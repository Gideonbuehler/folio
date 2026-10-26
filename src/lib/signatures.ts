/** Keeps track of the signatures in the open documents, checking each document once. */
import { create } from 'zustand';
import { useStore } from '../store';
import { checkSignatures, type SignatureInfo } from './certsign';

/** Signatures found in each open source document, checked once per document. */
export const useSignatures = create<{ byDoc: Record<string, SignatureInfo[]> }>()(() => ({ byDoc: {} }));

const checking = new Set<string>();

function checkNewDocs() {
  const { docs } = useStore.getState();
  const known = useSignatures.getState().byDoc;
  for (const doc of Object.values(docs)) {
    if (known[doc.id] || checking.has(doc.id)) continue;
    checking.add(doc.id);
    checkSignatures(doc)
      .then((sigs) => useSignatures.setState((s) => ({ byDoc: { ...s.byDoc, [doc.id]: sigs } })))
      .catch((e) => console.warn('Signature check failed', e))
      .finally(() => checking.delete(doc.id));
  }
}

useStore.subscribe((s, prev) => {
  if (s.docs !== prev.docs) checkNewDocs();
});

/** Signatures of the documents the open pages come from. */
export function currentSignatures(byDoc: Record<string, SignatureInfo[]>, srcs: string[]) {
  return [...new Set(srcs)].flatMap((id) => byDoc[id] ?? []);
}

