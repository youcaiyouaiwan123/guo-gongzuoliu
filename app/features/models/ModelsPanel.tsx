"use client";

import { FormEvent } from "react";
import type { ModelConnection, ModelStatus } from "../shared-types";
import { ALL_PRESET_MODELS, MODEL_PRESETS } from "../constants";
import { cleanModelText, formatModelOption, inferModelProvider, modelProviderMark } from "../shared-utils";
import { PlusIcon, ChevronDownIcon, ChevronUpIcon } from "../../components/icons";

export interface ModelsPanelProps {
  modelStatus: ModelStatus | null;
  selectedPresetModels: string[];
  setSelectedPresetModels: React.Dispatch<React.SetStateAction<string[]>>;
  presetApiKey: string;
  setPresetApiKey: React.Dispatch<React.SetStateAction<string>>;
  addingPresetModels: boolean;
  setAddingPresetModels: React.Dispatch<React.SetStateAction<boolean>>;
  showCustomModel: boolean;
  setShowCustomModel: React.Dispatch<React.SetStateAction<boolean>>;
  editingModel: ModelConnection | null;
  setEditingModel: React.Dispatch<React.SetStateAction<ModelConnection | null>>;
  testingModel: boolean;
  setTestingModel: React.Dispatch<React.SetStateAction<boolean>>;
  selectedModelConnectionIds: number[];
  setSelectedModelConnectionIds: React.Dispatch<React.SetStateAction<number[]>>;
  modelMode: string;
  setModelMode: React.Dispatch<React.SetStateAction<string>>;
  setNotice: (message: string) => void;
  loadModelStatus: () => Promise<void>;
  deleteBatch: (urls: string[]) => Promise<{ ok: number; failed: number }>;
  setAllSelectedIds: (ids: number[], setIds: (value: number[]) => void, checked: boolean) => void;
  toggleSelectedId: (ids: number[], setIds: (value: number[]) => void, id: number) => void;
}

