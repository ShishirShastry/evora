import { diffDocuments, type Document } from '../core';

/**
 * The version history of files on this device, in IndexedDB (database
 * "evora-versions"): each version is the whole document as it was, with a
 * name and description for a named one. The list of a file's versions is
 * read without reading the documents (they are in a store of their own).
 *
 * Automatic versions are made when a file is opened after it changed and
 * every ten minutes while it is being edited (see `checkpoint`), and thinned
 * out as they age, by the same rule as the server's.
 */

/** A version made by someone, with a name, or made automatically. */
export type VersionKind = 'auto' | 'named';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Which automatic versions to keep: all from the last day, then the newest
 * of each day for 30 days, then the newest of each week, and always the
 * newest. Named versions are always kept. Returns the IDs to remove.
 * (The server keeps its own by the same rule.)
 */
export function autoVersionsToDrop(versions: ReadonlyArray<{ id: string; kind: VersionKind; createdAt: string }>, now: number): string[] {
  const autos = versions.filter((version) => version.kind === 'auto').sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const seen = new Set<string>();
  const drop: string[] = [];
  autos.forEach((version, index) => {
    const at = Date.parse(version.createdAt);
    const age = now - at;
    if (index === 0 || age < DAY_MS) return;
    const bucket = age < 30 * DAY_MS ? `d${Math.floor(at / DAY_MS)}` : `w${Math.floor(at / (7 * DAY_MS))}`;
    if (seen.has(bucket)) drop.push(version.id);
    else seen.add(bucket);
  });
  return drop;
}

export const VERSIONS_DB_NAME = 'evora-versions';
const DB_VERSION = 1;
const META = 'versions';
const CONTENT = 'contents';

export interface LocalVersion {
  id: string;
  fileId: string;
  kind: VersionKind;
  /** Empty for an automatic version. */
  name: string;
  description: string;
  createdAt: string;
  /** How many layers the document had, for the list. */
  layerCount: number;
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
    return null;
  }
}

function newVersionId(): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function countLayers(doc: Document): number {
  let count = 0;
  for (const id in doc.nodes) if (doc.nodes[id]?.type !== 'PAGE') count++;
  return count;
}

/** How often an automatic version is made while a file is being edited. */
export const AUTO_VERSION_INTERVAL_MS = 10 * 60 * 1000;

export class LocalVersionStore {
  private db: Promise<IDBDatabase> | null = null;
  private readonly factory: IDBFactory | null;
  private readonly name: string;

  constructor(factory: IDBFactory | null = browserIndexedDb(), name: string = VERSIONS_DB_NAME) {
    this.factory = factory;
    this.name = name;
  }

  /** Whether versions can be kept here at all (a browser without IndexedDB cannot). */
  get available(): boolean {
    return this.factory !== null;
  }

  private open(): Promise<IDBDatabase> {
    if (!this.factory) return Promise.reject(new Error('This browser cannot keep version history (no IndexedDB).'));
    this.db ??= new Promise((resolve, reject) => {
      const req = (this.factory as IDBFactory).open(this.name, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'id' }).createIndex('fileId', 'fileId');
        if (!db.objectStoreNames.contains(CONTENT)) db.createObjectStore(CONTENT);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('The version history could not be opened'));
    });
    return this.db;
  }

  /** A file's versions, newest first. */
  async list(fileId: string): Promise<LocalVersion[]> {
    const db = await this.open();
    const tx = db.transaction(META, 'readonly');
    const rows = await request(tx.objectStore(META).index('fileId').getAll(fileId) as IDBRequest<LocalVersion[]>);
    return rows.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id.localeCompare(a.id));
  }

  /** The document a version holds, or null when there is no such version. */
  async content(id: string): Promise<Document | null> {
    const db = await this.open();
    const doc = await request(db.transaction(CONTENT, 'readonly').objectStore(CONTENT).get(id) as IDBRequest<Document | undefined>);
    return doc ?? null;
  }

  /** Keeps a version of a document. Automatic ones are thinned out afterwards. */
  async add(fileId: string, doc: Document, details: { kind: VersionKind; name?: string; description?: string; at?: Date }): Promise<LocalVersion> {
    const db = await this.open();
    const version: LocalVersion = {
      id: newVersionId(),
      fileId,
      kind: details.kind,
      name: (details.name ?? '').trim(),
      description: (details.description ?? '').trim(),
      createdAt: (details.at ?? new Date()).toISOString(),
      layerCount: countLayers(doc),
    };
    const tx = db.transaction([META, CONTENT], 'readwrite');
    tx.objectStore(META).put(version);
    // IndexedDB keeps a copy (a structured clone): what is kept does not change with the open file.
    tx.objectStore(CONTENT).put(doc, version.id);
    await done(tx);
    if (version.kind === 'auto') await this.prune(fileId, Date.parse(version.createdAt));
    return version;
  }

  /** Renames a version or changes its description. Naming an automatic version makes it a named one, which is always kept. */
  async update(id: string, changes: { name?: string; description?: string }): Promise<LocalVersion> {
    const db = await this.open();
    const tx = db.transaction(META, 'readwrite');
    const store = tx.objectStore(META);
    const held = await request(store.get(id) as IDBRequest<LocalVersion | undefined>);
    if (!held) throw new Error('There is no such version');
    const name = changes.name === undefined ? held.name : changes.name.trim();
    const next: LocalVersion = {
      ...held,
      name,
      description: changes.description === undefined ? held.description : changes.description.trim(),
      kind: name ? 'named' : held.kind,
    };
    if (next.kind === 'named' && !next.name) throw new Error('A named version needs a name');
    store.put(next);
    await done(tx);
    return next;
  }

  async remove(id: string): Promise<void> {
    const db = await this.open();
    const tx = db.transaction([META, CONTENT], 'readwrite');
    tx.objectStore(META).delete(id);
    tx.objectStore(CONTENT).delete(id);
    await done(tx);
  }

  /** Removes every version of a file. */
  async removeAll(fileId: string): Promise<void> {
    for (const version of await this.list(fileId)) await this.remove(version.id);
  }

  /** Thins out a file's automatic versions (see `autoVersionsToDrop`). Returns how many were removed. */
  async prune(fileId: string, now: number = Date.now()): Promise<number> {
    const drop = autoVersionsToDrop(await this.list(fileId), now);
    for (const id of drop) await this.remove(id);
    return drop.length;
  }

  /**
   * Makes an automatic version of a document when it differs from the
   * file's latest version (or there is none). Returns it, or null when
   * nothing changed.
   */
  async checkpoint(fileId: string, doc: Document, at: Date = new Date()): Promise<LocalVersion | null> {
    const [latest] = await this.list(fileId);
    if (latest) {
      const held = await this.content(latest.id);
      if (held && !diffDocuments(held, doc) && held.name === doc.name) return null;
    }
    return this.add(fileId, doc, { kind: 'auto', at });
  }
}

let shared: LocalVersionStore | null = null;

/** The version history of this device's files. */
export function localVersions(): LocalVersionStore {
  shared ??= new LocalVersionStore();
  return shared;
}
