import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Relative base — built assets reference each other with `./`, so the bundle
// works whether it's served from the tailnet `/lifebot/` prefix, a different
// path, or the dev server.
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    // Build straight into .serve/ so lifebot-static.service picks it up. The
    // tailnet proxy already routes /lifebot/ → :8003 → this dir.
    outDir: resolve(__dirname, '.serve'),
    emptyOutDir: true,
    target: 'es2022',
  },
  server: {
    host: true,
    port: 5174,
  },
  // Avoid bundling onnxruntime-web's wasm assets — we ship them straight from
  // public/ instead, so the runtime can fetch them at the same origin.
  optimizeDeps: {
    exclude: ['onnxruntime-web'],
  },
});
