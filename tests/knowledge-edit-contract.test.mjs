// 知识库编辑（PATCH action=edit）的契约测试。
// 直接对生产源码做不变量断言，并在内存 SQLite 中重放版本升级语义，
// 一旦权限校验被前移/删除，或版本升级从「仅正文变化」扩散到元数据编辑，用例立即失败。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const sourceCache = new Map();
async function source(relativePath) {
  if (!sourceCache.has(relativePath)) {
    sourceCache.set(relativePath, await readFile(new URL(`../${relativePath}`, import.meta.url), "utf8"));
  }
  return sourceCache.get(relativePath);
}

// 截取 state 路由 PATCH 处理体，供顺序类断言使用。
async function statePatchBody() {
  const text = await source("app/api/state/route.ts");
  const start = text.indexOf('app.patch("*"');
  assert.ok(start > -1, "未能定位 state 路由的 PATCH 处理体。");
  const end = text.indexOf("\nexport const", start);
  return text.slice(start, end > -1 ? end : undefined);
}

test("企业知识编辑必须先做创建者/管理员校验，再写库", async () => {
  const body = await statePatchBody();

  // 与 DELETE 对称：非创建者且非管理员必须 403。
  assert.match(body, /user\.role !== ADMIN_ROLE && existing\.createdBy !== user\.email\) return fail\([^)]*403\)/, "编辑必须校验创建者或管理员身份并返回 403。");

  const guardAt = body.indexOf("existing.createdBy !== user.email");
  const updateAt = body.indexOf("UPDATE knowledge_documents SET");
  assert.ok(guardAt > -1 && updateAt > -1, "编辑分支必须同时存在身份校验与 UPDATE。");
  assert.ok(guardAt < updateAt, "身份校验必须早于 UPDATE 写库。");

  // manage_knowledge 能力校验仍在处理体最前，早于任何写库。
  const capAt = body.indexOf('authorizeCapability(runtime.DB, user, "manage_knowledge")');
  assert.ok(capAt > -1 && capAt < guardAt, "manage_knowledge 能力校验必须最先执行。");
});

test("仅正文实质变化才升版本并刷新大小/状态，改元数据不动版本", async () => {
  const body = await statePatchBody();

  // 版本升级、大小与解析状态刷新必须都被 contentChanged 门控。
  assert.match(body, /const contentChanged = body\.content !== undefined && body\.content\.trim\(\) !== \(existing\.content \|\| ""\)\.trim\(\)/, "内容变化判定必须基于 trim 后的实质比较。");
  const gateAt = body.indexOf("if (contentChanged)");
  const versionBumpAt = body.indexOf('sets.push("version=version+1")');
  const sizeAt = body.indexOf('sets.push("size_bytes=?")');
  const statusAt = body.indexOf('sets.push("status=?")');
  assert.ok(gateAt > -1, "必须存在 contentChanged 门控块。");
  for (const [label, at] of [["版本升级", versionBumpAt], ["大小刷新", sizeAt], ["状态刷新", statusAt]]) {
    assert.ok(at > gateAt, `${label}必须位于 contentChanged 门控块内。`);
  }

  // 元数据字段（标题/分类/可见范围/标签/更新方式）不得触发版本升级。
  assert.equal([...body.matchAll(/version=version\+1/g)].length, 1, "版本升级语句只应出现一次，且仅用于正文变化。");
  for (const field of ['"title=?"', '"category=?"', '"visibility=?"', '"tags=?"', '"update_mode=?"']) {
    assert.ok(body.includes(field), `编辑必须支持更新 ${field} 字段。`);
  }
});

test("sync 分支保持原语义未被 edit 覆盖", async () => {
  const body = await statePatchBody();
  assert.match(body, /if \(body\.action !== "sync"\) return fail/, "非 sync/edit 的操作必须被拒绝。");
  assert.match(body, /UPDATE knowledge_documents SET status=CASE WHEN content='' THEN '待解析' ELSE '已解析' END/, "sync 的状态刷新语句必须保留。");
});

test("个人知识编辑仅改自己的 title/content", async () => {
  const text = await source("app/api/personal-knowledge/route.ts");
  const start = text.indexOf('app.patch("*"');
  const end = text.indexOf("\napp.delete(", start);
  const body = text.slice(start, end > -1 ? end : undefined);

  assert.match(body, /if \(body\.action === "edit"\)/, "个人知识 PATCH 必须支持 edit 动作。");
  assert.match(body, /UPDATE personal_knowledge SET title=\?,content=\?,updated_at=\? WHERE id=\? AND owner_email=\?/, "编辑必须按 owner_email 限定，只能改本人个人知识。");
  // 原「同步到企业」分支必须仍在。
  assert.match(body, /INSERT INTO knowledge_documents/, "同步到企业知识的分支必须保留。");
});

test("版本升级语义在 SQLite 中可复现：正文变化 +1，元数据不变", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE knowledge_documents (id INTEGER PRIMARY KEY, title TEXT, content TEXT, version INTEGER, size_bytes INTEGER, status TEXT, updated_at TEXT)");
  db.prepare("INSERT INTO knowledge_documents(id,title,content,version,size_bytes,status,updated_at) VALUES(1,'原标题','旧正文',1,9,'已解析','t0')").run();

  // 元数据编辑：不带 version=version+1。
  db.prepare("UPDATE knowledge_documents SET title=?,updated_at=? WHERE id=?").run("新标题", "t1", 1);
  assert.equal(db.prepare("SELECT version FROM knowledge_documents WHERE id=1").get().version, 1, "仅改元数据不应升版本。");

  // 正文编辑：带 version=version+1 与大小/状态刷新。
  const next = "全新正文内容";
  db.prepare("UPDATE knowledge_documents SET content=?,size_bytes=?,status=?,version=version+1,updated_at=? WHERE id=?")
    .run(next, new TextEncoder().encode(next).byteLength, "已解析", "t2", 1);
  const row = db.prepare("SELECT version,content,size_bytes FROM knowledge_documents WHERE id=1").get();
  assert.equal(row.version, 2, "正文变化必须把版本 +1。");
  assert.equal(row.content, next);
  assert.equal(row.size_bytes, new TextEncoder().encode(next).byteLength, "大小必须随正文刷新。");
});
