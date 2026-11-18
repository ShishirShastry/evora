import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Register } from '../src/collab/protocol.ts';
import { call, clock, newDoc, personalWorkspace, signUp, testServer, TestSocket, type TestServer } from './testing.ts';
import { compareLibraries, libraryLimits, summarizePublication, type LibrarySummary } from './libraries.ts';

/**
 * Team libraries on the collaboration server: the list of published libraries
 * a person can view (across workspaces, by workspace, without unpublished,
 * trashed or link-only documents and branches), one library's publication,
 * and who may read each.
 */

let server: TestServer;

beforeAll(async () => {
  server = await testServer();
});

afterAll(async () => {
  await server.stop();
});

const realLimits = { ...libraryLimits };
afterEach(() => {
  Object.assign(libraryLimits, realLimits);
  vi.restoreAllMocks();
});

let tickMs = Date.now();
function next(clientId: string): string {
  tickMs += 1000;
  return clock(tickMs, clientId);
}

/** A publication with `components` components (one of them in a set of two variants), `styles` styles and `variables` variables. */
function publication(version: number, components: number, styles: number, variables: number): Record<string, unknown> {
  const nodes: Record<string, unknown> = { set: { id: 'set', kind: 'COMPONENT_SET', parentId: '' }, inner: { id: 'inner', type: 'RECTANGLE', parentId: 'c0' } };
  for (let i = 0; i < components; i++) nodes[`c${i}`] = { id: `c${i}`, kind: 'COMPONENT', parentId: i < 2 ? 'set' : '' };
  const styles_: Record<string, unknown> = {};
  for (let i = 0; i < styles; i++) styles_[`s${i}`] = { id: `s${i}`, name: `Style ${i}` };
  const variables_: Record<string, unknown> = {};
  for (let i = 0; i < variables; i++) variables_[`v${i}`] = { id: `v${i}`, name: `Variable ${i}` };
  return { version, publishedAt: `2026-11-18T10:00:0${version}.000Z`, roots: ['set'], nodes, styles: styles_, variables: variables_, variableCollections: {}, assets: {} };
}

/** Changes registers over the live connection, as the app does when publishing, and waits until they are kept. */
async function edit(docId: string, token: string, values: Record<string, unknown>, clientId = 'libraryclient'): Promise<void> {
  const { socket } = await TestSocket.join(server, docId, { token }, clientId);
  const ops: Register[] = Object.entries(values).map(([k, v]) => ({ k, v, c: next(clientId) }));
  socket.send({ t: 'ops', id: 'p1', ops });
  await socket.next('ack');
  await socket.close();
}

async function makeDoc(token: string, workspaceId: string, name: string, published?: Record<string, unknown>): Promise<string> {
  const registers: Register[] = published ? [{ k: 'd:publication', v: published, c: next('seed') }] : [];
  const answer = await call(server, 'POST', '/api/documents', { token, body: { workspaceId, name, registers } });
  expect(answer.status).toBe(201);
  return answer.body.id as string;
}

const ids = (body: { libraries: LibrarySummary[] }): string[] => body.libraries.map((library) => library.id);

describe('summarizePublication', () => {
  it('counts components (each variant), styles and variables, and keeps the version and date', () => {
    expect(summarizePublication(publication(3, 4, 2, 5))).toEqual({ version: 3, publishedAt: '2026-11-18T10:00:03.000Z', components: 4, styles: 2, variables: 5 });
  });

  it('is null for a document that is not published or was unpublished', () => {
    expect(summarizePublication(null)).toBeNull();
    expect(summarizePublication(undefined)).toBeNull();
    expect(summarizePublication('published')).toBeNull();
    expect(summarizePublication([1, 2])).toBeNull();
  });

  it('reads a publication in another shape as empty rather than failing', () => {
    expect(summarizePublication({ version: 'two', nodes: [{ kind: 'COMPONENT' }], styles: 'x', variables: null, publishedAt: 5 })).toEqual({
      version: 0,
      publishedAt: '',
      components: 0,
      styles: 0,
      variables: 0,
    });
    expect(summarizePublication({ nodes: { a: null, b: 'COMPONENT', c: { kind: 'COMPONENT' } } })?.components).toBe(1);
  });
});

