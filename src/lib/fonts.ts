import type { FontFamily, TextObj } from '../types';

/**
 * Text objects are shown with system fonts that match the PDF standard 14
 * fonts they are saved with (Arial ~ Helvetica, Times New Roman ~ Times,
 * Courier New ~ Courier). Vertical metrics come from the screen fonts so the
 * saved baseline lands exactly where the user saw it, and line breaks are
 * computed here once so the editor and the saved file wrap identically.
 */
export const FONT_CSS: Record<FontFamily, string> = {
  sans: 'Helvetica, Arial, "Liberation Sans", sans-serif',
  serif: '"Times New Roman", Times, "Liberation Serif", serif',
  mono: '"Courier New", Courier, "Liberation Mono", monospace',
};

export const FONT_LABEL: Record<FontFamily, string> = {
  sans: 'Helvetica',
  serif: 'Times',
  mono: 'Courier',
};

const METRICS: Record<FontFamily, { ascent: number; descent: number }> = {
  sans: { ascent: 0.905, descent: 0.212 },
  serif: { ascent: 0.891, descent: 0.216 },
  mono: { ascent: 0.833, descent: 0.3 },
};

export const LINE_HEIGHT = 1.2;
/** Padding between a text object's box and its glyphs, in points. */
export const TEXT_PAD = 2;

type TextStyle = Pick<TextObj, 'font' | 'size' | 'bold' | 'italic'>;
type TextLike = TextStyle & Pick<TextObj, 'text'> & Partial<Pick<TextObj, 'width' | 'lineHeight' | 'hscale'>>;

/** Distance from the top of the text box to the first baseline. */
export function firstBaseline(font: FontFamily, size: number, lineHeight = LINE_HEIGHT) {
  const { ascent, descent } = METRICS[font];
  const halfLeading = (lineHeight - (ascent + descent)) / 2;
  return TEXT_PAD + (halfLeading + ascent) * size;
}

export function cssFont(o: TextStyle, scale = 1) {
  return `${o.italic ? 'italic ' : ''}${o.bold ? 'bold ' : ''}${o.size * scale}px ${FONT_CSS[o.font]}`;
}

let ctx: CanvasRenderingContext2D | null = null;

/** Width of a string in points at the object's size (no horizontal scaling). */
export function textWidth(o: TextStyle, s: string) {
  ctx ??= document.createElement('canvas').getContext('2d')!;
  // Measure at a large size for precision, then scale down.
  const font = cssFont({ ...o, size: 100 });
  if (ctx.font !== font) ctx.font = font;
  return (ctx.measureText(s).width * o.size) / 100;
}

export interface LaidLine {
  text: string;
  /** Offset of the line's first character in the full text. */
  start: number;
  width: number;
}

const layoutCache = new Map<string, LaidLine[]>();

/** Breaks text into lines: hard breaks always, soft wraps when a width is set. */
export function layoutText(o: TextLike): LaidLine[] {
  const hs = o.hscale ?? 1;
  const max = o.width ? o.width / hs : 0;
  const key = `${o.font}|${o.size}|${o.bold}|${o.italic}|${max.toFixed(2)}|${o.text}`;
  const hit = layoutCache.get(key);
  if (hit) return hit;
  const out: LaidLine[] = [];
  let offset = 0;
  for (const hard of o.text.split('\n')) {
    if (!max || textWidth(o, hard) <= max) {
      out.push({ text: hard, start: offset, width: textWidth(o, hard) });
    } else {
      // Greedy word wrap; spaces stay with the word before them, like a textarea.
      const tokens = hard.match(/\S+\s*|\s+/g) ?? [''];
      let line = '';
      let lineStart = offset;
      let pos = offset;
      for (const tok of tokens) {
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
  if (layoutCache.size > 3000) layoutCache.clear();
  layoutCache.set(key, out);
  return out;
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

/** Guess a family and style from an embedded font name like "ABCDEF+Calibri-Bold". */
export function classifyFont(name: string, cssFamily?: string) {
  const n = name.replace(/^[A-Z]{6}\+/, '');
  const lower = n.toLowerCase();
  let font: FontFamily = 'sans';
  if (/courier|mono|consol|menlo|typewriter/.test(lower) || cssFamily === 'monospace') font = 'mono';
  else if (
    /times|serif|georgia|garamond|cambria|palatino|minion|book|roman|baskerville|caslon|century|tinos/.test(lower) &&
    !/sans/.test(lower)
  )
    font = 'serif';
  else if (cssFamily === 'serif') font = 'serif';
  return {
    font,
    bold: /bold|black|heavy|semibold|demi|,b\b/.test(lower),
    italic: /italic|oblique|,i\b/.test(lower),
  };
}
