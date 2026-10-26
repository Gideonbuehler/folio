/**
 * Fonts embedded in an open PDF, offered to Edit mode so rewritten text keeps
 * the document's own font. A font program qualifies when it is TrueType or
 * OpenType with a Unicode character map, its license allows editing, and the
 * browser accepts it. Whether it can draw a given text is decided per object
 * (see activeDocFont in fontdb.ts); anything else uses the bundled match.
 */
import { decodePDFRawStream, PDFArray, PDFDict, PDFName, PDFRawStream, PDFStream } from '@cantoo/pdf-lib';
import type { PDFPageProxy } from 'pdfjs-dist';
import type { SourceDoc } from '../types';
import { addDocFont, loadFace, type DocFont } from './fontdb';
import { libFor } from './live';
import { lineFont, type TextLine } from './pdfjs';
import { withoutTables } from './sfnt';

/** `${doc id}|${pdf.js font id}` -> the usable font, or null when there is none. */
const found = new Map<string, DocFont | null>();
const pending = new Map<string, Promise<void>>();

/** The embedded font behind a pdf.js font id, once prepareDocFonts has looked at it. */
export function docFontFor(docId: string, fontName: string): DocFont | null {
  return found.get(`${docId}|${fontName}`) ?? null;
}

/** Looks for reusable font programs behind the fonts a page's text uses. */
export function prepareDocFonts(doc: SourceDoc, page: PDFPageProxy, index: number, fonts: Pick<TextLine, 'fontName' | 'cssFamily'>[]) {
  const jobs: Promise<void>[] = [];
  for (const f of fonts) {
    const key = `${doc.id}|${f.fontName}`;
    let job = pending.get(key);
    if (!job) {
      job = extract(doc, page, index, f)
        .catch((e) => {
          console.warn('Embedded font not reusable', f.fontName, e);
          return null;
        })
        .then((d) => {
          found.set(key, d);
        });
      pending.set(key, job);
    }
    jobs.push(job);
  }
  return Promise.all(jobs);
}

const SUBSET_TAG = /^[A-Z]{6}\+/;

