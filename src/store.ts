import { create } from 'zustand';
import { PDFDocument } from '@cantoo/pdf-lib';
import type { Dialog, DocMeta, Obj, PageItem, Rotation, SourceDoc, Tool, ToolStyle } from './types';
import { getText, loadSource, measureGuessed, PasswordCancelled, textItems, type PageGeometry } from './lib/pdfjs';
import { readFileBytes, uid } from './lib/util';
import { forgetLiveSources } from './lib/live';
import type { FileRef, Picked } from './lib/files';

interface Snapshot {
  pages: PageItem[];
  objects: Obj[];
  meta: DocMeta;
}

export interface SearchPart {
  item: number;
  start: number;
  end: number;
}

export interface SearchHit {
  page: string;
  parts: SearchPart[];
  before: string;
  match: string;
  after: string;
}

export interface Toast {
  id: string;
  text: string;
  kind: 'info' | 'error' | 'success';
}

export type SidebarTab = 'pages' | 'bookmarks' | 'comments' | 'search';
export type Theme = 'light' | 'dark' | 'system';

interface State extends Snapshot {
  docs: Record<string, SourceDoc>;
  fileName: string;
  fileHandle: FileRef | null;
  dirty: boolean;
  busy: string | null;
  past: Snapshot[];
  future: Snapshot[];
  gestureBase: Snapshot | null;

  zoom: number;
  fit: 'width' | 'page' | null;
  currentPage: number;
  scrollReq: { page: number; y?: number; ts: number } | null;
  tool: Tool;
  selection: string[];
  editing: string | null;
  openNote: string | null;
  /** Lifted images being dragged right now; live renders cut them out. */
  liveHoles: string[];
  pageSelection: string[];
  sidebar: SidebarTab | null;
  organize: boolean;
  dialog: Dialog | null;
  theme: Theme;
  userName: string;
  style: ToolStyle;
  toasts: Toast[];
  search: { query: string; matchCase: boolean; hits: SearchHit[]; active: number; running: boolean };
}

const DEFAULT_STYLE: ToolStyle = {
  stroke: '#e03131',
  fill: null,
  width: 2,
  opacity: 1,
  highlight: '#ffd43b',
  underline: '#1971c2',
  strike: '#e03131',
  inkColor: '#1c7ed6',
  inkWidth: 2.5,
  textColor: '#1a1a1a',
  font: 'sans',
  size: 14,
  bold: false,
  italic: false,
  noteColor: '#fcc419',
  redactColor: '#000000',
  redactMatch: false,
};

function loadPref<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`folio.${key}`);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}

function loadString(key: string, fallback: string) {
  try {
    return localStorage.getItem(`folio.${key}`) || fallback;
  } catch {
    return fallback;
  }
}

function loadTheme(): Theme {
  return loadString('theme', 'system') as Theme;
}

