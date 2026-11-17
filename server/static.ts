/**
 * Serving a built Evora (`npm run build` makes `dist/`) from the same server,
 * so one process is a whole self-hosted Evora: the files as they are, and
 * index.html for any other path (the app finds its way from the address).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.pdf': 'application/pdf',
  '.webmanifest': 'application/manifest+json',
};

function fileAt(path: string): { size: number } | null {
  try {
    const stats = statSync(path);
    return stats.isFile() ? { size: stats.size } : null;
  } catch {
    return null;
  }
}

/** Answers a request for the built app from `root`. */
export function serveStatic(root: string, req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Method not allowed');
    return;
  }
  const base = resolve(root);
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
  } catch {
    pathname = '/';
  }
  let path = resolve(join(base, pathname));
  // Nothing outside the folder is ever served.
  if (path !== base && !path.startsWith(base + sep)) path = join(base, 'index.html');
  let file = fileAt(path);
  if (!file) {
    path = join(base, 'index.html');
    file = fileAt(path);
  }
  if (!file) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }
  const isIndex = path === join(base, 'index.html');
  // Vite names built files by their content, so those can be kept; index.html is asked for again each time.
  const hashed = path.startsWith(join(base, 'assets') + sep);
  res.writeHead(200, {
    'Content-Type': TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': file.size,
    'Cache-Control': isIndex ? 'no-cache' : hashed ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(path)
    .on('error', () => res.destroy())
    .pipe(res);
}
