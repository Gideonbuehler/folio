/**
 * A small PDF content-stream engine: tokenizes a page's drawing operators,
 * tracks enough graphics and text state to know where each text run and
 * image lands (in the page's own content and inside the form XObjects it
 * draws), and rewrites the streams to remove or move them. This is what lets
 * Edit mode change the real page content instead of painting over it.
 */
import { decodePDFRawStream, PDFArray, PDFContentStream, PDFDict, PDFDocument, PDFName, PDFNumber, PDFPage, PDFRawStream, PDFRef, PDFStream, StandardFontEmbedder } from '@cantoo/pdf-lib';

type FontNames = Parameters<typeof StandardFontEmbedder.for>[0];
import type { Matrix, Rect } from '../types';
import { applyMatrix, invertMatrix } from './geometry';

/* ------------------------------------------------------------------ */
/* Tokenizer                                                            */
/* ------------------------------------------------------------------ */

export interface PName {
  name: string;
}
export interface PStr {
  bytes: Uint8Array;
}
export type Val = number | boolean | null | PName | PStr | Val[] | Map<string, Val>;

export interface Operation {
  op: string;
  args: Val[];
  /** Byte range of the operands and operator in the source. */
  start: number;
  end: number;
}

const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

const isName = (v: Val): v is PName => typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Map) && 'name' in v;
const isStr = (v: Val): v is PStr => typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Map) && 'bytes' in v;

export function parseContent(b: Uint8Array): Operation[] {
  const n = b.length;
  let i = 0;
  const ops: Operation[] = [];
  let args: Val[] = [];
  let opStart = -1;

  const skip = () => {
    while (i < n) {
      const c = b[i];
      if (WS.has(c)) i++;
      else if (c === 0x25) {
        while (i < n && b[i] !== 0x0a && b[i] !== 0x0d) i++;
      } else break;
    }
  };

  const keyword = () => {
    const s = i;
    while (i < n && !WS.has(b[i]) && !DELIM.has(b[i])) i++;
    if (i === s) i++; // stray delimiter such as '}' — consume it
    return String.fromCharCode(...b.subarray(s, i));
  };

  const literal = (): PStr => {
    i++; // (
    const out: number[] = [];
    let depth = 1;
    while (i < n) {
      const c = b[i++];
      if (c === 0x5c) {
        const e = b[i++];
        if (e === 0x6e) out.push(0x0a);
        else if (e === 0x72) out.push(0x0d);
        else if (e === 0x74) out.push(0x09);
        else if (e === 0x62) out.push(0x08);
        else if (e === 0x66) out.push(0x0c);
        else if (e === 0x0d) {
          if (b[i] === 0x0a) i++;
        } else if (e === 0x0a) {
          /* line continuation */
        } else if (e >= 0x30 && e <= 0x37) {
          let v = e - 0x30;
          for (let k = 0; k < 2 && b[i] >= 0x30 && b[i] <= 0x37; k++) v = v * 8 + (b[i++] - 0x30);
          out.push(v & 0xff);
        } else out.push(e);
      } else if (c === 0x28) {
        depth++;
        out.push(c);
      } else if (c === 0x29) {
        if (--depth === 0) break;
        out.push(c);
      } else out.push(c);
    }
    return { bytes: Uint8Array.from(out) };
  };

  const hex = (): PStr => {
    i++; // <
    const out: number[] = [];
    let hi = -1;
    while (i < n && b[i] !== 0x3e) {
      const c = b[i++];
      const v = c >= 0x30 && c <= 0x39 ? c - 0x30 : c >= 0x41 && c <= 0x46 ? c - 55 : c >= 0x61 && c <= 0x66 ? c - 87 : -1;
      if (v < 0) continue;
      if (hi < 0) hi = v;
      else {
        out.push(hi * 16 + v);
        hi = -1;
      }
    }
    if (hi >= 0) out.push(hi * 16);
    i++; // >
    return { bytes: Uint8Array.from(out) };
  };

  const name = (): PName => {
    i++; // /
    const s = i;
    while (i < n && !WS.has(b[i]) && !DELIM.has(b[i])) i++;
    const raw = String.fromCharCode(...b.subarray(s, i));
    return { name: raw.replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))) };
  };

  // Returns a value, or a string for a bare keyword (operator).
  const value = (): Val | string => {
    skip();
    const c = b[i];
    if (c === 0x28) return literal();
    if (c === 0x3c) {
      if (b[i + 1] === 0x3c) {
        i += 2;
        const m = new Map<string, Val>();
        for (;;) {
          skip();
          if (i >= n) break;
          if (b[i] === 0x3e && b[i + 1] === 0x3e) {
            i += 2;
            break;
          }
          const k = value();
          const v = value();
          if (isName(k as Val)) m.set((k as PName).name, v as Val);
        }
        return m;
      }
      return hex();
    }
    if (c === 0x5b) {
      i++;
      const arr: Val[] = [];
      for (;;) {
        skip();
        if (i >= n) break;
        if (b[i] === 0x5d) {
          i++;
          break;
        }
        const v = value();
        if (typeof v !== 'string') arr.push(v);
      }
      return arr;
    }
    if (c === 0x2f) return name();
    if ((c >= 0x30 && c <= 0x39) || c === 0x2b || c === 0x2d || c === 0x2e) {
      const s = i;
      i++;
      while (i < n && ((b[i] >= 0x30 && b[i] <= 0x39) || b[i] === 0x2e)) i++;
      const v = parseFloat(String.fromCharCode(...b.subarray(s, i)));
      return Number.isFinite(v) ? v : 0;
    }
    const k = keyword();
    if (k === 'true') return true;
    if (k === 'false') return false;
    if (k === 'null') return null;
    return k;
  };

  while (i < n) {
    skip();
    if (i >= n) break;
    const tokStart = i;
    const v = value();
    if (opStart < 0) opStart = tokStart;
    if (typeof v !== 'string') {
      args.push(v);
      continue;
    }
    if (v === 'BI') {
      // Inline image: key/value pairs, ID, raw bytes, EI.
      const dict = new Map<string, Val>();
      for (;;) {
        skip();
        if (i >= n) break;
        const k = value();
        if (k === 'ID') break;
        const val = value();
        if (isName(k as Val)) dict.set((k as PName).name, val as Val);
      }
      i++; // single whitespace after ID
      const len = dict.get('L') ?? dict.get('Length');
      let end = -1;
      if (typeof len === 'number') {
        end = i + len;
        while (end < n && !(b[end] === 0x45 && b[end + 1] === 0x49)) end++;
      } else {
        for (let k = i; k < n - 1; k++) {
          if (b[k] === 0x45 && b[k + 1] === 0x49 && WS.has(b[k - 1]) && (k + 2 >= n || WS.has(b[k + 2]) || DELIM.has(b[k + 2]))) {
            end = k;
            break;
          }
        }
      }
      if (end < 0) end = n - 2;
      i = end + 2;
      ops.push({ op: 'BI', args: [dict], start: opStart, end: i });
    } else {
      ops.push({ op: v, args, start: opStart, end: i });
    }
    args = [];
    opStart = -1;
  }
  return ops;
}

