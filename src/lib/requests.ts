/**
 * The sender's side of signature requests sent by email.
 *
 * Sending keeps a private copy of what was sent (the "master") together with
 * a fingerprint of every page. When a signed copy comes back and is opened
 * in Folio, the signatures and fields of whoever signed it are merged into
 * the master, and its pages are compared with what was sent, so changes
 * outside the signers' fields don't go unnoticed. Once everyone has signed,
 * finalizing flattens the master and adds a signing summary page.
 */
import { create } from 'zustand';
import {
  drawObject,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFObjectCopier,
  PDFRef,
  PDFSignature,
  PDFStream,
  PDFString,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  StandardFonts,
  type PDFFont,
  type PDFPage,
} from '@cantoo/pdf-lib';
import { actions, envelopeOpened, openDocuments, patchTab, tabState, toast } from '../store';
import {
  declined,
  firstName,
  mergeEvents,
  pendingSigners,
  sameEmail,
  sha256,
  signedAt,
  signerById,
  signersUp,
  STAMP_PREFIX,
  when,
  writeEnvelope,
  type Envelope,
  type Signer,
} from './envelope';
import { streamBytes } from './content';
import { idb } from './idb';
import { composeMail, type Recipient } from './mail';
import { dataRead, dataRemove, dataWrite, isDesktop } from './native';
import { loadSource } from './pdfjs';
import { saveBytes } from './files';
import { baseName } from './util';

const { get, set } = actions;

export interface TrackedRequest {
  id: string;
  title: string;
  sentAt: number;
  updatedAt: number;
  /** The request as far as the sender knows. */
  envelope: Envelope;
  /** SHA-256 of each page's content in the copy that was sent. */
  baseline: string[];
  /** SHA-256 of the file that was sent. */
  sentHash: string;
  /** Pages (1-based) that differed from the sent copy, in the copy each signer returned. */
  changes: Record<string, number[]>;
}

/** What opening a returned copy found, shown above that document. */
export interface ReturnReport {
  request: string;
  newlySigned: string[];
  changedPages: number[];
}

export const useRequests = create<{ list: TrackedRequest[]; loaded: boolean; reports: Record<string, ReturnReport> }>()(() => ({
  list: [],
  loaded: false,
  reports: {},
}));

const INDEX = 'requests/index.json';
const masterKey = (id: string) => (isDesktop ? `requests/${id}.pdf` : `request:${id}`);

let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn);
  chain = run.catch((e) => console.warn('Signature requests:', e));
  return run;
}

async function readIndex(): Promise<TrackedRequest[]> {
  if (isDesktop) {
    const b = await dataRead(INDEX);
    return b ? JSON.parse(new TextDecoder().decode(b)) : [];
  }
  return (await idb.get<TrackedRequest[]>('requests')) ?? [];
}

async function writeIndex(list: TrackedRequest[]) {
  useRequests.setState({ list });
  if (isDesktop) await dataWrite(INDEX, new TextEncoder().encode(JSON.stringify(list)));
  else await idb.set('requests', list);
}

export function loadRequests() {
  return serial(async () => {
    const list = await readIndex().catch(() => [] as TrackedRequest[]);
    useRequests.setState({ list, loaded: true });
  });
}

async function ensureLoaded() {
  if (!useRequests.getState().loaded) await loadRequests();
}

export async function masterBytes(id: string): Promise<Uint8Array | null> {
  if (isDesktop) return dataRead(masterKey(id));
  return (await idb.get<Uint8Array>(masterKey(id))) ?? null;
}

async function writeMaster(id: string, bytes: Uint8Array) {
  if (isDesktop) await dataWrite(masterKey(id), bytes);
  else await idb.set(masterKey(id), bytes);
}

export const findRequest = (id: string | undefined) => (id ? useRequests.getState().list.find((r) => r.id === id) : undefined);

export function forgetRequest(id: string) {
  return serial(async () => {
    await writeIndex(useRequests.getState().list.filter((r) => r.id !== id));
    if (isDesktop) await dataRemove(masterKey(id)).catch(() => {});
    else await idb.del(masterKey(id)).catch(() => {});
  });
}

