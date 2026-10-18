import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Copy, EyeOff, Highlighter, Strikethrough, Underline } from 'lucide-react';
import type { Obj, PageItem } from '../types';
import { actions, scrollToPage, toast, useStore, ZOOM_MAX, ZOOM_MIN } from '../store';
import { clientToPage, displaySize } from '../lib/geometry';
import { markupSelection, pageSelection, type MarkupKind } from '../lib/selection';
import { insertImageFile } from '../lib/images';
import { PageView } from './PageView';
import { requestEditAt } from './Overlay';

const GAP = 16;
const PAD_Y = 24;
const PAD_X = 24;
const EMPTY: Obj[] = [];
const MARKUP_TOOLS = ['highlight', 'underline', 'strike'];

/** A zoom anchor in client coordinates, consumed by the next zoom change. */
let zoomAnchor: { x: number; y: number } | null = null;

export function setZoomAnchor(x: number, y: number) {
  zoomAnchor = { x, y };
}

interface Layout {
  tops: number[];
  sizes: { w: number; h: number }[];
  total: number;
  maxW: number;
}

function computeLayout(pages: PageItem[], zoom: number): Layout {
  const tops: number[] = [];
  const sizes: { w: number; h: number }[] = [];
  let y = PAD_Y;
  let maxW = 0;
  for (const p of pages) {
    const d = displaySize(p, zoom);
    tops.push(y);
    sizes.push(d);
    y += d.h + GAP;
    maxW = Math.max(maxW, d.w);
  }
  return { tops, sizes, total: y - GAP + PAD_Y, maxW };
}

