/**
 * Channel manager CLI.
 *
 *   npm run channels -- snapshot [--days 30] [--scan 2000] [--no-activity] [--out snapshots/name]
 *   npm run channels -- roles
 *   npm run channels -- apply layouts/languages.json [--dry-run]
 *
 * `snapshot` writes a markdown report plus a JSON file with the full structure,
 * roles and per-channel activity so the layout can be reviewed before any
 * mirrored channels are created. `apply` creates or updates roles, categories
 * and channels from a layout file and is safe to re-run.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { connect } from "./lib/client.js";
import { renderMarkdown, takeSnapshot } from "./lib/snapshot.js";
import { applyLayout, type Layout } from "./lib/layout.js";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === "help") {
    console.log(readFileSync(new URL(import.meta.url)).toString().split("*/")[0].replace(/^\/\*\*?/, ""));
    return;
  }

  const { client, guild } = await connect();
  try {
    if (cmd === "snapshot") {
      const days = Number(flag(args, "days") ?? 30);
      const scan = Number(flag(args, "scan") ?? 2000);
      const activity = !args.includes("--no-activity");
      const out = flag(args, "out") ?? `snapshots/${guild.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${new Date().toISOString().slice(0, 10)}`;
      console.log(`Snapshot of ${guild.name} (${guild.memberCount} members), ${days}-day window${activity ? "" : ", no activity scan"}`);
      const snap = await takeSnapshot(guild, { windowDays: days, scanLimit: scan, activity, log: console.log });
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(`${out}.json`, JSON.stringify(snap, null, 2));
      writeFileSync(`${out}.md`, renderMarkdown(snap));
      console.log(`\nWrote ${out}.md and ${out}.json`);
    } else if (cmd === "roles") {
      const members = await guild.members.fetch();
      for (const r of [...guild.roles.cache.values()].sort((a, b) => b.position - a.position)) {
        const n = members.filter((m) => m.roles.cache.has(r.id)).size;
        console.log(`${String(n).padStart(6)}  ${r.name}${r.managed ? "  (managed)" : ""}`);
      }
    } else if (cmd === "apply") {
      const file = args.find((a) => !a.startsWith("--"));
      if (!file) throw new Error("apply needs a layout file path");
      const layout = JSON.parse(readFileSync(file, "utf8")) as Layout;
      const dryRun = args.includes("--dry-run");
      const changes = await applyLayout(guild, layout, dryRun);
      if (changes.length === 0) console.log("Nothing to change; server already matches the layout.");
      for (const c of changes) console.log(`${dryRun ? "[dry-run] " : ""}${c.action.padEnd(18)} ${c.target}${c.detail ? `  (${c.detail})` : ""}`);
    } else {
      throw new Error(`Unknown command "${cmd}". Run with "help".`);
    }
  } finally {
    await client.destroy();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
