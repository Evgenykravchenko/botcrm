import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { DomainError } from "./core.js";
import { PostgresStore } from "./postgres-store.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgresql://botcrm:botcrm_dev_password@localhost:5432/botcrm";
const workspaceId = "00000000-0000-4000-8000-000000000001";

test("dynamic segments preview the audience and constrain campaign snapshots", async () => {
  const store = new PostgresStore(databaseUrl); await store.init(); const suffix = randomUUID(); let contactId: string | undefined, conversationId: string | undefined, connectorId: string | undefined, segmentId: string | undefined, campaignId: string | undefined;
  try {
    const ingested = await store.ingest({ event_id: `segment-event-${suffix}`, schema_version: "1.0", occurred_at: new Date().toISOString(), workspace_id: "ws_demo", bot_id: `segment_bot_${suffix}`, channel: "api", external_chat_id: `segment-chat-${suffix}`, external_user_id: `segment-user-${suffix}`, type: "message.received", message: { text: "Segment fixture" }, profile: { name: `Segment Match ${suffix}` }, attributes: { segment_test_key: suffix, lead_score: 88 } }); contactId = ingested.contactId; conversationId = ingested.conversationId;
    const botSlug = ("segment_bot_" + suffix).toLowerCase().replace(/[^a-z0-9_]+/g, "_"); const bot = await store.pool.query("select id from bots where workspace_id=$1 and slug=$2", [workspaceId, botSlug]); connectorId = randomUUID(); await store.pool.query("insert into connectors(id,workspace_id,bot_id,channel,encrypted_credentials,status) values($1,$2,$3,'api',$4,'CONNECTED')", [connectorId, workspaceId, bot.rows[0].id, JSON.stringify({ outboundUrl: "https://example.test/messages", signingSecret: "test" })]);
    const filter = { operator: "AND" as const, conditions: [{ field: "attributes.segment_test_key", operator: "equals" as const, value: suffix }, { field: "attributes.lead_score", operator: "gte" as const, value: 80 }] };
    const segment = await store.createSegment("ws_demo", { name: `Hot test ${suffix}`, filter }); segmentId = segment.id; assert.equal(segment.count, 1);
    const preview = await store.previewSegment("ws_demo", { segmentId, channel: "api", limit: 10 }); assert.equal(preview.total, 1); assert.equal(preview.eligible, 1); assert.equal(preview.contacts[0].id, contactId);
    const campaign = await store.createCampaign("ws_demo", { name: `Segment campaign ${suffix}`, channel: "api", content: "Only the matching segment", segmentId }, "00000000-0000-4000-8000-000000000002"); campaignId = campaign.id; assert.equal(campaign.audience, 1); assert.equal(campaign.excluded, 0);
    const started = await store.startCampaign(campaignId, "ws_demo"); assert.equal(started.queued, 1); assert.equal(started.jobs[0].contactId, contactId);
    await assert.rejects(() => store.startCampaign(campaignId!, "ws_demo"), (error: unknown) => error instanceof DomainError && error.code === "campaign_state_conflict");
    await assert.rejects(() => store.deleteSegment(segmentId!, "ws_demo"), (error: unknown) => error instanceof DomainError && error.code === "segment_in_use");
  } finally {
    if (campaignId) await store.pool.query("delete from campaigns where id=$1", [campaignId]).catch(() => undefined); if (segmentId) await store.pool.query("delete from segments where id=$1", [segmentId]).catch(() => undefined);
    if (conversationId) await store.pool.query("delete from conversations where id=$1", [conversationId]).catch(() => undefined); if (connectorId) await store.pool.query("delete from connectors where id=$1", [connectorId]).catch(() => undefined); if (contactId) { await store.pool.query("delete from channel_identities where contact_id=$1", [contactId]).catch(() => undefined); await store.pool.query("delete from contacts where id=$1", [contactId]).catch(() => undefined); }
    await store.pool.query("delete from ingested_events where workspace_id=$1 and event_id=$2", [workspaceId, `segment-event-${suffix}`]).catch(() => undefined); await store.pool.query("delete from bots where workspace_id=$1 and slug=$2", [workspaceId, `segment_bot_${suffix}`.toLowerCase().replace(/[^a-z0-9_]+/g, "_")]).catch(() => undefined); await store.close();
  }
});
