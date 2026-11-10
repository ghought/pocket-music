/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';

// `npm run dev:https` serves over HTTPS on the LAN so phones can grant microphone access.
export default defineConfig(({ mode }) => ({
  // Relative base so the build works at any path, e.g. https://<user>.github.io/pocket-music/
  base: './',
  plugins: [react(), ...(mode === 'https' ? [basicSsl()] : [])],
  worker: { format: 'es' },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
}));
