// 能力项目录：授权策略的唯一事实来源。
// role_permissions 表只保存管理员在权限中心做出的覆盖，未被覆盖的能力按此处 employee 字段生效，
// 因此新增能力项在既有数据库上不会因缺少策略行而被一律拒绝。
// 本模块必须保持为叶子模块（不导入 _auth.ts），否则会与 authorizeCapability 形成循环依赖。
//
// adminManaged 标记：这些能力后端并不通过 role_permissions 逐项判定，而是在各自路由里
// 按角色硬控制（管理员专属或 owner-scoped，如企业架构、审批处理、监控/模型/平台的企业级管理、
// 外部平台发送）。权限中心对它们只读展示、不提供员工侧「允许/需审批」配置，以免出现
// 「开关点了不生效」的误导——员工侧一律固定为「拒绝」，真正的控制在对应路由内。
import { ADMIN_ROLE, STAFF_ROLE } from "./_roles";
export const capabilityCatalog = [
  { key: "use_chat", label: "智能助手对话", employee: "允许" },
  { key: "use_knowledge_search", label: "结合知识库回答", employee: "允许" },
  { key: "manage_personal_knowledge", label: "个人知识库", employee: "允许" },
  { key: "manage_knowledge", label: "企业知识库管理", employee: "需审批" },
  { key: "sync_enterprise_knowledge", label: "同步企业知识", employee: "需审批" },
  { key: "create_agent", label: "新建智能体", employee: "需审批" },
  { key: "run_agent", label: "运行智能体", employee: "允许" },
  { key: "create_workflow", label: "新建自动化工作流", employee: "需审批" },
  { key: "run_workflow", label: "运行自动化工作流", employee: "需审批" },
  { key: "collect_data", label: "数据采集与清洗", employee: "允许" },
  { key: "export_data", label: "导出数据", employee: "拒绝" },
  { key: "submit_approval", label: "发起审批", employee: "允许" },
  { key: "manage_approvals", label: "审批中心管理", employee: "拒绝", adminManaged: true },
  { key: "manage_organization", label: "企业架构管理", employee: "拒绝", adminManaged: true },
  { key: "manage_personal_models", label: "我的模型连接", employee: "允许" },
  { key: "manage_models", label: "模型接入管理", employee: "拒绝", adminManaged: true },
  { key: "manage_personal_platform", label: "我的平台连接", employee: "允许" },
  { key: "manage_platform", label: "平台接入管理", employee: "拒绝", adminManaged: true },
  { key: "external_send", label: "外部平台发送", employee: "拒绝", adminManaged: true },
  { key: "manage_users", label: "用户与账号管理", employee: "拒绝" },
  { key: "view_audit", label: "查看审计日志", employee: "拒绝" },
  { key: "view_contracts", label: "查看合同中心", employee: "允许" },
  { key: "generate_contracts", label: "生成合同", employee: "允许" },
  { key: "manage_contract_templates", label: "管理合同模板", employee: "拒绝" },
  { key: "view_monitoring", label: "查看监控看板", employee: "允许" },
  { key: "manage_monitoring", label: "管理监控看板", employee: "拒绝", adminManaged: true },
  { key: "use_media_generation", label: "图文视频生成", employee: "允许" },
] as const;

// 能力项分组：定义给前端权限中心使用，决定展示顺序、分组标题与说明。
// 真实事实源放后端，前端仅消费；图标等纯展示资源仍在 PermissionsPanel 里按 id 映射。
export const capabilityGroups = [
  {
    id: "chat",
    title: "智能助手 & 知识库",
    description: "员工日常对话、知识查询、个人与企业知识库维护相关能力。",
    keys: ["use_chat", "use_knowledge_search", "manage_personal_knowledge", "manage_knowledge", "sync_enterprise_knowledge"],
  },
  {
    id: "agent",
    title: "智能体 & 工作流",
    description: "员工能否建设、运行、自动化执行企业内部的智能体与流程。",
    keys: ["create_agent", "run_agent", "create_workflow", "run_workflow"],
  },
  {
    id: "data",
    title: "数据 & 审批",
    description: "数据采集、导出、审批发起、审批中心管理等核心治理能力。",
    keys: ["collect_data", "export_data", "submit_approval", "manage_approvals", "view_audit"],
  },
  {
    id: "system",
    title: "系统 & 业务管理",
    description: "企业架构、模型、平台、账号、监控、合同等后台管理能力。",
    keys: ["manage_organization", "manage_models", "manage_platform", "manage_users", "view_monitoring", "manage_monitoring", "view_contracts", "generate_contracts", "manage_contract_templates", "external_send"],
  },
  {
    id: "content",
    title: "内容生成",
    description: "图文视频生成等与内容生产相关的能力。",
    keys: ["use_media_generation"],
  },
] as const;

export type CapabilityKey = typeof capabilityCatalog[number]["key"];
export type CapabilityGroupId = typeof capabilityGroups[number]["id"];
export type CapabilityGroup = Omit<typeof capabilityGroups[number], never>;
export type Decision = "允许" | "需审批" | "拒绝";

// 权限中心里的角色规格：标题/描述/锁定/默认决策，由后端下发，前端只消费。
// locked = true 时该角色所有权限都是默认决策（管理员），不允许逐项覆盖。
export const permissionRoles = [
  {
    key: ADMIN_ROLE,
    label: "管理员",
    description: "最高权限；所有能力默认「允许」，保存时由后端自动锁定。",
    locked: true,
    defaultDecision: "允许" as Decision,
  },
  {
    key: STAFF_ROLE,
    label: "普通员工",
    description: "可配置；每项能力可独立设为「允许 / 需审批 / 拒绝」。",
    locked: false,
    defaultDecision: "拒绝" as Decision,
  },
] as const;

export type PermissionRoleKey = typeof permissionRoles[number]["key"];
export type PermissionRole = Omit<typeof permissionRoles[number], never>;

export function defaultDecisionFor(role: string, capability: string): Decision {
  if (role === ADMIN_ROLE) return "允许";
  return (capabilityCatalog.find(item => item.key === capability)?.employee as Decision) || "拒绝";
}

// 该能力是否由后端按角色硬控制、不接受权限中心的员工侧配置（见文件顶部 adminManaged 说明）。
export function isAdminManaged(capability: string): boolean {
  return capabilityCatalog.some(item => item.key === capability && "adminManaged" in item && item.adminManaged);
}
