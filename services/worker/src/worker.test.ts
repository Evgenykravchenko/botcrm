import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { Queue, Worker, type ConnectionOptions } from "bullmq";
import { Pool } from "pg";
import { campaignProcessor, type CampaignJob } from "./processor.js";

loadEnv({ path: resolve(process.cwd(), ".env"), quiet: true });
if (!process.env.DATABASE_URL) loadEnv({ path: resolve(process.cwd(), "../../.env"), quiet: true });

function redisConnection(redisUrl: string): ConnectionOptions {
  const url = new URL(redisUrl);
  return { host: url.hostname, port: Number(url.port || 6379), username: url.username || undefined, password: url.password || undefined, db: url.pathname.length > 1 ? Number(url.pathname.slice(1)) : 0, ...(url.protocol === "rediss:" ? { tls: {} } : {}) };
}

async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs = 8_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await read();
    if (result !== undefined) return result;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

test("BullMQ worker delivers a campaign recipient and persists completion", async (context) => {
  if (!process.env.DATABASE_URL || !process.env.REDIS_URL) return context.skip("DATABASE_URL and REDIS_URL are required");
  process.env.DELIVERY_MODE = "simulate";
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
  const campaignId = randomUUID();
  const recipientId = randomUUID();
  const contactId = randomUUID();
  const botId = randomUUID();
  const connectorId = randomUUID();
  const queueName = `campaign-delivery-test-${randomUUID()}`;
  const connection = redisConnection(process.env.REDIS_URL);
  const queue = new Queue<CampaignJob>(queueName, { connection });
  const worker = new Worker<CampaignJob>(queueName, campaignProcessor(pool), { connection, concurrency: 2 });

  try {
    await pool.query("insert into contacts(id,workspace_id,display_name) values($1,'00000000-0000-4000-8000-000000000001','Worker campaign contact')", [contactId]);
    await pool.query("insert into bots(id,workspace_id,slug,name,integration_mode) values($1,'00000000-0000-4000-8000-000000000001',$2,'Worker campaign bot','MIRROR')", [botId, "worker_campaign_" + botId.replaceAll("-", "")]);
    await pool.query("insert into connectors(id,workspace_id,bot_id,channel,encrypted_credentials,status) values($1,'00000000-0000-4000-8000-000000000001',$2,'whatsapp','{}','CONNECTED')", [connectorId, botId]);
    await pool.query("insert into campaigns(id,workspace_id,name,status,channel_content,audience_snapshot) values($1,'00000000-0000-4000-8000-000000000001','Worker integration test','RUNNING','{\"whatsapp\":{\"text\":\"test\"}}','{\"eligible\":1}')", [campaignId]);
    await pool.query("insert into campaign_recipients(id,workspace_id,campaign_id,contact_id,connector_id,status,next_attempt_at) values($1,'00000000-0000-4000-8000-000000000001',$2,$3,$4,'QUEUED',now())", [recipientId, campaignId, contactId, connectorId]);
    await worker.waitUntilReady();
    const payload: CampaignJob = { workspaceId: "00000000-0000-4000-8000-000000000001", recipientId, campaignId, contactId, connectorId, externalUserId: "wa_test", channel: "whatsapp", content: "Integration test" };
    await Promise.all([
      queue.add("deliver:whatsapp", payload, { jobId: `${recipientId}-first` }),
      queue.add("deliver:whatsapp", payload, { jobId: `${recipientId}-duplicate` }),
    ]);

    const state = await waitFor(async () => {
      const result = await pool.query("select lower(status::text) status,attempt_count,delivered_at from campaign_recipients where id=$1", [recipientId]);
      return result.rows[0]?.status === "delivered" ? result.rows[0] : undefined;
    });
    assert.equal(state.status, "delivered");
    assert.equal(state.attempt_count, 1);
    assert.ok(state.delivered_at);
    const campaign = await waitFor(async () => {
      const result = await pool.query("select lower(status::text) status from campaigns where id=$1", [campaignId]);
      return result.rows[0]?.status === "completed" ? result.rows[0] : undefined;
    });
    assert.equal(campaign.status, "completed");
  } finally {
    await worker.close();
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close();
    await pool.query("delete from campaigns where id=$1", [campaignId]).catch(() => undefined);
    await pool.query("delete from connectors where id=$1", [connectorId]).catch(() => undefined);
    await pool.query("delete from bots where id=$1", [botId]).catch(() => undefined);
    await pool.query("delete from contacts where id=$1", [contactId]).catch(() => undefined);
    await pool.end();
  }
});