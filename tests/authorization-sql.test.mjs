// 授权与幂等的 SQL 契约测试。
// 这些用例直接从生产源码中提取 SQL 语句与建表语句后在内存 SQLite 中重放，
// 因此测试的是真实实现而不是复制品：一旦某条 WHERE 条件被改回不安全的写法，用例会立即失败。
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const sourceCache = new Map();

async function source(relativePath) {
  if (!sourceCache.has(relativePath)) {
    sourceCache.set(relativePath, await readFile(new URL(`../${relativePath}`, import.meta.url), "utf8"));
  }
  return sourceCache.get(relativePath);
}

// 抓取 runtime.DB.prepare("...") / db.prepare("...") 中的 SQL 文本，按特征串定位目标语句。
function extractPreparedSql(text, needle) {
  for (const match of text.matchAll(/prepare\(\s*"((?:[^"\\]|\\.)*)"/g)) {
    if (match[1].includes(needle)) return match[1];
  }
  return null;
}

async function locateSql(relativePath, needle) {
  const sql = extractPreparedSql(await source(relativePath), needle);
  assert.ok(sql, `未能在 ${relativePath} 中找到包含“${needle}”的 SQL 语句，实现可能已被改写。`);
  return sql;
}

async function databaseWith(...ddlNeedles) {
  const shared = await source("app/api/modules/_shared.ts");
  const db = new DatabaseSync(":memory:");
  for (const needle of ddlNeedles) {
    const ddl = extractPreparedSql(shared, needle);
    assert.ok(ddl, `未能在 _shared.ts 中找到 ${needle} 的建表语句。`);
    db.exec(ddl);
  }
  return db;
}

// 从 _capabilities.ts 中解析能力目录条目，断言的是生产配置本身而不是复制的常量表。
async function capabilityEntries() {
  const text = await source("app/api/_capabilities.ts");
  const entries = new Map();
  // 能力条目可能带可选的 adminManaged 字段，正则容忍 employee 之后到 } 之间的额外内容。
  for (const match of text.matchAll(/\{\s*key:\s*"([^"]+)",\s*label:\s*"([^"]+)",\s*employee:\s*"([^"]+)"([^}]*)\}/g)) {
    entries.set(match[1], { label: match[2], employee: match[3], adminManaged: /adminManaged:\s*true/.test(match[4]) });
  }
  assert.ok(entries.size > 0, "未能从 _capabilities.ts 解析出任何能力项。");
  return entries;
}

test("个人域能力项对普通员工默认允许，企业级能力项保持收紧", async () => {
  const entries = await capabilityEntries();

  for (const key of ["manage_personal_models", "manage_personal_platform"]) {
    const entry = entries.get(key);
    assert.ok(entry, `能力目录必须包含 ${key}。`);
    assert.equal(entry.employee, "允许", `${key} 属于用户自助配置，普通员工默认必须可用。`);
  }

  // 企业级能力项不得被个人域的引入顺带放开。
  assert.equal(entries.get("manage_models")?.employee, "拒绝");
  assert.equal(entries.get("manage_platform")?.employee, "拒绝");
  assert.equal(entries.get("manage_knowledge")?.employee, "需审批");
});

test("后端硬控制的能力标记为 adminManaged 且员工默认拒绝，manage_help 无后端已移除", async () => {
  const entries = await capabilityEntries();

  // 这些能力后端按角色硬控制（管理员专属或 owner-scoped），不经 role_permissions 逐项判定，
  // 必须标记 adminManaged，权限中心才会锁定员工侧，避免「开关点了不生效」的误导。
  for (const key of ["manage_organization", "manage_approvals", "manage_monitoring", "manage_models", "manage_platform", "external_send"]) {
    const entry = entries.get(key);
    assert.ok(entry, `能力目录必须包含 ${key}。`);
    assert.equal(entry.adminManaged, true, `${key} 后端按角色硬控制，必须标记 adminManaged。`);
    assert.equal(entry.employee, "拒绝", `${key} 员工侧应固定为拒绝，与后端硬控制一致。`);
  }

  // manage_help 没有任何后端路由承接，属于纯误导性开关，应从目录与分组彻底移除。
  assert.equal(entries.get("manage_help"), undefined, "manage_help 无对应后端功能，必须从能力目录移除。");
  const capabilities = await source("app/api/_capabilities.ts");
  assert.doesNotMatch(capabilities, /manage_help/, "manage_help 不应再出现在能力目录或分组中。");

  // 权限中心必须能识别 adminManaged，从而锁定这些开关。
  const panel = await source("app/features/permissions/PermissionsPanel.tsx");
  assert.match(panel, /adminManaged/, "权限中心必须消费 adminManaged 标记以锁定不可配置的能力。");

  // governance 保存权限时，adminManaged 能力对员工必须被强制为拒绝，不能落库误导性策略。
  const governance = await source("app/api/governance/route.ts");
  assert.match(governance, /isAdminManaged/, "governance 必须对 adminManaged 能力强制固定员工侧决策。");
});

