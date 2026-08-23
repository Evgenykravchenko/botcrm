"use client";

import { ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle, Bot, Check, CheckCheck, ChevronDown, Circle, Mail, MessageCircle,
  Mic, MoreHorizontal, Paperclip, Pause, Phone, Plus, RefreshCw,
  Search, Send, SlidersHorizontal, Smile, User, X,
} from "lucide-react";
import { ApiAttachment, ApiPipeline, botcrmApi } from "./api-client";

type Channel = "telegram" | "vk" | "whatsapp" | "avito" | "api";
type ControlMode = "BOT" | "HUMAN" | "PAUSED";

export type InboxConversation = {
  id: string;
  contactId?: string;
  dealId?: string;
  dealVersion?: number;
  dealPipelineId?: string;
  stageId?: string;
  assignedUserId?: string;
  amount?: number;
  controlVersion: number;
  attributes: Record<string, unknown>;
  name: string;
  initials: string;
  channel: Channel;
  bot: string;
  preview: string;
  time: string;
  unread: number;
  online?: boolean;
  avatarAvailable?: boolean;
  avatarVersion?: string;
  tags: string[];
  stage: string;
  mode: ControlMode;
  phone: string;
  email: string;
  city: string;
};

export type InboxMessage = {
  id: string;
  side: "in" | "out" | "system";
  text: string;
  time: string;
  author?: string;
  status?: "queued" | "sent" | "delivered" | "read" | "failed";
  attachments?: Array<ApiAttachment & { previewUrl?: string }>;
};

function MessageReceipt({ status, channel, direction }: { status: NonNullable<InboxMessage["status"]>; channel: Channel; direction: "in" | "out" }) {
  if (direction === "in") {
    if (status === "read") return <span className="message-receipt inbound-read" title="Прочитано оператором в BotCRM" aria-label="Прочитано оператором"><CheckCheck size={14} /></span>;
    return <span className="message-receipt inbound-received" title="Получено BotCRM, но ещё не прочитано оператором" aria-label="Получено, не прочитано оператором"><Check size={14} /></span>;
  }
  if (status === "queued") return <span className="message-receipt queued" title="Сообщение ожидает отправки" aria-label="Ожидает отправки"><Circle className="queued-dot" size={9} /></span>;
  if (status === "failed") return <span className="message-receipt failed" title="Не удалось отправить сообщение" aria-label="Ошибка отправки"><AlertTriangle className="failed-icon" size={13} /></span>;
  if (status === "read") return <span className="message-receipt read" title="Прочитано получателем" aria-label="Прочитано получателем"><CheckCheck size={14} /></span>;
  if (status === "delivered") return <span className="message-receipt delivered" title="Доставлено получателю" aria-label="Доставлено получателю"><CheckCheck size={14} /></span>;
  const title = {
    telegram: "Отправлено в Telegram. Telegram Bot API не передаёт ботам статус прочтения",
    vk: "Отправлено во ВКонтакте. Текущий community-коннектор не получает подтверждение прочтения",
    whatsapp: "Отправлено в WhatsApp; ожидается webhook о доставке или прочтении",
    avito: "Отправлено в Avito. Текущий официальный коннектор не получает подтверждение прочтения",
    api: "Отправлено через Custom API; ожидается событие message.status от подключённого бота",
  }[channel];
  return <span className="message-receipt sent" title={title} aria-label={title}><Check size={14} /></span>;
}

type Props = {
  conversations: InboxConversation[];
  selected?: InboxConversation;
  selectedId: string;
  openConversation: (id: string) => void;
  closeConversation: () => void;
  search: string;
  setSearch: (value: string) => void;
  messages: InboxMessage[];
  draft: string;
  setDraft: (value: string) => void;
  sendMessage: (event: FormEvent) => void;
  setMode: (mode: ControlMode) => void;
  pendingAttachments: Array<ApiAttachment & { previewUrl?: string }>;
  uploadingAttachments: number;
  fileInputRef: { current: HTMLInputElement | null };
  attachFiles: (event: ChangeEvent<HTMLInputElement>) => void;
  removePendingAttachment: (id: string) => void;
  pipelines: ApiPipeline[];
  moveDeal: (stageSlug: string) => Promise<void>;
  editContact: () => void;
  refresh: () => Promise<void>;
  notify: (text: string) => void;
  currentUserName: string;
  liveRevision: number;
};

