import { currentAuth } from './account';
import { ApiError, type ApiOptions, type BranchFields } from './api';

export type { BranchFields, FileBranch } from './api';
import { API_BASE, type DocInfo, type UserRef } from './protocol';

/**
 * Advanced file management (Phase 9): projects (folders) inside a workspace,
 * moving and duplicating shared files, favourites, recents, search, and the
 * trash, on the collaboration server (the routes are listed in
 * `server/community.ts`); and, for the files on this device, favourites and
 * recents kept in this browser's localStorage.
 */

export interface Project {
  id: string;
  workspaceId: string;
  name: string;
  createdAt: string;
  fileCount: number;
}

/**
 * A shared file, with where it is filed and what it is to the person asking.
 * Lists leave branches out: a main file carries its open branches in
 * `branches` (see `BranchFields` in api.ts).
 */
export interface FileInfo extends DocInfo, BranchFields {
  projectId: string | null;
  projectName: string | null;
  /** The workspace's name, when the person asking is one of its members. */
  workspaceName: string | null;
  favorite: boolean;
  openedAt: string | null;
}

export interface TrashedFile {
  id: string;
  name: string;
  workspaceId: string;
  owner: UserRef;
  trashedBy: UserRef;
  trashedAt: string;
  purgeAt: string;
  canDelete: boolean;
}

// ------------------------------------------------------------------ requests

/**
 * The way the API clients of Phase 9 send requests: the same credentials,
 * errors and base as `createApi` in api.ts.
 */
export function createRequester(options: ApiOptions = {}) {
  const base = options.base ?? API_BASE;
  const auth = options.auth ?? currentAuth;
  const send = (input: string, init: RequestInit): Promise<Response> => (options.fetch ? options.fetch(input, init) : globalThis.fetch(input, init));

  async function raw(method: string, path: string, init: { body?: BodyInit; contentType?: string } = {}): Promise<Response> {
    const headers: Record<string, string> = {};
    if (init.contentType) headers['Content-Type'] = init.contentType;
    const { token, guestToken } = auth();
    if (token) headers.Authorization = `Bearer ${token}`;
    else if (guestToken) headers['X-Evora-Guest'] = guestToken;
    let response: Response;
    try {
      response = await send(`${base}${path}`, { method, headers, body: init.body });
    } catch {
      throw new ApiError('The collaboration server could not be reached. Check that it is running and that you are online.', 0);
    }
    if (!response.ok) {
      let message = `The collaboration server answered with an error (${response.status}).`;
      try {
        const data = (await response.json()) as { error?: unknown };
        if (typeof data.error === 'string' && data.error) message = data.error;
      } catch {
        // Not JSON: the status says what there is to say.
      }
      throw new ApiError(message, response.status);
    }
    return response;
  }

  async function json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await raw(method, path, body === undefined ? {} : { body: JSON.stringify(body), contentType: 'application/json' });
    const text = await response.text();
    if (!text) return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ApiError('The collaboration server sent an answer that could not be read.', response.status);
    }
  }

  return { base, raw, json };
}

const id = (value: string): string => encodeURIComponent(value);

export function createFilesApi(options: ApiOptions = {}) {
  const { json } = createRequester(options);
  return {
    // ------------------------------------------------------------ projects
    projects: (workspaceId: string) => json<Project[]>('GET', `/workspaces/${id(workspaceId)}/projects`),
    createProject: (workspaceId: string, name: string) => json<Project>('POST', `/workspaces/${id(workspaceId)}/projects`, { name }),
    renameProject: (projectId: string, name: string) => json<Project>('PATCH', `/projects/${id(projectId)}`, { name }),
    /** Deletes a project; its files stay in the workspace, at its root. */
    deleteProject: (projectId: string) => json<Record<string, never>>('DELETE', `/projects/${id(projectId)}`),

    // ------------------------------------------------------------ files
    workspaceFiles: (workspaceId: string) => json<FileInfo[]>('GET', `/workspaces/${id(workspaceId)}/files`),
    /** Moves a file to a project (null: the workspace's root), in its workspace or another one. */
    moveFile: (docId: string, to: { workspaceId?: string; projectId: string | null }) => json<FileInfo>('POST', `/documents/${id(docId)}/move`, to),
    duplicateFile: (docId: string, to: { workspaceId?: string; projectId?: string | null; name?: string } = {}) => json<FileInfo>('POST', `/documents/${id(docId)}/duplicate`, to),

    // ------------------------------------------------------------ trash
    /**
     * Moves a file to its workspace's trash (the same as DELETE /documents/:id): nobody can open it until it is restored
     * (opening it fails with status 410, "This file is in the trash"); it is deleted for good after 30 days.
     */
    trashFile: (docId: string) => json<Record<string, never>>('POST', `/documents/${id(docId)}/trash`),
    trash: (workspaceId: string) => json<TrashedFile[]>('GET', `/workspaces/${id(workspaceId)}/trash`),
    restoreFile: (docId: string) => json<FileInfo>('POST', `/trash/${id(docId)}/restore`),
    deleteForever: (docId: string) => json<Record<string, never>>('DELETE', `/trash/${id(docId)}`),

    // ------------------------------------------------------------ favourites, recents, search
    favorites: () => json<FileInfo[]>('GET', '/favorites'),
    setFavorite: (docId: string, favorite: boolean) => json<Record<string, never>>(favorite ? 'PUT' : 'DELETE', `/favorites/${id(docId)}`),
    recents: () => json<FileInfo[]>('GET', '/recents'),
    noteOpened: (docId: string) => json<Record<string, never>>('POST', `/recents/${id(docId)}`),
    search: (q: string) => json<FileInfo[]>('GET', `/files/search?q=${encodeURIComponent(q)}`),
  };
}

