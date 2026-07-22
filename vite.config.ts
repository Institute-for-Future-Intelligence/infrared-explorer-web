import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import svgr from 'vite-plugin-svgr';

// Build timestamp shown in the page footer, e.g. "2026-07-22 14:05 EDT". Rendered in US Eastern
// time to match the other IFI products' footers. Computed once when this config loads (production
// build / dev-server start), so in dev it reflects the server start, not the current request.
const buildTime = (() => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'short',
  }).formatToParts(new Date());
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')} ${get('timeZoneName')}`;
})();

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
    __BUILD_TIME__: JSON.stringify(buildTime),
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
