/**
 * The Evora collaboration server: the HTTP API under /api, the live
 * connection at /ws, and, when asked, the built app itself. `startServer` is
 * used by `main.ts` and by the tests, which start it in the same process.
 *
 * Two routes are answered here, before the API, so that they work whatever
 * state the rest is in and need no account:
 * - GET /api/health   -> {ok, version, uptime, db: "ok"} (200), or {ok: false, ..., db: "error"} (503)
 *                        when the database cannot be read, or while the server is stopping
 * - GET /api/version  -> {version, node, database}
 */
import * as community from './community.ts';
import * as plugins from './plugins.ts';
import * as versions from './versions.ts';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { readFileSync } from 'node:fs';
import { SOCKET_PATH, API_BASE } from '../src/collab/protocol.ts';
import { Store } from './store.ts';
import { Hub } from './hub.ts';
import { DEFAULT_LIMITS, createApi, type Limits } from './api.ts';
import { MB } from './http.ts';
import { WebSocketConnection, handshake } from './websocket.ts';
import { serveStatic } from './static.ts';
import type { GoogleConfig } from './google.ts';
import { TRUST_NOTHING, resolveClientAddress, setClientAddress, type TrustProxy } from './proxy.ts';

/** The close code live connections get when the server stops (1012, "service restart"): the app reconnects on it. */
export const CLOSE_RESTARTING = 1012;
export const RESTARTING_REASON = 'The server is restarting';

export interface ServerOptions {
  /** The port to listen on; 0 for any free port. */
  port: number;
  /** Where the database and images are kept. */
  dataDir: string;
  /** The address to listen on: 127.0.0.1 (this computer only) unless given, e.g. 0.0.0.0 for a network. */
  host?: string;
  /** A built app (`dist/`) to serve as well. */
  serveDir?: string;
  /** How often the server pings each live connection; one silent for twice as long is dropped (default 15 s). */
  heartbeatMs?: number;
  /** The largest WebSocket message and upload (default 50 MB). */
  maxMessageBytes?: number;
  /** The largest JSON body of most requests (default 2 MB). */
  maxJsonBytes?: number;
  /** Limits on repeated attempts (wrong passwords, accounts and guests made from one address). */
  limits?: Partial<Limits>;
  /** "Continue with Google": a Google OAuth client (see server/google.ts); off when not given. */
  google?: GoogleConfig | null;
  /** The app's public origin, e.g. https://evora.example.com (EVORA_PUBLIC_URL): where Google may send people back to, besides localhost. */
  publicUrl?: string | null;
  /** Which proxies in front may say who the client is in X-Forwarded-For (see server/proxy.ts); nobody by default. */
  trustProxy?: TrustProxy;
  /** How long `close()` waits for requests under way before it drops them (default 10 s). */
  shutdownMs?: number;
}

export interface RunningServer {
  /** Where it is, e.g. http://127.0.0.1:8787. */
  url: string;
  port: number;
  store: Store;
  hub: Hub;
  /**
   * Stops gracefully: no new connections or requests, live connections closed
   * with "server restarting" (1012), requests under way given until
   * `shutdownMs` to finish, then the database checkpointed and closed.
   */
  close(): Promise<void>;
}

