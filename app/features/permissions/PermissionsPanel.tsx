"use client";

import type { Permission, PermissionCapability, PermissionCapabilityGroup, PermissionRoleSpec } from "../shared-types";
import { buildPermissionDrafts, permissionKey } from "../shared-utils";
import { useMemo, useState } from "react";
import { WaveIcon, MessageIcon, BoltIcon, SparklesIcon, DiamondIcon, ClipboardIcon, BellIcon, RefreshIcon, ChevronDownIcon, ChevronUpIcon } from "../../components/icons";

export interface PermissionsPanelProps {
  permissions: Permission[];
  permissionDrafts: Record<string, string>;
  setPermissionDrafts: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  permissionDirty: boolean;
  setPermissionDirty: React.Dispatch<React.SetStateAction<boolean>>;
  setNotice: (message: string) => void;
  loadGovernance: () => Promise<void>;
  loadState: () => Promise<void>;
  // 能力项目录必须由父组件从 /api/capabilities 拉取后传入，避免前端硬编码与后端事实源再次漂移。
  capabilityCatalog: PermissionCapability[];
  // 能力项分组的元数据（标题/描述/keys）同样由后端下发，前端只补图标。
  capabilityGroups: PermissionCapabilityGroup[];
  // 角色规格（label/description/locked/defaultDecision）由后端下发，前端不再硬编码。
  permissionRoles: PermissionRoleSpec[];
  // collect_data 业务规则：员工也允许采集，但写死后端；改由 prop 注入。
}

type GroupId = "chat" | "agent" | "data" | "system" | "content";
type Decision = "允许" | "需审批" | "拒绝";

interface CapabilityGroup extends PermissionCapabilityGroup {
  icon: (props: { style?: React.CSSProperties }) => React.ReactElement;
}

// 图标是纯展示资源，前端按分组 id 映射；元数据（标题/描述/keys）由后端下发。
const groupIcons: Record<string, (props: { style?: React.CSSProperties }) => React.ReactElement> = {
  chat: props => <MessageIcon {...props} />,
  agent: props => <BoltIcon {...props} />,
  data: props => <WaveIcon {...props} />,
  system: props => <DiamondIcon {...props} />,
  content: props => <SparklesIcon {...props} />,
};

function buildGroups(raw: PermissionCapabilityGroup[]): CapabilityGroup[] {
  return raw.map(group => ({ ...group, icon: groupIcons[group.id] ?? groupIcons.chat }));
}

function isRoleLocked(role: PermissionRoleSpec, capability: PermissionCapability) {
  // 锁定角色（管理员）一律用 defaultDecision；某些能力键也强制默认（collect_data）。
  if (role.locked) return true;
  return false;
}

function decisionFor(role: PermissionRoleSpec, capability: PermissionCapability, draft: string | undefined, stored: Permission[]) {
  if (role.locked) return role.defaultDecision as Decision;
  if (draft) return draft as Decision;
  const storedItem = stored.find(item => item.role === role.key && item.capability === capability.key);
  if (storedItem) return storedItem.decision as Decision;
  return capability.employee as Decision;
}

