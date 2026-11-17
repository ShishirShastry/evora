import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, clock, newDoc, personalWorkspace, signUp, testServer, type TestServer } from './testing.ts';

let server: TestServer;

beforeAll(async () => {
  server = await testServer();
});

afterAll(async () => {
  await server.stop();
});

describe('workspaces', () => {
  it('makes, renames, lists and deletes workspaces', async () => {
    const { token } = await signUp(server, 'Owner');
    const made = await call(server, 'POST', '/api/workspaces', { token, body: { name: 'Studio' } });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ name: 'Studio', role: 'owner', memberCount: 1 });
    const renamed = await call(server, 'PATCH', `/api/workspaces/${made.body.id}`, { token, body: { name: 'Studio Two' } });
    expect(renamed.body.name).toBe('Studio Two');
    const list = await call(server, 'GET', '/api/workspaces', { token });
    expect(list.body.map((w: { name: string }) => w.name)).toEqual(["Owner's workspace", 'Studio Two']);
    expect((await call(server, 'DELETE', `/api/workspaces/${made.body.id}`, { token })).status).toBe(200);
    expect((await call(server, 'GET', '/api/workspaces', { token })).body).toHaveLength(1);
  });

  it('adds members by email with roles, and only lets each role do what it may', async () => {
    const owner = await signUp(server, 'Olga');
    const editor = await signUp(server, 'Eddie');
    const viewer = await signUp(server, 'Vera');
    const outsider = await signUp(server, 'Otto');
    const workspaceId = await personalWorkspace(server, owner.token);

    const added = await call(server, 'POST', `/api/workspaces/${workspaceId}/members`, { token: owner.token, body: { email: editor.user.email, role: 'editor' } });
    expect(added.status).toBe(200);
    expect(added.body.members.map((m: { user: { id: string }; role: string }) => [m.user.id, m.role])).toEqual([
      [owner.user.id, 'owner'],
      [editor.user.id, 'editor'],
    ]);
    expect(added.body.members[1].user.email).toBe(editor.user.email);

    // An editor may add people, but not make owners.
    expect((await call(server, 'POST', `/api/workspaces/${workspaceId}/members`, { token: editor.token, body: { email: viewer.user.email, role: 'owner' } })).status).toBe(403);
    expect((await call(server, 'POST', `/api/workspaces/${workspaceId}/members`, { token: editor.token, body: { email: viewer.user.email, role: 'viewer' } })).status).toBe(200);
    // A viewer may not add anyone; an outsider is told there is no such workspace.
    expect((await call(server, 'POST', `/api/workspaces/${workspaceId}/members`, { token: viewer.token, body: { email: outsider.user.email, role: 'viewer' } })).status).toBe(403);
    expect((await call(server, 'GET', `/api/workspaces/${workspaceId}/members`, { token: outsider.token })).status).toBe(404);
    expect((await call(server, 'GET', `/api/workspaces/${workspaceId}/members`, { token: viewer.token })).body.members).toHaveLength(3);

    // Only an owner changes roles or renames.
    expect((await call(server, 'PATCH', `/api/workspaces/${workspaceId}/members/${viewer.user.id}`, { token: editor.token, body: { role: 'editor' } })).status).toBe(403);
    expect((await call(server, 'PATCH', `/api/workspaces/${workspaceId}`, { token: editor.token, body: { name: 'Mine now' } })).status).toBe(403);
    const promoted = await call(server, 'PATCH', `/api/workspaces/${workspaceId}/members/${viewer.user.id}`, { token: owner.token, body: { role: 'editor' } });
    expect(promoted.body.members.find((m: { user: { id: string } }) => m.user.id === viewer.user.id).role).toBe('editor');

    // Members see the workspace, with its member count.
    const theirs = await call(server, 'GET', '/api/workspaces', { token: editor.token });
    expect(theirs.body.find((w: { id: string }) => w.id === workspaceId)).toMatchObject({ role: 'editor', memberCount: 3 });

    // Being added is notified.
    const notes = await call(server, 'GET', '/api/notifications', { token: editor.token });
    expect(notes.body).toEqual([expect.objectContaining({ kind: 'invite', workspaceId, from: expect.objectContaining({ id: owner.user.id }), read: false })]);
  });

  it('keeps an owner in every workspace, and lets members leave', async () => {
    const owner = await signUp(server, 'Solo');
    const member = await signUp(server, 'Member');
    const workspaceId = await personalWorkspace(server, owner.token);
    await call(server, 'POST', `/api/workspaces/${workspaceId}/members`, { token: owner.token, body: { email: member.user.email, role: 'viewer' } });

    expect((await call(server, 'PATCH', `/api/workspaces/${workspaceId}/members/${owner.user.id}`, { token: owner.token, body: { role: 'editor' } })).status).toBe(409);
    expect((await call(server, 'DELETE', `/api/workspaces/${workspaceId}/members/${owner.user.id}`, { token: owner.token })).status).toBe(409);
    // A member cannot remove someone else, but can leave.
    expect((await call(server, 'DELETE', `/api/workspaces/${workspaceId}/members/${owner.user.id}`, { token: member.token })).status).toBe(403);
    expect((await call(server, 'DELETE', `/api/workspaces/${workspaceId}/members/${member.user.id}`, { token: member.token })).status).toBe(200);
    expect((await call(server, 'GET', `/api/workspaces/${workspaceId}/members`, { token: member.token })).status).toBe(404);
  });

  it('invites by email someone without an account, who becomes a member on signing up', async () => {
    const owner = await signUp(server, 'Inviter');
    const workspaceId = await personalWorkspace(server, owner.token);
    const invited = await call(server, 'POST', `/api/workspaces/${workspaceId}/members`, { token: owner.token, body: { email: 'Later@Example.com', role: 'editor' } });
    expect(invited.body.pending).toEqual([{ email: 'later@example.com', role: 'editor', createdAt: expect.any(String) }]);

    const later = await call(server, 'POST', '/api/auth/signup', { body: { email: 'later@example.com', name: 'Later', password: 'password later' } });
    const me = await call(server, 'GET', '/api/me', { token: later.body.token });
    expect(me.body.workspaces.map((w: { id: string; role: string }) => [w.id, w.role])).toContainEqual([workspaceId, 'editor']);
    const members = await call(server, 'GET', `/api/workspaces/${workspaceId}/members`, { token: owner.token });
    expect(members.body.pending).toEqual([]);
    const notes = await call(server, 'GET', '/api/notifications', { token: later.body.token });
    expect(notes.body).toEqual([expect.objectContaining({ kind: 'invite', workspaceId, text: "Inviter's workspace" })]);
  });

  it('changes and withdraws a pending invitation by its email', async () => {
    const owner = await signUp(server, 'Pending');
    const workspaceId = await personalWorkspace(server, owner.token);
    await call(server, 'POST', `/api/workspaces/${workspaceId}/members`, { token: owner.token, body: { email: 'maybe@example.com', role: 'viewer' } });
    const changed = await call(server, 'PATCH', `/api/workspaces/${workspaceId}/members/maybe@example.com`, { token: owner.token, body: { role: 'editor' } });
    expect(changed.body.pending).toEqual([expect.objectContaining({ email: 'maybe@example.com', role: 'editor' })]);
    expect((await call(server, 'DELETE', `/api/workspaces/${workspaceId}/members/maybe@example.com`, { token: owner.token })).status).toBe(200);
    expect((await call(server, 'GET', `/api/workspaces/${workspaceId}/members`, { token: owner.token })).body.pending).toEqual([]);
  });

  it('makes invite links that anyone signed in can accept', async () => {
    const owner = await signUp(server, 'Linker');
    const joiner = await signUp(server, 'Joiner');
    const workspaceId = await personalWorkspace(server, owner.token);
    const link = await call(server, 'POST', `/api/workspaces/${workspaceId}/invites`, { token: owner.token, body: { role: 'viewer' } });
    expect(link.body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const seen = await call(server, 'GET', `/api/invites/${link.body.token}`);
    expect(seen.body).toEqual({ workspace: { id: workspaceId, name: "Linker's workspace" }, role: 'viewer', from: expect.objectContaining({ id: owner.user.id, name: 'Linker' }) });
    expect((await call(server, 'GET', '/api/invites/not-a-token')).status).toBe(404);
    expect((await call(server, 'POST', `/api/invites/${link.body.token}/accept`)).status).toBe(401);

    const accepted = await call(server, 'POST', `/api/invites/${link.body.token}/accept`, { token: joiner.token });
    expect(accepted.body).toMatchObject({ id: workspaceId, role: 'viewer', memberCount: 2 });
    // Accepting again changes nothing, and never lowers a role.
    expect((await call(server, 'POST', `/api/invites/${link.body.token}/accept`, { token: joiner.token })).body.memberCount).toBe(2);
    // Links that make owners are for owners to make.
    await call(server, 'PATCH', `/api/workspaces/${workspaceId}/members/${joiner.user.id}`, { token: owner.token, body: { role: 'editor' } });
    expect((await call(server, 'POST', `/api/workspaces/${workspaceId}/invites`, { token: joiner.token, body: { role: 'owner' } })).status).toBe(403);
  });

  it('has no limit on members', async () => {
    const owner = await signUp(server, 'Crowd');
    const workspaceId = await personalWorkspace(server, owner.token);
    for (let i = 0; i < 60; i++) await call(server, 'POST', `/api/workspaces/${workspaceId}/members`, { token: owner.token, body: { email: `seat${i}@example.com`, role: 'editor' } });
    const members = await call(server, 'GET', `/api/workspaces/${workspaceId}/members`, { token: owner.token });
    expect(members.body.pending).toHaveLength(60);
  });
});

