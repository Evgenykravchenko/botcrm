import { createHmac } from "node:crypto";
import { Job } from "bullmq";
import { Pool } from "pg";
import { decryptCredentials } from "./secrets.js";
import { attachmentUrl } from "./media-url.js";
import { telegramMediaForm } from "./telegram-media.js";

export interface CampaignJob { workspaceId?: string; recipientId: string; campaignId: string; contactId: string; connectorId: string; externalUserId: string; channel: string; content: string; buttons?: Array<{ id?: string; text: string; type: "callback" | "url"; value: string; row: number }>; media?: Array<{ objectKey: string; filename: string; mimeType: string }>; }
class DeliveryError extends Error { constructor(message: string, readonly permanent = false, readonly retryAfterMs?: number) { super(message); } }

function campaignButtonRows(buttons: NonNullable<CampaignJob["buttons"]>) {
  const rows = new Map<number, NonNullable<CampaignJob["buttons"]>>();
  buttons.forEach((button) => rows.set(button.row, [...(rows.get(button.row) ?? []), button]));
  return [...rows.entries()].sort(([left], [right]) => left - right).map(([, row]) => row);
}

async function campaignRequest(url: string, init: RequestInit) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  const payload = await response.json().catch(() => ({})) as Record<string, any>;
  const detail = String(payload.description ?? payload.error?.message ?? "").slice(0, 500);
  if (response.status === 429) { const seconds = Number(response.headers.get("retry-after") ?? payload.parameters?.retry_after ?? 2); throw new DeliveryError(detail || "Channel rate limit", false, Math.max(1, seconds) * 1_000); }
  if (response.status >= 500) throw new DeliveryError(detail || `Channel temporary error ${response.status}`);
  if (!response.ok) throw new DeliveryError(detail ? `Channel rejected message with ${response.status}: ${detail}` : `Channel rejected message with ${response.status}`, true);
  return payload;
}

