import { useSyncExternalStore } from 'react';
import type { FontFamily, TextObj } from '../types';
import { FAMILIES, fontChain, fontsVersion, loadFace, splitRuns, subscribeFonts, type Face } from './fontdb';

/**
 * Text objects are set in the bundled fonts (or a font embedded in the PDF),
 * on screen and in the saved file alike (see fontdb.ts). Kerning and
 * ligatures are off in both, so a line's width is the sum of its glyph
 * advances. Line breaks are computed here once, so the editor and the saved
 * file wrap identically.
 */
export const FONT_LABEL = Object.fromEntries(FAMILIES.map((f) => [f.key, f.like ? `${f.label} (${f.like})` : f.label])) as Record<FontFamily, string>;

export const LINE_HEIGHT = 1.2;
/** Padding between a text object's box and its glyphs, in points. */
export const TEXT_PAD = 2;

type TextStyle = Pick<TextObj, 'font' | 'size' | 'bold' | 'italic'> & Partial<Pick<TextObj, 'embedded' | 'text'>>;
type TextLike = TextStyle & Pick<TextObj, 'text'> & Partial<Pick<TextObj, 'width' | 'lineHeight' | 'hscale'>>;

/** Distance from the top of the text box to the first baseline. */
export function firstBaseline(o: TextStyle, lineHeight = LINE_HEIGHT) {
  const { ascent, descent } = fontChain(o)[0];
  const halfLeading = (lineHeight - (ascent + descent)) / 2;
  return TEXT_PAD + (halfLeading + ascent) * o.size;
}

/** Re-renders a component when fonts finish loading (text then measures differently). */
export function useFontsVersion() {
  return useSyncExternalStore(subscribeFonts, fontsVersion);
}

let ctx: CanvasRenderingContext2D | null = null;
/** Set when a measurement used a face that hadn't loaded yet. */
let provisional = false;

function canvas() {
  if (!ctx) {
    ctx = document.createElement('canvas').getContext('2d')!;
    // Match the CSS of text objects: no kerning, no ligatures.
    ctx.fontKerning = 'none';
    ctx.textRendering = 'optimizeSpeed';
  }
  return ctx;
}

function measureRun(face: Face, s: string) {
  if (face.state !== 'ready') {
    provisional = true;
    void loadFace(face);
  }
  const c = canvas();
  // Measure at a large size for precision.
  const font = `${face.style} ${face.weight} 100px "${face.css}"`;
  if (c.font !== font) c.font = font;
  return c.measureText(s).width / 100;
}

/** Width of a string in points at the object's size (no horizontal scaling). */
export function textWidth(o: TextStyle, s: string) {
  let w = 0;
  for (const run of splitRuns(fontChain(o), s)) w += measureRun(run.face, run.text);
  return w * o.size;
}

export interface LaidLine {
  text: string;
  /** Offset of the line's first character in the full text. */
  start: number;
  width: number;
}

const layoutCache = new Map<string, LaidLine[]>();
subscribeFonts(() => layoutCache.clear());

/** CJK characters can break anywhere; other text breaks at spaces and after hyphens. */
const CJK = '\\u2e80-\\u9fff\\uac00-\\ud7af\\uf900-\\ufaff\\ufe30-\\ufe4f\\uff00-\\uffef\\u{20000}-\\u{3ffff}';
const TOKEN = new RegExp(`[${CJK}]\\s*|[^\\s${CJK}-]+-+(?=[^\\s${CJK}-])|[^\\s${CJK}]+\\s*|\\s+`, 'gu');

export const tokens = (s: string) => s.match(TOKEN) ?? [''];

/** Breaks text into lines: hard breaks always, soft wraps when a width is set. */
export function layoutText(o: TextLike): LaidLine[] {
  const hs = o.hscale ?? 1;
  const max = o.width ? o.width / hs : 0;
  const key = `${o.font}|${o.embedded ?? ''}|${o.size}|${o.bold}|${o.italic}|${max.toFixed(2)}|${o.text}`;
  const hit = layoutCache.get(key);
  if (hit) return hit;
  provisional = false;
  const out: LaidLine[] = [];
  let offset = 0;
  for (const hard of o.text.split('\n')) {
    if (!max || textWidth(o, hard) <= max) {
      out.push({ text: hard, start: offset, width: textWidth(o, hard) });
    } else {
      // Greedy word wrap; spaces stay with the word before them, like a textarea.
      let line = '';
      let lineStart = offset;
      let pos = offset;
      for (const tok of tokens(hard)) {
        const candidate = line + tok;
        if (line && textWidth(o, candidate.trimEnd()) > max) {
          out.push({ text: line, start: lineStart, width: textWidth(o, line.trimEnd()) });
          line = '';
          lineStart = pos;
        }
        if (!line && textWidth(o, tok.trimEnd()) > max) {
          // A single word wider than the box: break it by characters.
          let chunk = '';
          let chunkStart = pos;
          for (const ch of tok) {
            if (chunk && textWidth(o, chunk + ch) > max) {
              out.push({ text: chunk, start: chunkStart, width: textWidth(o, chunk) });
              chunkStart += chunk.length;
              chunk = '';
            }
            chunk += ch;
          }
          line = chunk;
          lineStart = chunkStart;
        } else {
          line += tok;
        }
        pos += tok.length;
      }
      out.push({ text: line, start: lineStart, width: textWidth(o, line.trimEnd()) });
    }
    offset += hard.length + 1;
  }
  // Layouts measured before their fonts loaded are redone once they have.
  if (!provisional) {
    if (layoutCache.size > 3000) layoutCache.clear();
    layoutCache.set(key, out);
  }
  return out;
}