export function Viewer() {
  const pages = useStore((s) => s.pages);
  const objects = useStore((s) => s.objects);
  const zoom = useStore((s) => s.zoom);
  const fit = useStore((s) => s.fit);
  const tool = useStore((s) => s.tool);
  const scrollReq = useStore((s) => s.scrollReq);
  const currentPage = useStore((s) => s.currentPage);
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [scroll, setScroll] = useState({ top: 0, left: 0 });
  const [popover, setPopover] = useState<{ x: number; y: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current!;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  /* Fit modes recompute zoom as the window or document changes. */
  useEffect(() => {
    if (!fit || !size.w || !pages.length) return;
    const unit = computeLayout(pages, 1);
    let z = (size.w - PAD_X * 2 - 4) / unit.maxW;
    if (fit === 'page') {
      const cur = unit.sizes[Math.min(currentPage, pages.length - 1)];
      z = Math.min((size.w - PAD_X * 2) / cur.w, (size.h - PAD_Y * 2) / cur.h);
    }
    z = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(z * 1000) / 1000));
    if (Math.abs(z - actions.get().zoom) > 0.001) actions.set({ zoom: z });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fit, size.w, size.h, pages]);

  const layout = useMemo(() => computeLayout(pages, zoom), [pages, zoom]);
  const contentW = Math.max(size.w, layout.maxW + PAD_X * 2);
  const prev = useRef({ layout, zoom, pages, contentW });

  /* Keep the point under the cursor (or the view center) fixed while zooming. */
  useLayoutEffect(() => {
    const el = ref.current!;
    const old = prev.current;
    prev.current = { layout, zoom, pages, contentW };
    if (old.zoom === zoom || old.pages !== pages || !pages.length) {
      zoomAnchor = null;
      return;
    }
    const rect = el.getBoundingClientRect();
    // Explicit zooms anchor where asked; automatic ones (fit modes) keep the top in place.
    const ax = zoomAnchor ? zoomAnchor.x - rect.left : el.clientWidth / 2;
    const ay = zoomAnchor ? zoomAnchor.y - rect.top : 0;
    zoomAnchor = null;
    const X = el.scrollLeft + ax;
    const Y = el.scrollTop + ay;
    let i = old.layout.tops.findIndex((t, k) => Y < t + old.layout.sizes[k].h + GAP);
    if (i < 0) i = pages.length - 1;
    const os = old.layout.sizes[i];
    const oldLeft = (old.contentW - os.w) / 2;
    const fx = (X - oldLeft) / os.w;
    const fy = (Y - old.layout.tops[i]) / os.h;
    const ns = layout.sizes[i];
    const newLeft = (contentW - ns.w) / 2;
    el.scrollTop = layout.tops[i] + fy * ns.h - ay;
    el.scrollLeft = newLeft + fx * ns.w - ax;
  }, [layout, zoom, pages, contentW]);

  /* Programmatic scrolling (thumbnails, links, search). */
  useLayoutEffect(() => {
    if (!scrollReq || !ref.current) return;
    const el = ref.current;
    const top = layout.tops[scrollReq.page];
    if (top === undefined) return;
    const y = scrollReq.y && scrollReq.y > 0 ? scrollReq.y * zoom : 0;
    el.scrollTo({ top: top - 12 + y, behavior: 'auto' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollReq]);

  const frame = useRef(0);
  const onScroll = () => {
    const el = ref.current!;
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      setScroll({ top: el.scrollTop, left: el.scrollLeft });
      const probe = el.scrollTop + el.clientHeight * 0.35;
      let cur = 0;
      for (let i = 0; i < layout.tops.length; i++) {
        if (layout.tops[i] <= probe) cur = i;
        else break;
      }
      if (cur !== actions.get().currentPage) actions.set({ currentPage: cur });
    });
  };

  /* Ctrl/⌘ + wheel (and trackpad pinch) zooms around the cursor. */
  useEffect(() => {
    const el = ref.current!;
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const z = actions.get().zoom;
      const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0022));
      const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z * factor));
      setZoomAnchor(e.clientX, e.clientY);
      actions.set({ zoom: Math.round(next * 1000) / 1000, fit: null });
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, []);

  /* Visible pages, with a screen of overscan either side. */
  const visible: number[] = [];
  const lo = scroll.top - size.h;
  const hi = scroll.top + size.h * 2;
  for (let i = 0; i < pages.length; i++) {
    const t = layout.tops[i];
    if (t > hi) break;
    if (t + layout.sizes[i].h >= lo) visible.push(i);
  }

  const byPage = useMemo(() => {
    const m = new Map<string, Obj[]>();
    for (const o of objects) {
      const l = m.get(o.page);
      if (l) l.push(o);
      else m.set(o.page, [o]);
    }
    return m;
  }, [objects]);

  /* Pointer handling that isn't specific to one page. */
  const onPointerDown = (e: React.PointerEvent) => {
    const target = e.target as Element;
    const pan = tool === 'hand' || e.button === 1;
    if (pan) {
      e.preventDefault();
      const el = ref.current!;
      const sx = e.clientX;
      const sy = e.clientY;
      const st = el.scrollTop;
      const sl = el.scrollLeft;
      el.classList.add('panning');
      const move = (ev: PointerEvent) => {
        el.scrollTop = st - (ev.clientY - sy);
        el.scrollLeft = sl - (ev.clientX - sx);
      };
      const up = () => {
        el.classList.remove('panning');
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      return;
    }
    if (e.button !== 0) return;
    if (target.closest('[data-id], [data-handle], .note-popup, .tobj-edit, .sel-popover')) return;
    const s = actions.get();
    if (s.selection.length || s.openNote) actions.set({ selection: [], openNote: null });
    setPopover(null);
  };

  const onPointerUp = () => {
    if (tool !== 'select' && !MARKUP_TOOLS.includes(tool)) return;
    // Let the browser finish updating the selection first.
    setTimeout(() => {
      const sel = pageSelection();
      if (!sel) return;
      if (MARKUP_TOOLS.includes(tool)) {
        markupSelection(tool as MarkupKind);
        return;
      }
      const r = sel.getRangeAt(0).getBoundingClientRect();
      setPopover({ x: r.left + r.width / 2, y: r.top });
    }, 0);
  };

  useEffect(() => {
    const onSel = () => {
      if (!pageSelection()) setPopover(null);
    };
    document.addEventListener('selectionchange', onSel);
    return () => document.removeEventListener('selectionchange', onSel);
  }, []);

  useEffect(() => setPopover(null), [scroll.top, zoom]);

  /* Dropping an image onto a page places it there. */
  const onDrop = (e: React.DragEvent) => {
    const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    e.stopPropagation();
    const pageEl = (e.target as Element).closest<HTMLElement>('.page[data-page-id]');
    const s = actions.get();
    const idx = pageEl ? Number(pageEl.dataset.pageIndex) : s.currentPage;
    const at = pageEl ? clientToPage(pageEl, s.pages[idx], s.zoom, e.clientX, e.clientY) : undefined;
    files.forEach((f, i) => insertImageFile(f, { pageIndex: idx, at: at && { x: at.x + i * 16, y: at.y + i * 16 } }));
  };

  /* Double-clicking page text in Select mode opens that paragraph for editing. */
  const onDoubleClick = (e: React.MouseEvent) => {
    if (tool !== 'select') return;
    const target = e.target as Element;
    if (!target.closest('.textLayer') || target.closest('[data-id]')) return;
    const pageEl = target.closest<HTMLElement>('.page[data-page-id]');
    if (!pageEl) return;
    const s = actions.get();
    const page = s.pages[Number(pageEl.dataset.pageIndex)];
    if (!page) return;
    window.getSelection()?.removeAllRanges();
    setPopover(null);
    requestEditAt(page.id, clientToPage(pageEl, page, s.zoom, e.clientX, e.clientY));
    actions.set({ tool: 'editText', selection: [] });
  };

  const runMarkup = useCallback((k: MarkupKind) => {
    markupSelection(k);
    setPopover(null);
  }, []);

  return (
    <div
      ref={ref}
      className={`viewer tool-${tool}`}
      onScroll={onScroll}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onDoubleClick={onDoubleClick}
      onDragOver={(e) => {
        if ([...e.dataTransfer.items].some((i) => i.type.startsWith('image/'))) {
          e.preventDefault();
          e.stopPropagation();
        }
      }}
      onDrop={onDrop}
    >
      <div className="viewer-content" style={{ height: layout.total, width: contentW }}>
        {visible.map((i) => {
          const p = pages[i];
          return (
            <PageView
              key={p.id}
              page={p}
              index={i}
              zoom={zoom}
              top={layout.tops[i]}
              left={(contentW - layout.sizes[i].w) / 2}
              objects={byPage.get(p.id) ?? EMPTY}
            />
          );
        })}
      </div>
      {popover && (
        <div className="sel-popover" style={{ left: popover.x, top: popover.y }} onPointerDown={(e) => e.preventDefault()}>
          <button type="button" data-tip="Highlight" onClick={() => runMarkup('highlight')}>
            <Highlighter size={16} />
          </button>
          <button type="button" data-tip="Underline" onClick={() => runMarkup('underline')}>
            <Underline size={16} />
          </button>
          <button type="button" data-tip="Strikethrough" onClick={() => runMarkup('strike')}>
            <Strikethrough size={16} />
          </button>
          <button type="button" data-tip="Mark for redaction" onClick={() => runMarkup('redact')}>
            <EyeOff size={16} />
          </button>
          <span className="sep" />
          <button
            type="button"
            data-tip="Copy text"
            onClick={async () => {
              const text = window.getSelection()?.toString() ?? '';
              try {
                await navigator.clipboard.writeText(text);
                toast('Copied to clipboard', 'success');
              } catch {
                document.execCommand('copy');
              }
              setPopover(null);
            }}
          >
            <Copy size={16} />
          </button>
        </div>
      )}
      <PageNav />
    </div>
  );
}

