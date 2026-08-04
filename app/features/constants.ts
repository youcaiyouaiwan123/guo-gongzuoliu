import type { ApiResult, Tab } from "./shared-types";

export function createGatewaySecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

export const MODEL_PRESETS = [
  { provider: "Anthropic Claude", mark: "A", models: ["claude-haiku-4-5", "claude-sonnet-4-5-20250929", "claude-sonnet-4-6", "claude-sonnet-4-6-thinking", "claude-opus-4-5-20251101", "claude-opus-4-6", "claude-opus-4-6-thinking", "claude-opus-4-7", "claude-opus-4-7-thinking", "claude-opus-4-8", "claude-opus-5", "claude-sonnet-5"] },
  { provider: "Google Gemini", mark: "G", models: ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.5-flash-thinking", "gemini-2.5-pro", "gemini-2.5-pro-thinking", "gemini-3-flash-preview", "gemini-3.1-flash-lite", "gemini-3.1-pro-preview", "gemini-3.5-flash"] },
  { provider: "OpenAI", mark: "O", models: ["gpt-4.1", "gpt-4.1-mini", "gpt-4o", "gpt-4o-mini", "gpt-5", "gpt-5.1", "gpt-5.2", "gpt-5.4", "gpt-5.4-mini", "gpt-5.5", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"] },
  { provider: "DeepSeek", mark: "D", models: ["deepseek-v3.2", "deepseek-v4-flash", "deepseek-v4-pro"] },
  { provider: "智谱 AI", mark: "智", models: ["glm-5.1", "glm-5.2"] },
  { provider: "通义千问", mark: "通", models: ["qwen3.7-plus", "qwen3.7-plus-2026-05-26", "qwen3.7-max", "qwen3.7-max-preview"] },
  { provider: "月之暗面", mark: "月", models: ["kimi-k2.6"] },
  { provider: "MiniMax", mark: "M", models: ["MiniMax-M2.5"] },
] as const;
export const ALL_PRESET_MODELS = MODEL_PRESETS.flatMap(group => group.models.map(model => ({ provider: group.provider, model })));

export const pinnedWelcome = "欢迎使用海芯博创智能体。我司专注于大模型销售与 AI 培训两大核心业务，为企业提供从模型选型到团队赋能的一站式 AI 解决方案。诚邀各界合作伙伴垂询洽谈，共启智能未来。";

export type NavigationIconName =
  | "assistant"
  | "media"
  | "archive"
  | "knowledge"
  | "agent"
  | "workflow"
  | "data"
  | "organization"
  | "monitoring"
  | "contract"
  | "approval"
  | "model"
  | "connector"
  | "permission"
  | "audit"
  | "users"
  | "profile"
  | "help";
export type NavigationItem = [Tab, NavigationIconName, string];
export type NavigationGroup = { key: string; label: string; items: NavigationItem[] };

export const navGroups: NavigationGroup[] = [
  {
    key: "work",
    label: "核心工作",
    items: [["chat", "assistant", "智能助手"], ["media", "media", "图文视频生成"], ["artifacts", "archive", "沉淀中心"]],
  },
  {
    key: "automation",
    label: "知识与自动化",
    items: [["knowledge", "knowledge", "企业知识"], ["agents", "agent", "智能体中心"], ["workflows", "workflow", "自动化工作流"], ["data", "data", "数据采集"]],
  },
  {
    key: "operations",
    label: "企业运营",
    items: [["organization", "organization", "企业架构"], ["monitoring", "monitoring", "监控看板"], ["contracts", "contract", "合同中心"], ["approvals", "approval", "审批中心"]],
  },
  {
    key: "system",
    label: "系统与接入",
    items: [["models", "model", "模型接入"], ["connectors", "connector", "平台接入"], ["permissions", "permission", "权限中心"], ["logs", "audit", "审计日志"], ["users", "users", "账号管理"]],
  },
  {
    key: "account",
    label: "账户与帮助",
    items: [["profile", "profile", "个人中心"], ["help", "help", "使用说明"]],
  },
];

const adminOnlyTabs = new Set<Tab>(["permissions", "logs", "users"]);

export const nav = navGroups.flatMap(group => group.items);

export function navigationGroupsForRole(isAdmin: boolean) {
  if (isAdmin) return navGroups;
  return navGroups
    .map(group => ({ ...group, items: group.items.filter(([tab]) => !adminOnlyTabs.has(tab)) }))
    .filter(group => group.items.length > 0);
}

export function navigationGroupKeyForTab(tab: Tab) {
  return navGroups.find(group => group.items.some(([itemTab]) => itemTab === tab))?.key || navGroups[0].key;
}

export async function readApiResult(response: Response, emptyMessage: string) {
  const text = await response.text();
  if (!text.trim()) return { error: emptyMessage };
  try {
    return JSON.parse(text) as ApiResult;
  } catch {
    return { error: text.replace(/\s+/g, " ").trim().slice(0, 300) || emptyMessage };
  }
}
