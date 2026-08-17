// 平台接入：飞书、钉钉、企业微信的凭证管理。
// 使用 Hono 中间件统一处理认证和错误响应。
import { env } from "cloudflare:workers";
import { createApp, auth, success, fail, authorizeCapability } from "../_app";
import { encryptJson, decryptJson } from "../_crypto";

type Platform = "feishu" | "dingtalk" | "wecom";
type ConnectionMode = "callback" | "long_connection";
type RuntimeEnv = {
  DB: D1Database;
  PLATFORM_CREDENTIALS_KEY?: string;
  HAIXIN_GATEWAY_ADMIN_SECRET?: string;
  HAIXIN_CHANNEL_GATEWAY_URL?: string;
};
type Credentials = {
  appId: string;
  appSecret: string;
  callbackToken: string;
  connectionMode?: ConnectionMode;
  defaultModelMode?: string;
};

const runtime = env as unknown as RuntimeEnv;
const names: Record<Platform, string> = {
  feishu: "飞书",
  dingtalk: "钉钉",
  wecom: "企业微信",
};

async function encrypt(value: Credentials) {
  return encryptJson(value);
}

async function decrypt(value: string): Promise<Credentials> {
  const result = await decryptJson<Credentials>(value);
  if (result === null) throw new Error("平台凭证解析失败");
  return result;
}

function generateGatewaySecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function maskCredential(value?: string) {
  if (!value) return "";
  if (value.length <= 8) return `${value.slice(0, 2)}****${value.slice(-2)}`;
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}

function requestOrigin(request: Request) {
  const url = new URL(request.url);
  const forwardedProto = request.headers
    .get("x-forwarded-proto")
    ?.split(",")[0]
    ?.trim();
  const forwardedHost = request.headers
    .get("x-forwarded-host")
    ?.split(",")[0]
    ?.trim();
  const host = forwardedHost || request.headers.get("host");
  const proto = forwardedProto || url.protocol.replace(":", "");
  return host ? `${proto}://${host}` : url.origin;
}

