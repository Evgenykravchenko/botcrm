import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowRight, Bot, BriefcaseBusiness, Check, CheckCircle2, ChevronDown, CircleUserRound, Code2,
  Columns3, Database, Gauge, Inbox, LockKeyhole, MessageCircle, MessagesSquare,
  Radio, Search, Send, Server, ShieldCheck, SlidersHorizontal, UserRoundCheck,
  Webhook, Workflow,
} from "lucide-react";
import { LandingAnalytics } from "./landing-analytics";
import styles from "./landing.module.css";

export const metadata: Metadata = {
  title: "BotCRM — CRM для Telegram-ботов и самописных ботов",
  description: "Единая панель для диалогов, клиентов и сделок из Telegram и других каналов. Подключайте самописных ботов, передавайте чат оператору, ведите воронку и запускайте рассылки.",
  keywords: ["CRM для Telegram бота", "CRM для чат-ботов", "панель управления ботами", "единый чат для ботов", "канбан для лидов Telegram", "рассылки пользователям бота", "подключить самописного бота к CRM", "омниканальная CRM"],
  robots: { index: true, follow: true },
  alternates: { canonical: "/landing" },
  openGraph: {
    type: "website",
    locale: "ru_RU",
    title: "BotCRM — клиенты и продажи ваших ботов в одной панели",
    description: "Подключите существующих ботов без переноса логики. Диалоги, операторский перехват, CRM-профили, воронки, рассылки и автоматизации.",
    images: [{ url: "/og.png", width: 1731, height: 909, alt: "BotCRM — CRM-панель для самописных ботов" }],
  },
};

const faq = [
  { question: "Нужно ли переписывать уже работающего бота?", answer: "Нет. В mirror-режиме бот продолжает получать сообщения как раньше и передаёт их копии в BotCRM через REST API или SDK. Если нужен полный контроль над ответами и надёжный перехват оператором, канал можно направить через gateway BotCRM." },
  { question: "Можно ли подключить несколько ботов и проектов?", answer: "Да. В одном рабочем пространстве можно подключить несколько ботов, каналов и воронок. Диалоги фильтруются по боту, каналу, ответственному, стадии, тегам и пользовательским полям." },
  { question: "Что происходит, когда клиенту нужен человек?", answer: "Оператор забирает диалог одной кнопкой. Для совместимого бота новые события приостанавливаются, а команда отвечает из общей панели. После решения вопроса управление можно вернуть боту отдельным событием." },
  { question: "Где хранятся переменные и данные клиента?", answer: "Карточка контакта, идентификаторы каналов и нужные для работы переменные синхронизируются в PostgreSQL BotCRM. Вы сами управляете сервером, резервными копиями и сроками хранения." },
  { question: "Есть ли сегменты и рассылки?", answer: "Да. Можно собрать аудиторию по каналу, тегам, статусу подписки и пользовательским полям, проверить получателей, отправить тест и запустить рассылку по расписанию. Очередь учитывает ограничения каналов и исключает отписавшихся." },
  { question: "Какие каналы можно подключить?", answer: "Архитектура рассчитана на Telegram Bot API, VK Community Messages, WhatsApp Cloud API, Avito Messenger API при официальном доступе и любой собственный транспорт через универсальный REST/webhook-коннектор." },
];

const jsonLd = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",  name: "BotCRM",
  applicationCategory: "BusinessApplication",
  operatingSystem: "Web",
  description: "Self-hosted CRM-панель для управления диалогами, контактами, сделками и рассылками самописных ботов.",
  featureList: ["Единый inbox для ботов", "Перехват диалога оператором", "CRM-профили и пользовательские поля", "Канбан-воронки", "Сегменты и рассылки", "REST API и SDK"],
};

const faqLd = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: faq.map((item) => ({ "@type": "Question", name: item.question, acceptedAnswer: { "@type": "Answer", text: item.answer } })),
};

function Brand() {
  return (
    <a className={styles.brand} href="/landing" aria-label="BotCRM — главная">
      <span className={styles.brandMark}><MessageCircle size={20} strokeWidth={2.3} /></span>
      <span><b>BotCRM</b><small>CONTROL CENTER</small></span>
    </a>
  );
}

