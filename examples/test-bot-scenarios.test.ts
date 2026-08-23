import assert from "node:assert/strict";
import test from "node:test";
import { commandOf, scenarioFor } from "./test-bot-scenarios.js";

test("test bot commands are channel-independent", () => {
  assert.equal(commandOf("/BUY@sample_bot now"), "/buy");
  assert.equal(scenarioFor("/price", "vk_test_bot").attributes.lead_score, 70);
  assert.equal(scenarioFor("хочу купить", "vk_test_bot").attributes.intent, "purchase");
  assert.equal(scenarioFor("нужна поддержка", "vk_test_bot").handoff, true);
});

test("test bot records the configured source for onboarding and free text", () => {
  assert.equal(scenarioFor("/start", "vk_custom_bot").attributes.source, "vk_custom_bot");
  assert.equal(scenarioFor("обычное сообщение", "telegram_custom_bot").attributes.source, "telegram_custom_bot");
});
