import { ArgumentsHost, Body, Catch, Controller, Delete, ExceptionFilter, Get, Header, Headers, HttpException, Inject, Injectable, Module, OnModuleDestroy, OnModuleInit, Param, Patch, Post, Query, Req, Res, Sse } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ApiBody, ApiHeader, ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";
import { BotCrmCore, Channel, ControlMode, DomainError, NormalizedEvent } from "./core.js";
import { enrichProfileAvatar, getAdapter, verifySignature } from "./connectors.js";
import { PostgresStore } from "./postgres-store.js";
import { CampaignQueueService } from "./campaign-queue.js";
import { AuthGuard, AuthPrincipal, AuthService, PublicRoute, Roles, UserRole } from "./auth.js";
import { RateLimitGuard } from "./rate-limit.js";
import { MAX_MEDIA_BYTES, MediaStorage, MediaUploadInput, validateMediaInput } from "./media.js";
import { AutomationRuleInput } from "./automation.js";
import { SegmentGroup } from "./segment.js";
import { CampaignButton } from "./campaign-content.js";
import { exportContacts, parseContactImport } from "./contact-transfer.js";
import { RealtimeService } from "./realtime.js";
import { AttributeDefinitionInput } from "./attribute-definition.js";
import { parseWebhookChallenge } from "./input-normalization.js";

@Injectable()
export class BotCrmService implements OnModuleInit, OnModuleDestroy {
  private readonly memory = new BotCrmCore();
  private database?: PostgresStore;
  private readonly media = new MediaStorage();
  async onModuleInit() {
    if (!process.env.DATABASE_URL) return;
    const database = new PostgresStore(process.env.DATABASE_URL);
    try { await database.init(); this.database = database; console.log("BotCRM storage: PostgreSQL"); }
    catch (error) { await database.close().catch(() => undefined); console.error("PostgreSQL unavailable", error); throw error; }
  }
  async onModuleDestroy() { await this.database?.close(); }
  storageMode() { return this.database ? "postgres" : "memory"; }
  health() { return this.database?.health() ?? Promise.resolve({ status: "fallback", latencyMs: 0 }); }
  ingest(input: NormalizedEvent) { return this.database ? this.database.ingest(input) : this.memory.ingest(input); }
  upsertContact(workspace: string, input: Parameters<BotCrmCore["upsertContact"]>[1]) { return this.database ? this.database.upsertContact(workspace, input) : this.memory.upsertContact(workspace, input); }
  listContacts(workspace: string) { return this.database ? this.database.listContacts(workspace) : this.memory.listContacts(workspace); }
  listAttributeDefinitions(workspace: string) { if (!this.database) return Promise.resolve([]); return this.database.listAttributeDefinitions(workspace); }
  createAttributeDefinition(workspace: string, input: AttributeDefinitionInput) { if (!this.database) throw new DomainError(503, "PostgreSQL is required for attribute definitions", "persistent_storage_required"); return this.database.createAttributeDefinition(workspace, input); }
  updateAttributeDefinition(id: string, workspace: string, input: AttributeDefinitionInput) { if (!this.database) throw new DomainError(503, "PostgreSQL is required for attribute definitions", "persistent_storage_required"); return this.database.updateAttributeDefinition(id, workspace, input); }
  deleteAttributeDefinition(id: string, workspace: string) { if (!this.database) throw new DomainError(503, "PostgreSQL is required for attribute definitions", "persistent_storage_required"); return this.database.deleteAttributeDefinition(id, workspace); }
  private readonly contactAvatarCache = new Map<string, { expiresAt: number; value: { body: Buffer; contentType: string; cacheControl: string } }>();
  private readonly contactAvatarLoads = new Map<string, Promise<{ body: Buffer; contentType: string; cacheControl: string }>>();

  async contactAvatar(id: string, channel: Channel | undefined, workspace: string) {
    if (!this.database) throw new DomainError(503, "PostgreSQL is required for contact avatars", "persistent_storage_required");
    const source = await this.database.contactAvatarSource(id, channel, workspace);
    const version = String(source.profile.avatar_url ?? source.profile.avatar_file_id ?? "");
    const cacheKey = `${workspace}:${id}:${source.channel}:${version}`;
    const cached = this.contactAvatarCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    if (cached) this.contactAvatarCache.delete(cacheKey);

    let pending = this.contactAvatarLoads.get(cacheKey);
    if (!pending) {
      pending = this.loadContactAvatar(source);
      this.contactAvatarLoads.set(cacheKey, pending);
    }
    try {
      const value = await pending;
      if (this.contactAvatarCache.size >= 250) {
        for (const [key, entry] of this.contactAvatarCache) if (entry.expiresAt <= Date.now()) this.contactAvatarCache.delete(key);
        if (this.contactAvatarCache.size >= 250) this.contactAvatarCache.delete(this.contactAvatarCache.keys().next().value as string);
      }
      this.contactAvatarCache.set(cacheKey, { expiresAt: Date.now() + 6 * 60 * 60_000, value });
      return value;
    } finally {
      if (this.contactAvatarLoads.get(cacheKey) === pending) this.contactAvatarLoads.delete(cacheKey);
    }
  }