export function savePref(key: string, value: unknown) {
  try {
    localStorage.setItem(`folio.${key}`, typeof value === 'string' ? value : JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
}

const EMPTY_META: DocMeta = { title: '', author: '', subject: '', keywords: '' };

export const useStore = create<State>()(() => ({
  docs: {},
  pages: [],
  objects: [],
  meta: EMPTY_META,
  fileName: '',
  fileHandle: null,
  dirty: false,
  busy: null,
  past: [],
  future: [],
  gestureBase: null,

  zoom: 1,
  fit: 'width',
  currentPage: 0,
  scrollReq: null,
  tool: 'select',
  selection: [],
  editing: null,
  openNote: null,
  liveHoles: [],
  pageSelection: [],
  sidebar: 'pages',
  organize: false,
  dialog: null,
  theme: loadTheme(),
  userName: loadString('userName', 'Me'),
  style: loadPref('style', DEFAULT_STYLE),
  toasts: [],
  search: { query: '', matchCase: false, hits: [], active: -1, running: false },
}));

const get = useStore.getState;
const set = useStore.setState;

const snap = (s: Snapshot): Snapshot => ({ pages: s.pages, objects: s.objects, meta: s.meta });

/* ------------------------------------------------------------------ */
/* History                                                             */
/* ------------------------------------------------------------------ */

/** Applies a document change as one undoable step. */
export function commit(fn: (s: State) => Partial<Snapshot>) {
  const s = get();
  const patch = fn(s);
  set({ ...patch, past: [...s.past, snap(s)].slice(-300), future: [], dirty: true });
}

/** Start of a drag or typing session: changes until endGesture are one step. */
export function beginGesture() {
  set({ gestureBase: snap(get()) });
}

export function transient(fn: (s: State) => Partial<Snapshot>) {
  set(fn(get()));
}

export function endGesture() {
  const s = get();
  const base = s.gestureBase;
  if (!base) return;
  const changed = base.pages !== s.pages || base.objects !== s.objects || base.meta !== s.meta;
  set(changed ? { gestureBase: null, past: [...s.past, base].slice(-300), future: [], dirty: true } : { gestureBase: null });
}

function restore(target: Snapshot, s: State) {
  const ids = new Set(target.objects.map((o) => o.id));
  return {
    ...target,
    selection: s.selection.filter((id) => ids.has(id)),
    editing: null,
    pageSelection: s.pageSelection.filter((id) => target.pages.some((p) => p.id === id)),
    dirty: true,
  };
}

export function undo() {
  const s = get();
  if (s.gestureBase) endGesture();
  const t = get();
  const prev = t.past[t.past.length - 1];
  if (!prev) return;
  set({ ...restore(prev, t), past: t.past.slice(0, -1), future: [snap(t), ...t.future] });
}

export function redo() {
  const s = get();
  const next = s.future[0];
  if (!next) return;
  set({ ...restore(next, s), past: [...s.past, snap(s)], future: s.future.slice(1) });
}

/* ------------------------------------------------------------------ */
/* Objects                                                             */
/* ------------------------------------------------------------------ */

export function addObject(o: Obj, opts: { select?: boolean; edit?: boolean } = {}) {
  commit((s) => ({ objects: [...s.objects, o] }));
  if (opts.select !== false) set({ selection: [o.id], editing: opts.edit ? o.id : null });
}

export function addObjects(list: Obj[]) {
  if (!list.length) return;
  commit((s) => ({ objects: [...s.objects, ...list] }));
  set({ selection: list.map((o) => o.id) });
}

type Patch = Partial<Obj> | ((o: Obj) => Partial<Obj>);

function patchObjects(objects: Obj[], ids: string[], patch: Patch) {
  const want = new Set(ids);
  return objects.map((o) => (want.has(o.id) ? ({ ...o, ...(typeof patch === 'function' ? patch(o) : patch) } as Obj) : o));
}

export function updateObjects(ids: string[], patch: Patch) {
  if (!ids.length) return;
  commit((s) => ({ objects: patchObjects(s.objects, ids, patch) }));
}

export function updateObjectsTransient(ids: string[], patch: Patch) {
  transient((s) => ({ objects: patchObjects(s.objects, ids, patch) }));
}

/** What deleting an object leaves behind: edits of original content become erasures. */
function tombstone(o: Obj): Obj | null {
  if ((o.type === 'text' || o.type === 'image') && o.cover) {
    const c = o.cover;
    return {
      id: o.id,
      page: o.page,
      created: Date.now(),
      author: o.author,
      opacity: 1,
      type: 'whiteout',
      x: c.x,
      y: c.y,
      w: c.w,
      h: c.h,
      color: c.color,
      erase: o.type === 'text' ? 'text' : 'image',
    };
  }
  return null;
}

export function deleteObjects(ids: string[]) {
  if (!ids.length) return;
  const want = new Set(ids);
  commit((s) => ({
    objects: s.objects.flatMap((o) => {
      if (!want.has(o.id)) return [o];
      const t = tombstone(o);
      return t ? [t] : [];
    }),
  }));
  set((s) => ({ selection: s.selection.filter((id) => !want.has(id)), editing: null, openNote: null }));
}

export function duplicateObjects(ids: string[], offset = 12) {
  const s = get();
  const want = new Set(ids);
  const copies = s.objects
    .filter((o) => want.has(o.id))
    .map((o) => {
      return shift(detach({ ...structuredClone(o), id: uid(), created: Date.now() } as Obj), offset);
    });
  addObjects(copies);
}

export function reorderObjects(ids: string[], where: 'front' | 'back') {
  const want = new Set(ids);
  commit((s) => {
    const moving = s.objects.filter((o) => want.has(o.id));
    const rest = s.objects.filter((o) => !want.has(o.id));
    return { objects: where === 'front' ? [...rest, ...moving] : [...moving, ...rest] };
  });
}

let clipboard: Obj[] = [];

export function copyObjects(ids: string[]) {
  const want = new Set(ids);
  clipboard = get().objects.filter((o) => want.has(o.id)).map((o) => structuredClone(o));
  return clipboard.length;
}

export function pasteObjects() {
  const s = get();
  const page = s.pages[s.currentPage];
  if (!clipboard.length || !page) return false;
  const sameSpot = clipboard.every((o) => o.page === page.id);
  const copies = clipboard.map((o) => {
    const c = detach({ ...structuredClone(o), id: uid(), page: page.id, created: Date.now() } as Obj);
    return sameSpot ? shift(c, 12) : c;
  });
  clipboard = copies.map((o) => structuredClone(o));
  addObjects(copies);
  return true;
}

/** Copies of edited page content are plain objects; only the original replaces anything. */
function detach(o: Obj): Obj {
  if (o.type === 'text') delete o.cover;
  if (o.type === 'image') {
    delete o.cover;
    delete o.orig;
  }
  if (o.type === 'whiteout') delete o.erase;
  return o;
}

function shift(o: Obj, d: number): Obj {
  switch (o.type) {
    case 'line':
    case 'arrow':
      return { ...o, x1: o.x1 + d, y1: o.y1 + d, x2: o.x2 + d, y2: o.y2 + d };
    case 'ink':
      return { ...o, strokes: o.strokes.map((st) => st.map((v) => v + d)) };
    case 'highlight':
    case 'underline':
    case 'strike':
      return { ...o, rects: o.rects.map((r) => ({ ...r, x: r.x + d, y: r.y + d })) };
    default:
      return { ...o, x: o.x + d, y: o.y + d };
  }
}

/* ------------------------------------------------------------------ */
/* UI state                                                            */
/* ------------------------------------------------------------------ */

const STICKY_TOOLS: Tool[] = ['select', 'hand', 'editText', 'highlight', 'underline', 'strike', 'ink', 'redact', 'whiteout'];

export function setHole(id: string, on: boolean) {
  const cur = get().liveHoles;
  if (on === cur.includes(id)) return;
  set({ liveHoles: on ? [...cur, id] : cur.filter((x) => x !== id) });
}

export function setTool(tool: Tool) {
  set({ tool, editing: null, selection: tool === 'select' ? get().selection : [], openNote: null });
}

/** After creating an object, one-shot tools fall back to Select. */
export function toolDone() {
  if (!STICKY_TOOLS.includes(get().tool)) set({ tool: 'select' });
}

export function setStyle(patch: Partial<ToolStyle>) {
  const style = { ...get().style, ...patch };
  set({ style });
  savePref('style', style);
}

export function setUserName(userName: string) {
  set({ userName });
  savePref('userName', userName);
}

export function setTheme(theme: Theme) {
  set({ theme });
  savePref('theme', theme);
}

export function toast(text: string, kind: Toast['kind'] = 'info') {
  const t = { id: uid(), text, kind };
  set((s) => ({ toasts: [...s.toasts, t] }));
  setTimeout(() => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== t.id) })), kind === 'error' ? 6000 : 3200);
}

