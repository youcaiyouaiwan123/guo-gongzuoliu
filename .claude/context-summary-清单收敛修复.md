# 项目上下文摘要（技术评审清单收敛修复）

生成时间：2026-07-29

## 1. 任务范围

对《项目技术评审与改进清单.md》执行状态核查后，收敛四项残留缺口：

1. 采集日志删除缺少所有者条件（P0 第 6 项残留）
2. 审批处理非原子，可重复触发副作用（P1 审批幂等）
3. 模型与平台连接 API 缺少能力授权（P1 服务端授权闭环）
4. 迁移执行依赖单一标记文件（P1 迁移执行机制）

## 2. 相似实现分析

- **`app/api/modules/route.ts:153,164,179`**：采集结果发布链路
  - 模式：`WHERE ... AND (actor=? OR ?='管理员')` 所有者条件 + 显式管理员例外
  - 模式：`UPDATE ... WHERE status IN (...)` 原子抢占后检查 `meta.changes`，落空返回 409
  - 复用点：这两个模式是本次修复 1 与 2 的直接范本

- **`app/api/governance/route.ts:8-34` capabilityCatalog**
  - 模式：个人域与企业域成对定义能力项，如 `manage_personal_knowledge`（员工"允许"）与 `manage_knowledge`（员工"需审批"）
  - 已有 `manage_models`、`manage_platform` 两项，员工默认"拒绝"
  - 复用点：修复 3 的能力项选型必须落在这套既有语义里

- **`app/api/_auth.ts:147-158` authorizeCapability**
  - 模式：管理员直通；查 `role_permissions` 取 decision；"需审批"与"拒绝"分别返回不同文案的 403
  - 复用点：修复 3 直接调用，不新增授权机制

- **`app/api/modules/_shared.ts:29,34`**：`data_collection_runs` 与 `approval_requests` 的真实建表语句所在处（也说明迁移尚未统一）

## 3. 项目约定

- 命名：SQL 列 snake_case，TS 标识符 camelCase，查询用 `AS` 显式映射
- 角色与状态用中文字面量（`'管理员'`、`'待审批'`、`'已入知识库'`）参与 SQL 判断
- 错误响应统一 `Response.json({ error: "中文文案" }, { status })`；`connectors`/`model` 路由用 `message` 字段
- 注释、日志、文案全部简体中文
- 缩进 2 空格，无分号省略，单行 SQL 不换行

## 4. 可复用组件清单

- `app/api/_auth.ts`：`authenticate`、`authorizeCapability`、`ensureAuthTables`
- `app/api/modules/_shared.ts`：`runtime`、`ensureSchema`、`audit`
- `app/api/_password.ts`：`createPasswordRecord`、`verifyPassword`
- `app/api/governance/route.ts`：`capabilityCatalog`（前端权限面板动态渲染其内容）

## 5. 测试策略

- 框架：`node:test`（项目既有，无第三方测试库）
- 入口：`npm test` = `npm run build` + `node --test "tests/**/*.test.mjs"`
- 断言：`node:assert/strict`
- 数据层：`node:sqlite`（Node 内置）在内存库中重放生产 SQL
- 关键做法：测试从生产源码中提取 SQL 与建表语句后执行，而非复制 SQL 副本，避免实现改动后测试仍然通过

## 6. 依赖与集成点

- 数据库：D1（`runtime.DB`），本地由 `wrangler dev --local --persist-to /data` 承载
- 迁移：`drizzle/*.sql` 由 `deploy/selfhost-entrypoint.sh` 在启动时执行
  - 0000–0007、0015 为 drizzle 生成的**非幂等**迁移（裸 `CREATE TABLE`），重跑会报错
  - 0008 起多为手写幂等迁移（`IF NOT EXISTS`）
- 容器：`node:22-bookworm-slim`，已安装 `python3`；`sha256sum`、`awk`、`date` 来自基础镜像

## 7. 关键风险点

- **并发**：审批与采集发布都存在多人同时操作，必须靠单条 SQL 的受影响行数判定归属，不能先查后写
- **越权**：所有按 id 查询/更新的记录级接口都需带所有者条件，管理员例外必须显式写出
- **迁移接管**：旧部署只有 `.migrations-applied` 标记，若对其重跑非幂等迁移会导致启动失败，必须登记而非执行
- **产品行为**：`manage_models`/`manage_platform` 员工默认"拒绝"，若直接套用到用户自助配置接口会封死普通员工既有功能
