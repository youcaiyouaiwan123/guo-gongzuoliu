import { env } from "cloudflare:workers";

export type ModelConnection = {
  provider?: string;
  baseUrl: string;
  model: string;
  apiKey: string;
};

export type ImageGenerationResult = {
  images: Array<{ url?: string; b64Json?: string; dataUrl?: string }>;
  raw?: unknown;
};

type ContentPart = { text?: unknown; content?: unknown };
type ModelPayload = {
  error?: { message?: string };
  message?: string;
  output_text?: string;
  choices?: Array<{
    message?: { content?: string | ContentPart[]; reasoning_content?: string };
    text?: string;
    delta?: { content?: string; reasoning_content?: string };
  }>;
  content?: string | ContentPart[];
  data?: { content?: string };
  response?: string;
  delta?: { text?: string };
  text?: string;
};
type ImageCandidate = {
  url?: unknown;
  image_url?: unknown;
  uri?: unknown;
  b64_json?: unknown;
  base64?: unknown;
  image_base64?: unknown;
};
type ImagePayload = {
  data?: ImageCandidate[];
  images?: ImageCandidate[];
  output?: ImageCandidate[];
  result?: { images?: ImageCandidate[] };
  url?: unknown;
  b64_json?: unknown;
};

type RuntimeEnv = { MODEL_RELAY_URL?: string; MODEL_BASE_URL?: string };

const runtime = env as unknown as RuntimeEnv;
// 模型接入走单一中转地址，由环境变量 MODEL_BASE_URL 注入；旧部署的"硬编码 URL + 强制 UPDATE
// 用户表"实现会静默覆盖管理员在平台页面配置的 baseUrl，已通过移除 ensureSchema 中的覆盖 SQL
// 予以修复。运行时仍保留一个回退值，仅在 env 完全缺失时使用，避免冷启动失败。
const FIXED_MODEL_BASE_URL = runtime.MODEL_BASE_URL?.trim() || "https://claudecc.top";

function failure(payload: unknown, fallback: string) {
  const data = payload as ModelPayload;
  return data?.error?.message || data?.message || fallback;
}

function looksLikeJson(value: string) {
  const text = value.trim();
  return (
    (text.startsWith("{") && text.endsWith("}")) ||
    (text.startsWith("[") && text.endsWith("]"))
  );
}

function textFromPayload(payload: unknown, depth = 0): string {
  if (depth > 3) return "";

  if (typeof payload === "string") {
    if (looksLikeJson(payload)) {
      try {
        const nestedText = textFromPayload(JSON.parse(payload), depth + 1);
        if (nestedText) return nestedText;
      } catch {
        // The string only looks like JSON. Use it as plain text.
      }
    }
    return payload;
  }

  const data = payload as ModelPayload;
  if (typeof data?.output_text === "string") {
    return textFromPayload(data.output_text, depth + 1) || data.output_text;
  }

  const choice = data?.choices?.[0];
  if (
    typeof choice?.message?.content === "string" &&
    choice.message.content.trim()
  ) {
    return (
      textFromPayload(choice.message.content, depth + 1) ||
      choice.message.content
    );
  }
  if (Array.isArray(choice?.message?.content)) {
    return choice.message.content
      .map((item: ContentPart) => typeof item.text === "string" ? item.text : typeof item.content === "string" ? item.content : "")
      .join("");
  }
  if (
    typeof choice?.message?.reasoning_content === "string" &&
    choice.message.reasoning_content.trim()
  ) {
    return choice.message.reasoning_content;
  }
  if (typeof choice?.text === "string") return choice.text;

  if (typeof data?.content === "string") {
    return textFromPayload(data.content, depth + 1) || data.content;
  }
  if (Array.isArray(data?.content)) {
    return data.content
      .map((item: ContentPart) => typeof item.text === "string" ? item.text : typeof item.content === "string" ? item.content : "")
      .join("");
  }
  if (typeof data?.data?.content === "string") {
    return textFromPayload(data.data.content, depth + 1) || data.data.content;
  }
  if (typeof data?.response === "string") {
    return textFromPayload(data.response, depth + 1) || data.response;
  }

  return "";
}

