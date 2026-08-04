# 操作日志

## 2026-07-29 技术评审清单执行状态核查

对《项目技术评审与改进清单.md》逐条比对源码，结论：

- P0 六项：三项完全落地（SSRF、TLS 降级、默认密钥），三项主体落地但各有残留（固定身份头仍被优先信任、缺密码找回与限流、采集日志删除缺所有者条件）
- P1 七项：两项完成（密码存储、会话安全），三项部分，两项未动（迁移统一、迁移执行机制）
- P2 七项：一项大部分完成（前端 features 拆分 + 懒加载），两项部分，四项未动
- 第 4 章测试与 CI：完全未执行，且既有模板测试已失效

## 2026-07-29 清单收敛修复（编码前检查）

- 已查阅上下文摘要：`.claude/context-summary-清单收敛修复.md`
- 将复用的既有组件：
  - `app/api/modules/route.ts:153,164` 的所有者条件与原子抢占写法 —— 作为修复 1、2 的范本
  - `app/api/_auth.ts:147` `authorizeCapability` —— 修复 3 的授权入口
  - `app/api/modules/_shared.ts:29,34` 的建表语句 —— 测试构造真实 schema
- 遵循命名约定：SQL 列 snake_case + `AS` 映射为 camelCase；中文状态字面量参与判断
- 遵循代码风格：2 空格缩进，单行 SQL，错误响应 `Response.json({ error }, { status })`
- 不重复造轮子的证明：检查 `_auth.ts`、`_shared.ts`、`governance/route.ts` 后确认授权与审计能力均已存在，本次不新增机制，只补齐调用与 SQL 条件

## 2026-07-29 清单收敛修复（变更明细）

### 1. 采集日志删除补所有者条件

- 文件：`app/api/modules/route.ts:207-210`
- 变更：查询与删除均改为 `WHERE id=? AND (actor=? OR ?='管理员')`
- 理由：原实现仅按 id 操作，任何持有 `collect_data` 能力的账号可删除他人采集日志
- 与既有实现的一致性：与同文件 `:153,164,179` 的发布链路写法完全一致

### 2. 审批处理改为原子抢占

- 文件：`app/api/governance/route.ts` `decide` 与 `withdraw` 两个分支
- 变更：`UPDATE ... WHERE id=? AND status='待审批'`，并检查 `meta.changes`，落空返回 409
- 保留前置查询：仍需其 `requester`/`requestType`/`workflowRunId` 元数据与审批人权限校验，且权限校验必须早于抢占
- 副作用幂等：抢占成功者唯一，因此下方的转岗落库、`resumeApprovedWorkflow` 续跑与审计各自只执行一次；已确认 `resumeApprovedWorkflow` 仅由该分支调用，无需额外幂等键

### 3. 迁移执行机制改为迁移历史表

- 文件：`deploy/selfhost-entrypoint.sh`（重写）
- 变更要点：
  - 新建 `schema_migrations(name PRIMARY KEY, checksum, applied_at)` 作为数据库版本唯一事实来源
  - 逐条比对校验和：未登记则执行并登记；已登记且校验和不同则拒绝启动
  - 先执行迁移再登记，配合 `set -e` 保证失败的迁移不会被标记成功
  - 生产凭据校验前移到任何数据库操作之前，避免留下半初始化实例
  - 旧部署接管：检测到 `.migrations-applied` 且历史表为空时，将现有迁移登记为已应用并把标记文件改名归档，不重跑 0000–0007、0015 这些非幂等迁移
- 迁移步骤：直接重建镜像启动即可，首启日志会打印接管提示
- 回滚方案：恢复本文件旧版本（标记文件已改名为 `.migrations-applied.migrated`，需改回原名）

### 4. 测试基线

- 新增 `tests/authorization-sql.test.mjs`（5 个用例），从生产源码提取 SQL 后在 `node:sqlite` 内存库中重放
- 删除 `tests/rendered-html.test.mjs`：断言的 `app/_sites-preview/` 目录与模板文案均已不存在，且 worker 产物引用 `cloudflare:workers` 无法在 Node 中 import，属架构性失效；删除前确认其在本次改动之前即为 0 通过 / 2 失败
- `package.json` 的 `test` 脚本改为 `node --test "tests/**/*.test.mjs"`，未新增脚本

### 4. 模型与平台连接 API 补齐能力授权

