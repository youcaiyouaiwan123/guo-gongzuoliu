import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(relativePath) {
  return readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

function mediaBlocks(css, heading) {
  const blocks = [];
  let cursor = 0;

  while (cursor < css.length) {
    const start = css.indexOf(heading, cursor);
    if (start === -1) break;

    const openingBrace = css.indexOf("{", start + heading.length);
    let depth = 1;
    let end = openingBrace + 1;
    while (end < css.length && depth > 0) {
      if (css[end] === "{") depth += 1;
      if (css[end] === "}") depth -= 1;
      end += 1;
    }

    blocks.push(css.slice(start, end));
    cursor = end;
  }

  return blocks;
}

test("独立登录入口复用未登录首页的品牌布局", async () => {
  const authPage = await source("app/AuthPage.tsx");

  assert.match(authPage, /className="loginPage authPage"/, "独立登录页必须复用 loginPage 外层网格。");
  assert.match(authPage, /className="loginBrand authHero"/, "独立登录页必须复用 loginBrand 品牌区域。");
  assert.match(authPage, /className="loginLogo"/, "独立登录页标志必须复用 loginLogo 尺寸约束。");
  assert.match(authPage, /className="siteFooter loginFooter"/, "独立登录页必须复用固定页脚布局。");
});

test("登录页在 900 像素及以下切换为无横向挤压的单栏", async () => {
  const css = await source("app/styles/brand.css");
  const responsiveBlock = mediaBlocks(css, "@media (max-width: 900px)")
    .find(block => /\.loginPage\s*\{[^}]*grid-template-columns:\s*1fr/s.test(block));

  assert.ok(responsiveBlock, "900px 响应式规则必须将 loginPage 切换为单栏。");
  assert.match(responsiveBlock, /\.loginBrand\s*\{[^}]*display:\s*none/s, "单栏登录页必须隐藏品牌区，为表单保留完整宽度。");
  assert.match(responsiveBlock, /\.loginCard\s*\{[^}]*width:\s*min\(430px,\s*100%\)/s, "登录卡片宽度必须受视口约束。");
  assert.match(responsiveBlock, /\.siteFooter\s*\{[^}]*grid-column:\s*1/s, "单栏页脚必须回到第一列。");
});
