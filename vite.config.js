// Upstream targets Chrome 69 (the stock Car Thing cast_shell) with @vitejs/plugin-legacy
// and hand-written polyfills. Bridgething runs a modern chromium, so all of that
// is dropped — this is a plain modern build.
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: { target: 'es2022', sourcemap: true },
  server: { host: true },
});
