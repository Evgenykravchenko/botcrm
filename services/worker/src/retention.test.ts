import assert from "node:assert/strict";
import test from "node:test";
import { runRetention } from "./retention.js";

test("retention applies every configured boundary without deleting message history", async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    async query(sql: string, params: unknown[]) {
      calls.push({ sql, params });
      return { rowCount: calls.length };
    },
  };
  const result = await runRetention(pool as never, {
    rawWebhookDays: 31,
    ingestedEventDays: 32,
    processedOutboxDays: 8,
    auditDays: 366,
  });
  assert.deepEqual(calls.map((call) => call.params[0]), [31, 32, 8, 366]);
  assert.match(calls[0].sql, /^update messages set payload=/);
  assert.ok(calls.slice(1).every((call) => call.sql.startsWith("delete from")));
  assert.deepEqual(result, { rawPayloadsStripped: 1, ingestedEventsDeleted: 2, outboxEventsDeleted: 3, auditEventsDeleted: 4 });
});
