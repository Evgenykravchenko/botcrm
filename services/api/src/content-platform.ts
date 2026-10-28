import { Injectable } from "@nestjs/common";
import { DomainError } from "./core.js";

export type KeywordMatchMode = "exact" | "contains" | "any_word" | "all_words";
export type ContentBlockKind = "text" | "photo" | "video" | "audio" | "document";
export type ContentButtonAction = "text" | "open_link";
export type ContentButtonColor = "primary" | "secondary" | "positive" | "negative";
export type ContentPublicationStatus = "draft" | "published";
export type MediaPreparationStatus = "draft" | "queued" | "processing" | "ready" | "error";

export interface ContentPlatformBinding {
  workspaceId: string;
  botSlug: string;
  contentBotKey: string;
  label?: string;
  channel?: "telegram" | "vk" | "instagram" | "other";
  yandexRoot?: string;
}

export interface YandexDiskItem {
  name: string;
  path: string;
  type: "file" | "dir";
  kind?: ContentMediaInput["kind"];
  mimeType?: string;
  size?: number;
  previewUrl?: string;
}

export interface KeywordReplyBlockInput {
  id?: number;
  kind: ContentBlockKind;
  body?: string;
  mediaId?: number;
  sort?: number;
  sendSeparately?: boolean;
  enabled?: boolean;
}

export interface KeywordReplyButtonInput {
  id?: number;
  label: string;
  action: ContentButtonAction;
  target: string;
  color?: ContentButtonColor;
  row?: number;
  sort?: number;
  enabled?: boolean;
}

export interface KeywordReplyInput {
  phrase: string;
  matchMode?: KeywordMatchMode;
  priority?: number;
  enabled?: boolean;
  response: {
    name: string;
    status?: ContentPublicationStatus;
    fallbackText?: string;
    blocks?: KeywordReplyBlockInput[];
    buttons?: KeywordReplyButtonInput[];
  };
}

export interface ContentMediaInput {
  name: string;
  kind: Exclude<ContentBlockKind, "text">;
  yandexPath: string;
  status?: MediaPreparationStatus;
}

type ValidatedReplyBlock = Omit<Required<KeywordReplyBlockInput>, "id" | "mediaId"> & Pick<KeywordReplyBlockInput, "id" | "mediaId">;
type ValidatedReplyButton = Omit<Required<KeywordReplyButtonInput>, "id"> & Pick<KeywordReplyButtonInput, "id">;

type DirectusId = number;
type DirectusRecord = Record<string, unknown> & { id: DirectusId };
type DirectusEnvelope<T> = { data: T };

const matchModes = new Set<KeywordMatchMode>(["exact", "contains", "any_word", "all_words"]);
const blockKinds = new Set<ContentBlockKind>(["text", "photo", "video", "audio", "document"]);
const mediaKinds = new Set<ContentMediaInput["kind"]>(["photo", "video", "audio", "document"]);
const buttonActions = new Set<ContentButtonAction>(["text", "open_link"]);
const buttonColors = new Set<ContentButtonColor>(["primary", "secondary", "positive", "negative"]);
const publicationStatuses = new Set<ContentPublicationStatus>(["draft", "published"]);
const mediaStatuses = new Set<MediaPreparationStatus>(["draft", "queued", "processing", "ready", "error"]);

function normalizeDiskPath(value: string) {
  let source = value.trim();
  if (source.slice(0, 5).toLowerCase() === "disk:") source = source.slice(5);
  let start = 0;
  let end = source.length;
  while (start < end && source.charCodeAt(start) === 47) start += 1;
  while (end > start && source.charCodeAt(end - 1) === 47) end -= 1;
  const path = source.slice(start, end);
  if (path.length > 2048) throw new DomainError(400, "Yandex Disk path is too long", "invalid_yandex_path");
  const normalized = path ? `/${path}` : "/";
  if (normalized.split("/").includes("..")) throw new DomainError(400, "Yandex Disk path is invalid", "invalid_yandex_path");
  return normalized === "/" ? "/" : normalized;
}

function mediaKind(mimeType = "", name = ""): ContentMediaInput["kind"] | undefined {
  if (mimeType.startsWith("image/")) return "photo";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType) return "document";
  const extension = name.split(".").pop()?.toLowerCase();
  if (["jpg", "jpeg", "png", "gif", "webp", "heic"].includes(extension || "")) return "photo";
  if (["mp4", "mov", "m4v", "webm", "avi", "mkv"].includes(extension || "")) return "video";
  if (["mp3", "m4a", "wav", "ogg", "aac", "flac"].includes(extension || "")) return "audio";
  return "document";
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(parsed)));
}

function optionalId(value: unknown) {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new DomainError(400, "Invalid content item ID", "invalid_content_item_id");
  return parsed;
}

function text(value: unknown, maximum: number) {
  return String(value ?? "").trim().slice(0, maximum);
}

