// Clears the reserved bit 7 in the point flags of every simple glyph of a
// TrueType font, in place, and fixes up the checksums. Droid Sans Fallback
// (Android 4.4) sets it; FreeType ignores it but Chrome's font sanitizer
// rejects the whole font. Outlines are unchanged.
//   node scripts/fix-glyph-flags.mjs public/fonts/DroidSansFallback.ttf
import { readFileSync, writeFileSync } from 'node:fs';

const file = process.argv[2];
const b = readFileSync(file);
const tables = new Map();
for (let i = 0; i < b.readUInt16BE(4); i++) {
  const o = 12 + i * 16;
  tables.set(b.toString('latin1', o, o + 4), { rec: o, off: b.readUInt32BE(o + 8), len: b.readUInt32BE(o + 12) });
}
const head = tables.get('head');
const glyf = tables.get('glyf');
const longLoca = b.readInt16BE(head.off + 50) === 1;
const numGlyphs = b.readUInt16BE(tables.get('maxp').off + 4);
const loca = tables.get('loca').off;
const at = (g) => (longLoca ? b.readUInt32BE(loca + g * 4) : b.readUInt16BE(loca + g * 2) * 2);

let fixed = 0;
for (let g = 0; g < numGlyphs; g++) {
  const start = glyf.off + at(g);
  if (at(g + 1) === at(g)) continue; // empty glyph
  const contours = b.readInt16BE(start);
  if (contours <= 0) continue; // composite
  const points = b.readUInt16BE(start + 10 + (contours - 1) * 2) + 1;
  let p = start + 10 + contours * 2;
  p += 2 + b.readUInt16BE(p); // instructions
  for (let n = 0; n < points; ) {
    const flag = b[p];
    if (flag & 0x80) {
      b[p] = flag & 0x7f;
      fixed++;
    }
    p++;
    let count = 1;
    if (flag & 0x08) count += b[p++];
    n += count;
  }
}

const sum = (off, len) => {
  let s = 0;
  for (let i = 0; i < len; i += 4) s = (s + (i + 4 <= len ? b.readUInt32BE(off + i) : Buffer.concat([b.subarray(off + i, off + len), Buffer.alloc(4)]).readUInt32BE(0))) >>> 0;
  return s;
};
b.writeUInt32BE(sum(glyf.off, glyf.len), glyf.rec + 4);
b.writeUInt32BE(0, head.off + 8);
b.writeUInt32BE(sum(head.off, head.len), head.rec + 4);
b.writeUInt32BE((0xb1b0afba - sum(0, b.length)) >>> 0, head.off + 8);
writeFileSync(file, b);
console.log(`${file}: cleared bit 7 in ${fixed} flags`);