- 口径：经用户裁决采用「新增个人域能力项」方案。三个路由操作的都是按 `owner_email` 隔离的用户自有连接，若复用企业级 `manage_models`/`manage_platform`（员工默认"拒绝"）会立即封死普通员工自助配置能力
- 新增文件 `app/api/_capabilities.ts`：能力目录抽为叶子模块，新增 `manage_personal_models`（我的模型连接，员工"允许"）与 `manage_personal_platform`（我的平台连接，员工"允许"），沿用既有 `manage_personal_knowledge` / `manage_knowledge` 的成对模式
- `app/api/governance/route.ts`：删除就地定义的能力目录，改为从新模块导入并保持 `export { capabilityCatalog }` 对外接口不变；`defaults` 的 seed 逻辑不变，新能力项会以 `employee` 值自动登记进 `role_permissions`
- `app/api/_auth.ts`：`authorizeCapability` 在查不到策略行时改为回落 `defaultDecisionFor(role, capability)`，不再硬编码"拒绝"
  - 必要性：`ensureSchema()` 只在治理接口被调用时执行 seed。虽然 `Console.tsx:373` 首屏会并发拉取 `/api/governance`，但脚本直连或该请求失败时，新能力项在既有库上缺少策略行会导致普通员工被误拒。让能力目录成为默认决策的唯一来源后，DB 只承担"管理员覆盖值"的职责
  - 循环依赖处理：`_capabilities.ts` 保持叶子模块（不导入 `_auth.ts`），角色字面量就地声明
- 授权调用点：
  - `app/api/model/route.ts` POST / DELETE → `manage_personal_models`
  - `app/api/image-models/route.ts` POST / DELETE → `manage_personal_models`
  - `app/api/connectors/route.ts` POST → `manage_personal_platform`
  - 三处均置于 `authenticate` 之后、`schema()` 与请求体解析之前
- GET 保持仅身份认证：只读且已有 `owner_email` 过滤，不影响普通员工查看自己的连接

## 2026-07-29 P0 安全止血续做（身份头与限流）

### 5. 彻底移除可伪造的身份请求头

- 关键发现：ChatGPT 托管模式是模板脚手架残留，`/signin-with-chatgpt`、`/signout-with-chatgpt`、`/callback` 路由**在本项目中并不存在**，但 `app/page.tsx` 与 `app/api/_auth.ts` 仍优先信任 `oai-authenticated-user-email` 请求头
- 真实攻击路径：`app` 服务在 compose 中只 `expose` 不 `ports`，外网进不来，但同一 Docker 网络内的 `model-relay`、`channel-gateway` 可直连 `app:3000` 并伪造该头成为任意账号（含管理员）。Nginx 置空该头只在流量经过 Nginx 时有效，不覆盖此路径
- 变更：
  - `app/api/_auth.ts`：`authenticate` 只从 `haixin_session` Cookie 取身份
  - `app/page.tsx`：删除 `getChatGPTUser()` 分支，只用 Cookie 会话
  - `app/AuthPage.tsx`：删除 `chatGPTHref` 参数与"Continue with ChatGPT"入口（该入口点击后必然 404）
  - `app/Console.tsx`：401 跳转与登出跳转改为 `/login`
  - `app/features/profile/ProfilePanel.tsx`：改密后跳 `/login`（服务端已撤销全部会话）
  - 删除 `app/chatgpt-auth.ts`
  - `deploy/nginx-ip.conf`：删除两行置空指令——应用层不再读该头后它们成为误导性死配置
- 迁移影响：若未来需要接入统一身份认证，必须由可信代理动态签发身份并在 `authenticate` 中校验代理来源或签名，不能恢复裸信请求头的写法（已写入代码注释）

### 6. 注册与登录的频率限制与尝试次数

- 新增 `app/api/_throttle.ts`：失败计数与锁定
  - 计数用单条 `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` 完成，并发请求各自拿到递增后的次数，不存在先查后写被绕过的窗口
  - 规则：登录 15 分钟 5 次失败锁 15 分钟；索取验证码每小时 3 次；校验验证码 15 分钟 5 次失败锁 15 分钟
  - 超出时间窗自动重新计数，避免永久锁死正常用户
  - 统一返回 429 + `Retry-After` 头
- 接入点：
  - `login/route.ts`：计数早于密码校验（因此账号不存在、未验证、密码错误都会计入）；验证通过后 `resetAttempts`
  - `register/route.ts`：`requestCode` 与 `verify` 各自限流，计数早于验证码比对；注册成功后清零两个计数器
- 新增迁移 `drizzle/0017_auth_throttle.sql`（幂等），使限流表纳入版本化迁移，迁移统一后可直接移除运行时建表
- 未覆盖：IP 维度限流。当前按邮箱限流已能阻断针对具体账号的爆破与针对具体邮箱的验证码轰炸；撒网式攻击需配合 IP 维度，留待后续


## 2026-07-29 编码后声明（P0 收敛与授权补齐）

### 复用的既有组件

