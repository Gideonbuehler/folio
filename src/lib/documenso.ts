/**
 * Sending a request through Documenso (documenso.com, or a self-hosted one)
 * with its v2 API: the document goes up with its recipients and their fields
 * in one call, Documenso emails the signers and seals the signed document,
 * and Folio follows the status and fetches the result.
 *
 * Field positions are percentages of the page, measured from its top left
 * corner as the page is shown.
 */
import type { Envelope, SignRole } from './envelope';
import { responseError, serviceFetch, trimUrl, type DocumensoSettings } from './services';

const NAME = 'Documenso';

const TYPE: Record<SignRole, string> = {
  signature: 'SIGNATURE',
  initials: 'INITIALS',
  date: 'DATE',
  name: 'NAME',
  text: 'TEXT',
  checkbox: 'CHECKBOX',
};

/** A field for Documenso: page is 1-based, the rest in percent of the shown page. */
export interface DocumensoField {
  signer: string;
  role: SignRole;
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  required: boolean;
}

export interface DocumensoStatus {
  status: string;
  items: string[];
  recipients: { id: string | number; email: string; status: string; signedAt?: string | null; reason?: string | null }[];
}

const base = (s: DocumensoSettings) => `${trimUrl(s.url || 'https://app.documenso.com')}/api/v2`;

async function call(s: DocumensoSettings, path: string, init: RequestInit = {}): Promise<Response> {
  let res: Response;
  try {
    res = await serviceFetch(`${base(s)}${path}`, { ...init, headers: { Authorization: s.token.trim(), ...(init.headers ?? {}) } });
  } catch (e) {
    throw new Error(`Couldn't reach ${NAME}${typeof window !== 'undefined' && !('__TAURI_INTERNALS__' in window) ? ' (the browser may block it; use the desktop app)' : ''}: ${(e as Error).message}`);
  }
  if (!res.ok) throw await responseError(res, NAME);
  return res;
}

async function json<T>(s: DocumensoSettings, path: string, init: RequestInit = {}) {
  return (await (await call(s, path, init)).json()) as T;
}

/** Checks the address and token. */
export async function checkDocumenso(s: DocumensoSettings) {
  await call(s, '/envelope?page=1&perPage=1');
}

const pct = (v: number) => Math.round(Math.max(0, Math.min(100, v)) * 100) / 100;

/** Uploads the document with its signers and fields, and has Documenso send it. Returns the envelope id. */
export async function sendDocumenso(s: DocumensoSettings, env: Envelope, bytes: Uint8Array, fields: DocumensoField[]) {
  const payload = {
    type: 'DOCUMENT',
    title: env.title,
    externalId: env.id,
    meta: {
      subject: env.subject || `Please sign: ${env.title}`,
      message: env.message,
      signingOrder: env.order === 'sequential' ? 'SEQUENTIAL' : 'PARALLEL',
    },
    recipients: env.signers.map((x, i) => ({
      email: x.email,
      name: x.name,
      role: 'SIGNER',
      signingOrder: i + 1,
      fields: fields
        .filter((f) => f.signer === x.id)
        .map((f) => ({
          identifier: 0,
          type: TYPE[f.role],
          page: f.page,
          positionX: pct(f.x),
          positionY: pct(f.y),
          width: pct(f.w),
          height: pct(f.h),
        })),
    })),
  };
  const form = new FormData();
  form.append('payload', JSON.stringify(payload));
  form.append('files', new Blob([bytes as BlobPart], { type: 'application/pdf' }), `${env.title.replace(/[\\/:*?"<>|]/g, '_') || 'Document'}.pdf`);
  const created = await json<{ id: string }>(s, '/envelope/create', { method: 'POST', body: form });
  await call(s, '/envelope/distribute', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ envelopeId: created.id }) });
  return created.id;
}

interface RawEnvelope {
  status?: string;
  envelopeItems?: { id: string }[];
  recipients?: { id: string | number; email: string; signingStatus?: string; signedAt?: string | null; rejectionReason?: string | null }[];
}

export async function documensoStatus(s: DocumensoSettings, id: string): Promise<DocumensoStatus> {
  const e = await json<RawEnvelope>(s, `/envelope/${encodeURIComponent(id)}`);
  return {
    status: e.status ?? 'UNKNOWN',
    items: (e.envelopeItems ?? []).map((x) => x.id),
    recipients: (e.recipients ?? []).map((r) => ({ id: r.id, email: r.email, status: r.signingStatus ?? 'NOT_SIGNED', signedAt: r.signedAt, reason: r.rejectionReason })),
  };
}

export async function documensoSigned(s: DocumensoSettings, itemId: string) {
  const res = await call(s, `/envelope/item/${encodeURIComponent(itemId)}/download?version=signed`);
  return new Uint8Array(await res.arrayBuffer());
}

export async function documensoRemind(s: DocumensoSettings, id: string, recipients: (string | number)[]) {
  await call(s, '/envelope/redistribute', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ envelopeId: id, recipients }) });
}
