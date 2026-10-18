import type { SourceDoc } from '../types';
import { actions, scrollToPage } from '../store';
import { openExternal } from './native';

/**
 * The subset of pdf.js's link service the annotation layer calls: internal
 * links scroll the editor, external links open in a new tab.
 */
const services = new Map<string, object>();

export function linkServiceFor(doc: SourceDoc) {
  let svc = services.get(doc.id);
  if (svc) return svc;
  const gotoIndex = (index: number) => {
    const pages = actions.get().pages;
    const i = pages.findIndex((p) => p.src === doc.id && p.index === index);
    if (i >= 0) scrollToPage(i);
  };
  svc = {
    externalLinkEnabled: true,
    externalLinkTarget: 2,
    externalLinkRel: 'noopener noreferrer nofollow',
    eventBus: null,
    isInPresentationMode: false,
    get pagesCount() {
      return doc.pdf.numPages;
    },
    addLinkAttributes(link: HTMLAnchorElement, url: string) {
      link.href = url;
      link.title = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer nofollow';
      // Web links in a PDF open in the default browser, never inside the editor.
      link.onclick = (e) => {
        e.preventDefault();
        void openExternal(url);
      };
    },
    getDestinationHash: () => '#',
    getAnchorUrl: () => '#',
    async goToDestination(dest: string | unknown[]) {
      const explicit = typeof dest === 'string' ? await doc.pdf.getDestination(dest) : dest;
      if (!Array.isArray(explicit)) return;
      const ref = explicit[0];
      const index = typeof ref === 'number' ? ref : await doc.pdf.getPageIndex(ref as { num: number; gen: number });
      gotoIndex(index);
    },
    goToPage(n: number) {
      gotoIndex(n - 1);
    },
    executeNamedAction(action: string) {
      const s = actions.get();
      const cur = s.currentPage;
      if (action === 'NextPage') scrollToPage(cur + 1);
      else if (action === 'PrevPage') scrollToPage(cur - 1);
      else if (action === 'FirstPage') scrollToPage(0);
      else if (action === 'LastPage') scrollToPage(s.pages.length - 1);
    },
    executeSetOCGState() {},
    async getAttachmentContent() {
      return null;
    },
  };
  services.set(doc.id, svc);
  return svc;
}
