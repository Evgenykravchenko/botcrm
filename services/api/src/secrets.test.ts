import assert from "node:assert/strict";
import test from "node:test";
import { decryptSecret, encryptSecret } from "./secrets.js";

test("connector credentials use authenticated encryption", () => {
  const previous = process.env.MASTER_ENCRYPTION_KEY;
  process.env.MASTER_ENCRYPTION_KEY = "test-key-that-is-at-least-thirty-two-characters-long";
  try {
    const encrypted = encryptSecret({ botToken: "123:secret", endpoint: "https://example.com" });
    assert.equal(encrypted.alg, "aes-256-gcm");
    assert.equal(JSON.stringify(encrypted).includes("123:secret"), false);
    assert.deepEqual(decryptSecret(encrypted), { botToken: "123:secret", endpoint: "https://example.com" });
  } finally {
    if (previous === undefined) delete process.env.MASTER_ENCRYPTION_KEY; else process.env.MASTER_ENCRYPTION_KEY = previous;
  }
});
