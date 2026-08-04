"use client";

import { FormEvent, useState } from "react";
import { log } from "./features/logger";

export function LoginAuthCard({ initialAdminOnly = false }: { initialAdminOnly?: boolean }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [notice, setNotice] = useState("");
  const adminOnly = initialAdminOnly;
  const title = adminOnly ? "后台管理员登录" : "企业用户登录";

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

  async function requestCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNotice("正在发送验证码…");
    const values = Object.fromEntries(new FormData(event.currentTarget).entries());
    log.info("注册验证码请求", { email: values.email });
    const response = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "requestCode", ...values }),
    });
    const data = await response.json().catch(() => ({}));
    setNotice(response.ok ? data.message || "验证码已发送。" : data.error || "验证码发送失败。");
    if (response.ok) log.info("验证码已发送", { email: values.email });
    else log.warn("验证码发送失败", { email: values.email, error: data.error });
  }

  async function verify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNotice("正在完成注册…");
    const values = Object.fromEntries(new FormData(event.currentTarget).entries());
    log.info("注册验证", { email: values.email });
    const response = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "verify", ...values }),
    });
    const data = await response.json().catch(() => ({}));
    setNotice(response.ok ? data.message || "注册成功，请登录。" : data.error || "注册失败。");
    if (response.ok) { log.info("注册成功", { email: values.email }); setMode("login"); }
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
          <div className="authRegisterGrid">
            <form onSubmit={requestCode} className="featureForm">
              <label>
                邮箱
                <input name="email" type="email" required placeholder="name@company.com" />
              </label>
              <button type="submit">发送验证码</button>
            </form>
            <form onSubmit={verify} className="featureForm">
              <label>
                邮箱
                <input name="email" type="email" required placeholder="name@company.com" />
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
                <input name="password" type="password" required minLength={8} />
              </label>
              <button type="submit">完成注册</button>
            </form>
          </div>
        )}

        {notice && <p className="noticeLine">{notice}</p>}
        <small>邮箱登录使用验证码激活；管理员登录必须拥有管理员角色。</small>
      </section>
  );
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
