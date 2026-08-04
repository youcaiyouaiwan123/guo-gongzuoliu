"use client";

import { useEffect } from "react";
import { log } from "../features/logger";

/** 前端日志初始化组件：在每个页面加载时记录页面基本信息 */
export default function LoggerProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    log.info("页面加载", {
      url: window.location.pathname + window.location.search,
      referrer: document.referrer.slice(0, 200) || "(无)",
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      language: navigator.language,
    });
    // 记录页面卸载
    const handleBeforeUnload = () => {
      log.info("页面卸载", { url: window.location.pathname });
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, []);

  return <>{children}</>;
}