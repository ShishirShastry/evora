import type { EvoraFile } from '../core';
import { summarize, type DocumentStorage, type FileSummary, type StoredAsset } from './storage';

const DB_NAME = 'evora';
/** Where files were kept before the application was renamed Evora. They are copied over the first time Evora's own storage is made. */
const LEGACY_DB_NAME = 'open-design';
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
    private readonly legacyName: string | null = name === DB_NAME ? LEGACY_DB_NAME : null,
  ) {}

  /**
   * Opens a database only if it already exists: one that does not is not made
   * (its creation is called off), and null is returned.
   */
  private openExisting(name: string): Promise<IDBDatabase | null> {
    return new Promise((resolve) => {
      const req = this.factory.open(name);
      req.onupgradeneeded = () => req.transaction?.abort();
      req.onsuccess = () => resolve(req.result);
      req.onerror = (event) => {
        event.preventDefault();
        resolve(null);
      };
      req.onblocked = () => resolve(null);
    });
  }

  /**
   * Copies every file, summary and image from the storage used before the
   * rename into this one. The old storage is left as it was, so nothing is
   * lost if anything here goes wrong.
   */
  private async importLegacy(db: IDBDatabase, legacyName: string): Promise<void> {
    const legacy = await this.openExisting(legacyName);
    if (!legacy) return;
    try {
      const stores = [SUMMARIES, DOCUMENTS, ASSETS].filter((store) => legacy.objectStoreNames.contains(store));
      if (stores.length === 0) return;
      const read = legacy.transaction(stores, 'readonly');
      const contents = await Promise.all(
        stores.map(async (store) => {
          const keys = await request(read.objectStore(store).getAllKeys());
          const values = await request(read.objectStore(store).getAll());
          return { store, keys, values };
        }),
      );
      const write = db.transaction(stores, 'readwrite');
      for (const { store, keys, values } of contents) {
        const target = write.objectStore(store);
        values.forEach((value, index) => {
          // Summaries carry their own key; files and images are stored under theirs.
          if (target.keyPath !== null) target.put(value);
          else target.put(value, keys[index]);
        });
      }
      await done(write);
    } finally {
      legacy.close();
    }
  }

  private open(): Promise<IDBDatabase> {
    if (!this.db) {
      this.db = new Promise<IDBDatabase>((resolve, reject) => {
        const req = this.factory.open(this.name, DB_VERSION);
        let made = false;
        req.onupgradeneeded = (event) => {
          made = event.oldVersion === 0;
          // Each store is created if it is missing, so this handles a brand-new
          // database and every older version of it alike. Nothing is ever dropped.
          const db = req.result;
          if (!db.objectStoreNames.contains(SUMMARIES)) db.createObjectStore(SUMMARIES, { keyPath: 'id' });
          if (!db.objectStoreNames.contains(DOCUMENTS)) db.createObjectStore(DOCUMENTS);
          if (!db.objectStoreNames.contains(ASSETS)) db.createObjectStore(ASSETS);
        };
        req.onsuccess = () => {
          const db = req.result;
          // Made just now: the files kept under the application's old name are brought over first.
          if (made && this.legacyName) this.importLegacy(db, this.legacyName).then(() => resolve(db), () => resolve(db));
          else resolve(db);
        };
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

  async load(id: string): Promise<EvoraFile | null> {
    const db = await this.open();
    const file = await request(
      db.transaction(DOCUMENTS, 'readonly').objectStore(DOCUMENTS).get(id) as IDBRequest<EvoraFile | undefined>,
    );
    return file ?? null;
  }

  async save(file: EvoraFile): Promise<void> {
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