export type FilesApi = ReturnType<typeof createFilesApi>;

/** The client the application uses. */
export const filesApi: FilesApi = createFilesApi();

// ------------------------------------------------------------------ the files on this device

export const LOCAL_FAVORITES_KEY = 'evora:favorites';
export const LOCAL_RECENTS_KEY = 'evora:recents';
const MAX_LOCAL_RECENTS = 30;

export interface LocalRecent {
  id: string;
  openedAt: string;
}

type KeyStore = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStore(): KeyStore | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

const listeners = new Set<() => void>();
let version = 0;

/** Calls `listener` when the favourites or recents of this device change. Returns how to stop. */
export function subscribeLocalFiles(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** A number that changes whenever the favourites or recents of this device change (for useSyncExternalStore). */
export function localFilesVersion(): number {
  return version;
}

function changed(): void {
  version++;
  for (const listener of listeners) listener();
}

function read<T>(key: string, store: KeyStore | null, valid: (value: unknown) => value is T): T[] {
  try {
    const parsed = JSON.parse(store?.getItem(key) ?? '[]') as unknown;
    return Array.isArray(parsed) ? parsed.filter(valid) : [];
  } catch {
    return [];
  }
}

function write(key: string, value: unknown, store: KeyStore | null): void {
  try {
    store?.setItem(key, JSON.stringify(value));
  } catch {
    // Full or not allowed: kept for this session only.
  }
  changed();
}

const isString = (value: unknown): value is string => typeof value === 'string';
const isRecent = (value: unknown): value is LocalRecent =>
  !!value && typeof value === 'object' && typeof (value as LocalRecent).id === 'string' && typeof (value as LocalRecent).openedAt === 'string';

/** The IDs of this device's files that are favourites. */
export function localFavorites(store: KeyStore | null = defaultStore()): string[] {
  return read(LOCAL_FAVORITES_KEY, store, isString);
}

export function setLocalFavorite(fileId: string, favorite: boolean, store: KeyStore | null = defaultStore()): void {
  const current = localFavorites(store).filter((entry) => entry !== fileId);
  write(LOCAL_FAVORITES_KEY, favorite ? [fileId, ...current] : current, store);
}

/** This device's files opened lately, the latest first. */
export function localRecents(store: KeyStore | null = defaultStore()): LocalRecent[] {
  return read(LOCAL_RECENTS_KEY, store, isRecent);
}

export function noteLocalOpened(fileId: string, store: KeyStore | null = defaultStore(), at: Date = new Date()): void {
  const rest = localRecents(store).filter((entry) => entry.id !== fileId);
  write(LOCAL_RECENTS_KEY, [{ id: fileId, openedAt: at.toISOString() }, ...rest].slice(0, MAX_LOCAL_RECENTS), store);
}

/** Forgets a file of this device that was deleted. */
export function forgetLocalFile(fileId: string, store: KeyStore | null = defaultStore()): void {
  write(LOCAL_FAVORITES_KEY, localFavorites(store).filter((entry) => entry !== fileId), store);
  write(LOCAL_RECENTS_KEY, localRecents(store).filter((entry) => entry.id !== fileId), store);
}

// ------------------------------------------------------------------ sorting and filtering

export type SortKey = 'edited' | 'created' | 'name';

/** Files sorted as Figma's file browser sorts them: last edited and created newest first, names A to Z. */
export function sortFiles<T extends { name: string; updatedAt: string; createdAt: string }>(files: readonly T[], key: SortKey): T[] {
  const out = [...files];
  if (key === 'name') out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
  else {
    const field = key === 'edited' ? 'updatedAt' : 'createdAt';
    out.sort((a, b) => (a[field] < b[field] ? 1 : a[field] > b[field] ? -1 : 0));
  }
  return out;
}

/** Files whose name has every word of `text`, in any case. */
export function filterFiles<T extends { name: string }>(files: readonly T[], text: string): T[] {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...files];
  return files.filter((file) => {
    const name = file.name.toLowerCase();
    return words.every((word) => name.includes(word));
  });
}
