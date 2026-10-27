/**
 * Folio Sign: a small self-hosted signing service for Folio.
 *
 * Senders (with an API key, from Folio's Send for signature dialog) upload a
 * prepared document; every signer gets a personal link by email. The link
 * opens Folio's web app in signing mode, which takes them through their
 * fields and uploads the signed copy. The service passes the document on to
 * the next signer (or to everyone at once), records when each link was
 * opened and signed and from where, and tells the sender. The sender's Folio
 * collects the signed copies, checks them against what was sent, and
 * finalizes the document, which the service then sends to every signer.
 *
 *   node src/main.ts            run the service (settings: see config.ts)
 *   node src/main.ts new-key    print a new API key for FOLIO_SIGN_KEYS
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { loadConfig } from './config.ts';
import { mailer, type Message } from './mail.ts';
import { HttpError, newId, newToken, sha256, Store, type Recipient, type StoredRequest } from './store.ts';

const VERSION = '0.1.0';

if (process.argv[2] === 'new-key') {
  console.log(randomBytes(24).toString('base64url'));
  process.exit(0);
}

const config = loadConfig((key) => sha256(key));
const store = new Store(config.dataDir);
const send = await mailer(config);
const count = await store.load();

if (!config.keys.size) console.warn('FOLIO_SIGN_KEYS is empty: nobody can send requests. Create a key with `npm run new-key`.');
if (!existsSync(join(config.webDir, 'index.html'))) console.warn(`No Folio web app in ${config.webDir}: signing links won't open. Run \`npm run build\` in Folio first.`);

/* ------------------------------------------------------------------ */
/* HTTP helpers                                                         */
/* ------------------------------------------------------------------ */

function cors(res: ServerResponse) {
  // No cookies are used: the API key travels in the Authorization header.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Max-Age', '600');
}

function json(res: ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(data);
}

function pdf(res: ServerResponse, bytes: Uint8Array, name: string) {
  res.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Length': bytes.length,
    'Content-Disposition': `inline; filename="${name.replace(/[^\w .()-]/g, '_')}"`,
    'Cache-Control': 'no-store',
  });
  res.end(bytes);
}

async function body(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, 'The document is too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function jsonBody<T>(req: IncomingMessage, limit: number): Promise<T> {
  try {
    return JSON.parse((await body(req, limit)).toString('utf8')) as T;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, 'Expected JSON');
  }
}

function pdfBytes(data: Uint8Array) {
  if (data.length < 8 || Buffer.from(data.subarray(0, 1024)).indexOf('%PDF-') < 0) throw new HttpError(400, 'Expected a PDF');
  return data;
}

const ip = (req: IncomingMessage) => (String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket.remoteAddress || '').slice(0, 64);
const ua = (req: IncomingMessage) => String(req.headers['user-agent'] ?? '').slice(0, 300);

/** The sender an API key belongs to, as [owner hash, name]. */
function sender(req: IncomingMessage): [string, string] {
  const m = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ''));
  if (m) {
    const hash = sha256(m[1]);
    for (const [known, name] of config.keys) {
      if (timingSafeEqual(Buffer.from(known), Buffer.from(hash))) return [hash, name];
    }
  }
  throw new HttpError(401, 'Unknown API key');
}

function owned(req: IncomingMessage, id: string) {
  const [owner] = sender(req);
  const r = store.get(id);
  if (!r || r.owner !== owner) throw new HttpError(404, 'No such request');
  return r;
}

/* ------------------------------------------------------------------ */
/* Requests                                                             */
/* ------------------------------------------------------------------ */

const isEmail = (s: unknown): s is string => typeof s === 'string' && s.length <= 254 && /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/.test(s);
const text = (s: unknown, max: number) => (typeof s === 'string' ? s.trim().slice(0, max) : '');

const link = (x: Recipient) => `${config.publicUrl}/s/${x.token}`;
const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;

/** The signers who may sign now. */
function up(r: StoredRequest) {
  if (r.status !== 'out') return [];
  const left = r.recipients.filter((x) => x.status !== 'signed');
  return r.order === 'sequential' ? left.slice(0, 1) : left;
}

type SignerState = 'ready' | 'waiting' | 'signed' | 'declined' | 'completed' | 'cancelled';

function stateOf(r: StoredRequest, x: Recipient): SignerState {
  if (r.status === 'completed') return 'completed';
  if (r.status === 'cancelled') return 'cancelled';
  if (x.status === 'signed') return 'signed';
  if (r.status === 'declined') return 'declined';
  return up(r).includes(x) ? 'ready' : 'waiting';
}