export function scrollToPage(page: number, y?: number) {
  const s = get();
  const p = Math.max(0, Math.min(s.pages.length - 1, page));
  set({ scrollReq: { page: p, y, ts: Date.now() }, currentPage: p });
}

export const ZOOM_MIN = 0.1;
export const ZOOM_MAX = 8;
export const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5, 6, 8];

export function setZoom(zoom: number) {
  set({ zoom: Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom)), fit: null });
}

export function zoomStep(dir: 1 | -1) {
  const z = get().zoom;
  const next = dir > 0 ? ZOOM_STEPS.find((s) => s > z + 0.001) : [...ZOOM_STEPS].reverse().find((s) => s < z - 0.001);
  setZoom(next ?? z);
}

/* ------------------------------------------------------------------ */
/* Opening documents                                                   */
/* ------------------------------------------------------------------ */

function askPassword(name: string) {
  return (retry: boolean) =>
    new Promise<string | null>((resolve) => {
      set({
        dialog: {
          kind: 'password',
          name,
          retry,
          resolve: (pw) => {
            set({ dialog: null });
            resolve(pw);
          },
        },
      });
    });
}

async function loadFile(file: File) {
  const bytes = await readFileBytes(file);
  return loadSource(bytes, file.name, askPassword(file.name));
}

