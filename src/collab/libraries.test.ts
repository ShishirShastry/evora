import { describe, expect, it, vi } from 'vitest';
import {
  addLayer,
  createComponent,
  createDocument,
  createStyle,
  findLibraryUpdates,
  getPages,
  imagePaint,
  importLibrary,
  listLibraries,
  mirrorId,
  publicationImageHashes,
  publishLibrary,
  solidPaint,
  updatesToOffer,
  updateStyle,
  type Document,
  type NodeId,
  unpublishLibrary,
  type Publication,
} from '../core';
import { saveDocument } from '../persistence/files';
import { loadDeclinedUpdates, type SmallStore } from '../persistence/libraries';
import { MemoryStorage } from '../persistence/storage';
import { createEditorStore } from '../state/editorStore';
import { ApiError } from './api';
import { createLibrariesApi, createLibraryUpdates, loadTeamLibrary, missingImagesNote, readPublication, teamLibraryProblem, updatesOf, type TeamLibrarySummary } from './libraries';

/**
 * Team libraries, for the app: the client for GET /api/libraries and
 * GET /api/documents/:id/library (with a fake fetch), fetching a library's
 * images, which libraries a file uses have newer versions, and taking and
 * declining them.
 */

const AT = '2026-11-18T12:00:00.000Z';
const HASH = 'a'.repeat(64);
/** An image the library's file once had, that no published component or style uses. */
const UNUSED = 'b'.repeat(64);
const RED = { r: 1, g: 0, b: 0 };
const GREEN = { r: 0, g: 1, b: 0 };

/** A library file: a red component whose fill is a colour style, with an icon (an image) inside it; published. */
function kitDocument(id = 'kit-doc'): { doc: Document; component: NodeId; style: string } {
  let doc: Document = { ...createDocument('Kit'), id };
  const pageId = (getPages(doc)[0] as { id: NodeId }).id;
  const added = addLayer(doc, 'FRAME', pageId, { x: 0, y: 0, width: 100, height: 40, name: 'Button', fills: [solidPaint(RED)] });
  const icon = addLayer(added.doc, 'RECTANGLE', added.id, { x: 4, y: 4, width: 16, height: 16, name: 'Icon', fills: [imagePaint(HASH)] });
  doc = (createComponent(icon.doc, [added.id]) as { doc: Document }).doc;
  const styled = createStyle(doc, added.id, 'fills', 'Brand') as { doc: Document; id: string };
  doc = { ...styled.doc, assets: { [HASH]: { mimeType: 'image/png', width: 1, height: 1, name: 'dot.png' } } };
  return { doc: publishLibrary(doc, AT), component: added.id, style: styled.id };
}

const summary = (overrides: Partial<TeamLibrarySummary> = {}): TeamLibrarySummary => ({
  id: 'kit-doc',
  name: 'Kit',
  workspaceId: 'w1',
  workspaceName: 'Design team',
  version: 1,
  publishedAt: AT,
  components: 1,
  styles: 1,
  variables: 0,
  ...overrides,
});

interface Call {
  url: string;
  headers: Record<string, string>;
}

/** A fake fetch answering from a table of routes; every call is recorded with its headers. */
function fakeFetch(routes: Record<string, () => Response | Promise<Response>>) {
  const calls: Call[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, headers: { ...(init.headers as Record<string, string>) } });
    const route = routes[url];
    if (!route) return Response.json({ error: 'Not found.' }, { status: 404 });
    return route();
  };
  return { fetch, calls };
}

const signedIn = () => ({ token: 'session-1', guestToken: null });

