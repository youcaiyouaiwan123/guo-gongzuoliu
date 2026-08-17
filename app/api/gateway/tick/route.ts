import { createApp, success, fail } from "../../_app";
import { env } from "cloudflare:workers";
import { runWorkflowById, judgeTrigger, collectSource } from "../../modules/route";
import { ensureSchema, audit } from "../../modules/_shared";
import { normalizeBusinessRoleValue, normalizeRoleValue } from "../../_auth";
import { nextRunAt, nextCheckAt, withinCooldown, formatBeijingTime } from "../../_schedule";

// 定时任务的心跳入口。
//
// 自托管跑的是 `wrangler dev --local`（见 deploy/selfhost-entrypoint.sh），
// 收不到 Cloudflare 边缘投递的 Cron Trigger，所以由常驻的 channel-gateway 每分钟打一次这里。
// 鉴权照搬 api/gateway/accounts 那套 Bearer + HAIXIN_GATEWAY_ADMIN_SECRET，不另发明一套。
//
// 这里处理两类自动任务：
//   1. 定时制：到点（schedule_time）就跑，见下面第一段。
//   2. 主动制轮询（Lane A）：每隔 check_interval_min 检查一次事件源，AI 判定命中才跑，见第二段。
//      主动制的"入站消息"车道（Lane B）不在这里，由 api/platform 的消息入口即时评估。

type RuntimeEnv = {
  DB: D1Database;
  HAIXIN_GATEWAY_ADMIN_SECRET?: string;
};

const runtime = env as unknown as RuntimeEnv;

// 一次 tick 最多处理这么多条，避免积压时一口气打满模型接口。
const MAX_PER_TICK = 5;
// 主动制命中后冷却时长（分钟）：同一事件在此窗口内不重复触发工作流。
const PROACTIVE_COOLDOWN_MIN = 60;

type DueWorkflow = {
  id: number;
  name: string;
  scheduleTime: string;
  nextRunAt: string;
  createdBy: string;
};

