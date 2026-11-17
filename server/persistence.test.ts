import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { Thread } from '../src/collab/protocol.ts';
import { startServer } from './app.ts';
import { call, clock, newDoc, signUp, tempDir, TestSocket } from './testing.ts';

const dirs: string[] = [];
const children: ChildProcess[] = [];

function dir(): string {
  const path = tempDir();
  dirs.push(path);
  return path;
}

afterEach(async () => {
  // A stopped server's files can be removed only once its process has gone (Windows keeps them open until then).
  await Promise.all(
    children.splice(0).map((child) =>
      child.exitCode !== null || child.signalCode !== null ? null : new Promise((resolve) => (child.once('exit', resolve), child.kill())),
    ),
  );
  for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('keeping everything across a restart', () => {
  it('keeps accounts, sessions, documents, changes, comments and images', async () => {
    const dataDir = dir();
    let server = await startServer({ port: 0, dataDir });
    // Write-ahead logging: readers are not held up by a change being written.
    expect(server.store.one<{ journal_mode: string }>('PRAGMA journal_mode')?.journal_mode).toBe('wal');
    const owner = await signUp(server, 'Keeper', 'keeper@example.com');
    const doc = await newDoc(server, owner.token, 'Kept');
    const t = Date.now();
    const live = await TestSocket.join(server, doc.id, { token: owner.token }, 'keeperclient');
    live.socket.send({ t: 'ops', id: '1', ops: [{ k: 'n:frame:@', v: true, c: clock(t, 'keeperclient') }, { k: 'n:frame:w', v: 320, c: clock(t, 'keeperclient', 1) }] });
    const before = (await live.socket.next('ack')).seq;
    await live.socket.close();
    const thread = (await call<Thread>(server, 'POST', `/api/documents/${doc.id}/threads`, { token: owner.token, body: { pageId: 'p', x: 5, y: 6, body: 'Still here?' } })).body;
    const bytes = Buffer.from('an image, as bytes');
    const hash = createHash('sha256').update(bytes).digest('hex');
    await call(server, 'PUT', `/api/documents/${doc.id}/assets/${hash}`, { token: owner.token, body: bytes, headers: { 'Content-Type': 'image/webp' } });
    await server.close();

    server = await startServer({ port: 0, dataDir });
    // The same session still works, and so does signing in.
    expect((await call(server, 'GET', '/api/me', { token: owner.token })).body.user.email).toBe('keeper@example.com');
    expect((await call(server, 'POST', '/api/auth/login', { body: { email: 'keeper@example.com', password: 'correct horse battery' } })).status).toBe(200);
    const content = await call(server, 'GET', `/api/documents/${doc.id}/registers`, { token: owner.token });
    expect(content.body.seq).toBe(before);
    expect(content.body.registers.map((r: { k: string; v: unknown }) => [r.k, r.v])).toEqual([
      ['d:name', 'Kept'],
      ['n:frame:@', true],
      ['n:frame:w', 320],
    ]);
    expect((await call<Thread[]>(server, 'GET', `/api/documents/${doc.id}/threads`, { token: owner.token })).body).toEqual([thread]);
    const res = await fetch(`${server.url}/api/documents/${doc.id}/assets/${hash}`, { headers: { Authorization: `Bearer ${owner.token}` } });
    expect(res.headers.get('content-type')).toBe('image/webp');
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('an image, as bytes');

    // A client that held everything gets nothing new, and numbering goes on from where it was.
    const back = await TestSocket.join(server, doc.id, { token: owner.token }, 'keeperclient', before);
    expect(back.welcome).toMatchObject({ full: false, registers: [], seq: before });
    back.socket.send({ t: 'ops', id: '2', ops: [{ k: 'n:frame:h', v: 200, c: clock(Date.now(), 'keeperclient') }] });
    expect((await back.socket.next('ack')).seq).toBe(before + 1);
    await back.socket.close();
    await server.close();
  });
});

describe('server/main.ts', { timeout: 30_000 }, () => {
  const main = fileURLToPath(new URL('./main.ts', import.meta.url));

  /** Runs main.ts and resolves with the address it prints. */
  function run(args: string[]): Promise<{ child: ChildProcess; url: string }> {
    const child = spawn(process.execPath, [main, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    return new Promise((resolve, reject) => {
      let out = '';
      let err = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        out += chunk.toString();
        const found = /Evora collaboration server on (http:\/\/localhost:\d+)/.exec(out);
        if (found) resolve({ child, url: (found[1] as string).replace('localhost', '127.0.0.1') });
      });
      child.stderr?.on('data', (chunk: Buffer) => (err += chunk.toString()));
      child.on('exit', (code) => reject(new Error(`main.ts stopped (${code}): ${err}`)));
    });
  }

  function exitOf(args: string[]): Promise<{ code: number | null; err: string }> {
    const child = spawn(process.execPath, [main, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    return new Promise((resolve) => {
      let err = '';
      child.stderr?.on('data', (chunk: Buffer) => (err += chunk.toString()));
      child.on('exit', (code) => resolve({ code, err }));
    });
  }

  it('starts with plain Node, prints one line with its address, and serves a built app', async () => {
    const dataDir = join(dir(), 'data');
    const dist = dir();
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Evora</title>');
    mkdirSync(join(dist, 'assets'));
    writeFileSync(join(dist, 'assets', 'app-1234.js'), 'console.log("app")');

    const { child, url } = await run(['--port', '0', '--data', dataDir, '--serve', dist]);
    expect((await call(server(url), 'GET', '/api/health')).body.ok).toBe(true);
    expect(existsSync(join(dataDir, 'evora.db'))).toBe(true);

    const index = await fetch(`${url}/`);
    expect(index.headers.get('content-type')).toContain('text/html');
    expect(await index.text()).toContain('<title>Evora</title>');
    const script = await fetch(`${url}/assets/app-1234.js`);
    expect(script.headers.get('content-type')).toContain('text/javascript');
    expect(script.headers.get('cache-control')).toContain('immutable');
    // Any other path is the app, which finds its way from the address.
    expect(await (await fetch(`${url}/files/abc`)).text()).toContain('<title>Evora</title>');
    // Nothing outside the folder is served.
    const outside = await fetch(`${url}/..%2f..%2fpackage.json`);
    expect(await outside.text()).toContain('<title>Evora</title>');
    child.kill();
  });

  it('starts from nothing with --fresh, but only empties a folder that is its own', async () => {
    const dataDir = join(dir(), 'data');
    const first = await run(['--port', '0', '--data', dataDir]);
    await signUp(server(first.url), 'Before', 'before@example.com');
    first.child.kill();
    await new Promise((resolve) => first.child.once('exit', resolve));

    const again = await run(['--port', '0', '--data', dataDir, '--fresh']);
    expect((await call(server(again.url), 'POST', '/api/auth/login', { body: { email: 'before@example.com', password: 'correct horse battery' } })).status).toBe(401);
    again.child.kill();

    const other = dir();
    writeFileSync(join(other, 'precious.txt'), 'keep me');
    const refused = await exitOf(['--port', '0', '--data', other, '--fresh']);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('does not look like');
    expect(existsSync(join(other, 'precious.txt'))).toBe(true);
  });
});

function server(url: string): { url: string } {
  return { url };
}
