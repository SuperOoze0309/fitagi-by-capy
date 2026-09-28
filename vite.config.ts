import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Strip the smoke-test bootstrap from the production HTML.
 *
 * index.html loads `src/dev/smokeEntry.ts` when the page is opened with `?smoke=1`
 * so the headless browser run needs no test code inside the app. That block must
 * not survive into the shipped bundle, so it is removed at build time — the dev
 * server and `vite preview` keep it.
 */
function stripSmokeBootstrap(): Plugin {
  return {
    name: 'strip-smoke-bootstrap',
    apply: 'build',
    enforce: 'post',
    transformIndexHtml(html) {
      return html.replace(/\s*<!-- smoke-test:start -->[\s\S]*?<!-- smoke-test:end -->/g, '');
    },
  };
}

export default defineConfig({
  plugins: [react(), stripSmokeBootstrap()],
  base: './',
  server: {
    host: true,
    port: 5173,
  },
  build: {
    outDir: 'dist',
    target: 'es2021',
    sourcemap: false,
  },
});
