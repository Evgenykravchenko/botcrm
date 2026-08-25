"use client";

import { ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { ContactAvatar, InboxView as FunctionalInboxView } from "./inbox-view";
import { AppSelect, type AppSelectOption } from "./ui/app-select";
import { TemplateMessageEditor, TemplateVariable } from "./ui/template-message-editor";
import { CampaignMedia, CampaignRichContent, validateCampaignRichContent } from "./ui/campaign-rich-content";
import { CampaignSchedulePicker, campaignTimeZoneLabel, defaultCampaignSchedule } from "./ui/campaign-schedule-picker";
import { isDarkTheme, isThemeName, ThemePicker, type ThemeName } from "./ui/theme-picker";
import { botcrmApi, ApiAdminUser, ApiAnalytics, ApiAttachment, ApiAttributeDefinition, ApiAutomationInput, ApiAutomationRule, ApiAutomationRun, ApiAutomationTrigger, ApiCampaign, ApiCampaignButton, ApiCampaignRecipient, ApiContact, ApiConnector, ApiConnectorInput, ApiConversation, ApiDeal, ApiError, ApiMessage, ApiPipeline, ApiSearchResult, ApiSegment, ApiSegmentCondition, ApiSegmentGroup, ApiServiceToken, ApiSession, ApiTeam, ApiUser, ApiRealtimeStatus, setAuthToken, subscribeToRealtime } from "./api-client";
import { AlertTriangle, ArrowUpRight, BarChart3, Bot, BookOpen, Calendar, Check, CheckCheck, ChevronDown, Circle, Columns3, Copy, Database, ExternalLink, Eye, GripVertical, Inbox, Mail, Megaphone, Menu, MessageCircle, Mic, MoreHorizontal, Paperclip, Pause, Pencil, Phone, Plus, RefreshCw, Search, Send, Settings, ShieldCheck, SlidersHorizontal, Smile, Tag, User, Users, Workflow, X, Zap } from "lucide-react";

type Section = "inbox" | "contacts" | "pipeline" | "campaigns" | "automations" | "integrations" | "analytics" | "settings";
type ControlMode = "BOT" | "HUMAN" | "PAUSED";
type Channel = "telegram" | "vk" | "whatsapp" | "avito" | "api";
type Conversation = { id: string; contactId?: string; dealId?: string; dealVersion?: number; dealPipelineId?: string; stageId?: string; assignedUserId?: string; amount?: number; controlVersion: number; attributes: Record<string, unknown>; name: string; initials: string; channel: Channel; bot: string; preview: string; time: string; unread: number; online?: boolean; avatarAvailable?: boolean; avatarVersion?: string; tags: string[]; stage: string; mode: ControlMode; phone: string; email: string; city: string };
type ChatAttachment = ApiAttachment & { previewUrl?: string };
type ChatMessage = { id: string; side: "in" | "out" | "system"; text: string; time: string; author?: string; status?: "queued" | "sent" | "delivered" | "read" | "failed"; attachments?: ChatAttachment[] };
type Deal = { id: string; contactId?: string; version?: number; name: string; amount: number; source: string; bot: string; age: string; tags: string[]; contactName: string; contactDetail: string; channel: Channel; avatarAvailable?: boolean; avatarVersion?: string };
type Stage = { id: string; title: string; color: string; deals: Deal[] };

const channelMeta: Record<Channel, { label: string; short: string; className: string }> = {
  telegram: { label: "Telegram", short: "TG", className: "channel-tg" }, vk: { label: "ВКонтакте", short: "VK", className: "channel-vk" }, whatsapp: { label: "WhatsApp", short: "WA", className: "channel-wa" }, avito: { label: "Avito", short: "AV", className: "channel-av" }, api: { label: "Custom API", short: "API", className: "channel-api" },
};
const navItems: { id: Section; label: string; icon: LucideIcon; badge?: string }[] = [
  { id: "inbox", label: "Диалоги", icon: Inbox, badge: "3" }, { id: "contacts", label: "Контакты", icon: Users }, { id: "pipeline", label: "Воронки", icon: Columns3, badge: "24" }, { id: "campaigns", label: "Рассылки", icon: Megaphone }, { id: "automations", label: "Автоматизации", icon: Workflow }, { id: "integrations", label: "Боты и каналы", icon: Bot }, { id: "analytics", label: "Аналитика", icon: BarChart3 }, { id: "settings", label: "Настройки", icon: Settings },
];
type UiCapability = "supervise" | "admin" | "owner";
const capabilityRoles: Record<UiCapability, ApiUser["role"][]> = {
  supervise: ["OWNER", "ADMIN", "SUPERVISOR"],
  admin: ["OWNER", "ADMIN"],
  owner: ["OWNER"],
};
function hasCapability(user: ApiUser | null, capability: UiCapability) { return Boolean(user && capabilityRoles[capability].includes(user.role)); }
function sectionFromHash(): Section {
  if (typeof window === "undefined") return "inbox";
  const value = window.location.hash.slice(1);
  return navItems.some((item) => item.id === value) ? value as Section : "inbox";
}
const sectionTitles: Record<Section, { title: string; subtitle: string }> = {
  inbox: { title: "Диалоги", subtitle: "Все обращения из подключённых ботов" }, contacts: { title: "Контакты", subtitle: "Единая база пользователей и переменных" }, pipeline: { title: "Воронка продаж", subtitle: "Состояние каждой сделки в реальном времени" }, campaigns: { title: "Рассылки", subtitle: "Сегменты, расписание и статистика доставок" }, automations: { title: "Автоматизации", subtitle: "CRM-правила по событиям ботов" }, integrations: { title: "Боты и каналы", subtitle: "Подключения, API и состояние webhook" }, analytics: { title: "Аналитика", subtitle: "Продажи, скорость ответов и эффективность ботов" }, settings: { title: "Настройки", subtitle: "Команда, роли, сервисные токены и безопасность" },
};
function ChannelBadge({ channel, compact = false }: { channel: Channel; compact?: boolean }) { const meta = channelMeta[channel]; return <span className={`channel-badge ${meta.className}`} title={meta.label}>{compact ? meta.short : meta.label}</span>; }
function formatMoney(value: number) { return new Intl.NumberFormat("ru-RU").format(value) + " ₽"; }
function displayBot(botId: string) { return ({ sales_assistant: "Sales Assistant", support_bot: "Support Bot", course_bot: "Course Bot", avito_leads: "Avito Leads", b2b_qualifier: "B2B Qualifier" } as Record<string, string>)[botId] || botId.split("_").map((part) => part[0]?.toUpperCase() + part.slice(1)).join(" "); }
function displayStage(stageId?: string) { return ({ new: "Новая заявка", qualify: "Квалификация", proposal: "Предложение", invoice: "Счёт отправлен", won: "Оплачено", lost: "Проиграно" } as Record<string, string>)[stageId || ""] || "Без сделки"; }
function initials(name: string) { return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "?"; }
function shortTime(value: string) { const date = new Date(value); return Number.isNaN(date.valueOf()) ? "—" : date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }); }
function formatBytes(value: number) { if (value < 1024) return `${value} Б`; if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} КБ`; return `${(value / 1024 / 1024).toFixed(1)} МБ`; }
function relativeAge(value: string) { const minutes = Math.max(0, Math.round((Date.now() - new Date(value).valueOf()) / 60_000)); if (minutes < 60) return `${minutes} мин`; if (minutes < 1440) return `${Math.round(minutes / 60)} ч`; return `${Math.round(minutes / 1440)} дн`; }
function toUiMessage(message: ApiMessage): ChatMessage { return { id: message.id, side: message.direction === "system" ? "system" : message.direction === "inbound" ? "in" : "out", text: message.text, time: shortTime(message.createdAt), author: message.actor === "operator" ? "Евгений" : message.actor === "bot" ? "Бот" : undefined, status: message.status, attachments: message.attachments ?? [] }; }
function toUiConversation(item: ApiConversation, deals: ApiDeal[], pipelines: ApiPipeline[]): Conversation {
  const deal = deals
    .filter((candidate) => candidate.contactId === item.contactId)
    .sort((left, right) => new Date(right.updatedAt).valueOf() - new Date(left.updatedAt).valueOf())[0];
  const dealPipeline = pipelines.find((pipeline) => pipeline.id === deal?.pipelineId);
  const dealStage = dealPipeline?.stages.find((stage) => stage.slug === deal?.stageId);
  const tags = Array.isArray(item.contact.attributes?.tags) ? item.contact.attributes.tags.filter((tag): tag is string => typeof tag === "string") : [];
  const lastMessage = item.messages.at(-1);
  return { id: item.id, contactId: item.contactId, dealId: deal?.id, dealVersion: deal?.version, dealPipelineId: deal?.pipelineId, stageId: deal?.stageId, assignedUserId: item.assignedUserId, amount: deal?.amount, controlVersion: item.controlVersion, attributes: item.contact.attributes || {}, name: item.contact.displayName, initials: initials(item.contact.displayName), channel: item.channel, bot: displayBot(item.botId), preview: lastMessage?.text || "Диалог без сообщений", time: shortTime(item.lastMessageAt), unread: item.unreadCount, online: Date.now() - new Date(item.lastMessageAt).valueOf() < 10 * 60_000, avatarAvailable: item.contact.avatarAvailable, avatarVersion: item.contact.updatedAt, tags, stage: dealStage?.name ?? (deal ? deal.stageId : "Без сделки"), mode: item.mode, phone: item.contact.phone || "—", email: item.contact.email || "—", city: item.contact.city || "—" };
}
function toUiStages(deals: ApiDeal[], conversations: ApiConversation[], pipeline?: ApiPipeline): Stage[] {
  const configured = pipeline?.stages.map((stage) => ({ id: stage.slug, title: stage.name, color: stage.color, deals: [] as Deal[] })) ?? [];
  return configured.map((stage) => ({ ...stage, deals: deals.filter((deal) => deal.stageId === stage.id).map((deal) => {
    const conversation = conversations.find((item) => item.contactId === deal.contactId);
    const contact = deal.contact ?? conversation?.contact;
    const channel = conversation?.channel || contact?.identities?.[0]?.channel || "api";
    const identity = contact?.identities.find((item) => item.channel === channel) ?? contact?.identities[0];
    const username = ["telegram_username", "vk_username", "username"]
      .map((key) => contact?.attributes?.[key])
      .find((value): value is string => typeof value === "string" && value.trim().length > 0);
    const contactDetail = username
      ? (username.startsWith("@") ? username : `@${username}`)
      : identity ? `${channelMeta[identity.channel].short} ID ${identity.externalUserId}` : "Только CRM";
    const tags = Array.isArray(contact?.attributes?.tags) ? contact.attributes.tags.filter((tag): tag is string => typeof tag === "string") : [];
    return { id: deal.id, contactId: deal.contactId, version: deal.version, name: deal.title, amount: deal.amount, source: channelMeta[channel].short, bot: conversation ? displayBot(conversation.botId) : "CRM", age: relativeAge(deal.updatedAt), tags, contactName: contact?.displayName || "Контакт недоступен", contactDetail, channel, avatarAvailable: contact?.avatarAvailable, avatarVersion: contact?.updatedAt };
  }) }));
}
type CampaignCardItem = { id?: string; createdAt: string; rawStatus: ApiCampaign["status"]; name: string; channel: string; segment: string; audience: string; sent: string; delivered: string; status: string; tone: string; sentCount?: number; deliveredCount?: number; failedCount?: number; source: ApiCampaign };
function toCampaignCard(item: ApiCampaign): CampaignCardItem { const state = { draft: ["Черновик", "draft"], scheduled: [item.scheduledAt ? `${new Intl.DateTimeFormat("ru-RU", { timeZone: item.timeZone ?? "Europe/Moscow", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(item.scheduledAt))} · ${campaignTimeZoneLabel(item.timeZone ?? "Europe/Moscow")}` : "Запланирована", "scheduled"], running: ["Идёт", "running"], paused: ["На паузе", "paused"], completed: ["Завершена", "done"], cancelled: ["Отменена", "cancelled"] }[item.status]; const sent = item.sent ?? 0; const delivered = item.delivered ?? 0; return { id: item.id, createdAt: item.createdAt, rawStatus: item.status, name: item.name, channel: channelMeta[item.channel].label, segment: item.segmentName || "Все подходящие контакты", audience: new Intl.NumberFormat("ru-RU").format(item.eligible ?? item.audience), sent: new Intl.NumberFormat("ru-RU").format(sent), delivered: sent ? `${(delivered / sent * 100).toFixed(1)}%` : "—", status: state[0], tone: state[1], sentCount: sent, deliveredCount: delivered, failedCount: item.failed ?? 0, source: item }; }

function MessageAttachment({ attachment }: { attachment: ChatAttachment }) {
  const [url, setUrl] = useState(attachment.previewUrl || "");
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (attachment.previewUrl) { setUrl(attachment.previewUrl); return; }
    let active = true;
    void botcrmApi.attachmentUrl(attachment.id).then((result) => { if (active) setUrl(result.url); }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [attachment.id, attachment.previewUrl]);
  const isImage = attachment.mimeType.startsWith("image/");
  const isVideo = attachment.mimeType.startsWith("video/");
  const isAudio = attachment.mimeType.startsWith("audio/");
  if (isImage) return <a className="attachment-card image" href={url || undefined} target="_blank" rel="noreferrer">{url ? <img src={url} alt={attachment.filename} /> : <span className="attachment-loading"><RefreshCw className="spin" size={18} />Загрузка…</span>}<small>{attachment.filename} · {formatBytes(attachment.byteSize)}</small></a>;
  if (isVideo && url) return <div className="attachment-card media"><video controls preload="metadata" src={url} /><small>{attachment.filename} · {formatBytes(attachment.byteSize)}</small></div>;
  if (isAudio && url) return <div className="attachment-card audio"><audio controls preload="metadata" src={url} /><small>{attachment.filename} · {formatBytes(attachment.byteSize)}</small></div>;
  return <a className={`attachment-card file ${failed ? "failed" : ""}`} href={url || undefined} target="_blank" rel="noreferrer"><span><Paperclip size={18} /></span><div><b>{attachment.filename}</b><small>{failed ? "Не удалось получить ссылку" : `${formatBytes(attachment.byteSize)} · ${attachment.mimeType}`}</small></div>{url ? <ArrowUpRight size={16} /> : <RefreshCw className="spin" size={15} />}</a>;
}
export function BotCRM() {
  const [section, setSection] = useState<Section>(sectionFromHash);
  const [mobileNav, setMobileNav] = useState(false);
  const [theme, setTheme] = useState<ThemeName>("light");
  const [workspaceMenu, setWorkspaceMenu] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [messages, setMessages] = useState<Record<string, ChatMessage[]>>({});
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<ChatAttachment[]>([]);
  const [uploadingAttachments, setUploadingAttachments] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [stages, setStages] = useState<Stage[]>([]);
  const [pipelines, setPipelines] = useState<ApiPipeline[]>([]);
  const [selectedPipelineId, setSelectedPipelineId] = useState("");
  const [pipelineSettings, setPipelineSettings] = useState(false);
  const [dealComposer, setDealComposer] = useState<{ deal?: Deal; stageId?: string } | null>(null);
  const [dragged, setDragged] = useState<{ dealId: string; stageId: string } | null>(null);
  const [automations, setAutomations] = useState<ApiAutomationRule[]>([]);
  const [automationRuns, setAutomationRuns] = useState<ApiAutomationRun[]>([]);
  const [automationComposer, setAutomationComposer] = useState(false);
  const [connectors, setConnectors] = useState<ApiConnector[]>([]);
  const [connectorComposer, setConnectorComposer] = useState(false);
  const [campaignItems, setCampaignItems] = useState<CampaignCardItem[]>([]);
  const [segments, setSegments] = useState<ApiSegment[]>([]);
  const [contacts, setContacts] = useState<ApiContact[]>([]);
  const [attributeDefinitions, setAttributeDefinitions] = useState<ApiAttributeDefinition[]>([]);
  const [attributeManager, setAttributeManager] = useState(false);
  const [contactEditor, setContactEditor] = useState<ApiContact | "new" | null>(null);
  const [segmentManager, setSegmentManager] = useState(false);
  const [campaignComposer, setCampaignComposer] = useState(false);
  const [campaignEditor, setCampaignEditor] = useState<ApiCampaign | null>(null);
  const [startingCampaignId, setStartingCampaignId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [apiStatus, setApiStatus] = useState<"connecting" | "online" | "offline">("connecting");
  const [realtimeStatus, setRealtimeStatus] = useState<ApiRealtimeStatus>("connecting");
  const [liveRevision, setLiveRevision] = useState(0);
  const [lastRealtimeAt, setLastRealtimeAt] = useState("");
  const [authState, setAuthState] = useState<"checking" | "authenticated" | "login">("checking");
  const [currentUser, setCurrentUser] = useState<ApiUser | null>(null);
  const [accountModal, setAccountModal] = useState(false);
  const selected = conversations.find((item) => item.id === selectedId);
  const activeMessages = selected ? (messages[selected.id] ?? []) : [];
  const hasDemoData = conversations.some((item) => item.id.startsWith("30000000-0000-4000-8000-"));
  const canSupervise = hasCapability(currentUser, "supervise");
  const canAdmin = hasCapability(currentUser, "admin");
  const visibleNavItems = navItems.filter((item) => item.id !== "settings" || canAdmin);

  function notify(text: string) { setToast(text); window.setTimeout(() => setToast(null), 2800); }
  async function loadWorkspace(silent = false) {
    try {
      const requestedPipelineId = selectedPipelineId || "sales";
      const [apiConversations, apiDeals, apiCampaigns, apiAutomations, apiAutomationRuns, apiConnectors, apiSegments, apiContacts, apiPipelines, apiAttributeDefinitions] = await Promise.all([botcrmApi.conversations(), botcrmApi.deals(requestedPipelineId), botcrmApi.campaigns(), botcrmApi.automations(), botcrmApi.automationRuns(50), botcrmApi.connectors(), botcrmApi.segments(), botcrmApi.contacts(), botcrmApi.pipelines(), botcrmApi.attributeDefinitions()]);
      const mapped = apiConversations.map((item) => toUiConversation(item, apiDeals, apiPipelines));
      setConversations(mapped);
      setMessages(Object.fromEntries(apiConversations.map((item) => [item.id, item.messages.map(toUiMessage)])));
      setPipelines(apiPipelines);
      setSelectedPipelineId((current) => apiPipelines.some((pipeline) => pipeline.id === current) ? current : (apiPipelines.find((pipeline) => pipeline.isDefault) ?? apiPipelines[0])?.id ?? "");
      const activePipeline = apiPipelines.find((pipeline) => pipeline.id === requestedPipelineId) ?? apiPipelines.find((pipeline) => pipeline.isDefault) ?? apiPipelines[0];
      setStages(toUiStages(apiDeals, apiConversations, activePipeline));
      setCampaignItems(apiCampaigns.map(toCampaignCard));
      setAutomations(apiAutomations);
      setAutomationRuns(apiAutomationRuns);
      setConnectors(apiConnectors);
      setSegments(apiSegments);
      setContacts(apiContacts);
      setAttributeDefinitions(apiAttributeDefinitions);
      setSelectedId((current) => mapped.some((item) => item.id === current) ? current : "");
      setApiStatus("online");
    } catch (error) {
      setApiStatus("offline");
      if (!silent) notify(error instanceof ApiError ? `API: ${error.message}` : "API недоступен — реальные данные не загружены");
    }
  }
  async function initializeAuth() {
    try {
      const user = await botcrmApi.me();
      setCurrentUser(user);
      setAuthState("authenticated");
      await loadWorkspace(true);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setAuthState("login");
        setApiStatus("offline");
      } else {
        setAuthState("login");
        setApiStatus("offline");
      }
    }
  }
  useEffect(() => { void initializeAuth(); }, []);
  useEffect(() => {
    const storedTheme = window.localStorage.getItem("botcrm_theme");
    if (isThemeName(storedTheme)) setTheme(storedTheme);
  }, []);
  useEffect(() => {
    const target = `${window.location.pathname}${window.location.search}#${section}`;
    window.history.replaceState(window.history.state, "", target);
  }, [section]);
  useEffect(() => {
    const restoreSection = () => setSection(sectionFromHash());
    window.addEventListener("hashchange", restoreSection);
    return () => window.removeEventListener("hashchange", restoreSection);
  }, []);
  useEffect(() => {
    if (!currentUser) return;
    if (section === "settings" && !canAdmin) setSection("inbox");
    if (!canSupervise) {
      setPipelineSettings(false);
      setCampaignComposer(false);
      setSegmentManager(false);
      setAutomationComposer(false);
    }
    if (!canAdmin) setConnectorComposer(false);
  }, [currentUser, section, canAdmin, canSupervise]);
  useEffect(() => {
    if (authState !== "authenticated") return;
    let active = true;
    let running = false;
    let pending = false;
    let debounceTimer: number | undefined;

    const pageVisible = () => document.visibilityState !== "hidden";
    const synchronize = async () => {
      if (!active || !pageVisible()) { pending = true; return; }
      if (running) { pending = true; return; }
      running = true;
      do {
        pending = false;
        await loadWorkspace(true);
      } while (active && pending && pageVisible());
      running = false;
    };
    const schedule = () => {
      if (debounceTimer !== undefined) return;
      debounceTimer = window.setTimeout(() => { debounceTimer = undefined; void synchronize(); }, 250);
    };
    const unsubscribe = subscribeToRealtime(
      (event) => { setLiveRevision((value) => value + 1); setLastRealtimeAt(new Date(event.occurredAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" })); schedule(); },
      (status) => { if (active) { setRealtimeStatus(status); if (status === "live") schedule(); } },
    );
    const catchUp = () => { if (document.visibilityState === "visible") void synchronize(); };
    const fallback = window.setInterval(() => { if (document.visibilityState === "visible") void synchronize(); }, 30_000);
    window.addEventListener("focus", catchUp);
    document.addEventListener("visibilitychange", catchUp);
    return () => {
      active = false;
      unsubscribe();
      if (debounceTimer !== undefined) window.clearTimeout(debounceTimer);
      window.clearInterval(fallback);
      window.removeEventListener("focus", catchUp);
      document.removeEventListener("visibilitychange", catchUp);
    };
  }, [authState, selectedPipelineId]);
  useEffect(() => { setPendingAttachments((items) => { for (const item of items) if (item.previewUrl) URL.revokeObjectURL(item.previewUrl); return []; }); }, [selectedId]);
  useEffect(() => {
    if (section !== "inbox" || !selected || selected.unread <= 0) return;
    const conversationId = selected.id;
    setConversations((items) => items.map((item) => item.id === conversationId ? { ...item, unread: 0 } : item));
    void botcrmApi.markConversationRead(conversationId).catch(() => void loadWorkspace(true));
  }, [section, selected?.id, selected?.unread]);

  async function login(input: { email: string; password: string; totp?: string }) {
    const result = await botcrmApi.login({ workspace: "ws_demo", ...input });
    setAuthToken(result.token);
    setCurrentUser(result.user);
    setAuthState("authenticated");
    await loadWorkspace(true);
  }

  async function logout() {
    try { await botcrmApi.logout(); } catch { /* Session may already be expired. */ }
    setAuthToken();
    setCurrentUser(null);
    setAccountModal(false);
    setAuthState("login");
  }

  async function setMode(mode: ControlMode) {
    if (!selected) return;
    const before = selected;
    const text = mode === "HUMAN" ? "Диалог передан оператору. Бот приостановлен." : mode === "BOT" ? "Управление возвращено боту." : "Диалог поставлен на паузу.";
    setConversations((items) => items.map((item) => item.id === before.id ? { ...item, mode } : item));
    try {
      const updated = await botcrmApi.setControl(before.id, mode, before.controlVersion);
      setConversations((items) => items.map((item) => item.id === before.id ? { ...item, mode: updated.mode, controlVersion: updated.controlVersion } : item));
      setMessages((current) => ({ ...current, [before.id]: [...(current[before.id] ?? []), { id: crypto.randomUUID(), side: "system", text, time: shortTime(new Date().toISOString()) }] }));
      notify(text);
    } catch (error) {
      setConversations((items) => items.map((item) => item.id === before.id ? before : item));
      notify(error instanceof ApiError && error.status === 409 ? "Диалог уже изменён другим оператором. Данные обновлены." : "Не удалось изменить управление диалогом");
      await loadWorkspace(true);
    }
  }

  function openConversation(id: string) {
    setSelectedId(id);
    const target = conversations.find((item) => item.id === id);
    if (!target?.unread) return;
    setConversations((items) => items.map((item) => item.id === id ? { ...item, unread: 0 } : item));
    void botcrmApi.markConversationRead(id).catch(() => void loadWorkspace(true));
  }

  async function moveSelectedDeal(stageSlug: string) {
    if (!selected?.dealId || !selected.dealVersion) return;
    try {
      await botcrmApi.moveDeal(selected.dealId, stageSlug, selected.dealVersion);
      await loadWorkspace(true);
      const stageName = pipelines.find((pipeline) => pipeline.id === selected.dealPipelineId)?.stages.find((stage) => stage.slug === stageSlug)?.name ?? displayStage(stageSlug);
      notify(`Сделка перемещена в «${stageName}»`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "Не удалось переместить сделку");
      await loadWorkspace(true);
    }
  }

  async function attachFiles(event: ChangeEvent<HTMLInputElement>) {
    const selectedFiles = Array.from(event.target.files ?? []);
    event.target.value = "";
    const remaining = Math.max(0, 10 - pendingAttachments.length);
    const files = selectedFiles.slice(0, remaining);
    if (selectedFiles.length > remaining) notify("В одном сообщении можно отправить не более 10 файлов");
    if (!files.length) return;
    setUploadingAttachments((count) => count + files.length);
    await Promise.all(files.map(async (file) => {
      const previewUrl = /^(image|video|audio)\//.test(file.type) ? URL.createObjectURL(file) : undefined;
      try {
        const uploaded = await botcrmApi.uploadAttachment(file);
        setPendingAttachments((items) => [...items, { id: uploaded.id, filename: uploaded.filename, mimeType: uploaded.mimeType, byteSize: uploaded.byteSize, createdAt: uploaded.createdAt, previewUrl }]);
      } catch (error) {
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        notify(error instanceof ApiError ? `Не загружен ${file.name}: ${error.message}` : `Не удалось загрузить ${file.name}`);
      } finally {
        setUploadingAttachments((count) => Math.max(0, count - 1));
      }
    }));
  }

  function removePendingAttachment(id: string) {
    setPendingAttachments((items) => {
      const removed = items.find((item) => item.id === id);
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
      return items.filter((item) => item.id !== id);
    });
  }

  async function sendMessage(event: FormEvent) {
    if (!selected) return;
    event.preventDefault();
    const text = draft.trim();
    const attachments = pendingAttachments;
    if ((!text && !attachments.length) || uploadingAttachments > 0) return;
    const conversationId = selected.id;
    const pendingId = crypto.randomUUID();
    const pending: ChatMessage = { id: pendingId, side: "out", text, time: shortTime(new Date().toISOString()), author: "Евгений", status: "queued", attachments };
    setDraft("");
    setPendingAttachments([]);
    setMessages((current) => ({ ...current, [conversationId]: [...(current[conversationId] ?? []), pending] }));
    const preview = text || `📎 ${attachments.length === 1 ? attachments[0].filename : `${attachments.length} файла`}`;
    setConversations((items) => items.map((item) => item.id === conversationId ? { ...item, preview, time: "сейчас", unread: 0 } : item));
    try {
      let controlVersion = selected.controlVersion;
      if (selected.mode !== "HUMAN") {
        const control = await botcrmApi.setControl(conversationId, "HUMAN", controlVersion);
        controlVersion = control.controlVersion;
        setConversations((items) => items.map((item) => item.id === conversationId ? { ...item, mode: "HUMAN", controlVersion } : item));
      }
      const result = await botcrmApi.sendMessage(conversationId, text, pendingId, attachments.map((item) => item.id));
      setMessages((current) => ({ ...current, [conversationId]: (current[conversationId] ?? []).map((message) => message.id === pendingId ? toUiMessage(result.message) : message) }));
      for (const attachment of attachments) if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
      notify(attachments.length ? "Сообщение с вложением поставлено в очередь" : "Сообщение поставлено в очередь отправки");
    } catch (error) {
      setMessages((current) => ({ ...current, [conversationId]: (current[conversationId] ?? []).filter((message) => message.id !== pendingId) }));
      setPendingAttachments((items) => [...attachments, ...items]);
      notify(error instanceof ApiError ? `Не отправлено: ${error.message}` : "Не удалось отправить сообщение");
    }
  }
  async function switchPipeline(pipelineId: string) { setSelectedPipelineId(pipelineId); try { const [deals, apiConversations]=await Promise.all([botcrmApi.deals(pipelineId), botcrmApi.conversations()]); const pipeline=pipelines.find((item)=>item.id===pipelineId); setStages(toUiStages(deals,apiConversations,pipeline)); setConversations(apiConversations.map((item)=>toUiConversation(item,deals,pipelines))); setMessages(Object.fromEntries(apiConversations.map((item)=>[item.id,item.messages.map(toUiMessage)]))); } catch(error){notify(error instanceof Error?error.message:"Не удалось открыть воронку");} }
  async function moveDeal(targetStageId: string) {
    if (!dragged || dragged.stageId === targetStageId) return;
    const snapshot = stages;
    const targetStage = stages.find((stage) => stage.id === targetStageId);
    let moving: Deal | undefined;
    const removed = stages.map((stage) => ({ ...stage, deals: stage.deals.filter((deal) => { if (deal.id === dragged.dealId) { moving = deal; return false; } return true; }) }));
    if (!moving) return;
    setStages(removed.map((stage) => stage.id === targetStageId ? { ...stage, deals: [...stage.deals, moving!] } : stage));
    setDragged(null);
    try {
      const updated = await botcrmApi.moveDeal(moving.id, targetStageId, moving.version ?? 1);
      setStages((items) => items.map((stage) => ({ ...stage, deals: stage.deals.map((deal) => deal.id === moving!.id ? { ...deal, version: updated.version } : deal) })));
      const targetStageName = targetStage?.title ?? displayStage(targetStageId);
      setConversations((items) => items.map((item) => item.contactId === moving!.contactId ? { ...item, stageId: targetStageId, stage: targetStageName, dealVersion: updated.version } : item));
      notify(`Сделка перемещена в «${targetStageName}»`);
    } catch (error) {
      setStages(snapshot);
      notify(error instanceof ApiError && error.status === 409 ? "Сделка уже перемещена другим оператором" : "Не удалось переместить сделку");
      await loadWorkspace(true);
    }
  }

  async function saveCampaign(input: { name: string; channel: Channel; content: string; buttons?: ApiCampaignButton[]; mediaIds?: string[]; segmentId?: string; scheduledAt?: string; timeZone?: string }) {
    try {
      const saved = campaignEditor ? await botcrmApi.updateCampaign(campaignEditor.id, input) : await botcrmApi.createCampaign(input);
      setCampaignItems((items) => campaignEditor ? items.map((item) => item.id === saved.id ? toCampaignCard(saved) : item) : [toCampaignCard(saved), ...items]);
      setCampaignComposer(false);
      setCampaignEditor(null);
      notify(campaignEditor ? "Изменения рассылки сохранены" : saved.status === "scheduled" ? "Рассылка запланирована" : "Рассылка сохранена как черновик");
    } catch (error) {
      notify(error instanceof ApiError ? `Не удалось сохранить: ${error.message}` : "API рассылок недоступен");
    }
  }

  async function startCampaign(campaignId?: string) {
    if (!campaignId || startingCampaignId) return;
    setStartingCampaignId(campaignId);
    try {
      const result = await botcrmApi.startCampaign(campaignId);
      notify(`Рассылка запущена: ${result.queued} получателей поставлены в очередь`);
      await loadWorkspace(true);
      window.setTimeout(() => void loadWorkspace(true), 1200);
    } catch (error) {
      notify(error instanceof ApiError ? `Не удалось запустить: ${error.message}` : "Очередь рассылок недоступна");
    } finally {
      setStartingCampaignId(null);
    }
  }

  async function pauseCampaign(campaignId?: string) {
    if (!campaignId || startingCampaignId) return;
    setStartingCampaignId(campaignId);
    try {
      await botcrmApi.pauseCampaign(campaignId);
      await loadWorkspace(true);
      notify("Рассылка поставлена на паузу");
    } catch (error) {
      notify(error instanceof ApiError ? `Не удалось поставить на паузу: ${error.message}` : "API рассылок недоступен");
    } finally {
      setStartingCampaignId(null);
    }
  }

  async function cancelCampaign(campaignId?: string) {
    if (!campaignId || startingCampaignId) return;
    setStartingCampaignId(campaignId);
    try {
      await botcrmApi.cancelCampaign(campaignId);
      await loadWorkspace(true);
      notify("Рассылка отменена, ожидающие получатели исключены");
    } catch (error) {
      notify(error instanceof ApiError ? `Не удалось отменить: ${error.message}` : "API рассылок недоступен");
    } finally {
      setStartingCampaignId(null);
    }
  }
  if (authState === "checking") return <div className="auth-shell"><div className="auth-loading"><div className="brand-mark"><MessageCircle size={24} /></div><RefreshCw className="spin" size={22} /><span>Подключаем BotCRM…</span></div></div>;
  if (authState === "login") return <LoginScreen onLogin={login} />;
  const title = sectionTitles[section];
  return <div className="app-shell" data-theme={theme} data-color-scheme={isDarkTheme(theme) ? "dark" : "light"}>
    <aside className={`sidebar ${mobileNav ? "sidebar-open" : ""}`}>
      <div className="brand"><div className="brand-mark"><MessageCircle size={20} strokeWidth={2.6} /></div><div><strong>BotCRM</strong><span>Control center</span></div></div>
      <div className="workspace-control"><button className="workspace-switch" onClick={() => setWorkspaceMenu(!workspaceMenu)} aria-expanded={workspaceMenu}><div className="workspace-avatar">BS</div><span><b>Bot Studio</b><small>Локальная PostgreSQL</small></span><ChevronDown size={15} /></button>{workspaceMenu && <div className="workspace-popover"><b>Bot Studio</b><p>{hasDemoData ? <>Сейчас подключено одно рабочее пространство. Стартовые записи созданы из <code>infra/seed.sql</code> и являются демонстрационными.</> : <>Подключено одно рабочее пространство с реальными данными PostgreSQL.</>}</p>{canAdmin && <button onClick={() => { setWorkspaceMenu(false); setSection("settings"); }}>Настройки команды</button>}</div>}</div>{hasDemoData && <div className="demo-data-notice"><Database size={14} /><span><b>Демо-данные</b><small>Не реальные клиенты</small></span></div>}
      <nav className="nav-list"><p className="nav-label">Рабочее пространство</p>{visibleNavItems.map((item) => { const badge = item.id === "inbox" ? conversations.reduce((sum, conversation) => sum + conversation.unread, 0) : item.id === "pipeline" ? stages.reduce((sum, stage) => sum + stage.deals.length, 0) : 0; return <button key={item.id} className={section === item.id ? "active" : ""} onClick={() => { setSection(item.id); setMobileNav(false); }}><item.icon size={19} /><span>{item.label}</span>{badge > 0 && <em>{badge}</em>}</button>; })}</nav>
      <button className="docs-nav-link" onClick={() => { window.location.href = "/docs"; }}><BookOpen size={18}/><span><b>Документация</b><small>Запуск, работа и API</small></span><ExternalLink size={14}/></button>
      <div className="sidebar-bottom"><div className={`system-health ${apiStatus === "offline" ? "offline" : realtimeStatus === "offline" ? "realtime-offline" : ""}`}><span><i />{apiStatus === "online" ? "API подключён" : apiStatus === "connecting" ? "Подключение к API…" : "API недоступен"}</span><small>{apiStatus !== "online" ? "Ожидаем восстановление соединения" : realtimeStatus === "live" ? (lastRealtimeAt ? `Realtime · обновлено ${lastRealtimeAt}` : "Обновления в реальном времени") : realtimeStatus === "connecting" ? "Подключаем realtime…" : "Realtime переподключается…"}</small></div><button className="profile-button" onClick={() => setAccountModal(true)}><div className="profile-avatar">{initials(currentUser?.displayName || "Евгений")}</div><span><b>{currentUser?.displayName || "Евгений"}</b><small>{roleLabel(currentUser?.role)}</small></span><MoreHorizontal size={17} /></button></div>
    </aside>
    <main className="main-area">
      <header className="topbar"><div className="topbar-title"><button className="icon-button mobile-menu" onClick={() => setMobileNav(!mobileNav)}><Menu size={20} /></button><div><h1>{title.title}</h1><p>{title.subtitle}</p></div></div><GlobalSearch onOpen={(result) => { if (result.conversationId) { setSelectedId(result.conversationId); setSection("inbox"); } else if (result.type === "deal") setSection("pipeline"); else setSection("contacts"); }} /><div className="topbar-actions"><ThemePicker value={theme} onChange={(nextTheme) => { setTheme(nextTheme); window.localStorage.setItem("botcrm_theme", nextTheme); }} /><div className="notification-control"><button className={`icon-button notification-button ${notificationsOpen ? "active" : ""}`} onClick={() => setNotificationsOpen(!notificationsOpen)} aria-label="Уведомления" aria-expanded={notificationsOpen}><Circle size={19} />{conversations.some((item) => item.unread > 0) && <i />}</button>{notificationsOpen && <div className="notification-popover"><header><b>Уведомления</b><span>{conversations.reduce((sum, item) => sum + item.unread, 0)} новых</span></header>{conversations.filter((item) => item.unread > 0).slice(0, 5).map((item) => <button key={item.id} onClick={() => { void openConversation(item.id); setSection("inbox"); setNotificationsOpen(false); }}><ContactAvatar contactId={item.contactId} channel={item.channel} avatarAvailable={item.avatarAvailable} avatarVersion={item.avatarVersion} initials={item.initials} seed={item.id} size="sm" /><div><b>{item.name}</b><small>{item.preview}</small></div><em>{item.unread}</em></button>)}{!conversations.some((item) => item.unread > 0) && <p>Новых сообщений нет.</p>}</div>}</div>{section === "pipeline" && canSupervise && <button className="button secondary" onClick={() => setPipelineSettings(true)}><Settings size={16} />Настроить</button>}{section === "campaigns" && canSupervise && <button className="button primary" onClick={() => { setCampaignEditor(null); setCampaignComposer(true); }}><Plus size={17} />Новая рассылка</button>}{section === "automations" && canSupervise && <button className="button primary" onClick={() => setAutomationComposer(true)}><Plus size={17} />Новое правило</button>}{section === "integrations" && canAdmin && <button className="button primary" onClick={() => setConnectorComposer(true)}><Plus size={17} />Подключить</button>}</div></header>
      {section === "inbox" && <FunctionalInboxView conversations={conversations} selected={selected} selectedId={selectedId} openConversation={openConversation} closeConversation={() => { setSelectedId(""); setDraft(""); }} search={search} setSearch={setSearch} messages={activeMessages} draft={draft} setDraft={setDraft} sendMessage={sendMessage} setMode={setMode} pendingAttachments={pendingAttachments} uploadingAttachments={uploadingAttachments} fileInputRef={fileInputRef} attachFiles={attachFiles} removePendingAttachment={removePendingAttachment} pipelines={pipelines} moveDeal={moveSelectedDeal} editContact={() => { const contact = contacts.find((item) => item.id === selected?.contactId); if (contact) setContactEditor(contact); }} refresh={() => loadWorkspace(true)} notify={notify} currentUserName={currentUser?.displayName || "Оператор"} liveRevision={liveRevision} />}
      {section === "contacts" && <ContactsView canManageBulk={canSupervise} canManageAttributes={canAdmin} attributeDefinitions={attributeDefinitions} onManageAttributes={() => setAttributeManager(true)} contacts={contacts} conversations={conversations} onOpen={(contact) => { const conversationId = contact.conversationId || conversations.find((item) => item.contactId === contact.id)?.id; if (conversationId) { setSelectedId(conversationId); setSection("inbox"); } else setContactEditor(contact); }} onEdit={setContactEditor} onCreate={() => setContactEditor("new")} onSegments={() => setSegmentManager(true)} onChanged={() => loadWorkspace(true)} notify={notify} />}
      {section === "pipeline" && <PipelineView canConfigure={canSupervise} stages={stages} pipelines={pipelines} selectedPipelineId={selectedPipelineId} onSelectPipeline={switchPipeline} dragged={dragged} setDragged={setDragged} moveDeal={moveDeal} onCreate={(stageId) => setDealComposer({ stageId })} onEdit={(deal) => setDealComposer({ deal })} onConfigure={() => setPipelineSettings(true)} />}
      {section === "campaigns" && <CampaignsView canManage={canSupervise} items={campaignItems} onCreate={() => { setCampaignEditor(null); setCampaignComposer(true); }} onEdit={(campaign) => { setCampaignEditor(campaign); setCampaignComposer(true); }} onStart={startCampaign} onPause={pauseCampaign} onCancel={cancelCampaign} actionId={startingCampaignId} />}
      {section === "automations" && <AutomationsView canManage={canSupervise} attributeDefinitions={attributeDefinitions} automations={automations} runs={automationRuns} contacts={conversations} refresh={() => loadWorkspace(true)} notify={notify} />}
      {section === "integrations" && <IntegrationsView canCheck={canSupervise} canManage={canAdmin} connectors={connectors} refresh={() => loadWorkspace(true)} notify={notify} onCreate={() => setConnectorComposer(true)} />}
      {section === "analytics" && <AnalyticsView revision={liveRevision} />}
      {section === "settings" && currentUser && <SettingsView currentUser={currentUser} notify={notify} revision={liveRevision} />}
    </main>
    {pipelineSettings && canSupervise && <PipelineSettingsModal pipeline={pipelines.find((item) => item.id === selectedPipelineId) ?? pipelines.find((item) => item.isDefault) ?? pipelines[0]} close={() => setPipelineSettings(false)} changed={() => loadWorkspace(true)} notify={notify} />}
    {dealComposer && <DealModal contacts={contacts} pipeline={pipelines.find((item) => item.id === selectedPipelineId) ?? pipelines.find((item) => item.isDefault) ?? pipelines[0]} deal={dealComposer.deal} initialStageId={dealComposer.stageId} close={() => setDealComposer(null)} saved={async (editing) => { setDealComposer(null); await loadWorkspace(true); notify(editing ? "Сделка обновлена" : "Сделка создана"); }} />}
    {campaignComposer && canSupervise && <CampaignModal segments={segments} initial={campaignEditor ?? undefined} close={() => { setCampaignComposer(false); setCampaignEditor(null); }} launch={saveCampaign} />}
    {segmentManager && canSupervise && <SegmentManager attributeDefinitions={attributeDefinitions} segments={segments} close={() => setSegmentManager(false)} changed={async () => { const next = await botcrmApi.segments(); setSegments(next); }} notify={notify} />}
    {attributeManager && <AttributeDefinitionManager definitions={attributeDefinitions} canManage={canAdmin} close={() => setAttributeManager(false)} changed={async () => { setAttributeDefinitions(await botcrmApi.attributeDefinitions()); }} notify={notify} />}
    {contactEditor && <ContactModal canMerge={canSupervise} canDelete={canAdmin} allContacts={contacts} contact={contactEditor === "new" ? undefined : contactEditor} close={() => setContactEditor(null)} changed={async () => { setContacts(await botcrmApi.contacts()); }} notify={notify} />}
    {automationComposer && canSupervise && <AutomationModal pipelines={pipelines} attributeDefinitions={attributeDefinitions} close={() => setAutomationComposer(false)} created={async () => { setAutomationComposer(false); await loadWorkspace(true); notify("Правило автоматизации создано"); }} />}
    {connectorComposer && canAdmin && <ConnectorModal close={() => setConnectorComposer(false)} created={async () => { setConnectorComposer(false); await loadWorkspace(true); notify("Подключение создано — проверьте его состояние"); }} />}
    {accountModal && currentUser && <AccountModal user={currentUser} onUserChange={setCurrentUser} close={() => setAccountModal(false)} logout={logout} notify={notify} />}
    {toast && <div className="toast"><Check size={17} />{toast}</div>}{mobileNav && <button className="sidebar-scrim" onClick={() => setMobileNav(false)} />}
  </div>;
}

function GlobalSearch({ onOpen }: { onOpen: (result: ApiSearchResult) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ApiSearchResult[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (query.trim().length < 2) { setResults([]); setOpen(false); return; }
    const timer = window.setTimeout(() => {
      setLoading(true);
      botcrmApi.search(query).then((items) => { setResults(items); setOpen(true); }).catch(() => setResults([])).finally(() => setLoading(false));
    }, 220);
    return () => window.clearTimeout(timer);
  }, [query]);
  const labels = { contact: "Контакт", message: "Сообщение", deal: "Сделка" };
  return <div className="global-search">
    <Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} onFocus={() => query.length >= 2 && setOpen(true)} placeholder="Поиск по CRM…" aria-label="Глобальный поиск" />{loading && <RefreshCw size={15} className="spin" />}{query && !loading && <button onClick={() => { setQuery(""); setOpen(false); }} aria-label="Очистить поиск"><X size={14} /></button>}
    {open && <><button className="search-dismiss" onClick={() => setOpen(false)} aria-label="Закрыть результаты" /><div className="global-search-results">{results.length ? results.map((item) => <button key={`${item.type}-${item.id}`} onClick={() => { onOpen(item); setOpen(false); setQuery(""); }}><span className={`search-type ${item.type}`}>{labels[item.type]}</span><div><b>{item.title}</b><small>{item.subtitle || item.excerpt || "Без дополнительной информации"}</small>{item.excerpt && item.subtitle && <p>{item.excerpt}</p>}</div><ArrowUpRight size={15} /></button>) : <div className="search-empty"><Search size={18} />Ничего не найдено</div>}</div></>}
  </div>;
}
function LoginScreen({ onLogin }: { onLogin: (input: { email: string; password: string; totp?: string }) => Promise<void> }) {
  const [email, setEmail] = useState("owner@botcrm.local");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [requiresMfa, setRequiresMfa] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true); setError("");
    try { await onLogin({ email: email.trim(), password, totp: totp || undefined }); }
    catch (loginError) {
      if (loginError instanceof ApiError && loginError.code === "mfa_required") { setRequiresMfa(true); setError("Введите шестизначный код из приложения-аутентификатора"); }
      else setError(loginError instanceof ApiError ? loginError.message : "Не удалось подключиться к серверу");
    } finally { setSubmitting(false); }
  }
  return <div className="auth-shell"><div className="auth-visual"><div className="auth-brand"><div className="brand-mark"><MessageCircle size={24} /></div><span><b>BotCRM</b><small>Omnichannel control center</small></span></div><div className="auth-promise"><span className="eyebrow">Единое рабочее место</span><h1>Все боты, клиенты и продажи — в одной панели</h1><p>Диалоги, канбан, переменные, рассылки и автоматизации с контролем оператора.</p><div><span><ShieldCheck size={18} />Argon2id и TOTP</span><span><Database size={18} />Ваш PostgreSQL</span><span><Zap size={18} />Realtime-события</span></div></div></div><form className="login-card" onSubmit={submit}><header><span className="eyebrow">Безопасный вход</span><h2>Добро пожаловать</h2><p>Войдите в рабочее пространство Bot Studio</p></header><label className="form-field"><span>Email</span><input type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} required /></label><label className="form-field"><span>Пароль</span><input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Введите пароль" required /></label>{requiresMfa && <label className="form-field"><span>Код двухфакторной защиты</span><input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={totp} onChange={(event) => setTotp(event.target.value.replace(/\D/g, ""))} placeholder="000000" required /></label>}{error && <div className="auth-error"><AlertTriangle size={16} />{error}</div>}<button className="button primary login-submit" disabled={submitting || !email.trim() || !password}>{submitting ? <><RefreshCw size={17} className="spin" />Проверяем…</> : <><ShieldCheck size={17} />Войти в BotCRM</>}</button><div className="demo-credentials"><b>Локальный запуск</b><span>owner@botcrm.local</span><span>Пароль: botcrm-dev-password</span></div></form></div>;
}