describe('documents', () => {
  it('makes a document with starting content, which members of the workspace can open', async () => {
    const owner = await signUp(server, 'Maker');
    const viewer = await signUp(server, 'Looker');
    const workspaceId = await personalWorkspace(server, owner.token);
    await call(server, 'POST', `/api/workspaces/${workspaceId}/members`, { token: owner.token, body: { email: viewer.user.email, role: 'viewer' } });

    const t = Date.now();
    const made = await call(server, 'POST', '/api/documents', {
      token: owner.token,
      body: { workspaceId, name: 'Landing page', registers: [{ k: 'n:a:@', v: true, c: clock(t, 'maker00001') }, { k: 'n:a:name', v: 'Frame', c: clock(t, 'maker00001', 1) }] },
    });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ name: 'Landing page', workspaceId, role: 'owner', linkAccess: 'none', owner: { id: owner.user.id, name: 'Maker' } });

    const content = await call(server, 'GET', `/api/documents/${made.body.id}/registers`, { token: viewer.token });
    expect(content.body.registers.map((r: { k: string; v: unknown }) => [r.k, r.v])).toEqual([
      ['n:a:@', true],
      ['n:a:name', 'Frame'],
      ['d:name', 'Landing page'],
    ]);
    expect(content.body.seq).toBe(3);

    const listed = await call(server, 'GET', `/api/workspaces/${workspaceId}/documents`, { token: viewer.token });
    expect(listed.body).toEqual([expect.objectContaining({ id: made.body.id, role: 'viewer' })]);
    // A viewer of the workspace cannot make documents in it.
    expect((await call(server, 'POST', '/api/documents', { token: viewer.token, body: { workspaceId, name: 'Nope' } })).status).toBe(403);
    // Changes that are not valid are refused.
    expect((await call(server, 'POST', '/api/documents', { token: owner.token, body: { workspaceId, name: 'Bad', registers: [{ k: 'n:a:x', v: 1, c: 'yesterday' }] } })).status).toBe(400);
  });

  it('renames a document (editors) and deletes it (owners only)', async () => {
    const owner = await signUp(server, 'Renamer');
    const editor = await signUp(server, 'Helper');
    const doc = await newDoc(server, owner.token, 'Old name');
    await call(server, 'POST', `/api/documents/${doc.id}/members`, { token: owner.token, body: { email: editor.user.email, role: 'editor' } });

    const renamed = await call(server, 'PATCH', `/api/documents/${doc.id}`, { token: editor.token, body: { name: 'New name' } });
    expect(renamed.body).toMatchObject({ name: 'New name', role: 'editor' });
    // The name is the document's d:name register too.
    const content = await call(server, 'GET', `/api/documents/${doc.id}/registers`, { token: owner.token });
    expect(content.body.registers.find((r: { k: string }) => r.k === 'd:name').v).toBe('New name');

    expect((await call(server, 'DELETE', `/api/documents/${doc.id}`, { token: editor.token })).status).toBe(403);
    expect((await call(server, 'DELETE', `/api/documents/${doc.id}`, { token: owner.token })).status).toBe(200);
    expect((await call(server, 'GET', `/api/documents/${doc.id}`, { token: owner.token })).status).toBe(404);
  });

  it('shares a document with people directly, also before they have an account', async () => {
    const owner = await signUp(server, 'Sharer');
    const friend = await signUp(server, 'Friend');
    const doc = await newDoc(server, owner.token, 'Poster');

    expect((await call(server, 'GET', `/api/documents/${doc.id}`, { token: friend.token })).status).toBe(403);
    const shared = await call(server, 'POST', `/api/documents/${doc.id}/members`, { token: owner.token, body: { email: friend.user.email, role: 'viewer' } });
    expect(shared.body.members.map((m: { user: { id: string }; role: string }) => [m.user.id, m.role])).toEqual([
      [owner.user.id, 'owner'],
      [friend.user.id, 'viewer'],
    ]);
    expect((await call(server, 'GET', `/api/documents/${doc.id}`, { token: friend.token })).body.role).toBe('viewer');
    expect((await call(server, 'GET', '/api/shared', { token: friend.token })).body).toEqual([expect.objectContaining({ id: doc.id, name: 'Poster', role: 'viewer' })]);
    expect((await call(server, 'GET', '/api/shared', { token: owner.token })).body).toEqual([]);
    expect((await call(server, 'GET', '/api/notifications', { token: friend.token })).body).toEqual([expect.objectContaining({ kind: 'shared', docId: doc.id, text: 'Poster' })]);

    // A viewer cannot share it on, or change roles; the owner can.
    expect((await call(server, 'POST', `/api/documents/${doc.id}/members`, { token: friend.token, body: { email: 'x@example.com', role: 'viewer' } })).status).toBe(403);
    expect((await call(server, 'PATCH', `/api/documents/${doc.id}/members/${friend.user.id}`, { token: friend.token, body: { role: 'editor' } })).status).toBe(403);
    const raised = await call(server, 'PATCH', `/api/documents/${doc.id}/members/${friend.user.id}`, { token: owner.token, body: { role: 'editor' } });
    expect(raised.body.members[1].role).toBe('editor');

    // Someone without an account is invited by email, and has the document when they sign up.
    await call(server, 'POST', `/api/documents/${doc.id}/members`, { token: owner.token, body: { email: 'newcomer@example.com', role: 'editor' } });
    const newcomer = await call(server, 'POST', '/api/auth/signup', { body: { email: 'newcomer@example.com', name: 'Newcomer', password: 'password new' } });
    expect((await call(server, 'GET', `/api/documents/${doc.id}`, { token: newcomer.body.token })).body.role).toBe('editor');
    expect((await call(server, 'GET', '/api/shared', { token: newcomer.body.token })).body.map((d: { id: string }) => d.id)).toEqual([doc.id]);

    // Someone removed from it can no longer open it; anyone can leave.
    expect((await call(server, 'DELETE', `/api/documents/${doc.id}/members/${friend.user.id}`, { token: owner.token })).status).toBe(200);
    expect((await call(server, 'GET', `/api/documents/${doc.id}`, { token: friend.token })).status).toBe(403);
    expect((await call(server, 'DELETE', `/api/documents/${doc.id}/members/${newcomer.body.user.id}`, { token: newcomer.body.token })).status).toBe(200);
  });

  it('opens a document by its link to view for anyone, guests included, who cannot change it', async () => {
    const owner = await signUp(server, 'Publisher');
    const doc = await newDoc(server, owner.token, 'Public');
    const guest = (await call(server, 'POST', '/api/guests', { body: { name: 'Passer-by' } })).body;

    expect((await call(server, 'GET', `/api/documents/${doc.id}`, { guest: guest.guestToken })).status).toBe(403);
    expect((await call(server, 'GET', `/api/documents/${doc.id}`)).status).toBe(401);

    const opened = await call(server, 'PATCH', `/api/documents/${doc.id}`, { token: owner.token, body: { linkAccess: 'view' } });
    expect(opened.body.linkAccess).toBe('view');
    expect((await call(server, 'GET', `/api/documents/${doc.id}`, { guest: guest.guestToken })).body.role).toBe('viewer');
    expect((await call(server, 'GET', `/api/documents/${doc.id}`)).body.role).toBe('viewer');
    expect((await call(server, 'GET', `/api/documents/${doc.id}/registers`, { guest: guest.guestToken })).status).toBe(200);
    expect((await call(server, 'PATCH', `/api/documents/${doc.id}`, { guest: guest.guestToken, body: { name: 'Mine' } })).status).toBe(403);

    // With edit access a guest may change it, but not who has access.
    await call(server, 'PATCH', `/api/documents/${doc.id}`, { token: owner.token, body: { linkAccess: 'edit' } });
    expect((await call(server, 'PATCH', `/api/documents/${doc.id}`, { guest: guest.guestToken, body: { name: 'Edited by a guest' } })).body.name).toBe('Edited by a guest');
    expect((await call(server, 'PATCH', `/api/documents/${doc.id}`, { guest: guest.guestToken, body: { linkAccess: 'none' } })).status).toBe(403);
    expect((await call(server, 'GET', `/api/documents/${doc.id}/members`, { guest: guest.guestToken })).status).toBe(403);
    expect((await call(server, 'PATCH', `/api/documents/${doc.id}`, { token: owner.token, body: { linkAccess: 'everyone' } })).status).toBe(400);
  });

  it('gives the strongest of the document role, the workspace role and the link', async () => {
    const owner = await signUp(server, 'Strong');
    const person = await signUp(server, 'Mixed');
    const workspaceId = await personalWorkspace(server, owner.token);
    const doc = await newDoc(server, owner.token, 'Mixed roles');
    await call(server, 'POST', `/api/workspaces/${workspaceId}/members`, { token: owner.token, body: { email: person.user.email, role: 'viewer' } });
    expect((await call(server, 'GET', `/api/documents/${doc.id}`, { token: person.token })).body.role).toBe('viewer');
    await call(server, 'PATCH', `/api/documents/${doc.id}`, { token: owner.token, body: { linkAccess: 'edit' } });
    expect((await call(server, 'GET', `/api/documents/${doc.id}`, { token: person.token })).body.role).toBe('editor');
    await call(server, 'POST', `/api/documents/${doc.id}/members`, { token: owner.token, body: { email: person.user.email, role: 'owner' } });
    expect((await call(server, 'GET', `/api/documents/${doc.id}`, { token: person.token })).body.role).toBe('owner');
  });

  it('keeps images: editors put the bytes, anyone who can open the document reads them', async () => {
    const owner = await signUp(server, 'Imager');
    const viewer = await signUp(server, 'Seer');
    const doc = await newDoc(server, owner.token, 'Pictures');
    await call(server, 'POST', `/api/documents/${doc.id}/members`, { token: owner.token, body: { email: viewer.user.email, role: 'viewer' } });
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
    const hash = createHash('sha256').update(bytes).digest('hex');

    const put = await call(server, 'PUT', `/api/documents/${doc.id}/assets/${hash}`, { token: owner.token, body: bytes, headers: { 'Content-Type': 'image/png' } });
    expect(put.status).toBe(200);
    const res = await fetch(`${server.url}/api/documents/${doc.id}/assets/${hash}`, { headers: { Authorization: `Bearer ${viewer.token}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);

    expect((await call(server, 'PUT', `/api/documents/${doc.id}/assets/${hash}`, { token: viewer.token, body: bytes })).status).toBe(403);
    expect((await call(server, 'PUT', `/api/documents/${doc.id}/assets/${'0'.repeat(64)}`, { token: owner.token, body: bytes })).status).toBe(400);
    expect((await call(server, 'PUT', `/api/documents/${doc.id}/assets/not-a-hash`, { token: owner.token, body: bytes })).status).toBe(400);
    expect((await call(server, 'GET', `/api/documents/${doc.id}/assets/${'1'.repeat(64)}`, { token: owner.token })).status).toBe(404);
    const stranger = await signUp(server, 'Stranger');
    expect((await call(server, 'GET', `/api/documents/${doc.id}/assets/${hash}`, { token: stranger.token })).status).toBe(403);
  });

  it('removes a workspace with its documents', async () => {
    const owner = await signUp(server, 'Remover');
    const made = await call(server, 'POST', '/api/workspaces', { token: owner.token, body: { name: 'Temporary' } });
    const doc = await call(server, 'POST', '/api/documents', { token: owner.token, body: { workspaceId: made.body.id, name: 'Goes too' } });
    await call(server, 'DELETE', `/api/workspaces/${made.body.id}`, { token: owner.token });
    expect((await call(server, 'GET', `/api/documents/${doc.body.id}`, { token: owner.token })).status).toBe(404);
    expect(server.store.one(`SELECT 1 AS x FROM registers WHERE doc_id = ?`, doc.body.id)).toBeUndefined();
  });
});
