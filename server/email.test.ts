import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { DEFAULT_LIMITS } from './api.ts';
import { Mailer, parseSender } from './mail.ts';
import { Store } from './store.ts';
import { composeMessage, escapeHtml } from './email.ts';
import { call, newDoc, signUp, tempDir, testServer, type TestServer } from './testing.ts';
import { fakeSmtp, header, plainText, type FakeSmtp, type ReceivedMail } from './smtp-testing.ts';

const PUBLIC_URL = 'https://evora.example.com';

/** A server with email on, sending through a stand-in relay on this computer. */
async function mailServer(limits: Partial<typeof DEFAULT_LIMITS> = {}): Promise<{ server: TestServer; relay: FakeSmtp; mailer: Mailer }> {
  const relay = await fakeSmtp({ user: 'relay-user', pass: 'relay-pass' });
  const mailer = new Mailer({
    smtp: { security: 'plain', host: '127.0.0.1', port: relay.port, user: 'relay-user', pass: 'relay-pass' },
    from: parseSender('Evora <noreply@example.com>'),
    retryDelaysMs: [],
    log: () => undefined,
  });
  const server = await testServer({ mailer, publicUrl: PUBLIC_URL, limits });
  return { server, relay, mailer };
}

/** The messages sent to an address so far, once the queue has emptied. */
async function mailTo(mailer: Mailer, relay: FakeSmtp, address: string): Promise<ReceivedMail[]> {
  await mailer.idle();
  return relay.messages.filter((message) => message.to.includes(address));
}

/** The decoded subject of a message. */
function subject(message: ReceivedMail): string {
  return (header(message.data, 'Subject') ?? '').replace(/=\?UTF-8\?B\?([^?]*)\?=\s?/g, (_, b64: string) => Buffer.from(b64, 'base64').toString('utf8'));
}

/** The token in the newest link that confirms an address, sent to `address`. */
async function verifyToken(mailer: Mailer, relay: FakeSmtp, address: string): Promise<string> {
  const messages = await mailTo(mailer, relay, address);
  const links = messages.map((message) => /#\/verify-email\/([A-Za-z0-9_-]+)/.exec(plainText(message.data))?.[1]).filter(Boolean) as string[];
  if (!links.length) throw new Error(`No link was sent to ${address}`);
  return links.at(-1) as string;
}

let counter = 0;
function address(name: string): string {
  counter++;
  return `${name}.${counter}.${Date.now()}@example.com`;
}

describe('with email off (as before)', () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await testServer();
  });
  afterAll(async () => {
    await server.stop();
  });

  it('says email is off, and the address is not confirmed', async () => {
    const alex = await signUp(server, 'Alex');
    const status = await call(server, 'GET', '/api/me/email', { token: alex.token });
    expect(status.body).toEqual({ mail: false, email: alex.user.email, verified: false, mentionEmails: true });
    expect((await call(server, 'POST', '/api/me/email/resend', { token: alex.token })).status).toBe(409);
  });

  it('gives an invitation to whoever has the address, confirmed or not', async () => {
    const owner = await signUp(server, 'Owner');
    const squatter = await signUp(server, 'Squatter');
    const doc = await newDoc(server, owner.token, 'Plans');
    await call(server, 'POST', `/api/documents/${doc.id}/members`, { token: owner.token, body: { email: squatter.user.email, role: 'editor' } });
    expect((await call(server, 'GET', `/api/documents/${doc.id}`, { token: squatter.token })).status).toBe(200);
    // And an invitation for an address with no account is taken up when one is made with it.
    const later = address('later');
    await call(server, 'POST', `/api/documents/${doc.id}/members`, { token: owner.token, body: { email: later, role: 'viewer' } });
    const made = await signUp(server, 'Later', later);
    expect((await call(server, 'GET', `/api/documents/${doc.id}`, { token: made.token })).status).toBe(200);
  });
});