/* ------------------------------------------------------------------ */
/* Interpreter                                                          */
/* ------------------------------------------------------------------ */

export function mul(m1: Matrix, m2: Matrix): Matrix {
  return [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
  ];
}

const ID: Matrix = [1, 0, 0, 1, 0, 0];
const EMPTY = new Uint8Array(0);

interface FontInfo {
  twoByte: boolean;
  width: (code: number) => number; // glyph space / 1000
  scale: number; // glyph space -> text space (Type3 FontMatrix)
}

/** One element of a text-showing operator: a glyph or a TJ kerning number. */
export interface RunItem {
  /** The glyph's code bytes (absent for kerning). */
  glyph?: Uint8Array;
  kern?: number;
  /** Start and end along the baseline, in text space from the run's origin. */
  x0: number;
  x1: number;
}

/**
 * A content stream: the page's own, or one drawing of a form XObject that the
 * page draws, directly or through other forms. A form drawn twice gives two
 * nodes, since each drawing sits somewhere else and is edited on its own.
 */
export interface StreamNode {
  bytes: Uint8Array;
  ops: Operation[];
  /** Resources its operators refer to. */
  resources: PDFDict | undefined;
  /** 0 for the page itself. */
  depth: number;
  /** Forms only: the XObject, and the `Do` operator in the parent stream that draws it here. */
  form?: {
    xobject: PDFStream;
    parent: StreamNode;
    index: number;
    /** Form space -> user space for this drawing. */
    matrix: Matrix;
  };
  /** `q` index -> matching `Q` index. */
  blockEnd: Map<number, number>;
  /** `q` index -> CTM when the block started. */
  blockCtm: Map<number, Matrix>;
  /** Indices of every operator that paints something, ascending. */
  paints: number[];
  /** BDC operators carrying a property dictionary inline (may hold /ActualText). */
  inlineProps: Map<number, string>;
}

/** An operator in one of the analysed streams. */
export interface OpRef {
  node: StreamNode;
  index: number;
}

export interface TextRun {
  node: StreamNode;
  index: number;
  /** User-space corners of the run. */
  quad: { x: number; y: number }[];
  /** Horizontal advance in unscaled text space. */
  advance: number;
  size: number;
  hscale: number;
  /** Text space (at the run's origin) -> user space. */
  m: Matrix;
  /** Vertical extent in text space. */
  lo: number;
  hi: number;
  items: RunItem[];
  /** Marked-content operators (BDC/BMC) enclosing the run, in its stream or the ones drawing it. */
  marked: OpRef[];
}

