import AuthPage from "../AuthPage";

export const dynamic = "force-dynamic";
export const runtime = "edge";

export default function AdminLoginPage() {
  return <AuthPage adminOnly />;
}
