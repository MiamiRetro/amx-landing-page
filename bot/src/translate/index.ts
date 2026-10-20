import { createHash } from "node:crypto";
import type { Lang } from "../config.js";
import type { Db } from "../db/index.js";
import { log, errInfo } from "../log.js";
import { placeholdersIntact } from "../mirror/placeholders.js";
import { AnthropicProvider } from "./anthropic.js";
import { FallbackAlerter } from "./fallbackAlert.js";
import { OpenAICompatibleProvider, PRESETS } from "./openai-compatible.js";
import type { TranslateRequest, TranslateResult, TranslationProvider } from "./provider.js";

/**
 * Parses a provider spec:
 *   anthropic:claude-sonnet-5
 *   openai:gpt-5.6-terra
 *   gemini:gemini-3.7-flash
 *   openrouter:tencent/hy-mt2-7b
 */
/** Passes text through untranslated. For pipeline testing without an API key. Never cached. */
export class NoneProvider implements TranslationProvider {
  readonly id = "none";
  async translate(req: TranslateRequest): Promise<TranslateResult> {
    const translations: Partial<Record<Lang, string[]>> = {};
    for (const t of req.targets) translations[t] = req.segments.slice();
    return { translations, usage: { inputTokens: 0, cachedTokens: 0, cacheCreationTokens: 0, outputTokens: 0 } };
  }
}

export function providerFromSpec(spec: string): TranslationProvider {
  if (spec === "none") return new NoneProvider();
  const i = spec.indexOf(":");
  const vendor = i < 0 ? spec : spec.slice(0, i);
  const model = i < 0 ? "" : spec.slice(i + 1);
  if (vendor === "anthropic") return new AnthropicProvider(model || undefined);
  const preset = PRESETS[vendor];
  if (!preset) throw new Error(`Unknown translation vendor "${vendor}" in "${spec}"`);
  const apiKey = process.env[preset.keyEnv];
  if (!apiKey) throw new Error(`${preset.keyEnv} is required for provider ${spec}`);
  if (!model) throw new Error(`Provider ${spec} needs a model after the colon`);
  return new OpenAICompatibleProvider({ vendor, model, baseUrl: preset.baseUrl, apiKey, jsonMode: preset.jsonMode, extraHeaders: preset.extraHeaders });
}

export function segmentHash(text: string, sourceLang: Lang): string {
  return createHash("sha256").update(`${sourceLang}\u0000${text.trim()}`).digest("hex").slice(0, 32);
}

export interface TranslatorOptions {
  primary: TranslationProvider;
  fallbacks?: TranslationProvider[];
  db?: Db;
  /** Wraps each provider call; the mirror passes a concurrency limiter. */
  limiter?: <T>(fn: () => Promise<T>) => Promise<T>;
  timeoutMs?: number;
}

/**
 * Cache-aware translation with placeholder validation, one retry, and
 * provider fallback. Returns translations for every requested target;
 * segments that could not be translated come back as the source text so the
 * mirror can still post something.
 */
export class Translator {
  private alerter = new FallbackAlerter();
  constructor(private o: TranslatorOptions) {}

  get providerId() {
    return this.o.primary.id;
  }

