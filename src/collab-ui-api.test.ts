import { describe, expect, it } from 'vitest';
import { ApiError, createApi, documentLink, inviteLink } from './collab/api';
import type { Auth } from './collab/account';

/**
 * The collaboration server's HTTP client, against a fake fetch that records
 * each request and answers as the server would: the address and method of
 * every kind of request, the credentials it carries, the JSON it sends and
 * reads, raw image bytes, and the server's own error messages.
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

const thread = { id: 't1', docId: 'd1', pageId: 'p1', x: 1, y: 2, nodeId: null, resolved: false, createdAt: '2026-01-01T00:00:00.000Z', comments: [] };

describe('the collaboration API client', () => {
  it('sends the account session as a bearer token, and nothing for a guest when signed in', async () => {
    const server = fakeServer(() => json({ user: { id: 'u1' }, workspaces: [] }));
    const api = createApi({ fetch: server.fetch, auth: (): Auth => ({ token: 'session-1', guestToken: null }) });
    await api.me();
    expect(server.sent[0]?.url).toBe('/api/me');
    expect(server.sent[0]?.method).toBe('GET');
    expect(server.sent[0]?.headers.Authorization).toBe('Bearer session-1');
    expect(server.sent[0]?.headers['X-Evora-Guest']).toBeUndefined();
  });

  it('sends a guest token in its own header when there is no account', async () => {
    const server = fakeServer(() => json([]));
    const api = createApi({ fetch: server.fetch, auth: () => ({ token: null, guestToken: 'guest-7' }) });
    await api.listThreads('d1');
    expect(server.sent[0]?.headers['X-Evora-Guest']).toBe('guest-7');
    expect(server.sent[0]?.headers.Authorization).toBeUndefined();
  });

  it('asks for the credentials afresh on every request, so signing in takes effect at once', async () => {
    const server = fakeServer(() => json([]));
    let auth: Auth = { token: null, guestToken: null };
    const api = createApi({ fetch: server.fetch, auth: () => auth });
    await api.listWorkspaces();
    auth = { token: 'later', guestToken: null };
    await api.listWorkspaces();
    expect(server.sent[0]?.headers.Authorization).toBeUndefined();
    expect(server.sent[1]?.headers.Authorization).toBe('Bearer later');
  });

  it('sends JSON bodies with their content type and reads JSON answers', async () => {
    const server = fakeServer((request) => json({ token: 'tok', user: { id: 'u1', email: 'a@b.c', name: JSON.parse(String(request.body)).name, color: '#000000', createdAt: '' } }, 201));
    const api = createApi({ fetch: server.fetch, auth: () => ({ token: null, guestToken: null }) });
    const result = await api.signup('a@b.c', 'Ana', 'secret');
    expect(server.sent[0]?.method).toBe('POST');
    expect(server.sent[0]?.url).toBe('/api/auth/signup');
    expect(server.sent[0]?.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(String(server.sent[0]?.body))).toEqual({ email: 'a@b.c', name: 'Ana', password: 'secret' });
    expect(result.user.name).toBe('Ana');
    expect(result.token).toBe('tok');
  });

  it('puts every endpoint of the protocol at its address with its method', async () => {
    const server = fakeServer(() => json({}));
    const api = createApi({ fetch: server.fetch, auth: () => ({ token: 't', guestToken: null }) });
    const calls: [() => Promise<unknown>, string, string][] = [
      [() => api.login('e', 'p'), 'POST', '/api/auth/login'],
      [() => api.logout(), 'POST', '/api/auth/logout'],
      [() => api.createGuest('Gus'), 'POST', '/api/guests'],
      [() => api.updateMe({ name: 'N' }), 'PATCH', '/api/me'],
      [() => api.createWorkspace('W'), 'POST', '/api/workspaces'],
      [() => api.renameWorkspace('w1', 'W2'), 'PATCH', '/api/workspaces/w1'],
      [() => api.deleteWorkspace('w1'), 'DELETE', '/api/workspaces/w1'],
      [() => api.workspaceMembers('w1'), 'GET', '/api/workspaces/w1/members'],
      [() => api.addWorkspaceMember('w1', 'x@y.z', 'editor'), 'POST', '/api/workspaces/w1/members'],
      [() => api.setWorkspaceMemberRole('w1', 'u2', 'viewer'), 'PATCH', '/api/workspaces/w1/members/u2'],
      [() => api.removeWorkspaceMember('w1', 'u2'), 'DELETE', '/api/workspaces/w1/members/u2'],
      [() => api.createInviteLink('w1', 'editor'), 'POST', '/api/workspaces/w1/invites'],
      [() => api.getInvite('tok'), 'GET', '/api/invites/tok'],
      [() => api.acceptInvite('tok'), 'POST', '/api/invites/tok/accept'],
      [() => api.workspaceDocuments('w1'), 'GET', '/api/workspaces/w1/documents'],
      [() => api.sharedDocuments(), 'GET', '/api/shared'],
      [() => api.createDocument('w1', 'File'), 'POST', '/api/documents'],
      [() => api.getDocument('d1'), 'GET', '/api/documents/d1'],
      [() => api.updateDocument('d1', { linkAccess: 'view' }), 'PATCH', '/api/documents/d1'],
      [() => api.deleteDocument('d1'), 'DELETE', '/api/documents/d1'],
      [() => api.documentMembers('d1'), 'GET', '/api/documents/d1/members'],
      [() => api.addDocumentMember('d1', 'x@y.z', 'viewer'), 'POST', '/api/documents/d1/members'],
      [() => api.setDocumentMemberRole('d1', 'u2', 'editor'), 'PATCH', '/api/documents/d1/members/u2'],
      [() => api.removeDocumentMember('d1', 'u2'), 'DELETE', '/api/documents/d1/members/u2'],
      [() => api.documentRegisters('d1'), 'GET', '/api/documents/d1/registers'],
      [() => api.createThread('d1', { pageId: 'p', x: 1, y: 2, nodeId: null }, 'Hi'), 'POST', '/api/documents/d1/threads'],
      [() => api.reply('t1', 'Yes'), 'POST', '/api/threads/t1/comments'],
      [() => api.updateThread('t1', { resolved: true }), 'PATCH', '/api/threads/t1'],
      [() => api.deleteThread('t1'), 'DELETE', '/api/threads/t1'],
      [() => api.editComment('c1', 'Edited'), 'PATCH', '/api/comments/c1'],
      [() => api.deleteComment('c1'), 'DELETE', '/api/comments/c1'],
      [() => api.notifications(), 'GET', '/api/notifications'],
      [() => api.markNotificationsRead(['n1']), 'POST', '/api/notifications/read'],
      [() => api.health(), 'GET', '/api/health'],
    ];
    for (const [call, method, url] of calls) {
      await call();
      const last = server.sent[server.sent.length - 1];
      expect(`${last?.method} ${last?.url}`).toBe(`${method} ${url}`);
    }
  });

  it('sends what each change says, and leaves out registers a new document does not have', async () => {
    const server = fakeServer(() => json({}));
    const api = createApi({ fetch: server.fetch, auth: () => ({ token: 't', guestToken: null }) });
    await api.createDocument('w1', 'Empty');
    await api.createDocument('w1', 'From this device', [{ k: 'd:name', v: 'From this device', c: '000000001.0000.abc' }]);
    await api.createThread('d1', { pageId: 'p1', x: 10, y: 20, nodeId: 'n1' }, 'Look @[Ana](u1)');
    await api.markNotificationsRead(['n1', 'n2']);
    const bodies = server.sent.map((request) => JSON.parse(String(request.body)));
    expect(bodies[0]).toEqual({ workspaceId: 'w1', name: 'Empty' });
    expect(bodies[1].registers).toEqual([{ k: 'd:name', v: 'From this device', c: '000000001.0000.abc' }]);
    expect(bodies[2]).toEqual({ pageId: 'p1', x: 10, y: 20, nodeId: 'n1', body: 'Look @[Ana](u1)' });
    expect(bodies[3]).toEqual({ ids: ['n1', 'n2'] });
  });

  it('keeps IDs from changing the address they are part of', async () => {
    const server = fakeServer(() => json({}));
    const api = createApi({ fetch: server.fetch, auth: () => ({ token: 't', guestToken: null }) });
    await api.getDocument('a/b?c');
    expect(server.sent[0]?.url).toBe('/api/documents/a%2Fb%3Fc');
  });

  it("throws the server's own message, with the status", async () => {
    const server = fakeServer(() => json({ error: 'Only owners can do that.' }, 403));
    const api = createApi({ fetch: server.fetch, auth: () => ({ token: 't', guestToken: null }) });
    const failure = await api.deleteDocument('d1').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).message).toBe('Only owners can do that.');
    expect((failure as ApiError).status).toBe(403);
  });

  it('says what it can when the error has no message, and when the server cannot be reached', async () => {
    const plain = createApi({ fetch: async () => new Response('Bad gateway', { status: 502 }), auth: () => ({ token: null, guestToken: null }) });
    const failure = (await plain.health().catch((error: unknown) => error)) as ApiError;
    expect(failure.status).toBe(502);
    expect(failure.message).toContain('502');

    const unreachable = createApi({
      fetch: async () => {
        throw new TypeError('Failed to fetch');
      },
      auth: () => ({ token: null, guestToken: null }),
    });
    const offline = (await unreachable.health().catch((error: unknown) => error)) as ApiError;
    expect(offline).toBeInstanceOf(ApiError);
    expect(offline.status).toBe(0);
    expect(offline.message).toContain('could not be reached');
  });

  it('tells a deleted last comment (the thread is gone) from one that leaves a thread', async () => {
    let answer: unknown = thread;
    const api = createApi({ fetch: async () => json(answer), auth: () => ({ token: 't', guestToken: null }) });
    expect(await api.deleteComment('c1')).toEqual(thread);
    answer = {};
    expect(await api.deleteComment('c2')).toBeNull();
  });

  it('uploads image bytes as they are, with their type, and reads them back', async () => {
    const bytes = new Uint8Array([137, 80, 78, 71]);
    const server = fakeServer((request) => (request.method === 'PUT' ? json({}) : new Response(bytes, { status: 200, headers: { 'Content-Type': 'image/png' } })));
    const api = createApi({ fetch: server.fetch, auth: () => ({ token: 't', guestToken: null }) });
    await api.putAsset('d1', 'abc123', bytes, 'image/png');
    expect(server.sent[0]?.url).toBe('/api/documents/d1/assets/abc123');
    expect(server.sent[0]?.headers['Content-Type']).toBe('image/png');
    expect(server.sent[0]?.body).toBe(bytes);
    const asset = await api.getAsset('d1', 'abc123');
    expect(asset.mimeType).toBe('image/png');
    expect([...new Uint8Array(asset.bytes)]).toEqual([137, 80, 78, 71]);
  });

  it('can be pointed at another server', async () => {
    const server = fakeServer(() => json({ ok: true, version: '1' }));
    const api = createApi({ fetch: server.fetch, base: 'http://localhost:8797/api', auth: () => ({ token: null, guestToken: null }) });
    expect(await api.health()).toEqual({ ok: true, version: '1' });
    expect(server.sent[0]?.url).toBe('http://localhost:8797/api/health');
  });

  it('makes the links that are copied and sent', () => {
    expect(documentLink('d1', 'https://evora.example/')).toBe('https://evora.example/#/doc/d1');
    expect(inviteLink('tok', 'https://evora.example/')).toBe('https://evora.example/#/invite/tok');
  });
});