/**
 * A wrap width that reproduces the given line breaks: wide enough for every
 * line, too narrow for any line plus the first word of the next. Prefers
 * `guess` (the original column) inside that range. Falls back to `guess` when
 * no width works, e.g. because the font isn't metric-compatible.
 */
export function wrapWidth(o: TextLike, lines: string[], guess: number) {
  const hs = o.hscale ?? 1;
  let lo = 0;
  let hi = Infinity;
  lines.forEach((l, i) => {
    const line = l.trimEnd();
    lo = Math.max(lo, textWidth(o, line));
    if (i === lines.length - 1) return;
    const next = tokens(lines[i + 1].trimStart())[0].trimEnd();
    hi = Math.min(hi, textWidth(o, line + (line.endsWith('-') ? '' : ' ') + next));
  });
  lo *= hs;
  hi *= hs;
  if (!(hi > lo)) return guess;
  const margin = Math.min((hi - lo) / 4, o.size * 0.25);
  return Math.min(hi - margin, Math.max(lo + margin, guess));
}

/** Size of a text object's box in points. */
export function measureText(o: TextLike) {
  const lines = layoutText(o);
  const hs = o.hscale ?? 1;
  const lh = o.lineHeight ?? LINE_HEIGHT;
  const natural = Math.max(0, ...lines.map((l) => l.width)) * hs + o.size * 0.15;
  return {
    w: (o.width ?? natural) + TEXT_PAD * 2,
    h: Math.max(1, lines.length) * o.size * lh + TEXT_PAD * 2,
  };
}

/** Character offset nearest to a point given relative to the box's top-left. */
export function offsetAt(o: TextLike, x: number, y: number) {
  const lines = layoutText(o);
  const lh = (o.lineHeight ?? LINE_HEIGHT) * o.size;
  const i = Math.max(0, Math.min(lines.length - 1, Math.floor((y - TEXT_PAD) / lh)));
  const line = lines[i];
  const target = (x - TEXT_PAD) / (o.hscale ?? 1);
  let best = 0;
  let bestDist = Infinity;
  for (let k = 0; k <= line.text.length; k++) {
    const d = Math.abs(textWidth(o, line.text.slice(0, k)) - target);
    if (d < bestDist) {
      bestDist = d;
      best = k;
    }
  }
  return line.start + best;
}

/**
 * Bundled families that are drop-in replacements (same advance widths) for
 * common fonts, by compacted lower-case name. Narrow, black, rounded and
 * condensed cuts aren't.
 */
const METRIC: [RegExp, FontFamily][] = [
  [/calibri|carlito/, 'carlito'],
  [/cambria|caladea/, 'caladea'],
  [/^(arial(mt)?|helvetica|liberationsans|arimo|nimbussans(l)?)(?!narrow|black|rounded|condensed|neue|light|compressed)/, 'sans'],
  [/^(times|timesnewroman(ps)?(mt)?|liberationserif|tinos|nimbusroman(no9l)?)/, 'serif'],
  [/^(courier(new)?(ps)?(mt)?|liberationmono|cousine|nimbusmono(l|ps)?)/, 'mono'],
  [/^notosans(?!mono|symbols|cjk|sc|tc|jp|kr|hk|math|display)/, 'noto'],
];

/** Symbol-font bullets that PDFs map to private-use code points, as real characters. */
const PUA_SYMBOLS: Record<string, string> = {
  '': '•',
  '': '▪',
  '': '➢',
  '': '✓',
  '': '❖',
};

export const normalizeSymbols = (s: string) => s.replace(/[]/g, (c) => PUA_SYMBOLS[c]);

/**
 * Guess a family and style from an embedded font name like "ABCDEF+Calibri-Bold".
 * `metric` says the family has the same character widths as the original.
 */
export function classifyFont(name: string, cssFamily?: string) {
  const n = name.replace(/^[A-Z]{6}\+/, '');
  const lower = n.toLowerCase();
  const compact = lower.replace(/[\s_,-]/g, '');
  const match = METRIC.find(([re]) => re.test(compact));
  let font: FontFamily = 'sans';
  if (match) font = match[1];
  else if (/courier|mono|consol|menlo|typewriter/.test(lower) || cssFamily === 'monospace') font = 'mono';
  else if (
    /times|serif|georgia|garamond|palatino|minion|book|roman|baskerville|caslon|century/.test(lower) &&
    !/sans/.test(lower)
  )
    font = 'serif';
  else if (cssFamily === 'serif') font = 'serif';
  return {
    font,
    metric: !!match,
    bold: /bold|black|heavy|semibold|demi|,b\b/.test(lower),
    italic: /italic|oblique|,i\b/.test(lower),
  };
}
