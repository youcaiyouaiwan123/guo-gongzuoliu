import http from "node:http";

// 采集出网的实现拆到 collector.mjs：server.mjs 一被 import 就会监听端口，测试无法安全导入。
import { MAX_COLLECT_BYTES, requestText, requestTextFollowingRedirects } from "./collector.mjs";

const PORT = 8789;
const TARGET = "https://claudecc.top/v1/chat/completions";

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}


async function handleModelRelay(request, response) {
  const input = await readJson(request);
  const apiKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
  if (!apiKey) return json(response, 400, { message: "missing API Key" });

  const result = await requestText(TARGET, {
    method: "POST",
    timeout: 90000,
    timeoutMessage: "model relay timeout",
    userAgent: "Haixin-Enterprise-Model-Relay/1.0",
    accept: "application/json,text/event-stream,*/*",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: input.model,
      messages: input.messages,
      max_tokens: input.max_tokens,
      temperature: input.temperature,
    }),
  });
  response.writeHead(result.status, {
    "Content-Type": result.contentType,
  });
  response.end(result.body);
}

async function handleCollectorProxy(request, response) {
  const input = await readJson(request);
  const url = typeof input.url === "string" ? input.url.trim() : "";
  const method = String(input.method || "GET").toUpperCase() === "POST" ? "POST" : "GET";
  const forwardedHeaders = input.headers && typeof input.headers === "object" ? input.headers : {};
  if (!url) return json(response, 400, { ok: false, error: "missing collection url" });

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return json(response, 400, { ok: false, error: "invalid collection url" });
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    return json(response, 400, { ok: false, error: "only http/https urls are supported" });
  }

  try {
    const result = await requestTextFollowingRedirects(parsed.toString(), {
      method,
      timeout: 15000,
      publicOnly: true,
      timeoutMessage: "collection timeout",
      userAgent: forwardedHeaders["User-Agent"] || forwardedHeaders["user-agent"] || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 Haixin-Collector/2.0",
      accept: forwardedHeaders.Accept || forwardedHeaders.accept || "text/html,application/xhtml+xml,application/xml;q=0.9,application/json,text/csv,text/plain;q=0.8,*/*;q=0.7",
      headers: {
        "Accept-Language": forwardedHeaders["Accept-Language"] || forwardedHeaders["accept-language"] || "zh-CN,zh;q=0.9,en;q=0.8",
        "Cache-Control": "no-cache",
        Referer: parsed.origin + "/",
        // 数据源自定义的鉴权头（Authorization、X-Api-Key 等）。跨 origin 跳转时会被自动丢弃。
        ...(input.extraHeaders && typeof input.extraHeaders === "object" ? input.extraHeaders : {}),
      },
      maxBytes: MAX_COLLECT_BYTES,
    });
    return json(response, 200, {
      ok: true,
      httpStatus: result.status,
      contentType: result.contentType,
      body: result.body,
      truncated: result.truncated,
      finalUrl: result.finalUrl,
    });
  } catch (error) {
    return json(response, 502, {
      ok: false,
      error: error instanceof Error ? error.message : "collection proxy failed",
    });
  }
}

http
  .createServer(async (request, response) => {
    try {
      if (request.method === "POST" && request.url === "/v1/chat/completions") {
        return await handleModelRelay(request, response);
      }
      if (request.method === "POST" && request.url === "/collector/fetch") {
        return await handleCollectorProxy(request, response);
      }
      return json(response, 404, { message: "Not found" });
    } catch (error) {
      return json(response, 502, { message: error instanceof Error ? error.message : "relay failed" });
    }
  })
  .listen(PORT, "0.0.0.0", () => {
    console.log(`Model relay listening on ${PORT}`);
  });