function senderView(r: StoredRequest) {
  return {
    id: r.id,
    envelope: r.envelope,
    title: r.title,
    status: r.status,
    order: r.order,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    recipients: r.recipients.map(({ token: _token, ...x }) => x),
    copies: r.copies,
    final: r.final ?? null,
    audit: r.audit,
  };
}

async function mail(r: StoredRequest, m: Message) {
  try {
    await send(m);
    return true;
  } catch (e) {
    console.error(`Mail to ${m.to.email} failed:`, e);
    r.audit.push({ at: Date.now(), type: 'emailed', note: `Mail to ${m.to.email} failed: ${(e as Error).message}` });
    return false;
  }
}

async function invite(r: StoredRequest, x: Recipient, reminder = false) {
  const lines = [
    `Hi ${firstName(x.name)},`,
    '',
    reminder ? `A reminder: ${r.sender.name} is waiting for your signature on "${r.title}".` : `${r.sender.name} has asked you to sign "${r.title}".`,
    ...(r.message ? ['', r.message] : []),
    '',
    'Review and sign it here:',
    link(x),
    '',
    'This link is just for you. Please don\'t forward it.',
    '',
    `Sent with Folio Sign on behalf of ${r.sender.name} (${r.sender.email}).`,
  ];
  const ok = await mail(r, {
    to: { name: x.name, email: x.email },
    replyTo: r.sender,
    fromName: r.sender.name,
    subject: reminder ? `Reminder: ${r.subject}` : r.subject,
    text: lines.join('\n'),
  });
  if (!ok) return;
  if (x.status === 'waiting') x.status = 'sent';
  x.sentAt ??= Date.now();
  r.audit.push({ at: Date.now(), type: reminder ? 'reminded' : 'emailed', signer: x.signer });
}

function tellSender(r: StoredRequest, subject: string, lines: string[]) {
  return mail(r, { to: r.sender, subject, text: [`Hi ${firstName(r.sender.name)},`, '', ...lines, '', 'Open Folio and choose File > Signature requests to see it.'].join('\n') });
}

interface CreateBody {
  envelope?: {
    id?: string;
    title?: string;
    subject?: string;
    message?: string;
    order?: string;
    sender?: { name?: string; email?: string };
    signers?: { id?: string; name?: string; email?: string }[];
  };
  pdf?: string;
}

async function createRequest(req: IncomingMessage, res: ServerResponse) {
  const [owner, senderName] = sender(req);
  const b = await jsonBody<CreateBody>(req, Math.ceil(config.maxBytes * 1.4) + 1_000_000);
  const env = b.envelope ?? {};
  const signers = Array.isArray(env.signers) ? env.signers : [];
  if (!signers.length || signers.length > 50) throw new HttpError(400, 'A request needs between 1 and 50 signers');
  for (const s of signers) {
    if (typeof s.id !== 'string' || !s.id || !text(s.name, 200) || !isEmail(s.email)) throw new HttpError(400, 'Every signer needs a name and a valid email address');
  }
  if (!isEmail(env.sender?.email)) throw new HttpError(400, "The sender's email address is missing");
  const bytes = pdfBytes(Buffer.from(String(b.pdf ?? ''), 'base64'));
  if (bytes.length > config.maxBytes) throw new HttpError(413, 'The document is too large');
  const now = Date.now();
  const title = text(env.title, 300) || 'Document';
  const r: StoredRequest = {
    id: newId(),
    owner,
    envelope: text(env.id, 100),
    title,
    subject: text(env.subject, 300) || `Please sign: ${title}`,
    message: text(env.message, 5000),
    sender: { name: text(env.sender?.name, 200) || senderName, email: env.sender!.email!.trim() },
    order: env.order === 'parallel' ? 'parallel' : 'sequential',
    createdAt: now,
    updatedAt: now,
    status: 'out',
    recipients: signers.map((s) => ({ signer: s.id!, name: text(s.name, 200), email: s.email!.trim(), token: newToken(), status: 'waiting' })),
    copies: [{ n: 0, signer: null, at: now, sha256: sha256(bytes), size: bytes.length }],
    audit: [{ at: now, type: 'created', ip: ip(req), ua: ua(req) }],
  };
  await store.create(r, bytes);
  await store.update(r.id, async (cur) => {
    for (const x of up(cur)) await invite(cur, x);
  });
  json(res, 201, senderView(store.get(r.id)!));
}