  async translate(
    segments: string[],
    entities: string[][],
    sourceLang: Lang,
    targets: Lang[],
    glossary: { term: string; note: string | null }[],
    context?: string[],
  ): Promise<{ translations: Record<Lang, string[]>; translated: boolean }> {
    const result = {} as Record<Lang, string[]>;
    for (const t of targets) result[t] = segments.slice();
    if (targets.length === 0 || segments.length === 0) return { translations: result, translated: true };

    // cache lookup per target
    const hashes = segments.map((s) => segmentHash(s, sourceLang));
    const missing = new Map<Lang, Set<number>>();
    for (const t of targets) {
      const hits = this.o.db ? await this.o.db.cacheGet(hashes, t).catch(() => new Map<string, string>()) : new Map<string, string>();
      const miss = new Set<number>();
      segments.forEach((_s, i) => {
        const hit = hits.get(hashes[i]);
        if (hit !== undefined) result[t][i] = hit;
        else miss.add(i);
      });
      if (miss.size) missing.set(t, miss);
    }
    if (missing.size === 0) return { translations: result, translated: true };

    // one request covering the union of missing segments for all missing targets
    const idx = [...new Set([...missing.values()].flatMap((s) => [...s]))].sort((a, b) => a - b);
    const req: TranslateRequest = {
      segments: idx.map((i) => segments[i]),
      sourceLang,
      targets: [...missing.keys()],
      glossary,
      context,
    };

    const out = await this.callWithFallback(req, idx.map((i) => entities[i]));
    if (!out) return { translations: result, translated: false };

    const cacheRows: { hash: string; lang: Lang; text: string; provider: string }[] = [];
    for (const t of req.targets) {
      const arr = out.result.translations[t]!;
      idx.forEach((orig, k) => {
        if (!missing.get(t)?.has(orig)) return;
        result[t][orig] = arr[k];
        cacheRows.push({ hash: hashes[orig], lang: t, text: arr[k], provider: out.provider });
      });
    }
    if (this.o.db && out.provider !== "none") await this.o.db.cachePut(cacheRows).catch((e) => log.warn("cache put failed", errInfo(e)));
    return { translations: result, translated: true };
  }

  private async callWithFallback(req: TranslateRequest, entities: string[][]): Promise<{ result: TranslateResult; provider: string } | null> {
    const providers = [this.o.primary, ...(this.o.fallbacks ?? [])];
    let primaryError = "";
    for (const p of providers) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const started = Date.now();
        try {
          const result = await this.withTimeout(this.o.limiter ? this.o.limiter(() => p.translate(req)) : p.translate(req));
          const bad = this.validate(result, req, entities);
          await this.o.db?.logUsage({
            provider: p.id,
            input_tokens: result.usage.inputTokens,
            cached_tokens: result.usage.cachedTokens,
            cache_creation_tokens: result.usage.cacheCreationTokens,
            output_tokens: result.usage.outputTokens,
            segments: req.segments.length,
            ms: Date.now() - started,
            ok: bad.length === 0,
          });
          if (bad.length === 0) {
            if (p === this.o.primary) this.alerter.primaryOk(p.id);
            else this.alerter.fellBack(this.o.primary.id, p.id, primaryError || "unknown error", req.targets);
            return { result, provider: p.id };
          }
          if (p === this.o.primary) primaryError = `placeholders damaged: ${bad.join(", ")}`;
          log.warn("placeholders damaged, retrying", { provider: p.id, attempt, bad });
        } catch (err) {
          if (p === this.o.primary) primaryError = String((err as Error)?.message ?? err).slice(0, 160);
          log.warn("translation call failed", { provider: p.id, attempt, ...errInfo(err) });
          await this.o.db?.logUsage({ provider: p.id, input_tokens: 0, cached_tokens: 0, cache_creation_tokens: 0, output_tokens: 0, segments: req.segments.length, ms: Date.now() - started, ok: false });
        }
      }
    }
    log.error("all translation providers failed", { segments: req.segments.length });
    return null;
  }

  /** Returns "lang[i]" labels for segments whose placeholders were lost or duplicated. */
  private validate(result: TranslateResult, req: TranslateRequest, entities: string[][]): string[] {
    const bad: string[] = [];
    for (const t of req.targets) {
      const arr = result.translations[t];
      if (!arr) {
        bad.push(`${t}:missing`);
        continue;
      }
      arr.forEach((s, i) => {
        if (!placeholdersIntact(s, entities[i])) bad.push(`${t}[${i}]`);
      });
    }
    return bad;
  }

  private withTimeout<T>(p: Promise<T>): Promise<T> {
    const ms = this.o.timeoutMs ?? 60_000;
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`translation timed out after ${ms}ms`)), ms);
      p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
    });
  }
}
