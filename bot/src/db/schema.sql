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
  -- Disjoint input counts, billed at different rates: input_tokens at 1x,
  -- cache_creation_tokens (cache writes) at 1.25x, cached_tokens (cache reads) at 0.1x.
  input_tokens int not null default 0,
  cached_tokens int not null default 0,
  cache_creation_tokens int not null default 0,
  output_tokens int not null default 0,
  segments int not null default 0,
  ms int not null default 0,
  ok boolean not null default true
);
create index if not exists usage_log_at_idx on usage_log (at);
-- Migration for databases created before cache_creation_tokens existed. Rows
-- written before this column landed under-report cost: their cache-write tokens
-- were never recorded and read back as 0.
alter table usage_log add column if not exists cache_creation_tokens int not null default 0;

alter table channel_groups enable row level security;
alter table channel_group_members enable row level security;
alter table message_map enable row level security;
alter table translation_cache enable row level security;
alter table glossary enable row level security;
alter table settings enable row level security;
alter table usage_log enable row level security;

-- Remembered language choice, applied once the member is verified.
create table if not exists language_prefs (
  guild_id text not null,
  user_id text not null,
  lang text not null check (lang in ('en','zh','ko','id')),
  updated_at timestamptz not null default now(),
  primary key (guild_id, user_id)
);
alter table language_prefs enable row level security;

-- UID verification -----------------------------------------------------------

-- One row per Discord account. A member who re-verifies overwrites their row.
create table if not exists verifications (
  guild_id text not null,
  discord_user_id text not null,
  exchange text not null check (exchange in ('bitget','blofin','bybit')),
  uid text not null,
  detail jsonb,
  verified_at timestamptz not null default now(),
  primary key (guild_id, discord_user_id)
);
-- A UID belongs to exactly one Discord account, so a shared UID cannot let a
-- second person in.
create unique index if not exists verifications_uid_idx on verifications (exchange, uid);

-- Every attempt, successful or not. Feeds the per-member rate limit that stops
-- someone guessing at UIDs until one sticks.
create table if not exists verification_attempts (
  id bigserial primary key,
  at timestamptz not null default now(),
  guild_id text not null,
  discord_user_id text not null,
  exchange text not null,
  uid text not null,
  outcome text not null,
  ms int not null default 0,
  error text
);
create index if not exists verification_attempts_user_idx on verification_attempts (guild_id, discord_user_id, at);

alter table verifications enable row level security;
alter table verification_attempts enable row level security;

-- Translation queue ------------------------------------------------------------
-- Lets the bot hand translation jobs to a worker on a machine we run (Gemma via
-- llama.cpp) with no public endpoint: both sides only make outbound calls to
-- Supabase. Additive and idempotent.
--
-- The worker only ever writes a result here. The bot stays the sole Discord
-- publisher, so a late or duplicate result can never post twice.
--
-- Access is service-role RPC only: RLS is on with no policies, table privileges
-- are revoked from anon/authenticated, and every function is SECURITY DEFINER
-- with an empty search_path and EXECUTE granted to service_role alone.
--
-- Message text lives in translation_jobs.request only while a job is live. It is
-- blanked the moment a job reaches any final state, the bot deletes rows as it
-- reads them, and translation_purge() deletes whatever is left once purge_after
-- passes (deadline + retention, 10 minutes by default). translation_enqueue calls
-- it, so cleanup happens whenever the bot is running; schedule it with pg_cron as
-- well if you want it independent of traffic:
--   select cron.schedule('translation-purge', '* * * * *', 'select public.translation_purge()');

