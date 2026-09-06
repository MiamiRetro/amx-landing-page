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
  usage: { inputTokens: number; cachedTokens: number; outputTokens: number };
}

export interface TranslationProvider {
  /** Stable id used in caches and logs, e.g. "anthropic:claude-sonnet-5". */
  readonly id: string;
  translate(req: TranslateRequest): Promise<TranslateResult>;
}
