import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { ExtractionSchema, parseExtraction, type Extraction } from "./schema.js";

export const DEFAULT_INFOGRAPHIC_MODEL = "claude-sonnet-5-5";

const PROMPT = `You are reading an image posted in a trading-education Discord (brand: BLKBöX).
Decide whether it is an infographic: a designed graphic whose main content is meaningful text (a step-by-step guide, checklist, comparison, key stat, labelled diagram).
Photos, memes, screenshots of apps or exchanges, and price charts without explanatory text are NOT infographics.

If it is an infographic, transcribe its text exactly (do not translate, summarise or add anything) into the schema:
- title: the main headline. subtitle: the line under it, if any.
- layout: "steps" for numbered/ordered steps, "list" for bullet points or tips, "comparison" for side-by-side columns (each column one section), "stat" for headline numbers (put the number in value), "diagram-ish" for boxes/flows.
- sections: one per step/card/column, in reading order. Leave out step numbers themselves; they are re-drawn.
- footer: small print, a call to action or a URL at the bottom, if any.
Leave out the brand logo/wordmark and decorative text. If it is not an infographic, set isInfographic false, title "", layout "list", sections [].`;

export type ImageMime = "image/png" | "image/jpeg" | "image/webp";

export function mimeFromName(name: string): ImageMime | null {
  const ext = name.toLowerCase().split("?")[0].split(".").pop();
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "webp") return "image/webp";
  return null;
}

/**
 * Reads the image's text structure, or null when it is not an infographic.
 * With INFOGRAPHIC_VLM_URL set (the Mac Studio's local Qwen2.5-VL, e.g.
 * http://127.0.0.1:8189/v1) no image ever leaves the machine; otherwise Claude reads it.
 */
export async function extractInfographic(
  image: Buffer,
  mime: ImageMime,
  opts: { client?: Anthropic; model?: string } = {},
): Promise<Extraction | null> {
  const local = process.env.INFOGRAPHIC_VLM_URL?.trim();
  if (local) return extractLocal(local, image, mime);
  const client = opts.client ?? new Anthropic();
  const response = await client.messages.parse({
    model: opts.model ?? process.env.INFOGRAPHIC_MODEL ?? DEFAULT_INFOGRAPHIC_MODEL,
    max_tokens: 4096,
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: mime, data: image.toString("base64") } },
        { type: "text", text: PROMPT },
      ],
    }],
    output_config: { format: zodOutputFormat(ExtractionSchema) },
  });
  if (response.stop_reason === "refusal") throw new Error("extraction refused");
  if (!response.parsed_output) throw new Error("extraction did not parse");
  return parseExtraction(response.parsed_output);
}

const SHAPE = `Reply with only a JSON object, no prose, in this shape:
{"isInfographic": boolean, "title": string, "subtitle": string|null, "layout": "steps"|"list"|"comparison"|"stat"|"diagram-ish",
 "sections": [{"heading": string|null, "body": string|null, "bullets": string[]|null, "value": string|null}], "footer": string|null}`;

/** The same extraction through a local OpenAI-compatible vision server (mlx-vlm). */
async function extractLocal(baseUrl: string, image: Buffer, mime: ImageMime): Promise<Extraction | null> {
  const base = baseUrl.replace(/\/$/, "");
  // The server answers for whichever model it has loaded; asking for any other name makes it download one.
  let model = process.env.INFOGRAPHIC_VLM_MODEL;
  if (!model) {
    const list = (await (await fetch(`${base}/models`)).json()) as { data?: { id: string; loaded?: boolean }[] };
    model = list.data?.find((m) => m.loaded)?.id;
    if (!model) throw new Error("local vision server has no model loaded");
  }
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      temperature: 0,
      messages: [{
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:${mime};base64,${image.toString("base64")}` } },
          { type: "text", text: `${PROMPT}\n\n${SHAPE}` },
        ],
      }],
    }),
    signal: AbortSignal.timeout(300_000),
  });
  if (!res.ok) throw new Error(`local vision model ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const text = body.choices?.[0]?.message?.content ?? "";
  const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  if (!json) throw new Error("local vision model returned no JSON");
  const raw = JSON.parse(json) as Record<string, unknown>;
  // Local models write null where the schema wants the key left out.
  const clean = JSON.parse(JSON.stringify(raw, (_k, v) => (v === null ? undefined : v)));
  return parseExtraction(clean);
}