export default function PermissionsPanel({ permissions, permissionDrafts, setPermissionDrafts, permissionDirty, setPermissionDirty, setNotice, loadGovernance, loadState, capabilityCatalog, capabilityGroups, permissionRoles }: PermissionsPanelProps) {
  // 兼容：如果后端没下发角色（早期版本），回退到内置两条；正常情况下由父组件注入。
  const roles = useMemo(() => (permissionRoles.length > 0 ? permissionRoles : []), [permissionRoles]);
  const [activePage, setActivePage] = useState<string>("");
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const groups = useMemo(() => buildGroups(capabilityGroups), [capabilityGroups]);
  if (activePage === "" && groups[0]) setActivePage(groups[0].id);

  // 取"非锁定"角色（普通员工）作为主操作对象；锁定角色（管理员）只读展示。
  const staffRole = roles.find(role => !role.locked);
  const lockedRole = roles.find(role => role.locked);
  const editableRole = staffRole ?? roles[0];

  function permissionValue(roleName: string, capability: PermissionCapability) {
    const role = roles.find(item => item.key === roleName);
    if (role?.locked) return role.defaultDecision as Decision;
    return (permissionDrafts[permissionKey(roleName, capability.key)] || permissions.find(item => item.role === roleName && item.capability === capability.key)?.decision || capability.employee) as Decision;
  }

  function setPermissionDraft(roleName: string, capability: PermissionCapability, decision: Decision) {
    const role = roles.find(item => item.key === roleName);
    setPermissionDrafts(current => ({
      ...current,
      [permissionKey(roleName, capability.key)]: role?.locked ? "允许" : decision,
    }));
    setPermissionDirty(true);
  }

  function allowAllEmployeePermissions() {
    if (!editableRole) return;
    const next = buildPermissionDrafts(permissions, capabilityCatalog);
    for (const capability of capabilityCatalog) next[permissionKey(editableRole.key, capability.key)] = "允许";
    setPermissionDrafts(next);
    setPermissionDirty(true);
    setNotice(`已将所有「${editableRole.label}」权限置为「允许」`);
  }

  function resetPermissionDrafts() {
    setPermissionDrafts(buildPermissionDrafts(permissions, capabilityCatalog));
    setPermissionDirty(false);
    setNotice("已恢复到未保存状态");
  }

  function setEmployeeForGroup(group: CapabilityGroup, decision: Decision) {
    if (!editableRole) return;
    for (const key of group.keys) {
      const capability = capabilityCatalog.find(capability => capability.key === key);
      if (capability) setPermissionDraft(editableRole.key, capability, decision);
    }
    setNotice(`已将「${group.title}」整组设为${decision}`);
  }

  function toggleGroup(groupId: string) {
    setCollapsedGroups(current => ({ ...current, [groupId]: !current[groupId] }));
  }

  async function savePermissions() {
    if (roles.length === 0) return;
    const payload = roles.flatMap(role =>
      capabilityCatalog.map(capability => ({
        role: role.key,
        capability: capability.key,
        decision: isRoleLocked(role, capability) ? role.defaultDecision : permissionValue(role.key, capability),
      }))
    );
    const response = await fetch("/api/governance", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "savePermissions", permissions: payload }) });
    const data = await response.json();
    setNotice(response.ok ? "全部权限策略已保存" : data.error || "保存失败");
    if (response.ok) await Promise.all([loadGovernance(), loadState()]);
  }

  const stats = useMemo(() => {
    let allow = 0, review = 0, deny = 0;
    for (const capability of capabilityCatalog) {
      const decision = editableRole ? permissionValue(editableRole.key, capability) : "拒绝" as Decision;
      if (decision === "允许") allow++;
      else if (decision === "需审批") review++;
      else if (decision === "拒绝") deny++;
    }
    return { allow, review, deny, total: capabilityCatalog.length };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [permissionDrafts, permissions, capabilityCatalog, editableRole]);

  // 分页只用于 UI 折叠展示，从后端下发的 groups 派生：每页最多 2 组。
  const pages = useMemo(() => {
    const chunks: CapabilityGroup[][] = [];
    for (let i = 0; i < groups.length; i += 2) chunks.push(groups.slice(i, i + 2));
    return chunks.map((chunk, index) => ({ id: chunk[0].id, label: chunk[0].title, groups: chunk, index }));
  }, [groups]);
  const currentPage = pages.find(page => page.id === activePage) ?? pages[0];
  const currentPageGroups = currentPage?.groups ?? [];
  const currentPageAllow = currentPageGroups.reduce((sum, group) => {
    const items = group.keys.map(key => capabilityCatalog.find(capability => capability.key === key)).filter((c): c is PermissionCapability => Boolean(c));
    return sum + items.filter(item => editableRole && permissionValue(editableRole.key, item) === "允许").length;
  }, 0);
  const currentPageItems = currentPageGroups.reduce((sum, group) => sum + group.keys.length, 0);
  const editableKey = editableRole?.key ?? "";
  const lockedKey = lockedRole?.key ?? "";
  const headerIntro = roles.length > 0
    ? `把每个企业能力分配给${roles.map(role => `${role.label}（${role.description}）`).join("、")}。保存后立即生效，所有员工的智能助手、审批、数据导出都按这里的策略执行。`
    : "暂未加载到角色规格，正在重新拉取...";

  return <section className="contentPanel pageFill permissionsPage">
    <header className="permissionsHeader">
      <div className="permissionsHeaderInfo">
        <h2>权限中心</h2>
        <p>{headerIntro}</p>
      </div>
      <div className="permissionsHeaderStats">
        <div className="permissionsStat allow">
          <WaveIcon style={{ width: 14, height: 14 }} />
          <div><b>{stats.allow}</b><small>允许 · {stats.total}</small></div>
        </div>
        <div className="permissionsStat review">
          <BellIcon style={{ width: 14, height: 14 }} />
          <div><b>{stats.review}</b><small>需审批</small></div>
        </div>
        <div className="permissionsStat deny">
          <DiamondIcon style={{ width: 14, height: 14 }} />
          <div><b>{stats.deny}</b><small>拒绝</small></div>
        </div>
        <div className="permissionsStat total">
          <ClipboardIcon style={{ width: 14, height: 14 }} />
          <div><b>{stats.total}</b><small>能力总数</small></div>
        </div>
      </div>
      <div className="permissionsHeaderActions">
        <button className="outline" type="button" onClick={allowAllEmployeePermissions} disabled={!editableRole}>{editableRole ? `${editableRole.label}全选允许` : "员工全选允许"}</button>
        <button className="outline" type="button" disabled={!permissionDirty} onClick={resetPermissionDrafts}>
          <RefreshIcon style={{ width: 12, height: 12 }} /> 恢复未保存
        </button>
        <button type="button" className="primary" disabled={!permissionDirty} onClick={savePermissions}>保存权限</button>
      </div>
    </header>

    <div className="permissionsPager">
      <div className="permissionsPagerInfo">
        <strong>第 {(currentPage ? currentPage.index + 1 : 0) || 1} / {pages.length} 页</strong>
        <span>{currentPage?.label ?? ""} · 本页 {currentPageItems} 项 · 已允许 {currentPageAllow} 项</span>
      </div>
      <div className="permissionsPagerButtons">
        {pages.map((page, index) => {
          const pageItems = page.groups.reduce((sum, group) => sum + group.keys.length, 0);
          return <button key={page.id} type="button" className={`permissionsPagerBtn ${activePage === page.id ? "isActive" : ""}`} onClick={() => setActivePage(page.id)}>
            <span className="permissionsPagerIndex">{index + 1}</span>
            <span className="permissionsPagerLabel">{page.label}</span>
            <span className="permissionsPagerCount">{pageItems}</span>
          </button>;
        })}
      </div>
      <div className="permissionsPagerNav">
        <button type="button" className="outline" disabled={!currentPage || currentPage.index === 0} onClick={() => {
          if (!currentPage) return;
          const prev = pages[currentPage.index - 1];
          if (prev) setActivePage(prev.id);
        }}>上一页</button>
        <span className="permissionsPagerIndicator">
          {currentPage ? currentPage.index + 1 : 0} / {pages.length}
        </span>
        <button type="button" className="outline" disabled={!currentPage || currentPage.index >= pages.length - 1} onClick={() => {
          if (!currentPage) return;
          const next = pages[currentPage.index + 1];
          if (next) setActivePage(next.id);
        }}>下一页</button>
      </div>
    </div>

    <div className="pageScroll">
      <div className="permissionsRoleRow">
        {roles.length === 0 ? <div className="permissionsRoleCard"><div className="permissionsRoleHeader"><div><h3>加载中</h3><p>正在从后端拉取角色规格...</p></div></div></div> : null}
        {roles.map(role => {
          const isLocked = role.locked;
          const roleDecisionSummary = isLocked
            ? { allow: stats.total, review: 0, deny: 0 }
            : { allow: stats.allow, review: stats.review, deny: stats.deny };
          const initial = role.label.slice(0, 1) || "·";
          return <div key={role.key} className={`permissionsRoleCard ${isLocked ? "permissionsRoleAdmin" : "permissionsRoleEmployee"}`}>
            <div className="permissionsRoleHeader">
              <span className="permissionsRoleAvatar">{initial}</span>
              <div>
                <h3>{role.label}</h3>
                <p>{role.description}</p>
              </div>
              <span className={`permissionsRoleBadge ${isLocked ? "isFixed" : permissionDirty ? "isDirty" : "isFixed"}`}>
                {isLocked ? "已固定" : permissionDirty ? "有未保存" : "已同步"}
              </span>
            </div>
            <div className="permissionsRoleMeta">
              {isLocked ? <>
                <div><small>覆盖能力</small><b>{stats.total} / {stats.total}</b></div>
                <div><small>默认策略</small><b className="routeHealthy">{role.defaultDecision}</b></div>
              </> : <>
                <div><small>允许</small><b className="routeHealthy">{roleDecisionSummary.allow}</b></div>
                <div><small>需审批</small><b style={{ color: "#b87a00" }}>{roleDecisionSummary.review}</b></div>
                <div><small>拒绝</small><b className="routeWarning">{roleDecisionSummary.deny}</b></div>
              </>}
            </div>
          </div>;
        })}
      </div>

      <div className="permissionsGroups">
        {currentPageGroups.map(group => {
          const items = group.keys.map(key => capabilityCatalog.find(capability => capability.key === key)).filter((c): c is PermissionCapability => Boolean(c));
          const collapsed = collapsedGroups[group.id];
          const allowCount = items.filter(item => editableRole && permissionValue(editableRole.key, item) === "允许").length;
          return <article key={group.id} className={`permissionsGroup ${collapsed ? "isCollapsed" : ""}`}>
            <header className="permissionsGroupHead" onClick={() => toggleGroup(group.id)}>
              <div className="permissionsGroupTitle">
                <span className="permissionsGroupIcon">{group.icon({ style: { width: 14, height: 14 } })}</span>
                <div>
                  <h3>{group.title}<span className="permissionsGroupCount">{items.length}</span></h3>
                  <p>{group.description}</p>
                </div>
              </div>
              <div className="permissionsGroupSummary">
                <span className="permissionsGroupBadge allow"><b>{allowCount}</b> 允许</span>
                <span className="permissionsGroupBadge review"><b>{items.length - allowCount}</b> 其余</span>
                <button type="button" className="outline permissionsGroupBatch" disabled={!editableRole} onClick={event => { event.stopPropagation(); if (editableRole) setEmployeeForGroup(group, "允许"); }}>整组允许</button>
                <button type="button" className="ghost permissionsGroupToggle" aria-label={collapsed ? "展开" : "收起"}>
                  {collapsed ? <ChevronDownIcon style={{ width: 14, height: 14 }} /> : <ChevronUpIcon style={{ width: 14, height: 14 }} />}
                </button>
              </div>
            </header>
            {!collapsed && <div className="permissionsGroupGrid">
              {items.map(capability => {
                const decision = (editableRole ? permissionValue(editableRole.key, capability) : "拒绝") as Decision;
                const lockedCapability = editableRole?.locked ?? false;
                return <div key={capability.key} className={`permissionCard decision-${decision === "允许" ? "allow" : decision === "需审批" ? "review" : "deny"} ${lockedCapability ? "isLocked" : ""}`}>
                  <div className="permissionCardHead">
                    <strong>{capability.label}</strong>
                    {lockedCapability && <span className="permissionLock">已固定</span>}
                  </div>
                  <code className="permissionCardKey">{capability.key}</code>
                  <div className="permissionCardFooter">
                    <span className={`permissionDecisionBadge decision-${decision === "允许" ? "allow" : decision === "需审批" ? "review" : "deny"}`}>
                      <span className="permissionDecisionDot" />
                      {decision}
                    </span>
                    <div className="permissionCardSwitch">
                      {(["允许", "需审批", "拒绝"] as Decision[]).map(option => (
                        <button
                          key={option}
                          type="button"
                          className={`permissionChip ${decision === option ? "isActive" : ""} decision-${option === "允许" ? "allow" : option === "需审批" ? "review" : "deny"}`}
                          disabled={lockedCapability || !editableRole}
                          onClick={() => editableRole && setPermissionDraft(editableRole.key, capability, option)}
                        >
                          {option}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>;
              })}
            </div>}
          </article>;
        })}
      </div>
    </div>
  </section>;
}