describe('compareLibraries', () => {
  const row = (id: string, name: string, workspaceName: string | null): LibrarySummary => ({
    id,
    name,
    workspaceId: workspaceName ? `w-${workspaceName}` : null,
    workspaceName,
    version: 1,
    publishedAt: '',
    components: 0,
    styles: 0,
    variables: 0,
  });

  it('orders by workspace name, then name, ignoring case, with libraries outside the workspaces last', () => {
    const rows = [row('1', 'icons', 'Brand'), row('2', 'Shared', null), row('3', 'Buttons', 'brand'), row('4', 'Alpha', 'Agency'), row('5', 'Buttons', 'Brand')];
    expect(rows.sort(compareLibraries).map((r) => r.id)).toEqual(['4', '3', '5', '1', '2']);
  });
});

describe('GET /api/libraries', () => {
  it('lists the published libraries of every workspace the person is in, sorted, with their counts, and one workspace on request', async () => {
    const alex = await signUp(server, 'Zoe');
    const own = await personalWorkspace(server, alex.token);
    const brand = (await call(server, 'POST', '/api/workspaces', { token: alex.token, body: { name: 'Brand' } })).body.id as string;
    const icons = await makeDoc(alex.token, brand, 'Icons', publication(1, 3, 0, 0));
    const buttons = await makeDoc(alex.token, brand, 'buttons', publication(2, 1, 4, 2));
    const tokens = await makeDoc(alex.token, own, 'Tokens', publication(1, 0, 0, 6));
    await makeDoc(alex.token, brand, 'Not published');

    const all = await call(server, 'GET', '/api/libraries', { token: alex.token });
    expect(all.status).toBe(200);
    const ownName = (await call(server, 'GET', '/api/me', { token: alex.token })).body.workspaces.find((w: { id: string }) => w.id === own).name as string;
    expect(ownName.toLowerCase() > 'brand').toBe(true);
    expect(ids(all.body)).toEqual([buttons, icons, tokens]);
    expect(all.body.libraries[0]).toEqual({
      id: buttons,
      name: 'buttons',
      workspaceId: brand,
      workspaceName: 'Brand',
      version: 2,
      publishedAt: '2026-11-18T10:00:02.000Z',
      components: 1,
      styles: 4,
      variables: 2,
    });
    expect(all.body.libraries[2]).toMatchObject({ id: tokens, workspaceId: own, workspaceName: ownName, components: 0, styles: 0, variables: 6 });

    const onlyBrand = await call(server, 'GET', `/api/libraries?workspace=${brand}`, { token: alex.token });
    expect(onlyBrand.status).toBe(200);
    expect(ids(onlyBrand.body)).toEqual([buttons, icons]);

    // A workspace the person is not in does not exist for them.
    const blake = await signUp(server, 'Blake');
    expect((await call(server, 'GET', `/api/libraries?workspace=${brand}`, { token: blake.token })).status).toBe(404);
    expect(ids((await call(server, 'GET', '/api/libraries', { token: blake.token })).body)).toEqual([]);
  });

  it('leaves out unpublished, trashed and deleted-workspace documents and branches, and follows re-publishing', async () => {
    const owner = await signUp(server, 'Casey');
    const workspace = await personalWorkspace(server, owner.token);
    const kept = await makeDoc(owner.token, workspace, 'Kept', publication(1, 2, 1, 1));
    const unpublished = await makeDoc(owner.token, workspace, 'Unpublished', publication(1, 1, 0, 0));
    const trashed = await makeDoc(owner.token, workspace, 'Trashed', publication(1, 1, 0, 0));
    const team = (await call(server, 'POST', '/api/workspaces', { token: owner.token, body: { name: 'Gone' } })).body.id as string;
    await makeDoc(owner.token, team, 'In a deleted workspace', publication(1, 1, 0, 0));
    expect((await call(server, 'POST', `/api/documents/${kept}/branches`, { token: owner.token, body: { name: 'Idea' } })).status).toBe(201);

    expect(ids((await call(server, 'GET', '/api/libraries', { token: owner.token })).body).length).toBe(4);

    await edit(unpublished, owner.token, { 'd:publication': null });
    expect((await call(server, 'POST', `/api/documents/${trashed}/trash`, { token: owner.token })).status).toBe(200);
    expect((await call(server, 'DELETE', `/api/workspaces/${team}`, { token: owner.token })).status).toBe(200);
    expect(ids((await call(server, 'GET', '/api/libraries', { token: owner.token })).body)).toEqual([kept]);

    // Published again with more in it: the list shows the new version and counts at once.
    await edit(kept, owner.token, { 'd:publication': publication(2, 5, 3, 0) });
    const after = await call(server, 'GET', '/api/libraries', { token: owner.token });
    expect(after.body.libraries).toEqual([expect.objectContaining({ id: kept, version: 2, publishedAt: '2026-11-18T10:00:02.000Z', components: 5, styles: 3, variables: 0 })]);
    const one = await call(server, 'GET', `/api/documents/${kept}/library`, { token: owner.token });
    expect(one.body.publication).toMatchObject({ version: 2 });

    // Unpublished: 404 from the library route; in the trash: 410 to its owner, as for the document.
    expect(await call(server, 'GET', `/api/documents/${unpublished}/library`, { token: owner.token })).toEqual({ status: 404, body: { error: 'This file is not published as a library' } });
    expect((await call(server, 'GET', `/api/documents/${trashed}/library`, { token: owner.token })).status).toBe(410);
  });

  it('lists a library shared with someone as a document member, outside their workspaces, last and without a workspace', async () => {
    const owner = await signUp(server, 'Dana');
    const reader = await signUp(server, 'Eli');
    const doc = (await newDoc(server, owner.token, 'Shared kit', [{ k: 'd:publication', v: publication(1, 1, 0, 0), c: next('seed') }])).id;
    expect((await call(server, 'POST', `/api/documents/${doc}/members`, { token: owner.token, body: { email: reader.user.email, role: 'viewer' } })).status).toBe(200);
    const mine = await makeDoc(reader.token, await personalWorkspace(server, reader.token), 'Mine', publication(1, 0, 1, 0));
    const list = await call(server, 'GET', '/api/libraries', { token: reader.token });
    expect(ids(list.body)).toEqual([mine, doc]);
    expect(list.body.libraries[1]).toMatchObject({ workspaceId: null, workspaceName: null });
  });

  it('refuses nobody and gives a guest an empty list; links are not listed', async () => {
    const owner = await signUp(server, 'Frankie');
    const doc = (await newDoc(server, owner.token, 'Linked kit', [{ k: 'd:publication', v: publication(1, 1, 0, 0), c: next('seed') }])).id;
    expect((await call(server, 'PATCH', `/api/documents/${doc}`, { token: owner.token, body: { linkAccess: 'view' } })).status).toBe(200);
    const guest = (await call(server, 'POST', '/api/guests', { body: { name: 'Guest' } })).body.guestToken as string;
    const stranger = await signUp(server, 'Gray');

    expect((await call(server, 'GET', '/api/libraries')).status).toBe(401);
    expect(await call(server, 'GET', '/api/libraries', { guest })).toEqual({ status: 200, body: { libraries: [] } });
    expect((await call(server, 'GET', '/api/libraries?workspace=x', { guest })).status).toBe(401);
    expect(ids((await call(server, 'GET', '/api/libraries', { token: stranger.token })).body)).not.toContain(doc);
  });
});

