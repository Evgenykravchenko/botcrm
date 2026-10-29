import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PostgresStore } from "./postgres-store.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgresql://botcrm:botcrm_dev_password@localhost:5432/botcrm";
const workspaceUuid = "00000000-0000-4000-8000-000000000001";

test("PostgreSQL atomically attaches verified media and preserves idempotency", async () => {
  const store = new PostgresStore(databaseUrl);
  await store.init();
  const suffix = randomUUID();
  const eventId = `media_event_${suffix}`;
  let contactId = "";
  let conversationId = "";
  let uploadId = "";
  let messageId = "";
  let nativeMessageId = "";
  try {
    const ingested = await store.ingest({ event_id: eventId, schema_version: "1.0", occurred_at: new Date().toISOString(), workspace_id: "ws_demo", bot_id: "media_test_bot", channel: "vk", external_chat_id: suffix, external_user_id: suffix, type: "message.received", message: { text: "media fixture" }, profile: { name: "Media Test" } });
    contactId = ingested.contactId!;
    conversationId = ingested.conversationId!;
    const reserved = await store.reserveMediaUpload("ws_demo", { filename: "invoice.pdf", mimeType: "application/pdf", byteSize: 4096 });
    uploadId = reserved.id;
    assert.equal(reserved.status, "pending");
    const completed = await store.completeMediaUpload(uploadId, { mimeType: "application/pdf", byteSize: 4096 }, "ws_demo");
    assert.equal(completed.status, "uploaded");
    const key = `media_out_${suffix}`;
    const sent = await store.sendMessage({ conversationId, actor: "operator", text: "Invoice", idempotencyKey: key, attachmentIds: [uploadId] }, "ws_demo");
    messageId = sent.message.id;
    assert.equal(sent.message.attachments.length, 1);
    assert.equal(sent.message.attachments[0].filename, "invoice.pdf");
    const duplicate = await store.sendMessage({ conversationId, actor: "operator", text: "ignored", idempotencyKey: key, attachmentIds: [uploadId] }, "ws_demo");
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.message.attachments.length, 1);
    const nativeSent = await store.sendMessage({ conversationId, actor: "bot", text: "Video", idempotencyKey: `native_${suffix}`, nativeAttachments: [{ ref: "video-1_2_key", kind: "video", name: "Exercise video", yandexPath: "/bot_crm/media_test_bot/video.mp4" }] }, "ws_demo");
    nativeMessageId = nativeSent.message.id;
    assert.equal(nativeSent.message.attachments.length, 1);
    assert.equal(nativeSent.message.attachments[0].source, "vk_native");
    assert.equal(nativeSent.message.attachments[0].mediaKind, "video");
    assert.equal(nativeSent.message.attachments[0].yandexPath, "/bot_crm/media_test_bot/video.mp4");
    assert.equal(nativeSent.message.attachments[0].externalUrl, "https://vk.com/video-1_2");
    const conversation = await store.getConversation(conversationId, "ws_demo");
    assert.equal(conversation.messages.find((message) => message.id === messageId)?.attachments.length, 1);
    assert.equal(conversation.messages.find((message) => message.id === nativeMessageId)?.attachments[0].filename, "Exercise video");
    assert.equal((await store.getMediaUpload(uploadId, "ws_demo")).status, "attached");
  } finally {
    await store.pool.query("delete from audit_events where workspace_id=$1 and entity_id=any($2::text[])", [workspaceUuid, [eventId, uploadId, messageId, nativeMessageId, conversationId].filter(Boolean)]);
    if (nativeMessageId) await store.pool.query("delete from messages where id=$1", [nativeMessageId]);
    if (messageId) await store.pool.query("delete from messages where id=$1", [messageId]);
    if (uploadId) await store.pool.query("delete from media_uploads where id=$1", [uploadId]);
    if (conversationId) {
      await store.pool.query("delete from messages where conversation_id=$1", [conversationId]);
      await store.pool.query("delete from conversations where id=$1", [conversationId]);
    }
    if (contactId) {
      await store.pool.query("delete from channel_identities where contact_id=$1", [contactId]);
      await store.pool.query("delete from contacts where id=$1", [contactId]);
    }
    await store.pool.query("delete from ingested_events where workspace_id=$1 and event_id=$2", [workspaceUuid, eventId]);
    await store.pool.query("delete from bots where workspace_id=$1 and slug='media_test_bot' and not exists(select 1 from conversations where bot_id=bots.id)", [workspaceUuid]);
    await store.close();
  }
});
