/**
 * "Reduce file size": shrinks a finished document in place. Images shown at a
 * higher resolution than needed are downsampled, large photos without
 * transparency are stored as JPEG, identical streams (images, fonts, content
 * that came in twice when combining files) are stored once, uncompressed
 * streams are compressed, and embedded thumbnails and other applications'
 * private data are dropped. Unused objects are collected by the caller.
 */
import { zlibSync } from 'fflate';
import {
  decodePDFRawStream,
  PDFArray,
  PDFContentStream,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
} from '@cantoo/pdf-lib';
import type { Matrix } from '../types';
import { mul, parseContent } from './content';

export interface ReduceOptions {
  /** Images shown above this resolution are downsampled to it. */
  dpi: number;
  /** JPEG quality, 0..1. */
  quality: number;
}

export interface ReduceStats {
  images: number;
  duplicates: number;
}

export const REDUCE_PRESETS = [
  { id: 'small', label: 'Smallest', dpi: 150, quality: 0.62, hint: '150 dpi images, for screen and email' },
  { id: 'balanced', label: 'Balanced', dpi: 220, quality: 0.75, hint: '220 dpi images, good for office printing' },
  { id: 'high', label: 'High quality', dpi: 300, quality: 0.85, hint: '300 dpi images, for print' },
] as const;

export type ReducePreset = (typeof REDUCE_PRESETS)[number]['id'];

const name = (s: string) => PDFName.of(s);

export async function reduceDocument(doc: PDFDocument, opts: ReduceOptions, onProgress?: (t: string) => void): Promise<ReduceStats> {
  dropPrivateData(doc);
  onProgress?.('Removing duplicate data…');
  const duplicates = dedupeStreams(doc);
  const boxes = imagePlacements(doc);
  // Soft masks are images too; they're found through their parent's /SMask.
  const masks = new Set<string>();
  for (const [, o] of doc.context.enumerateIndirectObjects()) {
    const sm = o instanceof PDFStream ? o.dict.get(name('SMask')) : undefined;
    if (sm instanceof PDFRef) masks.add(sm.tag);
  }
  let images = 0;
  const targets = [...boxes.keys()];
  for (const [i, tag] of targets.entries()) {
    onProgress?.(`Optimizing images (${i + 1} of ${targets.length})…`);
    try {
      if (await optimizeImage(doc, tag, boxes.get(tag)!, masks.has(tag), opts)) images++;
    } catch (e) {
      console.warn('Image left as it was', e);
    }
  }
  onProgress?.('Compressing…');
  compressStreams(doc);
  return { images, duplicates };
}

/* ------------------------------------------------------------------ */
/* Thumbnails and private application data                              */
/* ------------------------------------------------------------------ */

function dropPrivateData(doc: PDFDocument) {
  for (const page of doc.getPages()) {
    page.node.delete(name('Thumb'));
    page.node.delete(name('PieceInfo'));
  }
  doc.catalog.delete(name('PieceInfo'));
}

/* ------------------------------------------------------------------ */
/* Duplicate streams                                                    */
/* ------------------------------------------------------------------ */

/** The parts of a stream that decide whether two are interchangeable. */
function streamKey(s: PDFStream) {
  let key = '';
  for (const [k, v] of s.dict.entries()) {
    if (k === name('Length')) continue;
    key += `${k.toString()} ${v.toString()}\n`;
  }
  return key;
}

function sameBytes(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Points every reference to a duplicate stream at its first copy. Repeats, so
 * images whose soft masks were duplicates become duplicates themselves.
 */
function dedupeStreams(doc: PDFDocument) {
  const ctx = doc.context;
  let total = 0;
  for (let round = 0; round < 4; round++) {
    const buckets = new Map<string, { ref: PDFRef; bytes: Uint8Array }[]>();
    const replace = new Map<string, PDFRef>();
    for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
      if (!(obj instanceof PDFRawStream) && !(obj instanceof PDFContentStream)) continue;
      const type = obj.dict.get(name('Type'));
      if (type === name('XRef') || type === name('ObjStm')) continue;
      const bytes = obj.getContents();
      const key = `${bytes.length}|${streamKey(obj)}`;
      const list = buckets.get(key);
      const twin = list?.find((c) => sameBytes(c.bytes, bytes));
      if (twin) replace.set(ref.tag, twin.ref);
      else if (list) list.push({ ref, bytes });
      else buckets.set(key, [{ ref, bytes }]);
    }
    if (!replace.size) break;
    total += replace.size;
    retarget(doc, replace);
    for (const tag of replace.keys()) {
      const [num, gen] = tag.split(' ').map(Number);
      ctx.delete(PDFRef.of(num, gen));
    }
  }
  return total;
}

