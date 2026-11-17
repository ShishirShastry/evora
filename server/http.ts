/**
 * Small helpers for the HTTP API: errors with a status, reading a body up to
 * a limit, answering with JSON, and matching a request to a route.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const KB = 1024;
export const MB = 1024 * 1024;

/**
 * Reads a request's body, refusing more than `limit` bytes with 413. A body
 * that is too large is still read (and dropped) up to twice the limit, so the
 * client is answered rather than cut off; beyond that the connection is closed.
 */
export function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const tooBig = () => new HttpError(413, `The request is larger than ${Math.round(limit / MB) || 1} MB`);
    const drainLimit = limit * 2;
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > drainLimit) {
      reject(tooBig());
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > drainLimit) {
        done = true;
        reject(tooBig());
        return;
      }
      if (size > limit) chunks.length = 0;
      else chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      if (size > limit) reject(tooBig());
      else resolve(Buffer.concat(chunks, size));
    });
    req.on('error', (error) => {
      if (done) return;
      done = true;
      reject(error);
    });
  });
}

/** Reads a JSON object from a request's body; an empty body is `{}`. */
export async function readJson(req: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  const bytes = await readBody(req, limit);
  if (bytes.length === 0) return {};
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new HttpError(400, 'The body is not valid JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'The body must be a JSON object');
  return value as Record<string, unknown>;
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(text);
}

export function sendError(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  sendJson(res, status, { error: message });
}

// ------------------------------------------------------------------ routes

export interface Route<C> {
  method: string;
  parts: string[];
  handler: (ctx: C, params: Record<string, string>) => Promise<unknown> | unknown;
}

export function route<C>(method: string, pattern: string, handler: Route<C>['handler']): Route<C> {
  return { method, parts: pattern.split('/').filter(Boolean), handler };
}

/**
 * Finds the route for a method and path. Returns the route and its
 * parameters, `'method'` when the path exists for other methods, or null.
 */
export function match<C>(routes: Route<C>[], method: string, path: string): { route: Route<C>; params: Record<string, string> } | 'method' | null {
  const parts = path.split('/').filter(Boolean);
  let pathMatched = false;
  for (const candidate of routes) {
    if (candidate.parts.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < parts.length; i++) {
      const want = candidate.parts[i] as string;
      const got = parts[i] as string;
      if (want.startsWith(':')) {
        try {
          params[want.slice(1)] = decodeURIComponent(got);
        } catch {
          ok = false;
          break;
        }
      } else if (want !== got) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    if (candidate.method !== method) {
      pathMatched = true;
      continue;
    }
    return { route: candidate, params };
  }
  return pathMatched ? 'method' : null;
}

/** The address a request came from, for limits on repeated attempts. */
export function clientAddress(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? 'unknown';
}
