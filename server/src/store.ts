/**
 * Requests on disk: <data>/requests/<id>/request.json with the request and
 * its audit trail, and the PDFs next to it (0.pdf is what was sent, then one
 * per returned signature, final.pdf once the sender finalized it). Everything
 * is also held in memory, indexed by signing token.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type RecipientStatus = 'waiting' | 'sent' | 'viewed' | 'signed' | 'declined';

export interface Recipient {
  /** The signer's id in the envelope inside the PDF. */
  signer: string;
  name: string;
  email: string;
  token: string;
  status: RecipientStatus;
  sentAt?: number;
  viewedAt?: number;
  signedAt?: number;
  declinedAt?: number;
  reason?: string;
}

export interface AuditEntry {
  at: number;
  type: 'created' | 'emailed' | 'viewed' | 'signed' | 'declined' | 'reminded' | 'completed' | 'downloaded' | 'cancelled';
  signer?: string;
  ip?: string;
  ua?: string;
  note?: string;
}

export interface Copy {
  n: number;
  /** Who returned it; null for the copy that was sent. */
  signer: string | null;
  at: number;
  sha256: string;
  size: number;
}

export interface StoredRequest {
  id: string;
  /** Hash of the sender's API key. */
  owner: string;
  /** The envelope's own id (from the PDF), so the sender's Folio can match them. */
  envelope: string;
  title: string;
  subject: string;
  message: string;
  sender: { name: string; email: string };
  order: 'sequential' | 'parallel';
  createdAt: number;
  updatedAt: number;
  status: 'out' | 'declined' | 'completed' | 'cancelled';
  recipients: Recipient[];
  copies: Copy[];
  final?: Copy;
  audit: AuditEntry[];
}

export const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');
export const newId = () => randomBytes(12).toString('base64url');

export class Store {
  private byId = new Map<string, StoredRequest>();
  private byToken = new Map<string, { id: string; signer: string }>();
  private locks = new Map<string, Promise<unknown>>();
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = join(dataDir, 'requests');
  }

  async load() {
    await mkdir(this.dir, { recursive: true });
    for (const id of await readdir(this.dir)) {
      const file = join(this.dir, id, 'request.json');
      if (!existsSync(file)) continue;
      try {
        this.index(JSON.parse(await readFile(file, 'utf8')) as StoredRequest);
      } catch (e) {
        console.warn(`Skipping unreadable request ${id}:`, e);
      }
    }
    return this.byId.size;
  }

  private index(r: StoredRequest) {
    this.byId.set(r.id, r);
    for (const x of r.recipients) this.byToken.set(x.token, { id: r.id, signer: x.signer });
  }

  get(id: string) {
    return this.byId.get(id);
  }

  byOwner(owner: string) {
    return [...this.byId.values()].filter((r) => r.owner === owner).sort((a, b) => b.createdAt - a.createdAt);
  }

  /** The request and recipient a signing token belongs to. */
  forToken(token: string) {
    const hit = this.byToken.get(token);
    const r = hit && this.byId.get(hit.id);
    const x = r?.recipients.find((p) => p.signer === hit!.signer);
    return r && x ? { request: r, recipient: x } : null;
  }

  /** Runs changes to one request one at a time. */
  async update<T>(id: string, fn: (r: StoredRequest) => Promise<T> | T): Promise<T> {
    const prev = this.locks.get(id) ?? Promise.resolve();
    const run = prev.then(async () => {
      const r = this.byId.get(id);
      if (!r) throw new HttpError(404, 'No such request');
      const out = await fn(r);
      r.updatedAt = Date.now();
      await this.save(r);
      return out;
    });
    this.locks.set(id, run.catch(() => {}));
    return run;
  }

  async create(r: StoredRequest, pdf: Uint8Array) {
    await mkdir(join(this.dir, r.id), { recursive: true });
    await this.writePdf(r.id, '0', pdf);
    await this.save(r);
    this.index(r);
  }

  private async save(r: StoredRequest) {
    const file = join(this.dir, r.id, 'request.json');
    await writeFile(`${file}.tmp`, JSON.stringify(r, null, 1));
    await rename(`${file}.tmp`, file);
  }

  async writePdf(id: string, name: string, bytes: Uint8Array) {
    const file = join(this.dir, id, `${name}.pdf`);
    await writeFile(`${file}.tmp`, bytes);
    await rename(`${file}.tmp`, file);
  }

  readPdf(id: string, name: string) {
    return readFile(join(this.dir, id, `${name}.pdf`));
  }

  async remove(id: string) {
    const r = this.byId.get(id);
    if (!r) return;
    for (const x of r.recipients) this.byToken.delete(x.token);
    this.byId.delete(id);
    await rm(join(this.dir, id), { recursive: true, force: true });
  }
}

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
