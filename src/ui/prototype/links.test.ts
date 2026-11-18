import { describe, expect, it } from 'vitest';
import { addFlow, addLayer, createDocument, getPages } from '../../core';
import { audienceOf, createPresentGate, parsePresentHash, planPrototypeLink, presentFrom, presentHash, prototypeLinkUrl, refusalNotice, SHARE_FIRST_REASON, unsentWarning } from './links';

/**
 * Prototype links: the address that presents a shared file from a frame,
 * read back the same, who it opens for, what "Copy prototype link" does for
 * a file on this device, and what someone refused is told.
 */

describe('prototype link addresses', () => {
  it('presents a shared file, from a frame when one is named', () => {
    expect(presentHash('doc1')).toBe('#/doc/doc1/present');
    expect(presentHash('doc1', 'Frame9')).toBe('#/doc/doc1/present/Frame9');
    expect(presentHash('doc1', null)).toBe('#/doc/doc1/present');
    expect(prototypeLinkUrl('https://evora.example.com/', 'doc1', 'F1')).toBe('https://evora.example.com/#/doc/doc1/present/F1');
  });

  it('reads back what it makes, and nothing else', () => {
    expect(parsePresentHash(presentHash('d_1-x'))).toEqual({ docId: 'd_1-x' });
    expect(parsePresentHash(presentHash('doc1', 'F:2'))).toEqual({ docId: 'doc1', startId: 'F:2' });
    expect(parsePresentHash('#/doc/doc1')).toBeNull();
    expect(parsePresentHash('#/doc/doc1/comment/t1')).toBeNull();
    expect(parsePresentHash('#/proto/doc1/F1')).toBeNull();
    expect(parsePresentHash('#/doc/doc1/present/a/b')).toBeNull();
  });

  it('starts where it would without a frame when the frame cannot be read', () => {
    expect(parsePresentHash('#/doc/doc1/present/%E0%A4%A')).toEqual({ docId: 'doc1' });
  });
});

describe('who a prototype link opens for', () => {
  it('says anyone with the link when link access allows viewing', () => {
    expect(audienceOf('view')).toMatch(/Anyone with the link/);
    expect(audienceOf('edit')).toMatch(/Anyone with the link/);
  });

  it('says only the people it is shared with otherwise, and how to change that', () => {
    expect(audienceOf('none')).toMatch(/Only people the file is shared with/);
    expect(audienceOf('none')).toMatch(/change link access in Share/);
  });

  it('claims neither when link access is not known yet (details still loading, or offline)', () => {
    for (const unknown of [null, undefined]) {
      expect(audienceOf(unknown)).not.toBe(audienceOf('none'));
      expect(audienceOf(unknown)).not.toMatch(/Only people the file is shared with/);
      expect(audienceOf(unknown)).not.toMatch(/Anyone with the link/);
    }
  });
});

describe('where a prototype link starts from the editor', () => {
  it('starts at the selected frame (as the Share dialog, the View menu and the Prototype panel all should), else the first flow', () => {
    let doc = createDocument('Links');
    const pageId = (getPages(doc)[0] as { id: string }).id;
    const a = addLayer(doc, 'FRAME', pageId, { x: 0, y: 0, width: 200, height: 300, name: 'Home' });
    const b = addLayer(a.doc, 'FRAME', pageId, { x: 400, y: 0, width: 200, height: 300, name: 'Checkout' });
    doc = (addFlow(b.doc, a.id) as { doc: typeof doc }).doc;
    expect(presentFrom({ doc, pageId, selection: [b.id] })).toBe(b.id);
    expect(presentFrom({ doc, pageId, selection: [] })).toBe(a.id);
    expect(presentFrom({ doc, pageId, selection: [a.id, b.id] })).toBe(a.id);
  });
});

describe('Copy prototype link', () => {
  it('gives the link of a shared file, from the frame asked for', () => {
    expect(planPrototypeLink({ sharedId: 'doc1', linkAccess: 'view', startId: 'F1', origin: 'http://localhost:5173/' })).toEqual({
      kind: 'link',
      url: 'http://localhost:5173/#/doc/doc1/present/F1',
      audience: audienceOf('view'),
    });
  });

  it('asks for a file on this device to be shared first, instead of a link that would not work for others', () => {
    expect(planPrototypeLink({ sharedId: null, startId: 'F1', origin: 'http://localhost:5173/' })).toEqual({ kind: 'share-first', reason: SHARE_FIRST_REASON });
    expect(SHARE_FIRST_REASON).toMatch(/Share it/);
  });
});

