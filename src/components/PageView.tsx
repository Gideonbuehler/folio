import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { AnnotationLayer, AnnotationMode, TextLayer, type PDFPageProxy, type RenderTask } from 'pdfjs-dist';
import { Trash2, X } from 'lucide-react';
import type { Obj, PageItem } from '../types';
import { actions, deleteObjects, updateObjects, useStore } from '../store';
import { displaySize, objBounds, pageToDisplay } from '../lib/geometry';
import { measureText } from '../lib/fonts';
import { getText, IMAGE_RESOURCES, pageMeasured, viewportFor } from '../lib/pdfjs';
import { linkServiceFor } from '../lib/links';
import { getLive, pageLiveKeys, type LiveRender } from '../lib/live';
import { Overlay } from './Overlay';
import { OBJ_LABEL } from './labels';

const MAX_CANVAS_PIXELS = 16_777_216;

/** Which edits the canvas currently reflects (from the last live render drawn). */
export interface Shown {
  keys: Map<string, string>;
  native: Set<string>;
}
const NOTHING_SHOWN: Shown = { keys: new Map(), native: new Set() };

interface Props {
  page: PageItem;
  index: number;
  zoom: number;
  top: number;
  left: number;
  objects: Obj[];
}

export const PageView = memo(function PageView({ page, index, zoom, top, left, objects }: Props) {
  const doc = useStore((s) => s.docs[page.src]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const annotRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const [pdfPage, setPdfPage] = useState<PDFPageProxy | null>(null);
  const [rendered, setRendered] = useState(false);
  const [textLayer, setTextLayer] = useState<TextLayer | null>(null);
  const firstRender = useRef(true);
  const { w, h } = displaySize(page, zoom);

  useEffect(() => {
    let alive = true;
    doc?.pdf.getPage(page.index + 1).then((p) => {
      pageMeasured(doc, page.index, p);
      if (alive) setPdfPage(p);
    });
    return () => {
      alive = false;
    };
  }, [doc, page.index]);

  /* Edit-mode changes are shown by rendering the page with them applied. */
  const allHoles = useStore((s) => s.liveHoles);
  const holes = useMemo(() => new Set(allHoles.filter((id) => objects.some((o) => o.id === id))), [allHoles, objects]);
  const wanted = useMemo(() => pageLiveKeys(objects, holes).key, [objects, holes]);
  const [live, setLive] = useState<LiveRender | null>(null);
  const [liveFailed, setLiveFailed] = useState(false);
  useEffect(() => {
    if (!doc || !wanted) {
      setLive(null);
      return;
    }
    if (live?.key === wanted) return;
    let alive = true;
    const t = setTimeout(() => {
      getLive(doc, page, objects, holes)
        .then((l) => {
          if (!alive) return;
          setLiveFailed(false);
          setLive(l);
        })
        .catch((e) => {
          console.warn('Live render failed; showing covers instead', e);
          if (alive) setLiveFailed(true);
        });
    }, 30);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // Rebuild only when the content edits change, not on every object tweak.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted, doc, page.index]);

  /** What the canvas currently shows, so the overlay knows which edits are already visible. */
  const [shown, setShown] = useState<Shown>(NOTHING_SHOWN);
  /** Bumped whenever the canvas is redrawn, for previews sampled from it. */
  const [canvasVersion, setCanvasVersion] = useState(0);
  // Until the newest live render is ready, keep showing the previous one.
  const sourceLive = wanted && live ? live : null;
  const source = sourceLive?.page ?? pdfPage;
  const lastZoom = useRef(zoom);

  /* Canvas: rendered off-screen and swapped in, so zooming never flashes blank. */
  useEffect(() => {
    if (!source) return;
    let task: RenderTask | null = null;
    let cancelled = false;
    const zoomed = lastZoom.current !== zoom;
    lastZoom.current = zoom;
    const delay = firstRender.current || !zoomed ? 0 : 140;
    const timer = setTimeout(async () => {
      const dpr = window.devicePixelRatio || 1;
      const unit = viewportFor(source, page, 1);
      let scale = zoom * dpr;
      if (unit.width * unit.height * scale * scale > MAX_CANVAS_PIXELS) scale = Math.sqrt(MAX_CANVAS_PIXELS / (unit.width * unit.height));
      const vp = viewportFor(source, page, scale);
      const off = document.createElement('canvas');
      off.width = Math.floor(vp.width);
      off.height = Math.floor(vp.height);
      task = source.render({ canvas: off, viewport: vp, annotationMode: AnnotationMode.ENABLE_FORMS });
      try {
        await task.promise;
      } catch {
        off.width = off.height = 0;
        return;
      }
      const c = canvasRef.current;
      if (cancelled || !c) return;
      c.width = off.width;
      c.height = off.height;
      c.getContext('2d')!.drawImage(off, 0, 0);
      off.width = off.height = 0;
      firstRender.current = false;
      setRendered(true);
      setShown(sourceLive ? { keys: sourceLive.keys, native: sourceLive.native } : NOTHING_SHOWN);
      setCanvasVersion((v) => v + 1);
    }, delay);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      task?.cancel();
    };
    // `page` identity changes on rotation; zoom changes re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, page, zoom]);

  /* Text layer: built once per page/rotation; zoom is handled by CSS variables. */
  useEffect(() => {
    const div = textRef.current;
    if (!pdfPage || !div || !doc) return;
    div.replaceChildren();
    let alive = true;
    let layer: TextLayer | null = null;
    getText(doc, page.index).then(async (tc) => {
      if (!alive) return;
      layer = new TextLayer({ textContentSource: tc, container: div, viewport: viewportFor(pdfPage, page, actions.get().zoom) });
      try {
        await layer.render();
      } catch {
        return;
      }
      if (!alive) return;
      const end = document.createElement('div');
      end.className = 'endOfContent';
      div.append(end);
      setTextLayer(layer);
    });
    return () => {
      alive = false;
      layer?.cancel();
      setTextLayer(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfPage, doc, page.index, page.rotation]);

  useEffect(() => {
    if (!textLayer || !pdfPage) return;
    const t = setTimeout(() => textLayer.update({ viewport: viewportFor(pdfPage, page, zoom) }), 160);
    return () => clearTimeout(t);
  }, [textLayer, pdfPage, page, zoom]);

  /* Annotation layer: links and fillable form fields. */
  useEffect(() => {
    const div = annotRef.current;
    if (!pdfPage || !div || !doc) return;
    div.replaceChildren();
    let alive = true;
    (async () => {
      const annotations = await pdfPage.getAnnotations({ intent: 'display' });
      if (!alive || !annotations.length) return;
      const viewport = viewportFor(pdfPage, page, actions.get().zoom).clone({ dontFlip: true });
      const linkService = linkServiceFor(doc);
      const layer = new AnnotationLayer({
        div,
        page: pdfPage,
        viewport,
        accessibilityManager: null,
        annotationCanvasMap: null,
        annotationEditorUIManager: null,
        structTreeLayer: null,
        commentManager: null,
        linkService,
        annotationStorage: doc.pdf.annotationStorage,
      });
      await layer.render({
        annotations,
        viewport,
        div,
        page: pdfPage,
        linkService: linkService as never,
        annotationStorage: doc.pdf.annotationStorage,
        imageResourcesPath: IMAGE_RESOURCES,
        renderForms: true,
        enableScripting: false,
        hasJSActions: false,
        fieldObjects: null,
      });
      // Typing in a form field is a change worth saving.
      div.addEventListener('input', () => actions.set({ dirty: true }));
      div.addEventListener('change', () => actions.set({ dirty: true }));
    })().catch((e) => console.warn('Annotation layer failed', e));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfPage, doc, page.index, page.rotation]);

  const style = {
    top,
    left,
    width: w,
    height: h,
    '--scale-factor': zoom,
    '--total-scale-factor': zoom,
    '--user-unit': 1,
    '--scale-round-x': '1px',
    '--scale-round-y': '1px',
  } as CSSProperties;

  return (
    <div ref={pageRef} className={`page ${rendered ? 'rendered' : ''}`} style={style} data-page-id={page.id} data-page-index={index}>
      <canvas ref={canvasRef} className="page-canvas" />
      <div ref={textRef} className="textLayer" />
      <SearchHits page={page} zoom={zoom} textLayer={textLayer} pageRef={pageRef} />
      <div ref={annotRef} className="annotationLayer" />
      <Overlay page={page} zoom={zoom} objects={objects} pdfPage={pdfPage} canvasRef={canvasRef} shown={shown} holes={holes} liveFailed={liveFailed} canvasVersion={canvasVersion} />
      <CommentPopup page={page} zoom={zoom} objects={objects} />
      {!rendered && <div className="page-loading" />}
    </div>
  );
});

/* ------------------------------------------------------------------ */

function SearchHits({
  page,
  zoom,
  textLayer,
  pageRef,
}: {
  page: PageItem;
  zoom: number;
  textLayer: TextLayer | null;
  pageRef: React.RefObject<HTMLDivElement | null>;
}) {
  const hits = useStore((s) => s.search.hits);
  const active = useStore((s) => s.search.active);
  const scrollReq = useStore((s) => s.scrollReq);
  const [rects, setRects] = useState<{ x: number; y: number; w: number; h: number; active: boolean }[]>([]);
  const activeRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!textLayer || !pageRef.current) {
      setRects([]);
      return;
    }
    const mine = hits.map((h, i) => ({ h, i })).filter(({ h }) => h.page === page.id);
    if (!mine.length) {
      setRects([]);
      return;
    }
    const compute = () => {
      const base = pageRef.current!.getBoundingClientRect();
      const divs = textLayer.textDivs;
      const out: typeof rects = [];
      const range = document.createRange();
      for (const { h, i } of mine) {
        for (const part of h.parts) {
          const node = divs[part.item]?.firstChild;
          if (!node || node.nodeType !== Node.TEXT_NODE) continue;
          const len = node.textContent?.length ?? 0;
          range.setStart(node, Math.min(part.start, len));
          range.setEnd(node, Math.min(part.end, len));
          for (const r of range.getClientRects()) {
            out.push({ x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height, active: i === active });
          }
        }
      }
      setRects(out);
    };
    // Wait for the text layer to pick up the new zoom.
    const t = setTimeout(compute, 200);
    return () => clearTimeout(t);
  }, [hits, active, textLayer, page.id, zoom, pageRef]);

  useEffect(() => {
    if (scrollReq?.y === -1 && activeRef.current) activeRef.current.scrollIntoView({ block: 'center', inline: 'nearest' });
  }, [rects, scrollReq]);

  if (!rects.length) return null;
  let first = true;
  return (
    <div className="search-hits">
      {rects.map((r, i) => {
        const isFirstActive = r.active && first;
        if (isFirstActive) first = false;
        return (
          <div
            key={i}
            ref={isFirstActive ? activeRef : undefined}
            className={`search-hit ${r.active ? 'active' : ''}`}
            style={{ left: r.x - 1, top: r.y - 1, width: r.w + 2, height: r.h + 2 }}
          />
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function CommentPopup({ page, zoom, objects }: { page: PageItem; zoom: number; objects: Obj[] }) {
  const openNote = useStore((s) => s.openNote);
  const o = objects.find((x) => x.id === openNote);
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setText(o?.comment ?? '');
    if (o) setTimeout(() => ref.current?.focus({ preventScroll: true }), 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [o?.id]);

  if (!o) return null;
  const b = objBounds(o, measureText);
  const a = pageToDisplay(page, zoom, { x: b.x, y: b.y });
  const c = pageToDisplay(page, zoom, { x: b.x + b.w, y: b.y + b.h });
  const right = Math.max(a.x, c.x);
  const topY = Math.min(a.y, c.y);
  const { w } = displaySize(page, zoom);
  const placeLeft = right + 280 > w + 140;
  const save = () => {
    if ((o.comment ?? '') !== text) updateObjects([o.id], { comment: text });
  };
  const close = () => {
    save();
    actions.set({ openNote: null });
  };
  return (
    <div
      className="note-popup"
      style={{ left: placeLeft ? Math.min(a.x, c.x) - 268 : right + 10, top: Math.max(0, topY) }}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <div className="note-popup-head">
        <span className="note-dot" style={{ background: 'color' in o ? o.color : 'var(--accent)' }} />
        <div className="note-meta">
          <strong>{o.author || 'Me'}</strong>
          <span>
            {OBJ_LABEL[o.type]} · {new Date(o.created).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
          </span>
        </div>
        <button
          type="button"
          className="icon-btn sm"
          aria-label="Delete"
          data-tip="Delete"
          onClick={() => {
            actions.set({ openNote: null });
            deleteObjects([o.id]);
          }}
        >
          <Trash2 size={15} />
        </button>
        <button type="button" className="icon-btn sm" aria-label="Close" data-tip="Close" onClick={close}>
          <X size={15} />
        </button>
      </div>
      <textarea
        ref={ref}
        value={text}
        placeholder="Add a comment…"
        onChange={(e) => setText(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) close();
        }}
      />
    </div>
  );
}
