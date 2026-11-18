import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addLayer,
  createDocument,
  deleteNodes,
  getChildIds,
  getPages,
  imagePaint,
  moveNodesBy,
  patchNode,
  solidPaint,
  validateDocument,
  type Document,
  type NodeId,
} from '../core';
import { MemoryStorage } from '../persistence/storage';
import { createEditorStore, type EditorStore } from '../state/editorStore';
import { cloudAssetLoader, LiveError, loadSharedDocument, openLiveDocument, ownerKey, type LiveDocument, type LiveStatus } from './live';
import { OfflineStore } from './offline';
import {
  canEdit,
  makeClock,
  wins,
  type ClientMessage,
  type CommentEvent,
  type DocInfo,
  type LinkAccess,
  type Peer,
  type Role,
  type ServerMessage,
  type StoredRegister,
} from './protocol';
import { documentFromRegisters, registersFromDocument } from './registers';

/**
 * The live engine against an in-memory server that speaks the protocol of
 * protocol.ts over a fake WebSocket and a fake fetch: messages travel as JSON
 * text, a few milliseconds late, so nothing is shared between the copies but
 * what is sent. Timers are fake, so waiting is exact.
 */

const DOC_ID = 'docShared01';
const LATENCY = 3;

class FakeSocket {
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  clientId: string | null = null;
  token = '';
  role: Role | null = null;
  peer: Peer | null = null;

  constructor(
    private readonly server: FakeServer,
    readonly url: string,
  ) {
    server.open(this);
  }

  /** The server accepted the connection. */
  opened(): void {
    if (this.readyState !== 0) return;
    this.readyState = 1;
    this.onopen?.({});
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error('The socket is not open');
    const message = JSON.parse(data) as ClientMessage;
    setTimeout(() => {
      if (this.readyState === 1) this.server.handle(this, message);
    }, LATENCY);
  }

  /** A message from the server. */
  deliver(message: ServerMessage): void {
    const data = JSON.stringify(message);
    setTimeout(() => {
      if (this.readyState === 1) this.onmessage?.({ data });
    }, LATENCY);
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.server.disconnect(this);
    setTimeout(() => this.onclose?.({}), LATENCY);
  }
}

class FakeServer {
  readonly registers = new Map<string, StoredRegister>();
  seq = 0;
  /** The sockets that have said hello. */
  readonly joined = new Set<FakeSocket>();
  readonly roles = new Map<string, Role>();
  readonly received: { clientId: string | null; message: ClientMessage }[] = [];
  readonly connections: number[] = [];
  readonly requests: { method: string; url: string }[] = [];
  readonly assets = new Map<string, { mimeType: string; bytes: ArrayBuffer }>();
  accepting = true;
  reachable = true;
  rejectNext = 0;
  linkAccess: LinkAccess = 'none';

  constructor(doc: Document) {
    this.seq = 1;
    for (const register of registersFromDocument(doc, { last: makeClock(0, 0, 'seed'), clientId: 'seed' }, 1000)) this.registers.set(register.k, { ...register, s: 1 });
  }

  socketClass(): typeof WebSocket {
    const server = this;
    return class {
      constructor(url: string) {
        return new FakeSocket(server, url);
      }
    } as unknown as typeof WebSocket;
  }

  open(socket: FakeSocket): void {
    this.connections.push(Date.now());
    setTimeout(() => (this.accepting ? socket.opened() : socket.close()), LATENCY);
  }

  info(role: Role | null): DocInfo {
    return { id: DOC_ID, name: 'Shared', workspaceId: 'w1', role, linkAccess: this.linkAccess, owner: { id: 'alice', name: 'alice', color: '#f24e1e' }, createdAt: '', updatedAt: '' };
  }

