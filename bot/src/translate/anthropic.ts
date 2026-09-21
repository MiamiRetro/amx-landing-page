import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { Lang } from "../config.js";
import { SYSTEM_PROMPT, buildUserPrompt } from "./prompt.js";
import type { TranslateRequest, TranslateResult, TranslationProvider } from "./provider.js";

/**
 * Claude adapter. One request returns every target language as structured JSON.
 * No prompt caching: at ~18 messages/day the calls are minutes apart, so the
 * 5-minute cache never hits and each write would cost a 25% premium instead.
 */
export class AnthropicProvider implements TranslationProvider {
  readonly id: string;
  private client: Anthropic;

  constructor(private model = "claude-sonnet-5", client?: Anthropic) {
    this.id = `anthropic:${model}`;
    this.client = client ?? new Anthropic();
  }

  async translate(req: TranslateRequest): Promise<TranslateResult> {
    const shape: Record<string, z.ZodArray<z.ZodString>> = {};
    for (const t of req.targets) shape[t] = z.array(z.string());
    const Schema = z.object(shape);

    const isHaiku = /haiku/i.test(this.model);
    const response = await this.client.messages.parse({
      model: this.model,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildUserPrompt(req) }],
      output_config: {
        format: zodOutputFormat(Schema),
        ...(isHaiku ? {} : { effort: "low" as const }),
      },
    });

    if (response.stop_reason === "refusal") {
      throw new Error(`translation refused: ${response.stop_details?.explanation ?? "no explanation"}`);
    }
    const parsed = response.parsed_output;
    if (!parsed) throw new Error("translation response did not parse as JSON");

    const translations: Partial<Record<Lang, string[]>> = {};
    for (const t of req.targets) {
      const arr = parsed[t];
      if (!Array.isArray(arr) || arr.length !== req.segments.length) {
        throw new Error(`translation for ${t} returned ${Array.isArray(arr) ? arr.length : 0} segments, expected ${req.segments.length}`);
      }
      translations[t] = arr;
    }
    const u = response.usage;
    return {
      translations,
      usage: {
        // Cache writes are billed as input (at a premium); count them so cost projections are honest.
        inputTokens: u.input_tokens + (u.cache_creation_input_tokens ?? 0),
        cachedTokens: u.cache_read_input_tokens ?? 0,
        outputTokens: u.output_tokens,
      },
    };
  }
}
