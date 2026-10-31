"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Check,
  LoaderCircle,
  MessageCircle,
  Plus,
  Send,
  Settings2,
  X,
} from "lucide-react";
import {
  ApiAssistantResult,
  ApiAssistantSettings,
  ApiContentBot,
  ApiContentMedia,
  ApiError,
  ApiKeywordReplyInput,
  ApiUser,
  botcrmApi,
} from "./api-client";
import { AppSelect } from "./ui/app-select";
import { RuleEditor } from "./keyword-replies-view";

type Props = {
  user: ApiUser;
  section: string;
  sectionTitle: string;
  botSlug?: string;
  conversation?: { id: string; name: string };
  navigate: (section: string) => void;
  insertReply: (conversationId: string, text: string) => boolean;
  ruleSaved: () => void;
  notify: (message: string) => void;
};
type Turn = {
  id: string;
  role: "user" | "assistant";
  text: string;
  result?: ApiAssistantResult;
};
const errorMessage = (error: unknown) =>
  error instanceof ApiError
    ? error.message
    : "Не удалось связаться с помощником. Проверьте соединение; автоматический повтор отключён.";
const money = (value: number) =>
  new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 4,
  }).format(value);

export function AssistantPanel(props: Props) {
  const [open, setOpen] = useState(false),
    [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<ApiAssistantSettings | null>(null),
    [loading, setLoading] = useState(false),
    [busy, setBusy] = useState(false);
  const [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [turns, setTurns] = useState<Turn[]>([]);
  const [bots, setBots] = useState<ApiContentBot[]>([]),
    [botSlug, setBotSlug] = useState(props.botSlug || "");
  const [includeConversation, setIncludeConversation] = useState(false);
  const [editor, setEditor] = useState<{
    id: string;
    botSlug: string;
    input: ApiKeywordReplyInput;
    media: ApiContentMedia[];
  } | null>(null);
  const [applied, setApplied] = useState<string[]>([]);
  const requestLock = useRef(false),
    inputRef = useRef<HTMLTextAreaElement>(null),
    launcherRef = useRef<HTMLButtonElement>(null),
    bottomRef = useRef<HTMLDivElement>(null);
  const contextKey =
    props.user.workspaceId +
    ":" +
    props.user.userId +
    ":" +
    botSlug +
    ":" +
    (props.conversation?.id || "");
  const contextRef = useRef(contextKey);
  useEffect(() => {
    contextRef.current = contextKey;
  }, [contextKey]);
  const admin = props.user.role === "OWNER" || props.user.role === "ADMIN";
  const canManage = admin || props.user.role === "SUPERVISOR";
  const identity = props.user.workspaceId + ":" + props.user.userId;
  useEffect(() => {
    setTurns([]);
    setApplied([]);
    setSettings(null);
    setOpen(false);
    setIncludeConversation(false);
  }, [identity]);
  useEffect(() => {
    if (props.botSlug) setBotSlug(props.botSlug);
  }, [props.botSlug]);
  useEffect(() => setIncludeConversation(false), [props.conversation?.id]);
  useEffect(() => {
    setTurns([]);
    setError("");
    setApplied([]);
  }, [contextKey]);
  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    setError("");
    void Promise.all([
      botcrmApi.assistantSettings(),
      botcrmApi.contentBots().catch(() => []),
    ])
      .then(([status, items]) => {
        if (active) {
          setSettings(status);
          setBots(items);
          setBotSlug((current) =>
            items.some((b) => b.botSlug === current) ? current : "",
          );
        }
      })
      .catch((e) => active && setError(errorMessage(e)))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [open]);
  useEffect(() => {
    if (open && !settingsOpen) inputRef.current?.focus();
  }, [open, settingsOpen]);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "nearest" });
  }, [turns, busy]);
  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !editor) {
        setOpen(false);
        launcherRef.current?.focus();
      }
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [open, editor]);

  async function ask(event: FormEvent) {
    event.preventDefault();
    if (requestLock.current || !message.trim() || !settings?.enabled) return;
    requestLock.current = true;
    setBusy(true);
    setError("");
    const text = message.trim(),
      requestId = crypto.randomUUID(),
      requestContext = contextRef.current;
    const history = turns
      .slice(-6)
      .map((t) => ({ role: t.role, text: t.text.slice(0, 2000) }));
    setTurns((current) => [
      ...current.slice(-19),
      { id: requestId, role: "user", text },
    ]);
    setMessage("");
    try {
      const result = await botcrmApi.askAssistant({
        requestId,
        message: text,
        section: props.section,
        ...(botSlug ? { botSlug } : {}),
        ...(includeConversation && props.conversation
          ? { conversationId: props.conversation.id, includeConversation: true }
          : {}),
        history,
      });
      if (contextRef.current === requestContext)
        setTurns((current) => [
          ...current,
          {
            id: result.requestId + "-result",
            role: "assistant",
            text: result.text,
            result,
          },
        ]);
      setSettings(await botcrmApi.assistantSettings());
    } catch (e) {
      setError(errorMessage(e));
      void botcrmApi
        .assistantSettings()
        .then(setSettings)
        .catch(() => undefined);
    } finally {
      requestLock.current = false;
      setBusy(false);
      inputRef.current?.focus();
    }
  }
  async function openEditor(result: ApiAssistantResult) {
    if (!result.keywordDraft || !canManage) return;
    setError("");
    try {
      const media = await botcrmApi.contentMedia(result.keywordDraft.botSlug);
      setEditor({ id: result.requestId, ...result.keywordDraft, media });
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  async function saveRule(input: ApiKeywordReplyInput) {
    if (!editor) return;
    await botcrmApi.createKeywordReply(editor.botSlug, input);
    setApplied((current) => [...current, editor.id]);
    setEditor(null);
    props.ruleSaved();
    props.notify("Автоответ сохранён");
  }

  return (
    <>
      {!open && (
        <button
          ref={launcherRef}
          className="assistant-launcher"
          aria-label="Открыть AI-помощника"
          aria-expanded={open}
          onClick={() => setOpen(true)}
        >
          <MessageCircle size={22} />
          <span>Помощник</span>
        </button>
      )}
      {open && (
        <aside
          className="assistant-panel"
          role="dialog"
          aria-label="AI-помощник BotCRM"
        >
          <header>
            <div className="assistant-heading">
              <span className="assistant-symbol">
                <Bot size={21} />
              </span>
              <div>
                <b>
                  {settingsOpen ? "Настройки помощника" : "Помощник BotCRM"}
                </b>
                <small>
                  {settingsOpen
                    ? "Подключение и лимиты"
                    : settings?.enabled
                      ? "Помогает подготовить и проверить"
                      : "Подключение AI"}
                </small>
              </div>
            </div>
            <div className="assistant-header-actions">
              {admin && (
                <button
                  className="icon-button"
                  aria-label={
                    settingsOpen ? "Вернуться в чат" : "Настройки AI-помощника"
                  }
                  onClick={() => setSettingsOpen(!settingsOpen)}
                >
                  {settingsOpen ? (
                    <ArrowLeft size={17} />
                  ) : (
                    <Settings2 size={17} />
                  )}
                </button>
              )}
              <button
                className="icon-button"
                aria-label="Закрыть помощника"
                onClick={() => {
                  setOpen(false);
                  launcherRef.current?.focus();
                }}
              >
                <X size={18} />
              </button>
            </div>
          </header>
          {loading ? (
            <div className="assistant-empty">
              <LoaderCircle className="spin" size={22} />
              <span>Подключаем помощника…</span>
            </div>
          ) : settingsOpen && settings ? (
            <AssistantSettings value={settings} saved={setSettings} />
          ) : (
            <>
              <div className="assistant-context">
                <span>
                  Раздел: <b>{props.sectionTitle}</b>
                </span>
                {bots.length > 0 && (
                  <div className="form-field">
                    <span>Бот для автоответов</span>
                    <AppSelect
                      ariaLabel="Бот для AI-помощника"
                      value={botSlug}
                      onValueChange={setBotSlug}
                      options={[
                        { value: "", label: "Без выбранного бота" },
                        ...bots.map((b) => ({
                          value: b.botSlug,
                          label: b.name,
                        })),
                      ]}
                      matchTriggerWidth
                    />
                  </div>
                )}
                {props.conversation && (
                  <label className="assistant-context-check">
                    <input
                      type="checkbox"
                      checked={includeConversation}
                      onChange={(e) => setIncludeConversation(e.target.checked)}
                    />
                    <span>
                      Передать AI последние сообщения:{" "}
                      <b>{props.conversation.name}</b>
                    </span>
                  </label>
                )}
              </div>
              <div
                className="assistant-messages"
                role="log"
                aria-label="Переписка с помощником"
                aria-live="polite"
              >
                {!settings?.enabled ? (
                  <div className="assistant-empty">
                    <Bot size={28} />
                    <h3>Помощник ещё не подключён</h3>
                    <p>
                      {admin
                        ? "Добавьте API-ключ и установите лимиты. Запросы начнутся только после отправки сообщения."
                        : "Администратор может подключить AI в настройках помощника."}
                    </p>
                    {admin && settings && (
                      <button
                        className="button primary"
                        onClick={() => setSettingsOpen(true)}
                      >
                        Настроить подключение
                      </button>
                    )}
                  </div>
                ) : !turns.length ? (
                  <div className="assistant-welcome">
                    <h3>Чем помочь?</h3>
                    <p>
                      Объясню настройки, подготовлю автоответ или помогу с
                      выбранной перепиской.
                    </p>
                    <div className="assistant-suggestions">
                      {[
                        "Как добавить фото в автоответ?",
                        ...(canManage
                          ? ["Подготовь простой автоответ на слово «привет»"]
                          : []),
                        ...(includeConversation
                          ? [
                              "Кратко перескажи выбранный диалог",
                              "Предложи ответ клиенту",
                            ]
                          : []),
                      ].map((text) => (
                        <button
                          key={text}
                          onClick={() => {
                            setMessage(text);
                            inputRef.current?.focus();
                          }}
                        >
                          {text}
                          <ArrowRight size={14} />
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
                {turns.map((turn) => (
                  <article
                    key={turn.id}
                    className={`assistant-turn ${turn.role}`}
                  >
                    <small>{turn.role === "user" ? "Вы" : "Помощник"}</small>
                    <p>{turn.text}</p>
                    {turn.result && (
                      <div className="assistant-result-actions">
                        {turn.result.navigateTo && (
                          <button
                            className="button secondary"
                            onClick={() =>
                              props.navigate(turn.result!.navigateTo!)
                            }
                          >
                            Открыть раздел <ArrowRight size={14} />
                          </button>
                        )}
                        {turn.result.keywordDraft && canManage && (
                          <div className="assistant-draft-card">
                            <b>
                              {turn.result.keywordDraft.input.response.name}
                            </b>
                            <span>
                              На фразу «{turn.result.keywordDraft.input.phrase}»
                            </span>
                            <p>
                              {
                                turn.result.keywordDraft.input.response.blocks?.find(
                                  (b) => b.kind === "text",
                                )?.body
                              }
                            </p>
                            <small>
                              {turn.result.keywordDraft.input.response.blocks?.filter(
                                (b) => b.kind !== "text",
                              ).length || 0}{" "}
                              файлов ·{" "}
                              {turn.result.keywordDraft.input.response.buttons
                                ?.length || 0}{" "}
                              кнопок
                            </small>
                            <button
                              className="button primary"
                              disabled={applied.includes(turn.result.requestId)}
                              onClick={() => void openEditor(turn.result!)}
                            >
                              {applied.includes(turn.result.requestId) ? (
                                <>
                                  <Check size={15} />
                                  Сохранено
                                </>
                              ) : (
                                <>
                                  Проверить в редакторе <ArrowRight size={14} />
                                </>
                              )}
                            </button>
                          </div>
                        )}
                        {turn.result.replyDraft && (
                          <button
                            className="button secondary"
                            onClick={() => {
                              if (
                                props.insertReply(
                                  turn.result!.replyDraft!.conversationId,
                                  turn.result!.replyDraft!.text,
                                )
                              )
                                props.notify(
                                  "Текст добавлен в черновик. Проверьте его перед отправкой.",
                                );
                            }}
                          >
                            Добавить в черновик сообщения
                          </button>
                        )}
                        {turn.result.taskDraft && (
                          <TaskDraft
                            result={turn.result}
                            notify={props.notify}
                          />
                        )}
                        <small className="assistant-turn-cost">
                          Оценка запроса: {money(turn.result.usage.costUsd)}
                        </small>
                      </div>
                    )}
                  </article>
                ))}
                {busy && (
                  <div className="assistant-thinking" role="status">
                    <LoaderCircle className="spin" size={16} />
                    Готовлю ответ…
                  </div>
                )}
                <div ref={bottomRef} />
              </div>
              {settings?.enabled && (
                <form className="assistant-compose" onSubmit={ask}>
                  <textarea
                    ref={inputRef}
                    aria-label="Сообщение AI-помощнику"
                    value={message}
                    maxLength={4000}
                    onChange={(e) => setMessage(e.target.value)}
                    placeholder="Опишите, что хотите сделать…"
                    rows={3}
                    onKeyDown={(e) => {
                      if (
                        e.key === "Enter" &&
                        !e.shiftKey &&
                        !e.nativeEvent.isComposing
                      ) {
                        e.preventDefault();
                        e.currentTarget.form?.requestSubmit();
                      }
                    }}
                  />
                  <div>
                    <button
                      type="button"
                      className="button secondary"
                      disabled={busy || !turns.length}
                      onClick={() => {
                        setTurns([]);
                        setError("");
                      }}
                    >
                      Новый чат
                    </button>
                    <button
                      className="button primary"
                      disabled={busy || !message.trim()}
                      aria-label="Отправить запрос помощнику"
                    >
                      {busy ? (
                        <LoaderCircle className="spin" size={17} />
                      ) : (
                        <Send size={17} />
                      )}
                      Отправить
                    </button>
                  </div>
                  <small>
                    AI готовит черновики. Сохранение и отправка — после вашей
                    проверки.
                  </small>
                </form>
              )}
              {settings?.enabled && (
                <footer className="assistant-budget">
                  <span>
                    Месяц: {money(settings.monthSpentUsd)} /{" "}
                    {money(settings.monthlyBudgetUsd)}
                  </span>
                  <span>
                    Сегодня: {settings.userRequestsToday} /{" "}
                    {settings.dailyUserLimit}
                  </span>
                </footer>
              )}
            </>
          )}
          {error && (
            <div className="assistant-error" role="alert">
              {error}
            </div>
          )}
        </aside>
      )}
      {editor && (
        <RuleEditor
          initialDraft={editor.input}
          botSlug={editor.botSlug}
          media={editor.media}
          mediaCreated={(item) =>
            setEditor((current) =>
              current
                ? {
                    ...current,
                    media: [
                      item,
                      ...current.media.filter((m) => m.id !== item.id),
                    ],
                  }
                : current,
            )
          }
          mediaRemoved={async () => {
            throw new Error("Для удаления откройте раздел «Медиатека».");
          }}
          close={() => setEditor(null)}
          save={saveRule}
        />
      )}
    </>
  );
}

function TaskDraft({
  result,
  notify,
}: {
  result: ApiAssistantResult;
  notify: Props["notify"];
}) {
  const [busy, setBusy] = useState(false),
    [saved, setSaved] = useState(false),
    [error, setError] = useState("");
  const task = result.taskDraft!;
  return (
    <div className="assistant-draft-card">
      <b>Задача</b>
      <p>{task.title}</p>
      {task.dueAt && (
        <small>{new Date(task.dueAt).toLocaleString("ru-RU")}</small>
      )}
      <button
        className="button secondary"
        disabled={busy || saved}
        onClick={async () => {
          setBusy(true);
          setError("");
          try {
            await botcrmApi.addContactTask(task.contactId, {
              title: task.title,
              dueAt: task.dueAt,
            });
            setSaved(true);
            notify("Задача создана");
          } catch (e) {
            setError(errorMessage(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {saved ? <Check size={15} /> : <Plus size={15} />}{" "}
        {saved ? "Создана" : "Создать задачу"}
      </button>
      {error && <small role="alert">{error}</small>}
    </div>
  );
}

function AssistantSettings({
  value,
  saved,
}: {
  value: ApiAssistantSettings;
  saved: (settings: ApiAssistantSettings) => void;
}) {
  const [provider, setProvider] = useState(value.provider),
    [key, setKey] = useState(""),
    [enabled, setEnabled] = useState(value.enabled),
    [budget, setBudget] = useState(String(value.monthlyBudgetUsd)),
    [limit, setLimit] = useState(String(value.dailyUserLimit));
  const [clearKey, setClearKey] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [success, setSuccess] = useState(false);
  const model = value.providers.find((p) => p.id === provider);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    setSuccess(false);
    try {
      const next = await botcrmApi.saveAssistantSettings({
        enabled,
        provider,
        monthlyBudgetUsd: Number(budget),
        dailyUserLimit: Number(limit),
        ...(key ? { apiKey: key } : {}),
        clearKey,
      });
      saved(next);
      setKey("");
      setClearKey(false);
      setSuccess(true);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="assistant-settings" onSubmit={submit}>
      <p>
        Подключение общее для рабочего пространства. Ключ хранится зашифрованным
        и не возвращается в браузер.
      </p>
      <div className="form-field">
        <span>Провайдер</span>
        <AppSelect
          ariaLabel="AI-провайдер"
          value={provider}
          onValueChange={(v) => {
            setProvider(v as typeof provider);
            setKey("");
            setEnabled(false);
            setSuccess(false);
          }}
          options={value.providers.map((p) => ({
            value: p.id,
            label: p.id === "openai" ? "OpenAI" : "Совместимый сервер",
            detail: p.model,
          }))}
          matchTriggerWidth
        />
      </div>
      <div className="assistant-model">
        <b>{model?.model}</b>
        <small>
          {model
            ? `${money(model.inputPrice)} за 1 млн входных · ${money(model.outputPrice)} выходных токенов`
            : ""}
        </small>
      </div>
      <label className="form-field">
        <span>
          {value.hasKey && provider === value.provider
            ? "Новый API-ключ · необязательно"
            : "API-ключ"}
        </span>
        <input
          type="password"
          autoComplete="new-password"
          spellCheck={false}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={
            value.hasKey && provider === value.provider
              ? "Ключ уже сохранён"
              : "Вставьте ключ провайдера"
          }
          maxLength={512}
        />
      </label>
      {value.hasKey && provider === value.provider && (
        <label className="assistant-context-check">
          <input
            type="checkbox"
            checked={clearKey}
            onChange={(e) => {
              setClearKey(e.target.checked);
              if (e.target.checked) setEnabled(false);
            }}
          />
          Удалить сохранённый ключ
        </label>
      )}
      <div className="assistant-settings-limits">
        <label className="form-field">
          <span>Бюджет на месяц, $</span>
          <input
            type="number"
            value={budget}
            min="0.1"
            max="100"
            step="0.1"
            required
            onChange={(e) => setBudget(e.target.value)}
          />
        </label>
        <label className="form-field">
          <span>Запросов в день на человека</span>
          <input
            type="number"
            value={limit}
            min="1"
            max="1000"
            step="1"
            required
            onChange={(e) => setLimit(e.target.value)}
          />
        </label>
      </div>
      <label className="assistant-context-check">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        Включить помощника
      </label>
      <div className="assistant-settings-note">
        Один запрос на действие, без автоматических повторов и смены модели. При
        ошибке сохраняется резерв бюджета: провайдер мог успеть списать
        средства. Лимиты считаются по UTC.
      </div>
      <button className="button primary" disabled={busy || !value.available}>
        {busy ? (
          <LoaderCircle className="spin" size={16} />
        ) : (
          <Check size={16} />
        )}
        Сохранить настройки
      </button>
      {success && (
        <p role="status">
          Настройки сохранены. Платные запросы начнутся только после отправки
          сообщения.
        </p>
      )}
      {error && (
        <p className="assistant-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
