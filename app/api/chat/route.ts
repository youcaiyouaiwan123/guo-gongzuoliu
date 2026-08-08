import { env } from "cloudflare:workers";
import { authorizeCapability } from "../_auth";
import { runWorkflowById } from "../modules/route";
import { callModel } from "../_modelProvider";
import { decryptSecret } from "../_crypto";
import { createApp, auth, success, fail } from "../_app";
import { log } from "../_logger";

type RuntimeEnv = {
  DB: D1Database;
  MODEL_API_KEY?: string;
  MODEL_BASE_URL?: string;
  MODEL_NAME?: string;
  MODEL_PROVIDER?: string;
  PLATFORM_CREDENTIALS_KEY?: string;
};
const runtime = env as unknown as RuntimeEnv;

type WorkflowRun = { status: string; workflowName: string; currentStep: number; output?: string; error?: string };
type ChatMessageRow = { role: string; content: string; sources: string; modelUsed: string; createdAt: string };
type BusinessRow = { id?: number; name?: string; title?: string; description?: string; status?: string; schedule?: string; platform?: string; artifactType?: string; sourceType?: string; variables?: string; templateTitle?: string };
type AgentConfig = { modelMode?: string; capabilities?: string[]; knowledgeCategory?: string; prompt?: unknown; memoryMode?: string; approvalMode?: string };

function inferModelProvider(model = "") {
  const name = model.toLowerCase();
  if (name.includes("claude")) return "Anthropic Claude";
  if (name.includes("gemini")) return "Google Gemini";
  if (name.includes("deepseek")) return "DeepSeek";
  if (name.includes("glm")) return "Zhipu AI";
  if (name.includes("qwen")) return "Tongyi Qianwen";
  if (name.includes("kimi")) return "Moonshot AI";
  if (name.includes("minimax")) return "MiniMax";
  if (name.includes("gpt")) return "OpenAI";
  return "Third-party Model";
}

function hasDirtyDisplayText(value = "") {
  const text = value.trim();
  return !text || text.includes("?") || text.includes("�") || /[鏅閫鏈绗妯鍑浼绠澶璇鈥俙銆]/.test(text);
}

function cleanProvider(provider = "", model = "") {
  return hasDirtyDisplayText(provider) ? inferModelProvider(model) : provider.trim();
}

function cleanConnectionName(connectionName = "", model = "") {
  const text = connectionName.trim();
  return hasDirtyDisplayText(text) ? `${inferModelProvider(model)} · ${model}` : text;
}

async function personalModel(email: string, selection = "auto") {
  const profileId = selection.startsWith("connection:") ? Number(selection.split(":")[1]) : 0;
  const row = profileId
    ? await runtime.DB.prepare("SELECT id,connection_name AS connectionName,provider,base_url AS baseUrl,model_name AS model,encrypted_api_key AS encryptedApiKey FROM user_model_profiles WHERE owner_email=? AND id=?").bind(email, profileId).first<{ id: number; connectionName: string; provider: string; baseUrl: string; model: string; encryptedApiKey: string }>()
    : await runtime.DB.prepare("SELECT id,connection_name AS connectionName,provider,base_url AS baseUrl,model_name AS model,encrypted_api_key AS encryptedApiKey FROM user_model_profiles WHERE owner_email=? ORDER BY updated_at DESC,id DESC LIMIT 1").bind(email).first<{ id: number; connectionName: string; provider: string; baseUrl: string; model: string; encryptedApiKey: string }>();
  if (!row) return null;
  const apiKey = await decryptSecret(row.encryptedApiKey);
  if (!apiKey) return null;
  return { id: row.id, connectionName: cleanConnectionName(row.connectionName, row.model), provider: cleanProvider(row.provider, row.model), baseUrl: runtime.MODEL_BASE_URL?.trim() || "https://claudecc.top", model: row.model, apiKey };
}

function compressOlderHistory(items: Array<{ role: string; content: string }>) {
  if (!items.length) return "";
  const compressed = items.reverse().map((item) => {
    const speaker = item.role === "assistant" ? "AI" : "用户";
    const content = item.content.replace(/\s+/g, " ").trim().slice(0, 600);
    return `${speaker}：${content}`;
  }).join("\n");
  return compressed.slice(-12000);
}

