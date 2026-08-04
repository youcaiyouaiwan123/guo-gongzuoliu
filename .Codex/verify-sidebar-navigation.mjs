import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const applicationOrigin = "http://localhost:3000";
const targets = await fetch("http://localhost:9222/json").then(response => response.json());
const pageTarget = targets.find(target => target.type === "page");
assert.ok(pageTarget, "未找到启用远程调试的 Chrome 页面。");

const socket = new WebSocket(pageTarget.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

let commandId = 0;
const pendingCommands = new Map();
socket.addEventListener("message", event => {
  const message = JSON.parse(event.data);
  const pending = pendingCommands.get(message.id);
  if (!pending) return;
  pendingCommands.delete(message.id);
  if (message.error) pending.reject(new Error(message.error.message));
  else pending.resolve(message.result);
});

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++commandId;
    pendingCommands.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "浏览器脚本执行失败。");
  return result.result.value;
}

async function waitFor(expression, message) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await evaluate(expression)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(message);
}

async function screenshot(filename) {
  const result = await send("Page.captureScreenshot", { format: "png", fromSurface: true });
  await writeFile(path.join(outputDirectory, filename), Buffer.from(result.data, "base64"));
}

const outputDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), "sidebar-navigation-screenshots");
await mkdir(outputDirectory, { recursive: true });
await send("Page.enable");
await send("Network.enable");
await send("Network.clearBrowserCookies");

try {
  await send("Emulation.setDeviceMetricsOverride", { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: `${applicationOrigin}/login` });
  await waitFor("document.readyState === 'complete' && Boolean(document.querySelector('.loginCard'))", "登录页未渲染完成。");

  const loginResult = await evaluate(`fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin", password: "admin123456", adminOnly: true }),
  }).then(async response => ({ ok: response.ok, status: response.status, body: await response.text() }))`);
  assert.equal(loginResult.ok, true, `管理员登录失败：${loginResult.status} ${loginResult.body}`);

  await send("Page.navigate", { url: `${applicationOrigin}/` });
  await waitFor("Boolean(document.querySelector('.sidebarNav')) && Boolean(document.querySelector('[data-tab=users]'))", "分组侧栏或管理员入口未渲染完成。");

  const initial = await evaluate(`(() => {
    const toggles = [...document.querySelectorAll(".navGroupToggle")];
    const current = document.querySelector(".navItem[aria-current=page]");
    return {
      groupCount: toggles.length,
      expandedLabels: toggles.filter(button => button.getAttribute("aria-expanded") === "true").map(button => button.textContent.trim()),
      currentTab: current?.dataset.tab,
      currentVisible: Boolean(current && getComputedStyle(current).display !== "none"),
      pageOverflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    };
  })()`);
  assert.equal(initial.groupCount, 5, "管理员侧栏必须显示 5 个业务组。");
  assert.equal(initial.expandedLabels.length, 1, "桌面端默认只能展开一个业务组。");
  assert.match(initial.expandedLabels[0], /核心工作/, "智能助手所在的核心工作组必须默认展开。");
  assert.equal(initial.currentTab, "chat", "当前页面必须通过 aria-current 标记。");
  assert.equal(initial.currentVisible, true, "当前页面入口必须可见。");
  assert.equal(initial.pageOverflowX, false, "桌面页面不得出现横向溢出。");
  await screenshot("desktop-default.png");

  await evaluate("document.querySelector('.navGroupToggle[aria-expanded=true]').click()");
  await waitFor("document.querySelectorAll('.navGroupToggle[aria-expanded=true]').length === 0", "活动组未能手动收起。");
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.navGroupItems')).display"), "none", "收起后子菜单仍然可见。");

  await evaluate("[...document.querySelectorAll('.navGroupToggle')].find(button => button.textContent.includes('知识与自动化')).click()");
  await waitFor("document.querySelectorAll('.navGroupToggle[aria-expanded=true]').length === 1", "目标业务组未展开。");
  assert.equal(
    await evaluate("document.querySelector('.navGroupToggle[aria-expanded=true]').textContent.includes('知识与自动化')"),
    true,
    "展开新组后旧组必须保持收起。",
  );

  await evaluate("document.querySelector('[data-tab=knowledge]').click()");
  await waitFor("document.querySelector('header h1')?.textContent === '企业知识'", "点击菜单后页面未切换到企业知识。");
  await waitFor("Boolean(document.querySelector('.contentPanel .metricRow'))", "企业知识内容面板未渲染完成。");
  assert.equal(await evaluate("document.querySelector('[data-tab=knowledge]').getAttribute('aria-current')"), "page", "切换后的入口未保持活动高亮。");
  await screenshot("desktop-group-open.png");

  await evaluate("document.querySelector('[data-tab=chat]').click()");
  await waitFor("document.querySelector('header h1')?.textContent === '智能助手'", "未能返回智能助手。");
  await evaluate("document.querySelector('.insightTitle button').click()");
  await waitFor("Boolean(document.querySelector('.viewAudit'))", "运行状态面板未展开。");
  await evaluate("document.querySelector('.viewAudit').click()");
  await waitFor("document.querySelector('header h1')?.textContent === '审计日志'", "外部入口未切换到审计日志。");
  assert.equal(
    await evaluate("document.querySelector('[data-group=system] .navGroupToggle').getAttribute('aria-expanded')"),
    "true",
    "外部页面切换后目标业务组必须自动展开。",
  );

  await send("Emulation.setDeviceMetricsOverride", { width: 768, height: 768, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: `${applicationOrigin}/` });
  await waitFor("Boolean(document.querySelector('.sidebarNav')) && Boolean(document.querySelector('[data-tab=users]'))", "平板侧栏未渲染完成。");
  const tablet = await evaluate(`(() => ({
    groupToggleCount: document.querySelectorAll('.navGroupToggle').length,
    visibleGroupToggleCount: [...document.querySelectorAll('.navGroupToggle')].filter(button => getComputedStyle(button).display !== 'none').length,
    pageOverflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  }))()`);
  assert.equal(tablet.groupToggleCount, 5, "768px 侧栏必须保留业务分组。");
  assert.equal(tablet.visibleGroupToggleCount, 5, "768px 侧栏分组标题必须可见。");
  assert.equal(tablet.pageOverflowX, false, "768px 页面不得出现整体横向溢出。");
  await screenshot("tablet-grouped-navigation.png");

  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await send("Page.navigate", { url: `${applicationOrigin}/` });
  await waitFor("Boolean(document.querySelector('.sidebarNav')) && Boolean(document.querySelector('[data-tab=users]'))", "手机端侧栏未渲染完成。");
  const mobile = await evaluate(`(() => {
    const toggles = [...document.querySelectorAll(".navGroupToggle")];
    const items = [...document.querySelectorAll(".navItem")];
    return {
      hiddenGroupToggleCount: toggles.filter(button => getComputedStyle(button).display === "none").length,
      itemCount: items.length,
      visibleItemCount: items.filter(button => getComputedStyle(button).display !== "none").length,
      pageOverflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    };
  })()`);
  assert.equal(mobile.hiddenGroupToggleCount, 5, "手机端必须隐藏分组标题。");
  assert.equal(mobile.visibleItemCount, mobile.itemCount, "手机端必须平铺显示全部允许访问的入口。");
  assert.equal(mobile.itemCount, 18, "管理员手机端必须保留全部 18 个入口。");
  assert.equal(mobile.pageOverflowX, false, "手机页面不得出现整体横向溢出。");
  await screenshot("mobile-flat-navigation.png");
} finally {
  socket.close();
}

console.log(`侧栏分组折叠浏览器验证通过，截图目录：${outputDirectory}`);
