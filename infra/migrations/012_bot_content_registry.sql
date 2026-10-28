create table if not exists bot_content_profiles (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  bot_id uuid not null references bots(id) on delete cascade,
  content_bot_key text not null,
  channel text not null default 'other',
  yandex_root text,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (bot_id),
  unique (content_bot_key),
  check (content_bot_key ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  check (channel in ('telegram', 'vk', 'instagram', 'other')),
  check (yandex_root is null or left(yandex_root, 1) = '/')
);

create index if not exists idx_bot_content_profiles_workspace
  on bot_content_profiles(workspace_id, enabled, created_at);

insert into bot_content_profiles(workspace_id, bot_id, content_bot_key, channel, yandex_root)
select b.workspace_id,
       b.id,
       left(replace(b.workspace_id::text, '-', ''), 12) || '-' || replace(b.slug, '_', '-'),
       case
         when bool_or(c.channel = 'telegram') then 'telegram'
         when bool_or(c.channel = 'vk') then 'vk'
         else 'other'
       end,
       '/bot_crm/' || b.slug
from bots b
join connectors c on c.bot_id = b.id
group by b.workspace_id, b.id, b.slug
on conflict (bot_id) do nothing;

create table if not exists bot_content_tokens (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  bot_id uuid not null references bots(id) on delete cascade,
  name text not null,
  token_hash char(64) not null unique,
  token_prefix text not null,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  check (char_length(name) between 1 and 120),
  check (char_length(token_prefix) between 8 and 24)
);

create index if not exists idx_bot_content_tokens_bot
  on bot_content_tokens(bot_id, revoked_at, expires_at);

comment on table bot_content_profiles is
  'BotCRM-owned content spaces. Directus is an internal storage backend and is not exposed to bots.';

comment on table bot_content_tokens is
  'Per-bot credentials for the BotCRM content runtime API. Only hashes are stored.';
