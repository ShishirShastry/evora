/**
 * "Continue with Google": signing in and up with a Google account, by the
 * OAuth 2.0 authorization-code flow with PKCE, done entirely by the server.
 *
 * 1. The app sends the browser to /api/auth/google/start?origin=…&mode=…;
 *    the server keeps a random `state` (hashed) with the PKCE verifier, the
 *    app's origin and an expiry, sets it in a cookie of that browser too, and
 *    sends the browser on to Google's consent page.
 * 2. Google sends the browser back to <origin>/api/auth/google/callback with a
 *    code. The server checks the state (once only, not expired, and the same
 *    browser), trades the code for an access token with its client secret and
 *    the verifier, and reads who it is (a verified email is required).
 * 3. The account is found by its Google ID, else by its email (and linked),
 *    else made. The browser goes back to <origin>/#/auth/google?ticket=… with
 *    a one-time ticket (kept hashed, valid for two minutes) that the app trades
 *    for a session at /api/auth/google/redeem. The session token itself is
 *    never in a URL.
 *
 * The desktop app ends its sign-ins differently (evora://auth): see "the desktop
 * app" below.
 *
 * Google is off unless a client ID and secret are configured
 * (EVORA_GOOGLE_CLIENT_ID and EVORA_GOOGLE_CLIENT_SECRET).
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export interface GoogleEndpoints {
  /** Where the browser is sent to give consent. */
  authorization: string;
  /** Where the server trades the code for tokens. */
  token: string;
  /** Where the server reads who signed in. */
  userinfo: string;
}

export const GOOGLE_ENDPOINTS: GoogleEndpoints = {
  authorization: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  userinfo: 'https://openidconnect.googleapis.com/v1/userinfo',
};

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  /** Google's own endpoints unless given (tests give a fake Google's). */
  endpoints?: Partial<GoogleEndpoints>;
}

/** How long a sign-in may take at Google before its state is no longer accepted. */
export const STATE_TTL_MS = 10 * 60 * 1000;
/** How long the app has to redeem its ticket after coming back. */
export const TICKET_TTL_MS = 2 * 60 * 1000;
/** The cookie that ties a sign-in to the browser that started it. */
export const STATE_COOKIE = 'evora_google_state';
export const CALLBACK_PATH = '/api/auth/google/callback';

/** Google's configuration from the environment, or null when it is not set up (the feature is then off). */
export function googleFromEnv(env: Record<string, string | undefined>, clientIdFlag?: string): GoogleConfig | null {
  const clientId = (clientIdFlag ?? env.EVORA_GOOGLE_CLIENT_ID ?? '').trim();
  const clientSecret = (env.EVORA_GOOGLE_CLIENT_SECRET ?? '').trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

export function endpointsOf(config: GoogleConfig): GoogleEndpoints {
  return { ...GOOGLE_ENDPOINTS, ...config.endpoints };
}

/** An origin as written by `URL`, e.g. http://localhost:5173, or null when `value` is not just an origin. */
export function asOrigin(value: string | undefined | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * The origin the browser may be sent back to: the app's public URL when it is
 * configured and asked for, or any port of this computer (localhost or
 * 127.0.0.1) for development. Anything else is refused, so the server never
 * sends a ticket to a site it does not know.
 */
export function allowedOrigin(asked: string | undefined | null, publicUrl: string | undefined | null): string | null {
  const configured = asOrigin(publicUrl);
  if (!asked) return configured;
  const origin = asOrigin(asked);
  if (!origin) return null;
  if (configured && origin === configured) return origin;
  const { hostname } = new URL(origin);
  return hostname === 'localhost' || hostname === '127.0.0.1' ? origin : null;
}

/** A PKCE verifier and its S256 challenge. */
export function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

/** The URL of Google's consent page for this sign-in. */
export function consentUrl(config: GoogleConfig, redirectUri: string, state: string, challenge: string): string {
  const url = new URL(endpointsOf(config).authorization);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('prompt', 'select_account');
  return url.toString();
}

/** Who signed in, as Google says. */
export interface GoogleProfile {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string;
}

/** A failure to show the person, as a short message. */
export class GoogleError extends Error {}

async function readJson(response: Response, what: string): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new GoogleError(`Google sent an answer that could not be read (${what})`);
  }
  if (!body || typeof body !== 'object') throw new GoogleError(`Google sent an answer that could not be read (${what})`);
  return body as Record<string, unknown>;
}