create table if not exists translation_jobs (
  id uuid primary key default gen_random_uuid(),
  -- Env-scoped, e.g. translate-gemma4-prod vs translate-gemma4-test.
  queue text not null check (queue ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  status text not null default 'queued'
    check (status in ('queued','running','succeeded','failed','cancelled','expired')),
  request jsonb not null,
  result jsonb,
  error text,
  attempts int not null default 0,
  -- Ownership of the current claim; only the holder can renew, complete or fail.
  claim_token uuid,
  claimed_by text,
  lease_expires_at timestamptz,
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  finished_at timestamptz,
  deadline_at timestamptz not null,
  purge_after timestamptz not null
);
create index if not exists translation_jobs_claim_idx on translation_jobs (queue, created_at)
  where status in ('queued','running');
create index if not exists translation_jobs_purge_idx on translation_jobs (purge_after);

-- One row per live worker; the bot treats a recent heartbeat as "worker is up".
create table if not exists translation_workers (
  queue text not null check (queue ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  worker_id text not null,
  heartbeat_at timestamptz not null default now(),
  info jsonb,
  primary key (queue, worker_id)
);

alter table translation_jobs enable row level security;
alter table translation_workers enable row level security;
revoke all on table public.translation_jobs from public, anon, authenticated;
revoke all on table public.translation_workers from public, anon, authenticated;

-- Wakeup for the worker (INSERT) and the bot (UPDATE) via Realtime. Polling
-- covers anything Realtime misses. With RLS on and no policies, only the service
-- role receives these changes.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'translation_jobs'
     ) then
    alter publication supabase_realtime add table public.translation_jobs;
  end if;
end $$;

-- Expires overdue jobs (blanking their text) and deletes rows past their TTL.
create or replace function public.translation_purge()
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  n int;
begin
  update public.translation_jobs
     set status = 'expired', request = '{}'::jsonb, result = null, claim_token = null,
         lease_expires_at = null, finished_at = now(), error = coalesce(error, 'deadline passed')
   where status in ('queued', 'running') and deadline_at <= now();
  delete from public.translation_jobs where purge_after <= now();
  get diagnostics n = row_count;
  delete from public.translation_workers where heartbeat_at < now() - interval '1 day';
  return n;
end $$;

-- Returns the job id, or null when p_require_worker_seconds is given and no worker
-- has sent a heartbeat that recently (the bot then falls back to cloud at once).
create or replace function public.translation_enqueue(
  p_queue text,
  p_request jsonb,
  p_deadline_seconds int default 30,
  p_require_worker_seconds int default null,
  p_retention_seconds int default 600
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_queue is null or p_queue !~ '^[a-z0-9][a-z0-9_-]{0,63}$' then
    raise exception 'invalid queue name';
  end if;
  if p_deadline_seconds is null or p_deadline_seconds not between 1 and 600 then
    raise exception 'deadline must be 1-600 seconds';
  end if;
  if p_retention_seconds is null or p_retention_seconds not between 0 and 3600 then
    raise exception 'retention must be 0-3600 seconds';
  end if;
  if p_request is null or jsonb_typeof(p_request) <> 'object' or octet_length(p_request::text) > 262144 then
    raise exception 'request must be a JSON object under 256 KiB';
  end if;

  perform public.translation_purge();

  if p_require_worker_seconds is not null and not exists (
    select 1 from public.translation_workers w
    where w.queue = p_queue and w.heartbeat_at > now() - make_interval(secs => p_require_worker_seconds)
  ) then
    return null;
  end if;

  insert into public.translation_jobs (queue, request, deadline_at, purge_after)
  values (
    p_queue, p_request,
    now() + make_interval(secs => p_deadline_seconds),
    now() + make_interval(secs => p_deadline_seconds + p_retention_seconds)
  )
  returning id into v_id;
  return v_id;
end $$;

-- Atomically hands the oldest live job to one worker. FOR UPDATE SKIP LOCKED means
-- concurrent claimers never get the same row and never block each other. Jobs past
-- their deadline are expired here, never handed out. A running job whose lease has
-- lapsed (worker died) can be re-claimed, up to 3 attempts, under a new claim_token
-- so the old holder can no longer complete it.
create or replace function public.translation_claim(
  p_queue text,
  p_worker_id text,
  p_lease_seconds int default 60
)
returns table (job_id uuid, job_request jsonb, job_remaining_ms bigint, job_claim_token uuid, job_attempts int)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_queue is null or p_queue !~ '^[a-z0-9][a-z0-9_-]{0,63}$' then
    raise exception 'invalid queue name';
  end if;
  if p_worker_id is null or length(p_worker_id) not between 1 and 128 then
    raise exception 'invalid worker id';
  end if;
  if p_lease_seconds is null or p_lease_seconds not between 5 and 600 then
    raise exception 'lease must be 5-600 seconds';
  end if;

  update public.translation_jobs
     set status = 'expired', request = '{}'::jsonb, result = null, claim_token = null,
         lease_expires_at = null, finished_at = now(), error = coalesce(error, 'deadline passed')
   where queue = p_queue and status in ('queued', 'running') and deadline_at <= now();

  update public.translation_jobs
     set status = 'failed', request = '{}'::jsonb, claim_token = null, lease_expires_at = null,
         finished_at = now(), error = 'attempts exceeded'
   where queue = p_queue and status = 'running' and lease_expires_at <= now() and attempts >= 3;

  select j.id into v_id
    from public.translation_jobs j
   where j.queue = p_queue
     and j.deadline_at > now()
     and (j.status = 'queued' or (j.status = 'running' and j.lease_expires_at <= now() and j.attempts < 3))
   order by j.created_at
   for update skip locked
   limit 1;
  if v_id is null then
    return;
  end if;

  return query
    update public.translation_jobs j
       set status = 'running', attempts = j.attempts + 1, claim_token = gen_random_uuid(),
           claimed_by = p_worker_id, claimed_at = now(),
           lease_expires_at = now() + make_interval(secs => p_lease_seconds)
     where j.id = v_id
    returning j.id, j.request, (extract(epoch from (j.deadline_at - now())) * 1000)::bigint,
              j.claim_token, j.attempts;
end $$;

-- Extends the lease. False means the claim is gone (cancelled, expired, taken by
-- another worker): the holder must stop generating.
create or replace function public.translation_renew(p_job_id uuid, p_claim_token uuid, p_lease_seconds int default 60)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_lease_seconds is null or p_lease_seconds not between 5 and 600 then
    raise exception 'lease must be 5-600 seconds';
  end if;
  update public.translation_jobs
     set lease_expires_at = now() + make_interval(secs => p_lease_seconds)
   where id = p_job_id and claim_token = p_claim_token and status = 'running' and deadline_at > now();
  return found;
end $$;

-- Stores the result. Rejected (false) unless the caller still holds the claim, the
-- job is still running and its deadline has not passed, so a late result after a
-- cancel or expiry is dropped and cannot be picked up by anyone.
create or replace function public.translation_complete(p_job_id uuid, p_claim_token uuid, p_result jsonb)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_result is null or jsonb_typeof(p_result) <> 'object' or octet_length(p_result::text) > 262144 then
    raise exception 'result must be a JSON object under 256 KiB';
  end if;
  update public.translation_jobs
     set status = 'succeeded', result = p_result, request = '{}'::jsonb, claim_token = null,
         lease_expires_at = null, finished_at = now()
   where id = p_job_id and claim_token = p_claim_token and status = 'running' and deadline_at > now();
  return found;
end $$;

-- Reports a worker-side failure so the bot can fall back immediately.
create or replace function public.translation_fail(p_job_id uuid, p_claim_token uuid, p_error text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.translation_jobs
     set status = 'failed', error = left(coalesce(p_error, 'failed'), 500), request = '{}'::jsonb,
         claim_token = null, lease_expires_at = null, finished_at = now()
   where id = p_job_id and claim_token = p_claim_token and status = 'running';
  return found;
end $$;

-- Bot-side cancel (provider timeout or abort). False when the job was already
-- final; the caller then reads it with translation_get.
create or replace function public.translation_cancel(p_job_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.translation_jobs
     set status = 'cancelled', request = '{}'::jsonb, result = null, claim_token = null,
         lease_expires_at = null, finished_at = now()
   where id = p_job_id and status in ('queued', 'running');
  return found;
end $$;

-- Current state of a job. A live job past its deadline reads as expired. With
-- p_consume, a final job is deleted as it is read, so nothing lingers. No row
-- means the job is gone (consumed or purged).
create or replace function public.translation_get(p_job_id uuid, p_consume boolean default false)
returns table (job_status text, job_result jsonb, job_error text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_result jsonb;
  v_error text;
begin
  select case when j.status in ('queued', 'running') and j.deadline_at <= now() then 'expired' else j.status end,
         j.result, j.error
    into v_status, v_result, v_error
    from public.translation_jobs j
   where j.id = p_job_id;
  if not found then
    return;
  end if;
  if p_consume and v_status not in ('queued', 'running') then
    delete from public.translation_jobs where id = p_job_id;
  end if;
  return query select v_status, v_result, v_error;
end $$;

create or replace function public.translation_heartbeat(p_queue text, p_worker_id text, p_info jsonb default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_queue is null or p_queue !~ '^[a-z0-9][a-z0-9_-]{0,63}$' then
    raise exception 'invalid queue name';
  end if;
  if p_worker_id is null or length(p_worker_id) not between 1 and 128 then
    raise exception 'invalid worker id';
  end if;
  insert into public.translation_workers (queue, worker_id, heartbeat_at, info)
  values (p_queue, p_worker_id, now(), p_info)
  on conflict (queue, worker_id) do update set heartbeat_at = now(), info = excluded.info;
end $$;

create or replace function public.translation_worker_stop(p_queue text, p_worker_id text)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.translation_workers where queue = p_queue and worker_id = p_worker_id;
$$;

create or replace function public.translation_worker_alive(p_queue text, p_max_age_seconds int default 15)
returns boolean
language sql
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.translation_workers w
    where w.queue = p_queue and w.heartbeat_at > now() - make_interval(secs => p_max_age_seconds)
  );
$$;

revoke all on function public.translation_purge() from public, anon, authenticated;
revoke all on function public.translation_enqueue(text, jsonb, int, int, int) from public, anon, authenticated;
revoke all on function public.translation_claim(text, text, int) from public, anon, authenticated;
revoke all on function public.translation_renew(uuid, uuid, int) from public, anon, authenticated;
revoke all on function public.translation_complete(uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.translation_fail(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.translation_cancel(uuid) from public, anon, authenticated;
revoke all on function public.translation_get(uuid, boolean) from public, anon, authenticated;
revoke all on function public.translation_heartbeat(text, text, jsonb) from public, anon, authenticated;
revoke all on function public.translation_worker_stop(text, text) from public, anon, authenticated;
revoke all on function public.translation_worker_alive(text, int) from public, anon, authenticated;

grant execute on function public.translation_purge() to service_role;
grant execute on function public.translation_enqueue(text, jsonb, int, int, int) to service_role;
grant execute on function public.translation_claim(text, text, int) to service_role;
grant execute on function public.translation_renew(uuid, uuid, int) to service_role;
grant execute on function public.translation_complete(uuid, uuid, jsonb) to service_role;
grant execute on function public.translation_fail(uuid, uuid, text) to service_role;
grant execute on function public.translation_cancel(uuid) to service_role;
grant execute on function public.translation_get(uuid, boolean) to service_role;
grant execute on function public.translation_heartbeat(text, text, jsonb) to service_role;
grant execute on function public.translation_worker_stop(text, text) to service_role;
grant execute on function public.translation_worker_alive(text, int) to service_role;
