import { randomUUID } from "node:crypto";

export type Channel = "telegram" | "vk" | "whatsapp" | "avito" | "api";
export type ControlMode = "BOT" | "HUMAN" | "PAUSED";
export type MessageStatus = "queued" | "sent" | "delivered" | "read" | "failed";

export interface NormalizedEvent {
  event_id: string;
  schema_version: "1.0";
  occurred_at: string;
  workspace_id: string;
  bot_id: string;
  connector_id?: string;
  channel: Channel;
  external_chat_id: string;
  external_user_id: string;
  type: "message.received" | "message.sent" | "message.status" | "contact.updated" | "control.returned";
  message?: { external_id?: string; text?: string; reply_to?: string; attachments?: Array<{ type: string; url: string }> };
  profile?: { name?: string; phone?: string; email?: string; city?: string; avatar_url?: string; avatar_file_id?: string };
  attributes?: Record<string, unknown>;
  raw_payload?: unknown;
}

export interface ContactRecord {
  id: string;
  workspaceId: string;
  displayName: string;
  phone?: string;
  email?: string;
  city?: string;
  avatarAvailable?: boolean;
  attributes: Record<string, unknown>;
  identities: Array<{ channel: Channel; externalUserId: string }>;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationRecord {
  id: string;
  workspaceId: string;
  botId: string;
  contactId: string;
  channel: Channel;
  externalChatId: string;
  mode: ControlMode;
  controlVersion: number;
  assignedUserId?: string;
  unreadCount: number;
  lastMessageAt: string;
}

export interface MessageRecord {
  id: string;
  eventId?: string;
  conversationId: string;
  direction: "inbound" | "outbound" | "system";
  actor: "contact" | "bot" | "operator" | "system";
  text: string;
  status: MessageStatus;
  externalId?: string;
  attachments: AttachmentRecord[];
  createdAt: string;
}

export interface AttachmentRecord {
  id: string;
  filename: string;
  mimeType: string;
  byteSize: number;
  createdAt: string;
}

export interface DealRecord {
  id: string;
  workspaceId: string;
  contactId: string;
  pipelineId: string;
  stageId: string;
  title: string;
  amount: number;
  version: number;
  updatedAt: string;
}

export interface CampaignRecord {
  id: string;
  workspaceId: string;
  name: string;
  channel: Channel;
  status: "draft" | "scheduled" | "running" | "completed" | "cancelled";
  audience: number;
  excluded: number;
  content: string;
  createdAt: string;
}

export class DomainError extends Error {
  constructor(public readonly status: number, message: string, public readonly code: string) { super(message); }
}

export class BotCrmCore {
  private readonly eventIds = new Set<string>();
  private readonly contacts = new Map<string, ContactRecord>();
  private readonly identityIndex = new Map<string, string>();
  private readonly conversations = new Map<string, ConversationRecord>();
  private readonly conversationIndex = new Map<string, string>();
  private readonly messages = new Map<string, MessageRecord[]>();
  private readonly deals = new Map<string, DealRecord>();
  private readonly campaigns = new Map<string, CampaignRecord>();
  private readonly audit: Array<Record<string, unknown>> = [];

