import assert from "node:assert/strict";
import test from "node:test";
import { BotCrmCore, DomainError, NormalizedEvent } from "./core.js";
import { getAdapter } from "./connectors.js";

const makeEvent = (id: string): NormalizedEvent => ({ event_id: id, schema_version: "1.0", occurred_at: "2026-08-19T12:00:00.000Z", workspace_id: "ws_test", bot_id: "test_bot", channel: "telegram", external_chat_id: "chat_1", external_user_id: "user_1", type: "message.received", message: { text: "Привет" }, profile: { name: "Тестовый пользователь" }, attributes: { lead_score: 81 } });

test("event ingestion is idempotent and creates one conversation", () => {
  const core = new BotCrmCore();
  const first = core.ingest(makeEvent("evt_1"));
  const duplicate = core.ingest(makeEvent("evt_1"));
  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  const conversations = core.listConversations("ws_test");
  assert.equal(conversations.length, 1);
  assert.equal(conversations[0].messages.length, 1);
  assert.equal(conversations[0].contact?.attributes.lead_score, 81);
});

test("conversation control uses optimistic concurrency", () => {
  const core = new BotCrmCore();
  const result = core.ingest(makeEvent("evt_control"));
  const claimed = core.setControl(result.conversationId!, { mode: "HUMAN", expectedVersion: 1, userId: "operator_1" });
  assert.equal(claimed.mode, "HUMAN");
  assert.equal(claimed.controlVersion, 2);
  assert.throws(() => core.setControl(result.conversationId!, { mode: "BOT", expectedVersion: 1 }), (error: unknown) => error instanceof DomainError && error.code === "control_version_conflict");
});

test("bot cannot send while operator owns the conversation", () => {
  const core = new BotCrmCore();
  const result = core.ingest(makeEvent("evt_send"));
  core.setControl(result.conversationId!, { mode: "HUMAN", expectedVersion: 1, userId: "operator_1" });
  assert.throws(() => core.sendMessage({ conversationId: result.conversationId!, actor: "bot", text: "Не должен уйти", idempotencyKey: "send_1" }), (error: unknown) => error instanceof DomainError && error.code === "bot_not_in_control");
  const operator = core.sendMessage({ conversationId: result.conversationId!, actor: "operator", text: "Ответ оператора", idempotencyKey: "send_2" });
  assert.equal(operator.duplicate, false);
  assert.equal(operator.message.actor, "operator");
});

test("Telegram adapter normalizes official Bot API updates", () => {
  const events = getAdapter("telegram").normalize({ update_id: 7788, message: { message_id: 42, text: "Хочу оплатить", chat: { id: 500 }, from: { id: 501, first_name: "Анна", username: "anna" } } }, { workspaceId: "ws_test", botId: "sales", connectorId: "tg_1", receivedAt: "2026-08-19T12:00:00.000Z" });
  assert.equal(events.length, 1);
  assert.equal(events[0].event_id, "telegram:7788");
  assert.equal(events[0].external_chat_id, "500");
  assert.equal(events[0].message?.text, "Хочу оплатить");
  assert.equal(events[0].profile?.name, "Анна");
});
test("WhatsApp adapter normalizes delivery receipts", () => {
  const events = getAdapter("whatsapp").normalize({ entry: [{ changes: [{ value: { statuses: [{ id: "wamid.42", recipient_id: "79990000000", status: "read", timestamp: "1787200000" }] } }] }] }, { workspaceId: "ws_test", botId: "sales", connectorId: "wa_1" });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "message.status");
  assert.equal(events[0].message?.external_id, "wamid.42");
  assert.equal(events[0].attributes?.status, "read");
});
test("contact avatar metadata is preserved with an initials fallback", () => {
  const core = new BotCrmCore();
  const event = makeEvent("evt_avatar");
  event.profile = { ...event.profile, avatar_url: "https://cdn.example.test/avatar.jpg" };
  core.ingest(event);
  const conversation = core.listConversations("ws_test")[0];
  assert.equal(conversation.contact?.avatarAvailable, true);
});

test("channel adapters preserve avatar hints when providers include them", () => {
  const context = { workspaceId: "ws_test", botId: "sales", connectorId: "connector_1" };
  const whatsapp = getAdapter("whatsapp").normalize({ entry: [{ changes: [{ value: { contacts: [{ profile: { name: "Анна", picture_url: "https://cdn.example.test/wa.jpg" } }], messages: [{ id: "wamid.avatar", from: "79990000000", type: "text", text: { body: "Привет" } }] } }] }] }, context);
  const avito = getAdapter("avito").normalize({ id: "avito-avatar", chat_id: "chat-1", author_id: "user-1", text: "Привет", author: { name: "Анна", avatar: { url: "https://cdn.example.test/avito.jpg" } } }, context);
  assert.equal(whatsapp[0].profile?.avatar_url, "https://cdn.example.test/wa.jpg");
  assert.equal(avito[0].profile?.avatar_url, "https://cdn.example.test/avito.jpg");
});