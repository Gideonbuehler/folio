import {
  PDFDocument,
  PDFPage,
  PDFFont,
  PDFImage,
  PDFName,
  PDFDict,
  PDFArray,
  PDFRef,
  PDFNumber,
  PDFNull,
  PDFHexString,
  PDFString,
  PDFStream,
  PDFObject,
  PDFObjectCopier,
  StandardFonts,
  LineCapStyle,
  LineJoinStyle,
  PDFOperator,
  degrees,
  pushGraphicsState,
  popGraphicsState,
  concatTransformationMatrix,
  setGraphicsState,
  setFillingRgbColor,
  setStrokingRgbColor,
  setLineWidth,
  setLineCap,
  setLineJoin,
  moveTo,
  lineTo,
  appendBezierCurve,
  closePath,
  rectangle,
  fill,
  stroke,
  fillAndStroke,
  beginText,
  endText,
  setFontAndSize,
  setTextMatrix,
  setCharacterSqueeze,
  showText,
  drawObject,
} from '@cantoo/pdf-lib';
import { AnnotationMode } from 'pdfjs-dist';
import type { DocMeta, FillObj, FontFamily, ImageObj, Matrix, Obj, PageItem, Rect, SourceDoc, TextObj } from '../types';
import { applyMatrix, arrowHead, invertMatrix, markupQuads, NOTE_SIZE } from './geometry';
import { firstBaseline, layoutText, LINE_HEIGHT, measureText, TEXT_PAD } from './fonts';
import { analyze, isolateImage, mul, overlap, pageContentBytes, parseContent, quadRect, rewrite, setPageContent, silenceRun, wrapInTransform } from './content';
import { hexToRgb } from './util';
import { fillMatchingBackground } from './sample';
import { applyRedaction, hiddenByMarks, marksOn, planRedaction, type RedactionPlan } from './redact';
import type { ReduceOptions, ReduceStats } from './reduce';

export interface ExportInput {
  docs: Record<string, SourceDoc>;
  pages: PageItem[];
  objects: Obj[];
  meta: DocMeta;
}

export interface ExportOptions {
  /** Only these pages, in document order. */
  pageIds?: string[];
  flattenForms?: boolean;
  /** Draw comments into the page instead of keeping them as annotations. */
  flattenComments?: boolean;
  userPassword?: string;
  ownerPassword?: string;
  /** Downsample and recompress images, drop duplicate and private data. */
  reduce?: ReduceOptions;
  onProgress?: (text: string) => void;
}

export interface ExportResult {
  bytes: Uint8Array;
  warnings: string[];
  reduced?: ReduceStats;
}

const REDACT_SCALE = 2.5; // ~180 dpi raster for redacted pages