describe('confirming an address', () => {
  let server: TestServer;
  let relay: FakeSmtp;
  let mailer: Mailer;
  beforeAll(async () => {
    ({ server, relay, mailer } = await mailServer({ emailResends: 2, emailTokenFailures: 6 }));
  });
  afterAll(async () => {
    await server.stop();
    await relay.close();
  });

  it('sends a new account a link, which confirms the address once', async () => {
    const alex = await signUp(server, 'Alex', address('alex'));
    expect((await call(server, 'GET', '/api/me/email', { token: alex.token })).body).toMatchObject({ mail: true, verified: false });
    const [message] = await mailTo(mailer, relay, alex.user.email);
    expect(message).toBeDefined();
    expect(message!.from).toBe('noreply@example.com');
    expect(subject(message!)).toBe('Confirm your email address for Evora');
    expect(header(message!.data, 'Message-ID')).toMatch(/^<.+@example\.com>$/);
    const text = plainText(message!.data);
    expect(text).toContain(`${PUBLIC_URL}/#/verify-email/`);
    const token = await verifyToken(mailer, relay, alex.user.email);
    // Only the token's hash is kept.
    const kept = server.store.all<{ token_hash: string }>(`SELECT token_hash FROM email_tokens WHERE user_id = ?`, alex.user.id);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.token_hash).not.toBe(token);
    expect(JSON.stringify(kept)).not.toContain(token);

    const confirmed = await call(server, 'POST', '/api/auth/verify-email', { body: { token } });
    expect(confirmed).toMatchObject({ status: 200, body: { email: alex.user.email, verified: true } });
    expect((await call(server, 'GET', '/api/me/email', { token: alex.token })).body).toMatchObject({ verified: true });
    // A second time: used.
    const again = await call(server, 'POST', '/api/auth/verify-email', { body: { token } });
    expect(again.status).toBe(400);
    expect(again.body.error).toMatch(/not valid|already used/);
    // Confirmed: nothing more to send.
    expect((await call(server, 'POST', '/api/me/email/resend', { token: alex.token })).status).toBe(409);
  });

  it('refuses a wrong token and an expired one', async () => {
    const sam = await signUp(server, 'Sam', address('sam'));
    const token = await verifyToken(mailer, relay, sam.user.email);
    expect((await call(server, 'POST', '/api/auth/verify-email', { body: { token: `${token.slice(0, -2)}xx` } })).status).toBe(400);
    expect((await call(server, 'POST', '/api/auth/verify-email', { body: {} })).status).toBe(400);
    server.store.run(`UPDATE email_tokens SET expires_at = ? WHERE user_id = ?`, Date.now() - 1, sam.user.id);
    const expired = await call(server, 'POST', '/api/auth/verify-email', { body: { token } });
    expect(expired.status).toBe(400);
    expect(expired.body.error).toMatch(/expired/);
    expect((await call(server, 'GET', '/api/me/email', { token: sam.token })).body.verified).toBe(false);
  });

  it('sends another link when asked, which replaces the last, a limited number of times', async () => {
    const kim = await signUp(server, 'Kim', address('kim'));
    const first = await verifyToken(mailer, relay, kim.user.email);
    expect((await call(server, 'POST', '/api/me/email/resend', { token: kim.token })).body).toEqual({ sent: true });
    const second = await verifyToken(mailer, relay, kim.user.email);
    expect(second).not.toBe(first);
    expect((await call(server, 'POST', '/api/me/email/resend', { token: kim.token })).status).toBe(200);
    const limited = await call(server, 'POST', '/api/me/email/resend', { token: kim.token });
    expect(limited.status).toBe(429);
    const third = await verifyToken(mailer, relay, kim.user.email);
    // The older links no longer work; the newest does.
    expect((await call(server, 'POST', '/api/auth/verify-email', { body: { token: first } })).status).toBe(400);
    expect((await call(server, 'POST', '/api/auth/verify-email', { body: { token: third } })).status).toBe(200);
    expect((await call(server, 'POST', '/api/me/email/resend')).status).toBe(401);
  });

  it('limits wrong tokens from one address', async () => {
    let status = 0;
    for (let i = 0; i < 10 && status !== 429; i++) {
      status = (await call(server, 'POST', '/api/auth/verify-email', { body: { token: `wrong-token-${'x'.repeat(30)}-${i}` } })).status;
    }
    expect(status).toBe(429);
  });
});

