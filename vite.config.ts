import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * The collaboration server (Phase 8, `server/`): the app asks it on the same
 * origin, under /api and /ws, and the development server passes those on.
 * EVORA_SERVER points them at another one (the browser tests start their own).
 */
const COLLAB = process.env.EVORA_SERVER ?? 'http://localhost:8787';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: COLLAB, changeOrigin: true },
      '/ws': { target: COLLAB.replace(/^http/, 'ws'), ws: true, changeOrigin: true },
    },
  },
  test: {
    // Core tests run in Node. Tests that need a DOM opt in per file with
    // a "@vitest-environment jsdom" comment on their first line.
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'server/**/*.test.ts'],
    restoreMocks: true,
  },
});
