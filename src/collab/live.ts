import { getAncestorIds, type Document, type NodeId } from '../core';
import type { DocumentStorage, StoredAsset } from '../persistence/storage';
import type { EditorStore } from '../state/editorStore';
import { configuredSocketUrl } from './endpoint';
import { defaultOfflineStore, type OfflineStore } from './offline';
import {
  API_BASE,
  canEdit,
  DEFAULT_SERVER_PORT,
  EXISTS,
  makeClock,
  newClientId,
  observe,
  parseKey,
  SOCKET_PATH,
  tick,
  type ClientMessage,
  type ClockState,
  type CommentEvent,
  type DocInfo,
  type LinkAccess,
  type Peer,
  type Presence,
  type Register,
  type Role,
  type ServerMessage,
} from './protocol';
import { applyRegisters, buildDocument, diffForSync, isRegular, opsFromPatch, RegisterMap, type Fix, type SyncPatch } from './registers';

/**
 * The live connection to a shared document: it keeps the editor's document
 * and everyone else's in step through the collaboration server.
 *
 * Every change made in the editor becomes registers (see registers.ts), which
 * are kept on this device until the server acknowledges them and sent in
 * small batches; changes from others are merged into the registers and shown
 * in the editor without entering its undo history. Without a connection the
 * changes wait (also across a reload, in the OfflineStore) and are sent when
 * it is back; the connection is tried again and again, at growing intervals.
 * Someone who may only view never sends a change. Presence (pointer,
 * selection, view) and comment events travel on the same connection.
 */

/** What a request carries to say who is asking: a session token, or failing that a guest's token. */
export interface LiveAuth {
  token: string | null;
  guestToken: string | null;
}

/**
 * A fingerprint of who is signed in (an account's or a guest's session token), stored with what this device keeps
 * of a shared document so that another person on the same computer is never shown it offline, and never sends its
 * waiting changes as theirs. Not secret-keeping: the token itself is kept on this device anyway; it only tells sessions apart.
 */
export function ownerKey(auth: LiveAuth): string | null {
  const token = auth.token ?? auth.guestToken;
  if (!token) return null;
  // FNV-1a, twice with different starting values: 64 bits, plenty to tell sessions apart.
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < token.length; i++) {
    const c = token.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x01000193) ^ (b >>> 13);
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}

export type LiveStatus = 'connecting' | 'online' | 'offline' | 'denied';

/** A failure to open a shared document, with the server's HTTP status (0 when it could not be reached). */
export class LiveError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'LiveError';
    this.status = status;
  }
}

export interface LiveDeps {
  fetch?: typeof fetch;
  /** Where the document is kept on this device; null keeps nothing. The browser's own by default. */
  offline?: OfflineStore | null;
  /** The HTTP API's base, '/api' by default (the same origin as the page). */
  apiBase?: string;
}

function authHeaders(auth: LiveAuth, extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  if (auth.token) headers.Authorization = `Bearer ${auth.token}`;
  else if (auth.guestToken) headers['X-Evora-Guest'] = auth.guestToken;
  return headers;
}

async function errorText(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === 'string') return body.error;
  } catch {
    // Not JSON: the status says enough.
  }
  return `The server answered ${response.status}.`;
}

function documentPath(apiBase: string, docId: string): string {
  return `${apiBase}/documents/${encodeURIComponent(docId)}`;
}

/** What `loadSharedDocument` read, handed to `openLiveDocument` so the registers are not fetched or built twice. */
interface HandOver {
  seq: number;
  map: RegisterMap;
  irregular: boolean;
  role: Role | null;
  /** The document the registers are of: they are used only for an editor holding this very document. */
  doc: Document;
}
/**
 * By document ID. A connection that closes hands its registers back, so one
 * opened again for the same editor (React opens, closes and reopens effects
 * in development) carries on without reading the whole document again.
 */
const handOvers = new Map<string, HandOver>();

/** Keeps the registers of one document only: a large document's registers are not held on to after another is opened. */
function handOver(docId: string, value: HandOver): void {
  handOvers.clear();
  handOvers.set(docId, value);
}

/**
 * Reads a shared document: from the server (GET /api/documents/:id/registers),
 * or, when the server cannot be reached, from what this device last kept of
 * it. Changes made here and not yet acknowledged (made offline before the page
 * was closed) are part of what is shown. Rejects with a `LiveError` whose
 * status is the server's when it refuses (401, 403, 404), and 0 when it cannot
 * be reached and nothing is kept.
 */
