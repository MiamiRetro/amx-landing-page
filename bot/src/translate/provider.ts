import type { Lang } from "../config.js";

export interface TranslateRequest {
  /** Tokenized segments (placeholders already applied). Each is translated independently but in one call. */
  segments: string[];
  sourceLang: Lang;
  targets: Lang[];
  /** Terms that must be left untranslated. */
  glossary: { term: string; note: string | null }[];
  /** Optional: the last few messages in the conversation, for context. Not translated. */
  context?: string[];
}

export interface TranslateResult {
  /** target lang → translated segments, same length/order as request.segments */
  translations: Partial<Record<Lang, string[]>>;
  /**
   * Input token counts are disjoint — total input volume is
   * inputTokens + cachedTokens + cacheCreationTokens — because each bills at a
   * different rate: fresh input at 1x, a cache write at 1.25x, a cache read at 0.1x.
   * Providers whose API reports cached tokens as part of one combined prompt total
   * must subtract them so the three stay disjoint here.
   */
  usage: { inputTokens: number; cachedTokens: number; cacheCreationTokens: number; outputTokens: number };
}

export interface TranslateOptions {
  /** Aborted when the caller gives up (timeout); providers holding remote work should cancel it. */
  signal?: AbortSignal;
}

export interface TranslationProvider {
  /** Stable id used in caches and logs, e.g. "anthropic:claude-sonnet-5". */
  readonly id: string;
  /**
   * Calls the Translator may make to this provider per request before moving to
   * the next one. Defaults to 2 (one retry). A provider whose single call can
   * already wait a long time sets 1 so the retry loop cannot double the wait.
   */
  readonly maxAttempts?: number;
  translate(req: TranslateRequest, opts?: TranslateOptions): Promise<TranslateResult>;
}
