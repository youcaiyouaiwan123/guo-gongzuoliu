import type { ModelConnection, OrgUnit, Permission, PermissionCapability, Workflow, WorkflowNode } from "./shared-types";

export function inferModelProvider(model?: string) {
  const name = (model || "").toLowerCase();
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

export function cleanModelText(value?: string, model?: string) {
  const text = (value || "").trim();
  if (!text || text.includes("?") || text.includes("�") || /[鏅閫鏈绗鎸鑷浼涓瀹淇]/.test(text)) return inferModelProvider(model);
  return text;
}

export function formatModelOption(model: ModelConnection) {
  const provider = inferModelProvider(model.model);
  return `${provider} - ${model.model}`;
}

export function modelProviderMark(model: ModelConnection) {
  return inferModelProvider(model.model).slice(0, 1);
}

export function targetStoreLabel(value?: string) {
  return ({ personal: "个人知识库", enterprise: "企业知识库", both: "个人知识库 + 企业知识库" } as Record<string, string>)[value || "personal"] || "个人知识库";
}

export function outputFormatLabel(value?: string) {
  return ({ markdown: "Markdown", document: "文档", table: "表格", json: "JSON", raw: "原始文本" } as Record<string, string>)[value || "markdown"] || "Markdown";
}

export function collectorModeLabel(value?: string) {
  return ({ direct: "网页直采", api: "API采集", crawler: "万能爬虫", mcp: "MCP采集", screenshot: "图片/截图识别", paste: "手动粘贴" } as Record<string, string>)[value || "direct"] || "网页直采";
}

export function platformLabel(value?: string) {
  return ({ web: "通用网页", xiaohongshu: "小红书", douyin: "抖音", kuaishou: "快手", bilibili: "B站", weibo: "微博", zhihu: "知乎", wechat: "公众号", custom_api: "API/MCP" } as Record<string, string>)[value || "web"] || "通用网页";
}

export function sourceIcon(sourceType?: string) {
  if (sourceType?.includes("API")) return "API";
  if (sourceType?.includes("截图") || sourceType?.includes("图片")) return "图";
  if (sourceType?.includes("MCP")) return "MCP";
  if (sourceType?.includes("CSV") || sourceType?.includes("表")) return "表";
  if (sourceType?.includes("JSON")) return "数";
  if (sourceType?.includes("爬虫")) return "爬";
  return "网";
}

export function statusClassName(status?: string) {
  const statusMap: Record<string, string> = {
    "失败": "statusFailed",
    "运行失败": "statusFailed",
    "采集失败": "statusFailed",
    "等待审批": "statusPendingApproval",
    "等待审核": "statusPendingReview",
    "待审核": "statusPendingReview",
    "待确认": "statusPendingReview",
  };
  return statusMap[status || ""] || "";
}

export function connectorClassName(connectorId: string) {
  return ({ feishu: "feishu", dingtalk: "dingtalk", wecom: "wecom" } as Record<string, string>)[connectorId] || "generic";
}

export function currentBrowserOrigin() {
  return typeof window === "undefined" ? "" : window.location.origin.replace(/\/$/, "");
}

export function adaptUrlToCurrentOrigin(value?: string) {
  if (!value) return "";
  const origin = currentBrowserOrigin();
  if (!origin) return value;
  try {
    const url = new URL(value);
    return `${origin}${url.pathname}${url.search}${url.hash}`;
  } catch {
    return value.startsWith("/") ? `${origin}${value}` : value;
  }
}

export function adaptGatewayConfigToCurrentOrigin(value?: string) {
  if (!value) return "";
  try {
    const config = JSON.parse(value) as { relayUrl?: string };
    if (config.relayUrl) config.relayUrl = adaptUrlToCurrentOrigin(config.relayUrl);
    return JSON.stringify(config);
  } catch {
    return value;
  }
}

export function gatewayEnvLine(value?: string) {
  const adapted = adaptGatewayConfigToCurrentOrigin(value);
  if (!adapted) return "";
  try {
    return `HAIXIN_ACCOUNTS_JSON=${JSON.stringify([JSON.parse(adapted)])}`;
  } catch {
    return "";
  }
}

export function gatewayStartCommand() {
  return [
    "cd /opt/haixin-ai/current",
    "docker compose --env-file /opt/haixin-ai/shared/.env -f docker-compose.server.yml -p haixin up -d channel-gateway",
    "docker compose --env-file /opt/haixin-ai/shared/.env -f docker-compose.server.yml -p haixin logs -f channel-gateway",
  ].join("\n");
}

export function formatConnectorTime(value?: string) {
  if (!value) return "暂无";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "暂无" : date.toLocaleString("zh-CN");
}

export async function copyGatewayText(text: string) {
  if (!text) return;
  await navigator.clipboard?.writeText(text);
}

export function parseWorkflowNodes(workflow: Workflow): WorkflowNode[] {
  try { const nodes = JSON.parse(workflow.steps); if (Array.isArray(nodes)) return nodes as WorkflowNode[]; } catch {}
  const parts = workflow.steps.split(/→|->|\n/).filter(Boolean);
  return parts.map((name,index)=>({ id:`legacy-${index}`, type:(index===0?"input":index===parts.length-1?"output":"ai") as WorkflowNode["type"], name:name.trim() }));
}

export function unitMark(unit: OrgUnit) {
  const name = unit.name || "";
  const marks = [
    [/采购|供应链/, ["采", "amber"]],
    [/销售|商务/, ["销", "blue"]],
    [/市场|营销|品牌/, ["营", "purple"]],
    [/财务|会计|审计/, ["财", "gold"]],
    [/人事|人力|招聘/, ["人", "rose"]],
    [/行政|综合/, ["行", "slate"]],
    [/技术|研发|开发|IT/i, ["技", "cyan"]],
    [/运营/, ["运", "orange"]],
    [/客服|客户成功/, ["客", "teal"]],
    [/仓储|物流/, ["仓", "brown"]],
  ] as const;
  const matched = marks.find(([pattern]) => pattern.test(name));
  if (matched) return { label: matched[1][0], tone: matched[1][1] };
  if (unit.unitType === "公司") return { label: "企", tone: "green" };
  if (unit.unitType === "岗位组") return { label: "岗", tone: "slate" };
  return { label: "部", tone: "green" };
}

export function permissionKey(roleName: string, capability: string) {
  return `${roleName}::${capability}`;
}

export function buildPermissionDrafts(items: Permission[], catalog: PermissionCapability[] = []) {
  const next: Record<string, string> = {};
  for (const capability of catalog) {
    next[permissionKey("管理员", capability.key)] = "允许";
    next[permissionKey("普通员工", capability.key)] = capability.key === "collect_data"
      ? "允许"
      : items.find(item => item.role === "普通员工" && item.capability === capability.key)?.decision || capability.employee;
  }
  return next;
}

export function formatFileSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export function normalizeUploadError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "");
  if (/Payload Too Large|413/i.test(message)) {
    return "附件过大：聊天窗口单个附件请控制在 10MB 内。大文件请先上传到个人知识库或企业知识库，再让 AI 调用。";
  }
  if (/Unexpected token/i.test(message)) {
    return "附件上传返回异常，可能是文件过大或服务端没有返回标准结果。请压缩文件后重试，或先上传到知识库。";
  }
  return message || "附件读取失败。";
}
