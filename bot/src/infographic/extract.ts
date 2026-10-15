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

/** Sends the image to Claude and returns its text structure, or null when it is not an infographic. */
export async function extractInfographic(
  image: Buffer,
  mime: ImageMime,
  opts: { client?: Anthropic; model?: string } = {},
): Promise<Extraction | null> {
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
