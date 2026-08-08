"use client";

import { FormEvent, useMemo, useState } from "react";
import { AdminSystemPanel } from "../../FeaturePanels";
import type { ManagedUser } from "../shared-types";
import { PlusIcon, RefreshIcon, WaveIcon, BellIcon, ClipboardIcon, MessageIcon, TrashIcon, SparklesIcon, DiamondIcon } from "../../components/icons";

export interface UsersPanelProps {
  users: ManagedUser[];
  setNotice: (message: string) => void;
  loadSession: () => Promise<void>;
}

type RoleFilter = "全部" | "管理员" | "普通员工";

function avatarColor(email: string) {
  const palette = ["#08765a", "#4a90e2", "#b87a00", "#c0392b", "#7c3aed", "#0d9488", "#db2777", "#ea580c"];
  let hash = 0;
  for (let i = 0; i < email.length; i++) hash = (hash * 31 + email.charCodeAt(i)) >>> 0;
  return palette[hash % palette.length];
}

function avatarLabel(email: string) {
  const local = email.split("@")[0] || email;
  return local.slice(0, 1).toUpperCase();
}

function formatDate(value: string) {
  try {
    return new Date(value).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  } catch {
    return value;
  }
}

function daysAgo(value: string) {
  try {
    const diff = Date.now() - new Date(value).getTime();
    const days = Math.floor(diff / 86_400_000);
    if (days <= 0) return "今日新增";
    if (days === 1) return "昨天";
    if (days < 7) return `${days} 天前`;
    if (days < 30) return `${Math.floor(days / 7)} 周前`;
    return `${Math.floor(days / 30)} 月前`;
  } catch {
    return "-";
  }
}

