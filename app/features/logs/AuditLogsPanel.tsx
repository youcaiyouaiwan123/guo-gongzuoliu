"use client";

import type { Log } from "../shared-types";

export interface AuditLogsPanelProps {
  logs: Log[];
  setLogs: React.Dispatch<React.SetStateAction<Log[]>>;
  selectedLogIds: number[];
  setSelectedLogIds: React.Dispatch<React.SetStateAction<number[]>>;
  setNotice: (message: string) => void;
  loadState: () => Promise<void>;
}

export default function AuditLogsPanel({ logs, setLogs, selectedLogIds, setSelectedLogIds, setNotice, loadState }: AuditLogsPanelProps) {
  async function deleteAuditLog(log: Log) {
    if (!confirm(`确认删除“${log.action} / ${log.resource}”这条审计记录吗？删除后无法恢复。`)) return;
    const response = await fetch(`/api/state?auditLogId=${log.id}`, { method: "DELETE" });
    const data = await response.json();
    if (!response.ok) return setNotice(data.error || "删除审计记录失败");
    setLogs(current => current.filter(item => item.id !== log.id));
    setSelectedLogIds(current => current.filter(id => id !== log.id));
    setNotice(data.message || "审计记录已删除");
  }
  function toggleAllLogs() {
    setSelectedLogIds(selectedLogIds.length === logs.length ? [] : logs.map(log => log.id));
  }
  async function deleteAuditLogs(mode: "selected" | "all") {
    if (mode === "selected" && !selectedLogIds.length) return setNotice("请先选择要删除的审计记录");
    const countText = mode === "all" ? "全部审计记录" : `选中的 ${selectedLogIds.length} 条审计记录`;
    if (!confirm(`确认删除${countText}吗？删除后无法恢复。`)) return;
    const query = mode === "all" ? "allAuditLogs=true" : `auditLogIds=${selectedLogIds.join(",")}`;
    const response = await fetch(`/api/state?${query}`, { method: "DELETE" });
    const data = await response.json();
    if (!response.ok) return setNotice(data.error || "批量删除审计记录失败");
    if (mode === "all") setLogs([]);
    else setLogs(current => current.filter(item => !selectedLogIds.includes(item.id)));
    setSelectedLogIds([]);
    setNotice(data.message || "审计记录已删除");
  }

  return <section className="contentPanel"><div className="sectionTitle"><div><h2>真实审计记录</h2></div><div className="auditToolbar"><button className="outline" onClick={loadState}>刷新记录</button><button className="dangerButton" disabled={!selectedLogIds.length} onClick={()=>deleteAuditLogs("selected")}>删除选中{selectedLogIds.length?`（${selectedLogIds.length}）`:""}</button><button className="dangerButton" disabled={!logs.length} onClick={()=>deleteAuditLogs("all")}>全部删除</button></div></div><div className="auditTable"><div className="auditRow head"><input type="checkbox" aria-label="全选当前审计记录" checked={logs.length>0&&selectedLogIds.length===logs.length} onChange={toggleAllLogs}/><b>时间</b><b>操作人</b><b>动作</b><b>资源</b><b>结果</b><b>操作</b></div>{logs.map(l => <div className="auditRow" key={l.id}><input type="checkbox" aria-label={`选择${l.action}`} checked={selectedLogIds.includes(l.id)} onChange={()=>setSelectedLogIds(current=>current.includes(l.id)?current.filter(id=>id!==l.id):[...current,l.id])}/><span>{new Date(l.createdAt).toLocaleString("zh-CN")}</span><span>{l.actor}</span><span>{l.action}</span><span title={l.detail}>{l.resource}</span><span className={l.result==="拒绝"?"result deniedResult":"result"}>{l.result}</span><button className="auditDeleteButton" onClick={() => deleteAuditLog(l)}>删除</button></div>)}{!logs.length && <div className="emptyState"></div>}</div></section>;
}