test("能力目录是叶子模块，且授权在缺少策略行时按目录默认值判定", async () => {
  const capabilities = await source("app/api/_capabilities.ts");
  const auth = await source("app/api/_auth.ts");

  assert.doesNotMatch(capabilities, /from\s+"\.\/_auth"/, "_capabilities.ts 不得导入 _auth.ts，否则与 authorizeCapability 形成循环依赖。");
  assert.match(auth, /import\s+\{\s*defaultDecisionFor\s*\}\s+from\s+"\.\/_capabilities"/, "authorizeCapability 必须从能力目录取默认决策。");
  assert.match(auth, /defaultDecisionFor\(user\.role, capability\)/, "缺少策略行时必须回落到能力目录默认值。");
  assert.doesNotMatch(auth, /normalizeDecisionValue\(policy\?\.decision \|\| "拒绝"\)/, "不得再把缺少策略行硬编码为拒绝，否则新增能力项在既有库上会被误拒。");
});

test("模型与平台连接的写操作全部经过能力授权", async () => {
  // 这些路由已统一改用 createApp()/Hono 装配：authorizeCapability 从 _app 转出（_app 再从
  // _auth 导出），身份认证由 app.use("*", auth()) 中间件统一完成，写操作在 app.post/app.delete
  // 处理体内校验能力。契约不变——每个写动作都必须在建表/请求体解析之前完成能力授权。
  const expectations = [
    ["app/api/model/route.ts", "manage_personal_models", ["post", "delete"]],
    ["app/api/image-models/route.ts", "manage_personal_models", ["post", "delete"]],
    ["app/api/connectors/route.ts", "manage_personal_platform", ["post"]],
  ];

  for (const [path, capability, verbs] of expectations) {
    const text = await source(path);
    assert.match(text, /import\s+\{[^}]*authorizeCapability[^}]*\}\s+from\s+"\.\.\/_app"/, `${path} 必须从 _app 引入 authorizeCapability。`);
    assert.match(text, /app\.use\(\s*"\*"\s*,\s*auth\(\)\s*\)/, `${path} 必须用 auth() 中间件统一完成身份认证。`);

    for (const verb of verbs) {
      const start = text.indexOf(`app.${verb}("*"`);
      assert.ok(start > -1, `${path} 缺少 ${verb.toUpperCase()} 处理函数。`);
      // 处理体到下一个 app.xxx 处理器或文件路由桥接（export const）为止。
      const bounds = [text.indexOf("\napp.", start + 1), text.indexOf("\nexport const", start + 1)].filter(pos => pos > -1);
      const body = text.slice(start, bounds.length ? Math.min(...bounds) : undefined);

      assert.match(body, new RegExp(`authorizeCapability\\(runtime\\.DB,\\s*user,\\s*"${capability}"\\)`), `${path} 的 ${verb.toUpperCase()} 必须校验 ${capability}。`);

      // 授权必须早于任何建表、业务写入与请求体解析，避免未授权也能触发副作用。
      const authorizeAt = body.indexOf("await authorizeCapability(");
      const schemaAt = body.search(/await (schema|ensureSchema)\(\)/);
      const bodyParseAt = body.search(/await c\.req\.(json|formData|text)\(/);
      assert.ok(authorizeAt > -1, `${path} 的 ${verb.toUpperCase()} 必须在处理体内校验能力。`);
      if (schemaAt > -1) assert.ok(authorizeAt < schemaAt, `${path} 的 ${verb.toUpperCase()} 授权必须早于建表与业务操作。`);
      if (bodyParseAt > -1) assert.ok(authorizeAt < bodyParseAt, `${path} 的 ${verb.toUpperCase()} 授权必须早于解析请求体。`);
    }
  }
});