  private async loadContactAvatar(source: { channel: Channel; profile: Record<string, unknown>; credentials: Record<string, any> }) {
    const profile = source.profile;
    let url: URL;
    if (typeof profile.avatar_url === "string" && profile.avatar_url.trim()) {
      try { url = new URL(profile.avatar_url); }
      catch { throw new DomainError(400, "Avatar URL is invalid", "invalid_avatar_url"); }
      const host = url.hostname.toLowerCase();
      const privateHost = host === "localhost" || host === "0.0.0.0" || host === "::1" || host === "[::1]" || host.endsWith(".local") || host.endsWith(".internal") || /^127\./.test(host) || /^10\./.test(host) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || /^\[(?:fc|fd|fe[89ab])/i.test(host);
      if (url.protocol !== "https:" || url.username || url.password || privateHost) throw new DomainError(400, "Avatar URL must be a public HTTPS address", "invalid_avatar_url");
    } else if (source.channel === "telegram" && typeof profile.avatar_file_id === "string") {
      const token = String(source.credentials.botToken ?? source.credentials.bot_token ?? "");
      if (!token) throw new DomainError(409, "Telegram connector token is not configured", "avatar_connector_credentials_missing");
      const fileResponse = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(profile.avatar_file_id)}`, { signal: AbortSignal.timeout(5_000) });
      const fileBody = await fileResponse.json() as { ok?: boolean; result?: { file_path?: string } };
      if (!fileResponse.ok || !fileBody.ok || !fileBody.result?.file_path) throw new DomainError(502, "Telegram avatar is temporarily unavailable", "avatar_provider_unavailable");
      url = new URL(`https://api.telegram.org/file/bot${token}/${fileBody.result.file_path}`);
    } else {
      throw new DomainError(404, "Contact avatar not found", "contact_avatar_not_found");
    }
    const response = await fetch(url, { signal: AbortSignal.timeout(8_000), redirect: "error" });
    if (!response.ok) throw new DomainError(502, "Avatar provider returned an error", "avatar_provider_unavailable");
    const providerContentType = String(response.headers.get("content-type") ?? "").toLowerCase().split(";", 1)[0];
    // Telegram's file endpoint commonly returns profile photos as a generic
    // binary stream even though getFile gives us a trusted JPEG photo path.
    // Normalize it here so clients can keep rejecting arbitrary non-images.
    const contentType = source.channel === "telegram" && providerContentType === "application/octet-stream"
      ? "image/jpeg"
      : providerContentType;
    const declaredSize = Number(response.headers.get("content-length") ?? 0);
    if (!contentType.startsWith("image/") || declaredSize > 5 * 1024 * 1024) throw new DomainError(415, "Avatar must be an image up to 5 MB", "invalid_avatar_media");
    const body = Buffer.from(await response.arrayBuffer());
    if (body.byteLength > 5 * 1024 * 1024) throw new DomainError(413, "Avatar exceeds 5 MB", "avatar_too_large");
    return { body, contentType, cacheControl: "private, max-age=21600" };
  }
  operationalMetrics() { return this.database?.operationalMetrics() ?? Promise.resolve({}); }
  async importContacts(workspace: string, format: "csv" | "json", content: string) {
    const rows = parseContactImport(format, content); const imported: Array<{ row: number; id: string }> = []; const errors: Array<{ row: number; message: string; code?: string }> = [];
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      try { let contact = await this.createContact(workspace, row); if (row.tags.length) contact = await this.setContactTags(contact.id, workspace, row.tags); imported.push({ row: index + 2, id: contact.id }); }
      catch (error) { errors.push({ row: index + 2, message: error instanceof Error ? error.message : String(error), code: error instanceof DomainError ? error.code : undefined }); }
    }
    return { total: rows.length, imported: imported.length, failed: errors.length, rows: imported, errors };
  }
  async exportContacts(workspace: string, format: "csv" | "json") { const contacts = await this.listContacts(workspace); return { format, filename: `botcrm-contacts-${new Date().toISOString().slice(0,10)}.${format}`, mimeType: format === "csv" ? "text/csv;charset=utf-8" : "application/json;charset=utf-8", content: exportContacts(format, contacts as Array<Record<string, any>>) }; }  createContact(workspace: string, input: { displayName: string; phone?: string; email?: string; city?: string; attributes?: Record<string, unknown>; channel?: Channel; externalUserId?: string }) { if (!this.database) throw new DomainError(503,"PostgreSQL is required for contact management","persistent_storage_required"); return this.database.createContact(workspace,input); }
  updateContact(id: string, workspace: string, input: { displayName?: string; phone?: string | null; email?: string | null; city?: string | null; attributes?: Record<string, unknown>; marketingStatus?: string }) { if (!this.database) throw new DomainError(503,"PostgreSQL is required for contact management","persistent_storage_required"); return this.database.updateContact(id,workspace,input); }
  setContactTags(id: string, workspace: string, tags: string[]) { if (!this.database) throw new DomainError(503,"PostgreSQL is required for contact management","persistent_storage_required"); return this.database.setContactTags(id,workspace,tags); }
  anonymizeContact(id: string, workspace: string) { if (!this.database) throw new DomainError(503,"PostgreSQL is required for contact management","persistent_storage_required"); return this.database.anonymizeContact(id,workspace); }
  mergeContacts(id: string, sourceId: string, workspace: string) { if (!this.database) throw new DomainError(503,"PostgreSQL is required for contact management","persistent_storage_required"); return this.database.mergeContacts(id,sourceId,workspace); }
  contactActivity(id: string, workspace: string) { if (!this.database) throw new DomainError(503,"PostgreSQL is required for contact management","persistent_storage_required"); return this.database.listContactActivity(id,workspace); }
  addContactNote(id: string, workspace: string, body: string) { if (!this.database) throw new DomainError(503,"PostgreSQL is required for contact management","persistent_storage_required"); return this.database.addContactNote(id,workspace,body); }
  addContactTask(id: string, workspace: string, input: { title: string; dueAt?: string }) { if (!this.database) throw new DomainError(503,"PostgreSQL is required for contact management","persistent_storage_required"); return this.database.addContactTask(id,workspace,input); }
  completeContactTask(id: string, workspace: string) { if (!this.database) throw new DomainError(503,"PostgreSQL is required for contact management","persistent_storage_required"); return this.database.completeContactTask(id,workspace); }
  listConversations(workspace: string) { if (!this.database) throw new DomainError(503, "PostgreSQL is required for conversations", "persistent_storage_required"); return this.database.listConversations(workspace); }
  markConversationRead(id: string, workspace: string) { if (!this.database) throw new DomainError(503, "PostgreSQL is required for conversations", "persistent_storage_required"); return this.database.markConversationRead(id, workspace); }
  getConversation(id: string, workspace?: string) { return this.database ? this.database.getConversation(id, workspace) : this.memory.getConversation(id, workspace); }
  setControl(id: string, input: Parameters<BotCrmCore["setControl"]>[1], workspace?: string) { return this.database ? this.database.setControl(id, input, workspace) : this.memory.setControl(id, input, workspace); }
  sendMessage(input: Parameters<BotCrmCore["sendMessage"]>[0], workspace?: string) { return this.database ? this.database.sendMessage(input, workspace) : this.memory.sendMessage(input, workspace); }
  prepareMessageDelivery(messageId: string, workspace?: string) { if (!this.database) throw new DomainError(503, "PostgreSQL is required for message delivery", "persistent_storage_required"); return this.database.prepareMessageDelivery(messageId, workspace); }
  async createMediaUpload(workspace: string, input: MediaUploadInput, actorId?: string) {
    if (!this.database) throw new DomainError(503, "PostgreSQL is required for media uploads", "persistent_storage_required");
    const validated = validateMediaInput(input);
    const reserved = await this.database.reserveMediaUpload(workspace, validated, actorId);
    const uploadUrl = await this.media.createUploadUrl(reserved.objectKey, validated.mimeType);
    const { objectKey: _objectKey, ...upload } = reserved;
    return { ...upload, uploadUrl, method: "PUT" as const, headers: { "content-type": validated.mimeType }, maxByteSize: MAX_MEDIA_BYTES };
  }
  async completeMediaUpload(id: string, workspace?: string) {
    if (!this.database) throw new DomainError(503, "PostgreSQL is required for media uploads", "persistent_storage_required");
    const pending = await this.database.getMediaUpload(id, workspace);
    if (pending.status === "uploaded" || pending.status === "attached") { const { objectKey: _objectKey, ...upload } = pending; return upload; }
    const head = await this.media.head(pending.objectKey);
    const completed = await this.database.completeMediaUpload(id, head, workspace);
    const { objectKey: _objectKey, ...upload } = completed;
    return upload;
  }
  async attachmentDownload(id: string, workspace?: string) {
    if (!this.database) throw new DomainError(503, "PostgreSQL is required for attachments", "persistent_storage_required");
    const attachment = await this.database.getAttachment(id, workspace);
    return { url: await this.media.createDownloadUrl(attachment.objectKey, attachment.filename), expiresInSeconds: 300 };
  }
  listPipelines(workspace:string) { if(!this.database) return Promise.resolve([]); return this.database.listPipelines(workspace); }
  createPipeline(workspace:string,input:{name:string;stages?:Array<{name:string;color?:string;terminalKind?:"WON"|"LOST"}>}) { if(!this.database) throw new DomainError(503,"PostgreSQL is required","persistent_storage_required"); return this.database.createPipeline(workspace,input); }
  updatePipeline(id:string,workspace:string,input:{name?:string;isDefault?:boolean}) { if(!this.database) throw new DomainError(503,"PostgreSQL is required","persistent_storage_required"); return this.database.updatePipeline(id,workspace,input); }
  createStage(id:string,workspace:string,input:{name:string;color?:string;terminalKind?:"WON"|"LOST"}) { if(!this.database) throw new DomainError(503,"PostgreSQL is required","persistent_storage_required"); return this.database.createStage(id,workspace,input); }
  updateStage(id:string,workspace:string,input:{name?:string;color?:string;terminalKind?:"WON"|"LOST"|null;position?:number}) { if(!this.database) throw new DomainError(503,"PostgreSQL is required","persistent_storage_required"); return this.database.updateStage(id,workspace,input); }
  deleteStage(id:string,workspace:string) { if(!this.database) throw new DomainError(503,"PostgreSQL is required","persistent_storage_required"); return this.database.deleteStage(id,workspace); }
  createDeal(workspace:string,input:{contactId:string;pipelineId?:string;stageId?:string;title:string;amount?:number}) { if(!this.database) throw new DomainError(503,"PostgreSQL is required","persistent_storage_required"); return this.database.createDeal(workspace,input); }
  updateDeal(id:string,workspace:string,input:{title?:string;amount?:number;expectedVersion:number}) { if(!this.database) throw new DomainError(503,"PostgreSQL is required","persistent_storage_required"); return this.database.updateDeal(id,workspace,input); }
  listPipeline(workspace: string, pipelineId?: string) { return this.database ? this.database.listPipeline(workspace, pipelineId) : this.memory.listPipeline(workspace, pipelineId); }
  moveDeal(id: string, stageId: string, expectedVersion: number, workspace?: string) { return this.database ? this.database.moveDeal(id, stageId, expectedVersion, workspace) : this.memory.moveDeal(id, stageId, expectedVersion, workspace); }
  listSegments(workspace: string) { if (!this.database) return Promise.resolve([]); return this.database.listSegments(workspace); }
  createSegment(workspace: string, input: { name: string; filter: SegmentGroup }) { if (!this.database) throw new DomainError(503, "PostgreSQL is required for segments", "persistent_storage_required"); return this.database.createSegment(workspace, input); }
  updateSegment(id: string, workspace: string, input: { name?: string; filter?: SegmentGroup }) { if (!this.database) throw new DomainError(503, "PostgreSQL is required for segments", "persistent_storage_required"); return this.database.updateSegment(id, workspace, input); }
  deleteSegment(id: string, workspace: string) { if (!this.database) throw new DomainError(503, "PostgreSQL is required for segments", "persistent_storage_required"); return this.database.deleteSegment(id, workspace); }
  previewSegment(workspace: string, input: { segmentId?: string; filter?: SegmentGroup; channel?: Channel; limit?: number }) { if (!this.database) throw new DomainError(503, "PostgreSQL is required for segment previews", "persistent_storage_required"); return this.database.previewSegment(workspace, input); }
  previewCampaign(input: Parameters<BotCrmCore["previewCampaign"]>[0]) { return this.database ? this.database.previewCampaign(input) : this.memory.previewCampaign(input); }
  createCampaign(workspace: string, input: { name: string; channel: Channel; content: string; buttons?: CampaignButton[]; mediaIds?: string[]; segmentId?: string; audience?: number; excluded?: number; scheduledAt?: string; timeZone?: string }, actorId: string) { return this.database ? this.database.createCampaign(workspace, input, actorId) : this.memory.createCampaign(workspace, { name: input.name, channel: input.channel, content: input.content, audience: input.audience ?? 0, excluded: input.excluded ?? 0 }); }
  updateCampaign(id: string, workspace: string, input: { name: string; channel: Channel; content: string; buttons?: CampaignButton[]; mediaIds?: string[]; segmentId?: string; scheduledAt?: string; timeZone?: string }, actorId: string) { if (!this.database) throw new DomainError(503, "PostgreSQL is required for campaigns", "persistent_storage_required"); return this.database.updateCampaign(id, workspace, input, actorId); }
  listCampaigns(workspace: string) { return this.database ? this.database.listCampaigns(workspace) : this.memory.listCampaigns(workspace); }
  getAudit(workspace: string) { return this.database ? this.database.getAudit(workspace) : this.memory.getAudit(workspace); }
