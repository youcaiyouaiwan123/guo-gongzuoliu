"use client";

import { ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { RefreshIcon, SparklesIcon } from "./components/icons";
import { log } from "./features/logger";

type NoticeSetter = (message: string) => void;

type Template = {
  id: number;
  title: string;
  description?: string;
  content: string;
  variables: string;
  updatedAt?: string;
};

type ContractDoc = {
  id: number;
  templateTitle: string;
  title: string;
  downloadUrl: string;
  createdAt: string;
};

type MonitoringReport = {
  id: number;
  title: string;
  platform: string;
  reportJson: string;
  createdAt: string;
};

type MonitoringDatum = Record<string, unknown> & {
  date?: string;
  spend?: number;
  cost?: number;
  name?: string;
  value?: number;
};

type MonitoringData = Record<string, unknown> & {
  summary?: Record<string, unknown>;
  totals?: Record<string, unknown>;
  indicators?: Record<string, unknown>;
  cleaning?: { inputRows?: number; usedRows?: number; dropped?: Array<{ reason: string; count: number }> };
  trend?: MonitoringDatum[];
  bars?: MonitoringDatum[];
};

type TextModel = {
  id: number;
  provider: string;
  model: string;
};

function safeJson<T>(value: string | undefined, fallback: T): T {
  try {
    return value ? JSON.parse(value) as T : fallback;
  } catch {
    return fallback;
  }
}

function formatNumber(value: unknown) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number.toLocaleString("zh-CN", { maximumFractionDigits: 2 }) : "0";
}

// CTR、转化率是 0~1 的比值，统一走 formatNumber 会显示成 "0.02"，看上去和 0 没区别；
// CPC、ROAS 则需要固定两位小数，不能被千分位整数格式吞掉小数。
function formatPercent(value: unknown) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? `${(number * 100).toFixed(2)}%` : "0%";
}

function formatRatio(value: unknown) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number.toFixed(2) : "0.00";
}

async function readResult(response: Response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}

async function deleteMany(url: string, ids: number[]) {
  return fetch(url, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids }),
  });
}