export async function buildPdf(input: ExportInput, opts: ExportOptions = {}): Promise<ExportResult> {
  const warnings = new Set<string>();
  const want = opts.pageIds ? new Set(opts.pageIds) : null;
  const pages = input.pages.filter((p) => !want || want.has(p.id));
  const byPage = new Map<string, Obj[]>();
  for (const o of input.objects) {
    const list = byPage.get(o.page);
    if (list) list.push(o);
    else byPage.set(o.page, [o]);
  }
  const marked = pages.filter((p) => byPage.get(p.id)?.some((o) => o.type === 'redact'));

  /* 1. Load every source we need with pdf-lib, form values included. */
  opts.onProgress?.('Preparing pages…');
  const srcIds = [...new Set(pages.map((p) => p.src))];
  const libDocs = new Map<string, PDFDocument>();
  for (const id of srcIds) {
    const doc = input.docs[id];
    let bytes = doc.bytes;
    if (doc.pdf.annotationStorage.size > 0) {
      try {
        bytes = await doc.pdf.saveDocument();
      } catch (e) {
        console.warn('Could not merge form values', e);
        warnings.add('Some form values could not be saved.');
      }
    }
    libDocs.set(id, await loadLib(bytes, doc.password));
  }

  /* 2. Plan redactions. Only what's under a mark is removed; pages with content
        that can't be removed precisely are flattened to an image instead. */
  const plans = new Map<string, RedactionPlan>();
  const redacted = new Set<string>(); // pages to flatten
  for (const item of marked) {
    opts.onProgress?.(`Preparing redactions on page ${pages.indexOf(item) + 1}…`);
    let plan: RedactionPlan;
    try {
      const pdfPage = await input.docs[item.src].pdf.getPage(item.index + 1);
      plan = await planRedaction(libDocs.get(item.src)!, item, pdfPage, marksOn(byPage.get(item.id)!));
    } catch (e) {
      console.warn('Redaction planning failed; flattening the page', e);
      plan = { fallback: 'its content could not be analysed', images: [] };
    }
    plans.set(item.id, plan);
    if (plan.fallback) {
      redacted.add(item.id);
      warnings.add(`Page ${pages.indexOf(item) + 1} was flattened to an image because ${plan.fallback}. Its text is no longer selectable.`);
    }
  }

  /* 2b. Flattened pages: nothing copied may still point at them. */
  for (const [id, lib] of libDocs) {
    const redactedIdx = new Set(pages.filter((p) => p.src === id && redacted.has(p.id)).map((p) => p.index));
    if (!redactedIdx.size) continue;
    const srcPages = lib.getPages();
    try {
      // Form fields with a widget on a redacted page are dropped (the page is
      // rasterized with their values); fields elsewhere stay fillable.
      const onRedacted = new Set<PDFObject>();
      for (const i of redactedIdx) {
        const annots = srcPages[i].node.Annots();
        for (let k = 0; k < (annots?.size() ?? 0); k++) {
          const a = lib.context.lookup(annots!.get(k));
          if (a) onRedacted.add(a);
        }
      }
      const form = lib.getForm();
      for (const field of form.getFields()) {
        if (field.acroField.getWidgets().some((w) => onRedacted.has(w.dict))) form.removeField(field);
      }
    } catch (e) {
      console.warn('Could not detach form fields from redacted pages', e);
    }
    const refs = new Set([...redactedIdx].map((i) => srcPages[i].ref.tag));
    srcPages.forEach((pg, i) => {
      if (!redactedIdx.has(i)) scrubDestinations(lib, pg, refs);
    });
  }

  /* 3. Assemble pages in order. */
  const out = await PDFDocument.create({ updateMetadata: false });
  const copies = new Map<string, PDFPage[]>();
  for (const [id, lib] of libDocs) {
    const indices = pages.filter((p) => p.src === id && !redacted.has(p.id)).map((p) => p.index);
    if (indices.length) copies.set(id, await out.copyPages(lib, indices));
  }
  const cursor = new Map<string, number>();
  const res = new Resources(out, warnings);
  const outPages: { item: PageItem; page: PDFPage; m: Matrix; raster?: Set<string> }[] = [];
  for (const item of pages) {
    if (redacted.has(item.id)) {
      opts.onProgress?.(`Redacting page ${outPages.length + 1}…`);
      const { page, native } = await rasterizeRedacted(out, input.docs[item.src], item, byPage.get(item.id) ?? [], res);
      page.setRotation(degrees(item.rotation));
      outPages.push({ item, page, m: [1, 0, 0, -1, 0, item.h], raster: native });
    } else {
      const k = cursor.get(item.src) ?? 0;
      cursor.set(item.src, k + 1);
      const page = out.addPage(copies.get(item.src)![k]);
      page.setRotation(degrees((item.baseRotate + item.rotation) % 360));
      outPages.push({ item, page, m: item.m });
    }
  }

  /* 4. Draw objects and add annotations. */
  for (const [i, { item, page, m, raster }] of outPages.entries()) {
    const objs = byPage.get(item.id);
    if (!objs?.length) continue;
    opts.onProgress?.(`Writing page ${i + 1} of ${outPages.length}…`);
    const marks = marksOn(objs);
    // Redaction first: it works on the page exactly as the plan saw it.
    if (marks.length && !raster) {
      opts.onProgress?.(`Redacting page ${i + 1}…`);
      await applyRedaction(out, page, m, marks, plans.get(item.id)!);
      if (marks.some((mk) => mk.match)) await matchPatches(out, input.docs[item.src], item, objs, res);
    }
    // Edits to the page's own text and images change its content stream directly.
    // Rasterized pages already show their Edit-mode changes.
    let native = raster ?? new Set<string>();
    if (!raster) {
      try {
        native = applyContentEdits(out, page, m, objs);
      } catch (e) {
        console.warn('Content edit failed; falling back to covering', e);
      }
    }
    const content: Obj[] = [];
    const annots: Obj[] = [];
    for (const o of objs) {
      // Anything of ours that sits mostly under a redaction mark is left out too.
      if (hiddenByMarks(o, marks)) continue;
      const isComment = o.type === 'highlight' || o.type === 'underline' || o.type === 'strike' || o.type === 'note';
      if (isComment && !opts.flattenComments) annots.push(o);
      else if (o.type === 'note') continue;
      else if (o.type === 'whiteout' && o.erase && native.has(o.id)) continue;
      else if (o.type === 'image' && o.orig && (native.has(o.id) || sameRect(o, o.orig))) continue;
      else content.push(o);
    }
    content.sort((a, b) => layer(a) - layer(b));
    if (content.length) await drawContent(out, page, m, content, res, native);
    for (const o of annots) addAnnotation(out, page, m, o);
  }

  /* 5. Forms, bookmarks, metadata. */
  if (opts.flattenForms) {
    try {
      rebuildAcroForm(out, outPages.map((p) => p.page), libDocs);
      out.getForm().flatten();
    } catch (e) {
      console.warn(e);
      warnings.add('Form fields could not be flattened.');
    }
  } else {
    rebuildAcroForm(out, outPages.map((p) => p.page), libDocs);
  }
  if (!opts.pageIds) {
    try {
      await writeOutline(out, input, pages, outPages.map((p) => p.page));
    } catch (e) {
      console.warn('Bookmarks were not copied', e);
    }
  }
  out.setTitle(input.meta.title || '');
  out.setAuthor(input.meta.author || '');
  out.setSubject(input.meta.subject || '');
  out.setKeywords(input.meta.keywords ? input.meta.keywords.split(/\s*[,;]\s*/).filter(Boolean) : []);
  out.setProducer('Folio PDF Editor');
  out.setCreator('Folio');
  out.setModificationDate(new Date());

  opts.onProgress?.('Saving…');
  await out.flush();
  collectGarbage(out);
  let reduced: ReduceStats | undefined;
  if (opts.reduce) {
    const { reduceDocument } = await import('./reduce');
    reduced = await reduceDocument(out, opts.reduce, opts.onProgress);
    collectGarbage(out);
    opts.onProgress?.('Saving…');
  }
  if (opts.userPassword || opts.ownerPassword) {
    out.encrypt({
      userPassword: opts.userPassword ?? '',
      ownerPassword: opts.ownerPassword || opts.userPassword || '',
      permissions: { printing: 'highResolution', modifying: false, copying: true, annotating: true, fillingForms: true },
    });
  }
  const bytes = await out.save({ useObjectStreams: true });
  return { bytes, warnings: [...warnings], reduced };
}

