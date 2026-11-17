import { describe, expect, it } from 'vitest';
import { createDocument, sha256Hex, type Document } from './core';
import { ApiError } from './collab/api';
import { copyToDevice, createCommunityApi, publishLocalDocument } from './collab/community';
import {
  createFilesApi,
  filterFiles,
  forgetLocalFile,
  localFavorites,
  localFilesVersion,
  localRecents,
  noteLocalOpened,
  setLocalFavorite,
  sortFiles,
  subscribeLocalFiles,
} from './collab/files';
import { makeClock, newClientId, type Register } from './collab/protocol';
import { registersFromDocument } from './collab/registers';
import { MemoryStorage } from './persistence/storage';

/**
 * The community and file-management API clients, against a fake fetch that
 * records each request and answers as the server would; the favourites and
 * recents kept on this device; publishing a local file and copying a
 * resource to this device.
 */

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeServer(answer: (request: Sent) => Response | Promise<Response> = () => json({})) {
  const sent: Sent[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const request: Sent = { url, method: init.method ?? 'GET', headers: (init.headers ?? {}) as Record<string, string>, body: init.body };
    sent.push(request);
    return answer(request);
  };
  return { sent, fetch };
}

const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const signedIn = () => ({ token: 'session-1', guestToken: null });
const body = (request: Sent | undefined): unknown => JSON.parse(String(request?.body));

const resource = {
  id: 'r1',
  kind: 'ui-kit',
  title: 'Kit',
  description: '',
  tags: [],
  author: { id: 'u1', name: 'Ada', color: '#f24e1e' },
  coverAt: '2026-01-01T00:00:00.000Z',
  version: 1,
  duplicates: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  versions: [],
};