export async function openDocuments(picked: Picked[]) {
  const pdfs = picked.filter((p) => /pdf$/i.test(p.file.type) || /\.pdf$/i.test(p.file.name));
  if (!pdfs.length) {
    if (picked.length) toast('That file is not a PDF', 'error');
    return;
  }
  const prev = get();
  set({ busy: pdfs.length > 1 ? 'Combining documents…' : 'Opening…' });
  try {
    const loaded = [];
    for (const p of pdfs) loaded.push(await loadFile(p.file));
    for (const d of Object.values(prev.docs)) void d.pdf.loadingTask.destroy();
    forgetLiveSources();
    const docs: Record<string, SourceDoc> = {};
    for (const l of loaded) docs[l.doc.id] = l.doc;
    const first = loaded[0].doc;
    const info = (await first.pdf.getMetadata().catch(() => null))?.info as Record<string, unknown> | undefined;
    const str = (v: unknown) => (typeof v === 'string' ? v : '');
    set({
      docs,
      pages: loaded.flatMap((l) => l.pages),
      objects: [],
      meta: {
        title: str(info?.Title),
        author: str(info?.Author),
        subject: str(info?.Subject),
        keywords: str(info?.Keywords),
      },
      fileName: pdfs.length > 1 ? 'Combined.pdf' : first.name,
      fileHandle: pdfs.length === 1 ? pdfs[0].handle : null,
      dirty: pdfs.length > 1,
      past: [],
      future: [],
      selection: [],
      editing: null,
      openNote: null,
      pageSelection: [],
      currentPage: 0,
      scrollReq: { page: 0, ts: Date.now() },
      fit: 'width',
      organize: false,
      tool: 'select',
      search: { query: '', matchCase: false, hits: [], active: -1, running: false },
    });
    blankDocs.clear();
    for (const l of loaded) void measureGuessed(l.doc, (changed) => applyGeometry(l.doc.id, changed));
  } catch (e) {
    if (!(e instanceof PasswordCancelled)) {
      console.error(e);
      toast(`Couldn't open the file: ${(e as Error).message}`, 'error');
    }
  } finally {
    set({ busy: null });
  }
}

export function closeDocument() {
  for (const d of Object.values(get().docs)) void d.pdf.loadingTask.destroy();
  forgetLiveSources();
  blankDocs.clear();
  set({
    docs: {},
    pages: [],
    objects: [],
    meta: EMPTY_META,
    fileName: '',
    fileHandle: null,
    dirty: false,
    past: [],
    future: [],
    selection: [],
    pageSelection: [],
    editing: null,
    openNote: null,
    organize: false,
  });
}

/* ------------------------------------------------------------------ */
/* Page operations                                                     */
/* ------------------------------------------------------------------ */

export function rotatePages(ids: string[], delta: 90 | -90 | 180) {
  const want = new Set(ids);
  commit((s) => ({
    pages: s.pages.map((p) => (want.has(p.id) ? { ...p, rotation: (((p.rotation + delta) % 360) + 360) % 360 as Rotation } : p)),
  }));
}

export function deletePages(ids: string[]) {
  const s = get();
  const want = new Set(ids);
  if (s.pages.every((p) => want.has(p.id))) {
    toast('A document needs at least one page', 'error');
    return;
  }
  commit((st) => ({
    pages: st.pages.filter((p) => !want.has(p.id)),
    objects: st.objects.filter((o) => !want.has(o.page)),
  }));
  set((st) => ({
    pageSelection: [],
    currentPage: Math.min(st.currentPage, st.pages.length - 1),
  }));
}

