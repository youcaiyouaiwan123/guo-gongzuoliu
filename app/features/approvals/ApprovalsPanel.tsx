"use client";

import type { ApprovalRequest } from "../shared-types";
import { PlusIcon } from "../../components/icons";
import { Pager } from "../Pager";
import { usePaged } from "../usePaged";

export interface ApprovalsPanelProps {
  approvals: ApprovalRequest[];
  appRole: string;
  userEmail: string;
  orgOwner: string;
  setShowApproval: (value: boolean) => void;
  setNotice: (message: string) => void;
  loadGovernance: () => Promise<void>;
  loadState: () => Promise<void>;
}

export default function ApprovalsPanel({ approvals, appRole, userEmail, orgOwner, setShowApproval, setNotice, loadGovernance, loadState }: ApprovalsPanelProps) {
  const { pageItems: pagedApprovals, page, pageSize, total, setPage } = usePaged(approvals, 10);
  async function decideApproval(id: number, status: "已通过" | "已拒绝") {
    const response = await fetch("/api/governance", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "decide", id: String(id), status }) });
    const data = await response.json();
    setNotice(response.ok ? (data.workflowRun ? `审批${status}，关联工作流已自动续跑至“${data.workflowRun.status}”` : `审批${status}`) : data.error || "处理失败");
    if (response.ok) await Promise.all([loadGovernance(), loadState()]);
  }

  async function withdrawApproval(id: number, title: string) {
    if (!confirm(`确定撤回审批“${title}”吗？\n\n审批不会被删除，撤回结果将保留在审计记录中。`)) return;
    const response = await fetch("/api/governance", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "withdraw", id: String(id) }) });
    const data = await response.json();
    setNotice(response.ok ? "审批已撤回" : data.error || "撤回失败");
    if (response.ok) await Promise.all([loadGovernance(), loadState()]);
  }

  return <section className="contentPanel">
    <div className="metricRow"><article><span>待处理</span><b>{approvals.filter(a=>a.status==="待审批").length}</b><small>只进入指定审批人的待办</small></article><article><span>已通过</span><b>{approvals.filter(a=>a.status==="已通过").length}</b><small>结果永久留痕</small></article><article><span>已拒绝</span><b>{approvals.filter(a=>a.status==="已拒绝").length}</b><small>可查看处理结果</small></article></div>
    <div className="sectionTitle"><div><h2>{appRole==="管理员"?"企业审批台":"我的审批"}</h2></div><button onClick={()=>setShowApproval(true)}><PlusIcon style={{ width: 12, height: 12 }} /> 发起审批</button></div>
    <div className="approvalList">{approvals.length ? pagedApprovals.map(a=><article key={a.id}><div><span className={`approvalState ${a.status}`}>{a.status}</span><h3>{a.title}</h3><p>{a.requestType} · {a.requester} → {a.approverEmail||"未指定审批人"}</p><small>{a.reason}</small>{a.approver && <small>实际处理人：{a.approver} · {a.comment}</small>}</div><time>{new Date(a.createdAt).toLocaleString("zh-CN")}</time>{a.status==="待审批"&&<div className="approvalButtons">{(a.approverEmail===userEmail||userEmail===orgOwner)&&<><button onClick={()=>decideApproval(a.id,"已通过")}>同意</button><button className="reject" onClick={()=>decideApproval(a.id,"已拒绝")}>拒绝</button></>}{a.requester===userEmail&&<button className="dangerButton" onClick={()=>withdrawApproval(a.id,a.title)}>撤回</button>}</div>}</article>) : <div className="emptyState"><b>还没有审批记录</b></div>}</div>
    <Pager page={page} pageSize={pageSize} total={total} onChange={setPage} />
  </section>;
}