export default function UsersPanel({ users, setNotice, loadSession }: UsersPanelProps) {
  const [keyword, setKeyword] = useState("");
  const [roleFilter, setRoleFilter] = useState<RoleFilter>("全部");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const stats = useMemo(() => {
    const total = users.length;
    const admin = users.filter(u => u.role === "管理员").length;
    const employee = total - admin;
    const recent = users.filter(u => {
      try { return Date.now() - new Date(u.createdAt).getTime() < 7 * 86_400_000; } catch { return false; }
    }).length;
    return { total, admin, employee, recent };
  }, [users]);

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    return users
      .filter(u => roleFilter === "全部" ? true : u.role === roleFilter)
      .filter(u => !kw || u.email.toLowerCase().includes(kw))
      .slice()
      .sort((a, b) => {
        if (a.role !== b.role) return a.role === "管理员" ? -1 : 1;
        try { return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(); } catch { return 0; }
      });
  }, [users, keyword, roleFilter]);

  const allSelected = filtered.length > 0 && filtered.every(u => selected.has(u.email));
  const someSelected = filtered.some(u => selected.has(u.email));

  function toggle(email: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(email)) next.delete(email);
      else next.add(email);
      return next;
    });
  }
  function toggleAll() {
    setSelected(prev => {
      if (allSelected) return new Set();
      const next = new Set(prev);
      filtered.forEach(u => next.add(u.email));
      return next;
    });
  }

  async function saveUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget).entries());
    if (!values.email) return;
    setBusy(true);
    const response = await fetch("/api/users", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(values) });
    const data = await response.json();
    setNotice(response.ok ? data.message || "账号角色已保存" : data.error || "保存失败");
    if (response.ok) { event.currentTarget.reset(); await loadSession(); }
    setBusy(false);
  }

  async function removeUser(email: string) {
    if (typeof window !== "undefined" && !window.confirm(`确认删除账号 ${email} ？`)) return;
    setBusy(true);
    const response = await fetch("/api/users", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ emails: [email] }) });
    const data = await response.json();
    setNotice(response.ok ? data.message || "账号已删除" : data.error || "删除失败");
    if (response.ok) {
      setSelected(prev => { const next = new Set(prev); next.delete(email); return next; });
      await loadSession();
    }
    setBusy(false);
  }

  async function removeSelected() {
    if (!selected.size) return;
    const emails = Array.from(selected);
    if (typeof window !== "undefined" && !window.confirm(`确认批量删除 ${emails.length} 个账号？`)) return;
    setBusy(true);
    const response = await fetch("/api/users", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ emails }) });
    const data = await response.json();
    setNotice(response.ok ? data.message || "账号已删除" : data.error || "删除失败");
    if (response.ok) {
      setSelected(new Set());
      await loadSession();
    }
    setBusy(false);
  }

  async function promote(email: string) {
    setBusy(true);
    const response = await fetch("/api/users", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, role: "管理员" }) });
    const data = await response.json();
    setNotice(response.ok ? `${email} 已设为管理员` : data.error || "角色调整失败");
    if (response.ok) await loadSession();
    setBusy(false);
  }

  async function demote(email: string) {
    setBusy(true);
    const response = await fetch("/api/users", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, role: "普通员工" }) });
    const data = await response.json();
    setNotice(response.ok ? `${email} 已降为普通员工` : data.error || "角色调整失败");
    if (response.ok) await loadSession();
    setBusy(false);
  }

  return <section className="contentPanel pageFill usersPage">
    <header className="usersHeader">
      <div className="usersHeaderInfo">
        <h2>账号管理</h2>
        <p>管理企业内所有员工的账号与系统角色，决定谁能进入控制台、谁能配置系统。系统邮件（SMTP）也在这里维护，所有通知邮件都会通过该设置发出。</p>
      </div>
      <div className="usersHeaderStats">
        <div className="usersStat total">
          <WaveIcon style={{ width: 14, height: 14 }} />
          <div><b>{stats.total}</b><small>账号总数</small></div>
        </div>
        <div className="usersStat admin">
          <DiamondIcon style={{ width: 14, height: 14 }} />
          <div><b>{stats.admin}</b><small>管理员</small></div>
        </div>
        <div className="usersStat employee">
          <MessageIcon style={{ width: 14, height: 14 }} />
          <div><b>{stats.employee}</b><small>普通员工</small></div>
        </div>
        <div className="usersStat recent">
          <SparklesIcon style={{ width: 14, height: 14 }} />
          <div><b>{stats.recent}</b><small>7 天内新增</small></div>
        </div>
      </div>
      <div className="usersHeaderActions">
        <button className="outline" type="button" disabled={busy} onClick={() => { void loadSession(); }}>
          <RefreshIcon style={{ width: 12, height: 12 }} /> 刷新列表
        </button>
        <button className="outline" type="button" disabled={busy || !someSelected} onClick={removeSelected}>
          <TrashIcon style={{ width: 12, height: 12 }} /> 批量删除 · {selected.size}
        </button>
      </div>
    </header>

    <div className="usersToolbar">
      <form className="usersAddForm" onSubmit={saveUser}>
        <div className="usersAddField usersAddFieldEmail">
          <label>员工邮箱</label>
          <input name="email" type="email" required placeholder="name@company.com" />
        </div>
        <div className="usersAddField">
          <label>系统角色</label>
          <select name="role" defaultValue="普通员工">
            <option>普通员工</option>
            <option>管理员</option>
          </select>
        </div>
        <button className="primary" type="submit" disabled={busy}>
          <PlusIcon style={{ width: 12, height: 12 }} /> 添加或更新账号
        </button>
      </form>
    </div>

    <div className="usersFilterBar">
      <div className="usersSearch">
        <input value={keyword} onChange={event => setKeyword(event.target.value)} placeholder="按邮箱搜索…" />
        {keyword && <button type="button" className="usersSearchClear" onClick={() => setKeyword("")}>×</button>}
      </div>
      <div className="usersFilterTabs" role="tablist">
        {(["全部", "管理员", "普通员工"] as RoleFilter[]).map(option => (
          <button
            key={option}
            type="button"
            role="tab"
            aria-selected={roleFilter === option}
            className={roleFilter === option ? "isActive" : ""}
            onClick={() => setRoleFilter(option)}
          >
            {option}
            <span className="usersFilterCount">{option === "全部" ? stats.total : option === "管理员" ? stats.admin : stats.employee}</span>
          </button>
        ))}
      </div>
      <div className="usersFilterInfo">
        <BellIcon style={{ width: 12, height: 12 }} />
        <span>显示 {filtered.length} / {users.length}</span>
      </div>
    </div>

    <div className="pageScroll">
      <div className="usersTable">
        <div className="usersTableHead">
          <label className="usersTableCheck">
            <input type="checkbox" checked={allSelected} onChange={toggleAll} />
          </label>
          <span>账号</span>
          <span>系统角色</span>
          <span>加入时间</span>
          <span>距今</span>
          <span className="usersTableActions">操作</span>
        </div>
        {filtered.length === 0 && <div className="usersEmpty">
          <ClipboardIcon style={{ width: 28, height: 28 }} />
          <h3>没有匹配的账号</h3>
          <p>{keyword ? `没有邮箱包含 "${keyword}" 的账号` : "该角色下还没有任何账号"}</p>
        </div>}
        {filtered.map(user => {
          const isAdmin = user.role === "管理员";
          const checked = selected.has(user.email);
          return <div key={user.email} className={`usersTableRow ${checked ? "isSelected" : ""} ${isAdmin ? "isAdmin" : "isEmployee"}`}>
            <label className="usersTableCheck">
              <input type="checkbox" checked={checked} onChange={() => toggle(user.email)} />
            </label>
            <div className="usersTableAccount">
              <span className="usersAvatar" style={{ background: avatarColor(user.email) }}>{avatarLabel(user.email)}</span>
              <div className="usersAccountText">
                <strong>{user.email}</strong>
                <code>{user.email.split("@")[1] || ""}</code>
              </div>
            </div>
            <div className="usersTableRole">
              <span className={`usersRoleBadge ${isAdmin ? "isAdmin" : "isEmployee"}`}>
                <span className="usersRoleDot" />
                {user.role}
              </span>
            </div>
            <div className="usersTableTime">{formatDate(user.createdAt)}</div>
            <div className="usersTableAgo"><span className="usersAgoTag">{daysAgo(user.createdAt)}</span></div>
            <div className="usersTableActions">
              {isAdmin
                ? <button className="outline" type="button" disabled={busy} onClick={() => demote(user.email)}>降为员工</button>
                : <button className="outline" type="button" disabled={busy} onClick={() => promote(user.email)}>提升为管理员</button>}
              <button className="ghost" type="button" disabled={busy} onClick={() => removeUser(user.email)} aria-label="删除账号">
                <TrashIcon style={{ width: 12, height: 12 }} />
              </button>
            </div>
          </div>;
        })}
      </div>

      <div className="usersSmtpWrap">
        <AdminSystemPanel setNotice={setNotice} />
      </div>
    </div>
  </section>;
}
