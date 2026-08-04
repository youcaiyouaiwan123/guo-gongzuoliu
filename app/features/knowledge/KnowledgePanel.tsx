"use client";

import { useState } from "react";
import type { Doc, PersonalKnowledge, Tab } from "../shared-types";
import { PlusIcon, ChevronDownIcon } from "../../components/icons";

export interface KnowledgePanelProps {
  docs: Doc[];
  personalKnowledge: PersonalKnowledge[];
  knowledgeView: "enterprise" | "personal";
  knowledgeQuery: string;
  knowledgeCategory: string;
  selectedKnowledgeIds: number[];
  selectedPersonalKnowledgeIds: number[];
  appRole: string;
  userEmail: string;
  setDocs: React.Dispatch<React.SetStateAction<Doc[]>>;
  setNotice: (message: string) => void;
  setKnowledgeView: React.Dispatch<React.SetStateAction<"enterprise" | "personal">>;
  setKnowledgeQuery: React.Dispatch<React.SetStateAction<string>>;
  setKnowledgeCategory: React.Dispatch<React.SetStateAction<string>>;
  setSelectedKnowledgeIds: React.Dispatch<React.SetStateAction<number[]>>;
  setSelectedPersonalKnowledgeIds: React.Dispatch<React.SetStateAction<number[]>>;
  setShowUpload: (value: boolean) => void;
  setShowPersonalKnowledge: (value: boolean) => void;
  setViewingKnowledge: React.Dispatch<React.SetStateAction<{ title: string; content: string; meta: string; downloadName: string } | null>>;
  setInput: React.Dispatch<React.SetStateAction<string>>;
  setTab: React.Dispatch<React.SetStateAction<Tab>>;
  setAskMode: React.Dispatch<React.SetStateAction<"quick" | "guided" | "continuous">>;
  loadState: () => Promise<void>;
  loadGovernance: () => Promise<void>;
  loadPersonalKnowledge: () => Promise<void>;
  deleteBatch: (urls: string[]) => Promise<{ ok: number; failed: number }>;
  toggleSelectedId: (ids: number[], setIds: (value: number[]) => void, id: number) => void;
  setAllSelectedIds: (ids: number[], setIds: (value: number[]) => void, checked: boolean) => void;
  downloadKnowledgeText: (title: string, content: string) => void;
}

