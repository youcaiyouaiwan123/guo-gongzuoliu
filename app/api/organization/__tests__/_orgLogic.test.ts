import { describe, it, expect } from "vitest";
import {
  buildOrgTree,
  findDuplicateUnit,
  normalizeUnitName,
  resolveUpwardRecipients,
  type OrgMemberRow,
  type OrgUnitRow,
} from "../_orgLogic";

// 三级架构：总公司 → 销售部 → 华东销售组，另有一个平级的市场部。
const units: OrgUnitRow[] = [
  { id: 1, name: "海芯博创", unitType: "公司", parentId: null, managerEmail: "boss@haixin.com" },
  { id: 2, name: "销售部", unitType: "部门", parentId: 1, managerEmail: "sales-head@haixin.com" },
  { id: 3, name: "华东销售组", unitType: "岗位组", parentId: 2, managerEmail: "east-lead@haixin.com" },
  { id: 4, name: "市场部", unitType: "部门", parentId: 1, managerEmail: "market-head@haixin.com" },
];

const members: OrgMemberRow[] = [
  { email: "boss@haixin.com", unitId: 1, jobTitle: "总经理", directManagerEmail: "", status: "在岗" },
  { email: "sales-head@haixin.com", unitId: 2, jobTitle: "销售总监", directManagerEmail: "boss@haixin.com", status: "在岗" },
  { email: "east-lead@haixin.com", unitId: 3, jobTitle: "华东负责人", directManagerEmail: "sales-head@haixin.com", status: "在岗" },
  { email: "zhang@haixin.com", unitId: 3, jobTitle: "销售代表", directManagerEmail: "", status: "在岗" },
];

describe("normalizeUnitName", () => {
  it("忽略空格与全角括号差异", () => {
    expect(normalizeUnitName("市场 部")).toBe(normalizeUnitName("市场部"));
    expect(normalizeUnitName("市场部（新）")).toBe(normalizeUnitName("市场部(新)"));
    expect(normalizeUnitName("　销售部　")).toBe(normalizeUnitName("销售部"));
  });
});

describe("findDuplicateUnit", () => {
  it("同一上级下重名被拦截", () => {
    expect(findDuplicateUnit(units, { name: "销售部", parentId: 1 })?.id).toBe(2);
  });

  it("加空格或换全角括号绕不过判重", () => {
    expect(findDuplicateUnit(units, { name: " 销售 部 ", parentId: 1 })?.id).toBe(2);
  });

  it("不同上级下允许同名", () => {
    expect(findDuplicateUnit(units, { name: "销售部", parentId: 4 })).toBeNull();
    expect(findDuplicateUnit(units, { name: "销售部", parentId: null })).toBeNull();
  });

  it("编辑自身时不算重名", () => {
    expect(findDuplicateUnit(units, { id: 2, name: "销售部", parentId: 1 })).toBeNull();
  });

  it("空名称不参与判重（由必填校验负责）", () => {
    expect(findDuplicateUnit(units, { name: "   ", parentId: 1 })).toBeNull();
  });
});

describe("buildOrgTree", () => {
  it("员工挂在自己所属部门下", () => {
    const tree = buildOrgTree(units, members);
    const east = tree[0].children.find(node => node.unit.id === 2)!.children[0];
    expect(east.unit.name).toBe("华东销售组");
    expect(east.members.map(item => item.email)).toEqual(["east-lead@haixin.com", "zhang@haixin.com"]);
  });

  it("离职（从 org_members 移除）后不再出现在树上", () => {
    const tree = buildOrgTree(units, members.filter(item => item.email !== "zhang@haixin.com"));
    const east = tree[0].children.find(node => node.unit.id === 2)!.children[0];
    expect(east.members.map(item => item.email)).toEqual(["east-lead@haixin.com"]);
  });

  it("上级被删除的孤儿节点仍作为根节点出现，不会整棵子树消失", () => {
    const orphaned = units.filter(unit => unit.id !== 1);
    const tree = buildOrgTree(orphaned, members);
    expect(tree.map(node => node.unit.id).sort()).toEqual([2, 4]);
    expect(tree.find(node => node.unit.id === 2)!.children[0].unit.id).toBe(3);
  });

  it("parent 指向成环时不会无限递归", () => {
    const cyclic: OrgUnitRow[] = [
      { id: 1, name: "A", parentId: 2 },
      { id: 2, name: "B", parentId: 1 },
    ];
    expect(() => buildOrgTree(cyclic, [])).not.toThrow();
  });

  it("空部门返回空成员数组而不是 undefined", () => {
    expect(buildOrgTree(units, [])[0].members).toEqual([]);
  });
});

describe("resolveUpwardRecipients", () => {
  it("直属上级与各级部门负责人都可作为汇报对象", () => {
    const recipients = resolveUpwardRecipients("zhang@haixin.com", members, units);
    expect(recipients).toEqual(expect.arrayContaining([
      "east-lead@haixin.com",
      "sales-head@haixin.com",
      "boss@haixin.com",
    ]));
    expect(recipients).toHaveLength(3);
  });

  it("直属上级排在最前面", () => {
    expect(resolveUpwardRecipients("east-lead@haixin.com", members, units)[0]).toBe("sales-head@haixin.com");
  });

  it("本人是部门负责人时不会出现在自己的汇报对象里", () => {
    expect(resolveUpwardRecipients("sales-head@haixin.com", members, units)).not.toContain("sales-head@haixin.com");
  });

  it("重复的上级只出现一次", () => {
    const duplicated: OrgMemberRow[] = [
      { email: "zhang@haixin.com", unitId: 3, directManagerEmail: "east-lead@haixin.com" },
    ];
    const recipients = resolveUpwardRecipients("zhang@haixin.com", duplicated, units);
    expect(recipients.filter(item => item === "east-lead@haixin.com")).toHaveLength(1);
  });

  it("未加入任何部门时返回空列表", () => {
    expect(resolveUpwardRecipients("nobody@haixin.com", members, units)).toEqual([]);
  });

  it("组织成环时不会死循环", () => {
    const cyclic: OrgUnitRow[] = [
      { id: 1, name: "A", parentId: 2, managerEmail: "a@haixin.com" },
      { id: 2, name: "B", parentId: 1, managerEmail: "b@haixin.com" },
    ];
    const recipients = resolveUpwardRecipients("x@haixin.com", [{ email: "x@haixin.com", unitId: 1 }], cyclic);
    expect(recipients.sort()).toEqual(["a@haixin.com", "b@haixin.com"]);
  });
});
