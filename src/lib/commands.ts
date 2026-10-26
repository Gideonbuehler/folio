import { zipSync } from 'fflate';
import { actions, closeTab, findTab, insertDocuments, openDocuments, patchTab, switchTab, tabState, toast } from '../store';
import { download, pickFiles, saveBytes, type Picked } from './files';
import { pdfjs } from './pdfjs';
import { baseName, formatBytes, readFileDataUrl } from './util';
import { insertImageFile } from './images';
import { askConfirm, askDiscard, baseNameOf, isDesktop, pathsExist, readPath } from './native';
import { useSignatures } from './signatures';
import { removeRecent, type RecentFile } from './recent';
import type { ExportOptions } from './export';

const { get, set } = actions;

export async function confirmDiscard() {
  if (!get().dirty) return true;
  return isDesktop ? askDiscard() : window.confirm('You have unsaved changes. Discard them?');
}

/** Opens each file in its own tab, or switches to it if it's already open. */
export async function openFiles(picked: Picked[]) {
  for (const p of picked) {
    const open = p.handle ? await findTab(p.handle) : null;
    if (open) switchTab(open);
    else await openDocuments([p]);
  }
}

export async function openPdf() {
  const picked = await pickFiles({ multiple: true });
  if (picked.length) await openFiles(picked);
}

export async function combinePdfs() {
  const picked = await pickFiles({ multiple: true });
  if (picked.length) await openDocuments(picked);
}

export async function newBlankDocument() {
  const { PDFDocument } = await import('@cantoo/pdf-lib');
  const d = await PDFDocument.create();
  d.addPage([612, 792]);
  const bytes = await d.save();
  const file = new File([bytes as BlobPart], 'Untitled.pdf', { type: 'application/pdf' });
  if (await openDocuments([{ file, handle: null }])) set({ dirty: true });
}

/** Asks what to do with a tab's unsaved changes before it closes. */
function askUnsaved(name: string) {
  return new Promise<'save' | 'discard' | 'cancel'>((resolve) =>
    set({
      dialog: {
        kind: 'unsaved',
        name,
        resolve: (choice) => {
          set({ dialog: null });
          resolve(choice);
        },
      },
    }),
  );
}

/** Closes tabs, asking about each one with unsaved changes. Returns false if the user cancelled. */
export async function closeTabs(ids: string[]) {
  const back = get().activeTab;
  for (const id of ids) {
    const doc = tabState(id);
    if (!doc) continue;
    if (doc.dirty) {
      switchTab(id);
      const choice = await askUnsaved(doc.fileName);
      if (choice === 'cancel') return false;
      if (choice === 'save') {
        await saveDocument();
        if (tabState(id)?.dirty) return false;
      }
    }
    closeTab(id);
  }
  if (back && tabState(back)) switchTab(back);
  return true;
}

export async function closeDoc() {
  const id = get().activeTab;
  if (id) await closeTabs([id]);
}

/** Opens files by path (desktop: launch arguments, double-clicked PDFs), each in its own tab. */
export async function openPaths(paths: string[]) {
  for (const path of paths) {
    try {
      const handle = { path, name: baseNameOf(path) };
      const open = await findTab(handle);
      if (open) switchTab(open);
      else await openDocuments([{ file: await readPath(path), handle }]);
    } catch (e) {
      toast(`Couldn't open ${baseNameOf(path)}: ${(e as Error).message ?? e}`, 'error');
    }
  }
}

/** Reopens a recent file; in the browser, permission to read it may need granting again. */
export async function openRecent(item: RecentFile) {
  try {
    if (item.path) {
      const [exists] = await pathsExist([item.path]);
      if (!exists) throw new Error('it was moved or deleted');
      await openPaths([item.path]);
      return;
    }
    const h = item.handle as (FileSystemFileHandle & PermissionMethods) | undefined;
    if (!h) return;
    if ((await h.queryPermission?.({ mode: 'read' })) !== 'granted' && (await h.requestPermission?.({ mode: 'read' })) !== 'granted') return;
    await openFiles([{ file: await h.getFile(), handle: h }]);
  } catch (e) {
    const gone = /moved or deleted/.test((e as Error).message) || (e as Error).name === 'NotFoundError';
    toast(gone ? `${item.name} was moved or deleted` : `Couldn't open ${item.name}: ${(e as Error).message}`, 'error');
    if (gone) void removeRecent(item.id);
  }
}

