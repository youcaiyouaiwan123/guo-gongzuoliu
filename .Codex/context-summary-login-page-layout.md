## 项目上下文摘要（登录页响应式布局）

生成时间：2026-07-30 13:06:19 +08:00

### 1. 需求、范围与复现

- **目标**：确认本地后端运行状态，并修复登录页面布局变形。
- **范围**：未登录首页 `/`、独立登录页 `/login`、管理员登录页 `/admin-login`，以及三者共享的登录卡片样式。
- **复现证据**：`/login` 在 `1366x768` 下的 `.authPage` 计算样式为 `display: block`、`min-height: 0px`，登录卡片顶部为 `1346.5px`，完全位于首屏之外。
- **后端证据**：3000 端口由 Vinext 的 `node.exe` 监听；`GET /` 返回 200；真实 `POST /api/auth/login` 空参数请求返回 400，说明 Route Handler 已运行并执行参数校验。

### 2. 相似实现分析

- **实现 1**：`app/page.tsx:32`
  - 模式：未登录首页使用 `.loginPage`、`.loginBrand`、`.loginLogo`、`.siteFooter.loginFooter` 和共享的 `LoginAuthCard`。
  - 可复用：完整的品牌双栏登录外壳及统一登录卡片。
  - 需注意：根页面与独立登录页必须保持相同布局协议。
- **实现 2**：`app/globals.css:739`
  - 模式：`.loginPage` 使用网格双栏，`.loginCard` 使用受视口约束的固定最大宽度并居中。
  - 可复用：现有颜色、间距、卡片和品牌样式，不新增第二套登录页设计。
  - 需注意：现有移动切换点为 620px，621-900px 仍会挤压双栏。
- **实现 3**：`app/globals.css:3864`
  - 模式：控制台在 900px 断点收拢网格，并在更窄断点继续调整。
  - 可复用：以 900px 作为桌面双栏到单栏布局的项目既有断点。
  - 需注意：登录页规则应放在品牌布局附近，避免被后续同选择器覆盖。
- **实现 4**：`app/globals.css:5308`
  - 模式：表单和构建器在 760px 下改为单列，宽度使用视口约束。
  - 可复用：窄屏采用单列、有限内边距和允许页面纵向滚动的响应式策略。

### 3. 项目约定

- **命名约定**：React 组件使用 PascalCase，CSS 类使用 camelCase，测试文件使用 `*.test.mjs`。
- **文件组织**：页面位于 `app/`，全局样式由 `app/layout.tsx` 唯一导入 `app/globals.css`，测试位于 `tests/`。
- **导入顺序**：Node 内置模块在测试文件顶部导入；应用内使用相对路径。
- **代码风格**：TypeScript/TSX 使用双引号和两空格缩进；CSS 每条声明独占一行。

### 4. 可复用组件清单

- `app/AuthPage.tsx` 的 `LoginAuthCard`：登录、注册和角色切换的唯一共享表单。
- `app/globals.css` 的 `.loginPage`：登录页外层网格。
- `app/globals.css` 的 `.loginBrand` 与 `.loginLogo`：品牌区域和标志。
- `app/globals.css` 的 `.siteFooter.loginFooter`：登录页页脚。

### 5. 测试策略

- **测试框架**：Node.js Test Runner，入口为 `npm test`。
- **回归测试**：读取真实 `AuthPage.tsx` 和 `globals.css`，断言独立登录页复用既有登录布局类，并存在 900px 单栏规则。
- **浏览器验证**：通过本地 Chrome CDP 在 1366、1036、768、390 四档宽度检查卡片是否位于页面内、是否横向溢出、是否在 900px 及以下切换为单栏。
- **接口验证**：请求真实登录 Route Handler，确认参数校验响应。

### 6. 依赖和集成点

- `app/layout.tsx` -> `app/globals.css`：全站样式入口。
- `/` -> `app/page.tsx` -> `LoginAuthCard`：未登录首页。
- `/login`、`/admin-login` -> `AuthPage` -> `LoginAuthCard`：独立登录入口。
- `/api/auth/login` -> Cloudflare D1 本地绑定：登录后端接口。
- 本次不新增第三方依赖，继续复用 Vinext、React、现有 CSS 和 Node.js Test Runner。

### 7. 技术选型与风险

- **方案**：让 `AuthPage` 组合现有登录外壳类，并在 900px 断点将登录布局切换为单列。
- **理由**：项目已有完整登录视觉体系，复用它可消除两套未同步的布局协议。
- **边界条件**：短视口允许纵向滚动；窄屏隐藏品牌区但保留登录卡片和公司页脚；桌面继续保持双栏。
- **性能影响**：仅改变静态类名和少量 CSS，无额外脚本、网络或运行时计算。
- **主要风险**：`globals.css` 后部存在覆盖规则，响应式规则必须位于后部品牌区并由浏览器计算样式验证最终优先级。

### 8. 上下文充分性检查

- [x] 能定义接口契约：三个登录入口共享同一布局；900px 以上双栏，900px 及以下单栏；登录卡片不得超出页面宽度。
- [x] 理解技术选型：复用现有类，避免新增平行样式体系。
- [x] 已识别风险：规则覆盖顺序、中等宽度挤压、短视口纵向溢出。
- [x] 知道验证方式：静态契约测试、真实浏览器计算样式、HTTP 接口冒烟、完整构建测试。
- [x] 已确认没有重复造轮子：搜索了 `AuthPage.tsx`、`page.tsx` 和 `globals.css` 中全部登录相关选择器。

### 9. 工具可用性说明

- 当前会话未提供 `sequential-thinking`、`shrimp-task-manager`、`desktop-commander`、Context7 和 GitHub 代码搜索工具。
- 已使用结构化复现与假设检验代替思维工具，使用本地 `rg`、PowerShell 只读命令和 Chrome CDP 完成检索与验证。
- 本次问题是项目内缺失样式和断点覆盖，不涉及第三方 API 用法；外部资料检索不可用不会改变修复契约。
