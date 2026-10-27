/**
 * Signature requests ("envelopes"): who is asked to sign a document, which
 * form fields each of them fills in, and what has happened so far. The
 * envelope travels inside the PDF (a custom entry in the document
 * information dictionary), so it survives being emailed around: whoever
 * opens the file in Folio sees whose turn it is, and the sender's Folio
 * recognizes the copies that come back.
 */
import { PDFDict, PDFDocument, PDFHexString, PDFName, PDFString } from '@cantoo/pdf-lib';

export type SignRole = 'signature' | 'initials' | 'date' | 'name' | 'text' | 'checkbox';

export interface Signer {
  id: string;
  name: string;
  email: string;
  color: string;
}

export interface EnvelopeField {
  /** The AcroForm field's name in the file. */
  name: string;
  signer: string;
  role: SignRole;
  required: boolean;
}

export interface EnvelopeEvent {
  type: 'sent' | 'signed' | 'declined' | 'completed';
  at: number;
  signer?: string;
  /** Why a signer declined. */
  note?: string;
}

export interface Envelope {
  v: 1;
  id: string;
  title: string;
  sender: { name: string; email: string };
  signers: Signer[];
  /** Sequential: each signer passes the document on to the next. Parallel: everyone signs their own copy. */
  order: 'sequential' | 'parallel';
  subject: string;
  message: string;
  /** Fields in the file that belong to a signer. Fields still being designed carry their signer themselves. */
  fields: EnvelopeField[];
  events: EnvelopeEvent[];
  status: 'draft' | 'out' | 'completed';
}

export const SIGNER_COLORS = ['#2f6fed', '#d9480f', '#2b8a3e', '#ae3ec9', '#c2255c', '#0b7285', '#e67700', '#5f3dc4'];

export const ROLE_LABEL: Record<SignRole, string> = {
  signature: 'Signature',
  initials: 'Initials',
  date: 'Date signed',
  name: 'Name',
  text: 'Text',
  checkbox: 'Checkbox',
};

/** Prefix of the stamp annotations that hold a signer's signature or initials. */
export const STAMP_PREFIX = 'folio-sign:';

const KEY = 'FolioEnvelope';

export const signedAt = (env: Envelope, signer: string) => env.events.find((e) => e.type === 'signed' && e.signer === signer)?.at;
export const declined = (env: Envelope) => env.events.find((e) => e.type === 'declined');
export const signerById = (env: Envelope, id: string) => env.signers.find((s) => s.id === id);
export const sameEmail = (a: string, b: string) => !!a && a.trim().toLowerCase() === b.trim().toLowerCase();

export function pendingSigners(env: Envelope) {
  return env.signers.filter((s) => signedAt(env, s.id) === undefined);
}

/** Who may sign now: the next one in line, or everyone left when signing in parallel. */
export function signersUp(env: Envelope): Signer[] {
  if (env.status !== 'out' || declined(env)) return [];
  const left = pendingSigners(env);
  return env.order === 'sequential' ? left.slice(0, 1) : left;
}

export function firstName(name: string) {
  return name.trim().split(/\s+/)[0] || name;
}

export function initialsOf(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return parts.map((p) => p[0]!.toUpperCase()).join('').slice(0, 3);
}

export const isEmail = (s: string) => /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/.test(s.trim());

/** Date as filled into "Date signed" fields: plain ASCII, so the form font can show it. */
export function signingDate(at: number) {
  return new Date(at).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

export function when(at: number) {
  return new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** An envelope read from a file, or null if it isn't a usable one. */
export function parseEnvelope(raw: unknown): Envelope | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const e = JSON.parse(raw) as Envelope;
    if (e?.v !== 1 || typeof e.id !== 'string' || !Array.isArray(e.signers) || !Array.isArray(e.fields) || !Array.isArray(e.events)) return null;
    return { ...e, order: e.order === 'parallel' ? 'parallel' : 'sequential', status: e.status ?? 'out', subject: e.subject ?? '', message: e.message ?? '' };
  } catch {
    return null;
  }
}

/** The envelope in pdf.js document metadata (`getMetadata().info`). */
export function envelopeFromInfo(info: Record<string, unknown> | undefined): Envelope | null {
  // pdf.js 6 gives custom entries as a Map; older versions as a plain object.
  const custom = info?.Custom as Map<string, unknown> | Record<string, unknown> | undefined;
  return parseEnvelope(custom instanceof Map ? custom.get(KEY) : custom?.[KEY]);
}

function infoDict(doc: PDFDocument): PDFDict {
  // pdf-lib keeps this private, though it is the supported way to the Info dictionary.
  return (doc as unknown as { getInfoDict(): PDFDict }).getInfoDict();
}

/** The envelope in a document loaded with pdf-lib. */
export function readEnvelope(doc: PDFDocument): Envelope | null {
  const v = infoDict(doc).lookup(PDFName.of(KEY));
  return v instanceof PDFHexString || v instanceof PDFString ? parseEnvelope(v.decodeText()) : null;
}

export function writeEnvelope(doc: PDFDocument, env: Envelope | null) {
  const info = infoDict(doc);
  if (env) info.set(PDFName.of(KEY), PDFHexString.fromText(JSON.stringify(env)));
  else info.delete(PDFName.of(KEY));
}

/** Events of both envelopes, each once, in time order. */
export function mergeEvents(a: EnvelopeEvent[], b: EnvelopeEvent[]) {
  const seen = new Set<string>();
  return [...a, ...b]
    .filter((e) => {
      const k = `${e.type}|${e.signer ?? ''}|${e.at}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((x, y) => x.at - y.at);
}

/** SHA-256 of some bytes, as hex. */
export async function sha256(bytes: Uint8Array) {
  const d = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