async function syncChannelGateway() {
  const candidates = [
    runtime.HAIXIN_CHANNEL_GATEWAY_URL,
    "http://channel-gateway:8788",
    "http://127.0.0.1:8788",
  ]
    .filter(Boolean)
    .map((item) => String(item).replace(/\/$/, ""));
  const secret = runtime.HAIXIN_GATEWAY_ADMIN_SECRET?.trim();
  if (!secret) throw new Error("通道网关管理密钥尚未配置");
  const errors: string[] = [];
  for (const baseUrl of candidates) {
    try {
      const response = await fetch(`${baseUrl}/sync`, {
        method: "POST",
        headers: { Authorization: `Bearer ${secret}`, "X-Haixin-Gateway-Secret": secret },
      });
      if (response.ok) return;
      const detail = (await response.text().catch(() => "")).trim();
      errors.push(`${baseUrl}: ${detail || `HTTP ${response.status}`}`);
    } catch (error) {
      errors.push(`${baseUrl}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(errors.join("；") || "通道网关不可达");
}

async function schema() {
  await runtime.DB.prepare(
    "CREATE TABLE IF NOT EXISTS user_platform_connections (id INTEGER PRIMARY KEY AUTOINCREMENT,owner_email TEXT NOT NULL,platform TEXT NOT NULL,encrypted_credentials TEXT NOT NULL,connection_key TEXT NOT NULL UNIQUE,connection_mode TEXT NOT NULL DEFAULT 'callback',created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(owner_email,platform))",
  ).run();
  await runtime.DB.prepare(
    "ALTER TABLE user_platform_connections ADD COLUMN connection_mode TEXT NOT NULL DEFAULT 'callback'",
  )
    .run()
    .catch(() => undefined);
  await runtime.DB.prepare(
    "ALTER TABLE platform_messages ADD COLUMN owner_email TEXT NOT NULL DEFAULT ''",
  )
    .run()
    .catch(() => undefined);
  await runtime.DB.prepare(
    "CREATE TABLE IF NOT EXISTS platform_gateway_status (owner_email TEXT NOT NULL,platform TEXT NOT NULL,instance_id TEXT NOT NULL DEFAULT '',state TEXT NOT NULL DEFAULT 'offline',last_heartbeat_at TEXT NOT NULL DEFAULT '',last_connected_at TEXT NOT NULL DEFAULT '',last_error TEXT NOT NULL DEFAULT '',inbound_count INTEGER NOT NULL DEFAULT 0,outbound_count INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL,PRIMARY KEY(owner_email,platform))",
  ).run();
}

async function test(platform: Platform, credentials: Credentials) {
  if (platform === "feishu") {
    return fetch(
      "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          app_id: credentials.appId,
          app_secret: credentials.appSecret,
        }),
      },
    );
  }
  if (platform === "dingtalk") {
    return fetch("https://api.dingtalk.com/v1.0/oauth2/accessToken", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        appKey: credentials.appId,
        appSecret: credentials.appSecret,
      }),
    });
  }
  return new Response(
    JSON.stringify({
      code: credentials.appId && credentials.appSecret ? 0 : 1,
    }),
    {
      headers: { "Content-Type": "application/json" },
    },
  );
}

const app = createApp();
app.use("*", auth());

// GET /api/connectors — 获取平台连接列表
app.get("*", async (c) => {
  const { user } = c.var;
  await schema();
  const origin = requestOrigin(c.req.raw);
  const rows = await runtime.DB.prepare(
    "SELECT platform,connection_key AS connectionKey,connection_mode AS connectionMode,encrypted_credentials AS encryptedCredentials,updated_at AS updatedAt FROM user_platform_connections WHERE owner_email=?",
  )
    .bind(user.email)
    .all<{
      platform: Platform;
      connectionKey: string;
      connectionMode: ConnectionMode;
      encryptedCredentials: string;
      updatedAt: string;
    }>();
  const byPlatform = new Map(rows.results.map((row) => [row.platform, row]));

  return success({
    connectors: await Promise.all(
      (Object.keys(names) as Platform[]).map(async (id) => {
        const row = byPlatform.get(id);
        const credentials = row
          ? await decrypt(row.encryptedCredentials).catch(() => null)
          : null;
        const latest = row
          ? await runtime.DB.prepare(
              "SELECT status,error,created_at AS createdAt FROM platform_messages WHERE platform=? AND owner_email=? ORDER BY updated_at DESC LIMIT 1",
            )
              .bind(id, user.email)
              .first<{ status: string; error: string; createdAt: string }>()
              .catch(() => null)
          : null;
        const gateway = row
          ? await runtime.DB.prepare(
              "SELECT state,last_heartbeat_at AS lastHeartbeatAt,last_connected_at AS lastConnectedAt,last_error AS lastError,inbound_count AS inboundCount,outbound_count AS outboundCount FROM platform_gateway_status WHERE owner_email=? AND platform=?",
            )
              .bind(user.email, id)
              .first<{
                state: string;
                lastHeartbeatAt: string;
                lastConnectedAt: string;
                lastError: string;
                inboundCount: number;
                outboundCount: number;
              }>()
              .catch(() => null)
          : null;
        const messageStats = row
          ? await runtime.DB.prepare(
              "SELECT COUNT(*) AS inboundCount,SUM(CASE WHEN status IN ('已回复','成功','replied','success') THEN 1 ELSE 0 END) AS outboundCount FROM platform_messages WHERE platform=? AND owner_email=?",
            )
              .bind(id, user.email)
              .first<{ inboundCount: number; outboundCount: number }>()
              .catch(() => null)
          : null;
        const heartbeatAge = gateway?.lastHeartbeatAt
          ? Date.now() - Date.parse(gateway.lastHeartbeatAt)
          : Number.POSITIVE_INFINITY;
        const latestAge = latest?.createdAt
          ? Date.now() - Date.parse(latest.createdAt)
          : Number.POSITIVE_INFINITY;
        const latestStatus = latest?.status || "";
        const latestSuccess =
          Boolean(latestStatus) &&
          latestAge < 5 * 60_000 &&
          ["已回复", "成功", "replied", "success"].includes(latestStatus);
        const gatewayOnline =
          (gateway?.state === "online" && heartbeatAge < 90_000) || latestSuccess;
        const relayUrl = row
          ? `${origin}/api/platform?platform=${id}&connection=${row.connectionKey}&transport=long_connection`
          : "";
        const gatewayConfig =
          row && credentials
            ? {
                id: `${id}-${row.connectionKey.slice(0, 8)}`,
                platform: id,
                appId: credentials.appId,
                appSecret: credentials.appSecret,
                relayUrl,
                relaySecret: credentials.callbackToken,
                defaultModelMode: credentials.defaultModelMode || "auto",
              }
            : null;
        return {
          id,
          name: names[id],
          configured: Boolean(row),
          callbackConfigured: Boolean(row),
          connectionMode: row?.connectionMode || "long_connection",
          defaultModelMode: credentials?.defaultModelMode || "auto",
          callbackUrl: row
            ? `${origin}/api/platform?platform=${id}&connection=${row.connectionKey}`
            : "",
          longConnectionUrl: relayUrl,
          gatewayConfig: gatewayConfig ? JSON.stringify(gatewayConfig) : "",
          gatewaySecret: credentials?.callbackToken || "",
          appIdPreview: maskCredential(credentials?.appId),
          credentialsUpdatedAt: row?.updatedAt || "",
          gatewayOnline,
          gatewayState: gatewayOnline ? "online" : gateway?.state || "offline",
          gatewayLastHeartbeatAt: gateway?.lastHeartbeatAt || "",
          gatewayLastError: gateway?.lastError || "",
          gatewayInboundCount: Math.max(gateway?.inboundCount || 0, messageStats?.inboundCount || 0),
          gatewayOutboundCount: Math.max(gateway?.outboundCount || 0, messageStats?.outboundCount || 0),
          lastMessageAt: latest?.createdAt || "",
          lastMessageStatus: latest?.status || "",
          lastMessageError: latest?.error || "",
          status: row
            ? `我的 API 已保存 · ${new Date(row.updatedAt).toLocaleDateString("zh-CN")}`
            : "尚未填写我的 API",
        };
      }),
    ),
    identities: [],
  });
});

// POST /api/connectors — 平台连接管理
app.post("*", async (c) => {
  const { user } = c.var;
  const denied = await authorizeCapability(runtime.DB, user, "manage_personal_platform");
  if (denied) return denied;
  await schema();
  const body = (await c.req.json()) as {
    action?: string;
    platform?: Platform;
    appId?: string;
    appSecret?: string;
    callbackToken?: string;
    connectionMode?: ConnectionMode;
    defaultModelMode?: string;
  };
  if (!body.platform || !names[body.platform])
    return fail("未知平台", 400);

  if (body.action === "setDefaultModel") {
    const defaultModelMode = body.defaultModelMode || "auto";
    if (
      !["auto", "enterprise"].includes(defaultModelMode) &&
      !/^connection:\d+$/.test(defaultModelMode)
    ) {
      return fail("请选择有效的机器人默认模型。", 400);
    }
    if (defaultModelMode.startsWith("connection:")) {
      const profileId = Number(defaultModelMode.slice("connection:".length));
      const profile = await runtime.DB.prepare(
        "SELECT id FROM user_model_profiles WHERE id=? AND owner_email=?",
      )
        .bind(profileId, user.email)
        .first();
      if (!profile)
        return fail("所选模型连接不存在或不属于当前账号。", 400);
    }
    const row = await runtime.DB.prepare(
      "SELECT encrypted_credentials AS encryptedCredentials FROM user_platform_connections WHERE owner_email=? AND platform=?",
    )
      .bind(user.email, body.platform)
      .first<{ encryptedCredentials: string }>();
    if (!row)
      return fail(`请先完成${names[body.platform]}平台接入。`, 400);
    const credentials = await decrypt(row.encryptedCredentials);
    credentials.defaultModelMode = defaultModelMode;
    await runtime.DB.prepare(
      "UPDATE user_platform_connections SET encrypted_credentials=?,updated_at=? WHERE owner_email=? AND platform=?",
    )
      .bind(
        await encrypt(credentials),
        new Date().toISOString(),
        user.email,
        body.platform,
      )
      .run();
    const syncError = await syncChannelGateway()
      .then(() => "")
      .catch((error) =>
        error instanceof Error ? error.message : String(error),
      );
    return success({
      message: syncError
        ? `${names[body.platform]}机器人默认模型已保存；但通道网关热同步失败，请检查网关服务。同步提示：${syncError}`
        : `${names[body.platform]}机器人默认模型已保存，并已热同步通道网关。`,
    });
  }

  if (body.action === "setConnectionMode") {
    const row = await runtime.DB.prepare(
      "SELECT encrypted_credentials AS encryptedCredentials FROM user_platform_connections WHERE owner_email=? AND platform=?",
    )
      .bind(user.email, body.platform)
      .first<{ encryptedCredentials: string }>();
    if (!row)
      return fail(`请先完成${names[body.platform]}平台接入。`, 400);
    const credentials = await decrypt(row.encryptedCredentials);
    const connectionMode: ConnectionMode =
      body.connectionMode === "callback" ? "callback" : "long_connection";
    credentials.connectionMode = connectionMode;
    await runtime.DB.prepare(
      "UPDATE user_platform_connections SET encrypted_credentials=?,connection_mode=?,updated_at=? WHERE owner_email=? AND platform=?",
    )
      .bind(
        await encrypt(credentials),
        connectionMode,
        new Date().toISOString(),
        user.email,
        body.platform,
      )
      .run();
    return success({
      message:
        connectionMode === "callback"
          ? "已切换为 HTTP 回调。"
          : "已切换为常驻长连接；网关认证成功后才会显示在线。",
    });
  }

  if (body.action === "saveConnection") {
    if (!body.appId?.trim() || !body.appSecret?.trim()) {
      return fail("请完整填写应用标识和应用密钥。", 400);
    }
    const connectionMode: ConnectionMode =
      body.connectionMode === "callback" ? "callback" : "long_connection";
    const callbackToken = body.callbackToken?.trim() || generateGatewaySecret();
    const defaultModelMode = body.defaultModelMode || "auto";
    if (
      !["auto", "enterprise"].includes(defaultModelMode) &&
      !/^connection:\d+$/.test(defaultModelMode)
    ) {
      return fail("请选择有效的机器人默认模型。", 400);
    }
    const encrypted = await encrypt({
      appId: body.appId.trim(),
      appSecret: body.appSecret.trim(),
      callbackToken,
      connectionMode,
      defaultModelMode,
    });
    const now = new Date().toISOString();
    const existing = await runtime.DB.prepare(
      "SELECT connection_key AS connectionKey FROM user_platform_connections WHERE owner_email=? AND platform=?",
    )
      .bind(user.email, body.platform)
      .first<{ connectionKey: string }>();
    const connectionKey =
      existing?.connectionKey || crypto.randomUUID().replaceAll("-", "");
    await runtime.DB.prepare(
      "INSERT INTO user_platform_connections(owner_email,platform,encrypted_credentials,connection_key,connection_mode,created_at,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(owner_email,platform) DO UPDATE SET encrypted_credentials=excluded.encrypted_credentials,connection_mode=excluded.connection_mode,updated_at=excluded.updated_at",
    )
      .bind(
        user.email,
        body.platform,
        encrypted,
        connectionKey,
        connectionMode,
        now,
        now,
      )
      .run();
    return success({
      message: `${names[body.platform]}凭证和通道网关密钥已加密保存。服务器网关会自动同步，稍后刷新状态查看真实链路。`,
      gatewaySecret: callbackToken,
    });
  }

  // 一键自检：前端点「发消息验收」即触发。全程后端自动完成，无需人工去平台发消息。
  // 依次验证：①平台凭证有效 ②长连接网关在线 ③消息→模型→回复整条链路能出回复。
  // 第③步复用真实中继入口（/api/platform ...transport=long_connection），走的就是真实机器人消息的同一段代码，
  // 只是把「用户在飞书发消息」这一物理动作换成后端自发一条自检消息，因此计数也会真实 +1。
  if (body.action === "selfTest") {
    const row = await runtime.DB.prepare(
      "SELECT encrypted_credentials AS encryptedCredentials,connection_key AS connectionKey,connection_mode AS connectionMode FROM user_platform_connections WHERE owner_email=? AND platform=?",
    )
      .bind(user.email, body.platform)
      .first<{ encryptedCredentials: string; connectionKey: string; connectionMode: ConnectionMode }>();
    if (!row)
      return fail(`请先完成${names[body.platform]}平台接入。`, 400);
    const credentials = await decrypt(row.encryptedCredentials);
    const steps: Array<{ label: string; ok: boolean; detail: string }> = [];

    // ① 平台凭证校验
    try {
      const response = await test(body.platform, credentials);
      const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      const ok =
        response.ok &&
        (data.code === undefined || data.code === 0) &&
        (data.errcode === undefined || data.errcode === 0);
      steps.push({ label: "平台凭证校验", ok, detail: ok ? "App ID / App Secret 有效" : "凭证或权限校验未通过，请检查应用凭证。" });
    } catch (error) {
      steps.push({ label: "平台凭证校验", ok: false, detail: error instanceof Error ? error.message : "凭证校验请求失败" });
    }

    if (row.connectionMode === "long_connection") {
      // ② 通道网关在线（心跳新鲜度）
      const gateway = await runtime.DB.prepare(
        "SELECT state,last_heartbeat_at AS lastHeartbeatAt FROM platform_gateway_status WHERE owner_email=? AND platform=?",
      )
        .bind(user.email, body.platform)
        .first<{ state: string; lastHeartbeatAt: string }>()
        .catch(() => null);
      const heartbeatAge = gateway?.lastHeartbeatAt ? Date.now() - Date.parse(gateway.lastHeartbeatAt) : Number.POSITIVE_INFINITY;
      const gatewayOnline = gateway?.state === "online" && heartbeatAge < 90_000;
      steps.push({
        label: "通道网关在线",
        ok: gatewayOnline,
        detail: gatewayOnline ? "长连接网关心跳正常，机器人已连上平台。" : "网关未在线，请确认 channel-gateway 已启动并通过平台鉴权。",
      });

      // ③ 消息 → 模型 → 回复整条链路
      try {
        const origin = requestOrigin(c.req.raw);
        const relayUrl = `${origin}/api/platform?platform=${body.platform}&connection=${row.connectionKey}&transport=long_connection`;
        const probe = `【平台一键自检】请回复“收到”即可。`;
        const relayResponse = await fetch(relayUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${credentials.callbackToken}` },
          body: JSON.stringify({
            eventId: `selftest-${crypto.randomUUID()}`,
            platformUserId: `selftest-${user.email}`,
            text: probe,
            modelMode: credentials.defaultModelMode || "auto",
          }),
        });
        const relayData = (await relayResponse.json().catch(() => ({}))) as { ok?: boolean; reply?: string };
        const replyText = String(relayData.reply || "").trim();
        const ok = relayResponse.ok && Boolean(relayData.ok) && replyText.length > 0;
        steps.push({
          label: "消息回复链路",
          ok,
          detail: ok ? `机器人已生成回复：${replyText.slice(0, 60)}${replyText.length > 60 ? "…" : ""}` : "消息进入系统后未能生成回复，请检查机器人默认模型与 API Key。",
        });
      } catch (error) {
        steps.push({ label: "消息回复链路", ok: false, detail: error instanceof Error ? error.message : "回复链路请求失败" });
      }
    }

    const passed = steps.every((step) => step.ok);
    const summary = steps.map((step) => `${step.ok ? "✅" : "❌"} ${step.label}：${step.detail}`).join("\n");
    const firstFail = steps.find((step) => !step.ok);
    return success({
      passed,
      steps,
      summary,
      message: passed
        ? `${names[body.platform]}机器人一键自检通过 ✅ 凭证有效 · 网关在线 · 回复链路正常。`
        : `${names[body.platform]}机器人一键自检未通过 ❌ ${firstFail ? `${firstFail.label}：${firstFail.detail}` : ""}`,
    });
  }

  const row = await runtime.DB.prepare(
    "SELECT encrypted_credentials AS encryptedCredentials FROM user_platform_connections WHERE owner_email=? AND platform=?",
  )
    .bind(user.email, body.platform)
    .first<{ encryptedCredentials: string }>();
  if (!row)
    return fail(`请先填写并保存自己的${names[body.platform]} API。`, 400);
  const response = await test(
    body.platform,
    await decrypt(row.encryptedCredentials),
  );
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  const failed =
    !response.ok ||
    (data.code !== undefined && data.code !== 0) ||
    (data.errcode !== undefined && data.errcode !== 0);
  if (failed)
    return fail(`${names[body.platform]}凭证验证失败，请检查凭证与权限。`, 502);
  return success({
    message:
      body.platform === "wecom"
        ? "企业微信字段已保存；AI 机器人凭证必须由常驻网关完成 WebSocket 真实鉴权。"
        : `${names[body.platform]}API 凭证有效；是否在线请以网关状态为准。`,
  });
});

export const GET = (request: Request) => app.fetch(request);
export const POST = (request: Request) => app.fetch(request);