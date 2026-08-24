"use client";

import type { Workflow, WorkflowRun } from "../shared-types";
import { parseWorkflowNodes, statusClassName } from "../shared-utils";
import { PlayIcon, PlusIcon, RefreshIcon } from "../../components/icons";
import { Pager } from "../Pager";
import { usePaged } from "../usePaged";

type ModuleName = "agent" | "workflow" | "source";

export interface WorkflowsPanelProps {
  workflows: Workflow[];
  workflowRuns: WorkflowRun[];
  selectedWorkflowIds: number[];
  runWorkflow: Workflow | null;
  runningWorkflow: boolean;
  setRunningWorkflow: React.Dispatch<React.SetStateAction<boolean>>;
  runInput: string;
  selectedRun: WorkflowRun | null;
  setModalType: React.Dispatch<React.SetStateAction<ModuleName | null>>;
  setSelectedWorkflowIds: React.Dispatch<React.SetStateAction<number[]>>;
  setRunWorkflow: React.Dispatch<React.SetStateAction<Workflow | null>>;
  setRunInput: React.Dispatch<React.SetStateAction<string>>;
  setSelectedRun: React.Dispatch<React.SetStateAction<WorkflowRun | null>>;
  chooseWorkflowTemplate: (kind: "宣传" | "会议" | "客户" | "自定义") => void;
  setAllSelectedIds: (ids: number[], setIds: (value: number[]) => void, checked: boolean) => void;
  toggleSelectedId: (ids: number[], setIds: (value: number[]) => void, id: number) => void;
  deleteSelectedModules: (moduleName: ModuleName, ids: number[], clear: (value: number[]) => void) => Promise<void>;
  runModule: (module: "workflow" | "source", id: number, name: string) => Promise<void>;
  deleteModule: (moduleName: ModuleName, id: number, name: string) => Promise<void>;
  editWorkflow: (w: Workflow) => void;
  loadModules: () => Promise<void>;
  setNotice: (message: string) => void;
  loadState: () => Promise<void>;
  loadGovernance: () => Promise<void>;
  loadArtifacts: () => Promise<void>;
}

