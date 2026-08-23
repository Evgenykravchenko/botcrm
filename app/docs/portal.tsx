/* eslint-disable @next/next/no-img-element */
"use client";

import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";
import {
  AlertTriangle, ArrowLeft, ArrowRight, BarChart3, BookOpen, Bot, Boxes, Check, CheckCircle2,
  ChevronRight, CircleHelp, Code2, ContactRound, Copy, Database, ExternalLink, FileText,
  Filter, GitBranch, Globe2, Inbox, KeyRound, Layers3, LifeBuoy, LockKeyhole,
  Megaphone, MessageSquare, MonitorCheck, Play, RefreshCw, Search, Send, Settings,
  ShieldCheck, Sparkles, Tag, Terminal, UserCog, Users, Webhook, Workflow, Zap,
  type LucideIcon,
} from "lucide-react";
import {
  acceptedEventExample, automationExample, csharpBot, goBot, javaBot, languageSetup,
  mediaUploadExample, normalizedEventExample, pythonBot, sendMessageExample, typescriptBot,
  webhookVerificationTs,
} from "./examples";

type NavItem = { id: string; title: string; description: string; keywords: string; icon: LucideIcon };
type NavGroup = { label: string; items: NavItem[] };
type Language = keyof typeof languageSetup;

const navGroups: NavGroup[] = [
  { label: "Начало", items: [
    { id: "start", title: "Как пользоваться справкой", description: "Маршруты для оператора, руководителя и разработчика", keywords: "начало помощь документация", icon: BookOpen },
    { id: "first-login", title: "Первый вход", description: "Вход, пустое рабочее пространство и первый результат", keywords: "логин пароль старт пусто", icon: Play },
    { id: "interface", title: "Интерфейс и realtime", description: "Навигация, поиск, темы и обновления", keywords: "меню поиск обновление realtime", icon: MonitorCheck },
  ]},
  { label: "Работа в BotCRM", items: [
    { id: "inbox", title: "Диалоги", description: "Inbox, фильтры, сообщения и управление", keywords: "чат оператор перехват непрочитанные", icon: Inbox },
    { id: "contacts", title: "Контакты", description: "Карточка клиента, теги, заметки и импорт", keywords: "клиент профиль импорт экспорт", icon: ContactRound },
    { id: "attributes", title: "Переменные и сегменты", description: "Поля бота и динамические аудитории", keywords: "attributes поля аудитория фильтр", icon: Tag },
    { id: "pipelines", title: "Воронки и сделки", description: "Этапы, суммы и drag-and-drop", keywords: "канбан сделка стадия продажи", icon: Layers3 },
    { id: "campaigns", title: "Рассылки", description: "Шаблоны, кнопки, медиа и расписание", keywords: "кампания фото время", icon: Megaphone },
    { id: "automations", title: "Автоматизации", description: "Триггеры, условия и действия", keywords: "правило webhook", icon: Workflow },
    { id: "integrations", title: "Боты и каналы", description: "Telegram, VK, WhatsApp, Avito и REST", keywords: "коннектор токен webhook", icon: Bot },
    { id: "analytics", title: "Аналитика", description: "Диалоги, продажи и конверсия", keywords: "график метрики отчет", icon: BarChart3 },
    { id: "settings", title: "Настройки и доступ", description: "Участники, роли, токены и MFA", keywords: "пароль команда 2fa", icon: Settings },
    { id: "recipes", title: "Рабочие сценарии", description: "Поддержка, продажи и возврат", keywords: "пример лид", icon: Sparkles },
  ]},
  { label: "Разработчику", items: [
    { id: "dev-overview", title: "Модель интеграции", description: "Gateway, Mirror и жизненный цикл", keywords: "архитектура sdk", icon: GitBranch },
    { id: "first-bot", title: "Первый бот", description: "Telegram-бот на пяти языках", keywords: "typescript python go csharp java код", icon: Code2 },
    { id: "connector-setup", title: "Настройка коннектора", description: "Поля для каждого канала", keywords: "credentials endpoint secret", icon: Boxes },
    { id: "auth-api", title: "Доступ к API", description: "URL, заголовки и service tokens", keywords: "authorization bearer", icon: KeyRound },
    { id: "events-api", title: "Входящие события", description: "Схема и ответ платформы", keywords: "event_id deliverToBot", icon: Webhook },
    { id: "messages-api", title: "Ответы и медиа", description: "Сообщения, вложения и статусы", keywords: "attachment upload", icon: Send },
    { id: "control-api", title: "Управление диалогом", description: "BOT, HUMAN, PAUSED и version", keywords: "claim return", icon: UserCog },
    { id: "callbacks", title: "Callback и подпись", description: "HMAC, повторы и replay", keywords: "signature timestamp", icon: ShieldCheck },
    { id: "reliability", title: "Надёжность", description: "Идемпотентность, порядок и лимиты", keywords: "retry 429 duplicate", icon: RefreshCw },
    { id: "channels", title: "Особенности каналов", description: "Возможности транспортов", keywords: "templates limits", icon: Globe2 },
  ]},
  { label: "Развертывание", items: [
    { id: "production", title: "Установка на сервер", description: "DNS, HTTPS, Docker и первый вход", keywords: "production deploy domain caddy", icon: Terminal },
    { id: "operations", title: "Обновления и резервные копии", description: "Backup, restore, мониторинг и аварии", keywords: "backup restore update logs", icon: Database },
  ]},  { label: "Справочники", items: [
    { id: "automation-reference", title: "Справочник автоматизаций", description: "Триггеры, операторы и действия", keywords: "automation actions", icon: Workflow },
    { id: "role-matrix", title: "Матрица ролей", description: "Права каждой роли", keywords: "owner admin supervisor operator", icon: Users },
    { id: "api-map", title: "Карта API", description: "Endpoint и Swagger", keywords: "rest openapi", icon: FileText },
    { id: "troubleshooting", title: "Диагностика", description: "Частые проблемы", keywords: "queued 401 timeout offline", icon: LifeBuoy },
    { id: "glossary", title: "Термины", description: "Словарь сущностей", keywords: "контакт диалог сделка", icon: CircleHelp },
  ]},
];

const languageLabels: Record<Language, string> = { typescript: "TypeScript", python: "Python", go: "Go", csharp: "C# / .NET", java: "Java" };
const languageCode: Record<Language, string> = { typescript: typescriptBot, python: pythonBot, go: goBot, csharp: csharpBot, java: javaBot };

function CodeBlock({ code, language = "text", caption }: { code: string; language?: string; caption?: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() { await navigator.clipboard.writeText(code); setCopied(true); window.setTimeout(() => setCopied(false), 1600); }
  return <figure className="docs-code"><header><span>{language}</span><button type="button" onClick={() => void copy()}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? "Скопировано" : "Копировать"}</button></header><pre><code>{code}</code></pre>{caption && <figcaption>{caption}</figcaption>}</figure>;
}
function Callout({ title, children, tone = "info", icon: Icon = CircleHelp }: { title: string; children: ReactNode; tone?: "info" | "warning" | "success" | "danger"; icon?: LucideIcon }) { return <div className={`docs-callout ${tone}`}><Icon size={20} /><div><b>{title}</b><div>{children}</div></div></div>; }
function Steps({ items }: { items: Array<{ title: string; text: ReactNode }> }) { return <div className="docs-steps">{items.map((item, index) => <article className="docs-step" key={item.title}><em>{index + 1}</em><div><h3>{item.title}</h3><div>{item.text}</div></div></article>)}</div>; }
function SectionHeader({ eyebrow, title, children, icon: Icon }: { eyebrow: string; title: string; children: ReactNode; icon: LucideIcon }) { return <header className="docs-section-head"><span className="docs-kicker"><Icon size={14} />{eyebrow}</span><h2>{title}</h2><div className="docs-lead">{children}</div></header>; }
function Screenshot({ src, alt, caption }: { src: string; alt: string; caption: string }) { return <figure className="docs-screenshot"><img src={src} alt={alt} width={1440} height={810} loading="lazy" /><figcaption><MonitorCheck size={15} />{caption}</figcaption></figure>; }
function LanguageExample() { const [language, setLanguage] = useState<Language>("typescript"); return <div className="docs-language-lab"><div className="docs-language-tabs" role="tablist" aria-label="Язык примера бота">{(Object.keys(languageLabels) as Language[]).map((item) => <button type="button" role="tab" aria-selected={language === item} className={language === item ? "active" : ""} onClick={() => setLanguage(item)} key={item}>{languageLabels[item]}</button>)}</div><CodeBlock language="Установка" code={languageSetup[language]} /><CodeBlock language={languageLabels[language]} code={languageCode[language]} caption="Замените тестовые ID данными коннектора. Секреты храните только в окружении." /></div>; }
function CheckList({ items }: { items: ReactNode[] }) { return <div className="docs-checklist">{items.map((item, index) => <div key={index}><CheckCircle2 size={16} />{item}</div>)}</div>; }
function FeatureGrid({ items, columns = 2 }: { items: Array<{ icon: LucideIcon; title: string; text: ReactNode }>; columns?: 2 | 3 }) { return <div className={`docs-card-grid columns-${columns}`}>{items.map(({ icon: Icon, title, text }) => <article key={title}><Icon size={21} /><h3>{title}</h3><div>{text}</div></article>)}</div>; }