test("并发审批只有第一次抢占成功，重复处理返回零受影响行", async () => {
  const db = await databaseWith("CREATE TABLE IF NOT EXISTS approval_requests");
  const claimSql = await locateSql("app/api/governance/route.ts", "UPDATE approval_requests SET status=?,approver=?,comment=?,decided_at=?");
  assert.match(claimSql, /status='待审批'/, "审批抢占语句必须限定原状态为待审批，否则无法防止重复处理。");

  db.prepare("INSERT INTO approval_requests(id,requester,request_type,title,reason,status,created_at) VALUES(1,'staff@haixin.test','用车申请','出差用车','客户现场支持','待审批','2026-07-29T00:00:00.000Z')").run();

  const claim = db.prepare(claimSql);
  const first = claim.run("已通过", "boss@haixin.test", "同意", "2026-07-29T01:00:00.000Z", 1);
  const second = claim.run("已拒绝", "manager@haixin.test", "不同意", "2026-07-29T01:00:01.000Z", 1);

  assert.equal(first.changes, 1, "第一位审批人应当抢占成功。");
  assert.equal(second.changes, 0, "第二位审批人必须落空，避免覆盖结论并重复触发工作流续跑。");

  const row = db.prepare("SELECT status,approver FROM approval_requests WHERE id=1").get();
  assert.equal(row.status, "已通过");
  assert.equal(row.approver, "boss@haixin.test");
});

test("已处理的审批无法再被申请人撤回", async () => {
  const db = await databaseWith("CREATE TABLE IF NOT EXISTS approval_requests");
  const claimSql = await locateSql("app/api/governance/route.ts", "UPDATE approval_requests SET status=?,approver=?,comment=?,decided_at=?");
  const withdrawSql = await locateSql("app/api/governance/route.ts", "UPDATE approval_requests SET status='已撤回'");
  assert.match(withdrawSql, /status='待审批'/, "撤回语句必须限定原状态为待审批。");

  db.prepare("INSERT INTO approval_requests(id,requester,request_type,title,reason,status,created_at) VALUES(1,'staff@haixin.test','用车申请','出差用车','客户现场支持','待审批','2026-07-29T00:00:00.000Z')").run();
  db.prepare(claimSql).run("已通过", "boss@haixin.test", "同意", "2026-07-29T01:00:00.000Z", 1);

  const withdrawn = db.prepare(withdrawSql).run("staff@haixin.test", "2026-07-29T02:00:00.000Z", 1);
  assert.equal(withdrawn.changes, 0, "审批已有结论后撤回必须失败。");
  assert.equal(db.prepare("SELECT status FROM approval_requests WHERE id=1").get().status, "已通过");
});

test("待审批的审批可以被申请人正常撤回", async () => {
  const db = await databaseWith("CREATE TABLE IF NOT EXISTS approval_requests");
  const withdrawSql = await locateSql("app/api/governance/route.ts", "UPDATE approval_requests SET status='已撤回'");

  db.prepare("INSERT INTO approval_requests(id,requester,request_type,title,reason,status,created_at) VALUES(1,'staff@haixin.test','用车申请','出差用车','客户现场支持','待审批','2026-07-29T00:00:00.000Z')").run();
  const withdrawn = db.prepare(withdrawSql).run("staff@haixin.test", "2026-07-29T02:00:00.000Z", 1);

  assert.equal(withdrawn.changes, 1);
  assert.equal(db.prepare("SELECT status FROM approval_requests WHERE id=1").get().status, "已撤回");
});

