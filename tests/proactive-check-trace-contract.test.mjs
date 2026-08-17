// 主动制「检查痕迹 + 判定异常分流 + free 观察增强」的契约测试。
//
// 背景：主动制任务从前端测试「不能触发」。排查发现三件事：
//   ① 判定「未命中/命中/失败」全不落库，前端看不到它在工作 → 加 last_checked_at 三列痕迹；
//   ② judgeTrigger 把模型调用失败也吞成「未命中」，真故障无从区分 → 让模型异常抛给 tick 记「检查失败」；
//   ③ free（通用观察）只喂一句「任务目标」，任何「数量/出现X」类条件永远看不到证据 →
//      free 观察聚合创建者近期真实采集结果 + 目标相关知识。
// 这里从生产源码提取实现直接断言，任一处被改回旧行为即失败。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const cache = new Map();
async function source(rel) {
  if (!cache.has(rel)) cache.set(rel, await readFile(new URL(`../${rel}`, import.meta.url), "utf8"));
  return cache.get(rel);
}

test("schema 为 workflows 补齐三列检查痕迹", async () => {
  const shared = await source("app/api/modules/_shared.ts");
  for (const col of ["last_checked_at", "last_check_result", "last_check_detail"]) {
    assert.ok(shared.includes(`ensureColumn(runtime.DB, "workflows", "${col}"`), `_shared.ts 应通过 ensureColumn 补 ${col}。`);
  }
});

test("列表 SELECT 把三列痕迹别名带给前端", async () => {
  const route = await source("app/api/modules/route.ts");
  const sql = [...route.matchAll(/prepare\(\s*"((?:[^"\\]|\\.)*)"/g)].map(m => m[1]).find(s => s.includes("FROM workflows ORDER BY id DESC"));
  assert.ok(sql, "未找到工作流列表 SELECT。");
  for (const alias of ["last_checked_at AS lastCheckedAt", "last_check_result AS lastCheckResult", "last_check_detail AS lastCheckDetail"]) {
    assert.ok(sql.includes(alias), `列表 SELECT 缺别名 ${alias}。`);
  }
});

test("tick 在 未命中/已触发/检查失败/观察为空 都落检查痕迹", async () => {
  const tick = await source("app/api/gateway/tick/route.ts");
  // recordCheck 落库时更新 last_checked_at 三列。
  assert.ok(/UPDATE workflows SET last_checked_at=\?,last_check_result=\?,last_check_detail=\?/.test(tick), "recordCheck 应更新 last_checked_at 三列。");
  for (const result of ["未命中", "已触发", "检查失败", "观察为空"]) {
    assert.ok(tick.includes(`recordCheck(task.id, "${result}"`), `tick 应在「${result}」时记痕迹。`);
  }
});

test("judgeTrigger 不再吞模型调用异常（askModel 在 try 之外）", async () => {
  const wf = await source("app/api/modules/_workflow.ts");
  const start = wf.indexOf("export async function judgeTrigger");
  assert.ok(start >= 0, "未找到 judgeTrigger。");
  const body = wf.slice(start, wf.indexOf("export async function workflowApprover"));
  const askAt = body.indexOf("await askModel");
  const tryAt = body.indexOf("try {");
  assert.ok(askAt >= 0 && tryAt >= 0, "judgeTrigger 应保留 askModel 调用与解析 try。");
  assert.ok(askAt < tryAt, "askModel 应在 try 之外，模型异常才会抛给 tick 记「检查失败」。");
  // 旧的「一律吞成空未命中」写法必须消失。
  assert.ok(!/return \{ trigger: false, reason: "" \};\s*\n\s*\} catch/.test(body), "judgeTrigger 不应再把模型异常吞成空未命中。");
});

test("free 观察聚合近期采集结果与目标相关知识", async () => {
  const tick = await source("app/api/gateway/tick/route.ts");
  assert.ok(/data_collection_runs WHERE actor=\?/.test(tick), "free 观察应纳入创建者近期采集结果。");
  assert.ok(tick.includes("FROM knowledge_documents"), "free 观察应纳入目标相关知识文档。");
});
