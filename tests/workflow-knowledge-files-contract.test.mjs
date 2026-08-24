// 工作流「知识检索」节点 files 模式（选具体文件当数据源）的契约测试。
// ① 对生产源码断言：files 模式按 node.knowledgeDocs 精确取文件；
//    企业文档仍带 visibility 权限子句（重校，不信前端）；个人知识 IN(...) 且 owner_email=?。
// ② 类型与前端：WorkflowNode 带 knowledgePick/knowledgeDocs；构建器渲染分组勾选清单。
// ③ 在内存 SQLite 中复现语义：勾选无权企业文档/他人个人知识都读不出。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const engine = await readFile(new URL("../app/api/modules/_workflow.ts", import.meta.url), "utf8");
const console_ = await readFile(new URL("../app/Console.tsx", import.meta.url), "utf8");
const sharedTypes = await readFile(new URL("../app/features/shared-types.ts", import.meta.url), "utf8");
const sharedApi = await readFile(new URL("../app/api/modules/_shared.ts", import.meta.url), "utf8");

test("知识节点存在 files 分支，按 node.knowledgeDocs 取具体文件", () => {
  assert.match(engine, /node\.knowledgePick === "files" && node\.knowledgeDocs\?\.length/, "缺 files 模式分支。");
  assert.match(engine, /startsWith\("e:"\)/, "缺企业文档前缀 e: 解析。");
  assert.match(engine, /startsWith\("p:"\)/, "缺个人知识前缀 p: 解析。");
});

test("files 模式：企业查询仍带 visibility 权限子句（不越权）", () => {
  const idx = engine.indexOf('node.knowledgePick === "files"');
  const seg = engine.slice(idx, idx + 1600);
  assert.match(seg, /knowledge_documents WHERE id IN/, "企业文档必须按 id IN 精确取。");
  assert.match(seg, /visibility='全员' OR visibility=\? OR \(visibility='部门' AND department_id=\?\)/, "企业查询必须保留 visibility 权限条件。");
});

test("files 模式：个人知识 IN(...) 且始终限定 owner_email=?", () => {
  const idx = engine.indexOf('node.knowledgePick === "files"');
  const seg = engine.slice(idx, idx + 1600);
  assert.match(seg, /personal_knowledge WHERE id IN/, "个人知识必须按 id IN 精确取。");
  assert.match(seg, /AND owner_email=\? ORDER BY/, "个人知识查询必须始终带 owner_email=? 约束。");
});

test("id 解析过滤成正整数，杜绝注入", () => {
  assert.match(engine, /Number\.isInteger\(n\) && n > 0/, "带前缀 id 必须 Number 化并过滤成正整数。");
});

test("WorkflowNode 类型（前后端）都带 knowledgePick/knowledgeDocs", () => {
  assert.match(sharedTypes, /knowledgePick\?: "library" \| "files"/, "前端缺 knowledgePick。");
  assert.match(sharedTypes, /knowledgeDocs\?: string\[\]/, "前端缺 knowledgeDocs。");
  assert.match(sharedApi, /knowledgePick\?: "library" \| "files"/, "后端缺 knowledgePick。");
  assert.match(sharedApi, /knowledgeDocs\?: string\[\]/, "后端缺 knowledgeDocs。");
});

test("构建器渲染分组勾选清单（整个库/指定文件切换 + 前缀 id + 全选/清空）", () => {
  assert.match(console_, /指定文件/, "缺“指定文件”模式切换。");
  assert.match(console_, /整个库/, "缺“整个库”模式切换。");
  assert.match(console_, /`e:\$\{d\.id\}`/, "企业文件复选框必须用 e: 前缀 id。");
  assert.match(console_, /`p:\$\{p\.id\}`/, "个人文件复选框必须用 p: 前缀 id。");
  assert.match(console_, /全选/, "缺“全选”。");
  assert.match(console_, /清空/, "缺“清空”。");
});

test("files 语义在 SQLite 中可复现：无权企业文档与他人个人知识被挡", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE knowledge_documents (id INTEGER PRIMARY KEY, title TEXT, content TEXT, visibility TEXT, department_id INTEGER, updated_at TEXT)");
  db.exec("CREATE TABLE personal_knowledge (id INTEGER PRIMARY KEY, owner_email TEXT, title TEXT, content TEXT, updated_at TEXT)");
  // A=全员企业(可见)、B=部门受限企业(actor 非该部门, 无权)
  db.prepare("INSERT INTO knowledge_documents(id,title,content,visibility,department_id,updated_at) VALUES(1,'A','ent-A','全员',NULL,'2026-08-19')").run();
  db.prepare("INSERT INTO knowledge_documents(id,title,content,visibility,department_id,updated_at) VALUES(2,'B','ent-B','部门',99,'2026-08-19')").run();
  // C=本人个人、D=他人个人
  db.prepare("INSERT INTO personal_knowledge(id,owner_email,title,content,updated_at) VALUES(1,'me@x.com','C','per-C','2026-08-19')").run();
  db.prepare("INSERT INTO personal_knowledge(id,owner_email,title,content,updated_at) VALUES(2,'other@x.com','D','per-D','2026-08-19')").run();

  const retrieveFiles = (knowledgeDocs, actor, role, unitId) => {
    const entIds = knowledgeDocs.filter(x => x.startsWith("e:")).map(x => Number(x.slice(2))).filter(n => Number.isInteger(n) && n > 0);
    const perIds = knowledgeDocs.filter(x => x.startsWith("p:")).map(x => Number(x.slice(2))).filter(n => Number.isInteger(n) && n > 0);
    const out = [];
    if (entIds.length) {
      const sql = `SELECT content FROM knowledge_documents WHERE id IN (${entIds.map(() => "?").join(",")}) AND (visibility='全员' OR visibility=? OR (visibility='部门' AND department_id=?)) ORDER BY updated_at DESC,id DESC LIMIT 20`;
      for (const r of db.prepare(sql).all(...entIds, role, unitId)) out.push(r.content);
    }
    if (perIds.length) {
      const sql = `SELECT content FROM personal_knowledge WHERE id IN (${perIds.map(() => "?").join(",")}) AND owner_email=? ORDER BY updated_at DESC,id DESC LIMIT 20`;
      for (const r of db.prepare(sql).all(...perIds, actor)) out.push(r.content);
    }
    return out;
  };

  // 勾选全部四个，actor 不属部门 99：应只回 A(全员) 和 C(本人)。
  const got = retrieveFiles(["e:1", "e:2", "p:1", "p:2"], "me@x.com", "销售经理", -1);
  assert.deepEqual(got.sort(), ["ent-A", "per-C"], "无权企业文档 B 与他人个人知识 D 必须被挡。");

  // 只勾企业 A：只回 A。
  assert.deepEqual(retrieveFiles(["e:1"], "me@x.com", "销售经理", -1), ["ent-A"]);
  // 非法 id 被过滤：不报错、不返回。
  assert.deepEqual(retrieveFiles(["e:abc", "p:0", "x:1"], "me@x.com", "销售经理", -1), []);

  db.close();
});
