"use client";

import { useState } from "react";
import type { Connector, ModelStatus } from "../shared-types";
import { createGatewaySecret } from "../constants";
import { adaptGatewayConfigToCurrentOrigin, connectorClassName, copyGatewayText, formatConnectorTime, formatModelOption, gatewayEnvLine, gatewayStartCommand } from "../shared-utils";
import { RefreshIcon, WaveIcon, MessageIcon, ClipboardIcon, PlayIcon, InboxIcon } from "../../components/icons";

type ConnectorLiveTest = { phrase: string; startedAt: string; result?: string };
type ConnectorTab = "platform" | "gateway" | "model";

export interface ConnectorsPanelProps {
  connectors: Connector[];
  setConnectors: React.Dispatch<React.SetStateAction<Connector[]>>;
  testingConnector: string;
  setTestingConnector: React.Dispatch<React.SetStateAction<string>>;
  setConnectorMode: React.Dispatch<React.SetStateAction<"callback" | "long_connection">>;
  setGatewaySecret: React.Dispatch<React.SetStateAction<string>>;
  setConnectorHelp: React.Dispatch<React.SetStateAction<Connector | null>>;
  connectorLiveTests: Record<string, ConnectorLiveTest>;
  setConnectorLiveTests: React.Dispatch<React.SetStateAction<Record<string, ConnectorLiveTest>>>;
  savingConnectorModel: string;
  setSavingConnectorModel: React.Dispatch<React.SetStateAction<string>>;
  connectorModelDrafts: Record<string, string>;
  setConnectorModelDrafts: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  modelStatus: ModelStatus | null;
  setNotice: (message: string) => void;
  loadConnectors: () => Promise<void>;
}