export function validateKeywordReplyInput(input: KeywordReplyInput): Required<Omit<KeywordReplyInput, "response">> & {
  response: Required<Omit<KeywordReplyInput["response"], "blocks" | "buttons">> & { blocks: ValidatedReplyBlock[]; buttons: ValidatedReplyButton[] };
} {
  const phrase = text(input?.phrase, 255);
  const matchMode = matchModes.has(input?.matchMode as KeywordMatchMode) ? input.matchMode as KeywordMatchMode : "contains";
  const responseName = text(input?.response?.name, 255);
  const status = publicationStatuses.has(input?.response?.status as ContentPublicationStatus) ? input.response.status as ContentPublicationStatus : "draft";
  const fallbackText = text(input?.response?.fallbackText, 10_000);
  if (!phrase) throw new DomainError(400, "Keyword phrase is required", "keyword_phrase_required");
  if (!responseName) throw new DomainError(400, "Response name is required", "response_name_required");
  if ((input.response?.blocks?.length ?? 0) > 20) throw new DomainError(400, "A response can contain at most 20 blocks", "response_block_limit");
  if ((input.response?.buttons?.length ?? 0) > 40) throw new DomainError(400, "A response can contain at most 40 buttons", "response_button_limit");

  const blocks = (input.response?.blocks ?? []).map((block, index) => {
    const kind = blockKinds.has(block.kind) ? block.kind : "text";
    const body = text(block.body, 10_000);
    const mediaId = optionalId(block.mediaId);
    if (kind === "text" && !body) throw new DomainError(400, "Text blocks cannot be empty", "empty_response_block");
    if (kind !== "text" && !mediaId && !body) throw new DomainError(400, "Media blocks need a prepared material or legacy reference", "empty_media_block");
    return {
      id: optionalId(block.id),
      kind,
      body,
      mediaId,
      sort: boundedInteger(block.sort, (index + 1) * 10, 0, 10_000),
      sendSeparately: Boolean(block.sendSeparately),
      enabled: block.enabled !== false,
    };
  });
  if (blocks.filter((block) => block.enabled && block.kind !== "text").length > 10) throw new DomainError(400, "A response can contain at most 10 media files", "response_media_limit");

  const buttons = (input.response?.buttons ?? []).map((button, index) => {
    const label = text(button.label, 40);
    const action = buttonActions.has(button.action) ? button.action : "text";
    const target = text(button.target, 2_000);
    if (!label || !target) throw new DomainError(400, "Every button needs a label and action", "invalid_response_button");
    if (action === "open_link") {
      let url: URL;
      try { url = new URL(target); }
      catch { throw new DomainError(400, "Button link is invalid", "invalid_response_button_url"); }
      if (!['http:', 'https:'].includes(url.protocol)) throw new DomainError(400, "Button link must use HTTP or HTTPS", "invalid_response_button_url");
    }
    return {
      id: optionalId(button.id),
      label,
      action,
      target,
      color: buttonColors.has(button.color as ContentButtonColor) ? button.color as ContentButtonColor : "primary",
      row: boundedInteger(button.row, 1, 1, 6),
      sort: boundedInteger(button.sort, (index + 1) * 10, 0, 10_000),
      enabled: button.enabled !== false,
    };
  });

  if (!blocks.some((block) => block.enabled) && !fallbackText) throw new DomainError(400, "A response needs at least one enabled block or fallback text", "empty_keyword_response");
  return {
    phrase,
    matchMode,
    priority: boundedInteger(input.priority, 100, -10_000, 10_000),
    enabled: input.enabled !== false,
    response: { name: responseName, status, fallbackText, blocks, buttons },
  };
}

export function validateContentMediaInput(input: ContentMediaInput) {
  const name = text(input?.name, 255);
  const kind = input?.kind;
  const yandexPath = text(input?.yandexPath, 1_024);
  const status = mediaStatuses.has(input?.status as MediaPreparationStatus) ? input.status as MediaPreparationStatus : "draft";
  if (!name) throw new DomainError(400, "Media name is required", "media_name_required");
  if (!mediaKinds.has(kind)) throw new DomainError(400, "Media type is invalid", "invalid_media_kind");
  if (!yandexPath.startsWith("/") || yandexPath.split("/").includes("..")) throw new DomainError(400, "Yandex Disk path must be absolute", "invalid_yandex_path");
  return { name, kind, yandexPath, status };
}

function parseBindings(source = process.env.CONTENT_PLATFORM_BINDINGS): ContentPlatformBinding[] {
  if (!source?.trim()) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(source); }
  catch { throw new DomainError(503, "Content platform bindings are invalid", "content_platform_configuration_error"); }
  if (!Array.isArray(parsed)) throw new DomainError(503, "Content platform bindings must be an array", "content_platform_configuration_error");
  const result: ContentPlatformBinding[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") throw new DomainError(503, "Content platform binding is invalid", "content_platform_configuration_error");
    const sourceItem = item as Record<string, unknown>;
    const binding: ContentPlatformBinding = {
      workspaceId: text(sourceItem.workspaceId, 128),
      botSlug: text(sourceItem.botSlug, 128),
      contentBotKey: text(sourceItem.contentBotKey, 128),
      label: text(sourceItem.label, 255) || undefined,
      channel: ["telegram", "vk", "instagram", "other"].includes(String(sourceItem.channel)) ? sourceItem.channel as ContentPlatformBinding["channel"] : undefined,
      yandexRoot: sourceItem.yandexRoot ? normalizeDiskPath(text(sourceItem.yandexRoot, 1_024)) : undefined,
    };
    if (!binding.workspaceId || !binding.botSlug || !binding.contentBotKey) throw new DomainError(503, "Content platform binding is incomplete", "content_platform_configuration_error");
    if (result.some((entry) => entry.workspaceId === binding.workspaceId && entry.botSlug === binding.botSlug)) throw new DomainError(503, "Content platform binding is duplicated", "content_platform_configuration_error");
    result.push(binding);
  }
  return result;
}

@Injectable()
export class ContentPlatformService {
  private readonly baseUrl?: string;
  private readonly token?: string;
  private readonly yandexToken?: string;
  private readonly bindings: ContentPlatformBinding[];
  private readonly managedBindings = new Map<string, ContentPlatformBinding>();
  private readonly ensuredYandexFolders = new Set<string>();

