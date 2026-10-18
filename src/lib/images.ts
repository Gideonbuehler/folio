import type { ImageObj, Point } from '../types';
import { actions, addObject, toast } from '../store';
import { loadImage, readFileDataUrl, uid } from './util';

const MAX_SIDE = 3000;

/** Reads an image file as PNG or JPEG (the formats a PDF can embed directly). */
export async function normalizeImage(file: Blob): Promise<{ src: string; w: number; h: number }> {
  const raw = await readFileDataUrl(file);
  const img = await loadImage(raw);
  let w = img.naturalWidth || 300;
  let h = img.naturalHeight || 200;
  const direct = /^data:image\/(png|jpe?g);/i.test(raw);
  if (direct && Math.max(w, h) <= MAX_SIDE) return { src: raw, w, h };
  const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
  w = Math.round(w * scale);
  h = Math.round(h * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d')!.drawImage(img, 0, 0, w, h);
  const jpeg = /^data:image\/jpe?g/i.test(raw);
  return { src: canvas.toDataURL(jpeg ? 'image/jpeg' : 'image/png', 0.92), w, h };
}

/** Places an image on a page, centered on `at` or on the page. */
export function placeImage(src: string, pxW: number, pxH: number, opts: { pageIndex?: number; at?: Point; signature?: boolean } = {}) {
  const s = actions.get();
  const page = s.pages[opts.pageIndex ?? s.currentPage];
  if (!page) return;
  const maxW = opts.signature ? Math.min(180, page.w * 0.4) : page.w * 0.5;
  const maxH = opts.signature ? 90 : page.h * 0.5;
  const ratio = pxW / pxH;
  let w = Math.min(maxW, pxW * 0.75);
  let h = w / ratio;
  if (h > maxH) {
    h = maxH;
    w = h * ratio;
  }
  const cx = opts.at?.x ?? page.w / 2;
  const cy = opts.at?.y ?? page.h / 2;
  const o: ImageObj = {
    id: uid(),
    page: page.id,
    created: Date.now(),
    author: s.userName,
    opacity: 1,
    type: 'image',
    x: Math.max(0, Math.min(page.w - w, cx - w / 2)),
    y: Math.max(0, Math.min(page.h - h, cy - h / 2)),
    w,
    h,
    src,
    signature: opts.signature,
  };
  addObject(o);
  actions.set({ tool: 'select' });
}

export async function insertImageFile(file: Blob, opts: { pageIndex?: number; at?: Point } = {}) {
  try {
    const img = await normalizeImage(file);
    placeImage(img.src, img.w, img.h, opts);
  } catch (e) {
    toast(`Couldn't insert image: ${(e as Error).message}`, 'error');
  }
}
