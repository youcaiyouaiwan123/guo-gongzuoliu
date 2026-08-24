import { runtime, ensureSchema, askModel, audit } from "./_shared";
import type { WorkflowNode, WorkflowRow, WorkflowRunOptions } from "./_shared";
import { collectSource, targetStoreLabels, outputFormatLabels } from "./_collection";

function parseNodes(value: string): WorkflowNode[] {
  try {
    const nodes = JSON.parse(value);
    if (Array.isArray(nodes)) return nodes.filter(n => n && n.type && n.name);
  } catch {}
  const parts = value.split(new RegExp("\\u2192|->|\\n"));
  return parts.map((name, index) => ({
    id: `legacy-${index}`,
    type: index === 0 ? "input" : index === parts.length - 1 ? "output" : "ai",
    name: name.trim() || `\u6b65\u9aa4${index + 1}`,
  })) as WorkflowNode[];
}

type WorkflowRunResult = {
  id: number;
  workflowId: number;
  workflowName: string;
  actor: string;
  status: string;
  input: string;
  output: string;
  currentStep: number;
  error?: string;
  startedAt: string;
  finishedAt?: string;
  steps: D1Row[];
};

async function getRun(runId: number): Promise<WorkflowRunResult> {
  const run = await runtime.DB.prepare("SELECT id,workflow_id AS workflowId,workflow_name AS workflowName,actor,status,input,output,current_step AS currentStep,error,started_at AS startedAt,finished_at AS finishedAt FROM workflow_runs WHERE id=?").bind(runId).first<Omit<WorkflowRunResult, "steps">>();
  if (!run) throw new Error("工作流运行记录不存在");
  const steps = await runtime.DB.prepare("SELECT id,step_index AS stepIndex,step_type AS stepType,step_name AS stepName,status,input,output,error,started_at AS startedAt,finished_at AS finishedAt FROM workflow_step_runs WHERE run_id=? ORDER BY step_index").bind(runId).all();
  return { ...run, steps: steps.results };
}

function prepareAiNode(node: WorkflowNode, input: string) {
  if (node.inputMode === "direct") {
    return {
      instruction: node.config || node.name || "请按用户直接提出的需求处理输入内容。",
      content: input,
    };
  }
  if (node.inputMode === "markdown" || node.inputMode === "skill") {
    return {
      instruction: node.config || node.name,
      content: `${input}\n\n【调用${node.inputMode === "skill" ? " Skill" : " Markdown"}：${node.resourceTitle || "未命名"}】\n${node.resourceContent || "未配置内容"}`,
    };
  }
  const guide = node.promptGuide || {};
  const instruction = [
    ["角色（Role）", guide.role],
    ["任务（Task）", guide.task],
    ["上下文（Context）", guide.context],
    ["约束（Constraint）", guide.constraint],
    ["格式（Format）", guide.format],
    ["示例（Example）", guide.example],
  ].filter(([, value]) => value).map(([label, value]) => `【${label}】\n${value}`).join("\n\n");
  return { instruction: instruction || node.config || node.name, content: input };
}

/**
 * 循环评估：一轮执行完后，对照"任务目标 / 合格标准 / 停止条件"判断是否达标。
 * 让模型只吐一行 JSON {pass, feedback}；宽松解析，解析失败按未通过处理（有 maxLoops 兜底不会死循环）。
 * 这一步本身也作为一条 workflow_step_runs 落库（step_type=review，名"循环评估"），运行详情时间线可见。
 */
