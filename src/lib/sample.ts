import type { PageItem, Rect } from '../types';
import { pageToDisplay } from './geometry';
import { rgbToHex } from './util';

/**
 * Fills a rectangle of `ctx` (in canvas pixels) with background reconstructed
 * from a thin ring just outside it: each pixel blends the left/right and
 * top/bottom edge colors, weighted toward the nearer edge. Flat backgrounds
 * stay flat and gradients continue smoothly through the hole.
 */
export function fillMatchingBackground(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(W, Math.ceil(x + w));
  const y1 = Math.min(H, Math.ceil(y + h));
  const bw = x1 - x0;
  const bh = y1 - y0;
  if (bw < 1 || bh < 1) return;
  // Sample a margin around the box; average a few pixels outward to beat anti-aliasing.
  const m = 4;
  const sx0 = Math.max(0, x0 - m);
  const sy0 = Math.max(0, y0 - m);
  const sx1 = Math.min(W, x1 + m);
  const sy1 = Math.min(H, y1 + m);
  const sw = sx1 - sx0;
  const src = ctx.getImageData(sx0, sy0, sw, sy1 - sy0).data;
  const at = (px: number, py: number, c: number) => src[((py - sy0) * sw + (px - sx0)) * 4 + c];
  const edge = (fixed: number, along: number, vertical: boolean, dir: -1 | 1) => {
    const out = [0, 0, 0];
    let n = 0;
    for (let d = 2; d <= m; d++) {
      const px = vertical ? along : fixed + dir * d;
      const py = vertical ? fixed + dir * d : along;
      if (px < sx0 || px >= sx1 || py < sy0 || py >= sy1) continue;
      for (let c = 0; c < 3; c++) out[c] += at(px, py, c);
      n++;
    }
    return n ? out.map((v) => v / n) : null;
  };
  const top = Array.from({ length: bw }, (_, i) => edge(y0, x0 + i, true, -1));
  const bottom = Array.from({ length: bw }, (_, i) => edge(y1 - 1, x0 + i, true, 1));
  const left = Array.from({ length: bh }, (_, j) => edge(x0, y0 + j, false, -1));
  const right = Array.from({ length: bh }, (_, j) => edge(x1 - 1, y0 + j, false, 1));
  const img = ctx.createImageData(bw, bh);
  const d = img.data;
  for (let j = 0; j < bh; j++) {
    for (let i = 0; i < bw; i++) {
      const u = (i + 0.5) / bw;
      const v = (j + 0.5) / bh;
      const L = left[j];
      const R = right[j];
      const T = top[i];
      const B = bottom[i];
      // Horizontal and vertical interpolations, each from whichever edges exist.
      const hor = L && R ? L.map((c, k) => c * (1 - u) + R[k] * u) : L ?? R;
      const ver = T && B ? T.map((c, k) => c * (1 - v) + B[k] * v) : T ?? B;
      const wh = hor ? 1 / (Math.min(L ? u : 1, R ? 1 - u : 1) * bw + 1) : 0;
      const wv = ver ? 1 / (Math.min(T ? v : 1, B ? 1 - v : 1) * bh + 1) : 0;
      const o = (j * bw + i) * 4;
      for (let c = 0; c < 3; c++) {
        const val = wh + wv ? ((hor?.[c] ?? 0) * wh + (ver?.[c] ?? 0) * wv) / (wh + wv) : 255;
        d[o + c] = val;
      }
      d[o + 3] = 255;
    }
  }
  ctx.putImageData(img, x0, y0);
}