describe('the community API client', () => {
  it('browses with the query in the address, and without credentials when there are none', async () => {
    const server = fakeServer(() => json({ items: [], total: 0 }));
    const api = createCommunityApi({ fetch: server.fetch, auth: () => ({ token: null, guestToken: null }) });
    await api.browse();
    await api.browse({ q: '  mobile kit ', kind: 'icons', tag: 'line', sort: 'popular', limit: 24, offset: 48 });
    expect(server.sent[0]?.url).toBe('/api/community/resources');
    expect(server.sent[1]?.url).toBe('/api/community/resources?q=mobile+kit&kind=icons&tag=line&sort=popular&limit=24&offset=48');
    expect(server.sent[1]?.headers.Authorization).toBeUndefined();
  });

  it('publishes a shared file and a file of this device, and changes and unpublishes resources', async () => {
    const server = fakeServer(() => json({ resource, version: 1, created: true }, 201));
    const api = createCommunityApi({ fetch: server.fetch, auth: signedIn });
    await api.publishDocument('d1', { kind: 'ui-kit', title: 'Kit', tags: ['a'], notes: 'First' });
    expect(server.sent[0]).toMatchObject({ url: '/api/community/resources', method: 'POST' });
    expect(server.sent[0]?.headers.Authorization).toBe('Bearer session-1');
    expect(body(server.sent[0])).toEqual({ docId: 'd1', kind: 'ui-kit', title: 'Kit', tags: ['a'], notes: 'First' });
    const registers: Register[] = [{ k: 'd:name', v: 'X', c: makeClock(1, 0, 'a') }];
    await api.publishRegisters('local1', registers, { kind: 'file', title: 'X' });
    expect(body(server.sent[1])).toEqual({ sourceId: 'local1', registers, kind: 'file', title: 'X' });
    await api.update('r1', { title: 'New' });
    expect(server.sent[2]).toMatchObject({ url: '/api/community/resources/r1', method: 'PATCH' });
    await api.unpublish('r 1');
    expect(server.sent[3]).toMatchObject({ url: '/api/community/resources/r%201', method: 'DELETE' });
    await api.putCover('r1', new Uint8Array([1, 2]), 'image/png');
    expect(server.sent[4]).toMatchObject({ url: '/api/community/resources/r1/cover', method: 'PUT' });
    expect(server.sent[4]?.headers['Content-Type']).toBe('image/png');
    expect(server.sent[4]?.body).toEqual(new Uint8Array([1, 2]));
  });

  it('duplicates into a workspace, takes copies, reads versions and the cover’s address', async () => {
    const server = fakeServer(() => json({}));
    const api = createCommunityApi({ fetch: server.fetch, auth: signedIn });
    await api.duplicate('r1', 'w1');
    await api.duplicate('r1', 'w1', 2, 'p1');
    await api.copy('r1');
    await api.copy('r1', 3);
    await api.version('r1', 2);
    await api.mine();
    await api.tags();
    expect(server.sent.map((request) => `${request.method} ${request.url}`)).toEqual([
      'POST /api/community/resources/r1/duplicate',
      'POST /api/community/resources/r1/duplicate',
      'POST /api/community/resources/r1/copies',
      'POST /api/community/resources/r1/copies',
      'GET /api/community/resources/r1/versions/2',
      'GET /api/community/mine',
      'GET /api/community/tags',
    ]);
    expect(body(server.sent[0])).toEqual({ workspaceId: 'w1' });
    expect(body(server.sent[1])).toEqual({ workspaceId: 'w1', version: 2, projectId: 'p1' });
    expect(body(server.sent[3])).toEqual({ version: 3 });
    expect(api.coverUrl(resource)).toBe('/api/community/resources/r1/cover?v=2026-01-01T00%3A00%3A00.000Z');
    expect(api.coverUrl({ id: 'r1', coverAt: null })).toBeNull();
  });

  it('reads the plugins directory, and says when a server has none', async () => {
    const entry = { id: 'p1', name: 'Lorem', description: '', version: '1.0.0', kind: 'plugin', author: { id: 'u1', name: 'Ada' }, installs: 3, updatedAt: '2026-01-01T00:00:00.000Z' };
    const withDirectory = fakeServer(() => json([entry]));
    const api = createCommunityApi({ fetch: withDirectory.fetch, auth: signedIn });
    expect(await api.pluginDirectory('lorem', 'plugin')).toEqual([entry]);
    expect(withDirectory.sent[0]?.url).toBe('/api/plugins/directory?q=lorem&kind=plugin');
    const missing = createCommunityApi({ fetch: fakeServer(() => json({ error: 'Not found' }, 404)).fetch, auth: signedIn });
    expect(await missing.pluginDirectory()).toBeNull();
    const broken = createCommunityApi({ fetch: fakeServer(() => json({ error: 'Something went wrong on the server' }, 500)).fetch, auth: signedIn });
    await expect(broken.pluginDirectory()).rejects.toThrow('Something went wrong on the server');
  });

  it('reports the server’s message, and an unreachable server as status 0', async () => {
    const api = createCommunityApi({ fetch: fakeServer(() => json({ error: 'There is no such resource: it may have been unpublished' }, 404)).fetch, auth: signedIn });
    await expect(api.resource('gone')).rejects.toMatchObject({ status: 404, message: 'There is no such resource: it may have been unpublished' });
    const offline = createCommunityApi({ fetch: () => Promise.reject(new TypeError('Failed to fetch')), auth: signedIn });
    const error = await offline.browse().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(0);
  });

  it('publishes a file of this device with the bytes of its images', async () => {
    const storage = new MemoryStorage();
    const bytes = new Uint8Array([7, 8, 9]);
    const hash = await sha256Hex(bytes);
    await storage.saveAsset(hash, { mimeType: 'image/png', bytes: bytes.buffer.slice(0) });
    const doc: Document = { ...createDocument('Poster'), assets: { [hash]: { mimeType: 'image/png', width: 1, height: 1, name: 'pic.png' } as never } };
    const server = fakeServer((request) => (request.method === 'POST' ? json({ resource, version: 1, created: true }, 201) : json({})));
    const api = createCommunityApi({ fetch: server.fetch, auth: signedIn });
    const result = await publishLocalDocument(api, doc, (h) => storage.loadAsset(h), { kind: 'file', title: 'Poster' });
    expect(result.created).toBe(true);
    const sent = body(server.sent[0]) as { sourceId: string; registers: Register[]; title: string };
    expect(sent.sourceId).toBe(doc.id);
    expect(sent.registers.find((register) => register.k === 'd:name')?.v).toBe('Poster');
    expect(sent.registers.some((register) => register.k === `a:${hash}`)).toBe(true);
    expect(server.sent[1]).toMatchObject({ method: 'PUT', url: `/api/community/resources/r1/assets/${hash}` });
    expect(new Uint8Array(server.sent[1]?.body as ArrayBuffer)).toEqual(bytes);
  });

  it('copies a resource to this device as a new file, with its images', async () => {
    const source = createDocument('Template');
    const registers = registersFromDocument(source, { last: makeClock(0, 0, ''), clientId: newClientId() });
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const server = fakeServer((request) =>
      request.url.endsWith('/copies')
        ? json({ resourceId: 'r1', number: 2, name: 'Template', registers, assets: [{ hash: 'h'.repeat(64), contentType: 'image/png' }] })
        : new Response(bytes, { status: 200, headers: { 'Content-Type': 'image/png' } }),
    );
    const storage = new MemoryStorage();
    const id = await copyToDevice(createCommunityApi({ fetch: server.fetch, auth: () => ({ token: null, guestToken: null }) }), storage, 'r1', 2);
    expect(body(server.sent[0])).toEqual({ version: 2 });
    expect(id).not.toBe(source.id);
    const saved = await storage.load(id);
    expect(saved?.document.name).toBe('Template');
    expect(Object.values(saved?.document.nodes ?? {}).some((node) => node.type === 'PAGE')).toBe(true);
    const asset = await storage.loadAsset('h'.repeat(64));
    expect(new Uint8Array(asset?.bytes ?? new ArrayBuffer(0))).toEqual(bytes);
  });
});

