/**
 * Live rendering of edited pages. When a page has Edit-mode changes (rewritten
 * text, moved or deleted images), the editor shows a render of the page with
 * those changes applied to its real content, exactly as saving would, instead
 * of painting patches over the original. That's what makes edits seamless on
 * gradients, photos and other non-white backgrounds.
 */
import { PDFDocument } from '@cantoo/pdf-lib';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import type { Obj, PageItem, SourceDoc } from '../types';
import { applyContentEdits, loadLib } from './export';
import { docParams, pdfjs } from './pdfjs';

const libs = new Map<string, Promise<PDFDocument>>();

export function libFor(doc: SourceDoc) {
  let p = libs.get(doc.id);
  if (!p) {
    p = loadLib(doc.bytes, doc.password);
    p.catch(() => libs.delete(doc.id));
    libs.set(doc.id, p);
  }
  return p;
}

const r = (v: number) => v.toFixed(2);

/**
 * What an object contributes to the page's rendered content. Objects with the
 * same key render identically, so a render can be reused while keys match.
 */
export function liveKey(o: Obj, holes: ReadonlySet<string>): string | null {
  if (o.type === 'text' && o.cover) return `t:${r(o.cover.x)},${r(o.cover.y)},${r(o.cover.w)},${r(o.cover.h)}`;
  if (o.type === 'whiteout' && o.erase) return `e:${o.erase}:${r(o.x)},${r(o.y)},${r(o.w)},${r(o.h)}`;
  if (o.type === 'image' && o.orig) {
    const g = o.orig;
    const from = `${r(g.x)},${r(g.y)},${r(g.w)},${r(g.h)}`;
    return holes.has(o.id) ? `h:${from}` : `i:${from}>${r(o.x)},${r(o.y)},${r(o.w)},${r(o.h)}`;
  }
  return null;
}

export interface LiveRender {
  /** Combined key of every content edit this render reflects. */
  key: string;
  /** Per-object keys at render time. */
  keys: Map<string, string>;
  /** Objects whose edit was applied to the real content (no cover needed). */
  native: Set<string>;
  pdf: PDFDocumentProxy;
  page: PDFPageProxy;
}

export function pageLiveKeys(objects: Obj[], holes: ReadonlySet<string>) {
  const keys = new Map<string, string>();
  for (const o of objects) {
    const k = liveKey(o, holes);
    if (k) keys.set(o.id, k);
  }
  const key = [...keys.entries()]
    .map(([id, k]) => `${id}=${k}`)
    .sort()
    .join('|');
  return { key, keys };
}

/** Builds a one-page PDF with the edits applied and opens it with pdf.js. */
export async function buildLive(doc: SourceDoc, item: PageItem, objects: Obj[], holes: ReadonlySet<string>): Promise<LiveRender> {
  const { key, keys } = pageLiveKeys(objects, holes);
  const lib = await libFor(doc);
  const out = await PDFDocument.create({ updateMetadata: false });
  const [page] = await out.copyPages(lib, [item.index]);
  out.addPage(page);
  // Images being dragged are cut out entirely; the overlay draws them at the pointer.
  const forRender: Obj[] = objects.map((o) =>
    o.type === 'image' && o.orig && holes.has(o.id)
      ? { id: o.id, page: o.page, created: o.created, opacity: 1, type: 'whiteout', ...o.orig, color: '#ffffff', erase: 'image' }
      : o,
  );
  const native = applyContentEdits(out, page, item.m, forRender);
  const bytes = await out.save({ useObjectStreams: false });
  const pdf = await pdfjs.getDocument(docParams(bytes)).promise;
  return { key, keys, native, pdf, page: await pdf.getPage(1) };
}

/* Builds are shared by the page view and its thumbnail, keyed by their edits. */
const builds = new Map<string, Promise<LiveRender>>();
const MAX_BUILDS = 24;

export function getLive(doc: SourceDoc, item: PageItem, objects: Obj[], holes: ReadonlySet<string>) {
  const cacheKey = `${doc.id}:${item.index}:${pageLiveKeys(objects, holes).key}`;
  let p = builds.get(cacheKey);
  if (p) {
    builds.delete(cacheKey);
    builds.set(cacheKey, p);
    return p;
  }
  p = buildLive(doc, item, objects, holes);
  p.catch(() => builds.delete(cacheKey));
  builds.set(cacheKey, p);
  while (builds.size > MAX_BUILDS) {
    const [oldest, old] = builds.entries().next().value!;
    builds.delete(oldest);
    void old.then((l) => l.pdf.loadingTask.destroy()).catch(() => {});
  }
  return p;
}

export function forgetLiveSources() {
  libs.clear();
  for (const p of builds.values()) void p.then((l) => l.pdf.loadingTask.destroy()).catch(() => {});
  builds.clear();
}
