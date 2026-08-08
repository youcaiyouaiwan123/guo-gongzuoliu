import { createApp, success, fail } from "../../_app";
import { env } from "cloudflare:workers";
import { runWorkflowById } from "../../modules/route";
import { ensureSchema, audit } from "../../modules/_shared";
import { normalizeBusinessRoleValue, normalizeRoleValue } from "../../_auth";
import { nextRunAt, formatBeijingTime } from "../../_schedule";

// 定时任务的心跳入口。
//
// 自托管跑的是 `wrangler dev --local`（见 deploy/selfhost-entrypoint.sh），
// 收不到 Cloudflare 边缘投递的 Cron Trigger，所以由常驻的 channel-gateway 每分钟打一次这里。
// 鉴权照搬 api/gateway/accounts 那套 Bearer + HAIXIN_GATEWAY_ADMIN_SECRET，不另发明一套。

type RuntimeEnv = {
  DB: D1Database;
  HAIXIN_GATEWAY_ADMIN_SECRET?: string;
};

const runtime = env as unknown as RuntimeEnv;

// 一次 tick 最多处理这么多条，避免积压时一口气打满模型接口。
const MAX_PER_TICK = 5;

type DueWorkflow = {
  id: number;
  name: string;
  scheduleTime: string;
  nextRunAt: string;
  createdBy: string;
};

function isAuthorized(request: Request) {
  const secret = runtime.HAIXIN_GATEWAY_ADMIN_SECRET?.trim();
  return Boolean(secret) && request.headers.get("authorization") === `Bearer ${secret}`;
}

/** 定时触发没有登录态，按创建者的账号还原出执行身份。 */
async function resolveActorRole(email: string) {
  const record = await runtime.DB.prepare("SELECT role FROM user_roles WHERE email=?")
    .bind(email).first<{ role: string }>();
  return normalizeBusinessRoleValue("", normalizeRoleValue(record?.role));
}

/** 创建者缺失时也要留下痕迹，否则任务"到点了什么都没发生"完全查不到。 */
async function recordSkipped(workflow: DueWorkflow, message: string) {
  const now = new Date().toISOString();
  await runtime.DB.prepare("INSERT INTO workflow_runs(workflow_id,workflow_name,actor,status,input,output,error,started_at,finished_at,source_channel) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .bind(workflow.id, workflow.name, workflow.createdBy || "定时调度", "失败", "定时触发", "", message, now, now, "定时调度").run();
  await audit(workflow.createdBy || "定时调度", "定时触发工作流", workflow.name, "失败", message);
}

const app = createApp();

// POST /api/gateway/tick — 由 channel-gateway 每分钟调用，执行到期的定时任务
app.post("*", async (c) => {
  if (!isAuthorized(c.req.raw)) return fail("unauthorized", 401);
  await ensureSchema();

  const now = new Date();
  const due = await runtime.DB.prepare(
    "SELECT id,name,schedule_time AS scheduleTime,next_run_at AS nextRunAt,created_by AS createdBy FROM workflows WHERE enabled=1 AND schedule_time<>'' AND next_run_at IS NOT NULL AND next_run_at<=? AND status<>'停用' ORDER BY next_run_at LIMIT ?",
  ).bind(now.toISOString(), MAX_PER_TICK).all<DueWorkflow>();

  const handled: Array<{ id: number; name: string; result: string; runId?: number }> = [];

  for (const workflow of due.results || []) {
    // 先抢占再执行：把 next_run_at 推到下一次，改动行数为 0 说明已被别的 tick 领走。
    // D1 没有 SELECT FOR UPDATE，条件 UPDATE 是这个项目里既有的做法（见 modules/route.ts 确认采集结果）。
    const upcoming = nextRunAt(workflow.scheduleTime, now);
    if (!upcoming) {
      // schedule_time 被改成了非法值，关掉调度，不然它会每分钟被捞出来一次。
      await runtime.DB.prepare("UPDATE workflows SET enabled=0,next_run_at=NULL WHERE id=?").bind(workflow.id).run();
      await recordSkipped(workflow, `定时设置「${workflow.scheduleTime}」无法解析，已停止调度，请重新设置运行时间。`);
      handled.push({ id: workflow.id, name: workflow.name, result: "定时设置非法，已停调度" });
      continue;
    }

    const claimed = await runtime.DB.prepare(
      "UPDATE workflows SET next_run_at=?,last_run_at=? WHERE id=? AND next_run_at=?",
    ).bind(upcoming, now.toISOString(), workflow.id, workflow.nextRunAt).run();
    if (!claimed.meta.changes) {
      handled.push({ id: workflow.id, name: workflow.name, result: "已被其他心跳领走，跳过" });
      continue;
    }

    if (!workflow.createdBy) {
      // 0023 之前建的任务没有创建者，拿不到身份也就取不到模型密钥。
      await recordSkipped(workflow, "该任务没有记录创建者，无法确定以谁的身份运行。请重新保存一次任务以补齐。");
      handled.push({ id: workflow.id, name: workflow.name, result: "缺少创建者，已跳过" });
      continue;
    }

    try {
      const role = await resolveActorRole(workflow.createdBy);
      // executeWorkflow 内部会吞掉步骤异常并把运行记为"失败"，所以这里拿到的是运行结果而非抛错。
      // 创建者没配模型密钥的情况就落在这条路径上，运行记录里会写明"尚未配置模型API"。
      const run = await runWorkflowById(workflow.id, workflow.createdBy, role, "定时触发", { sourceChannel: "定时调度" });
      handled.push({ id: workflow.id, name: workflow.name, result: run.status || "已执行", runId: run.id });
      await audit(workflow.createdBy, "定时触发工作流", workflow.name, run.status === "失败" ? "失败" : "成功", `运行#${run.id}；下次 ${formatBeijingTime(upcoming)}`);
    } catch (error) {
      // runWorkflowById 在工作流被停用/删除时会抛错，这类异常不该中断整轮心跳。
      const message = error instanceof Error ? error.message : "定时执行失败";
      await recordSkipped(workflow, message);
      handled.push({ id: workflow.id, name: workflow.name, result: message });
    }
  }

  return success({ now: now.toISOString(), due: due.results?.length || 0, handled });
});

export const POST = (request: Request) => app.fetch(request);