export default function KnowledgePanel({ docs, personalKnowledge, knowledgeView, knowledgeQuery, knowledgeCategory, selectedKnowledgeIds, selectedPersonalKnowledgeIds, appRole, userEmail, setDocs, setNotice, setKnowledgeView, setKnowledgeQuery, setKnowledgeCategory, setSelectedKnowledgeIds, setSelectedPersonalKnowledgeIds, setShowUpload, setShowPersonalKnowledge, setViewingKnowledge, setInput, setTab, setAskMode, loadState, loadGovernance, loadPersonalKnowledge, deleteBatch, toggleSelectedId, setAllSelectedIds, downloadKnowledgeText }: KnowledgePanelProps) {
  const deletableKnowledgeDocs = docs.filter(item => appRole === "管理员" || item.createdBy === userEmail);
  const [openDocMenu, setOpenDocMenu] = useState<number | null>(null);
  const [openPersonalMenu, setOpenPersonalMenu] = useState<number | null>(null);

  async function searchKnowledge() {
    const params = new URLSearchParams();
    if (knowledgeQuery.trim()) params.set("q", knowledgeQuery.trim());
    if (knowledgeCategory !== "全部分类") params.set("category", knowledgeCategory);
    const response = await fetch(`/api/state?${params}`);
    if (response.ok) setDocs((await response.json()).documents || []);
  }
  async function syncKnowledge(id: number) {
    const response = await fetch("/api/state", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, action: "sync" }) });
    const data = await response.json();
    setNotice(response.ok ? "已检查更新并刷新检索状态" : data.error || "同步失败");
    if (response.ok) await Promise.all([loadState(), loadGovernance()]);
  }
  async function deleteKnowledge(item: Doc) {
    if (!confirm(`确定永久删除知识资料“${item.title}”吗？\n\n资料记录和上传的原文件都会删除，此操作不能撤销。`)) return;
    const response = await fetch(`/api/state?id=${item.id}`, { method: "DELETE" });
    const data = await response.json();
    setNotice(response.ok ? data.message : data.error || "删除失败");
    if (response.ok) await loadState();
  }
  async function deletePersonalKnowledge(item: PersonalKnowledge) {
    if (!confirm(`确定删除个人知识“${item.title}”吗？已同步的企业副本不会被删除。`)) return;
    const response = await fetch(`/api/personal-knowledge?id=${item.id}`, { method: "DELETE" });
    const data = await response.json();
    setNotice(response.ok ? data.message : data.error || "删除失败");
    if (response.ok) await Promise.all([loadPersonalKnowledge(), loadState()]);
  }
  async function syncPersonalKnowledge(item: PersonalKnowledge) {
    if (!confirm(`确认把“${item.title}”同步到企业知识库吗？同步后将按企业知识权限供同部门或全员检索。`)) return;
    const response = await fetch("/api/personal-knowledge", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: item.id, visibility: appRole === "管理员" ? "全员" : "部门", category: "个人知识同步", tags: "个人知识,对话沉淀" }) });
    const data = await response.json();
    setNotice(response.ok ? data.message : data.error || "同步失败");
    if (response.ok) await Promise.all([loadPersonalKnowledge(), loadState()]);
  }
  function askAboutDocument(doc: Doc) {
    setInput(`请调用知识库中的《${doc.title}》（${doc.filename}，${doc.category}，V${doc.version}），先告诉我文件的主要内容和可执行事项。`);
    setTab("chat"); setAskMode("quick");
  }
  function askAboutPersonalKnowledge(item: PersonalKnowledge) {
    setInput(`请调用我的个人知识《${item.title}》，总结核心内容，并告诉我下一步可以怎么使用。`);
    setTab("chat"); setAskMode("quick");
  }
  async function deleteSelectedKnowledge() {
    if (!selectedKnowledgeIds.length) return setNotice("请先选择要删除的企业知识");
    if (!confirm(`确认删除选中的 ${selectedKnowledgeIds.length} 条企业知识吗？删除后无法恢复。`)) return;
    const result = await deleteBatch(selectedKnowledgeIds.map(id => `/api/state?id=${id}`));
    setSelectedKnowledgeIds([]);
    await loadState();
    setNotice(`已删除 ${result.ok} 条企业知识${result.failed ? `，${result.failed} 条失败` : ""}`);
  }
  async function deleteSelectedPersonalKnowledge() {
    if (!selectedPersonalKnowledgeIds.length) return setNotice("请先选择要删除的个人知识");
    if (!confirm(`确认删除选中的 ${selectedPersonalKnowledgeIds.length} 条个人知识吗？删除后无法恢复。`)) return;
    const result = await deleteBatch(selectedPersonalKnowledgeIds.map(id => `/api/personal-knowledge?id=${id}`));
    setSelectedPersonalKnowledgeIds([]);
    await loadPersonalKnowledge();
    setNotice(`已删除 ${result.ok} 条个人知识${result.failed ? `，${result.failed} 条失败` : ""}`);
  }

  return <section className="contentPanel">
    <div className="metricRow"><article><span>企业知识</span><b>{docs.length}</b><small>按部门与角色控制范围</small></article><article><span>我的个人知识</span><b>{personalKnowledge.length}</b><small>仅当前账号可检索</small></article><article><span>已同步企业</span><b>{personalKnowledge.filter(item=>item.syncStatus==="已同步企业知识").length}</b><small>保留个人副本与同步记录</small></article></div>
    <div className="knowledgeSwitch"><button className={knowledgeView==="enterprise"?"active":""} onClick={()=>setKnowledgeView("enterprise")}>企业知识库</button><button className={knowledgeView==="personal"?"active":""} onClick={()=>setKnowledgeView("personal")}>我的个人知识库</button></div>
    {knowledgeView==="enterprise"?<><div className="sectionTitle"><div><h2>企业知识库</h2></div><button onClick={() => setShowUpload(true)}><PlusIcon style={{ width: 12, height: 12 }} /> 上传知识文件</button></div>
    <div className="knowledgeToolbar"><input value={knowledgeQuery} onChange={e=>setKnowledgeQuery(e.target.value)} onKeyDown={e=>e.key==="Enter"&&searchKnowledge()} placeholder="搜索文件名、标签或正文…"/><select value={knowledgeCategory} onChange={e=>setKnowledgeCategory(e.target.value)}><option>全部分类</option>{["行政制度","人事资料","产品资料","销售方案","客户项目","企业宣传","财务制度","培训资料","其他"].map(x=><option key={x}>{x}</option>)}</select><button onClick={searchKnowledge}>搜索</button><button className="outline" onClick={()=>{setKnowledgeQuery("");setKnowledgeCategory("全部分类");loadState()}}>重置</button></div>
    {!!deletableKnowledgeDocs.length&&<div className="bulkActionBar"><label><input type="checkbox" checked={deletableKnowledgeDocs.every(item=>selectedKnowledgeIds.includes(item.id))} onChange={event=>setAllSelectedIds(deletableKnowledgeDocs.map(item=>item.id),setSelectedKnowledgeIds,event.target.checked)}/>全选</label><button className="dangerButton" disabled={!selectedKnowledgeIds.length} onClick={deleteSelectedKnowledge}>删除选中（{selectedKnowledgeIds.length}）</button></div>}<div className="knowledgeGrid">{docs.length ? docs.map(d => { const canDelete = appRole==="管理员" || d.createdBy===userEmail; return (<article key={d.id} className="knowledgeCard"><div className="cardTopRow"><span className="docIcon">{/\.(png|jpg|jpeg|webp)$/i.test(d.filename)?"▧":/\.(xlsx|csv)$/i.test(d.filename)?"▦":/\.(pdf)$/i.test(d.filename)?"▢":"▤"}</span>{canDelete && <label className="itemSelect" onClick={event => event.stopPropagation()}><input type="checkbox" checked={selectedKnowledgeIds.includes(d.id)} onChange={()=>toggleSelectedId(selectedKnowledgeIds,setSelectedKnowledgeIds,d.id)}/></label>}<div className="cardMenuWrap" onMouseLeave={() => setOpenDocMenu(null)}><button className="cardMenuTrigger" type="button" onClick={() => setOpenDocMenu(openDocMenu === d.id ? null : d.id)} aria-label="更多操作" title="更多操作">⋮</button>{openDocMenu === d.id && (<div className="cardMenu" role="menu"><button type="button" role="menuitem" onClick={() => { setViewingKnowledge({title:d.title,content:d.content||"暂无可查看正文。上传型非文本文件请下载文件查看。",meta:`${d.category} · ${d.visibility} · V${d.version}`,downloadName:d.filename||d.title}); setOpenDocMenu(null); }}>查看全文</button>{d.filename ? <a role="menuitem" href={`/api/state?download=${d.id}`}>下载文件</a> : <button type="button" role="menuitem" onClick={() => { downloadKnowledgeText(d.title, d.content); setOpenDocMenu(null); }}>下载文件</button>}<button type="button" role="menuitem" onClick={() => { syncKnowledge(d.id); setOpenDocMenu(null); }}>检查更新</button>{canDelete && <button type="button" role="menuitem" className="menuDanger" onClick={() => { deleteKnowledge(d); setOpenDocMenu(null); }}>删除</button>}</div>)}</div></div><h3>{d.title}</h3><div className="docMetaRow"><span className="docCategory">{d.category}</span><span className="docDot">·</span><span className="docVisibility">{d.visibility}</span><span className="docDot">·</span><span>V{d.version}</span><em className={d.status==="待解析"?"pending":""}>{d.status}</em></div><p className="docFilename">{d.filename||"在线文本"}<small>{d.sizeBytes?` · ${Math.max(1,Math.round(d.sizeBytes/1024))}KB`:" · 文本资料"}</small></p><small className="docUpdateMode">{d.updateMode}{d.updateSchedule?` · ${d.updateSchedule}`:""} · {d.createdBy}</small><div className="cardPrimaryAction"><button className="askAiButton" onClick={()=>askAboutDocument(d)}>让AI调用</button></div></article>); }) : <div className="emptyState"><b>没有匹配的企业资料</b></div>}</div></>:<><div className="sectionTitle"><div><h2>我的个人知识库</h2></div><button onClick={()=>setShowPersonalKnowledge(true)}><PlusIcon style={{ width: 12, height: 12 }} /> 新建个人知识</button></div>{!!personalKnowledge.length&&<div className="bulkActionBar"><label><input type="checkbox" checked={personalKnowledge.every(item=>selectedPersonalKnowledgeIds.includes(item.id))} onChange={event=>setAllSelectedIds(personalKnowledge.map(item=>item.id),setSelectedPersonalKnowledgeIds,event.target.checked)}/>全选</label><button className="dangerButton" disabled={!selectedPersonalKnowledgeIds.length} onClick={deleteSelectedPersonalKnowledge}>删除选中（{selectedPersonalKnowledgeIds.length}）</button></div>}<div className="knowledgeGrid">{personalKnowledge.length?personalKnowledge.map(item => (<article key={item.id} className="knowledgeCard personalKnowledgeCard"><div className="cardTopRow"><span className="docIcon personalIcon">私</span><label className="itemSelect" onClick={event => event.stopPropagation()}><input type="checkbox" checked={selectedPersonalKnowledgeIds.includes(item.id)} onChange={()=>toggleSelectedId(selectedPersonalKnowledgeIds,setSelectedPersonalKnowledgeIds,item.id)}/></label><div className="cardMenuWrap" onMouseLeave={() => setOpenPersonalMenu(null)}><button className="cardMenuTrigger" type="button" onClick={() => setOpenPersonalMenu(openPersonalMenu === item.id ? null : item.id)} aria-label="更多操作" title="更多操作">⋮</button>{openPersonalMenu === item.id && (<div className="cardMenu" role="menu"><button type="button" role="menuitem" onClick={() => { setViewingKnowledge({title:item.title,content:item.content,meta:`${item.sourceType} · ${item.syncStatus}`,downloadName:item.title}); setOpenPersonalMenu(null); }}>查看全文</button><button type="button" role="menuitem" onClick={() => { downloadKnowledgeText(item.title, item.content); setOpenPersonalMenu(null); }}>下载文件</button><button type="button" role="menuitem" onClick={() => { syncPersonalKnowledge(item); setOpenPersonalMenu(null); }}>同步企业知识</button><button type="button" role="menuitem" className="menuDanger" onClick={() => { deletePersonalKnowledge(item); setOpenPersonalMenu(null); }}>删除</button></div>)}</div></div><h3>{item.title}</h3><div className="docMetaRow"><span className="docCategory">{item.sourceType}</span><span className="docDot">·</span><span className="docVisibility">{item.syncStatus}</span><em className={item.syncStatus==="已同步企业知识"?"":"pending"}>{item.syncStatus}</em></div><p className="docFilename">{item.content.replace(/[#>*_-]/g," ").slice(0,110)}{item.content.length>110?"…":""}</p><small className="docUpdateMode">{new Date(item.updatedAt).toLocaleString("zh-CN")}</small><div className="cardPrimaryAction"><button className="askAiButton" onClick={()=>askAboutPersonalKnowledge(item)}>让AI调用</button></div></article>)) : <div className="emptyState"><b>还没有个人知识</b></div>}</div></>}
  </section>;
}
