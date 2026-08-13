import { env } from "cloudflare:workers";
import { collectSource, runWorkflowById, judgeTrigger } from "../modules/route";
import { callModel, type ModelConnection } from "../_modelProvider";
import { ensureColumn } from "../_schema";
import { withinCooldown } from "../_schedule";
import { createApp } from "../_app";
import { decryptSecret } from "../_crypto";

type Platform = "feishu" | "dingtalk" | "wecom";
type RuntimeEnv = {
  DB: D1Database;
  MODEL_API_KEY?: string;
  MODEL_BASE_URL?: string;
  MODEL_NAME?: string;
  PLATFORM_CREDENTIALS_KEY?: string;
  FEISHU_APP_ID?: string;
  FEISHU_APP_SECRET?: string;
  FEISHU_VERIFICATION_TOKEN?: string;
  DINGTALK_CALLBACK_TOKEN?: string;
  WECOM_CALLBACK_TOKEN?: string;
};
type Identity = { email: string; role: string; businessRole: string };
type PersonalCredentials = {
  appId: string;
  appSecret: string;
  callbackToken: string;
  connectionMode?: "callback" | "long_connection";
  defaultModelMode?: string;
};

const runtime = env as unknown as RuntimeEnv;
const zh = {
  admin: "\u7ba1\u7406\u5458",
  staff: "\u666e\u901a\u5458\u5de5",
  salesManager: "\u9500\u552e\u7ecf\u7406",
  processing: "\u5904\u7406\u4e2d",
  replied: "\u5df2\u56de\u590d",
  failed: "\u5931\u8d25",
  duplicate: "\u6d88\u606f\u6b63\u5728\u5904\u7406\uff0c\u8bf7\u7a0d\u540e\u3002",
  modelMissing: "\u673a\u5668\u4eba\u5c1a\u672a\u914d\u7f6e\u53ef\u7528\u7684\u5927\u6a21\u578b\u3002\u8bf7\u5728\u5e73\u53f0\u63a5\u5165\u91cc\u9009\u62e9\u673a\u5668\u4eba\u9ed8\u8ba4\u6a21\u578b\uff0c\u6216\u5148\u914d\u7f6e\u4f01\u4e1a\u516c\u5171\u6a21\u578b\u3002",
  modelFailed: "\u6a21\u578b\u8c03\u7528\u5931\u8d25\uff0c\u8bf7\u68c0\u67e5\u5e73\u53f0\u63a5\u5165\u91cc\u8be5\u673a\u5668\u4eba\u7684\u9ed8\u8ba4\u6a21\u578b\u548c API Key\u3002",
  platformChat: "\u5e73\u53f0\u673a\u5668\u4eba\u95ee\u7b54",
  success: "\u6210\u529f",
  deny: "\u62d2\u7edd",
  noPermission: "\u4f60\u6682\u65f6\u6ca1\u6709\u8fd9\u4e2a\u64cd\u4f5c\u6743\u9650\u3002",
  commandUnknown: "\u6682\u65f6\u6ca1\u6709\u8bc6\u522b\u5230\u53ef\u6267\u884c\u6307\u4ee4\u3002\u4f60\u53ef\u4ee5\u76f4\u63a5\u95ee\u6211\uff0c\u6216\u4f7f\u7528\uff1a\u786e\u8ba4\u8fd0\u884c\u5de5\u4f5c\u6d41 #ID | \u8f93\u5165\u5185\u5bb9",
  commandFailed: "\u6307\u4ee4\u6267\u884c\u5931\u8d25\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5\u3002",
  handleFailed: "\u5904\u7406\u5931\u8d25\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5\u3002",
  personalKnowledge: "\u4e2a\u4eba\u77e5\u8bc6\u5e93",
  enterpriseKnowledge: "\u4f01\u4e1a\u77e5\u8bc6\u5e93",
  bothKnowledge: "\u4e2a\u4eba\u77e5\u8bc6\u5e93\u548c\u4f01\u4e1a\u77e5\u8bc6\u5e93",
  document: "\u6587\u6863",
  table: "\u8868\u683c",
  raw: "\u539f\u59cb\u6587\u672c",
  employee: "\u5458\u5de5",
  active: "\u5728\u5c97",
  manual: "\u624b\u52a8\u521b\u5efa",
  onlyPersonal: "\u4ec5\u4e2a\u4eba",
};

