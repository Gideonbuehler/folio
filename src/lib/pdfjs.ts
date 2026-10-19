import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import type { TextContent, TextItem } from 'pdfjs-dist/types/src/display/api';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { Matrix, PageItem, Rect, Rotation, SourceDoc } from '../types';
import { applyMatrix } from './geometry';
import { classifyFont } from './fonts';
import { withOcr, type OcrPage } from './ocrModel';
import { uid } from './util';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export { pdfjs };

const ASSETS = `${import.meta.env.BASE_URL}pdfjs/`;
export const IMAGE_RESOURCES = `${ASSETS}images/`;

const DOC_OPTIONS = {
  cMapUrl: `${ASSETS}cmaps/`,
  cMapPacked: true,
  standardFontDataUrl: `${ASSETS}standard_fonts/`,
  wasmUrl: `${ASSETS}wasm/`,
  iccUrl: `${ASSETS}iccs/`,
};

export class PasswordCancelled extends Error {}

/**
 * Opens a PDF with pdf.js. `askPassword` is called for encrypted files and may
 * be called again with `retry` set when the password was wrong.
 */
export async function loadSource(
  bytes: Uint8Array,
  name: string,
  askPassword: (retry: boolean) => Promise<string | null>,
): Promise<{ doc: SourceDoc; pages: PageItem[] }> {
  const task = pdfjs.getDocument({ data: bytes.slice(), ...DOC_OPTIONS });
  let password: string | undefined;
  let cancelled = false;
  task.onPassword = (update: (pw: string) => void, reason: number) => {
    askPassword(reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD).then((pw) => {
      if (pw === null) {
        cancelled = true;
        void task.destroy();
      } else {
        password = pw;
        update(pw);
      }
    });
  };
  let pdf: PDFDocumentProxy;
  try {
    pdf = await task.promise;
  } catch (e) {
    if (cancelled) throw new PasswordCancelled('Password entry cancelled');
    throw e;
  }
  const doc: SourceDoc = { id: uid(), name, bytes, pdf, password };
  const pages: PageItem[] = [];
  for (let i = 0; i < pdf.numPages; i++) {
    const page = await pdf.getPage(i + 1);
    const vp = page.getViewport({ scale: 1 });
    pages.push({
      id: uid(),
      src: doc.id,
      index: i,
      rotation: 0,
      w: vp.width,
      h: vp.height,
      baseRotate: page.rotate,
      m: vp.transform as PageItem['m'],
    });
  }
  return { doc, pages };
}

export function viewportFor(page: PDFPageProxy, item: PageItem, scale: number) {
  return page.getViewport({ scale, rotation: (item.baseRotate + item.rotation) % 360 });
}

/* ------------------------------------------------------------------ */
/* Text content, cached per source page                                */
/* ------------------------------------------------------------------ */

const textCache = new Map<string, Promise<TextContent>>();

/** The page's text; with `ocr`, words recognized on the scan are included as if they were in the file. */
export function getText(doc: SourceDoc, index: number, ocr?: OcrPage): Promise<TextContent> {
  const key = `${doc.id}:${index}`;
  let p = textCache.get(key);
  if (!p) {
    p = doc.pdf.getPage(index + 1).then((pg) => pg.getTextContent({ disableNormalization: true }));
    textCache.set(key, p);
  }
  return ocr ? p.then((tc) => withOcr(tc, ocr)) : p;
}

export function textItems(tc: TextContent): TextItem[] {
  return tc.items.filter((it): it is TextItem => 'str' in it);
}

/** A run of text on one baseline, in page space. */
export interface TextLine {
  x: number;
  y: number;
  w: number;
  h: number;
  baseline: number;
  size: number;
  text: string;
  fontName: string;
  cssFamily?: string;
}

/**
 * Groups pdf.js text items into visual lines. Only horizontal text is
 * considered; rotated text is left alone by the text editor.
 */
