import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { AssistantStore } from "./assistant-store.js";

test("assistant budget reservations are atomic, scoped and idempotent in PostgreSQL", async () => {
  process.env.MASTER_ENCRYPTION_KEY =
    "synthetic-assistant-database-test-master-key";
  const pool = new Pool({
    connectionString:
      process.env.DATABASE_URL ??
      "postgresql://botcrm:botcrm_dev_password@localhost:5432/botcrm",
    max: 6,
  });
  const workspace = randomUUID(),
    other = randomUUID(),
    user = randomUUID();
  const store = new AssistantStore(pool);
  try {
    await pool.query(
      "insert into workspaces(id,name) values($1,'Assistant test'),($2,'Other assistant test')",
      [workspace, other],
    );
    await pool.query(
      "insert into users(id,workspace_id,email,display_name,role) values($1,$2,'fixture@example.test','Fixture','OWNER')",
      [user, workspace],
    );
    await store.save(workspace, user, {
      enabled: true,
      provider: "openai",
      apiKey: "synthetic-api-key-value",
      monthlyBudgetUsd: 0.1,
      dailyUserLimit: 2,
    });
    const settings = await store.settings(workspace);
    assert.equal(settings.hasKey, true);
    assert.ok(
      !JSON.stringify(settings.encryptedCredentials).includes(
        "synthetic-api-key-value",
      ),
    );
    assert.equal((await store.settings(other)).hasKey, false);
    const id = randomUUID();
    const concurrent = await Promise.allSettled([
      store.reserve(
        workspace,
        user,
        id,
        "same-hash",
        "fixture",
        settings,
        60_000,
      ),
      store.reserve(
        workspace,
        user,
        id,
        "same-hash",
        "fixture",
        settings,
        60_000,
      ),
    ]);
    assert.equal(concurrent.filter((x) => x.status === "fulfilled").length, 1);
    assert.equal((await store.usage(workspace, user)).monthSpentUsd, 0.06);
    await store.fail(workspace, id);
    assert.equal((await store.usage(workspace, user)).monthSpentUsd, 0.06);
    await assert.rejects(
      () =>
        store.reserve(
          workspace,
          user,
          randomUUID(),
          "new",
          "fixture",
          settings,
          60_000,
        ),
      (e: any) => e.code === "assistant_budget_exceeded",
    );
    const second = randomUUID();
    await store.reserve(
      workspace,
      user,
      second,
      "second",
      "fixture",
      settings,
      30_000,
    );
    const result = {
      requestId: second,
      text: "Verified",
      usage: { inputTokens: 1000, outputTokens: 100, costUsd: 0.00015 },
    };
    await store.finish(workspace, second, result, 150);
    assert.equal(
      (
        await store.reserve(
          workspace,
          user,
          second,
          "second",
          "fixture",
          settings,
          30_000,
        )
      )?.text,
      "Verified",
    );
    await assert.rejects(
      () =>
        store.reserve(
          workspace,
          user,
          second,
          "different-hash",
          "fixture",
          settings,
          30_000,
        ),
      (e: any) => e.code === "assistant_request_conflict",
    );
    await assert.rejects(
      () =>
        store.reserve(
          workspace,
          user,
          randomUUID(),
          "third",
          "fixture",
          settings,
          100,
        ),
      (e: any) => e.code === "assistant_daily_limit",
    );
    assert.equal((await store.usage(workspace, user)).monthSpentUsd, 0.06015);
    const audit = await pool.query(
      "select changes from audit_events where workspace_id=$1 and action='assistant.settings_updated'",
      [workspace],
    );
    assert.ok(!JSON.stringify(audit.rows).includes("synthetic-api-key-value"));
    await store.save(workspace, user, {
      enabled: true,
      provider: "openai",
      monthlyBudgetUsd: 0.1,
      dailyUserLimit: 10,
    });
    const malformed = randomUUID();
    await store.reserve(
      workspace,
      user,
      malformed,
      "malformed",
      "fixture",
      await store.settings(workspace),
      30000,
    );
    await store.fail(workspace, malformed, {
      cost: 80,
      inputTokens: 500,
      outputTokens: 60,
    });
    const failed = (
      await pool.query(
        "select status,cost_micros,input_tokens,output_tokens from assistant_requests where workspace_id=$1 and request_id=$2",
        [workspace, malformed],
      )
    ).rows[0];
    assert.equal(failed.status, "failed");
    assert.equal(Number(failed.cost_micros), 80);
    assert.equal(failed.input_tokens, 500);
    assert.equal(failed.output_tokens, 60);
  } finally {
    await pool.query("delete from workspaces where id in ($1,$2)", [
      workspace,
      other,
    ]);
    await pool.end();
  }
});
