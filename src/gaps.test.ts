import { describe, expect, it } from 'vitest';
import {
  addLayer,
  createDocument,
  createLayer,
  detachVertex,
  fitVectorNode,
  getPages,
  hitTestDeepest,
  NetworkBuilder,
  networkGeometry,
  patchNode,
  setNodes,
  solidPaint,
  toFile,
  type Document,
  type LayerNode,
  type NodeId,
  type VectorNetwork,
  type VectorNode,
} from './core';
import { freshKeys } from './core/order';
import { InteractionController, type PointerInput } from './engine/input/controller';
import { deleteFile } from './persistence/files';
import { DEFAULT_PREFERENCES, loadPreferences, savePreferences } from './persistence/prefs';
import { MemoryStorage } from './persistence/storage';
import { commandForKey, getCommand, runCommand, type AppActions, type Command } from './state/commands';
import { createEditorStore, type EditorStore } from './state/editorStore';

/**
 * Small gaps left by Phases 1 to 3, closed: hit testing of rounded corners,
 * adding and cutting points, the pixel-grid switch, and tidying up images.
 */

function setup(): { doc: Document; pageId: NodeId } {
  const doc = createDocument('Gaps');
  return { doc, pageId: (getPages(doc)[0] as { id: NodeId }).id };
}

const ptr = (x: number, y: number, mods: Partial<PointerInput> = {}): PointerInput => ({ x, y, button: 0, shiftKey: false, altKey: false, ctrlKey: false, detail: 1, ...mods });

function editor(doc: Document): { store: EditorStore; controller: InteractionController; app: AppActions } {
  const store = createEditorStore(doc);
  store.getState().setCanvasSize({ width: 800, height: 600 });
  const controller = new InteractionController(store, { requestRender: () => undefined, setCursor: () => undefined });
  const app: AppActions = {
    cancelInteraction: () => controller.cancel(),
    openShortcuts: () => undefined,
    saveNow: () => undefined,
    saveAs: () => undefined,
    placeImage: () => undefined,
    goHome: () => undefined,
  };
  return { store, controller, app };
}

const square = (): VectorNetwork => new NetworkBuilder().moveTo(0, 0).lineTo(100, 0).lineTo(100, 100).lineTo(0, 100).close().build();

function withVector(network: VectorNetwork, props: Partial<VectorNode> = {}): { doc: Document; id: NodeId; pageId: NodeId } {
  const { doc, pageId } = setup();
  const bounds = networkGeometry(network).bounds ?? { width: 0, height: 0 };
  const node = createLayer('VECTOR', pageId, freshKeys(1)[0] as string, { width: bounds.width, height: bounds.height, ...props, network }) as VectorNode;
  return { doc: setNodes(doc, { [node.id]: fitVectorNode(node) }), id: node.id, pageId };
}

describe('rounded rectangles', () => {
  it('are selected by their rounded outline, not by their box', () => {
    const { doc, pageId } = setup();
    const made = addLayer(doc, 'RECTANGLE', pageId, { x: 100, y: 100, width: 100, height: 100, cornerRadius: 40 });
    expect(hitTestDeepest(made.doc, pageId, { x: 150, y: 150 })).toBe(made.id);
    // Inside the box but outside the curve of the corner.
    expect(hitTestDeepest(made.doc, pageId, { x: 105, y: 105 })).toBeNull();
    // Inside the curve.
    expect(hitTestDeepest(made.doc, pageId, { x: 120, y: 120 })).toBe(made.id);
    // A square corner is still a corner.
    const mixed = patchNode(made.doc, made.id, { cornerRadii: [40, 0, 0, 0] });
    expect(hitTestDeepest(mixed, pageId, { x: 105, y: 105 })).toBeNull();
    expect(hitTestDeepest(mixed, pageId, { x: 195, y: 105 })).toBe(made.id);
    const sharp = patchNode(made.doc, made.id, { cornerRadius: 0 });
    expect(hitTestDeepest(sharp, pageId, { x: 105, y: 105 })).toBe(made.id);

    // An outline only: caught along the curve of the corner, not at the box's corner.
    const outlined = patchNode(made.doc, made.id, { fills: [], strokes: [solidPaint({ r: 0, g: 0, b: 0 })], strokeWeight: 2 });
    const onArc = { x: 140 - Math.SQRT1_2 * 40, y: 140 - Math.SQRT1_2 * 40 };
    expect(hitTestDeepest(outlined, pageId, onArc, 2)).toBe(made.id);
    expect(hitTestDeepest(outlined, pageId, { x: 101, y: 101 }, 2)).toBeNull();
    expect(hitTestDeepest(outlined, pageId, { x: 150, y: 150 }, 2)).toBeNull();
  });
});

