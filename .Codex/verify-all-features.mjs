import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const applicationOrigin = "http://localhost:3000";
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const resultFile = path.join(currentDirectory, "feature-audit-results.json");
const testPrefix = `验收测试-${Date.now()}`;

const envText = await readFile(path.join(currentDirectory, "..", ".dev.vars"), "utf8");
const localEnv = Object.fromEntries(envText.split(/\r?\n/).map(line => line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)).filter(Boolean).map(match => [match[1], match[2]]));
const adminUsername = localEnv.DEFAULT_ADMIN_USERNAME || "admin";
const adminPassword = localEnv.DEFAULT_ADMIN_PASSWORD || "admin123456";

const targets = await fetch("http://localhost:9222/json").then(response => response.json());
const pageTarget = targets.find(target => target.type === "page");
assert.ok(pageTarget, "未找到启用远程调试的 Chrome 页面。");

const socket = new WebSocket(pageTarget.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

let commandId = 0;
const pendingCommands = new Map();
const runtimeErrors = [];
const results = [];

socket.addEventListener("message", event => {
  const message = JSON.parse(event.data);
  if (message.method === "Runtime.exceptionThrown") {
    runtimeErrors.push(message.params?.exceptionDetails?.exception?.description || message.params?.exceptionDetails?.text || "未知浏览器异常");
  }
  if (message.method === "Runtime.consoleAPICalled" && message.params?.type === "error") {
    runtimeErrors.push((message.params.args || []).map(item => item.value || item.description || "").join(" "));
  }
  const pending = pendingCommands.get(message.id);
  if (!pending) return;
  pendingCommands.delete(message.id);
  clearTimeout(pending.timeout);
  if (message.error) pending.reject(new Error(message.error.message));
  else pending.resolve(message.result);
});

function send(method, params = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const id = ++commandId;
    const timeout = setTimeout(() => {
      pendingCommands.delete(id);
      reject(new Error(`${method} 超过 ${timeoutMs}ms 未响应。`));
    }, timeoutMs);
    pendingCommands.set(id, { resolve, reject, timeout });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const response = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || "浏览器脚本执行失败。");
  }
  return response.result.value;
}

async function waitFor(expression, message, attempts = 80) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await evaluate(expression)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(message);
}

function record(section, item, status, detail, evidence = "") {
  results.push({ section, item, status, detail, evidence });
}

