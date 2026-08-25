import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { DomainError } from "./core.js";
import { PostgresStore } from "./postgres-store.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgresql://botcrm:botcrm_dev_password@localhost:5432/botcrm";
const workspaceUuid = "00000000-0000-4000-8000-000000000001";

test("PostgreSQL persists an idempotent conversation across store restarts", async () => {
  const suffix = randomUUID();
  const externalId = `integration_${suffix}`;
  const eventId = `event_${suffix}`;
  const outboundKey = `outbound_${suffix}`;
  const statusEventId = `status_${suffix}`;
  const readStatusEventId = `status_read_${suffix}`;
  const lateSentStatusEventId = `status_late_sent_${suffix}`;
  const channelMessageId = `channel_${suffix}`;
  let store = new PostgresStore(databaseUrl);
  await store.init();
  let conversationId: string | undefined;
  let contactId: string | undefined;
  let campaignTestConversationId: string | undefined;
  const connectorId = randomUUID();
  try {
    const accepted = await store.ingest({ event_id: eventId, schema_version: "1.0", occurred_at: new Date().toISOString(), workspace_id: "ws_demo", bot_id: "integration_test_bot", channel: "api", external_chat_id: externalId, external_user_id: externalId, type: "message.received", message: { text: "persistent inbound" }, profile: { name: "Integration Test" }, attributes: { lead_score: 99 } });
    assert.equal(accepted.duplicate, false);
    conversationId = accepted.conversationId;
    contactId = accepted.contactId;
    assert.ok(conversationId && contactId);
    const unreadConversation = await store.getConversation(conversationId, "ws_demo");
    assert.equal(unreadConversation.messages.find((message) => message.eventId === eventId)?.status, "delivered");
    assert.equal(unreadConversation.unreadCount, 1);
    await store.markConversationRead(conversationId, "ws_demo");
    const readConversation = await store.getConversation(conversationId, "ws_demo");
    assert.equal(readConversation.messages.find((message) => message.eventId === eventId)?.status, "read");
    assert.equal(readConversation.unreadCount, 0);
    assert.equal((await store.ingest({ event_id: eventId, schema_version: "1.0", occurred_at: new Date().toISOString(), workspace_id: "ws_demo", bot_id: "integration_test_bot", channel: "api", external_chat_id: externalId, external_user_id: externalId, type: "message.received", message: { text: "duplicate" } })).duplicate, true);
    const claimed = await store.setControl(conversationId, { mode: "HUMAN", expectedVersion: 1, userId: "integration" });
    assert.equal(claimed.controlVersion, 2);
    const outbound = await store.sendMessage({ conversationId, actor: "operator", text: "persistent outbound", idempotencyKey: outboundKey });
    await store.pool.query("update messages set external_id=$2,status='SENT' where id=$1", [outbound.message.id, channelMessageId]);
    const receipt = await store.ingest({ event_id: statusEventId, schema_version: "1.0", occurred_at: new Date().toISOString(), workspace_id: "ws_demo", bot_id: "integration_test_bot", channel: "api", external_chat_id: externalId, external_user_id: externalId, type: "message.status", message: { external_id: channelMessageId }, attributes: { status: "delivered" } });
    assert.equal(receipt.status, "delivered");
    const readReceipt = await store.ingest({ event_id: readStatusEventId, schema_version: "1.0", occurred_at: new Date().toISOString(), workspace_id: "ws_demo", bot_id: "integration_test_bot", channel: "api", external_chat_id: externalId, external_user_id: externalId, type: "message.status", message: { external_id: channelMessageId }, attributes: { status: "read" } });
    assert.equal(readReceipt.status, "read");
    const lateSentReceipt = await store.ingest({ event_id: lateSentStatusEventId, schema_version: "1.0", occurred_at: new Date().toISOString(), workspace_id: "ws_demo", bot_id: "integration_test_bot", channel: "api", external_chat_id: externalId, external_user_id: externalId, type: "message.status", message: { external_id: channelMessageId }, attributes: { status: "sent" } });
    assert.equal(lateSentReceipt.status, "read");
    await store.pool.query(
      `insert into connectors(id,workspace_id,bot_id,channel,encrypted_credentials,status)
       select $1,workspace_id,bot_id,'api',$2,'CONNECTED' from conversations where id=$3`,
      [connectorId, JSON.stringify({ test: true }), conversationId],
    );
    const campaignTest = await store.createCampaignTestMessage("ws_demo", { contactId: contactId!, channel: "api", content: "campaign test message" });
    campaignTestConversationId = campaignTest.message.conversationId;
    assert.equal(campaignTest.message.status, "queued");
    await store.close();

    store = new PostgresStore(databaseUrl);
    await store.init();
    const persisted = await store.getConversation(conversationId, "ws_demo");
    assert.equal(persisted.mode, "HUMAN");
    assert.equal(persisted.messages.filter((message) => message.eventId === outboundKey).length, 1);
    assert.equal(persisted.messages.find((message) => message.eventId === outboundKey)?.status, "read");
    await assert.rejects(() => store.sendMessage({ conversationId: conversationId!, actor: "bot", text: "must be blocked", idempotencyKey: `blocked_${suffix}` }), (error: unknown) => error instanceof DomainError && error.code === "bot_not_in_control");
    await store.setControl(conversationId, { mode: "BOT", expectedVersion: 2, userId: "integration" });
  } finally {
    const cleanup = store.pool;
    if (conversationId) {
      await cleanup.query("delete from audit_events where workspace_id=$1 and entity_id=$2", [workspaceUuid, conversationId]);
      await cleanup.query("delete from deal_stage_history where workspace_id=$1 and deal_id in (select id from deals where contact_id=$2)", [workspaceUuid, contactId]);
      await cleanup.query("delete from messages where conversation_id=$1", [conversationId]);
      await cleanup.query("delete from conversations where id=$1", [conversationId]);
    }
    if (campaignTestConversationId && campaignTestConversationId !== conversationId) {
      await cleanup.query("delete from audit_events where workspace_id=$1 and entity_id=$2", [workspaceUuid, campaignTestConversationId]);
      await cleanup.query("delete from messages where conversation_id=$1", [campaignTestConversationId]);
      await cleanup.query("delete from conversations where id=$1", [campaignTestConversationId]);
    }
    if (contactId) {
      await cleanup.query("delete from channel_identities where contact_id=$1", [contactId]);
      await cleanup.query("delete from contacts where id=$1", [contactId]);
    }
    await cleanup.query("delete from connectors where id=$1", [connectorId]).catch(() => undefined);
    await cleanup.query("delete from ingested_events where workspace_id=$1 and event_id=any($2::text[])", [workspaceUuid, [eventId, statusEventId, readStatusEventId, lateSentStatusEventId]]);
    await cleanup.query("delete from bots where workspace_id=$1 and slug='integration_test_bot' and not exists(select 1 from conversations where bot_id=bots.id)", [workspaceUuid]);
    await store.close();
  }
});

