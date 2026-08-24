"use client";

import { useState } from "react";
import type { Doc, PersonalKnowledge, OrgUnit } from "../shared-types";

export type KnowledgeSelection =
  | { kind: "enterprise"; doc: Doc }
  | { kind: "personal"; item: PersonalKnowledge };

const CATEGORIES = ["行政制度", "人事资料", "产品资料", "销售方案", "客户项目", "企业宣传", "财务制度", "培训资料", "其他"];
const VISIBILITIES = ["部门", "全员", "销售经理", "市场专员"];
const UPDATE_MODES = ["手动更新", "每日检查", "每周检查", "每月检查", "源文件变化时"];

interface KnowledgeDetailModalProps {
  selection: KnowledgeSelection;
  canEdit: boolean;
  appRole: string;
  orgUnits: OrgUnit[];
  onClose: () => void;
  onSaved: () => Promise<void> | void;
  setNotice: (message: string) => void;
  downloadKnowledgeText: (title: string, content: string) => void;
  onAskAi: () => void;
  onDelete: () => void;
  onSecondary: () => void; // 企业＝检查更新，个人＝同步企业知识
}

export default function KnowledgeDetailModal({ selection, canEdit, appRole, orgUnits, onClose, onSaved, setNotice, downloadKnowledgeText, onAskAi, onDelete, onSecondary }: KnowledgeDetailModalProps) {
  const isEnterprise = selection.kind === "enterprise";
  const doc = isEnterprise ? selection.doc : null;
  const personal = !isEnterprise ? selection.item : null;

  const title = isEnterprise ? doc!.title : personal!.title;
  const content = isEnterprise ? (doc!.content || "") : personal!.content;
  const downloadName = isEnterprise ? (doc!.filename || doc!.title) : personal!.title;

  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(() =>
    isEnterprise
      ? { title: doc!.title, content: doc!.content || "", category: doc!.category, visibility: doc!.visibility, departmentId: doc!.departmentId ? String(doc!.departmentId) : "", tags: doc!.tags, updateMode: doc!.updateMode, updateSchedule: doc!.updateSchedule }
      : { title: personal!.title, content: personal!.content, category: "", visibility: "", departmentId: "", tags: "", updateMode: "", updateSchedule: "" }
  );
  const set = (key: keyof typeof form, value: string) => setForm(prev => ({ ...prev, [key]: value }));

  const metaLine = isEnterprise
    ? `${doc!.category} · ${doc!.visibility} · V${doc!.version} · ${doc!.status}`
    : `${personal!.sourceType} · ${personal!.syncStatus}`;

  async function save() {
    if (!form.title.trim()) return setNotice("资料名称不能为空。");
    if (!form.content.trim()) return setNotice("资料内容不能为空。");
    setSaving(true);
    try {
      let response: Response;
      if (isEnterprise) {
        const payload: Record<string, unknown> = {
          id: doc!.id,
          action: "edit",
          title: form.title.trim(),
          content: form.content,
          category: form.category,
          visibility: form.visibility,
          tags: form.tags,
          updateMode: form.updateMode,
          updateSchedule: form.updateSchedule,
        };
        if (appRole === "管理员" && form.visibility === "部门") payload.departmentId = Number(form.departmentId) || null;
        response = await fetch("/api/state", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      } else {
        response = await fetch("/api/personal-knowledge", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: personal!.id, action: "edit", title: form.title.trim(), content: form.content }) });
      }
      const data = await response.json();
      if (!response.ok) return setNotice(data.error || "保存失败");
      setNotice(data.message || "已保存修改。");
      await onSaved();
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return <div className="modalBackdrop" onMouseDown={() => { if (!saving) onClose(); }}>
    <div className="modal knowledgeViewer knowledgeDetailModal" onMouseDown={e => e.stopPropagation()}>
      <div className="modalHead">
        <div><h2>{editing ? "编辑知识" : title}</h2><p>{metaLine}</p></div>
        <button type="button" disabled={saving} onClick={onClose}>×</button>
      </div>

      {editing ? <div className="knowledgeEditForm">
        <label>资料名称<input value={form.title} disabled={saving} onChange={e => set("title", e.target.value)} /></label>
        {isEnterprise && <>
          <div className="uploadGrid">
            <label>业务分类<select value={form.category} disabled={saving} onChange={e => set("category", e.target.value)}>{CATEGORIES.map(x => <option key={x}>{x}</option>)}</select></label>
            <label>可见范围<select value={form.visibility} disabled={saving} onChange={e => set("visibility", e.target.value)}>{VISIBILITIES.map(x => <option key={x}>{x}</option>)}</select></label>
          </div>
          {appRole === "管理员" && form.visibility === "部门" && <label>所属部门<select value={form.departmentId} disabled={saving} onChange={e => set("departmentId", e.target.value)}><option value="">请选择部门</option>{orgUnits.map(unit => <option key={unit.id} value={unit.id}>{unit.name}</option>)}</select></label>}
          <div className="uploadGrid">
            <label>更新方式<select value={form.updateMode} disabled={saving} onChange={e => set("updateMode", e.target.value)}>{UPDATE_MODES.map(x => <option key={x}>{x}</option>)}</select></label>
            <label>标签<input value={form.tags} disabled={saving} placeholder="例如：产品A, 华东区, 2026" onChange={e => set("tags", e.target.value)} /></label>
          </div>
          <label>更新说明<input value={form.updateSchedule} disabled={saving} placeholder="例如：每周一 09:00 检查官网，变化后由负责人确认发布" onChange={e => set("updateSchedule", e.target.value)} /></label>
        </>}
        <label>资料内容<textarea rows={12} value={form.content} disabled={saving} onChange={e => set("content", e.target.value)} /><small>{isEnterprise ? "改动正文后版本号会 +1。" : "改动后仅更新个人副本。"}</small></label>
      </div> : <>
        <dl className="knowledgeDetailMeta">
          {isEnterprise ? <>
            <div><dt>业务分类</dt><dd>{doc!.category}</dd></div>
            <div><dt>可见范围</dt><dd>{doc!.visibility}</dd></div>
            <div><dt>版本</dt><dd>V{doc!.version}</dd></div>
            <div><dt>解析状态</dt><dd>{doc!.status}</dd></div>
            <div><dt>标签</dt><dd>{doc!.tags || "—"}</dd></div>
            <div><dt>更新方式</dt><dd>{doc!.updateMode}{doc!.updateSchedule ? ` · ${doc!.updateSchedule}` : ""}</dd></div>
            <div><dt>文件</dt><dd>{doc!.filename || "在线文本"}{doc!.sizeBytes ? ` · ${Math.max(1, Math.round(doc!.sizeBytes / 1024))}KB` : ""}</dd></div>
            <div><dt>创建者</dt><dd>{doc!.createdBy}</dd></div>
            <div><dt>更新时间</dt><dd>{new Date(doc!.updatedAt).toLocaleString("zh-CN")}</dd></div>
          </> : <>
            <div><dt>来源</dt><dd>{personal!.sourceType}</dd></div>
            <div><dt>同步状态</dt><dd>{personal!.syncStatus}</dd></div>
            <div><dt>更新时间</dt><dd>{new Date(personal!.updatedAt).toLocaleString("zh-CN")}</dd></div>
          </>}
        </dl>
        <pre>{content || "暂无可查看正文。上传型非文本文件请下载文件查看。"}</pre>
      </>}

      <div className="modalActions">
        {editing ? <>
          <button type="button" className="outline" disabled={saving} onClick={() => setEditing(false)}>取消</button>
          <button type="button" disabled={saving} onClick={save}>{saving ? "保存中…" : "保存修改"}</button>
        </> : <>
          <button type="button" className="outline" onClick={onClose}>关闭</button>
          <button type="button" className="outline" onClick={() => { onDelete(); onClose(); }} style={canEdit ? undefined : { display: "none" }}>删除</button>
          <button type="button" className="outline" onClick={onSecondary}>{isEnterprise ? "检查更新" : "同步企业知识"}</button>
          <button type="button" className="outline" onClick={() => downloadKnowledgeText(downloadName, content)}>下载文件</button>
          {canEdit && <button type="button" className="outline" onClick={() => setEditing(true)}>编辑</button>}
          <button type="button" onClick={() => { onAskAi(); onClose(); }}>让AI调用</button>
        </>}
      </div>
    </div>
  </div>;
}
