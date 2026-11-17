/**
 * The live connection: one room per document, holding the WebSocket
 * connections of everyone who has it open.
 *
 * A connection starts with `hello` (who, which document, the last sequence
 * number already held) and is answered with `welcome`. After that, changes
 * (`ops`) from editors are merged into the document by their clocks, kept,
 * acknowledged and passed on to the others in the room; presence is passed
 * on and never kept. The HTTP API tells the hub when comments or who may do
 * what change, and the hub tells the rooms.
 *
 * A document that may not be changed now (a merged branch, `store.lockReason`)
 * is joined as a viewer whatever one's role (so the app shows it read-only),
 * and changes sent to it are rejected with the reason. Someone who could open
 * a file before it went to the trash is refused with "This file is in the
 * trash" (code `not-found`, close 4404); anyone else with "no access".
 */
import type { Store, Identity, DocRow, UserRow } from './store.ts';
import { DocumentLockedError, IN_TRASH_MESSAGE, invalidRegisters, personId } from './store.ts';
import { hashToken } from './auth.ts';
import { CLOSE_GOING_AWAY, CLOSE_POLICY, type WebSocketConnection } from './websocket.ts';
import {
  SOCKET_CLOSE,
  canEdit,
  type ClientMessage,
  type CommentEvent,
  type LinkAccess,
  type Peer,
  type Presence,
  type Register,
  type Role,
  type ServerMessage,
  type StoredRegister,
  type UserRef,
} from '../src/collab/protocol.ts';

/** Close codes for connections the server ends itself (the 4000s are for applications, RFC 6455 §7.4.2). */
export const CLOSE_UNAUTHORIZED = SOCKET_CLOSE.unauthorized;
export const CLOSE_FORBIDDEN = SOCKET_CLOSE.forbidden;
export const CLOSE_NOT_FOUND = SOCKET_CLOSE.notFound;
export const CLOSE_BAD_REQUEST = SOCKET_CLOSE.badRequest;
/** The same client ID connected again to the same document: the older connection is closed. */
export const CLOSE_REPLACED = SOCKET_CLOSE.replaced;

/** How long a connection may stay without saying hello. */
const HELLO_TIMEOUT_MS = 30_000;
/** The largest message a connection may send before its hello is accepted (a hello is a few hundred bytes). */
export const MAX_HELLO_BYTES = 64 * 1024;
/** How many messages one connection may send in MESSAGE_WINDOW_MS; more closes it (1008), against floods. */
export const MAX_MESSAGES_PER_WINDOW = 20_000;
export const MESSAGE_WINDOW_MS = 10_000;
/** The longest layer ID kept in presence (a selection), so that presence passed on to everyone stays small. */
const MAX_PRESENCE_ID = 200;

interface Client {
  conn: WebSocketConnection;
  docId: string | null;
  clientId: string;
  identity: Identity;
  ref: UserRef;
  role: Role | null;
  linkAccess: LinkAccess;
  presence: Presence | null;
  helloTimer: ReturnType<typeof setTimeout> | null;
  /** The largest message this connection may send once it has said hello. */
  maxMessageBytes: number;
  /** Messages counted in the current window, against floods. */
  window: { start: number; count: number };
}

export interface HubOptions {
  /** Ping every this many milliseconds; a connection that sends nothing for twice as long is dropped. */
  heartbeatMs: number;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Checks presence sent by a client and returns it in the protocol's shape, or null when it is not valid. */
export function cleanPresence(value: unknown): Presence | null {
  if (!value || typeof value !== 'object') return null;
  const p = value as Record<string, unknown>;
  const pageId = p.pageId === null || p.pageId === undefined ? null : typeof p.pageId === 'string' ? p.pageId.slice(0, 200) : undefined;
  if (pageId === undefined) return null;
  let cursor: Presence['cursor'] = null;
  if (p.cursor !== null && p.cursor !== undefined) {
    const c = p.cursor as Record<string, unknown>;
    if (!isFiniteNumber(c.x) || !isFiniteNumber(c.y)) return null;
    cursor = { x: c.x, y: c.y };
  }
  const selection = Array.isArray(p.selection) ? p.selection.filter((id): id is string => typeof id === 'string' && id.length <= MAX_PRESENCE_ID).slice(0, 10_000) : [];
  let viewport: Presence['viewport'] = null;
  if (p.viewport !== null && p.viewport !== undefined) {
    const v = p.viewport as Record<string, unknown>;
    if (![v.x, v.y, v.zoom, v.width, v.height].every(isFiniteNumber)) return null;
    viewport = { x: v.x as number, y: v.y as number, zoom: v.zoom as number, width: v.width as number, height: v.height as number };
  }
  return { pageId, cursor, selection, viewport };
}

export class Hub {
  private readonly store: Store;
  private readonly options: HubOptions;
  /** Every connection, whether it has said hello or not. */
  private clients = new Set<Client>();
  /** The rooms: document ID → client ID → client. */
  private rooms = new Map<string, Map<string, Client>>();
  private heartbeat: ReturnType<typeof setInterval>;

