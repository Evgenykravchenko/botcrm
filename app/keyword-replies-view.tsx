"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, ArrowLeft, ArrowRight, Bot, Check, ChevronDown, ChevronRight, CircleOff, Copy, FileText, Folder, Image as ImageIcon, Link2, LoaderCircle, MessageSquareReply, Music2, Pencil, Play, Plus, RefreshCw, Save, Search, Settings2, Trash2, UploadCloud, Video, X } from "lucide-react";
import { ApiContentBot, ApiContentMedia, ApiContentMediaInput, ApiError, ApiKeywordBlockKind, ApiKeywordReply, ApiKeywordReplyButton, ApiKeywordReplyInput, ApiKeywordReplySettings, ApiYandexDiskItem, ApiYandexDiskListing, botcrmApi } from "./api-client";
import { AppSelect, type AppSelectOption } from "./ui/app-select";
import { useDiskPreview, VideoPreviewDialog } from "./media-preview";
import { MediaPreparationStatus } from "./media-preparation-status";

type ViewTab = "rules" | "media" | "fallback";
type Notice = { tone: "success" | "error"; text: string } | null;
type DeleteTarget = { type: "rule"; item: ApiKeywordReply } | { type: "media"; item: ApiContentMedia };
type IssuedToken = { token: string; botName: string };

const matchModeLabels = {
  exact: "Точное совпадение",
  contains: "Содержит фразу",
  any_word: "Любое слово",
  all_words: "Все слова",
} as const;
const kindLabels: Record<ApiKeywordBlockKind, string> = { text: "Текст", photo: "Фото", video: "Видео", audio: "Аудио", document: "Документ" };
function canAttachMedia(item: ApiContentMedia) { return item.status === "ready" && item.canAttach !== false; }
const channelLabels: Record<ApiContentBot["channel"], string> = { telegram: "Telegram", vk: "ВКонтакте", instagram: "Instagram", other: "Другой канал" };
const matchModeOptions: AppSelectOption[] = [
  { value: "exact", label: "Сообщение совпадает целиком", detail: "Только точная фраза" },
  { value: "contains", label: "Сообщение содержит фразу", detail: "Фраза может быть частью сообщения" },
  { value: "any_word", label: "Есть хотя бы одно слово", detail: "Подойдёт любое слово из фразы" },
  { value: "all_words", label: "Есть все слова", detail: "Порядок слов не важен" },
];
const buttonActionOptions: AppSelectOption[] = [
  { value: "open_link", label: "Открыть ссылку", detail: "Перейти на сайт" },
  { value: "text", label: "Запустить другую фразу", detail: "Показать другой автоответ" },
];
const priorityOptions: AppSelectOption[] = [
  { value: "normal", label: "Обычная важность", detail: "Подходит для большинства ответов" },
  { value: "high", label: "Выбирать в первую очередь", detail: "Если совпало несколько правил" },
  { value: "low", label: "Выбирать в последнюю очередь", detail: "Запасное совпадение" },
];

function errorText(error: unknown, fallback: string) {
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError" || /fetch is aborted/i.test(error.message))) return "Сервер не успел ответить. Попробуйте ещё раз.";
  return error instanceof ApiError ? error.message : error instanceof Error ? error.message : fallback;
}

function emptyRule(): ApiKeywordReplyInput {
  return { phrase: "", matchMode: "contains", priority: 100, enabled: true, response: { name: "", status: "draft", fallbackText: "", blocks: [{ kind: "text", body: "", sort: 10, sendSeparately: false, enabled: true }], buttons: [] } };
}

function ruleInput(rule: ApiKeywordReply): ApiKeywordReplyInput {
  return { phrase: rule.phrase, matchMode: rule.matchMode, priority: rule.priority, enabled: rule.enabled, response: { name: rule.response.name, status: rule.response.status, fallbackText: rule.response.fallbackText, blocks: rule.response.blocks.map((block) => ({ ...block })), buttons: rule.response.buttons.map((button) => ({ ...button })) } };
}

function activeText(rule: ApiKeywordReply) {
  return rule.response.blocks.find((block) => block.kind === "text" && block.enabled)?.body || rule.response.fallbackText || "Без текста";
}

function channelClass(channel: ApiContentBot["channel"]) {
  return channel === "telegram" ? "channel-tg" : channel === "vk" ? "channel-vk" : channel === "instagram" ? "channel-instagram" : "channel-api";
}

function DeleteConfirmationDialog({ target, busy, close, confirm }: { target: DeleteTarget; busy: boolean; close: () => void; confirm: () => void }) {
  const isMedia = target.type === "media";
  const title = isMedia ? "Убрать файл из медиатеки?" : "Удалить автоответ?";
  const name = isMedia ? target.item.name : target.item.response.name;
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) { if (event.key === "Escape" && !busy) close(); }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [busy, close]);
  return <div className="modal-backdrop delete-confirm-backdrop" role="dialog" aria-modal="true" aria-labelledby="delete-confirm-title" onMouseDown={(event) => event.target === event.currentTarget && !busy && close()}>
    <section className="modal delete-confirm-modal">
      <header><div className="delete-confirm-heading"><span className="delete-confirm-icon"><Trash2 size={20}/></span><div><span className="eyebrow">Подтверждение</span><h2 id="delete-confirm-title">{title}</h2></div></div><button type="button" className="icon-button" onClick={close} disabled={busy} aria-label="Закрыть"><X size={18}/></button></header>
      <div className="modal-body delete-confirm-body"><p><strong>«{name}»</strong> {isMedia ? "больше не будет доступен для добавления в автоответы." : "исчезнет из списка, и бот перестанет отвечать по связанному правилу."}</p>{isMedia ? <div className="delete-confirm-note"><UploadCloud size={17}/><span><b>Файл на Яндекс Диске останется</b><small>Удалится только запись из медиатеки BotCRM.</small></span></div> : <div className="delete-confirm-warning"><AlertCircle size={17}/><span>Это действие нельзя отменить.</span></div>}</div>
      <footer><button type="button" className="button secondary" onClick={close} disabled={busy} autoFocus>Отмена</button><button type="button" className="button danger-solid" onClick={confirm} disabled={busy}>{busy ? <LoaderCircle className="spin" size={16}/> : <Trash2 size={16}/>} {isMedia ? "Убрать из медиатеки" : "Удалить автоответ"}</button></footer>
    </section>
  </div>;
}

function ContentTokenDialog({ issued, busy, create, close }: { issued: IssuedToken | null; busy: boolean; create: () => void; close: () => void }) {
  const [copied, setCopied] = useState(false);
  async function copyToken() {
    try {
      await navigator.clipboard.writeText(issued.token);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) { if (event.key === "Escape") close(); }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [close]);
  return <div className="modal-backdrop delete-confirm-backdrop" role="dialog" aria-modal="true" aria-labelledby="content-token-title" onMouseDown={(event) => event.target === event.currentTarget && close()}>
    <section className="modal content-token-modal">
      <header><div><span className="eyebrow">Доступ бота к контенту</span><h2 id="content-token-title">{issued ? `Токен создан для «${issued.botName}»` : "Создать новый токен?"}</h2></div><button type="button" className="icon-button" onClick={close} disabled={busy} aria-label="Закрыть"><X size={18}/></button></header>
      <div className="modal-body content-token-body">
        {issued ? <><p>Добавьте этот секрет в <code>BOTCRM_CONTENT_TOKEN</code>. После закрытия окна BotCRM больше не покажет его полностью.</p><div className="content-token-value"><code>{issued.token}</code><button type="button" className="button secondary" onClick={() => void copyToken()}>{copied ? <Check size={16}/> : <Copy size={16}/>} {copied ? "Скопировано" : "Скопировать"}</button></div></> : <p>Будет создан отдельный секрет, с которым выбранный бот сможет читать и обновлять только свой контент. Действующие токены продолжат работать.</p>}
      </div>
      <footer>{issued ? <button type="button" className="button primary" onClick={close}>Готово</button> : <><button type="button" className="button secondary" onClick={close} disabled={busy}>Отмена</button><button type="button" className="button primary" onClick={create} disabled={busy}>{busy ? <LoaderCircle className="spin" size={16}/> : <Copy size={16}/>} Создать токен</button></>}</footer>
    </section>
  </div>;
}

