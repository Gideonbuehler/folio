import type { Obj, Rect } from '../types';
import { actions, commit } from '../store';
import { clientToPage, mergeLineRects } from './geometry';
import { uid } from './util';
import { backgroundColorAt } from './sample';

export interface PageRects {
  page: string;
  rects: Rect[];
}

/** The current text selection, if it lies in page text. */
export function pageSelection(): Selection | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  const el = (n: Node) => (n.nodeType === Node.ELEMENT_NODE ? (n as Element) : n.parentElement);
  if (!el(range.startContainer)?.closest('.textLayer') && !el(range.endContainer)?.closest('.textLayer')) return null;
  return sel;
}

/** Converts the selection's client rectangles into page-space rectangles per page. */
export function selectionRects(): { groups: PageRects[]; text: string } {
  const sel = pageSelection();
  if (!sel) return { groups: [], text: '' };
  const { pages, zoom } = actions.get();
  const byId = new Map(pages.map((p) => [p.id, p]));
  const pageEls = [...document.querySelectorAll<HTMLElement>('.viewer .page[data-page-id]')];
  const boxes = pageEls.map((el) => ({ el, r: el.getBoundingClientRect() }));
  const raw = [...sel.getRangeAt(0).getClientRects()].filter((r) => r.width > 0.5 && r.height > 0.5);
  const heights = raw.map((r) => r.height).sort((a, b) => a - b);
  const median = heights[Math.floor(heights.length / 2)] ?? 0;
  const out = new Map<string, Rect[]>();
  for (const r of raw) {
    // Skip the oversized boxes some browsers report for whole text layers.
    if (r.height > median * 2.5 && raw.length > 1) continue;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const hit = boxes.find((b) => cx >= b.r.left && cx <= b.r.right && cy >= b.r.top && cy <= b.r.bottom);
    if (!hit) continue;
    const id = hit.el.dataset.pageId!;
    const page = byId.get(id);
    if (!page) continue;
    const a = clientToPage(hit.el, page, zoom, r.left, r.top);
    const b = clientToPage(hit.el, page, zoom, r.right, r.bottom);
    const rect = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
    if (rect.w < 0.5 || rect.h < 0.5) continue;
    const list = out.get(id);
    if (list) list.push(rect);
    else out.set(id, [rect]);
  }
  const groups = [...out.entries()].map(([page, rects]) => ({ page, rects: mergeLineRects(rects) }));
  return { groups, text: sel.toString().replace(/\s+/g, ' ').trim() };
}

export type MarkupKind = 'highlight' | 'underline' | 'strike' | 'redact';

/** Turns the current text selection into markups (or redaction boxes). */
export function markupSelection(kind: MarkupKind) {
  const { groups, text } = selectionRects();
  if (!groups.length) return false;
  const s = actions.get();
  const base = { created: Date.now(), author: s.userName, opacity: 1 };
  const objs: Obj[] = [];
  for (const g of groups) {
    if (kind === 'redact') {
      const page = s.pages.find((p) => p.id === g.page)!;
      for (const r of g.rects) {
        const box = { x: r.x - 0.5, y: r.y - 0.5, w: r.w + 1, h: r.h + 1 };
        const color = s.style.redactMatch ? backgroundColorAt(g.page, page, s.zoom, box) : s.style.redactColor;
        objs.push({ ...base, id: uid(), page: g.page, type: 'redact', ...box, color, match: s.style.redactMatch || undefined });
      }
    } else {
      objs.push({ ...base, id: uid(), page: g.page, type: kind, rects: g.rects, color: s.style[kind], text });
    }
  }
  commit((st) => ({ objects: [...st.objects, ...objs] }));
  window.getSelection()?.removeAllRanges();
  return true;
}
