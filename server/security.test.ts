/**
 * Security tests of the collaboration server (Phase 10).
 *
 * - Every route of the API, read from the API's own route table, is called by
 *   someone who should not get through (nobody, a guest, someone outside the
 *   workspace, a viewer) and must be refused. A route added later without an
 *   entry in ACCESS fails the test, so every route is decided on.
 * - IDs of other people's documents, versions, comments, projects, trash and
 *   notifications, mixed with one's own (IDOR).
 * - Bodies: depth, __proto__, registers with hostile keys, clocks and values.
 * - Rate limits, sessions (hashing, logout everywhere, absolute expiry),
 *   uploads (types), security headers, static files (path traversal), the
 *   WebSocket (size before hello, fragments, floods), Google sign-in
 *   (redirects, linking an account made by someone else).
 */
import { createServer, request, type Server } from 'node:http';
import { connect, type Socket } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi, DEFAULT_LIMITS } from './api.ts';
import { Store, invalidRegisters } from './store.ts';
import { Hub, MAX_MESSAGES_PER_WINDOW, cleanPresence } from './hub.ts';
import { MB, tooDeep } from './http.ts';
import { allowedOrigin } from './google.ts';
import * as versions from './versions.ts';
import * as plugins from './plugins.ts';
import * as community from './community.ts';
import { call, clock, newDoc, personalWorkspace, signUp, tempDir, testServer, TestSocket, type TestServer } from './testing.ts';
import { makeBundle } from '../src/plugins/manifest.ts';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const hashOf = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const DENIED = [401, 403, 404, 410];

