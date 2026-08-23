import assert from "node:assert/strict";
import test from "node:test";
import { automationMatches, validateAutomationRule } from "./automation.js";
import { DomainError } from "./core.js";

test("automation conditions support nested values and numeric comparisons", () => {
  const context = { message: { text: "Хочу купить тариф" }, attributes: { lead_score: 91 }, tags: ["vip", "hot"] };
  assert.equal(automationMatches({ match: "all", conditions: [
    { field: "message.text", operator: "contains", value: "купить" },
    { field: "attributes.lead_score", operator: "gte", value: 80 },
    { field: "tags", operator: "contains", value: "VIP" },
  ] }, context), true);
  assert.equal(automationMatches({ match: "any", conditions: [
    { field: "attributes.lead_score", operator: "lt", value: 10 },
    { field: "missing", operator: "not_exists" },
  ] }, context), true);
});

test("automation validation normalizes defaults and rejects unsafe input", () => {
  const valid = validateAutomationRule({ name: "Горячий лид", triggerType: "message.received", actions: [{ type: "add_tag", tag: "горячий" }] });
  assert.equal(valid.enabled, true);
  assert.equal(valid.maxDepth, 5);
  assert.deepEqual(valid.conditionTree, { match: "all", conditions: [] });
  assert.throws(() => validateAutomationRule({ name: "x", triggerType: "message.received", actions: [{ type: "add_tag", tag: "ok" }] }), (error: unknown) => error instanceof DomainError && error.code === "invalid_automation_name");
  assert.throws(() => validateAutomationRule({ name: "Bad webhook", triggerType: "message.received", actions: [{ type: "webhook", url: "file:///etc/passwd" }] }), (error: unknown) => error instanceof DomainError && error.code === "invalid_automation_action");
});
