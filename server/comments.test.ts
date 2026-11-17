import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Notification, Thread } from '../src/collab/protocol.ts';
import { call, newDoc, signUp, testServer, TestSocket, type TestServer } from './testing.ts';

let server: TestServer;

beforeAll(async () => {
  server = await testServer();
});

afterAll(async () => {
  await server.stop();
});

async function team(name: string) {
  const owner = await signUp(server, `${name}Owner`);
  const editor = await signUp(server, `${name}Editor`);
  const viewer = await signUp(server, `${name}Viewer`);
  const doc = await newDoc(server, owner.token, `${name} file`);
  await call(server, 'POST', `/api/documents/${doc.id}/members`, { token: owner.token, body: { email: editor.user.email, role: 'editor' } });
  await call(server, 'POST', `/api/documents/${doc.id}/members`, { token: owner.token, body: { email: viewer.user.email, role: 'viewer' } });
  return { owner, editor, viewer, doc };
}

async function notes(token: string, kind?: Notification['kind']): Promise<Notification[]> {
  const all = (await call<Notification[]>(server, 'GET', '/api/notifications', { token })).body;
  return kind ? all.filter((n) => n.kind === kind) : all;
}

describe('comments', () => {
  it('starts a thread pinned to a place or a layer, which everyone connected receives', async () => {
    const { owner, viewer, doc } = await team('Pin');
    const watcher = await TestSocket.join(server, doc.id, { token: owner.token }, 'watcher');

    const made = await call<Thread>(server, 'POST', `/api/documents/${doc.id}/threads`, {
      token: viewer.token,
      body: { pageId: 'page1', x: 40, y: 12, nodeId: 'card', body: 'Is this the final colour?' },
    });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ docId: doc.id, pageId: 'page1', x: 40, y: 12, nodeId: 'card', resolved: false });
    expect(made.body.comments).toEqual([
      expect.objectContaining({ body: 'Is this the final colour?', mentions: [], author: { id: viewer.user.id, name: viewer.user.name, color: viewer.user.color }, editedAt: null }),
    ]);
    const event = await watcher.socket.next('comment');
    expect(event.event).toEqual({ kind: 'thread', thread: made.body });

    const listed = await call<Thread[]>(server, 'GET', `/api/documents/${doc.id}/threads`, { token: owner.token });
    expect(listed.body).toEqual([made.body]);
    expect((await call(server, 'POST', `/api/documents/${doc.id}/threads`, { token: viewer.token, body: { pageId: 'page1', x: 'left', y: 0, body: 'x' } })).status).toBe(400);
    expect((await call(server, 'POST', `/api/documents/${doc.id}/threads`, { token: viewer.token, body: { pageId: 'page1', x: 0, y: 0, body: '  ' } })).status).toBe(400);
    await watcher.socket.close();
  });

  it('notifies whoever is mentioned and can open the document, and no one else', async () => {
    const { owner, editor, doc } = await team('Mention');
    const outsider = await signUp(server, 'Outsider');
    await call(server, 'POST', `/api/documents/${doc.id}/threads`, {
      token: owner.token,
      body: { pageId: 'p', x: 0, y: 0, nodeId: null, body: `@[${editor.user.name}](${editor.user.id}) and @[Outsider](${outsider.user.id}), look at this` },
    });
    const mention = await notes(editor.token, 'mention');
    expect(mention).toEqual([
      expect.objectContaining({ kind: 'mention', docId: doc.id, from: expect.objectContaining({ id: owner.user.id }), text: `@${editor.user.name} and @Outsider, look at this`, read: false }),
    ]);
    // Someone who cannot open the document is not told about it.
    expect(await notes(outsider.token)).toEqual([]);
    // Nor is the author.
    expect(await notes(owner.token, 'mention')).toEqual([]);
  });

  it('notifies the thread’s other participants of a reply', async () => {
    const { owner, editor, viewer, doc } = await team('Reply');
    const thread = (await call<Thread>(server, 'POST', `/api/documents/${doc.id}/threads`, { token: owner.token, body: { pageId: 'p', x: 1, y: 2, body: 'First' } })).body;
    await call(server, 'POST', `/api/threads/${thread.id}/comments`, { token: editor.token, body: { body: 'Second' } });
    const replied = await call<Thread>(server, 'POST', `/api/threads/${thread.id}/comments`, { token: viewer.token, body: { body: 'Third' } });
    expect(replied.body.comments.map((c) => c.body)).toEqual(['First', 'Second', 'Third']);

    expect((await notes(owner.token, 'reply')).map((n) => n.text)).toEqual(['Third', 'Second']);
    expect((await notes(editor.token, 'reply')).map((n) => n.text)).toEqual(['Third']);
    expect(await notes(viewer.token, 'reply')).toEqual([]);
    expect((await notes(owner.token, 'reply'))[0]).toMatchObject({ threadId: thread.id, docId: doc.id, from: { id: viewer.user.id } });
  });

  it('resolves and reopens threads; only the author or an editor moves or deletes one', async () => {
    const { owner, editor, viewer, doc } = await team('Resolve');
    const watcher = await TestSocket.join(server, doc.id, { token: editor.token }, 'watcher2');
    const thread = (await call<Thread>(server, 'POST', `/api/documents/${doc.id}/threads`, { token: owner.token, body: { pageId: 'p', x: 1, y: 2, body: 'Fix the spacing' } })).body;
    await watcher.socket.next('comment');

    const resolved = await call<Thread>(server, 'PATCH', `/api/threads/${thread.id}`, { token: viewer.token, body: { resolved: true } });
    expect(resolved.body.resolved).toBe(true);
    expect((await watcher.socket.next('comment')).event).toMatchObject({ kind: 'thread', thread: { id: thread.id, resolved: true } });
    expect((await call<Thread>(server, 'PATCH', `/api/threads/${thread.id}`, { token: viewer.token, body: { resolved: false } })).body.resolved).toBe(false);

    expect((await call(server, 'PATCH', `/api/threads/${thread.id}`, { token: viewer.token, body: { x: 99, y: 99 } })).status).toBe(403);
    const moved = await call<Thread>(server, 'PATCH', `/api/threads/${thread.id}`, { token: editor.token, body: { x: 99, y: 98 } });
    expect([moved.body.x, moved.body.y]).toEqual([99, 98]);

    expect((await call(server, 'DELETE', `/api/threads/${thread.id}`, { token: viewer.token })).status).toBe(403);
    expect((await call(server, 'DELETE', `/api/threads/${thread.id}`, { token: editor.token })).status).toBe(200);
    expect((await watcher.socket.next('comment', (m) => m.event.kind === 'deleted')).event).toEqual({ kind: 'deleted', threadId: thread.id });
    expect((await call(server, 'GET', `/api/documents/${doc.id}/threads`, { token: owner.token })).body).toEqual([]);
    await watcher.socket.close();
  });

  it('lets only its author edit a comment, and tells people mentioned for the first time', async () => {
    const { owner, editor, viewer, doc } = await team('Edit');
    const thread = (await call<Thread>(server, 'POST', `/api/documents/${doc.id}/threads`, {
      token: owner.token,
      body: { pageId: 'p', x: 0, y: 0, body: `Hello @[E](${editor.user.id})` },
    })).body;
    const commentId = thread.comments[0]?.id as string;
    expect((await call(server, 'PATCH', `/api/comments/${commentId}`, { token: editor.token, body: { body: 'Not mine' } })).status).toBe(403);

    const edited = await call<Thread>(server, 'PATCH', `/api/comments/${commentId}`, {
      token: owner.token,
      body: { body: `Hello @[E](${editor.user.id}) and @[V](${viewer.user.id})` },
    });
    expect(edited.body.comments[0]).toMatchObject({ mentions: [editor.user.id, viewer.user.id], editedAt: expect.any(String) });
    expect(await notes(editor.token, 'mention')).toHaveLength(1);
    expect(await notes(viewer.token, 'mention')).toHaveLength(1);
  });

  it('deletes a comment by its author, and the thread with its last comment', async () => {
    const { owner, editor, doc } = await team('Delete');
    const thread = (await call<Thread>(server, 'POST', `/api/documents/${doc.id}/threads`, { token: owner.token, body: { pageId: 'p', x: 0, y: 0, body: 'One' } })).body;
    const reply = (await call<Thread>(server, 'POST', `/api/threads/${thread.id}/comments`, { token: editor.token, body: { body: 'Two' } })).body;
    const replyId = reply.comments[1]?.id as string;

    expect((await call(server, 'DELETE', `/api/comments/${replyId}`, { token: owner.token })).status).toBe(403);
    const left = await call<Thread>(server, 'DELETE', `/api/comments/${replyId}`, { token: editor.token });
    expect(left.body.comments.map((c) => c.body)).toEqual(['One']);
    const gone = await call(server, 'DELETE', `/api/comments/${thread.comments[0]?.id}`, { token: owner.token });
    expect(gone.body).toEqual({});
    expect((await call(server, 'GET', `/api/documents/${doc.id}/threads`, { token: owner.token })).body).toEqual([]);
  });

  it('lets guests comment through the link, and be mentioned', async () => {
    const owner = await signUp(server, 'GuestHost');
    const doc = await newDoc(server, owner.token, 'Open for comments');
    const guest = (await call(server, 'POST', '/api/guests', { body: { name: 'Reviewer' } })).body;
    expect((await call(server, 'POST', `/api/documents/${doc.id}/threads`, { guest: guest.guestToken, body: { pageId: 'p', x: 0, y: 0, body: 'Hi' } })).status).toBe(403);

    await call(server, 'PATCH', `/api/documents/${doc.id}`, { token: owner.token, body: { linkAccess: 'view' } });
    const thread = await call<Thread>(server, 'POST', `/api/documents/${doc.id}/threads`, { guest: guest.guestToken, body: { pageId: 'p', x: 0, y: 0, body: 'Looks good' } });
    expect(thread.status).toBe(201);
    expect(thread.body.comments[0]?.author).toEqual({ id: guest.guest.id, name: 'Reviewer', color: guest.guest.color, guest: true });
    // Someone with only a link and no name cannot comment.
    expect((await call(server, 'POST', `/api/threads/${thread.body.id}/comments`, { body: { body: 'Anonymous' } })).status).toBe(401);

    await call(server, 'POST', `/api/threads/${thread.body.id}/comments`, { token: owner.token, body: { body: `Thanks @[Reviewer](${guest.guest.id})` } });
    const theirs = (await call<Notification[]>(server, 'GET', '/api/notifications', { guest: guest.guestToken })).body;
    expect(theirs.map((n) => n.kind)).toEqual(['mention']);
  });

  it('marks notifications as read', async () => {
    const { owner, editor, doc } = await team('Read');
    await call(server, 'POST', `/api/documents/${doc.id}/threads`, { token: owner.token, body: { pageId: 'p', x: 0, y: 0, body: `@[E](${editor.user.id}) one` } });
    await call(server, 'POST', `/api/documents/${doc.id}/threads`, { token: owner.token, body: { pageId: 'p', x: 0, y: 0, body: `@[E](${editor.user.id}) two` } });
    const before = await notes(editor.token, 'mention');
    expect(before.map((n) => n.read)).toEqual([false, false]);
    // Someone else's IDs change nothing.
    await call(server, 'POST', '/api/notifications/read', { token: owner.token, body: { ids: before.map((n) => n.id) } });
    expect((await notes(editor.token, 'mention')).map((n) => n.read)).toEqual([false, false]);
    await call(server, 'POST', '/api/notifications/read', { token: editor.token, body: { ids: [before[0]?.id] } });
    expect((await notes(editor.token, 'mention')).map((n) => n.read)).toEqual([true, false]);
    expect((await call(server, 'POST', '/api/notifications/read', { token: editor.token, body: { ids: 'all' } })).status).toBe(400);
  });
});