  constructor() {
    this.baseUrl = process.env.CONTENT_PLATFORM_URL?.replace(/\/+$/, "");
    this.token = process.env.CONTENT_PLATFORM_TOKEN;
    this.yandexToken = process.env.CONTENT_PLATFORM_YANDEX_TOKEN;
    this.bindings = parseBindings();
    if (this.baseUrl) {
      let url: URL;
      try { url = new URL(this.baseUrl); }
      catch { throw new DomainError(503, "Content platform URL is invalid", "content_platform_configuration_error"); }
      if (!['http:', 'https:'].includes(url.protocol)) throw new DomainError(503, "Content platform URL must use HTTP or HTTPS", "content_platform_configuration_error");
    }
  }

  private configured() {
    if (!this.baseUrl || !this.token) throw new DomainError(503, "Content platform is not configured", "content_platform_not_configured");
  }

  private binding(workspaceId: string, botSlug: string) {
    const binding = this.managedBindings.get(`${workspaceId}:${botSlug}`)
      ?? this.bindings.find((item) => item.workspaceId === workspaceId && item.botSlug === botSlug);
    if (!binding) throw new DomainError(404, "Content bot is not available in this workspace", "content_bot_not_found");
    return binding;
  }

  legacyBindings(workspaceId: string) {
    return this.bindings.filter((item) => item.workspaceId === workspaceId).map((item) => ({ ...item }));
  }

  registerBindings(workspaceId: string, bindings: ContentPlatformBinding[]) {
    for (const key of this.managedBindings.keys()) if (key.startsWith(`${workspaceId}:`)) this.managedBindings.delete(key);
    for (const binding of bindings) this.managedBindings.set(`${workspaceId}:${binding.botSlug}`, { ...binding, workspaceId });
  }

