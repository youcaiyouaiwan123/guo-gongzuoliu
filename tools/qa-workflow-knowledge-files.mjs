import { chromium } from "playwright-core";

const BASE = "http://localhost:3000";
const EXEC = process.env.PW_CHROME;
const email = (process.env.ADMIN_USER || "admin").toLowerCase();
const password = process.env.ADMIN_PASS || "";
const shot = (page, name) => page.screenshot({ path: `/tmp/qa-wf-${name}.png`, fullPage: false });
const log = (...a) => console.log(...a);

const browser = await chromium.launch({ executablePath: EXEC, args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } });

const login = await ctx.request.post(`${BASE}/api/auth/login`, { data: { email, password } });
log("LOGIN", login.status());
if (!login.ok()) { log(await login.text()); await browser.close(); process.exit(1); }

const page = await ctx.newPage();
const errors = [];
page.on("pageerror", e => errors.push(String(e)));
page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
await page.goto(BASE, { waitUntil: "networkidle" });

// 进入「工作流」tab
const nav = page.locator('.navItem[data-tab="workflows"]');
if (await nav.count() && !(await nav.isVisible())) {
  const grp = page.locator('.navGroup:has(.navItem[data-tab="workflows"]) .navGroupToggle');
  if (await grp.count()) await grp.click();
}
await nav.first().click();
await page.waitForTimeout(1000);
await shot(page, "1-workflows");

// 打开「创建工作流」弹窗
const createBtn = page.getByRole("button", { name: /新建|创建|新增/ }).first();
await createBtn.click();
await page.waitForTimeout(600);

// 选「企业宣传」模板（含知识检索节点）
const tpl = page.getByRole("button", { name: /企业宣传|宣传/ }).first();
if (await tpl.count()) { await tpl.click(); await page.waitForTimeout(500); }
await shot(page, "2-builder");

// 找到 type=knowledge 的 builder 节点：定位含「指定文件」按钮的节点
const pickTabBtn = page.getByRole("button", { name: "指定文件" }).first();
log("指定文件按钮数:", await page.getByRole("button", { name: "指定文件" }).count());
if (!(await pickTabBtn.count())) {
  // 模板没有知识节点则手动把某节点类型改成「知识检索」
  const typeSelect = page.locator(".builderNode select").first();
  await typeSelect.selectOption({ label: "知识检索" });
  await page.waitForTimeout(400);
}
await page.getByRole("button", { name: "指定文件" }).first().click();
await page.waitForTimeout(500);
await shot(page, "3-files-mode");

// 断言分组勾选清单渲染
const filesBox = page.locator(".knowledgePickFiles");
const groups = page.locator(".knowledgePickGroup");
const entGroup = page.locator(".knowledgePickGroup:has-text('企业知识库')");
const perGroup = page.locator(".knowledgePickGroup:has-text('个人知识库')");
const bar = page.locator(".knowledgePickBar");
log("knowledgePickFiles 存在:", await filesBox.count() > 0);
log("分组数(应=2):", await groups.count());
log("企业组存在:", await entGroup.count() > 0, "个人组存在:", await perGroup.count() > 0);
log("全选/清空栏存在:", await bar.count() > 0);
log("企业复选框数:", await page.locator(".knowledgePickGroup:has-text('企业知识库') input[type=checkbox]").count());
log("个人复选框数:", await page.locator(".knowledgePickGroup:has-text('个人知识库') input[type=checkbox]").count());

// 若有文件，勾一个看计数变化
const firstCb = page.locator(".knowledgePickItem input[type=checkbox]").first();
if (await firstCb.count()) {
  await firstCb.check();
  await page.waitForTimeout(200);
  log("勾选后计数文本:", (await bar.locator("small").innerText().catch(()=>"?")));
  await shot(page, "4-checked");
}

// 切回「整个库」确认旧控件还在
await page.getByRole("button", { name: "整个库" }).first().click();
await page.waitForTimeout(300);
log("整个库模式-范围下拉存在:", await page.locator(".workflowKnowledgePick select").count() > 0);
await shot(page, "5-library-mode");

log("PAGE ERRORS:", errors.length ? errors.slice(0, 5) : "无");
await browser.close();
