import { z } from "zod";

export const LAYOUTS = ["steps", "list", "comparison", "stat", "diagram-ish"] as const;

export const SectionSchema = z.object({
  heading: z.string().optional(),
  body: z.string().optional(),
  bullets: z.array(z.string()).optional(),
  value: z.string().optional(),
});

/** What Claude reads off an image. Everything but isInfographic is ignored when it is false. */
export const ExtractionSchema = z.object({
  isInfographic: z.boolean(),
  title: z.string(),
  subtitle: z.string().optional(),
  layout: z.enum(LAYOUTS),
  sections: z.array(SectionSchema),
  footer: z.string().optional(),
});

export type Extraction = z.infer<typeof ExtractionSchema>;
export type Section = z.infer<typeof SectionSchema>;

/**
 * Validates raw model output. Returns null when it is malformed, not an
 * infographic, or has too little text to be worth re-rendering.
 */
export function parseExtraction(raw: unknown): Extraction | null {
  const r = ExtractionSchema.safeParse(raw);
  if (!r.success) return null;
  const ex = r.data;
  if (!ex.isInfographic) return null;
  if (!ex.title.trim() || ex.sections.length === 0) return null;
  // Bound the template: more than this would not fit a readable 1080px card anyway.
  if (ex.sections.length > 12) return null;
  return ex;
}

/** Every human-language string, in a stable order, for one translation call. */
export function flattenStrings(ex: Extraction): string[] {
  const out: string[] = [ex.title, ex.subtitle ?? "", ex.footer ?? ""];
  for (const s of ex.sections) {
    out.push(s.heading ?? "", s.body ?? "", s.value ?? "");
    for (const b of s.bullets ?? []) out.push(b);
  }
  return out;
}

/** Inverse of flattenStrings: puts translated strings back into the same shape. */
export function applyStrings(ex: Extraction, strings: string[]): Extraction {
  if (strings.length !== flattenStrings(ex).length) throw new Error("string count mismatch");
  let i = 0;
  const next = () => strings[i++];
  const keep = (orig: string | undefined) => {
    const v = next();
    return orig === undefined ? undefined : v;
  };
  const title = next();
  const subtitle = keep(ex.subtitle);
  const footer = keep(ex.footer);
  const sections = ex.sections.map((s) => {
    const heading = keep(s.heading);
    const body = keep(s.body);
    const value = keep(s.value);
    const bullets = s.bullets?.map(() => next());
    return { heading, body, value, bullets };
  });
  return { ...ex, title, subtitle, footer, sections };
}
