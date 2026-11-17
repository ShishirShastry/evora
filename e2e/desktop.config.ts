import { defineConfig } from '@playwright/test';

/**
 * The desktop app's tests (e2e/desktop.spec.ts), apart from the browser tests
 * (playwright.config.ts, which skips that file): they launch Electron on the
 * built app, so run `npm run desktop:build` first, then `npm run e2e:desktop`.
 * No web server is started; the app must work without one.
 */
process.env.EVORA_DESKTOP_E2E = '1';

export default defineConfig({
  testDir: '.',
  testMatch: 'desktop.spec.ts',
  timeout: 400_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  outputDir: '../test-results/desktop',
});
