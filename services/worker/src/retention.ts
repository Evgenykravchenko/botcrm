import { Pool } from "pg";

export type RetentionPolicy = {
  rawWebhookDays: number;
  ingestedEventDays: number;
  processedOutboxDays: number;
  auditDays: number;
};

function positiveDays(value: string | undefined, fallback: number) {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : fallback;
}

export function retentionPolicyFromEnv(): RetentionPolicy {
  return {
    rawWebhookDays: positiveDays(process.env.RAW_WEBHOOK_RETENTION_DAYS, 30),
    ingestedEventDays: positiveDays(process.env.INGESTED_EVENT_RETENTION_DAYS, 30),
    processedOutboxDays: positiveDays(process.env.PROCESSED_OUTBOX_RETENTION_DAYS, 7),
    auditDays: positiveDays(process.env.AUDIT_RETENTION_DAYS, 365),
  };
}

export async function runRetention(pool: Pick<Pool, "query">, policy = retentionPolicyFromEnv()) {
  const raw = await pool.query(
    "update messages set payload=payload-'raw' where occurred_at<now()-make_interval(days=>$1::int) and payload ? 'raw'",
    [policy.rawWebhookDays],
  );
  const ingested = await pool.query(
    "delete from ingested_events where received_at<now()-make_interval(days=>$1::int)",
    [policy.ingestedEventDays],
  );
  const outbox = await pool.query(
    "delete from outbox_events where processed_at is not null and processed_at<now()-make_interval(days=>$1::int)",
    [policy.processedOutboxDays],
  );
  const audit = await pool.query(
    "delete from audit_events where occurred_at<now()-make_interval(days=>$1::int)",
    [policy.auditDays],
  );
  return {
    rawPayloadsStripped: raw.rowCount ?? 0,
    ingestedEventsDeleted: ingested.rowCount ?? 0,
    outboxEventsDeleted: outbox.rowCount ?? 0,
    auditEventsDeleted: audit.rowCount ?? 0,
  };
}