/** Rewrites references (by tag) throughout the document. */
function retarget(doc: PDFDocument, replace: Map<string, PDFRef>) {
  const ctx = doc.context;
  const fix = (o: PDFObject | undefined, seen: Set<PDFObject>) => {
    if (!o || seen.has(o)) return;
    seen.add(o);
    if (o instanceof PDFDict) {
      for (const [k, v] of o.entries()) {
        if (v instanceof PDFRef) {
          const to = replace.get(v.tag);
          if (to) o.set(k, to);
        } else fix(v, seen);
      }
    } else if (o instanceof PDFArray) {
      for (let i = 0; i < o.size(); i++) {
        const v = o.get(i);
        if (v instanceof PDFRef) {
          const to = replace.get(v.tag);
          if (to) o.set(i, to);
        } else fix(v, seen);
      }
    } else if (o instanceof PDFStream) fix(o.dict, seen);
  };
  const seen = new Set<PDFObject>();
  for (const [, obj] of ctx.enumerateIndirectObjects()) fix(obj, seen);
  fix(ctx.trailerInfo.Root, seen);
}

/* ------------------------------------------------------------------ */
/* Where images are shown                                               */
/* ------------------------------------------------------------------ */

interface Box {
  /** Largest size the image is shown at, in points. */
  w: number;
  h: number;
}

function decodedContent(s: PDFObject | undefined): Uint8Array | null {
  try {
    if (s instanceof PDFRawStream) return decodePDFRawStream(s).decode();
    if (s instanceof PDFContentStream) return s.getUnencodedContents();
  } catch {
    /* unreadable stream */
  }
  return null;
}

function numbers(ctx: PDFDocument['context'], a: PDFObject | undefined): number[] {
  const arr = a instanceof PDFRef ? ctx.lookup(a) : a;
  if (!(arr instanceof PDFArray)) return [];
  return arr.asArray().map((v) => {
    const n = v instanceof PDFRef ? ctx.lookup(v) : v;
    return n instanceof PDFNumber ? n.asNumber() : 0;
  });
}

/**
 * The largest size each image XObject is drawn at, found by following the
 * transformation matrix through every page, form XObject and annotation
 * appearance. Images that are never found this way (patterns, Type 3 glyphs)
 * are left alone.
 */
