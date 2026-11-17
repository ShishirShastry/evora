import { afterEach, describe, expect, it } from 'vitest';
import { packageVersion } from './app.ts';
import { call, testServer, type TestServer } from './testing.ts';

const servers: TestServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

async function start(): Promise<TestServer> {
  const server = await testServer();
  servers.push(server);
  return server;
}

describe('GET /api/health', () => {
  it('answers without an account: ok, the version, how long it has run, and the database', async () => {
    const server = await start();
    const res = await fetch(`${server.url}/api/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as { uptime: number };
    expect(body).toEqual({ ok: true, version: packageVersion(), uptime: expect.any(Number), db: 'ok' });
    expect(body.uptime).toBeGreaterThanOrEqual(0);
    // HEAD, for checks that only want the status.
    expect((await fetch(`${server.url}/api/health`, { method: 'HEAD' })).status).toBe(200);
    // Other methods are still not allowed.
    expect((await call(server, 'DELETE', '/api/health')).status).toBe(405);
  });

  it('says 503 when the database cannot be read', async () => {
    const server = await start();
    server.store.db.close();
    const answer = await call(server, 'GET', '/api/health');
    expect(answer.status).toBe(503);
    expect(answer.body).toMatchObject({ ok: false, version: packageVersion(), db: 'error', error: expect.any(String) });
  });
});

describe('GET /api/version', () => {
  it('gives the version, the Node it runs on and the database schema', async () => {
    const server = await start();
    const answer = await call(server, 'GET', '/api/version');
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ version: packageVersion(), node: process.versions.node, database: expect.any(Number) });
    expect(answer.body.database).toBeGreaterThan(0);
    expect((await call(server, 'POST', '/api/version')).status).toBe(405);
  });
});
