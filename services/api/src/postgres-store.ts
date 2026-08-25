import { createHmac, randomUUID } from "node:crypto";
import { Pool, PoolClient } from "pg";
import { AttachmentRecord, CampaignRecord, Channel, ControlMode, DealRecord, DomainError, MessageRecord, NormalizedEvent } from "./core.js";
import { MAX_ATTACHMENTS_PER_MESSAGE, MediaObjectHead, MediaUploadInput } from "./media.js";
import { AutomationAction, AutomationRuleInput, automationMatches, isUuid, validateAutomationRule } from "./automation.js";
import { decryptSecret, encryptSecret } from "./secrets.js";
import { compileSegmentFilter, SegmentGroup, validateSegmentFilter } from "./segment.js";
import { renderCampaignTemplate } from "./campaign-template.js";
import { CampaignButton, validateCampaignContent } from "./campaign-content.js";
import { AttributeAuthority, AttributeDefinitionInput, humanizeAttributeKey, inferAttributeValueType, validateAttributeDefinition } from "./attribute-definition.js";
import { normalizeBotSlug } from "./input-normalization.js";

const DEMO_WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const DEMO_USER_ID = "00000000-0000-4000-8000-000000000002";

function percentDelta(current: number, previous: number) {
  if (!previous) return current ? 100 : 0;
  return ((current - previous) / Math.abs(previous)) * 100;
}

async function dispatchAutomationWebhook(urlValue: string, payload: Record<string, unknown>) {
  const url = new URL(urlValue);
  const allowlist = new Set((process.env.AUTOMATION_WEBHOOK_ALLOWLIST ?? "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean));
  if (!allowlist.has(url.hostname.toLowerCase())) throw new DomainError(403, `Webhook host ${url.hostname} is not allowed`, "automation_webhook_forbidden");
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "BotCRM-Automation/1.0" };
  if (process.env.AUTOMATION_WEBHOOK_SECRET) headers["x-botcrm-signature"] = `sha256=${createHmac("sha256", process.env.AUTOMATION_WEBHOOK_SECRET).update(body).digest("hex")}`;
  const response = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(8_000), redirect: "error" });
  if (!response.ok) throw new Error(`Automation webhook returned ${response.status}`);
  return { status: response.status };
}
export class PostgresStore {
  readonly pool: Pool;
  constructor(databaseUrl: string) { this.pool = new Pool({ connectionString: databaseUrl, max: Number(process.env.DATABASE_POOL_SIZE ?? 10), connectionTimeoutMillis: 4_000 }); }
  async init() { await this.pool.query("select 1"); }
  async close() { await this.pool.end(); }
  async health() { const started = Date.now(); await this.pool.query("select 1"); return { status: "ok", latencyMs: Date.now() - started }; }

  private async workspaceId(workspace: string, client: Pool | PoolClient = this.pool) {
    if (workspace === "ws_demo") return DEMO_WORKSPACE_ID;
    const result = await client.query<{ id: string }>("select id from workspaces where id::text=$1 limit 1", [workspace]);
    if (!result.rowCount) throw new DomainError(404, "Workspace not found", "workspace_not_found");
    return result.rows[0].id;
  }

  private mapAttributeDefinition(row: any) {
    return { id: row.id, workspaceId: row.workspace_id, objectScope: row.object_scope, key: row.key, label: row.label, valueType: row.value_type, authority: row.authority, config: row.config ?? {}, filterable: Boolean(row.filterable), usageCount: Number(row.usage_count ?? 0), example: row.example ?? undefined, createdAt: new Date(row.created_at).toISOString() };
  }

  private async discoverAttributeDefinitions(client: Pool | PoolClient, workspaceId: string, authority: AttributeAuthority, attributes?: Record<string, unknown>, config: Record<string, unknown> = {}) {
    for (const [key, value] of Object.entries(attributes ?? {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,79}$/.test(key)) continue;
      await client.query(`insert into attribute_definitions(workspace_id,object_scope,key,label,value_type,authority,config,filterable)
        values($1,'CONTACT',$2,$3,$4,$5,$6,true) on conflict(workspace_id,object_scope,key) do nothing`, [workspaceId, key, humanizeAttributeKey(key), inferAttributeValueType(value), authority, JSON.stringify({ discovered: true, ...config })]);
    }
  }

  async listAttributeDefinitions(workspace: string) {
    const workspaceId = await this.workspaceId(workspace);
    const result = await this.pool.query(`select ad.*,
      case when ad.object_scope='CONTACT' then (select count(*) from contacts ct where ct.workspace_id=ad.workspace_id and ct.deleted_at is null and ct.custom_fields ? ad.key) else 0 end usage_count,
      case when ad.object_scope='CONTACT' then (select ct.custom_fields->ad.key from contacts ct where ct.workspace_id=ad.workspace_id and ct.deleted_at is null and ct.custom_fields ? ad.key limit 1) else null end example
      from attribute_definitions ad where ad.workspace_id=$1 order by ad.object_scope,lower(ad.label),ad.key`, [workspaceId]);
    return result.rows.map((row) => this.mapAttributeDefinition(row));
  }

  async createAttributeDefinition(workspace: string, input: AttributeDefinitionInput) {
    const workspaceId = await this.workspaceId(workspace);
    const value = validateAttributeDefinition({ objectScope: "CONTACT", authority: "PLATFORM", filterable: true, config: {}, ...input });
    try {
      const result = await this.pool.query(`insert into attribute_definitions(workspace_id,object_scope,key,label,value_type,authority,config,filterable) values($1,$2,$3,$4,$5,$6,$7,$8) returning *`, [workspaceId, value.objectScope, value.key, value.label, value.valueType, value.authority, JSON.stringify(value.config ?? {}), value.filterable]);
      await this.pool.query("insert into audit_events(workspace_id,actor_type,actor_id,action,entity_type,entity_id,changes) values($1,'USER',$2,'attribute_definition.created','attribute_definition',$3,$4)", [workspaceId, DEMO_USER_ID, result.rows[0].id, JSON.stringify(value)]);
      return this.mapAttributeDefinition(result.rows[0]);
    } catch (error: any) { if (error?.code === "23505") throw new DomainError(409, "An attribute with this key already exists", "attribute_definition_conflict"); throw error; }
  }

  async updateAttributeDefinition(id: string, workspace: string, input: AttributeDefinitionInput) {
    const workspaceId = await this.workspaceId(workspace); const value = validateAttributeDefinition(input, true);
    const result = await this.pool.query(`update attribute_definitions set label=coalesce($3,label),value_type=coalesce($4,value_type),authority=coalesce($5,authority),config=coalesce($6,config),filterable=coalesce($7,filterable) where id=$1 and workspace_id=$2 returning *`, [id, workspaceId, value.label ?? null, value.valueType ?? null, value.authority ?? null, value.config === undefined ? null : JSON.stringify(value.config), value.filterable ?? null]);
    if (!result.rowCount) throw new DomainError(404, "Attribute definition not found", "attribute_definition_not_found");
    await this.pool.query("insert into audit_events(workspace_id,actor_type,actor_id,action,entity_type,entity_id,changes) values($1,'USER',$2,'attribute_definition.updated','attribute_definition',$3,$4)", [workspaceId, DEMO_USER_ID, id, JSON.stringify(value)]);
    return this.mapAttributeDefinition(result.rows[0]);
  }

  async deleteAttributeDefinition(id: string, workspace: string) {
    const workspaceId = await this.workspaceId(workspace); const result = await this.pool.query("delete from attribute_definitions where id=$1 and workspace_id=$2 returning id,key", [id, workspaceId]);
    if (!result.rowCount) throw new DomainError(404, "Attribute definition not found", "attribute_definition_not_found");
    await this.pool.query("insert into audit_events(workspace_id,actor_type,actor_id,action,entity_type,entity_id,changes) values($1,'USER',$2,'attribute_definition.deleted','attribute_definition',$3,$4)", [workspaceId, DEMO_USER_ID, id, JSON.stringify({ key: result.rows[0].key, valuesPreserved: true })]);
    return { ok: true, valuesPreserved: true };
  }
  private async ensureBot(client: PoolClient, workspaceId: string, slug: string) {
    const normalized = slug.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_") || "custom_bot";
    const result = await client.query<{ id: string }>(`insert into bots(workspace_id,slug,name,integration_mode) values($1,$2,$3,'MIRROR') on conflict(workspace_id,slug) do update set name=excluded.name returning id`, [workspaceId, normalized, slug]);
    return result.rows[0].id;
  }

