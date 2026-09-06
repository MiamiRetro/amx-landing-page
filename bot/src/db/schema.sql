-- amx-mirror-bot schema. Apply once with the Supabase SQL editor or `supabase db push`.
-- All tables are service-role only; the bot is the sole client.

create table if not exists channel_groups (
  id uuid primary key default gen_random_uuid(),
  guild_id text not null,
  name text not null,
  paused boolean not null default false,
  created_at timestamptz not null default now(),
  unique (guild_id, name)
);

create table if not exists channel_group_members (
  channel_id text primary key,
  group_id uuid not null references channel_groups(id) on delete cascade,
  lang text not null check (lang in ('en','zh','ko','id')),
  webhook_id text,
  webhook_token text,
  last_seen_message_id text,
  unique (group_id, lang)
);

create table if not exists message_map (
  source_message_id text not null,
  source_channel_id text not null,
  target_channel_id text not null,
  mirror_message_id text not null,
  lang text not null,
  created_at timestamptz not null default now(),
  primary key (source_message_id, target_channel_id)
);
create index if not exists message_map_mirror_idx on message_map (mirror_message_id);
create index if not exists message_map_source_channel_idx on message_map (source_channel_id, created_at);

create table if not exists translation_cache (
  hash text not null,
  lang text not null,
  text text not null,
  provider text not null,
  created_at timestamptz not null default now(),
  primary key (hash, lang)
);
create index if not exists translation_cache_created_idx on translation_cache (created_at);

create table if not exists glossary (
  guild_id text not null,
  term text not null,
  note text,
  created_at timestamptz not null default now(),
  primary key (guild_id, term)
);

create table if not exists settings (
  guild_id text not null,
  key text not null,
  value text not null,
  primary key (guild_id, key)
);

create table if not exists usage_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  provider text not null,
  input_tokens int not null default 0,
  cached_tokens int not null default 0,
  output_tokens int not null default 0,
  segments int not null default 0,
  ms int not null default 0,
  ok boolean not null default true
);
create index if not exists usage_log_at_idx on usage_log (at);

alter table channel_groups enable row level security;
alter table channel_group_members enable row level security;
alter table message_map enable row level security;
alter table translation_cache enable row level security;
alter table glossary enable row level security;
alter table settings enable row level security;
alter table usage_log enable row level security;
