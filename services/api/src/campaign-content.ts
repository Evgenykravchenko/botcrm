import { DomainError, type Channel } from "./core.js";

export type CampaignButton = { id?: string; text: string; type: "callback" | "url"; value: string; row: number };
export type CampaignContentInput = { content: string; buttons?: CampaignButton[]; mediaIds?: string[] };

export const campaignChannelLimits: Record<Channel, { buttons: number; perRow: number; images: number; links: boolean }> = {
  telegram: { buttons: 100, perRow: 8, images: 10, links: true },
  vk: { buttons: 40, perRow: 5, images: 0, links: true },
  whatsapp: { buttons: 3, perRow: 3, images: 1, links: false },
  avito: { buttons: 0, perRow: 0, images: 0, links: false },
  api: { buttons: 100, perRow: 10, images: 10, links: true },
};

export function validateCampaignContent(channel: Channel, input: CampaignContentInput) {
  const content = String(input.content ?? "").trim();
  const limits = campaignChannelLimits[channel];
  const mediaIds = [...new Set((input.mediaIds ?? []).map(String).filter(Boolean))];
  const buttons = (input.buttons ?? []).map((button, index) => ({
    id: String(button.id ?? `button_${index + 1}`),
    text: String(button.text ?? "").trim(),
    type: button.type === "url" ? "url" as const : "callback" as const,
    value: String(button.value ?? "").trim(),
    row: Math.max(0, Math.floor(Number(button.row) || 0)),
  }));
  if (!content) throw new DomainError(400, "Campaign message text is required", "campaign_content_required");
  if (buttons.length > limits.buttons) throw new DomainError(400, `${channel} supports at most ${limits.buttons} campaign buttons`, "campaign_button_limit");
  if (mediaIds.length > limits.images) throw new DomainError(400, `${channel} supports at most ${limits.images} campaign images`, "campaign_media_limit");
  for (const button of buttons) {
    if (!button.text || !button.value) throw new DomainError(400, "Every campaign button needs a label and action", "invalid_campaign_button");
    if (button.text.length > 64) throw new DomainError(400, "Campaign button label is too long", "invalid_campaign_button");
    if (button.type === "url") {
      if (!limits.links) throw new DomainError(400, `${channel} does not support URL buttons in this message format`, "campaign_link_button_unsupported");
      let url: URL; try { url = new URL(button.value); } catch { throw new DomainError(400, "Button URL is invalid", "invalid_campaign_button_url"); }
      if (!["http:", "https:"].includes(url.protocol)) throw new DomainError(400, "Button URL must use HTTP or HTTPS", "invalid_campaign_button_url");
    }
  }
  const rows = new Map<number, number>();
  buttons.forEach((button) => rows.set(button.row, (rows.get(button.row) ?? 0) + 1));
  if ([...rows.values()].some((count) => count > limits.perRow)) throw new DomainError(400, `${channel} button row is too wide`, "campaign_button_row_limit");
  return { text: content, buttons, mediaIds };
}