function AccountModal({ user, onUserChange, close, logout, notify }: { user: ApiUser; onUserChange: (user: ApiUser) => void; close: () => void; logout: () => Promise<void>; notify: (text: string) => void }) {
  const [sessions, setSessions] = useState<ApiSession[]>([]);
  const [mfaSetup, setMfaSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [mfaCode, setMfaCode] = useState("");
  const [disablePassword, setDisablePassword] = useState("");
  const [busy, setBusy] = useState(false);
  async function loadSessions() { try { setSessions(await botcrmApi.sessions()); } catch { setSessions([]); } }
  useEffect(() => { void loadSessions(); }, []);
  async function beginMfa() { setBusy(true); try { setMfaSetup(await botcrmApi.setupMfa()); notify("Секрет 2FA создан — подтвердите кодом"); } catch (error) { notify(error instanceof ApiError ? error.message : "Не удалось настроить 2FA"); } finally { setBusy(false); } }
  async function confirmMfa() { if (mfaCode.length !== 6) return; setBusy(true); try { await botcrmApi.verifyMfa(mfaCode); onUserChange({ ...user, mfaEnabled: true }); setMfaSetup(null); setMfaCode(""); notify("Двухфакторная защита включена"); } catch (error) { notify(error instanceof ApiError ? error.message : "Код не принят"); } finally { setBusy(false); } }
  async function disableMfa() { if (!disablePassword || mfaCode.length !== 6) return; setBusy(true); try { await botcrmApi.disableMfa(disablePassword, mfaCode); onUserChange({ ...user, mfaEnabled: false }); setDisablePassword(""); setMfaCode(""); notify("Двухфакторная защита отключена"); } catch (error) { notify(error instanceof ApiError ? error.message : "Не удалось отключить 2FA"); } finally { setBusy(false); } }
  async function revoke(id: string) { setBusy(true); try { await botcrmApi.revokeSession(id); await loadSessions(); notify("Сессия завершена"); } catch (error) { notify(error instanceof ApiError ? error.message : "Не удалось завершить сессию"); } finally { setBusy(false); } }
  return <div className="modal-backdrop" role="dialog" aria-modal="true" onMouseDown={(event) => event.target === event.currentTarget && close()}><section className="modal account-modal"><header><div><span className="eyebrow">Безопасность аккаунта</span><h2>{user.displayName}</h2><p>{user.email} · {roleLabel(user.role)}</p></div><button className="icon-button" onClick={close}><X size={19} /></button></header><div className="modal-body account-body"><section className="security-card"><div className="security-title"><div><ShieldCheck size={20} /><span><b>Двухфакторная защита</b><small>{user.mfaEnabled ? "Включена для входа в аккаунт" : "Добавьте код из приложения-аутентификатора"}</small></span></div><span className={`security-state ${user.mfaEnabled ? "enabled" : ""}`}>{user.mfaEnabled ? "Включена" : "Выключена"}</span></div>{!user.mfaEnabled && !mfaSetup && <button className="button secondary" disabled={busy} onClick={beginMfa}>Настроить 2FA</button>}{mfaSetup && <div className="mfa-setup"><p>Добавьте секрет в Google Authenticator, 1Password или другое TOTP-приложение.</p><div className="secret-copy"><code>{mfaSetup.secret}</code><button aria-label="Скопировать секрет 2FA" title="Скопировать секрет" onClick={() => { void navigator.clipboard.writeText(mfaSetup.secret); notify("Секрет скопирован"); }}><Copy size={15} /></button></div><details><summary>Показать URI для импорта</summary><code>{mfaSetup.uri}</code></details><label className="form-field"><span>Код подтверждения</span><input inputMode="numeric" maxLength={6} value={mfaCode} onChange={(event) => setMfaCode(event.target.value.replace(/\D/g, ""))} placeholder="000000" /></label><button className="button primary" onClick={confirmMfa} disabled={busy || mfaCode.length !== 6}>Подтвердить и включить</button></div>}{user.mfaEnabled && <div className="mfa-disable"><label className="form-field"><span>Пароль</span><input type="password" value={disablePassword} onChange={(event) => setDisablePassword(event.target.value)} /></label><label className="form-field"><span>Текущий TOTP-код</span><input inputMode="numeric" maxLength={6} value={mfaCode} onChange={(event) => setMfaCode(event.target.value.replace(/\D/g, ""))} /></label><button className="button secondary danger" disabled={busy || !disablePassword || mfaCode.length !== 6} onClick={disableMfa}>Отключить 2FA</button></div>}</section><section className="sessions-card"><header><div><h3>Активные сессии</h3><p>Устройства, на которых выполнялся вход</p></div><button className="icon-button" onClick={() => void loadSessions()}><RefreshCw size={16} /></button></header><div>{sessions.filter((session) => !session.revokedAt).map((session) => <article key={session.id}><div className="session-icon"><Database size={16} /></div><span><b>{session.userAgent?.includes("Windows") ? "Windows · браузер" : session.userAgent || "Неизвестное устройство"}</b><small>{session.ipAddress || "IP неизвестен"} · {new Date(session.lastSeenAt).toLocaleString("ru-RU")}</small></span>{session.current ? <em>Текущая</em> : <button disabled={busy} onClick={() => void revoke(session.id)}>Завершить</button>}</article>)}{sessions.filter((session) => !session.revokedAt).length === 0 && <div className="empty-inline">Сохранённых сессий пока нет — используется локальный dev-доступ.</div>}</div></section></div><footer><button className="button secondary danger" onClick={() => void logout()}>Выйти из аккаунта</button><button className="button primary" onClick={close}>Готово</button></footer></section></div>;
}
function roleLabel(role?: ApiUser["role"]) { return ({ OWNER: "Владелец", ADMIN: "Администратор", SUPERVISOR: "Руководитель", OPERATOR: "Оператор", SERVICE: "Сервис" } as Record<string, string>)[role || ""] || "Пользователь"; }
function displayAttribute(value: unknown) { if (value === null || value === undefined) return "—"; if (Array.isArray(value)) return value.join(", "); if (typeof value === "object") return JSON.stringify(value); if (typeof value === "boolean") return value ? "Да" : "Нет"; return String(value); }

function AttributeDefinitionManager({ definitions, canManage, close, changed, notify }: { definitions: ApiAttributeDefinition[]; canManage: boolean; close: () => void; changed: () => Promise<void>; notify: (text: string) => void }) {
  const [label, setLabel] = useState("");
  const [key, setKey] = useState("");
  const [valueType, setValueType] = useState<ApiAttributeDefinition["valueType"]>("STRING");
  const [authority, setAuthority] = useState<ApiAttributeDefinition["authority"]>("BOT");
  const [filterable, setFilterable] = useState(true);
  const [editing, setEditing] = useState<ApiAttributeDefinition | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const contactDefinitions = definitions.filter((item) => item.objectScope === "CONTACT");
  const typeOptions: AppSelectOption[] = [
    { value: "STRING", label: "Строка", detail: "Текстовое значение" }, { value: "NUMBER", label: "Число", detail: "Оценка, сумма или счётчик" },
    { value: "BOOLEAN", label: "Флаг Да / Нет", detail: "Логическое значение" }, { value: "DATE", label: "Дата", detail: "Дата или дата со временем" },
    { value: "ENUM", label: "Один вариант", detail: "Значение из заданного списка" }, { value: "MULTISELECT", label: "Несколько вариантов", detail: "Массив выбранных значений" },
    { value: "URL", label: "Ссылка", detail: "Адрес веб-страницы" }, { value: "JSON", label: "JSON", detail: "Структурированные технические данные" },
  ];
  function beginEdit(item: ApiAttributeDefinition) { setEditing(item); setLabel(item.label); setKey(item.key); setValueType(item.valueType); setAuthority(item.authority); setFilterable(item.filterable); setError(""); }
  function reset() { setEditing(null); setLabel(""); setKey(""); setValueType("STRING"); setAuthority("BOT"); setFilterable(true); setError(""); }
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      if (editing) await botcrmApi.updateAttributeDefinition(editing.id, { label: label.trim(), valueType, authority, filterable });
      else await botcrmApi.createAttributeDefinition({ objectScope: "CONTACT", key: key.trim(), label: label.trim(), valueType, authority, filterable });
      await changed(); notify(editing ? "Переменная обновлена" : "Переменная зарегистрирована"); reset();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Не удалось сохранить переменную"); }
    finally { setBusy(false); }
  }
  async function remove(item: ApiAttributeDefinition) {
    if (!window.confirm(`Удалить описание переменной «${item.label}»? Значения в контактах останутся.`)) return;
    setBusy(true); try { await botcrmApi.deleteAttributeDefinition(item.id); await changed(); if (editing?.id === item.id) reset(); notify("Описание переменной удалено; значения контактов сохранены"); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Не удалось удалить переменную"); } finally { setBusy(false); }
  }
  return <div className="modal-backdrop" role="dialog" aria-modal="true" onMouseDown={(event) => event.target === event.currentTarget && close()}><section className="modal attribute-modal"><header><div><span className="eyebrow">Схема данных контакта</span><h2>Переменные ботов</h2><p>Названия ключей приходят от ваших ботов. BotCRM хранит для них понятное имя, тип и доступность в фильтрах.</p></div><button className="icon-button" onClick={close}><X size={19} /></button></header><div className="modal-body attribute-layout"><section><h3>Зарегистрированные поля</h3><div className="attribute-list">{contactDefinitions.map((item) => <article key={item.id}><div className="attribute-type"><Database size={16} /></div><span><b>{item.label}</b><code>{item.key}</code><small>{item.valueType} · {item.authority === "BOT" ? "источник: бот" : "источник: платформа"} · используется у {item.usageCount} контактов</small></span><em className={item.filterable ? "enabled" : ""}>{item.filterable ? "В фильтрах" : "Скрыта"}</em>{canManage && <div><button className="icon-button" onClick={() => beginEdit(item)} title="Редактировать"><Settings size={15} /></button><button className="icon-button danger" disabled={busy} onClick={() => void remove(item)} title="Удалить описание"><X size={15} /></button></div>}</article>)}{!contactDefinitions.length && <div className="empty-inline">Переменных пока нет. Они появятся автоматически после первого события бота или их можно создать справа.</div>}</div></section>{canManage && <form onSubmit={save}><h3>{editing ? "Настройка переменной" : "Новая переменная"}</h3><label className="form-field"><span>Название для команды</span><input required maxLength={100} value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Например: Оценка интереса" /></label><label className="form-field"><span>Ключ в API</span><input required={!editing} disabled={Boolean(editing)} value={key} onChange={(event) => setKey(event.target.value)} placeholder="risk_level" pattern="[A-Za-z_][A-Za-z0-9_.-]{0,79}" /><small>Этот ключ бот передаёт в объекте attributes. После создания он не меняется.</small></label><label className="form-field"><span>Тип значения</span><AppSelect ariaLabel="Тип переменной" value={valueType} onValueChange={(value) => setValueType(value as ApiAttributeDefinition["valueType"])} options={typeOptions} matchTriggerWidth /></label><label className="form-field"><span>Источник истины</span><AppSelect ariaLabel="Источник переменной" value={authority} onValueChange={(value) => setAuthority(value as ApiAttributeDefinition["authority"])} options={[{ value: "BOT", label: "Самописный бот", detail: "Поле обновляет интеграция бота" }, { value: "PLATFORM", label: "BotCRM", detail: "Полем управляют операторы и автоматизации" }]} matchTriggerWidth /></label><label className="check-row"><input type="checkbox" checked={filterable} onChange={(event) => setFilterable(event.target.checked)} /><span><b>Использовать в фильтрах</b><small>Показывать поле в сегментах, таблицах и автоматизациях</small></span></label>{error && <div className="form-error"><AlertTriangle size={15} />{error}</div>}<div className="attribute-form-actions">{editing && <button type="button" className="button secondary" onClick={reset}>Отменить редактирование</button>}<button className="button primary" disabled={busy || !label.trim() || !key.trim()}>{busy && <RefreshCw size={15} className="spin" />}{editing ? "Сохранить" : "Зарегистрировать"}</button></div></form>}</div></section></div>;
}
function ContactsView({ canManageBulk, canManageAttributes, attributeDefinitions, contacts, conversations, onOpen, onEdit, onCreate, onSegments, onManageAttributes, onChanged, notify }: { canManageBulk: boolean; canManageAttributes: boolean; attributeDefinitions: ApiAttributeDefinition[]; contacts: ApiContact[]; conversations: Conversation[]; onOpen: (contact: ApiContact) => void; onEdit: (contact: ApiContact) => void; onCreate: () => void; onSegments: () => void; onManageAttributes: () => void; onChanged: () => Promise<void>; notify: (text: string) => void }) {
  const [query, setQuery] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [channel, setChannel] = useState<"" | Channel>("");
  const [marketing, setMarketing] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const contactAttributes = attributeDefinitions.filter((item) => item.objectScope === "CONTACT" && item.filterable);
  const [visibleAttributeKey, setVisibleAttributeKey] = useState(() => contactAttributes[0]?.key ?? "");
  const visibleAttribute = contactAttributes.find((item) => item.key === visibleAttributeKey) ?? contactAttributes[0];
  useEffect(() => { if (!visibleAttributeKey && contactAttributes[0]) setVisibleAttributeKey(contactAttributes[0].key); }, [visibleAttributeKey, contactAttributes]);
  const importRef = useRef<HTMLInputElement>(null);
  const normalized = query.trim().toLowerCase();
  const filtered = contacts.filter((contact) => {
    const matchesQuery = `${contact.displayName} ${contact.phone ?? ""} ${contact.email ?? ""} ${contact.city ?? ""} ${JSON.stringify(contact.attributes)}`.toLowerCase().includes(normalized);
    const matchesChannel = !channel || contact.identities.some((identity) => identity.channel === channel);
    const matchesMarketing = !marketing || (contact.marketingStatus ?? "UNKNOWN") === marketing;
    const matchesTag = !tagFilter.trim() || (contact.tags ?? []).some((tag) => tag.toLowerCase().includes(tagFilter.trim().toLowerCase()));
    return matchesQuery && matchesChannel && matchesMarketing && matchesTag;
  });
  const active30 = contacts.filter((contact) => contact.lastActivityAt && Date.now() - new Date(contact.lastActivityAt).valueOf() < 30 * 86_400_000).length;
  const unsubscribed = contacts.filter((contact) => contact.marketingStatus === "REVOKED").length;

  async function download(format: "csv" | "json") {
    setBusy(true);
    try {
      const exported = await botcrmApi.exportContacts(format);
      const link = document.createElement("a");
      link.href = URL.createObjectURL(new Blob([exported.content], { type: exported.mimeType }));
      link.download = exported.filename;
      link.click();
      URL.revokeObjectURL(link.href);
      notify(`Экспортировано ${contacts.length} контактов`);
    } catch (error) { notify(error instanceof Error ? error.message : "Не удалось экспортировать контакты"); }
    finally { setBusy(false); }
  }

  async function importFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setBusy(true);
    try {
      const format = file.name.toLowerCase().endsWith(".json") ? "json" : "csv";
      const result = await botcrmApi.importContacts(format, await file.text());
      await onChanged();
      notify(result.failed ? `Импортировано ${result.imported}; ошибок: ${result.failed} (первая — строка ${result.errors[0]?.row})` : `Импортировано ${result.imported} контактов`);
    } catch (error) { notify(error instanceof Error ? error.message : "Не удалось импортировать контакты"); }
    finally { setBusy(false); }
  }

  async function bulkMarketing(marketingStatus: "GRANTED" | "REVOKED") {
    if (!selectedIds.length) return;
    setBusy(true);
    try { await Promise.all(selectedIds.map((id) => botcrmApi.updateContact(id, { marketingStatus }))); await onChanged(); notify(`Обновлено контактов: ${selectedIds.length}`); setSelectedIds([]); }
    catch (error) { notify(error instanceof Error ? error.message : "Не удалось обновить контакты"); }
    finally { setBusy(false); }
  }

  async function bulkAddTag() {
    if (!selectedIds.length) return;
    const value = window.prompt("Какой тег добавить выбранным контактам?")?.trim();
    if (!value) return;
    setBusy(true);
    try { await Promise.all(selectedIds.map((id) => { const contact=contacts.find((item)=>item.id===id); return botcrmApi.setContactTags(id,[...new Set([...(contact?.tags??[]),value])]); })); await onChanged(); notify(`Тег добавлен: ${selectedIds.length}`); setSelectedIds([]); }
    catch (error) { notify(error instanceof Error ? error.message : "Не удалось добавить тег"); }
    finally { setBusy(false); }
  }
  return <div className="page-scroll">
    <div className="page-toolbar">
      <div className="search-box wide"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Имя, телефон, email или переменная" /></div>
      <button className={`button secondary ${filtersOpen ? "active" : ""}`} onClick={() => setFiltersOpen(!filtersOpen)}><SlidersHorizontal size={16} />Фильтры</button>
      {canManageBulk && <button className="button secondary" onClick={onSegments}><Tag size={16} />Сегменты</button>}
      {canManageAttributes && <button className="button secondary" onClick={onManageAttributes}><Database size={16} />Переменные</button>}
      <span className="toolbar-spacer" />
      {canManageBulk && <input ref={importRef} hidden type="file" accept=".csv,.json,text/csv,application/json" onChange={(event) => void importFile(event)} />}
      {canManageBulk && <button className="button secondary" disabled={busy} onClick={() => importRef.current?.click()}>Импорт</button>}
      {canManageBulk && <button className="button secondary" disabled={busy} onClick={() => void download("csv")}>Экспорт CSV</button>}
      {canManageBulk && <button className="button secondary compact-button" disabled={busy} onClick={() => void download("json")}>JSON</button>}
      <button className="button primary" onClick={onCreate}><Plus size={17} />Контакт</button>
    </div>
    {filtersOpen && <div className="contact-filters">
      <div className="contact-filter-field"><span>Канал</span><AppSelect compact ariaLabel="Канал контакта" value={channel} onValueChange={(value) => setChannel(value as "" | Channel)} options={[{ value: "", label: "Все каналы", detail: "Показывать всю базу", icon: <Inbox size={15} /> }, ...Object.entries(channelMeta).map(([value, meta]) => ({ value, label: meta.label, detail: value === "api" ? "Универсальная интеграция" : `${meta.label} · официальный API`, color: value === "telegram" ? "#2aabee" : value === "vk" ? "#2787f5" : value === "whatsapp" ? "#25b967" : value === "avito" ? "#00aaff" : "#6d5ce7" }))]} /></div>
      <div className="contact-filter-field"><span>Рассылки</span><AppSelect compact ariaLabel="Статус рассылок" value={marketing} onValueChange={setMarketing} options={[{ value: "", label: "Любой статус", detail: "Не учитывать подписку", icon: <Mail size={15} /> }, { value: "GRANTED", label: "Согласие получено", detail: "Можно включать в рассылки", color: "#16a66a" }, { value: "REVOKED", label: "Отписался", detail: "Исключён из рассылок", color: "#e05252" }, { value: "UNKNOWN", label: "Не указан", detail: "Согласие не зафиксировано", color: "#d99216" }]} /></div>
      <label><span>Тег</span><input value={tagFilter} onChange={(event) => setTagFilter(event.target.value)} placeholder="Например, VIP" /></label>
      <button className="button secondary" onClick={() => { setChannel(""); setMarketing(""); setTagFilter(""); }}>Сбросить</button>
    </div>}
    <div className="stats-strip"><MetricMini label="Всего контактов" value={new Intl.NumberFormat("ru-RU").format(contacts.length)} /><MetricMini label="Активны 30 дней" value={new Intl.NumberFormat("ru-RU").format(active30)} /><MetricMini label="С диалогом" value={new Intl.NumberFormat("ru-RU").format(contacts.filter((contact) => contact.conversationId).length)} /><MetricMini label="Отписались" value={new Intl.NumberFormat("ru-RU").format(unsubscribed)} down={unsubscribed > 0} /></div>
    {selectedIds.length>0&&<div className="bulk-toolbar"><b>Выбрано: {selectedIds.length}</b><button className="button secondary" disabled={busy} onClick={()=>void bulkAddTag()}><Tag size={15}/>Добавить тег</button><button className="button secondary" disabled={busy} onClick={()=>void bulkMarketing("GRANTED")}>Разрешить рассылки</button><button className="button secondary danger" disabled={busy} onClick={()=>void bulkMarketing("REVOKED")}>Отписать</button><button className="icon-button" onClick={()=>setSelectedIds([])}><X size={15}/></button></div>}<div className="data-card"><table className="contact-table"><thead><tr><th><input type="checkbox" aria-label="Выбрать все показанные контакты" checked={filtered.length>0&&filtered.every((contact)=>selectedIds.includes(contact.id))} onChange={(event)=>setSelectedIds(event.target.checked?[...new Set([...selectedIds,...filtered.map((contact)=>contact.id)])]:selectedIds.filter((id)=>!filtered.some((contact)=>contact.id===id)))} /></th><th>Контакт</th><th>Каналы</th><th>Стадия</th><th>Теги</th><th>{visibleAttribute ? <AppSelect compact ariaLabel="Переменная в таблице" value={visibleAttribute.key} onValueChange={setVisibleAttributeKey} options={contactAttributes.map((item) => ({ value: item.key, label: item.label, detail: `${item.key} · ${item.valueType}` }))} menuWidth={250} /> : <span>Переменная</span>}</th><th>Последняя активность</th><th /></tr></thead><tbody>{filtered.map((contact) => {
      const conversation = conversations.find((item) => item.contactId === contact.id); const channels = [...new Set(contact.identities.map((identity) => identity.channel))];
      return <tr key={contact.id} className={selectedIds.includes(contact.id)?"selected":""}><td><input type="checkbox" aria-label={`Выбрать ${contact.displayName}`} checked={selectedIds.includes(contact.id)} onChange={(event)=>setSelectedIds((ids)=>event.target.checked?[...ids,contact.id]:ids.filter((id)=>id!==contact.id))}/></td><td><button className="table-person" onClick={() => onOpen(contact)}><ContactAvatar contactId={contact.id} channel={conversation?.channel ?? contact.identities[0]?.channel ?? "api"} avatarAvailable={contact.avatarAvailable} avatarVersion={contact.updatedAt} initials={initials(contact.displayName)} seed={contact.id} size="md" /><span><b>{contact.displayName}</b><small>{contact.phone || contact.email || "Нет контактов"}</small></span></button></td><td><div className="channel-stack">{channels.map((item) => <ChannelBadge channel={item} compact key={item} />)}{!channels.length && <span>—</span>}</div></td><td><span className="stage-pill"><i />{conversation?.stage || "Без сделки"}</span></td><td><div className="table-tags">{(contact.tags ?? []).slice(0,2).map((tag) => <span key={tag}>{tag}</span>)}</div></td><td><strong className="score">{visibleAttribute ? displayAttribute(contact.attributes[visibleAttribute.key]) : "—"}</strong></td><td><span className="last-active">{contact.lastActivityAt ? shortTime(contact.lastActivityAt) : "—"}<small>{contact.city || ""}</small></span></td><td><button className="icon-button" aria-label={`Редактировать ${contact.displayName}`} onClick={() => onEdit(contact)}><MoreHorizontal size={16} /></button></td></tr>;
    })}</tbody></table><div className="table-footer"><span>Показано {filtered.length} из {contacts.length} контактов</span></div></div>
  </div>;
}

function ContactModal({ canMerge, canDelete, contact, allContacts, close, changed, notify }: { canMerge: boolean; canDelete: boolean; contact?: ApiContact; allContacts: ApiContact[]; close: () => void; changed: () => Promise<void>; notify: (text: string) => void }) {
  const [displayName, setDisplayName] = useState(contact?.displayName ?? ""); const [phone, setPhone] = useState(contact?.phone ?? ""); const [email, setEmail] = useState(contact?.email ?? ""); const [city, setCity] = useState(contact?.city ?? ""); const [tags, setTags] = useState((contact?.tags ?? []).join(", ")); const [attributes, setAttributes] = useState(JSON.stringify(contact?.attributes ?? {}, null, 2)); const [activity, setActivity] = useState<{notes:Array<{id:string;body:string;createdAt:string}>;tasks:Array<{id:string;title:string;completedAt?:string;createdAt:string}>}>({notes:[],tasks:[]}); const [note, setNote] = useState(""); const [task, setTask] = useState(""); const [mergeSource, setMergeSource] = useState(""); const [confirmAnonymize, setConfirmAnonymize] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  async function loadActivity() { if (contact) { const value = await botcrmApi.contactActivity(contact.id); setActivity(value); } }
  useEffect(() => { void loadActivity(); }, [contact?.id]);
  async function save(event: FormEvent) { event.preventDefault(); setBusy(true); setError(""); try { let parsed: Record<string,unknown>; try { parsed = JSON.parse(attributes); } catch { throw new Error("Переменные должны быть корректным JSON-объектом"); } let saved = contact ? await botcrmApi.updateContact(contact.id,{displayName,phone:phone||null,email:email||null,city:city||null,attributes:parsed}) : await botcrmApi.createContact({displayName,phone:phone||undefined,email:email||undefined,city:city||undefined,attributes:parsed}); const tagList=tags.split(",").map((item)=>item.trim()).filter(Boolean); if(tagList.length || contact) saved=await botcrmApi.setContactTags(saved.id,tagList); await changed(); notify(contact?"Карточка контакта обновлена":"Контакт создан"); close(); } catch(reason){setError(reason instanceof Error?reason.message:"Не удалось сохранить контакт");} finally{setBusy(false);} }
  async function addNote() { if(!contact||!note.trim()) return; setBusy(true); try{await botcrmApi.addContactNote(contact.id,note.trim());setNote("");await loadActivity();}finally{setBusy(false);} }
  async function addTask() { if(!contact||!task.trim()) return; setBusy(true); try{await botcrmApi.addContactTask(contact.id,{title:task.trim()});setTask("");await loadActivity();}finally{setBusy(false);} }
  async function merge() { if(!contact||!mergeSource) return; setBusy(true); setError(""); try{await botcrmApi.mergeContacts(contact.id,mergeSource);await changed();notify("Контакты объединены");close();}catch(reason){setError(reason instanceof Error?reason.message:"Не удалось объединить контакты");}finally{setBusy(false);} }
  async function anonymize() { if(!contact) return; if(!confirmAnonymize){setConfirmAnonymize(true);return;} setBusy(true);try{await botcrmApi.anonymizeContact(contact.id);await changed();notify("Контакт обезличен");close();}finally{setBusy(false);} }
  return <div className="modal-backdrop" role="dialog" aria-modal="true" onMouseDown={(event) => event.target === event.currentTarget && close()}><form className="modal contact-modal" onSubmit={save}><header><div><span className="eyebrow">CRM-карточка</span><h2>{contact?contact.displayName:"Новый контакт"}</h2></div><button type="button" className="icon-button" onClick={close}><X size={19}/></button></header><div className="modal-body contact-editor-grid"><section><div className="form-split"><label className="form-field"><span>Имя</span><input required minLength={2} value={displayName} onChange={(event)=>setDisplayName(event.target.value)}/></label><label className="form-field"><span>Город</span><input value={city} onChange={(event)=>setCity(event.target.value)}/></label></div><div className="form-split"><label className="form-field"><span>Телефон</span><input value={phone} onChange={(event)=>setPhone(event.target.value)}/></label><label className="form-field"><span>Email</span><input type="email" value={email} onChange={(event)=>setEmail(event.target.value)}/></label></div><label className="form-field"><span>Теги через запятую</span><input value={tags} onChange={(event)=>setTags(event.target.value)} placeholder="VIP, горячий"/></label><label className="form-field"><span>Переменные · JSON</span><textarea rows={8} value={attributes} onChange={(event)=>setAttributes(event.target.value)} spellCheck={false}/></label>{contact&&canMerge&&<><label className="form-field"><span>Объединить с контактом</span><select className="select-field" value={mergeSource} onChange={(event)=>setMergeSource(event.target.value)}><option value="">Выберите дубль</option>{allContacts.filter((item)=>item.id!==contact.id).map((item)=><option value={item.id} key={item.id}>{item.displayName}</option>)}</select></label><button type="button" className="button secondary" disabled={!mergeSource||busy} onClick={()=>void merge()}>Объединить карточки</button></>}</section>{contact&&<section className="contact-activity-editor"><h3>Заметки и задачи</h3><div className="inline-create"><input value={note} onChange={(event)=>setNote(event.target.value)} placeholder="Внутренняя заметка"/><button type="button" onClick={()=>void addNote()} disabled={busy||!note.trim()}><Plus size={15}/></button></div><div className="activity-mini-list">{activity.notes.map((item)=><article key={item.id}><b>{item.body}</b><small>{new Date(item.createdAt).toLocaleString("ru-RU")}</small></article>)}</div><div className="inline-create"><input value={task} onChange={(event)=>setTask(event.target.value)} placeholder="Новая задача"/><button type="button" onClick={()=>void addTask()} disabled={busy||!task.trim()}><Plus size={15}/></button></div><div className="activity-mini-list">{activity.tasks.map((item)=><article key={item.id} className={item.completedAt?"completed":""}><b>{item.title}</b>{item.completedAt?<small>Выполнена</small>:<button type="button" onClick={async()=>{await botcrmApi.completeTask(item.id);await loadActivity();}}>Выполнить</button>}</article>)}</div></section>}{error&&<div className="form-error"><AlertTriangle size={15}/>{error}</div>}</div><footer>{contact&&canDelete&&<button type="button" className="button secondary danger" onClick={()=>void anonymize()} disabled={busy}>{confirmAnonymize?"Нажмите ещё раз":"Обезличить"}</button>}<span className="toolbar-spacer"/><button type="button" className="button secondary" onClick={close}>Отмена</button><button className="button primary" disabled={busy||!displayName.trim()}>{busy&&<RefreshCw className="spin" size={15}/>}Сохранить</button></footer></form></div>;
}

function MetricMini({ label, value, delta, down }: { label: string; value: string; delta?: string; down?: boolean }) { return <div><span>{label}</span><b>{value}</b>{delta && <em className={down ? "down" : ""}>{delta}</em>}</div>; }

function PipelineView({ canConfigure, stages, pipelines, selectedPipelineId, onSelectPipeline, dragged, setDragged, moveDeal, onCreate, onEdit, onConfigure }: { canConfigure: boolean; stages: Stage[]; pipelines: ApiPipeline[]; selectedPipelineId: string; onSelectPipeline: (id: string) => void; dragged: { dealId: string; stageId: string } | null; setDragged: (value: { dealId: string; stageId: string } | null) => void; moveDeal: (stageId: string) => void; onCreate: (stageId?: string) => void; onEdit: (deal: Deal) => void; onConfigure: () => void }) {
  const [query, setQuery] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [minAmount, setMinAmount] = useState("");
  const [tag, setTag] = useState("");
  const normalized = query.trim().toLowerCase();
  const visibleStages = stages.map((stage) => ({ ...stage, deals: stage.deals.filter((deal) => {
    const queryMatch = !normalized || `${deal.name} ${deal.contactName} ${deal.contactDetail} ${deal.bot} ${deal.tags.join(" ")}`.toLowerCase().includes(normalized);
    const amountMatch = !minAmount || deal.amount >= Number(minAmount);
    const tagMatch = !tag.trim() || deal.tags.some((value) => value.toLowerCase().includes(tag.trim().toLowerCase()));
    return queryMatch && amountMatch && tagMatch;
  }) }));
  const total = visibleStages.reduce((sum, stage) => sum + stage.deals.reduce((inner, deal) => inner + deal.amount, 0), 0);
  const totalDeals = visibleStages.reduce((sum, stage) => sum + stage.deals.length, 0);
  return <div className="pipeline-page">
    <div className="pipeline-toolbar"><AppSelect className="pipeline-select" compact value={selectedPipelineId} options={pipelines.map((pipeline)=>({value:pipeline.id,label:pipeline.name,icon:<Columns3 size={15}/>}))} onValueChange={onSelectPipeline} ariaLabel="Выберите воронку" menuWidth={220}/><div className="pipeline-summary"><span>{totalDeals} сделок</span><b>{formatMoney(total)}</b></div><span className="toolbar-spacer" /><label className="pipeline-search"><Search size={16}/><input value={query} onChange={(event)=>setQuery(event.target.value)} placeholder="Поиск сделки"/></label><button className={`button secondary ${filtersOpen?"active":""}`} onClick={()=>setFiltersOpen(!filtersOpen)}><SlidersHorizontal size={16} />Фильтры</button><button className="button primary" onClick={()=>onCreate()}><Plus size={17} />Сделка</button></div>
    {filtersOpen&&<div className="pipeline-filters" role="dialog" aria-label="Фильтры воронки"><header><b>Фильтры сделок</b><button className="icon-button" aria-label="Закрыть фильтры" onClick={()=>setFiltersOpen(false)}><X size={15}/></button></header><div><label><span>Минимальная сумма</span><input type="number" min="0" value={minAmount} onChange={(event)=>setMinAmount(event.target.value)}/></label><label><span>Тег</span><input value={tag} onChange={(event)=>setTag(event.target.value)} placeholder="VIP"/></label></div><footer><button className="button secondary" onClick={()=>{setMinAmount("");setTag("");}}>Сбросить</button><button className="button primary" onClick={()=>setFiltersOpen(false)}>Применить</button></footer></div>}
    <div className="kanban-scroll">{visibleStages.map((stage)=><section className={`kanban-column ${dragged?"drag-active":""}`} key={stage.id} onDragOver={(event)=>event.preventDefault()} onDrop={()=>moveDeal(stage.id)}><header><span><i style={{background:stage.color}}/>{stage.title}<em>{stage.deals.length}</em></span>{canConfigure && <button aria-label={`Настроить стадию ${stage.title}`} onClick={onConfigure}><MoreHorizontal size={17}/></button>}</header><div className="column-total">{formatMoney(stage.deals.reduce((sum,deal)=>sum+deal.amount,0))}</div><div className="deal-list">{stage.deals.map((deal)=><article className="deal-card" key={deal.id} draggable onDragStart={()=>setDragged({dealId:deal.id,stageId:stage.id})} onDragEnd={()=>setDragged(null)} onClick={()=>onEdit(deal)} role="button" tabIndex={0} onKeyDown={(event)=>{if(event.key==="Enter")onEdit(deal);}}>
  <div className="deal-card-top"><GripVertical size={15}/><span className="deal-card-kind">Сделка</span><time>{deal.age}</time></div>
  <div className="deal-card-contact">
    <ContactAvatar contactId={deal.contactId} channel={deal.channel} avatarAvailable={deal.avatarAvailable} avatarVersion={deal.avatarVersion} initials={initials(deal.contactName)} seed={deal.contactId || deal.id} size="sm" />
    <span><small>Клиент</small><b>{deal.contactName}</b><em><ChannelBadge channel={deal.channel} compact />{deal.contactDetail}</em></span>
  </div>
  <div className="deal-card-main"><small>Сделка</small><h3>{deal.name}</h3><strong>{formatMoney(deal.amount)}</strong></div>
  <p><Bot size={13}/><span>{deal.bot}</span></p>
  <div>{deal.tags.map((value)=><span key={value}>{value}</span>)}</div>
</article>)}<button className="add-card" onClick={()=>onCreate(stage.id)}><Plus size={15}/>Добавить сделку</button></div></section>)}</div>
  </div>;
}
function PipelineSettingsModal({ pipeline, close, changed, notify }: { pipeline?: ApiPipeline; close: () => void; changed: () => Promise<void>; notify: (text: string) => void }) {
  const [newStage, setNewStage] = useState(""); const [newPipeline, setNewPipeline] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  async function addPipeline(){if(!newPipeline.trim())return;setBusy(true);setError("");try{await botcrmApi.createPipeline({name:newPipeline.trim()});setNewPipeline("");await changed();notify("Воронка создана");}catch(reason){setError(reason instanceof Error?reason.message:"Не удалось создать воронку");}finally{setBusy(false);}}
  async function addStage() { if(!pipeline||!newStage.trim())return;setBusy(true);setError("");try{await botcrmApi.createStage(pipeline.id,{name:newStage.trim()});setNewStage("");await changed();notify("Стадия добавлена");}catch(reason){setError(reason instanceof Error?reason.message:"Не удалось добавить стадию");}finally{setBusy(false);} }
  async function rename(id:string,name:string){if(!name.trim())return;setBusy(true);try{await botcrmApi.updateStage(id,{name:name.trim()});await changed();}finally{setBusy(false);}}
  async function remove(id:string){setBusy(true);setError("");try{await botcrmApi.deleteStage(id);await changed();notify("Стадия удалена");}catch(reason){setError(reason instanceof Error?reason.message:"Не удалось удалить стадию");}finally{setBusy(false);}}
  return <div className="modal-backdrop" role="dialog" aria-modal="true" onMouseDown={(event) => event.target === event.currentTarget && close()}><section className="modal pipeline-modal"><header><div><span className="eyebrow">Настройка канбана</span><h2>{pipeline?.name||"Воронка"}</h2></div><button className="icon-button" onClick={close}><X size={19}/></button></header><div className="modal-body"><div className="stage-settings">{pipeline?.stages.map((stage,index)=><article key={stage.id}><input type="color" value={stage.color} onChange={async(event)=>{await botcrmApi.updateStage(stage.id,{color:event.target.value});await changed();}}/><input defaultValue={stage.name} onBlur={(event)=>event.target.value!==stage.name&&void rename(stage.id,event.target.value)}/><span>{stage.dealCount} сделок</span><select value={stage.terminalKind??""} onChange={async(event)=>{await botcrmApi.updateStage(stage.id,{terminalKind:(event.target.value||null) as "WON"|"LOST"|null});await changed();}}><option value="">Обычная</option><option value="WON">Успешная</option><option value="LOST">Проигранная</option></select><button className="icon-button stage-move" disabled={busy||index===0} title="Выше" onClick={async()=>{await botcrmApi.updateStage(stage.id,{position:index-1});await changed();}}>↑</button><button className="icon-button stage-move" disabled={busy||index===(pipeline?.stages.length??0)-1} title="Ниже" onClick={async()=>{await botcrmApi.updateStage(stage.id,{position:index+1});await changed();}}>↓</button><button className="icon-button" disabled={busy||stage.dealCount>0} onClick={()=>void remove(stage.id)} title={stage.dealCount>0?"Сначала переместите сделки":"Удалить"}><X size={15}/></button></article>)}</div><div className="inline-create"><input value={newStage} onChange={(event)=>setNewStage(event.target.value)} placeholder="Название новой стадии"/><button onClick={()=>void addStage()} disabled={busy||!newStage.trim()}><Plus size={15}/></button></div><div className="pipeline-create-row"><b>Новая воронка</b><div className="inline-create"><input value={newPipeline} onChange={(event)=>setNewPipeline(event.target.value)} placeholder="Например: Повторные продажи"/><button onClick={()=>void addPipeline()} disabled={busy||!newPipeline.trim()}><Plus size={15}/></button></div></div>{error&&<div className="form-error"><AlertTriangle size={15}/>{error}</div>}</div><footer><button className="button primary" onClick={close}>Готово</button></footer></section></div>;
}
function DealModal({ contacts, pipeline, deal, initialStageId, close, saved }: { contacts: ApiContact[]; pipeline?: ApiPipeline; deal?: Deal; initialStageId?: string; close: () => void; saved: (editing: boolean) => Promise<void> }) {
  const [contactId, setContactId] = useState(deal?.contactId ?? contacts[0]?.id ?? "");
  const [stageId, setStageId] = useState(initialStageId ?? pipeline?.stages[0]?.slug ?? "");
  const [title, setTitle] = useState(deal?.name ?? "");
  const [amount, setAmount] = useState(deal ? String(deal.amount) : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const contactOptions = useMemo<AppSelectOption[]>(() => contacts.map((contact) => {
    const primaryIdentity = contact.identities[0];
    const channel = (primaryIdentity?.channel ?? "api") as Channel;
    const username = ["telegram_username", "vk_username", "username"]
      .map((key) => contact.attributes[key])
      .find((value): value is string => typeof value === "string" && value.trim().length > 0);
    const identitySummary = contact.identities
      .map((identity) => `${channelMeta[identity.channel as Channel].short} ID ${identity.externalUserId}`)
      .join(" · ");
    const detail = [
      username ? (username.startsWith("@") ? username : `@${username}`) : "",
      contact.phone,
      contact.email,
      identitySummary || `CRM ID ${contact.id.slice(0, 8)}`,
    ].filter(Boolean).join(" · ");

    return {
      value: contact.id,
      label: contact.displayName,
      detail,
      icon: (
        <span className="deal-contact-avatar">
          <ContactAvatar
            contactId={contact.id}
            channel={channel}
            avatarAvailable={contact.avatarAvailable}
            avatarVersion={contact.updatedAt}
            initials={initials(contact.displayName)}
            seed={contact.id}
            size="sm"
          />
          <ChannelBadge channel={channel} compact />
        </span>
      ),
    };
  }), [contacts]);

  const stageOptions = useMemo<AppSelectOption[]>(() => (pipeline?.stages ?? []).map((stage) => ({
    value: stage.slug,
    label: stage.name,
    detail: "Этап воронки",
    color: stage.color,
  })), [pipeline]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (deal) {
        await botcrmApi.updateDeal(deal.id, { title, amount: Number(amount) || 0, expectedVersion: deal.version ?? 1 });
      } else {
        await botcrmApi.createDeal({ contactId, pipelineId: pipeline?.id, stageId, title, amount: Number(amount) || 0 });
      }
      await saved(Boolean(deal));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось сохранить сделку");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <form className="modal deal-modal" onSubmit={submit}>
        <header>
          <div><span className="eyebrow">Карточка канбана</span><h2>{deal ? "Редактировать сделку" : "Создать сделку"}</h2></div>
          <button type="button" className="icon-button" onClick={close}><X size={19} /></button>
        </header>
        <div className="modal-body">
          <label className="form-field">
            <span>Контакт</span>
            <AppSelect
              ariaLabel="Контакт сделки"
              className="deal-contact-select"
              disabled={Boolean(deal)}
              value={contactId}
              onValueChange={setContactId}
              options={contactOptions}
              placeholder="Выберите контакт"
              searchable
              searchPlaceholder="Имя, телефон, email, username или ID"
              matchTriggerWidth
            />
          </label>
          <label className="form-field">
            <span>Название сделки</span>
            <input required minLength={2} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Например: Покупка тарифа Pro" />
          </label>
          <div className="form-split">
            {!deal && <label className="form-field">
              <span>Стадия</span>
              <AppSelect ariaLabel="Стадия сделки" className="deal-stage-select" value={stageId} onValueChange={setStageId} options={stageOptions} matchTriggerWidth />
            </label>}
            <label className="form-field"><span>Сумма, ₽</span><input type="number" min="0" value={amount} onChange={(event) => setAmount(event.target.value)} /></label>
          </div>
          {error && <div className="form-error"><AlertTriangle size={15} />{error}</div>}
        </div>
        <footer>
          <button type="button" className="button secondary" onClick={close}>Отмена</button>
          <button className="button primary" disabled={busy || !contactId || !title.trim()}>{busy && <RefreshCw className="spin" size={15} />}Сохранить</button>
        </footer>
      </form>
    </div>
  );
}

function CampaignsView({ canManage, items, onCreate, onEdit, onStart, onPause, onCancel, actionId }: { canManage: boolean; items: CampaignCardItem[]; onCreate: () => void; onEdit: (campaign: ApiCampaign) => void; onStart: (id?: string) => void; onPause: (id?: string) => void; onCancel: (id?: string) => void; actionId: string | null }) {
  const [status,setStatus]=useState<"all"|"running"|"scheduled"|"draft">("all");
  const [days,setDays]=useState("30");
  const [recipientCampaign,setRecipientCampaign]=useState<CampaignCardItem|null>(null);
  const [recipients,setRecipients]=useState<ApiCampaignRecipient[]>([]);
  const [recipientsLoading,setRecipientsLoading]=useState(false);
  const cutoff=days==="all"?0:Date.now()-Number(days)*86_400_000;
  const filtered=items.filter((item)=>(status==="all"||item.rawStatus===status)&&(!cutoff||new Date(item.createdAt).valueOf()>=cutoff));
  const audienceTotal=filtered.reduce((sum,item)=>sum+(item.source.eligible??item.source.audience??0),0);
  const sentTotal=filtered.reduce((sum,item)=>sum+(item.sentCount??0),0);
  const deliveredTotal=filtered.reduce((sum,item)=>sum+(item.deliveredCount??0),0);
  const failedTotal=filtered.reduce((sum,item)=>sum+(item.failedCount??0),0);
  async function showRecipients(item:CampaignCardItem){if(!item.id)return;setRecipientCampaign(item);setRecipientsLoading(true);try{setRecipients(await botcrmApi.campaignRecipients(item.id));}finally{setRecipientsLoading(false);}}
  return <div className="page-scroll">
    <div className="stats-strip campaign-stats"><MetricMini label="Аудитория" value={new Intl.NumberFormat("ru-RU").format(audienceTotal)}/><MetricMini label="Отправлено" value={new Intl.NumberFormat("ru-RU").format(sentTotal)}/><MetricMini label="Доставлено" value={sentTotal?`${(deliveredTotal/sentTotal*100).toFixed(1)}%`:"—"}/><MetricMini label="Ошибки" value={new Intl.NumberFormat("ru-RU").format(failedTotal)} down={failedTotal>0}/></div>
    <div className="page-toolbar"><div className="filter-tabs"><button className={status==="all"?"active":""} onClick={()=>setStatus("all")}>Все <span>{items.length}</span></button><button className={status==="running"?"active":""} onClick={()=>setStatus("running")}>Активные <span>{items.filter((item)=>item.rawStatus==="running").length}</span></button><button className={status==="scheduled"?"active":""} onClick={()=>setStatus("scheduled")}>Запланированные <span>{items.filter((item)=>item.rawStatus==="scheduled").length}</span></button><button className={status==="draft"?"active":""} onClick={()=>setStatus("draft")}>Черновики <span>{items.filter((item)=>item.rawStatus==="draft").length}</span></button></div><span className="toolbar-spacer"/><div className="period-app-select"><Calendar size={16}/><AppSelect compact ariaLabel="Период рассылок" value={days} onValueChange={setDays} options={[{value:"7",label:"За 7 дней"},{value:"30",label:"За 30 дней"},{value:"90",label:"За 90 дней"},{value:"all",label:"За всё время"}]}/></div></div>
    <div className="campaign-grid">{filtered.map((item)=>{
      const busy=actionId===item.id;
      const canStart=["draft","scheduled","paused"].includes(item.rawStatus);
      const canPause=item.rawStatus==="running";
      const canCancel=!["completed","cancelled"].includes(item.rawStatus);
      const canEdit=["draft","scheduled"].includes(item.rawStatus);
      return <article className="campaign-card" key={item.id||item.name}>
        <div className="campaign-card-head"><div className="campaign-icon"><Megaphone size={21}/></div><div className="campaign-title"><h3>{item.name}</h3><p><span>{item.channel}</span><i/>{item.segment}</p></div><span className={`campaign-status ${item.tone}`}><i/>{item.status}</span></div>
        <div className="campaign-numbers"><label><span>Аудитория</span><b>{item.audience}</b></label><label><span>Отправлено</span><b>{item.sent}</b></label><label><span>Доставлено</span><b>{item.delivered}</b></label></div>
        <div className="campaign-card-footer"><div className="campaign-primary-action">{canManage&&canStart&&<button className="button primary campaign-start" disabled={!item.id||busy} onClick={()=>onStart(item.id)}>{busy?<RefreshCw size={15} className="spin"/>:<Send size={15}/>} {busy?"Обработка…":item.rawStatus==="paused"?"Продолжить":"Запустить"}</button>}{canManage&&canPause&&<button className="button secondary campaign-start" disabled={!item.id||busy} onClick={()=>onPause(item.id)}><Pause size={15}/>{busy?"Обработка…":"Пауза"}</button>}</div><div className="campaign-card-actions">{canManage&&canEdit&&<button className="icon-button campaign-edit" aria-label={`Редактировать рассылку ${item.name}`} onClick={()=>onEdit(item.source)}><Pencil size={17}/></button>}{canManage&&canCancel&&<button className="icon-button campaign-cancel" aria-label={`Отменить рассылку ${item.name}`} disabled={!item.id||busy} onClick={()=>onCancel(item.id)}><X size={17}/></button>}{canManage&&<button className="icon-button" aria-label={`Получатели рассылки ${item.name}`} onClick={()=>void showRecipients(item)}><Eye size={18}/></button>}</div></div>
      </article>;
    })}{canManage && <button className="new-campaign-card" onClick={onCreate}><div><Plus size={23}/></div><b>Создать рассылку</b><span>Выберите сегмент и канал</span></button>}</div>
    {filtered.length===0&&<div className="workspace-empty compact"><Megaphone size={30}/><h2>Ничего не найдено</h2><p>Измените статус или период.</p></div>}
    {recipientCampaign&&<div className="modal-backdrop" role="dialog" aria-modal="true" onMouseDown={(event)=>event.target===event.currentTarget&&setRecipientCampaign(null)}><section className="modal recipients-modal"><header><div><span className="eyebrow">Результаты рассылки</span><h2>{recipientCampaign.name}</h2></div><button className="icon-button" onClick={()=>setRecipientCampaign(null)}><X size={18}/></button></header><div className="modal-body"><div className="recipient-summary"><b>{recipients.length}</b><span>получателей в зафиксированной аудитории</span></div>{recipientsLoading?<div className="empty-inline"><RefreshCw className="spin" size={18}/>Загрузка…</div>:<div className="recipient-list">{recipients.map((recipient)=><article key={recipient.id}><span><b>{recipient.contactName||recipient.contactId}</b><small>{recipient.externalUserId} · попыток: {recipient.attemptCount}</small></span><em className={recipient.status.toLowerCase()}>{recipient.status}</em>{recipient.lastError&&<small>{recipient.lastError}</small>}</article>)}{!recipients.length&&<div className="empty-inline">Получателей пока нет — запустите рассылку</div>}</div>}</div><footer><button className="button primary" onClick={()=>setRecipientCampaign(null)}>Готово</button></footer></section></div>}
  </div>;
}
const campaignTemplateVariables: TemplateVariable[] = [
  { key: "first_name", token: "{{first_name}}", label: "Имя", description: "Первое слово из имени контакта", example: "Евгений", tone: "violet" },
  { key: "last_name", token: "{{last_name}}", label: "Фамилия", description: "Остальная часть полного имени", example: "Иванов", tone: "pink" },
  { key: "full_name", token: "{{full_name}}", label: "Полное имя", description: "Имя контакта целиком", example: "Евгений Иванов", tone: "blue" },
  { key: "email", token: "{{email}}", label: "Email", description: "Электронная почта контакта", example: "client@example.com", tone: "orange" },
  { key: "phone", token: "{{phone}}", label: "Телефон", description: "Телефон из карточки контакта", example: "+7 900 000-00-00", tone: "green" },
  { key: "city", token: "{{city}}", label: "Город", description: "Город из карточки контакта", example: "Омск", tone: "blue" },
];

function campaignVariablesForContacts(contacts: ApiContact[], discovered: Array<{ key: string; example?: string }> = []) {
  const variables = new Map(campaignTemplateVariables.map((variable) => [variable.key, variable]));
  const tones: TemplateVariable["tone"][] = ["orange", "green", "blue", "pink", "violet"];
  const addValue = (path: string, value: unknown) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      Object.entries(value as Record<string, unknown>).forEach(([key, child]) => addValue(`${path}.${key}`, child));
      return;
    }
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return;
    const key = path.includes(".") ? `attributes.${path}` : path;
    if (variables.has(key)) return;
    const fieldName = path.split(".").at(-1) ?? path;
    variables.set(key, { key, token: `{{${key}}}`, label: fieldName.replaceAll("_", " "), description: `Пользовательское поле контакта · ${path}`, example: String(value), tone: tones[variables.size % tones.length] });
  };
  discovered.forEach((variable) => addValue(variable.key, variable.example ?? ""));
  contacts.forEach((contact) => Object.entries(contact.attributes ?? {}).forEach(([key, value]) => addValue(key, value)));
  return Array.from(variables.values());
}
function renderCampaignPreview(template: string, contact?: ApiContact) {
  if (!contact) return template;
  const attributes = contact.attributes ?? {};
  const displayName = contact.displayName?.trim() ?? "";
  const parts = displayName.split(/\s+/).filter(Boolean);
  const read = (path: string) => {
    const source: Record<string, unknown> = {
      ...attributes,
      attributes,
      first_name: attributes.first_name ?? attributes.firstName ?? parts[0],
      firstName: attributes.firstName ?? attributes.first_name ?? parts[0],
      last_name: attributes.last_name ?? attributes.lastName ?? parts.slice(1).join(" "),
      lastName: attributes.lastName ?? attributes.last_name ?? parts.slice(1).join(" "),
      full_name: displayName,
      display_name: displayName,
      name: displayName,
      email: contact.email,
      phone: contact.phone,
      city: contact.city,
    };
    return path.split(".").reduce<unknown>((value, key) => value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : undefined, source);
  };
  return template.replace(/\{\{\s*([^{}|]+?)(?:\s*\|\s*([^{}]*?))?\s*\}\}/g, (_match, path: string, fallback?: string) => {
    const value = read(path.trim());
    return typeof value === "string" ? value.trim() || fallback?.trim() || "" : typeof value === "number" || typeof value === "boolean" ? String(value) : fallback?.trim() || "";
  });
}
function CampaignModal({ segments, initial, close, launch }: { segments: ApiSegment[]; initial?: ApiCampaign; close: () => void; launch: (input: { name: string; channel: Channel; content: string; buttons?: ApiCampaignButton[]; mediaIds?: string[]; segmentId?: string; scheduledAt?: string; timeZone?: string }) => Promise<void> }) {
  const initialTimeZone = initial?.timeZone ?? "Europe/Moscow";
  const [name, setName] = useState(initial?.name ?? "Август · новый запуск");
  const [channel, setChannel] = useState<Channel>(initial?.channel ?? "telegram");
  const [content, setContent] = useState(initial?.content ?? "Здравствуйте, {{first_name}}! Подготовили для вас персональное предложение. Ответьте на это сообщение, и менеджер расскажет детали.");
  const [buttons, setButtons] = useState<ApiCampaignButton[]>(initial?.buttons ?? []);
  const [media, setMedia] = useState<CampaignMedia[]>(() => (initial?.mediaIds ?? []).map((id, index) => ({ id, filename: `Сохранённое изображение ${index + 1}`, mimeType: "image/*", byteSize: 0, createdAt: initial.createdAt, status: "attached", expiresAt: initial.createdAt, previewUrl: "" })));
  const [segmentId, setSegmentId] = useState(initial?.segmentId ?? segments[0]?.id ?? "");
  const [preview, setPreview] = useState<{ total: number; eligible: number; excluded: number; contacts: ApiContact[]; variables: Array<{ key: string; example?: string }> }>({ total: 0, eligible: 0, excluded: 0, contacts: [], variables: [] });
  const [showAudience, setShowAudience] = useState(false);
  const [testRecipient, setTestRecipient] = useState("");
  const [testStatus, setTestStatus] = useState("");
  const [testing, setTesting] = useState(false);
  const [scheduleMode, setScheduleMode] = useState<"draft" | "scheduled">(initial?.status === "scheduled" ? "scheduled" : "draft");
  const [scheduleTimeZone, setScheduleTimeZone] = useState(initialTimeZone);
  const [scheduledAt, setScheduledAt] = useState(() => initial?.scheduledAt ?? defaultCampaignSchedule(initialTimeZone));
  const [submitting, setSubmitting] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const selectedPreviewContact = preview.contacts.find((contact) => contact.id === testRecipient) ?? preview.contacts[0];
  const templateVariables = useMemo(() => campaignVariablesForContacts(preview.contacts, preview.variables), [preview.contacts, preview.variables]);
  const personalizedPreview = useMemo(() => renderCampaignPreview(content, selectedPreviewContact), [content, selectedPreviewContact]);
  const richValidation = validateCampaignRichContent(channel, buttons, media);
  const scheduleInvalid = scheduleMode === "scheduled" && new Date(scheduledAt).valueOf() <= Date.now();
  useEffect(() => { let active = true; setPreviewing(true); botcrmApi.previewSegment({ segmentId: segmentId || undefined, filter: segmentId ? undefined : { operator: "AND", conditions: [] }, channel, limit: 20 }).then((value) => { if (active) setPreview(value as typeof preview); }).catch(() => undefined).finally(() => { if (active) setPreviewing(false); }); return () => { active = false; }; }, [segmentId, channel]);
  async function sendTest() { const contactId=testRecipient||preview.contacts[0]?.id; if(!contactId||!content.trim())return; setTesting(true);setTestStatus("");try{await botcrmApi.testCampaign({contactId,channel,content:content.trim(),buttons,mediaIds:media.map((item)=>item.id)});setTestStatus("Тестовое сообщение поставлено в очередь");}catch(error){setTestStatus(error instanceof Error?error.message:"Не удалось отправить тест");}finally{setTesting(false);} }  async function submit(event: FormEvent) { event.preventDefault(); if (!name.trim() || !content.trim() || scheduleInvalid) return; setSubmitting(true); try { await launch({ name: name.trim(), channel, content: content.trim(), buttons, mediaIds: media.map((item)=>item.id), segmentId: segmentId || undefined, scheduledAt: scheduleMode === "scheduled" ? scheduledAt : undefined, timeZone: scheduleMode === "scheduled" ? scheduleTimeZone : undefined }); } finally { setSubmitting(false); } }
  return <div className="modal-backdrop" role="dialog" aria-modal="true" onMouseDown={(event) => event.target === event.currentTarget && close()}><form className="modal campaign-modal" onSubmit={submit}><header><div><span className="eyebrow">{initial ? "Редактирование рассылки" : "Новая рассылка"}</span><h2>{initial ? "Настройки и содержимое" : "Сообщение для сегмента"}</h2></div><button type="button" className="icon-button" onClick={close}><X size={19} /></button></header><div className="modal-body"><label className="form-field"><span>Название</span><input required value={name} onChange={(event) => setName(event.target.value)} /></label><div className="form-split"><label className="form-field"><span>Динамический сегмент</span><AppSelect ariaLabel="Сегмент рассылки" value={segmentId} onValueChange={setSegmentId} options={[{value:"",label:"Все подходящие контакты",detail:"Динамическая выборка по каналу",icon:<Users size={16}/>},...segments.map((segment)=>({value:segment.id,label:segment.name,detail:`${segment.count ?? 0} контактов`,icon:<Tag size={16}/>}))]}/></label><label className="form-field"><span>Канал</span><AppSelect ariaLabel="Канал рассылки" value={channel} onValueChange={(value)=>setChannel(value as Channel)} options={(Object.entries(channelMeta) as Array<[Channel,(typeof channelMeta)[Channel]]>).map(([value,meta])=>({value,label:meta.label,detail:value==="api"?"Универсальный транспорт":"Официальный канал",color:value==="telegram"?"#2aabee":value==="vk"?"#2787f5":value==="whatsapp"?"#25b967":value==="avito"?"#00aaff":"#6d5ce7"}))}/></label></div><TemplateMessageEditor value={content} onChange={setContent} variables={templateVariables} placeholder="Напишите сообщение и вставьте персональные данные…" /><CampaignRichContent channel={channel} buttons={buttons} onButtonsChange={setButtons} media={media} onMediaChange={setMedia} previewText={personalizedPreview} /><div className="audience-preview"><div><Users size={19} /><span><b>{previewing ? "Считаем аудиторию…" : `${preview.eligible} получателей`}</b><small>{preview.excluded} исключены из {preview.total}: нет канала, отписка или запрет</small></span></div><button type="button" onClick={() => setShowAudience(!showAudience)}>{showAudience ? "Скрыть" : "Посмотреть список"}</button></div>{showAudience && <div className="audience-list">{preview.contacts.map((contact) => <span key={contact.id}>{contact.displayName}</span>)}{!preview.contacts.length && <small>Подходящих получателей нет</small>}</div>}<div className="campaign-test-row"><label className="form-field"><span>Тестовый получатель</span><AppSelect ariaLabel="Тестовый получатель" value={testRecipient} onValueChange={setTestRecipient} options={[{value:"",label:"Первый из предпросмотра",detail:"Выбрать автоматически",icon:<User size={16}/>},...preview.contacts.map((contact)=>({value:contact.id,label:contact.displayName,detail:"Тестовая отправка",icon:<User size={16}/>}))]}/></label><button type="button" className="button secondary" disabled={testing||preview.contacts.length===0||!content.trim()||!!richValidation} onClick={()=>void sendTest()}>{testing?<RefreshCw className="spin" size={15}/>:<Send size={15}/>}Отправить тест</button>{testStatus&&<small>{testStatus}</small>}</div><div className="schedule-row"><label><input type="radio" name="schedule" checked={scheduleMode === "draft"} onChange={() => setScheduleMode("draft")} />Сохранить черновик</label><label><input type="radio" name="schedule" checked={scheduleMode === "scheduled"} onChange={() => setScheduleMode("scheduled")} />Запланировать</label></div>{scheduleMode === "scheduled" && <CampaignSchedulePicker value={scheduledAt} timeZone={scheduleTimeZone} onChange={setScheduledAt} onTimeZoneChange={setScheduleTimeZone} />}</div><footer><button type="button" className="button secondary" onClick={close}>Отмена</button><button className="button primary" disabled={submitting || previewing || !name.trim() || !content.trim() || preview.eligible === 0 || !!richValidation || scheduleInvalid}>{submitting ? "Сохранение…" : initial ? "Сохранить изменения" : scheduleMode === "scheduled" ? "Запланировать" : "Сохранить черновик"}</button></footer></form></div>;
}