describe('GET /api/libraries, reading and cutting', () => {
  it('never reads a publication from the database to list it, and reads each one only once per change', async () => {
    const owner = await signUp(server, 'Morgan');
    const workspace = await personalWorkspace(server, owner.token);
    const kit = await makeDoc(owner.token, workspace, 'Kit', publication(1, 2, 0, 0));
    const dropped = await makeDoc(owner.token, workspace, 'Dropped', publication(1, 1, 0, 0));
    await edit(dropped, owner.token, { 'd:publication': null });

    const queries: { sql: string; args: unknown[] }[] = [];
    const all = server.store.all.bind(server.store);
    vi.spyOn(server.store, 'all').mockImplementation(((sql: string, ...args: unknown[]) => {
      queries.push({ sql, args });
      return all(sql, ...(args as never[]));
    }) as typeof server.store.all);
    const reads = vi.spyOn(server.store, 'register');

    expect(ids((await call(server, 'GET', '/api/libraries', { token: owner.token })).body)).toEqual([kit]);
    const listing = queries.filter((query) => query.sql.includes('registers r')).map((query) => query.sql);
    expect(listing.length).toBe(1);
    const { args } = queries.find((query) => query.sql === listing[0]) as { args: unknown[] };
    const plan = (server.store.db.prepare('EXPLAIN QUERY PLAN ' + listing[0]).all(...(args as never[])) as { detail: string }[]).map((row) => row.detail).join('; ');
    // Read through the index of publication registers, which holds the sequence number: never the table row.
    expect(plan).toContain('COVERING INDEX registers_publication');
    // The register's value is neither selected nor filtered on: SQLite then leaves it unread on disk.
    expect(listing[0]).not.toMatch(/\br\.value\b|\br\.\*/);
    const first = reads.mock.calls.length;
    expect((await call(server, 'GET', '/api/libraries', { token: owner.token })).body.libraries.length).toBe(1);
    // The second list reads no publication at all: published or not, both are known by their sequence number.
    expect(reads.mock.calls.length).toBe(first);
  });

  it('keeps the first libraries of the order it shows when there are too many, and says it was cut', async () => {
    const owner = await signUp(server, 'Noor');
    const workspace = await personalWorkspace(server, owner.token);
    const zeta = await makeDoc(owner.token, workspace, 'Zeta', publication(1, 1, 0, 0));
    const arzte = await makeDoc(owner.token, workspace, 'Ärzte', publication(1, 1, 0, 0));
    const beta = await makeDoc(owner.token, workspace, 'beta', publication(1, 1, 0, 0));
    // Unpublished documents take no place in the list.
    for (const name of ['A1', 'A2', 'A3']) await edit(await makeDoc(owner.token, workspace, name, publication(1, 1, 0, 0)), owner.token, { 'd:publication': null });

    expect((await call(server, 'GET', '/api/libraries', { token: owner.token })).body).toEqual({ libraries: [expect.objectContaining({ id: arzte }), expect.objectContaining({ id: beta }), expect.objectContaining({ id: zeta })] });
    libraryLimits.libraries = 2;
    const cut = await call(server, 'GET', '/api/libraries', { token: owner.token });
    expect(ids(cut.body)).toEqual([arzte, beta]);
    expect(cut.body.truncated).toBe(true);
    libraryLimits.libraries = 3;
    expect((await call(server, 'GET', '/api/libraries', { token: owner.token })).body.truncated).toBeUndefined();
    // Past the safety cap on documents read, the list says so too.
    libraryLimits.candidates = 4;
    expect((await call(server, 'GET', '/api/libraries', { token: owner.token })).body.truncated).toBe(true);
  });
});

