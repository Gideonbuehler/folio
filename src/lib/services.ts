/**
 * Signing services a request can be sent with, besides the user's own email:
 * a Folio Sign server (server/ in this repository, self-hosted) or Documenso
 * (documenso.com or self-hosted). Their addresses and keys are kept on this
 * device only.
 */
import { create } from 'zustand';
import { isDesktop } from './native';

export type SendVia = 'email' | 'folio-sign' | 'documenso';

export interface FolioSignSettings {
  url: string;
  key: string;
}

export interface DocumensoSettings {
  url: string;
  token: string;
}

export interface Services {
  folioSign: FolioSignSettings | null;
  documenso: DocumensoSettings | null;
  /** How the last request was sent; the send dialog starts there. */
  via: SendVia;
}

const KEY = 'folio.services';

function load(): Services {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}') as Partial<Services>;
    return { folioSign: raw.folioSign ?? null, documenso: raw.documenso ?? null, via: raw.via ?? 'email' };
  } catch {
    return { folioSign: null, documenso: null, via: 'email' };
  }
}

export const useServices = create<Services>()(load);

export function setServices(patch: Partial<Services>) {
  useServices.setState(patch);
  try {
    localStorage.setItem(KEY, JSON.stringify(useServices.getState()));
  } catch {
    /* storage unavailable */
  }
}

export const VIA_LABEL: Record<SendVia, string> = {
  email: 'Your email',
  'folio-sign': 'Folio Sign',
  documenso: 'Documenso',
};

export const configured = (s: Services, via: SendVia) => via === 'email' || (via === 'folio-sign' ? !!s.folioSign : !!s.documenso);

export const trimUrl = (url: string) => url.trim().replace(/\/+$/, '');

/**
 * fetch for third-party services. The desktop app goes through its HTTP
 * plugin, which isn't bound by the CORS rules web pages are.
 */
export async function serviceFetch(url: string, init: RequestInit = {}): Promise<Response> {
  if (isDesktop) {
    const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http');
    return tauriFetch(url, init);
  }
  return fetch(url, init);
}

/** An error message from a JSON or text error response. */
export async function responseError(res: Response, what: string): Promise<Error> {
  let detail = '';
  try {
    const text = await res.text();
    try {
      const j = JSON.parse(text) as { error?: string; message?: string };
      detail = j.error || j.message || '';
    } catch {
      detail = text.slice(0, 200);
    }
  } catch {
    /* no body */
  }
  if (res.status === 401 || res.status === 403) return new Error(`${what} didn't accept the key${detail ? ` (${detail})` : ''}`);
  return new Error(`${what}: ${detail || `HTTP ${res.status}`}`);
}

/** Bytes as base64, without building one huge string by hand. */
export function toBase64(bytes: Uint8Array): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).slice(String(r.result).indexOf(',') + 1));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(new Blob([bytes as BlobPart]));
  });
}
