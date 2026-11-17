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
 * Google is off unless a client ID and secret are configured
 * (EVORA_GOOGLE_CLIENT_ID and EVORA_GOOGLE_CLIENT_SECRET).
 */
import { createHash, randomBytes } from 'node:crypto';

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
