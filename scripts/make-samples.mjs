// Builds sample PDFs for manual testing: text, images, a fillable form,
// bookmarks, an internal link, a rotated page and a landscape page.
import { mkdirSync, writeFileSync } from 'node:fs';
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

// A scanned document for text recognition: text pages rendered to pictures at
// 200 dpi on slightly grey, speckled paper, with only the pictures kept, plus
// one born-digital page that already has text and must be left alone.
await scannedSample();

async function scannedSample() {
  let createCanvas, pdfjs;
  try {
    ({ createCanvas } = await import('@napi-rs/canvas'));
    pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  } catch {
    console.warn('@napi-rs/canvas is not available; skipping scanned.pdf');
    return;
  }
  const typeset = await PDFDocument.create();
  const sb = await typeset.embedFont(StandardFonts.HelveticaBold);
  const sr = await typeset.embedFont(StandardFonts.TimesRoman);
  const sh = await typeset.embedFont(StandardFonts.Helvetica);
  const ink = rgb(0.08, 0.08, 0.1);
  const paragraph = (page, text, top, font = sr, size = 12) => {
    for (const line of wrap(text, font, size, 468)) {
      page.drawText(line, { x: 72, y: top, size, font, color: ink });
      top -= size * 1.45;
    }
    return top - size * 0.8;
  };

  const a = typeset.addPage([612, 792]);
  a.drawText('Service Agreement', { x: 72, y: 700, size: 24, font: sb, color: ink });
  a.drawText('Northwind Traders and Contoso Logistics', { x: 72, y: 674, size: 13, font: sh, color: ink });
  let top = paragraph(
    a,
    'This agreement sets out the terms under which Contoso Logistics will store and deliver goods for Northwind Traders. It starts on the first day of the month after both parties sign and runs for twelve months.',
    630,
  );
  top = paragraph(
    a,
    'Invoices are sent monthly and are due within thirty days. Late payments carry interest at two percent per month. Either party may end the agreement with ninety days written notice.',
    top,
  );
  a.drawText('Account number: 4417 2290 1185', { x: 72, y: top, size: 12, font: sr, color: ink });
  a.drawText('Contact: Dana Whitfield, 555-0148', { x: 72, y: top - 20, size: 12, font: sr, color: ink });
  a.drawText('Signed for Northwind Traders', { x: 72, y: 150, size: 11, font: sh, color: ink });
  a.drawLine({ start: { x: 72, y: 170 }, end: { x: 300, y: 170 }, thickness: 0.8, color: ink });

  const b = typeset.addPage([612, 792]);
  b.drawText('Meeting notes', { x: 72, y: 700, size: 22, font: sb, color: ink });
  top = paragraph(b, 'The warehouse audit is scheduled for the second week of March. Bring the signed delivery records and the updated insurance certificate.', 660);
  for (const item of ['- Confirm the audit date with the operations team', '- Renew the forklift maintenance contract', '- Send the revised price list to every customer']) {
    b.drawText(item, { x: 90, y: top, size: 12, font: sr, color: ink });
    top -= 20;
  }

  const pdf = await pdfjs.getDocument({
    data: await typeset.save(),
    standardFontDataUrl: join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', 'pdfjs-dist', 'standard_fonts') + '/',
    disableFontFace: true,
    isEvalSupported: false,
  }).promise;
  const scan = await PDFDocument.create();
  scan.setTitle('Scanned agreement');
  let seed = 7;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 200 / 72 });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const px = img.data;
    for (let p = 0; p < px.length; p += 4) {
      const lum = 0.3 * px[p] + 0.59 * px[p + 1] + 0.11 * px[p + 2];
      // Paper tone, sensor noise and the odd speck of dust.
      let v = 28 + (lum / 255) * 218 + (random() - 0.5) * 14;
      if (random() < 0.0004) v = 70;
      px[p] = Math.max(0, Math.min(255, v + 2));
      px[p + 1] = Math.max(0, Math.min(255, v + 1));
      px[p + 2] = Math.max(0, Math.min(255, v - 3));
    }
    ctx.putImageData(img, 0, 0);
    const picture = await scan.embedJpg(await canvas.encode('jpeg', 85));
    scan.addPage([612, 792]).drawImage(picture, { x: 0, y: 0, width: 612, height: 792 });
  }
  const digital = scan.addPage([612, 792]);
  const df = await scan.embedFont(StandardFonts.Helvetica);
  digital.drawText('Appendix (born-digital page)', { x: 72, y: 700, size: 20, font: df });
  for (const [i, line] of wrap(LOREM, df, 12, 468).entries()) digital.drawText(line, { x: 72, y: 660 - i * 17, size: 12, font: df });
  writeFileSync(join(out, 'scanned.pdf'), await scan.save());
}

console.log('samples written to', out);
