import { createHmac } from "node:crypto";
import { Job, UnrecoverableError } from "bullmq";
import { Pool } from "pg";
import { decryptCredentials } from "./secrets.js";

export interface BotEventJob { workspaceId: string; outboxId: string }

class BotEventDeliveryError extends Error {
  constructor(message: string, readonly permanent = false, readonly retryAfterMs?: number) { super(message); }
}

function assertEndpoint(value: string) {
  const url = new URL(value);
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(local || process.env.BOT_EVENT_ALLOW_HTTP === "true")) {
    throw new BotEventDeliveryError("Bot event endpoint must use HTTPS", true);
  }
  return url;
}

export function botEventProcessor(pool: Pool) {
  return async (job: Job<BotEventJob>) => {
    const client = await pool.connect();
    let transactionOpen = false;
    try {
      await client.query("begin"); transactionOpen = true;
      const result = await client.query(`select o.*,b.event_endpoint,b.enabled,cn.encrypted_credentials
        from outbox_events o
        join connectors cn on cn.id=(o.payload->>'connectorId')::uuid and cn.workspace_id=o.workspace_id
        join bots b on b.id=cn.bot_id
        where o.id=$1 and o.workspace_id=$2 and o.topic='bot.event' for update of o`, [job.data.outboxId, job.data.workspaceId]);
      if (!result.rowCount) { await client.query("commit"); transactionOpen = false; return { skipped: "outbox_missing" }; }
      const row = result.rows[0];
      if (row.processed_at) { await client.query("commit"); transactionOpen = false; return { skipped: "already_delivered" }; }
      if (!row.enabled || !row.event_endpoint) throw new BotEventDeliveryError("Bot event endpoint is not configured or bot is disabled", true);
      const endpoint = assertEndpoint(row.event_endpoint);
      const credentials = decryptCredentials(row.encrypted_credentials);
      const secret = credentials.signingSecret ?? credentials.webhookSecret ?? credentials.secret ?? process.env.BOT_EVENT_SIGNING_SECRET ?? process.env.SERVICE_TOKEN;
      if (!secret) throw new BotEventDeliveryError("Outgoing bot webhook signing secret is not configured", true);
      const event = row.payload.event as Record<string, unknown>;
      const body = JSON.stringify(event);
      try {
        const response = await fetch(endpoint, { method: "POST", redirect: "error", signal: AbortSignal.timeout(12_000), headers: {
          "content-type": "application/json", "user-agent": "BotCRM-Gateway/1.0",
          "x-botcrm-event-id": String(event.event_id ?? row.aggregate_id),
          "x-botcrm-delivery-id": String(row.id),
          "x-botcrm-timestamp": String(Math.floor(Date.now() / 1000)),
          "x-botcrm-signature": `sha256=${createHmac("sha256", String(secret)).update(body).digest("hex")}`,
        }, body });
        if (response.status === 429) throw new BotEventDeliveryError("Bot endpoint rate limit", false, Math.max(1, Number(response.headers.get("retry-after") ?? 2)) * 1_000);
        if (response.status >= 500) throw new BotEventDeliveryError(`Bot endpoint temporary error ${response.status}`);
        if (!response.ok) throw new BotEventDeliveryError(`Bot endpoint rejected event with ${response.status}`, true);
        await client.query("update outbox_events set processed_at=now(),attempt_count=attempt_count+1,last_error=null where id=$1", [row.id]);
        await client.query("insert into audit_events(workspace_id,actor_type,action,entity_type,entity_id,changes) values($1,'SERVICE','bot_event.delivered','outbox_event',$2,$3)", [row.workspace_id, row.id, JSON.stringify({ eventId: event.event_id, status: response.status })]);
        await client.query("commit"); transactionOpen = false;
        return { delivered: true, status: response.status };
      } catch (error) {
        const deliveryError = error instanceof BotEventDeliveryError ? error : new BotEventDeliveryError(error instanceof Error ? error.message : String(error));
        await client.query("update outbox_events set attempt_count=attempt_count+1,last_error=$2,available_at=now()+interval '5 seconds' where id=$1", [row.id, deliveryError.message.slice(0, 1000)]);
        await client.query("commit"); transactionOpen = false;
        if (deliveryError.permanent) throw new UnrecoverableError(deliveryError.message);
        throw deliveryError;
      }
    } catch (error) {
      if (transactionOpen) await client.query("rollback").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  };
}
