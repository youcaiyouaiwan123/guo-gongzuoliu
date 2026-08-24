import { env } from "cloudflare:workers";
import { callModel, callModelWithTools } from "../_modelProvider";
import { getAllSkills, executeSkill } from "./_skills";
import { ensureColumn } from "../_schema";
import { decryptSecret } from "../_crypto";

type RuntimeEnv = {
  DB: D1Database;
  MODEL_API_KEY?: string;
  MODEL_BASE_URL?: string;
  MODEL_NAME?: string;
  MODEL_PROVIDER?: string;
  COLLECTOR_PROXY_URL?: string;
};
type NodeType = "input" | "knowledge" | "agent" | "data" | "ai" | "review" | "approval" | "save" | "output";
type WorkflowNode = { id: string; type: NodeType; name: string; config?: string; modelMode?: string; parallelGroup?: string; inputMode?: "prompt" | "markdown" | "skill" | "direct"; promptGuide?: { role?: string; task?: string; context?: string; constraint?: string; format?: string; example?: string }; resourceTitle?: string; resourceContent?: string; knowledgeScope?: "all" | "enterprise" | "personal"; knowledgePick?: "library" | "files"; knowledgeDocs?: string[] };
type WorkflowRow = { id: number; name: string; steps: string; reviewStandard: string; maxLoops: number; goal?: string; stopCondition?: string; loopType?: string };
type WorkflowRunOptions = { runId?: number; startIndex?: number; current?: string; conversationId?: number; sourceChannel?: string };
const runtime = env as unknown as RuntimeEnv;