describe('the team libraries client', () => {
  it('lists the libraries with the session, and one workspace when asked', async () => {
    const { fetch, calls } = fakeFetch({
      '/api/libraries': () => Response.json({ libraries: [summary(), summary({ id: 'icons', name: 'Icons', workspaceId: null, workspaceName: null, version: 3 })] }),
      '/api/libraries?workspace=w%201': () => Response.json({ libraries: [summary()] }),
    });
    const api = createLibrariesApi({ fetch, auth: signedIn });
    expect(await api.list()).toEqual([summary(), summary({ id: 'icons', name: 'Icons', workspaceId: null, workspaceName: null, version: 3 })]);
    expect(calls[0]?.headers.Authorization).toBe('Bearer session-1');
    expect(await api.list('w 1')).toEqual([summary()]);
  });

  it('sends a guest token for a guest, and leaves out entries it cannot read', async () => {
    const { fetch, calls } = fakeFetch({ '/api/libraries': () => Response.json({ libraries: [summary(), { id: 7 }, null, { id: 'x', name: 'X' }] }) });
    const api = createLibrariesApi({ fetch, auth: () => ({ token: null, guestToken: 'guest-1' }) });
    expect((await api.list()).map((entry) => entry.id)).toEqual(['kit-doc']);
    expect(calls[0]?.headers['X-Evora-Guest']).toBe('guest-1');
    expect(calls[0]?.headers.Authorization).toBeUndefined();
  });

  it('gets a library’s publication', async () => {
    const { doc } = kitDocument();
    const { fetch } = fakeFetch({ '/api/documents/kit-doc/library': () => Response.json({ id: 'kit-doc', name: 'Kit', publication: doc.publication }) });
    const got = await createLibrariesApi({ fetch, auth: signedIn }).get('kit-doc');
    expect(got.name).toBe('Kit');
    expect(got.publication.version).toBe(1);
    expect(got.publication.roots).toEqual(doc.publication?.roots);
  });

  it('says plainly when a library is not published (404), the session has ended (401) or access is gone (403)', async () => {
    const { fetch } = fakeFetch({
      '/api/documents/gone/library': () => Response.json({ error: 'This file is not published as a library.' }, { status: 404 }),
      '/api/documents/denied/library': () => Response.json({ error: 'You cannot open this file.' }, { status: 403 }),
      '/api/libraries': () => Response.json({ error: 'Sign in first.' }, { status: 401 }),
    });
    const api = createLibrariesApi({ fetch, auth: signedIn });
    const fail = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => error);

    const gone = await fail(api.get('gone'));
    expect(gone).toBeInstanceOf(ApiError);
    expect((gone as ApiError).status).toBe(404);
    expect(teamLibraryProblem(gone)).toEqual({ kind: 'gone', message: 'This library is no longer published.' });

    const denied = await fail(api.get('denied'));
    expect(teamLibraryProblem(denied)).toEqual({ kind: 'denied', message: 'You no longer have access to this library.' });

    const ended = await fail(api.list());
    expect(teamLibraryProblem(ended)).toEqual({ kind: 'signed-out', message: 'Your session has ended. Sign in to use your team’s libraries.' });
  });

  it('treats a server that cannot be reached as offline', async () => {
    const api = createLibrariesApi({
      fetch: async () => {
        throw new TypeError('Failed to fetch');
      },
      auth: signedIn,
    });
    const error = await api.list().then(
      () => null,
      (cause: unknown) => cause,
    );
    expect((error as ApiError).status).toBe(0);
    expect(teamLibraryProblem(error).kind).toBe('offline');
    expect(teamLibraryProblem(new ApiError('Bad gateway', 502)).kind).toBe('offline');
  });

  it('refuses an answer that is not a list of libraries or not a publication', async () => {
    const { fetch } = fakeFetch({
      '/api/libraries': () => Response.json({ nothing: true }),
      '/api/documents/odd/library': () => Response.json({ id: 'odd', name: 'Odd', publication: { version: 1, roots: 'x' } }),
    });
    const api = createLibrariesApi({ fetch, auth: signedIn });
    await expect(api.list()).rejects.toThrow('could not be read');
    await expect(api.get('odd')).rejects.toThrow('could not be read');
    expect(readPublication(null)).toBeNull();
  });
});

describe('fetching a team library with its images', () => {
  it('keeps the images it uses on this device, fetching only those it does not have', async () => {
    const { doc } = kitDocument();
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    const { fetch, calls } = fakeFetch({
      '/api/documents/kit-doc/library': () => Response.json({ id: 'kit-doc', name: 'Kit', publication: doc.publication }),
      [`/api/documents/kit-doc/assets/${HASH}`]: () => new Response(bytes, { headers: { 'Content-Type': 'image/png' } }),
    });
    const storage = new MemoryStorage();
    const api = createLibrariesApi({ fetch, auth: signedIn });
    const first = await loadTeamLibrary(api, storage, 'kit-doc');
    expect(first.missingImages).toEqual([]);
    expect(await storage.loadAsset(HASH)).toMatchObject({ mimeType: 'image/png' });
    expect(calls.filter((call) => call.url.includes('/assets/'))).toHaveLength(1);
    expect(calls.find((call) => call.url.includes('/assets/'))?.headers.Authorization).toBe('Bearer session-1');

    await loadTeamLibrary(api, storage, 'kit-doc');
    expect(calls.filter((call) => call.url.includes('/assets/'))).toHaveLength(1);
  });

  it('says which images could not be fetched, and still gives the library', async () => {
    const { doc } = kitDocument();
    const { fetch } = fakeFetch({ '/api/documents/kit-doc/library': () => Response.json({ id: 'kit-doc', name: 'Kit', publication: doc.publication }) });
    const result = await loadTeamLibrary(createLibrariesApi({ fetch, auth: signedIn }), new MemoryStorage(), 'kit-doc', { retryDelays: [0] });
    expect(result.library.id).toBe('kit-doc');
    expect(result.missingImages).toEqual([HASH]);
  });
});

