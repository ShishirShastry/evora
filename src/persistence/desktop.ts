import { diffDocuments, FileFormatError, nameFromFile, type Document, type FileMeta, type TextMeasurer } from '../core';
import { canSaveInPlace, diskFileKind, type DiskFile, type DiskLink, type EvoraDesktop } from './desktopContract';
import { exportFigBytes, importFigBytes } from './fig';
import { createFile, exportFileName, exportFileText, importFileText, openFile } from './files';
import type { DocumentStorage } from './storage';

/**
 * Files on disk in the desktop app (Electron). In a browser there is no
 * `window.evoraDesktop` and none of this is used.
 *
 * The editor always works on a file of the app's library (IndexedDB), which
 * it saves by itself as it changes. A `.evora` file opened from disk becomes
 * such a library file, linked to its path (`DiskLink`, kept by the desktop
 * app): Save writes it back there, and opening the same, unchanged path again
 * opens the same library file. A `.fig`, `.opendesign` or `.svg` file becomes
 * a new library file that is not linked; Save then asks where to write a
 * `.evora`.
 */

export type { DiskFile, DiskLink, EvoraDesktop } from './desktopContract';

/** The desktop app's bridge, or null in a browser. */
export function desktopBridge(): EvoraDesktop | null {
  const bridge = (globalThis as { evoraDesktop?: EvoraDesktop }).evoraDesktop;
  return bridge ?? null;
}

export interface OpenedDiskFile {
  /** The library file that now holds it. */
  id: string;
  /** What a `.fig` file held that could not be converted. */
  notConverted: string[];
  /** Repairs made while opening. */
  repairs: string[];
  /** For an SVG file: the file, to be placed as layers once the new file's editor is open. */
  svg: File | null;
  /** Whether an existing library file was opened again rather than a new one made. */
  reused: boolean;
}

export class UnsupportedFileError extends Error {
  constructor(name: string) {
    super(`“${name}” is not a file Evora opens. Evora opens .evora, .opendesign, .fig and .svg files.`);
    this.name = 'UnsupportedFileError';
  }
}

type LinkStore = Pick<EvoraDesktop, 'linkByPath' | 'setLink'>;

/** Opens a file from disk into the library. Throws `FileFormatError`, `FigError` or `UnsupportedFileError` when it cannot. */
export async function openDiskFile(storage: DocumentStorage, links: LinkStore, file: DiskFile, measurer?: TextMeasurer): Promise<OpenedDiskFile> {
  const kind = diskFileKind(file.name);
  if (kind === 'fig') {
    const { id, notConverted } = await importFigBytes(storage, file.bytes, file.name, measurer);
    return { id, notConverted, repairs: [], svg: null, reused: false };
  }
  if (kind === 'svg') {
    const created = await createFile(storage, nameFromFile(file.name));
    const svg = new File([file.bytes as unknown as BlobPart], file.name, { type: 'image/svg+xml' });
    return { id: created.id, notConverted: [], repairs: [], svg, reused: false };
  }
  if (kind !== 'evora') throw new UnsupportedFileError(file.name);

  // The same file, unchanged on disk since it was last opened or saved here: its library file, with whatever was not saved yet.
  const link = await links.linkByPath(file.path);
  if (link && link.mtimeMs === file.mtimeMs && (await storage.load(link.fileId)) !== null) {
    return { id: link.fileId, notConverted: [], repairs: [], svg: null, reused: true };
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(file.bytes);
  } catch {
    throw new FileFormatError('This file is damaged or is not an Evora file (it is not text).');
  }
  const { id, repairs } = await importFileText(storage, text);
  if (canSaveInPlace(file.path)) {
    const opened = await openFile(storage, id);
    if (opened) await links.setLink({ fileId: id, path: file.path, savedUpdatedAt: opened.meta.updatedAt, mtimeMs: file.mtimeMs });
  }
  return { id, notConverted: [], repairs, svg: null, reused: false };
}

export type SaveMode = 'save' | 'saveAs' | 'copy';

export interface SaveTarget {
  /** The library file's ID. */
  fileId: string;
  doc: Document;
  /** Its metadata as stored: the autosave has been flushed, so `updatedAt` is that of `doc`. */
  meta: FileMeta;
}

type SaveBridge = Pick<EvoraDesktop, 'linkFor' | 'setLink' | 'save' | 'clearRecovery'>;

/**
 * Writes a library file to a `.evora` file on disk. "save" writes to its
 * linked file, or asks where when it has none (or it is not a `.evora`);
 * "saveAs" always asks and links the file to the new place; "copy" asks and
 * leaves the link alone. Returns the path written, or null when cancelled.
 */
export async function saveToDisk(storage: DocumentStorage, bridge: SaveBridge, target: SaveTarget, mode: SaveMode): Promise<string | null> {
  const link = await bridge.linkFor(target.fileId);
  const path = mode === 'save' && link && canSaveInPlace(link.path) ? link.path : null;
  const text = await exportFileText(storage, target.doc, target.meta);
  const saved = await bridge.save({ path, suggestedName: exportFileName(target.doc.name), kind: 'evora', data: text });
  if (!saved) return null;
  if (mode !== 'copy') {
    await bridge.setLink({ fileId: target.fileId, path: saved.path, savedUpdatedAt: target.meta.updatedAt, mtimeMs: saved.mtimeMs });
    await bridge.clearRecovery(target.fileId);
  }
  return saved.path;
}

/** "Save a copy as .fig": asks where, and returns what a Figma file cannot hold (null when cancelled). */
export async function saveFigToDisk(storage: DocumentStorage, bridge: Pick<EvoraDesktop, 'save'>, doc: Document): Promise<string[] | null> {
  const out = await exportFigBytes(storage, doc);
  const name = exportFileName(doc.name).replace(/\.evora$/, '.fig');
  const saved = await bridge.save({ path: null, suggestedName: name, kind: 'fig', data: out.bytes });
  return saved ? out.notWritten : null;
}

/**
 * Whether the open file has changes its disk file does not: it is linked, and
 * either it was already changed when opened or the document differs from what
 * it was when it last matched the disk (`baseline`). Undoing back to that
 * point makes it match again: undo builds a new document object, so the two
 * are compared by content when they are not the same object.
 */
export function isDiskDirty(link: DiskLink | null, baseline: Document | null, current: Document): boolean {
  if (link === null) return false;
  return baseline === null || !sameDocument(baseline, current);
}

/** Whether two snapshots of a document hold the same content. Untouched layers are shared by reference, so this is quick. */
function sameDocument(a: Document, b: Document): boolean {
  if (a === b) return true;
  if (a.id !== b.id || a.name !== b.name) return false;
  if (a.assets !== b.assets && JSON.stringify(a.assets) !== JSON.stringify(b.assets)) return false;
  return diffDocuments(a, b) === null;
}

/** The document to compare against: the open document when the library file matches its disk file, else null (changed). */
export function diskBaseline(link: DiskLink | null, meta: FileMeta, doc: Document): Document | null {
  return link !== null && link.savedUpdatedAt === meta.updatedAt ? doc : null;
}