/**
 * A fingerprint of each page's drawing. Streams holding nothing but "q" or
 * "Q" are left out: pdf-lib wraps a page's content in them whenever an
 * annotation (a signature stamp, a form field) is added, which changes
 * nothing that is drawn.
 */
async function pageHashes(doc: PDFDocument) {
  const out: string[] = [];
  for (const p of doc.getPages()) {
    const contents = p.node.Contents();
    const streams = contents instanceof PDFArray ? contents.asArray().map((r) => doc.context.lookup(r)) : contents ? [contents] : [];
    const parts: Uint8Array[] = [];
    for (const st of streams) {
      const bytes = st instanceof PDFStream ? streamBytes(st) : null;
      if (!bytes) continue;
      if (bytes.length <= 8 && /^\s*[qQ]\s*$/.test(String.fromCharCode(...bytes))) continue;
      parts.push(bytes, NEWLINE);
    }
    const all = new Uint8Array(parts.reduce((n, b) => n + b.length, 0));
    let at = 0;
    for (const b of parts) {
      all.set(b, at);
      at += b.length;
    }
    out.push(await sha256(all));
  }
  return out;
}

const NEWLINE = new Uint8Array([0x0a]);

const loadLib = (bytes: Uint8Array) => PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });

/* ------------------------------------------------------------------ */
/* Sending                                                              */
/* ------------------------------------------------------------------ */

const recipient = (s: Signer): Recipient => ({ name: s.name, email: s.email });

/** The note that goes with the document, for someone about to sign it. */
export function requestBody(env: Envelope, to: Signer, from: { name: string; email: string }, intro?: string) {
  const i = env.signers.findIndex((s) => s.id === to.id);
  const next = env.order === 'sequential' ? env.signers[i + 1] : undefined;
  const lines = [
    `Hi ${firstName(to.name)},`,
    '',
    intro ?? `${env.sender.name} has asked you to sign "${env.title}".`,
    ...(env.message.trim() ? ['', env.message.trim()] : []),
    '',
    'Open the attached PDF in Folio, which takes you through the fields that are yours to fill in, or in any PDF reader that can fill in forms.',
    next
      ? `When you have signed, send it on to ${next.name} (${next.email}), the next to sign.`
      : `When you have signed, send the signed PDF back to ${env.sender.name} (${env.sender.email}).`,
    '',
    `Thank you,`,
    from.name,
  ];
  return lines.join('\n');
}

/**
 * Sends the document in the active tab for signature: writes the fields and
 * the request into a copy, keeps that copy as the master, shows it in the
 * tab and opens an email to whoever signs first.
 */
