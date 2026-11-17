/**
 * Starts the Evora collaboration server:
 *
 *   node server/main.ts [--port 8787] [--data .evora-server] [--fresh] [--serve dist] [--host 127.0.0.1]
 *
 * --port   the port (default 8787, or EVORA_PORT)
 * --data   where accounts, documents and images are kept (default .evora-server, or EVORA_DATA)
 * --fresh  start from nothing: the data folder is emptied first (the browser tests use this)
 * --serve  also serve a built app from this folder, so one process is a whole self-hosted Evora
 * --host   the address to listen on (default 127.0.0.1, this computer only; 0.0.0.0 for a network; or EVORA_HOST)
 *
 * Runs with plain Node 24, which strips the types: nothing to build or install.
 */
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_SERVER_PORT } from '../src/collab/protocol.ts';
import { startServer } from './app.ts';

const { values } = parseArgs({
  options: {
    port: { type: 'string' },
    data: { type: 'string' },
    fresh: { type: 'boolean', default: false },
    serve: { type: 'string' },
    host: { type: 'string' },
  },
  strict: true,
});

const port = Number(values.port ?? process.env.EVORA_PORT ?? DEFAULT_SERVER_PORT);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`Not a port: ${values.port ?? process.env.EVORA_PORT}`);
  process.exit(1);
}
const dataDir = resolve(values.data ?? process.env.EVORA_DATA ?? '.evora-server');

if (values.fresh && existsSync(dataDir)) {
  // Only a folder this server made (or an empty one) is emptied, never some other folder named by mistake.
  const entries = readdirSync(dataDir);
  if (entries.length > 0 && !entries.includes('evora.db')) {
    console.error(`--fresh would delete ${dataDir}, which does not look like an Evora server's data folder; nothing was deleted.`);
    process.exit(1);
  }
  rmSync(dataDir, { recursive: true, force: true });
}

const serveDir = values.serve ? resolve(values.serve) : undefined;
if (serveDir && !existsSync(join(serveDir, 'index.html'))) {
  console.error(`--serve ${serveDir}: there is no index.html there (run "npm run build" first).`);
  process.exit(1);
}

const server = await startServer({ port, dataDir, serveDir, host: values.host ?? process.env.EVORA_HOST });
console.log(`Evora collaboration server on http://localhost:${server.port}`);

let stopping = false;
function stop(): void {
  if (stopping) return;
  stopping = true;
  void server.close().then(() => process.exit(0));
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
