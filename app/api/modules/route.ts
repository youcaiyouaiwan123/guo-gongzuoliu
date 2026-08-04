import { createApp, auth, success, fail, authorizeCapability } from "../_app";
import { log } from "../_logger";

import { runtime, ensureSchema, audit } from "./_shared";
import type { WorkflowRow } from "./_shared";
import {
  collectSource,
  targetStoreLabels,
  outputFormatLabels,
  collectorModeLabels,
  normalizeTargetStore,
  normalizeOutputFormat,
  normalizeCollectorMode,
  normalizePublishMode,
  clampNumber,
  normalizePlatform,
  normalizeYesNo,
  isInlineSource,
  collectionFileMeta,
} from "./_collection";
import { executeWorkflow, getRun, parseNodes, runWorkflowById, resumeApprovedWorkflow } from "./_workflow";

export { runWorkflowById, resumeApprovedWorkflow, collectSource };

const app = createApp();
app.use("*", auth());

// GET /api/modules — 获取智能体、工作流、数据源、运行记录等
app.get("*", async (c) => {
  const { user } = c.var;
  await ensureSchema();
  const runId = Number(new URL(c.req.url).searchParams.get("runId"));
  if (runId) {
    const owner = await runtime.DB.prepare("SELECT actor FROM workflow_runs WHERE id=?").bind(runId).first<{ actor: string }>();
    if (!owner || (owner.actor !== user.email && user.role !== "管理员")) return fail("无权查看该运行记录", 403);
    return success(await getRun(runId) as Record<string, unknown>);
  }
  const agentQuery = user.role === "管理员"
    ? runtime.DB.prepare("SELECT a.id,a.name,a.description,a.instructions,a.knowledge_scope AS knowledgeScope,a.status,a.created_at AS createdAt,COALESCE(c.config_json,'{}') AS config,COALESCE(c.created_by,'') AS createdBy FROM ai_agents a LEFT JOIN agent_configs c ON c.agent_id=a.id ORDER BY a.id DESC")
    : runtime.DB.prepare("SELECT a.id,a.name,a.description,a.instructions,a.knowledge_scope AS knowledgeScope,a.status,a.created_at AS createdAt,COALESCE(c.config_json,'{}') AS config,COALESCE(c.created_by,'') AS createdBy FROM ai_agents a LEFT JOIN agent_configs c ON c.agent_id=a.id WHERE a.knowledge_scope='全员' OR a.knowledge_scope=? ORDER BY a.id DESC").bind(user.businessRole);
  const runQuery = user.role === "管理员"
    ? runtime.DB.prepare("SELECT id,workflow_id AS workflowId,workflow_name AS workflowName,actor,status,input,output,current_step AS currentStep,error,started_at AS startedAt,finished_at AS finishedAt FROM workflow_runs ORDER BY id DESC LIMIT 20")
    : runtime.DB.prepare("SELECT id,workflow_id AS workflowId,workflow_name AS workflowName,actor,status,input,output,current_step AS currentStep,error,started_at AS startedAt,finished_at AS finishedAt FROM workflow_runs WHERE actor=? ORDER BY id DESC LIMIT 20").bind(user.email);
  const agentRunQuery = user.role === "管理员"
    ? runtime.DB.prepare("SELECT id,agent_id AS agentId,agent_name AS agentName,actor,model_used AS modelUsed,input,output,status,created_at AS createdAt FROM agent_runs ORDER BY id DESC LIMIT 30")
    : runtime.DB.prepare("SELECT id,agent_id AS agentId,agent_name AS agentName,actor,model_used AS modelUsed,input,output,status,created_at AS createdAt FROM agent_runs WHERE actor=? ORDER BY id DESC LIMIT 30").bind(user.email);
  const collectionRunQuery = user.role === "管理员"
    ? runtime.DB.prepare("SELECT id,source_id AS sourceId,source_name AS sourceName,actor,status,http_status AS httpStatus,row_count AS rowCount,content_type AS contentType,preview,error,model_used AS modelUsed,target_store AS targetStore,output_format AS outputFormat,collector_mode AS collectorMode,created_at AS createdAt,published_at AS publishedAt FROM data_collection_runs ORDER BY id DESC LIMIT 30")
    : runtime.DB.prepare("SELECT id,source_id AS sourceId,source_name AS sourceName,actor,status,http_status AS httpStatus,row_count AS rowCount,content_type AS contentType,preview,error,model_used AS modelUsed,target_store AS targetStore,output_format AS outputFormat,collector_mode AS collectorMode,created_at AS createdAt,published_at AS publishedAt FROM data_collection_runs WHERE actor=? ORDER BY id DESC LIMIT 30").bind(user.email);
  const [agents, workflows, sources, runs, collectionRuns, agentRuns] = await runtime.DB.batch([
    agentQuery,
    runtime.DB.prepare("SELECT id,name,trigger_type AS triggerType,steps,status,loop_type AS loopType,review_mode AS reviewMode,review_standard AS reviewStandard,stop_condition AS stopCondition,max_loops AS maxLoops,final_action AS finalAction,failure_action AS failureAction,last_run_at AS lastRunAt,created_at AS createdAt FROM workflows ORDER BY id DESC"),
    runtime.DB.prepare("SELECT s.id,s.name,s.source_type AS sourceType,s.source_url AS sourceUrl,s.schedule,s.status,s.last_run_at AS lastRunAt,s.created_at AS createdAt,d.request_method AS requestMethod,d.content_selector AS contentSelector,d.extract_fields AS extractFields,d.target_category AS targetCategory,d.visibility,d.publish_mode AS publishMode,d.sample_data AS sampleData,d.model_mode AS modelMode,d.target_store AS targetStore,d.output_format AS outputFormat,d.collector_mode AS collectorMode,d.platform,d.keyword,d.crawl_depth AS crawlDepth,d.max_pages AS maxPages,d.url_pattern AS urlPattern,d.exclude_pattern AS excludePattern,d.include_comments AS includeComments,d.export_profile AS exportProfile,d.respect_robots AS respectRobots FROM data_sources s LEFT JOIN data_source_details d ON d.source_id=s.id ORDER BY s.id DESC"),
    runQuery,
    collectionRunQuery,
    agentRunQuery,
  ]);
  return success({ agents: agents.results, workflows: workflows.results, sources: sources.results, runs: runs.results, collectionRuns: collectionRuns.results, agentRuns: agentRuns.results });
});

