import {
  base64ToBytes,
  bytesToBase64,
  createDocument,
  createId,
  FILE_EXTENSION,
  FileFormatError,
  parseFile,
  referencedAssetHashes,
  serializeFile,
  sha256Hex,
  toFile,
  type Document,
  type FileMeta,
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

/** Copies a file. Image assets are shared between the two: they are stored once, by hash. */
export async function duplicateFile(storage: DocumentStorage, id: string): Promise<string | null> {
  const opened = await openFile(storage, id);
  if (!opened) return null;
  const now = new Date().toISOString();
  const copy: Document = { ...opened.doc, id: createId(), name: `${opened.doc.name} copy` };
  await storage.save(toFile(copy, { createdAt: now, updatedAt: now }));
  return copy.id;
}

/**
 * Deletes a file, and with it the images that only it knew about. An image
 * is kept for as long as any remaining file lists it, whether or not a layer
 * of that file still shows it, so that undoing in an open file never finds
 * its image gone. Returns how many images were removed.
 */
export async function deleteFile(storage: DocumentStorage, id: string): Promise<number> {
  const doomed = await storage.load(id);
  await storage.remove(id);
  const hashes = Object.keys(doomed?.document?.assets ?? {});
  if (hashes.length === 0) return 0;
  const needed = new Set<string>();
  for (const summary of await storage.list()) {
    const other = await storage.load(summary.id);
    for (const hash in other?.document?.assets ?? {}) needed.add(hash);
  }
  let removed = 0;
  for (const hash of hashes) {
    if (needed.has(hash)) continue;
    await storage.removeAsset(hash);
    removed++;
  }
  return removed;
}

/**
 * The text of a `.opendesign` file for a document: the document itself plus
 * the bytes of every image it uses, so the file is complete on its own and
 * opens on another machine. An image whose bytes cannot be found on this
 * device is left out; the layer that uses it then shows as a placeholder.
 */
export async function exportFileText(storage: DocumentStorage, doc: Document, meta: FileMeta): Promise<string> {
  const file = toFile(doc, meta);
  const assetData: Record<string, string> = {};
  for (const hash of referencedAssetHashes(doc)) {
    const asset = await storage.loadAsset(hash);
    if (asset) assetData[hash] = bytesToBase64(new Uint8Array(asset.bytes));
  }
  return serializeFile(Object.keys(assetData).length > 0 ? { ...file, assetData } : file);
}

/**
 * Imports the text of a `.opendesign` file as a new local file. The import
 * always gets a fresh document ID, so importing never overwrites an existing
 * file, even when the same file is imported twice.
 *
 * Images bundled in the file are checked against their hashes before they are
 * stored: bytes that do not match the name they are filed under are refused,
 * because every file that uses that hash would otherwise show the wrong image.
 */
/**
 * How deeply a file's JSON may nest arrays and objects. A real file nests a
 * few dozen levels at most; one nested thousands deep would overflow the
 * stack of the code that checks and repairs it.
 */
export const MAX_FILE_DEPTH = 200;

/** Whether a parsed JSON value nests more than `limit` deep, walked without recursion. */
function nestedDeeperThan(value: unknown, limit: number): boolean {
  if (!value || typeof value !== 'object') return false;
  const stack: [object, number][] = [[value, 1]];
  while (stack.length > 0) {
    const [current, depth] = stack.pop() as [object, number];
    if (depth > limit) return true;
    for (const child of Array.isArray(current) ? current : Object.values(current)) if (child && typeof child === 'object') stack.push([child, depth + 1]);
  }
  return false;
}

export async function importFileText(storage: DocumentStorage, text: string): Promise<{ id: string; repairs: string[] }> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new FileFormatError('This file is damaged or is not an Evora file (it is not valid JSON).');
  }
  if (nestedDeeperThan(raw, MAX_FILE_DEPTH)) throw new FileFormatError(`This file is damaged or is not an Evora file: its data is nested more than ${MAX_FILE_DEPTH} levels deep.`);
  const { file, repairs } = parseFile(raw);

  const bundled = typeof raw === 'object' && raw !== null ? (raw as { assetData?: unknown }).assetData : undefined;
  const assetData = typeof bundled === 'object' && bundled !== null ? (bundled as Record<string, unknown>) : {};
  let rejected = 0;
  let missing = 0;
  for (const hash of referencedAssetHashes(file.document)) {
    const info = file.document.assets[hash];
    const encoded = assetData[hash];
    const bytes = typeof encoded === 'string' ? base64ToBytes(encoded) : null;
    if (bytes && info) {
      if ((await sha256Hex(bytes)) === hash) {
        const copy = new Uint8Array(bytes.byteLength);
        copy.set(bytes);
        await storage.saveAsset(hash, { mimeType: info.mimeType, bytes: copy.buffer });
        continue;
      }
      rejected++;
    }
    if (!(await storage.loadAsset(hash))) missing++;
  }
  if (rejected > 0) repairs.push(`${rejected} image(s) in the file were damaged and were not imported.`);
  if (missing > 0) repairs.push(`${missing} image(s) used by the file are missing; those layers show a placeholder.`);

  const now = new Date().toISOString();
  const doc: Document = { ...file.document, id: createId() };
  await storage.save(toFile(doc, { createdAt: file.meta.createdAt, updatedAt: now }));
  return { id: doc.id, repairs };
}

export function exportFileName(name: string): string {
  const safe = name.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'Untitled';
  return `${safe}${FILE_EXTENSION}`;
}