/** A painted vector path: its construction and painting operators. */
export interface PathHit {
  node: StreamNode;
  start: number;
  end: number;
  points: { x: number; y: number }[];
  /** The path sets a clip; removing it would change what else is visible. */
  clips: boolean;
}

/**
 * A form XObject whose content couldn't be analysed: it can't be decoded,
 * draws itself, or is nested too deeply. `node` and `index` are the `Do`.
 */
export interface FormHit {
  node: StreamNode;
  index: number;
  quad: { x: number; y: number }[];
}

export interface ImageHit {
  node: StreamNode;
  index: number;
  /** Unit square -> user space at the time of drawing. */
  ctm: Matrix;
  quad: { x: number; y: number }[];
  /** Indices of the `q` operators enclosing the image in its stream, outermost first. */
  enclosing: number[];
  /** Stencil masks paint with the fill color; they have no pixels of their own. */
  mask: boolean;
}

export interface Analysis {
  /** The page's own content stream. `ops`, `blockEnd`, `blockCtm`, `paints` and `inlineProps` are its. */
  root: StreamNode;
  /** Every stream analysed, parents before the forms they draw. */
  streams: StreamNode[];
  ops: Operation[];
  runs: TextRun[];
  images: ImageHit[];
  blockEnd: Map<number, number>;
  blockCtm: Map<number, Matrix>;
  paints: number[];
  paths: PathHit[];
  forms: FormHit[];
  inlineProps: Map<number, string>;
}

const PAINTS = new Set(['S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*', 'sh', 'Tj', 'TJ', "'", '"', 'Do', 'BI']);

/** Forms nested deeper than this, or past this many operators in all, aren't analysed. */
const MAX_DEPTH = 12;
const MAX_OPS = 2_000_000;

const STANDARD = new Set([
  'Helvetica',
  'Helvetica-Bold',
  'Helvetica-Oblique',
  'Helvetica-BoldOblique',
  'Times-Roman',
  'Times-Bold',
  'Times-Italic',
  'Times-BoldItalic',
  'Courier',
  'Courier-Bold',
  'Courier-Oblique',
  'Courier-BoldOblique',
]);
const cp1252 = new TextDecoder('windows-1252');

/** Glyph widths for the standard 14 fonts, which PDFs may use without a /Widths table. */
function standardWidths(name: string): ((code: number) => number) | null {
  if (!STANDARD.has(name)) return null;
  const embedder = StandardFontEmbedder.for(name as FontNames);
  const cache = new Map<number, number>();
  return (code) => {
    let w = cache.get(code);
    if (w === undefined) {
      try {
        w = embedder.widthOfTextAtSize(cp1252.decode(Uint8Array.of(code)), 1000);
      } catch {
        w = 500;
      }
      cache.set(code, w);
    }
    return w;
  };
}

function num(v: Val | undefined, d = 0) {
  return typeof v === 'number' ? v : d;
}

function newNode(bytes: Uint8Array, ops: Operation[], resources: PDFDict | undefined, depth: number, form?: StreamNode['form']): StreamNode {
  return { bytes, ops, resources, depth, form, blockEnd: new Map(), blockCtm: new Map(), paints: [], inlineProps: new Map() };
}

function dictOf(d: PDFDict, key: string): PDFDict | undefined {
  try {
    return d.lookupMaybe(PDFName.of(key), PDFDict);
  } catch {
    return undefined;
  }
}

/** The page's content, analysed with every form XObject it draws, or null if it has none. */
export function analyzePage(page: PDFPage): Analysis | null {
  const bytes = pageContentBytes(page);
  return bytes ? analyze(parseContent(bytes), page.doc, page.node.Resources(), bytes) : null;
}

/**
 * Follows the drawing operators of a content stream (`bytes` parsed into
 * `ops`) and of every form XObject it draws, recording where each text run,
 * image and path lands in user space.
 */
