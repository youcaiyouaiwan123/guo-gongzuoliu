import { createApp, success, fail } from "../../_app";
import { env } from "cloudflare:workers";
import { ensureColumn } from "../../_schema";

// 邮件发送队列端点（网关消费）。
//
// 注册验证码写进 mail_outbox（见 api/auth/register），但 worker（wrangler dev --local）里
// 没有可靠的出站 SMTP 能力，所以由常驻的 channel-gateway 每隔几秒来这里：
//   GET  取 status='待发送' 的邮件；
//   POST 回报每封的发送结果（成功→已发送，失败→累加 attempts，到上限→发送失败）。
// 鉴权照搬 api/gateway/tick 那套 Bearer + HAIXIN_GATEWAY_ADMIN_SECRET。

export const runtime = "edge";

type RuntimeEnv = {
  DB: D1Database;
  HAIXIN_GATEWAY_ADMIN_SECRET?: string;
};

const runtimeEnv = env as unknown as RuntimeEnv;

// 单封邮件最多重试这么多次，超过就落「发送失败」不再取走，避免坏地址无限占用队列。
const MAX_ATTEMPTS = 5;
// 一次最多取走这么多，避免网关一轮打满 SMTP。
const BATCH = 20;

function isAuthorized(request: Request) {
  const secret = runtimeEnv.HAIXIN_GATEWAY_ADMIN_SECRET?.trim();
  return Boolean(secret) && request.headers.get("authorization") === `Bearer ${secret}`;
}

// mail_outbox 早在 register 路由建表（id/email/subject/content/status/created_at）；
// 这里补齐发送态列。attempts 用于重试计数，error 存最后一次失败原因供后台展示。
async function ensureMailSchema(db: D1Database) {
  await db.prepare("CREATE TABLE IF NOT EXISTS mail_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT,email TEXT NOT NULL,subject TEXT NOT NULL,content TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL)").run();
  await ensureColumn(db, "mail_outbox", "sent_at", "TEXT");
  await ensureColumn(db, "mail_outbox", "error", "TEXT NOT NULL DEFAULT ''");
  await ensureColumn(db, "mail_outbox", "attempts", "INTEGER NOT NULL DEFAULT 0");
}

const app = createApp();

// GET /api/gateway/mail — 网关拉取待发送邮件（含正文，用于实际投递）
app.get("*", async (c) => {
  if (!isAuthorized(c.req.raw)) return fail("unauthorized", 401);
  const db = runtimeEnv.DB;
  await ensureMailSchema(db);
  const rows = await db.prepare("SELECT id,email,subject,content FROM mail_outbox WHERE status='待发送' AND attempts<? ORDER BY id LIMIT ?")
    .bind(MAX_ATTEMPTS, BATCH).all<{ id: number; email: string; subject: string; content: string }>();
  return success({ pending: rows.results || [] });
});

// POST /api/gateway/mail — 网关回报发送结果 {results:[{id,ok,error}]}
app.post("*", async (c) => {
  if (!isAuthorized(c.req.raw)) return fail("unauthorized", 401);
  const db = runtimeEnv.DB;
  await ensureMailSchema(db);
  const body = await c.req.json().catch(() => null) as { results?: Array<{ id?: number; ok?: boolean; error?: string }> } | null;
  const results = Array.isArray(body?.results) ? body!.results : [];
  const now = new Date().toISOString();
  let updated = 0;
  for (const r of results) {
    const id = Number(r?.id || 0);
    if (!(id > 0)) continue;
    if (r.ok) {
      await db.prepare("UPDATE mail_outbox SET status='已发送',sent_at=?,error='' WHERE id=?").bind(now, id).run();
    } else {
      // 累加尝试次数；到上限标记「发送失败」，否则留在「待发送」等下一轮重试。
      await db.prepare("UPDATE mail_outbox SET attempts=attempts+1,error=?,status=CASE WHEN attempts+1>=? THEN '发送失败' ELSE '待发送' END WHERE id=?")
        .bind(String(r.error || "发送失败").slice(0, 300), MAX_ATTEMPTS, id).run();
    }
    updated += 1;
  }
  return success({ ok: true, updated });
});

export const GET = (request: Request) => app.fetch(request);
export const POST = (request: Request) => app.fetch(request);
