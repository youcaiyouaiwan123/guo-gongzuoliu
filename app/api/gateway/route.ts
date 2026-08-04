import { createApp, success, fail } from "../_app";
import { env } from "cloudflare:workers";
import { decryptJson } from "../_crypto";

type RuntimeEnv = { DB: D1Database; PLATFORM_CREDENTIALS_KEY?: string };
type Platform = "feishu" | "dingtalk" | "wecom";
const runtime = env as unknown as RuntimeEnv;

async function credentials(connectionKey: string, platform: Platform) {
  if (!runtime.PLATFORM_CREDENTIALS_KEY) return null;
  const row = await runtime.DB.prepare(
    "SELECT owner_email AS ownerEmail,encrypted_credentials AS encryptedCredentials FROM user_platform_connections WHERE connection_key=? AND platform=?",
  )
    .bind(connectionKey, platform)
    .first<{ ownerEmail: string; encryptedCredentials: string }>();
  if (!row) return null;
  const value = await decryptJson<{ callbackToken: string }>(row.encryptedCredentials);
  if (!value) return null;
  return { ownerEmail: row.ownerEmail, value };
}

async function saveGatewayStatus(
  ownerEmail: string,
  platform: Platform,
  instanceId: string,
  state: string,
  heartbeatAt: string,
  connectedAt: string,
  error: string,
  inboundCount: number,
  outboundCount: number,
) {
  await runtime.DB.prepare(
    "UPDATE platform_gateway_status SET instance_id=?,state=?,last_heartbeat_at=?,last_connected_at=CASE WHEN ?='' THEN last_connected_at ELSE ? END,last_error=?,inbound_count=?,outbound_count=?,updated_at=? WHERE owner_email=? AND platform=?",
  )
    .bind(instanceId, state, heartbeatAt, connectedAt, connectedAt, error, inboundCount, outboundCount, heartbeatAt, ownerEmail, platform)
    .run();
  const exists = await runtime.DB.prepare("SELECT owner_email FROM platform_gateway_status WHERE owner_email=? AND platform=?")
    .bind(ownerEmail, platform)
    .first();
  if (!exists) {
    await runtime.DB.prepare(
      "INSERT INTO platform_gateway_status(owner_email,platform,instance_id,state,last_heartbeat_at,last_connected_at,last_error,inbound_count,outbound_count,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(ownerEmail, platform, instanceId, state, heartbeatAt, connectedAt, error, inboundCount, outboundCount, heartbeatAt)
      .run();
  }
}

const app = createApp();

// POST /api/gateway — 平台网关心跳/状态上报
app.post("*", async (c) => {
  const url = new URL(c.req.url);
  const platform = url.searchParams.get("platform") as Platform | null;
  const connectionKey = url.searchParams.get("connection") || "";
  if (!platform || !["feishu", "dingtalk", "wecom"].includes(platform)) return fail("unknown platform", 400);
  const personal = await credentials(connectionKey, platform);
  if (!personal) return fail("connection not found", 404);
  if ((c.req.header("Authorization") || "") !== `Bearer ${personal.value.callbackToken}`) return fail("invalid gateway secret", 401);
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const now = new Date().toISOString();
  await runtime.DB.prepare(
    "CREATE TABLE IF NOT EXISTS platform_gateway_status (owner_email TEXT NOT NULL,platform TEXT NOT NULL,instance_id TEXT NOT NULL DEFAULT '',state TEXT NOT NULL DEFAULT 'offline',last_heartbeat_at TEXT NOT NULL DEFAULT '',last_connected_at TEXT NOT NULL DEFAULT '',last_error TEXT NOT NULL DEFAULT '',inbound_count INTEGER NOT NULL DEFAULT 0,outbound_count INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL,PRIMARY KEY(owner_email,platform))",
  ).run();
  const state = String(body.state || "online");
  const connectedAt = state === "online" ? now : String(body.lastConnectedAt || "");
  await saveGatewayStatus(
    personal.ownerEmail,
    platform,
    String(body.instanceId || ""),
    state,
    now,
    connectedAt,
    String(body.error || "").slice(0, 1000),
    Math.max(0, Number(body.inboundCount || 0)),
    Math.max(0, Number(body.outboundCount || 0)),
  );
  return success({ serverTime: now });
});

export const POST = (request: Request) => app.fetch(request);