describe('which libraries have newer versions', () => {
  const used = [
    { id: 'a', name: 'Alpha', version: 2 },
    { id: 'b', name: 'Beta', version: 1 },
    { id: 'c', name: 'Gamma', version: 4 },
  ];

  it('lists the used libraries whose latest version is newer, by name, with the newest found when there are two', () => {
    const updates = findLibraryUpdates(used, [
      { id: 'b', name: 'Beta', version: 3 },
      { id: 'a', name: 'Alpha (renamed)', version: 3 },
      { id: 'c', name: 'Gamma', version: 4 },
      { id: 'b', name: 'Beta', version: 2 },
      { id: 'z', name: 'Not used', version: 9 },
    ]);
    expect(updates.map(({ id, name, from, to }) => ({ id, name, from, to }))).toEqual([
      { id: 'a', name: 'Alpha (renamed)', from: 2, to: 3 },
      { id: 'b', name: 'Beta', from: 1, to: 3 },
    ]);
  });

  it('finds nothing when nothing is newer, nothing is used, or nothing is known', () => {
    expect(findLibraryUpdates(used, [{ id: 'a', name: 'Alpha', version: 1 }])).toEqual([]);
    expect(findLibraryUpdates([], [{ id: 'a', name: 'Alpha', version: 5 }])).toEqual([]);
    expect(findLibraryUpdates(used, [])).toEqual([]);
  });

  it('leaves out a declined update until a newer version still is published', () => {
    const updates = [
      { id: 'a', name: 'Alpha', from: 1, to: 2 },
      { id: 'b', name: 'Beta', from: 1, to: 3 },
    ];
    expect(updatesToOffer(updates, { a: 2, b: 2 })).toEqual([{ id: 'b', name: 'Beta', from: 1, to: 3 }]);
    expect(updatesToOffer(updates, {})).toEqual(updates);
  });
});

/** A key-value store in memory, standing in for local storage. */
function memoryStore(): SmallStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (key) => data.get(key) ?? null, setItem: (key, value) => void data.set(key, value) };
}

