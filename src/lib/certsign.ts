/**
 * Certificate signatures: signing a finished PDF in an incremental update
 * (PAdES baseline B-B, SubFilter ETSI.CAdES.detached), and checking the
 * signatures of opened documents.
 *
 * Signing appends one update to the file: a signature field (or an existing
 * empty one), its visible appearance and the signature dictionary, whose
 * /Contents holds the CMS signature over every byte of the file except
 * itself. Nothing may change the file afterwards without breaking it.
 */
import {
  concatTransformationMatrix,
  beginText,
  drawObject,
  endText,
  PDFDict,
  PDFDocument,
  PDFFont,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFOperator,
  PDFRef,
  PDFSignature,
  PDFString,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  setFillingRgbColor,
  setFontAndSize,
  setLineWidth,
  setStrokingRgbColor,
  setTextMatrix,
  showText,
  stroke,
  StandardFonts,
} from '@cantoo/pdf-lib';
import type { Rect, SourceDoc } from '../types';
import { signDigest, verifyCms, type CertInfo, type Identity } from './certs';
import { concat } from './der';

/* ------------------------------------------------------------------ */
/* Signing                                                              */
/* ------------------------------------------------------------------ */

export type Placement =
  /** An existing, empty signature field. */
  | { kind: 'field'; name: string }
  /** A new field: page index in the file, rectangle in PDF user space, page rotation. */
  | { kind: 'new'; page: number; rect: Rect; rotate: number };

export interface SignOptions {
  identity: Identity;
  placement: Placement;
  /** PNG or JPEG data URL of a handwritten signature to show, if any. */
  image?: string | null;
  name: string;
  reason?: string;
  location?: string;
}

const PLACEHOLDER = '9999999999';

