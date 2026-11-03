import { defineConfig, loadEnv } from 'vite';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
export default defineConfig(({ mode }) => {
  const { PORT } = loadEnv(mode, fileURLToPath(new URL('../', import.meta.url)), 'PORT');
  const backend = `http://127.0.0.1:${PORT || 4000}`;
  return {
    plugins: [react()],
    server: { port: 5173, strictPort: true, allowedHosts: ['oc.home.arpa'], proxy: { '/api': backend, '/healthz': backend } },
  };
});