function extractKnowledgeTerms(input: string) {
  const terms = new Set<string>();
  const stopWords = new Set(["请帮", "帮我", "我要", "需要", "查询", "查找", "检索", "调用", "根据", "使用", "知识", "知识库", "资料", "资料库", "个人知识", "企业知识"]);
  // 提取英文词（2 字符以上），限制最大长度防止超出 SQLite LIKE 模式上限（D1 约 50 字节）
  for (const word of input.toLowerCase().match(/[a-z0-9_-]{2,}/g) || []) {
    if (!stopWords.has(word)) terms.add(word.slice(0, 15));
  }
  // \u63d0\u53d6\u5b8c\u6574\u4e2d\u6587\u5757\uff082 \u5b57\u4ee5\u4e0a\uff09\uff0c\u9650\u5236\u6700\u5927\u957f\u5ea6\u5230 15 \u5b57\uff0845 \u5b57\u8282 UTF-8\uff0c`%%` \u540e\u4ecd\u5728\u5b89\u5168\u8303\u56f4\uff09\u3002
  // \u79fb\u9664 2/3/4 \u5b57\u6ed1\u7a97\u5207\u5206\uff1a\u5b83\u4ea7\u751f\u5927\u91cf\u788e\u7247\u4e14\u957f\u6d88\u606f\u65f6\u7d2f\u79ef\u51fa\u8d85\u957f\u6a21\u5f0f\u5bfc\u81f4 D1 \u62a5 "pattern too complex"\u3002
  for (const chunk of input.match(/[\u4e00-\u9fff]{2,}/g) || []) {
    const limited = chunk.slice(0, 15);
    if (!stopWords.has(limited) && !stopWords.has(chunk)) terms.add(limited);
  }
  return Array.from(terms).sort((left, right) => right.length - left.length).slice(0, 10);
}

async function ensureSchema() {
  await runtime.DB.batch([
    runtime.DB.prepare("CREATE TABLE IF NOT EXISTS knowledge_documents (id INTEGER PRIMARY KEY AUTOINCREMENT,title TEXT NOT NULL,content TEXT NOT NULL,visibility TEXT NOT NULL DEFAULT '全员',filename TEXT NOT NULL DEFAULT '',mime_type TEXT NOT NULL DEFAULT 'text/plain',file_key TEXT NOT NULL DEFAULT '',category TEXT NOT NULL DEFAULT '未分类',tags TEXT NOT NULL DEFAULT '',version INTEGER NOT NULL DEFAULT 1,update_mode TEXT NOT NULL DEFAULT '手动更新',update_schedule TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT '已索引',size_bytes INTEGER NOT NULL DEFAULT 0,created_by TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL DEFAULT '')"),
    runtime.DB.prepare("CREATE TABLE IF NOT EXISTS org_members (email TEXT PRIMARY KEY,unit_id INTEGER NOT NULL,job_title TEXT NOT NULL DEFAULT '员工',direct_manager_email TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT '在岗',updated_at TEXT NOT NULL)"),
    runtime.DB.prepare("CREATE TABLE IF NOT EXISTS chat_conversations (id INTEGER PRIMARY KEY AUTOINCREMENT,owner_email TEXT NOT NULL,title TEXT NOT NULL DEFAULT '新对话',model_mode TEXT NOT NULL DEFAULT 'auto',created_at TEXT NOT NULL,updated_at TEXT NOT NULL)"),
    runtime.DB.prepare("CREATE TABLE IF NOT EXISTS user_model_profiles (id INTEGER PRIMARY KEY AUTOINCREMENT,owner_email TEXT NOT NULL,connection_name TEXT NOT NULL,provider TEXT NOT NULL,base_url TEXT NOT NULL,model_name TEXT NOT NULL,encrypted_api_key TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)"),
    runtime.DB.prepare("CREATE TABLE IF NOT EXISTS chat_messages (id INTEGER PRIMARY KEY AUTOINCREMENT,conversation_id INTEGER NOT NULL,role TEXT NOT NULL,content TEXT NOT NULL,sources TEXT NOT NULL DEFAULT '[]',model_used TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL)"),
    runtime.DB.prepare("CREATE TABLE IF NOT EXISTS audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT,actor TEXT NOT NULL,action TEXT NOT NULL,resource TEXT NOT NULL,result TEXT NOT NULL,detail TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL)"),
    runtime.DB.prepare("CREATE TABLE IF NOT EXISTS agent_configs (agent_id INTEGER PRIMARY KEY,config_json TEXT NOT NULL DEFAULT '{}',created_by TEXT NOT NULL DEFAULT '',updated_at TEXT NOT NULL)"),
    runtime.DB.prepare("CREATE TABLE IF NOT EXISTS agent_runs (id INTEGER PRIMARY KEY AUTOINCREMENT,agent_id INTEGER NOT NULL,agent_name TEXT NOT NULL,actor TEXT NOT NULL,model_used TEXT NOT NULL DEFAULT '',input TEXT NOT NULL DEFAULT '',output TEXT NOT NULL DEFAULT '',status TEXT NOT NULL,created_at TEXT NOT NULL)"),
    runtime.DB.prepare("CREATE TABLE IF NOT EXISTS personal_knowledge (id INTEGER PRIMARY KEY AUTOINCREMENT,owner_email TEXT NOT NULL,title TEXT NOT NULL,content TEXT NOT NULL,source_type TEXT NOT NULL DEFAULT '手动创建',conversation_id INTEGER,sync_status TEXT NOT NULL DEFAULT '仅个人',enterprise_document_id INTEGER,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)"),
    // 合同与监控三张表由 contracts/route.ts 与 monitoring/route.ts 负责建表和写入，
    // 此处只做只读检索。曾经在这里重复建表且列定义已过时（variables_json、raw_text/parsed_json），
    // 谁先被访问谁的结构生效，导致另一侧的读写因缺列而失败，故不再建表。
  ]);
}