test("普通员工不能删除他人的采集日志，管理员与本人可以", async () => {
  const db = await databaseWith("CREATE TABLE IF NOT EXISTS data_collection_runs");
  const selectSql = await locateSql("app/api/modules/route.ts", "SELECT source_name AS name FROM data_collection_runs");
  const deleteSql = await locateSql("app/api/modules/route.ts", "DELETE FROM data_collection_runs");
  for (const [label, sql] of [["查询", selectSql], ["删除", deleteSql]]) {
    assert.match(sql, /actor=\?\s*OR\s*\?='管理员'/, `采集日志${label}语句必须带所有者条件与显式管理员例外。`);
  }

  const insert = db.prepare("INSERT INTO data_collection_runs(id,source_id,source_name,actor,status,created_at) VALUES(?,?,?,?,?,?)");
  insert.run(1, 10, "行业新闻采集", "owner@haixin.test", "已入知识库", "2026-07-29T00:00:00.000Z");
  insert.run(2, 11, "竞品价格采集", "owner@haixin.test", "已入知识库", "2026-07-29T00:00:00.000Z");

  const select = db.prepare(selectSql);
  const remove = db.prepare(deleteSql);

  // 他人以普通员工身份操作：查询查不到，删除零行。
  assert.equal(select.get(1, "intruder@haixin.test", "普通员工"), undefined, "他人不应查到别人的采集日志。");
  assert.equal(remove.run(1, "intruder@haixin.test", "普通员工").changes, 0, "他人不应删除别人的采集日志。");
  assert.equal(db.prepare("SELECT COUNT(*) AS total FROM data_collection_runs").get().total, 2);

  // 本人操作：允许删除自己的记录。
  assert.equal(select.get(1, "owner@haixin.test", "普通员工").name, "行业新闻采集");
  assert.equal(remove.run(1, "owner@haixin.test", "普通员工").changes, 1);

  // 管理员例外：可以删除他人记录。
  assert.equal(remove.run(2, "admin@haixin.test", "管理员").changes, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS total FROM data_collection_runs").get().total, 0);
});

test("查看审计日志必须经过 view_audit 能力校验，普通员工默认拿不到", async () => {
  // 回归：GET /api/state 曾无条件把全员 audit_logs 返回给任何登录用户，
  // 而 view_audit 对普通员工默认「拒绝」却从未被执法。此处锁定读取侧的能力校验。
  const state = await source("app/api/state/route.ts");
  const start = state.indexOf('app.get("*"');
  const end = state.indexOf("\napp.post(", start);
  assert.ok(start > -1 && end > start, "未能定位 state 路由的 GET 处理体。");
  const body = state.slice(start, end);

  const auditReadAt = body.indexOf("FROM audit_logs");
  assert.ok(auditReadAt > -1, "GET 仍应在获得授权时读取 audit_logs。");
  const guardAt = body.search(/authorizeCapability\(runtime\.DB,\s*user,\s*"view_audit"\)/);
  assert.ok(guardAt > -1, "GET 返回审计日志前必须校验 view_audit 能力。");
  assert.ok(guardAt < auditReadAt, "view_audit 能力校验必须早于 audit_logs 读取。");
  assert.match(body, /results:\s*\[\]/, "校验未通过时必须回落到空审计日志，而不是照常查询全表。");

  // 能力目录里 view_audit 对普通员工默认必须是「拒绝」，确保默认收紧。
  const entries = await capabilityEntries();
  assert.equal(entries.get("view_audit")?.employee, "拒绝", "view_audit 默认必须对普通员工拒绝。");
});

test("身份只来自会话 Cookie，可伪造的身份请求头已彻底移除", async () => {
  const auth = await source("app/api/_auth.ts");
  assert.doesNotMatch(auth, /headers\.get\("oai-authenticated-user-email"\)/, "认证不得再读取客户端可控的身份请求头。");
  assert.match(auth, /getCookie\(request, "haixin_session"\)/, "身份必须来自会话 Cookie。");

  // 整个 ChatGPT 托管残留（登录路由本就不存在）必须清除，避免再次成为绕过入口。
  const files = ["app/page.tsx", "app/AuthPage.tsx", "app/Console.tsx", "app/features/profile/ProfilePanel.tsx", "deploy/nginx-ip.conf"];
  for (const file of files) {
    const text = await source(file);
    assert.doesNotMatch(text, /oai-authenticated|chatgpt-auth|signin-with-chatgpt|signout-with-chatgpt/i, `${file} 仍残留 ChatGPT 托管模式的引用。`);
  }
  await assert.rejects(source("app/chatgpt-auth.ts"), "app/chatgpt-auth.ts 应已删除。");
});

test("认证失败计数达到上限后锁定，成功后清零", async () => {
  const throttle = await source("app/api/_throttle.ts");

  const ddl = throttle.match(/"(CREATE TABLE IF NOT EXISTS auth_throttle [^"]+)"/)?.[1];
  assert.ok(ddl, "未能从 _throttle.ts 提取限流表建表语句。");
  // 计数语句由多段字符串拼接而成，这里把 db.prepare(...) 内的片段还原为完整 SQL。
  const consumeBlock = throttle.slice(
    throttle.indexOf('"INSERT INTO auth_throttle'),
    throttle.indexOf(").bind(rule.scope"),
  );
  const consumeSql = [...consumeBlock.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(match => match[1]).join("");
  assert.match(consumeSql, /RETURNING attempts,locked_until AS lockedUntil/, "计数必须用 RETURNING 一步拿到结果，避免先查后写。");

  const db = new DatabaseSync(":memory:");
  db.exec(ddl);
  const consume = db.prepare(consumeSql);
  const now = new Date("2026-07-29T10:00:00.000Z");
  const nowText = now.toISOString();
  const windowFloor = new Date(now.getTime() - 900 * 1000).toISOString();

  // 连续 6 次尝试：前 5 次在限额内，第 6 次越限。
  const counts = [];
  for (let index = 0; index < 6; index += 1) {
    counts.push(consume.get("login", "staff@haixin.test", nowText, windowFloor, windowFloor).attempts);
  }
  assert.deepEqual(counts, [1, 2, 3, 4, 5, 6], "并发累加必须单调递增，不能被重置。");
  assert.ok(counts[5] > 5, "第 6 次必须越过 limit=5 并触发锁定。");

  // 窗口过期后计数从 1 重新开始。
  const laterFloor = new Date(now.getTime() + 3600 * 1000).toISOString();
  const afterWindow = consume.get("login", "staff@haixin.test", laterFloor, laterFloor, laterFloor);
  assert.equal(afterWindow.attempts, 1, "超出时间窗后必须重新计数，避免永久锁死正常用户。");

  // 成功后清零：下一次尝试重新从 1 开始。
  db.prepare("DELETE FROM auth_throttle WHERE scope=? AND subject=?").run("login", "staff@haixin.test");
  assert.equal(consume.get("login", "staff@haixin.test", nowText, windowFloor, windowFloor).attempts, 1);

  // 不同账号互不影响。
  assert.equal(consume.get("login", "other@haixin.test", nowText, windowFloor, windowFloor).attempts, 1);
});

test("登录与注册接口均已接入限流", async () => {
  const login = await source("app/api/auth/login/route.ts");
  assert.match(login, /consumeAttempt\(db, LOGIN_RULE, email\)/, "登录必须累加失败计数。");
  assert.match(login, /resetAttempts\(db, LOGIN_RULE, email\)/, "登录成功后必须清零。");
  // 计数必须早于密码校验，否则失败请求不会被计入。
  assert.ok(login.indexOf("consumeAttempt(db, LOGIN_RULE") < login.indexOf("verifyPassword(body.password"), "限流必须发生在密码校验之前。");

  const register = await source("app/api/auth/register/route.ts");
  assert.match(register, /consumeAttempt\(db, REGISTER_CODE_RULE, email\)/, "索取验证码必须限流。");
  assert.match(register, /consumeAttempt\(db, REGISTER_VERIFY_RULE, email\)/, "校验验证码必须限流。");
  assert.ok(register.indexOf("consumeAttempt(db, REGISTER_VERIFY_RULE") < register.indexOf("inputHash !== row.codeHash"), "限流必须发生在验证码比对之前。");

  const rules = await source("app/api/_throttle.ts");
  assert.match(rules, /LOGIN_RULE[^=]*=\s*\{ scope: "login", limit: 5, windowSeconds: 900, lockSeconds: 900 \}/, "登录限流参数被改动，请同步确认是否仍满足要求。");
  assert.match(rules, /status: 429/, "限流响应必须返回 429。");
  assert.match(rules, /"Retry-After"/, "限流响应必须带 Retry-After 头。");
});

test("限流表已纳入版本化迁移", async () => {
  const migration = await source("drizzle/0017_auth_throttle.sql");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS `auth_throttle`/, "限流表必须有对应迁移，便于迁移统一后移除运行时建表。");
  assert.match(migration, /IF NOT EXISTS/, "新增迁移必须幂等，可安全重复执行。");
});