const segmentBaseFieldOptions: AppSelectOption[] = [
  { value: "name", label: "Имя", detail: "Имя или часть имени контакта", icon: <User size={15} /> },
  { value: "phone", label: "Телефон", detail: "Номер из карточки контакта", icon: <Phone size={15} /> },
  { value: "email", label: "Email", detail: "Адрес электронной почты", icon: <Mail size={15} /> },
  { value: "city", label: "Город", detail: "Город из профиля контакта", icon: <Database size={15} /> },
  { value: "channel", label: "Канал", detail: "Telegram, VK, WhatsApp, Avito или API", icon: <Inbox size={15} /> },
  { value: "tag", label: "Тег", detail: "Тег, назначенный контакту", icon: <Tag size={15} /> },
  { value: "stage", label: "Стадия сделки", detail: "Текущий этап воронки", icon: <Columns3 size={15} /> },
  { value: "last_activity", label: "Последняя активность", detail: "Время последнего события контакта", icon: <Calendar size={15} /> },
];
function segmentFieldOptionsFor(definitions: ApiAttributeDefinition[]): AppSelectOption[] {
  return [...segmentBaseFieldOptions, ...definitions.filter((item) => item.objectScope === "CONTACT" && item.filterable).map((item) => ({ value: `attributes.${item.key}`, label: item.label, detail: `${item.key} · ${item.valueType}`, icon: <Database size={15} /> }))];
}
const segmentLogicOptions: AppSelectOption[] = [
  { value: "AND", label: "Все условия", detail: "Контакт должен соответствовать каждому условию" },
  { value: "OR", label: "Любое условие", detail: "Достаточно совпадения хотя бы с одним условием" },
];
const segmentOperatorOptions: AppSelectOption[] = [
  { value: "equals", label: "Равно", detail: "Полное совпадение значения" },
  { value: "not_equals", label: "Не равно", detail: "Исключить точное значение" },
  { value: "contains", label: "Содержит", detail: "Значение содержит указанный текст" },
  { value: "gte", label: "Больше или равно", detail: "Для чисел и дат" },
  { value: "lte", label: "Меньше или равно", detail: "Для чисел и дат" },
  { value: "exists", label: "Заполнено", detail: "Поле существует и не пустое" },
  { value: "not_exists", label: "Не заполнено", detail: "Поле отсутствует или пустое" },
];
function SegmentManager({ attributeDefinitions, segments, close, changed, notify }: { attributeDefinitions: ApiAttributeDefinition[]; segments: ApiSegment[]; close: () => void; changed: () => Promise<void>; notify: (text: string) => void }) {
  const [name, setName] = useState(""); const [groupOperator, setGroupOperator] = useState<"AND" | "OR">("AND");
  const [conditions, setConditions] = useState<ApiSegmentCondition[]>([{ field: "city", operator: "equals", value: "" }]);
  const segmentFieldOptions = segmentFieldOptionsFor(attributeDefinitions); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  function updateCondition(index: number, patch: Partial<ApiSegmentCondition>) { setConditions((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item)); }
  async function create(event: FormEvent) { event.preventDefault(); setBusy(true); setError(""); try { await botcrmApi.createSegment({ name, filter: { operator: groupOperator, conditions } as ApiSegmentGroup }); setName(""); await changed(); notify("Динамический сегмент создан"); } catch (reason) { setError(reason instanceof Error ? reason.message : "Не удалось создать сегмент"); } finally { setBusy(false); } }
  async function remove(id: string) { setBusy(true); setError(""); try { await botcrmApi.deleteSegment(id); await changed(); notify("Сегмент удалён"); } catch (reason) { setError(reason instanceof Error ? reason.message : "Не удалось удалить сегмент"); } finally { setBusy(false); } }
  return <div className="modal-backdrop" role="dialog" aria-modal="true" onMouseDown={(event) => event.target === event.currentTarget && close()}><section className="modal segment-modal"><header><div><span className="eyebrow">Динамические аудитории</span><h2>Сегменты контактов</h2></div><button className="icon-button" onClick={close}><X size={19} /></button></header><div className="modal-body segment-layout"><section><h3>Сохранённые сегменты</h3><div className="saved-segments">{segments.map((segment) => <article key={segment.id}><span><b>{segment.name}</b><small>{segment.count ?? 0} контактов · {segment.filter.operator}</small></span><button className="icon-button" disabled={busy} aria-label={`Удалить ${segment.name}`} onClick={() => void remove(segment.id)}><X size={15} /></button></article>)}{!segments.length && <div className="empty-inline">Сегментов пока нет</div>}</div></section><form onSubmit={create}><h3>Новый сегмент</h3><label className="form-field"><span>Название</span><input required minLength={2} value={name} onChange={(event) => setName(event.target.value)} placeholder="Например: Горячие лиды" /></label><label className="form-field"><span>Логика условий</span><AppSelect ariaLabel="Логика условий сегмента" value={groupOperator} onValueChange={(value) => setGroupOperator(value as "AND" | "OR")} options={segmentLogicOptions} matchTriggerWidth /></label><div className="segment-conditions">{conditions.map((condition, index) => <div className="segment-condition" key={index}><AppSelect compact className="segment-condition-select" ariaLabel={`Поле условия ${index + 1}`} value={condition.field} onValueChange={(value) => updateCondition(index, { field: value })} options={segmentFieldOptions} menuWidth={270} /><AppSelect compact className="segment-condition-select" ariaLabel={`Оператор условия ${index + 1}`} value={condition.operator} onValueChange={(value) => updateCondition(index, { operator: value as ApiSegmentCondition["operator"] })} options={segmentOperatorOptions} menuWidth={250} />{!["exists", "not_exists"].includes(condition.operator) && <input required value={String(condition.value ?? "")} onChange={(event) => updateCondition(index, { value: ["gt", "gte", "lt", "lte"].includes(condition.operator) ? Number(event.target.value) : event.target.value })} placeholder="Значение" />}<button type="button" className="icon-button" disabled={conditions.length === 1} onClick={() => setConditions((items) => items.filter((_, itemIndex) => itemIndex !== index))}><X size={14} /></button></div>)}</div><button type="button" className="button secondary" onClick={() => setConditions((items) => [...items, { field: "city", operator: "equals", value: "" }])}><Plus size={15} />Добавить условие</button>{error && <div className="form-error"><AlertTriangle size={15} />{error}</div>}<button className="button primary segment-save" disabled={busy || !name.trim()}>{busy && <RefreshCw size={15} className="spin" />}Сохранить сегмент</button></form></div></section></div>;
}