/** Moves the given pages so they sit before `before` (an index in the current order). */
export function movePages(ids: string[], before: number) {
  const s = get();
  const want = new Set(ids);
  const moving = s.pages.filter((p) => want.has(p.id));
  const head = s.pages.slice(0, before).filter((p) => !want.has(p.id));
  const tail = s.pages.slice(before).filter((p) => !want.has(p.id));
  const next = [...head, ...moving, ...tail];
  if (next.every((p, i) => p === s.pages[i])) return;
  commit(() => ({ pages: next }));
}

export function duplicatePages(ids: string[]) {
  const want = new Set(ids);
  commit((s) => {
    const pages: PageItem[] = [];
    const objects = [...s.objects];
    for (const p of s.pages) {
      pages.push(p);
      if (!want.has(p.id)) continue;
      const copy = { ...p, id: uid() };
      pages.push(copy);
      for (const o of s.objects) if (o.page === p.id) objects.push({ ...structuredClone(o), id: uid(), page: copy.id });
    }
    return { pages, objects };
  });
}

const blankDocs = new Map<string, string>();

async function blankSource(w: number, h: number): Promise<{ doc: SourceDoc; page: PageItem } | string> {
  const key = `${Math.round(w)}x${Math.round(h)}`;
  const existing = blankDocs.get(key);
  if (existing && get().docs[existing]) return existing;
  const d = await PDFDocument.create();
  d.addPage([w, h]);
  const bytes = await d.save();
  const { doc, pages } = await loadSource(bytes, 'Blank page', async () => null);
  blankDocs.set(key, doc.id);
  return { doc, page: pages[0] };
}

export async function insertBlankPage(at: number, size?: { w: number; h: number }) {
  const s = get();
  const ref = s.pages[Math.min(at, s.pages.length - 1)] ?? s.pages[s.pages.length - 1];
  const w = size?.w ?? (ref ? (ref.rotation % 180 ? ref.h : ref.w) : 612);
  const h = size?.h ?? (ref ? (ref.rotation % 180 ? ref.w : ref.h) : 792);
  const res = await blankSource(w, h);
  let page: PageItem;
  if (typeof res === 'string') {
    const doc = get().docs[res];
    const pg = await doc.pdf.getPage(1);
    const vp = pg.getViewport({ scale: 1 });
    page = { id: uid(), src: res, index: 0, rotation: 0, w: vp.width, h: vp.height, baseRotate: 0, m: vp.transform as PageItem['m'] };
  } else {
    set((st) => ({ docs: { ...st.docs, [res.doc.id]: res.doc } }));
    page = res.page;
  }
  commit((st) => {
    const pages = [...st.pages];
    pages.splice(at, 0, page);
    return { pages };
  });
  scrollToPage(at);
}

export async function insertDocuments(picked: Picked[], at: number) {
  const pdfs = picked.filter((p) => /\.pdf$/i.test(p.file.name) || p.file.type === 'application/pdf');
  if (!pdfs.length) return;
  set({ busy: 'Inserting pages…' });
  try {
    const added: PageItem[] = [];
    const docs: Record<string, SourceDoc> = {};
    for (const p of pdfs) {
      const l = await loadFile(p.file);
      docs[l.doc.id] = l.doc;
      added.push(...l.pages);
    }
    set((st) => ({ docs: { ...st.docs, ...docs } }));
    commit((st) => {
      const pages = [...st.pages];
      pages.splice(at, 0, ...added);
      return { pages };
    });
    for (const d of Object.values(docs)) void measureGuessed(d, (changed) => applyGeometry(d.id, changed));
    toast(`Inserted ${added.length} page${added.length === 1 ? '' : 's'}`, 'success');
    scrollToPage(at);
  } catch (e) {
    if (!(e instanceof PasswordCancelled)) toast(`Couldn't insert: ${(e as Error).message}`, 'error');
  } finally {
    set({ busy: null });
  }
}

/**
 * Puts measured page sizes in place of the guesses a large document opened
 * with (see loadSource), everywhere the pages appear, history included.
 * Not an edit: nothing becomes undoable or dirty.
 */