function ContentBotDialog({ busy, close, create }: { busy: boolean; close: () => void; create: (input: { botSlug: string; name: string; channel: ApiContentBot["channel"]; yandexRoot?: string }) => void }) {
  const [name, setName] = useState("");
  const [botSlug, setBotSlug] = useState("");
  const [channel, setChannel] = useState<ApiContentBot["channel"]>("vk");
  const [yandexRoot, setYandexRoot] = useState("");
  function submit(event: FormEvent) {
    event.preventDefault();
    create({ botSlug, name, channel, yandexRoot: yandexRoot.trim() || undefined });
  }
  return <div className="modal-backdrop delete-confirm-backdrop" role="dialog" aria-modal="true" aria-labelledby="content-bot-title" onMouseDown={(event) => event.target === event.currentTarget && !busy && close()}>
    <section className="modal content-token-modal">
      <header><div><span className="eyebrow">Новое пространство контента</span><h2 id="content-bot-title">Добавить бота</h2></div><button type="button" className="icon-button" onClick={close} disabled={busy} aria-label="Закрыть"><X size={18}/></button></header>
      <form onSubmit={submit}>
        <div className="modal-body content-bot-form">
          <label className="form-field"><span>Название</span><input required minLength={2} maxLength={120} value={name} onChange={(event) => setName(event.target.value)} placeholder="Например: Каталог Instagram"/></label>
          <label className="form-field"><span>Техническое имя</span><input required pattern="[a-z0-9_]+" value={botSlug} onChange={(event) => setBotSlug(event.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_"))} placeholder="instagram_catalog"/><small>Латинские буквы, цифры и подчёркивание. После подключения не меняется.</small></label>
          <label className="form-field"><span>Канал</span><AppSelect ariaLabel="Канал контентного бота" value={channel} onValueChange={(value) => setChannel(value as ApiContentBot["channel"])} options={[{ value: "vk", label: "ВКонтакте" }, { value: "instagram", label: "Instagram" }, { value: "telegram", label: "Telegram" }, { value: "other", label: "Другой канал" }]} matchTriggerWidth/></label>
          <div className="media-ready-note"><Check size={17}/><div><b>Папка создастся автоматически</b><span>BotCRM подготовит <code>/bot_crm/{botSlug || "техническое_имя"}</code> на Яндекс Диске.</span></div></div>
          <details className="media-technical"><summary>Использовать другую папку</summary><label className="form-field"><span>Полный путь на Яндекс Диске</span><input value={yandexRoot} onChange={(event) => setYandexRoot(event.target.value)} placeholder="/другая_папка/бот"/><small>Оставьте пустым, если подходит стандартная папка BotCRM.</small></label></details>
        </div>
        <footer><button type="button" className="button secondary" onClick={close} disabled={busy}>Отмена</button><button className="button primary" disabled={busy || name.trim().length < 2 || !botSlug}>{busy ? <LoaderCircle className="spin" size={16}/> : <Plus size={16}/>} Добавить</button></footer>
      </form>
    </section>
  </div>;
}

export function KeywordRepliesView({ canManage, canAdmin, mediaChange }: { canManage: boolean; canAdmin: boolean; mediaChange?: { botSlug?: string; revision: number } }) {
  const [bots, setBots] = useState<ApiContentBot[]>([]);
  const [botSlug, setBotSlug] = useState("");
  const [rules, setRules] = useState<ApiKeywordReply[]>([]);
  const [media, setMedia] = useState<ApiContentMedia[]>([]);
  const refreshMediaRef = useRef<() => void>(() => undefined);
  const pendingMediaRef = useRef(false);
  const currentBotRef = useRef(botSlug);
  useEffect(() => { currentBotRef.current = botSlug; }, [botSlug]);
  useEffect(() => { pendingMediaRef.current = media.some((item) => item.status === "queued" || item.status === "processing"); }, [media]);
  const [settings, setSettings] = useState<ApiKeywordReplySettings>({ unknownMessage: "" });
  const [tab, setTab] = useState<ViewTab>("rules");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<Notice>(null);
  const [editor, setEditor] = useState<ApiKeywordReply | "new" | null>(null);
  const [mediaEditor, setMediaEditor] = useState<ApiContentMedia | "new" | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [tokenDialogOpen, setTokenDialogOpen] = useState(false);
  const [creatingToken, setCreatingToken] = useState(false);
  const [issuedToken, setIssuedToken] = useState<IssuedToken | null>(null);
  const [botDialogOpen, setBotDialogOpen] = useState(false);
  const [creatingBot, setCreatingBot] = useState(false);

  async function loadBots() {
    setLoading(true); setError("");
    try {
      const items = await botcrmApi.contentBots();
      setBots(items);
      setBotSlug((current) => items.some((item) => item.botSlug === current) ? current : items[0]?.botSlug || "");
    } catch (loadError) { setError(errorText(loadError, "Не удалось подключиться к платформе контента")); }
    finally { setLoading(false); }
  }

  const loadContent = useCallback(async (slug = botSlug, quiet = false) => {
    if (!slug) return;
    if (!quiet) setLoading(true); else setRefreshing(true);
    setError("");
    try {
      const [nextRules, nextMedia, nextSettings] = await Promise.all([botcrmApi.keywordReplies(slug), botcrmApi.contentMedia(slug), botcrmApi.keywordReplySettings(slug)]);
      if (currentBotRef.current !== slug) return;
      setRules(nextRules); setMedia(nextMedia); setSettings(nextSettings);
    } catch (loadError) { setError(errorText(loadError, "Не удалось загрузить автоответы")); }
    finally { setLoading(false); setRefreshing(false); }
  }, [botSlug]);

  useEffect(() => { void loadBots(); }, []);
  useEffect(() => { if (botSlug) void loadContent(botSlug); }, [botSlug, loadContent]);
  useEffect(() => {
    if (!botSlug) return;
    let active = true;
    let running = false;
    let pending = false;
    let lastRefresh = Date.now();
    const refresh = async () => {
      if (!active || document.visibilityState !== "visible") return;
      if (running) { pending = true; return; }
      running = true;
      do {
        pending = false;
        try {
          const next = await botcrmApi.contentMedia(botSlug);
          if (active) setMedia((current) => JSON.stringify(current) === JSON.stringify(next) ? current : next);
        } catch { /* Keep the editor intact; reconnect, focus and periodic catch-up retry. */ }
        lastRefresh = Date.now();
      } while (active && pending);
      running = false;
    };
    refreshMediaRef.current = () => { void refresh(); };
    const catchUp = () => { void refresh(); };
    const timer = window.setInterval(() => {
      if (pendingMediaRef.current || Date.now() - lastRefresh >= 30_000) void refresh();
    }, 5_000);
    window.addEventListener("focus", catchUp);
    document.addEventListener("visibilitychange", catchUp);
    return () => { active = false; refreshMediaRef.current = () => undefined; window.clearInterval(timer); window.removeEventListener("focus", catchUp); document.removeEventListener("visibilitychange", catchUp); };
  }, [botSlug]);
  useEffect(() => { if (mediaChange?.botSlug === botSlug) refreshMediaRef.current(); }, [botSlug, mediaChange]);
  useEffect(() => { if (!notice) return; const timer = window.setTimeout(() => setNotice(null), 8000); return () => window.clearTimeout(timer); }, [notice]);

  const bot = bots.find((item) => item.botSlug === botSlug);
  const published = rules.filter((rule) => rule.enabled && rule.response.status === "published").length;
  const readyMedia = media.filter(canAttachMedia).length;
  const fallbackName = settings.fallbackResponseId ? rules.find((rule) => rule.response.id === settings.fallbackResponseId)?.response.name : undefined;

  async function saveRule(input: ApiKeywordReplyInput) {
    if (!botSlug) return;
    try {
      if (editor && editor !== "new") await botcrmApi.updateKeywordReply(botSlug, editor.id, input);
      else await botcrmApi.createKeywordReply(botSlug, input);
      setEditor(null); await loadContent(botSlug, true);
      setNotice({ tone: "success", text: editor === "new" ? "Автоответ создан" : "Автоответ сохранён" });
    } catch (saveError) { throw new Error(errorText(saveError, "Не удалось сохранить автоответ")); }
  }

  async function removeRule(rule: ApiKeywordReply) {
    try { await botcrmApi.deleteKeywordReply(botSlug, rule.id); await loadContent(botSlug, true); setNotice({ tone: "success", text: "Автоответ удалён" }); return true; }
    catch (removeError) { setNotice({ tone: "error", text: errorText(removeError, "Не удалось удалить автоответ") }); return false; }
  }

  async function saveMedia(input: ApiContentMediaInput) {
    try {
      if (mediaEditor && mediaEditor !== "new") await botcrmApi.updateContentMedia(botSlug, mediaEditor.id, input);
      else await botcrmApi.createContentMedia(botSlug, input);
      setMediaEditor(null); await loadContent(botSlug, true);
      setNotice({ tone: "success", text: input.status === "queued" ? "Материал поставлен в очередь" : "Материал сохранён" });
    } catch (saveError) { throw new Error(errorText(saveError, "Не удалось сохранить материал")); }
  }

  async function removeMedia(item: ApiContentMedia) {
    try {
      await botcrmApi.deleteContentMedia(botSlug, item.id);
      setMedia((items) => items.filter((candidate) => candidate.id !== item.id));
      setNotice({ tone: "success", text: "Файл убран из медиатеки" });
      return true;
    } catch (removeError) {
      const message = removeError instanceof ApiError && removeError.code === "content_media_in_use"
        ? "Сначала открепите файл от автоответа и сохраните его. После этого файл можно убрать из медиатеки."
        : errorText(removeError, "Не удалось убрать файл");
      setNotice({ tone: "error", text: message });
      return false;
    }
  }

  async function confirmRemoval() {
    if (!deleteTarget) return;
    setDeleting(true);
    const removed = deleteTarget.type === "media" ? await removeMedia(deleteTarget.item) : await removeRule(deleteTarget.item);
    setDeleting(false);
    if (removed) setDeleteTarget(null);
  }

  async function createBotToken() {
    setCreatingToken(true);
    try {
      const result = await botcrmApi.createContentToken(botSlug);
      setIssuedToken({ token: result.token, botName: bot?.name || botSlug });
    } catch (tokenError) {
      setNotice({ tone: "error", text: errorText(tokenError, "Не удалось создать токен бота") });
    } finally {
      setCreatingToken(false);
    }
  }

  function openTokenDialog() {
    setIssuedToken(null);
    setTokenDialogOpen(true);
  }

  function closeTokenDialog() {
    if (creatingToken) return;
    setTokenDialogOpen(false);
    setIssuedToken(null);
  }

  async function createContentBot(input: { botSlug: string; name: string; channel: ApiContentBot["channel"]; yandexRoot?: string }) {
    setCreatingBot(true);
    try {
      const created = await botcrmApi.registerContentBot(input);
      setBots((items) => [...items.filter((item) => item.botSlug !== created.botSlug), created]);
      setBotSlug(created.botSlug);
      setBotDialogOpen(false);
      setNotice({ tone: "success", text: "Пространство контента создано. Теперь выпустите персональный токен для процесса бота." });
    } catch (createError) {
      setNotice({ tone: "error", text: errorText(createError, "Не удалось добавить бота") });
    } finally {
      setCreatingBot(false);
    }
  }

  if (loading && !bots.length) return <div className="keyword-page page-scroll"><div className="keyword-state"><LoaderCircle className="spin" size={24}/><b>Подключаем платформу контента</b><span>Загружаем доступных ботов и правила</span></div></div>;
  if (error && !bots.length) return <div className="keyword-page page-scroll"><div className="keyword-state error"><AlertCircle size={28}/><b>Автоответы пока недоступны</b><span>{error}</span><button className="button secondary" onClick={() => void loadBots()}><RefreshCw size={15}/>Повторить</button></div></div>;
  if (!bots.length) return <div className="keyword-page page-scroll"><div className="keyword-state"><CircleOff size={28}/><b>Нет подключённых контентных ботов</b><span>Администратор должен привязать бота к этому рабочему пространству.</span>{canAdmin && <button className="button primary" onClick={() => setBotDialogOpen(true)}><Plus size={16}/>Добавить бота</button>}</div>{botDialogOpen && <ContentBotDialog busy={creatingBot} close={() => !creatingBot && setBotDialogOpen(false)} create={(input) => void createContentBot(input)}/>}</div>;

  return <div className="keyword-page page-scroll">
    <section className="keyword-hero">
      <div className="keyword-hero-copy"><span className="keyword-icon"><MessageSquareReply size={22}/></span><div><span className="eyebrow">Контент без изменения кода</span><h2>Автоответы по ключевым словам</h2><p>Человек пишет фразу — бот находит правило и отправляет подготовленный текст, файл и кнопки.</p></div></div>
      <div className="keyword-bot-picker"><label>Контентный бот</label><div><span className={`channel-badge ${channelClass(bot?.channel || "other")}`}>{bot ? channelLabels[bot.channel] : "Канал"}</span><AppSelect compact className="keyword-bot-select" ariaLabel="Контентный бот" value={botSlug} onValueChange={setBotSlug} options={bots.map((item) => ({ value: item.botSlug, label: item.name, detail: channelLabels[item.channel] }))} matchTriggerWidth/></div><small>{bot?.status === "active" ? "Управляется BotCRM" : "Бот приостановлен"}</small>{canAdmin && <div className="keyword-bot-admin-actions"><button className="button secondary" onClick={openTokenDialog}><Copy size={14}/>Токен</button><button className="button secondary" onClick={() => setBotDialogOpen(true)}><Plus size={14}/>Бот</button></div>}</div>
    </section>

    <section className="keyword-summary">
      <article><span>Правила</span><b>{rules.length}</b><small>{published} работают сейчас</small></article>
      <article><span>Материалы</span><b>{media.length}</b><small>{readyMedia} готовы к выдаче</small></article>
      <article><span>Если ничего не найдено</span><b className="summary-text">{fallbackName || (settings.unknownMessage ? "Короткий текст" : "Ничего")}</b><small>{settings.unknownMessage || "Ответ отключён"}</small></article>
      <article className="keyword-flow"><span>Как это работает</span><div><i>Фраза</i><ArrowRight size={13}/><i>Правило</i><ArrowRight size={13}/><i>Ответ</i></div><small>Публикация применяется без релиза бота</small></article>
    </section>

    <div className="keyword-tabs-row">
      <div className="keyword-tabs"><button className={tab === "rules" ? "active" : ""} onClick={() => setTab("rules")}><MessageSquareReply size={15}/>Автоответы <em>{rules.length}</em></button><button className={tab === "media" ? "active" : ""} onClick={() => setTab("media")}><UploadCloud size={15}/>Медиатека <em>{media.length}</em></button><button className={tab === "fallback" ? "active" : ""} onClick={() => setTab("fallback")}><Settings2 size={15}/>Если ничего не найдено</button></div>
      <div className="keyword-actions"><button className="icon-button" aria-label="Обновить" onClick={() => void loadContent(botSlug, true)} disabled={refreshing}><RefreshCw className={refreshing ? "spin" : ""} size={16}/></button>{canManage && tab === "rules" && <button className="button primary" onClick={() => setEditor("new")}><Plus size={16}/>Новый автоответ</button>}{canManage && tab === "media" && <button className="button primary" onClick={() => setMediaEditor("new")}><Plus size={16}/>Добавить файл</button>}</div>
    </div>

    {error && <div className="keyword-inline-error"><AlertCircle size={16}/><span>{error}</span><button onClick={() => void loadContent(botSlug)}>Повторить</button></div>}
    {tab === "rules" && <RulesPanel rules={rules} canManage={canManage} edit={setEditor} remove={(item) => setDeleteTarget({ type: "rule", item })}/>} 
    {tab === "media" && <MediaPanel media={media} botSlug={botSlug} canManage={canManage} edit={setMediaEditor} remove={(item) => setDeleteTarget({ type: "media", item })}/>}
    {tab === "fallback" && <FallbackPanel botSlug={botSlug} rules={rules} value={settings} canManage={canManage} saved={(next) => { setSettings(next); setNotice({ tone: "success", text: "Ответ по умолчанию сохранён" }); }}/>} 
    {editor && <RuleEditor key={botSlug} initial={editor === "new" ? undefined : editor} botSlug={botSlug} media={media} mediaCreated={(item) => setMedia((items) => items.some((candidate) => candidate.id === item.id) ? items.map((candidate) => candidate.id === item.id ? item : candidate) : [item, ...items])} mediaRemoved={removeMedia} close={() => setEditor(null)} save={saveRule}/>}
    {mediaEditor && <MediaEditor initial={mediaEditor === "new" ? undefined : mediaEditor} botSlug={botSlug} close={() => setMediaEditor(null)} save={saveMedia}/>} 
    {deleteTarget && <DeleteConfirmationDialog target={deleteTarget} busy={deleting} close={() => setDeleteTarget(null)} confirm={() => void confirmRemoval()}/>} 
    {tokenDialogOpen && <ContentTokenDialog issued={issuedToken} busy={creatingToken} create={() => void createBotToken()} close={closeTokenDialog}/>}
    {botDialogOpen && <ContentBotDialog busy={creatingBot} close={() => !creatingBot && setBotDialogOpen(false)} create={(input) => void createContentBot(input)}/>}
    {notice && <div className={`keyword-notice ${notice.tone}`}>{notice.tone === "success" ? <Check size={16}/> : <AlertCircle size={16}/>}<span>{notice.text}</span></div>}
  </div>;
}

function RulesPanel({ rules, canManage, edit, remove }: { rules: ApiKeywordReply[]; canManage: boolean; edit: (rule: ApiKeywordReply) => void; remove: (rule: ApiKeywordReply) => void }) {
  if (!rules.length) return <div className="keyword-empty"><span><MessageSquareReply size={24}/></span><h3>Правил пока нет</h3><p>Создайте ключевую фразу и укажите, что бот должен отправить в ответ.</p></div>;
  return <section className="keyword-rule-list"><header><span>Ключевая фраза и условие</span><span>Что получит пользователь</span><span>Состояние</span><span/></header>{rules.map((rule) => <article key={rule.id} className={!rule.enabled || rule.response.status !== "published" ? "muted" : ""}>
    <div className="keyword-phrase"><b>“{rule.phrase}”</b><small>{matchModeLabels[rule.matchMode]}</small></div>
    <div className="keyword-response-summary"><b>{rule.response.name}</b><p>{activeText(rule)}</p><span>{rule.response.blocks.map((block) => kindLabels[block.kind]).filter((item, index, list) => list.indexOf(item) === index).join(" · ") || "Резервный текст"}{rule.response.buttons.length ? ` · ${rule.response.buttons.length} кноп.` : ""}</span></div>
    <div><span className={`keyword-status ${rule.enabled && rule.response.status === "published" ? "live" : "draft"}`}><i/>{rule.enabled && rule.response.status === "published" ? "Работает" : rule.response.status === "draft" ? "Черновик" : "Выключен"}</span></div>
    <div className="keyword-row-actions">{canManage && <><button onClick={() => edit(rule)} aria-label="Редактировать"><Pencil size={15}/></button><button className="danger" onClick={() => remove(rule)} aria-label="Удалить"><Trash2 size={15}/></button></>}</div>
  </article>)}</section>;
}

function LibraryMediaArtwork({ item, botSlug, play }: { item: ApiContentMedia; botSlug: string; play: (poster: string) => void }) {
  const preview = useDiskPreview(botSlug, item.yandexPath, item.kind === "photo" || item.kind === "video");
  const artwork = <MediaArtwork kind={item.kind} name={item.name} previewUrl={preview.url}/>;
  return item.kind === "video" ? <button type="button" className="library-media-thumbnail" aria-label={`Посмотреть ${item.name}`} onClick={() => play(preview.url)}>{artwork}</button> : <span className="library-media-thumbnail">{artwork}</span>;
}

function MediaPanel({ media, botSlug, canManage, edit, remove }: { media: ApiContentMedia[]; botSlug: string; canManage: boolean; edit: (item: ApiContentMedia) => void; remove: (item: ApiContentMedia) => void }) {
  const [viewing, setViewing] = useState<{ item: ApiContentMedia; poster: string } | null>(null);
  if (!media.length) return <div className="keyword-empty"><span><UploadCloud size={24}/></span><h3>Медиатека пока пустая</h3><p>Нажмите «Добавить файл» и выберите фото, видео или документ прямо на Яндекс Диске.</p></div>;
  return <><section className="keyword-media-grid">{media.map((item) => <article key={item.id}><LibraryMediaArtwork item={item} botSlug={botSlug} play={(poster) => setViewing({ item, poster })}/><div className="media-copy"><div><b>{item.name}</b><MediaPreparationStatus item={item}/></div><p>{canAttachMedia(item) ? "Можно прикреплять к автоответам" : item.status === "error" ? "Нужно проверить и подготовить заново" : "Подготавливается автоматически"}</p><small>{kindLabels[item.kind]}{item.fileSize ? ` · ${formatFileSize(item.fileSize)}` : ""}{item.vkAttachment ? " · VK готов" : ""}{item.telegramFileId ? " · Telegram готов" : ""}</small>{item.errorMessage && <em>{item.errorMessage}</em>}</div>{canManage && <div className="media-card-actions"><button className="icon-button" onClick={() => edit(item)} aria-label={`Изменить ${item.name}`}><Pencil size={15}/></button><button className="icon-button danger" onClick={() => remove(item)} aria-label={`Убрать ${item.name} из медиатеки`}><Trash2 size={15}/></button></div>}</article>)}</section>{viewing && <VideoPreviewDialog botSlug={botSlug} path={viewing.item.yandexPath} name={viewing.item.name} poster={viewing.poster} close={() => setViewing(null)}/>}</>;
}

function FallbackPanel({ botSlug, rules, value, canManage, saved }: { botSlug: string; rules: ApiKeywordReply[]; value: ApiKeywordReplySettings; canManage: boolean; saved: (value: ApiKeywordReplySettings) => void }) {
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => setDraft(value), [value]);
  const selectedFallback = draft.fallbackResponseId ? rules.find((rule) => rule.response.id === draft.fallbackResponseId) : undefined;
  async function submit(event: FormEvent) { event.preventDefault(); setSaving(true); setError(""); try { saved(await botcrmApi.updateKeywordReplySettings(botSlug, { unknownMessage: draft.unknownMessage, fallbackResponseId: draft.fallbackResponseId || null })); } catch (saveError) { setError(errorText(saveError, "Не удалось сохранить")); } finally { setSaving(false); } }
  return <section className="fallback-layout"><form className="fallback-card" onSubmit={submit}><header><span><Settings2 size={19}/></span><div><h3>Если правило не найдено</h3><p>Выберите один понятный ответ, который получит пользователь.</p></div></header><label className="form-field"><span>Короткое сообщение</span><textarea rows={4} value={draft.unknownMessage} onChange={(event) => setDraft({ ...draft, unknownMessage: event.target.value })} disabled={!canManage} placeholder="Например: Не нашёл подходящий материал. Попробуйте другое слово."/></label><div className="form-field"><span>Или выдать полноценный готовый ответ</span><AppSelect ariaLabel="Готовый запасной ответ" value={draft.fallbackResponseId ? String(draft.fallbackResponseId) : ""} onValueChange={(value) => setDraft({ ...draft, fallbackResponseId: value ? Number(value) : undefined })} disabled={!canManage} options={[{ value: "", label: "Только короткое сообщение", detail: "Без файлов и кнопок" }, ...rules.map((rule) => ({ value: String(rule.response.id), label: rule.response.name, detail: "Готовый ответ с его содержимым" }))]} matchTriggerWidth/></div><div className="fallback-tip"><AlertCircle size={15}/><span>Если выбран готовый ответ, бот сможет отправить его текст, медиа и кнопки. Короткое сообщение останется запасным вариантом.</span></div>{error && <p className="form-error">{error}</p>}{canManage && <button className="button primary" disabled={saving}>{saving ? <LoaderCircle className="spin" size={15}/> : <Save size={15}/>}Сохранить</button>}</form><aside className="fallback-preview"><span className="eyebrow">Предпросмотр</span><div className="preview-bot"><Bot size={16}/><b>Бот</b></div><div className="preview-message">{selectedFallback ? selectedFallback.response.fallbackText || activeText(selectedFallback) : draft.unknownMessage || "Бот ничего не отправит."}</div><small>Так выглядит запасной ответ без найденного ключевого слова.</small></aside></section>;
}

function mediaGlyph(kind: ApiContentMedia["kind"], size = 20) {
  if (kind === "photo") return <ImageIcon size={size}/>;
  if (kind === "video") return <Video size={size}/>;
  if (kind === "audio") return <Music2 size={size}/>;
  return <FileText size={size}/>;
}

function formatFileSize(value?: number) {
  if (!value) return "";
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} КБ`;
  return `${(value / 1024 / 1024).toFixed(value > 100 * 1024 * 1024 ? 0 : 1)} МБ`;
}

type PreviewGalleryItem = { key: string; kind: ApiContentMedia["kind"]; name: string; previewUrl?: string; yandexPath?: string };

function PreviewMediaGallery({ items, botSlug }: { items: PreviewGalleryItem[]; botSlug: string }) {
  const [viewing, setViewing] = useState<PreviewGalleryItem | null>(null);
  const visibleItems = useMemo(() => items.slice(0, 10), [items]);
  const [ratios, setRatios] = useState<Record<string, number>>({});
  useEffect(() => {
    let active = true;
    const pending = visibleItems.flatMap((item) => {
      if (!item.previewUrl || typeof window === "undefined") return [];
      const image = new window.Image();
      image.onload = () => {
        if (!active || !image.naturalWidth || !image.naturalHeight) return;
        setRatios((current) => ({ ...current, [item.key]: image.naturalWidth / image.naturalHeight }));
      };
      image.src = item.previewUrl;
      return [image];
    });
    return () => { active = false; pending.forEach((image) => { image.onload = null; }); };
  }, [visibleItems]);
  if (!visibleItems.length) return null;
  const firstRatio = ratios[visibleItems[0].key] || 1;
  const layout = visibleItems.length === 1
    ? firstRatio < .82 ? "single-portrait" : firstRatio > 1.35 ? "single-wide" : "single-square"
    : visibleItems.length === 2 ? "pair-split"
      : visibleItems.length === 3
        ? firstRatio > 1.25 ? "triple-top" : "triple-left"
        : visibleItems.length === 4 ? firstRatio < .9 ? "quad-feature" : "quad" : visibleItems.length === 5 ? "five" : "many";
  return <><div className={`preview-media-gallery ${layout} count-${visibleItems.length}`} aria-label={`Медиафайлов: ${visibleItems.length}`}>{visibleItems.map((item, index) => {
    const ratio = ratios[item.key] || 1;
    const orientation = ratio < .82 ? "portrait" : ratio > 1.35 ? "wide" : "square";
    const style = { ...(item.previewUrl ? { backgroundImage: `url(${JSON.stringify(item.previewUrl).slice(1, -1)})` } : {}), ...(visibleItems.length === 1 ? { aspectRatio: String(ratio) } : {}) };
    return <span className={`preview-gallery-item ${item.kind} ${orientation}`} key={item.key} style={style} role={item.previewUrl && item.kind !== "video" ? "img" : undefined} aria-label={item.name}>{!item.previewUrl && mediaGlyph(item.kind, 25)}{item.kind === "video" && <button type="button" className="preview-play" aria-label={`Посмотреть ${item.name}`} onClick={() => setViewing(item)}><Play size={18}/></button>}{index === 9 && items.length > 10 && <b className="preview-gallery-overflow">+{items.length - 10}</b>}</span>;
  })}</div>{viewing?.yandexPath && <VideoPreviewDialog botSlug={botSlug} path={viewing.yandexPath} name={viewing.name} poster={viewing.previewUrl} close={() => setViewing(null)}/>}</>;
}

function RuleEditor({ initial, botSlug, media, mediaCreated, mediaRemoved, close, save }: { initial?: ApiKeywordReply; botSlug: string; media: ApiContentMedia[]; mediaCreated: (item: ApiContentMedia) => void; mediaRemoved: (item: ApiContentMedia) => Promise<boolean>; close: () => void; save: (input: ApiKeywordReplyInput) => Promise<void> }) {
  const [draft, setDraft] = useState<ApiKeywordReplyInput>(initial ? ruleInput(initial) : emptyRule());
  const [availableMedia, setAvailableMedia] = useState(media);
  const [mediaSearch, setMediaSearch] = useState("");
  const [diskOpen, setDiskOpen] = useState(false);
  const [previewUrls, setPreviewUrls] = useState<Record<number, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [mediaToRemove, setMediaToRemove] = useState<ApiContentMedia | null>(null);
  const [removingMedia, setRemovingMedia] = useState(false);
  const [retryingMedia, setRetryingMedia] = useState<number | null>(null);
  const [mediaNotice, setMediaNotice] = useState("");
  const previewSources = JSON.stringify(availableMedia.filter((item) => (item.kind === "photo" || item.kind === "video") && item.yandexPath).map(({ id, yandexPath }) => ({ id, yandexPath })));
  useEffect(() => setAvailableMedia(media), [media]);
  useEffect(() => {
    let active = true;
    const objectUrls: string[] = [];
    const previewable = JSON.parse(previewSources) as Array<Pick<ApiContentMedia, "id" | "yandexPath">>;
    setPreviewUrls({});
    void Promise.all(previewable.map(async (item) => {
      try {
        const blob = await botcrmApi.contentDiskPreview(botSlug, item.yandexPath);
        if (!active) return;
        const objectUrl = URL.createObjectURL(blob);
        objectUrls.push(objectUrl);
        setPreviewUrls((items) => ({ ...items, [item.id]: objectUrl }));
      } catch { /* A thumbnail is helpful but not required to send the file. */ }
    }));
    return () => { active = false; objectUrls.forEach((url) => URL.revokeObjectURL(url)); };
  }, [previewSources, botSlug]);

  const blocks = useMemo(() => draft.response.blocks || [], [draft.response.blocks]);
  const buttons = draft.response.buttons || [];
  const buttonRows = Object.values(buttons.filter((button) => button.enabled !== false).sort((left, right) => (left.sort || 0) - (right.sort || 0)).reduce<Record<number, ApiKeywordReplyButton[]>>((rows, button) => {
    const row = Math.max(1, button.row || 1);
    (rows[row] ||= []).push(button);
    return rows;
  }, {}));
  const textBlock = blocks.find((block) => block.kind === "text" && block.enabled !== false);
  const message = textBlock?.body || draft.response.fallbackText || "";
  const selectedMedia = blocks.filter((block) => block.kind !== "text" && block.enabled !== false).map((block) => ({ block, item: availableMedia.find((item) => item.id === block.mediaId) }));
  const previewMedia: PreviewGalleryItem[] = useMemo(() => blocks.filter((block) => block.kind !== "text" && block.enabled !== false).map((block, index) => {
    const item = availableMedia.find((candidate) => candidate.id === block.mediaId);
    return { key: String(block.id || `${block.mediaId || block.kind}-${index}`), kind: item?.kind || block.kind as ApiContentMedia["kind"], name: item?.name || kindLabels[block.kind], yandexPath: item?.yandexPath, previewUrl: item ? previewUrls[item.id] : undefined };
  }), [availableMedia, blocks, previewUrls]);
  const mediaLimitReached = selectedMedia.length >= 10;
  const hasUnreadyMedia = blocks.some((block) => block.kind !== "text" && (!block.mediaId || !availableMedia.some((item) => item.id === block.mediaId && canAttachMedia(item))));
  const active = draft.enabled !== false && draft.response.status === "published";
  const filteredMedia = availableMedia.filter((item) => !mediaSearch.trim() || item.name.toLowerCase().includes(mediaSearch.trim().toLowerCase()));

  function response(patch: Partial<ApiKeywordReplyInput["response"]>) { setDraft((current) => ({ ...current, response: { ...current.response, ...patch } })); }
  function updateButton(index: number, patch: Partial<ApiKeywordReplyButton>) { response({ buttons: buttons.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item) }); }
  function setMessage(value: string) {
    const index = blocks.findIndex((block) => block.kind === "text");
    const next = index >= 0
      ? blocks.map((block, blockIndex) => blockIndex === index ? { ...block, body: value, enabled: true } : block)
      : [{ kind: "text" as const, body: value, sort: 10, sendSeparately: false, enabled: true }, ...blocks];
    response({ blocks: next, fallbackText: value });
  }
  function setActive(value: boolean) {
    setDraft((current) => ({ ...current, enabled: value, response: { ...current.response, status: value ? "published" : "draft" } }));
  }
  function toggleMedia(item: ApiContentMedia) {
    const exists = blocks.some((block) => block.kind !== "text" && block.mediaId === item.id);
    if (!exists && !canAttachMedia(item)) return;
    if (!exists && mediaLimitReached) { setError("В один автоответ можно добавить не более 10 файлов."); return; }
    setError("");
    response({ blocks: exists ? blocks.filter((block) => !(block.kind !== "text" && block.mediaId === item.id)) : [...blocks, { kind: item.kind, mediaId: item.id, body: "", sort: (blocks.length + 1) * 10, sendSeparately: false, enabled: true }] });
  }
  async function importDiskFile(file: ApiYandexDiskItem) {
    if (!file.kind) return;
    if (mediaLimitReached) { setError("В один автоответ можно добавить не более 10 файлов."); return; }
    const existing = availableMedia.find((item) => item.yandexPath === file.path);
    if (existing) {
      if (!blocks.some((block) => block.kind !== "text" && block.mediaId === existing.id)) toggleMedia(existing);
      setDiskOpen(false);
      return;
    }
    const item = await botcrmApi.createContentMedia(botSlug, { name: file.name, kind: file.kind, yandexPath: file.path, status: "queued" });
    setAvailableMedia((items) => [item, ...items.filter((candidate) => candidate.id !== item.id)]);
    mediaCreated(item);
    setMediaSearch("");
    setMediaNotice("Файл добавлен в медиатеку. Дождитесь статуса «Готов» и нажмите на карточку, чтобы прикрепить его.");
    setDiskOpen(false);
  }
  async function retryMedia(item: ApiContentMedia) {
    setRetryingMedia(item.id); setError("");
    try {
      const updated = await botcrmApi.updateContentMedia(botSlug, item.id, { name: item.name, kind: item.kind, yandexPath: item.yandexPath, status: "queued" });
      setAvailableMedia((items) => items.map((candidate) => candidate.id === updated.id ? updated : candidate));
      mediaCreated(updated);
      setMediaNotice("Файл снова поставлен в очередь. Статус обновится автоматически.");
    } catch (retryError) { setError(errorText(retryError, "Не удалось повторить подготовку")); }
    finally { setRetryingMedia(null); }
  }
  async function removeLibraryItem() {
    if (!mediaToRemove) return;
    setRemovingMedia(true);
    if (!await mediaRemoved(mediaToRemove)) { setRemovingMedia(false); return; }
    const removedId = mediaToRemove.id;
    setAvailableMedia((items) => items.filter((candidate) => candidate.id !== removedId));
    setDraft((current) => ({
      ...current,
      response: {
        ...current.response,
        blocks: (current.response.blocks || []).filter((block) => block.mediaId !== removedId),
      },
    }));
    setRemovingMedia(false);
    setMediaToRemove(null);
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); setSaving(true); setError("");
    try {
      const phrase = draft.phrase.trim();
      if (!phrase) throw new Error("Напишите ключевую фразу");
      if (hasUnreadyMedia) throw new Error("Дождитесь готовности файлов или открепите их от автоответа.");
      if (!message.trim() && !selectedMedia.length) throw new Error("Добавьте текст, фото, видео или другой файл");
      await save({ ...draft, phrase, response: { ...draft.response, name: draft.response.name.trim() || `Ответ: ${phrase}`, fallbackText: message } });
    } catch (saveError) { setError(errorText(saveError, "Не удалось сохранить")); setSaving(false); }
  }

  return <><div className="modal-backdrop"><div className="modal keyword-modal keyword-editor-v2"><header><div><span className="eyebrow">{initial ? "Автоответ" : "Новый автоответ"}</span><h2>{initial ? `На фразу «${draft.phrase}»` : "Что должен ответить бот?"}</h2><p>Всё на одном экране: фраза, сообщение, файлы и кнопки.</p></div><button type="button" className="icon-button" onClick={close} aria-label="Закрыть"><X size={19}/></button></header><form onSubmit={submit}><div className="modal-body keyword-editor-layout"><section className="keyword-editor-fields">
    <section className="editor-card trigger-card"><div className="editor-card-title"><span>1</span><div><b>Когда отвечать</b><small>Напишите фразу так, как её введёт человек.</small></div></div><div className="trigger-fields"><label className="form-field"><span>Ключевая фраза</span><input value={draft.phrase} onChange={(event) => setDraft({ ...draft, phrase: event.target.value })} placeholder="Например: получить прайс" autoFocus/></label><div className="form-field"><span>Как распознать</span><AppSelect className="keyword-form-select" ariaLabel="Как распознать ключевую фразу" value={draft.matchMode || "contains"} onValueChange={(value) => setDraft({ ...draft, matchMode: value as ApiKeywordReplyInput["matchMode"] })} options={matchModeOptions} matchTriggerWidth/></div></div></section>

    <section className="editor-card answer-card"><div className="editor-card-title"><span>2</span><div><b>Что получит человек</b><small>Можно отправить текст, файлы и кнопки вместе.</small></div></div><label className="form-field message-field"><span>Текст сообщения</span><textarea rows={5} value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Напишите ответ так, как его увидит пользователь…"/></label>
      <div className="media-picker-heading"><div><b>Фото, видео и файлы <em className={mediaLimitReached ? "limit" : ""}>{selectedMedia.length}/10</em></b><small>Прикрепляйте файлы со статусом «Готов». Подготовка обновляется автоматически.</small></div><button type="button" className="button secondary compact" onClick={() => setDiskOpen((value) => !value)}><UploadCloud size={15}/>{diskOpen ? "Скрыть Диск" : "Выбрать с Яндекс Диска"}</button></div>
      {mediaNotice && <p className="media-preparation-note" role="status">{mediaNotice}</p>}
      {hasUnreadyMedia && <p className="media-preparation-note warning" role="status">Прикреплённый файл ещё не готов. Дождитесь подготовки или открепите его, чтобы сохранить ответ.</p>}
      {diskOpen && <YandexDiskBrowser botSlug={botSlug} onSelect={importDiskFile} disabled={mediaLimitReached}/>} 
      <div className="media-library-search"><Search size={15}/><input value={mediaSearch} onChange={(event) => setMediaSearch(event.target.value)} placeholder="Найти в библиотеке"/></div>
      {filteredMedia.length ? <div className="media-choice-grid">{filteredMedia.map((item) => {
        const selected = blocks.some((block) => block.mediaId === item.id);
        const ready = canAttachMedia(item);
        const busy = item.status === "queued" || item.status === "processing";
        const disabled = !selected && (!ready || mediaLimitReached);
        return <article className={`media-choice-item ${selected ? "selected" : ""} ${!ready ? "preparing" : ""}`} key={item.id}>
          <button type="button" className="media-choice-toggle" aria-pressed={selected} aria-describedby={`media-status-${item.id}`} disabled={disabled} onClick={() => toggleMedia(item)}>
            <MediaArtwork kind={item.kind} name={item.name} previewUrl={previewUrls[item.id]}/>
            <span><b>{item.name}</b><small>{kindLabels[item.kind]}{item.fileSize ? ` · ${formatFileSize(item.fileSize)}` : ""}</small><span id={`media-status-${item.id}`}><MediaPreparationStatus item={item}/></span></span>
          </button>
          <div className="media-choice-actions">
            <button type="button" className={selected ? "selected" : ""} aria-label={selected ? `Открепить ${item.name}` : `Прикрепить ${item.name}`} disabled={disabled} onClick={() => toggleMedia(item)}>{selected ? <Check size={14}/> : <Plus size={14}/>}</button>
            {!ready && !busy && <button type="button" aria-label={`Повторить подготовку ${item.name}`} title="Повторить подготовку" disabled={retryingMedia === item.id} onClick={() => void retryMedia(item)}><RefreshCw size={14} className={retryingMedia === item.id ? "spin" : ""}/></button>}
            <button type="button" className="remove" aria-label={`Убрать ${item.name} из медиатеки`} onClick={() => setMediaToRemove(item)}><Trash2 size={14}/></button>
          </div>
        </article>;
      })}</div> : <div className="media-library-empty"><ImageIcon size={21}/><div><b>В библиотеке пока нет файлов</b><small>Выберите фото или видео с Яндекс Диска — оно появится здесь.</small></div></div>}
    </section>

    <section className="editor-card buttons-card"><div className="editor-card-title"><span>3</span><div><b>Кнопки <em>необязательно</em></b><small>Добавьте кнопку со ссылкой или переходом к другому автоответу.</small></div><button type="button" onClick={() => response({ buttons: [...buttons, { label: "", action: "text", target: "", color: "primary", row: Math.floor(buttons.length / 2) + 1, sort: (buttons.length + 1) * 10, enabled: true }] })}><Plus size={15}/>Добавить</button></div>
      {!!buttons.length && <div className="simple-button-list">{buttons.map((button, index) => <article key={button.id || `button-${index}`}><label><span>Текст кнопки</span><input value={button.label} onChange={(event) => updateButton(index, { label: event.target.value })} placeholder="Например: Открыть сайт"/></label><div className="button-action-field"><span>После нажатия</span><AppSelect compact ariaLabel={`Действие кнопки ${index + 1}`} value={button.action} onValueChange={(value) => updateButton(index, { action: value as ApiKeywordReplyButton["action"] })} options={buttonActionOptions} matchTriggerWidth/></div><label className="button-target"><span>{button.action === "open_link" ? "Ссылка" : "Ключевая фраза"}</span><input value={button.target} onChange={(event) => updateButton(index, { target: event.target.value })} placeholder={button.action === "open_link" ? "https://example.com" : "прайс"}/></label><button type="button" aria-label="Удалить кнопку" onClick={() => response({ buttons: buttons.filter((_, itemIndex) => itemIndex !== index) })}><Trash2 size={16}/></button></article>)}</div>}
    </section>

    <details className="keyword-advanced"><summary><span><Settings2 size={16}/><b>Дополнительные настройки</b></span><ChevronDown size={16}/></summary><div><label className="keyword-active-switch"><input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)}/><span><b>{active ? "Автоответ работает" : "Автоответ выключен"}</b><small>{active ? "Бот может отвечать на эту фразу." : "Настройки сохранятся, но бот не отвечает."}</small></span></label><div className="form-split"><label className="form-field"><span>Название в списке</span><input value={draft.response.name} onChange={(event) => response({ name: event.target.value })} placeholder="Создастся из ключевой фразы"/></label><div className="form-field"><span>Если подошло несколько правил</span><AppSelect className="keyword-form-select" ariaLabel="Порядок выбора автоответа" value={draft.priority >= 1000 ? "high" : draft.priority <= 10 ? "low" : "normal"} onValueChange={(value) => setDraft({ ...draft, priority: value === "high" ? 1000 : value === "low" ? 10 : 100 })} options={priorityOptions} matchTriggerWidth/></div></div><p>Важность нужна только когда одно сообщение подходит сразу под несколько автоответов. Обычно её можно не менять.</p></div></details>
    {error && <p className="form-error keyword-form-error"><AlertCircle size={16}/>{error}</p>}
  </section><aside className="keyword-preview"><span className="eyebrow">Так увидит пользователь</span><div className="preview-user-message">{draft.phrase || "Ключевая фраза"}</div><div className="preview-chat"><div className="preview-bot"><Bot size={16}/><b>Бот</b></div><PreviewMediaGallery items={previewMedia} botSlug={botSlug}/>{message ? <div className="preview-message">{message}</div> : !selectedMedia.length && <div className="preview-message muted">Здесь появится ответ бота</div>}{!!buttonRows.length && <div className="preview-buttons">{buttonRows.map((row, rowIndex) => <div className="preview-button-row" key={rowIndex} style={{ gridTemplateColumns: `repeat(${row.length}, minmax(0, 1fr))` }}>{row.map((button, buttonIndex) => <span key={button.id || `${rowIndex}-${buttonIndex}`}>{button.action === "open_link" && <Link2 size={12}/>}<b>{button.label || "Кнопка"}</b></span>)}</div>)}</div>}</div><div className={`preview-state ${active ? "live" : "draft"}`}><i/>{active ? "Автоответ включён" : "Сохранится как черновик"}</div></aside></div><footer><span className="save-hint">{active ? "Изменения начнут работать сразу" : "Автоответ останется выключенным"}</span><div className="keyword-editor-actions"><button type="button" className="button secondary" onClick={close}>Отмена</button><button className="button primary" disabled={saving || hasUnreadyMedia}>{saving ? <LoaderCircle className="spin" size={17}/> : <Save size={17}/>} Сохранить</button></div></footer></form></div></div>{mediaToRemove && <DeleteConfirmationDialog target={{ type: "media", item: mediaToRemove }} busy={removingMedia} close={() => setMediaToRemove(null)} confirm={() => void removeLibraryItem()}/>}</>;
}

function MediaArtwork({ kind, name, previewUrl, large = false }: { kind: ApiContentMedia["kind"]; name: string; previewUrl?: string; large?: boolean }) {
  return <span className={`media-artwork ${kind} ${large ? "large" : ""}`} role={previewUrl ? "img" : undefined} aria-label={previewUrl ? name : undefined} style={previewUrl ? { backgroundImage: `url(${JSON.stringify(previewUrl).slice(1, -1)})` } : undefined}>{!previewUrl && mediaGlyph(kind, large ? 28 : 21)}{kind === "video" && <i><Play size={large ? 17 : 13}/></i>}</span>;
}

function YandexPreview({ botSlug, file, large = false }: { botSlug: string; file: ApiYandexDiskItem; large?: boolean }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    if (!file.previewUrl) return;
    let active = true; let objectUrl = "";
    void botcrmApi.contentDiskPreview(botSlug, file.path).then((blob) => { if (!active) return; objectUrl = URL.createObjectURL(blob); setUrl(objectUrl); }).catch(() => undefined);
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [botSlug, file.path, file.previewUrl]);
  return <MediaArtwork kind={file.kind || "document"} name={file.name} previewUrl={url} large={large}/>;
}

function YandexDiskBrowser({ botSlug, onSelect, disabled = false }: { botSlug: string; onSelect: (file: ApiYandexDiskItem) => Promise<void> | void; disabled?: boolean }) {
  const [listing, setListing] = useState<ApiYandexDiskListing>();
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [selecting, setSelecting] = useState("");
  const [error, setError] = useState("");
  const load = useCallback(async (path?: string) => { setLoading(true); setError(""); try { setListing(await botcrmApi.contentDiskFiles(botSlug, path)); } catch (loadError) { setError(errorText(loadError, "Не удалось открыть Яндекс Диск")); } finally { setLoading(false); } }, [botSlug]);
  useEffect(() => { void load(); }, [load]);
  const visible = (listing?.items || []).filter((item) => !search.trim() || item.name.toLowerCase().includes(search.trim().toLowerCase()));
  const canGoUp = Boolean(listing && listing.path !== listing.root);
  function parentPath() { if (!listing) return; const parent = listing.path.split("/").slice(0, -1).join("/") || "/"; void load(parent.length < listing.root.length ? listing.root : parent); }
  async function choose(file: ApiYandexDiskItem) { setSelecting(file.path); setError(""); try { await onSelect(file); } catch (selectError) { setError(errorText(selectError, "Не удалось добавить файл")); } finally { setSelecting(""); } }
  return <div className="disk-browser"><header><div><span className="disk-logo">Я</span><div><b>Яндекс Диск</b><small>{listing?.path || "Открываем папку бота…"}</small></div></div>{canGoUp && <button type="button" onClick={parentPath}><ArrowLeft size={14}/>Назад</button>}</header><label className="disk-search"><Search size={15}/><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Найти файл в этой папке"/></label>{disabled && <div className="disk-limit-note"><AlertCircle size={15}/><span>Уже выбрано 10 файлов. Снимите выбор с одного файла, чтобы добавить другой.</span></div>}{loading ? <div className="disk-state"><LoaderCircle className="spin" size={21}/><span>Загружаем файлы…</span></div> : error ? <div className="disk-state error"><AlertCircle size={21}/><div><b>Диск пока недоступен</b><span>{error}</span></div><button type="button" onClick={() => void load(listing?.path)}><RefreshCw size={14}/>Повторить</button></div> : <div className="disk-grid">{visible.map((item) => item.type === "dir" ? <button type="button" className="disk-folder" key={item.path} onClick={() => void load(item.path)}><Folder size={24}/><span><b>{item.name}</b><small>Папка</small></span><ChevronRight size={15}/></button> : <button type="button" className="disk-file" key={item.path} disabled={Boolean(selecting) || disabled} onClick={() => void choose(item)}><YandexPreview botSlug={botSlug} file={item}/><span><b>{item.name}</b><small>{kindLabels[item.kind || "document"]}{item.size ? ` · ${formatFileSize(item.size)}` : ""}</small></span><i>{selecting === item.path ? <LoaderCircle className="spin" size={15}/> : <Plus size={15}/>}</i></button>)}{!visible.length && <div className="disk-empty"><Folder size={22}/><b>В этой папке нет файлов</b></div>}</div>}</div>;
}

function MediaEditor({ initial, botSlug, close, save }: { initial?: ApiContentMedia; botSlug: string; close: () => void; save: (input: ApiContentMediaInput) => Promise<void> }) {
  const [draft, setDraft] = useState<ApiContentMediaInput>(initial ? { name: initial.name, kind: initial.kind, yandexPath: initial.yandexPath, status: initial.status } : { name: "", kind: "photo", yandexPath: "", status: "queued" });
  const [selectedFile, setSelectedFile] = useState<ApiYandexDiskItem>();
  const [browsing, setBrowsing] = useState(!initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  function choose(file: ApiYandexDiskItem) { if (!file.kind) return; setSelectedFile(file); setDraft({ name: file.name, kind: file.kind, yandexPath: file.path, status: "queued" }); setBrowsing(false); }
  async function submit(event: FormEvent) { event.preventDefault(); setSaving(true); setError(""); try { if (!draft.yandexPath) throw new Error("Сначала выберите файл"); await save(draft); } catch (saveError) { setError(errorText(saveError, "Не удалось сохранить")); setSaving(false); } }
  const statusOptions: AppSelectOption[] = [
    { value: "draft", label: "Черновик", detail: "Не подготавливать сейчас" },
    { value: "queued", label: "Подготовить заново", detail: "Поставить файл в очередь" },
    ...(initial?.status === "ready" ? [{ value: "ready", label: "Готов", detail: "Файл уже подготовлен" }] : []),
    ...(initial?.status === "error" ? [{ value: "error", label: "Ошибка", detail: "Требует внимания" }] : []),
  ];
  return <div className="modal-backdrop"><div className="modal media-modal media-modal-v2"><header><div><span className="eyebrow">Библиотека медиа</span><h2>{initial ? "Изменить материал" : "Выбрать файл"}</h2><p>Файл останется на Яндекс Диске. Бот сам подготовит его к отправке.</p></div><button type="button" className="icon-button" onClick={close} aria-label="Закрыть"><X size={19}/></button></header><form onSubmit={submit}><div className="modal-body">{browsing ? <YandexDiskBrowser botSlug={botSlug} onSelect={choose}/> : <><div className="selected-disk-file">{selectedFile ? <YandexPreview botSlug={botSlug} file={selectedFile} large/> : <MediaArtwork kind={draft.kind} name={draft.name} large/>}<div><span>Выбранный файл</span><b>{draft.name}</b><small>{kindLabels[draft.kind]}{selectedFile?.size ? ` · ${formatFileSize(selectedFile.size)}` : ""}</small></div><button type="button" onClick={() => setBrowsing(true)}>Выбрать другой</button></div><label className="form-field"><span>Как назвать в библиотеке</span><input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="Например: Фото массажного кабинета"/></label><div className="media-ready-note"><Check size={17}/><div><b>Всё готово</b><span>После сохранения файл появится в медиабиблиотеке и начнёт подготавливаться.</span></div></div><details className="media-technical"><summary>Техническая информация</summary><code>{draft.yandexPath}</code>{initial && <div className="form-field"><span>Состояние</span><AppSelect ariaLabel="Состояние материала" value={draft.status || "draft"} onValueChange={(value) => setDraft({ ...draft, status: value as ApiContentMediaInput["status"] })} options={statusOptions} matchTriggerWidth/></div>}</details></>}{error && <p className="form-error keyword-form-error"><AlertCircle size={16}/>{error}</p>}</div><footer><button type="button" className="button secondary" onClick={close}>Отмена</button>{!browsing && <button className="button primary" disabled={saving || !draft.yandexPath}>{saving ? <LoaderCircle className="spin" size={16}/> : <Save size={16}/>} Добавить в библиотеку</button>}</footer></form></div></div>;
}
