import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";

const PORT = 8789;
const TARGET = "https://claudecc.top/v1/chat/completions";
const MAX_COLLECT_BYTES = 500_000;

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

function isBlockedIpv4(address) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19));
}

function isBlockedIp(address) {
  if (net.isIPv4(address)) return isBlockedIpv4(address);
  if (!net.isIPv6(address)) return true;
  const normalized = address.toLowerCase();
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd") || /^fe[89ab]/.test(normalized)) return true;
  const mappedIpv4 = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  return mappedIpv4 ? isBlockedIpv4(mappedIpv4) : false;
}

async function assertPublicTarget(targetUrl) {
  const parsed = new URL(targetUrl);
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname === "metadata.google.internal") {
    throw new Error("collection target is not allowed");
  }
  const addresses = net.isIP(hostname)
    ? [{ address: hostname }]
    : await dns.promises.lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(item => isBlockedIp(item.address))) {
    throw new Error("collection target is not allowed");
  }
}

function requestText(targetUrl, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const client = parsed.protocol === "https:" ? https : http;
    const body = options.body ? Buffer.from(options.body, "utf8") : null;
    const req = client.request(
      parsed,
      {
        method: options.method || "GET",
        timeout: options.timeout || 15000,
        rejectUnauthorized: true,
        ...(options.publicOnly ? {
          lookup(hostname, lookupOptions, callback) {
            dns.lookup(hostname, lookupOptions, (error, address, family) => {
              if (error) return callback(error);
              if (typeof address !== "string" || isBlockedIp(address)) return callback(new Error("collection target is not allowed"));
              callback(null, address, family);
            });
          },
        } : {}),
        headers: {
          "User-Agent": options.userAgent || "Haixin-Enterprise-Relay/1.0",
          Accept: options.accept || "*/*",
          ...(body ? { "Content-Type": "application/json", "Content-Length": body.length } : {}),
          ...(options.headers || {}),
        },
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on("data", (chunk) => {
          if (options.maxBytes && size >= options.maxBytes) return;
          const remaining = options.maxBytes ? options.maxBytes - size : chunk.length;
          const piece = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
          chunks.push(piece);
          size += piece.length;
        });
        res.on("end", () => {
          resolve({
            status: res.statusCode || 0,
            contentType: res.headers["content-type"] || "text/plain; charset=utf-8",
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error(options.timeoutMessage || "request timeout")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function handleModelRelay(request, response) {
  const input = await readJson(request);
  const apiKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
  if (!apiKey) return json(response, 400, { message: "missing API Key" });

  const result = await requestText(TARGET, {
    method: "POST",
    timeout: 45000,
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
    await assertPublicTarget(parsed.toString());
    const result = await requestText(parsed.toString(), {
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
      },
      maxBytes: MAX_COLLECT_BYTES,
    });
    return json(response, 200, {
      ok: true,
      httpStatus: result.status,
      contentType: result.contentType,
      body: result.body,
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