search(workspace: string, query: string, limit?: number) { return this.database ? this.database.search(workspace, query, limit) : Promise.resolve([]); }
  analytics(workspace: string, days?: number) { if (!this.database) throw new DomainError(503, "PostgreSQL is required for analytics", "persistent_storage_required"); return this.database.analytics(workspace, days); }
  webhookConnector(id:string,channel:Channel) { if(!this.database) throw new DomainError(503,"PostgreSQL is required for connectors","persistent_storage_required"); return this.database.webhookConnector(id,channel); }
  listConnectors(workspace: string) { if (!this.database) return Promise.resolve([]); return this.database.listConnectors(workspace); }
  createConnector(workspace: string, input: { botName: string; botSlug?: string; integrationMode?: "GATEWAY" | "MIRROR"; eventEndpoint?: string; channel: Channel; externalAccountId?: string; credentials?: Record<string, unknown> }) { if (!this.database) throw new DomainError(503, "PostgreSQL is required for connectors", "persistent_storage_required"); return this.database.createConnector(workspace, input); }
  updateConnector(id: string, workspace: string, input: { botName?: string; integrationMode?: "GATEWAY" | "MIRROR"; eventEndpoint?: string; externalAccountId?: string; credentials?: Record<string, unknown>; enabled?: boolean }) { if (!this.database) throw new DomainError(503, "PostgreSQL is required for connectors", "persistent_storage_required"); return this.database.updateConnector(id, workspace, input); }
  checkConnector(id: string, workspace: string) { if (!this.database) throw new DomainError(503, "PostgreSQL is required for connectors", "persistent_storage_required"); return this.database.checkConnector(id, workspace); }
  deleteConnector(id: string, workspace: string) { if (!this.database) throw new DomainError(503, "PostgreSQL is required for connectors", "persistent_storage_required"); return this.database.deleteConnector(id, workspace); }listAutomationRules(workspace: string) { if (!this.database) return Promise.resolve([]); return this.database.listAutomationRules(workspace); }
  createAutomationRule(workspace: string, input: AutomationRuleInput) { if (!this.database) throw new DomainError(503, "PostgreSQL is required for automations", "persistent_storage_required"); return this.database.createAutomationRule(workspace, input); }
  updateAutomationRule(id: string, workspace: string, input: Partial<AutomationRuleInput>) { if (!this.database) throw new DomainError(503, "PostgreSQL is required for automations", "persistent_storage_required"); return this.database.updateAutomationRule(id, workspace, input); }
  deleteAutomationRule(id: string, workspace: string) { if (!this.database) throw new DomainError(503, "PostgreSQL is required for automations", "persistent_storage_required"); return this.database.deleteAutomationRule(id, workspace); }
  listAutomationRuns(workspace: string, limit?: number) { if (!this.database) return Promise.resolve([]); return this.database.listAutomationRuns(workspace, limit); }
  testAutomationRule(id: string, workspace: string, contactId?: string, context?: Record<string, unknown>) { if (!this.database) throw new DomainError(503, "PostgreSQL is required for automations", "persistent_storage_required"); return this.database.testAutomationRule(id, workspace, contactId, context); }
  processAutomationTrigger(workspace: string, triggerType: string, sourceEventId: string, context: Record<string, unknown>, depth?: number) { if (!this.database) throw new DomainError(503, "PostgreSQL is required for automations", "persistent_storage_required"); return this.database.processAutomationTrigger(workspace, triggerType, sourceEventId, context, depth); }
  createCampaignTestMessage(workspace: string, input: { contactId: string; channel: Channel; content: string; buttons?: CampaignButton[]; mediaIds?: string[] }) { if (!this.database) throw new DomainError(503, "PostgreSQL is required for campaigns", "persistent_storage_required"); return this.database.createCampaignTestMessage(workspace, input); }
  startCampaign(id: string, workspace?: string) { if (!this.database) throw new DomainError(503, "PostgreSQL is required for campaigns", "persistent_storage_required"); return this.database.startCampaign(id, workspace); }
  listCampaignRecipients(id: string, workspace?: string) { if (!this.database) throw new DomainError(503, "PostgreSQL is required for campaigns", "persistent_storage_required"); return this.database.listCampaignRecipients(id, workspace); }
  pauseCampaign(id: string, workspace?: string) { if (!this.database) throw new DomainError(503, "PostgreSQL is required for campaigns", "persistent_storage_required"); return this.database.pauseCampaign(id, workspace); }
  cancelCampaign(id: string, workspace?: string) { if (!this.database) throw new DomainError(503, "PostgreSQL is required for campaigns", "persistent_storage_required"); return this.database.cancelCampaign(id, workspace); }
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse();
    if (exception instanceof DomainError) return response.status(exception.status).send({ error: { code: exception.code, message: exception.message } });
    if (exception instanceof HttpException) return response.status(exception.getStatus()).send(exception.getResponse());
    console.error(exception); return response.status(500).send({ error: { code: "internal_error", message: "Internal server error" } });
  }
}

