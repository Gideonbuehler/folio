/**
 * Updates for the desktop app (tauri-plugin-updater). Each release on GitHub
 * carries a signed installer and a latest.json that the app checks; see
 * "Releases" in the README. Folio never installs over unsaved work: it asks to
 * save first, or waits for the next start.
 */
import { create } from 'zustand';
import type { Update } from '@tauri-apps/plugin-updater';
import { actions, anyDirty, tabState, toast } from '../store';
import { isPathRef } from './files';
import { isDesktop } from './native';
import { flushAutosave } from './recovery';
import { openPaths, saveAllTabs } from './commands';

export const APP_VERSION = __APP_VERSION__;

/** The version the user chose to install when Folio next starts. */
const PENDING = 'folio.update.onStart';
/** Documents that were open when an update closed the app, to reopen after it. */
const REOPEN = 'folio.update.reopen';

export const useUpdates = create<{ update: Update | null; checking: boolean; pending: string | null }>(() => ({
  update: null,
  checking: false,
  pending: stored(PENDING),
}));

function stored(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function remember(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: the choice just isn't kept */
  }
}

function message(e: unknown) {
  const text = String((e as Error)?.message ?? e);
  return /valid release JSON/i.test(text) ? 'no release was found' : text;
}

async function find() {
  const { check } = await import('@tauri-apps/plugin-updater');
  const update = await check({ timeout: 30_000 });
  useUpdates.setState({ update });
  return update;
}

/**
 * At startup: reopens what an update closed, installs an update the user put
 * off until now, and otherwise checks quietly. A found update only shows as a
 * button in the header; nothing pops up.
 */
export async function startUpdates() {
  if (!isDesktop) return;
  const reopen = stored(REOPEN);
  if (reopen) {
    remember(REOPEN, null);
    try {
      await openPaths(JSON.parse(reopen) as string[]);
    } catch {
      /* a bad list only means nothing to reopen */
    }
  }
  if (import.meta.env.DEV) return;
  const pending = stored(PENDING);
  // Let the window open its documents before going to the network.
  if (!pending) await new Promise((r) => setTimeout(r, 5000));
  let update: Update | null;
  try {
    update = await find();
  } catch (e) {
    console.warn('Update check failed:', e);
    return;
  }
  if (!update) {
    remember(PENDING, null);
    useUpdates.setState({ pending: null });
    return;
  }
  if (pending && !anyDirty()) await install(update);
}

/** File > Check for updates: says what it found. */
export async function checkForUpdates() {
  if (!isDesktop || useUpdates.getState().checking || actions.get().busy) return;
  useUpdates.setState({ checking: true });
  actions.set({ busy: 'Checking for updates…' });
  try {
    const update = await find();
    actions.set({ busy: null });
    if (update) actions.set({ dialog: { kind: 'update' } });
    else toast(`Folio ${APP_VERSION} is the latest version`, 'success');
  } catch (e) {
    toast(`Couldn't check for updates: ${message(e)}`, 'error');
  } finally {
    useUpdates.setState({ checking: false });
    actions.set({ busy: null });
  }
}

/** Installs now, saving every document with unsaved changes first; stops if one isn't saved. */
export async function saveAndInstall() {
  const { update } = useUpdates.getState();
  if (!update) return;
  actions.set({ dialog: null });
  if (anyDirty() && !(await saveAllTabs())) {
    toast('The update was not installed because a document was not saved.', 'info');
    return;
  }
  await install(update);
}

export function installOnNextStart() {
  const { update } = useUpdates.getState();
  if (!update) return;
  remember(PENDING, update.version);
  useUpdates.setState({ pending: update.version });
  actions.set({ dialog: null });
  toast(`Folio ${update.version} will be installed the next time you start Folio.`, 'success');
}

/**
 * Downloads and verifies the update, then runs its installer, which closes
 * Folio and starts it again; the documents that were open are reopened then.
 */
async function install(update: Update) {
  const label = `Downloading Folio ${update.version}…`;
  actions.set({ busy: label });
  try {
    let total = 0;
    let got = 0;
    await update.download((e) => {
      if (e.event === 'Started') total = e.data.contentLength ?? 0;
      else if (e.event === 'Progress') {
        got += e.data.chunkLength;
        if (total) actions.set({ busy: `${label} ${Math.min(99, Math.round((got / total) * 100))}%` });
      }
    });
    actions.set({ busy: `Installing Folio ${update.version}…` });
    // Nothing is unsaved by now; this clears the autosaves so the next start doesn't offer them.
    await flushAutosave();
    const s = actions.get();
    const paths = s.tabs.map((t) => tabState(t.id)?.fileHandle).flatMap((h) => (isPathRef(h) ? [h.path] : []));
    const active = tabState(s.activeTab)?.fileHandle;
    // The active document last, so it's the one showing after the restart.
    if (isPathRef(active)) paths.push(...paths.splice(paths.indexOf(active.path), 1));
    remember(REOPEN, paths.length ? JSON.stringify(paths) : null);
    remember(PENDING, null);
    await update.install();
  } catch (e) {
    remember(REOPEN, null);
    actions.set({ busy: null });
    toast(`Couldn't install the update: ${message(e)}`, 'error');
  }
}