async function extract(doc: SourceDoc, page: PDFPageProxy, index: number, line: Pick<TextLine, 'fontName' | 'cssFamily'>): Promise<DocFont | null> {
  const style = lineFont(page, { ...line, text: '' } as TextLine);
  if (!style.name) return null;
  const lib = await libFor(doc);
  const pdfPage = lib.getPages()[index];
  if (!pdfPage) return null;
  const program = findProgram(pdfPage.node.Resources(), style.name, new Set(), 0);
  if (!program) return null;
  const bytes = withoutTables(program, ['EBDT', 'EBLC', 'EBSC']);

  const fontkit = await import('@cantoo/fontkit');
  const font = fontkit.create(bytes) as unknown as LooseFont;
  // The browser and fontkit must agree on the character map: a Unicode one only.
  // Subsets in PDFs often have none; their text is drawn by glyph id.
  const cmaps: { platformID: number; encodingID: number }[] = font?.cmap?.tables ?? [];
  if (!cmaps.some((t) => t.platformID === 0 || (t.platformID === 3 && (t.encodingID === 1 || t.encodingID === 10)))) return null;
  // Saving embeds a subset; make sure fontkit can write one.
  const trial = font.createSubset();
  trial.includeGlyph(font.glyphForCodePoint(font.characterSet.find((c) => c > 0x20) ?? 0x20)?.id ?? 0);
  trial.encode();
  const fs = font['OS/2']?.fsType;
  if (fs && (fs.noEmbedding || (fs.viewOnly && !fs.editable) || fs.noSubsetting || fs.bitmapOnly)) return null;

  const cover = new Set(font.characterSet.filter((c) => c > 0));
  const upm = font.unitsPerEm || 1000;
  const os2 = font['OS/2'];
  const typo = !!os2?.fsSelection?.useTypoMetrics;
  const d = addDocFont({
    // pdf-lib appends a random number to the names of fonts it embeds.
    name: style.name.replace(SUBSET_TAG, '').replace(/-\d{4,}$/, ''),
    subset: SUBSET_TAG.test(style.name),
    bold: style.bold,
    italic: style.italic,
    bytes,
    cover,
    ps: (font.postscriptName || style.name.replace(SUBSET_TAG, '')).replace(/[^\x21-\x7e]|[()<>[\]{}/%#]/g, ''),
    ascent: (typo ? os2.typoAscender : font.ascent) / upm,
    descent: -(typo ? os2.typoDescender : font.descent) / upm,
  });
  await loadFace(d.face);
  if (d.face.state !== 'ready') return null;
  // Take the vertical metrics the browser actually lays lines out with.
  const c = document.createElement('canvas').getContext('2d')!;
  c.font = `1000px "${d.face.css}"`;
  const m = c.measureText('H');
  if (m.fontBoundingBoxAscent > 0) {
    d.face.ascent = m.fontBoundingBoxAscent / 1000;
    d.face.descent = m.fontBoundingBoxDescent / 1000;
  }
  return d;
}

interface LooseFont {
  characterSet: number[];
  createSubset(): { includeGlyph(id: number): number; encode(): Uint8Array };
  glyphForCodePoint(cp: number): { id: number } | null;
  postscriptName: string | null;
  unitsPerEm: number;
  ascent: number;
  descent: number;
  cmap?: { tables?: { platformID: number; encodingID: number }[] };
  'OS/2'?: {
    fsType?: Record<string, boolean>;
    fsSelection?: Record<string, boolean>;
    typoAscender: number;
    typoDescender: number;
  };
}

const N = (s: string) => PDFName.of(s);

/** The TrueType or OpenType program of the font named `name` in these resources (or nested forms). */
function findProgram(res: PDFDict | undefined, name: string, seen: Set<PDFDict>, depth: number): Uint8Array | null {
  if (!res || seen.has(res) || depth > 4) return null;
  seen.add(res);
  const fonts = res.lookupMaybe(N('Font'), PDFDict);
  for (const [, ref] of fonts?.entries() ?? []) {
    const dict = fonts!.context.lookup(ref);
    if (!(dict instanceof PDFDict)) continue;
    const bytes = programOf(dict, name);
    if (bytes) return bytes;
  }
  const xobjects = res.lookupMaybe(N('XObject'), PDFDict);
  for (const [, ref] of xobjects?.entries() ?? []) {
    const xo = xobjects!.context.lookup(ref);
    if (!(xo instanceof PDFStream) || xo.dict.get(N('Subtype'))?.toString() !== '/Form') continue;
    const bytes = findProgram(xo.dict.lookupMaybe(N('Resources'), PDFDict), name, seen, depth + 1);
    if (bytes) return bytes;
  }
  return null;
}

function programOf(font: PDFDict, name: string): Uint8Array | null {
  let desc = font.lookupMaybe(N('FontDescriptor'), PDFDict);
  if (font.get(N('Subtype'))?.toString() === '/Type0') {
    const kids = font.lookupMaybe(N('DescendantFonts'), PDFArray);
    const cid = kids?.lookupMaybe(0, PDFDict);
    desc = cid?.lookupMaybe(N('FontDescriptor'), PDFDict);
  }
  const names = [font.get(N('BaseFont')), desc?.get(N('FontName'))].map((v) =>
    v
      ?.toString()
      .replace(/^\//, '')
      .replace(/#([0-9a-f]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16))),
  );
  if (!desc || !names.includes(name)) return null;
  const ff2 = desc.lookupMaybe(N('FontFile2'), PDFStream);
  const ff3 = desc.lookupMaybe(N('FontFile3'), PDFStream);
  const stream = ff2 ?? (ff3?.dict.get(N('Subtype'))?.toString() === '/OpenType' ? ff3 : undefined);
  if (!stream) return null;
  return stream instanceof PDFRawStream ? decodePDFRawStream(stream).decode() : stream.getContents();
}
