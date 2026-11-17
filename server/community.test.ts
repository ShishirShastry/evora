import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { purgeTrash, TRASH_DAYS } from './community.ts';
import { call, clock, newDoc, personalWorkspace, signUp, testServer, TestSocket, type TestServer } from './testing.ts';
import type { Register } from '../src/collab/protocol.ts';

let server: TestServer;

beforeAll(async () => {
  server = await testServer();
});

afterAll(async () => {
  await server.stop();
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const hashOf = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** A small document's registers: a page with a rectangle, and an image when a hash is given. */
function content(name: string, imageHash?: string): Register[] {
  const out: Register[] = [
    { k: 'd:name', v: name, c: clock(1000, 'seed') },
    { k: 'n:page1:@', v: true, c: clock(1000, 'seed', 1) },
    { k: 'n:rect1:@', v: true, c: clock(1000, 'seed', 2) },
    { k: 'n:rect1:name', v: 'Box', c: clock(1000, 'seed', 3) },
  ];
  if (imageHash) out.push({ k: `a:${imageHash}`, v: { mimeType: 'image/png', width: 1, height: 1 }, c: clock(1000, 'seed', 4) });
  return out;
}

/** Makes a shared document with an image uploaded. */
async function docWithImage(token: string, name: string) {
  const image = new Uint8Array([...PNG, Math.floor(Math.random() * 255)]);
  const hash = hashOf(image);
  const doc = await newDoc(server, token, name, content(name, hash));
  const put = await call(server, 'PUT', `/api/documents/${doc.id}/assets/${hash}`, { token, body: image, headers: { 'Content-Type': 'image/png' } });
  expect(put.status).toBe(200);
  return { doc, hash, image };
}

const valueOf = (registers: Register[], key: string): unknown => registers.find((register) => register.k === key)?.v;

describe('the community', () => {
  it('publishes a shared file as a snapshot, with its images, that later edits do not change', async () => {
    const ada = await signUp(server, 'Ada');
    const { doc, hash, image } = await docWithImage(ada.token, 'Mobile kit');
    const published = await call(server, 'POST', '/api/community/resources', {
      token: ada.token,
      body: { docId: doc.id, kind: 'ui-kit', title: 'Mobile UI kit', description: 'Buttons and cards', tags: ['Mobile', 'buttons', 'mobile'], notes: 'First release' },
    });
    expect(published.status).toBe(201);
    expect(published.body.created).toBe(true);
    expect(published.body.version).toBe(1);
    const resource = published.body.resource;
    expect(resource).toMatchObject({ kind: 'ui-kit', title: 'Mobile UI kit', tags: ['mobile', 'buttons'], version: 1, duplicates: 0, author: { id: ada.user.id, name: 'Ada' }, sourceKey: `doc:${doc.id}` });
    expect(resource.versions).toEqual([expect.objectContaining({ number: 1, name: 'Mobile kit', notes: 'First release', assetCount: 1 })]);

    // The file is changed afterwards: the published version is not.
    await call(server, 'PATCH', `/api/documents/${doc.id}`, { token: ada.token, body: { name: 'Renamed later' } });
    const version = await call(server, 'GET', `/api/community/resources/${resource.id}/versions/1`);
    expect(version.status).toBe(200);
    expect(valueOf(version.body.registers, 'd:name')).toBe('Mobile kit');
    expect(valueOf(version.body.registers, 'n:rect1:name')).toBe('Box');
    expect(version.body.assets).toEqual([{ hash, contentType: 'image/png' }]);

    // Its image can be read by anyone, without an account.
    const bytes = await fetch(`${server.url}/api/community/resources/${resource.id}/assets/${hash}`);
    expect(bytes.status).toBe(200);
    expect(new Uint8Array(await bytes.arrayBuffer())).toEqual(image);
    // Someone else's view of it does not show where it came from.
    const anonymous = await call(server, 'GET', `/api/community/resources/${resource.id}`);
    expect(anonymous.status).toBe(200);
    expect(anonymous.body.sourceKey).toBeUndefined();
  });

  it('makes a new version when the same file is published again, and duplicates the latest or a chosen one', async () => {
    const ben = await signUp(server, 'Ben');
    const doc = await newDoc(server, ben.token, 'Icons v1', content('Icons v1'));
    const first = await call(server, 'POST', '/api/community/resources', { token: ben.token, body: { docId: doc.id, kind: 'icons', title: 'Line icons' } });
    await call(server, 'PATCH', `/api/documents/${doc.id}`, { token: ben.token, body: { name: 'Icons v2' } });
    const second = await call(server, 'POST', '/api/community/resources', { token: ben.token, body: { docId: doc.id, notes: 'Twenty more icons' } });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ created: false, version: 2, resource: { id: first.body.resource.id, kind: 'icons', title: 'Line icons', version: 2 } });
    expect(second.body.resource.versions.map((v: { number: number; notes: string; name: string }) => [v.number, v.name, v.notes])).toEqual([
      [2, 'Icons v2', 'Twenty more icons'],
      [1, 'Icons v1', ''],
    ]);

    const cleo = await signUp(server, 'Cleo');
    const workspaceId = await personalWorkspace(server, cleo.token);
    const latest = await call(server, 'POST', `/api/community/resources/${first.body.resource.id}/duplicate`, { token: cleo.token, body: { workspaceId } });
    expect(latest.status).toBe(201);
    expect(latest.body).toMatchObject({ name: 'Icons v2', workspaceId, role: 'owner', owner: { id: cleo.user.id } });
    const chosen = await call(server, 'POST', `/api/community/resources/${first.body.resource.id}/duplicate`, { token: cleo.token, body: { workspaceId, version: 1 } });
    expect(chosen.body.name).toBe('Icons v1');
    const registers = await call(server, 'GET', `/api/documents/${chosen.body.id}/registers`, { token: cleo.token });
    expect(valueOf(registers.body.registers, 'n:rect1:name')).toBe('Box');
    // Counted once per person, however often they duplicate it.
    const after = await call(server, 'GET', `/api/community/resources/${first.body.resource.id}`);
    expect(after.body.duplicates).toBe(1);
    expect((await call(server, 'POST', `/api/community/resources/${first.body.resource.id}/duplicate`, { token: cleo.token, body: { workspaceId, version: 9 } })).status).toBe(404);
  });

  it('duplicates a resource into a workspace with its images', async () => {
    const dan = await signUp(server, 'Dan');
    const { doc, hash, image } = await docWithImage(dan.token, 'Photo template');
    const published = await call(server, 'POST', '/api/community/resources', { token: dan.token, body: { docId: doc.id, kind: 'template', title: 'Photo template' } });
    const eve = await signUp(server, 'Eve');
    const workspaceId = await personalWorkspace(server, eve.token);
    const copy = await call(server, 'POST', `/api/community/resources/${published.body.resource.id}/duplicate`, { token: eve.token, body: { workspaceId } });
    expect(copy.status).toBe(201);
    const asset = await fetch(`${server.url}/api/documents/${copy.body.id}/assets/${hash}`, { headers: { Authorization: `Bearer ${eve.token}` } });
    expect(asset.status).toBe(200);
    expect(asset.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await asset.arrayBuffer())).toEqual(image);
  });

  it('publishes a file from a device: registers first, then its images and a cover; a copy is taken without an account', async () => {
    const fay = await signUp(server, 'Fay');
    const image = new Uint8Array([...PNG, 77]);
    const hash = hashOf(image);
    const made = await call(server, 'POST', '/api/community/resources', {
      token: fay.token,
      body: { registers: content('Local file', hash), sourceId: 'localfile123', kind: 'file', title: 'Local wireframes' },
    });
    expect(made.status).toBe(201);
    const id = made.body.resource.id;
    // Only images the latest version uses, and only bytes that match their hash, are taken.
    const other = new Uint8Array([9, 9, 9]);
    expect((await call(server, 'PUT', `/api/community/resources/${id}/assets/${hashOf(other)}`, { token: fay.token, body: other })).status).toBe(400);
    expect((await call(server, 'PUT', `/api/community/resources/${id}/assets/${hash}`, { token: fay.token, body: other })).status).toBe(400);
    expect((await call(server, 'PUT', `/api/community/resources/${id}/assets/${hash}`, { token: fay.token, body: image, headers: { 'Content-Type': 'image/png' } })).status).toBe(200);
    // Somebody else cannot add to it.
    const gus = await signUp(server, 'Gus');
    expect((await call(server, 'PUT', `/api/community/resources/${id}/assets/${hash}`, { token: gus.token, body: image })).status).toBe(403);

    // The cover.
    expect((await call(server, 'GET', `/api/community/resources/${id}/cover`)).status).toBe(404);
    expect((await call(server, 'PUT', `/api/community/resources/${id}/cover`, { token: fay.token, body: PNG, headers: { 'Content-Type': 'text/html' } })).status).toBe(400);
    expect((await call(server, 'PUT', `/api/community/resources/${id}/cover`, { token: gus.token, body: PNG, headers: { 'Content-Type': 'image/png' } })).status).toBe(403);
    expect((await call(server, 'PUT', `/api/community/resources/${id}/cover`, { token: fay.token, body: PNG, headers: { 'Content-Type': 'image/png' } })).status).toBe(200);
    const cover = await fetch(`${server.url}/api/community/resources/${id}/cover`);
    expect(cover.status).toBe(200);
    expect(cover.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await cover.arrayBuffer())).toEqual(PNG);
    expect((await call(server, 'GET', `/api/community/resources/${id}`)).body.coverAt).toEqual(expect.any(String));

    // Publishing the same local file again is a new version of it.
    const again = await call(server, 'POST', '/api/community/resources', { token: fay.token, body: { registers: content('Local file'), sourceId: 'localfile123', notes: 'No image now' } });
    expect(again.body).toMatchObject({ created: false, version: 2 });

    // A copy to keep on one's device: no account needed, and it is counted.
    const copy = await call(server, 'POST', `/api/community/resources/${id}/copies`, { body: { version: 1 } });
    expect(copy.status).toBe(200);
    expect(copy.body).toMatchObject({ number: 1, name: 'Local file', assets: [{ hash, contentType: 'image/png' }] });
    expect((await call(server, 'GET', `/api/community/resources/${id}`)).body.duplicates).toBe(1);
  });

  it('browses and searches by text, kind and tag, sorted by newest or most duplicated', async () => {
    const hal = await signUp(server, 'Halvard Searchable');
    const make = async (title: string, kind: string, tags: string[], description = '') => {
      const doc = await newDoc(server, hal.token, title, content(title));
      const made = await call(server, 'POST', '/api/community/resources', { token: hal.token, body: { docId: doc.id, kind, title, tags, description } });
      return made.body.resource.id as string;
    };
    const zebra = await make('Zebra dashboard', 'template', ['dashboard', 'zz-test'], 'Charts in stripes');
    const quokka = await make('Quokka icons', 'icons', ['zz-test', 'icons']);
    const yak = await make('Yak forms', 'components', ['forms', 'zz-test']);

    const byTag = await call(server, 'GET', '/api/community/resources?tag=zz-test');
    expect(byTag.body.total).toBe(3);
    // Newest first.
    expect(byTag.body.items.map((item: { id: string }) => item.id)).toEqual([yak, quokka, zebra]);
    expect((await call(server, 'GET', '/api/community/resources?tag=zz-test&kind=icons')).body.items.map((item: { id: string }) => item.id)).toEqual([quokka]);
    // Words are looked for in the title, description, tags and author's name.
    expect((await call(server, 'GET', '/api/community/resources?q=stripes')).body.items.map((item: { id: string }) => item.id)).toEqual([zebra]);
    expect((await call(server, 'GET', '/api/community/resources?q=quokka%20ICONS')).body.items.map((item: { id: string }) => item.id)).toEqual([quokka]);
    expect((await call(server, 'GET', '/api/community/resources?q=halvard&tag=zz-test')).body.total).toBe(3);
    expect((await call(server, 'GET', '/api/community/resources?q=nothing-matches-this')).body).toEqual({ items: [], total: 0 });
    expect((await call(server, 'GET', '/api/community/resources?kind=poster')).status).toBe(400);

    // Most duplicated first.
    const ivy = await signUp(server, 'Ivy');
    const workspaceId = await personalWorkspace(server, ivy.token);
    await call(server, 'POST', `/api/community/resources/${zebra}/duplicate`, { token: ivy.token, body: { workspaceId } });
    await call(server, 'POST', `/api/community/resources/${zebra}/duplicate`, { token: hal.token, body: { workspaceId: await personalWorkspace(server, hal.token) } });
    await call(server, 'POST', `/api/community/resources/${quokka}/copies`, {});
    const popular = await call(server, 'GET', '/api/community/resources?tag=zz-test&sort=popular');
    expect(popular.body.items.map((item: { id: string; duplicates: number }) => [item.id, item.duplicates])).toEqual([
      [zebra, 2],
      [quokka, 1],
      [yak, 0],
    ]);
    // Paging.
    const page = await call(server, 'GET', '/api/community/resources?tag=zz-test&limit=1&offset=1');
    expect(page.body.items).toHaveLength(1);
    expect(page.body.total).toBe(3);
    const tags = await call(server, 'GET', '/api/community/tags');
    expect(tags.body).toEqual(expect.arrayContaining([{ tag: 'zz-test', count: 3 }]));
  });

  it('lists one’s own resources, lets only the author change or unpublish them, and needs an account to publish', async () => {
    const jon = await signUp(server, 'Jon');
    const kim = await signUp(server, 'Kim');
    const doc = await newDoc(server, jon.token, 'Mine', content('Mine'));
    expect((await call(server, 'POST', '/api/community/resources', { body: { docId: doc.id, kind: 'file', title: 'Anon' } })).status).toBe(401);
    // Someone who cannot open the file cannot publish it; a viewer cannot either.
    expect((await call(server, 'POST', '/api/community/resources', { token: kim.token, body: { docId: doc.id, kind: 'file', title: 'Stolen' } })).status).toBe(403);
    await call(server, 'POST', `/api/documents/${doc.id}/members`, { token: jon.token, body: { email: kim.user.email, role: 'viewer' } });
    expect((await call(server, 'POST', '/api/community/resources', { token: kim.token, body: { docId: doc.id, kind: 'file', title: 'Stolen' } })).status).toBe(403);
    expect((await call(server, 'POST', '/api/community/resources', { token: jon.token, body: { docId: doc.id, kind: 'file' } })).status).toBe(400);

    const made = await call(server, 'POST', '/api/community/resources', { token: jon.token, body: { docId: doc.id, kind: 'file', title: 'Jon’s file' } });
    const id = made.body.resource.id;
    const mine = await call(server, 'GET', '/api/community/mine', { token: jon.token });
    expect(mine.body.map((item: { id: string; sourceKey: string }) => [item.id, item.sourceKey])).toEqual([[id, `doc:${doc.id}`]]);
    expect((await call(server, 'GET', '/api/community/mine', { token: kim.token })).body).toEqual([]);

    expect((await call(server, 'PATCH', `/api/community/resources/${id}`, { token: kim.token, body: { title: 'Hijacked' } })).status).toBe(403);
    const edited = await call(server, 'PATCH', `/api/community/resources/${id}`, { token: jon.token, body: { title: 'Better title', tags: ['one'], kind: 'template' } });
    expect(edited.body).toMatchObject({ title: 'Better title', tags: ['one'], kind: 'template' });

    expect((await call(server, 'DELETE', `/api/community/resources/${id}`, { token: kim.token })).status).toBe(403);
    expect((await call(server, 'DELETE', `/api/community/resources/${id}`, { token: jon.token })).status).toBe(200);
    expect((await call(server, 'GET', `/api/community/resources/${id}`)).status).toBe(404);
    expect((await call(server, 'GET', '/api/community/mine', { token: jon.token })).body).toEqual([]);
  });

  it('needs an account and an editor’s role to duplicate into a workspace', async () => {
    const lea = await signUp(server, 'Lea');
    const doc = await newDoc(server, lea.token, 'Open', content('Open'));
    const made = await call(server, 'POST', '/api/community/resources', { token: lea.token, body: { docId: doc.id, kind: 'file', title: 'Open file' } });
    const id = made.body.resource.id;
    const workspaceId = await personalWorkspace(server, lea.token);
    expect((await call(server, 'POST', `/api/community/resources/${id}/duplicate`, { body: { workspaceId } })).status).toBe(401);
    const max = await signUp(server, 'Max');
    expect((await call(server, 'POST', `/api/community/resources/${id}/duplicate`, { token: max.token, body: { workspaceId } })).status).toBe(404);
    await call(server, 'POST', `/api/workspaces/${workspaceId}/members`, { token: lea.token, body: { email: max.user.email, role: 'viewer' } });
    expect((await call(server, 'POST', `/api/community/resources/${id}/duplicate`, { token: max.token, body: { workspaceId } })).status).toBe(403);
  });
});

