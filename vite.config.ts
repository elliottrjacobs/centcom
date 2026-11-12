import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// Point the dev UI at another server (e.g. a scratch vault on :4848) without touching the real one.
const API = process.env.CENTCOM_API ?? 'http://127.0.0.1:4747';

/**
 * index.html allows the Vite dev server's HMR websocket in its CSP. A production build has no
 * dev server, so the shipped policy must not name one: strip those sources, and fail the build
 * rather than ship them if the markup ever changes shape.
 */
const DEV_CONNECT_SOURCES = ['ws://localhost:5179', 'ws://127.0.0.1:5179'];
function productionCsp(): Plugin {
  return {
    name: 'centcom-production-csp',
    apply: 'build',
    transformIndexHtml(html) {
      let out = html;
      for (const source of DEV_CONNECT_SOURCES) out = out.split(` ${source}`).join('');
      if (DEV_CONNECT_SOURCES.some((source) => out.includes(source))) throw new Error('index.html: dev-only CSP sources survived the production transform.');
      if (!/connect-src 'self';/.test(out)) throw new Error("index.html: expected connect-src 'self' in the production CSP.");
      return out;
    },
  };
}

export default defineConfig({
  plugins: [react(), productionCsp()],
  // Relative base so the built UI loads from file-less http root and from Electron alike.
  base: './',
  resolve: {
    alias: { '@shared': fileURLToPath(new URL('./shared', import.meta.url)) },
  },
  server: {
    host: '127.0.0.1',
    port: 5179,
    strictPort: true,
    proxy: {
      '/api': { target: API, changeOrigin: false },
      '/mcp': { target: API, changeOrigin: false },
    },
  },
  build: { outDir: 'dist-ui', emptyOutDir: true },
});
