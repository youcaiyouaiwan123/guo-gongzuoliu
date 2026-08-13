"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { ArtifactUploadPanel, ContractsPanel, HelpPanel, MediaPanel, MonitoringPanel } from "./FeaturePanels";
import { createGatewaySecret, nav, readApiResult } from "./features/constants";
import { log, logMount, markStart, markEnd } from "./features/logger";
import SidebarNavigation from "./features/navigation/SidebarNavigation";
import { Pager } from "./features/Pager";
import {
  ArrowRightIcon, ArrowUpRightIcon, BellIcon, BoltIcon, ChevronDownIcon, ChevronLeftIcon,
  ChevronRightIcon, ChevronUpIcon, ClipboardIcon, DiamondIcon, InboxIcon, MessageIcon,
  PlayIcon, PlusIcon, RefreshIcon, TrashIcon, WaveIcon,
} from "./components/icons";
import type {
  Agent, AgentRun, Artifact, ApprovalRequest, ApprovalTarget, ChatApiMessage, ChatAttachment,
  CollectionRun, Connector, Conversation, Doc, Log, ManagedUser, Message, ModelConnection, ModelStatus,
  OrgMember, OrgReport, OrgUnit, Permission, PermissionCapability, PermissionCapabilityGroup, PermissionRoleSpec, PersonalKnowledge, ProfileInfo, PromptGuide, Role,
  SaveDraft, Source, Tab, TransferRequest, Workflow, WorkflowNode, WorkflowRun,
} from "./features/shared-types";
import {
  adaptGatewayConfigToCurrentOrigin, adaptUrlToCurrentOrigin, buildPermissionDrafts, formatFileSize,
  formatModelOption, normalizeUploadError, outputFormatLabel, targetStoreLabel,
} from "./features/shared-utils";

const KnowledgePanel = dynamic(() => import("./features/knowledge/KnowledgePanel"), { ssr: false });
const OrganizationPanel = dynamic(() => import("./features/organization/OrganizationPanel"), { ssr: false });
const AgentsPanel = dynamic(() => import("./features/agents/AgentsPanel"), { ssr: false });
const WorkflowsPanel = dynamic(() => import("./features/workflows/WorkflowsPanel"), { ssr: false });
const CollectionPanel = dynamic(() => import("./features/collection/CollectionPanel"), { ssr: false });
const ApprovalsPanel = dynamic(() => import("./features/approvals/ApprovalsPanel"), { ssr: false });
const PermissionsPanel = dynamic(() => import("./features/permissions/PermissionsPanel"), { ssr: false });
const AuditLogsPanel = dynamic(() => import("./features/logs/AuditLogsPanel"), { ssr: false });
const ModelsPanel = dynamic(() => import("./features/models/ModelsPanel"), { ssr: false });
const ConnectorsPanel = dynamic(() => import("./features/connectors/ConnectorsPanel"), { ssr: false });
const ProfilePanel = dynamic(() => import("./features/profile/ProfilePanel"), { ssr: false });
const UsersPanel = dynamic(() => import("./features/users/UsersPanel"), { ssr: false });
const SourcePasteZone = dynamic(() => import("./features/collection/SourcePasteZone"), { ssr: false });