export function DocsPortal() {
  const [query, setQuery] = useState("");
  const allItems = useMemo(() => navGroups.flatMap((group) => group.items.map((item) => ({ ...item, group: group.label }))), []);
  const results = useMemo(() => { const value = query.trim().toLocaleLowerCase("ru"); if (value.length < 2) return []; return allItems.filter((item) => `${item.title} ${item.description} ${item.keywords}`.toLocaleLowerCase("ru").includes(value)).slice(0, 8); }, [allItems, query]);
  const jump = (id: string) => { setQuery(""); window.setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: "smooth" }), 0); };
  return <div className="docs-page">
    <header className="docs-topbar"><Link className="docs-brand" href="/"><span><MessageSquare size={20} /></span><b>BotCRM</b><em>Справочный центр</em></Link><div className="docs-search-wrap"><label className="docs-search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Найти: рассылка, Telegram, роли…" aria-label="Поиск по документации" />{query && <button type="button" onClick={() => setQuery("")} aria-label="Очистить поиск">×</button>}</label>{query.trim().length >= 2 && <div className="docs-search-results">{results.length ? results.map((item) => <button type="button" onClick={() => jump(item.id)} key={item.id}><item.icon size={16} /><span><b>{item.title}</b><small>{item.group} · {item.description}</small></span><ChevronRight size={14} /></button>) : <div><Search size={18} /><span><b>Ничего не найдено</b><small>Попробуйте другое слово или откройте Swagger.</small></span></div>}</div>}</div><nav><Link href="/">Открыть панель</Link><a href="/api-docs" target="_blank" rel="noreferrer">Swagger <ExternalLink size={14} /></a></nav></header>
    <aside className="docs-sidebar"><Link className="docs-back" href="/"><ArrowLeft size={15} />Вернуться в BotCRM</Link>{navGroups.map((group) => <div className="docs-nav-group" key={group.label}><p>{group.label}</p>{group.items.map(({ id, title, icon: Icon }) => <a href={`#${id}`} key={id}><Icon size={15} /><span>{title}</span><ChevronRight size={12} /></a>)}</div>)}<div className="docs-sidebar-note"><BookOpen size={17} /><b>API всегда точнее примера</b><span>Все поля конкретного запроса находятся в <a href="/api-docs">Swagger/OpenAPI</a>.</span></div></aside>
    <main className="docs-content">
      <section className="docs-hero" id="start"><div><span className="docs-kicker"><BookOpen size={14} />Документация BotCRM</span><h1>Всё для работы и интеграции</h1><p>Инструкции для оператора и руководителя, а рядом — технический контракт разработчика. Здесь объясняется куда нажать, зачем это нужно, что произойдёт и как проверить результат.</p><div className="docs-hero-actions"><a href="#first-login"><Users size={17} />Я работаю в панели</a><a href="#first-bot" className="secondary"><Code2 size={17} />Я подключаю бота</a></div></div><div className="docs-route-card"><span>Выберите маршрут</span><button type="button" onClick={() => jump("inbox")}><Inbox /><span><b>Оператор</b><small>Диалоги, контакты и задачи</small></span><ArrowRight /></button><button type="button" onClick={() => jump("analytics")}><BarChart3 /><span><b>Руководитель</b><small>Воронка, команда и аналитика</small></span><ArrowRight /></button><button type="button" onClick={() => jump("first-bot")}><Terminal /><span><b>Разработчик</b><small>REST, SDK и webhooks</small></span><ArrowRight /></button></div></section>

      <section className="docs-section" id="first-login"><SectionHeader eyebrow="Начало работы" title="Первый вход и первый результат" icon={Play}>Чистая установка не содержит придуманных клиентов. Данные появляются после подключения бота, импорта или ручного создания карточки.</SectionHeader><Steps items={[
        { title: "Войдите под владельцем", text: <p>Используйте email и пароль установки. В production пароль показывается один раз командой <code>prod:init</code>.</p> },
        { title: "Подключите канал", text: <p>«Боты и каналы» → «Подключить бота» → режим, endpoint и секреты официального API.</p> },
        { title: "Напишите боту", text: <p>Входящее автоматически создаёт контакт, идентификатор канала, диалог и сообщение.</p> },
        { title: "Обработайте обращение", text: <p>Откройте диалог, заберите его у бота, ответьте, создайте заметку, задачу или сделку.</p> },
      ]}/><Callout title="Почему после установки всё пусто" icon={Database}>Это ожидаемо. Демо-данные добавляются только командой <code>npm run demo:seed</code>; production её не выполняет.</Callout></section>

      <section className="docs-section" id="interface"><SectionHeader eyebrow="Общие элементы" title="Навигация, поиск и realtime" icon={MonitorCheck}>Адрес хранится в hash (`#inbox`, `#contacts`, `#pipeline`), поэтому обновление браузера возвращает на ту же страницу.</SectionHeader><FeatureGrid columns={3} items={[
        { icon: Search, title: "Глобальный поиск", text: <p>Ищет контакты, сообщения и сделки минимум по двум символам.</p> }, { icon: Zap, title: "Realtime", text: <p>Сообщения, счётчики и CRM-изменения приходят без перезагрузки.</p> }, { icon: MonitorCheck, title: "Тема", text: <p>Светлая/тёмная тема сохраняется в браузере.</p> }, { icon: RefreshCw, title: "Обновление", text: <p>При проблеме проверьте конкретный раздел или connector.</p> }, { icon: LockKeyhole, title: "Доступ по роли", text: <p>Недоступные действия отключаются, а API повторно проверяет права.</p> }, { icon: Boxes, title: "Workspace", text: <p>Данные изолированы через <code>workspace_id</code>.</p> },
      ]}/></section>

      <section className="docs-section" id="inbox"><SectionHeader eyebrow="Рабочее место оператора" title="Диалоги: как не потерять обращение" icon={Inbox}>Трёхколоночный inbox объединяет очередь, переписку и карточку клиента.</SectionHeader><Screenshot src="/docs/inbox.png" alt="Раздел Диалоги BotCRM" caption="Слева — очередь, по центру — история и ответ, справа — клиент, сделка, переменные и задачи."/><h3 className="docs-subtitle">Список диалогов</h3><div className="docs-feature-list">{[["Все","Полная текущая выборка."],["Нужен оператор","Только режим HUMAN — бот остановлен."],["Непрочитанные","Разговоры с новыми входящими."],["Фильтры","Канал, бот и состояние видны вместе со списком."],["Сортировка","Новые, непрочитанные или имя."],["Закрыть диалог","Снимает выбор, не читая следующий случайно."]].map(([title,text])=><article key={title}><span><Check size={16}/></span><div><h3>{title}</h3><p>{text}</p></div></article>)}</div><h3 className="docs-subtitle">Непрочитанные</h3><p>Диалог читается, когда он открыт. Новые сообщения в уже открытом разговоре сразу считаются прочитанными. Без выбранного диалога счётчик сохраняется.</p><h3 className="docs-subtitle">BOT, HUMAN и PAUSED</h3><div className="docs-state-grid"><article><i className="bot"/><b>BOT</b><p>Отвечает бот. Для ответа человеком нажмите «Перехватить».</p></article><article><i className="human"/><b>HUMAN</b><p>Бот не получает входящие; работает оператор.</p></article><article><i className="paused"/><b>PAUSED</b><p>Автоответ запрещён, но разговор ещё не активен у оператора.</p></article></div><Callout title="Mirror требует сотрудничества бота" tone="warning" icon={AlertTriangle}>Бот, который пишет напрямую в канал, невозможно остановить извне. Он должен проверять <code>deliverToBot</code> и отправлять через BotCRM.</Callout><h3 className="docs-subtitle">Ответы и вложения</h3><CheckList items={["Enter отправляет, Shift+Enter переносит строку","Скрепка загружает файл через S3/MinIO","Есть emoji, аудио и быстрые ответы","Видны queued, sent, delivered, read и failed","Кнопка «К новым сообщениям» не сбивает чтение истории"]}/></section>

      <section className="docs-section" id="contacts"><SectionHeader eyebrow="CRM-карточка" title="Контакты: единый человек вместо набора ID" icon={ContactRound}>У одного контакта могут быть несколько каналов, разговоров и сделок.</SectionHeader><FeatureGrid items={[
        { icon: ContactRound, title: "Профиль", text: <p>Имя, телефон, email, город, аватар и channel identities.</p> }, { icon: Tag, title: "Теги и переменные", text: <p>Командные метки и значения от ботов.</p> }, { icon: FileText, title: "Заметки и задачи", text: <p>Внутренний контекст не отправляется клиенту.</p> }, { icon: RefreshCw, title: "Объединение", text: <p>Склеивайте только подтверждённые дубли, не людей с похожим именем.</p> },
      ]}/><h3 className="docs-subtitle">Создание и редактирование</h3><p>«+ Контакт» создаёт ручную карточку с контактами, тегами и JSON-переменными. Обычно карточка появляется автоматически после первого события.</p><h3 className="docs-subtitle">Импорт и экспорт</h3><p>CSV/JSON переносит существующую базу. Экспорт доступен руководителю, администратору и владельцу. Используйте UTF‑8 и проверьте уникальность телефонов/email.</p><Callout title="Удаление означает обезличивание" icon={ShieldCheck}>OWNER/ADMIN очищает персональные поля и identities, отзывает маркетинговый статус и добавляет suppression, чтобы контакт не попал в рассылку.</Callout></section>
      <section className="docs-section" id="attributes"><SectionHeader eyebrow="Данные ботов" title="Переменные и динамические сегменты" icon={Tag}>Названия не зашиты в BotCRM. Бот может прислать <code>lead_score</code>, <code>plan</code>, <code>risk_level</code> или свой корректный ключ.</SectionHeader><div className="docs-compare"><article><span>Технический ключ</span><h3><code>lead_score</code></h3><p>Используется в API и не меняется после создания.</p></article><article><span>Понятное название</span><h3>Оценка интереса</h3><p>Показывается в интерфейсе и может меняться.</p></article></div><h3 className="docs-subtitle">Типы полей</h3><CheckList items={["Строка — тариф или источник","Число — балл, количество, сумма","Флаг — да/нет","Дата — оплата или окончание подписки","Enum / multiselect — варианты","Ссылка и JSON — технические данные"]}/><p>У определения есть область, тип, источник истины и возможность фильтрации. Удаление определения не стирает сохранённые значения.</p><h3 className="docs-subtitle">Динамические аудитории</h3><Steps items={[
        { title: "Откройте «Контакты → Сегменты»", text: <p>Например, создайте «Горячие лиды из Telegram».</p> }, { title: "Добавьте условия", text: <p>Канал = Telegram И Оценка интереса ≥ 80.</p> }, { title: "Проверьте аудиторию", text: <p>Система покажет всего, доступных и исключённых.</p> }, { title: "Используйте в рассылке", text: <p>Сегмент живой, а список фиксируется при запуске кампании.</p> },
      ]}/></section>

      <section className="docs-section" id="pipelines"><SectionHeader eyebrow="Продажи" title="Воронки и сделки" icon={Layers3}>Воронка показывает сделки, а не диалоги. Контакт может быть в inbox без карточки на доске, пока сделка не создана.</SectionHeader><Screenshot src="/docs/pipeline.png" alt="Канбан BotCRM" caption="Колонки — настраиваемые этапы; карточка показывает клиента, сумму и время на стадии."/><h3 className="docs-subtitle">Как создать этапы</h3><Steps items={[
        { title: "Откройте настройки воронки", text: <p>Нажмите настройку рядом с выбором текущей воронки.</p> }, { title: "Создайте воронку", text: <p>Например: «Продажи», «Поддержка», «Онбординг».</p> }, { title: "Добавьте стадии", text: <p>Укажите название, цвет и при необходимости финал WON/LOST.</p> }, { title: "Расставьте порядок", text: <p>Он определяет колонки и расчёт конверсии.</p> },
      ]}/><h3 className="docs-subtitle">Работа со сделкой</h3><p>Создайте сделку из доски или контакта, задайте название и сумму. Перетаскивание использует optimistic locking: конфликт не перезапишет чужое более свежее изменение.</p><Callout title="Профиль и доска читают одну сделку" icon={RefreshCw}>После перемещения realtime обновляет inbox и канбан. При нескольких сделках профиль показывает текущую связанную с диалогом.</Callout></section>

      <section className="docs-section" id="campaigns"><SectionHeader eyebrow="Коммуникации" title="Рассылки: от аудитории до результата" icon={Megaphone}>Кампания запускается после предпросмотра. Недоступные, отписавшиеся и suppression-контакты исключаются.</SectionHeader><Steps items={[
        { title: "Название и канал", text: <p>Контент и ограничения зависят от транспорта.</p> }, { title: "Сегмент", text: <p>Проверьте доступных и причины исключений.</p> }, { title: "Сообщение", text: <p>Вставляйте <code>{"{{"}first_name{"}}"}</code> через подсказку; токен выделяется и объясняется.</p> }, { title: "Медиа и кнопки", text: <p>Изображения и ряды callback/URL-кнопок проверяются по capabilities.</p> }, { title: "Тест", text: <p>Отправьте реальному контакту того же канала и проверьте подстановки.</p> }, { title: "Запуск", text: <p>Сейчас или по времени выбранной зоны с показом текущего времени.</p> },
      ]}/><h3 className="docs-subtitle">Состояния</h3><div className="docs-status-row"><span>Черновик</span><ArrowRight/><span>Запланирована</span><ArrowRight/><span>Выполняется</span><ArrowRight/><span>Завершена</span></div><p>Выполнение можно поставить на паузу и продолжить. Отмена прекращает ожидающие отправки. Временные ошибки повторяются, постоянные попадают в failed/suppression.</p><Callout title="Telegram и WhatsApp различаются" tone="warning" icon={AlertTriangle}>Telegram ограничивает скорость, поэтому очередь растягивает отправку. WhatsApp вне сервисного окна требует одобренный template.</Callout></section>

      <section className="docs-section" id="automations"><SectionHeader eyebrow="CRM-правила" title="Автоматизации: событие → условие → действие" icon={Workflow}>Это не сценарий бота. Правило реагирует на событие CRM: сообщение, изменение контакта или сделки, кампанию или неактивность.</SectionHeader><div className="docs-automation-flow"><article><Zap/><b>Событие</b><span>Пришло сообщение</span></article><ArrowRight/><article><Filter/><b>Условия</b><span>Оценка ≥ 80</span></article><ArrowRight/><article><Workflow/><b>Действия</b><span>Тег + стадия + задача</span></article></div><h3 className="docs-subtitle">Пример</h3><p>Выберите «Контакт обновлён», поле «Оценка интереса», оператор «≥», значение 80. Затем тег «Горячий», стадию «Квалификация» и задачу на 15 минут.</p><CodeBlock language="JSON API" code={automationExample}/><CheckList items={["Правило включается и выключается","Есть тест на выбранном контакте","Журнал показывает matched/skipped/completed/failed","maxDepth и event ID защищают от циклов","Webhook разрешён только доменам allowlist"]}/><Callout title="Отправка ботом блокируется в HUMAN" tone="warning">Оператор уже забрал разговор. Верните его в BOT либо осознанно отправляйте как оператор.</Callout></section>

      <section className="docs-section" id="integrations"><SectionHeader eyebrow="Администрирование" title="Боты и каналы" icon={Bot}>Бот — логический обработчик, connector — конкретный канал и credentials.</SectionHeader><div className="docs-state-grid"><article><i className="human"/><b>Подключено</b><p>Последняя проверка успешна.</p></article><article><i className="paused"/><b>Требует внимания</b><p>Таймаут, токен или неполная конфигурация.</p></article><article><i className="bot"/><b>Ожидает</b><p>Сохранён, но ещё не проверен.</p></article></div><Steps items={[
        { title: "Создайте бота у провайдера", text: <p>Например, Telegram через BotFather.</p> }, { title: "Выберите Gateway или Mirror", text: <p>Gateway отдаёт webhook BotCRM; Mirror оставляет transport у бота.</p> }, { title: "Укажите endpoint кода", text: <p>Туда приходят события и <code>control.returned</code>.</p> }, { title: "Заполните секреты", text: <p>После сохранения их можно только заменить.</p> }, { title: "Скопируйте webhook URL", text: <p>В Gateway зарегистрируйте его у провайдера.</p> }, { title: "Нажмите «Проверить»", text: <p>Health-check покажет конкретную ошибку.</p> },
      ]}/><Callout title="Только официальные API" icon={ShieldCheck}>Не используются WhatsApp Web-эмуляция, пользовательские аккаунты VK или обход Avito. Для Avito нужен официальный Messenger API.</Callout></section>

      <section className="docs-section" id="analytics"><SectionHeader eyebrow="Управление" title="Аналитика: что означают показатели" icon={BarChart3}>Данные считаются из реальных диалогов и сделок. Период 7/30/90 дней влияет на сводку и каналы.</SectionHeader><Screenshot src="/docs/analytics.png" alt="Аналитика BotCRM" caption="Наведение показывает точное значение столбца или этапа."/><div className="docs-metric-table"><div><b>Новые диалоги</b><span>Созданные за период.</span></div><div><b>Конверсия</b><span>Доля выигранных сделок.</span></div><div><b>Первый ответ</b><span>От входящего до исходящего.</span></div><div><b>Выручка</b><span>Сумма сделок WON.</span></div><div><b>Каналы</b><span>Только каналы с диалогами.</span></div><div><b>Воронка</b><span>Сделки и суммы по этапам.</span></div></div><Callout title="Пустой график — честный результат">Без сделок воронка показывает нули. Создайте и переместите сделку — realtime обновит данные.</Callout></section>

      <section className="docs-section" id="settings"><SectionHeader eyebrow="Безопасность команды" title="Настройки, роли и учётные записи" icon={Settings}>В self-hosted версии приглашение не отправляется email. OWNER/ADMIN создаёт пользователя и безопасно передаёт временный пароль.</SectionHeader><FeatureGrid items={[
        { icon: Users, title: "Участники", text: <p>Имя, email, роль и состояние доступа.</p> }, { icon: Boxes, title: "Команды", text: <p>Группы сотрудников отдельно от ролей.</p> }, { icon: KeyRound, title: "Service tokens", text: <p>Показываются полностью один раз, затем только отзываются.</p> }, { icon: ShieldCheck, title: "MFA и сессии", text: <p>TOTP и отзыв отдельных активных сессий.</p> },
      ]}/><Steps items={[
        { title: "Настройки → Участники", text: <p>Доступно OWNER/ADMIN.</p> }, { title: "Имя, email, временный пароль", text: <p>Не менее 12 символов; не отправляйте в общем чате.</p> }, { title: "Минимальная роль", text: <p>Оператору не нужны настройки ботов или запуск кампаний.</p> }, { title: "Передача и MFA", text: <p>Пользователь входит и подтверждает TOTP шестизначным кодом.</p> },
      ]}/></section>

      <section className="docs-section" id="recipes"><SectionHeader eyebrow="Примеры" title="Три рабочих сценария" icon={Sparkles}>Замените стадии, поля и сроки на свои процессы.</SectionHeader><div className="docs-recipe-grid"><article><span>01 · Поддержка</span><h3>Нужен человек</h3><ol><li>Бот ставит <code>needs_human=true</code>.</li><li>Правило меняет режим на HUMAN.</li><li>Диалог попадает в «Нужен оператор».</li><li>Оператор отвечает и возвращает управление.</li></ol><b>Запрос не теряется в ленте.</b></article><article><span>02 · Продажа</span><h3>Горячий лид</h3><ol><li><code>lead_score=95</code>.</li><li>Добавляется тег «Горячий».</li><li>Сделка идёт в «Квалификация».</li><li>Задача менеджеру на 15 минут.</li></ol><b>Скорость не зависит от ручного просмотра.</b></article><article><span>03 · Возврат</span><h3>30 дней без активности</h3><ol><li>Сегмент выбирает доступных.</li><li>Кампания подставляет имя.</li><li>Кнопка ведёт на предложение.</li><li>Ответ открывает диалог.</li></ol><b>Видны доставка и ответы.</b></article></div></section>

      <section className="docs-section docs-developer-start" id="dev-overview"><SectionHeader eyebrow="Техническая документация" title="BotCRM между каналом и вашим кодом" icon={GitBranch}>Платформа не заменяет бизнес-логику: нормализует transport, хранит историю, управляет перехватом и ставит отправки в очередь.</SectionHeader><div className="docs-compare"><article><span>Новый проект</span><h3>Gateway</h3><p>Webhook канала указывает на BotCRM. Платформа проверяет, сохраняет и вызывает endpoint бота только в BOT.</p><ul><li>полный контроль;</li><li>единая доставка;</li><li>рекомендуется.</li></ul></article><article><span>Работающий проект</span><h3>Mirror / SDK</h3><p>Бот принимает update сам, копирует входящие в <code>/events</code> и отвечает через <code>/messages/send</code>.</p><ul><li>минимум изменений;</li><li>постепенная миграция;</li><li>нужен deliverToBot.</li></ul></article></div><div className="docs-flow"><span>Пользователь</span><ChevronRight/><b>Канал</b><ChevronRight/><b>BotCRM / transport</b><ChevronRight/><span>Ваш обработчик</span><ChevronRight/><b>Queue</b><ChevronRight/><span>Ответ</span></div></section>

      <section className="docs-section" id="first-bot"><SectionHeader eyebrow="Практика" title="Первый Telegram-бот с BotCRM" icon={Code2}>Он отвечает на <code>/price</code>, создаёт CRM-данные и прекращает отвечать после перехвата. Выберите язык.</SectionHeader><Steps items={[
        { title: "Создайте бота в BotFather", text: <p>Получите <code>TELEGRAM_BOT_TOKEN</code>. Для этого примера не ставьте webhook — используется polling.</p> }, { title: "Создайте Mirror-коннектор", text: <p>Telegram → Mirror / SDK, имя, slug и token.</p> }, { title: "Создайте service token", text: <p>Настройки → Сервисные токены. Скопируйте сразу.</p> }, { title: "Настройте окружение", text: <CodeBlock language=".env" code={`TELEGRAM_BOT_TOKEN=123456:telegram-secret\nBOTCRM_URL=https://crm.example.ru\nBOTCRM_WORKSPACE_ID=ws_demo\nBOTCRM_BOT_ID=sales_assistant\nBOTCRM_SERVICE_TOKEN=botcrm-service-secret`}/> }, { title: "Проверьте перехват", text: <p>Отправьте <code>/price</code>, заберите диалог и отправьте ещё сообщение: бот не должен ответить.</p> },
      ]}/><LanguageExample/><Callout title="Повторяйте с тем же ключом" tone="warning" icon={AlertTriangle}>При сетевом retry используйте прежний <code>event_id</code> или <code>Idempotency-Key</code>. Новый ключ создаст новое сообщение.</Callout></section>      <section className="docs-section" id="connector-setup">
        <SectionHeader eyebrow="Каналы" title="Настройка коннектора" icon={Boxes}>Секреты шифруются и после сохранения не показываются. Endpoint — адрес вашего кода, webhook URL — адрес BotCRM для провайдера канала.</SectionHeader>
        <div className="docs-table-wrap"><table className="docs-table"><thead><tr><th>Канал</th><th>Обязательные поля</th><th>Что проверить</th></tr></thead><tbody>
          <tr><td>Telegram</td><td><code>botToken</code>, <code>webhookSecret</code></td><td>Токен от BotFather; HTTPS webhook в Gateway.</td></tr>
          <tr><td>VK</td><td><code>accessToken</code>, API 5.199, confirmation secret/code</td><td>Callback API сообщества и подтверждение сервера.</td></tr>
          <tr><td>WhatsApp Cloud</td><td><code>accessToken</code>, <code>phoneNumberId</code>, app secret, verify token</td><td>Webhook Meta, подписка messages, одобренные templates.</td></tr>
          <tr><td>Avito</td><td><code>accessToken</code>, <code>accountId</code>, outbound URL, signing secret</td><td>Официальный доступ Messenger API.</td></tr>
          <tr><td>Generic REST</td><td>outbound URL, signing secret</td><td>Ваш endpoint принимает нормализованные события.</td></tr>
        </tbody></table></div>
        <FeatureGrid columns={2} items={[
          { icon: Globe2, title: "Gateway", text: <p>Зарегистрируйте показанный BotCRM webhook у провайдера. Endpoint вашего бота получает уже проверенные события.</p> },
          { icon: GitBranch, title: "Mirror / SDK", text: <p>Ваш бот сохраняет polling/webhook, но копирует события в API и соблюдает <code>deliverToBot</code>.</p> },
        ]}/>
        <Callout title="Локальный адрес недоступен Telegram" tone="warning" icon={AlertTriangle}><code>localhost</code> работает только на вашем ПК. Для Gateway нужен публичный HTTPS-домен; для локальной проверки используйте Mirror/polling.</Callout>
      </section>

      <section className="docs-section" id="auth-api">
        <SectionHeader eyebrow="REST API" title="Адреса, авторизация и workspace" icon={KeyRound}>В production используйте тот же публичный домен, что и панель. Reverse proxy направляет <code>/api/*</code> в API, поэтому отдельный открытый порт не нужен.</SectionHeader>
        <CodeBlock language="HTTP" code={`POST https://crm.example.ru/api/v1/events
Authorization: Bearer <service-token>
X-Service-Token: <service-token>
X-Workspace-Id: ws_demo
Idempotency-Key: telegram:482991204
Content-Type: application/json`}/>
        <div className="docs-field-list">
          <article><code>Authorization</code><p>Bearer service token. Заголовок <code>X-Service-Token</code> поддерживается для SDK и внутренних интеграций.</p></article>
          <article><code>X-Workspace-Id</code><p>Обязательная граница данных. Токен также привязан к workspace; несовпадение отклоняется.</p></article>
          <article><code>Idempotency-Key</code><p>Стабильный ключ операции. Повтор того же запроса не создаёт вторую отправку.</p></article>
          <article><code>Cookie session</code><p>Только для браузерной панели. Не копируйте пользовательские cookies в бот.</p></article>
        </div>
        <Callout title="Service token показывается один раз" icon={LockKeyhole}>Создайте его в «Настройки → Сервисные токены», сохраните в secret manager и отзовите при утечке. Не помещайте токен в frontend, git или лог.</Callout>
      </section>

      <section className="docs-section" id="events-api">
        <SectionHeader eyebrow="Контракт" title="Входящие события" icon={Webhook}>Mirror-бот отправляет событие в <code>POST /api/v1/events</code>. Gateway создаёт тот же объект автоматически после проверки канального webhook.</SectionHeader>
        <CodeBlock language="JSON" code={normalizedEventExample}/>
        <h3 className="docs-subtitle">Ответ платформы</h3><CodeBlock language="JSON" code={acceptedEventExample}/>
        <div className="docs-field-list">
          <article><code>event_id</code><p>Глобально стабильный ID исходного update. При retry не меняется.</p></article>
          <article><code>occurred_at</code><p>Время у источника в ISO 8601 UTC. Оно определяет порядок сообщений.</p></article>
          <article><code>external_chat_id</code><p>Диалог у канала; не путать с внутренним UUID conversation.</p></article>
          <article><code>profile</code><p>Имя, username, телефон, email, город и avatar. Передавайте только известные данные.</p></article>
          <article><code>attributes</code><p>Произвольные типизированные данные. Новые ключи появляются в реестре переменных.</p></article>
          <article><code>deliverToBot</code><p><b>false</b> означает HUMAN/PAUSED: сохраните событие, но не запускайте ответ бота.</p></article>
        </div>
        <Callout title="Поддерживаемые типы">Основные: <code>message.received</code>, <code>message.sent</code>, <code>button.clicked</code>, статусы доставки и <code>control.returned</code>. Неизвестный raw payload сохраняйте только для диагностики и с ограниченным retention.</Callout>
      </section>

      <section className="docs-section" id="messages-api">
        <SectionHeader eyebrow="Исходящие" title="Сообщения, вложения и статусы" icon={Send}>Бот и оператор отправляют через один API, чтобы история, ограничения канала и delivery status не расходились.</SectionHeader>
        <CodeBlock language="HTTP + JSON" code={sendMessageExample}/>
        <h3 className="docs-subtitle">Загрузка медиа</h3><CodeBlock language="HTTP" code={mediaUploadExample}/>
        <Steps items={[
          { title: "Создать upload", text: <p>Передайте имя, MIME и размер; получите upload URL/id.</p> },
          { title: "Загрузить байты", text: <p>Отправьте файл по выданному URL, не кодируйте большое изображение в JSON.</p> },
          { title: "Подтвердить", text: <p><code>POST /media/uploads/:id/complete</code> проверит объект.</p> },
          { title: "Отправить attachment id", text: <p>Добавьте его в message. Worker адаптирует формат канала.</p> },
        ]}/>
        <div className="docs-status-row"><span>queued</span><ArrowRight/><span>sent</span><ArrowRight/><span>delivered</span><ArrowRight/><span>read</span></div>
        <p>Не каждый канал присылает delivered/read. UI показывает только реально поддерживаемый уровень. <code>failed</code> содержит безопасную причину и признак временной ошибки.</p>
        <div className="docs-table-wrap"><table className="docs-table"><thead><tr><th>Канал</th><th>Максимальный подтверждаемый статус</th></tr></thead><tbody>
          <tr><td>Telegram Bot API</td><td><code>sent</code> — API ботов не сообщает, прочитал ли пользователь сообщение.</td></tr>
          <tr><td>VK Community</td><td><code>sent</code> в текущем нативном адаптере.</td></tr>
          <tr><td>WhatsApp Cloud API</td><td><code>delivered</code> и <code>read</code> из подписанного webhook Meta.</td></tr>
          <tr><td>Avito Messenger</td><td><code>sent</code> в текущем нативном адаптере.</td></tr>
          <tr><td>Custom API / SDK</td><td>До <code>read</code>, если интеграция отправляет событие <code>message.status</code> с внешним ID сообщения.</td></tr>
        </tbody></table></div>
      </section>

      <section className="docs-section" id="control-api">
        <SectionHeader eyebrow="Перехват" title="BOT, HUMAN и PAUSED без гонок" icon={UserCog}>Состояние меняется атомарно. Передавайте последнюю версию conversation: два оператора не смогут незаметно перезаписать друг друга.</SectionHeader>
        <CodeBlock language="HTTP" code={`GET /api/v1/conversations/{conversationId}/control

PATCH /api/v1/conversations/{conversationId}/control
Content-Type: application/json

{
  "mode": "HUMAN",
  "expectedVersion": 7,
  "reason": "operator_claim"
}`}/>
        <div className="docs-state-grid"><article><i className="bot"/><b>BOT</b><p>События доставляются endpoint бота.</p></article><article><i className="human"/><b>HUMAN</b><p>Отвечает оператор; бот получает <code>deliverToBot=false</code>.</p></article><article><i className="paused"/><b>PAUSED</b><p>Автоматические ответы приостановлены.</p></article></div>
        <Callout title="Возврат управления" icon={RefreshCw}>После HUMAN → BOT платформа создаёт <code>control.returned</code>. Бот может восстановить контекст, но не должен повторять старый ответ.</Callout>
      </section>
      <section className="docs-section" id="callbacks">
        <SectionHeader eyebrow="Исходящий webhook" title="Проверка подписи до разбора JSON" icon={ShieldCheck}>BotCRM вызывает endpoint бота подписанным POST. Проверяйте HMAC по исходным байтам body, затем timestamp и только после этого JSON.</SectionHeader>
        <CodeBlock language="TypeScript / Fastify" code={webhookVerificationTs}/>
        <div className="docs-table-wrap"><table className="docs-table"><thead><tr><th>Заголовок</th><th>Назначение</th></tr></thead><tbody>
          <tr><td><code>x-botcrm-event-id</code></td><td>Стабильный ID бизнес-события.</td></tr>
          <tr><td><code>x-botcrm-delivery-id</code></td><td>ID конкретной попытки доставки.</td></tr>
          <tr><td><code>x-botcrm-timestamp</code></td><td>Unix timestamp; отклоняйте слишком старые запросы.</td></tr>
          <tr><td><code>x-botcrm-signature</code></td><td><code>sha256=HMAC_SHA256(rawBody, signingSecret)</code>.</td></tr>
        </tbody></table></div>
        <Callout title="Сначала ACK, затем тяжёлая работа" icon={Zap}>Верните 2xx после безопасной постановки события в свою очередь. Долгая обработка приводит к timeout и повторной доставке.</Callout>
      </section>

      <section className="docs-section" id="reliability">
        <SectionHeader eyebrow="Production-контракт" title="Повторы, порядок, 429 и ошибки" icon={RefreshCw}>Сеть не гарантирует ровно одну доставку. Корректная интеграция должна быть безопасна при at-least-once.</SectionHeader>
        <div className="docs-table-wrap"><table className="docs-table"><thead><tr><th>Ситуация</th><th>Поведение интеграции</th></tr></thead><tbody>
          <tr><td>Повтор входящего webhook</td><td>Тот же <code>event_id</code>; API вернёт <code>duplicate: true</code>.</td></tr>
          <tr><td>Повтор отправки</td><td>Тот же <code>Idempotency-Key</code>; не генерировать его заново при retry.</td></tr>
          <tr><td>HTTP 429</td><td>Ждать <code>Retry-After</code>, не крутить цикл немедленно.</td></tr>
          <tr><td>HTTP 5xx / timeout</td><td>Exponential backoff с jitter и ограничением попыток.</td></tr>
          <tr><td>Обычный HTTP 4xx</td><td>Постоянная ошибка: исправить payload/доступ, не повторять бесконечно.</td></tr>
          <tr><td>События пришли не по порядку</td><td>Сортировать сообщения по <code>occurred_at</code> и стабильному sequence/id.</td></tr>
          <tr><td>Endpoint недоступен</td><td>После попыток запись попадает в DLQ и видна в журнале.</td></tr>
        </tbody></table></div>
        <CheckList items={["У события стабильный внешний ID","У отправки стабильный idempotency key","Секреты ротируются без простоя","Логи не содержат токены и raw персональные данные","Есть timeout и ограничение размера body","Метрики различают temporary/permanent failure"]}/>
      </section>

      <section className="docs-section" id="channels">
        <SectionHeader eyebrow="Capabilities" title="Разные каналы — разные возможности" icon={Globe2}>Перед показом кнопок и форматов проверяйте capabilities коннектора. Платформа блокирует неподдерживаемые действия, но код бота тоже не должен их предполагать.</SectionHeader>
        <div className="docs-table-wrap"><table className="docs-table"><thead><tr><th>Канал</th><th>Сильные стороны</th><th>Ограничения, которые важно учесть</th></tr></thead><tbody>
          <tr><td>Telegram Bot API</td><td>Текст, медиа, inline-кнопки, reply, edit/delete</td><td>Лимиты на чат и массовую отправку; бот не пишет первым произвольному человеку.</td></tr>
          <tr><td>VK Community</td><td>Сообщения сообщества, вложения, клавиатура</td><td>Нужны права сообщества, confirmation и актуальная версия API.</td></tr>
          <tr><td>WhatsApp Cloud</td><td>Телефонная identity, статусы доставки, templates</td><td>Вне сервисного окна — только одобренный шаблон; ограничения бизнеса Meta.</td></tr>
          <tr><td>Avito Messenger</td><td>Переписка по объявлениям</td><td>Только аккаунты с официально выданным API-доступом.</td></tr>
          <tr><td>Generic</td><td>Любой сайт, приложение или собственный transport</td><td>Delivery/read/edit доступны только если их реализует ваш адаптер.</td></tr>
        </tbody></table></div>
        <Callout title="Один контакт, несколько identity">Telegram ID, VK ID и телефон WhatsApp не объединяются по похожему имени. Автослияние допустимо только по подтверждённому телефону/email или вашему устойчивому external ID.</Callout>
      </section>

      <section className="docs-section" id="automation-reference">
        <SectionHeader eyebrow="Справочник" title="Автоматизации: все поддерживаемые элементы" icon={Workflow}>Названия в UI переведены, а API использует стабильные технические ключи.</SectionHeader>
        <h3 className="docs-subtitle">Триггеры</h3><div className="docs-token-cloud">
          {['message.received','message.sent','contact.updated','conversation.created','deal.created','deal.stage_changed','button.clicked','conversation.inactive','campaign.delivered','campaign.failed'].map((value)=><code key={value}>{value}</code>)}
        </div>
        <h3 className="docs-subtitle">Операторы условий</h3><div className="docs-token-cloud">
          {['equals','not_equals','contains','not_contains','gt','gte','lt','lte','exists','not_exists','in'].map((value)=><code key={value}>{value}</code>)}
        </div>
        <h3 className="docs-subtitle">Действия</h3><div className="docs-token-cloud">
          {['set_attribute','add_tag','move_deal','assign_user','create_task','set_control','send_message','webhook','suppress_contact'].map((value)=><code key={value}>{value}</code>)}
        </div>
        <p>Правило принимает до 20 условий и от 1 до 10 действий. <code>maxDepth</code> задаётся от 1 до 10. Внешний webhook разрешается только доменам из <code>AUTOMATION_WEBHOOK_ALLOWLIST</code> и подписывается <code>AUTOMATION_WEBHOOK_SECRET</code>.</p>
        <Callout title="Почему нужен allowlist" icon={ShieldCheck}>Без него правило могло бы обращаться к localhost, metadata cloud или внутренним сервисам. Allowlist ограничивает исходящие запросы заранее известными доменами.</Callout>
      </section>

      <section className="docs-section" id="role-matrix">
        <SectionHeader eyebrow="Доступ" title="Матрица ролей" icon={Users}>Выдавайте минимальную роль. Точное разрешение endpoint всегда проверяет backend; скрытая кнопка в UI не является защитой.</SectionHeader>
        <div className="docs-table-wrap"><table className="docs-table role-table"><thead><tr><th>Возможность</th><th>Владелец</th><th>Админ</th><th>Руководитель</th><th>Оператор</th></tr></thead><tbody>
          <tr><td>Диалоги и ответы</td><td>Да</td><td>Да</td><td>Да</td><td>Да</td></tr>
          <tr><td>Контакты, сделки, задачи</td><td>Да</td><td>Да</td><td>Да</td><td>По назначению</td></tr>
          <tr><td>Сегменты и просмотр аналитики</td><td>Да</td><td>Да</td><td>Да</td><td>Ограниченно</td></tr>
          <tr><td>Запуск рассылки и автоматизации</td><td>Да</td><td>Да</td><td>Да</td><td>Нет</td></tr>
          <tr><td>Каналы, пользователи, команды, service token</td><td>Да</td><td>Да</td><td>Нет</td><td>Нет</td></tr>
          <tr><td>Удаление workspace / передача владения</td><td>Да</td><td>Нет</td><td>Нет</td><td>Нет</td></tr>
        </tbody></table></div>
        <p className="docs-smallprint">Сервисный аккаунт не входит в интерфейс и получает только явно предусмотренный API-доступ через отзываемый токен.</p>
      </section>

      <section className="docs-section" id="api-map">
        <SectionHeader eyebrow="REST" title="Карта API" icon={Database}>Ниже — обзор групп. Полные request/response schemas и интерактивные запросы находятся в OpenAPI.</SectionHeader>
        <div className="docs-api-map">
          <article><b>Auth</b><code>/api/v1/auth/*</code><p>login, me, logout, MFA, sessions.</p></article>
          <article><b>Events</b><code>/api/v1/events</code><p>Нормализованные входящие события.</p></article>
          <article><b>Messages</b><code>/api/v1/messages/send</code><p>Текст, buttons, media и idempotency.</p></article>
          <article><b>Contacts</b><code>/api/v1/contacts/*</code><p>upsert, поля, tags, import/export, merge.</p></article>
          <article><b>Conversations</b><code>/api/v1/conversations/*</code><p>read, control, notes и tasks.</p></article>
          <article><b>CRM</b><code>/api/v1/pipelines/*</code><p>pipelines, stages, deals.</p></article>
          <article><b>Audience</b><code>/api/v1/segments/*</code><p>Фильтры, preview и сохранение.</p></article>
          <article><b>Campaigns</b><code>/api/v1/campaigns/*</code><p>draft, test, schedule, pause, results.</p></article>
          <article><b>Automations</b><code>/api/v1/automations/*</code><p>rules, test и runs.</p></article>
          <article><b>Administration</b><code>/api/v1/admin/*</code><p>users, teams, service tokens.</p></article>
          <article><b>Operations</b><code>/health</code><p>Liveness/readiness и connector health.</p></article>
          <article><b>OpenAPI</b><code>/api-docs</code><p>Интерактивная схема текущей версии.</p></article>
        </div>
        <div className="docs-cta-row"><Link className="docs-primary-link" href="/api-docs" target="_blank">Открыть Swagger <ExternalLink/></Link><a className="docs-secondary-link" href="#first-bot">Вернуться к первому боту</a></div>
      </section>
      <section className="docs-section" id="production">
        <SectionHeader eyebrow="Self-hosted" title="Установка на сервер и собственный домен" icon={Terminal}>Production-compose поднимает web, API, worker, PostgreSQL, Redis, MinIO и Caddy. Снаружи открыты только 80/443; TLS получает Caddy.</SectionHeader>
        <h3 className="docs-subtitle">Что понадобится</h3><CheckList items={["VPS с Linux x86_64, минимум 4 vCPU / 8 GB RAM для комфортного старта","Docker Engine 27+ и Compose plugin","Два DNS-имени: CRM и закрытое S3-хранилище медиа","Открытые TCP 80/443 и UDP 443; PostgreSQL/Redis/MinIO не публикуются","SMTP не обязателен: участников создаёт OWNER/ADMIN"]}/>
        <Steps items={[
          { title: "Создайте DNS", text: <p>A/AAAA для <code>crm.example.ru</code> и <code>media.crm.example.ru</code> должны указывать на сервер до первого запуска.</p> },
          { title: "Скачайте проект и сгенерируйте конфигурацию", text: <CodeBlock language="bash" code={`git clone <your-repository-url> botcrm
cd botcrm
npm ci
npm run prod:init -- --domain crm.example.ru --storage-domain media.crm.example.ru --email owner@example.ru --owner-name "Иван" --workspace-name "Моя команда" --timezone Europe/Moscow`}/> },
          { title: "Заполните .env.production", text: <p>Домены, email ACME, workspace, timezone и независимые длинные секреты. Не переносите dev-пароль.</p> },
          { title: "Проверьте compose", text: <CodeBlock language="bash" code={`npm run prod:check
npm run prod:config`}/> },
          { title: "Соберите и запустите", text: <CodeBlock language="bash" code={`npm run prod:up
npm run prod:ps
npm run prod:logs`}/> },
          { title: "Проверьте снаружи", text: <p>Откройте <code>https://crm.example.ru</code>, <code>/docs</code>, <code>/api-docs</code> и <code>/api/v1/health</code>. Затем войдите владельцем и включите MFA.</p> },
        ]}/>
        <h3 className="docs-subtitle">Критические переменные</h3><div className="docs-field-list">
          <article><code>BOTCRM_DOMAIN</code><p>Публичный домен панели и API.</p></article><article><code>BOTCRM_STORAGE_DOMAIN</code><p>Отдельный HTTPS host для медиа.</p></article><article><code>BOOTSTRAP_OWNER_*</code><p>Первый владелец; пароль минимум 16 случайных символов.</p></article><article><code>MASTER_ENCRYPTION_KEY</code><p>Шифрует credentials каналов. Потеря ключа делает их нечитаемыми.</p></article><article><code>POSTGRES/REDIS/MINIO</code><p>Независимые секреты внутренних сервисов.</p></article><article><code>TRUST_PROXY=true</code><p>Корректный HTTPS, IP и secure cookies за Caddy.</p></article>
        </div>
        <Callout title="Не публикуйте внутренние порты" tone="danger" icon={LockKeyhole}>Не добавляйте наружу 5432, 6379, 9000 и служебные порты API/worker. Доступ к приложению идёт через Caddy и backend network.</Callout>
      </section>

      <section className="docs-section" id="operations">
        <SectionHeader eyebrow="Эксплуатация" title="Обновления, backup и восстановление" icon={Database}>Резервная копия считается рабочей только после тестового восстановления. Перед каждым обновлением сохраните PostgreSQL, S3 и файл production-конфигурации.</SectionHeader>
        <div className="docs-compare"><article><span>Ежедневно</span><h3>Резервная копия</h3><CodeBlock language="bash" code={`npm run prod:backup`}/><p>Скопируйте архив за пределы VPS и зашифруйте его отдельным ключом.</p></article><article><span>Регулярная проверка</span><h3>Восстановление</h3><CodeBlock language="bash" code={`npm run prod:restore -- --from <backup-directory>`}/><p>Сначала проводите drill на отдельном сервере/volume, не поверх production.</p></article></div>
        <h3 className="docs-subtitle">Безопасное обновление</h3><Steps items={[
          { title: "Прочитайте release notes", text: <p>Особенно migrations, новые переменные и изменения channel adapters.</p> },
          { title: "Сделайте backup", text: <p>База, object storage, <code>.env.production</code> и master encryption key.</p> },
          { title: "Получите версию и проверьте config", text: <CodeBlock language="bash" code={`git pull --ff-only
npm run prod:check
npm run prod:config`}/> },
          { title: "Запустите миграции и сервисы", text: <CodeBlock language="bash" code={`npm run prod:migrate
npm run prod:up`}/> },
          { title: "Smoke test", text: <p>Вход, входящее/исходящее сообщение, realtime, upload, тест кампании и connector health.</p> },
        ]}/>
        <h3 className="docs-subtitle">Что мониторить</h3><div className="docs-metric-table"><div><b>Health</b><span>web, API, PostgreSQL, Redis, MinIO.</span></div><div><b>Queues</b><span>глубина, oldest job, DLQ.</span></div><div><b>Channels</b><span>token expiry, 401/403/429, latency.</span></div><div><b>Resources</b><span>disk, RAM, CPU, inode и object storage.</span></div><div><b>Security</b><span>login throttling, audit, MFA, revoked sessions.</span></div><div><b>Backups</b><span>возраст последнего и результат restore drill.</span></div></div>
        <Callout title="Минимальная аварийная последовательность" tone="warning" icon={AlertTriangle}>Остановите источник повреждения, сохраните логи и текущее состояние, поднимите чистые volumes, восстановите последнюю проверенную копию, смените скомпрометированные токены и только потом верните DNS/трафик.</Callout>
      </section>
      <section className="docs-section" id="troubleshooting">
        <SectionHeader eyebrow="Диагностика" title="Проблемы и точные проверки" icon={LifeBuoy}>Начинайте со статуса коннектора, журнала доставки и health-check. Не меняйте сразу несколько настроек: иначе теряется причина.</SectionHeader>
        <div className="docs-troubleshooting">
          <details open><summary>Сообщение появилось в Telegram, но не в BotCRM</summary><ol><li>Проверьте, запущен ли Mirror-процесс или установлен ли Gateway webhook.</li><li>Посмотрите connector health и срок токена.</li><li>Проверьте, что <code>event_id</code>, chat/user id и workspace заполнены.</li><li>Для Gateway убедитесь, что домен доступен по HTTPS извне.</li></ol></details>
          <details><summary>BotCRM принял сообщение, но бот не ответил</summary><ol><li>Посмотрите <code>deliverToBot</code>: при HUMAN/PAUSED он false.</li><li>Проверьте endpoint и его TLS-сертификат.</li><li>Убедитесь, что endpoint вернул 2xx до timeout.</li><li>Проверьте DLQ и логи worker по event/delivery id.</li></ol></details>
          <details><summary>Бот отвечает одновременно с оператором</summary><ol><li>Исходящие бота должны идти через <code>/messages/send</code>.</li><li>Mirror-код обязан читать <code>deliverToBot</code> до бизнес-логики.</li><li>Не отправляйте в Telegram напрямую после того, как событие уже передано BotCRM.</li></ol></details>
          <details><summary>Появились одинаковые сообщения</summary><ol><li>На retry используйте прежний <code>event_id</code>.</li><li>Для отправки сохраняйте прежний <code>Idempotency-Key</code>.</li><li>Не запускайте параллельно две копии polling без распределённой блокировки.</li></ol></details>
          <details><summary>Медиа даёт Internal server error</summary><ol><li>Проверьте MIME, размер и разрешённый формат канала.</li><li>Завершите upload через <code>/complete</code> перед отправкой.</li><li>Проверьте доступ API и worker к S3/MinIO.</li><li>Посмотрите статус attachment — файл мог не загрузиться полностью.</li></ol></details>
          <details><summary>Переменная в рассылке не подставилась</summary><ol><li>Вставьте токен из подсказки, не набирайте имя по памяти.</li><li>Проверьте область поля: contact/bot/deal/conversation.</li><li>Откройте preview получателей: там видны пропущенные значения.</li><li>Задайте fallback либо исключите контакт фильтром exists.</li></ol></details>
          <details><summary>Webhook автоматизации заблокирован</summary><ol><li>Добавьте только нужный hostname в <code>AUTOMATION_WEBHOOK_ALLOWLIST</code>.</li><li>Используйте публичный HTTPS URL.</li><li>Задайте <code>AUTOMATION_WEBHOOK_SECRET</code> и проверяйте подпись у получателя.</li><li>Не разрешайте широкие wildcard и внутренние адреса.</li></ol></details>
          <details><summary>После деплоя вход или realtime не работают</summary><ol><li>Проверьте <code>APP_URL</code>, <code>NEXT_PUBLIC_API_URL</code>, trusted proxy и HTTPS.</li><li>Убедитесь, что reverse proxy передаёт cookies и upgrade/streaming.</li><li>Проверьте CORS/cookie domain, если UI и API всё же на разных доменах.</li><li>Синхронизируйте время сервера — оно нужно сессиям и webhook signatures.</li></ol></details>
        </div>
      </section>

      <section className="docs-section" id="glossary">
        <SectionHeader eyebrow="Термины" title="Короткий словарь BotCRM" icon={CircleHelp}>Одинаковые слова используются в панели, API и журналах.</SectionHeader>
        <dl className="docs-glossary">
          <div><dt>Workspace</dt><dd>Изолированное рабочее пространство команды.</dd></div>
          <div><dt>Bot</dt><dd>Ваша бизнес-логика и её логический идентификатор.</dd></div>
          <div><dt>Connector</dt><dd>Настроенное подключение транспорта с credentials и capabilities.</dd></div>
          <div><dt>Contact</dt><dd>Человек, объединяющий подтверждённые identity разных каналов.</dd></div>
          <div><dt>Channel identity</dt><dd>Telegram/VK ID, WhatsApp phone или другой внешний идентификатор.</dd></div>
          <div><dt>Conversation</dt><dd>Конкретная переписка контакта с ботом/каналом.</dd></div>
          <div><dt>Deal</dt><dd>Коммерческий или процессный объект на этапе pipeline.</dd></div>
          <div><dt>Attribute</dt><dd>Типизированная переменная контакта, диалога, сделки или связи с ботом.</dd></div>
          <div><dt>Segment</dt><dd>Сохранённый динамический фильтр аудитории.</dd></div>
          <div><dt>Campaign</dt><dd>Управляемая массовая отправка с очередью и результатами.</dd></div>
          <div><dt>Suppression</dt><dd>Запрет отправки контакту/identity по отписке или постоянной ошибке.</dd></div>
          <div><dt>Idempotency</dt><dd>Гарантия, что безопасный повтор операции не создаёт дубль.</dd></div>
          <div><dt>DLQ</dt><dd>Очередь событий, которые не удалось доставить после повторов.</dd></div>
          <div><dt>Capability</dt><dd>Заявленная возможность канала: кнопки, edit, read status и т. п.</dd></div>
        </dl>
      </section>

      <section className="docs-finish">
        <div><span>Документация соответствует текущей реализации</span><h2>Начните с одного реального диалога</h2><p>Подключите тестового бота, отправьте событие, перехватите разговор и верните управление. Это проверит transport, realtime, права и очередь одной короткой цепочкой.</p></div>
        <div className="docs-finish-actions"><Link href="/#integrations">Открыть «Боты и каналы» <ArrowRight/></Link><a href="#first-bot">Посмотреть код</a></div>
      </section>

      <footer className="docs-footer"><span>BotCRM Documentation</span><span>Пользовательская и техническая справка</span><a href="https://github.com/Evgenykravchenko/botcrm" target="_blank" rel="noreferrer">Исходный код</a><a href="https://github.com/Evgenykravchenko/botcrm/blob/main/LICENSE" target="_blank" rel="noreferrer">AGPL-3.0</a><Link href="/">В панель</Link></footer>
    </main>
  </div>;
}
