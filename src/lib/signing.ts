/**
 * Signing a document that was sent for signature. Folio works out whose turn
 * it is, shows that signer their fields, puts their signature or initials
 * into the signature fields, fills in the date and their name, and when they
 * finish saves the signed copy and prepares the email to the next signer, or
 * back to the sender.
 */
import { create } from 'zustand';
import { actions, commit, patchTab, scrollToPage, tabState, toast, undo, useStore, type DocState } from '../store';
import type { ImageObj, Rect, StampTarget } from '../types';
import { applyMatrix } from './geometry';
import { firstName, sameEmail, signerById, signersUp, signingDate, type Envelope, type EnvelopeField } from './envelope';
import { composeMail } from './mail';
import { isPathRef } from './files';
import { baseName, uid } from './util';
import { LINK_TOKEN } from './linkmode';

const { get } = actions;

/** A request field on a page. */
export interface Spot {
  field: EnvelopeField;
  page: string;
  src: string;
  /** Page space. */
  rect: Rect;
  /** pdf.js annotation id: where the form value is kept. */
  annot: string;
  kind: 'sig' | 'text' | 'checkbox' | 'other';
  /** The value the file has. */
  value: unknown;
}

interface TabSigning {
  signer: string | null;
  /** Guided signing is on. */
  active: boolean;
}

export const useSigning = create<{ byTab: Record<string, TabSigning>; spots: Record<string, Spot[]>; formsVersion: number }>()(() => ({
  byTab: {},
  spots: {},
  formsVersion: 0,
}));

/** Form layers re-read their values after Folio fills fields in. */
export const useFormsVersion = () => useSigning((s) => s.formsVersion);

interface AnnotData {
  id: string;
  fieldName?: string;
  fieldType?: string;
  fieldValue?: unknown;
  rect?: number[];
}

let run = 0;

/** Finds the request's fields on the pages of a tab. */
async function refreshSpots(tab: string) {
  const mine = ++run;
  const d = tabState(tab);
  const out = d ? await findSpots(d) : [];
  if (mine !== run) return;
  useSigning.setState((s) => ({ spots: { ...s.spots, [tab]: out } }));
}

/** The request's fields in the document's files, where they are on its pages. */
export async function findSpots(d: Pick<DocState, 'envelope' | 'pages' | 'docs'>): Promise<Spot[]> {
  const env = d.envelope;
  const out: Spot[] = [];
  if (env && env.status !== 'draft' && env.fields.length) {
    const byName = new Map(env.fields.map((f) => [f.name, f]));
    for (const page of d.pages) {
      const doc = d.docs[page.src];
      if (!doc) continue;
      let annots: AnnotData[] = [];
      try {
        annots = (await (await doc.pdf.getPage(page.index + 1)).getAnnotations()) as AnnotData[];
      } catch {
        continue;
      }
      for (const a of annots) {
        const field = a.fieldName ? byName.get(a.fieldName) : undefined;
        if (!field || !a.rect) continue;
        const p = applyMatrix(page.m, a.rect[0], a.rect[1]);
        const q = applyMatrix(page.m, a.rect[2], a.rect[3]);
        out.push({
          field,
          page: page.id,
          src: page.src,
          rect: { x: Math.min(p.x, q.x), y: Math.min(p.y, q.y), w: Math.abs(q.x - p.x), h: Math.abs(q.y - p.y) },
          annot: a.id,
          kind: a.fieldType === 'Sig' ? 'sig' : a.fieldType === 'Btn' ? 'checkbox' : a.fieldType === 'Tx' ? 'text' : 'other',
          value: a.fieldValue,
        });
      }
    }
  }
  return out;
}

useStore.subscribe((s, prev) => {
  if (!s.activeTab) return;
  if (s.activeTab !== prev.activeTab || s.envelope !== prev.envelope || s.docs !== prev.docs || s.pages.length !== prev.pages.length) {
    void refreshSpots(s.activeTab);
  }
});

