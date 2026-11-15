import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  addLayer,
  createDocument,
  CURRENT_SCHEMA_VERSION,
  FileFormatError,
  getChildIds,
  getPages,
  patchNode,
  toFile,
  type Document,
  type NodeId,
  type OpenDesignFile,
} from '../core';
import { createEditorStore } from '../state/editorStore';
import { createAutosaver } from './autosave';
import {
  createFile,
  duplicateFile,
  exportFileName,
  exportFileText,
  importFileText,
  listFiles,
  openFile,
  renameFile,
  saveDocument,
} from './files';
import { IndexedDbStorage } from './indexedDbStorage';
import { loadSession, saveSession } from './session';
import { MemoryStorage, type DocumentStorage } from './storage';

let dbCounter = 0;
function freshStorage(): IndexedDbStorage {
  return new IndexedDbStorage(indexedDB, `open-design-test-${dbCounter++}`);
}

function sampleDocument(): { doc: Document; pageId: NodeId; rectId: NodeId } {
  const doc = createDocument('Sample');
  const pageId = (getPages(doc)[0] as { id: NodeId }).id;
  const frame = addLayer(doc, 'FRAME', pageId, { x: 10, y: 20, width: 300, height: 200 });
  const rect = addLayer(frame.doc, 'RECTANGLE', frame.id, { x: 5, y: 6, width: 70, height: 80, rotation: 15 });
  return { doc: rect.doc, pageId, rectId: rect.id };
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const meta = { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };

describe('IndexedDB storage', () => {
  it('saves, lists, loads and removes files', async () => {
    const storage = freshStorage();
    expect(await storage.list()).toEqual([]);
    expect(await storage.load('nope')).toBeNull();

    const { doc } = sampleDocument();
    await storage.save(toFile(doc, meta));
    expect(await storage.list()).toEqual([
      { id: doc.id, name: 'Sample', createdAt: meta.createdAt, updatedAt: meta.updatedAt, layerCount: 2 },
    ]);
    const loaded = await storage.load(doc.id);
    expect(loaded?.document).toEqual(doc);
    expect(loaded?.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);

    await storage.remove(doc.id);
    expect(await storage.list()).toEqual([]);
    expect(await storage.load(doc.id)).toBeNull();
    await storage.close();
  });

  it('keeps data across connections, as a page reload would', async () => {
    const name = `open-design-test-${dbCounter++}`;
    const first = new IndexedDbStorage(indexedDB, name);
    const { doc } = sampleDocument();
    await first.save(toFile(doc, meta));
    await first.close();

    const second = new IndexedDbStorage(indexedDB, name);
    expect((await second.load(doc.id))?.document).toEqual(doc);
    await second.close();
  });
});

describe('file operations', () => {
  let storage: DocumentStorage;
  beforeEach(() => {
    storage = freshStorage();
  });

  it('creates files and lists the most recently edited first', async () => {
    const a = await createFile(storage, 'First');
    await wait(5);
    const b = await createFile(storage, 'Second');
    expect((await listFiles(storage)).map((f) => f.name)).toEqual(['Second', 'First']);

    const opened = await openFile(storage, a.id);
    if (!opened) throw new Error('file missing');
    await wait(5);
    await saveDocument(storage, opened.doc, opened.meta.createdAt);
    expect((await listFiles(storage)).map((f) => f.id)).toEqual([a.id, b.id]);
  });

  it('opens what was saved, unchanged and with nothing to repair', async () => {
    const { doc } = sampleDocument();
    await saveDocument(storage, doc, meta.createdAt);
    const opened = await openFile(storage, doc.id);
    expect(opened?.doc).toEqual(doc);
    expect(opened?.repairs).toEqual([]);
    expect(opened?.meta.createdAt).toBe(meta.createdAt);
    expect(await openFile(storage, 'missing')).toBeNull();
  });

  it('renames and duplicates', async () => {
    const { doc } = sampleDocument();
    await saveDocument(storage, doc, meta.createdAt);
    await renameFile(storage, doc.id, '  Renamed  ');
    expect((await openFile(storage, doc.id))?.doc.name).toBe('Renamed');

    const copyId = await duplicateFile(storage, doc.id);
    expect(copyId).not.toBe(doc.id);
    const copy = await openFile(storage, copyId as string);
    expect(copy?.doc.name).toBe('Renamed copy');
    expect(copy?.doc.nodes).toEqual(doc.nodes);
    expect(await listFiles(storage)).toHaveLength(2);
  });

  it('exports to text and imports it back as a separate file every time', async () => {
    const { doc } = sampleDocument();
    const text = exportFileText(doc, meta);
    const first = await importFileText(storage, text);
    const second = await importFileText(storage, text);
    expect(first.repairs).toEqual([]);
    expect(first.id).not.toBe(doc.id);
    expect(second.id).not.toBe(first.id);
    expect(await listFiles(storage)).toHaveLength(2);
    expect((await openFile(storage, first.id))?.doc.nodes).toEqual(doc.nodes);
  });

  it('refuses files it cannot read, with a message for the user', async () => {
    await expect(importFileText(storage, 'not json at all')).rejects.toBeInstanceOf(FileFormatError);
    await expect(importFileText(storage, '{"hello":"world"}')).rejects.toThrow('not an OPEN DESIGN file');
    const { doc } = sampleDocument();
    const future = { ...toFile(doc, meta), schemaVersion: CURRENT_SCHEMA_VERSION + 1 };
    await expect(importFileText(storage, JSON.stringify(future))).rejects.toThrow('newer version');
    expect(await listFiles(storage)).toEqual([]);
  });

  it('builds a safe file name for export', () => {
    expect(exportFileName('Landing page')).toBe('Landing page.opendesign');
    expect(exportFileName('a/b:c*d')).toBe('a b c d.opendesign');
    expect(exportFileName('///')).toBe('Untitled.opendesign');
  });
});

describe('autosave', () => {
  it('writes committed changes and reports the true status', async () => {
    const storage = new MemoryStorage();
    const { doc, rectId } = sampleDocument();
    await storage.save(toFile(doc, meta));
    const store = createEditorStore(doc);
    const saver = createAutosaver(store, storage, meta, { delay: 10 });
    expect(store.getState().saveStatus).toBe('saved');

    store.getState().apply('Move', (d) => patchNode(d, rectId, { x: 99 }));
    expect(store.getState().saveStatus).toBe('unsaved');
    expect((await storage.load(doc.id))?.document.nodes[rectId]).toMatchObject({ x: 5 });

    await wait(40);
    expect(store.getState().saveStatus).toBe('saved');
    expect((await storage.load(doc.id))?.document.nodes[rectId]).toMatchObject({ x: 99 });
    expect(saver.meta().updatedAt > meta.updatedAt).toBe(true);
    expect(saver.meta().createdAt).toBe(meta.createdAt);
    await saver.dispose();
  });

  it('does not write a drag in progress, only its result', async () => {
    const storage = new MemoryStorage();
    const { doc, rectId } = sampleDocument();
    await storage.save(toFile(doc, meta));
    const store = createEditorStore(doc);
    const saver = createAutosaver(store, storage, meta, { delay: 5 });

    store.getState().beginGesture();
    store.getState().updateGesture((base) => patchNode(base, rectId, { x: 50 }));
    await wait(30);
    expect((await storage.load(doc.id))?.document.nodes[rectId]).toMatchObject({ x: 5 });
    expect(store.getState().saveStatus).toBe('unsaved');

    store.getState().commitGesture('Move');
    await wait(30);
    expect((await storage.load(doc.id))?.document.nodes[rectId]).toMatchObject({ x: 50 });
    expect(store.getState().saveStatus).toBe('saved');
    await saver.dispose();
  });

  it('saves undo and file renames too', async () => {
    const storage = new MemoryStorage();
    const { doc, rectId } = sampleDocument();
    const store = createEditorStore(doc);
    const saver = createAutosaver(store, storage, meta, { delay: 5 });
    store.getState().apply('Move', (d) => patchNode(d, rectId, { x: 77 }));
    await saver.flush();
    store.getState().undo();
    store.getState().renameDocument('New name');
    await saver.flush();
    const stored = await storage.load(doc.id);
    expect(stored?.document.name).toBe('New name');
    expect(stored?.document.nodes[rectId]).toMatchObject({ x: 5 });
    await saver.dispose();
  });

  it('reports a failed write and recovers on the next one', async () => {
    const inner = new MemoryStorage();
    let failing = true;
    const storage: DocumentStorage = {
      list: () => inner.list(),
      load: (id) => inner.load(id),
      remove: (id) => inner.remove(id),
      save: async (file: OpenDesignFile) => {
        if (failing) throw new Error('disk full');
        await inner.save(file);
      },
    };
    const { doc, rectId } = sampleDocument();
    const store = createEditorStore(doc);
    const saver = createAutosaver(store, storage, meta, { delay: 5 });

    store.getState().apply('Move', (d) => patchNode(d, rectId, { x: 1 }));
    await saver.flush();
    expect(store.getState().saveStatus).toBe('error');
    expect(store.getState().saveError).toBe('disk full');
    expect(await inner.load(doc.id)).toBeNull();

    failing = false;
    await saver.flush();
    expect(store.getState().saveStatus).toBe('saved');
    expect((await inner.load(doc.id))?.document.nodes[rectId]).toMatchObject({ x: 1 });
    await saver.dispose();
  });

  it('flushes pending changes when the editor closes', async () => {
    const storage = new MemoryStorage();
    const { doc, pageId } = sampleDocument();
    const store = createEditorStore(doc);
    const saver = createAutosaver(store, storage, meta, { delay: 10_000 });
    store.getState().apply('Add', (d) => addLayer(d, 'ELLIPSE', pageId).doc);
    await saver.dispose();
    const stored = await storage.load(doc.id);
    expect(getChildIds(stored?.document as Document, pageId)).toHaveLength(2);
  });
});

describe('session memory', () => {
  function fakeStorage(): Storage {
    const data = new Map<string, string>();
    return {
      get length() {
        return data.size;
      },
      clear: () => data.clear(),
      getItem: (key) => data.get(key) ?? null,
      key: (index) => [...data.keys()][index] ?? null,
      removeItem: (key) => void data.delete(key),
      setItem: (key, value) => void data.set(key, value),
    };
  }

  it('remembers the page and viewports per file and ignores damaged values', () => {
    const storage = fakeStorage();
    expect(loadSession('doc', storage)).toEqual({});
    saveSession('doc', { pageId: 'p1', viewports: { p1: { x: 1, y: 2, zoom: 3 } } }, storage);
    expect(loadSession('doc', storage)).toEqual({ pageId: 'p1', viewports: { p1: { x: 1, y: 2, zoom: 3 } } });
    expect(loadSession('other', storage)).toEqual({});

    storage.setItem('open-design:session:bad', '{"pageId":5,"viewports":{"p":{"x":"a","y":0,"zoom":1},"q":{"x":0,"y":0,"zoom":0}}}');
    expect(loadSession('bad', storage)).toEqual({ pageId: undefined, viewports: {} });
    storage.setItem('open-design:session:worse', 'not json');
    expect(loadSession('worse', storage)).toEqual({});
  });

  it('an editor store starts on the remembered page and view', () => {
    const { doc } = sampleDocument();
    const pageId = (getPages(doc)[0] as { id: NodeId }).id;
    const store = createEditorStore(doc, { pageId, viewports: { [pageId]: { x: 7, y: 8, zoom: 2 } } });
    expect(store.getState().viewport).toEqual({ x: 7, y: 8, zoom: 2 });
    // A remembered page that no longer exists falls back to the first page.
    const other = createEditorStore(doc, { pageId: 'gone' });
    expect(other.getState().pageId).toBe(pageId);
  });
});
