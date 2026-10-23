import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { ArrowLeftRight, ChevronDown, ChevronUp, Columns2, Layers, Loader2, Minus, Plus, X } from 'lucide-react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { Rect } from '../types';
import { closeCompare, stepChange, swapSides, useCompare, type Change, type ComparePage, type Side } from '../lib/compare';
import { IconButton, Segmented, Toggle } from './ui';

const GAP = 16;
const PAD = 20;
const KIND_LABEL: Record<Change['kind'], string> = {
  changed: 'Changed',
  added: 'Added',
  removed: 'Removed',
  visual: 'Visual',
  pageAdded: 'Page added',
  pageRemoved: 'Page removed',
};

export function CompareView() {
  const left = useCompare((s) => s.left);
  const right = useCompare((s) => s.right);
  const pairs = useCompare((s) => s.pairs);
  const changes = useCompare((s) => s.changes);
  const active = useCompare((s) => s.active);
  const mode = useCompare((s) => s.mode);
  const showText = useCompare((s) => s.showText);
  const showVisual = useCompare((s) => s.showVisual);
  const status = useCompare((s) => s.status);
  const zoom = useCompare((s) => s.zoom);
  const scroller = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const el = scroller.current!;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  /* Keys while comparing: Esc closes, arrows / N / P step through the changes. */
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el?.closest?.('input, textarea, select') || e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key;
      if (k === 'Escape') closeCompare();
      else if (k === 'ArrowDown' || k === 'n' || k === 'j') stepChange(1);
      else if (k === 'ArrowUp' || k === 'p' || k === 'k') stepChange(-1);
      else return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener('keydown', down, true);
    return () => window.removeEventListener('keydown', down, true);
  }, []);

  const maxW = (pages: ComparePage[]) => pages.reduce((m, p) => Math.max(m, p.w), 1);
  const lw = left ? maxW(left.pages) : 1;
  const rw = right ? maxW(right.pages) : 1;
  const avail = Math.max(200, width - PAD * 2);
  const fit = mode === 'side' ? (avail - GAP) / (lw + rw) : avail / Math.max(lw, rw);
  const scale = Math.max(0.1, fit * zoom);

  const rows = useMemo(() => {
    let y = PAD;
    return pairs.map((p) => {
      const ha = p.a !== null && left ? left.pages[p.a].h : 0;
      const hb = p.b !== null && right ? right.pages[p.b].h : 0;
      const h = Math.max(ha, hb) * scale;
      const top = y;
      y += h + GAP;
      return { top, h };
    });
  }, [pairs, left, right, scale]);
  const total = rows.length ? rows[rows.length - 1].top + rows[rows.length - 1].h + PAD : 0;

  /* Bring the active change into view, on the page that shows it. */
  useEffect(() => {
    const c = changes[active];
    const el = scroller.current;
    if (!c || !el) return;
    const row = rows[c.pair];
    const r = [...c.b, ...c.a][0];
    if (!row || !r) return;
    const target = row.top + r.y * scale - el.clientHeight / 3;
    el.scrollTo({ top: Math.max(0, target) });
    document.querySelector(`[data-change="${c.id}"]`)?.scrollIntoView({ block: 'nearest' });
    // Scroll only when the active change itself changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, changes[active]?.id]);

  if (!left || !right) return null;
  const counts = changes.reduce<Record<string, number>>((m, c) => ((m[c.kind] = (m[c.kind] ?? 0) + 1), m), {});
  const set = useCompare.setState;
  const colW = mode === 'side' ? [lw * scale, rw * scale] : [Math.max(lw, rw) * scale];
  const innerW = mode === 'side' ? colW[0] + GAP + colW[1] : colW[0];
  const contentW = Math.max(width, innerW + PAD * 2);
  const x0 = (contentW - innerW) / 2;

  return (
    <div className="compare">
      <div className="compare-bar">
        <div className="compare-names">
          <span className="cmp-name old" title={left.name}>
            {left.name}
          </span>
          <IconButton tip="Swap documents" onClick={swapSides}>
            <ArrowLeftRight size={16} />
          </IconButton>
          <span className="cmp-name new" title={right.name}>
            {right.name}
          </span>
        </div>
        <span className="toolbar-sep" />
        <Segmented
          value={mode}
          onChange={(m) => set({ mode: m })}
          options={[
            { value: 'side', label: <Columns2 size={15} />, tip: 'Side by side' },
            { value: 'overlay', label: <Layers size={15} />, tip: 'Overlay: old in red, new in blue' },
          ]}
        />
        <Toggle checked={showText} onChange={(v) => set({ showText: v })} label="Text changes" />
        <Toggle checked={showVisual} onChange={(v) => set({ showVisual: v })} label="Visual differences" />
        <span className="spacer" />
        {status && (
          <span className="muted small cmp-status">
            <Loader2 size={13} className="spin" /> {status}
          </span>
        )}
        <IconButton tip="Zoom out" onClick={() => set({ zoom: Math.max(0.4, zoom / 1.25) })}>
          <Minus size={16} />
        </IconButton>
        <button type="button" className="zoom-value" onClick={() => set({ zoom: 1 })} data-tip="Fit width">
          {Math.round(zoom * 100)}%
        </button>
        <IconButton tip="Zoom in" onClick={() => set({ zoom: Math.min(4, zoom * 1.25) })}>
          <Plus size={16} />
        </IconButton>
        <span className="toolbar-sep" />
        <IconButton tip="Close comparison" shortcut="Esc" onClick={closeCompare}>
          <X size={17} />
        </IconButton>
      </div>
      <div className="compare-body">
        <aside className="compare-list">
          <div className="compare-list-head">
            <strong>
              {changes.length} change{changes.length === 1 ? '' : 's'}
            </strong>
            <div className="cmp-nav">
              <IconButton tip="Previous change" shortcut="↑" disabled={!changes.length} onClick={() => stepChange(-1)}>
                <ChevronUp size={16} />
              </IconButton>
              <span className="muted small">{changes.length ? `${active + 1} of ${changes.length}` : ''}</span>
              <IconButton tip="Next change" shortcut="↓" disabled={!changes.length} onClick={() => stepChange(1)}>
                <ChevronDown size={16} />
              </IconButton>
            </div>
          </div>
          <div className="cmp-counts">
            {(Object.keys(KIND_LABEL) as Change['kind'][])
              .filter((k) => counts[k])
              .map((k) => (
                <span key={k} className={`cmp-badge k-${k}`}>
                  {counts[k]} {KIND_LABEL[k].toLowerCase()}
                </span>
              ))}
          </div>
          {!changes.length && <p className="muted small cmp-empty">{status ? 'Looking for differences…' : 'No differences found.'}</p>}
          <ol className="cmp-items">
            {changes.map((c, i) => (
              <li key={c.id}>
                <button type="button" data-change={c.id} className={`cmp-item ${i === active ? 'active' : ''}`} onClick={() => set({ active: i })}>
                  <span className="cmp-item-head">
                    <span className={`cmp-badge k-${c.kind}`}>{KIND_LABEL[c.kind]}</span>
                    <span className="muted small">{pageLabel(c, useCompare.getState().pairs)}</span>
                  </span>
                  {c.kind === 'visual' ? (
                    <span className="small muted">Images, graphics or layout differ here</span>
                  ) : (
                    <span className="cmp-text">
                      {c.oldText && <del>{c.oldText}</del>}
                      {c.oldText && c.newText && ' '}
                      {c.newText && <ins>{c.newText}</ins>}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ol>
        </aside>
        <div className="compare-scroll" ref={scroller}>
          <div className="compare-content" style={{ width: contentW, height: total }}>
            {pairs.map((p, pi) => (
              <div key={pi} className="cmp-row" style={{ top: rows[pi].top, left: x0, width: innerW, height: rows[pi].h }}>
                {mode === 'side' ? (
                  <>
                    <PageCell side={left} index={p.a} scale={scale} width={colW[0]} changes={changes} pair={pi} which="a" active={active} root={scroller} />
                    <PageCell side={right} index={p.b} scale={scale} width={colW[1]} changes={changes} pair={pi} which="b" active={active} root={scroller} />
                  </>
                ) : (
                  <OverlayCell left={left} right={right} a={p.a} b={p.b} scale={scale} changes={changes} pair={pi} active={active} root={scroller} />
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function pageLabel(c: Change, pairs: { a: number | null; b: number | null }[]) {
  const p = pairs[c.pair];
  if (!p) return '';
  if (p.a === null) return `New page ${p.b! + 1}`;
  if (p.b === null) return `Old page ${p.a + 1}`;
  return p.a === p.b ? `Page ${p.a + 1}` : `Page ${p.a + 1} → ${p.b + 1}`;
}

/* ------------------------------------------------------------------ */

/** True once the element is near the visible part of the scroller. */
function useNear(ref: RefObject<HTMLElement | null>, root: RefObject<HTMLElement | null>) {
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setNear(e.isIntersecting), { root: root.current, rootMargin: '1200px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [ref, root]);
  return near;
}

async function renderTo(pdf: PDFDocumentProxy, index: number, scale: number, canvas: HTMLCanvasElement, cancelled: () => boolean) {
  const page = await pdf.getPage(index + 1);
  const vp = page.getViewport({ scale });
  const off = document.createElement('canvas');
  off.width = Math.max(1, Math.floor(vp.width));
  off.height = Math.max(1, Math.floor(vp.height));
  const g = off.getContext('2d')!;
  g.fillStyle = '#fff';
  g.fillRect(0, 0, off.width, off.height);
  // 'print' keeps rendering going when the window is in the background.
  await page.render({ canvas: off, viewport: vp, intent: 'print' }).promise;
  if (cancelled()) return null;
  canvas.width = off.width;
  canvas.height = off.height;
  canvas.getContext('2d')!.drawImage(off, 0, 0);
  return off;
}

const PageCell = memo(function PageCell({
  side,
  index,
  scale,
  width,
  changes,
  pair,
  which,
  active,
  root,
}: {
  side: Side;
  index: number | null;
  scale: number;
  width: number;
  changes: Change[];
  pair: number;
  which: 'a' | 'b';
  active: number;
  root: RefObject<HTMLDivElement | null>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const near = useNear(ref, root);
  const showText = useCompare((s) => s.showText);
  const showVisual = useCompare((s) => s.showVisual);
  const visual = useCompare((s) => s.visual.get(pair));
  const page = index !== null ? side.pages[index] : null;
  const dpr = window.devicePixelRatio || 1;

  useEffect(() => {
    if (!near || index === null || !canvas.current) return;
    let stop = false;
    const t = setTimeout(() => {
      renderTo(side.pdf, index, scale * dpr, canvas.current!, () => stop)
        .then((off) => off && (off.width = off.height = 0))
        .catch(() => {});
    }, 60);
    return () => {
      stop = true;
      clearTimeout(t);
    };
  }, [near, side, index, scale, dpr]);

  if (!page) {
    return (
      <div ref={ref} className="cmp-cell cmp-missing" style={{ width }}>
        <span>{which === 'a' ? 'Page added in the new version' : 'Page removed in the new version'}</span>
      </div>
    );
  }
  const mine = changes.map((c, i) => ({ c, i })).filter(({ c }) => c.pair === pair);
  return (
    <div ref={ref} className="cmp-cell" style={{ width: page.w * scale, height: page.h * scale }}>
      <canvas ref={canvas} className="cmp-canvas" style={{ width: page.w * scale, height: page.h * scale }} />
      {showVisual && visual?.[which] && <img className="cmp-mask" src={visual[which]} alt="" style={{ width: visual.w * scale, height: visual.h * scale }} />}
      <Highlights items={mine} which={which} scale={scale} active={active} showText={showText} />
    </div>
  );
});

function Highlights({ items, which, scale, active, showText }: { items: { c: Change; i: number }[]; which: 'a' | 'b'; scale: number; active: number; showText: boolean }) {
  const set = useCompare.setState;
  return (
    <>
      {items.flatMap(({ c, i }) => {
        if (c.kind === 'pageAdded' || c.kind === 'pageRemoved') return [];
        if (c.kind !== 'visual' && !showText) return [];
        const rects: Rect[] = which === 'a' ? c.a : c.b;
        const cls = c.kind === 'visual' ? 'vis' : which === 'a' ? 'del' : 'ins';
        return rects.map((r, k) => (
          <div
            key={`${c.id}-${k}`}
            className={`cmp-hl ${cls} ${i === active ? 'active' : ''}`}
            style={{ left: r.x * scale - 1, top: r.y * scale - 1, width: r.w * scale + 2, height: r.h * scale + 2 }}
            onClick={() => set({ active: i })}
          />
        ));
      })}
    </>
  );
}

/** Both versions in one picture: what only the old one has is red, what only the new one has is blue. */
const OverlayCell = memo(function OverlayCell({
  left,
  right,
  a,
  b,
  scale,
  changes,
  pair,
  active,
  root,
}: {
  left: Side;
  right: Side;
  a: number | null;
  b: number | null;
  scale: number;
  changes: Change[];
  pair: number;
  active: number;
  root: RefObject<HTMLDivElement | null>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const near = useNear(ref, root);
  const showText = useCompare((s) => s.showText);
  const dpr = window.devicePixelRatio || 1;
  const pa = a !== null ? left.pages[a] : null;
  const pb = b !== null ? right.pages[b] : null;
  const w = Math.max(pa?.w ?? 0, pb?.w ?? 0);
  const h = Math.max(pa?.h ?? 0, pb?.h ?? 0);

  useEffect(() => {
    if (!near || !canvas.current) return;
    let stop = false;
    const t = setTimeout(async () => {
      const s = scale * dpr;
      const W = Math.max(1, Math.floor(w * s));
      const H = Math.max(1, Math.floor(h * s));
      const lum = async (side: Side, i: number | null) => {
        const c = document.createElement('canvas');
        c.width = W;
        c.height = H;
        const g = c.getContext('2d', { willReadFrequently: true })!;
        g.fillStyle = '#fff';
        g.fillRect(0, 0, W, H);
        if (i !== null) {
          const off = await renderTo(side.pdf, i, s, document.createElement('canvas'), () => stop);
          if (off) {
            g.drawImage(off, 0, 0);
            off.width = off.height = 0;
          }
        }
        const d = g.getImageData(0, 0, W, H).data;
        c.width = c.height = 0;
        return d;
      };
      try {
        const da = await lum(left, a);
        const db = await lum(right, b);
        if (stop || !canvas.current) return;
        const out = new ImageData(W, H);
        for (let k = 0; k < out.data.length; k += 4) {
          const la = (da[k] * 3 + da[k + 1] * 6 + da[k + 2]) / 10;
          const lb = (db[k] * 3 + db[k + 1] * 6 + db[k + 2]) / 10;
          out.data[k] = lb;
          out.data[k + 1] = Math.min(la, lb);
          out.data[k + 2] = la;
          out.data[k + 3] = 255;
        }
        canvas.current.width = W;
        canvas.current.height = H;
        canvas.current.getContext('2d')!.putImageData(out, 0, 0);
      } catch {
        /* cancelled or failed render */
      }
    }, 60);
    return () => {
      stop = true;
      clearTimeout(t);
    };
  }, [near, left, right, a, b, scale, dpr, w, h]);

  const mine = changes.map((c, i) => ({ c, i })).filter(({ c }) => c.pair === pair);
  return (
    <div ref={ref} className="cmp-cell" style={{ width: w * scale, height: h * scale }}>
      <canvas ref={canvas} className="cmp-canvas" style={{ width: w * scale, height: h * scale }} />
      {(a === null || b === null) && <span className="cmp-tag">{a === null ? 'Page added' : 'Page removed'}</span>}
      <Highlights items={mine} which="a" scale={scale} active={active} showText={showText} />
      <Highlights items={mine.filter(({ c }) => c.kind !== 'visual')} which="b" scale={scale} active={active} showText={showText} />
    </div>
  );
});