const channelMeta: Record<Channel, { label: string; short: string; className: string }> = {
  telegram: { label: "Telegram", short: "TG", className: "channel-tg" },
  vk: { label: "ВКонтакте", short: "VK", className: "channel-vk" },
  whatsapp: { label: "WhatsApp", short: "WA", className: "channel-wa" },
  avito: { label: "Avito", short: "AV", className: "channel-av" },
  api: { label: "Custom API", short: "API", className: "channel-api" },
};

const quickReplies = [
  "Здравствуйте! Чем могу помочь?",
  "Спасибо, уточню информацию и вернусь с ответом.",
  "Подскажите, пожалуйста, удобное время для звонка.",
  "Отправляю информацию. Если появятся вопросы — напишите.",
];

const emoji = ["👍", "🙂", "✅", "🙏", "🔥", "🎉", "❤️", "👋"];

function ChannelBadge({ channel, compact = false }: { channel: Channel; compact?: boolean }) {
  const meta = channelMeta[channel];
  return <span className={`channel-badge ${meta.className}`} title={meta.label}>{compact ? meta.short : meta.label}</span>;
}

const avatarObjectUrlCache = new Map<string, Promise<string | undefined>>();

function avatarObjectUrl(contactId: string, channel: Channel, version: string) {
  const key = `${contactId}:${channel}:${version}`;
  let pending = avatarObjectUrlCache.get(key);
  if (!pending) {
    pending = botcrmApi.contactAvatar(contactId, channel)
      .then((blob) => {
        if (!blob.type.startsWith("image/")) throw new Error(`Unexpected avatar content type: ${blob.type || "unknown"}`);
        return URL.createObjectURL(blob);
      })
      .catch(() => {
        avatarObjectUrlCache.delete(key);
        return undefined;
      });
    avatarObjectUrlCache.set(key, pending);
  }
  return pending;
}

export function ContactAvatar({ contactId, channel, avatarAvailable, avatarVersion = "", initials, online = false, seed, size = "md" }: { contactId?: string; channel: Channel; avatarAvailable?: boolean; avatarVersion?: string; initials: string; online?: boolean; seed: string; size?: "sm" | "md" | "lg" }) {
  const [src, setSrc] = useState<string>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    setSrc(undefined);
    setFailed(false);
    if (!avatarAvailable || !contactId) return () => { active = false; };
    void avatarObjectUrl(contactId, channel, avatarVersion).then((url) => { if (active) setSrc(url); });
    return () => { active = false; };
  }, [avatarAvailable, avatarVersion, channel, contactId]);
  const tone = Math.abs(seed.charCodeAt(1) || seed.charCodeAt(0) || 0) % 5;
  return <div className={`avatar avatar-${size} avatar-${tone} ${src && !failed ? "avatar-with-image" : ""}`} aria-label={`Аватар ${initials}`}>
    {src && !failed ? <img src={src} alt="" draggable={false} onError={() => setFailed(true)} /> : initials}
    {online && <i />}
  </div>;
}

function Avatar({ item, size = "md" }: { item: InboxConversation; size?: "sm" | "md" | "lg" }) {
  return <ContactAvatar contactId={item.contactId} channel={item.channel} avatarAvailable={item.avatarAvailable} avatarVersion={item.avatarVersion} initials={item.initials} online={item.online} seed={item.id} size={size} />;
}