describe('the file management API client', () => {
  it('calls each route with its method and body', async () => {
    const server = fakeServer(() => json({}));
    const api = createFilesApi({ fetch: server.fetch, auth: signedIn });
    await api.projects('w1');
    await api.createProject('w1', 'Website');
    await api.renameProject('p1', 'Site');
    await api.deleteProject('p1');
    await api.workspaceFiles('w1');
    await api.moveFile('d1', { workspaceId: 'w2', projectId: null });
    await api.duplicateFile('d1');
    await api.trashFile('d1');
    await api.trash('w1');
    await api.restoreFile('d1');
    await api.deleteForever('d1');
    await api.favorites();
    await api.setFavorite('d1', true);
    await api.setFavorite('d1', false);
    await api.recents();
    await api.noteOpened('d1');
    await api.search('home page');
    expect(server.sent.map((request) => `${request.method} ${request.url}`)).toEqual([
      'GET /api/workspaces/w1/projects',
      'POST /api/workspaces/w1/projects',
      'PATCH /api/projects/p1',
      'DELETE /api/projects/p1',
      'GET /api/workspaces/w1/files',
      'POST /api/documents/d1/move',
      'POST /api/documents/d1/duplicate',
      'POST /api/documents/d1/trash',
      'GET /api/workspaces/w1/trash',
      'POST /api/trash/d1/restore',
      'DELETE /api/trash/d1',
      'GET /api/favorites',
      'PUT /api/favorites/d1',
      'DELETE /api/favorites/d1',
      'GET /api/recents',
      'POST /api/recents/d1',
      'GET /api/files/search?q=home%20page',
    ]);
    expect(body(server.sent[1])).toEqual({ name: 'Website' });
    expect(body(server.sent[5])).toEqual({ workspaceId: 'w2', projectId: null });
    expect(body(server.sent[6])).toEqual({});
    expect(server.sent.every((request) => request.headers.Authorization === 'Bearer session-1')).toBe(true);
  });
});

describe('favourites and recents of this device', () => {
  function memoryStore() {
    const values = new Map<string, string>();
    return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) };
  }

  it('keeps favourites, latest first, and tells listeners', () => {
    const store = memoryStore();
    let told = 0;
    const stop = subscribeLocalFiles(() => told++);
    const before = localFilesVersion();
    setLocalFavorite('a', true, store);
    setLocalFavorite('b', true, store);
    setLocalFavorite('a', true, store);
    expect(localFavorites(store)).toEqual(['a', 'b']);
    setLocalFavorite('b', false, store);
    expect(localFavorites(store)).toEqual(['a']);
    expect(told).toBe(4);
    expect(localFilesVersion()).toBe(before + 4);
    stop();
  });

  it('keeps the files opened lately, each once, the latest first, and at most 30', () => {
    const store = memoryStore();
    noteLocalOpened('a', store, new Date('2026-01-01T00:00:00Z'));
    noteLocalOpened('b', store, new Date('2026-01-02T00:00:00Z'));
    noteLocalOpened('a', store, new Date('2026-01-03T00:00:00Z'));
    expect(localRecents(store)).toEqual([
      { id: 'a', openedAt: '2026-01-03T00:00:00.000Z' },
      { id: 'b', openedAt: '2026-01-02T00:00:00.000Z' },
    ]);
    for (let i = 0; i < 40; i++) noteLocalOpened(`f${i}`, store);
    expect(localRecents(store)).toHaveLength(30);
    setLocalFavorite('f39', true, store);
    forgetLocalFile('f39', store);
    expect(localFavorites(store)).toEqual([]);
    expect(localRecents(store).some((entry) => entry.id === 'f39')).toBe(false);
  });

  it('survives what is stored being unreadable, or no storage at all', () => {
    const store = memoryStore();
    store.setItem('evora:favorites', '{not json');
    store.setItem('evora:recents', JSON.stringify([{ id: 1 }, 'x', { id: 'ok', openedAt: '2026-01-01T00:00:00.000Z' }]));
    expect(localFavorites(store)).toEqual([]);
    expect(localRecents(store)).toEqual([{ id: 'ok', openedAt: '2026-01-01T00:00:00.000Z' }]);
    expect(localFavorites(null)).toEqual([]);
    expect(() => setLocalFavorite('a', true, null)).not.toThrow();
  });
});

describe('sorting and filtering file lists', () => {
  const files = [
    { name: 'beta 10', updatedAt: '2026-01-03', createdAt: '2026-01-01' },
    { name: 'Alpha', updatedAt: '2026-01-01', createdAt: '2026-01-03' },
    { name: 'beta 9', updatedAt: '2026-01-02', createdAt: '2026-01-02' },
  ];

  it('sorts by last edited, created, or name', () => {
    expect(sortFiles(files, 'edited').map((file) => file.name)).toEqual(['beta 10', 'beta 9', 'Alpha']);
    expect(sortFiles(files, 'created').map((file) => file.name)).toEqual(['Alpha', 'beta 9', 'beta 10']);
    expect(sortFiles(files, 'name').map((file) => file.name)).toEqual(['Alpha', 'beta 9', 'beta 10']);
    // The list given is not changed.
    expect(files[0]?.name).toBe('beta 10');
  });

  it('filters by every word of the name, in any case', () => {
    expect(filterFiles(files, 'BETA 1').map((file) => file.name)).toEqual(['beta 10']);
    expect(filterFiles(files, '  ')).toHaveLength(3);
  });
});