function apiBase(baseUrl: string) {
  const base = baseUrl.replace(/\/+$/, "");
  return /\/v\d+$/i.test(base) ? base : `${base}/v1`;
}

function textFromEventStream(raw: string) {
  let result = "";
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const value = line.slice(5).trim();
    if (!value || value === "[DONE]") continue;
    try {
      const payload = JSON.parse(value);
      result +=
        payload?.choices?.[0]?.delta?.content ||
        payload?.choices?.[0]?.delta?.reasoning_content ||
        payload?.delta?.text ||
        payload?.text ||
        "";
    } catch {
      // Ignore keep-alive or non-JSON stream lines.
    }
  }
  return result;
}

// 模型接口没有超时就等于没有上限：对端卡住时请求会一直挂着，
// 占满 Worker 并发额度，用户侧表现为页面一直转圈。
// 文字与图片分开设阈值，图片生成本身就慢得多。
const TEXT_MODEL_TIMEOUT_MS = 60_000;
const IMAGE_MODEL_TIMEOUT_MS = 120_000;

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number, label: string) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new Error(`${label}在 ${Math.round(timeoutMs / 1000)} 秒内没有响应，请稍后重试或更换模型连接。`);
    }
    throw error;
  }
}

async function readPayload(response: Response) {
  const raw = await response.text();
  if (!raw) return { payload: {}, text: "" };
  if (raw.includes("data:")) {
    const text = textFromEventStream(raw);
    if (text) return { payload: {}, text };
  }
  try {
    const payload = JSON.parse(raw);
    return { payload, text: textFromPayload(payload) };
  } catch {
    return { payload: raw, text: raw.trim() };
  }
}

function ensureText(text: string, protocol: string) {
  const value = text.trim();
  if (!value) {
    throw new Error(
      `${protocol} 接口已连接，但没有返回可读文字。请检查模型名称与接口协议是否匹配。`,
    );
  }
  return value;
}