async function ensureSchema() {
  await runtime.DB.batch([
    runtime.DB.prepare("CREATE TABLE IF NOT EXISTS ai_agents (id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,description TEXT NOT NULL,instructions TEXT NOT NULL,knowledge_scope TEXT NOT NULL DEFAULT '全员',status TEXT NOT NULL DEFAULT '草稿',created_at TEXT NOT NULL,config_json TEXT NOT NULL DEFAULT '{}',created_by TEXT NOT NULL DEFAULT '')"),
    runtime.DB.prepare("CREATE TABLE IF NOT EXISTS agent_configs (agent_id INTEGER PRIMARY KEY,config_json TEXT NOT NULL DEFAULT '{}',created_by TEXT NOT NULL DEFAULT '',updated_at TEXT NOT NULL)"),
    runtime.DB.prepare("CREATE TABLE IF NOT EXISTS agent_runs (id INTEGER PRIMARY KEY AUTOINCREMENT,agent_id INTEGER NOT NULL,agent_name TEXT NOT NULL,actor TEXT NOT NULL,model_used TEXT NOT NULL DEFAULT '',input TEXT NOT NULL DEFAULT '',output TEXT NOT NULL DEFAULT '',status TEXT NOT NULL,created_at TEXT NOT NULL)"),
    runtime.DB.prepare("CREATE TABLE IF NOT EXISTS user_model_profiles (id INTEGER PRIMARY KEY AUTOINCREMENT,owner_email TEXT NOT NULL,connection_name TEXT NOT NULL,provider TEXT NOT NULL,base_url TEXT NOT NULL,model_name TEXT NOT NULL,encrypted_api_key TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)"),
    runtime.DB.prepare("CREATE INDEX IF NOT EXISTS agent_runs_agent_idx ON agent_runs(agent_id,id)"),
    runtime.DB.prepare("CREATE TABLE IF NOT EXISTS workflows (id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,trigger_type TEXT NOT NULL,steps TEXT NOT NULL,status TEXT NOT NULL DEFAULT '停用',loop_type TEXT NOT NULL DEFAULT '单次',review_mode TEXT NOT NULL DEFAULT '明确标准',review_standard TEXT NOT NULL DEFAULT '',stop_condition TEXT NOT NULL DEFAULT '',max_loops INTEGER NOT NULL DEFAULT 3,final_action TEXT NOT NULL DEFAULT '人工确认',failure_action TEXT NOT NULL DEFAULT '通知负责人',last_run_at TEXT,created_at TEXT NOT NULL)"),
    runtime.DB.prepare("CREATE TABLE IF NOT EXISTS data_sources (id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,source_type TEXT NOT NULL,source_url TEXT NOT NULL DEFAULT '',schedule TEXT NOT NULL DEFAULT '手动',status TEXT NOT NULL DEFAULT '待运行',last_run_at TEXT,created_at TEXT NOT NULL)"),
    runtime.DB.prepare("CREATE TABLE IF NOT EXISTS data_source_details (source_id INTEGER PRIMARY KEY,request_method TEXT NOT NULL DEFAULT 'GET',content_selector TEXT NOT NULL DEFAULT '',extract_fields TEXT NOT NULL DEFAULT '',target_category TEXT NOT NULL DEFAULT '数据采集',visibility TEXT NOT NULL DEFAULT '全员',publish_mode TEXT NOT NULL DEFAULT 'auto',sample_data TEXT NOT NULL DEFAULT '',model_mode TEXT NOT NULL DEFAULT 'auto',target_store TEXT NOT NULL DEFAULT 'personal',output_format TEXT NOT NULL DEFAULT 'markdown',collector_mode TEXT NOT NULL DEFAULT 'direct',created_by TEXT NOT NULL DEFAULT '')"),
    runtime.DB.prepare("CREATE TABLE IF NOT EXISTS data_collection_runs (id INTEGER PRIMARY KEY AUTOINCREMENT,source_id INTEGER NOT NULL,source_name TEXT NOT NULL,actor TEXT NOT NULL,status TEXT NOT NULL,http_status INTEGER NOT NULL DEFAULT 0,row_count INTEGER NOT NULL DEFAULT 0,content_type TEXT NOT NULL DEFAULT '',preview TEXT NOT NULL DEFAULT '',error TEXT NOT NULL DEFAULT '',model_used TEXT NOT NULL DEFAULT '',target_store TEXT NOT NULL DEFAULT 'personal',output_format TEXT NOT NULL DEFAULT 'markdown',collector_mode TEXT NOT NULL DEFAULT 'direct',created_at TEXT NOT NULL,published_at TEXT)"),
    runtime.DB.prepare("CREATE INDEX IF NOT EXISTS data_collection_runs_source_idx ON data_collection_runs(source_id,id)"),
    runtime.DB.prepare("CREATE TABLE IF NOT EXISTS knowledge_documents (id INTEGER PRIMARY KEY AUTOINCREMENT,title TEXT NOT NULL,content TEXT NOT NULL,visibility TEXT NOT NULL DEFAULT '全员',filename TEXT NOT NULL DEFAULT '',mime_type TEXT NOT NULL DEFAULT 'text/plain',file_key TEXT NOT NULL DEFAULT '',category TEXT NOT NULL DEFAULT '未分类',tags TEXT NOT NULL DEFAULT '',version INTEGER NOT NULL DEFAULT 1,update_mode TEXT NOT NULL DEFAULT '手动更新',update_schedule TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT '已索引',size_bytes INTEGER NOT NULL DEFAULT 0,created_by TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL DEFAULT '')"),
    runtime.DB.prepare("CREATE TABLE IF NOT EXISTS personal_knowledge (id INTEGER PRIMARY KEY AUTOINCREMENT,owner_email TEXT NOT NULL,title TEXT NOT NULL,content TEXT NOT NULL,source_type TEXT NOT NULL DEFAULT '手动创建',conversation_id INTEGER,sync_status TEXT NOT NULL DEFAULT '仅个人',enterprise_document_id INTEGER,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)"),
    runtime.DB.prepare("CREATE TABLE IF NOT EXISTS saved_artifacts (id INTEGER PRIMARY KEY AUTOINCREMENT,owner_email TEXT NOT NULL,title TEXT NOT NULL,artifact_type TEXT NOT NULL,source_type TEXT NOT NULL,content TEXT NOT NULL,config TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL,updated_at TEXT NOT NULL)"),
    runtime.DB.prepare("CREATE TABLE IF NOT EXISTS approval_requests (id INTEGER PRIMARY KEY AUTOINCREMENT,requester TEXT NOT NULL,request_type TEXT NOT NULL,title TEXT NOT NULL,reason TEXT NOT NULL,status TEXT NOT NULL DEFAULT '待审批',approver TEXT,comment TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,decided_at TEXT)"),
    runtime.DB.prepare("CREATE TABLE IF NOT EXISTS chat_messages (id INTEGER PRIMARY KEY AUTOINCREMENT,conversation_id INTEGER NOT NULL,role TEXT NOT NULL,content TEXT NOT NULL,sources TEXT NOT NULL DEFAULT '[]',model_used TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL)"),
    runtime.DB.prepare("CREATE TABLE IF NOT EXISTS audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT,actor TEXT NOT NULL,action TEXT NOT NULL,resource TEXT NOT NULL,result TEXT NOT NULL,detail TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL)"),
    runtime.DB.prepare("CREATE TABLE IF NOT EXISTS workflow_runs (id INTEGER PRIMARY KEY AUTOINCREMENT,workflow_id INTEGER NOT NULL,workflow_name TEXT NOT NULL,actor TEXT NOT NULL,status TEXT NOT NULL,input TEXT NOT NULL DEFAULT '',output TEXT NOT NULL DEFAULT '',current_step INTEGER NOT NULL DEFAULT 0,error TEXT NOT NULL DEFAULT '',started_at TEXT NOT NULL,finished_at TEXT)"),
    runtime.DB.prepare("CREATE TABLE IF NOT EXISTS workflow_step_runs (id INTEGER PRIMARY KEY AUTOINCREMENT,run_id INTEGER NOT NULL,step_index INTEGER NOT NULL,step_type TEXT NOT NULL,step_name TEXT NOT NULL,status TEXT NOT NULL,input TEXT NOT NULL DEFAULT '',output TEXT NOT NULL DEFAULT '',error TEXT NOT NULL DEFAULT '',started_at TEXT NOT NULL,finished_at TEXT)"),
    runtime.DB.prepare("CREATE INDEX IF NOT EXISTS workflow_runs_actor_idx ON workflow_runs(actor,id)"),
    runtime.DB.prepare("CREATE INDEX IF NOT EXISTS workflow_step_runs_run_idx ON workflow_step_runs(run_id,step_index)"),
    runtime.DB.prepare("CREATE TABLE IF NOT EXISTS org_members (email TEXT PRIMARY KEY,unit_id INTEGER NOT NULL,job_title TEXT NOT NULL DEFAULT '员工',direct_manager_email TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT '在岗',updated_at TEXT NOT NULL)"),
  ]);
  await ensureColumn(runtime.DB, "workflow_runs", "conversation_id", "INTEGER");
  await ensureColumn(runtime.DB, "workflow_runs", "source_channel", "TEXT NOT NULL DEFAULT '工作流中心'");
  await ensureColumn(runtime.DB, "approval_requests", "workflow_run_id", "INTEGER");
  await ensureColumn(runtime.DB, "approval_requests", "workflow_step_index", "INTEGER");
  await ensureColumn(runtime.DB, "approval_requests", "approver_email", "TEXT NOT NULL DEFAULT ''");
  await ensureColumn(runtime.DB, "approval_requests", "agent_id", "INTEGER");
  await ensureColumn(runtime.DB, "data_source_details", "model_mode", "TEXT NOT NULL DEFAULT 'auto'");
  await ensureColumn(runtime.DB, "data_source_details", "extract_fields", "TEXT NOT NULL DEFAULT ''");
  await ensureColumn(runtime.DB, "data_collection_runs", "model_used", "TEXT NOT NULL DEFAULT ''");
  await ensureColumn(runtime.DB, "data_source_details", "target_store", "TEXT NOT NULL DEFAULT 'personal'");
  await ensureColumn(runtime.DB, "data_source_details", "output_format", "TEXT NOT NULL DEFAULT 'markdown'");
  await ensureColumn(runtime.DB, "data_source_details", "collector_mode", "TEXT NOT NULL DEFAULT 'direct'");
  await ensureColumn(runtime.DB, "data_collection_runs", "target_store", "TEXT NOT NULL DEFAULT 'personal'");
  await ensureColumn(runtime.DB, "data_collection_runs", "output_format", "TEXT NOT NULL DEFAULT 'markdown'");
  await ensureColumn(runtime.DB, "data_collection_runs", "collector_mode", "TEXT NOT NULL DEFAULT 'direct'");
  await ensureColumn(runtime.DB, "data_source_details", "platform", "TEXT NOT NULL DEFAULT 'web'");
  await ensureColumn(runtime.DB, "data_source_details", "keyword", "TEXT NOT NULL DEFAULT ''");
  await ensureColumn(runtime.DB, "data_source_details", "crawl_depth", "INTEGER NOT NULL DEFAULT 1");
  await ensureColumn(runtime.DB, "data_source_details", "max_pages", "INTEGER NOT NULL DEFAULT 5");
  await ensureColumn(runtime.DB, "data_source_details", "url_pattern", "TEXT NOT NULL DEFAULT ''");
  await ensureColumn(runtime.DB, "data_source_details", "exclude_pattern", "TEXT NOT NULL DEFAULT ''");
  await ensureColumn(runtime.DB, "data_source_details", "include_comments", "TEXT NOT NULL DEFAULT 'no'");
  await ensureColumn(runtime.DB, "data_source_details", "export_profile", "TEXT NOT NULL DEFAULT 'knowledge'");
  await ensureColumn(runtime.DB, "data_source_details", "respect_robots", "TEXT NOT NULL DEFAULT 'yes'");
  // 企业自有 API 基本都要带鉴权头，按"每行 Key: Value"保存。
  await ensureColumn(runtime.DB, "data_source_details", "request_headers", "TEXT NOT NULL DEFAULT ''");
  // 定时任务调度：created_by 决定到点用谁的身份跑，enabled 与 status 分开是因为
  // status 跑完会变成"已完成"，没法再拿来判断该不该继续调度。详见 drizzle/0023。
  await ensureColumn(runtime.DB, "workflows", "created_by", "TEXT NOT NULL DEFAULT ''");
  await ensureColumn(runtime.DB, "workflows", "schedule_time", "TEXT NOT NULL DEFAULT ''");
  await ensureColumn(runtime.DB, "workflows", "next_run_at", "TEXT");
  await ensureColumn(runtime.DB, "workflows", "enabled", "INTEGER NOT NULL DEFAULT 0");
  // 持续任务（自动任务）的用户目标：以前只存在前端表单里，从没落库，
  // 于是定时/循环执行时节点拿不到目标，模型只能对着"定时触发"空转。详见修复计划。
  await ensureColumn(runtime.DB, "workflows", "goal", "TEXT NOT NULL DEFAULT ''");
  // 主动制（事件触发）：事件源 + 自然语言触发条件，AI 判定命中后直接跑该工作流。详见 drizzle/0024。
  // watch_source_type: data_source | inbound_message | free（空=非主动制）。
  await ensureColumn(runtime.DB, "workflows", "watch_source_type", "TEXT NOT NULL DEFAULT ''");
  await ensureColumn(runtime.DB, "workflows", "watch_source_ref", "TEXT NOT NULL DEFAULT ''");
  await ensureColumn(runtime.DB, "workflows", "trigger_condition", "TEXT NOT NULL DEFAULT ''");
  await ensureColumn(runtime.DB, "workflows", "check_interval_min", "INTEGER NOT NULL DEFAULT 10");
  await ensureColumn(runtime.DB, "workflows", "last_triggered_at", "TEXT");
  // 主动制"检查痕迹"：轮询判定 命中/未命中/失败 都不落 workflow_runs（未命中根本不产生运行），
  // 以前只在网关内存日志里一闪而过，前端完全看不到它在工作。这三列给每条主动制任务留一条
  // 最近判定痕迹，卡片上直接显示"上次检查 + 结果 + 依据"。
  await ensureColumn(runtime.DB, "workflows", "last_checked_at", "TEXT");
  await ensureColumn(runtime.DB, "workflows", "last_check_result", "TEXT NOT NULL DEFAULT ''");
  await ensureColumn(runtime.DB, "workflows", "last_check_detail", "TEXT NOT NULL DEFAULT ''");
}

