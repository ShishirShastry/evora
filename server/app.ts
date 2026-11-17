/**
 * The Evora collaboration server: the HTTP API under /api, the live
 * connection at /ws, and, when asked, the built app itself. `startServer` is
 * used by `main.ts` and by the tests, which start it in the same process.
 */
import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { readFileSync } from 'node:fs';
import { SOCKET_PATH, API_BASE } from '../src/collab/protocol.ts';
import { Store } from './store.ts';
import { Hub } from './hub.ts';
import { DEFAULT_LIMITS, createApi, type Limits } from './api.ts';
import { MB } from './http.ts';
import { WebSocketConnection, handshake } from './websocket.ts';
import { serveStatic } from './static.ts';

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
  /** Limits on repeated attempts (wrong passwords, accounts and guests made from one address). */
  limits?: Partial<Limits>;
}

export interface RunningServer {
  /** Where it is, e.g. http://127.0.0.1:8787. */
  url: string;
  port: number;
  store: Store;
  hub: Hub;
  close(): Promise<void>;
}

function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const maxMessageBytes = options.maxMessageBytes ?? 50 * MB;
  const store = new Store(options.dataDir);
  const hub = new Hub(store, { heartbeatMs: options.heartbeatMs ?? 15_000 });
  const api = createApi(store, hub, {
    version: packageVersion(),
    maxJsonBytes: 2 * MB,
    maxUploadBytes: maxMessageBytes,
    limits: { ...DEFAULT_LIMITS, ...options.limits },
  });

  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0] as string;
    if (path === API_BASE || path.startsWith(`${API_BASE}/`)) {
      void api(req, res);
    } else if (options.serveDir) {
      serveStatic(options.serveDir, req, res);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('This is the Evora collaboration server: the app talks to it under /api and /ws.');
    }
  });

  /** The connections that became WebSockets, which the HTTP server no longer closes itself. */
  const sockets = new Set<Socket>();
  server.on('upgrade', (req, socket: Socket, head: Buffer) => {
    socket.on('error', () => socket.destroy());
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const path = (req.url ?? '/').split('?')[0];
    if (path !== SOCKET_PATH) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    if (!handshake(req, socket)) return;
    hub.attach(new WebSocketConnection(socket, head, { maxMessageBytes }));
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

  let closed: Promise<void> | null = null;
  return {
    url: `http://${shown.includes(':') ? `[${shown}]` : shown}:${port}`,
    port,
    store,
    hub,
    close() {
      closed ??= new Promise<void>((resolve) => {
        hub.closeAll();
        server.close(() => {
          store.close();
          resolve();
        });
        server.closeAllConnections();
        // WebSocket connections are no longer the HTTP server's: give their close frames a moment, then drop them.
        setTimeout(() => {
          for (const socket of sockets) socket.destroy();
        }, 200).unref();
      });
      return closed;
    },
  };
}
