export type ApiChannel = "telegram" | "vk" | "whatsapp" | "avito" | "api";
export type ApiControlMode = "BOT" | "HUMAN" | "PAUSED";
export type ApiUserRole = "OWNER" | "ADMIN" | "SUPERVISOR" | "OPERATOR" | "SERVICE";
export interface ApiUser { sessionId?: string; userId: string; workspaceId: string; email: string; displayName: string; role: ApiUserRole; mfaEnabled: boolean; }
export interface ApiSession { id: string; userAgent?: string; ipAddress?: string; createdAt: string; lastSeenAt: string; expiresAt: string; revokedAt?: string; current: boolean; }
export interface ApiAdminUser { userId: string; email: string; displayName: string; role: Exclude<ApiUserRole, "SERVICE">; disabledAt?: string; lastLoginAt?: string; createdAt: string; mfaEnabled: boolean; }
export interface ApiServiceToken { id: string; name: string; tokenPrefix: string; createdAt: string; lastUsedAt?: string; expiresAt?: string; revokedAt?: string; token?: string; }
export interface ApiTeam { id: string; name: string; createdAt: string; members: Array<{ userId: string; displayName: string; email: string }>; }

export interface ApiContact {
  id: string;
  workspaceId: string;
  displayName: string;
  phone?: string;
  email?: string;
  city?: string;
  avatarAvailable?: boolean;
  attributes: Record<string, unknown>;
  identities: Array<{ channel: ApiChannel; externalUserId: string }>;
  tags?: string[];
  marketingStatus?: string;
  conversationId?: string;
  lastActivityAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type ApiAttributeScope = "CONTACT" | "CONVERSATION" | "DEAL" | "CONTACT_BOT";
export type ApiAttributeValueType = "STRING" | "NUMBER" | "BOOLEAN" | "DATE" | "ENUM" | "MULTISELECT" | "URL" | "JSON";
export type ApiAttributeAuthority = "PLATFORM" | "BOT";
export interface ApiAttributeDefinition { id: string; workspaceId: string; objectScope: ApiAttributeScope; key: string; label: string; valueType: ApiAttributeValueType; authority: ApiAttributeAuthority; config: Record<string, unknown>; filterable: boolean; usageCount: number; example?: unknown; createdAt: string; }
export interface ApiAttributeDefinitionInput { objectScope?: ApiAttributeScope; key?: string; label?: string; valueType?: ApiAttributeValueType; authority?: ApiAttributeAuthority; config?: Record<string, unknown>; filterable?: boolean; }
export interface ApiAttachment {
  id: string;
  filename: string;
  mimeType: string;
  byteSize: number;
  createdAt: string;
}

export interface ApiMediaUpload extends ApiAttachment {
  status: "pending" | "uploaded" | "attached" | "expired";
  expiresAt: string;
  completedAt?: string;
  uploadUrl?: string;
  method?: "PUT";
  headers?: Record<string, string>;
  maxByteSize?: number;
}
export interface ApiMessage {
  id: string;
  eventId?: string;
  conversationId: string;
  direction: "inbound" | "outbound" | "system";
  actor: "contact" | "bot" | "operator" | "system";
  text: string;
  status: "queued" | "sent" | "delivered" | "read" | "failed";
  externalId?: string;
  attachments: ApiAttachment[];
  createdAt: string;
}

export interface ApiConversation {
  id: string;
  workspaceId: string;
  botId: string;
  contactId: string;
  channel: ApiChannel;
  externalChatId: string;
  mode: ApiControlMode;
  controlVersion: number;
  assignedUserId?: string;
  unreadCount: number;
  lastMessageAt: string;
  contact: ApiContact;
  messages: ApiMessage[];
}

export interface ApiPipelineStage { id:string; slug:string; name:string; color:string; position:number; terminalKind?:"WON"|"LOST"; dealCount:number }
export interface ApiPipeline { id:string; name:string; isDefault:boolean; createdAt:string; stages:ApiPipelineStage[] }

export interface ApiDeal {
  id: string;
  workspaceId: string;
  contactId: string;
  pipelineId: string;
  stageId: string;
  title: string;
  amount: number;
  version: number;
  updatedAt: string;
  contact?: ApiContact;
}

export type ApiSegmentOperator = "equals" | "not_equals" | "contains" | "not_contains" | "gt" | "gte" | "lt" | "lte" | "exists" | "not_exists" | "in";
export interface ApiSegmentCondition { field: string; operator: ApiSegmentOperator; value?: unknown }
export interface ApiSegmentGroup { operator: "AND" | "OR"; conditions: Array<ApiSegmentCondition | ApiSegmentGroup> }
export interface ApiSegment { id: string; workspaceId: string; name: string; filter: ApiSegmentGroup; count?: number; createdAt: string }

export interface ApiCampaignButton { id?: string; text: string; type: "callback" | "url"; value: string; row: number; }
export interface ApiCampaign {
  id: string;
  workspaceId: string;
  name: string;
  channel: ApiChannel;
  status: "draft" | "scheduled" | "running" | "paused" | "completed" | "cancelled";
  audience: number;
  excluded: number;
  content: string;
  buttons?: ApiCampaignButton[];
  mediaIds?: string[];
  segmentId?: string;
  segmentName?: string;
  scheduledAt?: string;
  timeZone?: string;
  eligible?: number;
  sent?: number;
  delivered?: number;
  read?: number;
  failed?: number;
  createdAt: string;
}

export interface ApiCampaignRecipient {
  id: string;
  contactId: string;
  contactName: string;
  channel: ApiChannel;
  externalUserId: string;
  status: "pending" | "queued" | "sent" | "delivered" | "read" | "failed" | "cancelled";
  attemptCount: number;
  lastError?: string;
  sentAt?: string;
  deliveredAt?: string;
  readAt?: string;
}

export interface ApiConnector {
  id: string; workspaceId: string; botId: string; botSlug: string; botName: string; integrationMode: "GATEWAY" | "MIRROR"; eventEndpoint?: string;
  channel: ApiChannel; externalAccountId?: string; status: "pending" | "connected" | "warning" | "disabled"; capabilities: Record<string, unknown>;
  configuredFields: string[]; webhookUrl: string; lastHealthAt?: string; lastError?: string; createdAt: string;
}
export interface ApiConnectorInput { botName: string; botSlug?: string; integrationMode?: "GATEWAY" | "MIRROR"; eventEndpoint?: string; channel: ApiChannel; externalAccountId?: string; credentials?: Record<string, unknown>; }
export type ApiAutomationTrigger = "message.received" | "message.sent" | "contact.updated" | "conversation.created" | "deal.created" | "deal.stage_changed" | "button.clicked" | "conversation.inactive" | "campaign.delivered" | "campaign.failed";
export interface ApiAutomationCondition { field: string; operator: "equals" | "not_equals" | "contains" | "not_contains" | "gt" | "gte" | "lt" | "lte" | "exists" | "not_exists" | "in"; value?: unknown; }
export type ApiAutomationAction =
  | { type: "set_attribute"; key: string; value: unknown }
  | { type: "add_tag"; tag: string; color?: string }
  | { type: "move_deal"; stage: string }
  | { type: "assign_user"; userId: string }
  | { type: "create_task"; title: string; dueMinutes?: number; userId?: string }
  | { type: "set_control"; mode: ApiControlMode }
  | { type: "send_message"; text: string; actor?: "bot" | "operator" }
  | { type: "webhook"; url: string }
  | { type: "suppress_contact"; reason?: string; channel?: string };
export interface ApiAutomationInput { name: string; enabled?: boolean; triggerType: ApiAutomationTrigger; conditionTree?: { match: "all" | "any"; conditions: ApiAutomationCondition[] }; actions: ApiAutomationAction[]; maxDepth?: number; }
export interface ApiAutomationRule extends Required<ApiAutomationInput> { id: string; workspaceId: string; runCount: number; successCount: number; lastRunAt?: string; createdAt: string; }
export interface ApiAutomationRun { id: string; ruleId: string; ruleName: string; sourceEventId: string; depth: number; status: "RUNNING" | "SUCCESS" | "FAILED"; result?: Record<string, unknown>; error?: string; startedAt: string; finishedAt?: string; durationMs: number; }
export interface ApiSearchResult {
  type: "contact" | "message" | "deal";
  id: string;
  contactId?: string;
  conversationId?: string;
  title: string;
  subtitle?: string;
  excerpt?: string;
  occurredAt: string;
  score: number;
}

export interface ApiAnalytics {
  periodDays: number;
  generatedAt: string;
  summary: { conversations: number; conversationDelta: number; wonDeals: number; conversion: number; conversionDelta: number; firstResponseSeconds: number; revenue: number; revenueDelta: number };
  daily: Array<{ date: string; conversations: number; won: number }>;
  channels: Array<{ channel: ApiChannel; count: number; share: number }>;
  funnel: Array<{ slug: string; name: string; color: string; position: number; count: number; amount: number }>;
  bots: Array<{ slug: string; name: string; conversations: number; won: number; score: number }>;
}
export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
  }
}

