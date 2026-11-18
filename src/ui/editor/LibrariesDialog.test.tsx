// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAccount, setAccountStorage, setGuest, type KeyValueStore } from '../../collab/account';
import { createLibrariesApi, createLibraryUpdates, type TeamLibrarySummary } from '../../collab/libraries';
import {
  addLayer,
  createComponent,
  createDocument,
  createStyle,
  getPages,
  imagePaint,
  importLibrary,
  listLibraries,
  mirrorId,
  publishLibrary,
  solidPaint,
  updateStyle,
  type Document,
  type NodeId,
  type Publication,
} from '../../core';
import { ImageCache } from '../../engine/images/imageCache';
import { saveDocument } from '../../persistence/files';
import { MemoryStorage } from '../../persistence/storage';
import { createEditorStore, type EditorStore } from '../../state/editorStore';
import { EditorContext, type EditorContextValue } from './EditorContext';
import { LibrariesDialog } from './LibrariesDialog';
import { LibraryUpdatesContext, LibraryUpdatesNotice } from './LibraryUpdates';

/**
 * The Libraries dialog with team libraries: the "On this device" and "Team
 * libraries" sections, what it says to someone not signed in and offline,
 * adding a team library (its images kept on this device), and the "Library
 * updates available" notice, accepted (one undo step) and declined.
 */

const AT = '2026-11-18T12:00:00.000Z';
const HASH = 'b'.repeat(64);
const RED = { r: 1, g: 0, b: 0 };
const GREEN = { r: 0, g: 1, b: 0 };

class MemoryKeyValues implements KeyValueStore {
  private data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
}

beforeEach(() => {
  setAccountStorage(new MemoryKeyValues());
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  setAccountStorage(null);
  vi.unstubAllGlobals();
});

const signIn = (): void => setAccount({ token: 'session-alex', user: { id: 'u1', email: 'alex@example.com', name: 'Alex', color: '#0d99ff', createdAt: AT } });

/** A published library file with a red component styled by "Brand", with an icon (an image) inside it. */
function kitDocument(id: string, name = 'Kit'): { doc: Document; style: string } {
  let doc: Document = { ...createDocument(name), id };
  const pageId = (getPages(doc)[0] as { id: NodeId }).id;
  const added = addLayer(doc, 'FRAME', pageId, { x: 0, y: 0, width: 100, height: 40, name: 'Button', fills: [solidPaint(RED)] });
  const icon = addLayer(added.doc, 'RECTANGLE', added.id, { x: 4, y: 4, width: 16, height: 16, name: 'Icon', fills: [imagePaint(HASH)] });
  doc = (createComponent(icon.doc, [added.id]) as { doc: Document }).doc;
  const styled = createStyle(doc, added.id, 'fills', 'Brand') as { doc: Document; id: string };
  doc = { ...styled.doc, assets: { [HASH]: { mimeType: 'image/png', width: 1, height: 1, name: 'dot.png' } } };
  return { doc: publishLibrary(doc, AT), style: styled.id };
}

