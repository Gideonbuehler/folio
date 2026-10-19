/**
 * Saving recognized text: each page gets an invisible text layer (text render
 * mode 3) with one run per word, stretched over the word's box, so the saved
 * file is searchable and selectable in any viewer while the scan stays what
 * you see. Words replaced in Edit mode are left out, and so is every character
 * under a redaction mark.
 *
 * The layer uses its own Type0 font: two-byte codes are UTF-16 code units, a
 * ToUnicode map turns them back into text, and the embedded TrueType font has
 * no visible glyphs. That works for any language the engine can read.
 */
import { PDFString, type PDFDocument, type PDFPage, type PDFRef } from '@cantoo/pdf-lib';
import type { Matrix, Obj, Rect } from '../types';
import { invertMatrix } from './geometry';
import type { OcrPage, OcrWord } from './ocrModel';

/** Every glyph advances half an em; Tz stretches each run to its word's width. */
const ADVANCE = 500;

const area = (r: Rect) => Math.max(0, r.w) * Math.max(0, r.h);

const overlap = (a: Rect, b: Rect) =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

const centerIn = (a: Rect, b: Rect) => {
  const cx = a.x + a.w / 2;
  const cy = a.y + a.h / 2;
  return cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h;
};

/** Stricter than for ordinary text: a character a mark touches noticeably goes. */
const underMark = (r: Rect, marks: Rect[]) => marks.some((m) => centerIn(r, m) || overlap(r, m) > 0.1 * area(r));

interface Run {
  text: string;
  x0: number;
  x1: number;
  /** The run ends where the word does. */
  last: boolean;
  /** The run starts where the word does. */
  first: boolean;
}

/** The parts of a word that survive the redaction marks. */
function keptRuns(w: OcrWord, size: number, marks: Rect[]): Run[] {
  const whole: Run = { text: w.text, x0: w.x, x1: w.x + w.w, first: true, last: true };
  const top = Math.min(w.y, w.base - 0.8 * size);
  const bottom = Math.max(w.y + w.h, w.base + 0.2 * size);
  const box: Rect = { x: w.x, y: top, w: w.w, h: bottom - top };
  if (!marks.some((m) => overlap(box, m) > 0)) return [whole];

  const symbols = Array.from(w.text);
  const exact = w.chars && w.chars.length === symbols.length * 2 ? w.chars : null;
  const step = w.w / symbols.length;
  const runs: Run[] = [];
  let cur: Run | null = null;
  symbols.forEach((ch, i) => {
    // Where the character is on the scan, and where the saved run will put it.
    const placed = { x: w.x + i * step, y: top, w: step, h: bottom - top };
    const seen = exact ? { x: exact[i * 2], y: top, w: exact[i * 2 + 1] - exact[i * 2], h: bottom - top } : placed;
    if (underMark(placed, marks) || underMark(seen, marks)) {
      cur = null;
      return;
    }
    const x0 = exact ? Math.min(exact[i * 2], placed.x) : placed.x;
    const x1 = exact ? Math.max(exact[i * 2 + 1], placed.x + step) : placed.x + step;
    if (cur) {
      cur.text += ch;
      cur.x1 = Math.max(cur.x1, x1);
      cur.last = i === symbols.length - 1;
    } else {
      cur = { text: ch, x0, x1, first: i === 0, last: i === symbols.length - 1 };
      runs.push(cur);
    }
  });
  return runs;
}

const f = (v: number) => String(Math.round(v * 1000) / 1000);

const hex = (text: string) => {
  let s = '';
  for (let i = 0; i < text.length; i++) s += text.charCodeAt(i).toString(16).padStart(4, '0');
  return s;
};

const mul = (a: Matrix, b: Matrix): Matrix => [
  a[0] * b[0] + a[1] * b[2],
  a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2],
  a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4],
  a[4] * b[1] + a[5] * b[3] + b[5],
];

/**
 * Adds the recognized text of a page as its first content stream. `m` maps the
 * output page's user space to page space; `objs` are the page's objects.
 */