- `app/api/_auth.ts` `authorizeCapability`：三个路由的授权入口，未新增授权机制
- `app/api/modules/route.ts:153,164` 的所有者条件与原子抢占写法：修复 1、2 的实现范本
- `app/api/governance/route.ts:68-72` 的 seed 逻辑：新能力项无需额外初始化代码即可登记
- `app/api/modules/_shared.ts:29,34` 的建表语句：测试直接提取以构造真实 schema

### 遵循的项目约定

- 命名：新能力键沿用 `manage_personal_*` 前缀，与既有 `manage_personal_knowledge` 一致
- SQL 风格：所有者条件写作 `(actor=? OR ?='管理员')`，与同文件既有语句逐字一致
- 错误响应：审批与采集沿用 `{ error }`，模型与平台连接沿用该路由既有的 `{ message }`
- 注释：只解释设计理由（为何原子抢占、为何叶子模块、为何登记而非重跑），不复述代码

### 对比的相似实现

- 采集结果发布链路：本次的删除路径与其所有者条件写法相同，差异仅在无需能力二次校验（删除已由 `collect_data` 把关）
- `manage_personal_knowledge` / `manage_knowledge`：本次新增的两项完全对称，差异是个人模型/平台连接不涉及企业可见性，因此无"同步到企业"的第三项

### 未重复造轮子的证明

- 检查 `_auth.ts`、`_shared.ts`、`governance/route.ts` 后确认授权判定、审计写入、能力目录 seed 均已存在，本次只新增能力项与调用点
- 检查 `tests/` 后确认无既有 SQL 层测试可扩展，故新建测试文件；测试工具全部使用 Node 内置（`node:test`、`node:assert/strict`、`node:sqlite`），未引入第三方依赖


## 2026-07-29 P1 稳定数据（迁移补全与热路径清理）

### 7. 盘点结果：迁移此前只覆盖 27/41 张表

用脚本比对源码中的运行时建表与 `drizzle/*.sql` 的覆盖情况，发现 **14 张表只在运行时创建、迁移完全没有**，其中包括 `login_sessions`、`frontend_users`、`user_security` 三张登录必需表。这解释了那 90 余处运行时建表的由来：迁移不完整，运行时建表是唯一能让系统跑起来的方式。因此不能先删建表再补迁移，顺序必须反过来。

### 8. 三张表存在互相冲突的定义

`contract_templates`、`contract_documents`、`monitoring_reports` 在 `chat/route.ts` 与各自主路由中列定义不同（`variables_json` 对 `filled_values`、`raw_text/parsed_json` 对 `raw_rows/report`、多出或缺少 `status`/`sections`）。由于 `CREATE TABLE IF NOT EXISTS` 是"存在即跳过"，实际结构取决于哪个接口先被访问，另一侧的读写会因缺列失败。

- 判定依据：`chat/route.ts` 对这三张表**只读不写**，且主路由侧有 `ensureColumn` 自愈机制，因此以主路由定义为权威
- 变更：删除 `chat/route.ts` 中这三行建表；修正 `chat` 侧引用了权威结构不存在的 `status` 列的查询（该列只用于过滤，结果未使用）

### 9. 补齐迁移

- 新增 `drizzle/0018_missing_core_tables.sql`：14 张表的定义**逐字取自各表权威写入方**（用脚本提取而非手抄），并补上清单 P2 3.3 要求的索引（会话邮箱与过期时间、采集运行所有者、合同创建者、监控报表所有者）
- 结果：空库执行全部 20 个迁移共 88 条语句后建出 41 张表，与运行时建表集合完全一致

### 10. 认证热路径的全表修复改为一次性迁移

- 原实现：`ensureAuthTables` 每次认证都全表扫描 `user_roles`、`frontend_users`、`role_permissions` 并逐行写回规范化结果
- 顺带发现的既有缺陷：`role_permissions` 上有 `UNIQUE(role,capability)`，若多行乱码 role 归一后重复，那句 `UPDATE` 会抛唯一约束错误且未被捕获，导致**认证接口整体 500**
- 变更：
  - 新增 `drizzle/0019_normalize_legacy_values.sql`，先按归一键去重（保留每组最新一行）再规范化，一次性修复历史脏数据
  - 从 `ensureAuthTables` 删除三段全表循环，仅保留建表
- 安全性依据：乱码来自早期 GBK/UTF-8 混淆，新数据取自代码常量不会再产生；且读取路径的 `normalizeRoleValue`/`normalizeStatusValue` 仍然兜底，删除写回不影响行为

### 11. 本轮不删除运行时建表的理由

迁移虽已完整，但删除那 90 余处 `CREATE TABLE IF NOT EXISTS` 属于高风险改动，且本机无法端到端启动验证。前提条件（迁移完整、空库可跑通）已在本轮达成并被测试守卫，删除动作留待具备真实环境验证时执行。

## 2026-07-29 P2 异常处理（补列错误不再静默）