function formatMoney(value: number) { return new Intl.NumberFormat("ru-RU").format(value) + " ₽"; }
function formatBytes(value: number) { if (value < 1024) return `${value} Б`; if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} КБ`; return `${(value / 1024 / 1024).toFixed(1)} МБ`; }
function displayAttribute(value: unknown) { if (value == null) return "—"; if (Array.isArray(value)) return value.join(", "); if (typeof value === "object") return JSON.stringify(value); if (typeof value === "boolean") return value ? "Да" : "Нет"; return String(value); }

function MessageAttachment({ attachment }: { attachment: ApiAttachment & { previewUrl?: string } }) {
  const [url, setUrl] = useState(attachment.previewUrl || "");
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (attachment.previewUrl) return;
    let active = true;
    void botcrmApi.attachmentUrl(attachment.id).then((result) => { if (active) setUrl(result.url); }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [attachment.id, attachment.previewUrl]);
  if (attachment.mimeType.startsWith("image/")) return <a className="attachment-card image" href={url || undefined} target="_blank" rel="noreferrer">{url ? <img src={url} alt={attachment.filename} /> : <span className="attachment-loading"><RefreshCw className="spin" size={18} />Загрузка…</span>}<small>{attachment.filename} · {formatBytes(attachment.byteSize)}</small></a>;
  if (attachment.mimeType.startsWith("video/") && url) return <div className="attachment-card media"><video controls preload="metadata" src={url} /><small>{attachment.filename}</small></div>;
  if (attachment.mimeType.startsWith("audio/") && url) return <div className="attachment-card audio"><audio controls preload="metadata" src={url} /><small>{attachment.filename}</small></div>;
  return <a className={`attachment-card file ${failed ? "failed" : ""}`} href={url || undefined} target="_blank" rel="noreferrer"><span><Paperclip size={18} /></span><div><b>{attachment.filename}</b><small>{failed ? "Ссылка недоступна" : `${formatBytes(attachment.byteSize)} · ${attachment.mimeType}`}</small></div></a>;
}

function ControlButton({ mode, setMode }: { mode: ControlMode; setMode: (mode: ControlMode) => void }) {
  if (mode === "BOT") return <button className="control-button bot" onClick={() => setMode("HUMAN")}><Bot size={16} />Отвечает бот<span>Перехватить</span></button>;
  if (mode === "PAUSED") return <button className="control-button paused" onClick={() => setMode("HUMAN")}><Pause size={15} />На паузе<span>Забрать</span></button>;
  return <button className="control-button human" onClick={() => setMode("BOT")}><User size={15} />У оператора<span>Вернуть боту</span></button>;
}


type DropdownOption = { value: string; label: string; detail?: string; color?: string };
function CustomDropdown({ value, options, onChange, ariaLabel, compact=false }: { value: string; options: DropdownOption[]; onChange: (value: string) => void | Promise<void>; ariaLabel: string; compact?: boolean }) {
  const [open,setOpen]=useState(false); const [busy,setBusy]=useState(false); const root=useRef<HTMLDivElement>(null);
  const selectedOption=options.find((option)=>option.value===value)??options[0];
  useEffect(()=>{if(!open)return;const close=(event:MouseEvent)=>{if(root.current&&!root.current.contains(event.target as Node))setOpen(false);};document.addEventListener("mousedown",close);return()=>document.removeEventListener("mousedown",close);},[open]);
  async function choose(next:string){if(next===value){setOpen(false);return;}setBusy(true);try{await onChange(next);setOpen(false);}finally{setBusy(false);}}
  return <div className={`custom-dropdown ${compact?"compact":""}`} ref={root}><button type="button" className="custom-dropdown-trigger" aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={open} onClick={()=>setOpen(!open)} disabled={busy}>{selectedOption?.color&&<i style={{background:selectedOption.color}}/>}<span><b>{selectedOption?.label??"Выберите"}</b>{selectedOption?.detail&&<small>{selectedOption.detail}</small>}</span>{busy?<RefreshCw className="spin" size={14}/>:<ChevronDown className={open?"rotated":""} size={15}/>}</button>{open&&<div className="custom-dropdown-menu" role="listbox" aria-label={ariaLabel}>{options.map((option)=><button type="button" role="option" aria-selected={option.value===value} key={option.value} onClick={()=>void choose(option.value)}>{option.color&&<i style={{background:option.color}}/>}<span><b>{option.label}</b>{option.detail&&<small>{option.detail}</small>}</span>{option.value===value&&<Check size={15}/>}</button>)}</div>}</div>;
}function ProfileSection({ title, badge, children, defaultOpen = true }: { title: string; badge?: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return <section className={`profile-section ${open ? "open" : "collapsed"}`}><button className="profile-section-title" onClick={() => setOpen(!open)} aria-expanded={open}><span>{title}{badge && <em>{badge}</em>}</span><ChevronDown size={15} /></button>{open && children}</section>;
}

function ProfileLine({ icon: Icon, label, value }: { icon: typeof Phone; label: string; value: string }) {
  return <div className="profile-line"><Icon size={15} /><span>{label}</span><b>{value}</b></div>;
}

export function InboxView(props: Props) {
  const {
    conversations, selected, selectedId, openConversation, closeConversation, search, setSearch, messages,
    draft, setDraft, sendMessage, setMode, pendingAttachments, uploadingAttachments,
    fileInputRef, attachFiles, removePendingAttachment, pipelines, moveDeal,
    editContact, refresh, notify, currentUserName, liveRevision,
  } = props;
  const [tab, setTab] = useState<"all" | "human" | "unread">("all");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [channel, setChannel] = useState<"" | Channel>("");
  const [botFilter, setBotFilter] = useState("");
  const [controlFilter, setControlFilter] = useState<"" | ControlMode>("");
  const [sort, setSort] = useState<"new" | "unread" | "name">("new");
  const [chatMenu, setChatMenu] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [tagDraft, setTagDraft] = useState("");
  const [tagEditor, setTagEditor] = useState(false);
  const [contactActivity, setContactActivity] = useState<{ notes: Array<{ id: string; body: string; createdAt: string }>; tasks: Array<{ id: string; title: string; completedAt?: string; createdAt: string }> }>({ notes: [], tasks: [] });
  const [activityDraft, setActivityDraft] = useState("");
  const [taskDraft, setTaskDraft] = useState("");
  const audioInputRef = useRef<HTMLInputElement>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const keepChatAtBottomRef = useRef(true);
  const previousConversationRef = useRef("");
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);

  const bots = useMemo(() => [...new Set(conversations.map((item) => item.bot))].sort(), [conversations]);
  const visibleConversations = useMemo(() => {
    const normalized = search.trim().toLowerCase();
    const items = conversations.filter((item) => {
      if (tab === "human" && item.mode !== "HUMAN") return false;
      if (tab === "unread" && item.unread === 0) return false;
      if (channel && item.channel !== channel) return false;
      if (botFilter && item.bot !== botFilter) return false;
      if (controlFilter && item.mode !== controlFilter) return false;
      return !normalized || `${item.name} ${item.preview} ${item.bot}`.toLowerCase().includes(normalized);
    });
    return [...items].sort((a, b) => sort === "name" ? a.name.localeCompare(b.name, "ru") : sort === "unread" ? b.unread - a.unread : 0);
  }, [botFilter, channel, controlFilter, conversations, search, sort, tab]);

  async function loadContactActivity() {
    if (!selected?.contactId) return setContactActivity({ notes: [], tasks: [] });
    try { setContactActivity(await botcrmApi.contactActivity(selected.contactId)); }
    catch { setContactActivity({ notes: [], tasks: [] }); }
  }
  useEffect(() => { void loadContactActivity(); }, [selected?.contactId, liveRevision]);
  useEffect(() => {
    if (!selected) return;
    const node = chatScrollRef.current;
    if (!node) return;
    const conversationChanged = previousConversationRef.current !== selected.id;
    if (conversationChanged) {
      previousConversationRef.current = selected.id;
      keepChatAtBottomRef.current = true;
    }
    if (!conversationChanged && !keepChatAtBottomRef.current) {
      setShowJumpToLatest(true);
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      node.scrollTop = node.scrollHeight;
      keepChatAtBottomRef.current = true;
      setShowJumpToLatest(false);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [messages.length, selected?.id]);

  function handleChatScroll() {
    if (!selected) return;
    const node = chatScrollRef.current;
    if (!node) return;
    const closeToBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 96;
    keepChatAtBottomRef.current = closeToBottom;
    setShowJumpToLatest(!closeToBottom);
  }

  function jumpToLatest() {
    if (!selected) return;
    const node = chatScrollRef.current;
    if (!node) return;
    node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
    keepChatAtBottomRef.current = true;
    setShowJumpToLatest(false);
  }

  async function addNote() { if (!selected?.contactId || !activityDraft.trim()) return; await botcrmApi.addContactNote(selected.contactId, activityDraft.trim()); setActivityDraft(""); await loadContactActivity(); }
  async function addTask() { if (!selected?.contactId || !taskDraft.trim()) return; await botcrmApi.addContactTask(selected.contactId, { title: taskDraft.trim() }); setTaskDraft(""); await loadContactActivity(); }
  async function addTag() {
    const tag = tagDraft.trim();
    if (!selected?.contactId || !tag) return;
    try { await botcrmApi.setContactTags(selected.contactId, [...new Set([...selected.tags, tag])]); setTagDraft(""); setTagEditor(false); await refresh(); notify(`Тег «${tag}» добавлен`); }
    catch (error) { notify(error instanceof Error ? error.message : "Не удалось добавить тег"); }
  }
  function insertText(value: string) { setDraft(draft ? `${draft}${draft.endsWith(" ") ? "" : " "}${value}` : value); setEmojiOpen(false); setTemplatesOpen(false); }

  const dealPipeline = pipelines.find((pipeline) => pipeline.id === selected?.dealPipelineId);
  const pipelineStages = (dealPipeline?.stages ?? []).map((stage) => ({ ...stage, pipelineName: dealPipeline?.name ?? "" }));
  return <div className={`inbox-layout ${selected ? "" : "no-selection"}`.trim()}>
    <section className="conversation-list-panel">
      <div className="inbox-tabs">
        <button className={tab === "all" ? "active" : ""} onClick={() => setTab("all")}>Все <span>{conversations.length}</span></button>
        <button className={tab === "human" ? "active attention" : "attention"} onClick={() => setTab("human")}>Нужен оператор <span>{conversations.filter((item) => item.mode === "HUMAN").length}</span></button>
        <button className={tab === "unread" ? "active" : ""} onClick={() => setTab("unread")}>Непрочитанные <span>{conversations.filter((item) => item.unread > 0).length}</span></button>
      </div>
      <div className={`conversation-controls ${filtersOpen ? "filters-open" : ""}`}>
        <div className="search-row"><label className="search-box"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Поиск по диалогам" /></label><button type="button" className={`icon-button inbox-filter-toggle ${filtersOpen ? "active" : ""}`} onClick={() => setFiltersOpen(!filtersOpen)} aria-label="Фильтры диалогов" aria-expanded={filtersOpen}><SlidersHorizontal size={17} />{(channel || botFilter || controlFilter) && <span>{Number(Boolean(channel)) + Number(Boolean(botFilter)) + Number(Boolean(controlFilter))}</span>}</button></div>
        {filtersOpen && <div className="inbox-filter-panel">
          <div className="inbox-filter-heading"><span>Отбор диалогов</span><small>Сейчас показано: {visibleConversations.length}</small></div>
          <div className="inbox-filter-fields"><label><span>Канал</span><CustomDropdown compact ariaLabel="Фильтр по каналу" value={channel} onChange={(value)=>setChannel(value as ""|Channel)} options={[{value:"",label:"Все каналы"},...Object.entries(channelMeta).map(([value,meta])=>({value,label:meta.label}))]}/></label><label className="align-right"><span>Бот</span><CustomDropdown compact ariaLabel="Фильтр по боту" value={botFilter} onChange={setBotFilter} options={[{value:"",label:"Все боты"},...bots.map((bot)=>({value:bot,label:bot}))]}/></label><label className="inbox-filter-status"><span>Состояние диалога</span><CustomDropdown compact ariaLabel="Фильтр по состоянию диалога" value={controlFilter} onChange={(value)=>setControlFilter(value as ""|ControlMode)} options={[{value:"",label:"Любое состояние"},{value:"HUMAN",label:"Нужен оператор",detail:"Бот остановлен"},{value:"BOT",label:"Отвечает бот"},{value:"PAUSED",label:"На паузе"}]}/></label></div>
          <div className="inbox-filter-actions"><span>{channel || botFilter || controlFilter ? "Фильтры применены" : "Выберите условия отбора"}</span><button type="button" disabled={!channel && !botFilter && !controlFilter} onClick={() => { setChannel(""); setBotFilter(""); setControlFilter(""); }}>Сбросить</button></div>
        </div>}
      </div>
      <div className="list-caption"><span>{visibleConversations.length} диалогов</span><CustomDropdown compact ariaLabel="Сортировка диалогов" value={sort} onChange={(value)=>setSort(value as typeof sort)} options={[{value:"new",label:"Сначала новые"},{value:"unread",label:"Непрочитанные"},{value:"name",label:"По имени"}]}/></div>
      <div className="conversation-scroll">{visibleConversations.map((item) => <button key={item.id} onClick={() => openConversation(item.id)} className={`conversation-row ${selectedId === item.id ? "selected" : ""} ${item.mode === "HUMAN" ? "needs-operator" : ""}`}><Avatar item={item} /><div className="conversation-copy"><div><strong>{item.name}</strong><time>{item.time}</time></div><div className="conversation-source"><ChannelBadge channel={item.channel} compact /><span>{item.bot}</span>{item.mode === "HUMAN" && <em className="operator-needed"><User size={10} />Нужен оператор</em>}</div><p>{item.preview}</p></div>{item.unread > 0 && <span className="unread-badge">{item.unread}</span>}</button>)}{visibleConversations.length === 0 && <div className="empty-state"><Search size={28} /><b>Диалогов нет</b><span>Измените вкладку или фильтры</span></div>}</div>
    </section>
    {selected ? <>
    <section className="chat-panel">
      <div className="chat-header"><div className="chat-person"><Avatar item={selected} size="sm" /><div><div><strong>{selected.name}</strong>{selected.online && <span className="online-label">в сети</span>}</div><p><ChannelBadge channel={selected.channel} compact /> через {selected.bot}</p></div></div><div className="chat-actions"><ControlButton mode={selected.mode} setMode={setMode} /><div className="popover-anchor"><button className="icon-button" onClick={() => setChatMenu(!chatMenu)} aria-label="Действия с диалогом"><MoreHorizontal size={18} /></button>{chatMenu && <div className="action-popover"><button onClick={() => { setChatMenu(false); setMode("HUMAN"); }}><User size={15} />Передать оператору</button><button onClick={() => { setChatMenu(false); setMode("BOT"); }}><Bot size={15} />Вернуть боту</button><button onClick={() => { setChatMenu(false); setMode("PAUSED"); }}><Pause size={15} />Поставить на паузу</button><button onClick={() => { setChatMenu(false); editContact(); }}><MoreHorizontal size={15} />Открыть карточку</button></div>}</div><button className="icon-button close-conversation" onClick={closeConversation} aria-label="Закрыть диалог" title="Закрыть диалог"><X size={18} /></button></div></div>
      <div className="chat-scroll" ref={chatScrollRef} onScroll={handleChatScroll}><div className="date-divider"><span>Сегодня</span></div>{messages.map((message) => message.side === "system" ? <div className="system-message" key={message.id}><span>{message.text}</span><time>{message.time}</time></div> : <div className={`message-wrap ${message.side}`} key={message.id}>{message.side === "in" && <Avatar item={selected} size="sm" />}<div><div className={`message-bubble ${message.attachments?.length ? "with-attachments" : ""}`}>{message.text && <div className="message-text">{message.text}</div>}{message.attachments?.map((attachment) => <MessageAttachment key={attachment.id} attachment={attachment} />)}</div><p>{message.author && <span>{message.author}</span>}<time>{message.time}</time>{message.status && <MessageReceipt status={message.status} channel={selected.channel} direction={message.side} />}</p></div></div>)}</div>
      {showJumpToLatest && <button type="button" className="chat-jump-latest" onClick={jumpToLatest}><ChevronDown size={16} />К новым сообщениям</button>}
      <form className="composer" onSubmit={sendMessage}>
        {selected.mode === "BOT" && <button type="button" className="bot-writing" onClick={() => setMode("HUMAN")}><Bot size={15} />Сейчас отвечает бот · нажмите, чтобы перехватить</button>}
        {selected.mode === "PAUSED" && <button type="button" className="bot-writing paused" onClick={() => setMode("HUMAN")}><Pause size={15} />Диалог на паузе · забрать оператору</button>}
        {(pendingAttachments.length > 0 || uploadingAttachments > 0) && <div className="pending-attachments">{pendingAttachments.map((attachment) => <div className="pending-attachment" key={attachment.id}><span><Paperclip size={17} /></span><div><b>{attachment.filename}</b><small>{formatBytes(attachment.byteSize)}</small></div><button type="button" onClick={() => removePendingAttachment(attachment.id)}><X size={14} /></button></div>)}{uploadingAttachments > 0 && <div className="pending-attachment uploading"><RefreshCw className="spin" size={17} />Загрузка…</div>}</div>}
        <div className="composer-box"><textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} placeholder="Напишите сообщение…" rows={2} /><input ref={fileInputRef} className="file-input" type="file" multiple onChange={attachFiles} /><input ref={audioInputRef} className="file-input" type="file" accept="audio/*" capture="user" onChange={attachFiles} /><div className="composer-tools"><div><button type="button" title="Прикрепить файл" onClick={() => fileInputRef.current?.click()}><Paperclip size={18} /></button><div className="popover-anchor"><button type="button" title="Эмодзи" onClick={() => { setEmojiOpen(!emojiOpen); setTemplatesOpen(false); }}><Smile size={18} /></button>{emojiOpen && <div className="emoji-popover">{emoji.map((item) => <button type="button" key={item} onClick={() => insertText(item)}>{item}</button>)}</div>}</div><button type="button" title="Прикрепить голосовое или аудиофайл" onClick={() => audioInputRef.current?.click()}><Mic size={18} /></button><div className="popover-anchor"><button type="button" className="template-button" onClick={() => { setTemplatesOpen(!templatesOpen); setEmojiOpen(false); }}>/ Шаблон</button>{templatesOpen && <div className="template-popover">{quickReplies.map((reply) => <button type="button" key={reply} onClick={() => insertText(reply)}>{reply}</button>)}</div>}</div></div><button className="send-button" aria-label="Отправить сообщение" disabled={(!draft.trim() && pendingAttachments.length === 0) || uploadingAttachments > 0}><Send size={18} /></button></div></div>
      </form>
    </section>
    <aside className="contact-panel"><div className="contact-head"><button className="icon-button" onClick={editContact} aria-label="Редактировать контакт"><MoreHorizontal size={18} /></button><Avatar item={selected} size="lg" /><h2>{selected.name}</h2><p><ChannelBadge channel={selected.channel} /> <span>#{selected.id.slice(0, 8)}</span></p><div className="contact-tags">{selected.tags.map((tag) => <span key={tag}>{tag}</span>)}<button onClick={() => setTagEditor(!tagEditor)} aria-label="Добавить тег"><Plus size={13} /></button></div>{tagEditor && <div className="tag-editor"><input autoFocus value={tagDraft} onChange={(event) => setTagDraft(event.target.value)} onKeyDown={(event) => event.key === "Enter" && void addTag()} placeholder="Новый тег" /><button onClick={() => void addTag()} disabled={!tagDraft.trim()}><Check size={13} /></button></div>}</div>
      <ProfileSection title="Контакты"><ProfileLine icon={Phone} label="Телефон" value={selected.phone} /><ProfileLine icon={Mail} label="Email" value={selected.email} /><ProfileLine icon={User} label="Город" value={selected.city} /></ProfileSection>
      <ProfileSection title="Сделка"><div className="deal-stage-field"><small>Текущая стадия</small>{selected.dealId && selected.stageId && pipelineStages.length ? <CustomDropdown ariaLabel="Стадия сделки" value={selected.stageId} onChange={moveDeal} options={pipelineStages.map((stage)=>({value:stage.slug,label:stage.name,detail:stage.pipelineName,color:stage.color}))}/> : <div className="deal-state-empty">Без сделки</div>}</div><div className="field-grid"><label><span>Сумма</span><b>{selected.amount ? formatMoney(selected.amount) : "—"}</b></label><label><span>Ответственный</span><b>{selected.mode === "HUMAN" ? currentUserName : "Не назначен"}</b></label></div></ProfileSection>
      <ProfileSection title="Переменные бота" badge={String(Object.keys(selected.attributes).filter((key) => key !== "tags").length)}>{Object.entries(selected.attributes).filter(([key]) => key !== "tags").slice(0, 12).map(([key, value]) => <div className="variable-row" key={key}><code>{key}</code><span>{displayAttribute(value)}</span></div>)}{Object.keys(selected.attributes).filter((key) => key !== "tags").length === 0 && <div className="empty-inline">Переменных пока нет</div>}</ProfileSection>
      <ProfileSection title="Заметки и задачи" badge={String(contactActivity.notes.length + contactActivity.tasks.length)}><div className="inbox-activity-create"><input value={activityDraft} onChange={(event) => setActivityDraft(event.target.value)} placeholder="Добавить заметку" /><button disabled={!activityDraft.trim()} onClick={() => void addNote()}><Plus size={13} /></button></div>{contactActivity.notes.map((item) => <div className="timeline-item" key={item.id}><i className="green" /><span><b>{item.body}</b><small>{new Date(item.createdAt).toLocaleString("ru-RU")}</small></span></div>)}<div className="inbox-activity-create"><input value={taskDraft} onChange={(event) => setTaskDraft(event.target.value)} placeholder="Создать задачу" /><button disabled={!taskDraft.trim()} onClick={() => void addTask()}><Plus size={13} /></button></div>{contactActivity.tasks.map((item) => <div className={`timeline-item ${item.completedAt ? "completed" : ""}`} key={item.id}><i /><span><b>{item.title}</b><small>{item.completedAt ? "Выполнена" : "Ожидает выполнения"}</small></span>{!item.completedAt && <button className="timeline-complete" onClick={async () => { await botcrmApi.completeTask(item.id); await loadContactActivity(); }}><Check size={13} /></button>}</div>)}{!contactActivity.notes.length && !contactActivity.tasks.length && <div className="empty-inline">Активности пока нет</div>}</ProfileSection>
    </aside>
    </> : <section className="inbox-idle-state"><div><MessageCircle size={34} /><h2>{conversations.length ? "Выберите диалог" : "Диалогов пока нет"}</h2><p>{conversations.length ? "Нажмите на обращение слева. Пока диалог не открыт, новые сообщения останутся непрочитанными." : "Подключите бота или передайте первое событие через REST API."}</p></div></section>}
  </div>;
}
