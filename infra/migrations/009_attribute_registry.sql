create table if not exists attribute_definitions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  object_scope text not null check (object_scope in ('CONTACT','CONVERSATION','DEAL','CONTACT_BOT')),
  key text not null,
  label text not null,
  value_type text not null check (value_type in ('STRING','NUMBER','BOOLEAN','DATE','ENUM','MULTISELECT','URL','JSON')),
  authority text not null default 'PLATFORM',
  config jsonb not null default '{}'::jsonb,
  filterable boolean not null default true,
  created_at timestamptz not null default now(),
  unique(workspace_id, object_scope, key)
);

insert into attribute_definitions(workspace_id,object_scope,key,label,value_type,authority,config,filterable)
select ct.workspace_id,
       'CONTACT',
       item.key,
       initcap(regexp_replace(item.key, '[._-]+', ' ', 'g')),
       case
         when bool_and(jsonb_typeof(item.value) = 'number') then 'NUMBER'
         when bool_and(jsonb_typeof(item.value) = 'boolean') then 'BOOLEAN'
         when bool_and(jsonb_typeof(item.value) = 'array') then 'MULTISELECT'
         when bool_and(jsonb_typeof(item.value) = 'string') then 'STRING'
         else 'JSON'
       end,
       'BOT',
       '{"discovered":true,"backfilled":true}'::jsonb,
       true
from contacts ct
cross join lateral jsonb_each(coalesce(ct.custom_fields, '{}'::jsonb)) item
where ct.deleted_at is null and item.key ~ '^[A-Za-z_][A-Za-z0-9_.-]{0,79}$'
group by ct.workspace_id,item.key
on conflict(workspace_id,object_scope,key) do nothing;
