import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: '.',
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',    // 其他 API 仍走 Express
      '/webhook': 'http://localhost:3000',
    },
  },
  build: {
    outDir: 'client-dist',
  },
});