/** Trades the code for an access token, then reads the profile with it. */
export async function fetchProfile(config: GoogleConfig, code: string, verifier: string, redirectUri: string): Promise<GoogleProfile> {
  const endpoints = endpointsOf(config);
  let tokenResponse: Response;
  try {
    tokenResponse = await fetch(endpoints.token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new GoogleError('Google could not be reached');
  }
  const tokens = await readJson(tokenResponse, 'token');
  if (!tokenResponse.ok || typeof tokens.access_token !== 'string') throw new GoogleError('Google did not accept the sign-in');

  let infoResponse: Response;
  try {
    infoResponse = await fetch(endpoints.userinfo, {
      headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new GoogleError('Google could not be reached');
  }
  const info = await readJson(infoResponse, 'profile');
  if (!infoResponse.ok || typeof info.sub !== 'string' || !info.sub || typeof info.email !== 'string' || !info.email)
    throw new GoogleError('Google did not say who signed in');
  const verified = info.email_verified === true || info.email_verified === 'true';
  const name = typeof info.name === 'string' && info.name.trim() ? info.name.trim().slice(0, 100) : info.email.split('@')[0]?.slice(0, 100) || 'Someone';
  return { sub: info.sub, email: info.email, emailVerified: verified, name };
}

/** Reads one cookie from a Cookie header. */
export function cookieValue(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

// ------------------------------------------------------------------ the desktop app

/*
 * The desktop app (Electron) cannot be sent back to: its pages are at
 * app://evora/, which Google cannot redirect to. So it signs in through the
 * system's browser:
 *
 * 1. The app makes a random PKCE verifier, which stays in its main process,
 *    and opens /api/auth/google/start?…&desktop=1&nonce=<random>
 *    &code_challenge=<base64url(SHA-256(verifier))>&code_challenge_method=S256
 *    in the system's browser (the origin is the server's own). The nonce and
 *    the challenge are kept here, in memory, beside the state, for as long as
 *    the state lives.
 * 2. Google comes back to the callback in that browser as usual (the state
 *    cookie is checked as usual). The one-time ticket is made as usual, but
 *    bound to the challenge (`ticketKey`), and instead of going to the web app
 *    the browser is shown a page that says "Click Open Evora to finish", with
 *    a link to evora://auth?ticket=…&nonce=…, which the system hands to the app.
 * 3. The app checks that the nonce is the one it started with, then redeems
 *    the ticket at /api/auth/google/redeem with the verifier. A desktop ticket
 *    is redeemed only with the verifier its challenge was made from; one
 *    brought without it, or with another, is refused and burned. So another
 *    program that registered evora:// too and caught the address cannot use
 *    the ticket: it does not have the verifier, which is never in an address.
 *
 * The nonce lets the app refuse a return it did not ask for. The flow is kept
 * in memory only: a server restarted in the middle of a sign-in has forgotten
 * that it was the desktop's, and that sign-in finishes in the web app at the
 * origin instead (a known, safe failure: the origin is one the server accepts
 * anyway). A ticket, once made, is in the database with its challenge, so a
 * restart never makes a desktop ticket redeemable without the verifier.
 */

/** The address the desktop app is registered for, where a desktop sign-in ends. */
export const DESKTOP_RETURN = 'evora://auth';
/** A nonce the desktop app makes: 16 to 96 random bytes, in base64url. */
export const NONCE_PATTERN = /^[A-Za-z0-9_-]{22,128}$/;
/** A PKCE S256 challenge: a SHA-256 hash in base64url, without padding. */
export const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** A PKCE verifier (RFC 7636): 43 to 128 unreserved characters. */
export const VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;

/** What a desktop start brings: the nonce of the return, and the challenge its ticket is bound to. */
export interface DesktopStart {
  nonce: string;
  challenge: string;
}

/**
 * Whether a start asks for the desktop flow: null when it does not (the web
 * flow, unchanged), its nonce and challenge when it does, or 'invalid' when it
 * asks with a missing or malformed nonce or challenge.
 */
export function desktopStart(query: URLSearchParams): DesktopStart | null | 'invalid' {
  if (!query.has('desktop')) return null;
  if (query.get('desktop') !== '1') return 'invalid';
  const nonce = query.get('nonce') ?? '';
  const challenge = query.get('code_challenge') ?? '';
  const method = query.get('code_challenge_method') ?? 'S256';
  if (!NONCE_PATTERN.test(nonce) || !CHALLENGE_PATTERN.test(challenge) || method !== 'S256') return 'invalid';
  return { nonce, challenge };
}

/** The S256 challenge of a verifier. */
export function challengeOf(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/** Whether `verifier` is the one `challenge` was made from, compared in constant time. */
export function verifierMatches(verifier: unknown, challenge: string): boolean {
  if (typeof verifier !== 'string' || !VERIFIER_PATTERN.test(verifier)) return false;
  const made = Buffer.from(challengeOf(verifier));
  const expected = Buffer.from(challenge);
  return made.length === expected.length && timingSafeEqual(made, expected);
}

/*
 * How a ticket is kept (google_tickets.ticket_hash): the SHA-256 of the ticket
 * in hex for a web ticket, and that followed by "." and its challenge for a
 * desktop ticket. Both are found by one range over the hash (`ticketKeyRange`),
 * so a desktop ticket brought without its verifier is still found, and burned.
 */

/** The key a ticket is kept under: its hash, and the challenge it is bound to (desktop) or none (web). */
export function ticketKey(ticketHash: string, challenge: string | null): string {
  return challenge ? `${ticketHash}.${challenge}` : ticketHash;
}

/** The range of keys [from, to) a ticket with this hash may be kept under. */
export function ticketKeyRange(ticketHash: string): [string, string] {
  // "/" comes right after ".": every `${hash}.${challenge}` is below `${hash}/`, and no other hash (all 64 hex digits) is in between.
  return [ticketHash, `${ticketHash}/`];
}

/** The challenge a kept ticket is bound to, or null for a web ticket. */
export function challengeOfKey(key: string): string | null {
  const dot = key.indexOf('.');
  return dot < 0 ? null : key.slice(dot + 1);
}

/** Whether a kept ticket may be redeemed with this verifier: a web ticket always, a desktop one only with its own. */
export function ticketRedeemable(key: string, verifier: unknown): boolean {
  const challenge = challengeOfKey(key);
  return challenge === null || verifierMatches(verifier, challenge);
}

/**
 * The desktop sign-ins under way: the nonce and challenge of each, by the hash
 * of its state, until the state expires. Bounded, since anyone may start a
 * sign-in: when full, the oldest is forgotten first (that sign-in then finishes
 * in the web app).
 */
export class DesktopFlows {
  private readonly flows = new Map<string, DesktopStart & { expiresAt: number }>();

  private readonly max: number;
  private readonly ttlMs: number;

  constructor(max = 10_000, ttlMs = STATE_TTL_MS) {
    this.max = max;
    this.ttlMs = ttlMs;
  }

  get size(): number {
    return this.flows.size;
  }

  begin(stateHash: string, start: DesktopStart, now = Date.now()): void {
    for (const [key, flow] of this.flows) {
      // Kept in the order they began, all with the same lifetime: the expired ones are at the front.
      if (flow.expiresAt > now) break;
      this.flows.delete(key);
    }
    while (this.flows.size >= this.max) {
      const oldest = this.flows.keys().next().value;
      if (oldest === undefined) break;
      this.flows.delete(oldest);
    }
    this.flows.set(stateHash, { nonce: start.nonce, challenge: start.challenge, expiresAt: now + this.ttlMs });
  }

  /** A desktop sign-in's nonce and challenge, once only; null for a web sign-in, one already taken, or one expired. */
  take(stateHash: string, now = Date.now()): DesktopStart | null {
    const flow = this.flows.get(stateHash);
    if (!flow) return null;
    this.flows.delete(stateHash);
    return flow.expiresAt > now ? { nonce: flow.nonce, challenge: flow.challenge } : null;
  }
}

/** evora://auth?ticket=…&nonce=… (or error=… in place of the ticket). */
export function desktopReturnUrl(nonce: string, params: { ticket: string } | { error: string }): string {
  const query = new URLSearchParams('ticket' in params ? { ticket: params.ticket } : { error: params.error });
  query.set('nonce', nonce);
  return `${DESKTOP_RETURN}?${query.toString()}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

/** Only the page below's own inline style; no scripts, frames or forms. */
export const DESKTOP_PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/**
 * The page the system's browser shows at the end of a desktop sign-in. Its
 * main action is the "Open Evora" link to `returnUrl` (evora://…), which the
 * text asks the person to click; it also tries to go there by itself with a
 * meta refresh, as a best effort (browsers may ask first, or not follow it).
 */
export function desktopReturnPage(returnUrl: string, error: string | null): string {
  const url = escapeHtml(returnUrl);
  const heading = error ? 'Signing in with Google did not finish' : 'Click Open Evora to finish';
  const body = error
    ? `<p>${escapeHtml(error)}</p><p>Click Open Evora to go back to Evora, then try again.</p>`
    : `<p>Google has confirmed who you are. Click <strong>Open Evora</strong> to finish signing in; if your browser asks whether to open Evora, allow it.</p>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="0;url=${url}">
<title>${heading} - Evora</title>
<style>
body { margin: 0; min-height: 100vh; display: grid; place-items: center; font: 15px/1.5 system-ui, sans-serif; background: #f6f6f7; color: #18181b; }
main { max-width: 26rem; padding: 2rem; }
h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
.open { display: inline-block; padding: .6rem 1.2rem; border-radius: 8px; background: #0b6bcb; color: #fff; font-weight: 600; text-decoration: none; }
.open:focus-visible { outline: 3px solid #6cb6ff; outline-offset: 2px; }
@media (prefers-color-scheme: dark) { body { background: #0b0b0d; color: #ececef; } .open { background: #3d8fe0; } }
</style>
</head>
<body>
<main>
<h1>${heading}</h1>
${body}
<p><a class="open" href="${url}">Open Evora</a></p>
<p>You can close this tab afterwards.</p>
</main>
</body>
</html>
`;
}
