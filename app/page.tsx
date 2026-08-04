import { cookies } from "next/headers";
import { env } from "cloudflare:workers";
import Console from "./Console";
import { LoginAuthCard } from "./AuthPage";

export const dynamic = "force-dynamic";
export const runtime = "edge";

type PageUser = { email: string; displayName?: string };

async function getEmailSessionUser(): Promise<PageUser | null> {
  try {
    const sessionId = (await cookies()).get("haixin_session")?.value;
    if (!sessionId) return null;
    if (!env.DB) return null;
    const row = await env.DB.prepare(`
      SELECT u.email, u.display_name AS displayName
      FROM login_sessions s
      JOIN frontend_users u ON u.email = s.email
      WHERE s.token = ? AND s.expires_at > ?
      LIMIT 1
    `).bind(sessionId, new Date().toISOString()).first<PageUser>();
    return row || null;
  } catch {
    return null;
  }
}

export default async function Home() {
  const user = await getEmailSessionUser();

  if (!user) {
    return (
      <main className="loginPage">
        <section className="loginBrand">
          <img className="loginLogo" src="/haixin-bochuang-logo.png" alt="海芯博创" />
          <p>海芯博创 · 企业智能中台</p>
          <h1>让企业知识、智能体和业务流程在安全边界内协同工作。</h1>
          <ul>
            <li>企业知识权限隔离</li>
            <li>关键操作全程审计</li>
            <li>模型密钥只保存在服务器</li>
          </ul>
        </section>
        <footer className="siteFooter loginFooter">嘉兴海芯博创科技有限公司</footer>
        <LoginAuthCard />
      </main>
    );
  }

  return <Console userEmail={user.email} displayName={user.displayName || user.email.split("@")[0]} />;
}
