import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SOCKET_CLOSE, type Register, type StoredRegister } from '../src/collab/protocol.ts';
import { call, clock, newDoc, signUp, testServer, TestSocket, type TestServer } from './testing.ts';
import { CLOSE_FORBIDDEN, CLOSE_NOT_FOUND, CLOSE_REPLACED, CLOSE_UNAUTHORIZED } from './hub.ts';

let server: TestServer;

beforeAll(async () => {
  server = await testServer();
});

afterAll(async () => {
  await server.stop();
});

/** An owner, an editor and a viewer of a new document. */
async function team(name: string) {
  const owner = await signUp(server, `${name}Owner`);
  const editor = await signUp(server, `${name}Editor`);
  const viewer = await signUp(server, `${name}Viewer`);
  const doc = await newDoc(server, owner.token, `${name} file`);
  await call(server, 'POST', `/api/documents/${doc.id}/members`, { token: owner.token, body: { email: editor.user.email, role: 'editor' } });
  await call(server, 'POST', `/api/documents/${doc.id}/members`, { token: owner.token, body: { email: viewer.user.email, role: 'viewer' } });
  return { owner, editor, viewer, doc };
}

function valueOf(registers: StoredRegister[], key: string): unknown {
  return registers.find((r) => r.k === key)?.v;
}