export default function ModelsPanel({ modelStatus, selectedPresetModels, setSelectedPresetModels, presetApiKey, setPresetApiKey, addingPresetModels, setAddingPresetModels, showCustomModel, setShowCustomModel, editingModel, setEditingModel, testingModel, setTestingModel, selectedModelConnectionIds, setSelectedModelConnectionIds, modelMode, setModelMode, setNotice, loadModelStatus, deleteBatch, setAllSelectedIds, toggleSelectedId }: ModelsPanelProps) {
  async function testModel(id?: number) {
    setTestingModel(true);
    const response = await fetch("/api/model", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
    const data = await response.json();
    setNotice(data.message || (response.ok ? "连接成功" : "连接失败"));
    setTestingModel(false);
  }

  async function deleteModelConnection(item: ModelConnection) {
    if (!confirm(`确定删除模型连接“${item.connectionName}”吗？`)) return;
    const response = await fetch(`/api/model?id=${item.id}`, { method: "DELETE" });
    const data = await response.json();
    setNotice(data.message || (response.ok ? "模型连接已删除" : "删除失败"));
    if (response.ok) {
      if (modelMode === `connection:${item.id}`) setModelMode("auto");
      await loadModelStatus();
    }
  }

  async function saveModelConfig(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget).entries());
    const response = await fetch("/api/model", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...values, id: editingModel?.id, action: "save" }) });
    const data = await response.json();
    setNotice(data.message || (response.ok ? "模型API已保存" : "保存失败"));
    if (response.ok) { event.currentTarget.reset(); setEditingModel(null); await loadModelStatus(); }
  }

  function togglePresetModel(model: string) {
    setSelectedPresetModels(items => items.includes(model) ? items.filter(item => item !== model) : [...items, model]);
  }

  function togglePresetVendor(models: readonly string[]) {
    setSelectedPresetModels(items => {
      const allSelected = models.every(model => items.includes(model));
      return allSelected ? items.filter(item => !models.includes(item)) : Array.from(new Set([...items, ...models]));
    });
  }

  async function addPresetModels() {
    if (!selectedPresetModels.length) return setNotice("请先选择至少一个模型。");
    if (!presetApiKey.trim()) return setNotice("请填写该接口的 API Key。");
    setAddingPresetModels(true);
    let success = 0;
    const failures: string[] = [];
    for (const preset of ALL_PRESET_MODELS.filter(item => selectedPresetModels.includes(item.model))) {
      const response = await fetch("/api/model", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "save",
          connectionName: `${preset.provider} · ${preset.model}`,
          provider: preset.provider,
          baseUrl: "https://claudecc.top",
          model: preset.model,
          apiKey: presetApiKey.trim(),
        }),
      });
      if (response.ok) success += 1;
      else failures.push(preset.model);
    }
    setAddingPresetModels(false);
    if (success) {
      setSelectedPresetModels([]);
      setPresetApiKey("");
      await loadModelStatus();
    }
    setNotice(failures.length ? `已添加 ${success} 个，${failures.length} 个添加失败：${failures.join("、")}` : `已添加 ${success} 个模型，聊天窗口现在可以直接选择。`);
  }

  async function deleteSelectedModelConnections() {
    if (!selectedModelConnectionIds.length) return setNotice("请先选择要删除的模型连接");
    if (!confirm(`确认删除选中的 ${selectedModelConnectionIds.length} 个模型连接吗？删除后无法恢复。`)) return;
    const result = await deleteBatch(selectedModelConnectionIds.map(id => `/api/model?id=${id}`));
    if (selectedModelConnectionIds.some(id => modelMode === `connection:${id}`)) setModelMode("auto");
    setSelectedModelConnectionIds([]);
    await loadModelStatus();
    setNotice(`已删除 ${result.ok} 个模型连接${result.failed ? `，${result.failed} 个失败` : ""}`);
  }

  return <section className="contentPanel pageFill modelsPage">
    <div className="pageScroll">
      <div className="sectionTitle"><div><h2>模型服务入口</h2></div></div>
      <div className="providerGrid"><a className="providerLinkCard" href="https://www.claudecc.top" target="_blank" rel="noreferrer"><span className="providerMark">海</span><div><h3>ClaudeCC 模型服务</h3><p>第三方模型服务平台</p><small>www.claudecc.top</small></div><em>一键访问 →</em></a></div>
      <div className="sectionTitle"><div><h2>我的第三方模型接入</h2></div><span className={modelStatus?.configured ? "policyBadge" : "warningBadge"}>{modelStatus?.configured ? `${modelStatus.connections.length} 个模型连接` : "等待填写我的API"}</span></div>
      <div className="modelSummary">
        <article><span>当前供应商</span><b>{modelStatus ? inferModelProvider(modelStatus.model) : "读取中…"}</b><small>可随时切换</small></article>
        <article><span>当前模型</span><b>{modelStatus?.model || "读取中…"}</b><small>{modelStatus?.baseUrl || "服务器端接口"}</small></article>
        <article><span>密钥状态</span><b>{modelStatus?.keyStatus || "读取中…"}</b><small>原始密钥永不返回浏览器</small></article>
      </div>
      <section className="presetModelSection"><div className="presetModelHeading"><div><h3>预设厂家模型</h3><p>勾选多个模型，使用同一个接口密钥一键加入；加入后会自动出现在智能助手的模型选择器中。</p></div><div><button type="button" className="outline selectAllModels" onClick={()=>setSelectedPresetModels(selectedPresetModels.length===ALL_PRESET_MODELS.length?[]:ALL_PRESET_MODELS.map(item=>item.model))}>{selectedPresetModels.length===ALL_PRESET_MODELS.length?"取消全部":"✓ 全选所有模型"}</button><span>已选 {selectedPresetModels.length} / {ALL_PRESET_MODELS.length} 个</span></div></div><div className="presetVendorGrid">{MODEL_PRESETS.map(group=>{const vendorAllSelected=group.models.every(model=>selectedPresetModels.includes(model));return <article key={group.provider}><header><span className="providerMark">{group.mark}</span><div><b>{group.provider}</b><small>{group.models.length} 个可用模型</small></div><button type="button" className="vendorSelectAll" onClick={()=>togglePresetVendor(group.models)}>{vendorAllSelected?"取消本厂家":"全选本厂家"}</button></header><div className="presetModelChoices">{group.models.map(model=><label key={model} className={selectedPresetModels.includes(model)?"selected":""}><input type="checkbox" checked={selectedPresetModels.includes(model)} onChange={()=>togglePresetModel(model)}/><span>{model}</span></label>)}</div></article>})}</div><div className="presetAddBar"><label>统一 API Key<input type="password" value={presetApiKey} onChange={event=>setPresetApiKey(event.target.value)} autoComplete="new-password" placeholder="填写后仅加密保存，页面不会回显"/></label><button type="button" onClick={addPresetModels} disabled={addingPresetModels||!selectedPresetModels.length}>{addingPresetModels?"正在添加…":`一键添加所选 ${selectedPresetModels.length||""} 个模型`}</button></div></section>
      <button type="button" className="customModelToggle" aria-expanded={Boolean(showCustomModel||editingModel)} onClick={()=>setShowCustomModel(value=>!value)}>
        <div className="customModelToggleText">
          <h3>自定义添加模型</h3>
          <p>新模型上线或预设列表中没有时，可继续手动填写型号。</p>
        </div>
        <span className="customModelToggleAction">{showCustomModel||editingModel?<><ChevronUpIcon style={{ width: 12, height: 12 }} /> 收起</>:<><ChevronDownIcon style={{ width: 12, height: 12 }} /> 展开添加</>}</span>
      </button>
      {(showCustomModel||editingModel)&&<form key={editingModel?.id||"new"} className="userForm modelForm" onSubmit={saveModelConfig}><input type="hidden" name="id" value={editingModel?.id||""}/><label>连接名称<input name="connectionName" required defaultValue={editingModel ? cleanModelText(editingModel.connectionName, editingModel.model) : ""} placeholder="例如：Claude 合同审查"/></label><label>模型供应商<select name="provider" required defaultValue={editingModel ? inferModelProvider(editingModel.model) : "Anthropic Claude"}><option>Anthropic Claude</option><option>Google Gemini</option><option>OpenAI</option><option>DeepSeek</option><option>通义千问</option><option>智谱 AI</option><option>月之暗面</option><option>MiniMax</option><option>豆包</option><option>OpenRouter</option><option>硅基流动</option><option>自建模型</option></select></label><label>API 接口地址<input name="baseUrl" type="url" required value="https://claudecc.top" readOnly aria-readonly="true" title="所有模型统一使用该接口地址"/></label><label>模型名称<input name="model" required defaultValue={editingModel?.model||""} placeholder="填写新模型的准确名称"/></label><label>API Key<input name="apiKey" type="password" required={!editingModel} autoComplete="new-password" placeholder={editingModel?"不修改密钥可留空":"填写该供应商发放的 API Key"}/></label><button type="submit">{editingModel?"保存修改":<><PlusIcon style={{ width: 12, height: 12 }} /> 添加自定义模型</>}</button>{editingModel&&<button type="button" className="outline" onClick={()=>setEditingModel(null)}>取消编辑</button>}</form>}
      {!!modelStatus?.connections?.length&&<><div className="bulkActionBar"><label><input type="checkbox" checked={modelStatus.connections.every(item=>selectedModelConnectionIds.includes(item.id))} onChange={event=>setAllSelectedIds(modelStatus.connections.map(item=>item.id),setSelectedModelConnectionIds,event.target.checked)}/>全选</label><button className="dangerButton" disabled={!selectedModelConnectionIds.length} onClick={deleteSelectedModelConnections}>删除选中（{selectedModelConnectionIds.length}）</button></div><div className="modelConnectionList">{modelStatus.connections.map(item=><article key={item.id}><span className="providerMark">{modelProviderMark(item)}</span><div><b>{formatModelOption(item)}</b><p>{inferModelProvider(item.model)} - {item.model}</p><small>{item.baseUrl}</small></div><em>已加密</em><button className="outline" onClick={()=>setEditingModel(item)}>编辑</button><button className="outline" onClick={()=>testModel(item.id)} disabled={testingModel}>{testingModel?"检测中…":"测试"}</button><label className="itemSelect"><input type="checkbox" checked={selectedModelConnectionIds.includes(item.id)} onChange={()=>toggleSelectedId(selectedModelConnectionIds,setSelectedModelConnectionIds,item.id)}/>选择</label><button className="dangerButton" onClick={()=>deleteModelConnection(item)}>删除</button></article>)}</div></>}
    </div>
  </section>;
}
