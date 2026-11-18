import { describe, expect, it } from 'vitest';
import {
  MAX_PENDING_SIGN_INS,
  SIGN_IN_TTL_MS,
  acceptReturn,
  addPending,
  authUrlInArgv,
  codeChallenge,
  googleDesktopStartUrl,
  newNonce,
  newVerifier,
  parseAuthUrl,
  pendingFor,
  redeemTicket,
  refusalMessage,
  refusalShown,
  type PendingSignIn,
} from '../electron/auth';

/**
 * "Continue with Google" in the desktop app, without Electron: the address the
 * system's browser is sent to, reading the evora://auth address it comes back
 * at, accepting it only for the sign-in the app started, and redeeming the
 * ticket with the PKCE verifier (electron/auth.ts).
 */

const NONCE = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcd';
const TICKET = 'tIcKeT0123456789abcdefghijklmnopqrstuvwxyz_';
/** RFC 7636, appendix B: a verifier and its S256 challenge. */
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const SERVER = 'https://evora.example.com';

describe('the desktop app’s Google sign-in', () => {
  it('makes a fresh random nonce and verifier each time, in base64url', () => {
    const a = newNonce();
    const b = newNonce();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
    expect(newNonce((bytes) => bytes.fill(255))).toBe('_'.repeat(42) + '8');
    expect(newVerifier()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newVerifier()).not.toBe(newVerifier());
  });

  it('makes the S256 challenge of a verifier, as the server checks it', async () => {
    expect(await codeChallenge(VERIFIER)).toBe(CHALLENGE);
    expect(await codeChallenge(newVerifier())).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('opens the configured server’s own Google start, with the desktop flag, the nonce and the challenge (never the verifier)', () => {
    const address = googleDesktopStartUrl(`${SERVER}/`, 'signup', 'inv123', NONCE, CHALLENGE) as string;
    const url = new URL(address);
    expect(url.origin).toBe(SERVER);
    expect(url.pathname).toBe('/api/auth/google/start');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      origin: SERVER,
      mode: 'signup',
      invite: 'inv123',
      desktop: '1',
      nonce: NONCE,
      code_challenge: CHALLENGE,
      code_challenge_method: 'S256',
    });
    expect(address).not.toContain(VERIFIER);
    expect(new URL(googleDesktopStartUrl('localhost:8787', 'login', null, NONCE, CHALLENGE) as string).searchParams.get('invite')).toBeNull();
  });

  it('opens nothing for a missing or odd server address, a bad nonce or a bad challenge', () => {
    expect(googleDesktopStartUrl(null, 'login', null, NONCE, CHALLENGE)).toBeNull();
    expect(googleDesktopStartUrl('file:///etc/passwd', 'login', null, NONCE, CHALLENGE)).toBeNull();
    expect(googleDesktopStartUrl('javascript:alert(1)', 'login', null, NONCE, CHALLENGE)).toBeNull();
    expect(googleDesktopStartUrl(`${SERVER}/path`, 'login', null, NONCE, CHALLENGE)).toBeNull();
    expect(googleDesktopStartUrl(SERVER, 'login', null, 'short', CHALLENGE)).toBeNull();
    expect(googleDesktopStartUrl(SERVER, 'login', null, NONCE, 'short')).toBeNull();
  });

  it('reads evora://auth with a ticket or an error, and the nonce', () => {
    expect(parseAuthUrl(`evora://auth?ticket=${TICKET}&nonce=${NONCE}`)).toEqual({ nonce: NONCE, ticket: TICKET, error: null });
    expect(parseAuthUrl(`evora://auth/?ticket=${TICKET}&nonce=${NONCE}`)).toEqual({ nonce: NONCE, ticket: TICKET, error: null });
    expect(parseAuthUrl(`EVORA://auth?error=Signing+in+with+Google+was+cancelled&nonce=${NONCE}`)).toEqual({
      nonce: NONCE,
      ticket: null,
      error: 'Signing in with Google was cancelled',
    });
    expect(parseAuthUrl(`evora://auth?error=${'x'.repeat(1000)}&nonce=${NONCE}`)?.error).toHaveLength(300);
  });

  it('refuses anything else', () => {
    for (const value of [
      `https://auth?ticket=${TICKET}&nonce=${NONCE}`,
      `evora://other?ticket=${TICKET}&nonce=${NONCE}`,
      `evora://auth/path?ticket=${TICKET}&nonce=${NONCE}`,
      `evora://someone@auth?ticket=${TICKET}&nonce=${NONCE}`,
      `evora://auth?ticket=${TICKET}`,
      `evora://auth?ticket=${TICKET}&nonce=short`,
      `evora://auth?nonce=${NONCE}`,
      `evora://auth?ticket=${TICKET}&error=x&nonce=${NONCE}`,
      `evora://auth?ticket=bad%20ticket%20with%20spaces&nonce=${NONCE}`,
      `evora://auth?ticket=${'t'.repeat(3000)}&nonce=${NONCE}`,
      'not an address',
    ]) {
      expect(parseAuthUrl(value), value).toBeNull();
    }
  });

  it('finds the evora:// address on a second launch’s command line', () => {
    expect(authUrlInArgv(['--allow-file-access', `evora://auth?ticket=${TICKET}&nonce=${NONCE}`])).toBe(`evora://auth?ticket=${TICKET}&nonce=${NONCE}`);
    expect(authUrlInArgv(['C:\\designs\\a.evora', '--flag'])).toBeNull();
  });

  it('accepts the return only with the nonce it started with, while fresh, for the same server', () => {
    const pending: PendingSignIn = { nonce: NONCE, verifier: VERIFIER, server: SERVER, startedAt: 1_000_000, windowId: 3 };
    const back = { nonce: NONCE, ticket: TICKET, error: null };
    expect(acceptReturn(pending, back, 1_000_000 + 5000, SERVER)).toEqual({ ok: true, windowId: 3, server: SERVER, verifier: VERIFIER, ticket: TICKET, error: null });
    // The server as written in the settings is compared as an origin.
    expect(acceptReturn(pending, back, 1_000_001, `${SERVER}/`).ok).toBe(true);
    expect(acceptReturn(pending, { nonce: NONCE, ticket: null, error: 'No & way' }, 1_000_001, SERVER)).toEqual({
      ok: true,
      windowId: 3,
      server: SERVER,
      verifier: VERIFIER,
      ticket: null,
      error: 'No & way',
    });

    // A return the app did not start, another sign-in's, one too late, and one for a server changed since.
    expect(acceptReturn(null, back, 1_000_001, SERVER)).toEqual({ ok: false, reason: 'none' });
    expect(acceptReturn(pending, { ...back, nonce: `${NONCE.slice(0, -1)}X` }, 1_000_001, SERVER)).toEqual({ ok: false, reason: 'nonce' });
    expect(acceptReturn(pending, { ...back, nonce: 'a-different-length-nonce-1234' }, 1_000_001, SERVER)).toEqual({ ok: false, reason: 'nonce' });
    expect(acceptReturn(pending, back, 1_000_000 + SIGN_IN_TTL_MS + 1, SERVER)).toEqual({ ok: false, reason: 'expired' });
    expect(acceptReturn(pending, back, 999_999, SERVER)).toEqual({ ok: false, reason: 'expired' });
    expect(acceptReturn(pending, back, 1_000_001, 'https://other.example.com')).toEqual({ ok: false, reason: 'server' });
    expect(acceptReturn(pending, back, 1_000_001, null)).toEqual({ ok: false, reason: 'server' });
  });

  it('keeps each sign-in started until it comes back, so an earlier one still finishes in its own window', () => {
    const at = (nonce: string, windowId: number, startedAt: number): PendingSignIn => ({ nonce, verifier: VERIFIER, server: SERVER, startedAt, windowId });
    const first = at(NONCE, 1, 1_000_000);
    const second = at(`${NONCE.slice(0, -1)}X`, 2, 1_000_100);
    let { kept, dropped } = addPending([], first, 1_000_000);
    ({ kept, dropped } = addPending(kept, second, 1_000_100));
    expect(kept).toEqual([first, second]);
    expect(dropped).toEqual([]);
    // The first browser tab finished: it is the first window's sign-in, accepted, not "Evora did not start this".
    const back = { nonce: NONCE, ticket: TICKET, error: null };
    expect(pendingFor(kept, NONCE)).toBe(first);
    expect(acceptReturn(pendingFor(kept, NONCE), back, 1_000_200, SERVER)).toMatchObject({ ok: true, windowId: 1 });
    expect(pendingFor(kept, second.nonce)).toBe(second);
    // A nonce of none of them is refused as another's; with none waiting, it is ignored.
    expect(acceptReturn(pendingFor(kept, 'a-different-length-nonce-1234'), { ...back, nonce: 'a-different-length-nonce-1234' }, 1_000_200, SERVER)).toEqual({ ok: false, reason: 'nonce' });
    expect(pendingFor([], NONCE)).toBeNull();
    // Expired ones are let go when another starts, and only so many wait: the oldest is dropped, and its window told.
    const late = addPending(kept, at('late-nonce-0123456789abcdef', 3, 1_000_000 + SIGN_IN_TTL_MS + 1), 1_000_000 + SIGN_IN_TTL_MS + 1);
    expect(late.dropped).toEqual([{ pending: first, reason: 'expired' }]);
    let many: PendingSignIn[] = [];
    let last: ReturnType<typeof addPending> = { kept: [], dropped: [] };
    for (let i = 0; i <= MAX_PENDING_SIGN_INS; i++) {
      last = addPending(many, at(`nonce-number-${i}-0123456789abcdef`, i, 2_000_000 + i), 2_000_000 + i);
      many = last.kept;
    }
    expect(many).toHaveLength(MAX_PENDING_SIGN_INS);
    expect(last.dropped).toEqual([{ pending: at('nonce-number-0-0123456789abcdef', 0, 2_000_000), reason: 'replaced' }]);
  });

  it('ignores a return when no sign-in waits, and says why for the others', () => {
    expect(refusalShown('none')).toBe(false);
    // Any page or program can launch evora://auth with some nonce: no alarming dialog for it (the app only comes forward).
    expect(refusalShown('nonce')).toBe(false);
    expect(refusalShown('expired')).toBe(true);
    expect(refusalShown('server')).toBe(true);
    expect(refusalMessage('expired')).toMatch(/too long/);
    expect(refusalMessage('nonce')).toMatch(/did not start/);
    expect(refusalMessage('server')).toMatch(/collaboration server was changed/);
  });

  it('redeems the ticket at the server it started at, with the verifier, and reads the session', async () => {
    const sent: Array<{ url: string; body: unknown }> = [];
    const account = { token: 'session-token', user: { id: 'u1', email: 'alex@example.com', name: 'Alex', color: '#0d99ff', createdAt: '2026-11-18T10:00:00.000Z' } };
    const fetcher = (async (url: string, init: RequestInit) => {
      sent.push({ url, body: JSON.parse(String(init.body)) });
      return Response.json({ ...account, extra: 'ignored' });
    }) as unknown as typeof fetch;
    expect(await redeemTicket(SERVER, TICKET, VERIFIER, fetcher)).toEqual({ ok: true, account });
    expect(sent).toEqual([{ url: `${SERVER}/api/auth/google/redeem`, body: { ticket: TICKET, verifier: VERIFIER } }]);
  });

  it('says why a redeem failed, without throwing', async () => {
    const answer = (response: Response | Error) =>
      (async () => {
        if (response instanceof Error) throw response;
        return response;
      }) as unknown as typeof fetch;
    expect(await redeemTicket(SERVER, TICKET, VERIFIER, answer(Response.json({ error: 'This sign-in can only be finished by the app that started it: try again' }, { status: 401 })))).toEqual({
      ok: false,
      message: 'This sign-in can only be finished by the app that started it: try again',
    });
    expect((await redeemTicket(SERVER, TICKET, VERIFIER, answer(new TypeError('Failed to fetch')))).ok).toBe(false);
    expect((await redeemTicket(SERVER, TICKET, VERIFIER, answer(new Response('not json', { status: 200 })))).ok).toBe(false);
    expect((await redeemTicket(SERVER, TICKET, VERIFIER, answer(Response.json({ token: 'x' })))).ok).toBe(false);
  });
});
