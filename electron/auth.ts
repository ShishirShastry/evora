/**
 * "Continue with Google" in the desktop app: the parts that need no Electron,
 * so they can be tested on their own (src/desktopAuth.test.ts).
 *
 * The app's pages are at app://evora/, where Google cannot send anyone back.
 * So the sign-in happens in the system's browser:
 *
 * 1. The main process makes a random nonce and a random PKCE verifier, keeps
 *    them with the time, the window and the collaboration server's origin, and
 *    opens the server's /api/auth/google/start with `desktop=1&nonce=…` and
 *    `code_challenge=<base64url(SHA-256(verifier))>` in the system's browser
 *    (`googleDesktopStartUrl`).
 * 2. The server runs the usual Google flow there and, at the end, shows a page
 *    whose "Open Evora" link goes to evora://auth?ticket=…&nonce=… (or error=…
 *    in place of the ticket). The system hands that address to the app:
 *    'open-url' on macOS, the second instance's command line on Windows and
 *    Linux.
 * 3. The app reads it (`parseAuthUrl`) and accepts it only with the nonce it
 *    made, within the time a sign-in may take, for the same server, and once
 *    (`acceptReturn`). The main process then redeems the one-time ticket itself,
 *    with the verifier (`redeemTicket`), and hands the session to the window
 *    that started the sign-in, which keeps it where it is (no navigation).
 *
 * Several sign-ins may wait at once (`addPending`, `pendingFor`), each for the
 * window that started it.
 *
 * The server redeems a desktop ticket only with its verifier (and a web ticket
 * only without one), so another program that registered evora:// too and
 * caught the address of a sign-in this app started cannot use it. PKCE does not
 * stop such a program from starting a sign-in of its own in the person's
 * browser and catching that one's address (RFC 8252, 8.6): the server's last
 * page says to go on only after clicking Continue with Google in Evora.
 * The verifier never leaves the main process: it is in no address, no IPC
 * message and no log. Only the one-time ticket is ever in an address, and none
 * of this is logged.
 */
import type { GoogleAccount, GoogleSignInResult } from '../src/persistence/desktopContract.js';
import { normalizeServerUrl } from '../src/persistence/desktopContract.js';

/** The scheme the app is registered for (app.setAsDefaultProtocolClient, and `build.protocols` for the installers). */
export const AUTH_SCHEME = 'evora';
/** How long a sign-in started in the browser may take: as long as the server keeps its state (server/google.ts). */
export const SIGN_IN_TTL_MS = 10 * 60 * 1000;
/** A nonce: base64url, as the server accepts it. */
export const NONCE_PATTERN = /^[A-Za-z0-9_-]{22,128}$/;
/** An S256 PKCE challenge: base64url of a SHA-256 hash. */
const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** A one-time ticket from the server: base64url. */
const TICKET_PATTERN = /^[A-Za-z0-9_-]{20,200}$/;
/** The longest error message taken from an evora:// address. */
const MAX_ERROR = 300;
/** How long redeeming the ticket may take. */
const REDEEM_TIMEOUT_MS = 15_000;

/** A sign-in the app started and waits for. Kept in the main process only. */
export interface PendingSignIn {
  nonce: string;
  /** The PKCE verifier the ticket is redeemed with; never sent anywhere but the server's redeem. */
  verifier: string;
  /** The collaboration server's origin the sign-in was started at. */
  server: string;
  /** When it was started (ms since 1970). */
  startedAt: number;
  /** The window that started it, which the result goes back to. */
  windowId: number;
}

/** What an evora://auth address brings back: a ticket or an error, with the nonce. */
export interface AuthReturn {
  nonce: string;
  ticket: string | null;
  error: string | null;
}

type Random = (bytes: Uint8Array<ArrayBuffer>) => void;
const systemRandom: Random = (bytes) => void crypto.getRandomValues(bytes);

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A new random nonce: 32 bytes in base64url (43 characters). */
export function newNonce(random: Random = systemRandom): string {
  const bytes = new Uint8Array(32);
  random(bytes);
  return base64url(bytes);
}

/** A new random PKCE verifier: 32 bytes in base64url (43 characters, as RFC 7636 asks at least). */
export function newVerifier(random: Random = systemRandom): string {
  return newNonce(random);
}

