/**
 * Settings, all from the environment (a `.env` file next to package.json is
 * read too):
 *
 *   FOLIO_SIGN_KEYS        API keys of the people who may send requests, as
 *                          name=key pairs separated by commas. Create a key
 *                          with `npm run new-key`.
 *   FOLIO_SIGN_PUBLIC_URL  The address signers open, e.g. https://sign.example.com
 *   FOLIO_SIGN_PORT        Port to listen on (8787)
 *   FOLIO_SIGN_HOST        Interface to listen on (0.0.0.0)
 *   FOLIO_SIGN_DATA        Where documents and requests are kept (./data)
 *   FOLIO_SIGN_WEB         Folio's built web app, shown to signers (../dist)
 *   SMTP_URL               Mail server, e.g. smtps://user:password@smtp.example.com:465.
 *                          Without it, mail is written to <data>/outbox as .eml files.
 *   MAIL_FROM              Sender address for mail, e.g. "Folio Sign <sign@example.com>"
 *   FOLIO_SIGN_MAX_MB      Largest document accepted, in megabytes (50)
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Config {
  port: number;
  host: string;
  publicUrl: string;
  dataDir: string;
  webDir: string;
  /** sha256(key) in hex -> the sender's name. */
  keys: Map<string, string>;
  smtpUrl: string | null;
  mailFrom: string;
  maxBytes: number;
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Reads KEY=value lines from server/.env into the environment (values already set win). */
function loadDotEnv() {
  const file = resolve(root, '.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith('#')) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

export function loadConfig(hashKey: (key: string) => string): Config {
  loadDotEnv();
  const env = process.env;
  const port = Number(env.FOLIO_SIGN_PORT || 8787);
  const keys = new Map<string, string>();
  for (const part of (env.FOLIO_SIGN_KEYS || '').split(',')) {
    const item = part.trim();
    if (!item) continue;
    const eq = item.indexOf('=');
    const name = eq > 0 ? item.slice(0, eq).trim() : 'sender';
    const key = eq > 0 ? item.slice(eq + 1).trim() : item;
    if (key.length >= 24) keys.set(hashKey(key), name);
  }
  return {
    port,
    host: env.FOLIO_SIGN_HOST || '0.0.0.0',
    publicUrl: (env.FOLIO_SIGN_PUBLIC_URL || `http://localhost:${port}`).replace(/\/+$/, ''),
    dataDir: resolve(root, env.FOLIO_SIGN_DATA || 'data'),
    webDir: resolve(root, env.FOLIO_SIGN_WEB || '../dist'),
    keys,
    smtpUrl: env.SMTP_URL || null,
    mailFrom: env.MAIL_FROM || 'Folio Sign <no-reply@localhost>',
    maxBytes: Math.max(1, Number(env.FOLIO_SIGN_MAX_MB || 50)) * 1024 * 1024,
  };
}