async function judgeLoop(
  actor: string,
  criteria: { goal: string; standard: string; stopCondition: string },
  current: string,
  runId: number,
  stepIndex: number,
): Promise<{ pass: boolean; feedback: string }> {
  const rules = [
    criteria.goal && `任务目标：${criteria.goal}`,
    criteria.standard && `合格标准：${criteria.standard}`,
    criteria.stopCondition && `停止条件：${criteria.stopCondition}`,
  ].filter(Boolean).join("\n") || "内容完整、事实有依据、可直接交付";
  const started = new Date().toISOString();
  const step = await runtime.DB.prepare("INSERT INTO workflow_step_runs(run_id,step_index,step_type,step_name,status,input,started_at) VALUES(?,?,?,?,?,?,?) RETURNING id")
    .bind(runId, stepIndex, "review", "循环评估", "运行中", current.slice(0, 12000), started).first<{ id: number }>();
  try {
    const instruction = `你是严格的质量审查员。请对照下列要求，判断“当前结果”是否已经合格、并满足停止条件：\n${rules}\n\n只输出一行 JSON，不要任何多余文字或代码块：{"pass": true 或 false, "feedback": "若未通过，明确指出还缺什么、下一轮如何改进；已通过则留空"}。`;
    const raw = await askModel(actor, instruction, current, "auto");
    let pass = false;
    let feedback = raw.trim();
    try {
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]) as { pass?: unknown; feedback?: unknown };
        pass = parsed.pass === true;
        feedback = String(parsed.feedback ?? "").trim();
      }
    } catch {}
    await runtime.DB.prepare("UPDATE workflow_step_runs SET status='已完成',output=?,finished_at=? WHERE id=?")
      .bind(`判定：${pass ? "通过" : "未通过"}${feedback ? `\n${feedback}` : ""}`.slice(0, 12000), new Date().toISOString(), step!.id).run();
    return { pass, feedback };
  } catch (error) {
    // 评估这步本身失败（多半是模型接口挂了），不再空转：记失败并停止循环，已产出的结果照常返回。
    const message = error instanceof Error ? error.message : "循环评估失败";
    await runtime.DB.prepare("UPDATE workflow_step_runs SET status='失败',error=?,finished_at=? WHERE id=?")
      .bind(message, new Date().toISOString(), step!.id).run();
    return { pass: true, feedback: "" };
  }
}

/**
 * 主动制（事件触发）触发判定：让模型对照"触发条件"看"观察内容"是否命中。
 * 与 judgeLoop 不同，这一步发生在工作流"运行之前"，此时还没有 workflow_run，
 * 所以不落 step 记录，只是一次轻量模型调用。
 *
 * 异常处理刻意分两层：
 *   - 模型调用失败（密钥失效/超时/接口挂）——**向上抛**，让调用方（tick）记成"检查失败"，
 *     而不是伪装成"未命中"。以前这里 catch 吞掉一切，真出故障也只显示"未命中"，无从排查。
 *   - 模型有返回但 JSON 不可解析——按"未命中"处理（宁可漏触发也不误触发），但带上原因说明。
 */
export async function judgeTrigger(
  actor: string,
  condition: string,
  observation: string,
): Promise<{ trigger: boolean; reason: string }> {
  const instruction = `你是主动监测判定器。请判断下面的"观察内容"是否满足给定的"触发条件"。\n触发条件：${condition}\n\n只输出一行 JSON，不要任何多余文字或代码块：{"trigger": true 或 false, "reason": "命中则说明依据；未命中则简述原因"}。判定要保守：只有确有证据满足条件才 true。`;
  // 注意：askModel 的异常不在此捕获，交由 tick 记为"检查失败"。
  const raw = await askModel(actor, instruction, observation, "auto");
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return { trigger: false, reason: "模型未返回可解析的判定结果，按未命中处理" };
    const parsed = JSON.parse(match[0]) as { trigger?: unknown; reason?: unknown };
    return { trigger: parsed.trigger === true, reason: String(parsed.reason ?? "").trim() };
  } catch {
    // 有返回但不是合法 JSON：按未命中处理，等下一轮再评估，绝不误触发工作流。
    return { trigger: false, reason: "模型返回无法解析为判定 JSON，按未命中处理" };
  }
}