async function officialSend(row: Record<string, any>, job: CampaignJob) {
  const credentials = decryptCredentials(row.encrypted_credentials ?? {});
  const buttons = job.buttons ?? [];
  const media = await Promise.all((job.media ?? []).map(async (item) => ({ ...item, url: await attachmentUrl(item.objectKey, item.filename) })));
  const responses: Record<string, any>[] = [];
  if (job.channel === "telegram") {
    const token = credentials.botToken ?? credentials.bot_token; if (!token) throw new DeliveryError("Telegram bot token is not configured", true);
    const markup = buttons.length ? { inline_keyboard: campaignButtonRows(buttons).map((buttonRow) => buttonRow.map((button) => button.type === "url" ? { text: button.text, url: button.value } : { text: button.text, callback_data: button.value })) } : undefined;
    if (media[0]?.mimeType.startsWith("image/") && job.content.length <= 1024) {
      const form = await telegramMediaForm({ chatId: job.externalUserId, attachment: media[0], field: "photo", caption: job.content, replyMarkup: markup });
      responses.push(await campaignRequest(`https://api.telegram.org/bot${token}/sendPhoto`, { method: "POST", body: form }));
      for (const image of media.slice(1)) {
        const imageForm = await telegramMediaForm({ chatId: job.externalUserId, attachment: image, field: "photo" });
        responses.push(await campaignRequest(`https://api.telegram.org/bot${token}/sendPhoto`, { method: "POST", body: imageForm }));
      }
    } else {
      responses.push(await campaignRequest(`https://api.telegram.org/bot${token}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: job.externalUserId, text: job.content, ...(markup ? { reply_markup: markup } : {}) }) }));
      for (const image of media) {
        const imageForm = await telegramMediaForm({ chatId: job.externalUserId, attachment: image, field: "photo" });
        responses.push(await campaignRequest(`https://api.telegram.org/bot${token}/sendPhoto`, { method: "POST", body: imageForm }));
      }
    }  } else if (job.channel === "vk") {
    if (media.length) throw new DeliveryError("VK campaign images require the VK upload flow", true);
    const token = credentials.accessToken ?? credentials.access_token; if (!token) throw new DeliveryError("VK access token is not configured", true);
    const keyboard = buttons.length ? JSON.stringify({ inline: true, buttons: campaignButtonRows(buttons).map((buttonRow) => buttonRow.map((button) => button.type === "url" ? { action: { type: "open_link", link: button.value, label: button.text } } : { action: { type: "callback", label: button.text, payload: JSON.stringify({ value: button.value }) }, color: "primary" })) }) : undefined;
    responses.push(await campaignRequest("https://api.vk.com/method/messages.send", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ access_token: token, v: credentials.apiVersion ?? credentials.api_version ?? "5.199", peer_id: job.externalUserId, random_id: String(Date.now()), message: job.content, ...(keyboard ? { keyboard } : {}) }) }));
  } else if (job.channel === "whatsapp") {
    const token = credentials.accessToken ?? credentials.access_token; const phoneId = credentials.phoneNumberId ?? credentials.phone_number_id; if (!token || !phoneId) throw new DeliveryError("WhatsApp credentials are not configured", true);
    if (buttons.some((button) => button.type === "url")) throw new DeliveryError("WhatsApp URL buttons require an approved template", true);
    const url = `https://graph.facebook.com/${credentials.apiVersion ?? credentials.graph_version ?? "v23.0"}/${phoneId}/messages`; const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    if (buttons.length) responses.push(await campaignRequest(url, { method: "POST", headers, body: JSON.stringify({ messaging_product: "whatsapp", to: job.externalUserId, type: "interactive", interactive: { type: "button", ...(media[0] ? { header: { type: "image", image: { link: media[0].url } } } : {}), body: { text: job.content }, action: { buttons: buttons.map((button, index) => ({ type: "reply", reply: { id: button.value || button.id || `button_${index + 1}`, title: button.text } })) } } }) }));
    else if (media[0]) responses.push(await campaignRequest(url, { method: "POST", headers, body: JSON.stringify({ messaging_product: "whatsapp", to: job.externalUserId, type: "image", image: { link: media[0].url, caption: job.content } }) }));
    else responses.push(await campaignRequest(url, { method: "POST", headers, body: JSON.stringify({ messaging_product: "whatsapp", to: job.externalUserId, type: "text", text: { body: job.content } }) }));
  } else if (job.channel === "api") {
    const target = credentials.outboundUrl ?? credentials.endpoint; if (!target) throw new DeliveryError("Generic connector endpoint is not configured", true);
    const body = JSON.stringify({ type: "campaign.message", recipient_id: job.recipientId, external_user_id: job.externalUserId, message: { text: job.content, buttons, attachments: media.map(({ url, filename, mimeType }) => ({ url, filename, mime_type: mimeType })) } });
    const signature = (credentials.signingSecret ?? credentials.secret) ? createHmac("sha256", (credentials.signingSecret ?? credentials.secret)).update(body).digest("hex") : "";
    responses.push(await campaignRequest(target, { method: "POST", headers: { "content-type": "application/json", "x-botcrm-signature": signature }, body }));
  } else if (job.channel === "avito") {
    if (buttons.length || media.length) throw new DeliveryError("Avito campaign buttons and images are unavailable for this connector", true);
    const target = credentials.outboundUrl ?? credentials.endpoint; if (!target || !(credentials.accessToken ?? credentials.access_token)) throw new DeliveryError("Avito Messenger credentials are not configured", true);
    responses.push(await campaignRequest(target, { method: "POST", headers: { authorization: `Bearer ${(credentials.accessToken ?? credentials.access_token)}`, "content-type": "application/json" }, body: JSON.stringify({ user_id: job.externalUserId, message: { text: job.content } }) }));
  } else throw new DeliveryError(`Unsupported campaign channel: ${job.channel}`, true);
  return responses.at(-1) ?? {};
}
async function finishCampaign(pool: Pool, campaignId: string) {
  await pool.query(`update campaigns set status='COMPLETED',updated_at=now() where id=$1 and status='RUNNING' and not exists(select 1 from campaign_recipients where campaign_id=$1 and (status='QUEUED' or (status='FAILED' and attempt_count<5)))`, [campaignId]);
}