  handle(socket: FakeSocket, message: ClientMessage): void {
    this.received.push({ clientId: socket.clientId, message });
    switch (message.t) {
      case 'hello': {
        const token = message.token ?? message.guestToken ?? '';
        const role = this.roles.get(token) ?? null;
        if (!role) {
          socket.deliver({ t: 'error', code: 'forbidden', message: 'You cannot open this file.' });
          setTimeout(() => socket.close(), LATENCY * 2);
          return;
        }
        socket.clientId = message.clientId;
        socket.token = token;
        socket.role = role;
        socket.peer = { clientId: message.clientId, user: { id: token, name: token, color: '#0d99ff' }, role, presence: null };
        const registers = [...this.registers.values()].filter((register) => register.s > message.since);
        const peers = [...this.joined].map((other) => other.peer as Peer);
        socket.deliver({ t: 'welcome', seq: this.seq, full: message.since === 0, registers, you: socket.peer, peers, doc: this.info(role) });
        for (const other of this.joined) other.deliver({ t: 'presence', peer: socket.peer });
        this.joined.add(socket);
        break;
      }
      case 'ops': {
        if (!canEdit(socket.role) || this.rejectNext > 0) {
          if (this.rejectNext > 0) this.rejectNext--;
          socket.deliver({ t: 'rejected', id: message.id, reason: 'Not allowed' });
          return;
        }
        this.seq++;
        const kept: StoredRegister[] = [];
        for (const register of message.ops) {
          if (!wins(register, this.registers.get(register.k))) continue;
          const stored = { ...register, s: this.seq };
          this.registers.set(register.k, stored);
          kept.push(stored);
        }
        socket.deliver({ t: 'ack', id: message.id, seq: this.seq });
        if (kept.length > 0) for (const other of this.joined) if (other !== socket) other.deliver({ t: 'ops', seq: this.seq, ops: kept, from: socket.clientId as string });
        break;
      }
      case 'presence':
        if (!socket.peer) return;
        socket.peer = { ...socket.peer, presence: message.presence };
        for (const other of this.joined) if (other !== socket) other.deliver({ t: 'presence', peer: socket.peer });
        break;
      case 'ping':
        socket.deliver({ t: 'pong' });
        break;
    }
  }

  disconnect(socket: FakeSocket): void {
    if (!this.joined.delete(socket)) return;
    for (const other of this.joined) other.deliver({ t: 'leave', clientId: socket.clientId as string });
  }

  /** Cuts one person's connection, as a network would. */
  drop(token: string): void {
    for (const socket of [...this.joined]) if (socket.token === token) socket.close();
  }

  setRole(token: string, role: Role | null): void {
    if (role) this.roles.set(token, role);
    else this.roles.delete(token);
    for (const socket of this.joined) {
      if (socket.token !== token) continue;
      socket.role = role;
      socket.deliver({ t: 'access', role, linkAccess: this.linkAccess });
    }
  }

  broadcast(message: ServerMessage): void {
    for (const socket of this.joined) socket.deliver(message);
  }

  /** The document as the server holds it. */
  doc(): Document {
    return documentFromRegisters([...this.registers.values()], { id: DOC_ID, name: 'Untitled' });
  }

  opsFrom(clientId: string): ClientMessage[] {
    return this.received.filter((entry) => entry.clientId === clientId && entry.message.t === 'ops').map((entry) => entry.message);
  }

  readonly fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (!this.reachable) throw new TypeError('fetch failed');
    const url = String(input);
    const method = init?.method ?? 'GET';
    this.requests.push({ method, url });
    const headers = new Headers(init?.headers);
    const token = headers.get('Authorization')?.replace(/^Bearer /, '') ?? headers.get('X-Evora-Guest') ?? '';
    const role = this.roles.get(token) ?? null;
    const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (!role) return json(403, { error: 'You cannot open this file.' });
    if (/\/api\/documents\/[^/]+\/registers$/.test(url)) return json(200, { seq: this.seq, registers: [...this.registers.values()] });
    const asset = /\/api\/documents\/[^/]+\/assets\/([^/]+)$/.exec(url);
    if (asset) {
      const hash = decodeURIComponent(asset[1] as string);
      if (method === 'PUT') {
        if (!canEdit(role)) return json(403, { error: 'Viewers cannot add images.' });
        this.assets.set(hash, { mimeType: headers.get('Content-Type') ?? '', bytes: init?.body as ArrayBuffer });
        return json(200, {});
      }
      const held = this.assets.get(hash);
      return held ? new Response(held.bytes, { status: 200, headers: { 'Content-Type': held.mimeType } }) : json(404, { error: 'No such image.' });
    }
    return json(404, { error: 'Not found' });
  }) as typeof fetch;
}

interface Client {
  store: EditorStore;
  live: LiveDocument;
  token: string;
}

const opened: LiveDocument[] = [];

