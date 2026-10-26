import type { Matrix, Obj, PageItem, Point, Rect, Rotation, TextObj } from '../types';

export function applyMatrix(m: Matrix, x: number, y: number): Point {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

export function invertMatrix(m: Matrix): Matrix {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

/** Page size as displayed, after the user's rotation. */
export function displaySize(p: PageItem, zoom: number) {
  const swap = p.rotation === 90 || p.rotation === 270;
  return { w: (swap ? p.h : p.w) * zoom, h: (swap ? p.w : p.h) * zoom };
}

/**
 * Maps a point from page space to the page element's (unrotated) box in CSS
 * pixels. Inverse of `displayToPage`.
 */
export function pageToDisplay(p: PageItem, zoom: number, pt: Point): Point {
  const { w, h } = displaySize(p, zoom);
  const vx = (pt.x - p.w / 2) * zoom;
  const vy = (pt.y - p.h / 2) * zoom;
  const r = rotate(vx, vy, p.rotation);
  return { x: r.x + w / 2, y: r.y + h / 2 };
}

export function displayToPage(p: PageItem, zoom: number, pt: Point): Point {
  const { w, h } = displaySize(p, zoom);
  const r = rotate(pt.x - w / 2, pt.y - h / 2, ((360 - p.rotation) % 360) as Rotation);
  return { x: r.x / zoom + p.w / 2, y: r.y / zoom + p.h / 2 };
}

/** Clockwise rotation in a y-down coordinate system. */
function rotate(x: number, y: number, deg: Rotation): Point {
  switch (deg) {
    case 90:
      return { x: -y, y: x };
    case 180:
      return { x: -x, y: -y };
    case 270:
      return { x: y, y: -x };
    default:
      return { x, y };
  }
}

/** Converts a viewport client point into page space for the page element. */
export function clientToPage(el: Element, p: PageItem, zoom: number, cx: number, cy: number): Point {
  const r = el.getBoundingClientRect();
  return displayToPage(p, zoom, { x: cx - r.left, y: cy - r.top });
}

export function rectFromPoints(a: Point, b: Point): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

export function unionRects(rects: Rect[]): Rect {
  let x1 = Infinity,
    y1 = Infinity,
    x2 = -Infinity,
    y2 = -Infinity;
  for (const r of rects) {
    x1 = Math.min(x1, r.x);
    y1 = Math.min(y1, r.y);
    x2 = Math.max(x2, r.x + r.w);
    y2 = Math.max(y2, r.y + r.h);
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

export function rectsIntersect(a: Rect, b: Rect) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

export function pointInRect(p: Point, r: Rect, pad = 0) {
  return p.x >= r.x - pad && p.x <= r.x + r.w + pad && p.y >= r.y - pad && p.y <= r.y + r.h + pad;
}

export function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

/** Bounding box of an object in page space. Text needs measured size. */
export function objBounds(o: Obj, textSize?: (o: TextObj) => { w: number; h: number }): Rect {
  switch (o.type) {
    case 'image':
      return o.crop ? cropRect(o, o.crop) : { x: o.x, y: o.y, w: o.w, h: o.h };
    case 'rect':
    case 'ellipse':
    case 'whiteout':
    case 'redact':
    case 'field':
      return { x: o.x, y: o.y, w: o.w, h: o.h };
    case 'line':
    case 'arrow': {
      const pad = Math.max(o.width, 4) / 2;
      const r = rectFromPoints({ x: o.x1, y: o.y1 }, { x: o.x2, y: o.y2 });
      return { x: r.x - pad, y: r.y - pad, w: r.w + pad * 2, h: r.h + pad * 2 };
    }
    case 'ink': {
      let x1 = Infinity,
        y1 = Infinity,
        x2 = -Infinity,
        y2 = -Infinity;
      for (const s of o.strokes)
        for (let i = 0; i < s.length; i += 2) {
          x1 = Math.min(x1, s[i]);
          x2 = Math.max(x2, s[i]);
          y1 = Math.min(y1, s[i + 1]);
          y2 = Math.max(y2, s[i + 1]);
        }
      const pad = o.width / 2;
      return { x: x1 - pad, y: y1 - pad, w: x2 - x1 + pad * 2, h: y2 - y1 + pad * 2 };
    }
    case 'text': {
      const s = textSize ? textSize(o) : { w: 40, h: o.size * 1.2 };
      return { x: o.x, y: o.y, w: s.w, h: s.h };
    }
    case 'highlight':
    case 'underline':
    case 'strike':
      return unionRects(o.rects);
    case 'note':
      return { x: o.x, y: o.y, w: NOTE_SIZE, h: NOTE_SIZE };
  }
}

export const NOTE_SIZE = 22;

/** The visible part of a box given crop fractions. */
export function cropRect(box: Rect, c: { l: number; t: number; r: number; b: number }): Rect {
  return { x: box.x + c.l * box.w, y: box.y + c.t * box.h, w: (c.r - c.l) * box.w, h: (c.b - c.t) * box.h };
}

/** Translate an object by (dx, dy). Returns a patch. */
export function moveObj(o: Obj, dx: number, dy: number): Partial<Obj> {
  switch (o.type) {
    case 'line':
    case 'arrow':
      return { x1: o.x1 + dx, y1: o.y1 + dy, x2: o.x2 + dx, y2: o.y2 + dy } as Partial<Obj>;
    case 'ink':
      return { strokes: o.strokes.map((s) => s.map((v, i) => v + (i % 2 ? dy : dx))) } as Partial<Obj>;
    case 'highlight':
    case 'underline':
    case 'strike':
      return { rects: o.rects.map((r) => ({ ...r, x: r.x + dx, y: r.y + dy })) } as Partial<Obj>;
    default:
      return { x: o.x + dx, y: o.y + dy } as Partial<Obj>;
  }
}

/** Fit `from` box onto `to` box, scaling the object's geometry. */
export function resizeObj(o: Obj, from: Rect, to: Rect): Partial<Obj> {
  const sx = from.w ? to.w / from.w : 1;
  const sy = from.h ? to.h / from.h : 1;
  const mx = (x: number) => to.x + (x - from.x) * sx;
  const my = (y: number) => to.y + (y - from.y) * sy;
  switch (o.type) {
    case 'ink':
      return { strokes: o.strokes.map((s) => s.map((v, i) => (i % 2 ? my(v) : mx(v)))) } as Partial<Obj>;
    case 'text': {
      const s = Math.min(sx, sy);
      const size = Math.max(4, Math.round(o.size * s * 10) / 10);
      const k = size / o.size;
      return { x: to.x, y: to.y, size, ...(o.width ? { width: o.width * k } : {}) } as Partial<Obj>;
    }
    case 'image':
      // `from` may be the visible (cropped) part; scale the whole box with it.
      return { x: to.x + (o.x - from.x) * sx, y: to.y + (o.y - from.y) * sy, w: Math.max(2, o.w * sx), h: Math.max(2, o.h * sy) } as Partial<Obj>;
    case 'rect':
    case 'ellipse':
    case 'whiteout':
    case 'redact':
    case 'field':
      return { x: to.x, y: to.y, w: Math.max(2, to.w), h: Math.max(2, to.h) } as Partial<Obj>;
    default:
      return {};
  }
}

export function arrowHead(x1: number, y1: number, x2: number, y2: number, width: number) {
  const len = Math.hypot(x2 - x1, y2 - y1) || 1;
  const size = Math.min(Math.max(8, width * 4), len * 0.6);
  const ux = (x2 - x1) / len;
  const uy = (y2 - y1) / len;
  const bx = x2 - ux * size;
  const by = y2 - uy * size;
  const half = size * 0.5;
  return {
    base: { x: x2 - ux * size * 0.8, y: y2 - uy * size * 0.8 },
    l: { x: bx - uy * half, y: by + ux * half },
    r: { x: bx + uy * half, y: by - ux * half },
  };
}

/** The painted area of a markup, per selection rectangle, in page space. */
export function markupQuads(o: { type: 'highlight' | 'underline' | 'strike'; rects: Rect[] }): Rect[] {
  return o.rects.map((r) => {
    if (o.type === 'highlight') return r;
    const t = Math.max(0.6, r.h * 0.07);
    return o.type === 'underline' ? { x: r.x, y: r.y + r.h - t * 1.2, w: r.w, h: t } : { x: r.x, y: r.y + r.h * 0.52 - t / 2, w: r.w, h: t };
  });
}

/** Page space -> rotated display space, in points (multiply e/f by zoom for CSS). */
export function rotationMatrix(p: PageItem): Matrix {
  switch (p.rotation) {
    case 90:
      return [0, 1, -1, 0, p.h, 0];
    case 180:
      return [-1, 0, 0, -1, p.w, p.h];
    case 270:
      return [0, -1, 1, 0, 0, p.w];
    default:
      return [1, 0, 0, 1, 0, 0];
  }
}

/** Merge selection rectangles that sit on the same line. */
export function mergeLineRects(rects: Rect[]): Rect[] {
  const sameLine = (a: Rect, b: Rect) => Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 0.5 * Math.min(a.h, b.h);
  // Group into lines first: words on one line needn't share the exact same y
  // (recognized text on a slightly skewed scan, for one), then join left to right.
  const lines: Rect[][] = [];
  for (const r of [...rects].sort((a, b) => a.y + a.h / 2 - (b.y + b.h / 2))) {
    const line = lines.find((l) => sameLine(l[l.length - 1], r));
    if (line) line.push(r);
    else lines.push([r]);
  }
  const out: Rect[] = [];
  for (const line of lines) {
    let last: Rect | null = null;
    for (const r of line.sort((a, b) => a.x - b.x)) {
      if (last && r.x - (last.x + last.w) < Math.max(last.h, r.h) * 0.8) {
        out[out.length - 1] = last = unionRects([last, r]);
        continue;
      }
      out.push((last = { ...r }));
    }
  }
  return out;
}