  constructor() {
    const iso = (minutesAgo = 0) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
    const people = [
      { key: "c1", contactId: "contact_c1", name: "Анна Ковалева", phone: "+79134482011", email: "anna.k@example.ru", city: "Омск", channel: "telegram" as Channel, externalId: "84120931", botId: "sales_assistant", message: "Да, отправьте реквизиты для оплаты", mode: "BOT" as ControlMode, unread: 2, minutesAgo: 2, attributes: { lead_score: 92, plan: "team", payment_status: "waiting", sessions: 4, tags: ["VIP", "горячий"] } },
      { key: "c2", contactId: "contact_c2", name: "Максим Орлов", phone: "+70000000002", email: "max.orlov@example.com", city: "Москва", channel: "whatsapp" as Channel, externalId: "wa_9652014590", botId: "support_bot", message: "Подскажите, когда будет доставка?", mode: "HUMAN" as ControlMode, unread: 1, minutesAgo: 7, attributes: { lead_score: 78, plan: "personal", topic: "delivery", tags: ["доставка"] } },
      { key: "c3", contactId: "contact_c3", name: "Елена Сафина", phone: "+79504461902", email: "safina.e@example.ru", city: "Казань", channel: "vk" as Channel, externalId: "vk_240188", botId: "course_bot", message: "Спасибо, всё получилось 👍", mode: "BOT" as ControlMode, unread: 0, minutesAgo: 29, attributes: { lead_score: 84, course: "product", payment_status: "paid", tags: ["курс"] } },
      { key: "c4", contactId: "contact_c4", name: "Илья Петров", phone: "+79218813204", email: undefined, city: "Санкт-Петербург", channel: "avito" as Channel, externalId: "avito_59310", botId: "avito_leads", message: "Можно посмотреть сегодня вечером?", mode: "BOT" as ControlMode, unread: 0, minutesAgo: 45, attributes: { lead_score: 67, category: "realty", tags: ["недвижимость"] } },
      { key: "c5", contactId: "contact_c5", name: "ООО Север", phone: "+73812551840", email: "info@sever.ru", city: "Омск", channel: "api" as Channel, externalId: "crm_sever_25", botId: "b2b_qualifier", message: "Нам нужно подключить 25 менеджеров", mode: "PAUSED" as ControlMode, unread: 0, minutesAgo: 71, attributes: { lead_score: 88, seats: 25, plan: "enterprise", tags: ["B2B", "enterprise"] } },
      { key: "c6", contactId: "contact_c6", name: "Дарья Волкова", phone: "+79991017643", email: "volkova.d@example.ru", city: "Новосибирск", channel: "telegram" as Channel, externalId: "tg_3102884", botId: "sales_assistant", message: "Пока подумаю, спасибо", mode: "BOT" as ControlMode, unread: 0, minutesAgo: 114, attributes: { lead_score: 51, sessions: 3, tags: ["возврат"] } },
    ];

    for (const person of people) {
      const contact: ContactRecord = { id: person.contactId, workspaceId: "ws_demo", displayName: person.name, phone: person.phone, email: person.email, city: person.city, attributes: person.attributes, identities: [{ channel: person.channel, externalUserId: person.externalId }], createdAt: iso(60 * 24 * 30), updatedAt: iso(person.minutesAgo) };
      const conversation: ConversationRecord = { id: person.key, workspaceId: "ws_demo", botId: person.botId, contactId: person.contactId, channel: person.channel, externalChatId: person.externalId, mode: person.mode, controlVersion: 1, assignedUserId: person.mode === "HUMAN" ? "user_owner" : undefined, unreadCount: person.unread, lastMessageAt: iso(person.minutesAgo) };
      this.contacts.set(contact.id, contact);
      this.identityIndex.set(this.identityKey(contact.workspaceId, person.channel, person.externalId), contact.id);
      this.conversations.set(conversation.id, conversation);
      this.conversationIndex.set(this.conversationKey(conversation.workspaceId, conversation.botId, conversation.channel, conversation.externalChatId), conversation.id);
      const history: MessageRecord[] = person.key === "c1" ? [
        { id: "m1", conversationId: person.key, direction: "system", actor: "system", text: "Диалог создан ботом Sales Assistant · Telegram", status: "sent", attachments: [], createdAt: iso(11) },
        { id: "m2", conversationId: person.key, direction: "inbound", actor: "contact", text: "Здравствуйте! Видела у вас пакет для небольших команд. Он подойдёт, если нас пятеро?", status: "read", attachments: [], createdAt: iso(10) },
        { id: "m3", conversationId: person.key, direction: "outbound", actor: "bot", text: "Анна, здравствуйте! Да, пакет «Команда» рассчитан на 3–10 человек. В него входят все основные модули и помощь с запуском.", status: "read", attachments: [], createdAt: iso(9) },
        { id: "m4", conversationId: person.key, direction: "outbound", actor: "bot", text: "Стоимость — 24 900 ₽ в месяц. Могу прислать короткую презентацию или сразу подготовить счёт.", status: "read", attachments: [], createdAt: iso(8) },
        { id: "m5", conversationId: person.key, direction: "inbound", actor: "contact", text: "Презентацию посмотрела, всё понятно. А оплатить можно от ИП?", status: "read", attachments: [], createdAt: iso(5) },
        { id: "m6", conversationId: person.key, direction: "outbound", actor: "bot", text: "Да, конечно. Работаем и с ИП, и с юридическими лицами. Счёт сформируем с НДС или без — как вам удобнее.", status: "read", attachments: [], createdAt: iso(4) },
        { id: "m7", conversationId: person.key, direction: "inbound", actor: "contact", text: person.message, status: "read", attachments: [], createdAt: iso(person.minutesAgo) },
      ] : [
        { id: `${person.key}_system`, conversationId: person.key, direction: "system", actor: "system", text: `История синхронизирована через ${person.channel}`, status: "sent", attachments: [], createdAt: iso(person.minutesAgo + 2) },
        { id: `${person.key}_message`, conversationId: person.key, direction: "inbound", actor: "contact", text: person.message, status: "read", attachments: [], createdAt: iso(person.minutesAgo) },
      ];
      this.messages.set(person.key, history);
    }

    const extraContacts = [
      ["contact_d2", "Ольга Романова"], ["contact_d3", "Роман Беляев"], ["contact_d5", "Мария Цой"], ["contact_d7", "Артур Хасанов"], ["contact_d10", "Никита Чен"],
    ] as const;
    for (const [id, displayName] of extraContacts) this.contacts.set(id, { id, workspaceId: "ws_demo", displayName, attributes: {}, identities: [], createdAt: iso(10_000), updatedAt: iso(200) });

    const deals: Array<Omit<DealRecord, "workspaceId" | "version" | "updatedAt">> = [
      { id: "d1", contactId: "contact_c4", pipelineId: "sales", stageId: "new", title: "Илья Петров", amount: 42000 },
      { id: "d2", contactId: "contact_d2", pipelineId: "sales", stageId: "new", title: "Ольга Романова", amount: 14900 },
      { id: "d3", contactId: "contact_d3", pipelineId: "sales", stageId: "new", title: "Роман Беляев", amount: 28000 },
      { id: "d4", contactId: "contact_c2", pipelineId: "sales", stageId: "qualify", title: "Максим Орлов", amount: 34900 },
      { id: "d5", contactId: "contact_d5", pipelineId: "sales", stageId: "qualify", title: "Мария Цой", amount: 52000 },
      { id: "d6", contactId: "contact_c5", pipelineId: "sales", stageId: "proposal", title: "ООО Север", amount: 189000 },
      { id: "d7", contactId: "contact_d7", pipelineId: "sales", stageId: "proposal", title: "Артур Хасанов", amount: 74500 },
      { id: "d8", contactId: "contact_c1", pipelineId: "sales", stageId: "invoice", title: "Анна Ковалева", amount: 24900 },
      { id: "d9", contactId: "contact_c3", pipelineId: "sales", stageId: "won", title: "Елена Сафина", amount: 19900 },
      { id: "d10", contactId: "contact_d10", pipelineId: "sales", stageId: "won", title: "Никита Чен", amount: 48000 },
    ];
    for (const deal of deals) this.deals.set(deal.id, { ...deal, workspaceId: "ws_demo", version: 1, updatedAt: iso(5) });

    const seededCampaigns: CampaignRecord[] = [
      { id: "campaign_repeat", workspaceId: "ws_demo", name: "Август · повторная покупка", channel: "telegram", status: "running", audience: 2418, excluded: 91, content: "Персональное предложение для повторной покупки", createdAt: iso(60 * 24 * 3) },
      { id: "campaign_abandoned", workspaceId: "ws_demo", name: "Брошенная заявка", channel: "telegram", status: "completed", audience: 386, excluded: 14, content: "Возвращайтесь — поможем закончить оформление", createdAt: iso(60 * 24 * 8) },
      { id: "campaign_update", workspaceId: "ws_demo", name: "Обновление продукта 2.4", channel: "whatsapp", status: "draft", audience: 1092, excluded: 47, content: "Рассказываем о новых возможностях", createdAt: iso(60 * 24) },
      { id: "campaign_webinar", workspaceId: "ws_demo", name: "Напоминание о вебинаре", channel: "vk", status: "scheduled", audience: 742, excluded: 22, content: "Вебинар начнётся завтра в 10:00", createdAt: iso(60 * 12) },
    ];
    for (const campaign of seededCampaigns) this.campaigns.set(campaign.id, campaign);
  }