describe('changing the address and the mention setting', () => {
  let server: TestServer;
  let relay: FakeSmtp;
  let mailer: Mailer;
  beforeAll(async () => {
    ({ server, relay, mailer } = await mailServer());
  });
  afterAll(async () => {
    await server.stop();
    await relay.close();
  });

  it('needs the password for a new address, which must be confirmed again', async () => {
    const alex = await signUp(server, 'Alex', address('alex'));
    await call(server, 'POST', '/api/auth/verify-email', { body: { token: await verifyToken(mailer, relay, alex.user.email) } });
    const next = address('alex-new');
    expect((await call(server, 'PATCH', '/api/me/email', { token: alex.token, body: { email: next } })).status).toBe(403);
    expect((await call(server, 'PATCH', '/api/me/email', { token: alex.token, body: { email: next, password: 'wrong password' } })).status).toBe(403);
    const taken = await signUp(server, 'Taken', address('taken'));
    expect((await call(server, 'PATCH', '/api/me/email', { token: alex.token, body: { email: taken.user.email, password: 'correct horse battery' } })).status).toBe(409);
    const changed = await call(server, 'PATCH', '/api/me/email', { token: alex.token, body: { email: next.toUpperCase(), password: 'correct horse battery' } });
    expect(changed.body).toEqual({ mail: true, email: next, verified: false, mentionEmails: true });
    const token = await verifyToken(mailer, relay, next);
    expect((await call(server, 'POST', '/api/auth/verify-email', { body: { token } })).status).toBe(200);
    expect((await call(server, 'GET', '/api/me', { token: alex.token })).body.user.email).toBe(next);
  });

  it('turns mention emails off and on', async () => {
    const kim = await signUp(server, 'Kim', address('kim'));
    expect((await call(server, 'PATCH', '/api/me/email', { token: kim.token, body: { mentionEmails: false } })).body.mentionEmails).toBe(false);
    expect((await call(server, 'GET', '/api/me/email', { token: kim.token })).body.mentionEmails).toBe(false);
    expect((await call(server, 'PATCH', '/api/me/email', { token: kim.token, body: { mentionEmails: 'no' } })).status).toBe(400);
    expect((await call(server, 'PATCH', '/api/me/email', { token: kim.token, body: { mentionEmails: true } })).body.mentionEmails).toBe(true);
  });
});