async function join(server: FakeServer, token: string, options: { offline?: OfflineStore | null; storage?: MemoryStorage; network?: EventTarget } = {}): Promise<Client> {
  const auth = { token, guestToken: null };
  const loaded = await loadSharedDocument(DOC_ID, auth, { fetch: server.fetch, offline: options.offline ?? null });
  const store = createEditorStore(loaded.doc);
  const live = openLiveDocument({
    docId: DOC_ID,
    store,
    auth,
    seq: loaded.seq,
    socketUrl: 'ws://test/ws',
    WebSocketImpl: server.socketClass(),
    offline: options.offline ?? null,
    fetch: server.fetch,
    storage: options.storage ?? null,
    network: options.network ?? null,
  });
  opened.push(live);
  return { store, live, token };
}

const settle = async (ms = 300): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms);
};

function firstPage(store: EditorStore): NodeId {
  return getPages(store.getState().doc)[0]!.id;
}

function base(): { doc: Document; frame: NodeId; rect: NodeId } {
  const doc = createDocument('Shared');
  const page = getPages(doc)[0]!.id;
  const frame = addLayer(doc, 'FRAME', page, { x: 0, y: 0, width: 400, height: 300, name: 'Card' });
  const rect = addLayer(frame.doc, 'RECTANGLE', frame.id, { x: 10, y: 10, name: 'Box' });
  return { doc: { ...rect.doc, id: DOC_ID }, frame: frame.id, rect: rect.id };
}

function nodeOf(client: Client, id: NodeId): Record<string, unknown> | undefined {
  return client.store.getState().doc.nodes[id] as unknown as Record<string, unknown> | undefined;
}

