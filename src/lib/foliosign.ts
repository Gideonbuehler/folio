/**
 * Talking to a Folio Sign server (server/ in this repository): the sender's
 * API, with their key, and the signer's, with the token from their link.
 */
import type { Envelope } from './envelope';
import { responseError, toBase64, trimUrl, type FolioSignSettings } from './services';

export type RemoteRecipientStatus = 'waiting' | 'sent' | 'viewed' | 'signed' | 'declined';

export interface RemoteRecipient {
  signer: string;
  name: string;
  email: string;
  status: RemoteRecipientStatus;
  sentAt?: number;
  viewedAt?: number;
  signedAt?: number;
  declinedAt?: number;
  reason?: string;
}

export interface RemoteAudit {
  at: number;
  type: string;
  signer?: string;
  ip?: string;
  ua?: string;
  note?: string;
}

export interface RemoteRequest {
  id: string;
  envelope: string;
  title: string;
  status: 'out' | 'declined' | 'completed' | 'cancelled';
  recipients: RemoteRecipient[];
  copies: { n: number; signer: string | null; at: number; sha256: string; size: number }[];
  final: { at: number; sha256: string } | null;
  audit: RemoteAudit[];
}

const NAME = 'Folio Sign';

async function api<T>(s: FolioSignSettings, path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${trimUrl(s.url)}${path}`, { ...init, headers: { Authorization: `Bearer ${s.key.trim()}`, ...(init.headers ?? {}) } });
  } catch {
    throw new Error(`Couldn't reach ${NAME} at ${trimUrl(s.url)}`);
  }
  if (!res.ok) throw await responseError(res, NAME);
  if (res.status === 204) return undefined as T;
  const type = res.headers.get('Content-Type') ?? '';
  return (type.includes('application/pdf') ? new Uint8Array(await res.arrayBuffer()) : await res.json()) as T;
}

/** Checks the address and key; resolves to the name the key belongs to. */
export async function checkFolioSign(s: FolioSignSettings) {
  const h = await api<{ ok: boolean; service?: string; sender: string | null }>(s, '/api/health');
  if (h.service !== 'folio-sign') throw new Error(`That address isn't a ${NAME} server`);
  if (!h.sender) throw new Error(`${NAME} didn't accept the key`);
  return h.sender;
}

export async function createRemote(s: FolioSignSettings, env: Envelope, bytes: Uint8Array) {
  const body = JSON.stringify({
    envelope: {
      id: env.id,
      title: env.title,
      subject: env.subject,
      message: env.message,
      order: env.order,
      sender: env.sender,
      signers: env.signers.map(({ id, name, email }) => ({ id, name, email })),
    },
    pdf: await toBase64(bytes),
  });
  return api<RemoteRequest>(s, '/api/requests', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
}

export const getRemote = (s: FolioSignSettings, id: string) => api<RemoteRequest>(s, `/api/requests/${encodeURIComponent(id)}`);
export const remoteCopy = (s: FolioSignSettings, id: string, n: number) => api<Uint8Array>(s, `/api/requests/${encodeURIComponent(id)}/copies/${n}`);
export const remindRemote = (s: FolioSignSettings, id: string) => api<RemoteRequest>(s, `/api/requests/${encodeURIComponent(id)}/remind`, { method: 'POST' });
export const cancelRemote = (s: FolioSignSettings, id: string) => api<void>(s, `/api/requests/${encodeURIComponent(id)}`, { method: 'DELETE' });

export async function finalRemote(s: FolioSignSettings, id: string, bytes: Uint8Array) {
  const body = JSON.stringify({ pdf: await toBase64(bytes) });
  return api<RemoteRequest>(s, `/api/requests/${encodeURIComponent(id)}/final`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
}

/* ------------------------------------------------------------------ */
/* Signing links (same origin: the server serves this app)              */
/* ------------------------------------------------------------------ */

export type LinkState = 'ready' | 'waiting' | 'signed' | 'declined' | 'completed' | 'cancelled';

export interface LinkInfo {
  title: string;
  message: string;
  sender: { name: string; email: string };
  order: 'sequential' | 'parallel';
  state: LinkState;
  signer: { id: string; name: string; email: string };
  signers: { name: string; status: RemoteRecipientStatus }[];
}

async function link<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/sign/${encodeURIComponent(token)}${path}`, init);
  } catch {
    throw new Error("Couldn't reach the signing service. Check your connection and try again.");
  }
  if (!res.ok) {
    let msg = `The signing service answered ${res.status}`;
    try {
      msg = ((await res.json()) as { error?: string }).error || msg;
    } catch {
      /* not JSON */
    }
    throw new Error(msg);
  }
  const type = res.headers.get('Content-Type') ?? '';
  return (type.includes('application/pdf') ? new Uint8Array(await res.arrayBuffer()) : await res.json()) as T;
}

export const linkInfo = (token: string) => link<LinkInfo>(token, '');
export const linkDocument = (token: string) => link<Uint8Array>(token, '/document');
export const linkComplete = (token: string, bytes: Uint8Array) =>
  link<{ ok: boolean }>(token, '/complete', { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: bytes as BodyInit });
export const linkDecline = (token: string, reason: string) =>
  link<{ ok: boolean }>(token, '/decline', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }) });