function imagePlacements(doc: PDFDocument): Map<string, Box> {
  const ctx = doc.context;
  const boxes = new Map<string, Box>();
  const record = (ref: PDFRef, ctm: Matrix, img: PDFStream) => {
    const w = Math.hypot(ctm[0], ctm[1]);
    const h = Math.hypot(ctm[2], ctm[3]);
    for (const r of [ref, img.dict.get(name('SMask'))]) {
      if (!(r instanceof PDFRef)) continue;
      const b = boxes.get(r.tag);
      boxes.set(r.tag, { w: Math.max(b?.w ?? 0, w), h: Math.max(b?.h ?? 0, h) });
    }
  };

  const scan = (bytes: Uint8Array, resources: PDFDict | undefined, start: Matrix, path: Set<string>) => {
    if (path.size > 12) return;
    let ops;
    try {
      ops = parseContent(bytes);
    } catch {
      return;
    }
    const xobjects = resources?.lookupMaybe(name('XObject'), PDFDict);
    let ctm = start;
    const stack: Matrix[] = [];
    for (const op of ops) {
      if (op.op === 'q') stack.push(ctm);
      else if (op.op === 'Q') ctm = stack.pop() ?? ctm;
      else if (op.op === 'cm' && op.args.length === 6 && op.args.every((v) => typeof v === 'number')) ctm = mul(op.args as Matrix, ctm);
      else if (op.op === 'Do' && xobjects) {
        const arg = op.args[0];
        const key = arg && typeof arg === 'object' && 'name' in arg ? arg.name : null;
        if (!key) continue;
        const ref = xobjects.get(name(key));
        if (!(ref instanceof PDFRef) || path.has(ref.tag)) continue;
        const xo = ctx.lookup(ref);
        if (!(xo instanceof PDFStream)) continue;
        const subtype = xo.dict.get(name('Subtype'));
        if (subtype === name('Image')) record(ref, ctm, xo);
        else if (subtype === name('Form')) {
          const content = decodedContent(xo);
          if (!content) continue;
          const fm = numbers(ctx, xo.dict.get(name('Matrix')));
          const m = fm.length === 6 ? mul(fm as Matrix, ctm) : ctm;
          const res = xo.dict.lookupMaybe(name('Resources'), PDFDict) ?? resources;
          scan(content, res, m, new Set([...path, ref.tag]));
        }
      }
    }
  };

  for (const page of doc.getPages()) {
    const node = page.node;
    const contents = node.Contents();
    const parts = contents instanceof PDFArray ? contents.asArray().map((r) => ctx.lookup(r)) : [contents];
    const chunks = parts.map(decodedContent).filter((c): c is Uint8Array => !!c);
    const total = chunks.reduce((t, c) => t + c.length + 1, 0);
    const joined = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      joined.set(c, at);
      at += c.length;
      joined[at++] = 0x0a;
    }
    scan(joined, node.Resources(), [1, 0, 0, 1, 0, 0], new Set());

    // Annotation appearances are form XObjects mapped onto the annotation's rectangle.
    const annots = node.Annots();
    for (let i = 0; i < (annots?.size() ?? 0); i++) {
      const a = ctx.lookup(annots!.get(i));
      if (!(a instanceof PDFDict)) continue;
      const ap = a.lookupMaybe(name('AP'), PDFDict);
      const rect = numbers(ctx, a.get(name('Rect')));
      if (!ap || rect.length !== 4) continue;
      const appearances: PDFObject[] = [];
      for (const key of ['N', 'D', 'R']) {
        const v = ap.get(name(key));
        const o = v instanceof PDFRef ? ctx.lookup(v) : v;
        if (o instanceof PDFStream) appearances.push(v!);
        else if (o instanceof PDFDict) for (const [, s] of o.entries()) appearances.push(s);
      }
      for (const v of appearances) {
        const s = v instanceof PDFRef ? ctx.lookup(v) : v;
        if (!(s instanceof PDFStream)) continue;
        const content = decodedContent(s);
        const bbox = numbers(ctx, s.dict.get(name('BBox')));
        if (!content || bbox.length !== 4) continue;
        const fm = numbers(ctx, s.dict.get(name('Matrix')));
        const matrix = (fm.length === 6 ? fm : [1, 0, 0, 1, 0, 0]) as Matrix;
        const bw = Math.abs(bbox[2] - bbox[0]) || 1;
        const bh = Math.abs(bbox[3] - bbox[1]) || 1;
        const fit: Matrix = [Math.abs(rect[2] - rect[0]) / bw, 0, 0, Math.abs(rect[3] - rect[1]) / bh, 0, 0];
        scan(content, s.dict.lookupMaybe(name('Resources'), PDFDict), mul(matrix, fit), new Set(v instanceof PDFRef ? [v.tag] : []));
      }
    }
  }
  return boxes;
}

/* ------------------------------------------------------------------ */
/* Decoding images                                                      */
/* ------------------------------------------------------------------ */

const DECODABLE = new Set(['FlateDecode', 'LZWDecode', 'ASCII85Decode', 'ASCIIHexDecode', 'RunLengthDecode']);

