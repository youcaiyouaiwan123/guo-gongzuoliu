// 工作流「知识检索」节点=可选知识库数据源的契约测试。
// ① 对生产源码断言：知识节点按 node.knowledgeScope 决定检索哪些知识库；
//    个人知识始终限定 owner_email=actor（scope 不能放开越权读他人私有沉淀）；
//    默认 all 保持“企业+个人”的旧行为（向后兼容）。
// ② 类型与前端选择器：WorkflowNode 带 knowledgeScope 字段；构建器渲染三档范围。
// ③ 在内存 SQLite 中复现 scope 语义：enterprise 只出企业、personal 只出本人个人、all 两者都出。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const engine = await readFile(new URL("../app/api/modules/_workflow.ts", import.meta.url), "utf8");
const console_ = await readFile(new URL("../app/Console.tsx", import.meta.url), "utf8");
const sharedTypes = await readFile(new URL("../app/features/shared-types.ts", import.meta.url), "utf8");
const sharedApi = await readFile(new URL("../app/api/modules/_shared.ts", import.meta.url), "utf8");

test("知识节点读取 node.knowledgeScope 且默认 all", () => {
  assert.match(engine, /const scope = node\.knowledgeScope \|\| "all"/, "知识节点必须按 node.knowledgeScope 取范围并默认 all。");
});

test("scope 门控：enterprise 跳过个人库、personal 跳过企业库", () => {
  assert.match(engine, /if \(scope !== "personal"\)/, "非 personal 时才查企业知识库。");
  assert.match(engine, /if \(scope !== "enterprise"\)/, "非 enterprise 时才查个人知识库。");
});

test("个人知识始终限定 owner_email=actor（不因 scope 越权）", () => {
  const q = engine.indexOf("SELECT title,content FROM personal_knowledge WHERE owner_email=?");
  assert.ok(q > -1, "个人库检索必须始终带 owner_email=? 约束。");
  // 且该查询处在 scope!=="enterprise" 分支内，其上方就是该 if。
  const branch = engine.indexOf('if (scope !== "enterprise")');
  assert.ok(branch > -1 && branch < q, "个人库检索必须位于 scope!==enterprise 分支内。");
});

test("WorkflowNode 类型（前后端）都带 knowledgeScope", () => {
  assert.match(sharedTypes, /knowledgeScope\?: "all" \| "enterprise" \| "personal"/, "前端 WorkflowNode 缺 knowledgeScope。");
  assert.match(sharedApi, /knowledgeScope\?: "all" \| "enterprise" \| "personal"/, "后端 WorkflowNode 缺 knowledgeScope。");
});

test("构建器为知识节点渲染三档范围选择，且不再落到通用输入框", () => {
  assert.match(console_, /node\.type==="knowledge"&&<div/, "知识节点必须有专属范围选择器。");
  assert.match(console_, /全部知识库（企业\+个人）/, "缺“全部知识库”选项。");
  assert.match(console_, /仅企业知识库/, "缺“仅企业知识库”选项。");
  assert.match(console_, /仅个人知识库/, "缺“仅个人知识库”选项。");
  // knowledge 已从通用 <input> 分支排除，避免同时渲染两个控件。
  assert.match(console_, /!\["input","ai","agent","data","output","save","approval","knowledge"\]\.includes\(node\.type\)/, "knowledge 必须从通用输入分支排除。");
});

test("scope 语义在 SQLite 中可复现", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE knowledge_documents (id INTEGER PRIMARY KEY, title TEXT, content TEXT, visibility TEXT, department_id INTEGER, updated_at TEXT)");
  db.exec("CREATE TABLE personal_knowledge (id INTEGER PRIMARY KEY, owner_email TEXT, title TEXT, content TEXT, updated_at TEXT)");
  db.prepare("INSERT INTO knowledge_documents(title,content,visibility,department_id,updated_at) VALUES('企业客户','ent-A','全员',NULL,'2026-08-19')").run();
  db.prepare("INSERT INTO personal_knowledge(owner_email,title,content,updated_at) VALUES('me@x.com','我的客户','per-A','2026-08-19')").run();
  db.prepare("INSERT INTO personal_knowledge(owner_email,title,content,updated_at) VALUES('other@x.com','别人客户','per-B','2026-08-19')").run();

  const retrieve = (scope, actor, role) => {
    const out = [];
    if (scope !== "personal") {
      for (const r of db.prepare("SELECT content FROM knowledge_documents WHERE (visibility='全员' OR visibility=?) ORDER BY updated_at DESC,id DESC LIMIT 6").all(role)) out.push(r.content);
    }
    if (scope !== "enterprise") {
      for (const r of db.prepare("SELECT content FROM personal_knowledge WHERE owner_email=? ORDER BY updated_at DESC,id DESC LIMIT 6").all(actor)) out.push(r.content);
    }
    return out;
  };

  assert.deepEqual(retrieve("all", "me@x.com", "普通员工"), ["ent-A", "per-A"], "all 应含企业+本人个人。");
  assert.deepEqual(retrieve("enterprise", "me@x.com", "普通员工"), ["ent-A"], "enterprise 只出企业。");
  assert.deepEqual(retrieve("personal", "me@x.com", "普通员工"), ["per-A"], "personal 只出本人个人。");
  // 无论哪种 scope，都拿不到 other@x.com 的私有个人知识。
  for (const scope of ["all", "enterprise", "personal"]) {
    assert.ok(!retrieve(scope, "me@x.com", "普通员工").includes("per-B"), `scope=${scope} 不得读到他人私有个人知识。`);
  }
  db.close();
});