describe('taking and declining updates', () => {
  /** A file on this device that has added version 1 of the team library, and a server that now has version 2 (green). */
  async function setUp() {
    const kit = kitDocument();
    const v1 = kit.doc.publication as Publication;
    const greener = updateStyle(kit.doc, kit.style, { paints: [solidPaint(GREEN)] });
    const v2 = publishLibrary(greener, '2026-11-18T13:00:00.000Z').publication as Publication;
    expect(v2.version).toBe(2);
    let serverPublication = v1;
    const { fetch, calls } = fakeFetch({
      '/api/libraries': () => Response.json({ libraries: [summary({ version: serverPublication.version, publishedAt: serverPublication.publishedAt })] }),
      '/api/documents/kit-doc/library': () => Response.json({ id: 'kit-doc', name: 'Kit', publication: serverPublication }),
      [`/api/documents/kit-doc/assets/${HASH}`]: () => new Response(new Uint8Array([9]).buffer, { headers: { 'Content-Type': 'image/png' } }),
    });
    const storage = new MemoryStorage();
    const editor = createEditorStore(createDocument('Design'));
    const declinedStore = memoryStore();
    const updates = createLibraryUpdates({ editor, storage, api: createLibrariesApi({ fetch, auth: signedIn }), signedIn: () => true, declinedStore });
    expect(await updates.take('kit-doc', 'team', 'Kit', 'Add library')).toBe('');
    expect(listLibraries(editor.getState().doc)).toEqual([{ id: 'kit-doc', name: 'Kit', version: 1, publishedAt: AT }]);
    serverPublication = v2;
    return { editor, updates, calls, declinedStore, styleId: mirrorId('kit-doc', kit.style), storage };
  }

  it('finds the newer version on the server and takes it as one undo step', async () => {
    const { editor, updates, styleId } = await setUp();
    const colour = () => (editor.getState().doc.styles[styleId] as { paints: { color: unknown }[] }).paints[0]?.color;
    expect(colour()).toEqual(RED);
    await updates.check();
    const offered = findLibraryUpdates(listLibraries(editor.getState().doc), updates.store.getState().latest ?? []);
    expect(offered.map(({ name, from, to }) => ({ name, from, to }))).toEqual([{ name: 'Kit', from: 1, to: 2 }]);

    const steps = editor.getState().undoStack.length;
    expect(await updates.accept()).toBe(true);
    expect(colour()).toEqual(GREEN);
    expect(listLibraries(editor.getState().doc)).toEqual([{ id: 'kit-doc', name: 'Kit', version: 2, publishedAt: '2026-11-18T13:00:00.000Z' }]);
    expect(editor.getState().undoStack.length).toBe(steps + 1);
    editor.getState().undo();
    expect(colour()).toEqual(RED);
  });

  it('does not ask the server when the file uses no library, or when nobody is signed in', async () => {
    const { fetch, calls } = fakeFetch({});
    const editor = createEditorStore(createDocument('Empty'));
    const none = createLibraryUpdates({ editor, storage: new MemoryStorage(), api: createLibrariesApi({ fetch, auth: signedIn }), signedIn: () => true, declinedStore: memoryStore() });
    await none.check();
    expect(calls).toEqual([]);

    // A file that uses a team library, with nobody signed in: the server is not asked.
    const using = createEditorStore(importLibrary(createDocument('Design'), { id: 'kit-doc', name: 'Kit', publication: kitDocument().doc.publication as Publication }));
    const signedOut = createLibraryUpdates({ editor: using, storage: new MemoryStorage(), api: createLibrariesApi({ fetch, auth: signedIn }), signedIn: () => false, declinedStore: memoryStore() });
    await signedOut.check();
    expect(calls).toEqual([]);
    expect(signedOut.store.getState().latest).toEqual([]);
  });

  it('“Not now” hides the update until the next version, and remembers it for the file', async () => {
    const { editor, updates, declinedStore } = await setUp();
    await updates.check();
    updates.decline();
    const state = updates.store.getState();
    const all = findLibraryUpdates(listLibraries(editor.getState().doc), state.latest ?? []);
    expect(all).toHaveLength(1);
    expect(updatesToOffer(all, state.declined)).toEqual([]);
    expect(loadDeclinedUpdates(editor.getState().doc.id, declinedStore)).toEqual({ 'kit-doc': 2 });
    // Nothing is taken when nothing is offered; the file keeps version 1.
    expect(await updates.accept()).toBe(false);
    expect(listLibraries(editor.getState().doc)[0]?.version).toBe(1);
    // A version 3 is offered again.
    updates.learn('team', [{ id: 'kit-doc', name: 'Kit', version: 3 }]);
    const later = updatesToOffer(findLibraryUpdates(listLibraries(editor.getState().doc), updates.store.getState().latest ?? []), updates.store.getState().declined);
    expect(later.map((update) => update.to)).toEqual([3]);
  });

  it('takes a newer version of a library on this device too', async () => {
    const storage = new MemoryStorage();
    const kit = kitDocument('local-kit');
    await saveDocument(storage, kit.doc, AT);
    const editor = createEditorStore(createDocument('Design'));
    const updates = createLibraryUpdates({ editor, storage, signedIn: () => false, declinedStore: memoryStore() });
    expect(await updates.take('local-kit', 'device', 'Kit', 'Add library')).toBe('');
    await saveDocument(storage, publishLibrary(updateStyle(kit.doc, kit.style, { paints: [solidPaint(GREEN)] }), AT), AT);
    await updates.check();
    expect(await updates.accept()).toBe(true);
    expect(listLibraries(editor.getState().doc)).toEqual([{ id: 'local-kit', name: 'Kit', version: 2, publishedAt: '2026-11-18T12:00:00.001Z' }]);
  });

  it('says what went wrong when a library cannot be taken, and changes nothing', async () => {
    const { fetch } = fakeFetch({ '/api/documents/gone/library': () => Response.json({ error: 'Not published.' }, { status: 404 }) });
    const editor = createEditorStore(createDocument('Design'));
    const updates = createLibraryUpdates({ editor, storage: new MemoryStorage(), api: createLibrariesApi({ fetch, auth: signedIn }), signedIn: () => true, declinedStore: memoryStore() });
    expect(await updates.take('gone', 'team', 'Old kit', 'Add library')).toBe('“Old kit”: This library is no longer published.');
    expect(listLibraries(editor.getState().doc)).toEqual([]);
    expect(editor.getState().undoStack).toHaveLength(0);
  });
});

