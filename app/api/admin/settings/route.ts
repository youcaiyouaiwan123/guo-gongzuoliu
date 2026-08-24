import { env } from "cloudflare:workers";
import { createApp, admin, success, fail, ensureColumn } from "../../_app";

type RuntimeEnv = { DB: D1Database; MAIL_HOST?: string; MAIL_SENDER?: string };
const runtimeEnv = env as unknown as RuntimeEnv;
const SMTP_KEYS = ["smtpHost", "smtpPort", "smtpAccount", "smtpSender", "smtpCredential"] as const;

async function ensureTables(db: D1Database) {
  await db.prepare("CREATE TABLE IF NOT EXISTS system_settings (key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at TEXT NOT NULL)").run();
  await db.prepare("CREATE TABLE IF NOT EXISTS audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT,actor TEXT NOT NULL,action TEXT NOT NULL,resource TEXT NOT NULL,result TEXT NOT NULL,detail TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL)").run();
  await db.prepare("CREATE TABLE IF NOT EXISTS mail_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT,email TEXT NOT NULL,subject TEXT NOT NULL,content TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL)").run();
  await ensureColumn(db, "mail_outbox", "sent_at", "TEXT");
  await ensureColumn(db, "mail_outbox", "error", "TEXT NOT NULL DEFAULT ''");
  await ensureColumn(db, "mail_outbox", "attempts", "INTEGER NOT NULL DEFAULT 0");
}

const app = createApp();
app.use("*", admin());

// GET /api/admin/settings — 获取系统设置 + 发信状态 + 邮件发送队列
app.get("*", async (c) => {
  const db = runtimeEnv.DB;
  await ensureTables(db);
  const rows = await db.prepare("SELECT key,value FROM system_settings WHERE key IN ('smtpHost','smtpPort','smtpAccount','smtpSender','smtpCredential')").all<{ key: string; value: string }>();
  const settings = Object.fromEntries((rows.results || []).map(row => [row.key, row.key === "smtpCredential" ? (row.value ? "已保存" : "") : row.value]));
  // 真正的发信凭据来自服务器环境变量（MAIL_*），由网关消费队列发出；这里只回状态，绝不回密钥。
  const mail = { active: Boolean(runtimeEnv.MAIL_HOST?.trim()), host: runtimeEnv.MAIL_HOST?.trim() || "", sender: runtimeEnv.MAIL_SENDER?.trim() || "" };
  const outboxRows = await db.prepare("SELECT id,email,subject,status,error,attempts,created_at AS createdAt,sent_at AS sentAt FROM mail_outbox ORDER BY id DESC LIMIT 30")
    .all<{ id: number; email: string; subject: string; status: string; error: string; attempts: number; createdAt: string; sentAt: string }>();
  return success({ settings, mail, outbox: outboxRows.results || [] });
});

// POST /api/admin/settings — 保存 SMTP 设置 / 重试失败邮件
app.post("*", async (c) => {
  const { user } = c.var;
  const db = runtimeEnv.DB;
  await ensureTables(db);
  const body = await c.req.json() as Record<string, string>;
  const now = new Date().toISOString();

  // 重试：把一封「发送失败」的邮件重新放回队列，清零 attempts，等网关下一轮取走。
  if (body.action === "retryMail") {
    const id = Number(body.id || 0);
    if (!(id > 0)) return fail("缺少要重试的邮件 ID。", 400);
    const result = await db.prepare("UPDATE mail_outbox SET status='待发送',attempts=0,error='' WHERE id=? AND status='发送失败'").bind(id).run();
    if (!result.meta.changes) return fail("该邮件不存在或不是失败状态。", 404);
    await db.prepare("INSERT INTO audit_logs(actor,action,resource,result,detail,created_at) VALUES(?,?,?,?,?,?)")
      .bind(user.email, "重试发送邮件", "系统邮件", "成功", `邮件 #${id} 已重新入队`, now).run();
    return success({ ok: true, message: "邮件已重新入队，稍后自动重发。" });
  }

  for (const key of SMTP_KEYS) {
    const value = String(body[key] || "").trim();
    if (key === "smtpCredential" && !value) continue;
    await db.prepare("INSERT INTO system_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at")
      .bind(key, value, now).run();
  }
  await db.prepare("INSERT INTO audit_logs(actor,action,resource,result,detail,created_at) VALUES(?,?,?,?,?,?)")
    .bind(user.email, "保存 SMTP 设置", "系统邮件", "成功", "SMTP 服务器、端口、账户、发送者邮箱已保存", now).run();
  return success({ ok: true, message: "SMTP 设置已保存并生效。" });
});

export const GET = (request: Request) => app.fetch(request);
export const POST = (request: Request) => app.fetch(request);