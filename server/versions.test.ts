import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Register, StoredRegister } from '../src/collab/protocol.ts';
import { call, clock, newDoc, personalWorkspace, signUp, testServer, TestSocket, type TestServer } from './testing.ts';
import { autoVersions, autoVersionsToDrop, conflictsBetween, valuesToBring, valuesToReach } from './versions.ts';

/**
 * Version history and branching on the collaboration server: named and
 * automatic versions, restoring through the live connection, backups of
 * deleted files, branches, updating a branch from main and merging it back
 * (with and without conflicts), and who may do each.
 */

let server: TestServer;
const realNow = autoVersions.now;
const realInterval = autoVersions.intervalMs;
const realEvery = autoVersions.everyChanges;

beforeAll(async () => {
  server = await testServer();
});

afterAll(async () => {
  await server.stop();
});

afterEach(() => {
  autoVersions.now = realNow;
  autoVersions.intervalMs = realInterval;
  autoVersions.everyChanges = realEvery;
});

let tickMs = Date.now();
/** Clocks later than anything made before in this file. */
function next(clientId: string): string {
  tickMs += 1000;
  return clock(tickMs, clientId);
}

/** Changes a document over the live connection, as an editor would, and waits until they are kept. */
async function edit(docId: string, token: string, values: Record<string, unknown>, clientId = 'editorclient'): Promise<number> {
  const { socket } = await TestSocket.join(server, docId, { token }, clientId);
  const ops: Register[] = Object.entries(values).map(([k, v]) => ({ k, v, c: next(clientId) }));
  socket.send({ t: 'ops', id: 'e1', ops });
  const ack = await socket.next('ack');
  await socket.close();
  return ack.seq;
}

async function valuesOf(docId: string, token: string): Promise<Record<string, unknown>> {
  const answer = await call<{ seq: number; registers: StoredRegister[] }>(server, 'GET', `/api/documents/${docId}/registers`, { token });
  expect(answer.status).toBe(200);
  return Object.fromEntries(answer.body.registers.map((r) => [r.k, r.v]));
}

/** An owner, an editor and a viewer of a new document with one rectangle in it. */
async function team(name: string) {
  const owner = await signUp(server, `${name}Owner`);
  const editor = await signUp(server, `${name}Editor`);
  const viewer = await signUp(server, `${name}Viewer`);
  const doc = await newDoc(server, owner.token, `${name} file`);
  await call(server, 'POST', `/api/documents/${doc.id}/members`, { token: owner.token, body: { email: editor.user.email, role: 'editor' } });
  await call(server, 'POST', `/api/documents/${doc.id}/members`, { token: owner.token, body: { email: viewer.user.email, role: 'viewer' } });
  await edit(doc.id, owner.token, { 'n:rect:@': true, 'n:rect:type': 'RECTANGLE', 'n:rect:x': 10, 'n:rect:y': 20 }, 'ownerclient');
  return { owner, editor, viewer, doc };
}

describe('the pure rules', () => {
  it('reaches a version: changed registers, nodes made since are removed, the name and images are left alone', () => {
    const current = new Map<string, unknown>([
      ['d:name', 'Now'],
      ['n:a:@', true],
      ['n:a:x', 5],
      ['n:a:opacity', 0.5],
      ['n:b:@', true],
      ['n:b:x', 1],
      ['t:styles:s1', { id: 's1' }],
      ['a:hash', { width: 1 }],
    ]);
    const target = new Map<string, unknown>([
      ['d:name', 'Then'],
      ['n:a:@', true],
      ['n:a:x', 1],
    ]);
    expect(Object.fromEntries(valuesToReach(current, target))).toEqual({ 'n:a:x': 1, 'n:a:opacity': null, 'n:b:@': false, 'n:b:x': null, 't:styles:s1': null });
  });

  it('finds conflicts only where both sides changed the same register to different values', () => {
    const base = new Map<string, unknown>([['k1', 1], ['k2', 1], ['k3', 1]]);
    const main = new Map<string, unknown>([['k1', 2], ['k2', 5], ['k3', 1]]);
    const branch = new Map<string, unknown>([['k1', 3], ['k2', 5], ['k3', 9], ['k4', { a: 1 }]]);
    expect(conflictsBetween(base, main, branch)).toEqual([{ key: 'k1', base: 1, main: 2, branch: 3 }]);
    const merged = valuesToBring(base, branch, main, 'branch', { k1: 'main' });
    expect(merged.unresolved).toEqual([]);
    expect(Object.fromEntries(merged.values)).toEqual({ k3: 9, k4: { a: 1 } });
    expect(valuesToBring(base, branch, main, 'branch', {}).unresolved.map((c) => c.key)).toEqual(['k1']);
    expect(Object.fromEntries(valuesToBring(base, branch, main, 'branch', { k1: 'branch' }).values)).toEqual({ k1: 3, k3: 9, k4: { a: 1 } });
  });

  it('thins automatic versions out as they age and keeps every named one', () => {
    const now = Date.UTC(2026, 10, 17, 12);
    const hour = 3600_000;
    const day = 24 * hour;
    const versions = [
      { id: 'recent1', kind: 'auto' as const, createdMs: now - hour },
      { id: 'recent2', kind: 'auto' as const, createdMs: now - 2 * hour },
      { id: 'd3a', kind: 'auto' as const, createdMs: Date.UTC(2026, 10, 14, 15) },
      { id: 'd3b', kind: 'auto' as const, createdMs: Date.UTC(2026, 10, 14, 10) },
      { id: 'named', kind: 'named' as const, createdMs: Date.UTC(2026, 10, 14, 9) },
      { id: 'old1', kind: 'auto' as const, createdMs: now - 60 * day },
      { id: 'old2', kind: 'auto' as const, createdMs: now - 60 * day - hour },
    ];
    expect(autoVersionsToDrop(versions, now).sort()).toEqual(['d3b', 'old2']);
  });
});

