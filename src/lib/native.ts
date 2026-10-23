/**
 * Desktop (Tauri) integration. Everything here is a no-op in the browser; the
 * Tauri modules are imported lazily so the web build doesn't depend on them.
 */

export const isDesktop = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** A file on disk, as opposed to a browser FileSystemFileHandle. */
export interface PathRef {
  path: string;
  name: string;
}

export function baseNameOf(path: string) {
  return path.split(/[\\/]/).pop() || path;
}

const core = () => import('@tauri-apps/api/core');
const dialog = () => import('@tauri-apps/plugin-dialog');

export async function readPath(path: string): Promise<File> {
  const { invoke } = await core();
  const buf = await invoke<ArrayBuffer>('read_file', { path });
  const name = baseNameOf(path);
  return new File([buf], name, { type: /\.pdf$/i.test(name) ? 'application/pdf' : guessType(name) });
}

export async function writePath(path: string, bytes: Uint8Array) {
  const { invoke } = await core();
  const hex = [...new TextEncoder().encode(path)].map((b) => b.toString(16).padStart(2, '0')).join('');
  await invoke('write_file', bytes, { headers: { 'x-path': hex } });
}

function guessType(name: string) {
  const ext = name.split('.').pop()?.toLowerCase();
  return ext === 'png' ? 'image/png' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : '';
}

const FILTERS = {
  pdf: [{ name: 'PDF document', extensions: ['pdf'] }],
  image: [{ name: 'Image', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
};

export async function chooseFiles(kind: 'pdf' | 'image', multiple: boolean): Promise<{ file: File; ref: PathRef }[]> {
  const { open } = await dialog();
  const picked = await open({ multiple, directory: false, filters: FILTERS[kind] });
  const paths = picked === null ? [] : Array.isArray(picked) ? picked : [picked];
  return Promise.all(paths.map(async (path) => ({ file: await readPath(path), ref: { path, name: baseNameOf(path) } })));
}

export async function chooseSavePath(suggested: string): Promise<string | null> {
  const { save } = await dialog();
  const ext = suggested.split('.').pop()?.toLowerCase() ?? 'pdf';
  const filters = ext === 'pdf' ? FILTERS.pdf : [{ name: ext.toUpperCase(), extensions: [ext === 'jpg' ? 'jpg' : ext] }];
  return save({ defaultPath: suggested, filters });
}

/** A yes/no question with a custom confirm button. */
export async function askConfirm(message: string, okLabel: string): Promise<boolean> {
  if (!isDesktop) return window.confirm(message);
  const { ask } = await dialog();
  return ask(message, { title: 'Folio', kind: 'warning', okLabel, cancelLabel: 'Cancel' });
}

export async function askDiscard(): Promise<boolean> {
  const { ask } = await dialog();
  return ask('You have unsaved changes. Discard them?', { title: 'Folio', kind: 'warning', okLabel: 'Discard', cancelLabel: 'Cancel' });
}

export async function openExternal(url: string) {
  if (!isDesktop) {
    window.open(url, '_blank', 'noopener');
    return;
  }
  const { openUrl } = await import('@tauri-apps/plugin-opener');
  await openUrl(url);
}

export async function startupFiles(): Promise<string[]> {
  const { invoke } = await core();
  return invoke<string[]>('startup_files');
}

export async function onOpenFiles(handler: (paths: string[]) => void) {
  const { listen } = await import('@tauri-apps/api/event');
  return listen<string[]>('open-files', (e) => handler(e.payload));
}

export async function setWindowTitle(title: string) {
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  await getCurrentWindow().setTitle(title);
}

/** Asks before closing the window with unsaved changes. */
export async function guardClose(isDirty: () => boolean) {
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  return getCurrentWindow().onCloseRequested(async (event) => {
    if (isDirty() && !(await askDiscard())) event.preventDefault();
  });
}
