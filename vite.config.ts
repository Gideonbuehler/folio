import { readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/** Kept in step with src-tauri by `npm run bump`. */
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

/** Test PDFs are served in development only; they don't ship with the app. */
function dropDevSamples(): Plugin {
  let outDir = 'dist';
  return {
    name: 'folio-drop-dev-samples',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      for (const dir of ['samples', 'test-samples']) rmSync(resolve(outDir, dir), { recursive: true, force: true });
    },
  };
}

export default defineConfig({
  plugins: [react(), dropDevSamples()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  // The desktop shell (src-tauri) loads the dev server from this exact port.
  server: {
    port: 5180,
    strictPort: true,
    // Folio Sign (server/) in development: signing links open this dev server.
    proxy: { '/api': 'http://127.0.0.1:8787' },
  },
  clearScreen: false,
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
  optimizeDeps: { exclude: ['pdfjs-dist'] },
});
