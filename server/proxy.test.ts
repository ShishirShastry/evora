import type { IncomingMessage } from 'node:http';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ConfigError, readConfig } from './config.ts';
import { clientAddress } from './http.ts';
import { parseTrustProxy, normaliseAddress, requestAddress, resolveClientAddress, setClientAddress } from './proxy.ts';
import { call, tempDir, testServer, type TestServer } from './testing.ts';

describe('the trust-proxy setting', () => {
  it('is off unless set', () => {
    for (const off of [undefined, '', '0', 'false', 'off', 'no', ' NO ']) expect(parseTrustProxy(off)).toEqual({ kind: 'off' });
    expect(parseTrustProxy('1')).toEqual({ kind: 'hops', hops: 1 });
    expect(parseTrustProxy('true')).toEqual({ kind: 'hops', hops: 1 });
    expect(parseTrustProxy('2')).toEqual({ kind: 'hops', hops: 2 });
    expect(parseTrustProxy('10.0.0.0/8, ::1, loopback').kind).toBe('list');
  });

  it('refuses what is not an address, a range or a known name', () => {
    expect(() => parseTrustProxy('nginx')).toThrow('not an address');
    expect(() => parseTrustProxy('10.0.0.0/33')).toThrow('prefix');
    expect(() => parseTrustProxy('10.0.0.0/8/1')).toThrow('not an address');
    expect(() => parseTrustProxy('99')).toThrow('at most 32');
  });

  it('writes addresses one way', () => {
    expect(normaliseAddress('::ffff:192.0.2.1')).toBe('192.0.2.1');
    expect(normaliseAddress(' 192.0.2.1:5555 ')).toBe('192.0.2.1');
    expect(normaliseAddress('[2001:DB8::1]:443')).toBe('2001:db8::1');
  });
});

describe('the client address', () => {
  const off = parseTrustProxy('');
  const one = parseTrustProxy('1');
  const two = parseTrustProxy('2');
  const list = parseTrustProxy('127.0.0.1, 10.0.0.0/8');

  it('is the connection when nothing is trusted, whatever the header says', () => {
    expect(resolveClientAddress('::ffff:127.0.0.1', '203.0.113.9', off)).toBe('127.0.0.1');
    expect(resolveClientAddress('198.51.100.4', undefined, one)).toBe('198.51.100.4');
  });

  it('is the right-most hop past a number of trusted proxies', () => {
    // A client may write anything on the left; the proxy adds who it saw on the right.
    expect(resolveClientAddress('127.0.0.1', '1.1.1.1, 203.0.113.9', one)).toBe('203.0.113.9');
    expect(resolveClientAddress('127.0.0.1', '1.1.1.1, 203.0.113.9, 10.0.0.2', two)).toBe('203.0.113.9');
    // Fewer hops than proxies: the left-most there is.
    expect(resolveClientAddress('127.0.0.1', '203.0.113.9', two)).toBe('203.0.113.9');
    // Something that is not an address is not believed.
    expect(resolveClientAddress('127.0.0.1', 'garbage', one)).toBe('127.0.0.1');
    // The header given twice counts as one list.
    expect(resolveClientAddress('127.0.0.1', ['1.1.1.1', '203.0.113.9'], one)).toBe('203.0.113.9');
  });

  it('is the right-most hop that is not a listed proxy', () => {
    expect(resolveClientAddress('127.0.0.1', '1.1.1.1, 203.0.113.9, 10.1.2.3', list)).toBe('203.0.113.9');
    // A connection from somewhere not listed: its header is not believed.
    expect(resolveClientAddress('198.51.100.4', '203.0.113.9', list)).toBe('198.51.100.4');
    // Every hop a proxy: the left-most.
    expect(resolveClientAddress('127.0.0.1', '10.0.0.5, 10.0.0.6', list)).toBe('10.0.0.5');
    // A forged hop to the left of the real client does not matter.
    expect(resolveClientAddress('127.0.0.1', '10.0.0.5, 203.0.113.9', list)).toBe('203.0.113.9');
    expect(resolveClientAddress('127.0.0.1', 'not-an-ip, 10.0.0.6', list)).toBe('10.0.0.6');
  });

  it('is kept with the request', () => {
    const req = { socket: { remoteAddress: '::ffff:192.0.2.7' }, headers: {} } as unknown as IncomingMessage;
    expect(requestAddress(req)).toBe('192.0.2.7');
    setClientAddress(req, '203.0.113.50');
    expect(requestAddress(req)).toBe('203.0.113.50');
  });
});

/** Whether server/http.ts's clientAddress reads the address app.ts works out (see the report: a one-line change there). */
function wired(): boolean {
  const req = { socket: { remoteAddress: '127.0.0.1' }, headers: {} } as unknown as IncomingMessage;
  setClientAddress(req, '203.0.113.200');
  return clientAddress(req) === '203.0.113.200';
}