describe('file management', () => {
  it('makes, renames and deletes projects; deleting one puts its files at the workspace’s root', async () => {
    const owner = await signUp(server, 'Nia');
    const viewer = await signUp(server, 'Oli');
    const workspaceId = await personalWorkspace(server, owner.token);
    await call(server, 'POST', `/api/workspaces/${workspaceId}/members`, { token: owner.token, body: { email: viewer.user.email, role: 'viewer' } });

    const made = await call(server, 'POST', `/api/workspaces/${workspaceId}/projects`, { token: owner.token, body: { name: 'Website' } });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ name: 'Website', workspaceId, fileCount: 0 });
    expect((await call(server, 'POST', `/api/workspaces/${workspaceId}/projects`, { token: viewer.token, body: { name: 'Nope' } })).status).toBe(403);
    const renamed = await call(server, 'PATCH', `/api/projects/${made.body.id}`, { token: owner.token, body: { name: 'Marketing site' } });
    expect(renamed.body.name).toBe('Marketing site');
    expect((await call(server, 'PATCH', `/api/projects/${made.body.id}`, { token: viewer.token, body: { name: 'x' } })).status).toBe(403);

    const doc = await newDoc(server, owner.token, 'Home page');
    const moved = await call(server, 'POST', `/api/documents/${doc.id}/move`, { token: owner.token, body: { projectId: made.body.id } });
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({ projectId: made.body.id, projectName: 'Marketing site', workspaceId });
    const projects = await call(server, 'GET', `/api/workspaces/${workspaceId}/projects`, { token: viewer.token });
    expect(projects.body).toEqual([expect.objectContaining({ id: made.body.id, fileCount: 1 })]);

    expect((await call(server, 'DELETE', `/api/projects/${made.body.id}`, { token: owner.token })).status).toBe(200);
    const files = await call(server, 'GET', `/api/workspaces/${workspaceId}/files`, { token: owner.token });
    expect(files.body.find((file: { id: string }) => file.id === doc.id)).toMatchObject({ projectId: null, workspaceName: "Nia's workspace" });
  });

  it('moves files between projects and between workspaces one can edit in', async () => {
    const pia = await signUp(server, 'Pia');
    const quinn = await signUp(server, 'Quinn');
    const home = await personalWorkspace(server, pia.token);
    const studio = (await call(server, 'POST', '/api/workspaces', { token: pia.token, body: { name: 'Studio' } })).body.id as string;
    const project = (await call(server, 'POST', `/api/workspaces/${studio}/projects`, { token: pia.token, body: { name: 'App' } })).body.id as string;
    const foreign = (await call(server, 'POST', `/api/workspaces/${home}/projects`, { token: pia.token, body: { name: 'Elsewhere' } })).body.id as string;
    const doc = await newDoc(server, pia.token, 'Moving file');

    // A project of another workspace is refused.
    expect((await call(server, 'POST', `/api/documents/${doc.id}/move`, { token: pia.token, body: { workspaceId: studio, projectId: foreign } })).status).toBe(400);
    const moved = await call(server, 'POST', `/api/documents/${doc.id}/move`, { token: pia.token, body: { workspaceId: studio, projectId: project } });
    expect(moved.body).toMatchObject({ workspaceId: studio, projectId: project, workspaceName: 'Studio' });
    expect((await call(server, 'GET', `/api/workspaces/${home}/files`, { token: pia.token })).body.map((f: { id: string }) => f.id)).not.toContain(doc.id);
    expect((await call(server, 'GET', `/api/workspaces/${studio}/files`, { token: pia.token })).body.map((f: { id: string }) => f.id)).toContain(doc.id);

    // Someone who is only a viewer of the target workspace cannot move files there.
    await call(server, 'POST', `/api/workspaces/${studio}/members`, { token: pia.token, body: { email: quinn.user.email, role: 'editor' } });
    const quinnHome = await personalWorkspace(server, quinn.token);
    await call(server, 'POST', `/api/workspaces/${quinnHome}/members`, { token: quinn.token, body: { email: pia.user.email, role: 'viewer' } });
    expect((await call(server, 'POST', `/api/documents/${doc.id}/move`, { token: pia.token, body: { workspaceId: quinnHome } })).status).toBe(403);
    // An editor of both may.
    const taken = await call(server, 'POST', `/api/documents/${doc.id}/move`, { token: quinn.token, body: { workspaceId: quinnHome, projectId: null } });
    expect(taken.body).toMatchObject({ workspaceId: quinnHome, projectId: null });
  });

  it('duplicates a shared file with its images, in the same project', async () => {
    const rae = await signUp(server, 'Rae');
    const { doc, hash, image } = await docWithImage(rae.token, 'Poster');
    const workspaceId = doc.workspaceId;
    const project = (await call(server, 'POST', `/api/workspaces/${workspaceId}/projects`, { token: rae.token, body: { name: 'Prints' } })).body.id as string;
    await call(server, 'POST', `/api/documents/${doc.id}/move`, { token: rae.token, body: { projectId: project } });
    const copy = await call(server, 'POST', `/api/documents/${doc.id}/duplicate`, { token: rae.token, body: {} });
    expect(copy.status).toBe(201);
    expect(copy.body).toMatchObject({ name: 'Poster copy', projectId: project, workspaceId });
    expect(copy.body.id).not.toBe(doc.id);
    const asset = await fetch(`${server.url}/api/documents/${copy.body.id}/assets/${hash}`, { headers: { Authorization: `Bearer ${rae.token}` } });
    expect(new Uint8Array(await asset.arrayBuffer())).toEqual(image);
    const registers = await call(server, 'GET', `/api/documents/${copy.body.id}/registers`, { token: rae.token });
    expect(valueOf(registers.body.registers, 'n:rect1:name')).toBe('Box');
    expect(valueOf(registers.body.registers, 'd:name')).toBe('Poster copy');
  });

  it('keeps favourites and recents per person, and searches across the files one can open', async () => {
    const sam = await signUp(server, 'Sam');
    const tess = await signUp(server, 'Tess');
    const doc = await newDoc(server, sam.token, 'Unique Pelican board');
    const shared = await newDoc(server, tess.token, 'Pelican notes');
    const hidden = await newDoc(server, tess.token, 'Pelican secret');
    await call(server, 'POST', `/api/documents/${shared.id}/members`, { token: tess.token, body: { email: sam.user.email, role: 'viewer' } });

    expect((await call(server, 'PUT', `/api/favorites/${hidden.id}`, { token: sam.token })).status).toBe(403);
    expect((await call(server, 'PUT', `/api/favorites/${doc.id}`, { token: sam.token })).status).toBe(200);
    expect((await call(server, 'PUT', `/api/favorites/${shared.id}`, { token: sam.token })).status).toBe(200);
    const favorites = await call(server, 'GET', '/api/favorites', { token: sam.token });
    expect(favorites.body.map((f: { id: string; favorite: boolean }) => [f.id, f.favorite])).toEqual([
      [shared.id, true],
      [doc.id, true],
    ]);
    expect((await call(server, 'GET', '/api/favorites', { token: tess.token })).body).toEqual([]);
    await call(server, 'DELETE', `/api/favorites/${shared.id}`, { token: sam.token });
    expect((await call(server, 'GET', '/api/favorites', { token: sam.token })).body.map((f: { id: string }) => f.id)).toEqual([doc.id]);

    expect((await call(server, 'POST', `/api/recents/${hidden.id}`, { token: sam.token })).status).toBe(403);
    await call(server, 'POST', `/api/recents/${doc.id}`, { token: sam.token });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await call(server, 'POST', `/api/recents/${shared.id}`, { token: sam.token });
    const recents = await call(server, 'GET', '/api/recents', { token: sam.token });
    expect(recents.body.map((f: { id: string }) => f.id)).toEqual([shared.id, doc.id]);
    expect(recents.body[0].openedAt).toEqual(expect.any(String));

    const found = await call(server, 'GET', '/api/files/search?q=pelican', { token: sam.token });
    expect(found.body.map((f: { id: string }) => f.id).sort()).toEqual([doc.id, shared.id].sort());
    expect((await call(server, 'GET', '/api/files/search?q=', { token: sam.token })).body).toEqual([]);
    expect((await call(server, 'GET', '/api/files/search?q=pelican')).status).toBe(401);
  });

  it('moves a deleted file to the trash, where nobody can open it until it is restored', async () => {
    const uma = await signUp(server, 'Uma');
    const vic = await signUp(server, 'Vic');
    const workspaceId = await personalWorkspace(server, uma.token);
    const doc = await newDoc(server, uma.token, 'Trashable');
    await call(server, 'POST', `/api/documents/${doc.id}/members`, { token: uma.token, body: { email: vic.user.email, role: 'editor' } });
    await call(server, 'PATCH', `/api/documents/${doc.id}`, { token: uma.token, body: { linkAccess: 'view' } });
    await call(server, 'PUT', `/api/favorites/${doc.id}`, { token: uma.token });

    // Only an owner may delete it.
    expect((await call(server, 'POST', `/api/documents/${doc.id}/trash`, { token: vic.token })).status).toBe(403);
    expect((await call(server, 'POST', `/api/documents/${doc.id}/trash`, { token: uma.token })).status).toBe(200);

    // Whoever could open it before (its owner, a member, anyone by its link) is told it is in the trash; nobody can open it.
    expect(await call(server, 'GET', `/api/documents/${doc.id}`, { token: uma.token })).toEqual({ status: 410, body: { error: 'This file is in the trash' } });
    expect((await call(server, 'GET', `/api/documents/${doc.id}/registers`, { token: vic.token })).status).toBe(410);
    expect((await call(server, 'GET', `/api/documents/${doc.id}`)).status).toBe(410);
    expect((await call(server, 'GET', `/api/workspaces/${workspaceId}/documents`, { token: uma.token })).body.map((d: { id: string }) => d.id)).not.toContain(doc.id);
    expect((await call(server, 'GET', '/api/favorites', { token: uma.token })).body).toEqual([]);
    expect((await call(server, 'GET', '/api/files/search?q=trashable', { token: uma.token })).body).toEqual([]);

    const trash = await call(server, 'GET', `/api/workspaces/${workspaceId}/trash`, { token: uma.token });
    expect(trash.body).toEqual([expect.objectContaining({ id: doc.id, name: 'Trashable', workspaceId, canDelete: true, trashedBy: expect.objectContaining({ id: uma.user.id }) })]);
    expect(Date.parse(trash.body[0].purgeAt) - Date.parse(trash.body[0].trashedAt)).toBe(TRASH_DAYS * 24 * 60 * 60 * 1000);
    // Someone outside the workspace cannot see or restore it.
    expect((await call(server, 'GET', `/api/workspaces/${workspaceId}/trash`, { token: vic.token })).status).toBe(404);
    expect((await call(server, 'POST', `/api/trash/${doc.id}/restore`, { token: vic.token })).status).toBe(404);

    const restored = await call(server, 'POST', `/api/trash/${doc.id}/restore`, { token: uma.token });
    expect(restored.status).toBe(200);
    expect(restored.body).toMatchObject({ id: doc.id, workspaceId, linkAccess: 'view', favorite: true });
    // Everything comes back: members, link access, favourites.
    expect((await call(server, 'GET', `/api/documents/${doc.id}`, { token: vic.token })).body.role).toBe('editor');
    expect((await call(server, 'GET', `/api/documents/${doc.id}`)).body.role).toBe('viewer');
    expect((await call(server, 'GET', `/api/workspaces/${workspaceId}/trash`, { token: uma.token })).body).toEqual([]);
  });

  it('deletes from the trash for good, by a permitted person, and purges after 30 days', async () => {
    const wes = await signUp(server, 'Wes');
    const xia = await signUp(server, 'Xia');
    const workspaceId = await personalWorkspace(server, wes.token);
    await call(server, 'POST', `/api/workspaces/${workspaceId}/members`, { token: wes.token, body: { email: xia.user.email, role: 'editor' } });
    const { doc, hash } = await docWithImage(wes.token, 'Gone for good');
    await call(server, 'POST', `/api/documents/${doc.id}/trash`, { token: wes.token });
    expect((await call(server, 'GET', `/api/workspaces/${workspaceId}/trash`, { token: xia.token })).body[0].canDelete).toBe(false);
    expect((await call(server, 'DELETE', `/api/trash/${doc.id}`, { token: xia.token })).status).toBe(403);
    expect((await call(server, 'DELETE', `/api/trash/${doc.id}`, { token: wes.token })).status).toBe(200);
    expect(server.store.docById(doc.id)).toBeUndefined();
    expect(existsSync(server.store.assetPath(doc.id, hash))).toBe(false);

    const old = await newDoc(server, wes.token, 'Old');
    const recent = await newDoc(server, wes.token, 'Recent');
    await call(server, 'POST', `/api/documents/${old.id}/trash`, { token: wes.token });
    await call(server, 'POST', `/api/documents/${recent.id}/trash`, { token: wes.token });
    server.store.run(`UPDATE file_trash SET trashed_at = ? WHERE doc_id = ?`, Date.now() - (TRASH_DAYS * 24 + 1) * 60 * 60 * 1000, old.id);
    const listed = await call(server, 'GET', `/api/workspaces/${workspaceId}/trash`, { token: wes.token });
    expect(listed.body.map((f: { id: string }) => f.id)).toEqual([recent.id]);
    expect(server.store.docById(old.id)).toBeUndefined();
    // A file whose workspace was deleted goes too.
    const other = (await call(server, 'POST', '/api/workspaces', { token: wes.token, body: { name: 'Temporary' } })).body.id as string;
    const orphan = (await call(server, 'POST', '/api/documents', { token: wes.token, body: { workspaceId: other, name: 'Orphan' } })).body.id as string;
    await call(server, 'POST', `/api/documents/${orphan}/trash`, { token: wes.token });
    await call(server, 'DELETE', `/api/workspaces/${other}`, { token: wes.token });
    expect(purgeTrash(server.store)).toBeGreaterThanOrEqual(1);
    expect(server.store.docById(orphan)).toBeUndefined();
    expect(server.store.docById(recent.id)).toBeDefined();
  });

  it('disconnects whoever has a file open when it is moved to the trash', async () => {
    const zed = await signUp(server, 'Zed');
    const doc = await newDoc(server, zed.token, 'Open now');
    const { socket } = await TestSocket.join(server, doc.id, { token: zed.token }, 'zedclient1');
    await call(server, 'POST', `/api/documents/${doc.id}/trash`, { token: zed.token });
    expect(await socket.next('access')).toMatchObject({ role: null });
    expect((await socket.closed).code).toBe(4403);
  });

  it('moves a file to the trash with DELETE /api/documents/:id too, where it can be restored', async () => {
    const yan = await signUp(server, 'Yan');
    const ola = await signUp(server, 'Ola');
    const outsider = await signUp(server, 'Outsider of Yan');
    const workspaceId = await personalWorkspace(server, yan.token);
    const doc = await newDoc(server, yan.token, 'Not at once', content('Not at once'));
    await call(server, 'POST', `/api/documents/${doc.id}/members`, { token: yan.token, body: { email: ola.user.email, role: 'editor' } });
    const { socket } = await TestSocket.join(server, doc.id, { token: ola.token }, 'olaclient1');

    // Only an owner may delete it.
    expect((await call(server, 'DELETE', `/api/documents/${doc.id}`, { token: ola.token })).status).toBe(403);
    expect((await call(server, 'DELETE', `/api/documents/${doc.id}`, { token: yan.token })).status).toBe(200);
    // Nothing is lost: the file is kept, in the trash, and whoever had it open is disconnected.
    expect(server.store.docById(doc.id)).toBeDefined();
    expect(await socket.next('access')).toMatchObject({ role: null });
    expect((await socket.closed).code).toBe(4403);
    const trash = await call(server, 'GET', `/api/workspaces/${workspaceId}/trash`, { token: yan.token });
    expect(trash.body).toEqual([expect.objectContaining({ id: doc.id, name: 'Not at once', trashedBy: expect.objectContaining({ id: yan.user.id }) })]);

    // Opening it says it is in the trash, to those who could open it before; others are just refused.
    expect(await call(server, 'GET', `/api/documents/${doc.id}`, { token: ola.token })).toEqual({ status: 410, body: { error: 'This file is in the trash' } });
    expect((await call(server, 'GET', `/api/documents/${doc.id}`, { token: outsider.token })).status).toBe(403);
    const late = await TestSocket.open(server);
    late.send({ t: 'hello', docId: doc.id, since: 0, clientId: 'olaclient2', token: ola.token });
    expect(await late.next('error')).toEqual({ t: 'error', code: 'not-found', message: 'This file is in the trash' });
    expect((await late.closed).code).toBe(4404);
    const stranger = await TestSocket.open(server);
    stranger.send({ t: 'hello', docId: doc.id, since: 0, clientId: 'strangerclient', token: outsider.token });
    expect(await stranger.next('error')).toMatchObject({ code: 'forbidden', message: 'You do not have access to this document' });
    // Deleting it again is answered the same way.
    expect((await call(server, 'DELETE', `/api/documents/${doc.id}`, { token: yan.token })).status).toBe(410);

    const restored = await call(server, 'POST', `/api/trash/${doc.id}/restore`, { token: yan.token });
    expect(restored.status).toBe(200);
    expect((await call(server, 'GET', `/api/documents/${doc.id}`, { token: ola.token })).body.role).toBe('editor');
    const registers = await call(server, 'GET', `/api/documents/${doc.id}/registers`, { token: ola.token });
    expect(valueOf(registers.body.registers, 'n:rect1:name')).toBe('Box');
  });
});

