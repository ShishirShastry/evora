import { app, dialog, type BrowserWindow } from 'electron';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import type { DiskFile, DiskLink, RecoveryEntry, SavedFile, SaveRequest } from '../src/persistence/desktopContract.js';
import { diskFileKind } from '../src/persistence/desktopContract.js';
import { readJson, writeJson } from './jsonStore.js';

/**
 * Files on disk, for the main process. The app's pages never name a path to
 * read or write on their own: a path must first have been given to the app
 * by the person (the Open and Save dialogs, the command line, a double-click,
 * a drop, Open Recent) or be one of the files the app saved before. That way
 * a page that went wrong cannot read or overwrite other files.
 */

/** The largest file opened (a big Figma file is tens of megabytes). */
const MAX_BYTES = 1024 * 1024 * 1024;
const MAX_RECENT = 12;

const granted = new Set<string>();

function key(path: string): string {
  const full = resolve(path);
  return process.platform === 'win32' || process.platform === 'darwin' ? full.toLowerCase() : full;
}

export function grant(path: string): void {
  granted.add(key(path));
}

export function isGranted(path: string): boolean {
  return granted.has(key(path));
}

const dataPath = (name: string): string => join(app.getPath('userData'), name);

// ------------------------------------------------------------------ reading

/** Reads a file the app was given. Throws for one it was not, for a folder, or for one too large. */
export function readDiskFile(path: string): DiskFile {
  const full = resolve(path);
  if (!isGranted(full)) throw new Error('Evora was not given this file to open.');
  const stat = statSync(full);
  if (!stat.isFile()) throw new Error('This is not a file.');
  if (stat.size > MAX_BYTES) throw new Error('This file is too large to open.');
  const bytes = new Uint8Array(readFileSync(full));
  return { path: full, name: basename(full), bytes, mtimeMs: Math.floor(stat.mtimeMs) };
}

/** The files among command-line arguments (or a second launch's) that Evora opens. */
export function filesInArguments(argv: readonly string[], cwd: string): string[] {
  const found: string[] = [];
  for (const arg of argv) {
    if (!arg || arg.startsWith('-')) continue;
    if (diskFileKind(arg) === null) continue;
    const full = resolve(cwd, arg);
    try {
      if (statSync(full).isFile()) found.push(full);
    } catch {
      // Not a file that exists: ignored.
    }
  }
  return found;
}

export async function showOpenDialog(window: BrowserWindow | null): Promise<string | null> {
  const options: Electron.OpenDialogOptions = {
    title: 'Open',
    properties: ['openFile'],
    filters: [
      { name: 'Evora, Figma and SVG files', extensions: ['evora', 'opendesign', 'fig', 'svg'] },
      { name: 'Evora files', extensions: ['evora', 'opendesign'] },
      { name: 'Figma files', extensions: ['fig'] },
      { name: 'SVG files', extensions: ['svg'] },
    ],
  };
  const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
  const path = result.canceled ? undefined : result.filePaths[0];
  if (!path) return null;
  grant(path);
  return path;
}

// ------------------------------------------------------------------ saving

function lastFolder(): string {
  const recent = recentFiles()[0];
  return recent ? dirname(recent) : app.getPath('documents');
}