export async function loadSharedDocument(docId: string, auth: LiveAuth, deps: LiveDeps = {}): Promise<{ doc: Document; seq: number; fromCache: boolean }> {
  const fetchFn = deps.fetch ?? globalThis.fetch.bind(globalThis);
  const offline = deps.offline === undefined ? defaultOfflineStore() : deps.offline;
  const apiBase = deps.apiBase ?? API_BASE;

  let remote: { seq: number; registers: Register[] } | null = null;
  try {
    const response = await fetchFn(`${documentPath(apiBase, docId)}/registers`, { headers: authHeaders(auth) });
    if (response.ok) remote = (await response.json()) as { seq: number; registers: Register[] };
    else if (response.status < 500) throw new LiveError(response.status, await errorText(response));
  } catch (error) {
    // Refused: what is kept here must not be shown either. Anything else means the server could not be reached.
    if (error instanceof LiveError) throw error;
  }

  const stored = offline ? await offline.load(docId).catch(() => null) : null;
  // Only this person's own copy: someone else's, on a shared computer, is neither shown nor sent on.
  const kept = stored?.snapshot && stored.snapshot.owner && stored.snapshot.owner === ownerKey(auth) ? stored : null;
  const map = new RegisterMap();
  let seq: number;
  if (remote && Array.isArray(remote.registers)) {
    map.merge(remote.registers);
    seq = typeof remote.seq === 'number' ? remote.seq : 0;
  } else if (kept?.snapshot) {
    map.merge(kept.snapshot.registers);
    seq = kept.snapshot.seq;
  } else {
    throw new LiveError(0, 'The collaboration server cannot be reached, and this file has not been opened on this device before.');
  }
  for (const register of kept?.pending ?? []) map.setLocal(register);

  const built = buildDocument(map, { id: docId, name: 'Untitled' });
  const role = kept?.snapshot?.role ?? null;
  handOver(docId, { seq, map, irregular: built.irregular, role, doc: built.doc });
  if (remote && offline) void offline.save(docId, { seq, registers: map.confirmedRegisters(), role, owner: ownerKey(auth) }, map.pendingRegisters()).catch(() => undefined);
  return { doc: built.doc, seq, fromCache: remote === null };
}

// ------------------------------------------------------------------ images

const downloads = new Map<string, Promise<StoredAsset | null>>();

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetches an image's bytes from the server and keeps them on this device.
 * Someone who has just added an image may still be sending it, so a missing
 * image is asked for again a few times (over about eight seconds).
 */
export function downloadAsset(options: { docId: string; hash: string; auth: LiveAuth; storage: DocumentStorage; fetch?: typeof fetch; apiBase?: string }): Promise<StoredAsset | null> {
  const key = `${options.docId}/${options.hash}`;
  let running = downloads.get(key);
  if (!running) {
    const fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
    const url = `${documentPath(options.apiBase ?? API_BASE, options.docId)}/assets/${encodeURIComponent(options.hash)}`;
    running = (async () => {
      for (const delay of [0, 500, 1000, 2000, 4000]) {
        if (delay > 0) await wait(delay);
        try {
          const response = await fetchFn(url, { headers: authHeaders(options.auth) });
          if (response.ok) {
            const asset: StoredAsset = { mimeType: response.headers.get('Content-Type') ?? 'application/octet-stream', bytes: await response.arrayBuffer() };
            await options.storage.saveAsset(options.hash, asset);
            return asset;
          }
          if (response.status === 401 || response.status === 403) return null;
        } catch {
          // Not reachable just now: tried again.
        }
      }
      return null;
    })().finally(() => downloads.delete(key));
    downloads.set(key, running);
  }
  return running;
}

