import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import { PostgresStore } from "./postgres-store.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgresql://botcrm:botcrm_dev_password@localhost:5432/botcrm";
const workspaceId = "00000000-0000-4000-8000-000000000001";

test("automation engine is idempotent and commits CRM actions with a run journal", async () => {
  const store = new PostgresStore(databaseUrl);
  const suffix = randomUUID();
  const tagName = `automation-${suffix}`;
  const contact = await store.pool.query("insert into contacts(workspace_id,display_name) values($1,$2) returning id", [workspaceId, `Automation integration ${suffix}`]);
  let ruleId = "";
  try {
    const rule = await store.createAutomationRule("ws_demo", {
      name: `Integration ${suffix}`,
      triggerType: "contact.updated",
      conditionTree: { match: "all", conditions: [{ field: "attributes.score", operator: "gte", value: 80 }] },
      actions: [
        { type: "set_attribute", key: "qualified", value: true },
        { type: "add_tag", tag: tagName },
        { type: "create_task", title: "Позвонить лиду", dueMinutes: 30 },
      ],
    });
    ruleId = rule.id;
    const sourceEventId = `test:${suffix}`;
    const first = await store.processAutomationTrigger("ws_demo", "contact.updated", sourceEventId, { contactId: contact.rows[0].id, attributes: { score: 91 } });
    const duplicate = await store.processAutomationTrigger("ws_demo", "contact.updated", sourceEventId, { contactId: contact.rows[0].id, attributes: { score: 91 } });
    assert.deepEqual(first, { matched: 1, executed: 1 });
    assert.deepEqual(duplicate, { matched: 1, executed: 0 });
    const state = await store.pool.query("select custom_fields->>'qualified' qualified,(select count(*)::int from contact_tags ct join tags t on t.id=ct.tag_id where ct.contact_id=c.id and t.name=$2) tags,(select count(*)::int from tasks where contact_id=c.id) tasks from contacts c where c.id=$1", [contact.rows[0].id, tagName]);
    assert.deepEqual(state.rows[0], { qualified: "true", tags: 1, tasks: 1 });
    const runs = await store.listAutomationRuns("ws_demo", 20);
    const run = runs.find((item) => item.ruleId === ruleId);
    assert.equal(run?.status, "SUCCESS");
  } finally {
    if (ruleId) await store.deleteAutomationRule(ruleId, "ws_demo").catch(() => undefined);
    await store.pool.query("delete from tasks where contact_id=$1", [contact.rows[0].id]);
    await store.pool.query("delete from contact_tags where contact_id=$1", [contact.rows[0].id]);
    await store.pool.query("delete from tags where workspace_id=$1 and name=$2", [workspaceId, tagName]);
    await store.pool.query("delete from contacts where id=$1", [contact.rows[0].id]);
    await store.close();
  }
});

test("conversation.created is emitted once and executes its CRM action", async () => {
  const store = new PostgresStore(databaseUrl);
  const suffix = randomUUID();
  const tagName = "new-dialog-" + suffix;
  const eventId = "conversation-created-" + suffix;
  const externalId = "automation-user-" + suffix;
  const botSlug = "automation_bot_" + suffix.replaceAll("-", "");
  let ruleId = "";
  let contactId = "";
  let conversationId = "";
  try {
    const rule = await store.createAutomationRule("ws_demo", {
      name: "Новый диалог " + suffix,
      triggerType: "conversation.created",
      actions: [{ type: "add_tag", tag: tagName }],
    });
    ruleId = rule.id;
    const accepted = await store.ingest({
      event_id: eventId,
      schema_version: "1.0",
      occurred_at: new Date().toISOString(),
      workspace_id: "ws_demo",
      bot_id: botSlug,
      channel: "api",
      external_chat_id: externalId,
      external_user_id: externalId,
      type: "message.received",
      message: { text: "Первое сообщение" },
      profile: { name: "Новый контакт" },
    });
    contactId = accepted.contactId!;
    conversationId = accepted.conversationId!;
    const tagged = await store.pool.query("select count(*)::int count from contact_tags ct join tags t on t.id=ct.tag_id where ct.contact_id=$1 and t.name=$2", [contactId, tagName]);
    assert.equal(tagged.rows[0].count, 1);
    const runs = await store.listAutomationRuns("ws_demo", 50);
    assert.equal(runs.filter((run) => run.ruleId === ruleId && run.status === "SUCCESS").length, 1);

    await store.ingest({
      event_id: eventId + "-second",
      schema_version: "1.0",
      occurred_at: new Date().toISOString(),
      workspace_id: "ws_demo",
      bot_id: botSlug,
      channel: "api",
      external_chat_id: externalId,
      external_user_id: externalId,
      type: "message.received",
      message: { text: "Второе сообщение" },
    });
    const afterSecond = await store.listAutomationRuns("ws_demo", 50);
    assert.equal(afterSecond.filter((run) => run.ruleId === ruleId).length, 1);
  } finally {
    if (ruleId) await store.deleteAutomationRule(ruleId, "ws_demo").catch(() => undefined);
    if (conversationId) await store.pool.query("delete from messages where conversation_id=$1", [conversationId]).catch(() => undefined);
    if (conversationId) await store.pool.query("delete from conversations where id=$1", [conversationId]).catch(() => undefined);
    if (contactId) await store.pool.query("delete from contact_tags where contact_id=$1", [contactId]).catch(() => undefined);
    await store.pool.query("delete from tags where workspace_id=$1 and name=$2", [workspaceId, tagName]).catch(() => undefined);
    if (contactId) await store.pool.query("delete from channel_identities where contact_id=$1", [contactId]).catch(() => undefined);
    if (contactId) await store.pool.query("delete from contacts where id=$1", [contactId]).catch(() => undefined);
    await store.pool.query("delete from ingested_events where event_id in ($1,$2)", [eventId, eventId + "-second"]).catch(() => undefined);
    await store.pool.query("delete from bots where workspace_id=$1 and slug=$2", [workspaceId, botSlug]).catch(() => undefined);
    await store.close();
  }
});

