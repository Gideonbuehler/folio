/**
 * Compare two versions of a document. Pages are paired up by their text (so
 * inserted or deleted pages don't throw everything after them off), then the
 * words of each pair are diffed, and the rendered pages are compared pixel by
 * pixel for changes the text doesn't show (images, graphics, layout).
 */
import { create } from 'zustand';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import type { Rect } from '../types';
import { mergeLineRects, rectsIntersect } from './geometry';
import { actions, toast, useStore } from '../store';
import { loadSource, PasswordCancelled } from './pdfjs';
import { pickFiles } from './files';
import { untouchedDoc } from './commands';
import { readFileBytes } from './util';

const { get } = actions;

export interface Word extends Rect {
  text: string;
}

export interface ComparePage {
  /** Size in points as displayed (page rotation applied). */
  w: number;
  h: number;
  words: Word[];
}

export interface Side {
  name: string;
  pdf: PDFDocumentProxy;
  pages: ComparePage[];
  /** Built from unsaved changes, or opened just for comparing: destroyed on close. */
  owned: boolean;
}

export interface Pair {
  a: number | null;
  b: number | null;
}

export type ChangeKind = 'changed' | 'added' | 'removed' | 'visual' | 'pageAdded' | 'pageRemoved';

export interface Change {
  id: number;
  pair: number;
  kind: ChangeKind;
  oldText: string;
  newText: string;
  /** Areas on the old (left) and new (right) page, in points. */
  a: Rect[];
  b: Rect[];
}

export interface VisualDiff {
  /** Differing pixels in the highlight color (transparent elsewhere) for the old and new page. */
  a: string;
  b: string;
  /** Its size in points (pages are compared from their top-left corners). */
  w: number;
  h: number;
}

interface CompareState {
  open: boolean;
  status: string | null;
  left: Side | null;
  right: Side | null;
  pairs: Pair[];
  changes: Change[];
  active: number;
  mode: 'side' | 'overlay';
  showText: boolean;
  showVisual: boolean;
  /** Pixel differences by pair index, filled in in the background. */
  visual: Map<number, VisualDiff>;
  visualDone: boolean;
  zoom: number;
}

const INITIAL: CompareState = {
  open: false,
  status: null,
  left: null,
  right: null,
  pairs: [],
  changes: [],
  active: -1,
  mode: 'side',
  showText: true,
  showVisual: true,
  visual: new Map(),
  visualDone: false,
  zoom: 1,
};

export const useCompare = create<CompareState>()(() => INITIAL);
const cget = useCompare.getState;
const cset = useCompare.setState;

/* ------------------------------------------------------------------ */
/* Words with their boxes                                               */
/* ------------------------------------------------------------------ */

const SEP = null;

