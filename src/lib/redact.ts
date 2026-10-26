/**
 * Precise redaction, the way Acrobat does it: only what lies under a
 * redaction mark is removed. Text loses the individual glyphs inside a mark
 * (neighbouring words stay real, selectable, editable text), images get the
 * covered pixels painted over in a new copy, vector shapes mostly inside a mark
 * are dropped, and annotations touching a mark are deleted. The same goes for
 * content inside form XObjects: the page gets its own copy of each form it
 * changes. Pages with content that can't be removed this way are flattened
 * instead, as a safe fallback.
 */
import { PDFArray, PDFDict, PDFName, PDFNumber, type PDFDocument, type PDFPage } from '@cantoo/pdf-lib';
import type { PDFPageProxy } from 'pdfjs-dist';
import type { FillObj, Matrix, Obj, PageItem, Rect } from '../types';
import { applyMatrix, objBounds } from './geometry';
import { measureText } from './fonts';
import { analyzePage, ContentEdits, overlap, quadRect, redactRun, type OpRef, type RunItem, type TextRun } from './content';
import { findImages, redactedImage } from './pdfjs';

export interface RedactionPlan {
  /** Why the page has to be flattened instead, or null when it doesn't. */
  fallback: string | null;
  /** Redacted copies of the images under the marks, matched later by position. */
  images: { rect: Rect; png: Uint8Array }[];
}

const area = (r: Rect) => Math.max(0, r.w) * Math.max(0, r.h);

function iou(a: Rect, b: Rect) {
  const o = overlap(a, b);
  return o / Math.max(1e-6, area(a) + area(b) - o);
}

/** Share of `r` lying under the marks. */
function covered(r: Rect, marks: Rect[]) {
  const a = area(r);
  if (!a) return 0;
  return Math.min(1, marks.reduce((t, m) => t + overlap(r, m), 0) / a);
}

const touches = (r: Rect, marks: Rect[]) => marks.some((m) => overlap(r, m) > 0);

export const marksOn = (objs: Obj[]) => objs.filter((o): o is FillObj => o.type === 'redact');

/** Our own objects mostly under a mark are left out of the saved file. */
export function hiddenByMarks(o: Obj, marks: Rect[]) {
  if (o.type === 'redact' || !marks.length) return false;
  return covered(objBounds(o, measureText), marks) >= 0.5;
}

/**
 * Works out, on the source page, whether precise redaction is possible, and
 * prepares redacted copies of any images under the marks.
 */
export async function planRedaction(lib: PDFDocument, item: PageItem, pdfPage: PDFPageProxy, marks: FillObj[]): Promise<RedactionPlan> {
  const a = analyzePage(lib.getPage(item.index));
  if (!a) return { fallback: null, images: [] };
  const m = item.m;

  // Forms are analysed like the page itself; only ones that can't be read are a problem.
  for (const f of a.forms) {
    if (touches(quadRect(f.quad, m), marks)) return { fallback: 'it draws grouped content (a form XObject) that could not be read under a redaction mark', images: [] };
  }

  const hits = a.images.map((im) => ({ im, rect: quadRect(im.quad, m) })).filter((h) => touches(h.rect, marks));
  if (!hits.length) return { fallback: null, images: [] };
  const decoded = await findImages(pdfPage, item, { all: true });
  const used = new Set<number>();
  const images: RedactionPlan['images'] = [];
  for (const { im, rect } of hits) {
    if (im.mask) {
      // A stencil mask has no pixels to edit; it can only go as a whole.
      if (covered(rect, marks) < 0.98) return { fallback: 'a stencil-mask image is only partly under a redaction mark', images: [] };
      continue;
    }
    let best = -1;
    let score = 0.9;
    decoded.forEach((d, i) => {
      const s = iou(d.rect, rect);
      if (s > score && !used.has(i)) {
        score = s;
        best = i;
      }
    });
    if (best < 0) return { fallback: 'an image under a redaction mark could not be read', images: [] };
    used.add(best);
    const under = marks.filter((mk) => overlap(rect, mk) > 0);
    const png = await redactedImage(pdfPage, decoded[best], under, (under[0] as FillObj).color ?? '#000000');
    if (!png) return { fallback: 'an image under a redaction mark could not be read', images: [] };
    images.push({ rect, png });
  }
  return { fallback: null, images };
}