export async function loadLib(bytes: Uint8Array, password?: string) {
  try {
    return await PDFDocument.load(bytes, { updateMetadata: false, ...(password !== undefined ? { password } : {}) });
  } catch (e) {
    if (password === undefined && /encrypt/i.test(String(e))) {
      return PDFDocument.load(bytes, { updateMetadata: false, password: '' });
    }
    throw e;
  }
}

/** Paint order, matching the editor: whiteouts, shapes, text, redactions. */
function layer(o: Obj) {
  if (o.type === 'whiteout') return 0;
  if (o.type === 'redact') return 3;
  if (o.type === 'text') return 2;
  return 1;
}

/* ------------------------------------------------------------------ */
/* Resources: fonts, images, graphics states                           */
/* ------------------------------------------------------------------ */

const STD: Record<FontFamily, [StandardFonts, StandardFonts, StandardFonts, StandardFonts]> = {
  sans: [StandardFonts.Helvetica, StandardFonts.HelveticaBold, StandardFonts.HelveticaOblique, StandardFonts.HelveticaBoldOblique],
  serif: [StandardFonts.TimesRoman, StandardFonts.TimesRomanBold, StandardFonts.TimesRomanItalic, StandardFonts.TimesRomanBoldItalic],
  mono: [StandardFonts.Courier, StandardFonts.CourierBold, StandardFonts.CourierOblique, StandardFonts.CourierBoldOblique],
};

class Resources {
  private fonts = new Map<string, Promise<PDFFont>>();
  private images = new Map<string, Promise<PDFImage>>();
  /** Background-matched redaction fills, by object id. */
  readonly redactPatches = new Map<string, PDFImage>();
  constructor(
    private doc: PDFDocument,
    private warnings: Set<string>,
  ) {}

  font(family: FontFamily, bold: boolean, italic: boolean) {
    const name = STD[family][(bold ? 1 : 0) + (italic ? 2 : 0)];
    let f = this.fonts.get(name);
    if (!f) {
      f = this.doc.embedFont(name);
      this.fonts.set(name, f);
    }
    return f;
  }

  image(src: string) {
    let img = this.images.get(src);
    if (!img) {
      const bytes = dataUrlBytes(src);
      img = /^data:image\/jpe?g/i.test(src) ? this.doc.embedJpg(bytes) : this.doc.embedPng(bytes);
      this.images.set(src, img);
    }
    return img;
  }

  /** Text the standard fonts can encode; anything else becomes "?". */
  safeText(font: PDFFont, text: string) {
    try {
      font.encodeText(text);
      return text;
    } catch {
      this.warnings.add('Some characters are not supported by the built-in PDF fonts and were replaced with "?".');
      let out = '';
      for (const ch of text) {
        try {
          font.encodeText(ch);
          out += ch;
        } catch {
          out += '?';
        }
      }
      return out;
    }
  }
}

