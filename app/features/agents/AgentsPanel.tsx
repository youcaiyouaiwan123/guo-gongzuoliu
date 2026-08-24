"use client";

import type { Agent, AgentRun } from "../shared-types";
import { PlusIcon } from "../../components/icons";
import { Pager } from "../Pager";
import { usePaged } from "../usePaged";

type AgentSettings = { modelMode?: string; welcomeMessage?: string; capabilities?: string[]; knowledgeCategory?: string; publishTarget?: string };
type ModuleName = "agent" | "workflow" | "source";

export interface AgentsPanelProps {
  agents: Agent[];
  agentRuns: AgentRun[];
  activeAgent: Agent | null;
  selectedAgentIds: number[];
  setSelectedAgentIds: React.Dispatch<React.SetStateAction<number[]>>;
  setAllSelectedIds: (ids: number[], setIds: (value: number[]) => void, checked: boolean) => void;
  toggleSelectedId: (ids: number[], setIds: (value: number[]) => void, id: number) => void;
  setModalType: React.Dispatch<React.SetStateAction<ModuleName | null>>;
  agentSettings: (agent: Agent) => AgentSettings;
  startAgent: (agent: Agent) => void;
  deleteModule: (moduleName: ModuleName, id: number, name: string) => Promise<void>;
  deleteSelectedModules: (moduleName: ModuleName, ids: number[], clear: (value: number[]) => void) => Promise<void>;
  loadModules: () => Promise<void>;
}

export default function AgentsPanel({ agents, agentRuns, activeAgent, selectedAgentIds, setSelectedAgentIds, setAllSelectedIds, toggleSelectedId, setModalType, agentSettings, startAgent, deleteModule, deleteSelectedModules, loadModules }: AgentsPanelProps) {
  const pagedAgents = usePaged(agents, 9);
  const pagedRuns = usePaged(agentRuns, 10);
  return <section className="contentPanel">
    <div className="metricRow"><article><span>智能体总数</span><b>{agents.length}</b><small>按岗位独立配置</small></article><article><span>已启用</span><b>{agents.filter(a=>a.status==="已启用").length}</b><small>共享统一安全边界</small></article><article><span>知识权限</span><b>角色隔离</b><small>每次问答重新校验</small></article></div>
    <div className="sectionTitle"><div><h2>企业智能体</h2></div><button onClick={()=>setModalType("agent")}><PlusIcon style={{ width: 12, height: 12 }} /> 创建智能体</button></div>
    {!!agents.length&&<div className="bulkActionBar"><label><input type="checkbox" checked={agents.every(item=>selectedAgentIds.includes(item.id))} onChange={event=>setAllSelectedIds(agents.map(item=>item.id),setSelectedAgentIds,event.target.checked)}/>全选</label><button className="dangerButton" disabled={!selectedAgentIds.length} onClick={()=>deleteSelectedModules("agent",selectedAgentIds,setSelectedAgentIds)}>删除选中（{selectedAgentIds.length}）</button></div>}
    <div className="moduleGrid">{agents.length ? pagedAgents.pageItems.map(a=>{const settings=agentSettings(a);return <article key={a.id} className={activeAgent?.id===a.id?"activeModule":""}><span className="moduleIcon">AI</span><div><h3>{a.name}</h3><p>{a.description}</p><small>知识：{settings.knowledgeCategory||a.knowledgeScope} · 模型：{settings.modelMode==="auto"||!settings.modelMode?"自动选择":"指定模型"}</small><div className="agentTags">{(settings.capabilities||[]).slice(0,4).map(item=><span key={item}>{({knowledge:"知识",workflow:"工作流",data:"采集",approval:"审批",artifacts:"沉淀",connectors:"平台"} as Record<string,string>)[item]||item}</span>)}{settings.publishTarget&&<span>{settings.publishTarget}</span>}</div></div><em>{activeAgent?.id===a.id?"运行中":a.status}</em><div className="moduleActions"><button disabled={a.status!=="已启用"} onClick={()=>startAgent(a)}>{activeAgent?.id===a.id?"继续使用":"开始使用"}</button><label className="itemSelect"><input type="checkbox" checked={selectedAgentIds.includes(a.id)} onChange={()=>toggleSelectedId(selectedAgentIds,setSelectedAgentIds,a.id)}/>选择</label><button className="dangerButton" onClick={()=>deleteModule("agent",a.id,a.name)}>删除</button></div></article>}) : <div className="emptyState"><b>还没有智能体</b></div>}</div>
    <Pager page={pagedAgents.page} pageSize={pagedAgents.pageSize} total={pagedAgents.total} onChange={pagedAgents.setPage} />
    {!!agentRuns.length&&<><div className="sectionTitle subTitle"><div><h2>智能体运行记录</h2></div><button className="outline" onClick={loadModules}>刷新</button></div><div className="runList">{pagedRuns.pageItems.map(run=><article key={run.id}><span className={`runState ${run.status}`}>{run.status}</span><b>{run.agentName}</b><small>{run.actor} · {run.modelUsed||"未配置"} · {new Date(run.createdAt).toLocaleString("zh-CN")}</small><p>{run.input}</p></article>)}</div><Pager page={pagedRuns.page} pageSize={pagedRuns.pageSize} total={pagedRuns.total} onChange={pagedRuns.setPage} /></>}
  </section>;
}
