## 项目上下文摘要（全功能逐项验收）

生成时间：2026-07-30 21:20:00 +08:00

### 1. 相似实现分析

- `.Codex/verify-sidebar-navigation.mjs`：使用 Chrome CDP 完成管理员登录、菜单交互、断点和截图断言。
- `.Codex/verify-login-layout.mjs`：使用真实浏览器验证登录路由、布局和接口状态。
- `tests/authorization-sql.test.mjs`：使用 Node Test Runner 验证权限、审批并发和数据库边界。
- `app/Console.tsx`：集中加载 12 组业务 API，并将 18 个导航入口映射到对应面板。

### 2. 项目约定

- 浏览器验收脚本位于项目本地 `.Codex/`，使用 Node ESM、CDP 和中文断言。
- 测试数据统一使用 `验收测试-` 前缀，成功或失败后均执行清理。
- 不记录或输出模型密钥、平台密钥、管理员密码及 SMTP 凭证。

### 3. 功能与集成点

- 核心工作：`/api/chat`、`/api/image-*`、`/api/artifacts`。
- 知识与自动化：`/api/state`、`/api/personal-knowledge`、`/api/modules`。
- 企业运营：`/api/organization`、`/api/monitoring`、`/api/contracts`、`/api/governance`。
- 系统与接入：`/api/model`、`/api/connectors`、权限目录、审计日志、`/api/users`。
- 账户与帮助：`/api/profile` 和静态帮助面板。

### 4. 测试策略

- 18 个菜单逐项点击，验证页头、活动入口、内容面板、横向溢出和运行时异常。
- 16 个主要 GET 接口逐项验证认证状态与响应结构。
- 对话、知识、个人知识、沉淀、智能体、工作流定义、数据源、组织、监控、合同和账号执行创建、读取、更新或删除闭环。
- 模型、生图、SMTP、平台网关验证配置检测和可控降级，并明确标记为受外部配置限制。

### 5. 风险和清理

- 审批正向链路需要第二个可登录账号；当前只验证页面、读取和输入校验，正向并发由现有自动测试覆盖。
- 工作流真实 AI 节点、智能体回答、生图和机器人消息不能在缺少外部密钥时伪造通过。
- 测试结束后删除创建的业务记录和新增审计记录；历史工作流运行不在本轮创建。

### 6. 工具替代记录

- 当前会话没有 Context7、GitHub 搜索、sequential-thinking、shrimp-task-manager 和 desktop-commander 工具。
- 已使用项目现有 CDP 脚本、PowerShell 只读检索、Node 测试和本地服务接口作为替代，并在最终报告记录限制。
