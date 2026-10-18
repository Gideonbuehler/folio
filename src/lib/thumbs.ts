import type { PDFPageProxy } from 'pdfjs-dist';
import type { PageItem, SourceDoc } from '../types';
import { viewportFor } from './pdfjs';

/**
 * Small page renders for the sidebar and the organizer, cached as object
 * URLs. Renders run two at a time so a long document doesn't stall the main
 * view.
 */
const cache = new Map<string, Promise<string>>();
const queue: (() => void)[] = [];
let running = 0;
const MAX_PARALLEL = 2;

function pump() {
  while (running < MAX_PARALLEL && queue.length) {
    running++;
    queue.shift()!();
  }
}

/**
 * Renders a page preview. `live` supplies an edited render of the page
 * (see live.ts) and its key, so previews show Edit-mode changes too.
 */
export function thumbnail(doc: SourceDoc, item: PageItem, cssWidth: number, live?: { page: PDFPageProxy; key: string }): Promise<string> {
  const px = Math.round(cssWidth * Math.min(2, window.devicePixelRatio || 1));
  const bucket = px <= 160 ? 160 : px <= 320 ? 320 : 480;
  const key = `${doc.id}:${item.index}:${item.rotation}:${bucket}:${live?.key ?? ''}`;
  let p = cache.get(key);
  if (p) return p;
  p = new Promise<string>((resolve, reject) => {
    queue.push(async () => {
      try {
        const page = live?.page ?? (await doc.pdf.getPage(item.index + 1));
        const base = viewportFor(page, item, 1);
        const vp = viewportFor(page, item, bucket / base.width);
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(vp.width);
        canvas.height = Math.ceil(vp.height);
        await page.render({ canvas, viewport: vp }).promise;
        const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
        canvas.width = canvas.height = 0;
        if (!blob) throw new Error('thumbnail failed');
        resolve(URL.createObjectURL(blob));
      } catch (e) {
        cache.delete(key);
        reject(e);
      } finally {
        running--;
        pump();
      }
    });
    pump();
  });
  cache.set(key, p);
  return p;
}