test("自托管入口脚本以迁移历史表为事实来源", async () => {
  const script = await source("deploy/selfhost-entrypoint.sh");

  assert.match(script, /CREATE TABLE IF NOT EXISTS schema_migrations \(name TEXT PRIMARY KEY,checksum TEXT NOT NULL,applied_at TEXT NOT NULL\)/, "必须建立迁移历史表并记录名称、校验和与执行时间。");
  assert.match(script, /INSERT INTO schema_migrations\(name,checksum,applied_at\)/, "每条迁移执行后必须写入历史记录。");
  assert.match(script, /校验和不一致/, "已应用迁移被改写时必须拒绝启动。");
  assert.doesNotMatch(script, /if \[ ! -f "\$LEGACY_MARKER" \]/, "不得再以标记文件是否存在作为跳过全部迁移的唯一判据。");

  // 凭据校验必须早于任何数据库写入，避免留下半初始化实例。
  const credentialGuard = script.indexOf("PLATFORM_CREDENTIALS_KEY:-");
  const firstDatabaseWrite = script.indexOf("d1_command");
  assert.ok(credentialGuard > -1 && firstDatabaseWrite > -1);
  assert.ok(credentialGuard < firstDatabaseWrite, "生产凭据校验必须位于首次数据库操作之前。");

  // 迁移执行语句必须排在写入历史记录之前，失败时 set -e 会终止脚本而不留下成功标记。
  assert.match(script, /set -eu/, "脚本必须开启 set -e，保证迁移失败即终止。");
  const runMigration = script.indexOf('d1_file "$migration"');
  const recordMigration = script.indexOf("INSERT INTO schema_migrations(name,checksum,applied_at)");
  assert.ok(runMigration > -1 && recordMigration > runMigration, "必须先执行迁移再登记，迁移失败不能被标记成功。");
});