function ProductPreview() {
  return (
    <div className={styles.previewFrame} aria-label="Пример интерфейса BotCRM">
      <div className={styles.previewTop}>
        <span className={styles.previewDots}><i /><i /><i /></span>
        <span>Диалоги</span>
        <span className={styles.previewLive}><Radio size={11} /> realtime</span>
      </div>
      <div className={styles.previewBody}>
        <aside className={styles.previewRail}>
          <span className={styles.miniLogo}><MessageCircle size={14} /></span>
          <span className={styles.railActive}><Inbox size={15} /></span>
          <span><CircleUserRound size={15} /></span><span><Columns3 size={15} /></span><span><Send size={15} /></span>        </aside>
        <section className={styles.previewList}>
          <div className={styles.previewSearch}><Search size={12} /> Поиск</div>
          <div className={styles.previewFilter}><b>Все диалоги</b><span>Требуют оператора · 2</span></div>
          <div className={styles.chatItem}><span className={styles.avatarCoral}>А</span><span><b>Анна Волкова</b><small>Хочу уточнить по тарифу…</small></span><em>2</em></div>
          <div className={styles.chatItemActive}><span className={styles.avatarViolet}>М</span><span><b>Михаил Орлов</b><small>Нужен человек</small></span><i>сейчас</i></div>
          <div className={styles.chatItem}><span className={styles.avatarBlue}>Е</span><span><b>Елена</b><small>Бот отправил предложение</small></span><i>12:48</i></div>
        </section>
        <section className={styles.previewChat}>
          <header><span className={styles.avatarViolet}>М</span><span><b>Михаил Орлов</b><small>Telegram · Sales bot</small></span><button><Bot size={12} /> Отвечает бот</button></header>
          <div className={styles.messageArea}>
            <div className={styles.userMessage}>Хочу подключить три наших бота. Можно обсудить с человеком?<small>14:26</small></div>
            <div className={styles.systemEvent}><UserRoundCheck size={12} /> Нужен оператор</div>
            <div className={styles.botMessage}>Да. Передаю диалог менеджеру — история переписки сохранится.<small>Бот · 14:26</small></div>
            <div className={styles.operatorMessage}>Михаил, добрый день! Уже вижу ваши данные. Подскажу, как подключить все три проекта.<small>Оператор · 14:27</small></div>
          </div>
          <div className={styles.composer}>Написать сообщение… <Send size={14} /></div>
        </section>
        <aside className={styles.previewProfile}>
          <div className={styles.profilePerson}><span className={styles.avatarViolet}>М</span><b>Михаил Орлов</b><small>Москва · Telegram</small></div>
          <dl>
            <div><dt>Стадия</dt><dd><i className={styles.stageDot} /> Квалификация</dd></div>
            <div><dt>Ответственный</dt><dd>Алексей</dd></div>
            <div><dt>lead_score</dt><dd>92</dd></div>
            <div><dt>Ботов</dt><dd>3</dd></div>
          </dl>
          <div className={styles.profileTags}><span>горячий лид</span><span>B2B</span></div>
        </aside>
      </div>
    </div>
  );
}

function SectionTitle({ eyebrow, title, text }: { eyebrow: string; title: string; text: string }) {
  return <div className={styles.sectionTitle}><span>{eyebrow}</span><h2>{title}</h2><p>{text}</p></div>;}