const app = createApp();
app.use("*", auth());

// GET /api/chat — 获取对话列表和消息
app.get("*", async (c) => {
  const { user } = c.var;
  await ensureSchema();
  const conversationId = Number(new URL(c.req.url).searchParams.get("conversationId"));
  const conversations = await runtime.DB.prepare("SELECT id,title,model_mode AS modelMode,created_at AS createdAt,updated_at AS updatedAt FROM chat_conversations WHERE owner_email=? ORDER BY updated_at DESC LIMIT 50").bind(user.email).all();
  let messages: unknown[] = [];
  if (conversationId) {
    const owned = await runtime.DB.prepare("SELECT id FROM chat_conversations WHERE id=? AND owner_email=?").bind(conversationId, user.email).first();
    if (!owned) return fail("对话不存在。", 404);
    const rows = await runtime.DB.prepare("SELECT role,content,sources,model_used AS modelUsed,created_at AS createdAt FROM chat_messages WHERE conversation_id=? ORDER BY id").bind(conversationId).all<ChatMessageRow>();
    messages = rows.results.map((item) => ({ ...item, sources: JSON.parse(item.sources || "[]") as unknown[] }));
  }
  return success({ conversations: conversations.results, messages });
});

// POST /api/chat — 发送消息、创建对话、运行工作流等
app.post("*", async (c) => {
  const { user } = c.var;
  await ensureSchema();
  const body = await c.req.json<{ action?: string; message?: string; agentId?: number; workflowId?: number; conversationId?: number; modelMode?: string; knowledgeMode?: "native" | "knowledge" }>();
  const message = body.message?.trim();
  const role = user.businessRole;
  log.info("聊天请求", { email: user.email, action: body.action || "chat", hasMessage: !!message, conversationId: body.conversationId, knowledgeMode: body.knowledgeMode, modelMode: body.modelMode });
  const actor = user.email;
  const membership = await runtime.DB.prepare("SELECT unit_id AS unitId FROM org_members WHERE email=?").bind(actor).first<{ unitId: number }>();
  const now = new Date().toISOString();
  if (body.action === "ensureDefaultConversation") {
    const existing = await runtime.DB.prepare("SELECT id FROM chat_conversations WHERE owner_email=? ORDER BY updated_at DESC LIMIT 1")
      .bind(actor).first<{ id: number }>();
    if (existing?.id) return success({ conversationId: existing.id, created: false });
    const created = await runtime.DB.prepare("INSERT INTO chat_conversations(owner_email,title,model_mode,created_at,updated_at) VALUES(?,?,?,?,?) RETURNING id")
      .bind(actor, "默认任务", body.modelMode || "auto", now, now).first<{ id: number }>();
    return success({ conversationId: created!.id, created: true });
  }
  if (body.action === "createConversation") {
    const created = await runtime.DB.prepare("INSERT INTO chat_conversations(owner_email,title,model_mode,created_at,updated_at) VALUES(?,?,?,?,?) RETURNING id")
      .bind(actor, "新任务", body.modelMode || "auto", now, now).first<{ id: number }>();
    return success({ conversationId: created!.id });
  }
  if (!body.conversationId) {
    return fail("请先点击\u201c新建独立任务\u201d。发送消息、切换模型或运行工作流都不会自动创建任务。", 400);
  }
  let selectedMode = body.modelMode || "auto";
  let ownModel = await personalModel(actor, selectedMode);
  const conversationId = Number(body.conversationId) || 0;
  if (conversationId) {
    const owned = await runtime.DB.prepare("SELECT id FROM chat_conversations WHERE id=? AND owner_email=?").bind(conversationId, actor).first();
    if (!owned) return fail("对话不存在或无权访问。", 404);
  }
  await runtime.DB.prepare("INSERT INTO chat_messages(conversation_id,role,content,created_at) VALUES(?,'user',?,?)").bind(conversationId, message || "", now).run();
  await runtime.DB.prepare("UPDATE chat_conversations SET model_mode=?,updated_at=? WHERE id=?").bind(body.modelMode || "auto", now, conversationId).run();
  // 自动从首条消息生成标题
  if (message) {
    await runtime.DB.prepare("UPDATE chat_conversations SET title=?,updated_at=? WHERE id=? AND owner_email=? AND (title='新任务' OR title='默认任务')")
      .bind(message.slice(0, 15), now, conversationId, actor).run();
  }
  if (body.workflowId) {
    const denied = await authorizeCapability(runtime.DB, user, "run_workflow");
    if (denied) return denied;
    try {
      const run = await runWorkflowById(Number(body.workflowId), actor, role, message || "执行本次工作流", {
        conversationId,
        sourceChannel: "智能助手",
      }) as WorkflowRun;
      const answer = run.status === "等待审批"
        ? `工作流“${run.workflowName}”已运行到第 ${run.currentStep + 1} 步，现已提交审批并暂停。审批通过后会从下一步自动继续，不会重复执行前面的步骤。\n\n当前结果：\n${run.output || "等待审批"}`
        : run.status === "已完成"
          ? `工作流“${run.workflowName}”已完成。\n\n${run.output || "流程已完成，没有额外输出。"}`
          : `工作流“${run.workflowName}”执行失败：${run.error || "未知错误"}。可到自动化工作流查看每一步的运行记录并重试。`;
      await runtime.DB.prepare("INSERT INTO chat_messages(conversation_id,role,content,sources,model_used,created_at) VALUES(?,'assistant',?,'[]','工作流执行器',?)")
        .bind(conversationId, answer, new Date().toISOString()).run();
      await runtime.DB.prepare("UPDATE chat_conversations SET updated_at=? WHERE id=?").bind(new Date().toISOString(), conversationId).run();
      return success({ answer, conversationId, usedModel: "工作流执行器", workflowRun: run });
    } catch (error) {
      return fail(error instanceof Error ? error.message : "工作流启动失败", 400);
    }
  }
  const selectedAgent = body.agentId
    ? await runtime.DB.prepare("SELECT a.id,a.name,a.description,a.instructions,a.knowledge_scope AS knowledgeScope,a.status,COALESCE(c.config_json,'{}') AS config FROM ai_agents a LEFT JOIN agent_configs c ON c.agent_id=a.id WHERE a.id=?")
      .bind(body.agentId).first<{ id: number; name: string; description: string; instructions: string; knowledgeScope: string; status: string; config: string }>()
    : null;
  if (body.agentId && (!selectedAgent || selectedAgent.status !== "已启用")) {
    await writeAudit(actor, "运行智能体", `#${body.agentId}`, "拒绝", "智能体不存在或未启用");
    return fail("该智能体不存在或尚未启用。", 404);
  }
  if (selectedAgent && selectedAgent.knowledgeScope !== "全员" && selectedAgent.knowledgeScope !== role) {
    await writeAudit(actor, "运行智能体", selectedAgent.name, "拒绝", `用户岗位${role}无权使用知识范围${selectedAgent.knowledgeScope}`);
    return fail("你的岗位无权使用该智能体的知识范围。", 403);
  }
  const agentConfig = (() => {
    try { return selectedAgent ? JSON.parse(selectedAgent.config || "{}") as AgentConfig : {}; } catch { return {}; }
  })();
  if (selectedAgent && agentConfig.modelMode && agentConfig.modelMode !== "auto") {
    selectedMode = agentConfig.modelMode;
    ownModel = await personalModel(actor, selectedMode);
  }
  const explicitKnowledgeRequest = /(调用|检索|查询|查找|根据|使用).{0,16}(企业知识|个人知识|知识库|资料库|沉淀|合同|合同模板|监控|看板|报表)|(企业知识|个人知识|知识库|资料库|沉淀|合同|合同模板|监控|看板|报表).{0,16}(调用|检索|查询|查找|找到|根据|使用)/.test(message || "");
  const agentKnowledgeEnabled = Boolean(selectedAgent && (agentConfig.capabilities || []).includes("knowledge"));
  const shouldUseKnowledge = body.knowledgeMode === "knowledge"
    || (body.knowledgeMode == null && (explicitKnowledgeRequest || agentKnowledgeEnabled));
  const auditAction = selectedAgent ? "运行智能体" : shouldUseKnowledge ? "知识问答" : "原生AI问答";
  const auditResource = selectedAgent?.name || message || "";
  if (!message) return fail("请输入问题", 400);

  const sensitive = /(全部客户|导出客户|底价|密码|密钥|工资明细)/.test(message);
  if (sensitive && role !== "销售经理") {
    await writeAudit(actor, "知识问答", message, "拒绝", `角色${role}无权访问敏感信息`);
    return success({ answer: "该请求可能涉及超出当前角色权限的敏感信息，我没有读取或发送相关数据。请联系资料负责人申请授权。", blocked: true });
  }

  type KnowledgeRow = { id: number; title: string; content: string; filename: string; category: string; tags: string; version: number; status: string; updatedAt: string };
  type PersonalKnowledgeRow = { id: number; title: string; content: string; sourceType: string; syncStatus: string };
  let rows: { results: KnowledgeRow[] } = { results: [] };
  let personalKnowledge: { results: PersonalKnowledgeRow[] } = { results: [] };
  let businessSources: string[] = [];
  const words = shouldUseKnowledge ? extractKnowledgeTerms(message) : [];
  if (shouldUseKnowledge && words.length) {
    let sql = "SELECT id,title,content,filename,category,tags,version,status,updated_at AS updatedAt FROM knowledge_documents WHERE (visibility='全员' OR visibility=? OR (visibility='部门' AND department_id=?))";
    const binds: unknown[] = [role, membership?.unitId || -1];
    sql += ` AND (${words.map(() => "(title LIKE ? OR filename LIKE ? OR category LIKE ? OR tags LIKE ? OR content LIKE ?)").join(" OR ")})`;
    for (const word of words) { const like = `%${word}%`; binds.push(like, like, like, like, like); }
    if (selectedAgent && agentConfig.knowledgeCategory && agentConfig.knowledgeCategory !== "全部分类") {
      sql += " AND category=?";
      binds.push(agentConfig.knowledgeCategory);
    }
    sql += " ORDER BY CASE WHEN status='已索引' THEN 0 ELSE 1 END,updated_at DESC,id DESC LIMIT 8";
    rows = await runtime.DB.prepare(sql).bind(...binds).all<KnowledgeRow>();
  }
  const context = rows.results.map((item) => `【${item.title}｜分类：${item.category}｜版本：V${item.version}｜文件：${item.filename}｜状态：${item.status}】\n${item.content ? item.content.slice(0, 5000) : "原文件已保存，但正文仍在等待解析；可以向用户提供文件下载入口，不得假装已读取正文。"}`).join("\n\n");
  let businessContext = "";
  if (shouldUseKnowledge) {
    let personalSql = "SELECT id,title,content,source_type AS sourceType,sync_status AS syncStatus FROM personal_knowledge WHERE owner_email=?";
    const personalBinds: unknown[] = [actor];
    if (words.length) {
      personalSql += ` AND (${words.map(() => "(title LIKE ? OR content LIKE ?)").join(" OR ")})`;
      for (const word of words) { const like = `%${word}%`; personalBinds.push(like, like); }
    }
    // 无检索关键词时，不再强制 AND 1=0（原逻辑导致个人知识永远查不到）；
    // 查询已限定 owner_email 且 LIMIT 8，直接返回该用户最近的个人知识即可。
    personalSql += " ORDER BY updated_at DESC,id DESC LIMIT 8";
    const [personalKnowledgeRows, artifactRows, agentRows, workflowRows, sourceRows, approvalRows, contractTemplateRows, contractDocumentRows, monitoringRows] = await runtime.DB.batch([
      runtime.DB.prepare(personalSql).bind(...personalBinds),
      runtime.DB.prepare("SELECT title,artifact_type AS artifactType,source_type AS sourceType,content FROM saved_artifacts WHERE owner_email=? ORDER BY id DESC LIMIT 10").bind(actor),
      runtime.DB.prepare("SELECT name,description,instructions,status FROM ai_agents WHERE knowledge_scope='全员' OR knowledge_scope=? ORDER BY id DESC LIMIT 10").bind(role),
      runtime.DB.prepare("SELECT id,name,trigger_type AS triggerType,steps,status,last_run_at AS lastRunAt FROM workflows ORDER BY id DESC LIMIT 10"),
      runtime.DB.prepare("SELECT id,name,source_type AS sourceType,schedule,status,last_run_at AS lastRunAt FROM data_sources ORDER BY id DESC LIMIT 10"),
      runtime.DB.prepare("SELECT id,title,request_type AS requestType,status,comment FROM approval_requests WHERE requester=? ORDER BY id DESC LIMIT 10").bind(actor),
      runtime.DB.prepare("SELECT id,title,description,variables FROM contract_templates ORDER BY id DESC LIMIT 10"),
      runtime.DB.prepare("SELECT id,title,template_title AS templateTitle,created_at AS createdAt FROM contract_documents WHERE created_by=? ORDER BY id DESC LIMIT 10").bind(actor),
      runtime.DB.prepare("SELECT id,title,platform,created_at AS createdAt FROM monitoring_reports WHERE owner_email=? ORDER BY id DESC LIMIT 10").bind(actor),
    ]);
    personalKnowledge = { results: personalKnowledgeRows.results as PersonalKnowledgeRow[] };
    businessSources = [
      ...contractTemplateRows.results.map((x: BusinessRow) => `合同模板：${x.title}`),
      ...contractDocumentRows.results.map((x: BusinessRow) => `我的合同：${x.title}`),
      ...monitoringRows.results.map((x: BusinessRow) => `监控报表：${x.title}`),
    ];
    businessContext = [
      `个人知识：${personalKnowledge.results.map((x) => `【${x.title}｜${x.sourceType}｜${x.syncStatus}】\n${String(x.content).slice(0,3000)}`).join("\n") || "没有检索到匹配内容"}`,
      `个人沉淀：${artifactRows.results.map((x: BusinessRow) => `${x.title}(${x.artifactType}/${x.sourceType})`).join("；") || "暂无"}`,
      `可用智能体：${agentRows.results.map((x: BusinessRow) => `${x.name}：${x.description}`).join("；") || "暂无"}`,
      `工作流：${workflowRows.results.map((x: BusinessRow) => `#${x.id} ${x.name}(${x.status})`).join("；") || "暂无"}`,
      `数据采集：${sourceRows.results.map((x: BusinessRow) => `#${x.id} ${x.name}(${x.status}/${x.schedule})`).join("；") || "暂无"}`,
      `我的审批：${approvalRows.results.map((x: BusinessRow) => `#${x.id} ${x.title}(${x.status})`).join("；") || "暂无"}`,
      `合同模板：${contractTemplateRows.results.map((x: BusinessRow) => `#${x.id} ${x.title}｜变量：${String(x.variables || "[]").slice(0, 160)}`).join("；") || "暂无"}`,
      `我的合同：${contractDocumentRows.results.map((x: BusinessRow) => `#${x.id} ${x.title}｜模板：${x.templateTitle || "无模板"}`).join("；") || "暂无"}`,
      `监控报表：${monitoringRows.results.map((x: BusinessRow) => `#${x.id} ${x.title}｜${x.platform}`).join("；") || "暂无"}`,
    ].join("\n");
  }
  const sourceTitles = [
    ...rows.results.map((item) => `企业知识：${item.title}`),
    ...personalKnowledge.results.map((item) => `个人知识：${item.title}`),
    ...businessSources,
  ];
  const sourceFiles = rows.results.map((item) => ({ id: item.id, title: item.title, filename: item.filename, category: item.category, version: item.version, status: item.status }));
  if (shouldUseKnowledge && sourceTitles.length === 0) {
    const noMatchAnswer = "没有在你的个人知识库、企业知识库、合同中心或监控看板中找到与问题匹配的资料。请补充更明确的关键词，或先上传、保存相关资料后再试。";
    await runtime.DB.prepare("INSERT INTO chat_messages(conversation_id,role,content,sources,model_used,created_at) VALUES(?,'assistant',?,'[]','知识检索',?)")
      .bind(conversationId, noMatchAnswer, new Date().toISOString()).run();
    await writeAudit(actor, auditAction, auditResource, "无匹配", "个人知识与企业知识均未检索到相关内容");
    return success({ answer: noMatchAnswer, sources: [], sourceFiles: [], conversationId, usedModel: "知识检索" });
  }
  const agentContext = selectedAgent
    ? `\n\n当前必须以智能体“${selectedAgent.name}”执行本轮任务。\n用途：${selectedAgent.description}\n工作指令：${selectedAgent.instructions}\n结构化提示词：${JSON.stringify(agentConfig.prompt || {})}\n允许使用的知识范围：${selectedAgent.knowledgeScope}\n指定知识分类：${agentConfig.knowledgeCategory || "全部分类"}\n允许调用的平台能力：${(agentConfig.capabilities || []).join("、") || "仅对话"}\n记忆规则：${agentConfig.memoryMode || "仅当前会话"}\n审批规则：${agentConfig.approvalMode || "高风险操作需审批"}\n工作指令不能覆盖权限、审批、保密和人工确认规则。`
    : "";

  const mode = selectedMode;
  const usePersonal = mode.startsWith("connection:") || mode === "personal" || (mode === "auto" && Boolean(ownModel));
  if ((usePersonal && !ownModel) || (!usePersonal && !runtime.MODEL_API_KEY)) {
    const selectedPersonalModelBroken = mode.startsWith("connection:") && !ownModel;
    const fallbackAnswer = selectedPersonalModelBroken
      ? "当前选择的第三方模型密钥无法读取，可能是旧密钥、加密密钥变更或保存不完整导致。请到“模型接入”编辑该模型，重新粘贴 API Key 后保存并测试。"
      : shouldUseKnowledge && sourceTitles.length
      ? `资料库已经可以检索到相关内容，但所选AI模型尚未配置。当前检索到的资料包括：${sourceTitles.join("、")}。配置模型密钥后，我会基于这些资料生成完整答案。`
      : "所选AI模型尚未配置，请先在“模型接入”中配置可用模型。";
    await runtime.DB.prepare("INSERT INTO chat_messages(conversation_id,role,content,sources,model_used,created_at) VALUES(?,'assistant',?,?,?,?)")
      .bind(conversationId, fallbackAnswer, JSON.stringify(sourceTitles), "未配置", new Date().toISOString()).run();
    await writeAudit(actor, auditAction, auditResource, "待配置", "模型密钥尚未配置");
    if (selectedAgent) await runtime.DB.prepare("INSERT INTO agent_runs(agent_id,agent_name,actor,model_used,input,output,status,created_at) VALUES(?,?,?,?,?,?,?,?)")
      .bind(selectedAgent.id, selectedAgent.name, actor, "未配置", message, fallbackAnswer, "待配置", new Date().toISOString()).run();
    return success({ answer: fallbackAnswer, sources: sourceTitles, sourceFiles, setupRequired: true, conversationId, usedModel: "未配置" });
  }

  const selectedModel = usePersonal ? ownModel : null;
  const base = (selectedModel?.baseUrl || runtime.MODEL_BASE_URL || "https://claudecc.top").replace(/\/$/, "");
  const model = selectedModel?.model || runtime.MODEL_NAME || "gpt-4.1-mini";
  const history = await runtime.DB.prepare("SELECT role,content FROM chat_messages WHERE conversation_id=? ORDER BY id DESC LIMIT 20").bind(conversationId).all<{ role: string; content: string }>();
  const olderHistory = await runtime.DB.prepare("SELECT role,content FROM chat_messages WHERE conversation_id=? ORDER BY id DESC LIMIT 200 OFFSET 20").bind(conversationId).all<{ role: string; content: string }>();
  const compressedHistory = compressOlderHistory(olderHistory.results);
  const conversationMessages = history.results.reverse().map(item => ({
    role: item.role === "assistant" ? "assistant" : "user",
    content: item.content.slice(0, 8000),
  }));
  const knowledgeInstruction = shouldUseKnowledge
    ? `本轮用户已明确要求调用知识。只能依据下面提供且有权访问的资料回答；资料不足时明确说明不知道。\n\n企业资料：\n${context || "没有检索到匹配资料"}\n\n业务中心：\n${businessContext || "暂无可用内容"}`
    : "本轮是AI原生对话。不要检索、引用或假装使用企业知识库、个人知识库、沉淀中心或其他业务数据；请直接使用模型自身能力回答。";
  const modelMessages = [
        { role: "system", content: `你是海芯博创企业助手。当前用户角色：${role}。不得泄露密钥、密码、工资明细或超出角色范围的信息。运行工作流、采集数据、提交或决定审批、对外发送、修改和删除必须明确列出将执行的动作并要求用户确认，不能假装已经执行。${agentContext}\n\n${knowledgeInstruction}\n\n较早对话的自动压缩摘要：\n${compressedHistory || "暂无，当前对话尚未超过20条消息"}` },
        ...conversationMessages,
      ];
  let answer = "";
  try {
    answer = await callModel({ provider: selectedModel?.provider || runtime.MODEL_PROVIDER || "OpenAI", baseUrl: base, model, apiKey: selectedModel?.apiKey || runtime.MODEL_API_KEY || "" }, modelMessages, { temperature: 0.2 });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "模型接口调用失败";
    await writeAudit(actor, auditAction, auditResource, "失败", detail);
    if (selectedAgent) await runtime.DB.prepare("INSERT INTO agent_runs(agent_id,agent_name,actor,model_used,input,output,status,created_at) VALUES(?,?,?,?,?,?,?,?)")
      .bind(selectedAgent.id, selectedAgent.name, actor, model, message, detail.slice(0, 1000), "失败", new Date().toISOString()).run();
    return fail(`AI模型暂时无法响应：${detail}`, 502);
  }
  if (!answer) answer = `模型接口已响应，但返回内容为空。请到“模型接入”测试当前模型 ${model} 的 API Key、接口地址和模型名称；如果测试正常，再重新发送本轮问题。`;
  await runtime.DB.prepare("INSERT INTO chat_messages(conversation_id,role,content,sources,model_used,created_at) VALUES(?,'assistant',?,?,?,?)")
    .bind(conversationId, answer, JSON.stringify(sourceTitles), model, new Date().toISOString()).run();
  await writeAudit(actor, auditAction, auditResource, "成功", `引用${sourceTitles.length}份资料${selectedAgent ? `；知识范围${selectedAgent.knowledgeScope}` : ""}`);
  if (selectedAgent) await runtime.DB.prepare("INSERT INTO agent_runs(agent_id,agent_name,actor,model_used,input,output,status,created_at) VALUES(?,?,?,?,?,?,?,?)")
    .bind(selectedAgent.id, selectedAgent.name, actor, model, message, answer.slice(0, 8000), "成功", new Date().toISOString()).run();
  return success({ answer, conversationId, usedModel: usePersonal ? `${selectedModel?.connectionName} · ${model}` : model, agent: selectedAgent ? { id: selectedAgent.id, name: selectedAgent.name } : null, sources: sourceTitles, sourceFiles });
});

