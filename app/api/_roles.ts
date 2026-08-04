// 角色与状态字面量：项目内唯一事实源。
// 之所以从 _auth.ts 抽离：_capabilities.ts 需要使用 ADMIN_ROLE 作为能力默认决策的判定，
// 但 _auth.ts 又依赖 _capabilities.ts 的 defaultDecisionFor，形成循环。
// 把无外部依赖的纯常量放在本叶子模块，可同时被两端 import。

export const ADMIN_ROLE = "管理员" as const;
export const STAFF_ROLE = "普通员工" as const;
export const SALES_ROLE = "销售经理" as const;

export const ENABLED_STATUS = "启用" as const;
export const DISABLED_STATUS = "禁用" as const;

export type AppRole = typeof ADMIN_ROLE | typeof STAFF_ROLE;
export type BusinessRole = typeof SALES_ROLE | typeof STAFF_ROLE;
