import { describe, expect, it } from 'vitest';
import {
  addLayer,
  applyStyle,
  bindVariable,
  createCollection,
  createComponent,
  createComponentSet,
  createDocument,
  createInstance,
  createStyle,
  createVariable,
  CURRENT_SCHEMA_VERSION,
  deleteStyle,
  deleteVariable,
  getLayer,
  getLibraryPages,
  getPages,
  hasUnpublishedChanges,
  importLibrary,
  libraryOf,
  listComponents,
  listLibraries,
  mirrorId,
  parseFile,
  patchNode,
  publishLibrary,
  removeLibrary,
  repairDocument,
  setVariableValue,
  solidPaint,
  unpublishLibrary,
  updateStyle,
  updateVariable,
  type Document,
  type FrameNode,
  type LayerNode,
  type LayerPatch,
  type LayerType,
  type NodeId,
  type Publication,
  type SolidPaint,
  type TextNode,
} from './core';
import { saveDocument } from './persistence/files';
import { listPublishedLibraries, loadLibrary } from './persistence/libraries';
import { MemoryStorage } from './persistence/storage';
import { createEditorStore, type EditorStore } from './state/editorStore';

/**
 * Libraries: one file publishes, another adds what was published and uses
 * it. Both are edited through an editor store, and what goes from one to
 * the other goes through storage, as in the application.
 */

const RED = { r: 1, g: 0, b: 0 };
const GREEN = { r: 0, g: 1, b: 0 };
const BLUE = { r: 0, g: 0, b: 1 };
const WHITE = { r: 1, g: 1, b: 1 };
const AT = '2026-11-16T12:00:00.000Z';

const now = (store: EditorStore): Document => store.getState().doc;
const act = (store: EditorStore, fn: (doc: Document) => Document): void => store.getState().apply('Edit', fn);
const layer = (store: EditorStore, id: NodeId): LayerNode => getLayer(now(store), id) as LayerNode;
const fill = (store: EditorStore, id: NodeId) => (layer(store, id).fills[0] as SolidPaint).color;
const pageOf = (store: EditorStore): NodeId => (getPages(now(store))[0] as { id: NodeId }).id;

function add(store: EditorStore, type: LayerType, parentId: NodeId, props: LayerPatch): NodeId {
  let id = '';
  act(store, (doc) => {
    const out = addLayer(doc, type, parentId, props);
    id = out.id;
    return out.doc;
  });
  return id;
}

function make(store: EditorStore, fn: (doc: Document) => { doc: Document; id: string } | null): string {
  let id = '';
  act(store, (doc) => {
    const out = fn(doc) as { doc: Document; id: string };
    id = out.id;
    return out.doc;
  });
  return id;
}

interface Kit {
  store: EditorStore;
  id: string;
  button: NodeId;
  label: NodeId;
  style: string;
  ink: string;
  mode: string;
}

/** A library file: a button component whose background uses a colour style and whose label is bound to a colour variable. */
function kit(): Kit {
  const store = createEditorStore(createDocument('Kit'));
  const pageId = pageOf(store);
  const button = add(store, 'FRAME', pageId, { x: 0, y: 0, width: 120, height: 40, name: 'Button', fills: [solidPaint(BLUE)] });
  const label = add(store, 'TEXT', button, { x: 10, y: 10, characters: 'OK', name: 'Label', fills: [solidPaint(WHITE)] });
  act(store, (doc) => (createComponent(doc, [button]) as { doc: Document }).doc);
  const style = make(store, (doc) => createStyle(doc, button, 'fills', 'Brand'));
  const collection = make(store, (doc) => createCollection(doc, 'Theme'));
  const ink = make(store, (doc) => createVariable(doc, collection, 'COLOR', 'ink', WHITE));
  act(store, (doc) => bindVariable(doc, [label], 'fills.0', ink));
  const mode = (now(store).variableCollections[collection] as { modes: { id: string }[] }).modes[0]!.id;
  return { store, id: now(store).id, button, label, style, ink, mode };
}

/** Publishes a file and saves it; then reads what it published back from storage. */
async function publish(storage: MemoryStorage, store: EditorStore): Promise<{ id: string; name: string; publication: Publication }> {
  act(store, (doc) => publishLibrary(doc, AT));
  await saveDocument(storage, now(store), AT);
  return (await loadLibrary(storage, now(store).id)) as { id: string; name: string; publication: Publication };
}