export function buildLines(tc: TextContent, item: PageItem): TextLine[] {
  const lines: TextLine[] = [];
  let cur: (TextLine & { end: number }) | null = null;
  const flush = () => {
    if (cur && cur.text.trim()) lines.push(cur);
    cur = null;
  };
  const [ma, mb, mc, md] = item.m;
  for (const it of textItems(tc)) {
    const [a, b, c, d, e, f] = it.transform as number[];
    // Direction of the text baseline in page space.
    const dx = ma * a + mc * b;
    const dy = mb * a + md * b;
    const size = Math.hypot(c, d);
    if (!it.str || size < 1 || dx <= 0 || Math.abs(dy) > Math.abs(dx) * 0.05) {
      if (it.hasEOL) flush();
      continue;
    }
    const style = tc.styles[it.fontName];
    const ascent = style?.ascent || 0.8;
    const descent = style?.descent || -0.2;
    const o = applyMatrix(item.m, e, f);
    const x = o.x;
    const w = it.width;
    const top = o.y - ascent * size;
    const h = (ascent - descent) * size;
    if (
      cur &&
      Math.abs(cur.baseline - o.y) < size * 0.3 &&
      Math.abs(cur.size - size) < size * 0.2 &&
      x - cur.end > -size * 0.5 &&
      x - cur.end < size * 1.5
    ) {
      const c0: TextLine & { end: number } = cur;
      const gap = x - c0.end;
      const needsSpace = gap > size * 0.18 && !c0.text.endsWith(' ') && !it.str.startsWith(' ');
      c0.text += (needsSpace ? ' ' : '') + it.str;
      const right = Math.max(c0.x + c0.w, x + w);
      const y1 = Math.min(c0.y, top);
      const y2 = Math.max(c0.y + c0.h, top + h);
      c0.w = right - c0.x;
      c0.y = y1;
      c0.h = y2 - y1;
      c0.end = x + w;
    } else {
      flush();
      cur = {
        x,
        y: top,
        w,
        h,
        baseline: o.y,
        size,
        text: it.str,
        fontName: it.fontName,
        cssFamily: style?.fontFamily,
        end: x + w,
      };
    }
    if (it.hasEOL) flush();
  }
  flush();
  return lines.map(({ ...l }) => {
    delete (l as Partial<TextLine & { end: number }>).end;
    return { ...l, text: l.text.replace(/\s+$/, '') };
  });
}

/** Best-effort font style for a line, using the embedded font's real name. */
export function lineFont(page: PDFPageProxy, line: TextLine) {
  let name = '';
  let bold: boolean | undefined;
  let italic: boolean | undefined;
  try {
    if (page.commonObjs.has(line.fontName)) {
      const f = page.commonObjs.get(line.fontName) as {
        name?: string;
        fallbackName?: string;
        bold?: boolean;
        black?: boolean;
        italic?: boolean;
      };
      name = f?.name ?? f?.fallbackName ?? '';
      bold = f?.bold || f?.black;
      italic = f?.italic;
    }
  } catch {
    /* font not loaded yet */
  }
  const guess = classifyFont(name, line.cssFamily);
  return { font: guess.font, bold: bold || guess.bold, italic: italic || guess.italic };
}

/* ------------------------------------------------------------------ */
/* Edit mode: paragraphs and images on a page                           */
/* ------------------------------------------------------------------ */

export interface Paragraph extends Rect {
  lines: TextLine[];
  text: string;
  size: number;
  /** Baseline of the first line, page space. */
  baseline: number;
  /** Baseline-to-baseline distance as a multiple of the size. */
  lineHeight: number;
}

const BULLET = /^\s*(?:[-•●▪◦‣∙·*–—✓✔➢➤►]|\(?\d{1,3}[.)]|\(?[a-zA-Z][.)])\s/;

/** Joins consecutive lines that share size, alignment and regular spacing. */
export function buildParagraphs(lines: TextLine[]): Paragraph[] {
  const out: Paragraph[] = [];
  let cur: Paragraph | null = null;
  let gap = 0;
  const close = () => {
    if (cur) out.push(cur);
    cur = null;
    gap = 0;
  };
  for (const l of lines) {
    const p: Paragraph | null = cur;
    // Each list item is its own block; its wrapped continuation lines join it.
    if (p && BULLET.test(l.text)) close();
    else if (p) {
      const prev = p.lines[p.lines.length - 1];
      const dy = l.baseline - prev.baseline;
      const sameSize = Math.abs(l.size - p.size) < p.size * 0.12;
      const spacingOk = dy > p.size * 0.85 && dy < p.size * 1.9 && (!gap || Math.abs(dy - gap) < p.size * 0.25);
      const aligned = l.x > p.x - p.size * 1.2 && l.x < p.x + p.size * 4 && l.x < p.x + p.w;
      if (sameSize && spacingOk && aligned) {
        gap = gap || dy;
        p.lines.push(l);
        const right = Math.max(p.x + p.w, l.x + l.w);
        p.x = Math.min(p.x, l.x);
        p.w = right - p.x;
        p.h = l.y + l.h - p.y;
        p.text += (p.text.endsWith('-') ? '' : ' ') + l.text.trim();
        p.lineHeight = gap / p.size;
        continue;
      }
      close();
    }
    cur = { x: l.x, y: l.y, w: l.w, h: l.h, lines: [l], text: l.text.trim(), size: l.size, baseline: l.baseline, lineHeight: 1.2 };
  }
  close();
  return out;
}