/** A preview of a background-matched redaction, cut from the rendered page. */
export function matchingPatch(canvas: HTMLCanvasElement | null, page: PageItem, zoom: number, r: Rect): string | null {
  if (!canvas?.width || page.rotation) return null;
  try {
    const box = canvas.getBoundingClientRect();
    if (!box.width) return null;
    const k = canvas.width / box.width;
    const a = pageToDisplay(page, zoom, { x: r.x, y: r.y });
    const b = pageToDisplay(page, zoom, { x: r.x + r.w, y: r.y + r.h });
    const x = Math.min(a.x, b.x) * k;
    const y = Math.min(a.y, b.y) * k;
    const w = Math.abs(a.x - b.x) * k;
    const h = Math.abs(a.y - b.y) * k;
    // Work on a copy so the page canvas is untouched.
    const pad = 6;
    const tmp = document.createElement('canvas');
    tmp.width = Math.max(1, Math.ceil(w + pad * 2));
    tmp.height = Math.max(1, Math.ceil(h + pad * 2));
    const tctx = tmp.getContext('2d', { willReadFrequently: true })!;
    tctx.drawImage(canvas, x - pad, y - pad, tmp.width, tmp.height, 0, 0, tmp.width, tmp.height);
    fillMatchingBackground(tctx, pad, pad, w, h);
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(w));
    out.height = Math.max(1, Math.round(h));
    out.getContext('2d')!.drawImage(tmp, pad, pad, w, h, 0, 0, out.width, out.height);
    return out.toDataURL('image/png');
  } catch {
    return null;
  }
}

/** The average background around a page-space rectangle, read from the page on screen. */
export function backgroundColorAt(pageId: string, page: PageItem, zoom: number, r: Rect) {
  const canvas = document.querySelector<HTMLCanvasElement>(`.page[data-page-id="${pageId}"] canvas`);
  return sampleColors(canvas, page, zoom, r).bg;
}

/**
 * Reads the rendered page to find the background behind a text line and the
 * color of its glyphs, so replaced text blends in.
 */
export function sampleColors(canvas: HTMLCanvasElement | null, page: PageItem, zoom: number, r: Rect) {
  const fallback = { bg: '#ffffff', fg: '#000000' };
  if (!canvas || !canvas.width) return fallback;
  try {
    const box = canvas.getBoundingClientRect();
    const parent = canvas.parentElement!.getBoundingClientRect();
    const sx = canvas.width / box.width;
    const sy = canvas.height / box.height;
    const pts = [
      pageToDisplay(page, zoom, { x: r.x, y: r.y }),
      pageToDisplay(page, zoom, { x: r.x + r.w, y: r.y + r.h }),
    ];
    const ox = box.left - parent.left;
    const oy = box.top - parent.top;
    const x1 = Math.max(0, Math.floor((Math.min(pts[0].x, pts[1].x) - ox) * sx) - 2);
    const y1 = Math.max(0, Math.floor((Math.min(pts[0].y, pts[1].y) - oy) * sy) - 2);
    const x2 = Math.min(canvas.width, Math.ceil((Math.max(pts[0].x, pts[1].x) - ox) * sx) + 2);
    const y2 = Math.min(canvas.height, Math.ceil((Math.max(pts[0].y, pts[1].y) - oy) * sy) + 2);
    const w = x2 - x1;
    const h = y2 - y1;
    if (w < 2 || h < 2) return fallback;
    const data = canvas.getContext('2d', { willReadFrequently: true })!.getImageData(x1, y1, w, h).data;
    const at = (x: number, y: number) => {
      const i = (y * w + x) * 4;
      return [data[i], data[i + 1], data[i + 2]] as const;
    };
    // Background: most common color along the border.
    const counts = new Map<string, { n: number; c: readonly [number, number, number] }>();
    const tally = (x: number, y: number) => {
      const c = at(x, y);
      const k = c.map((v) => v >> 3).join(',');
      const e = counts.get(k);
      if (e) e.n++;
      else counts.set(k, { n: 1, c });
    };
    for (let x = 0; x < w; x++) {
      tally(x, 0);
      tally(x, h - 1);
    }
    for (let y = 0; y < h; y++) {
      tally(0, y);
      tally(w - 1, y);
    }
    const bg = [...counts.values()].sort((a, b) => b.n - a.n)[0].c;
    // Glyph color: the pixel that differs most from the background.
    let best = 0;
    let fg: readonly [number, number, number] = [0, 0, 0];
    for (let y = 1; y < h - 1; y++)
      for (let x = 1; x < w - 1; x++) {
        const c = at(x, y);
        const d = (c[0] - bg[0]) ** 2 + (c[1] - bg[1]) ** 2 + (c[2] - bg[2]) ** 2;
        if (d > best) {
          best = d;
          fg = c;
        }
      }
    return { bg: rgbToHex(...bg), fg: best > 900 ? rgbToHex(...fg) : '#000000' };
  } catch {
    return fallback;
  }
}
