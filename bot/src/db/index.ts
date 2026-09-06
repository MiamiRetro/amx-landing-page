import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config, type Lang } from "../config.js";

export interface GroupMember {
  channel_id: string;
  group_id: string;
  lang: Lang;
  webhook_id: string | null;
  webhook_token: string | null;
  last_seen_message_id: string | null;
}

export interface Group {
  id: string;
  guild_id: string;
  name: string;
  paused: boolean;
  members: GroupMember[];
}

export interface MapRow {
  source_message_id: string;
  source_channel_id: string;
  target_channel_id: string;
  mirror_message_id: string;
  lang: Lang;
}

function unwrap<T>(r: { data: T | null; error: { message: string } | null }, what: string): T {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data as T;
}

export class Db {
  readonly sb: SupabaseClient;

  constructor(sb?: SupabaseClient) {
    this.sb = sb ?? createClient(config.supabaseUrl(), config.supabaseServiceKey(), { auth: { persistSession: false } });
  }

  async loadGroups(guildId: string): Promise<Group[]> {
    const groups = unwrap(await this.sb.from("channel_groups").select("*").eq("guild_id", guildId), "load groups") as Omit<Group, "members">[];
    if (groups.length === 0) return [];
    const members = unwrap(
      await this.sb.from("channel_group_members").select("*").in("group_id", groups.map((g) => g.id)),
      "load group members",
    ) as GroupMember[];
    return groups.map((g) => ({ ...g, members: members.filter((m) => m.group_id === g.id) }));
  }

  async createGroup(guildId: string, name: string): Promise<string> {
    const row = unwrap(await this.sb.from("channel_groups").insert({ guild_id: guildId, name }).select("id").single(), "create group") as { id: string };
    return row.id;
  }

  async findGroupByName(guildId: string, name: string): Promise<string | null> {
    const r = await this.sb.from("channel_groups").select("id").eq("guild_id", guildId).eq("name", name).maybeSingle();
    if (r.error) throw new Error(`find group: ${r.error.message}`);
    return r.data?.id ?? null;
  }

  async upsertMember(m: Omit<GroupMember, "last_seen_message_id"> & { last_seen_message_id?: string | null }) {
    unwrap(await this.sb.from("channel_group_members").upsert(m, { onConflict: "channel_id" }), "upsert member");
  }

  async removeMember(channelId: string) {
    unwrap(await this.sb.from("channel_group_members").delete().eq("channel_id", channelId), "remove member");
  }

  async setPaused(groupId: string | null, guildId: string, paused: boolean) {
    const q = this.sb.from("channel_groups").update({ paused }).eq("guild_id", guildId);
    unwrap(await (groupId ? q.eq("id", groupId) : q), "set paused");
  }

  async setLastSeen(channelId: string, messageId: string) {
    unwrap(await this.sb.from("channel_group_members").update({ last_seen_message_id: messageId }).eq("channel_id", channelId), "set last seen");
  }

  async insertMap(rows: MapRow[]) {
    if (rows.length === 0) return;
    unwrap(await this.sb.from("message_map").upsert(rows, { onConflict: "source_message_id,target_channel_id" }), "insert map");
  }

  /** All mirrors of a source message. */
  async mirrorsOf(sourceMessageId: string): Promise<MapRow[]> {
    return unwrap(await this.sb.from("message_map").select("*").eq("source_message_id", sourceMessageId), "mirrors of") as MapRow[];
  }

  /** The source row for a mirror message, if the id is a mirror. */
  async sourceOf(mirrorMessageId: string): Promise<MapRow | null> {
    const r = await this.sb.from("message_map").select("*").eq("mirror_message_id", mirrorMessageId).maybeSingle();
    if (r.error) throw new Error(`source of: ${r.error.message}`);
    return (r.data as MapRow | null) ?? null;
  }

  async deleteMap(sourceMessageId: string) {
    unwrap(await this.sb.from("message_map").delete().eq("source_message_id", sourceMessageId), "delete map");
  }

  async cacheGet(hashes: string[], lang: Lang): Promise<Map<string, string>> {
    if (hashes.length === 0) return new Map();
    const rows = unwrap(await this.sb.from("translation_cache").select("hash,text").eq("lang", lang).in("hash", hashes), "cache get") as { hash: string; text: string }[];
    return new Map(rows.map((r) => [r.hash, r.text]));
  }

  async cachePut(rows: { hash: string; lang: Lang; text: string; provider: string }[]) {
    if (rows.length === 0) return;
    unwrap(await this.sb.from("translation_cache").upsert(rows, { onConflict: "hash,lang" }), "cache put");
  }

  async glossary(guildId: string): Promise<{ term: string; note: string | null }[]> {
    return unwrap(await this.sb.from("glossary").select("term,note").eq("guild_id", guildId).order("term"), "glossary") as { term: string; note: string | null }[];
  }

  async glossaryAdd(guildId: string, term: string, note: string | null) {
    unwrap(await this.sb.from("glossary").upsert({ guild_id: guildId, term, note }, { onConflict: "guild_id,term" }), "glossary add");
  }

  async glossaryRemove(guildId: string, term: string) {
    unwrap(await this.sb.from("glossary").delete().eq("guild_id", guildId).eq("term", term), "glossary remove");
  }

  async getSetting(guildId: string, key: string): Promise<string | null> {
    const r = await this.sb.from("settings").select("value").eq("guild_id", guildId).eq("key", key).maybeSingle();
    if (r.error) throw new Error(`get setting: ${r.error.message}`);
    return r.data?.value ?? null;
  }

  async setSetting(guildId: string, key: string, value: string) {
    unwrap(await this.sb.from("settings").upsert({ guild_id: guildId, key, value }, { onConflict: "guild_id,key" }), "set setting");
  }

  async logUsage(row: { provider: string; input_tokens: number; cached_tokens: number; output_tokens: number; segments: number; ms: number; ok: boolean }) {
    const r = await this.sb.from("usage_log").insert(row);
    if (r.error) console.error("usage log failed:", r.error.message);
  }

  async usageToday(): Promise<{ requests: number; input: number; cached: number; output: number }> {
    const since = new Date(Date.now() - 86_400_000).toISOString();
    const rows = unwrap(await this.sb.from("usage_log").select("input_tokens,cached_tokens,output_tokens").gte("at", since), "usage today") as { input_tokens: number; cached_tokens: number; output_tokens: number }[];
    return rows.reduce(
      (a, r) => ({ requests: a.requests + 1, input: a.input + r.input_tokens, cached: a.cached + r.cached_tokens, output: a.output + r.output_tokens }),
      { requests: 0, input: 0, cached: 0, output: 0 },
    );
  }
}
