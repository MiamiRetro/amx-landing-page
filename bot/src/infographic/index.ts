import { createHash } from "node:crypto";
import type { Lang } from "../config.js";
import { log, errInfo } from "../log.js";
import { detokenize, tokenize } from "../mirror/placeholders.js";
import type { Translator } from "../translate/index.js";
import { extractInfographic, mimeFromName, type ImageMime } from "./extract.js";
import { Renderer } from "./render.js";
import { applyStrings, flattenStrings, type Extraction } from "./schema.js";

/** Mirror groups whose forums carry tutorials worth re-rendering. */
export const TUTORIAL_GROUPS = new Set(["setup-guides", "trading-strategies"]);
export const MAX_IMAGES_PER_MESSAGE = 4;

export function infographicsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.INFOGRAPHIC_TRANSLATION === "1";
}

/** Indexes of files that should go through the pipeline: images in a tutorial group, at most 4. */
export function pickCandidates(groupName: string, fileNames: string[]): number[] {
  if (!TUTORIAL_GROUPS.has(groupName)) return [];
  const out: number[] = [];
  fileNames.forEach((n, i) => {
    if (out.length < MAX_IMAGES_PER_MESSAGE && mimeFromName(n)) out.push(i);
  });
  return out;
}

export interface FileLike { attachment: Buffer | string; name: string }

/** Per target: rendered version where one exists, the original otherwise. */
export function chooseFiles(files: FileLike[], rendered: Map<number, Buffer> | undefined): FileLike[] {
  if (!rendered || rendered.size === 0) return files;
  return files.map((f, i) => {
    const r = rendered.get(i);
    return r ? { attachment: r, name: f.name.replace(/\.[^.]+$/, "") + ".png" } : f;
  });
}

class Lru<V> {
  private m = new Map<string, V>();
  constructor(private max: number) {}
  get(k: string): V | undefined {
    if (!this.m.has(k)) return undefined;
    const v = this.m.get(k)!;
    this.m.delete(k);
    this.m.set(k, v);
    return v;
  }
  delete(k: string) {
    this.m.delete(k);
  }
  set(k: string, v: V) {
    this.m.delete(k);
    this.m.set(k, v);
    while (this.m.size > this.max) this.m.delete(this.m.keys().next().value!);
  }
}

export interface LocalizerDeps {
  translator: Translator;
  renderer?: Renderer;
  extract?: (img: Buffer, mime: ImageMime) => Promise<Extraction | null>;
}

/**
 * Turns infographic images into one re-rendered PNG per language. Every step
 * is best-effort: whatever fails leaves that image (or language) as the original.
 */
export class InfographicLocalizer {
  private extractions = new Lru<Promise<Extraction | null>>(200);
  private renders = new Lru<Buffer>(400);
  readonly renderer: Renderer;
  private extract: (img: Buffer, mime: ImageMime) => Promise<Extraction | null>;

  constructor(private d: LocalizerDeps) {
    this.renderer = d.renderer ?? new Renderer();
    this.extract = d.extract ?? ((img, mime) => extractInfographic(img, mime));
  }

  /** Returns lang → (file index → rendered PNG). Missing entries mean: use the original. */
  async localize(
    groupName: string,
    files: FileLike[],
    sourceLang: Lang,
    targets: Lang[],
    glossary: { term: string; note: string | null }[],
  ): Promise<Map<Lang, Map<number, Buffer>>> {
    const out = new Map<Lang, Map<number, Buffer>>();
    const idx = pickCandidates(groupName, files.map((f) => f.name));
    for (const i of idx) {
      const f = files[i];
      if (!Buffer.isBuffer(f.attachment)) continue;
      try {
        const per = await this.localizeOne(f.attachment, mimeFromName(f.name)!, sourceLang, targets, glossary);
        for (const [lang, png] of per) {
          if (!out.has(lang)) out.set(lang, new Map());
          out.get(lang)!.set(i, png);
        }
      } catch (e) {
        log.warn("infographic translation failed, keeping original", { name: f.name, ...errInfo(e) });
      }
    }
    return out;
  }

  async localizeOne(img: Buffer, mime: ImageMime, sourceLang: Lang, targets: Lang[], glossary: { term: string; note: string | null }[]): Promise<Map<Lang, Buffer>> {
    const hash = createHash("sha256").update(img).digest("hex");
    const result = new Map<Lang, Buffer>();
    const todo = targets.filter((l) => l !== sourceLang && !this.fromCache(hash, l, result));
    if (todo.length === 0) return result;

    let pending = this.extractions.get(hash);
    if (!pending) {
      pending = this.extract(img, mime);
      this.extractions.set(hash, pending);
      pending.catch(() => this.extractions.delete(hash)); // retry next time
    }
    const ex = await pending;
    if (!ex) return result; // not an infographic

    const strings = flattenStrings(ex);
    const tok = strings.map((s) => tokenize(s));
    const live = tok.map((t, i) => (t.text.trim() ? i : -1)).filter((i) => i >= 0);
    const r = await this.d.translator.translate(live.map((i) => tok[i].text), live.map((i) => tok[i].entities), sourceLang, todo, glossary);
    if (!r.translated) throw new Error("translation failed");

    for (const lang of todo) {
      try {
        const translated = strings.slice();
        live.forEach((orig, k) => { translated[orig] = detokenize(r.translations[lang][k], tok[orig].entities); });
        const png = await this.renderer.render(applyStrings(ex, translated), lang);
        this.renders.set(`${hash}:${lang}`, png);
        result.set(lang, png);
      } catch (e) {
        log.warn("infographic render failed, keeping original", { lang, ...errInfo(e) });
      }
    }
    return result;
  }

  private fromCache(hash: string, lang: Lang, into: Map<Lang, Buffer>): boolean {
    const hit = this.renders.get(`${hash}:${lang}`);
    if (hit) into.set(lang, hit);
    return !!hit;
  }

  close() {
    return this.renderer.close();
  }
}