### 12. 统一补列工具，只忽略"列已存在"

- 复用来源：`contracts/route.ts` 中已有一份正确实现的 `ensureColumn`（只吞 `duplicate column`，其余抛出），将其提升为共享模块 `app/api/_schema.ts`，并让 `contracts/route.ts` 改为导入，消除重复定义
- 替换范围：6 个文件共 30 处 `ALTER TABLE ... .run().catch(() => undefined)` 全部改为 `ensureColumn(...)`
  - `modules/_shared.ts` 23 处、`governance/route.ts` 3 处，`organization`、`personal-knowledge`、`platform`、`state` 各 1 处
- 危害说明：原写法把补列的所有失败一并吞掉。补列失败后，后续引用该列的查询会报错，又被上层的空 catch 变成"没有数据"，正是清单 3.5 指出的"把 Schema 错误误判成没有数据"

### 13. 治理接口的全表规范化一并移除

- 上一轮只清理了 `_auth.ts` 中的全表规范化，本轮发现 `governance/route.ts` 的 `ensureSchema` 里还有一份对 `role_permissions` 的全表扫描 + 逐行写回，且带同样的 `UNIQUE(role,capability)` 冲突风险（归一后撞行会抛错使治理接口整体失败）
- 该修复已由迁移 `0019_normalize_legacy_values.sql` 一次性完成，故删除这段循环

### 验证

- `npm test` 19/19 通过；`tsc` 0 错误；`lint` 0 error
- 反向验证：让 `ensureColumn` 退回吞掉所有错误、让某路由退回静默写法、恢复治理接口全表规范化 —— 2 个用例精确失败，还原后全绿
- 静默降级 catch 总数从 79 降至 49

## 2026-07-29 P1/P2 数据模型（删除 Drizzle ORM 层）

### 14. 核对结果：Schema 已漂移且零引用

- `db/schema.ts` 定义 14 张表，迁移实际有 41 张
- 逐表比对其中 14 张：11 张一致，**3 张漂移**，漂移列全部是通过 `ALTER TABLE` 后加却没同步回 Schema 的
  - `knowledge_documents` 缺 `department_id`
  - `workflow_runs` 缺 `conversation_id`、`source_channel`
  - `approval_requests` 缺 `workflow_run_id`、`workflow_step_index`
- `getDb()` 与 `db/schema.ts` **没有任何业务代码引用**，全部 API 走 `runtime.DB.prepare(...)` 裸 SQL
- 迁移 0008 起全部手写（带 `IF NOT EXISTS`，drizzle-kit 不会生成该写法），`drizzle/meta` 快照停在 0007 —— 说明 `db:generate` 早已弃用

### 15. 处置：删除而非补全

经用户裁决采用删除方案。补全需写 27 张表定义并重建 meta 快照，而 drizzle 生成的 SQL 不带 `IF NOT EXISTS`，在已有库上会直接失败，反而引入风险；且 ORM 层无人使用，补全只是维护一个假的事实来源。

- 删除：`db/`（schema.ts、index.ts）、`drizzle.config.ts`、`drizzle/meta/`、`package.json` 的 `db:generate`
- 卸载依赖：`drizzle-orm`、`drizzle-kit`
- 一并删除 `examples/`（2 个文件，模板脚手架的 D1 `notes` 示例，本项目无此表且零引用；它 import 根 `db/`，是卸载依赖的必要前提）
- 保留：`drizzle/*.sql` 20 个迁移，作为数据库结构的唯一事实来源

### 验证

- `npm test` 20/20 通过（含 build）；`tsc` 0 错误；`lint` 0 error
- 新增守卫用例：断言 `db/schema.ts`、`db/index.ts`、`drizzle.config.ts` 不存在，package.json 无 drizzle 依赖与 `db:generate`，迁移文件完整 —— 防止第二个事实来源被重新引入

## 2026-07-29 P2 模型调用超时

### 16. 三处出网调用统一加超时

- 原状：`_modelProvider.ts` 的三个 `fetch`（模型中转、直连文字模型、图片模型）都没有超时。对端卡住时请求一直挂着，占满 Worker 并发额度，用户侧表现为页面一直转圈
- 变更：新增 `fetchWithTimeout`，用 `AbortSignal.timeout()` 真正中断请求；文字 60 秒、图片 120 秒（图片生成本身更慢）；超时错误转换为中文提示
- 层级关系：中转服务 `server.mjs` 自身是 45 秒，短于应用侧的 60 秒。内层先超时才是正确的，否则应用先放弃而中转仍在跑，连接被白白占用
- 测试守卫：断言全文件只剩 1 处裸 `fetch`（在封装内部）、3 处走封装、图片阈值高于文字、中转阈值短于应用层
