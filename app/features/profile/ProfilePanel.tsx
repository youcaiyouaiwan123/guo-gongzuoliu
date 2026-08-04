"use client";

import { FormEvent } from "react";
import type { ProfileInfo, Role } from "../shared-types";

type PasswordForm = { currentPassword: string; newPassword: string; confirmPassword: string };

export interface ProfilePanelProps {
  profileInfo: ProfileInfo | null;
  userEmail: string;
  displayName: string;
  appRole: string;
  role: Role;
  passwordForm: PasswordForm;
  setPasswordForm: React.Dispatch<React.SetStateAction<PasswordForm>>;
  setNotice: (message: string) => void;
}

export default function ProfilePanel({ profileInfo, userEmail, displayName, appRole, role, passwordForm, setPasswordForm, setNotice }: ProfilePanelProps) {
  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (passwordForm.newPassword !== passwordForm.confirmPassword) return setNotice("两次输入的新密码不一致");
    const response = await fetch("/api/profile", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "changePassword", ...passwordForm }) });
    const data = await response.json();
    setNotice(response.ok ? data.message || "密码已更新" : data.error || "修改密码失败");
    if (response.ok) {
      setPasswordForm({ currentPassword: "", newPassword: "", confirmPassword: "" });
      // 服务端改密时已撤销该账号的全部会话，因此必须回到登录页重新认证。
      window.setTimeout(() => window.location.assign("/login"), 800);
    }
  }

  return <section className="contentPanel"><div className="profileInlineStatus"><span className="policyBadge">{profileInfo?.passwordConfigured ? "已设置密码" : "未设置密码"}</span></div><div className="profileSummary"><article><span>账号邮箱</span><b>{profileInfo?.email || userEmail}</b><small>{profileInfo?.name || displayName}</small></article><article><span>系统角色</span><b>{profileInfo?.role || appRole}</b><small>{profileInfo?.businessRole || role}</small></article><article><span>密码状态</span><b>{profileInfo?.passwordConfigured ? "已启用" : "待设置"}</b><small>{profileInfo?.passwordUpdatedAt ? `最近更新：${new Date(profileInfo.passwordUpdatedAt).toLocaleString("zh-CN")}` : "设置后将写入审计日志"}</small></article></div><form className="profileForm" onSubmit={changePassword}><label>当前密码<input type="password" value={passwordForm.currentPassword} onChange={event=>setPasswordForm({...passwordForm,currentPassword:event.target.value})} placeholder={profileInfo?.passwordConfigured ? "请输入当前密码" : "首次设置可留空"}/></label><label>新密码<input type="password" value={passwordForm.newPassword} onChange={event=>setPasswordForm({...passwordForm,newPassword:event.target.value})} placeholder="至少 8 位"/></label><label>确认新密码<input type="password" value={passwordForm.confirmPassword} onChange={event=>setPasswordForm({...passwordForm,confirmPassword:event.target.value})} placeholder="再次输入新密码"/></label><button type="submit">保存密码</button></form></section>;
}
