/**
 * The fonts Folio sets text in. Two kinds:
 *
 * - Bundled open fonts in public/fonts, metric-compatible with the fonts most
 *   PDFs use (Liberation for Arial/Helvetica, Times and Courier, Carlito for
 *   Calibri, Caladea for Cambria), plus fallbacks for characters those lack
 *   (Noto Sans, Noto Sans Symbols 2, Droid Sans Fallback for CJK).
 * - Font programs embedded in an open PDF, reused when they can draw the text.
 *
 * Each face is loaded once, from local bytes, and those same bytes are shown
 * on screen (as a FontFace) and embedded on save, so text measures and wraps
 * identically in both. Characters are given to the first face in an object's
 * chain that has them, the same way the browser falls back through a CSS
 * font-family list.
 */
import manifest from './fonts.manifest.json';
import type { FontFamily } from '../types';

export interface Face {
  id: string;
  /** CSS family the face is registered under. */
  css: string;
  weight: number;
  style: 'normal' | 'italic';
  /** PostScript name, used for the font's name in saved files. */
  ps: string;
  /** Vertical metrics as the browser uses them, in em. */
  ascent: number;
  descent: number;
  /** Covered code points: sorted [first, last] pairs, or a set. */
  ranges?: number[];
  cover?: Set<number>;
  url?: string;
  bytes?: Uint8Array;
  state: 'idle' | 'loading' | 'ready' | 'failed';
  promise?: Promise<void>;
}

/** Font families offered in the Font menu, in menu order. */
export const FAMILIES: { key: FontFamily; label: string; like?: string }[] = [
  { key: 'sans', label: 'Liberation Sans', like: 'Arial' },
  { key: 'serif', label: 'Liberation Serif', like: 'Times' },
  { key: 'mono', label: 'Liberation Mono', like: 'Courier' },
  { key: 'carlito', label: 'Carlito', like: 'Calibri' },
  { key: 'caladea', label: 'Caladea', like: 'Cambria' },
  { key: 'noto', label: 'Noto Sans' },
];

const FONT_DIR = `${import.meta.env.BASE_URL}fonts/`;

/** Bundled faces by family key ('symbols' and 'cjk' are fallbacks only). */
const bundled = new Map<string, Face[]>();
for (const f of manifest.faces) {
  const face: Face = {
    id: f.id,
    css: `folio-${f.family}`,
    weight: f.weight,
    style: f.style as Face['style'],
    ps: f.ps,
    ascent: f.ascent,
    descent: f.descent,
    ranges: f.ranges,
    url: FONT_DIR + f.file,
    state: 'idle',
  };
  const list = bundled.get(f.family);
  if (list) list.push(face);
  else bundled.set(f.family, [face]);
}

/** The face CSS font matching would pick from a family for this style. */
function pick(faces: Face[], bold: boolean, italic: boolean): Face {
  const style = italic ? 'italic' : 'normal';
  const sameStyle = faces.filter((f) => f.style === style);
  const pool = sameStyle.length ? sameStyle : faces;
  const weight = bold ? 700 : 400;
  return pool.find((f) => f.weight === weight) ?? pool[0];
}

export function bundledFace(family: string, bold: boolean, italic: boolean): Face {
  return pick(bundled.get(family) ?? bundled.get('sans')!, bold, italic);
}

function fallbacks(bold: boolean, italic: boolean): Face[] {
  return [bundledFace('noto', bold, italic), bundledFace('symbols', false, false), bundledFace('cjk', false, false)];
}

/* ------------------------------------------------------------------ */
/* Fonts embedded in open documents                                     */
/* ------------------------------------------------------------------ */

export interface DocFont {
  id: string;
  /** Font name as the PDF gives it, without a subset tag. */
  name: string;
  face: Face;
  /** Only some of the font's glyphs are embedded (the name had a subset tag). */
  subset: boolean;
  bold: boolean;
  italic: boolean;
}

const docFonts = new Map<string, DocFont>();
let docFontCount = 0;

export function addDocFont(f: Omit<DocFont, 'id' | 'face'> & { bytes: Uint8Array; cover: Set<number>; ps: string; ascent: number; descent: number }): DocFont {
  const n = ++docFontCount;
  const face: Face = {
    id: `doc-${n}`,
    css: `folio-doc-${n}`,
    weight: 400,
    style: 'normal',
    ps: f.ps,
    ascent: f.ascent,
    descent: f.descent,
    cover: f.cover,
    bytes: f.bytes,
    state: 'idle',
  };
  const font: DocFont = { id: face.id, name: f.name, face, subset: f.subset, bold: f.bold, italic: f.italic };
  docFonts.set(font.id, font);
  return font;
}

export function getDocFont(id: string | undefined) {
  return id ? docFonts.get(id) : undefined;
}

export interface FontStyle {
  font: FontFamily;
  bold: boolean;
  italic: boolean;
  /** A font embedded in the source PDF to use where it can. */
  embedded?: string;
  /** The whole text, when known: a subset font is only used if it has all of it. */
  text?: string;
}

/**
 * The document font an object is drawn with, if any. It applies while the
 * style still matches the original and, for a subset, while every character
 * of the text is among the glyphs the PDF embedded.
 */