describe('libraries', () => {
  it('publishes a file, and says when it has changes that are not published', async () => {
    const storage = new MemoryStorage();
    const k = kit();
    expect(now(k.store).publication).toBeNull();
    expect(hasUnpublishedChanges(now(k.store))).toBe(true);
    const published = await publish(storage, k.store);
    expect(published.publication).toMatchObject({ version: 1, publishedAt: AT, roots: [k.button] });
    expect(Object.keys(published.publication.nodes).sort()).toEqual([k.button, k.label].sort());
    expect(Object.keys(published.publication.styles)).toEqual([k.style]);
    expect(Object.keys(published.publication.variables)).toEqual([k.ink]);
    expect(hasUnpublishedChanges(now(k.store))).toBe(false);
    // Publishing again with nothing changed is not a new version; a change is.
    expect(publishLibrary(now(k.store), AT)).toBe(now(k.store));
    act(k.store, (doc) => patchNode(doc, k.button, { cornerRadius: 8 }));
    expect(hasUnpublishedChanges(now(k.store))).toBe(true);
    // What was published is as it was until it is published again.
    expect((now(k.store).publication?.nodes[k.button] as FrameNode).cornerRadius).toBe(0);
    act(k.store, (doc) => publishLibrary(doc, AT));
    expect(now(k.store).publication?.version).toBe(2);
    // Publishing is an undo step like any other.
    k.store.getState().undo();
    expect(now(k.store).publication?.version).toBe(1);
    k.store.getState().redo();
    // The list of libraries has the published files, not the one that asks and not unpublished ones.
    await saveDocument(storage, now(k.store), AT);
    const other = createEditorStore(createDocument('Design'));
    await saveDocument(storage, now(other), AT);
    expect(await listPublishedLibraries(storage, now(other).id)).toEqual([{ id: k.id, name: 'Kit', version: 2, publishedAt: AT, components: 1, styles: 1, variables: 1 }]);
    expect(await listPublishedLibraries(storage, k.id)).toEqual([]);
    act(k.store, unpublishLibrary);
    await saveDocument(storage, now(k.store), AT);
    expect(await listPublishedLibraries(storage)).toEqual([]);
    expect(await loadLibrary(storage, k.id)).toBeNull();
    // An empty file has nothing to publish.
    expect(publishLibrary(now(other), AT)).toBe(now(other));
  });

  it('adds a library to another file: its components, styles and variables are used there and cannot be changed there', async () => {
    const storage = new MemoryStorage();
    const k = kit();
    const library = await publish(storage, k.store);
    const store = createEditorStore(createDocument('Design'));
    const pageId = pageOf(store);
    act(store, (doc) => importLibrary(doc, library));

    expect(listLibraries(now(store))).toEqual([{ id: k.id, name: 'Kit', version: 1 }]);
    // The library's page is not one of the document's pages.
    expect(getPages(now(store))).toHaveLength(1);
    expect(getLibraryPages(now(store))).toHaveLength(1);
    const button = mirrorId(k.id, k.button);
    const style = mirrorId(k.id, k.style);
    const ink = mirrorId(k.id, k.ink);
    expect(listComponents(now(store)).map((component) => component.id)).toEqual([button]);
    expect(libraryOf(now(store), button)).toMatchObject({ id: k.id, name: 'Kit' });
    expect(now(store).styles[style]).toMatchObject({ name: 'Brand', remote: k.id });
    expect(now(store).variables[ink]).toMatchObject({ name: 'ink', remote: k.id });
    // It is never shown.
    store.getState().setPage(getLibraryPages(now(store))[0]!.id);
    expect(store.getState().pageId).toBe(pageId);

    // An instance of the library's component, a layer with its style, a layer bound to its variable.
    const instance = make(store, (doc) => createInstance(doc, button, { parentId: pageId, at: { x: 0, y: 0 } }));
    const label = mirrorId(instance, mirrorId(k.id, k.label));
    expect(layer(store, instance)).toMatchObject({ kind: 'INSTANCE', width: 120, height: 40, styleRefs: { fills: style } });
    expect(fill(store, instance)).toEqual(BLUE);
    expect((layer(store, label) as TextNode).characters).toBe('OK');
    expect(layer(store, label).boundVariables).toEqual({ 'fills.0': ink });
    const box = add(store, 'RECTANGLE', pageId, { x: 200, y: 0, width: 50, height: 50, fills: [solidPaint(RED)], strokes: [solidPaint(RED)] });
    act(store, (doc) => bindVariable(applyStyle(doc, [box], 'fills', style), [box], 'strokes.0', ink));
    expect(fill(store, box)).toEqual(BLUE);
    expect((layer(store, box).strokes[0] as SolidPaint).color).toEqual(WHITE);

    // What came from the library is changed in the library.
    const doc = now(store);
    expect(updateStyle(doc, style, { paints: [solidPaint(RED)] })).toBe(doc);
    expect(deleteStyle(doc, style)).toBe(doc);
    expect(setVariableValue(doc, ink, k.mode, RED)).toBe(doc);
    expect(updateVariable(doc, ink, { name: 'other' })).toBe(doc);
    expect(deleteVariable(doc, ink)).toBe(doc);
    expect(createVariable(doc, doc.variables[ink]!.collectionId, 'COLOR')).toBeNull();
    // A file cannot add itself, and adding is one undo step.
    expect(importLibrary(now(k.store), library)).toBe(now(k.store));
    // It is all in the file: saved and opened again, nothing is missing.
    const reopened = repairDocument(JSON.parse(JSON.stringify(now(store))));
    expect(reopened.repairs).toEqual([]);
    expect(reopened.doc).toEqual(now(store));
  });

  it('takes a new version of a library: instances, styled and bound layers follow, and overrides stay', async () => {
    const storage = new MemoryStorage();
    const k = kit();
    const store = createEditorStore(createDocument('Design'));
    const pageId = pageOf(store);
    let kitLibrary = await publish(storage, k.store);
    act(store, (doc) => importLibrary(doc, kitLibrary));
    const button = mirrorId(k.id, k.button);
    const style = mirrorId(k.id, k.style);
    const ink = mirrorId(k.id, k.ink);
    const instance = make(store, (doc) => createInstance(doc, button, { parentId: pageId, at: { x: 0, y: 0 } }));
    const label = mirrorId(instance, mirrorId(k.id, k.label));
    const box = add(store, 'RECTANGLE', pageId, { x: 200, y: 0, width: 50, height: 50, fills: [solidPaint(RED)], strokes: [solidPaint(RED)] });
    act(store, (doc) => bindVariable(applyStyle(doc, [box], 'fills', style), [box], 'strokes.0', ink));
    // Something changed in the instance here.
    act(store, (doc) => patchNode(doc, label, { characters: 'Save' } as LayerPatch));
    expect((layer(store, instance) as FrameNode).overrides).toEqual({ [mirrorId(k.id, k.label)]: { characters: 'Save' } });

    // The library changes: a wider, green button with a second layer, and another ink.
    const icon = add(k.store, 'ELLIPSE', k.button, { x: 100, y: 12, width: 16, height: 16, name: 'Icon', fills: [solidPaint(RED)] });
    act(k.store, (doc) => setVariableValue(updateStyle(patchNode(doc, k.button, { width: 160 }), k.style, { paints: [solidPaint(GREEN)] }), k.ink, k.mode, RED));
    // Nothing reaches the other file until the library is published and the file takes the new version.
    await saveDocument(storage, now(k.store), AT);
    expect((await loadLibrary(storage, k.id))?.publication.version).toBe(1);
    kitLibrary = await publish(storage, k.store);
    expect(kitLibrary.publication.version).toBe(2);
    expect(fill(store, instance)).toEqual(BLUE);

    const before = now(store);
    act(store, (doc) => importLibrary(doc, kitLibrary));
    expect(listLibraries(now(store))).toEqual([{ id: k.id, name: 'Kit', version: 2 }]);
    expect(layer(store, instance)).toMatchObject({ width: 160 });
    expect(fill(store, instance)).toEqual(GREEN);
    expect(fill(store, box)).toEqual(GREEN);
    expect((layer(store, box).strokes[0] as SolidPaint).color).toEqual(RED);
    expect(fill(store, label)).toEqual(RED);
    expect(layer(store, mirrorId(instance, mirrorId(k.id, icon)))).toMatchObject({ type: 'ELLIPSE', x: 100 });
    // The override made here is still there.
    expect((layer(store, label) as TextNode).characters).toBe('Save');
    // Taking a new version is one undo step.
    store.getState().undo();
    expect(now(store)).toEqual(before);
    store.getState().redo();

    // The library drops its style and its variable: the layers keep the look and lose the reference.
    act(k.store, (doc) => deleteVariable(deleteStyle(doc, k.style), k.ink));
    act(store, (doc) => importLibrary(doc, { ...kitLibrary, publication: { ...(publishLibrary(now(k.store), AT).publication as Publication) } }));
    expect(now(store).styles).toEqual({});
    expect(now(store).variables).toEqual({});
    expect(layer(store, box)).toMatchObject({ styleRefs: {}, boundVariables: {} });
    expect(fill(store, box)).toEqual(GREEN);
    expect(fill(store, instance)).toEqual(GREEN);

    // Removing the library: its instances become frames with the layers they had.
    act(store, (doc) => removeLibrary(doc, k.id));
    expect(listLibraries(now(store))).toEqual([]);
    expect(listComponents(now(store))).toEqual([]);
    expect(layer(store, instance)).toMatchObject({ kind: 'FRAME', componentId: null, width: 160 });
    expect(layer(store, label)).toMatchObject({ characters: 'Save', sourceId: null });
    store.getState().undo();
    expect(layer(store, instance)).toMatchObject({ kind: 'INSTANCE', componentId: button });
  });

  it('publishes the components a component uses, variants, and works for a copy of the library file', async () => {
    const storage = new MemoryStorage();
    const k = kit();
    const kitLibrary = await publish(storage, k.store);
    // A second library that builds on the first: a card with the first's button in it, and a set of two variants.
    const cards = createEditorStore(createDocument('Cards'));
    const cardsPage = pageOf(cards);
    act(cards, (doc) => importLibrary(doc, kitLibrary));
    const card = add(cards, 'FRAME', cardsPage, { x: 0, y: 0, width: 200, height: 120, name: 'Card', fills: [solidPaint(WHITE)] });
    make(cards, (doc) => createInstance(doc, mirrorId(k.id, k.button), { parentId: card, at: { x: 10, y: 10 } }));
    act(cards, (doc) => (createComponent(doc, [card]) as { doc: Document }).doc);
    const on = add(cards, 'FRAME', cardsPage, { x: 0, y: 200, width: 40, height: 20, name: 'On', fills: [solidPaint(GREEN)] });
    const off = add(cards, 'FRAME', cardsPage, { x: 0, y: 240, width: 40, height: 20, name: 'Off', fills: [solidPaint(RED)] });
    act(cards, (doc) => (createComponent((createComponent(doc, [on]) as { doc: Document }).doc, [off]) as { doc: Document }).doc);
    const set = make(cards, (doc) => createComponentSet(doc, [on, off]));
    const cardsLibrary = await publish(storage, cards);
    // The card, the set, and the button the card uses (which came from the first library).
    expect(cardsLibrary.publication.roots.slice().sort()).toEqual([card, set, mirrorId(k.id, k.button)].sort());

    const store = createEditorStore(createDocument('Design'));
    const pageId = pageOf(store);
    act(store, (doc) => importLibrary(doc, cardsLibrary));
    const cardsId = now(cards).id;
    const instance = make(store, (doc) => createInstance(doc, mirrorId(cardsId, card), { parentId: pageId, at: { x: 0, y: 0 } }));
    // The button inside the card is there, with its label, though this file never added the first library.
    expect((layer(store, instance) as FrameNode).kind).toBe('INSTANCE');
    const texts = Object.values(now(store).nodes).filter((node) => node.type === 'TEXT' && node.sourceId !== null && libraryOf(now(store), node.id) === null) as TextNode[];
    expect(texts.map((text) => text.characters)).toEqual(['OK']);
    expect(listLibraries(now(store)).map((entry) => entry.name)).toEqual(['Cards']);
    // A variant from the library.
    const toggle = make(store, (doc) => createInstance(doc, mirrorId(cardsId, off), { parentId: pageId, at: { x: 300, y: 0 } }));
    expect(fill(store, toggle)).toEqual(RED);

    // A copy of the library file has the same layer IDs; adding the original to it still keeps the two apart.
    const copy = createEditorStore({ ...now(k.store), id: 'copy-of-kit', name: 'Kit copy', publication: null });
    act(copy, (doc) => importLibrary(doc, kitLibrary));
    expect(listComponents(now(copy)).map((component) => component.id).sort()).toEqual([k.button, mirrorId(k.id, k.button)].sort());
    expect(Object.keys(now(copy).styles).sort()).toEqual([k.style, mirrorId(k.id, k.style)].sort());
  });

  it('opens a version 20 file, where nothing is published or from a library', () => {
    const k = kit();
    const current = now(k.store);
    const v20 = JSON.parse(JSON.stringify(current)) as Record<string, unknown> & { nodes: Record<string, Record<string, unknown>> };
    delete v20.publication;
    for (const id in v20.nodes) delete (v20.nodes[id] as Record<string, unknown>).library;
    for (const table of ['styles', 'variables', 'variableCollections']) for (const id in v20[table] as Record<string, Record<string, unknown>>) delete (v20[table] as Record<string, Record<string, unknown>>)[id]!.remote;
    const parsed = parseFile({ format: 'open-design', schemaVersion: 20, meta: { createdAt: AT, updatedAt: AT }, document: v20 });
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(21);
    expect(parsed.repairs).toEqual([]);
    expect(parsed.file.document).toEqual(current);
    // A published file keeps what it published through saving and opening.
    act(k.store, (doc) => publishLibrary(doc, AT));
    const reopened = repairDocument(JSON.parse(JSON.stringify(now(k.store))));
    expect(reopened.repairs).toEqual([]);
    expect(reopened.doc).toEqual(now(k.store));
    // A file whose only page holds a library gets a page to design on.
    const raw = JSON.parse(JSON.stringify(now(k.store))) as { nodes: Record<string, Record<string, unknown>> };
    for (const id in raw.nodes) if (raw.nodes[id]!.type === 'PAGE') raw.nodes[id]!.library = { id: 'x', name: 'X', version: 1 };
    expect(getPages(repairDocument(raw).doc)).toHaveLength(1);
  });
});