function PageNav() {
  const current = useStore((s) => s.currentPage);
  const count = useStore((s) => s.pages.length);
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <div className="page-nav" onPointerDown={(e) => e.stopPropagation()}>
      <button type="button" className="icon-btn sm" data-tip="Previous page" data-tip-side="top" onClick={() => scrollToPage(current - 1)} disabled={current <= 0}>
        <ChevronUp size={16} />
      </button>
      <input
        aria-label="Page number"
        value={draft ?? String(current + 1)}
        onFocus={(e) => {
          setDraft(String(current + 1));
          e.target.select();
        }}
        onChange={(e) => setDraft(e.target.value.replace(/\D/g, ''))}
        onBlur={() => setDraft(null)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') {
            const n = Number(draft);
            if (n >= 1) scrollToPage(n - 1);
            (e.target as HTMLInputElement).blur();
          }
          if (e.key === 'Escape') (e.target as HTMLInputElement).blur();
        }}
        style={{ width: `${Math.max(2, String(count).length) + 1.2}ch` }}
      />
      <span className="page-count">of {count}</span>
      <button
        type="button"
        className="icon-btn sm"
        data-tip="Next page"
        data-tip-side="top"
        onClick={() => scrollToPage(current + 1)}
        disabled={current >= count - 1}
      >
        <ChevronDown size={16} />
      </button>
    </div>
  );
}
