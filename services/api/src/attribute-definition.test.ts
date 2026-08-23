import test from "node:test";
import assert from "node:assert/strict";
import { humanizeAttributeKey, inferAttributeValueType, validateAttributeDefinition } from "./attribute-definition.js";

test("infers types for arbitrary bot attributes", () => {
  assert.equal(inferAttributeValueType(95), "NUMBER");
  assert.equal(inferAttributeValueType(true), "BOOLEAN");
  assert.equal(inferAttributeValueType(["vip", "paid"]), "MULTISELECT");
  assert.equal(inferAttributeValueType({ plan: "pro" }), "JSON");
  assert.equal(inferAttributeValueType("purchase"), "STRING");
});

test("validates a registry definition without imposing business keys", () => {
  const value = validateAttributeDefinition({ objectScope: "CONTACT", key: "my_bot.score-v2", label: "Bot score", valueType: "NUMBER", authority: "BOT", filterable: true });
  assert.equal(value.key, "my_bot.score-v2");
  assert.equal(humanizeAttributeKey("requested_plan"), "Запрошенный тариф");
  assert.equal(humanizeAttributeKey("custom_delivery_zone"), "Custom delivery zone");
  assert.throws(() => validateAttributeDefinition({ objectScope: "CONTACT", key: "bad key", label: "Bad", valueType: "STRING", authority: "BOT" }));
});