/** Writes a file so that a crash in the middle leaves the old one whole: a temporary file beside it, then a rename. */
function writeAtomically(path: string, data: string | Uint8Array): void {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.saving`);
  try {
    writeFileSync(temporary, data);
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

export async function saveFile(window: BrowserWindow | null, request: SaveRequest): Promise<SavedFile | null> {
  const extension = request.kind === 'fig' ? '.fig' : '.evora';
  let path = request.path && isGranted(request.path) ? resolve(request.path) : null;
  if (path === null) {
    const options: Electron.SaveDialogOptions = {
      title: request.kind === 'fig' ? 'Save a copy as a Figma file' : 'Save',
      defaultPath: join(lastFolder(), basename(request.suggestedName)),
      filters: request.kind === 'fig' ? [{ name: 'Figma file', extensions: ['fig'] }] : [{ name: 'Evora file', extensions: ['evora'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    };
    const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return null;
    path = resolve(result.filePath);
    if (extname(path).toLowerCase() !== extension) path += extension;
    grant(path);
  }
  const data = typeof request.data === 'string' ? request.data : Buffer.from(request.data.buffer, request.data.byteOffset, request.data.byteLength);
  writeAtomically(path, data);
  addRecent(path);
  return { path, mtimeMs: Math.floor(statSync(path).mtimeMs) };
}

// ------------------------------------------------------------------ links between library files and disk files

type Links = Record<string, DiskLink>;
const linksPath = (): string => dataPath('disk-links.json');

function readLinks(): Links {
  return readJson<Links>(linksPath(), {});
}

/** At start: the paths of linked files were given to the app before, and stay given. */
export function grantKnownPaths(): void {
  for (const link of Object.values(readLinks())) grant(link.path);
  for (const path of recentFiles()) grant(path);
}

export function linkFor(fileId: string): DiskLink | null {
  return readLinks()[fileId] ?? null;
}

export function linkByPath(path: string): DiskLink | null {
  const wanted = key(path);
  return Object.values(readLinks()).find((link) => key(link.path) === wanted) ?? null;
}

export function setLink(link: DiskLink): void {
  if (!isGranted(link.path)) throw new Error('Evora was not given this file.');
  const links = readLinks();
  // One library file per disk file.
  for (const [id, other] of Object.entries(links)) if (key(other.path) === key(link.path)) delete links[id];
  links[link.fileId] = { fileId: link.fileId, path: resolve(link.path), savedUpdatedAt: link.savedUpdatedAt, mtimeMs: link.mtimeMs };
  writeJson(linksPath(), links);
}

export function removeLink(fileId: string): void {
  const links = readLinks();
  if (!(fileId in links)) return;
  delete links[fileId];
  writeJson(linksPath(), links);
}

// ------------------------------------------------------------------ recent files

const recentPath = (): string => dataPath('recent-files.json');

export function recentFiles(): string[] {
  const list = readJson<unknown>(recentPath(), []);
  return Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string' && existsSync(item)) : [];
}

let onRecentChange: () => void = () => {};
export function watchRecent(callback: () => void): void {
  onRecentChange = callback;
}

/** Remembers a file in the app's Open Recent list and the system's (the Jump List on Windows, the Dock on macOS). */
export function addRecent(path: string): void {
  const full = resolve(path);
  const list = [full, ...recentFiles().filter((item) => key(item) !== key(full))].slice(0, MAX_RECENT);
  writeJson(recentPath(), list);
  app.addRecentDocument(full);
  onRecentChange();
}

export function clearRecent(): void {
  writeJson(recentPath(), []);
  app.clearRecentDocuments();
  onRecentChange();
}

// ------------------------------------------------------------------ recovery copies

const recoveryDir = (): string => dataPath('recovery');
const safeId = (fileId: string): string => fileId.replace(/[^0-9A-Za-z_-]/g, '_').slice(0, 120);

export function writeRecovery(entry: Omit<RecoveryEntry, 'savedAt'>): void {
  if (!isGranted(entry.path)) throw new Error('Evora was not given this file.');
  mkdirSync(recoveryDir(), { recursive: true });
  const full: RecoveryEntry = { ...entry, path: resolve(entry.path), savedAt: new Date().toISOString() };
  writeJson(join(recoveryDir(), `${safeId(entry.fileId)}.json`), full);
}

export function clearRecovery(fileId: string): void {
  rmSync(join(recoveryDir(), `${safeId(fileId)}.json`), { force: true });
}

/** The recovery copies left by a session that did not end normally. */
export function pendingRecoveries(): RecoveryEntry[] {
  if (!existsSync(recoveryDir())) return [];
  const found: RecoveryEntry[] = [];
  for (const name of readdirSync(recoveryDir())) {
    if (!name.endsWith('.json')) continue;
    const entry = readJson<RecoveryEntry | null>(join(recoveryDir(), name), null);
    if (entry && typeof entry.fileId === 'string' && typeof entry.text === 'string' && typeof entry.path === 'string') found.push(entry);
  }
  return found;
}
