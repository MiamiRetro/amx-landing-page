import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Lang } from "../config.js";

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "assets");
const DIR = join(ASSETS, "support", "guides");

/**
 * Infographics the assistant can attach to an answer. FAQ entries name them on a
 * "Guide:" line. Rendered by assets/support/guides/render.mjs, except uid, which
 * is the verify panel's existing UID guide.
 */
export const GUIDES = ["discord-mobile", "discord-desktop", "help-thread", "verify", "uid", "channel-map", "scams"] as const;
export type GuideKey = (typeof GUIDES)[number];

/** Images per answer, so a reply never turns into a wall of pictures. */
export const MAX_GUIDES = 2;

/** The card in the member's language when one was rendered (guides/<lang>/), English otherwise. */
export function guideFile(key: GuideKey, lang: Lang): string {
  if (key === "uid") return join(ASSETS, "verify", "uid-guide.png");
  const own = join(DIR, lang, `${key}.png`);
  return lang !== "en" && existsSync(own) ? own : join(DIR, `${key}.png`);
}