/** Words of a page in reading order, each with its box in points (top-left origin). */
export async function pageWords(page: PDFPageProxy): Promise<ComparePage> {
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  const m = vp.transform;
  const toView = (x: number, y: number) => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] });
  const chars: ({ ch: string; box: Rect } | null)[] = [];
  let prev: { x: number; y: number; ux: number; uy: number; size: number } | null = null;
  for (const it of tc.items as TextItem[]) {
    if (!('str' in it)) continue;
    const str = it.str;
    if (!str) {
      if (it.hasEOL) {
        chars.push(SEP);
        prev = null;
      }
      continue;
    }
    const [a, b, c, d, e, f] = it.transform as number[];
    const dl = Math.hypot(a, b) || 1;
    const size = Math.hypot(c, d) || dl;
    const ux = a / dl;
    const uy = b / dl;
    const vx = -uy;
    const vy = ux;
    const width = it.width || dl * str.length * 0.5;
    if (prev) {
      // A jump to another line, a visible gap or a step backwards starts a new word.
      const dx = e - prev.x;
      const dy = f - prev.y;
      const along = dx * prev.ux + dy * prev.uy;
      const across = dx * -prev.uy + dy * prev.ux;
      if (Math.abs(across) > prev.size * 0.5 || along > prev.size * 0.22 || along < -prev.size * 0.5) chars.push(SEP);
    }
    const n = [...str].length;
    let k = 0;
    for (const ch of str) {
      const s0 = (width * k) / n;
      const s1 = (width * (k + 1)) / n;
      k++;
      const pts = [
        [s0, -0.22],
        [s1, -0.22],
        [s1, 0.85],
        [s0, 0.85],
      ].map(([s, up]) => toView(e + ux * s + vx * up * size, f + uy * s + vy * up * size));
      const xs = pts.map((p) => p.x);
      const ys = pts.map((p) => p.y);
      chars.push({ ch, box: { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) } });
    }
    prev = { x: e + ux * width, y: f + uy * width, ux, uy, size };
    if (it.hasEOL) {
      chars.push(SEP);
      prev = null;
    }
  }
  const words: Word[] = [];
  let text = '';
  let x1 = Infinity,
    y1 = Infinity,
    x2 = -Infinity,
    y2 = -Infinity;
  const flush = () => {
    const t = text.normalize('NFKC').replace(/­/g, '');
    if (t) words.push({ text: t, x: x1, y: y1, w: x2 - x1, h: y2 - y1 });
    text = '';
    x1 = y1 = Infinity;
    x2 = y2 = -Infinity;
  };
  for (const c of chars) {
    if (!c || /\s/.test(c.ch)) {
      flush();
      continue;
    }
    text += c.ch;
    x1 = Math.min(x1, c.box.x);
    y1 = Math.min(y1, c.box.y);
    x2 = Math.max(x2, c.box.x + c.box.w);
    y2 = Math.max(y2, c.box.y + c.box.h);
  }
  flush();
  return { w: vp.width, h: vp.height, words };
}

/* ------------------------------------------------------------------ */
/* Pairing pages                                                        */
/* ------------------------------------------------------------------ */

function counts(p: ComparePage) {
  const m = new Map<string, number>();
  for (const w of p.words) m.set(w.text, (m.get(w.text) ?? 0) + 1);
  return m;
}

/** Share of words two pages have in common (Dice coefficient). */
function similarity(a: Map<string, number>, an: number, b: Map<string, number>, bn: number) {
  if (!an && !bn) return 0.5;
  if (!an || !bn) return 0;
  let common = 0;
  const [small, big] = a.size < b.size ? [a, b] : [b, a];
  for (const [w, n] of small) common += Math.min(n, big.get(w) ?? 0);
  return (2 * common) / (an + bn);
}

/**
 * Lines the pages up in order, maximizing how similar paired pages are; pages
 * left over were added or removed.
 */
export function alignPages(a: ComparePage[], b: ComparePage[]): Pair[] {
  const n = a.length;
  const m = b.length;
  if (n * m > 400_000) {
    // Very long documents: pair by position.
    return Array.from({ length: Math.max(n, m) }, (_, i) => ({ a: i < n ? i : null, b: i < m ? i : null }));
  }
  const ca = a.map(counts);
  const cb = b.map(counts);
  const sim = (i: number, j: number) => similarity(ca[i], a[i].words.length, cb[j], b[j].words.length);
  // score[i][j]: best total for a[0..i) and b[0..j). Matching earns similarity plus a
  // small bonus, so similar documents pair page for page.
  const W = m + 1;
  const score = new Float64Array((n + 1) * W);
  const move = new Uint8Array((n + 1) * W); // 1 match, 2 skip a, 3 skip b
  for (let i = 1; i <= n; i++) move[i * W] = 2;
  for (let j = 1; j <= m; j++) move[j] = 3;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const s = sim(i - 1, j - 1);
      const match = s >= 0.12 || (a[i - 1].words.length < 3 && b[j - 1].words.length < 3) ? score[(i - 1) * W + j - 1] + s + 0.05 : -Infinity;
      const up = score[(i - 1) * W + j];
      const left = score[i * W + j - 1];
      let best = match;
      let mv = 1;
      if (up > best) {
        best = up;
        mv = 2;
      }
      if (left > best) {
        best = left;
        mv = 3;
      }
      score[i * W + j] = best;
      move[i * W + j] = mv;
    }
  }
  const out: Pair[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const mv = move[i * W + j];
    if (mv === 1) {
      out.push({ a: i - 1, b: j - 1 });
      i--;
      j--;
    } else if (mv === 2) {
      out.push({ a: i - 1, b: null });
      i--;
    } else {
      out.push({ a: null, b: j - 1 });
      j--;
    }
  }
  return out.reverse();
}