function dataUrlBytes(src: string) {
  const b64 = src.slice(src.indexOf(',') + 1);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function gs(doc: PDFDocument, page: PDFPage, opacity: number, multiply = false) {
  const dict = doc.context.obj({
    Type: 'ExtGState',
    ca: opacity,
    CA: opacity,
    ...(multiply ? { BM: 'Multiply' } : {}),
  });
  return page.node.newExtGState('GS', dict);
}

const rgb = (hex: string) => hexToRgb(hex);

/* ------------------------------------------------------------------ */
/* Page content                                                        */
/* ------------------------------------------------------------------ */

const wrapped = new WeakSet<PDFPage>();

async function drawContent(doc: PDFDocument, page: PDFPage, m: Matrix, objs: Obj[], res: Resources, native: Set<string>) {
  if (!wrapped.has(page)) {
    // Isolate the existing content so its graphics state can't leak into ours.
    page.node.wrapContentStreams(doc.context.getPushGraphicsStateContentStream(), doc.context.getPopGraphicsStateContentStream());
    wrapped.add(page);
  }
  const ops: PDFOperator[] = [pushGraphicsState(), concatTransformationMatrix(...invertMatrix(m))];
  // Where the original couldn't be removed from the content, cover it instead.
  for (const o of objs) {
    if ((o.type !== 'text' && o.type !== 'image') || !o.cover || native.has(o.id)) continue;
    const c = o.cover;
    ops.push(setFillingRgbColor(...rgb(c.color)), rectangle(c.x, c.y, c.w, c.h), fill());
  }
  for (const o of objs) {
    ops.push(pushGraphicsState());
    if (o.opacity < 1) ops.push(setGraphicsState(gs(doc, page, o.opacity)));
    ops.push(...(await objectOps(page, o, res)));
    ops.push(popGraphicsState());
  }
  ops.push(popGraphicsState());
  page.pushOperators(...ops);
}

async function objectOps(page: PDFPage, o: Obj, res: Resources): Promise<PDFOperator[]> {
  const round = [setLineCap(LineCapStyle.Round), setLineJoin(LineJoinStyle.Round)];
  switch (o.type) {
    case 'rect':
    case 'ellipse': {
      const path = o.type === 'rect' ? [rectangle(o.x, o.y, o.w, o.h)] : ellipsePath(o.x + o.w / 2, o.y + o.h / 2, o.w / 2, o.h / 2);
      const ops: PDFOperator[] = [...path];
      if (o.fill) ops.unshift(setFillingRgbColor(...rgb(o.fill)));
      if (o.stroke) ops.unshift(setStrokingRgbColor(...rgb(o.stroke)), setLineWidth(o.width), setLineJoin(LineJoinStyle.Miter));
      ops.push(o.fill && o.stroke ? fillAndStroke() : o.fill ? fill() : stroke());
      return o.fill || o.stroke ? ops : [];
    }
    case 'line':
    case 'arrow': {
      const ops: PDFOperator[] = [setStrokingRgbColor(...rgb(o.stroke)), setLineWidth(o.width), ...round];
      let { x2, y2 } = o;
      if (o.type === 'arrow') {
        const head = arrowHead(o.x1, o.y1, o.x2, o.y2, o.width);
        x2 = head.base.x;
        y2 = head.base.y;
        ops.push(moveTo(o.x1, o.y1), lineTo(x2, y2), stroke());
        ops.push(setFillingRgbColor(...rgb(o.stroke)), moveTo(o.x2, o.y2), lineTo(head.l.x, head.l.y), lineTo(head.r.x, head.r.y), closePath(), fill());
        return ops;
      }
      ops.push(moveTo(o.x1, o.y1), lineTo(x2, y2), stroke());
      return ops;
    }
    case 'ink': {
      const ops: PDFOperator[] = [setStrokingRgbColor(...rgb(o.stroke)), setLineWidth(o.width), ...round];
      for (const s of o.strokes) ops.push(...smoothPath(s), stroke());
      return ops;
    }
    case 'redact': {
      const patch = o.match ? res.redactPatches.get(o.id) : undefined;
      if (patch) {
        const name = page.node.newXObject('Image', patch.ref);
        return [concatTransformationMatrix(o.w, 0, 0, -o.h, o.x, o.y + o.h), drawObject(name)];
      }
      return [setFillingRgbColor(...rgb(o.color)), rectangle(o.x, o.y, o.w, o.h), fill()];
    }
    case 'whiteout':
      return [setFillingRgbColor(...rgb(o.color)), rectangle(o.x, o.y, o.w, o.h), fill()];
    case 'image': {
      const img = await res.image(o.src);
      const name = page.node.newXObject('Image', img.ref);
      return [concatTransformationMatrix(o.w, 0, 0, -o.h, o.x, o.y + o.h), drawObject(name)];
    }
    case 'text': {
      const ops: PDFOperator[] = [];
      const font = await res.font(o.font, o.bold, o.italic);
      const key = page.node.newFontDictionary(font.name, font.ref);
      const box = measureText(o);
      if (o.rotate) {
        const cx = o.x + box.w / 2;
        const cy = o.y + box.h / 2;
        const r = (o.rotate * Math.PI) / 180;
        const cos = Math.cos(r);
        const sin = Math.sin(r);
        ops.push(concatTransformationMatrix(1, 0, 0, 1, cx, cy), concatTransformationMatrix(cos, sin, -sin, cos, 0, 0), concatTransformationMatrix(1, 0, 0, 1, -cx, -cy));
      }
      const lh = o.lineHeight ?? LINE_HEIGHT;
      ops.push(setFillingRgbColor(...rgb(o.color)), beginText(), setFontAndSize(key, o.size));
      if (o.hscale && o.hscale !== 1) ops.push(setCharacterSqueeze(o.hscale * 100));
      const base = firstBaseline(o.font, o.size, lh);
      layoutText(o).forEach((line, i) => {
        const text = line.text.replace(/\s+$/, '');
        if (!text) return;
        ops.push(setTextMatrix(1, 0, 0, -1, o.x + TEXT_PAD, o.y + base + i * o.size * lh));
        ops.push(showText(font.encodeText(res.safeText(font, text))));
      });
      ops.push(endText());
      return ops;
    }
    case 'highlight':
    case 'underline':
    case 'strike': {
      // Only reached when comments are flattened.
      const ops: PDFOperator[] = [setFillingRgbColor(...rgb(o.color))];
      for (const q of markupQuads(o)) ops.push(rectangle(q.x, q.y, q.w, q.h), fill());
      if (o.type === 'highlight') ops.unshift(setGraphicsState(gs(page.doc, page, Math.min(o.opacity, 0.45), true)));
      return ops;
    }
    case 'note':
      return [];
  }
}

const KAPPA = 0.5522847498;

function ellipsePath(cx: number, cy: number, rx: number, ry: number): PDFOperator[] {
  const ox = rx * KAPPA;
  const oy = ry * KAPPA;
  return [
    moveTo(cx - rx, cy),
    appendBezierCurve(cx - rx, cy - oy, cx - ox, cy - ry, cx, cy - ry),
    appendBezierCurve(cx + ox, cy - ry, cx + rx, cy - oy, cx + rx, cy),
    appendBezierCurve(cx + rx, cy + oy, cx + ox, cy + ry, cx, cy + ry),
    appendBezierCurve(cx - ox, cy + ry, cx - rx, cy + oy, cx - rx, cy),
    closePath(),
  ];
}

/** Quadratic smoothing through stroke midpoints, emitted as cubic curves. */
function smoothPath(s: number[]): PDFOperator[] {
  const n = s.length / 2;
  if (n === 1) return [moveTo(s[0], s[1]), lineTo(s[0] + 0.01, s[1])];
  const ops: PDFOperator[] = [moveTo(s[0], s[1])];
  let px = s[0];
  let py = s[1];
  for (let i = 1; i < n - 1; i++) {
    const cx = s[i * 2];
    const cy = s[i * 2 + 1];
    const mx = (cx + s[i * 2 + 2]) / 2;
    const my = (cy + s[i * 2 + 3]) / 2;
    ops.push(appendBezierCurve(px + (2 / 3) * (cx - px), py + (2 / 3) * (cy - py), mx + (2 / 3) * (cx - mx), my + (2 / 3) * (cy - my), mx, my));
    px = mx;
    py = my;
  }
  ops.push(lineTo(s[(n - 1) * 2], s[(n - 1) * 2 + 1]));
  return ops;
}

/* ------------------------------------------------------------------ */
/* Edits to the page's own content                                      */
/* ------------------------------------------------------------------ */

function sameRect(a: Rect, b: Rect) {
  return Math.abs(a.x - b.x) < 0.05 && Math.abs(a.y - b.y) < 0.05 && Math.abs(a.w - b.w) < 0.05 && Math.abs(a.h - b.h) < 0.05;
}

function iou(a: Rect, b: Rect) {
  const o = overlap(a, b);
  return o / Math.max(1e-6, a.w * a.h + b.w * b.h - o);
}

/**
 * Removes replaced text, and moves or removes edited images, inside the page's
 * content stream. Returns the ids of objects fully handled this way; anything
 * else falls back to being covered.
 */
export function applyContentEdits(doc: PDFDocument, page: PDFPage, m: Matrix, objs: Obj[]): Set<string> {
  const native = new Set<string>();
  const texts = objs.filter((o): o is TextObj => o.type === 'text' && !!o.cover);
  const erases = objs.filter((o): o is FillObj => o.type === 'whiteout' && !!o.erase);
  const moves = objs.filter((o): o is ImageObj => o.type === 'image' && !!o.orig);
  if (!texts.length && !erases.length && !moves.length) return native;
  const bytes = pageContentBytes(page);
  if (!bytes) return native;
  const analysis = analyze(parseContent(bytes), doc, page.node.Resources());
  const { ops, runs, images } = analysis;
  const reps = new Map<number, string | Uint8Array>();
  const runRects = runs.map((r) => ({ r, rect: quadRect(r.quad, m) }));
  const imageRects = images.map((im) => ({ im, rect: quadRect(im.quad, m) }));

  /** Silences every text run that lies (almost) entirely inside `area`. */
  const removeText = (area: Rect) => {
    let removed = 0;
    for (const { r, rect } of runRects) {
      const a = rect.w * rect.h;
      if (a <= 0 || overlap(rect, area) / a < 0.85) continue;
      if (!reps.has(r.index)) reps.set(r.index, silenceRun(ops[r.index], r));
      removed += a;
    }
    return removed;
  };

  for (const t of texts) {
    const c = t.cover!;
    if (removeText(c) >= 0.45 * c.w * c.h) native.add(t.id);
  }
  for (const e of erases) {
    if (e.erase === 'text') {
      if (removeText(e) > 0) native.add(e.id);
    } else {
      for (const { im, rect } of imageRects) {
        if (iou(rect, e) > 0.85) {
          reps.set(im.index, '');
          native.add(e.id);
        }
      }
    }
  }
  const used = new Set<number>();
  for (const o of moves) {
    let best: (typeof imageRects)[number] | null = null;
    let score = 0.85;
    for (const cand of imageRects) {
      const sc = iou(cand.rect, o.orig!);
      if (sc > score && !used.has(cand.im.index)) {
        score = sc;
        best = cand;
      }
    }
    if (!best) continue;
    used.add(best.im.index);
    native.add(o.id);
    if (sameRect(o, o.orig!)) continue;
    // Map the old spot onto the new one in page space, then express that as an
    // extra transform applied just before the image is drawn.
    const r0 = o.orig!;
    const sx = o.w / r0.w;
    const sy = o.h / r0.h;
    const pageMove: Matrix = [sx, 0, 0, sy, o.x - r0.x * sx, o.y - r0.y * sy];
    const userMove = mul(mul(m, pageMove), invertMatrix(m));
    const range = isolateImage(analysis, best.im);
    const ctm = range.ctm;
    reps.set(range.start, wrapInTransform(bytes, ops[range.start], ops[range.end], mul(mul(ctm, userMove), invertMatrix(ctm))));
    for (let k = range.start + 1; k <= range.end; k++) reps.set(k, '');
  }
  if (reps.size) setPageContent(page, rewrite(bytes, ops, reps));
  return native;
}

/* ------------------------------------------------------------------ */
/* Annotations                                                          */
/* ------------------------------------------------------------------ */

function addAnnotation(doc: PDFDocument, page: PDFPage, m: Matrix, o: Obj) {
  const ctx = doc.context;
  const inv = invertMatrix(m);
  const toPdf = (x: number, y: number) => applyMatrix(inv, x, y);
  const common = {
    Type: 'Annot',
    F: 4,
    P: page.ref,
    NM: PDFHexString.fromText(o.id),
    T: PDFHexString.fromText(o.author || 'Folio'),
    M: PDFString.fromDate(new Date()),
    CreationDate: PDFString.fromDate(new Date(o.created)),
    ...(o.comment ? { Contents: PDFHexString.fromText(o.comment) } : {}),
  };
  if (o.type === 'note') {
    const a = toPdf(o.x, o.y);
    const b = toPdf(o.x + NOTE_SIZE, o.y + NOTE_SIZE);
    const dict = ctx.obj({
      ...common,
      F: 28,
      Subtype: 'Text',
      Name: 'Comment',
      Rect: [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y)],
      C: rgb(o.color),
      Open: false,
      Subj: 'Note',
    });
    page.node.addAnnot(ctx.register(dict));
    return;
  }
  if (o.type !== 'highlight' && o.type !== 'underline' && o.type !== 'strike') return;

  // QuadPoints follow the text orientation: upper-left, upper-right, lower-left, lower-right.
  const quadPoints: number[] = [];
  for (const r of o.rects) {
    for (const [x, y] of [
      [r.x, r.y],
      [r.x + r.w, r.y],
      [r.x, r.y + r.h],
      [r.x + r.w, r.y + r.h],
    ]) {
      const p = toPdf(x, y);
      quadPoints.push(p.x, p.y);
    }
  }
  const paint = markupQuads(o).map((q) => [toPdf(q.x, q.y), toPdf(q.x + q.w, q.y), toPdf(q.x + q.w, q.y + q.h), toPdf(q.x, q.y + q.h)]);
  const xs = [...paint.flat().map((p) => p.x), ...quadPoints.filter((_, i) => i % 2 === 0)];
  const ys = [...paint.flat().map((p) => p.y), ...quadPoints.filter((_, i) => i % 2 === 1)];
  const bbox = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  const opacity = o.type === 'highlight' ? Math.min(o.opacity, 1) : o.opacity;
  const ops: PDFOperator[] = [setGraphicsState(PDFName.of('GS0')), setFillingRgbColor(...rgb(o.color))];
  for (const quad of paint) {
    ops.push(moveTo(quad[0].x, quad[0].y));
    for (const p of quad.slice(1)) ops.push(lineTo(p.x, p.y));
    ops.push(closePath(), fill());
  }
  const ap = ctx.formXObject(ops, {
    BBox: bbox,
    Resources: { ExtGState: { GS0: { Type: 'ExtGState', ca: opacity, CA: opacity, ...(o.type === 'highlight' ? { BM: 'Multiply' } : {}) } } },
  });
  const subtype = o.type === 'highlight' ? 'Highlight' : o.type === 'underline' ? 'Underline' : 'StrikeOut';
  const dict = ctx.obj({
    ...common,
    Subtype: subtype,
    Rect: bbox,
    QuadPoints: quadPoints,
    C: rgb(o.color),
    CA: opacity,
    Subj: subtype === 'StrikeOut' ? 'Strikethrough' : subtype,
    AP: { N: ctx.register(ap) },
  });
  page.node.addAnnot(ctx.register(dict));
}

