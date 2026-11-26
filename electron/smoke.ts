import { app, type BrowserWindow } from 'electron';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHost, stopHost } from './hostServer.js';

/**
 * `Evora --smoke-test`: what the release workflow runs on each system's
 * installed copy (the Windows installer's install, the Mac disk images, the
 * Linux .deb and AppImage) before a release goes out; see RELEASING.md. It
 * checks that the packaged app works at all:
 *
 * - its window loads the app from app://evora/, and the page draws itself and
 *   reaches the desktop bridge (the preload script);
 * - the collaboration server packed with the app starts with the app's own
 *   Node, as "Host a team server" starts it, and answers at /api/health and
 *   with the app at /.
 *
 * It prints a line for each check and quits with 0 when all of them pass, 1
 * otherwise. It works in a new, empty data folder, so a person's own files and
 * settings are never touched.
 */
export const SMOKE_TEST = process.argv.includes('--smoke-test');

const PAGE_TIMEOUT_MS = 60_000;
/**
 * The app gives its team server 20 seconds; here it gets longer, because the
 * Intel build is tried on Apple silicon runners through Rosetta, where a first
 * start is much slower than on a real Intel Mac.
 */
const SERVER_TIMEOUT_MS = 120_000;

/** The page has drawn into #root and has the bridge from the preload script. */
const PAGE_READY = `typeof window.evoraDesktop === 'object' && window.evoraDesktop !== null && (document.getElementById('root')?.childElementCount ?? 0) > 0`;

/** Before the app is ready: a data folder of its own. */
export function prepareSmokeTest(): void {
  app.setPath('userData', mkdtempSync(join(tmpdir(), 'evora-smoke-')));
}

function say(line: string): void {
  process.stdout.write(`[smoke] ${line}\n`);
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runSmokeTest(window: BrowserWindow): Promise<void> {
  say(`Evora ${app.getVersion()} on ${process.platform} ${process.arch}${app.isPackaged ? '' : ' (not packaged)'}, data in ${app.getPath('userData')}`);
  let failed = 0;

  try {
    await pageReady(window);
    say(`ok: the window loaded ${window.webContents.getURL()} and the page reached the desktop bridge`);
  } catch (error) {
    failed++;
    say(`FAILED: the app's window: ${reason(error)}`);
  }

  try {
    const port = await freePort();
    const startedAt = Date.now();
    const status = await startHost(port, SERVER_TIMEOUT_MS);
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    if (status.state !== 'running') throw new Error(status.message ?? `the server is ${status.state}`);
    const health = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(5000) });
    if (!health.ok) throw new Error(`/api/health answered ${health.status}`);
    const page = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(5000) });
    if (!page.ok || !(await page.text()).includes('<div id="root">')) throw new Error(`/ answered ${page.status} without the app`);
    say(`ok: the team server started with the app's own Node in ${seconds} s on port ${port} and served the app`);
  } catch (error) {
    failed++;
    say(`FAILED: the team server: ${reason(error)}`);
  } finally {
    await stopHost();
  }

  say(failed === 0 ? 'passed' : `failed (${failed} of 2 checks)`);
  app.exit(failed === 0 ? 0 : 1);
}

function pageReady(window: BrowserWindow): Promise<void> {
  const contents = window.webContents;
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (error?: Error): void => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      clearInterval(poll);
      if (error) reject(error);
      else resolve();
    };
    const deadline = setTimeout(() => finish(new Error(`not ready after ${PAGE_TIMEOUT_MS / 1000} s, at ${contents.getURL() || 'no address'}`)), PAGE_TIMEOUT_MS);
    contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      if (isMainFrame) finish(new Error(`${url} did not load: ${description} (${code})`));
    });
    contents.on('preload-error', (_event, path, error) => finish(new Error(`the preload script ${path} failed: ${error.message}`)));
    contents.on('render-process-gone', (_event, details) => finish(new Error(`the page's process stopped (${details.reason})`)));
    // One question at a time: asked while the page loads, it is answered once the page has loaded.
    let asking = false;
    const poll = setInterval(() => {
      if (window.isDestroyed()) {
        finish(new Error('the window was closed'));
        return;
      }
      if (asking) return;
      asking = true;
      contents.executeJavaScript(PAGE_READY, true).then(
        (ready: unknown) => {
          asking = false;
          if (ready === true) finish();
        },
        () => {
          // The page went away while it was asked (a reload): asked again.
          asking = false;
        },
      );
    }, 250);
  });
}

/** A port nothing on this computer listens on. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => (port > 0 ? resolve(port) : reject(new Error('no free port'))));
    });
  });
}