describe('cutting a path and adding points while editing', () => {
  it('cuts the segments that meet at a point apart', () => {
    const opened = detachVertex(square(), 0);
    expect(opened.added).toEqual([4]);
    expect(opened.network.vertices).toHaveLength(5);
    expect(opened.network.vertices[4]).toEqual({ x: 0, y: 0 });
    // The square is now one open path that starts and ends in the same place.
    expect(networkGeometry(opened.network).chains).toHaveLength(1);
    expect(networkGeometry(opened.network).closed).toBe(false);

    // In the middle of an open path: two paths.
    const line = new NetworkBuilder().moveTo(0, 0).lineTo(50, 0).lineTo(100, 0).build();
    expect(networkGeometry(detachVertex(line, 1).network).chains).toHaveLength(2);
    // An end has nothing to be cut from.
    expect(detachVertex(line, 0)).toEqual({ network: line, added: [] });
    // Where three segments meet, each goes its own way.
    const tee = { vertices: [...line.vertices, { x: 50, y: 80 }], segments: [...line.segments, { start: 1, end: 3, tangentStart: { x: 0, y: 0 }, tangentEnd: { x: 0, y: 0 } }] };
    const apart = detachVertex(tee, 1);
    expect(apart.added).toHaveLength(2);
    expect(networkGeometry(apart.network).chains).toHaveLength(3);
  });

  it('cuts at the selected points from the command, and selects the new ends', () => {
    const made = withVector(square(), { x: 100, y: 100 });
    const { store, controller, app } = editor(made.doc);
    store.getState().setVectorEdit({ id: made.id, vertices: [] });
    expect(getCommand('vector.cut')?.enabled?.(store.getState())).toBe(false);
    store.getState().setVectorEdit({ id: made.id, vertices: [2] });
    runCommand(getCommand('vector.cut') as Command, { store, app });
    const state = store.getState();
    expect(state.undoStack.map((entry) => entry.label)).toEqual(['Cut path']);
    expect(state.vectorEdit).toEqual({ id: made.id, vertices: [4] });
    const vector = state.doc.nodes[made.id] as VectorNode;
    expect(networkGeometry(vector.network).closed).toBe(false);
    // The new end can be dragged away from the point it was cut from.
    controller.pointerDown(ptr(200, 200));
    controller.pointerMove(ptr(215, 215));
    controller.pointerMove(ptr(230, 230));
    controller.pointerUp(ptr(230, 230));
    const after = store.getState().doc.nodes[made.id] as VectorNode;
    expect(after.network.vertices[4]).toEqual({ x: 130, y: 130 });
    expect(after.network.vertices[2]).toEqual({ x: 100, y: 100 });
  });

  it('adds a point where a segment is double-clicked', () => {
    const made = withVector(square(), { x: 100, y: 100 });
    const { store, controller } = editor(made.doc);
    store.getState().setVectorEdit({ id: made.id, vertices: [] });
    controller.pointerDown(ptr(150, 101));
    controller.pointerUp(ptr(150, 101));
    expect(store.getState().undoStack).toEqual([]);
    controller.pointerDown(ptr(150, 101, { detail: 2 }));
    controller.pointerUp(ptr(150, 101, { detail: 2 }));
    const state = store.getState();
    const vector = state.doc.nodes[made.id] as VectorNode;
    expect(vector.network.vertices).toHaveLength(5);
    expect(vector.network.vertices[4]).toEqual({ x: 50, y: 0 });
    expect(state.vectorEdit?.vertices).toEqual([4]);
    expect(state.undoStack.map((entry) => entry.label)).toEqual(['Add point']);
    expect(networkGeometry(vector.network).closed).toBe(true);
    expect(vector).toMatchObject({ width: 100, height: 100 });
  });
});

