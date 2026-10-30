import "dotenv/config";

export const LANGS = ["en", "zh", "ko", "id", "es", "ja", "pt", "ru", "tr", "vi"] as const;
export type Lang = (typeof LANGS)[number];

export const LANG_NAMES: Record<Lang, string> = {
  en: "English",
  zh: "Simplified Chinese",
  ko: "Korean",
  id: "Indonesian",
  es: "Spanish",
  ja: "Japanese",
  pt: "Portuguese",
  ru: "Russian",
  tr: "Turkish",
  vi: "Vietnamese",
};

export function isLang(x: string): x is Lang {
  return (LANGS as readonly string[]).includes(x);
}

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing required environment variable ${name}`);
  return v;
}

export const config = {
  discordToken: () => env("DISCORD_TOKEN"),
  guildId: () => env("DISCORD_GUILD_ID"),
  supabaseUrl: () => env("SUPABASE_URL"),
  supabaseServiceKey: () => env("SUPABASE_SERVICE_ROLE_KEY"),
  /** Provider spec, e.g. "anthropic:claude-sonnet-5" or "openai-compatible:gemini:gemini-3.7-flash". */
  translationProvider: () => env("TRANSLATION_PROVIDER", "anthropic:claude-sonnet-5"),
  /** Optional comma-separated fallback providers tried in order when the primary fails. */
  translationFallbacks: () => (process.env.TRANSLATION_FALLBACKS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  /** Seconds to wait for a translation before mirroring the original untranslated. */
  translationTimeoutSec: () => Number(process.env.TRANSLATION_TIMEOUT_SEC ?? 60),
  /** Max concurrent translation requests across all channels. */
  translationConcurrency: () => Number(process.env.TRANSLATION_CONCURRENCY ?? 4),
  /**
   * Environment label that scopes queue names (translate-gemma4-<env>), so test
   * and production never share a queue. Falls back to Railway's environment name.
   */
  translationQueueEnv: () => env("TRANSLATION_QUEUE_ENV", process.env.RAILWAY_ENVIRONMENT_NAME),
  /** Seconds the bot waits for the local worker before cancelling the job and falling back. Keep under translationTimeoutSec. */
  translationQueueDeadlineSec: () => Number(process.env.TRANSLATION_QUEUE_DEADLINE_SEC ?? 20),
  /** A worker heartbeat older than this counts as down and the bot falls back without waiting. */
  translationQueueWorkerTtlSec: () => Number(process.env.TRANSLATION_QUEUE_WORKER_TTL_SEC ?? 15),
  /** Messages to backfill per channel on startup. */
  backfillLimit: () => Number(process.env.BACKFILL_LIMIT ?? 200),
  port: () => Number(process.env.PORT ?? 8080),
  logLevel: () => process.env.LOG_LEVEL ?? "info",
};
