// 认证类接口的失败计数与锁定。
// 计数通过单条 UPSERT + RETURNING 完成：并发请求各自拿到递增后的次数，
// 不存在“先查后写”被绕过的窗口。锁定期用 locked_until 表示，空串代表未锁定。
const TABLE_SQL = "CREATE TABLE IF NOT EXISTS auth_throttle (scope TEXT NOT NULL,subject TEXT NOT NULL,window_started_at TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,locked_until TEXT NOT NULL DEFAULT '',PRIMARY KEY(scope,subject))";

export type ThrottleRule = {
  scope: string;
  limit: number;
  windowSeconds: number;
  lockSeconds: number;
};

// 登录：同一账号 15 分钟内允许 5 次失败，超出后锁定 15 分钟。
export const LOGIN_RULE: ThrottleRule = { scope: "login", limit: 5, windowSeconds: 900, lockSeconds: 900 };
// 索取注册验证码：同一邮箱每小时 3 次，避免把他人邮箱当作轰炸目标。
export const REGISTER_CODE_RULE: ThrottleRule = { scope: "register_code", limit: 3, windowSeconds: 3600, lockSeconds: 3600 };
// 校验注册验证码：6 位数字可被枚举，因此按失败次数锁定。
export const REGISTER_VERIFY_RULE: ThrottleRule = { scope: "register_verify", limit: 5, windowSeconds: 900, lockSeconds: 900 };

// 按 IP 的兜底限流：上面几条都以「邮箱/账号」为主体，攻击者换邮箱/换账号即可绕开。
// 这两条以来源 IP 为主体，掐住「单机换着邮箱狂发验证码」和「单机跨账号撞库/喷洒」。
// 阈值取得比单账号宽松：正常用户远够用，脚本化滥用则很快撞墙。
// 登录 IP 限流不区分成功/失败，成功登录不清零——正常人一个 IP 15 分钟登录几十次已属异常。
export const LOGIN_IP_RULE: ThrottleRule = { scope: "login_ip", limit: 30, windowSeconds: 900, lockSeconds: 900 };
export const REGISTER_CODE_IP_RULE: ThrottleRule = { scope: "register_code_ip", limit: 10, windowSeconds: 3600, lockSeconds: 3600 };

// 从可信边缘（nginx）注入的头里取真实来源 IP。nginx 用 $remote_addr 设 X-Real-IP，
// 比 X-Forwarded-For 更不易被客户端伪造；缺失时退回 XFF 的第一跳，再退回占位符。
export function clientIp(request: Request): string {
  const real = request.headers.get("x-real-ip")?.trim();
  if (real) return real;
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || "unknown";
}

export type ThrottleResult = { allowed: true } | { allowed: false; retryAfterSeconds: number };

export async function ensureThrottleTable(db: D1Database) {
  await db.prepare(TABLE_SQL).run();
}

export async function consumeAttempt(db: D1Database, rule: ThrottleRule, subject: string): Promise<ThrottleResult> {
  await ensureThrottleTable(db);
  const now = new Date();
  const nowText = now.toISOString();
  const windowFloor = new Date(now.getTime() - rule.windowSeconds * 1000).toISOString();

  const row = await db.prepare(
    "INSERT INTO auth_throttle(scope,subject,window_started_at,attempts,locked_until) VALUES(?,?,?,1,'')"
    + " ON CONFLICT(scope,subject) DO UPDATE SET"
    + " attempts=CASE WHEN auth_throttle.window_started_at<? THEN 1 ELSE auth_throttle.attempts+1 END,"
    + " window_started_at=CASE WHEN auth_throttle.window_started_at<? THEN excluded.window_started_at ELSE auth_throttle.window_started_at END"
    + " RETURNING attempts,locked_until AS lockedUntil"
  ).bind(rule.scope, subject, nowText, windowFloor, windowFloor).first<{ attempts: number; lockedUntil: string }>();

  const lockedUntil = row?.lockedUntil || "";
  if (lockedUntil && lockedUntil > nowText) {
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((new Date(lockedUntil).getTime() - now.getTime()) / 1000)) };
  }

  if (Number(row?.attempts || 1) > rule.limit) {
    const until = new Date(now.getTime() + rule.lockSeconds * 1000).toISOString();
    await db.prepare("UPDATE auth_throttle SET locked_until=? WHERE scope=? AND subject=?").bind(until, rule.scope, subject).run();
    return { allowed: false, retryAfterSeconds: rule.lockSeconds };
  }

  return { allowed: true };
}

// 认证成功后清零，避免正常用户偶发输错后仍被计入后续窗口。
export async function resetAttempts(db: D1Database, rule: ThrottleRule, subject: string) {
  await db.prepare("DELETE FROM auth_throttle WHERE scope=? AND subject=?").bind(rule.scope, subject).run();
}

export function throttledResponse(result: Extract<ThrottleResult, { allowed: false }>, action: string) {
  const minutes = Math.max(1, Math.ceil(result.retryAfterSeconds / 60));
  return Response.json(
    { error: `${action}过于频繁，请在 ${minutes} 分钟后重试。` },
    { status: 429, headers: { "Retry-After": String(result.retryAfterSeconds) } },
  );
}