/* ------------------------------------------------------------------ */
/* Word diff (Myers)                                                    */
/* ------------------------------------------------------------------ */

export type DiffOp = { op: 'eq' | 'del' | 'ins'; a: number; b: number };

/** Shortest edit script between two word lists; null if they differ too much to be worth it. */
export function diffWords(a: string[], b: string[], maxD = 2500): DiffOp[] | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  // Snapshot of diagonals -d..d before step d (index k + d), for walking back.
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= Math.min(max, maxD); d++) {
    trace.push(v.slice(off - d, off + d + 1));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x; // in place: step d only reads diagonals of the other parity
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    if (found >= 0) break;
  }
  if (found < 0) return null;
  // Walk back through the snapshots.
  const ops: DiffOp[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const pv = trace[d];
    const at = (k: number) => pv[k + d];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const px = at(prevK);
    const py = px - prevK;
    while (x > px && y > py) {
      x--;
      y--;
      ops.push({ op: 'eq', a: x, b: y });
    }
    if (x === px) ops.push({ op: 'ins', a: x, b: --y });
    else ops.push({ op: 'del', a: --x, b: y });
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    ops.push({ op: 'eq', a: x, b: y });
  }
  return ops.reverse();
}

function boxes(words: Word[], idx: number[]) {
  return mergeLineRects(idx.map((i) => words[i]));
}

const snippet = (words: Word[], idx: number[]) => {
  const t = idx.map((i) => words[i].text).join(' ');
  return t.length > 160 ? `${t.slice(0, 157)}…` : t;
};

/** Text changes for all pairs, in page order. */
export function textChanges(left: Side, right: Side, pairs: Pair[]): Change[] {
  const out: Change[] = [];
  let id = 0;
  pairs.forEach((p, pi) => {
    if (p.a === null || p.b === null) {
      const page = p.a !== null ? left.pages[p.a] : right.pages[p.b!];
      const full = [{ x: 0, y: 0, w: page.w, h: page.h }];
      const text = snippet(page.words, page.words.map((_, i) => i).slice(0, 30));
      out.push(
        p.a !== null
          ? { id: id++, pair: pi, kind: 'pageRemoved', oldText: text, newText: '', a: full, b: [] }
          : { id: id++, pair: pi, kind: 'pageAdded', oldText: '', newText: text, a: [], b: full },
      );
      return;
    }
    const A = left.pages[p.a].words;
    const B = right.pages[p.b].words;
    const ops = diffWords(
      A.map((w) => w.text),
      B.map((w) => w.text),
    );
    if (!ops) {
      out.push({ id: id++, pair: pi, kind: 'changed', oldText: snippet(A, A.map((_, i) => i).slice(0, 30)), newText: snippet(B, B.map((_, i) => i).slice(0, 30)), a: boxes(A, A.map((_, i) => i)), b: boxes(B, B.map((_, i) => i)) });
      return;
    }
    let del: number[] = [];
    let ins: number[] = [];
    const flush = () => {
      if (!del.length && !ins.length) return;
      const kind: ChangeKind = del.length && ins.length ? 'changed' : del.length ? 'removed' : 'added';
      out.push({ id: id++, pair: pi, kind, oldText: snippet(A, del), newText: snippet(B, ins), a: boxes(A, del), b: boxes(B, ins) });
      del = [];
      ins = [];
    };
    for (const op of ops) {
      if (op.op === 'eq') flush();
      else if (op.op === 'del') del.push(op.a);
      else ins.push(op.b);
    }
    flush();
  });
  return out;
}

