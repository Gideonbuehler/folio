// Copies the OCR runtime (tesseract.js worker, WebAssembly core and language
// data) into public/ so text recognition runs on the device without a CDN.
//
// Languages are the @tesseract.js-data/<code> packages listed in package.json;
// adding one there (npm install @tesseract.js-data/deu) is all it takes.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const modules = join(root, 'node_modules');
const dest = join(root, 'public', 'tesseract');

if (!existsSync(join(modules, 'tesseract.js')) || !existsSync(join(modules, 'tesseract.js-core'))) {
  console.warn('tesseract.js not installed yet; skipping OCR asset copy');
  process.exit(0);
}

rmSync(dest, { recursive: true, force: true });
mkdirSync(join(dest, 'core'), { recursive: true });
mkdirSync(join(dest, 'lang'), { recursive: true });

copyFileSync(join(modules, 'tesseract.js', 'dist', 'worker.min.js'), join(dest, 'worker.min.js'));
// LSTM-only builds (the engine Folio uses); tesseract.js picks the fastest one
// the browser supports. The .wasm.js files carry the WebAssembly inline.
for (const name of ['tesseract-core-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js', 'tesseract-core-relaxedsimd-lstm.wasm.js']) {
  copyFileSync(join(modules, 'tesseract.js-core', name), join(dest, 'core', name));
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const prefix = '@tesseract.js-data/';
const wanted = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })
  .filter((name) => name.startsWith(prefix))
  .map((name) => name.slice(prefix.length))
  // English first: it's the default and the most common fallback.
  .sort((a, b) => (a === 'eng' ? -1 : b === 'eng' ? 1 : a.localeCompare(b)));
const languages = [];
for (const lang of wanted) {
  // "best_int" models: LSTM-only, accurate and small.
  const file = join(modules, '@tesseract.js-data', lang, '4.0.0_best_int', `${lang}.traineddata.gz`);
  if (!existsSync(file)) {
    console.warn(`OCR language data for "${lang}" not found; run npm install`);
    continue;
  }
  copyFileSync(file, join(dest, 'lang', `${lang}.traineddata.gz`));
  languages.push(lang);
}
writeFileSync(join(dest, 'languages.json'), JSON.stringify(languages));
console.log(`OCR assets copied to public/tesseract (${languages.join(', ') || 'no languages'})`);
