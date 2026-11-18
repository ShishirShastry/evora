import { createStore, type StoreApi } from 'zustand/vanilla';
import { findLibraryUpdates, importLibrary, isNewerVersion, listLibraries, publicationImageHashes, updatesToOffer, type LibraryUpdate, type Publication } from '../core';
import { loadDeclinedUpdates, loadLibrary, saveDeclinedUpdates, type SmallStore } from '../persistence/libraries';
import type { DocumentStorage, StoredAsset } from '../persistence/storage';
import type { EditorStore } from '../state/editorStore';
import { currentAuth } from './account';
import { ApiError, type ApiOptions } from './api';
import { createRequester } from './files';

/**
 * Team libraries: the libraries published by shared files on the
 * collaboration server, for any file to use, and the check for newer
 * versions of the libraries a file uses (on this device or the server).
 *
 * The routes (JSON under /api; errors are a status and `{ error }`):
 * - GET /libraries[?workspace=<id>] -> { libraries: TeamLibrarySummary[], truncated?: true }   the published shared files the person can view
 * - GET /documents/:id/library      -> { id, name, publication }             viewer access; 404 when not published
 * - GET /documents/:id/assets/:hash -> the bytes of an image                  viewer access (the per-document image route)
 *
 * Publishing is not a route: a shared file publishes by changing its
 * `d:publication` register over the live connection, as any edit (editors
 * only). A file that adds a team library takes a copy of what it published,
 * as with a library on this device, so it opens and draws without the server.
 */

// ------------------------------------------------------------------ what the server sends

/** A published shared file, as the list of team libraries shows it. */
export interface TeamLibrarySummary {
  /** The shared document's ID: the library's ID in every file that adds it. */
  id: string;
  name: string;
  workspaceId: string | null;
  workspaceName: string | null;
  version: number;
  publishedAt: string;
  components: number;
  styles: number;
  variables: number;
}

/** What a team library publishes, in the shape `importLibrary` takes. */
export interface TeamLibrary {
  id: string;
  name: string;
  publication: Publication;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0);

/** One entry of the list, or null when it is not one (an entry a newer or broken server sent that this app cannot use). */
export function readSummary(value: unknown): TeamLibrarySummary | null {
  if (!isObject(value)) return null;
  const { id, name, workspaceId, workspaceName, version, publishedAt } = value;
  if (typeof id !== 'string' || !id || typeof name !== 'string' || typeof version !== 'number' || !Number.isFinite(version)) return null;
  return {
    id,
    name,
    workspaceId: typeof workspaceId === 'string' ? workspaceId : null,
    workspaceName: typeof workspaceName === 'string' ? workspaceName : null,
    version,
    publishedAt: typeof publishedAt === 'string' ? publishedAt : '',
    components: count(value.components),
    styles: count(value.styles),
    variables: count(value.variables),
  };
}

/**
 * A publication as the server sent it, or null when it does not have the
 * shape of one. What is inside is checked again, like an opened file, when it
 * is added (`importLibrary` repairs it).
 */
export function readPublication(value: unknown): Publication | null {
  if (!isObject(value)) return null;
  const { version, publishedAt, roots, nodes, styles, variables, variableCollections, assets } = value;
  if (typeof version !== 'number' || !Number.isFinite(version) || typeof publishedAt !== 'string') return null;
  if (!Array.isArray(roots) || !roots.every((root) => typeof root === 'string')) return null;
  if (![nodes, styles, variables, variableCollections, assets].every(isObject)) return null;
  return value as unknown as Publication;
}

const UNREADABLE = 'The collaboration server sent a library that could not be read.';

const id = (value: string): string => encodeURIComponent(value);