export function ArtifactUploadPanel({ onDone, setNotice }: { onDone: () => void; setNotice: NoticeSetter }) {
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState(0);

  async function processFile(file: File) {
    setBusy(true);
    setProgress(0);
    try {
      const content = await file.text();
      const lower = file.name.toLowerCase();
      const artifactType = lower.endsWith(".skill") ? "skill" : "markdown";
      setProgress(60);
      const response = await fetch("/api/artifacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: file.name,
          artifactType,
          sourceType: "upload",
          content,
          config: { fileName: file.name, fileSize: file.size },
        }),
      });
      setProgress(95);
      const data = await readResult(response);
      if (!response.ok) throw new Error(data.error || "上传失败");
      setProgress(100);
      setNotice("沉淀文件已保存。");
      onDone();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "上传失败");
    } finally {
      setBusy(false);
      setTimeout(() => setProgress(0), 400);
    }
  }

  function handleInputChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    processFile(file);
    event.target.value = "";
  }

  function handleDragOver(event: React.DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    if (!dragging) setDragging(true);
  }

  function handleDragLeave(event: React.DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setDragging(false);
  }

  function handleDrop(event: React.DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    processFile(file);
  }

  return (
    <section className="uploadPanel">
      <h3>上传</h3>
      <label
        className={`dropZone ${dragging ? "dragging" : ""}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <input
          type="file"
          accept=".md,.markdown,.skill,.txt,text/markdown,text/plain"
          onChange={handleInputChange}
          disabled={busy}
          multiple
        />
        <div className="dropZoneContent">
          <b>{busy ? "上传中…" : "拖拽文件到此处"}</b>
          <small>或点击选择 .md / .skill / .txt</small>
        </div>
      </label>
      {busy && (
        <div className="uploadProgress" aria-label="上传进度">
          <div className="bar" style={{ width: `${progress}%` }} />
        </div>
      )}
    </section>
  );
}

export function AdminSystemPanel({ setNotice }: { setNotice: NoticeSetter }) {
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/admin/settings")
      .then(response => response.ok ? response.json() : Promise.reject())
      .then(data => setSettings(data.settings || {}))
      .catch(() => undefined);
  }, []);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    const values = Object.fromEntries(new FormData(event.currentTarget).entries());
    const response = await fetch("/api/admin/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(values),
    });
    const data = await readResult(response);
    setNotice(response.ok ? data.message || "SMTP 设置已保存并生效。" : data.error || "SMTP 保存失败。");
    setBusy(false);
  }

  return (
    <section className="featureCard">
      <div className="sectionTitle slimTitle">
        <div>
          <h3>系统邮件 SMTP</h3>
        </div>
      </div>
      <form className="featureForm twoColumns" onSubmit={save}>
        <label>SMTP 服务器地址<input name="smtpHost" required defaultValue={settings.smtpHost || ""} placeholder="smtp.example.com" /></label>
        <label>SMTP 端口<input name="smtpPort" required defaultValue={settings.smtpPort || "465"} placeholder="465 / 587" /></label>
        <label>SMTP 账户<input name="smtpAccount" required defaultValue={settings.smtpAccount || ""} /></label>
        <label>SMTP 发送者邮箱<input name="smtpSender" type="email" required defaultValue={settings.smtpSender || ""} /></label>
        <label className="wide">SMTP 访问凭证<input name="smtpCredential" type="password" placeholder={settings.smtpCredential ? "已保存；不修改可留空" : "授权码或密码"} /></label>
        <button disabled={busy}>{busy ? "保存中…" : "保存 SMTP 设置"}</button>
      </form>
    </section>
  );
}

export function ContractsPanel({ isAdmin, setNotice }: { isAdmin: boolean; setNotice: NoticeSetter }) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [documents, setDocuments] = useState<ContractDoc[]>([]);
  const [selectedId, setSelectedId] = useState<number | "">("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [selectedTemplates, setSelectedTemplates] = useState<number[]>([]);
  const [selectedDocs, setSelectedDocs] = useState<number[]>([]);
  const [sectionText, setSectionText] = useState("");
  const [sectionMode, setSectionMode] = useState<"fixed" | "variable">("fixed");
  const [templateText, setTemplateText] = useState("");
  const [templateUploadBusy, setTemplateUploadBusy] = useState(false);
  const [templateFileName, setTemplateFileName] = useState("");

  async function load() {
    const response = await fetch("/api/contracts");
    const data = await readResult(response);
    if (response.ok) {
      setTemplates(data.templates || []);
      setDocuments(data.documents || []);
      if (!selectedId && data.templates?.[0]) setSelectedId(data.templates[0].id);
    }
  }

  useEffect(() => {
    void Promise.resolve().then(load);
  }, []);

  const selected = templates.find(item => item.id === selectedId);
  const variables = useMemo(() => safeJson<string[]>(selected?.variables, []), [selected]);

  function addSection() {
    const text = sectionText.trim();
    if (!text) return;
    const addition = sectionMode === "variable" ? `{{${text}}}` : text;
    setTemplateText(current => `${current}${current ? "\n\n" : ""}${addition}`);
    setSectionText("");
  }

  async function saveTemplate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formValues = Object.fromEntries(new FormData(event.currentTarget).entries());
    const content = templateText || String(formValues.content || "");
    const response = await fetch("/api/contracts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "saveTemplate", ...formValues, content }),
    });
    const data = await readResult(response);
    setNotice(response.ok ? `合同模板已保存，识别变量：${(data.variables || []).join("、") || "无"}` : data.error || "合同模板保存失败。");
    if (response.ok) {
      setTemplateText("");
      await load();
    }
  }

  async function importTemplateFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    setTemplateFileName(file.name);
    setTemplateUploadBusy(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const response = await fetch("/api/extract-file", { method: "POST", body: formData });
      const data = await readResult(response);
      if (!response.ok) {
        setNotice(data.error || "模板文件解析失败。");
        return;
      }
      // /api/extract-file 统一返回 content 字段，解析失败时用 note 说明原因。
      const text = String(data.content || "").trim();
      if (!text) {
        setNotice(data.note || "文件已读取，但没有提取到可用文字。请换成可复制文字的 PDF/Word，或手动粘贴模板内容。");
        return;
      }
      setTemplateText(text);
      setNotice(`已读取模板文件：${file.name}。请检查变量后保存模板。`);
    } catch {
      setNotice("模板文件上传或解析失败，请稍后重试。");
    } finally {
      setTemplateUploadBusy(false);
    }
  }

  async function generateContract() {
    if (!selectedId) return setNotice("请先选择合同模板。");
    const response = await fetch("/api/contracts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "generate", templateId: selectedId, values }),
    });
    const data = await readResult(response);
    setNotice(response.ok ? "合同已生成，可下载 PDF。" : data.error || "合同生成失败。");
    if (response.ok) await load();
  }

  async function removeTemplates(ids: number[]) {
    if (!ids.length) return;
    const response = await deleteMany("/api/contracts?type=template", ids);
    const data = await readResult(response);
    setNotice(response.ok ? data.message || "合同模板已删除。" : data.error || "删除失败。");
    setSelectedTemplates([]);
    await load();
  }

  async function removeDocs(ids: number[]) {
    if (!ids.length) return;
    const response = await deleteMany("/api/contracts?type=document", ids);
    const data = await readResult(response);
    setNotice(response.ok ? data.message || "合同记录已删除。" : data.error || "删除失败。");
    setSelectedDocs([]);
    await load();
  }

  return (
    <section className="contentPanel">
      <div className="sectionTitle">
        <div><h2>合同中心</h2></div>
        <span className="policyBadge">{templates.length} 个模板</span>
      </div>

      {isAdmin && (
        <section className="featureCard">
          <h3>管理员添加合同模板</h3>
          <p>变量写法：{"{{甲方}}、{{乙方}}、{{签署日期}}"}。系统会自动识别变量，其余文字就是固定条款。</p>
          <div className="templateBuilder">
            <label>模块内容<input value={sectionText} onChange={event => setSectionText(event.target.value)} placeholder="输入固定条款，或输入变量名称" /></label>
            <select value={sectionMode} onChange={event => setSectionMode(event.target.value as "fixed" | "variable")}>
              <option value="fixed">固定内容</option>
              <option value="variable">变量字段</option>
            </select>
            <button type="button" className="outline" onClick={addSection}>添加到模板</button>
          </div>
          <form className="featureForm" onSubmit={saveTemplate}>
            <label>合同名称<input name="title" required placeholder="例如：AI 培训服务合同" /></label>
            <label>说明<input name="description" placeholder="用于用户选择模板时识别用途" /></label>
            <label className="wide contractTemplateUpload">
              <span className="contractTemplateUploadTitle">上传合同模板</span>
              <span className="contractTemplateUploadBox">
                <span>
                  <b>{templateUploadBusy ? "正在解析模板…" : "选择 PDF / Word / Markdown / TXT"}</b>
                  <em>{templateFileName ? `已选择：${templateFileName}` : "点击这里选择文件，解析后自动填入下方合同模板"}</em>
                </span>
                <i>{templateUploadBusy ? "解析中" : "选择文件"}</i>
              </span>
              <input type="file" accept=".pdf,.docx,.md,.txt,text/markdown,text/plain,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={importTemplateFile} disabled={templateUploadBusy} />
              <small>{templateUploadBusy ? "正在解析模板文件..." : "支持可复制文字的 PDF、Word（docx）、Markdown、TXT；解析后会自动填入下方模板框。"}</small>
            </label>
            <label className="wide">合同模板<textarea name="content" required rows={10} value={templateText} onChange={event => setTemplateText(event.target.value)} placeholder={"甲方：{{甲方}}\n乙方：{{乙方}}\n服务内容：海芯博创为甲方提供 {{服务内容}}。"} /></label>
            <button>保存模板并识别变量</button>
          </form>
        </section>
      )}

      <section className="featureGrid">
        <article className="featureCard">
          <h3>生成合同</h3>
          <label>选择模板<select value={selectedId} onChange={event => { setSelectedId(Number(event.target.value)); setValues({}); }}>
            <option value="">请选择合同模板</option>
            {templates.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
          </select></label>
          {variables.map(name => (
            <label key={name}>{name}<input value={values[name] || ""} onChange={event => setValues(current => ({ ...current, [name]: event.target.value }))} /></label>
          ))}
          <button onClick={generateContract}>生成合同</button>
        </article>

        <article className="featureCard">
          <div className="inlineTitle">
            <h3>模板管理</h3>
            {isAdmin && templates.length > 0 && <button className="outline" onClick={() => setSelectedTemplates(selectedTemplates.length === templates.length ? [] : templates.map(item => item.id))}>{selectedTemplates.length === templates.length ? "取消全选" : "全选"}</button>}
            {isAdmin && selectedTemplates.length > 0 && <button className="dangerButton" onClick={() => removeTemplates(selectedTemplates)}>删除所选</button>}
          </div>
          <div className="compactList">
            {templates.map(item => <div key={item.id}><label className="rowCheck"><input type="checkbox" checked={selectedTemplates.includes(item.id)} onChange={() => setSelectedTemplates(current => current.includes(item.id) ? current.filter(id => id !== item.id) : [...current, item.id])} /><b>{item.title}</b></label><small>{safeJson<string[]>(item.variables, []).join("、") || "无变量"}</small>{isAdmin && <button className="dangerButton" onClick={() => removeTemplates([item.id])}>删除</button>}</div>)}
            {!templates.length && <p>还没有合同模板。</p>}
          </div>
        </article>
      </section>

      <section className="featureCard">
        <div className="inlineTitle">
          <h3>已生成合同</h3>
          {documents.length > 0 && <button className="outline" onClick={() => setSelectedDocs(selectedDocs.length === documents.length ? [] : documents.map(item => item.id))}>{selectedDocs.length === documents.length ? "取消全选" : "全选"}</button>}
          {selectedDocs.length > 0 && <button className="dangerButton" onClick={() => removeDocs(selectedDocs)}>删除所选</button>}
        </div>
        <div className="auditTable">
          <div className="userRow head"><b>合同</b><b>生成时间</b><b>操作</b></div>
          {documents.map(doc => <div className="userRow" key={doc.id}><label className="rowCheck"><input type="checkbox" checked={selectedDocs.includes(doc.id)} onChange={() => setSelectedDocs(current => current.includes(doc.id) ? current.filter(id => id !== doc.id) : [...current, doc.id])} /><span>{doc.title || doc.templateTitle}</span></label><span>{new Date(doc.createdAt).toLocaleString("zh-CN")}</span><a className="outlineLink" href={doc.downloadUrl} target="_blank">下载 PDF</a></div>)}
        </div>
      </section>
    </section>
  );
}

export function MonitoringPanel({ setNotice }: { setNotice: NoticeSetter }) {
  const [reports, setReports] = useState<MonitoringReport[]>([]);
  const [current, setCurrent] = useState<MonitoringData | null>(null);
  const [fileText, setFileText] = useState("");
  const [selectedReports, setSelectedReports] = useState<number[]>([]);

  async function load() {
    const response = await fetch("/api/monitoring");
    const data = await readResult(response);
    if (response.ok) setReports(data.reports || []);
  }

  useEffect(() => {
    void Promise.resolve().then(load);
  }, []);

  async function readFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) setFileText(await file.text());
  }

  async function analyze(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget).entries());
    const response = await fetch("/api/monitoring", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...values, data: fileText || values.rawData }),
    });
    const data = await readResult(response);
    if (!response.ok) return setNotice(data.error || "监控数据分析失败。");
    setCurrent(data.report);
    setNotice("监控看板已生成。");
    await load();
  }

  async function removeReports(ids: number[]) {
    if (!ids.length) return;
    const response = await deleteMany("/api/monitoring", ids);
    const data = await readResult(response);
    setNotice(response.ok ? data.message || "监控报表已删除。" : data.error || "删除失败。");
    setSelectedReports([]);
    await load();
  }

  // CTR/CPC/转化率/ROAS 由后端放在 indicators 里，而这里过去只读 summary/totals，
  // 于是四个衍生指标恒为 undefined，界面上永远显示 0。三者合并，历史报表也能正确回显。
  const summary: Record<string, unknown> = { ...current?.totals, ...current?.indicators, ...current?.summary };
  const cleaning = current?.cleaning;
  const droppedTotal = (cleaning?.dropped || []).reduce((sum, item) => sum + item.count, 0);
  const trend = current?.trend || [];
  const bars = current?.bars || [];
  const maxSpend = Math.max(1, ...trend.map((item) => Number(item.spend ?? item.cost ?? 0)));
  const maxBar = Math.max(1, ...bars.map((item) => Number(item.value || 0)));

  return (
    <section className="contentPanel pageFill monitoringPage">
      <div className="pageScroll">
      <section className="featureCard">
        <form className="featureForm twoColumns" onSubmit={analyze}>
          <label>看板名称<input name="title" placeholder="例如：7月投放日报" /></label>
          <label>数据平台<select name="platform"><option>自动识别</option><option>抖音</option><option>Google Ads</option><option>天猫</option><option>小红书</option><option>其他</option></select></label>
          <label className="wide">上传数据文件<input type="file" accept=".csv,.tsv,.json,.txt" onChange={readFile} /></label>
          <label className="wide">或粘贴数据<textarea name="rawData" rows={8} placeholder="粘贴 CSV / JSON / 表格文本。系统会识别常见字段：花费、曝光、点击、转化、销售额、日期、计划、商品等。" /></label>
          <button>生成监控看板</button>
        </form>
      </section>

      {current && <section className="dashboardBoard">
        <div className="metricGrid">
          {([
            ["花费", summary.spend ?? summary.cost, formatNumber],
            ["曝光", summary.impressions, formatNumber],
            ["点击", summary.clicks, formatNumber],
            ["转化", summary.conversions, formatNumber],
            ["销售额", summary.revenue, formatNumber],
            ["CTR", summary.ctr, formatPercent],
            ["CPC", summary.cpc, formatRatio],
            ["转化率", summary.conversionRate ?? summary.cvr, formatPercent],
            ["ROAS", summary.roas, formatRatio],
          ] as Array<[string, unknown, (value: unknown) => string]>).map(([label, value, format]) => <article key={label}><span>{label}</span><b>{format(value)}</b></article>) }
        </div>
        {cleaning && <p className="cleaningSummary">
          {droppedTotal
            ? `已剔除 ${droppedTotal} 行异常数据（${(cleaning.dropped || []).map(item => `${item.reason} ${item.count}`).join(" / ")}），实际统计 ${cleaning.usedRows} / ${cleaning.inputRows} 行。`
            : `${cleaning.usedRows} 行数据全部参与统计，未发现合计行、空行或全零行。`}
        </p>}
        <div className="featureGrid">
          <div className="chartPanel"><h3>趋势图</h3><div className="chartBars">{trend.map((item, index) => <span key={index} style={{ height: `${Math.max(8, Number(item.spend ?? item.cost ?? 0) / maxSpend * 160)}px` }} title={`${item.date}: ${item.spend ?? item.cost}`} />)}</div></div>
          <div className="chartPanel"><h3>柱状排行</h3><div className="rankBars">{bars.map((item) => <p key={item.name}><span>{item.name}</span><i style={{ width: `${Math.max(6, Number(item.value || 0) / maxBar * 100)}%` }} /><b>{formatNumber(item.value)}</b></p>)}</div></div>
        </div>
      </section>}

      <section className="featureCard">
        <div className="inlineTitle">
          <h3>历史看板</h3>
          {reports.length > 0 && <button className="outline" onClick={() => setSelectedReports(selectedReports.length === reports.length ? [] : reports.map(item => item.id))}>{selectedReports.length === reports.length ? "取消全选" : "全选"}</button>}
          {selectedReports.length > 0 && <button className="dangerButton" onClick={() => removeReports(selectedReports)}>删除所选</button>}
        </div>
        <div className="compactList">
          {reports.map(item => <div key={item.id}><label className="rowCheck"><input type="checkbox" checked={selectedReports.includes(item.id)} onChange={() => setSelectedReports(current => current.includes(item.id) ? current.filter(id => id !== item.id) : [...current, item.id])} /><b>{item.title}</b></label><small>{item.platform} · {new Date(item.createdAt).toLocaleString("zh-CN")}</small><button onClick={() => setCurrent(safeJson<MonitoringData | null>(item.reportJson, null))}>查看</button></div>)}
        </div>
      </section>
      </div>
    </section>
  );
}



type CleanImageModel = {
  id: number;
  connectionName: string;
  provider: string;
  baseUrl?: string;
  model: string;
};

type CleanGeneratedImage = {
  id: number;
  provider: string;
  model: string;
  prompt: string;
  size: string;
  quality: string;
  imageUrl?: string;
  imageDataUrl?: string;
  createdAt?: string;
};

function CleanMediaPanel() {
  const [imageModels, setImageModels] = useState<CleanImageModel[]>([]);
  const [textModels, setTextModels] = useState<TextModel[]>([]);
  const [images, setImages] = useState<CleanGeneratedImage[]>([]);
  const [selectedModelId, setSelectedModelId] = useState("");
  const [selectedModels, setSelectedModels] = useState<number[]>([]);
  const [selectedImages, setSelectedImages] = useState<number[]>([]);
  const [editingModel, setEditingModel] = useState<CleanImageModel | null>(null);
  const [formKey, setFormKey] = useState(0);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [promptMode, setPromptMode] = useState<"structured" | "custom">("structured");
  const [optimizePrompt, setOptimizePrompt] = useState(false);
  const [textModelId, setTextModelId] = useState("");
  const [customPrompt, setCustomPrompt] = useState("");
  const [optimizedPrompt, setOptimizedPrompt] = useState("");
  const [settings, setSettings] = useState({ size: "1024x1024", quality: "standard", count: 1 });
  const [structured, setStructured] = useState({
    subject: "",
    scene: "",
    brand: "海芯博创蓝色科技视觉，突出 AI 培训与大模型服务",
    style: "现代企业宣传图，干净高级，蓝绿色科技风",
    composition: "主体清晰，留白合理，适合官网或宣传海报",
    text: "",
    negative: "不要低清，不要水印，不要杂乱文字，不要错误中文",
  });
  const resultRef = useRef<HTMLDivElement | null>(null);

  const providerPresets = [
    { provider: "GPT 图片", models: ["gpt-image-2-c", "gpt-image-1", "dall-e-3"] },
    { provider: "Google Gemini 图片", models: ["gemini-2.5-flash-image", "imagen-4.0-generate-preview"] },
    { provider: "通义千问 / 通义万相", models: ["qwen-image", "wanx2.1-t2i-turbo", "wanx2.1-t2i-plus"] },
    { provider: "字节豆包 / 即梦", models: ["doubao-seedream-3-0-t2i", "seedream-4.0", "jimeng-2.1"] },
    { provider: "自定义图片模型", models: [] },
  ];

  async function loadAll() {
    const [modelResponse, textResponse, imageResponse] = await Promise.all([
      fetch("/api/image-models"),
      fetch("/api/model"),
      fetch("/api/image-generate"),
    ]);
    const modelData = await readResult(modelResponse);
    const textData = await readResult(textResponse);
    const imageData = await readResult(imageResponse);
    const nextImageModels = modelData.models || [];
    const nextTextModels = textData.connections || [];
    setImageModels(nextImageModels);
    setTextModels(nextTextModels);
    setImages(imageData.images || []);
    setSelectedModelId(current => current || (nextImageModels[0]?.id ? String(nextImageModels[0].id) : ""));
    setTextModelId(current => current || (nextTextModels[0]?.id ? String(nextTextModels[0].id) : ""));
  }

  useEffect(() => {
    void Promise.resolve().then(loadAll).catch(error => setMessage(error instanceof Error ? error.message : "图片模块加载失败。"));
  }, []);

  function updateStructured(key: keyof typeof structured, value: string) {
    setStructured(current => ({ ...current, [key]: value }));
  }

  function sourcePrompt() {
    if (promptMode === "custom") return customPrompt.trim();
    return [
      ["画面主题", structured.subject],
      ["使用场景", structured.scene],
      ["品牌要求", structured.brand],
      ["视觉风格", structured.style],
      ["构图比例", structured.composition],
      ["画面文字", structured.text],
      ["负面约束", structured.negative],
    ].filter(([, value]) => String(value || "").trim()).map(([label, value]) => `${label}：${value}`).join("\n");
  }

  async function saveImageModel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy("save-model");
    setMessage("");
    try {
      const response = await fetch("/api/image-models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "save",
          id: editingModel?.id,
          connectionName: form.get("connectionName"),
          provider: form.get("provider"),
          model: form.get("model"),
          apiKey: form.get("apiKey"),
        }),
      });
      const result = await readResult(response);
      if (!response.ok) throw new Error(result.message || result.error || "图片模型保存失败。");
      setMessage(result.message || "图片模型已保存。");
      setEditingModel(null);
      setFormKey(value => value + 1);
      await loadAll();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "图片模型保存失败。");
    } finally {
      setBusy("");
    }
  }

  async function testImageModel(model: CleanImageModel) {
    setBusy(`test-${model.id}`);
    setMessage("");
    try {
      const response = await fetch("/api/image-models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: model.id }),
      });
      const result = await readResult(response);
      if (!response.ok) throw new Error(result.message || result.error || "图片模型测试失败。");
      setMessage(result.message || "图片模型测试成功。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "图片模型测试失败。");
    } finally {
      setBusy("");
    }
  }

  async function deleteImageModels(ids: number[]) {
    if (!ids.length) return;
    setBusy("delete-model");
    try {
      const response = await deleteMany("/api/image-models", ids);
      const result = await readResult(response);
      setMessage(result.message || `已删除 ${ids.length} 个图片模型。`);
      setSelectedModels([]);
      await loadAll();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "删除图片模型失败。");
    } finally {
      setBusy("");
    }
  }

  async function optimizeCurrentPrompt() {
    const prompt = sourcePrompt();
    if (!prompt) return setMessage("请先填写提示词内容。");
    if (!textModelId) return setMessage("请先选择一个用于优化提示词的大模型。");
    setBusy("optimize");
    setMessage("");
    try {
      const response = await fetch("/api/image-prompt-optimize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ textModelId, prompt }),
      });
      const result = await readResult(response);
      if (!response.ok) throw new Error(result.message || result.error || "提示词优化失败。");
      const nextPrompt = result.optimizedPrompt || result.prompt || result.content || "";
      if (!nextPrompt) throw new Error("提示词优化没有返回内容，请更换优化模型或关闭优化开关。");
      setOptimizedPrompt(nextPrompt);
      setMessage("提示词已优化，可以继续生成图片。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "提示词优化失败。");
    } finally {
      setBusy("");
    }
  }

  async function generateImage() {
    const prompt = sourcePrompt();
    if (!selectedModelId) return setMessage("请先保存并选择一个图片模型。");
    if (!prompt) return setMessage("请先填写图片需求或自定义提示词。");
    setBusy("generate");
    log.info("图片生成开始", { modelId: selectedModelId, promptLength: prompt.length, optimizePrompt, size: settings.size, count: settings.count });
    setMessage(optimizePrompt ? "正在优化提示词并生成图片，请稍候。" : "正在生成图片，请稍候。");
    try {
      let finalPrompt = optimizedPrompt || prompt;
      if (optimizePrompt && !optimizedPrompt) {
        log.info("优化提示词", { textModelId });
        const optimizeResponse = await fetch("/api/image-prompt-optimize", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ textModelId, prompt }),
        });
        const optimizeResult = await readResult(optimizeResponse);
        if (!optimizeResponse.ok) throw new Error(optimizeResult.message || optimizeResult.error || "提示词优化失败。");
        finalPrompt = optimizeResult.optimizedPrompt || optimizeResult.prompt || optimizeResult.content || "";
        if (!finalPrompt) throw new Error("提示词优化没有返回内容，请更换优化模型或关闭优化开关。");
        setOptimizedPrompt(finalPrompt);
        log.info("提示词优化完成", { finalPromptLength: finalPrompt.length });
      }
      const response = await fetch("/api/image-generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imageModelId: Number(selectedModelId),
          prompt,
          optimizedPrompt: finalPrompt,
          size: settings.size,
          quality: settings.quality,
          count: Number(settings.count || 1),
        }),
      });
      const result = await readResult(response);
      if (!response.ok) throw new Error(result.message || result.error || "图片生成失败。");
      log.info("图片生成成功", { imagesCount: result.images?.length || 0 });
      setMessage(result.message || "图片已生成，结果已保存到下方。");
      if (Array.isArray(result.images) && result.images.length) {
        setImages(current => [...result.images, ...current.filter(item => !result.images.some((next: CleanGeneratedImage) => next.id === item.id))]);
      }
      await loadAll();
      setTimeout(() => resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 80);
    } catch (error) {
      log.error("图片生成失败", { error: error instanceof Error ? error.message : String(error) });
      setMessage(error instanceof Error ? error.message : "图片生成失败。");
    } finally {
      setBusy("");
    }
  }

  async function deleteImages(ids: number[]) {
    if (!ids.length) return;
    setBusy("delete-image");
    try {
      const response = await deleteMany("/api/image-generate", ids);
      const result = await readResult(response);
      setMessage(result.message || `已删除 ${ids.length} 条图片记录。`);
      setSelectedImages([]);
      await loadAll();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "删除图片记录失败。");
    } finally {
      setBusy("");
    }
  }

  const selectedModel = imageModels.find(item => String(item.id) === selectedModelId);
  const imageSrc = (item: CleanGeneratedImage) => item.imageDataUrl || item.imageUrl || "";

  return (
    <section className="stack mediaPanel">
      <section className="featureCard mediaModelCard">
        <div className="inlineTitle">
          <div>
          </div>
          <span className="pill">{imageModels.length} 个图片模型</span>
        </div>
        <form key={formKey} className="formGrid mediaModelForm" onSubmit={saveImageModel}>
          <label>连接名称<input name="connectionName" defaultValue={editingModel?.connectionName || ""} placeholder="例如：GPT 图片测试" /></label>
          <label>供应商<select name="provider" defaultValue={editingModel?.provider || providerPresets[0].provider}>{providerPresets.map(item => <option key={item.provider}>{item.provider}</option>)}</select></label>
          <label>模型名称<input name="model" defaultValue={editingModel?.model || ""} placeholder="例如：gpt-image-2-c" /></label>
          <label>固定接口地址<input value="https://claudecc.top" readOnly /></label>
          <label>API Key<input name="apiKey" type="password" placeholder={editingModel ? "不修改可留空" : "填写图片模型 Key"} /></label>
          <div className="mediaFormActions">
            <button className="primaryButton saveImageModelButton" disabled={busy === "save-model"}>{busy === "save-model" ? "保存中..." : editingModel ? "保存修改" : "保存图片模型"}</button>
            {editingModel && <button type="button" className="outline" onClick={() => { setEditingModel(null); setFormKey(value => value + 1); }}>取消编辑</button>}
          </div>
        </form>
        <div className="presetMarquee">
          <div className="presetTrack">
            {providerPresets.flatMap(item => item.models.map(model => <button key={`a-${item.provider}-${model}`} className="chipButton" onClick={() => { setEditingModel({ id: 0, connectionName: `${item.provider} · ${model}`, provider: item.provider, baseUrl: "https://claudecc.top", model }); setFormKey(value => value + 1); }}>{item.provider} · {model}</button>))}
            {providerPresets.flatMap(item => item.models.map(model => <button key={`b-${item.provider}-${model}`} className="chipButton" onClick={() => { setEditingModel({ id: 0, connectionName: `${item.provider} · ${model}`, provider: item.provider, baseUrl: "https://claudecc.top", model }); setFormKey(value => value + 1); }}>{item.provider} · {model}</button>))}
          </div>
        </div>
        {imageModels.length > 0 && <div className="mediaBulkActions rowActions"><button className="outline" onClick={() => setSelectedModels(selectedModels.length === imageModels.length ? [] : imageModels.map(item => item.id))}>{selectedModels.length === imageModels.length ? "取消全选" : "全选"}</button>{selectedModels.length > 0 && <button className="dangerButton" onClick={() => deleteImageModels(selectedModels)}>删除所选</button>}</div>}
        <div className="mediaModelList">
          {imageModels.length === 0 && <div className="compactEmptyState">还没有保存图片模型，先在表单里填好供应商、模型名、Key 再保存。</div>}
          {imageModels.map(model => <div className="mediaModelItem" key={model.id}>
            <label className="rowCheck"><input type="checkbox" checked={selectedModels.includes(model.id)} onChange={() => setSelectedModels(current => current.includes(model.id) ? current.filter(id => id !== model.id) : [...current, model.id])} /></label>
            <div className="modelAvatar">{model.provider?.slice(0, 1) || "图"}</div>
            <div className="modelInfo"><b>{model.connectionName}</b><span>{model.provider} · {model.model}</span></div>
            <div className="itemActions">
              <button className="outline" onClick={() => { setEditingModel(model); setFormKey(value => value + 1); }}>编辑</button>
              <button className="outline" disabled={busy === `test-${model.id}`} onClick={() => testImageModel(model)}>{busy === `test-${model.id}` ? "测试中..." : "测试"}</button>
              <button className="dangerButton" onClick={() => deleteImageModels([model.id])}>删除</button>
            </div>
          </div>)}
        </div>
      </section>

      <div className="mediaWorkGrid">
        <section className="featureCard mediaGeneratorCard">
          <div className="inlineTitle mediaGeneratorTitle"><div><h2>文生图</h2></div><button className="primaryButton generateImageButton" disabled={busy === "generate"} onClick={generateImage}>{busy === "generate" ? "生成中..." : "生成图片"}</button></div>
          <div className="mediaGeneratorBody">
            <div className="formGrid twoCols">
              <label>图片模型<select value={selectedModelId} onChange={event => setSelectedModelId(event.target.value)}>{imageModels.length === 0 && <option value="">请先保存图片模型</option>}{imageModels.map(item => <option key={item.id} value={item.id}>{item.provider} · {item.model}</option>)}</select></label>
              <label>比例 / 尺寸<select value={settings.size} onChange={event => setSettings(current => ({ ...current, size: event.target.value }))}><option>1024x1024</option><option>1024x1536</option><option>1536x1024</option><option>1792x1024</option><option>1024x1792</option></select></label>
              <label>质量<select value={settings.quality} onChange={event => setSettings(current => ({ ...current, quality: event.target.value }))}><option value="standard">标准</option><option value="hd">高清</option><option value="high">高质量</option></select></label>
              <label>数量<input type="number" min="1" max="4" value={settings.count} onChange={event => setSettings(current => ({ ...current, count: Number(event.target.value || 1) }))} /></label>
            </div>
            <div className="toggleRow"><button className={promptMode === "structured" ? "active" : ""} onClick={() => setPromptMode("structured")}>结构化提示词</button><button className={promptMode === "custom" ? "active" : ""} onClick={() => setPromptMode("custom")}>自定义提示词</button><label><input type="checkbox" checked={optimizePrompt} onChange={event => setOptimizePrompt(event.target.checked)} /> 生成前优化提示词</label></div>
            {optimizePrompt && <label className="optimizerRow">选择优化模型<select value={textModelId} onChange={event => setTextModelId(event.target.value)}>{textModels.length === 0 && <option value="">请先在模型接入中保存文本模型</option>}{textModels.map(item => <option key={item.id} value={item.id}>{item.provider} · {item.model}</option>)}</select></label>}
            {promptMode === "structured" ? <div className="formGrid span7">
              <label>主题<input value={structured.subject} onChange={event => updateStructured("subject", event.target.value)} placeholder="例如：海芯博创蓝色科技风企业宣传图" /></label>
              <label>场景<input value={structured.scene} onChange={event => updateStructured("scene", event.target.value)} placeholder="官网 Banner、产品海报、培训封面" /></label>
              <label>品牌要求<input value={structured.brand} onChange={event => updateStructured("brand", event.target.value)} /></label>
              <label>风格<input value={structured.style} onChange={event => updateStructured("style", event.target.value)} /></label>
              <label>构图<input value={structured.composition} onChange={event => updateStructured("composition", event.target.value)} /></label>
              <label>画面文字<input value={structured.text} onChange={event => updateStructured("text", event.target.value)} placeholder="需要出现在图里的短文字" /></label>
              <label className="span2">负面约束<input value={structured.negative} onChange={event => updateStructured("negative", event.target.value)} /></label>
            </div> : <label className="customPromptLabel">自定义提示词<textarea value={customPrompt} onChange={event => setCustomPrompt(event.target.value)} placeholder="直接输入完整生图提示词..." /></label>}
            <div className="rowActions"><button className="primaryButton optimizePromptButton" disabled={busy === "optimize"} onClick={optimizeCurrentPrompt}>{busy === "optimize" ? <><RefreshIcon style={{ width: 14, height: 14, animation: "spin 1s linear infinite" }} /> 优化中...</> : <><SparklesIcon style={{ width: 14, height: 14 }} /> 优化提示词</>}</button>{selectedModel && <span className="muted">当前使用：{selectedModel.provider} · {selectedModel.model}</span>}</div>
            {optimizedPrompt && <div className="softPanel"><b>优化后的提示词</b><pre>{optimizedPrompt}</pre></div>}
            {message && <div className="softPanel">{message}</div>}
          </div>
        </section>

        <section className="featureCard mediaVideoCard">
          <div className="inlineTitle"><div><h2>视频生成</h2></div></div>
          <div className="mediaVideoBody">
            <p className="videoHint">这里先保留企业短视频脚本与分镜需求，后续接入视频模型后可直接生成。</p>
            <label>视频需求<textarea placeholder="例如：30 秒企业宣传短片，突出大模型销售与 AI 培训服务。" /></label>
          </div>
        </section>

        <section className="featureCard mediaResultCard" ref={resultRef}>
          <div className="inlineTitle"><div><h2>生成结果</h2></div>{images.length > 0 && <div className="rowActions"><button className="outline" onClick={() => setSelectedImages(selectedImages.length === images.length ? [] : images.map(item => item.id))}>{selectedImages.length === images.length ? "取消全选" : "全选"}</button>{selectedImages.length > 0 && <button className="dangerButton" onClick={() => deleteImages(selectedImages)}>删除所选</button>}</div>}</div>
          <div className="mediaResultBody">
            {images.length === 0 ? <div className="compactEmptyState">还没有生成图片，填写需求后点击「生成图片」即可。</div> : <div className="imageResultGrid">
              {images.map(item => <article key={item.id} className="imageResultItem"><label className="rowCheck"><input type="checkbox" checked={selectedImages.includes(item.id)} onChange={() => setSelectedImages(current => current.includes(item.id) ? current.filter(id => id !== item.id) : [...current, item.id])} /><b>{item.provider} · {item.model}</b></label>{imageSrc(item) ? <img src={imageSrc(item)} alt={item.prompt} /> : null}<p>{item.prompt}</p><small>{item.size} · {item.createdAt ? new Date(item.createdAt).toLocaleString("zh-CN") : "时间未知"}</small><div className="rowActions">{imageSrc(item) && <a className="outline" href={imageSrc(item)} download={`haixin-image-${item.id}.png`}>下载</a>}<button className="outline" onClick={() => navigator.clipboard?.writeText(imageSrc(item))}>复制地址</button><button className="dangerButton" onClick={() => deleteImages([item.id])}>删除</button></div></article>)}
            </div>}
          </div>
        </section>
      </div>
    </section>
  );
}

export function MediaPanel() {
  return <CleanMediaPanel />;
}

export function HelpPanel() {
  return (
    <section className="stack">
      <section className="featureCard">
        <h2>使用说明</h2>
        <p>这里汇总海芯博创企业智能中台的主要功能说明。左侧进入对应模块，按页面提示完成配置和操作。</p>
        <div className="guideGrid">
          <div><h3>智能助手</h3><p>用于日常问答、上传资料解析、保存个人知识和调用企业知识。</p></div>
          <div><h3>模型接入</h3><p>保存第三方模型 Key，文本模型与图片模型分开管理。</p></div>
          <div><h3>平台接入</h3><p>配置飞书、钉钉、企业微信机器人，通道网关上线后外部机器人可真实回复。</p></div>
          <div><h3>数据采集</h3><p>按目标网页、API、截图识别或自定义字段采集数据，默认入个人知识库。</p></div>
          <div><h3>合同中心</h3><p>管理员维护合同模板，用户填写变量后生成合同并下载 PDF。</p></div>
          <div><h3>图文视频生成</h3><p>保存图片模型，填写提示词后生成宣传图、海报或培训配图。</p></div>
        </div>
      </section>
    </section>
  );
}

