import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { PEOPLE_COLORS, type AuthResult } from '../src/collab/protocol.ts';
import { call, newDoc, personalWorkspace, signUp, tempDir, testServer, type TestServer } from './testing.ts';
import { Store } from './store.ts';
import { allowedOrigin, asOrigin, cookieValue, googleFromEnv } from './google.ts';

/**
 * "Continue with Google", against a fake Google: a small HTTP server in this
 * test that plays the consent page (it sends the browser straight back with a
 * code), the token endpoint (which checks the client secret, the PKCE
 * verifier and the redirect URI) and the userinfo endpoint.
 */

const CLIENT_ID = 'evora-test-client.apps.example';
const CLIENT_SECRET = 'not-a-real-secret';

interface Profile {
  sub: string;
  email: string;
  email_verified: boolean | string;
  name?: string;
}

/** The fake Google. `next` is who signs in at the consent page. */
class FakeGoogle {
  server!: Server;
  url = '';
  next: Profile = { sub: '0', email: 'nobody@example.com', email_verified: true };
  /** What the token endpoint refused, and why. */
  refusals: string[] = [];
  private codes = new Map<string, { challenge: string; redirectUri: string; profile: Profile }>();
  private tokens = new Map<string, Profile>();

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const address = this.server.address();
    this.url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  get endpoints() {
    return { authorization: `${this.url}/o/oauth2/v2/auth`, token: `${this.url}/token`, userinfo: `${this.url}/v1/userinfo` };
  }

  private async handle(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.url);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/o/oauth2/v2/auth') {
      const q = url.searchParams;
      const ok =
        q.get('client_id') === CLIENT_ID &&
        q.get('response_type') === 'code' &&
        q.get('scope') === 'openid email profile' &&
        q.get('code_challenge_method') === 'S256' &&
        q.get('prompt') === 'select_account' &&
        !!q.get('code_challenge') &&
        !!q.get('state') &&
        !!q.get('redirect_uri');
      if (!ok) return json(400, { error: 'invalid_request' });
      const code = randomBytes(12).toString('hex');
      this.codes.set(code, { challenge: q.get('code_challenge') as string, redirectUri: q.get('redirect_uri') as string, profile: this.next });
      res.writeHead(302, { Location: `${q.get('redirect_uri')}?${new URLSearchParams({ code, state: q.get('state') as string })}` });
      res.end();
      return;
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      let text = '';
      for await (const chunk of req) text += chunk;
      const form = new URLSearchParams(text);
      const held = this.codes.get(form.get('code') ?? '');
      const refuse = (why: string) => {
        this.refusals.push(why);
        json(400, { error: 'invalid_grant' });
      };
      if (!held) return refuse('code');
      this.codes.delete(form.get('code') as string);
      if (form.get('grant_type') !== 'authorization_code') return refuse('grant_type');
      if (form.get('client_id') !== CLIENT_ID || form.get('client_secret') !== CLIENT_SECRET) return refuse('client');
      if (form.get('redirect_uri') !== held.redirectUri) return refuse('redirect_uri');
      const verifier = form.get('code_verifier') ?? '';
      if (createHash('sha256').update(verifier).digest('base64url') !== held.challenge) return refuse('verifier');
      const token = randomBytes(12).toString('hex');
      this.tokens.set(token, held.profile);
      return json(200, { access_token: token, token_type: 'Bearer', expires_in: 3599, id_token: 'unused' });
    }
    if (url.pathname === '/v1/userinfo') {
      const profile = this.tokens.get((req.headers.authorization ?? '').replace(/^Bearer /, ''));
      if (!profile) return json(401, { error: 'invalid_token' });
      return json(200, { picture: 'https://example.com/p.png', ...profile });
    }
    json(404, { error: 'not found' });
  }
}

const google = new FakeGoogle();
let server: TestServer;

beforeAll(async () => {
  await google.start();
  server = await testServer({ google: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, endpoints: google.endpoints } });
});

