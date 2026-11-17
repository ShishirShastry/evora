import { net, protocol, type Session } from 'electron';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { desktopCsp } from '../src/persistence/desktopContract.js';
import { appFilePath, contentType } from './staticFiles.js';

/**
 * The app is served to its windows from app://evora/, a privileged scheme of
 * its own: the built web app (dist/) read from the package, so it works with
 * no server and no network. It is a secure, standard origin, so IndexedDB,
 * the clipboard and fonts work as on https. Its pages carry a strict
 * Content-Security-Policy.
 *
 * app://evora/api/… is passed on to the collaboration server chosen in the
 * settings, so the app's API client (which asks /api on its own origin) works
 * unchanged; with none chosen it answers 503. The live connection's WebSocket
 * goes to the server directly (src/collab/endpoint.ts).
 */

export const APP_SCHEME = 'app';
export const APP_HOST = 'evora';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
export const APP_URL = `${APP_ORIGIN}/`;

/** Must run before the app is ready. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true } },
  ]);
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}

/** Headers not passed on between the app and the server (hop-by-hop ones, and ones fetch sets itself). */
const DROPPED = new Set(['host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'origin', 'referer', 'content-length', 'content-encoding', 'cookie', 'set-cookie']);

async function proxy(request: Request, server: string | null, path: string, search: string): Promise<Response> {
  if (!server) {
    return json(503, { error: 'No collaboration server is set. Choose one in File ▸ Collaboration… to share files; files on this computer work without one.' });
  }
  const headers = new Headers();
  request.headers.forEach((value, name) => {
    if (!DROPPED.has(name.toLowerCase())) headers.set(name, value);
  });
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  try {
    const response = await fetch(`${server}${path}${search}`, {
      method: request.method,
      headers,
      body: hasBody ? await request.arrayBuffer() : undefined,
      redirect: 'manual',
    });
    const out = new Headers();
    response.headers.forEach((value, name) => {
      if (!DROPPED.has(name.toLowerCase())) out.set(name, value);
    });
    return new Response(response.status === 204 || response.status === 304 ? null : response.body, { status: response.status, statusText: response.statusText, headers: out });
  } catch (error) {
    return json(502, { error: `The collaboration server at ${server} could not be reached. ${error instanceof Error ? error.message : ''}`.trim() });
  }
}

/** Serves app://evora/ from `root` (the built app) for this session. `server()` is the collaboration server chosen now. */
export function serveApp(session: Session, root: string, server: () => string | null): void {
  session.protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== APP_HOST) return new Response('Not found', { status: 404 });
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return proxy(request, server(), url.pathname, url.search);
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
    const relative = appFilePath(url.pathname);
    const file = relative === null ? null : join(root, ...relative.split('/'));
    if (file && !isFile(file)) return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
    if (!file) return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
    const type = contentType(file);
    const response = await net.fetch(pathToFileURL(file).toString());
    const headers = new Headers({ 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' });
    if (type.startsWith('text/html')) {
      headers.set('Content-Security-Policy', desktopCsp(server()));
      headers.set('Referrer-Policy', 'no-referrer');
    }
    return new Response(response.body, { status: 200, headers });
  });
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Whether the built app is where it should be. */
export function hasBuiltApp(root: string): boolean {
  return existsSync(join(root, 'index.html'));
}