export async function callModel(
  connection: ModelConnection,
  messages: Array<{ role: string; content: string }>,
  options: { maxTokens?: number; temperature?: number } = {},
) {
  // This deployment intentionally routes every vendor/model through the same
  // OpenAI-compatible endpoint, so stored URLs cannot accidentally leak keys.
  const maxTokens = options.maxTokens || 1600;
  const temperature = options.temperature ?? 0.2;

  if (runtime.MODEL_RELAY_URL) {
    const response = await fetchWithTimeout(runtime.MODEL_RELAY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiKey: connection.apiKey,
        model: connection.model,
        messages,
        max_tokens: maxTokens,
        temperature,
      }),
    }, TEXT_MODEL_TIMEOUT_MS, "模型中转服务");
    const { payload, text } = await readPayload(response);
    if (!response.ok) {
      throw new Error(failure(payload, `模型中转服务返回 ${response.status}`));
    }
    return ensureText(text, "模型");
  }

  const response = await fetchWithTimeout(`${apiBase(FIXED_MODEL_BASE_URL)}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${connection.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: connection.model,
      max_tokens: maxTokens,
      temperature,
      messages,
    }),
  }, TEXT_MODEL_TIMEOUT_MS, "模型接口");
  const { payload, text } = await readPayload(response);
  if (!response.ok) {
    throw new Error(failure(payload, `模型接口返回 ${response.status}`));
  }
  return ensureText(text, "模型");
}

function imageDataFromPayload(payload: unknown): ImageGenerationResult {
  const data = payload as ImagePayload;
  const images: Array<{ url?: string; b64Json?: string; dataUrl?: string }> = [];
  const candidates = [
    ...(Array.isArray(data?.data) ? data.data : []),
    ...(Array.isArray(data?.images) ? data.images : []),
    ...(Array.isArray(data?.output) ? data.output : []),
    ...(Array.isArray(data?.result?.images) ? data.result.images : []),
  ];

  for (const item of candidates) {
    const url = item?.url || item?.image_url || item?.uri;
    const b64Json = item?.b64_json || item?.base64 || item?.image_base64;
    if (typeof url === "string" && url.trim()) images.push({ url: url.trim() });
    if (typeof b64Json === "string" && b64Json.trim()) {
      const value = b64Json.trim();
      images.push({
        b64Json: value,
        dataUrl: value.startsWith("data:") ? value : `data:image/png;base64,${value}`,
      });
    }
  }

  if (typeof data?.url === "string") images.push({ url: data.url });
  if (typeof data?.b64_json === "string") {
    images.push({ b64Json: data.b64_json, dataUrl: `data:image/png;base64,${data.b64_json}` });
  }

  return { images, raw: payload };
}

/**
 * 从文本中提取 Markdown 图片（支持 base64 data URL 和普通 URL）
 */
function extractImagesFromMarkdown(text: string): Array<{ url?: string; dataUrl?: string }> {
  const results: Array<{ url?: string; dataUrl?: string }> = [];
  const regex = /!\[.*?\]\((data:image\/[^;]+;base64,[^)]+)\)/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const dataUrl = match[1];
    results.push({ dataUrl, b64Json: dataUrl.replace(/^data:image\/[^;]+;base64,/, "") });
  }
  const urlRegex = /!\[.*?\]\((https?:\/\/[^)]+)\)/g;
  while ((match = urlRegex.exec(text)) !== null) {
    results.push({ url: match[1] });
  }
  return results;
}

/**
 * 判断是否为 Gemini 原生生图模型（通过对话接口生成图片，非 Imagen）
 */
function isGeminiNativeImageModel(model: string): boolean {
  const name = model.toLowerCase();
  return name.includes("gemini") && !name.includes("imagen");
}

export async function callImageModel(
  connection: ModelConnection,
  prompt: string,
  options: { size?: string; count?: number; quality?: string } = {},
): Promise<ImageGenerationResult> {
  const size = options.size || "1024x1024";
  const count = Math.min(Math.max(Number(options.count || 1), 1), 4);
  const quality = options.quality || "standard";

  // Gemini 原生生图模型走对话接口
  if (isGeminiNativeImageModel(connection.model)) {
    const response = await fetchWithTimeout(`${apiBase(FIXED_MODEL_BASE_URL)}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${connection.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: connection.model,
        max_tokens: 8000,
        temperature: 0.2,
        messages: [
          {
            role: "user",
            content: `请生成一张图片：${prompt}\n\n要求：图片尺寸 ${size}，直接返回图片，不要额外文字说明。`,
          },
        ],
      }),
    }, IMAGE_MODEL_TIMEOUT_MS, "Gemini 图片接口");

    const raw = await response.text();
    let payload: unknown = {};
    try {
      payload = raw ? JSON.parse(raw) : {};
    } catch {
      payload = raw;
    }
    if (!response.ok) {
      throw new Error(failure(payload, `Gemini 图片接口返回 ${response.status}`));
    }

    const text = textFromPayload(payload);
    const images = extractImagesFromMarkdown(text);

    // 也尝试从原始响应中提取图片
    const data = payload as Record<string, unknown>;
    const choices = data?.choices as Array<Record<string, unknown>> | undefined;
    if (choices?.[0]) {
      const msg = choices[0].message as Record<string, unknown> | undefined;
      if (msg?.content && typeof msg.content === "string") {
        const more = extractImagesFromMarkdown(msg.content);
        images.push(...more);
      }
    }

    if (!images.length) {
      throw new Error(`Gemini 模型 ${connection.model} 已连接，但没有返回图片。请确认该模型是否支持生图，或更换 Imagen 模型。`);
    }
    return { images, raw: payload };
  }

  // 常规图片模型（OpenAI / Imagen / 其他）走 /images/generations 接口
  const response = await fetchWithTimeout(`${apiBase(FIXED_MODEL_BASE_URL)}/images/generations`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${connection.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: connection.model,
      prompt,
      n: count,
      size,
      quality,
      response_format: "b64_json",
    }),
  }, IMAGE_MODEL_TIMEOUT_MS, "图片模型接口");

  const raw = await response.text();
  let payload: unknown = {};
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    payload = raw;
  }
  if (!response.ok) {
    throw new Error(failure(payload, `图片模型接口返回 ${response.status}`));
  }

  const result = imageDataFromPayload(payload);
  if (!result.images.length) {
    throw new Error("图片模型已连接，但没有返回图片。请确认第三方中转是否支持该图片模型。");
  }
  return result;
}

