"use client";

import { useState } from "react";
import * as XLSX from "xlsx";
import type { CollectionRun, Source } from "../shared-types";
import { collectorModeLabel, outputFormatLabel, platformLabel, sourceIcon, statusClassName, targetStoreLabel } from "../shared-utils";
import { PlayIcon, PlusIcon } from "../../components/icons";

type ModuleName = "agent" | "workflow" | "source";
type CollectionTab = "sources" | "cleaning";

const cleaningOptions = [
  { id: "trim", name: "去除多余空格", detail: "清除首尾空格、连续空格和无意义缩进" },
  { id: "blank", name: "删除空行空值", detail: "删除整行为空的数据，统一空值表达" },
  { id: "dedupe", name: "重复数据去重", detail: "按整行内容识别并删除重复记录" },
  { id: "format", name: "格式标准化", detail: "统一日期分隔符、全角标点和换行格式" },
  { id: "html", name: "清除网页标签", detail: "移除HTML标签、脚本片段和网页噪声" },
  { id: "mask", name: "敏感信息脱敏", detail: "隐藏手机号、身份证号和邮箱的关键部分" },
];

export interface CollectionPanelProps {
  sources: Source[];
  collectionRuns: CollectionRun[];
  selectedSourceIds: number[];
  selectedCollectionRunIds: number[];
  selectedCollectionRun: CollectionRun | null;
  runningSourceId: number | null;
  cleaningRules: string[];
  cleanedPreview: string;
  showCleaning: boolean;
  localCleaningFile: { name: string; raw: string };
  localCleaningBusy: boolean;
  setSelectedSourceIds: React.Dispatch<React.SetStateAction<number[]>>;
  setSelectedCollectionRunIds: React.Dispatch<React.SetStateAction<number[]>>;
  setSelectedCollectionRun: React.Dispatch<React.SetStateAction<CollectionRun | null>>;
  setRunningSourceId: React.Dispatch<React.SetStateAction<number | null>>;
  setCleaningRules: React.Dispatch<React.SetStateAction<string[]>>;
  setCleanedPreview: React.Dispatch<React.SetStateAction<string>>;
  setShowCleaning: React.Dispatch<React.SetStateAction<boolean>>;
  setLocalCleaningFile: React.Dispatch<React.SetStateAction<{ name: string; raw: string }>>;
  setLocalCleaningBusy: React.Dispatch<React.SetStateAction<boolean>>;
  setCollectionRuns: React.Dispatch<React.SetStateAction<CollectionRun[]>>;
  setNotice: (message: string) => void;
  setAllSelectedIds: (ids: number[], setIds: (value: number[]) => void, checked: boolean) => void;
  toggleSelectedId: (ids: number[], setIds: (value: number[]) => void, id: number) => void;
  runModule: (module: "workflow" | "source", id: number, name: string) => Promise<void>;
  deleteModule: (moduleName: ModuleName, id: number, name: string) => Promise<void>;
  deleteSelectedModules: (moduleName: ModuleName, ids: number[], clear: (value: number[]) => void) => Promise<void>;
  loadModules: () => Promise<void>;
  loadState: () => Promise<void>;
  loadPersonalKnowledge: () => Promise<void>;
  deleteBatch: (urls: string[]) => Promise<{ ok: number; failed: number }>;
  modelModeLabel: (mode?: string) => string;
  newSourceTask: (preset?: Partial<Source>) => void;
  openSourceEditor: (source: Source) => void;
}

