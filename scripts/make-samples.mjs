// Builds sample PDFs for manual testing: text, images, a fillable form,
// bookmarks, an internal link, a rotated page and a landscape page.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { PDFDocument, StandardFonts, rgb, degrees, PDFName, PDFHexString, PDFNumber, pushGraphicsState, popGraphicsState, rectangle, clip, endPath } from '@cantoo/pdf-lib';

const out = process.env.FOLIO_SAMPLES_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'samples');
mkdirSync(out, { recursive: true });

/** A tiny PNG encoder so the samples need no image files. */
function png(width, height, pixel) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      const o = y * (width * 3 + 1) + 1 + x * 3;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// A sunset landscape and a bar chart.
const landscape = png(320, 200, (x, y) => {
  const sky = y < 120;
  const sun = (x - 220) ** 2 + (y - 80) ** 2 < 900;
  const hill = y > 120 + 25 * Math.sin(x / 40);
  if (sun) return [255, 196, 64];
  if (hill) return [46 + (y % 7), 120 + ((x * 3) % 20), 70];
  return sky ? [70 + y, 120 + y / 2, 200] : [90, 150, 90];
});
const chart = png(240, 160, (x, y) => {
  const bars = [60, 95, 80, 130];
  const i = Math.floor((x - 20) / 55);
  const inBar = i >= 0 && i < 4 && (x - 20) % 55 < 38 && y > 150 - bars[i];
  if (inBar) return [[76, 95, 213], [12, 133, 153], [247, 103, 7], [47, 158, 68]][i];
  if (y === 150 || x === 15) return [120, 120, 120];
  return [252, 252, 255];
});

const LOREM =
  'Folio keeps every change editable until you save. Highlights, notes and shapes are stored as objects on top of the original page, so the source file is never touched. When you save, the edits are written into a fresh document: drawings become page content, while comments stay real PDF annotations that any reader can open.';