/** Applies a plan to the copied page in the output document. */
export async function applyRedaction(out: PDFDocument, page: PDFPage, m: Matrix, marks: FillObj[], plan: RedactionPlan) {
  const a = analyzePage(page);
  if (a) {
    const edits = new ContentEdits(page);
    const strip = new Set<OpRef>();

    // Text: drop the glyphs under the marks, keep everything else in place.
    const glyphRect = (run: TextRun, it: RunItem) =>
      quadRect([applyMatrix(run.m, it.x0, run.lo), applyMatrix(run.m, it.x1, run.lo), applyMatrix(run.m, it.x1, run.hi), applyMatrix(run.m, it.x0, run.hi)], m);
    for (const run of a.runs) {
      if (!touches(quadRect(run.quad, m), marks)) continue;
      const drop = (it: RunItem) => {
        const g = glyphRect(run, it);
        const cx = g.x + g.w / 2;
        const cy = g.y + g.h / 2;
        return covered(g, marks) >= 0.3 || marks.some((mk) => cx >= mk.x && cx <= mk.x + mk.w && cy >= mk.y && cy <= mk.y + mk.h);
      };
      const replacement = redactRun(run.node.ops[run.index], run, drop);
      if (replacement === null) continue;
      edits.set(run.node, run.index, replacement);
      // Alternate text attached to the surrounding tags could repeat what was removed.
      for (const mk of run.marked) if (mk.node.inlineProps.has(mk.index)) strip.add(mk);
    }

    // Vector shapes that sit mostly under a mark (signatures, scribbles) go entirely.
    for (const p of a.paths) {
      if (p.clips || p.points.length < 2) continue;
      const xs = p.points.map((q) => q.x);
      const ys = p.points.map((q) => q.y);
      const r = quadRect(
        [
          { x: Math.min(...xs), y: Math.min(...ys) },
          { x: Math.max(...xs), y: Math.min(...ys) },
          { x: Math.max(...xs), y: Math.max(...ys) },
          { x: Math.min(...xs), y: Math.max(...ys) },
        ],
        m,
      );
      const inside = area(r) > 0 ? covered(r, marks) : marks.some((mk) => r.x >= mk.x && r.x <= mk.x + mk.w && r.y >= mk.y && r.y <= mk.y + mk.h) ? 1 : 0;
      if (inside < 0.8) continue;
      for (let k = p.start; k <= p.end; k++) if (!edits.has(p.node, k) && isPathOp(p.node.ops[k].op)) edits.set(p.node, k, '');
    }

    // Images: swap in the copy with the covered pixels painted over.
    const used = new Set<number>();
    for (const im of a.images) {
      const rect = quadRect(im.quad, m);
      if (!touches(rect, marks)) continue;
      if (im.mask) {
        edits.set(im.node, im.index, '');
        continue;
      }
      const i = plan.images.findIndex((p, k) => !used.has(k) && iou(p.rect, rect) > 0.9);
      if (i < 0) {
        // Shouldn't happen (the plan saw the same content); never keep it unredacted.
        edits.set(im.node, im.index, '');
        continue;
      }
      used.add(i);
      const img = await out.embedPng(plan.images[i].png);
      edits.set(im.node, im.index, `${edits.xobject(im.node, 'Redacted', img.ref)} Do`);
    }

    for (const mk of strip) if (!edits.has(mk.node, mk.index)) edits.set(mk.node, mk.index, `/${mk.node.inlineProps.get(mk.index)} BMC`);
    if (edits.size) edits.commit();
  }
  removeAnnotations(out, page, m, marks);
}

const PATH_OPS = new Set(['m', 'l', 'c', 'v', 'y', 'h', 're', 'S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*']);
const isPathOp = (op: string) => PATH_OPS.has(op);

/** Links, comments and form widgets touching a mark are deleted. */
function removeAnnotations(doc: PDFDocument, page: PDFPage, m: Matrix, marks: Rect[]) {
  const annots = page.node.Annots();
  if (!annots) return;
  for (let i = annots.size() - 1; i >= 0; i--) {
    const dict = doc.context.lookup(annots.get(i));
    if (!(dict instanceof PDFDict)) continue;
    const rect = dict.lookupMaybe(PDFName.of('Rect'), PDFArray);
    if (!rect || rect.size() < 4) continue;
    const [x1, y1, x2, y2] = rect.asArray().map((v) => (doc.context.lookup(v) as PDFNumber)?.asNumber?.() ?? 0);
    const r = quadRect(
      [
        { x: x1, y: y1 },
        { x: x2, y: y1 },
        { x: x2, y: y2 },
        { x: x1, y: y2 },
      ],
      m,
    );
    if (touches(r, marks)) annots.remove(i);
  }
}
