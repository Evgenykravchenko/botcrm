import { createHmac, timingSafeEqual } from "node:crypto";
import { Channel, NormalizedEvent } from "./core.js";

export interface AdapterContext { workspaceId: string; botId: string; connectorId: string; receivedAt?: string }
export interface OutboundEnvelope { externalChatId: string; text: string; template?: { name: string; language: string; parameters?: string[] } }
export interface ConnectorAdapter {
  channel: Channel;
  normalize(payload: any, context: AdapterContext): NormalizedEvent[];
  buildOutbound(input: OutboundEnvelope, credentials: Record<string, string>): { url: string; method: "POST"; headers: Record<string, string>; body: unknown };
}

const base = (channel: Channel, context: AdapterContext, externalChatId: string, externalUserId: string, eventId: string): Omit<NormalizedEvent, "type"> => ({ event_id: eventId, schema_version: "1.0", occurred_at: context.receivedAt ?? new Date().toISOString(), workspace_id: context.workspaceId, bot_id: context.botId, channel, external_chat_id: externalChatId, external_user_id: externalUserId });

function firstString(...values: unknown[]) {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim();
}

const avatarMetadataCache = new Map<string, { expiresAt: number; profile: { avatar_url?: string; avatar_file_id?: string } }>();

export async function enrichProfileAvatar(event: NormalizedEvent, credentials: Record<string, any>): Promise<NormalizedEvent> {
  if (event.profile?.avatar_url || event.profile?.avatar_file_id || !event.external_user_id) return event;
  const cacheKey = `${event.workspace_id}:${event.channel}:${event.bot_id}:${event.external_user_id}`;
  const cached = avatarMetadataCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return { ...event, profile: { ...(event.profile ?? {}), ...cached.profile } };
  const profile: { avatar_url?: string; avatar_file_id?: string } = {};
  try {
    if (event.channel === "telegram") {
      const token = firstString(credentials.botToken, credentials.bot_token);
      if (token) {
        const response = await fetch(`https://api.telegram.org/bot${token}/getUserProfilePhotos?user_id=${encodeURIComponent(event.external_user_id)}&limit=1`, { signal: AbortSignal.timeout(4_000) });
        const body = await response.json() as { ok?: boolean; result?: { photos?: Array<Array<{ file_id?: string }>> } };
        profile.avatar_file_id = body.ok ? firstString(body.result?.photos?.[0]?.at(-1)?.file_id, body.result?.photos?.[0]?.[0]?.file_id) : undefined;
      }
    } else if (event.channel === "vk") {
      const token = firstString(credentials.accessToken, credentials.access_token);
      if (token) {
        const version = firstString(credentials.apiVersion, credentials.api_version) ?? "5.199";
        const response = await fetch(`https://api.vk.com/method/users.get?user_ids=${encodeURIComponent(event.external_user_id)}&fields=photo_200&access_token=${encodeURIComponent(token)}&v=${encodeURIComponent(version)}`, { signal: AbortSignal.timeout(4_000) });
        const body = await response.json() as { response?: Array<{ photo_200?: string }> };
        profile.avatar_url = firstString(body.response?.[0]?.photo_200);
      }
    }
  } catch {
    // Avatar lookup is optional and must never block message ingestion.
  }
  avatarMetadataCache.set(cacheKey, { expiresAt: Date.now() + 6 * 60 * 60_000, profile });
  return Object.keys(profile).length ? { ...event, profile: { ...(event.profile ?? {}), ...profile } } : event;
}

export const telegramAdapter: ConnectorAdapter = {
  channel: "telegram",
  normalize(payload, context) {
    const message = payload.message ?? payload.edited_message ?? payload.callback_query?.message;
    if (!message) return [];
    const sender = payload.callback_query?.from ?? message.from ?? {};
    return [{ ...base("telegram", context, String(message.chat.id), String(sender.id), `telegram:${payload.update_id}`), type: "message.received", message: { external_id: String(message.message_id), text: payload.callback_query?.data ?? message.text ?? message.caption ?? "", reply_to: message.reply_to_message ? String(message.reply_to_message.message_id) : undefined }, profile: { name: [sender.first_name, sender.last_name].filter(Boolean).join(" ") || sender.username, avatar_url: firstString(sender.photo_url, sender.avatar_url) }, attributes: { username: sender.username, language_code: sender.language_code, telegram_update_type: payload.callback_query ? "callback_query" : payload.edited_message ? "edited_message" : "message" }, raw_payload: payload }];
  },
  buildOutbound(input, credentials) { return { url: `https://api.telegram.org/bot${credentials.botToken}/sendMessage`, method: "POST", headers: { "content-type": "application/json" }, body: { chat_id: input.externalChatId, text: input.text } }; },
};

