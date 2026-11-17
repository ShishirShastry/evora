import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PEOPLE_COLORS } from '../src/collab/protocol.ts';
import { call, signUp, testServer, type TestServer } from './testing.ts';
import { hashPassword, verifyPassword, RateLimiter } from './auth.ts';

let server: TestServer;

beforeAll(async () => {
  server = await testServer({ limits: { loginFailures: 3 } });
});

afterAll(async () => {
  await server.stop();
});

describe('accounts', () => {
  it('answers the health check with the version', async () => {
    const answer = await call(server, 'GET', '/api/health');
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ ok: true, version: expect.any(String) });
  });

  it('signs up with an email, a name and a password, and gives a personal workspace', async () => {
    const answer = await call(server, 'POST', '/api/auth/signup', { body: { email: ' Grace@Example.com ', name: 'Grace', password: 'a long password' } });
    expect(answer.status).toBe(201);
    expect(answer.body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(answer.body.user).toMatchObject({ email: 'grace@example.com', name: 'Grace' });
    expect(PEOPLE_COLORS).toContain(answer.body.user.color);

    const me = await call(server, 'GET', '/api/me', { token: answer.body.token });
    expect(me.status).toBe(200);
    expect(me.body.user.id).toBe(answer.body.user.id);
    expect(me.body.workspaces).toEqual([expect.objectContaining({ name: "Grace's workspace", role: 'owner', memberCount: 1 })]);
  });

  it('gives people colours in turn', async () => {
    const first = await signUp(server, 'First');
    const second = await signUp(server, 'Second');
    const a = PEOPLE_COLORS.indexOf(first.user.color);
    expect(second.user.color).toBe(PEOPLE_COLORS[(a + 1) % PEOPLE_COLORS.length]);
  });

  it('refuses a second account with the same email, and checks what is sent', async () => {
    await call(server, 'POST', '/api/auth/signup', { body: { email: 'twice@example.com', name: 'Once', password: 'password one' } });
    const again = await call(server, 'POST', '/api/auth/signup', { body: { email: 'TWICE@example.com', name: 'Twice', password: 'password two' } });
    expect(again.status).toBe(409);
    expect(again.body.error).toBeTruthy();
    expect((await call(server, 'POST', '/api/auth/signup', { body: { email: 'nobody', name: 'X', password: 'password one' } })).status).toBe(400);
    expect((await call(server, 'POST', '/api/auth/signup', { body: { email: 'short@example.com', name: 'X', password: 'short' } })).status).toBe(400);
    expect((await call(server, 'POST', '/api/auth/signup', { body: { email: 'noname@example.com', password: 'password one' } })).status).toBe(400);
  });

  it('signs in with the right password and not with a wrong one', async () => {
    await call(server, 'POST', '/api/auth/signup', { body: { email: 'login@example.com', name: 'Login', password: 'the right one' } });
    const right = await call(server, 'POST', '/api/auth/login', { body: { email: 'Login@Example.com', password: 'the right one' } });
    expect(right.status).toBe(200);
    expect(right.body.user.email).toBe('login@example.com');
    expect((await call(server, 'GET', '/api/me', { token: right.body.token })).status).toBe(200);

    const wrong = await call(server, 'POST', '/api/auth/login', { body: { email: 'login@example.com', password: 'the wrong one' } });
    expect(wrong.status).toBe(401);
    const unknown = await call(server, 'POST', '/api/auth/login', { body: { email: 'nobody@example.com', password: 'the right one' } });
    expect(unknown.status).toBe(401);
    // The same answer, so that it does not tell whether an account exists.
    expect(unknown.body.error).toBe(wrong.body.error);
  });

  it('keeps passwords as salted hashes and tokens only as hashes', async () => {
    const { token, user } = await signUp(server, 'Secret');
    const row = server.store.one<{ password: string }>(`SELECT password FROM users WHERE id = ?`, user.id);
    expect(row?.password).toMatch(/^scrypt:16384:8:1:/);
    expect(row?.password).not.toContain('correct horse battery');
    const sessions = server.store.all<{ token_hash: string }>(`SELECT token_hash FROM sessions WHERE user_id = ?`, user.id);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.token_hash).not.toBe(token);
    expect(sessions[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('salts each password differently and compares them', async () => {
    const one = await hashPassword('same password');
    const two = await hashPassword('same password');
    expect(one).not.toBe(two);
    expect(await verifyPassword('same password', one)).toBe(true);
    expect(await verifyPassword('same password', two)).toBe(true);
    expect(await verifyPassword('Same password', one)).toBe(false);
    expect(await verifyPassword('same password', 'not a hash')).toBe(false);
  });

  it('signs out: the token no longer works', async () => {
    const { token } = await signUp(server, 'Leaving');
    expect((await call(server, 'POST', '/api/auth/logout', { token })).status).toBe(200);
    const me = await call(server, 'GET', '/api/me', { token });
    expect(me.status).toBe(401);
    expect(me.body.error).toMatch(/session has ended/);
    expect((await call(server, 'GET', '/api/me')).status).toBe(401);
    expect((await call(server, 'GET', '/api/me', { token: 'made-up' })).status).toBe(401);
    // An old token sent along does not stop someone signing in again.
    expect((await call(server, 'POST', '/api/guests', { token, body: { name: 'Fresh start' } })).status).toBe(200);
    expect((await call(server, 'GET', '/api/health', { token })).status).toBe(200);
  });

  it('changes the name, colour and password; a new password signs out the other sessions', async () => {
    await call(server, 'POST', '/api/auth/signup', { body: { email: 'change@example.com', name: 'Before', password: 'old password' } });
    const one = await call(server, 'POST', '/api/auth/login', { body: { email: 'change@example.com', password: 'old password' } });
    const two = await call(server, 'POST', '/api/auth/login', { body: { email: 'change@example.com', password: 'old password' } });

    const named = await call(server, 'PATCH', '/api/me', { token: one.body.token, body: { name: 'After', color: '#00B5CE' } });
    expect(named.status).toBe(200);
    expect(named.body).toMatchObject({ name: 'After', color: '#00b5ce' });
    expect((await call(server, 'PATCH', '/api/me', { token: one.body.token, body: { color: 'blue' } })).status).toBe(400);

    expect((await call(server, 'PATCH', '/api/me', { token: one.body.token, body: { password: 'new password' } })).status).toBe(200);
    expect((await call(server, 'GET', '/api/me', { token: one.body.token })).status).toBe(200);
    expect((await call(server, 'GET', '/api/me', { token: two.body.token })).status).toBe(401);
    expect((await call(server, 'POST', '/api/auth/login', { body: { email: 'change@example.com', password: 'old password' } })).status).toBe(401);
    expect((await call(server, 'POST', '/api/auth/login', { body: { email: 'change@example.com', password: 'new password' } })).status).toBe(200);
  });

  it('stops repeated wrong passwords for a while', async () => {
    await call(server, 'POST', '/api/auth/signup', { body: { email: 'guarded@example.com', name: 'Guarded', password: 'the right one' } });
    for (let i = 0; i < 3; i++) expect((await call(server, 'POST', '/api/auth/login', { body: { email: 'guarded@example.com', password: 'wrong' } })).status).toBe(401);
    const blocked = await call(server, 'POST', '/api/auth/login', { body: { email: 'guarded@example.com', password: 'the right one' } });
    expect(blocked.status).toBe(429);
  });

  it('counts attempts in a window that ends', () => {
    const limiter = new RateLimiter(2, 1000);
    limiter.hit('a', 0);
    expect(limiter.allowed('a', 10)).toBe(true);
    limiter.hit('a', 20);
    expect(limiter.allowed('a', 30)).toBe(false);
    expect(limiter.allowed('b', 30)).toBe(true);
    expect(limiter.allowed('a', 1001)).toBe(true);
  });

  it('makes guests with a name, a colour and a guest token', async () => {
    const answer = await call(server, 'POST', '/api/guests', { body: { name: 'Visitor' } });
    expect(answer.status).toBe(200);
    expect(answer.body.guestToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(answer.body.guest).toMatchObject({ name: 'Visitor' });
    expect(PEOPLE_COLORS).toContain(answer.body.guest.color);
    expect((await call(server, 'POST', '/api/guests', { body: {} })).status).toBe(400);
    // A guest has no account.
    expect((await call(server, 'GET', '/api/me', { guest: answer.body.guestToken })).status).toBe(401);
    expect((await call(server, 'GET', '/api/notifications', { guest: answer.body.guestToken })).status).toBe(200);
    expect((await call(server, 'GET', '/api/notifications', { guest: 'made-up' })).status).toBe(401);
  });

  it('answers unknown paths and methods, and bodies that are not JSON', async () => {
    expect((await call(server, 'GET', '/api/nothing-here')).status).toBe(404);
    expect((await call(server, 'DELETE', '/api/health')).status).toBe(405);
    const res = await fetch(`${server.url}/api/auth/login`, { method: 'POST', body: '{not json', headers: { 'Content-Type': 'application/json' } });
    expect(res.status).toBe(400);
  });

  it('answers a body that is too large with 413', async () => {
    const big = JSON.stringify({ email: 'big@example.com', name: 'x'.repeat(3 * 1024 * 1024), password: 'password one' });
    const res = await fetch(`${server.url}/api/auth/signup`, { method: 'POST', body: big, headers: { 'Content-Type': 'application/json' } });
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: string }).error).toMatch(/larger than 2 MB/);
  });
});