describe('snapping to the pixel grid', () => {
  const key = { code: 'Quote', ctrlKey: true, shiftKey: false, altKey: true, metaKey: false };

  /** Draws a rectangle with the pointer at four times magnification, where one screen pixel is a quarter of a unit. */
  function draw(pixelSnap: boolean): { store: EditorStore; controller: InteractionController; node: LayerNode } {
    const { store, controller } = editor(createDocument('Pixels'));
    store.getState().setViewport({ x: 0, y: 0, zoom: 4 });
    store.getState().setPixelSnap(pixelSnap);
    store.getState().setSnapping(false);
    store.getState().setTool('rectangle');
    controller.pointerDown(ptr(41, 43));
    controller.pointerMove(ptr(100, 100));
    controller.pointerMove(ptr(163, 170));
    controller.pointerUp(ptr(163, 170));
    const state = store.getState();
    return { store, controller, node: state.doc.nodes[state.selection[0] as NodeId] as LayerNode };
  }

  it('puts new layers on whole pixels while it is on', () => {
    expect(draw(true).node).toMatchObject({ x: 10, y: 11, width: 31, height: 32 });
  });

  it('leaves them where the pointer was when it is off', () => {
    const { store, controller, node } = draw(false);
    expect(node).toMatchObject({ x: 10.25, y: 10.75, width: 30.5, height: 31.75 });
    // Moving and resizing keep fractions too.
    controller.pointerDown(ptr(100, 100));
    controller.pointerMove(ptr(110, 100));
    controller.pointerMove(ptr(121, 106));
    controller.pointerUp(ptr(121, 106));
    expect(store.getState().doc.nodes[node.id]).toMatchObject({ x: 15.5, y: 12.25 });
    store.getState().setPixelSnap(true);
    controller.pointerDown(ptr(121, 106));
    controller.pointerMove(ptr(130, 110));
    controller.pointerMove(ptr(142, 106));
    controller.pointerUp(ptr(142, 106));
    // With the grid back on, the layer lands on whole pixels again.
    expect(store.getState().doc.nodes[node.id]).toMatchObject({ x: 21, y: 12 });
  });

  it('is a preference with a menu item and a shortcut, remembered on this device', () => {
    const { store, app } = editor(createDocument('Pixels'));
    const command = commandForKey(key);
    expect(command?.id).toBe('view.pixelSnap');
    expect(command?.checked?.(store.getState())).toBe(true);
    runCommand(command as Command, { store, app });
    expect(store.getState().pixelSnap).toBe(false);
    expect(command?.checked?.(store.getState())).toBe(false);

    const data = new Map<string, string>();
    const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) } as unknown as Storage;
    expect(loadPreferences(storage).pixelSnap).toBe(true);
    savePreferences({ ...DEFAULT_PREFERENCES, pixelSnap: false }, storage);
    expect(loadPreferences(storage)).toEqual({ ...DEFAULT_PREFERENCES, pixelSnap: false });
    expect(createEditorStore(createDocument('P'), undefined, loadPreferences(storage)).getState().pixelSnap).toBe(false);
  });
});

describe('deleting a file', () => {
  const hash = (letter: string): string => letter.repeat(64);
  const info = { mimeType: 'image/png', width: 10, height: 10, name: 'image.png' };
  const bytes = (): ArrayBuffer => new Uint8Array([1, 2, 3]).buffer;

  it('removes the images only that file knew about', async () => {
    const storage = new MemoryStorage();
    const now = '2026-11-16T12:00:00.000Z';
    const first: Document = { ...createDocument('First'), assets: { [hash('a')]: info, [hash('b')]: info } };
    const second: Document = { ...createDocument('Second'), assets: { [hash('b')]: info, [hash('c')]: info } };
    await storage.save(toFile(first, { createdAt: now, updatedAt: now }));
    await storage.save(toFile(second, { createdAt: now, updatedAt: now }));
    for (const letter of ['a', 'b', 'c']) await storage.saveAsset(hash(letter), { mimeType: 'image/png', bytes: bytes() });

    expect(await deleteFile(storage, first.id)).toBe(1);
    expect(await storage.load(first.id)).toBeNull();
    expect(await storage.loadAsset(hash('a'))).toBeNull();
    // Still listed by the other file, so still there.
    expect(await storage.loadAsset(hash('b'))).not.toBeNull();
    expect(await storage.loadAsset(hash('c'))).not.toBeNull();

    expect(await deleteFile(storage, second.id)).toBe(2);
    expect(await storage.loadAsset(hash('b'))).toBeNull();
    expect(await storage.loadAsset(hash('c'))).toBeNull();
    // A file that is not there, or that used no images, removes nothing.
    expect(await deleteFile(storage, 'nothing')).toBe(0);
    const plain = createDocument('Plain');
    await storage.save(toFile(plain, { createdAt: now, updatedAt: now }));
    expect(await deleteFile(storage, plain.id)).toBe(0);
    expect(await storage.list()).toEqual([]);
  });
});
