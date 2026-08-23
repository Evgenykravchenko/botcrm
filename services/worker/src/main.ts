import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { ConnectionOptions, Queue, Worker } from "bullmq";
import { Pool } from "pg";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { campaignProcessor, CampaignJob } from "./processor.js";
import { messageProcessor, MessageJob } from "./message-processor.js";
import { botEventProcessor, BotEventJob } from "./bot-event-processor.js";
import { runRetention } from "./retention.js";

loadEnv({ path: resolve(process.cwd(), ".env"), quiet: true });
if (!process.env.DATABASE_URL) loadEnv({ path: resolve(process.cwd(), "../../.env"), quiet: true });
if (process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy) {
  setGlobalDispatcher(new EnvHttpProxyAgent());
  console.log(JSON.stringify({ level: "info", message: "outbound HTTP proxy enabled" }));
}
if (!process.env.DATABASE_URL || !process.env.REDIS_URL) throw new Error("DATABASE_URL and REDIS_URL are required");

function redisConnection(redisUrl: string): ConnectionOptions {
  const url = new URL(redisUrl);
  return { host: url.hostname, port: Number(url.port || 6379), username: url.username || undefined, password: url.password || undefined, db: url.pathname.length > 1 ? Number(url.pathname.slice(1)) : 0, ...(url.protocol === "rediss:" ? { tls: {} } : {}) };
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: Number(process.env.WORKER_DATABASE_POOL_SIZE ?? 10) });
await pool.query("select 1");
const queueConnection = redisConnection(process.env.REDIS_URL);
const messageQueue = new Queue<MessageJob>("message-delivery", { connection: queueConnection, defaultJobOptions: { attempts: 5, backoff: { type: "channel-aware", delay: 2_000 }, removeOnComplete: { age: 86_400, count: 20_000 }, removeOnFail: { age: 604_800, count: 50_000 } } });
await messageQueue.waitUntilReady();
const botEventQueue = new Queue<BotEventJob>("bot-event-delivery", { connection: queueConnection, defaultJobOptions: { attempts: 5, backoff: { type: "channel-aware", delay: 2_000 }, removeOnComplete: { age: 86_400, count: 20_000 }, removeOnFail: { age: 604_800, count: 50_000 } } });
await botEventQueue.waitUntilReady();
const worker = new Worker<CampaignJob>("campaign-delivery", campaignProcessor(pool), {
  connection: redisConnection(process.env.REDIS_URL),
  concurrency: Number(process.env.CAMPAIGN_CONCURRENCY ?? 20),
  limiter: { max: Number(process.env.CAMPAIGN_RATE_LIMIT ?? 30), duration: 1_000 },
  settings: {
    backoffStrategy: (attemptsMade, type, error) => {
      if (type !== "channel-aware") return 2_000;
      const retryAfterMs = Number((error as Error & { retryAfterMs?: number }).retryAfterMs ?? 0);
      return retryAfterMs > 0 ? retryAfterMs : Math.min(300_000, 2_000 * 2 ** Math.max(0, attemptsMade - 1));
    },
  },
});
await worker.waitUntilReady();
console.log(JSON.stringify({ level: "info", message: "BotCRM campaign worker ready", deliveryMode: process.env.DELIVERY_MODE || "simulate" }));
worker.on("completed", (job) => console.log(JSON.stringify({ level: "info", message: "campaign recipient completed", jobId: job.id, recipientId: job.data.recipientId })));
worker.on("failed", (job, error) => console.error(JSON.stringify({ level: "error", message: "campaign recipient failed", jobId: job?.id, recipientId: job?.data.recipientId, error: error.message })));
worker.on("error", (error) => console.error(JSON.stringify({ level: "error", message: "worker error", error: error.message })));

