/**
 * Folio's version lives in package.json, package-lock.json,
 * src-tauri/tauri.conf.json, src-tauri/Cargo.toml and src-tauri/Cargo.lock.
 * This sets all of them at once, or checks that they agree.
 *
 *   npm run bump -- 0.2.0          set an exact version
 *   npm run bump -- patch          0.1.0 -> 0.1.1 (also minor, major)
 *   node scripts/version.mjs --check [v0.2.0]
 *                                  fail unless every file has the same version
 *                                  (and it matches the tag, if given)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/;

/** Where each file keeps the version: the first match is the one that counts. */
const FILES = [
  { path: 'package.json', pattern: /^(\s*"version":\s*")([^"]+)(")/m },
  { path: 'package-lock.json', pattern: /^(\s*"version":\s*")([^"]+)(")/m, count: 2 },
  { path: 'src-tauri/tauri.conf.json', pattern: /^(\s*"version":\s*")([^"]+)(")/m },
  { path: 'src-tauri/Cargo.toml', pattern: /^(\[package\](?:\r?\n(?!\[)[^\n]*)*?\r?\nversion\s*=\s*")([^"]+)(")/m },
  { path: 'src-tauri/Cargo.lock', pattern: /^(\[\[package\]\]\r?\nname = "folio"\r?\nversion = ")([^"]+)(")/m },
];

const read = (path) => readFileSync(root + path, 'utf8');

function versionsIn(f) {
  const text = read(f.path);
  const global = new RegExp(f.pattern.source, f.pattern.flags + 'g');
  const found = [...text.matchAll(global)].slice(0, f.count ?? 1).map((m) => m[2]);
  if (found.length < (f.count ?? 1)) throw new Error(`No version found in ${f.path}`);
  return found;
}

function check(tag) {
  const all = FILES.flatMap((f) => versionsIn(f).map((v) => ({ path: f.path, v })));
  const want = tag ? tag.replace(/^v/, '') : all[0].v;
  const wrong = all.filter((x) => x.v !== want);
  if (wrong.length) {
    console.error(`Expected version ${want}${tag ? ` (from the tag ${tag})` : ''}, but:`);
    for (const x of wrong) console.error(`  ${x.path} has ${x.v}`);
    console.error('Run "npm run bump -- <version>" and commit before tagging.');
    process.exit(1);
  }
  console.log(`Every file has version ${want}.`);
}

function next(current, how) {
  if (SEMVER.test(how)) return how;
  const m = current.match(SEMVER);
  if (!m) throw new Error(`The current version ${current} isn't major.minor.patch`);
  const [maj, min, pat] = m.slice(1, 4).map(Number);
  if (how === 'major') return `${maj + 1}.0.0`;
  if (how === 'minor') return `${maj}.${min + 1}.0`;
  if (how === 'patch') return m[4] ? `${maj}.${min}.${pat}` : `${maj}.${min}.${pat + 1}`;
  throw new Error(`"${how}" is not a version (like 1.2.3) or one of major, minor, patch`);
}

function bump(how) {
  const current = versionsIn(FILES[0])[0];
  const version = next(current, how);
  for (const f of FILES) {
    let left = f.count ?? 1;
    const global = new RegExp(f.pattern.source, f.pattern.flags + 'g');
    const text = read(f.path).replace(global, (all, a, _v, b) => (left-- > 0 ? a + version + b : all));
    writeFileSync(root + f.path, text);
  }
  check();
  console.log(`
${current} -> ${version}. Next, write what changed in the tag message (the update
prompt shows it), then push the tag on its own to build and publish the release
(a tag pushed together with the branch may not start the workflow):

  git commit -am "Folio ${version}"
  git tag -a v${version} -m "What's new in ${version}"
  git push origin main
  git push origin v${version}`);
}

const [arg, tag] = process.argv.slice(2);
try {
  if (arg === '--check') check(tag);
  else if (arg) bump(arg);
  else {
    console.error('Usage: npm run bump -- <version | major | minor | patch>');
    process.exit(2);
  }
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