afterAll(async () => {
  await server.stop();
  await google.stop();
});

let people = 0;
function profile(name: string, extra: Partial<Profile> = {}): Profile {
  people++;
  return { sub: `10${people}${Date.now()}`, email: `${name.toLowerCase()}.${people}@gmail.example`, email_verified: true, name, ...extra };
}

interface Started {
  /** Google's consent page. */
  consent: URL;
  /** The cookie the start set in the browser. */
  cookie: string;
}

async function start(query: Record<string, string>, target: { url: string } = server): Promise<Started> {
  const res = await fetch(`${target.url}/api/auth/google/start?${new URLSearchParams(query)}`, { redirect: 'manual' });
  expect(res.status).toBe(302);
  const setCookie = res.headers.get('set-cookie') ?? '';
  expect(setCookie).toMatch(/HttpOnly/);
  expect(setCookie).toMatch(/SameSite=Lax/);
  return { consent: new URL(res.headers.get('location') as string), cookie: setCookie.split(';')[0] as string };
}

/** Google's answer: where it sends the browser back to (the callback, with a code and the state). */
async function consent(started: Started): Promise<URL> {
  const res = await fetch(started.consent, { redirect: 'manual' });
  expect(res.status).toBe(302);
  return new URL(res.headers.get('location') as string);
}

/** Follows the callback as the browser would; returns where it sends the browser: the app's #/auth/google?… */
async function callback(url: URL, cookie: string): Promise<{ origin: string; params: URLSearchParams; location: string }> {
  // The callback is on the app's origin; in these tests the app is the server itself.
  const res = await fetch(`${server.url}${url.pathname}${url.search}`, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} });
  expect(res.status).toBe(302);
  const location = res.headers.get('location') as string;
  const [before, after = ''] = location.split('#/auth/google?');
  return { origin: (before as string).replace(/\/$/, ''), params: new URLSearchParams(after), location };
}

/** The whole sign-in, as the person's browser goes through it; resolves with the account's session. */
async function signInWithGoogle(who: Profile, query: Record<string, string> = {}): Promise<AuthResult> {
  google.next = who;
  const started = await start({ origin: server.url, mode: 'login', ...query });
  const back = await callback(await consent(started), started.cookie);
  const ticket = back.params.get('ticket');
  if (!ticket) throw new Error(`No ticket: ${back.location}`);
  const redeemed = await call<AuthResult>(server, 'POST', '/api/auth/google/redeem', { body: { ticket } });
  expect(redeemed.status).toBe(200);
  return redeemed.body;
}