/* ------------------------------------------------------------------ */
/* Redaction                                                            */
/* ------------------------------------------------------------------ */

/**
 * A redacted page is replaced by a picture of itself with the redacted areas
 * painted black, so the hidden text and images no longer exist in the file.
 */
/** Renders a source page (with any Edit-mode changes applied) at the redaction resolution. */
async function renderForRedaction(src: SourceDoc, item: PageItem, objs: Obj[]) {
  let pg = await src.pdf.getPage(item.index + 1);
  let native = new Set<string>();
  const { getLive, pageLiveKeys } = await import('./live');
  if (pageLiveKeys(objs, new Set()).key) {
    try {
      const live = await getLive(src, item, objs, new Set());
      pg = live.page;
      native = live.native;
    } catch (e) {
      console.warn('Redaction: could not apply edits to the page first', e);
    }
  }
  const vp = pg.getViewport({ scale: REDACT_SCALE });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(vp.width);
  canvas.height = Math.ceil(vp.height);
  await pg.render({ canvas, viewport: vp, intent: 'print', annotationMode: AnnotationMode.ENABLE_STORAGE }).promise;
  return { canvas, native };
}

/** Background-matched fills for "Match background" redactions, sampled around each mark. */
async function matchPatches(out: PDFDocument, src: SourceDoc, item: PageItem, objs: Obj[], res: Resources, rendered?: HTMLCanvasElement) {
  const canvas = rendered ?? (await renderForRedaction(src, item, objs)).canvas;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const S = REDACT_SCALE;
  for (const o of objs) {
    if (o.type !== 'redact' || !o.match) continue;
    fillMatchingBackground(ctx, o.x * S, o.y * S, o.w * S, o.h * S);
    const patch = document.createElement('canvas');
    patch.width = Math.max(1, Math.round(o.w * S));
    patch.height = Math.max(1, Math.round(o.h * S));
    patch.getContext('2d')!.drawImage(canvas, o.x * S, o.y * S, o.w * S, o.h * S, 0, 0, patch.width, patch.height);
    const bytes = await new Promise<Blob>((ok, no) => patch.toBlob((b) => (b ? ok(b) : no(new Error('patch failed'))), 'image/png'));
    res.redactPatches.set(o.id, await out.embedPng(new Uint8Array(await bytes.arrayBuffer())));
  }
  if (!rendered) canvas.width = canvas.height = 0;
}

