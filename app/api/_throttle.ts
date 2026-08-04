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