/* ------------------------------------------------------------------ */
/* Routes                                                               */
/* ------------------------------------------------------------------ */

async function route(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  const method = req.method ?? 'GET';
  let m: RegExpExecArray | null;

  if (path.startsWith('/api/')) {
    cors(res);
    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (path === '/api/health') {
      const who = req.headers.authorization ? sender(req)[1] : null;
      return json(res, 200, { ok: true, service: 'folio-sign', version: VERSION, sender: who });
    }

    /* The sender's side. */
    if (path === '/api/requests' && method === 'POST') return createRequest(req, res);
    if (path === '/api/requests' && method === 'GET') {
      const [owner] = sender(req);
      return json(res, 200, store.byOwner(owner).map(senderView));
    }
    if ((m = /^\/api\/requests\/([\w-]+)$/.exec(path))) {
      const r = owned(req, m[1]);
      if (method === 'GET') return json(res, 200, senderView(r));
      if (method === 'DELETE') {
        await store.remove(r.id);
        res.writeHead(204);
        res.end();
        return;
      }
    }
    if ((m = /^\/api\/requests\/([\w-]+)\/copies\/(\d+)$/.exec(path)) && method === 'GET') {
      const r = owned(req, m[1]);
      const copy = r.copies.find((c) => c.n === Number(m![2]));
      if (!copy) throw new HttpError(404, 'No such copy');
      return pdf(res, await store.readPdf(r.id, String(copy.n)), `${r.title}.pdf`);
    }
    if ((m = /^\/api\/requests\/([\w-]+)\/remind$/.exec(path)) && method === 'POST') {
      const r = owned(req, m[1]);
      await store.update(r.id, async (cur) => {
        for (const x of up(cur)) await invite(cur, x, true);
      });
      return json(res, 200, senderView(r));
    }
    if ((m = /^\/api\/requests\/([\w-]+)\/final$/.exec(path)) && method === 'POST') {
      const r = owned(req, m[1]);
      const b = await jsonBody<{ pdf?: string }>(req, Math.ceil(config.maxBytes * 1.4) + 1_000_000);
      const bytes = pdfBytes(Buffer.from(String(b.pdf ?? ''), 'base64'));
      if (r.recipients.some((x) => x.status !== 'signed')) throw new HttpError(409, 'Not everyone has signed yet');
      await store.update(r.id, async (cur) => {
        await store.writePdf(cur.id, 'final', bytes);
        cur.final = { n: -1, signer: null, at: Date.now(), sha256: sha256(bytes), size: bytes.length };
        cur.status = 'completed';
        cur.audit.push({ at: Date.now(), type: 'completed', ip: ip(req), ua: ua(req) });
        for (const x of cur.recipients) {
          await mail(cur, {
            to: { name: x.name, email: x.email },
            replyTo: cur.sender,
            fromName: cur.sender.name,
            subject: `Signed: ${cur.title}`,
            text: [`Hi ${firstName(x.name)},`, '', `Everyone has signed "${cur.title}". Download the signed document here:`, link(x), '', `Sent with Folio Sign on behalf of ${cur.sender.name}.`].join('\n'),
          });
        }
      });
      return json(res, 200, senderView(r));
    }

    /* The signer's side: the token is the key. */
    if ((m = /^\/api\/sign\/([\w-]{20,})(\/[a-z]+)?$/.exec(path))) {
      const hit = store.forToken(m[1]);
      if (!hit) throw new HttpError(404, 'This signing link is not valid any more');
      const { request: r, recipient: x } = hit;
      const action = m[2] ?? '';
      const state = stateOf(r, x);
      if (action === '' && method === 'GET') {
        if (state === 'ready' && !x.viewedAt) {
          await store.update(r.id, (cur) => {
            const me = cur.recipients.find((p) => p.signer === x.signer)!;
            me.viewedAt = Date.now();
            if (me.status === 'sent' || me.status === 'waiting') me.status = 'viewed';
            cur.audit.push({ at: me.viewedAt, type: 'viewed', signer: me.signer, ip: ip(req), ua: ua(req) });
          });
        }
        return json(res, 200, {
          title: r.title,
          message: r.message,
          sender: r.sender,
          order: r.order,
          state,
          signer: { id: x.signer, name: x.name, email: x.email },
          signers: r.recipients.map((p) => ({ name: p.name, status: p.status })),
        });
      }
      if (action === '/document' && method === 'GET') {
        // In order, each signer gets the copy the one before them signed; otherwise everyone gets what was sent.
        const copy = state === 'completed' && r.final ? 'final' : r.order === 'sequential' ? String(r.copies.at(-1)!.n) : '0';
        if (copy === 'final') await store.update(r.id, (cur) => void cur.audit.push({ at: Date.now(), type: 'downloaded', signer: x.signer, ip: ip(req), ua: ua(req) }));
        return pdf(res, await store.readPdf(r.id, copy), `${r.title}.pdf`);
      }
      if (action === '/complete' && method === 'POST') {
        if (state !== 'ready') throw new HttpError(409, state === 'waiting' ? "It isn't your turn to sign yet" : 'This document can no longer be signed here');
        const bytes = pdfBytes(await body(req, config.maxBytes));
        await store.update(r.id, async (cur) => {
          const me = cur.recipients.find((p) => p.signer === x.signer)!;
          const n = cur.copies.length;
          await store.writePdf(cur.id, String(n), bytes);
          const hash = sha256(bytes);
          cur.copies.push({ n, signer: me.signer, at: Date.now(), sha256: hash, size: bytes.length });
          me.status = 'signed';
          me.signedAt = Date.now();
          cur.audit.push({ at: me.signedAt, type: 'signed', signer: me.signer, ip: ip(req), ua: ua(req), note: `SHA-256 ${hash}` });
          const next = up(cur);
          if (!next.length) {
            await tellSender(cur, `Everyone has signed: ${cur.title}`, [`${me.name} signed "${cur.title}", and with that everyone has signed.`, 'Finalize it in Folio to get the signed document and send it to the signers.']);
          } else {
            await tellSender(cur, `${me.name} signed: ${cur.title}`, [`${me.name} signed "${cur.title}".`, `Still to sign: ${next.map((p) => p.name).join(', ')}.`]);
            for (const p of next) if (p.status === 'waiting') await invite(cur, p);
          }
        });
        return json(res, 200, { ok: true, state: 'signed' });
      }
      if (action === '/decline' && method === 'POST') {
        if (state !== 'ready') throw new HttpError(409, 'This document can no longer be declined here');
        const b = await jsonBody<{ reason?: string }>(req, 20_000);
        const reason = text(b.reason, 2000);
        await store.update(r.id, async (cur) => {
          const me = cur.recipients.find((p) => p.signer === x.signer)!;
          me.status = 'declined';
          me.declinedAt = Date.now();
          me.reason = reason || undefined;
          cur.status = 'declined';
          cur.audit.push({ at: me.declinedAt, type: 'declined', signer: me.signer, ip: ip(req), ua: ua(req), note: reason || undefined });
          await tellSender(cur, `${me.name} declined: ${cur.title}`, [`${me.name} declined to sign "${cur.title}".`, ...(reason ? ['', `Reason: ${reason}`] : [])]);
        });
        return json(res, 200, { ok: true, state: 'declined' });
      }
    }
    throw new HttpError(404, 'Not found');
  }

  if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
  return serveWeb(path, res);
}