  async ingest(event: NormalizedEvent) {
    if (!event.event_id || event.schema_version !== "1.0" || !event.workspace_id || !event.bot_id || !event.channel || !event.external_chat_id || !event.external_user_id || !event.type) throw new DomainError(400, "Normalized event is incomplete", "invalid_event");
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const workspaceId = await this.workspaceId(event.workspace_id, client);
      const accepted = await client.query("insert into ingested_events(workspace_id,event_id,occurred_at) values($1,$2,$3) on conflict do nothing returning event_id", [workspaceId, event.event_id, event.occurred_at]);
      if (!accepted.rowCount) { const existingOutbox = await client.query("select id,payload->>'connectorId' as connector_id from outbox_events where workspace_id=$1 and topic='bot.event' and aggregate_id=$2 order by created_at desc limit 1", [workspaceId, event.event_id]); await client.query("rollback"); return { duplicate: true, eventId: event.event_id, workspaceId, outboxEventId: existingOutbox.rows[0]?.id, connectorId: existingOutbox.rows[0]?.connector_id }; }

      if (event.type === "message.status") {
        const externalId = event.message?.external_id; const requested = String(event.attributes?.status ?? "").toUpperCase();
        const allowed = new Set(["SENT", "DELIVERED", "READ", "FAILED"]); if (!externalId || !allowed.has(requested)) throw new DomainError(400, "Message status event is incomplete", "invalid_message_status");
        const updated = await client.query(`update messages m set
            status=case
              when $3::text='FAILED' and m.status not in ('DELIVERED','READ') then 'FAILED'::message_status
              when $3::text='READ' then 'READ'::message_status
              when $3::text='DELIVERED' and m.status not in ('READ','FAILED') then 'DELIVERED'::message_status
              when $3::text='SENT' and m.status in ('QUEUED') then 'SENT'::message_status
              else m.status
            end,
            error_code=case when $3::text='FAILED' and m.status not in ('DELIVERED','READ') then coalesce($4,error_code) when $3::text<>'FAILED' then null else error_code end,
            error_message=case when $3::text='FAILED' and m.status not in ('DELIVERED','READ') then coalesce($5,error_message) when $3::text<>'FAILED' then null else error_message end
          from conversations c where m.conversation_id=c.id and m.workspace_id=$1 and m.external_id=$2 and c.channel=$6 returning m.id,m.conversation_id,m.status`, [workspaceId, externalId, requested, event.attributes?.error_code ?? null, event.attributes?.error_message ?? null, event.channel]);
        await client.query("insert into audit_events(workspace_id,actor_type,action,entity_type,entity_id,changes) values($1,'SERVICE','message.status_changed','message',$2,$3)", [workspaceId, updated.rows[0]?.id ?? externalId, JSON.stringify({ externalId, status: requested, matched: updated.rowCount })]);
        await client.query("commit");
        return { duplicate: false, eventId: event.event_id, workspaceId, messageId: updated.rows[0]?.id, status: String(updated.rows[0]?.status ?? requested).toLowerCase(), matched: updated.rowCount };
      }
      await this.discoverAttributeDefinitions(client, workspaceId, "BOT", event.attributes, { sourceBot: event.bot_id });
      const identity = await client.query<{ contact_id: string }>("select contact_id from channel_identities where workspace_id=$1 and channel=$2 and external_user_id=$3", [workspaceId, event.channel, event.external_user_id]);
      let contactId = identity.rows[0]?.contact_id;
      if (!contactId && (event.profile?.phone || event.profile?.email)) {
        const matched = await client.query<{ id: string }>("select id from contacts where workspace_id=$1 and deleted_at is null and (($2::text is not null and phone=$2) or ($3::text is not null and lower(email)=lower($3))) limit 1", [workspaceId, event.profile?.phone ?? null, event.profile?.email ?? null]);
        contactId = matched.rows[0]?.id;
      }
      if (!contactId) {
        const inserted = await client.query<{ id: string }>("insert into contacts(workspace_id,display_name,phone,email,city,custom_fields) values($1,$2,$3,$4,$5,$6) returning id", [workspaceId, event.profile?.name || `Пользователь ${event.external_user_id}`, event.profile?.phone ?? null, event.profile?.email ?? null, event.profile?.city ?? null, JSON.stringify(event.attributes ?? {})]);
        contactId = inserted.rows[0].id;
      } else {
        await client.query("update contacts set display_name=coalesce($2,display_name),phone=coalesce($3,phone),email=coalesce($4,email),city=coalesce($5,city),custom_fields=custom_fields || $6::jsonb,updated_at=now() where id=$1", [contactId, event.profile?.name ?? null, event.profile?.phone ?? null, event.profile?.email ?? null, event.profile?.city ?? null, JSON.stringify(event.attributes ?? {})]);
      }
      await client.query("insert into channel_identities(workspace_id,contact_id,channel,external_user_id,profile) values($1,$2,$3,$4,$5) on conflict(workspace_id,channel,external_user_id) do update set contact_id=excluded.contact_id,profile=channel_identities.profile || excluded.profile", [workspaceId, contactId, event.channel, event.external_user_id, JSON.stringify(event.profile ?? {})]);

      let botId: string; let connectorId: string | null = null; let connectorIntegrationMode: string | null = null; let connectorEventEndpoint: string | null = null;
      if (event.connector_id && isUuid(event.connector_id)) {
        const connector = await client.query("select c.id,c.bot_id,b.integration_mode,b.event_endpoint from connectors c join bots b on b.id=c.bot_id where c.id=$1 and c.workspace_id=$2 and c.channel=$3", [event.connector_id, workspaceId, event.channel]);
        if (!connector.rowCount) throw new DomainError(404, "Connector not found for webhook", "connector_not_found");
        botId = connector.rows[0].bot_id; connectorId = connector.rows[0].id; connectorIntegrationMode = connector.rows[0].integration_mode; connectorEventEndpoint = connector.rows[0].event_endpoint;
      } else {
        botId = await this.ensureBot(client, workspaceId, event.bot_id);
        const connector = await client.query("select id from connectors where workspace_id=$1 and bot_id=$2 and channel=$3 order by created_at limit 1", [workspaceId, botId, event.channel]);
        connectorId = connector.rows[0]?.id ?? null;
      }
      const conversationResult = await client.query<{ id: string; control_mode: ControlMode; created: boolean }>(`insert into conversations(workspace_id,bot_id,connector_id,contact_id,channel,external_chat_id,last_message_at) values($1,$2,$3,$4,$5,$6,$7) on conflict(workspace_id,bot_id,channel,external_chat_id) do update set connector_id=coalesce(excluded.connector_id,conversations.connector_id),contact_id=excluded.contact_id,last_message_at=greatest(conversations.last_message_at,excluded.last_message_at) returning id,control_mode,(xmax=0) created`, [workspaceId, botId, connectorId, contactId, event.channel, event.external_chat_id, event.occurred_at]);
      const conversation = conversationResult.rows[0];
      if (event.type === "message.received" || event.type === "message.sent") {
        const inbound = event.type === "message.received";
        await client.query(`insert into messages(workspace_id,conversation_id,event_id,external_id,direction,actor_type,text_content,payload,status,occurred_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict(workspace_id,event_id) do nothing`, [workspaceId, conversation.id, event.event_id, event.message?.external_id ?? null, inbound ? "INBOUND" : "OUTBOUND", inbound ? "contact" : "bot", event.message?.text ?? "", JSON.stringify({ attachments: event.message?.attachments ?? [], raw: event.raw_payload ?? null }), inbound ? "DELIVERED" : "SENT", event.occurred_at]);
        await client.query("update conversations set unread_count=unread_count+$2,last_message_at=greatest(last_message_at,$3) where id=$1", [conversation.id, inbound ? 1 : 0, event.occurred_at]);
      }
      let outboxEventId: string | undefined;
      if (event.type === "message.received" && conversation.control_mode === "BOT" && connectorId && connectorIntegrationMode === "GATEWAY" && connectorEventEndpoint) {
        const normalizedForBot = { ...event, workspace_id: workspaceId, conversation_id: conversation.id, contact_id: contactId };
        const outbox = await client.query<{ id: string }>("insert into outbox_events(workspace_id,topic,aggregate_id,payload) values($1,'bot.event',$2,$3) returning id", [workspaceId, event.event_id, JSON.stringify({ connectorId, event: normalizedForBot })]);
        outboxEventId = outbox.rows[0].id;
      }
      await client.query("insert into audit_events(workspace_id,actor_type,action,entity_type,entity_id,changes) values($1,'SERVICE','event.ingested','conversation',$2,$3)", [workspaceId, conversation.id, JSON.stringify({ eventId: event.event_id, type: event.type })]);
      await client.query("commit");
      const automationEventContext = { contactId, conversationId: conversation.id, channel: event.channel, message: event.message ?? {}, profile: event.profile ?? {}, attributes: event.attributes ?? {}, eventType: event.type };
      if (conversation.created && (event.type === "message.received" || event.type === "message.sent")) await this.processAutomationTrigger(event.workspace_id, "conversation.created", event.event_id + ":conversation.created", automationEventContext).catch((error) => console.error("Conversation created automation trigger failed", error));
      await this.processAutomationTrigger(event.workspace_id, event.type, event.event_id, automationEventContext).catch((error) => console.error("Automation trigger failed", error));
      const buttonClicked = event.attributes?.telegram_update_type === "callback_query"
        || event.attributes?.vk_update_type === "message_event"
        || ["interactive", "button"].includes(String(event.attributes?.message_type ?? ""));
      if (buttonClicked) {
        await this.processAutomationTrigger(event.workspace_id, "button.clicked", `${event.event_id}:button`, {
          contactId,
          conversationId: conversation.id,
          channel: event.channel,
          value: event.message?.text ?? "",
          message: event.message ?? {},
          attributes: event.attributes ?? {},
        }).catch((error) => console.error("Button automation trigger failed", error));
      }
      return { duplicate: false, eventId: event.event_id, workspaceId, contactId, conversationId: conversation.id, connectorId: connectorId ?? undefined, outboxEventId, deliverToBot: event.type === "message.received" && conversation.control_mode === "BOT" };
    } catch (error) { await client.query("rollback"); if (error instanceof DomainError) throw error; throw error; } finally { client.release(); }
  }

  async upsertContact(workspace: string, input: { channel: Channel; externalUserId: string; name?: string; phone?: string; email?: string; city?: string; avatarUrl?: string; avatarFileId?: string; attributes?: Record<string, unknown> }) {
    return this.ingest({ event_id: randomUUID(), schema_version: "1.0", occurred_at: new Date().toISOString(), workspace_id: workspace, bot_id: "profile_sync", channel: input.channel, external_chat_id: input.externalUserId, external_user_id: input.externalUserId, type: "contact.updated", profile: { name: input.name, phone: input.phone, email: input.email, city: input.city, avatar_url: input.avatarUrl, avatar_file_id: input.avatarFileId }, attributes: input.attributes });
  }

  private mapAttachment(row: Record<string, any>): AttachmentRecord {
    return { id: row.id, filename: row.filename || "attachment", mimeType: row.mime_type, byteSize: Number(row.byte_size), createdAt: new Date(row.created_at).toISOString() };
  }

  private mapMessage(row: Record<string, any>, attachments: AttachmentRecord[] = []): MessageRecord {
    return { id: row.id, eventId: row.event_id ?? undefined, conversationId: row.conversation_id, direction: row.direction === "INBOUND" ? "inbound" : row.direction === "OUTBOUND" ? "outbound" : "system", actor: row.actor_type, text: row.text_content, status: String(row.status).toLowerCase() as MessageRecord["status"], externalId: row.external_id ?? undefined, attachments, createdAt: new Date(row.occurred_at).toISOString() };
  }
  private mapMediaUpload(row: Record<string, any>) {
    return { id: row.id, filename: row.filename, mimeType: row.mime_type, byteSize: Number(row.byte_size), sha256: row.sha256 ?? undefined, status: String(row.status).toLowerCase(), createdAt: new Date(row.created_at).toISOString(), expiresAt: new Date(row.expires_at).toISOString(), completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : undefined };
  }  private mapContact(row: Record<string, any>) {
    return { id: row.contact_id, workspaceId: row.workspace_id, displayName: row.display_name, phone: row.phone ?? undefined, email: row.email ?? undefined, city: row.city ?? undefined, avatarAvailable: Boolean(row.avatar_available), marketingStatus: row.marketing_status ?? undefined, attributes: row.custom_fields ?? {}, identities: row.identities ?? [], tags: row.tags ?? [], conversationId: row.conversation_id ?? undefined, lastActivityAt: row.last_activity_at ? new Date(row.last_activity_at).toISOString() : undefined, createdAt: new Date(row.contact_created_at).toISOString(), updatedAt: new Date(row.contact_updated_at).toISOString() };
  }
  private mapConversation(row: Record<string, any>, messages: MessageRecord[]) {
    return { id: row.id, workspaceId: row.workspace_id, botId: row.bot_slug, contactId: row.contact_id, channel: row.channel, externalChatId: row.external_chat_id, mode: row.control_mode, controlVersion: row.control_version, assignedUserId: row.assigned_user_id ?? undefined, unreadCount: row.unread_count, lastMessageAt: new Date(row.last_message_at).toISOString(), contact: this.mapContact(row), messages };
  }

  private async conversationRows(workspace: string, id?: string) {
    const workspaceId = await this.workspaceId(workspace);
    const result = await this.pool.query(`select c.*,b.slug bot_slug,ct.display_name,ct.phone,ct.email,ct.city,ct.custom_fields,ct.created_at contact_created_at,ct.updated_at contact_updated_at,exists(select 1 from channel_identities avatar_ci where avatar_ci.contact_id=ct.id and avatar_ci.channel=c.channel and (nullif(avatar_ci.profile->>'avatar_url','') is not null or nullif(avatar_ci.profile->>'avatar_file_id','') is not null)) avatar_available,coalesce((select jsonb_agg(jsonb_build_object('channel',ci.channel,'externalUserId',ci.external_user_id) order by ci.created_at) from channel_identities ci where ci.contact_id=ct.id),'[]'::jsonb) identities from conversations c join bots b on b.id=c.bot_id join contacts ct on ct.id=c.contact_id where c.workspace_id=$1 and c.archived_at is null and ($2::uuid is null or c.id=$2) order by c.last_message_at desc`, [workspaceId, id ?? null]);
    if (!result.rowCount) return [];
    const ids = result.rows.map((row) => row.id);
    // External clocks can drift by milliseconds and some channels only provide
    // second precision. Server ingestion time preserves the causal order of an
    // inbound message, its bot reply and subsequent control events.
    const messageResult = await this.pool.query("select * from messages where conversation_id=any($1::uuid[]) order by created_at,occurred_at,id", [ids]);
    const messageIds = messageResult.rows.map((row) => row.id);
    const attachmentResult = messageIds.length ? await this.pool.query("select * from attachments where message_id=any($1::uuid[]) order by created_at,id", [messageIds]) : { rows: [] as Record<string, any>[] };
    const byMessage = new Map<string, AttachmentRecord[]>();
    for (const row of attachmentResult.rows) byMessage.set(row.message_id, [...(byMessage.get(row.message_id) ?? []), this.mapAttachment(row)]);
    const byConversation = new Map<string, MessageRecord[]>();
    for (const row of messageResult.rows) byConversation.set(row.conversation_id, [...(byConversation.get(row.conversation_id) ?? []), this.mapMessage(row, byMessage.get(row.id) ?? [])]);    return result.rows.map((row) => this.mapConversation(row, byConversation.get(row.id) ?? []));
  }
  async listConversations(workspace: string) { return this.conversationRows(workspace); }
  async markConversationRead(id: string, workspace = "ws_demo") {
    const workspaceId = await this.workspaceId(workspace);
    const result = await this.pool.query("update conversations set unread_count=0 where id=$1 and workspace_id=$2 and archived_at is null returning id,unread_count", [id, workspaceId]);
    if (!result.rowCount) throw new DomainError(404, "Conversation not found", "conversation_not_found");
    await this.pool.query("update messages set status=case when status='FAILED' then status else 'READ'::message_status end where conversation_id=$1 and workspace_id=$2 and direction='INBOUND'", [id, workspaceId]);
    return { id, unreadCount: 0 };
  }
  async getConversation(id: string, workspace = "ws_demo") { const result = await this.conversationRows(workspace, id); if (!result.length) throw new DomainError(404, "Conversation not found", "conversation_not_found"); return result[0]; }

  async contactAvatarSource(id: string, channel: Channel | undefined, workspace = "ws_demo") {
    const workspaceId = await this.workspaceId(workspace);
    const result = await this.pool.query(`select ci.channel,ci.profile,cn.encrypted_credentials
      from channel_identities ci
      left join lateral(select c.connector_id from conversations c where c.contact_id=ci.contact_id and c.channel=ci.channel and c.connector_id is not null order by c.last_message_at desc limit 1) cv on true
      left join connectors cn on cn.id=cv.connector_id and cn.workspace_id=ci.workspace_id
      where ci.contact_id=$1 and ci.workspace_id=$2
        and (nullif(ci.profile->>'avatar_url','') is not null or nullif(ci.profile->>'avatar_file_id','') is not null)
      order by case when ci.channel=$3 then 0 else 1 end,ci.created_at desc limit 1`, [id, workspaceId, channel ?? null]);
    if (!result.rowCount) throw new DomainError(404, "Contact avatar not found", "contact_avatar_not_found");
    const row = result.rows[0];
    return { channel: row.channel as Channel, profile: row.profile as Record<string, unknown>, credentials: row.encrypted_credentials ? decryptSecret(row.encrypted_credentials) : {} };
  }

  async listContacts(workspace: string) {
    const workspaceId = await this.workspaceId(workspace);
    const result = await this.pool.query(`select ct.id contact_id,ct.workspace_id,ct.display_name,ct.phone,ct.email,ct.city,ct.marketing_status,ct.custom_fields,ct.created_at contact_created_at,ct.updated_at contact_updated_at,exists(select 1 from channel_identities avatar_ci where avatar_ci.contact_id=ct.id and (nullif(avatar_ci.profile->>'avatar_url','') is not null or nullif(avatar_ci.profile->>'avatar_file_id','') is not null)) avatar_available,(select max(c.last_message_at) from conversations c where c.contact_id=ct.id) last_activity_at,(select c.id from conversations c where c.contact_id=ct.id and c.archived_at is null order by c.last_message_at desc limit 1) conversation_id,coalesce((select jsonb_agg(jsonb_build_object('channel',ci.channel,'externalUserId',ci.external_user_id)) from channel_identities ci where ci.contact_id=ct.id),'[]'::jsonb) identities,coalesce((select jsonb_agg(t.name order by t.name) from contact_tags ctag join tags t on t.id=ctag.tag_id where ctag.contact_id=ct.id),'[]'::jsonb) tags from contacts ct where ct.workspace_id=$1 and ct.deleted_at is null order by ct.updated_at desc`, [workspaceId]);
    return result.rows.map((row) => this.mapContact(row));
  }

  private async contactRecord(id: string, workspaceId: string, client: Pool | PoolClient = this.pool) {
    const result = await client.query(`select ct.id contact_id,ct.workspace_id,ct.display_name,ct.phone,ct.email,ct.city,ct.custom_fields,ct.marketing_status,ct.created_at contact_created_at,ct.updated_at contact_updated_at,exists(select 1 from channel_identities avatar_ci where avatar_ci.contact_id=ct.id and (nullif(avatar_ci.profile->>'avatar_url','') is not null or nullif(avatar_ci.profile->>'avatar_file_id','') is not null)) avatar_available,(select max(c.last_message_at) from conversations c where c.contact_id=ct.id) last_activity_at,(select c.id from conversations c where c.contact_id=ct.id and c.archived_at is null order by c.last_message_at desc limit 1) conversation_id,coalesce((select jsonb_agg(jsonb_build_object('channel',ci.channel,'externalUserId',ci.external_user_id)) from channel_identities ci where ci.contact_id=ct.id),'[]'::jsonb) identities,coalesce((select jsonb_agg(t.name order by t.name) from contact_tags ctag join tags t on t.id=ctag.tag_id where ctag.contact_id=ct.id),'[]'::jsonb) tags from contacts ct where ct.id=$1 and ct.workspace_id=$2 and ct.deleted_at is null`, [id, workspaceId]);
    if (!result.rowCount) throw new DomainError(404, "Contact not found", "contact_not_found"); return this.mapContact(result.rows[0]);
  }
  async createContact(workspace: string, input: { displayName: string; phone?: string; email?: string; city?: string; attributes?: Record<string, unknown>; channel?: Channel; externalUserId?: string }) {
    const workspaceId = await this.workspaceId(workspace); const name = String(input.displayName ?? "").trim(); if (name.length < 2) throw new DomainError(400, "Contact name is required", "invalid_contact"); const client = await this.pool.connect(); try { await client.query("begin"); await this.discoverAttributeDefinitions(client, workspaceId, "PLATFORM", input.attributes, { source: "contact" }); const result = await client.query("insert into contacts(workspace_id,display_name,phone,email,city,custom_fields) values($1,$2,$3,$4,$5,$6) returning id", [workspaceId, name, input.phone?.trim() || null, input.email?.trim() || null, input.city?.trim() || null, JSON.stringify(input.attributes ?? {})]); if (input.channel && input.externalUserId) await client.query("insert into channel_identities(workspace_id,contact_id,channel,external_user_id) values($1,$2,$3,$4)", [workspaceId, result.rows[0].id, input.channel, input.externalUserId]); await client.query("insert into audit_events(workspace_id,actor_type,actor_id,action,entity_type,entity_id,changes) values($1,'USER',$2,'contact.created','contact',$3,$4)", [workspaceId, DEMO_USER_ID, result.rows[0].id, JSON.stringify({ displayName: name })]); await client.query("commit"); return this.contactRecord(result.rows[0].id, workspaceId); } catch (error: any) { await client.query("rollback"); if (error?.code === "23505") throw new DomainError(409, "Phone, email or channel identity already belongs to another contact", "contact_identity_conflict"); throw error; } finally { client.release(); }
  }
  async updateContact(id: string, workspace: string, input: { displayName?: string; phone?: string | null; email?: string | null; city?: string | null; attributes?: Record<string, unknown>; marketingStatus?: string }) {
    const workspaceId = await this.workspaceId(workspace);
    await this.discoverAttributeDefinitions(this.pool, workspaceId, "PLATFORM", input.attributes, { source: "contact" });
    const result = await this.pool.query("update contacts set display_name=coalesce($3,display_name),phone=case when $4::boolean then $5 else phone end,email=case when $6::boolean then $7 else email end,city=case when $8::boolean then $9 else city end,custom_fields=custom_fields || $10::jsonb,marketing_status=coalesce($11,marketing_status),updated_at=now() where id=$1 and workspace_id=$2 and deleted_at is null returning id", [id, workspaceId, input.displayName?.trim() || null, input.phone !== undefined, input.phone || null, input.email !== undefined, input.email || null, input.city !== undefined, input.city || null, JSON.stringify(input.attributes ?? {}), input.marketingStatus ?? null]).catch((error: any) => {
      if (error?.code === "23505") throw new DomainError(409, "Phone or email already belongs to another contact", "contact_identity_conflict");
      throw error;
    });
    if (!result.rowCount) throw new DomainError(404, "Contact not found", "contact_not_found");
    const sourceEventId = "contact.updated:" + id + ":" + randomUUID();
    await this.pool.query("insert into audit_events(workspace_id,actor_type,actor_id,action,entity_type,entity_id,changes) values($1,'USER',$2,'contact.updated','contact',$3,$4)", [workspaceId, DEMO_USER_ID, id, JSON.stringify({ fields: Object.keys(input), sourceEventId })]);
    await this.processAutomationTrigger(workspace, "contact.updated", sourceEventId, {
      contactId: id,
      profile: { name: input.displayName, phone: input.phone, email: input.email, city: input.city },
      attributes: input.attributes ?? {},
      changedFields: Object.keys(input),
    }).catch((error) => console.error("Contact updated automation trigger failed", error));
    return this.contactRecord(id, workspaceId);
  }
  async setContactTags(id: string, workspace: string, names: string[]) {
    const workspaceId = await this.workspaceId(workspace); await this.contactRecord(id, workspaceId); const normalized = [...new Set(names.map((name) => String(name).trim()).filter(Boolean))].slice(0,50); const client = await this.pool.connect(); try { await client.query("begin"); const tagIds: string[] = []; for (const name of normalized) { const tag = await client.query("insert into tags(workspace_id,name,color) values($1,$2,'#7c5cff') on conflict(workspace_id,name) do update set name=excluded.name returning id", [workspaceId, name]); tagIds.push(tag.rows[0].id); } await client.query("delete from contact_tags where contact_id=$1", [id]); if (tagIds.length) await client.query("insert into contact_tags(workspace_id,contact_id,tag_id) select $1,$2,unnest($3::uuid[])", [workspaceId, id, tagIds]); await client.query("commit"); return this.contactRecord(id, workspaceId); } catch (error) { await client.query("rollback"); throw error; } finally { client.release(); }
  }
  async anonymizeContact(id: string, workspace: string) {
    const workspaceId = await this.workspaceId(workspace); const client = await this.pool.connect(); try { await client.query("begin"); const result = await client.query("update contacts set display_name=$3,phone=null,email=null,city=null,custom_fields='{}'::jsonb,marketing_status='REVOKED',updated_at=now() where id=$1 and workspace_id=$2 and deleted_at is null returning id", [id, workspaceId, `Удалённый контакт ${id.slice(0,8)}`]); if (!result.rowCount) throw new DomainError(404, "Contact not found", "contact_not_found"); await client.query("delete from channel_identities where contact_id=$1", [id]); await client.query("delete from contact_tags where contact_id=$1", [id]); await client.query("insert into suppression_entries(workspace_id,contact_id,channel,reason) values($1,$2,null,'Contact anonymized') on conflict(contact_id,channel) do update set reason=excluded.reason,created_at=now()", [workspaceId,id]); await client.query("insert into audit_events(workspace_id,actor_type,actor_id,action,entity_type,entity_id,changes) values($1,'USER',$2,'contact.anonymized','contact',$3,'{}')", [workspaceId,DEMO_USER_ID,id]); await client.query("commit"); return { ok: true }; } catch (error) { await client.query("rollback"); throw error; } finally { client.release(); }
  }
  async mergeContacts(targetId: string, sourceId: string, workspace: string) {
    if (targetId === sourceId) throw new DomainError(400, "Contacts must be different", "invalid_contact_merge"); const workspaceId = await this.workspaceId(workspace); const client = await this.pool.connect(); try { await client.query("begin"); const contacts = await client.query("select * from contacts where id=any($1::uuid[]) and workspace_id=$2 and deleted_at is null for update", [[targetId,sourceId],workspaceId]); if (contacts.rowCount !== 2) throw new DomainError(404, "Contact not found", "contact_not_found"); await client.query("delete from channel_identities src using channel_identities dst where src.contact_id=$1 and dst.contact_id=$2 and src.channel=dst.channel and src.external_user_id=dst.external_user_id", [sourceId,targetId]); await client.query("update channel_identities set contact_id=$2 where contact_id=$1", [sourceId,targetId]); for (const table of ["conversations","deals","tasks","notes"]) await client.query(`update ${table} set contact_id=$2 where contact_id=$1`, [sourceId,targetId]); await client.query("insert into contact_tags(workspace_id,contact_id,tag_id) select workspace_id,$2,tag_id from contact_tags where contact_id=$1 on conflict do nothing", [sourceId,targetId]); await client.query("delete from contact_tags where contact_id=$1", [sourceId]); const source = contacts.rows.find((row) => row.id === sourceId); await client.query("update contacts set deleted_at=now(),display_name=$2,phone=null,email=null,city=null,custom_fields='{}'::jsonb where id=$1", [sourceId,`Объединён с ${targetId}`]); await client.query("update contacts set custom_fields=custom_fields || $2::jsonb,phone=coalesce(phone,$3),email=coalesce(email,$4),city=coalesce(city,$5),updated_at=now() where id=$1", [targetId,JSON.stringify(source.custom_fields ?? {}),source.phone,source.email,source.city]); await client.query("insert into audit_events(workspace_id,actor_type,actor_id,action,entity_type,entity_id,changes) values($1,'USER',$2,'contact.merged','contact',$3,$4)", [workspaceId,DEMO_USER_ID,targetId,JSON.stringify({ sourceId })]); await client.query("commit"); return this.contactRecord(targetId,workspaceId); } catch (error) { await client.query("rollback"); throw error; } finally { client.release(); }
  }
  async listContactActivity(id: string, workspace: string) {
    const workspaceId = await this.workspaceId(workspace); await this.contactRecord(id,workspaceId); const [notes,tasks,audit] = await Promise.all([this.pool.query("select id,body,created_at \"createdAt\" from notes where contact_id=$1 order by created_at desc",[id]),this.pool.query("select id,title,due_at \"dueAt\",completed_at \"completedAt\",created_at \"createdAt\" from tasks where contact_id=$1 order by created_at desc",[id]),this.pool.query("select id,action,changes,occurred_at \"occurredAt\" from audit_events where workspace_id=$1 and entity_id=$2 order by occurred_at desc limit 100",[workspaceId,id])]); return { notes: notes.rows,tasks: tasks.rows,audit: audit.rows };
  }
  async addContactNote(id: string, workspace: string, body: string) { const workspaceId=await this.workspaceId(workspace); await this.contactRecord(id,workspaceId); const text=String(body??"").trim(); if(!text) throw new DomainError(400,"Note cannot be empty","invalid_note"); const result=await this.pool.query("insert into notes(workspace_id,contact_id,author_id,body) values($1,$2,$3,$4) returning id,body,created_at \"createdAt\"",[workspaceId,id,DEMO_USER_ID,text]); return result.rows[0]; }
  async addContactTask(id: string, workspace: string, input: { title: string; dueAt?: string }) { const workspaceId=await this.workspaceId(workspace); await this.contactRecord(id,workspaceId); const title=String(input.title??"").trim(); if(!title) throw new DomainError(400,"Task title is required","invalid_task"); const result=await this.pool.query("insert into tasks(workspace_id,contact_id,assigned_user_id,title,due_at) values($1,$2,$3,$4,$5) returning id,title,due_at \"dueAt\",completed_at \"completedAt\",created_at \"createdAt\"",[workspaceId,id,DEMO_USER_ID,title,input.dueAt??null]); return result.rows[0]; }
  async completeContactTask(taskId: string, workspace: string) { const workspaceId=await this.workspaceId(workspace); const result=await this.pool.query("update tasks set completed_at=coalesce(completed_at,now()) where id=$1 and workspace_id=$2 returning id,title,due_at \"dueAt\",completed_at \"completedAt\",created_at \"createdAt\"",[taskId,workspaceId]); if(!result.rowCount) throw new DomainError(404,"Task not found","task_not_found"); return result.rows[0]; }

  async reserveMediaUpload(workspace: string, input: MediaUploadInput, actorId?: string) {
    const workspaceId = await this.workspaceId(workspace);
    const extension = /\.[a-z0-9]{1,12}$/i.exec(input.filename)?.[0]?.toLowerCase() || "";
    const objectKey = `${workspaceId}/${new Date().toISOString().slice(0, 10).replace(/-/g, "/")}/${randomUUID()}${extension}`;
    const userId = actorId && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(actorId) ? actorId : null;
    const result = await this.pool.query("insert into media_uploads(workspace_id,object_key,filename,mime_type,byte_size,sha256,created_by,expires_at) values($1,$2,$3,$4,$5,$6,$7,now()+interval '15 minutes') returning *", [workspaceId, objectKey, input.filename, input.mimeType, input.byteSize, input.sha256 ?? null, userId]);
    return { ...this.mapMediaUpload(result.rows[0]), objectKey };
  }

  async getMediaUpload(id: string, workspace = "ws_demo") {
    const workspaceId = await this.workspaceId(workspace);
    const result = await this.pool.query("select * from media_uploads where id=$1 and workspace_id=$2", [id, workspaceId]);
    if (!result.rowCount) throw new DomainError(404, "Media upload not found", "media_upload_not_found");
    return { ...this.mapMediaUpload(result.rows[0]), objectKey: result.rows[0].object_key };
  }

  async completeMediaUpload(id: string, head: MediaObjectHead, workspace = "ws_demo") {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const workspaceId = await this.workspaceId(workspace, client);
      const result = await client.query("select * from media_uploads where id=$1 and workspace_id=$2 for update", [id, workspaceId]);
      if (!result.rowCount) throw new DomainError(404, "Media upload not found", "media_upload_not_found");
      const row = result.rows[0];
      if (row.status === "ATTACHED" || row.status === "UPLOADED") { await client.query("commit"); return { ...this.mapMediaUpload(row), objectKey: row.object_key }; }
      if (row.status !== "PENDING" || new Date(row.expires_at).valueOf() <= Date.now()) {
        await client.query("update media_uploads set status='EXPIRED' where id=$1", [id]);
        throw new DomainError(409, "Media upload reservation has expired", "media_upload_expired");
      }
      if (Number(row.byte_size) !== head.byteSize) throw new DomainError(409, "Uploaded object size does not match the reservation", "media_size_mismatch");
      if (String(row.mime_type).toLowerCase() !== head.mimeType.toLowerCase()) throw new DomainError(409, "Uploaded object content type does not match the reservation", "media_type_mismatch");
      const updated = await client.query("update media_uploads set status='UPLOADED',completed_at=now() where id=$1 returning *", [id]);
      await client.query("insert into audit_events(workspace_id,actor_type,action,entity_type,entity_id,changes) values($1,'USER','media.uploaded','media_upload',$2,$3)", [workspaceId, id, JSON.stringify({ filename: row.filename, byteSize: head.byteSize, mimeType: head.mimeType })]);
      await client.query("commit");
      return { ...this.mapMediaUpload(updated.rows[0]), objectKey: updated.rows[0].object_key };
    } catch (error) { await client.query("rollback"); throw error; } finally { client.release(); }
  }

  async getAttachment(id: string, workspace = "ws_demo") {
    const workspaceId = await this.workspaceId(workspace);
    const result = await this.pool.query("select a.* from attachments a where a.id=$1 and a.workspace_id=$2", [id, workspaceId]);
    if (!result.rowCount) throw new DomainError(404, "Attachment not found", "attachment_not_found");
    return { ...this.mapAttachment(result.rows[0]), objectKey: result.rows[0].object_key };
  }
  async setControl(conversationId: string, input: { mode: ControlMode; expectedVersion: number; userId?: string }, workspace = "ws_demo") {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const requestedOwner = input.userId?.trim();
      const ownerId = input.mode === "HUMAN" ? (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestedOwner ?? "") ? requestedOwner! : DEMO_USER_ID) : null;
      const workspaceId = await this.workspaceId(workspace, client);
      const result = await client.query(`update conversations set control_mode=$2,control_version=control_version+1,assigned_user_id=$3 where id=$1 and workspace_id=$5 and control_version=$4 returning *`, [conversationId, input.mode, ownerId, input.expectedVersion, workspaceId]);
      if (!result.rowCount) { const exists = await client.query("select 1 from conversations where id=$1 and workspace_id=$2", [conversationId, workspaceId]); throw new DomainError(exists.rowCount ? 409 : 404, exists.rowCount ? "Control state changed by another actor" : "Conversation not found", exists.rowCount ? "control_version_conflict" : "conversation_not_found"); }
      const row = result.rows[0];
      const text = input.mode === "HUMAN" ? "Диалог забран оператором" : input.mode === "BOT" ? "Управление возвращено боту" : "Диалог поставлен на паузу";
      await client.query("insert into messages(workspace_id,conversation_id,direction,actor_type,text_content,status,occurred_at) values($1,$2,'SYSTEM','system',$3,'SENT',now())", [row.workspace_id, conversationId, text]);
      let outboxEventId: string | undefined;
      if (input.mode === "BOT" && row.connector_id) {
        const target = await client.query("select b.slug,b.event_endpoint,ci.external_user_id from bots b left join channel_identities ci on ci.contact_id=$2 and ci.channel=$3 where b.id=$1 limit 1", [row.bot_id, row.contact_id, row.channel]);
        if (target.rows[0]?.event_endpoint) {
          const eventId = `control.returned:${conversationId}:v${row.control_version}`;
          const event = { event_id: eventId, schema_version: "1.0", occurred_at: new Date().toISOString(), workspace_id: workspaceId, bot_id: target.rows[0].slug, channel: row.channel, external_chat_id: row.external_chat_id, external_user_id: target.rows[0].external_user_id ?? row.external_chat_id, type: "control.returned", conversation_id: conversationId, attributes: { control_version: row.control_version } };
          const outbox = await client.query<{ id: string }>("insert into outbox_events(workspace_id,topic,aggregate_id,payload) values($1,'bot.event',$2,$3) returning id", [workspaceId, eventId, JSON.stringify({ connectorId: row.connector_id, event })]);
          outboxEventId = outbox.rows[0].id;
        }
      }
      await client.query("insert into audit_events(workspace_id,actor_type,actor_id,action,entity_type,entity_id,changes) values($1,'USER',$2,'conversation.control_changed','conversation',$3,$4)", [row.workspace_id, input.userId ?? "user_owner", conversationId, JSON.stringify({ to: input.mode, version: row.control_version })]);
      await client.query("commit");
      return { id: row.id, workspaceId: row.workspace_id, botId: row.bot_id, contactId: row.contact_id, connectorId: row.connector_id ?? undefined, outboxEventId, channel: row.channel, externalChatId: row.external_chat_id, mode: row.control_mode, controlVersion: row.control_version, assignedUserId: row.assigned_user_id ?? undefined, unreadCount: row.unread_count, lastMessageAt: new Date(row.last_message_at).toISOString() };
    } catch (error) { await client.query("rollback"); throw error; } finally { client.release(); }
  }

  async sendMessage(input: { conversationId: string; actor: "bot" | "operator"; text: string; idempotencyKey: string; attachmentIds?: string[]; buttons?: CampaignButton[] }, workspace = "ws_demo") {
    if (!input.idempotencyKey) throw new DomainError(400, "Idempotency-Key is required", "idempotency_required");
    const attachmentIds = [...new Set(input.attachmentIds ?? [])];
    if (!input.text.trim() && !attachmentIds.length) throw new DomainError(400, "Message text or attachment is required", "empty_message");
    if (attachmentIds.length > MAX_ATTACHMENTS_PER_MESSAGE) throw new DomainError(400, `A message can contain at most ${MAX_ATTACHMENTS_PER_MESSAGE} attachments`, "too_many_attachments");
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const workspaceId = await this.workspaceId(workspace, client);
      const conversation = await client.query("select * from conversations where id=$1 and workspace_id=$2 for share", [input.conversationId, workspaceId]);
      if (!conversation.rowCount) throw new DomainError(404, "Conversation not found", "conversation_not_found");
      if (input.actor === "bot" && conversation.rows[0].control_mode !== "BOT") throw new DomainError(409, "Bot is not in control of this conversation", "bot_not_in_control");
      const duplicate = await client.query("select * from messages where workspace_id=$1 and event_id=$2", [workspaceId, input.idempotencyKey]);
      if (duplicate.rowCount) {
        const existingAttachments = await client.query("select * from attachments where message_id=$1 order by created_at,id", [duplicate.rows[0].id]);
        const existingOutbox = await client.query("select id from outbox_events where workspace_id=$1 and topic='bot.event' and aggregate_id=$2 order by created_at desc limit 1", [workspaceId, input.idempotencyKey]);
        await client.query("commit");
        return { duplicate: true, workspaceId, outboxEventId: existingOutbox.rows[0]?.id, message: this.mapMessage(duplicate.rows[0], existingAttachments.rows.map((row) => this.mapAttachment(row))) };
      }
      let uploads: Record<string, any>[] = [];
      if (attachmentIds.length) {
        const uploadResult = await client.query("select * from media_uploads where id=any($1::uuid[]) and workspace_id=$2 for update", [attachmentIds, workspaceId]);
        uploads = uploadResult.rows;
        if (uploads.length !== attachmentIds.length || uploads.some((row) => !["UPLOADED", "ATTACHED"].includes(row.status))) throw new DomainError(409, "Every attachment must be uploaded and belong to this workspace", "attachment_not_ready");
      }
      const result = await client.query("insert into messages(workspace_id,conversation_id,event_id,direction,actor_type,text_content,payload,status,occurred_at) values($1,$2,$3,'OUTBOUND',$4,$5,$6,'QUEUED',now()) returning *", [workspaceId, input.conversationId, input.idempotencyKey, input.actor, input.text.trim(), JSON.stringify({ buttons: input.buttons ?? [] })]);
      const attached: AttachmentRecord[] = [];
      for (const upload of uploads) {
        const attachment = await client.query("insert into attachments(workspace_id,message_id,object_key,filename,mime_type,byte_size,sha256) values($1,$2,$3,$4,$5,$6,$7) returning *", [workspaceId, result.rows[0].id, upload.object_key, upload.filename, upload.mime_type, upload.byte_size, upload.sha256]);
        attached.push(this.mapAttachment(attachment.rows[0]));
      }
      if (attachmentIds.length) await client.query("update media_uploads set status='ATTACHED',attached_message_id=$2 where id=any($1::uuid[])", [attachmentIds, result.rows[0].id]);
      await client.query("update conversations set last_message_at=now() where id=$1", [input.conversationId]);
      let outboxEventId: string | undefined;
      if (input.actor === "operator" && conversation.rows[0].connector_id) {
        const target = await client.query("select b.slug,b.event_endpoint,ci.external_user_id from bots b left join channel_identities ci on ci.contact_id=$2 and ci.channel=$3 where b.id=$1 limit 1", [conversation.rows[0].bot_id, conversation.rows[0].contact_id, conversation.rows[0].channel]);
        if (target.rows[0]?.event_endpoint) {
          const event = { event_id: input.idempotencyKey, schema_version: "1.0", occurred_at: new Date().toISOString(), workspace_id: workspaceId, bot_id: target.rows[0].slug, channel: conversation.rows[0].channel, external_chat_id: conversation.rows[0].external_chat_id, external_user_id: target.rows[0].external_user_id ?? conversation.rows[0].external_chat_id, type: "message.sent", conversation_id: input.conversationId, contact_id: conversation.rows[0].contact_id, message: { text: input.text.trim(), attachments: attached.map((item) => ({ id: item.id, filename: item.filename, mime_type: item.mimeType })) }, attributes: { actor: "operator" } };
          const outbox = await client.query<{ id: string }>("insert into outbox_events(workspace_id,topic,aggregate_id,payload) values($1,'bot.event',$2,$3) returning id", [workspaceId, input.idempotencyKey, JSON.stringify({ connectorId: conversation.rows[0].connector_id, event })]);
          outboxEventId = outbox.rows[0].id;
        }
      }
      await client.query("insert into audit_events(workspace_id,actor_type,action,entity_type,entity_id,changes) values($1,$2,'message.queued','message',$3,$4)", [workspaceId, input.actor === "operator" ? "USER" : "SERVICE", result.rows[0].id, JSON.stringify({ conversationId: input.conversationId, attachmentCount: attached.length })]);
      await client.query("commit");
      await this.processAutomationTrigger(workspace, "message.sent", input.idempotencyKey, { contactId: conversation.rows[0].contact_id, conversationId: input.conversationId, channel: conversation.rows[0].channel, message: { text: input.text.trim(), actor: input.actor }, attributes: {} }).catch((error) => console.error("Automation trigger failed", error));
      return { duplicate: false, workspaceId, outboxEventId, message: this.mapMessage(result.rows[0], attached) };
    } catch (error) { await client.query("rollback"); throw error; } finally { client.release(); }
  }
  async prepareMessageDelivery(messageId: string, workspace = "ws_demo") {
    const workspaceId = await this.workspaceId(workspace);
    const result = await this.pool.query(`select m.id "messageId",m.workspace_id "workspaceId",m.status,c.id "conversationId",c.connector_id "connectorId",c.external_chat_id "externalChatId",c.channel
      from messages m join conversations c on c.id=m.conversation_id where m.id=$1 and m.workspace_id=$2`, [messageId, workspaceId]);
    if (!result.rowCount) throw new DomainError(404, "Message not found", "message_not_found");
    if (!result.rows[0].connectorId) throw new DomainError(409, "Conversation has no channel connector", "connector_required");
    return result.rows[0];
  }
  async listPipelines(workspace: string) { const workspaceId=await this.workspaceId(workspace); const result=await this.pool.query(`select p.id,p.name,p.is_default "isDefault",p.created_at "createdAt",coalesce(jsonb_agg(jsonb_build_object('id',s.id,'slug',s.slug,'name',s.name,'color',s.color,'position',s.position,'terminalKind',s.terminal_kind,'dealCount',(select count(*) from deals d where d.stage_id=s.id)) order by s.position) filter(where s.id is not null),'[]'::jsonb) stages from pipelines p left join stages s on s.pipeline_id=p.id where p.workspace_id=$1 group by p.id order by p.is_default desc,p.created_at`,[workspaceId]); return result.rows; }
  async createPipeline(workspace: string,input:{name:string;stages?:Array<{name:string;color?:string;terminalKind?:"WON"|"LOST"}>}) { const workspaceId=await this.workspaceId(workspace); const name=String(input.name??"").trim(); if(name.length<2) throw new DomainError(400,"Pipeline name is required","invalid_pipeline"); const stages=input.stages?.length?input.stages:[{name:"Новая заявка",color:"#8b5cf6"},{name:"В работе",color:"#3b82f6"},{name:"Успешно",color:"#10b981",terminalKind:"WON" as const},{name:"Проиграно",color:"#ef4444",terminalKind:"LOST" as const}]; const client=await this.pool.connect(); try{await client.query("begin"); const pipeline=await client.query("insert into pipelines(workspace_id,name) values($1,$2) returning id",[workspaceId,name]); for(let index=0;index<stages.length;index++){const stage=stages[index];const slug=`stage_${randomUUID().slice(0,8)}`;await client.query("insert into stages(workspace_id,pipeline_id,slug,name,color,position,terminal_kind) values($1,$2,$3,$4,$5,$6,$7)",[workspaceId,pipeline.rows[0].id,slug,stage.name,stage.color??"#8b5cf6",index,stage.terminalKind??null]);} await client.query("commit"); return (await this.listPipelines(workspace)).find((item)=>item.id===pipeline.rows[0].id); }catch(error){await client.query("rollback");throw error;}finally{client.release();} }
  async updatePipeline(id:string,workspace:string,input:{name?:string;isDefault?:boolean}) { const workspaceId=await this.workspaceId(workspace); const client=await this.pool.connect(); try{await client.query("begin"); if(input.isDefault) await client.query("update pipelines set is_default=false where workspace_id=$1",[workspaceId]); const result=await client.query("update pipelines set name=coalesce($3,name),is_default=coalesce($4,is_default) where id=$1 and workspace_id=$2 returning id",[id,workspaceId,input.name?.trim()||null,input.isDefault??null]); if(!result.rowCount) throw new DomainError(404,"Pipeline not found","pipeline_not_found"); await client.query("commit"); return (await this.listPipelines(workspace)).find((item)=>item.id===id); }catch(error){await client.query("rollback");throw error;}finally{client.release();} }
  async createStage(pipelineId:string,workspace:string,input:{name:string;color?:string;terminalKind?:"WON"|"LOST"}) { const workspaceId=await this.workspaceId(workspace); const pipeline=await this.pool.query("select 1 from pipelines where id=$1 and workspace_id=$2",[pipelineId,workspaceId]); if(!pipeline.rowCount) throw new DomainError(404,"Pipeline not found","pipeline_not_found"); const position=await this.pool.query("select coalesce(max(position),-1)+1 position from stages where pipeline_id=$1",[pipelineId]); const result=await this.pool.query("insert into stages(workspace_id,pipeline_id,slug,name,color,position,terminal_kind) values($1,$2,$3,$4,$5,$6,$7) returning id,slug,name,color,position,terminal_kind \"terminalKind\"",[workspaceId,pipelineId,`stage_${randomUUID().slice(0,8)}`,String(input.name).trim(),input.color??"#8b5cf6",position.rows[0].position,input.terminalKind??null]); return result.rows[0]; }
  async updateStage(id:string,workspace:string,input:{name?:string;color?:string;terminalKind?:"WON"|"LOST"|null;position?:number}) {
    const workspaceId=await this.workspaceId(workspace); const client=await this.pool.connect();
    try { await client.query("begin"); const current=await client.query("select id,pipeline_id,position from stages where id=$1 and workspace_id=$2 for update",[id,workspaceId]); if(!current.rowCount) throw new DomainError(404,"Stage not found","stage_not_found");
      if(input.position!==undefined){const ordered=await client.query("select id from stages where pipeline_id=$1 order by position for update",[current.rows[0].pipeline_id]);const ids=ordered.rows.map((row)=>row.id).filter((stageId)=>stageId!==id);ids.splice(Math.max(0,Math.min(ids.length,Math.floor(input.position))),0,id);await client.query("update stages set position=position+1000 where pipeline_id=$1",[current.rows[0].pipeline_id]);for(let position=0;position<ids.length;position+=1)await client.query("update stages set position=$2 where id=$1",[ids[position],position]);}
      const result=await client.query("update stages set name=coalesce($3,name),color=coalesce($4,color),terminal_kind=case when $5::boolean then $6 else terminal_kind end where id=$1 and workspace_id=$2 returning id,slug,name,color,position,terminal_kind \"terminalKind\"",[id,workspaceId,input.name?.trim()||null,input.color??null,input.terminalKind!==undefined,input.terminalKind??null]);await client.query("commit");return result.rows[0];
    } catch(error){await client.query("rollback");throw error;} finally{client.release();}
  }  async deleteStage(id:string,workspace:string) { const workspaceId=await this.workspaceId(workspace); const used=await this.pool.query("select 1 from deals where stage_id=$1 limit 1",[id]); if(used.rowCount) throw new DomainError(409,"Move deals before deleting the stage","stage_in_use"); const result=await this.pool.query("delete from stages where id=$1 and workspace_id=$2 returning id",[id,workspaceId]); if(!result.rowCount) throw new DomainError(404,"Stage not found","stage_not_found"); return {ok:true}; }
  async createDeal(workspace:string,input:{contactId:string;pipelineId?:string;stageId?:string;title:string;amount?:number}) { const workspaceId=await this.workspaceId(workspace); const pipeline=await this.pool.query("select id from pipelines where workspace_id=$1 and ($2::uuid is null and is_default=true or id=$2::uuid) order by is_default desc limit 1",[workspaceId,input.pipelineId??null]); if(!pipeline.rowCount) throw new DomainError(404,"Pipeline not found","pipeline_not_found"); const stage=await this.pool.query("select id,slug from stages where pipeline_id=$1 and ($2::text is null or id::text=$2 or slug=$2) order by position limit 1",[pipeline.rows[0].id,input.stageId??null]); if(!stage.rowCount) throw new DomainError(404,"Stage not found","stage_not_found"); const contact=await this.pool.query("select 1 from contacts where id=$1 and workspace_id=$2 and deleted_at is null",[input.contactId,workspaceId]); if(!contact.rowCount) throw new DomainError(404,"Contact not found","contact_not_found"); const result=await this.pool.query("insert into deals(workspace_id,contact_id,pipeline_id,stage_id,title,amount,assigned_user_id) values($1,$2,$3,$4,$5,$6,$7) returning *",[workspaceId,input.contactId,pipeline.rows[0].id,stage.rows[0].id,String(input.title).trim(),input.amount??0,null]); await this.processAutomationTrigger(workspace,"deal.created",`deal.created:${result.rows[0].id}`,{contactId:input.contactId,dealId:result.rows[0].id,stageId:stage.rows[0].slug}); return {id:result.rows[0].id,workspaceId,contactId:input.contactId,pipelineId:pipeline.rows[0].id,stageId:stage.rows[0].slug,title:result.rows[0].title,amount:Number(result.rows[0].amount??0),version:result.rows[0].version,updatedAt:new Date(result.rows[0].updated_at).toISOString()}; }
  async updateDeal(id:string,workspace:string,input:{title?:string;amount?:number;expectedVersion:number}) { const workspaceId=await this.workspaceId(workspace); const result=await this.pool.query("update deals set title=coalesce($3,title),amount=coalesce($4,amount),version=version+1,updated_at=now() where id=$1 and workspace_id=$2 and version=$5 returning *",[id,workspaceId,input.title?.trim()||null,input.amount??null,input.expectedVersion]); if(!result.rowCount){const exists=await this.pool.query("select 1 from deals where id=$1 and workspace_id=$2",[id,workspaceId]);throw new DomainError(exists.rowCount?409:404,exists.rowCount?"Deal was changed":"Deal not found",exists.rowCount?"deal_version_conflict":"deal_not_found");} return {id:result.rows[0].id,workspaceId,contactId:result.rows[0].contact_id,pipelineId:result.rows[0].pipeline_id,stageId:result.rows[0].stage_id,title:result.rows[0].title,amount:Number(result.rows[0].amount??0),version:result.rows[0].version,updatedAt:new Date(result.rows[0].updated_at).toISOString()}; }

  async listPipeline(workspace: string, pipelineSlug = "sales") {
    const workspaceId = await this.workspaceId(workspace);
    const result = await this.pool.query(`select d.*,s.slug stage_slug,p.name pipeline_name,ct.display_name,ct.phone,ct.email,ct.city,ct.custom_fields,ct.created_at contact_created_at,ct.updated_at contact_updated_at,exists(select 1 from channel_identities avatar_ci where avatar_ci.contact_id=ct.id and (nullif(avatar_ci.profile->>'avatar_url','') is not null or nullif(avatar_ci.profile->>'avatar_file_id','') is not null)) avatar_available,coalesce((select jsonb_agg(jsonb_build_object('channel',ci.channel,'externalUserId',ci.external_user_id)) from channel_identities ci where ci.contact_id=ct.id),'[]'::jsonb) identities from deals d join stages s on s.id=d.stage_id join pipelines p on p.id=d.pipeline_id join contacts ct on ct.id=d.contact_id where d.workspace_id=$1 and ($2='sales' or p.id::text=$2) order by s.position,d.updated_at desc`, [workspaceId, pipelineSlug]);
    return result.rows.map((row) => ({ id: row.id, workspaceId: row.workspace_id, contactId: row.contact_id, pipelineId: row.pipeline_id, stageId: row.stage_slug, title: row.title, amount: Number(row.amount ?? 0), version: row.version, updatedAt: new Date(row.updated_at).toISOString(), contact: this.mapContact(row) }));
  }

  async moveDeal(id: string, stageSlug: string, expectedVersion: number, workspace = "ws_demo") {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const workspaceId = await this.workspaceId(workspace, client);
      const current = await client.query("select * from deals where id=$1 and workspace_id=$2 for update", [id, workspaceId]);
      if (!current.rowCount) throw new DomainError(404, "Deal not found", "deal_not_found");
      if (current.rows[0].version !== expectedVersion) throw new DomainError(409, "Deal was changed", "deal_version_conflict");
      const stage = await client.query("select id from stages where pipeline_id=$1 and slug=$2", [current.rows[0].pipeline_id, stageSlug]);
      if (!stage.rowCount) throw new DomainError(404, "Stage not found", "stage_not_found");
      const result = await client.query("update deals set stage_id=$2,version=version+1,updated_at=now() where id=$1 returning *", [id, stage.rows[0].id]);
      await client.query("insert into deal_stage_history(workspace_id,deal_id,from_stage_id,to_stage_id,actor_type,actor_id) values($1,$2,$3,$4,'USER',$5)", [current.rows[0].workspace_id, id, current.rows[0].stage_id, stage.rows[0].id, DEMO_USER_ID]);
      await client.query("commit");
      const row = result.rows[0];
      await this.processAutomationTrigger(workspace, "deal.stage_changed", `deal:${id}:v${row.version}`, { contactId: row.contact_id, dealId: id, stageId: stageSlug, deal: { id, stage: stageSlug, amount: Number(row.amount ?? 0) } }).catch((error) => console.error("Automation trigger failed", error));
      return { id: row.id, workspaceId: row.workspace_id, contactId: row.contact_id, pipelineId: "sales", stageId: stageSlug, title: row.title, amount: Number(row.amount ?? 0), version: row.version, updatedAt: new Date(row.updated_at).toISOString() } as DealRecord;
    } catch (error) { await client.query("rollback"); throw error; } finally { client.release(); }
  }

  private mapConnector(row: Record<string, any>) {
    const credentials = decryptSecret(row.encrypted_credentials ?? {});
    const publicBase = (process.env.PUBLIC_API_URL ?? "http://localhost:4100/api/v1").replace(/\/$/, "");
    return { id: row.id, workspaceId: row.workspace_id, botId: row.bot_id, botSlug: row.bot_slug, botName: row.bot_name, integrationMode: row.integration_mode, eventEndpoint: row.event_endpoint ?? undefined, channel: row.channel, externalAccountId: row.external_account_id ?? undefined, status: String(row.status).toLowerCase(), capabilities: row.capabilities ?? {}, configuredFields: Object.keys(credentials).filter((key) => credentials[key] !== undefined && credentials[key] !== ""), webhookUrl: `${publicBase}/webhooks/${row.channel}/${row.id}`, lastHealthAt: row.last_health_at ? new Date(row.last_health_at).toISOString() : undefined, lastError: row.last_error ?? undefined, createdAt: new Date(row.created_at).toISOString() };
  }

  async webhookConnector(id:string,channel:Channel) { const result=await this.pool.query("select c.*,b.slug bot_slug,b.integration_mode,b.event_endpoint from connectors c join bots b on b.id=c.bot_id where c.id=$1 and c.channel=$2 and b.enabled=true",[id,channel]); if(!result.rowCount) throw new DomainError(404,"Connector not found","connector_not_found"); const row=result.rows[0]; return {id:row.id,workspaceId:row.workspace_id,botId:row.bot_slug,integrationMode:row.integration_mode,eventEndpoint:row.event_endpoint,credentials:decryptSecret(row.encrypted_credentials??{})}; }
  async listConnectors(workspace: string) {
    const workspaceId = await this.workspaceId(workspace);
    const result = await this.pool.query(`select c.*,b.slug bot_slug,b.name bot_name,b.integration_mode,b.event_endpoint from connectors c join bots b on b.id=c.bot_id where c.workspace_id=$1 order by c.created_at`, [workspaceId]);
    return result.rows.map((row) => this.mapConnector(row));
  }

  async createConnector(workspace: string, input: { botName: string; botSlug?: string; integrationMode?: "GATEWAY" | "MIRROR"; eventEndpoint?: string; channel: Channel; externalAccountId?: string; credentials?: Record<string, unknown> }) {
    const workspaceId = await this.workspaceId(workspace);
    const botName = String(input.botName ?? "").trim();
    const botSlug = normalizeBotSlug(String(input.botSlug ?? botName));
    if (botName.length < 2 || !botSlug || !["telegram", "vk", "whatsapp", "avito", "api"].includes(input.channel)) throw new DomainError(400, "Bot name, slug and supported channel are required", "invalid_connector_input");
    const credentials = input.credentials ?? {};
    const integrationMode = input.integrationMode ?? "GATEWAY";
    const requiredCredentials: Record<Channel, string[]> = {
      telegram: ["botToken", "webhookSecret"],
      vk: integrationMode === "MIRROR" ? ["accessToken"] : ["accessToken", "confirmationSecret", "confirmationCode"],
      whatsapp: ["accessToken", "phoneNumberId", "appSecret", "verifyToken"],
      avito: ["accessToken", "signingSecret"],
      api: ["outboundUrl", "signingSecret"],
    };
    const missingCredentials = requiredCredentials[input.channel].filter((key) => typeof credentials[key] !== "string" || !String(credentials[key]).trim());
    if (missingCredentials.length) throw new DomainError(400, `Required connector secrets are missing: ${missingCredentials.join(", ")}`, "connector_secrets_required");
    if (input.eventEndpoint) { const url = new URL(input.eventEndpoint); if (!["http:", "https:"].includes(url.protocol)) throw new DomainError(400, "Bot event endpoint must use HTTP(S)", "invalid_connector_endpoint"); }
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const bot = await client.query("insert into bots(workspace_id,slug,name,integration_mode,event_endpoint) values($1,$2,$3,$4,$5) on conflict(workspace_id,slug) do update set name=excluded.name,integration_mode=excluded.integration_mode,event_endpoint=excluded.event_endpoint returning id", [workspaceId, botSlug, botName, integrationMode, input.eventEndpoint ?? null]);
      const capabilities = { telegram: { delivery: true, read: false, receiptMode: "sent_only", edit: true, delete: true, freeBroadcastRate: 30 }, vk: { delivery: true, read: false, receiptMode: "sent_only", edit: true }, whatsapp: { delivery: true, read: true, receiptMode: "webhook", templates: true, serviceWindowHours: 24 }, avito: { delivery: true, read: false, receiptMode: "sent_only", requiresEntitlement: true }, api: { delivery: true, read: true, receiptMode: "message.status", edit: true, templates: true } }[input.channel];
      const result = await client.query("insert into connectors(workspace_id,bot_id,channel,external_account_id,encrypted_credentials,capabilities,status) values($1,$2,$3,$4,$5,$6,$7) returning *", [workspaceId, bot.rows[0].id, input.channel, input.externalAccountId ?? null, JSON.stringify(encryptSecret(credentials)), JSON.stringify(capabilities), Object.keys(credentials).length ? "PENDING" : "WARNING"]);
      await client.query("insert into audit_events(workspace_id,actor_type,actor_id,action,entity_type,entity_id,changes) values($1,'USER',$2,'connector.created','connector',$3,$4)", [workspaceId, DEMO_USER_ID, result.rows[0].id, JSON.stringify({ channel: input.channel, botSlug })]);
      await client.query("commit");
      return this.mapConnector({ ...result.rows[0], bot_slug: botSlug, bot_name: botName, integration_mode: integrationMode, event_endpoint: input.eventEndpoint ?? null });
    } catch (error: any) { await client.query("rollback"); if (error?.code === "23505") throw new DomainError(409, "A connector for this account already exists", "connector_exists"); throw error; } finally { client.release(); }
  }

  async updateConnector(id: string, workspace: string, input: { botName?: string; integrationMode?: "GATEWAY" | "MIRROR"; eventEndpoint?: string; externalAccountId?: string; credentials?: Record<string, unknown>; enabled?: boolean }) {
    const workspaceId = await this.workspaceId(workspace);
    const current = await this.pool.query("select c.*,b.slug bot_slug,b.name bot_name,b.integration_mode,b.event_endpoint from connectors c join bots b on b.id=c.bot_id where c.id=$1 and c.workspace_id=$2", [id, workspaceId]);
    if (!current.rowCount) throw new DomainError(404, "Connector not found", "connector_not_found");
    const row = current.rows[0];
    const credentials = input.credentials ? { ...decryptSecret(row.encrypted_credentials), ...input.credentials } : decryptSecret(row.encrypted_credentials);
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("update bots set name=coalesce($2,name),integration_mode=coalesce($3,integration_mode),event_endpoint=coalesce($4,event_endpoint),enabled=coalesce($5,enabled) where id=$1 and workspace_id=$6", [row.bot_id, input.botName?.trim() || null, input.integrationMode ?? null, input.eventEndpoint ?? null, input.enabled ?? null, workspaceId]);
      const result = await client.query("update connectors set external_account_id=coalesce($3,external_account_id),encrypted_credentials=$4,status=case when $5::boolean then 'PENDING' else status end,last_error=case when $5::boolean then null else last_error end where id=$1 and workspace_id=$2 returning *", [id, workspaceId, input.externalAccountId ?? null, JSON.stringify(encryptSecret(credentials)), Boolean(input.credentials)]);
      await client.query("insert into audit_events(workspace_id,actor_type,actor_id,action,entity_type,entity_id,changes) values($1,'USER',$2,'connector.updated','connector',$3,$4)", [workspaceId, DEMO_USER_ID, id, JSON.stringify({ changed: Object.keys(input), credentialsRotated: Boolean(input.credentials) })]);
      await client.query("commit");
      return this.mapConnector({ ...row, ...result.rows[0], bot_name: input.botName?.trim() || row.bot_name, integration_mode: input.integrationMode ?? row.integration_mode, event_endpoint: input.eventEndpoint ?? row.event_endpoint });
    } catch (error) { await client.query("rollback"); throw error; } finally { client.release(); }
  }

  async checkConnector(id: string, workspace: string) {
    const workspaceId = await this.workspaceId(workspace);
    const result = await this.pool.query("select c.*,b.slug bot_slug,b.name bot_name,b.integration_mode,b.event_endpoint from connectors c join bots b on b.id=c.bot_id where c.id=$1 and c.workspace_id=$2", [id, workspaceId]);
    if (!result.rowCount) throw new DomainError(404, "Connector not found", "connector_not_found");
    const row = result.rows[0]; const credentials = decryptSecret(row.encrypted_credentials);
    try {
      let url = ""; const init: RequestInit = { method: "GET", signal: AbortSignal.timeout(8_000) };
      if (row.channel === "telegram") { const token = credentials.botToken ?? credentials.bot_token; if (!token) throw new Error("Telegram bot token is not configured"); url = `https://api.telegram.org/bot${token}/getMe`; }
      else if (row.channel === "vk") { const token = credentials.accessToken ?? credentials.access_token; if (!token) throw new Error("VK access token is not configured"); url = `https://api.vk.com/method/groups.getById?access_token=${encodeURIComponent(token)}&v=${encodeURIComponent(credentials.apiVersion ?? "5.199")}`; }
      else if (row.channel === "whatsapp") { const token = credentials.accessToken ?? credentials.access_token; const phoneId = credentials.phoneNumberId ?? credentials.phone_number_id; if (!token || !phoneId) throw new Error("WhatsApp access token and phone number ID are required"); url = `https://graph.facebook.com/${credentials.apiVersion ?? "v23.0"}/${phoneId}`; init.headers = { authorization: `Bearer ${token}` }; }
      else if (row.channel === "avito") { const token = credentials.accessToken ?? credentials.access_token; if (!token) throw new Error("Avito access token is not configured"); url = credentials.healthUrl ?? "https://api.avito.ru/core/v1/accounts/self"; init.headers = { authorization: `Bearer ${token}` }; }
      else { url = credentials.healthUrl ?? credentials.outboundUrl ?? credentials.endpoint; if (!url) throw new Error("Generic connector health or outbound URL is not configured"); }
      const response = await fetch(url, init); if (!response.ok) throw new Error(`Official API returned ${response.status}`);
      const updated = await this.pool.query("update connectors set status='CONNECTED',last_health_at=now(),last_error=null where id=$1 returning *", [id]);
      return this.mapConnector({ ...row, ...updated.rows[0] });
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : String(error);
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || /aborted.*timeout/i.test(rawMessage));
      const message = timedOut ? "Официальный API канала не ответил за 8 секунд. Проверьте интернет/VPN и HTTPS_PROXY сервера." : rawMessage;
      const updated = await this.pool.query("update connectors set status='WARNING',last_health_at=now(),last_error=$2 where id=$1 returning *", [id, message.slice(0, 1000)]);
      return this.mapConnector({ ...row, ...updated.rows[0] });
    }
  }

  async deleteConnector(id: string, workspace: string) {
    const workspaceId = await this.workspaceId(workspace);
    const result = await this.pool.query("delete from connectors where id=$1 and workspace_id=$2 returning bot_id,channel", [id, workspaceId]);
    if (!result.rowCount) throw new DomainError(404, "Connector not found", "connector_not_found");
    await this.pool.query("insert into audit_events(workspace_id,actor_type,actor_id,action,entity_type,entity_id,changes) values($1,'USER',$2,'connector.deleted','connector',$3,$4)", [workspaceId, DEMO_USER_ID, id, JSON.stringify({ channel: result.rows[0].channel })]);
    await this.pool.query("delete from bots where id=$1 and workspace_id=$2 and not exists(select 1 from connectors where bot_id=$1) and not exists(select 1 from conversations where bot_id=$1)", [result.rows[0].bot_id, workspaceId]);
    return { ok: true };
  }
  private mapAutomationRule(row: Record<string, any>) {
    return { id: row.id, workspaceId: row.workspace_id, name: row.name, enabled: row.enabled, triggerType: row.trigger_type, conditionTree: row.condition_tree ?? { match: "all", conditions: [] }, actions: row.actions ?? [], maxDepth: Number(row.max_depth), runCount: Number(row.run_count ?? 0), successCount: Number(row.success_count ?? 0), lastRunAt: row.last_run_at ? new Date(row.last_run_at).toISOString() : undefined, createdAt: new Date(row.created_at).toISOString() };
  }

  async listAutomationRules(workspace: string) {
    const workspaceId = await this.workspaceId(workspace);
    const result = await this.pool.query(`select ar.*,
      (select count(*) from automation_runs r where r.rule_id=ar.id)::int run_count,
      (select count(*) from automation_runs r where r.rule_id=ar.id and r.status='SUCCESS')::int success_count,
      (select max(r.started_at) from automation_runs r where r.rule_id=ar.id) last_run_at
      from automation_rules ar where ar.workspace_id=$1 order by ar.created_at desc`, [workspaceId]);
    return result.rows.map((row) => this.mapAutomationRule(row));
  }

  async createAutomationRule(workspace: string, input: AutomationRuleInput) {
    const workspaceId = await this.workspaceId(workspace);
    const rule = validateAutomationRule(input);
    const result = await this.pool.query("insert into automation_rules(workspace_id,name,enabled,trigger_type,condition_tree,actions,max_depth) values($1,$2,$3,$4,$5,$6,$7) returning *", [workspaceId, rule.name, rule.enabled, rule.triggerType, JSON.stringify(rule.conditionTree), JSON.stringify(rule.actions), rule.maxDepth]);
    await this.pool.query("insert into audit_events(workspace_id,actor_type,actor_id,action,entity_type,entity_id,changes) values($1,'USER',$2,'automation.created','automation_rule',$3,$4)", [workspaceId, DEMO_USER_ID, result.rows[0].id, JSON.stringify({ name: rule.name, triggerType: rule.triggerType })]);
    return this.mapAutomationRule(result.rows[0]);
  }

  async updateAutomationRule(id: string, workspace: string, patch: Partial<AutomationRuleInput>) {
    const workspaceId = await this.workspaceId(workspace);
    const current = await this.pool.query("select * from automation_rules where id=$1 and workspace_id=$2", [id, workspaceId]);
    if (!current.rowCount) throw new DomainError(404, "Automation not found", "automation_not_found");
    const row = current.rows[0];
    const rule = validateAutomationRule({ name: patch.name ?? row.name, enabled: patch.enabled ?? row.enabled, triggerType: patch.triggerType ?? row.trigger_type, conditionTree: patch.conditionTree ?? row.condition_tree, actions: patch.actions ?? row.actions, maxDepth: patch.maxDepth ?? row.max_depth });
    const result = await this.pool.query("update automation_rules set name=$3,enabled=$4,trigger_type=$5,condition_tree=$6,actions=$7,max_depth=$8 where id=$1 and workspace_id=$2 returning *", [id, workspaceId, rule.name, rule.enabled, rule.triggerType, JSON.stringify(rule.conditionTree), JSON.stringify(rule.actions), rule.maxDepth]);
    await this.pool.query("insert into audit_events(workspace_id,actor_type,actor_id,action,entity_type,entity_id,changes) values($1,'USER',$2,'automation.updated','automation_rule',$3,$4)", [workspaceId, DEMO_USER_ID, id, JSON.stringify(patch)]);
    return this.mapAutomationRule(result.rows[0]);
  }

  async deleteAutomationRule(id: string, workspace: string) {
    const workspaceId = await this.workspaceId(workspace);
    const result = await this.pool.query("with removed_runs as (delete from automation_runs where rule_id=$1 and workspace_id=$2) delete from automation_rules where id=$1 and workspace_id=$2 returning name", [id, workspaceId]);
    if (!result.rowCount) throw new DomainError(404, "Automation not found", "automation_not_found");
    await this.pool.query("insert into audit_events(workspace_id,actor_type,actor_id,action,entity_type,entity_id,changes) values($1,'USER',$2,'automation.deleted','automation_rule',$3,$4)", [workspaceId, DEMO_USER_ID, id, JSON.stringify({ name: result.rows[0].name })]);
    return { ok: true };
  }

  async listAutomationRuns(workspace: string, requestedLimit = 100) {
    const workspaceId = await this.workspaceId(workspace);
    const limit = Math.min(500, Math.max(1, Number(requestedLimit) || 100));
    const result = await this.pool.query(`select r.id,r.rule_id "ruleId",ar.name "ruleName",r.source_event_id "sourceEventId",r.depth,r.status,r.result,r.error,r.started_at "startedAt",r.finished_at "finishedAt",
      greatest(0,extract(epoch from(coalesce(r.finished_at,now())-r.started_at))*1000)::int "durationMs"
      from automation_runs r join automation_rules ar on ar.id=r.rule_id where r.workspace_id=$1 order by r.started_at desc limit $2`, [workspaceId, limit]);
    return result.rows.map((row) => ({ ...row, startedAt: new Date(row.startedAt).toISOString(), finishedAt: row.finishedAt ? new Date(row.finishedAt).toISOString() : undefined, durationMs: Number(row.durationMs) }));
  }

  private async automationContext(workspaceId: string, input: Record<string, unknown>) {
    let contactId = typeof input.contactId === "string" && isUuid(input.contactId) ? input.contactId : null;
    if (!contactId) {
      const conversationId = typeof input.conversationId === "string" && isUuid(input.conversationId) ? input.conversationId : null;
      const dealId = typeof input.dealId === "string" && isUuid(input.dealId) ? input.dealId : null;
      const messageId = typeof input.messageId === "string" && isUuid(input.messageId) ? input.messageId : null;
      const recipientId = typeof input.recipientId === "string" && isUuid(input.recipientId) ? input.recipientId : null;
      let resolved: { contact_id?: string } | undefined;
      if (conversationId) resolved = (await this.pool.query("select contact_id from conversations where id=$1 and workspace_id=$2", [conversationId, workspaceId])).rows[0];
      else if (dealId) resolved = (await this.pool.query("select contact_id from deals where id=$1 and workspace_id=$2", [dealId, workspaceId])).rows[0];
      else if (messageId) resolved = (await this.pool.query("select c.contact_id from messages m join conversations c on c.id=m.conversation_id where m.id=$1 and m.workspace_id=$2", [messageId, workspaceId])).rows[0];
      else if (recipientId) resolved = (await this.pool.query("select contact_id from campaign_recipients where id=$1 and workspace_id=$2", [recipientId, workspaceId])).rows[0];
      contactId = resolved?.contact_id ?? null;
    }
    if (!contactId) return input;
    const result = await this.pool.query("select ct.id \"contactId\",ct.display_name \"contactName\",ct.phone,ct.email,ct.city,ct.custom_fields attributes,c.id \"conversationId\",c.channel,c.control_mode \"controlMode\",c.assigned_user_id \"assignedUserId\",d.id \"dealId\",d.amount,d.custom_fields \"dealAttributes\",s.slug \"stageId\" from contacts ct left join lateral(select * from conversations where contact_id=ct.id and archived_at is null order by last_message_at desc limit 1)c on true left join lateral(select * from deals where contact_id=ct.id order by updated_at desc limit 1)d on true left join stages s on s.id=d.stage_id where ct.id=$1 and ct.workspace_id=$2 and ct.deleted_at is null", [contactId, workspaceId]);
    if (!result.rowCount) return { ...input, contactId };
    const row = result.rows[0];
    return {
      ...row,
      ...input,
      contactId,
      contact: { id: row.contactId, name: row.contactName, phone: row.phone, email: row.email, city: row.city, ...(row.attributes ?? {}) },
      attributes: { ...(row.attributes ?? {}), ...((input.attributes as Record<string, unknown>) ?? {}) },
      deal: { id: row.dealId, stage: row.stageId, amount: Number(row.amount ?? 0), ...(row.dealAttributes ?? {}), ...((input.deal as Record<string, unknown>) ?? {}) },
      conversation: { id: row.conversationId, channel: row.channel, controlMode: row.controlMode, assignedUserId: row.assignedUserId, ...((input.conversation as Record<string, unknown>) ?? {}) },
    };
  }
  async testAutomationRule(id: string, workspace: string, contactId?: string, context: Record<string, unknown> = {}) {
    const workspaceId = await this.workspaceId(workspace);
    const result = await this.pool.query("select * from automation_rules where id=$1 and workspace_id=$2", [id, workspaceId]);
    if (!result.rowCount) throw new DomainError(404, "Automation not found", "automation_not_found");
    const enriched = await this.automationContext(workspaceId, { ...context, ...(contactId ? { contactId } : {}) });
    const matched = automationMatches(result.rows[0].condition_tree, enriched);
    return { matched, context: enriched, actions: matched ? result.rows[0].actions : [] };
  }

  async processAutomationTrigger(workspace: string, triggerType: string, sourceEventId: string, rawContext: Record<string, unknown>, depth = 0) {
    const workspaceId = await this.workspaceId(workspace);
    if (depth > 10) return { matched: 0, executed: 0, skipped: "depth_limit" };
    const context = await this.automationContext(workspaceId, rawContext);
    const rules = await this.pool.query("select * from automation_rules where workspace_id=$1 and enabled=true and trigger_type=$2 order by created_at,id", [workspaceId, triggerType]);
    let matched = 0;
    let executed = 0;
    for (const rule of rules.rows) {
      if (depth >= Number(rule.max_depth) || !automationMatches(rule.condition_tree, context)) continue;
      matched += 1;
      const run = await this.pool.query("insert into automation_runs(workspace_id,rule_id,source_event_id,depth,status) values($1,$2,$3,$4,'RUNNING') on conflict(rule_id,source_event_id) do nothing returning id", [workspaceId, rule.id, sourceEventId, depth]);
      if (!run.rowCount) continue;
      const runId = run.rows[0].id;
      const client = await this.pool.connect();
      const actionResults: Array<Record<string, unknown>> = [];
      const followUps: Array<{ triggerType: string; sourceEventId: string; context: Record<string, unknown> }> = [];
      try {
        await client.query("begin");
        const contactId = typeof context.contactId === "string" && isUuid(context.contactId) ? context.contactId : null;
        const conversationId = typeof context.conversationId === "string" && isUuid(context.conversationId) ? context.conversationId : null;
        const dealId = typeof context.dealId === "string" && isUuid(context.dealId) ? context.dealId : null;
        const actions = rule.actions as AutomationAction[];
        for (let actionIndex = 0; actionIndex < actions.length; actionIndex += 1) {
          const action = actions[actionIndex];
          const actionEventId = sourceEventId + ":automation:" + rule.id + ":" + actionIndex;
          let resultDetail: Record<string, unknown> = { type: action.type, status: "success" };

          if (action.type === "set_attribute") {
            if (!contactId) throw new DomainError(409, "Automation action set_attribute requires a contact", "automation_context_missing");
            await this.discoverAttributeDefinitions(client, workspaceId, "PLATFORM", { [action.key]: action.value }, { source: "automation", ruleId: rule.id });
            const updated = await client.query("update contacts set custom_fields=custom_fields || jsonb_build_object($2::text,$3::jsonb),updated_at=now() where id=$1 and workspace_id=$4 returning id", [contactId, action.key, JSON.stringify(action.value), workspaceId]);
            if (!updated.rowCount) throw new DomainError(404, "Automation contact not found", "contact_not_found");
            followUps.push({ triggerType: "contact.updated", sourceEventId: actionEventId, context: { contactId, attributes: { [action.key]: action.value }, changedFields: ["attributes." + action.key] } });
          } else if (action.type === "add_tag") {
            if (!contactId) throw new DomainError(409, "Automation action add_tag requires a contact", "automation_context_missing");
            const tag = await client.query("insert into tags(workspace_id,name,color) values($1,$2,$3) on conflict(workspace_id,name) do update set color=excluded.color returning id", [workspaceId, action.tag.trim(), action.color ?? "#8b5cf6"]);
            await client.query("insert into contact_tags(workspace_id,contact_id,tag_id) values($1,$2,$3) on conflict do nothing", [workspaceId, contactId, tag.rows[0].id]);
          } else if (action.type === "move_deal") {
            if (!dealId && !contactId) throw new DomainError(409, "Automation action move_deal requires a deal or contact", "automation_context_missing");
            const deal = await client.query("select * from deals where workspace_id=$1 and " + (dealId ? "id=$2" : "contact_id=$2 order by updated_at desc limit 1") + " for update", [workspaceId, dealId ?? contactId]);
            if (!deal.rowCount) throw new DomainError(409, "The contact has no deal to move", "automation_deal_missing");
            const stage = await client.query("select id from stages where pipeline_id=$1 and slug=$2", [deal.rows[0].pipeline_id, action.stage]);
            if (!stage.rowCount) throw new DomainError(404, "Target stage " + action.stage + " was not found in this pipeline", "stage_not_found");
            const moved = await client.query("update deals set stage_id=$2,version=version+1,updated_at=now() where id=$1 returning contact_id,amount", [deal.rows[0].id, stage.rows[0].id]);
            await client.query("insert into deal_stage_history(workspace_id,deal_id,from_stage_id,to_stage_id,actor_type,actor_id) values($1,$2,$3,$4,'AUTOMATION',$5)", [workspaceId, deal.rows[0].id, deal.rows[0].stage_id, stage.rows[0].id, rule.id]);
            followUps.push({ triggerType: "deal.stage_changed", sourceEventId: actionEventId, context: { contactId: moved.rows[0].contact_id, dealId: deal.rows[0].id, stageId: action.stage, deal: { id: deal.rows[0].id, stage: action.stage, amount: Number(moved.rows[0].amount ?? 0) } } });
          } else if (action.type === "assign_user") {
            if (!conversationId && !dealId) throw new DomainError(409, "Automation action assign_user requires a conversation or deal", "automation_context_missing");
            const user = await client.query("select id from users where id=$1 and workspace_id=$2 and disabled_at is null", [action.userId, workspaceId]);
            if (!user.rowCount) throw new DomainError(404, "Assigned user not found", "user_not_found");
            if (conversationId) await client.query("update conversations set assigned_user_id=$2 where id=$1 and workspace_id=$3", [conversationId, action.userId, workspaceId]);
            if (dealId) await client.query("update deals set assigned_user_id=$2,updated_at=now() where id=$1 and workspace_id=$3", [dealId, action.userId, workspaceId]);
          } else if (action.type === "create_task") {
            if (!contactId && !dealId) throw new DomainError(409, "Automation action create_task requires a contact or deal", "automation_context_missing");
            await client.query("insert into tasks(workspace_id,contact_id,deal_id,assigned_user_id,title,due_at) values($1,$2,$3,$4,$5,case when $6::int is null then null else now()+make_interval(mins=>$6::int) end)", [workspaceId, contactId, dealId, action.userId && isUuid(action.userId) ? action.userId : null, action.title.trim(), action.dueMinutes ?? null]);
          } else if (action.type === "set_control") {
            if (!conversationId) throw new DomainError(409, "Automation action set_control requires a conversation", "automation_context_missing");
            const controlled = await client.query("update conversations set control_mode=$2::control_mode,control_version=control_version+1,assigned_user_id=case when $2::control_mode='HUMAN'::control_mode then coalesce(assigned_user_id,$4) else assigned_user_id end where id=$1 and workspace_id=$3 returning *", [conversationId, action.mode, workspaceId, DEMO_USER_ID]);
            if (!controlled.rowCount) throw new DomainError(404, "Automation conversation not found", "conversation_not_found");
            const controlledRow = controlled.rows[0];
            const systemText = action.mode === "HUMAN" ? "Диалог автоматически передан оператору" : action.mode === "BOT" ? "Управление автоматически возвращено боту" : "Диалог автоматически поставлен на паузу";
            await client.query("insert into messages(workspace_id,conversation_id,event_id,direction,actor_type,text_content,status,occurred_at) values($1,$2,$3,'SYSTEM','system',$4,'SENT',now()) on conflict(workspace_id,event_id) do nothing", [workspaceId, conversationId, actionEventId + ":control", systemText]);
            if (action.mode === "BOT" && controlledRow.connector_id) {
              const target = await client.query("select b.slug,b.event_endpoint,ci.external_user_id from bots b left join channel_identities ci on ci.contact_id=$2 and ci.channel=$3 where b.id=$1 limit 1", [controlledRow.bot_id, controlledRow.contact_id, controlledRow.channel]);
              if (target.rows[0]?.event_endpoint) {
                const returnEventId = actionEventId + ":control.returned";
                const returnEvent = { event_id: returnEventId, schema_version: "1.0", occurred_at: new Date().toISOString(), workspace_id: workspaceId, bot_id: target.rows[0].slug, channel: controlledRow.channel, external_chat_id: controlledRow.external_chat_id, external_user_id: target.rows[0].external_user_id ?? controlledRow.external_chat_id, type: "control.returned", conversation_id: conversationId, attributes: { control_version: controlledRow.control_version } };
                const outbox = await client.query("insert into outbox_events(workspace_id,topic,aggregate_id,payload) values($1,'bot.event',$2,$3) on conflict do nothing returning id", [workspaceId, returnEventId, JSON.stringify({ connectorId: controlledRow.connector_id, event: returnEvent })]);
                resultDetail = { ...resultDetail, outboxId: outbox.rows[0]?.id };
              }
            }
          } else if (action.type === "send_message") {
            if (!conversationId) throw new DomainError(409, "Automation action send_message requires a conversation", "automation_context_missing");
            const target = await client.query("select control_mode,connector_id,channel,contact_id from conversations where id=$1 and workspace_id=$2", [conversationId, workspaceId]);
            if (!target.rowCount) throw new DomainError(404, "Automation conversation not found", "conversation_not_found");
            if (!target.rows[0].connector_id) throw new DomainError(409, "Conversation has no channel connector", "connector_required");
            const actor = action.actor ?? "bot";
            if (actor === "bot" && target.rows[0].control_mode !== "BOT") throw new DomainError(409, "Bot is not in control of this conversation", "bot_not_in_control");
            const message = await client.query("insert into messages(workspace_id,conversation_id,event_id,direction,actor_type,text_content,status,occurred_at) values($1,$2,$3,'OUTBOUND',$4,$5,'QUEUED',now()) on conflict(workspace_id,event_id) do nothing returning id", [workspaceId, conversationId, actionEventId + ":message", actor, action.text.trim()]);
            await client.query("update conversations set last_message_at=now() where id=$1", [conversationId]);
            resultDetail = { ...resultDetail, messageId: message.rows[0]?.id };
            followUps.push({ triggerType: "message.sent", sourceEventId: actionEventId, context: { contactId: target.rows[0].contact_id, conversationId, channel: target.rows[0].channel, message: { text: action.text.trim(), actor }, attributes: {} } });
          } else if (action.type === "suppress_contact") {
            if (!contactId) throw new DomainError(409, "Automation action suppress_contact requires a contact", "automation_context_missing");
            await client.query("insert into suppression_entries(workspace_id,contact_id,channel,reason) values($1,$2,$3,$4) on conflict(contact_id,channel) do update set reason=excluded.reason,created_at=now()", [workspaceId, contactId, action.channel ?? null, action.reason ?? "Automation rule"]);
          } else if (action.type === "webhook") {
            const delivery = await dispatchAutomationWebhook(action.url, { event: "automation.triggered", workspaceId, ruleId: rule.id, sourceEventId, context });
            resultDetail = { ...resultDetail, url: action.url, httpStatus: delivery.status };
          }
          actionResults.push(resultDetail);
        }
        await client.query("insert into audit_events(workspace_id,actor_type,actor_id,action,entity_type,entity_id,changes) values($1,'AUTOMATION',$2,'automation.executed','automation_rule',$2,$3)", [workspaceId, rule.id, JSON.stringify({ sourceEventId, actions: actionResults.length })]);
        await client.query("commit");
        await this.pool.query("update automation_runs set status='SUCCESS',result=$2,finished_at=now() where id=$1", [runId, JSON.stringify({ actions: actionResults, context: { contactId, conversationId, dealId } })]);
        executed += 1;
        for (const followUp of followUps) {
          await this.processAutomationTrigger(workspace, followUp.triggerType, followUp.sourceEventId, followUp.context, depth + 1).catch((error) => console.error("Chained automation trigger failed", error));
        }
      } catch (error) {
        await client.query("rollback");
        const rawMessage = error instanceof Error ? error.message : String(error);
        const timedOut = error instanceof Error && (error.name === "TimeoutError" || /aborted.*timeout/i.test(rawMessage));
        const message = timedOut ? "Официальный API канала не ответил за 8 секунд. Проверьте интернет/VPN и HTTPS_PROXY сервера." : rawMessage;
        await this.pool.query("update automation_runs set status='FAILED',error=$2,finished_at=now() where id=$1", [runId, message.slice(0, 2000)]);
      } finally {
        client.release();
      }
    }
    return { matched, executed };
  }
  private mapSegment(row: Record<string, any>, count?: number) { return { id: row.id, workspaceId: row.workspace_id, name: row.name, filter: row.filter_tree as SegmentGroup, count, createdAt: new Date(row.created_at).toISOString() }; }
  private async segmentCount(workspaceId: string, filter: unknown, client: Pool | PoolClient = this.pool) {
    const compiled = compileSegmentFilter(filter, [workspaceId]); const result = await client.query(`select count(*)::int count from contacts ct where ct.workspace_id=$1 and ct.deleted_at is null and ${compiled.sql}`, compiled.params); return Number(result.rows[0].count);
  }
  async listSegments(workspace: string) {
    const workspaceId = await this.workspaceId(workspace); const result = await this.pool.query("select * from segments where workspace_id=$1 order by created_at desc", [workspaceId]);
    return Promise.all(result.rows.map(async (row) => this.mapSegment(row, await this.segmentCount(workspaceId, row.filter_tree))));
  }
  async createSegment(workspace: string, input: { name: string; filter: SegmentGroup }) {
    const workspaceId = await this.workspaceId(workspace); const name = String(input.name ?? "").trim(); if (name.length < 2 || name.length > 120) throw new DomainError(400, "Segment name must contain 2-120 characters", "invalid_segment_name"); const filter = validateSegmentFilter(input.filter);
    const result = await this.pool.query("insert into segments(workspace_id,name,filter_tree,created_by) values($1,$2,$3,$4) returning *", [workspaceId, name, JSON.stringify(filter), DEMO_USER_ID]); const count = await this.segmentCount(workspaceId, filter);
    await this.pool.query("insert into audit_events(workspace_id,actor_type,actor_id,action,entity_type,entity_id,changes) values($1,'USER',$2,'segment.created','segment',$3,$4)", [workspaceId, DEMO_USER_ID, result.rows[0].id, JSON.stringify({ name, count })]); return this.mapSegment(result.rows[0], count);
  }
  async updateSegment(id: string, workspace: string, input: { name?: string; filter?: SegmentGroup }) {
    const workspaceId = await this.workspaceId(workspace); const current = await this.pool.query("select * from segments where id=$1 and workspace_id=$2", [id, workspaceId]); if (!current.rowCount) throw new DomainError(404, "Segment not found", "segment_not_found");
    const name = input.name === undefined ? current.rows[0].name : String(input.name).trim(); if (name.length < 2 || name.length > 120) throw new DomainError(400, "Segment name must contain 2-120 characters", "invalid_segment_name"); const filter = input.filter === undefined ? current.rows[0].filter_tree : validateSegmentFilter(input.filter);
    const result = await this.pool.query("update segments set name=$3,filter_tree=$4 where id=$1 and workspace_id=$2 returning *", [id, workspaceId, name, JSON.stringify(filter)]); const count = await this.segmentCount(workspaceId, filter); await this.pool.query("insert into audit_events(workspace_id,actor_type,actor_id,action,entity_type,entity_id,changes) values($1,'USER',$2,'segment.updated','segment',$3,$4)", [workspaceId, DEMO_USER_ID, id, JSON.stringify({ name, count })]); return this.mapSegment(result.rows[0], count);
  }
  async deleteSegment(id: string, workspace: string) {
    const workspaceId = await this.workspaceId(workspace); const used = await this.pool.query("select 1 from campaigns where segment_id=$1 limit 1", [id]); if (used.rowCount) throw new DomainError(409, "Segment is used by a campaign", "segment_in_use"); const result = await this.pool.query("delete from segments where id=$1 and workspace_id=$2 returning id", [id, workspaceId]); if (!result.rowCount) throw new DomainError(404, "Segment not found", "segment_not_found"); return { ok: true };
  }
  async previewSegment(workspace: string, input: { segmentId?: string; filter?: SegmentGroup; channel?: Channel; limit?: number }) {
    const workspaceId = await this.workspaceId(workspace); let filter: unknown = input.filter; if (input.segmentId) { const saved = await this.pool.query("select filter_tree from segments where id=$1 and workspace_id=$2", [input.segmentId, workspaceId]); if (!saved.rowCount) throw new DomainError(404, "Segment not found", "segment_not_found"); filter = saved.rows[0].filter_tree; } if (!filter) filter = { operator: "AND", conditions: [] };
    const compiled = compileSegmentFilter(filter, [workspaceId]); const channel = input.channel; const channelParam = channel ? `$${compiled.params.length + 1}` : undefined; if (channel) compiled.params.push(channel); const limit = Math.min(100, Math.max(1, Number(input.limit ?? 25))); const limitParam = `$${compiled.params.length + 1}`; compiled.params.push(limit);
    const eligibility = channel ? `and exists(select 1 from channel_identities ci where ci.contact_id=ct.id and ci.channel=${channelParam}) and not exists(select 1 from suppression_entries se where se.contact_id=ct.id and (se.channel is null or se.channel=${channelParam})) and not exists(select 1 from consents co where co.contact_id=ct.id and co.channel=${channelParam} and co.purpose='MARKETING' and co.status='REVOKED')` : "";
    const [summary, sample, variables] = await Promise.all([this.pool.query(`select count(*)::int total,count(*) filter(where ct.marketing_status='REVOKED' or ${channel ? `not exists(select 1 from channel_identities ci where ci.contact_id=ct.id and ci.channel=${channelParam}) or exists(select 1 from suppression_entries se where se.contact_id=ct.id and (se.channel is null or se.channel=${channelParam})) or exists(select 1 from consents co where co.contact_id=ct.id and co.channel=${channelParam} and co.purpose='MARKETING' and co.status='REVOKED')` : "false"})::int excluded from contacts ct where ct.workspace_id=$1 and ct.deleted_at is null and ${compiled.sql}`, compiled.params.slice(0,-1)), this.pool.query(`select ct.id,ct.display_name "displayName",ct.phone,ct.email,ct.city,ct.custom_fields attributes from contacts ct where ct.workspace_id=$1 and ct.deleted_at is null and ct.marketing_status<>'REVOKED' and ${compiled.sql} ${eligibility} order by ct.updated_at desc limit ${limitParam}`, compiled.params), this.pool.query(`select field.key,min(field.value #>> '{}') example from contacts ct cross join lateral jsonb_each(ct.custom_fields) field where ct.workspace_id=$1 and ct.deleted_at is null and ct.marketing_status<>'REVOKED' and ${compiled.sql} ${eligibility} and jsonb_typeof(field.value) in ('string','number','boolean') group by field.key order by field.key limit 200`, compiled.params.slice(0,-1))]);
    const total = Number(summary.rows[0].total); const excluded = Number(summary.rows[0].excluded); return { total, eligible: Math.max(0, total-excluded), excluded, contacts: sample.rows, variables: variables.rows };
  }
  previewCampaign(input: { audience: number; suppressed?: number; unavailable?: number }) { const excluded = (input.suppressed ?? 0) + (input.unavailable ?? 0); return { total: input.audience, eligible: Math.max(0, input.audience - excluded), excluded, reasons: { suppressed: input.suppressed ?? 0, unavailable: input.unavailable ?? 0 } }; }
  private mapCampaign(row: Record<string, any>): CampaignRecord & Record<string, unknown> { const channel = Object.keys(row.channel_content ?? {})[0] as Channel || "api"; const channelContent = row.channel_content?.[channel] ?? {}; const content = channelContent.text ?? ""; return { id: row.id, workspaceId: row.workspace_id, name: row.name, segmentId: row.segment_id ?? undefined, segmentName: row.segment_name ?? undefined, scheduledAt: row.scheduled_at ? new Date(row.scheduled_at).toISOString() : undefined, timeZone: channelContent.timeZone ?? "Europe/Moscow", channel, status: String(row.status).toLowerCase() as CampaignRecord["status"], audience: Number(row.audience_snapshot?.audience ?? row.recipient_total ?? 0), excluded: Number(row.audience_snapshot?.excluded ?? 0), eligible: Number(row.audience_snapshot?.eligible ?? row.recipient_total ?? 0), sent: Number(row.sent_count ?? 0), delivered: Number(row.delivered_count ?? 0), read: Number(row.read_count ?? 0), failed: Number(row.failed_count ?? 0), content, buttons: channelContent.buttons ?? [], mediaIds: channelContent.mediaIds ?? [], createdAt: new Date(row.created_at).toISOString() }; }
  async createCampaign(workspace: string, input: { name: string; channel: Channel; content: string; buttons?: CampaignButton[]; mediaIds?: string[]; segmentId?: string; audience?: number; excluded?: number; scheduledAt?: string; timeZone?: string }, actorId: string) {
    const workspaceId = await this.workspaceId(workspace);
    const name = String(input.name ?? "").trim();
    const composed = validateCampaignContent(input.channel, input);
    if (name.length < 2) throw new DomainError(400, "Campaign name is required", "invalid_campaign");
    const actor = await this.pool.query("select 1 from users where id=$1 and workspace_id=$2 and disabled_at is null", [actorId, workspaceId]);
    if (!actor.rowCount) throw new DomainError(403, "Campaign creator is not an active workspace user", "invalid_campaign_creator");
    if (input.segmentId) { const segment = await this.pool.query("select 1 from segments where id=$1 and workspace_id=$2", [input.segmentId, workspaceId]); if (!segment.rowCount) throw new DomainError(404, "Segment not found", "segment_not_found"); }
    if (composed.mediaIds.length) {
      const uploads = await this.pool.query("select id,status,mime_type from media_uploads where id=any($1::uuid[]) and workspace_id=$2", [composed.mediaIds, workspaceId]);
      if (uploads.rowCount !== composed.mediaIds.length || uploads.rows.some((row) => !["UPLOADED", "ATTACHED"].includes(row.status) || !String(row.mime_type).startsWith("image/"))) throw new DomainError(409, "Campaign images must be uploaded image files from this workspace", "campaign_media_not_ready");
    }
    const preview = await this.previewSegment(workspace, { segmentId: input.segmentId, channel: input.channel, limit: 1 });
    const scheduledAt = input.scheduledAt ? new Date(input.scheduledAt) : undefined;
    const timeZone = String(input.timeZone ?? "Europe/Moscow");
    try { new Intl.DateTimeFormat("en", { timeZone }).format(); } catch { throw new DomainError(400, "Invalid campaign time zone", "invalid_campaign_time_zone"); }
    if (scheduledAt && Number.isNaN(scheduledAt.valueOf())) throw new DomainError(400, "Invalid campaign schedule", "invalid_campaign_schedule");
    if (scheduledAt && scheduledAt.valueOf() <= Date.now()) throw new DomainError(400, "Campaign schedule must be in the future", "invalid_campaign_schedule");
    const status = scheduledAt && scheduledAt.valueOf() > Date.now() ? "SCHEDULED" : "DRAFT";
    const result = await this.pool.query("insert into campaigns(workspace_id,name,segment_id,status,channel_content,audience_snapshot,scheduled_at,created_by) values($1,$2,$3,$4,$5,$6,$7,$8) returning *", [workspaceId, name, input.segmentId ?? null, status, JSON.stringify({ [input.channel]: { ...composed, timeZone } }), JSON.stringify({ audience: preview.total, eligible: preview.eligible, excluded: preview.excluded }), scheduledAt?.toISOString() ?? null, actorId]);
    if (input.segmentId) { const segmentName = await this.pool.query("select name from segments where id=$1", [input.segmentId]); result.rows[0].segment_name = segmentName.rows[0]?.name; }
    return this.mapCampaign(result.rows[0]);
  }  async listCampaigns(workspace: string) { const workspaceId = await this.workspaceId(workspace); const result = await this.pool.query(`select c.*,s.name segment_name,count(cr.id)::int recipient_total,count(cr.id) filter(where cr.status in ('SENT','DELIVERED','READ'))::int sent_count,count(cr.id) filter(where cr.status in ('DELIVERED','READ'))::int delivered_count,count(cr.id) filter(where cr.status='READ')::int read_count,count(cr.id) filter(where cr.status='FAILED')::int failed_count from campaigns c left join segments s on s.id=c.segment_id left join campaign_recipients cr on cr.campaign_id=c.id where c.workspace_id=$1 group by c.id,s.name order by c.created_at desc`, [workspaceId]); return result.rows.map((row) => this.mapCampaign(row)); }
  async search(workspace: string, rawQuery: string, requestedLimit = 30) {
    const query = String(rawQuery ?? "").trim().slice(0, 100);
    if (query.length < 2) return [];
    const limit = Math.min(50, Math.max(1, Number(requestedLimit) || 30));
    const workspaceId = await this.workspaceId(workspace);
    const pattern = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
    const [contacts, messages, deals] = await Promise.all([
      this.pool.query(`select 'contact' type,ct.id,ct.id "contactId",recent.id "conversationId",ct.display_name title,
        concat_ws(' · ',nullif(ct.phone,''),nullif(ct.email,''),nullif(ct.city,'')) subtitle,
        left(ct.custom_fields::text,220) excerpt,ct.updated_at "occurredAt",
        case when lower(ct.display_name)=lower($2) then 100 when lower(ct.display_name) like lower($2)||'%' then 80 else 55 end score
        from contacts ct left join lateral (select c.id from conversations c where c.contact_id=ct.id and c.archived_at is null order by c.last_message_at desc limit 1) recent on true
        where ct.workspace_id=$1 and ct.deleted_at is null and (ct.display_name ilike $3 escape '\\' or coalesce(ct.phone,'') ilike $3 escape '\\' or coalesce(ct.email,'') ilike $3 escape '\\' or coalesce(ct.city,'') ilike $3 escape '\\' or ct.custom_fields::text ilike $3 escape '\\')
        order by score desc,ct.updated_at desc limit $4`, [workspaceId, query, pattern, limit]),
      this.pool.query(`select 'message' type,m.id,c.contact_id "contactId",c.id "conversationId",ct.display_name title,
        concat(b.name,' · ',c.channel) subtitle,left(m.text_content,280) excerpt,m.occurred_at "occurredAt",
        60 + case when to_tsvector('simple',m.text_content) @@ websearch_to_tsquery('simple',$2) then 20 else 0 end score
        from messages m join conversations c on c.id=m.conversation_id join contacts ct on ct.id=c.contact_id join bots b on b.id=c.bot_id
        where m.workspace_id=$1 and m.text_content<>'' and (to_tsvector('simple',m.text_content) @@ websearch_to_tsquery('simple',$2) or m.text_content ilike $3 escape '\\')
        order by score desc,m.occurred_at desc limit $4`, [workspaceId, query, pattern, limit]),
      this.pool.query(`select 'deal' type,d.id,d.contact_id "contactId",recent.id "conversationId",d.title,
        concat(p.name,' · ',s.name,' · ',coalesce(d.amount,0),' ',d.currency) subtitle,
        left(d.custom_fields::text,220) excerpt,d.updated_at "occurredAt",
        case when lower(d.title)=lower($2) then 95 when lower(d.title) like lower($2)||'%' then 78 else 58 end score
        from deals d join pipelines p on p.id=d.pipeline_id join stages s on s.id=d.stage_id
        left join lateral (select c.id from conversations c where c.contact_id=d.contact_id and c.archived_at is null order by c.last_message_at desc limit 1) recent on true
        where d.workspace_id=$1 and (d.title ilike $3 escape '\\' or d.custom_fields::text ilike $3 escape '\\' or s.name ilike $3 escape '\\')
        order by score desc,d.updated_at desc limit $4`, [workspaceId, query, pattern, limit]),
    ]);
    return [...contacts.rows, ...messages.rows, ...deals.rows]
      .sort((a, b) => Number(b.score) - Number(a.score) || new Date(b.occurredAt).valueOf() - new Date(a.occurredAt).valueOf())
      .slice(0, limit)
      .map((row) => ({ ...row, score: Number(row.score), occurredAt: new Date(row.occurredAt).toISOString() }));
  }

  async analytics(workspace: string, requestedDays = 30) {
    const days = Math.min(365, Math.max(1, Number(requestedDays) || 30));
    const workspaceId = await this.workspaceId(workspace);
    const [summary, responseTime, daily, channels, funnel, bots] = await Promise.all([
      this.pool.query(`select
        count(*) filter(where c.created_at>=now()-make_interval(days => $2::int))::int conversations_current,
        count(*) filter(where c.created_at<now()-make_interval(days => $2::int) and c.created_at>=now()-make_interval(days => $2::int*2))::int conversations_previous,
        (select count(*)::int from deals d where d.workspace_id=$1 and d.created_at>=now()-make_interval(days => $2::int)) deals_current,
        (select count(*)::int from deals d where d.workspace_id=$1 and d.created_at<now()-make_interval(days => $2::int) and d.created_at>=now()-make_interval(days => $2::int*2)) deals_previous,
        (select count(*)::int from deals d join stages s on s.id=d.stage_id where d.workspace_id=$1 and s.terminal_kind='WON' and d.updated_at>=now()-make_interval(days => $2::int)) won_current,
        (select count(*)::int from deals d join stages s on s.id=d.stage_id where d.workspace_id=$1 and s.terminal_kind='WON' and d.updated_at<now()-make_interval(days => $2::int) and d.updated_at>=now()-make_interval(days => $2::int*2)) won_previous,
        (select coalesce(sum(d.amount),0)::numeric from deals d join stages s on s.id=d.stage_id where d.workspace_id=$1 and s.terminal_kind='WON' and d.updated_at>=now()-make_interval(days => $2::int)) revenue_current,
        (select coalesce(sum(d.amount),0)::numeric from deals d join stages s on s.id=d.stage_id where d.workspace_id=$1 and s.terminal_kind='WON' and d.updated_at<now()-make_interval(days => $2::int) and d.updated_at>=now()-make_interval(days => $2::int*2)) revenue_previous
        from conversations c where c.workspace_id=$1`, [workspaceId, days]),
      this.pool.query(`with first_in as (select conversation_id,min(occurred_at) occurred_at from messages where workspace_id=$1 and direction='INBOUND' and occurred_at>=now()-make_interval(days => $2::int) group by conversation_id),
        pairs as (select fi.conversation_id,fi.occurred_at,(select min(m.occurred_at) from messages m where m.conversation_id=fi.conversation_id and m.direction='OUTBOUND' and m.occurred_at>=fi.occurred_at) first_out from first_in fi)
        select coalesce(avg(extract(epoch from(first_out-occurred_at))) filter(where first_out is not null),0)::int seconds from pairs`, [workspaceId, days]),
      this.pool.query(`with dates as (select generate_series(current_date-13,current_date,'1 day'::interval)::date as metric_date),
        conv as (select created_at::date as metric_date,count(*)::int count from conversations where workspace_id=$1 and created_at>=current_date-13 group by 1),
        wins as (select d.updated_at::date as metric_date,count(*)::int count from deals d join stages s on s.id=d.stage_id where d.workspace_id=$1 and s.terminal_kind='WON' and d.updated_at>=current_date-13 group by 1)
        select dates.metric_date,coalesce(conv.count,0)::int conversations,coalesce(wins.count,0)::int won from dates left join conv using(metric_date) left join wins using(metric_date) order by dates.metric_date`, [workspaceId]),
      this.pool.query(`select channel,count(*)::int count from conversations where workspace_id=$1 and created_at>=now()-make_interval(days => $2::int) group by channel order by count desc`, [workspaceId, days]),
      this.pool.query(`select s.slug,s.name,s.color,s.position,count(d.id)::int count,coalesce(sum(d.amount),0)::numeric amount from stages s join pipelines p on p.id=s.pipeline_id left join deals d on d.stage_id=s.id and d.workspace_id=$1 where s.workspace_id=$1 and p.id=(select selected.id from pipelines selected where selected.workspace_id=$1 order by selected.is_default desc,selected.created_at asc limit 1) group by s.id order by s.position`, [workspaceId]),
      this.pool.query(`select b.slug,b.name,count(distinct c.id)::int conversations,count(distinct d.id) filter(where s.terminal_kind='WON')::int won,
        round(100.0*count(distinct d.id) filter(where s.terminal_kind='WON')/greatest(count(distinct c.id),1))::int score
        from bots b left join conversations c on c.bot_id=b.id and c.workspace_id=$1 and c.created_at>=now()-make_interval(days => $2::int)
        left join deals d on d.contact_id=c.contact_id and d.workspace_id=$1 left join stages s on s.id=d.stage_id
        where b.workspace_id=$1 group by b.id order by score desc,b.name`, [workspaceId, days]),
    ]);
    const row = summary.rows[0];
    const conversationDelta = percentDelta(Number(row.conversations_current), Number(row.conversations_previous));
    const currentConversion = Number(row.deals_current) ? Number(row.won_current) / Number(row.deals_current) * 100 : 0;
    const previousConversion = Number(row.deals_previous) ? Number(row.won_previous) / Number(row.deals_previous) * 100 : 0;
    const channelTotal = channels.rows.reduce((sum, item) => sum + Number(item.count), 0);
    return {
      periodDays: days,
      generatedAt: new Date().toISOString(),
      summary: {
        conversations: Number(row.conversations_current), conversationDelta,
        wonDeals: Number(row.won_current), conversion: currentConversion, conversionDelta: currentConversion - previousConversion,
        firstResponseSeconds: Number(responseTime.rows[0]?.seconds ?? 0),
        revenue: Number(row.revenue_current), revenueDelta: percentDelta(Number(row.revenue_current), Number(row.revenue_previous)),
      },
      daily: daily.rows.map((item) => ({ date: new Date(item.metric_date).toISOString().slice(0, 10), conversations: Number(item.conversations), won: Number(item.won) })),
      channels: channels.rows.map((item) => ({ channel: item.channel, count: Number(item.count), share: channelTotal ? Number(item.count) / channelTotal * 100 : 0 })),
      funnel: funnel.rows.map((item) => ({ slug: item.slug, name: item.name, color: item.color, position: item.position, count: Number(item.count), amount: Number(item.amount) })),
      bots: bots.rows.map((item) => ({ slug: item.slug, name: item.name, conversations: Number(item.conversations), won: Number(item.won), score: Number(item.score) })),
    };
  }
  async operationalMetrics() { const result=await this.pool.query(`select (select count(*) from workspaces)::int workspaces,(select count(*) from contacts where deleted_at is null)::int contacts,(select count(*) from conversations where archived_at is null)::int conversations,(select count(*) from messages)::bigint messages,(select count(*) from messages where status='QUEUED')::int queued_messages,(select count(*) from messages where status='FAILED')::int failed_messages,(select count(*) from outbox_events where processed_at is null)::int pending_outbox,(select count(*) from campaign_recipients where status='QUEUED')::int queued_campaign_recipients`); return result.rows[0]; }
  async getAudit(workspace: string) { const workspaceId = await this.workspaceId(workspace); const result = await this.pool.query("select id,workspace_id as \"workspaceId\",action,entity_type as \"entityType\",entity_id as \"entityId\",changes,occurred_at as \"occurredAt\" from audit_events where workspace_id=$1 order by occurred_at desc limit 1000", [workspaceId]); return result.rows; }
  async createCampaignTestMessage(workspace: string, input: { contactId: string; channel: Channel; content: string; buttons?: CampaignButton[]; mediaIds?: string[] }) {
    const workspaceId = await this.workspaceId(workspace); const composed = validateCampaignContent(input.channel, input);
    const target = await this.pool.query(`select ct.id contact_id,ct.display_name "displayName",ct.phone,ct.email,ct.city,ct.custom_fields attributes,ci.external_user_id,c.id conversation_id
      from contacts ct join channel_identities ci on ci.contact_id=ct.id and ci.channel=$3
      left join lateral(select cv.id from conversations cv where cv.contact_id=ct.id and cv.channel=$3 and cv.archived_at is null and cv.connector_id is not null order by cv.last_message_at desc limit 1)c on true
      where ct.id=$1 and ct.workspace_id=$2 and ct.deleted_at is null and ct.marketing_status<>'REVOKED'
      and not exists(select 1 from suppression_entries se where se.contact_id=ct.id and (se.channel is null or se.channel=$3)) limit 1`, [input.contactId, workspaceId, input.channel]);
    if (!target.rowCount) throw new DomainError(409, "Contact is unavailable for a test message", "campaign_test_recipient_unavailable");
    let conversationId = target.rows[0].conversation_id as string | undefined;
    if (!conversationId) { const connector = await this.pool.query("select c.id,c.bot_id from connectors c join bots b on b.id=c.bot_id where c.workspace_id=$1 and c.channel=$2 and b.enabled=true order by c.created_at limit 1", [workspaceId,input.channel]); if(!connector.rowCount) throw new DomainError(409,"No enabled connector for this channel","connector_required"); const created=await this.pool.query(`insert into conversations(workspace_id,bot_id,connector_id,contact_id,channel,external_chat_id,last_message_at) values($1,$2,$3,$4,$5,$6,now()) on conflict(workspace_id,bot_id,channel,external_chat_id) do update set connector_id=excluded.connector_id,contact_id=excluded.contact_id returning id`,[workspaceId,connector.rows[0].bot_id,connector.rows[0].id,input.contactId,input.channel,target.rows[0].external_user_id]); conversationId=created.rows[0].id; }
    const personalizedContent = renderCampaignTemplate(composed.text, target.rows[0]);
    const personalizedButtons = composed.buttons.map((button) => ({ ...button, text: renderCampaignTemplate(button.text, target.rows[0]), value: renderCampaignTemplate(button.value, target.rows[0]) }));
    const result = await this.sendMessage({ conversationId: conversationId!, actor: "operator", text: personalizedContent, buttons: personalizedButtons, attachmentIds: composed.mediaIds, idempotencyKey: `campaign-test:${randomUUID()}` }, workspace);
    await this.pool.query("insert into audit_events(workspace_id,actor_type,actor_id,action,entity_type,entity_id,changes) values($1,'USER',$2,'campaign.test_sent','message',$3,$4)",[workspaceId,DEMO_USER_ID,result.message.id,JSON.stringify({contactId:input.contactId,channel:input.channel})]);
    return result;
  }
  async startCampaign(campaignId: string, workspace = "ws_demo") {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const workspaceId = await this.workspaceId(workspace, client);
      const campaignResult = await client.query("select c.*,s.filter_tree from campaigns c left join segments s on s.id=c.segment_id where c.id=$1 and c.workspace_id=$2 for update of c", [campaignId, workspaceId]);
      if (!campaignResult.rowCount) throw new DomainError(404, "Campaign not found", "campaign_not_found");
      const campaign = campaignResult.rows[0];
      if (!["DRAFT", "SCHEDULED", "PAUSED"].includes(campaign.status)) throw new DomainError(409, "Campaign cannot be started from current status", "campaign_state_conflict");
      const channel = Object.keys(campaign.channel_content ?? {})[0] as Channel | undefined;
      if (!channel) throw new DomainError(400, "Campaign channel content is empty", "campaign_content_required");
      const composed = validateCampaignContent(channel, { content: campaign.channel_content[channel]?.text ?? "", buttons: campaign.channel_content[channel]?.buttons, mediaIds: campaign.channel_content[channel]?.mediaIds });
      const mediaResult = composed.mediaIds.length ? await client.query(`select object_key "objectKey",filename,mime_type "mimeType" from media_uploads where id=any($1::uuid[]) and workspace_id=$2 order by array_position($1::uuid[],id)`, [composed.mediaIds, workspaceId]) : { rows: [] as Array<{ objectKey: string; filename: string; mimeType: string }> };
      if (mediaResult.rows.length !== composed.mediaIds.length) throw new DomainError(409, "Campaign image is unavailable", "campaign_media_not_ready");
      const compiledSegment = compileSegmentFilter(campaign.filter_tree ?? { operator: "AND", conditions: [] }, [workspaceId, campaignId, channel]);
      await client.query(`insert into campaign_recipients(workspace_id,campaign_id,contact_id,connector_id,status,next_attempt_at)
        select $1,$2,ct.id,cn.id,'QUEUED',now()
        from contacts ct
        join channel_identities ci on ci.contact_id=ct.id and ci.channel=$3
        join lateral (select id from connectors where workspace_id=$1 and channel=$3 and status in ('CONNECTED','WARNING') order by case when status='CONNECTED' then 0 else 1 end,created_at limit 1) cn on true
        where ct.workspace_id=$1 and ct.deleted_at is null and ct.marketing_status <> 'REVOKED' and ${compiledSegment.sql}
          and not exists(select 1 from suppression_entries se where se.contact_id=ct.id and (se.channel is null or se.channel=$3))
          and not exists(select 1 from consents co where co.contact_id=ct.id and co.channel=$3 and co.purpose='MARKETING' and co.status='REVOKED')
        on conflict(campaign_id,contact_id,connector_id) do update set status=case when campaign_recipients.status in ('FAILED','QUEUED') then 'QUEUED' else campaign_recipients.status end,next_attempt_at=case when campaign_recipients.status in ('FAILED','QUEUED') then now() else campaign_recipients.next_attempt_at end`, compiledSegment.params);
      const jobs = await client.query(`select cr.workspace_id "workspaceId",cr.id "recipientId",cr.campaign_id "campaignId",cr.contact_id "contactId",cr.connector_id "connectorId",ci.external_user_id "externalUserId",cn.channel,ct.display_name "displayName",ct.phone,ct.email,ct.city,ct.custom_fields attributes
        from campaign_recipients cr join campaigns c on c.id=cr.campaign_id join contacts ct on ct.id=cr.contact_id join connectors cn on cn.id=cr.connector_id join channel_identities ci on ci.contact_id=cr.contact_id and ci.channel=cn.channel
        where cr.campaign_id=$1 and cr.workspace_id=$2 and cr.status='QUEUED' order by cr.id`, [campaignId, workspaceId]);
      await client.query("update campaigns set status='RUNNING',audience_snapshot=coalesce(audience_snapshot,'{}'::jsonb) || jsonb_build_object('eligible',$2::int),updated_at=now() where id=$1", [campaignId, jobs.rowCount]);
      await client.query("insert into audit_events(workspace_id,actor_type,actor_id,action,entity_type,entity_id,changes) values($1,'USER',$2,'campaign.started','campaign',$3,$4)", [workspaceId, DEMO_USER_ID, campaignId, JSON.stringify({ recipients: jobs.rowCount, channel })]);
      await client.query("commit");
      return { campaignId, channel, queued: jobs.rowCount, jobs: jobs.rows.map(({ displayName, phone, email, city, attributes, ...job }) => { const contact = { displayName, phone, email, city, attributes }; return { ...job, content: renderCampaignTemplate(composed.text, contact), buttons: composed.buttons.map((button) => ({ ...button, text: renderCampaignTemplate(button.text, contact), value: renderCampaignTemplate(button.value, contact) })), media: mediaResult.rows }; }) };
    } catch (error) { await client.query("rollback"); throw error; } finally { client.release(); }
  }

  async pauseCampaign(campaignId: string, workspace = "ws_demo") {
    const workspaceId = await this.workspaceId(workspace);
    const result = await this.pool.query("update campaigns set status='PAUSED',updated_at=now() where id=$1 and workspace_id=$2 and status in ('RUNNING','SCHEDULED') returning *", [campaignId, workspaceId]);
    if (!result.rowCount) {
      const exists = await this.pool.query("select status from campaigns where id=$1 and workspace_id=$2", [campaignId, workspaceId]);
      if (!exists.rowCount) throw new DomainError(404, "Campaign not found", "campaign_not_found");
      throw new DomainError(409, "Campaign cannot be paused from current status", "campaign_state_conflict");
    }
    await this.pool.query("insert into audit_events(workspace_id,actor_type,actor_id,action,entity_type,entity_id,changes) values($1,'USER',$2,'campaign.paused','campaign',$3,$4)", [workspaceId, DEMO_USER_ID, campaignId, JSON.stringify({ status: "PAUSED" })]);
    return this.mapCampaign(result.rows[0]);
  }

  async cancelCampaign(campaignId: string, workspace = "ws_demo") {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const workspaceId = await this.workspaceId(workspace, client);
      const result = await client.query("update campaigns set status='CANCELLED',updated_at=now() where id=$1 and workspace_id=$2 and status not in ('COMPLETED','CANCELLED') returning *", [campaignId, workspaceId]);
      if (!result.rowCount) {
        const exists = await client.query("select status from campaigns where id=$1 and workspace_id=$2", [campaignId, workspaceId]);
        if (!exists.rowCount) throw new DomainError(404, "Campaign not found", "campaign_not_found");
        throw new DomainError(409, "Campaign cannot be cancelled from current status", "campaign_state_conflict");
      }
      await client.query("update campaign_recipients set status='CANCELLED',next_attempt_at=null,last_error='Campaign cancelled by operator' where campaign_id=$1 and workspace_id=$2 and status in ('QUEUED','FAILED')", [campaignId, workspaceId]);
      await client.query("insert into audit_events(workspace_id,actor_type,actor_id,action,entity_type,entity_id,changes) values($1,'USER',$2,'campaign.cancelled','campaign',$3,$4)", [workspaceId, DEMO_USER_ID, campaignId, JSON.stringify({ status: "CANCELLED" })]);
      await client.query("commit");
      return this.mapCampaign(result.rows[0]);
    } catch (error) { await client.query("rollback"); throw error; } finally { client.release(); }
  }
  async listCampaignRecipients(campaignId: string, workspace = "ws_demo") {
    const workspaceId = await this.workspaceId(workspace);
    const result = await this.pool.query(`select cr.id,cr.contact_id "contactId",ct.display_name "contactName",cn.channel,ci.external_user_id "externalUserId",lower(cr.status::text) status,cr.attempt_count "attemptCount",cr.last_error "lastError",cr.sent_at "sentAt",cr.delivered_at "deliveredAt",cr.read_at "readAt" from campaign_recipients cr join contacts ct on ct.id=cr.contact_id left join connectors cn on cn.id=cr.connector_id left join channel_identities ci on ci.contact_id=cr.contact_id and ci.channel=cn.channel where cr.campaign_id=$1 and cr.workspace_id=$2 order by ct.display_name`, [campaignId, workspaceId]);
    return result.rows;
  }
}
