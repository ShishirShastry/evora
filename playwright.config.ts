import { defineConfig } from '@playwright/test';

const PORT = 5179;
/** The collaboration server the tests use: its own port and an empty database each run. */
const SERVER_PORT = 8797;

/**
 * Acceptance tests run against the real application in the Microsoft Edge that
 * ships with Windows, so no browser download is needed. The dev server is
 * started with the same Node binary that runs Playwright, so it works whether
 * or not Node is on PATH.
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  expect: { timeout: 7_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  outputDir: 'test-results',
  use: {
    baseURL: `http://localhost:${PORT}`,
    channel: 'msedge',
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    trace: 'off',
  },
  webServer: [
    {
      command: `"${process.execPath}" server/main.ts --port ${SERVER_PORT} --data test-results/evora-server --fresh`,
      url: `http://localhost:${SERVER_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `"${process.execPath}" node_modules/vite/bin/vite.js --port ${PORT} --strictPort`,
      url: `http://localhost:${PORT}`,
      reuseExistingServer: true,
      timeout: 180_000,
      env: { EVORA_SERVER: `http://localhost:${SERVER_PORT}` },
    },
  ],
});