describe('GET /api/documents/:id/library', () => {
  it('lets a viewer read it, refuses an outsider and a guest without link access, and lets a guest in by the link', async () => {
    const owner = await signUp(server, 'Harper');
    const viewer = await signUp(server, 'Indy');
    const outsider = await signUp(server, 'Jules');
    const workspace = await personalWorkspace(server, owner.token);
    expect((await call(server, 'POST', `/api/workspaces/${workspace}/members`, { token: owner.token, body: { email: viewer.user.email, role: 'viewer' } })).status).toBe(200);
    const doc = await makeDoc(owner.token, workspace, 'Design system', publication(4, 2, 1, 1));
    const guest = (await call(server, 'POST', '/api/guests', { body: { name: 'Guest' } })).body.guestToken as string;

    const read = await call(server, 'GET', `/api/documents/${doc}/library`, { token: viewer.token });
    expect(read.status).toBe(200);
    expect(read.body).toEqual({ id: doc, name: 'Design system', publication: publication(4, 2, 1, 1) });
    expect(ids((await call(server, 'GET', '/api/libraries', { token: viewer.token })).body)).toEqual([doc]);

    expect((await call(server, 'GET', `/api/documents/${doc}/library`, { token: outsider.token })).status).toBe(403);
    expect((await call(server, 'GET', `/api/documents/${doc}/library`, { guest })).status).toBe(403);
    expect((await call(server, 'GET', `/api/documents/${doc}/library`)).status).toBe(401);
    expect((await call(server, 'GET', '/api/documents/no-such-doc/library', { token: owner.token })).status).toBe(404);

    expect((await call(server, 'PATCH', `/api/documents/${doc}`, { token: owner.token, body: { linkAccess: 'view' } })).status).toBe(200);
    const byLink = await call(server, 'GET', `/api/documents/${doc}/library`, { guest });
    expect(byLink.status).toBe(200);
    expect(byLink.body.publication.version).toBe(4);
  });

  it('only lets editors publish: a viewer cannot change the publication over the live connection', async () => {
    const owner = await signUp(server, 'Kai');
    const viewer = await signUp(server, 'Lee');
    const workspace = await personalWorkspace(server, owner.token);
    expect((await call(server, 'POST', `/api/workspaces/${workspace}/members`, { token: owner.token, body: { email: viewer.user.email, role: 'viewer' } })).status).toBe(200);
    const doc = await makeDoc(owner.token, workspace, 'Locked kit', publication(1, 1, 0, 0));
    const { socket } = await TestSocket.join(server, doc, { token: viewer.token }, 'viewerclient');
    socket.send({ t: 'ops', id: 'v1', ops: [{ k: 'd:publication', v: null, c: next('viewerclient') }] });
    await socket.next('rejected');
    await socket.close();
    expect((await call(server, 'GET', `/api/documents/${doc}/library`, { token: viewer.token })).body.publication.version).toBe(1);
  });
});
