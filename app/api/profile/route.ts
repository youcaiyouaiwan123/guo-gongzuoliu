// 个人中心：个人信息与密码修改。
import { env } from "cloudflare:workers";
import { createApp, auth, success, fail } from "../_app";
import { createPasswordRecord, verifyPassword } from "../_password";

type RuntimeEnv = { DB: D1Database };
const runtime = env as unknown as RuntimeEnv;

async function schema() {
  await runtime.DB.batch([
    runtime.DB.prepare("CREATE TABLE IF NOT EXISTS user_security (email TEXT PRIMARY KEY,password_hash TEXT NOT NULL,password_salt TEXT NOT NULL,updated_at TEXT NOT NULL)"),
    runtime.DB.prepare("CREATE TABLE IF NOT EXISTS audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT,actor TEXT NOT NULL,action TEXT NOT NULL,resource TEXT NOT NULL,result TEXT NOT NULL,detail TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL)"),
  ]);
}

async function audit(actor: string, action: string, resource: string, result: string, detail = "") {
  await runtime.DB.prepare("INSERT INTO audit_logs(actor,action,resource,result,detail,created_at) VALUES(?,?,?,?,?,?)")
    .bind(actor, action, resource, result, detail, new Date().toISOString()).run();
}

const app = createApp();
app.use("*", auth());

// GET /api/profile — 获取个人信息
app.get("*", async (c) => {
  await schema();
  const { user } = c.var;
  const row = await runtime.DB.prepare("SELECT updated_at AS updatedAt FROM user_security WHERE email=?")
    .bind(user.email).first<{ updatedAt: string }>();
  return success({
    email: user.email,
    name: user.email.split("@")[0],
    role: user.role,
    businessRole: user.businessRole,
    passwordConfigured: Boolean(row),
    passwordUpdatedAt: row?.updatedAt || "",
  });
});

// POST /api/profile — 修改密码
app.post("*", async (c) => {
  await schema();
  const { user } = c.var;
  const body = await c.req.json() as Record<string, string>;
  if (body.action !== "changePassword") return fail("不支持的操作。");
  const newPassword = String(body.newPassword || "");
  const confirmPassword = String(body.confirmPassword || "");
  const currentPassword = String(body.currentPassword || "");
  if (newPassword.length < 8) return fail("新密码至少 8 位。");
  if (confirmPassword && confirmPassword !== newPassword) return fail("两次输入的新密码不一致。");

  const old = await runtime.DB.prepare("SELECT password_hash AS passwordHash,password_salt AS passwordSalt FROM user_security WHERE email=?")
    .bind(user.email).first<{ passwordHash: string; passwordSalt: string }>();
  if (old) {
    const verification = await verifyPassword(currentPassword, old);
    if (!verification.valid) {
      await audit(user.email, "修改密码", "个人中心", "失败", "当前密码校验失败");
      return fail("当前密码不正确。", 403);
    }
  }

  const passwordRecord = await createPasswordRecord(newPassword);
  const now = new Date().toISOString();
  await runtime.DB.batch([
    runtime.DB.prepare("INSERT INTO user_security(email,password_hash,password_salt,updated_at) VALUES(?,?,?,?) ON CONFLICT(email) DO UPDATE SET password_hash=excluded.password_hash,password_salt=excluded.password_salt,updated_at=excluded.updated_at")
      .bind(user.email, passwordRecord.passwordHash, passwordRecord.passwordSalt, now),
    runtime.DB.prepare("DELETE FROM login_sessions WHERE email=?").bind(user.email),
    runtime.DB.prepare("INSERT INTO audit_logs(actor,action,resource,result,detail,created_at) VALUES(?,?,?,?,?,?)")
      .bind(user.email, "修改密码", "个人中心", "成功", old ? "更新登录备用密码并撤销全部会话" : "首次设置登录备用密码并撤销全部会话", now),
  ]);
  return success(
    { ok: true, message: "密码已更新，请重新登录。" },
    { status: 201, headers: { "Set-Cookie": "haixin_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT" } }
  );
});

export const GET = (request: Request) => app.fetch(request);
export const POST = (request: Request) => app.fetch(request);