@ApiTags("system")
@Controller()
export class SystemController {
  constructor(@Inject(BotCrmService) private readonly core: BotCrmService, @Inject(CampaignQueueService) private readonly queue: CampaignQueueService) {}
  @Get("health")
  @PublicRoute()
  async health() { return { status: "ok", service: "botcrm-api", version: "0.2.6", storage: this.core.storageMode(), database: await this.core.health(), queue: this.queue.status(), time: new Date().toISOString() }; }

  @Get("metrics")
  @Roles("OWNER", "ADMIN", "SUPERVISOR", "SERVICE")
  @Header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
  async metrics() {
    const source = await this.core.operationalMetrics() as Record<string, string | number | undefined>;
    const values: Record<string, number> = {
      workspaces_total: Number(source.workspaces ?? 0),
      contacts_total: Number(source.contacts ?? 0),
      conversations_total: Number(source.conversations ?? 0),
      messages_total: Number(source.messages ?? 0),
      messages_queued: Number(source.queued_messages ?? 0),
      messages_failed: Number(source.failed_messages ?? 0),
      outbox_pending: Number(source.pending_outbox ?? 0),
      campaign_recipients_queued: Number(source.queued_campaign_recipients ?? 0),
    };
    return `${Object.entries(values).map(([name, value]) => `# TYPE botcrm_${name} gauge\nbotcrm_${name} ${value}`).join("\n")}\n`;
  }
  @Get("connectors/capabilities")
  capabilities() {
    return [
      { channel: "telegram", inboundWebhook: true, delivery: true, read: false, receiptMode: "sent_only", edit: true, delete: true, templates: false, freeBroadcastRate: 30 },
      { channel: "vk", inboundWebhook: true, delivery: true, read: false, receiptMode: "sent_only", edit: true, delete: true, templates: false },
      { channel: "whatsapp", inboundWebhook: true, delivery: true, read: true, receiptMode: "webhook", edit: false, delete: false, templates: true, serviceWindowHours: 24 },
      { channel: "avito", inboundWebhook: true, delivery: true, read: false, receiptMode: "sent_only", edit: false, delete: false, requiresEntitlement: true },
      { channel: "api", inboundWebhook: true, delivery: true, read: true, receiptMode: "message.status", edit: true, delete: true, templates: true },
    ];
  }
}

@ApiTags("realtime")
@Controller()
export class RealtimeController {
  constructor(@Inject(RealtimeService) private readonly realtime: RealtimeService) {}

  @Sse("realtime")
  @Roles("OWNER", "ADMIN", "SUPERVISOR", "OPERATOR")
  @ApiOperation({ summary: "Authenticated workspace change stream" })
  stream(@Req() request: { auth?: AuthPrincipal }) {
    if (!request.auth) throw new DomainError(401, "Authentication required", "authentication_required");
    return this.realtime.stream(request.auth.workspaceId);
  }
}

@ApiTags("auth")
@Controller("auth")
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}
  private principal(request: { auth?: AuthPrincipal }) { if (!request.auth) throw new DomainError(401, "Authentication required", "authentication_required"); return request.auth; }

  @Post("login")
  @PublicRoute()
  @ApiOperation({ summary: "Create a password and optional TOTP authenticated session" })
  login(@Body() body: { workspace?: string; email: string; password: string; totp?: string }, @Req() request: { ip?: string; headers: Record<string, string | string[] | undefined> }) {
    if (typeof body?.email !== "string" || typeof body?.password !== "string" || !body.email.trim() || !body.password) throw new DomainError(400, "Email and password are required", "credentials_required");
    if (body.email.length > 320 || body.password.length > 512 || (body.workspace?.length ?? 0) > 128 || (body.totp?.length ?? 0) > 16) throw new DomainError(400, "Credentials exceed the allowed length", "credentials_too_long");
    const userAgent = Array.isArray(request.headers["user-agent"]) ? request.headers["user-agent"][0] : request.headers["user-agent"];
    return this.auth.login(body, { ip: request.ip, userAgent });
  }

  @Get("me")
  me(@Req() request: { auth?: AuthPrincipal }) { return this.principal(request); }

  @Post("logout")
  logout(@Req() request: { auth?: AuthPrincipal }) { return this.auth.logout(this.principal(request)); }

  @Get("sessions")
  sessions(@Req() request: { auth?: AuthPrincipal }) { return this.auth.sessions(this.principal(request)); }

  @Delete("sessions/:id")
  revokeSession(@Param("id") id: string, @Req() request: { auth?: AuthPrincipal }) { return this.auth.revokeSession(this.principal(request), id); }

  @Post("mfa/setup")
  setupMfa(@Req() request: { auth?: AuthPrincipal }) { return this.auth.setupMfa(this.principal(request)); }

  @Post("mfa/verify")
  verifyMfa(@Body() body: { code: string }, @Req() request: { auth?: AuthPrincipal }) { if (!body?.code) throw new DomainError(400, "Authentication code is required", "mfa_code_required"); return this.auth.verifyMfaSetup(this.principal(request), body.code); }

  @Delete("mfa")
  disableMfa(@Body() body: { password: string; code: string }, @Req() request: { auth?: AuthPrincipal }) { if (!body?.password || !body?.code) throw new DomainError(400, "Password and authentication code are required", "mfa_confirmation_required"); return this.auth.disableMfa(this.principal(request), body.password, body.code); }
}
@ApiTags("administration")
@Controller("admin")
@Roles("OWNER", "ADMIN")
export class AdminController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}
  private principal(request: { auth?: AuthPrincipal }) { if (!request.auth) throw new DomainError(401, "Authentication required", "authentication_required"); return request.auth; }

  @Get("users")
  listUsers(@Req() request: { auth?: AuthPrincipal }) { return this.auth.listUsers(this.principal(request)); }

  @Post("users")
  createUser(@Body() body: { email: string; displayName: string; password: string; role: Exclude<UserRole, "SERVICE"> }, @Req() request: { auth?: AuthPrincipal }) { return this.auth.createUser(this.principal(request), body); }

  @Patch("users/:id")
  updateUser(@Param("id") id: string, @Body() body: { role?: Exclude<UserRole, "SERVICE">; disabled?: boolean }, @Req() request: { auth?: AuthPrincipal }) { return this.auth.updateUser(this.principal(request), id, body); }

  @Get("teams")
  listTeams(@Req() request: { auth?: AuthPrincipal }) { return this.auth.listTeams(this.principal(request)); }

  @Post("teams")
  createTeam(@Body() body: { name: string }, @Req() request: { auth?: AuthPrincipal }) { return this.auth.createTeam(this.principal(request), body.name); }

  @Patch("teams/:id/members")
  setTeamMembers(@Param("id") id: string, @Body() body: { userIds: string[] }, @Req() request: { auth?: AuthPrincipal }) { return this.auth.setTeamMembers(this.principal(request), id, Array.isArray(body.userIds) ? body.userIds : []); }

  @Delete("teams/:id")
  deleteTeam(@Param("id") id: string, @Req() request: { auth?: AuthPrincipal }) { return this.auth.deleteTeam(this.principal(request), id); }
  @Get("service-tokens")
  listServiceTokens(@Req() request: { auth?: AuthPrincipal }) { return this.auth.listServiceTokens(this.principal(request)); }

  @Post("service-tokens")
  createServiceToken(@Body() body: { name: string; expiresAt?: string }, @Req() request: { auth?: AuthPrincipal }) { return this.auth.createServiceToken(this.principal(request), body); }

  @Delete("service-tokens/:id")
  revokeServiceToken(@Param("id") id: string, @Req() request: { auth?: AuthPrincipal }) { return this.auth.revokeServiceToken(this.principal(request), id); }
}
@ApiTags("events")
@ApiHeader({ name: "x-service-token", required: false, description: "Service token; mandatory when SERVICE_TOKEN is configured" })
@Controller()
export class ApiController {
  constructor(@Inject(BotCrmService) private readonly core: BotCrmService, @Inject(CampaignQueueService) private readonly queue: CampaignQueueService) {}

