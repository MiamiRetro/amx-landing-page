/** The local model is run with an 8192-token window shared by prompt and output. */
export const HARD_CONTEXT_BUDGET = 8192;

export interface BudgetConfig {
  /** Combined prompt + output tokens allowed; clamped to HARD_CONTEXT_BUDGET. */
  contextBudget: number;
  /** Tokens reserved for chat-template framing (BOS, turn markers, system fold-in). */
  templateHeadroom: number;
  /** Upper bound on generated tokens. */
  maxOutputCap: number;
}

export const DEFAULT_BUDGET: BudgetConfig = { contextBudget: HARD_CONTEXT_BUDGET, templateHeadroom: 128, maxOutputCap: 4096 };

export interface Measure {
  /** Tokens in the system + user message text, without template framing. */
  promptTokens: number;
  /** Tokens in the segments alone, used to size the expected output. */
  segmentTokens: number;
  /** True when counted by the model's tokenizer, false for the byte upper bound. */
  exact: boolean;
}

export type BudgetPlan =
  | { ok: true; maxTokens: number; promptTokens: number; expectedOutput: number; exact: boolean }
  | { ok: false; reason: string };

/**
 * A safe upper bound on token count with no tokenizer: no token is shorter than
 * one byte, so UTF-8 byte length can only over-count. Used when /tokenize is
 * unreachable; over-counting makes oversized requests fail to cloud sooner, never
 * run local and get cut off.
 */
export function byteUpperBound(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** Counts tokens with the model's tokenizer, falling back to the byte bound if it fails. */
export async function measurePrompt(
  system: string,
  user: string,
  segments: string[],
  countTokens: (text: string) => Promise<number>,
  signal?: AbortSignal,
): Promise<Measure> {
  const segText = segments.join("\n");
  try {
    const [s, u, seg] = await Promise.all([countTokens(system), countTokens(user), countTokens(segText)]);
    return { promptTokens: s + u, segmentTokens: seg, exact: true };
  } catch (e) {
    // An abort must still stop the job rather than be silently turned into an estimate.
    if (signal?.aborted) throw e;
    return { promptTokens: byteUpperBound(system) + byteUpperBound(user), segmentTokens: byteUpperBound(segText), exact: false };
  }
}

/**
 * Output tokens the JSON reply will probably need: each target repeats every
 * segment, CJK and Hangul can run ~2x the source token count, plus quotes,
 * commas and keys per entry. Deliberately generous; a reply that still
 * overruns is caught by finish_reason and failed, never accepted truncated.
 */
export function expectedOutputTokens(segmentTokens: number, segmentCount: number, targetCount: number): number {
  return targetCount * (2 * segmentTokens + 6 * segmentCount + 8) + 16;
}

/**
 * Decides whether a request fits locally and how many tokens the model may
 * generate. prompt + headroom + max_tokens never exceeds the budget. If the
 * expected output does not fit, the request is refused (so it goes to cloud)
 * instead of being truncated.
 */
export function planBudget(m: Measure, segmentCount: number, targetCount: number, cfg: BudgetConfig = DEFAULT_BUDGET): BudgetPlan {
  const ctx = Math.min(cfg.contextBudget, HARD_CONTEXT_BUDGET);
  const expectedOutput = expectedOutputTokens(m.segmentTokens, segmentCount, targetCount);
  const room = ctx - m.promptTokens - cfg.templateHeadroom;
  const maxTokens = Math.min(cfg.maxOutputCap, room);
  if (maxTokens < expectedOutput) {
    return {
      ok: false,
      reason: `over_budget: prompt ${m.promptTokens}${m.exact ? "" : " (byte bound)"} + headroom ${cfg.templateHeadroom} + expected output ${expectedOutput} does not fit in ${ctx} (output cap ${cfg.maxOutputCap})`,
    };
  }
  return { ok: true, maxTokens, promptTokens: m.promptTokens, expectedOutput, exact: m.exact };
}