  registerBinding(binding: ContentPlatformBinding) {
    this.managedBindings.set(`${binding.workspaceId}:${binding.botSlug}`, { ...binding });
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    this.configured();
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: { accept: "application/json", authorization: `Bearer ${this.token}`, ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
        signal: AbortSignal.timeout(8_000),
      });
    } catch {
      throw new DomainError(502, "Content platform is temporarily unavailable", "content_platform_unavailable");
    }
    if (!response.ok) {
      if (response.status === 404) throw new DomainError(404, "Content item was not found", "content_item_not_found");
      if (response.status === 401 || response.status === 403) throw new DomainError(502, "Content platform rejected its server credentials", "content_platform_authentication_failed");
      throw new DomainError(502, `Content platform returned ${response.status}`, "content_platform_request_failed");
    }
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  }

  async listYandexFiles(workspaceId: string, botSlug: string, requestedPath?: string) {
    const binding = this.binding(workspaceId, botSlug);
    if (!this.yandexToken || !binding.yandexRoot) throw new DomainError(503, "Yandex Disk browser is not configured for this bot", "yandex_disk_browser_not_configured");
    const root = normalizeDiskPath(binding.yandexRoot);
    const path = normalizeDiskPath(requestedPath || root);
    if (root !== "/" && path !== root && !path.startsWith(`${root}/`)) throw new DomainError(403, "This Yandex Disk folder is outside the bot library", "yandex_disk_path_forbidden");

    const query = new URLSearchParams({
      path,
      limit: "500",
      preview_size: "M",
      preview_crop: "true",
      fields: "path,name,type,_embedded.items.path,_embedded.items.name,_embedded.items.type,_embedded.items.mime_type,_embedded.items.size,_embedded.items.preview",
    });
    let response: Response;
    try {
      response = await fetch(`https://cloud-api.yandex.net/v1/disk/resources?${query.toString()}`, {
        headers: { accept: "application/json", authorization: `OAuth ${this.yandexToken}` },
        signal: AbortSignal.timeout(8_000),
      });
    } catch {
      throw new DomainError(502, "Yandex Disk is temporarily unavailable", "yandex_disk_unavailable");
    }
    if (!response.ok) {
      if (response.status === 404) throw new DomainError(404, "Yandex Disk folder was not found", "yandex_disk_folder_not_found");
      if (response.status === 401 || response.status === 403) throw new DomainError(502, "Yandex Disk rejected its server credentials", "yandex_disk_authentication_failed");
      throw new DomainError(502, `Yandex Disk returned ${response.status}`, "yandex_disk_request_failed");
    }
    const payload = await response.json() as { _embedded?: { items?: Array<Record<string, unknown>> } };
    const items = (payload._embedded?.items ?? []).map((item): YandexDiskItem => {
      const type = item.type === "dir" ? "dir" : "file";
      const name = String(item.name ?? "");
      const mimeType = String(item.mime_type ?? "");
      return {
        name,
        path: normalizeDiskPath(String(item.path ?? "")),
        type,
        kind: type === "file" ? mediaKind(mimeType, name) : undefined,
        mimeType: mimeType || undefined,
        size: typeof item.size === "number" ? item.size : undefined,
        previewUrl: typeof item.preview === "string" ? item.preview : undefined,
      };
    }).sort((left, right) => left.type === right.type ? left.name.localeCompare(right.name, "ru") : left.type === "dir" ? -1 : 1);
    return { root, path, items };
  }

  async yandexFilePreview(workspaceId: string, botSlug: string, requestedPath: string) {
    const binding = this.binding(workspaceId, botSlug);
    if (!this.yandexToken || !binding.yandexRoot) throw new DomainError(503, "Yandex Disk browser is not configured for this bot", "yandex_disk_browser_not_configured");
    const root = normalizeDiskPath(binding.yandexRoot);
    const path = normalizeDiskPath(requestedPath);
    if (root !== "/" && path !== root && !path.startsWith(`${root}/`)) throw new DomainError(403, "This Yandex Disk file is outside the bot library", "yandex_disk_path_forbidden");
    const query = new URLSearchParams({ path, preview_size: "M", preview_crop: "true", fields: "type,preview" });
    let metadataResponse: Response;
    try {
      metadataResponse = await fetch(`https://cloud-api.yandex.net/v1/disk/resources?${query.toString()}`, { headers: { accept: "application/json", authorization: `OAuth ${this.yandexToken}` }, signal: AbortSignal.timeout(8_000) });
    } catch {
      throw new DomainError(502, "Yandex Disk is temporarily unavailable", "yandex_disk_unavailable");
    }
    if (!metadataResponse.ok) throw new DomainError(metadataResponse.status === 404 ? 404 : 502, metadataResponse.status === 404 ? "Yandex Disk file was not found" : `Yandex Disk returned ${metadataResponse.status}`, metadataResponse.status === 404 ? "yandex_disk_file_not_found" : "yandex_disk_request_failed");
    const metadata = await metadataResponse.json() as { type?: string; preview?: string };
    if (metadata.type !== "file" || !metadata.preview) throw new DomainError(404, "Preview is not available for this file", "yandex_disk_preview_not_found");
    let previewResponse: Response;
    try {
      previewResponse = await fetch(metadata.preview, { headers: { authorization: `OAuth ${this.yandexToken}` }, signal: AbortSignal.timeout(8_000) });
    } catch {
      throw new DomainError(502, "Yandex Disk preview is temporarily unavailable", "yandex_disk_unavailable");
    }
    if (!previewResponse.ok) throw new DomainError(502, `Yandex Disk preview returned ${previewResponse.status}`, "yandex_disk_request_failed");
    const contentType = previewResponse.headers.get("content-type") || "image/jpeg";
    if (!contentType.startsWith("image/")) throw new DomainError(502, "Yandex Disk returned an invalid preview", "yandex_disk_invalid_preview");
    const body = Buffer.from(await previewResponse.arrayBuffer());
    if (body.byteLength > 5 * 1024 * 1024) throw new DomainError(502, "Yandex Disk preview is too large", "yandex_disk_invalid_preview");
    return { body, contentType };
  }

  private async items<T extends DirectusRecord>(collection: string, query: URLSearchParams) {
    const result = await this.request<DirectusEnvelope<T[]>>(`/items/${collection}?${query.toString()}`);
    return result.data;
  }

  private async contentBot(binding: ContentPlatformBinding) {
    const query = new URLSearchParams({ "filter[key][_eq]": binding.contentBotKey, limit: "1", fields: "*" });
    const [bot] = await this.items<DirectusRecord>("content_bots", query);
    if (!bot) throw new DomainError(409, "The bound content bot does not exist", "content_bot_binding_broken");
    return bot;
  }

  async ensureContentBot(binding: ContentPlatformBinding) {
    this.configured();
    this.managedBindings.set(`${binding.workspaceId}:${binding.botSlug}`, binding);
    const query = new URLSearchParams({ "filter[key][_eq]": binding.contentBotKey, limit: "1", fields: "*" });
    const [existing] = await this.items<DirectusRecord>("content_bots", query);
    const bot = existing ?? await this.createItem<DirectusRecord>("content_bots", {
      key: binding.contentBotKey,
      name: binding.label || binding.botSlug,
      platform: binding.channel || "other",
      status: "active",
      description: "Контентом управляет BotCRM",
    });
    await this.ensureYandexFolder(binding);
    return bot;
  }

  private async ensureYandexFolder(binding: ContentPlatformBinding) {
    if (!this.yandexToken || !binding.yandexRoot) return;
    const root = normalizeDiskPath(binding.yandexRoot);
    if (this.ensuredYandexFolders.has(root)) return;
    const segments = root.split("/").filter(Boolean);
    let current = "";
    for (const segment of segments) {
      current += `/${segment}`;
      const query = new URLSearchParams({ path: current });
      let response: Response;
      try {
        response = await fetch(`https://cloud-api.yandex.net/v1/disk/resources?${query.toString()}`, {
          method: "PUT",
          headers: { accept: "application/json", authorization: `OAuth ${this.yandexToken}` },
          signal: AbortSignal.timeout(8_000),
        });
      } catch {
        throw new DomainError(502, "Yandex Disk is temporarily unavailable", "yandex_disk_unavailable");
      }
      if (response.ok) continue;
      if (response.status === 409) {
        let metadata: Response;
        try {
          metadata = await fetch(`https://cloud-api.yandex.net/v1/disk/resources?${query.toString()}&fields=type`, {
            headers: { accept: "application/json", authorization: `OAuth ${this.yandexToken}` },
            signal: AbortSignal.timeout(8_000),
          });
        } catch {
          throw new DomainError(502, "Yandex Disk is temporarily unavailable", "yandex_disk_unavailable");
        }
        const payload = metadata.ok ? await metadata.json() as { type?: string } : {};
        if (payload.type === "dir") continue;
      }
      if (response.status === 401 || response.status === 403) throw new DomainError(502, "Yandex Disk rejected its server credentials", "yandex_disk_authentication_failed");
      throw new DomainError(502, `Yandex Disk could not create ${current}`, "yandex_disk_folder_creation_failed");
    }
    this.ensuredYandexFolders.add(root);
  }

  private async createItem<T extends DirectusRecord>(collection: string, body: Record<string, unknown>) {
    const result = await this.request<DirectusEnvelope<T>>(`/items/${collection}`, { method: "POST", body: JSON.stringify(body) });
    return result.data;
  }

  private async patchItem<T extends DirectusRecord>(collection: string, id: number, body: Record<string, unknown>) {
    const result = await this.request<DirectusEnvelope<T>>(`/items/${collection}/${id}`, { method: "PATCH", body: JSON.stringify(body) });
    return result.data;
  }

  private deleteItem(collection: string, id: number) {
    return this.request<void>(`/items/${collection}/${id}`, { method: "DELETE" });
  }

  async listBots(workspaceId: string) {
    this.configured();
    const bindings = [...this.managedBindings.values()].filter((item) => item.workspaceId === workspaceId);
    const source = bindings.length ? bindings : this.bindings.filter((item) => item.workspaceId === workspaceId);
    return Promise.all(source.map(async (binding) => {
      const bot = await this.contentBot(binding);
      return {
        botSlug: binding.botSlug,
        contentBotKey: binding.contentBotKey,
        name: binding.label || String(bot.name ?? binding.botSlug),
        channel: binding.channel || String(bot.platform ?? "other"),
        status: String(bot.status ?? "paused"),
        description: String(bot.description ?? ""),
      };
    }));
  }

  async runtimeRules(workspaceId: string, botSlug: string) {
    const rules = await this.listRules(workspaceId, botSlug);
    return rules.filter((rule: any) => rule.enabled && rule.response.status === "published").map((rule: any) => ({
      id: rule.id,
      phrase: rule.phrase,
      match_mode: rule.matchMode,
      priority: rule.priority,
      response: rule.response.id,
      enabled: rule.enabled,
    }));
  }

  async runtimeSettings(workspaceId: string, botSlug: string) {
    const settings = await this.settings(workspaceId, botSlug);
    return { unknown_message: settings.unknownMessage || null, fallback_response: settings.fallbackResponseId ?? null };
  }

  async runtimePreparedResponse(workspaceId: string, botSlug: string, responseId: number) {
    const binding = this.binding(workspaceId, botSlug);
    const records = await this.recordsForBot(binding);
    const relationId = (value: unknown) => typeof value === "object" && value ? Number((value as { id?: unknown }).id) : Number(value);
    const response = records.responses.find((item) => item.id === responseId && String(item.status ?? "draft") === "published");
    if (!response) return null;
    const mediaById = new Map(records.media.map((item) => [item.id, item]));
    const deliveryByMedia = new Map<number, DirectusRecord>();
    if (binding.channel === "instagram") {
      const deliveries = await this.items<DirectusRecord>("media_deliveries", new URLSearchParams({
        "filter[media][bot][_eq]": String(records.bot.id),
        "filter[platform][_eq]": binding.channel,
        "filter[status][_eq]": "ready",
        "filter[expires_at][_gt]": new Date().toISOString(),
        fields: "*",
        limit: "-1",
      }));
      for (const delivery of deliveries) deliveryByMedia.set(relationId(delivery.media), delivery);
    }
    return {
      response: {
        id: response.id,
        name: String(response.name ?? ""),
        status: String(response.status ?? "draft"),
        fallback_text: response.fallback_text == null ? null : String(response.fallback_text),
      },
      blocks: records.blocks
        .filter((item) => relationId(item.response) === responseId && item.enabled !== false)
        .sort((a, b) => Number(a.sort ?? 0) - Number(b.sort ?? 0) || a.id - b.id)
        .map((block) => {
          const media = mediaById.get(relationId(block.media));
          return {
            id: block.id,
            response: responseId,
            sort: Number(block.sort ?? 0),
            kind: String(block.kind ?? "text"),
            body: block.body == null ? null : String(block.body),
            send_separately: Boolean(block.send_separately),
            enabled: block.enabled !== false,
            media: media ? { ...media, delivery: deliveryByMedia.get(media.id) ?? null } : null,
          };
        }),
      buttons: records.buttons
        .filter((item) => relationId(item.response) === responseId && item.enabled !== false)
        .sort((a, b) => Number(a.row_number ?? 1) - Number(b.row_number ?? 1) || Number(a.sort ?? 0) - Number(b.sort ?? 0) || a.id - b.id)
        .map((button) => ({
          id: button.id,
          response: responseId,
          label: String(button.label ?? ""),
          action: String(button.action ?? "text"),
          target: String(button.target ?? ""),
          color: String(button.color ?? "primary"),
          row_number: Number(button.row_number ?? 1),
          sort: Number(button.sort ?? 0),
          enabled: button.enabled !== false,
        })),
    };
  }

  async runtimeQueuedMedia(workspaceId: string, botSlug: string, limit: number) {
    const binding = this.binding(workspaceId, botSlug);
    const records = await this.recordsForBot(binding);
    const candidateIds = new Set(records.media.filter((item) => item.status === "queued").map((item) => item.id));
    if (binding.channel === "instagram") {
      const expired = await this.items<DirectusRecord>("media_deliveries", new URLSearchParams({
        "filter[media][bot][_eq]": String(records.bot.id),
        "filter[platform][_eq]": binding.channel,
        "filter[status][_eq]": "ready",
        "filter[expires_at][_lte]": new Date().toISOString(),
        fields: "media.id",
        sort: "expires_at",
        limit: String(Math.min(20, Math.max(1, limit))),
      }));
      for (const delivery of expired) {
        const mediaId = typeof delivery.media === "object" && delivery.media ? Number((delivery.media as { id?: unknown }).id) : Number(delivery.media);
        if (Number.isSafeInteger(mediaId) && mediaId > 0) candidateIds.add(mediaId);
      }
    }
    return records.media
      .filter((item) => candidateIds.has(item.id))
      .sort((a, b) => a.id - b.id)
      .slice(0, Math.min(20, Math.max(1, limit)));
  }

  async runtimeSetMediaDelivery(workspaceId: string, botSlug: string, mediaId: number, input: { externalReference?: string; expiresAt?: string }) {
    const binding = this.binding(workspaceId, botSlug);
    if (binding.channel !== "instagram") throw new DomainError(409, "This bot does not use expiring media deliveries", "content_delivery_platform_missing");
    const records = await this.recordsForBot(binding);
    if (!records.media.some((item) => item.id === mediaId)) throw new DomainError(404, "Media item was not found", "content_media_not_found");
    const externalReference = String(input.externalReference ?? "").trim();
    if (!externalReference || externalReference.length > 2_000) throw new DomainError(400, "Media delivery reference is invalid", "invalid_media_delivery_reference");
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : new Date(Date.now() + 80 * 24 * 60 * 60 * 1_000);
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= new Date()) throw new DomainError(400, "Media delivery expiration is invalid", "invalid_media_delivery_expiry");
    const relationId = (value: unknown) => typeof value === "object" && value ? Number((value as { id?: unknown }).id) : Number(value);
    const deliveries = await this.items<DirectusRecord>("media_deliveries", new URLSearchParams({
      "filter[media][_eq]": String(mediaId),
      "filter[platform][_eq]": binding.channel,
      fields: "*",
      limit: "1",
    }));
    const payload = { media: mediaId, platform: binding.channel, status: "ready", external_reference: externalReference, error_message: null, prepared_at: new Date().toISOString(), expires_at: expiresAt.toISOString() };
    const delivery = deliveries[0]
      ? await this.patchItem<DirectusRecord>("media_deliveries", deliveries[0].id, payload)
      : await this.createItem<DirectusRecord>("media_deliveries", payload);
    if (relationId(delivery.media) !== mediaId) throw new DomainError(502, "Content platform returned an invalid media delivery", "content_platform_invalid_response");
    await this.patchItem<DirectusRecord>("media_assets", mediaId, { status: "ready", error_message: null });
    return delivery;
  }

  async runtimeUpdateMedia(workspaceId: string, botSlug: string, mediaId: number, changes: Record<string, unknown>) {
    const binding = this.binding(workspaceId, botSlug);
    const records = await this.recordsForBot(binding);
    if (!records.media.some((item) => item.id === mediaId)) throw new DomainError(404, "Media item was not found", "content_media_not_found");
    const allowed = new Set(["status", "vk_attachment", "telegram_file_id", "mime_type", "file_size", "error_message"]);
    const body = Object.fromEntries(Object.entries(changes).filter(([key]) => allowed.has(key)));
    if (!Object.keys(body).length) throw new DomainError(400, "No supported media fields were supplied", "invalid_media_update");
    if (body.status !== undefined && !mediaStatuses.has(body.status as MediaPreparationStatus)) throw new DomainError(400, "Media status is invalid", "invalid_media_status");
    return this.patchItem<DirectusRecord>("media_assets", mediaId, body);
  }

  private async recordsForBot(binding: ContentPlatformBinding) {
    const bot = await this.contentBot(binding);
    const botId = bot.id;
    const byBot = (collection: string) => this.items<DirectusRecord>(collection, new URLSearchParams({ "filter[bot][_eq]": String(botId), limit: "-1", fields: "*" }));
    const byResponseBot = (collection: string) => this.items<DirectusRecord>(collection, new URLSearchParams({ "filter[response][bot][_eq]": String(botId), limit: "-1", fields: "*" }));
    const [keywords, responses, blocks, buttons, media, settings] = await Promise.all([
      byBot("keywords"), byBot("responses"), byResponseBot("response_blocks"), byResponseBot("response_buttons"), byBot("media_assets"), byBot("bot_settings"),
    ]);
    return { bot, keywords, responses, blocks, buttons, media, settings };
  }

  async listRules(workspaceId: string, botSlug: string) {
    const binding = this.binding(workspaceId, botSlug);
    const records = await this.recordsForBot(binding);
    const mediaById = new Map(records.media.map((item) => [item.id, item]));
    const responseById = new Map(records.responses.map((item) => [item.id, item]));
    const relationId = (value: unknown) => typeof value === "object" && value ? Number((value as { id?: unknown }).id) : Number(value);
    return records.keywords
      .sort((left, right) => Number(right.priority ?? 0) - Number(left.priority ?? 0) || String(left.phrase).localeCompare(String(right.phrase), "ru"))
      .map((keyword) => {
        const responseId = relationId(keyword.response);
        const response = responseById.get(responseId);
        if (!response) return null;
        return {
          id: keyword.id,
          phrase: String(keyword.phrase ?? ""),
          matchMode: String(keyword.match_mode ?? "contains"),
          priority: Number(keyword.priority ?? 100),
          enabled: keyword.enabled !== false,
          response: {
            id: response.id,
            name: String(response.name ?? ""),
            status: String(response.status ?? "draft"),
            fallbackText: String(response.fallback_text ?? ""),
            blocks: records.blocks.filter((item) => relationId(item.response) === response.id).sort((a, b) => Number(a.sort ?? 0) - Number(b.sort ?? 0)).map((block) => {
              const mediaId = relationId(block.media);
              const media = mediaById.get(mediaId);
              return { id: block.id, kind: String(block.kind ?? "text"), body: String(block.body ?? ""), sort: Number(block.sort ?? 0), sendSeparately: Boolean(block.send_separately), enabled: block.enabled !== false, mediaId: media?.id, mediaName: media ? String(media.name ?? "") : undefined, mediaStatus: media ? String(media.status ?? "draft") : undefined };
            }),
            buttons: records.buttons.filter((item) => relationId(item.response) === response.id).sort((a, b) => Number(a.row_number ?? 1) - Number(b.row_number ?? 1) || Number(a.sort ?? 0) - Number(b.sort ?? 0)).map((button) => ({ id: button.id, label: String(button.label ?? ""), action: String(button.action ?? "text"), target: String(button.target ?? ""), color: String(button.color ?? "primary"), row: Number(button.row_number ?? 1), sort: Number(button.sort ?? 0), enabled: button.enabled !== false })),
          },
        };
      })
      .filter(Boolean);
  }

  async listMedia(workspaceId: string, botSlug: string) {
    const binding = this.binding(workspaceId, botSlug);
    const { media } = await this.recordsForBot(binding);
    return media.sort((a, b) => b.id - a.id).map((item) => ({
      id: item.id,
      name: String(item.name ?? ""),
      kind: String(item.kind ?? "document"),
      yandexPath: String(item.yandex_path ?? ""),
      status: String(item.status ?? "draft"),
      vkAttachment: String(item.vk_attachment ?? ""),
      telegramFileId: String(item.telegram_file_id ?? ""),
      mimeType: String(item.mime_type ?? ""),
      fileSize: item.file_size == null ? undefined : Number(item.file_size),
      errorMessage: String(item.error_message ?? ""),
    }));
  }

  private async assertMediaOwned(botId: number, mediaIds: number[]) {
    if (!mediaIds.length) return;
    const records = await this.items<DirectusRecord>("media_assets", new URLSearchParams({ "filter[bot][_eq]": String(botId), limit: "-1", fields: "id" }));
    const allowed = new Set(records.map((item) => item.id));
    if (mediaIds.some((id) => !allowed.has(id))) throw new DomainError(400, "Selected media does not belong to this bot", "invalid_response_media");
  }

  private blockBody(responseId: number, block: ValidatedReplyBlock) {
    return { response: responseId, sort: block.sort, kind: block.kind, body: block.body || null, media: block.mediaId ?? null, send_separately: block.sendSeparately, enabled: block.enabled };
  }

  private buttonBody(responseId: number, button: ValidatedReplyButton) {
    return { response: responseId, label: button.label, action: button.action, target: button.target, color: button.color, row_number: button.row, sort: button.sort, enabled: button.enabled };
  }

  async createRule(workspaceId: string, botSlug: string, input: KeywordReplyInput) {
    const validated = validateKeywordReplyInput(input);
    const binding = this.binding(workspaceId, botSlug);
    const bot = await this.contentBot(binding);
    await this.assertMediaOwned(bot.id, [...new Set(validated.response.blocks.map((block) => block.mediaId).filter((id): id is number => Boolean(id)))]);
    const response = await this.createItem<DirectusRecord>("responses", { bot: bot.id, name: validated.response.name, status: validated.response.status, fallback_text: validated.response.fallbackText || null });
    const created: Array<[string, number]> = [];
    try {
      for (const block of validated.response.blocks) { const item = await this.createItem<DirectusRecord>("response_blocks", this.blockBody(response.id, block)); created.push(["response_blocks", item.id]); }
      for (const button of validated.response.buttons) { const item = await this.createItem<DirectusRecord>("response_buttons", this.buttonBody(response.id, button)); created.push(["response_buttons", item.id]); }
      const keyword = await this.createItem<DirectusRecord>("keywords", { bot: bot.id, phrase: validated.phrase, match_mode: validated.matchMode, priority: validated.priority, enabled: validated.enabled, response: response.id });
      return (await this.listRules(workspaceId, botSlug)).find((item) => item?.id === keyword.id);
    } catch (error) {
      for (const [collection, id] of created.reverse()) await this.deleteItem(collection, id).catch(() => undefined);
      await this.deleteItem("responses", response.id).catch(() => undefined);
      throw error;
    }
  }

  async updateRule(workspaceId: string, botSlug: string, ruleId: number, input: KeywordReplyInput) {
    const validated = validateKeywordReplyInput(input);
    const binding = this.binding(workspaceId, botSlug);
    const records = await this.recordsForBot(binding);
    const relationId = (value: unknown) => typeof value === "object" && value ? Number((value as { id?: unknown }).id) : Number(value);
    const keyword = records.keywords.find((item) => item.id === ruleId);
    if (!keyword) throw new DomainError(404, "Keyword rule was not found", "keyword_rule_not_found");
    const responseId = relationId(keyword.response);
    const existingBlocks = records.blocks.filter((item) => relationId(item.response) === responseId);
    const existingButtons = records.buttons.filter((item) => relationId(item.response) === responseId);
    await this.assertMediaOwned(records.bot.id, [...new Set(validated.response.blocks.map((block) => block.mediaId).filter((id): id is number => Boolean(id)))]);
    const submittedBlockIds = new Set(validated.response.blocks.map((item) => item.id).filter((id): id is number => Boolean(id)));
    const submittedButtonIds = new Set(validated.response.buttons.map((item) => item.id).filter((id): id is number => Boolean(id)));
    if ([...submittedBlockIds].some((id) => !existingBlocks.some((item) => item.id === id)) || [...submittedButtonIds].some((id) => !existingButtons.some((item) => item.id === id))) throw new DomainError(400, "Nested content item does not belong to this response", "invalid_nested_content_item");

    await this.patchItem("responses", responseId, { name: validated.response.name, status: validated.response.status, fallback_text: validated.response.fallbackText || null });
    for (const block of validated.response.blocks) {
      if (block.id) await this.patchItem("response_blocks", block.id, this.blockBody(responseId, block));
      else await this.createItem("response_blocks", this.blockBody(responseId, block));
    }
    for (const button of validated.response.buttons) {
      if (button.id) await this.patchItem("response_buttons", button.id, this.buttonBody(responseId, button));
      else await this.createItem("response_buttons", this.buttonBody(responseId, button));
    }
    for (const block of existingBlocks.filter((item) => !submittedBlockIds.has(item.id))) await this.deleteItem("response_blocks", block.id);
    for (const button of existingButtons.filter((item) => !submittedButtonIds.has(item.id))) await this.deleteItem("response_buttons", button.id);
    await this.patchItem("keywords", ruleId, { phrase: validated.phrase, match_mode: validated.matchMode, priority: validated.priority, enabled: validated.enabled });
    return (await this.listRules(workspaceId, botSlug)).find((item) => item?.id === ruleId);
  }

  async deleteRule(workspaceId: string, botSlug: string, ruleId: number) {
    const binding = this.binding(workspaceId, botSlug);
    const records = await this.recordsForBot(binding);
    const relationId = (value: unknown) => typeof value === "object" && value ? Number((value as { id?: unknown }).id) : Number(value);
    const keyword = records.keywords.find((item) => item.id === ruleId);
    if (!keyword) throw new DomainError(404, "Keyword rule was not found", "keyword_rule_not_found");
    const responseId = relationId(keyword.response);
    await this.deleteItem("keywords", ruleId);
    const remaining = await this.items<DirectusRecord>("keywords", new URLSearchParams({ "filter[response][_eq]": String(responseId), limit: "1", fields: "id" }));
    if (!remaining.length) {
      for (const block of records.blocks.filter((item) => relationId(item.response) === responseId)) await this.deleteItem("response_blocks", block.id);
      for (const button of records.buttons.filter((item) => relationId(item.response) === responseId)) await this.deleteItem("response_buttons", button.id);
      await this.deleteItem("responses", responseId);
    }
    return { ok: true };
  }

  async settings(workspaceId: string, botSlug: string) {
    const binding = this.binding(workspaceId, botSlug);
    const { settings } = await this.recordsForBot(binding);
    const item = settings[0];
    const relationId = (value: unknown) => typeof value === "object" && value ? Number((value as { id?: unknown }).id) : Number(value);
    return { unknownMessage: String(item?.unknown_message ?? ""), fallbackResponseId: item?.fallback_response ? relationId(item.fallback_response) : undefined };
  }

  async updateSettings(workspaceId: string, botSlug: string, input: { unknownMessage?: string; fallbackResponseId?: number | null }) {
    const binding = this.binding(workspaceId, botSlug);
    const records = await this.recordsForBot(binding);
    const fallbackResponseId = input.fallbackResponseId == null ? null : optionalId(input.fallbackResponseId);
    if (fallbackResponseId && !records.responses.some((item) => item.id === fallbackResponseId)) throw new DomainError(400, "Fallback response does not belong to this bot", "invalid_fallback_response");
    const body = { bot: records.bot.id, unknown_message: text(input.unknownMessage, 10_000) || null, fallback_response: fallbackResponseId };
    if (records.settings[0]) await this.patchItem("bot_settings", records.settings[0].id, body);
    else await this.createItem("bot_settings", body);
    return this.settings(workspaceId, botSlug);
  }

  async createMedia(workspaceId: string, botSlug: string, input: ContentMediaInput) {
    const validated = validateContentMediaInput(input);
    const binding = this.binding(workspaceId, botSlug);
    const bot = await this.contentBot(binding);
    const existing = (await this.listMedia(workspaceId, botSlug)).find((media) => media.yandexPath === validated.yandexPath);
    if (existing) return existing;
    const item = await this.createItem<DirectusRecord>("media_assets", { bot: bot.id, name: validated.name, kind: validated.kind, yandex_path: validated.yandexPath, status: validated.status });
    return (await this.listMedia(workspaceId, botSlug)).find((media) => media.id === item.id);
  }

  async updateMedia(workspaceId: string, botSlug: string, mediaId: number, input: ContentMediaInput) {
    const validated = validateContentMediaInput(input);
    const binding = this.binding(workspaceId, botSlug);
    const records = await this.recordsForBot(binding);
    if (!records.media.some((item) => item.id === mediaId)) throw new DomainError(404, "Media item was not found", "content_media_not_found");
    await this.patchItem("media_assets", mediaId, { name: validated.name, kind: validated.kind, yandex_path: validated.yandexPath, status: validated.status });
    return (await this.listMedia(workspaceId, botSlug)).find((media) => media.id === mediaId);
  }

  async deleteMedia(workspaceId: string, botSlug: string, mediaId: number) {
    const binding = this.binding(workspaceId, botSlug);
    const records = await this.recordsForBot(binding);
    if (!records.media.some((item) => item.id === mediaId)) throw new DomainError(404, "Media item was not found", "content_media_not_found");
    const relationId = (value: unknown) => typeof value === "object" && value ? Number((value as { id?: unknown }).id) : Number(value);
    const usageCount = records.blocks.filter((block) => relationId(block.media) === mediaId).length;
    if (usageCount) throw new DomainError(409, "Remove this file from all auto-replies before deleting it", "content_media_in_use");
    await this.deleteItem("media_assets", mediaId);
    return { ok: true };
  }
}