// PATCH /api/chat — 重命名对话、清空上下文、切换模型
app.patch("*", async (c) => {
  const { user } = c.var;
  await ensureSchema();
  const body = await c.req.json<{ id?: number; title?: string; action?: string; modelMode?: string }>();
  if (body.action === "clearContext") {
    const owned = await runtime.DB.prepare("SELECT id FROM chat_conversations WHERE id=? AND owner_email=?").bind(Number(body.id), user.email).first();
    if (!owned) return fail("对话不存在。", 404);
    await runtime.DB.prepare("DELETE FROM chat_messages WHERE conversation_id=?").bind(Number(body.id)).run();
    await runtime.DB.prepare("UPDATE chat_conversations SET updated_at=? WHERE id=?").bind(new Date().toISOString(), Number(body.id)).run();
    await writeAudit(user.email, "清空对话上下文", `对话#${body.id}`, "成功", "用户主动清除当前对话全部消息");
    return success({ ok: true });
  }
  if (body.action === "changeModel") {
    if (!body.id || !body.modelMode) return fail("缺少任务或模型信息。", 400);
    const updated = await runtime.DB.prepare("UPDATE chat_conversations SET model_mode=?,updated_at=? WHERE id=? AND owner_email=? RETURNING id")
      .bind(body.modelMode, new Date().toISOString(), body.id, user.email).first();
    if (!updated) return fail("任务不存在或无权修改。", 404);
    return success({ ok: true });
  }
  if (!body.id || !body.title?.trim()) return fail("请填写对话名称。", 400);
  await runtime.DB.prepare("UPDATE chat_conversations SET title=?,updated_at=? WHERE id=? AND owner_email=?")
    .bind(body.title.trim().slice(0, 40), new Date().toISOString(), body.id, user.email).run();
  return success({ ok: true });
});

// DELETE /api/chat — 删除对话
app.delete("*", async (c) => {
  const { user } = c.var;
  await ensureSchema();
  const id = Number(new URL(c.req.url).searchParams.get("id"));
  const owned = await runtime.DB.prepare("SELECT id FROM chat_conversations WHERE id=? AND owner_email=?").bind(id, user.email).first();
  if (!owned) return fail("对话不存在。", 404);
  await runtime.DB.batch([
    runtime.DB.prepare("DELETE FROM chat_messages WHERE conversation_id=?").bind(id),
    runtime.DB.prepare("DELETE FROM chat_conversations WHERE id=?").bind(id),
  ]);
  return success({ ok: true });
});

export const GET = (request: Request) => app.fetch(request);
export const POST = (request: Request) => app.fetch(request);
export const PATCH = (request: Request) => app.fetch(request);
export const DELETE = (request: Request) => app.fetch(request);

async function writeAudit(actor: string, action: string, resource: string, result: string, detail: string) {
  await runtime.DB.prepare("INSERT INTO audit_logs(actor,action,resource,result,detail,created_at) VALUES(?,?,?,?,?,?)")
    .bind(actor, action, resource.slice(0, 100), result, detail, new Date().toISOString()).run();
}