/** A client for the team library routes, with the same credentials and errors as the rest of the API (`ApiError`). */
export function createLibrariesApi(options: ApiOptions = {}) {
  const { raw, json } = createRequester(options);
  /** The list as the server sent it, and whether it was cut (the server lists at most a few hundred). */
  const page = async (workspaceId?: string): Promise<{ libraries: TeamLibrarySummary[]; truncated: boolean }> => {
    const answer = await json<{ libraries?: unknown; truncated?: unknown }>('GET', `/libraries${workspaceId ? `?workspace=${id(workspaceId)}` : ''}`);
    if (!Array.isArray(answer.libraries)) throw new ApiError(UNREADABLE, 200);
    return { libraries: answer.libraries.map(readSummary).filter((entry): entry is TeamLibrarySummary => entry !== null), truncated: answer.truncated === true };
  };
  return {
    /** The published libraries the person can view, by workspace name then name; one workspace's only when given. */
    list: async (workspaceId?: string): Promise<TeamLibrarySummary[]> => (await page(workspaceId)).libraries,
    /** The same, saying whether the server cut the list short: the libraries past the cut are then asked for one by one. */
    page,
    /** A shared file's current publication. 404 when it is not published. */
    get: async (docId: string): Promise<TeamLibrary> => {
      const answer = await json<{ id?: unknown; name?: unknown; publication?: unknown }>('GET', `/documents/${id(docId)}/library`);
      const publication = readPublication(answer.publication);
      if (!publication) throw new ApiError(UNREADABLE, 200);
      return { id: typeof answer.id === 'string' && answer.id ? answer.id : docId, name: typeof answer.name === 'string' ? answer.name : '', publication };
    },
    /** The bytes of an image a shared file uses (the per-document image route). */
    getAsset: async (docId: string, hash: string): Promise<StoredAsset> => {
      const response = await raw('GET', `/documents/${id(docId)}/assets/${id(hash)}`);
      return { mimeType: response.headers.get('Content-Type') ?? 'application/octet-stream', bytes: await response.arrayBuffer() };
    },
  };
}

export type LibrariesApi = ReturnType<typeof createLibrariesApi>;

/** The client the application uses. */
export const librariesApi: LibrariesApi = createLibrariesApi();

// ------------------------------------------------------------------ what went wrong, in words

export type TeamProblemKind = 'offline' | 'signed-out' | 'denied' | 'gone' | 'other';

/** What a failed request for team libraries means for the person, and what to tell them. */
export function teamLibraryProblem(error: unknown): { kind: TeamProblemKind; message: string } {
  const status = error instanceof ApiError ? error.status : 0;
  if (!(error instanceof ApiError) || status === 0 || status === 502 || status === 503 || status === 504) {
    return { kind: 'offline', message: 'You are offline, or the collaboration server cannot be reached. Team libraries show again when it can be.' };
  }
  if (status === 401) return { kind: 'signed-out', message: 'Your session has ended. Sign in to use your team’s libraries.' };
  if (status === 403) return { kind: 'denied', message: 'You no longer have access to this library.' };
  if (status === 404) return { kind: 'gone', message: 'This library is no longer published.' };
  if (status === 410) return { kind: 'gone', message: 'This library’s file is in the trash.' };
  return { kind: 'other', message: error.message };
}

// ------------------------------------------------------------------ taking a team library

/**
 * How long to wait before each try of a library's image: the library's editor
 * may still be uploading it, so a missing image is asked for again a few
 * times (over about eight seconds), as a shared file's own images are.
 */
export const IMAGE_RETRY_DELAYS: readonly number[] = [0, 500, 1000, 2000, 4000];

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** One image of a library, asked for again while it may still be on its way; null when it cannot be had. */
async function fetchImage(api: LibrariesApi, libraryId: string, hash: string, delays: readonly number[]): Promise<StoredAsset | null> {
  for (const delay of delays) {
    if (delay > 0) await wait(delay);
    try {
      return await api.getAsset(libraryId, hash);
    } catch (error) {
      // Not allowed, or the file is gone: asking again changes nothing.
      if (error instanceof ApiError && [401, 403, 410].includes(error.status)) return null;
    }
  }
  return null;
}

/**
 * Fetches a team library's publication and the images its components and
 * styles use (not every image its file ever had), keeping the images on this
 * device by hash, where every file finds its images. Images this device
 * already has are not fetched again; those fetched now are in `fetched` (a
 * shared file that adds the library sends them to its own document). An image
 * that cannot be fetched does not stop the library from being added; its hash
 * is in `missingImages`.
 */