describe('the images of a team library', () => {
  it('fetches and copies only the images its components and styles use, not every image its file ever had', async () => {
    const kit = kitDocument();
    const publication = { ...(kit.doc.publication as Publication), assets: { ...(kit.doc.publication as Publication).assets, [UNUSED]: { mimeType: 'image/png', width: 1, height: 1, name: 'moodboard.png' } } };
    expect(publicationImageHashes(publication)).toEqual([HASH]);
    const { fetch, calls } = fakeFetch({
      '/api/documents/kit-doc/library': () => Response.json({ id: 'kit-doc', name: 'Kit', publication }),
      [`/api/documents/kit-doc/assets/${HASH}`]: () => new Response(new Uint8Array([1]).buffer, { headers: { 'Content-Type': 'image/png' } }),
    });
    const result = await loadTeamLibrary(createLibrariesApi({ fetch, auth: signedIn }), new MemoryStorage(), 'kit-doc', { retryDelays: [0] });
    // The unused image is not asked for, and is not reported missing.
    expect(calls.filter((call) => call.url.includes('/assets/')).map((call) => call.url)).toEqual([`/api/documents/kit-doc/assets/${HASH}`]);
    expect(result.missingImages).toEqual([]);
    const using = importLibrary(createDocument('Design'), result.library);
    expect(Object.keys(using.assets)).toEqual([HASH]);
  });

  it('counts an image a paint style uses', () => {
    const style = { id: 's', name: 'Photo', type: 'PAINT', paints: [imagePaint(UNUSED)] };
    expect(publicationImageHashes({ nodes: {}, styles: { s: style } as never, assets: { [UNUSED]: {} } as never })).toEqual([UNUSED]);
    // A paint naming an image the publication does not list is not fetched.
    expect(publicationImageHashes({ nodes: {}, styles: { s: style } as never, assets: {} })).toEqual([]);
  });

  it('asks again for an image that is still being uploaded', async () => {
    const kit = kitDocument();
    let asked = 0;
    const { fetch } = fakeFetch({
      '/api/documents/kit-doc/library': () => Response.json({ id: 'kit-doc', name: 'Kit', publication: kit.doc.publication }),
      [`/api/documents/kit-doc/assets/${HASH}`]: () => (++asked < 3 ? Response.json({ error: 'No such image.' }, { status: 404 }) : new Response(new Uint8Array([1]).buffer, { headers: { 'Content-Type': 'image/png' } })),
    });
    const result = await loadTeamLibrary(createLibrariesApi({ fetch, auth: signedIn }), new MemoryStorage(), 'kit-doc', { retryDelays: [0, 0, 0] });
    expect(result.missingImages).toEqual([]);
    expect(asked).toBe(3);
  });

  it('uploads an image to the shared file once it could be downloaded, though the file already lists it', async () => {
    const kit = kitDocument();
    const v1 = kit.doc.publication as Publication;
    const v2 = publishLibrary(updateStyle(kit.doc, kit.style, { paints: [solidPaint(GREEN)] }), '2026-11-18T13:00:00.000Z').publication as Publication;
    let serverPublication = v1;
    let imageThere = false;
    const { fetch } = fakeFetch({
      '/api/libraries': () => Response.json({ libraries: [summary({ version: serverPublication.version, publishedAt: serverPublication.publishedAt })] }),
      '/api/documents/kit-doc/library': () => Response.json({ id: 'kit-doc', name: 'Kit', publication: serverPublication }),
      [`/api/documents/kit-doc/assets/${HASH}`]: () => (imageThere ? new Response(new Uint8Array([1]).buffer, { headers: { 'Content-Type': 'image/png' } }) : Response.json({ error: 'No such image.' }, { status: 404 })),
    });
    const editor = createEditorStore(createDocument('Design'));
    const uploadImages = vi.fn();
    const updates = createLibraryUpdates({ editor, storage: new MemoryStorage(), api: createLibrariesApi({ fetch, auth: signedIn }), signedIn: () => true, declinedStore: memoryStore(), uploadImages, imageRetryDelays: [0] });
    // Added while the image cannot be downloaded: it is listed in the file, but there are no bytes to send.
    expect(await updates.take('kit-doc', 'team', 'Kit', 'Add library')).toBe('');
    expect(updates.store.getState().problem).toBe(missingImagesNote('Kit', 1));
    expect(editor.getState().doc.assets[HASH]).toBeDefined();
    expect(uploadImages.mock.calls.flat(2)).not.toContain(HASH);

    // Updated later, when it can be: it is sent to the file's own copy on the server.
    imageThere = true;
    serverPublication = v2;
    await updates.check();
    expect(await updates.accept()).toBe(true);
    expect(uploadImages).toHaveBeenLastCalledWith([HASH]);
  });
});

