import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { Register } from '../src/collab/protocol.ts';
import { startServer, type RunningServer } from './app.ts';
import { backup, restore, verifyBackup, type Manifest } from './backup.ts';
import { call, clock, newDoc, signUp, tempDir, TestSocket } from './testing.ts';

const dirs: string[] = [];
const running: RunningServer[] = [];

function dir(): string {
  const path = tempDir();
  dirs.push(path);
  return path;
}

async function serve(dataDir: string): Promise<RunningServer> {
  const server = await startServer({ port: 0, dataDir });
  running.push(server);
  return server;
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.close()));
  for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7]);
const hashOf = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** A server with an account, a document with changes and an image, and a Community file with an image and a cover. */
async function populated(server: RunningServer) {
  const owner = await signUp(server, 'Backer', 'backer@example.com');
  const doc = await newDoc(server, owner.token, 'Backed up');
  const live = await TestSocket.join(server, doc.id, { token: owner.token }, 'backupclient');
  const t = Date.now();
  live.socket.send({ t: 'ops', id: '1', ops: [{ k: 'n:frame:@', v: true, c: clock(t, 'backupclient') }, { k: 'n:frame:w', v: 640, c: clock(t, 'backupclient', 1) }] });
  await live.socket.next('ack');
  const image = new Uint8Array([...PNG, 1]);
  const imageHash = hashOf(image);
  expect((await call(server, 'PUT', `/api/documents/${doc.id}/assets/${imageHash}`, { token: owner.token, body: image, headers: { 'Content-Type': 'image/png' } })).status).toBe(200);

  const shared = new Uint8Array([...PNG, 2]);
  const sharedHash = hashOf(shared);
  const registers: Register[] = [
    { k: 'd:name', v: 'Community file', c: clock(1000, 'seed') },
    { k: 'n:page1:@', v: true, c: clock(1000, 'seed', 1) },
    { k: `a:${sharedHash}`, v: { mimeType: 'image/png', width: 1, height: 1 }, c: clock(1000, 'seed', 2) },
  ];
  const made = await call(server, 'POST', '/api/community/resources', { token: owner.token, body: { registers, sourceId: 'backupsource1', kind: 'file', title: 'Backed up wireframes' } });
  expect(made.status).toBe(201);
  const resourceId = made.body.resource.id as string;
  expect((await call(server, 'PUT', `/api/community/resources/${resourceId}/assets/${sharedHash}`, { token: owner.token, body: shared, headers: { 'Content-Type': 'image/png' } })).status).toBe(200);
  expect((await call(server, 'PUT', `/api/community/resources/${resourceId}/cover`, { token: owner.token, body: PNG, headers: { 'Content-Type': 'image/png' } })).status).toBe(200);
  return { owner, doc, live: live.socket, image, imageHash, shared, sharedHash, resourceId };
}

/** Checks that a server holds everything `populated` wrote. */
async function expectEverything(server: RunningServer, made: Awaited<ReturnType<typeof populated>>, frameWidth: number): Promise<void> {
  expect((await call(server, 'POST', '/api/auth/login', { body: { email: 'backer@example.com', password: 'correct horse battery' } })).status).toBe(200);
  // The session from before still works.
  expect((await call(server, 'GET', '/api/me', { token: made.owner.token })).body.user.email).toBe('backer@example.com');
  const content = await call(server, 'GET', `/api/documents/${made.doc.id}/registers`, { token: made.owner.token });
  const values = Object.fromEntries(content.body.registers.map((r: { k: string; v: unknown }) => [r.k, r.v]));
  expect(values).toMatchObject({ 'd:name': 'Backed up', 'n:frame:@': true, 'n:frame:w': frameWidth });
  const image = await fetch(`${server.url}/api/documents/${made.doc.id}/assets/${made.imageHash}`, { headers: { Authorization: `Bearer ${made.owner.token}` } });
  expect(image.status).toBe(200);
  expect(new Uint8Array(await image.arrayBuffer())).toEqual(made.image);
  const cover = await fetch(`${server.url}/api/community/resources/${made.resourceId}/cover`);
  expect(cover.status).toBe(200);
  expect(new Uint8Array(await cover.arrayBuffer())).toEqual(PNG);
  const shared = await fetch(`${server.url}/api/community/resources/${made.resourceId}/assets/${made.sharedHash}`);
  expect(shared.status).toBe(200);
  expect(new Uint8Array(await shared.arrayBuffer())).toEqual(made.shared);
}

