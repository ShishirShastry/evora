import { app } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import type { HostStatus } from '../src/persistence/desktopContract.js';
import { UNPACKED_ROOT } from './paths.js';

/**
 * "Host a team server from this computer": Evora's own collaboration server
 * (server/main.ts, unchanged), run as a child process of the app's own
 * executable in Node mode (ELECTRON_RUN_AS_NODE=1; Electron's Node 24 strips
 * the types of the .ts files itself and has node:sqlite). It listens on every
 * network address of this computer, keeps its data in the app's data folder,
 * and also serves the app, so others can use it from a browser as well as
 * from their own Evora app. It stops when Evora quits.
 */

let child: ChildProcess | null = null;
let status: HostStatus | null = null;
let listener: (status: HostStatus) => void = () => {};

export function watchHost(callback: (status: HostStatus) => void): void {
  listener = callback;
}

export const hostDataDir = (): string => join(app.getPath('userData'), 'team-server');

/** The server's files, which are left outside the package's archive (asarUnpack) so plain Node can load them. */
function serverEntry(): string {
  return join(UNPACKED_ROOT, 'server', 'main.ts');
}

function builtApp(): string | null {
  const dist = join(UNPACKED_ROOT, 'dist');
  return existsSync(join(dist, 'index.html')) ? dist : null;
}

/** The addresses others on the network reach this computer at. */
export function networkAddresses(port: number): string[] {
  const found: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) found.push(`http://${entry.address}:${port}`);
    }
  }
  found.push(`http://localhost:${port}`);
  return found;
}

function set(next: HostStatus): HostStatus {
  status = next;
  listener(next);
  return next;
}

export function hostStatus(): HostStatus {
  return status ?? { state: 'stopped', port: null, addresses: [], dataDir: hostDataDir(), message: null };
}

async function healthy(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

export async function startHost(port: number): Promise<HostStatus> {
  if (child && status?.state === 'running') return hostStatus();
  const entry = serverEntry();
  if (!existsSync(entry)) return set({ ...hostStatus(), state: 'error', message: `The server's files are missing from this installation (${entry}).` });
  const dataDir = hostDataDir();
  mkdirSync(dataDir, { recursive: true });
  const args = [entry, '--port', String(port), '--data', dataDir, '--host', '0.0.0.0'];
  const served = builtApp();
  if (served) args.push('--serve', served);
  set({ state: 'starting', port, addresses: [], dataDir, message: null });

  const started = spawn(process.execPath, args, {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child = started;
  let errors = '';
  started.stderr?.on('data', (chunk: Buffer) => {
    errors = (errors + chunk.toString('utf8')).slice(-4000);
  });
  started.stdout?.on('data', () => {});

  const exited = new Promise<number | null>((resolve) => started.once('exit', (code) => resolve(code)));
  started.once('exit', (code) => {
    if (child !== started) return;
    child = null;
    if (status?.state === 'running' || status?.state === 'starting') {
      set({ state: code === 0 ? 'stopped' : 'error', port: null, addresses: [], dataDir, message: code === 0 ? null : describe(errors, port) });
    }
  });

  // Ready when it answers GET /api/health; it gives up after 20 seconds.
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const done = await Promise.race([exited.then(() => 'exited' as const), new Promise<'wait'>((resolve) => setTimeout(() => resolve('wait'), 250))]);
    if (done === 'exited') return hostStatus();
    if (await healthy(port)) return set({ state: 'running', port, addresses: networkAddresses(port), dataDir, message: null });
  }
  started.kill();
  return set({ state: 'error', port: null, addresses: [], dataDir, message: 'The server did not start in time.' });
}

function describe(errors: string, port: number): string {
  if (/EADDRINUSE/.test(errors)) return `Port ${port} is already in use on this computer. Choose another port.`;
  if (/EACCES/.test(errors)) return `This computer did not allow listening on port ${port}. Choose another port.`;
  const last = errors.trim().split('\n').filter(Boolean).pop();
  return last ? `The server stopped: ${last}` : 'The server stopped.';
}

export async function stopHost(): Promise<HostStatus> {
  const running = child;
  child = null;
  if (running) {
    const gone = new Promise<void>((resolve) => running.once('exit', () => resolve()));
    running.kill();
    await Promise.race([gone, new Promise((resolve) => setTimeout(resolve, 3000))]);
  }
  return set({ state: 'stopped', port: null, addresses: [], dataDir: hostDataDir(), message: null });
}

/** When the app quits. */
export function killHost(): void {
  child?.kill();
  child = null;
}