/** Sends an image's bytes to the server (editors). Resolves to whether the server kept them. */
export async function uploadAsset(options: { docId: string; hash: string; asset: StoredAsset; auth: LiveAuth; fetch?: typeof fetch; apiBase?: string }): Promise<boolean> {
  const fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
  try {
    const response = await fetchFn(`${documentPath(options.apiBase ?? API_BASE, options.docId)}/assets/${encodeURIComponent(options.hash)}`, {
      method: 'PUT',
      headers: authHeaders(options.auth, { 'Content-Type': options.asset.mimeType }),
      body: options.asset.bytes,
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Where the editor's image cache gets a shared document's images: from this
 * device when it has them, else from the server (kept here afterwards).
 * Pass it to `new ImageCache(...)`.
 */
export function cloudAssetLoader(options: { docId: string; auth: LiveAuth; storage: DocumentStorage; fetch?: typeof fetch; apiBase?: string }): (hash: string) => Promise<StoredAsset | null> {
  return async (hash) => {
    const local = await options.storage.loadAsset(hash).catch(() => null);
    return local ?? downloadAsset({ ...options, hash });
  };
}

// ------------------------------------------------------------------ the live connection

export interface LiveOptions {
  docId: string;
  store: EditorStore;
  auth: LiveAuth;
  /** The server's sequence number the document was read at (from `loadSharedDocument`). */
  seq: number;
  /** ws(s)://<page's host>/ws by default. */
  socketUrl?: string;
  /** Where the document and the changes waiting are kept on this device; null keeps nothing. The browser's own by default. */
  offline?: OfflineStore | null;
  WebSocketImpl?: typeof WebSocket;
  /** The time, for clocks (Date.now by default). */
  now?: () => number;
  /**
   * The registers the document was built from. Not needed after
   * `loadSharedDocument`, which hands them over; without either, the whole
   * document is asked for when connecting.
   */
  registers?: Iterable<Register>;
  /** What this person may do, when known before the server says. */
  role?: Role | null;
  /**
   * Where images are kept on this device. When given, images added here are
   * sent to the server and images others add are fetched as soon as they
   * appear; without it the connection leaves images to the interface.
   */
  storage?: DocumentStorage | null;
  fetch?: typeof fetch;
  apiBase?: string;
  /** This connection's client ID (a new one by default). */
  clientId?: string;
  /** Milliseconds between batches of changes sent (50 by default). */
  batchDelay?: number;
  /** Where the browser says it has lost and regained the network (its `offline` and `online` events): the window by default. */
  network?: EventTarget | null;
}

export interface LiveDocument {
  readonly clientId: string;
  status(): LiveStatus;
  onStatus(callback: (status: LiveStatus) => void): () => void;
  /** Who else has the document open, without you. */
  peers(): Peer[];
  onPeers(callback: (peers: Peer[]) => void): () => void;
  you(): Peer | null;
  /** What you may do: null until the server has said (or when you may no longer open it). */
  role(): Role | null;
  onAccess(callback: (role: Role | null, linkAccess: LinkAccess) => void): () => void;
  /** The document's details as the server last gave them. */
  info(): DocInfo | null;
  /** Where your pointer, selection and view are. Sent at most every 30 ms, while online. */
  setPresence(presence: Partial<Presence>): void;
  onComment(callback: (event: CommentEvent) => void): () => void;
  /** Changes made here that the server has not acknowledged yet. */
  pendingCount(): number;
  onPending(callback: (count: number) => void): () => void;
  /** The server's sequence number the document is up to. */
  seq(): number;
  /**
   * Sends these images, now on this device, to the server's copy of the
   * document (editors only; only images the document lists). An image is sent
   * when it is added to the document, but only if this device has its bytes
   * then: one that arrives later (a team library's image that could not be
   * downloaded when the library was added) is sent with this.
   */
  uploadAssets(hashes: readonly string[]): void;
  close(): void;
}

const MAX_BATCH = 2000;
const PRESENCE_INTERVAL = 30;
const PING_INTERVAL = 25_000;
const SNAPSHOT_DELAY = 5000;
/** A connection that has heard nothing for this long (pings are answered) is taken to be dead, and made again. */
const SILENCE_LIMIT = 60_000;
const PENDING_DELAY = 100;

function defaultSocketUrl(): string {
  // The desktop app names its server (src/collab/endpoint.ts); a browser uses its own origin.
  const configured = configuredSocketUrl();
  if (configured !== null) return configured;
  if (typeof location === 'undefined') return `ws://localhost:${DEFAULT_SERVER_PORT}${SOCKET_PATH}`;
  return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${SOCKET_PATH}`;
}

const EMPTY_PRESENCE: Presence = { pageId: null, cursor: null, selection: [], viewport: null };

function isStructural(patch: SyncPatch): boolean {
  for (const id in patch.nodes) {
    const change = patch.nodes[id];
    if (!change || change.before === null || change.after === null) return true;
    if ('parentId' in change.after || 'order' in change.after) return true;
  }
  return false;
}

function listeners<T extends unknown[]>() {
  const set = new Set<(...args: T) => void>();
  return {
    add(callback: (...args: T) => void): () => void {
      set.add(callback);
      return () => set.delete(callback);
    },
    emit(...args: T): void {
      for (const callback of [...set]) {
        try {
          callback(...args);
        } catch (error) {
          console.error(error);
        }
      }
    },
  };
}

/** Opens the live connection for a shared document whose editor is `store` (see the top of this file). */
export function openLiveDocument(options: LiveOptions): LiveDocument {
  const { docId, store, auth } = options;
  const clientId = options.clientId ?? newClientId();
  const now = options.now ?? Date.now;
  const WebSocketImpl = options.WebSocketImpl ?? globalThis.WebSocket;
  const socketUrl = options.socketUrl ?? defaultSocketUrl();
  const offline = options.offline === undefined ? defaultOfflineStore() : options.offline;
  const storage = options.storage ?? null;
  const fetchFn = options.fetch;
  const apiBase = options.apiBase ?? API_BASE;
  const batchDelay = options.batchDelay ?? 50;

  // The registers, as handed over by loadSharedDocument, given, or (failing both) to be read whole when connecting.
  const handed = handOvers.get(docId);
  let map: RegisterMap;
  let lastSeq: number;
  let irregular: boolean;
  let role: Role | null = options.role ?? null;
  if (options.registers) {
    map = new RegisterMap(options.registers);
    lastSeq = options.seq;
    irregular = !isRegular(store.getState().doc, map);
  } else if (handed && handed.doc === store.getState().doc && handed.seq >= options.seq) {
    handOvers.delete(docId);
    map = handed.map;
    lastSeq = handed.seq;
    irregular = handed.irregular;
    role = options.role ?? handed.role;
  } else {
    map = new RegisterMap();
    lastSeq = 0;
    irregular = true;
  }
  let roleKnown = options.role !== undefined && options.role !== null;
  const clock: ClockState = { last: makeClock(0, 0, clientId), clientId };
  if (map.latestClock) observe(clock, map.latestClock);

  let status: LiveStatus = 'connecting';
  let closed = false;
  let socket: WebSocket | null = null;
  let attempt = 0;
  let you: Peer | null = null;
  let info: DocInfo | null = null;
  let linkAccess: LinkAccess = 'none';
  const peers = new Map<string, Peer>();
  let presence: Presence | null = null;
  let lastPresenceAt = -Infinity;
  let lastHeard = Date.now();
  /** Changes not yet sent, by key: only the latest change to a register is sent. */
  const queue = new Map<string, Register>();
  /** Batches sent and not yet acknowledged, by ID. */
  const inflight = new Map<string, Register[]>();
  let batches = 0;
  /** Acknowledged since the snapshot kept on this device was written: kept with the changes waiting until it is written again. */
  let ackedSinceSnapshot: Register[] = [];
  const uploads = new Set<string>();
  let uploading = false;
  const timers = { reconnect: null as ReturnType<typeof setTimeout> | null, flush: null as ReturnType<typeof setTimeout> | null, presence: null as ReturnType<typeof setTimeout> | null, ping: null as ReturnType<typeof setInterval> | null, pending: null as ReturnType<typeof setTimeout> | null, snapshot: null as ReturnType<typeof setTimeout> | null };
  let lastPending = map.pendingCount;

  const statusListeners = listeners<[LiveStatus]>();
  const peerListeners = listeners<[Peer[]]>();
  const accessListeners = listeners<[Role | null, LinkAccess]>();
  const commentListeners = listeners<[CommentEvent]>();
  const pendingListeners = listeners<[number]>();

  const canEditNow = (): boolean => (roleKnown ? canEdit(role) : role === null || canEdit(role));
  const online = (): boolean => status === 'online' && socket !== null;

  const setStatus = (next: LiveStatus): void => {
    if (status === next) return;
    status = next;
    statusListeners.emit(next);
  };
  const emitPeers = (): void => peerListeners.emit([...peers.values()]);
  const emitPending = (): void => {
    const count = map.pendingCount;
    if (count === lastPending) return;
    lastPending = count;
    pendingListeners.emit(count);
  };

  const send = (message: ClientMessage): boolean => {
    if (!socket || socket.readyState !== 1) return false;
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  };

  // ---------------------------------------------------------------- keeping changes on this device

  const savePending = (): void => {
    if (!offline || timers.pending) return;
    timers.pending = setTimeout(() => {
      timers.pending = null;
      void offline.savePending(docId, [...map.pendingRegisters(), ...ackedSinceSnapshot]).catch(() => undefined);
    }, PENDING_DELAY);
  };
  let snapshotting = false;
  const saveSnapshot = (): void => {
    if (!offline || timers.snapshot) return;
    timers.snapshot = setTimeout(() => {
      timers.snapshot = null;
      if (snapshotting) {
        saveSnapshot();
        return;
      }
      snapshotting = true;
      const included = new Set(ackedSinceSnapshot);
      void offline
        .save(docId, { seq: lastSeq, registers: map.confirmedRegisters(), role: roleKnown ? role : null, owner: ownerKey(auth) }, map.pendingRegisters())
        .then(() => {
          ackedSinceSnapshot = ackedSinceSnapshot.filter((register) => !included.has(register));
        })
        .catch(() => undefined)
        .finally(() => {
          snapshotting = false;
        });
    }, SNAPSHOT_DELAY);
  };

  // ---------------------------------------------------------------- the editor's document

  /** The document as last accounted for: every change to the store's document after it is either remote or made here. */
  let synced = store.getState().doc;

  /** Shows what the registers say for these keys in the editor (a remote change), and writes what had to be put right. */
  const applyKeys = (keys: readonly string[], full = false): void => {
    if (keys.length === 0 && !full) return;
    const current = store.getState().doc;
    const result = applyRegisters(current, map, keys, { irregular: irregular || full, docId });
    irregular = result.irregular;
    if (result.doc !== current) {
      synced = result.doc;
      store.getState().applyRemote(result.doc);
    }
    writeFixes(result.fixes);
  };

  const writeFixes = (fixes: readonly Fix[]): void => {
    if (fixes.length === 0 || !canEditNow()) return;
    const c = tick(clock, now());
    for (const fix of fixes) {
      const register: Register = { k: fix.k, v: fix.v, c };
      if (map.setLocal(register)) queue.set(register.k, register);
    }
    changed();
  };

  /** After changes were queued: they are kept on this device, counted, and sent soon. */
  const changed = (): void => {
    savePending();
    emitPending();
    flushSoon();
  };

  // Changes made here that must be checked against the registers (a layer brought back, a layer moved).
  const toCheck = new Set<string>();
  let checkQueued = false;
  const check = (): void => {
    checkQueued = false;
    if (closed) return;
    const keys = [...toCheck];
    toCheck.clear();
    applyKeys(keys);
  };

  const onLocalChange = (previous: Document, next: Document): void => {
    // Someone who may only view sends nothing (the store refuses their edits; text measured again stays theirs).
    if (!canEditNow()) return;
    const patch = diffForSync(previous, next);
    if (!patch) return;
    let ops = opsFromPatch(patch, next, clock, now());
    // A layer brought back (an undo of its deletion) only says that it exists again: its properties are
    // as the registers have them, so what others changed in it meanwhile is kept.
    const revived = new Set<NodeId>();
    for (const id in patch.nodes) if (patch.nodes[id]?.before === null && map.nodeValues(id)?.[EXISTS] !== undefined) revived.add(id);
    if (revived.size > 0) {
      ops = ops.filter((register) => {
        const parsed = parseKey(register.k);
        return parsed.kind !== 'node' || !revived.has(parsed.nodeId) || parsed.prop === EXISTS || map.get(register.k) === undefined;
      });
    }
    for (const register of ops) {
      if (map.setLocal(register)) queue.set(register.k, register);
      const parsed = parseKey(register.k);
      if (parsed.kind === 'asset') queueUpload(parsed.hash);
    }
    if (revived.size > 0 || isStructural(patch)) {
      // Where layers are (their existence, parent and place) is what can disagree with the registers.
      for (const register of ops) {
        const parsed = parseKey(register.k);
        if (parsed.kind === 'node' && (parsed.prop === EXISTS || parsed.prop === 'parentId' || parsed.prop === 'order')) toCheck.add(register.k);
      }
      if (!checkQueued) {
        checkQueued = true;
        queueMicrotask(check);
      }
    }
    changed();
  };

  const unsubscribe = store.subscribe((state) => {
    if (state.doc === synced) return;
    if (state.doc === state.remoteDoc) {
      synced = state.doc;
      return;
    }
    const previous = synced;
    synced = state.doc;
    onLocalChange(previous, state.doc);
  });

  /** Takes back every change not yet acknowledged (someone who may no longer edit). */
  const revertPending = (): void => {
    const keys = map.dropPending();
    queue.clear();
    inflight.clear();
    ackedSinceSnapshot = [];
    applyKeys(keys);
    emitPending();
    savePending();
  };

  // ---------------------------------------------------------------- sending

  const flushSoon = (delay = batchDelay): void => {
    if (timers.flush || closed) return;
    timers.flush = setTimeout(flush, delay);
  };

  const flush = (): void => {
    timers.flush = null;
    if (!online() || !canEdit(role) || queue.size === 0) return;
    // A node is never shown anywhere before all of it has arrived, nor before its parent: its existence comes after its properties, parents first.
    const doc = store.getState().doc;
    const rest: Register[] = [];
    const created: Register[] = [];
    const deleted: Register[] = [];
    for (const register of queue.values()) {
      const parsed = parseKey(register.k);
      if (parsed.kind === 'node' && parsed.prop === EXISTS) (register.v === true ? created : deleted).push(register);
      else rest.push(register);
    }
    const depth = (register: Register): number => {
      const parsed = parseKey(register.k);
      return parsed.kind === 'node' && doc.nodes[parsed.nodeId] ? getAncestorIds(doc, parsed.nodeId).length : 0;
    };
    created.sort((a, b) => depth(a) - depth(b));
    const all = [...rest, ...created, ...deleted];
    queue.clear();
    for (let start = 0; start < all.length; start += MAX_BATCH) {
      const ops = all.slice(start, start + MAX_BATCH);
      const id = `${clientId}-${++batches}`;
      inflight.set(id, ops);
      if (!send({ t: 'ops', id, ops })) {
        // The connection went: everything waiting is sent again after the next welcome.
        inflight.delete(id);
        for (const register of all.slice(start)) if (map.isPending(register.k)) queue.set(register.k, register);
        return;
      }
    }
  };

  // ---------------------------------------------------------------- images

  const queueUpload = (hash: string): void => {
    if (!storage) return;
    uploads.add(hash);
    void runUploads();
  };

  const runUploads = async (): Promise<void> => {
    if (uploading || !storage || !online() || !canEdit(role)) return;
    uploading = true;
    try {
      // Until none is left: images queued while others are being sent are sent too.
      while (uploads.size > 0) {
        const hash = uploads.values().next().value as string;
        const asset = await storage.loadAsset(hash).catch(() => null);
        if (!asset) {
          uploads.delete(hash);
          continue;
        }
        if (!(await uploadAsset({ docId, hash, asset, auth, fetch: fetchFn, apiBase }))) break;
        uploads.delete(hash);
      }
    } finally {
      uploading = false;
    }
  };

  const fetchMissingAssets = (keys: readonly string[]): void => {
    if (!storage) return;
    for (const key of keys) {
      const parsed = parseKey(key);
      if (parsed.kind !== 'asset' || map.value(key) === null) continue;
      const hash = parsed.hash;
      void storage
        .loadAsset(hash)
        .then((local) => (local ? null : downloadAsset({ docId, hash, auth, storage, fetch: fetchFn, apiBase })))
        .catch(() => null);
    }
  };

  // ---------------------------------------------------------------- the connection

  const sendPresence = (): void => {
    timers.presence = null;
    if (!presence || !online()) return;
    if (send({ t: 'presence', presence })) lastPresenceAt = Date.now();
  };

  const deny = (): void => {
    setStatus('denied');
    clearTimeout(timers.reconnect ?? undefined);
    clearInterval(timers.ping ?? undefined);
    const current = socket;
    socket = null;
    current?.close();
    peers.clear();
    emitPeers();
    role = null;
    roleKnown = true;
    store.getState().setReadOnly(true);
    accessListeners.emit(null, linkAccess);
  };

  const onWelcome = (message: Extract<ServerMessage, { t: 'welcome' }>): void => {
    attempt = 0;
    you = message.you;
    info = message.doc;
    linkAccess = message.doc.linkAccess;
    role = message.you.role ?? message.doc.role;
    roleKnown = true;
    peers.clear();
    for (const peer of message.peers) if (peer.clientId !== clientId) peers.set(peer.clientId, peer);
    const wasEmpty = map.size === 0;
    const keys = map.merge(message.registers, clock);
    lastSeq = message.seq;
    applyKeys(keys, wasEmpty);
    fetchMissingAssets(keys);
    store.getState().setReadOnly(!canEdit(role));
    if (!canEdit(role)) revertPending();
    // Whatever was sent and not acknowledged before the connection went is sent again (the server keeps a change once).
    inflight.clear();
    for (const register of map.pendingRegisters()) queue.set(register.k, register);
    setStatus('online');
    accessListeners.emit(role, linkAccess);
    emitPeers();
    emitPending();
    flush();
    sendPresence();
    clearInterval(timers.ping ?? undefined);
    timers.ping = setInterval(() => {
      // Pings are answered: a connection silent for longer than this has gone without saying so.
      if (Date.now() - lastHeard > SILENCE_LIMIT) socket?.close();
      else send({ t: 'ping' });
    }, PING_INTERVAL);
    saveSnapshot();
    void runUploads();
  };

  const onMessage = (message: ServerMessage): void => {
    switch (message.t) {
      case 'welcome':
        onWelcome(message);
        break;
      case 'ops': {
        lastSeq = Math.max(lastSeq, message.seq);
        const keys = map.merge(message.ops, clock);
        // A change waiting to be sent that someone else's later change has replaced is not sent.
        for (const key of keys) if (queue.has(key) && !map.isPending(key)) queue.delete(key);
        applyKeys(keys);
        fetchMissingAssets(keys);
        emitPending();
        saveSnapshot();
        break;
      }
      case 'ack': {
        const batch = inflight.get(message.id);
        if (!batch) break;
        inflight.delete(message.id);
        map.acknowledge(batch);
        ackedSinceSnapshot.push(...batch);
        emitPending();
        savePending();
        saveSnapshot();
        break;
      }
      case 'rejected': {
        const batch = inflight.get(message.id);
        if (!batch) break;
        inflight.delete(message.id);
        // Brought back to what the server holds.
        const keys = map.reject(batch);
        for (const key of keys) queue.delete(key);
        applyKeys(keys);
        emitPending();
        savePending();
        break;
      }
      case 'presence':
        if (message.peer.clientId === clientId) you = message.peer;
        else peers.set(message.peer.clientId, message.peer);
        emitPeers();
        break;
      case 'leave':
        if (peers.delete(message.clientId)) emitPeers();
        break;
      case 'comment':
        commentListeners.emit(message.event);
        break;
      case 'access':
        linkAccess = message.linkAccess;
        if (info) info = { ...info, role: message.role, linkAccess: message.linkAccess };
        if (message.role === null) {
          deny();
          break;
        }
        role = message.role;
        roleKnown = true;
        if (you) you = { ...you, role: message.role };
        store.getState().setReadOnly(!canEdit(role));
        if (!canEdit(role)) revertPending();
        accessListeners.emit(role, linkAccess);
        flush();
        break;
      case 'error':
        if (message.code === 'unauthorized' || message.code === 'forbidden' || message.code === 'not-found') deny();
        break;
      default:
        break;
    }
  };

  const scheduleReconnect = (): void => {
    if (closed || status === 'denied' || timers.reconnect) return;
    const delay = Math.min(10_000, 500 * 2 ** attempt);
    attempt++;
    timers.reconnect = setTimeout(() => {
      timers.reconnect = null;
      connect();
    }, delay);
  };

  const onDisconnected = (): void => {
    clearInterval(timers.ping ?? undefined);
    timers.ping = null;
    if (peers.size > 0) {
      peers.clear();
      emitPeers();
    }
    if (closed || status === 'denied') return;
    setStatus('offline');
    scheduleReconnect();
  };

  const connect = (): void => {
    if (closed || status === 'denied') return;
    // Trying again after the connection was lost is still being offline.
    if (status !== 'offline') setStatus('connecting');
    let next: WebSocket;
    try {
      next = new WebSocketImpl(socketUrl);
    } catch {
      onDisconnected();
      return;
    }
    socket = next;
    next.onopen = () => {
      if (socket !== next) return;
      const hello: Extract<ClientMessage, { t: 'hello' }> = { t: 'hello', docId, since: lastSeq, clientId };
      if (auth.token) hello.token = auth.token;
      else if (auth.guestToken) hello.guestToken = auth.guestToken;
      send(hello);
    };
    next.onmessage = (event: MessageEvent) => {
      if (socket !== next) return;
      lastHeard = Date.now();
      let message: ServerMessage;
      try {
        message = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }
      if (message && typeof message === 'object' && typeof message.t === 'string') onMessage(message);
    };
    next.onclose = () => {
      if (socket !== next) return;
      socket = null;
      onDisconnected();
    };
    next.onerror = () => {
      // The close that follows says the rest.
    };
  };

  // A browser that comes back online is tried at once rather than at the end of the wait.
  const onBrowserOnline = (): void => {
    if (status !== 'offline' || !timers.reconnect) return;
    clearTimeout(timers.reconnect);
    timers.reconnect = null;
    connect();
  };
  // A browser that says it has lost the network: the connection is taken to be gone at once (an open socket can take
  // long to notice), so changes made now wait here, and say so, instead of being sent into it.
  const onBrowserOffline = (): void => {
    const current = socket;
    if (closed || status === 'denied' || !current) return;
    socket = null;
    current.close();
    onDisconnected();
  };
  const win = options.network !== undefined ? options.network : typeof window !== 'undefined' && typeof window.addEventListener === 'function' ? window : null;
  win?.addEventListener('online', onBrowserOnline);
  win?.addEventListener('offline', onBrowserOffline);

  // Changes made here before the page was last closed and not yet acknowledged.
  if (offline) {
    void offline
      .loadPending(docId)
      .then((kept) => {
        if (closed || kept.length === 0) return;
        const keys: string[] = [];
        for (const register of kept) {
          observe(clock, register.c);
          if (map.setLocal(register)) {
            queue.set(register.k, register);
            keys.push(register.k);
          }
        }
        if (keys.length === 0) return;
        applyKeys(keys);
        changed();
      })
      .catch(() => undefined);
  }
  if (roleKnown) store.getState().setReadOnly(!canEdit(role));
  connect();

  return {
    clientId,
    status: () => status,
    onStatus: (callback) => statusListeners.add(callback),
    peers: () => [...peers.values()],
    onPeers: (callback) => peerListeners.add(callback),
    you: () => you,
    role: () => role,
    onAccess: (callback) => accessListeners.add(callback),
    info: () => info,
    setPresence(partial) {
      presence = { ...(presence ?? EMPTY_PRESENCE), ...partial };
      if (!online() || timers.presence) return;
      const delay = lastPresenceAt + PRESENCE_INTERVAL - Date.now();
      if (delay <= 0) sendPresence();
      else timers.presence = setTimeout(sendPresence, delay);
    },
    onComment: (callback) => commentListeners.add(callback),
    pendingCount: () => map.pendingCount,
    onPending: (callback) => pendingListeners.add(callback),
    seq: () => lastSeq,
    uploadAssets(hashes) {
      const listed = store.getState().doc.assets;
      for (const hash of hashes) if (Object.prototype.hasOwnProperty.call(listed, hash)) queueUpload(hash);
    },
    close() {
      if (closed) return;
      closed = true;
      unsubscribe();
      win?.removeEventListener('online', onBrowserOnline);
      win?.removeEventListener('offline', onBrowserOffline);
      for (const timer of [timers.reconnect, timers.flush, timers.presence, timers.pending, timers.snapshot]) if (timer) clearTimeout(timer);
      if (timers.ping) clearInterval(timers.ping);
      const current = socket;
      socket = null;
      current?.close();
      // A connection opened again for this editor carries on from here (changes still waiting included).
      if (status !== 'denied') handOver(docId, { seq: lastSeq, map, irregular, role: roleKnown ? role : null, doc: synced });
      // What this device keeps of the document is brought up to date, so it opens as it was left, also offline.
      if (offline) void offline.save(docId, { seq: lastSeq, registers: map.confirmedRegisters(), role: roleKnown ? role : null, owner: ownerKey(auth) }, map.pendingRegisters()).catch(() => undefined);
    },
  };
}
