import type { Lang } from "../config.js";
import { SYSTEM_PROMPT, buildUserPrompt } from "./prompt.js";
import type { TranslateRequest, TranslateResult, TranslationProvider } from "./provider.js";

/**
 * Adapter for any chat-completions endpoint: OpenAI, Gemini's OpenAI-compatible
 * endpoint, OpenRouter (Hy-MT2, DeepSeek, Gemma, ...). Used for the bake-off
 * and as a fallback provider. Uses fetch so no extra SDK is needed.
 */
export interface OpenAICompatibleOptions {
  /** Short vendor label for ids/logs, e.g. "openai", "gemini", "openrouter". */
  vendor: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  /** Whether the endpoint accepts response_format json_object. Default true. */
  jsonMode?: boolean;
  extraHeaders?: Record<string, string>;
  fetchImpl?: typeof fetch;
}

export const PRESETS: Record<string, { baseUrl: string; keyEnv: string; jsonMode: boolean; extraHeaders?: Record<string, string> }> = {
  openai: { baseUrl: "https://api.openai.com/v1", keyEnv: "OPENAI_API_KEY", jsonMode: true },
  gemini: { baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", keyEnv: "GEMINI_API_KEY", jsonMode: true },
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    keyEnv: "OPENROUTER_API_KEY",
    jsonMode: false,
    extraHeaders: { "HTTP-Referer": "https://alphanumetrix.com", "X-Title": "AMX mirror bot" },
  },
};

export class OpenAICompatibleProvider implements TranslationProvider {
  readonly id: string;
  private f: typeof fetch;

  constructor(private opts: OpenAICompatibleOptions) {
    this.id = `${opts.vendor}:${opts.model}`;
    this.f = opts.fetchImpl ?? fetch;
  }

  async translate(req: TranslateRequest): Promise<TranslateResult> {
    const body: Record<string, unknown> = {
      model: this.opts.model,
      temperature: 0.2,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserPrompt(req) },
      ],
    };
    if (this.opts.jsonMode !== false) body.response_format = { type: "json_object" };

    const res = await this.f(`${this.opts.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.opts.apiKey}`,
        ...(this.opts.extraHeaders ?? {}),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`${this.id} HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
    };
    const content = data.choices?.[0]?.message?.content ?? "";
    const parsed = extractJson(content);

    const translations: Partial<Record<Lang, string[]>> = {};
    for (const t of req.targets) {
      const arr = parsed[t];
      if (!Array.isArray(arr) || arr.length !== req.segments.length || !arr.every((s) => typeof s === "string")) {
        throw new Error(`${this.id}: translation for ${t} malformed`);
      }
      translations[t] = arr as string[];
    }
    return {
      translations,
      usage: {
        inputTokens: data.usage?.prompt_tokens ?? 0,
        cachedTokens: data.usage?.prompt_tokens_details?.cached_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
      },
    };
  }
}

/** Tolerates code fences and leading prose around the JSON object. */
export function extractJson(text: string): Record<string, unknown> {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("no JSON object in response");
  return JSON.parse(candidate.slice(start, end + 1)) as Record<string, unknown>;
}