function inferModelProvider(model = "") {
  const name = model.toLowerCase();
  if (name.includes("claude")) return "Anthropic Claude";
  if (name.includes("gemini")) return "Google Gemini";
  if (name.includes("deepseek")) return "DeepSeek";
  if (name.includes("glm")) return "GLM";
  if (name.includes("qwen")) return "Qwen";
  if (name.includes("kimi")) return "Moonshot AI";
  if (name.includes("minimax")) return "MiniMax";
  if (name.includes("gpt")) return "OpenAI";
  return "Third-party Model";
}

function hasDirtyDisplayText(value = "") {
  const text = value.trim();
  return !text || text.includes("?") || text.includes("\ufffd") || /[\u9300-\u9fff]/u.test(text);
}

function cleanProvider(provider = "", model = "") {
  return hasDirtyDisplayText(provider) ? inferModelProvider(model) : provider.trim();
}

function normalizeRole(role?: string | null) {
  const text = String(role || "");
  return text === zh.admin || text.includes("\u7ba1") || text.includes("\u7ba1\u7406") ? zh.admin : zh.staff;
}

function platformLog(stage: string, data: Record<string, unknown> = {}) {
  console.log(`[platform] ${stage}`, JSON.stringify(data));
}

function json(data: unknown, status = 200) {
  return Response.json(data, { status });
}

// 平台凭证/模型密钥统一走 _crypto 的对称解密（写入侧在 connectors/model 用 encryptSecret/encryptJson）。
// 历史遗留：本文件曾直接引用未定义的 decryptWithPlatformKey，导致长连接凭证解密必抛错、
// personalConnection 恒返回 null（表现为网关心跳/消息一律 404 connection not found）。
async function decryptWithPlatformKey(payload: string): Promise<string> {
  const text = await decryptSecret(payload);
  if (text === null) throw new Error("平台凭证解密失败");
  return text;
}

async function personalConnection(connectionKey: string | null, platform: Platform) {
  if (!connectionKey || !runtime.PLATFORM_CREDENTIALS_KEY) return null;
  const row = await runtime.DB.prepare("SELECT owner_email AS ownerEmail,encrypted_credentials AS encryptedCredentials FROM user_platform_connections WHERE connection_key=? AND platform=?")
    .bind(connectionKey, platform)
    .first<{ ownerEmail: string; encryptedCredentials: string }>();
  if (!row) return null;
  try {
    const credentials = JSON.parse(await decryptWithPlatformKey(row.encryptedCredentials)) as PersonalCredentials;
    return { ownerEmail: row.ownerEmail, credentials };
  } catch (error) {
    platformLog("personal_connection.decrypt_failed", { platform, connectionKey, error: String(error) });
    return null;
  }
}

async function connectionIdentity(email: string): Promise<Identity> {
  const row = await runtime.DB.prepare("SELECT role FROM user_roles WHERE email=?").bind(email).first<{ role: string }>();
  const role = normalizeRole(row?.role);
  return { email, role, businessRole: role === zh.admin ? zh.salesManager : zh.staff };
}

async function decryptModelKey(value: string) {
  try {
    return await decryptWithPlatformKey(value);
  } catch (error) {
    platformLog("model.decrypt_failed", { error: String(error) });
    return "";
  }
}