/** The routes of the API as it is built, "METHOD /path/:param". */
function routeTable(): string[] {
  const dir = tempDir();
  const store = new Store(dir);
  const hub = new Hub(store, { heartbeatMs: 60_000 });
  try {
    for (const part of [versions, plugins, community]) part.setup(store);
    const api = createApi(store, hub, {
      extensions: [versions.extension, plugins.extension, community.extension],
      version: 'test',
      maxJsonBytes: MB,
      maxUploadBytes: MB,
      limits: DEFAULT_LIMITS,
    });
    return api.routes.map((route) => `${route.method} /${route.parts.join('/')}`);
  } finally {
    hub.closeAll();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

type Persona = 'anonymous' | 'outsider' | 'guest' | 'viewer';

/**
 * Who must be refused on each route. "public" routes are open to anyone
 * (they are still called, and must not fail with 500). A persona not listed
 * may be allowed (a viewer may comment; anyone with an account may make a
 * workspace), and is not called, so that the walk changes nothing.
 */
const A: Persona = 'anonymous';
const O: Persona = 'outsider';
const G: Persona = 'guest';
const V: Persona = 'viewer';
const ACCESS: Record<string, Persona[] | 'public'> = {
  'GET /api/health': 'public',
  'POST /api/auth/signup': 'public',
  'POST /api/auth/login': 'public',
  'POST /api/auth/logout': 'public',
  'POST /api/auth/logout-all': [A, G],
  'GET /api/auth/providers': 'public',
  'GET /api/auth/google/start': 'public',
  'GET /api/auth/google/callback': 'public',
  'POST /api/auth/google/redeem': 'public',
  'POST /api/guests': 'public',
  'GET /api/me': [A, G],
  'PATCH /api/me': [A, G],
  'GET /api/workspaces': [A, G],
  'POST /api/workspaces': [A, G],
  'PATCH /api/workspaces/:id': [A, O, G, V],
  'DELETE /api/workspaces/:id': [A, O, G, V],
  'GET /api/workspaces/:id/members': [A, O, G],
  'POST /api/workspaces/:id/members': [A, O, G, V],
  'PATCH /api/workspaces/:id/members/:userId': [A, O, G, V],
  'DELETE /api/workspaces/:id/members/:userId': [A, O, G, V],
  'POST /api/workspaces/:id/invites': [A, O, G, V],
  'GET /api/invites/:token': 'public',
  'POST /api/invites/:token/accept': [A, G],
  'GET /api/workspaces/:id/documents': [A, O, G],
  'GET /api/shared': [A, G],
  'POST /api/documents': [A, O, G, V],
  'GET /api/documents/:id': [A, O, G],
  'PATCH /api/documents/:id': [A, O, G, V],
  'DELETE /api/documents/:id': [A, O, G, V],
  'POST /api/documents/:id/trash': [A, O, G, V],
  'GET /api/documents/:id/members': [A, O, G],
  'POST /api/documents/:id/members': [A, O, G, V],
  'PATCH /api/documents/:id/members/:userId': [A, O, G, V],
  'DELETE /api/documents/:id/members/:userId': [A, O, G, V],
  'GET /api/documents/:id/registers': [A, O, G],
  'PUT /api/documents/:id/assets/:hash': [A, O, G, V],
  'GET /api/documents/:id/assets/:hash': [A, O, G],
  'GET /api/documents/:id/threads': [A, O, G],
  'POST /api/documents/:id/threads': [A, O, G],
  'POST /api/threads/:id/comments': [A, O, G],
  'PATCH /api/threads/:id': [A, O, G, V],
  'DELETE /api/threads/:id': [A, O, G, V],
  'PATCH /api/comments/:id': [A, O, G, V],
  'DELETE /api/comments/:id': [A, O, G, V],
  'GET /api/notifications': [A],
  'POST /api/notifications/read': [A],
  // versions.ts
  'GET /api/documents/:id/versions': [A, O, G],
  'POST /api/documents/:id/versions': [A, O, G, V],
  'GET /api/documents/:id/versions/:versionId': [A, O, G],
  'PATCH /api/documents/:id/versions/:versionId': [A, O, G, V],
  'DELETE /api/documents/:id/versions/:versionId': [A, O, G, V],
  'POST /api/documents/:id/versions/:versionId/restore': [A, O, G, V],
  'GET /api/workspaces/:id/deleted-documents': [A, O, G, V],
  'POST /api/workspaces/:id/deleted-documents/:docId/recover': [A, O, G, V],
  'DELETE /api/workspaces/:id/deleted-documents/:docId': [A, O, G, V],
  'POST /api/documents/:id/branches': [A, O, G, V],
  'GET /api/documents/:id/branches': [A, O, G],
  'GET /api/documents/:id/branch': [A, O, G],
  'GET /api/documents/:id/update-from-main': [A, O, G],
  'POST /api/documents/:id/update-from-main': [A, O, G, V],
  'GET /api/documents/:id/merge': [A, O, G],
  'POST /api/documents/:id/merge': [A, O, G, V],
  // plugins.ts
  'GET /api/plugins/directory': 'public',
  'POST /api/plugins/directory': [A, O, G, V],
  'GET /api/plugins/directory/:id': 'public',
  'GET /api/plugins/directory/:id/versions/:version': 'public',
  'POST /api/plugins/directory/:id/install': 'public',
  'DELETE /api/plugins/directory/:id': [A, O, G, V],
  // community.ts
  'GET /api/community/resources': 'public',
  'GET /api/community/tags': 'public',
  'GET /api/community/mine': [A, G],
  'POST /api/community/resources': [A, O, G, V],
  'GET /api/community/resources/:id': 'public',
  'PATCH /api/community/resources/:id': [A, O, G, V],
  'DELETE /api/community/resources/:id': [A, O, G, V],
  'PUT /api/community/resources/:id/cover': [A, O, G, V],
  'GET /api/community/resources/:id/cover': 'public',
  'PUT /api/community/resources/:id/assets/:hash': [A, O, G, V],
  'GET /api/community/resources/:id/assets/:hash': 'public',
  'GET /api/community/resources/:id/versions/:number': 'public',
  'POST /api/community/resources/:id/copies': 'public',
  'POST /api/community/resources/:id/duplicate': [A, O, G, V],
  'GET /api/workspaces/:id/projects': [A, O, G],
  'POST /api/workspaces/:id/projects': [A, O, G, V],
  'PATCH /api/projects/:id': [A, O, G, V],
  'DELETE /api/projects/:id': [A, O, G, V],
  'GET /api/workspaces/:id/files': [A, O, G],
  'POST /api/documents/:id/move': [A, O, G, V],
  'POST /api/documents/:id/duplicate': [A, O, G, V],
  'GET /api/workspaces/:id/trash': [A, O, G],
  'POST /api/trash/:docId/restore': [A, O, G, V],
  'DELETE /api/trash/:docId': [A, O, G, V],
  'GET /api/favorites': [A, G],
  'PUT /api/favorites/:docId': [A, O, G],
  'DELETE /api/favorites/:docId': [A, G],
  'GET /api/recents': [A, G],
  'POST /api/recents/:docId': [A, O, G],
  'GET /api/files/search': [A, G],
  // email.ts
  'GET /api/me/email': [A, G],
  'PATCH /api/me/email': [A, G],
  'POST /api/me/email/resend': [A, G],
  'POST /api/auth/verify-email': 'public',
};

interface World {
  owner: { token: string; id: string; email: string };
  viewer: { token: string; id: string; email: string };
  outsider: { token: string; id: string; workspace: string; doc: string };
  guest: string;
  workspace: string;
  doc: string;
  image: string;
  thread: string;
  comment: string;
  version: string;
  branch: string;
  project: string;
  trashed: string;
  deleted: string;
  resource: string;
  plugin: string;
  invite: string;
  notification: string;
}

let server: TestServer;
let world: World;

async function ok<T = any>(answer: Promise<{ status: number; body: T }>, status = [200, 201]): Promise<T> {
  const got = await answer;
  if (!status.includes(got.status)) throw new Error(`Setting up failed: ${got.status} ${JSON.stringify(got.body)}`);
  return got.body;
}

async function build(): Promise<World> {
  const owner = await signUp(server, 'Owner');
  const workspace = await personalWorkspace(server, owner.token);
  const imageBytes = new Uint8Array([...PNG, ...randomBytes(8)]);
  const image = hashOf(imageBytes);
  const doc = (
    await newDoc(server, owner.token, 'Secret plans', [
      { k: 'n:page1:@', v: true, c: clock(1000, 'seed') },
      { k: 'n:page1:type', v: 'PAGE', c: clock(1000, 'seed', 1) },
      { k: `a:${image}`, v: { mimeType: 'image/png', width: 1, height: 1 }, c: clock(1000, 'seed', 2) },
    ])
  ).id;
  await ok(call(server, 'PUT', `/api/documents/${doc}/assets/${image}`, { token: owner.token, body: imageBytes, headers: { 'Content-Type': 'image/png' } }));
  const thread = await ok(call(server, 'POST', `/api/documents/${doc}/threads`, { token: owner.token, body: { pageId: 'page1', x: 1, y: 2, body: 'Owner only' } }));
  const version = await ok(call(server, 'POST', `/api/documents/${doc}/versions`, { token: owner.token, body: { name: 'First' } }));
  const branch = await ok(call(server, 'POST', `/api/documents/${doc}/branches`, { token: owner.token, body: { name: 'Idea' } }));
  const project = await ok(call(server, 'POST', `/api/workspaces/${workspace}/projects`, { token: owner.token, body: { name: 'Project' } }));
  const trashed = (await newDoc(server, owner.token, 'Old')).id;
  await ok(call(server, 'POST', `/api/documents/${trashed}/trash`, { token: owner.token }));
  const deleted = (await newDoc(server, owner.token, 'Gone')).id;
  await ok(call(server, 'POST', `/api/documents/${deleted}/versions`, { token: owner.token, body: { name: 'Kept' } }));
  await ok(call(server, 'POST', `/api/documents/${deleted}/trash`, { token: owner.token }));
  await ok(call(server, 'DELETE', `/api/trash/${deleted}`, { token: owner.token }));
  const published = await ok(call(server, 'POST', '/api/community/resources', { token: owner.token, body: { docId: doc, kind: 'file', title: 'Public thing' } }));
  await ok(call(server, 'PUT', `/api/community/resources/${published.resource.id}/cover`, { token: owner.token, body: PNG, headers: { 'Content-Type': 'image/png' } }));
  const bundle = makeBundle({ id: 'com.example.secure', name: 'Secure', version: '1.0.0', author: 'Tests', kind: 'plugin', api: 1, permissions: [] }, 'evora.closePlugin();', null);
  await ok(call(server, 'POST', '/api/plugins/directory', { token: owner.token, body: { bundle } }));
  const invite = await ok(call(server, 'POST', `/api/workspaces/${workspace}/invites`, { token: owner.token, body: { role: 'viewer' } }));
  await ok(call(server, 'PUT', `/api/favorites/${doc}`, { token: owner.token }));

  const viewer = await signUp(server, 'Viewer');
  await ok(call(server, 'POST', `/api/workspaces/${workspace}/members`, { token: owner.token, body: { email: viewer.user.email, role: 'viewer' } }));
  // A reply by the viewer: the owner is told, which gives the owner a notification.
  await ok(call(server, 'POST', `/api/threads/${thread.id}/comments`, { token: viewer.token, body: { body: 'Seen' } }));
  const notes = await ok(call(server, 'GET', '/api/notifications', { token: owner.token }));

  const outsider = await signUp(server, 'Outsider');
  const outsiderWorkspace = await personalWorkspace(server, outsider.token);
  const outsiderDoc = (await newDoc(server, outsider.token, 'Mine')).id;
  const guest = await ok(call(server, 'POST', '/api/guests', { body: { name: 'Guest' } }));

  return {
    owner: { token: owner.token, id: owner.user.id, email: owner.user.email },
    viewer: { token: viewer.token, id: viewer.user.id, email: viewer.user.email },
    outsider: { token: outsider.token, id: outsider.user.id, workspace: outsiderWorkspace, doc: outsiderDoc },
    guest: guest.guestToken,
    workspace,
    doc,
    image,
    thread: thread.id,
    comment: thread.comments[0].id,
    version: version.id,
    branch: branch.id,
    project: project.id,
    trashed,
    deleted,
    resource: published.resource.id,
    plugin: 'com.example.secure',
    invite: invite.token,
    notification: notes[0].id,
  };
}

/** The path of a route with the world's IDs put in, and the body to send. */
function requestFor(route: string, w: World): { method: string; path: string; body?: unknown; headers?: Record<string, string> } {
  const [method, pattern] = route.split(' ') as [string, string];
  // Parameters by the route they are in: the doc of a branch route is the branch.
  const branchRoute = /update-from-main|\/merge$/.test(pattern);
  const params: Record<string, string> = {
    id: pattern.startsWith('/api/workspaces')
      ? w.workspace
      : pattern.startsWith('/api/threads')
        ? w.thread
        : pattern.startsWith('/api/comments')
          ? w.comment
          : pattern.startsWith('/api/projects')
            ? w.project
            : pattern.startsWith('/api/community')
              ? w.resource
              : pattern.startsWith('/api/plugins')
                ? w.plugin
                : branchRoute
                  ? w.branch
                  : w.doc,
    userId: route.startsWith('PATCH') ? w.viewer.id : w.owner.id,
    hash: w.image,
    token: route.includes('accept') ? 'not-a-real-invite' : w.invite,
    versionId: w.version,
    docId: pattern.includes('deleted-documents') ? w.deleted : pattern.includes('/trash/') ? w.trashed : w.doc,
    version: '1.0.0',
    number: '1',
  };
  const path = pattern.replace(/:([A-Za-z]+)/g, (_, name: string) => encodeURIComponent(params[name] ?? 'x'));
  const bodies: Record<string, unknown> = {
    'POST /api/workspaces/:id/members': { email: 'someone@example.com', role: 'editor' },
    'PATCH /api/workspaces/:id/members/:userId': { role: 'owner' },
    'POST /api/workspaces/:id/invites': { role: 'owner' },
    'POST /api/documents': { workspaceId: w.workspace, name: 'Planted' },
    'PATCH /api/documents/:id': { name: 'Renamed', linkAccess: 'edit' },
    'POST /api/documents/:id/members': { email: 'someone@example.com', role: 'editor' },
    'PATCH /api/documents/:id/members/:userId': { role: 'owner' },
    'POST /api/documents/:id/threads': { pageId: 'page1', x: 1, y: 1, body: 'Hello' },
    'POST /api/threads/:id/comments': { body: 'Hello' },
    'PATCH /api/threads/:id': { x: 99 },
    'PATCH /api/comments/:id': { body: 'Changed' },
    'POST /api/notifications/read': { ids: [w.notification] },
    'POST /api/documents/:id/versions': { name: 'Planted' },
    'PATCH /api/documents/:id/versions/:versionId': { name: 'Renamed' },
    'POST /api/documents/:id/branches': { name: 'Planted' },
    'POST /api/documents/:id/update-from-main': { resolutions: {} },
    'POST /api/documents/:id/merge': { resolutions: {} },
    'POST /api/plugins/directory': {
      bundle: makeBundle({ id: 'com.example.secure', name: 'Taken over', version: '9.0.0', author: 'Someone else', kind: 'plugin', api: 1, permissions: [] }, 'evora.closePlugin();', null),
    },
    'POST /api/community/resources': { docId: w.doc, kind: 'file', title: 'Leaked' },
    'PATCH /api/community/resources/:id': { title: 'Defaced' },
    'POST /api/community/resources/:id/duplicate': { workspaceId: w.workspace },
    'POST /api/workspaces/:id/projects': { name: 'Planted' },
    'PATCH /api/projects/:id': { name: 'Renamed' },
    'POST /api/documents/:id/move': { projectId: w.project },
  };
  if (route === 'PUT /api/documents/:id/assets/:hash' || route === 'PUT /api/community/resources/:id/assets/:hash') return { method, path, body: PNG, headers: { 'Content-Type': 'image/png' } };
  if (route === 'PUT /api/community/resources/:id/cover') return { method, path, body: PNG, headers: { 'Content-Type': 'image/png' } };
  return { method, path, body: bodies[route] };
}

function credentials(persona: Persona, w: World): { token?: string; guest?: string } {
  if (persona === 'outsider') return { token: w.outsider.token };
  if (persona === 'viewer') return { token: w.viewer.token };
  if (persona === 'guest') return { guest: w.guest };
  return {};
}

beforeAll(async () => {
  server = await testServer();
  world = await build();
}, 60_000);

afterAll(async () => {
  await server?.stop();
});

describe('authorization on every route', () => {
  const table = routeTable();

  it('has a decision for every route of the API, and no decision for a route that is gone', () => {
    const undecided = table.filter((route) => !(route in ACCESS));
    expect(undecided, 'Routes without an entry in ACCESS (decide who must be refused)').toEqual([]);
    const gone = Object.keys(ACCESS).filter((route) => !table.includes(route));
    expect(gone).toEqual([]);
    // Every route is reached by its own method and path: none shadows another.
    expect(new Set(table).size).toBe(table.length);
  });

  it('refuses nobody, a guest, an outsider and a viewer wherever they must be refused, without saying more than it must', async () => {
    const failures: string[] = [];
    for (const route of table) {
      const access = ACCESS[route];
      if (!access) continue;
      const personas: Persona[] = access === 'public' ? [] : access;
      for (const persona of personas) {
        const { method, path, body, headers } = requestFor(route, world);
        const answer = await call(server, method, path, { ...credentials(persona, world), body, headers });
        if (!DENIED.includes(answer.status)) failures.push(`${route} as ${persona}: ${answer.status} ${JSON.stringify(answer.body).slice(0, 120)}`);
        else if (typeof answer.body?.error !== 'string' || /at \w+ \(|\.ts:\d+|SQLITE|node:/.test(answer.body.error)) failures.push(`${route} as ${persona}: an error that says too much: ${JSON.stringify(answer.body)}`);
      }
    }
    expect(failures).toEqual([]);
  }, 60_000);

  it('answers the public routes without a server error, to anyone', async () => {
    const failures: string[] = [];
    for (const route of table) {
      if (ACCESS[route] !== 'public') continue;
      // Signing out as someone would end the session the later tests use: nobody in particular signs out instead.
      const personas: Persona[] = route === 'POST /api/auth/logout' ? ['anonymous'] : ['anonymous', 'guest', 'outsider'];
      for (const persona of personas) {
        const { method, path, body, headers } = requestFor(route, world);
        const answer = await call(server, method, path, { ...credentials(persona, world), body, headers });
        if (answer.status >= 500) failures.push(`${route} as ${persona}: ${answer.status}`);
      }
    }
    expect(failures).toEqual([]);
  }, 60_000);

  it('left everything as it was: nothing a refused request asked for happened', async () => {
    const owner = world.owner.token;
    const doc = await call(server, 'GET', `/api/documents/${world.doc}`, { token: owner });
    expect(doc.body).toMatchObject({ name: 'Secret plans', linkAccess: 'none' });
    const members = await call(server, 'GET', `/api/workspaces/${world.workspace}/members`, { token: owner });
    expect(members.body.members.map((m: { user: { id: string }; role: string }) => [m.user.id, m.role]).sort()).toEqual([[world.owner.id, 'owner'], [world.viewer.id, 'viewer']].sort());
    expect(members.body.pending).toEqual([]);
    const threads = await call(server, 'GET', `/api/documents/${world.doc}/threads`, { token: owner });
    expect(threads.body).toHaveLength(1);
    expect(threads.body[0]).toMatchObject({ x: 1, y: 2 });
    expect(threads.body[0].comments[0].body).toBe('Owner only');
    const versionList = await call(server, 'GET', `/api/documents/${world.doc}/versions`, { token: owner });
    expect(versionList.body.map((v: { name: string }) => v.name)).toEqual(['First']);
    const plugin = await call(server, 'GET', `/api/plugins/directory/${world.plugin}`);
    expect(plugin.body).toMatchObject({ name: 'Secure', version: '1.0.0' });
    const resource = await call(server, 'GET', `/api/community/resources/${world.resource}`);
    expect(resource.body.title).toBe('Public thing');
    const trash = await call(server, 'GET', `/api/workspaces/${world.workspace}/trash`, { token: owner });
    expect(trash.body.map((t: { id: string }) => t.id)).toEqual([world.trashed]);
    const notes = await call(server, 'GET', '/api/notifications', { token: owner });
    expect(notes.body.find((n: { id: string }) => n.id === world.notification)?.read).toBe(false);
    const files = await call(server, 'GET', `/api/workspaces/${world.workspace}/files`, { token: owner });
    expect(files.body.map((f: { name: string }) => f.name).sort()).toEqual(['Secret plans']);
  });
});

describe('IDs of what belongs to others (IDOR)', () => {
  it('does not reach a version, a deleted file, a project or a branch through a document or workspace of one’s own', async () => {
    const t = world.outsider.token;
    const mine = world.outsider.doc;
    expect((await call(server, 'GET', `/api/documents/${mine}/versions/${world.version}`, { token: t })).status).toBe(404);
    expect((await call(server, 'PATCH', `/api/documents/${mine}/versions/${world.version}`, { token: t, body: { name: 'Mine now' } })).status).toBe(404);
    expect((await call(server, 'DELETE', `/api/documents/${mine}/versions/${world.version}`, { token: t })).status).toBe(404);
    expect((await call(server, 'POST', `/api/documents/${mine}/versions/${world.version}/restore`, { token: t })).status).toBe(404);
    expect((await call(server, 'POST', `/api/workspaces/${world.outsider.workspace}/deleted-documents/${world.deleted}/recover`, { token: t })).status).toBe(404);
    expect((await call(server, 'DELETE', `/api/workspaces/${world.outsider.workspace}/deleted-documents/${world.deleted}`, { token: t })).status).toBe(404);
    // A project of another workspace is refused as a place for one's own file, or for a copy.
    expect((await call(server, 'POST', `/api/documents/${mine}/move`, { token: t, body: { projectId: world.project } })).status).toBe(400);
    expect((await call(server, 'POST', `/api/community/resources/${world.resource}/duplicate`, { token: t, body: { workspaceId: world.outsider.workspace, projectId: world.project } })).status).toBe(400);
    // One's own file moved into someone else's workspace.
    expect((await call(server, 'POST', `/api/documents/${mine}/move`, { token: t, body: { workspaceId: world.workspace } })).status).toBe(404);
    // A file that is not a branch has nothing to merge.
    expect((await call(server, 'POST', `/api/documents/${mine}/merge`, { token: t, body: {} })).status).toBe(404);
    // Someone else's notification cannot be marked read; someone else's favourite cannot be removed.
    expect((await call(server, 'POST', '/api/notifications/read', { token: t, body: { ids: [world.notification] } })).status).toBe(200);
    expect((await call(server, 'DELETE', `/api/favorites/${world.doc}`, { token: t })).status).toBe(200);
    const notes = await call(server, 'GET', '/api/notifications', { token: world.owner.token });
    expect(notes.body.find((n: { id: string }) => n.id === world.notification)?.read).toBe(false);
    const favorites = await call(server, 'GET', '/api/favorites', { token: world.owner.token });
    expect(favorites.body.map((f: { id: string }) => f.id)).toContain(world.doc);
    // Search finds only what one can open.
    const found = await call(server, 'GET', `/api/files/search?q=${encodeURIComponent('Secret')}`, { token: t });
    expect(found.body).toEqual([]);
    // A version of the owner's file is still there and unchanged.
    const listed = await call(server, 'GET', `/api/documents/${world.doc}/versions`, { token: world.owner.token });
    expect(listed.body.map((v: { id: string; name: string }) => [v.id, v.name])).toEqual([[world.version, 'First']]);
  });

  it('does not let a file’s viewer publish it to the Community or a guest by link change who has access', async () => {
    const doc = await newDoc(server, world.owner.token, 'Link file');
    await call(server, 'PATCH', `/api/documents/${doc.id}`, { token: world.owner.token, body: { linkAccess: 'view' } });
    const guestView = await call(server, 'GET', `/api/documents/${doc.id}`, { guest: world.guest });
    expect(guestView.status).toBe(200);
    expect(guestView.body.role).toBe('viewer');
    expect((await call(server, 'POST', `/api/documents/${doc.id}/threads`, { guest: world.guest, body: { pageId: 'p', x: 0, y: 0, body: 'A guest may comment' } })).status).toBe(201);
    expect((await call(server, 'POST', '/api/community/resources', { token: world.outsider.token, body: { docId: doc.id, kind: 'file', title: 'Taken' } })).status).toBe(403);
    expect((await call(server, 'PATCH', `/api/documents/${doc.id}`, { guest: world.guest, body: { linkAccess: 'edit' } })).status).toBe(403);
    expect((await call(server, 'GET', `/api/documents/${doc.id}/members`, { guest: world.guest })).status).toBe(403);
    expect((await call(server, 'PUT', `/api/documents/${doc.id}/assets/${hashOf(PNG)}`, { guest: world.guest, body: PNG, headers: { 'Content-Type': 'image/png' } })).status).toBe(403);
  });
});

describe('bodies and registers', () => {
  it('refuses JSON nested too deep, and a body that is not an object', async () => {
    const deep = '['.repeat(200) + ']'.repeat(200);
    const answer = await fetch(`${server.url}/api/auth/login`, { method: 'POST', body: `{"email":"a@b.c","password":${deep}}`, headers: { 'Content-Type': 'application/json' } });
    expect(answer.status).toBe(400);
    expect(((await answer.json()) as { error: string }).error).toMatch(/nested more than 64/);
    // Far deeper than any stack: refused, and the server goes on.
    const deeper = await fetch(`${server.url}/api/auth/login`, { method: 'POST', body: `{"x":${'['.repeat(500_000)}${']'.repeat(500_000)}}`, headers: { 'Content-Type': 'application/json' } });
    expect(deeper.status).toBe(400);
    expect((await call(server, 'GET', '/api/auth/providers')).status).toBe(200);
    expect(tooDeep({ a: [[[1]]] }, 4)).toBe(false);
    expect(tooDeep({ a: [[[[1]]]] }, 4)).toBe(true);
  });

  it('keeps __proto__ in a body as data: nothing gets a prototype from it', async () => {
    const res = await fetch(`${server.url}/api/auth/signup`, {
      method: 'POST',
      body: `{"__proto__":{"polluted":true,"role":"owner"},"email":"proto.${Date.now()}@example.com","name":"Proto","password":"correct horse battery","constructor":{"prototype":{"polluted":true}}}`,
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(201);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it('refuses registers with a __proto__ key, a value nested too deep, or a clock that would break other clients', () => {
    const now = Date.now();
    const good = { k: 'n:a:x', v: 1, c: clock(now, 'client') };
    expect(invalidRegisters([good], now)).toBeNull();
    expect(invalidRegisters([{ ...good, k: 'n:__proto__:x' }], now)).toMatch(/__proto__/);
    expect(invalidRegisters([{ ...good, k: 't:styles:__proto__' }], now)).toMatch(/__proto__/);
    expect(invalidRegisters([{ ...good, k: 'a:__proto__' }], now)).toMatch(/__proto__/);
    let nested: unknown = 1;
    for (let i = 0; i < 100; i++) nested = [nested];
    expect(invalidRegisters([{ ...good, v: nested }], now)).toMatch(/nested more than/);
    // A counter so long that every client would read it as Infinity (and then make clocks "…Infinity…").
    const ms = clock(now, 'client').slice(0, 9);
    expect(invalidRegisters([{ ...good, c: `${ms}.${'z'.repeat(400)}.client` }], now)).toMatch(/no valid clock/);
    // Eleven digits, but past the largest integer a client can add one to.
    expect(invalidRegisters([{ ...good, c: `${ms}.${'z'.repeat(11)}.client` }], now)).toMatch(/counter is too large/);
    expect(invalidRegisters([{ ...good, c: `${ms}.${(2 ** 50).toString(36)}.client` }], now)).toBeNull();
    // A clock a day and more ahead would win over every change made after it.
    expect(invalidRegisters([{ ...good, c: clock(now + 25 * 60 * 60 * 1000, 'client') }], now)).toMatch(/too far in the future/);
  });

  it('refuses such registers over HTTP and over the live connection', async () => {
    const workspaceId = world.workspace;
    const bad = await call(server, 'POST', '/api/documents', { token: world.owner.token, body: { workspaceId, name: 'Bad', registers: [{ k: 'n:__proto__:polluted', v: true, c: clock(Date.now(), 'x') }] } });
    expect(bad.status).toBe(400);
    const { socket } = await TestSocket.join(server, world.doc, { token: world.owner.token }, 'protoclient');
    socket.send({ t: 'ops', id: 'p1', ops: [{ k: 'n:__proto__:type', v: 'FRAME', c: clock(Date.now(), 'protoclient') }] });
    expect((await socket.next('rejected')).reason).toMatch(/__proto__/);
    await socket.close();
  });

  it('keeps a search to a few short words, with % and _ taken as themselves', async () => {
    const all = await call(server, 'GET', '/api/community/resources');
    const percent = await call(server, 'GET', `/api/community/resources?q=${encodeURIComponent('%')}`);
    const underscore = await call(server, 'GET', `/api/community/resources?q=${encodeURIComponent('_')}`);
    expect(all.body.total).toBeGreaterThan(0);
    expect(percent.body.total).toBe(0);
    expect(underscore.body.total).toBe(0);
    // As long as an address may be (about 8 KB): five words are read, each cut to 100 characters.
    const long = await call(server, 'GET', `/api/community/resources?q=${encodeURIComponent(`${'%_'.repeat(300)} `.repeat(4))}`);
    expect(long.status).toBe(200);
    const files = await call(server, 'GET', `/api/files/search?q=${encodeURIComponent('%')}`, { token: world.owner.token });
    expect(files.body).toEqual([]);
  });
});

describe('rate limits', () => {
  let limited: TestServer;
  beforeAll(async () => {
    limited = await testServer({ limits: { loginAddressFailures: 3, comments: 2, invites: 2, uploads: 1 } });
  });
  afterAll(async () => {
    await limited?.stop();
  });

  it('limits wrong passwords from one address across many emails (one password tried on many accounts)', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await call(limited, 'POST', '/api/auth/login', { body: { email: `spray${i}@example.com`, password: 'Password1' } })).status);
    expect(statuses).toEqual([401, 401, 401, 429]);
  });

  it('limits comments, invitations and uploads per person', async () => {
    const owner = await signUp(limited, 'Busy');
    const doc = await newDoc(limited, owner.token, 'Busy file');
    const workspaceId = await personalWorkspace(limited, owner.token);
    const comment = () => call(limited, 'POST', `/api/documents/${doc.id}/threads`, { token: owner.token, body: { pageId: 'p', x: 0, y: 0, body: 'Again' } });
    expect([(await comment()).status, (await comment()).status, (await comment()).status]).toEqual([201, 201, 429]);
    const invite = (n: number) => call(limited, 'POST', `/api/workspaces/${workspaceId}/members`, { token: owner.token, body: { email: `invitee${n}@example.com`, role: 'viewer' } });
    expect([(await invite(1)).status, (await invite(2)).status, (await invite(3)).status]).toEqual([200, 200, 429]);
    expect((await call(limited, 'POST', `/api/workspaces/${workspaceId}/invites`, { token: owner.token, body: { role: 'viewer' } })).status).toBe(429);
    const upload = (bytes: Uint8Array) => call(limited, 'PUT', `/api/documents/${doc.id}/assets/${hashOf(bytes)}`, { token: owner.token, body: bytes, headers: { 'Content-Type': 'image/png' } });
    expect((await upload(PNG)).status).toBe(200);
    expect((await upload(new Uint8Array([...PNG, 9]))).status).toBe(429);
  });
});

describe('sessions', () => {
  it('keeps only a hash of 32 random bytes, ends every session on "sign out everywhere", and its live connections', async () => {
    const email = `everywhere.${Date.now()}@example.com`;
    const first = await signUp(server, 'Everywhere', email);
    const second = (await call(server, 'POST', '/api/auth/login', { body: { email, password: 'correct horse battery' } })).body;
    expect(Buffer.from(first.token, 'base64url')).toHaveLength(32);
    const rows = server.store.all<{ token_hash: string }>(`SELECT token_hash FROM sessions WHERE user_id = ?`, first.user.id);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.token_hash)).not.toContain(first.token);
    expect(rows.map((row) => row.token_hash)).toContain(createHash('sha256').update(first.token).digest('hex'));
    const doc = await newDoc(server, first.token, 'Open elsewhere');
    const { socket } = await TestSocket.join(server, doc.id, { token: second.token }, 'elsewhere');
    expect((await call(server, 'POST', '/api/auth/logout-all', { token: first.token })).status).toBe(200);
    expect((await socket.closed).code).toBe(4401);
    expect((await call(server, 'GET', '/api/me', { token: first.token })).status).toBe(401);
    expect((await call(server, 'GET', '/api/me', { token: second.token })).status).toBe(401);
    expect(server.store.all(`SELECT * FROM sessions WHERE user_id = ?`, first.user.id)).toEqual([]);
  });

  it('ends a session a year after it started, however often it is used', async () => {
    const person = await signUp(server, 'Old session');
    expect((await call(server, 'GET', '/api/me', { token: person.token })).status).toBe(200);
    server.store.run(`UPDATE sessions SET created_at = ? WHERE user_id = ?`, new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString(), person.user.id);
    expect((await call(server, 'GET', '/api/me', { token: person.token })).status).toBe(401);
  });

  it('keeps passwords as salted scrypt and refuses passwords that are too short or too long', async () => {
    const person = await signUp(server, 'Hashed');
    const stored = server.store.one<{ password: string }>(`SELECT password FROM users WHERE id = ?`, person.user.id)?.password ?? '';
    expect(stored).toMatch(/^scrypt:16384:8:1:[A-Za-z0-9+/=]{24}:[A-Za-z0-9+/=]{88}$/);
    expect((await call(server, 'POST', '/api/auth/signup', { body: { email: `short.${Date.now()}@example.com`, name: 'S', password: 'seven77' } })).status).toBe(400);
    expect((await call(server, 'POST', '/api/auth/signup', { body: { email: `long.${Date.now()}@example.com`, name: 'L', password: 'x'.repeat(1025) } })).status).toBe(400);
  });
});

describe('uploads', () => {
  it('serves an upload declared as a page or a script as bytes, and every upload under a sandbox', async () => {
    const doc = await newDoc(server, world.owner.token, 'Uploads');
    const html = new TextEncoder().encode('<html><script>alert(document.cookie)</script></html>');
    const put = await call(server, 'PUT', `/api/documents/${doc.id}/assets/${hashOf(html)}`, { token: world.owner.token, body: html, headers: { 'Content-Type': 'text/html' } });
    expect(put.status).toBe(200);
    const got = await fetch(`${server.url}/api/documents/${doc.id}/assets/${hashOf(html)}`, { headers: { Authorization: `Bearer ${world.owner.token}` } });
    expect(got.headers.get('content-type')).toBe('application/octet-stream');
    expect(got.headers.get('content-security-policy')).toContain('sandbox');
    expect(got.headers.get('x-content-type-options')).toBe('nosniff');

    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script></svg>');
    await call(server, 'PUT', `/api/documents/${doc.id}/assets/${hashOf(svg)}`, { token: world.owner.token, body: svg, headers: { 'Content-Type': 'image/svg+xml; charset=utf-8' } });
    const image = await fetch(`${server.url}/api/documents/${doc.id}/assets/${hashOf(svg)}`, { headers: { Authorization: `Bearer ${world.owner.token}` } });
    expect(image.headers.get('content-type')).toBe('image/svg+xml');
    // Opened on its own, an SVG's scripts do not run: the policy has no scripts and a sandbox.
    expect(image.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");

    const js = new TextEncoder().encode('alert(1)');
    const resource = world.resource;
    const script = await call(server, 'PUT', `/api/community/resources/${resource}/assets/${hashOf(js)}`, { token: world.owner.token, body: js, headers: { 'Content-Type': 'text/javascript' } });
    // Not used by the resource's version: refused before its type matters.
    expect(script.status).toBe(400);
  });

  it('refuses a cover whose bytes are not the picture its type says', async () => {
    const html = new TextEncoder().encode('<!doctype html><script>alert(1)</script>');
    const answer = await call(server, 'PUT', `/api/community/resources/${world.resource}/cover`, { token: world.owner.token, body: html, headers: { 'Content-Type': 'image/png' } });
    expect(answer.status).toBe(400);
    const cover = await fetch(`${server.url}/api/community/resources/${world.resource}/cover`);
    expect(cover.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await cover.arrayBuffer())).toEqual(PNG);
  });
});

/** A request with the path exactly as written (fetch would tidy `..` away). */
function rawGet(url: string, path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  const { hostname, port } = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({ hostname, port, path, method: 'GET', headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('security headers and static files', () => {
  let site: TestServer;
  let dist: string;
  beforeAll(async () => {
    dist = tempDir();
    mkdirSync(join(dist, 'assets'), { recursive: true });
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Evora</title>');
    writeFileSync(join(dist, 'assets', 'app.js'), 'console.log(1)');
    // Something beside the built app that must never be served.
    writeFileSync(join(dist, '..', `secret-${process.pid}.txt`), 'SECRET');
    site = await testServer({ serveDir: dist });
  });
  afterAll(async () => {
    await site?.stop();
    rmSync(join(dist, '..', `secret-${process.pid}.txt`), { force: true });
    rmSync(dist, { recursive: true, force: true });
  });

  it('gives the API its headers on every answer, errors included', async () => {
    for (const answer of [await fetch(`${site.url}/api/auth/providers`), await fetch(`${site.url}/api/nothing-here`), await fetch(`${site.url}/api/me`)]) {
      expect(answer.headers.get('x-content-type-options')).toBe('nosniff');
      expect(answer.headers.get('referrer-policy')).toBe('no-referrer');
      expect(answer.headers.get('x-frame-options')).toBe('DENY');
      expect(answer.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
      expect(answer.headers.get('strict-transport-security')).toBeNull();
    }
    // Behind a proxy that says the request came over HTTPS: HSTS.
    const https = await rawGet(site.url, '/api/auth/providers', { 'X-Forwarded-Proto': 'https' });
    expect(https.headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
  });

  it('serves the app with a policy that keeps it to its own site and out of other sites’ frames', async () => {
    const page = await fetch(`${site.url}/`);
    const csp = page.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toMatch(/connect-src 'self' ws:\/\/127\.0\.0\.1:\d+ wss:\/\/127\.0\.0\.1:\d+/);
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).toMatch(/frame-src 'self' blob: data:/);
    expect(page.headers.get('x-frame-options')).toBe('DENY');
    expect(page.headers.get('referrer-policy')).toBe('no-referrer');
    expect(page.headers.get('x-content-type-options')).toBe('nosniff');
    // A Host that is not a host name is not written into the policy.
    const odd = await rawGet(site.url, '/', { Host: 'evil.example"; script-src *' });
    expect(String(odd.headers['content-security-policy'])).not.toContain('evil');
  });

  it('never serves a file outside the app’s folder, however the path is written', async () => {
    for (const path of [
      `/../secret-${process.pid}.txt`,
      `/..%2fsecret-${process.pid}.txt`,
      `/%2e%2e/secret-${process.pid}.txt`,
      `/%2e%2e%2fsecret-${process.pid}.txt`,
      `/..%5csecret-${process.pid}.txt`,
      `/assets/..%2f..%2fsecret-${process.pid}.txt`,
      `/%00../secret-${process.pid}.txt`,
    ]) {
      const answer = await rawGet(site.url, path);
      expect(answer.body, path).not.toContain('SECRET');
    }
    expect((await rawGet(site.url, '/assets/app.js')).body).toBe('console.log(1)');
  });
});

/** Opens a WebSocket by hand, so that frames can be sent as no browser would. */
async function rawSocket(url: string): Promise<{ socket: Socket; closed: Promise<number | null> }> {
  const { hostname, port } = new URL(url);
  const socket = connect(Number(port), hostname);
  await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
  socket.write(['GET /ws HTTP/1.1', `Host: ${hostname}:${port}`, 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`, 'Sec-WebSocket-Version: 13', '', ''].join('\r\n'));
  let buffer = Buffer.alloc(0);
  let upgraded = false;
  const closed = new Promise<number | null>((resolve) => {
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) return;
        upgraded = true;
        buffer = buffer.subarray(end + 4);
      }
      // Look for the server's close frame (never masked): opcode 8, then its code.
      for (let at = 0; at + 2 <= buffer.length; ) {
        const opcode = (buffer[at] as number) & 0x0f;
        let length = (buffer[at + 1] as number) & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (at + 4 > buffer.length) return;
          length = buffer.readUInt16BE(at + 2);
          offset = 4;
        } else if (length === 127) {
          if (at + 10 > buffer.length) return;
          length = Number(buffer.readBigUInt64BE(at + 2));
          offset = 10;
        }
        if (at + offset + length > buffer.length) return;
        if (opcode === 8) {
          resolve(length >= 2 ? buffer.readUInt16BE(at + offset) : null);
          return;
        }
        at += offset + length;
      }
    });
    socket.on('close', () => resolve(null));
    socket.on('error', () => resolve(null));
  });
  return { socket, closed };
}

function maskedFrame(opcode: number, payload: Buffer, fin = true): Buffer {
  const key = randomBytes(4);
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = (payload[i] as number) ^ (key[i & 3] as number);
  let header: Buffer;
  if (payload.length < 126) header = Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | payload.length]);
  else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = (fin ? 0x80 : 0) | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = (fin ? 0x80 : 0) | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, key, masked]);
}

describe('the live connection', () => {
  it('takes only small messages before hello: nobody unknown can make the server hold megabytes', async () => {
    const { socket, closed } = await rawSocket(server.url);
    socket.write(maskedFrame(0x1, Buffer.alloc(200 * 1024, 0x20)));
    expect(await closed).toBe(1009);
    socket.destroy();
  });

  it('closes a connection that sends one message in endless empty pieces', async () => {
    const { socket, closed } = await rawSocket(server.url);
    const pieces = [maskedFrame(0x1, Buffer.from('{'), false)];
    for (let i = 0; i < 1100; i++) pieces.push(maskedFrame(0x0, Buffer.alloc(0), false));
    socket.write(Buffer.concat(pieces));
    expect(await closed).toBe(1009);
    socket.destroy();
  });

  it('closes a connection that floods it with messages (1008)', async () => {
    const flood = await TestSocket.open(server);
    for (let i = 0; i < MAX_MESSAGES_PER_WINDOW + 100; i++) flood.send({ t: 'ping' });
    expect((await flood.closed).code).toBe(1008);
    // Others are not affected.
    const other = await TestSocket.open(server);
    await other.settle();
    await other.close();
  });

  it('accepts a large message once the connection has said who it is', async () => {
    const { socket } = await TestSocket.join(server, world.doc, { token: world.owner.token }, 'bigsender');
    socket.send({ t: 'ops', id: 'big', ops: [{ k: 'n:page1:note', v: 'x'.repeat(300 * 1024), c: clock(Date.now(), 'bigsender') }] });
    expect((await socket.next('ack')).id).toBe('big');
    await socket.close();
  });

  it('keeps presence small: layer IDs longer than any real one are left out', () => {
    const presence = cleanPresence({ pageId: 'p', cursor: null, selection: ['ok', 'x'.repeat(10_000)], viewport: null });
    expect(presence?.selection).toEqual(['ok']);
  });
});

describe('signing in with Google', () => {
  it('sends people back only to the app’s own address or this computer', () => {
    expect(allowedOrigin('https://evil.example', null)).toBeNull();
    expect(allowedOrigin('https://evil.example', 'https://evora.example.com')).toBeNull();
    expect(allowedOrigin('http://localhost.evil.example', null)).toBeNull();
    expect(allowedOrigin('http://127.0.0.1.evil.example', null)).toBeNull();
    expect(allowedOrigin('javascript:alert(1)', null)).toBeNull();
    expect(allowedOrigin('http://localhost:5173/path?x=1', null)).toBeNull();
    expect(allowedOrigin('http://user@localhost:5173', null)).toBeNull();
    expect(allowedOrigin('https://evora.example.com', 'https://evora.example.com')).toBe('https://evora.example.com');
    expect(allowedOrigin('http://localhost:5173', null)).toBe('http://localhost:5173');
  });

  describe('linking an account made by someone else', () => {
    let fake: Server;
    let fakeUrl = '';
    let profile = { sub: 'g-1', email: '', email_verified: true, name: 'Victim' };
    let googleServer: TestServer;
    beforeAll(async () => {
      fake = createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(req.url?.startsWith('/token') ? { access_token: 'fake-access' } : profile));
      });
      await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', () => resolve()));
      const address = fake.address();
      fakeUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
      googleServer = await testServer({
        google: { clientId: 'client', clientSecret: 'secret', endpoints: { authorization: `${fakeUrl}/auth`, token: `${fakeUrl}/token`, userinfo: `${fakeUrl}/userinfo` } },
      });
    });
    afterAll(async () => {
      await googleServer?.stop();
      await new Promise<void>((resolve) => fake.close(() => resolve()));
    });

    it('ends every session the account had before Google proved who owns its email', async () => {
      // Someone makes an account with an address that is not theirs, and stays signed in.
      const victimEmail = `victim.${Date.now()}@example.com`;
      const squatter = await signUp(googleServer, 'Squatter', victimEmail);
      const doc = await newDoc(googleServer, squatter.token, 'Planted');
      const { socket } = await TestSocket.join(googleServer, doc.id, { token: squatter.token }, 'squatter');
      expect((await call(googleServer, 'GET', '/api/me', { token: squatter.token })).status).toBe(200);
      // The address's owner then continues with Google.
      profile = { sub: `g-${Date.now()}`, email: victimEmail, email_verified: true, name: 'Victim' };
      const start = await fetch(`${googleServer.url}/api/auth/google/start?origin=${encodeURIComponent(googleServer.url)}&mode=login`, { redirect: 'manual' });
      const consent = new URL(start.headers.get('location') as string);
      const cookie = (start.headers.get('set-cookie') as string).split(';')[0] as string;
      const back = await fetch(`${googleServer.url}/api/auth/google/callback?state=${consent.searchParams.get('state')}&code=abc`, { redirect: 'manual', headers: { Cookie: cookie } });
      const ticket = new URLSearchParams((back.headers.get('location') as string).split('?')[1]).get('ticket');
      expect(ticket).toBeTruthy();
      const redeemed = await call(googleServer, 'POST', '/api/auth/google/redeem', { body: { ticket } });
      expect(redeemed.status).toBe(200);
      expect(redeemed.body.user.id).toBe(squatter.user.id);
      // The squatter's session is over, and so is their live connection.
      expect((await call(googleServer, 'GET', '/api/me', { token: squatter.token })).status).toBe(401);
      expect((await socket.closed).code).toBe(4401);
      expect((await call(googleServer, 'GET', '/api/me', { token: redeemed.body.token })).status).toBe(200);
    });
  });
});
