import type { Metadata } from "next";
import "./styles/base.css";
import "./styles/chat.css";
import "./styles/modules.css";
import "./styles/panels.css";
import "./styles/brand.css";
import "./styles/console.css";
import "./styles/media.css";
import "./styles/artifacts.css";
import "./styles/collection.css";
import "./styles/organization.css";
import "./styles/page-fill.css";
import LoggerProvider from "./components/LoggerProvider";

export const metadata: Metadata = {
  title: "海芯博创｜企业智能中台",
  description: "嘉兴海芯博创科技有限公司企业智能中台。",
  icons: { icon: "/haixin-bochuang-logo.png", shortcut: "/haixin-bochuang-logo.png" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body><LoggerProvider>{children}</LoggerProvider></body></html>;
}