const messageWorker = new Worker<MessageJob>("message-delivery", messageProcessor(pool), {
  connection: redisConnection(process.env.REDIS_URL),
  concurrency: Number(process.env.MESSAGE_CONCURRENCY ?? 30),
  settings: { backoffStrategy: (attemptsMade, type, error) => { if (type !== "channel-aware") return 2_000; const retryAfterMs = Number((error as Error & { retryAfterMs?: number }).retryAfterMs ?? 0); return retryAfterMs > 0 ? retryAfterMs : Math.min(300_000, 2_000 * 2 ** Math.max(0, attemptsMade - 1)); } },
});
await messageWorker.waitUntilReady();
console.log(JSON.stringify({ level: "info", message: "BotCRM message delivery worker ready" }));
messageWorker.on("completed", (job) => console.log(JSON.stringify({ level: "info", message: "outbound message completed", jobId: job.id, messageId: job.data.messageId })));
messageWorker.on("failed", (job, error) => console.error(JSON.stringify({ level: "error", message: "outbound message failed", jobId: job?.id, messageId: job?.data.messageId, error: error.message })));
messageWorker.on("error", (error) => console.error(JSON.stringify({ level: "error", message: "message worker error", error: error.message })));
const botEventWorker = new Worker<BotEventJob>("bot-event-delivery", botEventProcessor(pool), {
  connection: redisConnection(process.env.REDIS_URL),
  concurrency: Number(process.env.BOT_EVENT_CONCURRENCY ?? 20),
  settings: { backoffStrategy: (attemptsMade, type, error) => { if (type !== "channel-aware") return 2_000; const retryAfterMs = Number((error as Error & { retryAfterMs?: number }).retryAfterMs ?? 0); return retryAfterMs > 0 ? retryAfterMs : Math.min(300_000, 2_000 * 2 ** Math.max(0, attemptsMade - 1)); } },
});
await botEventWorker.waitUntilReady();
console.log(JSON.stringify({ level: "info", message: "BotCRM bot event worker ready" }));
botEventWorker.on("completed", (job) => console.log(JSON.stringify({ level: "info", message: "bot event delivered", jobId: job.id, outboxId: job.data.outboxId })));
botEventWorker.on("failed", (job, error) => console.error(JSON.stringify({ level: "error", message: "bot event delivery failed", jobId: job?.id, outboxId: job?.data.outboxId, error: error.message })));
botEventWorker.on("error", (error) => console.error(JSON.stringify({ level: "error", message: "bot event worker error", error: error.message })));
async function scanInactiveConversations() {
  if (!process.env.SERVICE_TOKEN) return;
  const result = await pool.query(`select id "conversationId",workspace_id "workspaceId",contact_id "contactId",channel,control_mode "controlMode",last_message_at "lastMessageAt",
    greatest(0,extract(epoch from(now()-last_message_at))/60)::int "inactiveMinutes"
    from conversations where archived_at is null and last_message_at<now()-interval '5 minutes' order by last_message_at limit 1000`);
  const baseUrl = (process.env.BOTCRM_API_URL ?? "http://localhost:4100/api/v1").replace(/\/$/, "");
  for (const row of result.rows) {
    const response = await fetch(`${baseUrl}/automations/process`, { method: "POST", headers: { "content-type": "application/json", "x-service-token": process.env.SERVICE_TOKEN, "x-workspace-id": row.workspaceId }, body: JSON.stringify({ triggerType: "conversation.inactive", sourceEventId: `conversation.inactive:${row.conversationId}:${new Date(row.lastMessageAt).toISOString()}`, context: row }), signal: AbortSignal.timeout(5_000) }).catch((error) => { console.error(JSON.stringify({ level: "error", message: "inactivity automation request failed", error: error.message })); return null; });
    if (response && !response.ok) console.error(JSON.stringify({ level: "error", message: "inactivity automation rejected", status: response.status, conversationId: row.conversationId }));
  }
}
async function startScheduledCampaigns() {
  if (!process.env.SERVICE_TOKEN) return; const result = await pool.query("select id,workspace_id from campaigns where status='SCHEDULED' and scheduled_at<=now() order by scheduled_at limit 100"); const baseUrl = (process.env.BOTCRM_API_URL ?? "http://localhost:4100/api/v1").replace(/\/$/, "");
  for (const row of result.rows) { const response = await fetch(`${baseUrl}/campaigns/${row.id}/start`, { method: "POST", headers: { "content-type": "application/json", "x-service-token": process.env.SERVICE_TOKEN, "x-workspace-id": row.workspace_id }, body: "{}", signal: AbortSignal.timeout(10_000) }).catch((error) => { console.error(JSON.stringify({ level: "error", message: "scheduled campaign start failed", campaignId: row.id, error: error.message })); return null; }); if (response && !response.ok && response.status !== 409) console.error(JSON.stringify({ level: "error", message: "scheduled campaign rejected", campaignId: row.id, status: response.status })); }
}
const scheduledCampaignInterval = setInterval(() => void startScheduledCampaigns(), Math.max(15_000, Number(process.env.SCHEDULED_CAMPAIGN_SCAN_INTERVAL_MS ?? 30_000)));
scheduledCampaignInterval.unref(); void startScheduledCampaigns();
const inactivityInterval = setInterval(() => void scanInactiveConversations(), Math.max(30_000, Number(process.env.INACTIVITY_SCAN_INTERVAL_MS ?? 60_000)));
inactivityInterval.unref();
void scanInactiveConversations();
async function recoverPendingBotEvents() {
  try {
    const result = await pool.query("select id,workspace_id \"workspaceId\",attempt_count \"attemptCount\" from outbox_events where topic='bot.event' and processed_at is null and available_at<=now() and attempt_count<20 order by created_at limit 1000");
    if (result.rowCount) await botEventQueue.addBulk(result.rows.map((row) => ({ name: "deliver", data: { workspaceId: row.workspaceId, outboxId: row.id }, opts: { jobId: row.id + "-" + row.attemptCount } })));
  } catch (error) {
    console.error(JSON.stringify({ level: "error", message: "pending bot event recovery failed", error: error instanceof Error ? error.message : String(error) }));
  }
}
const botEventRecoveryInterval = setInterval(() => void recoverPendingBotEvents(), Math.max(5_000, Number(process.env.BOT_EVENT_RECOVERY_SCAN_INTERVAL_MS ?? 15_000)));
botEventRecoveryInterval.unref();
void recoverPendingBotEvents();

