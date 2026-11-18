import { publishCounts, type Publication } from '../core';
import { openFile } from './files';
import type { DocumentStorage } from './storage';

/** A file that is published as a library, as the list of libraries shows it. */
export interface LibrarySummary {
  id: string;
  name: string;
  version: number;
  publishedAt: string;
  components: number;
  styles: number;
  variables: number;
}

/** What a file has published, read from storage. Null when the file is gone or is not published. */
export async function loadLibrary(storage: DocumentStorage, id: string): Promise<{ id: string; name: string; publication: Publication } | null> {
  const opened = await openFile(storage, id);
  if (!opened || !opened.doc.publication) return null;
  return { id: opened.doc.id, name: opened.doc.name, publication: opened.doc.publication };
}

/** The files on this device that are published as libraries, by name, leaving out one (the file that is asking). */
export async function listPublishedLibraries(storage: DocumentStorage, exceptId?: string): Promise<LibrarySummary[]> {
  const out: LibrarySummary[] = [];
  for (const file of await storage.list()) {
    if (file.id === exceptId) continue;
    const library = await loadLibrary(storage, file.id);
    if (!library) continue;
    out.push({ id: library.id, name: library.name, version: library.publication.version, publishedAt: library.publication.publishedAt, ...publishCounts(library.publication) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1));
}

// ------------------------------------------------------------------ updates declined

/** The part of the Web Storage interface used for remembering declined updates, so tests can give their own. */
export interface SmallStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Where declined library updates are kept: by file ID, then by library ID, the version that was declined. */
export const DECLINED_UPDATES_KEY = 'evora:library-updates-declined';

function browserStore(): SmallStore | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // Storage can be refused (a private window with site data blocked).
    return null;
  }
}

function readAll(store: SmallStore | null): Record<string, Record<string, number>> {
  try {
    const raw = store?.getItem(DECLINED_UPDATES_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, Record<string, number>>) : {};
  } catch {
    return {};
  }
}

/**
 * The library updates someone declined in a file ("Not now"): by library ID,
 * the version declined. Kept on this device; nothing is lost if it is not.
 */
export function loadDeclinedUpdates(fileId: string, store: SmallStore | null = browserStore()): Record<string, number> {
  const entry = readAll(store)[fileId];
  const out: Record<string, number> = {};
  if (!entry || typeof entry !== 'object') return out;
  for (const id in entry) if (typeof entry[id] === 'number' && Number.isFinite(entry[id])) out[id] = entry[id];
  return out;
}

/** Remembers the library updates declined in a file. */
export function saveDeclinedUpdates(fileId: string, declined: Readonly<Record<string, number>>, store: SmallStore | null = browserStore()): void {
  const all = readAll(store);
  if (Object.keys(declined).length === 0) delete all[fileId];
  else all[fileId] = { ...declined };
  try {
    store?.setItem(DECLINED_UPDATES_KEY, JSON.stringify(all));
  } catch {
    // Storage that refuses writes: the update is offered again next time, which is harmless.
  }
}