  constructor(store: Store, options: HubOptions) {
    this.store = store;
    this.options = options;
    this.heartbeat = setInterval(() => this.beat(), options.heartbeatMs);
    this.heartbeat.unref();
  }

  /** Takes a new WebSocket connection. */
  attach(conn: WebSocketConnection): void {
    const client: Client = {
      conn,
      docId: null,
      clientId: '',
      identity: { kind: 'anonymous' },
      ref: { id: '', name: '', color: '' },
      role: null,
      linkAccess: 'none',
      presence: null,
      helloTimer: null,
      maxMessageBytes: conn.maxMessageBytes,
      window: { start: Date.now(), count: 0 },
    };
    // Until it says who it is, a connection may send only small messages: nobody unknown can make the server hold megabytes.
    conn.maxMessageBytes = Math.min(conn.maxMessageBytes, MAX_HELLO_BYTES);
    client.helloTimer = setTimeout(() => {
      if (!client.docId) this.refuse(client, 'bad-request', 'No hello was sent', CLOSE_BAD_REQUEST);
    }, HELLO_TIMEOUT_MS);
    this.clients.add(client);
    conn.onMessage = (data, binary) => this.receive(client, data, binary);
    conn.onClose = () => this.leave(client);
  }

  /** The number of connections in a document's room. */
  roomSize(docId: string): number {
    return this.rooms.get(docId)?.size ?? 0;
  }

  /** Closes every connection (the server is stopping). */
  closeAll(): void {
    clearInterval(this.heartbeat);
    for (const client of [...this.clients]) client.conn.close(CLOSE_GOING_AWAY, 'The server is stopping');
  }

  // -------------------------------------------------------------- sending

  private send(client: Client, message: ServerMessage): void {
    client.conn.send(JSON.stringify(message));
  }

  /** Sends to everyone in a room, except one client when `except` is given. */
  private broadcast(docId: string, message: ServerMessage, except?: Client): void {
    const room = this.rooms.get(docId);
    if (!room) return;
    const text = JSON.stringify(message);
    for (const client of room.values()) if (client !== except) client.conn.send(text);
  }

  private refuse(client: Client, code: 'unauthorized' | 'forbidden' | 'not-found' | 'bad-request', message: string, closeCode: number): void {
    this.send(client, { t: 'error', code, message });
    client.conn.close(closeCode, message);
  }

  /**
   * What someone may do in a document over the live connection: their role,
   * but no more than a viewer's while the document may not be changed (a
   * merged branch), so the app shows it read-only and sends no changes.
   */
  private effectiveRole(doc: DocRow, identity: Identity): Role | null {
    const role = this.store.roleOn(doc, identity);
    return role && canEdit(role) && this.store.lockReason(doc.id) ? 'viewer' : role;
  }

  private peer(client: Client): Peer {
    return { clientId: client.clientId, user: client.ref, role: client.role as Role, presence: client.presence };
  }

  // -------------------------------------------------------------- receiving

  private receive(client: Client, data: string | Buffer, binary: boolean): void {
    const nowMs = Date.now();
    if (nowMs - client.window.start >= MESSAGE_WINDOW_MS) client.window = { start: nowMs, count: 0 };
    if (++client.window.count > MAX_MESSAGES_PER_WINDOW) {
      if (client.window.count === MAX_MESSAGES_PER_WINDOW + 1) {
        this.send(client, { t: 'error', code: 'bad-request', message: 'Too many messages: slow down' });
        client.conn.close(CLOSE_POLICY, 'Too many messages');
      }
      return;
    }
    if (binary) {
      this.send(client, { t: 'error', code: 'bad-request', message: 'Messages are JSON text' });
      return;
    }
    let message: ClientMessage;
    try {
      message = JSON.parse(data as string) as ClientMessage;
    } catch {
      this.send(client, { t: 'error', code: 'bad-request', message: 'A message is not valid JSON' });
      return;
    }
    if (!message || typeof message !== 'object' || typeof (message as { t?: unknown }).t !== 'string') {
      this.send(client, { t: 'error', code: 'bad-request', message: 'A message needs a type (t)' });
      return;
    }
    if (message.t === 'ping') {
      this.send(client, { t: 'pong' });
      return;
    }
    if (message.t === 'hello') {
      if (client.docId) this.send(client, { t: 'error', code: 'bad-request', message: 'Already connected to a document' });
      else this.hello(client, message);
      return;
    }
    if (!client.docId) {
      this.refuse(client, 'bad-request', 'The first message must be hello', CLOSE_BAD_REQUEST);
      return;
    }
    if (message.t === 'ops') this.ops(client, message);
    else if (message.t === 'presence') this.presence(client, message.presence);
    else this.send(client, { t: 'error', code: 'bad-request', message: `Unknown message type ${(message as { t: string }).t}` });
  }