test("manual contact updates trigger rules and missing action context is reported as failure", async () => {
  const store = new PostgresStore(databaseUrl);
  const suffix = randomUUID();
  const tagName = "qualified-" + suffix;
  const contact = await store.pool.query("insert into contacts(workspace_id,display_name) values($1,$2) returning id", [workspaceId, "Updated contact " + suffix]);
  let updateRuleId = "";
  let invalidRuleId = "";
  try {
    const updateRule = await store.createAutomationRule("ws_demo", {
      name: "Ручное обновление " + suffix,
      triggerType: "contact.updated",
      conditionTree: { match: "all", conditions: [{ field: "attributes.lead_score", operator: "gte", value: 80 }] },
      actions: [{ type: "add_tag", tag: tagName }],
    });
    updateRuleId = updateRule.id;
    await store.updateContact(contact.rows[0].id, "ws_demo", { attributes: { lead_score: 92 } });
    const tagged = await store.pool.query("select count(*)::int count from contact_tags ct join tags t on t.id=ct.tag_id where ct.contact_id=$1 and t.name=$2", [contact.rows[0].id, tagName]);
    assert.equal(tagged.rows[0].count, 1);

    const invalidRule = await store.createAutomationRule("ws_demo", {
      name: "Нет контекста " + suffix,
      triggerType: "campaign.failed",
      actions: [{ type: "add_tag", tag: "should-not-apply" }],
    });
    invalidRuleId = invalidRule.id;
    const result = await store.processAutomationTrigger("ws_demo", "campaign.failed", "missing-context-" + suffix, { status: "FAILED" });
    assert.deepEqual(result, { matched: 1, executed: 0 });
    const runs = await store.listAutomationRuns("ws_demo", 100);
    const failed = runs.find((run) => run.ruleId === invalidRuleId);
    assert.equal(failed?.status, "FAILED");
    assert.match(failed?.error ?? "", /requires a contact/);
  } finally {
    if (updateRuleId) await store.deleteAutomationRule(updateRuleId, "ws_demo").catch(() => undefined);
    if (invalidRuleId) await store.deleteAutomationRule(invalidRuleId, "ws_demo").catch(() => undefined);
    await store.pool.query("delete from contact_tags where contact_id=$1", [contact.rows[0].id]).catch(() => undefined);
    await store.pool.query("delete from tags where workspace_id=$1 and name=$2", [workspaceId, tagName]).catch(() => undefined);
    await store.pool.query("delete from contacts where id=$1", [contact.rows[0].id]).catch(() => undefined);
    await store.close();
  }
});
test("automation actions emit bounded follow-up events for chained rules", async () => {
  const store = new PostgresStore(databaseUrl);
  const suffix = randomUUID();
  const tagName = "chain-complete-" + suffix;
  const contact = await store.pool.query("insert into contacts(workspace_id,display_name) values($1,$2) returning id", [workspaceId, "Automation chain " + suffix]);
  const ruleIds: string[] = [];
  try {
    const first = await store.createAutomationRule("ws_demo", {
      name: "Первый шаг " + suffix,
      triggerType: "message.received",
      conditionTree: { match: "all", conditions: [{ field: "message.text", operator: "contains", value: "купить" }] },
      actions: [{ type: "set_attribute", key: "qualified", value: true }],
      maxDepth: 5,
    });
    ruleIds.push(first.id);
    const second = await store.createAutomationRule("ws_demo", {
      name: "Второй шаг " + suffix,
      triggerType: "contact.updated",
      conditionTree: { match: "all", conditions: [{ field: "attributes.qualified", operator: "equals", value: true }] },
      actions: [{ type: "add_tag", tag: tagName }],
      maxDepth: 5,
    });
    ruleIds.push(second.id);

    const result = await store.processAutomationTrigger("ws_demo", "message.received", "chain-source-" + suffix, { contactId: contact.rows[0].id, message: { text: "Хочу купить" } });
    assert.deepEqual(result, { matched: 1, executed: 1 });
    const state = await store.pool.query("select custom_fields->>'qualified' qualified,(select count(*)::int from contact_tags ct join tags t on t.id=ct.tag_id where ct.contact_id=c.id and t.name=$2) tags from contacts c where c.id=$1", [contact.rows[0].id, tagName]);
    assert.deepEqual(state.rows[0], { qualified: "true", tags: 1 });
    const runs = await store.listAutomationRuns("ws_demo", 100);
    assert.equal(runs.filter((run) => ruleIds.includes(run.ruleId) && run.status === "SUCCESS").length, 2);
  } finally {
    for (const ruleId of ruleIds) await store.deleteAutomationRule(ruleId, "ws_demo").catch(() => undefined);
    await store.pool.query("delete from contact_tags where contact_id=$1", [contact.rows[0].id]).catch(() => undefined);
    await store.pool.query("delete from tags where workspace_id=$1 and name=$2", [workspaceId, tagName]).catch(() => undefined);
    await store.pool.query("delete from contacts where id=$1", [contact.rows[0].id]).catch(() => undefined);
    await store.close();
  }
});
test("remaining UI automation actions mutate their real targets", async () => {
  const store = new PostgresStore(databaseUrl);
  const suffix = randomUUID();
  const botId = randomUUID();
  const connectorId = randomUUID();
  const botSlug = "automation_actions_" + suffix.replaceAll("-", "");
  const eventId = "automation-actions-" + suffix;
  const ruleIds: string[] = [];
  let contactId = "";
  let conversationId = "";
  let pipelineId = "";
  let dealId = "";
  try {
    await store.pool.query("insert into bots(id,workspace_id,slug,name,integration_mode) values($1,$2,$3,'Automation actions bot','MIRROR')", [botId, workspaceId, botSlug]);
    await store.pool.query("insert into connectors(id,workspace_id,bot_id,channel,encrypted_credentials,status) values($1,$2,$3,'api',$4,'CONNECTED')", [connectorId, workspaceId, botId, JSON.stringify({ outboundUrl: "https://example.test/messages", signingSecret: "test" })]);
    const ingested = await store.ingest({ event_id: eventId, schema_version: "1.0", occurred_at: new Date().toISOString(), workspace_id: "ws_demo", connector_id: connectorId, bot_id: botSlug, channel: "api", external_chat_id: "actions-chat-" + suffix, external_user_id: "actions-user-" + suffix, type: "message.received", message: { text: "Prepare actions" }, profile: { name: "Automation actions contact" } });
    contactId = ingested.contactId!;
    conversationId = ingested.conversationId!;

    const pipeline = await store.createPipeline("ws_demo", { name: "Automation pipeline " + suffix, stages: [{ name: "Начало" }, { name: "Готово", terminalKind: "WON" }] });
    pipelineId = pipeline.id;
    const deal = await store.createDeal("ws_demo", { contactId, pipelineId, stageId: pipeline.stages[0].slug, title: "Automation deal", amount: 5000 });
    dealId = deal.id;

    const definitions = [
      { key: "send", name: "Send " + suffix, actions: [{ type: "send_message" as const, text: "Автоматический ответ" }] },
      { key: "suppress", name: "Suppress " + suffix, actions: [{ type: "suppress_contact" as const, reason: "Automation test" }] },
      { key: "move", name: "Move " + suffix, actions: [{ type: "move_deal" as const, stage: pipeline.stages[1].slug }] },
      { key: "control", name: "Control " + suffix, actions: [{ type: "set_control" as const, mode: "HUMAN" as const }] },
    ];
    for (const definition of definitions) {
      const rule = await store.createAutomationRule("ws_demo", { name: definition.name, triggerType: "contact.updated", conditionTree: { match: "all", conditions: [{ field: "attributes.test_action", operator: "equals", value: definition.key }] }, actions: definition.actions });
      ruleIds.push(rule.id);
    }
    for (const definition of definitions) {
      const result = await store.processAutomationTrigger("ws_demo", "contact.updated", "action-" + definition.key + "-" + suffix, { contactId, conversationId, dealId, attributes: { test_action: definition.key } });
      if (result.executed !== 1) { const failedRuns = await store.listAutomationRuns("ws_demo", 100); const failed = failedRuns.find((run) => run.sourceEventId === "action-" + definition.key + "-" + suffix); assert.fail(definition.key + ": " + (failed?.error ?? "unknown failure")); }
      assert.deepEqual(result, { matched: 1, executed: 1 }, definition.key);
    }

    const state = await store.pool.query("select c.control_mode,(select count(*)::int from messages m where m.conversation_id=c.id and m.text_content='Автоматический ответ' and m.status='QUEUED') queued,(select count(*)::int from messages m where m.conversation_id=c.id and m.direction='SYSTEM') system_messages,(select count(*)::int from suppression_entries s where s.contact_id=c.contact_id) suppressed,(select st.slug from deals d join stages st on st.id=d.stage_id where d.id=$2) stage from conversations c where c.id=$1", [conversationId, dealId]);
    assert.equal(state.rows[0].control_mode, "HUMAN");
    assert.equal(state.rows[0].queued, 1);
    assert.ok(state.rows[0].system_messages >= 1);
    assert.equal(state.rows[0].suppressed, 1);
    assert.equal(state.rows[0].stage, pipeline.stages[1].slug);
  } finally {
    for (const ruleId of ruleIds) await store.deleteAutomationRule(ruleId, "ws_demo").catch(() => undefined);
    if (conversationId) await store.pool.query("delete from messages where conversation_id=$1", [conversationId]).catch(() => undefined);
    if (contactId) await store.pool.query("delete from suppression_entries where contact_id=$1", [contactId]).catch(() => undefined);
    if (dealId) await store.pool.query("delete from deals where id=$1", [dealId]).catch(() => undefined);
    if (pipelineId) await store.pool.query("delete from pipelines where id=$1", [pipelineId]).catch(() => undefined);
    if (conversationId) await store.pool.query("delete from conversations where id=$1", [conversationId]).catch(() => undefined);
    if (contactId) await store.pool.query("delete from channel_identities where contact_id=$1", [contactId]).catch(() => undefined);
    if (contactId) await store.pool.query("delete from contacts where id=$1", [contactId]).catch(() => undefined);
    await store.pool.query("delete from ingested_events where event_id=$1", [eventId]).catch(() => undefined);
    await store.pool.query("delete from connectors where id=$1", [connectorId]).catch(() => undefined);
    await store.pool.query("delete from bots where id=$1", [botId]).catch(() => undefined);
    await store.close();
  }
});
test("automation webhook enforces the allowlist and signs its payload", async () => {
  const store = new PostgresStore(databaseUrl);
  const suffix = randomUUID();
  const received: Array<{ body: string; signature?: string }> = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => body += chunk);
    request.on("end", () => {
      received.push({ body, signature: request.headers["x-botcrm-signature"] as string | undefined });
      response.writeHead(204);
      response.end();
    });
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Webhook test server did not bind");
  const previousAllowlist = process.env.AUTOMATION_WEBHOOK_ALLOWLIST;
  const previousSecret = process.env.AUTOMATION_WEBHOOK_SECRET;
  process.env.AUTOMATION_WEBHOOK_ALLOWLIST = "127.0.0.1";
  process.env.AUTOMATION_WEBHOOK_SECRET = "automation-test-secret";
  let ruleId = "";
  try {
    const rule = await store.createAutomationRule("ws_demo", {
      name: "Webhook " + suffix,
      triggerType: "contact.updated",
      actions: [{ type: "webhook", url: "http://127.0.0.1:" + address.port + "/automation" }],
    });
    ruleId = rule.id;
    const result = await store.processAutomationTrigger("ws_demo", "contact.updated", "webhook-" + suffix, { attributes: { test: true } });
    assert.deepEqual(result, { matched: 1, executed: 1 });
    assert.equal(received.length, 1);
    const payload = JSON.parse(received[0].body);
    assert.equal(payload.event, "automation.triggered");
    assert.equal(payload.ruleId, ruleId);
    const expected = "sha256=" + createHmac("sha256", "automation-test-secret").update(received[0].body).digest("hex");
    assert.equal(received[0].signature, expected);
  } finally {
    if (ruleId) await store.deleteAutomationRule(ruleId, "ws_demo").catch(() => undefined);
    if (previousAllowlist === undefined) delete process.env.AUTOMATION_WEBHOOK_ALLOWLIST; else process.env.AUTOMATION_WEBHOOK_ALLOWLIST = previousAllowlist;
    if (previousSecret === undefined) delete process.env.AUTOMATION_WEBHOOK_SECRET; else process.env.AUTOMATION_WEBHOOK_SECRET = previousSecret;
    await store.close();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
});