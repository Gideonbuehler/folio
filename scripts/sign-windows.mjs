/**
 * Code-signs one Windows binary. Release builds (src-tauri/tauri.release.conf.json)
 * run it as Tauri's `signCommand` for the app, its installer and uninstaller.
 * The certificate comes from the environment, so secrets never live in the
 * repo and nothing changes in the build when one is added:
 *
 * - Azure Trusted Signing: AZURE_TRUSTED_SIGNING_ENDPOINT, AZURE_TRUSTED_SIGNING_ACCOUNT
 *   and AZURE_TRUSTED_SIGNING_PROFILE, with AZURE_TENANT_ID, AZURE_CLIENT_ID and
 *   AZURE_CLIENT_SECRET for the app registration allowed to sign.
 *   Needs trusted-signing-cli (`cargo install trusted-signing-cli`).
 * - A .pfx file: WINDOWS_CERTIFICATE_FILE and WINDOWS_CERTIFICATE_PASSWORD.
 * - A certificate in the Windows certificate store (a USB token, or a cloud
 *   key vault's local signing provider): WINDOWS_CERTIFICATE_THUMBPRINT.
 *
 * WINDOWS_TIMESTAMP_URL overrides the timestamp server for the last two.
 * With nothing set, the file stays unsigned and the build carries on.
 *
 *   node scripts/sign-windows.mjs <file>
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/sign-windows.mjs <file>');
  process.exit(2);
}

const env = process.env;
const timestamp = env.WINDOWS_TIMESTAMP_URL || 'http://timestamp.digicert.com';

function run(cmd, args) {
  const res = spawnSync(cmd, args, { stdio: 'inherit' });
  if (res.error) {
    console.error(`Could not run ${cmd}: ${res.error.message}`);
    process.exit(1);
  }
  process.exit(res.status ?? 1);
}

/** signtool.exe from the newest Windows SDK, unless SIGNTOOL points elsewhere. */
function signtool() {
  if (env.SIGNTOOL) return env.SIGNTOOL;
  const root = join(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Windows Kits', '10', 'bin');
  const versions = existsSync(root) ? readdirSync(root).filter((v) => /^10\./.test(v)) : [];
  versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const v of versions) {
    const exe = join(root, v, 'x64', 'signtool.exe');
    if (existsSync(exe)) return exe;
  }
  return 'signtool.exe';
}

const name = basename(file);

if (env.AZURE_TRUSTED_SIGNING_ENDPOINT) {
  console.log(`Signing ${name} with Azure Trusted Signing`);
  run('trusted-signing-cli', [
    '-e', env.AZURE_TRUSTED_SIGNING_ENDPOINT,
    '-a', env.AZURE_TRUSTED_SIGNING_ACCOUNT ?? '',
    '-c', env.AZURE_TRUSTED_SIGNING_PROFILE ?? '',
    '-d', 'Folio',
    file,
  ]);
} else if (env.WINDOWS_CERTIFICATE_FILE || env.WINDOWS_CERTIFICATE_THUMBPRINT) {
  const cert = env.WINDOWS_CERTIFICATE_FILE
    ? ['/f', env.WINDOWS_CERTIFICATE_FILE, ...(env.WINDOWS_CERTIFICATE_PASSWORD ? ['/p', env.WINDOWS_CERTIFICATE_PASSWORD] : [])]
    : ['/sha1', env.WINDOWS_CERTIFICATE_THUMBPRINT];
  console.log(`Signing ${name} with ${env.WINDOWS_CERTIFICATE_FILE ? 'the .pfx certificate' : 'the certificate in the Windows store'}`);
  run(signtool(), ['sign', ...cert, '/fd', 'sha256', '/tr', timestamp, '/td', 'sha256', '/d', 'Folio', file]);
} else {
  console.log(`Not code-signing ${name}: no certificate is set up (see "Releases" in the README).`);
}
