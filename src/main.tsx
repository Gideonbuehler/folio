import { createRoot } from 'react-dom/client';
import './pdfjs-layers.css';
import './styles.css';
import { App } from './App';
import { openDocuments, useStore } from './store';

if (import.meta.env.DEV) {
  // Debug handle for the dev server only; never part of a production build.
  (window as unknown as { folio: unknown }).folio = {
    store: useStore,
    open: (bytes: Uint8Array, name = 'test.pdf') => openDocuments([{ file: new File([bytes as BlobPart], name, { type: 'application/pdf' }), handle: null }]),
    build: () => import('./lib/export').then(({ buildPdf }) => {
      const s = useStore.getState();
      return buildPdf({ docs: s.docs, pages: s.pages, objects: s.objects, meta: s.meta, ocr: s.ocr });
    }),
    recognize: (pageIds?: string[]) => import('./lib/ocr').then(({ recognizeText }) => recognizeText(pageIds)),
  };
}

createRoot(document.getElementById('root')!).render(<App />);