export function activeDocFont(o: FontStyle): DocFont | null {
  const d = getDocFont(o.embedded);
  if (!d || d.face.state !== 'ready' || d.bold !== o.bold || d.italic !== o.italic) return null;
  if (d.subset && o.text !== undefined) {
    for (const ch of o.text) {
      const cp = ch.codePointAt(0)!;
      if (cp > 0x20 && !ignorable(cp) && !covers(d.face, cp)) return null;
    }
  }
  return d;
}

/** Faces an object's characters are drawn with, in fallback order. */
export function fontChain(o: FontStyle): Face[] {
  const rest = [bundledFace(o.font, o.bold, o.italic), ...fallbacks(o.bold, o.italic)];
  const d = activeDocFont(o);
  if (!d) return rest;
  // A subset falls back as a whole (see activeDocFont); a full font per character.
  return d.subset ? [d.face] : [d.face, ...rest];
}

/** CSS font-family list for an object; the browser falls back the same way. */
export function fontStack(o: FontStyle) {
  return fontChain(o)
    .map((f) => `"${f.css}"`)
    .join(', ');
}

/* ------------------------------------------------------------------ */
/* Coverage and runs                                                    */
/* ------------------------------------------------------------------ */

export function covers(face: Face, cp: number): boolean {
  if (face.cover) return face.cover.has(cp);
  const r = face.ranges!;
  let lo = 0;
  let hi = r.length / 2 - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cp < r[mid * 2]) hi = mid - 1;
    else if (cp > r[mid * 2 + 1]) lo = mid + 1;
    else return true;
  }
  return false;
}

/** Joiners and variation selectors: invisible, and fine to drop if a font lacks them. */
export function ignorable(cp: number) {
  return cp === 0x200c || cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef);
}

const COMPLEX = /[̀-ͯ҃-҉֑-ׇ᪰-᫿᷀-᷿‌‍⃐-⃿︀-️︠-︯\ud800-\udfff]/;
let segmenter: Intl.Segmenter | null = null;

/** Grapheme clusters (base character plus combining marks). */
function clusters(text: string): Iterable<string> {
  if (!COMPLEX.test(text)) return text;
  segmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  return [...segmenter.segment(text)].map((s) => s.segment);
}

function faceFor(chain: Face[], cluster: string): Face {
  const cps: number[] = [];
  for (const ch of cluster) {
    const cp = ch.codePointAt(0)!;
    if (!ignorable(cp)) cps.push(cp);
  }
  if (!cps.length || cps[0] < 0x20) return chain[0];
  for (const f of chain) if (cps.every((cp) => covers(f, cp))) return f;
  for (const f of chain) if (covers(f, cps[0])) return f;
  return chain[0];
}

export interface Run {
  face: Face;
  text: string;
}

/** Splits text into runs drawn with one face each. */
export function splitRuns(chain: Face[], text: string): Run[] {
  const runs: Run[] = [];
  const first = chain[0];
  // Common case: the first face has every character.
  let simple = true;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0x20 && !covers(first, cp)) {
      simple = false;
      break;
    }
  }
  if (simple || chain.length === 1) return text ? [{ face: first, text }] : [];
  for (const c of clusters(text)) {
    const face = faceFor(chain, c);
    const last = runs[runs.length - 1];
    if (last && last.face === face) last.text += c;
    else runs.push({ face, text: c });
  }
  return runs;
}

/** Characters no face in the chain can draw. */
export function uncovered(chain: Face[], text: string): string[] {
  const out = new Set<string>();
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp > 0x20 && !ignorable(cp) && !chain.some((f) => covers(f, cp))) out.add(ch);
  }
  return [...out];
}

/* ------------------------------------------------------------------ */
/* Loading                                                              */
/* ------------------------------------------------------------------ */

const listeners = new Set<() => void>();
let version = 0;

export function subscribeFonts(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export const fontsVersion = () => version;

function changed() {
  version++;
  listeners.forEach((l) => l());
}

/** Loads a face's bytes and registers it with the document. */
export function loadFace(face: Face): Promise<void> {
  face.promise ??= (async () => {
    face.state = 'loading';
    try {
      if (!face.bytes) {
        const res = await fetch(face.url!);
        if (!res.ok) throw new Error(`${face.url}: ${res.status}`);
        face.bytes = new Uint8Array(await res.arrayBuffer());
      }
      const ff = new FontFace(face.css, face.bytes as Uint8Array<ArrayBuffer>, { weight: String(face.weight), style: face.style });
      await ff.load();
      document.fonts.add(ff);
      face.state = 'ready';
    } catch (e) {
      console.warn('Font could not be loaded', face.id, e);
      face.state = 'failed';
    }
    changed();
  })();
  return face.promise;
}

/** Faces needed to draw these texts in their styles. */
export function facesFor(items: (FontStyle & { text: string })[]): Face[] {
  const need = new Set<Face>();
  for (const o of items) {
    const chain = fontChain(o);
    need.add(chain[0]);
    for (const line of o.text.split('\n')) for (const r of splitRuns(chain, line)) need.add(r.face);
  }
  return [...need];
}

/** Resolves once every face these texts need has loaded (or failed to). */
export async function loadFontsFor(items: (FontStyle & { text: string })[]) {
  await Promise.all(facesFor(items).map(loadFace));
}

/** The face's font program, for embedding. */
export async function faceBytes(face: Face): Promise<Uint8Array> {
  await loadFace(face);
  if (!face.bytes) throw new Error(`Font ${face.id} is unavailable`);
  return face.bytes;
}