describe('versions', () => {
  it('are saved with a name and a description, listed, read, renamed and deleted, by editors only', async () => {
    const { owner, editor, viewer, doc } = await team('Named');
    const made = await call(server, 'POST', `/api/documents/${doc.id}/versions`, { token: editor.token, body: { name: 'First draft', description: 'Before the review' } });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ kind: 'named', name: 'First draft', description: 'Before the review', seq: 5, author: { id: editor.user.id } });

    expect((await call(server, 'POST', `/api/documents/${doc.id}/versions`, { token: viewer.token, body: { name: 'No' } })).status).toBe(403);
    expect((await call(server, 'POST', `/api/documents/${doc.id}/versions`, { token: owner.token, body: {} })).status).toBe(400);

    // Viewers may look at the history.
    const list = await call(server, 'GET', `/api/documents/${doc.id}/versions`, { token: viewer.token });
    expect(list.status).toBe(200);
    expect(list.body.map((v: { name: string }) => v.name)).toEqual(['First draft']);
    const one = await call(server, 'GET', `/api/documents/${doc.id}/versions/${made.body.id}`, { token: viewer.token });
    expect(one.status).toBe(200);
    const held = Object.fromEntries(one.body.registers.map((r: Register) => [r.k, r.v]));
    expect(held).toEqual({ 'd:name': 'Named file', 'n:rect:@': true, 'n:rect:type': 'RECTANGLE', 'n:rect:x': 10, 'n:rect:y': 20 });

    expect((await call(server, 'PATCH', `/api/documents/${doc.id}/versions/${made.body.id}`, { token: viewer.token, body: { name: 'x' } })).status).toBe(403);
    const renamed = await call(server, 'PATCH', `/api/documents/${doc.id}/versions/${made.body.id}`, { token: owner.token, body: { name: 'Draft A', description: 'Reviewed' } });
    expect(renamed.body).toMatchObject({ name: 'Draft A', description: 'Reviewed' });

    // Someone who cannot open the document cannot see its history.
    const stranger = await signUp(server, 'Stranger');
    expect((await call(server, 'GET', `/api/documents/${doc.id}/versions`, { token: stranger.token })).status).toBe(403);

    expect((await call(server, 'DELETE', `/api/documents/${doc.id}/versions/${made.body.id}`, { token: viewer.token })).status).toBe(403);
    expect((await call(server, 'DELETE', `/api/documents/${doc.id}/versions/${made.body.id}`, { token: editor.token })).status).toBe(200);
    expect((await call(server, 'GET', `/api/documents/${doc.id}/versions`, { token: owner.token })).body).toEqual([]);
  });

  it('are made automatically when a document changes again after a while, or after many changes', async () => {
    const { owner, doc } = await team('Auto');
    let fake = Date.now();
    autoVersions.now = () => fake;
    // Long after the document was made: the next change first keeps the document as it was.
    fake += 11 * 60 * 1000;
    await edit(doc.id, owner.token, { 'n:rect:x': 11 });
    let list = (await call(server, 'GET', `/api/documents/${doc.id}/versions`, { token: owner.token })).body;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: 'auto', name: '', seq: 5, author: null });

    // Soon after: no new version.
    fake += 60 * 1000;
    await edit(doc.id, owner.token, { 'n:rect:x': 12 });
    expect((await call(server, 'GET', `/api/documents/${doc.id}/versions`, { token: owner.token })).body).toHaveLength(1);

    // Every N changes.
    autoVersions.everyChanges = 3;
    await edit(doc.id, owner.token, { 'n:rect:x': 13, 'n:rect:y': 30 });
    await edit(doc.id, owner.token, { 'n:rect:x': 14 });
    list = (await call(server, 'GET', `/api/documents/${doc.id}/versions`, { token: owner.token })).body;
    expect(list).toHaveLength(2);
    expect(list[0].seq).toBe(9);
    const content = await call(server, 'GET', `/api/documents/${doc.id}/versions/${list[0].id}`, { token: owner.token });
    expect(content.body.registers.find((r: Register) => r.k === 'n:rect:x').v).toBe(13);
  });

  it('are restored for everyone connected, after a “Before restoring” version', async () => {
    const { owner, editor, viewer, doc } = await team('Restore');
    const saved = await call(server, 'POST', `/api/documents/${doc.id}/versions`, { token: owner.token, body: { name: 'Good' } });
    await edit(doc.id, editor.token, { 'n:rect:x': 99, 'n:rect:opacity': 0.5, 'n:circle:@': true, 'n:circle:type': 'ELLIPSE' });

    const watcher = await TestSocket.join(server, doc.id, { token: viewer.token }, 'watcher');
    expect((await call(server, 'POST', `/api/documents/${doc.id}/versions/${saved.body.id}/restore`, { token: viewer.token })).status).toBe(403);
    const restored = await call(server, 'POST', `/api/documents/${doc.id}/versions/${saved.body.id}/restore`, { token: editor.token });
    expect(restored.status).toBe(200);
    expect(restored.body.before).toMatchObject({ kind: 'named', name: 'Before restoring Good' });
    expect(restored.body.changed).toBe(4);

    // Others see it live, as ordinary changes from the server.
    const live = await watcher.socket.next('ops');
    expect(live.from).toBe('server');
    expect(Object.fromEntries(live.ops.map((r) => [r.k, r.v]))).toEqual({ 'n:rect:x': 10, 'n:rect:opacity': null, 'n:circle:@': false, 'n:circle:type': null });
    await watcher.socket.close();

    const now = await valuesOf(doc.id, owner.token);
    expect(now['n:rect:x']).toBe(10);
    expect(now['n:circle:@']).toBe(false);

    // The version made first holds what was there, so the restore can itself be undone.
    const before = await call(server, 'GET', `/api/documents/${doc.id}/versions/${restored.body.before.id}`, { token: owner.token });
    expect(before.body.registers.find((r: Register) => r.k === 'n:rect:x').v).toBe(99);
    const names = (await call(server, 'GET', `/api/documents/${doc.id}/versions`, { token: owner.token })).body.map((v: { name: string }) => v.name);
    expect(names).toEqual(['Before restoring Good', 'Good']);
  });

  it('outlive their deleted document, which can be recovered from them or purged', async () => {
    const owner = await signUp(server, 'Backup');
    const doc = await newDoc(server, owner.token, 'Precious');
    await edit(doc.id, owner.token, { 'n:p:@': true, 'n:p:type': 'RECTANGLE', 'n:p:x': 7 }, 'ownerclient');
    await call(server, 'POST', `/api/documents/${doc.id}/versions`, { token: owner.token, body: { name: 'Kept' } });
    expect((await call(server, 'DELETE', `/api/documents/${doc.id}`, { token: owner.token })).status).toBe(200);
    const workspaceId = await personalWorkspace(server, owner.token);

    const deleted = await call(server, 'GET', `/api/workspaces/${workspaceId}/deleted-documents`, { token: owner.token });
    expect(deleted.body).toEqual([{ docId: doc.id, name: 'Precious', versions: 1, latestAt: expect.any(String) }]);
    const recovered = await call(server, 'POST', `/api/workspaces/${workspaceId}/deleted-documents/${doc.id}/recover`, { token: owner.token });
    expect(recovered.status).toBe(201);
    expect(recovered.body).toMatchObject({ name: 'Precious', role: 'owner' });
    expect((await valuesOf(recovered.body.id, owner.token))['n:p:x']).toBe(7);

    const outsider = await signUp(server, 'Outsider');
    expect((await call(server, 'GET', `/api/workspaces/${workspaceId}/deleted-documents`, { token: outsider.token })).status).toBe(404);
    expect((await call(server, 'DELETE', `/api/workspaces/${workspaceId}/deleted-documents/${doc.id}`, { token: owner.token })).status).toBe(200);
    expect((await call(server, 'GET', `/api/workspaces/${workspaceId}/deleted-documents`, { token: owner.token })).body).toEqual([]);
  });
});