// 按顺序执行 drizzle/ 下的全部迁移，返回建好的内存库。
async function migratedDatabase() {
  const dir = new URL("../drizzle/", import.meta.url);
  const files = (await readdir(dir)).filter(name => name.endsWith(".sql")).sort();
  const db = new DatabaseSync(":memory:");
  for (const name of files) {
    const sql = await readFile(new URL(name, dir), "utf8");
    for (const part of sql.split("--> statement-breakpoint")) {
      const statement = part.trim();
      if (!statement) continue;
      try {
        db.exec(statement);
      } catch (error) {
        assert.fail(`迁移 ${name} 执行失败：${error.message}\n语句：${statement.slice(0, 200)}`);
      }
    }
  }
  return { db, files };
}

test("空数据库可以执行全部迁移", async () => {
  const { db, files } = await migratedDatabase();
  assert.ok(files.length >= 20, "迁移文件数量异常，请确认 drizzle 目录完整。");
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(row => row.name);
  // 登录链路依赖的表必须由迁移建出，否则空库部署无法完成登录。
  for (const required of ["frontend_users", "login_sessions", "user_security", "user_roles", "role_permissions", "auth_throttle"]) {
    assert.ok(tables.includes(required), `迁移必须创建 ${required}，否则空库部署连登录都无法完成。`);
  }
});

