import http from "node:http";
import crypto from "node:crypto";
import tls from "node:tls";
import * as lark from "@larksuiteoapi/node-sdk";
import { DWClient, TOPIC_ROBOT } from "dingtalk-stream";
import AiBot, { generateReqId } from "@wecom/aibot-node-sdk";

const instanceId = process.env.HOSTNAME || `gateway-${crypto.randomUUID().slice(0, 8)}`;
const port = Number(process.env.PORT || 8788);
const states = new Map();
const running = new Map();
const recentEvents = new Map();
let lastSyncError = "";
let lastMessageSyncAt = 0;

function validateAccount(item) {
  for (const field of ["id", "platform", "appId", "appSecret", "relayUrl", "relaySecret"]) {
    if (!item[field]) throw new Error(`Account is missing ${field}`);
  }
  if (!["feishu", "dingtalk", "wecom"].includes(item.platform)) throw new Error(`Unsupported platform: ${item.platform}`);
}

function parseEnvAccounts() {
  let accounts;
  try {
    accounts = JSON.parse(process.env.HAIXIN_ACCOUNTS_JSON || "[]");
  } catch {
    throw new Error("HAIXIN_ACCOUNTS_JSON is not valid JSON");
  }
  if (!Array.isArray(accounts)) throw new Error("HAIXIN_ACCOUNTS_JSON must be an array");
  accounts.forEach(validateAccount);
  return accounts;
}

/**
 * 叫醒 app 去跑到期的定时任务。
 *
 * 地址由 accounts 同步地址推导，省一个环境变量；两者本来就是同一个 app。
 */