  private workspace(headers: Record<string, string | undefined>) { return headers["x-workspace-id"] || "ws_demo"; }
  private authorize(headers: Record<string, string | undefined>) { if (!headers["x-workspace-id"]) throw new DomainError(401, "Authentication required", "authentication_required"); }

  @Get("webhooks/whatsapp/:connectorId")
  @PublicRoute()
  async verifyWhatsApp(@Param("connectorId") connectorId:string,@Query("hub.mode") mode:string,@Query("hub.verify_token") token:string,@Query("hub.challenge") challenge:string) { const connector=await this.core.webhookConnector(connectorId,"whatsapp"); const expected=String(connector.credentials.verifyToken??connector.credentials.verify_token??""); if(mode!=="subscribe"||!expected||token!==expected) throw new DomainError(403,"WhatsApp verification failed","invalid_webhook_verification"); const verifiedChallenge=parseWebhookChallenge(challenge); if(verifiedChallenge===undefined) throw new DomainError(400,"WhatsApp challenge must be a canonical safe integer","invalid_webhook_challenge"); return verifiedChallenge; }

  @Post("webhooks/:channel/:connectorId")
  @PublicRoute()
  @ApiOperation({ summary: "Receive, verify and normalize an official channel webhook" })
  async receiveWebhook(@Param("channel") channel: Channel, @Param("connectorId") connectorId: string, @Body() body: any, @Headers() headers: Record<string, string | undefined>, @Req() request: { rawBody?: Buffer }) {
    const connector = await this.core.webhookConnector(connectorId, channel); const credentials = connector.credentials as Record<string,any>; const rawBody = request.rawBody?.toString("utf8") ?? JSON.stringify(body);
    if (channel === "telegram") { const expected=credentials.webhookSecret??credentials.webhook_secret??process.env.CONNECTOR_WEBHOOK_SECRET; if(!expected) throw new DomainError(503,"Telegram webhook secret is not configured","webhook_secret_missing"); if(headers["x-telegram-bot-api-secret-token"]!==expected) throw new DomainError(401,"Invalid Telegram webhook secret","invalid_webhook_secret"); }
    else if (channel === "vk") { const expected=credentials.confirmationSecret??credentials.webhookSecret??credentials.secret; if(!expected) throw new DomainError(503,"VK webhook secret is not configured","webhook_secret_missing"); if(body?.secret!==expected) throw new DomainError(401,"Invalid VK webhook secret","invalid_webhook_secret"); if(body?.type==="confirmation") return String(credentials.confirmationCode??credentials.confirmation_code??""); }
    else if (channel === "whatsapp") { const secret=credentials.appSecret??credentials.app_secret; if(!secret) throw new DomainError(503,"WhatsApp app secret is not configured","webhook_secret_missing"); if(!verifySignature(rawBody,headers["x-hub-signature-256"]??"",secret)) throw new DomainError(401,"Invalid WhatsApp webhook signature","invalid_webhook_signature"); }
    else { const secret=credentials.signingSecret??credentials.webhookSecret??credentials.secret; if(!secret) throw new DomainError(503,"Webhook signing secret is not configured","webhook_secret_missing"); if(!verifySignature(rawBody,headers["x-botcrm-signature"]??headers["x-avito-signature"]??"",secret)) throw new DomainError(401,"Invalid webhook signature","invalid_webhook_signature"); }
    const adapter = getAdapter(channel); if (!adapter) throw new DomainError(404, "Unsupported channel", "unsupported_channel");
    const events = adapter.normalize(body, { workspaceId: connector.workspaceId, botId: connector.botId, connectorId });
    const enrichedEvents = await Promise.all(events.map((event) => enrichProfileAvatar(event, credentials)));
    const results = await Promise.all(enrichedEvents.map(async (event) => { const result: any = await this.core.ingest({ ...event, connector_id: connectorId }); if (result.outboxEventId) await this.queue.enqueueBotEvent({ workspaceId: result.workspaceId, outboxId: result.outboxEventId }); return result; }));
    return { accepted: events.length, results };
  }
  @Post("events")
  @Roles("SERVICE", "OWNER", "ADMIN")
  @ApiOperation({ summary: "Ingest an idempotent normalized bot event" })
  @ApiBody({ schema: { example: { event_id: "evt_123", schema_version: "1.0", occurred_at: "2026-08-19T12:00:00Z", workspace_id: "ws_demo", bot_id: "sales_assistant", channel: "telegram", external_chat_id: "84120931", external_user_id: "84120931", type: "message.received", message: { text: "Р вЂ”Р Т‘РЎР‚Р В°Р Р†РЎРѓРЎвЂљР Р†РЎС“Р в„–РЎвЂљР Вµ" }, profile: { name: "Р С’Р Р…Р Р…Р В°" }, attributes: { lead_score: 92 } } } })
  ingest(@Body() body: NormalizedEvent, @Headers() headers: Record<string, string | undefined>) { this.authorize(headers); return this.core.ingest({ ...body, workspace_id: this.workspace(headers) }); }

  @Post("contacts/upsert")
  @Roles("SERVICE", "OWNER", "ADMIN")
  @ApiOperation({ summary: "Upsert a contact and typed bot variables" })
  upsertContact(@Body() body: { channel: Channel; externalUserId: string; name?: string; phone?: string; email?: string; city?: string; avatarUrl?: string; avatarFileId?: string; attributes?: Record<string, unknown> }, @Headers() headers: Record<string, string | undefined>) { this.authorize(headers); return this.core.upsertContact(this.workspace(headers), body); }

  @Get("contacts/:id/avatar")
  @Roles("OWNER", "ADMIN", "SUPERVISOR", "OPERATOR")
  @ApiOperation({ summary: "Load a contact avatar without exposing channel credentials" })
  async contactAvatar(@Param("id") id: string, @Query("channel") channel: Channel | undefined, @Headers() headers: Record<string, string | undefined>, @Res() reply: any) {
    this.authorize(headers);
    const avatar = await this.core.contactAvatar(id, channel, this.workspace(headers));
    return reply.header("content-type", avatar.contentType).header("cache-control", avatar.cacheControl).header("x-content-type-options", "nosniff").send(avatar.body);
  }

  @Get("attribute-definitions")
  @Roles("SERVICE", "OWNER", "ADMIN", "SUPERVISOR", "OPERATOR")
  @ApiOperation({ summary: "List registered custom attributes" })
  listAttributeDefinitions(@Headers() headers: Record<string, string | undefined>) { this.authorize(headers); return this.core.listAttributeDefinitions(this.workspace(headers)); }

  @Post("attribute-definitions")
  @Roles("OWNER", "ADMIN")
  @ApiOperation({ summary: "Register a custom attribute" })
  createAttributeDefinition(@Body() body: AttributeDefinitionInput, @Headers() headers: Record<string, string | undefined>) { this.authorize(headers); return this.core.createAttributeDefinition(this.workspace(headers), body); }

  @Patch("attribute-definitions/:id")
  @Roles("OWNER", "ADMIN")
  @ApiOperation({ summary: "Update custom attribute metadata" })
  updateAttributeDefinition(@Param("id") id: string, @Body() body: AttributeDefinitionInput, @Headers() headers: Record<string, string | undefined>) { this.authorize(headers); return this.core.updateAttributeDefinition(id, this.workspace(headers), body); }