type DueProactive = {
  id: number;
  name: string;
  nextRunAt: string;
  createdBy: string;
  watchSourceType: string;
  watchSourceRef: string;
  triggerCondition: string;
  checkIntervalMin: number;
  lastTriggeredAt: string | null;
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

/**
 * 取主动制任务这一轮要"观察"的内容，交给 AI 判定是否命中触发条件。
 * data_source：先对该源刷新采集一次（拿到最新内容再判定，避免读到旧快照/空结果），
 *              再读它最近一次采集结果的预览；采集失败则回退到已有的最近一次结果。
 * free：不绑定具体源，聚合创建者可见的最近真实信号（近期采集结果 + 目标相关知识），
 *       让判定器有真实数据可依，而不是只对着一句"任务目标"空判——那样任何"数量/出现了X"
 *       类条件都永远看不到证据、永远未命中。
 */
async function proactiveObservation(task: DueProactive): Promise<string> {
  if (task.watchSourceType === "data_source") {
    const sourceId = Number(task.watchSourceRef);
    if (!(sourceId > 0)) return "";
    // 以创建者身份刷新采集；失败不抛出，继续读已有的最近一次结果。
    await collectSource(sourceId, task.createdBy, false).catch(() => undefined);
    const latest = await runtime.DB.prepare(
      "SELECT source_name AS sourceName,status,preview,created_at AS createdAt FROM data_collection_runs WHERE source_id=? ORDER BY id DESC LIMIT 1",
    ).bind(sourceId).first<{ sourceName: string; status: string; preview: string; createdAt: string }>();
    if (!latest) return "";
    return `数据源「${latest.sourceName}」最近一次采集（${latest.createdAt}，状态：${latest.status}）：\n${latest.preview || "（无内容）"}`;
  }
  // free：任务目标 + 创建者最近的真实数据信号（采集结果 + 目标相关知识），拼成可判定的观察上下文。
  const goalRow = await runtime.DB.prepare("SELECT goal FROM workflows WHERE id=?").bind(task.id).first<{ goal: string }>();
  const goalText = (goalRow?.goal || task.name || "").trim();
  const parts: string[] = [`任务目标：${goalText || task.name}`];
  // 近期采集结果：取创建者最近几条已成功的采集预览，作为"世界的最新状态"喂给判定器。
  const runs = await runtime.DB.prepare(
    "SELECT source_name AS sourceName,status,preview,created_at AS createdAt FROM data_collection_runs WHERE actor=? AND status IN ('成功','已入知识库') AND preview<>'' ORDER BY id DESC LIMIT 3",
  ).bind(task.createdBy).all<{ sourceName: string; status: string; preview: string; createdAt: string }>();
  for (const run of runs.results || []) {
    parts.push(`数据源「${run.sourceName}」最近采集（${run.createdAt}）：\n${(run.preview || "").slice(0, 1500)}`);
  }
  // 目标相关知识：按目标里的关键词命中全员或本人可见的知识文档，补充判定依据。
  const words = Array.from(new Set((goalText.match(/[一-鿿]{2,}|[a-zA-Z0-9_-]{3,}/g) || []))).slice(0, 5);
  if (words.length) {
    let sql = "SELECT title,content FROM knowledge_documents WHERE (visibility='全员' OR created_by=?)";
    const binds: unknown[] = [task.createdBy];
    sql += ` AND (${words.map(() => "(title LIKE ? OR content LIKE ?)").join(" OR ")})`;
    words.forEach(word => { binds.push(`%${word}%`, `%${word}%`); });
    sql += " ORDER BY updated_at DESC,id DESC LIMIT 3";
    const docs = await runtime.DB.prepare(sql).bind(...binds).all<{ title: string; content: string }>();
    for (const doc of docs.results || []) {
      parts.push(`知识「${doc.title}」：\n${(doc.content || "").slice(0, 1500)}`);
    }
  }
  return parts.join("\n\n");
}

/**
 * 主动制"检查痕迹"落库：把这一轮判定结果写回 workflows 三列，前端卡片即可显示
 * "上次检查时间 + 结果 + 依据"。命中/未命中/失败都记；冷却、被其他心跳领走这类瞬时状态不记，
 * 以免覆盖掉更有价值的"已触发/未命中"判定。
 */
async function recordCheck(taskId: number, result: string, detail: string) {
  await runtime.DB.prepare("UPDATE workflows SET last_checked_at=?,last_check_result=?,last_check_detail=? WHERE id=?")
    .bind(new Date().toISOString(), result, (detail || "").slice(0, 500), taskId).run();
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

  // —— 第二段：主动制轮询车道（Lane A）——
  // 到点检查 data_source/free 类主动制任务：抢占推进 next_run_at → 取观察内容 → AI 判定 →
  // 命中且过了冷却才真正跑工作流。inbound_message 类不在这里（由渠道消息入口即时评估）。
  const dueProactive = await runtime.DB.prepare(
    "SELECT id,name,next_run_at AS nextRunAt,created_by AS createdBy,watch_source_type AS watchSourceType,watch_source_ref AS watchSourceRef,trigger_condition AS triggerCondition,check_interval_min AS checkIntervalMin,last_triggered_at AS lastTriggeredAt FROM workflows WHERE enabled=1 AND watch_source_type IN ('data_source','free') AND next_run_at IS NOT NULL AND next_run_at<=? AND status<>'停用' ORDER BY next_run_at LIMIT ?",
  ).bind(now.toISOString(), MAX_PER_TICK).all<DueProactive>();

  for (const task of dueProactive.results || []) {
    // 抢占：把下次检查时刻推到 now+interval，改动为 0 说明已被别的 tick 领走。
    const upcoming = nextCheckAt(task.checkIntervalMin, now);
    const claimed = await runtime.DB.prepare(
      "UPDATE workflows SET next_run_at=? WHERE id=? AND next_run_at=?",
    ).bind(upcoming, task.id, task.nextRunAt).run();
    if (!claimed.meta.changes) {
      handled.push({ id: task.id, name: task.name, result: "主动制：已被其他心跳领走，跳过" });
      continue;
    }
    if (!task.createdBy) {
      handled.push({ id: task.id, name: task.name, result: "主动制：缺少创建者，已跳过" });
      continue;
    }
    // 命中后冷却期内不重复判定/触发，省一次模型调用。
    if (withinCooldown(task.lastTriggeredAt, PROACTIVE_COOLDOWN_MIN, now)) {
      handled.push({ id: task.id, name: task.name, result: "主动制：冷却中，跳过" });
      continue;
    }
    try {
      const observation = await proactiveObservation(task);
      if (!observation.trim()) {
        // 观察内容为空（如 data_source 尚无任何采集结果）：判定没有意义，直接记痕迹跳过。
        await recordCheck(task.id, "观察为空", task.watchSourceType === "data_source" ? "所选数据源还没有任何采集结果，无法判定。请先手动采集一次或检查数据源配置。" : "没有可供判定的观察内容。");
        handled.push({ id: task.id, name: task.name, result: "主动制：观察为空，跳过" });
        continue;
      }
      const verdict = await judgeTrigger(task.createdBy, task.triggerCondition, observation);
      if (!verdict.trigger) {
        await recordCheck(task.id, "未命中", verdict.reason);
        handled.push({ id: task.id, name: task.name, result: "主动制：未命中" });
        continue;
      }
      const role = await resolveActorRole(task.createdBy);
      const run = await runWorkflowById(task.id, task.createdBy, role, `【主动触发】${verdict.reason || task.triggerCondition}`, { sourceChannel: "主动触发" });
      await runtime.DB.prepare("UPDATE workflows SET last_triggered_at=? WHERE id=?").bind(now.toISOString(), task.id).run();
      await recordCheck(task.id, "已触发", `${verdict.reason || task.triggerCondition}（运行#${run.id}·${run.status || "已执行"}）`);
      handled.push({ id: task.id, name: task.name, result: `主动制：已触发（${run.status || "已执行"}）`, runId: run.id });
      await audit(task.createdBy, "主动触发工作流", task.name, run.status === "失败" ? "失败" : "成功", `运行#${run.id}；依据：${verdict.reason || task.triggerCondition}`);
    } catch (error) {
      // 判定或执行异常不该中断整轮心跳；下次检查会重试。judgeTrigger 现在会把模型调用失败抛到这里，
      // 记成"检查失败"而非伪装成"未命中"，前端能看出是链路故障、需去查密钥/接口。
      const message = error instanceof Error ? error.message : "主动制判定失败";
      await recordCheck(task.id, "检查失败", message);
      handled.push({ id: task.id, name: task.name, result: `主动制：${message}` });
      await audit(task.createdBy, "主动触发工作流", task.name, "失败", message);
    }
  }

  return success({ now: now.toISOString(), due: due.results?.length || 0, handled });
});

export const POST = (request: Request) => app.fetch(request);