/** Fallback: the whole page becomes an image with the marks painted in. */
async function rasterizeRedacted(out: PDFDocument, src: SourceDoc, item: PageItem, objs: Obj[], res: Resources) {
  // A page that also has Edit-mode changes is rasterized with them applied.
  let pg = await src.pdf.getPage(item.index + 1);
  let native = new Set<string>();
  const { getLive, pageLiveKeys } = await import('./live');
  if (pageLiveKeys(objs, new Set()).key) {
    try {
      const live = await getLive(src, item, objs, new Set());
      pg = live.page;
      native = live.native;
    } catch (e) {
      console.warn('Redaction: could not apply edits to the page first', e);
    }
  }
  const vp = pg.getViewport({ scale: REDACT_SCALE });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(vp.width);
  canvas.height = Math.ceil(vp.height);
  await pg.render({
    canvas,
    viewport: vp,
    intent: 'print',
    annotationMode: AnnotationMode.ENABLE_STORAGE,
  }).promise;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const S = REDACT_SCALE;
  // Solid fills first, then background matches, which may sample next to a solid box.
  for (const o of objs) {
    if (o.type !== 'redact' || o.match) continue;
    ctx.fillStyle = o.color;
    ctx.fillRect(o.x * S, o.y * S, o.w * S, o.h * S);
  }
  // The same patches are drawn again on top, over anything placed in the boxes.
  await matchPatches(out, src, item, objs, res, canvas);
  const blob = await new Promise<Blob>((ok, no) => canvas.toBlob((b) => (b ? ok(b) : no(new Error('Rasterize failed'))), 'image/png'));
  canvas.width = canvas.height = 0;
  const img = await out.embedPng(new Uint8Array(await blob.arrayBuffer()));
  const page = out.addPage([item.w, item.h]);
  page.drawImage(img, { x: 0, y: 0, width: item.w, height: item.h });
  return { page, native };
}