beforeEach(() => {
  // IndexedDB (fake-indexeddb) keeps its own, real, timing.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});

afterEach(() => {
  for (const live of opened.splice(0)) live.close();
  vi.useRealTimers();
});

describe('editing a shared document live', () => {
  it('brings two people editing at once to the same document, without the other’s changes in their undo history', async () => {
    const { doc, frame, rect } = base();
    const server = new FakeServer(doc);
    server.roles.set('alice', 'editor');
    server.roles.set('bob', 'editor');
    const alice = await join(server, 'alice');
    const bob = await join(server, 'bob');
    await settle();
    expect(alice.live.status()).toBe('online');
    expect(bob.live.status()).toBe('online');

    // At the same moment: Alice moves the box and adds a text, Bob recolours the box and adds an ellipse.
    alice.store.getState().apply('Move', (d) => moveNodesBy(d, [rect], 40, 0));
    bob.store.getState().apply('Colour', (d) => patchNode(d, rect, { fills: [solidPaint({ r: 0, g: 0.5, b: 1 })] }));
    let ellipse = '';
    bob.store.getState().apply('Ellipse', (d) => {
      const added = addLayer(d, 'ELLIPSE', frame, { x: 100, y: 100 });
      ellipse = added.id;
      return added.doc;
    });
    alice.store.getState().apply('Text', (d) => addLayer(d, 'TEXT', firstPage(alice.store), { characters: 'Hello', x: 500 }).doc);
    await settle();

    expect(alice.store.getState().doc).toEqual(bob.store.getState().doc);
    expect(alice.store.getState().doc).toEqual(server.doc());
    expect(nodeOf(alice, rect)).toMatchObject({ x: 50, fills: [{ color: { r: 0, g: 0.5, b: 1 } }] });
    expect(nodeOf(alice, ellipse)).toMatchObject({ type: 'ELLIPSE', parentId: frame });
    expect(validateDocument(alice.store.getState().doc)).toEqual([]);
    expect(alice.store.getState().undoStack.map((entry) => entry.label)).toEqual(['Move', 'Text']);
    expect(bob.store.getState().undoStack.map((entry) => entry.label)).toEqual(['Colour', 'Ellipse']);
  });

  it('counts changes waiting until the server acknowledges them', async () => {
    const { doc, rect } = base();
    const server = new FakeServer(doc);
    server.roles.set('alice', 'editor');
    const alice = await join(server, 'alice');
    await settle();
    const counts: number[] = [];
    alice.live.onPending((count) => counts.push(count));
    alice.store.getState().apply('Move', (d) => moveNodesBy(d, [rect], 5, 5));
    expect(alice.live.pendingCount()).toBe(2);
    await settle();
    expect(alice.live.pendingCount()).toBe(0);
    expect(counts).toEqual([2, 0]);
    // Changes made during a drag go out in batches, the last value of each property once per batch.
    alice.store.getState().beginGesture();
    for (let step = 1; step <= 10; step++) alice.store.getState().updateGesture((d) => moveNodesBy(d, [rect], step, 0));
    alice.store.getState().commitGesture('Move');
    await settle();
    const batches = server.opsFrom(alice.live.clientId);
    expect(batches).toHaveLength(2);
    expect((batches[1] as Extract<ClientMessage, { t: 'ops' }>).ops.map((register) => register.k)).toEqual([`n:${rect}:x`]);
    expect(server.doc().nodes[rect]).toMatchObject({ x: 25 });
  });

  it('keeps changes made offline and merges them when the connection is back', async () => {
    const { doc, rect, frame } = base();
    const server = new FakeServer(doc);
    server.roles.set('alice', 'editor');
    server.roles.set('bob', 'editor');
    const alice = await join(server, 'alice');
    const bob = await join(server, 'bob');
    await settle();
    const statuses: LiveStatus[] = [];
    alice.live.onStatus((status) => statuses.push(status));

    server.accepting = false;
    server.drop('alice');
    await settle(50);
    expect(alice.live.status()).toBe('offline');
    expect(bob.live.peers()).toEqual([]);

    // Offline, Alice renames the box and moves it; Bob meanwhile recolours it and renames it too (later, so his name stays).
    alice.store.getState().apply('Rename', (d) => patchNode(d, rect, { name: 'Alice offline' }));
    alice.store.getState().apply('Move', (d) => moveNodesBy(d, [rect], 0, 30));
    let made = '';
    alice.store.getState().apply('Add', (d) => {
      const added = addLayer(d, 'STAR', frame);
      made = added.id;
      return added.doc;
    });
    await settle(100);
    bob.store.getState().apply('Rename', (d) => patchNode(d, rect, { name: 'Bob online' }));
    bob.store.getState().apply('Colour', (d) => patchNode(d, rect, { fills: [solidPaint({ r: 1, g: 1, b: 0 })] }));
    await settle(400);
    expect(alice.live.pendingCount()).toBeGreaterThan(0);
    expect(server.opsFrom(alice.live.clientId)).toHaveLength(0);
    expect(nodeOf(bob, made)).toBeUndefined();

    server.accepting = true;
    await settle(20_000);
    expect(alice.live.status()).toBe('online');
    expect(alice.live.pendingCount()).toBe(0);
    expect(alice.store.getState().doc).toEqual(bob.store.getState().doc);
    expect(nodeOf(bob, rect)).toMatchObject({ name: 'Bob online', y: 40, fills: [{ color: { r: 1, g: 1, b: 0 } }] });
    expect(nodeOf(bob, made)).toMatchObject({ type: 'STAR' });
    expect(statuses[0]).toBe('offline');
    expect(statuses.at(-1)).toBe('online');
  });

  it('takes the connection as gone when the browser says it is offline, and tries again at once when it is back', async () => {
    const { doc, rect } = base();
    const server = new FakeServer(doc);
    server.roles.set('alice', 'editor');
    server.roles.set('bob', 'editor');
    const network = new EventTarget();
    const alice = await join(server, 'alice', { network });
    const bob = await join(server, 'bob');
    await settle();
    expect(alice.live.status()).toBe('online');

    // The socket itself has not noticed (it never does while the network is simply gone): the browser's word is enough.
    server.accepting = false;
    network.dispatchEvent(new Event('offline'));
    expect(alice.live.status()).toBe('offline');
    alice.store.getState().apply('Rename', (d) => patchNode(d, rect, { name: 'Made offline' }));
    await settle(100);
    expect(alice.live.pendingCount()).toBeGreaterThan(0);
    expect(server.opsFrom(alice.live.clientId)).toHaveLength(0);
    expect(nodeOf(bob, rect)).toMatchObject({ name: 'Box' });

    // Back online: tried at once, well before the next attempt was due, and what waited is sent.
    await settle(2_000);
    server.accepting = true;
    const attempts = server.connections.length;
    network.dispatchEvent(new Event('online'));
    await settle(50);
    expect(server.connections.length).toBe(attempts + 1);
    expect(alice.live.status()).toBe('online');
    expect(alice.live.pendingCount()).toBe(0);
    expect(nodeOf(bob, rect)).toMatchObject({ name: 'Made offline' });
  });

  it('tries the connection again at growing intervals, up to ten seconds', async () => {
    const { doc } = base();
    const server = new FakeServer(doc);
    server.roles.set('alice', 'editor');
    server.accepting = false;
    const alice = await join(server, 'alice');
    await settle(40_000);
    const gaps = server.connections.slice(1).map((time, i) => time - (server.connections[i] as number));
    // Each wait counts from the moment the last attempt failed (a few milliseconds after it began).
    expect(gaps.slice(0, 7).map((gap) => Math.round(gap / 100) * 100)).toEqual([500, 1000, 2000, 4000, 8000, 10000, 10000]);
    expect(alice.live.status()).toBe('offline');
  });

  it('sends nothing for someone who may only view, who still sees everyone else’s changes', async () => {
    const { doc, rect } = base();
    const server = new FakeServer(doc);
    server.roles.set('alice', 'editor');
    server.roles.set('vera', 'viewer');
    const alice = await join(server, 'alice');
    const vera = await join(server, 'vera');
    const access: (Role | null)[] = [];
    vera.live.onAccess((role) => access.push(role));
    await settle();
    expect(vera.live.role()).toBe('viewer');
    expect(access).toEqual(['viewer']);
    expect(vera.store.getState().readOnly).toBe(true);

    const before = vera.store.getState().doc;
    vera.store.getState().apply('Move', (d) => moveNodesBy(d, [rect], 50, 0));
    expect(vera.store.getState().doc).toBe(before);
    // Even a change that reaches the document some other way is not sent.
    vera.store.setState({ doc: patchNode(before, rect, { name: 'Forced' }) });
    await settle();
    expect(server.opsFrom(vera.live.clientId)).toHaveLength(0);
    expect(vera.live.pendingCount()).toBe(0);

    alice.store.getState().apply('Rename', (d) => patchNode(d, rect, { name: 'From Alice' }));
    await settle();
    expect(nodeOf(vera, rect)).toMatchObject({ name: 'From Alice' });
  });

  it('undoes only one’s own step, keeping what someone else changed since', async () => {
    const { doc, rect } = base();
    const server = new FakeServer(doc);
    server.roles.set('alice', 'editor');
    server.roles.set('bob', 'editor');
    const alice = await join(server, 'alice');
    const bob = await join(server, 'bob');
    await settle();
    alice.store.getState().apply('Move', (d) => moveNodesBy(d, [rect], 100, 0));
    await settle();
    bob.store.getState().apply('Colour', (d) => patchNode(d, rect, { fills: [solidPaint({ r: 0, g: 1, b: 0 })] }));
    await settle();
    expect(alice.store.getState().undoStack).toHaveLength(1);
    alice.store.getState().undo();
    await settle();
    for (const client of [alice, bob]) expect(nodeOf(client, rect)).toMatchObject({ x: 10, fills: [{ color: { r: 0, g: 1, b: 0 } }] });
    expect(alice.store.getState().doc).toEqual(bob.store.getState().doc);
    alice.store.getState().redo();
    await settle();
    expect(nodeOf(bob, rect)).toMatchObject({ x: 110, fills: [{ color: { r: 0, g: 1, b: 0 } }] });
  });

  it('brings back a deleted layer with what others changed in it meanwhile when the deletion is undone', async () => {
    const { doc, rect } = base();
    const server = new FakeServer(doc);
    server.roles.set('alice', 'editor');
    server.roles.set('bob', 'editor');
    const alice = await join(server, 'alice');
    const bob = await join(server, 'bob');
    await settle();
    alice.store.getState().apply('Delete', (d) => deleteNodes(d, [rect]));
    bob.store.getState().apply('Rename', (d) => patchNode(d, rect, { name: 'Renamed by Bob' }));
    await settle();
    expect(nodeOf(alice, rect)).toBeUndefined();
    expect(nodeOf(bob, rect)).toBeUndefined();
    alice.store.getState().undo();
    await settle();
    expect(nodeOf(alice, rect)).toMatchObject({ name: 'Renamed by Bob', x: 10 });
    expect(alice.store.getState().doc).toEqual(bob.store.getState().doc);
    expect(alice.store.getState().doc).toEqual(server.doc());
  });

  it('takes a change the server refuses back to what the server holds', async () => {
    const { doc, rect } = base();
    const server = new FakeServer(doc);
    server.roles.set('alice', 'editor');
    const alice = await join(server, 'alice');
    await settle();
    server.rejectNext = 1;
    let made = '';
    alice.store.getState().apply('Changes', (d) => {
      const added = addLayer(moveNodesBy(d, [rect], 7, 0), 'ELLIPSE', firstPage(alice.store));
      made = added.id;
      return added.doc;
    });
    await settle();
    expect(nodeOf(alice, rect)).toMatchObject({ x: 10 });
    expect(nodeOf(alice, made)).toBeUndefined();
    expect(alice.store.getState().doc).toEqual(server.doc());
    expect(alice.live.pendingCount()).toBe(0);
  });

  it('makes the editor read-only and takes back what was waiting when edit rights are taken away, and closes when access goes', async () => {
    const { doc, rect } = base();
    const server = new FakeServer(doc);
    server.roles.set('alice', 'editor');
    const alice = await join(server, 'alice');
    await settle();
    const access: (Role | null)[] = [];
    alice.live.onAccess((role) => access.push(role));
    alice.store.getState().apply('Move', (d) => moveNodesBy(d, [rect], 7, 0));
    // The owner makes Alice a viewer before her change arrives.
    server.setRole('alice', 'viewer');
    await settle();
    expect(alice.live.role()).toBe('viewer');
    expect(alice.store.getState().readOnly).toBe(true);
    expect(nodeOf(alice, rect)).toMatchObject({ x: 10 });
    expect(alice.store.getState().doc).toEqual(server.doc());

    server.setRole('alice', null);
    await settle();
    expect(alice.live.status()).toBe('denied');
    expect(access).toEqual(['viewer', null]);
    await settle(30_000);
    expect(server.connections).toHaveLength(1);
  });

  it('shares where everyone is, at most every 30 ms, and forgets those who leave', async () => {
    const { doc } = base();
    const server = new FakeServer(doc);
    server.roles.set('alice', 'editor');
    server.roles.set('bob', 'viewer');
    const alice = await join(server, 'alice');
    const bob = await join(server, 'bob');
    await settle();
    const seen: Peer[][] = [];
    bob.live.onPeers((peers) => seen.push(peers));
    expect(bob.live.peers().map((peer) => peer.clientId)).toEqual([alice.live.clientId]);
    expect(alice.live.you()?.role).toBe('editor');

    for (let x = 0; x < 30; x++) {
      alice.live.setPresence({ cursor: { x, y: 0 }, pageId: firstPage(alice.store) });
      await settle(2);
    }
    await settle(100);
    const sent = server.received.filter((entry) => entry.clientId === alice.live.clientId && entry.message.t === 'presence');
    expect(sent.length).toBeGreaterThan(1);
    expect(sent.length).toBeLessThanOrEqual(3);
    expect(bob.live.peers()[0]?.presence?.cursor).toEqual({ x: 29, y: 0 });

    alice.live.close();
    await settle();
    expect(bob.live.peers()).toEqual([]);
    expect(seen.at(-1)).toEqual([]);
  });

  it('passes comment events on', async () => {
    const { doc } = base();
    const server = new FakeServer(doc);
    server.roles.set('alice', 'viewer');
    const alice = await join(server, 'alice');
    await settle();
    const events: CommentEvent[] = [];
    alice.live.onComment((event) => events.push(event));
    server.broadcast({ t: 'comment', event: { kind: 'deleted', threadId: 't1' } });
    await settle();
    expect(events).toEqual([{ kind: 'deleted', threadId: 't1' }]);
  });

  it('sends images added here to the server and fetches the ones others add', async () => {
    const { doc, frame } = base();
    const server = new FakeServer(doc);
    server.roles.set('alice', 'editor');
    server.roles.set('bob', 'editor');
    const aliceImages = new MemoryStorage();
    const bobImages = new MemoryStorage();
    const alice = await join(server, 'alice', { storage: aliceImages });
    const bob = await join(server, 'bob', { storage: bobImages });
    await settle();

    const hash = 'c'.repeat(64);
    const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3]).buffer;
    await aliceImages.saveAsset(hash, { mimeType: 'image/png', bytes });
    alice.store.getState().addAssets({ [hash]: { mimeType: 'image/png', width: 2, height: 2, name: 'dot.png' } });
    alice.store.getState().apply('Place image', (d) => addLayer(d, 'RECTANGLE', frame, { fills: [imagePaint(hash)] }).doc);
    await settle(1000);

    expect(new Uint8Array(server.assets.get(hash)!.bytes)).toEqual(new Uint8Array(bytes));
    expect(server.assets.get(hash)!.mimeType).toBe('image/png');
    expect(bob.store.getState().doc.assets[hash]).toMatchObject({ name: 'dot.png' });
    const fetched = await bobImages.loadAsset(hash);
    expect(fetched?.mimeType).toBe('image/png');
    expect(new Uint8Array(fetched!.bytes)).toEqual(new Uint8Array(bytes));

    // The image cache of a third person loads it from the server, and keeps it.
    const carolImages = new MemoryStorage();
    server.roles.set('carol', 'viewer');
    const load = cloudAssetLoader({ docId: DOC_ID, auth: { token: 'carol', guestToken: null }, storage: carolImages, fetch: server.fetch });
    expect((await load(hash))?.mimeType).toBe('image/png');
    expect(await carolImages.loadAsset(hash)).not.toBeNull();
  });

  it('asks for the whole document when no registers were handed over', async () => {
    const { doc, rect } = base();
    const server = new FakeServer(doc);
    server.roles.set('alice', 'editor');
    const store = createEditorStore(createDocument('Placeholder'));
    const live = openLiveDocument({ docId: DOC_ID, store, auth: { token: 'alice', guestToken: null }, seq: 99, socketUrl: 'ws://test/ws', WebSocketImpl: server.socketClass(), offline: null, fetch: server.fetch });
    opened.push(live);
    await settle();
    const hello = server.received.find((entry) => entry.message.t === 'hello')?.message as Extract<ClientMessage, { t: 'hello' }>;
    expect(hello.since).toBe(0);
    expect(store.getState().doc.nodes[rect]).toBeDefined();
    expect(store.getState().doc).toEqual(server.doc());
    expect(store.getState().undoStack).toHaveLength(0);
  });
});

