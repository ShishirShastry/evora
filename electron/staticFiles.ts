/**
 * Serving the built app's files (electron/appProtocol.ts): which file a URL
 * path names, and its type. Plain string work, with no Electron or Node, so
 * it is unit-tested with the app's tests.
 */

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  wasm: 'application/wasm',
};

export function contentType(file: string): string {
  const name = file.split(/[/\\]/).pop() ?? '';
  const dot = name.lastIndexOf('.');
  return (dot > 0 && TYPES[name.slice(dot + 1).toLowerCase()]) || 'application/octet-stream';
}

/**
 * The path inside the app's folder that a URL path names ("index.html" for
 * "/"), or null when it would leave the folder: "..", also written %2e%2e,
 * a backslash, a NUL, or something that does not decode.
 */
export function appFilePath(pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\') || /^[a-z]:/i.test(decoded.replace(/^\/+/, ''))) return null;
  const parts = decoded.split('/').filter((part) => part !== '');
  if (parts.some((part) => part === '.' || part === '..')) return null;
  return parts.length === 0 ? 'index.html' : parts.join('/');
}