export async function sendForSignature(): Promise<boolean> {
  await ensureLoaded();
  const s = get();
  const tab = s.activeTab;
  if (!s.envelope || s.busy || !tab) return false;
  const now = Date.now();
  const env: Envelope = {
    ...s.envelope,
    sender: { name: s.userName.trim(), email: s.userEmail.trim() },
    subject: s.envelope.subject.trim() || `Please sign: ${s.envelope.title}`,
    signers: s.envelope.signers.map((x) => ({ ...x, name: x.name.trim(), email: x.email.trim() })),
    status: 'out',
    events: [...s.envelope.events, { type: 'sent', at: now }],
  };
  set({ busy: 'Preparing the document…', editing: null });
  let sent: Envelope;
  let bytes: Uint8Array;
  try {
    const { buildPdf } = await import('./export');
    const res = await buildPdf(
      { docs: s.docs, pages: s.pages, objects: s.objects, meta: s.meta, ocr: s.ocr, envelope: env },
      { onProgress: (t) => set({ busy: t }) },
    );
    bytes = res.bytes;
    sent = res.envelope ?? env;
    for (const w of res.warnings) toast(w, 'info');
    const lib = await loadLib(bytes);
    const record: TrackedRequest = {
      id: sent.id,
      title: sent.title,
      sentAt: now,
      updatedAt: now,
      envelope: sent,
      baseline: await pageHashes(lib),
      sentHash: await sha256(bytes),
      changes: {},
    };
    await serial(async () => {
      await writeMaster(sent.id, bytes);
      await writeIndex([record, ...useRequests.getState().list.filter((r) => r.id !== sent.id)]);
    });
    // The tab shows the copy that was sent from now on; the original file is left as it was.
    const name = `${baseName(s.fileName) || 'Document'} (for signature).pdf`;
    const { doc, pages } = await loadSource(bytes, name, async () => null);
    patchTab(tab, (d) => ({
      docs: { ...d.docs, [doc.id]: doc },
      pages: pages.map((p, i) => ({ ...p, id: d.pages[i]?.id ?? p.id })),
      objects: [],
      envelope: sent,
      past: [],
      future: [],
      selection: [],
      fileName: name,
      fileHandle: null,
      dirty: false,
    }));
  } catch (e) {
    console.error(e);
    toast(`Couldn't prepare the document: ${(e as Error).message}`, 'error');
    return false;
  } finally {
    set({ busy: null });
  }

  const up = signersUp(sent);
  const me = up.find((x) => sameEmail(x.email, sent.sender.email));
  if (me && up.length === 1) {
    // The sender signs first: no email yet.
    const { startSigning } = await import('./signing');
    startSigning(tab, me.id);
    toast('You sign first. When you finish, Folio prepares the email to the next signer.', 'success');
    return true;
  }
  const to = up.filter((x) => x !== me);
  const opened = await composeMail(
    {
      to: to.map(recipient),
      subject: sent.subject,
      body: to.length === 1 ? requestBody(sent, to[0], sent.sender) : requestBody(sent, { ...to[0], name: 'there' }, sent.sender),
    },
    { bytes, name: `${sent.title}.pdf` },
  );
  toast(opened ? `Sent for signature. You'll see "${sent.title}" under Signature requests.` : 'The email was not sent. You can send it later from Signature requests.', opened ? 'success' : 'info');
  return true;
}

/** Emails whoever is next with the latest copy, as a reminder. */
export async function remind(id: string) {
  const r = findRequest(id);
  const bytes = r && (await masterBytes(id));
  if (!r || !bytes) return;
  const up = signersUp(r.envelope);
  if (!up.length) return;
  const env = r.envelope;
  await composeMail(
    {
      to: up.map(recipient),
      subject: `Reminder: ${env.subject || `Please sign: ${env.title}`}`,
      body: requestBody(env, up.length === 1 ? up[0] : { ...up[0], name: 'there' }, env.sender, `A reminder that "${env.title}" is waiting for your signature.`),
    },
    { bytes, name: `${env.title}.pdf` },
  );
}

/** Opens the sender's copy with every signature collected so far. */
export async function openLatest(id: string) {
  const r = findRequest(id);
  const bytes = r && (await masterBytes(id));
  if (!r || !bytes) {
    toast("Folio no longer has a copy of this request's document", 'error');
    return;
  }
  const name = r.envelope.status === 'completed' ? `${r.title} (signed).pdf` : `${r.title} (latest).pdf`;
  await openDocuments([{ file: new File([bytes as BlobPart], name, { type: 'application/pdf' }), handle: null }]);
}

/* ------------------------------------------------------------------ */
/* Returned copies                                                      */
/* ------------------------------------------------------------------ */

envelopeOpened.add((tab, env, doc) => {
  receiveCopy(tab, env, doc.bytes).catch((e) => {
    console.error(e);
    toast(`Couldn't check this copy against your request: ${(e as Error).message}`, 'error');
  });
});

/** The sender signed in their own request: their copy gets the signature like any returned one. */
export function recordOwnSignature(tab: string, env: Envelope, bytes: Uint8Array) {
  return receiveCopy(tab, env, bytes);
}

