import type { Register, Role } from './protocol';

/**
 * What this device keeps of each shared document, so that it can be opened
 * and edited without a connection and nothing made offline is lost when the
 * page is reloaded or closed: the registers as the server was last known to
 * hold them, the server's sequence number they go up to, the role last
 * granted, and the changes made here that the server has not acknowledged.
 *
 * Kept in the browser's IndexedDB, in a database of its own ("evora-collab"),
 * apart from the files on this device. The snapshot and the changes waiting
 * are separate records, so the (small, frequent) list of changes can be
 * written without writing the (large, occasional) snapshot.
 */

export const OFFLINE_DB_NAME = 'evora-collab';
const DB_VERSION = 1;
const SNAPSHOTS = 'snapshots';
const PENDING = 'pending';

export interface OfflineSnapshot {
  /** The server's sequence number the registers go up to. */
  seq: number;
  registers: Register[];
  /** The role last granted on the document; null when not known. */
  role: Role | null;
  savedAt: string;
}

export interface OfflineDocument {
  snapshot: OfflineSnapshot | null;
  /** Changes made here not yet acknowledged by the server, oldest first. */
  pending: Register[];
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

function browserIndexedDb(): IDBFactory | null {
  try {
    return typeof indexedDB === 'undefined' ? null : indexedDB;
  } catch {
    // A browser can refuse storage altogether (site data blocked).
    return null;
  }
}

/**
 * The shared documents kept on this device. Without IndexedDB (or when it
 * refuses to open) nothing is kept: loading finds nothing and saving does
 * nothing, so a document still works online.
 */
export class OfflineStore {
  private db: Promise<IDBDatabase | null> | null = null;
  private readonly factory: IDBFactory | null;
  private readonly name: string;

  constructor(factory: IDBFactory | null = browserIndexedDb(), name: string = OFFLINE_DB_NAME) {
    this.factory = factory;
    this.name = name;
  }

  private open(): Promise<IDBDatabase | null> {
    if (!this.db) {
      const factory = this.factory;
      this.db = !factory
        ? Promise.resolve(null)
        : new Promise<IDBDatabase | null>((resolve) => {
            let req: IDBOpenDBRequest;
            try {
              req = factory.open(this.name, DB_VERSION);
            } catch {
              resolve(null);
              return;
            }
            req.onupgradeneeded = () => {
              const db = req.result;
              if (!db.objectStoreNames.contains(SNAPSHOTS)) db.createObjectStore(SNAPSHOTS);
              if (!db.objectStoreNames.contains(PENDING)) db.createObjectStore(PENDING);
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = (event) => {
              event.preventDefault();
              resolve(null);
            };
            req.onblocked = () => resolve(null);
          });
    }
    return this.db;
  }

  /** Whether anything can be kept (IndexedDB is there and opened). */
  async available(): Promise<boolean> {
    return (await this.open()) !== null;
  }

  /** What is kept of a document, or null when nothing is. */
  async load(docId: string): Promise<OfflineDocument | null> {
    const db = await this.open();
    if (!db) return null;
    const tx = db.transaction([SNAPSHOTS, PENDING], 'readonly');
    const [snapshot, pending] = await Promise.all([
      request(tx.objectStore(SNAPSHOTS).get(docId) as IDBRequest<OfflineSnapshot | undefined>),
      request(tx.objectStore(PENDING).get(docId) as IDBRequest<Register[] | undefined>),
    ]);
    if (!snapshot && !pending) return null;
    return { snapshot: snapshot ?? null, pending: pending ?? [] };
  }

  /** The changes waiting to be sent for a document (none when nothing is kept). */
  async loadPending(docId: string): Promise<Register[]> {
    return (await this.load(docId))?.pending ?? [];
  }

  /** Keeps the changes waiting to be sent, replacing those kept before. */
  async savePending(docId: string, pending: readonly Register[]): Promise<void> {
    const db = await this.open();
    if (!db) return;
    const tx = db.transaction(PENDING, 'readwrite');
    tx.objectStore(PENDING).put([...pending], docId);
    await done(tx);
  }

  /** Keeps a snapshot and the changes waiting together, in one transaction, so the two always agree. */
  async save(docId: string, snapshot: Omit<OfflineSnapshot, 'savedAt'> & { savedAt?: string }, pending: readonly Register[]): Promise<void> {
    const db = await this.open();
    if (!db) return;
    const tx = db.transaction([SNAPSHOTS, PENDING], 'readwrite');
    const record: OfflineSnapshot = { seq: snapshot.seq, registers: snapshot.registers, role: snapshot.role ?? null, savedAt: snapshot.savedAt ?? new Date().toISOString() };
    tx.objectStore(SNAPSHOTS).put(record, docId);
    tx.objectStore(PENDING).put([...pending], docId);
    await done(tx);
  }

  /** Forgets everything kept of a document. */
  async clear(docId: string): Promise<void> {
    const db = await this.open();
    if (!db) return;
    const tx = db.transaction([SNAPSHOTS, PENDING], 'readwrite');
    tx.objectStore(SNAPSHOTS).delete(docId);
    tx.objectStore(PENDING).delete(docId);
    await done(tx);
  }

  /** The documents something is kept of. */
  async documents(): Promise<string[]> {
    const db = await this.open();
    if (!db) return [];
    const tx = db.transaction([SNAPSHOTS, PENDING], 'readonly');
    const [a, b] = await Promise.all([request(tx.objectStore(SNAPSHOTS).getAllKeys()), request(tx.objectStore(PENDING).getAllKeys())]);
    return [...new Set([...a, ...b].map(String))].sort();
  }

  /** Closes the connection (tests, and reopening after a version change). */
  async close(): Promise<void> {
    const db = this.db ? await this.db : null;
    db?.close();
    this.db = null;
  }
}

let shared: OfflineStore | null = null;

/** The store the application uses, over the browser's own IndexedDB. */
export function defaultOfflineStore(): OfflineStore {
  return (shared ??= new OfflineStore());
}