test("VK mirror connector requires only the community access token", async () => {
  const store = new PostgresStore(databaseUrl);
  await store.init();
  const suffix = randomUUID().replaceAll("-", "");
  const slug = `vk_mirror_${suffix}`;
  let connectorId: string | undefined;
  let botId: string | undefined;
  try {
    const connector = await store.createConnector("ws_demo", {
      botName: "VK Mirror Test",
      botSlug: slug,
      channel: "vk",
      integrationMode: "MIRROR",
      externalAccountId: "123456",
      credentials: { accessToken: "vk-community-token-for-integration-test", apiVersion: "5.199" },
    });
    connectorId = connector.id;
    botId = connector.botId;
    assert.equal(connector.integrationMode, "MIRROR");
    assert.deepEqual(connector.configuredFields.sort(), ["accessToken", "apiVersion"].sort());

    await assert.rejects(
      () => store.createConnector("ws_demo", {
        botName: "VK Gateway Invalid",
        botSlug: `vk_gateway_${suffix}`,
        channel: "vk",
        integrationMode: "GATEWAY",
        credentials: { accessToken: "vk-community-token-for-integration-test" },
      }),
      (error: unknown) => error instanceof DomainError && error.code === "connector_secrets_required",
    );
  } finally {
    if (connectorId) {
      await store.pool.query("delete from audit_events where workspace_id=$1 and entity_id=$2", [workspaceUuid, connectorId]);
      await store.pool.query("delete from connectors where id=$1", [connectorId]);
    }
    if (botId) await store.pool.query("delete from bots where id=$1", [botId]);
    await store.close();
  }
});