export function analyze(ops: Operation[], doc: PDFDocument, resources: PDFDict | undefined, bytes: Uint8Array = EMPTY): Analysis {
  const ctx = doc.context;
  const fontCaches = new Map<PDFDict | undefined, Map<string, FontInfo>>();
  const parsed = new Map<PDFStream, { bytes: Uint8Array; ops: Operation[] } | null>();
  const streams: StreamNode[] = [];
  const runs: TextRun[] = [];
  const images: ImageHit[] = [];
  const paths: PathHit[] = [];
  const forms: FormHit[] = [];
  const markedStack: OpRef[] = [];
  /** Forms being drawn right now, so one that draws itself is caught. */
  const drawing = new Set<PDFStream>();
  let budget = MAX_OPS;

  const loadFont = (res: PDFDict | undefined, fname: string): FontInfo => {
    let cache = fontCaches.get(res);
    if (!cache) fontCaches.set(res, (cache = new Map()));
    const hit = cache.get(fname);
    if (hit) return hit;
    let info: FontInfo = { twoByte: false, width: () => 500, scale: 1 };
    try {
      const fd = res && dictOf(res, 'Font')?.lookupMaybe(PDFName.of(fname), PDFDict);
      if (fd) {
        const subtype = fd.get(PDFName.of('Subtype'))?.toString();
        const numbers = (a: PDFArray | undefined) => (a ? a.asArray().map((x) => (ctx.lookup(x) as PDFNumber)?.asNumber?.() ?? 0) : []);
        if (subtype === '/Type0') {
          const kids = fd.lookupMaybe(PDFName.of('DescendantFonts'), PDFArray);
          const cid = kids ? (ctx.lookup(kids.get(0)) as PDFDict | undefined) : undefined;
          const dw = (cid?.lookupMaybe(PDFName.of('DW'), PDFNumber)?.asNumber() ?? 1000) as number;
          const widths = new Map<number, number>();
          const w = cid?.lookupMaybe(PDFName.of('W'), PDFArray);
          if (w) {
            const items = w.asArray().map((x) => ctx.lookup(x) ?? x);
            for (let k = 0; k < items.length; ) {
              const first = (items[k] as PDFNumber).asNumber();
              const next = items[k + 1];
              if (next instanceof PDFArray) {
                numbers(next).forEach((v, j) => widths.set(first + j, v));
                k += 2;
              } else {
                const last = (next as PDFNumber).asNumber();
                const v = (items[k + 2] as PDFNumber).asNumber();
                for (let c = first; c <= last && c - first < 65536; c++) widths.set(c, v);
                k += 3;
              }
            }
          }
          info = { twoByte: true, width: (c) => widths.get(c) ?? dw, scale: 1 };
        } else {
          const first = fd.lookupMaybe(PDFName.of('FirstChar'), PDFNumber)?.asNumber() ?? 0;
          const widths = numbers(fd.lookupMaybe(PDFName.of('Widths'), PDFArray));
          const desc = fd.lookupMaybe(PDFName.of('FontDescriptor'), PDFDict);
          const missing = desc?.lookupMaybe(PDFName.of('MissingWidth'), PDFNumber)?.asNumber() ?? 0;
          const base = fd.get(PDFName.of('BaseFont'))?.toString() ?? '';
          const fallback = /Courier/i.test(base) ? 600 : 500;
          const std = !widths.length ? standardWidths(base.replace(/^\/([A-Z]{6}\+)?/, '')) : null;
          let scale = 1;
          if (subtype === '/Type3') {
            const fm = numbers(fd.lookupMaybe(PDFName.of('FontMatrix'), PDFArray));
            scale = fm.length ? fm[0] * 1000 : 1;
          }
          info = {
            twoByte: false,
            width: (c) => (widths.length ? (widths[c - first] ?? (missing || fallback)) : std ? std(c) : fallback),
            scale,
          };
        }
      }
    } catch {
      /* keep the estimate */
    }
    cache.set(fname, info);
    return info;
  };

  const formContent = (xo: PDFStream) => {
    if (!parsed.has(xo)) {
      let content: { bytes: Uint8Array; ops: Operation[] } | null = null;
      try {
        const b = streamBytes(xo);
        if (b) content = { bytes: b, ops: parseContent(b) };
      } catch {
        /* an unsupported filter: the form stays opaque */
      }
      parsed.set(xo, content);
    }
    return parsed.get(xo)!;
  };

  // Graphics and text state. A form starts from the state it's drawn in, and
  // everything it changes is undone when it ends.
  let ctm: Matrix = ID;
  let tm: Matrix = ID;
  let tlm: Matrix = ID;
  let font: FontInfo = { twoByte: false, width: () => 500, scale: 1 };
  let size = 0;
  let tc = 0;
  let tw = 0;
  let th = 1;
  let tl = 0;
  let ts = 0;

  const drawForm = (parent: StreamNode, index: number, xo: PDFStream) => {
    const nums = (k: string) => {
      try {
        const arr = xo.dict.lookupMaybe(PDFName.of(k), PDFArray);
        return arr ? arr.asArray().map((v) => (ctx.lookup(v) as PDFNumber)?.asNumber?.() ?? 0) : null;
      } catch {
        return null;
      }
    };
    const bb = nums('BBox') ?? [0, 0, 1e5, 1e5];
    const fm = nums('Matrix');
    const matrix = mul(fm?.length === 6 ? (fm as Matrix) : ID, ctm);
    const content = parent.depth < MAX_DEPTH && !drawing.has(xo) && budget > 0 ? formContent(xo) : null;
    if (!content) {
      const q = [applyMatrix(matrix, bb[0], bb[1]), applyMatrix(matrix, bb[2], bb[1]), applyMatrix(matrix, bb[2], bb[3]), applyMatrix(matrix, bb[0], bb[3])];
      forms.push({ node: parent, index, quad: q });
      return;
    }
    // A form without resources of its own uses those of the stream drawing it.
    const res = dictOf(xo.dict, 'Resources') ?? parent.resources;
    const node = newNode(content.bytes, content.ops, res, parent.depth + 1, { xobject: xo, parent, index, matrix });
    const saved = { ctm, tm, tlm, font, size, tc, tw, th, tl, ts };
    const marks = markedStack.length;
    ctm = matrix;
    drawing.add(xo);
    interpret(node);
    drawing.delete(xo);
    markedStack.length = marks;
    ({ ctm, tm, tlm, font, size, tc, tw, th, tl, ts } = saved);
  };

  const interpret = (node: StreamNode) => {
    streams.push(node);
    budget -= node.ops.length;
    const { ops, resources: res } = node;
    const xobjects = res && dictOf(res, 'XObject');
    const stack: Matrix[] = [];
    const qStack: number[] = [];
    let pathStart = -1;
    let pathPts: { x: number; y: number }[] = [];
    let pathClips = false;

    const nextLine = (tx: number, ty: number) => {
      tlm = mul([1, 0, 0, 1, tx, ty], tlm);
      tm = tlm;
    };

    const show = (index: number, parts: Val[]) => {
      let adv = 0;
      const items: RunItem[] = [];
      for (const p of parts) {
        if (typeof p === 'number') {
          const d = (-p / 1000) * size * th;
          items.push({ kern: p, x0: adv, x1: adv + d });
          adv += d;
        } else if (isStr(p)) {
          const bytes = p.bytes;
          const step = font.twoByte ? 2 : 1;
          for (let k = 0; k + step - 1 < bytes.length; k += step) {
            const code = step === 2 ? (bytes[k] << 8) | bytes[k + 1] : bytes[k];
            const w0 = (font.width(code) / 1000) * font.scale;
            const space = !font.twoByte && code === 32 ? tw : 0;
            const d = (w0 * size + tc + space) * th;
            items.push({ glyph: bytes.subarray(k, k + step), x0: adv, x1: adv + d });
            adv += d;
          }
        }
      }
      const m = mul(tm, ctm);
      const lo = ts - 0.25 * size;
      const hi = ts + 0.85 * size;
      const quad = [applyMatrix(m, 0, lo), applyMatrix(m, adv, lo), applyMatrix(m, adv, hi), applyMatrix(m, 0, hi)];
      runs.push({ node, index, quad, advance: adv, size, hscale: th, m, lo, hi, items, marked: [...markedStack] });
      tm = mul([1, 0, 0, 1, adv, 0], tm);
    };

    const imageAt = (index: number, mask = false) => {
      images.push({
        node,
        index,
        ctm,
        quad: [applyMatrix(ctm, 0, 0), applyMatrix(ctm, 1, 0), applyMatrix(ctm, 1, 1), applyMatrix(ctm, 0, 1)],
        enclosing: [...qStack],
        mask,
      });
    };
    const addPoint = (index: number, x: number, y: number) => {
      if (pathStart < 0) pathStart = index;
      pathPts.push(applyMatrix(ctm, x, y));
    };

    ops.forEach((o, index) => {
      const a = o.args;
      if (PAINTS.has(o.op)) node.paints.push(index);
      switch (o.op) {
        case 'q':
          stack.push(ctm);
          qStack.push(index);
          node.blockCtm.set(index, ctm);
          break;
        case 'Q': {
          ctm = stack.pop() ?? ctm;
          const start = qStack.pop();
          if (start !== undefined) node.blockEnd.set(start, index);
          break;
        }
        case 'cm':
          ctm = mul([num(a[0], 1), num(a[1]), num(a[2]), num(a[3], 1), num(a[4]), num(a[5])], ctm);
          break;
        case 'BT':
          tm = tlm = ID;
          break;
        case 'Tf':
          if (isName(a[0])) font = loadFont(res, a[0].name);
          size = num(a[1]);
          break;
        case 'Tc':
          tc = num(a[0]);
          break;
        case 'Tw':
          tw = num(a[0]);
          break;
        case 'Tz':
          th = num(a[0], 100) / 100;
          break;
        case 'TL':
          tl = num(a[0]);
          break;
        case 'Ts':
          ts = num(a[0]);
          break;
        case 'Td':
          nextLine(num(a[0]), num(a[1]));
          break;
        case 'TD':
          tl = -num(a[1]);
          nextLine(num(a[0]), num(a[1]));
          break;
        case 'Tm':
          tm = tlm = [num(a[0], 1), num(a[1]), num(a[2]), num(a[3], 1), num(a[4]), num(a[5])];
          break;
        case 'T*':
          nextLine(0, -tl);
          break;
        case 'Tj':
          show(index, [a[0]]);
          break;
        case 'TJ':
          show(index, Array.isArray(a[0]) ? a[0] : []);
          break;
        case "'":
          nextLine(0, -tl);
          show(index, [a[0]]);
          break;
        case '"':
          tw = num(a[0]);
          tc = num(a[1]);
          nextLine(0, -tl);
          show(index, [a[2]]);
          break;
        case 'Do': {
          if (!isName(a[0])) break;
          let xo: PDFStream | undefined;
          try {
            xo = xobjects?.lookupMaybe(PDFName.of(a[0].name), PDFStream);
          } catch {
            break;
          }
          const subtype = xo?.dict.get(PDFName.of('Subtype'))?.toString();
          if (subtype === '/Image') imageAt(index, xo!.dict.get(PDFName.of('ImageMask'))?.toString() === 'true');
          else if (subtype === '/Form' && xo) drawForm(node, index, xo);
          break;
        }
        case 'BI': {
          const dict = a[0] instanceof Map ? a[0] : undefined;
          const im = dict?.get('IM') ?? dict?.get('ImageMask');
          imageAt(index, im === true);
          break;
        }
        case 'BDC':
          markedStack.push({ node, index });
          if (a[1] instanceof Map && isName(a[0])) node.inlineProps.set(index, a[0].name);
          break;
        case 'BMC':
          markedStack.push({ node, index });
          break;
        case 'EMC':
          markedStack.pop();
          break;
        case 'm':
        case 'l':
          addPoint(index, num(a[0]), num(a[1]));
          break;
        case 'c':
          addPoint(index, num(a[0]), num(a[1]));
          addPoint(index, num(a[2]), num(a[3]));
          addPoint(index, num(a[4]), num(a[5]));
          break;
        case 'v':
        case 'y':
          addPoint(index, num(a[0]), num(a[1]));
          addPoint(index, num(a[2]), num(a[3]));
          break;
        case 're': {
          const [x, y, w, h] = [num(a[0]), num(a[1]), num(a[2]), num(a[3])];
          addPoint(index, x, y);
          addPoint(index, x + w, y);
          addPoint(index, x + w, y + h);
          addPoint(index, x, y + h);
          break;
        }
        case 'W':
        case 'W*':
          pathClips = true;
          break;
        case 'S':
        case 's':
        case 'f':
        case 'F':
        case 'f*':
        case 'B':
        case 'B*':
        case 'b':
        case 'b*':
        case 'n':
          if (pathStart >= 0 && o.op !== 'n') paths.push({ node, start: pathStart, end: index, points: pathPts, clips: pathClips });
          pathStart = -1;
          pathPts = [];
          pathClips = false;
          break;
      }
    });
  };

  const root = newNode(bytes, ops, resources, 0);
  interpret(root);
  return {
    root,
    streams,
    ops,
    runs,
    images,
    blockEnd: root.blockEnd,
    blockCtm: root.blockCtm,
    paints: root.paints,
    paths,
    forms,
    inlineProps: root.inlineProps,
  };
}