describe('invitations with email on', () => {
  let server: TestServer;
  let relay: FakeSmtp;
  let mailer: Mailer;
  beforeAll(async () => {
    ({ server, relay, mailer } = await mailServer());
  });
  afterAll(async () => {
    await server.stop();
    await relay.close();
  });

  async function confirmed(name: string) {
    const person = await signUp(server, name, address(name.toLowerCase()));
    await call(server, 'POST', '/api/auth/verify-email', { body: { token: await verifyToken(mailer, relay, person.user.email) } });
    return person;
  }

  it('are taken up only by an account whose address is confirmed', async () => {
    const owner = await confirmed('Owner');
    const doc = await newDoc(server, owner.token, 'Launch <plan>');
    // Someone makes an account with another person's address before they do, and cannot confirm it.
    const victim = address('victim');
    const squatter = await signUp(server, 'Squatter', victim);
    const shared = await call(server, 'POST', `/api/documents/${doc.id}/members`, { token: owner.token, body: { email: victim, role: 'editor' } });
    expect(shared.body.pending).toEqual([expect.objectContaining({ email: victim, role: 'editor' })]);
    expect(shared.body.members.map((m: { user: { id: string } }) => m.user.id)).not.toContain(squatter.user.id);
    expect((await call(server, 'GET', `/api/documents/${doc.id}`, { token: squatter.token })).status).toBe(403);

    // The invitation went to the address itself, which only its owner reads.
    const invitation = (await mailTo(mailer, relay, victim)).find((message) => subject(message).includes('invited you'));
    expect(invitation).toBeDefined();
    expect(subject(invitation!)).toBe('Owner invited you to the file “Launch <plan>” on Evora');
    const text = plainText(invitation!.data);
    expect(text).toContain(`${PUBLIC_URL}/#/doc/${doc.id}`);
    expect(text).toContain('as an editor');
    expect(text).toMatch(/confirm the address/);
    expect(invitation!.data).toContain('Launch &lt;plan&gt;');

    // Confirming the address (here: whoever reads that mailbox) takes the invitation up.
    await call(server, 'POST', '/api/auth/verify-email', { body: { token: await verifyToken(mailer, relay, victim) } });
    expect((await call(server, 'GET', `/api/documents/${doc.id}`, { token: squatter.token })).status).toBe(200);
    const notes = await call(server, 'GET', '/api/notifications', { token: squatter.token });
    expect(notes.body).toEqual([expect.objectContaining({ kind: 'shared', docId: doc.id })]);
  });

  it('wait for a new account until its address is confirmed', async () => {
    const owner = await confirmed('Lead');
    const workspace = (await call(server, 'GET', '/api/workspaces', { token: owner.token })).body[0];
    const newcomer = address('newcomer');
    await call(server, 'POST', `/api/workspaces/${workspace.id}/members`, { token: owner.token, body: { email: newcomer, role: 'viewer' } });
    const [invitation] = await mailTo(mailer, relay, newcomer);
    expect(subject(invitation!)).toBe(`Lead invited you to the workspace “${workspace.name}” on Evora`);
    expect(plainText(invitation!.data)).toContain(`${PUBLIC_URL}/#/workspace/${workspace.id}`);
    expect(plainText(invitation!.data)).toContain('as a viewer');

    const made = await signUp(server, 'Newcomer', newcomer);
    expect((await call(server, 'GET', '/api/workspaces', { token: made.token })).body.map((w: { id: string }) => w.id)).not.toContain(workspace.id);
    await call(server, 'POST', '/api/auth/verify-email', { body: { token: await verifyToken(mailer, relay, newcomer) } });
    expect((await call(server, 'GET', '/api/workspaces', { token: made.token })).body.map((w: { id: string }) => w.id)).toContain(workspace.id);
  });

  it('go to a confirmed account at once, and say so by email', async () => {
    const owner = await confirmed('Host');
    const friend = await confirmed('Friend');
    const doc = await newDoc(server, owner.token, 'Sketches');
    await call(server, 'POST', `/api/documents/${doc.id}/members`, { token: owner.token, body: { email: friend.user.email, role: 'viewer' } });
    expect((await call(server, 'GET', `/api/documents/${doc.id}`, { token: friend.token })).status).toBe(200);
    const invitation = (await mailTo(mailer, relay, friend.user.email)).find((message) => subject(message).includes('invited you'));
    expect(plainText(invitation!.data)).toContain('You can open it now');
    // Inviting again with the same role sends nothing more.
    const before = (await mailTo(mailer, relay, friend.user.email)).length;
    await call(server, 'POST', `/api/documents/${doc.id}/members`, { token: owner.token, body: { email: friend.user.email, role: 'viewer' } });
    expect((await mailTo(mailer, relay, friend.user.email)).length).toBe(before);
  });

  it('send only so many emails for one account, while the invitations are still made', async () => {
    const owner = await confirmed('Bulk');
    const doc = await newDoc(server, owner.token, 'Bulk');
    const addresses = Array.from({ length: 52 }, (_, i) => `bulk-${i}.${Date.now()}@example.com`);
    for (const to of addresses) await call(server, 'POST', `/api/documents/${doc.id}/members`, { token: owner.token, body: { email: to, role: 'viewer' } });
    await mailer.idle();
    const sent = relay.messages.filter((message) => addresses.some((to) => message.to.includes(to)));
    expect(sent).toHaveLength(50);
    expect((await call(server, 'GET', `/api/documents/${doc.id}/members`, { token: owner.token })).body.pending).toHaveLength(52);
  });
});

