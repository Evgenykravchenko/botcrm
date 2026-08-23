import assert from "node:assert/strict";
import test from "node:test";
import { normalizeBotSlug, parseWebhookChallenge } from "./input-normalization.js";

test("bot slugs are normalized without ambiguous edge separators", () => {
  assert.equal(normalizeBotSlug("  My custom bot  "), "my_custom_bot");
  assert.equal(normalizeBotSlug("___Sales__Bot___"), "sales__bot");
  assert.equal(normalizeBotSlug("---"), "");
});

test("webhook challenges only accept canonical safe integers", () => {
  assert.equal(parseWebhookChallenge("123456789"), 123456789);
  assert.equal(parseWebhookChallenge("00123"), undefined);
  assert.equal(parseWebhookChallenge("<script>alert(1)</script>"), undefined);
  assert.equal(parseWebhookChallenge("9".repeat(16)), undefined);
});
