// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getGuest, setAccount, setAccountStorage, setGuest, type KeyValueStore } from '../../collab/account';
import { createApi } from '../../collab/api';
import { LiveError } from '../../collab/live';
import { createDocument, createLayer, getPages, type Document } from '../../core';
import { freshKeys } from '../../core/order';
import type { DocumentStorage } from '../../persistence/storage';
import { parseRoute } from '../App';
import { PrototypeScreen } from './PrototypeScreen';

/**
 * Presenting a shared file (`#/doc/<id>/present`): the route that reads the
 * link, someone with no name yet asked for one, and someone the server
 * refuses told why and offered a way in, never a blank page.
 */

class MemoryKeyValues implements KeyValueStore {
  private readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
}

beforeEach(() => {
  setAccountStorage(new MemoryKeyValues());
  // jsdom has no layout or canvas: the stage is measured and painted in a real browser only.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      disconnect(): void {}
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});
afterEach(() => {
  cleanup();
  setAccountStorage(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const storage = { loadAsset: async () => null } as unknown as DocumentStorage;
const api = createApi({ auth: () => ({ token: null, guestToken: 'g' }), fetch: async () => Response.json({ error: 'Not found' }, { status: 404 }) });
const refuse = (status: number) => async (): Promise<never> => {
  throw new LiveError(status, 'refused');
};

function show(status: number) {
  render(<PrototypeScreen source="shared" storage={storage} fileId="doc1" startId="F1" onExit={() => undefined} loadShared={refuse(status)} api={api} />);
}

describe('the prototype link route', () => {
  it('opens a shared file in presentation, from the frame named', () => {
    expect(parseRoute('#/doc/doc1/present/F1')).toEqual({ screen: 'present', id: 'doc1', startId: 'F1' });
    expect(parseRoute('#/doc/doc1/present')).toEqual({ screen: 'present', id: 'doc1', startId: undefined });
    expect(parseRoute('#/doc/doc1')).toEqual({ screen: 'doc', id: 'doc1', threadId: undefined });
  });

  it('opens a file on this device with its Share dialog, for a prototype asking to be shared', () => {
    expect(parseRoute('#/file/abc/share')).toEqual({ screen: 'file', id: 'abc', share: true });
  });
});

describe('a shared prototype that cannot be shown', () => {
  it('asks someone with neither an account nor a guest name for one first', () => {
    show(403);
    expect(screen.getByRole('region', { name: 'Join as a guest' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
  });

  it('tells a guest without access to ask for it, and offers signing in', async () => {
    setGuest({ guestToken: 'g', guest: { id: 'g1', name: 'Alex', color: '#0d99ff' } } as Parameters<typeof setGuest>[0]);
    show(403);
    const alert = await screen.findByRole('alert', { name: 'Prototype not opened' });
    expect(alert.textContent).toContain('You do not have access to this prototype');
    expect(alert.textContent).toContain('Ask the person who sent the link');
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('offers a signed-in person without access another account', async () => {
    setAccount({ token: 't', user: { id: 'u1', name: 'Alex', email: 'alex@example.com', color: '#0d99ff' } } as Parameters<typeof setAccount>[0]);
    show(403);
    const alert = await screen.findByRole('alert', { name: 'Prototype not opened' });
    expect(alert.textContent).toContain('signed in as Alex');
    expect(screen.getByRole('button', { name: 'Sign in with another account' })).toBeTruthy();
  });

  it('says a link to no file leads nowhere', async () => {
    setGuest({ guestToken: 'g', guest: { id: 'g1', name: 'Alex', color: '#0d99ff' } } as Parameters<typeof setGuest>[0]);
    show(404);
    const alert = await screen.findByRole('alert', { name: 'Prototype not opened' });
    expect(alert.textContent).toContain('This prototype link leads nowhere');
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
  });
});

/** A small file: one page with two frames, "Home" and "Details". */
function twoFrames(): { doc: Document; home: string; details: string } {
  const doc = createDocument('Checkout');
  const page = getPages(doc)[0];
  if (!page) throw new Error('The new file has no page.');
  const [first, second] = freshKeys(2) as [string, string];
  const home = createLayer('FRAME', page.id, first, { name: 'Home', width: 375, height: 812 });
  const details = createLayer('FRAME', page.id, second, { name: 'Details', x: 500, width: 375, height: 812 });
  return { doc: { ...doc, nodes: { ...doc.nodes, [home.id]: home, [details.id]: details } }, home: home.id, details: details.id };
}

function present(startId: string, loadShared: (docId: string) => Promise<{ doc: Document; fromCache?: boolean }>) {
  render(<PrototypeScreen source="shared" storage={storage} fileId="doc1" startId={startId} onExit={() => undefined} loadShared={loadShared} api={api} />);
}

describe('a shared prototype that opens', () => {
  it('plays for a signed-in member, from the frame the link names', async () => {
    setAccount({ token: 't', user: { id: 'u1', name: 'Alex', email: 'alex@example.com', color: '#0d99ff' } } as Parameters<typeof setAccount>[0]);
    const { doc, details } = twoFrames();
    const asked: string[] = [];
    present(details, async (docId) => {
      asked.push(docId);
      return { doc };
    });
    expect(await screen.findByRole('application', { name: 'Prototype' })).toBeTruthy();
    expect(screen.getByRole('status', { name: 'Current screen' }).textContent).toBe('Details');
    expect(asked).toEqual(['doc1']);
    expect(screen.queryByRole('status', { name: 'Offline' })).toBeNull();
  });

  it('plays for a guest the same way', async () => {
    setGuest({ guestToken: 'g', guest: { id: 'g1', name: 'Alex', color: '#0d99ff' } } as Parameters<typeof setGuest>[0]);
    const { doc, home } = twoFrames();
    present(home, async () => ({ doc }));
    expect(await screen.findByRole('application', { name: 'Prototype' })).toBeTruthy();
    expect(screen.getByRole('status', { name: 'Current screen' }).textContent).toBe('Home');
  });

  it('says so in the bar when it shows the copy kept on this device, the server being out of reach', async () => {
    setGuest({ guestToken: 'g', guest: { id: 'g1', name: 'Alex', color: '#0d99ff' } } as Parameters<typeof setGuest>[0]);
    const { doc, home } = twoFrames();
    present(home, async () => ({ doc, fromCache: true }));
    const offline = await screen.findByRole('status', { name: 'Offline' });
    expect(offline.textContent).toBe('Offline: showing the copy kept on this device');
    expect(screen.getByRole('status', { name: 'Current screen' }).textContent).toBe('Home');
  });
});

describe('a guest name the server no longer knows', () => {
  it('is forgotten, and a new one asked for', async () => {
    setGuest({ guestToken: 'stale', guest: { id: 'g1', name: 'Alex', color: '#0d99ff' } } as Parameters<typeof setGuest>[0]);
    show(401);
    expect(await screen.findByRole('region', { name: 'Join as a guest' })).toBeTruthy();
    expect(getGuest()).toBeNull();
    expect(screen.queryByRole('alert', { name: 'Prototype not opened' })).toBeNull();
  });

  it('is not why a signed-in person is refused: they are asked to sign in again', async () => {
    setAccount({ token: 't', user: { id: 'u1', name: 'Alex', email: 'alex@example.com', color: '#0d99ff' } } as Parameters<typeof setAccount>[0]);
    show(401);
    const alert = await screen.findByRole('alert', { name: 'Prototype not opened' });
    expect(alert.textContent).toContain('Sign in to view this prototype');
  });
});