/** The form value of a field as it is now (typed in, or as the file has it). */
function currentValue(d: DocState, spot: Spot): unknown {
  const doc = d.docs[spot.src];
  const stored = doc?.pdf.annotationStorage.getValue(spot.annot, { value: undefined }) as { value?: unknown } | undefined;
  return stored?.value !== undefined ? stored.value : spot.value;
}

export function spotDone(d: DocState, spot: Spot): boolean {
  const { role, name } = spot.field;
  if (role === 'signature' || role === 'initials') return d.objects.some((o) => o.type === 'image' && o.stamp?.field === name);
  const v = currentValue(d, spot);
  if (spot.kind === 'checkbox') return v === true || (typeof v === 'string' && v !== '' && v !== 'Off');
  return typeof v === 'string' ? v.trim() !== '' : v != null && v !== false;
}

/**
 * Who signs in this tab: the one chosen, the one with the user's email, or
 * else the only one whose turn it is. The sender and signers who already
 * signed are known by their email and never stand in for someone else.
 */
export function currentSigner(env: Envelope, tab: string | null, userEmail: string): string | null {
  const up = signersUp(env);
  const chosen = tab ? useSigning.getState().byTab[tab]?.signer : null;
  if (chosen && up.some((s) => s.id === chosen)) return chosen;
  const mine = up.find((s) => sameEmail(s.email, userEmail));
  if (mine) return mine.id;
  if (sameEmail(env.sender.email, userEmail) || env.signers.some((s) => sameEmail(s.email, userEmail))) return null;
  return up.length === 1 ? up[0].id : null;
}

export function chooseSigner(tab: string, signer: string) {
  useSigning.setState((s) => ({ byTab: { ...s.byTab, [tab]: { signer, active: s.byTab[tab]?.active ?? false } } }));
}

/** Starts guided signing in a tab: fills in the date and name, then goes to the first field. */
export function startSigning(tab: string, signer: string) {
  useSigning.setState((s) => ({ byTab: { ...s.byTab, [tab]: { signer, active: true } } }));
  const d = tabState(tab);
  const env = d?.envelope;
  const who = env && signerById(env, signer);
  if (!d || !who) return;
  const fill = (spots: Spot[]) => {
    let filled = false;
    for (const spot of spots) {
      if (spot.field.signer !== signer || spot.kind !== 'text') continue;
      const doc = d.docs[spot.src];
      const v = currentValue(d, spot);
      const text = spot.field.role === 'date' ? signingDate(Date.now()) : spot.field.role === 'name' && !(typeof v === 'string' && v.trim()) ? who.name : null;
      if (!doc || text === null) continue;
      doc.pdf.annotationStorage.setValue(spot.annot, { value: text });
      filled = true;
    }
    if (filled) useSigning.setState((s) => ({ formsVersion: s.formsVersion + 1 }));
  };
  const spots = useSigning.getState().spots[tab];
  if (spots) {
    fill(spots);
    goToNext(tab);
  } else {
    void refreshSpots(tab).then(() => {
      fill(useSigning.getState().spots[tab] ?? []);
      goToNext(tab);
    });
  }
}

export function stopSigning(tab: string) {
  useSigning.setState((s) => ({ byTab: { ...s.byTab, [tab]: { signer: s.byTab[tab]?.signer ?? null, active: false } } }));
}

/** The signer's fields in page order, and which are still to do. */
export function progress(tab: string | null) {
  const d = tabState(tab);
  const env = d?.envelope;
  const signer = env && tab ? currentSigner(env, tab, get().userEmail) : null;
  const spots = (tab && useSigning.getState().spots[tab]) || [];
  if (!d || !signer) return { mine: [] as Spot[], todo: [] as Spot[] };
  const order = new Map(d.pages.map((p, i) => [p.id, i]));
  const mine = spots
    .filter((s) => s.field.signer === signer)
    .sort((a, b) => (order.get(a.page) ?? 0) - (order.get(b.page) ?? 0) || a.rect.y - b.rect.y || a.rect.x - b.rect.x);
  return { mine, todo: mine.filter((s) => !spotDone(d, s)) };
}

