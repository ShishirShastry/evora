import type { OpenDesignFile } from '../core';
import { summarize, type DocumentStorage, type FileSummary, type StoredAsset } from './storage';

const DB_NAME = 'open-design';
/** Version 2 added the store for image assets. */
const DB_VERSION = 2;
const SUMMARIES = 'summaries';
const DOCUMENTS = 'documents';
const ASSETS = 'assets';

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

/**
 * Local file storage in the browser's IndexedDB. Summaries and documents are
 * kept in separate object stores so the file browser can list files without
 * reading every document, and both are written in one transaction so they can
 * never disagree. Image assets have a store of their own, keyed by hash.
 */
export class IndexedDbStorage implements DocumentStorage {
  private db: Promise<IDBDatabase> | null = null;

  constructor(
    private readonly factory: IDBFactory = indexedDB,
    private readonly name: string = DB_NAME,
  ) {}

  private open(): Promise<IDBDatabase> {
    if (!this.db) {
      this.db = new Promise<IDBDatabase>((resolve, reject) => {
        const req = this.factory.open(this.name, DB_VERSION);
        req.onupgradeneeded = () => {
          // Each store is created if it is missing, so this handles a brand-new
          // database and every older version of it alike. Nothing is ever dropped.
          const db = req.result;
          if (!db.objectStoreNames.contains(SUMMARIES)) db.createObjectStore(SUMMARIES, { keyPath: 'id' });
          if (!db.objectStoreNames.contains(DOCUMENTS)) db.createObjectStore(DOCUMENTS);
          if (!db.objectStoreNames.contains(ASSETS)) db.createObjectStore(ASSETS);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('Could not open local storage'));
        req.onblocked = () => reject(new Error('Local storage is blocked by another tab'));
      });
      // Let a later call retry if opening failed.
      this.db.catch(() => {
        this.db = null;
      });
    }
    return this.db;
  }

  async list(): Promise<FileSummary[]> {
    const db = await this.open();
    return request(db.transaction(SUMMARIES, 'readonly').objectStore(SUMMARIES).getAll() as IDBRequest<FileSummary[]>);
  }

  async load(id: string): Promise<OpenDesignFile | null> {
    const db = await this.open();
    const file = await request(
      db.transaction(DOCUMENTS, 'readonly').objectStore(DOCUMENTS).get(id) as IDBRequest<OpenDesignFile | undefined>,
    );
    return file ?? null;
  }

  async save(file: OpenDesignFile): Promise<void> {
    const db = await this.open();
    const tx = db.transaction([SUMMARIES, DOCUMENTS], 'readwrite');
    tx.objectStore(DOCUMENTS).put(file, file.document.id);
    tx.objectStore(SUMMARIES).put(summarize(file));
    await done(tx);
  }

  async remove(id: string): Promise<void> {
    const db = await this.open();
    const tx = db.transaction([SUMMARIES, DOCUMENTS], 'readwrite');
    tx.objectStore(DOCUMENTS).delete(id);
    tx.objectStore(SUMMARIES).delete(id);
    await done(tx);
  }

  async saveAsset(hash: string, asset: StoredAsset): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(ASSETS, 'readwrite');
    tx.objectStore(ASSETS).put({ mimeType: asset.mimeType, bytes: asset.bytes }, hash);
    await done(tx);
  }

  async loadAsset(hash: string): Promise<StoredAsset | null> {
    const db = await this.open();
    const asset = await request(db.transaction(ASSETS, 'readonly').objectStore(ASSETS).get(hash) as IDBRequest<StoredAsset | undefined>);
    return asset ?? null;
  }

  async removeAsset(hash: string): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(ASSETS, 'readwrite');
    tx.objectStore(ASSETS).delete(hash);
    await done(tx);
  }

  /** Closes the connection. Used by tests. */
  async close(): Promise<void> {
    if (!this.db) return;
    (await this.db).close();
    this.db = null;
  }
}
