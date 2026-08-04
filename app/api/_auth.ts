import { env } from "cloudflare:workers";
import { defaultDecisionFor } from "./_capabilities";
import {
  ADMIN_ROLE,
  STAFF_ROLE,
  SALES_ROLE,
  ENABLED_STATUS,
  DISABLED_STATUS,
  type AppRole,
  type BusinessRole,
} from "./_roles";

export type { AppRole, BusinessRole };

type AuthRuntimeEnv = { ADMIN_EMAILS?: string };
const authRuntime = env as unknown as AuthRuntimeEnv;

export { ADMIN_ROLE, STAFF_ROLE, SALES_ROLE, ENABLED_STATUS, DISABLED_STATUS };

export type AppUser = {
  email: string;
  role: AppRole;
  businessRole: BusinessRole;
};

export function getCookie(request: Request, name: string) {
  const cookie = request.headers.get("cookie") || "";
  return cookie
    .split(";")
    .map(part => part.trim())
    .find(part => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

export function normalizeRoleValue(value?: string | null): AppRole {
  const text = String(value || "").trim().toLowerCase();
  if (
    text.includes("管理员") ||
    text.includes("admin") ||
    text.includes("owner") ||
    text.includes("绠＄悊") ||
    text.includes("管理")
  ) {
    return ADMIN_ROLE;
  }
  return STAFF_ROLE;
}

export function normalizeBusinessRoleValue(value?: string | null, role?: AppRole): BusinessRole {
  const text = String(value || "").trim().toLowerCase();
  if (role === ADMIN_ROLE || text.includes("销售") || text.includes("閿€鍞")) return SALES_ROLE;
  return "普通员工";
}

export function normalizeStatusValue(value?: string | null) {
  const text = String(value || "").trim().toLowerCase();
  if (text.includes("禁用") || text.includes("disabled") || text.includes("绂佺敤")) return DISABLED_STATUS;
  return ENABLED_STATUS;
}

export function normalizeDecisionValue(value?: string | null): "允许" | "需审批" | "拒绝" {
  const text = String(value || "").trim().toLowerCase();
  if (text.includes("允许") || text.includes("allow") || text.includes("鍏佽") || text.includes("通过")) return "允许";
  if (text.includes("审批") || text.includes("review") || text.includes("瀹℃壒")) return "需审批";
  return "拒绝";
}

export async function ensureAuthTables(db: D1Database) {
  await db.prepare("CREATE TABLE IF NOT EXISTS user_roles (email TEXT PRIMARY KEY,role TEXT NOT NULL DEFAULT '普通员工',created_at TEXT NOT NULL,updated_at TEXT NOT NULL)").run();
  await db.prepare("CREATE TABLE IF NOT EXISTS frontend_users (email TEXT PRIMARY KEY,display_name TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT '启用',email_verified_at TEXT DEFAULT '',last_login_at TEXT DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL)").run();
  await db.prepare("CREATE TABLE IF NOT EXISTS login_sessions (token TEXT PRIMARY KEY,email TEXT NOT NULL,created_at TEXT NOT NULL,expires_at TEXT NOT NULL)").run();
  await db.prepare("CREATE TABLE IF NOT EXISTS role_permissions (id INTEGER PRIMARY KEY AUTOINCREMENT,role TEXT NOT NULL,capability TEXT NOT NULL,decision TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(role,capability))").run();
  // 历史脏数据的规范化已移到迁移 0019_normalize_legacy_values.sql 一次性执行。
  // 此前在这里对 user_roles、frontend_users、role_permissions 做全表扫描并逐行写回，
  // 每次认证都会付出该代价；读取路径的 normalizeRoleValue / normalizeStatusValue 已足够兜底。
}

export async function authenticate(request: Request, db: D1Database, adminOnly = false): Promise<{ user: AppUser } | { response: Response }> {
  await ensureAuthTables(db);

  // 身份只来自会话 Cookie。此前还会优先信任 oai-authenticated-user-email 请求头，
  // 但该头由客户端可控：同一 Docker 网络内的任何服务直连 app:3000 即可冒充任意账号（含管理员）。
  // 如需接入统一身份认证，必须由可信代理动态签发身份并在此校验代理来源或签名，不能裸信请求头。
  let email = "";
  const token = getCookie(request, "haixin_session");
  if (token) {
    const session = await db.prepare("SELECT email FROM login_sessions WHERE token=? AND expires_at>?")
      .bind(token, new Date().toISOString())
      .first<{ email: string }>();
    email = session?.email?.trim().toLowerCase() || "";
  }

  if (!email) {
    return { response: Response.json({ error: "登录状态已失效，请重新登录。" }, { status: 401 }) };
  }

  const configuredAdmins = (authRuntime.ADMIN_EMAILS || "").split(",").map(item => item.trim().toLowerCase()).filter(Boolean);
  const isConfiguredAdmin = configuredAdmins.includes(email);
  let record = await db.prepare("SELECT email,role FROM user_roles WHERE email=?").bind(email).first<{ email: string; role: string }>();
  if (!record) {
    const count = await db.prepare("SELECT COUNT(*) AS total FROM user_roles").first<{ total: number }>();
    const role: AppRole = Number(count?.total || 0) === 0 || isConfiguredAdmin ? ADMIN_ROLE : STAFF_ROLE;
    const now = new Date().toISOString();
    await db.prepare("INSERT OR IGNORE INTO user_roles(email,role,created_at,updated_at) VALUES(?,?,?,?)").bind(email, role, now, now).run();
    record = { email, role };
  }

  let role = normalizeRoleValue(record.role);
  if (isConfiguredAdmin && role !== ADMIN_ROLE) role = ADMIN_ROLE;
  if (record.role !== role || isConfiguredAdmin) {
    await db.prepare("UPDATE user_roles SET role=?,updated_at=? WHERE email=?").bind(role, new Date().toISOString(), email).run();
  }

  const now = new Date().toISOString();
  await db.prepare("INSERT INTO frontend_users(email,display_name,status,email_verified_at,last_login_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(email) DO UPDATE SET status=CASE WHEN frontend_users.status='禁用' OR frontend_users.status='绂佺敤' THEN frontend_users.status ELSE '启用' END,last_login_at=excluded.last_login_at,updated_at=excluded.updated_at")
    .bind(email, email.split("@")[0] || email, ENABLED_STATUS, now, now, now, now)
    .run();

  const userStatus = await db.prepare("SELECT status FROM frontend_users WHERE email=?").bind(email).first<{ status: string }>();
  if (normalizeStatusValue(userStatus?.status) === DISABLED_STATUS) {
    return { response: Response.json({ error: "账号已被禁用，请联系管理员。" }, { status: 403 }) };
  }

  if (adminOnly && role !== ADMIN_ROLE) {
    return { response: Response.json({ error: "仅管理员可以执行此操作。" }, { status: 403 }) };
  }

  return { user: { email, role, businessRole: normalizeBusinessRoleValue("", role) } };
}

export async function authorizeCapability(db: D1Database, user: AppUser, capability: string): Promise<Response | null> {
  if (user.role === ADMIN_ROLE || capability === "collect_data") return null;
  await ensureAuthTables(db);
  const policy = await db.prepare("SELECT decision FROM role_permissions WHERE role=? AND capability=?")
    .bind(user.role, capability)
    .first<{ decision: string }>();
  // 没有策略行说明管理员尚未在权限中心覆盖该能力，此时按能力目录的默认值判定，
  // 避免新增能力项在既有数据库上被一律拒绝。
  const decision = policy?.decision
    ? normalizeDecisionValue(policy.decision)
    : defaultDecisionFor(user.role, capability);
  if (decision === "允许") return null;
  if (decision === "需审批") return Response.json({ error: "此操作需要审批，请先到审批中心提交申请。" }, { status: 403 });
  return Response.json({ error: "当前角色没有此操作权限。" }, { status: 403 });
}