async function tickSchedules() {
  const accountsUrl = process.env.HAIXIN_GATEWAY_ACCOUNTS_URL;
  const secret = process.env.HAIXIN_GATEWAY_ADMIN_SECRET?.trim();
  if (!accountsUrl || !secret) return;
  const url = accountsUrl.replace(/\/accounts(?:\/)?$/, "/tick");
  if (url === accountsUrl) return;
  try {
    const response = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${secret}` } });
    if (!response.ok) {
      console.error(`[schedule] tick failed HTTP ${response.status}`);
      return;
    }
    const data = await response.json().catch(() => null);
    if (data?.handled?.length) console.log(`[schedule] ${JSON.stringify(data.handled)}`);
  } catch (error) {
    // 调度失败不该影响长连接网关本职工作，记一行就够。
    console.error(`[schedule] tick error: ${error.message}`);
  }
}

// ── 邮件出站 ───────────────────────────────────────────────────────────────
// worker（wrangler dev --local）没有可靠的出站 SMTP，注册验证码只是写进 mail_outbox。
// 本进程常驻、本来就每隔几秒访问 app，顺带把待发邮件取走用 node:tls 直连 SMTP 投出去。
// 发信凭据只来自服务器环境变量（MAIL_*，落在 /opt/haixin-ai/shared/.env），不进 DB、不进仓库。

const b64 = (value) => Buffer.from(String(value), "utf8").toString("base64");

// 极简 SMTP over 隐式 TLS（465）客户端。按 EHLO→AUTH LOGIN→MAIL/RCPT/DATA 顺序推进，
// 每一步校验期望状态码，任一步不符即 reject。正文以 text/html 发出（验证码邮件已是 HTML）。
function sendMail({ host, port, user, pass, fromEmail, fromName, to, subject, html }) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch { /* already closed */ }
      err ? reject(err) : resolve();
    };
    const socket = tls.connect({ host, port: Number(port), servername: host });
    socket.setEncoding("utf8");
    socket.setTimeout(20_000, () => finish(new Error("SMTP 超时")));
    socket.on("error", (err) => finish(err));

    const fromHeader = fromName ? `=?UTF-8?B?${b64(fromName)}?= <${fromEmail}>` : fromEmail;
    const body = String(html || "")
      .replace(/\r?\n/g, "\r\n")
      .replace(/^\./gm, ".."); // dot-stuffing：正文里行首的 . 需转义，避免被当成结束符
    const message = [
      `From: ${fromHeader}`,
      `To: ${to}`,
      `Subject: =?UTF-8?B?${b64(subject)}?=`,
      "MIME-Version: 1.0",
      "Content-Type: text/html; charset=UTF-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      body,
      ".",
      "",
    ].join("\r\n");

    // 每步：期望状态码 + 命中后要发的命令（返回 null 表示自己已写入原始数据）。
    const steps = [
      { expect: "220", cmd: () => "EHLO haixin-gateway" },
      { expect: "250", cmd: () => "AUTH LOGIN" },
      { expect: "334", cmd: () => b64(user) },
      { expect: "334", cmd: () => b64(pass) },
      { expect: "235", cmd: () => `MAIL FROM:<${fromEmail}>` },
      { expect: "250", cmd: () => `RCPT TO:<${to}>` },
      { expect: "250", cmd: () => "DATA" },
      { expect: "354", cmd: () => { socket.write(message); return null; } },
      { expect: "250", cmd: () => "QUIT" },
    ];
    let step = 0;
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      // 只在收到完整行（以 CRLF 结尾）且末行是「三位数字+空格」的终结行时才推进，
      // 兼容 EHLO 的 `250-...` 多行响应。
      if (!buffer.endsWith("\r\n")) return;
      const lines = buffer.split("\r\n").filter(Boolean);
      const last = lines[lines.length - 1] || "";
      if (!/^\d{3} /.test(last)) return;
      buffer = "";
      const current = steps[step];
      if (last.slice(0, 3) !== current.expect) {
        finish(new Error(`SMTP 期望 ${current.expect}，实际：${last.slice(0, 120)}`));
        return;
      }
      const isLast = step === steps.length - 1;
      const out = current.cmd();
      step += 1;
      if (out != null) socket.write(`${out}\r\n`);
      if (isLast) { try { socket.end(); } catch { /* ignore */ } finish(null); }
    });
  });
}

async function drainMailOutbox() {
  const accountsUrl = process.env.HAIXIN_GATEWAY_ACCOUNTS_URL;
  const secret = process.env.HAIXIN_GATEWAY_ADMIN_SECRET?.trim();
  const host = process.env.MAIL_HOST?.trim();
  const user = process.env.MAIL_USER?.trim();
  const pass = process.env.MAIL_PASS;
  if (!accountsUrl || !secret || !host || !user || !pass) return;
  const url = accountsUrl.replace(/\/accounts(?:\/)?$/, "/mail");
  if (url === accountsUrl) return;
  const cfg = {
    host,
    port: process.env.MAIL_PORT?.trim() || "465",
    user,
    pass,
    fromEmail: process.env.MAIL_FROM?.trim() || user,
    fromName: "海芯博创",
  };
  try {
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${secret}` } });
    if (!resp.ok) { console.error(`[mail] fetch failed HTTP ${resp.status}`); return; }
    const data = await resp.json().catch(() => null);
    const pending = data?.pending || [];
    if (!pending.length) return;
    const results = [];
    for (const mail of pending) {
      try {
        await sendMail({ ...cfg, to: mail.email, subject: mail.subject, html: mail.content });
        results.push({ id: mail.id, ok: true });
        console.log(`[mail] sent #${mail.id} → ${mail.email}`);
      } catch (error) {
        results.push({ id: mail.id, ok: false, error: error.message });
        console.error(`[mail] send #${mail.id} failed: ${error.message}`);
      }
    }
    await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
      body: JSON.stringify({ results }),
    }).catch((error) => console.error(`[mail] report error: ${error.message}`));
  } catch (error) {
    console.error(`[mail] drain error: ${error.message}`);
  }
}