async function receiveCopy(tab: string, env: Envelope, bytes: Uint8Array) {
  await ensureLoaded();
  const r = findRequest(env.id);
  if (!r || env.status === 'draft') return;
  const report = await serial(async () => {
    const cur = findRequest(env.id)!;
    const returned = await loadLib(bytes);
    const hashes = await pageHashes(returned);
    const changedPages =
      hashes.length !== cur.baseline.length ? hashes.map((_, i) => i + 1) : hashes.flatMap((h, i) => (h === cur.baseline[i] ? [] : [i + 1]));
    const newly = env.signers.filter((x) => signedAt(env, x.id) !== undefined && signedAt(cur.envelope, x.id) === undefined);
    const newlyDeclined = declined(env) && !declined(cur.envelope);
    if (!newly.length && !newlyDeclined) return { request: cur.id, newlySigned: [], changedPages: [] };
    const merged: Envelope = { ...cur.envelope, events: mergeEvents(cur.envelope.events, env.events) };
    if (newly.length) {
      const master = await masterBytes(cur.id);
      if (master) await writeMaster(cur.id, await mergeSigners(master, returned, merged, new Set(newly.map((x) => x.id))));
    }
    const changes = { ...cur.changes };
    if (changedPages.length) for (const x of newly) changes[x.id] = changedPages;
    await writeIndex(useRequests.getState().list.map((x) => (x.id === cur.id ? { ...x, envelope: merged, changes, updatedAt: Date.now() } : x)));
    return { request: cur.id, newlySigned: newly.map((x) => x.id), changedPages };
  });
  useRequests.setState((st) => ({ reports: { ...st.reports, [tab]: report } }));
  const latest = findRequest(env.id)!;
  if (report.newlySigned.length) {
    const names = report.newlySigned.map((id) => signerById(latest.envelope, id)?.name ?? 'A signer').join(' and ');
    const left = pendingSigners(latest.envelope).length;
    toast(left ? `${names} signed "${latest.title}". ${left} still to sign.` : `Everyone has signed "${latest.title}". Finalize it to get the signed document.`, 'success');
  }
  if (report.changedPages.length) toast(`This copy differs from the one you sent on page ${report.changedPages.join(', ')}.`, 'error');
}

const NM = PDFName.of('NM');

function annotsOf(page: PDFPage): PDFRef[] {
  const arr = page.node.Annots();
  if (!arr) return [];
  return arr.asArray().filter((x): x is PDFRef => x instanceof PDFRef);
}

/** The request field a stamp annotation belongs to, if it is one of ours. */
function stampField(doc: PDFDocument, ref: PDFRef) {
  const dict = doc.context.lookup(ref);
  if (!(dict instanceof PDFDict)) return null;
  const nm = dict.lookup(NM);
  const text = nm instanceof PDFHexString || nm instanceof PDFString ? nm.decodeText() : '';
  return text.startsWith(STAMP_PREFIX) ? { dict, field: text.slice(STAMP_PREFIX.length) } : null;
}

/**
 * Copies what these signers did in the returned copy into the master: their
 * signature stamps (whose empty signature fields then go) and the values of
 * their other fields, which are locked.
 */
async function mergeSigners(masterRaw: Uint8Array, returned: PDFDocument, env: Envelope, signers: Set<string>) {
  const master = await loadLib(masterRaw);
  const fields = env.fields.filter((f) => signers.has(f.signer));
  const names = new Set(fields.map((f) => f.name));
  const copier = PDFObjectCopier.for(returned.context, master.context);
  const mForm = master.getForm();
  const rForm = returned.getForm();
  const mPages = master.getPages();
  returned.getPages().forEach((rp, i) => {
    const mp = mPages[i];
    if (!mp) return;
    const have = new Set(annotsOf(mp).map((ref) => stampField(master, ref)?.field).filter(Boolean));
    for (const ref of annotsOf(rp)) {
      const hit = stampField(returned, ref);
      if (!hit || !names.has(hit.field) || have.has(hit.field)) continue;
      const clone = hit.dict.clone(returned.context);
      clone.delete(PDFName.of('P'));
      const copy = copier.copy(clone);
      copy.set(PDFName.of('P'), mp.ref);
      mp.node.addAnnot(master.context.register(copy));
      const empty = mForm.getFieldMaybe(hit.field);
      if (empty) mForm.removeField(empty);
    }
  });
  for (const f of fields) {
    if (f.role === 'signature' || f.role === 'initials') continue;
    const rf = rForm.getFieldMaybe(f.name);
    const mf = mForm.getFieldMaybe(f.name);
    if (!rf || !mf) continue;
    // Value and appearance as the signer's copy has them; nothing is redrawn.
    const v = rf.acroField.dict.get(PDFName.of('V'));
    if (v) mf.acroField.dict.set(PDFName.of('V'), copier.copy(v));
    const rw = rf.acroField.getWidgets();
    const mw = mf.acroField.getWidgets();
    mw.forEach((w, k) => {
      const from = rw[k];
      if (!from) return;
      for (const key of ['AP', 'AS']) {
        const val = from.dict.get(PDFName.of(key));
        if (val) w.dict.set(PDFName.of(key), copier.copy(val));
      }
    });
    mf.enableReadOnly();
  }
  writeEnvelope(master, env);
  return master.save({ updateFieldAppearances: false });
}