test("迁移覆盖了所有在运行时创建的表", async () => {
  const { db } = await migratedDatabase();
  const migrated = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));

  // 扫描 API 源码中的运行时建表，任何一张未被迁移覆盖的表都会让空库部署缺表。
  const apiDir = new URL("../app/api/", import.meta.url);
  const runtimeTables = new Set();
  async function scan(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const child = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
      if (entry.isDirectory()) await scan(child);
      else if (entry.name.endsWith(".ts")) {
        const text = await readFile(child, "utf8");
        for (const match of text.matchAll(/CREATE TABLE IF NOT EXISTS[`\s]+([A-Za-z_][A-Za-z0-9_]*)/g)) {
          runtimeTables.add(match[1]);
        }
      }
    }
  }
  await scan(apiDir);

  const uncovered = [...runtimeTables].filter(name => !migrated.has(name)).sort();
  assert.deepEqual(uncovered, [], `以下表只在运行时创建、迁移未覆盖，空库部署会缺表：${uncovered.join("、")}`);
});

test("历史脏数据规范化迁移能归一取值并消除唯一约束冲突", async () => {
  const { db } = await migratedDatabase();

  // 迁移已在建库时跑过，这里灌入乱码数据后重放 0019 验证其修复能力。
  const normalizeSql = await readFile(new URL("../drizzle/0019_normalize_legacy_values.sql", import.meta.url), "utf8");
  const now = "2026-07-29T00:00:00.000Z";

  db.prepare("INSERT INTO user_roles(email,role,created_at,updated_at) VALUES(?,?,?,?)").run("a@t.test", "绠＄悊", now, now);
  db.prepare("INSERT INTO user_roles(email,role,created_at,updated_at) VALUES(?,?,?,?)").run("b@t.test", "staff", now, now);
  db.prepare("INSERT INTO frontend_users(email,display_name,status,created_at,updated_at) VALUES(?,?,?,?,?)").run("c@t.test", "c", "绂佺敤", now, now);
  db.prepare("INSERT INTO frontend_users(email,display_name,status,created_at,updated_at) VALUES(?,?,?,?,?)").run("d@t.test", "d", "unknown", now, now);
  // 两行乱码 role 归一后会撞上 UNIQUE(role,capability)，既有实现在此处会抛错导致认证整体失败。
  db.prepare("INSERT INTO role_permissions(role,capability,decision,updated_at) VALUES(?,?,?,?)").run("绠＄悊", "use_chat", "鍏佽", now);
  db.prepare("INSERT INTO role_permissions(role,capability,decision,updated_at) VALUES(?,?,?,?)").run("admin", "use_chat", "allow", now);
  db.prepare("INSERT INTO role_permissions(role,capability,decision,updated_at) VALUES(?,?,?,?)").run("员工", "export_data", "瀹℃壒", now);

  for (const part of normalizeSql.split("--> statement-breakpoint")) {
    const statement = part.trim();
    if (statement) db.exec(statement);
  }

  assert.equal(db.prepare("SELECT role FROM user_roles WHERE email='a@t.test'").get().role, "管理员");
  assert.equal(db.prepare("SELECT role FROM user_roles WHERE email='b@t.test'").get().role, "普通员工");
  assert.equal(db.prepare("SELECT status FROM frontend_users WHERE email='c@t.test'").get().status, "禁用");
  assert.equal(db.prepare("SELECT status FROM frontend_users WHERE email='d@t.test'").get().status, "启用");

  const admin = db.prepare("SELECT decision FROM role_permissions WHERE role='管理员' AND capability='use_chat'").all();
  assert.equal(admin.length, 1, "归一后重复的策略行必须被去重，只保留最新一行。");
  assert.equal(admin[0].decision, "允许");
  assert.equal(db.prepare("SELECT decision FROM role_permissions WHERE role='普通员工' AND capability='export_data'").get().decision, "需审批");

  // 归一后不应残留任何非标准取值。
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM user_roles WHERE role NOT IN ('管理员','普通员工')").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM frontend_users WHERE status NOT IN ('启用','禁用')").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM role_permissions WHERE decision NOT IN ('允许','需审批','拒绝')").get().n, 0);
});

test("认证热路径不再做全表扫描与逐行写回", async () => {
  const auth = await source("app/api/_auth.ts");
  const start = auth.indexOf("export async function ensureAuthTables");
  const end = auth.indexOf("\nexport async function authenticate");
  const body = auth.slice(start, end);

  assert.doesNotMatch(body, /SELECT email,role FROM user_roles"/, "认证链路不得再全表读取 user_roles。");
  assert.doesNotMatch(body, /SELECT email,status FROM frontend_users"/, "认证链路不得再全表读取 frontend_users。");
  assert.doesNotMatch(body, /SELECT id,role,decision FROM role_permissions"/, "认证链路不得再全表读取 role_permissions。");
  assert.doesNotMatch(body, /for \(const row of/, "认证链路不得再逐行写回规范化结果。");
});

test("合同与监控三张表只有唯一的建表来源", async () => {
  const chat = await source("app/api/chat/route.ts");
  for (const table of ["contract_templates", "contract_documents", "monitoring_reports"]) {
    assert.doesNotMatch(chat, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`), `chat 路由只读 ${table}，不应重复建表（此前列定义已过时，谁先建谁生效会让另一侧读写失败）。`);
  }
  // chat 侧的读取不得再引用权威结构中不存在的列。
  assert.doesNotMatch(chat, /FROM contract_templates WHERE status=/, "contract_templates 的权威结构没有 status 列。");
});