describe('opening the connection again', () => {
  it('carries on from where a closed connection of the same editor was, without reading the whole document again', async () => {
    const { doc, rect } = base();
    const server = new FakeServer(doc);
    server.roles.set('alice', 'editor');
    server.roles.set('bob', 'editor');
    const alice = await join(server, 'alice');
    const bob = await join(server, 'bob');
    await settle();
    bob.store.getState().apply('Move', (d) => moveNodesBy(d, [rect], 3, 0));
    await settle();
    // Closed and opened again at once, as React does with effects in development; a change is made in between.
    alice.live.close();
    alice.store.getState().apply('Rename', (d) => patchNode(d, rect, { name: 'Between' }));
    const again = openLiveDocument({ docId: DOC_ID, store: alice.store, auth: { token: 'alice', guestToken: null }, seq: 1, socketUrl: 'ws://test/ws', WebSocketImpl: server.socketClass(), offline: null, fetch: server.fetch });
    opened.push(again);
    await settle();
    const hellos = server.received.filter((entry) => entry.message.t === 'hello').map((entry) => entry.message as Extract<ClientMessage, { t: 'hello' }>);
    // The editor's document changed after the close, so the registers handed back no longer fit it: the whole document is read.
    expect(hellos.at(-1)?.since).toBe(0);
    expect(alice.store.getState().doc).toEqual(server.doc());
    expect(nodeOf(alice, rect)).toMatchObject({ x: 13 });

    again.close();
    const third = openLiveDocument({ docId: DOC_ID, store: alice.store, auth: { token: 'alice', guestToken: null }, seq: 1, socketUrl: 'ws://test/ws', WebSocketImpl: server.socketClass(), offline: null, fetch: server.fetch });
    opened.push(third);
    await settle();
    const last = server.received.filter((entry) => entry.message.t === 'hello').at(-1)?.message as Extract<ClientMessage, { t: 'hello' }>;
    expect(last.since).toBeGreaterThan(1);
    alice.store.getState().apply('Rename', (d) => patchNode(d, rect, { name: 'After' }));
    await settle();
    expect(nodeOf(bob, rect)).toMatchObject({ name: 'After', x: 13 });
  });
});

