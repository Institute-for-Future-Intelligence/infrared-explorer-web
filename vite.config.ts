import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import svgr from 'vite-plugin-svgr';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), svgr()],
  server: {
    open: true,
    port: 3002,
    host: true,
  },
  // Firebase Hosting serves the app at the domain root, so no base path
  // (the old '/infrared-explorer-web' base was for GitHub Pages).
});