describe('branches', () => {
  async function branchOf(name: string) {
    const people = await team(name);
    const made = await call(server, 'POST', `/api/documents/${people.doc.id}/branches`, { token: people.editor.token, body: { name: `${name} idea` } });
    expect(made.status).toBe(201);
    return { ...people, branch: made.body };
  }

  it('are made by editors, hold a copy of main, and are known as branches of it', async () => {
    const { owner, viewer, doc, branch } = await branchOf('Make');
    expect(branch).toMatchObject({ name: 'Make idea', mainId: doc.id, mainName: 'Make file', status: 'open', baseSeq: 5 });
    expect((await call(server, 'POST', `/api/documents/${doc.id}/branches`, { token: viewer.token, body: { name: 'No' } })).status).toBe(403);
    expect((await call(server, 'POST', `/api/documents/${branch.id}/branches`, { token: owner.token, body: { name: 'Deeper' } })).status).toBe(400);

    const content = await valuesOf(branch.id, owner.token);
    expect(content).toMatchObject({ 'd:name': 'Make idea', 'n:rect:@': true, 'n:rect:x': 10 });
    // Whoever may open main may open the branch, with the same role.
    expect((await call(server, 'GET', `/api/documents/${branch.id}`, { token: viewer.token })).body.role).toBe('viewer');
    expect((await call(server, 'GET', `/api/documents/${branch.id}/branch`, { token: viewer.token })).body.branch).toMatchObject({ mainId: doc.id, mainName: 'Make file' });
    expect((await call(server, 'GET', `/api/documents/${doc.id}/branch`, { token: owner.token })).body.branch).toBeNull();
    const list = await call(server, 'GET', `/api/documents/${doc.id}/branches`, { token: viewer.token });
    expect(list.body.map((b: { id: string }) => b.id)).toEqual([branch.id]);
  });

  it('are updated from main without conflicts, keeping their own changes', async () => {
    const { editor, viewer, doc, branch } = await branchOf('Update');
    await edit(doc.id, editor.token, { 'n:rect:x': 50, 'n:new:@': true, 'n:new:type': 'TEXT' });
    await edit(branch.id, editor.token, { 'n:rect:y': 80 });

    const preview = await call(server, 'GET', `/api/documents/${branch.id}/update-from-main`, { token: editor.token });
    expect(preview.body.conflicts).toEqual([]);
    expect(preview.body.changes.map((c: { key: string }) => c.key).sort()).toEqual(['n:new:@', 'n:new:type', 'n:rect:x']);

    const watcher = await TestSocket.join(server, branch.id, { token: viewer.token }, 'branchwatcher');
    expect((await call(server, 'POST', `/api/documents/${branch.id}/update-from-main`, { token: viewer.token, body: {} })).status).toBe(403);
    const updated = await call(server, 'POST', `/api/documents/${branch.id}/update-from-main`, { token: editor.token, body: {} });
    expect(updated.status).toBe(200);
    expect(updated.body.applied).toBe(3);
    expect((await watcher.socket.next('ops')).ops.map((r) => r.k).sort()).toEqual(['n:new:@', 'n:new:type', 'n:rect:x']);
    await watcher.socket.close();

    const content = await valuesOf(branch.id, editor.token);
    expect(content).toMatchObject({ 'n:rect:x': 50, 'n:rect:y': 80, 'n:new:@': true });
    // Nothing more to bring.
    expect((await call(server, 'GET', `/api/documents/${branch.id}/update-from-main`, { token: editor.token })).body.changes).toEqual([]);
  });

  it('list conflicts when updating from main, and apply the choice made for each', async () => {
    const { editor, doc, branch } = await branchOf('Clash');
    await edit(doc.id, editor.token, { 'n:rect:x': 1, 'n:rect:y': 2 });
    await edit(branch.id, editor.token, { 'n:rect:x': 100, 'n:rect:y': 200 });
    const preview = await call(server, 'GET', `/api/documents/${branch.id}/update-from-main`, { token: editor.token });
    expect(preview.body.conflicts).toEqual([
      { key: 'n:rect:x', base: 10, main: 1, branch: 100 },
      { key: 'n:rect:y', base: 20, main: 2, branch: 200 },
    ]);
    // Every conflict needs a choice.
    expect((await call(server, 'POST', `/api/documents/${branch.id}/update-from-main`, { token: editor.token, body: { resolutions: { 'n:rect:x': 'main' } } })).status).toBe(409);
    const done = await call(server, 'POST', `/api/documents/${branch.id}/update-from-main`, { token: editor.token, body: { resolutions: { 'n:rect:x': 'main', 'n:rect:y': 'branch' } } });
    expect(done.status).toBe(200);
    const content = await valuesOf(branch.id, editor.token);
    expect(content['n:rect:x']).toBe(1);
    expect(content['n:rect:y']).toBe(200);
    // The branch's own value is now a change against the new base, with no conflict: merging takes it to main.
    const review = await call(server, 'GET', `/api/documents/${branch.id}/merge`, { token: editor.token });
    expect(review.body.conflicts).toEqual([]);
    expect(review.body.changes).toEqual([{ key: 'n:rect:y', base: 2, value: 200 }]);
  });

  it('merge into main with a choice per conflict, record versions before and after, and can be rolled back', async () => {
    const { owner, editor, viewer, doc, branch } = await branchOf('Merge');
    await edit(doc.id, owner.token, { 'n:rect:x': 1 }, 'ownerclient');
    await edit(branch.id, editor.token, { 'n:rect:x': 100, 'n:rect:y': 300, 'n:star:@': true, 'n:star:type': 'STAR' });

    const review = await call(server, 'GET', `/api/documents/${branch.id}/merge`, { token: editor.token });
    expect(review.body).toMatchObject({ mainId: doc.id, canMerge: true, conflicts: [{ key: 'n:rect:x', base: 10, main: 1, branch: 100 }] });
    expect(review.body.changes.map((c: { key: string }) => c.key).sort()).toEqual(['n:rect:x', 'n:rect:y', 'n:star:@', 'n:star:type']);

    // Someone who may edit the branch but only view main may not merge.
    await call(server, 'POST', `/api/documents/${branch.id}/members`, { token: owner.token, body: { email: viewer.user.email, role: 'editor' } });
    expect((await call(server, 'GET', `/api/documents/${branch.id}/merge`, { token: viewer.token })).body.canMerge).toBe(false);
    expect((await call(server, 'POST', `/api/documents/${branch.id}/merge`, { token: viewer.token, body: { resolutions: { 'n:rect:x': 'branch' } } })).status).toBe(403);
    expect((await call(server, 'POST', `/api/documents/${branch.id}/merge`, { token: editor.token, body: {} })).status).toBe(409);

    const watcher = await TestSocket.join(server, doc.id, { token: owner.token }, 'mainwatcher');
    const merged = await call(server, 'POST', `/api/documents/${branch.id}/merge`, { token: editor.token, body: { resolutions: { 'n:rect:x': 'main' } } });
    expect(merged.status).toBe(200);
    expect(merged.body).toMatchObject({ applied: 3, before: { name: 'Before merging Merge idea' }, after: { name: 'Merged Merge idea' }, branch: { status: 'merged', mergedBy: { id: editor.user.id } } });
    expect((await watcher.socket.next('ops')).ops.map((r) => r.k).sort()).toEqual(['n:rect:y', 'n:star:@', 'n:star:type']);
    await watcher.socket.close();

    const main = await valuesOf(doc.id, owner.token);
    expect(main).toMatchObject({ 'd:name': 'Merge file', 'n:rect:x': 1, 'n:rect:y': 300, 'n:star:@': true });
    expect((await call(server, 'POST', `/api/documents/${branch.id}/merge`, { token: editor.token, body: {} })).status).toBe(409);
    // The branch stays, archived, and can still be opened.
    expect((await call(server, 'GET', `/api/documents/${branch.id}/branch`, { token: editor.token })).body.branch.status).toBe('merged');
    expect((await call(server, 'GET', `/api/documents/${branch.id}/registers`, { token: editor.token })).status).toBe(200);

    // Rolling the merge back: restoring the version made before it.
    const rolled = await call(server, 'POST', `/api/documents/${doc.id}/versions/${merged.body.before.id}/restore`, { token: owner.token });
    expect(rolled.status).toBe(200);
    const after = await valuesOf(doc.id, owner.token);
    expect(after).toMatchObject({ 'n:rect:x': 1, 'n:rect:y': 20, 'n:star:@': false });
  });
});