describe('opening a shared document', () => {
  it('reads it from the server, and says why when it may not be opened', async () => {
    const { doc } = base();
    const server = new FakeServer(doc);
    server.roles.set('alice', 'viewer');
    const loaded = await loadSharedDocument(DOC_ID, { token: 'alice', guestToken: null }, { fetch: server.fetch, offline: null });
    expect(loaded.fromCache).toBe(false);
    expect(loaded.seq).toBe(1);
    expect(loaded.doc).toEqual({ ...doc, name: 'Shared' });
    const refused = loadSharedDocument(DOC_ID, { token: 'mallory', guestToken: null }, { fetch: server.fetch, offline: null });
    await expect(refused).rejects.toBeInstanceOf(LiveError);
    await expect(refused).rejects.toMatchObject({ status: 403 });
    server.reachable = false;
    await expect(loadSharedDocument(DOC_ID, { token: 'alice', guestToken: null }, { fetch: server.fetch, offline: null })).rejects.toMatchObject({ status: 0 });
  });

  it('shows what this device keeps only to the person who kept it, on a computer several people use', async () => {
    const { doc } = base();
    const server = new FakeServer(doc);
    server.roles.set('alice', 'editor');
    server.roles.set('sam', 'editor');
    const offline = new OfflineStore(new IDBFactory(), 'evora-collab-owner-test');
    // Alice opens it while online: this device keeps her copy.
    await loadSharedDocument(DOC_ID, { token: 'alice', guestToken: null }, { fetch: server.fetch, offline });
    await settle();
    expect((await offline.load(DOC_ID))?.snapshot?.owner).toBe(ownerKey({ token: 'alice', guestToken: null }));
    server.reachable = false;
    // Offline, Alice still gets her copy; Sam, or a guest, on the same computer does not.
    await expect(loadSharedDocument(DOC_ID, { token: 'alice', guestToken: null }, { fetch: server.fetch, offline })).resolves.toMatchObject({ fromCache: true });
    await expect(loadSharedDocument(DOC_ID, { token: 'sam', guestToken: null }, { fetch: server.fetch, offline })).rejects.toMatchObject({ status: 0 });
    await expect(loadSharedDocument(DOC_ID, { token: null, guestToken: 'guest-1' }, { fetch: server.fetch, offline })).rejects.toMatchObject({ status: 0 });
    await expect(loadSharedDocument(DOC_ID, { token: null, guestToken: null }, { fetch: server.fetch, offline })).rejects.toMatchObject({ status: 0 });
  });

  it('tells sessions apart by a fingerprint of their token', () => {
    expect(ownerKey({ token: 'a', guestToken: null })).toMatch(/^[0-9a-f]{16}$/);
    expect(ownerKey({ token: 'a', guestToken: null })).toBe(ownerKey({ token: 'a', guestToken: null }));
    expect(ownerKey({ token: 'a', guestToken: null })).not.toBe(ownerKey({ token: 'b', guestToken: null }));
    expect(ownerKey({ token: null, guestToken: 'g' })).not.toBe(ownerKey({ token: null, guestToken: 'h' }));
    expect(ownerKey({ token: null, guestToken: null })).toBeNull();
  });

  it('opens from this device when the server cannot be reached, with the changes made offline, and sends them later', async () => {
    const { doc, rect } = base();
    const server = new FakeServer(doc);
    server.roles.set('alice', 'editor');
    const offline = new OfflineStore(new IDBFactory(), 'evora-collab-test');
    const first = await join(server, 'alice', { offline });
    await settle();
    // The connection goes; a change is made; the page is closed.
    server.accepting = false;
    server.drop('alice');
    await settle(50);
    first.store.getState().apply('Rename', (d) => patchNode(d, rect, { name: 'Made offline' }));
    await settle(200);
    first.live.close();
    opened.splice(opened.indexOf(first.live), 1);
    // Let IndexedDB finish its writes (it keeps real time).
    await vi.waitFor(async () => expect((await offline.loadPending(DOC_ID)).length).toBeGreaterThan(0), { timeout: 2000 });

    // Reopened with no server at all.
    server.reachable = false;
    const again = await loadSharedDocument(DOC_ID, { token: 'alice', guestToken: null }, { fetch: server.fetch, offline });
    expect(again.fromCache).toBe(true);
    expect(again.doc.nodes[rect]?.name).toBe('Made offline');
    expect(server.doc().nodes[rect]?.name).toBe('Box');

    // The server is back: the change is sent.
    server.reachable = true;
    server.accepting = true;
    const store = createEditorStore(again.doc);
    const live = openLiveDocument({ docId: DOC_ID, store, auth: { token: 'alice', guestToken: null }, seq: again.seq, socketUrl: 'ws://test/ws', WebSocketImpl: server.socketClass(), offline, fetch: server.fetch });
    opened.push(live);
    await settle(1000);
    expect(live.pendingCount()).toBe(0);
    expect(server.doc().nodes[rect]?.name).toBe('Made offline');
    expect(store.getState().doc).toEqual(server.doc());
    expect(getChildIds(store.getState().doc, null)).toHaveLength(1);
  });
});
