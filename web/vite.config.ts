import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The API has no CORS headers on purpose: the browser talks to the Vite server, and Vite forwards
// API paths to Fastify. Same origin from the browser's point of view, no backend change needed.
const apiTarget = process.env.PULSELEDGER_API_URL ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/v1': apiTarget,
      '/health': apiTarget,
    },
  },
  preview: {
    proxy: {
      '/v1': apiTarget,
      '/health': apiTarget,
    },
  },
});
