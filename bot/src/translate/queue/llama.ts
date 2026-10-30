/**
 * Minimal client for a llama.cpp `llama-server` reached directly (for example
 * http://127.0.0.1:8081): no router, no model switching, text only.
 */
export interface LlamaChatBody {
  messages: { role: "system" | "user"; content: string }[];
  max_tokens: number;
  temperature: number;
  stream: false;
  cache_prompt: boolean;
  chat_template_kwargs: { enable_thinking: false };
  response_format?: { type: "json_object" };
}

export interface LlamaChatResult {
  content: string;
  finishReason: string | null;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  /** Set when the server returned reasoning text despite thinking being disabled. */
  reasoning: string;
}

/**
 * Request body for one translation. Plain string messages only (no images, audio
 * or tools), thinking disabled, non-streaming, hard max_tokens. There is no
 * `model` field: the server we talk to serves exactly one model.
 */
export function buildChatBody(system: string, user: string, maxTokens: number, jsonMode = true): LlamaChatBody {
  return {
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    max_tokens: maxTokens,
    temperature: 0.2,
    stream: false,
    cache_prompt: true,
    chat_template_kwargs: { enable_thinking: false },
    ...(jsonMode ? { response_format: { type: "json_object" as const } } : {}),
  };
}

export interface LlamaClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  jsonMode?: boolean;
}

export class LlamaClient {
  private f: typeof fetch;
  private base: string;

  constructor(private o: LlamaClientOptions) {
    this.f = o.fetchImpl ?? fetch;
    this.base = o.baseUrl.replace(/\/+$/, "");
  }

  /** Token count of `text` as the model's tokenizer sees it (no BOS; template headroom covers framing). */
  async countTokens(text: string, signal?: AbortSignal): Promise<number> {
    const res = await this.f(`${this.base}/tokenize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: text, add_special: false }),
      signal: withTimeout(signal, 5_000),
    });
    if (!res.ok) throw new Error(`llama /tokenize HTTP ${res.status}`);
    const data = (await res.json()) as { tokens?: unknown };
    if (!Array.isArray(data.tokens)) throw new Error("llama /tokenize returned no token list");
    return data.tokens.length;
  }

  async healthy(): Promise<boolean> {
    try {
      const res = await this.f(`${this.base}/health`, { signal: AbortSignal.timeout(2_000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Context window the server was started with (n_ctx), or null when /props does not say. */
  async contextSize(): Promise<number | null> {
    try {
      const res = await this.f(`${this.base}/props`, { signal: AbortSignal.timeout(3_000) });
      if (!res.ok) return null;
      const data = (await res.json()) as { default_generation_settings?: { n_ctx?: number } };
      const n = data.default_generation_settings?.n_ctx;
      return typeof n === "number" && n > 0 ? n : null;
    } catch {
      return null;
    }
  }

  /** Aborting `signal` closes the connection, which makes llama-server stop generating. */
  async chat(system: string, user: string, maxTokens: number, signal: AbortSignal): Promise<LlamaChatResult> {
    const res = await this.f(`${this.base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildChatBody(system, user, maxTokens, this.o.jsonMode ?? true)),
      signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`llama HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string | null; reasoning_content?: string | null }; finish_reason?: string | null }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
    };
    const choice = data.choices?.[0];
    return {
      content: choice?.message?.content ?? "",
      finishReason: choice?.finish_reason ?? null,
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
      cachedTokens: data.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      reasoning: choice?.message?.reasoning_content ?? "",
    };
  }
}

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const t = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, t]) : t;
}
