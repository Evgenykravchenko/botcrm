import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PostgresStore } from "./postgres-store.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgresql://botcrm:botcrm_dev_password@localhost:5432/botcrm";
const workspaceId = "00000000-0000-4000-8000-000000000001";

test("Gateway ingestion persists a recoverable bot outbox and control.returned event", async () => {
  const store = new PostgresStore(databaseUrl); await store.init();
  const botId = randomUUID(), connectorId = randomUUID(), eventId = `gateway-${randomUUID()}`, externalId = `gateway-user-${randomUUID()}`;
  let conversationId: string | undefined, contactId: string | undefined;
  try {
    await store.pool.query("insert into bots(id,workspace_id,slug,name,integration_mode,event_endpoint) values($1,$2,$3,'Gateway Store Test','GATEWAY','https://bot.example.test/events')", [botId, workspaceId, `gateway_store_${botId.replaceAll("-", "")}`]);
    await store.pool.query("insert into connectors(id,workspace_id,bot_id,channel,encrypted_credentials,status) values($1,$2,$3,'api',$4,'CONNECTED')", [connectorId, workspaceId, botId, JSON.stringify({ signingSecret: "gateway-store-secret" })]);
    const event = { event_id: eventId, schema_version: "1.0" as const, occurred_at: new Date().toISOString(), workspace_id: "ws_demo", connector_id: connectorId, bot_id: "ignored-for-gateway", channel: "api" as const, external_chat_id: externalId, external_user_id: externalId, type: "message.received" as const, message: { text: "Persist me before delivery" }, profile: { name: "Gateway Store Contact" } };
    const accepted = await store.ingest(event); conversationId = accepted.conversationId; contactId = accepted.contactId;
    assert.equal(accepted.deliverToBot, true); assert.ok(accepted.outboxEventId); assert.equal(accepted.connectorId, connectorId);
    const outbox = await store.pool.query("select payload from outbox_events where id=$1", [accepted.outboxEventId]);
    assert.equal(outbox.rows[0].payload.connectorId, connectorId); assert.equal(outbox.rows[0].payload.event.conversation_id, conversationId); assert.equal(outbox.rows[0].payload.event.message.text, "Persist me before delivery");
    const duplicate = await store.ingest(event); assert.equal(duplicate.duplicate, true); assert.equal(duplicate.outboxEventId, accepted.outboxEventId);
    const human = await store.setControl(conversationId!, { mode: "HUMAN", expectedVersion: 1, userId: "gateway-test" });
    const operatorKey = `operator-${randomUUID()}`; const operatorMessage = await store.sendMessage({ conversationId: conversationId!, actor: "operator", text: "Operator took over", idempotencyKey: operatorKey });
    assert.ok(operatorMessage.outboxEventId); const operatorOutbox = await store.pool.query("select payload from outbox_events where id=$1", [operatorMessage.outboxEventId]); assert.equal(operatorOutbox.rows[0].payload.event.type, "message.sent"); assert.equal(operatorOutbox.rows[0].payload.event.attributes.actor, "operator");
    const returned = await store.setControl(conversationId!, { mode: "BOT", expectedVersion: human.controlVersion, userId: "gateway-test" });
    assert.ok(returned.outboxEventId);
    const control = await store.pool.query("select payload from outbox_events where id=$1", [returned.outboxEventId]);
    assert.equal(control.rows[0].payload.event.type, "control.returned"); assert.equal(control.rows[0].payload.event.conversation_id, conversationId);
  } finally {
    await store.pool.query("delete from outbox_events where workspace_id=$1 and (payload->>'connectorId')=$2", [workspaceId, connectorId]).catch(() => undefined);
    if (conversationId) { await store.pool.query("delete from audit_events where workspace_id=$1 and entity_id in ($2)", [workspaceId, conversationId]).catch(() => undefined); await store.pool.query("delete from conversations where id=$1", [conversationId]).catch(() => undefined); }
    if (contactId) { await store.pool.query("delete from channel_identities where contact_id=$1", [contactId]).catch(() => undefined); await store.pool.query("delete from contacts where id=$1", [contactId]).catch(() => undefined); }
    await store.pool.query("delete from ingested_events where workspace_id=$1 and event_id=$2", [workspaceId, eventId]).catch(() => undefined); await store.pool.query("delete from connectors where id=$1", [connectorId]).catch(() => undefined); await store.pool.query("delete from bots where id=$1", [botId]).catch(() => undefined); await store.close();
  }
});