describe('the live connection', () => {
  it('welcomes with the whole document, who you are and who else is here', async () => {
    const { owner, editor, doc } = await team('Welcome');
    const a = await TestSocket.join(server, doc.id, { token: owner.token }, 'ownerclient');
    expect(a.welcome.full).toBe(true);
    expect(a.welcome.seq).toBe(1);
    expect(a.welcome.registers).toEqual([{ k: 'd:name', v: 'Welcome file', c: expect.any(String), s: 1 }]);
    expect(a.welcome.you).toEqual({ clientId: 'ownerclient', user: { id: owner.user.id, name: owner.user.name, color: owner.user.color }, role: 'owner', presence: null });
    expect(a.welcome.peers).toEqual([]);
    expect(a.welcome.doc).toMatchObject({ id: doc.id, role: 'owner' });

    const b = await TestSocket.join(server, doc.id, { token: editor.token }, 'editorclient');
    expect(b.welcome.peers).toEqual([expect.objectContaining({ clientId: 'ownerclient', role: 'owner' })]);
    // Whoever was there is told of the newcomer.
    const joined = await a.socket.next('presence');
    expect(joined.peer).toMatchObject({ clientId: 'editorclient', role: 'editor', user: { id: editor.user.id } });
    await a.socket.close();
    await b.socket.close();
  });

  it('merges two people’s changes, acknowledges them and passes them on', async () => {
    const { owner, editor, doc } = await team('Merge');
    const a = await TestSocket.join(server, doc.id, { token: owner.token }, 'clienta');
    const b = await TestSocket.join(server, doc.id, { token: editor.token }, 'clientb');
    await a.socket.next('presence');
    const t = Date.now();

    a.socket.send({ t: 'ops', id: 'a1', ops: [{ k: 'n:rect:@', v: true, c: clock(t, 'clienta') }, { k: 'n:rect:x', v: 10, c: clock(t, 'clienta', 1) }] });
    const ackA = await a.socket.next('ack');
    expect(ackA).toEqual({ t: 'ack', id: 'a1', seq: 3 });
    const toB = await b.socket.next('ops');
    expect(toB.from).toBe('clienta');
    expect(toB.seq).toBe(3);
    expect(toB.ops.map((r) => [r.k, r.v, r.s])).toEqual([
      ['n:rect:@', true, 2],
      ['n:rect:x', 10, 3],
    ]);

    b.socket.send({ t: 'ops', id: 'b1', ops: [{ k: 'n:rect:y', v: 20, c: clock(t + 1, 'clientb') }] });
    expect(await b.socket.next('ack')).toEqual({ t: 'ack', id: 'b1', seq: 4 });
    expect((await a.socket.next('ops')).ops).toEqual([{ k: 'n:rect:y', v: 20, c: clock(t + 1, 'clientb'), s: 4 }]);
    // The sender is not sent its own changes back.
    await a.socket.settle();
    await b.socket.settle();
    expect(b.socket.held('ops')).toEqual([]);
    expect(a.socket.held('ops')).toEqual([]);

    const content = await call(server, 'GET', `/api/documents/${doc.id}/registers`, { token: owner.token });
    expect(content.body.seq).toBe(4);
    expect(valueOf(content.body.registers, 'n:rect:x')).toBe(10);
    expect(valueOf(content.body.registers, 'n:rect:y')).toBe(20);
    await a.socket.close();
    await b.socket.close();
  });

  it('keeps the later clock whatever order the changes arrive in', async () => {
    const t = Date.now();
    const early: Register = { k: 'n:shape:fill', v: 'red', c: clock(t, 'clientearly') };
    const late: Register = { k: 'n:shape:fill', v: 'blue', c: clock(t + 50, 'clientlate') };

    for (const order of [
      [late, early],
      [early, late],
    ]) {
      const { owner, editor, doc } = await team('Order');
      const a = await TestSocket.join(server, doc.id, { token: owner.token }, 'clientearly');
      const b = await TestSocket.join(server, doc.id, { token: editor.token }, 'clientlate');
      const [first, second] = order as [Register, Register];
      const firstSocket = first === early ? a.socket : b.socket;
      const secondSocket = first === early ? b.socket : a.socket;
      firstSocket.send({ t: 'ops', id: 'one', ops: [first] });
      await firstSocket.next('ack');
      secondSocket.send({ t: 'ops', id: 'two', ops: [second] });
      await secondSocket.next('ack');

      const content = await call(server, 'GET', `/api/documents/${doc.id}/registers`, { token: owner.token });
      expect(valueOf(content.body.registers, 'n:shape:fill')).toBe('blue');
      // When the early change came second it lost, and nobody was sent it.
      await a.socket.settle();
      await b.socket.settle();
      const passedOn = [...a.socket.held('ops'), ...b.socket.held('ops')] as { ops: StoredRegister[] }[];
      expect(passedOn.flatMap((m) => m.ops).some((r) => r.v === 'red')).toBe(first === early);
      await a.socket.close();
      await b.socket.close();
    }
  });

  it('breaks a tie of the same moment by the client ID, the same way everywhere', async () => {
    const { owner, doc } = await team('Tie');
    const a = await TestSocket.join(server, doc.id, { token: owner.token }, 'clienttie');
    const t = Date.now();
    a.socket.send({ t: 'ops', id: 'x', ops: [{ k: 'n:n:v', v: 'from z', c: clock(t, 'zzzzzzzzzz') }] });
    await a.socket.next('ack');
    a.socket.send({ t: 'ops', id: 'y', ops: [{ k: 'n:n:v', v: 'from a', c: clock(t, 'aaaaaaaaaa') }] });
    await a.socket.next('ack');
    const content = await call(server, 'GET', `/api/documents/${doc.id}/registers`, { token: owner.token });
    expect(valueOf(content.body.registers, 'n:n:v')).toBe('from z');
    await a.socket.close();
  });

  it('sends a returning client only what changed since the sequence number it holds', async () => {
    const { owner, editor, doc } = await team('Return');
    const a = await TestSocket.join(server, doc.id, { token: owner.token }, 'clientstay');
    const t = Date.now();
    a.socket.send({ t: 'ops', id: '1', ops: [{ k: 'n:p:x', v: 1, c: clock(t, 'clientstay') }] });
    const held = (await a.socket.next('ack')).seq;

    // Someone else edits while this client is away.
    await a.socket.close();
    const b = await TestSocket.join(server, doc.id, { token: editor.token }, 'clientother');
    b.socket.send({ t: 'ops', id: '2', ops: [{ k: 'n:p:y', v: 2, c: clock(t + 1, 'clientother') }, { k: 'n:p:x', v: 3, c: clock(t + 2, 'clientother') }] });
    await b.socket.next('ack');

    const back = await TestSocket.join(server, doc.id, { token: owner.token }, 'clientstay', held);
    expect(back.welcome.full).toBe(false);
    expect(back.welcome.registers.map((r) => [r.k, r.v])).toEqual([
      ['n:p:y', 2],
      ['n:p:x', 3],
    ]);
    expect(back.welcome.seq).toBe(held + 2);

    // Up to date: nothing to send. A number the document never reached: everything.
    const current = await TestSocket.join(server, doc.id, { token: owner.token }, 'clientthree', back.welcome.seq);
    expect(current.welcome).toMatchObject({ full: false, registers: [] });
    const strange = await TestSocket.join(server, doc.id, { token: owner.token }, 'clientfour', 9999);
    expect(strange.welcome.full).toBe(true);
    expect(strange.welcome.registers).toHaveLength(back.welcome.seq - 1);
    for (const s of [b.socket, back.socket, current.socket, strange.socket]) await s.close();
  });

  it('merges changes made offline when they are sent on reconnecting', async () => {
    const { owner, editor, doc } = await team('Offline');
    const t = Date.now();
    // Both edit the same layer; the owner's edit is later but sent after the editor's.
    const online = await TestSocket.join(server, doc.id, { token: editor.token }, 'clientonline');
    online.socket.send({ t: 'ops', id: 'on', ops: [{ k: 'n:card:name', v: 'Online name', c: clock(t, 'clientonline') }, { k: 'n:card:w', v: 100, c: clock(t + 20, 'clientonline') }] });
    await online.socket.next('ack');

    const offline = await TestSocket.join(server, doc.id, { token: owner.token }, 'clientoffline', 1);
    offline.socket.send({ t: 'ops', id: 'off', ops: [{ k: 'n:card:name', v: 'Offline name', c: clock(t + 10, 'clientoffline') }, { k: 'n:card:w', v: 50, c: clock(t + 5, 'clientoffline') }] });
    await offline.socket.next('ack');
    const passed = await online.socket.next('ops');
    // Only the change that won is passed on.
    expect(passed.ops.map((r) => [r.k, r.v])).toEqual([['n:card:name', 'Offline name']]);
    const content = await call(server, 'GET', `/api/documents/${doc.id}/registers`, { token: owner.token });
    expect(valueOf(content.body.registers, 'n:card:name')).toBe('Offline name');
    expect(valueOf(content.body.registers, 'n:card:w')).toBe(100);
    await online.socket.close();
    await offline.socket.close();
  });

  it('refuses changes from viewers, and changes that are not valid', async () => {
    const { owner, viewer, doc } = await team('Refuse');
    const v = await TestSocket.join(server, doc.id, { token: viewer.token }, 'clientviewer');
    expect(v.welcome.you.role).toBe('viewer');
    v.socket.send({ t: 'ops', id: 'v1', ops: [{ k: 'n:a:x', v: 1, c: clock(Date.now(), 'clientviewer') }] });
    expect(await v.socket.next('rejected')).toMatchObject({ t: 'rejected', id: 'v1' });

    const o = await TestSocket.join(server, doc.id, { token: owner.token }, 'clientowner');
    o.socket.send({ t: 'ops', id: 'bad1', ops: [{ k: 'n:a:x', v: 1, c: 'not a clock' }] });
    expect((await o.socket.next('rejected')).id).toBe('bad1');
    o.socket.send({ t: 'ops', id: 'bad2', ops: [{ k: 'n:a:x', c: clock(Date.now(), 'clientowner') }] });
    expect((await o.socket.next('rejected')).id).toBe('bad2');
    // A clock days ahead would win over every later change: refused.
    o.socket.send({ t: 'ops', id: 'bad3', ops: [{ k: 'n:a:x', v: 1, c: clock(Date.now() + 3 * 24 * 3600 * 1000, 'clientowner') }] });
    expect((await o.socket.next('rejected')).reason).toMatch(/future/);
    const content = await call(server, 'GET', `/api/documents/${doc.id}/registers`, { token: owner.token });
    expect(content.body.seq).toBe(1);
    await v.socket.close();
    await o.socket.close();
  });

  it('passes presence on without keeping it, and says when someone leaves', async () => {
    const { owner, viewer, doc } = await team('Presence');
    const a = await TestSocket.join(server, doc.id, { token: owner.token }, 'clientpa');
    const b = await TestSocket.join(server, doc.id, { token: viewer.token }, 'clientpb');
    await a.socket.next('presence');

    const presence = { pageId: 'page1', cursor: { x: 12.5, y: -4 }, selection: ['rect'], viewport: { x: 0, y: 0, zoom: 1, width: 800, height: 600 } };
    b.socket.send({ t: 'presence', presence });
    const seen = await a.socket.next('presence');
    expect(seen.peer).toEqual({ clientId: 'clientpb', user: expect.objectContaining({ id: viewer.user.id }), role: 'viewer', presence });

    // A newcomer gets the presence of those already there.
    const c = await TestSocket.join(server, doc.id, { token: owner.token }, 'clientpc');
    expect(c.welcome.peers.find((p) => p.clientId === 'clientpb')?.presence).toEqual(presence);

    b.socket.send({ t: 'presence', presence: { pageId: 5 } });
    expect((await b.socket.next('error')).code).toBe('bad-request');

    await b.socket.close();
    expect(await a.socket.next('leave')).toEqual({ t: 'leave', clientId: 'clientpb' });
    expect(await c.socket.next('leave', (m) => m.clientId === 'clientpb')).toBeTruthy();
    await a.socket.close();
    await c.socket.close();
  });

  it('lets a guest in only through the link, to view or to edit as the link says', async () => {
    const owner = await signUp(server, 'LinkOwner');
    const doc = await newDoc(server, owner.token, 'Link file');
    const guest = (await call(server, 'POST', '/api/guests', { body: { name: 'Guest' } })).body;

    const refused = await TestSocket.open(server);
    refused.send({ t: 'hello', docId: doc.id, since: 0, clientId: 'guestclient', guestToken: guest.guestToken });
    expect((await refused.next('error')).code).toBe('forbidden');
    expect((await refused.closed).code).toBe(CLOSE_FORBIDDEN);

    await call(server, 'PATCH', `/api/documents/${doc.id}`, { token: owner.token, body: { linkAccess: 'view' } });
    const g = await TestSocket.join(server, doc.id, { guestToken: guest.guestToken }, 'guestclient');
    expect(g.welcome.you).toMatchObject({ role: 'viewer', user: { id: guest.guest.id, name: 'Guest', guest: true } });
    g.socket.send({ t: 'ops', id: 'g1', ops: [{ k: 'n:a:x', v: 1, c: clock(Date.now(), 'guestclient') }] });
    expect((await g.socket.next('rejected')).id).toBe('g1');

    // The link is changed to edit: the guest is told, and may now edit.
    await call(server, 'PATCH', `/api/documents/${doc.id}`, { token: owner.token, body: { linkAccess: 'edit' } });
    expect(await g.socket.next('access')).toEqual({ t: 'access', role: 'editor', linkAccess: 'edit' });
    g.socket.send({ t: 'ops', id: 'g2', ops: [{ k: 'n:a:x', v: 1, c: clock(Date.now(), 'guestclient') }] });
    expect((await g.socket.next('ack')).id).toBe('g2');

    // The link is closed: the guest is told and disconnected.
    await call(server, 'PATCH', `/api/documents/${doc.id}`, { token: owner.token, body: { linkAccess: 'none' } });
    expect(await g.socket.next('access')).toEqual({ t: 'access', role: null, linkAccess: 'none' });
    expect((await g.socket.closed).code).toBe(CLOSE_FORBIDDEN);
  });

  it('tells a member when their role changes, and disconnects them when it is removed', async () => {
    const { owner, editor, doc } = await team('Access');
    const o = await TestSocket.join(server, doc.id, { token: owner.token }, 'clientao');
    const e = await TestSocket.join(server, doc.id, { token: editor.token }, 'clientae');
    await o.socket.next('presence');

    await call(server, 'PATCH', `/api/documents/${doc.id}/members/${editor.user.id}`, { token: owner.token, body: { role: 'viewer' } });
    expect(await e.socket.next('access')).toEqual({ t: 'access', role: 'viewer', linkAccess: 'none' });
    // The others see the new role.
    expect((await o.socket.next('presence')).peer).toMatchObject({ clientId: 'clientae', role: 'viewer' });
    e.socket.send({ t: 'ops', id: 'e1', ops: [{ k: 'n:a:x', v: 1, c: clock(Date.now(), 'clientae') }] });
    expect((await e.socket.next('rejected')).id).toBe('e1');

    await call(server, 'DELETE', `/api/documents/${doc.id}/members/${editor.user.id}`, { token: owner.token });
    expect(await e.socket.next('access')).toEqual({ t: 'access', role: null, linkAccess: 'none' });
    expect((await e.socket.closed).code).toBe(CLOSE_FORBIDDEN);
    expect(await o.socket.next('leave')).toEqual({ t: 'leave', clientId: 'clientae' });
    await o.socket.close();
  });

  it('follows changes made in the workspace: a member removed from it is disconnected from its documents', async () => {
    const owner = await signUp(server, 'WsOwner');
    const member = await signUp(server, 'WsMember');
    const workspaceId = (await call(server, 'GET', '/api/me', { token: owner.token })).body.workspaces[0].id as string;
    await call(server, 'POST', `/api/workspaces/${workspaceId}/members`, { token: owner.token, body: { email: member.user.email, role: 'viewer' } });
    const doc = await newDoc(server, owner.token, 'Team file');
    const m = await TestSocket.join(server, doc.id, { token: member.token }, 'clientwm');
    expect(m.welcome.you.role).toBe('viewer');

    await call(server, 'PATCH', `/api/workspaces/${workspaceId}/members/${member.user.id}`, { token: owner.token, body: { role: 'editor' } });
    expect(await m.socket.next('access')).toEqual({ t: 'access', role: 'editor', linkAccess: 'none' });
    await call(server, 'DELETE', `/api/workspaces/${workspaceId}/members/${member.user.id}`, { token: owner.token });
    expect((await m.socket.next('access')).role).toBeNull();
    expect((await m.socket.closed).code).toBe(CLOSE_FORBIDDEN);
  });

  it('shows a new name or colour to everyone connected', async () => {
    const { owner, editor, doc } = await team('Rename person');
    const o = await TestSocket.join(server, doc.id, { token: owner.token }, 'clientnameo');
    const e = await TestSocket.join(server, doc.id, { token: editor.token }, 'clientnamee');
    await o.socket.next('presence');
    await call(server, 'PATCH', '/api/me', { token: editor.token, body: { name: 'Edie', color: '#14ae5c' } });
    expect((await o.socket.next('presence')).peer).toMatchObject({ clientId: 'clientnamee', user: { id: editor.user.id, name: 'Edie', color: '#14ae5c' } });
    await o.socket.close();
    await e.socket.close();
  });

  it('disconnects everyone when the document is deleted, and a session when it signs out', async () => {
    const { owner, editor, doc } = await team('Gone');
    const e = await TestSocket.join(server, doc.id, { token: editor.token }, 'clientge');
    await call(server, 'POST', '/api/auth/logout', { token: editor.token });
    expect((await e.socket.next('error')).code).toBe('unauthorized');
    expect((await e.socket.closed).code).toBe(CLOSE_UNAUTHORIZED);

    const o = await TestSocket.join(server, doc.id, { token: owner.token }, 'clientgo');
    await call(server, 'DELETE', `/api/documents/${doc.id}`, { token: owner.token });
    expect((await o.socket.next('access')).role).toBeNull();
    expect((await o.socket.closed).code).toBe(CLOSE_FORBIDDEN);
  });

  it('renames over HTTP as a change everyone connected receives', async () => {
    const { owner, editor, doc } = await team('Rename');
    const e = await TestSocket.join(server, doc.id, { token: editor.token }, 'clientre');
    await call(server, 'PATCH', `/api/documents/${doc.id}`, { token: owner.token, body: { name: 'Renamed' } });
    const ops = await e.socket.next('ops');
    expect(ops.from).toBe('server');
    expect(ops.ops).toEqual([expect.objectContaining({ k: 'd:name', v: 'Renamed' })]);

    // A rename made as a change renames the document too.
    e.socket.send({ t: 'ops', id: 'n', ops: [{ k: 'd:name', v: 'Renamed live', c: clock(Date.now() + 1000, 'clientre') }] });
    await e.socket.next('ack');
    expect((await call(server, 'GET', `/api/documents/${doc.id}`, { token: owner.token })).body.name).toBe('Renamed live');
    await e.socket.close();
  });

  it('refuses a hello without a valid identity, for no document, or without access', async () => {
    const { doc } = await team('Hello');
    const stranger = await signUp(server, 'HelloStranger');

    const noOne = await TestSocket.open(server);
    noOne.send({ t: 'hello', docId: doc.id, since: 0, clientId: 'c1' });
    expect((await noOne.next('error')).code).toBe('unauthorized');
    expect((await noOne.closed).code).toBe(CLOSE_UNAUTHORIZED);

    const badToken = await TestSocket.open(server);
    badToken.send({ t: 'hello', docId: doc.id, since: 0, clientId: 'c2', token: 'made-up' });
    expect((await badToken.next('error')).code).toBe('unauthorized');

    const nothing = await TestSocket.open(server);
    nothing.send({ t: 'hello', docId: 'no-such-doc', since: 0, clientId: 'c3', token: stranger.token });
    expect((await nothing.next('error')).code).toBe('not-found');
    expect((await nothing.closed).code).toBe(CLOSE_NOT_FOUND);

    const outsider = await TestSocket.open(server);
    outsider.send({ t: 'hello', docId: doc.id, since: 0, clientId: 'c4', token: stranger.token });
    expect((await outsider.next('error')).code).toBe('forbidden');

    const early = await TestSocket.open(server);
    early.send({ t: 'ops', id: 'x', ops: [] });
    expect((await early.next('error')).code).toBe('bad-request');
  });

  it('answers ping with pong, and lets the same client take the place of its old connection', async () => {
    const { owner, doc } = await team('Again');
    const first = await TestSocket.join(server, doc.id, { token: owner.token }, 'sameclient');
    first.socket.send({ t: 'ping' });
    expect(await first.socket.next('pong')).toEqual({ t: 'pong' });

    const second = await TestSocket.join(server, doc.id, { token: owner.token }, 'sameclient');
    expect(second.welcome.peers).toEqual([]);
    expect((await first.socket.closed).code).toBe(CLOSE_REPLACED);
    expect(server.hub.roomSize(doc.id)).toBe(1);

    // Client IDs are seen by everyone in the room: someone else cannot use one to push its owner out.
    await call(server, 'PATCH', `/api/documents/${doc.id}`, { token: owner.token, body: { linkAccess: 'view' } });
    const guest = (await call(server, 'POST', '/api/guests', { body: { name: 'Pretender' } })).body;
    const pretender = await TestSocket.open(server);
    pretender.send({ t: 'hello', docId: doc.id, since: 0, clientId: 'sameclient', guestToken: guest.guestToken });
    expect((await pretender.next('error')).code).toBe('bad-request');
    expect((await pretender.closed).code).toBe(SOCKET_CLOSE.badRequest);
    await second.socket.settle();
    expect(server.hub.roomSize(doc.id)).toBe(1);
    await second.socket.close();
  });

  it('has no limit on how many people are in a document', async () => {
    const owner = await signUp(server, 'Many');
    const doc = await newDoc(server, owner.token, 'Busy file');
    await call(server, 'PATCH', `/api/documents/${doc.id}`, { token: owner.token, body: { linkAccess: 'edit' } });
    const sockets: TestSocket[] = [];
    for (let i = 0; i < 25; i++) {
      const guest = (await call(server, 'POST', '/api/guests', { body: { name: `Guest ${i}` } })).body;
      sockets.push((await TestSocket.join(server, doc.id, { guestToken: guest.guestToken }, `guest${i}`)).socket);
    }
    expect(server.hub.roomSize(doc.id)).toBe(25);
    sockets[3]?.send({ t: 'ops', id: 'many', ops: [{ k: 'n:x:y', v: 1, c: clock(Date.now(), 'guest3') }] });
    await sockets[3]?.next('ack');
    for (const [i, s] of sockets.entries()) if (i !== 3) expect((await s.next('ops')).from).toBe('guest3');
    for (const s of sockets) await s.close();
  });
});
