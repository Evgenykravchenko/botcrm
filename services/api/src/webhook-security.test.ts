import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { ApiController } from "./app.js";
import { DomainError } from "./core.js";

function signature(body: string, secret: string) {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

test("official webhook resolves tenant from connector and verifies the raw request", async () => {
  const ingested: any[] = [];
  const queued: any[] = [];
  const core = {
    async webhookConnector() {
      return { workspaceId: "workspace-from-connector", botId: "bot-from-connector", credentials: { appSecret: "meta-secret" } };
    },
    async ingest(event: any) {
      ingested.push(event);
      return { workspaceId: event.workspace_id, outboxEventId: "outbox-1" };
    },
  };
  const queue = { async enqueueBotEvent(job: any) { queued.push(job); } };
  const controller = new ApiController(core as never, queue as never);
  const payload = { entry: [{ changes: [{ value: { messages: [{ id: "wamid.1", from: "79990000000", timestamp: "1787200000", type: "text", text: { body: "hello" } }] } }] }] };
  const rawBody = JSON.stringify(payload);

  await assert.rejects(
    controller.receiveWebhook("whatsapp", "connector-1", payload, { "x-hub-signature-256": "sha256=invalid" }, { rawBody: Buffer.from(rawBody) }),
    (error: unknown) => error instanceof DomainError && error.code === "invalid_webhook_signature",
  );
  const result = await controller.receiveWebhook("whatsapp", "connector-1", payload, { "x-hub-signature-256": signature(rawBody, "meta-secret"), "x-workspace-id": "forged" }, { rawBody: Buffer.from(rawBody) });
  if (typeof result === "string") assert.fail("Expected normalized webhook result");
  assert.equal(result.accepted, 1);
  assert.equal(ingested[0].workspace_id, "workspace-from-connector");
  assert.equal(ingested[0].bot_id, "bot-from-connector");
  assert.equal(ingested[0].connector_id, "connector-1");
  assert.deepEqual(queued, [{ workspaceId: "workspace-from-connector", outboxId: "outbox-1" }]);
});

test("channel-specific verification covers Telegram, VK and WhatsApp challenge", async () => {
  const core = {
    async webhookConnector(_id: string, channel: string) {
      if (channel === "telegram") return { workspaceId: "ws", botId: "bot", credentials: { webhookSecret: "telegram-secret" } };
      if (channel === "vk") return { workspaceId: "ws", botId: "bot", credentials: { confirmationSecret: "vk-secret", confirmationCode: "vk-code" } };
      return { workspaceId: "ws", botId: "bot", credentials: { verifyToken: "verify-me" } };
    },
    async ingest() { return {}; },
  };
  const controller = new ApiController(core as never, { enqueueBotEvent: async () => undefined } as never);
  await assert.rejects(controller.receiveWebhook("telegram", "tg", {}, {}, {}), (error: unknown) => error instanceof DomainError && error.code === "invalid_webhook_secret");
  assert.equal(await controller.receiveWebhook("vk", "vk", { type: "confirmation", secret: "vk-secret" }, {}, {}), "vk-code");
  assert.equal(await controller.verifyWhatsApp("wa", "subscribe", "verify-me", "123456789"), 123456789);
  await assert.rejects(controller.verifyWhatsApp("wa", "subscribe", "wrong", "123456789"), (error: unknown) => error instanceof DomainError && error.code === "invalid_webhook_verification");
  await assert.rejects(controller.verifyWhatsApp("wa", "subscribe", "verify-me", "<script>alert(1)</script>"), (error: unknown) => error instanceof DomainError && error.code === "invalid_webhook_challenge");
});
test("webhook fails closed when a connector has no verification secret", async () => {
  const core = {
    async webhookConnector() { return { workspaceId: "ws", botId: "bot", credentials: {} }; },
    async ingest() { assert.fail("Unsigned webhook must not be ingested"); },
  };
  const controller = new ApiController(core as never, { enqueueBotEvent: async () => undefined } as never);
  await assert.rejects(
    controller.receiveWebhook("telegram", "tg-without-secret", {}, {}, {}),
    (error: unknown) => error instanceof DomainError && error.status === 503 && error.code === "webhook_secret_missing",
  );
});
