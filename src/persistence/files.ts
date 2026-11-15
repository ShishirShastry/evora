import {
  createDocument,
  createId,
  FILE_EXTENSION,
  parseFile,
  parseFileText,
  serializeFile,
  toFile,
  type Document,
  type FileMeta,
  type OpenDesignFile,
} from '../core';
import type { DocumentStorage, FileSummary } from './storage';

/** File-level operations of the file browser. Each returns what the caller needs to refresh its list. */

export interface OpenedFile {
  doc: Document;
  meta: FileMeta;
  /** Problems that were repaired while opening. Empty for a healthy file. */
  repairs: string[];
}

export async function listFiles(storage: DocumentStorage): Promise<FileSummary[]> {
  const files = await storage.list();
  return files.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
}

export async function createFile(storage: DocumentStorage, name = 'Untitled'): Promise<FileSummary> {
  const now = new Date().toISOString();
  const file = toFile(createDocument(name), { createdAt: now, updatedAt: now });
  await storage.save(file);
  return { id: file.document.id, name, createdAt: now, updatedAt: now, layerCount: 0 };
}

/** Loads a stored file through migration, validation and repair. Null when it does not exist. */
export async function openFile(storage: DocumentStorage, id: string): Promise<OpenedFile | null> {
  const raw = await storage.load(id);
  if (!raw) return null;
  const { file, repairs } = parseFile(raw);
  return { doc: file.document, meta: file.meta, repairs };
}

export async function saveDocument(storage: DocumentStorage, doc: Document, createdAt: string): Promise<FileMeta> {
  const meta = { createdAt, updatedAt: new Date().toISOString() };
  await storage.save(toFile(doc, meta));
  return meta;
}

export async function renameFile(storage: DocumentStorage, id: string, name: string): Promise<void> {
  const trimmed = name.trim();
  const opened = await openFile(storage, id);
  if (!opened || !trimmed) return;
  await saveDocument(storage, { ...opened.doc, name: trimmed }, opened.meta.createdAt);
}

export async function duplicateFile(storage: DocumentStorage, id: string): Promise<string | null> {
  const opened = await openFile(storage, id);
  if (!opened) return null;
  const now = new Date().toISOString();
  const copy: Document = { ...opened.doc, id: createId(), name: `${opened.doc.name} copy` };
  await storage.save(toFile(copy, { createdAt: now, updatedAt: now }));
  return copy.id;
}

/**
 * Imports the text of a `.opendesign` file as a new local file. The import
 * always gets a fresh document ID, so importing never overwrites an existing
 * file, even when the same file is imported twice.
 */
export async function importFileText(storage: DocumentStorage, text: string): Promise<{ id: string; repairs: string[] }> {
  const { file, repairs } = parseFileText(text);
  const now = new Date().toISOString();
  const doc: Document = { ...file.document, id: createId() };
  await storage.save(toFile(doc, { createdAt: file.meta.createdAt, updatedAt: now }));
  return { id: doc.id, repairs };
}

export function exportFileText(doc: Document, meta: FileMeta): string {
  return serializeFile(toFile(doc, meta) as OpenDesignFile);
}

export function exportFileName(name: string): string {
  const safe = name.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'Untitled';
  return `${safe}${FILE_EXTENSION}`;
}
