import { readFileSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

// e2e 要用真实管理员账号登录，凭据只存在 .env 里（仓库不提交）。
// 这里手工读一遍，避免为测试再引入 dotenv 依赖；已存在的环境变量优先，CI 上可直接注入。
function loadDotEnv(file = ".env") {
  let text = "";
  try {
    text = readFileSync(new URL(file, import.meta.url), "utf8");
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([\w.-]+)\s*=\s*(.*)$/.exec(line);
    if (!match || line.trimStart().startsWith("#")) continue;
    const key = match[1];
    if (process.env[key] !== undefined) continue;
    process.env[key] = match[2].trim().replace(/^["'](.*)["']$/, "$1");
  }
}

loadDotEnv();

// 浏览器可执行文件默认交给 Playwright 自己解析（npx playwright install 装到哪就用哪）。
// 之前这里写死了某台 Windows 机器的绝对路径，换任何一台机器或 CI 都跑不起来。
// 确有自带浏览器的环境，用 PLAYWRIGHT_CHROMIUM_PATH 指定即可。
const chromiumPath = process.env.PLAYWRIGHT_CHROMIUM_PATH?.trim();

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: "list",
  timeout: 30000,
  use: {
    baseURL: process.env.E2E_BASE_URL || "http://localhost:3000",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        ...(chromiumPath ? { launchOptions: { executablePath: chromiumPath } } : {}),
      },
    },
  ],
  webServer: {
    command: "npx vinext dev",
    url: process.env.E2E_BASE_URL || "http://localhost:3000",
    reuseExistingServer: true,
    timeout: 120000,
    cwd: ".",
  },
});