export interface PageImage {
  /** Full extent of the image, page space. */
  rect: Rect;
  /** The part actually visible through the clip path in effect, page space. */
  visible: Rect;
  /** Unit square -> page space. */
  unit: Matrix;
  objId?: string;
  inline?: unknown;
  inForm: boolean;
}

const mulM = (a: Matrix, b: Matrix): Matrix => [
  a[0] * b[0] + a[1] * b[2],
  a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2],
  a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4],
  a[4] * b[1] + a[5] * b[3] + b[5],
];

function mapBox(m: Matrix, x1: number, y1: number, x2: number, y2: number): Rect {
  const pts = [applyMatrix(m, x1, y1), applyMatrix(m, x2, y1), applyMatrix(m, x2, y2), applyMatrix(m, x1, y2)];
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

function intersect(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  return { x, y, w: Math.max(0, Math.min(a.x + a.w, b.x + b.w) - x), h: Math.max(0, Math.min(a.y + a.h, b.y + b.h) - y) };
}

/**
 * Finds raster images drawn by the page's own content. Full-page images (scans,
 * backgrounds) are skipped unless `all` is set; Edit mode doesn't offer them.
 */
export async function findImages(page: PDFPageProxy, item: PageItem, opts: { all?: boolean } = {}): Promise<PageImage[]> {
  const { OPS } = pdfjs;
  const list = await page.getOperatorList({ annotationMode: pdfjs.AnnotationMode.DISABLE });
  const out: PageImage[] = [];
  let ctm: Matrix = [1, 0, 0, 1, 0, 0];
  // Clip region in page space (bounding box of the clip paths in effect).
  let clip: Rect | null = null;
  let pendingClip = false;
  const stack: { ctm: Matrix; clip: Rect | null }[] = [];
  let depth = 0;
  const { fnArray, argsArray } = list;
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i] as unknown[];
    if (fn === OPS.save) stack.push({ ctm, clip });
    else if (fn === OPS.restore) ({ ctm, clip } = stack.pop() ?? { ctm, clip });
    else if (fn === OPS.transform) ctm = mulM(args as Matrix, ctm);
    else if (fn === OPS.clip || fn === OPS.eoClip) pendingClip = true;
    else if (fn === OPS.constructPath) {
      // pdf.js passes the path's bounding box (before the CTM) as the third argument.
      const mm = args[2] as ArrayLike<number> | null | undefined;
      if (pendingClip && mm && mm.length >= 4 && Number.isFinite(mm[0])) {
        const box = mapBox(mulM(ctm, item.m), mm[0], mm[1], mm[2], mm[3]);
        clip = clip ? intersect(clip, box) : box;
      }
      pendingClip = false;
    } else if (fn === OPS.paintFormXObjectBegin) {
      stack.push({ ctm, clip });
      depth++;
      if (Array.isArray(args[0]) && args[0].length === 6) ctm = mulM(args[0] as Matrix, ctm);
    } else if (fn === OPS.paintFormXObjectEnd) {
      ({ ctm, clip } = stack.pop() ?? { ctm, clip });
      depth = Math.max(0, depth - 1);
    } else if (fn === OPS.beginGroup) {
      stack.push({ ctm, clip });
      depth++;
    } else if (fn === OPS.endGroup) {
      ({ ctm, clip } = stack.pop() ?? { ctm, clip });
      depth = Math.max(0, depth - 1);
    } else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) {
      const unit = mulM(ctm, item.m);
      const pts = [applyMatrix(unit, 0, 0), applyMatrix(unit, 1, 0), applyMatrix(unit, 1, 1), applyMatrix(unit, 0, 1)];
      const xs = pts.map((p) => p.x);
      const ys = pts.map((p) => p.y);
      const rect = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
      // Ignore slivers and full-page backgrounds (scans are edited as text, not moved).
      if (rect.w < 4 || rect.h < 4) continue;
      if (!opts.all && rect.w > item.w * 0.97 && rect.h > item.h * 0.97) continue;
      const visible = clip ? intersect(rect, clip) : rect;
      if (visible.w < 4 || visible.h < 4) continue;
      out.push({
        rect,
        visible,
        unit,
        objId: fn === OPS.paintImageXObject ? (args[0] as string) : undefined,
        inline: fn === OPS.paintInlineImageXObject ? args[0] : undefined,
        inForm: depth > 0,
      });
    }
  }
  return out;
}

interface DecodedImage {
  width: number;
  height: number;
  bitmap?: ImageBitmap;
  data?: Uint8Array | Uint8ClampedArray;
  kind?: number;
}

