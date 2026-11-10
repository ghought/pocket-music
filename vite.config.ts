/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';

// `npm run dev:https` serves over HTTPS on the LAN so phones can grant microphone access.
export default defineConfig(({ mode }) => ({
  plugins: [react(), ...(mode === 'https' ? [basicSsl()] : [])],
  worker: { format: 'es' },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
}));
