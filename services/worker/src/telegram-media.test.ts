import assert from "node:assert/strict";
import test from "node:test";
import { telegramMediaForm } from "./telegram-media.js";

test("Telegram media is uploaded as multipart bytes instead of a private storage URL", async () => {
  const form = await telegramMediaForm({
    chatId: "12345",
    attachment: {
      url: "data:image/png;base64,iVBORw0KGgo=",
      filename: "offer.png",
      mimeType: "image/png",
    },
    field: "photo",
    caption: "Personal offer",
    replyMarkup: { inline_keyboard: [[{ text: "Open", url: "https://example.com" }]] },
  });

  assert.equal(form.get("chat_id"), "12345");
  assert.equal(form.get("caption"), "Personal offer");
  assert.deepEqual(JSON.parse(String(form.get("reply_markup"))), { inline_keyboard: [[{ text: "Open", url: "https://example.com" }]] });
  const photo = form.get("photo");
  assert.ok(photo instanceof Blob);
  assert.equal(photo.type, "image/png");
  assert.equal(photo.size, 8);
  assert.equal((photo as File).name, "offer.png");
});
