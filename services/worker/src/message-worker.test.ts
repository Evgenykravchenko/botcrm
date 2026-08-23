import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { Queue, Worker, type ConnectionOptions } from "bullmq";
import { Pool } from "pg";
import { messageProcessor, type MessageJob } from "./message-processor.js";

loadEnv({ path: resolve(process.cwd(), ".env"), quiet: true });
if (!process.env.DATABASE_URL) loadEnv({ path: resolve(process.cwd(), "../../.env"), quiet: true });
const workspaceId = "00000000-0000-4000-8000-000000000001";
function redisConnection(redisUrl: string): ConnectionOptions { const url = new URL(redisUrl); return { host: url.hostname, port: Number(url.port || 6379), db: url.pathname.length > 1 ? Number(url.pathname.slice(1)) : 0 }; }
async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs = 8_000): Promise<T> { const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) { const result = await read(); if (result !== undefined) return result; await new Promise((resolveWait) => setTimeout(resolveWait, 40)); } throw new Error("Timed out waiting for outbound delivery"); }

test("message worker delivers a signed generic outbound message exactly once", async (context) => {
  if (!process.env.DATABASE_URL || !process.env.REDIS_URL) return context.skip("DATABASE_URL and REDIS_URL are required");
  const received: Array<{ body: string; signature?: string }> = [];
  const server = createServer((request, response) => { let body = ""; request.on("data", (chunk) => body += chunk); request.on("end", () => { received.push({ body, signature: request.headers["x-botcrm-signature"] as string | undefined }); response.writeHead(200, { "content-type": "application/json" }); response.end('{"id":"external-test-1"}'); }); });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Test server did not bind");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
  const botId = randomUUID(), connectorId = randomUUID(), contactId = randomUUID(), conversationId = randomUUID(), messageId = randomUUID();
  const queueName = `message-delivery-test-${randomUUID()}`; const connection = redisConnection(process.env.REDIS_URL); const queue = new Queue<MessageJob>(queueName, { connection }); const worker = new Worker<MessageJob>(queueName, messageProcessor(pool), { connection, concurrency: 2 });
  try {
    await pool.query("insert into bots(id,workspace_id,slug,name,integration_mode) values($1,$2,$3,'Message Worker Test','GATEWAY')", [botId, workspaceId, `message_test_${botId.replaceAll("-", "")}`]);
    await pool.query("insert into connectors(id,workspace_id,bot_id,channel,encrypted_credentials,status) values($1,$2,$3,'api',$4,'CONNECTED')", [connectorId, workspaceId, botId, JSON.stringify({ outboundUrl: `http://127.0.0.1:${address.port}/messages`, signingSecret: "integration-secret" })]);
    await pool.query("insert into contacts(id,workspace_id,display_name) values($1,$2,'Message Worker Contact')", [contactId, workspaceId]);
    await pool.query("insert into conversations(id,workspace_id,bot_id,connector_id,contact_id,channel,external_chat_id) values($1,$2,$3,$4,$5,'api','chat-test')", [conversationId, workspaceId, botId, connectorId, contactId]);
    await pool.query("insert into messages(id,workspace_id,conversation_id,event_id,direction,actor_type,text_content,status,occurred_at) values($1,$2,$3,$4,'OUTBOUND','operator','Hello from worker','QUEUED',now())", [messageId, workspaceId, conversationId, `message-test-${messageId}`]);
    await pool.query("insert into attachments(workspace_id,message_id,object_key,filename,mime_type,byte_size) values($1,$2,$3,'brief.pdf','application/pdf',128)", [workspaceId, messageId, `worker-test/${messageId}/brief.pdf`]);
    await worker.waitUntilReady(); const job: MessageJob = { workspaceId, messageId, conversationId, connectorId, externalChatId: "chat-test", channel: "api" };
    await Promise.all([queue.add("send:api", job, { jobId: `${messageId}-1` }), queue.add("send:api", job, { jobId: `${messageId}-2` })]);
    const state = await waitFor(async () => { const result = await pool.query("select status,external_id from messages where id=$1", [messageId]); return result.rows[0]?.status === "SENT" ? result.rows[0] : undefined; });
    assert.equal(state.external_id, "external-test-1"); assert.equal(received.length, 1); assert.match(received[0].body, /Hello from worker/); assert.match(received[0].signature ?? "", /^sha256=[0-9a-f]{64}$/); const outboundBody = JSON.parse(received[0].body); assert.equal(outboundBody.message.attachments.length, 1); assert.match(outboundBody.message.attachments[0].url, /brief\.pdf|X-Amz-/);
  } finally {
    await worker.close(); await queue.obliterate({ force: true }).catch(() => undefined); await queue.close();
    await pool.query("delete from conversations where id=$1", [conversationId]).catch(() => undefined); await pool.query("delete from contacts where id=$1", [contactId]).catch(() => undefined); await pool.query("delete from connectors where id=$1", [connectorId]).catch(() => undefined); await pool.query("delete from bots where id=$1", [botId]).catch(() => undefined); await pool.end(); await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
});