describe('counting takers', () => {
  async function publishedBy(name: string) {
    const author = await signUp(server, name);
    const doc = await newDoc(server, author.token, `${name} kit`, content(`${name} kit`));
    const made = await call(server, 'POST', '/api/community/resources', { token: author.token, body: { docId: doc.id, kind: 'ui-kit', title: `${name} kit` } });
    return made.body.resource.id as string;
  }
  const duplicatesOf = async (id: string): Promise<number> => (await call(server, 'GET', `/api/community/resources/${id}`)).body.duplicates;

  it('counts each person once, whether they copy or duplicate, and two people twice', async () => {
    const id = await publishedBy('Counted');
    const pia = await signUp(server, 'Pia');
    const quinn = await signUp(server, 'Quinn');
    const piaSpace = await personalWorkspace(server, pia.token);
    for (let i = 0; i < 3; i++) {
      expect((await call(server, 'POST', `/api/community/resources/${id}/duplicate`, { token: pia.token, body: { workspaceId: piaSpace } })).status).toBe(201);
      expect((await call(server, 'POST', `/api/community/resources/${id}/copies`, { token: pia.token, body: {} })).status).toBe(200);
    }
    expect(await duplicatesOf(id)).toBe(1);
    await call(server, 'POST', `/api/community/resources/${id}/copies`, { token: quinn.token, body: {} });
    await call(server, 'POST', `/api/community/resources/${id}/copies`, { token: quinn.token, body: {} });
    expect(await duplicatesOf(id)).toBe(2);
    // A guest is a person too.
    const guest = (await call(server, 'POST', '/api/guests', { body: { name: 'Visitor' } })).body.guestToken as string;
    await call(server, 'POST', `/api/community/resources/${id}/copies`, { guest, body: {} });
    await call(server, 'POST', `/api/community/resources/${id}/copies`, { guest, body: {} });
    expect(await duplicatesOf(id)).toBe(3);
  });

  it('counts someone without an account once per address, keeping only a hash of it', async () => {
    const id = await publishedBy('Anonymous');
    for (let i = 0; i < 4; i++) expect((await call(server, 'POST', `/api/community/resources/${id}/copies`, { body: {} })).status).toBe(200);
    expect(await duplicatesOf(id)).toBe(1);
    const kept = server.store.all<{ who: string }>(`SELECT who FROM community_takers WHERE resource_id = ?`, id);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.who).toMatch(/^address:[0-9a-f]{64}$/);
    expect(kept[0]?.who).not.toContain('127.0.0.1');
    // The client cannot pick its address with a header: X-Forwarded-For is not read.
    await call(server, 'POST', `/api/community/resources/${id}/copies`, { body: {}, headers: { 'X-Forwarded-For': '203.0.113.9' } });
    expect(await duplicatesOf(id)).toBe(1);
  });

  it('keeps the count made before takers were recorded as a floor, and sorts by the total', async () => {
    const older = await publishedBy('Legacy');
    const newer = await publishedBy('Newcomer');
    // A resource from before: its counter said 5.
    server.store.run(`UPDATE community_resources SET duplicates = 5 WHERE id = ?`, older);
    expect(await duplicatesOf(older)).toBe(5);
    const rex = await signUp(server, 'Rex');
    await call(server, 'POST', `/api/community/resources/${older}/copies`, { token: rex.token, body: {} });
    await call(server, 'POST', `/api/community/resources/${older}/copies`, { token: rex.token, body: {} });
    expect(await duplicatesOf(older)).toBe(6);
    await call(server, 'POST', `/api/community/resources/${newer}/copies`, { token: rex.token, body: {} });
    const listed = await call(server, 'GET', '/api/community/resources?q=legacy');
    expect(listed.body.items[0]).toMatchObject({ id: older, duplicates: 6 });
    const popular = await call(server, 'GET', '/api/community/resources?sort=popular&limit=100');
    const order = popular.body.items.map((item: { id: string }) => item.id);
    expect(order.indexOf(older)).toBeLessThan(order.indexOf(newer));
  });
});

describe('limits on counting routes', () => {
  it('refuses an address that calls them too often', async () => {
    const limited = await testServer({ limits: { counted: 3 } });
    try {
      const author = await signUp(limited, 'Busy');
      const doc = await newDoc(limited, author.token, 'Busy kit', content('Busy kit'));
      const id = (await call(limited, 'POST', '/api/community/resources', { token: author.token, body: { docId: doc.id, kind: 'file', title: 'Busy kit' } })).body.resource.id as string;
      for (let i = 0; i < 3; i++) expect((await call(limited, 'POST', `/api/community/resources/${id}/copies`, { body: {} })).status).toBe(200);
      const refused = await call(limited, 'POST', `/api/community/resources/${id}/copies`, { body: {} });
      expect(refused).toEqual({ status: 429, body: { error: 'Too many requests from here: try again later' } });
      // Signed in, the same address is limited too: the limit is per address, whoever is asking.
      expect((await call(limited, 'POST', `/api/community/resources/${id}/copies`, { token: author.token, body: {} })).status).toBe(429);
      expect((await call(limited, 'GET', `/api/community/resources/${id}`)).body.duplicates).toBe(1);
    } finally {
      await limited.stop();
    }
  }, 30_000);
});
