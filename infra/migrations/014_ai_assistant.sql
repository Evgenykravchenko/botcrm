-- Optional assistant. Existing bots and release slots do not depend on these tables.
create table assistant_settings (
  workspace_id uuid primary key references workspaces(id) on delete cascade,
  enabled boolean not null default false,
  provider text not null default 'openai' check(provider in ('openai','compatible')),
  encrypted_credentials jsonb not null default '{}',
  monthly_budget_micros bigint not null default 5000000 check(monthly_budget_micros between 100000 and 100000000),
  daily_user_limit integer not null default 100 check(daily_user_limit between 1 and 1000),
  updated_at timestamptz not null default now()
);
create table assistant_requests (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  request_id uuid not null,
  user_id uuid not null references users(id),
  input_hash text not null,
  provider text not null,
  model text not null,
  status text not null check(status in ('pending','succeeded','failed')),
  cost_micros bigint not null check(cost_micros >= 0),
  input_tokens integer,
  output_tokens integer,
  encrypted_result jsonb,
  created_at timestamptz not null default now(),
  primary key(workspace_id,request_id)
);
create index assistant_requests_budget on assistant_requests(workspace_id,created_at);
create index assistant_requests_user on assistant_requests(workspace_id,user_id,created_at);