export const vkAdapter: ConnectorAdapter = {
  channel: "vk",
  normalize(payload, context) {
    if (payload.type === "message_event") {
      const event = payload.object ?? {};
      const sourceId = payload.event_id ?? `${payload.group_id}:${event.event_id}`;
      const value = event.payload?.value ?? event.payload?.action ?? event.payload ?? "";
      return [{
        ...base("vk", context, String(event.peer_id), String(event.user_id), `vk:${sourceId}`),
        type: "message.received",
        message: {
          external_id: String(event.event_id ?? sourceId),
          text: typeof value === "string" ? value : JSON.stringify(value),
        },
        profile: { avatar_url: firstString(event.user?.photo_200, event.user?.photo, event.avatar_url) },
        attributes: { group_id: payload.group_id, vk_update_type: "message_event" },
        raw_payload: payload,
      }];
    }
    if (payload.type !== "message_new") return [];
    const message = payload.object?.message ?? payload.object ?? {};
    return [{ ...base("vk", context, String(message.peer_id), String(message.from_id), `vk:${payload.event_id ?? `${payload.group_id}:${message.id}`}`), type: "message.received", message: { external_id: String(message.id), text: message.text ?? "", reply_to: message.reply_message ? String(message.reply_message.id) : undefined }, profile: { avatar_url: firstString(message.from?.photo_200, message.from?.photo, message.avatar_url) }, attributes: { group_id: payload.group_id }, raw_payload: payload }];
  },
  buildOutbound(input, credentials) { return { url: "https://api.vk.com/method/messages.send", method: "POST", headers: { "content-type": "application/json" }, body: { peer_id: input.externalChatId, message: input.text, random_id: Date.now(), access_token: credentials.accessToken, v: credentials.apiVersion ?? "5.199" } }; },
};

export const whatsappAdapter: ConnectorAdapter = {
  channel: "whatsapp",
  normalize(payload, context) {
    const value = payload.entry?.[0]?.changes?.[0]?.value; const message = value?.messages?.[0];
    if (!message) return (value?.statuses ?? []).map((status: any) => ({ ...base("whatsapp", context, String(status.recipient_id ?? status.id), String(status.recipient_id ?? status.id), `whatsapp:status:${status.id}:${status.status}:${status.timestamp ?? Date.now()}`), occurred_at: status.timestamp ? new Date(Number(status.timestamp) * 1000).toISOString() : new Date().toISOString(), type: "message.status" as const, message: { external_id: status.id }, attributes: { status: status.status, error_code: status.errors?.[0]?.code ? String(status.errors[0].code) : undefined, error_message: status.errors?.[0]?.title ?? status.errors?.[0]?.message }, raw_payload: payload }));
    const contact = value.contacts?.[0]; const text = message.text?.body ?? message.button?.text ?? message.interactive?.button_reply?.title ?? message.interactive?.list_reply?.title ?? "";
    return [{ ...base("whatsapp", context, String(message.from), String(message.from), `whatsapp:${message.id}`), occurred_at: message.timestamp ? new Date(Number(message.timestamp) * 1000).toISOString() : new Date().toISOString(), type: "message.received", message: { external_id: message.id, text }, profile: { name: contact?.profile?.name, phone: message.from, avatar_url: firstString(contact?.profile?.avatar_url, contact?.profile?.photo_url, contact?.profile?.picture_url) }, attributes: { phone_number_id: value.metadata?.phone_number_id, message_type: message.type }, raw_payload: payload }];
  },
  buildOutbound(input, credentials) { const body = input.template ? { messaging_product: "whatsapp", to: input.externalChatId, type: "template", template: { name: input.template.name, language: { code: input.template.language }, components: input.template.parameters?.length ? [{ type: "body", parameters: input.template.parameters.map((text) => ({ type: "text", text })) }] : undefined } } : { messaging_product: "whatsapp", to: input.externalChatId, type: "text", text: { body: input.text } }; return { url: `https://graph.facebook.com/${credentials.apiVersion ?? "v23.0"}/${credentials.phoneNumberId}/messages`, method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${credentials.accessToken}` }, body }; },
};

export const avitoAdapter: ConnectorAdapter = {
  channel: "avito",
  normalize(payload, context) {
    const message = payload.payload?.value ?? payload; const chatId = String(message.chat_id ?? message.chatId ?? ""); const userId = String(message.author_id ?? message.user_id ?? ""); if (!chatId || !userId) return [];
    return [{ ...base("avito", context, chatId, userId, `avito:${message.id ?? message.message_id}`), type: "message.received", message: { external_id: String(message.id ?? message.message_id), text: message.content?.text ?? message.text ?? "" }, profile: { name: firstString(message.author?.name, message.user?.name), avatar_url: firstString(message.author?.avatar?.url, message.author?.avatar, message.user?.avatar?.url, message.user?.avatar, message.avatar_url) }, attributes: { item_id: message.item_id }, raw_payload: payload }];
  },
  buildOutbound(input, credentials) { return { url: `https://api.avito.ru/messenger/v1/accounts/${credentials.userId}/chats/${input.externalChatId}/messages`, method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${credentials.accessToken}` }, body: { message: { text: input.text }, type: "text" } }; },
};

export const apiAdapter: ConnectorAdapter = {
  channel: "api",
  normalize(payload, context) { return [{ ...payload, schema_version: "1.0", workspace_id: context.workspaceId, bot_id: context.botId, channel: payload.channel ?? "api" }]; },
  buildOutbound(input, credentials) { return { url: credentials.outboundUrl, method: "POST", headers: { "content-type": "application/json", "x-botcrm-signature": sign(JSON.stringify(input), credentials.signingSecret) }, body: input }; },
};

const registry: Record<Channel, ConnectorAdapter> = { telegram: telegramAdapter, vk: vkAdapter, whatsapp: whatsappAdapter, avito: avitoAdapter, api: apiAdapter };
export const getAdapter = (channel: Channel) => registry[channel];
export function sign(body: string, secret: string) { return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`; }
export function verifySignature(body: string, signature: string, secret: string) { const expected = Buffer.from(sign(body, secret)); const received = Buffer.from(signature); return expected.length === received.length && timingSafeEqual(expected, received); }
