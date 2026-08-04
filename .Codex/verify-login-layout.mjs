import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const browserEndpoint = "http://localhost:9222/json";
const applicationOrigin = "http://localhost:3000";
const routes = ["/", "/login", "/admin-login"];
const viewports = [
  { width: 1366, height: 768 },
  { width: 1036, height: 905 },
  { width: 768, height: 768 },
  { width: 390, height: 844 },
];
const outputDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), "login-layout-screenshots");

const targets = await fetch(browserEndpoint).then(response => response.json());
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
  const result = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "浏览器脚本执行失败。");
  return result.result.value;
}

async function waitForLoginCard() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const ready = await evaluate("document.readyState === 'complete' && Boolean(document.querySelector('.loginCard'))");
    if (ready) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("登录页在 5 秒内未渲染完成。");
}

function assertLayout(result) {
  assert.equal(result.overflowX, false, `${result.route} 在 ${result.width}px 下出现横向溢出。`);
  assert.equal(result.cardInsideWidth, true, `${result.route} 在 ${result.width}px 下登录卡片超出视口。`);
  assert.equal(result.cardTopVisible, true, `${result.route} 在 ${result.width}px 下登录卡片完全落在首屏之外。`);
  assert.equal(result.footerOverlap, false, `${result.route} 在 ${result.width}px 下登录卡片与页脚重叠。`);

  if (result.width <= 900) {
    assert.equal(result.heroDisplay, "none", `${result.route} 在 ${result.width}px 下未隐藏品牌栏。`);
    assert.equal(result.gridColumnCount, 1, `${result.route} 在 ${result.width}px 下未切换为单栏。`);
  } else {
    assert.notEqual(result.heroDisplay, "none", `${result.route} 在 ${result.width}px 下品牌栏被意外隐藏。`);
    assert.equal(result.gridColumnCount, 2, `${result.route} 在 ${result.width}px 下未保持双栏。`);
  }
}

await send("Page.enable");
await send("Network.enable");
await send("Network.clearBrowserCookies");
await mkdir(outputDirectory, { recursive: true });

try {
  for (const viewport of viewports) {
    await send("Emulation.setDeviceMetricsOverride", {
      ...viewport,
      deviceScaleFactor: 1,
      mobile: viewport.width <= 390,
    });

    for (const route of routes) {
      await send("Page.navigate", { url: `${applicationOrigin}${route}` });
      await waitForLoginCard();

      const result = await evaluate(`(() => {
        const page = document.querySelector(".loginPage");
        const hero = document.querySelector(".loginBrand");
        const card = document.querySelector(".loginCard");
        const footer = document.querySelector(".loginFooter");
        const pageStyle = getComputedStyle(page);
        const cardRect = card.getBoundingClientRect();
        const footerRect = footer?.getBoundingClientRect();
        return {
          route: ${JSON.stringify(route)},
          width: innerWidth,
          height: innerHeight,
          gridColumnCount: pageStyle.gridTemplateColumns.split(" ").filter(Boolean).length,
          heroDisplay: getComputedStyle(hero).display,
          cardInsideWidth: cardRect.left >= 0 && cardRect.right <= innerWidth + 1,
          cardTopVisible: cardRect.top < innerHeight && cardRect.bottom > 0,
          footerOverlap: Boolean(footerRect && cardRect.bottom > footerRect.top + 1),
          overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
          card: { x: cardRect.x, y: cardRect.y, width: cardRect.width, height: cardRect.height },
        };
      })()`);

      assertLayout(result);
      console.log(JSON.stringify(result));

      if (route === "/login") {
        const screenshot = await send("Page.captureScreenshot", { format: "png", fromSurface: true });
        await writeFile(path.join(outputDirectory, `login-${viewport.width}x${viewport.height}.png`), Buffer.from(screenshot.data, "base64"));
      }
    }
  }
} finally {
  socket.close();
}

console.log(`登录布局浏览器验证通过，截图目录：${outputDirectory}`);
