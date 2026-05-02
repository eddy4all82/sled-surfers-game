import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  publicDir: 'public',
  server: {
    port: 3002,
    host: '0.0.0.0',
    open: true,
  },
  build: {
    outDir: 'dist',
    assetsInlineLimit: 0, // Don't inline GLB files
  },
});