/* ------------------------------------------------------------------ */
/* Pixel differences                                                    */
/* ------------------------------------------------------------------ */

const DETECT_SCALE = 1.5;
const CELL = 10;

async function renderPage(pdf: PDFDocumentProxy, index: number, scale: number) {
  const page = await pdf.getPage(index + 1);
  const vp = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(vp.width));
  canvas.height = Math.max(1, Math.round(vp.height));
  const g = canvas.getContext('2d', { willReadFrequently: true })!;
  g.fillStyle = '#fff';
  g.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, viewport: vp, intent: 'print' }).promise;
  return canvas;
}

/** Differing pixels of a page pair, and the areas they form (in points). */
async function pixelDiff(left: Side, right: Side, p: Pair): Promise<{ diff: VisualDiff; areas: Rect[] } | null> {
  const ca = await renderPage(left.pdf, p.a!, DETECT_SCALE);
  const cb = await renderPage(right.pdf, p.b!, DETECT_SCALE);
  const w = Math.max(ca.width, cb.width);
  const h = Math.max(ca.height, cb.height);
  const read = (c: HTMLCanvasElement) => {
    // Pages of different sizes are compared from the top-left corner.
    if (c.width === w && c.height === h) return c.getContext('2d')!.getImageData(0, 0, w, h).data;
    const full = document.createElement('canvas');
    full.width = w;
    full.height = h;
    const g = full.getContext('2d', { willReadFrequently: true })!;
    g.fillStyle = '#fff';
    g.fillRect(0, 0, w, h);
    g.drawImage(c, 0, 0);
    return g.getImageData(0, 0, w, h).data;
  };
  const da = read(ca);
  const db = read(cb);
  ca.width = ca.height = cb.width = cb.height = 0;
  // Each side marks what only it has: darker there than on the other side. Plain
  // color changes (similar brightness) are marked on both.
  const oldMask = new ImageData(w, h);
  const newMask = new ImageData(w, h);
  const gw = Math.ceil(w / CELL);
  const gh = Math.ceil(h / CELL);
  const grid = new Uint16Array(gw * gh);
  let any = 0;
  const paint = (d: Uint8ClampedArray, k: number) => {
    d[k] = 236;
    d[k + 1] = 64;
    d[k + 2] = 196;
    d[k + 3] = 210;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = (y * w + x) * 4;
      const diff = Math.max(Math.abs(da[k] - db[k]), Math.abs(da[k + 1] - db[k + 1]), Math.abs(da[k + 2] - db[k + 2]));
      if (diff < 40) continue;
      any++;
      const la = da[k] * 0.3 + da[k + 1] * 0.59 + da[k + 2] * 0.11;
      const lb = db[k] * 0.3 + db[k + 1] * 0.59 + db[k + 2] * 0.11;
      if (la < lb + 20) paint(oldMask.data, k);
      if (lb < la + 20) paint(newMask.data, k);
      grid[Math.floor(y / CELL) * gw + Math.floor(x / CELL)]++;
    }
  }
  if (!any) return null;
  const toUrl = async (img: ImageData) => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    c.getContext('2d')!.putImageData(img, 0, 0);
    const url = await new Promise<string>((ok) => c.toBlob((b) => ok(b ? URL.createObjectURL(b) : ''), 'image/png'));
    c.width = c.height = 0;
    return url;
  };
  const urlA = await toUrl(oldMask);
  const urlB = await toUrl(newMask);
  // Group busy cells (allowing one-cell gaps) into areas.
  const hot = (i: number) => grid[i] >= 3;
  const seen = new Uint8Array(gw * gh);
  const areas: Rect[] = [];
  for (let i = 0; i < grid.length; i++) {
    if (!hot(i) || seen[i]) continue;
    let x1 = gw,
      y1 = gh,
      x2 = -1,
      y2 = -1;
    const stack = [i];
    seen[i] = 1;
    while (stack.length) {
      const c = stack.pop()!;
      const cx = c % gw;
      const cy = (c - cx) / gw;
      x1 = Math.min(x1, cx);
      y1 = Math.min(y1, cy);
      x2 = Math.max(x2, cx);
      y2 = Math.max(y2, cy);
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
          const ni = ny * gw + nx;
          if (!seen[ni] && hot(ni)) {
            seen[ni] = 1;
            stack.push(ni);
          }
        }
    }
    const s = CELL / DETECT_SCALE;
    areas.push({ x: x1 * s, y: y1 * s, w: (x2 - x1 + 1) * s, h: (y2 - y1 + 1) * s });
  }
  return { diff: { a: urlA, b: urlB, w: w / DETECT_SCALE, h: h / DETECT_SCALE }, areas };
}

