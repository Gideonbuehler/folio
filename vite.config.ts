import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

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
  // The desktop shell (src-tauri) loads the dev server from this exact port.
  server: { port: 5180, strictPort: true },
  clearScreen: false,
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
  optimizeDeps: { exclude: ['pdfjs-dist'] },
});