function wrap(text, font, size, width) {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (font.widthOfTextAtSize(next, size) > width) {
      lines.push(line);
      line = w;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

const doc = await PDFDocument.create();
doc.setTitle('Folio sample document');
doc.setAuthor('Folio');
const helv = await doc.embedFont(StandardFonts.Helvetica);
const bold = await doc.embedFont(StandardFonts.HelveticaBold);
const times = await doc.embedFont(StandardFonts.TimesRoman);

// Page 1: headings and paragraphs
const p1 = doc.addPage([612, 792]);
p1.drawText('Quarterly Report', { x: 72, y: 700, size: 28, font: bold, color: rgb(0.12, 0.14, 0.2) });
p1.drawText('Prepared for the operations team', { x: 72, y: 672, size: 13, font: helv, color: rgb(0.4, 0.42, 0.48) });
let y = 620;
for (const para of [LOREM, 'Revenue grew 18 percent year over year, driven by renewals in the enterprise segment and a strong launch in the northern region. Operating costs stayed flat.', 'Next steps: finalize the vendor contract, confirm the audit date, and circulate the signed agreement to all department heads by Friday.']) {
  for (const line of wrap(para, helv, 12, 468)) {
    p1.drawText(line, { x: 72, y, size: 12, font: helv, color: rgb(0.1, 0.1, 0.12) });
    y -= 17;
  }
  y -= 12;
}
p1.drawText('Serif paragraph set in Times for the edit-text tool.', { x: 72, y: y - 10, size: 14, font: times, color: rgb(0.55, 0.1, 0.1) });
const landscapeImg = await doc.embedPng(landscape);
const chartImg = await doc.embedPng(chart);
p1.drawImage(landscapeImg, { x: 72, y: 258, width: 200, height: 125 });
p1.drawImage(chartImg, { x: 330, y: 258, width: 180, height: 120 });
p1.drawText('Figure 1: Site photo', { x: 72, y: 246, size: 9, font: helv, color: rgb(0.4, 0.42, 0.48) });
p1.drawText('Figure 2: Revenue by quarter', { x: 330, y: 246, size: 9, font: helv, color: rgb(0.4, 0.42, 0.48) });
p1.drawRectangle({ x: 72, y: 150, width: 468, height: 76, color: rgb(0.93, 0.95, 1), borderColor: rgb(0.6, 0.65, 0.9), borderWidth: 1 });
p1.drawText('Go to the form on page 2', { x: 90, y: 182, size: 13, font: bold, color: rgb(0.2, 0.3, 0.8) });

// Page 2: a fillable form
const p2 = doc.addPage([612, 792]);
p2.drawText('Application form', { x: 72, y: 700, size: 22, font: bold });
p2.drawText('Full name', { x: 72, y: 640, size: 11, font: helv });
p2.drawText('Email', { x: 72, y: 580, size: 11, font: helv });
p2.drawText('Department', { x: 72, y: 520, size: 11, font: helv });
p2.drawText('I agree to the terms', { x: 100, y: 466, size: 11, font: helv });
const form = doc.getForm();
const name = form.createTextField('applicant.name');
name.addToPage(p2, { x: 72, y: 608, width: 300, height: 24 });
const email = form.createTextField('applicant.email');
email.addToPage(p2, { x: 72, y: 548, width: 300, height: 24 });
const dept = form.createDropdown('applicant.dept');
dept.addOptions(['Engineering', 'Finance', 'Operations', 'Sales']);
dept.addToPage(p2, { x: 72, y: 488, width: 200, height: 24 });
const agree = form.createCheckBox('applicant.agree');
agree.addToPage(p2, { x: 72, y: 462, width: 18, height: 18 });

// Page 3: rotated page (/Rotate 90)
const p3 = doc.addPage([612, 792]);
p3.setRotation(degrees(90));
p3.drawText('This page carries /Rotate 90', { x: 72, y: 700, size: 20, font: bold });
for (const [i, line] of wrap(LOREM, helv, 12, 468).entries()) p3.drawText(line, { x: 72, y: 660 - i * 17, size: 12, font: helv });

// Page 4: landscape
const p4 = doc.addPage([792, 612]);
p4.drawText('Landscape appendix', { x: 72, y: 520, size: 22, font: bold });
for (const [i, line] of wrap(LOREM, times, 13, 640).entries()) p4.drawText(line, { x: 72, y: 480 - i * 18, size: 13, font: times });

// Internal link on page 1 -> page 2
const link = doc.context.obj({
  Type: 'Annot',
  Subtype: 'Link',
  Rect: [72, 150, 540, 226],
  Border: [0, 0, 0],
  Dest: [p2.ref, PDFName.of('XYZ'), null, 792, null],
});
p1.node.addAnnot(doc.context.register(link));

// Bookmarks
const ctx = doc.context;
const root = ctx.nextRef();
const items = [
  ['Quarterly Report', p1],
  ['Application form', p2],
  ['Rotated page', p3],
  ['Landscape appendix', p4],
];
const refs = items.map(() => ctx.nextRef());
items.forEach(([title, page], i) => {
  const d = ctx.obj({ Title: PDFHexString.fromText(title), Parent: root, Dest: [page.ref, PDFName.of('Fit')] });
  if (i > 0) d.set(PDFName.of('Prev'), refs[i - 1]);
  if (i < items.length - 1) d.set(PDFName.of('Next'), refs[i + 1]);
  ctx.assign(refs[i], d);
});
ctx.assign(root, ctx.obj({ Type: 'Outlines', First: refs[0], Last: refs[refs.length - 1], Count: PDFNumber.of(items.length) }));
doc.catalog.set(PDFName.of('Outlines'), root);

writeFileSync(join(out, 'sample.pdf'), await doc.save());

// A brochure-style page: gradient background, framed photos, light text.
const brochure = await PDFDocument.create();
const bp = brochure.addPage([792, 612]);
const bf = await brochure.embedFont(StandardFonts.Helvetica);
for (let i = 0; i < 160; i++) {
  const t = i / 159;
  const g = 0.27 + 0.3 * t;
  bp.drawRectangle({ x: 0, y: 612 - (i + 1) * (612 / 160), width: 792, height: 612 / 160 + 0.5, color: rgb(g, g, g + 0.01) });
}
const photo = (seed) =>
  png(240, 180, (x, y) => {
    if (x < 8 || y < 8 || x > 231 || y > 171) return [250, 250, 250];
    const v = Math.sin((x + seed) / 17) * Math.cos((y - seed) / 23);
    return [140 + 70 * v, 100 + 40 * v + (seed % 40), 70 + 30 * Math.sin(y / 9)].map((c) => Math.max(0, Math.min(255, Math.round(c))));
  });
for (const [i, [x, y]] of [
  [40, 330],
  [300, 330],
  [300, 90],
  [560, 90],
].entries()) {
  const img = await brochure.embedPng(photo(i * 37));
  if (i === 1) {
    // Cropped like a PowerPoint picture: clipped to a frame smaller than the image.
    bp.pushOperators(pushGraphicsState(), rectangle(x + 20, y + 15, 160, 120), clip(), endPath());
    bp.drawImage(img, { x, y, width: 200, height: 150 });
    bp.pushOperators(popGraphicsState());
  } else bp.drawImage(img, { x, y, width: 200, height: 150 });
}
for (const [i, line] of ['Rapid turnarounds, full turnkey', 'Detailed digital records and reports', 'Peace of mind'].entries()) {
  bp.drawText('-', { x: 470, y: 540 - i * 28, size: 18, font: bf, color: rgb(0.92, 0.92, 0.92) });
  bp.drawText(line, { x: 490, y: 540 - i * 28, size: 18, font: bf, color: rgb(0.92, 0.92, 0.92) });
}
writeFileSync(join(out, 'brochure.pdf'), await brochure.save());

// A second, short document for merge/insert tests
const extra = await PDFDocument.create();
const ef = await extra.embedFont(StandardFonts.HelveticaBold);
for (const label of ['Appendix A', 'Appendix B']) {
  const p = extra.addPage([612, 792]);
  p.drawText(label, { x: 72, y: 700, size: 26, font: ef, color: rgb(0.1, 0.45, 0.3) });
}
writeFileSync(join(out, 'appendix.pdf'), await extra.save());
// Calibri documents like Word writes them, for Edit mode font matching. Built
// from the system's Calibri when there is one (Windows); never committed.
const calibriDir = process.env.WINDIR ? join(process.env.WINDIR, 'Fonts') : '';
if (calibriDir && existsSync(join(calibriDir, 'calibri.ttf'))) {
  const fontkit = await import('@cantoo/fontkit');
  const plain = { liga: false, clig: false, dlig: false, hlig: false, calt: false, kern: false };
  // Calibri's embedded bitmaps stop fontkit from subsetting it (see src/lib/sfnt.ts).
  const outlinesOnly = (file) => {
    const b = readFileSync(join(calibriDir, file));
    const n = b.readUInt16BE(4);
    const keep = [];
    for (let i = 0; i < n; i++) {
      const o = 12 + i * 16;
      const tag = b.toString('latin1', o, o + 4);
      if (!['EBDT', 'EBLC', 'EBSC'].includes(tag)) keep.push({ rec: b.subarray(o, o + 16), off: b.readUInt32BE(o + 8), len: b.readUInt32BE(o + 12) });
    }
    const head = Buffer.alloc(12 + keep.length * 16);
    b.copy(head, 0, 0, 4);
    head.writeUInt16BE(keep.length, 4);
    const pow = 2 ** Math.floor(Math.log2(keep.length));
    head.writeUInt16BE(pow * 16, 6);
    head.writeUInt16BE(Math.log2(pow), 8);
    head.writeUInt16BE(keep.length * 16 - pow * 16, 10);
    const parts = [head];
    let at = head.length;
    keep.forEach((t, i) => {
      t.rec.copy(head, 12 + i * 16);
      head.writeUInt32BE(at, 12 + i * 16 + 8);
      const data = Buffer.alloc((t.len + 3) & ~3);
      b.copy(data, 0, t.off, t.off + t.len);
      parts.push(data);
      at += data.length;
    });
    return Buffer.concat(parts);
  };
  const paragraphs = [
    'Folio sets rewritten text in a font with the same character widths as the original, so a paragraph opened in Edit mode keeps its line breaks. Calibri is matched with Carlito, Cambria with Caladea, and Arial, Times New Roman and Courier New with the Liberation fonts.',
    'This second paragraph is long enough to wrap over several lines as well. Its last line is short, and the column is 468 points wide, the width of a Letter page with one-inch margins.',
    'Short closing paragraph.',
  ];
  for (const [file, subset] of [
    ['calibri.pdf', true],
    ['calibri-full.pdf', false],
  ]) {
    const cdoc = await PDFDocument.create();
    cdoc.registerFontkit(fontkit);
    const regular = await cdoc.embedFont(outlinesOnly('calibri.ttf'), { subset, features: plain });
    const boldFont = await cdoc.embedFont(outlinesOnly('calibrib.ttf'), { subset, features: plain });
    const cp = cdoc.addPage([612, 792]);
    cp.drawText('Project update', { x: 72, y: 700, size: 20, font: boldFont, color: rgb(0.13, 0.25, 0.45) });
    let cy = 660;
    for (const para of paragraphs) {
      for (const line of wrap(para, regular, 11, 468)) {
        cp.drawText(line, { x: 72, y: cy, size: 11, font: regular });
        cy -= 13.4;
      }
      cy -= 8;
    }
    writeFileSync(join(out, file), await cdoc.save());
  }
}

console.log('samples written to', out);
