// @vitest-environment jsdom
import { IDBFactory } from 'fake-indexeddb';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { addLayer, createDocument, getPages, patchNode } from './core';
import { createVersionsApi } from './collab/versions';
import { ImageCache } from './engine/images/imageCache';
import { MemoryStorage } from './persistence/storage';
import { LocalVersionStore } from './persistence/versions';
import { createEditorStore, type EditorStore } from './state/editorStore';
import { EditorContext, type EditorContextValue } from './ui/editor/EditorContext';
import { CollabContext } from './ui/collab/CollabContext';
import { createCollabSession } from './ui/collab/session';
import { versionsActions, versionsUi } from './ui/versions/state';
import { VersionsMount } from './ui/versions/VersionsMount';

/**
 * Version history in the editor, for a file on this device: an automatic
 * version when the file is opened, "Save to version history" (Ctrl+Alt+S),
 * the panel, looking at a version and restoring it as one undo step; and for
 * a shared file that is a branch, its "Branch of …" badge.
 */

afterEach(() => {
  cleanup();
  versionsActions.reset();
});

function editor(store: EditorStore): EditorContextValue {
  return {
    store,
    app: {} as never,
    controller: { current: null },
    storage: new MemoryStorage(),
    images: new ImageCache(async () => null),
    placeFiles: async () => undefined,
    pickImage: async () => null,
  };
}

describe('version history of a file on this device', () => {
  it('keeps a version on opening, saves named ones, shows one and restores it as one undo step', async () => {
    const doc = createDocument('Poster');
    const made = addLayer(doc, 'RECTANGLE', getPages(doc)[0]!.id, { name: 'Box', x: 10 });
    const store = createEditorStore(made.doc);
    const local = new LocalVersionStore(new IDBFactory());
    render(
      <EditorContext.Provider value={editor(store)}>
        <VersionsMount local={local} />
      </EditorContext.Provider>,
    );
    // Opened, and never kept before: an automatic version.
    await waitFor(async () => expect(await local.list(made.doc.id)).toHaveLength(1));

    // Ctrl+Alt+S: Save to version history.
    fireEvent.keyDown(window, { key: 's', code: 'KeyS', ctrlKey: true, altKey: true });
    const dialog = await screen.findByRole('dialog', { name: 'Save to version history' });
    fireEvent.change(within(dialog).getByLabelText('Title'), { target: { value: 'Box at 10' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Saved “Box at 10” to the version history.')).toBeTruthy();

    act(() => store.getState().apply('Move', (current) => patchNode(current, made.id, { x: 500 })));
    act(() => versionsActions.openPanel());
    const panel = await screen.findByRole('complementary', { name: 'Version history' });
    fireEvent.click(await within(panel).findByRole('button', { name: /^Box at 10/ }));
    const viewer = await screen.findByRole('dialog', { name: 'Viewing Box at 10' });
    // The file has not changed by looking.
    expect(store.getState().doc.nodes[made.id]).toMatchObject({ x: 500 });

    const steps = store.getState().undoStack.length;
    fireEvent.click(within(viewer).getByRole('button', { name: 'Restore this version' }));
    await waitFor(() => expect(store.getState().doc.nodes[made.id]).toMatchObject({ x: 10 }));
    expect(store.getState().undoStack.length).toBe(steps + 1);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Viewing Box at 10' })).toBeNull());
    act(() => store.getState().undo());
    expect(store.getState().doc.nodes[made.id]).toMatchObject({ x: 500 });
    expect((await local.list(made.doc.id)).map((v) => v.name)).toEqual(['Before restoring Box at 10', 'Box at 10', '']);
  });
});

describe('a shared file that is a branch', () => {
  it('shows whose branch it is, with Update from main and Merge into main', async () => {
    const store = createEditorStore(createDocument('Idea'));
    const branch = { id: 'b1', name: 'Idea', mainId: 'm1', mainName: 'Website', status: 'open', baseSeq: 4, createdBy: { id: 'u', name: 'Ana', color: '#000000' }, createdAt: '', mergedAt: null, mergedBy: null };
    const api = createVersionsApi({
      auth: () => ({ token: 't', guestToken: null }),
      fetch: async (url) => {
        if (url === '/api/documents/b1/branch') return Response.json({ branch });
        if (url === '/api/documents/b1/merge') return Response.json({ mainId: 'm1', mainSeq: 9, baseSeq: 4, status: 'open', canMerge: true, changes: [], conflicts: [] });
        if (url.endsWith('/registers')) return Response.json({ seq: 1, registers: [] });
        return Response.json([]);
      },
    });
    const session = createCollabSession({ docId: 'b1', api: {} as never });
    render(
      <EditorContext.Provider value={editor(store)}>
        <CollabContext.Provider value={session}>
          <VersionsMount api={api} local={new LocalVersionStore(null)} />
        </CollabContext.Provider>
      </EditorContext.Provider>,
    );
    const badge = await screen.findByRole('region', { name: 'Branch' });
    expect(badge.textContent).toContain('Branch of Website');
    expect(versionsUi.getState().context).toMatchObject({ shared: true, docId: 'b1', branch: { mainId: 'm1' } });
    fireEvent.click(within(badge).getByRole('button', { name: 'Merge into main' }));
    const review = await screen.findByRole('dialog', { name: 'Merge “Idea” into main' });
    expect(await within(review).findByText('This branch has no changes to merge.')).toBeTruthy();
    expect(within(review).getByRole('button', { name: 'Merge branch' })).toHaveProperty('disabled', true);
  });
});