describe.skipIf(!wired())('limits behind a proxy', () => {
  const servers: TestServer[] = [];
  afterAll(async () => {
    await Promise.all(servers.map((server) => server.stop()));
  });

  const signUpFrom = (server: TestServer, forwardedFor: string, n: number) =>
    call(server, 'POST', '/api/auth/signup', { body: { email: `proxy${n}.${Date.now()}@example.com`, name: 'Proxied', password: 'correct horse battery' }, headers: { 'X-Forwarded-For': forwardedFor } });

  it('counts each client behind a trusted proxy on its own', async () => {
    const server = await testServer({ trustProxy: parseTrustProxy('1'), limits: { signups: 1 } });
    servers.push(server);
    expect((await signUpFrom(server, '203.0.113.1', 1)).status).toBe(201);
    expect((await signUpFrom(server, '203.0.113.1', 2)).status).toBe(429);
    expect((await signUpFrom(server, '203.0.113.2', 3)).status).toBe(201);
  });

  it('does not believe the header when no proxy is trusted', async () => {
    const server = await testServer({ limits: { signups: 1 } });
    servers.push(server);
    expect((await signUpFrom(server, '203.0.113.1', 4)).status).toBe(201);
    expect((await signUpFrom(server, '203.0.113.2', 5)).status).toBe(429);
  });
});

describe('the settings', () => {
  const made: string[] = [];
  const folder = (): string => {
    const path = tempDir();
    made.push(path);
    return path;
  };
  afterAll(() => {
    for (const path of made) rmSync(path, { recursive: true, force: true });
  });
  const read = (args: string[], env: Record<string, string> = {}) => readConfig(args, env);

  it('has defaults, takes variables, and lets a flag win', () => {
    const config = read([]);
    expect(config).toMatchObject({ port: 8787, host: '127.0.0.1', dataDir: resolve('.evora-server'), publicUrl: null, google: null, maxUploadBytes: 50 * 1024 * 1024, maxJsonBytes: 2 * 1024 * 1024, trustProxy: { kind: 'off' }, shutdownMs: 10_000, fresh: false });
    const env = {
      EVORA_PORT: '9000',
      EVORA_HOST: '0.0.0.0',
      EVORA_DATA: 'somewhere',
      EVORA_PUBLIC_URL: 'https://evora.example.com/',
      EVORA_GOOGLE_CLIENT_ID: 'id.apps.googleusercontent.com',
      EVORA_GOOGLE_CLIENT_SECRET: 'shh',
      EVORA_MAX_UPLOAD_MB: '100',
      EVORA_MAX_JSON_MB: '4',
      EVORA_TRUST_PROXY: 'loopback',
      EVORA_SHUTDOWN_SECONDS: '3',
    };
    expect(read([], env)).toMatchObject({
      port: 9000,
      host: '0.0.0.0',
      dataDir: resolve('somewhere'),
      publicUrl: 'https://evora.example.com',
      google: { clientId: 'id.apps.googleusercontent.com', clientSecret: 'shh' },
      maxUploadBytes: 100 * 1024 * 1024,
      maxJsonBytes: 4 * 1024 * 1024,
      trustProxy: { kind: 'list' },
      shutdownMs: 3000,
    });
    expect(read(['--port', '9100', '--host', 'localhost', '--trust-proxy', '0', '--max-upload-mb', '10'], env)).toMatchObject({ port: 9100, host: 'localhost', trustProxy: { kind: 'off' }, maxUploadBytes: 10 * 1024 * 1024 });
  });

  it('refuses values that are not ones, with a message that says which', () => {
    const refused = (args: string[], env: Record<string, string> = {}): string => {
      try {
        read(args, env);
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        return (error as Error).message;
      }
      throw new Error('accepted');
    };
    expect(refused(['--port', '70000'])).toContain('port');
    expect(refused([], { EVORA_PORT: 'eighty' })).toContain('port');
    expect(refused(['--host', 'not a host'])).toContain('host');
    expect(refused(['--public-url', 'https://evora.example.com/app'])).toContain('not an origin');
    expect(refused(['--max-upload-mb', '0'])).toContain('max upload');
    expect(refused([], { EVORA_MAX_JSON_MB: 'lots' })).toContain('max JSON');
    expect(refused([], { EVORA_TRUST_PROXY: 'my-proxy' })).toContain('trust proxy');
    expect(refused(['--shutdown-seconds', '-1'])).toContain('shutdown');
    expect(refused(['--google-client-id', 'x'])).toContain('EVORA_GOOGLE_CLIENT_SECRET');
    expect(refused([], { EVORA_GOOGLE_CLIENT_SECRET: 'x' })).toContain('client ID');
    expect(refused(['--unknown'])).toContain('unknown');
    expect(refused(['--serve', folder()])).toContain('index.html');
  });

  it('serves a folder with an app in it, and only empties its own data folder with --fresh', () => {
    const dist = folder();
    writeFileSync(join(dist, 'index.html'), '<!doctype html>');
    expect(read(['--serve', dist]).serveDir).toBe(resolve(dist));
    expect(read([], { EVORA_SERVE: dist }).serveDir).toBe(resolve(dist));
    const other = folder();
    mkdirSync(join(other, 'photos'));
    expect(() => read(['--data', other, '--fresh'])).toThrow('does not look like');
  });
});
