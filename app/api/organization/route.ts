// 组织架构：企业架构管理、成员管理、逐级汇报。
import { env } from "cloudflare:workers";
import { createApp, auth, admin, success, fail, authorizeCapability } from "../_app";
import { callModel } from "../_modelProvider";
import { decryptSecret } from "../_crypto";
import { ensureColumn } from "../_schema";
import { log, logQuery } from "../_logger";
import { findDuplicateUnit, resolveUpwardRecipients, type OrgMemberRow, type OrgUnitRow } from "./_orgLogic";

type RuntimeEnv = {
  DB: D1Database;
  PLATFORM_CREDENTIALS_KEY?: string;
  MODEL_API_KEY?: string;
  MODEL_BASE_URL?: string;
  MODEL_NAME?: string;
  MODEL_PROVIDER?: string;
};
const runtime = env as unknown as RuntimeEnv;

// schema 建表+补列较重，进程内只需跑一次；后续请求直接复用同一 Promise。
// 失败则清空以便下次请求重试。
let schemaReady: Promise<void> | null = null;
function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = ensureSchemaOnce().catch(error => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}
async function ensureSchemaOnce() {
  await runtime.DB.batch([
    runtime.DB.prepare("CREATE TABLE IF NOT EXISTS org_units (id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,unit_type TEXT NOT NULL DEFAULT '部门',parent_id INTEGER,manager_email TEXT NOT NULL DEFAULT '',sort_order INTEGER NOT NULL DEFAULT 0,created_by TEXT NOT NULL,created_at TEXT NOT NULL)"),
    runtime.DB.prepare("CREATE TABLE IF NOT EXISTS org_members (email TEXT PRIMARY KEY,unit_id INTEGER NOT NULL,job_title TEXT NOT NULL DEFAULT '员工',direct_manager_email TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT '在岗',updated_at TEXT NOT NULL)"),
    runtime.DB.prepare("CREATE TABLE IF NOT EXISTS org_transfer_requests (id INTEGER PRIMARY KEY AUTOINCREMENT,email TEXT NOT NULL,from_unit_id INTEGER,to_unit_id INTEGER NOT NULL,job_title TEXT NOT NULL DEFAULT '员工',reason TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT '待审批',decided_by TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,decided_at TEXT)"),
    runtime.DB.prepare("CREATE TABLE IF NOT EXISTS org_reports (id INTEGER PRIMARY KEY AUTOINCREMENT,sender_email TEXT NOT NULL,recipient_email TEXT NOT NULL,unit_id INTEGER,title TEXT NOT NULL,content TEXT NOT NULL,ai_summary TEXT NOT NULL DEFAULT '',importance TEXT NOT NULL DEFAULT '普通',status TEXT NOT NULL DEFAULT '未读',attachment_document_id INTEGER,created_at TEXT NOT NULL,handled_at TEXT)"),
    runtime.DB.prepare("CREATE TABLE IF NOT EXISTS org_report_mentions (report_id INTEGER NOT NULL,email TEXT NOT NULL,status TEXT NOT NULL DEFAULT '未读',PRIMARY KEY(report_id,email))"),
    runtime.DB.prepare("CREATE TABLE IF NOT EXISTS user_model_connections (owner_email TEXT PRIMARY KEY,provider TEXT NOT NULL,base_url TEXT NOT NULL,model_name TEXT NOT NULL,encrypted_api_key TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)"),
    runtime.DB.prepare("CREATE TABLE IF NOT EXISTS user_model_profiles (id INTEGER PRIMARY KEY AUTOINCREMENT,owner_email TEXT NOT NULL,connection_name TEXT NOT NULL,provider TEXT NOT NULL,base_url TEXT NOT NULL,model_name TEXT NOT NULL,encrypted_api_key TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)"),
    runtime.DB.prepare("CREATE TABLE IF NOT EXISTS audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT,actor TEXT NOT NULL,action TEXT NOT NULL,resource TEXT NOT NULL,result TEXT NOT NULL,detail TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL)"),
    runtime.DB.prepare("CREATE TABLE IF NOT EXISTS approval_requests (id INTEGER PRIMARY KEY AUTOINCREMENT,requester TEXT NOT NULL,request_type TEXT NOT NULL,title TEXT NOT NULL,reason TEXT NOT NULL,status TEXT NOT NULL DEFAULT '待审批',approver TEXT,comment TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,decided_at TEXT)"),
  ]);
  await ensureColumn(runtime.DB, "approval_requests", "approver_email", "TEXT NOT NULL DEFAULT ''");
  await ensureColumn(runtime.DB, "org_units", "unit_type", "TEXT NOT NULL DEFAULT '部门'");
  await ensureColumn(runtime.DB, "org_units", "parent_id", "INTEGER");
  await ensureColumn(runtime.DB, "org_units", "manager_email", "TEXT NOT NULL DEFAULT ''");
  await ensureColumn(runtime.DB, "org_units", "sort_order", "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn(runtime.DB, "org_units", "created_by", "TEXT NOT NULL DEFAULT ''");
  await ensureColumn(runtime.DB, "org_members", "job_title", "TEXT NOT NULL DEFAULT '员工'");
  await ensureColumn(runtime.DB, "org_members", "direct_manager_email", "TEXT NOT NULL DEFAULT ''");
  await ensureColumn(runtime.DB, "org_members", "status", "TEXT NOT NULL DEFAULT '在岗'");
  await ensureColumn(runtime.DB, "org_members", "updated_at", "TEXT NOT NULL DEFAULT ''");
  await ensureColumn(runtime.DB, "org_reports", "ai_summary", "TEXT NOT NULL DEFAULT ''");
  await ensureColumn(runtime.DB, "org_reports", "importance", "TEXT NOT NULL DEFAULT '普通'");
  await ensureColumn(runtime.DB, "org_reports", "attachment_document_id", "INTEGER");
  await ensureColumn(runtime.DB, "org_reports", "handled_at", "TEXT");
}

async function audit(actor: string, action: string, resource: string, detail: string) {
  await runtime.DB.prepare("INSERT INTO audit_logs(actor,action,resource,result,detail,created_at) VALUES(?,?,?,?,?,?)")
    .bind(actor, action, resource, "成功", detail, new Date().toISOString()).run();
}

async function aiSummarize(email: string, title: string, content: string) {
  let config: { provider?: string; baseUrl: string; model: string; apiKey: string } | null = null;
  const row = await runtime.DB.prepare("SELECT provider,base_url AS baseUrl,model_name AS model,encrypted_api_key AS encryptedApiKey FROM user_model_profiles WHERE owner_email=? ORDER BY updated_at DESC,id DESC LIMIT 1")
    .bind(email).first<{ provider: string; baseUrl: string; model: string; encryptedApiKey: string }>();
  if (row) {
    const apiKey = await decryptSecret(row.encryptedApiKey);
    if (apiKey) config = { provider: row.provider, baseUrl: row.baseUrl || runtime.MODEL_BASE_URL?.trim() || "https://claudecc.top", model: row.model, apiKey };
  }
  if (!config && runtime.MODEL_API_KEY) {
    config = { provider: runtime.MODEL_PROVIDER || "OpenAI", baseUrl: runtime.MODEL_BASE_URL?.trim() || "https://claudecc.top", model: runtime.MODEL_NAME || "gpt-4.1-mini", apiKey: runtime.MODEL_API_KEY };
  }
  if (!config) return "";
  try {
    return (await callModel(config, [
      { role: "system", content: "你是企业逐级汇报助手。将员工原文整理成简洁、客观、可供管理者决策的中文汇报。保留关键数字、风险、需要决定的事项和下一步，不得编造。" },
      { role: "user", content: `汇报标题：${title}\n\n原始内容：\n${content}` },
    ], { temperature: 0.1 })).trim();
  } catch {
    return "";
  }
}

async function loadUnits() {
  const result = await runtime.DB.prepare("SELECT id,name,unit_type AS unitType,parent_id AS parentId,manager_email AS managerEmail,sort_order AS sortOrder FROM org_units").all<OrgUnitRow>();
  return (result.results || []) as OrgUnitRow[];
}

/** 同级重名检查；命中时返回 409 响应，未命中返回 null。 */
async function rejectDuplicateUnit(name: string, parentId: number | null, id: number | null) {
  const duplicate = findDuplicateUnit(await loadUnits(), { id, name, parentId });
  if (!duplicate) return null;
  return fail(`同一上级下已存在同名部门「${duplicate.name}」，请改名或挂到其他上级。`, 409);
}

async function upwardRecipients(email: string) {
  const [units, members] = await Promise.all([
    loadUnits(),
    runtime.DB.prepare("SELECT email,unit_id AS unitId,direct_manager_email AS directManagerEmail FROM org_members").all<OrgMemberRow>(),
  ]);
  return resolveUpwardRecipients(email, (members.results || []) as OrgMemberRow[], units);
}

const app = createApp();
app.use("*", auth());

// GET /api/organization — 获取组织架构、成员、汇报
app.get("*", async (c) => {
  await ensureSchema();
  const { user } = c.var;
  log.info("获取组织架构", { email: user.email, role: user.role });

  const start = performance.now();
  const [units, members, transfers] = await runtime.DB.batch([
    runtime.DB.prepare("SELECT id,name,unit_type AS unitType,parent_id AS parentId,manager_email AS managerEmail,sort_order AS sortOrder,created_at AS createdAt FROM org_units ORDER BY sort_order,id"),
    runtime.DB.prepare("SELECT m.email,m.unit_id AS unitId,m.job_title AS jobTitle,m.direct_manager_email AS directManagerEmail,m.status,m.updated_at AS updatedAt,u.name AS unitName FROM org_members m LEFT JOIN org_units u ON u.id=m.unit_id ORDER BY u.sort_order,m.job_title,m.email"),
    user.role === "管理员"
      ? runtime.DB.prepare("SELECT r.id,r.email,r.from_unit_id AS fromUnitId,r.to_unit_id AS toUnitId,r.job_title AS jobTitle,r.reason,r.status,r.created_at AS createdAt,f.name AS fromUnitName,t.name AS toUnitName FROM org_transfer_requests r LEFT JOIN org_units f ON f.id=r.from_unit_id LEFT JOIN org_units t ON t.id=r.to_unit_id ORDER BY r.id DESC LIMIT 100")
      : runtime.DB.prepare("SELECT r.id,r.email,r.from_unit_id AS fromUnitId,r.to_unit_id AS toUnitId,r.job_title AS jobTitle,r.reason,r.status,r.created_at AS createdAt,f.name AS fromUnitName,t.name AS toUnitName FROM org_transfer_requests r LEFT JOIN org_units f ON f.id=r.from_unit_id LEFT JOIN org_units t ON t.id=r.to_unit_id WHERE r.email=? OR EXISTS(SELECT 1 FROM org_units mu WHERE mu.id=r.to_unit_id AND mu.manager_email=?) ORDER BY r.id DESC LIMIT 50").bind(user.email, user.email),
  ]);
  logQuery("batch(org_units, org_members, org_transfer_requests)", [], performance.now() - start);
  log.info("组织架构查询结果", {
    unitsCount: units.results?.length || 0,
    membersCount: members.results?.length || 0,
    transfersCount: transfers.results?.length || 0,
  });
  const reports = user.role === "管理员"
    ? await runtime.DB.prepare("SELECT id,sender_email AS senderEmail,recipient_email AS recipientEmail,unit_id AS unitId,title,content,ai_summary AS aiSummary,importance,status,attachment_document_id AS attachmentDocumentId,created_at AS createdAt,handled_at AS handledAt FROM org_reports ORDER BY id DESC LIMIT 100").all()
    : await runtime.DB.prepare("SELECT id,sender_email AS senderEmail,recipient_email AS recipientEmail,unit_id AS unitId,title,content,ai_summary AS aiSummary,importance,status,attachment_document_id AS attachmentDocumentId,created_at AS createdAt,handled_at AS handledAt FROM org_reports WHERE sender_email=? OR recipient_email=? OR EXISTS(SELECT 1 FROM org_report_mentions m WHERE m.report_id=org_reports.id AND m.email=?) ORDER BY id DESC LIMIT 100").bind(user.email, user.email, user.email).all();
  const myMember = (members.results as Array<{ email: string }>).find(item => item.email === user.email) || null;
  const owner = await runtime.DB.prepare("SELECT email FROM user_roles ORDER BY CASE WHEN role='管理员' THEN 0 ELSE 1 END,created_at,email LIMIT 1").first<{ email: string }>();
  const recipients = await upwardRecipients(user.email);
  const pendingApprovals = owner?.email === user.email
    ? await runtime.DB.prepare("SELECT COUNT(*) AS total FROM approval_requests WHERE status='待审批'").first<{ total: number }>()
    : await runtime.DB.prepare("SELECT COUNT(*) AS total FROM approval_requests WHERE status='待审批' AND approver_email=?").bind(user.email).first<{ total: number }>();
  const unreadReports = await runtime.DB.prepare("SELECT (SELECT COUNT(*) FROM org_reports WHERE recipient_email=? AND status='未读')+(SELECT COUNT(*) FROM org_report_mentions WHERE email=? AND status='未读') AS total").bind(user.email, user.email).first<{ total: number }>();
  return success({ units: units.results, members: members.results, ownerEmail: owner?.email || user.email, transfers: transfers.results, reports: reports.results, myMember, recipients, reminders: { approvals: Number(pendingApprovals?.total || 0), reports: Number(unreadReports?.total || 0) } });
});

// POST /api/organization — 组织/成员/汇报的增删改
app.post("*", async (c) => {
  await ensureSchema();
  const { user } = c.var;
  const body = await c.req.json() as Record<string, string>;
  const now = new Date().toISOString();

  if (body.action === "createUnit") {
    if (user.role !== "管理员") return fail("仅管理员可以调整企业架构。", 403);
    if (!body.name?.trim()) return fail("请填写组织名称。");
    const parentId = Number(body.parentId) || null;
    const conflict = await rejectDuplicateUnit(body.name, parentId, null);
    if (conflict) return conflict;
    await runtime.DB.prepare("INSERT INTO org_units(name,unit_type,parent_id,manager_email,sort_order,created_by,created_at) VALUES(?,?,?,?,?,?,?)")
      .bind(body.name.trim(), body.unitType || "部门", parentId, body.managerEmail?.trim().toLowerCase() || "", Number(body.sortOrder) || 0, user.email, now).run();
    await audit(user.email, "新增组织节点", body.name.trim(), `上级节点：${body.parentId || "无"}`);
  } else if (body.action === "updateUnit") {
    if (user.role !== "管理员") return fail("仅管理员可以调整企业架构。", 403);
    const id = Number(body.id);
    const parentId = Number(body.parentId) || null;
    if (!id || !body.name?.trim()) return fail("缺少组织节点或组织名称。");
    if (parentId === id) return fail("组织不能把自己设为上级。");
    let cursor = parentId;
    for (let depth = 0; cursor && depth < 30; depth++) {
      if (cursor === id) return fail("不能把下级组织设为当前组织的上级。", 409);
      const parent = await runtime.DB.prepare("SELECT parent_id AS parentId FROM org_units WHERE id=?").bind(cursor).first<{ parentId: number | null }>();
      cursor = parent?.parentId || null;
    }
    const conflict = await rejectDuplicateUnit(body.name, parentId, id);
    if (conflict) return conflict;
    await runtime.DB.prepare("UPDATE org_units SET name=?,unit_type=?,parent_id=?,manager_email=?,sort_order=? WHERE id=?")
      .bind(body.name.trim(), body.unitType || "部门", parentId, body.managerEmail?.trim().toLowerCase() || "", Number(body.sortOrder) || 0, id).run();
    await audit(user.email, "修改组织节点", body.name.trim(), `节点#${id} · 类型：${body.unitType || "部门"}`);
  } else if (body.action === "assignMember") {
    if (user.role !== "管理员") return fail("仅管理员可以直接分配岗位。", 403);
    const email = body.email?.trim().toLowerCase();
    if (!email || !Number(body.unitId)) return fail("请选择员工和所属组织。");
    await runtime.DB.prepare("INSERT INTO org_members(email,unit_id,job_title,direct_manager_email,status,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(email) DO UPDATE SET unit_id=excluded.unit_id,job_title=excluded.job_title,direct_manager_email=excluded.direct_manager_email,status='在岗',updated_at=excluded.updated_at")
      .bind(email, Number(body.unitId), body.jobTitle?.trim() || "员工", body.directManagerEmail?.trim().toLowerCase() || "", "在岗", now).run();
    await audit(user.email, "分配或转岗", email, `组织#${body.unitId} · ${body.jobTitle || "员工"}`);
  } else if (body.action === "removeMember" || body.action === "offboardMember") {
    if (user.role !== "管理员") return fail("仅管理员可以移出成员或办理离职。", 403);
    const email = body.email?.trim().toLowerCase();
    if (!email) return fail("缺少成员邮箱。");
    const owner = await runtime.DB.prepare("SELECT email FROM user_roles ORDER BY CASE WHEN role='管理员' THEN 0 ELSE 1 END,created_at,email LIMIT 1").first<{ email: string }>();
    if (email === owner?.email) return fail("老板是企业最高负责人，不能移出部门或办理离职。", 409);
    const member = await runtime.DB.prepare("SELECT m.email,u.name AS unitName FROM org_members m LEFT JOIN org_units u ON u.id=m.unit_id WHERE m.email=?").bind(email).first<{ email: string; unitName: string }>();
    if (!member) return fail("该成员已不在任何部门。", 404);
    await runtime.DB.batch([
      runtime.DB.prepare("DELETE FROM org_members WHERE email=?").bind(email),
      runtime.DB.prepare("UPDATE org_members SET direct_manager_email='',updated_at=? WHERE direct_manager_email=?").bind(now, email),
      runtime.DB.prepare("UPDATE org_transfer_requests SET status='已撤回',decided_by=?,decided_at=? WHERE email=? AND status='待审批'").bind(user.email, now, email),
    ]);
    const actionName = body.action === "offboardMember" ? "办理成员离职" : "成员移出部门";
    await audit(user.email, actionName, email, `${member.unitName || "原组织"}；历史汇报、审批及审计记录保留`);
  } else if (body.action === "requestTransfer") {
    if (!Number(body.toUnitId)) return fail("请选择希望加入的部门。");
    const current = await runtime.DB.prepare("SELECT unit_id AS unitId FROM org_members WHERE email=?").bind(user.email).first<{ unitId: number }>();
    const duplicate = await runtime.DB.prepare("SELECT id FROM org_transfer_requests WHERE email=? AND status='待审批'").bind(user.email).first();
    if (duplicate) return fail("你已有一条待处理的加入或转岗申请。", 409);
    await runtime.DB.prepare("INSERT INTO org_transfer_requests(email,from_unit_id,to_unit_id,job_title,reason,status,created_at) VALUES(?,?,?,?,?,'待审批',?)")
      .bind(user.email, current?.unitId || null, Number(body.toUnitId), body.jobTitle?.trim() || "员工", body.reason?.trim() || "", now).run();
    const targetUnit = await runtime.DB.prepare("SELECT manager_email AS managerEmail FROM org_units WHERE id=?").bind(Number(body.toUnitId)).first<{ managerEmail: string }>();
    const owner = await runtime.DB.prepare("SELECT email FROM user_roles ORDER BY CASE WHEN role='管理员' THEN 0 ELSE 1 END,created_at,email LIMIT 1").first<{ email: string }>();
    const designatedApprover = targetUnit?.managerEmail || owner?.email || "";
    await runtime.DB.prepare("INSERT INTO approval_requests(requester,request_type,title,reason,status,approver_email,created_at) VALUES(?,?,?,?,?,?,?)")
      .bind(user.email, "加入部门/转岗", `${current ? "转岗" : "加入部门"}：${body.jobTitle || "员工"}`, body.reason?.trim() || "申请加入组织架构", "待审批", designatedApprover, now).run();
    await audit(user.email, "提交加入或转岗申请", user.email, `目标组织#${body.toUnitId}`);
  } else if (body.action === "decideTransfer") {
    const item = await runtime.DB.prepare("SELECT * FROM org_transfer_requests WHERE id=? AND status='待审批'").bind(Number(body.id)).first<{ email: string; to_unit_id: number; job_title: string }>();
    if (!item) return fail("申请不存在或已经处理。", 409);
    const target = await runtime.DB.prepare("SELECT manager_email AS managerEmail FROM org_units WHERE id=?").bind(item.to_unit_id).first<{ managerEmail: string }>();
    if (user.role !== "管理员" && target?.managerEmail !== user.email) return fail("仅目标部门负责人或管理员可以处理申请。", 403);
    const status = body.status === "已通过" ? "已通过" : "已拒绝";
    await runtime.DB.prepare("UPDATE org_transfer_requests SET status=?,decided_by=?,decided_at=? WHERE id=?").bind(status, user.email, now, Number(body.id)).run();
    await runtime.DB.prepare("UPDATE approval_requests SET status=?,approver=?,comment='已在企业架构中处理',decided_at=? WHERE requester=? AND request_type='加入部门/转岗' AND status='待审批'")
      .bind(status, user.email, now, item.email).run();
    if (status === "已通过") {
      await runtime.DB.prepare("INSERT INTO org_members(email,unit_id,job_title,direct_manager_email,status,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(email) DO UPDATE SET unit_id=excluded.unit_id,job_title=excluded.job_title,direct_manager_email=excluded.direct_manager_email,status='在岗',updated_at=excluded.updated_at")
        .bind(item.email, item.to_unit_id, item.job_title, target?.managerEmail || "", "在岗", now).run();
    }
    await audit(user.email, "处理加入或转岗", item.email, status);
  } else if (body.action === "createReport") {
    if (!body.title?.trim() || !body.content?.trim() || !body.recipientEmail?.trim()) return fail("请填写汇报对象、标题和内容。");
    const allowed = await upwardRecipients(user.email);
    if (user.role !== "管理员" && !allowed.includes(body.recipientEmail.trim().toLowerCase())) return fail("只能向直属主管或上级管理者汇报。", 403);
    const member = await runtime.DB.prepare("SELECT unit_id AS unitId FROM org_members WHERE email=?").bind(user.email).first<{ unitId: number }>();
    const mentionEmail = body.mentionEmail?.trim().toLowerCase();
    if (mentionEmail) {
      const mentioned = await runtime.DB.prepare("SELECT unit_id AS unitId FROM org_members WHERE email=?").bind(mentionEmail).first<{ unitId: number }>();
      if (!member || !mentioned || member.unitId !== mentioned.unitId) return fail("只能@同部门成员。", 403);
    }
    const summary = body.useAi === "true" ? await aiSummarize(user.email, body.title.trim(), body.content.trim()) : "";
    const created = await runtime.DB.prepare("INSERT INTO org_reports(sender_email,recipient_email,unit_id,title,content,ai_summary,importance,status,attachment_document_id,created_at) VALUES(?,?,?,?,?,?,?,'未读',?,?) RETURNING id")
      .bind(user.email, body.recipientEmail.trim().toLowerCase(), member?.unitId || null, body.title.trim(), body.content.trim(), summary, body.importance === "重要" ? "重要" : "普通", Number(body.attachmentDocumentId) || null, now).first<{ id: number }>();
    if (mentionEmail) {
      await runtime.DB.prepare("INSERT OR IGNORE INTO org_report_mentions(report_id,email,status) VALUES(?,?,'未读')").bind(created!.id, mentionEmail).run();
    }
    await audit(user.email, body.useAi === "true" ? "AI整理并汇报" : "提交逐级汇报", body.title.trim(), `接收人：${body.recipientEmail}`);
  } else if (body.action === "handleReport") {
    const report = await runtime.DB.prepare("SELECT recipient_email AS recipientEmail,title FROM org_reports WHERE id=?").bind(Number(body.id)).first<{ recipientEmail: string; title: string }>();
    const mention = await runtime.DB.prepare("SELECT email FROM org_report_mentions WHERE report_id=? AND email=?").bind(Number(body.id), user.email).first();
    if (!report || (report.recipientEmail !== user.email && !mention && user.role !== "管理员")) return fail("无权处理该汇报。", 403);
    if (report.recipientEmail === user.email || user.role === "管理员") {
      await runtime.DB.prepare("UPDATE org_reports SET status='已处理',handled_at=? WHERE id=?").bind(now, Number(body.id)).run();
      await runtime.DB.prepare("UPDATE org_report_mentions SET status='已处理' WHERE report_id=?").bind(Number(body.id)).run();
    }
    if (mention) await runtime.DB.prepare("UPDATE org_report_mentions SET status='已处理' WHERE report_id=? AND email=?").bind(Number(body.id), user.email).run();
    await audit(user.email, "处理汇报", report.title, "已处理");
  } else {
    return fail("不支持的组织操作。");
  }
  return success({ ok: true });
});

// DELETE /api/organization — 删除组织节点
app.delete("*", async (c) => {
  await ensureSchema();
  const { user } = c.var;
  if (user.role !== "管理员") return fail("仅管理员可以删除组织节点。", 403);
  const id = Number(c.req.query("id"));
  const child = await runtime.DB.prepare("SELECT id FROM org_units WHERE parent_id=? LIMIT 1").bind(id).first();
  const member = await runtime.DB.prepare("SELECT email FROM org_members WHERE unit_id=? LIMIT 1").bind(id).first();
  if (child || member) return fail("该节点下面仍有下级组织或成员，请先转移后再删除。", 409);
  const item = await runtime.DB.prepare("SELECT name FROM org_units WHERE id=?").bind(id).first<{ name: string }>();
  if (!item) return fail("组织节点不存在。", 404);
  await runtime.DB.prepare("DELETE FROM org_units WHERE id=?").bind(id).run();
  await audit(user.email, "删除组织节点", item.name, "空节点已删除");
  return success({ ok: true });
});

// vinext 文件路由桥接
export const GET = (request: Request) => app.fetch(request);
export const POST = (request: Request) => app.fetch(request);
export const DELETE = (request: Request) => app.fetch(request);