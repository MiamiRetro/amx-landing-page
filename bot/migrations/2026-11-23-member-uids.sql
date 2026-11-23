-- Several exchange UIDs per member ---------------------------------------------
-- `verifications` keeps one row per Discord account (the UID that let them in).
-- `member_uids` holds every UID a member has linked, that one included, so the
-- VIP tracker and competitions can total commission across all of them.
--
-- Triggers keep member_uids in step with verifications, so a bot build that only
-- knows `verifications` (or a row written by hand) still shows up here.
-- Additive and idempotent: safe to run while the old bot is live.

create table if not exists member_uids (
  exchange text not null check (exchange in ('bitget','blofin','bybit')),
  uid text not null,
  guild_id text not null,
  discord_user_id text not null,
  detail jsonb,
  added_at timestamptz not null default now(),
  -- A UID belongs to exactly one member, whichever server they verified in.
  primary key (exchange, uid)
);
create index if not exists member_uids_user_idx on member_uids (guild_id, discord_user_id);
alter table member_uids enable row level security;

insert into member_uids (exchange, uid, guild_id, discord_user_id, detail, added_at)
select exchange, uid, guild_id, discord_user_id, detail, verified_at from verifications
on conflict (exchange, uid) do nothing;

create or replace function member_uids_sync() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    -- The old primary UID goes only if it was this member's.
    delete from member_uids
     where exchange = old.exchange and uid = old.uid
       and guild_id = old.guild_id and discord_user_id = old.discord_user_id
       and (tg_op = 'DELETE' or old.exchange <> new.exchange or old.uid <> new.uid);
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    insert into member_uids (exchange, uid, guild_id, discord_user_id, detail, added_at)
    values (new.exchange, new.uid, new.guild_id, new.discord_user_id, new.detail, new.verified_at)
    on conflict (exchange, uid) do update
      set guild_id = excluded.guild_id, discord_user_id = excluded.discord_user_id, detail = excluded.detail;
    return new;
  end if;
  return old;
end $$;

drop trigger if exists verifications_member_uids on verifications;
create trigger verifications_member_uids
  after insert or update or delete on verifications
  for each row execute function member_uids_sync();

revoke all on function member_uids_sync() from public, anon, authenticated;