  private identify(token: unknown, guestToken: unknown): Identity | null {
    if (typeof token === 'string' && token) {
      const hash = hashToken(token);
      const user = this.store.sessionUser(hash);
      return user ? { kind: 'user', user, sessionHash: hash } : null;
    }
    if (typeof guestToken === 'string' && guestToken) {
      const guest = this.store.guestByToken(hashToken(guestToken));
      return guest ? { kind: 'guest', guest } : null;
    }
    return null;
  }

  private hello(client: Client, message: Extract<ClientMessage, { t: 'hello' }>): void {
    const { docId, since, clientId } = message;
    if (typeof docId !== 'string' || typeof clientId !== 'string' || !clientId || clientId.length > 64 || !/^[A-Za-z0-9_-]+$/.test(clientId)) {
      this.refuse(client, 'bad-request', 'hello needs a docId and a clientId of letters and digits', CLOSE_BAD_REQUEST);
      return;
    }
    const identity = this.identify(message.token, message.guestToken);
    if (!identity) {
      this.refuse(client, 'unauthorized', 'Sign in, or join as a guest, to open a shared document', CLOSE_UNAUTHORIZED);
      return;
    }
    const doc = this.store.docById(docId);
    if (!doc) {
      this.refuse(client, 'not-found', 'There is no such document', CLOSE_NOT_FOUND);
      return;
    }
    const role = this.effectiveRole(doc, identity);
    if (!role) {
      if (this.store.trashedFor(doc, identity)) this.refuse(client, 'not-found', IN_TRASH_MESSAGE, CLOSE_NOT_FOUND);
      else this.refuse(client, 'forbidden', 'You do not have access to this document', CLOSE_FORBIDDEN);
      return;
    }
    let room = this.rooms.get(doc.id);
    // The same client coming back before its old connection was noticed as gone: the new one takes its place.
    // Client IDs are seen by everyone in the room, so only the same person may take one over.
    const previous = room?.get(clientId);
    if (previous && personId(previous.identity) !== personId(identity)) {
      this.refuse(client, 'bad-request', 'That client ID is in use in this document', CLOSE_BAD_REQUEST);
      return;
    }
    if (client.helloTimer) clearTimeout(client.helloTimer);
    client.helloTimer = null;
    client.conn.maxMessageBytes = client.maxMessageBytes;
    client.docId = doc.id;
    client.clientId = clientId;
    client.identity = identity;
    client.ref = this.store.identityRef(identity) as UserRef;
    client.role = role;
    client.linkAccess = doc.link_access;

    if (!room) {
      room = new Map();
      this.rooms.set(doc.id, room);
    }
    if (previous) {
      previous.docId = null;
      room.delete(clientId);
      this.clients.delete(previous);
      previous.conn.close(CLOSE_REPLACED, 'Connected again');
    }
    const peers = [...room.values()].map((other) => this.peer(other));
    room.set(clientId, client);

    // Everything after `since`; everything when the client has nothing, or a number this document never reached.
    const requested = typeof since === 'number' && Number.isFinite(since) ? Math.floor(since) : 0;
    const full = requested <= 0 || requested > doc.seq;
    const registers = this.store.registersSince(doc.id, full ? 0 : requested);
    this.send(client, { t: 'welcome', seq: doc.seq, full, registers, you: this.peer(client), peers, doc: this.store.docDto(doc, role) });
    this.broadcast(doc.id, { t: 'presence', peer: this.peer(client) }, client);
  }

