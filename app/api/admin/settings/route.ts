import { env } from "cloudflare:workers";
import { createApp, admin, success, fail } from "../../_app";

type RuntimeEnv = { DB: D1Database };
const runtimeEnv = env as unknown as RuntimeEnv;
const SMTP_KEYS = ["smtpHost", "smtpPort", "smtpAccount", "smtpSender", "smtpCredential"] as const;

async function ensureTables(db: D1Database) {
  await db.prepare("CREATE TABLE IF NOT EXISTS system_settings (key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at TEXT NOT NULL)").run();
  await db.prepare("CREATE TABLE IF NOT EXISTS audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT,actor TEXT NOT NULL,action TEXT NOT NULL,resource TEXT NOT NULL,result TEXT NOT NULL,detail TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL)").run();
}

const app = createApp();
app.use("*", admin());

// GET /api/admin/settings — 获取系统设置
app.get("*", async (c) => {
  const { user } = c.var;
  const db = runtimeEnv.DB;
  await ensureTables(db);
  const rows = await db.prepare("SELECT key,value FROM system_settings WHERE key IN ('smtpHost','smtpPort','smtpAccount','smtpSender','smtpCredential')").all<{ key: string; value: string }>();
  const settings = Object.fromEntries((rows.results || []).map(row => [row.key, row.key === "smtpCredential" ? (row.value ? "已保存" : "") : row.value]));
  return success({ settings });
});

// POST /api/admin/settings — 保存 SMTP 设置
app.post("*", async (c) => {
  const { user } = c.var;
  const db = runtimeEnv.DB;
  await ensureTables(db);
  const body = await c.req.json() as Record<string, string>;
  const now = new Date().toISOString();
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