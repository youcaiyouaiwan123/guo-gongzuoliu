// 能力项目录：前端权限中心只读接口。
// 真实事实来源仍在 app/api/_capabilities.ts（由后端授权逻辑直接消费），这里只负责把
// 同一份目录以 JSON 形式暴露给前端，确保严格遵循"前端→后端→数据库"的分层。
import { createApp, success } from "../_app";
import { capabilityCatalog, capabilityGroups, permissionRoles } from "../_capabilities";

export const runtime = "edge";

const app = createApp();

app.get("*", async (c) => {
  return success({ capabilities: capabilityCatalog, groups: capabilityGroups, roles: permissionRoles });
});

export const GET = (request: Request) => app.fetch(request);