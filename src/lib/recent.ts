/**
 * Recently opened files. The desktop app keeps their paths in the app data
 * folder and hides the ones that no longer exist; the browser keeps
 * FileSystemFileHandles in IndexedDB and asks for permission again when one
 * is reopened. Files opened without a handle (an old-style upload) can't be
 * reopened, so they aren't listed.
 */
import { create } from 'zustand';
import { useStore } from '../store';
import { isPathRef, type FileRef } from './files';
import { idb } from './idb';
import { dataRead, dataWrite, isDesktop, pathsExist } from './native';
import { uid } from './util';

export interface RecentFile {
  id: string;
  name: string;
  openedAt: number;
  /** Desktop. */
  path?: string;
  /** Browser. */
  handle?: FileSystemFileHandle;
  /** Desktop: the file was moved or deleted since. */
  missing?: boolean;
}

const MAX = 12;
const FILE = 'recent.json';

export const useRecent = create<{ items: RecentFile[] }>(() => ({ items: [] }));

/** The entries worth showing. */
export const visibleRecent = (items: RecentFile[]) => items.filter((i) => !i.missing);

let chain: Promise<unknown> = Promise.resolve();
function serial(fn: () => Promise<void>) {
  chain = chain.then(fn).catch((e) => console.warn('Recent files:', e));
  return chain;
}

async function persist(items: RecentFile[]) {
  const plain = items.map(({ missing: _missing, ...r }) => r);
  if (isDesktop) await dataWrite(FILE, new TextEncoder().encode(JSON.stringify(plain)));
  else await idb.set('recent', plain);
}

async function read(): Promise<RecentFile[]> {
  if (isDesktop) {
    const bytes = await dataRead(FILE);
    return bytes ? JSON.parse(new TextDecoder().decode(bytes)) : [];
  }
  return (await idb.get<RecentFile[]>('recent')) ?? [];
}

/** Loads the list (again), checking which desktop files still exist. */
export function loadRecent() {
  return serial(async () => {
    let items = await read().catch(() => [] as RecentFile[]);
    if (isDesktop && items.length) {
      const exist = await pathsExist(items.map((i) => i.path ?? ''));
      items = items.map((it, k) => ({ ...it, missing: !exist[k] }));
    }
    useRecent.setState({ items });
  });
}

async function same(item: RecentFile, ref: FileRef) {
  if (isPathRef(ref)) return item.path?.toLowerCase() === ref.path.toLowerCase();
  return !!item.handle && (await item.handle.isSameEntry(ref).catch(() => false));
}

export function noteRecent(ref: FileRef, name: string) {
  return serial(async () => {
    const cur = useRecent.getState().items;
    const dupes = await Promise.all(cur.map((i) => same(i, ref)));
    const entry: RecentFile = { id: uid(), name, openedAt: Date.now(), ...(isPathRef(ref) ? { path: ref.path } : { handle: ref }) };
    const items = [entry, ...cur.filter((_, k) => !dupes[k])].slice(0, MAX);
    useRecent.setState({ items });
    await persist(items);
  });
}

export function removeRecent(id: string) {
  return serial(async () => {
    const items = useRecent.getState().items.filter((i) => i.id !== id);
    useRecent.setState({ items });
    await persist(items);
  });
}

export function clearRecent() {
  return serial(async () => {
    useRecent.setState({ items: [] });
    await persist([]);
  });
}

let started = false;

/** Loads the list and notes every file opened or saved under a new name from now on. */
export function startRecent() {
  if (started) return;
  started = true;
  void loadRecent();
  useStore.subscribe((s, prev) => {
    if (!s.fileHandle || s.fileHandle === prev.fileHandle) return;
    // Switching to an existing tab changes the file too; only a new tab or a new file counts.
    const newTab = s.activeTab !== prev.activeTab && !prev.tabs.some((t) => t.id === s.activeTab);
    if (s.activeTab === prev.activeTab || newTab) void noteRecent(s.fileHandle, s.fileName);
  });
}
