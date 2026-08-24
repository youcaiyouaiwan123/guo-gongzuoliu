// 注册：邮箱验证码注册。
import { createApp, success, fail } from "../../_app";
import { env } from "cloudflare:workers";
import { createPasswordRecord } from "../../_password";
import { REGISTER_CODE_RULE, REGISTER_VERIFY_RULE, REGISTER_CODE_IP_RULE, consumeAttempt, resetAttempts, throttledResponse, clientIp } from "../../_throttle";

export const runtime = "edge";

const runtimeEnv = env as unknown as { DB: D1Database; MAIL_HOST?: string; MAIL_DAILY_CAP?: string };

async function sha256(value: string) {
  const data = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash)).map(byte => byte.toString(16).padStart(2, "0")).join("");
}

// 验证码邮件正文（HTML）。发信由网关侧统一以 text/html 发出，这里只组织展示。
function verificationEmailHtml(code: string) {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f5f7f3;">
  <div style="max-width:480px;margin:0 auto;padding:32px 20px;font-family:'Microsoft YaHei',Arial,sans-serif;color:#19231f;">
    <div style="background:#ffffff;border:1px solid #dde5e0;border-radius:16px;padding:32px 28px;">
      <div style="font-size:13px;letter-spacing:.14em;color:#0b6b4f;font-weight:700;">HAIXIN BOCHUANG</div>
      <h1 style="margin:10px 0 4px;font-size:22px;color:#19231f;">海芯博创账号验证码</h1>
      <p style="margin:0 0 22px;color:#6d7973;font-size:14px;line-height:1.7;">您正在注册海芯博创企业 AI 平台账号，请在验证页面输入以下验证码完成注册：</p>
      <div style="text-align:center;margin:0 0 22px;">
        <span style="display:inline-block;font-size:34px;font-weight:800;letter-spacing:.32em;color:#07553f;background:#e6f3ed;border-radius:12px;padding:16px 24px;">${code}</span>
      </div>
      <p style="margin:0 0 6px;color:#6d7973;font-size:13px;line-height:1.7;">验证码 <b style="color:#19231f;">10 分钟内</b>有效，请勿向任何人透露。</p>
      <p style="margin:0;color:#6d7973;font-size:13px;line-height:1.7;">若非本人操作，请忽略本邮件。</p>
    </div>
    <p style="margin:16px 0 0;text-align:center;color:#89958f;font-size:11px;">本邮件由系统自动发送，请勿直接回复。</p>
  </div>
</body></html>`;
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
    // IP 兜底限流放最前：单机换着邮箱狂发验证码的滥用在这里就被掐断。
    const ipThrottle = await consumeAttempt(db, REGISTER_CODE_IP_RULE, clientIp(c.req.raw));
    if (!ipThrottle.allowed) return throttledResponse(ipThrottle, "验证码获取");
    const throttle = await consumeAttempt(db, REGISTER_CODE_RULE, email);
    if (!throttle.allowed) return throttledResponse(throttle, "验证码获取");

    // 发信凭据放在服务器环境变量（MAIL_*）里，由网关消费 mail_outbox 实际发送；
    // 这里只用 MAIL_HOST 作为「邮件服务是否已配置」的门槛，密钥永不进 DB。
    if (!runtimeEnv.MAIL_HOST?.trim()) return fail("邮件服务尚未配置，请联系管理员。", 503);

    // 统一回复：不因「是否已注册 / 是否真的发出」而分叉，避免被用来枚举有效账号。
    const genericOk = success({ message: "如果该邮箱可以注册，验证码已发送，请查收邮件。" });

    // 已注册：不再发码，但回复与未注册完全一致。
    const existing = await db.prepare("SELECT email FROM user_security WHERE email=?").bind(email).first<{ email: string }>();
    if (existing) return genericOk;

    // 全局每日发信上限：兜底防止被灌爆 SMTP 配额。超限则静默丢弃，仍回一致文案。
    const cap = Number(runtimeEnv.MAIL_DAILY_CAP || "300");
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const sent = await db.prepare("SELECT COUNT(*) AS n FROM mail_outbox WHERE created_at>=?").bind(since).first<{ n: number }>();
    if (Number(sent?.n || 0) >= cap) return genericOk;

    const random = new Uint32Array(1);
    crypto.getRandomValues(random);
    const code = String(100000 + random[0] % 900000);
    const codeHash = await sha256(`${email}:${code}`);
    const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    await db.prepare("INSERT INTO email_verification_codes(email,code_hash,expires_at,created_at) VALUES(?,?,?,?) ON CONFLICT(email) DO UPDATE SET code_hash=excluded.code_hash,expires_at=excluded.expires_at,created_at=excluded.created_at")
      .bind(email, codeHash, expires, now).run();
    await db.prepare("INSERT INTO mail_outbox(email,subject,content,status,created_at) VALUES(?,?,?,?,?)")
      .bind(email, "海芯博创账号验证码", verificationEmailHtml(code), "待发送", now).run();
    return genericOk;
  }

  if (body.action === "verify") {
    if (!body.password || body.password.length < 8) return fail("密码至少需要 8 位。", 400);
    const throttle = await consumeAttempt(db, REGISTER_VERIFY_RULE, email);
    if (!throttle.allowed) return throttledResponse(throttle, "验证码校验");
    // 先校验验证码：无码 / 过期 / 不匹配一律返回同一句，
    // 避免据此判断该邮箱是否已注册、是否存在待验证的验证码（枚举面）。
    const row = await db.prepare("SELECT code_hash AS codeHash,expires_at AS expiresAt FROM email_verification_codes WHERE email=?").bind(email).first<{ codeHash: string; expiresAt: string }>();
    const inputHash = await sha256(`${email}:${String(body.code || "").trim()}`);
    if (!row || row.expiresAt < now || inputHash !== row.codeHash) return fail("验证码不正确或已过期，请重新获取。", 400);
    // 到这一步已证明持有该邮箱的验证码（即掌控邮箱）；此时再拦截「已注册」不构成枚举。
    const existing = await db.prepare("SELECT email FROM user_security WHERE email=?").bind(email).first<{ email: string }>();
    if (existing) return fail("该邮箱已注册，请直接登录或使用密码找回功能。", 409);
    const passwordRecord = await createPasswordRecord(body.password);
    // 注册一律创建「普通员工」。管理员由 DEFAULT_ADMIN 引导（见 login 路由 ensureDefaultAdminUser），
    // 不再让「第一个注册者自动成为管理员」——那是一个任何人都能抢占的提权窗口。
    const role = "普通员工";
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