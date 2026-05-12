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
    proxy: {
      // Same-origin shim for the evenhub-simulator automation API. Run the
      // simulator with `--automation-port 9898`; the HUD preview pane fetches
      // `/sim-api/api/screenshot/glasses` to embed the live LVGL framebuffer.
      // Going through Vite means no CORS handshake to worry about.
      '/sim-api': {
        target: 'http://127.0.0.1:9898',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/sim-api/, ''),
      },
      // Backend (server.cjs) for /lifebot/threads, /lifebot/groups,
      // /lifebot/logs, /lifebot/voiceprints. In prod claude-hub does the same
      // prefix strip; replicating it here keeps the client code unchanged.
      // Without this proxy Vite returns the SPA's index.html for unknown
      // paths, JSON.parse chokes on it, and WebKit (the simulator's WebView)
      // reports "The string did not match the expected pattern."
      '/lifebot': {
        target: 'http://127.0.0.1:8003',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/lifebot/, ''),
      },
    },
  },
  // Pre-bundle vad-web + onnxruntime-web so esbuild converts their internal
  // `require("onnxruntime-web/wasm")` (CJS) into ESM. Vite 8 + Rolldown ships
  // the raw require to the browser otherwise, which crashes app startup.
  // The .wasm binaries themselves still come from public/ — we point ort at
  // them at runtime via ort.env.wasm.wasmPaths (see WebAudioCapture.ts).
  optimizeDeps: {
    include: [
      '@ricky0123/vad-web',
      '@ricky0123/vad-web/dist/models/v5',
      '@ricky0123/vad-web/dist/default-model-fetcher',
      '@ricky0123/vad-web/dist/frame-processor',
      'onnxruntime-web',
      'onnxruntime-web/wasm',
    ],
  },
});