export default function Console({ userEmail, displayName }: { userEmail: string; displayName: string }) {
  const [tab, setTab] = useState<Tab>("chat");
  const [hydrated, setHydrated] = useState(false);
  // 数据采集源表单：主选数据来源（sourceKind），只有「网页」才有直采/递归两种获取方式（webMethod）。
  // 其余来源手段唯一，不显示第二个下拉，提交时自动映射 collectorMode。
  const sourceKindMap: Record<string, string> = {
    "网页": "direct", // 默认，webMethod 可覆盖
    "JSON API": "api",
    "CSV文件": "direct",
    "图片/截图": "screenshot",
    "文本/粘贴": "paste",
    "MCP": "mcp",
  };
  const [sourceKind, setSourceKind] = useState("网页");
  // 粘贴数据改为受控：截图识别的结果要回填进来，非受控的 defaultValue 做不到。
  const [sampleData, setSampleData] = useState("");
  // 这三种来源不出网，地址、请求方式、爬取范围对它们都是干扰项。
  const isInlineSourceKind = ["图片/截图", "文本/粘贴", "MCP"].includes(sourceKind);
  const [webMethod, setWebMethod] = useState<"direct" | "crawler">("direct");
  const [role, setRole] = useState<Role>("普通员工");
  const [appRole, setAppRole] = useState("普通员工");
  const [messages, setMessages] = useState<Message[]>([{ who: "bot", text: "你好，我是海芯博创企业助手，你上传的企业资料会进入受控知识库；所有问答均记录审计日志。" }]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationId, setConversationId] = useState<number | null>(null);
  const [modelMode, setModelMode] = useState("auto");
  const [input, setInput] = useState("");
  const [knowledgeMode, setKnowledgeMode] = useState<"native" | "knowledge">("native");
  const [chatAttachments, setChatAttachments] = useState<ChatAttachment[]>([]);
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [askMode, setAskMode] = useState<"quick" | "guided" | "continuous">("quick");
  const [guide, setGuide] = useState({ role: "", task: "", context: "", constraint: "", format: "", example: "" });
  const [continuous, setContinuous] = useState({ name: "", loopType: "目标制", reviewMode: "明确标准", goal: "", triggerType: "手动触发", reviewStandard: "", stopCondition: "", maxLoops: "3", finalAction: "提交管理员审批", failureAction: "通知负责人", scheduleTime: "09:00", watchSourceType: "free", watchSourceRef: "", triggerCondition: "", checkInterval: "10" });
  const [busy, setBusy] = useState(false);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [personalKnowledge, setPersonalKnowledge] = useState<PersonalKnowledge[]>([]);
  const [knowledgeView, setKnowledgeView] = useState<"enterprise" | "personal">("enterprise");
  const [showPersonalKnowledge, setShowPersonalKnowledge] = useState(false);
  const [viewingKnowledge, setViewingKnowledge] = useState<{ title: string; content: string; meta: string; downloadName: string } | null>(null);
  const [logs, setLogs] = useState<Log[]>([]);
  const [selectedLogIds, setSelectedLogIds] = useState<number[]>([]);
  const [selectedConversationIds, setSelectedConversationIds] = useState<number[]>([]);
  const [selectedArtifactIds, setSelectedArtifactIds] = useState<number[]>([]);
  const [selectedKnowledgeIds, setSelectedKnowledgeIds] = useState<number[]>([]);
  const [selectedPersonalKnowledgeIds, setSelectedPersonalKnowledgeIds] = useState<number[]>([]);
  const [selectedAgentIds, setSelectedAgentIds] = useState<number[]>([]);
  const [selectedWorkflowIds, setSelectedWorkflowIds] = useState<number[]>([]);
  const [selectedSourceIds, setSelectedSourceIds] = useState<number[]>([]);
  const [selectedCollectionRunIds, setSelectedCollectionRunIds] = useState<number[]>([]);
  const [selectedModelConnectionIds, setSelectedModelConnectionIds] = useState<number[]>([]);
  const [showUpload, setShowUpload] = useState(false);
  const [uploadFiles, setUploadFiles] = useState<{ name: string; size: number; type: string }[]>([]);
  const [uploadMode, setUploadMode] = useState<"file" | "text">("file");
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [knowledgeQuery, setKnowledgeQuery] = useState("");
  const [knowledgeCategory, setKnowledgeCategory] = useState("全部分类");
  const [notice, setNotice] = useState("");
  const [modelStatus, setModelStatus] = useState<ModelStatus | null>(null);
  const [testingModel, setTestingModel] = useState(false);
  const [editingModel, setEditingModel] = useState<ModelConnection | null>(null);
  const [selectedPresetModels, setSelectedPresetModels] = useState<string[]>([]);
  const [presetApiKey, setPresetApiKey] = useState("");
  const [addingPresetModels, setAddingPresetModels] = useState(false);
  const [showCustomModel, setShowCustomModel] = useState(false);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentRuns, setAgentRuns] = useState<AgentRun[]>([]);
  const [activeAgent, setActiveAgent] = useState<Agent | null>(null);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [workflowRuns, setWorkflowRuns] = useState<WorkflowRun[]>([]);
  const [chatWorkflowId, setChatWorkflowId] = useState("");
  const [workflowLauncherCollapsed, setWorkflowLauncherCollapsed] = useState(true);
  const [insightCollapsed, setInsightCollapsed] = useState(true);
  const [workflowNodes, setWorkflowNodes] = useState<WorkflowNode[]>([
    { id: "input", type: "input", name: "填写本次任务" },
    { id: "ai", type: "ai", name: "AI处理", config: "根据输入生成完整、准确、可直接使用的结果" },
    { id: "output", type: "output", name: "查看结果" },
  ]);
  const [runWorkflow, setRunWorkflow] = useState<Workflow | null>(null);
  const [runInput, setRunInput] = useState("");
  const [selectedRun, setSelectedRun] = useState<WorkflowRun | null>(null);
  const [runningWorkflow, setRunningWorkflow] = useState(false);
  const [sources, setSources] = useState<Source[]>([]);
  const [collectionRuns, setCollectionRuns] = useState<CollectionRun[]>([]);
  const [selectedCollectionRun, setSelectedCollectionRun] = useState<CollectionRun | null>(null);
  const [runningSourceId, setRunningSourceId] = useState<number | null>(null);
  const [editingSource, setEditingSource] = useState<Source | null>(null);
  const [sourceDraft, setSourceDraft] = useState<Partial<Source> | null>(null);
  // 「自定义采集内容」两种布局都要用，但位置不同：出网来源排在地址之后，
  // 粘贴/截图/MCP 排在粘贴区之后（数据本身才是主输入）。抽出来避免两处 JSX 各抄一遍。
  const extractFieldsField = <label className="wide">自定义采集内容<textarea name="extractFields" rows={3} defaultValue={(editingSource?.extractFields ?? sourceDraft?.extractFields) || ""} placeholder="直接写你要抓什么，不是选择题。例如：抓商品名称、价格、规格、库存、详情页链接。留空则保存整页正文。"/><small>采集过程和失败原因进日志；知识库只保存这里要求的真实结果，抓不到就失败，不会把采集报告当结果。支持 data.list.title 这类点号路径。</small></label>;
  const [cleaningRules, setCleaningRules] = useState<string[]>(["trim", "blank", "dedupe"]);
  const [cleanedPreview, setCleanedPreview] = useState("");
  const [showCleaning, setShowCleaning] = useState(false);
  const [localCleaningFile, setLocalCleaningFile] = useState({ name: "", raw: "" });
  const [localCleaningBusy, setLocalCleaningBusy] = useState(false);
  const [modalType, setModalType] = useState<"agent" | "workflow" | "source" | null>(null);
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [connectorHelp, setConnectorHelp] = useState<Connector | null>(null);
  const [connectorMode, setConnectorMode] = useState<"callback" | "long_connection">("callback");
  const [gatewaySecret, setGatewaySecret] = useState("");
  const [testingConnector, setTestingConnector] = useState("");
  const [savingConnectorModel, setSavingConnectorModel] = useState("");
  const [connectorModelDrafts, setConnectorModelDrafts] = useState<Record<string, string>>({});
  const [connectorLiveTests, setConnectorLiveTests] = useState<Record<string, { phrase: string; startedAt: string; result?: string }>>({});
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [approvalTargets, setApprovalTargets] = useState<ApprovalTarget[]>([]);
  const [permissions, setPermissions] = useState<Permission[]>([]);
  // 能力项目录由后端 /api/capabilities 提供，避免前端再硬编码一份导致与 _capabilities.ts 漂移。
  const [capabilityCatalog, setCapabilityCatalog] = useState<PermissionCapability[]>([]);
  // 分组元数据（标题/描述/keys）也由 /api/capabilities 同包下发，前端只补图标。
  const [capabilityGroups, setCapabilityGroups] = useState<PermissionCapabilityGroup[]>([]);
  // 角色规格（label/description/locked/defaultDecision）由 /api/capabilities 同包下发。
  const [permissionRoles, setPermissionRoles] = useState<PermissionRoleSpec[]>([]);
  // 业务规则：员工也允许采集 collect_data，由后端决定。
  const [permissionDrafts, setPermissionDrafts] = useState<Record<string, string>>({});
  const [permissionDirty, setPermissionDirty] = useState(false);
  const [profileInfo, setProfileInfo] = useState<ProfileInfo | null>(null);
  const [passwordForm, setPasswordForm] = useState({ currentPassword: "", newPassword: "", confirmPassword: "" });
  const [showApproval, setShowApproval] = useState(false);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [artifactResources, setArtifactResources] = useState<Artifact[]>([]);
  const [artifactsPage, setArtifactsPage] = useState(1);
  const [artifactsTotal, setArtifactsTotal] = useState(0);
  const [artifactCounts, setArtifactCounts] = useState({ total: 0, markdown: 0, skill: 0 });
  const [artifactOwners, setArtifactOwners] = useState<string[]>([]);
  const ARTIFACTS_PAGE_SIZE = 20;
  const [saveDraft, setSaveDraft] = useState<SaveDraft | null>(null);
  const [artifactOwner, setArtifactOwner] = useState("全部用户");
  const [orgUnits, setOrgUnits] = useState<OrgUnit[]>([]);
  const [orgMembers, setOrgMembers] = useState<OrgMember[]>([]);
  const [orgOwner, setOrgOwner] = useState("");
  const [transfers, setTransfers] = useState<TransferRequest[]>([]);
  const [orgReports, setOrgReports] = useState<OrgReport[]>([]);
  const [myMember, setMyMember] = useState<OrgMember | null>(null);
  const [reportRecipients, setReportRecipients] = useState<string[]>([]);
  const [reminders, setReminders] = useState({ approvals: 0, reports: 0 });
  const [orgModal, setOrgModal] = useState<"unit" | "member" | "transfer" | "report" | null>(null);
  const [editingMember, setEditingMember] = useState<OrgMember | null>(null);
  const [editingUnit, setEditingUnit] = useState<OrgUnit | null>(null);
  const [selectedUnitId, setSelectedUnitId] = useState<number | null>(null);
  const [memberQuery, setMemberQuery] = useState("");

  async function loadState() {
    const response = await fetch("/api/state");
    if (response.ok) {
      const data = await response.json();
      const nextLogs = (data.logs || []) as Log[];
      setDocs(data.documents || []); setLogs(nextLogs);
      setSelectedLogIds(current => current.filter(id => nextLogs.some(log => log.id === id)));
    }
  }
  function toggleSelectedId(ids: number[], setIds: (value: number[]) => void, id: number) {
    setIds(ids.includes(id) ? ids.filter(item => item !== id) : [...ids, id]);
  }
  function setAllSelectedIds(ids: number[], setIds: (value: number[]) => void, checked: boolean) {
    setIds(checked ? ids : []);
  }
  async function deleteBatch(urls: string[]) {
    const results = await Promise.allSettled(urls.map(async (url) => {
      const response = await fetch(url, { method: "DELETE" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "删除失败");
      return data;
    }));
    return { ok: results.filter(item => item.status === "fulfilled").length, failed: results.filter(item => item.status === "rejected").length };
  }
  async function loadModelStatus() {
    const response = await fetch("/api/model");
    if (response.ok) setModelStatus(await response.json());
  }
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
  function modelModeShortLabel(mode?: string) {
    if (!mode || mode === "auto") return "自动选模型";
    if (mode === "enterprise" || mode === "public") return "企业模型";
    if (mode.startsWith("connection:")) {
      const id = Number(mode.slice("connection:".length));
      const connection = modelStatus?.connections?.find(item => item.id === id);
      return connection ? formatModelOption(connection) : "第三方模型";
    }
    return mode;
  }
  const modelModeOptions = <>
    <option value="auto">自动选择（个人最新模型 → 企业公共模型）</option>
    <option value="enterprise">固定使用企业公共模型</option>
    <option value="none">不调用模型</option>
    {modelStatus?.connections?.map(model => <option key={model.id} value={`connection:${model.id}`}>{formatModelOption(model)}</option>)}
  </>;
  async function loadChats(selectId?: number) {
    const query = selectId ? `?conversationId=${selectId}` : "";
    log.info("加载对话列表", { selectId });
    markStart("loadChats");
    const response = await fetch(`/api/chat${query}`);
    if (!response.ok) {
      log.warn("对话列表加载失败", { status: response.status });
      return;
    }
    const data = await response.json();
    const chatItems = (data.conversations || []) as Conversation[];
    setConversations(chatItems);
    if (selectId) {
      const selected = chatItems.find((item: Conversation) => item.id === selectId);
      setConversationId(selectId); setModelMode(selected?.modelMode || "auto");
      setMessages(((data.messages || []) as ChatApiMessage[]).map(item => ({ who: item.role === "user" ? "user" : "bot", text: item.content, sources: item.sources, modelUsed: item.modelUsed })));
      return;
    }
    if (chatItems.length && (!conversationId || !chatItems.some(item => item.id === conversationId))) {
      await loadChats(chatItems[0].id);
      return;
    }
    if (!chatItems.length) {
      const createdResponse = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "ensureDefaultConversation", modelMode: "auto" }),
      });
      const created = await createdResponse.json();
      if (createdResponse.ok && created.conversationId) await loadChats(created.conversationId);
    }
  }
  async function loadModules() {
    const response = await fetch("/api/modules");
    if (response.ok) {
      const data = await response.json();
      setAgents(data.agents || []); setAgentRuns(data.agentRuns || []); setWorkflows(data.workflows || []); setSources(data.sources || []); setWorkflowRuns(data.runs || []); setCollectionRuns(data.collectionRuns || []);
    }
  }
  async function loadConnectors() {
    const response = await fetch("/api/connectors");
    if (response.ok) {
      const data = await response.json();
      setConnectors(data.connectors || []);
    }
  }
  async function loadSession() {
    markStart("loadSession");
    const response = await fetch("/api/session");
    if (response.status === 401) {
      log.warn("会话过期，跳转登录页");
      return location.assign("/login");
    }
    if (response.ok) {
      const data = await response.json();
      setAppRole(data.role); setRole(data.businessRole);
      log.info("会话加载成功", { role: data.role, businessRole: data.businessRole });
      markEnd("loadSession");
      if (data.role === "管理员") {
        const usersResponse = await fetch("/api/users");
        if (usersResponse.ok) setUsers((await usersResponse.json()).users || []);
      }
    } else {
      markEnd("loadSession", { status: response.status });
    }
  }
  async function loadGovernance() {
    const response = await fetch("/api/governance");
    if (response.ok) {
      const data = await response.json();
      const nextPermissions = (data.permissions || []) as Permission[];
      setApprovals(data.approvals || []); setPermissions(nextPermissions); setApprovalTargets(data.approvalTargets || []);
      setPermissionDrafts(buildPermissionDrafts(nextPermissions, capabilityCatalog));
      setPermissionDirty(false);
    }
  }
  async function loadCapabilities() {
    // 能力项目录（含分组、角色规格）由后端 /api/capabilities 提供，避免前端硬编码与 _capabilities.ts 漂移。
    const response = await fetch("/api/capabilities");
    if (response.ok) {
      const data = await response.json();
      setCapabilityCatalog((data.capabilities || []) as PermissionCapability[]);
      setCapabilityGroups((data.groups || []) as PermissionCapabilityGroup[]);
      setPermissionRoles((data.roles || []) as PermissionRoleSpec[]);
    }
  }
  async function loadProfile() {
    const response = await fetch("/api/profile");
    if (response.ok) setProfileInfo(await response.json());
  }
  useEffect(() => {
    // 能力项目录首载完成时，如果当前草稿还是空的（首次进入），立即生成一遍草稿；
    // 否则保留用户已经编辑的内容，避免覆盖。
    if (capabilityCatalog.length > 0 && !permissionDirty && Object.keys(permissionDrafts).length === 0) {
      setPermissionDrafts(buildPermissionDrafts(permissions, capabilityCatalog));
    }
    // 仅依赖 catalog 长度变化即可触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capabilityCatalog.length]);
  async function loadArtifacts(page = artifactsPage, owner = artifactOwner) {
    const params = new URLSearchParams({ page: String(page), pageSize: String(ARTIFACTS_PAGE_SIZE) });
    if (owner && owner !== "全部用户") params.set("owner", owner);
    const response = await fetch(`/api/artifacts?${params.toString()}`);
    if (response.ok) {
      const data = await response.json();
      setArtifacts(data.artifacts || []);
      setArtifactsTotal(data.total || 0);
      setArtifactsPage(data.page || page);
      setArtifactCounts(data.counts || { total: 0, markdown: 0, skill: 0 });
      setArtifactOwners(data.owners || []);
    }
  }
  // 工作流构建器要用「当前用户自己」的全部 markdown/skill（含正文），与网格分页相互独立。
  async function loadArtifactResources() {
    const response = await fetch("/api/artifacts?scope=picker");
    if (response.ok) setArtifactResources((await response.json()).artifacts || []);
  }
  async function loadPersonalKnowledge() {
    const response = await fetch("/api/personal-knowledge");
    if (response.ok) setPersonalKnowledge((await response.json()).items || []);
  }
  async function loadOrganization() {
    const response = await fetch("/api/organization");
    if (response.ok) {
      const data = await response.json();
      const units = data.units || [];
      setOrgUnits(units); setOrgMembers(data.members || []); setOrgOwner(data.ownerEmail || ""); setTransfers(data.transfers || []);
      setSelectedUnitId(current => units.some((unit: OrgUnit) => unit.id === current) ? current : units[0]?.id || null);
      setOrgReports(data.reports || []); setMyMember(data.myMember || null); setReportRecipients(data.recipients || []);
      setReminders(data.reminders || { approvals: 0, reports: 0 });
    }
  }
  useEffect(() => { loadSession(); loadState(); loadModelStatus(); loadModules(); loadConnectors(); loadGovernance(); loadCapabilities(); loadProfile(); loadArtifacts(); loadArtifactResources(); loadPersonalKnowledge(); loadOrganization(); loadChats(); }, []);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const saved = window.localStorage.getItem("haixin.activeTab");
    if (saved) setTab(saved as Tab);
    setHydrated(true);
    log.info("Console 组件已挂载", { userEmail, displayName, savedTab: saved });
  }, []);
  useEffect(() => {
    if (!hydrated || typeof window === "undefined") return;
    window.localStorage.setItem("haixin.activeTab", tab);
    log.info("标签切换", { tab });
  }, [tab, hydrated]);
  useEffect(() => {
    if (tab !== "logs" || appRole !== "管理员") return;
    const timer = window.setInterval(loadState, 5000);
    return () => window.clearInterval(timer);
  }, [tab, appRole]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 2500);
    return () => window.clearTimeout(timer);
  }, [notice]);

  async function newChat() {
    log.info("新建对话", {});
    const response = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "createConversation", modelMode: "auto" }) });
    const data = await response.json();
    if (!response.ok || !data.conversationId) return setNotice(data.error || "新建任务失败");
    setActiveAgent(null); setInput(""); setAskMode("quick");
    await loadChats(data.conversationId);
    setMessages([{ who: "bot", text: "这是一个新的独立任务。旧任务已经保留在左侧，可以随时切换回来继续处理。" }]);
    setNotice("已新建独立任务，原聊天未被覆盖");
    log.info("新建对话成功", { conversationId: data.conversationId });
  }
  async function deleteChat(id: number) {
    log.info("删除对话", { conversationId: id });
    if (!confirm("确定删除这条对话及全部消息吗？")) return;
    const response = await fetch(`/api/chat?id=${id}`, { method: "DELETE" });
    if (!response.ok) return setNotice("删除对话失败");
    if (conversationId === id) { setConversationId(null); setMessages([{ who: "bot", text: "请选择左侧任务，或新建一个独立任务。" }]); }
    await loadChats();
  }
  async function deleteSelectedChats() {
    if (!selectedConversationIds.length) return setNotice("请先选择要删除的任务");
    if (!confirm(`确认删除选中的 ${selectedConversationIds.length} 个任务吗？删除后无法恢复。`)) return;
    const result = await deleteBatch(selectedConversationIds.map(id => `/api/chat?id=${id}`));
    if (conversationId && selectedConversationIds.includes(conversationId)) {
      setConversationId(null);
      setMessages([{ who: "bot", text: "请选择左侧任务，或新建一个独立任务。" }]);
    }
    setSelectedConversationIds([]);
    await loadChats();
    setNotice(`已删除 ${result.ok} 个任务${result.failed ? `，${result.failed} 个失败` : ""}`);
  }
  async function renameChat(item: Conversation) {
    const title = prompt("输入新的对话名称", item.title)?.trim();
    if (!title) return;
    const response = await fetch("/api/chat", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: item.id, title }) });
    if (response.ok) await loadChats();
  }
  async function changeTaskModel(nextMode: string) {
    setModelMode(nextMode);
    if (!conversationId) {
      setNotice("模型已选择，但尚未创建任务。请点击“新建独立任务”后再开始对话。");
      return;
    }
    const response = await fetch("/api/chat", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "changeModel", id: conversationId, modelMode: nextMode }),
    });
    if (!response.ok) {
      const data = await response.json();
      return setNotice(data.error || "切换模型失败");
    }
    setConversations(items => items.map(item => item.id === conversationId ? { ...item, modelMode: nextMode } : item));
    setNotice("当前任务模型已切换，上下文和任务窗口保持不变。");
  }
  async function clearContext() {
    if (!conversationId) return setNotice("请先点击“新建独立任务”，未创建任务时不会自动生成窗口。");
    if (!confirm("确定清空当前对话的全部上下文吗？清空后无法恢复，其他对话不受影响。")) return;
    const response = await fetch("/api/chat", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "clearContext", id: conversationId }) });
    if (!response.ok) return setNotice("清空上下文失败");
    setMessages([{ who: "bot", text: "当前对话上下文已清空。接下来的回答不会读取之前的消息。" }]);
    setNotice("当前对话上下文已彻底清空");
    await loadChats();
  }

  function openChatDeposit() {
    const useful = messages.filter((message, index) => index > 0 || messages.length === 1);
    if (!useful.some(message => message.who === "user")) return setNotice("完成一次问答后才能沉淀聊天");
    const body = useful.map(message => `### ${message.who === "user" ? "用户" : "AI"}\n\n${message.text}${message.sources?.length ? `\n\n> 引用资料：${message.sources.join("、")}` : ""}`).join("\n\n");
    setSaveDraft({ sourceType: "chat", title: `聊天沉淀 ${new Date().toLocaleDateString("zh-CN")}`, content: `# 聊天沉淀\n\n${body}`, config: JSON.stringify({ messages: useful }) });
  }

  async function savePersonalKnowledge(title: string, content: string, sourceType: string, polish = false) {
    const response = await fetch("/api/personal-knowledge", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title, content, sourceType, conversationId, polish }) });
    const data = await response.json();
    if (!response.ok) return setNotice(data.error || "保存个人知识失败");
    setNotice(data.message || "保存成功");
    // 同步保存到沉淀中心
    await fetch("/api/artifacts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, content, artifactType: "markdown", sourceType: "chat", config: { source: "personalKnowledge", originalSourceType: sourceType } }),
    });
    await Promise.all([loadPersonalKnowledge(), loadArtifacts(), loadArtifactResources(), loadState()]);
  }

  async function saveMessageToPersonal(message: Message, index: number) {
    const title = `${message.who === "user" ? "我的问题" : "AI回答"} · ${message.text.replace(/\s+/g, " ").slice(0, 28)}`;
    await savePersonalKnowledge(title, message.text, `对话消息 #${index + 1}`);
  }

  async function saveConversationToPersonal() {
    const useful = messages.filter(message => message.text.trim());
    if (!useful.some(message => message.who === "user")) return setNotice("完成一次问答后才能保存到个人知识库");
    const content = useful.map(message => `## ${message.who === "user" ? "我的问题" : "AI回答"}\n\n${message.text}`).join("\n\n");
    await savePersonalKnowledge(`对话知识 · ${conversations.find(item => item.id === conversationId)?.title || new Date().toLocaleDateString("zh-CN")}`, content, "完整对话");
  }

  async function createPersonalKnowledge(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const files = form.getAll("files").filter((value): value is File => value instanceof File && value.size > 0);
    const title = String(form.get("title") || "").trim();
    const content = String(form.get("content") || "").trim();
    if (files.length) {
      const response = await fetch("/api/personal-knowledge", { method: "POST", body: form });
      const data = await response.json();
      if (!response.ok) return setNotice(data.error || "个人知识文件上传失败");
      await Promise.all([loadPersonalKnowledge(), loadState()]);
      setNotice(data.message || "文件已保存到个人知识库");
    } else {
      if (!title || !content) return setNotice("请选择文件，或同时填写知识名称与知识内容");
      await savePersonalKnowledge(title, content, "手动创建", form.get("polish") === "1");
    }
    setShowPersonalKnowledge(false);
  }


  const CHAT_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
  const CHAT_ATTACHMENT_TEXT_LIMIT = 80_000;
  const CHAT_ATTACHMENT_TOTAL_LIMIT = 180_000;
  // 图片走多模态：直接把图交给视觉模型识别，不做文字抽取。
  // 格式/体积与后端 validateOcrImages（api/modules/_collection.ts）保持一致：png/jpg/webp、≤5MB。
  const CHAT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
  function isChatImage(file: File) {
    return /^image\/(png|jpe?g|webp)$/i.test(file.type) || /\.(png|jpe?g|webp)$/i.test(file.name);
  }
  function readImageDataUrl(file: File) {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error(`「${file.name}」读取失败，请重试。`));
      reader.readAsDataURL(file);
    });
  }

  async function parseChatFile(file: File): Promise<{ content: string; note: string; dataUrl?: string }> {
    if (isChatImage(file)) {
      if (file.size > CHAT_IMAGE_MAX_BYTES) {
        throw new Error(`「${file.name}」图片超过 5MB，请压缩后再传。`);
      }
      const dataUrl = await readImageDataUrl(file);
      if (!/^data:image\/(png|jpe?g|webp);base64,/i.test(dataUrl)) {
        throw new Error(`「${file.name}」图片格式不支持，请用 PNG、JPG 或 WebP。`);
      }
      return {
        content: `# 图片：${file.name}`,
        note: "图片将随本轮直接交给 AI 识别（仅本轮有效，不入库）。",
        dataUrl,
      };
    }
    if (file.size > CHAT_ATTACHMENT_MAX_BYTES) {
      throw new Error(`「${file.name}」超过 10MB。聊天附件用于临时问答，大文件请先上传到个人知识库或企业知识库。`);
    }
    const form = new FormData();
    form.append("file", file);
    const response = await fetch("/api/extract-file", { method: "POST", body: form });
    const data = await readApiResult(response, "文件解析服务没有返回内容。");
    if (!response.ok) throw new Error(String(data.error || `${file.name} 解析失败`));
    const rawContent = String(data.content || "").trim();
    if (!rawContent) {
      throw new Error(`「${file.name}」没有提取到可读正文。${data.note || "请换成 PDF、Word(docx)、Excel、Markdown、TXT 或 CSV 后重试。"}`);
    }
    const content =
      rawContent.length > CHAT_ATTACHMENT_TEXT_LIMIT
        ? `${rawContent.slice(0, CHAT_ATTACHMENT_TEXT_LIMIT)}\n\n[系统提示：附件内容较长，已截取前 ${CHAT_ATTACHMENT_TEXT_LIMIT} 字用于本轮对话；完整资料建议上传到知识库后调用。]`
        : rawContent;
    return {
      content: `# 附件：${String(data.filename || data.name || file.name)}

${content}`,
      note: String(data.note || "附件正文已解析，可随本轮问题提交给 AI。"),
    };
  }

  async function addChatFiles(files?: FileList | null) {
    if (!files?.length) return;
    setAttachmentBusy(true);
    const parsed: ChatAttachment[] = [];
    const skipped: string[] = [];
    try {
      for (const file of Array.from(files).slice(0, 8)) {
        let result: { content: string; note: string; dataUrl?: string };
        try {
          result = await parseChatFile(file);
        } catch (error) {
          skipped.push(normalizeUploadError(error));
          continue;
        }
        parsed.push({
          id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
          name: file.name,
          type: file.type || "未知类型",
          size: file.size,
          content: result.content,
          note: result.note,
          mode: "round",
          dataUrl: result.dataUrl,
        });
      }
      if (parsed.length) setChatAttachments(items => [...items, ...parsed]);
      const message = [
        parsed.length ? `已添加 ${parsed.length} 个附件，可选择仅本轮使用、存个人知识或同步企业知识。` : "",
        skipped.length ? `未添加：${skipped.join("；")}` : "",
      ].filter(Boolean).join(" ");
      setNotice(message || "没有可读取的附件。");
    } catch (error) {
      setNotice(normalizeUploadError(error));
    } finally {
      setAttachmentBusy(false);
    }
  }

  function attachmentContext(items: ChatAttachment[]) {
    if (!items.length) return "";
    let used = 0;
    const blocks: string[] = [];
    for (const item of items) {
      const remaining = CHAT_ATTACHMENT_TOTAL_LIMIT - used;
      if (remaining <= 0) break;
      const content =
        item.content.length > remaining
          ? `${item.content.slice(0, remaining)}\n\n[系统提示：本轮附件总内容过长，后续内容已省略。]`
          : item.content;
      used += content.length;
      const modeText = item.mode === "round" ? "仅本轮使用" : item.mode === "personal" ? "存入个人知识库" : "同步到企业知识库";
      blocks.push(`${content}\n\n> 处理方式：${modeText}`);
    }
    return `\n\n---\n\n## 本轮上传附件\n\n${blocks.join("\n\n---\n\n")}`;
  }

  async function persistChatAttachments(items: ChatAttachment[]) {
    const needSave = items.filter(item => item.mode !== "round" && !item.saved);
    for (const item of needSave) {
      const response = await fetch("/api/personal-knowledge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: `聊天附件 · ${item.name}`, content: item.content, sourceType: `聊天附件 · ${item.mode === "enterprise" ? "同步企业知识" : "个人知识"}`, conversationId }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `${item.name} 保存失败`);
      if (item.mode === "enterprise") {
        const syncResponse = await fetch("/api/personal-knowledge", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: data.item?.id, visibility: appRole === "管理员" ? "全员" : "部门", category: "聊天附件", tags: "聊天附件,智能助手上传" }),
        });
        const syncData = await syncResponse.json();
        if (!syncResponse.ok) throw new Error(syncData.error || `${item.name} 同步企业知识失败`);
      }
    }
    if (needSave.length) await Promise.all([loadPersonalKnowledge(), loadState()]);
  }


  function loopMarkdown() {
    return `# ${continuous.name || "持续任务"}\n\n## 运行方式\n\n- 类型：${continuous.loopType}\n- 触发：${continuous.triggerType}\n- 审查模式：${continuous.reviewMode}\n- 最大循环：${continuous.maxLoops} 次\n\n## 任务目标\n\n${continuous.goal}\n\n## 审查标准\n\n${continuous.reviewStandard}\n\n## 停止条件\n\n${continuous.stopCondition}\n\n## 完成与失败处理\n\n- 完成后：${continuous.finalAction}\n- 失败后：${continuous.failureAction}`;
  }

  async function saveArtifact(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!saveDraft) return;
    const form = new FormData(event.currentTarget);
    const response = await fetch("/api/artifacts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      ...saveDraft, title: form.get("title"), artifactType: form.get("artifactType"),
    }) });
    const data = await response.json();
    if (!response.ok) return setNotice(data.error || "沉淀保存失败");
    setSaveDraft(null); setNotice("已保存到沉淀中心，下次可以直接复用");
    await Promise.all([loadArtifacts(), loadArtifactResources(), loadState()]);
  }

  function reuseArtifact(item: Artifact) {
    if (item.sourceType === "loop") {
      try {
        const saved = JSON.parse(item.config);
        setContinuous({ ...continuous, ...saved });
        setAskMode("continuous"); setTab("chat");
        setNotice("Loop配置已恢复，检查后即可再次创建");
      } catch { setNotice("该Loop配置无法读取，请打开Markdown内容参考"); }
      return;
    }
    if (item.artifactType === "skill") {
      setGuide({ role: "基于历史沉淀复用的企业助手", task: item.content, context: "沿用已验证的方法，并根据本次新信息调整", constraint: "不得虚构缺失信息，重要结论需人工核对", format: "保持原沉淀的结构", example: "" });
      setAskMode("guided");
    } else {
      setInput(item.content); setAskMode("quick");
    }
    setTab("chat"); setNotice(item.artifactType === "skill" ? "Skill已载入任务向导，可修改后运行" : "Markdown已放入聊天输入框");
  }

  function downloadMarkdown(item: Artifact) {
    const url = URL.createObjectURL(new Blob([item.content], { type: "text/markdown;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = `${item.title.replace(/[\\/:*?"<>|]/g, "_")}.md`; link.click();
    URL.revokeObjectURL(url);
  }

  function downloadKnowledgeText(title: string, content: string) {
    if (!content?.trim()) return setNotice("这条知识还没有可下载的正文内容");
    const safeTitle = (title || "knowledge").replace(/[\\/:*?"<>|]/g, "_");
    let extension = "md";
    let mimeType = "text/markdown;charset=utf-8";
    try {
      JSON.parse(content);
      extension = "json";
      mimeType = "application/json;charset=utf-8";
    } catch {
      if (!content.trim().startsWith("#") && !content.includes("| ---")) {
        extension = "txt";
        mimeType = "text/plain;charset=utf-8";
      }
    }
    const url = URL.createObjectURL(new Blob([content], { type: mimeType }));
    const link = document.createElement("a"); link.href = url; link.download = `${safeTitle}.${extension}`; link.click();
    URL.revokeObjectURL(url);
  }

  async function deleteArtifact(item: Artifact) {
    if (!confirm(`确定删除“${item.title}”吗？`)) return;
    const response = await fetch(`/api/artifacts?id=${item.id}`, { method: "DELETE" });
    const data = await response.json();
    setNotice(response.ok ? "沉淀已删除" : data.error || "删除失败");
    if (response.ok) await Promise.all([loadArtifacts(), loadArtifactResources(), loadState()]);
  }


  async function deleteModule(moduleName: "agent" | "workflow" | "source", id: number, name: string) {
    const label = moduleName === "agent" ? "智能体" : moduleName === "workflow" ? "工作流" : "数据源";
    const historyNote = moduleName === "workflow" ? "\n\n已有运行历史和审计记录会继续保留。" : "";
    if (!confirm(`确定删除${label}“${name}”吗？${historyNote}`)) return;
    const response = await fetch(`/api/modules?module=${moduleName}&id=${id}`, { method: "DELETE" });
    const data = await response.json();
    setNotice(response.ok ? data.message : data.error || "删除失败");
    if (response.ok) {
      if (moduleName === "agent" && activeAgent?.id === id) setActiveAgent(null);
      await Promise.all([loadModules(), loadState()]);
    }
  }

  async function submitApproval(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget).entries());
    const response = await fetch("/api/governance", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "submit", ...values }) });
    const data = await response.json();
    setNotice(response.ok ? "审批申请已提交到指定账号" : data.error || "提交失败");
    if (response.ok) { setShowApproval(false); event.currentTarget.reset(); await Promise.all([loadGovernance(), loadState()]); }
  }


  async function logout() {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      window.location.assign("/login");
    }
  }

  function unitDepth(unit: OrgUnit, seen = new Set<number>()): number {
    if (!unit.parentId || seen.has(unit.id)) return 0;
    seen.add(unit.id);
    const parent = orgUnits.find(item => item.id === unit.parentId);
    return parent ? 1 + unitDepth(parent, seen) : 0;
  }


  async function submitOrganization(event: FormEvent<HTMLFormElement>, action: string) {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget).entries());
    const response = await fetch("/api/organization", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...values, useAi: values.useAi ? "true" : "false" }) });
    const data = await response.json();
    setNotice(response.ok ? action === "createReport" ? "汇报已送达上级，管理者会收到提醒" : action === "requestTransfer" ? "加入或转岗申请已提交审批" : "企业架构已更新" : data.error || "操作失败");
    if (response.ok) {
      const form = event.currentTarget;
      setOrgModal(null); setEditingMember(null); setEditingUnit(null);
      form.reset();
      await Promise.all([loadOrganization(), loadGovernance(), loadState()]);
    }
  }



  async function saveConnectorCredentials(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!connectorHelp) return;
    const values = Object.fromEntries(new FormData(event.currentTarget).entries());
    const response = await fetch("/api/connectors", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...values, action: "saveConnection", platform: connectorHelp.id }),
    });
    const data = await response.json();
    setNotice(data.message || (response.ok ? "个人API已保存" : "保存失败"));
    if (response.ok) { setConnectorHelp(null); await loadConnectors(); }
  }


  async function saveModule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget).entries());
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const agentAction = submitter?.value || "enable";
    // 数据来源表单：把新的 sourceKind 映射回后端的 collectorMode 和 sourceType。
    // sourceType 只是展示文本，后端用 includes("万能") 判断爬虫。
    if (modalType === "source") {
      const kind = String(values.sourceKind || "网页");
      const method = kind === "网页" ? String(values.webMethod || "direct") : sourceKindMap[kind] || "direct";
      const sourceType = kind === "网页" ? (method === "crawler" ? "万能爬虫" : "公开网页") : kind;
      values.sourceType = sourceType;
      values.collectorMode = method;
    }
    const response = await fetch("/api/modules", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...values, type: modalType, ...(modalType==="source"&&editingSource?{id:String(editingSource.id)}:{}), ...(modalType==="workflow"?{steps:JSON.stringify(workflowNodes)}:{}), ...(modalType==="agent"?{status:agentAction==="draft"?"草稿":"已启用"}:{}) }) });
    const data = await response.json();
    if (!response.ok) return setNotice(data.error || "保存失败");
    setNotice(modalType==="source" ? (data.message || "采集任务已保存") : agentAction==="draft"?"智能体草稿已保存":"已保存并启用"); setModalType(null); setEditingSource(null); setSourceDraft(null); await Promise.all([loadModules(), loadState()]);
    if (modalType==="agent" && agentAction==="test" && data.id) {
      const config = JSON.stringify({ modelMode: values.modelMode || "auto", welcomeMessage: values.welcomeMessage || `你好，我是${values.name}。请告诉我你要完成的任务。` });
      startAgent({ id: data.id, name: String(values.name), description: String(values.description || ""), instructions: String(values.instructions || values.taskPrompt || ""), knowledgeScope: String(values.knowledgeScope || "全员"), status: "已启用", config });
    }
  }

  function closeModuleModal() {
    setModalType(null);
    setEditingSource(null);
    setSourceDraft(null);
  }

  function openSourceEditor(source: Source) {
    setEditingSource(source);
    setSourceDraft(null);
    setModalType("source");
    setSampleData(source.sampleData || "");
    // 编辑旧数据时按 collectorMode 反推 sourceKind，保证下拉正确回显。
    const cm = source.collectorMode || "direct";
    if (cm === "direct" || cm === "crawler") {
      setSourceKind("网页");
      setWebMethod(cm);
    } else if (cm === "api") {
      setSourceKind("JSON API");
    } else if (cm === "screenshot") {
      setSourceKind("图片/截图");
    } else if (cm === "paste") {
      setSourceKind("文本/粘贴");
    } else if (cm === "mcp") {
      setSourceKind("MCP");
    } else {
      setSourceKind("网页");
      setWebMethod("direct");
    }
  }

  function newSourceTask(preset?: Partial<Source>) {
    setEditingSource(null);
    setSourceDraft(preset || null);
    setModalType("source");
    setSampleData(preset?.sampleData || "");
    const cm = preset?.collectorMode || "direct";
    if (cm === "direct" || cm === "crawler") {
      setSourceKind("网页");
      setWebMethod(cm);
    } else if (cm === "api") {
      setSourceKind("JSON API");
    } else if (cm === "screenshot") {
      setSourceKind("图片/截图");
    } else if (cm === "paste") {
      setSourceKind("文本/粘贴");
    } else if (cm === "mcp") {
      setSourceKind("MCP");
    } else {
      setSourceKind("网页");
      setWebMethod("direct");
    }
  }

  async function runModule(module: "workflow" | "source", id: number, name: string) {
    if (module === "workflow") {
      const workflow = workflows.find(item=>item.id===id);
      if (workflow) { setRunWorkflow(workflow); setRunInput(""); }
      return;
    }
    setRunningSourceId(id); setNotice("正在连接数据源并抓取真实内容…");
    const response = await fetch("/api/modules", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "run", module, id: String(id), name }) });
    const data = await response.json();
    setRunningSourceId(null);
    setNotice(response.ok
      ? data.publishMode === "record_only"
        ? `采集完成：得到 ${data.rowCount} 条，已保存为采集记录，输出为${outputFormatLabel(data.outputFormat)}。可打开记录查看、清洗或手动入库。`
        : `采集完成：得到 ${data.rowCount} 条，已进入${targetStoreLabel(data.targetStore)}，输出为${outputFormatLabel(data.outputFormat)}。个人知识可在企业知识页手动同步到企业知识库。`
      : data.error || "执行失败");
    await Promise.all([loadModules(), loadState()]);
  }


  function chooseWorkflowTemplate(kind: "宣传" | "会议" | "客户" | "自定义") {
    const templates: Record<string, WorkflowNode[]> = {
      宣传: [{id:"in",type:"input",name:"填写宣传需求"},{id:"kb",type:"knowledge",name:"检索企业资料"},{id:"ai",type:"ai",name:"生成宣传文案",config:"基于企业资料生成真实、合规、有吸引力的宣传文案，不得编造数据"},{id:"review",type:"review",name:"审查事实与品牌口径",config:"事实有出处、无夸大承诺、品牌口径一致、结构完整"},{id:"approve",type:"approval",name:"负责人审批"},{id:"save",type:"save",name:"保存到沉淀中心"},{id:"out",type:"output",name:"交付最终文案"}],
      会议: [{id:"in",type:"input",name:"粘贴会议记录"},{id:"ai",type:"ai",name:"提炼结论与待办",config:"整理会议结论、待办、负责人、截止时间和待确认事项"},{id:"review",type:"review",name:"检查遗漏",config:"不遗漏负责人、时间、争议和待确认事项"},{id:"save",type:"save",name:"保存会议纪要"},{id:"out",type:"output",name:"输出纪要"}],
      客户: [{id:"in",type:"input",name:"填写客户情况"},{id:"kb",type:"knowledge",name:"检索产品与政策"},{id:"ai",type:"ai",name:"生成跟进建议",config:"生成客户画像、需求判断、风险点和下一步跟进话术"},{id:"review",type:"review",name:"检查承诺风险",config:"不得承诺未授权价格、赔偿、交付日期"},{id:"out",type:"output",name:"输出跟进方案"}],
      自定义: [{id:"in",type:"input",name:"填写本次任务"},{id:"ai",type:"ai",name:"AI处理",config:"完成用户要求并给出可直接使用的结果"},{id:"out",type:"output",name:"查看结果"}],
    };
    setWorkflowNodes(templates[kind]);
  }

  function addWorkflowNode() {
    const next: WorkflowNode = { id:`node-${Date.now()}`, type:"ai", name:"新的处理步骤", config:"说明这一步要完成什么", inputMode:"prompt" };
    setWorkflowNodes(items=>[...items.slice(0,-1),next,...items.slice(-1)]);
  }

  function addParallelGroup() {
    const stamp = Date.now();
    const group = `parallel-${stamp}`;
    const branches: WorkflowNode[] = [
      { id:`${group}-1`, type:"ai", name:"AI任务一", config:"说明第一个AI要独立完成什么", parallelGroup:group, inputMode:"prompt" },
      { id:`${group}-2`, type:"ai", name:"AI任务二", config:"说明第二个AI要独立完成什么", parallelGroup:group, inputMode:"prompt" },
    ];
    setWorkflowNodes(items=>{
      const inputIndex = items.findIndex(item=>item.type==="input");
      const insertAt = inputIndex >= 0 ? inputIndex + 1 : 0;
      return [...items.slice(0,insertAt),...branches,...items.slice(insertAt)];
    });
  }

  function addParallelBranch(group: string, afterId: string) {
    setWorkflowNodes(items=>{
      const index = items.findIndex(item=>item.id===afterId);
      const count = items.filter(item=>item.parallelGroup===group).length + 1;
      const next: WorkflowNode = { id:`${group}-${Date.now()}`, type:"ai", name:`AI任务${count}`, config:"说明这个AI要独立完成什么", parallelGroup:group, inputMode:"prompt" };
      return [...items.slice(0,index+1),next,...items.slice(index+1)];
    });
  }

  function updateWorkflowInput(nodeId: string, patch: Partial<WorkflowNode>) {
    setWorkflowNodes(items=>items.map(item=>item.id===nodeId?{...item,...patch}:item));
  }

  function updatePromptField(nodeId: string, field: keyof PromptGuide, value: string) {
    setWorkflowNodes(items=>items.map(item=>{
      if (item.id!==nodeId) return item;
      const guide: PromptGuide = item.promptGuide || { role:"",task:"",context:"",constraint:"",format:"",example:"" };
      return {...item,promptGuide:{...guide,[field]:value}};
    }));
  }

  function selectWorkflowResource(nodeId: string, artifactId: string, mode: "markdown" | "skill") {
    const artifact = artifactResources.find(item=>String(item.id)===artifactId && item.artifactType===mode);
    updateWorkflowInput(nodeId,{inputMode:mode,resourceTitle:artifact?.title||"",resourceContent:artifact ? `${artifact.content}\n\n配置：${artifact.config||"无"}` : ""});
  }

  async function send(event?: FormEvent, preset?: string) {
    event?.preventDefault();
    const value = (preset || input).trim();
    const attachments = [...chatAttachments];
    if ((!value && !attachments.length) || busy || attachmentBusy) return;
    if (!conversationId) return setNotice("请先点击左侧“新建独立任务”。系统不会因发送消息或切换模型自动创建窗口。");
    const displayText = value || `请处理我上传的 ${attachments.length} 个附件`;
    const payloadText = `${displayText}${attachmentContext(attachments)}`;
    const images = attachments.map(item => item.dataUrl).filter((url): url is string => Boolean(url));
    log.info("发送消息", { conversationId, messageLength: value.length, hasAttachments: attachments.length > 0, imageCount: images.length, agentId: activeAgent?.id, modelMode, knowledgeMode });
    markStart("sendMessage");
    setMessages((m) => [...m, { who: "user", text: attachments.length ? `${displayText}\n\n已附加：${attachments.map(item => item.name).join("、")}` : displayText }]);
    setInput(""); setChatAttachments([]); setBusy(true);
    let persisted = false;
    try {
      await persistChatAttachments(attachments);
      persisted = true;
      const response = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: payloadText, role, agentId: activeAgent?.id, conversationId, modelMode, knowledgeMode, images }) });
      const data = await readApiResult(response, "服务没有返回内容，请稍后重试。");
      const answer = data.answer || data.error || "服务暂时不可用";
      setMessages((m) => [...m, { who: "bot", text: answer, sources: data.sources, sourceFiles: data.sourceFiles, modelUsed: data.usedModel }]);
      if (data.conversationId) setConversationId(data.conversationId);
      await Promise.all([loadState(), loadChats()]);
      markEnd("sendMessage", { status: data.error ? "error" : "ok", responseLength: answer.length });
      if (data.error) log.warn("消息回复包含错误", { error: data.error, conversationId });
    } catch (error) {
      if (!persisted && attachments.length) setChatAttachments(attachments);
      log.error("消息发送失败", { error: error instanceof Error ? error.message : String(error), conversationId });
      setMessages((m) => [...m, { who: "bot", text: error instanceof Error ? error.message : "连接暂时中断，请稍后重试。" }]);
    } finally { setBusy(false); }
  }

  async function runWorkflowInChat() {
    const workflow = workflows.find(item => String(item.id) === chatWorkflowId);
    const value = input.trim();
    if (!conversationId) return setNotice("请先点击左侧“新建独立任务”。工作流不会自动创建聊天窗口。");
    if (!workflow) return setNotice("请先选择一个已启用的工作流");
    if (!value) return setNotice("请填写这次要交给工作流处理的任务或数据");
    if (busy) return;
    setMessages(items => [...items, { who: "user", text: `运行工作流“${workflow.name}”\n${value}` }]);
    setInput("");
    setBusy(true);
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: value, workflowId: workflow.id, conversationId, modelMode }),
      });
      const data = await readApiResult(response, "工作流服务没有返回内容，请稍后重试。");
      setMessages(items => [...items, { who: "bot", text: data.answer || data.error || "工作流暂时无法启动", modelUsed: data.usedModel }]);
      if (data.conversationId) setConversationId(data.conversationId);
      await Promise.all([loadModules(), loadGovernance(), loadState(), loadChats()]);
    } catch {
      setMessages(items => [...items, { who: "bot", text: "工作流连接暂时中断，请稍后重试。" }]);
    } finally {
      setBusy(false);
    }
  }

  function agentSettings(agent: Agent) {
    try { return JSON.parse(agent.config || "{}") as { modelMode?: string; welcomeMessage?: string; capabilities?: string[]; knowledgeCategory?: string; publishTarget?: string }; }
    catch { return {}; }
  }

  function startAgent(agent: Agent) {
    const config = agentSettings(agent);
    setActiveAgent(agent);
    if (config.modelMode) setModelMode(config.modelMode);
    setAskMode("quick");
    setTab("chat");
    setMessages((items) => [...items, { who: "bot", text: config.welcomeMessage || `已启动“${agent.name}”。我会按它的工作指令和“${agent.knowledgeScope}”知识范围回答；每次运行都会重新校验你的权限并记录审计。` }]);
    setNotice(`正在使用智能体：${agent.name}`);
  }

  function stopAgent() {
    const name = activeAgent?.name;
    setActiveAgent(null);
    if (name) setMessages((items) => [...items, { who: "bot", text: `已退出“${name}”，恢复为通用企业助手。` }]);
  }

  function applyPromptTemplate(template: "宣传文案" | "会议纪要" | "数据分析" | "客户回复") {
    const templates = {
      宣传文案: { role: "企业品牌宣传专员", task: "撰写一份企业宣传文案", context: "请结合我提供的产品、客户和使用场景", constraint: "不得夸大效果，不得编造数据和客户案例", format: "标题、导语、三个核心亮点、行动邀请", example: "语气专业、可信、简洁" },
      会议纪要: { role: "企业会议秘书", task: "整理会议纪要并提炼待办", context: "请根据我粘贴的会议记录处理", constraint: "不得遗漏负责人、完成时间和争议事项", format: "会议结论、待办表格、风险与待确认事项", example: "每条待办包含负责人和截止时间" },
      数据分析: { role: "企业数据分析师", task: "分析业务数据并提出建议", context: "请根据我提供的数据范围和指标处理", constraint: "区分事实与推测，数据不足时明确说明", format: "关键发现、原因分析、异常项、行动建议", example: "优先使用表格展示同比和环比" },
      客户回复: { role: "资深客户服务经理", task: "起草一份客户回复", context: "请结合客户问题、历史沟通和公司政策", constraint: "不得承诺未获授权的价格、赔偿或交付日期", format: "可直接发送的回复正文，并附内部处理建议", example: "语气真诚、明确、有解决方案" },
    };
    setGuide(templates[template]);
  }

  function sendGuided(event: FormEvent) {
    event.preventDefault();
    if (!guide.task.trim()) return setNotice("请至少填写“要完成什么”");
    const prompt = [
      guide.role && `【角色】${guide.role}`, `【任务】${guide.task}`,
      guide.context && `【上下文】${guide.context}`, guide.constraint && `【约束】${guide.constraint}`,
      guide.format && `【格式】${guide.format}`, guide.example && `【示例】${guide.example}`,
    ].filter(Boolean).join("\n");
    setAskMode("quick");
    send(undefined, prompt);
  }

  async function createContinuousTask(event: FormEvent) {
    event.preventDefault();
    // 把用户填的目标/合格标准编译成"可执行的真节点"，而不是以前那串没有语义的箭头文字。
    // input(直接需求=目标) → ai(以目标为任务) → review(合格标准) → output；
    // 明确标准才加审查节点，探索标准模式让 AI 先产出、由人工/循环评估把关。
    const goal = continuous.goal.trim();
    const standard = continuous.reviewStandard.trim();
    const nodes = [
      { id: "loop-input", type: "input", name: "设定目标", inputMode: "direct", config: goal },
      { id: "loop-exec", type: "ai", name: "执行任务", promptGuide: { task: goal } },
      ...(continuous.reviewMode === "明确标准" && standard
        ? [{ id: "loop-review", type: "review", name: "审查结果", config: standard }]
        : []),
      { id: "loop-output", type: "output", name: "输出结果" },
    ];
    const response = await fetch("/api/modules", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      type: "workflow", name: continuous.name, triggerType: continuous.triggerType, steps: JSON.stringify(nodes), goal: continuous.goal,
      loopType: continuous.loopType, reviewMode: continuous.reviewMode, reviewStandard: continuous.reviewStandard,
      stopCondition: continuous.stopCondition, maxLoops: continuous.maxLoops, finalAction: continuous.finalAction,
      failureAction: continuous.failureAction, scheduleTime: continuous.loopType === "定时制" ? continuous.scheduleTime : "",
      watchSourceType: continuous.loopType === "主动制" ? continuous.watchSourceType : "",
      watchSourceRef: continuous.loopType === "主动制" ? continuous.watchSourceRef : "",
      triggerCondition: continuous.loopType === "主动制" ? continuous.triggerCondition : "",
      checkInterval: continuous.checkInterval,
    }) });
    const data = await response.json();
    if (!response.ok) return setNotice(data.error || "持续任务创建失败");
    setNotice(continuous.loopType === "定时制"
      ? `持续任务已创建，每天 ${continuous.scheduleTime}（北京时间）自动运行`
      : continuous.loopType === "主动制"
        ? (continuous.watchSourceType === "inbound_message"
          ? "持续任务已创建；收到所选渠道消息时会自动评估并按条件触发"
          : `持续任务已创建；每 ${continuous.checkInterval} 分钟检查一次事件源，命中触发条件即自动运行`)
        : "持续任务已创建；该模式不会自动运行，需要在工作流中心手动触发");
    await Promise.all([loadModules(), loadState()]);
    setSaveDraft({ sourceType: "loop", title: continuous.name, content: loopMarkdown(), config: JSON.stringify(continuous) });
    setTab("workflows"); setAskMode("quick");
  }

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const files = form.getAll("files").filter(value => value instanceof File && value.size);
    setUploading(true);
    setUploadProgress(0);
    // 进度模拟（fetch 不直接暴露进度）
    const tick = setInterval(() => setUploadProgress(p => Math.min(85, p + Math.random() * 12)), 120);
    let response: Response;
    try {
      if (files.length) {
        response = await fetch("/api/state", { method: "POST", body: form });
      } else {
        response = await fetch("/api/state", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "document", title: form.get("title"), content: form.get("content"), visibility: form.get("visibility"), departmentId: form.get("departmentId"), category: form.get("category"), tags: form.get("tags"), updateMode: form.get("updateMode"), updateSchedule: form.get("updateSchedule"), polish: form.get("polish") === "1" }) });
      }
      const data = await response.json();
      clearInterval(tick);
      setUploadProgress(100);
      if (!response.ok) { setUploading(false); setUploadProgress(0); return setNotice(data.error || "保存失败"); }
      setNotice(files.length ? `已上传 ${files.length} 个文件；可解析内容已进入AI检索` : (data.message || "资料已保存并可用于AI问答"));
      setTimeout(() => {
        setShowUpload(false); event.currentTarget.reset();
        setUploadFiles([]); setUploadMode("file"); setUploadProgress(0); setUploading(false);
      }, 400);
      await loadState();
    } catch (err) {
      clearInterval(tick);
      setUploading(false); setUploadProgress(0);
      setNotice("上传失败：" + (err instanceof Error ? err.message : "网络异常"));
    }
  }


  async function deleteSelectedArtifacts() {
    if (!selectedArtifactIds.length) return setNotice("请先选择要删除的沉淀");
    if (!confirm(`确认删除选中的 ${selectedArtifactIds.length} 条沉淀吗？删除后无法恢复。`)) return;
    const result = await deleteBatch(selectedArtifactIds.map(id => `/api/artifacts?id=${id}`));
    setSelectedArtifactIds([]);
    await Promise.all([loadArtifacts(), loadArtifactResources(), loadState()]);
    setNotice(`已删除 ${result.ok} 条沉淀${result.failed ? `，${result.failed} 条失败` : ""}`);
  }
  async function deleteSelectedModules(moduleName: "agent" | "workflow" | "source", ids: number[], clear: (value: number[]) => void) {
    if (!ids.length) return setNotice("请先选择要删除的项目");
    const label = moduleName === "agent" ? "智能体" : moduleName === "workflow" ? "工作流" : "数据源";
    if (!confirm(`确认删除选中的 ${ids.length} 个${label}吗？删除后无法恢复。`)) return;
    const result = await deleteBatch(ids.map(id => `/api/modules?module=${moduleName}&id=${id}`));
    clear([]);
    if (moduleName === "agent" && activeAgent && ids.includes(activeAgent.id)) setActiveAgent(null);
    await Promise.all([loadModules(), loadState()]);
    setNotice(`已删除 ${result.ok} 个${label}${result.failed ? `，${result.failed} 个失败` : ""}`);
  }

  // 服务端已按 owner 过滤并分页，网格直接渲染当前页。批量操作以当前页为范围。
  const visibleArtifacts = artifacts;
  // 用于在消息区中央渲染“空状态 Hero”：当用户尚未发出过任何消息且当前不在生成中时展示。
  // 这样初识状态、清空上下文、新建任务后，都给出明显的下一步引导。
  const hasUserMessage = messages.some(item => item.who === "user");
  const currentConversationTitle = conversations.find(item => item.id === conversationId)?.title;

  return <main className="shell">
    <aside className="sidebar">
      <div className="brand"><img className="brandLogo" src="/haixin-bochuang-logo.png" alt="海芯博创"/><span><b>海芯博创</b><small>企业智能中台</small></span></div>
      <SidebarNavigation activeTab={tab} isAdmin={appRole === "管理员"} onSelect={setTab} />
      <div className="profile"><span className="avatar">{displayName.slice(0,1)}</span><span><b>{displayName}</b><small>{userEmail}</small></span><button className="signout" type="button" onClick={logout}>退出</button></div>
    </aside>
    <section className="workspace">
      <header><div><h1>{nav.find(n => n[0] === tab)?.[2]}</h1></div></header>
      {notice && <button className="notice" onClick={() => setNotice("")}>{notice} ×</button>}

      {/* 工作区正文：视口高度由 shell 锁定，纵向滚动只发生在这一层，页面本身不出现滚动条。 */}
      <div className={`workspaceBody ${tab === "chat" ? "chatBody" : ""}`}>
      {tab === "chat" && <div className={`chatLayout ${insightCollapsed?"insightCollapsed":""}`}>
        <aside className="conversationPanel"><button className="newChatButton" onClick={newChat}><PlusIcon style={{ width: 14, height: 14 }} /> 新建独立任务</button>{!!conversations.length&&<div className="conversationBulk"><label><input type="checkbox" checked={conversations.every(item=>selectedConversationIds.includes(item.id))} onChange={event=>setAllSelectedIds(conversations.map(item=>item.id),setSelectedConversationIds,event.target.checked)}/>全选</label><button disabled={!selectedConversationIds.length} onClick={deleteSelectedChats}>删除选中</button></div>}<div className="conversationList">{conversations.map(item=><div key={item.id} className={conversationId===item.id?"active":""}><div className="conversationTitleRow"><label className="conversationCheck"><input type="checkbox" checked={selectedConversationIds.includes(item.id)} onChange={()=>toggleSelectedId(selectedConversationIds,setSelectedConversationIds,item.id)}/></label><button className="conversationTitle" onClick={()=>loadChats(item.id)}>{item.title}</button><button title="重命名" aria-label={`编辑${item.title}`} onClick={()=>renameChat(item)}>编辑</button><button title="删除" aria-label={`删除${item.title}`} onClick={()=>deleteChat(item.id)}>删除</button></div><button className="conversationMeta" onClick={()=>loadChats(item.id)}>{new Date(item.updatedAt).toLocaleDateString("zh-CN")} · {modelModeShortLabel(item.modelMode)}</button></div>)}</div>{!conversations.length && <div className="conversationEmpty"><div className="conversationEmptyIcon"><MessageIcon style={{ width: 32, height: 32 }} /></div></div>}</aside>
        <section className="chatPanel"><div className="chatTop"><div className="chatTopIdentity"><span className="botAvatar">AI</span><div className="chatTopIdentityText"><b>海芯博创企业助手</b><span className="statusBadge">身份已验证 · 模型已就绪</span></div></div>{currentConversationTitle && <div className="chatTopTask" title={currentConversationTitle}>对话：{currentConversationTitle}</div>}<div className="chatControls"><label className="modelSelect">模型<select value={modelMode} onChange={e=>changeTaskModel(e.target.value)}>{modelModeOptions}</select></label><div className="askMode"><button className={askMode==="quick"?"active":""} onClick={()=>setAskMode("quick")} title="直接与AI对话问答"><BoltIcon style={{ width: 14, height: 14 }} /> 直接问答</button><button className={askMode==="guided"?"active":""} onClick={()=>setAskMode("guided")} title="按业务引导填写，自动生成提示词"><ClipboardIcon style={{ width: 14, height: 14 }} /> 引导填写</button><button className={askMode==="continuous"?"active":""} onClick={()=>setAskMode("continuous")} title="创建可自动或定时运行的任务"><RefreshIcon style={{ width: 14, height: 14 }} /> 自动任务</button></div><button className="iconButton clearContextIcon" onClick={clearContext} title="清空当前任务上下文" aria-label="清空当前任务上下文"><TrashIcon /></button><button className="iconButton depositIcon" onClick={saveConversationToPersonal} title="保存到个人知识" aria-label="保存到个人知识"><InboxIcon /></button><button className="iconButton depositIcon" onClick={openChatDeposit} title="沉淀为MD/Skill" aria-label="沉淀为MD/Skill"><DiamondIcon /></button></div></div>
          {activeAgent && <div className="agentRunBar"><div><span>运行中的智能体</span><b>{activeAgent.name}</b><small>{activeAgent.description} · 知识范围：{activeAgent.knowledgeScope}</small></div><div><button onClick={openChatDeposit}>保存本次结果</button><button className="outline" onClick={stopAgent}>退出智能体</button></div></div>}
          {askMode==="quick" ? <><div className="messages">{!hasUserMessage && !busy && <div className="emptyHero"><div className="emptyHeroIcon" aria-hidden="true"><WaveIcon style={{ width: 36, height: 36 }} /></div><h2>欢迎使用海芯博创企业助手</h2><div className="suggestionGrid">{["根据知识库介绍公司产品", "查看我的权限", "帮我导出全部客户", "起草一份客户回访方案"].map(s => <button key={s} className="suggestionCard" onClick={() => send(undefined, s)} type="button"><span className="suggestionIcon" aria-hidden="true"><ArrowRightIcon style={{ width: 14, height: 14 }} /></span><b>{s}</b></button>)}</div><div className="emptyHeroFoot"><span>官网：https://www.haixinzhixun.com</span><div className="emptyHeroActions"><button type="button" onClick={saveConversationToPersonal} className="heroDepositButton"><PlusIcon style={{ width: 12, height: 12 }} /> 保存到个人知识</button><button type="button" onClick={openChatDeposit} className="heroDepositButton"><DiamondIcon style={{ width: 12, height: 12 }} /> 沉淀为MD/Skill</button></div></div></div>}{messages.map((m, i) => <div className={`message ${m.who}`} key={i}>{m.who === "bot" && <span className="miniAvatar">AI</span>}{m.who === "user" && <span className="miniAvatar userAvatar">{displayName.slice(0,1)}</span>}<div><p>{m.text}</p>{m.modelUsed&&<small>本次使用：{m.modelUsed}</small>}{m.sources?.length ? <small>引用资料：{m.sources.join("、")}</small> : null}{m.sourceFiles?.length?<div className="chatSources">{m.sourceFiles.map(file=><a key={file.id} href={`/api/state?download=${file.id}`}><b>{file.filename||file.title}</b><span>{file.category} · V{file.version} · {file.status}</span><em>下载</em></a>)}</div>:null}<button className="messageKnowledgeButton" type="button" onClick={()=>saveMessageToPersonal(m,i)}><PlusIcon style={{ width: 12, height: 12 }} /> 存入个人知识</button></div></div>)}{busy && <div className="message bot"><span className="miniAvatar">AI</span><div><p>{activeAgent?"正在按智能体配置处理…":knowledgeMode==="knowledge"?"正在检索个人与企业知识并生成回答…":"AI 正在生成原生回答…"}</p></div></div>}</div>
          <div className={`chatWorkflowLauncher ${workflowLauncherCollapsed?"collapsed":""}`}><div className="workflowLauncherHead"><div><div className="collapsibleTitle"><b><RefreshIcon style={{ width: 14, height: 14 }} /> 把任务交给自动化工作流</b><button type="button" onClick={()=>setWorkflowLauncherCollapsed(value=>!value)}>{workflowLauncherCollapsed?"展开":"收起"} {workflowLauncherCollapsed?<ChevronDownIcon style={{ width: 12, height: 12 }} />:<ChevronUpIcon style={{ width: 12, height: 12 }} />}</button></div></div></div>{!workflowLauncherCollapsed&&<div className="workflowLauncherControls"><select value={chatWorkflowId} onChange={e=>setChatWorkflowId(e.target.value)}><option value="">选择已启用工作流</option>{workflows.filter(item=>item.status!=="停用").map(item=><option key={item.id} value={item.id}>#{item.id} · {item.name}</option>)}</select><button type="button" disabled={busy||!chatWorkflowId} onClick={runWorkflowInChat}>运行所选工作流</button></div>}</div>
          <form className="composer" onSubmit={e => send(e)}><div className="knowledgeMode" aria-label="回答方式"><button type="button" className={knowledgeMode==="native"?"active":""} onClick={()=>setKnowledgeMode("native")}>AI 原生回答</button><button type="button" className={knowledgeMode==="knowledge"?"active":""} onClick={()=>setKnowledgeMode("knowledge")}>结合知识库回答</button><label className="chatFileButton"><input type="file" multiple accept=".doc,.docx,.xls,.xlsx,.ppt,.pptx,.pdf,.md,.txt,.csv,.json,.xml,.png,.jpg,.jpeg,.webp,.gif" onChange={event=>{addChatFiles(event.target.files); event.currentTarget.value = "";}}/><PlusIcon style={{ width: 12, height: 12 }} /> 上传附件</label></div>{chatAttachments.length ? <div className="chatAttachmentTray">{chatAttachments.map(item=><div className="chatAttachmentItem" key={item.id}><div><b>{item.name}</b><span>{formatFileSize(item.size)} · {item.note}</span></div><select value={item.mode} onChange={event=>setChatAttachments(items=>items.map(file=>file.id===item.id?{...file,mode:event.target.value as ChatAttachment["mode"]}:file))}><option value="round">仅本轮使用</option><option value="personal">存个人知识</option><option value="enterprise">同步企业知识</option></select><button type="button" onClick={()=>setChatAttachments(items=>items.filter(file=>file.id!==item.id))}>删除</button></div>)}</div> : null}<textarea rows={1} value={input} onChange={e => setInput(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();e.currentTarget.form?.requestSubmit()}}} placeholder={conversationId?"向企业助手提问，或直接上传附件…":"默认任务正在准备…"} aria-label="聊天内容" disabled={!conversationId}/><button disabled={busy||!conversationId||attachmentBusy}>{attachmentBusy?"…":<ArrowRightIcon style={{ width: 16, height: 16 }} />}</button><small>{knowledgeMode==="knowledge"?"将检索个人知识及有权限的企业知识，再结合模型回答":"直接使用所选模型的原生能力回答，不检索知识库"}{chatAttachments.length?" · 附件会随本轮问题一起提交":""}</small></form></> :
          askMode==="guided" ? <form className="promptGuide" onSubmit={sendGuided}><div className="guideIntro"><div><b>不会写提示词？按业务填写即可</b><p>只填“任务”也能使用，其他内容越完整，结果越准确。</p></div><button type="button" onClick={()=>setAskMode("quick")}>返回聊天</button></div><div className="templateBar"><span>常用模板</span>{(["宣传文案","会议纪要","数据分析","客户回复"] as const).map(t=><button type="button" key={t} onClick={()=>applyPromptTemplate(t)}>{t}</button>)}</div><div className="guideGrid">
            <label><span>1. 希望AI扮演谁 <i>Role</i></span><input value={guide.role} onChange={e=>setGuide({...guide,role:e.target.value})} placeholder="例如：企业品牌宣传专员"/></label>
            <label className="required"><span>2. 要完成什么 <i>Task</i></span><textarea required value={guide.task} onChange={e=>setGuide({...guide,task:e.target.value})} placeholder="例如：写一份新产品发布通知"/></label>
            <label><span>3. 有哪些背景资料 <i>Context</i></span><textarea value={guide.context} onChange={e=>setGuide({...guide,context:e.target.value})} placeholder="产品、客户、使用场景、已有资料…"/></label>
            <label><span>4. 有哪些要求或禁区 <i>Constraint</i></span><textarea value={guide.constraint} onChange={e=>setGuide({...guide,constraint:e.target.value})} placeholder="字数、语气、不能编造的内容…"/></label>
            <label><span>5. 希望怎么输出 <i>Format</i></span><input value={guide.format} onChange={e=>setGuide({...guide,format:e.target.value})} placeholder="例如：标题 + 正文 + 表格"/></label>
            <label><span>6. 有没有参考示例 <i>Example</i></span><input value={guide.example} onChange={e=>setGuide({...guide,example:e.target.value})} placeholder="例如：专业、简洁、类似公司公文"/></label>
          </div><div className="promptPreview"><b>系统将自动整理为完整提示词</b><p>{guide.task ? [guide.role,guide.task,guide.context,guide.constraint,guide.format,guide.example].filter(Boolean).join(" ｜ ") : "选择模板或填写任务后，这里会显示内容摘要。"}</p><button disabled={busy}>{busy?"正在生成…":"提交给企业助手 →"}</button></div></form> :
          <form className="continuousGuide" onSubmit={createContinuousTask}><div className="guideIntro"><div><b>创建一个会持续工作的AI任务</b><p>选择运行方式和判断标准，确认后由自动化工作流托管。</p></div></div><div className="loopCards">{[
            ["回合制","AI通过多轮询问和沟通完成","需求访谈、方案讨论"],["目标制","AI持续执行直到达到目标","整理线索、优化方案"],["定时制","按照固定时间重复执行","日报、周报、舆情监测"],["主动制","发现事件或异常后主动执行","投诉提醒、指标异常"],
          ].map(x=><button type="button" key={x[0]} className={continuous.loopType===x[0]?"selected":""} onClick={()=>setContinuous({...continuous,loopType:x[0],triggerType:x[0]==="定时制"?"每日定时":x[0]==="主动制"?"事件触发":"手动触发"})}><b>{x[0]}</b><span>{x[1]}</span><small>{x[2]}</small></button>)}</div><div className="continuousGrid"><label>任务名称<input required value={continuous.name} onChange={e=>setContinuous({...continuous,name:e.target.value})} placeholder="例如：每日重点客户整理"/></label><label>触发方式<select value={continuous.triggerType} onChange={e=>setContinuous({...continuous,triggerType:e.target.value})}><option>手动触发</option><option>收到消息</option><option>每日定时</option><option>每周定时</option><option>事件触发</option></select></label>{continuous.loopType==="定时制"&&<label>每天运行时间（北京时间）<input required type="time" value={continuous.scheduleTime} onChange={e=>setContinuous({...continuous,scheduleTime:e.target.value})}/></label>}{continuous.loopType==="主动制"&&<><label className="wide">事件源<select value={continuous.watchSourceType} onChange={e=>setContinuous({...continuous,watchSourceType:e.target.value,watchSourceRef:""})}><option value="free">通用观察（AI 依据任务目标判断）</option><option value="data_source">指定数据源（周期检查最新采集结果）</option><option value="inbound_message">渠道消息（收到飞书/钉钉/企微消息时评估）</option></select></label>{continuous.watchSourceType==="data_source"&&<label>监测数据源<select required value={continuous.watchSourceRef} onChange={e=>setContinuous({...continuous,watchSourceRef:e.target.value})}><option value="">请选择数据源</option>{sources.map(item=><option key={item.id} value={item.id}>#{item.id} · {item.name}</option>)}</select></label>}{continuous.watchSourceType==="inbound_message"&&<label>监听平台<select required value={continuous.watchSourceRef} onChange={e=>setContinuous({...continuous,watchSourceRef:e.target.value})}><option value="">请选择平台</option>{connectors.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}{continuous.watchSourceType!=="inbound_message"&&<label>检查间隔（分钟）<input type="number" min="1" max="1440" value={continuous.checkInterval} onChange={e=>setContinuous({...continuous,checkInterval:e.target.value})}/></label>}<label className="wide">触发条件<textarea required value={continuous.triggerCondition} onChange={e=>setContinuous({...continuous,triggerCondition:e.target.value})} placeholder="用一句话描述什么情况下该触发。例如：出现客户投诉或负面反馈；或某指标较上次明显下降。"/></label></>}<label className="wide">任务目标<textarea required value={continuous.goal} onChange={e=>setContinuous({...continuous,goal:e.target.value})} placeholder="例如：每天整理新增客户，并找出最值得跟进的10个客户。"/></label></div><div className="reviewChoice"><b>你是否清楚什么结果算合格？</b><div><button type="button" className={continuous.reviewMode==="明确标准"?"selected":""} onClick={()=>setContinuous({...continuous,reviewMode:"明确标准"})}>我知道合格标准<small>按规则自动检查和返工</small></button><button type="button" className={continuous.reviewMode==="探索标准"?"selected":""} onClick={()=>setContinuous({...continuous,reviewMode:"探索标准"})}>让AI先探索并提出标准<small>提出假设、寻找证据，再由人工确认</small></button></div></div><div className="continuousGrid"><label className="wide">{continuous.reviewMode==="明确标准"?"合格标准":"希望AI探索什么"}<textarea required value={continuous.reviewStandard} onChange={e=>setContinuous({...continuous,reviewStandard:e.target.value})} placeholder={continuous.reviewMode==="明确标准"?"例如：名称、需求和来源必须完整，不得编造联系方式。":"例如：找出客户流失的可能原因，并用业务数据验证。"}/></label><label>停止条件<input required value={continuous.stopCondition} onChange={e=>setContinuous({...continuous,stopCondition:e.target.value})} placeholder="例如：完成10条合格记录"/></label><label>最大循环次数<input type="number" min="1" max="10" value={continuous.maxLoops} onChange={e=>setContinuous({...continuous,maxLoops:e.target.value})}/></label><label>完成后<select value={continuous.finalAction} onChange={e=>setContinuous({...continuous,finalAction:e.target.value})}><option>提交管理员审批</option><option>通知负责人</option><option>保存结果不执行</option></select></label><label>失败后<select value={continuous.failureAction} onChange={e=>setContinuous({...continuous,failureAction:e.target.value})}><option>通知负责人</option><option>转人工处理</option><option>暂停任务</option></select></label></div><div className="taskConfirm"><div><b>{continuous.name||"待命名的持续任务"}</b><p>{continuous.loopType} · {continuous.reviewMode} · 最多{continuous.maxLoops}次 · {continuous.finalAction}</p></div><button>确认并创建 →</button></div></form>}
        </section>
        <aside className={`insightPanel ${insightCollapsed?"collapsed":""}`}><div className="insightTitle"><h3>当前运行状态</h3><button type="button" onClick={()=>setInsightCollapsed(value=>!value)} title={insightCollapsed?"展开运行状态":"收起运行状态"}>{insightCollapsed?<ChevronLeftIcon style={{ width: 12, height: 12 }} />:<ChevronRightIcon style={{ width: 12, height: 12 }} />}<span>{insightCollapsed?"展开":"收起"}</span></button></div>{!insightCollapsed&&<><div className="controlCard"><span>身份权限</span><b>{role}</b></div><div className="controlCard"><span>企业资料</span><b>{docs.length} 份</b></div><div className="controlCard"><span>审计记录</span><b>{logs.length} 条</b></div><button className="viewAudit" onClick={() => setTab("logs")}>查看审计记录 →</button></>}</aside>
      </div>}

      {tab === "media" && <MediaPanel />}

      {tab === "artifacts" && <section className="artifactsLayout pageFill">
        <aside className="artifactsSidebar">
            <div className="sideBlock">
              <h2>沉淀中心</h2>
            </div>
            <ArtifactUploadPanel onDone={() => { loadArtifacts(); loadArtifactResources(); }} setNotice={setNotice}/>
            <div className="sideBlock metricsBlock">
              <article><span>可复用沉淀</span><b>{artifactCounts.total}</b></article>
              <article><span>Markdown</span><b>{artifactCounts.markdown}</b></article>
              <article><span>Skill</span><b>{artifactCounts.skill}</b></article>
            </div>
            {appRole === "管理员" && <div className="sideBlock filterBlock">
              <label>按用户筛选<select value={artifactOwner} onChange={event => { setArtifactOwner(event.target.value); loadArtifacts(1, event.target.value); }}><option>全部用户</option>{artifactOwners.map(owner => <option key={owner}>{owner}</option>)}</select></label>
            </div>}
            {!!visibleArtifacts.length && <div className="sideBlock bulkBlock">
              <span>批量操作</span>
              <label><input type="checkbox" checked={visibleArtifacts.every(item => selectedArtifactIds.includes(item.id))} onChange={event => setAllSelectedIds(visibleArtifacts.map(item => item.id), setSelectedArtifactIds, event.target.checked)}/>全选</label>
              <button className="dangerButton" disabled={!selectedArtifactIds.length} onClick={deleteSelectedArtifacts}>删除选中（{selectedArtifactIds.length}）</button>
            </div>}
          </aside>
          <main className="artifactsMain">
            <div className="artifactsHeader">
              <h2>{appRole === "管理员" ? "企业沉淀" : "我的沉淀"}</h2>
              <small>{artifactsTotal} 项 · 按更新时间倒序</small>
            </div>
            <div className="artifactGrid">{visibleArtifacts.map(item => <article className="artifactCard" key={item.id}>
              <div className="cardColorBar" data-type={item.artifactType}/>
              <div className="cardHead">
                <span className={`artifactKind ${item.artifactType}`}>{item.artifactType === "skill" ? "SKILL" : ".MD"}</span>
                <span className="sourceBadge">{item.sourceType === "loop" ? "持续任务" : item.sourceType === "upload" ? "上传文件" : "聊天记录"}</span>
                <label className="cardSelect" title="选择该项">
                  <input type="checkbox" checked={selectedArtifactIds.includes(item.id)} onChange={() => toggleSelectedId(selectedArtifactIds, setSelectedArtifactIds, item.id)}/>
                </label>
              </div>
              <h3 className="cardTitle">{item.title}</h3>
              <p className="cardPreview">{item.content.replace(/[#>*_-]/g, " ").slice(0, 180)}{item.content.length > 180 ? "…" : ""}</p>
              <div className="cardMeta">
                <span>{appRole === "管理员" ? item.ownerEmail : "我的"}</span>
                <time>{new Date(item.updatedAt).toLocaleString("zh-CN")}</time>
              </div>
              <div className="cardActions">
                <button onClick={() => reuseArtifact(item)}><ArrowUpRightIcon style={{ width: 12, height: 12 }} /> 复用</button>
                <button className="outline" onClick={() => downloadMarkdown(item)}>下载</button>
                <button className="dangerLink" onClick={() => deleteArtifact(item)}>删除</button>
              </div>
            </article>)}</div>
            <Pager page={artifactsPage} pageSize={ARTIFACTS_PAGE_SIZE} total={artifactsTotal} onChange={next => loadArtifacts(next)} />
            {!artifactsTotal && <div className="emptyState big">
              <b>还没有沉淀内容</b>
              <small>把对话整理为 Markdown 或 Skill，或在左侧拖入 .md / .skill / .txt 文件开始沉淀。</small>
            </div>}
          </main>
      </section>}

      {tab === "monitoring" && <MonitoringPanel setNotice={setNotice} />}

      {tab === "contracts" && <ContractsPanel isAdmin={appRole==="管理员"} setNotice={setNotice} />}

      {tab === "help" && <HelpPanel />}

      {tab === "knowledge" && <KnowledgePanel docs={docs} personalKnowledge={personalKnowledge} knowledgeView={knowledgeView} knowledgeQuery={knowledgeQuery} knowledgeCategory={knowledgeCategory} selectedKnowledgeIds={selectedKnowledgeIds} selectedPersonalKnowledgeIds={selectedPersonalKnowledgeIds} appRole={appRole} userEmail={userEmail} setDocs={setDocs} setNotice={setNotice} setKnowledgeView={setKnowledgeView} setKnowledgeQuery={setKnowledgeQuery} setKnowledgeCategory={setKnowledgeCategory} setSelectedKnowledgeIds={setSelectedKnowledgeIds} setSelectedPersonalKnowledgeIds={setSelectedPersonalKnowledgeIds} setShowUpload={setShowUpload} setShowPersonalKnowledge={setShowPersonalKnowledge} setViewingKnowledge={setViewingKnowledge} setInput={setInput} setTab={setTab} setAskMode={setAskMode} loadState={loadState} loadGovernance={loadGovernance} loadPersonalKnowledge={loadPersonalKnowledge} deleteBatch={deleteBatch} toggleSelectedId={toggleSelectedId} setAllSelectedIds={setAllSelectedIds} downloadKnowledgeText={downloadKnowledgeText} />}

      {tab === "organization" && <OrganizationPanel orgUnits={orgUnits} orgMembers={orgMembers} orgOwner={orgOwner} myMember={myMember} reminders={reminders} transfers={transfers} orgReports={orgReports} reportRecipients={reportRecipients} selectedUnitId={selectedUnitId} memberQuery={memberQuery} appRole={appRole} userEmail={userEmail} setSelectedUnitId={setSelectedUnitId} setMemberQuery={setMemberQuery} setOrgModal={setOrgModal} setEditingUnit={setEditingUnit} setEditingMember={setEditingMember} setNotice={setNotice} loadOrganization={loadOrganization} loadGovernance={loadGovernance} loadState={loadState} />}

      {tab === "agents" && <AgentsPanel agents={agents} agentRuns={agentRuns} activeAgent={activeAgent} selectedAgentIds={selectedAgentIds} setSelectedAgentIds={setSelectedAgentIds} setAllSelectedIds={setAllSelectedIds} toggleSelectedId={toggleSelectedId} setModalType={setModalType} agentSettings={agentSettings} startAgent={startAgent} deleteModule={deleteModule} deleteSelectedModules={deleteSelectedModules} loadModules={loadModules} />}

      {tab === "workflows" && <WorkflowsPanel workflows={workflows} workflowRuns={workflowRuns} selectedWorkflowIds={selectedWorkflowIds} runWorkflow={runWorkflow} runningWorkflow={runningWorkflow} setRunningWorkflow={setRunningWorkflow} runInput={runInput} selectedRun={selectedRun} setModalType={setModalType} setSelectedWorkflowIds={setSelectedWorkflowIds} setRunWorkflow={setRunWorkflow} setRunInput={setRunInput} setSelectedRun={setSelectedRun} chooseWorkflowTemplate={chooseWorkflowTemplate} setAllSelectedIds={setAllSelectedIds} toggleSelectedId={toggleSelectedId} deleteSelectedModules={deleteSelectedModules} runModule={runModule} deleteModule={deleteModule} loadModules={loadModules} setNotice={setNotice} loadState={loadState} loadGovernance={loadGovernance} loadArtifacts={async () => { await Promise.all([loadArtifacts(), loadArtifactResources()]); }} />}

      {tab === "data" && <CollectionPanel sources={sources} collectionRuns={collectionRuns} selectedSourceIds={selectedSourceIds} selectedCollectionRunIds={selectedCollectionRunIds} selectedCollectionRun={selectedCollectionRun} runningSourceId={runningSourceId} cleaningRules={cleaningRules} cleanedPreview={cleanedPreview} showCleaning={showCleaning} localCleaningFile={localCleaningFile} localCleaningBusy={localCleaningBusy} setSelectedSourceIds={setSelectedSourceIds} setSelectedCollectionRunIds={setSelectedCollectionRunIds} setSelectedCollectionRun={setSelectedCollectionRun} setRunningSourceId={setRunningSourceId} setCleaningRules={setCleaningRules} setCleanedPreview={setCleanedPreview} setShowCleaning={setShowCleaning} setLocalCleaningFile={setLocalCleaningFile} setLocalCleaningBusy={setLocalCleaningBusy} setCollectionRuns={setCollectionRuns} setNotice={setNotice} setAllSelectedIds={setAllSelectedIds} toggleSelectedId={toggleSelectedId} runModule={runModule} deleteModule={deleteModule} deleteSelectedModules={deleteSelectedModules} loadModules={loadModules} loadState={loadState} loadPersonalKnowledge={loadPersonalKnowledge} deleteBatch={deleteBatch} modelModeLabel={modelModeLabel} newSourceTask={newSourceTask} openSourceEditor={openSourceEditor} />}

      {tab === "approvals" && <ApprovalsPanel approvals={approvals} appRole={appRole} userEmail={userEmail} orgOwner={orgOwner} setShowApproval={setShowApproval} setNotice={setNotice} loadGovernance={loadGovernance} loadState={loadState} />}

      {tab === "permissions" && <PermissionsPanel permissions={permissions} permissionDrafts={permissionDrafts} setPermissionDrafts={setPermissionDrafts} permissionDirty={permissionDirty} setPermissionDirty={setPermissionDirty} setNotice={setNotice} loadGovernance={loadGovernance} loadState={loadState} capabilityCatalog={capabilityCatalog} capabilityGroups={capabilityGroups} permissionRoles={permissionRoles} />}

      {tab === "logs" && <AuditLogsPanel logs={logs} setLogs={setLogs} selectedLogIds={selectedLogIds} setSelectedLogIds={setSelectedLogIds} setNotice={setNotice} loadState={loadState} />}

      {tab === "models" && <ModelsPanel modelStatus={modelStatus} selectedPresetModels={selectedPresetModels} setSelectedPresetModels={setSelectedPresetModels} presetApiKey={presetApiKey} setPresetApiKey={setPresetApiKey} addingPresetModels={addingPresetModels} setAddingPresetModels={setAddingPresetModels} showCustomModel={showCustomModel} setShowCustomModel={setShowCustomModel} editingModel={editingModel} setEditingModel={setEditingModel} testingModel={testingModel} setTestingModel={setTestingModel} selectedModelConnectionIds={selectedModelConnectionIds} setSelectedModelConnectionIds={setSelectedModelConnectionIds} modelMode={modelMode} setModelMode={setModelMode} setNotice={setNotice} loadModelStatus={loadModelStatus} deleteBatch={deleteBatch} setAllSelectedIds={setAllSelectedIds} toggleSelectedId={toggleSelectedId} />}

      {tab === "profile" && <ProfilePanel profileInfo={profileInfo} userEmail={userEmail} displayName={displayName} appRole={appRole} role={role} passwordForm={passwordForm} setPasswordForm={setPasswordForm} setNotice={setNotice} />}

      {tab === "connectors" && <ConnectorsPanel connectors={connectors} setConnectors={setConnectors} testingConnector={testingConnector} setTestingConnector={setTestingConnector} setConnectorMode={setConnectorMode} setGatewaySecret={setGatewaySecret} setConnectorHelp={setConnectorHelp} connectorLiveTests={connectorLiveTests} setConnectorLiveTests={setConnectorLiveTests} savingConnectorModel={savingConnectorModel} setSavingConnectorModel={setSavingConnectorModel} connectorModelDrafts={connectorModelDrafts} setConnectorModelDrafts={setConnectorModelDrafts} modelStatus={modelStatus} setNotice={setNotice} loadConnectors={loadConnectors} />}

      {tab === "users" && <UsersPanel users={users} setNotice={setNotice} loadSession={loadSession} />}
      </div>
    </section>
    {orgModal==="unit"&&<div className="modalBackdrop" onMouseDown={()=>{setOrgModal(null);setEditingUnit(null)}}><form className="modal" onSubmit={e=>submitOrganization(e,editingUnit?"updateUnit":"createUnit")} onMouseDown={e=>e.stopPropagation()}><input type="hidden" name="id" value={editingUnit?.id||""}/><div className="modalHead"><div><h2>{editingUnit?"编辑组织节点":"新增组织节点"}</h2><p>可以修改名称、节点类型、上级组织、负责人和显示顺序。</p></div><button type="button" onClick={()=>{setOrgModal(null);setEditingUnit(null)}}>×</button></div><label>组织名称<input name="name" required defaultValue={editingUnit?.name||""} placeholder="例如：销售部、销售主管组"/></label><label>节点类型<select name="unitType" defaultValue={editingUnit?.unitType||"部门"}><option>公司</option><option>部门</option><option>岗位组</option></select></label><label>上级组织<select name="parentId" defaultValue={editingUnit?.parentId||""}><option value="">无（直接归属老板）</option>{orgUnits.filter(unit=>unit.id!==editingUnit?.id).map(unit=><option key={unit.id} value={unit.id}>{"　".repeat(unitDepth(unit))}{unit.name}</option>)}</select></label><label>负责人邮箱<input name="managerEmail" type="email" defaultValue={editingUnit?.managerEmail||""} placeholder="例如：manager@company.com"/></label><label>排序<input name="sortOrder" type="number" defaultValue={editingUnit?.sortOrder||0}/></label><div className="modalActions"><button type="button" className="outline" onClick={()=>{setOrgModal(null);setEditingUnit(null)}}>取消</button><button>{editingUnit?"保存修改":"保存组织节点"}</button></div></form></div>}
    {orgModal==="member"&&<div className="modalBackdrop" onMouseDown={()=>{setOrgModal(null);setEditingMember(null)}}><form className="modal" onSubmit={e=>submitOrganization(e,"assignMember")} onMouseDown={e=>e.stopPropagation()}><div className="modalHead"><div><h2>{editingMember?"调整成员岗位":"分配成员或转岗"}</h2><p>管理员可把已注册账号放入指定部门，并设置岗位和直属上级。</p></div><button type="button" onClick={()=>{setOrgModal(null);setEditingMember(null)}}>×</button></div><label>成员邮箱<select name="email" required defaultValue={editingMember?.email||""} disabled={!!editingMember}><option value="">请选择注册用户</option>{users.map(user=><option key={user.email}>{user.email}</option>)}</select>{editingMember&&<input type="hidden" name="email" value={editingMember.email}/>}</label><label>所属组织<select name="unitId" required defaultValue={editingMember?.unitId||""}><option value="">请选择组织</option>{orgUnits.map(unit=><option key={unit.id} value={unit.id}>{"　".repeat(unitDepth(unit))}{unit.name}</option>)}</select></label><label>岗位名称<input name="jobTitle" required defaultValue={editingMember?.jobTitle||""} placeholder="例如：销售主管、副主管、业务员"/></label><label>直属上级邮箱<input name="directManagerEmail" type="email" defaultValue={editingMember?.directManagerEmail||""} placeholder="不填则按部门负责人逐级汇报"/></label><div className="modalActions"><button type="button" className="outline" onClick={()=>{setOrgModal(null);setEditingMember(null)}}>取消</button><button>保存岗位关系</button></div></form></div>}
    {orgModal==="transfer"&&<div className="modalBackdrop" onMouseDown={()=>setOrgModal(null)}><form className="modal" onSubmit={e=>submitOrganization(e,"requestTransfer")} onMouseDown={e=>e.stopPropagation()}><div className="modalHead"><div><h2>{myMember?"申请转岗":"选择加入部门"}</h2><p>提交后进入审批，批准后部门资料权限和汇报关系自动切换。</p></div><button type="button" onClick={()=>setOrgModal(null)}>×</button></div>{myMember&&<div className="currentPlacement"><span>当前岗位</span><b>{myMember.unitName} · {myMember.jobTitle}</b></div>}<label>目标组织<select name="toUnitId" required><option value="">请选择</option>{orgUnits.map(unit=><option key={unit.id} value={unit.id}>{"　".repeat(unitDepth(unit))}{unit.name}</option>)}</select></label><label>申请岗位<input name="jobTitle" required placeholder="例如：业务员、营销专员"/></label><label>申请原因<textarea name="reason" rows={5} required placeholder="说明加入部门或转岗原因"/></label><div className="modalActions"><button type="button" className="outline" onClick={()=>setOrgModal(null)}>取消</button><button>提交审批</button></div></form></div>}
    {orgModal==="report"&&<div className="modalBackdrop" onMouseDown={()=>setOrgModal(null)}><form className="modal reportModal" onSubmit={e=>submitOrganization(e,"createReport")} onMouseDown={e=>e.stopPropagation()}><div className="modalHead"><div><h2>向上级汇报</h2><p>只能选择组织链上的直属主管或上级负责人，AI可把原始记录整理为管理摘要。</p></div><button type="button" onClick={()=>setOrgModal(null)}>×</button></div><label>汇报对象<select name="recipientEmail" required><option value="">选择上级管理者</option>{reportRecipients.map(email=><option key={email}>{email}</option>)}</select></label><label>汇报标题<input name="title" required placeholder="例如：本周重点客户进展与需决策事项"/></label><label>原始汇报内容<textarea name="content" rows={8} required placeholder="写明完成事项、关键数据、风险、需要上级决定的内容…"/></label><div className="uploadGrid"><label>重要程度<select name="importance"><option>普通</option><option>重要</option></select></label><label>@ 同部门成员<select name="mentionEmail"><option value="">不@成员</option>{orgMembers.filter(member=>member.unitId===myMember?.unitId&&member.email!==userEmail).map(member=><option key={member.email} value={member.email}>{member.jobTitle} · {member.email}</option>)}</select></label><label className="wide">附带知识文件<select name="attachmentDocumentId"><option value="">不附带</option>{docs.map(doc=><option key={doc.id} value={doc.id}>{doc.title}</option>)}</select></label></div><label className="aiReportChoice"><input name="useAi" type="checkbox" defaultChecked/><span><b>让AI整理后再汇报</b><small>保留原文，同时生成管理摘要、风险和待决策事项</small></span></label><div className="modalActions"><button type="button" className="outline" onClick={()=>setOrgModal(null)}>取消</button><button>提交汇报</button></div></form></div>}
    {showUpload && <div className="modalBackdrop" onMouseDown={() => { if (!uploading) { setShowUpload(false); setUploadFiles([]); setUploadMode("file"); } }}><form className="modal knowledgeUploadModal" onSubmit={upload} onMouseDown={e=>e.stopPropagation()}><div className="modalHead"><div><h2>上传企业知识</h2><p>可批量上传办公文件、图片和 Markdown，也可以直接粘贴文本创建知识。</p></div><button type="button" disabled={uploading} onClick={() => { setShowUpload(false); setUploadFiles([]); setUploadMode("file"); }}>×</button></div>
    <div className="uploadModeTabs"><button type="button" className={uploadMode==="file"?"active":""} onClick={()=>setUploadMode("file")}>上传文件</button><button type="button" className={uploadMode==="text"?"active":""} onClick={()=>setUploadMode("text")}>直接创建文本</button></div>
    <div className="uploadModalBody">
      <div className="uploadLeftPanel">
        {uploadMode==="file" ? (<>
          <input id="uploadFileInput" name="files" type="file" multiple accept=".doc,.docx,.xls,.xlsx,.ppt,.pptx,.pdf,.md,.txt,.csv,.json,.xml,.png,.jpg,.jpeg,.webp,.gif" onChange={event => { const list = Array.from(event.target.files || []).map(file => ({ name: file.name, size: file.size, type: file.type })); setUploadFiles(list); }} disabled={uploading}/>
          <div className="fileDrop" role="button" tabIndex={0} onClick={() => { if (!uploading) document.getElementById("uploadFileInput")?.click(); }} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); if (!uploading) document.getElementById("uploadFileInput")?.click(); } }}>
            <div className="fileDropIcon">▤</div>
            <b>选择或拖入文件</b>
            <span>Word、Excel、PPT、PDF、MD、CSV、TXT、JSON 及常见图片 · 单个不超过 15MB</span>
          </div>
          {uploadFiles.length > 0 && (<div className="uploadFileList">
            <div className="uploadFileListHead">已选择 {uploadFiles.length} 个文件</div>
            {uploadFiles.map((file, index) => { const ext = (file.name.split(".").pop() || "").toLowerCase(); const icon = /^(png|jpg|jpeg|webp|gif)$/.test(ext) ? "▧" : /^(xlsx|csv)$/.test(ext) ? "▦" : /^(pdf)$/.test(ext) ? "▢" : "▤"; return (<div className="uploadFileItem" key={index}><span className="uploadFileIcon">{icon}</span><div className="uploadFileInfo"><b title={file.name}>{file.name}</b><small>{file.size > 1024 * 1024 ? (file.size / 1024 / 1024).toFixed(2) + " MB" : Math.max(1, Math.round(file.size / 1024)) + " KB"}</small></div></div>); })}
          </div>)}
        </>) : (<div className="textModePanel">
          <label>资料名称<input name="title" placeholder="例如：2026 产品介绍" disabled={uploading}/></label>
          <label>资料内容<textarea name="content" rows={8} placeholder="在这里粘贴正文内容…" disabled={uploading}/></label>
          <label className="polishToggle"><input type="checkbox" name="polish" value="1" disabled={uploading}/>让 AI 整理格式后再保存<small>不勾选则原文保存，一个字都不改。勾选后由 AI 整理成结构清晰的 Markdown，只调整排版、保留原始事实；整理不成功会自动按原文保存。</small></label>
        </div>)}
        {uploading && (<div className="uploadProgressBox"><div className="uploadProgressBar" style={{ width: uploadProgress + "%" }} /><small>{uploadProgress < 100 ? "正在上传…" : "处理中…"} {Math.round(uploadProgress)}%</small></div>)}
      </div>
      <div className="uploadRightPanel">
        <div className="uploadSection"><div className="uploadSectionHead">基础信息</div>
          {uploadMode==="file" && (<label>资料名称<input name="title" placeholder="可选，默认取文件名" disabled={uploading}/></label>)}
          <div className="uploadGrid">
            <label>业务分类<select name="category" disabled={uploading}>{["行政制度","人事资料","产品资料","销售方案","客户项目","企业宣传","财务制度","培训资料","其他"].map(x=><option key={x}>{x}</option>)}</select></label>
            <label>所属部门<select name="departmentId" defaultValue={myMember?.unitId||""} disabled={uploading}><option value="">按当前用户部门</option>{orgUnits.map(unit=><option key={unit.id} value={unit.id}>{unit.name}</option>)}</select></label>
          </div>
          <label>标签<input name="tags" placeholder="例如：产品A, 华东区, 2026" disabled={uploading}/></label>
        </div>
        <div className="uploadSection"><div className="uploadSectionHead">权限与可见性</div>
          <div className="uploadGrid">
            <label>可见范围<select name="visibility" disabled={uploading}><option>部门</option><option>全员</option><option>销售经理</option><option>市场专员</option></select></label>
          </div>
        </div>
        <div className="uploadSection"><div className="uploadSectionHead">更新策略</div>
          <div className="uploadGrid">
            <label>更新方式<select name="updateMode" disabled={uploading}><option>手动更新</option><option>每日检查</option><option>每周检查</option><option>每月检查</option><option>源文件变化时</option></select></label>
          </div>
          <label>更新说明<input name="updateSchedule" placeholder="例如：每周一 09:00 检查官网，变化后由负责人确认发布" disabled={uploading}/></label>
        </div>
      </div>
    </div>
    <div className="modalActions"><button type="button" className="outline" disabled={uploading} onClick={() => { setShowUpload(false); setUploadFiles([]); setUploadMode("file"); }}>取消</button><button type="submit" disabled={uploading}>{uploading ? "上传中…" : uploadMode==="file" ? "上传并进入知识库" : "创建知识"}</button></div></form></div>}
    {viewingKnowledge && <div className="modalBackdrop" onMouseDown={()=>setViewingKnowledge(null)}><div className="modal knowledgeViewer" onMouseDown={e=>e.stopPropagation()}><div className="modalHead"><div><h2>{viewingKnowledge.title}</h2><p>{viewingKnowledge.meta}</p></div><button type="button" onClick={()=>setViewingKnowledge(null)}>×</button></div><pre>{viewingKnowledge.content}</pre><div className="modalActions"><button type="button" className="outline" onClick={()=>setViewingKnowledge(null)}>关闭</button><button type="button" onClick={()=>downloadKnowledgeText(viewingKnowledge.downloadName,viewingKnowledge.content)}>下载文件</button></div></div></div>}
    {showPersonalKnowledge && <div className="modalBackdrop" onMouseDown={()=>setShowPersonalKnowledge(false)}><form className="modal knowledgeUpload" onSubmit={createPersonalKnowledge} onMouseDown={e=>e.stopPropagation()}><div className="modalHead"><div><h2>新建个人知识</h2><p>可批量上传 PDF、Word、Excel、PPT、Markdown、Skill 等文件，也可以直接粘贴正文内容。</p></div><button type="button" onClick={()=>setShowPersonalKnowledge(false)}>×</button></div><label className="fileDrop"><input name="files" type="file" multiple accept=".md,.markdown,.skill,.txt,.csv,.json,.xml,.html,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.png,.jpg,.jpeg,.webp,.gif"/><b>选择或拖入文件</b><span>PDF、Word、Excel、PPT、MD、Skill、CSV、TXT 及常见图片 · 单个不超过30MB</span></label><div className="uploadDivider"><span>或者直接创建一份个人知识</span></div><label>知识名称<input name="title" placeholder="未选择文件时填写，例如：客户跟进要点"/></label><label>知识内容<textarea name="content" rows={10} placeholder="未选择文件时，在这里粘贴正文…"/></label><label className="polishToggle"><input type="checkbox" name="polish" value="1"/>让 AI 整理格式后再保存<small>不勾选则原文保存，一个字都不改。勾选后由 AI 整理成结构清晰的 Markdown，只调整排版、保留原始事实；整理不成功会自动按原文保存。</small></label><div className="modalActions"><button type="button" className="outline" onClick={()=>setShowPersonalKnowledge(false)}>取消</button><button type="submit">保存个人知识</button></div></form></div>}
            {modalType && <div className="modalBackdrop" onMouseDown={closeModuleModal}><form className={`modal ${modalType==="source"?"sourceBuilder":modalType==="agent"?"agentBuilderModal":""}`} onSubmit={saveModule} onMouseDown={e=>e.stopPropagation()}><div className="modalHead"><div><h2>{modalType==="agent"?"创建智能体":modalType==="workflow"?"新建工作流":editingSource?"编辑采集任务":"新建采集任务"}</h2><p>{modalType==="source"?"一次配置后可测试、立即运行，并由采集用户直接确认进入知识库。":modalType==="agent"?"配置模型、提示词、知识、能力和运行规则，保存后直接试聊。":"保存后立即进入企业后台统一管理。"}</p></div><button type="button" onClick={closeModuleModal}>×</button></div>
      <label>名称<input name="name" required defaultValue={modalType==="source" ? (editingSource?.name ?? sourceDraft?.name) || "" : ""} placeholder={modalType==="agent"?"例如：企业宣传助手":modalType==="workflow"?"例如：客户线索整理":"例如：官网公开信息"}/></label>
      {modalType==="agent" && <div className="agentBuilder">
        <div className="agentBuilderIntro"><b>按 5 步完成配置</b><span>保存后可直接试聊，模型、知识和工具都会在运行时真实生效。</span></div>
        <section><h3>1. 基本信息</h3><div className="agentFormGrid"><label>用途说明<input name="description" required placeholder="例如：根据企业资料生成合规宣传内容"/></label><label>开场欢迎语<input name="welcomeMessage" placeholder="用户启动智能体后首先看到的内容"/></label></div></section>
        <section><h3>2. 模型与提示词</h3><div className="agentFormGrid"><label>运行模型<select name="modelMode"><option value="auto">自动选择（推荐）</option><option value="public">企业公共模型</option>{modelStatus?.connections?.map(connection=><option key={connection.id} value={`connection:${connection.id}`}>{formatModelOption(connection)}</option>)}</select></label><label>角色 Role<input name="rolePrompt" placeholder="例如：资深企业宣传顾问"/></label><label>任务 Task<input name="taskPrompt" required placeholder="这个智能体必须完成什么"/></label><label>上下文 Context<input name="contextPrompt" placeholder="业务背景、目标客户、已有资料"/></label><label>约束 Constraint<input name="constraintPrompt" placeholder="禁止事项、字数、范围"/></label><label>格式 Format<input name="formatPrompt" placeholder="例如：标题 + 正文 + 行动建议"/></label><label className="wide">示例 Example<textarea name="examplePrompt" rows={3} placeholder="放一份你认可的结果示例，智能体会按这个标准输出"/></label><label className="wide">补充工作指令（可选）<textarea name="instructions" rows={4} placeholder="结构化提示词之外的长期规则，例如先查知识库、资料不足时明确提示"/></label></div></section>
        <section><h3>3. 知识与权限</h3><div className="agentFormGrid"><label>使用范围<select name="knowledgeScope"><option>全员</option><option>销售经理</option><option>市场专员</option></select></label><label>知识分类<select name="knowledgeCategory"><option>全部分类</option>{Array.from(new Set(docs.map(doc=>doc.category))).filter(Boolean).map(category=><option key={category}>{category}</option>)}</select></label></div><small>运行时仍会按登录账号和所属部门二次校验，智能体不能绕过资料权限。</small></section>
        <section><h3>4. 可调用能力</h3><div className="capabilityGrid">{[["knowledge","检索企业知识","读取当前账号有权限的知识"],["workflow","运行工作流","把任务交给已配置流程"],["data","数据采集","查看采集源与运行状态"],["approval","发起审批","高风险动作提交指定审批人"],["artifacts","调用沉淀","使用个人 Markdown 和 Skill"],["connectors","平台接入","在授权范围内使用飞书、钉钉、企微"]].map(([key,title,desc])=><label key={key}><input type="checkbox" name={`capability_${key}`} defaultChecked={key==="knowledge"||key==="artifacts"}/><span><b>{title}</b><small>{desc}</small></span></label>)}</div></section>
        <section><h3>5. 运行与发布</h3><div className="agentFormGrid"><label>记忆方式<select name="memoryMode"><option>仅当前会话</option><option>允许读取个人沉淀</option><option>无记忆模式</option></select></label><label>审批规则<select name="approvalMode"><option>高风险操作需审批</option><option>所有外部动作需审批</option><option>仅查询不执行动作</option></select></label><label>使用场景<select name="usageScope"><option>企业内部</option><option>指定岗位</option><option>外部客户服务</option></select></label><label>发布到<select name="publishTarget"><option>智能助手</option><option>飞书机器人</option><option>钉钉机器人</option><option>企业微信机器人</option></select></label></div></section>
      </div>}
      {modalType==="workflow" && <><div className="templatePicker"><b>先选一个模板</b><div>{(["宣传","会议","客户","自定义"] as const).map(x=><button type="button" key={x} onClick={()=>chooseWorkflowTemplate(x)}>{x==="宣传"?"企业宣传":x==="会议"?"会议纪要":x==="客户"?"客户跟进":"从空白开始"}</button>)}</div></div><label>触发方式<select name="triggerType"><option>手动触发</option><option>收到消息</option><option>每日定时</option><option>新增业务记录</option></select></label><div className="builder"><div className="builderHead"><div><b>执行步骤</b><small>第一步组织任务，随后分发给顺序或并行AI</small></div><span className="builderLegend"><i/>并行AI任务</span></div>{workflowNodes.map((node,index)=><div className={`builderNode ${node.parallelGroup?"parallelNode":""} ${node.type==="input"?"inputBuilderNode":""}`} key={node.id}><b>{node.parallelGroup?"并":index+1}</b><select value={node.type} disabled={!!node.parallelGroup} onChange={e=>setWorkflowNodes(items=>items.map(x=>x.id===node.id?{...x,type:e.target.value as WorkflowNode["type"],config:""}:x))}><option value="input">接收输入</option><option value="knowledge">知识检索</option><option value="agent">调用智能体</option><option value="data">运行数据采集</option><option value="ai">AI处理</option><option value="review">质量审查</option><option value="approval">人工审批</option><option value="save">保存沉淀</option><option value="output">输出结果</option></select><input value={node.name} onChange={e=>setWorkflowNodes(items=>items.map(x=>x.id===node.id?{...x,name:e.target.value}:x))}/>{(node.type==="input"||node.type==="ai")&&<div className="workflowInputSource"><div className="inputModeTabs"><button type="button" className={(node.inputMode||"prompt")==="prompt"?"active":""} onClick={()=>updateWorkflowInput(node.id,{inputMode:"prompt"})}>提示词结构</button><button type="button" className={node.inputMode==="markdown"?"active":""} onClick={()=>updateWorkflowInput(node.id,{inputMode:"markdown"})}>调用 Markdown</button><button type="button" className={node.inputMode==="skill"?"active":""} onClick={()=>updateWorkflowInput(node.id,{inputMode:"skill"})}>调用 Skill</button><button type="button" className={node.inputMode==="direct"?"active":""} onClick={()=>updateWorkflowInput(node.id,{inputMode:"direct"})}>直接提需求</button></div>{(node.inputMode||"prompt")==="prompt"?<div className="promptStructureGrid">{([["role","角色 Role","例如：资深市场顾问"],["task","任务 Task","需要完成的核心任务"],["context","上下文 Context","业务背景、已有资料"],["constraint","约束 Constraint","不能做什么、字数、范围"],["format","格式 Format","表格、报告、Markdown等"],["example","示例 Example","期望结果示例"]] as Array<[keyof PromptGuide,string,string]>).map(([field,label,placeholder])=><label key={field}>{label}<input value={node.promptGuide?.[field]||""} onChange={e=>updatePromptField(node.id,field,e.target.value)} placeholder={placeholder}/></label>)}</div>:(node.inputMode==="direct"?<label className="workflowResourceSelect workflowDirectRequest">直接填写需求<textarea rows={5} value={node.config||""} onChange={e=>updateWorkflowInput(node.id,{config:e.target.value})} placeholder="直接写一句业务需求，例如：把客户反馈整理成问题清单，并给出优先级和下一步动作。"/><small>适合不想拆角色、任务、上下文时使用；执行时会把这段需求直接交给当前步骤。</small></label>:<label className="workflowResourceSelect">从我的沉淀中心选择{node.inputMode==="skill"?" Skill":" Markdown"}<select value={node.resourceTitle?String(artifactResources.find(item=>item.title===node.resourceTitle&&item.artifactType===node.inputMode)?.id||""):""} onChange={e=>selectWorkflowResource(node.id,e.target.value,node.inputMode as "markdown"|"skill")}><option value="">请选择已保存内容</option>{artifactResources.filter(item=>item.artifactType===node.inputMode).map(item=><option key={item.id} value={item.id}>{item.title}</option>)}</select><small>{node.resourceTitle?`已选：${node.resourceTitle}`:`还没有可用内容时，请先到沉淀中心保存一个${node.inputMode==="skill"?" Skill":" .md 文件"}`}</small></label>)}</div>}{node.type==="agent"&&<label className="workflowResourceSelect">选择已启用智能体<select value={node.config||""} onChange={e=>setWorkflowNodes(items=>items.map(x=>x.id===node.id?{...x,config:e.target.value}:x))}><option value="">请选择智能体</option>{agents.filter(item=>item.status==="已启用").map(item=><option key={item.id} value={item.id}>#{item.id} · {item.name}</option>)}</select></label>}{node.type==="data"&&<label className="workflowResourceSelect">选择数据源<select value={node.config||""} onChange={e=>setWorkflowNodes(items=>items.map(x=>x.id===node.id?{...x,config:e.target.value}:x))}><option value="">请选择数据源</option>{sources.map(item=><option key={item.id} value={item.id}>#{item.id} · {item.name}</option>)}</select><small>运行后先进入采集审核，不会绕过数据清洗和入库确认。</small></label>}{!["input","ai","agent","data","output","save","approval"].includes(node.type)&&<input className="wide" value={node.config||""} onChange={e=>setWorkflowNodes(items=>items.map(x=>x.id===node.id?{...x,config:e.target.value}:x))} placeholder={node.type==="review"?"填写审查标准":"说明这一步要做什么"}/>} { ["ai","review","agent"].includes(node.type)&&<label className="workflowResourceSelect compactModelSelect">本步骤模型<select value={node.modelMode||"auto"} onChange={e=>setWorkflowNodes(items=>items.map(x=>x.id===node.id?{...x,modelMode:e.target.value}:x))}>{modelModeOptions}</select><small>指定后，本步骤优先使用这个模型；不选则自动选择。</small></label>}<button type="button" disabled={workflowNodes.length<=2} onClick={()=>setWorkflowNodes(items=>items.filter(x=>x.id!==node.id))}>×</button>{node.parallelGroup&&workflowNodes[index+1]?.parallelGroup!==node.parallelGroup&&<button type="button" className="addBranchButton" onClick={()=>addParallelBranch(node.parallelGroup!,node.id)}><PlusIcon style={{ width: 12, height: 12 }} /> 增加一个并行AI任务</button>}{index<workflowNodes.length-1&&<i>{node.parallelGroup&&workflowNodes[index+1]?.parallelGroup===node.parallelGroup?<PlusIcon style={{ width: 12, height: 12 }} />:"↓"}</i>}</div>)}<div className="builderAddActions"><button type="button" className="addNode" onClick={addWorkflowNode}><PlusIcon style={{ width: 12, height: 12 }} /> 添加顺序步骤</button><button type="button" className="addNode parallelAdd" onClick={addParallelGroup}>⑂ 在第一步后添加并行AI组</button></div><p className="parallelHint">流程可直接连接：聊天任务、企业/个人知识、Markdown、Skill、智能体、数据采集、并行AI、质量审查、审批、沉淀和结果回传。</p></div></>}
      {modalType==="source" && <>
        <div className="builderSection">
          <b>1. 数据从哪里来</b>
          <div className="sourceConfigGrid">
            <label>数据来源<select name="sourceKind" value={sourceKind} onChange={event=>setSourceKind(event.target.value)}>
              <option value="网页">网页</option>
              <option value="JSON API">JSON API</option>
              <option value="CSV文件">CSV文件</option>
              <option value="图片/截图">图片/截图</option>
              <option value="文本/粘贴">文本/粘贴</option>
              <option value="MCP">MCP</option>
            </select><small>主选数据来源类型</small></label>
            {sourceKind === "网页" && <label>采集方式<select name="webMethod" value={webMethod} onChange={event=>setWebMethod(event.target.value as "direct"|"crawler")}>
              <option value="direct">直采单页</option>
              <option value="crawler">递归爬取</option>
            </select><small>直采只抓当前页；递归会按深度和页数爬取链接</small></label>}
            {/* 粘贴/截图/MCP 三种来源不出网，地址与请求方式对它们只是干扰项 */}
            {!isInlineSourceKind && <>
              <label>请求方式<select name="requestMethod" defaultValue={(editingSource?.requestMethod ?? sourceDraft?.requestMethod) || "GET"}><option>GET</option><option>POST</option></select></label>
              <label className="wide">HTTPS地址<input name="sourceUrl" type="url" defaultValue={(editingSource?.sourceUrl ?? sourceDraft?.sourceUrl) || ""} placeholder="网页/API/CSV文件的完整地址，例如 https://example.com/data.csv"/></label>
              <label className="wide">请求头（可选）<textarea name="requestHeaders" rows={3} placeholder={"每行一个，格式 Key: Value\nAuthorization: Bearer 你的令牌\nX-Api-Key: 你的密钥"}/><small>{editingSource?.requestHeaderNames?.length ? `已配置：${editingSource.requestHeaderNames.join("、")}（值不回显，留空即保持不变）` : "企业自有 API 需要鉴权时填写；值加密保存且不会回显。头名与头值都只能用 ASCII。"}</small></label>
              {extractFieldsField}
            </>}
          </div>
          {isInlineSourceKind
            ? <>
                {/* 平台下拉随爬取范围一起隐藏了，这里按数据来源补一个固定值，避免粘贴任务被记成"公开网站" */}
                <input type="hidden" name="platform" value={sourceKind === "图片/截图" ? "screenshot" : sourceKind === "MCP" ? "mcp" : "manual_export"} />
                {/* 这三种来源里，"数据本身"才是主输入，必须排在"要抓哪些字段"前面 */}
                <SourcePasteZone value={sampleData} onChange={setSampleData} kind={sourceKind} taskName={editingSource?.name} modelMode={editingSource?.modelMode} setNotice={setNotice} />
                <div className="sourceConfigGrid" style={{ marginTop: 10 }}>{extractFieldsField}</div>
              </>
            : <details className="sourceSampleFold">
                <summary>补充样例数据（可选）</summary>
                <SourcePasteZone value={sampleData} onChange={setSampleData} kind={sourceKind} taskName={editingSource?.name} modelMode={editingSource?.modelMode} setNotice={setNotice} />
              </details>}
        </div>
        {!isInlineSourceKind && <div className="builderSection">
          <b>2. 爬取范围与平台设置</b>
          <div className="sourceConfigGrid">
            <label>平台<select name="platform" defaultValue={(editingSource?.platform ?? sourceDraft?.platform) || "web"}><option value="web">公开网站</option><option value="xiaohongshu">小红书（授权数据）</option><option value="douyin">抖音（授权数据）</option><option value="kuaishou">快手（授权数据）</option><option value="bilibili">B站（授权数据）</option><option value="wechat">公众号/视频号（授权数据）</option><option value="zhihu">知乎（授权数据）</option><option value="custom_api">企业自有API</option><option value="mcp">MCP工具返回</option><option value="screenshot">截图/图片识别</option><option value="manual_export">平台导出文件</option></select></label>
            <label>关键词<input name="keyword" defaultValue={(editingSource?.keyword ?? sourceDraft?.keyword) || ""} placeholder="用于采集报告标记或平台授权任务"/></label>
            <label>递归深度<input name="crawlDepth" type="number" min={0} max={3} defaultValue={(editingSource?.crawlDepth ?? sourceDraft?.crawlDepth) ?? 1}/></label>
            <label>最大页数<input name="maxPages" type="number" min={1} max={50} defaultValue={(editingSource?.maxPages ?? sourceDraft?.maxPages) ?? 5}/></label>
            <label className="wide">包含URL规则<input name="urlPattern" defaultValue={(editingSource?.urlPattern ?? sourceDraft?.urlPattern) || ""} placeholder="留空=同域全部；可填 /docs 或 https://example.com/docs/*"/></label>
            <label className="wide">排除URL规则<input name="excludePattern" defaultValue={(editingSource?.excludePattern ?? sourceDraft?.excludePattern) || ""} placeholder="login, signup, admin, *.pdf"/></label>
            <label>评论/明细<select name="includeComments" defaultValue={(editingSource?.includeComments ?? sourceDraft?.includeComments) || "no"}><option value="no">不采集</option><option value="yes">采集评论/明细（需授权）</option></select></label>
            <label>合规规则<select name="respectRobots" defaultValue={(editingSource?.respectRobots ?? sourceDraft?.respectRobots) || "yes"}><option value="yes">遵守站点规则</option><option value="no">仅企业授权来源</option></select></label>
          </div>
          <p className="builderHint">平台类采集必须走合法授权/API/MCP/导出数据，系统不会绕过登录、验证码、付费墙或反爬限制；公开网站会按同域链接、深度和页数真实递归抓取。</p>
        </div>}
        <div className="builderSection">
          <b>3. 什么时候运行</b>
          <div className="sourceConfigGrid">
            <label>运行计划<select name="schedule" defaultValue={(editingSource?.schedule ?? sourceDraft?.schedule) || "手动"}><option>手动</option><option>每天 09:00</option><option>每周一 09:00</option><option>每月1日 09:00</option></select></label>
            <label>入库方式<select name="publishMode" defaultValue={["record_only","仅保存采集记录"].includes(String(editingSource?.publishMode ?? sourceDraft?.publishMode ?? "")) ? "record_only" : "auto"}><option value="auto">自动入库</option><option value="record_only">仅保存采集记录</option></select><small>默认成功后直接进入上面选择的知识库；选择“仅保存采集记录”时只保留日志和预览。</small></label>
          </div>
        </div>
        <div className="builderSection">
          <b>4. 采集结果放到哪里</b>
          <div className="sourceConfigGrid">
            <label>默认入库<select name="targetStore" defaultValue={(editingSource?.targetStore ?? sourceDraft?.targetStore) || "personal"}><option value="personal">个人知识库（推荐）</option><option value="enterprise">企业知识库</option><option value="both">个人 + 企业</option></select><small>个人知识不会自动共享；需要共享时，再到企业知识页手动同步。</small></label>
            <label>输出形态<select name="outputFormat" defaultValue={(editingSource?.outputFormat ?? sourceDraft?.outputFormat) || "markdown"}><option value="markdown">Markdown</option><option value="document">文档</option><option value="table">表格</option><option value="json">JSON</option><option value="raw">原始文本</option></select></label>
            <label>知识库分类<select name="targetCategory" defaultValue={(editingSource?.targetCategory ?? sourceDraft?.targetCategory) || "数据采集"}><option>数据采集</option><option>企业宣传</option><option>产品资料</option><option>销售方案</option><option>客户项目</option><option>其他</option></select></label>
            <label>可见范围<select name="visibility" defaultValue={(editingSource?.visibility ?? sourceDraft?.visibility) || "全员"}><option>全员</option><option>部门</option><option>销售经理</option><option>市场专员</option></select></label>
          </div>
        </div>
        <div className="builderSection">
          <b>5. 模型整理</b>
          <div className="sourceConfigGrid">
            <label className="wide">采集整理模型<select name="modelMode" defaultValue={(editingSource?.modelMode ?? sourceDraft?.modelMode) || "auto"}>{modelModeOptions}</select><small>用于把网页/API/MCP/截图识别文本整理成可入库内容；只想保留原始抓取内容时，选择“不调用模型”。</small></label>
          </div>
        </div>
      </>}
      <div className="modalActions"><button type="button" className="outline" onClick={closeModuleModal}>取消</button>{modalType==="agent"&&<button type="submit" className="outline" value="draft">保存草稿</button>}<button type="submit" value={modalType==="agent"?"test":"enable"}>{modalType==="source"?(editingSource?"保存修改":"保存采集任务"):modalType==="agent"?"保存、启用并试聊":"保存并启用"}</button></div></form></div>}
    {showApproval && <div className="modalBackdrop" onMouseDown={()=>setShowApproval(false)}><form className="modal" onSubmit={submitApproval} onMouseDown={e=>e.stopPropagation()}><div className="modalHead"><div><h2>发起企业审批</h2><p>从企业架构中指定具体审批账号，申请只会进入该账号的待办。</p></div><button type="button" onClick={()=>setShowApproval(false)}>×</button></div><label>审批类型<select name="requestType"><option>导出敏感数据</option><option>对外发送内容</option><option>创建智能体</option><option>运行自动化</option><option>其他事项</option></select></label><label>指定审批人<select name="approverEmail" required defaultValue={approvalTargets.find(item=>item.recommended)?.email||""}><option value="" disabled>请选择企业架构中的账号</option>{approvalTargets.map(item=><option key={item.email} value={item.email}>{item.recommended?"推荐 · ":""}{item.unitName} · {item.jobTitle} · {item.email}</option>)}</select></label><label>审批事项<input name="title" required placeholder="例如：导出本月重点客户清单"/></label><label>申请原因<textarea name="reason" required rows={7} placeholder="说明业务目的、数据范围、使用人和完成时间…"/></label><div className="modalActions"><button type="button" className="outline" onClick={()=>setShowApproval(false)}>取消</button><button type="submit" disabled={!approvalTargets.length}>提交给指定审批人</button></div></form></div>}
    {saveDraft && <div className="modalBackdrop" onMouseDown={()=>setSaveDraft(null)}><form className="modal depositModal" onSubmit={saveArtifact} onMouseDown={e=>e.stopPropagation()}><div className="modalHead"><div><h2>是否沉淀本次{saveDraft.sourceType==="loop"?"Loop":"聊天"}？</h2><p>保存后会进入你的沉淀中心，下次可以直接复用。</p></div><button type="button" onClick={()=>setSaveDraft(null)}>×</button></div><label>沉淀名称<input name="title" required defaultValue={saveDraft.title}/></label><fieldset className="artifactChoice"><legend>保存成什么</legend><label><input type="radio" name="artifactType" value="markdown" defaultChecked/><span><b>Markdown 文件（.md）</b><small>适合归档、查看、下载和复制内容</small></span></label><label><input type="radio" name="artifactType" value="skill"/><span><b>可复用 Skill</b><small>保存方法与配置，下次一键恢复并再次运行</small></span></label></fieldset><label>内容预览<textarea readOnly rows={8} value={saveDraft.content}/></label><div className="modalActions"><button type="button" className="outline" onClick={()=>setSaveDraft(null)}>暂不保存</button><button type="submit">保存到沉淀中心</button></div></form></div>}
    {connectorHelp && <div className="modalBackdrop" onMouseDown={()=>setConnectorHelp(null)}><form className="modal connectorModal" onSubmit={saveConnectorCredentials} onMouseDown={e=>e.stopPropagation()}><div className="modalHead"><div><h2>接入我的{connectorHelp.name}</h2><p>这些凭证只属于当前账号，将在服务器端加密保存。</p></div><button type="button" onClick={()=>setConnectorHelp(null)}>×</button></div><div className="connectorModePicker"><b>接收事件方式</b><div><button type="button" className={connectorMode==="long_connection"?"active":""} onClick={()=>setConnectorMode("long_connection")}>长连接（推荐）</button><button type="button" className={connectorMode==="callback"?"active":""} onClick={()=>setConnectorMode("callback")}>HTTP 回调（备用）</button></div><p>{connectorMode==="long_connection"?`${connectorHelp.name}由常驻通道网关保持在线，断线会自动重连。`:`${connectorHelp.name}将事件推送到本平台生成的 HTTPS 地址。`}</p></div><input type="hidden" name="connectionMode" value={connectorMode}/><label>{connectorHelp.id==="wecom"&&connectorMode==="long_connection"?"机器人 ID（Bot ID）":connectorHelp.id==="wecom"?"企业 ID（Corp ID）":connectorHelp.id==="dingtalk"?"Client ID / AppKey":"App ID"}<input name="appId" required autoComplete="off" placeholder="从开放平台复制"/></label><label>{connectorHelp.id==="wecom"&&connectorMode==="long_connection"?"机器人 Secret":connectorHelp.id==="dingtalk"?"Client Secret / AppSecret":"应用密钥（App Secret）"}<input name="appSecret" type="password" required autoComplete="new-password" placeholder="保存后不再回显"/></label><label>{connectorMode==="long_connection"?"通道网关密钥（自动生成并加密保存）":"回调校验密钥 / Token"}<div className="gatewaySecretField"><input name="callbackToken" type="text" required autoComplete="off" value={gatewaySecret} onChange={event=>setGatewaySecret(event.target.value)} placeholder="系统自动生成"/>{connectorMode==="long_connection"&&<button type="button" className="outline" onClick={()=>setGatewaySecret(createGatewaySecret())}>重新生成</button>}</div></label><div className="setupSteps"><b>接入步骤</b>{connectorMode==="long_connection"?<><ol><li>在{connectorHelp.name}开放平台创建企业机器人，开启消息收发权限。</li><li>{connectorHelp.id==="feishu"?"事件订阅选择“使用长连接接收事件”，订阅接收消息事件。":connectorHelp.id==="dingtalk"?"机器人消息接收模式选择 Stream。":"创建 AI 机器人，API 模式选择 WebSocket 长连接。"}</li><li>保存凭证后，服务器通道网关会自动同步这条配置。</li><li>网关完成平台鉴权并持续上报心跳后，本页才会显示“真实链路在线”。</li><li>在{connectorHelp.name}给机器人发消息，后台调用你指定的模型并原路回复。</li></ol>{connectorHelp.longConnectionUrl&&<p><b>后台中转地址：</b><br/><code>{adaptUrlToCurrentOrigin(connectorHelp.longConnectionUrl)}</code></p>}{connectorHelp.gatewayConfig&&<p><b>备用网关账户配置：</b><br/><code>{adaptGatewayConfigToCurrentOrigin(connectorHelp.gatewayConfig)}</code></p>}<p className="connectionNotice">注意：服务器会自动同步配置；下面的备用配置只用于离线排查，不需要日常手动复制。</p></>:<><ol><li>在{connectorHelp.name}开放平台创建企业应用并启用机器人。</li><li>开通接收消息、发送回复及需要调用的业务权限。</li><li>保存本页凭证，把生成的回调地址填到开放平台。</li><li>发送一条真实消息验证收发链路。</li></ol>{connectorHelp.callbackUrl&&<p><b>我的专属回调地址：</b><br/><code>{adaptUrlToCurrentOrigin(connectorHelp.callbackUrl)}</code></p>}</>}<p>当前状态：{connectorHelp.gatewayOnline?"网关在线":connectorHelp.status}</p></div><div className="modalActions"><button type="button" className="outline" onClick={()=>setConnectorHelp(null)}>取消</button><button type="submit">加密保存我的API</button></div></form></div>}
  </main>;
}


