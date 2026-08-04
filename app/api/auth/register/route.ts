// 注册：邮箱验证码注册。
import { createApp, success, fail } from "../../_app";
import { env } from "cloudflare:workers";
import { createPasswordRecord } from "../../_password";
import { REGISTER_CODE_RULE, REGISTER_VERIFY_RULE, consumeAttempt, resetAttempts, throttledResponse } from "../../_throttle";

export const runtime = "edge";

const runtimeEnv = env as unknown as { DB: D1Database };

async function sha256(value: string) {
  const data = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash)).map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function ensureTables(db: D1Database) {
  await db.prepare("CREATE TABLE IF NOT EXISTS frontend_users (email TEXT PRIMARY KEY,display_name TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT '启用',email_verified_at TEXT DEFAULT '',last_login_at TEXT DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL)").run();
  await db.prepare("CREATE TABLE IF NOT EXISTS user_security (email TEXT PRIMARY KEY,password_hash TEXT NOT NULL,password_salt TEXT NOT NULL,updated_at TEXT NOT NULL)").run();
  await db.prepare("CREATE TABLE IF NOT EXISTS user_roles (email TEXT PRIMARY KEY,role TEXT NOT NULL DEFAULT '普通员工',created_at TEXT NOT NULL,updated_at TEXT NOT NULL)").run();
  await db.prepare("CREATE TABLE IF NOT EXISTS email_verification_codes (email TEXT PRIMARY KEY,code_hash TEXT NOT NULL,expires_at TEXT NOT NULL,created_at TEXT NOT NULL)").run();
  await db.prepare("CREATE TABLE IF NOT EXISTS mail_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT,email TEXT NOT NULL,subject TEXT NOT NULL,content TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL)").run();
  await db.prepare("CREATE TABLE IF NOT EXISTS system_settings (key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at TEXT NOT NULL)").run();
}

const app = createApp();

// POST /api/auth/register — 注册：发送验证码 / 校验验证码并创建账号
app.post("*", async (c) => {
  const db = runtimeEnv.DB;
  await ensureTables(db);
  const body = await c.req.json() as { action?: string; email?: string; password?: string; code?: string; displayName?: string };
  const email = body.email?.trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail("请输入有效邮箱。", 400);
  const now = new Date().toISOString();

  if (body.action === "requestCode") {
    const throttle = await consumeAttempt(db, REGISTER_CODE_RULE, email);
    if (!throttle.allowed) return throttledResponse(throttle, "验证码获取");

    const existing = await db.prepare("SELECT email FROM user_security WHERE email=?").bind(email).first<{ email: string }>();
    if (existing) return fail("该邮箱已注册，请直接登录或使用密码找回功能。", 409);

    const smtp = await db.prepare("SELECT value FROM system_settings WHERE key='smtpHost'").first<{ value: string }>();
    if (!smtp?.value?.trim()) return fail("邮件服务尚未配置，请联系管理员。", 503);

    const random = new Uint32Array(1);
    crypto.getRandomValues(random);
    const code = String(100000 + random[0] % 900000);
    const codeHash = await sha256(`${email}:${code}`);
    const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    await db.prepare("INSERT INTO email_verification_codes(email,code_hash,expires_at,created_at) VALUES(?,?,?,?) ON CONFLICT(email) DO UPDATE SET code_hash=excluded.code_hash,expires_at=excluded.expires_at,created_at=excluded.created_at")
      .bind(email, codeHash, expires, now).run();
    await db.prepare("INSERT INTO mail_outbox(email,subject,content,status,created_at) VALUES(?,?,?,?,?)")
      .bind(email, "海芯博创账号验证码", `您的验证码是：${code}，10 分钟内有效。`, "待发送", now).run();
    return success({ message: "验证码已进入邮件发送队列。" });
  }

  if (body.action === "verify") {
    if (!body.password || body.password.length < 8) return fail("密码至少需要 8 位。", 400);
    const throttle = await consumeAttempt(db, REGISTER_VERIFY_RULE, email);
    if (!throttle.allowed) return throttledResponse(throttle, "验证码校验");
    const existing = await db.prepare("SELECT email FROM user_security WHERE email=?").bind(email).first<{ email: string }>();
    if (existing) return fail("该邮箱已注册，请直接登录或使用密码找回功能。", 409);
    const row = await db.prepare("SELECT code_hash AS codeHash,expires_at AS expiresAt FROM email_verification_codes WHERE email=?").bind(email).first<{ codeHash: string; expiresAt: string }>();
    if (!row || row.expiresAt < now) return fail("验证码已过期，请重新获取。", 400);
    const inputHash = await sha256(`${email}:${String(body.code || "").trim()}`);
    if (inputHash !== row.codeHash) return fail("验证码不正确。", 400);
    const passwordRecord = await createPasswordRecord(body.password);
    const count = await db.prepare("SELECT COUNT(*) AS total FROM user_roles").first<{ total: number }>();
    const role = Number(count?.total || 0) === 0 ? "管理员" : "普通员工";
    try {
      await db.batch([
        db.prepare("INSERT INTO user_security(email,password_hash,password_salt,updated_at) VALUES(?,?,?,?)").bind(email, passwordRecord.passwordHash, passwordRecord.passwordSalt, now),
        db.prepare("INSERT INTO frontend_users(email,display_name,status,email_verified_at,created_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(email) DO UPDATE SET display_name=excluded.display_name,status='启用',email_verified_at=excluded.email_verified_at,updated_at=excluded.updated_at")
          .bind(email, body.displayName?.trim() || email.split("@")[0], "启用", now, now, now),
        db.prepare("INSERT OR IGNORE INTO user_roles(email,role,created_at,updated_at) VALUES(?,?,?,?)").bind(email, role, now, now),
        db.prepare("DELETE FROM email_verification_codes WHERE email=?").bind(email),
      ]);
    } catch {
      return fail("该邮箱已注册，请直接登录或使用密码找回功能。", 409);
    }
    await resetAttempts(db, REGISTER_VERIFY_RULE, email);
    await resetAttempts(db, REGISTER_CODE_RULE, email);
    return success({ message: "注册成功，请登录。", role });
  }

  return fail("未知操作。", 400);
});

export const POST = (request: Request) => app.fetch(request);