import { createHmac, timingSafeEqual } from "node:crypto";
export type Channel = "telegram" | "vk" | "whatsapp" | "avito" | "api";
export type ControlMode = "BOT" | "HUMAN" | "PAUSED";
export interface BotCrmEvent {
  event_id: string;
  schema_version: "1.0";
  occurred_at: string;
  workspace_id: string;
  bot_id: string;
  channel: Channel;
  external_chat_id: string;
  external_user_id: string;
  type: "message.received" | "message.sent" | "message.status" | "contact.updated" | "control.returned";
  message?: { external_id?: string; text?: string; reply_to?: string; attachments?: Array<{ type: string; url: string }> };
  profile?: { name?: string; phone?: string; email?: string; city?: string; avatar_url?: string; avatar_file_id?: string };
  attributes?: Record<string, unknown>;
  raw_payload?: unknown;
  conversation_id?: string;
  contact_id?: string;
}
export class BotCrmError extends Error { constructor(public status: number, public code: string, message: string) { super(message); } }
export class BotCrmClient {
  constructor(private options: { baseUrl: string; workspaceId: string; botId: string; serviceToken: string; fetch?: typeof fetch }) {}
  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await (this.options.fetch ?? fetch)(`${this.options.baseUrl.replace(/\/$/, "")}/api/v1${path}`, { ...init, headers: { "content-type": "application/json", "x-workspace-id": this.options.workspaceId, "x-service-token": this.options.serviceToken, ...init.headers } });
    const body = await response.json() as any;
    if (!response.ok) throw new BotCrmError(response.status, body?.error?.code ?? "request_failed", body?.error?.message ?? response.statusText);
    return body as T;
  }
  event(input: Omit<BotCrmEvent, "schema_version" | "workspace_id" | "bot_id">) { return this.request<{ duplicate: boolean; contactId?: string; conversationId?: string; deliverToBot?: boolean }>("/events", { method: "POST", body: JSON.stringify({ ...input, schema_version: "1.0", workspace_id: this.options.workspaceId, bot_id: this.options.botId }) }); }
  incoming(input: { eventId: string; channel: Channel; chatId: string; userId: string; text: string; externalMessageId?: string; profile?: BotCrmEvent["profile"]; attributes?: Record<string, unknown>; raw?: unknown }) { return this.event({ event_id: input.eventId, occurred_at: new Date().toISOString(), channel: input.channel, external_chat_id: input.chatId, external_user_id: input.userId, type: "message.received", message: { external_id: input.externalMessageId, text: input.text }, profile: input.profile, attributes: input.attributes, raw_payload: input.raw }); }
  send(input: { conversationId: string; text: string; actor?: "bot" | "operator"; idempotencyKey: string }) { return this.request("/messages/send", { method: "POST", headers: { "idempotency-key": input.idempotencyKey }, body: JSON.stringify({ conversationId: input.conversationId, text: input.text, actor: input.actor ?? "bot" }) }); }
  conversation(id: string) { return this.request<{ mode: ControlMode; controlVersion: number }>(`/conversations/${id}`); }
  claim(id: string, expectedVersion: number, userId: string) { return this.request(`/conversations/${id}/control`, { method: "PATCH", body: JSON.stringify({ mode: "HUMAN", expectedVersion, userId }) }); }
  returnToBot(id: string, expectedVersion: number) { return this.request(`/conversations/${id}/control`, { method: "PATCH", body: JSON.stringify({ mode: "BOT", expectedVersion }) }); }
}

export function verifyBotCrmWebhook(rawBody: string | Uint8Array, signature: string | undefined, secret: string): boolean {
  if (!signature?.startsWith("sha256=") || !secret) return false;
  const body = typeof rawBody === "string" ? rawBody : Buffer.from(rawBody);
  const expected = Buffer.from(createHmac("sha256", secret).update(body).digest("hex"), "utf8");
  const supplied = Buffer.from(signature.slice(7), "utf8");
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}