let run = 0;

/** Renders each page pair and adds the visual changes the text diff didn't cover. */
async function findVisualChanges(token: number) {
  const { left, right, pairs } = cget();
  if (!left || !right) return;
  for (const [pi, p] of pairs.entries()) {
    if (token !== run || !cget().open) return;
    if (p.a === null || p.b === null) continue;
    cset({ status: `Comparing page ${pi + 1} of ${pairs.length} visually…` });
    let res: Awaited<ReturnType<typeof pixelDiff>> = null;
    try {
      res = await pixelDiff(left, right, p);
    } catch (e) {
      console.warn('Visual compare failed for a page', e);
    }
    if (token !== run || !res) continue;
    const st = cget();
    const covered = st.changes.filter((c) => c.pair === pi).flatMap((c) => [...c.a, ...c.b]);
    const pad = (r: Rect) => ({ x: r.x - 4, y: r.y - 4, w: r.w + 8, h: r.h + 8 });
    const extra = res.areas.filter((r) => !covered.some((c) => rectsIntersect(pad(c), r))).slice(0, 40);
    const visual = new Map(st.visual);
    visual.set(pi, res.diff);
    let changes = st.changes;
    if (extra.length) {
      let id = Math.max(-1, ...changes.map((c) => c.id)) + 1;
      const added: Change[] = extra.map((r) => ({ id: id++, pair: pi, kind: 'visual', oldText: '', newText: '', a: [r], b: [r] }));
      changes = sortChanges([...changes, ...added]);
    }
    const activeId = st.changes[st.active]?.id;
    cset({ visual, changes, active: activeId === undefined ? st.active : changes.findIndex((c) => c.id === activeId) });
  }
  if (token === run) cset({ status: null, visualDone: true });
}

function sortChanges(list: Change[]) {
  const top = (c: Change) => Math.min(...[...c.a, ...c.b].map((r) => r.y), Infinity);
  return [...list].sort((x, y) => x.pair - y.pair || top(x) - top(y) || x.id - y.id);
}

/* ------------------------------------------------------------------ */
/* Opening and closing                                                  */
/* ------------------------------------------------------------------ */

async function sideFrom(pdf: PDFDocumentProxy, name: string, owned: boolean, progress: (i: number, n: number) => void): Promise<Side> {
  const pages: ComparePage[] = [];
  for (let i = 0; i < pdf.numPages; i++) {
    progress(i, pdf.numPages);
    pages.push(await pageWords(await pdf.getPage(i + 1)));
  }
  return { name, pdf, pages, owned };
}