export function goToSpot(spot: Spot) {
  const i = get().pages.findIndex((p) => p.id === spot.page);
  if (i >= 0) scrollToPage(i, Math.max(0, spot.rect.y - 80));
}

/** Goes to the next field still to fill in (required ones first). */
export function goToNext(tab: string | null) {
  const { todo } = progress(tab);
  const next = todo.find((s) => s.field.required) ?? todo[0];
  if (next) goToSpot(next);
}

/** Opens the signature dialog for a signature or initials field. */
export function signSpot(spot: Spot) {
  actions.set({
    dialog: {
      kind: 'signature',
      target: { field: spot.field.name, signer: spot.field.signer, page: spot.page, rect: spot.rect, initials: spot.field.role === 'initials' },
    },
  });
}

/** Puts a signature (an image, `pxW` x `pxH`) into its field, centered and as large as fits. */
export function stampField(target: StampTarget, src: string, pxW: number, pxH: number) {
  const s = get();
  const who = s.envelope && signerById(s.envelope, target.signer);
  const r = target.rect;
  const pad = Math.min(3, r.h * 0.08);
  const box = { x: r.x + pad, y: r.y + pad, w: Math.max(1, r.w - pad * 2), h: Math.max(1, r.h - pad * 2) };
  const ratio = pxW / pxH;
  let w = box.w;
  let h = w / ratio;
  if (h > box.h) {
    h = box.h;
    w = h * ratio;
  }
  const o: ImageObj = {
    id: uid(),
    page: target.page,
    created: Date.now(),
    author: who?.name || s.userName,
    opacity: 1,
    type: 'image',
    x: box.x + (box.w - w) / 2,
    y: box.y + (box.h - h) / 2,
    w,
    h,
    src,
    signature: true,
    stamp: { field: target.field, signer: target.signer },
  };
  commit((st) => ({ objects: [...st.objects.filter((x) => !(x.type === 'image' && x.stamp?.field === target.field)), o] }));
  actions.set({ selection: [] });
  setTimeout(() => goToNext(get().activeTab), 0);
}

export function clearStamp(field: string) {
  commit((st) => ({ objects: st.objects.filter((x) => !(x.type === 'image' && x.stamp?.field === field)) }));
}

const recipient = (s: { name: string; email: string }) => ({ name: s.name, email: s.email });

/**
 * Finishes signing: records it in the request, saves the signed copy where
 * the signer chooses and opens the email that passes it on.
 */
