import { describe, expect, it } from 'vitest';
import { createDocument } from './core';
import { createApi, type EvoraApi } from './collab/api';
import type { CommentEvent, LinkAccess, Peer, Presence, Role, Thread } from './collab/protocol';
import { createEditorStore } from './state/editorStore';
import { createCollabSession, peopleHere, statusLabel, statusTone, type LiveConnection } from './ui/collab/session';

/**
 * The editor's collaboration session against a stand-in for the live
 * connection and the real editor store: what it mirrors of the connection,
 * read-only access for viewers, comments arriving and being made, and following.
 */

class FakeLive implements LiveConnection {
  statusValue = 'connecting';
  pending = 0;
  peerList: Peer[] = [];
  me: Peer | null = null;
  roleValue: Role | null = null;
  presence: Partial<Presence>[] = [];
  closed = false;
  private listeners = { status: new Set<(s: string) => void>(), peers: new Set<(p: Peer[]) => void>(), access: new Set<(r: Role | null, l: LinkAccess) => void>(), comment: new Set<(e: CommentEvent) => void>(), pending: new Set<(n: number) => void>() };
  status(): string {
    return this.statusValue;
  }
  onStatus(callback: (status: string) => void): () => void {
    this.listeners.status.add(callback);
    return () => this.listeners.status.delete(callback);
  }
  peers(): Peer[] {
    return this.peerList;
  }
  onPeers(callback: (peers: Peer[]) => void): () => void {
    this.listeners.peers.add(callback);
    return () => this.listeners.peers.delete(callback);
  }
  you(): Peer | null {
    return this.me;
  }
  role(): Role | null {
    return this.roleValue;
  }
  onAccess(callback: (role: Role | null, linkAccess: LinkAccess) => void): () => void {
    this.listeners.access.add(callback);
    return () => this.listeners.access.delete(callback);
  }
  setPresence(presence: Partial<Presence>): void {
    this.presence.push(presence);
  }
  onComment(callback: (event: CommentEvent) => void): () => void {
    this.listeners.comment.add(callback);
    return () => this.listeners.comment.delete(callback);
  }
  pendingCount(): number {
    return this.pending;
  }
  onPending(callback: (count: number) => void): () => void {
    this.listeners.pending.add(callback);
    return () => this.listeners.pending.delete(callback);
  }
  close(): void {
    this.closed = true;
  }
  // What the server would make happen.
  welcome(role: Role, you: Peer, peers: Peer[]): void {
    this.roleValue = role;
    this.me = you;
    this.peerList = peers;
    this.setStatus('online');
    for (const listener of this.listeners.peers) listener(peers);
  }
  setStatus(status: string): void {
    this.statusValue = status;
    for (const listener of this.listeners.status) listener(status);
  }
  setPending(count: number): void {
    this.pending = count;
    for (const listener of this.listeners.pending) listener(count);
  }
  setPeers(peers: Peer[]): void {
    this.peerList = peers;
    for (const listener of this.listeners.peers) listener(peers);
  }
  access(role: Role | null, linkAccess: LinkAccess): void {
    this.roleValue = role;
    for (const listener of this.listeners.access) listener(role, linkAccess);
  }
  comment(event: CommentEvent): void {
    for (const listener of this.listeners.comment) listener(event);
  }
}

const peer = (clientId: string, userId: string, name: string, role: Role = 'editor'): Peer => ({ clientId, user: { id: userId, name, color: '#0d99ff' }, role, presence: null });

const thread = (id: string, body = 'Hello', authorId = 'u1'): Thread => ({
  id,
  docId: 'd1',
  pageId: 'p1',
  x: 1,
  y: 2,
  nodeId: null,
  resolved: false,
  createdAt: '2026-11-17T10:00:00.000Z',
  comments: [{ id: `${id}-c1`, threadId: id, author: { id: authorId, name: 'Ana', color: '#0d99ff' }, body, mentions: [], createdAt: '2026-11-17T10:00:00.000Z', editedAt: null }],
});

/** An API whose requests are recorded and answered by `answer`. */
function recordingApi(answer: (method: string, url: string, body: unknown) => unknown = () => ({})): { api: EvoraApi; calls: { method: string; url: string; body: unknown }[] } {
  const calls: { method: string; url: string; body: unknown }[] = [];
  const api = createApi({
    auth: () => ({ token: 't', guestToken: null }),
    fetch: async (url, init) => {
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
      calls.push({ method: init.method ?? 'GET', url, body });
      return new Response(JSON.stringify(answer(init.method ?? 'GET', url, body) ?? {}), { status: 200 });
    },
  });
  return { api, calls };
}

