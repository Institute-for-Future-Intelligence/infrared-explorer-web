import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import svgr from 'vite-plugin-svgr';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), svgr()],
  // react-draggable's log helper references `process.env.DRAGGABLE_DEBUG` at
  // runtime (on every drag start). There's no `process` global in the browser,
  // so dragging threw `ReferenceError: process is not defined`. Statically
  // replace just that flag with `false` — leaving `process.env.NODE_ENV`, which
  // Vite manages, untouched.
  define: {
    'process.env.DRAGGABLE_DEBUG': 'false',
  },
  server: {
    open: true,
    port: 3002,
    host: true,
    // Mobile Safari aggressively caches dev modules, so CSS/JS edits don't show on the phone until a
    // full cache clear. Tell it never to store dev responses.
    headers: { 'Cache-Control': 'no-store' },
  },
  // Firebase Hosting serves the app at the domain root, so no base path
  // (the old '/infrared-explorer-web' base was for GitHub Pages).
});