// POST /api/modules — 创建智能体、工作流、数据源、运行工作流等
app.post("*", async (c) => {
  const { user } = c.var;
  await ensureSchema();
  const body = await c.req.json() as Record<string, string>;
  const actor = user.email;
  const now = new Date().toISOString();
  const capability = body.type === "agent" ? "create_agent" : body.type === "source" || body.type === "approveSourceRun" || body.type === "ai-collect" || (body.type === "run" && body.module === "source") ? "collect_data" : "run_workflow";
  const denied = await authorizeCapability(runtime.DB, user, capability);
  if (denied) return denied;
  if (body.type === "agent") {
    const structuredInstruction = [
      body.rolePrompt && `角色：${body.rolePrompt}`,
      body.taskPrompt && `任务：${body.taskPrompt}`,
      body.contextPrompt && `上下文：${body.contextPrompt}`,
      body.constraintPrompt && `约束：${body.constraintPrompt}`,
      body.formatPrompt && `格式：${body.formatPrompt}`,
      body.examplePrompt && `示例：${body.examplePrompt}`,
    ].filter(Boolean).join("\n");
    const instructions = body.instructions?.trim() || structuredInstruction;
    if (!body.name?.trim() || !instructions) return fail("请填写智能体名称，并至少填写任务或工作指令", 400);
    const capabilities = ["knowledge", "workflow", "data", "approval", "artifacts", "connectors"].filter(key => body[`capability_${key}`] === "on");
    const config = {
      modelMode: body.modelMode || "auto",
      welcomeMessage: body.welcomeMessage?.trim() || `你好，我是${body.name.trim()}。请告诉我你要完成的任务。`,
      prompt: { role: body.rolePrompt || "", task: body.taskPrompt || "", context: body.contextPrompt || "", constraint: body.constraintPrompt || "", format: body.formatPrompt || "", example: body.examplePrompt || "" },
      knowledgeCategory: body.knowledgeCategory || "全部分类",
      knowledgeDocumentIds: body.knowledgeDocumentIds || "",
      capabilities,
      memoryMode: body.memoryMode || "仅当前会话",
      approvalMode: body.approvalMode || "高风险操作需审批",
      publishTarget: body.publishTarget || "智能助手",
      usageScope: body.usageScope || "企业内部",
    };
    const status = body.status === "草稿" ? "草稿" : "已启用";
    const created = await runtime.DB.prepare("INSERT INTO ai_agents(name,description,instructions,knowledge_scope,status,created_at) VALUES(?,?,?,?,?,?) RETURNING id")
      .bind(body.name.trim(), body.description?.trim() || "企业专用智能体", instructions, body.knowledgeScope || "全员", status, now).first<{ id: number }>();
    await runtime.DB.prepare("INSERT INTO agent_configs(agent_id,config_json,created_by,updated_at) VALUES(?,?,?,?)")
      .bind(created!.id, JSON.stringify(config), actor, now).run();
    await audit(actor, "创建智能体", body.name, "成功", `${status}；模型：${config.modelMode}；能力：${capabilities.join("、") || "仅对话"}`);
    return success({ ok: true, id: created!.id, status }, 201);
  } else if (body.type === "workflow") {
    const nodes = parseNodes(body.steps || "");
    log.info("创建工作流/持续任务", { name: body.name, loopType: body.loopType, triggerType: body.triggerType, nodesCount: nodes.length });
    if (!body.name?.trim() || nodes.length < 2) return fail("工作流至少需要两个步骤", 400);
    await runtime.DB.prepare("INSERT INTO workflows(name,trigger_type,steps,status,loop_type,review_mode,review_standard,stop_condition,max_loops,final_action,failure_action,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
      .bind(body.name.trim(), body.triggerType || "手动触发", JSON.stringify(nodes), "已启用", body.loopType || "单次", body.reviewMode || "明确标准", body.reviewStandard || "", body.stopCondition || "", Math.min(10, Math.max(1, Number(body.maxLoops) || 3)), body.finalAction || "输出结果", body.failureAction || "通知负责人", now).run();
    await audit(actor, "创建工作流", body.name, "成功", nodes.map(n => n.name).join(" → "));
  } else if (body.type === "source") {
    const sourceId = Number(body.id || 0);
    if (!body.name?.trim() || !body.sourceType) return fail("请填写数据源名称和类型", 400);
    const targetStore = normalizeTargetStore(body.targetStore);
    const outputFormat = normalizeOutputFormat(body.outputFormat);
    const collectorMode = normalizeCollectorMode(body.collectorMode || (body.sourceType.includes("API") ? "api" : body.sourceType.includes("截图") || body.sourceType.includes("图片") ? "screenshot" : body.sourceType.includes("粘贴") ? "paste" : body.sourceType.includes("MCP") ? "mcp" : "direct"));
    const platform = normalizePlatform(body.platform);
    const crawlDepth = clampNumber(body.crawlDepth, 1, 0, 3);
    const maxPages = clampNumber(body.maxPages, 5, 1, 50);
    const includeComments = normalizeYesNo(body.includeComments);
    const respectRobots = normalizeYesNo(body.respectRobots || "yes");
    const publishMode = normalizePublishMode(body.publishMode);
    if (!isInlineSource(body.sourceType) && !body.sourceUrl?.trim()) return fail("请填写HTTPS采集地址；如果是截图、MCP或手动数据，请选择对应数据类型并粘贴识别后的文本。", 400);
    if (sourceId > 0) {
      const existing = await runtime.DB.prepare("SELECT id,name FROM data_sources WHERE id=?").bind(sourceId).first<{ id: number; name: string }>();
      if (!existing) return fail("要编辑的数据源不存在", 404);
      await runtime.DB.batch([
        runtime.DB.prepare("UPDATE data_sources SET name=?,source_type=?,source_url=?,schedule=?,status=? WHERE id=?")
          .bind(body.name.trim(), body.sourceType, body.sourceUrl?.trim() || "", body.schedule || "手动", "待测试", sourceId),
        runtime.DB.prepare("DELETE FROM data_source_details WHERE source_id=?").bind(sourceId),
        runtime.DB.prepare("INSERT INTO data_source_details(source_id,request_method,content_selector,extract_fields,target_category,visibility,publish_mode,sample_data,model_mode,target_store,output_format,collector_mode,created_by,platform,keyword,crawl_depth,max_pages,url_pattern,exclude_pattern,include_comments,export_profile,respect_robots) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
          .bind(sourceId, body.requestMethod || "GET", body.contentSelector || "", body.extractFields || "", body.targetCategory || "数据采集", body.visibility || "全员", publishMode, body.sampleData || "", body.modelMode || "auto", targetStore, outputFormat, collectorMode, actor, platform, body.keyword || "", crawlDepth, maxPages, body.urlPattern || "", body.excludePattern || "", includeComments, body.exportProfile || "knowledge", respectRobots),
      ]);
      await audit(actor, "编辑数据源", body.name, "成功", `原名称：${existing.name}；类型：${body.sourceType}；入库：${targetStoreLabels[targetStore]}；格式：${outputFormatLabels[outputFormat]}；方式：${collectorModeLabels[collectorMode]}`);
      return success({ ok: true, id: sourceId, message: "采集任务已更新，可重新测试或立即采集。" });
    }
    const created = await runtime.DB.prepare("INSERT INTO data_sources(name,source_type,source_url,schedule,status,created_at) VALUES(?,?,?,?,?,?) RETURNING id")
      .bind(body.name.trim(), body.sourceType, body.sourceUrl?.trim() || "", body.schedule || "手动", "待测试", now).first<{ id: number }>();
    await runtime.DB.prepare("INSERT INTO data_source_details(source_id,request_method,content_selector,extract_fields,target_category,visibility,publish_mode,sample_data,model_mode,target_store,output_format,collector_mode,created_by,platform,keyword,crawl_depth,max_pages,url_pattern,exclude_pattern,include_comments,export_profile,respect_robots) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .bind(created!.id, body.requestMethod || "GET", body.contentSelector || "", body.extractFields || "", body.targetCategory || "数据采集", body.visibility || "全员", publishMode, body.sampleData || "", body.modelMode || "auto", targetStore, outputFormat, collectorMode, actor, platform, body.keyword || "", crawlDepth, maxPages, body.urlPattern || "", body.excludePattern || "", includeComments, body.exportProfile || "knowledge", respectRobots).run();
    await audit(actor, "添加数据源", body.name, "成功", `${body.sourceType}；入库：${targetStoreLabels[targetStore]}；格式：${outputFormatLabels[outputFormat]}；方式：${collectorModeLabels[collectorMode]}`);
    return success({ ok: true, id: created!.id }, 201);
  } else if (body.type === "run" && body.module === "workflow") {
    const workflow = await runtime.DB.prepare("SELECT id,name,steps,review_standard AS reviewStandard,max_loops AS maxLoops FROM workflows WHERE id=?").bind(Number(body.id)).first<WorkflowRow>();
    if (!workflow) return fail("工作流不存在", 404);
    const run = await executeWorkflow(workflow, actor, user.businessRole, body.input?.trim() || "执行本次工作流");
    return success({ ok: true, run }, 201);
  } else if (body.type === "retry") {
    const previous = await runtime.DB.prepare("SELECT workflow_id AS workflowId,input FROM workflow_runs WHERE id=? AND (actor=? OR ?='管理员')").bind(Number(body.runId), actor, user.role).first<{ workflowId: number; input: string }>();
    if (!previous) return fail("没有找到可重试的运行记录", 404);
    const workflow = await runtime.DB.prepare("SELECT id,name,steps,review_standard AS reviewStandard,max_loops AS maxLoops FROM workflows WHERE id=?").bind(previous.workflowId).first<WorkflowRow>();
    const run = await executeWorkflow(workflow!, actor, user.businessRole, previous.input);
    return success({ ok: true, run }, 201);
  } else if (body.type === "run" && body.module === "source") {
    try {
      const result = await collectSource(Number(body.id), actor, body.action === "test");
      return success(result, 201);
    } catch (error) {
      return fail(error instanceof Error ? error.message : "采集失败", 502);
    }
  } else if (body.type === "approveSourceRun") {
    const run = await runtime.DB.prepare("SELECT r.id,r.source_id AS sourceId,r.source_name AS sourceName,r.actor,r.preview,r.status,COALESCE(r.target_store,d.target_store,'personal') AS targetStore,COALESCE(r.output_format,d.output_format,'markdown') AS outputFormat,d.target_category AS targetCategory,d.visibility FROM data_collection_runs r LEFT JOIN data_source_details d ON d.source_id=r.source_id WHERE r.id=? AND (r.actor=? OR ?='管理员')").bind(Number(body.runId), actor, user.role).first<{ id: number; sourceId: number; sourceName: string; actor: string; preview: string; status: string; targetStore: string; outputFormat: string; targetCategory: string; visibility: string }>();
    if (!run || !["待确认", "待审核", "已采集"].includes(run.status)) return fail("没有找到可入库的采集结果", 404);
    const finalPreview = typeof body.cleanedPreview === "string" && body.cleanedPreview.trim() ? body.cleanedPreview.slice(0, 12000) : run.preview;
    const rawCleaningRules = (body as { cleaningRules?: unknown }).cleaningRules;
    const appliedRules = Array.isArray(rawCleaningRules) ? rawCleaningRules.slice(0, 10).map(String).join(",") : "";
    const published = new Date().toISOString();
    const targetStore = normalizeTargetStore(run.targetStore);
    if ((targetStore === "enterprise" || targetStore === "both") && user.role !== "管理员") {
      const knowledgeDenied = await authorizeCapability(runtime.DB, user, "manage_knowledge");
      if (knowledgeDenied) return knowledgeDenied;
    }
    const claimed = await runtime.DB.prepare("UPDATE data_collection_runs SET status='发布中' WHERE id=? AND status IN ('待确认','待审核','已采集') AND (actor=? OR ?='管理员')").bind(run.id, actor, user.role).run();
    if (!claimed.meta.changes) return fail("采集结果已处理或无权操作。", 409);
    const outputFormat = normalizeOutputFormat(run.outputFormat);
    const title = `${run.sourceName} ${new Date().toLocaleDateString("zh-CN")}`;
    const fileMeta = collectionFileMeta(title, outputFormat);
    let enterpriseDocumentId: number | null = null;
    if (targetStore === "enterprise" || targetStore === "both") {
      const createdDoc = await runtime.DB.prepare("INSERT INTO knowledge_documents(title,content,visibility,filename,mime_type,file_key,category,tags,version,update_mode,update_schedule,status,size_bytes,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id")
        .bind(title, finalPreview, run.visibility || "全员", fileMeta.filename, fileMeta.mimeType, "", run.targetCategory || "数据采集", appliedRules ? `自动采集,数据清洗:${appliedRules}` : `自动采集,${outputFormatLabels[outputFormat]}`, 1, "源文件变化时", "", "已索引", new TextEncoder().encode(finalPreview).length, actor, published, published).first<{ id: number }>();
      enterpriseDocumentId = createdDoc?.id || null;
    }
    if (targetStore === "personal" || targetStore === "both") {
      await runtime.DB.prepare("INSERT INTO personal_knowledge(owner_email,title,content,source_type,conversation_id,sync_status,enterprise_document_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)")
        .bind(actor, title, finalPreview, `数据采集/${outputFormatLabels[outputFormat]}`, null, targetStore === "both" ? "已同步企业知识" : "仅个人", enterpriseDocumentId, published, published).run();
    }
    await runtime.DB.prepare("UPDATE data_collection_runs SET preview=?,status='已入知识库',published_at=? WHERE id=? AND status='发布中' AND (actor=? OR ?='管理员')").bind(finalPreview, published, run.id, actor, user.role).run();
    await runtime.DB.prepare("UPDATE data_sources SET status='已入知识库' WHERE id=?").bind(run.sourceId).run();
    await audit(actor, "确认采集结果", run.sourceName, "成功", `运行#${run.id}已进入${targetStoreLabels[targetStore]}${appliedRules ? `，已执行数据清洗：${appliedRules}` : ""}`);
    return success({ ok: true, message: `${appliedRules ? "清洗后的" : ""}采集结果已进入${targetStoreLabels[targetStore]}。` });
  } else if (body.type === "ai-collect") {
    // AI 驱动采集：用户用自然语言描述需求，AI 自动选择技能执行
    const { collectWithAI } = await import("./_collection");
    const result = await collectWithAI(actor, body.prompt || "", {
      url: body.url || "",
      modelMode: body.modelMode || "auto",
      targetStore: body.targetStore || "personal",
      outputFormat: body.outputFormat || "markdown",
    });
    return success({ ok: true, text: result.text, toolCalls: result.toolCalls, modelMode: result.modelMode, targetStore: result.targetStore, outputFormat: result.outputFormat });
  } else {
    return fail("不支持的操作", 400);
  }
  return success({ ok: true }, 201);
});

// DELETE /api/modules — 删除智能体、工作流、数据源、采集日志
app.delete("*", async (c) => {
  const { user } = c.var;
  await ensureSchema();
  const id = Number(new URL(c.req.url).searchParams.get("id"));
  const moduleName = new URL(c.req.url).searchParams.get("module") || "agent";
  if (!id) return fail("请指定要删除的记录 ID。", 400);
  const capability = moduleName === "agent" ? "create_agent" : moduleName === "source" || moduleName === "collectionRun" ? "collect_data" : "run_workflow";
  const denied = await authorizeCapability(runtime.DB, user, capability);
  if (denied) return denied;

  let item: { name: string } | null = null;
  let label = "";
  if (moduleName === "collectionRun") {
    label = "采集日志";
    item = await runtime.DB.prepare("SELECT source_name AS name FROM data_collection_runs WHERE id=? AND (actor=? OR ?='管理员')").bind(id, user.email, user.role).first<{ name: string }>();
    if (item) await runtime.DB.prepare("DELETE FROM data_collection_runs WHERE id=? AND (actor=? OR ?='管理员')").bind(id, user.email, user.role).run();
  } else if (moduleName === "agent") {
    label = "智能体";
    item = await runtime.DB.prepare("SELECT name FROM ai_agents WHERE id=?").bind(id).first<{ name: string }>();
    if (item) await runtime.DB.prepare("DELETE FROM ai_agents WHERE id=?").bind(id).run();
  } else if (moduleName === "workflow") {
    label = "工作流";
    item = await runtime.DB.prepare("SELECT name FROM workflows WHERE id=?").bind(id).first<{ name: string }>();
    if (item) await runtime.DB.prepare("DELETE FROM workflows WHERE id=?").bind(id).run();
  } else {
    label = "数据源";
    item = await runtime.DB.prepare("SELECT name FROM data_sources WHERE id=?").bind(id).first<{ name: string }>();
    if (item) await runtime.DB.batch([
      runtime.DB.prepare("DELETE FROM data_source_details WHERE source_id=?").bind(id),
      runtime.DB.prepare("DELETE FROM data_sources WHERE id=?").bind(id),
    ]);
  }

  if (!item) return fail(`${label}不存在或已经删除。`, 404);
  await audit(user.email, `删除${label}`, item.name, "成功", moduleName === "workflow" ? "工作流定义已删除，历史运行和审计记录继续保留。" : `${label}定义已删除。`);
  return success({ ok: true, message: `${label}“${item.name}”已删除。` });
});

export const GET = (request: Request) => app.fetch(request);
export const POST = (request: Request) => app.fetch(request);
export const DELETE = (request: Request) => app.fetch(request);