function setup(answer?: (method: string, url: string, body: unknown) => unknown, signedIn = true) {
  const editor = createEditorStore(createDocument('Shared'));
  const { api, calls } = recordingApi(answer);
  const session = createCollabSession({ docId: 'd1', api, editor, signedIn: () => signedIn });
  const live = new FakeLive();
  return { editor, api, calls, session, live };
}

describe('the live connection, as the editor sees it', () => {
  it('mirrors its status, the changes waiting, who is here and what you may do', () => {
    const { session, live } = setup();
    const detach = session.attach(live);
    expect(session.store.getState().status).toBe('connecting');
    live.welcome('editor', peer('c0', 'u0', 'Me'), [peer('c0', 'u0', 'Me'), peer('c1', 'u1', 'Ana')]);
    let state = session.store.getState();
    expect(state.status).toBe('online');
    expect(state.role).toBe('editor');
    expect(state.you?.clientId).toBe('c0');
    expect(state.peers.map((p) => p.clientId)).toEqual(['c0', 'c1']);
    live.setStatus('offline');
    live.setPending(3);
    state = session.store.getState();
    expect(statusLabel(state.status, state.pending)).toBe('Offline — 3 changes waiting');
    detach();
    live.setPending(0);
    expect(session.store.getState().pending).toBe(3);
  });

  it('makes the document read-only for a viewer, and editable again when they are made an editor', () => {
    const { session, live, editor } = setup();
    session.attach(live);
    live.welcome('viewer', peer('c0', 'u0', 'Me', 'viewer'), []);
    expect(editor.getState().readOnly).toBe(true);
    live.access('viewer', 'view');
    expect(editor.getState().readOnly).toBe(true);
    expect(session.store.getState().linkAccess).toBe('view');
    live.access('editor', 'view');
    expect(editor.getState().readOnly).toBe(false);
    live.access(null, 'none');
    expect(editor.getState().readOnly).toBe(true);
  });

  it('takes a viewer’s role from the connection when it is attached', () => {
    const { session, live, editor } = setup();
    live.roleValue = 'viewer';
    session.attach(live);
    expect(editor.getState().readOnly).toBe(true);
  });

  it('leaves the document editable while the role is not known yet, so that work can go on offline', () => {
    const { session, live, editor } = setup();
    session.attach(live);
    live.setStatus('offline');
    expect(session.store.getState().role).toBeNull();
    expect(editor.getState().readOnly).toBe(false);
  });

  it('stops following someone who has left', () => {
    const { session, live } = setup();
    session.attach(live);
    live.welcome('editor', peer('c0', 'u0', 'Me'), [peer('c1', 'u1', 'Ana')]);
    session.follow('c1');
    live.setPeers([peer('c2', 'u2', 'Bob')]);
    expect(session.store.getState().following).toBeNull();
  });
});

