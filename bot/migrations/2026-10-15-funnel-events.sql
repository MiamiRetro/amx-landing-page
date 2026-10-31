-- Onboarding funnel: one row per step a member takes (join, language_picked,
-- verify_opened, verify_result, verified, leave, language_changed_by_mod).
-- invite_code is the invite a join came through, null when it cannot be told.
create table if not exists funnel_events (
  id bigserial primary key,
  guild_id text not null,
  discord_user_id text not null,
  event text not null,
  lang text,
  detail jsonb,
  invite_code text,
  created_at timestamptz not null default now()
);
create index if not exists funnel_events_event_idx on funnel_events (guild_id, event, created_at);

alter table funnel_events enable row level security;