export function addOcrText(doc: PDFDocument, page: PDFPage, m: Matrix, ocr: OcrPage, objs: Obj[]) {
  const marks: Rect[] = objs.filter((o) => o.type === 'redact') as Rect[];
  const replaced: Rect[] = [];
  for (const o of objs) {
    if (o.type === 'text' && o.cover) replaced.push(o.cover);
    else if (o.type === 'whiteout' && o.erase === 'text') replaced.push(o);
  }
  const gone = (w: OcrWord) => replaced.some((r) => centerIn(w, r) || overlap(w, r) > 0.5 * area(w));

  const font = page.node.newFontDictionary('OCR', ocrFont(doc));
  const inv = invertMatrix(m);
  const ops: string[] = [];
  /** Text space (x right, y up, origin on the baseline) -> user space. */
  const show = (text: string, x0: number, x1: number, base: number, size: number) => {
    const units = text.length;
    const scale = ((x1 - x0) / ((units * size * ADVANCE) / 1000)) * 100;
    if (!units || !(scale > 0.01)) return;
    ops.push(`${f(scale)} Tz ${mul([1, 0, 0, -1, x0, base], inv).map(f).join(' ')} Tm <${hex(text)}> Tj`);
  };

  for (const line of ocr.lines) {
    const runs = line.words.map((w) => (gone(w) ? [] : keptRuns(w, line.size, marks)));
    if (!runs.some((r) => r.length)) continue;
    ops.push(`${font.toString()} ${f(line.size)} Tf`);
    line.words.forEach((w, i) => {
      for (const r of runs[i]) show(r.text, r.x0, r.x1, w.base, line.size);
      // An explicit space between neighbors that both survive, filling the gap.
      const next = line.words[i + 1];
      const end = runs[i][runs[i].length - 1];
      const start = runs[i + 1]?.[0];
      if (next && end?.last && start?.first) {
        const gap = Math.max(next.x - (w.x + w.w), line.size * 0.05);
        show(' ', w.x + w.w, w.x + w.w + gap, (w.base + next.base) / 2, line.size);
      }
    });
  }
  if (!ops.length) return;
  const content = ['q', 'BT', '3 Tr', ...ops, 'ET', 'Q', ''].join('\n');
  const ctx = doc.context;
  const stream = ctx.register(ctx.flateStream(content));
  // First, so it starts from the default graphics state whatever the page does.
  const contents = page.node.normalizedEntries().Contents;
  if (contents) contents.insert(0, stream);
  else page.node.addContentStream(stream);
}

/* ------------------------------------------------------------------ */
/* The font                                                            */
/* ------------------------------------------------------------------ */

const fonts = new WeakMap<PDFDocument, PDFRef>();

function ocrFont(doc: PDFDocument): PDFRef {
  const hit = fonts.get(doc);
  if (hit) return hit;
  const ctx = doc.context;
  const ttf = glyphlessFont();
  const file = ctx.register(ctx.flateStream(ttf, { Length1: ttf.length }));
  const descriptor = ctx.register(
    ctx.obj({
      Type: 'FontDescriptor',
      FontName: 'FolioOCR',
      Flags: 4,
      FontBBox: [0, -200, 500, 800],
      ItalicAngle: 0,
      Ascent: 800,
      Descent: -200,
      CapHeight: 700,
      StemV: 80,
      FontFile2: file,
    }),
  );
  // Every code is drawn with glyph 1, which is empty.
  const gids = new Uint8Array(65536 * 2);
  for (let i = 1; i < gids.length; i += 2) gids[i] = 1;
  const cid = ctx.register(
    ctx.obj({
      Type: 'Font',
      Subtype: 'CIDFontType2',
      BaseFont: 'FolioOCR',
      CIDSystemInfo: { Registry: PDFString.of('Adobe'), Ordering: PDFString.of('Identity'), Supplement: 0 },
      FontDescriptor: descriptor,
      DW: ADVANCE,
      CIDToGIDMap: ctx.register(ctx.flateStream(gids)),
    }),
  );
  const ref = ctx.register(
    ctx.obj({
      Type: 'Font',
      Subtype: 'Type0',
      BaseFont: 'FolioOCR',
      Encoding: 'Identity-H',
      DescendantFonts: [cid],
      ToUnicode: ctx.register(ctx.flateStream(toUnicode())),
    }),
  );
  fonts.set(doc, ref);
  return ref;
}

/** Maps every two-byte code to the same UTF-16 code unit. */
function toUnicode() {
  const ranges: string[] = [];
  for (let hi = 0; hi < 256; hi++) {
    const h = hi.toString(16).padStart(2, '0');
    ranges.push(`<${h}00> <${h}ff> <${h}00>`);
  }
  const blocks: string[] = [];
  for (let i = 0; i < ranges.length; i += 100) {
    const part = ranges.slice(i, i + 100);
    blocks.push(`${part.length} beginbfrange`, ...part, 'endbfrange');
  }
  return [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<0000> <ffff>',
    'endcodespacerange',
    ...blocks,
    'endcmap',
    'CMapName currentdict /CMap defineresource pop',
    'end',
    'end',
    '',
  ].join('\n');
}

/**
 * A minimal TrueType font with two glyphs: .notdef (a triangle, as fonts are
 * expected to have one) and an empty glyph used for every character.
 */
