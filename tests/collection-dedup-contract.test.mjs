// 采集入库去重的契约测试。
// ① 对生产源码断言：自动入库路径在 INSERT 前必须先按 content 查重（个人库、企业库各一处），
//    且用 insertedKnowledge 门控运行状态，防止有人把守卫删掉让重复回潮。
// ② 在内存 SQLite 中重放去重语义：同内容重跑只留 1 条，内容变化才新增。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const src = await readFile(new URL("../app/api/modules/_collection.ts", import.meta.url), "utf8");

test("自动入库前必须按 content 查重（个人库）", () => {
  const guard = src.indexOf("SELECT id FROM personal_knowledge WHERE owner_email=? AND content=?");
  const insert = src.indexOf("INSERT INTO personal_knowledge");
  assert.ok(guard > -1, "个人库入库前缺少 content 查重守卫。");
  assert.ok(insert > -1 && guard < insert, "content 查重必须早于 INSERT INTO personal_knowledge。");
});

test("自动入库前必须按 content 查重（企业库）", () => {
  const guard = src.indexOf("SELECT id FROM knowledge_documents WHERE created_by=? AND category=? AND content=?");
  assert.ok(guard > -1, "企业库自动入库前缺少 content 查重守卫。");
  // 该守卫必须位于自动入库分支（record_only 之后、autoCreated 运行记录之前）。
  const autoRun = src.indexOf("const autoCreated =");
  assert.ok(autoRun > -1 && guard < autoRun, "企业库查重必须在自动入库分支内。");
});

test("是否新增用 insertedKnowledge 门控运行状态", () => {
  assert.match(src, /let insertedKnowledge = false/, "必须有 insertedKnowledge 标志。");
  assert.match(src, /insertedKnowledge = true/, "命中新增分支时必须置 insertedKnowledge=true。");
  assert.match(src, /const autoRunStatus = insertedKnowledge \?/, "运行状态必须由 insertedKnowledge 决定（新增 vs 跳过）。");
});

test("去重语义在 SQLite 中可复现：同内容只留 1 条，变内容才新增", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE personal_knowledge (id INTEGER PRIMARY KEY, owner_email TEXT, content TEXT)");
  const ingest = (owner, content) => {
    const dup = db.prepare("SELECT id FROM personal_knowledge WHERE owner_email=? AND content=? ORDER BY id DESC LIMIT 1").get(owner, content);
    if (dup) return false;
    db.prepare("INSERT INTO personal_knowledge(owner_email,content) VALUES(?,?)").run(owner, content);
    return true;
  };
  const A = "| 客户公司 | 客户姓名 |\n| 杭州明创 | 王磊 |";
  const B = "| 客户公司 | 客户姓名 |\n| 苏州云帆 | 张辉 |";
  // 同一份静态内容重跑 5 次：只应入库 1 条。
  const first = [ingest("admin", A), ingest("admin", A), ingest("admin", A), ingest("admin", A), ingest("admin", A)];
  assert.deepEqual(first, [true, false, false, false, false], "同内容仅首次入库，其余去重跳过。");
  // 内容变化：应新增。
  assert.equal(ingest("admin", B), true, "内容变化必须新增。");
  // 换个 owner 即便同内容也各自独立。
  assert.equal(ingest("other", A), true, "不同用户的同内容互不影响。");

  assert.equal(db.prepare("SELECT count(*) c FROM personal_knowledge").get().c, 3, "最终应只有 3 条（admin:A、admin:B、other:A）。");
});