/** Drops link targets that point at pages being redacted. */
function scrubDestinations(doc: PDFDocument, page: PDFPage, refs: Set<string>) {
  const annots = page.node.Annots();
  if (!annots) return;
  const hits = (v: PDFObject | undefined) => {
    const arr = v instanceof PDFRef ? doc.context.lookup(v) : v;
    if (!(arr instanceof PDFArray) || !arr.size()) return false;
    const first = arr.get(0);
    return first instanceof PDFRef && refs.has(first.tag);
  };
  for (let i = 0; i < annots.size(); i++) {
    const a = doc.context.lookup(annots.get(i));
    if (!(a instanceof PDFDict)) continue;
    if (hits(a.get(PDFName.of('Dest')))) a.delete(PDFName.of('Dest'));
    const act = doc.context.lookup(a.get(PDFName.of('A')));
    if (act instanceof PDFDict && hits(act.get(PDFName.of('D')))) a.delete(PDFName.of('A'));
  }
}

/* ------------------------------------------------------------------ */
/* Forms                                                                */
/* ------------------------------------------------------------------ */

/** Points the new document's AcroForm at the widgets that came along with copied pages. */
function rebuildAcroForm(out: PDFDocument, pages: PDFPage[], sources: Map<string, PDFDocument>) {
  const ctx = out.context;
  const roots: PDFRef[] = [];
  const seen = new Set<string>();
  for (const page of pages) {
    const annots = page.node.Annots();
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i++) {
      const first = annots.get(i);
      if (!(first instanceof PDFRef)) continue;
      let ref: PDFRef = first;
      const dict = ctx.lookup(ref);
      if (!(dict instanceof PDFDict) || dict.get(PDFName.of('Subtype'))?.toString() !== '/Widget') continue;
      let cur: PDFDict = dict;
      for (let guard = 0; guard < 32; guard++) {
        const parent = cur.get(PDFName.of('Parent'));
        if (!(parent instanceof PDFRef)) break;
        const pd = ctx.lookup(parent);
        if (!(pd instanceof PDFDict)) break;
        ref = parent;
        cur = pd;
      }
      if (!seen.has(ref.tag)) {
        seen.add(ref.tag);
        roots.push(ref);
      }
    }
  }
  if (!roots.length) return;
  const acro = ctx.obj({ Fields: roots });
  for (const src of sources.values()) {
    const srcAcro = src.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
    if (!srcAcro) continue;
    const copier = PDFObjectCopier.for(src.context, ctx);
    for (const key of ['DA', 'DR', 'Q']) {
      const v = srcAcro.get(PDFName.of(key));
      if (v && !acro.has(PDFName.of(key))) acro.set(PDFName.of(key), copier.copy(v));
    }
    break;
  }
  out.catalog.set(PDFName.of('AcroForm'), ctx.register(acro));
}

