import { chromium } from "playwright-core";

const BASE = "http://127.0.0.1";
const EXEC = process.env.PW_CHROME;
const email = process.env.ADMIN_USER;
const password = process.env.ADMIN_PASS;
const shot = (page, name) => page.screenshot({ path: `/tmp/qa-${name}.png`, fullPage: false });

const browser = await chromium.launch({ executablePath: EXEC, args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });

const login = await ctx.request.post(`${BASE}/api/auth/login`, { data: { email, password } });
console.log("LOGIN", login.status());
if (!login.ok()) { console.log(await login.text()); await browser.close(); process.exit(1); }

const page = await ctx.newPage();
await page.goto(BASE, { waitUntil: "networkidle" });

// 进入知识库 tab（分组折叠则先展开）
const nav = page.locator('.navItem[data-tab="knowledge"]');
if (!(await nav.isVisible())) {
  await page.locator('.navGroup:has(.navItem[data-tab="knowledge"]) .navGroupToggle').click();
}
await nav.click();
await page.waitForTimeout(1200);
await shot(page, "1-knowledge-grid");
console.log("cards:", await page.locator(".knowledgeCard").count());

// 点第一张企业卡 → 详情弹窗
const card = page.locator(".knowledgeCard").first();
if (await card.count()) {
  await card.click();
  await page.waitForSelector(".knowledgeDetailModal", { timeout: 5000 });
  await page.waitForTimeout(500);
  await shot(page, "2-detail");
  console.log("detail meta rows:", await page.locator(".knowledgeDetailMeta div").count());

  // 切编辑态
  const editBtn = page.locator(".knowledgeDetailModal .modalActions button", { hasText: "编辑" });
  if (await editBtn.count()) {
    await editBtn.first().click();
    await page.waitForTimeout(400);
    await shot(page, "3-edit-form");
    console.log("edit form present:", await page.locator(".knowledgeEditForm").count() > 0);
  } else {
    console.log("no edit button (canEdit=false)");
  }
}

await browser.close();
console.log("DONE");