  @Delete("attribute-definitions/:id")
  @Roles("OWNER", "ADMIN")
  @ApiOperation({ summary: "Remove custom attribute metadata without deleting contact values" })
  deleteAttributeDefinition(@Param("id") id: string, @Headers() headers: Record<string, string | undefined>) { this.authorize(headers); return this.core.deleteAttributeDefinition(id, this.workspace(headers)); }
  @Get("contacts")
  @Roles("OWNER", "ADMIN", "SUPERVISOR", "OPERATOR")
  listContacts(@Headers() headers: Record<string, string | undefined>) { this.authorize(headers); return this.core.listContacts(this.workspace(headers)); }

  @Get("contacts/export")
  @Roles("OWNER", "ADMIN", "SUPERVISOR")
  exportContacts(@Query("format") format: string, @Headers() headers: Record<string,string|undefined>) { this.authorize(headers); return this.core.exportContacts(this.workspace(headers), format === "json" ? "json" : "csv"); }

  @Post("contacts/import")
  @Roles("OWNER", "ADMIN", "SUPERVISOR")
  importContacts(@Body() body: { format: "csv" | "json"; content: string }, @Headers() headers: Record<string,string|undefined>) { this.authorize(headers); if (!body || !["csv","json"].includes(body.format) || typeof body.content !== "string") throw new DomainError(400,"Import format and content are required","invalid_contact_import"); return this.core.importContacts(this.workspace(headers),body.format,body.content); }
  @Post("contacts")
  @Roles("OWNER", "ADMIN", "SUPERVISOR", "OPERATOR")
  createContact(@Body() body: { displayName: string; phone?: string; email?: string; city?: string; attributes?: Record<string, unknown>; channel?: Channel; externalUserId?: string }, @Headers() headers: Record<string,string|undefined>) { this.authorize(headers); return this.core.createContact(this.workspace(headers),body); }

  @Patch("contacts/:id")
  @Roles("OWNER", "ADMIN", "SUPERVISOR", "OPERATOR")
  updateContact(@Param("id") id: string, @Body() body: { displayName?: string; phone?: string|null; email?: string|null; city?: string|null; attributes?: Record<string,unknown>; marketingStatus?: string }, @Headers() headers: Record<string,string|undefined>) { this.authorize(headers); return this.core.updateContact(id,this.workspace(headers),body); }

  @Patch("contacts/:id/tags")
  @Roles("OWNER", "ADMIN", "SUPERVISOR", "OPERATOR")
  setContactTags(@Param("id") id: string, @Body() body: { tags: string[] }, @Headers() headers: Record<string,string|undefined>) { this.authorize(headers); return this.core.setContactTags(id,this.workspace(headers),Array.isArray(body.tags)?body.tags:[]); }

  @Delete("contacts/:id")
  @Roles("OWNER", "ADMIN")
  anonymizeContact(@Param("id") id: string, @Headers() headers: Record<string,string|undefined>) { this.authorize(headers); return this.core.anonymizeContact(id,this.workspace(headers)); }

  @Post("contacts/:id/merge")
  @Roles("OWNER", "ADMIN", "SUPERVISOR")
  mergeContacts(@Param("id") id: string, @Body() body: { sourceContactId: string }, @Headers() headers: Record<string,string|undefined>) { this.authorize(headers); return this.core.mergeContacts(id,body.sourceContactId,this.workspace(headers)); }

  @Get("contacts/:id/activity")
  @Roles("OWNER", "ADMIN", "SUPERVISOR", "OPERATOR")
  contactActivity(@Param("id") id: string, @Headers() headers: Record<string,string|undefined>) { this.authorize(headers); return this.core.contactActivity(id,this.workspace(headers)); }

  @Post("contacts/:id/notes")
  @Roles("OWNER", "ADMIN", "SUPERVISOR", "OPERATOR")
  addContactNote(@Param("id") id: string, @Body() body: { body: string }, @Headers() headers: Record<string,string|undefined>) { this.authorize(headers); return this.core.addContactNote(id,this.workspace(headers),body.body); }

  @Post("contacts/:id/tasks")
  @Roles("OWNER", "ADMIN", "SUPERVISOR", "OPERATOR")
  addContactTask(@Param("id") id: string, @Body() body: { title: string; dueAt?: string }, @Headers() headers: Record<string,string|undefined>) { this.authorize(headers); return this.core.addContactTask(id,this.workspace(headers),body); }

  @Patch("tasks/:id/complete")
  @Roles("OWNER", "ADMIN", "SUPERVISOR", "OPERATOR")
  completeTask(@Param("id") id: string, @Headers() headers: Record<string,string|undefined>) { this.authorize(headers); return this.core.completeContactTask(id,this.workspace(headers)); }

  @Get("conversations")
  @Roles("OWNER", "ADMIN", "SUPERVISOR", "OPERATOR")
  listConversations(@Headers() headers: Record<string, string | undefined>) { this.authorize(headers); return this.core.listConversations(this.workspace(headers)); }

  @Patch("conversations/:id/read")
  @Roles("OWNER", "ADMIN", "SUPERVISOR", "OPERATOR")
  markConversationRead(@Param("id") id: string, @Headers() headers: Record<string, string | undefined>) { this.authorize(headers); return this.core.markConversationRead(id, this.workspace(headers)); }

  @Get("conversations/:id")
  @Roles("SERVICE", "OWNER", "ADMIN", "SUPERVISOR", "OPERATOR")
  @ApiParam({ name: "id" })
  getConversation(@Param("id") id: string, @Headers() headers: Record<string, string | undefined>) { this.authorize(headers); return this.core.getConversation(id, this.workspace(headers)); }

  @Patch("conversations/:id/control")
  @Roles("SERVICE", "OWNER", "ADMIN", "SUPERVISOR", "OPERATOR")
  @ApiOperation({ summary: "Atomically claim, pause, or return a conversation" })
  async setControl(@Param("id") id: string, @Body() body: { mode: ControlMode; expectedVersion: number }, @Headers() headers: Record<string, string | undefined>, @Req() request: { auth?: AuthPrincipal }) {
    this.authorize(headers);
    const result: any = await this.core.setControl(id, { ...body, userId: request.auth?.userId }, this.workspace(headers));
    if (result.outboxEventId) await this.queue.enqueueBotEvent({ workspaceId: result.workspaceId, outboxId: result.outboxEventId });
    return result;
  }

  @Post("media/uploads")
  @Roles("SERVICE", "OWNER", "ADMIN", "SUPERVISOR", "OPERATOR")
  @ApiOperation({ summary: "Reserve an S3 upload and return a short-lived signed PUT URL" })
  createMediaUpload(@Body() body: MediaUploadInput, @Headers() headers: Record<string, string | undefined>, @Req() request: { auth?: AuthPrincipal }) {
    this.authorize(headers);
    return this.core.createMediaUpload(this.workspace(headers), body, request.auth?.userId);
  }

  @Post("media/uploads/:id/complete")
  @Roles("SERVICE", "OWNER", "ADMIN", "SUPERVISOR", "OPERATOR")
  @ApiOperation({ summary: "Verify an uploaded object before it can be attached to a message" })
  completeMediaUpload(@Param("id") id: string, @Headers() headers: Record<string, string | undefined>) {
    this.authorize(headers);
    return this.core.completeMediaUpload(id, this.workspace(headers));
  }

  @Get("media/attachments/:id/url")
  @Roles("OWNER", "ADMIN", "SUPERVISOR", "OPERATOR")
  @ApiOperation({ summary: "Create a five-minute signed URL for an attachment" })
  attachmentDownload(@Param("id") id: string, @Headers() headers: Record<string, string | undefined>) {
    this.authorize(headers);
    return this.core.attachmentDownload(id, this.workspace(headers));
  }
  @Post("messages/send")
  @Roles("SERVICE", "OWNER", "ADMIN", "SUPERVISOR", "OPERATOR")
  @ApiOperation({ summary: "Queue an operator or bot outbound message" })
  async sendMessage(@Body() body: { conversationId: string; actor: "bot" | "operator"; text: string; attachmentIds?: string[] }, @Headers("idempotency-key") idempotencyKey: string, @Headers() headers: Record<string, string | undefined>) {
    this.authorize(headers);
    const workspace = this.workspace(headers);
    const result: any = await this.core.sendMessage({ ...body, idempotencyKey }, workspace);
    if (result.message.status === "queued") {
      const delivery = await this.core.prepareMessageDelivery(result.message.id, workspace);
      await this.queue.enqueueMessage(delivery);
    }
    if (result.outboxEventId) await this.queue.enqueueBotEvent({ workspaceId: result.workspaceId, outboxId: result.outboxEventId });
    return result;
  }