/* ------------------------------------------------------------------ */
/* Bookmarks                                                            */
/* ------------------------------------------------------------------ */

interface OutlineNode {
  title: string;
  dest: string | unknown[] | null;
  url: string | null;
  items: OutlineNode[];
  bold?: boolean;
  italic?: boolean;
}

async function writeOutline(out: PDFDocument, input: ExportInput, pages: PageItem[], outPages: PDFPage[]) {
  const primary = input.docs[pages[0]?.src];
  if (!primary) return;
  const outline = (await primary.pdf.getOutline()) as OutlineNode[] | null;
  if (!outline?.length) return;
  const target = new Map<number, PDFRef>();
  pages.forEach((p, i) => {
    if (p.src === primary.id && !target.has(p.index)) target.set(p.index, outPages[i].ref);
  });
  const ctx = out.context;

  const resolve = async (dest: OutlineNode['dest']) => {
    try {
      const explicit = typeof dest === 'string' ? await primary.pdf.getDestination(dest) : dest;
      if (!Array.isArray(explicit) || !explicit.length) return null;
      const ref = explicit[0];
      const idx = typeof ref === 'number' ? ref : await primary.pdf.getPageIndex(ref as { num: number; gen: number });
      const pageRef = target.get(idx);
      if (!pageRef) return null;
      const kind = (explicit[1] as { name?: string })?.name ?? 'Fit';
      const args = explicit.slice(2).map((v) => (typeof v === 'number' ? PDFNumber.of(v) : PDFNull));
      return ctx.obj([pageRef, PDFName.of(kind), ...args]);
    } catch {
      return null;
    }
  };

  const build = async (items: OutlineNode[], parent: PDFRef): Promise<{ first: PDFRef; last: PDFRef; count: number } | null> => {
    const refs = items.map(() => ctx.nextRef());
    let count = 0;
    for (const [i, item] of items.entries()) {
      const dict = ctx.obj({ Title: PDFHexString.fromText(item.title || 'Untitled'), Parent: parent });
      if (i > 0) dict.set(PDFName.of('Prev'), refs[i - 1]);
      if (i < items.length - 1) dict.set(PDFName.of('Next'), refs[i + 1]);
      const dest = await resolve(item.dest);
      if (dest) dict.set(PDFName.of('Dest'), dest);
      else if (item.url) dict.set(PDFName.of('A'), ctx.obj({ S: 'URI', URI: PDFString.of(item.url) }));
      const flags = (item.italic ? 1 : 0) | (item.bold ? 2 : 0);
      if (flags) dict.set(PDFName.of('F'), PDFNumber.of(flags));
      if (item.items?.length) {
        const kids = await build(item.items, refs[i]);
        if (kids) {
          dict.set(PDFName.of('First'), kids.first);
          dict.set(PDFName.of('Last'), kids.last);
          dict.set(PDFName.of('Count'), PDFNumber.of(-kids.count));
        }
      }
      ctx.assign(refs[i], dict);
      count++;
    }
    return refs.length ? { first: refs[0], last: refs[refs.length - 1], count } : null;
  };

  const rootRef = ctx.nextRef();
  const top = await build(outline, rootRef);
  if (!top) return;
  ctx.assign(rootRef, ctx.obj({ Type: 'Outlines', First: top.first, Last: top.last, Count: top.count }));
  out.catalog.set(PDFName.of('Outlines'), rootRef);
}

/* ------------------------------------------------------------------ */
/* Garbage collection                                                   */
/* ------------------------------------------------------------------ */

/** Removes objects nothing references, e.g. leftovers pulled in by copying. */
function collectGarbage(doc: PDFDocument) {
  const ctx = doc.context;
  const seen = new Set<string>();
  const stack: PDFObject[] = [];
  const { Root, Info } = ctx.trailerInfo;
  if (Root) stack.push(Root);
  if (Info) stack.push(Info);
  while (stack.length) {
    const o = stack.pop()!;
    if (o instanceof PDFRef) {
      if (seen.has(o.tag)) continue;
      seen.add(o.tag);
      const v = ctx.lookup(o);
      if (v) stack.push(v);
    } else if (o instanceof PDFDict) {
      for (const [, v] of o.entries()) stack.push(v);
    } else if (o instanceof PDFArray) {
      for (const v of o.asArray()) stack.push(v);
    } else if (o instanceof PDFStream) {
      stack.push(o.dict);
    }
  }
  for (const [ref] of ctx.enumerateIndirectObjects()) if (!seen.has(ref.tag)) ctx.delete(ref);
}