interface ColorInfo {
  /** Components per pixel of the base color space (1 gray, 3 RGB). */
  n: 1 | 3;
  /** Color space for the re-encoded image. */
  out: PDFObject;
  /** Indexed images: palette (n bytes per entry) and highest index. */
  palette?: Uint8Array;
  hival?: number;
}

function stringBytes(o: PDFObject | undefined): Uint8Array | null {
  if (o instanceof PDFHexString || o instanceof PDFString) return o.asBytes();
  return null;
}

function colorInfo(doc: PDFDocument, raw: PDFObject | undefined, depth = 0): ColorInfo | null {
  const ctx = doc.context;
  const cs = raw instanceof PDFRef ? ctx.lookup(raw) : raw;
  if (!raw || !cs) return null;
  if (cs instanceof PDFName) {
    if (cs === name('DeviceRGB')) return { n: 3, out: raw };
    if (cs === name('DeviceGray')) return { n: 1, out: raw };
    return null;
  }
  if (!(cs instanceof PDFArray) || !cs.size()) return null;
  const family = cs.get(0);
  if (family === name('ICCBased')) {
    const profile = ctx.lookup(cs.get(1));
    const n = profile instanceof PDFStream ? profile.dict.lookupMaybe(name('N'), PDFNumber)?.asNumber() : undefined;
    return n === 1 || n === 3 ? { n, out: raw } : null;
  }
  if (family === name('CalRGB')) return { n: 3, out: raw };
  if (family === name('CalGray')) return { n: 1, out: raw };
  if (family === name('Indexed') && depth === 0 && cs.size() === 4) {
    const base = colorInfo(doc, cs.get(1), 1);
    const hivalObj = ctx.lookup(cs.get(2));
    const hival = hivalObj instanceof PDFNumber ? hivalObj.asNumber() : -1;
    if (!base || hival < 0) return null;
    const lk = cs.get(3);
    const lookup = lk instanceof PDFRef ? ctx.lookup(lk) : lk;
    const palette = lookup instanceof PDFRawStream ? decodedContent(lookup) : stringBytes(lookup);
    if (!palette || palette.length < (hival + 1) * base.n) return null;
    return { n: base.n, out: base.out, palette, hival };
  }
  return null;
}

function filtersOf(dict: PDFDict): { filters: string[]; params: (PDFDict | undefined)[] } {
  const f = dict.lookup(name('Filter'));
  const p = dict.lookup(name('DecodeParms'));
  const filters = f instanceof PDFName ? [f.decodeText()] : f instanceof PDFArray ? f.asArray().map((x) => (x instanceof PDFName ? x.decodeText() : '?')) : [];
  const params = filters.map((_, i) => {
    const v = p instanceof PDFArray ? p.lookup(i) : i === 0 ? p : undefined;
    return v instanceof PDFDict ? v : undefined;
  });
  return { filters, params };
}

const param = (d: PDFDict | undefined, key: string, fallback: number) => d?.lookupMaybe(name(key), PDFNumber)?.asNumber() ?? fallback;

/** Undoes PNG or TIFF predictors (8-bit samples only for TIFF). */
function unpredict(data: Uint8Array, params: PDFDict | undefined): Uint8Array | null {
  const predictor = param(params, 'Predictor', 1);
  if (predictor <= 1) return data;
  const colors = param(params, 'Colors', 1);
  const bpc = param(params, 'BitsPerComponent', 8);
  const columns = param(params, 'Columns', 1);
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowBytes = Math.ceil((colors * bpc * columns) / 8);
  if (predictor === 2) {
    if (bpc !== 8) return null;
    const out = data.slice();
    for (let r = 0; r + rowBytes <= out.length; r += rowBytes) for (let i = bpp; i < rowBytes; i++) out[r + i] = (out[r + i] + out[r + i - bpp]) & 255;
    return out;
  }
  const rows = Math.floor(data.length / (rowBytes + 1));
  const out = new Uint8Array(rows * rowBytes);
  for (let r = 0; r < rows; r++) {
    const type = data[r * (rowBytes + 1)];
    const src = r * (rowBytes + 1) + 1;
    const dst = r * rowBytes;
    for (let i = 0; i < rowBytes; i++) {
      const x = data[src + i];
      const a = i >= bpp ? out[dst + i - bpp] : 0;
      const b = r > 0 ? out[dst - rowBytes + i] : 0;
      const c = r > 0 && i >= bpp ? out[dst - rowBytes + i - bpp] : 0;
      let v: number;
      switch (type) {
        case 1:
          v = x + a;
          break;
        case 2:
          v = x + b;
          break;
        case 3:
          v = x + ((a + b) >> 1);
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          v = x;
      }
      out[dst + i] = v & 255;
    }
  }
  return out;
}