const summary = (overrides: Partial<TeamLibrarySummary>): TeamLibrarySummary => ({
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

/** A fake server for the team library routes. */
function fakeServer(libraries: () => TeamLibrarySummary[], publications: Record<string, () => Publication>) {
  const calls: string[] = [];
  const fetch = async (url: string): Promise<Response> => {
    calls.push(url);
    if (url === '/api/libraries') return Response.json({ libraries: libraries() });
    const library = /^\/api\/documents\/([^/]+)\/library$/.exec(url);
    if (library) {
      const make = publications[decodeURIComponent(library[1] as string)];
      return make ? Response.json({ id: library[1], name: 'Kit', publication: make() }) : Response.json({ error: 'Not published.' }, { status: 404 });
    }
    if (url.includes('/assets/')) return new Response(new Uint8Array([1, 2]).buffer, { headers: { 'Content-Type': 'image/png' } });
    return Response.json({ error: 'Not found.' }, { status: 404 });
  };
  return { api: createLibrariesApi({ fetch }), calls };
}

function editorValue(store: EditorStore, storage: MemoryStorage): EditorContextValue {
  return {
    store,
    app: { saveNow: () => undefined } as never,
    controller: { current: null },
    storage,
    images: new ImageCache(async () => null),
    placeFiles: async () => undefined,
    pickImage: async () => null,
  };
}

const section = (name: string) => screen.getByRole('region', { name });

describe('the Libraries dialog', () => {
  it('asks a guest, who is in no workspace, to sign in with an account, without asking the server', async () => {
    setGuest({ guestToken: 'guest-sam', guest: { id: 'g1', name: 'Sam', color: '#0d99ff' } });
    const store = createEditorStore(createDocument('Design'));
    const { api, calls } = fakeServer(() => [summary({})], {});
    render(
      <EditorContext.Provider value={editorValue(store, new MemoryStorage())}>
        <LibrariesDialog onClose={() => undefined} teamApi={api} />
      </EditorContext.Provider>,
    );
    const team = section('Team libraries');
    await waitFor(() => expect(team.textContent).toContain('Sign in with an account to use them.'));
    expect(within(team).getByRole('button', { name: 'Sign in' })).toBeTruthy();
    expect(calls).toEqual([]);
  });

  it('asks someone who is not signed in to sign in for team libraries, and still lists this device’s libraries', async () => {
    const storage = new MemoryStorage();
    await saveDocument(storage, kitDocument('local-kit', 'Local kit').doc, AT);
    const store = createEditorStore(createDocument('Design'));
    const { api, calls } = fakeServer(() => [], {});
    render(
      <EditorContext.Provider value={editorValue(store, storage)}>
        <LibrariesDialog onClose={() => undefined} teamApi={api} />
      </EditorContext.Provider>,
    );
    await waitFor(() => expect(section('Libraries on this device').textContent).toContain('Local kit'));
    const team = section('Team libraries');
    expect(team.textContent).toContain('Sign in to use your team’s libraries.');
    expect(within(team).getByRole('button', { name: 'Sign in' })).toBeTruthy();
    expect(calls).toEqual([]);
  });

  it('says so when offline, and tries again', async () => {
    signIn();
    let reachable = false;
    const api = createLibrariesApi({
      fetch: async () => {
        if (!reachable) throw new TypeError('Failed to fetch');
        return Response.json({ libraries: [summary({})] });
      },
    });
    const store = createEditorStore(createDocument('Design'));
    render(
      <EditorContext.Provider value={editorValue(store, new MemoryStorage())}>
        <LibrariesDialog onClose={() => undefined} teamApi={api} />
      </EditorContext.Provider>,
    );
    await waitFor(() => expect(section('Team libraries').textContent).toContain('You are offline, or the collaboration server cannot be reached.'));
    reachable = true;
    fireEvent.click(within(section('Team libraries')).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(section('Team libraries').textContent).toContain('Kit'));
  });

  it('shows a signed-out message when the session has ended', async () => {
    signIn();
    const api = createLibrariesApi({ fetch: async () => Response.json({ error: 'Sign in first.' }, { status: 401 }) });
    render(
      <EditorContext.Provider value={editorValue(createEditorStore(createDocument('Design')), new MemoryStorage())}>
        <LibrariesDialog onClose={() => undefined} teamApi={api} />
      </EditorContext.Provider>,
    );
    await waitFor(() => expect(section('Team libraries').textContent).toContain('Your session has ended. Sign in to use your team’s libraries.'));
    expect(within(section('Team libraries')).getByRole('button', { name: 'Sign in' })).toBeTruthy();
  });

  it('lists team libraries by workspace and adds one to the file, with its images', async () => {
    signIn();
    const kit = kitDocument('kit-doc');
    const { api } = fakeServer(
      () => [
        summary({ id: 'icons-doc', name: 'Icons', workspaceId: 'w0', workspaceName: 'Brand', version: 4, components: 12, styles: 0, variables: 1 }),
        summary({}),
        summary({ id: 'design-doc', name: 'Design' }),
      ],
      { 'kit-doc': () => kit.doc.publication as Publication },
    );
    const storage = new MemoryStorage();
    // The file itself ('design-doc') is published too: it is not offered to itself.
    const store = createEditorStore({ ...createDocument('Design'), id: 'design-doc' });
    render(
      <EditorContext.Provider value={editorValue(store, storage)}>
        <LibrariesDialog onClose={() => undefined} teamApi={api} />
      </EditorContext.Provider>,
    );
    const brand = await screen.findByRole('group', { name: 'Brand' });
    expect(brand.textContent).toContain('Icons');
    expect(brand.textContent).toContain('12 components, 0 styles, 1 variable');
    expect(brand.textContent).toContain('Version 4.');
    const designTeam = screen.getByRole('group', { name: 'Design team' });
    expect(designTeam.textContent).toContain('Kit');
    expect(within(designTeam).queryByRole('button', { name: 'Add Design' })).toBeNull();

    fireEvent.click(within(designTeam).getByRole('button', { name: 'Add Kit' }));
    await waitFor(() => expect(listLibraries(store.getState().doc)).toEqual([{ id: 'kit-doc', name: 'Kit', version: 1, publishedAt: AT }]));
    expect(store.getState().undoStack.at(-1)?.label).toBe('Add library');
    expect(await storage.loadAsset(HASH)).toMatchObject({ mimeType: 'image/png' });
    await waitFor(() => expect(section('Libraries used in this file').textContent).toContain('Version 1. Up to date.'));
    expect(screen.queryByRole('group', { name: 'Design team' })).toBeNull();
  });

  it('offers a newer team version, takes it as one undo step, and the style follows', async () => {
    signIn();
    const kit = kitDocument('kit-doc');
    const v2 = publishLibrary(updateStyle(kit.doc, kit.style, { paints: [solidPaint(GREEN)] }), AT).publication as Publication;
    const { api } = fakeServer(() => [summary({ version: 2, publishedAt: v2.publishedAt })], { 'kit-doc': () => v2 });
    const store = createEditorStore(importLibrary(createDocument('Design'), { id: 'kit-doc', name: 'Kit', publication: kit.doc.publication as Publication }));
    const styleId = mirrorId('kit-doc', kit.style);
    const colour = () => (store.getState().doc.styles[styleId] as { paints: { color: unknown }[] }).paints[0]?.color;
    expect(colour()).toEqual(RED);
    render(
      <EditorContext.Provider value={editorValue(store, new MemoryStorage())}>
        <LibrariesDialog onClose={() => undefined} teamApi={api} />
      </EditorContext.Provider>,
    );
    const notice = await screen.findByRole('region', { name: 'Library updates available' });
    expect(notice.textContent).toContain('Kit: version 1 → 2');
    expect(section('Libraries used in this file').textContent).toContain('Version 2 is available.');
    const steps = store.getState().undoStack.length;
    fireEvent.click(within(notice).getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(colour()).toEqual(GREEN));
    expect(store.getState().undoStack.length).toBe(steps + 1);
    expect(listLibraries(store.getState().doc)).toEqual([{ id: 'kit-doc', name: 'Kit', version: 2, publishedAt: v2.publishedAt }]);
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Library updates available' })).toBeNull());
    act(() => store.getState().undo());
    expect(colour()).toEqual(RED);
  });
});

describe('the library updates notice in the editor', () => {
  it('lists what changed, and “Not now” hides it until the next version', async () => {
    signIn();
    const kit = kitDocument('kit-doc');
    let version = 2;
    const { api } = fakeServer(() => [summary({ version, publishedAt: `2026-11-18T2${version}:00:00.000Z` })], {});
    const store = createEditorStore(importLibrary(createDocument('Design'), { id: 'kit-doc', name: 'Kit', publication: kit.doc.publication as Publication }));
    const updates = createLibraryUpdates({ editor: store, storage: new MemoryStorage(), api, signedIn: () => true });
    render(
      <EditorContext.Provider value={editorValue(store, new MemoryStorage())}>
        <LibraryUpdatesContext.Provider value={updates}>
          <LibraryUpdatesNotice updates={updates} />
        </LibraryUpdatesContext.Provider>
      </EditorContext.Provider>,
    );
    await act(() => updates.check());
    const notice = screen.getByRole('region', { name: 'Library updates available' });
    expect(within(notice).getByRole('status').textContent).toContain('Kit: version 1 → 2');
    fireEvent.click(within(notice).getByRole('button', { name: 'Not now' }));
    expect(screen.queryByRole('region', { name: 'Library updates available' })).toBeNull();
    // Checked again: still version 2, still hidden. Version 3 shows it again.
    await act(() => updates.check());
    expect(screen.queryByRole('region', { name: 'Library updates available' })).toBeNull();
    version = 3;
    await act(() => updates.check());
    expect(screen.getByRole('region', { name: 'Library updates available' }).textContent).toContain('Kit: version 1 → 3');
  });

  it('shows nothing to someone who may only view the file', async () => {
    signIn();
    const kit = kitDocument('kit-doc');
    const { api } = fakeServer(() => [summary({ version: 2 })], {});
    const store = createEditorStore(importLibrary(createDocument('Design'), { id: 'kit-doc', name: 'Kit', publication: kit.doc.publication as Publication }));
    store.setState({ readOnly: true });
    const updates = createLibraryUpdates({ editor: store, storage: new MemoryStorage(), api, signedIn: () => true });
    render(
      <EditorContext.Provider value={editorValue(store, new MemoryStorage())}>
        <LibraryUpdatesNotice updates={updates} />
      </EditorContext.Provider>,
    );
    await act(() => updates.check());
    expect(screen.queryByRole('region', { name: 'Library updates available' })).toBeNull();
  });
});