export default function CollectionPanel({ sources, collectionRuns, selectedSourceIds, selectedCollectionRunIds, selectedCollectionRun, runningSourceId, cleaningRules, cleanedPreview, showCleaning, localCleaningFile, localCleaningBusy, setSelectedSourceIds, setSelectedCollectionRunIds, setSelectedCollectionRun, setRunningSourceId, setCleaningRules, setCleanedPreview, setShowCleaning, setLocalCleaningFile, setLocalCleaningBusy, setCollectionRuns, setNotice, setAllSelectedIds, toggleSelectedId, runModule, deleteModule, deleteSelectedModules, loadModules, loadState, loadPersonalKnowledge, deleteBatch, modelModeLabel, newSourceTask, openSourceEditor }: CollectionPanelProps) {
  const [tab, setTab] = useState<CollectionTab>("sources");
  const [showAiCollect, setShowAiCollect] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiUrl, setAiUrl] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiResult, setAiResult] = useState<{ text: string; toolCalls: number; runId?: number } | null>(null);

  const pendingCount = collectionRuns.filter(run => ["失败", "采集失败", "待确认", "待审核", "已采集"].includes(run.status)).length;

  async function testSource(id: number, name: string) {
    setRunningSourceId(id);
    const response = await fetch("/api/modules", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "run", module: "source", action: "test", id: String(id), name }) });
    const data = await response.json(); setRunningSourceId(null);
    setNotice(response.ok ? `测试成功：${collectorModeLabel(data.collectorMode)} · ${data.httpStatus || "本地内容"} · 识别 ${data.rowCount} 条 · 输出${outputFormatLabel(data.outputFormat)}` : data.error || "连接测试失败");
  }

  async function approveCollectionRun(run: CollectionRun) {
    const response = await fetch("/api/modules", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "approveSourceRun", runId: String(run.id), cleanedPreview: cleanedPreview || undefined, cleaningRules: cleanedPreview ? cleaningRules : [] }) });
    const data = await response.json();
    setNotice(data.message || (response.ok ? "已进入知识库" : "入库失败"));
    if (response.ok) { setSelectedCollectionRun(null); setShowCleaning(false); setCleanedPreview(""); await Promise.all([loadModules(), loadState()]); }
  }

  async function deleteCollectionRun(run: CollectionRun) {
    if (!confirm(`确认删除采集日志 #${run.id} / ${run.sourceName} 吗？删除后无法恢复。`)) return;
    const response = await fetch(`/api/modules?module=collectionRun&id=${run.id}`, { method: "DELETE" });
    const data = await response.json();
    if (!response.ok) return setNotice(data.error || "删除采集日志失败");
    setCollectionRuns(current => current.filter(item => item.id !== run.id));
    if (selectedCollectionRun?.id === run.id) setSelectedCollectionRun(null);
    setNotice(data.message || "采集日志已删除");
  }

  function toggleCleaningRule(id: string) {
    setCleaningRules(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id]);
  }

  // 各类空白字符：半角空格、制表符、全角空格(U+3000)、不换行空格(U+00A0)、零宽空格等。
  // 网页和 Excel 导出的数据里全角空格和 &nbsp; 极常见，单用 trim() 清不掉。
  const WHITESPACE = "[ \\t\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]";

  function runDataCleaning(sourceText?: string) {
    let text = sourceText ?? selectedCollectionRun?.preview ?? "";
    if (!text) return setNotice("请先选择一条有内容的采集记录");
    // 顺序：清标签 → 格式标准化 → 去空格 → 删空行 → 去重 → 脱敏。
    // 标准化必须在去重之前，否则「只差一个全角逗号」的重复行标准化后才相同，去重会漏；
    // 去空格必须在清标签之后，因为标签被替换成空格会制造连续空白。
    if (cleaningRules.includes("html")) {
      text = text.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, "\"");
    }
    if (cleaningRules.includes("format")) {
      text = text.replace(/[，；：]/g, mark => ({ "，": ",", "；": ";", "：": ":" }[mark] || mark))
        .replace(/(\d{4})[/.年-](\d{1,2})[/.月-](\d{1,2})日?/g, (_, y, m, d) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
    }
    let lines = text.replace(/\r\n?/g, "\n").split("\n");
    if (cleaningRules.includes("trim")) {
      const edge = new RegExp(`^${WHITESPACE}+|${WHITESPACE}+$`, "g");
      const inner = new RegExp(`${WHITESPACE}{2,}`, "g");
      lines = lines.map(line => line.replace(edge, "").replace(inner, " "));
    }
    if (cleaningRules.includes("blank")) {
      const blank = new RegExp(`^${WHITESPACE}*$`);
      lines = lines.filter(line => !blank.test(line) && !/^(null|undefined|n\/a|nan|无|-)$/i.test(line.trim()));
    }
    if (cleaningRules.includes("dedupe")) {
      // 按去空白、手机号分隔符归一化后的内容判重，保留首次出现的原始行。
      // 138-1234-5678 与 13812345678 是同一手机号的两种写法，脱敏前必须视为重复。
      // 正则只匹配 1[3-9] 开头的 3-4-4 手机号形态，不会误伤 2024-03-07 这类日期。
      const seen = new Set<string>();
      lines = lines.filter(line => {
        const key = line
          .replace(new RegExp(WHITESPACE, "g"), "")
          .replace(/(1[3-9]\d)[-](\d{4})[-](\d{4})/g, "$1$2$3")
          .toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
    text = lines.join("\n");
    if (cleaningRules.includes("mask")) text = maskSensitive(text);
    setCleanedPreview(text);
    setShowCleaning(true);
    setNotice(`数据清洗完成：已执行 ${cleaningRules.length} 项规则，可对照预览后再入库`);
  }

  // 手机号脱敏：覆盖纯 11 位、带 -/空格分隔、带 +86/86 前缀等写法。
  function maskSensitive(input: string) {
    let text = input
      // +86 / 86 前缀（可带分隔符），保留前缀
      .replace(/(\+?86[-\s]?)(1[3-9]\d)[-\s]?(\d{4})[-\s]?(\d{4})(?!\d)/g, (_, p, a, __, d) => `${p}${a}****${d}`)
      // 带分隔符的 11 位：138-1234-5678 / 138 1234 5678
      .replace(/(?<![\d+])(1[3-9]\d)[-\s](\d{4})[-\s](\d{4})(?!\d)/g, "$1****$3")
      // 纯 11 位，允许前后紧贴非数字字符（逗号、竖线、中文等）
      .replace(/(?<!\d)(1[3-9]\d)\d{4}(\d{4})(?!\d)/g, "$1****$2");
    text = text
      // 身份证 18 位（含末位 X）与 15 位旧号
      .replace(/(?<![\dXx])(\d{6})\d{8}(\d{3}[\dXx])(?![\dXx])/g, "$1********$2")
      .replace(/(?<!\d)(\d{6})\d{6}(\d{3})(?!\d)/g, "$1******$2")
      // 邮箱：保留前 2 位与完整域名
      .replace(/([\w.+-]{1,2})[\w.+-]*(@[\w.-]+\.[A-Za-z]{2,})/g, "$1***$2")
      // 银行卡 16-19 位，保留前 4 后 4
      .replace(/(?<!\d)(\d{4})\d{8,11}(\d{4})(?!\d)/g, "$1********$2");
    return text;
  }

  async function readLocalCleaningFile(file?: File) {
    if (!file) return;
    setLocalCleaningBusy(true);
    setShowCleaning(false);
    setCleanedPreview("");
    try {
      const extension = file.name.split(".").pop()?.toLowerCase();
      let raw = "";
      if (extension === "xlsx" || extension === "xls") {
        const workbook = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: true });
        raw = workbook.SheetNames.map(sheetName => {
          const rows = XLSX.utils.sheet_to_csv(workbook.Sheets[sheetName], { blankrows: false });
          return workbook.SheetNames.length > 1 ? `# 工作表：${sheetName}\n${rows}` : rows;
        }).join("\n\n");
      } else {
        raw = await file.text();
      }
      if (!raw.trim()) throw new Error("文件中没有可清洗的文本或表格数据");
      setLocalCleaningFile({ name: file.name, raw: raw.slice(0, 200000) });
      setNotice(`已读取本地文件：${file.name}，请选择规则后执行清洗`);
    } catch (error) {
      setLocalCleaningFile({ name: "", raw: "" });
      setNotice(error instanceof Error ? error.message : "本地文件读取失败");
    } finally {
      setLocalCleaningBusy(false);
    }
  }

  function downloadCleanedFile() {
    if (!cleanedPreview) return setNotice("请先执行数据清洗");
    const baseName = (localCleaningFile.name || "cleaned-data").replace(/\.[^.]+$/, "");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([cleanedPreview], { type: "text/plain;charset=utf-8" }));
    link.download = `${baseName}-cleaned.txt`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  async function saveLocalCleaningToKnowledge() {
    if (!cleanedPreview) return setNotice("请先执行数据清洗");
    const response = await fetch("/api/personal-knowledge", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      title: `${localCleaningFile.name.replace(/\.[^.]+$/, "") || "本地数据"}（清洗后）`,
      content: cleanedPreview,
      sourceType: `本地文件清洗 · ${cleaningRules.join("、") || "未选择规则"}`,
    }) });
    const data = await response.json();
    if (!response.ok) return setNotice(data.error || "保存到个人知识库失败");
    setNotice("清洗后的本地数据已进入个人知识库；需要共享时请到企业知识中手动同步。");
    await Promise.all([loadPersonalKnowledge(), loadState()]);
  }

  async function runAiCollect(event: React.FormEvent) {
    event.preventDefault();
    if (!aiPrompt.trim()) return setNotice("请描述采集需求");
    setAiBusy(true);
    setAiResult(null);
    try {
      const response = await fetch("/api/modules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "ai-collect",
          prompt: aiPrompt.trim(),
          url: aiUrl.trim() || undefined,
          modelMode: "auto",
          targetStore: "personal",
          outputFormat: "markdown",
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "AI 采集失败");
      setAiResult({ text: data.text, toolCalls: data.toolCalls, runId: data.runId });
      setNotice(`AI 采集完成：调用 ${data.toolCalls} 次工具，已存为采集记录 #${data.runId}，请在“数据清洗与运行记录”里确认入库。`);
      // 结果已经落库，刷新列表让这条记录立刻出现在运行记录里，用户不用手动刷新页面。
      await loadModules();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "AI 采集失败");
    } finally {
      setAiBusy(false);
    }
  }

  async function deleteSelectedCollectionRuns() {
    if (!selectedCollectionRunIds.length) return setNotice("请先选择要删除的采集日志");
    if (!confirm(`确认删除选中的 ${selectedCollectionRunIds.length} 条采集日志吗？删除后无法恢复。`)) return;
    const result = await deleteBatch(selectedCollectionRunIds.map(id => `/api/modules?module=collectionRun&id=${id}`));
    setSelectedCollectionRunIds([]);
    if (selectedCollectionRun && selectedCollectionRunIds.includes(selectedCollectionRun.id)) setSelectedCollectionRun(null);
    await loadModules();
    setNotice(`已删除 ${result.ok} 条采集日志${result.failed ? `，${result.failed} 条失败` : ""}`);
  }

  return <section className="contentPanel collectionLayout">
    {/* 顶部：3 统计 + 4 模式（单行紧凑） */}
    <div className="collectionHeader">
      <div className="metricRow compact">
        <article>
          <span>已配置数据源</span>
          <b>{sources.length}</b>
          <small>网页、API、万能爬虫、MCP、截图识别和本地文件</small>
        </article>
        <article>
          <span>真实运行次数</span>
          <b>{collectionRuns.length}</b>
          <small>成功与失败都有记录</small>
        </article>
        <article>
          <span>待处理记录</span>
          <b>{pendingCount}</b>
          <small>失败可查看后编辑重试；仅保存记录可手动入库</small>
        </article>
      </div>
      <div className="crawlerModes compact">
        <button type="button" onClick={() => newSourceTask({ sourceType: "万能爬虫", collectorMode: "crawler", platform: "web", targetStore: "personal", outputFormat: "markdown", crawlDepth: 1, maxPages: 5 })}>网站递归</button>
        <button type="button" onClick={() => newSourceTask({ sourceType: "JSON API", collectorMode: "api", platform: "custom_api", targetStore: "personal", outputFormat: "json" })}>API / MCP</button>
        <button type="button" onClick={() => newSourceTask({ sourceType: "截图识别/图片数据", collectorMode: "screenshot", platform: "screenshot", targetStore: "personal", outputFormat: "table" })}>截图识别</button>
        <button type="button" onClick={() => newSourceTask({ sourceType: "粘贴CSV/JSON", collectorMode: "paste", platform: "manual_export", targetStore: "personal", outputFormat: "table" })}>平台导出</button>
        <button type="button" className="primaryButton" onClick={() => { setShowAiCollect(true); setAiPrompt(""); setAiUrl(""); setAiResult(null); }}>AI 智能采集</button>
      </div>
    </div>

    {/* 工具栏：流程指示器 + 新建按钮（单行） */}
    <div className="collectionToolbar">
      <div className="collectionFlow compact">
        <span>1 配置</span><i>→</i><span>2 测试</span><i>→</i><span>3 运行</span><i>→</i><span>4 清洗</span><i>→</i><span>5 预览</span><i>→</i><span>6 入库</span>
      </div>
      <button type="button" className="primaryButton" onClick={() => newSourceTask()}>
        <PlusIcon style={{ width: 12, height: 12 }} /> 新建采集任务
      </button>
    </div>

    {/* Tab 切换 */}
    <div className="collectionTabs">
      <button type="button" className={tab === "sources" ? "active" : ""} onClick={() => setTab("sources")}>
        采集任务 ({sources.length})
      </button>
      <button type="button" className={tab === "cleaning" ? "active" : ""} onClick={() => setTab("cleaning")}>
        数据清洗与运行记录 ({cleaningRules.length} 规则 / {collectionRuns.length} 记录)
      </button>
    </div>

    {/* Tab 内容 */}
    {tab === "sources" && (
      <div className="collectionContent">
        {!!sources.length && (
          <div className="bulkActionBar compact">
            <label>
              <input type="checkbox" checked={sources.every(item => selectedSourceIds.includes(item.id))} onChange={event => setAllSelectedIds(sources.map(item => item.id), setSelectedSourceIds, event.target.checked)} />
              全选
            </label>
            <span>已选 {selectedSourceIds.length} / {sources.length} 个数据源</span>
            <button type="button" className="dangerButton" disabled={!selectedSourceIds.length} onClick={() => deleteSelectedModules("source", selectedSourceIds, setSelectedSourceIds)}>
              删除选中（{selectedSourceIds.length}）
            </button>
          </div>
        )}
        <div className="sourceGrid compact">
          {sources.length ? sources.map(s => (
            <article key={s.id} className="sourceCard">
              <div className="cardTop">
                <span className="moduleIcon">{sourceIcon(s.sourceType)}</span>
                <div className="cardTitle">
                  <h3>{s.name}</h3>
                  <small>{collectorModeLabel(s.collectorMode)} · {platformLabel(s.platform)}</small>
                </div>
                <em className={`collectionState ${statusClassName(s.status)}`}>{s.status}</em>
              </div>
              <code className="sourceUrl">{s.sourceUrl || "使用粘贴/截图识别/MCP返回数据，不保存图片原件"}</code>
              <div className="sourceMeta compact">
                <span>入库：{targetStoreLabel(s.targetStore)}</span>
                <span>输出：{outputFormatLabel(s.outputFormat)}</span>
                <span>范围：{s.visibility || "全员"}</span>
                <span>{s.lastRunAt ? `上次：${new Date(s.lastRunAt).toLocaleString("zh-CN")}` : "尚未运行"}</span>
              </div>
              <div className="cardActions compact">
                <button type="button" disabled={runningSourceId === s.id} onClick={() => runModule("source", s.id, s.name)}>
                  {runningSourceId === s.id ? "采集中…" : (<><PlayIcon style={{ width: 12, height: 12 }} /> 立即采集</>)}
                </button>
                <button type="button" className="outline" disabled={runningSourceId === s.id} onClick={() => testSource(s.id, s.name)}>测试连接</button>
                <button type="button" className="outline" onClick={() => openSourceEditor(s)}>编辑</button>
                <span className="cardMenuWrap">
                  ⋮
                  <div className="menu" role="menu">
                    <label className="itemSelect">
                      <input type="checkbox" checked={selectedSourceIds.includes(s.id)} onChange={() => toggleSelectedId(selectedSourceIds, setSelectedSourceIds, s.id)} />
                      选择
                    </label>
                    <button type="button" className="dangerButton" onClick={() => deleteModule("source", s.id, s.name)}>删除</button>
                  </div>
                </span>
              </div>
            </article>
          )) : (
            <div className="sourceEmpty">
              <b>还没有可运行的数据源</b>
              <p style={{ margin: "6px 0 0", fontSize: 11, color: "#8b9791" }}>点击右上方“新建采集任务”或选择一种采集模式开始</p>
            </div>
          )}
        </div>
      </div>
    )}

    {tab === "cleaning" && (
      <div className="collectionContent">
        {/* 6 清洗规则（3 列） */}
        <div className="cleaningGrid compact">
          {cleaningOptions.map(option => (
            <button type="button" key={option.id} className={cleaningRules.includes(option.id) ? "active" : ""} onClick={() => toggleCleaningRule(option.id)}>
              <span>{cleaningRules.includes(option.id) ? "✓" : <PlusIcon style={{ width: 12, height: 12 }} />}</span>
              <div>
                <b>{option.name}</b>
                <small>{option.detail}</small>
              </div>
            </button>
          ))}
        </div>

        {/* 2 个入口卡片 */}
        <div className="cleaningEntrances compact">
          <article>
            <span className="cleaningEntranceIcon">采</span>
            <div>
              <b>清洗采集结果</b>
              <p>在下方“采集运行记录”中打开一条记录，执行清洗并决定是否进入知识库。</p>
            </div>
            <em>选择下方记录 →</em>
          </article>
          <article className="localCleaningCard">
            <span className="cleaningEntranceIcon">传</span>
            <div>
              <b>上传本地文件清洗</b>
              <p>支持 Excel、CSV、JSON、TXT、Markdown；文件在浏览器中解析，再由你确认是否入库。</p>
            </div>
            <label className="localFileButton">
              <input type="file" accept=".xlsx,.xls,.csv,.json,.txt,.md" onChange={event => readLocalCleaningFile(event.target.files?.[0])} />
              {localCleaningBusy ? "读取中…" : "选择本地文件"}
            </label>
          </article>
        </div>

        {/* 本地文件工作区（按需展开） */}
        {localCleaningFile.raw && (
          <div className="localCleaningWorkspace compact">
            <div className="localCleaningTitle">
              <div>
                <b>{localCleaningFile.name}</b>
                <small>已读取本地文件 · 原始内容不会自动上传</small>
              </div>
              <div>
                <button type="button" className="outline" onClick={() => { setLocalCleaningFile({ name: "", raw: "" }); setShowCleaning(false); setCleanedPreview(""); }}>移除文件</button>
                <button type="button" disabled={!cleaningRules.length} onClick={() => runDataCleaning(localCleaningFile.raw)}>执行智能清洗</button>
              </div>
            </div>
            <div className={showCleaning ? "cleaningCompare active" : "cleaningCompare"}>
              <label>
                <small>本地原始数据</small>
                <textarea readOnly rows={10} value={localCleaningFile.raw} />
              </label>
              {showCleaning && (
                <label>
                  <small>清洗后数据</small>
                  <textarea readOnly rows={10} value={cleanedPreview} />
                </label>
              )}
            </div>
            {showCleaning && (
              <div className="localCleaningActions">
                <button type="button" className="outline" onClick={downloadCleanedFile}>下载清洗结果</button>
                <button type="button" onClick={saveLocalCleaningToKnowledge}>保存到个人知识库</button>
              </div>
            )}
          </div>
        )}

        {/* 采集运行记录 */}
        {!!collectionRuns.length && (
          <>
            <div className="runHeader">
              <b>采集运行记录</b>
              <button type="button" className="outline" onClick={loadModules}>刷新</button>
            </div>
            <div className="bulkActionBar compact">
              <label>
                <input type="checkbox" checked={collectionRuns.every(item => selectedCollectionRunIds.includes(item.id))} onChange={event => setAllSelectedIds(collectionRuns.map(item => item.id), setSelectedCollectionRunIds, event.target.checked)} />
                全选
              </label>
              <span>已选 {selectedCollectionRunIds.length} / {collectionRuns.length} 条</span>
              <button type="button" className="dangerButton" disabled={!selectedCollectionRunIds.length} onClick={deleteSelectedCollectionRuns}>
                删除选中（{selectedCollectionRunIds.length}）
              </button>
            </div>
            <div className="collectionRunList compact">
              {collectionRuns.map(run => (
                <article
                  key={run.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => { setShowCleaning(false); setCleanedPreview(""); setSelectedCollectionRun(run); }}
                  onKeyDown={event => { if (event.key === "Enter") { setShowCleaning(false); setCleanedPreview(""); setSelectedCollectionRun(run); } }}
                >
                  <span className={`runState ${run.status}`}>{run.status}</span>
                  <b>{run.sourceName}</b>
                  <small>#{run.id} · {run.rowCount}条 · {collectorModeLabel(run.collectorMode)} · 入{targetStoreLabel(run.targetStore)} · {outputFormatLabel(run.outputFormat)} · 模型：{modelModeLabel(run.modelUsed)} · {new Date(run.createdAt).toLocaleString("zh-CN")}</small>
                  <i>{run.error || "查看采集结果 →"}</i>
                  <label className="itemSelect" onClick={event => event.stopPropagation()}>
                    <input type="checkbox" checked={selectedCollectionRunIds.includes(run.id)} onChange={() => toggleSelectedId(selectedCollectionRunIds, setSelectedCollectionRunIds, run.id)} />
                    选
                  </label>
                  <button type="button" className="dangerButton" onClick={event => { event.stopPropagation(); deleteCollectionRun(run); }}>删除</button>
                </article>
              ))}
            </div>
          </>
        )}
      </div>
    )}

    {/* Modal：AI 智能采集 */}
    {showAiCollect && (
      <div className="modalBackdrop" onMouseDown={() => { if (!aiBusy) setShowAiCollect(false); }}>
        <div className="modal aiCollectModal" onMouseDown={e => e.stopPropagation()}>
          <div className="modalHead">
            <div>
              <h2>AI 智能采集</h2>
              <p>用自然语言描述采集需求，AI 自动选择 14 种技能（网页读取、跨平台搜索、内容处理等）执行</p>
            </div>
            <button type="button" disabled={aiBusy} onClick={() => setShowAiCollect(false)}>×</button>
          </div>
          <form onSubmit={runAiCollect}>
            <label>采集需求<textarea required value={aiPrompt} onChange={e => setAiPrompt(e.target.value)} rows={4} placeholder={'例如：搜索 GitHub 上最近一周关于 "AI agent" 的仓库，按 star 数排序\n例如：读取 Reddit 的 python 板块今天的热门帖子\n例如：搜索 V2EX 上关于 "前端开发" 的最新讨论\n例如：搜索 Hacker News 上关于 "llm" 的热门故事\n例如：读取 https://example.com/blog 的内容，整理为 Markdown'} disabled={aiBusy} /></label>
            <label>目标网址（可选）<input value={aiUrl} onChange={e => setAiUrl(e.target.value)} placeholder="留空则由 AI 自主搜索，填写后 AI 优先采集该网址" disabled={aiBusy} /></label>
            <div className="modalActions">
              <button type="button" className="outline" disabled={aiBusy} onClick={() => setShowAiCollect(false)}>取消</button>
              <button type="submit" disabled={aiBusy || !aiPrompt.trim()}>{aiBusy ? "AI 采集中…" : "开始 AI 采集"}</button>
            </div>
          </form>
          {aiResult && (
            <div className="aiCollectResult">
              <div className="aiCollectResultHead">
                <b>采集结果</b>
                <small>调用 {aiResult.toolCalls} 次工具{aiResult.runId ? ` · 采集记录 #${aiResult.runId} 待确认入库` : ""}</small>
              </div>
              <pre>{aiResult.text.slice(0, 20000)}</pre>
            </div>
          )}
        </div>
      </div>
    )}

    {/* Modal：采集结果详情 */}
    {selectedCollectionRun && (
      <div className="modalBackdrop" onMouseDown={() => { setSelectedCollectionRun(null); setShowCleaning(false); setCleanedPreview(""); }}>
        <div className="modal collectionResult" onMouseDown={e => e.stopPropagation()}>
          <div className="modalHead">
            <div>
              <h2>{selectedCollectionRun.sourceName}</h2>
              <p>采集运行 #{selectedCollectionRun.id} · {new Date(selectedCollectionRun.createdAt).toLocaleString("zh-CN")}</p>
            </div>
            <button type="button" onClick={() => { setSelectedCollectionRun(null); setShowCleaning(false); setCleanedPreview(""); }}>×</button>
          </div>
          <div className={`runSummary ${statusClassName(selectedCollectionRun.status)}`}>
            <b>{selectedCollectionRun.status}</b>
            <span>{selectedCollectionRun.error || `HTTP ${selectedCollectionRun.httpStatus || "本地"} · 识别 ${selectedCollectionRun.rowCount} 条 · ${selectedCollectionRun.contentType} · ${collectorModeLabel(selectedCollectionRun.collectorMode)} · 入${targetStoreLabel(selectedCollectionRun.targetStore)} · ${outputFormatLabel(selectedCollectionRun.outputFormat)} · 模型：${modelModeLabel(selectedCollectionRun.modelUsed)}`}</span>
          </div>
          {selectedCollectionRun.preview ? (
            <>
              <div className="cleaningModalHead">
                <div>
                  <b>清洗规则</b>
                  <small>{cleaningRules.map(id => cleaningOptions.find(item => item.id === id)?.name).filter(Boolean).join("、") || "尚未选择"}</small>
                </div>
                <button type="button" disabled={!cleaningRules.length} onClick={() => runDataCleaning()}>执行数据清洗</button>
              </div>
              <div className={showCleaning ? "cleaningCompare active" : "cleaningCompare"}>
                <label>
                  <small>入库预览</small>
                  <textarea readOnly rows={showCleaning ? 12 : 16} value={selectedCollectionRun.preview} />
                </label>
                {showCleaning && (
                  <label>
                    <small>清洗后数据</small>
                    <textarea readOnly rows={12} value={cleanedPreview} />
                  </label>
                )}
              </div>
            </>
          ) : (
            <div className="guardrail">
              <b>失败原因</b>
              <p>{selectedCollectionRun.error}</p>
            </div>
          )}
          <div className="modalActions">
            <button type="button" className="dangerButton" onClick={() => deleteCollectionRun(selectedCollectionRun)}>删除日志</button>
            <button type="button" className="outline" onClick={() => { setSelectedCollectionRun(null); setShowCleaning(false); setCleanedPreview(""); }}>关闭</button>
            {showCleaning && (
              <button type="button" className="outline" onClick={() => { setShowCleaning(false); setCleanedPreview(""); }}>恢复原始数据</button>
            )}
            {["待确认", "待审核", "已采集"].includes(selectedCollectionRun.status) && (
              <button type="button" onClick={() => approveCollectionRun({ ...selectedCollectionRun, preview: cleanedPreview || selectedCollectionRun.preview })}>
                {showCleaning ? `使用清洗结果并进入${targetStoreLabel(selectedCollectionRun.targetStore)}` : `手动进入${targetStoreLabel(selectedCollectionRun.targetStore)}`}
              </button>
            )}
          </div>
        </div>
      </div>
    )}
  </section>;
}
