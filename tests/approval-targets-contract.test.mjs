// 审批人下拉（approvalTargets）与「创建智能体」审批的契约测试。
//
// 背景：governance/route.ts 的 approvalTargets 一度返回 { current, candidates } 对象，
// 而前端（Console.tsx）按扁平数组消费（.map/.find/.length），导致「发起审批」弹窗一渲染
// 就抛 TypeError、整屏白屏，审批也永远发不出去。这里把两端约定锁死，防止再退回对象形状。
//
// 测试直接从生产源码提取 SQL / 断言真实实现，而非复制品：某处被改回不安全写法即刻失败。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const cache = new Map();
async function source(rel) {
  if (!cache.has(rel)) cache.set(rel, await readFile(new URL(`../${rel}`, import.meta.url), "utf8"));
  return cache.get(rel);
}
function extractPreparedSql(text, needle) {
  for (const m of text.matchAll(/prepare\(\s*"((?:[^"\\]|\\.)*)"/g)) {
    if (m[1].includes(needle)) return m[1];
  }
  return null;
}
// 截取某个 `async function <name>` 的函数体到下一个 `async function` 之前。
function functionBody(text, name) {
  const start = text.indexOf(`async function ${name}`);
  if (start < 0) return "";
  const rest = text.slice(start + 1);
  const next = rest.indexOf("\nasync function ");
  return next < 0 ? rest : rest.slice(0, next);
}

test("approvalTargets 的 SELECT 能在真实库上取到映射列，并只回在岗成员", async () => {
  const sql = extractPreparedSql(await source("app/api/governance/route.ts"), "FROM org_members m LEFT JOIN org_units u");
  assert.ok(sql, "未在 governance/route.ts 找到 approvalTargets 的 SELECT，实现可能已被改写。");

  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE org_units(id INTEGER PRIMARY KEY, name TEXT, sort_order INTEGER DEFAULT 0, manager_email TEXT DEFAULT '')");
  db.exec("CREATE TABLE org_members(email TEXT PRIMARY KEY, unit_id INTEGER, job_title TEXT DEFAULT '员工', direct_manager_email TEXT DEFAULT '', status TEXT DEFAULT '在岗')");
  db.exec("INSERT INTO org_units VALUES (1,'销售部',0,'boss@x.com')");
  db.exec("INSERT INTO org_members VALUES ('me@x.com',1,'专员','mgr@x.com','在岗'),('mgr@x.com',1,'经理','','在岗'),('off@x.com',1,'前员工','','离职')");

  const rows = db.prepare(sql).all();
  assert.deepEqual(rows.map(r => r.email).sort(), ["me@x.com", "mgr@x.com"], "离职成员不应出现在候选里。");

  const me = rows.find(r => r.email === "me@x.com");
  // 前端映射需要这些别名列；缺一个下拉就会渲染出空白项。
  assert.equal(me.jobTitle, "专员");
  assert.equal(me.unitName, "销售部");
  assert.equal(me.directManagerEmail, "mgr@x.com");
  assert.equal(me.unitManagerEmail, "boss@x.com");
});

test("approvalTargets 返回扁平数组且带 recommended，未退回 {current,candidates} 对象", async () => {
  const body = functionBody(await source("app/api/governance/route.ts"), "approvalTargets");
  assert.ok(body, "未找到 approvalTargets 函数。");
  assert.ok(body.includes(".filter(item => item.email !== email)"), "应过滤掉申请人本人。");
  assert.ok(/recommended:/.test(body), "数组元素必须含 recommended 字段（前端据此设默认审批人）。");
  assert.ok(!/return\s*\{\s*current\s*,\s*candidates\s*\}/.test(body), "禁止退回 {current,candidates} 对象——会让前端 .map 抛错白屏。");
});

test("Console.tsx 始终按数组消费 approvalTargets", async () => {
  const text = await source("app/Console.tsx");
  assert.ok(text.includes("approvalTargets.map("), "审批弹窗应对 approvalTargets 调用 .map（数组）。");
  assert.ok(text.includes("ApprovalTarget[]"), "approvalTargets 状态类型应为数组 ApprovalTarget[]。");
});

test("员工创建智能体走审批：写入审批请求、置为待审批，审批通过后启用", async () => {
  const modules = await source("app/api/modules/route.ts");
  assert.ok(modules.includes("workflowApprover(actor)"), "应用 workflowApprover 自动推导审批人。");
  assert.ok(
    extractPreparedSql(modules, "INSERT INTO approval_requests") &&
      /"创建智能体"/.test(modules),
    "员工创建智能体时应插入一条「创建智能体」审批请求。",
  );

  const gov = await source("app/api/governance/route.ts");
  assert.ok(gov.includes("agent_id AS agentId"), "decide 需读出 agentId 才能回写智能体状态。");
  const enable = extractPreparedSql(gov, "UPDATE ai_agents SET status=?");
  assert.ok(enable && enable.includes("status='待审批'"), "审批结果只应作用于「待审批」的智能体，避免误改其它状态。");
});
