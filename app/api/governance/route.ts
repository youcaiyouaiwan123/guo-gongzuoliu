// 治理中心：审批流、权限管理、审计日志。
// 使用 Hono 中间件统一处理认证和错误响应。
import { env } from "cloudflare:workers";
import { createApp, auth, success, fail, ADMIN_ROLE, STAFF_ROLE, authorizeCapability } from "../_app";
import { log } from "../_logger";
import { resumeApprovedWorkflow } from "../modules/route";
import { capabilityCatalog as catalog } from "../_capabilities";
import { ensureColumn } from "../_schema";
import { normalizeDecisionValue, normalizeRoleValue } from "../_auth";
import type { CapabilityKey, Decision } from "../_capabilities";

type RuntimeEnv = { DB: D1Database };
const runtime = env as unknown as RuntimeEnv;

export { capabilityCatalog } from "../_capabilities";

// ---------------------------------------------------------------------------
// 数据库 schema
// ---------------------------------------------------------------------------
const defaults = catalog.flatMap(item => [
  [ADMIN_ROLE, item.key, "允许"],
  [STAFF_ROLE, item.key, item.employee],
] as [string, CapabilityKey, Decision][]);

async function ensureSchema() {
  await runtime.DB.batch([
    runtime.DB.prepare("CREATE TABLE IF NOT EXISTS approval_requests (id INTEGER PRIMARY KEY AUTOINCREMENT,requester TEXT NOT NULL,request_type TEXT NOT NULL,title TEXT NOT NULL,reason TEXT NOT NULL,status TEXT NOT NULL DEFAULT '待审批',approver TEXT,comment TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,decided_at TEXT)"),
    runtime.DB.prepare("CREATE TABLE IF NOT EXISTS role_permissions (id INTEGER PRIMARY KEY AUTOINCREMENT,role TEXT NOT NULL,capability TEXT NOT NULL,decision TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(role,capability))"),
    runtime.DB.prepare("CREATE TABLE IF NOT EXISTS audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT,actor TEXT NOT NULL,action TEXT NOT NULL,resource TEXT NOT NULL,result TEXT NOT NULL,detail TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL)"),
    runtime.DB.prepare("CREATE TABLE IF NOT EXISTS org_units (id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,unit_type TEXT NOT NULL DEFAULT '部门',parent_id INTEGER,manager_email TEXT NOT NULL DEFAULT '',sort_order INTEGER NOT NULL DEFAULT 0,created_by TEXT NOT NULL,created_at TEXT NOT NULL)"),
    runtime.DB.prepare("CREATE TABLE IF NOT EXISTS org_members (email TEXT PRIMARY KEY,unit_id INTEGER NOT NULL,job_title TEXT NOT NULL DEFAULT '员工',direct_manager_email TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT '在岗',updated_at TEXT NOT NULL)"),
    runtime.DB.prepare("CREATE TABLE IF NOT EXISTS org_transfer_requests (id INTEGER PRIMARY KEY AUTOINCREMENT,email TEXT NOT NULL,from_unit_id INTEGER,to_unit_id INTEGER NOT NULL,job_title TEXT NOT NULL DEFAULT '员工',reason TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT '待审批',decided_by TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,decided_at TEXT)"),
  ]);
  await ensureColumn(runtime.DB, "approval_requests", "approver_email", "TEXT NOT NULL DEFAULT ''");
  await ensureColumn(runtime.DB, "approval_requests", "workflow_run_id", "INTEGER");
  await ensureColumn(runtime.DB, "approval_requests", "workflow_step_index", "INTEGER");
  await ensureColumn(runtime.DB, "org_units", "unit_type", "TEXT NOT NULL DEFAULT '部门'");
  await ensureColumn(runtime.DB, "org_units", "parent_id", "INTEGER");
  await ensureColumn(runtime.DB, "org_units", "manager_email", "TEXT NOT NULL DEFAULT ''");
  await ensureColumn(runtime.DB, "org_units", "sort_order", "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn(runtime.DB, "org_units", "created_by", "TEXT NOT NULL DEFAULT ''");
  await ensureColumn(runtime.DB, "org_members", "job_title", "TEXT NOT NULL DEFAULT '员工'");
  await ensureColumn(runtime.DB, "org_members", "direct_manager_email", "TEXT NOT NULL DEFAULT ''");
  await ensureColumn(runtime.DB, "org_members", "status", "TEXT NOT NULL DEFAULT '在岗'");
  await ensureColumn(runtime.DB, "org_members", "updated_at", "TEXT NOT NULL DEFAULT ''");

  const now = new Date().toISOString();
  for (const [role, capability, decision] of defaults) {
    const finalDecision = role === ADMIN_ROLE || capability === "collect_data" ? "允许" : decision;
    await runtime.DB.prepare("INSERT INTO role_permissions(role,capability,decision,updated_at) VALUES(?,?,?,?) ON CONFLICT(role,capability) DO UPDATE SET decision=role_permissions.decision,updated_at=excluded.updated_at")
      .bind(role, capability, finalDecision, now).run();
  }
  for (const item of catalog) {
    await runtime.DB.prepare("INSERT INTO role_permissions(role,capability,decision,updated_at) VALUES(?,?,?,?) ON CONFLICT(role,capability) DO UPDATE SET decision='允许',updated_at=excluded.updated_at")
      .bind(ADMIN_ROLE, item.key, "允许", now).run();
  }
  await runtime.DB.prepare("INSERT INTO role_permissions(role,capability,decision,updated_at) VALUES(?,?,?,?) ON CONFLICT(role,capability) DO UPDATE SET decision='允许',updated_at=excluded.updated_at")
    .bind(STAFF_ROLE, "collect_data", "允许", now).run();
}

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------
async function ownerEmail() {
  const owner = await runtime.DB.prepare("SELECT email FROM user_roles ORDER BY CASE WHEN role='管理员' THEN 0 ELSE 1 END,created_at,email LIMIT 1").first<{ email: string }>();
  return owner?.email || "";
}

async function approvalTargets(email: string) {
  const rows = await runtime.DB.prepare(
    "SELECT m.email,m.job_title AS jobTitle,u.name AS unitName,m.direct_manager_email AS directManagerEmail,u.manager_email AS unitManagerEmail FROM org_members m LEFT JOIN org_units u ON u.id=m.unit_id WHERE m.status='在岗' ORDER BY u.sort_order,u.name,m.job_title,m.email"
  ).all<{ email: string; jobTitle: string; unitName: string; directManagerEmail: string; unitManagerEmail: string }>();
  const current = rows.results.find(item => item.email === email);
  const candidates = rows.results.filter(item => item.email !== email);
  return { current, candidates };
}

async function audit(actor: string, action: string, resource: string, result: string, detail: string) {
  await runtime.DB.prepare("INSERT INTO audit_logs(actor,action,resource,result,detail,created_at) VALUES(?,?,?,?,?,?)")
    .bind(actor, action, resource, result, detail, new Date().toISOString()).run();
}

// ---------------------------------------------------------------------------
// Hono 路由
// ---------------------------------------------------------------------------
const app = createApp();
app.use("*", auth());

// GET /api/governance — 获取审批列表、权限策略、能力目录
app.get("*", async (c) => {
  await ensureSchema();
  const { user } = c.var;
  log.info("获取治理数据", { email: user.email, role: user.role });
  const owner = await ownerEmail();
  const isManager = owner === user.email || user.role === ADMIN_ROLE;
  const approvals = isManager
    ? await runtime.DB.prepare("SELECT id,requester,request_type AS requestType,title,reason,status,approver_email AS approverEmail,approver,comment,workflow_run_id AS workflowRunId,workflow_step_index AS workflowStepIndex,created_at AS createdAt,decided_at AS decidedAt FROM approval_requests ORDER BY id DESC LIMIT 100").all()
    : await runtime.DB.prepare("SELECT id,requester,request_type AS requestType,title,reason,status,approver_email AS approverEmail,approver,comment,workflow_run_id AS workflowRunId,workflow_step_index AS workflowStepIndex,created_at AS createdAt,decided_at AS decidedAt FROM approval_requests WHERE requester=? OR approver_email=? ORDER BY id DESC LIMIT 100").bind(user.email, user.email).all();
  const permissions = await runtime.DB.prepare("SELECT id,role,capability,decision,updated_at AS updatedAt FROM role_permissions ORDER BY capability,role").all();
  return success({ approvals: approvals.results, permissions: permissions.results, capabilities: catalog, approvalTargets: await approvalTargets(user.email), ownerEmail: owner });
});

// POST /api/governance — 提交/处理/撤回审批、修改权限
app.post("*", async (c) => {
  await ensureSchema();
  const { user } = c.var;
  const body = await c.req.json() as {
    action?: string;
    id?: unknown;
    requestType?: string;
    title?: string;
    reason?: string;
    approverEmail?: string;
    status?: string;
    comment?: string;
    role?: string;
    capability?: string;
    decision?: string;
    permissions?: Array<{ role?: string; capability?: string; decision?: string }>;
  };
  const now = new Date().toISOString();

  if (body.action === "submit") {
    if (!body.requestType || !body.title?.trim() || !body.reason?.trim() || !body.approverEmail?.trim()) {
      return fail("请完整填写审批事项、申请原因并指定审批人。");
    }
    if (body.requestType === "数据采集") {
      return fail("数据采集已直接开放，请到数据采集页面新建或运行任务。", 409);
    }
    const targetEmail = String(body.approverEmail).trim().toLowerCase();
    const target = await runtime.DB.prepare("SELECT email FROM org_members WHERE email=? AND status='在岗' UNION SELECT email FROM user_roles WHERE email=? LIMIT 1").bind(targetEmail, targetEmail).first<{ email: string }>();
    if (!target) return fail("指定的审批账号不在当前企业架构或用户列表中。");
    if (targetEmail === user.email) return fail("审批人不能是申请人本人，请选择直属主管、部门负责人或老板。");
    await runtime.DB.prepare("INSERT INTO approval_requests(requester,request_type,title,reason,status,approver_email,created_at) VALUES(?,?,?,?,?,?,?)")
      .bind(user.email, body.requestType, body.title.trim(), body.reason.trim(), "待审批", targetEmail, now).run();
    await audit(user.email, "提交审批", body.title.trim(), "待审批", body.reason.trim());
    return success({ ok: true }, 201);
  }

  if (body.action === "decide") {
    const status = String(body.status || "");
    if (!["已通过", "已拒绝"].includes(status)) return fail("无效的审批结果。");
    const item = await runtime.DB.prepare("SELECT requester,request_type AS requestType,title,status,approver_email AS approverEmail,workflow_run_id AS workflowRunId FROM approval_requests WHERE id=?").bind(Number(body.id)).first<{ requester: string; requestType: string; title: string; status: string; approverEmail: string; workflowRunId?: number }>();
    if (!item || item.status !== "待审批") return fail("该审批不存在或已经处理。", 409);
    if (item.approverEmail !== user.email && await ownerEmail() !== user.email && user.role !== ADMIN_ROLE) return fail("该审批已指定给其他账号，你无权处理。", 403);
    const claimed = await runtime.DB.prepare("UPDATE approval_requests SET status=?,approver=?,comment=?,decided_at=? WHERE id=? AND status='待审批'")
      .bind(status, user.email, body.comment?.trim() || "管理员已处理", now, Number(body.id)).run();
    if (!claimed.meta.changes) return fail("该审批已被其他账号处理。", 409);
    if (item.requestType === "加入部门/转岗") {
      const transfer = await runtime.DB.prepare("SELECT id,to_unit_id AS toUnitId,job_title AS jobTitle FROM org_transfer_requests WHERE email=? AND status='待审批' ORDER BY id DESC LIMIT 1").bind(item.requester).first<{ id: number; toUnitId: number; jobTitle: string }>();
      if (transfer) {
        await runtime.DB.prepare("UPDATE org_transfer_requests SET status=?,decided_by=?,decided_at=? WHERE id=?").bind(status, user.email, now, transfer.id).run();
        if (status === "已通过") {
          const unit = await runtime.DB.prepare("SELECT manager_email AS managerEmail FROM org_units WHERE id=?").bind(transfer.toUnitId).first<{ managerEmail: string }>();
          await runtime.DB.prepare("INSERT INTO org_members(email,unit_id,job_title,direct_manager_email,status,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(email) DO UPDATE SET unit_id=excluded.unit_id,job_title=excluded.job_title,direct_manager_email=excluded.direct_manager_email,status='在岗',updated_at=excluded.updated_at")
            .bind(item.requester, transfer.toUnitId, transfer.jobTitle, unit?.managerEmail || "", "在岗", now).run();
        }
      }
    }
    let workflowRun: unknown = null;
    if (item.workflowRunId) {
      if (status === "已通过") {
        workflowRun = await resumeApprovedWorkflow(item.workflowRunId, user.email, user.businessRole);
      } else {
        await runtime.DB.prepare("UPDATE workflow_runs SET status='已拒绝',error=?,finished_at=? WHERE id=?")
          .bind(`审批“${item.title}”已被拒绝`, now, item.workflowRunId).run();
        await runtime.DB.prepare("UPDATE workflow_step_runs SET status='已拒绝',error=?,finished_at=? WHERE run_id=? AND status='等待审批'")
          .bind(body.comment?.trim() || "审批人拒绝", now, item.workflowRunId).run();
        const linked = await runtime.DB.prepare("SELECT conversation_id AS conversationId,workflow_name AS workflowName FROM workflow_runs WHERE id=?")
          .bind(item.workflowRunId).first<{ conversationId?: number; workflowName: string }>();
        if (linked?.conversationId) {
          await runtime.DB.prepare("INSERT INTO chat_messages(conversation_id,role,content,sources,model_used,created_at) VALUES(?,'assistant',?,'[]','工作流执行器',?)")
            .bind(linked.conversationId, `工作流“${linked.workflowName}”的审批已被拒绝，流程已终止。${body.comment?.trim() ? `\n\n审批意见：${body.comment.trim()}` : ""}`, now).run();
        }
      }
    }
    await audit(user.email, "处理审批", item.title, status, body.comment?.trim() || "");
    return success({ ok: true, workflowRun }, 201);
  }

  if (body.action === "withdraw") {
    const item = await runtime.DB.prepare("SELECT requester,title,status FROM approval_requests WHERE id=?").bind(Number(body.id)).first<{ requester: string; title: string; status: string }>();
    if (!item || item.status !== "待审批") return fail("该审批不存在或已经处理，无法撤回。", 409);
    if (item.requester !== user.email && user.role !== ADMIN_ROLE) return fail("只能撤回自己发起的审批。", 403);
    const withdrawn = await runtime.DB.prepare("UPDATE approval_requests SET status='已撤回',approver=?,comment='申请人撤回',decided_at=? WHERE id=? AND status='待审批'")
      .bind(user.email, now, Number(body.id)).run();
    if (!withdrawn.meta.changes) return fail("该审批已被处理，无法撤回。", 409);
    await audit(user.email, "撤回审批", item.title, "已撤回", "审批记录继续保留用于审计。");
    return success({ ok: true }, 201);
  }

  if (body.action === "permission") {
    if (user.role !== ADMIN_ROLE) return fail("仅管理员可以修改权限。", 403);
    const role = normalizeRoleValue(body.role);
    const capability = String(body.capability || "");
    const exists = catalog.some(item => item.key === capability);
    if (!exists) return fail("权限项不存在。");
    const decision = role === ADMIN_ROLE || capability === "collect_data" ? "允许" : normalizeDecisionValue(body.decision);
    await runtime.DB.prepare("INSERT INTO role_permissions(role,capability,decision,updated_at) VALUES(?,?,?,?) ON CONFLICT(role,capability) DO UPDATE SET decision=excluded.decision,updated_at=excluded.updated_at")
      .bind(role, capability, decision, now).run();
    await audit(user.email, "修改权限", `${role} · ${capability}`, "成功", decision);
    return success({ ok: true }, 201);
  }

  if (body.action === "savePermissions") {
    if (user.role !== ADMIN_ROLE) return fail("仅管理员可以保存权限。", 403);
    const incoming = Array.isArray(body.permissions) ? body.permissions : [];
    const byKey = new Map<string, Decision>();
    for (const item of incoming) {
      const role = normalizeRoleValue(item?.role);
      const capability = String(item?.capability || "");
      if (!catalog.some(entry => entry.key === capability)) continue;
      byKey.set(`${role}:${capability}`, normalizeDecisionValue(item?.decision));
    }
    const rows = [ADMIN_ROLE, STAFF_ROLE].flatMap(role =>
      catalog.map(capability => ({
        role,
        capability: capability.key,
        decision: role === ADMIN_ROLE || capability.key === "collect_data"
          ? "允许"
          : byKey.get(`${role}:${capability.key}`) || capability.employee,
      }))
    );
    await runtime.DB.batch(rows.map(item =>
      runtime.DB.prepare("INSERT INTO role_permissions(role,capability,decision,updated_at) VALUES(?,?,?,?) ON CONFLICT(role,capability) DO UPDATE SET decision=excluded.decision,updated_at=excluded.updated_at")
        .bind(item.role, item.capability, item.decision, now)
    ));
    await audit(user.email, "保存权限策略", "全部权限", "成功", `共 ${rows.length} 项；管理员固定最高权限；数据采集固定开放。`);
    return success({ ok: true }, 201);
  }

  return fail("不支持的操作。");
});

// ---------------------------------------------------------------------------
// vinext 文件路由桥接
// ---------------------------------------------------------------------------
export const GET = (request: Request) => app.fetch(request);
export const POST = (request: Request) => app.fetch(request);