/**
 * The largest q…Q block around an image that draws nothing else. Moving that
 * whole block moves the image together with its clip path (PowerPoint and Word
 * clip every picture to its frame), so the image isn't cut off at its old spot.
 * Indices are in the image's own stream.
 */
export function isolateImage(hit: ImageHit): { start: number; end: number; ctm: Matrix } {
  const { node } = hit;
  let best = { start: hit.index, end: hit.index, ctm: hit.ctm };
  for (let k = hit.enclosing.length - 1; k >= 0; k--) {
    const q = hit.enclosing[k];
    const end = node.blockEnd.get(q);
    if (end === undefined) break;
    if (node.paints.some((p) => p > q && p < end && p !== hit.index)) break;
    best = { start: q, end, ctm: node.blockCtm.get(q)! };
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* Page helpers                                                         */
/* ------------------------------------------------------------------ */

/** Decoded bytes of a stream, or null when it can't be decoded. */
export function streamBytes(s: PDFStream): Uint8Array | null {
  if (s instanceof PDFRawStream) return decodePDFRawStream(s).decode();
  if (s instanceof PDFContentStream) return s.getUnencodedContents();
  return s.getContents();
}

export function pageContentBytes(page: PDFPage): Uint8Array | null {
  const ctx = page.doc.context;
  const contents = page.node.Contents();
  if (!contents) return null;
  const streams = contents instanceof PDFArray ? contents.asArray().map((r) => ctx.lookup(r)) : [contents];
  const parts: Uint8Array[] = [];
  for (const s of streams) {
    if (!(s instanceof PDFStream)) return null;
    const b = streamBytes(s);
    if (!b) return null;
    parts.push(b);
  }
  const total = parts.reduce((t, p) => t + p.length + 1, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
    out[at++] = 0x0a;
  }
  return out;
}

export function setPageContent(page: PDFPage, bytes: Uint8Array) {
  const ctx = page.doc.context;
  const ref: PDFRef = ctx.register(ctx.flateStream(bytes));
  // Always an array: pdf-lib appends to it when we draw on the page afterwards.
  page.node.set(PDFName.of('Contents'), ctx.obj([ref]));
}

/** Stream entries that describe the old encoded bytes rather than the form. */
const STREAM_KEYS = new Set(['Length', 'Filter', 'DecodeParms', 'DL']);

/**
 * Changes to a page's content, collected per stream (see Analysis) and then
 * written in one go. A form XObject with changes is never modified: the
 * drawing that was edited gets a copy of the form with the new content, so
 * other pages, and other drawings of it on this page, stay as they were.
 */
export class ContentEdits {
  private reps = new Map<StreamNode, Map<number, string | Uint8Array>>();
  /** New XObjects the copy of a form needs, by name. */
  private extra = new Map<StreamNode, Map<string, PDFRef>>();
  /** User-space points the copy of a form must show (where moved images went). */
  private reach = new Map<StreamNode, { x: number; y: number }[]>();

  constructor(private page: PDFPage) {}

  /** Replaces operator `index` of `node` with new source. */
  set(node: StreamNode, index: number, rep: string | Uint8Array) {
    let m = this.reps.get(node);
    if (!m) this.reps.set(node, (m = new Map()));
    m.set(index, rep);
  }

  has(node: StreamNode, index: number) {
    return !!this.reps.get(node)?.has(index);
  }

  get size() {
    let n = 0;
    for (const m of this.reps.values()) n += m.size;
    return n;
  }

  /** Makes an XObject available to `node`'s operators and returns its name, such as "/Redacted1". */
  xobject(node: StreamNode, tag: string, ref: PDFRef): string {
    if (!node.form) return this.page.node.newXObject(tag, ref).toString();
    let names = this.extra.get(node);
    if (!names) this.extra.set(node, (names = new Map()));
    const taken = node.resources && dictOf(node.resources, 'XObject');
    let k = 1;
    let name = `${tag}${k}`;
    while (names.has(name) || taken?.has(PDFName.of(name))) name = `${tag}${++k}`;
    names.set(name, ref);
    return `/${name}`;
  }

  /**
   * Widens the bounding box of the form drawing `node` (and of every form
   * drawing that one) to take in these user-space points, so content moved
   * outside the form's old box isn't clipped away.
   */
  include(node: StreamNode, pts: { x: number; y: number }[]) {
    for (let n = node; n.form; n = n.form.parent) {
      const list = this.reach.get(n);
      if (list) list.push(...pts);
      else this.reach.set(n, [...pts]);
    }
  }

  /** Writes everything: a new content stream for the page, copies of changed forms. */
  commit() {
    const ctx = this.page.doc.context;
    const done = new Set<StreamNode>();
    for (;;) {
      // Deepest first: a form's copy changes the `Do` in the stream drawing it.
      let node: StreamNode | null = null;
      for (const n of [...this.reps.keys(), ...this.extra.keys(), ...this.reach.keys()]) {
        if (!done.has(n) && (!node || n.depth > node.depth)) node = n;
      }
      if (!node) break;
      done.add(node);
      const reps = this.reps.get(node);
      const bytes = reps?.size ? rewrite(node.bytes, node.ops, reps) : node.bytes;
      if (!node.form) {
        if (reps?.size) setPageContent(this.page, bytes);
        continue;
      }
      const { xobject, parent, index, matrix } = node.form;
      const copy = ctx.flateStream(bytes);
      for (const [k, v] of xobject.dict.entries()) if (!STREAM_KEYS.has(k.asString().slice(1))) copy.dict.set(k, v);
      const extra = this.extra.get(node);
      if (extra) {
        const res = node.resources ? node.resources.clone(ctx) : ctx.obj({});
        const xo = dictOf(res, 'XObject')?.clone(ctx) ?? ctx.obj({});
        for (const [name, ref] of extra) xo.set(PDFName.of(name), ref);
        res.set(PDFName.of('XObject'), xo);
        copy.dict.set(PDFName.of('Resources'), res);
      }
      const pts = this.reach.get(node);
      if (pts?.length) {
        const inv = invertMatrix(matrix);
        const bb = xobject.dict.lookupMaybe(PDFName.of('BBox'), PDFArray);
        const box = bb ? bb.asArray().map((v) => (ctx.lookup(v) as PDFNumber)?.asNumber?.() ?? 0) : null;
        if (box?.length === 4) {
          const local = pts.map((p) => applyMatrix(inv, p.x, p.y));
          const xs = [box[0], box[2], ...local.map((p) => p.x)];
          const ys = [box[1], box[3], ...local.map((p) => p.y)];
          copy.dict.set(PDFName.of('BBox'), ctx.obj([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]));
        }
      }
      const name = this.xobject(parent, 'Fm', ctx.register(copy));
      this.set(parent, index, `${name} Do`);
    }
  }
}

const fmt = (v: number) => (Math.abs(v) < 1e-6 ? '0' : String(Number(v.toFixed(5))));

/** Replacement bytes for a text-showing operator that keep the text cursor where it was. */
export function silenceRun(op: Operation, run: TextRun): string {
  const k = run.size * run.hscale;
  const skip = k ? `[${fmt((-run.advance * 1000) / k)}] TJ` : '';
  if (op.op === "'") return `T* ${skip}`;
  if (op.op === '"') return `${fmt(num(op.args[0]))} Tw ${fmt(num(op.args[1]))} Tc T* ${skip}`;
  return skip;
}

/** Hex string literal for raw glyph bytes. */
function hexOf(bytes: Uint8Array[]) {
  let s = '<';
  for (const b of bytes) for (const v of b) s += v.toString(16).padStart(2, '0');
  return `${s}>`;
}

/**
 * Rewrites a text-showing operator without the glyphs `drop` selects, keeping
 * every remaining glyph exactly where it was. Removed glyphs become kerning
 * gaps, so nothing after them shifts. Returns null when nothing is dropped.
 */
export function redactRun(op: Operation, run: TextRun, drop: (item: RunItem) => boolean): string | null {
  if (!run.items.some((it) => it.glyph && drop(it))) return null;
  const k = run.size * run.hscale;
  const parts: string[] = [];
  let pending: Uint8Array[] = [];
  let gap = 0;
  const flushText = () => {
    if (pending.length) parts.push(hexOf(pending));
    pending = [];
  };
  const flushGap = () => {
    if (gap) parts.push(fmt(gap));
    gap = 0;
  };
  for (const it of run.items) {
    if (it.kern !== undefined) {
      flushText();
      gap += it.kern;
    } else if (it.glyph && drop(it)) {
      flushText();
      if (k) gap += (-(it.x1 - it.x0) * 1000) / k;
    } else if (it.glyph) {
      flushGap();
      pending.push(it.glyph);
    }
  }
  flushText();
  flushGap();
  const tj = `[${parts.join(' ')}] TJ`;
  if (op.op === "'") return `T* ${tj}`;
  if (op.op === '"') return `${fmt(num(op.args[0]))} Tw ${fmt(num(op.args[1]))} Tc T* ${tj}`;
  return tj;
}

/** Original operators (from `first` through `last`) drawn under an extra transform. */
export function wrapInTransform(src: Uint8Array, first: Operation, last: Operation, m: Matrix): Uint8Array {
  return concat([ascii(`q ${m.map(fmt).join(' ')} cm\n`), src.subarray(first.start, last.end), ascii('\nQ')]);
}

/** Applies replacements (op index -> new source) to the stream bytes. */
export function rewrite(src: Uint8Array, ops: Operation[], replacements: Map<number, string | Uint8Array>): Uint8Array {
  const chunks: Uint8Array[] = [];
  let at = 0;
  for (const [index, rep] of [...replacements.entries()].sort((a, b) => a[0] - b[0])) {
    const op = ops[index];
    chunks.push(src.subarray(at, op.start), ascii(' '), typeof rep === 'string' ? ascii(rep) : rep, ascii(' '));
    at = op.end;
  }
  chunks.push(src.subarray(at));
  return concat(chunks);
}

function ascii(s: string) {
  const out = new Uint8Array(s.length);
  for (let k = 0; k < s.length; k++) out[k] = s.charCodeAt(k) & 0x7f;
  return out;
}

function concat(chunks: Uint8Array[]) {
  const out = new Uint8Array(chunks.reduce((t, c) => t + c.length, 0));
  let p = 0;
  for (const c of chunks) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}

/** Axis-aligned bounds of a quad after mapping into page space. */
export function quadRect(quad: { x: number; y: number }[], m: Matrix): Rect {
  const pts = quad.map((p) => applyMatrix(m, p.x, p.y));
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

export function overlap(a: Rect, b: Rect) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}