/** Decodes an image XObject to a canvas, or null if it uses something we don't handle. */
async function decodeImage(img: PDFRawStream, w: number, h: number, bpc: number, color: ColorInfo): Promise<HTMLCanvasElement | null> {
  const { filters, params } = filtersOf(img.dict);
  const dct = filters[filters.length - 1] === 'DCTDecode';
  const pre = dct ? filters.slice(0, -1) : filters;
  if (pre.some((f) => !DECODABLE.has(f))) return null;
  // Run the general-purpose filters through pdf-lib (predictors are applied below).
  const plain = img.dict.clone(img.dict.context);
  plain.delete(name('DecodeParms'));
  if (pre.length) plain.set(name('Filter'), img.dict.context.obj(pre.map((f) => name(f))));
  else plain.delete(name('Filter'));
  let bytes = decodePDFRawStream(PDFRawStream.of(plain, img.contents)).decode();
  if (pre.length) {
    const last = unpredict(bytes, params[pre.length - 1]);
    if (!last) return null;
    bytes = last;
  }

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d', { willReadFrequently: true })!;
  if (dct) {
    if (color.palette) return null;
    const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: 'image/jpeg' }), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    if (bitmap.width !== w || bitmap.height !== h) {
      bitmap.close();
      return null;
    }
    g.drawImage(bitmap, 0, 0);
    bitmap.close();
    return canvas;
  }

  const id = g.createImageData(w, h);
  const dst = id.data;
  if (color.palette) {
    if (![1, 2, 4, 8].includes(bpc)) return null;
    const rowBytes = Math.ceil((w * bpc) / 8);
    if (bytes.length < rowBytes * h) return null;
    const pal = color.palette;
    const mask = (1 << bpc) - 1;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const bit = x * bpc;
        let idx = (bytes[y * rowBytes + (bit >> 3)] >> (8 - bpc - (bit & 7))) & mask;
        if (idx > color.hival!) idx = color.hival!;
        const q = (y * w + x) * 4;
        if (color.n === 3) {
          dst[q] = pal[idx * 3];
          dst[q + 1] = pal[idx * 3 + 1];
          dst[q + 2] = pal[idx * 3 + 2];
        } else dst[q] = dst[q + 1] = dst[q + 2] = pal[idx];
        dst[q + 3] = 255;
      }
  } else {
    if (bpc !== 8 || bytes.length < w * h * color.n) return null;
    for (let p = 0, q = 0; q < dst.length; p += color.n, q += 4) {
      if (color.n === 3) {
        dst[q] = bytes[p];
        dst[q + 1] = bytes[p + 1];
        dst[q + 2] = bytes[p + 2];
      } else dst[q] = dst[q + 1] = dst[q + 2] = bytes[p];
      dst[q + 3] = 255;
    }
  }
  g.putImageData(id, 0, 0);
  return canvas;
}

/* ------------------------------------------------------------------ */
/* Re-encoding                                                          */
/* ------------------------------------------------------------------ */

/** Halves repeatedly, then scales the rest of the way: smoother than one big step. */
function resample(src: HTMLCanvasElement, w: number, h: number): HTMLCanvasElement {
  let cur = src;
  while (cur.width / 2 >= w && cur.height / 2 >= h) {
    const half = document.createElement('canvas');
    half.width = Math.max(w, Math.floor(cur.width / 2));
    half.height = Math.max(h, Math.floor(cur.height / 2));
    const g = half.getContext('2d')!;
    g.imageSmoothingQuality = 'high';
    g.drawImage(cur, 0, 0, half.width, half.height);
    if (cur !== src) cur.width = cur.height = 0;
    cur = half;
  }
  if (cur.width === w && cur.height === h) return cur;
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const g = out.getContext('2d')!;
  g.imageSmoothingQuality = 'high';
  g.drawImage(cur, 0, 0, w, h);
  if (cur !== src) cur.width = cur.height = 0;
  return out;
}