function automationTriggerLabel(trigger: ApiAutomationTrigger) {
  return ({ "message.received": "Получено сообщение", "message.sent": "Отправлено сообщение", "contact.updated": "Контакт обновлён", "conversation.created": "Диалог создан", "deal.created": "Сделка создана", "deal.stage_changed": "Стадия изменена", "button.clicked": "Нажата кнопка", "conversation.inactive": "Нет активности", "campaign.delivered": "Рассылка доставлена", "campaign.failed": "Ошибка рассылки" } as Record<ApiAutomationTrigger, string>)[trigger];
}
function automationActionLabel(action: ApiAutomationRule["actions"][number]) {
  if (action.type === "set_attribute") return `Установить ${action.key} = ${String(action.value)}`;
  if (action.type === "add_tag") return `Добавить тег «${action.tag}»`;
  if (action.type === "move_deal") return `Переместить в «${displayStage(action.stage)}»`;
  if (action.type === "assign_user") return "Назначить оператора";
  if (action.type === "create_task") return `Создать задачу «${action.title}»`;
  if (action.type === "set_control") return `Режим диалога: ${action.mode}`;
  if (action.type === "send_message") return `Отправить: ${action.text}`;
  if (action.type === "webhook") return `Вызвать webhook ${action.url}`;
  return "Добавить в suppression list";
}
function AutomationsView({ canManage, attributeDefinitions, automations, runs, contacts, refresh, notify }: { canManage: boolean; attributeDefinitions: ApiAttributeDefinition[]; automations: ApiAutomationRule[]; runs: ApiAutomationRun[]; contacts: Conversation[]; refresh: () => Promise<void>; notify: (text: string) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const totalRuns = runs.length;
  const successRate = totalRuns ? runs.filter((item) => item.status === "SUCCESS").length / totalRuns * 100 : 100;
  async function toggle(item: ApiAutomationRule) { try { setBusy(item.id); await botcrmApi.updateAutomation(item.id, { enabled: !item.enabled }); await refresh(); } catch (error) { notify(error instanceof Error ? error.message : "Не удалось изменить правило"); } finally { setBusy(null); } }
  async function remove(item: ApiAutomationRule) { try { setBusy(item.id); await botcrmApi.deleteAutomation(item.id); await refresh(); notify("Правило удалено"); } catch (error) { notify(error instanceof Error ? error.message : "Не удалось удалить правило"); } finally { setBusy(null); } }
  async function testRule(item: ApiAutomationRule) { const contactId = contacts.find((contact) => contact.contactId)?.contactId; try { setBusy(item.id); const result = await botcrmApi.testAutomation(item.id, { contactId, context: { message: { text: "Тестовое сообщение" } } }); notify(result.matched ? `Условия совпали · действий: ${result.actions.length}` : "Условия не совпали на выбранном контакте"); } catch (error) { notify(error instanceof Error ? error.message : "Не удалось проверить правило"); } finally { setBusy(null); } }
  return <div className="page-scroll"><div className="automation-hero"><div><div className="automation-orb"><Zap size={25} /></div><span><h2>Автоматизируйте работу CRM</h2><p>Правила реагируют на реальные события ботов и выполняются транзакционно.</p></span></div><div><label>Запусков в журнале<b>{totalRuns}</b></label><label>Успешно<b>{successRate.toFixed(1)}%</b></label></div></div>
    <div className="automation-list"><div className="list-header"><span>Правило</span><span>Условие и действие</span><span>Запуски</span><span>Статус</span><span /></div>{automations.length ? automations.map((item, index) => { const condition = item.conditionTree.conditions[0]; return <article key={item.id}><div className={`automation-symbol ${["green","orange","purple","blue"][index % 4]}`}><Workflow size={18} /></div><div className="automation-name"><b>{item.name}</b><small>{automationTriggerLabel(item.triggerType)}{item.lastRunAt ? ` · ${relativeAge(item.lastRunAt)} назад` : " · ещё не запускалось"}</small></div><div className="automation-flow"><code>{condition ? automationConditionSummary(condition, attributeDefinitions) : "Без условий"}</code><span>→</span><p>{item.actions.map(automationActionLabel).join("; ")}</p></div><strong>{item.runCount}</strong><button disabled={!canManage || busy === item.id} className={`toggle ${item.enabled ? "on" : ""}`} onClick={() => void toggle(item)} aria-label={item.enabled ? "Выключить правило" : "Включить правило"}><i /></button>{canManage && <div className="automation-actions"><button onClick={() => void testRule(item)} title="Тестировать"><Check size={15} /></button><button onClick={() => void remove(item)} title="Удалить"><X size={15} /></button></div>}</article>; }) : <div className="automation-empty"><Workflow size={28} /><b>Правил пока нет</b><span>Нажмите «Новое правило», чтобы автоматизировать работу CRM.</span></div>}</div>
    <div className="run-log"><header><div><h3>Последние выполнения</h3><p>Идемпотентный журнал автоматизаций</p></div><button onClick={() => void refresh()}><RefreshCw size={15} />Обновить</button></header>{runs.length ? runs.slice(0, 12).map((run) => <div className={`run-row ${run.status.toLowerCase()}`} key={run.id}>{run.status === "SUCCESS" ? <Check size={15} /> : run.status === "FAILED" ? <AlertTriangle size={15} /> : <RefreshCw className="spin" size={15} />}<span><b>{run.ruleName}</b><small>{run.status === "FAILED" ? run.error : `Событие ${run.sourceEventId}`}</small></span><time>{new Date(run.startedAt).toLocaleTimeString("ru-RU")}</time><em>{run.durationMs} мс</em></div>) : <div className="automation-empty small"><Check size={22} /><span>Запуски появятся после первого подходящего события</span></div>}</div>
  </div>;
}

type AutomationConditionOperator = "equals" | "not_equals" | "contains" | "not_contains" | "gt" | "gte" | "lt" | "lte" | "exists" | "not_exists" | "in";
type AutomationConditionKind = "text" | "number" | "boolean" | "channel" | "actor" | "control" | "stage" | "status";
type AutomationConditionField = AppSelectOption & { kind: AutomationConditionKind; triggers?: ApiAutomationTrigger[] };

const automationTriggerOptions: AppSelectOption[] = [
  { value: "message.received", label: "Получено сообщение", detail: "Пользователь написал боту", icon: <MessageCircle size={16} /> },
  { value: "message.sent", label: "Отправлено сообщение", detail: "Бот или оператор отправил ответ", icon: <Send size={16} /> },
  { value: "contact.updated", label: "Контакт обновлён", detail: "Изменился профиль или переменная", icon: <User size={16} /> },
  { value: "conversation.created", label: "Диалог создан", detail: "Появилось новое обращение", icon: <Inbox size={16} /> },
  { value: "deal.created", label: "Сделка создана", detail: "Контакт добавлен в воронку", icon: <Columns3 size={16} /> },
  { value: "deal.stage_changed", label: "Стадия изменена", detail: "Сделку переместили по воронке", icon: <Columns3 size={16} /> },
  { value: "button.clicked", label: "Нажата кнопка", detail: "Пользователь нажал кнопку сообщения", icon: <Circle size={16} /> },
  { value: "conversation.inactive", label: "Нет активности", detail: "В диалоге долго нет сообщений", icon: <Pause size={16} /> },
  { value: "campaign.delivered", label: "Рассылка доставлена", detail: "Сообщение кампании дошло", icon: <CheckCheck size={16} /> },
  { value: "campaign.failed", label: "Ошибка рассылки", detail: "Сообщение кампании не доставлено", icon: <AlertTriangle size={16} /> },
];

const automationBaseConditionFields: AutomationConditionField[] = [
  { value: "__always__", label: "Без дополнительного условия", detail: "Выполнять при каждом таком событии", kind: "text", icon: <Zap size={16} /> },
  { value: "message.text", label: "Текст сообщения", detail: "Что написал пользователь, бот или оператор", kind: "text", triggers: ["message.received", "message.sent", "button.clicked"], icon: <MessageCircle size={16} /> },
  { value: "message.actor", label: "Автор сообщения", detail: "Кто отправил: бот или оператор", kind: "actor", triggers: ["message.sent"], icon: <User size={16} /> },
  { value: "value", label: "Значение нажатой кнопки", detail: "Служебное значение callback-кнопки", kind: "text", triggers: ["button.clicked"], icon: <Circle size={16} /> },
  { value: "channel", label: "Канал обращения", detail: "Telegram, VK, WhatsApp, Avito или API", kind: "channel", icon: <Inbox size={16} /> },
  { value: "contact.name", label: "Имя контакта", detail: "Имя в карточке клиента", kind: "text", icon: <User size={16} /> },
  { value: "contact.phone", label: "Телефон контакта", detail: "Подтверждённый номер телефона", kind: "text", icon: <Phone size={16} /> },
  { value: "contact.email", label: "Email контакта", detail: "Адрес электронной почты", kind: "text", icon: <Mail size={16} /> },
  { value: "contact.city", label: "Город контакта", detail: "Город из профиля клиента", kind: "text", icon: <Database size={16} /> },
  { value: "deal.stage", label: "Этап сделки", detail: "Текущая стадия сделки в воронке", kind: "stage", icon: <Columns3 size={16} /> },
  { value: "deal.amount", label: "Сумма сделки", detail: "Текущая сумма сделки", kind: "number", icon: <BarChart3 size={16} /> },
  { value: "conversation.controlMode", label: "Кто отвечает в диалоге", detail: "Бот, оператор или пауза", kind: "control", icon: <Bot size={16} /> },
  { value: "inactiveMinutes", label: "Минут без активности", detail: "Сколько минут прошло с последнего сообщения", kind: "number", triggers: ["conversation.inactive"], icon: <Pause size={16} /> },
  { value: "status", label: "Статус доставки", detail: "Доставлено или завершилось ошибкой", kind: "status", triggers: ["campaign.delivered", "campaign.failed"], icon: <CheckCheck size={16} /> },
];

function automationConditionFieldsFor(definitions: ApiAttributeDefinition[]): AutomationConditionField[] {
  return [...automationBaseConditionFields, ...definitions.filter((item) => item.objectScope === "CONTACT" && item.filterable).map((item) => ({ value: `attributes.${item.key}`, label: item.label, detail: `${item.key} · ${item.valueType}`, kind: item.valueType === "NUMBER" ? "number" as const : item.valueType === "BOOLEAN" ? "boolean" as const : "text" as const, icon: <Database size={16} /> }))];
}

const automationOperatorOptions: Record<AutomationConditionKind, AppSelectOption[]> = {
  text: [
    { value: "contains", label: "Содержит", detail: "В тексте встречается указанная часть" },
    { value: "equals", label: "Равно", detail: "Полное совпадение значения" },
    { value: "not_equals", label: "Не равно", detail: "Значения отличаются" },
    { value: "not_contains", label: "Не содержит", detail: "Указанной части нет в тексте" },
    { value: "exists", label: "Заполнено", detail: "Поле существует и не пустое" },
    { value: "not_exists", label: "Не заполнено", detail: "Поля нет или оно пустое" },
  ],
  number: [
    { value: "gte", label: "Больше или равно", detail: "Значение не меньше указанного" },
    { value: "gt", label: "Больше", detail: "Значение строго больше указанного" },
    { value: "lte", label: "Меньше или равно", detail: "Значение не больше указанного" },
    { value: "lt", label: "Меньше", detail: "Значение строго меньше указанного" },
    { value: "equals", label: "Равно", detail: "Числа совпадают" },
    { value: "not_equals", label: "Не равно", detail: "Числа отличаются" },
    { value: "exists", label: "Заполнено", detail: "Число указано" },
    { value: "not_exists", label: "Не заполнено", detail: "Значение отсутствует" },
  ],
  boolean: [
    { value: "equals", label: "Равно", detail: "Флаг включён или выключен" },
    { value: "not_equals", label: "Не равно", detail: "Флаг отличается от указанного" },
    { value: "exists", label: "Задан", detail: "Флаг присутствует" },
    { value: "not_exists", label: "Не задан", detail: "Флаг отсутствует" },
  ],
  channel: [
    { value: "equals", label: "Равно", detail: "Событие пришло из выбранного канала" },
    { value: "not_equals", label: "Не равно", detail: "Исключить выбранный канал" },
  ],
  actor: [
    { value: "equals", label: "Равно", detail: "Сообщение отправил выбранный участник" },
    { value: "not_equals", label: "Не равно", detail: "Сообщение отправил не он" },
  ],
  control: [
    { value: "equals", label: "Равно", detail: "Диалог находится в выбранном режиме" },
    { value: "not_equals", label: "Не равно", detail: "Диалог находится в другом режиме" },
  ],
  stage: [
    { value: "equals", label: "Равно", detail: "Сделка на выбранном этапе" },
    { value: "not_equals", label: "Не равно", detail: "Сделка не на этом этапе" },
  ],
  status: [
    { value: "equals", label: "Равно", detail: "Статус совпадает с выбранным" },
    { value: "not_equals", label: "Не равно", detail: "Статус отличается" },
  ],
};

const automationActionOptions: AppSelectOption[] = [
  { value: "add_tag", label: "Добавить тег", detail: "Пометить контакт для поиска и фильтров", icon: <Tag size={16} /> },
  { value: "set_attribute", label: "Изменить переменную", detail: "Записать значение в карточку контакта", icon: <Database size={16} /> },
  { value: "move_deal", label: "Переместить сделку", detail: "Изменить этап воронки", icon: <Columns3 size={16} /> },
  { value: "create_task", label: "Создать задачу", detail: "Поставить оператору задачу на сутки", icon: <Calendar size={16} /> },
  { value: "set_control", label: "Изменить управление", detail: "Передать диалог оператору, боту или поставить на паузу", icon: <Bot size={16} /> },
  { value: "send_message", label: "Отправить сообщение", detail: "Автоматически ответить в диалоге", icon: <Send size={16} /> },
  { value: "suppress_contact", label: "Запретить рассылки", detail: "Исключить контакт из будущих кампаний", icon: <ShieldCheck size={16} /> },
  { value: "webhook", label: "Вызвать webhook", detail: "Передать событие во внешнюю систему", icon: <ExternalLink size={16} /> },
];

function automationConditionFieldLabel(field: string, definitions: ApiAttributeDefinition[]) {
  const automationConditionFields = automationConditionFieldsFor(definitions);
  if (field.startsWith("attributes.")) {
    const known = automationConditionFields.find((item) => item.value === field);
    return known?.label ?? "Переменная бота «" + field.slice("attributes.".length) + "»";
  }
  return automationConditionFields.find((item) => item.value === field)?.label ?? field;
}

function automationConditionSummary(condition: ApiAutomationRule["conditionTree"]["conditions"][number], definitions: ApiAttributeDefinition[]) {
  const operator = Object.values(automationOperatorOptions).flat().find((item) => item.value === condition.operator)?.label ?? condition.operator;
  const value = condition.value === undefined ? "" : " · " + String(condition.value);
  return automationConditionFieldLabel(condition.field, definitions) + " · " + operator + value;
}

function AutomationModal({ pipelines, attributeDefinitions, close, created }: { pipelines: ApiPipeline[]; attributeDefinitions: ApiAttributeDefinition[]; close: () => void; created: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [triggerType, setTriggerType] = useState<ApiAutomationTrigger>("message.received");
  const [conditionField, setConditionField] = useState("message.text");
  const [conditionOperator, setConditionOperator] = useState<AutomationConditionOperator>("contains");
  const [conditionValue, setConditionValue] = useState("");
  const [actionType, setActionType] = useState<"add_tag" | "set_attribute" | "move_deal" | "create_task" | "set_control" | "send_message" | "suppress_contact" | "webhook">("add_tag");
  const [actionKey, setActionKey] = useState(() => attributeDefinitions.find((item) => item.objectScope === "CONTACT")?.key ?? "");
  const [actionValue, setActionValue] = useState("горячий");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const automationConditionFields = automationConditionFieldsFor(attributeDefinitions);
  const contactAttributeDefinitions = attributeDefinitions.filter((item) => item.objectScope === "CONTACT");
  const availableFields = automationConditionFields.filter((field) => !field.triggers || field.triggers.includes(triggerType));
  const selectedField = automationConditionFields.find((field) => field.value === conditionField) ?? automationConditionFields[1];
  const operatorOptions = automationOperatorOptions[selectedField.kind];
  const conditionNeedsValue = conditionField !== "__always__" && !["exists", "not_exists"].includes(conditionOperator);
  const conditionPath = conditionField === "__always__" ? "" : conditionField;

  const stageOptions: AppSelectOption[] = pipelines.flatMap((pipeline) => pipeline.stages.map((stage) => ({ value: stage.slug, label: stage.name, detail: pipeline.name, color: stage.color })));
  const presetValueOptions: AppSelectOption[] | null =
    selectedField.kind === "channel" ? [
      { value: "telegram", label: "Telegram", detail: "Сообщения Telegram-бота" },
      { value: "vk", label: "ВКонтакте", detail: "Сообщения сообщества VK" },
      { value: "whatsapp", label: "WhatsApp", detail: "WhatsApp Cloud API" },
      { value: "avito", label: "Avito", detail: "Avito Messenger API" },
      { value: "api", label: "Custom API", detail: "Собственный канал или сайт" },
    ] : selectedField.kind === "actor" ? [
      { value: "bot", label: "Бот", detail: "Автоматический ответ бота" },
      { value: "operator", label: "Оператор", detail: "Ручной ответ сотрудника" },
    ] : selectedField.kind === "boolean" ? [
      { value: "true", label: "Да, включён", detail: "Логическое значение true" },
      { value: "false", label: "Нет, выключен", detail: "Логическое значение false" },
    ] : selectedField.kind === "control" ? [
      { value: "BOT", label: "Отвечает бот", detail: "События передаются самописному боту" },
      { value: "HUMAN", label: "Отвечает оператор", detail: "Диалог перехвачен сотрудником" },
      { value: "PAUSED", label: "Диалог на паузе", detail: "Ответы временно остановлены" },
    ] : selectedField.kind === "stage" ? stageOptions : selectedField.kind === "status" ? [
      { value: "DELIVERED", label: "Доставлено", detail: "Канал подтвердил доставку" },
      { value: "FAILED", label: "Ошибка", detail: "Канал не смог доставить сообщение" },
    ] : null;

  function parsedValue(value: string) {
    if (value === "true") return true;
    if (value === "false") return false;
    const number = Number(value);
    return value.trim() !== "" && Number.isFinite(number) ? number : value;
  }

  function chooseConditionField(value: string) {
    setConditionField(value);
    setConditionValue("");
    const field = automationConditionFields.find((item) => item.value === value);
    const nextOperator = field?.kind === "number" ? "gte" : ["channel", "actor", "boolean", "control", "stage", "status"].includes(field?.kind ?? "") ? "equals" : "contains";
    setConditionOperator(nextOperator);
  }

  function chooseActionType(value: string) {
    const type = value as typeof actionType;
    setActionType(type);
    const defaults: Record<typeof actionType, string> = {
      add_tag: "горячий",
      set_attribute: "горячий",
      move_deal: stageOptions[0]?.value ?? "",
      create_task: "Связаться с клиентом",
      set_control: "HUMAN",
      send_message: "Спасибо! Передаю ваш запрос менеджеру.",
      suppress_contact: "Автоматическая отписка",
      webhook: "https://example.com/hook",
    };
    setActionValue(defaults[type]);
  }

  function buildAction(): ApiAutomationInput["actions"][number] {
    if (actionType === "add_tag") return { type: "add_tag", tag: actionValue };
    if (actionType === "set_attribute") return { type: "set_attribute", key: actionKey, value: parsedValue(actionValue) };
    if (actionType === "move_deal") return { type: "move_deal", stage: actionValue };
    if (actionType === "create_task") return { type: "create_task", title: actionValue, dueMinutes: 1440 };
    if (actionType === "set_control") return { type: "set_control", mode: actionValue as ControlMode };
    if (actionType === "send_message") return { type: "send_message", text: actionValue, actor: "bot" };
    if (actionType === "webhook") return { type: "webhook", url: actionValue };
    return { type: "suppress_contact", reason: actionValue || "Автоматическая отписка" };
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (conditionNeedsValue && !conditionValue.trim()) return setError("Укажите значение, с которым нужно сравнить поле");
    if (actionType === "set_attribute" && !actionKey.trim()) return setError("Укажите имя переменной, которую нужно изменить");
    if (!actionValue.trim()) return setError("Укажите значение действия");
    setSubmitting(true);
    try {
      await botcrmApi.createAutomation({
        name,
        enabled: true,
        triggerType,
        conditionTree: {
          match: "all",
          conditions: conditionPath ? [{
            field: conditionPath,
            operator: conditionOperator,
            ...(conditionNeedsValue ? { value: parsedValue(conditionValue) } : {}),
          }] : [],
        },
        actions: [buildAction()],
        maxDepth: 5,
      });
      await created();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось создать правило");
    } finally {
      setSubmitting(false);
    }
  }

  return <div className="modal-backdrop" role="dialog" aria-modal="true" onMouseDown={(event) => event.target === event.currentTarget && close()}>
    <form className="modal automation-modal" onSubmit={submit}>
      <header>
        <div><span className="eyebrow">CRM-автоматизация</span><h2>Новое правило</h2></div>
        <button type="button" className="icon-button" onClick={close} aria-label="Закрыть"><X size={17} /></button>
      </header>
      <div className="modal-body">
        <label className="form-field"><span>Название правила</span><input required minLength={2} maxLength={120} value={name} onChange={(event) => setName(event.target.value)} placeholder="Например: Горячий лид → оператор" /></label>
        <div className="automation-builder">
          <div className="builder-step"><b>1</b><span><strong>Событие</strong><small>Когда запускать правило</small></span></div>
          <label className="automation-control">
            <span>Событие запуска</span>
            <AppSelect value={triggerType} options={automationTriggerOptions} onValueChange={(value) => {
              const nextTrigger = value as ApiAutomationTrigger;
              setTriggerType(nextTrigger);
              const stillAvailable = automationConditionFields.some((field) => field.value === conditionField && (!field.triggers || field.triggers.includes(nextTrigger)));
              if (!stillAvailable) chooseConditionField("__always__");
            }} ariaLabel="Событие запуска автоматизации" matchTriggerWidth />
          </label>

          <div className="builder-step"><b>2</b><span><strong>Условие</strong><small>Что именно проверить перед выполнением</small></span></div>
          <div className={"automation-condition-grid " + (conditionField === "__always__" ? "without-condition" : "")}>
            <label className="automation-control">
              <span>Что сравниваем</span>
              <AppSelect value={conditionField} options={availableFields} onValueChange={chooseConditionField} ariaLabel="Поле условия" matchTriggerWidth />
            </label>
            {conditionField !== "__always__" && <label className="automation-control">
              <span>Как сравниваем</span>
              <AppSelect value={conditionOperator} options={operatorOptions} onValueChange={(value) => setConditionOperator(value as AutomationConditionOperator)} ariaLabel="Оператор сравнения" matchTriggerWidth />
            </label>}
            {conditionField !== "__always__" && conditionNeedsValue && <label className="automation-control">
              <span>С чем сравниваем</span>
              {presetValueOptions
                ? <AppSelect value={conditionValue} options={presetValueOptions} onValueChange={setConditionValue} ariaLabel="Значение условия" placeholder="Выберите значение" matchTriggerWidth />
                : <input type={selectedField.kind === "number" ? "number" : "text"} value={conditionValue} onChange={(event) => setConditionValue(event.target.value)} placeholder={selectedField.kind === "number" ? "Например, 70" : "Введите значение"} />}
            </label>}
            {conditionField === "__always__" && <div className="automation-condition-empty"><Zap size={17} /><span><b>Условие не требуется</b><small>Действие выполнится при каждом выбранном событии.</small></span></div>}
          </div>

          <div className="builder-step"><b>3</b><span><strong>Действие</strong><small>Что платформа должна сделать</small></span></div>
          <div className={"automation-action-grid " + (actionType === "set_attribute" ? "three" : "")}>
            <label className="automation-control">
              <span>Действие</span>
              <AppSelect value={actionType} options={automationActionOptions} onValueChange={chooseActionType} ariaLabel="Действие автоматизации" matchTriggerWidth />
            </label>
            {actionType === "set_attribute" && <label className="automation-control">
              <span>Имя переменной</span>
              <AppSelect value={actionKey} onValueChange={setActionKey} options={contactAttributeDefinitions.map((item) => ({ value: item.key, label: item.label, detail: `${item.key} · ${item.valueType}` }))} ariaLabel="Переменная для изменения" placeholder="Сначала зарегистрируйте переменную" matchTriggerWidth />
            </label>}
            <label className="automation-control">
              <span>{actionType === "move_deal" ? "Новый этап" : actionType === "set_control" ? "Новый режим" : actionType === "set_attribute" ? "Новое значение" : "Параметр действия"}</span>
              {actionType === "set_control"
                ? <AppSelect value={actionValue} options={[
                    { value: "HUMAN", label: "Передать оператору", detail: "Бот перестанет получать новые сообщения" },
                    { value: "BOT", label: "Вернуть боту", detail: "Бот снова продолжит диалог" },
                    { value: "PAUSED", label: "Поставить на паузу", detail: "Не отвечает ни бот, ни оператор" },
                  ]} onValueChange={setActionValue} ariaLabel="Режим управления диалогом" matchTriggerWidth />
                : actionType === "move_deal"
                  ? <AppSelect value={actionValue} options={stageOptions} onValueChange={setActionValue} ariaLabel="Этап воронки" placeholder="Выберите этап" matchTriggerWidth />
                  : <input required value={actionValue} onChange={(event) => setActionValue(event.target.value)} placeholder={actionType === "webhook" ? "https://example.com/hook" : actionType === "send_message" ? "Текст сообщения" : "Введите значение"} />}
            </label>
          </div>
        </div>
        {error && <div className="form-error"><AlertTriangle size={15} />{error}</div>}
      </div>
      <footer><button type="button" className="button secondary" onClick={close}>Отмена</button><button className="button primary" disabled={submitting}>{submitting && <RefreshCw className="spin" size={15} />}Создать правило</button></footer>
    </form>
  </div>;
}
function SettingsView({ currentUser, notify, revision }: { currentUser: ApiUser; notify: (text: string) => void; revision: number }) {
  const [tab, setTab] = useState<"users" | "teams" | "tokens">("users");
  const [users, setUsers] = useState<ApiAdminUser[]>([]);
  const [tokens, setTokens] = useState<ApiServiceToken[]>([]);
  const [teams, setTeams] = useState<ApiTeam[]>([]);
  const [teamName, setTeamName] = useState("");
  const [loading, setLoading] = useState(true);
  const initializedRef = useRef(false);
  const [userForm, setUserForm] = useState({ displayName: "", email: "", password: "", role: "OPERATOR" as ApiAdminUser["role"] });
  const [tokenName, setTokenName] = useState("");
  const [newToken, setNewToken] = useState<ApiServiceToken | null>(null);
  const allowed = currentUser.role === "OWNER" || currentUser.role === "ADMIN";
  async function load() {
    if (!allowed) return setLoading(false);
    if (!initializedRef.current) setLoading(true);
    try { const [nextUsers, nextTeams, nextTokens] = await Promise.all([botcrmApi.adminUsers(), botcrmApi.teams(), botcrmApi.serviceTokens()]); setUsers(nextUsers); setTeams(nextTeams); setTokens(nextTokens); }
    catch (error) { notify(error instanceof ApiError ? error.message : "Не удалось загрузить настройки"); }
    finally { initializedRef.current = true; setLoading(false); }
  }
  useEffect(() => { void load(); }, [revision]);
  async function createUser(event: FormEvent) {
    event.preventDefault();
    try { const created = await botcrmApi.createUser(userForm); setUsers((items) => [...items, created]); setUserForm({ displayName: "", email: "", password: "", role: "OPERATOR" }); notify("Участник команды создан"); }
    catch (error) { notify(error instanceof ApiError ? error.message : "Не удалось создать пользователя"); }
  }
  async function updateUser(userId: string, input: { role?: ApiAdminUser["role"]; disabled?: boolean }) {
    try { const updated = await botcrmApi.updateUser(userId, input); setUsers((items) => items.map((item) => item.userId === userId ? updated : item)); notify("Права пользователя обновлены"); }
    catch (error) { notify(error instanceof ApiError ? error.message : "Не удалось изменить пользователя"); }
  }
  async function createTeam(event: FormEvent) {
    event.preventDefault(); if (!teamName.trim()) return;
    try { const created = await botcrmApi.createTeam(teamName.trim()); setTeams((items) => [...items, created]); setTeamName(""); notify("Команда создана"); }
    catch (error) { notify(error instanceof ApiError ? error.message : "Не удалось создать команду"); }
  }
  async function toggleTeamMember(team: ApiTeam, userId: string) {
    const userIds = team.members.some((member) => member.userId === userId) ? team.members.filter((member) => member.userId !== userId).map((member) => member.userId) : [...team.members.map((member) => member.userId), userId];
    try { const updated = await botcrmApi.setTeamMembers(team.id, userIds); setTeams((items) => items.map((item) => item.id === team.id ? updated : item)); notify("Состав команды обновлён"); }
    catch (error) { notify(error instanceof ApiError ? error.message : "Не удалось изменить команду"); }
  }
  async function deleteTeam(teamId: string) {
    try { await botcrmApi.deleteTeam(teamId); setTeams((items) => items.filter((item) => item.id !== teamId)); notify("Команда удалена"); }
    catch (error) { notify(error instanceof ApiError ? error.message : "Не удалось удалить команду"); }
  }  async function createToken(event: FormEvent) {
    event.preventDefault(); if (!tokenName.trim()) return;
    try { const created = await botcrmApi.createServiceToken({ name: tokenName.trim() }); setTokens((items) => [created, ...items]); setNewToken(created); setTokenName(""); notify("Сервисный токен создан — сохраните его сейчас"); }
    catch (error) { notify(error instanceof ApiError ? error.message : "Не удалось создать токен"); }
  }
  async function revokeToken(id: string) {
    try { await botcrmApi.revokeServiceToken(id); setTokens((items) => items.map((item) => item.id === id ? { ...item, revokedAt: new Date().toISOString() } : item)); notify("Сервисный токен отозван"); }
    catch (error) { notify(error instanceof ApiError ? error.message : "Не удалось отозвать токен"); }
  }
  if (!allowed) return <div className="page-scroll"><div className="permission-card"><ShieldCheck size={30} /><h2>Требуются права администратора</h2><p>Управление участниками и токенами доступно владельцу и администраторам workspace.</p></div></div>;
  return <div className="page-scroll settings-page"><div className="settings-tabs"><button className={tab === "users" ? "active" : ""} onClick={() => setTab("users")}><Users size={17} />Участники <span>{users.filter((user) => !user.disabledAt).length}</span></button><button className={tab === "teams" ? "active" : ""} onClick={() => setTab("teams")}><Columns3 size={17} />Команды <span>{teams.length}</span></button><button className={tab === "tokens" ? "active" : ""} onClick={() => setTab("tokens")}><ShieldCheck size={17} />Сервисные токены <span>{tokens.filter((token) => !token.revokedAt).length}</span></button></div>{loading ? <div className="settings-loading"><RefreshCw className="spin" size={20} />Загрузка настроек…</div> : tab === "users" ? <div className="settings-layout"><section className="settings-panel"><header><div><h2>Участники команды</h2><p>Роли определяют доступ к диалогам, рассылкам и системным настройкам.</p></div></header><div className="users-admin-list">{users.map((item) => <article key={item.userId} className={item.disabledAt ? "disabled" : ""}><div className="admin-avatar">{initials(item.displayName)}</div><span><b>{item.displayName}{item.userId === currentUser.userId && <em>Вы</em>}{item.role === "OWNER" && currentUser.role !== "OWNER" && <em>Защищён</em>}</b><small>{item.email} · {item.mfaEnabled ? "2FA включена" : "без 2FA"}</small></span><AppSelect compact ariaLabel={`Роль пользователя ${item.displayName}`} disabled={item.userId === currentUser.userId || (item.role === "OWNER" && currentUser.role !== "OWNER")} value={item.role} onValueChange={(value)=>void updateUser(item.userId,{role:value as ApiAdminUser["role"]})} options={[...(currentUser.role === "OWNER" || item.role === "OWNER" ? [{value:"OWNER",label:"Владелец",detail:"Полный доступ"}] : []),{value:"ADMIN",label:"Администратор",detail:"Настройки и команда"},{value:"SUPERVISOR",label:"Руководитель",detail:"Контроль операторов"},{value:"OPERATOR",label:"Оператор",detail:"Диалоги и сделки"}]}/><button className={`toggle ${!item.disabledAt ? "on" : ""}`} aria-label={`${item.disabledAt ? "Включить" : "Отключить"} пользователя ${item.displayName}`} title={item.userId === currentUser.userId ? "Нельзя отключить собственную учётную запись" : item.role === "OWNER" && currentUser.role !== "OWNER" ? "Только владелец может управлять другим владельцем" : undefined} disabled={item.userId === currentUser.userId || (item.role === "OWNER" && currentUser.role !== "OWNER")} onClick={() => void updateUser(item.userId, { disabled: !item.disabledAt })}><i /></button></article>)}</div></section><form className="settings-panel create-user-card" onSubmit={createUser}><header><div><h2>Добавить участника</h2><p>Создайте учётную запись и передайте пароль безопасным способом.</p></div></header><label className="form-field"><span>Имя</span><input value={userForm.displayName} onChange={(event) => setUserForm({ ...userForm, displayName: event.target.value })} required /></label><label className="form-field"><span>Email</span><input type="email" value={userForm.email} onChange={(event) => setUserForm({ ...userForm, email: event.target.value })} required /></label><label className="form-field"><span>Временный пароль · минимум 12 символов</span><input type="password" minLength={12} value={userForm.password} onChange={(event) => setUserForm({ ...userForm, password: event.target.value })} required /></label><label className="form-field"><span>Роль</span><AppSelect ariaLabel="Роль нового участника" value={userForm.role} onValueChange={(value)=>setUserForm({...userForm,role:value as ApiAdminUser["role"]})} options={[{value:"OPERATOR",label:"Оператор",detail:"Диалоги и сделки"},{value:"SUPERVISOR",label:"Руководитель",detail:"Контроль команды"},{value:"ADMIN",label:"Администратор",detail:"Настройки workspace"},...(currentUser.role==="OWNER"?[{value:"OWNER",label:"Владелец",detail:"Полный доступ"}]:[])]}/></label><button className="button primary"><Plus size={16} />Создать пользователя</button></form></div> : tab === "teams" ? <div className="settings-layout teams-layout"><section className="settings-panel"><header><div><h2>Рабочие команды</h2><p>Группируйте операторов для назначения диалогов, сделок и задач.</p></div></header><div className="teams-list">{teams.map((team) => <article key={team.id}><header><div><div className="team-symbol"><Users size={18} /></div><span><b>{team.name}</b><small>{team.members.length} участников</small></span></div><button aria-label={`Удалить команду ${team.name}`} onClick={() => void deleteTeam(team.id)}><X size={16} /></button></header><div className="team-members">{users.filter((user) => !user.disabledAt).map((user) => <label key={user.userId}><input type="checkbox" checked={team.members.some((member) => member.userId === user.userId)} onChange={() => void toggleTeamMember(team, user.userId)} /><span><b>{user.displayName}</b><small>{roleLabel(user.role)}</small></span></label>)}</div></article>)}{teams.length === 0 && <div className="empty-inline">Команд пока нет. Создайте первую группу операторов.</div>}</div></section><form className="settings-panel create-user-card" onSubmit={createTeam}><header><div><h2>Новая команда</h2><p>Например, «Продажи», «Поддержка» или «Курс: поток 12».</p></div></header><label className="form-field"><span>Название команды</span><input value={teamName} onChange={(event) => setTeamName(event.target.value)} required /></label><button className="button primary"><Plus size={16} />Создать команду</button></form></div> : <div className="settings-layout tokens-layout"><section className="settings-panel"><header><div><h2>Токены самописных ботов</h2><p>Каждой интеграции выдаётся отдельный секрет. Полное значение показывается только один раз.</p></div></header>{newToken?.token && <div className="new-token-banner"><AlertTriangle size={18} /><span><b>Скопируйте токен сейчас</b><code>{newToken.token}</code></span><button onClick={() => { void navigator.clipboard.writeText(newToken.token!); notify("Токен скопирован"); }}><Copy size={16} />Копировать</button></div>}<div className="token-list">{tokens.map((token) => <article key={token.id} className={token.revokedAt ? "disabled" : ""}><div className="token-symbol"><ShieldCheck size={18} /></div><span><b>{token.name}</b><code>{token.tokenPrefix}••••••••</code></span><small>{token.lastUsedAt ? `Использован ${new Date(token.lastUsedAt).toLocaleString("ru-RU")}` : "Ещё не использовался"}</small>{token.revokedAt ? <em>Отозван</em> : <button onClick={() => void revokeToken(token.id)}>Отозвать</button>}</article>)}</div></section><form className="settings-panel create-user-card" onSubmit={createToken}><header><div><h2>Новый токен</h2><p>Используйте его в заголовке <code>x-service-token</code> SDK или REST API.</p></div></header><label className="form-field"><span>Название интеграции</span><input value={tokenName} onChange={(event) => setTokenName(event.target.value)} placeholder="Например: Sales Bot production" required /></label><div className="token-permissions"><b>Права сервисного аккаунта</b><span><Check size={14} />Приём событий</span><span><Check size={14} />Upsert контактов и переменных</span><span><Check size={14} />Отправка сообщений через gateway</span><span className="denied"><X size={14} />Нет доступа к контактам и рассылкам</span></div><button className="button primary"><Plus size={16} />Создать токен</button></form></div>}</div>;
}
function IntegrationsView({ canCheck, canManage, connectors, refresh, notify, onCreate }: { canCheck: boolean; canManage: boolean; connectors: ApiConnector[]; refresh: () => Promise<void>; notify: (text: string) => void; onCreate: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  async function check(item: ApiConnector) { try { setBusy(item.id); const result = await botcrmApi.checkConnector(item.id); await refresh(); notify(result.status === "connected" ? `${item.botName}: соединение работает` : `${item.botName}: ${result.lastError || "требуется настройка"}`); } catch (error) { notify(error instanceof Error ? error.message : "Проверка не выполнена"); } finally { setBusy(null); } }
  async function remove(item: ApiConnector) { try { setBusy(item.id); await botcrmApi.deleteConnector(item.id); await refresh(); notify("Подключение удалено"); } catch (error) { notify(error instanceof Error ? error.message : "Не удалось удалить подключение"); } finally { setBusy(null); } }
  async function copy(value: string, message: string) { await navigator.clipboard.writeText(value); notify(message); }
  return <div className="page-scroll"><div className="integration-banner"><div><ShieldCheck size={24} /><span><h2>Каналы под контролем</h2><p>Credentials зашифрованы AES‑256‑GCM, webhook изолированы по connector ID, проверки используют официальные API.</p></span></div><button className="button secondary" onClick={() => window.open("/api-docs", "_blank")}><ExternalLink size={16} />OpenAPI</button></div><div className="integration-grid">{connectors.map((item) => { const healthy = item.status === "connected"; return <article className="integration-card" key={item.id}><div className="integration-card-head"><div className={`integration-logo ${channelMeta[item.channel].className}`}>{channelMeta[item.channel].short}</div><span className={`connection-state ${healthy ? "healthy" : "warning"}`}><i />{healthy ? "Подключён" : item.status === "pending" ? "Ожидает проверки" : "Требует внимания"}</span></div><h3>{item.botName}</h3><p>{channelMeta[item.channel].label} · {item.integrationMode === "GATEWAY" ? "Gateway" : "Mirror / SDK"}</p><div className="integration-detail"><span>{item.lastError || (item.lastHealthAt ? `Проверено ${relativeAge(item.lastHealthAt)} назад` : "Проверка ещё не выполнялась")}</span><label>Настроено секретных полей<b>{item.configuredFields.length}</b></label><label>Возможностей канала<b>{Object.keys(item.capabilities).length}</b></label></div><div className="connector-webhook"><code>{item.webhookUrl}</code><button onClick={() => void copy(item.webhookUrl, "Webhook URL скопирован")} title="Копировать webhook"><Copy size={14} /></button></div><footer>{canCheck && <button disabled={busy === item.id} onClick={() => void check(item)}><RefreshCw className={busy === item.id ? "spin" : ""} size={15} />Проверить</button>}{canManage && <button onClick={() => void remove(item)}><X size={15} />Удалить</button>}</footer></article>; })}{canManage && <button className="add-integration" onClick={onCreate}><div><Plus size={23} /></div><b>Подключить бота</b><span>Telegram, VK, WhatsApp, Avito или REST API</span></button>}</div><div className="api-kit"><div className="api-kit-icon"><Database size={23} /></div><div><span className="eyebrow">Для разработчиков</span><h3>Подключите любого самописного бота</h3><p>Mirror SDK для TypeScript и Python уже включены в репозиторий. Gateway принимает webhook канала напрямую.</p></div><div className="api-actions"><button className="button secondary" onClick={() => void copy(window.location.origin + "/api/v1/events", "Endpoint событий скопирован")}><Copy size={15} />Endpoint</button><button className="button primary" onClick={() => window.open("/docs#developer", "_blank")}>Документация <ExternalLink size={15} /></button></div></div></div>;
}

function ConnectorModal({ close, created }: { close: () => void; created: () => Promise<void> }) {
  const [channel, setChannel] = useState<Channel>("telegram");
  const [botName, setBotName] = useState("");
  const [botSlug, setBotSlug] = useState("");
  const [mode, setMode] = useState<"GATEWAY" | "MIRROR">("GATEWAY");
  const [externalAccountId, setExternalAccountId] = useState("");
  const [eventEndpoint, setEventEndpoint] = useState("");
  const [primarySecret, setPrimarySecret] = useState("");
  const [secondarySecret, setSecondarySecret] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [verificationValue, setVerificationValue] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  function credentials(): Record<string, unknown> {
    if (channel === "telegram") return { botToken: primarySecret, webhookSecret };
    if (channel === "vk") return mode === "GATEWAY"
      ? { accessToken: primarySecret, apiVersion: "5.199", confirmationSecret: webhookSecret, confirmationCode: verificationValue }
      : { accessToken: primarySecret, apiVersion: "5.199", ...(webhookSecret ? { signingSecret: webhookSecret } : {}) };
    if (channel === "whatsapp") return { accessToken: primarySecret, phoneNumberId: secondarySecret, apiVersion: "v23.0", appSecret: webhookSecret, verifyToken: verificationValue };
    if (channel === "avito") return { accessToken: primarySecret, accountId: externalAccountId, outboundUrl: endpoint, signingSecret: webhookSecret };
    return { outboundUrl: endpoint, healthUrl: endpoint, signingSecret: primarySecret };
  }
  async function submit(event: FormEvent) { event.preventDefault(); setSubmitting(true); setError(""); try { const input: ApiConnectorInput = { botName, botSlug: botSlug || undefined, channel, integrationMode: mode, externalAccountId: externalAccountId || undefined, eventEndpoint: eventEndpoint || undefined, credentials: credentials() }; await botcrmApi.createConnector(input); await created(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Не удалось создать подключение"); } finally { setSubmitting(false); } }
  const secretLabel = channel === "telegram" ? "Bot token" : channel === "api" ? "HMAC secret" : "Access token";
  return <div className="modal-backdrop" role="dialog" aria-modal="true" onMouseDown={(event) => event.target === event.currentTarget && close()}><form className="modal connector-modal" onSubmit={submit}><header><div><span className="eyebrow">Официальный API / Mirror SDK</span><h2>Подключение бота</h2></div><button type="button" className="icon-button" onClick={close}><X size={17} /></button></header><div className="modal-body"><div className="form-split"><label className="form-field"><span>Канал</span><AppSelect ariaLabel="Канал подключаемого бота" value={channel} onValueChange={(value) => { setChannel(value as Channel); setPrimarySecret(""); setSecondarySecret(""); setEndpoint(""); setWebhookSecret(""); setVerificationValue(""); }} options={[{value:"telegram",label:"Telegram Bot API",detail:"Webhook и Bot API",color:"#2aabee"},{value:"vk",label:"VK Community Messages",detail:"Bots Long Poll или Callback API",color:"#2787f5"},{value:"whatsapp",label:"WhatsApp Cloud API",detail:"Официальный Meta API",color:"#25b967"},{value:"avito",label:"Avito Messenger API",detail:"Требуется официальный доступ",color:"#00aaff"},{value:"api",label:"Универсальный REST",detail:"Любой самописный транспорт",color:"#6d5ce7"}]}/></label><label className="form-field"><span>Режим</span><AppSelect ariaLabel="Режим подключения бота" value={mode} onValueChange={(value)=>setMode(value as typeof mode)} options={[{value:"GATEWAY",label:"Gateway",detail:"Webhook канала принимает BotCRM",icon:<ShieldCheck size={16}/>},{value:"MIRROR",label:"Mirror / SDK",detail:"Webhook остаётся у вашего бота",icon:<Copy size={16}/>} ]}/></label></div><div className="form-split"><label className="form-field"><span>Название бота</span><input required minLength={2} value={botName} onChange={(event) => { setBotName(event.target.value); if (!botSlug) setBotSlug(event.target.value.toLowerCase().replace(/[^a-z0-9]+/g, "_")); }} placeholder="Sales Assistant" /></label><label className="form-field"><span>Slug</span><input required value={botSlug} onChange={(event) => setBotSlug(event.target.value)} placeholder="sales_assistant" /></label></div><label className="form-field"><span>Внешний account / community ID</span><input value={externalAccountId} onChange={(event) => setExternalAccountId(event.target.value)} placeholder="Необязательно" /></label><label className="form-field"><span>{mode === "GATEWAY" ? "Endpoint самописного бота для входящих событий" : "Endpoint самописного бота для событий оператора · необязательно"}</span><input required={mode === "GATEWAY"} type="url" value={eventEndpoint} onChange={(event) => setEventEndpoint(event.target.value)} placeholder={mode === "GATEWAY" ? "https://bot.example.com/botcrm-events" : "Можно оставить пустым"} />{mode === "MIRROR" && <small>Заполните, только если BotCRM должен моментально уведомлять ваш бот о захвате и возврате диалога.</small>}</label><label className="form-field"><span>{secretLabel}</span><input required type="password" autoComplete="new-password" value={primarySecret} onChange={(event) => setPrimarySecret(event.target.value)} placeholder="Сохраняется только в зашифрованном виде" /></label>{channel === "whatsapp" && <label className="form-field"><span>Phone number ID</span><input required value={secondarySecret} onChange={(event) => setSecondarySecret(event.target.value)} /></label>}{(channel === "api" || channel === "avito") && <label className="form-field"><span>Outbound / health endpoint</span><input required type="url" value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder="https://api.example.com/messages" /></label>}{channel !== "api" && !(channel === "vk" && mode === "MIRROR" && !eventEndpoint) && <label className="form-field"><span>{channel === "whatsapp" ? "Meta App secret для подписи webhook" : channel === "vk" && mode === "MIRROR" ? "Секрет подписи событий BotCRM" : channel === "vk" ? "Секрет Callback API" : channel === "telegram" ? "Webhook secret token" : "Секрет подписи webhook"}</span><input required type="password" autoComplete="new-password" value={webhookSecret} onChange={(event) => setWebhookSecret(event.target.value)} placeholder="Отдельный секрет для проверки входящих событий" /></label>}{(channel === "whatsapp" || (channel === "vk" && mode === "GATEWAY")) && <label className="form-field"><span>{channel === "whatsapp" ? "Verify token для Meta" : "Код подтверждения VK"}</span><input required value={verificationValue} onChange={(event) => setVerificationValue(event.target.value)} /></label>}<div className="security-note"><ShieldCheck size={17} /><span><b>Секрет нельзя будет посмотреть после сохранения.</b> Его можно только заменить новым.</span></div>{error && <div className="form-error"><AlertTriangle size={15} />{error}</div>}</div><footer><button type="button" className="button secondary" onClick={close}>Отмена</button><button className="button primary" disabled={submitting}>{submitting && <RefreshCw className="spin" size={15} />}Сохранить подключение</button></footer></form></div>;
}
function AnalyticsView({ revision }: { revision: number }) {
  const [data, setData] = useState<ApiAnalytics | null>(null);
  const [days, setDays] = useState(30);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    setLoading(true);
    botcrmApi.analytics(days).then((value) => { if (active) { setData(value); setError(""); } }).catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "Не удалось загрузить аналитику"); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [days, revision]);
  if (loading && !data) return <div className="page-scroll analytics-loading"><RefreshCw className="spin" size={24} /><span>Считаем показатели…</span></div>;
  if (error && !data) return <div className="page-scroll analytics-loading error"><AlertTriangle size={24} /><span>{error}</span><button className="button secondary" onClick={() => setDays((value) => value === 30 ? 31 : 30)}>Повторить</button></div>;
  if (!data) return null;
  const maxDaily = Math.max(1, ...data.daily.map((item) => item.conversations));
  const funnelTotal = data.funnel.reduce((sum, item) => sum + item.count, 0);
  const totalChannels = data.channels.reduce((sum, item) => sum + item.count, 0);
  const analyticsChannelColors: Record<Channel, string> = { telegram: "#6b59dc", vk: "#4f8bda", whatsapp: "#42b783", avito: "#00aaff", api: "#8a93a5" };
  const activeChannels = data.channels.filter((item) => item.count > 0);
  const donutSlices = activeChannels.map((item, index) => {
    const start = activeChannels.slice(0, index).reduce((sum, current) => sum + (totalChannels ? current.count / totalChannels * 100 : 0), 0);
    const end = start + (totalChannels ? item.count / totalChannels * 100 : 0);
    return `${analyticsChannelColors[item.channel]} ${start}% ${end}%`;
  });
  const donutBackground = donutSlices.length ? `conic-gradient(${donutSlices.join(",")})` : "var(--surface-3)";
  const formatDelta = (value: number) => `${value >= 0 ? "↑" : "↓"} ${Math.abs(value).toFixed(1)}%`;
  const formatResponse = (seconds: number) => seconds < 60 ? `${seconds}с` : `${Math.floor(seconds / 60)}м ${seconds % 60}с`;
  return <div className="page-scroll">
    <div className="analytics-toolbar"><span>Данные обновлены {new Date(data.generatedAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}</span><div className="analytics-period-control"><Calendar size={16} /><AppSelect compact menuWidth={116} menuAlign="end" ariaLabel="Период аналитики" value={String(days)} onValueChange={(value) => setDays(Number(value))} options={[{ value: "7", label: "7 дней" }, { value: "30", label: "30 дней" }, { value: "90", label: "90 дней" }]} /></div></div>
    <div className="analytics-grid">
      <article className="metric-card"><span>Новых диалогов</span><b>{data.summary.conversations.toLocaleString("ru-RU")}</b><em className={data.summary.conversationDelta < 0 ? "negative" : ""}>{formatDelta(data.summary.conversationDelta)}</em><small>к прошлому периоду</small></article>
      <article className="metric-card"><span>Конверсия в оплату</span><b>{data.summary.conversion.toFixed(1)}%</b><em className={data.summary.conversionDelta < 0 ? "negative" : ""}>{formatDelta(data.summary.conversionDelta)}</em><small>{data.summary.wonDeals.toLocaleString("ru-RU")} успешных сделок</small></article>
      <article className="metric-card"><span>Первый ответ</span><b>{formatResponse(data.summary.firstResponseSeconds)}</b><em>p95 контролируется</em><small>боты + операторы</small></article>
      <article className="metric-card"><span>Выручка</span><b>{formatMoney(data.summary.revenue)}</b><em className={data.summary.revenueDelta < 0 ? "negative" : ""}>{formatDelta(data.summary.revenueDelta)}</em><small>по выигранным сделкам</small></article>
    </div>
    <div className="analytics-row"><article className="chart-card main-chart"><header><div><h3>Диалоги и продажи</h3><p>Наведите на день, чтобы увидеть точные значения</p></div><div className="legend"><span><i className="purple" />Диалоги</span><span><i className="green" />Оплаты</span></div></header><div className="bar-chart" role="list" aria-label="Диалоги и продажи по дням">{data.daily.map((item, index) => { const date = new Date(`${item.date}T00:00:00`); const shortDate = date.toLocaleDateString("ru-RU", { day: "numeric", month: "short" }); const fullDate = date.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" }); const tooltipDate = date.toLocaleDateString("ru-RU", { day: "numeric", month: "long" }); const conversationHeight = item.conversations ? Math.max(4, item.conversations / maxDaily * 100) : 0; const wonHeight = item.won ? Math.max(6, item.won / maxDaily * 100) : 0; return <button type="button" className="bar-chart-item" key={item.date} role="listitem" aria-label={`${fullDate}: диалогов ${item.conversations}, оплат ${item.won}`}><span className="bar-tooltip"><b>{tooltipDate}</b><span><i className="purple" />Диалоги <strong>{item.conversations}</strong></span><span><i className="green" />Оплаты <strong>{item.won}</strong></span></span>{item.conversations > 0 && <span className="bar-value" style={{ bottom: `calc(${conversationHeight}% + 5px)` }}>{item.conversations}</span>}<i style={{ height: `${conversationHeight}%` }} /><em style={{ height: `${wonHeight}%` }} /><span className="bar-date">{index % 2 === 0 ? shortDate : ""}</span></button>; })}</div></article>
      <article className="chart-card"><header><div><h3>Каналы</h3><p>Доля обращений</p></div></header><div className="donut-wrap"><div className="donut" style={{ background: donutBackground }}><span><b>{totalChannels.toLocaleString("ru-RU")}</b><small>диалогов</small></span></div><div className="donut-legend">{data.channels.filter((item) => item.count > 0).map((item) => <label key={item.channel}><i style={{ background: analyticsChannelColors[item.channel] }} />{channelMeta[item.channel]?.label || item.channel}<b>{item.share.toFixed(1)}%</b></label>)}{!totalChannels && <div className="analytics-empty compact">Обращений за период нет</div>}</div></div></article></div>
    <div className="analytics-row bottom"><article className="chart-card funnel-card"><header><div><h3>Состояние воронки</h3><p>Распределение текущих сделок по этапам</p></div><strong className="funnel-total">{funnelTotal} сделок</strong></header>{data.funnel.length ? <div className="funnel-list">{data.funnel.map((item) => { const share = funnelTotal ? item.count / funnelTotal * 100 : 0; return <button type="button" className="funnel-row" key={item.slug} aria-label={`${item.name}: ${item.count} сделок, ${share.toFixed(0)} процентов`}><span className="funnel-stage"><i style={{ background: item.color }} /><b>{item.name}</b></span><span className="funnel-track"><i style={{ width: `${share}%`, background: item.color }} /></span><span className="funnel-value"><b>{item.count.toLocaleString("ru-RU")}</b><small>{share.toFixed(0)}%</small></span><span className="funnel-tooltip"><b>{item.name}</b><span>{item.count.toLocaleString("ru-RU")} сделок · {share.toFixed(1)}%</span><span>Сумма: {formatMoney(item.amount)}</span></span></button>; })}</div> : <div className="analytics-empty"><Columns3 size={23} /><b>Воронка пока не настроена</b><span>Создайте этапы в разделе «Воронки»</span></div>}</article>
      <article className="chart-card bot-rating"><header><div><h3>Эффективность ботов</h3><p>Выигранные сделки от обращений</p></div></header>{data.bots.length ? data.bots.map((item) => <div className="rating-row" key={item.slug}><span><Bot size={15} />{item.name}</span><div><i style={{ width: `${Math.min(100, item.score)}%` }} /></div><b>{item.score}%</b></div>) : <div className="empty-inline">Нет подключённых ботов</div>}</article></div>
  </div>;
}