export default function ConnectorsPanel({ connectors, setConnectors, testingConnector, setTestingConnector, setConnectorMode, setGatewaySecret, setConnectorHelp, connectorLiveTests, setConnectorLiveTests, savingConnectorModel, setSavingConnectorModel, connectorModelDrafts, setConnectorModelDrafts, modelStatus, setNotice, loadConnectors }: ConnectorsPanelProps) {
  const [tab, setTab] = useState<ConnectorTab>("platform");
  const platformDefs: Array<[Connector["id"], string, string, string]> = [
    ["feishu", "飞书", "飞", "机器人收发消息、身份映射、知识问答"],
    ["dingtalk", "钉钉", "钉", "群机器人、工作通知和员工身份"],
    ["wecom", "企业微信", "微", "应用消息、通讯录身份和客户联系"],
  ];
  const platformById = Object.fromEntries(connectors.map(item => [item.id, item])) as Record<string, Connector>;
  const configuredCount = connectors.filter(item => item.configured).length;
  const liveCount = connectors.filter(item => {
    if (!item.configured) return false;
    return item.connectionMode === "long_connection" ? Boolean(item.gatewayOnline) : Boolean(item.lastMessageAt);
  }).length;
  const totalInbound = connectors.reduce((sum, item) => sum + (item.gatewayInboundCount || 0), 0);
  const totalOutbound = connectors.reduce((sum, item) => sum + (item.gatewayOutboundCount || 0), 0);

  function modelModeLabel(mode?: string) {
    if (!mode || mode === "auto") return "自动选择";
    if (mode === "enterprise" || mode === "public") return "企业公共模型";
    if (mode === "none") return "不调用模型";
    if (mode.startsWith("connection:")) {
      const connection = modelStatus?.connections?.find(item => `connection:${item.id}` === mode);
      return connection ? formatModelOption(connection) : "指定第三方模型";
    }
    return mode;
  }

  const robotModelModeOptions = <>
    <option value="auto">自动选择（个人最新模型 → 企业公共模型）</option>
    <option value="enterprise">固定使用企业公共模型</option>
    {modelStatus?.connections?.map(model => <option key={model.id} value={`connection:${model.id}`}>{formatModelOption(model)}</option>)}
  </>;

  function gatewayAllEnvLine() {
    const accounts = connectors
      .filter(item => item.configured && item.connectionMode === "long_connection" && item.gatewayConfig)
      .map(item => {
        try {
          return JSON.parse(adaptGatewayConfigToCurrentOrigin(item.gatewayConfig));
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    return accounts.length ? `HAIXIN_ACCOUNTS_JSON=${JSON.stringify(accounts)}` : "";
  }

  function gatewayWriteAndRestartCommand() {
    const envLine = gatewayAllEnvLine();
    if (!envLine) return gatewayStartCommand();
    const encoded = typeof btoa === "function" ? btoa(unescape(encodeURIComponent(envLine))) : "";
    return [
      "cd /opt/haixin-ai/current",
      "python3 - <<'PY'",
      "from pathlib import Path",
      "import base64",
      `line = base64.b64decode("${encoded}").decode()`,
      `env = Path("/opt/haixin-ai/shared/.env")`,
      `env.parent.mkdir(parents=True, exist_ok=True)`,
      `lines = env.read_text(encoding="utf-8").splitlines() if env.exists() else []`,
      `lines = [x for x in lines if not x.startswith("HAIXIN_ACCOUNTS_JSON=")]`,
      `lines.append(line)`,
      `env.write_text("\\n".join(lines) + "\\n", encoding="utf-8")`,
      `print("HAIXIN_ACCOUNTS_JSON written to /opt/haixin-ai/shared/.env")`,
      "PY",
      "docker compose --env-file /opt/haixin-ai/shared/.env -f docker-compose.server.yml -p haixin up -d channel-gateway",
      "docker compose --env-file /opt/haixin-ai/shared/.env -f docker-compose.server.yml -p haixin logs -f channel-gateway",
    ].join("\n");
  }

  async function testConnectorReal(item: Connector) {
    if (item.connectionMode === "long_connection") {
      // 一键自检：点击即由后端自动跑「凭证校验 → 网关在线 → 消息回复链路」三项，无需人工去平台发消息。
      setTestingConnector(item.id);
      setConnectorLiveTests(previous => ({ ...previous, [item.id]: { phrase: "一键自检", startedAt: new Date().toISOString(), result: "正在自检：校验凭证、网关与回复链路…" } }));
      setNotice(`正在对${item.name}机器人进行一键自检…`);
      try {
        const response = await fetch("/api/connectors", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "selfTest", platform: item.id }),
        });
        const data = await response.json();
        const detail: string = data.summary || data.message || (response.ok ? "自检完成" : "自检失败");
        setConnectorLiveTests(previous => ({ ...previous, [item.id]: { phrase: "一键自检", startedAt: previous[item.id]?.startedAt || new Date().toISOString(), result: detail } }));
        setNotice(data.message || (response.ok ? "自检完成" : "自检失败"));
        await loadConnectors();
      } catch (error) {
        const message = error instanceof Error ? error.message : `${item.name}自检失败`;
        setConnectorLiveTests(previous => ({ ...previous, [item.id]: { phrase: "一键自检", startedAt: previous[item.id]?.startedAt || new Date().toISOString(), result: message } }));
        setNotice(message);
      } finally {
        setTestingConnector("");
      }
      return;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 12000);
    try {
      setTestingConnector(item.id);
      const response = await fetch("/api/connectors", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ platform: item.id }), signal: controller.signal });
      const data = await response.json();
      setNotice(data.message || (response.ok ? "凭证测试成功；真实机器人回复仍以收到平台消息为准。" : "连接失败"));
    } catch (error) {
      setNotice(error instanceof DOMException && error.name === "AbortError" ? "凭证测试超时。请用真实发消息验收机器人是否能回复。" : error instanceof Error ? error.message : "连接失败");
    } finally {
      window.clearTimeout(timer);
      setTestingConnector("");
    }
  }

  async function saveConnectorModel(item: Connector, defaultModelMode: string) {
    try {
      setSavingConnectorModel(item.id);
      const response = await fetch("/api/connectors", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "setDefaultModel", platform: item.id, defaultModelMode }),
      });
      const data = await response.json();
      setNotice(data.message || (response.ok ? "机器人默认模型已保存，并已热同步通道网关服务" : "保存失败"));
      if (response.ok) {
        setConnectorModelDrafts(current => {
          const next = { ...current };
          delete next[item.id];
          return next;
        });
        await loadConnectors();
      }
    } finally {
      setSavingConnectorModel("");
    }
  }

  async function switchConnectorMode(item: Connector, connectionMode: "callback" | "long_connection") {
    const response = await fetch("/api/connectors", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "setConnectionMode", platform: item.id, connectionMode }),
    });
    const data = await response.json();
    setNotice(data.message || "接收方式已更新");
    if (response.ok) await loadConnectors();
  }

  function getPlatformItem(id: Connector["id"], fallbackName: string) {
    return platformById[id] || { id, name: fallbackName, configured: false, status: "未接入" } as Connector;
  }

  function renderPlatformCard(id: Connector["id"], name: string, mark: string, description: string) {
    const item: Connector = getPlatformItem(id, name);
    const receiving = Boolean(item.lastMessageAt);
    const live = item.connectionMode === "long_connection" ? Boolean(item.gatewayOnline) : receiving;
    const modeLabel = item.connectionMode === "long_connection" ? "常驻长连接" : item.connectionMode === "callback" ? "HTTP 回调" : "未配置";
    return <article key={id} className={`connectorCardNew ${live ? "isLive" : ""} ${item.configured ? "isConfigured" : "isPending"}`}>
      <header className="connectorCardNewHead">
        <div className="connectorCardNewLogo">
          <span className={`connectorLogo ${connectorClassName(String(id))}`}>{mark}</span>
          <div>
            <h3>{name}</h3>
            <p>{description}</p>
          </div>
        </div>
        <span className={`connectorCardNewStatus ${live ? "isOnline" : item.configured ? "isIdle" : "isOffline"}`}>
          <span className="connectorStatusDot" />
          {live ? "真实链路在线" : item.configured ? (item.callbackConfigured ? "仅凭证已保存" : "等待网关") : "未接入"}
        </span>
      </header>

      <div className="connectorCardNewMeta">
        <div><small>连接方式</small><b>{modeLabel}</b></div>
        {item.connectionMode === "long_connection" ? (
          <>
            <div><small>网关状态</small><b className={item.gatewayOnline ? "routeHealthy" : "routeWarning"}>{item.gatewayOnline ? "在线" : item.gatewayLastError ? "异常" : "离线"}</b></div>
            <div><small>消息统计</small><b>收 {item.gatewayInboundCount || 0} / 回 {item.gatewayOutboundCount || 0}</b></div>
          </>
        ) : (
          <div style={{ gridColumn: "span 2" }}><small>最近消息</small><b className={receiving ? "routeHealthy" : "routeWarning"}>{receiving ? new Date(item.lastMessageAt!).toLocaleString("zh-CN") : "尚未收到平台消息"}</b></div>
        )}
      </div>

      <div className="connectorCardNewActions">
        <button className="outline" onClick={() => { setConnectorMode(item.connectionMode || "long_connection"); setGatewaySecret(item.gatewaySecret || createGatewaySecret()); setConnectorHelp(item); }}>
          {item.configured ? "修改我的 API" : "填写我的 API"}
        </button>
        <button className="connectorTestBtn" disabled={!item.configured || testingConnector === id} onClick={() => testConnectorReal(item)}>
          {testingConnector === id ? <><InboxIcon style={{ width: 12, height: 12 }} /> 等待中…</> : <><PlayIcon style={{ width: 12, height: 12 }} /> {item.connectionMode === "long_connection" ? "发消息验收" : "测试凭证"}</>}
        </button>
        {item.configured && <button className="ghost" onClick={() => switchConnectorMode(item, item.connectionMode === "long_connection" ? "callback" : "long_connection")}>
          改用 {item.connectionMode === "long_connection" ? "HTTP 回调" : "长连接"}
        </button>}
      </div>
    </article>;
  }

  function renderGatewayPlatformStep(id: Connector["id"], platformName: string) {
    const item: Connector = getPlatformItem(id, platformName);
    const ready = Boolean(item.configured && item.connectionMode === "long_connection" && item.gatewayConfig);
    const envLine = ready ? gatewayEnvLine(item.gatewayConfig) : "";
    return <article key={id} className="gatewayConfigCard">
      <header>
        <span className={`connectorLogo ${connectorClassName(String(id))}`}>{platformName.slice(0, 1)}</span>
        <div>
          <strong>{platformName} · 网关账户配置</strong>
          <p>{ready ? "环境变量已就绪，可以直接复制到服务器。" : "尚未生成网关配置，请先填写 API 并保存为长连接。"}</p>
        </div>
        <span className={`gatewayConfigBadge ${ready ? "isReady" : "isPending"}`}>{ready ? "已就绪" : "未就绪"}</span>
      </header>
      {ready ? <>
        <div className="gatewayConfigMeta">
          <span><b>App ID</b><em>{item.appIdPreview || "未知"}</em></span>
          <span><b>保存时间</b><em>{formatConnectorTime(item.credentialsUpdatedAt)}</em></span>
          <span><b>网关状态</b><em className={item.gatewayOnline ? "routeHealthy" : "routeWarning"}>{item.gatewayOnline ? "在线" : "离线"}</em></span>
          <span><b>消息统计</b><em>收 {item.gatewayInboundCount || 0} / 回 {item.gatewayOutboundCount || 0}</em></span>
        </div>
        <code className="gatewayConfigCode">{envLine}</code>
        <div className="gatewayConfigActions">
          <button type="button" className="outline" onClick={() => copyGatewayText(envLine)}><ClipboardIcon style={{ width: 12, height: 12 }} /> 复制 {platformName} 环境配置</button>
          {!item.configured && <button type="button" className="outline" onClick={() => { setConnectorMode("long_connection"); setGatewaySecret(item.gatewaySecret || createGatewaySecret()); setConnectorHelp(item); }}>去填写 {platformName} API</button>}
        </div>
      </> : <div className="gatewayConfigEmpty">
        <p>请先到「平台接入」填写 {platformName} 的 App ID / App Secret，并保存为长连接。</p>
        <button type="button" className="outline" onClick={() => { setConnectorMode("long_connection"); setGatewaySecret(item.gatewaySecret || createGatewaySecret()); setConnectorHelp(item); }}>去填写 {platformName} API</button>
      </div>}
    </article>;
  }

  return <section className="contentPanel pageFill connectorsPage">
    <header className="connectorsHeader">
      <div className="connectorsHeaderInfo">
        <h2>平台接入</h2>
        <p>统一管理飞书、钉钉、企业微信的机器人接入、网关配置和默认模型。</p>
      </div>
      <div className="connectorsHeaderStats">
        <div><WaveIcon style={{ width: 14, height: 14 }} /><b>{liveCount}<span>/{platformDefs.length}</span></b><small>链路在线</small></div>
        <div><RefreshIcon style={{ width: 14, height: 14 }} /><b>{configuredCount}<span>/{platformDefs.length}</span></b><small>已配置</small></div>
        <div><MessageIcon style={{ width: 14, height: 14 }} /><b>{totalInbound + totalOutbound}</b><small>累计消息</small></div>
      </div>
      <button className="outline connectorsRefreshBtn" onClick={loadConnectors}><RefreshIcon style={{ width: 12, height: 12 }} /> 刷新状态</button>
    </header>

    <div className="connectorsTabs">
      <button className={tab === "platform" ? "active" : ""} onClick={() => setTab("platform")}>平台接入<span className="tabBadge">{configuredCount}/{platformDefs.length}</span></button>
      <button className={tab === "gateway" ? "active" : ""} onClick={() => setTab("gateway")}>通道网关<span className="tabBadge">{connectors.filter(c => c.connectionMode === "long_connection" && c.gatewayConfig).length}</span></button>
      <button className={tab === "model" ? "active" : ""} onClick={() => setTab("model")}>机器人模型<span className="tabBadge">{connectors.length}</span></button>
    </div>

    <div className="connectorsTabContent">
      {tab === "platform" && <div className="connectorsPlatformGrid">
        {platformDefs.map(([id, name, mark, desc]) => renderPlatformCard(id, name, mark, desc))}
        {Object.entries(connectorLiveTests).length > 0 && <div className="liveTestPanelInline">
          <div className="liveTestPanelHeader">
            <b>机器人一键自检</b>
            <span>点击「发消息验收」即自动完成：凭证校验 → 网关在线 → 消息回复链路，无需手动去平台发消息。</span>
          </div>
          {Object.entries(connectorLiveTests).map(([id, test]) => {
            const item = connectors.find(connector => connector.id === id);
            return <div className="liveTestRow" key={id}>
              <strong>{item?.name || id} · 自检结果</strong>
              <small className={test.result?.includes("通过") ? "routeHealthy" : "routeWarning"} style={{ whiteSpace: "pre-line" }}>{test.result || "正在自检…"}</small>
            </div>;
          })}
        </div>}
      </div>}

      {tab === "gateway" && <div className="connectorsGatewayLayout">
        <div className="gatewayPlatformGrid">
          {(["feishu", "dingtalk", "wecom"] as Connector["id"][]).map((id) => {
            const platformName = id === "feishu" ? "飞书" : id === "dingtalk" ? "钉钉" : "企业微信";
            return renderGatewayPlatformStep(id, platformName);
          })}
        </div>
        <div className="gatewayGlobalPanel">
          <div className="gatewayGlobalHeader">
            <b>全部已配置平台 · 统一环境变量</b>
            <p>把三平台合并为一条 <code>HAIXIN_ACCOUNTS_JSON</code>，避免单独复制时互相覆盖。</p>
          </div>
          <code className="gatewayGlobalCode">{gatewayAllEnvLine() || "暂无可合并的长连接平台配置"}</code>
          <button type="button" className="outline" disabled={!gatewayAllEnvLine()} onClick={() => copyGatewayText(gatewayAllEnvLine())}><ClipboardIcon style={{ width: 12, height: 12 }} /> 复制全部环境配置</button>
        </div>
        <div className="gatewayCommandRow">
          <article>
            <header><b>一键写入并重启网关</b><span>自动写入 /opt/haixin-ai/shared/.env 并重启 channel-gateway。</span></header>
            <code>{gatewayWriteAndRestartCommand()}</code>
            <button type="button" className="outline" onClick={() => copyGatewayText(gatewayWriteAndRestartCommand())}><ClipboardIcon style={{ width: 12, height: 12 }} /> 复制一键写入并重启命令</button>
          </article>
          <article>
            <header><b>只重启网关</b><span>如果 .env 已经写好，只重启服务即可。</span></header>
            <code>{gatewayStartCommand()}</code>
            <button type="button" className="outline" onClick={() => copyGatewayText(gatewayStartCommand())}><ClipboardIcon style={{ width: 12, height: 12 }} /> 复制只重启命令</button>
          </article>
        </div>
      </div>}

      {tab === "model" && <div className="robotModelGridNew">
        {connectors.map(item => {
          const draft = connectorModelDrafts[item.id] ?? item.defaultModelMode ?? "auto";
          const saved = item.defaultModelMode || "auto";
          const dirty = draft !== saved;
          return <article key={item.id} className="robotModelCardNew">
            <div className="robotModelCardNewHead">
              <span className={`connectorLogo ${connectorClassName(String(item.id))}`}>{item.name.slice(0, 1)}</span>
              <div>
                <h3>{item.name}机器人</h3>
                <p>{item.configured ? `${item.name}机器人单独选择模型，不影响其它平台，也不影响智能助手聊天。` : `请先在「平台接入」完成${item.name}平台接入。`}</p>
              </div>
              <span className={`robotModelStatus ${item.configured ? "isConfigured" : "isPending"}`}>{item.configured ? "已配置" : "未配置"}</span>
            </div>
            <label className="robotModelSelectLabel">
              <span>{item.name}机器人使用</span>
              <select disabled={!item.configured || savingConnectorModel === item.id} value={draft} onChange={event => setConnectorModelDrafts(current => ({ ...current, [item.id]: event.target.value }))}>
                {robotModelModeOptions}
              </select>
            </label>
            <div className="robotModelCardNewFooter">
              <small>当前生效：<b>{modelModeLabel(saved)}</b></small>
              <button type="button" className="primary" disabled={!item.configured || savingConnectorModel === item.id} onClick={() => saveConnectorModel(item, draft)}>
                {savingConnectorModel === item.id ? "保存并同步中…" : dirty ? "保存并同步网关" : "同步网关"}
              </button>
            </div>
          </article>;
        })}
      </div>}
    </div>
  </section>;
}
