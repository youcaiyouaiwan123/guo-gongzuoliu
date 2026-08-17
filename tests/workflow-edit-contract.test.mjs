// 持续任务「编辑」能力的契约测试。
//
// 背景：主动制/持续任务一度只能建、不能改——route.ts 的 type:"workflow" 分支只有 INSERT。
// 加了「带数字 id 就 UPDATE」的分叉后，这里把三件事锁死，防止回归：
//   ① 列表 SELECT 能取到编辑回填要用的 6 个别名列（缺一列前端表单就填不回去）；
//   ② workflow 分支存在 id>0 → UPDATE workflows，且带 created_by / 管理员 权限校验；
//   ③ UPDATE 语句不触碰 created_by / created_at / status / last_run_at / last_triggered_at
//      （保留任务归属与主动制冷却历史）。
//
// 测试直接从生产源码提取 SQL / 断言真实实现，而非复制品：某处被改回只 INSERT 即刻失败。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const cache = new Map();
async function source(rel) {
  if (!cache.has(rel)) cache.set(rel, await readFile(new URL(`../${rel}`, import.meta.url), "utf8"));
  return cache.get(rel);
}
function preparedStatements(text) {
  return [...text.matchAll(/prepare\(\s*"((?:[^"\\]|\\.)*)"/g)].map(m => m[1]);
}
function extractPreparedSql(text, needle) {
  return preparedStatements(text).find(sql => sql.includes(needle)) || null;
}

test("列表 SELECT 能在真实库上取到编辑回填要用的别名列", async () => {
  const sql = extractPreparedSql(await source("app/api/modules/route.ts"), "FROM workflows ORDER BY id DESC");
  assert.ok(sql, "未找到工作流列表 SELECT，实现可能已被改写。");

  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE workflows(id INTEGER PRIMARY KEY, name TEXT, trigger_type TEXT, steps TEXT, status TEXT, loop_type TEXT, review_mode TEXT, review_standard TEXT, stop_condition TEXT, max_loops INTEGER, final_action TEXT, failure_action TEXT, goal TEXT, schedule_time TEXT, watch_source_type TEXT, watch_source_ref TEXT, trigger_condition TEXT, check_interval_min INTEGER, enabled INTEGER, last_checked_at TEXT, last_check_result TEXT, last_check_detail TEXT, last_run_at TEXT, created_at TEXT, created_by TEXT, next_run_at TEXT, last_triggered_at TEXT)");
  db.exec("INSERT INTO workflows(id,name,trigger_type,steps,status,loop_type,review_mode,review_standard,stop_condition,max_loops,final_action,failure_action,goal,schedule_time,watch_source_type,watch_source_ref,trigger_condition,check_interval_min,enabled,last_run_at,created_at) VALUES (7,'监测A','事件触发','[]','已启用','主动制','明确标准','','',3,'通知负责人','通知负责人','看板异动','','data_source','12','出现异常',15,1,NULL,'2026-01-01')");

  const row = db.prepare(sql).get();
  // 缺任一别名列，前端 editWorkflow 回填就会拿到 undefined、表单填不回去。
  for (const col of ["watchSourceType", "watchSourceRef", "triggerCondition", "checkIntervalMin", "scheduleTime", "enabled"]) {
    assert.ok(col in row, `列表 SELECT 缺少别名列 ${col}。`);
  }
  assert.equal(row.watchSourceType, "data_source");
  assert.equal(row.watchSourceRef, "12");
  assert.equal(row.triggerCondition, "出现异常");
  assert.equal(row.checkIntervalMin, 15);
});

test("workflow 分支存在 id>0 → UPDATE workflows，并带创建者/管理员权限校验", async () => {
  const text = await source("app/api/modules/route.ts");
  const update = extractPreparedSql(text, "UPDATE workflows SET");
  assert.ok(update, "未找到 UPDATE workflows——编辑分叉可能缺失，退回了只 INSERT。");
  assert.ok(update.includes("WHERE id=?"), "UPDATE 应按 id 定位单条任务。");

  // 权限：非创建者且非管理员应被 403 挡下。
  assert.ok(/created_by/.test(text) && /createdBy/.test(text), "编辑分叉应读出 created_by 判断归属。");
  assert.ok(/只能编辑自己创建的任务/.test(text), "应对非创建者非管理员返回明确拒绝文案。");
  assert.ok(/user\.role\s*!==\s*"管理员"/.test(text), "权限校验应放行管理员。");
});

test("UPDATE 只改任务定义，不触碰归属与冷却历史列", async () => {
  const update = extractPreparedSql(await source("app/api/modules/route.ts"), "UPDATE workflows SET");
  // SET 子句截到 WHERE 之前，只看被写的列。
  const setClause = update.slice(update.indexOf("SET"), update.indexOf("WHERE"));
  for (const col of ["created_by", "created_at", "status", "last_run_at", "last_triggered_at"]) {
    assert.ok(!setClause.includes(col), `编辑不应改写 ${col}（保留任务归属与主动制冷却历史）。`);
  }
  // 但该改的定义列必须在。
  for (const col of ["name=", "steps=", "watch_source_type=", "trigger_condition=", "check_interval_min="]) {
    assert.ok(setClause.includes(col), `UPDATE 应覆盖 ${col}。`);
  }
});

test("前端仅对持续任务显示「编辑」，透传 editWorkflow", async () => {
  const panel = await source("app/features/workflows/WorkflowsPanel.tsx");
  assert.ok(/editWorkflow:\s*\(w:\s*Workflow\)\s*=>\s*void/.test(panel), "WorkflowsPanel 应声明 editWorkflow 属性。");
  assert.ok(panel.includes('w.loopType&&w.loopType!=="单次"'), "编辑按钮应仅在持续任务（loopType≠单次）时渲染，builder 型不显示。");

  const console_ = await source("app/Console.tsx");
  assert.ok(console_.includes("editWorkflow={editWorkflow}"), "Console 应把 editWorkflow 透传给 WorkflowsPanel。");
  assert.ok(console_.includes("setEditingWorkflowId"), "Console 应有 editingWorkflowId 状态驱动新建/编辑切换。");
  assert.ok(/id:\s*String\(editingWorkflowId\)/.test(console_), "编辑提交时 payload 应带上 id 走 UPDATE。");
});
