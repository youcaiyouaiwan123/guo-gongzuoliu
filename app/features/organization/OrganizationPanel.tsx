"use client";

import { useState } from "react";
import type { OrgMember, OrgReport, OrgUnit, TransferRequest } from "../shared-types";
import { unitMark } from "../shared-utils";
import { PlusIcon } from "../../components/icons";

type OrgModalType = "unit" | "member" | "transfer" | "report" | null;
type OrgTab = "manage" | "chart" | "reports";

export interface OrganizationPanelProps {
  orgUnits: OrgUnit[];
  orgMembers: OrgMember[];
  orgOwner: string;
  myMember: OrgMember | null;
  reminders: { approvals: number; reports: number };
  transfers: TransferRequest[];
  orgReports: OrgReport[];
  reportRecipients: string[];
  selectedUnitId: number | null;
  memberQuery: string;
  appRole: string;
  userEmail: string;
  setSelectedUnitId: React.Dispatch<React.SetStateAction<number | null>>;
  setMemberQuery: React.Dispatch<React.SetStateAction<string>>;
  setOrgModal: React.Dispatch<React.SetStateAction<OrgModalType>>;
  setEditingUnit: React.Dispatch<React.SetStateAction<OrgUnit | null>>;
  setEditingMember: React.Dispatch<React.SetStateAction<OrgMember | null>>;
  setNotice: (message: string) => void;
  loadOrganization: () => Promise<void>;
  loadGovernance: () => Promise<void>;
  loadState: () => Promise<void>;
}