/** The decoded image pdf.js holds for a page image (waits for it when `wait` is set). */
async function decodedData(page: PDFPageProxy, img: PageImage, wait: boolean): Promise<DecodedImage | undefined> {
  if (!img.objId) return img.inline as DecodedImage;
  const store = img.objId.startsWith('g_') ? page.commonObjs : page.objs;
  if (store.has(img.objId)) return store.get(img.objId) as DecodedImage;
  if (!wait) return undefined;
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(undefined), 8000);
    (store as unknown as { get(id: string, cb: (d: unknown) => void): void }).get(img.objId!, (d) => {
      clearTimeout(t);
      resolve(d as DecodedImage);
    });
  });
}

/** Draws decoded image data onto a canvas at its native size. */
function toCanvas(data: DecodedImage): HTMLCanvasElement | null {
  if (!data?.width || !data.height) return null;
  const { width: w, height: h } = data;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  if (data.bitmap) {
    ctx.drawImage(data.bitmap, 0, 0);
    return c;
  }
  if (!data.data) return null;
  const id = new ImageData(w, h);
  const src = data.data;
  const dst = id.data;
  if (data.kind === 3) dst.set(src.subarray(0, dst.length));
  else if (data.kind === 2) {
    for (let p = 0, q = 0; q < dst.length; p += 3, q += 4) {
      dst[q] = src[p];
      dst[q + 1] = src[p + 1];
      dst[q + 2] = src[p + 2];
      dst[q + 3] = 255;
    }
  } else if (data.kind === 1) {
    const rowBytes = (w + 7) >> 3;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const bit = (src[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
        const q = (y * w + x) * 4;
        dst[q] = dst[q + 1] = dst[q + 2] = bit ? 255 : 0;
        dst[q + 3] = 255;
      }
  } else return null;
  ctx.putImageData(id, 0, 0);
  return c;
}

/**
 * A copy of a page image, at its native resolution, with the parts under the
 * given page-space rectangles painted over. Used by redaction so the covered
 * pixels no longer exist in the file. Returns PNG bytes, or null if the image
 * couldn't be decoded.
 */
export async function redactedImage(page: PDFPageProxy, img: PageImage, rects: Rect[], color: string): Promise<Uint8Array | null> {
  const canvas = toCanvas((await decodedData(page, img, true)) as DecodedImage);
  if (!canvas) return null;
  const { width: w, height: h } = canvas;
  const ctx = canvas.getContext('2d')!;
  // Page space -> unit square -> image pixels (row 0 is the top of the image).
  const toUnit = invertM(img.unit);
  ctx.fillStyle = color;
  for (const r of rects) {
    const pts = [
      [r.x, r.y],
      [r.x + r.w, r.y],
      [r.x + r.w, r.y + r.h],
      [r.x, r.y + r.h],
    ].map(([x, y]) => {
      const u = applyMatrix(toUnit, x, y);
      return [u.x * w, (1 - u.y) * h];
    });
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (const p of pts.slice(1)) ctx.lineTo(p[0], p[1]);
    ctx.closePath();
    // Grow by a pixel so anti-aliased edges can't leave traces.
    ctx.lineWidth = 2;
    ctx.strokeStyle = color;
    ctx.fill();
    ctx.stroke();
  }
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'));
  canvas.width = canvas.height = 0;
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
}

const invertM = (m: Matrix): Matrix => {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
};

/** An upright PNG of a page image as it appears in page space. */
export function imagePixels(page: PDFPageProxy, img: PageImage): string | null {
  let data: DecodedImage | undefined;
  try {
    if (img.objId) {
      const store = img.objId.startsWith('g_') ? page.commonObjs : page.objs;
      if (store.has(img.objId)) data = store.get(img.objId) as DecodedImage;
    } else data = img.inline as DecodedImage;
  } catch {
    return null;
  }
  const source = data ? toCanvas(data) : null;
  if (!source || !data) return null;
  const { width: w, height: h } = data;

  // Keep native resolution (within reason) and bake in any rotation or flip.
  const r = img.rect;
  const scale = Math.max(1, Math.min(4, Math.max(w / r.w, h / r.h)));
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(r.w * scale));
  out.height = Math.max(1, Math.round(r.h * scale));
  const ctx = out.getContext('2d')!;
  const m = mulM(img.unit, [scale, 0, 0, scale, -r.x * scale, -r.y * scale]);
  ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
  ctx.scale(1 / w, -1 / h);
  ctx.drawImage(source, 0, -h, w, h);
  return out.toDataURL('image/png');
}

export function totalRotation(item: PageItem): Rotation {
  return ((item.baseRotate + item.rotation) % 360) as Rotation;
}