export async function finishSigning() {
  const s = get();
  const tab = s.activeTab;
  const env = s.envelope;
  const signer = env && tab ? currentSigner(env, tab, s.userEmail) : null;
  const me = env && signer ? signerById(env, signer) : undefined;
  if (!tab || !env || !me || s.busy) return;
  const { mine, todo } = progress(tab);
  const missing = todo.filter((x) => x.field.required);
  if (!mine.length) {
    toast('There are no fields for you in this document', 'error');
    return;
  }
  if (missing.length) {
    toast(`${missing.length} required field${missing.length === 1 ? ' is' : 's are'} still empty`, 'error');
    goToSpot(missing[0]);
    return;
  }
  commit((st) => ({ envelope: st.envelope && { ...st.envelope, events: [...st.envelope.events, { type: 'signed', at: Date.now(), signer: me.id }] } }));
  const { buildCurrent } = await import('./commands');
  const res = await buildCurrent();
  if (!res) {
    undo();
    return;
  }
  if (LINK_TOKEN) {
    // Signing from a Folio Sign link: the signed copy goes back to the service.
    try {
      actions.set({ busy: 'Sending your signature…' });
      const { submitLink } = await import('./linksign');
      await submitLink(res.bytes);
    } catch (e) {
      undo();
      toast(`Couldn't send your signature: ${(e as Error).message}`, 'error');
      return;
    } finally {
      actions.set({ busy: null });
    }
    patchTab(tab, { dirty: false });
    stopSigning(tab);
    return;
  }
  const { saveBytes } = await import('./files');
  const out = await saveBytes(res.bytes, `${baseName(s.fileName).replace(/ \((for signature|signed[^)]*)\)$/, '') || env.title} (signed by ${firstName(me.name)}).pdf`, null, true);
  if (!out) {
    undo();
    return;
  }
  patchTab(tab, { dirty: false, fileHandle: out.handle, fileName: out.name });
  stopSigning(tab);
  const after = res.envelope ?? env;
  const attachment = out.handle && isPathRef(out.handle) ? { ref: out.handle, name: out.name } : { bytes: res.bytes, name: out.name, saved: !out.handle };
  const iAmSender = sameEmail(after.sender.email, me.email);
  if (iAmSender) {
    // The sender signing their own request: their copy is updated right away.
    const { recordOwnSignature } = await import('./requests');
    await recordOwnSignature(tab, after, res.bytes);
  }
  const next = after.order === 'sequential' ? signersUp(after)[0] : undefined;
  const { requestBody } = await import('./requests');
  if (next) {
    await composeMail(
      {
        to: [recipient(next)],
        cc: iAmSender ? [] : [recipient(after.sender)],
        subject: after.subject || `Please sign: ${after.title}`,
        body: requestBody(after, next, me, `${me.name} has signed "${after.title}" and it is your turn to sign.`),
      },
      attachment,
    );
    toast(`Signed. Send the email to pass the document on to ${next.name}.`, 'success');
  } else if (!iAmSender) {
    await composeMail(
      {
        to: [recipient(after.sender)],
        subject: `Signed: ${after.title}`,
        body: [`Hi ${firstName(after.sender.name)},`, '', `I have signed "${after.title}". The signed document is attached.`, '', me.name].join('\n'),
      },
      attachment,
    );
    toast(`Signed. Send the email to return the document to ${after.sender.name}.`, 'success');
  } else {
    toast('Signed.', 'success');
  }
}

/** Declines to sign, telling the sender why. */
export async function declineSigning(reason: string) {
  const s = get();
  const tab = s.activeTab;
  const env = s.envelope;
  const signer = env && tab ? currentSigner(env, tab, s.userEmail) : null;
  const me = env && signer ? signerById(env, signer) : undefined;
  if (!tab || !env || !me || s.busy) return;
  if (LINK_TOKEN) {
    try {
      const { declineLink } = await import('./linksign');
      await declineLink(reason.trim());
      stopSigning(tab);
    } catch (e) {
      toast(`Couldn't decline: ${(e as Error).message}`, 'error');
    }
    return;
  }
  commit((st) => ({ envelope: st.envelope && { ...st.envelope, events: [...st.envelope.events, { type: 'declined', at: Date.now(), signer: me.id, note: reason.trim() || undefined }] } }));
  const { buildCurrent } = await import('./commands');
  const res = await buildCurrent();
  if (!res) {
    undo();
    return;
  }
  stopSigning(tab);
  const after = res.envelope ?? env;
  const body = [`Hi ${firstName(after.sender.name)},`, '', `I have declined to sign "${after.title}".`, ...(reason.trim() ? ['', `Reason: ${reason.trim()}`] : []), '', me.name];
  await composeMail(
    { to: [recipient(after.sender)], subject: `Declined: ${after.title}`, body: body.join('\n') },
    { bytes: res.bytes, name: `${after.title} (declined).pdf` },
  );
  toast('You declined to sign. The sender is told once you send the email.', 'info');
}