export function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store', ...extra });
  res.end(text);
}

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const startedAt = Date.now();
  const version = packageVersion();
  const trust = options.trustProxy ?? TRUST_NOTHING;
  const maxMessageBytes = options.maxMessageBytes ?? 50 * MB;
  const shutdownMs = options.shutdownMs ?? 10_000;
  const store = new Store(options.dataDir);
  const hub = new Hub(store, { heartbeatMs: options.heartbeatMs ?? 15_000 });
  // The parts built on the API: their tables, then their routes.
  for (const part of [versions, plugins, community]) part.setup(store);
  const api = createApi(store, hub, {
    extensions: [versions.extension, plugins.extension, community.extension],
    version,
    maxJsonBytes: options.maxJsonBytes ?? 2 * MB,
    maxUploadBytes: maxMessageBytes,
    limits: { ...DEFAULT_LIMITS, ...options.limits },
    google: options.google ?? null,
    publicUrl: options.publicUrl ?? null,
  });

  let stopping = false;
  /** Requests being answered, so that a stop can wait for them. */
  let inFlight = 0;
  let onIdle: (() => void) | null = null;

  /** Whether the database answers a read. */
  function databaseOk(): { ok: true } | { ok: false; error: string } {
    try {
      store.db.prepare('SELECT count(*) AS n FROM meta').get();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  }

  function health(res: ServerResponse): void {
    const uptime = Math.floor((Date.now() - startedAt) / 1000);
    const db = databaseOk();
    if (stopping) sendJson(res, 503, { ok: false, version, uptime, db: db.ok ? 'ok' : 'error', stopping: true });
    else if (db.ok) sendJson(res, 200, { ok: true, version, uptime, db: 'ok' });
    else sendJson(res, 503, { ok: false, version, uptime, db: 'error', error: db.error });
  }

  function versionInfo(res: ServerResponse): void {
    let database: number | null = null;
    try {
      database = (store.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    } catch {
      // A database that cannot be read: health says so.
    }
    sendJson(res, 200, { version, node: process.versions.node, database });
  }

  function handle(req: IncomingMessage, res: ServerResponse): void {
    setClientAddress(req, resolveClientAddress(req.socket.remoteAddress, req.headers['x-forwarded-for'], trust));
    const path = (req.url ?? '/').split('?')[0] as string;
    if (path === `${API_BASE}/health` && (req.method === 'GET' || req.method === 'HEAD')) return health(res);
    if (path === `${API_BASE}/version`) {
      if (req.method === 'GET' || req.method === 'HEAD') return versionInfo(res);
      return sendJson(res, 405, { error: 'Method not allowed' }, { Allow: 'GET, HEAD' });
    }
    if (stopping) {
      // A request on a connection that was already open: the server is going, say so and close it.
      return sendJson(res, 503, { error: RESTARTING_REASON }, { Connection: 'close', 'Retry-After': '5' });
    }
    if (path === API_BASE || path.startsWith(`${API_BASE}/`)) {
      void api(req, res);
    } else if (options.serveDir) {
      serveStatic(options.serveDir, req, res);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('This is the Evora collaboration server: the app talks to it under /api and /ws.');
    }
  }

  const server: Server = createServer((req, res) => {
    inFlight++;
    let done = false;
    const finished = (): void => {
      if (done) return;
      done = true;
      inFlight--;
      if (inFlight === 0 && onIdle) onIdle();
    };
    res.on('finish', finished);
    res.on('close', finished);
    handle(req, res);
  });

  /** The connections that became WebSockets, which the HTTP server no longer closes itself. */
  const sockets = new Map<Socket, WebSocketConnection | null>();
  server.on('upgrade', (req, socket: Socket, head: Buffer) => {
    socket.on('error', () => socket.destroy());
    sockets.set(socket, null);
    socket.on('close', () => sockets.delete(socket));
    setClientAddress(req, resolveClientAddress(socket.remoteAddress, req.headers['x-forwarded-for'], trust));
    if (stopping) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nRetry-After: 5\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const path = (req.url ?? '/').split('?')[0];
    if (path !== SOCKET_PATH) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    if (!handshake(req, socket)) return;
    const conn = new WebSocketConnection(socket, head, { maxMessageBytes });
    sockets.set(socket, conn);
    hub.attach(conn);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host ?? '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;
  const shown = !options.host || options.host === '0.0.0.0' || options.host === '::' ? '127.0.0.1' : options.host;

  /** Waits for `ready()` to be true, or for `ms` to pass. */
  function settle(ready: () => boolean, set: (wake: (() => void) | null) => void, ms: number): Promise<void> {
    if (ready()) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms);
      timer.unref();
      function done(): void {
        clearTimeout(timer);
        set(null);
        resolve();
      }
      set(() => {
        if (ready()) done();
      });
    });
  }

  let closed: Promise<void> | null = null;
  async function stop(): Promise<void> {
    stopping = true;
    // No new connections; idle kept-alive ones are closed now, busy ones after their answer.
    const listening = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeIdleConnections();
    // Live connections: "server restarting", which the app reconnects on.
    for (const conn of sockets.values()) conn?.close(CLOSE_RESTARTING, RESTARTING_REASON);
    hub.closeAll();
    // Requests under way may finish, up to the time allowed.
    await settle(() => inFlight === 0, (wake) => (onIdle = wake), shutdownMs);
    server.closeAllConnections();
    // Give the close frames a moment to be answered, then drop what is left.
    let socketWake: (() => void) | null = null;
    const watch = setInterval(() => socketWake?.(), 20);
    await settle(() => sockets.size === 0, (wake) => (socketWake = wake), Math.min(1000, Math.max(200, shutdownMs)));
    clearInterval(watch);
    for (const socket of sockets.keys()) socket.destroy();
    await listening;
    // Everything in the write-ahead log into the database file, then closed.
    try {
      if (store.db.isOpen) store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      // A database that cannot be checkpointed is still closed; SQLite finishes the log when it is next opened.
    }
    store.close();
  }

  return {
    url: `http://${shown.includes(':') ? `[${shown}]` : shown}:${port}`,
    port,
    store,
    hub,
    close() {
      closed ??= stop();
      return closed;
    },
  };
}