interface PermissionMethods {
  queryPermission?: (o: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
  requestPermission?: (o: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
}

export async function insertPdfPages(at = get().currentPage + 1) {
  const picked = await pickFiles({ multiple: true });
  if (picked.length) await insertDocuments(picked, at);
}

export async function pickAndInsertImage() {
  const picked = await pickFiles({ accept: 'image' });
  for (const p of picked) await insertImageFile(p.file);
}

async function build(opts: ExportOptions = {}) {
  const s = get();
  const { buildPdf } = await import('./export');
  return buildPdf(
    { docs: s.docs, pages: s.pages, objects: s.objects, meta: s.meta, ocr: s.ocr },
    { ...opts, onProgress: (t) => set({ busy: t }) },
  );
}

function pdfName(name: string) {
  return /\.pdf$/i.test(name) ? name : `${name || 'Document'}.pdf`;
}

/** The single source document, if the open document is exactly that file, unchanged. */
export function untouchedDoc() {
  const s = get();
  const src = s.pages[0]?.src;
  const doc = src ? s.docs[src] : undefined;
  if (!doc || s.objects.length || s.pages.length !== doc.pdf.numPages || doc.pdf.annotationStorage.size > 0) return null;
  return s.pages.every((p, i) => p.src === src && p.index === i && p.rotation === 0) ? doc : null;
}

function signatureCount() {
  const s = get();
  const byDoc = useSignatures.getState().byDoc;
  return [...new Set(s.pages.map((p) => p.src))].reduce((n, id) => n + (byDoc[id]?.length ?? 0), 0);
}

export async function saveDocument(opts: { saveAs?: boolean; copy?: boolean; name?: string } & ExportOptions = {}) {
  const s = get();
  if (!s.pages.length || s.busy) return;
  if (s.editing) set({ editing: null });
  // The save dialog may be up a while; the result belongs to this tab whichever is active by then.
  const tab = s.activeTab;
  const plain = !opts.flattenForms && !opts.flattenComments && !opts.reduce && !opts.userPassword && !opts.ownerPassword && !opts.pageIds;
  const signed = signatureCount();
  const keep = signed > 0 && plain ? untouchedDoc() : null;
  if (signed && !keep) {
    const ok = await askConfirm(
      `This document is digitally signed. Saving ${plain ? 'your changes' : 'with these options'} rewrites it, so the signature${signed === 1 ? '' : 's'} will be removed. Save anyway?`,
      'Save',
    );
    if (!ok) return;
  }
  set({ busy: 'Saving…' });
  try {
    // An unchanged signed file is saved byte for byte, so its signatures stay valid.
    const res = keep ? { bytes: keep.bytes, warnings: [] as string[], reduced: undefined } : await build(opts);
    set({ busy: null });
    const name = pdfName(opts.name ?? s.fileName);
    const forcePicker = !!opts.saveAs || !!opts.copy || !s.fileHandle;
    const out = await saveBytes(res.bytes, name, opts.copy ? null : s.fileHandle, forcePicker);
    if (!out) return;
    if (!opts.copy) patchTab(tab, { dirty: false, fileHandle: out.handle ?? s.fileHandle, fileName: out.name });
    if (opts.reduce) toast(reductionReport(currentSize(), res.bytes.length, res.reduced?.images ?? 0), 'success');
    else toast(out.handle ? `Saved ${out.name}` : `Downloaded ${out.name}`, 'success');
    for (const w of res.warnings) toast(w, 'info');
  } catch (e) {
    console.error(e);
    toast(`Save failed: ${(e as Error).message}`, 'error');
  } finally {
    set({ busy: null });
  }
}

/** Size of the file(s) the document was opened from. */
export function currentSize() {
  const s = get();
  return [...new Set(s.pages.map((p) => p.src))].reduce((t, id) => t + (s.docs[id]?.bytes.length ?? 0), 0);
}

function reductionReport(before: number, after: number, images: number) {
  const pics = images ? ` · ${images} image${images === 1 ? '' : 's'} optimized` : '';
  if (after >= before) return `Saved at ${formatBytes(after)}: the file was already compact${pics}`;
  const pct = Math.round((1 - after / before) * 100);
  return `Reduced from ${formatBytes(before)} to ${formatBytes(after)} (−${pct}%)${pics}`;
}

export async function extractPages(pageIds: string[]) {
  const s = get();
  if (!pageIds.length) return;
  set({ busy: 'Extracting pages…' });
  try {
    const ordered = s.pages.filter((p) => pageIds.includes(p.id)).map((p) => p.id);
    const res = await build({ pageIds: ordered });
    set({ busy: null });
    const name = `${baseName(s.fileName)} (pages).pdf`;
    const out = await saveBytes(res.bytes, name, null, true);
    if (out) toast(`Extracted ${ordered.length} page${ordered.length === 1 ? '' : 's'}`, 'success');
  } catch (e) {
    toast(`Extract failed: ${(e as Error).message}`, 'error');
  } finally {
    set({ busy: null });
  }
}

/** Renders the finished document page by page (what you'd get after saving). */
async function renderOutput(
  scale: number,
  pageIds: string[] | undefined,
  onPage: (canvas: HTMLCanvasElement, index: number, total: number) => Promise<void>,
) {
  const res = await build(pageIds ? { pageIds } : {});
  const pdf = await pdfjs.getDocument({ data: res.bytes }).promise;
  try {
    for (let i = 1; i <= pdf.numPages; i++) {
      set({ busy: `Rendering page ${i} of ${pdf.numPages}…` });
      const page = await pdf.getPage(i);
      const vp = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      await page.render({ canvas, viewport: vp, intent: 'print' }).promise;
      await onPage(canvas, i - 1, pdf.numPages);
      canvas.width = canvas.height = 0;
    }
  } finally {
    void pdf.loadingTask.destroy();
  }
}

export async function exportImages(opts: { format: 'png' | 'jpeg'; dpi: number; pageIds?: string[] }) {
  const s = get();
  const stem = baseName(s.fileName) || 'Document';
  set({ busy: 'Preparing…' });
  try {
    const files: Record<string, Uint8Array> = {};
    let single: Blob | null = null;
    await renderOutput(opts.dpi / 72, opts.pageIds, async (canvas, i, total) => {
      const blob = await new Promise<Blob>((res, rej) =>
        canvas.toBlob((b) => (b ? res(b) : rej(new Error('Encoding failed'))), `image/${opts.format}`, 0.92),
      );
      if (total === 1) single = blob;
      else files[`${stem}-${String(i + 1).padStart(String(total).length, '0')}.${opts.format === 'jpeg' ? 'jpg' : 'png'}`] = new Uint8Array(await blob.arrayBuffer());
    });
    if (single) download(single, `${stem}.${opts.format === 'jpeg' ? 'jpg' : 'png'}`);
    else {
      const zip = zipSync(files, { level: 0 });
      download(new Blob([zip as BlobPart], { type: 'application/zip' }), `${stem} images.zip`);
    }
    toast('Images exported', 'success');
  } catch (e) {
    toast(`Export failed: ${(e as Error).message}`, 'error');
  } finally {
    set({ busy: null });
  }
}

export async function printDocument() {
  if (!get().pages.length || get().busy) return;
  set({ busy: 'Preparing to print…' });
  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
  document.body.append(frame);
  try {
    const urls: string[] = [];
    const sizes: { w: number; h: number }[] = [];
    await renderOutput(150 / 72, undefined, async (canvas) => {
      const blob = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('print render failed'))), 'image/png'));
      urls.push(await readFileDataUrl(blob));
      sizes.push({ w: canvas.width / (150 / 72), h: canvas.height / (150 / 72) });
    });
    const doc = frame.contentDocument!;
    doc.open();
    doc.write(
      `<!doctype html><html><head><title>${get().fileName}</title><style>@page{margin:0}html,body{margin:0;padding:0}img{display:block;page-break-after:always;break-after:page;margin:0 auto}</style></head><body>${urls
        .map((u, i) => `<img src="${u}" style="width:${sizes[i].w}pt;height:${sizes[i].h}pt">`)
        .join('')}</body></html>`,
    );
    doc.close();
    await new Promise((r) => setTimeout(r, 300));
    set({ busy: null });
    frame.contentWindow!.focus();
    frame.contentWindow!.print();
  } catch (e) {
    toast(`Print failed: ${(e as Error).message}`, 'error');
  } finally {
    set({ busy: null });
    setTimeout(() => frame.remove(), 60_000);
  }
}