export async function loadTeamLibrary(
  api: LibrariesApi,
  storage: DocumentStorage,
  libraryId: string,
  options: { retryDelays?: readonly number[] } = {},
): Promise<{ library: TeamLibrary; missingImages: string[]; fetched: string[] }> {
  const library = await api.get(libraryId);
  const delays = options.retryDelays ?? IMAGE_RETRY_DELAYS;
  const missingImages: string[] = [];
  const fetched: string[] = [];
  await Promise.all(
    publicationImageHashes(library.publication).map(async (hash) => {
      if (await storage.loadAsset(hash).catch(() => null)) return;
      const asset = await fetchImage(api, libraryId, hash, delays);
      const kept = asset !== null && (await storage.saveAsset(hash, asset).then(() => true, () => false));
      (kept ? fetched : missingImages).push(hash);
    }),
  );
  return { library, missingImages: missingImages.sort(), fetched: fetched.sort() };
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** What to say when some of a library's images could not be fetched. */
export function missingImagesNote(name: string, missing: number): string {
  return `${plural(missing, 'image', 'images')} of “${name}” could not be downloaded and will show as missing.`;
}

// ------------------------------------------------------------------ newer versions

/** Where a library's latest version was found. */
export type LibrarySource = 'device' | 'team';

/** A library's latest version, and where it was found. */
export interface LatestLibrary {
  id: string;
  name: string;
  version: number;
  /** When that version was published (ISO), when known: tells a library published again from version 1 apart. */
  publishedAt?: string;
  source: LibrarySource;
}

export interface LibraryUpdatesState {
  /** The latest versions found, of this device's libraries and the team's; null before the first look. */
  latest: LatestLibrary[] | null;
  /** By library ID, the version someone chose "Not now" for in this file. */
  declined: Record<string, number>;
  /** While updates are being fetched and applied. */
  busy: boolean;
  /** What went wrong the last time, in words; empty when nothing did. */
  problem: string;
}

/** An update of a library a file uses, with where it comes from. */
export type FoundUpdate = LibraryUpdate & { latest: LatestLibrary };

export interface LibraryUpdatesOptions {
  editor: EditorStore;
  storage: DocumentStorage;
  api?: LibrariesApi;
  /** Whether someone is signed in with an account, so that the server can be asked (it lists no libraries for a guest). The account on this device by default. */
  signedIn?: () => boolean;
  /** Where declined updates are kept; this browser's local storage by default. */
  declinedStore?: SmallStore | null;
  /**
   * For a shared file: sends images now on this device to the file's own copy
   * on the server (the live connection's `uploadAssets`). Called with the
   * images a team library brought that this device did not have before, even
   * when the file already lists them: an image that could not be downloaded
   * when the library was added was never sent.
   */
  uploadImages?: (hashes: string[]) => void;
  /** How long to wait before each try of a library's image (`IMAGE_RETRY_DELAYS` by default). */
  imageRetryDelays?: readonly number[];
}

/** The updates a file can take now, given what is known: every newer version, declined or not. */
export function updatesOf(state: Pick<LibraryUpdatesState, 'latest'>, editor: EditorStore): FoundUpdate[] {
  return state.latest ? findLibraryUpdates(listLibraries(editor.getState().doc), state.latest) : [];
}

/**
 * The updates of the libraries a file uses: looking for newer versions on
 * this device and on the server, taking them (all at once, as one undo step),
 * taking or adding one library, and declining ("Not now", until the next
 * version). Shared by the notice in the editor and the Libraries dialog.
 */
export function createLibraryUpdates(options: LibraryUpdatesOptions) {
  const { editor, storage } = options;
  const api = options.api ?? librariesApi;
  const signedIn =
    options.signedIn ??
    (() => {
      // A guest is in no workspace and the server lists no libraries for one, so only an account asks.
      return Boolean(currentAuth().token);
    });
  const declinedStore = options.declinedStore;
  const fileId = editor.getState().doc.id;
  const store: StoreApi<LibraryUpdatesState> = createStore<LibraryUpdatesState>(() => ({
    latest: null,
    declined: loadDeclinedUpdates(fileId, declinedStore),
    busy: false,
    problem: '',
  }));
  let checks = 0;

  /** Replaces what is known from one source (every entry from it), keeping the other's. */
  const learn = (source: LibrarySource, entries: readonly Omit<LatestLibrary, 'source'>[]): void => {
    const kept = (store.getState().latest ?? []).filter((entry) => entry.source !== source);
    const learned = entries.map((entry): LatestLibrary => {
      const out: LatestLibrary = { id: entry.id, name: entry.name, version: entry.version, source };
      if (entry.publishedAt) out.publishedAt = entry.publishedAt;
      return out;
    });
    store.setState({ latest: [...kept, ...learned] });
  };

  /** Replaces, or with null forgets, what is known of one library from one source. */
  const learnOne = (source: LibrarySource, libraryId: string, entry: Omit<LatestLibrary, 'source'> | null): void => {
    const others = (store.getState().latest ?? []).filter((known) => known.source === source && known.id !== libraryId);
    learn(source, entry ? [...others, entry] : others);
  };

  const versionOf = (library: TeamLibrary): Omit<LatestLibrary, 'source'> => ({ id: library.id, name: library.name, version: library.publication.version, publishedAt: library.publication.publishedAt });

  /**
   * Looks for newer versions of the libraries the file uses: each on this
   * device, and the team's on the server (one request) when someone is signed
   * in. Nothing is asked when the file uses no library. A server that cannot
   * be reached leaves what was known of the team's as it was; with nobody
   * signed in, or the list refused (401, 403), it is forgotten. When the
   * server cut its list short, the libraries the file uses that it left out
   * (and that are not on this device) are asked for one by one.
   */
  const check = async (): Promise<void> => {
    const used = listLibraries(editor.getState().doc);
    if (used.length === 0) return;
    const run = ++checks;
    const device: Omit<LatestLibrary, 'source'>[] = [];
    for (const library of used) {
      const found = await loadLibrary(storage, library.id).catch(() => null);
      if (found) device.push(versionOf(found));
    }
    let team: Omit<LatestLibrary, 'source'>[] | null = null;
    let forget = !signedIn();
    if (!forget) {
      const listed = await api.page().catch((error: unknown) => {
        const kind = teamLibraryProblem(error).kind;
        forget = kind === 'signed-out' || kind === 'denied';
        return null;
      });
      if (listed) {
        team = listed.libraries;
        if (listed.truncated) {
          const known = new Set([...listed.libraries, ...device].map((entry) => entry.id));
          for (const library of used) {
            if (known.has(library.id)) continue;
            const got = await api.get(library.id).catch(() => null);
            if (got) team.push(versionOf({ ...got, name: got.name || library.name }));
          }
        }
      }
    }
    if (run !== checks) return;
    learn('device', device);
    if (team) learn('team', team);
    else if (forget) learn('team', []);
  };

  /**
   * Fetches one library's latest publication: from this device's files or
   * from the server (with its images; `fetched` are those this device did not
   * have). One that can never be taken (no longer published, access gone, in
   * the trash, signed out) is forgotten, so that it is not offered again.
   */
  const fetchLibrary = async (libraryId: string, source: LibrarySource, name: string): Promise<{ library: TeamLibrary | null; note: string; fetched: string[] }> => {
    if (source === 'device') {
      const library = await loadLibrary(storage, libraryId).catch(() => null);
      if (!library) learnOne('device', libraryId, null);
      return library ? { library, note: '', fetched: [] } : { library: null, note: `“${name}” is no longer published on this device.`, fetched: [] };
    }
    try {
      const { library, missingImages, fetched } = await loadTeamLibrary(api, storage, libraryId, { retryDelays: options.imageRetryDelays });
      return { library: { ...library, name: library.name || name }, note: missingImages.length > 0 ? missingImagesNote(library.name || name, missingImages.length) : '', fetched };
    } catch (error) {
      const problem = teamLibraryProblem(error);
      if (problem.kind === 'denied' || problem.kind === 'gone' || problem.kind === 'signed-out') learnOne('team', libraryId, null);
      return { library: null, note: `“${name}”: ${problem.message}`, fetched: [] };
    }
  };

  /** The version of a library the file has now, if it uses it. */
  const usedVersion = (libraryId: string) => listLibraries(editor.getState().doc).find((library) => library.id === libraryId) ?? null;

  /** Sends the images a library brought to a shared file's own copy on the server. */
  const upload = (hashes: readonly string[]): void => {
    if (hashes.length > 0) options.uploadImages?.([...new Set(hashes)].sort());
  };

  const READ_ONLY = 'You can no longer edit this file.';

  /**
   * Takes the newest version of the libraries given (by default every update
   * that is offered, declined ones left out), as one undo step. Resolves to
   * whether anything was taken.
   */
  const accept = async (only?: readonly string[]): Promise<boolean> => {
    const state = store.getState();
    const all = updatesOf(state, editor);
    const chosen = only ? all.filter((update) => only.includes(update.id)) : updatesToOffer(all, state.declined);
    if (chosen.length === 0 || state.busy) return false;
    store.setState({ busy: true, problem: '' });
    const taken: TeamLibrary[] = [];
    const fetched: string[] = [];
    const notes: string[] = [];
    for (const update of chosen) {
      const { library, note, fetched: brought } = await fetchLibrary(update.id, update.latest.source, update.name);
      if (note) notes.push(note);
      if (!library) continue;
      // What was fetched is what is known now: newer still than the list said, or (the list being behind) not newer at all.
      learnOne(update.latest.source, library.id, versionOf(library));
      const have = usedVersion(library.id);
      if (have && !isNewerVersion(library.publication, have)) {
        notes.push(`“${library.name}” has no newer version than the one this file has.`);
        continue;
      }
      taken.push(library);
      fetched.push(...brought);
    }
    if (taken.length > 0 && editor.getState().readOnly) {
      // Edit rights were taken away while the libraries were fetched: nothing can be changed.
      store.setState({ busy: false, problem: [READ_ONLY, ...notes].join(' ') });
      return false;
    }
    if (taken.length > 0) {
      editor.getState().apply(taken.length === 1 ? 'Update library' : 'Update libraries', (doc) => taken.reduce((next, library) => importLibrary(next, library), doc));
      upload(fetched);
    }
    store.setState({ busy: false, problem: notes.join(' ') });
    return taken.length > 0;
  };

  /**
   * Adds a library to the file (or takes its latest version), from this
   * device or from the server, as one undo step labelled `label`. Resolves to
   * what went wrong, in words, or '' when it was added (or when another is
   * being taken already: nothing is done then). A version older than the one
   * the file has is not taken.
   */
  const take = async (libraryId: string, source: LibrarySource, name: string, label: string): Promise<string> => {
    if (store.getState().busy) return '';
    store.setState({ busy: true, problem: '' });
    const { library, note, fetched } = await fetchLibrary(libraryId, source, name);
    let problem = library ? '' : note;
    if (library) {
      const have = usedVersion(library.id);
      if (editor.getState().readOnly) {
        problem = `You can no longer edit this file, so “${library.name}” was not ${have ? 'updated' : 'added'}.`;
      } else if (have && isNewerVersion(have, library.publication)) {
        learnOne(source, library.id, versionOf(library));
        problem = `“${library.name}” has no newer version than the one this file has.`;
      } else {
        editor.getState().apply(label, (doc) => importLibrary(doc, library));
        learnOne(source, library.id, versionOf(library));
        upload(fetched);
      }
    }
    store.setState({ busy: false, problem: library && !problem ? note : '' });
    return problem;
  };

  /** "Not now": the updates offered now are not offered again in this file until a newer version is published. */
  const decline = (): void => {
    const state = store.getState();
    const declined = { ...state.declined };
    for (const update of updatesToOffer(updatesOf(state, editor), state.declined)) declined[update.id] = update.to;
    saveDeclinedUpdates(fileId, declined, declinedStore);
    store.setState({ declined });
  };

  /** Whether updates can be taken in this file now (someone who may only view it is never offered any). */
  const canTake = (): boolean => !editor.getState().readOnly;

  return { store, check, learn, accept, take, decline, canTake };
}

export type LibraryUpdates = ReturnType<typeof createLibraryUpdates>;
