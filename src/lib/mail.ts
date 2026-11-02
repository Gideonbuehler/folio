/**
 * Handing a document to the user's email program. Folio never sends mail
 * itself: it opens a new message, addressed and with the PDF attached, for
 * the user to review and send.
 *
 * - Desktop with a mail program that takes attachments (Simple MAPI: classic
 *   Outlook, Thunderbird, ...): the message opens with the file attached.
 * - Otherwise: the file is saved where the user chooses and shown in its
 *   folder, and a mailto: link opens the message for them to attach it.
 * - Browser: the system share sheet when it can share files, else a download
 *   and a mailto: link.
 */
import { toast } from '../store';
import { download, isPathRef, type FileRef } from './files';
import { baseNameOf, chooseSavePath, dataWrite, isDesktop, openExternal, writePath } from './native';

export interface Recipient {
  name: string;
  email: string;
}

export interface Mail {
  to: Recipient[];
  cc?: Recipient[];
  subject: string;
  body: string;
}

/**
 * Where the attachment comes from: a file already saved, or bytes to attach
 * (`saved` when the user already has them as a download).
 */
export type Attachment = { ref: FileRef; name: string } | { bytes: Uint8Array; name: string; saved?: boolean };

const core = () => import('@tauri-apps/api/core');

let client: Promise<{ name: string; attachments: boolean }> | null = null;

/** The mail program messages open in, and whether files can be attached for the user. */
export function mailClient() {
  client ??= (async () => {
    if (!isDesktop) return { name: '', attachments: false };
    try {
      const { invoke } = await core();
      const [name, attachments] = await invoke<[string, boolean]>('mail_client');
      return { name, attachments };
    } catch {
      return { name: '', attachments: false };
    }
  })();
  return client;
}

/** How the message will be prepared, for the send dialogs. */
export async function mailMethodText() {
  const c = await mailClient();
  if (c.attachments) return `Folio opens a new message in ${c.name} with the document attached. Check it and click Send.`;
  if (isDesktop) return 'Folio saves the document, shows it in its folder and opens a new message in your email app. Attach the file and click Send.';
  if (canShareFiles()) return 'Choose your email app in the share window, check the message and click Send.';
  return 'Folio downloads the document and opens a new message in your email app. Attach the file and click Send.';
}

function canShareFiles() {
  try {
    const probe = new File([new Uint8Array(1)], 'probe.pdf', { type: 'application/pdf' });
    return typeof navigator.canShare === 'function' && navigator.canShare({ files: [probe] });
  } catch {
    return false;
  }
}

const safeName = (name: string) => name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'document';

export function mailtoUrl(m: Mail) {
  const list = (r: Recipient[]) => r.map((x) => encodeURIComponent(x.email.trim())).join(',');
  const q = [
    m.cc?.length ? `cc=${list(m.cc)}` : '',
    `subject=${encodeURIComponent(m.subject)}`,
    // Long links get cut off by some mail programs; the body is a courtesy.
    `body=${encodeURIComponent(m.body.length > 1500 ? `${m.body.slice(0, 1500)}…` : m.body)}`,
  ].filter(Boolean);
  return `mailto:${list(m.to)}?${q.join('&')}`;
}

/**
 * Opens a new message with the attachment. Resolves to false if the user
 * cancelled along the way (for example the save dialog).
 */
export async function composeMail(m: Mail, file: Attachment): Promise<boolean> {
  if (isDesktop) return composeDesktop(m, file);
  const bytes = 'bytes' in file ? file.bytes : null;
  if (bytes && canShareFiles()) {
    try {
      await navigator.share({ files: [new File([bytes as BlobPart], file.name, { type: 'application/pdf' })], title: m.subject, text: m.body });
      return true;
    } catch (e) {
      if ((e as Error).name === 'AbortError') return false;
      console.warn('Sharing failed; falling back to a download', e);
    }
  }
  if (bytes && !('saved' in file && file.saved)) await download(new Blob([bytes as BlobPart], { type: 'application/pdf' }), file.name);
  await openExternal(mailtoUrl(m));
  toast(`Attach ${file.name} to the message (it's in your downloads).`, 'info');
  return true;
}

async function composeDesktop(m: Mail, file: Attachment): Promise<boolean> {
  const { invoke } = await core();
  const c = await mailClient();
  const pair = (r: Recipient) => [r.name, r.email.trim()];
  let path = 'ref' in file && isPathRef(file.ref) ? file.ref.path : null;
  if (c.attachments) {
    try {
      if (!path && 'bytes' in file) {
        // A copy in Folio's own folder just for the mail program to pick up.
        const name = `outbox/${safeName(file.name.replace(/\.pdf$/i, ''))}.pdf`;
        await dataWrite(name, file.bytes);
        path = await invoke<string>('data_file_path', { name });
      }
      const result = await invoke<string>('compose_mail', {
        to: m.to.map(pair),
        cc: (m.cc ?? []).map(pair),
        subject: m.subject,
        body: m.body,
        attachment: path ? [path, file.name] : null,
      });
      return result !== 'cancelled';
    } catch (e) {
      console.warn('The mail program did not take the message; using a mailto link', e);
    }
  }
  if (!path && 'bytes' in file) {
    path = await chooseSavePath(file.name);
    if (!path) return false;
    await writePath(path, file.bytes);
  }
  if (path) {
    try {
      const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
      await revealItemInDir(path);
    } catch (e) {
      console.warn('Could not show the file', e);
    }
  }
  await openExternal(mailtoUrl(m));
  toast(path ? `Attach ${baseNameOf(path)} to the message; its folder is open.` : 'Attach the document to the message.', 'info');
  return true;
}