  @Get("pipelines")
  @Roles("OWNER","ADMIN","SUPERVISOR","OPERATOR")
  pipelines(@Headers() headers:Record<string,string|undefined>){this.authorize(headers);return this.core.listPipelines(this.workspace(headers));}
  @Post("pipelines")
  @Roles("OWNER","ADMIN","SUPERVISOR")
  createPipeline(@Body() body:{name:string;stages?:Array<{name:string;color?:string;terminalKind?:"WON"|"LOST"}>},@Headers() headers:Record<string,string|undefined>){this.authorize(headers);return this.core.createPipeline(this.workspace(headers),body);}
  @Patch("pipelines/:id")
  @Roles("OWNER","ADMIN","SUPERVISOR")
  updatePipeline(@Param("id") id:string,@Body() body:{name?:string;isDefault?:boolean},@Headers() headers:Record<string,string|undefined>){this.authorize(headers);return this.core.updatePipeline(id,this.workspace(headers),body);}
  @Post("pipelines/:id/stages")
  @Roles("OWNER","ADMIN","SUPERVISOR")
  createStage(@Param("id") id:string,@Body() body:{name:string;color?:string;terminalKind?:"WON"|"LOST"},@Headers() headers:Record<string,string|undefined>){this.authorize(headers);return this.core.createStage(id,this.workspace(headers),body);}
  @Patch("stages/:id")
  @Roles("OWNER","ADMIN","SUPERVISOR")
  updateStage(@Param("id") id:string,@Body() body:{name?:string;color?:string;terminalKind?:"WON"|"LOST"|null;position?:number},@Headers() headers:Record<string,string|undefined>){this.authorize(headers);return this.core.updateStage(id,this.workspace(headers),body);}
  @Delete("stages/:id")
  @Roles("OWNER","ADMIN","SUPERVISOR")
  deleteStage(@Param("id") id:string,@Headers() headers:Record<string,string|undefined>){this.authorize(headers);return this.core.deleteStage(id,this.workspace(headers));}
  @Post("deals")
  @Roles("OWNER","ADMIN","SUPERVISOR","OPERATOR")
  createDeal(@Body() body:{contactId:string;pipelineId?:string;stageId?:string;title:string;amount?:number},@Headers() headers:Record<string,string|undefined>){this.authorize(headers);return this.core.createDeal(this.workspace(headers),body);}
  @Patch("deals/:id")
  @Roles("OWNER","ADMIN","SUPERVISOR","OPERATOR")
  updateDeal(@Param("id") id:string,@Body() body:{title?:string;amount?:number;expectedVersion:number},@Headers() headers:Record<string,string|undefined>){this.authorize(headers);return this.core.updateDeal(id,this.workspace(headers),body);}

  @Get("pipelines/:pipelineId/deals")
  @Roles("OWNER", "ADMIN", "SUPERVISOR", "OPERATOR")
  listDeals(@Param("pipelineId") pipelineId: string, @Headers() headers: Record<string, string | undefined>) { this.authorize(headers); return this.core.listPipeline(this.workspace(headers), pipelineId); }

  @Patch("deals/:id/stage")
  @Roles("OWNER", "ADMIN", "SUPERVISOR", "OPERATOR")
  @ApiOperation({ summary: "Move a deal with optimistic concurrency" })
  moveDeal(@Param("id") id: string, @Body() body: { stageId: string; expectedVersion: number }, @Headers() headers: Record<string, string | undefined>) { this.authorize(headers); return this.core.moveDeal(id, body.stageId, body.expectedVersion, this.workspace(headers)); }

  @Get("segments")
  @Roles("OWNER", "ADMIN", "SUPERVISOR", "OPERATOR")
  listSegments(@Headers() headers: Record<string, string | undefined>) { this.authorize(headers); return this.core.listSegments(this.workspace(headers)); }

  @Post("segments/preview")
  @Roles("OWNER", "ADMIN", "SUPERVISOR", "OPERATOR")
  previewSegment(@Body() body: { segmentId?: string; filter?: SegmentGroup; channel?: Channel; limit?: number }, @Headers() headers: Record<string, string | undefined>) { this.authorize(headers); return this.core.previewSegment(this.workspace(headers), body); }

  @Post("segments")
  @Roles("OWNER", "ADMIN", "SUPERVISOR")
  createSegment(@Body() body: { name: string; filter: SegmentGroup }, @Headers() headers: Record<string, string | undefined>) { this.authorize(headers); return this.core.createSegment(this.workspace(headers), body); }

  @Patch("segments/:id")
  @Roles("OWNER", "ADMIN", "SUPERVISOR")
  updateSegment(@Param("id") id: string, @Body() body: { name?: string; filter?: SegmentGroup }, @Headers() headers: Record<string, string | undefined>) { this.authorize(headers); return this.core.updateSegment(id, this.workspace(headers), body); }

  @Delete("segments/:id")
  @Roles("OWNER", "ADMIN", "SUPERVISOR")
  deleteSegment(@Param("id") id: string, @Headers() headers: Record<string, string | undefined>) { this.authorize(headers); return this.core.deleteSegment(id, this.workspace(headers)); }

  @Post("campaigns/preview")
  @Roles("OWNER", "ADMIN", "SUPERVISOR")
  previewCampaign(@Body() body: { segmentId?: string; filter?: SegmentGroup; channel?: Channel; limit?: number }, @Headers() headers: Record<string, string | undefined>) { this.authorize(headers); return this.core.previewSegment(this.workspace(headers), body); }

  @Post("campaigns")
  @Roles("OWNER", "ADMIN", "SUPERVISOR")
  createCampaign(@Body() body: { name: string; channel: Channel; content: string; buttons?: CampaignButton[]; mediaIds?: string[]; segmentId?: string; scheduledAt?: string; timeZone?: string }, @Headers() headers: Record<string, string | undefined>, @Req() request: { auth?: AuthPrincipal }) {
    this.authorize(headers);
    if (!request.auth) throw new DomainError(401, "Authentication required", "authentication_required");
    return this.core.createCampaign(this.workspace(headers), body, request.auth.userId);
  }

  @Patch("campaigns/:id")
  @Roles("OWNER", "ADMIN", "SUPERVISOR")
  updateCampaign(@Param("id") id: string, @Body() body: { name: string; channel: Channel; content: string; buttons?: CampaignButton[]; mediaIds?: string[]; segmentId?: string; scheduledAt?: string; timeZone?: string }, @Headers() headers: Record<string, string | undefined>, @Req() request: { auth?: AuthPrincipal }) {
    this.authorize(headers);
    if (!request.auth) throw new DomainError(401, "Authentication required", "authentication_required");
    return this.core.updateCampaign(id, this.workspace(headers), body, request.auth.userId);
  }

