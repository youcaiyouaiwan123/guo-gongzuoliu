// 邮箱注册「真发信 + 关闭首人 admin + HTML 邮件 + 队列/重试」的契约测试。
//
// 背景：mail_outbox 一直只写不发 → 验证码永远送不出。这次让常驻网关消费队列，用 node:tls 直连
// SMTP 投递；同时关掉「第一个注册者自动成为管理员」的提权窗口，验证码邮件改 HTML，后台可见发送队列。
// 这里从生产源码提取实现直接断言，任一处被改回旧行为即失败。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const cache = new Map();
async function source(rel) {
  if (!cache.has(rel)) cache.set(rel, await readFile(new URL(`../${rel}`, import.meta.url), "utf8"));
  return cache.get(rel);
}

test("register：发信门槛改 env.MAIL_HOST，不再读 system_settings.smtpHost", async () => {
  const reg = await source("app/api/auth/register/route.ts");
  assert.ok(/runtimeEnv\.MAIL_HOST\?\.trim\(\)/.test(reg), "requestCode 应以 env.MAIL_HOST 作为发信是否可用的门槛。");
  assert.ok(!reg.includes("WHERE key='smtpHost'"), "不应再从 system_settings 读 smtpHost 判断发信可用。");
});

test("register：注册一律普通员工，关闭首人自动 admin", async () => {
  const reg = await source("app/api/auth/register/route.ts");
  assert.ok(/const role = "普通员工"/.test(reg), "注册应固定创建普通员工。");
  assert.ok(!/COUNT\(\*\)[\s\S]*?user_roles[\s\S]*?管理员/.test(reg), "不应再按 user_roles 计数把首个注册者设为管理员。");
});

test("register：验证码邮件写入 HTML 正文", async () => {
  const reg = await source("app/api/auth/register/route.ts");
  assert.ok(reg.includes("verificationEmailHtml("), "应调用 HTML 模板生成验证码邮件正文。");
  assert.ok(/<!doctype html>/i.test(reg), "验证码邮件正文应为 HTML。");
});

test("mail 端点：GET 取待发送、POST 回报结果并按上限重试", async () => {
  const mail = await source("app/api/gateway/mail/route.ts");
  assert.ok(/status='待发送' AND attempts<\?/.test(mail), "GET 应只取未超重试上限的待发送邮件。");
  assert.ok(/status='已发送',sent_at=\?/.test(mail), "POST 成功应标记已发送并写 sent_at。");
  assert.ok(/attempts\+1>=\? THEN '发送失败' ELSE '待发送'/.test(mail), "POST 失败应累加尝试，到上限落发送失败、否则回到待发送。");
  assert.ok(/isAuthorized|Bearer \$\{secret\}/.test(mail), "mail 端点应有 Bearer 鉴权。");
});

test("网关：node:tls SMTP 客户端 + drainMailOutbox 定时消费队列", async () => {
  const gw = await source("services/channel-gateway/index.mjs");
  assert.ok(/import tls from "node:tls"/.test(gw), "网关应用 node:tls 直连 SMTP。");
  assert.ok(gw.includes("function sendMail("), "网关应有 sendMail SMTP 客户端。");
  assert.ok(gw.includes("async function drainMailOutbox("), "网关应有 drainMailOutbox 消费队列。");
  assert.ok(/setInterval\(\(\) => \{ void drainMailOutbox\(\); \}/.test(gw), "网关应定时调用 drainMailOutbox。");
  for (const key of ["MAIL_HOST", "MAIL_USER", "MAIL_PASS", "MAIL_PORT", "MAIL_FROM"]) {
    assert.ok(gw.includes(`process.env.${key}`), `drainMailOutbox 应读取 ${key}。`);
  }
  assert.ok(gw.includes('"/mail"') && /\/accounts\(\?:\\\/\)\?\$/.test(gw), "网关应从 accounts URL 推导 /mail 端点。");
});

test("后台设置：返回 env 发信状态 + 邮件队列，支持重试", async () => {
  const settings = await source("app/api/admin/settings/route.ts");
  assert.ok(/MAIL_HOST[\s\S]*?MAIL_SENDER/.test(settings), "GET 应基于 env MAIL_HOST/MAIL_SENDER 回发信状态。");
  assert.ok(settings.includes("FROM mail_outbox ORDER BY id DESC"), "GET 应返回发送队列。");
  assert.ok(/action === "retryMail"/.test(settings), "POST 应支持 retryMail 重试。");
  assert.ok(!settings.includes("SMTP 访问凭证密钥"), "不应把发信密钥写入 DB 或回显。");
});

test("前端：注册加确认密码 + 强度提示", async () => {
  const page = await source("app/AuthPage.tsx");
  assert.ok(page.includes('name="confirmPassword"'), "注册表单应有确认密码字段。");
  assert.ok(/两次输入的密码不一致/.test(page), "确认密码不一致时应拦截。");
  assert.ok(page.includes("passwordStrength("), "应展示密码强度提示。");
});

test("部署：compose/entrypoint 注入 MAIL_*（密钥只给网关）", async () => {
  const compose = await source("docker-compose.server.yml");
  // 网关拿全套发信密钥。
  for (const key of ["MAIL_HOST", "MAIL_PORT", "MAIL_USER", "MAIL_PASS", "MAIL_FROM"]) {
    assert.ok(compose.includes(`${key}:`), `channel-gateway 应注入 ${key}。`);
  }
  // app 只拿非密钥的 MAIL_HOST/MAIL_SENDER，绝不给 MAIL_PASS。
  // 注意 app 块内 MODEL_RELAY_URL 的值里也含 "model-relay:"，切块要按服务头 "\n  model-relay:"。
  const appBlock = compose.slice(compose.indexOf("app:"), compose.indexOf("\n  model-relay:"));
  assert.ok(appBlock.includes("MAIL_HOST:") && appBlock.includes("MAIL_SENDER:"), "app 应注入 MAIL_HOST/MAIL_SENDER。");
  assert.ok(!appBlock.includes("MAIL_PASS:"), "app 不应拿到发信密钥 MAIL_PASS。");

  const entry = await source("deploy/selfhost-entrypoint.sh");
  assert.ok(entry.includes('--var "MAIL_HOST:${MAIL_HOST:-}"'), "entrypoint 应把 MAIL_HOST 传给 worker。");
  assert.ok(!/--var "MAIL_PASS/.test(entry), "entrypoint 不应把 MAIL_PASS 传给 worker。");
});
