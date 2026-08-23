CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE user_role AS ENUM ('OWNER','ADMIN','SUPERVISOR','OPERATOR','SERVICE');
CREATE TYPE control_mode AS ENUM ('BOT','HUMAN','PAUSED');
CREATE TYPE message_direction AS ENUM ('INBOUND','OUTBOUND','SYSTEM');
CREATE TYPE message_status AS ENUM ('QUEUED','SENT','DELIVERED','READ','FAILED');
CREATE TYPE campaign_status AS ENUM ('DRAFT','SCHEDULED','RUNNING','PAUSED','COMPLETED','CANCELLED');

CREATE TABLE workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  timezone text NOT NULL DEFAULT 'Asia/Omsk',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email text NOT NULL, display_name text NOT NULL, password_hash text, role user_role NOT NULL DEFAULT 'OPERATOR',
  totp_secret_encrypted text, disabled_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,email)
);
CREATE TABLE bots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  slug text NOT NULL, name text NOT NULL, integration_mode text NOT NULL CHECK (integration_mode IN ('GATEWAY','MIRROR')),
  event_endpoint text, encrypted_secret text, enabled boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,slug)
);
CREATE TABLE connectors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  bot_id uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE, channel text NOT NULL, external_account_id text,
  encrypted_credentials jsonb NOT NULL DEFAULT '{}', capabilities jsonb NOT NULL DEFAULT '{}', status text NOT NULL DEFAULT 'PENDING',
  last_health_at timestamptz, last_error text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  display_name text NOT NULL, phone text, email text, city text, locale text,
  custom_fields jsonb NOT NULL DEFAULT '{}', marketing_status text NOT NULL DEFAULT 'UNKNOWN',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
);
CREATE UNIQUE INDEX contacts_verified_phone_uq ON contacts(workspace_id,phone) WHERE phone IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX contacts_verified_email_uq ON contacts(workspace_id,lower(email)) WHERE email IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX contacts_custom_fields_gin ON contacts USING gin(custom_fields jsonb_path_ops);
CREATE TABLE channel_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE, channel text NOT NULL, external_user_id text NOT NULL,
  verified boolean NOT NULL DEFAULT false, profile jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,channel,external_user_id)
);
CREATE TABLE conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  bot_id uuid NOT NULL REFERENCES bots(id), connector_id uuid REFERENCES connectors(id), contact_id uuid NOT NULL REFERENCES contacts(id),
  channel text NOT NULL, external_chat_id text NOT NULL, control_mode control_mode NOT NULL DEFAULT 'BOT', control_version integer NOT NULL DEFAULT 1,
  assigned_user_id uuid REFERENCES users(id), unread_count integer NOT NULL DEFAULT 0, custom_fields jsonb NOT NULL DEFAULT '{}',
  last_message_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(), archived_at timestamptz,
  UNIQUE(workspace_id,bot_id,channel,external_chat_id)
);
CREATE INDEX conversations_inbox_idx ON conversations(workspace_id,last_message_at DESC) WHERE archived_at IS NULL;
CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, event_id text, external_id text,
  direction message_direction NOT NULL, actor_type text NOT NULL, actor_id text, content_type text NOT NULL DEFAULT 'text',
  text_content text NOT NULL DEFAULT '', payload jsonb NOT NULL DEFAULT '{}', status message_status NOT NULL,
  reply_to_id uuid REFERENCES messages(id), error_code text, error_message text,
  occurred_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,event_id)
);
CREATE INDEX messages_conversation_idx ON messages(conversation_id,created_at,occurred_at,id);
CREATE INDEX messages_search_idx ON messages USING gin(to_tsvector('simple',text_content));
CREATE TABLE attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE, object_key text NOT NULL, filename text,
  mime_type text NOT NULL, byte_size bigint NOT NULL, sha256 text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE attribute_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  object_scope text NOT NULL CHECK (object_scope IN ('CONTACT','CONVERSATION','DEAL','CONTACT_BOT')),
  key text NOT NULL, label text NOT NULL, value_type text NOT NULL, authority text NOT NULL DEFAULT 'PLATFORM',
  config jsonb NOT NULL DEFAULT '{}', filterable boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,object_scope,key)
);
CREATE TABLE pipelines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL, is_default boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE stages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  pipeline_id uuid NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE, slug text NOT NULL, name text NOT NULL, color text NOT NULL,
  position integer NOT NULL, terminal_kind text CHECK (terminal_kind IN ('WON','LOST') OR terminal_kind IS NULL),
  UNIQUE(pipeline_id,position), UNIQUE(pipeline_id,slug)
);
CREATE TABLE deals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id), pipeline_id uuid NOT NULL REFERENCES pipelines(id), stage_id uuid NOT NULL REFERENCES stages(id),
  title text NOT NULL, amount numeric(14,2), currency char(3) NOT NULL DEFAULT 'RUB', assigned_user_id uuid REFERENCES users(id),
  custom_fields jsonb NOT NULL DEFAULT '{}', version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), closed_at timestamptz
);
CREATE INDEX deals_board_idx ON deals(workspace_id,pipeline_id,stage_id,updated_at DESC);
CREATE TABLE deal_stage_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  deal_id uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE, from_stage_id uuid REFERENCES stages(id), to_stage_id uuid NOT NULL REFERENCES stages(id),
  actor_type text NOT NULL, actor_id text, occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL, color text NOT NULL, UNIQUE(workspace_id,name)
);
CREATE TABLE contact_tags (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  tag_id uuid NOT NULL REFERENCES tags(id) ON DELETE CASCADE, PRIMARY KEY(contact_id,tag_id)
);
CREATE TABLE segments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL, filter_tree jsonb NOT NULL, created_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE, channel text NOT NULL, purpose text NOT NULL,
  status text NOT NULL CHECK (status IN ('GRANTED','REVOKED')), source text NOT NULL, evidence jsonb NOT NULL DEFAULT '{}', occurred_at timestamptz NOT NULL,
  UNIQUE(contact_id,channel,purpose)
);
CREATE TABLE suppression_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE, channel text, reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(contact_id,channel)
);
CREATE TABLE campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL, segment_id uuid REFERENCES segments(id), status campaign_status NOT NULL DEFAULT 'DRAFT',
  channel_content jsonb NOT NULL, scheduled_at timestamptz, audience_snapshot jsonb, created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE campaign_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE, contact_id uuid NOT NULL REFERENCES contacts(id),
  connector_id uuid REFERENCES connectors(id), status message_status, attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz, last_error text, sent_at timestamptz, delivered_at timestamptz, read_at timestamptz,
  UNIQUE(campaign_id,contact_id,connector_id)
);
CREATE INDEX campaign_queue_idx ON campaign_recipients(campaign_id,next_attempt_at) WHERE status IN ('QUEUED','FAILED');
CREATE TABLE automation_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL, enabled boolean NOT NULL DEFAULT true, trigger_type text NOT NULL, condition_tree jsonb NOT NULL DEFAULT '{}',
  actions jsonb NOT NULL, max_depth integer NOT NULL DEFAULT 5, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE automation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  rule_id uuid NOT NULL REFERENCES automation_rules(id), source_event_id text NOT NULL, depth integer NOT NULL DEFAULT 0,
  status text NOT NULL, result jsonb, error text, started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
  UNIQUE(rule_id,source_event_id)
);
CREATE TABLE tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  contact_id uuid REFERENCES contacts(id), deal_id uuid REFERENCES deals(id), assigned_user_id uuid REFERENCES users(id),
  title text NOT NULL, due_at timestamptz, completed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  contact_id uuid REFERENCES contacts(id), conversation_id uuid REFERENCES conversations(id), deal_id uuid REFERENCES deals(id),
  author_id uuid REFERENCES users(id), body text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_type text NOT NULL, actor_id text, action text NOT NULL, entity_type text NOT NULL, entity_id text,
  changes jsonb NOT NULL DEFAULT '{}', ip inet, occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_workspace_time_idx ON audit_events(workspace_id,occurred_at DESC);
CREATE TABLE ingested_events (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, event_id text NOT NULL,
  occurred_at timestamptz NOT NULL, received_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,event_id)
);

CREATE TABLE idempotency_keys (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, key text NOT NULL, request_hash text NOT NULL,
  response_code integer NOT NULL, response_body jsonb NOT NULL, expires_at timestamptz NOT NULL,
  PRIMARY KEY(workspace_id,key)
);
CREATE TABLE outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  topic text NOT NULL, aggregate_id text NOT NULL, payload jsonb NOT NULL, attempt_count integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz, last_error text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbox_pending_idx ON outbox_events(available_at) WHERE processed_at IS NULL;
