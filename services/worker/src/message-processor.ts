import { createHmac } from "node:crypto";
import { Job } from "bullmq";
import { Pool } from "pg";
import { attachmentUrl } from "./media-url.js";
import { decryptCredentials } from "./secrets.js";
import { telegramMediaForm } from "./telegram-media.js";

export interface MessageJob { workspaceId: string; messageId: string; conversationId: string; connectorId: string; externalChatId: string; channel: string }
interface DeliveryAttachment { url: string; mimeType: string; filename: string }
interface DeliveryButton { id?: string; text: string; type: "callback" | "url"; value: string; row: number }
class MessageDeliveryError extends Error { constructor(message: string, readonly permanent = false, readonly retryAfterMs?: number) { super(message); } }

async function channelRequest(url: string, init: RequestInit) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  const payload = await response.json().catch(() => ({})) as Record<string, any>;
  const detail = String(payload.description ?? payload.error?.message ?? "").slice(0, 500);
  if (response.status === 429) throw new MessageDeliveryError(detail || "Channel rate limit", false, Math.max(1, Number(response.headers.get("retry-after") ?? payload.parameters?.retry_after ?? 2)) * 1_000);
  if (response.status >= 500) throw new MessageDeliveryError(detail || `Channel temporary error ${response.status}`);
  if (!response.ok) throw new MessageDeliveryError(detail ? `Channel rejected message with ${response.status}: ${detail}` : `Channel rejected message with ${response.status}`, true);
  return payload;
}

function externalId(body: Record<string, any>) { return String(body.result?.message_id ?? body.result ?? body.messages?.[0]?.id ?? body.id ?? "") || undefined; }

function buttonRows(buttons: DeliveryButton[]) {
  const rows = new Map<number, DeliveryButton[]>();
  buttons.forEach((button) => rows.set(button.row, [...(rows.get(button.row) ?? []), button]));
  return [...rows.entries()].sort(([left], [right]) => left - right).map(([, row]) => row);
}

