import type { OpenDesignFile } from '../core';

/** What the file browser shows for one file, without loading its contents. */
export interface FileSummary {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  /** Number of layers, shown as a hint in the file browser. */
  layerCount: number;
}

/**
 * Where files live. The local implementation uses IndexedDB; a server-backed
 * implementation can provide the same interface later.
 */
export interface DocumentStorage {
  list(): Promise<FileSummary[]>;
  /** The stored file exactly as it was saved, or null when there is no such file. */
  load(id: string): Promise<OpenDesignFile | null>;
  /** Creates or replaces a file. The document and its summary are written atomically. */
  save(file: OpenDesignFile): Promise<void>;
  remove(id: string): Promise<void>;
}

export function summarize(file: OpenDesignFile): FileSummary {
  let layerCount = 0;
  for (const id in file.document.nodes) if (file.document.nodes[id]?.type !== 'PAGE') layerCount++;
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

  async list(): Promise<FileSummary[]> {
    return [...this.files.values()].map((json) => summarize(JSON.parse(json) as OpenDesignFile));
  }

  async load(id: string): Promise<OpenDesignFile | null> {
    const json = this.files.get(id);
    return json === undefined ? null : (JSON.parse(json) as OpenDesignFile);
  }

  async save(file: OpenDesignFile): Promise<void> {
    this.files.set(file.document.id, JSON.stringify(file));
  }

  async remove(id: string): Promise<void> {
    this.files.delete(id);
  }
}
