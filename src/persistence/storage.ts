import type { EvoraFile } from '../core';

/** What the file browser shows for one file, without loading its contents. */
export interface FileSummary {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  /** Number of layers, shown as a hint in the file browser. */
  layerCount: number;
}

/** The bytes of an image asset, as they were imported. */
export interface StoredAsset {
  mimeType: string;
  bytes: ArrayBuffer;
}

/**
 * Where files live. The local implementation uses IndexedDB; a server-backed
 * implementation can provide the same interface later.
 *
 * Image assets are stored once per device, keyed by the hash of their bytes,
 * and shared by every file that uses them.
 */
export interface DocumentStorage {
  list(): Promise<FileSummary[]>;
  /** The stored file exactly as it was saved, or null when there is no such file. */
  load(id: string): Promise<EvoraFile | null>;
  /** Creates or replaces a file. The document and its summary are written atomically. */
  save(file: EvoraFile): Promise<void>;
  remove(id: string): Promise<void>;
  /** Stores an asset under its hash. Storing the same hash again is harmless. */
  saveAsset(hash: string, asset: StoredAsset): Promise<void>;
  loadAsset(hash: string): Promise<StoredAsset | null>;
  /** Deletes an asset's bytes. The caller makes sure no file needs them. */
  removeAsset(hash: string): Promise<void>;
}

export function summarize(file: EvoraFile): FileSummary {
  let layerCount = 0;
  // What a file holds of the libraries it uses is not counted: those are not its layers.
  const nodes = file.document.nodes;
  const imported = (id: string): boolean => {
    let node = nodes[id];
    for (let step = 0; node && node.parentId !== null && step < 1000; step++) node = nodes[node.parentId];
    return node?.type === 'PAGE' && Boolean(node.library);
  };
  for (const id in nodes) if (nodes[id]?.type !== 'PAGE' && !imported(id)) layerCount++;
  return {
    id: file.document.id,
    name: file.document.name,
    createdAt: file.meta.createdAt,
    updatedAt: file.meta.updatedAt,
    layerCount,
  };
}

/** In-memory storage, used by tests and as a fallback when IndexedDB is unavailable. */
export class MemoryStorage implements DocumentStorage {
  private readonly files = new Map<string, string>();
  private readonly assets = new Map<string, StoredAsset>();

  async list(): Promise<FileSummary[]> {
    return [...this.files.values()].map((json) => summarize(JSON.parse(json) as EvoraFile));
  }

  async load(id: string): Promise<EvoraFile | null> {
    const json = this.files.get(id);
    return json === undefined ? null : (JSON.parse(json) as EvoraFile);
  }

  async save(file: EvoraFile): Promise<void> {
    this.files.set(file.document.id, JSON.stringify(file));
  }

  async remove(id: string): Promise<void> {
    this.files.delete(id);
  }

  async saveAsset(hash: string, asset: StoredAsset): Promise<void> {
    this.assets.set(hash, { mimeType: asset.mimeType, bytes: asset.bytes.slice(0) });
  }

  async loadAsset(hash: string): Promise<StoredAsset | null> {
    const asset = this.assets.get(hash);
    return asset ? { mimeType: asset.mimeType, bytes: asset.bytes.slice(0) } : null;
  }

  async removeAsset(hash: string): Promise<void> {
    this.assets.delete(hash);
  }
}