async function fetchRemoteAccounts() {  const url = process.env.HAIXIN_GATEWAY_ACCOUNTS_URL;
  if (!url) return [];
  const secret = process.env.HAIXIN_GATEWAY_ADMIN_SECRET?.trim();
  if (!secret) throw new Error("HAIXIN_GATEWAY_ADMIN_SECRET is required when remote account sync is enabled");
  const response = await fetch(url, { headers: { Authorization: `Bearer ${secret}` } });
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).trim().slice(0, 300);
    throw new Error(`Gateway account sync failed HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
  }
  const data = await response.json();
  const accounts = Array.isArray(data.accounts) ? data.accounts : [];
  accounts.forEach(validateAccount);
  return accounts;
}

async function loadAccounts() {
  const byId = new Map();
  for (const account of parseEnvAccounts()) byId.set(account.id, account);
  for (const account of await fetchRemoteAccounts()) byId.set(account.id, account);
  return [...byId.values()];
}

function ensureState(account) {
  if (states.has(account.id)) return states.get(account.id);
  const state = {
    id: account.id,
    platform: account.platform,
    state: "starting",
    inboundCount: 0,
    outboundCount: 0,
    lastConnectedAt: "",
    lastMessageAt: "",
    error: "",
  };
  states.set(account.id, state);
  return state;
}

function update(account, patch) {
  Object.assign(ensureState(account), patch);
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "invalid-url";
  }
}

function logStep(account, stage, data = {}) {
  console.log(`[${account.id}] ${stage}`, JSON.stringify(data));
}

function feishuEventType(data) {
  return String(data?.header?.event_type || data?.type || data?.event?.type || "unknown");
}

function feishuMessageId(data) {
  return String(data?.event?.message?.message_id || data?.message?.message_id || "");
}

function alreadyHandled(account, eventId) {
  if (!eventId) return false;
  const key = `${account.id}:${eventId}`;
  const now = Date.now();
  for (const [storedKey, expiresAt] of recentEvents) {
    if (expiresAt <= now) recentEvents.delete(storedKey);
  }
  if (recentEvents.has(key)) return true;
  recentEvents.set(key, now + 10 * 60 * 1000);
  return false;
}

function logError(account, stage, error, data = {}) {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? String(error.stack || "").split("\n").slice(0, 3).join(" | ") : "";
  console.error(`[${account.id}] ${stage} ERROR`, JSON.stringify({ ...data, message, stack }));
}

function gatewayStatusUrl(relayUrl) {
  return new URL(relayUrl).toString();
}

function relayHeaders(account) {
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${account.relaySecret}`,
  };
  if (account.sitesBypassToken) {
    headers["OAI-Sites-Authorization"] = `Bearer ${account.sitesBypassToken}`;
  }
  return headers;
}

