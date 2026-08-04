// 登录验证。
import { createApp, success, fail } from "../../_app";
import { env } from "cloudflare:workers";
import { createPasswordRecord, verifyPassword } from "../../_password";
import { LOGIN_RULE, consumeAttempt, resetAttempts, throttledResponse } from "../../_throttle";
import { ensureAuthTables } from "../../_auth";

export const runtime = "edge";

const runtimeEnv = env as unknown as { DB: D1Database; DEFAULT_ADMIN_USERNAME?: string; DEFAULT_ADMIN_PASSWORD?: string };

async function ensureDefaultAdminUser(db: D1Database) {
  const username = runtimeEnv.DEFAULT_ADMIN_USERNAME?.trim().toLowerCase() || "";
  const password = runtimeEnv.DEFAULT_ADMIN_PASSWORD || "";
  if (!username || !password) throw new Error("管理员初始化凭据尚未配置。");

  const existing = await db.prepare("SELECT email FROM user_security WHERE email=?").bind(username).first<{ email: string }>();
  if (existing) return;
  const existingRole = await db.prepare("SELECT role FROM user_roles WHERE email=?").bind(username).first<{ role: string }>();
  if (existingRole && existingRole.role !== "管理员") throw new Error("管理员初始化账号已被普通账号占用。");

  const now = new Date().toISOString();
  const passwordRecord = await createPasswordRecord(password);
  await db.batch([
    db.prepare("INSERT INTO frontend_users(email,display_name,status,email_verified_at,created_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(email) DO NOTHING")
      .bind(username, username, "启用", now, now, now),
    db.prepare("INSERT INTO user_roles(email,role,created_at,updated_at) VALUES(?,?,?,?) ON CONFLICT(email) DO NOTHING")
      .bind(username, "管理员", now, now),
    db.prepare("INSERT INTO user_security(email,password_hash,password_salt,updated_at) VALUES(?,?,?,?)")
      .bind(username, passwordRecord.passwordHash, passwordRecord.passwordSalt, now),
  ]);
}

const app = createApp();

// POST /api/auth/login — 登录验证
app.post("*", async (c) => {
  const db = runtimeEnv.DB;
  await ensureAuthTables(db);
  await db.prepare("CREATE TABLE IF NOT EXISTS user_security (email TEXT PRIMARY KEY,password_hash TEXT NOT NULL,password_salt TEXT NOT NULL,updated_at TEXT NOT NULL)").run();
  await ensureDefaultAdminUser(db);

  const body = await c.req.json() as { email?: string; password?: string; adminOnly?: boolean };
  const email = body.email?.trim().toLowerCase();
  if (!email || !body.password) return fail("请输入账号和密码。", 400);

  const throttle = await consumeAttempt(db, LOGIN_RULE, email);
  if (!throttle.allowed) return throttledResponse(throttle, "登录尝试");

  const user = await db.prepare("SELECT status,email_verified_at AS emailVerifiedAt FROM frontend_users WHERE email=?").bind(email).first<{ status: string; emailVerifiedAt: string }>();
  if (!user?.emailVerifiedAt) return fail("请先完成邮箱验证注册。", 403);
  if (user.status === "禁用") return fail("账号已被禁用，请联系管理员。", 403);

  const security = await db.prepare("SELECT password_hash AS passwordHash,password_salt AS passwordSalt FROM user_security WHERE email=?").bind(email).first<{ passwordHash: string; passwordSalt: string }>();
  const verification = security ? await verifyPassword(body.password, security) : null;
  if (!security || !verification?.valid) return fail("邮箱或密码不正确。", 401);
  await resetAttempts(db, LOGIN_RULE, email);
  if (verification.needsUpgrade) {
    const upgraded = await createPasswordRecord(body.password);
    await db.prepare("UPDATE user_security SET password_hash=?,password_salt=?,updated_at=? WHERE email=? AND password_hash=? AND password_salt=?")
      .bind(upgraded.passwordHash, upgraded.passwordSalt, new Date().toISOString(), email, security.passwordHash, security.passwordSalt).run();
  }

  const role = await db.prepare("SELECT role FROM user_roles WHERE email=?").bind(email).first<{ role: string }>();
  if (body.adminOnly && role?.role !== "管理员") return fail("后台仅管理员可登录。", 403);

  const token = crypto.randomUUID();
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  await db.prepare("INSERT INTO login_sessions(token,email,created_at,expires_at) VALUES(?,?,?,?)").bind(token, email, now, expires).run();
  await db.prepare("UPDATE frontend_users SET last_login_at=?,updated_at=? WHERE email=?").bind(now, now, email).run();

  const forwardedProto = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  const secure = forwardedProto === "https" || new URL(c.req.url).protocol === "https:";
  return c.json(
    { ok: true, role: role?.role === "管理员" ? "管理员" : "普通员工", redirect: "/" },
    200,
    { "Set-Cookie": `haixin_session=${token}; Path=/;${secure ? " Secure;" : ""} HttpOnly; SameSite=Lax; Max-Age=604800` },
  );
});

export const POST = (request: Request) => app.fetch(request);