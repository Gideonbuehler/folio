// Reads the bundled fonts in public/fonts and writes src/lib/fonts.manifest.json:
// for every face its file, style, vertical metrics and the code points it covers.
// The editor uses the coverage to pick a font per character before a font is
// loaded, so it only fetches the faces a text needs. Run after changing the fonts:
//   node scripts/build-font-manifest.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fontkit from '@cantoo/fontkit';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'public', 'fonts');

/** family key -> file name stem per style (regular, bold, italic, bold italic). */
const FAMILIES = {
  sans: ['LiberationSans-Regular', 'LiberationSans-Bold', 'LiberationSans-Italic', 'LiberationSans-BoldItalic'],
  serif: ['LiberationSerif-Regular', 'LiberationSerif-Bold', 'LiberationSerif-Italic', 'LiberationSerif-BoldItalic'],
  mono: ['LiberationMono-Regular', 'LiberationMono-Bold', 'LiberationMono-Italic', 'LiberationMono-BoldItalic'],
  carlito: ['Carlito-Regular', 'Carlito-Bold', 'Carlito-Italic', 'Carlito-BoldItalic'],
  caladea: ['Caladea-Regular', 'Caladea-Bold', 'Caladea-Italic', 'Caladea-BoldItalic'],
  noto: ['NotoSans-Regular', 'NotoSans-Bold', 'NotoSans-Italic', 'NotoSans-BoldItalic'],
  symbols: ['NotoSansSymbols2-Regular'],
  cjk: ['DroidSansFallback'],
};

function ranges(codePoints) {
  const cps = [...new Set(codePoints)].filter((c) => c > 0).sort((a, b) => a - b);
  const out = [];
  for (const c of cps) {
    if (out.length && out[out.length - 1] === c - 1) out[out.length - 1] = c;
    else out.push(c, c);
  }
  return out;
}

const faces = [];
for (const [family, stems] of Object.entries(FAMILIES)) {
  stems.forEach((stem, i) => {
    const file = `${stem}.ttf`;
    const font = fontkit.create(readFileSync(join(dir, file)));
    const os2 = font['OS/2'];
    const upm = font.unitsPerEm;
    // What browsers use for the line box: typo metrics when the font asks for
    // them, else hhea (equal to the Windows metrics in all of these fonts).
    const useTypo = !!os2?.fsSelection?.useTypoMetrics;
    const ascent = useTypo ? os2.typoAscender : font.hhea.ascent;
    const descent = -(useTypo ? os2.typoDescender : font.hhea.descent);
    faces.push({
      id: `${family}-${i}`,
      family,
      file,
      ps: font.postscriptName,
      weight: i % 2 ? 700 : 400,
      style: i >= 2 ? 'italic' : 'normal',
      ascent: Number((ascent / upm).toFixed(4)),
      descent: Number((descent / upm).toFixed(4)),
      ranges: ranges(font.characterSet),
    });
  });
}

const target = join(root, 'src', 'lib', 'fonts.manifest.json');
writeFileSync(target, `${JSON.stringify({ faces })}\n`);
console.log(`${faces.length} faces written to ${target}`);