describe('mention emails', () => {
  let server: TestServer;
  let relay: FakeSmtp;
  let mailer: Mailer;
  beforeAll(async () => {
    ({ server, relay, mailer } = await mailServer());
  });
  afterAll(async () => {
    await server.stop();
    await relay.close();
  });

  it('go to a mentioned person with a confirmed address, unless they turned them off', async () => {
    const owner = await signUp(server, 'Ana', address('ana'));
    const bo = await signUp(server, 'Bo', address('bo'));
    const cy = await signUp(server, 'Cy', address('cy'));
    for (const person of [owner, bo]) await call(server, 'POST', '/api/auth/verify-email', { body: { token: await verifyToken(mailer, relay, person.user.email) } });
    const doc = await newDoc(server, owner.token, 'Poster');
    // Cy's address is not confirmed: Cy is added by the store directly, as an invitation would wait.
    server.store.addDocMember(doc.id, cy.user.id, 'editor');
    await call(server, 'POST', `/api/documents/${doc.id}/members`, { token: owner.token, body: { email: bo.user.email, role: 'editor' } });

    const thread = await call(server, 'POST', `/api/documents/${doc.id}/threads`, {
      token: owner.token,
      body: { pageId: 'page1', x: 1, y: 1, body: `@[Bo](${bo.user.id}) and @[Cy](${cy.user.id}), what do you think?` },
    });
    expect(thread.status).toBe(201);
    const mention = (await mailTo(mailer, relay, bo.user.email)).find((message) => subject(message).includes('mentioned you'));
    expect(mention).toBeDefined();
    expect(subject(mention!)).toBe('Ana mentioned you in “Poster”');
    expect(plainText(mention!.data)).toContain(`${PUBLIC_URL}/#/doc/${doc.id}/comment/${thread.body.id}`);
    expect(plainText(mention!.data)).toContain('Email settings');
    expect((await mailTo(mailer, relay, cy.user.email)).some((message) => subject(message).includes('mentioned you'))).toBe(false);

    await call(server, 'PATCH', '/api/me/email', { token: bo.token, body: { mentionEmails: false } });
    const before = (await mailTo(mailer, relay, bo.user.email)).length;
    await call(server, 'POST', `/api/threads/${thread.body.id}/comments`, { token: owner.token, body: { body: `@[Bo](${bo.user.id}) again` } });
    expect((await mailTo(mailer, relay, bo.user.email)).length).toBe(before);
    // The notification in the app still comes.
    const notes = await call(server, 'GET', '/api/notifications', { token: bo.token });
    expect(notes.body.filter((n: { kind: string }) => n.kind === 'mention')).toHaveLength(2);
  });
});

describe('the database before email (schema 2)', () => {
  it('is brought up to date: Google accounts confirmed, others not, mention emails on', () => {
    const dir = tempDir();
    const old = new DatabaseSync(join(dir, 'evora.db'));
    old.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, color TEXT NOT NULL, password TEXT NOT NULL, created_at TEXT NOT NULL, google_sub TEXT);
      CREATE UNIQUE INDEX users_google_sub ON users(google_sub);
      INSERT INTO users VALUES ('u1', 'pat@example.com', 'Pat', '#0d99ff', 'scrypt:1:1:1:a:b', '2026-11-01T00:00:00.000Z', NULL);
      INSERT INTO users VALUES ('u2', 'gil@example.com', 'Gil', '#0d99ff', '', '2026-11-02T00:00:00.000Z', 'google-sub-1');
      PRAGMA user_version = 2;`);
    old.close();
    const store = new Store(dir);
    try {
      expect(store.one<{ user_version: number }>(`PRAGMA user_version`)?.user_version).toBe(3);
      expect(store.userById('u1')).toMatchObject({ email: 'pat@example.com', email_verified: 0, mention_emails: 1 });
      expect(store.userById('u2')).toMatchObject({ google_sub: 'google-sub-1', email_verified: 1, mention_emails: 1 });
      expect(store.all(`SELECT * FROM email_tokens`)).toEqual([]);
      // A session reads the new columns too.
      store.createSession('u1', 't', 'hash-of-t');
      expect(store.sessionUser('hash-of-t')).toMatchObject({ id: 'u1', email_verified: 0, mention_emails: 1 });
    } finally {
      store.close();
    }
    // Opening it again changes nothing.
    const again = new Store(dir);
    expect(again.userById('u2')?.email_verified).toBe(1);
    again.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('the messages', () => {
  it('are short, plain, and escape what people typed in the HTML', () => {
    const message = composeMessage('a@example.com', 'Subject', ['<b>Bold</b> & "quoted"'], { label: 'Open', url: 'https://evora.example.com/#/doc/x' }, 'Footer');
    expect(message.text).toBe('<b>Bold</b> & "quoted"\n\nOpen: https://evora.example.com/#/doc/x\n\nFooter');
    expect(message.html).toContain('&lt;b&gt;Bold&lt;/b&gt; &amp; &quot;quoted&quot;');
    expect(message.html).not.toContain('<b>');
    expect(escapeHtml(`'`)).toBe('&#39;');
    expect(composeMessage('a@example.com', 'x'.repeat(300), [], { label: 'l', url: 'u' }, 'f').subject.length).toBe(150);
  });
});
