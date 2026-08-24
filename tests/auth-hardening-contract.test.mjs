// 认证防滥用硬化的契约测试：按 IP 兜底限流、消除账号枚举、全局每日发信上限。
//
// 背景：原先按邮箱/账号限流可被「换邮箱/换账号」绕开；登录先暴露「未验证」再验密码，
// 据响应码即可枚举有效邮箱；发信无全局上限，可被灌爆 SMTP 配额。这次逐一堵上。
// 从生产源码提取实现直接断言，任一处被改回旧行为即失败。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const cache = new Map();
async function source(rel) {
  if (!cache.has(rel)) cache.set(rel, await readFile(new URL(`../${rel}`, import.meta.url), "utf8"));
  return cache.get(rel);
}

test("throttle：新增按 IP 的登录/发码规则 + 可信头取 IP", async () => {
  const t = await source("app/api/_throttle.ts");
  assert.ok(/LOGIN_IP_RULE:\s*ThrottleRule/.test(t), "应有 LOGIN_IP_RULE 按 IP 限流登录。");
  assert.ok(/REGISTER_CODE_IP_RULE:\s*ThrottleRule/.test(t), "应有 REGISTER_CODE_IP_RULE 按 IP 限流发码。");
  assert.ok(/export function clientIp/.test(t), "应有 clientIp 提取来源 IP。");
  assert.ok(t.includes('"x-real-ip"'), "clientIp 应优先取 nginx 注入的 x-real-ip。");
});

test("register 发码：IP 限流在前 + 已注册/超限一律统一回复（消除枚举）", async () => {
  const reg = await source("app/api/auth/register/route.ts");
  const req = reg.slice(reg.indexOf('body.action === "requestCode"'), reg.indexOf('body.action === "verify"'));
  assert.ok(req.includes("REGISTER_CODE_IP_RULE"), "发码应先按 IP 限流。");
  // IP 限流须早于按邮箱限流。
  assert.ok(req.indexOf("REGISTER_CODE_IP_RULE") < req.indexOf("REGISTER_CODE_RULE"), "IP 限流应在邮箱限流之前。");
  // 统一回复对象，已注册与未注册返回同一 genericOk。
  assert.ok(/const genericOk = success\(/.test(req), "应有统一回复 genericOk。");
  assert.ok(/if \(existing\) return genericOk/.test(req), "已注册邮箱应回统一文案，不得给出可区分的错误。");
  assert.ok(!/if \(existing\) return fail/.test(req), "已注册不应再返回可枚举的 fail。");
});

test("register 发码：全局 24h 发信上限（按 mail_outbox 计数）", async () => {
  const reg = await source("app/api/auth/register/route.ts");
  assert.ok(/MAIL_DAILY_CAP/.test(reg), "应有 MAIL_DAILY_CAP 全局上限。");
  assert.ok(/COUNT\(\*\)[\s\S]*?FROM mail_outbox WHERE created_at>=/.test(reg), "上限应按最近 24h mail_outbox 计数。");
  assert.ok(/>=\s*cap\) return genericOk/.test(reg), "超限应静默回统一文案而非报错。");
});

test("register 校验：先验验证码再判已注册，错误文案统一", async () => {
  const reg = await source("app/api/auth/register/route.ts");
  const ver = reg.slice(reg.indexOf('body.action === "verify"'));
  const codeCheck = ver.indexOf("code_hash");
  const existingCheck = ver.indexOf("SELECT email FROM user_security");
  assert.ok(codeCheck > 0 && existingCheck > 0 && codeCheck < existingCheck, "应先校验验证码，再判断是否已注册。");
  assert.ok(/验证码不正确或已过期/.test(ver), "无码/过期/不匹配应返回同一句，避免枚举。");
});

test("login：按 IP 限流 + 先验密码再暴露账号状态（消除枚举与时序差）", async () => {
  const login = await source("app/api/auth/login/route.ts");
  assert.ok(login.includes("LOGIN_IP_RULE") && login.includes("clientIp("), "登录应叠加按 IP 限流。");
  assert.ok(/DUMMY_RECORD/.test(login), "账号不存在时应跑 dummy 校验抹平时序。");
  const body = login.slice(login.indexOf("app.post"));
  const pwdCheck = body.indexOf("verifyPassword(");
  const verifiedCheck = body.indexOf("emailVerifiedAt");
  assert.ok(pwdCheck > 0 && verifiedCheck > pwdCheck, "应先验密码，再暴露「未验证/禁用」状态。");
  assert.ok(/if \(!security \|\| !verification\.valid\) return fail\("邮箱或密码不正确。", 401\)/.test(body), "不存在/未验证/密码错应统一回 401 同一句。");
});
