/**
 * Signing from a Folio Sign link: fetch the document for the signer the link
 * belongs to, take them through their fields, and upload the signed copy
 * (or their decline) instead of saving and emailing it.
 */
import { create } from 'zustand';
import { actions, openDocuments } from '../store';
import { linkComplete, linkDecline, linkDocument, linkInfo, type LinkInfo } from './foliosign';
import { download } from './files';
import { LINK_TOKEN } from './linkmode';
import { chooseSigner, startSigning } from './signing';

type Phase = 'loading' | 'signing' | 'done' | 'declined' | 'status' | 'error';

interface LinkSession {
  phase: Phase;
  info: LinkInfo | null;
  error: string | null;
  /** The copy the signer just signed, to keep if they want. */
  signed: Uint8Array | null;
}

export const useLink = create<LinkSession>()(() => ({ phase: 'loading', info: null, error: null, signed: null }));

export async function startLink() {
  if (!LINK_TOKEN) return;
  try {
    const info = await linkInfo(LINK_TOKEN);
    useLink.setState({ info });
    if (info.state !== 'ready') {
      useLink.setState({ phase: 'status' });
      return;
    }
    const bytes = await linkDocument(LINK_TOKEN);
    // Signing as the person the link was sent to; none of this is kept on the device.
    actions.set({ userName: info.signer.name, userEmail: info.signer.email });
    const tab = await openDocuments([{ file: new File([bytes as BlobPart], `${info.title}.pdf`, { type: 'application/pdf' }), handle: null }]);
    if (!tab) throw new Error("The document couldn't be opened");
    if (!actions.get().envelope) throw new Error('This document has no signature request in it');
    chooseSigner(tab, info.signer.id);
    startSigning(tab, info.signer.id);
    useLink.setState({ phase: 'signing' });
  } catch (e) {
    useLink.setState({ phase: 'error', error: (e as Error).message });
  }
}

export async function submitLink(bytes: Uint8Array) {
  await linkComplete(LINK_TOKEN!, bytes);
  useLink.setState({ phase: 'done', signed: bytes });
}

export async function declineLink(reason: string) {
  await linkDecline(LINK_TOKEN!, reason);
  useLink.setState({ phase: 'declined' });
}

/** The signed copy just uploaded, or once everyone has signed, the finished document. */
export async function downloadCopy() {
  const { signed, info } = useLink.getState();
  const bytes = signed ?? (await linkDocument(LINK_TOKEN!));
  const name = `${info?.title || 'Document'}${info?.state === 'completed' ? ' (signed)' : ''}.pdf`;
  await download(new Blob([bytes as BlobPart], { type: 'application/pdf' }), name);
}