async function heartbeat(account) {
  const state = states.get(account.id);
  try {
    const response = await fetch(gatewayStatusUrl(account.relayUrl), {
      method: "POST",
      headers: relayHeaders(account),
      body: JSON.stringify({ kind: "gateway_heartbeat", ...state, instanceId }),
    });
    const raw = await response.text().catch(() => "");
    let result = {};
    try {
      result = raw ? JSON.parse(raw) : {};
    } catch {
      result = {};
    }
    if (!response.ok) {
      const detail = raw.trim().slice(0, 300);
      throw new Error(`Status report failed HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
    }
    const nextModelMode = typeof result.modelMode === "string" ? result.modelMode.trim() : "";
    if (nextModelMode) {
      account.defaultModelMode = nextModelMode;
      const current = running.get(account.id);
      if (current?.account) current.account.defaultModelMode = nextModelMode;
    }
  } catch (error) {
    console.error(`[${account.id}] heartbeat`, error);
  }
}

async function relay(account, eventId, platformUserId, text) {
  const state = states.get(account.id);
  state.inboundCount += 1;
  state.lastMessageAt = new Date().toISOString();
  const startedAt = Date.now();
  await syncBeforeMessage(account);
  const modelMode = account.defaultModelMode || "auto";
  logStep(account, "backend.relay.request", {
    eventId,
    platformUserId,
    textLength: text.length,
    relay: safeUrl(account.relayUrl),
    modelMode,
  });
  const response = await fetch(account.relayUrl, {
    method: "POST",
    headers: relayHeaders(account),
    body: JSON.stringify({ eventId, platformUserId, text, modelMode }),
  });
  const raw = await response.text().catch(() => "");
  let result = {};
  try {
    result = raw ? JSON.parse(raw) : {};
  } catch {
    result = {};
  }
  logStep(account, "backend.relay.response", {
    eventId,
    status: response.status,
    durationMs: Date.now() - startedAt,
    replyLength: String(result.reply || "").trim().length,
    rawPreview: raw.slice(0, 180),
  });
  if (!response.ok) throw new Error(String(result.message || result.error || `Haixin backend HTTP ${response.status}`));
  const reply = String(result.reply || "").trim();
  if (!reply) throw new Error("Haixin backend returned an empty reply");
  state.error = "";
  void heartbeat(account);
  return reply;
}

async function syncBeforeMessage(account) {
  const now = Date.now();
  if (now - lastMessageSyncAt < 3000) return;
  lastMessageSyncAt = now;
  try {
    await syncAccounts();
  } catch (error) {
    lastSyncError = error instanceof Error ? error.message : String(error);
    logError(account, "account.sync.beforeMessage", error);
  }
}

function online(account) {
  update(account, { state: "online", lastConnectedAt: new Date().toISOString(), error: "" });
  console.log(`[${account.id}] ${account.platform} connected`);
  void heartbeat(account);
}

function failed(account, error) {
  const message = error instanceof Error ? error.message : String(error);
  update(account, { state: "error", error: message });
  console.error(`[${account.id}]`, error);
  void heartbeat(account);
}

function processingError(account, error) {
  const message = error instanceof Error ? error.message : String(error);
  update(account, { error: message });
  logError(account, "message.processing", error);
  void heartbeat(account);
}

async function startFeishu(account) {
  const client = new lark.Client({
    appId: account.appId,
    appSecret: account.appSecret,
    appType: lark.AppType.SelfBuild,
  });
  const dispatcher = new lark.EventDispatcher({});
  const originalInvoke = dispatcher.invoke.bind(dispatcher);
  dispatcher.invoke = async (data, params) => {
    logStep(account, "feishu.event.incoming", {
      type: feishuEventType(data),
      messageId: feishuMessageId(data),
    });
    return originalInvoke(data, params);
  };
  dispatcher.register({
    "im.message.receive_v1": async event => {
      if (event.message?.message_type !== "text") {
        logStep(account, "feishu.message.ignored", {
          reason: "non_text_message",
          messageType: String(event.message?.message_type || ""),
          messageId: String(event.message?.message_id || ""),
        });
        return;
      }
      try {
        const text = String(JSON.parse(event.message.content || "{}").text || "").trim();
        if (!text) {
          logStep(account, "feishu.message.ignored", {
            reason: "empty_text",
            messageId: String(event.message.message_id || ""),
          });
          return;
        }
        const eventId = String(event.message.message_id);
        if (alreadyHandled(account, eventId)) {
          logStep(account, "feishu.message.ignored", {
            reason: "duplicate_event",
            messageId: eventId,
          });
          return;
        }
        const platformUserId = String(event.sender?.sender_id?.open_id || "");
        logStep(account, "feishu.message.received", {
          eventId,
          platformUserId,
          chatId: String(event.message.chat_id || ""),
          chatType: String(event.message.chat_type || ""),
          textLength: text.length,
        });
        const reply = await relay(
          account,
          eventId,
          platformUserId,
          text,
        );
        logStep(account, "feishu.reply.request", { eventId, replyLength: reply.length });
        const sent = await client.im.message.reply({
          path: { message_id: eventId },
          data: { msg_type: "text", content: JSON.stringify({ text: reply }) },
        });
        states.get(account.id).outboundCount += 1;
        logStep(account, "feishu.reply.success", {
          eventId,
          code: sent?.code ?? 0,
          msg: sent?.msg || "ok",
        });
        void heartbeat(account);
      } catch (error) {
        logError(account, "feishu.message", error);
        processingError(account, error);
      }
    },
  });
  const ws = new lark.WSClient({
    appId: account.appId,
    appSecret: account.appSecret,
    loggerLevel: lark.LoggerLevel.info,
    autoReconnect: true,
    handshakeTimeoutMs: 15_000,
    onReady: () => online(account),
    onReconnecting: () => update(account, { state: "reconnecting" }),
    onReconnected: () => online(account),
    onError: error => failed(account, error),
  });
  void ws.start({ eventDispatcher: dispatcher }).catch(error => failed(account, error));
  return () => ws.close?.();
}

async function startDingTalk(account) {
  const client = new DWClient({
    clientId: account.appId,
    clientSecret: account.appSecret,
    keepAlive: true,
  });
  client.registerCallbackListener(TOPIC_ROBOT, message => {
    // Acknowledge first so DingTalk does not redeliver while the model is processing.
    client.socketCallBackResponse(message.headers.messageId, { status: "SUCCESS", message: "accepted" });
    void (async () => {
      try {
        const body = JSON.parse(message.data || "{}");
        if (body.msgtype !== "text") return;
        const eventId = String(body.msgId || message.headers.messageId);
        const platformUserId = String(body.senderStaffId || body.senderId || "");
        logStep(account, "dingtalk.message.received", {
          eventId,
          platformUserId,
          textLength: String(body.text?.content || "").trim().length,
        });
        const reply = await relay(
          account,
          eventId,
          platformUserId,
          String(body.text?.content || "").trim(),
        );
        logStep(account, "dingtalk.reply.request", { eventId, replyLength: reply.length });
        const response = await fetch(body.sessionWebhook, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ msgtype: "text", text: { content: reply } }),
        });
        if (!response.ok) throw new Error(`DingTalk reply failed HTTP ${response.status}`);
        states.get(account.id).outboundCount += 1;
        logStep(account, "dingtalk.reply.success", { eventId, status: response.status });
        void heartbeat(account);
      } catch (error) {
        processingError(account, error);
      }
    })();
  });
  await client.connect();
  online(account);
  return () => client.disconnect();
}

async function startWeCom(account) {
  const client = new AiBot.WSClient({ botId: account.appId, secret: account.appSecret });
  client.on("authenticated", () => online(account));
  client.on("error", error => failed(account, error));
  client.on("disconnected", () => update(account, { state: "reconnecting" }));
  client.on("message.text", frame => {
    void (async () => {
      const streamId = generateReqId("haixin");
      try {
        const text = String(frame.body?.text?.content || "").trim();
        if (!text) return;
        await client.replyStream(frame, streamId, "正在处理…", false);
        const reply = await relay(
          account,
          String(frame.headers?.req_id || frame.body?.msgid || generateReqId("event")),
          String(frame.body?.from?.userid || frame.body?.userid || frame.body?.chatid || ""),
          text,
        );
        await client.replyStream(frame, streamId, reply, true);
      } catch (error) {
        processingError(account, error);
        await client.replyStream(frame, streamId, `处理失败：${error instanceof Error ? error.message : String(error)}`, true).catch(() => undefined);
      }
    })();
  });
  client.connect();
  return () => client.disconnect();
}

function signature(account) {
  return JSON.stringify({
    platform: account.platform,
    appId: account.appId,
    appSecret: account.appSecret,
    relayUrl: account.relayUrl,
    relaySecret: account.relaySecret,
  });
}

async function startAccount(account) {
  const close = account.platform === "feishu"
    ? await startFeishu(account)
    : account.platform === "dingtalk"
      ? await startDingTalk(account)
      : await startWeCom(account);
  running.set(account.id, { account, close, signature: signature(account) });
}

async function stopAccount(id) {
  const item = running.get(id);
  if (!item) return;
  try {
    await item.close?.();
  } catch (error) {
    console.error(`[${id}] close`, error);
  }
  running.delete(id);
  if (states.has(id)) states.get(id).state = "offline";
}

async function syncAccounts() {
  try {
    const accounts = await loadAccounts();
    const nextIds = new Set(accounts.map(account => account.id));
    for (const id of running.keys()) {
      if (!nextIds.has(id)) await stopAccount(id);
    }
    for (const account of accounts) {
      const nextSignature = signature(account);
      const current = running.get(account.id);
      if (current?.signature === nextSignature) {
        current.account.defaultModelMode = account.defaultModelMode || "auto";
        current.signature = nextSignature;
        continue;
      }
      if (current) await stopAccount(account.id);
      ensureState(account);
      update(account, { state: "starting", error: "" });
      try {
        await startAccount(account);
      } catch (error) {
        failed(account, error);
      }
    }
    lastSyncError = "";
    if (!accounts.length) console.log("No gateway accounts yet; waiting for platform credentials.");
  } catch (error) {
    lastSyncError = error instanceof Error ? error.message : String(error);
    console.error("[gateway] account sync", error);
  }
}

async function reloadAccounts() {
  for (const id of Array.from(running.keys())) await stopAccount(id);
  await syncAccounts();
}

function isAdminRequest(request) {
  const secret = String(process.env.HAIXIN_GATEWAY_ADMIN_SECRET || "").trim().replace(/^['"]|['"]$/g, "");
  const bearer = String(request.headers.authorization || request.headers.Authorization || "")
    .replace(/^Bearer\s+/i, "")
    .trim();
  if (!secret || !bearer) return false;
  const expected = Buffer.from(secret);
  const received = Buffer.from(bearer);
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}

await syncAccounts();
setInterval(syncAccounts, 15_000).unref();

// 定时任务心跳。
//
// 自托管的 app 跑的是 `wrangler dev --local`，收不到 Cloudflare 的 Cron Trigger，
// 而本进程本来就常驻、本来就每 15 秒访问一次 app，顺带把这一下也带上，
// 免得为了"每天 9 点跑个日报"再单起一个容器。失败只记日志：调度不该拖垮长连接网关。
setInterval(() => { void tickSchedules(); }, 60_000).unref();

// 邮件出站：验证码有效期 10 分钟，取走要快，隔 10 秒扫一次队列。
void drainMailOutbox();
setInterval(() => { void drainMailOutbox(); }, 10_000).unref();

setInterval(() => {
  for (const { account } of running.values()) void heartbeat(account);
}, 30_000).unref();

http.createServer(async (request, response) => {
  if (request.url === "/healthz") {
    const allOnline = [...states.values()].every(item => item.state === "online");
    response.writeHead(allOnline ? 200 : 503, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: allOnline, instanceId, syncError: lastSyncError, accounts: [...states.values()] }));
    return;
  }
  if (request.url === "/reload" && request.method === "POST") {
    if (!isAdminRequest(request)) {
      response.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ ok: false, message: "unauthorized" }));
      return;
    }
    await reloadAccounts();
    response.writeHead(lastSyncError ? 503 : 200, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: !lastSyncError, instanceId, syncError: lastSyncError, accounts: [...states.values()] }));
    return;
  }
  if (request.url === "/sync" && request.method === "POST") {
    if (!isAdminRequest(request)) {
      response.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ ok: false, message: "unauthorized" }));
      return;
    }
    await syncAccounts();
    response.writeHead(lastSyncError ? 503 : 200, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: !lastSyncError, instanceId, syncError: lastSyncError, accounts: [...states.values()] }));
    return;
  }
  if (request.url === "/status") {
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ instanceId, syncError: lastSyncError, accounts: [...states.values()] }));
    return;
  }
  response.writeHead(404);
  response.end("not found");
}).listen(port, () => console.log(`Haixin channel gateway status port: ${port}`));

async function shutdown() {
  for (const id of running.keys()) await stopAccount(id);
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
