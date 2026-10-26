/**
 * Text recognized on scanned pages, and how it joins the page's own text.
 *
 * Results are kept per source page, in page space (see PageItem), and are
 * merged into the pdf.js text content of that page. Everything that reads
 * page text (search, the selectable text layer, Edit mode paragraphs,
 * highlights and redaction by selection) therefore treats recognized words
 * exactly like text that was in the file.
 */
import type { TextContent, TextItem } from 'pdfjs-dist/types/src/display/api';
import type { Matrix, PageItem, Rect } from '../types';
import { applyMatrix, invertMatrix } from './geometry';

export interface OcrWord {
  text: string;
  /** Bounding box of the inked word. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Baseline under the word. */
  base: number;
  /** Left and right edge of each character, when the engine reported them: [x0, x1, x0, x1, ...]. */
  chars?: number[];
}

export interface OcrLine {
  /** Estimated font size in points. */
  size: number;
  words: OcrWord[];
}

export interface OcrPage {
  /** Languages the page was recognized with, e.g. "eng". */
  lang: string;
  /** PDF user space -> page space of the source page when it was recognized. */
  m: Matrix;
  lines: OcrLine[];
}

/** OCR results are stored per source page; duplicated pages share them. */
export const ocrKey = (p: Pick<PageItem, 'src' | 'index'>) => `${p.src}:${p.index}`;

export const ocrWordCount = (p: OcrPage) => p.lines.reduce((n, l) => n + l.words.length, 0);

/* ------------------------------------------------------------------ */
/* Text content                                                        */
/* ------------------------------------------------------------------ */

export const OCR_FONT = 'folio-ocr';

/**
 * How the text layer sets recognized words. Each word is scaled to its box, so
 * only the vertical metrics matter: the box from 0.8 above to 0.2 below the
 * baseline covers ascenders and descenders at the estimated size.
 */
const OCR_STYLE = { fontFamily: 'sans-serif', ascent: 0.8, descent: -0.2, vertical: false };

function ocrItems(ocr: OcrPage): TextItem[] {
  const inv = invertMatrix(ocr.m);
  const linear = (x: number, y: number) => [inv[0] * x + inv[2] * y, inv[1] * x + inv[3] * y];
  const items: TextItem[] = [];
  for (const line of ocr.lines) {
    const s = line.size;
    // Text runs left to right in page space with its top towards -y.
    const [a, b] = linear(s, 0);
    const [c, d] = linear(0, -s);
    const item = (str: string, x: number, base: number, width: number, hasEOL: boolean): TextItem => {
      const o = applyMatrix(inv, x, base);
      return { str, dir: 'ltr', transform: [a, b, c, d, o.x, o.y], width, height: s, fontName: OCR_FONT, hasEOL };
    };
    line.words.forEach((w, i) => {
      const next = line.words[i + 1];
      items.push(item(w.text, w.x, w.base, w.w, !next));
      // A real space between words, so selections, search and Edit mode see separate words.
      if (next) items.push(item(' ', w.x + w.w, (w.base + next.base) / 2, Math.max(0.1, next.x - w.x - w.w), false));
    });
  }
  return items;
}

const merged = new WeakMap<TextContent, WeakMap<OcrPage, TextContent>>();

/** The page's text content with its recognized words appended (indices of existing items are kept). */
export function withOcr(tc: TextContent, ocr: OcrPage): TextContent {
  let byOcr = merged.get(tc);
  if (!byOcr) {
    byOcr = new WeakMap();
    merged.set(tc, byOcr);
  }
  let out = byOcr.get(ocr);
  if (!out) {
    out = { ...tc, items: [...tc.items, ...ocrItems(ocr)], styles: { ...tc.styles, [OCR_FONT]: OCR_STYLE } };
    byOcr.set(ocr, out);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* From the engine                                                     */
/* ------------------------------------------------------------------ */

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** The parts of tesseract.js's "blocks" output that are used here. */
export interface EngineBlock {
  paragraphs: {
    lines: {
      bbox: Box;
      baseline?: Box & { has_baseline?: boolean };
      rowAttributes?: { ascenders?: number; descenders?: number; row_height?: number; rowHeight?: number };
      words: { text: string; confidence: number; bbox: Box; symbols?: { text: string; bbox: Box }[] }[];
    }[];
  }[];
}

const hasLetters = (s: string) => /[\p{L}\p{N}]/u.test(s);

const overlapArea = (a: Rect, b: Rect) =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

/**
 * Converts recognized blocks (pixels of a render at `scale` times page space)
 * into an OcrPage. Words already present as real text (`existing`, page space)
 * are dropped so they aren't found twice.
 */
export function fromEngine(blocks: EngineBlock[] | null, scale: number, m: Matrix, lang: string, existing: Rect[] = []): OcrPage {
  const lines: OcrLine[] = [];
  const px = (v: number) => v / scale;
  for (const block of blocks ?? []) {
    for (const para of block.paragraphs ?? []) {
      const start = lines.length;
      for (const line of para.lines ?? []) {
        const top = px(line.bbox.y0);
        const bottom = px(line.bbox.y1);
        const bl = line.baseline;
        const sloped = bl && bl.x1 !== bl.x0 && bl.has_baseline !== false;
        const baseAt = (x: number) => {
          if (!sloped) return bottom - (bottom - top) * 0.2;
          const t = (x * scale - bl.x0) / (bl.x1 - bl.x0);
          return px(bl.y0 + (bl.y1 - bl.y0) * t);
        };
        const words: OcrWord[] = [];
        for (const w of line.words ?? []) {
          const text = w.text.trim();
          if (!text || w.confidence < 20 || (!hasLetters(text) && w.confidence < 50)) continue;
          const box = { x: px(w.bbox.x0), y: px(w.bbox.y0), w: px(w.bbox.x1 - w.bbox.x0), h: px(w.bbox.y1 - w.bbox.y0) };
          if (box.w <= 0 || box.h <= 0) continue;
          if (existing.some((r) => overlapArea(box, r) > 0.5 * box.w * box.h)) continue;
          const word: OcrWord = { text, ...box, base: Math.max(box.y, baseAt(box.x + box.w / 2)) };
          const syms = w.symbols ?? [];
          if (syms.length && syms.map((s) => s.text).join('') === text) word.chars = syms.flatMap((s) => [px(s.bbox.x0), px(s.bbox.x1)]);
          words.push(word);
        }
        if (!words.length) continue;
        // Cap height and ascenders reach about 0.72 em above the baseline in
        // most text faces; descenders about 0.21 em below it.
        const mid = words[Math.floor(words.length / 2)];
        const rise = mid.base - top;
        const drop = bottom - mid.base;
        const size = rise > (bottom - top) * 0.45 ? Math.max(rise / 0.72, drop / 0.25) : (bottom - top) / 0.93;
        lines.push({ size: Math.max(1, size), words });
      }
      // Lines of one paragraph share a size unless they clearly differ, which
      // keeps them together as one block in Edit mode.
      const group = lines.slice(start);
      if (group.length > 1) {
        const sizes = group.map((l) => l.size).sort((a, b) => a - b);
        const median = sizes[Math.floor(sizes.length / 2)];
        for (const l of group) if (Math.abs(l.size - median) < median * 0.2) l.size = median;
      }
    }
  }
  return { lang, m, lines };
}
