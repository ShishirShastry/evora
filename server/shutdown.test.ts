import { spawn } from 'node:child_process';
import { existsSync, rmSync, statSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { CLOSE_RESTARTING, RESTARTING_REASON, startServer, type RunningServer } from './app.ts';
import { call, newDoc, signUp, tempDir, TestSocket } from './testing.ts';

const dirs: string[] = [];
const running: RunningServer[] = [];

function dir(): string {
  const path = tempDir();
  dirs.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.close()));
  for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** Starts a request whose body is sent in two halves, so that it is under way until `finish` is called. */
function slowRequest(url: string, path: string, body: string): { finish(): void; answer: Promise<{ status: number; text: string }> } {
  const half = Math.floor(body.length / 2);
  let req!: ReturnType<typeof request>;
  const answer = new Promise<{ status: number; text: string }>((resolve, reject) => {
    req = request(`${url}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      let text = '';
      res.on('data', (chunk: Buffer) => (text += chunk.toString()));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.write(body.slice(0, half));
  });
  return { finish: () => req.end(body.slice(half)), answer };
}

describe('stopping gracefully', { timeout: 30_000 }, () => {
  it('tells live connections the server is restarting, lets a request under way finish, and leaves the database whole', async () => {
    const dataDir = dir();
    const server = await startServer({ port: 0, dataDir });
    const owner = await signUp(server, 'Stopper', 'stopper@example.com');
    const doc = await newDoc(server, owner.token, 'Kept on stop');
    const live = await TestSocket.join(server, doc.id, { token: owner.token }, 'stopclient');

    const body = JSON.stringify({ email: 'late@example.com', name: 'Late', password: 'correct horse battery' });
    const slow = slowRequest(server.url, '/api/auth/signup', body);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const closing = server.close();
    // The live connection is told why, with the code the app reconnects on.
    expect(await live.socket.closed).toEqual({ code: CLOSE_RESTARTING, reason: RESTARTING_REASON });
    // New connections are not taken.
    await expect(fetch(`${server.url}/api/health`)).rejects.toThrow();
    // The request that was under way finishes.
    slow.finish();
    expect((await slow.answer).status).toBe(201);
    await closing;
    // The database was checkpointed: nothing is left in the write-ahead log.
    const wal = join(dataDir, 'evora.db-wal');
    expect(!existsSync(wal) || statSync(wal).size === 0).toBe(true);

    // Everything is there after a start on the same folder, the late account included.
    const again = await startServer({ port: 0, dataDir });
    running.push(again);
    expect((await call(again, 'POST', '/api/auth/login', { body: { email: 'late@example.com', password: 'correct horse battery' } })).status).toBe(200);
    expect((await call(again, 'GET', `/api/documents/${doc.id}`, { token: owner.token })).status).toBe(200);
  });

  it('does not wait longer than it was given for a request that never finishes', async () => {
    const server = await startServer({ port: 0, dataDir: dir(), shutdownMs: 300 });
    const stuck = slowRequest(server.url, '/api/auth/signup', JSON.stringify({ email: 'stuck@example.com', name: 'Stuck', password: 'correct horse battery' }));
    stuck.answer.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 100));
    const started = Date.now();
    await server.close();
    expect(Date.now() - started).toBeLessThan(2500);
    await expect(stuck.answer).rejects.toThrow();
    // Closing twice is the same close.
    await server.close();
  });

  // Windows cannot send a process SIGTERM or SIGINT from another (Node's kill() ends it at once there), so this runs on Linux and macOS only.
  it.skipIf(process.platform === 'win32')('stops on SIGTERM and exits with 0', async () => {
    const main = fileURLToPath(new URL('./main.ts', import.meta.url));
    const child = spawn(process.execPath, [main, '--port', '0', '--data', join(dir(), 'data')], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const url = await new Promise<string>((resolve, reject) => {
      child.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString();
        const found = /on (http:\/\/localhost:\d+)/.exec(out);
        if (found) resolve((found[1] as string).replace('localhost', '127.0.0.1'));
      });
      child.on('exit', (code) => reject(new Error(`main.ts stopped (${code})`)));
    });
    const owner = await signUp({ url }, 'Signalled');
    const doc = await newDoc({ url }, owner.token);
    const live = await TestSocket.join({ url }, doc.id, { token: owner.token }, 'signalclient');
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
    child.kill('SIGTERM');
    expect((await live.socket.closed).code).toBe(CLOSE_RESTARTING);
    expect(await exited).toBe(0);
    expect(out).toContain('Stopped');
  });
});
