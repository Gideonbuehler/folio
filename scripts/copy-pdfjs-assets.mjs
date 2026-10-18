// Copies the pdf.js runtime assets (character maps, standard fonts, wasm decoders,
// annotation icons) into public/ so the viewer can fetch them without a CDN.
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', 'pdfjs-dist');
const dest = join(root, 'public', 'pdfjs');

if (!existsSync(src)) {
  console.warn('pdfjs-dist not installed yet; skipping asset copy');
  process.exit(0);
}

mkdirSync(dest, { recursive: true });
for (const [from, to] of [
  ['cmaps', 'cmaps'],
  ['standard_fonts', 'standard_fonts'],
  ['wasm', 'wasm'],
  ['iccs', 'iccs'],
  [join('web', 'images'), 'images'],
]) {
  const p = join(src, from);
  if (existsSync(p)) cpSync(p, join(dest, to), { recursive: true });
}
console.log('pdf.js assets copied to public/pdfjs');
