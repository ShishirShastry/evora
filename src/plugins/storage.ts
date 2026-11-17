/**
 * Installed plugins and their own data, kept on this device in IndexedDB
 * (database "evora-plugins"), so that they are there in every file. The
 * factory is passed in, so the tests use a stand-in.
 */
import type { JsonValue } from '../core';
import type { ClientStorage } from './api';
import { parseBundle, type PluginBundle } from './manifest';

export const PLUGINS_DB_NAME = 'evora-plugins';
const DB_VERSION = 1;
const INSTALLED = 'installed';
const DATA = 'data';

/** Where an installed plugin came from. */
export type PluginSource = 'file' | 'directory' | 'development';

export interface InstalledPlugin {
  /** The manifest's ID. */
  id: string;
  bundle: PluginBundle;
  enabled: boolean;
  source: PluginSource;
  installedAt: string;
  updatedAt: string;
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

export class PluginRegistry {
  private db: Promise<IDBDatabase> | null = null;

  constructor(
    private readonly factory: IDBFactory = indexedDB,
    private readonly name: string = PLUGINS_DB_NAME,
    /** The IndexedDB key ranges that go with the factory. */
    private readonly keyRange: typeof IDBKeyRange = globalThis.IDBKeyRange,
  ) {}

  private open(): Promise<IDBDatabase> {
    if (!this.db) {
      this.db = new Promise<IDBDatabase>((resolve, reject) => {
        const req = this.factory.open(this.name, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(INSTALLED)) db.createObjectStore(INSTALLED, { keyPath: 'id' });
          // A plugin's own data, keyed by [plugin ID, key].
          if (!db.objectStoreNames.contains(DATA)) db.createObjectStore(DATA);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('Could not open the plugins storage'));
        req.onblocked = () => reject(new Error('The plugins storage is blocked by another tab'));
      });
      this.db.catch(() => {
        this.db = null;
      });
    }
    return this.db;
  }

  /** Every installed plugin, by name. A record that no longer reads as a plugin is left out. */
  async list(): Promise<InstalledPlugin[]> {
    const db = await this.open();
    const rows = await request(db.transaction(INSTALLED, 'readonly').objectStore(INSTALLED).getAll() as IDBRequest<InstalledPlugin[]>);
    const out: InstalledPlugin[] = [];
    for (const row of rows) {
      try {
        out.push({ ...row, bundle: parseBundle(row.bundle) });
      } catch {
        // Damaged: not offered.
      }
    }
    return out.sort((a, b) => a.bundle.manifest.name.localeCompare(b.bundle.manifest.name) || a.id.localeCompare(b.id));
  }

  async get(id: string): Promise<InstalledPlugin | null> {
    const db = await this.open();
    const row = await request(db.transaction(INSTALLED, 'readonly').objectStore(INSTALLED).get(id) as IDBRequest<InstalledPlugin | undefined>);
    return row ?? null;
  }

  /** Installs a plugin, or replaces the installed one with the same ID (keeping whether it was enabled, and its data). */
  async install(bundle: PluginBundle, source: PluginSource, now = new Date().toISOString()): Promise<InstalledPlugin> {
    const checked = parseBundle(bundle);
    const previous = await this.get(checked.manifest.id);
    const record: InstalledPlugin = {
      id: checked.manifest.id,
      bundle: checked,
      enabled: previous?.enabled ?? true,
      source,
      installedAt: previous?.installedAt ?? now,
      updatedAt: now,
    };
    const db = await this.open();
    const tx = db.transaction(INSTALLED, 'readwrite');
    tx.objectStore(INSTALLED).put(record);
    await done(tx);
    return record;
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const record = await this.get(id);
    if (!record) return;
    const db = await this.open();
    const tx = db.transaction(INSTALLED, 'readwrite');
    tx.objectStore(INSTALLED).put({ ...record, enabled });
    await done(tx);
  }

  /** Uninstalls a plugin and removes its data. */
  async uninstall(id: string): Promise<void> {
    const db = await this.open();
    const tx = db.transaction([INSTALLED, DATA], 'readwrite');
    tx.objectStore(INSTALLED).delete(id);
    tx.objectStore(DATA).delete(this.keyRange.bound([id], [id, []]));
    await done(tx);
  }

  /** A plugin's own data (`evora.clientStorage`). */
  storageFor(pluginId: string): ClientStorage & { clear(): Promise<void>; entries(): Promise<[string, JsonValue][]> } {
    const range = () => this.keyRange.bound([pluginId], [pluginId, []]);
    return {
      get: async (key) => {
        const db = await this.open();
        const value = await request(db.transaction(DATA, 'readonly').objectStore(DATA).get([pluginId, key]) as IDBRequest<JsonValue | undefined>);
        return value;
      },
      set: async (key, value) => {
        const db = await this.open();
        const tx = db.transaction(DATA, 'readwrite');
        tx.objectStore(DATA).put(value, [pluginId, key]);
        await done(tx);
      },
      delete: async (key) => {
        const db = await this.open();
        const tx = db.transaction(DATA, 'readwrite');
        tx.objectStore(DATA).delete([pluginId, key]);
        await done(tx);
      },
      keys: async () => {
        const db = await this.open();
        const keys = await request(db.transaction(DATA, 'readonly').objectStore(DATA).getAllKeys(range()));
        return keys.map((key) => (key as [string, string])[1]);
      },
      entries: async () => {
        const db = await this.open();
        const store = db.transaction(DATA, 'readonly').objectStore(DATA);
        const [keys, values] = await Promise.all([request(store.getAllKeys(range())), request(store.getAll(range()) as IDBRequest<JsonValue[]>)]);
        return keys.map((key, i) => [(key as [string, string])[1], values[i] as JsonValue]);
      },
      clear: async () => {
        const db = await this.open();
        const tx = db.transaction(DATA, 'readwrite');
        tx.objectStore(DATA).delete(range());
        await done(tx);
      },
    };
  }

  close(): void {
    void this.db?.then((db) => db.close());
    this.db = null;
  }
}
