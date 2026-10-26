/**
 * The text a page shows right now, for its text layer (select, copy,
 * highlight) and for search. A page with Edit-mode changes takes its text
 * from the live render (see live.ts), whose content has the replaced
 * wording removed exactly as saving removes it, and every page gets the text
 * of the text objects drawn on it, which saving writes as real text too.
 */
import type { TextContent, TextItem } from 'pdfjs-dist/types/src/display/api';
import type { Matrix, Obj, PageItem, SourceDoc, TextObj } from '../types';
import { applyMatrix, invertMatrix } from './geometry';
import { firstBaseline, layoutText, LINE_HEIGHT, measureText, TEXT_PAD } from './fonts';
import { getLive, pageLiveKeys, type LiveRender } from './live';
import { getText } from './pdfjs';
import { withOcr, type OcrPage } from './ocrModel';
import { mul } from './content';

const NO_HOLES = new Set<string>();

const r = (v: number) => v.toFixed(2);

const textObjects = (objects: Obj[]) => objects.filter((o): o is TextObj => o.type === 'text' && !!o.text.trim());

/** OCR results are replaced, never mutated, so identity tells them apart. */
const ocrIds = new WeakMap<OcrPage, number>();
let ocrSeq = 0;
const ocrTag = (ocr?: OcrPage) => {
  if (!ocr) return '';
  let id = ocrIds.get(ocr);
  if (!id) ocrIds.set(ocr, (id = ++ocrSeq));
  return `ocr${id}`;
};

/** Identifies the text a page shows: equal keys, equal text. */
export function pageTextKey(objects: Obj[], ocr?: OcrPage): string {
  const live = pageLiveKeys(objects, NO_HOLES).key;
  const texts = textObjects(objects)
    .map((o) => [o.id, r(o.x), r(o.y), o.size, o.font, o.width ?? '', o.lineHeight ?? '', o.hscale ?? '', o.rotate ?? '', o.text].join(','))
    .sort()
    .join('|');
  const recognized = ocrTag(ocr);
  return live || texts || recognized ? `${live}#${texts}#${recognized}` : '';
}

/** Text of an edited page as its live render shows it (one extraction per render). */
const liveText = new WeakMap<LiveRender, Promise<TextContent>>();

async function baseText(doc: SourceDoc, item: PageItem, objects: Obj[], ocr?: OcrPage): Promise<TextContent> {
  if (pageLiveKeys(objects, NO_HOLES).key) {
    try {
      const live = await getLive(doc, item, objects, NO_HOLES);
      let p = liveText.get(live);
      if (!p) {
        p = live.page.getTextContent({ disableNormalization: true });
        liveText.set(live, p);
      }
      // Recognized words of a scanned page join the edited page's text too.
      return ocr ? withOcr(await p, ocr) : await p;
    } catch (e) {
      console.warn('Text of the edited page is not available; using the original', e);
    }
  }
  return getText(doc, item.index, ocr);
}

const FONT_FAMILY = { sans: 'sans-serif', serif: 'serif', mono: 'monospace' } as const;

/** One text item per line of a text object, placed where the object draws it (as export.ts does). */
function objectItems(o: TextObj, item: PageItem): TextItem[] {
  const lh = o.lineHeight ?? LINE_HEIGHT;
  const hs = o.hscale ?? 1;
  const base = firstBaseline(o, lh);
  // Page space -> PDF user space, with the object's rotation about its center.
  let toUser: Matrix = invertMatrix(item.m);
  if (o.rotate) {
    const box = measureText(o);
    const cx = o.x + box.w / 2;
    const cy = o.y + box.h / 2;
    const a = (o.rotate * Math.PI) / 180;
    const rot: Matrix = [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0];
    toUser = mul(mul(mul([1, 0, 0, 1, -cx, -cy], rot), [1, 0, 0, 1, cx, cy]), toUser);
  }
  const out: TextItem[] = [];
  layoutText(o).forEach((line, i) => {
    const str = line.text.replace(/\s+$/, '');
    if (!str) return;
    const at: Matrix = [o.size * hs, 0, 0, -o.size, o.x + TEXT_PAD, o.y + base + i * o.size * lh];
    out.push({ str, dir: 'ltr', width: line.width * hs, height: o.size, transform: mul(at, toUser), fontName: `folio-${o.font}`, hasEOL: true });
  });
  return out;
}

export interface PageText {
  key: string;
  content: TextContent;
}

const cache = new Map<string, Promise<PageText>>();
const MAX_CACHED = 64;

/**
 * The page's text as it looks now. Items from text objects are placed among
 * the page's own text in reading order, so selections run through them
 * naturally.
 */
export function pageText(doc: SourceDoc, item: PageItem, objects: Obj[], ocr?: OcrPage): Promise<PageText> {
  const key = pageTextKey(objects, ocr);
  const id = `${doc.id}:${item.index}:${item.m.join(',')}:${key}`;
  let p = cache.get(id);
  if (p) return p;
  p = (async () => {
    const content = await baseText(doc, item, objects, ocr);
    const texts = textObjects(objects);
    if (!texts.length) return { key, content };
    // Where each text item starts, in page space (marked-content markers have no position).
    const all = content.items;
    const starts = all.map((it) => ('str' in it ? applyMatrix(item.m, it.transform[4], it.transform[5]) : null));
    const groups = texts
      .map((o) => {
        const lines = objectItems(o, item);
        const first = applyMatrix(item.m, lines[0]?.transform[4] ?? 0, lines[0]?.transform[5] ?? 0);
        // Before the first item that comes later in reading order (further down, or right of it on its line).
        let at = starts.findIndex((s) => !!s && (s.y > first.y + o.size * 0.5 || (Math.abs(s.y - first.y) <= o.size * 0.5 && s.x > first.x)));
        if (at < 0) at = all.length;
        return { at, lines };
      })
      .filter((g) => g.lines.length)
      .sort((a, b) => a.at - b.at);
    const merged: TextContent['items'] = [];
    let last: TextItem | null = null;
    let next = 0;
    const take = (it: TextContent['items'][number]) => {
      merged.push(it);
      if ('str' in it) last = it;
    };
    for (const g of groups) {
      while (next < g.at) take(all[next++]);
      // Keep the object's words apart from the text before it.
      if (last && !(last as TextItem).hasEOL) take({ str: '', dir: 'ltr', width: 0, height: 0, transform: [1, 0, 0, 1, 0, 0], fontName: 'folio-sans', hasEOL: true });
      g.lines.forEach(take);
    }
    while (next < all.length) take(all[next++]);
    const styles = { ...content.styles };
    for (const [font, fontFamily] of Object.entries(FONT_FAMILY)) styles[`folio-${font}`] = { fontFamily, ascent: 0.8, descent: -0.2, vertical: false };
    return { key, content: { ...content, items: merged, styles } };
  })();
  p.catch(() => cache.delete(id));
  cache.set(id, p);
  while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
  return p;
}