describe('Continue with Google', () => {
  it('says Google is offered when it is configured, and not when it is not', async () => {
    expect((await call(server, 'GET', '/api/auth/providers')).body).toEqual({ google: true });
    const plain = await testServer();
    try {
      expect((await call(plain, 'GET', '/api/auth/providers')).body).toEqual({ google: false });
      const res = await fetch(`${plain.url}/api/auth/google/start?origin=${encodeURIComponent(plain.url)}&mode=login`, { redirect: 'manual' });
      expect(res.status).toBe(404);
    } finally {
      await plain.stop();
    }
  });

  it('sends the browser to Google with PKCE, a state, and the callback on the app’s origin', async () => {
    const started = await start({ origin: 'http://localhost:5173', mode: 'signup' });
    expect(`${started.consent.origin}${started.consent.pathname}`).toBe(google.endpoints.authorization);
    const q = started.consent.searchParams;
    expect(q.get('client_id')).toBe(CLIENT_ID);
    expect(q.get('redirect_uri')).toBe('http://localhost:5173/api/auth/google/callback');
    expect(q.get('scope')).toBe('openid email profile');
    expect(q.get('response_type')).toBe('code');
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(q.get('prompt')).toBe('select_account');
    expect(q.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(started.cookie).toBe(`evora_google_state=${q.get('state')}`);
    // The state is kept hashed, with its verifier; the secret is never sent to the browser.
    expect(server.store.one(`SELECT 1 AS found FROM google_states WHERE state_hash = ?`, q.get('state') as string)).toBeUndefined();
    const kept = server.store.one<{ verifier: string; origin: string; mode: string }>(
      `SELECT verifier, origin, mode FROM google_states WHERE state_hash = ?`,
      createHash('sha256').update(q.get('state') as string).digest('hex'),
    );
    expect(kept).toMatchObject({ origin: 'http://localhost:5173', mode: 'signup' });
    expect(createHash('sha256').update(kept?.verifier ?? '').digest('base64url')).toBe(q.get('code_challenge'));
    expect(started.consent.toString()).not.toContain(CLIENT_SECRET);
  });

  it('accepts only the app’s own origins', async () => {
    for (const origin of ['https://evil.example', 'http://localhost.evil.example', 'javascript:alert(1)', 'http://localhost:5173/path', '']) {
      const res = await fetch(`${server.url}/api/auth/google/start?${new URLSearchParams({ origin, mode: 'login' })}`, { redirect: 'manual' });
      expect(res.status, origin).toBe(400);
    }
    expect(allowedOrigin('http://127.0.0.1:8080', null)).toBe('http://127.0.0.1:8080');
    expect(allowedOrigin('https://localhost', null)).toBe('https://localhost');
    expect(allowedOrigin('https://evora.example.com', 'https://evora.example.com')).toBe('https://evora.example.com');
    expect(allowedOrigin(undefined, 'https://evora.example.com/')).toBe('https://evora.example.com');
    expect(allowedOrigin('https://other.example.com', 'https://evora.example.com')).toBeNull();
    expect(asOrigin('https://evora.example.com/app')).toBeNull();
  });

  it('makes a new account: the name from Google, no password, a workspace of its own, a colour', async () => {
    const who = profile('Hedy', { name: 'Hedy Lamarr' });
    const { token, user } = await signInWithGoogle(who);
    expect(user).toMatchObject({ email: who.email, name: 'Hedy Lamarr' });
    expect(PEOPLE_COLORS).toContain(user.color);
    const me = await call(server, 'GET', '/api/me', { token });
    expect(me.status).toBe(200);
    expect(me.body.workspaces).toEqual([expect.objectContaining({ name: "Hedy Lamarr's workspace", role: 'owner' })]);
    const row = server.store.one<{ password: string; google_sub: string }>(`SELECT password, google_sub FROM users WHERE id = ?`, user.id);
    expect(row).toEqual({ password: '', google_sub: who.sub });

    // No password: signing in with one fails as a wrong one does.
    const wrong = await call(server, 'POST', '/api/auth/login', { body: { email: who.email, password: '' } });
    const guessed = await call(server, 'POST', '/api/auth/login', { body: { email: who.email, password: 'anything at all' } });
    expect(wrong.status).toBe(401);
    expect(guessed.status).toBe(401);
    expect(guessed.body.error).toBe('Wrong email or password');

    // A password can be set later, and then works.
    expect((await call(server, 'PATCH', '/api/me', { token, body: { password: 'a password now' } })).status).toBe(200);
    expect((await call(server, 'POST', '/api/auth/login', { body: { email: who.email, password: 'a password now' } })).status).toBe(200);
  });

  it('signs in again by the Google account, even after its email changed at Google', async () => {
    const who = profile('Ada');
    const first = await signInWithGoogle(who);
    const again = await signInWithGoogle({ ...who, email: `renamed.${who.email}` });
    expect(again.user.id).toBe(first.user.id);
    expect(again.token).not.toBe(first.token);
    expect(server.store.all(`SELECT id FROM users WHERE google_sub = ?`, who.sub)).toHaveLength(1);
  });

  it('links Google to an existing account with the same email', async () => {
    const existing = await signUp(server, 'Grace', `grace.${Date.now()}@gmail.example`);
    const who = profile('Grace', { email: existing.user.email.toUpperCase() });
    const { user } = await signInWithGoogle(who);
    expect(user.id).toBe(existing.user.id);
    expect(server.store.one<{ google_sub: string }>(`SELECT google_sub FROM users WHERE id = ?`, user.id)?.google_sub).toBe(who.sub);
    // The password still works too.
    expect((await call(server, 'POST', '/api/auth/login', { body: { email: existing.user.email, password: 'correct horse battery' } })).status).toBe(200);
    // Another Google account with that email is not linked over it.
    google.next = { ...who, sub: `${who.sub}-other` };
    const started = await start({ origin: server.url, mode: 'login' });
    const back = await callback(await consent(started), started.cookie);
    expect(back.params.get('error')).toMatch(/linked to another Google account/);
  });

  it('takes up pending email invitations, as signing up does', async () => {
    const owner = await signUp(server, 'Owner');
    const workspaceId = await personalWorkspace(server, owner.token);
    const doc = await newDoc(server, owner.token, 'Brief');
    const who = profile('Invitee');
    await call(server, 'POST', `/api/workspaces/${workspaceId}/members`, { token: owner.token, body: { email: who.email, role: 'editor' } });
    await call(server, 'POST', `/api/documents/${doc.id}/members`, { token: owner.token, body: { email: who.email, role: 'viewer' } });
    const { token } = await signInWithGoogle(who);
    const me = await call(server, 'GET', '/api/me', { token });
    expect(me.body.workspaces).toEqual(expect.arrayContaining([expect.objectContaining({ id: workspaceId, role: 'editor' })]));
    expect((await call(server, 'GET', `/api/documents/${doc.id}`, { token })).body.role).toBe('editor');
    expect(server.store.all(`SELECT * FROM workspace_invites WHERE email = ?`, who.email)).toHaveLength(0);
    const notes = await call(server, 'GET', '/api/notifications', { token });
    expect(notes.body.map((n: { kind: string }) => n.kind).sort()).toEqual(['invite', 'shared']);
  });

  it('joins the workspace of the invite link it was started from', async () => {
    const owner = await signUp(server, 'Linker');
    const workspaceId = await personalWorkspace(server, owner.token);
    const link = await call(server, 'POST', `/api/workspaces/${workspaceId}/invites`, { token: owner.token, body: { role: 'viewer' } });
    const { token } = await signInWithGoogle(profile('Follower'), { invite: link.body.token });
    const me = await call(server, 'GET', '/api/me', { token });
    expect(me.body.workspaces).toEqual(expect.arrayContaining([expect.objectContaining({ id: workspaceId, role: 'viewer' })]));
  });

  it('refuses an email Google has not verified', async () => {
    const who = profile('Unverified', { email_verified: false });
    google.next = who;
    const started = await start({ origin: server.url, mode: 'signup' });
    const back = await callback(await consent(started), started.cookie);
    expect(back.origin).toBe(server.url);
    expect(back.params.get('error')).toMatch(/not verified/);
    expect(back.params.get('ticket')).toBeNull();
    expect(server.store.userByEmail(who.email)).toBeUndefined();
    // "true" as a string is how some answers say it, and is accepted.
    const stringy = await signInWithGoogle(profile('Stringy', { email_verified: 'true' }));
    expect(stringy.user.name).toBe('Stringy');
  });

  it('uses a state once only', async () => {
    google.next = profile('Twice');
    const started = await start({ origin: server.url, mode: 'login' });
    const url = await consent(started);
    const first = await callback(url, started.cookie);
    expect(first.params.get('ticket')).toBeTruthy();
    const second = await callback(url, started.cookie);
    expect(second.origin).toBe(server.url);
    expect(second.params.get('error')).toMatch(/already used/);
  });

  it('refuses a state that has expired', async () => {
    google.next = profile('Slow');
    const started = await start({ origin: server.url, mode: 'login' });
    const url = await consent(started);
    server.store.run(`UPDATE google_states SET expires_at = ? WHERE state_hash = ?`, Date.now() - 1, createHash('sha256').update(url.searchParams.get('state') as string).digest('hex'));
    const back = await callback(url, started.cookie);
    expect(back.params.get('error')).toMatch(/too long/);
    expect(server.store.userByEmail(google.next.email)).toBeUndefined();
  });

  it('refuses a state it never gave out, and one brought from another browser', async () => {
    const bad = await fetch(`${server.url}/api/auth/google/callback?code=x&state=made-up`, { redirect: 'manual' });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toMatch(/not valid/);
    expect((await fetch(`${server.url}/api/auth/google/callback?code=x`, { redirect: 'manual' })).status).toBe(400);

    google.next = profile('Victim');
    const started = await start({ origin: server.url, mode: 'login' });
    const url = await consent(started);
    // Someone else's callback link, opened in a browser that did not start the sign-in.
    const elsewhere = await callback(url, '');
    expect(elsewhere.params.get('error')).toMatch(/another browser/);
    expect(server.store.userByEmail(google.next.email)).toBeUndefined();
  });

  it('sends a cancelled consent back with an error', async () => {
    const started = await start({ origin: server.url, mode: 'login' });
    const state = started.consent.searchParams.get('state') as string;
    const back = await callback(new URL(`${server.url}/api/auth/google/callback?error=access_denied&state=${state}`), started.cookie);
    expect(back.params.get('error')).toBe('Signing in with Google was cancelled');
  });

  it('refuses a code when the token endpoint does (a wrong client secret)', async () => {
    const wrongSecret = await testServer({ google: { clientId: CLIENT_ID, clientSecret: 'wrong', endpoints: google.endpoints } });
    try {
      google.next = profile('Secretless');
      const res = await fetch(`${wrongSecret.url}/api/auth/google/start?${new URLSearchParams({ origin: wrongSecret.url, mode: 'login' })}`, { redirect: 'manual' });
      const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] as string;
      const url = await consent({ consent: new URL(res.headers.get('location') as string), cookie });
      const back = await fetch(`${wrongSecret.url}${url.pathname}${url.search}`, { redirect: 'manual', headers: { Cookie: cookie } });
      expect(back.headers.get('location')).toMatch(/#\/auth\/google\?error=Google\+did\+not\+accept/);
      expect(google.refusals).toContain('client');
    } finally {
      await wrongSecret.stop();
    }
  });

  it('sends the PKCE verifier and the same redirect URI to the token endpoint, which checks them', async () => {
    // Every sign-in above passed the fake token endpoint's checks; here the state's verifier, then its origin, is spoiled.
    const hash = (state: string) => createHash('sha256').update(state).digest('hex');
    google.next = profile('Pkce');
    let started = await start({ origin: server.url, mode: 'login' });
    let url = await consent(started);
    server.store.run(`UPDATE google_states SET verifier = 'not-the-verifier' WHERE state_hash = ?`, hash(url.searchParams.get('state') as string));
    expect((await callback(url, started.cookie)).params.get('error')).toMatch(/did not accept/);
    expect(google.refusals.at(-1)).toBe('verifier');

    started = await start({ origin: server.url, mode: 'login' });
    url = await consent(started);
    server.store.run(`UPDATE google_states SET origin = 'http://localhost:1' WHERE state_hash = ?`, hash(url.searchParams.get('state') as string));
    const back = await callback(url, started.cookie);
    expect(back.origin).toBe('http://localhost:1');
    expect(back.params.get('error')).toMatch(/did not accept/);
    expect(google.refusals.at(-1)).toBe('redirect_uri');
    expect(server.store.userByEmail(google.next.email)).toBeUndefined();
  });

  it('redeems a ticket once only, and never puts the session token in a URL', async () => {
    google.next = profile('Ticket');
    const started = await start({ origin: server.url, mode: 'login' });
    const back = await callback(await consent(started), started.cookie);
    const ticket = back.params.get('ticket') as string;
    expect(ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(server.store.all(`SELECT * FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.email = ?`, google.next.email)).toHaveLength(0);
    const first = await call<AuthResult>(server, 'POST', '/api/auth/google/redeem', { body: { ticket } });
    expect(first.status).toBe(200);
    expect(back.location).not.toContain(first.body.token);
    const second = await call(server, 'POST', '/api/auth/google/redeem', { body: { ticket } });
    expect(second.status).toBe(401);
    expect((await call(server, 'POST', '/api/auth/google/redeem', { body: {} })).status).toBe(400);
  });

  it('refuses a ticket that has expired', async () => {
    google.next = profile('Late');
    const started = await start({ origin: server.url, mode: 'login' });
    const back = await callback(await consent(started), started.cookie);
    const ticket = back.params.get('ticket') as string;
    server.store.run(`UPDATE google_tickets SET expires_at = ? WHERE ticket_hash = ?`, Date.now() - 1, createHash('sha256').update(ticket).digest('hex'));
    expect((await call(server, 'POST', '/api/auth/google/redeem', { body: { ticket } })).status).toBe(401);
  });

  it('reads its configuration from the environment, and a cookie from a header', () => {
    expect(googleFromEnv({})).toBeNull();
    expect(googleFromEnv({ EVORA_GOOGLE_CLIENT_ID: 'id' })).toBeNull();
    expect(googleFromEnv({ EVORA_GOOGLE_CLIENT_ID: ' id ', EVORA_GOOGLE_CLIENT_SECRET: 'secret' })).toEqual({ clientId: 'id', clientSecret: 'secret' });
    expect(googleFromEnv({ EVORA_GOOGLE_CLIENT_SECRET: 'secret' }, 'flag-id')).toEqual({ clientId: 'flag-id', clientSecret: 'secret' });
    expect(cookieValue('a=1; evora_google_state=xyz; b=2', 'evora_google_state')).toBe('xyz');
    expect(cookieValue(undefined, 'a')).toBeNull();
  });
});

describe('the database before Google', () => {
  it('is brought up to date, keeping its accounts', () => {
    const dir = tempDir();
    // A database as the first version made it: users without google_sub, user_version 1.
    const old = new DatabaseSync(join(dir, 'evora.db'));
    old.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, color TEXT NOT NULL, password TEXT NOT NULL, created_at TEXT NOT NULL);
      INSERT INTO users VALUES ('u1', 'old@example.com', 'Old', '#0d99ff', 'scrypt:1:1:1:a:b', '2026-11-01T00:00:00.000Z');
      PRAGMA user_version = 1;`);
    old.close();
    const store = new Store(dir);
    try {
      expect(store.userByEmail('old@example.com')).toMatchObject({ id: 'u1', name: 'Old', google_sub: null });
      expect(store.one<{ user_version: number }>(`PRAGMA user_version`)?.user_version).toBe(2);
      store.run(`UPDATE users SET google_sub = 'g1' WHERE id = 'u1'`);
      expect(store.userByGoogle('g1')?.id).toBe('u1');
      store.run(`INSERT INTO users (id, email, name, color, password, created_at) VALUES ('u2', 'b@example.com', 'B', '#0d99ff', '', 'x')`);
      store.run(`INSERT INTO users (id, email, name, color, password, created_at) VALUES ('u3', 'c@example.com', 'C', '#0d99ff', '', 'x')`);
      expect(() => store.run(`UPDATE users SET google_sub = 'g1' WHERE id = 'u2'`)).toThrow();
    } finally {
      store.close();
    }
    // Opening it again changes nothing.
    new Store(dir).close();
  });
});