/** The open document as it is now: the original file, or what saving it would produce. */
async function currentPdf(): Promise<{ pdf: PDFDocumentProxy; owned: boolean }> {
  const s = get();
  const doc = untouchedDoc();
  if (doc) return { pdf: doc.pdf, owned: false };
  const { buildPdf } = await import('./export');
  const res = await buildPdf({ docs: s.docs, pages: s.pages, objects: s.objects, meta: s.meta });
  const { pdf } = (await loadSource(res.bytes, s.fileName, async () => null)).doc;
  return { pdf, owned: true };
}

export async function compareWith() {
  const s = get();
  if (!s.pages.length || s.busy) return;
  const picked = await pickFiles({ multiple: false });
  const file = picked[0]?.file;
  if (!file) return;
  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
    toast('That file is not a PDF', 'error');
    return;
  }
  closeCompare();
  const token = ++run;
  actions.set({ busy: 'Opening for comparison…' });
  let other: PDFDocumentProxy | null = null;
  let mine: { pdf: PDFDocumentProxy; owned: boolean } | null = null;
  try {
    const loaded = await loadSource(await readFileBytes(file), file.name, (retry) =>
      new Promise((resolve) =>
        actions.set({
          dialog: {
            kind: 'password',
            name: file.name,
            retry,
            resolve: (pw) => {
              actions.set({ dialog: null });
              resolve(pw);
            },
          },
        }),
      ),
    );
    other = loaded.doc.pdf;
    actions.set({ busy: 'Preparing the open document…' });
    mine = await currentPdf();
    const left = await sideFrom(mine.pdf, s.fileName, mine.owned, (i, n) => actions.set({ busy: `Reading ${s.fileName} (page ${i + 1} of ${n})…` }));
    const right = await sideFrom(other, file.name, true, (i, n) => actions.set({ busy: `Reading ${file.name} (page ${i + 1} of ${n})…` }));
    if (token !== run) return;
    const pairs = alignPages(left.pages, right.pages);
    const changes = sortChanges(textChanges(left, right, pairs));
    cset({ ...INITIAL, visual: new Map(), open: true, left, right, pairs, changes, active: changes.length ? 0 : -1 });
    actions.set({ busy: null });
    void findVisualChanges(token);
  } catch (e) {
    if (mine?.owned) void mine.pdf.loadingTask.destroy();
    if (other) void other.loadingTask.destroy();
    if (!(e instanceof PasswordCancelled)) {
      console.error(e);
      toast(`Couldn't compare: ${(e as Error).message}`, 'error');
    }
  } finally {
    actions.set({ busy: null });
  }
}

/** Puts the other document on the left (as the older version). */
export function swapSides() {
  const st = cget();
  if (!st.left || !st.right) return;
  const token = ++run;
  const left = st.right;
  const right = st.left;
  const pairs = alignPages(left.pages, right.pages);
  const changes = sortChanges(textChanges(left, right, pairs));
  forgetVisual();
  cset({ left, right, pairs, changes, active: changes.length ? 0 : -1, visual: new Map(), visualDone: false });
  void findVisualChanges(token);
}

function forgetVisual() {
  for (const v of cget().visual.values()) for (const u of [v.a, v.b]) if (u) URL.revokeObjectURL(u);
}

export function closeCompare() {
  run++;
  const st = cget();
  forgetVisual();
  for (const side of [st.left, st.right]) if (side?.owned) void side.pdf.loadingTask.destroy();
  cset({ ...INITIAL, visual: new Map() });
}

// Closing the document, or opening another one, ends the comparison.
useStore.subscribe((s, prev) => {
  if (!cget().open) return;
  if (!s.pages.length || (s.docs !== prev.docs && !Object.keys(prev.docs).some((id) => id in s.docs))) closeCompare();
});

export function stepChange(dir: 1 | -1) {
  const st = cget();
  const n = st.changes.length;
  if (!n) return;
  cset({ active: st.active < 0 ? 0 : (st.active + dir + n) % n });
}