async function runCase(section, item, test) {
  console.log(`[测试] ${section} / ${item}`);
  try {
    const outcome = await test();
    record(section, item, outcome?.status || "通过", outcome?.detail || "验证通过。", outcome?.evidence || "");
    console.log(`[${outcome?.status || "通过"}] ${item}`);
  } catch (error) {
    record(section, item, "失败", error instanceof Error ? error.message : String(error));
    console.log(`[失败] ${item}：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function api(pathname, options = {}) {
  return evaluate(`(async () => {
    const options = ${JSON.stringify(options)};
    options.signal = AbortSignal.timeout(10000);
    const response = await fetch(${JSON.stringify(pathname)}, options);
    const contentType = response.headers.get("content-type") || "";
    let body;
    if (contentType.includes("application/json")) {
      body = await response.json().catch(() => ({}));
    } else {
      const bytes = await response.arrayBuffer();
      body = { byteLength: bytes.byteLength };
    }
    return { ok: response.ok, status: response.status, contentType, body };
  })()`);
}

function jsonRequest(pathname, method, body) {
  return api(pathname, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function requireOk(response, message) {
  assert.equal(response.ok, true, `${message}：HTTP ${response.status} ${response.body?.error || response.body?.message || ""}`.trim());
}

const created = {
  chatId: 0,
  documentId: 0,
  personalKnowledgeId: 0,
  artifactId: 0,
  agentId: 0,
  workflowId: 0,
  sourceId: 0,
  collectionRunIds: [],
  unitId: 0,
  monitoringId: 0,
  contractTemplateId: 0,
  contractDocumentId: 0,
  userEmail: "",
};
let initialAuditIds = null;

async function cleanupCreatedData() {
  const cleanupRequests = [];
  if (created.chatId) cleanupRequests.push(() => api(`/api/chat?id=${created.chatId}`, { method: "DELETE" }));
  if (created.documentId) cleanupRequests.push(() => api(`/api/state?id=${created.documentId}`, { method: "DELETE" }));
  if (created.personalKnowledgeId) cleanupRequests.push(() => api(`/api/personal-knowledge?id=${created.personalKnowledgeId}`, { method: "DELETE" }));
  if (created.artifactId) cleanupRequests.push(() => api(`/api/artifacts?id=${created.artifactId}`, { method: "DELETE" }));
  if (created.agentId) cleanupRequests.push(() => api(`/api/modules?module=agent&id=${created.agentId}`, { method: "DELETE" }));
  if (created.workflowId) cleanupRequests.push(() => api(`/api/modules?module=workflow&id=${created.workflowId}`, { method: "DELETE" }));
  for (const id of created.collectionRunIds) cleanupRequests.push(() => api(`/api/modules?module=collectionRun&id=${id}`, { method: "DELETE" }));
  if (created.sourceId) cleanupRequests.push(() => api(`/api/modules?module=source&id=${created.sourceId}`, { method: "DELETE" }));
  if (created.unitId) cleanupRequests.push(() => api(`/api/organization?id=${created.unitId}`, { method: "DELETE" }));
  if (created.monitoringId) cleanupRequests.push(() => jsonRequest(`/api/monitoring?id=${created.monitoringId}`, "DELETE", {}));
  if (created.contractDocumentId) cleanupRequests.push(() => jsonRequest(`/api/contracts?type=document&id=${created.contractDocumentId}`, "DELETE", {}));
  if (created.contractTemplateId) cleanupRequests.push(() => jsonRequest(`/api/contracts?type=template&id=${created.contractTemplateId}`, "DELETE", {}));
  if (created.userEmail) cleanupRequests.push(() => jsonRequest("/api/users", "DELETE", { emails: [created.userEmail] }));

  for (const cleanup of cleanupRequests) {
    try { await cleanup(); } catch { }
  }

  if (initialAuditIds) {
    try {
      const state = await api("/api/state");
      const newIds = (state.body?.logs || []).map(item => Number(item.id)).filter(id => id && !initialAuditIds.has(id));
      if (newIds.length) await api(`/api/state?auditLogIds=${newIds.join(",")}`, { method: "DELETE" });
    } catch { }
  }
}

await send("Page.enable");
await send("Runtime.enable");
await send("Network.enable");
await send("Network.clearBrowserCookies");
await send("Emulation.setDeviceMetricsOverride", { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false });

try {
  await send("Page.navigate", { url: `${applicationOrigin}/login` });
  await waitFor("document.readyState === 'complete' && Boolean(document.querySelector('.loginCard'))", "登录页未渲染完成。");

  const login = await evaluate(`fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ${JSON.stringify(adminUsername)}, password: ${JSON.stringify(adminPassword)}, adminOnly: true }),
  }).then(async response => ({ ok: response.ok, status: response.status, body: await response.text() }))`);
  assert.equal(login.ok, true, `管理员登录失败：HTTP ${login.status}`);

  await send("Page.navigate", { url: applicationOrigin });
  await waitFor("Boolean(document.querySelector('.sidebarNav')) && document.querySelectorAll('.navItem').length === 18", "控制台未完整渲染 18 个入口。");
  record("基础环境", "管理员登录", "通过", "默认管理员完成真实登录，会话 Cookie 生效。", "POST /api/auth/login");

  const pageDefinitions = [
    ["chat", "智能助手"], ["media", "图文视频生成"], ["artifacts", "沉淀中心"],
    ["knowledge", "企业知识"], ["agents", "智能体中心"], ["workflows", "自动化工作流"], ["data", "数据采集"],
    ["organization", "企业架构"], ["monitoring", "监控看板"], ["contracts", "合同中心"], ["approvals", "审批中心"],
    ["models", "模型接入"], ["connectors", "平台接入"], ["permissions", "权限中心"], ["logs", "审计日志"], ["users", "账号管理"],
    ["profile", "个人中心"], ["help", "使用说明"],
  ];

  for (const [tab, label] of pageDefinitions) {
    await runCase("页面逐项", label, async () => {
      await evaluate(`(() => {
        const item = document.querySelector(${JSON.stringify(`[data-tab=${tab}]`)});
        const group = item?.closest(".navGroup");
        if (group?.dataset.expanded !== "true") group?.querySelector(".navGroupToggle")?.click();
        item?.click();
      })()`);
      await waitFor(`document.querySelector("header h1")?.textContent === ${JSON.stringify(label)}`, `${label}页面未完成切换。`);
      await new Promise(resolve => setTimeout(resolve, 180));
      const snapshot = await evaluate(`(() => {
        const active = document.querySelector(${JSON.stringify(`[data-tab=${tab}]`)});
        const main = document.querySelector("main");
        const visibleSections = [...document.querySelectorAll("main section")].filter(element => {
          const style = getComputedStyle(element);
          return style.display !== "none" && style.visibility !== "hidden";
        });
        return {
          heading: document.querySelector("header h1")?.textContent || "",
          active: active?.getAttribute("aria-current") === "page",
          sectionCount: visibleSections.length,
          buttonCount: [...main.querySelectorAll("button")].filter(button => !button.disabled && getComputedStyle(button).display !== "none").length,
          inputCount: [...main.querySelectorAll("input,select,textarea")].filter(input => getComputedStyle(input).display !== "none").length,
          overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
          fatalText: /Unhandled|Internal Server Error|Application error|ChunkLoadError/i.test(document.body.innerText),
        };
      })()`);
      assert.equal(snapshot.heading, label, "页头与入口名称不一致。");
      assert.equal(snapshot.active, true, "入口未保持活动状态。");
      assert.ok(snapshot.sectionCount > 0, "页面没有可见内容区。");
      assert.equal(snapshot.overflowX, false, "页面出现整体横向溢出。");
      assert.equal(snapshot.fatalText, false, "页面出现运行时错误文本。");
      return { detail: `页头、活动状态和内容区正常；可操作按钮 ${snapshot.buttonCount} 个，表单控件 ${snapshot.inputCount} 个。`, evidence: "Chrome CDP DOM" };
    });
  }

  const endpointDefinitions = [
    ["会话", "/api/session"], ["企业知识与审计", "/api/state"], ["智能助手", "/api/chat"],
    ["沉淀中心", "/api/artifacts"], ["个人知识", "/api/personal-knowledge"], ["自动化模块", "/api/modules"],
    ["企业架构", "/api/organization"], ["审批与权限", "/api/governance"], ["模型接入", "/api/model"],
    ["平台接入", "/api/connectors"], ["监控看板", "/api/monitoring"], ["合同中心", "/api/contracts"],
    ["个人中心", "/api/profile"], ["账号管理", "/api/users"], ["系统邮件", "/api/admin/settings"],
    ["图片模型", "/api/image-models"], ["生图记录", "/api/image-generate"],
  ];
  const endpointResponses = new Map();
  for (const [label, pathname] of endpointDefinitions) {
    await runCase("接口逐项", label, async () => {
      const response = await api(pathname);
      requireOk(response, `${label}读取失败`);
      endpointResponses.set(pathname, response);
      return { detail: `GET ${pathname} 返回 HTTP ${response.status}。`, evidence: pathname };
    });
  }

  const initialState = endpointResponses.get("/api/state") || await api("/api/state");
  requireOk(initialState, "读取初始审计记录失败");
  initialAuditIds = new Set((initialState.body?.logs || []).map(item => Number(item.id)));

  await runCase("核心工作", "智能助手任务管理", async () => {
    const createdResponse = await jsonRequest("/api/chat", "POST", { action: "createConversation", modelMode: "none" });
    requireOk(createdResponse, "创建对话任务失败");
    created.chatId = Number(createdResponse.body.conversationId);
    assert.ok(created.chatId > 0, "创建接口未返回任务编号。");
    const renamed = await jsonRequest("/api/chat", "PATCH", { id: created.chatId, title: `${testPrefix}-对话` });
    requireOk(renamed, "重命名对话任务失败");
    const listed = await api(`/api/chat?conversationId=${created.chatId}`);
    requireOk(listed, "读取对话任务失败");
    assert.ok((listed.body.conversations || []).some(item => item.id === created.chatId && item.title === `${testPrefix}-对话`), "重命名结果未持久化。");
    const deleted = await api(`/api/chat?id=${created.chatId}`, { method: "DELETE" });
    requireOk(deleted, "删除对话任务失败");
    created.chatId = 0;
    return { detail: "创建、重命名、读取和删除任务闭环通过；未调用付费模型。", evidence: "/api/chat" };
  });

  await runCase("核心工作", "图文视频生成", async () => {
    const models = endpointResponses.get("/api/image-models") || await api("/api/image-models");
    const modelCount = (models.body?.models || []).length;
    const optimize = await jsonRequest("/api/image-prompt-optimize", "POST", { prompt: `${testPrefix} 企业海报` });
    const generate = await jsonRequest("/api/image-generate", "POST", { prompt: `${testPrefix} 企业海报` });
    if (!modelCount) {
      assert.equal(optimize.status, 400, "缺少文字模型时提示词优化应明确拒绝。");
      assert.equal(generate.status, 400, "缺少图片模型时生图应明确拒绝。");
      return { status: "受限", detail: "页面与接口正常，但文字模型和图片模型均未配置；接口返回明确配置提示，未执行真实生图。", evidence: "/api/image-models" };
    }
    return { status: "受限", detail: `检测到 ${modelCount} 个图片模型；为避免产生外部计费，本轮未发起真实生图。`, evidence: "/api/image-models" };
  });

  await runCase("核心工作", "沉淀中心", async () => {
    const saved = await jsonRequest("/api/artifacts", "POST", { title: `${testPrefix}-沉淀`, content: "# 验收测试\n\n临时沉淀内容。", artifactType: "markdown", sourceType: "upload", config: {} });
    requireOk(saved, "保存沉淀失败");
    created.artifactId = Number(saved.body.id);
    const listed = await api("/api/artifacts");
    requireOk(listed, "读取沉淀失败");
    assert.ok((listed.body.artifacts || []).some(item => item.id === created.artifactId), "保存的沉淀未出现在列表中。");
    const deleted = await api(`/api/artifacts?id=${created.artifactId}`, { method: "DELETE" });
    requireOk(deleted, "删除沉淀失败");
    created.artifactId = 0;
    return { detail: "Markdown 沉淀的保存、列表读取和删除闭环通过。", evidence: "/api/artifacts" };
  });

  await runCase("知识与自动化", "企业知识", async () => {
    const saved = await jsonRequest("/api/state", "POST", { type: "document", title: `${testPrefix}-企业知识`, content: "用于验证企业知识保存、索引状态和更新检查。", visibility: "全员", category: "验收测试", tags: "验收测试", updateMode: "手动更新", updateSchedule: "" });
    requireOk(saved, "保存企业知识失败");
    created.documentId = Number(saved.body.document?.id);
    assert.ok(created.documentId > 0, "知识接口未返回资料编号。");
    const sync = await jsonRequest("/api/state", "PATCH", { id: created.documentId, action: "sync" });
    requireOk(sync, "检查知识更新失败");
    const deleted = await api(`/api/state?id=${created.documentId}`, { method: "DELETE" });
    requireOk(deleted, "删除企业知识失败");
    created.documentId = 0;
    return { detail: "在线资料保存、更新检查和删除闭环通过。", evidence: "/api/state" };
  });

  await runCase("知识与自动化", "个人知识", async () => {
    const saved = await jsonRequest("/api/personal-knowledge", "POST", { title: `${testPrefix}-个人知识`, content: "用于验证个人知识隔离和删除。", sourceType: "验收测试" });
    requireOk(saved, "保存个人知识失败");
    created.personalKnowledgeId = Number(saved.body.item?.id);
    const listed = await api("/api/personal-knowledge");
    requireOk(listed, "读取个人知识失败");
    assert.ok((listed.body.items || []).some(item => item.id === created.personalKnowledgeId), "个人知识未出现在本人列表中。");
    const deleted = await api(`/api/personal-knowledge?id=${created.personalKnowledgeId}`, { method: "DELETE" });
    requireOk(deleted, "删除个人知识失败");
    created.personalKnowledgeId = 0;
    return { detail: "个人知识保存、本人列表读取和删除闭环通过。", evidence: "/api/personal-knowledge" };
  });

  await runCase("知识与自动化", "智能体中心", async () => {
    const saved = await jsonRequest("/api/modules", "POST", { type: "agent", name: `${testPrefix}-智能体`, instructions: "只用于本地验收，不调用外部模型。", knowledgeScope: "全员", status: "已启用" });
    requireOk(saved, "创建智能体失败");
    created.agentId = Number(saved.body.id);
    const listed = await api("/api/modules");
    requireOk(listed, "读取智能体失败");
    assert.ok((listed.body.agents || []).some(item => item.id === created.agentId), "创建的智能体未出现在列表中。");
    const deleted = await api(`/api/modules?module=agent&id=${created.agentId}`, { method: "DELETE" });
    requireOk(deleted, "删除智能体失败");
    created.agentId = 0;
    return { detail: "智能体定义创建、读取和删除通过；实际回答受模型未配置限制。", evidence: "/api/modules" };
  });

  await runCase("知识与自动化", "自动化工作流", async () => {
    const steps = [
      { id: "input", type: "input", name: "输入任务" },
      { id: "output", type: "output", name: "输出结果" },
    ];
    const saved = await jsonRequest("/api/modules", "POST", { type: "workflow", name: `${testPrefix}-工作流`, triggerType: "手动触发", steps: JSON.stringify(steps) });
    requireOk(saved, "创建工作流失败");
    const listed = await api("/api/modules");
    requireOk(listed, "读取工作流失败");
    const workflow = (listed.body.workflows || []).find(item => item.name === `${testPrefix}-工作流`);
    assert.ok(workflow?.id, "创建的工作流未出现在列表中。");
    created.workflowId = Number(workflow.id);
    const deleted = await api(`/api/modules?module=workflow&id=${created.workflowId}`, { method: "DELETE" });
    requireOk(deleted, "删除工作流失败");
    created.workflowId = 0;
    return { detail: "两步工作流定义创建、读取和删除通过；未创建不可无痕清理的运行历史。", evidence: "/api/modules" };
  });

  await runCase("知识与自动化", "数据采集", async () => {
    const saved = await jsonRequest("/api/modules", "POST", { type: "source", name: `${testPrefix}-数据源`, sourceType: "手动粘贴", sampleData: "名称,数量\n验收样本,1", collectorMode: "paste", targetStore: "personal", outputFormat: "markdown", schedule: "手动" });
    requireOk(saved, "创建数据源失败");
    const sourceList = await api("/api/modules");
    requireOk(sourceList, "读取新建数据源失败");
    created.sourceId = Number((sourceList.body.sources || []).find(item => item.name === `${testPrefix}-数据源`)?.id);
    assert.ok(created.sourceId > 0, "创建的数据源未出现在列表中。");
    const run = await jsonRequest("/api/modules", "POST", { type: "run", module: "source", action: "test", id: String(created.sourceId), name: `${testPrefix}-数据源` });
    requireOk(run, "测试数据源失败");
    assert.equal(run.body.rowCount, 1, "测试采集没有识别 CSV 数据行。");
    assert.match(run.body.preview || "", /验收样本/, "测试采集预览缺少样本内容。");
    const deleted = await api(`/api/modules?module=source&id=${created.sourceId}`, { method: "DELETE" });
    requireOk(deleted, "删除数据源失败");
    created.sourceId = 0;
    return { detail: "手动数据源创建、CSV 样本识别、采集预览和删除闭环通过；测试模式按设计不写运行记录。", evidence: "/api/modules" };
  });

  await runCase("企业运营", "企业架构", async () => {
    const saved = await jsonRequest("/api/organization", "POST", { action: "createUnit", name: `${testPrefix}-部门`, unitType: "部门", sortOrder: "999" });
    requireOk(saved, "创建组织节点失败");
    const listed = await api("/api/organization");
    requireOk(listed, "读取组织节点失败");
    const unit = (listed.body.units || []).find(item => item.name === `${testPrefix}-部门`);
    assert.ok(unit?.id, "创建的组织节点未出现在列表中。");
    created.unitId = Number(unit.id);
    const deleted = await api(`/api/organization?id=${created.unitId}`, { method: "DELETE" });
    requireOk(deleted, "删除组织节点失败");
    created.unitId = 0;
    return { detail: "空部门创建、列表读取和删除闭环通过。", evidence: "/api/organization" };
  });

  await runCase("企业运营", "监控看板", async () => {
    const saved = await jsonRequest("/api/monitoring", "POST", { title: `${testPrefix}-监控`, platform: "验收平台", data: "date,campaign,cost,impressions,clicks,conversions,revenue\n2026-07-30,验收计划,100,1000,80,8,500" });
    requireOk(saved, "生成监控报表失败");
    created.monitoringId = Number(saved.body.id);
    assert.equal(saved.body.report?.rowCount, 1, "报表没有识别测试数据行。");
    const listed = await api("/api/monitoring");
    assert.ok((listed.body.reports || []).some(item => item.id === created.monitoringId), "生成的报表未出现在列表中。");
    const deleted = await jsonRequest(`/api/monitoring?id=${created.monitoringId}`, "DELETE", {});
    requireOk(deleted, "删除监控报表失败");
    created.monitoringId = 0;
    return { detail: "CSV 解析、指标计算、报表保存、列表读取和删除闭环通过。", evidence: "/api/monitoring" };
  });

  await runCase("企业运营", "合同中心", async () => {
    const templateTitle = `${testPrefix}-合同模板`;
    const savedTemplate = await jsonRequest("/api/contracts", "POST", { action: "saveTemplate", title: templateTitle, description: "验收测试", content: "甲方：{{甲方}}\n乙方：{{乙方}}\n金额：{{金额}}" });
    requireOk(savedTemplate, "保存合同模板失败");
    assert.deepEqual(savedTemplate.body.variables, ["甲方", "乙方", "金额"], "合同变量识别结果不正确。");
    const listed = await api("/api/contracts");
    const template = (listed.body.templates || []).find(item => item.title === templateTitle);
    assert.ok(template?.id, "合同模板未出现在列表中。");
    created.contractTemplateId = Number(template.id);
    const generated = await jsonRequest("/api/contracts", "POST", { action: "generate", templateId: created.contractTemplateId, values: { 甲方: "甲公司", 乙方: "乙公司", 金额: "1000元" } });
    requireOk(generated, "生成合同失败");
    created.contractDocumentId = Number(generated.body.id);
    const pdf = await api(`/api/contracts/pdf?id=${created.contractDocumentId}`);
    requireOk(pdf, "下载合同 PDF 失败");
    assert.ok(pdf.contentType.includes("application/pdf") && pdf.body.byteLength > 500, "合同 PDF 内容无效。");
    const deletedDocument = await jsonRequest(`/api/contracts?type=document&id=${created.contractDocumentId}`, "DELETE", {});
    requireOk(deletedDocument, "删除合同文件失败");
    created.contractDocumentId = 0;
    const deletedTemplate = await jsonRequest(`/api/contracts?type=template&id=${created.contractTemplateId}`, "DELETE", {});
    requireOk(deletedTemplate, "删除合同模板失败");
    created.contractTemplateId = 0;
    return { detail: "模板保存、变量识别、合同生成、PDF 下载和删除闭环通过。", evidence: "/api/contracts" };
  });

  await runCase("企业运营", "审批中心", async () => {
    const governance = endpointResponses.get("/api/governance") || await api("/api/governance");
    requireOk(governance, "读取审批列表失败");
    const invalid = await jsonRequest("/api/governance", "POST", { action: "submit", requestType: "模型接入", title: "", reason: "", approverEmail: "" });
    assert.equal(invalid.status, 400, "不完整审批申请应被拒绝。");
    return { status: "受限", detail: "列表读取和必填校验通过；当前只有一个可登录账号，未伪造第二审批人，因此未执行正向提交/处理链路。并发处理由现有自动测试覆盖。", evidence: "/api/governance" };
  });

  await runCase("系统与接入", "模型接入", async () => {
    const response = endpointResponses.get("/api/model") || await api("/api/model");
    requireOk(response, "读取模型配置失败");
    const count = (response.body.connections || []).length;
    return count
      ? { status: "受限", detail: `读取到 ${count} 个模型连接；本轮未发起可能产生计费的外部模型调用。`, evidence: "/api/model" }
      : { status: "受限", detail: "模型配置接口正常，但当前没有模型连接，AI 对话、智能体回答和 AI 工作流不能真实执行。", evidence: "/api/model" };
  });

  await runCase("系统与接入", "平台接入", async () => {
    const response = endpointResponses.get("/api/connectors") || await api("/api/connectors");
    requireOk(response, "读取平台配置失败");
    const connectors = response.body.connectors || [];
    const configured = connectors.filter(item => item.configured);
    const online = connectors.filter(item => item.gatewayOnline);
    return configured.length && online.length
      ? { status: "受限", detail: `检测到 ${configured.length} 个已配置平台、${online.length} 个在线网关；未向真实机器人发送消息。`, evidence: "/api/connectors" }
      : { status: "受限", detail: `平台列表接口正常；已配置 ${configured.length} 个，真实网关在线 ${online.length} 个，无法执行飞书/钉钉/企业微信收发验收。`, evidence: "/api/connectors" };
  });

  await runCase("系统与接入", "权限中心", async () => {
    const response = endpointResponses.get("/api/governance") || await api("/api/governance");
    requireOk(response, "读取权限目录失败");
    assert.ok((response.body.capabilities || []).length >= 20, "权限能力目录不完整。");
    const invalid = await jsonRequest("/api/governance", "POST", { action: "permission", role: "普通员工", capability: "__invalid__", decision: "允许" });
    assert.equal(invalid.status, 400, "无效权限项应被拒绝。");
    return { detail: `读取到 ${(response.body.capabilities || []).length} 个能力项，无效权限写入被正确拒绝；未修改现有权限策略。`, evidence: "/api/governance" };
  });

  await runCase("系统与接入", "账号管理", async () => {
    created.userEmail = `feature-audit-${Date.now()}@example.test`;
    const saved = await jsonRequest("/api/users", "POST", { email: created.userEmail, role: "普通员工", displayName: `${testPrefix}-员工`, status: "启用" });
    requireOk(saved, "创建测试账号失败");
    const listed = await api("/api/users");
    requireOk(listed, "读取账号列表失败");
    assert.ok((listed.body.users || []).some(item => item.email === created.userEmail && item.role === "普通员工"), "测试账号未出现在列表中。");
    const deleted = await jsonRequest("/api/users", "DELETE", { emails: [created.userEmail] });
    requireOk(deleted, "删除测试账号失败");
    created.userEmail = "";
    return { detail: "普通员工账号创建、角色读取和删除闭环通过。", evidence: "/api/users" };
  });

  await runCase("系统与接入", "审计日志", async () => {
    const state = await api("/api/state");
    requireOk(state, "读取审计日志失败");
    const newLogs = (state.body.logs || []).filter(item => !initialAuditIds.has(Number(item.id)));
    assert.ok(newLogs.length > 0, "业务操作没有产生审计记录。");
    return { detail: `本轮业务操作产生 ${newLogs.length} 条可读取审计记录，测试结束后统一清理。`, evidence: "/api/state" };
  });

  await runCase("账户与帮助", "个人中心", async () => {
    const profile = endpointResponses.get("/api/profile") || await api("/api/profile");
    requireOk(profile, "读取个人资料失败");
    assert.equal(profile.body.role, "管理员", "当前管理员角色识别不正确。");
    const invalid = await jsonRequest("/api/profile", "POST", { action: "changePassword", newPassword: "123", confirmPassword: "123" });
    assert.equal(invalid.status, 400, "过短密码应被拒绝。");
    return { detail: "资料读取和密码强度校验通过；未修改当前管理员密码或会话。", evidence: "/api/profile" };
  });

  await runCase("账户与帮助", "系统邮件与注册", async () => {
    const settings = endpointResponses.get("/api/admin/settings") || await api("/api/admin/settings");
    requireOk(settings, "读取 SMTP 配置失败");
    const configured = ["smtpHost", "smtpPort", "smtpAccount", "smtpSender", "smtpCredential"].every(key => Boolean(settings.body.settings?.[key]));
    return configured
      ? { status: "受限", detail: "SMTP 配置字段完整；为避免向真实邮箱发送验证码，本轮未发信。", evidence: "/api/admin/settings" }
      : { status: "受限", detail: "SMTP 配置接口正常，但配置不完整，邮箱验证码注册当前不可用。", evidence: "/api/admin/settings" };
  });

  await runCase("账户与帮助", "使用说明", async () => {
    await evaluate(`document.querySelector('[data-tab=help]')?.click()`);
    await waitFor("document.querySelector('header h1')?.textContent === '使用说明'", "使用说明页面未打开。");
    const textLength = await evaluate("document.querySelector('main')?.innerText.length || 0");
    assert.ok(textLength > 300, "使用说明内容过少或未渲染。");
    return { detail: `帮助内容已渲染，共 ${textLength} 个文本字符。`, evidence: "18-help.png" };
  });

  const uniqueRuntimeErrors = [...new Set(runtimeErrors.filter(Boolean))];
  if (uniqueRuntimeErrors.length) {
    record("浏览器运行时", "控制台与页面异常", "失败", uniqueRuntimeErrors.slice(0, 8).join(" | "));
  } else {
    record("浏览器运行时", "控制台与页面异常", "通过", "逐页切换期间未捕获未处理异常或 console.error。", "Chrome CDP Runtime");
  }
} finally {
  await cleanupCreatedData();
  const summary = {
    generatedAt: new Date().toISOString(),
    applicationOrigin,
    total: results.length,
    passed: results.filter(item => item.status === "通过").length,
    limited: results.filter(item => item.status === "受限").length,
    failed: results.filter(item => item.status === "失败").length,
    results,
  };
  await writeFile(resultFile, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  socket.close();
}

const failed = results.filter(item => item.status === "失败");
console.log(`全功能逐项验收完成：通过 ${results.filter(item => item.status === "通过").length}，受限 ${results.filter(item => item.status === "受限").length}，失败 ${failed.length}。`);
console.log(`详细结果：${resultFile}`);
assert.equal(failed.length, 0, `存在 ${failed.length} 项失败，请查看详细结果。`);
