/**
 * Copies the live server's layout into a test server: the roles channel
 * permissions refer to, then categories and channels with their overwrites,
 * matched by role name. No messages, no members, nothing from tickets or logs.
 *
 *   railway run npx tsx scripts/clone-to-test.ts --to <test guild id>
 *
 * Idempotent: roles and channels that already exist by name are left alone.
 */
import "dotenv/config";

const API = "https://discord.com/api/v10";
const SKIP_CATEGORIES = ["Created Tickets", "Claimed Tickets", "Closed Tickets", "server logs"];
const SKIP_CHANNELS = ["verify-preview", "start-here-preview", "language-test"];
/** Membership roles the onboarding flow reads, created even if no overwrite names them. */
const ALWAYS_ROLES = ["Member", "Members", "New Member", "Muted Member", "中文", "한국어", "Bahasa Indonesia"];

const token = process.env.DISCORD_TOKEN!.trim();
const FROM = process.env.DISCORD_GUILD_ID!;

async function api<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  for (;;) {
    const res = await fetch(API + path, { ...init, headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json", "X-Audit-Log-Reason": "clone live layout for onboarding test", ...init.headers } });
    if (res.status === 429) {
      const wait = Number((await res.json()).retry_after ?? 1);
      await new Promise((r) => setTimeout(r, wait * 1000 + 100));
      continue;
    }
    if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} → ${res.status} ${await res.text()}`);
    return (res.status === 204 ? null : res.json()) as T;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const TO = args[args.indexOf("--to") + 1];
  if (!TO || TO === FROM) throw new Error("--to <test guild id> is required and must not be the live server");
  const me = await api("/users/@me");

  const srcRoles: any[] = await api(`/guilds/${FROM}/roles`);
  const srcChannels: any[] = await api(`/guilds/${FROM}/channels`);
  const skipCatIds = new Set(srcChannels.filter((c) => c.type === 4 && SKIP_CATEGORIES.includes(c.name)).map((c) => c.id));
  const keep = srcChannels.filter((c) => !skipCatIds.has(c.id) && !skipCatIds.has(c.parent_id) && !SKIP_CHANNELS.includes(c.name));

  // Roles: every non-managed role an overwrite on a kept channel names, plus the membership roles.
  const srcRoleById = new Map(srcRoles.map((r) => [r.id, r]));
  const wanted = new Set(ALWAYS_ROLES);
  for (const c of keep) for (const o of c.permission_overwrites ?? []) {
    const r = srcRoleById.get(o.id);
    if (o.type === 0 && r && !r.managed && r.id !== FROM) wanted.add(r.name);
  }
  let dstRoles: any[] = await api(`/guilds/${TO}/roles`);
  for (const name of wanted) {
    if (dstRoles.some((r) => r.name === name)) continue;
    const src = srcRoles.find((r) => r.name === name);
    await api(`/guilds/${TO}/roles`, { method: "POST", body: JSON.stringify({ name, color: src?.color ?? 0, hoist: src?.hoist ?? false, permissions: "0" }) });
    console.log(`role  + ${name}`);
  }
  dstRoles = await api(`/guilds/${TO}/roles`);
  const dstRoleByName = new Map(dstRoles.map((r) => [r.name, r.id]));

  const mapOverwrites = (c: any) =>
    (c.permission_overwrites ?? [])
      .map((o: any) => {
        if (o.type === 1) return o.id === me.id ? o : null; // keep only the bot's own member overwrite
        if (o.id === FROM) return { ...o, id: TO }; // @everyone
        const name = srcRoleById.get(o.id)?.name;
        const id = name && dstRoleByName.get(name);
        return id ? { ...o, id } : null;
      })
      .filter(Boolean);

  const existing: any[] = await api(`/guilds/${TO}/channels`);
  const catIdByName = new Map(existing.filter((c) => c.type === 4).map((c) => [c.name, c.id]));
  for (const cat of keep.filter((c) => c.type === 4).sort((a, b) => a.position - b.position)) {
    if (catIdByName.has(cat.name)) continue;
    const made = await api(`/guilds/${TO}/channels`, { method: "POST", body: JSON.stringify({ name: cat.name, type: 4, permission_overwrites: mapOverwrites(cat) }) });
    catIdByName.set(cat.name, made.id);
    console.log(`cat   + ${cat.name}`);
  }
  const srcCatName = new Map(srcChannels.filter((c) => c.type === 4).map((c) => [c.id, c.name]));
  for (const ch of keep.filter((c) => c.type !== 4).sort((a, b) => a.position - b.position)) {
    const parentName = ch.parent_id ? srcCatName.get(ch.parent_id) : null;
    const parent = parentName ? catIdByName.get(parentName) : undefined;
    if (existing.some((c) => c.name === ch.name && (c.parent_id ?? null) === (parent ?? null))) continue;
    // Announcement channels need Community features the test server may not route the same way; text behaves identically for permissions.
    const type = ch.type === 5 ? 0 : ch.type;
    await api(`/guilds/${TO}/channels`, {
      method: "POST",
      body: JSON.stringify({ name: ch.name, type, topic: [0, 5, 15].includes(ch.type) ? ch.topic ?? undefined : undefined, parent_id: parent, permission_overwrites: mapOverwrites(ch) }),
    });
    console.log(`chan  + ${parentName ? parentName + " / " : ""}#${ch.name}`);
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
