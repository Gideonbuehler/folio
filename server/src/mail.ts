/**
 * Outgoing mail: through the SMTP server in SMTP_URL, or, without one, into
 * <data>/outbox as .eml files (open them in any mail program) so the whole
 * flow can be tried without a mail account.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from './config.ts';

export interface Message {
  to: { name: string; email: string };
  /** Answers go to the person the mail is about (the sender of a request). */
  replyTo?: { name: string; email: string };
  /** Shown as "<fromName> via Folio Sign". */
  fromName?: string;
  subject: string;
  text: string;
}

type Send = (m: Message) => Promise<void>;

const quote = (name: string) => `"${name.replace(/["\\\r\n]/g, '')}"`;
const address = (p: { name: string; email: string }) => (p.name ? `${quote(p.name)} <${p.email}>` : p.email);

function fromHeader(config: Config, m: Message) {
  const plain = /<([^>]+)>/.exec(config.mailFrom)?.[1] ?? config.mailFrom;
  const label = /^(.*?)\s*</.exec(config.mailFrom)?.[1]?.replace(/^"|"$/g, '') || 'Folio Sign';
  return m.fromName ? `${quote(`${m.fromName} via ${label}`)} <${plain}>` : config.mailFrom;
}

export async function mailer(config: Config): Promise<Send> {
  if (config.smtpUrl) {
    const nodemailer = await import('nodemailer');
    const transport = nodemailer.createTransport(config.smtpUrl);
    return async (m) => {
      await transport.sendMail({
        from: fromHeader(config, m),
        to: address(m.to),
        replyTo: m.replyTo ? address(m.replyTo) : undefined,
        subject: m.subject,
        text: m.text,
      });
    };
  }
  const outbox = join(config.dataDir, 'outbox');
  await mkdir(outbox, { recursive: true });
  console.log(`No SMTP_URL set: mail goes to ${outbox}`);
  let n = 0;
  return async (m) => {
    const headers = [
      `From: ${fromHeader(config, m)}`,
      `To: ${address(m.to)}`,
      ...(m.replyTo ? [`Reply-To: ${address(m.replyTo)}`] : []),
      `Subject: ${encodeHeader(m.subject)}`,
      `Date: ${new Date().toUTCString()}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: 8bit',
    ];
    const name = `${Date.now()}-${++n}-${m.to.email.replace(/[^a-z0-9@.-]/gi, '_')}.eml`;
    await writeFile(join(outbox, name), `${headers.join('\r\n')}\r\n\r\n${m.text.replace(/\r?\n/g, '\r\n')}\r\n`);
    console.log(`Mail to ${m.to.email}: ${m.subject} (${name})`);
  };
}

/** RFC 2047 for subjects with non-ASCII characters. */
function encodeHeader(s: string) {
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}