describe('a library unpublished and published again', () => {
  /** Kit at version 3, a file that uses version 3, then Kit unpublished and published again (version 1, later). */
  function republished() {
    let kit = kitDocument().doc;
    const colours = [GREEN, { r: 0, g: 0, b: 1 }, { r: 1, g: 1, b: 0 }];
    const styleId = Object.keys(kit.styles)[0] as string;
    kit = publishLibrary(updateStyle(kit, styleId, { paints: [solidPaint(colours[0]!)] }), '2026-11-18T13:00:00.000Z');
    const v2 = kit.publication as Publication;
    kit = publishLibrary(updateStyle(kit, styleId, { paints: [solidPaint(colours[1]!)] }), '2026-11-18T14:00:00.000Z');
    const v3 = kit.publication as Publication;
    expect(v3.version).toBe(3);
    kit = unpublishLibrary(kit);
    kit = publishLibrary(updateStyle(kit, styleId, { paints: [solidPaint(colours[2]!)] }), '2026-11-18T15:00:00.000Z');
    const again = kit.publication as Publication;
    expect(again.version).toBe(1);
    const file = importLibrary(createDocument('Design'), { id: 'kit-doc', name: 'Kit', publication: v3 });
    return { v2, v3, again, file, styleId };
  }

  it('is offered to a file that has a higher version, because it was published later', () => {
    const { again, file } = republished();
    const updates = findLibraryUpdates(listLibraries(file), [{ id: 'kit-doc', name: 'Kit', version: again.version, publishedAt: again.publishedAt }]);
    expect(updates.map(({ from, to }) => ({ from, to }))).toEqual([{ from: 3, to: 1 }]);
    // An older publishing with a lower version is not.
    expect(findLibraryUpdates(listLibraries(file), [{ id: 'kit-doc', name: 'Kit', version: 2, publishedAt: '2026-11-18T13:00:00.000Z' }])).toEqual([]);
    // Declined at 3, a 1 published later is still offered.
    expect(updatesToOffer(updates, { 'kit-doc': 3 })).toHaveLength(1);
    expect(updatesToOffer(updates, { 'kit-doc': 1 })).toHaveLength(0);
  });

  it('is taken by "Update", and an older publishing than the file has is never taken', async () => {
    const { again, v2, file, styleId } = republished();
    let listed = { version: again.version, publishedAt: again.publishedAt };
    let serverPublication = again;
    const { fetch } = fakeFetch({
      '/api/libraries': () => Response.json({ libraries: [summary(listed)] }),
      '/api/documents/kit-doc/library': () => Response.json({ id: 'kit-doc', name: 'Kit', publication: serverPublication }),
      [`/api/documents/kit-doc/assets/${HASH}`]: () => new Response(new Uint8Array([1]).buffer, { headers: { 'Content-Type': 'image/png' } }),
    });
    const editor = createEditorStore(file);
    const updates = createLibraryUpdates({ editor, storage: new MemoryStorage(), api: createLibrariesApi({ fetch, auth: signedIn }), signedIn: () => true, declinedStore: memoryStore(), imageRetryDelays: [0] });
    await updates.check();
    expect(await updates.accept()).toBe(true);
    expect(listLibraries(editor.getState().doc)).toEqual([{ id: 'kit-doc', name: 'Kit', version: 1, publishedAt: again.publishedAt }]);
    expect((editor.getState().doc.styles[mirrorId('kit-doc', styleId)] as { paints: { color: unknown }[] }).paints[0]?.color).toEqual({ r: 1, g: 1, b: 0 });

    // The list says there is a version 2, but what the server gives by the time it is fetched is older than what the file has.
    listed = { version: 2, publishedAt: '2026-11-18T16:00:00.000Z' };
    serverPublication = v2;
    await updates.check();
    const steps = editor.getState().undoStack.length;
    expect(await updates.accept()).toBe(false);
    expect(editor.getState().undoStack.length).toBe(steps);
    expect(listLibraries(editor.getState().doc)[0]?.version).toBe(1);
    expect(updates.store.getState().problem).toBe('“Kit” has no newer version than the one this file has.');
  });
});

