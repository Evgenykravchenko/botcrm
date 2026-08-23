export interface TelegramMediaSource {
  url: string;
  filename: string;
  mimeType: string;
}

export async function telegramMediaForm(input: {
  chatId: string;
  attachment: TelegramMediaSource;
  field: "photo" | "video" | "audio" | "document";
  caption?: string;
  replyMarkup?: unknown;
}) {
  const source = await fetch(input.attachment.url, { signal: AbortSignal.timeout(30_000) });
  if (!source.ok) throw new Error(`Media storage returned ${source.status}`);
  const bytes = await source.arrayBuffer();
  const form = new FormData();
  form.append("chat_id", input.chatId);
  form.append(input.field, new Blob([bytes], { type: input.attachment.mimeType }), input.attachment.filename);
  if (input.caption) form.append("caption", input.caption);
  if (input.replyMarkup) form.append("reply_markup", JSON.stringify(input.replyMarkup));
  return form;
}
