// 组织架构的纯逻辑：建树、逐级汇报链、部门重名判定。
//
// route.ts 顶部 import "cloudflare:workers"，在 vitest 里无法导入，
// 这些规则又恰恰是最容易出错、最需要回归测试的部分，因此单独成文件。

export type OrgUnitRow = {
  id: number;
  name: string;
  unitType?: string;
  parentId?: number | null;
  managerEmail?: string;
  sortOrder?: number;
};

export type OrgMemberRow = {
  email: string;
  unitId: number;
  jobTitle?: string;
  directManagerEmail?: string;
  status?: string;
  unitName?: string;
};

export type OrgTreeNode = {
  unit: OrgUnitRow;
  members: OrgMemberRow[];
  children: OrgTreeNode[];
};

/**
 * 部门名归一：去掉首尾与中间空白、全角空格，统一大小写与全角括号。
 * 不做归一的话，"市场部" 与 "市场 部"、"市场部（新）" 与 "市场部(新)" 会被当成不同部门，
 * 重名校验形同虚设。
 */
export function normalizeUnitName(name: string) {
  return String(name ?? "")
    .replace(/[\s 　]/g, "")
    .replace(/（/g, "(")
    .replace(/）/g, ")")
    .toLowerCase();
}

function sameParent(a?: number | null, b?: number | null) {
  return (a || null) === (b || null);
}

/**
 * 同一上级下是否已存在同名节点。
 * 不同分公司/事业部下允许各有一个"市场部"，因此只在同级范围内判重。
 * 传 id 表示"编辑现有节点"，需要把自己排除在外。
 */
export function findDuplicateUnit(
  units: OrgUnitRow[],
  target: { id?: number | null; name: string; parentId?: number | null },
): OrgUnitRow | null {
  const name = normalizeUnitName(target.name);
  if (!name) return null;
  return units.find(unit =>
    unit.id !== (target.id || 0)
    && sameParent(unit.parentId, target.parentId)
    && normalizeUnitName(unit.name) === name,
  ) || null;
}

/**
 * 建树。根节点 = 没有上级、或上级已被删除的孤儿节点（否则整棵子树会在架构图上消失）。
 * parent 指向成环时靠 path 集合止损，不会无限递归。
 */
export function buildOrgTree(units: OrgUnitRow[], members: OrgMemberRow[]): OrgTreeNode[] {
  const membersByUnit = new Map<number, OrgMemberRow[]>();
  for (const member of members) {
    const list = membersByUnit.get(member.unitId) || [];
    list.push(member);
    membersByUnit.set(member.unitId, list);
  }
  const build = (unit: OrgUnitRow, path: Set<number>): OrgTreeNode | null => {
    if (path.has(unit.id)) return null;
    const nextPath = new Set(path).add(unit.id);
    return {
      unit,
      members: membersByUnit.get(unit.id) || [],
      children: units
        .filter(child => child.parentId === unit.id)
        .map(child => build(child, nextPath))
        .filter((node): node is OrgTreeNode => node !== null),
    };
  };
  return units
    .filter(unit => !unit.parentId || !units.some(parent => parent.id === unit.parentId))
    .map(unit => build(unit, new Set()))
    .filter((node): node is OrgTreeNode => node !== null);
}

/**
 * 逐级汇报可选的接收人：直属上级优先，然后沿组织树向上收集各级负责人。
 * 自己是本部门负责人时跳过自己，避免出现"汇报给自己"。
 */
export function resolveUpwardRecipients(email: string, members: OrgMemberRow[], units: OrgUnitRow[]) {
  const member = members.find(item => item.email === email);
  if (!member) return [] as string[];
  const recipients = new Set<string>();
  if (member.directManagerEmail) recipients.add(member.directManagerEmail);
  const unitsById = new Map(units.map(unit => [unit.id, unit]));
  const visited = new Set<number>();
  let unitId: number | null | undefined = member.unitId;
  while (unitId && !visited.has(unitId)) {
    visited.add(unitId);
    const unit = unitsById.get(unitId);
    if (!unit) break;
    if (unit.managerEmail && unit.managerEmail !== email) recipients.add(unit.managerEmail);
    unitId = unit.parentId;
  }
  recipients.delete(email);
  return [...recipients];
}