function applyGeometry(src: string, changed: Map<number, PageGeometry>) {
  const fixed = new Map<PageItem[], PageItem[]>();
  const fix = (list: PageItem[]) => {
    let out = fixed.get(list);
    if (!out) {
      const hit = (p: PageItem) => p.src === src && changed.has(p.index);
      out = list.some(hit) ? list.map((p) => (hit(p) ? { ...p, ...changed.get(p.index)! } : p)) : list;
      fixed.set(list, out);
    }
    return out;
  };
  const fixSnap = (sn: Snapshot) => {
    const pages = fix(sn.pages);
    return pages === sn.pages ? sn : { ...sn, pages };
  };
  const fixAll = (list: Snapshot[]) => {
    const out = list.map(fixSnap);
    return out.some((sn, i) => sn !== list[i]) ? out : list;
  };
  set((s) => ({ pages: fix(s.pages), past: fixAll(s.past), future: fixAll(s.future), gestureBase: s.gestureBase && fixSnap(s.gestureBase) }));
}

export function setMeta(meta: DocMeta) {
  commit(() => ({ meta }));
}

/* ------------------------------------------------------------------ */
/* Search                                                              */
/* ------------------------------------------------------------------ */

let searchRun = 0;

export async function runSearch(query: string, matchCase = get().search.matchCase) {
  const run = ++searchRun;
  const q = query.trim();
  set({ search: { query, matchCase, hits: [], active: -1, running: !!q } });
  if (!q) return;
  const needle = matchCase ? q : q.toLowerCase();
  const hits: SearchHit[] = [];
  const { pages, docs } = get();
  for (const page of pages) {
    const doc = docs[page.src];
    if (!doc) continue;
    const tc = await getText(doc, page.index);
    if (run !== searchRun) return;
    const items = textItems(tc);
    // Concatenate items, remembering where each character came from.
    let text = '';
    const owner: number[] = [];
    const offset: number[] = [];
    items.forEach((it, i) => {
      for (let k = 0; k < it.str.length; k++) {
        owner.push(i);
        offset.push(k);
      }
      text += it.str;
      if (it.hasEOL) {
        text += ' ';
        owner.push(-1);
        offset.push(0);
      }
    });
    const hay = matchCase ? text : text.toLowerCase();
    let from = 0;
    for (;;) {
      const at = hay.indexOf(needle, from);
      if (at < 0) break;
      from = at + needle.length;
      const parts: SearchPart[] = [];
      for (let c = at; c < at + needle.length; c++) {
        const item = owner[c];
        if (item < 0) continue;
        const last = parts[parts.length - 1];
        if (last && last.item === item && last.end === offset[c]) last.end++;
        else parts.push({ item, start: offset[c], end: offset[c] + 1 });
      }
      hits.push({
        page: page.id,
        parts,
        before: text.slice(Math.max(0, at - 40), at).replace(/\s+/g, ' '),
        match: text.slice(at, at + needle.length),
        after: text.slice(at + needle.length, at + needle.length + 60).replace(/\s+/g, ' '),
      });
      if (hits.length >= 5000) break;
    }
    if (hits.length && get().search.hits.length === 0) {
      set((s) => ({ search: { ...s.search, hits: [...hits], active: 0 } }));
      gotoHit(0);
    }
  }
  if (run !== searchRun) return;
  set((s) => ({ search: { ...s.search, hits, running: false, active: hits.length ? Math.max(0, s.search.active) : -1 } }));
}

export function gotoHit(i: number) {
  const s = get();
  const n = s.search.hits.length;
  if (!n) return;
  const idx = ((i % n) + n) % n;
  const hit = s.search.hits[idx];
  set({ search: { ...s.search, active: idx } });
  const pageIndex = s.pages.findIndex((p) => p.id === hit.page);
  if (pageIndex >= 0) set({ scrollReq: { page: pageIndex, y: -1, ts: Date.now() } });
}

export function clearSearch() {
  searchRun++;
  set({ search: { query: '', matchCase: get().search.matchCase, hits: [], active: -1, running: false } });
}

export const actions = { get, set };