async function personalModel(email: string, mode = "auto"): Promise<ModelConnection | null> {
  if (mode === "enterprise") return null;
  const selectedId = mode.startsWith("connection:") ? Number(mode.slice("connection:".length)) : null;
  let row = selectedId
    ? await runtime.DB.prepare("SELECT provider,base_url AS baseUrl,model_name AS model,encrypted_api_key AS encryptedApiKey FROM user_model_profiles WHERE owner_email=? AND id=?")
      .bind(email, selectedId)
      .first<{ provider: string; baseUrl: string; model: string; encryptedApiKey: string }>()
    : null;
  if (!row) {
    row = await runtime.DB.prepare("SELECT provider,base_url AS baseUrl,model_name AS model,encrypted_api_key AS encryptedApiKey FROM user_model_profiles WHERE owner_email=? ORDER BY updated_at DESC,id DESC LIMIT 1")
      .bind(email)
      .first<{ provider: string; baseUrl: string; model: string; encryptedApiKey: string }>();
  }
  if (!row) return null;
  const apiKey = await decryptModelKey(row.encryptedApiKey);
  if (!apiKey) return null;
  return { provider: cleanProvider(row.provider, row.model), baseUrl: "https://claudecc.top", model: row.model, apiKey };
}

function enterpriseModel(): ModelConnection | null {
  if (!runtime.MODEL_API_KEY) return null;
  return { provider: "OpenAI", baseUrl: runtime.MODEL_BASE_URL || "https://claudecc.top", model: runtime.MODEL_NAME || "gpt-5.5", apiKey: runtime.MODEL_API_KEY };
}

function targetStoreLabel(value?: string) {
  if (value === "enterprise") return zh.enterpriseKnowledge;
  if (value === "both") return zh.bothKnowledge;
  return zh.personalKnowledge;
}

function outputFormatLabel(value?: string) {
  return ({ markdown: "Markdown", document: zh.document, table: zh.table, json: "JSON", raw: zh.raw } as Record<string, string>)[value || "markdown"] || "Markdown";
}

async function ensureSchema() {
  await runtime.DB.batch([
    runtime.DB.prepare("CREATE TABLE IF NOT EXISTS platform_identities (id INTEGER PRIMARY KEY AUTOINCREMENT,platform TEXT NOT NULL,platform_user_id TEXT NOT NULL,email TEXT NOT NULL,display_name TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,UNIQUE(platform,platform_user_id))"),
    runtime.DB.prepare("CREATE TABLE IF NOT EXISTS platform_messages (event_id TEXT PRIMARY KEY,platform TEXT NOT NULL,platform_user_id TEXT NOT NULL DEFAULT '',status TEXT NOT NULL,reply TEXT NOT NULL DEFAULT '',error TEXT NOT NULL DEFAULT '',owner_email TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL)"),
    runtime.DB.prepare("CREATE TABLE IF NOT EXISTS platform_gateway_status (owner_email TEXT NOT NULL,platform TEXT NOT NULL,instance_id TEXT NOT NULL DEFAULT '',state TEXT NOT NULL DEFAULT 'offline',last_heartbeat_at TEXT NOT NULL DEFAULT '',last_connected_at TEXT NOT NULL DEFAULT '',last_error TEXT NOT NULL DEFAULT '',inbound_count INTEGER NOT NULL DEFAULT 0,outbound_count INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL,PRIMARY KEY(owner_email,platform))"),
    runtime.DB.prepare("CREATE TABLE IF NOT EXISTS audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT,actor TEXT NOT NULL,action TEXT NOT NULL,resource TEXT NOT NULL,result TEXT NOT NULL,detail TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL)"),
    runtime.DB.prepare("CREATE TABLE IF NOT EXISTS org_members (email TEXT PRIMARY KEY,unit_id INTEGER NOT NULL,job_title TEXT NOT NULL DEFAULT '" + zh.employee + "',direct_manager_email TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT '" + zh.active + "',updated_at TEXT NOT NULL)"),
    runtime.DB.prepare("CREATE TABLE IF NOT EXISTS personal_knowledge (id INTEGER PRIMARY KEY AUTOINCREMENT,owner_email TEXT NOT NULL,title TEXT NOT NULL,content TEXT NOT NULL,source_type TEXT NOT NULL DEFAULT '" + zh.manual + "',conversation_id INTEGER,sync_status TEXT NOT NULL DEFAULT '" + zh.onlyPersonal + "',enterprise_document_id INTEGER,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)"),
  ]);
  await ensureColumn(runtime.DB, "platform_messages", "owner_email", "TEXT NOT NULL DEFAULT ''");
}

