import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PostgresStore } from "./postgres-store.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgresql://botcrm:botcrm_dev_password@localhost:5432/botcrm";
const workspaceId = "00000000-0000-4000-8000-000000000001";

test("contact CRM operations persist fields, tags, activity, merge and anonymization", async () => {
  const store = new PostgresStore(databaseUrl); await store.init(); const suffix = randomUUID(); let targetId: string | undefined, sourceId: string | undefined;
  try {
    const target = await store.createContact("ws_demo", { displayName: `CRM Target ${suffix}`, phone: `+7999${suffix.replaceAll("-", "").slice(0, 7)}`, city: "Омск", attributes: { score: 10 } }); targetId = target.id;
    const source = await store.createContact("ws_demo", { displayName: `CRM Source ${suffix}`, email: `${suffix}@example.test`, attributes: { source_key: suffix } }); sourceId = source.id;
    const updated = await store.updateContact(targetId!, "ws_demo", { attributes: { score: 95 }, city: "Москва" }); assert.equal(updated.attributes.score, 95); assert.equal(updated.city, "Москва");
    const tagged = await store.setContactTags(targetId!, "ws_demo", ["VIP", "Горячий"]); assert.deepEqual(tagged.tags, ["VIP", "Горячий"]);
    await store.addContactNote(targetId!, "ws_demo", "Позвонить после обеда"); const task = await store.addContactTask(targetId!, "ws_demo", { title: "Подготовить предложение" }); await store.completeContactTask(task.id, "ws_demo");
    const activity = await store.listContactActivity(targetId!, "ws_demo"); assert.equal(activity.notes[0].body, "Позвонить после обеда"); assert.ok(activity.tasks[0].completedAt);
    const merged = await store.mergeContacts(targetId!, sourceId!, "ws_demo"); assert.equal(merged.attributes.source_key, suffix); assert.equal(merged.email, `${suffix}@example.test`);
    assert.equal((await store.anonymizeContact(targetId!, "ws_demo")).ok, true); const hidden = await store.listContacts("ws_demo"); const anonymized = hidden.find((item) => item.id === targetId); assert.ok(anonymized?.displayName.startsWith("Удалённый контакт")); assert.equal(anonymized?.phone, undefined);
  } finally {
    for (const id of [targetId, sourceId].filter(Boolean) as string[]) { await store.pool.query("delete from suppression_entries where contact_id=$1", [id]).catch(() => undefined); await store.pool.query("delete from notes where contact_id=$1", [id]).catch(() => undefined); await store.pool.query("delete from tasks where contact_id=$1", [id]).catch(() => undefined); await store.pool.query("delete from contact_tags where contact_id=$1", [id]).catch(() => undefined); await store.pool.query("delete from contacts where id=$1", [id]).catch(() => undefined); await store.pool.query("delete from audit_events where workspace_id=$1 and entity_id=$2", [workspaceId, id]).catch(() => undefined); } await store.close();
  }
});
