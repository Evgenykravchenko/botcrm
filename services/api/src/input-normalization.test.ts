import assert from "node:assert/strict";
import test from "node:test";
import { isSafeWebhookChallenge, normalizeBotSlug } from "./input-normalization.js";

test("bot slugs are normalized without ambiguous edge separators", () => {
  assert.equal(normalizeBotSlug("  My custom bot  "), "my_custom_bot");
  assert.equal(normalizeBotSlug("___Sales__Bot___"), "sales__bot");
  assert.equal(normalizeBotSlug("---"), "");
});

test("webhook challenges only accept a bounded safe character set", () => {
  assert.equal(isSafeWebhookChallenge("challenge-42_A.b~c"), true);
  assert.equal(isSafeWebhookChallenge("<script>alert(1)</script>"), false);
  assert.equal(isSafeWebhookChallenge("x".repeat(257)), false);
});