  ingest(event: NormalizedEvent) {
    this.validateEvent(event);
    if (this.eventIds.has(event.event_id)) return { duplicate: true, eventId: event.event_id };
    const now = new Date().toISOString();
    const identityKey = this.identityKey(event.workspace_id, event.channel, event.external_user_id);
    let contactId = this.identityIndex.get(identityKey);
    if (!contactId) {
      contactId = randomUUID();
      this.contacts.set(contactId, { id: contactId, workspaceId: event.workspace_id, displayName: event.profile?.name || `Пользователь ${event.external_user_id}`, phone: event.profile?.phone, email: event.profile?.email, city: event.profile?.city, avatarAvailable: Boolean(event.profile?.avatar_url || event.profile?.avatar_file_id), attributes: event.attributes ?? {}, identities: [{ channel: event.channel, externalUserId: event.external_user_id }], createdAt: now, updatedAt: now });
      this.identityIndex.set(identityKey, contactId);
    } else {
      const current = this.contacts.get(contactId)!;
      this.contacts.set(contactId, { ...current, displayName: event.profile?.name ?? current.displayName, phone: event.profile?.phone ?? current.phone, email: event.profile?.email ?? current.email, city: event.profile?.city ?? current.city, avatarAvailable: Boolean(event.profile?.avatar_url || event.profile?.avatar_file_id) || current.avatarAvailable, attributes: { ...current.attributes, ...(event.attributes ?? {}) }, updatedAt: now });
    }
    const conversationKey = this.conversationKey(event.workspace_id, event.bot_id, event.channel, event.external_chat_id);
    let conversationId = this.conversationIndex.get(conversationKey);
    if (!conversationId) {
      conversationId = randomUUID();
      this.conversations.set(conversationId, { id: conversationId, workspaceId: event.workspace_id, botId: event.bot_id, contactId, channel: event.channel, externalChatId: event.external_chat_id, mode: "BOT", controlVersion: 1, unreadCount: 0, lastMessageAt: now });
      this.conversationIndex.set(conversationKey, conversationId);
    }
    const conversation = this.conversations.get(conversationId)!;
    if (event.type === "message.received" || event.type === "message.sent") {
      const inbound = event.type === "message.received";
      const record: MessageRecord = { id: randomUUID(), eventId: event.event_id, conversationId, direction: inbound ? "inbound" : "outbound", actor: inbound ? "contact" : "bot", text: event.message?.text ?? "", status: inbound ? "read" : "sent", externalId: event.message?.external_id, attachments: [], createdAt: event.occurred_at };
      this.messages.set(conversationId, [...(this.messages.get(conversationId) ?? []), record]);
      this.conversations.set(conversationId, { ...conversation, unreadCount: inbound ? conversation.unreadCount + 1 : conversation.unreadCount, lastMessageAt: event.occurred_at });
    }
    this.eventIds.add(event.event_id);
    this.audit.push({ id: randomUUID(), workspaceId: event.workspace_id, action: "event.ingested", eventId: event.event_id, conversationId, occurredAt: now });
    return { duplicate: false, eventId: event.event_id, contactId, conversationId, deliverToBot: event.type === "message.received" && conversation.mode === "BOT" };
  }