/** Many distinct colors means a photo, which JPEG suits; few means a graphic, which it doesn't. */
function looksLikePhoto(c: HTMLCanvasElement) {
  const g = c.getContext('2d', { willReadFrequently: true })!;
  const d = g.getImageData(0, 0, c.width, c.height).data;
  const total = c.width * c.height;
  const step = Math.max(1, Math.floor(total / 8192));
  const seen = new Set<number>();
  for (let i = 0; i < total; i += step) {
    const q = i * 4;
    seen.add((d[q] << 16) | (d[q + 1] << 8) | d[q + 2]);
    if (seen.size > 600) return true;
  }
  return false;
}

function jpegBytes(c: HTMLCanvasElement, quality: number): Promise<Uint8Array> {
  return new Promise((ok, fail) =>
    c.toBlob(
      (b) => (b ? b.arrayBuffer().then((a) => ok(new Uint8Array(a)), fail) : fail(new Error('JPEG encoding failed'))),
      'image/jpeg',
      quality,
    ),
  );
}

/** Lossless: PNG "Paeth" prediction on every row, then Flate. */
function flateBytes(c: HTMLCanvasElement, n: 1 | 3): Uint8Array {
  const { width: w, height: h } = c;
  const d = c.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, w, h).data;
  const row = w * n;
  const out = new Uint8Array((row + 1) * h);
  const line = new Uint8Array(row);
  const prev = new Uint8Array(row);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const q = (y * w + x) * 4;
      if (n === 3) {
        line[x * 3] = d[q];
        line[x * 3 + 1] = d[q + 1];
        line[x * 3 + 2] = d[q + 2];
      } else line[x] = d[q];
    }
    const o = y * (row + 1);
    out[o] = 4;
    for (let i = 0; i < row; i++) {
      const a = i >= n ? line[i - n] : 0;
      const b = y ? prev[i] : 0;
      const cc = y && i >= n ? prev[i - n] : 0;
      const p = a + b - cc;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - cc);
      out[o + 1 + i] = (line[i] - (pa <= pb && pa <= pc ? a : pb <= pc ? b : cc)) & 255;
    }
    prev.set(line);
  }
  return zlibSync(out, { level: 9 });
}