describe('backup and restore', { timeout: 30_000 }, () => {
  it('backs up a running server while it is being written to, and restores it into an empty folder', async () => {
    const dataDir = dir();
    const server = await serve(dataDir);
    const made = await populated(server);

    // Changes keep arriving while the backup is made.
    let width = 640;
    let writing = true;
    const writer = (async () => {
      let n = 0;
      while (writing) {
        width = 700 + ++n;
        made.live.send({ t: 'ops', id: `w${n}`, ops: [{ k: 'n:frame:w', v: width, c: clock(Date.now() + n, 'backupclient', n) }] });
        await made.live.next('ack');
      }
    })();
    const out = join(dir(), 'backup');
    const result = await backup({ dataDir, out });
    writing = false;
    await writer;
    await made.live.close();

    expect(['sqlite-backup', 'vacuum-into']).toContain(result.manifest.method);
    const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')) as Manifest;
    expect(manifest).toEqual(result.manifest);
    expect(manifest.format).toBe('evora-backup');
    const paths = manifest.files.map((file) => file.path);
    expect(paths).toContain('evora.db');
    expect(paths).toContain(`files/assets/${made.doc.id}/${made.imageHash}`);
    expect(paths.some((path) => path.startsWith('files/community/') && path.endsWith('/cover'))).toBe(true);
    expect(paths.some((path) => path.startsWith('files/community/') && path.endsWith(made.sharedHash))).toBe(true);
    // The live database's own log files are not copied as they are.
    expect(paths.some((path) => /evora\.db-(wal|shm)$/.test(path))).toBe(false);
    expect(verifyBackup(out)).toEqual(manifest);

    // The backup's frame width is one the server had acknowledged when the copy was made.
    const restored = join(dir(), 'restored');
    restore({ from: out, dataDir: restored });
    const again = await serve(restored);
    const content = await call(again, 'GET', `/api/documents/${made.doc.id}/registers`, { token: made.owner.token });
    const backedWidth = content.body.registers.find((r: { k: string }) => r.k === 'n:frame:w').v as number;
    expect(backedWidth === 640 || (backedWidth > 700 && backedWidth <= width)).toBe(true);
    await expectEverything(again, made, backedWidth);
    // The restored server goes on working.
    const next = await TestSocket.join(again, made.doc.id, { token: made.owner.token }, 'afterrestore');
    next.socket.send({ t: 'ops', id: 'r1', ops: [{ k: 'n:frame:h', v: 99, c: clock(Date.now() + 10_000, 'afterrestore') }] });
    expect((await next.socket.next('ack')).seq).toBeGreaterThan(0);
    await next.socket.close();
  });

  it('works from the command line, as "npm run backup" runs it, while the server runs', async () => {
    const dataDir = dir();
    const server = await serve(dataDir);
    const made = await populated(server);
    await made.live.close();
    const script = fileURLToPath(new URL('./backup.ts', import.meta.url));
    const run = (args: string[]) =>
      new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
        const child = spawn(process.execPath, [script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        let err = '';
        child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
        child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
        child.on('exit', (code) => resolve({ code, out, err }));
      });

    const out = join(dir(), 'cli-backup');
    const made1 = await run(['--data', dataDir, '--out', out]);
    expect(made1.err).toBe('');
    expect(made1.code).toBe(0);
    expect(made1.out).toMatch(/Backed up \d+ files/);
    expect((await run(['--verify', out])).code).toBe(0);

    const restored = join(dir(), 'cli-restored');
    const back = await run(['--restore', out, '--data', restored]);
    expect(back.code).toBe(0);
    expect(back.out).toContain('Restored');
    await expectEverything(await serve(restored), made, 640);

    // Into a folder that is not empty: refused, nothing touched.
    const busy = dir();
    writeFileSync(join(busy, 'keep.txt'), 'keep me');
    const refused = await run(['--restore', out, '--data', busy]);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('not empty');
    expect(readFileSync(join(busy, 'keep.txt'), 'utf8')).toBe('keep me');
    expect(existsSync(join(busy, 'evora.db'))).toBe(false);

    // Wrong flags: the usage.
    const wrong = await run(['--nonsense']);
    expect(wrong.code).toBe(2);
    expect(wrong.err).toContain('Usage');
  }, 90_000); // It starts the backup tool as its own process; give it time on a busy machine.

  it('refuses what it should, and finds a backup that was changed', async () => {
    const dataDir = dir();
    const server = await serve(dataDir);
    const owner = await signUp(server, 'Tamper');
    await newDoc(server, owner.token, 'One');

    // Not a data folder; a folder that is not empty; the data folder itself.
    await expect(backup({ dataDir: dir(), out: join(dir(), 'x') })).rejects.toThrow('not an Evora server');
    const full = dir();
    writeFileSync(join(full, 'something'), 'x');
    await expect(backup({ dataDir, out: full })).rejects.toThrow('not empty');
    await expect(backup({ dataDir, out: join(dataDir, 'inside') })).rejects.toThrow('inside the data folder');

    const out = join(dir(), 'b');
    await backup({ dataDir, out });
    // A changed database is found before anything is restored.
    const db = join(out, 'evora.db');
    const bytes = readFileSync(db);
    bytes[bytes.length - 1] ^= 0xff;
    writeFileSync(db, bytes);
    expect(() => verifyBackup(out)).toThrow('checksum');
    const target = join(dir(), 'never');
    expect(() => restore({ from: out, dataDir: target })).toThrow('checksum');
    expect(existsSync(join(target, 'evora.db'))).toBe(false);

    // A manifest that names a file outside the backup.
    const evil = join(dir(), 'evil');
    mkdirSync(evil);
    writeFileSync(join(evil, 'manifest.json'), JSON.stringify({ format: 'evora-backup', formatVersion: 1, files: [{ path: 'evora.db', size: 0, sha256: '' }, { path: 'files/../../x', size: 0, sha256: '' }] }));
    expect(() => verifyBackup(evil)).toThrow('outside the backup');
    // Not a backup at all.
    expect(() => verifyBackup(dir())).toThrow('not an Evora backup');
  });
});
