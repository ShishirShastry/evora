/**
 * Small helpers for the HTTP API: errors with a status, reading a body up to
 * a limit, answering with JSON, and matching a request to a route.
 */
import { requestAddress } from './proxy.ts';
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

/** How deeply arrays and objects may be nested in a JSON body or a register's value. */
export const MAX_JSON_DEPTH = 64;

/**
 * Whether a parsed JSON value nests arrays and objects more than `limit`
 * deep. Walked without recursion, so a hostile value cannot overflow the
 * stack here; values nested that deep would overflow it later (in
 * JSON.stringify, structuredClone or the app's own recursive code).
 */
export function tooDeep(value: unknown, limit = MAX_JSON_DEPTH): boolean {
  if (!value || typeof value !== 'object') return false;
  const stack: { value: object; depth: number }[] = [{ value, depth: 1 }];
  while (stack.length > 0) {
    const { value: current, depth } = stack.pop() as { value: object; depth: number };
    if (depth > limit) return true;
    for (const child of Array.isArray(current) ? current : Object.values(current)) if (child && typeof child === 'object') stack.push({ value: child, depth: depth + 1 });
  }
  return false;
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
  if (tooDeep(value)) throw new HttpError(400, `The body is nested more than ${MAX_JSON_DEPTH} levels deep`);
  return value as Record<string, unknown>;
}

// ------------------------------------------------------------------ headers

/** What every answer of the API says: it is data, never a page, a frame or a script. */
export const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/**
 * Headers every response of the server carries (the API, the app and its
 * files): no sniffing a type other than the one given, no referrer sent to
 * other sites, never shown in another site's frame, and, when the request
 * came over HTTPS (TLS here, or a proxy that says so), HSTS.
 */
export function securityHeaders(req: IncomingMessage, res: ServerResponse): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  const forwarded = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0]?.trim().toLowerCase();
  if ((req.socket as { encrypted?: boolean }).encrypted || forwarded === 'https') res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

/** The image types an uploaded image is served as; anything else is served as bytes (application/octet-stream). */
export const IMAGE_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/svg+xml', 'image/bmp', 'image/x-icon'];

/**
 * The type an upload is kept and served as: the declared type when it is one
 * of IMAGE_TYPES (without parameters), otherwise application/octet-stream,
 * so that nothing uploaded is ever served as a page, a script or a style
 * sheet from this site, whatever the uploader said it was.
 */
export function uploadType(declared: unknown): string {
  const type = String(declared ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  return IMAGE_TYPES.includes(type) ? type : 'application/octet-stream';
}

/** Whether bytes begin as a picture of the given type does (PNG, JPEG, WebP). */
export function looksLike(type: string, bytes: Uint8Array): boolean {
  const at = (offset: number, ...values: number[]) => values.every((value, i) => bytes[offset + i] === value);
  if (type === 'image/png') return at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  if (type === 'image/jpeg') return at(0, 0xff, 0xd8, 0xff);
  if (type === 'image/webp') return at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50);
  return false;
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': API_CSP,
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
/** The client's address: the socket's, or behind a trusted proxy the one it forwarded (server/proxy.ts, EVORA_TRUST_PROXY). */
export function clientAddress(req: IncomingMessage): string {
  return requestAddress(req);
}