function dataUrlBytes(src: string) {
  const bin = atob(src.slice(src.indexOf(',') + 1));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** "2026.10.23 14:05:09 +02'00'", as Acrobat shows it. */
export function signatureDate(d: Date) {
  const p = (n: number) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${sign}${p(Math.floor(Math.abs(off) / 60))}'${p(Math.abs(off) % 60)}'`;
}

/** Text the standard font can show. */
function safe(font: PDFFont, text: string) {
  return [...text]
    .map((ch) => {
      try {
        font.encodeText(ch);
        return ch;
      } catch {
        return '?';
      }
    })
    .join('');
}

/** Visible appearance: the handwritten signature (if any) beside who signed, when and why. */
async function buildAppearance(doc: PDFDocument, w: number, h: number, rotate: number, o: SignOptions, when: Date) {
  const ctx = doc.context;
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const ops: PDFOperator[] = [];
  const resources: { Font: Record<string, PDFRef>; XObject?: Record<string, PDFRef> } = { Font: { F1: regular.ref, F2: bold.ref } };
  const pad = Math.min(4, w * 0.04, h * 0.08);
  let textBox = { x: pad, y: pad, w: w - pad * 2, h: h - pad * 2 };

  if (o.image) {
    const bytes = dataUrlBytes(o.image);
    const img = /^data:image\/jpe?g/i.test(o.image) ? await doc.embedJpg(bytes) : await doc.embedPng(bytes);
    resources.XObject = { Im1: img.ref };
    // Wide boxes: picture on the left. Tall ones: picture on top.
    const side = w >= h * 1.6;
    const area = side ? { x: pad, y: pad, w: w * 0.48 - pad * 1.5, h: h - pad * 2 } : { x: pad, y: h * 0.45, w: w - pad * 2, h: h * 0.55 - pad };
    const s = Math.min(area.w / img.width, area.h / img.height);
    const iw = img.width * s;
    const ih = img.height * s;
    ops.push(pushGraphicsState(), concatTransformationMatrix(iw, 0, 0, ih, area.x + (area.w - iw) / 2, area.y + (area.h - ih) / 2), drawObject('Im1'), popGraphicsState());
    textBox = side ? { x: w * 0.5, y: pad, w: w * 0.5 - pad, h: h - pad * 2 } : { x: pad, y: pad, w: w - pad * 2, h: h * 0.45 - pad * 1.5 };
  }

  const lines: { text: string; font: PDFFont; key: string }[] = [
    { text: 'Digitally signed by', font: regular, key: 'F1' },
    { text: o.name, font: bold, key: 'F2' },
    { text: `Date: ${signatureDate(when)}`, font: regular, key: 'F1' },
    ...(o.reason ? [{ text: `Reason: ${o.reason}`, font: regular, key: 'F1' }] : []),
    ...(o.location ? [{ text: `Location: ${o.location}`, font: regular, key: 'F1' }] : []),
  ].map((l) => ({ ...l, text: safe(l.font, l.text) }));
  const byHeight = textBox.h / (lines.length * 1.18);
  const byWidth = Math.min(...lines.map((l) => textBox.w / Math.max(1, l.font.widthOfTextAtSize(l.text, 1))));
  const size = Math.max(3, Math.min(11, byHeight, byWidth));
  const lead = size * 1.18;
  const top = textBox.y + (textBox.h + lines.length * lead) / 2 - size * 0.9;
  ops.push(setFillingRgbColor(0.1, 0.1, 0.12), beginText());
  lines.forEach((l, i) => {
    ops.push(setFontAndSize(l.key, size), setTextMatrix(1, 0, 0, 1, textBox.x, top - i * lead), showText(l.font.encodeText(l.text)));
  });
  ops.push(endText());
  // A hairline frame, as signature boxes usually have.
  ops.push(setStrokingRgbColor(0.55, 0.58, 0.63), setLineWidth(0.5), rectangle(0.25, 0.25, w - 0.5, h - 0.5), stroke());

  const r = ((rotate % 360) + 360) % 360;
  // Turns the upright drawing so it reads correctly on a rotated page.
  const matrix = r === 90 ? [0, 1, -1, 0, 0, 0] : r === 180 ? [-1, 0, 0, -1, 0, 0] : r === 270 ? [0, -1, 1, 0, 0, 0] : [1, 0, 0, 1, 0, 0];
  const form = ctx.formXObject(ops, { BBox: [0, 0, w, h], Matrix: matrix, Resources: resources });
  return ctx.register(form);
}

function findPlaceholder(bytes: Uint8Array, from: number, contentsHexLength: number) {
  const text = new TextDecoder('latin1').decode(bytes.subarray(from));
  const zeros = `<${'0'.repeat(contentsHexLength)}>`;
  const contentsAt = text.indexOf(zeros);
  const byteRangeAt = text.indexOf('/ByteRange');
  if (contentsAt < 0 || byteRangeAt < 0) throw new Error('Signature placeholder not found');
  const open = text.indexOf('[', byteRangeAt);
  const close = text.indexOf(']', open);
  if (!text.slice(open, close).includes(PLACEHOLDER)) throw new Error('Signature byte range not found');
  return { contents: from + contentsAt, contentsEnd: from + contentsAt + zeros.length, rangeOpen: from + open, rangeClose: from + close };
}

/**
 * Signs `bytes` (a finished PDF) with an incremental update and returns the
 * signed file. The signature covers the whole file except its own value.
 */
export async function signPdf(bytes: Uint8Array, o: SignOptions): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { forIncrementalUpdate: true, updateMetadata: false });
  if (doc.isEncrypted) throw new Error("Password-protected files can't be signed. Save without a password first.");
  const ctx = doc.context;
  const when = new Date();
  const form = doc.getForm();
  const acro = form.acroForm;

  // Room for the CMS signature: the certificates plus a generous margin.
  const certBytes = o.identity.chain.reduce((t, c) => t + c.der.length, 0);
  const reserve = Math.ceil((certBytes + 6000) / 1024) * 1024;
  const sig = ctx.obj({
    Type: 'Sig',
    Filter: 'Adobe.PPKLite',
    SubFilter: 'ETSI.CAdES.detached',
    ByteRange: [0, Number(PLACEHOLDER), Number(PLACEHOLDER), Number(PLACEHOLDER)],
    Contents: PDFHexString.of('0'.repeat(reserve * 2)),
    M: PDFString.fromDate(when),
    Name: PDFHexString.fromText(o.name),
    ...(o.reason ? { Reason: PDFHexString.fromText(o.reason) } : {}),
    ...(o.location ? { Location: PDFHexString.fromText(o.location) } : {}),
    Prop_Build: { App: { Name: 'Folio' } },
  });
  const sigRef = ctx.register(sig);

  const p = o.placement;
  if (p.kind === 'field') {
    const field = form.getFields().find((f) => f.getName() === p.name);
    if (!(field instanceof PDFSignature)) throw new Error(`There is no signature field named "${p.name}"`);
    if (field.acroField.dict.has(PDFName.of('V'))) throw new Error(`"${p.name}" is already signed`);
    field.acroField.dict.set(PDFName.of('V'), sigRef);
    for (const widget of field.acroField.getWidgets()) {
      const r = widget.getRectangle();
      const rotate = widget.getAppearanceCharacteristics()?.getRotation() ?? 0;
      const upright = rotate % 180 ? { w: r.height, h: r.width } : { w: r.width, h: r.height };
      if (r.width > 1 && r.height > 1) widget.dict.set(PDFName.of('AP'), ctx.obj({ N: await buildAppearance(doc, upright.w, upright.h, rotate, o, when) }));
      widget.dict.set(PDFName.of('F'), PDFNumber.of(132)); // print + locked
    }
  } else {
    const page = doc.getPage(p.page);
    const taken = new Set(form.getFields().map((f) => f.getName()));
    let name = 'Signature1';
    for (let n = 2; taken.has(name); n++) name = `Signature${n}`;
    const upright = p.rotate % 180 ? { w: p.rect.h, h: p.rect.w } : { w: p.rect.w, h: p.rect.h };
    const widget = ctx.obj({
      Type: 'Annot',
      Subtype: 'Widget',
      FT: 'Sig',
      T: PDFHexString.fromText(name),
      V: sigRef,
      Rect: [p.rect.x, p.rect.y, p.rect.x + p.rect.w, p.rect.y + p.rect.h],
      F: 132,
      P: page.ref,
      MK: { R: p.rotate },
      AP: { N: await buildAppearance(doc, upright.w, upright.h, p.rotate, o, when) },
    });
    const ref = ctx.register(widget);
    page.node.addAnnot(ref);
    acro.addField(ref);
  }
  acro.dict.set(PDFName.of('SigFlags'), PDFNumber.of(3));
  // The AcroForm may be a direct part of the catalog; make sure the update carries it.
  if (!(doc.catalog.get(PDFName.of('AcroForm')) instanceof PDFRef)) doc.catalog.registerChange();

  // A classic cross-reference table keeps the signature dictionary out of object streams.
  const out = await doc.commit({ useObjectStreams: false });
  const at = findPlaceholder(out, bytes.length, reserve * 2);
  const range = [0, at.contents, at.contentsEnd, out.length - at.contentsEnd];
  const text = `0 ${range[1]} ${range[2]} ${range[3]}`;
  const slot = at.rangeClose - at.rangeOpen - 1;
  if (text.length > slot) throw new Error('Signature byte range does not fit');
  out.set(new TextEncoder().encode(text.padEnd(slot, ' ')), at.rangeOpen + 1);

  const signed = concat([out.subarray(0, range[1]), out.subarray(range[2])]);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', signed as BufferSource));
  const cms = await signDigest(o.identity, digest);
  if (cms.length > reserve) throw new Error('The signature is larger than the space reserved for it');
  const hex = [...cms].map((b) => b.toString(16).padStart(2, '0')).join('');
  out.set(new TextEncoder().encode(hex), at.contents + 1);
  return out;
}

/* ------------------------------------------------------------------ */
/* Removing signatures that no longer apply                             */
/* ------------------------------------------------------------------ */

/**
 * A rewritten document can't keep its signatures (they cover the old bytes),
 * so signed signature fields become empty ones again. Returns how many.
 */
export function clearSignatures(doc: PDFDocument): number {
  const acro = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  if (!acro) return 0;
  let n = 0;
  for (const field of doc.getForm().getFields()) {
    if (!(field instanceof PDFSignature) || !field.acroField.dict.has(PDFName.of('V'))) continue;
    field.acroField.dict.delete(PDFName.of('V'));
    for (const w of field.acroField.getWidgets()) {
      w.dict.delete(PDFName.of('AP'));
      w.dict.set(PDFName.of('F'), PDFNumber.of(4));
    }
    n++;
  }
  doc.catalog.delete(PDFName.of('Perms'));
  return n;
}

/* ------------------------------------------------------------------ */
/* Checking signatures of opened documents                              */
/* ------------------------------------------------------------------ */

export type SignatureState = 'valid' | 'modified' | 'invalid' | 'unknown';

export interface SignatureInfo {
  id: string;
  field: string;
  signer: string;
  cert: CertInfo | null;
  time: Date | null;
  reason: string | null;
  location: string | null;
  state: SignatureState;
  /** Updates appended to the file after this signature. */
  laterUpdates: number;
  timestamped: boolean;
  problem?: string;
}

interface PdfjsSignature {
  id: string;
  fieldName: string;
  signerName: string | null;
  reason: string | null;
  location: string | null;
  signingTime: string | null;
  coversWholeDocument: boolean;
  modificationsAfterSignature: number;
}

/** pdf.js 6 reads signature dictionaries for us (byte ranges, later updates, the CMS blob). */
interface WithSignatures {
  getSignatures?: () => Promise<PdfjsSignature[] | null>;
  getSignatureData?: (id: string) => Promise<{ data: Uint8Array[]; pkcs7: Uint8Array } | null>;
}

export function parsePdfDate(s: string | null): Date | null {
  const m = s?.match(/^D?:?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Zz+-])?(\d{2})?'?(\d{2})?/);
  if (!m) return null;
  const utc = Date.UTC(Number(m[1]), Number(m[2] ?? 1) - 1, Number(m[3] ?? 1), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0));
  const sign = m[7] === '-' ? -1 : m[7] === '+' ? 1 : 0;
  return new Date(utc - sign * (Number(m[8] ?? 0) * 60 + Number(m[9] ?? 0)) * 60_000);
}

export async function checkSignatures(doc: SourceDoc): Promise<SignatureInfo[]> {
  const pdf = doc.pdf as unknown as WithSignatures;
  if (!pdf.getSignatures || !pdf.getSignatureData) return [];
  const list = (await pdf.getSignatures().catch(() => null)) ?? [];
  const out: SignatureInfo[] = [];
  for (const s of list) {
    const data = await pdf.getSignatureData(s.id).catch(() => null);
    const check = data ? await verifyCms(data.pkcs7, data.data) : null;
    let state: SignatureState = 'unknown';
    if (check && !check.problem) state = !check.intact || !check.signatureOk ? 'invalid' : s.coversWholeDocument ? 'valid' : 'modified';
    out.push({
      id: s.id,
      field: s.fieldName,
      signer: check?.signer?.name ?? s.signerName ?? 'Unknown signer',
      cert: check?.signer ?? null,
      time: check?.signingTime ?? parsePdfDate(s.signingTime),
      reason: s.reason,
      location: s.location,
      state,
      laterUpdates: s.modificationsAfterSignature,
      timestamped: !!check?.timestamped,
      problem: check?.problem ?? (data ? undefined : 'the signature could not be read'),
    });
  }
  return out;
}
