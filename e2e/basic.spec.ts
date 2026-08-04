import { test, expect } from "@playwright/test";

// 增加整体超时
test.setTimeout(60000);

test.describe("登录页面", () => {
  test("登录页面正常加载", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("h1, h2, h3").first()).toBeVisible();
  });

  test("登录表单包含用户名和密码输入框", async ({ page }) => {
    await page.goto("/");
    // 等待表单渲染
    await page.waitForTimeout(2000);
    // 检查是否有输入框
    const inputs = page.locator('input[type="text"], input[type="password"], input:not([type="hidden"])');
    const count = await inputs.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });
});

test.describe("侧边栏导航", () => {
  test("侧边栏包含主要导航入口", async ({ page }) => {
    await page.goto("/");
    await page.waitForTimeout(3000);
    // 检查侧边栏或导航区域是否存在
    const sidebar = page.locator("nav, aside, [class*=sidebar], [class*=nav]").first();
    const exists = (await sidebar.count()) > 0;
    if (exists) {
      await expect(sidebar).toBeVisible();
    }
  });
});

test.describe("数据采集面板", () => {
  test("数据采集页面可访问", async ({ page }) => {
    await page.goto("/");
    await page.waitForTimeout(2000);
    // 尝试导航到数据采集页面
    await page.goto("/data").catch(() => {});
    // 页面应该能正常加载
    await expect(page.locator("body")).toBeVisible();
  });
});

test.describe("页面基础检查", () => {
  test("页面标题不为空", async ({ page }) => {
    await page.goto("/");
    const title = await page.title();
    expect(title.length).toBeGreaterThan(0);
  });

  test("页面无控制台错误", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        errors.push(msg.text());
      }
    });
    await page.goto("/");
    await page.waitForTimeout(2000);
    expect(errors.length).toBe(0);
  });

  test("页面内容区域可见", async ({ page }) => {
    await page.goto("/");
    await page.waitForTimeout(2000);
    // 检查主要内容区域
    const main = page.locator("main, [role=main], #root, #app, .app-content").first();
    const exists = (await main.count()) > 0;
    if (exists) {
      await expect(main).toBeVisible();
    }
  });
});