/* ------------------------------------------------------------------ */
/* Folio's web app, which is the signing page                           */
/* ------------------------------------------------------------------ */

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};

function serveWeb(path: string, res: ServerResponse) {
  // Signing links (and the start page) are the app itself.
  const file = path === '/' || /^\/s\/[\w-]+\/?$/.test(path) ? 'index.html' : decodeURIComponent(path).replace(/^\/+/, '');
  const full = normalize(join(config.webDir, file));
  if (!full.startsWith(config.webDir + sep) || !existsSync(full) || !statSync(full).isFile()) throw new HttpError(404, 'Not found');
  const html = full.endsWith('.html');
  res.writeHead(200, {
    'Content-Type': TYPES[extname(full).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': statSync(full).size,
    'Cache-Control': html ? 'no-cache' : file.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
    // Signing links carry their token in the path; it mustn't leak to other sites.
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    ...(html ? { 'X-Frame-Options': 'DENY' } : {}),
  });
  createReadStream(full).pipe(res);
}

/* ------------------------------------------------------------------ */

const server = createServer((req, res) => {
  route(req, res).catch((e: unknown) => {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error(e);
    if (res.headersSent) {
      res.destroy();
      return;
    }
    json(res, status, { error: status === 500 ? 'Something went wrong' : (e as Error).message });
  });
});

server.listen(config.port, config.host, () => {
  console.log(`Folio Sign ${VERSION} on http://${config.host}:${config.port} (links: ${config.publicUrl}), ${count} request${count === 1 ? '' : 's'}`);
});

