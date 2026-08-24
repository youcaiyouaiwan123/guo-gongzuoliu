"use client";

import { FormEvent, useState } from "react";
import { log } from "./features/logger";

export function LoginAuthCard({ initialAdminOnly = false }: { initialAdminOnly?: boolean }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [notice, setNotice] = useState("");
  const [email, setEmail] = useState("");
  const [sendingCode, setSendingCode] = useState(false);
  const [pwd, setPwd] = useState("");
  const [confirmPwd, setConfirmPwd] = useState("");
  const adminOnly = initialAdminOnly;
  const title = adminOnly ? "后台管理员登录" : "企业用户登录";

  // 密码强度：按长度 + 字符类别（小写/大写/数字/符号）粗评，只做前端提示，不阻断后端校验。
  const strength = passwordStrength(pwd);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNotice("正在验证账号…");
    const values = Object.fromEntries(new FormData(event.currentTarget).entries());
    log.info("登录请求", { adminOnly, email: values.email });
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...values, adminOnly }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      log.warn("登录失败", { email: values.email, error: data.error });
      setNotice(data.error || "登录失败，请检查邮箱、密码或管理员权限。");
      return;
    }
    log.info("登录成功", { email: values.email, redirect: data.redirect });
    window.location.href = data.redirect || "/";
  }

  // 发送验证码：不再是独立表单，读共享的 email 状态即可，避免注册区出现两个邮箱框。
  async function requestCode() {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { setNotice("请先填写有效邮箱。"); return; }
    setSendingCode(true);
    setNotice("正在发送验证码…");
    log.info("注册验证码请求", { email });
    const response = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "requestCode", email: email.trim() }),
    });
    const data = await response.json().catch(() => ({}));
    setNotice(response.ok ? data.message || "验证码已发送。" : data.error || "验证码发送失败。");
    if (response.ok) log.info("验证码已发送", { email });
    else log.warn("验证码发送失败", { email, error: data.error });
    setSendingCode(false);
  }

  async function verify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget).entries());
    const password = String(values.password || "");
    if (password.length < 8) { setNotice("密码至少需要 8 位。"); return; }
    if (password !== String(values.confirmPassword || "")) { setNotice("两次输入的密码不一致。"); return; }
    setNotice("正在完成注册…");
    log.info("注册验证", { email: values.email });
    const response = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "verify", ...values }),
    });
    const data = await response.json().catch(() => ({}));
    setNotice(response.ok ? data.message || "注册成功，请登录。" : data.error || "注册失败。");
    if (response.ok) { log.info("注册成功", { email: values.email }); setEmail(""); setPwd(""); setConfirmPwd(""); setMode("login"); }
    else log.warn("注册失败", { email: values.email, error: data.error });
  }

  return (
      <section className="loginCard authCard authUnifiedCard">
        <div className="authCardHead">
          <h2>{title}</h2>
          <p>
            {adminOnly
              ? "管理员入口会校验后台权限，请使用管理员账号登录。"
              : "使用企业邮箱登录，或注册新的企业账号。"}
          </p>
        </div>
        {!adminOnly && (
          <div className="authTabsLine" role="tablist" aria-label="登录或注册">
            <button type="button" role="tab" aria-selected={mode === "login"} className={mode === "login" ? "active" : ""} onClick={() => setMode("login")}>
              邮箱登录
            </button>
            <button type="button" role="tab" aria-selected={mode === "register"} className={mode === "register" ? "active" : ""} onClick={() => setMode("register")}>
              邮箱注册
            </button>
          </div>
        )}

        {mode === "login" && (
          <form onSubmit={login} className="featureForm">
            <label>
              账号
              <input name="email" type="text" required placeholder={adminOnly ? "admin" : "邮箱或用户名"} />
            </label>
            <label>
              密码
              <input name="password" type="password" required placeholder="请输入密码" />
            </label>
            <button>{adminOnly ? "进入后台" : "登录系统"}</button>
          </form>
        )}

        {mode === "register" && (
          <form onSubmit={verify} className="featureForm authRegisterGrid">
            <label>
              邮箱
              <div className="emailWithAction">
                <input name="email" type="email" required placeholder="name@company.com" value={email} onChange={e => setEmail(e.target.value)} />
                <button type="button" className="ghostAction" disabled={sendingCode} onClick={requestCode}>{sendingCode ? "发送中…" : "发送验证码"}</button>
              </div>
            </label>
            <label>
              验证码
              <input name="code" required placeholder="6 位验证码" />
            </label>
            <label>
              姓名
              <input name="displayName" placeholder="可选" />
            </label>
            <label>
              密码
              <input name="password" type="password" required minLength={8} value={pwd} onChange={e => setPwd(e.target.value)} placeholder="至少 8 位" />
            </label>
            {pwd && <p className={`pwdStrength ${strength.level}`}><i /><span>密码强度：{strength.label}</span></p>}
            <label>
              确认密码
              <input name="confirmPassword" type="password" required minLength={8} value={confirmPwd} onChange={e => setConfirmPwd(e.target.value)} placeholder="再次输入密码" />
            </label>
            {confirmPwd && confirmPwd !== pwd && <p className="pwdMismatch">两次输入的密码不一致</p>}
            <button type="submit">完成注册</button>
          </form>
        )}

        {notice && <p className="noticeLine">{notice}</p>}
        <small>邮箱登录使用验证码激活；管理员登录必须拥有管理员角色。</small>
      </section>
  );
}

// 密码强度粗评：长度达标 + 命中的字符类别数，映射到 弱/中/强。仅前端提示用。
function passwordStrength(value: string): { level: "weak" | "medium" | "strong"; label: string } {
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^a-zA-Z0-9]/].filter(re => re.test(value)).length;
  if (value.length < 8 || classes <= 1) return { level: "weak", label: "弱（建议混合字母、数字与符号）" };
  if (value.length >= 12 && classes >= 3) return { level: "strong", label: "强" };
  return { level: "medium", label: "中" };
}

export default function AuthPage({ adminOnly = false }: { adminOnly?: boolean }) {
  const title = adminOnly ? "后台管理员登录" : "企业用户登录";

  return (
    <main className="loginPage authPage">
      <section className="loginBrand authHero">
        <img className="loginLogo" src="/haixin-bochuang-logo.png" alt="海芯博创" />
        <p>海芯博创 · 企业智能中台</p>
        <h1>{title}</h1>
      </section>
      <footer className="siteFooter loginFooter">嘉兴海芯博创科技有限公司</footer>
      <LoginAuthCard initialAdminOnly={adminOnly} />
    </main>
  );
}