function apiBase() {
  if (typeof window !== "undefined") {
    const configured = window.localStorage.getItem("botcrm_api_url");
    if (configured) return configured;
    if (["localhost", "127.0.0.1", "::1"].includes(window.location.hostname)) return "http://localhost:4100/api/v1";
    return "/api/v1";
  }
  return process.env.NEXT_PUBLIC_API_URL || "http://localhost:4100/api/v1";
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  headers.set("x-workspace-id", "ws_demo");
  if (typeof window !== "undefined") { const token = window.localStorage.getItem("botcrm_auth_token"); if (token) headers.set("authorization", `Bearer ${token}`); }
  if (init.body) headers.set("content-type", "application/json");
  const response = await fetch(`${apiBase()}${path}`, { ...init, headers, signal: AbortSignal.timeout(8_000) });
  const payload = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
  if (!response.ok) throw new ApiError(response.status, payload?.error?.code || "request_failed", payload?.error?.message || `API returned ${response.status}`);
  return payload as T;
}

async function requestBlob(path: string): Promise<Blob> {
  const headers = new Headers({ accept: "image/*", "x-workspace-id": "ws_demo" });
  if (typeof window !== "undefined") { const token = window.localStorage.getItem("botcrm_auth_token"); if (token) headers.set("authorization", `Bearer ${token}`); }
  const response = await fetch(`${apiBase()}${path}`, { headers, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new ApiError(response.status, "avatar_load_failed", `Avatar returned ${response.status}`);
  return response.blob();
}

export function setAuthToken(token?: string) {
  if (typeof window === "undefined") return;
  if (token) window.localStorage.setItem("botcrm_auth_token", token);
  else window.localStorage.removeItem("botcrm_auth_token");
}

export type ApiRealtimeStatus = "connecting" | "live" | "offline";
export interface ApiRealtimeEvent {
  type: "change";
  workspaceId: string;
  entity: string;
  operation: "insert" | "update" | "delete";
  entityId?: string;
  occurredAt: string;
}

export function subscribeToRealtime(onEvent: (event: ApiRealtimeEvent) => void, onStatus: (status: ApiRealtimeStatus) => void) {
  if (typeof window === "undefined") return () => undefined;
  let stopped = false;
  let controller: AbortController | undefined;
  let retryTimer: number | undefined;
  let retryDelay = 1_000;

  const connect = async () => {
    if (stopped) return;
    controller = new AbortController();
    onStatus("connecting");
    try {
      const headers = new Headers({ accept: "text/event-stream", "x-workspace-id": "ws_demo" });
      const token = window.localStorage.getItem("botcrm_auth_token");
      if (token) headers.set("authorization", `Bearer ${token}`);
      const response = await fetch(`${apiBase()}/realtime`, { headers, signal: controller.signal, cache: "no-store" });
      if (!response.ok || !response.body) throw new ApiError(response.status, "realtime_unavailable", `Realtime returned ${response.status}`);
      onStatus("live");
      retryDelay = 1_000;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!stopped) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, "\n");
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
          if (!data) continue;
          try {
            const event = JSON.parse(data) as Partial<ApiRealtimeEvent>;
            if (event.type === "change" && event.workspaceId && event.entity && event.operation && event.occurredAt) onEvent(event as ApiRealtimeEvent);
          } catch { /* Ignore malformed or forward-compatible events. */ }
        }
      }
      if (!stopped) throw new Error("Realtime stream ended");
    } catch (error) {
      if (stopped || (error instanceof DOMException && error.name === "AbortError")) return;
      onStatus("offline");
      retryTimer = window.setTimeout(() => void connect(), retryDelay);
      retryDelay = Math.min(15_000, retryDelay * 2);
    }
  };

  void connect();
  return () => {
    stopped = true;
    controller?.abort();
    if (retryTimer !== undefined) window.clearTimeout(retryTimer);
  };
}
export const botcrmApi = {
  login: (input: { workspace?: string; email: string; password: string; totp?: string }) => request<{ token: string; expiresAt: string; user: ApiUser }>("/auth/login", { method: "POST", body: JSON.stringify(input) }),
  me: () => request<ApiUser>("/auth/me"),
  logout: () => request<{ ok: boolean }>("/auth/logout", { method: "POST", body: JSON.stringify({}) }),
  sessions: () => request<ApiSession[]>("/auth/sessions"),
  revokeSession: (sessionId: string) => request<{ ok: boolean }>(`/auth/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" }),
  setupMfa: () => request<{ secret: string; uri: string; expiresInSeconds: number }>("/auth/mfa/setup", { method: "POST", body: JSON.stringify({}) }),
  verifyMfa: (code: string) => request<{ enabled: true }>("/auth/mfa/verify", { method: "POST", body: JSON.stringify({ code }) }),
  disableMfa: (password: string, code: string) => request<{ enabled: false }>("/auth/mfa", { method: "DELETE", body: JSON.stringify({ password, code }) }),
  adminUsers: () => request<ApiAdminUser[]>("/admin/users"),
  createUser: (input: { email: string; displayName: string; password: string; role: ApiAdminUser["role"] }) => request<ApiAdminUser>("/admin/users", { method: "POST", body: JSON.stringify(input) }),
  updateUser: (userId: string, input: { role?: ApiAdminUser["role"]; disabled?: boolean }) => request<ApiAdminUser>(`/admin/users/${encodeURIComponent(userId)}`, { method: "PATCH", body: JSON.stringify(input) }),
  teams: () => request<ApiTeam[]>("/admin/teams"),
  createTeam: (name: string) => request<ApiTeam>("/admin/teams", { method: "POST", body: JSON.stringify({ name }) }),
  setTeamMembers: (teamId: string, userIds: string[]) => request<ApiTeam>(`/admin/teams/${encodeURIComponent(teamId)}/members`, { method: "PATCH", body: JSON.stringify({ userIds }) }),
  deleteTeam: (teamId: string) => request<{ ok: boolean }>(`/admin/teams/${encodeURIComponent(teamId)}`, { method: "DELETE" }),
  serviceTokens: () => request<ApiServiceToken[]>("/admin/service-tokens"),
  createServiceToken: (input: { name: string; expiresAt?: string }) => request<ApiServiceToken>("/admin/service-tokens", { method: "POST", body: JSON.stringify(input) }),
  revokeServiceToken: (tokenId: string) => request<{ ok: boolean }>(`/admin/service-tokens/${encodeURIComponent(tokenId)}`, { method: "DELETE" }),
  health: () => request<{ status: string; version: string }>("/health"),
  conversations: () => request<ApiConversation[]>("/conversations"),
  markConversationRead: (conversationId: string) => request<{ id: string; unreadCount: number }>(`/conversations/${encodeURIComponent(conversationId)}/read`, { method: "PATCH", body: JSON.stringify({}) }),
search: (query: string, limit = 30) => request<ApiSearchResult[]>(`/search?q=${encodeURIComponent(query)}&limit=${Math.min(50, Math.max(1, limit))}`),
  analytics: (days = 30) => request<ApiAnalytics>(`/analytics?days=${Math.min(365, Math.max(1, days))}`),
  connectors: () => request<ApiConnector[]>("/connectors"),
  createConnector: (input: ApiConnectorInput) => request<ApiConnector>("/connectors", { method: "POST", body: JSON.stringify(input) }),
  updateConnector: (id: string, input: Partial<Omit<ApiConnectorInput, "channel" | "botSlug">> & { enabled?: boolean }) => request<ApiConnector>(`/connectors/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(input) }),
  checkConnector: (id: string) => request<ApiConnector>(`/connectors/${encodeURIComponent(id)}/check`, { method: "POST", body: JSON.stringify({}) }),
  deleteConnector: (id: string) => request<{ ok: boolean }>(`/connectors/${encodeURIComponent(id)}`, { method: "DELETE" }),  automations: () => request<ApiAutomationRule[]>("/automations"),
  createAutomation: (input: ApiAutomationInput) => request<ApiAutomationRule>("/automations", { method: "POST", body: JSON.stringify(input) }),
  updateAutomation: (id: string, input: Partial<ApiAutomationInput>) => request<ApiAutomationRule>(`/automations/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteAutomation: (id: string) => request<{ ok: boolean }>(`/automations/${encodeURIComponent(id)}`, { method: "DELETE" }),
  automationRuns: (limit = 100) => request<ApiAutomationRun[]>(`/automations/runs?limit=${Math.min(500, Math.max(1, limit))}`),
  testAutomation: (id: string, input: { contactId?: string; context?: Record<string, unknown> }) => request<{ matched: boolean; context: Record<string, unknown>; actions: ApiAutomationAction[] }>(`/automations/${encodeURIComponent(id)}/test`, { method: "POST", body: JSON.stringify(input) }),  contacts: () => request<ApiContact[]>("/contacts"),
  attributeDefinitions: () => request<ApiAttributeDefinition[]>("/attribute-definitions"),
  createAttributeDefinition: (input: ApiAttributeDefinitionInput) => request<ApiAttributeDefinition>("/attribute-definitions", { method: "POST", body: JSON.stringify(input) }),
  updateAttributeDefinition: (id: string, input: ApiAttributeDefinitionInput) => request<ApiAttributeDefinition>(`/attribute-definitions/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteAttributeDefinition: (id: string) => request<{ ok: boolean; valuesPreserved: boolean }>(`/attribute-definitions/${encodeURIComponent(id)}`, { method: "DELETE" }),
  contactAvatar: (contactId: string, channel?: ApiChannel) => requestBlob(`/contacts/${encodeURIComponent(contactId)}/avatar${channel ? `?channel=${encodeURIComponent(channel)}` : ""}`),
  exportContacts: (format: "csv" | "json") => request<{ format: "csv" | "json"; filename: string; mimeType: string; content: string }>(`/contacts/export?format=${format}`),
  importContacts: (format: "csv" | "json", content: string) => request<{ total: number; imported: number; failed: number; errors: Array<{ row: number; message: string; code?: string }> }>("/contacts/import", { method: "POST", body: JSON.stringify({ format, content }) }),  createContact: (input: { displayName: string; phone?: string; email?: string; city?: string; attributes?: Record<string,unknown>; channel?: ApiChannel; externalUserId?: string }) => request<ApiContact>("/contacts", { method: "POST", body: JSON.stringify(input) }),
  updateContact: (id: string, input: { displayName?: string; phone?: string|null; email?: string|null; city?: string|null; attributes?: Record<string,unknown>; marketingStatus?: string }) => request<ApiContact>(`/contacts/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(input) }),
  setContactTags: (id: string, tags: string[]) => request<ApiContact>(`/contacts/${encodeURIComponent(id)}/tags`, { method: "PATCH", body: JSON.stringify({ tags }) }),
  anonymizeContact: (id: string) => request<{ok:boolean}>(`/contacts/${encodeURIComponent(id)}`, { method: "DELETE" }),
  mergeContacts: (targetId: string, sourceContactId: string) => request<ApiContact>(`/contacts/${encodeURIComponent(targetId)}/merge`, { method: "POST", body: JSON.stringify({ sourceContactId }) }),
  contactActivity: (id: string) => request<{ notes: Array<{id:string;body:string;createdAt:string}>; tasks: Array<{id:string;title:string;dueAt?:string;completedAt?:string;createdAt:string}>; audit: Array<{id:string;action:string;changes:Record<string,unknown>;occurredAt:string}> }>(`/contacts/${encodeURIComponent(id)}/activity`),
  addContactNote: (id: string, body: string) => request(`/contacts/${encodeURIComponent(id)}/notes`, { method: "POST", body: JSON.stringify({ body }) }),
  addContactTask: (id: string, input: {title:string;dueAt?:string}) => request(`/contacts/${encodeURIComponent(id)}/tasks`, { method: "POST", body: JSON.stringify(input) }),
  completeTask: (id: string) => request(`/tasks/${encodeURIComponent(id)}/complete`, { method: "PATCH", body: JSON.stringify({}) }),
  pipelines: () => request<ApiPipeline[]>("/pipelines"),
  createPipeline: (input:{name:string}) => request<ApiPipeline>("/pipelines",{method:"POST",body:JSON.stringify(input)}),
  updatePipeline: (id:string,input:{name?:string;isDefault?:boolean}) => request<ApiPipeline>(`/pipelines/${encodeURIComponent(id)}`,{method:"PATCH",body:JSON.stringify(input)}),
  createStage: (pipelineId:string,input:{name:string;color?:string;terminalKind?:"WON"|"LOST"}) => request<ApiPipelineStage>(`/pipelines/${encodeURIComponent(pipelineId)}/stages`,{method:"POST",body:JSON.stringify(input)}),
  updateStage: (id:string,input:{name?:string;color?:string;terminalKind?:"WON"|"LOST"|null;position?:number}) => request<ApiPipelineStage>(`/stages/${encodeURIComponent(id)}`,{method:"PATCH",body:JSON.stringify(input)}),
  deleteStage: (id:string) => request<{ok:boolean}>(`/stages/${encodeURIComponent(id)}`,{method:"DELETE"}),
  createDeal: (input:{contactId:string;pipelineId?:string;stageId?:string;title:string;amount?:number}) => request<ApiDeal>("/deals",{method:"POST",body:JSON.stringify(input)}),
  updateDeal: (id:string,input:{title?:string;amount?:number;expectedVersion:number}) => request<ApiDeal>(`/deals/${encodeURIComponent(id)}`,{method:"PATCH",body:JSON.stringify(input)}),
  deals: (pipelineId = "sales") => request<ApiDeal[]>(`/pipelines/${encodeURIComponent(pipelineId)}/deals`),
  segments: () => request<ApiSegment[]>("/segments"),
  createSegment: (input: { name: string; filter: ApiSegmentGroup }) => request<ApiSegment>("/segments", { method: "POST", body: JSON.stringify(input) }),
  updateSegment: (id: string, input: { name?: string; filter?: ApiSegmentGroup }) => request<ApiSegment>(`/segments/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteSegment: (id: string) => request<{ ok: boolean }>(`/segments/${encodeURIComponent(id)}`, { method: "DELETE" }),
  previewSegment: (input: { segmentId?: string; filter?: ApiSegmentGroup; channel?: ApiChannel; limit?: number }) => request<{ total: number; eligible: number; excluded: number; contacts: ApiContact[]; variables: Array<{ key: string; example?: string }> }>("/segments/preview", { method: "POST", body: JSON.stringify(input) }),
  campaigns: () => request<ApiCampaign[]>("/campaigns"),
  setControl: (conversationId: string, mode: ApiControlMode, expectedVersion: number) => request<Omit<ApiConversation, "contact" | "messages">>(`/conversations/${encodeURIComponent(conversationId)}/control`, { method: "PATCH", body: JSON.stringify({ mode, expectedVersion }) }),
  createMediaUpload: (file: { name: string; type: string; size: number }) => request<ApiMediaUpload>("/media/uploads", { method: "POST", body: JSON.stringify({ filename: file.name, mimeType: file.type || "application/octet-stream", byteSize: file.size }) }),
  completeMediaUpload: (uploadId: string) => request<ApiMediaUpload>(`/media/uploads/${encodeURIComponent(uploadId)}/complete`, { method: "POST", body: JSON.stringify({}) }),
  attachmentUrl: (attachmentId: string) => request<{ url: string; expiresInSeconds: number }>(`/media/attachments/${encodeURIComponent(attachmentId)}/url`),
  uploadAttachment: async (file: File) => {
    const reservation = await botcrmApi.createMediaUpload(file);
    if (!reservation.uploadUrl || !reservation.headers) throw new ApiError(500, "invalid_upload_reservation", "API did not return an upload URL");
    const upload = await fetch(reservation.uploadUrl, { method: "PUT", headers: reservation.headers, body: file, signal: AbortSignal.timeout(60_000) });
    if (!upload.ok) throw new ApiError(upload.status, "media_upload_failed", `Хранилище вернуло ${upload.status}`);
    return botcrmApi.completeMediaUpload(reservation.id);
  },
  sendMessage: (conversationId: string, text: string, idempotencyKey: string, attachmentIds: string[] = []) => request<{ duplicate: boolean; message: ApiMessage }>("/messages/send", { method: "POST", headers: { "idempotency-key": idempotencyKey }, body: JSON.stringify({ conversationId, actor: "operator", text, attachmentIds }) }),
  moveDeal: (dealId: string, stageId: string, expectedVersion: number) => request<ApiDeal>(`/deals/${encodeURIComponent(dealId)}/stage`, { method: "PATCH", body: JSON.stringify({ stageId, expectedVersion }) }),
  previewCampaign: (input: { segmentId?: string; filter?: ApiSegmentGroup; channel?: ApiChannel; limit?: number }) => request<{ total: number; eligible: number; excluded: number; contacts: ApiContact[] }>("/campaigns/preview", { method: "POST", body: JSON.stringify(input) }),
  testCampaign: (input: { contactId: string; channel: ApiChannel; content: string; buttons?: ApiCampaignButton[]; mediaIds?: string[] }) => request<{ duplicate: boolean; message: ApiMessage }>("/campaigns/test", { method: "POST", body: JSON.stringify(input) }),
  createCampaign: (input: { name: string; channel: ApiChannel; content: string; buttons?: ApiCampaignButton[]; mediaIds?: string[]; segmentId?: string; scheduledAt?: string; timeZone?: string }) => request<ApiCampaign>("/campaigns", { method: "POST", body: JSON.stringify(input) }),
  updateCampaign: (campaignId: string, input: { name: string; channel: ApiChannel; content: string; buttons?: ApiCampaignButton[]; mediaIds?: string[]; segmentId?: string; scheduledAt?: string; timeZone?: string }) => request<ApiCampaign>(`/campaigns/${encodeURIComponent(campaignId)}`, { method: "PATCH", body: JSON.stringify(input) }),
  startCampaign: (campaignId: string) => request<{ campaignId: string; channel: ApiChannel; recipients: number; queued: number }>(`/campaigns/${encodeURIComponent(campaignId)}/start`, { method: "POST", body: JSON.stringify({}) }),
  campaignRecipients: (campaignId: string) => request<ApiCampaignRecipient[]>(`/campaigns/${encodeURIComponent(campaignId)}/recipients`),
  pauseCampaign: (campaignId: string) => request<ApiCampaign>(`/campaigns/${encodeURIComponent(campaignId)}/pause`, { method: "POST", body: JSON.stringify({}) }),
  cancelCampaign: (campaignId: string) => request<ApiCampaign>(`/campaigns/${encodeURIComponent(campaignId)}/cancel`, { method: "POST", body: JSON.stringify({}) }),
};