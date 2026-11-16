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
