import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { Queue, Worker, type ConnectionOptions } from "bullmq";
import { Pool } from "pg";
import { botEventProcessor, type BotEventJob } from "./bot-event-processor.js";

loadEnv({ path: resolve(process.cwd(), ".env"), quiet: true });
if (!process.env.DATABASE_URL) loadEnv({ path: resolve(process.cwd(), "../../.env"), quiet: true });
const workspaceId = "00000000-0000-4000-8000-000000000001";
function redisConnection(redisUrl: string): ConnectionOptions { const url = new URL(redisUrl); return { host: url.hostname, port: Number(url.port || 6379), db: url.pathname.length > 1 ? Number(url.pathname.slice(1)) : 0 }; }
async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs = 8_000): Promise<T> { const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) { const value = await read(); if (value !== undefined) return value; await new Promise((resolveWait) => setTimeout(resolveWait, 40)); } throw new Error("Timed out waiting for bot event delivery"); }

test("bot event worker delivers a signed outbox event exactly once", async (context) => {
  if (!process.env.DATABASE_URL || !process.env.REDIS_URL) return context.skip("DATABASE_URL and REDIS_URL are required");
  const received: Array<{ body: string; signature: string; eventId: string }> = [];
  const secret = "bot-event-integration-secret";
  const server = createServer((request, response) => { let body = ""; request.on("data", (chunk) => body += chunk); request.on("end", () => { received.push({ body, signature: String(request.headers["x-botcrm-signature"] ?? ""), eventId: String(request.headers["x-botcrm-event-id"] ?? "") }); response.writeHead(204); response.end(); }); });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Test server did not bind");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
  const botId = randomUUID(), connectorId = randomUUID(), outboxId = randomUUID(), eventId = `gateway-test-${randomUUID()}`;
  const queueName = `bot-event-delivery-test-${randomUUID()}`; const connection = redisConnection(process.env.REDIS_URL); const queue = new Queue<BotEventJob>(queueName, { connection }); const worker = new Worker<BotEventJob>(queueName, botEventProcessor(pool), { connection, concurrency: 2 });
  try {
    await pool.query("insert into bots(id,workspace_id,slug,name,integration_mode,event_endpoint) values($1,$2,$3,'Bot Event Worker Test','GATEWAY',$4)", [botId, workspaceId, `bot_event_test_${botId.replaceAll("-", "")}`, `http://127.0.0.1:${address.port}/events`]);
    await pool.query("insert into connectors(id,workspace_id,bot_id,channel,encrypted_credentials,status) values($1,$2,$3,'api',$4,'CONNECTED')", [connectorId, workspaceId, botId, JSON.stringify({ signingSecret: secret })]);
    const event = { event_id: eventId, schema_version: "1.0", occurred_at: new Date().toISOString(), workspace_id: workspaceId, bot_id: "test", channel: "api", external_chat_id: "chat-1", external_user_id: "user-1", type: "message.received", message: { text: "Gateway hello" } };
    await pool.query("insert into outbox_events(id,workspace_id,topic,aggregate_id,payload) values($1,$2,'bot.event',$3,$4)", [outboxId, workspaceId, eventId, JSON.stringify({ connectorId, event })]);
    await worker.waitUntilReady(); const job: BotEventJob = { workspaceId, outboxId };
    await Promise.all([queue.add("deliver", job, { jobId: `${outboxId}-1` }), queue.add("deliver", job, { jobId: `${outboxId}-2` })]);
    const state = await waitFor(async () => { const result = await pool.query("select processed_at from outbox_events where id=$1", [outboxId]); return result.rows[0]?.processed_at ? result.rows[0] : undefined; });
    assert.ok(state.processed_at); assert.equal(received.length, 1); assert.equal(received[0].eventId, eventId); assert.equal(received[0].signature, `sha256=${createHmac("sha256", secret).update(received[0].body).digest("hex")}`); assert.match(received[0].body, /Gateway hello/);
  } finally {
    await worker.close(); await queue.obliterate({ force: true }).catch(() => undefined); await queue.close();
    await pool.query("delete from outbox_events where id=$1", [outboxId]).catch(() => undefined); await pool.query("delete from connectors where id=$1", [connectorId]).catch(() => undefined); await pool.query("delete from bots where id=$1", [botId]).catch(() => undefined); await pool.end(); await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
});
