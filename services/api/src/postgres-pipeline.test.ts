import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { DomainError } from "./core.js";
import { PostgresStore } from "./postgres-store.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgresql://botcrm:botcrm_dev_password@localhost:5432/botcrm";

test("pipeline, stages and deals are configurable with optimistic versions", async () => {
  const store = new PostgresStore(databaseUrl); await store.init(); let pipelineId: string | undefined, contactId: string | undefined, dealId: string | undefined;
  try {
    const pipeline = await store.createPipeline("ws_demo", { name: `Custom pipeline ${randomUUID()}`, stages: [{ name: "Входящие" }, { name: "Готово", terminalKind: "WON" }] }); pipelineId = pipeline.id; assert.equal(pipeline.stages.length, 2);
    const extra = await store.createStage(pipelineId!, "ws_demo", { name: "Согласование", color: "#ffaa00" }); assert.equal(extra.position, 2);
    await store.updateStage(extra.id, "ws_demo", { position: 0 }); const reordered = (await store.listPipelines("ws_demo")).find((item) => item.id === pipelineId); assert.equal(reordered?.stages[0].id, extra.id);
    const contact = await store.createContact("ws_demo", { displayName: `Pipeline Contact ${randomUUID()}` }); contactId = contact.id;
    const deal = await store.createDeal("ws_demo", { contactId: contactId!, pipelineId: pipelineId!, stageId: pipeline.stages[0].slug, title: "Новая сделка", amount: 12500 }); dealId = deal.id; assert.equal(deal.amount, 12500); const persisted = await store.pool.query("select assigned_user_id from deals where id=$1", [deal.id]); assert.equal(persisted.rows[0].assigned_user_id, null);
    const updated = await store.updateDeal(dealId!, "ws_demo", { title: "Обновлённая сделка", amount: 14000, expectedVersion: deal.version }); assert.equal(updated.version, 2); assert.equal(updated.amount, 14000);
    await assert.rejects(() => store.updateDeal(dealId!, "ws_demo", { amount: 1, expectedVersion: deal.version }), (error: unknown) => error instanceof DomainError && error.code === "deal_version_conflict");
    await assert.rejects(() => store.deleteStage(pipeline.stages[0].id, "ws_demo"), (error: unknown) => error instanceof DomainError && error.code === "stage_in_use");
  } finally {
    if (dealId) await store.pool.query("delete from deals where id=$1", [dealId]).catch(() => undefined); if (contactId) await store.pool.query("delete from contacts where id=$1", [contactId]).catch(() => undefined); if (pipelineId) await store.pool.query("delete from pipelines where id=$1", [pipelineId]).catch(() => undefined); await store.close();
  }
});