async function getModel(email: string, mode = "auto") {
  const selectedId = mode?.startsWith("connection:") ? Number(mode.slice("connection:".length)) : null;
  const row = mode === "enterprise" || mode === "public"
    ? null
    : selectedId
      ? await runtime.DB.prepare("SELECT provider,base_url AS baseUrl,model_name AS model,encrypted_api_key AS encryptedApiKey FROM user_model_profiles WHERE owner_email=? AND id=?")
        .bind(email, selectedId).first<{ provider: string; baseUrl: string; model: string; encryptedApiKey: string }>()
      : await runtime.DB.prepare("SELECT provider,base_url AS baseUrl,model_name AS model,encrypted_api_key AS encryptedApiKey FROM user_model_profiles WHERE owner_email=? ORDER BY updated_at DESC,id DESC LIMIT 1")
        .bind(email).first<{ provider: string; baseUrl: string; model: string; encryptedApiKey: string }>();
  if (row) {
    const apiKey = await decryptSecret(row.encryptedApiKey);
    if (apiKey) return { provider: row.provider, baseUrl: row.baseUrl || runtime.MODEL_BASE_URL?.trim() || "https://claudecc.top", model: row.model, apiKey };
  }
  if (runtime.MODEL_API_KEY) return { provider: runtime.MODEL_PROVIDER || "OpenAI", baseUrl: runtime.MODEL_BASE_URL?.trim() || "https://claudecc.top", model: runtime.MODEL_NAME || "gpt-4.1-mini", apiKey: runtime.MODEL_API_KEY };
  return null;
}

