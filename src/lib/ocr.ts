/**
 * On-device text recognition for scanned pages: tesseract.js, running as
 * WebAssembly in a Web Worker. The worker, its core and the language data ship
 * with the app in public/tesseract (see scripts/copy-tesseract-assets.mjs);
 * nothing is fetched from the network and nothing leaves the device.
 */
import { create } from 'zustand';
import { AnnotationMode } from 'pdfjs-dist';
import type Tesseract from 'tesseract.js';
import type { Matrix, PageItem, Rect, SourceDoc } from '../types';
import { actions, commit, runSearch, toast } from '../store';
import { buildLines, findImages, getText, textItems } from './pdfjs';
import { fromEngine, ocrKey, ocrWordCount, type EngineBlock, type OcrPage } from './ocrModel';

const { get } = actions;

/** Resolution pages are rendered at for recognition. */
const OCR_DPI = 300;
const MAX_PIXELS = 40_000_000;
/** A page with less real text than this, mostly covered by images, is a scan. */
const MIN_TEXT_CHARS = 40;
const MIN_IMAGE_COVER = 0.5;
/** The engine holds on to a lot of memory; it's let go after this long unused. */
const IDLE_MS = 90_000;

const asset = (path: string) => new URL(`${import.meta.env.BASE_URL}tesseract/${path}`, location.href).href;

export interface OcrJob {
  /** Pages being recognized, in order. */
  pages: string[];
  /** How many of them are finished. */
  done: number;
  /** Progress on the current page, 0 to 1. */
  progress: number;
  phase: 'checking' | 'starting' | 'recognizing';
}

export const useOcr = create<{ job: OcrJob | null; dismissed: string[] }>(() => ({ job: null, dismissed: [] }));

/** Hides the "scanned page" notices of one source document. */
export function dismissScanNotices(docId: string) {
  useOcr.setState((s) => ({ dismissed: [...s.dismissed, docId] }));
}

/* ------------------------------------------------------------------ */
/* Which pages need it                                                 */
/* ------------------------------------------------------------------ */

const scans = new Map<string, Promise<boolean>>();

const clipArea = (r: Rect, w: number, h: number) => Math.max(0, Math.min(r.x + r.w, w) - Math.max(r.x, 0)) * Math.max(0, Math.min(r.y + r.h, h) - Math.max(r.y, 0));

/** A page is a scan when it has (almost) no text and images cover most of it. */
export function isScanned(doc: SourceDoc, page: PageItem): Promise<boolean> {
  const key = ocrKey(page);
  let p = scans.get(key);
  if (!p) {
    p = (async () => {
      const tc = await getText(doc, page.index);
      const chars = textItems(tc).reduce((n, it) => n + it.str.replace(/\s+/g, '').length, 0);
      if (chars >= MIN_TEXT_CHARS) return false;
      const pdfPage = await doc.pdf.getPage(page.index + 1);
      const images = await findImages(pdfPage, page, { all: true });
      const covered = images.reduce((t, im) => t + clipArea(im.visible, page.w, page.h), 0);
      return covered >= MIN_IMAGE_COVER * page.w * page.h;
    })().catch(() => false);
    scans.set(key, p);
  }
  return p;
}

/* ------------------------------------------------------------------ */
/* The engine                                                          */
/* ------------------------------------------------------------------ */

let engine: Promise<{ worker: Tesseract.Worker; langs: string }> | null = null;
let onProgress: ((p: number) => void) | null = null;
let idle: ReturnType<typeof setTimeout> | undefined;

async function languages(): Promise<string[]> {
  const res = await fetch(asset('languages.json')).catch(() => null);
  const list = res?.ok ? ((await res.json()) as string[]) : [];
  if (!list.length) throw new Error('no recognition languages are installed');
  return list;
}

function getEngine() {
  clearTimeout(idle);
  if (!engine) {
    const starting = (async () => {
      const [mod, langs] = await Promise.all([import('tesseract.js'), languages()]);
      const T = ((mod as unknown as { default?: typeof Tesseract }).default ?? mod) as typeof Tesseract;
      const worker = await T.createWorker(langs, T.OEM.LSTM_ONLY, {
        workerPath: asset('worker.min.js'),
        corePath: asset('core'),
        langPath: asset('lang'),
        // The data is local already; don't keep a second copy in IndexedDB.
        cacheMethod: 'none',
        workerBlobURL: false,
        logger: (m) => {
          if (m.status === 'recognizing text') onProgress?.(m.progress);
        },
        errorHandler: (e) => console.warn('Text recognition:', e),
      });
      // Full layout analysis (columns, headings), rather than one block of text.
      await worker.setParameters({ tessedit_pageseg_mode: T.PSM.AUTO, user_defined_dpi: String(OCR_DPI) });
      return { worker, langs: langs.join('+') };
    })();
    starting.catch(() => {
      if (engine === starting) engine = null;
    });
    engine = starting;
  }
  return engine;
}

function stopEngine() {
  clearTimeout(idle);
  const e = engine;
  engine = null;
  void e?.then(({ worker }) => worker.terminate()).catch(() => {});
}

/* ------------------------------------------------------------------ */
/* Recognizing pages                                                   */
/* ------------------------------------------------------------------ */