  @Post("campaigns/test")
  @Roles("OWNER", "ADMIN", "SUPERVISOR")
  async testCampaign(@Body() body: { contactId: string; channel: Channel; content: string; buttons?: CampaignButton[]; mediaIds?: string[] }, @Headers() headers: Record<string,string|undefined>) { this.authorize(headers); const workspace=this.workspace(headers); const result:any=await this.core.createCampaignTestMessage(workspace,body); const delivery=await this.core.prepareMessageDelivery(result.message.id,workspace); await this.queue.enqueueMessage(delivery); return result; }
  @Post("campaigns/:id/start")
  @Roles("SERVICE", "OWNER", "ADMIN", "SUPERVISOR")
  @ApiOperation({ summary: "Snapshot eligible recipients and enqueue a campaign" })
  async startCampaign(@Param("id") id: string, @Headers() headers: Record<string, string | undefined>) {
    this.authorize(headers);
    const workspace = this.workspace(headers);
    const prepared = await this.core.startCampaign(id, workspace);
    try {
      const queued = await this.queue.enqueue(prepared.jobs);
      return { campaignId: id, channel: prepared.channel, recipients: prepared.queued, queued: queued.queued };
    } catch (error) {
      await this.core.pauseCampaign(id, workspace).catch(() => undefined);
      throw error;
    }
  }

  @Post("campaigns/:id/pause")
  @Roles("OWNER", "ADMIN", "SUPERVISOR")
  @ApiOperation({ summary: "Pause a running or scheduled campaign" })
  pauseCampaign(@Param("id") id: string, @Headers() headers: Record<string, string | undefined>) { this.authorize(headers); return this.core.pauseCampaign(id, this.workspace(headers)); }

  @Post("campaigns/:id/cancel")
  @Roles("OWNER", "ADMIN", "SUPERVISOR")
  @ApiOperation({ summary: "Cancel a campaign and suppress outstanding recipients" })
  cancelCampaign(@Param("id") id: string, @Headers() headers: Record<string, string | undefined>) { this.authorize(headers); return this.core.cancelCampaign(id, this.workspace(headers)); }
  @Get("campaigns/:id/recipients")
  @Roles("OWNER", "ADMIN", "SUPERVISOR")
  listCampaignRecipients(@Param("id") id: string, @Headers() headers: Record<string, string | undefined>) { this.authorize(headers); return this.core.listCampaignRecipients(id, this.workspace(headers)); }
  @Get("campaigns")
  @Roles("OWNER", "ADMIN", "SUPERVISOR", "OPERATOR")
  listCampaigns(@Headers() headers: Record<string, string | undefined>) { this.authorize(headers); return this.core.listCampaigns(this.workspace(headers)); }

  @Get("connectors")
  @Roles("OWNER", "ADMIN", "SUPERVISOR", "OPERATOR")
  listConnectors(@Headers() headers: Record<string, string | undefined>) { this.authorize(headers); return this.core.listConnectors(this.workspace(headers)); }

  @Post("connectors")
  @Roles("OWNER", "ADMIN")
  createConnector(@Body() body: { botName: string; botSlug?: string; integrationMode?: "GATEWAY" | "MIRROR"; eventEndpoint?: string; channel: Channel; externalAccountId?: string; credentials?: Record<string, unknown> }, @Headers() headers: Record<string, string | undefined>) { this.authorize(headers); return this.core.createConnector(this.workspace(headers), body); }

  @Patch("connectors/:id")
  @Roles("OWNER", "ADMIN")
  updateConnector(@Param("id") id: string, @Body() body: { botName?: string; integrationMode?: "GATEWAY" | "MIRROR"; eventEndpoint?: string; externalAccountId?: string; credentials?: Record<string, unknown>; enabled?: boolean }, @Headers() headers: Record<string, string | undefined>) { this.authorize(headers); return this.core.updateConnector(id, this.workspace(headers), body); }

  @Post("connectors/:id/check")
  @Roles("OWNER", "ADMIN", "SUPERVISOR")
  checkConnector(@Param("id") id: string, @Headers() headers: Record<string, string | undefined>) { this.authorize(headers); return this.core.checkConnector(id, this.workspace(headers)); }

  @Delete("connectors/:id")
  @Roles("OWNER", "ADMIN")
  deleteConnector(@Param("id") id: string, @Headers() headers: Record<string, string | undefined>) { this.authorize(headers); return this.core.deleteConnector(id, this.workspace(headers)); }
  @Get("automations")
  @Roles("OWNER", "ADMIN", "SUPERVISOR", "OPERATOR")
  listAutomations(@Headers() headers: Record<string, string | undefined>) { this.authorize(headers); return this.core.listAutomationRules(this.workspace(headers)); }

  @Post("automations")
  @Roles("OWNER", "ADMIN", "SUPERVISOR")
  createAutomation(@Body() body: AutomationRuleInput, @Headers() headers: Record<string, string | undefined>) { this.authorize(headers); return this.core.createAutomationRule(this.workspace(headers), body); }

  @Patch("automations/:id")
  @Roles("OWNER", "ADMIN", "SUPERVISOR")
  updateAutomation(@Param("id") id: string, @Body() body: Partial<AutomationRuleInput>, @Headers() headers: Record<string, string | undefined>) { this.authorize(headers); return this.core.updateAutomationRule(id, this.workspace(headers), body); }

  @Delete("automations/:id")
  @Roles("OWNER", "ADMIN", "SUPERVISOR")
  deleteAutomation(@Param("id") id: string, @Headers() headers: Record<string, string | undefined>) { this.authorize(headers); return this.core.deleteAutomationRule(id, this.workspace(headers)); }

  @Get("automations/runs")
  @Roles("OWNER", "ADMIN", "SUPERVISOR", "OPERATOR")
  automationRuns(@Query("limit") limit: string, @Headers() headers: Record<string, string | undefined>) { this.authorize(headers); return this.core.listAutomationRuns(this.workspace(headers), Number(limit) || 100); }

  @Post("automations/:id/test")
  @Roles("OWNER", "ADMIN", "SUPERVISOR")
  testAutomation(@Param("id") id: string, @Body() body: { contactId?: string; context?: Record<string, unknown> }, @Headers() headers: Record<string, string | undefined>) { this.authorize(headers); return this.core.testAutomationRule(id, this.workspace(headers), body?.contactId, body?.context); }
  @Post("automations/process")
  @Roles("SERVICE")
  processAutomation(@Body() body: { triggerType: string; sourceEventId: string; context?: Record<string, unknown>; depth?: number }, @Headers() headers: Record<string, string | undefined>) {
    this.authorize(headers);
    if (!body?.triggerType || !body?.sourceEventId) throw new DomainError(400, "Trigger type and source event ID are required", "invalid_automation_event");
    return this.core.processAutomationTrigger(this.workspace(headers), body.triggerType, body.sourceEventId, body.context ?? {}, body.depth ?? 0);
  }
  @Get("search")
  @Roles("OWNER", "ADMIN", "SUPERVISOR", "OPERATOR")
  @ApiOperation({ summary: "Search contacts, messages, and deals" })
  search(@Query("q") query: string, @Query("limit") limit: string, @Headers() headers: Record<string, string | undefined>) {
    this.authorize(headers);
    return this.core.search(this.workspace(headers), query, Number(limit) || 30);
  }

  @Get("analytics")
  @Roles("OWNER", "ADMIN", "SUPERVISOR", "OPERATOR")
  @ApiOperation({ summary: "Return live workspace CRM analytics" })
  analytics(@Query("days") days: string, @Headers() headers: Record<string, string | undefined>) {
    this.authorize(headers);
    return this.core.analytics(this.workspace(headers), Number(days) || 30);
  }
  @Get("audit")
  @Roles("OWNER", "ADMIN", "SUPERVISOR")
  async audit(@Headers() headers: Record<string, string | undefined>, @Query("limit") limit = "100") { this.authorize(headers); const entries = await this.core.getAudit(this.workspace(headers)); return entries.slice(0, Math.min(Number(limit) || 100, 1000)); }
}

@Module({ controllers: [SystemController, RealtimeController, AuthController, AdminController, ApiController], providers: [BotCrmService, CampaignQueueService, RealtimeService, AuthService, RateLimitGuard, AuthGuard, { provide: APP_GUARD, useExisting: RateLimitGuard }, { provide: APP_GUARD, useExisting: AuthGuard }] })
export class AppModule {}