function glyphlessFont(): Uint8Array {
  const u16 = (v: number) => [(v >> 8) & 255, v & 255];
  const i16 = (v: number) => u16(v < 0 ? v + 65536 : v);
  const u32 = (v: number) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
  const utf16 = (s: string) => [...s].flatMap((c) => u16(c.charCodeAt(0)));

  // .notdef: one contour through (0,0) (500,0) (250,700), coordinates as int16 deltas.
  const notdef = [...i16(1), ...i16(0), ...i16(0), ...i16(500), ...i16(700), ...u16(2), ...u16(0), 1, 1, 1, ...i16(0), ...i16(500), ...i16(-250), ...i16(0), ...i16(0), ...i16(700), 0];

  const names: [number, string][] = [
    [1, 'FolioOCR'],
    [2, 'Regular'],
    [4, 'FolioOCR'],
    [6, 'FolioOCR'],
  ];
  const nameData = names.map(([, s]) => utf16(s));
  const nameRecords = names.flatMap(([id], i) => [
    ...u16(3),
    ...u16(1),
    ...u16(0x409),
    ...u16(id),
    ...u16(nameData[i].length),
    ...u16(nameData.slice(0, i).reduce((t, d) => t + d.length, 0)),
  ]);

  const tables: Record<string, number[]> = {
    // format 4 with only the closing segment: no characters are mapped.
    cmap: [...u16(0), ...u16(1), ...u16(3), ...u16(1), ...u32(12), ...u16(4), ...u16(24), ...u16(0), ...u16(2), ...u16(2), ...u16(0), ...u16(0), ...u16(0xffff), ...u16(0), ...u16(0xffff), ...i16(1), ...u16(0)],
    glyf: notdef,
    head: [
      ...u32(0x00010000),
      ...u32(0x00010000),
      ...u32(0), // checkSumAdjustment, filled in below
      ...u32(0x5f0f3cf5),
      ...u16(0x000b),
      ...u16(1000),
      ...u32(0),
      ...u32(0),
      ...u32(0),
      ...u32(0),
      ...i16(0),
      ...i16(0),
      ...i16(500),
      ...i16(700),
      ...u16(0),
      ...u16(3),
      ...i16(2),
      ...i16(0), // short loca offsets
      ...i16(0),
    ],
    hhea: [...u32(0x00010000), ...i16(800), ...i16(-200), ...i16(0), ...u16(500), ...i16(0), ...i16(0), ...i16(500), ...i16(1), ...i16(0), ...i16(0), 0, 0, 0, 0, 0, 0, 0, 0, ...i16(0), ...u16(2)],
    hmtx: [...u16(500), ...i16(0), ...u16(500), ...i16(0)],
    loca: [...u16(0), ...u16(notdef.length / 2), ...u16(notdef.length / 2)],
    maxp: [...u32(0x00010000), ...u16(2), ...u16(3), ...u16(1), ...u16(0), ...u16(0), ...u16(2), ...new Array(16).fill(0)],
    name: [...u16(0), ...u16(names.length), ...u16(6 + names.length * 12), ...nameRecords, ...nameData.flat()],
    post: [...u32(0x00030000), ...u32(0), ...i16(-100), ...i16(50), ...u32(0), ...u32(0), ...u32(0), ...u32(0), ...u32(0)],
  };

  const tags = Object.keys(tables).sort();
  const pad = (a: number[]) => [...a, ...new Array((4 - (a.length % 4)) % 4).fill(0)];
  const checksum = (a: number[]) => {
    const p = pad(a);
    let sum = 0;
    for (let i = 0; i < p.length; i += 4) sum = (sum + ((p[i] << 24) | (p[i + 1] << 16) | (p[i + 2] << 8) | p[i + 3])) >>> 0;
    return sum;
  };
  const n = tags.length;
  const pow = 2 ** Math.floor(Math.log2(n));
  const header = [...u32(0x00010000), ...u16(n), ...u16(pow * 16), ...u16(Math.log2(pow)), ...u16(n * 16 - pow * 16)];
  let offset = 12 + n * 16;
  const dir: number[] = [];
  const body: number[] = [];
  let headAt = 0;
  for (const tag of tags) {
    const data = tables[tag];
    if (tag === 'head') headAt = offset;
    dir.push(...[...tag].map((c) => c.charCodeAt(0)), ...u32(checksum(data)), ...u32(offset), ...u32(data.length));
    const padded = pad(data);
    body.push(...padded);
    offset += padded.length;
  }
  const font = [...header, ...dir, ...body];
  const adjust = (0xb1b0afba - checksum(font)) >>> 0;
  font.splice(headAt + 8, 4, ...u32(adjust));
  return Uint8Array.from(font);
}