/* ------------------------------------------------------------------ */
/* Finalizing                                                           */
/* ------------------------------------------------------------------ */

/**
 * Turns the master into the finished document: signatures and fields become
 * part of the pages, a signing summary page is added, and the result is
 * saved where the user chooses and opened.
 */
export async function finalizeRequest(id: string) {
  await ensureLoaded();
  const r = findRequest(id);
  const raw = r && (await masterBytes(id));
  if (!r || !raw) {
    toast("Folio no longer has a copy of this request's document", 'error');
    return;
  }
  if (pendingSigners(r.envelope).length) {
    toast('Not everyone has signed yet', 'error');
    return;
  }
  set({ busy: 'Finalizing…' });
  let bytes: Uint8Array;
  let env: Envelope;
  try {
    const doc = await loadLib(raw);
    const at = Date.now();
    env = { ...r.envelope, status: 'completed', events: [...r.envelope.events, { type: 'completed', at }] };
    flattenStamps(doc);
    const form = doc.getForm();
    // Signature fields nobody had to sign stay empty; they'd only show "Sign here".
    for (const f of form.getFields()) if (f instanceof PDFSignature) form.removeField(f);
    try {
      form.flatten({ updateFieldAppearances: false });
    } catch (e) {
      console.warn('Fields not flattened; locking them instead', e);
      for (const f of form.getFields()) f.enableReadOnly();
    }
    await addSummaryPage(doc, r, env);
    writeEnvelope(doc, env);
    bytes = await doc.save();
  } catch (e) {
    console.error(e);
    toast(`Couldn't finalize: ${(e as Error).message}`, 'error');
    return;
  } finally {
    set({ busy: null });
  }
  const out = await saveBytes(bytes, `${r.title} (signed).pdf`, null, true);
  if (!out) return;
  await serial(async () => {
    await writeMaster(id, bytes);
    await writeIndex(useRequests.getState().list.map((x) => (x.id === id ? { ...x, envelope: env, updatedAt: Date.now() } : x)));
  });
  await openDocuments([{ file: new File([bytes as BlobPart], out.name, { type: 'application/pdf' }), handle: out.handle }]);
  toast(`Saved ${out.name}. Send it to the signers so everyone has the signed document.`, 'success');
}

/** Emails the finished document to every signer. */
export async function sendFinal(tab: string | null) {
  const d = tabState(tab);
  const env = d?.envelope;
  if (!d || !env) return;
  const handle = d.fileHandle;
  const r = findRequest(env.id);
  const bytes = handle ? null : r ? await masterBytes(r.id) : null;
  if (!handle && !bytes) return;
  const body = [
    'Hi,',
    '',
    `Everyone has signed "${env.title}". The signed document is attached, with a summary of who signed and when on its last page.`,
    '',
    'Thank you,',
    env.sender.name,
  ].join('\n');
  await composeMail(
    { to: env.signers.filter((x) => !sameEmail(x.email, env.sender.email)).map(recipient), subject: `Signed: ${env.title}`, body },
    handle ? { ref: handle, name: d.fileName } : { bytes: bytes!, name: d.fileName },
  );
}