async function emitAutomationEvent(job: CampaignJob, triggerType: "campaign.delivered" | "campaign.failed", detail: Record<string, unknown> = {}) {
  const serviceToken = process.env.SERVICE_TOKEN;
  if (!serviceToken) return;
  const baseUrl = (process.env.BOTCRM_API_URL ?? "http://localhost:4100/api/v1").replace(/\/$/, "");
  const response = await fetch(`${baseUrl}/automations/process`, { method: "POST", headers: { "content-type": "application/json", "x-service-token": serviceToken, "x-workspace-id": job.workspaceId ?? "ws_demo" }, body: JSON.stringify({ triggerType, sourceEventId: `${triggerType}:${job.recipientId}`, context: { contactId: job.contactId, campaignId: job.campaignId, recipientId: job.recipientId, channel: job.channel, ...detail } }), signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`Automation API returned ${response.status}`);
}
export function campaignProcessor(pool: Pool, deliveryMode = process.env.DELIVERY_MODE || "simulate") {
  return async (bullJob: Job<CampaignJob>) => {
    const job = bullJob.data;
    const client = await pool.connect();
    let released = false;
    let transactionOpen = false;
    const release = () => { if (!released) { released = true; client.release(); } };
    try {
      await client.query("begin");
      transactionOpen = true;
      const locked = await client.query(`select cr.status,cr.attempt_count,cn.encrypted_credentials,c.status campaign_status
        from campaign_recipients cr
        join connectors cn on cn.id=cr.connector_id
        join campaigns c on c.id=cr.campaign_id
        where cr.id=$1 and cr.campaign_id=$2
        for update of cr`, [job.recipientId, job.campaignId]);
      if (!locked.rowCount) {
        await client.query("commit"); transactionOpen = false; release();
        return { skipped: "recipient_missing" };
      }
      const row = locked.rows[0];
      if (row.campaign_status !== "RUNNING") {
        if (row.campaign_status === "CANCELLED" && ["QUEUED", "FAILED"].includes(row.status)) {
          await client.query("update campaign_recipients set status='CANCELLED',next_attempt_at=null,last_error='Campaign cancelled by operator' where id=$1", [job.recipientId]);
        }
        await client.query("commit"); transactionOpen = false; release();
        return { skipped: `campaign_${String(row.campaign_status).toLowerCase()}` };
      }
      if (["SENT", "DELIVERED", "READ", "CANCELLED"].includes(row.status)) {
        await client.query("commit"); transactionOpen = false; release();
        return { skipped: "already_terminal" };
      }
      try {
        const response = deliveryMode === "simulate" ? { simulated: true, id: `sim_${job.recipientId}` } : await officialSend(row, job);
        await client.query("update campaign_recipients set status='DELIVERED',attempt_count=$2,last_error=null,next_attempt_at=null,sent_at=coalesce(sent_at,now()),delivered_at=now() where id=$1", [job.recipientId, bullJob.attemptsMade + 1]);
        await client.query("commit"); transactionOpen = false; release();
        await finishCampaign(pool, job.campaignId);
        await emitAutomationEvent(job, "campaign.delivered", { status: "DELIVERED", delivery: response }).catch((error) => console.error(JSON.stringify({ level: "error", message: "campaign automation trigger failed", error: error.message })));
        return response;
      } catch (error) {
        const deliveryError = error instanceof DeliveryError ? error : new DeliveryError(error instanceof Error ? error.message : String(error));
        const maxAttempts = Number(bullJob.opts.attempts ?? 5);
        const permanentFailure = deliveryError.permanent || bullJob.attemptsMade + 1 >= maxAttempts;
        const attempts = permanentFailure ? maxAttempts : bullJob.attemptsMade + 1;
        const nextAttempt = permanentFailure ? null : new Date(Date.now() + (deliveryError.retryAfterMs ?? 2_000 * 2 ** bullJob.attemptsMade));
        await client.query("update campaign_recipients set status='FAILED',attempt_count=$2,last_error=$3,next_attempt_at=$4 where id=$1", [job.recipientId, attempts, deliveryError.message, nextAttempt]);
        await client.query("commit"); transactionOpen = false; release();
        await finishCampaign(pool, job.campaignId);
        if (permanentFailure) await emitAutomationEvent(job, "campaign.failed", { status: "FAILED", error: deliveryError.message, permanent: true }).catch((error) => console.error(JSON.stringify({ level: "error", message: "campaign automation trigger failed", error: error.message })));
        if (!permanentFailure) throw deliveryError;
        return { failed: deliveryError.message, permanent: true };
      }
    } catch (error) {
      if (transactionOpen) await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      release();
    }
  };
}