// ─── Function Calling 支持 ─────────────────────────────

type ToolDefinition = {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
};

type ToolCallResult = {
  role: "tool";
  tool_call_id: string;
  content: string;
};

type ToolCallRequest = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

/**
 * 带 Function Calling 的模型调用
 *
 * 发送消息和工具定义给模型，如果模型返回 tool_calls，
 * 自动执行工具并将结果返回。支持多轮 tool call 循环。
 */
export async function callModelWithTools(
  connection: ModelConnection,
  messages: Array<{ role: string; content: string }>,
  tools: ToolDefinition[],
  options: {
    maxTokens?: number;
    temperature?: number;
    maxToolCalls?: number;
    executeTool?: (name: string, args: Record<string, unknown>) => Promise<{ success: boolean; data?: unknown; error?: string }>;
  } = {},
): Promise<{ text: string; toolCalls: ToolCallResult[] }> {
  const maxTokens = options.maxTokens || 3200;
  const temperature = options.temperature ?? 0.2;
  const maxToolCalls = options.maxToolCalls || 10;
  const toolResults: ToolCallResult[] = [];
  let currentMessages = [...messages];

  for (let round = 0; round < maxToolCalls; round++) {
    const response = await fetchWithTimeout(
      `${apiBase(FIXED_MODEL_BASE_URL)}/chat/completions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${connection.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: connection.model,
          max_tokens: maxTokens,
          temperature,
          messages: currentMessages,
          tools: tools.map(t => ({
            type: "function",
            function: {
              name: t.name,
              description: t.description,
              parameters: t.parameters as Record<string, unknown>,
            },
          })),
          tool_choice: "auto",
        }),
      },
      TEXT_MODEL_TIMEOUT_MS,
      "模型接口",
    );

    const { payload, text } = await readPayload(response);
    if (!response.ok) {
      throw new Error(failure(payload, `模型接口返回 ${response.status}`));
    }

    const data = payload as {
      choices?: Array<{
        message?: {
          content?: string;
          tool_calls?: Array<{
            id: string;
            type: "function";
            function: { name: string; arguments: string };
          }>;
        };
      }>;
    };

    const choice = data?.choices?.[0];
    const msg = choice?.message;

    // 没有 tool_calls → 返回文本结果
    if (!msg?.tool_calls?.length) {
      return { text: text || msg?.content || "", toolCalls: toolResults };
    }

    // 处理 tool_calls
    const assistantContent = msg.content || "";
    const batchResults: ToolCallResult[] = [];

    for (const call of msg.tool_calls) {
      let resultContent: string;
      if (options.executeTool) {
        try {
          const args = JSON.parse(call.function.arguments);
          const result = await options.executeTool(call.function.name, args);
          resultContent = JSON.stringify(result);
        } catch (error) {
          resultContent = JSON.stringify({ success: false, error: error instanceof Error ? error.message : "执行失败" });
        }
      } else {
        resultContent = JSON.stringify({ success: false, error: "未提供工具执行器" });
      }
      batchResults.push({
        role: "tool",
        tool_call_id: call.id,
        content: resultContent,
      });
    }

    // 将 assistant 消息和 tool results 加入对话
    currentMessages.push({
      role: "assistant",
      content: assistantContent || null as unknown as string,
      // 注意：tool_calls 需要通过非标准字段传递
    } as Record<string, unknown> as { role: string; content: string });
    // 实际 tool_calls 需要附加到消息中
    const lastMsg = currentMessages[currentMessages.length - 1] as Record<string, unknown>;
    lastMsg.tool_calls = msg.tool_calls;

    for (const tr of batchResults) {
      currentMessages.push(tr as unknown as { role: string; content: string });
    }
    toolResults.push(...batchResults);
  }

  return { text: "已达到最大工具调用轮次", toolCalls: toolResults };
}