  private ops(client: Client, message: Extract<ClientMessage, { t: 'ops' }>): void {
    const id = typeof message.id === 'string' ? message.id : '';
    if (!canEdit(client.role)) {
      const reason = this.store.lockReason(client.docId as string) ?? 'You can view and comment on this document, not change it';
      this.send(client, { t: 'rejected', id, reason });
      return;
    }
    const invalid = invalidRegisters(message.ops, Date.now());
    if (invalid) {
      this.send(client, { t: 'rejected', id, reason: invalid });
      return;
    }
    const docId = client.docId as string;
    let result: { seq: number; kept: StoredRegister[] };
    try {
      result = this.store.applyRegisters(docId, message.ops as Register[]);
    } catch (error) {
      if (error instanceof DocumentLockedError) {
        // Locked since this connection was told its role: it is read-only from now on.
        this.send(client, { t: 'rejected', id, reason: error.message });
        this.recheck([docId]);
      } else this.send(client, { t: 'rejected', id, reason: 'The document no longer exists' });
      return;
    }
    this.send(client, { t: 'ack', id, seq: result.seq });
    if (result.kept.length > 0) this.broadcast(docId, { t: 'ops', seq: result.seq, ops: result.kept, from: client.clientId }, client);
  }

  private presence(client: Client, value: unknown): void {
    const presence = cleanPresence(value);
    if (!presence) {
      this.send(client, { t: 'error', code: 'bad-request', message: 'Presence is not valid' });
      return;
    }
    client.presence = presence;
    this.broadcast(client.docId as string, { t: 'presence', peer: this.peer(client) }, client);
  }

  private leave(client: Client): void {
    if (client.helloTimer) clearTimeout(client.helloTimer);
    this.clients.delete(client);
    const docId = client.docId;
    if (!docId) return;
    client.docId = null;
    const room = this.rooms.get(docId);
    if (!room || room.get(client.clientId) !== client) return;
    room.delete(client.clientId);
    if (room.size === 0) this.rooms.delete(docId);
    else this.broadcast(docId, { t: 'leave', clientId: client.clientId });
  }

  private beat(): void {
    const deadline = Date.now() - this.options.heartbeatMs * 2;
    for (const client of [...this.clients]) {
      if (client.conn.state !== 'open') continue;
      if (client.conn.lastSeen < deadline) client.conn.terminate();
      else client.conn.ping();
    }
  }

  // -------------------------------------------------------------- told by the HTTP API

  /** Passes changes the server made itself (a document renamed over HTTP) to everyone in the room. */
  serverOps(docId: string, seq: number, ops: StoredRegister[]): void {
    if (ops.length > 0) this.broadcast(docId, { t: 'ops', seq, ops, from: 'server' });
  }

  /** Passes a change to a document's comments to everyone in its room. */
  comment(docId: string, event: CommentEvent): void {
    this.broadcast(docId, { t: 'comment', event });
  }

  /**
   * Works out again what everyone connected to these documents may do, after
   * a change to members, roles or link access (or a document being removed):
   * whoever's role or link access changed is told with `access`, and whoever
   * may no longer open the document is disconnected.
   */
  recheck(docIds: Iterable<string>): void {
    for (const docId of new Set(docIds)) {
      const room = this.rooms.get(docId);
      if (!room) continue;
      const doc: DocRow | undefined = this.store.docById(docId);
      for (const client of [...room.values()]) {
        const role = doc ? this.effectiveRole(doc, client.identity) : null;
        const linkAccess: LinkAccess = doc ? doc.link_access : 'none';
        if (role === client.role && linkAccess === client.linkAccess) continue;
        const roleChanged = role !== client.role;
        client.role = role;
        client.linkAccess = linkAccess;
        this.send(client, { t: 'access', role, linkAccess });
        if (role === null) {
          this.leave(client);
          client.conn.close(CLOSE_FORBIDDEN, 'Access removed');
        } else if (roleChanged) this.broadcast(docId, { t: 'presence', peer: this.peer(client) }, client);
      }
    }
  }

  /** Disconnects the connections made with a session that has ended (signed out). */
  endSession(sessionHash: string): void {
    for (const client of [...this.clients]) {
      if (client.identity.kind === 'user' && client.identity.sessionHash === sessionHash) {
        this.send(client, { t: 'error', code: 'unauthorized', message: 'Signed out' });
        this.leave(client);
        client.conn.close(CLOSE_UNAUTHORIZED, 'Signed out');
      }
    }
  }

  /** Updates the name and colour shown for a person in every room (they changed them). */
  renamePerson(user: UserRow): void {
    for (const client of this.clients) {
      if (client.identity.kind !== 'user' || client.identity.user.id !== user.id || !client.docId) continue;
      client.identity = { ...client.identity, user };
      client.ref = { id: user.id, name: user.name, color: user.color };
      this.broadcast(client.docId, { t: 'presence', peer: this.peer(client) }, client);
    }
  }
}