async function saveGatewayStatus(ownerEmail: string, platform: Platform, payload: Record<string, unknown>) {
  const now = new Date().toISOString();
  const state = String(payload.state || "online");
  const connectedAt = state === "online" ? now : String(payload.lastConnectedAt || "");
  const instanceId = String(payload.instanceId || "");
  const error = String(payload.error || "").slice(0, 1000);
  const inboundCount = Math.max(0, Number(payload.inboundCount || 0));
  const outboundCount = Math.max(0, Number(payload.outboundCount || 0));
  await runtime.DB.prepare(
    "UPDATE platform_gateway_status SET instance_id=?,state=?,last_heartbeat_at=?,last_connected_at=CASE WHEN ?='' THEN last_connected_at ELSE ? END,last_error=?,inbound_count=?,outbound_count=?,updated_at=? WHERE owner_email=? AND platform=?",
  )
    .bind(instanceId, state, now, connectedAt, connectedAt, error, inboundCount, outboundCount, now, ownerEmail, platform)
    .run();
  const exists = await runtime.DB.prepare("SELECT owner_email FROM platform_gateway_status WHERE owner_email=? AND platform=?")
    .bind(ownerEmail, platform)
    .first()
    .catch(() => null);
  if (!exists) {
    await runtime.DB.prepare(
      "INSERT INTO platform_gateway_status(owner_email,platform,instance_id,state,last_heartbeat_at,last_connected_at,last_error,inbound_count,outbound_count,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(ownerEmail, platform, instanceId, state, now, connectedAt, error, inboundCount, outboundCount, now)
      .run();
  }
}

async function audit(actor: string, action: string, resource: string, result = zh.success, detail = "") {
  await runtime.DB.prepare("INSERT INTO audit_logs (actor,action,resource,result,detail,created_at) VALUES (?,?,?,?,?,?)")
    .bind(actor, action, resource, result, detail.slice(0, 1000), new Date().toISOString())
    .run()
    .catch(error => platformLog("audit.failed", { action, error: String(error) }));
}

async function reserve(eventId: string, platform: Platform, platformUserId: string, ownerEmail = "") {
  const now = new Date().toISOString();
  const result = await runtime.DB.prepare("INSERT OR IGNORE INTO platform_messages (event_id,platform,platform_user_id,status,owner_email,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .bind(eventId, platform, platformUserId, zh.processing, ownerEmail, now, now)
    .run();
  return Boolean((result.meta as { changes?: number } | undefined)?.changes);
}

async function finish(eventId: string, reply: string, error = "") {
  const status = error ? zh.failed : zh.replied;
  await runtime.DB.prepare("UPDATE platform_messages SET status=?,reply=?,error=?,updated_at=? WHERE event_id=?")
    .bind(status, reply.slice(0, 5000), error.slice(0, 1000), new Date().toISOString(), eventId)
    .run();
}

async function allowed(identity: Identity, action: string) {
  if (identity.role === zh.admin) return true;
  const row = await runtime.DB.prepare("SELECT allowed FROM role_permissions WHERE role=? AND permission=?")
    .bind(identity.role, action)
    .first<{ allowed: number }>()
    .catch(() => null);
  return Boolean(row?.allowed);
}

async function executeCommand(identity: Identity, text: string) {
  const workflowMatch = text.match(/^\s*(?:confirm\s+run\s+workflow|确认运行工作流)\s*#?(\d+)\s*(?:\|\s*(.*))?$/i);
  if (workflowMatch) {
    if (!(await allowed(identity, "run_workflow"))) return zh.noPermission;
    const id = Number(workflowMatch[1]);
    const input = workflowMatch[2] || text;
    const result = await runWorkflowById(id, identity.email, identity.role, input, { sourceChannel: "platform" });
    await audit(identity.email, "\u5e73\u53f0\u8fd0\u884c\u5de5\u4f5c\u6d41", `#${id}`);
    return `\u5de5\u4f5c\u6d41\u72b6\u6001\uff1a${result.status}${result.output ? `\n${result.output}` : ""}`;
  }

  const collectMatch = text.match(/^\s*(?:confirm\s+run\s+collection|确认运行数据采集)\s*#?(\d+)\s*$/i);
  if (collectMatch) {
    if (!(await allowed(identity, "collect_data"))) return zh.noPermission;
    const id = Number(collectMatch[1]);
    try {
      const result = await collectSource(id, identity.email);
      const message = `\u6570\u636e\u91c7\u96c6\u5df2\u5b8c\u6210\uff1a${result.rowCount}\u6761\uff0c\u8fd0\u884c#${result.runId || "-"}`;
      await audit(identity.email, "\u5e73\u53f0\u8fd0\u884c\u6570\u636e\u91c7\u96c6", `#${id}`, zh.success, message);
      return message;
    } catch (error) {
      const message = error instanceof Error ? error.message : "\u6570\u636e\u91c7\u96c6\u5931\u8d25";
      await audit(identity.email, "\u5e73\u53f0\u8fd0\u884c\u6570\u636e\u91c7\u96c6", `#${id}`, zh.failed, message);
      return message;
    }
  }

  const approvalMatch = text.match(/^\s*(?:apply approval|申请审批)\s*[|｜]\s*(.+?)\s*[|｜]\s*(.+?)\s*[|｜]\s*([\s\S]+)$/i);
  if (approvalMatch) {
    const [, type, title, reason] = approvalMatch;
    await runtime.DB.prepare("INSERT INTO approvals (type,title,reason,requester,approver,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
      .bind(type.trim(), title.trim(), reason.trim(), identity.email, "", "\u5f85\u5ba1\u6279", new Date().toISOString(), new Date().toISOString())
      .run()
      .catch(() => undefined);
    await audit(identity.email, "\u5e73\u53f0\u53d1\u8d77\u5ba1\u6279", title.trim());
    return "\u5ba1\u6279\u5df2\u53d1\u8d77\uff0c\u7ba1\u7406\u8005\u4f1a\u5728\u5ba1\u6279\u4e2d\u5fc3\u770b\u5230\u3002";
  }
  return null;
}

async function businessContext(identity: Identity) {
  const [docs, personal, agents, workflows, sources, approvals, artifacts] = await Promise.all([
    runtime.DB.prepare("SELECT title,summary,content FROM enterprise_documents WHERE visibility='全员' OR visibility='all' OR visibility='public' ORDER BY id DESC LIMIT 5").all<{ title: string; summary: string; content: string }>().catch(() => ({ results: [] as { title: string; summary: string; content: string }[] })),
    runtime.DB.prepare("SELECT title,content FROM personal_knowledge WHERE owner_email=? ORDER BY id DESC LIMIT 5").bind(identity.email).all<{ title: string; content: string }>().catch(() => ({ results: [] as { title: string; content: string }[] })),
    runtime.DB.prepare("SELECT name,purpose,instructions FROM agents ORDER BY id DESC LIMIT 5").all<{ name: string; purpose: string; instructions: string }>().catch(() => ({ results: [] as { name: string; purpose: string; instructions: string }[] })),
    runtime.DB.prepare("SELECT id,name,description FROM workflows ORDER BY id DESC LIMIT 5").all<{ id: number; name: string; description: string }>().catch(() => ({ results: [] as { id: number; name: string; description: string }[] })),
    runtime.DB.prepare("SELECT id,name,url,target_store AS targetStore,output_format AS outputFormat,status FROM data_sources ORDER BY id DESC LIMIT 5").all<{ id: number; name: string; url: string; targetStore: string; outputFormat: string; status: string }>().catch(() => ({ results: [] as { id: number; name: string; url: string; targetStore: string; outputFormat: string; status: string }[] })),
    runtime.DB.prepare("SELECT type,title,status FROM approvals WHERE requester=? OR approver=? ORDER BY id DESC LIMIT 5").bind(identity.email, identity.email).all<{ type: string; title: string; status: string }>().catch(() => ({ results: [] as { type: string; title: string; status: string }[] })),
    runtime.DB.prepare("SELECT title,type,content FROM artifacts WHERE owner=? ORDER BY id DESC LIMIT 5").bind(identity.email).all<{ title: string; type: string; content: string }>().catch(() => ({ results: [] as { title: string; type: string; content: string }[] })),
  ]);

  return [
    `User: ${identity.email}`,
    `Role: ${identity.role} / ${identity.businessRole}`,
    "Enterprise knowledge:",
    ...docs.results.map(item => `- ${item.title}: ${item.summary || item.content?.slice(0, 220) || ""}`),
    "Personal knowledge:",
    ...personal.results.map(item => `- ${item.title}: ${item.content?.slice(0, 220) || ""}`),
    "Agents:",
    ...agents.results.map(item => `- ${item.name}: ${item.purpose || item.instructions?.slice(0, 160) || ""}`),
    "Workflows:",
    ...workflows.results.map(item => `- #${item.id} ${item.name}: ${item.description || ""}`),
    "Data collection:",
    ...sources.results.map(item => `- #${item.id} ${item.name}: ${item.url || ""}; store=${targetStoreLabel(item.targetStore)}; format=${outputFormatLabel(item.outputFormat)}; status=${item.status}`),
    "Approvals:",
    ...approvals.results.map(item => `- ${item.type} / ${item.title}: ${item.status}`),
    "Saved MD/Skill:",
    ...artifacts.results.map(item => `- ${item.title} (${item.type}): ${item.content?.slice(0, 160) || ""}`),
  ].filter(Boolean).join("\n");
}

async function answer(identity: Identity, text: string, modelMode = "auto") {
  const commandResult = await executeCommand(identity, text).catch(error => {
    platformLog("command.failed", { error: String(error) });
    return zh.commandFailed;
  });
  if (commandResult) return commandResult;

  const selectedModel = await personalModel(identity.email, modelMode);
  const fallbackModel = enterpriseModel();
  const model = selectedModel || fallbackModel;
  platformLog("model.select", {
    email: identity.email,
    mode: modelMode,
    selected: selectedModel ? `${selectedModel.provider}:${selectedModel.model}` : null,
    fallback: fallbackModel ? `${fallbackModel.provider}:${fallbackModel.model}` : null,
  });
  if (!model) return zh.modelMissing;

  const context = await businessContext(identity);
  const system = [
    "\u4f60\u662f\u6d77\u82af\u535a\u521b\u4f01\u4e1a\u52a9\u624b\uff0c\u6b63\u5728\u98de\u4e66\u3001\u9489\u9489\u6216\u4f01\u4e1a\u5fae\u4fe1\u673a\u5668\u4eba\u4e2d\u56de\u590d\u7528\u6237\u3002",
    "\u8bf7\u7528\u7b80\u6d01\u4e2d\u6587\u56de\u590d\u3002",
    "\u53ef\u4ee5\u7ed3\u5408\u4e0b\u65b9\u4f01\u4e1a\u80cc\u666f\uff0c\u4f46\u4e0d\u8981\u7f16\u9020\u672a\u77e5\u4fe1\u606f\u3002",
    context,
  ].join("\n");
  const messages = [{ role: "system" as const, content: system }, { role: "user" as const, content: text }];

  try {
    const reply = await callModel(model, messages);
    if (reply) return reply;
    throw new Error("empty model response");
  } catch (error) {
    platformLog("model.primary_failed", { model: model.model, error: String(error) });
    if (fallbackModel && (!selectedModel || fallbackModel.model !== selectedModel.model)) {
      try {
        const reply = await callModel(fallbackModel, messages);
        if (reply) return reply;
      } catch (fallbackError) {
        platformLog("model.fallback_failed", { model: fallbackModel.model, error: String(fallbackError) });
      }
    }
    return zh.modelFailed;
  }
}

async function identityForPlatform(platform: Platform, platformUserId: string, ownerEmail?: string): Promise<Identity> {
  if (ownerEmail) return connectionIdentity(ownerEmail);
  const row = await runtime.DB.prepare("SELECT email FROM platform_identities WHERE platform=? AND platform_user_id=?")
    .bind(platform, platformUserId)
    .first<{ email: string }>();
  if (row?.email) return connectionIdentity(row.email);
  return { email: `${platformUserId}@${platform}.local`, role: zh.staff, businessRole: zh.staff };
}

// 主动制"入站消息"车道：找出监听该平台的"收到消息"型主动制任务，
// 对消息文本做 AI 触发判定，命中就以任务创建者身份跑对应工作流。冷却窗口内不重复触发。
const INBOUND_PROACTIVE_COOLDOWN_MIN = 60;
async function evaluateInboundProactive(platform: Platform, text: string) {
  const tasks = await runtime.DB.prepare(
    "SELECT id,name,created_by AS createdBy,trigger_condition AS triggerCondition,last_triggered_at AS lastTriggeredAt FROM workflows WHERE enabled=1 AND watch_source_type='inbound_message' AND watch_source_ref=? AND status<>'停用'",
  ).bind(platform).all<{ id: number; name: string; createdBy: string; triggerCondition: string; lastTriggeredAt: string | null }>();
  const now = new Date();
  for (const task of tasks.results || []) {
    if (!task.createdBy) continue;
    if (withinCooldown(task.lastTriggeredAt, INBOUND_PROACTIVE_COOLDOWN_MIN, now)) continue;
    const verdict = await judgeTrigger(task.createdBy, task.triggerCondition, `收到${platform}消息：${text}`);
    if (!verdict.trigger) continue;
    const creator = await connectionIdentity(task.createdBy);
    await runWorkflowById(task.id, task.createdBy, creator.role, `【消息触发】${verdict.reason || task.triggerCondition}`, { sourceChannel: "主动触发" });
    await runtime.DB.prepare("UPDATE workflows SET last_triggered_at=? WHERE id=?").bind(now.toISOString(), task.id).run();
    await audit(task.createdBy, "主动触发工作流", task.name, zh.success, `渠道消息命中；依据：${verdict.reason || task.triggerCondition}`);
  }
}

async function handleMessage(platform: Platform, platformUserId: string, text: string, eventId: string, ownerEmail?: string, modelMode = "auto") {
  await ensureSchema();
  const identity = await identityForPlatform(platform, platformUserId, ownerEmail);
  const inserted = await reserve(eventId, platform, platformUserId, identity.email);
  if (!inserted) return zh.duplicate;
  try {
    platformLog("message.received", { platform, eventId, ownerEmail: identity.email, modelMode, textLength: text.length });
    const reply = await answer(identity, text, modelMode);
    await finish(eventId, reply);
    await audit(identity.email, zh.platformChat, platform, zh.success, text.slice(0, 500));
    platformLog("message.replied", { platform, eventId, replyLength: reply.length });
    // 主动制入站消息车道（Lane B）：回复之后再评估该平台的"收到消息"型主动制任务，
    // 命中就跑对应工作流。放在回复之后、且整段 try/catch，绝不影响机器人正常应答。
    await evaluateInboundProactive(platform, text).catch(error => {
      platformLog("proactive.failed", { platform, eventId, error: error instanceof Error ? error.message : String(error) });
    });
    return reply;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finish(eventId, "", message);
    platformLog("message.failed", { platform, eventId, error: message });
    return zh.handleFailed;
  }
}

function pickPlatform(url: URL): Platform {
  const value = url.searchParams.get("platform");
  if (value === "dingtalk" || value === "wecom" || value === "feishu") return value;
  return "feishu";
}

async function verifyFeishuChallenge(request: Request) {
  const payload = await request.json().catch(() => ({} as { challenge?: string; token?: string; type?: string }));
  if (payload?.type === "url_verification" && payload.challenge) {
    if (!runtime.FEISHU_VERIFICATION_TOKEN || payload.token === runtime.FEISHU_VERIFICATION_TOKEN) return json({ challenge: payload.challenge });
    return json({ error: "invalid token" }, 403);
  }
  return null;
}

function getTextFromPayload(payload: Record<string, unknown>) {
  const direct = typeof payload.text === "string" ? payload.text : "";
  if (direct) return direct;
  const event = payload.event as Record<string, unknown> | undefined;
  const message = event?.message as Record<string, unknown> | undefined;
  const content = typeof message?.content === "string" ? message.content : "";
  if (!content) return "";
  try {
    const parsed = JSON.parse(content) as { text?: string };
    return parsed.text || "";
  } catch {
    return content;
  }
}

function getEventId(payload: Record<string, unknown>) {
  const header = payload.header as Record<string, unknown> | undefined;
  const event = payload.event as Record<string, unknown> | undefined;
  const message = event?.message as Record<string, unknown> | undefined;
  return String(header?.event_id || message?.message_id || payload.eventId || crypto.randomUUID());
}

function getPlatformUserId(payload: Record<string, unknown>) {
  const event = payload.event as Record<string, unknown> | undefined;
  const sender = event?.sender as Record<string, unknown> | undefined;
  const senderId = sender?.sender_id as Record<string, unknown> | undefined;
  return String(senderId?.open_id || sender?.user_id || payload.platformUserId || "anonymous");
}

const app = createApp();

// POST /api/platform — 平台回调入口（webhook，无需标准 auth 中间件）
app.post("*", async (c) => {
  const url = new URL(c.req.url);
  const platform = pickPlatform(url);
  const transport = url.searchParams.get("transport");
  const connectionKey = url.searchParams.get("connection");

  if (platform === "feishu" && transport !== "long_connection") {
    const challenge = await verifyFeishuChallenge(c.req.raw);
    if (challenge) return challenge;
  }

  if (transport === "long_connection") {
    const connection = await personalConnection(connectionKey, platform);
    if (!connection) return json({ error: "connection not found" }, 404);
    if (connection.credentials.connectionMode !== "long_connection") return json({ error: "connection is not long_connection mode" }, 400);
    const auth = c.req.header("authorization") || "";
    if (auth !== `Bearer ${connection.credentials.callbackToken}`) return json({ error: "unauthorized" }, 403);
    const payload = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    if (payload.type === "gateway_heartbeat" || payload.kind === "gateway_heartbeat") {
      await ensureSchema();
      await saveGatewayStatus(connection.ownerEmail, platform, payload);
      return json({ ok: true, modelMode: connection.credentials.defaultModelMode || "auto", serverTime: new Date().toISOString() });
    }
    const text = getTextFromPayload(payload);
    if (!text.trim()) return json({ ok: true, ignored: "empty text" });
    const effectiveModelMode = String(
      connection.credentials.defaultModelMode || payload.modelMode || "auto",
    );
    platformLog("message.model_mode.resolve", {
      platform,
      savedModelMode: connection.credentials.defaultModelMode || null,
      gatewayModelMode: payload.modelMode || null,
      effectiveModelMode,
    });
    const reply = await handleMessage(
      platform,
      getPlatformUserId(payload),
      text,
      getEventId(payload),
      connection.ownerEmail,
      effectiveModelMode,
    );
    return json({ ok: true, reply, modelMode: effectiveModelMode });
  }

  const payload = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  const text = getTextFromPayload(payload);
  if (!text.trim()) return json({ ok: true, ignored: "empty text" });
  const reply = await handleMessage(platform, getPlatformUserId(payload), text, getEventId(payload), undefined, "auto");
  return json({ ok: true, reply });
});

export const POST = (request: Request) => app.fetch(request);