  upsertContact(workspaceId: string, input: { channel: Channel; externalUserId: string; name?: string; phone?: string; email?: string; city?: string; avatarUrl?: string; avatarFileId?: string; attributes?: Record<string, unknown> }) {
    return this.ingest({ event_id: randomUUID(), schema_version: "1.0", occurred_at: new Date().toISOString(), workspace_id: workspaceId, bot_id: "profile_sync", channel: input.channel, external_chat_id: input.externalUserId, external_user_id: input.externalUserId, type: "contact.updated", profile: { name: input.name, phone: input.phone, email: input.email, city: input.city, avatar_url: input.avatarUrl, avatar_file_id: input.avatarFileId }, attributes: input.attributes });
  }

  listConversations(workspaceId: string) { return [...this.conversations.values()].filter((item) => item.workspaceId === workspaceId).sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt)).map((conversation) => ({ ...conversation, contact: this.contacts.get(conversation.contactId), messages: this.messages.get(conversation.id) ?? [] })); }
  getConversation(id: string, workspaceId?: string) { const value = this.conversations.get(id); if (!value || (workspaceId && value.workspaceId !== workspaceId)) throw new DomainError(404, "Conversation not found", "conversation_not_found"); return { ...value, contact: this.contacts.get(value.contactId), messages: this.messages.get(id) ?? [] }; }

  setControl(conversationId: string, input: { mode: ControlMode; expectedVersion: number; userId?: string }, workspaceId?: string) {
    const current = this.conversations.get(conversationId); if (!current || (workspaceId && current.workspaceId !== workspaceId)) throw new DomainError(404, "Conversation not found", "conversation_not_found");
    if (current.controlVersion !== input.expectedVersion) throw new DomainError(409, "Control state changed by another actor", "control_version_conflict");
    const updated = { ...current, mode: input.mode, assignedUserId: input.mode === "HUMAN" ? input.userId : undefined, controlVersion: current.controlVersion + 1 };
    this.conversations.set(conversationId, updated);
    const system: MessageRecord = { id: randomUUID(), conversationId, direction: "system", actor: "system", text: input.mode === "HUMAN" ? "Диалог забран оператором" : input.mode === "BOT" ? "Управление возвращено боту" : "Диалог поставлен на паузу", status: "sent", attachments: [], createdAt: new Date().toISOString() };
    this.messages.set(conversationId, [...(this.messages.get(conversationId) ?? []), system]);
    this.audit.push({ id: randomUUID(), workspaceId: current.workspaceId, action: "conversation.control_changed", conversationId, from: current.mode, to: input.mode, userId: input.userId, occurredAt: system.createdAt });
    return updated;
  }

  sendMessage(input: { conversationId: string; actor: "bot" | "operator"; text: string; idempotencyKey: string; attachmentIds?: string[]; buttons?: Array<{ id?: string; text: string; type: "callback" | "url"; value: string; row: number }> }, workspaceId?: string) {
    if (!input.idempotencyKey) throw new DomainError(400, "Idempotency-Key is required", "idempotency_required");
    const conversation = this.conversations.get(input.conversationId); if (!conversation || (workspaceId && conversation.workspaceId !== workspaceId)) throw new DomainError(404, "Conversation not found", "conversation_not_found");
    const duplicate = (this.messages.get(input.conversationId) ?? []).find((message) => message.eventId === input.idempotencyKey); if (duplicate) return { duplicate: true, message: duplicate };
    if (input.actor === "bot" && conversation.mode !== "BOT") throw new DomainError(409, "Bot is not in control of this conversation", "bot_not_in_control");
    if (!input.text.trim() && !input.attachmentIds?.length) throw new DomainError(400, "Message text or attachment is required", "empty_message");
    if (input.attachmentIds?.length) throw new DomainError(503, "Persistent storage is required for attachments", "persistent_storage_required");
    const message: MessageRecord = { id: randomUUID(), eventId: input.idempotencyKey, conversationId: input.conversationId, direction: "outbound", actor: input.actor, text: input.text, status: "queued", attachments: [], createdAt: new Date().toISOString() };
    this.messages.set(input.conversationId, [...(this.messages.get(input.conversationId) ?? []), message]);
    return { duplicate: false, message };
  }

  listContacts(workspaceId: string) { return [...this.contacts.values()].filter((contact) => contact.workspaceId === workspaceId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  listPipeline(workspaceId: string, pipelineId?: string) { return [...this.deals.values()].filter((deal) => deal.workspaceId === workspaceId && (!pipelineId || deal.pipelineId === pipelineId)).map((deal) => ({ ...deal, contact: this.contacts.get(deal.contactId) })); }
  moveDeal(id: string, stageId: string, expectedVersion: number, workspaceId?: string) { const deal = this.deals.get(id); if (!deal || (workspaceId && deal.workspaceId !== workspaceId)) throw new DomainError(404, "Deal not found", "deal_not_found"); if (deal.version !== expectedVersion) throw new DomainError(409, "Deal was changed", "deal_version_conflict"); const updated = { ...deal, stageId, version: deal.version + 1, updatedAt: new Date().toISOString() }; this.deals.set(id, updated); return updated; }
  previewCampaign(input: { audience: number; suppressed?: number; unavailable?: number }) { const excluded = (input.suppressed ?? 0) + (input.unavailable ?? 0); return { total: input.audience, eligible: Math.max(0, input.audience - excluded), excluded, reasons: { suppressed: input.suppressed ?? 0, unavailable: input.unavailable ?? 0 } }; }
  createCampaign(workspaceId: string, input: { name: string; channel: Channel; content: string; audience: number; excluded: number }) { const campaign: CampaignRecord = { id: randomUUID(), workspaceId, name: input.name, channel: input.channel, status: "draft", audience: input.audience, excluded: input.excluded, content: input.content, createdAt: new Date().toISOString() }; this.campaigns.set(campaign.id, campaign); return campaign; }
  listCampaigns(workspaceId: string) { return [...this.campaigns.values()].filter((item) => item.workspaceId === workspaceId); }
  getAudit(workspaceId: string) { return this.audit.filter((item) => item.workspaceId === workspaceId); }

  private validateEvent(event: NormalizedEvent) { const required = [event.event_id, event.schema_version, event.occurred_at, event.workspace_id, event.bot_id, event.channel, event.external_chat_id, event.external_user_id, event.type]; if (required.some((value) => !value)) throw new DomainError(400, "Normalized event is incomplete", "invalid_event"); if (event.schema_version !== "1.0") throw new DomainError(400, "Unsupported schema version", "unsupported_schema"); }
  private identityKey(workspaceId: string, channel: Channel, userId: string) { return `${workspaceId}:${channel}:${userId}`; }
  private conversationKey(workspaceId: string, botId: string, channel: Channel, chatId: string) { return `${workspaceId}:${botId}:${channel}:${chatId}`; }
}