async function recognizePage(worker: Tesseract.Worker, langs: string, doc: SourceDoc, item: PageItem): Promise<OcrPage> {
  const pdfPage = await doc.pdf.getPage(item.index + 1);
  const unit = pdfPage.getViewport({ scale: 1 });
  let scale = OCR_DPI / 72;
  if (unit.width * unit.height * scale * scale > MAX_PIXELS) scale = Math.sqrt(MAX_PIXELS / (unit.width * unit.height));
  const viewport = pdfPage.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(viewport.width));
  canvas.height = Math.max(1, Math.round(viewport.height));
  let image: Blob;
  try {
    // The print intent renders even while the window is hidden.
    await pdfPage.render({ canvas, viewport, intent: 'print', annotationMode: AnnotationMode.DISABLE }).promise;
    image = await new Promise<Blob>((ok, no) => canvas.toBlob((b) => (b ? ok(b) : no(new Error('the page could not be captured'))), 'image/png'));
  } finally {
    canvas.width = canvas.height = 0;
  }
  const { data } = await worker.recognize(image, {}, { blocks: true, text: false });
  // Text the page already has is kept as it is, not recognized a second time.
  const existing = buildLines(await getText(doc, item.index), item);
  return fromEngine(data.blocks as unknown as EngineBlock[], scale, unit.transform as Matrix, langs, existing);
}

class Cancelled extends Error {}
let cancelJob: (() => void) | null = null;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Recognizes the text of scanned pages: the given pages, or the whole
 * document. Pages that already have text, or were recognized before, are
 * skipped. The results are added as one undoable change.
 */
export async function recognizeText(pageIds?: string[]) {
  if (useOcr.getState().job) return;
  const s = get();
  const want = pageIds ? new Set(pageIds) : null;
  const seen = new Set<string>();
  let already = 0;
  const candidates = s.pages.filter((p) => {
    if (want && !want.has(p.id)) return false;
    const k = ocrKey(p);
    if (seen.has(k)) return false;
    seen.add(k);
    if (s.ocr[k]) already++;
    return !s.ocr[k];
  });

  const setJob = (patch: Partial<OcrJob>) => useOcr.setState((st) => (st.job ? { job: { ...st.job, ...patch } } : st));
  useOcr.setState({ job: { pages: candidates.map((p) => p.id), done: 0, progress: 0, phase: 'checking' } });
  let cancelled = false;
  const stopped = new Promise<never>((_, reject) => {
    cancelJob = () => {
      cancelled = true;
      reject(new Cancelled());
    };
  });
  stopped.catch(() => {});

  const results: { key: string; src: string; page: OcrPage }[] = [];
  try {
    const todo: PageItem[] = [];
    for (const p of candidates) {
      const doc = s.docs[p.src];
      if (doc && (await Promise.race([isScanned(doc, p), stopped]))) todo.push(p);
    }
    if (!todo.length) {
      const one = pageIds?.length === 1;
      if (already) toast(one ? 'Text on this page is already recognized' : 'Text is already recognized on every scanned page');
      else toast(one ? 'This page already has text' : 'No scanned pages found: every page already has text');
      return;
    }
    setJob({ pages: todo.map((p) => p.id), phase: 'starting' });
    const { worker, langs } = await Promise.race([getEngine(), stopped]);
    let shown = -1;
    onProgress = (p) => {
      // Re-render at most every whole percent.
      const pct = Math.floor(p * 100);
      if (pct !== shown) {
        shown = pct;
        setJob({ progress: p });
      }
    };
    for (const [i, p] of todo.entries()) {
      shown = -1;
      setJob({ done: i, progress: 0, phase: 'recognizing' });
      const doc = get().docs[p.src];
      if (!doc) continue; // closed in the meantime
      const page = await Promise.race([recognizePage(worker, langs, doc, p), stopped]);
      results.push({ key: ocrKey(p), src: p.src, page });
    }
  } catch (e) {
    if (!(e instanceof Cancelled)) {
      console.error(e);
      toast(`Text recognition failed: ${(e as Error).message ?? e}`, 'error');
      stopEngine();
    }
  } finally {
    onProgress = null;
    cancelJob = null;
    useOcr.setState({ job: null });
    if (engine) idle = setTimeout(stopEngine, IDLE_MS);
    finish(results, cancelled);
  }
}

function finish(results: { key: string; src: string; page: OcrPage }[], cancelled: boolean) {
  const s = get();
  const kept = results.filter((r) => s.docs[r.src]);
  if (!kept.length) return;
  commit((st) => ({ ocr: { ...st.ocr, ...Object.fromEntries(kept.map((r) => [r.key, r.page])) } }));
  const words = kept.reduce((n, r) => n + ocrWordCount(r.page), 0);
  const pages = plural(kept.length, 'page');
  if (cancelled) toast(`Stopped. Text recognized on ${pages} so far`, 'info');
  else if (!words) toast(`No text found on ${kept.length === 1 ? 'the page' : `the ${pages}`}`, 'info');
  else toast(`Recognized ${plural(words, 'word')} on ${pages}`, 'success');
  // Whatever is being searched for may now be found on the scans too.
  if (s.search.query.trim()) void runSearch(s.search.query);
}

/** Stops recognition; pages finished so far are kept. */
export function cancelRecognition() {
  if (!cancelJob) return;
  cancelJob();
  // Terminating the worker is the only way to interrupt the page in progress.
  stopEngine();
}
