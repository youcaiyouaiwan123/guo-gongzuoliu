import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: "list",
  timeout: 30000,
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: {
          executablePath: "C:\\Users\\zh126\\AppData\\Local\\ms-playwright\\chromium-1124\\chrome-win\\chrome.exe",
        },
      },
    },
  ],
  webServer: {
    command: "npx vinext dev",
    url: "http://localhost:3000",
    reuseExistingServer: true,
    timeout: 120000,
    cwd: ".",
  },
});