export default function WorkflowsPanel({ workflows, workflowRuns, selectedWorkflowIds, runWorkflow, runningWorkflow, setRunningWorkflow, runInput, selectedRun, setModalType, setSelectedWorkflowIds, setRunWorkflow, setRunInput, setSelectedRun, chooseWorkflowTemplate, setAllSelectedIds, toggleSelectedId, deleteSelectedModules, runModule, deleteModule, editWorkflow, loadModules, setNotice, loadState, loadGovernance, loadArtifacts }: WorkflowsPanelProps) {
  async function executeSelectedWorkflow() {
    if (!runWorkflow || !runInput.trim()) return setNotice("请先填写本次要处理的内容");
    setRunningWorkflow(true); setNotice("工作流正在逐步执行，持续任务可能需要一两分钟…");
    try {
      const response = await fetch("/api/modules", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({type:"run",module:"workflow",id:String(runWorkflow.id),name:runWorkflow.name,input:runInput}) });
      // 504/网关超时返回的是 HTML，response.json() 会抛异常——用 .catch 兜住，避免卡在“执行中”。
      const data = await response.json().catch(()=>null);
      if (!response.ok || !data) {
        setNotice((data && data.error) || "执行时间较长或连接中断，任务可能仍在后台完成，请在“最近运行”刷新查看结果。");
        await loadModules().catch(()=>{});
        return;
      }
      setRunWorkflow(null); setSelectedRun(data.run); setNotice(data.run.status==="已完成"?"工作流已逐步执行完成":data.run.status==="等待审批"?"已提交审批，流程暂停等待决定":"工作流执行失败，可查看原因后重试");
      await Promise.all([loadModules(),loadState(),loadGovernance(),loadArtifacts()]);
    } catch {
      setNotice("执行时间较长或连接中断，任务可能仍在后台完成，请在“最近运行”刷新查看结果。");
      await loadModules().catch(()=>{});
    } finally {
      setRunningWorkflow(false);
    }
  }

  async function retryWorkflow(run: WorkflowRun) {
    setRunningWorkflow(true);
    try {
      const response = await fetch("/api/modules",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({type:"retry",runId:String(run.id)})});
      const data = await response.json().catch(()=>null);
      if (!response.ok || !data) {
        setNotice((data && data.error) || "执行时间较长或连接中断，任务可能仍在后台完成，请在“最近运行”刷新查看结果。");
        await loadModules().catch(()=>{});
        return;
      }
      setSelectedRun(data.run); setNotice(data.run.status==="已完成"?"重新运行成功":"重新运行结束，请查看步骤");
      await loadModules();
    } catch {
      setNotice("执行时间较长或连接中断，任务可能仍在后台完成，请在“最近运行”刷新查看结果。");
      await loadModules().catch(()=>{});
    } finally {
      setRunningWorkflow(false);
    }
  }

  const pagedWorkflows = usePaged(workflows, 9);
  const pagedRuns = usePaged(workflowRuns, 10);
  return <section className="contentPanel">
    <div className="metricRow"><article><span>已建流程</span><b>{workflows.length}</b><small>每一步都由后台执行</small></article><article><span>运行记录</span><b>{workflowRuns.length}</b><small>刷新后仍可追踪</small></article><article><span>等待审批</span><b>{workflowRuns.filter(r=>r.status==="等待审批").length}</b><small>高风险动作自动暂停</small></article></div>
    <div className="pageInlineActions"><button onClick={()=>{chooseWorkflowTemplate("自定义");setModalType("workflow")}}><PlusIcon style={{ width: 12, height: 12 }} /> 新建工作流</button></div>
    {!!workflows.length&&<div className="bulkActionBar"><label><input type="checkbox" checked={workflows.every(item=>selectedWorkflowIds.includes(item.id))} onChange={event=>setAllSelectedIds(workflows.map(item=>item.id),setSelectedWorkflowIds,event.target.checked)}/>全选</label><button className="dangerButton" disabled={!selectedWorkflowIds.length} onClick={()=>deleteSelectedModules("workflow",selectedWorkflowIds,setSelectedWorkflowIds)}>删除选中（{selectedWorkflowIds.length}）</button></div>}
    <div className="workflowGrid">{workflows.length ? pagedWorkflows.pageItems.map(w=>{const nodes=parseWorkflowNodes(w);return <article key={w.id} className="workflowCard"><div className="workflowCardTop"><div><h3>{w.name}</h3><p>{w.triggerType} · {nodes.length} 个真实任务 · {new Set(nodes.filter(n=>n.parallelGroup).map(n=>n.parallelGroup)).size ? "含并行汇聚":"顺序执行"}</p></div><em>{w.status}</em></div><div className="workflowPath">{nodes.map((node,index)=><span key={node.id} className={node.parallelGroup?"parallelPathNode":""}><b>{node.parallelGroup?"并":index+1}</b>{node.name}{index<nodes.length-1&&<i>{node.parallelGroup&&nodes[index+1]?.parallelGroup===node.parallelGroup?<PlusIcon style={{ width: 10, height: 10 }} />:"→"}</i>}</span>)}</div>{(w.watchSourceType==="data_source"||w.watchSourceType==="free")&&w.lastCheckedAt&&<p className={`workflowCheckTrace ${w.lastCheckResult==="已触发"?"ok":w.lastCheckResult==="检查失败"?"bad":""}`}><b>上次检查 {new Date(w.lastCheckedAt).toLocaleString("zh-CN")}</b> · {w.lastCheckResult||"—"}{w.lastCheckDetail?`：${w.lastCheckDetail}`:""}</p>}<div className="workflowActions"><small>{w.lastRunAt?`上次运行：${new Date(w.lastRunAt).toLocaleString("zh-CN")}`:"尚未运行"}</small><div><button onClick={()=>runModule("workflow",w.id,w.name)}><PlayIcon style={{ width: 12, height: 12 }} /> 试运行</button>{w.loopType&&w.loopType!=="单次"&&<button className="outline" onClick={()=>editWorkflow(w)}>编辑</button>}<label className="itemSelect"><input type="checkbox" checked={selectedWorkflowIds.includes(w.id)} onChange={()=>toggleSelectedId(selectedWorkflowIds,setSelectedWorkflowIds,w.id)}/>选择</label><button className="dangerButton" onClick={()=>deleteModule("workflow",w.id,w.name)}>删除</button></div></div></article>}) : <div className="emptyState"><b>还没有工作流</b></div>}</div>
    <Pager page={pagedWorkflows.page} pageSize={pagedWorkflows.pageSize} total={pagedWorkflows.total} onChange={pagedWorkflows.setPage} />
    {!!workflowRuns.length&&<><div className="sectionTitle subTitle"><div><h2>最近运行</h2></div><button className="outline" onClick={loadModules}>刷新</button></div><div className="runList">{pagedRuns.pageItems.map(run=><button key={run.id} onClick={async()=>{const response=await fetch(`/api/modules?runId=${run.id}`);setSelectedRun(response.ok?await response.json():run)}}><span className={`runState ${run.status}`}>{run.status}</span><b>{run.workflowName}</b><small>#{run.id} · {run.actor} · {new Date(run.startedAt).toLocaleString("zh-CN")}</small><i>查看详情 →</i></button>)}</div><Pager page={pagedRuns.page} pageSize={pagedRuns.pageSize} total={pagedRuns.total} onChange={pagedRuns.setPage} /></>}
    {runWorkflow && <div className="modalBackdrop" onMouseDown={()=>!runningWorkflow&&setRunWorkflow(null)}><div className="modal runModal" onMouseDown={e=>e.stopPropagation()}><div className="modalHead"><div><h2>试运行：{runWorkflow.name}</h2><p>顺序节点依次执行；同一并行组的AI会同时处理，全部完成后统一汇总给下一步。</p></div><button type="button" disabled={runningWorkflow} onClick={()=>setRunWorkflow(null)}>×</button></div><div className="runPreview">{parseWorkflowNodes(runWorkflow).map((node,index,items)=><span key={node.id} className={node.parallelGroup?"parallelPathNode":""}><b>{node.parallelGroup?"并":index+1}</b>{node.name}{index<items.length-1&&<i>{node.parallelGroup&&items[index+1]?.parallelGroup===node.parallelGroup?<PlusIcon style={{ width: 10, height: 10 }} />:"→"}</i>}</span>)}</div><label>本次要处理什么<textarea rows={8} value={runInput} onChange={e=>setRunInput(e.target.value)} placeholder="例如：根据知识库里的公司与产品资料，为制造业客户写一篇800字的企业公众号介绍。"/></label><div className="modalActions"><button type="button" className="outline" onClick={()=>setRunWorkflow(null)}>取消</button><button type="button" disabled={runningWorkflow} onClick={executeSelectedWorkflow}>{runningWorkflow?"正在执行工作流…":"开始试运行"}</button></div></div></div>}
    {selectedRun && <div className="modalBackdrop" onMouseDown={()=>setSelectedRun(null)}><div className="modal runDetail" onMouseDown={e=>e.stopPropagation()}><div className="modalHead"><div><h2>{selectedRun.workflowName}</h2><p>运行 #{selectedRun.id} · {new Date(selectedRun.startedAt).toLocaleString("zh-CN")}</p></div><button type="button" onClick={()=>setSelectedRun(null)}>×</button></div><div className={`runSummary ${statusClassName(selectedRun.status)}`}><b>{selectedRun.status}</b><span>{selectedRun.error||`已走到第 ${selectedRun.currentStep} 步`}</span></div><div className="stepTimeline">{selectedRun.steps?.map(step=><article key={step.id}><span>{step.status==="已完成"?"✓":step.status==="失败"?"!":step.status==="等待审批"?"…":<RefreshIcon style={{ width: 12, height: 12 }} />}</span><div><b>{step.stepIndex+1}. {step.stepName}</b><small>{step.stepType} · {step.status}</small>{step.error&&<p className="stepError">{step.error}</p>}{step.output&&<details><summary>查看这一步的结果</summary><pre>{step.output}</pre></details>}</div></article>)}</div>{selectedRun.output&&<label>当前最终结果<textarea readOnly rows={10} value={selectedRun.output}/></label>}<div className="modalActions">{selectedRun.status==="失败"&&<button type="button" disabled={runningWorkflow} onClick={()=>retryWorkflow(selectedRun)}>{runningWorkflow?"重试中…":"重新运行"}</button>}<button type="button" className="outline" onClick={()=>setSelectedRun(null)}>关闭</button></div></div></div>}
  </section>;
}
