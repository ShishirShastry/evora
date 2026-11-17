import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { addLayer, createDocument, getPages, patchNode, type Document } from './core';
import { LocalVersionStore, VERSIONS_DB_NAME } from './persistence/versions';
import { createEditorStore } from './state/editorStore';
import { localSource, restoredDocument } from './ui/versions/source';

/**
 * The version history of files on this device (IndexedDB "evora-versions",
 * here a fake one): keeping, listing, reading, naming and removing versions,
 * automatic versions only when something changed, thinning them out, and
 * restoring a version as one step that undo takes back.
 */

function docWithRect(): { doc: Document; rectId: string } {
  const doc = createDocument('Poster');
  const page = getPages(doc)[0]!;
  const made = addLayer(doc, 'RECTANGLE', page.id, { x: 10, y: 20, width: 100, height: 50 });
  return { doc: made.doc, rectId: made.id };
}

describe('LocalVersionStore', () => {
  it('keeps whole documents, lists a file’s versions newest first, and reads them back', async () => {
    const versions = new LocalVersionStore(new IDBFactory());
    const { doc, rectId } = docWithRect();
    const first = await versions.add(doc.id, doc, { kind: 'named', name: ' First ', description: 'Start', at: new Date('2026-11-17T10:00:00Z') });
    expect(first).toMatchObject({ fileId: doc.id, kind: 'named', name: 'First', description: 'Start', layerCount: 1 });
    const moved = patchNode(doc, rectId, { x: 300 });
    await versions.add(doc.id, moved, { kind: 'auto', at: new Date('2026-11-17T11:00:00Z') });
    await versions.add('another-file', moved, { kind: 'auto' });

    const list = await versions.list(doc.id);
    expect(list.map((v) => v.kind)).toEqual(['auto', 'named']);
    const held = await versions.content(first.id);
    expect(held?.nodes[rectId]).toMatchObject({ x: 10 });
    expect((await versions.content(list[0]!.id))?.nodes[rectId]).toMatchObject({ x: 300 });
    expect(await versions.content('nope')).toBeNull();
  });

  it('is kept in its own database, and survives being opened again', async () => {
    const factory = new IDBFactory();
    const { doc } = docWithRect();
    await new LocalVersionStore(factory).add(doc.id, doc, { kind: 'named', name: 'Kept' });
    const again = new LocalVersionStore(factory, VERSIONS_DB_NAME);
    expect((await again.list(doc.id)).map((v) => v.name)).toEqual(['Kept']);
  });

  it('names, describes and removes versions; naming an autosave makes it named', async () => {
    const versions = new LocalVersionStore(new IDBFactory());
    const { doc } = docWithRect();
    const auto = await versions.add(doc.id, doc, { kind: 'auto' });
    const named = await versions.update(auto.id, { name: 'Approved', description: 'By the client' });
    expect(named).toMatchObject({ kind: 'named', name: 'Approved', description: 'By the client' });
    await expect(versions.update(auto.id, { name: '' })).rejects.toThrow('needs a name');
    await versions.remove(auto.id);
    expect(await versions.list(doc.id)).toEqual([]);
    expect(await versions.content(auto.id)).toBeNull();
  });

  it('makes an automatic version only when the document differs from the latest one', async () => {
    const versions = new LocalVersionStore(new IDBFactory());
    const { doc, rectId } = docWithRect();
    expect(await versions.checkpoint(doc.id, doc)).not.toBeNull();
    expect(await versions.checkpoint(doc.id, doc)).toBeNull();
    // A document read again from storage is equal, not the same object: still nothing new.
    expect(await versions.checkpoint(doc.id, structuredClone(doc))).toBeNull();
    expect(await versions.checkpoint(doc.id, patchNode(doc, rectId, { y: 99 }))).toMatchObject({ kind: 'auto' });
    expect(await versions.list(doc.id)).toHaveLength(2);
  });

  it('thins automatic versions out as they age, keeping named ones', async () => {
    const versions = new LocalVersionStore(new IDBFactory());
    const { doc } = docWithRect();
    const now = Date.parse('2026-11-17T12:00:00Z');
    const at = (iso: string) => new Date(iso);
    await versions.add(doc.id, doc, { kind: 'auto', at: at('2026-11-10T09:00:00Z') });
    await versions.add(doc.id, doc, { kind: 'auto', at: at('2026-11-10T15:00:00Z') });
    await versions.add(doc.id, doc, { kind: 'named', name: 'Same day', at: at('2026-11-10T16:00:00Z') });
    await versions.add(doc.id, doc, { kind: 'auto', at: at('2026-11-17T11:00:00Z') });
    await versions.add(doc.id, doc, { kind: 'auto', at: at('2026-11-17T11:30:00Z') });
    // Adding an automatic version thinned the older ones out already: of 10 November, the last autosave is kept.
    expect(await versions.prune(doc.id, now)).toBe(0);
    const left = await versions.list(doc.id);
    expect(left.map((v) => v.createdAt)).toEqual(['2026-11-17T11:30:00.000Z', '2026-11-17T11:00:00.000Z', '2026-11-10T16:00:00.000Z', '2026-11-10T15:00:00.000Z']);
  });
});

describe('restoring a version of a file on this device', () => {
  it('keeps the file’s ID, name and images', () => {
    const { doc } = docWithRect();
    const now = { ...doc, name: 'Renamed', assets: { abc: { name: 'photo.png', mimeType: 'image/png', width: 1, height: 1 } } } as unknown as Document;
    const old = { ...doc, id: 'other', name: 'Old name', assets: {} } as Document;
    const restored = restoredDocument(now, old);
    expect(restored.id).toBe(doc.id);
    expect(restored.name).toBe('Renamed');
    expect(Object.keys(restored.assets)).toEqual(['abc']);
  });

  it('is one step of the undo history, after keeping what there was as a version', async () => {
    const versions = new LocalVersionStore(new IDBFactory());
    const { doc, rectId } = docWithRect();
    const store = createEditorStore(doc);
    const source = localSource(store, versions);
    const saved = await source.create('Original', 'Rectangle at 10');

    store.getState().apply('Move', (current) => patchNode(current, rectId, { x: 400 }));
    store.getState().apply('Resize', (current) => patchNode(current, rectId, { width: 10 }));
    const undoBefore = store.getState().undoStack.length;

    const said = await source.restore(saved);
    expect(said).toContain('Restored “Original”');
    expect(store.getState().doc.nodes[rectId]).toMatchObject({ x: 10, width: 100 });
    expect(store.getState().undoStack.length).toBe(undoBefore + 1);
    expect(store.getState().undoStack.at(-1)?.label).toBe('Restore version');

    // What there was is in the history too.
    const list = await source.list();
    expect(list.map((v) => v.name)).toEqual(['Before restoring Original', 'Original']);
    const before = await source.content(list[0]!);
    expect(before.nodes[rectId]).toMatchObject({ x: 400, width: 10 });

    store.getState().undo();
    expect(store.getState().doc.nodes[rectId]).toMatchObject({ x: 400, width: 10 });
  });
});
