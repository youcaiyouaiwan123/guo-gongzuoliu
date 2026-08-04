// 能力项目录：前端权限中心只读接口。
// 真实事实来源仍在 app/api/_capabilities.ts（由后端授权逻辑直接消费），这里只负责把
// 同一份目录以 JSON 形式暴露给前端，确保严格遵循"前端→后端→数据库"的分层。
import { createApp, success } from "../_app";
import { capabilityCatalog, capabilityGroups, permissionRoles } from "../_capabilities";

export const runtime = "edge";

// 业务规则：员工也强制允许的能力键（与角色无关的全局规则），由后端统一下发。
const ALWAYS_ALLOW_KEYS = ["collect_data"] as const;

const app = createApp();

app.get("*", async (c) => {
  return success({ capabilities: capabilityCatalog, groups: capabilityGroups, roles: permissionRoles, alwaysAllow: ALWAYS_ALLOW_KEYS });
});

export const GET = (request: Request) => app.fetch(request);