export async function workflowApprover(actor: string) {
  const member = await runtime.DB.prepare(
    "SELECT m.direct_manager_email AS directManagerEmail,u.manager_email AS unitManagerEmail FROM org_members m LEFT JOIN org_units u ON u.id=m.unit_id WHERE m.email=?"
  ).bind(actor).first<{ directManagerEmail: string; unitManagerEmail: string }>();
  if (member?.directManagerEmail && member.directManagerEmail !== actor) return member.directManagerEmail;
  if (member?.unitManagerEmail && member.unitManagerEmail !== actor) return member.unitManagerEmail;
  const owner = await runtime.DB.prepare("SELECT email FROM user_roles WHERE role='管理员' AND email<>? ORDER BY created_at,email LIMIT 1")
    .bind(actor).first<{ email: string }>();
  return owner?.email || "";
}

export async function executeWorkflow(workflow: WorkflowRow, actor: string, role: string, input: string, options: WorkflowRunOptions = {}) {
  const nodes = parseNodes(workflow.steps);
  if (!nodes.length) throw new Error("工作流没有可执行步骤");
  const now = new Date().toISOString();
  let runId = options.runId || 0;
  if (!runId) {
    const created = await runtime.DB.prepare("INSERT INTO workflow_runs(workflow_id,workflow_name,actor,status,input,started_at,conversation_id,source_channel) VALUES(?,?,?,?,?,?,?,?) RETURNING id")
      .bind(workflow.id, workflow.name, actor, "运行中", input, now, options.conversationId || null, options.sourceChannel || "工作流中心").first<{ id: number }>();
    runId = created!.id;
  } else {
    await runtime.DB.prepare("UPDATE workflow_runs SET status='运行中',error='',finished_at=NULL WHERE id=?").bind(runId).run();
  }
  // 持续任务（loop_type≠单次）才进"执行→审查→循环评估→返工"的真循环；
  // 可视化构建器的普通工作流恒为"单次"：maxLoops=1、base=0，行为与改造前逐字节一致。
  const isLoopTask = (workflow.loopType || "单次") !== "单次";
  const maxLoops = isLoopTask ? Math.min(10, Math.max(1, Number(workflow.maxLoops) || 3)) : 1;
  // 定时触发/历史任务传进来的是"定时触发"这类占位输入，用工作流目标兜底，避免节点空转。
  const goal = (workflow.goal || "").trim();
  const seed = goal && ["", "定时触发", "执行本次工作流", "执行任务"].includes((input || "").trim()) ? goal : input;
  // 返工轮从"第一个非输入节点"重跑：input 节点会用固定模板覆盖 current，重跑它会冲掉上一轮的返工意见。
  const firstWorkIndex = Math.max(0, nodes.findIndex(node => node.type !== "input"));
  let current = options.current ?? seed;
  const startIndex = Math.max(0, options.startIndex || 0);
  const membership = await runtime.DB.prepare("SELECT unit_id AS unitId FROM org_members WHERE email=?").bind(actor).first<{ unitId: number }>();
  let loopsRun = 0;
  try {
    for (let loop = 0; loop < maxLoops; loop++) {
      loopsRun = loop + 1;
      const base = loop * nodes.length;
      const from = loop === 0 ? startIndex : firstWorkIndex;
      for (let index = from; index < nodes.length; index++) {
      const node = nodes[index];
      if (node.parallelGroup) {
        const groupInput = current;
        const parallelNodes: Array<{ node: WorkflowNode; index: number }> = [];
        let cursor = index;
        while (cursor < nodes.length && nodes[cursor].parallelGroup === node.parallelGroup) {
          parallelNodes.push({ node: nodes[cursor], index: cursor });
          cursor++;
        }
        const results = await Promise.all(parallelNodes.map(async branch => {
          const started = new Date().toISOString();
          const step = await runtime.DB.prepare("INSERT INTO workflow_step_runs(run_id,step_index,step_type,step_name,status,input,started_at) VALUES(?,?,?,?,?,?,?) RETURNING id")
            .bind(runId, base + branch.index, branch.node.type, branch.node.name, "运行中", groupInput.slice(0, 12000), started).first<{ id: number }>();
          try {
            const prepared = prepareAiNode(branch.node, groupInput);
            const output = await askModel(actor, prepared.instruction, prepared.content, branch.node.modelMode || "auto");
            await runtime.DB.prepare("UPDATE workflow_step_runs SET status='已完成',output=?,finished_at=? WHERE id=?")
              .bind(output.slice(0, 12000), new Date().toISOString(), step!.id).run();
            return { name: branch.node.name, output };
          } catch (error) {
            const message = error instanceof Error ? error.message : "并行AI任务执行失败";
            await runtime.DB.prepare("UPDATE workflow_step_runs SET status='失败',error=?,finished_at=? WHERE id=?")
              .bind(message, new Date().toISOString(), step!.id).run();
            throw new Error(`${branch.node.name}：${message}`);
          }
        }));
        current = results.map((result, resultIndex) => `【并行任务 ${resultIndex + 1}：${result.name}】\n${result.output}`).join("\n\n");
        await runtime.DB.prepare("UPDATE workflow_runs SET current_step=?,output=? WHERE id=?")
          .bind(base + cursor, current.slice(0, 12000), runId).run();
        index = cursor - 1;
        continue;
      }
      const started = new Date().toISOString();
      const step = await runtime.DB.prepare("INSERT INTO workflow_step_runs(run_id,step_index,step_type,step_name,status,input,started_at) VALUES(?,?,?,?,?,?,?) RETURNING id")
        .bind(runId, base + index, node.type, node.name, "运行中", current.slice(0, 12000), started).first<{ id: number }>();
      try {
        if (node.type === "input") {
          if (node.inputMode === "direct") {
            current = `${node.config ? `【直接需求】\n${node.config}\n\n` : ""}【本次输入】\n${seed}`;
          } else if (node.inputMode === "markdown" || node.inputMode === "skill") {
            current = `【本次输入】\n${seed}\n\n【调用${node.inputMode === "skill" ? " Skill" : " Markdown"}：${node.resourceTitle || "未命名"}】\n${node.resourceContent || "未配置内容"}`;
          } else {
            const guide = node.promptGuide || {};
            const structured = [
              ["角色（Role）", guide.role], ["任务（Task）", guide.task], ["上下文（Context）", guide.context],
              ["约束（Constraint）", guide.constraint], ["格式（Format）", guide.format], ["示例（Example）", guide.example],
            ].filter(([,value])=>value).map(([label,value])=>`【${label}】\n${value}`).join("\n\n");
            current = `${structured ? `${structured}\n\n` : ""}【本次输入】\n${seed}`;
          }
        } else if (node.type === "knowledge") {
          // 知识检索节点=“知识库数据源”：每次运行都实时查询当前知识库内容。
          // 两种模式：files=只读用户勾选的具体文件；library=按 scope 读整库（旧行为）。
          // 无论哪种模式，权限都在后端重校：企业文档重查 visibility、个人知识限定 owner_email=actor，
          // 前端勾选只是便利，伪造 id 读不到无权文件。
          if (node.knowledgePick === "files" && node.knowledgeDocs?.length) {
            // 带前缀 id：e:<id>=企业 knowledge_documents、p:<id>=个人 personal_knowledge。
            // Number 化并过滤成正整数，杜绝把非法值拼进 IN 子句。
            const entIds = node.knowledgeDocs.filter(x => x.startsWith("e:")).map(x => Number(x.slice(2))).filter(n => Number.isInteger(n) && n > 0);
            const perIds = node.knowledgeDocs.filter(x => x.startsWith("p:")).map(x => Number(x.slice(2))).filter(n => Number.isInteger(n) && n > 0);
            let context = "";
            let personalContext = "";
            if (entIds.length) {
              // 沿用整库同款 visibility 权限条件，无权文档即使被勾选也查不出。
              const sql = `SELECT title,content FROM knowledge_documents WHERE id IN (${entIds.map(() => "?").join(",")}) AND (visibility='全员' OR visibility=? OR (visibility='部门' AND department_id=?)) ORDER BY updated_at DESC,id DESC LIMIT 20`;
              const docs = await runtime.DB.prepare(sql).bind(...entIds, role, membership?.unitId || -1).all<{ title: string; content: string }>();
              context = docs.results.map(d => `【企业知识：${d.title}】\n${d.content.slice(0, 2500)}`).join("\n\n");
            }
            if (perIds.length) {
              const sql = `SELECT title,content FROM personal_knowledge WHERE id IN (${perIds.map(() => "?").join(",")}) AND owner_email=? ORDER BY updated_at DESC,id DESC LIMIT 20`;
              const personal = await runtime.DB.prepare(sql).bind(...perIds, actor).all<{ title: string; content: string }>();
              personalContext = personal.results.map(d => `【个人知识：${d.title}】\n${d.content.slice(0, 2500)}`).join("\n\n");
            }
            current = `${current}\n\n--- 授权知识检索结果 ---\n${[context, personalContext].filter(Boolean).join("\n\n") || "未检索到匹配资料"}`;
          } else {
          // scope 决定检索哪些知识库：all=企业+个人、enterprise=仅企业、personal=仅个人。
          // 个人知识始终限定 owner_email=actor，工作流不能越权读他人的私有沉淀。
          const scope = node.knowledgeScope || "all";
          const words = Array.from(new Set((`${seed} ${node.config || ""}`).match(/[一-鿿]{2,}|[a-zA-Z0-9_-]{3,}/g) || [])).slice(0, 5);
          let context = "";
          let personalContext = "";
          if (scope !== "personal") {
            let sql = "SELECT title,content FROM knowledge_documents WHERE (visibility='全员' OR visibility=? OR (visibility='部门' AND department_id=?))";
            const binds: unknown[] = [role, membership?.unitId || -1];
            if (words.length) {
              sql += ` AND (${words.map(() => "(title LIKE ? OR content LIKE ?)").join(" OR ")})`;
              words.forEach(word => { binds.push(`%${word}%`, `%${word}%`); });
            }
            sql += " ORDER BY updated_at DESC,id DESC LIMIT 6";
            const docs = await runtime.DB.prepare(sql).bind(...binds).all<{ title: string; content: string }>();
            context = docs.results.map(d => `【企业知识：${d.title}】\n${d.content.slice(0, 2500)}`).join("\n\n");
          }
          if (scope !== "enterprise") {
            const personal = await runtime.DB.prepare("SELECT title,content FROM personal_knowledge WHERE owner_email=? ORDER BY updated_at DESC,id DESC LIMIT 6").bind(actor).all<{ title: string; content: string }>();
            personalContext = personal.results.map(d => `【个人知识：${d.title}】\n${d.content.slice(0, 2500)}`).join("\n\n");
          }
          current = `${current}\n\n--- 授权知识检索结果 ---\n${[context,personalContext].filter(Boolean).join("\n\n") || "未检索到匹配资料"}`;
          }
        } else if (node.type === "ai") {
          const prepared = prepareAiNode(node, current);
          current = await askModel(actor, prepared.instruction, prepared.content, node.modelMode || "auto");
        } else if (node.type === "agent") {
          const agentId = Number(node.config);
          const agent = await runtime.DB.prepare("SELECT a.name,a.description,a.instructions,a.knowledge_scope AS knowledgeScope,a.status,COALESCE(c.config_json,a.config_json,'{}') AS configJson FROM ai_agents a LEFT JOIN agent_configs c ON c.agent_id=a.id WHERE a.id=?")
            .bind(agentId).first<{ name: string; description: string; instructions: string; knowledgeScope: string; status: string; configJson?: string }>();
          if (!agent || agent.status !== "已启用") throw new Error("所选智能体不存在或未启用");
          if (agent.knowledgeScope !== "全员" && agent.knowledgeScope !== role) throw new Error(`当前岗位无权调用智能体“${agent.name}”`);
          let agentConfig: { modelMode?: string } = {};
          try { agentConfig = JSON.parse(agent.configJson || "{}"); } catch {}
          const agentModelMode = node.modelMode || agentConfig.modelMode || "auto";
          const agentInput = current;
          current = await askModel(actor, `你正在以企业智能体“${agent.name}”执行任务。\n用途：${agent.description}\n工作指令：${agent.instructions}`, agentInput, agentModelMode);
          await runtime.DB.prepare("INSERT INTO agent_runs(agent_id,agent_name,actor,model_used,input,output,status,created_at) VALUES(?,?,?,?,?,?,?,?)")
            .bind(agentId, agent.name, actor, agentModelMode, agentInput.slice(0, 12000), current.slice(0, 12000), "已完成", new Date().toISOString()).run();
        } else if (node.type === "data") {
          const sourceId = Number(node.config);
          if (!sourceId) throw new Error("数据采集步骤尚未选择数据源");
          const collected = await collectSource(sourceId, actor, false);
          current = `${current}\n\n--- 数据采集结果 ---\n来源运行 #${collected.runId}，共 ${collected.rowCount} 条，已按数据源设置处理；默认自动进入${targetStoreLabels[collected.targetStore] || "知识库"}，输出为${outputFormatLabels[collected.outputFormat] || "Markdown"}。\n${collected.preview}`;
        } else if (node.type === "review") {
          const standard = node.config || workflow.reviewStandard || "内容完整、事实有依据、可以直接使用";
          current = await askModel(actor, `请按以下标准审查并改进内容：${standard}。只输出改进后的最终版本。`, current, node.modelMode || "auto");
        } else if (node.type === "approval") {
          const approverEmail = await workflowApprover(actor);
          if (!approverEmail) throw new Error("工作流需要审批，但企业架构中没有可用审批人");
          await runtime.DB.prepare("INSERT INTO approval_requests(requester,request_type,title,reason,status,approver_email,workflow_run_id,workflow_step_index,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
            .bind(actor, "运行自动化", `${workflow.name}：${node.name}`, `工作流运行 #${runId} 等待人工确认。当前结果摘要：${current.slice(0, 500)}`, "待审批", approverEmail, runId, index, new Date().toISOString()).run();
          await runtime.DB.prepare("UPDATE workflow_step_runs SET status='等待审批',output=?,finished_at=? WHERE id=?").bind(current.slice(0, 12000), new Date().toISOString(), step!.id).run();
          await runtime.DB.prepare("UPDATE workflow_runs SET status='等待审批',output=?,current_step=? WHERE id=?").bind(current.slice(0, 12000), index, runId).run();
          await audit(actor, "运行工作流", workflow.name, "等待审批", `运行#${runId}停在步骤${index + 1}`);
          return getRun(runId);
        } else if (node.type === "save") {
          const time = new Date().toISOString();
          await runtime.DB.prepare("INSERT INTO saved_artifacts(owner_email,title,artifact_type,source_type,content,config,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
            .bind(actor, `${workflow.name} ${new Date().toLocaleDateString("zh-CN")}`, "markdown", "loop", `# ${workflow.name}\n\n${current}`, JSON.stringify({ workflowId: workflow.id, runId }), time, time).run();
        }
        await runtime.DB.prepare("UPDATE workflow_step_runs SET status='已完成',output=?,finished_at=? WHERE id=?")
          .bind(current.slice(0, 12000), new Date().toISOString(), step!.id).run();
        await runtime.DB.prepare("UPDATE workflow_runs SET current_step=?,output=? WHERE id=?").bind(base + index + 1, current.slice(0, 12000), runId).run();
      } catch (error) {
        const message = error instanceof Error ? error.message : "步骤执行失败";
        await runtime.DB.prepare("UPDATE workflow_step_runs SET status='失败',error=?,finished_at=? WHERE id=?").bind(message, new Date().toISOString(), step!.id).run();
        throw error;
      }
      }
      if (!isLoopTask) break;
      // 循环评估：对照 目标/合格标准/停止条件 判定是否达标；未达标带返工意见进入下一轮。
      const verdict = await judgeLoop(actor, { goal, standard: workflow.reviewStandard || "", stopCondition: workflow.stopCondition || "" }, current, runId, base + nodes.length);
      if (verdict.pass || loop === maxLoops - 1) break;
      current = `${current}\n\n【上一轮未达标 · 返工要求】\n${verdict.feedback}\n\n请据此改进后重新产出完整、可直接交付的最终结果。`;
    }
    const finished = new Date().toISOString();
    await runtime.DB.prepare("UPDATE workflow_runs SET status='已完成',output=?,finished_at=? WHERE id=?").bind(current.slice(0, 12000), finished, runId).run();
    await runtime.DB.prepare("UPDATE workflows SET status='已完成',last_run_at=? WHERE id=?").bind(finished, workflow.id).run();
    await audit(actor, "运行工作流", workflow.name, "成功", isLoopTask ? `循环任务完成，共 ${loopsRun} 轮` : `运行#${runId}完成${nodes.length}个步骤`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "工作流执行失败";
    await runtime.DB.prepare("UPDATE workflow_runs SET status='失败',error=?,finished_at=? WHERE id=?").bind(message, new Date().toISOString(), runId).run();
    await runtime.DB.prepare("UPDATE workflows SET status='运行失败',last_run_at=? WHERE id=?").bind(new Date().toISOString(), workflow.id).run();
    await audit(actor, "运行工作流", workflow.name, "失败", message);
  }
  return getRun(runId);
}

export async function runWorkflowById(id: number, actor: string, role: string, input: string, options: WorkflowRunOptions = {}) {
  await ensureSchema();
  const workflow = await runtime.DB.prepare("SELECT id,name,steps,review_standard AS reviewStandard,max_loops AS maxLoops,goal,stop_condition AS stopCondition,loop_type AS loopType FROM workflows WHERE id=? AND status<>'停用'")
    .bind(id).first<WorkflowRow>();
  if (!workflow) throw new Error("工作流不存在或已停用");
  return executeWorkflow(workflow, actor, role, input || "执行本次工作流", options);
}

export async function resumeApprovedWorkflow(runId: number, actor: string, role: string) {
  await ensureSchema();
  const run = await runtime.DB.prepare("SELECT workflow_id AS workflowId,actor,status,input,output,current_step AS currentStep,conversation_id AS conversationId,source_channel AS sourceChannel FROM workflow_runs WHERE id=?")
    .bind(runId).first<{ workflowId: number; actor: string; status: string; input: string; output: string; currentStep: number; conversationId?: number; sourceChannel?: string }>();
  if (!run || run.status !== "等待审批") throw new Error("该工作流不在等待审批状态");
  const approval = await runtime.DB.prepare("SELECT status FROM approval_requests WHERE workflow_run_id=? AND workflow_step_index=? ORDER BY id DESC LIMIT 1")
    .bind(runId, run.currentStep).first<{ status: string }>();
  if (approval?.status !== "已通过") throw new Error("审批尚未通过，工作流不能继续");
  const workflow = await runtime.DB.prepare("SELECT id,name,steps,review_standard AS reviewStandard,max_loops AS maxLoops,goal,stop_condition AS stopCondition,loop_type AS loopType FROM workflows WHERE id=?")
    .bind(run.workflowId).first<WorkflowRow>();
  if (!workflow) throw new Error("原工作流已被删除，无法继续执行");
  await runtime.DB.prepare("UPDATE workflow_step_runs SET status='已完成',finished_at=? WHERE run_id=? AND step_index=? AND status='等待审批'")
    .bind(new Date().toISOString(), runId, run.currentStep).run();
  const result = await executeWorkflow(workflow, run.actor || actor, role, run.input, {
    runId,
    startIndex: run.currentStep + 1,
    current: run.output,
    conversationId: run.conversationId,
    sourceChannel: run.sourceChannel,
  });
  if (run.conversationId) {
    const completed = result;
    const answer = completed.status === "已完成"
      ? `审批已通过，工作流“${completed.workflowName}”已自动继续并完成。\n\n${completed.output || "流程已完成"}`
      : `审批已通过，但工作流“${completed.workflowName}”续跑后状态为“${completed.status}”：${completed.error || "请查看运行详情"}`;
    await runtime.DB.prepare("INSERT INTO chat_messages(conversation_id,role,content,sources,model_used,created_at) VALUES(?,'assistant',?,'[]','工作流执行器',?)")
      .bind(run.conversationId, answer, new Date().toISOString()).run();
  }
  return result;
}

export { parseNodes, getRun };
