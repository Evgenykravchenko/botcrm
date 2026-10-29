-- Transient transfer telemetry stays in BotCRM; no changes to the shared Directus schema.
create table if not exists content_media_progress (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  bot_id uuid not null references bots(id) on delete cascade,
  media_id integer not null check (media_id > 0),
  source_path text not null,
  attempt_id uuid not null,
  stage text not null check (stage in ('connecting', 'transferring', 'finalizing')),
  transferred_bytes bigint not null check (transferred_bytes >= 0),
  total_bytes bigint check (total_bytes > 0),
  bytes_per_second double precision check (bytes_per_second >= 0),
  eta_seconds integer check (eta_seconds >= 0),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, bot_id, media_id),
  check (total_bytes is null or transferred_bytes <= total_bytes)
);
create index if not exists idx_content_media_progress_updated on content_media_progress(updated_at);