/** Re-encodes one image XObject if that makes it meaningfully smaller. */
async function optimizeImage(doc: PDFDocument, tag: string, box: Box, isMask: boolean, opts: ReduceOptions): Promise<boolean> {
  const ctx = doc.context;
  const [num, gen] = tag.split(' ').map(Number);
  const ref = PDFRef.of(num, gen);
  const img = ctx.lookup(ref);
  if (!(img instanceof PDFRawStream) || img.dict.get(name('Subtype')) !== name('Image')) return false;
  const d = img.dict;
  if (d.lookup(name('ImageMask'))?.toString() === 'true' || d.has(name('Matte'))) return false;
  const mask = d.get(name('Mask'));
  if (mask && !(mask instanceof PDFRef)) return false; // color-key masks need exact colors
  const w = d.lookupMaybe(name('Width'), PDFNumber)?.asNumber() ?? 0;
  const h = d.lookupMaybe(name('Height'), PDFNumber)?.asNumber() ?? 0;
  const bpc = d.lookupMaybe(name('BitsPerComponent'), PDFNumber)?.asNumber() ?? 8;
  if (w < 16 || h < 16 || w * h > 60_000_000) return false;
  const color = isMask ? ({ n: 1, out: name('DeviceGray') } as ColorInfo) : colorInfo(doc, d.get(name('ColorSpace')));
  if (!color) return false;
  // Only the default sample mapping is supported ([0 1] per component).
  const decode = numbers(ctx, d.get(name('Decode')));
  const max = color.palette ? 2 ** bpc - 1 : 1;
  if (decode.length && decode.some((v, i) => v !== (i % 2 ? max : 0))) return false;

  const { filters } = filtersOf(d);
  const wasJpeg = filters[filters.length - 1] === 'DCTDecode';
  const alpha = d.has(name('SMask')) || !!mask || isMask;
  const old = img.contents.length;

  // Resolution the image is shown at, along its sharper axis.
  const dpi = Math.min(w / Math.max(box.w / 72, 1e-3), h / Math.max(box.h / 72, 1e-3));
  const shrink = dpi > opts.dpi * 1.3;
  const scale = shrink ? opts.dpi / dpi : 1;
  const nw = Math.max(1, Math.round(w * scale));
  const nh = Math.max(1, Math.round(h * scale));
  // Already compact JPEGs at the right size are left alone.
  const heavyJpeg = wasJpeg && old / (w * h) > 0.35;
  if (!shrink && !heavyJpeg && (wasJpeg || alpha || old < 48 * 1024)) return false;

  const decoded = await decodeImage(img, w, h, bpc, color);
  if (!decoded) return false;
  const canvas = shrink ? resample(decoded, nw, nh) : decoded;
  const photo = wasJpeg || (!color.palette && looksLikePhoto(canvas));
  let bytes: Uint8Array;
  let jpeg = false;
  if (!alpha && photo) {
    bytes = await jpegBytes(canvas, opts.quality);
    jpeg = true;
  } else if (shrink || !wasJpeg) {
    bytes = flateBytes(canvas, color.n);
  } else return false;
  canvas.width = canvas.height = 0;
  if (decoded !== canvas) decoded.width = decoded.height = 0;
  if (bytes.length > old * (shrink ? 0.97 : 0.85)) return false;

  const dict = d.clone(ctx);
  for (const k of ['Filter', 'DecodeParms', 'Length', 'Width', 'Height', 'BitsPerComponent', 'ColorSpace', 'Decode', 'Alternates']) dict.delete(name(k));
  dict.set(name('Width'), PDFNumber.of(nw));
  dict.set(name('Height'), PDFNumber.of(nh));
  dict.set(name('BitsPerComponent'), PDFNumber.of(8));
  // Canvas JPEGs are always three-channel.
  dict.set(name('ColorSpace'), jpeg && color.n === 1 ? name('DeviceRGB') : color.out);
  dict.set(name('Filter'), name(jpeg ? 'DCTDecode' : 'FlateDecode'));
  if (!jpeg) dict.set(name('DecodeParms'), ctx.obj({ Predictor: 15, Colors: color.n, BitsPerComponent: 8, Columns: nw }));
  ctx.assign(ref, PDFRawStream.of(dict, bytes));
  return true;
}

/* ------------------------------------------------------------------ */
/* Other streams                                                        */
/* ------------------------------------------------------------------ */

/** Compresses streams stored without compression, and re-packs weakly compressed ones. */
function compressStreams(doc: PDFDocument) {
  const ctx = doc.context;
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    const d = obj.dict;
    const type = d.get(name('Type'));
    if (type === name('Metadata') || type === name('XRef') || type === name('ObjStm')) continue;
    const { filters } = filtersOf(d);
    const plainFlate = filters.length === 1 && filters[0] === 'FlateDecode' && !d.has(name('DecodeParms'));
    if (filters.length && !plainFlate) continue;
    if (obj.contents.length < (filters.length ? 4096 : 512)) continue;
    try {
      const raw = filters.length ? decodePDFRawStream(obj).decode() : obj.contents;
      const packed = zlibSync(raw, { level: 9 });
      if (packed.length > obj.contents.length * 0.92) continue;
      const dict = d.clone(ctx);
      dict.set(name('Filter'), name('FlateDecode'));
      dict.delete(name('Length'));
      ctx.assign(ref, PDFRawStream.of(dict, packed));
    } catch {
      /* leave it */
    }
  }
}
