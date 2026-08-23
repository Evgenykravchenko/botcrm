import assert from "node:assert/strict";
import test from "node:test";
import { validateCampaignContent } from "./campaign-content.js";

test("Telegram campaign accepts button rows, links and multiple images", () => {
  const result = validateCampaignContent("telegram", { content: "Hello", buttons: [{ text: "Open", type: "url", value: "https://example.com", row: 0 }, { text: "Buy", type: "callback", value: "buy", row: 1 }], mediaIds: ["one", "two"] });
  assert.equal(result.buttons.length, 2);
  assert.deepEqual(result.mediaIds, ["one", "two"]);
});

test("WhatsApp campaign enforces interactive-message constraints", () => {
  assert.throws(() => validateCampaignContent("whatsapp", { content: "Hello", buttons: [{ text: "Open", type: "url", value: "https://example.com", row: 0 }] }), /does not support URL buttons/);
  assert.throws(() => validateCampaignContent("whatsapp", { content: "Hello", mediaIds: ["one", "two"] }), /at most 1 campaign images/);
});

test("Avito rejects unsupported campaign controls", () => {
  assert.throws(() => validateCampaignContent("avito", { content: "Hello", buttons: [{ text: "Buy", type: "callback", value: "buy", row: 0 }] }), /at most 0 campaign buttons/);
});
