import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  publicDir: 'public',
  server: {
    host: '0.0.0.0',
    port: 3001,
    open: true,
  },
  build: {
    outDir: 'dist',
    assetsInlineLimit: 0, // Don't inline GLB files
  },
});