describe('a prototype link that could not be opened', () => {
  it('tells someone refused how to get access, and offers signing in', () => {
    const guest = refusalNotice(403, { signedIn: false });
    expect(guest.title).toBe('You do not have access to this prototype');
    expect(guest.detail).toMatch(/As a guest/);
    expect(guest.detail).toMatch(/Ask the person who sent the link/);
    expect(guest.offerSignIn).toBe(true);
    const member = refusalNotice(403, { signedIn: true, name: 'Alex' });
    expect(member.detail).toMatch(/signed in as Alex/);
    expect(member.detail).toMatch(/another|an account that has access/);
  });

  it('asks to sign in again when the session has expired', () => {
    expect(refusalNotice(401, { signedIn: true })).toMatchObject({ title: 'Sign in to view this prototype', offerSignIn: true });
  });

  it('says a link to no file leads nowhere, and does not offer signing in', () => {
    expect(refusalNotice(404, { signedIn: true })).toMatchObject({ title: 'This prototype link leads nowhere', offerSignIn: false });
  });

  it('says when the server cannot be reached, or the file is in the trash', () => {
    expect(refusalNotice(0, { signedIn: false }).detail).toMatch(/cannot be reached/);
    expect(refusalNotice(410, { signedIn: false }, 'This file is in the trash.').title).toBe('This file is in the trash');
    expect(refusalNotice(500, { signedIn: false }, 'Broken.').detail).toBe('Broken.');
  });
});

describe('Present on a shared file, waiting for its changes to be sent', () => {
  function later(): { promise: Promise<void>; resolve: () => void } {
    let resolve = (): void => undefined;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 3; i += 1) await Promise.resolve();
  };

  it('goes once the wait is over', async () => {
    const gate = createPresentGate();
    const wait = later();
    let went = 0;
    expect(gate.start(wait.promise, () => (went += 1))).toBe(true);
    await settle();
    expect(went).toBe(0);
    wait.resolve();
    await settle();
    expect(went).toBe(1);
  });

  it('does nothing for a second Present while the first waits, and allows one after', async () => {
    const gate = createPresentGate();
    const first = later();
    const went: string[] = [];
    expect(gate.start(first.promise, () => went.push('first'))).toBe(true);
    expect(gate.start(Promise.resolve(), () => went.push('second'))).toBe(false);
    first.resolve();
    await settle();
    expect(went).toEqual(['first']);
    expect(gate.start(Promise.resolve(), () => went.push('third'))).toBe(true);
    await settle();
    expect(went).toEqual(['first', 'third']);
  });

  it('does not go once cancelled (the editor was left meanwhile), nor start again', async () => {
    const gate = createPresentGate();
    const wait = later();
    let went = 0;
    gate.start(wait.promise, () => (went += 1));
    gate.cancel();
    wait.resolve();
    await settle();
    expect(went).toBe(0);
    expect(gate.start(Promise.resolve(), () => (went += 1))).toBe(false);
  });

  it('warns instead of going when changes are still unsent after the wait, and goes on the next Present', async () => {
    // The presentation holds no live connection: changes left unsent would not be sent until the editor is opened again.
    const gate = createPresentGate();
    const warned: number[] = [];
    let went = 0;
    expect(gate.start(Promise.resolve(3), () => (went += 1), (left) => warned.push(left))).toBe(true);
    await settle();
    expect(went).toBe(0);
    expect(warned).toEqual([3]);
    // Pressed again: the person was told, so it goes.
    gate.start(Promise.resolve(3), () => (went += 1), (left) => warned.push(left));
    await settle();
    expect(went).toBe(1);
    expect(warned).toEqual([3]);
    // Everything sent: it goes, and a later unsent change is warned about afresh.
    gate.start(Promise.resolve(0), () => (went += 1), (left) => warned.push(left));
    await settle();
    expect(went).toBe(2);
    gate.start(Promise.resolve(1), () => (went += 1), (left) => warned.push(left));
    await settle();
    expect(went).toBe(2);
    expect(warned).toEqual([3, 1]);
  });

  it('says how many changes have not reached the server', () => {
    expect(unsentWarning(1)).toMatch(/1 change has not reached the server/);
    expect(unsentWarning(3)).toMatch(/3 changes have not reached the server/);
    expect(unsentWarning(3)).toMatch(/Present again/);
  });
});