/** The S256 challenge of a verifier: base64url(SHA-256(verifier)). */
export async function codeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/**
 * The address the system's browser is sent to: the server's own Google start,
 * with the server's origin as the origin (Google comes back to the server
 * itself), the desktop flag, the nonce and the PKCE challenge. Null when
 * `server` is not an http(s) server address, or the nonce or challenge is not one.
 */
export function googleDesktopStartUrl(server: string | null, mode: 'login' | 'signup', invite: string | null, nonce: string, challenge: string): string | null {
  const origin = server ? normalizeServerUrl(server) : null;
  if (!origin || !NONCE_PATTERN.test(nonce) || !CHALLENGE_PATTERN.test(challenge)) return null;
  const query = new URLSearchParams({ origin, mode: mode === 'signup' ? 'signup' : 'login' });
  if (invite && invite.length <= 200) query.set('invite', invite);
  query.set('desktop', '1');
  query.set('nonce', nonce);
  query.set('code_challenge', challenge);
  query.set('code_challenge_method', 'S256');
  return `${origin}/api/auth/google/start?${query.toString()}`;
}

/** Reads an evora://auth?… address; null when it is anything else, or malformed. */
export function parseAuthUrl(value: string): AuthReturn | null {
  if (typeof value !== 'string' || value.length > 2000 || !value.toLowerCase().startsWith(`${AUTH_SCHEME}://`)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== `${AUTH_SCHEME}:` || url.hostname !== 'auth' || (url.pathname !== '' && url.pathname !== '/') || url.username || url.password || url.port) return null;
  const nonce = url.searchParams.get('nonce') ?? '';
  const ticket = url.searchParams.get('ticket');
  const error = url.searchParams.get('error');
  if (!NONCE_PATTERN.test(nonce)) return null;
  // Exactly one of the two.
  if ((ticket === null) === (error === null)) return null;
  if (ticket !== null) return TICKET_PATTERN.test(ticket) ? { nonce, ticket, error: null } : null;
  const message = (error ?? '').trim().slice(0, MAX_ERROR);
  return { nonce, ticket: null, error: message || 'Signing in with Google did not finish' };
}

/** The evora:// address among a second instance's (or the first's) command-line arguments, if there is one. */
export function authUrlInArgv(argv: readonly string[]): string | null {
  for (const arg of argv) if (typeof arg === 'string' && arg.toLowerCase().startsWith(`${AUTH_SCHEME}://`)) return arg;
  return null;
}

/** Compares two strings in a time that does not depend on where they differ. */
function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

/** Why a return was not accepted: no sign-in waits, another nonce, too late, or the collaboration server changed since. */
export type RefusalReason = 'none' | 'nonce' | 'expired' | 'server';

export type ReturnCheck =
  | { ok: true; windowId: number; server: string; verifier: string; ticket: string; error: null }
  | { ok: true; windowId: number; server: string; verifier: string; ticket: null; error: string }
  | { ok: false; reason: RefusalReason };

/**
 * Whether a return is the one the app waits for: the same nonce, within
 * SIGN_IN_TTL_MS of the start, with the same collaboration server as at the
 * start (`currentServer`, as in the settings now). A return with another nonce
 * leaves the pending sign-in waiting; the caller forgets the pending one once
 * it is accepted, has expired or its server changed, so each nonce works once.
 */
export function acceptReturn(pending: PendingSignIn | null, back: AuthReturn, now: number, currentServer: string | null): ReturnCheck {
  if (!pending) return { ok: false, reason: 'none' };
  if (!sameText(pending.nonce, back.nonce)) return { ok: false, reason: 'nonce' };
  if (now - pending.startedAt > SIGN_IN_TTL_MS || now < pending.startedAt) return { ok: false, reason: 'expired' };
  const current = currentServer ? normalizeServerUrl(currentServer) : null;
  if (current !== pending.server) return { ok: false, reason: 'server' };
  const base = { ok: true as const, windowId: pending.windowId, server: pending.server, verifier: pending.verifier };
  return back.ticket !== null
    ? { ...base, ticket: back.ticket, error: null }
    : { ...base, ticket: null, error: back.error ?? 'Signing in with Google did not finish' };
}

/** How many sign-ins may wait at once (several windows, or a second click while the browser was slow). */
export const MAX_PENDING_SIGN_INS = 5;

