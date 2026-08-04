import { createApp, success, fail } from "../../_app";
import { env } from "cloudflare:workers";
import { decryptJson } from "../../_crypto";

type Platform = "feishu" | "dingtalk" | "wecom";
type RuntimeEnv = {
  DB: D1Database;
  PLATFORM_CREDENTIALS_KEY?: string;
  HAIXIN_GATEWAY_ADMIN_SECRET?: string;
};
type Credentials = {
  appId: string;
  appSecret: string;
  callbackToken: string;
  connectionMode?: "callback" | "long_connection";
  defaultModelMode?: string;
};

const runtime = env as unknown as RuntimeEnv;

async function decrypt(value: string): Promise<Credentials | null> {
  return decryptJson<Credentials>(value);
}

function isAuthorized(request: Request) {
  const secret = runtime.HAIXIN_GATEWAY_ADMIN_SECRET?.trim();
  return Boolean(secret) && request.headers.get("authorization") === `Bearer ${secret}`;
}

const app = createApp();

// GET /api/gateway/accounts — 获取长连接网关账号列表
app.get("*", async (c) => {
  if (!isAuthorized(c.req.raw)) {
    return fail("unauthorized", 401);
  }

  await runtime.DB.prepare(
    "CREATE TABLE IF NOT EXISTS user_platform_connections (id INTEGER PRIMARY KEY AUTOINCREMENT,owner_email TEXT NOT NULL,platform TEXT NOT NULL,encrypted_credentials TEXT NOT NULL,connection_key TEXT NOT NULL UNIQUE,connection_mode TEXT NOT NULL DEFAULT 'callback',created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(owner_email,platform))",
  ).run();

  const rows = await runtime.DB.prepare(
    "SELECT owner_email AS ownerEmail,platform,connection_key AS connectionKey,connection_mode AS connectionMode,encrypted_credentials AS encryptedCredentials FROM user_platform_connections WHERE connection_mode='long_connection'",
  ).all<{
    ownerEmail: string;
    platform: Platform;
    connectionKey: string;
    connectionMode: string;
    encryptedCredentials: string;
  }>();

  const accounts = [];
  for (const row of rows.results || []) {
    if (!["feishu", "dingtalk", "wecom"].includes(row.platform)) continue;
    const credentials = await decrypt(row.encryptedCredentials);
    if (!credentials?.appId || !credentials.appSecret || !credentials.callbackToken)
      continue;
    accounts.push({
      id: `${row.platform}-${row.connectionKey.slice(0, 8)}`,
      platform: row.platform,
      ownerEmail: row.ownerEmail,
      appId: credentials.appId,
      appSecret: credentials.appSecret,
      relayUrl: `http://app:3000/api/platform?platform=${row.platform}&connection=${row.connectionKey}&transport=long_connection`,
      relaySecret: credentials.callbackToken,
      defaultModelMode: credentials.defaultModelMode || "auto",
    });
  }

  return success({ accounts, updatedAt: new Date().toISOString() });
});

export const GET = (request: Request) => app.fetch(request);