async function recoverQueuedMessages() {
  try {
    const result = await pool.query(`select m.id "messageId",m.workspace_id "workspaceId",c.id "conversationId",c.connector_id "connectorId",c.external_chat_id "externalChatId",c.channel
      from messages m join conversations c on c.id=m.conversation_id
      where m.status='QUEUED' and c.connector_id is not null order by m.occurred_at limit 1000`);
    if (result.rowCount) await messageQueue.addBulk(result.rows.map((data) => ({ name: `send:${data.channel}`, data, opts: { jobId: data.messageId } })));
  } catch (error) { console.error(JSON.stringify({ level: "error", message: "queued message recovery failed", error: error instanceof Error ? error.message : String(error) })); }
}
const messageRecoveryInterval = setInterval(() => void recoverQueuedMessages(), Math.max(5_000, Number(process.env.MESSAGE_RECOVERY_SCAN_INTERVAL_MS ?? 15_000)));
messageRecoveryInterval.unref();
void recoverQueuedMessages();
async function applyRetentionPolicy() {
  try {
    const result = await runRetention(pool);
    console.log(JSON.stringify({ level: "info", message: "retention policy applied", ...result }));
  } catch (error) {
    console.error(JSON.stringify({ level: "error", message: "retention policy failed", error: error instanceof Error ? error.message : String(error) }));
  }
}
const retentionInterval = setInterval(() => void applyRetentionPolicy(), Math.max(3_600_000, Number(process.env.RETENTION_SCAN_INTERVAL_MS ?? 21_600_000)));
retentionInterval.unref();
void applyRetentionPolicy();
async function shutdown(signal: string) {
  console.log(JSON.stringify({ level: "info", message: "worker shutdown", signal }));
  clearInterval(inactivityInterval);
  clearInterval(scheduledCampaignInterval);
  clearInterval(retentionInterval);
  clearInterval(messageRecoveryInterval);
  clearInterval(botEventRecoveryInterval);
  await Promise.all([worker.close(), messageWorker.close(), botEventWorker.close(), messageQueue.close(), botEventQueue.close()]);
  await pool.end();
  process.exit(0);
}
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