/** A sign-in let go when another started: too late by then, or the oldest of too many. */
export interface DroppedSignIn {
  pending: PendingSignIn;
  reason: 'expired' | 'replaced';
}

/**
 * The sign-ins waiting once `next` has started: each is kept until it comes back, so an earlier one (from another
 * window, or an earlier click) still finishes in the window that started it. Expired ones are let go, and beyond
 * MAX_PENDING_SIGN_INS the oldest; those are in `dropped`, so that their windows can stop waiting.
 */
export function addPending(pendings: readonly PendingSignIn[], next: PendingSignIn, now: number): { kept: PendingSignIn[]; dropped: DroppedSignIn[] } {
  const dropped: DroppedSignIn[] = [];
  const kept: PendingSignIn[] = [];
  for (const pending of pendings) {
    if (now - pending.startedAt > SIGN_IN_TTL_MS || now < pending.startedAt) dropped.push({ pending, reason: 'expired' });
    else kept.push(pending);
  }
  kept.push(next);
  while (kept.length > MAX_PENDING_SIGN_INS) dropped.push({ pending: kept.shift() as PendingSignIn, reason: 'replaced' });
  return { kept, dropped };
}

/**
 * The waiting sign-in a return with this nonce is for; when none has it, the latest (which `acceptReturn` then
 * refuses as another's), or null when none waits.
 */
export function pendingFor(pendings: readonly PendingSignIn[], nonce: string): PendingSignIn | null {
  let found: PendingSignIn | null = null;
  // Every one is compared, so the time taken does not say which matched.
  for (const pending of pendings) if (sameText(pending.nonce, nonce)) found = pending;
  return found ?? pendings[pendings.length - 1] ?? null;
}

/**
 * Whether a refused return is worth a dialog: not when no sign-in was waiting (it is ignored), nor for another nonce,
 * since any page or program can launch evora://auth with one (the app only comes forward; the sign-in keeps waiting).
 */
export function refusalShown(reason: RefusalReason): boolean {
  return reason !== 'none' && reason !== 'nonce';
}

/** What to tell a window whose sign-in was let go because others started after it. */
export const REPLACED_MESSAGE = 'Another sign-in with Google was started, so this one was stopped. Try “Continue with Google” again.';

/** What to tell the person about a return that was not accepted. */
export function refusalMessage(reason: RefusalReason): string {
  if (reason === 'expired') return 'The sign-in with Google took too long. Try “Continue with Google” again.';
  if (reason === 'server')
    return 'The collaboration server was changed after this sign-in with Google started, so it was not finished. Try “Continue with Google” again.';
  return 'Evora did not start this sign-in with Google, so it was ignored. Try “Continue with Google” again from Evora.';
}

function accountOf(body: unknown): GoogleAccount | null {
  if (!body || typeof body !== 'object') return null;
  const { token, user } = body as { token?: unknown; user?: unknown };
  if (typeof token !== 'string' || !token || !user || typeof user !== 'object') return null;
  const { id, email, name, color, createdAt } = user as Record<string, unknown>;
  if (typeof id !== 'string' || typeof email !== 'string' || typeof name !== 'string' || typeof color !== 'string' || typeof createdAt !== 'string') return null;
  return { token, user: { id, email, name, color, createdAt } };
}

/**
 * Trades the one-time ticket for a session at the server the sign-in was
 * started at, with the PKCE verifier. Never throws: a failure comes back as a
 * message to show. Nothing here is logged.
 */
export async function redeemTicket(server: string, ticket: string, verifier: string, fetcher: typeof fetch = fetch): Promise<GoogleSignInResult> {
  let response: Response;
  try {
    response = await fetcher(`${server}/api/auth/google/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ ticket, verifier }),
      signal: AbortSignal.timeout(REDEEM_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, message: 'The collaboration server could not be reached to finish signing in with Google. Try again.' };
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Not JSON: said below.
  }
  if (response.ok) {
    const account = accountOf(body);
    return account ? { ok: true, account } : { ok: false, message: 'The collaboration server sent an answer that could not be read. Try again.' };
  }
  const error = body && typeof body === 'object' ? (body as { error?: unknown }).error : null;
  return { ok: false, message: typeof error === 'string' && error ? error.slice(0, MAX_ERROR) : 'Signing in with Google did not finish. Try again.' };
}
