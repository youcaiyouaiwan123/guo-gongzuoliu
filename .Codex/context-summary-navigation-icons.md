## 项目上下文摘要（侧栏导航图标匹配）

生成时间：2026-07-30 16:05:00 +08:00

### 1. 相似实现分析

- **导航数据**：`app/features/constants.ts` 使用 `[Tab, 图标, 标签]` 元组作为侧栏入口唯一事实来源。
- **导航渲染**：`app/features/navigation/SidebarNavigation.tsx` 统一渲染分组、入口、活动状态和无障碍属性。
- **图标布局**：`app/globals.css` 的 `.navIcon` 预留固定宽度，保证不同入口的文字左边缘对齐。
- **模块标记**：`app/features/shared-utils.ts` 的 `sourceIcon` 按业务类型映射显示标记，说明项目倾向集中管理视觉语义。

### 2. 项目约定

- TSX 使用 PascalCase 组件、camelCase 常量和双引号导入。
- 导航数据继续集中在 `constants.ts`，图标组件映射放在导航渲染模块，不把 React 依赖引入纯数据模块。
- CSS 使用既有 `.sidebarNav` 作用域和 980px/760px 响应式规则。

### 3. 可复用组件与依赖

- 复用 `SidebarNavigation`、`navGroups`、`Tab` 和既有按钮状态类。
- 使用成熟的 `lucide-react` 线性图标库，避免维护自绘 SVG 和平台相关字符图标。

### 4. 测试策略

- 扩展 `tests/sidebar-navigation.test.mjs`，固定 18 个入口的语义图标键。
- 执行 `npm test`、`npx tsc --noEmit`、`npm run lint` 和首页 HTTP 冒烟验证。

### 5. 依赖和集成点

- `constants.ts` 输出图标键，`SidebarNavigation.tsx` 映射为 Lucide 组件，`globals.css` 控制统一尺寸。
- 菜单选择、角色过滤、活动状态和页面标题协议保持不变。

### 6. 风险与约束

- 图标库会增加一个前端依赖，但构建按命名导入进行打包，不加载完整图标集。
- 图标必须使用固定尺寸和 `aria-hidden`，不改变按钮可访问名称和布局宽度。
