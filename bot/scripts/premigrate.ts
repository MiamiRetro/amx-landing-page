/**
 * Gets a server ready for the onboarding migration, before scripts/onboarding.ts runs:
 *
 *   1. checks the bot's permissions and role position, the verified role, and
 *      who holds the old language roles
 *   2. creates the 20 language roles and 6 notification roles if missing
 *      (no permissions, nobody holds them yet, so nothing changes for members)
 *   3. deletes the test channels and roles listed in a plan file
 *
 *   npx tsx scripts/premigrate.ts                                   # dry run: checks and plan only
 *   npx tsx scripts/premigrate.ts --plan premigrate-plan.json       # dry run including deletions
 *   npx tsx scripts/premigrate.ts --plan premigrate-plan.json --backup backups/<dir> --apply
 *
 * Plan file: { "deleteChannels": ["<id>", ...], "deleteRoles": ["<id>", ...] }
 * Ids, not names, so nothing is deleted by a lookalike name.
 *
 * Deleting is refused unless --backup points at a scripts/backup.ts folder
 * that holds a message export (messages/<id>.jsonl) for every channel in the
 * plan, since Discord keeps no copy of a deleted channel.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ChannelType, PermissionFlagsBits as P } from "discord.js";
import { LANGS } from "../src/config.js";
import { connect } from "../src/lib/client.js";
import { NOTIFY_ROLES, NOTIFY_TOPICS } from "../src/notify.js";
import { LANG_ROLE_NAMES } from "../src/roles.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : undefined;
}

const log = (s: string) => console.log(s);

async function main() {
  const apply = process.argv.includes("--apply");
  const planFile = arg("plan");
  const backup = arg("backup");
  const plan: { deleteChannels?: string[]; deleteRoles?: string[] } = planFile ? JSON.parse(readFileSync(planFile, "utf8")) : {};
  const { client, guild } = await connect();
  let problems = 0;
  const warn = (s: string) => { problems++; log(`  ! ${s}`); };
  try {
    log(`${apply ? "APPLYING" : "DRY RUN (add --apply to make these changes)"} on ${guild.name} (${guild.id})`);
    const members = await guild.members.fetch();
    const me = guild.members.me ?? (await guild.members.fetchMe());
    const top = me.roles.highest;

    log(`\n== checks`);
    for (const [flag, name] of [[P.ManageRoles, "Manage Roles"], [P.ManageChannels, "Manage Channels"]] as const) {
      if (me.permissions.has(flag)) log(`  bot has ${name}`);
      else warn(`bot lacks ${name}: grant it for the migration, remove it after`);
    }
    if (me.permissions.has(P.Administrator)) warn("bot has Administrator; the security baseline says it shouldn't");
    log(`  bot's top role: ${top.name} (position ${top.position} of ${guild.roles.cache.size - 1})`);

    const verified = guild.roles.cache.filter((r) => ["member", "members"].includes(r.name.toLowerCase()));
    if (verified.size === 0) warn(`no role named "Member" or "Members": the migration would treat every verified member as unverified`);
    for (const r of verified.values()) log(`  verified role "${r.name}": ${members.filter((m) => m.roles.cache.has(r.id)).size} members`);
    const humans = members.filter((m) => !m.user.bot);
    log(`  ${humans.size} people, ${members.size - humans.size} bots`);
    for (const lang of ["zh", "ko", "id"] as const) {
      const names = Object.values(LANG_ROLE_NAMES[lang]);
      for (const r of guild.roles.cache.filter((x) => names.includes(x.name)).values()) log(`  ${r.name}: ${members.filter((m) => m.roles.cache.has(r.id)).size} members`);
    }
    const admins = guild.roles.cache.filter((r) => r.permissions.has(P.Administrator) && !r.managed);
    log(`  roles with Administrator: ${admins.map((r) => r.name).join(", ") || "(none)"}`);
    if (guild.roles.everyone.permissions.has(P.MentionEveryone)) warn("@everyone can mention @everyone");
    const dupes = [...guild.roles.cache.values()].filter((r, _, all) => all.filter((x) => x.name === r.name).length > 1);
    if (dupes.length) warn(`roles sharing a name (the migration finds roles by name): ${[...new Set(dupes.map((r) => r.name))].join(", ")}`);

    log(`\n== roles`);
    const wanted = [
      ...LANGS.flatMap((l) => [LANG_ROLE_NAMES[l].base, LANG_ROLE_NAMES[l].member]),
      ...NOTIFY_TOPICS.map((t) => NOTIFY_ROLES[t].name),
    ];
    for (const name of wanted) {
      const role = guild.roles.cache.find((r) => r.name === name);
      if (role) {
        if (role.position >= top.position) warn(`${name} sits above the bot's role, so the bot can't hand it out: drag ${top.name} above it`);
        else log(`  ok ${name}`);
        continue;
      }
      log(`  create ${name}`);
      if (apply) await guild.roles.create({ name, mentionable: false, permissions: [], reason: "pre-migration: language and notification roles" });
    }

    log(`\n== cleanup`);
    const delChannels = (plan.deleteChannels ?? []).map((id) => ({ id, ch: guild.channels.cache.get(id) }));
    const delRoles = (plan.deleteRoles ?? []).map((id) => ({ id, role: guild.roles.cache.get(id) }));
    if (!delChannels.length && !delRoles.length) log(`  nothing to delete${planFile ? "" : " (no --plan)"}`);
    const missingExport = delChannels.filter(({ id, ch }) => ch && ch.type !== ChannelType.GuildCategory && !(backup && existsSync(join(backup, "messages", `${id}.jsonl`))));
    if (apply && missingExport.length) {
      warn(`no message export for ${missingExport.map(({ ch }) => "#" + ch!.name).join(", ")}: run scripts/backup.ts --messages for them and pass --backup`);
      log(`\nStopped before deleting anything.`);
      return;
    }
    // Children before their categories.
    delChannels.sort((a, b) => Number(a.ch?.type === ChannelType.GuildCategory) - Number(b.ch?.type === ChannelType.GuildCategory));
    for (const { id, ch } of delChannels) {
      if (!ch) { log(`  already gone: channel ${id}`); continue; }
      const kids = ch.type === ChannelType.GuildCategory ? guild.channels.cache.filter((c) => c.parentId === ch.id && !delChannels.some((d) => d.id === c.id)) : null;
      if (kids?.size) { warn(`keep category ${ch.name}: still holds ${kids.map((c) => "#" + c.name).join(", ")}`); continue; }
      log(`  delete ${ch.type === ChannelType.GuildCategory ? "category" : "#"}${ch.name} (${id})`);
      if (apply) await ch.delete("pre-migration cleanup: test channel");
    }
    for (const { id, role } of delRoles) {
      if (!role) { log(`  already gone: role ${id}`); continue; }
      if (role.managed) { warn(`can't delete ${role.name}: it belongs to an integration`); continue; }
      log(`  delete role ${role.name} (${members.filter((m) => m.roles.cache.has(id)).size} members hold it)`);
      if (apply) await role.delete("pre-migration cleanup: test role");
    }
    log(`\n${problems ? `${problems} thing(s) to fix, marked with !` : "No problems found."}`);
  } finally {
    await client.destroy();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });
