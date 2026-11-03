/**
 * Autosave and crash recovery. A couple of seconds after a change, every tab
 * with unsaved changes is written to this device: the app data folder in the
 * desktop app, IndexedDB in the browser. A tab's source PDFs are written once,
 * then its pages, objects, properties and form values each time they change.
 * Saving or closing a document deletes its copy, and so does closing the
 * window; whatever is left at the next launch belonged to a session that
 * crashed or was killed, and Folio offers to bring it back. Nothing is ever
 * sent anywhere.
 */
import { create } from 'zustand';
import type { SourceDoc } from '../types';
import { actions, openSource, openTab, snap, tabState, toast, useStore, type DocState, type Snapshot } from '../store';
import type { FileRef } from './files';
import { idb } from './idb';
import { dataList, dataRead, dataRemove, dataWrite, isDesktop } from './native';
import { PasswordCancelled } from './pdfjs';
import { uid } from './util';

export interface RecoveryRecord {
  v: 1;
  /** The tab's id; a restored tab keeps it, and with it these files. */
  id: string;
  /** The Folio session that owns the record. */
  owner: string;
  savedAt: number;
  fileName: string;
  fileHandle: FileRef | null;
  /** Pages, objects, properties: everything undo covers. */
  doc: Snapshot;
  /** The source PDFs the pages come from. Passwords are never stored; encrypted files ask again. */
  sources: { id: string; name: string }[];
  /** Form field values typed into each source, by pdf.js annotation id. */
  forms: Record<string, Record<string, unknown>>;
}

interface Backend {
  list(): Promise<RecoveryRecord[]>;
  put(r: RecoveryRecord): Promise<void>;
  putSource(tab: string, doc: string, bytes: Uint8Array): Promise<void>;
  source(tab: string, doc: string): Promise<Uint8Array | null>;
  /** Deletes a tab's record and its sources. */
  remove(tab: string): Promise<void>;
  /** Deletes sources whose record is gone (left by a crash between the two writes). */
  sweep(): Promise<void>;
}

const DIR = 'recovery';

/** Desktop: `recovery/<tab>.json` plus `recovery/<tab>.<source>.pdf` in the app data folder. */
const files: Backend = {
  async list() {
    const out: RecoveryRecord[] = [];
    for (const name of await dataList(DIR)) {
      if (!name.endsWith('.json')) continue;
      const bytes = await dataRead(`${DIR}/${name}`);
      try {
        if (bytes) out.push(JSON.parse(new TextDecoder().decode(bytes)));
      } catch {
        /* unreadable; ignored */
      }
    }
    return out;
  },
  put: (r) => dataWrite(`${DIR}/${r.id}.json`, new TextEncoder().encode(JSON.stringify(r))),
  putSource: (tab, doc, bytes) => dataWrite(`${DIR}/${tab}.${doc}.pdf`, bytes),
  source: (tab, doc) => dataRead(`${DIR}/${tab}.${doc}.pdf`),
  async remove(tab) {
    await dataRemove(`${DIR}/${tab}.json`);
    for (const name of await dataList(DIR)) if (name.startsWith(`${tab}.`)) await dataRemove(`${DIR}/${name}`);
  },
  async sweep() {
    const names = await dataList(DIR);
    const tabs = new Set(names.filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)));
    for (const name of names) if (!tabs.has(name.split('.')[0])) await dataRemove(`${DIR}/${name}`);
  },
};

/** Browser: `recovery:<tab>` records and `recovery-src:<tab>:<source>` bytes in IndexedDB. */
const browser: Backend = {
  async list() {
    const keys = (await idb.keys()).filter((k) => k.startsWith('recovery:'));
    const out: RecoveryRecord[] = [];
    for (const k of keys) {
      const r = await idb.get<RecoveryRecord>(k);
      if (r) out.push(r);
    }
    return out;
  },
  put: (r) => idb.set(`recovery:${r.id}`, r),
  putSource: (tab, doc, bytes) => idb.set(`recovery-src:${tab}:${doc}`, bytes),
  source: async (tab, doc) => (await idb.get<Uint8Array>(`recovery-src:${tab}:${doc}`)) ?? null,
  async remove(tab) {
    await idb.del(`recovery:${tab}`);
    for (const k of await idb.keys()) if (k.startsWith(`recovery-src:${tab}:`)) await idb.del(k);
  },
  async sweep() {
    const keys = await idb.keys();
    const tabs = new Set(keys.filter((k) => k.startsWith('recovery:')).map((k) => k.slice('recovery:'.length)));
    for (const k of keys) if (k.startsWith('recovery-src:') && !tabs.has(k.split(':')[1])) await idb.del(k);
  },
};

const backend = isDesktop ? files : browser;

/* ------------------------------------------------------------------ */
/* Sessions                                                            */
/* ------------------------------------------------------------------ */

/*
 * Each running Folio holds a Web Lock named after its session for as long as
 * it's open, so records whose owner holds no lock were left behind. (Several
 * browser tabs can run Folio at once; each only ever offers orphans.)
 */
const SESSION = uid();
const LOCK = 'folio-session:';

function holdSession() {
  navigator.locks?.request(LOCK + SESSION, () => new Promise<never>(() => {})).catch(() => {});
}

async function liveSessions(): Promise<Set<string>> {
  try {
    const { held = [] } = (await navigator.locks?.query()) ?? {};
    return new Set(held.map((l) => l.name ?? '').filter((n) => n.startsWith(LOCK)).map((n) => n.slice(LOCK.length)));
  } catch {
    return new Set();
  }
}

/** Takes over records whose session is gone, so no other window offers them too. */
async function claimOrphans(): Promise<RecoveryRecord[]> {
  const work = async () => {
    const live = await liveSessions();
    const orphans = (await backend.list()).filter((r) => r.owner !== SESSION && !live.has(r.owner));
    const claimed: RecoveryRecord[] = [];
    for (const r of orphans) {
      const mine = { ...r, owner: SESSION };
      await backend.put(mine);
      claimed.push(mine);
    }
    if (![...live].some((s) => s !== SESSION)) await backend.sweep();
    return claimed.sort((a, b) => a.savedAt - b.savedAt);
  };
  return navigator.locks ? navigator.locks.request('folio-recovery', work) : work();
}

/* ------------------------------------------------------------------ */
/* Autosave                                                            */
/* ------------------------------------------------------------------ */

/** What's on disk for each tab, to skip writes when nothing changed. */
interface Written {
  doc: Snapshot;
  fileName: string;
  fileHandle: FileRef | null;
  forms: string;
  sources: Set<string>;
}

const written = new Map<string, Written>();
let chain: Promise<unknown> = Promise.resolve();
let timer = 0;
let closing = false;

/** Runs storage work one piece at a time. */
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const p = chain.then(fn);
  chain = p.catch((e) => console.warn('Autosave failed', e));
  return p;
}

function schedule(delay: number) {
  if (timer || closing) return;
  timer = window.setTimeout(() => {
    timer = 0;
    void serial(autosave);
  }, delay);
}

const unchanged = (a: Snapshot, b: Snapshot) => (Object.keys(b) as (keyof Snapshot)[]).every((k) => a[k] === b[k]);

function usedSources(d: DocState) {
  return [...new Set(d.pages.map((p) => p.src))].filter((id) => d.docs[id]);
}

function formValues(docs: SourceDoc[]) {
  const out: Record<string, Record<string, unknown>> = {};
  for (const doc of docs) if (doc.pdf.annotationStorage.size) out[doc.id] = Object.fromEntries(doc.pdf.annotationStorage);
  return out;
}

async function forget(id: string) {
  written.delete(id);
  await backend.remove(id);
}

async function autosave() {
  const { tabs } = actions.get();
  const open = new Set(tabs.map((t) => t.id));
  for (const id of [...written.keys()]) if (!open.has(id)) await forget(id);
  for (const { id } of tabs) {
    if (closing) return;
    const d = tabState(id);
    if (!d) continue;
    if (!d.dirty) {
      if (written.has(id)) await forget(id);
      continue;
    }
    // Mid-drag states aren't worth keeping; the gesture's end is.
    if (d.gestureBase || !d.pages.length) continue;
    const used = usedSources(d);
    let forms: RecoveryRecord['forms'] = {};
    let formsKey = '';
    try {
      forms = formValues(used.map((s) => d.docs[s]));
      formsKey = JSON.stringify(forms);
    } catch {
      forms = {};
    }
    const doc = snap(d);
    const w = written.get(id);
    if (w && unchanged(w.doc, doc) && w.fileName === d.fileName && w.fileHandle === d.fileHandle && w.forms === formsKey) continue;
    const sources = new Set(w?.sources);
    for (const src of used) {
      if (sources.has(src)) continue;
      await backend.putSource(id, src, d.docs[src].bytes);
      sources.add(src);
    }
    await backend.put({
      v: 1,
      id,
      owner: SESSION,
      savedAt: Date.now(),
      fileName: d.fileName,
      fileHandle: d.fileHandle,
      doc,
      sources: used.map((s) => ({ id: s, name: d.docs[s].name })),
      forms,
    });
    written.set(id, { doc, fileName: d.fileName, fileHandle: d.fileHandle, forms: formsKey, sources });
  }
}

/** Brings the autosaves up to date now, e.g. before an update closes the app from outside. */
export function flushAutosave() {
  clearTimeout(timer);
  timer = 0;
  return serial(autosave);
}

/** Clean exit: the user saved or chose to discard, so nothing needs recovering. */
export async function endSession() {
  closing = true;
  clearTimeout(timer);
  await chain;
  for (const id of [...written.keys()]) await forget(id).catch(() => {});
}

/* ------------------------------------------------------------------ */
/* Restoring                                                           */
/* ------------------------------------------------------------------ */

/** Documents a previous session left behind, waiting for the user to restore or discard them. */
export const useRecovery = create<{ found: RecoveryRecord[] }>(() => ({ found: [] }));

let started = false;

/** Starts autosaving and looks for documents to recover. Call once at startup. */
export async function startRecovery() {
  if (started) return;
  started = true;
  holdSession();
  useStore.subscribe((s, prev) => {
    if (s.tabs !== prev.tabs || s.dirty !== prev.dirty || s.fileName !== prev.fileName || !unchanged(snap(prev), snap(s))) schedule(2000);
  });
  // Form typing only marks the document dirty once; pick up later keystrokes too.
  window.setInterval(() => schedule(0), 5000);
  try {
    const found = await serial(claimOrphans);
    if (found.length) useRecovery.setState({ found });
  } catch (e) {
    console.warn('Recovery check failed', e);
  }
}

export async function discardRecovered() {
  const { found } = useRecovery.getState();
  useRecovery.setState({ found: [] });
  await serial(async () => {
    for (const r of found) await backend.remove(r.id);
  });
}

export async function restoreRecovered() {
  const { found } = useRecovery.getState();
  useRecovery.setState({ found: [] });
  let restored = 0;
  for (const r of found) {
    try {
      actions.set({ busy: `Restoring ${r.fileName}…` });
      const docs: Record<string, SourceDoc> = {};
      for (const src of r.sources) {
        const bytes = await backend.source(r.id, src.id);
        if (!bytes) throw new Error(`the copy of ${src.name} is missing`);
        actions.set({ busy: null });
        const { doc } = await openSource(bytes, src.name);
        actions.set({ busy: `Restoring ${r.fileName}…` });
        // Pages refer to their source by id, so it keeps the one it had.
        doc.id = src.id;
        for (const [key, value] of Object.entries(r.forms[src.id] ?? {})) doc.pdf.annotationStorage.setValue(key, value as object);
        docs[src.id] = doc;
      }
      openTab({ ...r.doc, docs, fileName: r.fileName, fileHandle: r.fileHandle, dirty: true }, r.id);
      const d = tabState(r.id)!;
      written.set(r.id, {
        doc: snap(d),
        fileName: d.fileName,
        fileHandle: d.fileHandle,
        forms: JSON.stringify(formValues(Object.values(docs))),
        sources: new Set(r.sources.map((s) => s.id)),
      });
      restored++;
    } catch (e) {
      if (e instanceof PasswordCancelled) toast(`${r.fileName} was not restored`, 'info');
      else toast(`Couldn't restore ${r.fileName}: ${(e as Error).message}`, 'error');
      // Left on disk: it'll be offered again next time.
    } finally {
      actions.set({ busy: null });
    }
  }
  if (restored) toast(`Restored ${restored} document${restored === 1 ? '' : 's'}`, 'success');
}
