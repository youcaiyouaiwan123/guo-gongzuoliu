// 用户管理：仅管理员可用。
import { createApp, auth, admin, success, fail, ADMIN_ROLE, STAFF_ROLE } from "../_app";
import { ensureAuthTables, ENABLED_STATUS, DISABLED_STATUS } from "../_auth";
import { env } from "cloudflare:workers";

export const runtime = "edge";

type RuntimeEnv = { DB: D1Database };
const runEnv = env as unknown as RuntimeEnv;

function normalizeRole(role?: string) {
  const text = String(role || "").trim().toLowerCase();
  if (text.includes("管理员") || text.includes("admin") || text.includes("绠") || text.includes("鐞")) return ADMIN_ROLE;
  return STAFF_ROLE;
}

function normalizeStatus(status?: string) {
  const text = String(status || "").trim();
  if (text.includes("禁") || text.includes("绂")) return DISABLED_STATUS;
  return ENABLED_STATUS;
}

async function ensureAudit(db: D1Database) {
  await db.prepare("CREATE TABLE IF NOT EXISTS audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT,actor TEXT NOT NULL,action TEXT NOT NULL,resource TEXT NOT NULL,result TEXT NOT NULL,detail TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL)").run();
}

const app = createApp();
app.use("*", admin());

// GET /api/users — 获取用户列表
app.get("*", async (c) => {
  const { user } = c.var;
  const db = runEnv.DB;
  await ensureAuthTables(db);
  const result = await db.prepare(`
    SELECT
      r.email AS email,
      r.role AS role,
      COALESCE(f.display_name,'') AS displayName,
      COALESCE(f.status,'启用') AS status,
      COALESCE(f.email_verified_at,'') AS emailVerifiedAt,
      COALESCE(f.last_login_at,'') AS lastLoginAt,
      r.created_at AS createdAt,
      r.updated_at AS updatedAt
    FROM user_roles r
    LEFT JOIN frontend_users f ON f.email=r.email
    ORDER BY r.created_at DESC
  `).all();
  return success({ currentUser: user, users: result.results || [] });
});

// POST /api/users — 创建/更新用户
app.post("*", async (c) => {
  const { user } = c.var;
  const db = runEnv.DB;
  await ensureAuthTables(db);
  await ensureAudit(db);

  const body = await c.req.json() as { email?: string; role?: string; displayName?: string; status?: string };
  const email = body.email?.trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail("请输入有效邮箱。");

  const role = normalizeRole(body.role);
  const displayName = body.displayName?.trim() || email.split("@")[0] || email;
  const status = normalizeStatus(body.status);
  const owner = await db.prepare("SELECT email FROM user_roles ORDER BY CASE WHEN role='管理员' THEN 0 ELSE 1 END,created_at,email LIMIT 1").first<{ email: string }>();
  if (email === owner?.email && role !== ADMIN_ROLE) return fail("老板/首个管理员账号拥有最高权限，不能降级。", 409);

  const now = new Date().toISOString();
  await db.prepare("INSERT INTO user_roles(email,role,created_at,updated_at) VALUES(?,?,?,?) ON CONFLICT(email) DO UPDATE SET role=excluded.role,updated_at=excluded.updated_at")
    .bind(email, role, now, now).run();
  await db.prepare("INSERT INTO frontend_users(email,display_name,status,created_at,updated_at,email_verified_at) VALUES(?,?,?,?,?,COALESCE((SELECT email_verified_at FROM frontend_users WHERE email=?),?)) ON CONFLICT(email) DO UPDATE SET display_name=excluded.display_name,status=excluded.status,updated_at=excluded.updated_at")
    .bind(email, displayName, status, now, now, email, now).run();
  await db.prepare("INSERT INTO audit_logs(actor,action,resource,result,detail,created_at) VALUES(?,?,?,?,?,?)")
    .bind(user.email, "保存用户", email, "成功", `${role} / ${status}`, now).run();
  return success({ ok: true, message: "用户已保存。" });
});

// DELETE /api/users — 删除用户
app.delete("*", async (c) => {
  const { user } = c.var;
  const db = runEnv.DB;
  await ensureAuthTables(db);
  await ensureAudit(db);

  const body = await c.req.json().catch(() => ({})) as { emails?: string[] };
  const emails = (body.emails?.length ? body.emails : [c.req.query("email") || ""])
    .map(item => String(item).trim().toLowerCase()).filter(Boolean);
  if (!emails.length) return fail("请选择要删除的用户。");
  if (emails.includes(user.email)) return fail("不能删除当前登录账号。", 409);

  const owner = await db.prepare("SELECT email FROM user_roles ORDER BY CASE WHEN role='管理员' THEN 0 ELSE 1 END,created_at,email LIMIT 1").first<{ email: string }>();
  if (owner?.email && emails.includes(owner.email)) return fail("不能删除老板/首个管理员账号。", 409);

  const placeholders = emails.map(() => "?").join(",");
  const admins = await db.prepare(`SELECT COUNT(*) AS total FROM user_roles WHERE role='管理员' AND email NOT IN (${placeholders})`).bind(...emails).first<{ total: number }>();
  if (Number(admins?.total || 0) < 1) return fail("至少需要保留一个管理员。", 409);

  for (const email of emails) {
    await db.prepare("DELETE FROM login_sessions WHERE email=?").bind(email).run().catch(() => undefined);
    await db.prepare("DELETE FROM frontend_users WHERE email=?").bind(email).run();
    await db.prepare("DELETE FROM user_roles WHERE email=?").bind(email).run();
  }
  const now = new Date().toISOString();
  await db.prepare("INSERT INTO audit_logs(actor,action,resource,result,detail,created_at) VALUES(?,?,?,?,?,?)")
    .bind(user.email, "批量删除用户", emails.join(","), "成功", `${emails.length} 个账号`, now).run();
  return success({ message: "用户已删除。", deleted: emails.length });
});

// vinext 文件路由桥接
export const GET = (request: Request) => app.fetch(request);
export const POST = (request: Request) => app.fetch(request);
export const DELETE = (request: Request) => app.fetch(request);