export default function OrganizationPanel({ orgUnits, orgMembers, orgOwner, myMember, reminders, transfers, orgReports, reportRecipients, selectedUnitId, memberQuery, appRole, userEmail, setSelectedUnitId, setMemberQuery, setOrgModal, setEditingUnit, setEditingMember, setNotice, loadOrganization, loadGovernance, loadState }: OrganizationPanelProps) {
  const [tab, setTab] = useState<OrgTab>("manage");
  // 架构图里展开显示全部成员的部门；默认折叠，避免大部门把整棵树撑开。
  const [expandedUnitIds, setExpandedUnitIds] = useState<number[]>([]);
  const selectedUnit = orgUnits.find(unit => unit.id === selectedUnitId) || null;
  const selectedMembers = orgMembers.filter(member => member.unitId === selectedUnitId && (!memberQuery.trim() || `${member.email} ${member.jobTitle}`.toLowerCase().includes(memberQuery.trim().toLowerCase())));

  // unitName 来自 LEFT JOIN，成员挂在已删除部门上时为 null；
  // 直接插进模板字符串会在界面上渲染出字面量 "null"。
  const unitNameOf = (member: OrgMember) => member.unitName || "未分配部门";

  const orgTree = orgUnits.filter(unit=>!unit.parentId||!orgUnits.some(parent=>parent.id===unit.parentId));

  const CHART_MEMBER_PREVIEW = 6;

  function renderOrgUnit(unit: OrgUnit, path = new Set<number>()) {
    if (path.has(unit.id)) return null;
    const nextPath = new Set(path); nextPath.add(unit.id);
    const mark = unitMark(unit);
    const members = orgMembers.filter(member => member.unitId === unit.id);
    const children = orgUnits.filter(child => child.parentId === unit.id);
    const expanded = expandedUnitIds.includes(unit.id);
    const visibleMembers = expanded ? members : members.slice(0, CHART_MEMBER_PREVIEW);
    return <li key={unit.id}>
      <article className="orgChartCard">
        <div className="orgNodeIcon" data-tone={mark.tone}>{mark.label}</div>
        <div className="orgNodeBody">
          <small>{unit.unitType || "组织节点"}</small>
          <h3>{unit.name?.trim() || "未命名组织"}</h3>
          <p>负责人：{unit.managerEmail || "待设置"} · {members.length} 人</p>
          {members.length ? <ul className="orgChartMembers">
            {visibleMembers.map(member => <li key={member.email} className={member.status === "在岗" ? "" : "leftMember"}>
              <b>{member.jobTitle || "员工"}</b>
              <span>{member.email}</span>
              {member.email === unit.managerEmail && <em className="memberBadge manager">负责人</em>}
              {member.email === orgOwner && <em className="memberBadge owner">老板</em>}
              {member.status && member.status !== "在岗" && <em className="memberBadge">{member.status}</em>}
              <small>上级：{member.directManagerEmail || unit.managerEmail || "按上级部门逐级汇报"}</small>
            </li>)}
            {members.length > CHART_MEMBER_PREVIEW && <li className="orgChartMoreMembers">
              <button type="button" onClick={() => setExpandedUnitIds(current => expanded ? current.filter(id => id !== unit.id) : [...current, unit.id])}>
                {expanded ? "收起成员" : `展开全部 ${members.length} 人`}
              </button>
            </li>}
          </ul> : <p className="orgChartEmptyMembers">暂无成员{appRole === "管理员" ? "，可通过上方“分配成员”加入" : ""}</p>}
        </div>
        <b className="orgPeopleCount">{members.length}人</b>
      </article>
      {children.length > 0 && <ul>{children.map(child => renderOrgUnit(child, nextPath))}</ul>}
    </li>;
  }

  async function decideTransfer(id: number, status: "已通过" | "已拒绝") {
    const response = await fetch("/api/organization", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "decideTransfer", id: String(id), status }) });
    const data = await response.json();
    setNotice(response.ok ? `转岗申请${status}` : data.error || "处理失败");
    if (response.ok) await Promise.all([loadOrganization(), loadGovernance(), loadState()]);
  }

  async function manageOrgMember(member: OrgMember, action: "removeMember" | "offboardMember") {
    const offboard = action === "offboardMember";
    const message = offboard
      ? `确定将 ${member.email} 标记为离职吗？\n\n系统会解除其部门、岗位和汇报关系，历史汇报、审批及审计记录仍会保留。`
      : `确定将 ${member.email} 移出 ${unitNameOf(member)} 吗？\n\n账号仍可使用，之后可以重新分配部门。`;
    if (!confirm(message)) return;
    const response = await fetch("/api/organization", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, email: member.email }) });
    const data = await response.json();
    setNotice(response.ok ? (offboard ? "离职处理完成，组织权限已解除" : "成员已移出部门") : data.error || "处理失败");
    if (response.ok) await Promise.all([loadOrganization(), loadGovernance(), loadState()]);
  }

  async function handleReport(id: number) {
    const response = await fetch("/api/organization", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "handleReport", id: String(id) }) });
    const data = await response.json();
    setNotice(response.ok ? "汇报已标记为处理完成" : data.error || "处理失败");
    if (response.ok) await Promise.all([loadOrganization(), loadState()]);
  }

  async function deleteOrgUnit(unit: OrgUnit) {
    if (!confirm(`确定删除组织节点“${unit.name}”吗？\n\n只有没有下级组织和成员的空节点可以删除。`)) return;
    const response = await fetch(`/api/organization?id=${unit.id}`, { method: "DELETE" });
    const data = await response.json();
    setNotice(response.ok ? "组织节点已删除" : data.error || "删除失败");
    if (response.ok) await Promise.all([loadOrganization(), loadState()]);
  }

  return <section className="contentPanel orgPage">
    {/* 顶部：3 统计 + 操作按钮（单行紧凑） */}
    <header className="orgHeader">
      <div className="metricRow compact">
        <article><span>组织节点</span><b>{orgUnits.length}</b><small>部门、岗位组可无限向下扩展</small></article>
        <article><span>在岗成员</span><b>{orgMembers.length}</b><small>{myMember?`${unitNameOf(myMember)} · ${myMember.jobTitle}`:"尚未加入部门"}</small></article>
        <article><span>管理待办</span><b>{reminders.approvals+reminders.reports}</b><small>{reminders.reports} 份未读汇报 · {reminders.approvals} 项审批</small></article>
      </div>
      <div className="orgHeaderActions">
        {appRole==="管理员"&&<>
          <button className="primary" onClick={()=>{setEditingUnit(null);setOrgModal("unit")}}><PlusIcon style={{ width: 12, height: 12 }} /> 新增组织</button>
          <button onClick={()=>{setEditingMember(null);setOrgModal("member")}}>分配成员</button>
        </>}
        <button onClick={()=>setOrgModal("transfer")}>{myMember?"申请转岗":"选择部门"}</button>
        {reportRecipients.length>0&&<button onClick={()=>setOrgModal("report")}>向上汇报</button>}
      </div>
    </header>

    {/* Tab 切换 */}
    <div className="orgTabs" role="tablist">
      <button type="button" role="tab" className={tab==="manage"?"active":""} onClick={()=>setTab("manage")}>组织管理<span className="tabBadge">{orgUnits.length}</span></button>
      <button type="button" role="tab" className={tab==="chart"?"active":""} onClick={()=>setTab("chart")}>公司架构图</button>
      <button type="button" role="tab" className={tab==="reports"?"active":""} onClick={()=>setTab("reports")}>逐级汇报<span className="tabBadge">{orgReports.length}</span></button>
    </div>

    {/* Tab 内容（可滚动） */}
    <div className="orgContent">
      {tab==="manage" && <>
        <div className="orgLayout">
          <div className="orgTree departmentDirectory">
            <div className="subTitle"><div><h3>部门管理</h3></div><span>{orgUnits.length} 个节点</span></div>
            <div className="departmentCardGrid">{orgUnits.length?orgUnits.map(unit=>{const mark=unitMark(unit);const memberCount=orgMembers.filter(member=>member.unitId===unit.id).length;const parent=orgUnits.find(item=>item.id===unit.parentId);return <button type="button" key={unit.id} className={`departmentCard ${selectedUnitId===unit.id?"selected":""}`} onClick={()=>{setSelectedUnitId(unit.id);setMemberQuery("")}}><span className="orgNodeIcon" data-tone={mark.tone}>{mark.label}</span><span className="departmentCardBody"><small>{parent?`${parent.name} / `:""}{unit.unitType}</small><b>{unit.name}</b><em>负责人：{unit.managerEmail||"待设置"}</em></span><strong>{memberCount}人</strong><i>查看人员 →</i></button>}):<div className="emptyState"><b>还没有部门</b></div>}</div>
          </div>
          <aside className="orgSide">
            <div className="departmentHead"><div><small>当前选择</small><h3>{selectedUnit?.name||"请选择部门"}</h3>{selectedUnit&&<p>{selectedUnit.unitType} · 负责人：{selectedUnit.managerEmail||"待设置"} · {orgMembers.filter(member=>member.unitId===selectedUnit.id).length}人</p>}</div>{appRole==="管理员"&&selectedUnit&&<div><button onClick={()=>{setEditingUnit(selectedUnit);setOrgModal("unit")}}>编辑组织</button><button className="dangerButton" onClick={()=>deleteOrgUnit(selectedUnit)}>删除组织</button></div>}</div>
            {selectedUnit&&<><input className="memberSearch" value={memberQuery} onChange={event=>setMemberQuery(event.target.value)} placeholder="搜索姓名邮箱或岗位"/><div className="departmentMembers">{selectedMembers.length?selectedMembers.map(member=><article key={member.email}><div><b>{member.jobTitle}</b><span>{member.email}</span>{member.email===orgOwner&&<strong className="ownerBadge">老板</strong>}</div>{appRole==="管理员"&&<div className="departmentMemberActions"><button onClick={()=>{setEditingMember(member);setOrgModal("member")}}>调整岗位</button>{member.email!==orgOwner?<><button onClick={()=>manageOrgMember(member,"removeMember")}>移出部门</button><button className="dangerButton" onClick={()=>manageOrgMember(member,"offboardMember")}>办理离职</button></>:<span className="ownerProtected">最高权限保护</span>}</div>}</article>):<div className="emptyMini"><b>暂无匹配成员</b><p>可以点击上方“分配成员”加入该部门。</p></div>}</div></>}
            <div className="orgSideDivider"/>
            <h3>我的组织关系</h3>
            {myMember?<div className="myOrgCard"><span>{unitNameOf(myMember)}</span><b>{myMember.jobTitle}</b><p>直属上级：{myMember.directManagerEmail||"按部门负责人逐级汇报"}</p></div>:<div className="emptyMini"><b>未加入部门</b><p>选择部门后提交申请，负责人审批后生效。</p></div>}
            <h3>加入与转岗申请</h3>
            {transfers.slice(0,6).map(item=><div className="transferItem" key={item.id}><div><b>{item.email}</b><span>{item.fromUnitName||"未分配"} → {item.toUnitName}</span><small>{item.jobTitle} · {item.reason}</small></div><em className={`approvalState ${item.status}`}>{item.status}</em>{item.status==="待审批"&&(appRole==="管理员"||orgUnits.some(u=>u.id===item.toUnitId&&u.managerEmail===userEmail))&&<div><button onClick={()=>decideTransfer(item.id,"已通过")}>通过</button><button className="dangerButton" onClick={()=>decideTransfer(item.id,"已拒绝")}>拒绝</button></div>}</div>)}
          </aside>
        </div>
      </>}

      {tab==="chart" && <div className="orgChartSection">
        <div className="subTitle"><div><h3>公司架构图</h3></div><span className="liveStructure">● 自动同步</span></div>
        <div className="orgChartViewport">
          <div className="orgChartBoss"><span>企</span><div><small>企业最高负责人</small><h3>老板</h3><p>{orgOwner || userEmail}</p></div><b>最高权限</b></div>
          {orgTree.length?<ul className="orgChartRoot">{orgTree.map(unit=>renderOrgUnit(unit))}</ul>:<div className="emptyState"><b>老板节点已建立</b></div>}
        </div>
      </div>}

      {tab==="reports" && <div className="orgReportsSection">
        <div className="subTitle"><div><h3>逐级汇报与重要文件</h3></div>{reportRecipients.length>0&&<button onClick={()=>setOrgModal("report")}><PlusIcon style={{ width: 12, height: 12 }} /> 新建汇报</button>}</div>
        <div className="reportGrid">{orgReports.length?orgReports.map(report=><article key={report.id} className={report.importance==="重要"?"importantReport":""}><div className="reportHead"><span>{report.importance}</span><em className={`approvalState ${report.status}`}>{report.status}</em></div><h3>{report.title}</h3><p>{report.aiSummary||report.content}</p>{report.aiSummary&&<details><summary>查看员工原始汇报</summary><p>{report.content}</p></details>}{report.attachmentDocumentId&&<a href={`/api/state?download=${report.attachmentDocumentId}`}>下载汇报附件</a>}<small>{report.senderEmail} → {report.recipientEmail} · {new Date(report.createdAt).toLocaleString("zh-CN")}</small>{report.senderEmail!==userEmail&&report.status==="未读"&&<button onClick={()=>handleReport(report.id)}>标记已处理</button>}</article>):<div className="emptyState"><b>还没有逐级汇报</b></div>}</div>
      </div>}
    </div>
  </section>;
}