/** Draws each signature stamp into its page and removes the annotation. */
function flattenStamps(doc: PDFDocument) {
  for (const page of doc.getPages()) {
    const arr = page.node.Annots();
    if (!arr) continue;
    const keep: PDFRef[] = [];
    let drawn = false;
    for (const ref of annotsOf(page)) {
      const hit = stampField(doc, ref);
      const ap = hit?.dict.lookup(PDFName.of('AP'));
      const n = ap instanceof PDFDict ? ap.get(PDFName.of('N')) : null;
      if (!hit || !(n instanceof PDFRef)) {
        keep.push(ref);
        continue;
      }
      if (!drawn) {
        page.node.wrapContentStreams(doc.context.getPushGraphicsStateContentStream(), doc.context.getPopGraphicsStateContentStream());
        drawn = true;
      }
      // The stamp's appearance is drawn in user space (its box is the annotation's rectangle).
      const name = page.node.newXObject('FolioSig', n);
      page.pushOperators(pushGraphicsState(), drawObject(name), popGraphicsState());
    }
    if (drawn) {
      const others = arr.asArray().filter((x) => !(x instanceof PDFRef) || keep.includes(x));
      page.node.set(PDFName.of('Annots'), doc.context.obj(others) as PDFArray);
    }
  }
}

/** A last page listing who signed what and when, and what Folio checked. */
async function addSummaryPage(doc: PDFDocument, r: TrackedRequest, env: Envelope) {
  const first = doc.getPage(0);
  const { width, height } = first.getSize();
  const portrait = width <= height;
  const page = doc.addPage(portrait ? [width, height] : [612, 792]);
  const W = page.getWidth();
  const H = page.getHeight();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const margin = 56;
  let y = H - margin;
  const ink = rgb(0.13, 0.15, 0.18);
  const muted = rgb(0.4, 0.43, 0.48);

  const safe = (font: PDFFont, text: string) =>
    [...text]
      .map((ch) => {
        try {
          font.encodeText(ch);
          return ch;
        } catch {
          return '?';
        }
      })
      .join('');
  const write = (text: string, opts: { font?: PDFFont; size?: number; color?: ReturnType<typeof rgb>; gap?: number } = {}) => {
    const font = opts.font ?? regular;
    const size = opts.size ?? 10;
    const words = safe(font, text).split(/\s+/);
    let line = '';
    const lines: string[] = [];
    for (const w of words) {
      const next = line ? `${line} ${w}` : w;
      if (font.widthOfTextAtSize(next, size) > W - margin * 2 && line) {
        lines.push(line);
        line = w;
      } else line = next;
    }
    if (line) lines.push(line);
    for (const l of lines) {
      if (y < margin + size) return;
      page.drawText(l, { x: margin, y: y - size, size, font, color: opts.color ?? ink });
      y -= size * 1.4;
    }
    y -= opts.gap ?? 0;
  };

  write('Signing summary', { font: bold, size: 18, gap: 6 });
  write(env.title, { size: 12, gap: 4 });
  write(`Sent by ${env.sender.name} (${env.sender.email}) on ${when(r.sentAt)}.`, { color: muted });
  write(`Request ${env.id}. SHA-256 of the copy that was sent: ${r.sentHash}`, { color: muted, size: 8, gap: 14 });

  write('Signers', { font: bold, size: 12, gap: 2 });
  env.signers.forEach((s, i) => {
    const at = signedAt(env, s.id);
    write(`${i + 1}. ${s.name} (${s.email}): ${at ? `signed ${when(at)}` : 'did not sign'}`);
  });
  y -= 10;

  write('History', { font: bold, size: 12, gap: 2 });
  for (const e of env.events) {
    const who = e.signer ? signerById(env, e.signer)?.name ?? 'A signer' : env.sender.name;
    const what = e.type === 'sent' ? `Sent for signature by ${who}` : e.type === 'signed' ? `Signed by ${who}` : e.type === 'declined' ? `Declined by ${who}${e.note ? `: ${e.note}` : ''}` : 'Completed';
    write(`${when(e.at)}   ${what}`);
  }
  y -= 10;

  write('Checks', { font: bold, size: 12, gap: 2 });
  const changed = Object.entries(r.changes).filter(([, pages]) => pages.length);
  if (!changed.length) write("Every returned copy matched the copy that was sent, apart from the signers' own fields.");
  for (const [id, pages] of changed) {
    write(`The copy returned by ${signerById(env, id)?.name ?? 'a signer'} differed from the copy that was sent on page ${pages.join(', ')}.`);
  }
  y -= 10;
  write(
    'Signatures were collected by email with Folio. Signers are identified by the email addresses they were sent to; Folio did not verify their identities. Sign this document with a certificate to make later changes detectable.',
    { color: muted, size: 8 },
  );
}
