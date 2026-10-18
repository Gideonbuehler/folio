/**
 * File open/save. In the desktop app this uses native dialogs and writes
 * straight to disk. In the browser it uses the File System Access API where
 * available, so Ctrl+S writes back to the opened file, and falls back to
 * <input type=file> and downloads elsewhere.
 */
import { chooseFiles, chooseSavePath, isDesktop, writePath, baseNameOf, type PathRef } from './native';

type Handle = FileSystemFileHandle;

/** Where a document lives: a desktop path or a browser file handle. */
export type FileRef = PathRef | Handle;

export const isPathRef = (r: FileRef | null | undefined): r is PathRef => !!r && 'path' in r;

interface PickerWindow {
  showOpenFilePicker?: (opts: unknown) => Promise<Handle[]>;
  showSaveFilePicker?: (opts: unknown) => Promise<Handle>;
}

const w = window as unknown as PickerWindow;
export const canSaveInPlace = isDesktop || typeof w.showSaveFilePicker === 'function';

const PDF_TYPES = [{ description: 'PDF document', accept: { 'application/pdf': ['.pdf'] } }];

export interface Picked {
  file: File;
  handle: FileRef | null;
}

export async function pickFiles(opts: { multiple?: boolean; accept?: 'pdf' | 'image' } = {}): Promise<Picked[]> {
  const accept = opts.accept ?? 'pdf';
  if (isDesktop) {
    const chosen = await chooseFiles(accept, !!opts.multiple);
    return chosen.map((c) => ({ file: c.file, handle: c.ref }));
  }
  if (w.showOpenFilePicker && accept === 'pdf') {
    try {
      const handles = await w.showOpenFilePicker({ multiple: !!opts.multiple, types: PDF_TYPES });
      return Promise.all(handles.map(async (h) => ({ file: await h.getFile(), handle: h })));
    } catch (e) {
      if ((e as Error).name === 'AbortError') return [];
      // Fall through to the input element (e.g. in sandboxed frames).
    }
  }
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = !!opts.multiple;
    input.accept = accept === 'pdf' ? 'application/pdf,.pdf' : 'image/png,image/jpeg,image/webp,image/gif,image/svg+xml';
    input.onchange = () => resolve(Array.from(input.files ?? []).map((file) => ({ file, handle: null })));
    input.oncancel = () => resolve([]);
    input.click();
  });
}

/** Writes bytes to `handle`, or asks where to save. Returns where it went. */
export async function saveBytes(
  bytes: Uint8Array,
  name: string,
  handle: FileRef | null,
  forcePicker: boolean,
): Promise<{ handle: FileRef | null; name: string } | null> {
  if (isDesktop) {
    const path = !forcePicker && isPathRef(handle) ? handle.path : await chooseSavePath(isPathRef(handle) ? handle.path : name);
    if (!path) return null;
    await writePath(path, bytes);
    return { handle: { path, name: baseNameOf(path) }, name: baseNameOf(path) };
  }
  if (w.showSaveFilePicker) {
    try {
      let h = forcePicker || isPathRef(handle) ? null : handle;
      if (h) {
        const perm = await (h as unknown as { requestPermission?: (o: unknown) => Promise<string> }).requestPermission?.({
          mode: 'readwrite',
        });
        if (perm && perm !== 'granted') h = null;
      }
      h ??= await w.showSaveFilePicker({ suggestedName: name, types: PDF_TYPES });
      const writable = await h.createWritable();
      await writable.write(bytes as unknown as ArrayBuffer);
      await writable.close();
      return { handle: h, name: h.name };
    } catch (e) {
      if ((e as Error).name === 'AbortError') return null;
      console.warn('Save via File System Access failed, downloading instead', e);
    }
  }
  download(new Blob([bytes as BlobPart], { type: 'application/pdf' }), name);
  return { handle: null, name };
}

/** Saves a generated file (images, ZIPs): a save dialog in the app, a download in the browser. */
export async function download(blob: Blob, name: string) {
  if (isDesktop) {
    const path = await chooseSavePath(name);
    if (path) await writePath(path, new Uint8Array(await blob.arrayBuffer()));
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
