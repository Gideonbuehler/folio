/**
 * The "Sign with certificate" workflow: choose where the signature goes (a box
 * drawn on a page, or an empty signature field), then sign and save a copy,
 * which becomes the open document.
 */
import { create } from 'zustand';
import type { FieldObj, PageItem, Rect } from '../types';
import { actions, openDocuments, setTool, toast, useStore } from '../store';
import { applyMatrix, invertMatrix } from './geometry';
import { saveBytes } from './files';
import { baseName } from './util';
import { untouchedDoc } from './commands';
import type { Identity } from './certs';
import { signPdf, type Placement } from './certsign';
import { useSignatures } from './signatures';

const { get, set } = actions;

export interface SignTarget {
  /** 'box' is the box drawn last; otherwise the name of an empty signature field. */
  key: string;
  label: string;
}

interface FlowState {
  /** The box drawn for the signature, in page space. */
  box: { page: string; rect: Rect } | null;
  /** Unlocked digital ID, kept only until signing is done or cancelled. */
  identity: Identity | null;
  idFile: string | null;
}

export const useCertFlow = create<FlowState>()(() => ({ box: null, identity: null, idFile: null }));

/** Forgets the unlocked ID and the drawn box. */
export function endCertFlow() {
  useCertFlow.setState({ box: null, identity: null, idFile: null });
}

// Leaving the box tool without placing a box (Esc, another tool) ends the flow,
// so an unlocked ID never lingers.
useStore.subscribe((s, prev) => {
  if (prev.tool === 'certSign' && s.tool !== 'certSign' && s.dialog?.kind !== 'certSign') endCertFlow();
});

export function startCertSign() {
  if (!get().pages.length) return;
  set({ dialog: { kind: 'certSign' } });
}

/** Lets the user draw the signature box; the dialog comes back afterwards. */
export function drawSignatureBox() {
  set({ dialog: null });
  setTool('certSign');
  toast('Drag a box where the signature should appear');
}

export function placeSignatureBox(page: PageItem, rect: Rect) {
  useCertFlow.setState({ box: { page: page.id, rect } });
  set({ tool: 'select', dialog: { kind: 'certSign' } });
}

/** Empty signature fields: designed in Folio, or already in the file and not signed yet. */
export async function emptySignatureFields(): Promise<SignTarget[]> {
  const s = get();
  const out: SignTarget[] = [];
  const pageNo = (id: string) => s.pages.findIndex((p) => p.id === id) + 1;
  for (const o of s.objects) {
    if (o.type === 'field' && o.kind === 'signature') out.push({ key: o.name, label: `${o.name} (page ${pageNo(o.page)}, not saved yet)` });
  }
  const signed = new Set(Object.values(useSignatures.getState().byDoc).flatMap((l) => l.map((x) => x.field)));
  for (const [i, p] of s.pages.entries()) {
    const doc = s.docs[p.src];
    if (!doc) continue;
    try {
      const annots = await (await doc.pdf.getPage(p.index + 1)).getAnnotations();
      for (const a of annots as { fieldType?: string; fieldName?: string }[]) {
        if (a.fieldType === 'Sig' && a.fieldName && !signed.has(a.fieldName) && !out.some((t) => t.key === a.fieldName)) {
          out.push({ key: a.fieldName, label: `${a.fieldName} (page ${i + 1})` });
        }
      }
    } catch {
      /* page not readable */
    }
  }
  return out;
}

function userRect(r: Rect, page: PageItem): Rect {
  const inv = invertMatrix(page.m);
  const pts = [applyMatrix(inv, r.x, r.y), applyMatrix(inv, r.x + r.w, r.y + r.h)];
  return { x: Math.min(pts[0].x, pts[1].x), y: Math.min(pts[0].y, pts[1].y), w: Math.abs(pts[1].x - pts[0].x), h: Math.abs(pts[1].y - pts[0].y) };
}

export interface SignRequest {
  identity: Identity;
  target: string;
  image: string | null;
  name: string;
  reason: string;
  location: string;
}

/**
 * Signs the document as it is now and saves the signed copy. An unchanged
 * file is signed as is, so signatures already in it stay valid; otherwise
 * the document is written out first (as saving would) and then signed.
 */
export async function signAndSave(req: SignRequest) {
  const s = get();
  if (s.busy) return;
  set({ busy: 'Preparing to sign…', editing: null });
  try {
    let placement: Placement;
    const box = useCertFlow.getState().box;
    if (req.target === 'box') {
      const index = s.pages.findIndex((p) => p.id === box?.page);
      if (!box || index < 0) throw new Error('Draw the signature box first');
      const page = s.pages[index];
      placement = { kind: 'new', page: index, rect: userRect(box.rect, page), rotate: (page.baseRotate + page.rotation) % 360 };
    } else {
      placement = { kind: 'field', name: req.target };
    }
    const designed = s.objects.some((o): o is FieldObj => o.type === 'field' && o.kind === 'signature' && o.name === req.target);
    const original = !designed ? untouchedDoc() : null;
    let bytes: Uint8Array;
    if (original && original.password === undefined) {
      bytes = original.bytes;
    } else {
      const { buildPdf } = await import('./export');
      const res = await buildPdf({ docs: s.docs, pages: s.pages, objects: s.objects, meta: s.meta }, { objectStreams: false, onProgress: (t) => set({ busy: t }) });
      bytes = res.bytes;
    }
    set({ busy: 'Signing…' });
    const signed = await signPdf(bytes, { identity: req.identity, placement, image: req.image, name: req.name, reason: req.reason || undefined, location: req.location || undefined });
    set({ busy: null });
    const out = await saveBytes(signed, `${baseName(s.fileName) || 'Document'} (signed).pdf`, null, true);
    if (!out) return false;
    endCertFlow();
    // The signed file is what's open from now on.
    await openDocuments([{ file: new File([signed as BlobPart], out.name, { type: 'application/pdf' }), handle: out.handle }]);
    toast(`Signed and saved ${out.name}. Any change to it from now on invalidates the signature.`, 'success');
    return true;
  } catch (e) {
    console.error(e);
    toast(`Signing failed: ${(e as Error).message}`, 'error');
    return false;
  } finally {
    set({ busy: null });
  }
}
