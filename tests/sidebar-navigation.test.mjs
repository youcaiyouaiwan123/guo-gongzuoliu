import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

test("侧栏分组完整覆盖所有入口并保持角色可见范围", async () => {
  const constantsUrl = new URL("../app/features/constants.ts", import.meta.url).href;
  const evaluation = `
    import { nav, navigationGroupsForRole } from ${JSON.stringify(constantsUrl)};
    const serialize = groups => groups.map(group => ({ label: group.label, keys: group.items.map(([key]) => key) }));
    console.log(JSON.stringify({ navKeys: nav.map(([key]) => key), adminGroups: serialize(navigationGroupsForRole(true)), employeeGroups: serialize(navigationGroupsForRole(false)) }));
  `;
  const { stdout } = await execFileAsync(process.execPath, [
    "--no-warnings",
    "--experimental-strip-types",
    "--input-type=module",
    "--eval",
    evaluation,
  ], { encoding: "utf8" });
  const model = JSON.parse(stdout.trim());

  const expectedKeys = [
    "chat", "media", "artifacts",
    "knowledge", "agents", "workflows", "data",
    "organization", "monitoring", "contracts", "approvals",
    "models", "connectors", "permissions", "logs", "users",
    "profile", "help",
  ];
  const adminKeys = model.adminGroups.flatMap(group => group.keys);
  const employeeKeys = model.employeeGroups.flatMap(group => group.keys);

  assert.deepEqual(model.adminGroups.map(group => group.label), ["核心工作", "知识与自动化", "企业运营", "系统与接入", "账户与帮助"]);
  assert.deepEqual(adminKeys, expectedKeys, "管理员分组必须按业务顺序完整覆盖全部导航入口。");
  assert.deepEqual(model.navKeys, expectedKeys, "平铺导航必须从分组模型派生，供页头标题继续复用。");
  assert.equal(new Set(adminKeys).size, adminKeys.length, "每个导航入口只能属于一个分组。");
  assert.deepEqual(
    employeeKeys,
    expectedKeys.filter(key => !["permissions", "logs", "users"].includes(key)),
    "普通用户的入口范围必须与改造前一致。",
  );
  assert.ok(model.employeeGroups.every(group => group.keys.length > 0), "角色过滤后不得保留空分组。");
});

test("侧栏入口使用与业务语义匹配的图标键", async () => {
  const constantsUrl = new URL("../app/features/constants.ts", import.meta.url).href;
  const evaluation = `
    import { nav } from ${JSON.stringify(constantsUrl)};
    console.log(JSON.stringify(Object.fromEntries(nav.map(([tab, icon]) => [tab, icon]))));
  `;
  const { stdout } = await execFileAsync(process.execPath, [
    "--no-warnings",
    "--experimental-strip-types",
    "--input-type=module",
    "--eval",
    evaluation,
  ], { encoding: "utf8" });

  assert.deepEqual(JSON.parse(stdout.trim()), {
    chat: "assistant",
    media: "media",
    artifacts: "archive",
    knowledge: "knowledge",
    agents: "agent",
    workflows: "workflow",
    data: "data",
    organization: "organization",
    monitoring: "monitoring",
    contracts: "contract",
    approvals: "approval",
    models: "model",
    connectors: "connector",
    permissions: "permission",
    logs: "audit",
    users: "users",
    profile: "profile",
    help: "help",
  });
});
