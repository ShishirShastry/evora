/**
 * Where the collaboration server is, for the parts of the app that cannot
 * simply ask their own origin.
 *
 * In a browser the app talks to `/api` and `/ws` on the origin it was loaded
 * from, and nothing here is set. The desktop app is loaded from its own
 * `app://evora/` address: its HTTP requests to `/api` are passed on to the
 * configured server by the desktop app itself, but a WebSocket cannot be, and
 * links given to other people must name the server; the desktop bridge sets
 * both here (src/ui/desktop/DesktopMount.tsx).
 */

let serverOrigin: string | null = null;

/** Sets (or, with null, clears) the collaboration server's origin, e.g. http://192.168.1.20:8787. */
export function setServerOrigin(origin: string | null): void {
  serverOrigin = origin;
}

/** The configured server's origin, or null when the app's own origin is the server. */
export function configuredServerOrigin(): string | null {
  return serverOrigin;
}

/** The WebSocket address of the live connection, when a server is configured; null means "on the page's own origin". */
export function configuredSocketUrl(): string | null {
  return serverOrigin === null ? null : `${serverOrigin.replace(/^http/, 'ws')}/ws`;
}

/** The address links to this app start with: the server's when one is configured, else the page's own. */
export function linkOrigin(): string {
  if (serverOrigin !== null) return `${serverOrigin}/`;
  return typeof location === 'undefined' ? '' : `${location.origin}${location.pathname}`;
}