export default function LandingPage() {
  const apiExample = `POST /api/v1/events
Authorization: Service token

{
  "type": "message.received",
  "channel": "telegram",
  "external_user_id": "84120931",
  "attributes": { "lead_score": 92 }
}`;

  return (
    <main className={styles.landing}>
      <LandingAnalytics />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(faqLd) }} />

      <header className={styles.header}>
        <div className={styles.headerInner}>
          <Brand />
          <nav aria-label="Навигация по странице"><a href="#problems">Зачем</a><a href="#features">Возможности</a><a href="#how">Как подключить</a><a href="#security">Безопасность</a><a href="#faq">Вопросы</a></nav>
          <div className={styles.headerActions}><Link className={styles.loginLink} href="/">Войти</Link><Link className={styles.headerCta} href="/docs" data-cta="header-docs">Документация <ArrowRight size={15} /></Link></div>
        </div>
      </header>

      <section className={styles.hero}>
        <div className={styles.heroGlow} />
        <div className={styles.container}>
          <div className={styles.heroCopy}>
            <span className={styles.eyebrow}><span /> CRM для самописных ботов</span>
            <h1>Все диалоги и сделки ваших ботов — <em>в одной панели</em></h1>
            <p>Подключите уже работающих ботов. Команда увидит переписку, данные клиента и стадию сделки, сможет вовремя забрать диалог и довести обращение до результата.</p>
            <div className={styles.heroActions}><Link className={styles.primaryCta} href="/" data-cta="hero-app">Посмотреть BotCRM <ArrowRight size={18} /></Link><a className={styles.secondaryCta} href="#how" data-cta="hero-how">Как это работает</a></div>
            <div className={styles.heroFacts}><span><Check size={15} /> Без переноса логики бота</span><span><Check size={15} /> REST API и SDK</span><span><Check size={15} /> Self-hosted</span></div>          </div>
          <ProductPreview />
        </div>
      </section>

      <section className={styles.factStrip} aria-label="Ключевые возможности"><div className={styles.container}><span><MessagesSquare size={18} /> Все боты и каналы</span><span><Radio size={18} /> Сообщения в реальном времени</span><span><UserRoundCheck size={18} /> Перехват оператором</span><span><Columns3 size={18} /> Сделки на канбан-доске</span><span><Server size={18} /> Данные на вашем сервере</span></div></section>

      <section className={styles.problems} id="problems">
        <div className={styles.container}>
          <SectionTitle eyebrow="Знакомая ситуация" title="Бот отвечает. А что происходит с клиентом — не видно." text="Самописный бот решает сценарий, но не даёт команде рабочего места. Поэтому продажи и поддержка всё равно держатся на логах, таблицах и ручных сообщениях." />
          <div className={styles.problemGrid}>
            <article><span>01</span><h3>Лиды остаются внутри чата</h3><p>Клиент проявил интерес, но у него нет стадии, ответственного и следующего шага.</p></article>
            <article><span>02</span><h3>Оператор подключается поздно</h3><p>Запрос «позовите человека» теряется среди обычных диалогов, пока клиент ждёт.</p></article>
            <article><span>03</span><h3>Контекст разбросан</h3><p>Переменные в БД, переписка в Telegram, задачи в таблице — целой картины нет ни у кого.</p></article>
            <article><span>04</span><h3>Каждый новый бот — новая админка</h3><p>Снова нужны списки пользователей, рассылки, статусы, поиск и отдельный мониторинг.</p></article>
          </div>
          <div className={styles.shiftPanel}>
            <div className={styles.shiftBefore}><span>Сейчас</span><ul><li>Логи и запросы к базе</li><li>Ручные таблицы лидов</li><li>Параллельные ответы бота и человека</li><li>Рассылки отдельными скриптами</li></ul></div>
            <ArrowRight className={styles.shiftArrow} />
            <div className={styles.shiftAfter}><span>С BotCRM</span><ul><li><CheckCircle2 /> Диалог, клиент и сделка связаны</li><li><CheckCircle2 /> Видно, где нужен оператор</li><li><CheckCircle2 /> Управление передаётся явно</li><li><CheckCircle2 /> Сегменты и результаты в панели</li></ul></div>
          </div>
        </div>
      </section>

      <section className={styles.features} id="features">
        <div className={styles.container}>
          <SectionTitle eyebrow="Одно рабочее место" title="От первого сообщения до продажи — без потери контекста" text="BotCRM не заменяет вашего бота. Она добавляет недостающий слой управления для команды, которая работает с его пользователями." />
          <div className={styles.featureGrid}>
            <article className={styles.featureWide}>
              <div className={styles.featureText}><span className={styles.iconBox}><Inbox /></span><h3>Единый inbox для всех ботов</h3><p>Переписка обновляется в реальном времени. Фильтруйте диалоги по боту, каналу, ответственному, тегам, стадии и любым переменным.</p><ul><li><Check /> Полная история сообщений</li><li><Check /> Непрочитанные и статусы доставки</li><li><Check /> Заметки, задачи и назначения</li></ul></div>
              <div className={styles.inboxIllustration}><div><span className={styles.avatarCoral}>А</span><span className={styles.illustrationContact}><b>Анна</b><small>Новый вопрос по тарифу</small></span><em>1 новое</em></div><div className={styles.illustrationActive}><span className={styles.avatarViolet}>М</span><span className={styles.illustrationContact}><b>Михаил</b><small>Нужен оператор</small></span><i>сейчас</i></div><div><span className={styles.avatarBlue}>К</span><span className={styles.illustrationContact}><b>Компания Север</b><small>Ответил на рассылку</small></span><i>8 мин</i></div></div>
            </article>
            <article className={styles.featureCard}><span className={styles.iconBox}><UserRoundCheck /></span><h3>Забрать диалог у бота</h3><p>Оператор подключается одной кнопкой. Совместимый бот перестаёт отвечать, а после решения вопроса получает управление обратно.</p><div className={styles.controlDemo}><span><Bot size={17} /><small>Сейчас отвечает</small><strong>Бот</strong></span><ArrowRight size={18} /><b><CircleUserRound size={17} /><small>Диалог забрал</small><strong>Алексей</strong></b></div></article>
            <article className={styles.featureCard}><span className={styles.iconBox}><BriefcaseBusiness /></span><h3>Карточка клиента вместо набора ID</h3><p>Объедините аккаунты человека, теги, контакты и типизированные переменные. Выберите, какие данные бот может обновлять.</p><div className={styles.variableDemo}><span><small>lead_score</small><b>92</b><em>Высокий интерес</em></span><span><small>plan</small><b>Pro</b><em>Выбранный тариф</em></span><span><small>source</small><b>Telegram</b><em>Источник лида</em></span></div></article>
            <article className={styles.featureCard}><span className={styles.iconBox}><Columns3 /></span><h3>Воронки, которые команда видит</h3><p>Создавайте свои этапы и двигайте сделки вручную или правилом. На карточке — сумма, ответственный, теги и время на стадии.</p><div className={styles.pipelineDemo}><div><span><i /> Новая заявка</span><strong>8</strong><small>3 ждут первого ответа</small><em><b style={{ width: "78%" }} /></em></div><div><span><i /> В работе</span><strong>4</strong><small>На сумму 38 400 ₽</small><em><b style={{ width: "52%" }} /></em></div><div><span><i /> Оплата</span><strong>2</strong><small>Конверсия 25%</small><em><b style={{ width: "30%" }} /></em></div></div></article>
            <article className={styles.featureCard}><span className={styles.iconBox}><Send /></span><h3>Рассылки без самодельных скриптов</h3><p>Соберите сегмент, проверьте получателей и отправьте сообщение с переменными, изображениями и кнопками. Ограничения канала учтёт очередь.</p><div className={styles.campaignDemo}><span>Запланировано получателей</span><strong>1 248</strong><i><b style={{ width: "76%" }} /></i><small><CheckCircle2 /> Аудитория проверена, отписавшиеся исключены</small></div></article>
            <article className={styles.featureWideAlt}><div className={styles.featureText}><span className={styles.iconBox}><Workflow /></span><h3>Автоматизации для CRM, а не ещё один конструктор ботов</h3><p>Реагируйте на события вокруг диалога: меняйте стадию, назначайте оператора, добавляйте тег, создавайте задачу или вызывайте внешний webhook.</p></div><div className={styles.ruleDemo}><span><Radio /> Клиент написал «купить»</span><ArrowRight /><span><SlidersHorizontal /> lead_score больше 80</span><ArrowRight /><span><Columns3 /> Переместить в «Оплата»</span></div></article>
          </div>
        </div>
      </section>

      <section className={styles.how} id="how">
        <div className={styles.container}>
          <SectionTitle eyebrow="Подключение" title="Не переносите бота. Подключите его." text="Выберите уровень контроля под текущую архитектуру. Начать можно с копирования событий, а затем перевести нужные каналы через gateway." />
          <div className={styles.steps}>
            <article><span>1</span><div className={styles.iconBox}><Code2 /></div><h3>Добавьте REST или SDK</h3><p>TypeScript и Python SDK передают входящие, исходящие сообщения и пользовательские поля в общем формате.</p></article>
            <article><span>2</span><div className={styles.iconBox}><Webhook /></div><h3>Выберите режим</h3><p><b>Mirror</b> оставляет текущий webhook. <b>Gateway</b> отдаёт BotCRM контроль над каналом и перехватом.</p></article>
            <article><span>3</span><div className={styles.iconBox}><Gauge /></div><h3>Работайте из панели</h3><p>Диалоги появляются автоматически. Настройте этапы, фильтры, роли и правила под процесс команды.</p></article>
          </div>
          <div className={styles.codePanel}>
            <div className={styles.codeCopy}><span>Универсальный API</span><h3>Любой язык. Любая логика бота.</h3><p>Платформа принимает нормализованные события и не заставляет переносить сценарии в закрытый конструктор.</p><Link href="/docs">Открыть документацию <ArrowRight size={16} /></Link></div>
            <pre><code>{apiExample}</code></pre>
          </div>
        </div>
      </section>

      <section className={styles.audience}>
        <div className={styles.container}>
          <SectionTitle eyebrow="Кому подходит" title="Одна система — три понятных рабочих места" text="Каждый видит нужный ему слой, а данные остаются связанными." />
          <div className={styles.audienceGrid}>
            <article><BriefcaseBusiness /><h3>Владельцу и руководителю</h3><p>Видеть обращения, нагрузку, стадии и продажи без запросов к разработчику.</p><a href="#features">Что будет в панели <ArrowRight /></a></article>
            <article><MessagesSquare /><h3>Продажам и поддержке</h3><p>Быстро находить запросы, где нужен человек, отвечать с контекстом и не терять следующий шаг.</p><a href="#problems">Какие боли закрывает <ArrowRight /></a></article>
            <article><Code2 /><h3>Разработчику и агентству</h3><p>Подключать новые проекты по одному контракту вместо разработки очередной админки с нуля.</p><Link href="/docs">Контракт интеграции <ArrowRight /></Link></article>
          </div>
        </div>
      </section>

      <section className={styles.security} id="security">
        <div className={styles.container}>
          <div className={styles.securityCopy}><span className={styles.eyebrowDark}><LockKeyhole /> Контроль данных</span><h2>CRM разворачивается на вашем сервере</h2><p>PostgreSQL, Redis и S3-совместимое хранилище остаются под вашим управлением. Никакой обязательной передачи клиентской базы в закрытый SaaS.</p><ul><li><ShieldCheck /> Роли, TOTP-MFA и управление сессиями</li><li><Database /> Шифрование токенов каналов и резервные копии</li><li><Server /> Docker Compose для обычного VPS</li><li><Webhook /> Подписанные webhooks, аудит и rate limiting</li></ul></div>          <div className={styles.securityDiagram}><span><Bot /> Ваши боты</span><i /><strong><ShieldCheck /> BotCRM</strong><i /><div><span><Database /> PostgreSQL</span><span><Radio /> Redis</span><span><Server /> S3 / MinIO</span></div><small>Ваша инфраструктура</small></div>
        </div>
      </section>

      <section className={styles.faq} id="faq">
        <div className={styles.container}>
          <SectionTitle eyebrow="Частые вопросы" title="Что важно знать до подключения" text="Коротко о совместимости, данных и ежедневной работе." />
          <div className={styles.faqList}>{faq.map((item, index) => <details name="botcrm-faq" key={item.question}><summary><span>{String(index + 1).padStart(2, "0")}</span><b>{item.question}</b><i><ChevronDown /></i></summary><p>{item.answer}</p></details>)}</div>
        </div>
      </section>

      <section className={styles.finalCta}>
        <div className={styles.container}>
          <div><span>Ваши боты уже общаются с клиентами.</span><h2>Теперь сделайте эту работу видимой.</h2><p>Подключите первый бот, откройте диалоги в панели и настройте процесс команды вокруг реальных обращений.</p><div className={styles.heroActions}><Link className={styles.primaryCtaLight} href="/" data-cta="final-app">Открыть BotCRM <ArrowRight size={18} /></Link><Link className={styles.secondaryCtaDark} href="/docs" data-cta="final-docs">Изучить документацию</Link></div></div>
          <div className={styles.finalMark}><MessageCircle /></div>
        </div>
      </section>

      <footer className={styles.footer}><div className={styles.container}><Brand /><p>CRM-панель для самописных ботов: диалоги, клиенты, сделки и рассылки.</p><nav><a href="#features">Возможности</a><a href="#how">Подключение</a><Link href="/docs">Документация</Link><a href="https://github.com/Evgenykravchenko/botcrm" target="_blank" rel="noreferrer">Исходный код</a><a href="https://github.com/Evgenykravchenko/botcrm/blob/main/LICENSE" target="_blank" rel="noreferrer">AGPL-3.0</a><Link href="/">Войти</Link></nav><small>© {new Date().getFullYear()} BotCRM · свободное ПО без гарантий</small></div></footer>
    </main>
  );
}