describe('what is known of the team’s libraries', () => {
  async function using() {
    const kit = kitDocument();
    const editor = createEditorStore(importLibrary(createDocument('Design'), { id: 'kit-doc', name: 'Kit', publication: kit.doc.publication as Publication }));
    let status = 200;
    let signed = true;
    const { fetch } = fakeFetch({
      '/api/libraries': () => (status === 200 ? Response.json({ libraries: [summary({ version: 2, publishedAt: '2026-11-18T13:00:00.000Z' })] }) : Response.json({ error: 'No.' }, { status })),
      '/api/documents/kit-doc/library': () => Response.json({ error: 'No.' }, { status }),
    });
    const updates = createLibraryUpdates({ editor, storage: new MemoryStorage(), api: createLibrariesApi({ fetch, auth: signedIn }), signedIn: () => signed, declinedStore: memoryStore(), imageRetryDelays: [0] });
    await updates.check();
    expect(updatesOf(updates.store.getState(), editor)).toHaveLength(1);
    return { editor, updates, setStatus: (next: number) => void (status = next), signOut: () => void (signed = false) };
  }

  it('is forgotten when nobody is signed in any more', async () => {
    const { editor, updates, signOut } = await using();
    signOut();
    await updates.check();
    expect(updatesOf(updates.store.getState(), editor)).toEqual([]);
  });

  it('is forgotten when the list is refused (401 or 403), and kept when the server cannot be reached', async () => {
    for (const status of [401, 403]) {
      const { editor, updates, setStatus } = await using();
      setStatus(status);
      await updates.check();
      expect(updatesOf(updates.store.getState(), editor)).toEqual([]);
    }
    const { editor, updates, setStatus } = await using();
    setStatus(503);
    await updates.check();
    expect(updatesOf(updates.store.getState(), editor)).toHaveLength(1);
  });

  it('drops an update that can never be taken: access gone, unpublished, in the trash or signed out', async () => {
    for (const status of [401, 403, 404, 410]) {
      const { editor, updates, setStatus } = await using();
      setStatus(status);
      expect(await updates.accept()).toBe(false);
      expect(updates.store.getState().problem).not.toBe('');
      expect(updatesOf(updates.store.getState(), editor)).toEqual([]);
    }
  });
});

describe('taking a library while the file changes hands', () => {
  it('says so when the file became read-only while the library was fetched, and when busy does nothing', async () => {
    const kit = kitDocument();
    const editor = createEditorStore(createDocument('Design'));
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    const { fetch } = fakeFetch({
      '/api/documents/kit-doc/library': async () => {
        await held;
        return Response.json({ id: 'kit-doc', name: 'Kit', publication: kit.doc.publication });
      },
      [`/api/documents/kit-doc/assets/${HASH}`]: () => new Response(new Uint8Array([1]).buffer, { headers: { 'Content-Type': 'image/png' } }),
    });
    const updates = createLibraryUpdates({ editor, storage: new MemoryStorage(), api: createLibrariesApi({ fetch, auth: signedIn }), signedIn: () => true, declinedStore: memoryStore(), imageRetryDelays: [0] });
    const taking = updates.take('kit-doc', 'team', 'Kit', 'Add library');
    // A second take while the first runs does nothing.
    expect(await updates.take('kit-doc', 'team', 'Kit', 'Add library')).toBe('');
    editor.getState().setReadOnly(true);
    release();
    expect(await taking).toBe('You can no longer edit this file, so “Kit” was not added.');
    expect(listLibraries(editor.getState().doc)).toEqual([]);
    expect(updates.store.getState().latest ?? []).toEqual([]);
    expect(updates.store.getState().busy).toBe(false);
  });
});