test("补列失败不再被静默吞掉，且只忽略列已存在", async () => {
  const schema = await source("app/api/_schema.ts");
  assert.match(schema, /duplicate column/, "只有“列已存在”属于正常幂等结果，可以忽略。");
  assert.match(schema, /throw error/, "其余错误（表不存在、语法错误、磁盘故障）必须抛出。");

  // 全仓不得再出现把所有 ALTER TABLE 错误一并吞掉的写法。
  const apiDir = new URL("../app/api/", import.meta.url);
  const offenders = [];
  async function scan(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const child = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
      if (entry.isDirectory()) await scan(child);
      else if (entry.name.endsWith(".ts")) {
        const text = await readFile(child, "utf8");
        if (/ALTER TABLE[^\n]*catch\(\(\) => (undefined|null)\)/.test(text)) offenders.push(entry.name);
      }
    }
  }
  await scan(apiDir);
  assert.deepEqual(offenders, [], `以下文件仍在静默吞掉补列错误：${offenders.join("、")}`);

  // ensureColumn 只应有一处定义，避免再次出现实现漂移。
  const definitions = [];
  async function scanDefs(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const child = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
      if (entry.isDirectory()) await scanDefs(child);
      else if (entry.name.endsWith(".ts")) {
        const text = await readFile(child, "utf8");
        if (/function ensureColumn\(/.test(text)) definitions.push(entry.name);
      }
    }
  }
  await scanDefs(apiDir);
  assert.deepEqual(definitions, ["_schema.ts"], "ensureColumn 应当只在 _schema.ts 中定义一次。");
});

test("治理接口的建表流程不再做全表规范化", async () => {
  const governance = await source("app/api/governance/route.ts");
  const start = governance.indexOf("async function ensureSchema");
  const end = governance.indexOf("\nasync function ownerEmail");
  const body = governance.slice(start, end);

  assert.doesNotMatch(body, /SELECT id,role,decision FROM role_permissions"/, "不得再全表读取 role_permissions 做规范化。");
  assert.doesNotMatch(body, /UPDATE role_permissions SET role=\?,decision=\?/, "不得再逐行写回规范化结果——归一后可能撞上 UNIQUE(role,capability) 使接口整体失败。");
});

test("版本化迁移是数据库结构的唯一事实来源", async () => {
  // Drizzle ORM 层曾与迁移并存：schema.ts 只有 14 张表、3 张已漂移，且零业务引用，
  // 却让人误以为那就是完整结构。已删除，此处防止它被重新引入形成第二个事实来源。
  for (const removed of ["db/schema.ts", "db/index.ts", "drizzle.config.ts"]) {
    await assert.rejects(source(removed), `${removed} 应已删除——数据库结构只由 drizzle/*.sql 定义。`);
  }

  const pkg = JSON.parse(await source("package.json"));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  assert.ok(!deps["drizzle-orm"] && !deps["drizzle-kit"], "不应重新引入 drizzle 依赖。");
  assert.ok(!pkg.scripts["db:generate"], "迁移由手写维护，不应恢复 db:generate。");

  const files = (await readdir(new URL("../drizzle/", import.meta.url))).filter(name => name.endsWith(".sql"));
  assert.ok(files.length >= 20, "迁移文件必须完整保留。");
});

test("模型调用全部带超时，且内层比外层先超时", async () => {
  const provider = await source("app/api/_modelProvider.ts");

  // 全部出网调用（中转、中转重试、直连文字、图片）都必须走带超时的封装。
  // 真正的安全不变量是"只有 fetchWithTimeout 内部允许裸 fetch"——只要裸 fetch 恒为 1，
  // 其余任何出网调用就必然被包进带超时的封装里。
  const bareFetch = [...provider.matchAll(/await fetch\(/g)].length;
  assert.equal(bareFetch, 1, "只有 fetchWithTimeout 内部允许直接调用 fetch。");
  assert.equal([...provider.matchAll(/await fetchWithTimeout\(/g)].length, 4, "四处模型出网调用都必须带超时。");
  assert.match(provider, /AbortSignal\.timeout\(timeoutMs\)/, "超时必须真正中断请求，而不只是提示。");
  assert.match(provider, /TimeoutError/, "超时要转换成可读的中文提示。");

  const textTimeout = Number(provider.match(/TEXT_MODEL_TIMEOUT_MS = ([\d_]+)/)[1].replace(/_/g, ""));
  const imageTimeout = Number(provider.match(/IMAGE_MODEL_TIMEOUT_MS = ([\d_]+)/)[1].replace(/_/g, ""));
  assert.ok(imageTimeout > textTimeout, "图片生成更慢，阈值应高于文字模型。");

  // 中转服务自身的超时必须短于应用侧，否则应用先放弃、中转仍在跑，连接被白白占用。
  const relay = await source("services/model-relay/server.mjs");
  const relayTimeout = Number(relay.match(/timeout: (\d+),\s*\n\s*timeoutMessage: "model relay timeout"/)[1]);
  assert.ok(relayTimeout < textTimeout, `中转层超时（${relayTimeout}ms）必须短于应用层（${textTimeout}ms）。`);
});