async function askModel(email: string, instruction: string, content: string, mode = "auto") {
  const model = await getModel(email, mode);
  if (!model) throw new Error("尚未配置模型API，请先到“模型接入”填写自己的API");
  const messages = [
      { role: "system", content: "你是企业工作流执行器。只处理提供的信息，不虚构数据；输出可直接交付的中文结果。" },
      { role: "user", content: `${instruction}\n\n待处理内容：\n${content}` },
    ];
  // 持续任务一轮要串行跑「执行→审查→评估」多次调用，上游（claudecc.top）偶发排队会让某一次
  // 生成超过中转层 90s 而报 model relay timeout，进而拖垮整个 run。这里只对「超时类」错误自动重试
  // 一次（短暂退避）；鉴权/参数等确定性错误立即抛出，重试无意义。仅执行器路径重试，交互聊天不受影响。
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await callModel(model, messages, { temperature: 0.2 });
      return result.trim() || "模型未返回内容";
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      const isTimeout = /relay timeout|没有响应|超时|timeout/i.test(message);
      if (attempt === 0 && isTimeout) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

/**
 * 截图识别：把图片交给视觉模型，只要求原样转录，不做归纳。
 *
 * 采集任务此前只能手工粘贴 OCR 后的文字，用户拿着截图无处可放。
 * 提示词强调"只输出图里真实存在的内容"，避免模型把看不清的数字补全成"合理"的数字——
 * 采集数据一旦被编造，后面的清洗和入库都会把错误当事实沉淀下去。
 */
async function askModelWithImages(email: string, instruction: string, imageDataUrls: string[], mode = "auto") {
  const model = await getModel(email, mode);
  if (!model) throw new Error("尚未配置模型API，请先到“模型接入”填写自己的API");
  const result = await callModel(model, [
    {
      role: "system",
      content: "你是严谨的图片转文字助手。只输出图片中真实存在的文字与表格内容，逐字转录，不补全、不推测、不解释、不加任何说明。看不清的字符用 ? 代替。图中是表格时输出 Markdown 表格；不是表格时按原始分行输出纯文本；图中没有可读内容时只输出空字符串。",
    },
    {
      role: "user",
      content: [
        { type: "text" as const, text: instruction },
        ...imageDataUrls.map(url => ({ type: "image_url" as const, image_url: { url } })),
      ],
    },
  ], { temperature: 0, maxTokens: 3200 });
  return result.trim();
}

async function audit(actor: string, action: string, resource: string, result: string, detail: string) {
  await runtime.DB.prepare("INSERT INTO audit_logs(actor,action,resource,result,detail,created_at) VALUES(?,?,?,?,?,?)")
    .bind(actor, action, resource, result, detail, new Date().toISOString()).run();
}

/**
 * 带技能（Function Calling）的 AI 问答
 *
 * 将注册的采集技能注入模型，让 AI 自主决定调哪些工具来完成用户请求。
 * 适用于：数据采集、信息提取、内容整理等场景。
 */
async function askModelWithSkills(
  email: string,
  systemPrompt: string,
  userMessage: string,
  mode = "auto",
): Promise<{ text: string; toolCalls: unknown[] }> {
  const model = await getModel(email, mode);
  if (!model) throw new Error("尚未配置模型API，请先到“模型接入”填写自己的API");
  const result = await callModelWithTools(
    model,
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
    getAllSkills(),
    {
      maxTokens: 4000,
      temperature: 0.2,
      executeTool: async (name, args) => executeSkill(name, args),
    },
  );
  return { text: result.text, toolCalls: result.toolCalls };
}

export { runtime, ensureSchema, askModel, askModelWithImages, askModelWithSkills, audit };
export type { RuntimeEnv, NodeType, WorkflowNode, WorkflowRow, WorkflowRunOptions };