describe('comments in a session', () => {
  it('take in threads, changes and deletions as they arrive', () => {
    const { session, live } = setup();
    session.attach(live);
    live.comment({ kind: 'thread', thread: thread('t1') });
    live.comment({ kind: 'thread', thread: thread('t2') });
    live.comment({ kind: 'thread', thread: { ...thread('t1'), resolved: true } });
    session.openThread('t2');
    live.comment({ kind: 'deleted', threadId: 't2' });
    const state = session.store.getState();
    expect(Object.keys(state.threads)).toEqual(['t1']);
    expect(state.threads.t1?.resolved).toBe(true);
    expect(state.openThreadId).toBeNull();
  });

  it('posts a new thread where it was pinned, opens it, and puts the draft away', async () => {
    const { session, calls } = setup((method, url, body) => (method === 'POST' && url.endsWith('/threads') ? { ...thread('t9', (body as { body: string }).body), x: 5, y: 6 } : {}));
    session.setCommentMode(true);
    const pin = { pageId: 'p1', nodeId: null, x: 5, y: 6 };
    session.setDraft(pin);
    await session.postThread(pin, 'Hi @[Ana](u1)');
    expect(calls[0]).toEqual({ method: 'POST', url: '/api/documents/d1/threads', body: { pageId: 'p1', nodeId: null, x: 5, y: 6, body: 'Hi @[Ana](u1)' } });
    const state = session.store.getState();
    expect(state.draft).toBeNull();
    expect(state.openThreadId).toBe('t9');
    expect(state.threads.t9?.comments[0]?.body).toBe('Hi @[Ana](u1)');
  });

  it('resolves, replies, edits and deletes through the server, keeping what it answers', async () => {
    let current = thread('t1');
    const { session, calls } = setup((method, url, body) => {
      if (url === '/api/threads/t1' && method === 'PATCH') current = { ...current, resolved: (body as { resolved: boolean }).resolved };
      if (url === '/api/threads/t1/comments') current = { ...current, comments: [...current.comments, { ...(current.comments[0] as Thread['comments'][number]), id: 'c2', body: (body as { body: string }).body }] };
      if (url === '/api/comments/c2' && method === 'DELETE') return {};
      return current;
    });
    session.applyCommentEvent({ kind: 'thread', thread: current });
    await session.setResolved('t1', true);
    expect(session.store.getState().threads.t1?.resolved).toBe(true);
    await session.reply('t1', 'Agreed');
    expect(session.store.getState().threads.t1?.comments.map((comment) => comment.body)).toEqual(['Hello', 'Agreed']);
    // Deleting the last comment of a thread removes the thread (the server answers with nothing).
    await session.deleteComment('t1', 'c2');
    expect(session.store.getState().threads.t1).toBeUndefined();
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(['PATCH /api/threads/t1', 'POST /api/threads/t1/comments', 'DELETE /api/comments/c2']);
  });

  it('reads the document, its comments and the people who can be mentioned', async () => {
    const member = (id: string, name: string) => ({ user: { id, name, color: '#000000', email: `${id}@example.com` }, role: 'editor' });
    const { session } = setup((_method, url) => {
      if (url === '/api/documents/d1') return { id: 'd1', name: 'Shared', workspaceId: 'w1', role: 'editor', linkAccess: 'view', owner: { id: 'u1', name: 'Ana', color: '#000' }, createdAt: '', updatedAt: '' };
      if (url === '/api/documents/d1/threads') return [thread('t1'), thread('t2')];
      if (url === '/api/documents/d1/members') return { members: [member('u1', 'Ana')], pending: [] };
      if (url === '/api/workspaces/w1/members') return { members: [member('u1', 'Ana'), member('u2', 'Bob')], pending: [] };
      if (url === '/api/workspaces') return [{ id: 'w1', name: 'Studio', role: 'editor', memberCount: 2, createdAt: '' }];
      return {};
    });
    await session.refresh();
    const state = session.store.getState();
    expect(state.info?.workspaceId).toBe('w1');
    expect(state.linkAccess).toBe('view');
    expect(Object.keys(state.threads).sort()).toEqual(['t1', 't2']);
    expect(state.members.map((m) => m.user.name)).toEqual(['Ana', 'Bob']);
  });

  it('asks only for the member lists the person may read', async () => {
    const doc = { id: 'd1', name: 'Shared', workspaceId: 'w1', role: 'viewer', linkAccess: 'view', owner: { id: 'u1', name: 'Ana', color: '#000' }, createdAt: '', updatedAt: '' };
    const answer = (_method: string, url: string): unknown => {
      if (url === '/api/documents/d1') return doc;
      if (url === '/api/documents/d1/threads') return [];
      if (url === '/api/documents/d1/members') return { members: [], pending: [] };
      // The document's workspace is not one of theirs.
      if (url === '/api/workspaces') return [{ id: 'w9', name: 'Their own', role: 'owner', memberCount: 1, createdAt: '' }];
      return {};
    };
    const outside = setup(answer);
    await outside.session.refresh();
    expect(outside.calls.map((call) => call.url)).not.toContain('/api/workspaces/w1/members');
    expect(outside.calls.map((call) => call.url)).toContain('/api/documents/d1/members');
    // A guest may read no member list at all.
    const guest = setup(answer, false);
    await guest.session.refresh();
    expect(guest.calls.map((call) => call.url).sort()).toEqual(['/api/documents/d1', '/api/documents/d1/threads']);
    expect(guest.session.store.getState().members).toEqual([]);
  });
});

describe('what the session holds for the panels', () => {
  it('puts the Comments tab away when another tab of the right sidebar is chosen', () => {
    const { session, editor } = setup();
    session.setCommentsTab(true);
    editor.getState().setRightTab('prototype');
    expect(session.store.getState().commentsTab).toBe(false);
  });

  it('says how the shared document stands with the server', () => {
    expect(statusLabel('connecting', 0)).toBe('Connecting…');
    expect(statusLabel('online', 0)).toBe('Synced');
    expect(statusLabel('online', 2)).toBe('Saving…');
    expect(statusLabel('offline', 1)).toBe('Offline — 1 change waiting');
    expect(statusLabel('offline', 0)).toBe('Offline');
    expect(statusTone('online', 0)).toBe('ok');
    expect(statusTone('online', 1)).toBe('busy');
    expect(statusTone('offline', 0)).toBe('bad');
  });

  it('lists you first, then each other person once however many tabs they have open', () => {
    const me = peer('c0', 'u0', 'Me');
    const list = peopleHere(me, [peer('c1', 'u1', 'Ana'), me, peer('c2', 'u1', 'Ana'), peer('c3', 'u0', 'Me'), peer('c4', 'u2', 'Bob')]);
    expect(list.map((p) => p.clientId)).toEqual(['c0', 'c1', 'c4']);
  });
});