async function sendOfficial(channel: string, credentials: Record<string, any>, chatId: string, text: string, attachments: DeliveryAttachment[], buttons: DeliveryButton[] = []) {
  const responses: Record<string, any>[] = [];
  if (channel === "telegram") {
    const token = credentials.botToken ?? credentials.bot_token; if (!token) throw new MessageDeliveryError("Telegram bot token is not configured", true);
    const replyMarkup = buttons.length ? { inline_keyboard: buttonRows(buttons).map((row) => row.map((button) => button.type === "url" ? { text: button.text, url: button.value } : { text: button.text, callback_data: button.value })) } : undefined;
    const firstImage = attachments[0]?.mimeType.startsWith("image/") ? attachments[0] : undefined;
    if (firstImage && buttons.length && text.length <= 1024) {
      const form = await telegramMediaForm({ chatId, attachment: firstImage, field: "photo", caption: text, replyMarkup });
      responses.push(await channelRequest(`https://api.telegram.org/bot${token}/sendPhoto`, { method: "POST", body: form }));
      attachments = attachments.slice(1);
    } else if (text) {
      responses.push(await channelRequest(`https://api.telegram.org/bot${token}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chatId, text, ...(replyMarkup ? { reply_markup: replyMarkup } : {}) }) }));
    }
    for (const attachment of attachments) {
      const image = attachment.mimeType.startsWith("image/"); const video = attachment.mimeType.startsWith("video/"); const audio = attachment.mimeType.startsWith("audio/");
      const method = image ? "sendPhoto" : video ? "sendVideo" : audio ? "sendAudio" : "sendDocument"; const field = image ? "photo" : video ? "video" : audio ? "audio" : "document";
      const form = await telegramMediaForm({ chatId, attachment, field });
      responses.push(await channelRequest(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", body: form }));
    }  } else if (channel === "whatsapp") {
    const token = credentials.accessToken ?? credentials.access_token; const phoneId = credentials.phoneNumberId ?? credentials.phone_number_id; if (!token || !phoneId) throw new MessageDeliveryError("WhatsApp credentials are not configured", true);
    const url = `https://graph.facebook.com/${credentials.apiVersion ?? "v23.0"}/${phoneId}/messages`; const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    if (buttons.length) {
      if (buttons.some((button) => button.type === "url")) throw new MessageDeliveryError("WhatsApp URL buttons require an approved template", true);
      if (attachments.length > 1) throw new MessageDeliveryError("WhatsApp interactive messages support one header image", true);
      responses.push(await channelRequest(url, { method: "POST", headers, body: JSON.stringify({ messaging_product: "whatsapp", to: chatId, type: "interactive", interactive: { type: "button", ...(attachments[0] ? { header: { type: "image", image: { link: attachments[0].url } } } : {}), body: { text }, action: { buttons: buttons.map((button, index) => ({ type: "reply", reply: { id: button.value || button.id || `button_${index + 1}`, title: button.text } })) } } }) }));
    } else {
      if (text) responses.push(await channelRequest(url, { method: "POST", headers, body: JSON.stringify({ messaging_product: "whatsapp", to: chatId, type: "text", text: { body: text } }) }));
      for (const attachment of attachments) { const type = attachment.mimeType.startsWith("image/") ? "image" : attachment.mimeType.startsWith("video/") ? "video" : attachment.mimeType.startsWith("audio/") ? "audio" : "document"; responses.push(await channelRequest(url, { method: "POST", headers, body: JSON.stringify({ messaging_product: "whatsapp", to: chatId, type, [type]: { link: attachment.url, ...(type === "document" ? { filename: attachment.filename } : {}) } }) })); }
    }
  } else if (channel === "vk") {
    if (attachments.length) throw new MessageDeliveryError("VK attachments require the channel upload flow and cannot be sent as generic files", true);
    const token = credentials.accessToken ?? credentials.access_token; if (!token) throw new MessageDeliveryError("VK access token is not configured", true);
    const keyboard = buttons.length ? JSON.stringify({ inline: true, buttons: buttonRows(buttons).map((row) => row.map((button) => button.type === "url" ? { action: { type: "open_link", link: button.value, label: button.text } } : { action: { type: "callback", label: button.text, payload: JSON.stringify({ value: button.value }) }, color: "primary" })) }) : undefined;
    responses.push(await channelRequest("https://api.vk.com/method/messages.send", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ access_token: token, v: credentials.apiVersion ?? "5.199", peer_id: chatId, random_id: String(Date.now()), message: text, ...(keyboard ? { keyboard } : {}) }) }));
  } else if (channel === "avito") {
    if (attachments.length || buttons.length) throw new MessageDeliveryError("Avito campaign media and buttons are unavailable for this connector", true);
    const token = credentials.accessToken ?? credentials.access_token; const accountId = credentials.accountId ?? credentials.userId; if (!token || !accountId) throw new MessageDeliveryError("Avito account and access token are not configured", true);
    const url = credentials.outboundUrl ?? `https://api.avito.ru/messenger/v1/accounts/${accountId}/chats/${chatId}/messages`;
    responses.push(await channelRequest(url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ message: { text }, type: "text" }) }));
  } else if (channel === "api") {
    const url = credentials.outboundUrl ?? credentials.endpoint; if (!url) throw new MessageDeliveryError("Generic outbound URL is not configured", true);
    const body = JSON.stringify({ type: "message.outbound", external_chat_id: chatId, message: { text, attachments, buttons } }); const secret = credentials.signingSecret ?? credentials.secret;
    responses.push(await channelRequest(url, { method: "POST", headers: { "content-type": "application/json", ...(secret ? { "x-botcrm-signature": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}` } : {}) }, body }));
  } else throw new MessageDeliveryError(`Unsupported channel ${channel}`, true);
  const response = responses.at(-1) ?? {}; return { response, externalId: responses.map(externalId).find(Boolean) };
}
export function messageProcessor(pool: Pool) {
  return async (bullJob: Job<MessageJob>) => {
    const client = await pool.connect(); let transactionOpen = false;
    try {
      await client.query("begin"); transactionOpen = true;
      const result = await client.query(`select m.id,m.status,m.text_content,m.payload,c.external_chat_id,c.channel,c.connector_id,cn.encrypted_credentials,
        coalesce((select jsonb_agg(jsonb_build_object('objectKey',a.object_key,'filename',a.filename,'mimeType',a.mime_type) order by a.created_at,a.id) from attachments a where a.message_id=m.id),'[]'::jsonb) attachments
        from messages m join conversations c on c.id=m.conversation_id join connectors cn on cn.id=c.connector_id
        where m.id=$1 and m.workspace_id=$2 for update of m`, [bullJob.data.messageId, bullJob.data.workspaceId]);
      if (!result.rowCount) { await client.query("commit"); transactionOpen = false; return { skipped: "message_or_connector_missing" }; }
      const row = result.rows[0];
      if (["SENT", "DELIVERED", "READ"].includes(row.status)) { await client.query("commit"); transactionOpen = false; return { skipped: "already_sent" }; }
      try {
        const attachments: DeliveryAttachment[] = await Promise.all((row.attachments as Array<{ objectKey: string; filename: string; mimeType: string }>).map(async (item) => ({ url: await attachmentUrl(item.objectKey, item.filename), filename: item.filename, mimeType: item.mimeType })));
        const sent = await sendOfficial(row.channel, decryptCredentials(row.encrypted_credentials), row.external_chat_id, row.text_content, attachments, row.payload?.buttons ?? []);
        await client.query("update messages set status='SENT',external_id=coalesce($2,external_id),error_code=null,error_message=null where id=$1", [row.id, sent.externalId ?? null]);
        await client.query("insert into audit_events(workspace_id,actor_type,action,entity_type,entity_id,changes) values($1,'SERVICE','message.sent','message',$2,$3)", [bullJob.data.workspaceId, row.id, JSON.stringify({ channel: row.channel, externalId: sent.externalId, attachmentCount: attachments.length })]);
        await client.query("commit"); transactionOpen = false; return sent.response;
      } catch (error) {
        const deliveryError = error instanceof MessageDeliveryError ? error : new MessageDeliveryError(error instanceof Error ? error.message : String(error));
        const maxAttempts = Number(bullJob.opts.attempts ?? 5); const terminal = deliveryError.permanent || bullJob.attemptsMade + 1 >= maxAttempts;
        await client.query("update messages set status=$2,error_code=$3,error_message=$4 where id=$1", [row.id, terminal ? "FAILED" : "QUEUED", terminal ? "permanent_delivery_error" : "temporary_delivery_error", deliveryError.message.slice(0, 1000)]);
        await client.query("commit"); transactionOpen = false; if (!terminal) throw deliveryError; return { failed: deliveryError.message, permanent: true };
      }
    } catch (error) { if (transactionOpen) await client.query("rollback").catch(() => undefined); throw error; }
    finally { client.release(); }
  };
}