test("PostgreSQL enforces campaign pause, resume, cancellation and recipient suppression", async () => {
  const store = new PostgresStore(databaseUrl);
  await store.init();
  let campaignId: string | undefined;
  let recipientContactId: string | undefined;
  const botId = randomUUID();
  const connectorId = randomUUID();
  const campaignCreatorId = randomUUID();
  try {
    await store.pool.query("insert into users(id,workspace_id,email,display_name,role) values($1,$2,$3,$4,'SUPERVISOR')", [campaignCreatorId, workspaceUuid, `campaign-${campaignCreatorId}@example.test`, "Campaign creator"]);
    await store.pool.query("insert into bots(id,workspace_id,slug,name,integration_mode) values($1,$2,$3,$4,'MIRROR')", [botId, workspaceUuid, `campaign_test_${botId.replaceAll("-", "")}`, "Campaign lifecycle test bot"]);
    await store.pool.query("insert into connectors(id,workspace_id,bot_id,channel,encrypted_credentials,status) values($1,$2,$3,'whatsapp',$4,'CONNECTED')", [connectorId, workspaceUuid, botId, JSON.stringify({ test: true })]);
    const recipient = await store.createContact("ws_demo", { displayName: "Campaign lifecycle recipient", channel: "whatsapp", externalUserId: `wa_${randomUUID()}` });
    recipientContactId = recipient.id;
    const created = await store.createCampaign("ws_demo", { name: `Lifecycle ${randomUUID()}`, channel: "whatsapp", content: "Lifecycle test", audience: 1, excluded: 0 }, campaignCreatorId);
    campaignId = created.id;
    const persistedCreator = await store.pool.query("select created_by from campaigns where id=$1", [campaignId]);
    assert.equal(persistedCreator.rows[0].created_by, campaignCreatorId);
    const updated = await store.updateCampaign(campaignId, "ws_demo", { name: "Lifecycle edited", channel: "whatsapp", content: "Updated lifecycle test" }, campaignCreatorId);
    assert.equal(updated.name, "Lifecycle edited");
    assert.equal(updated.content, "Updated lifecycle test");
    const started = await store.startCampaign(campaignId, "ws_demo");
    assert.equal(started.channel, "whatsapp");
    assert.ok((started.queued ?? 0) >= 1);
    await assert.rejects(() => store.updateCampaign(campaignId!, "ws_demo", { name: "Too late", channel: "whatsapp", content: "Cannot edit running" }, campaignCreatorId), (error: unknown) => error instanceof DomainError && error.code === "campaign_state_conflict");
    assert.equal((await store.pauseCampaign(campaignId, "ws_demo")).status, "paused");
    const resumed = await store.startCampaign(campaignId, "ws_demo");
    assert.ok((resumed.queued ?? 0) >= 1);
    assert.equal((await store.cancelCampaign(campaignId, "ws_demo")).status, "cancelled");
    const recipients = await store.listCampaignRecipients(campaignId, "ws_demo");
    assert.ok(recipients.length >= 1);
    assert.ok(recipients.every((recipient) => recipient.status === "cancelled"));
    await assert.rejects(() => store.startCampaign(campaignId!, "ws_demo"), (error: unknown) => error instanceof DomainError && error.code === "campaign_state_conflict");
  } finally {
    if (campaignId) {
      await store.pool.query("delete from audit_events where workspace_id=$1 and entity_id=$2", [workspaceUuid, campaignId]);
      await store.pool.query("delete from campaigns where id=$1", [campaignId]);
    }
    if (recipientContactId) {
      await store.pool.query("delete from audit_events where workspace_id=$1 and entity_id=$2", [workspaceUuid, recipientContactId]);
      await store.pool.query("delete from channel_identities where contact_id=$1", [recipientContactId]);
      await store.pool.query("delete from contacts where id=$1", [recipientContactId]);
    }
    await store.pool.query("delete from connectors where id=$1", [connectorId]).catch(() => undefined);
    await store.pool.query("delete from bots where id=$1", [botId]).catch(() => undefined);
    await store.pool.query("delete from users where id=$1", [campaignCreatorId]).catch(() => undefined);
    await store.close();
  }
});
