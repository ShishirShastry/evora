import { describe, expect, it } from 'vitest';
import {
  addLayer,
  createDocument,
  getChildIds,
  getLayer,
  getPages,
  getWorldBounds,
  patchNode,
  worldCenterOf,
  type LayerNode,
  type NodeId,
} from '../core';
import { InteractionController, type PointerInput } from '../engine/input/controller';
import { screenToWorld } from '../engine/viewport';
import {
  clearClipboard,
  COMMANDS,
  commandForKey,
  copyPage,
  copySelection,
  createPage,
  cutSelection,
  deleteSelection,
  duplicateSelection,
  nudgeSelection,
  paste,
  removePage,
  reorderSelection,
  selectAll,
  setZoom,
  toggleLocked,
  toggleVisible,
  zoomToFit,
  zoomToSelection,
} from './commands';
import { createEditorStore, HISTORY_LIMIT, type EditorStore, type ToolId } from './editorStore';

/**
 * These tests drive the real store and the real interaction controller with
 * pointer sequences, exactly as the canvas does. The default viewport maps
 * screen pixels one-to-one onto page units, so coordinates read naturally.
 */

function setup(): { store: EditorStore; controller: InteractionController; pageId: NodeId; cursors: string[] } {
  const store = createEditorStore(createDocument('Test'));
  store.getState().setCanvasSize({ width: 800, height: 600 });
  const cursors: string[] = [];
  const controller = new InteractionController(store, {
    requestRender: () => undefined,
    setCursor: (cursor) => cursors.push(cursor),
  });
  return { store, controller, pageId: store.getState().pageId, cursors };
}

function ptr(x: number, y: number, extra: Partial<PointerInput> = {}): PointerInput {
  return { x, y, button: 0, shiftKey: false, altKey: false, ctrlKey: false, detail: 1, ...extra };
}

function drag(
  controller: InteractionController,
  from: [number, number],
  to: [number, number],
  extra: Partial<PointerInput> = {},
): void {
  controller.pointerDown(ptr(from[0], from[1], extra));
  controller.pointerMove(ptr((from[0] + to[0]) / 2, (from[1] + to[1]) / 2, extra));
  controller.pointerMove(ptr(to[0], to[1], extra));
  controller.pointerUp(ptr(to[0], to[1], extra));
}

function click(controller: InteractionController, at: [number, number], extra: Partial<PointerInput> = {}): void {
  controller.pointerDown(ptr(at[0], at[1], extra));
  controller.pointerUp(ptr(at[0], at[1], extra));
}

function draw(store: EditorStore, controller: InteractionController, tool: ToolId, from: [number, number], to: [number, number], extra: Partial<PointerInput> = {}): LayerNode {
  store.getState().setTool(tool);
  drag(controller, from, to, extra);
  const id = store.getState().selection[0];
  const node = getLayer(store.getState().doc, id);
  if (!node) throw new Error('nothing was drawn');
  return node;
}

function layersOnPage(store: EditorStore): LayerNode[] {
  const { doc, pageId } = store.getState();
  return getChildIds(doc, pageId).map((id) => doc.nodes[id] as LayerNode);
}

describe('drawing shapes', () => {
  it('draws a rectangle by dragging, as one undoable step', () => {
    const { store, controller } = setup();
    const rect = draw(store, controller, 'rectangle', [100, 100], [220, 180]);
    expect(rect).toMatchObject({ type: 'RECTANGLE', x: 100, y: 100, width: 120, height: 80, name: 'Rectangle 1' });
    expect(store.getState().tool).toBe('move');
    expect(store.getState().selection).toEqual([rect.id]);
    expect(store.getState().undoStack.map((entry) => entry.label)).toEqual(['Create rectangle']);

    store.getState().undo();
    expect(layersOnPage(store)).toEqual([]);
    expect(store.getState().selection).toEqual([]);
    store.getState().redo();
    expect(layersOnPage(store)).toHaveLength(1);
    expect(store.getState().selection).toEqual([rect.id]);
  });

  it('draws in any direction', () => {
    const { store, controller } = setup();
    const rect = draw(store, controller, 'rectangle', [300, 300], [200, 250]);
    expect(rect).toMatchObject({ x: 200, y: 250, width: 100, height: 50 });
  });

  it('creates a default-sized shape on a plain click', () => {
    const { store, controller } = setup();
    store.getState().setTool('ellipse');
    click(controller, [50, 60]);
    expect(layersOnPage(store)[0]).toMatchObject({ type: 'ELLIPSE', x: 50, y: 60, width: 100, height: 100 });
  });

  it('constrains to a square with Shift and draws from the centre with Alt', () => {
    const { store, controller } = setup();
    expect(draw(store, controller, 'rectangle', [100, 100], [200, 140], { shiftKey: true })).toMatchObject({ width: 100, height: 100 });
    expect(draw(store, controller, 'rectangle', [400, 300], [450, 320], { altKey: true })).toMatchObject({
      x: 350, y: 280, width: 100, height: 40,
    });
  });

  it('draws every Phase 1 shape type with its own properties', () => {
    const { store, controller } = setup();
    expect(draw(store, controller, 'frame', [0, 0], [100, 100])).toMatchObject({ type: 'FRAME', clipsContent: true });
    expect(draw(store, controller, 'polygon', [200, 0], [300, 100])).toMatchObject({ type: 'POLYGON', pointCount: 3 });
    expect(draw(store, controller, 'star', [400, 0], [500, 100])).toMatchObject({ type: 'STAR', pointCount: 5 });
    const line = draw(store, controller, 'line', [0, 300], [0, 400]);
    expect(line).toMatchObject({ type: 'LINE', width: 100, height: 0, rotation: 90 });
  });

  it('puts a shape drawn over a frame inside that frame', () => {
    const { store, controller } = setup();
    const frame = draw(store, controller, 'frame', [100, 100], [500, 400]);
    const rect = draw(store, controller, 'rectangle', [150, 160], [250, 260]);
    expect(rect).toMatchObject({ parentId: frame.id, x: 50, y: 60 });
    const outside = draw(store, controller, 'rectangle', [600, 100], [700, 200]);
    expect(outside.parentId).toBe(store.getState().pageId);
  });

  it('cancelling a draw leaves no trace', () => {
    const { store, controller } = setup();
    store.getState().setTool('rectangle');
    controller.pointerDown(ptr(100, 100));
    controller.pointerMove(ptr(200, 200));
    expect(layersOnPage(store)).toHaveLength(1);
    expect(controller.cancel()).toBe(true);
    expect(layersOnPage(store)).toEqual([]);
    expect(store.getState().undoStack).toEqual([]);
    expect(store.getState().tool).toBe('move');
  });
});

describe('selecting', () => {
  it('selects on click, adds with Shift and clears on empty canvas', () => {
    const { store, controller } = setup();
    const a = draw(store, controller, 'rectangle', [0, 0], [100, 100]);
    const b = draw(store, controller, 'rectangle', [200, 0], [300, 100]);
    click(controller, [50, 50]);
    expect(store.getState().selection).toEqual([a.id]);
    click(controller, [250, 50], { shiftKey: true });
    expect(store.getState().selection).toEqual([a.id, b.id]);
    click(controller, [250, 50], { shiftKey: true });
    expect(store.getState().selection).toEqual([a.id]);
    click(controller, [600, 500]);
    expect(store.getState().selection).toEqual([]);
  });

  it('reduces a multi-selection to one layer on a plain click', () => {
    const { store, controller } = setup();
    const a = draw(store, controller, 'rectangle', [0, 0], [100, 100]);
    const b = draw(store, controller, 'rectangle', [200, 0], [300, 100]);
    store.getState().setSelection([a.id, b.id]);
    click(controller, [250, 50]);
    expect(store.getState().selection).toEqual([b.id]);
  });

  it('selects with a marquee and extends it with Shift', () => {
    const { store, controller } = setup();
    const a = draw(store, controller, 'rectangle', [0, 0], [100, 100]);
    const b = draw(store, controller, 'rectangle', [200, 0], [300, 100]);
    const c = draw(store, controller, 'rectangle', [0, 300], [100, 400]);
    drag(controller, [350, 150], [50, 50]);
    expect(store.getState().selection).toEqual([a.id, b.id]);
    expect(controller.marquee).toBeNull();
    drag(controller, [150, 450], [50, 350], { shiftKey: true });
    expect(store.getState().selection).toEqual([a.id, b.id, c.id]);
    expect(store.getState().undoStack).toHaveLength(3); // selecting is not an edit
  });

  it('goes one level deeper on double-click and all the way with Ctrl', () => {
    const { store, controller } = setup();
    const outer = draw(store, controller, 'frame', [0, 0], [400, 400]);
    const inner = draw(store, controller, 'frame', [50, 50], [250, 250]);
    const rect = draw(store, controller, 'rectangle', [60, 60], [160, 160]);
    click(controller, [600, 500]);
    click(controller, [100, 100]);
    expect(store.getState().selection).toEqual([inner.id]);
    click(controller, [100, 100], { detail: 2 });
    expect(store.getState().selection).toEqual([rect.id]);
    click(controller, [600, 500]);
    click(controller, [100, 100], { ctrlKey: true });
    expect(store.getState().selection).toEqual([rect.id]);
    expect(outer.parentId).toBe(store.getState().pageId);
  });

  it('shows what would be selected while hovering', () => {
    const { store, controller } = setup();
    const a = draw(store, controller, 'rectangle', [0, 0], [100, 100]);
    click(controller, [600, 500]);
    controller.pointerMove(ptr(50, 50));
    expect(store.getState().hoveredId).toBe(a.id);
    controller.pointerMove(ptr(500, 500));
    expect(store.getState().hoveredId).toBeNull();
  });
});

describe('moving', () => {
  it('moves the selection by dragging, as one undoable step', () => {
    const { store, controller } = setup();
    const rect = draw(store, controller, 'rectangle', [100, 100], [200, 200]);
    drag(controller, [150, 150], [190, 120]);
    expect(getLayer(store.getState().doc, rect.id)).toMatchObject({ x: 140, y: 70 });
    expect(store.getState().undoStack.map((entry) => entry.label)).toEqual(['Create rectangle', 'Move']);
    store.getState().undo();
    expect(getLayer(store.getState().doc, rect.id)).toMatchObject({ x: 100, y: 100 });
  });

  it('does not record history for a click that did not move anything', () => {
    const { store, controller } = setup();
    draw(store, controller, 'rectangle', [100, 100], [200, 200]);
    click(controller, [150, 150]);
    controller.pointerDown(ptr(150, 150));
    controller.pointerMove(ptr(151, 151));
    controller.pointerUp(ptr(151, 151));
    expect(store.getState().undoStack).toHaveLength(1);
  });

  it('constrains to one axis with Shift', () => {
    const { store, controller } = setup();
    const rect = draw(store, controller, 'rectangle', [100, 100], [200, 200]);
    drag(controller, [150, 150], [250, 170], { shiftKey: true });
    expect(getLayer(store.getState().doc, rect.id)).toMatchObject({ x: 200, y: 100 });
  });

  it('duplicates with Alt-drag, leaving the original in place', () => {
    const { store, controller } = setup();
    const rect = draw(store, controller, 'rectangle', [100, 100], [200, 200]);
    drag(controller, [150, 150], [350, 150], { altKey: true });
    const all = layersOnPage(store);
    expect(all).toHaveLength(2);
    expect(getLayer(store.getState().doc, rect.id)).toMatchObject({ x: 100, y: 100 });
    const copyId = store.getState().selection[0] as NodeId;
    expect(copyId).not.toBe(rect.id);
    expect(getLayer(store.getState().doc, copyId)).toMatchObject({ x: 300, y: 100 });
    store.getState().undo();
    expect(layersOnPage(store)).toHaveLength(1);
  });

  it('Escape during a drag puts everything back', () => {
    const { store, controller } = setup();
    const rect = draw(store, controller, 'rectangle', [100, 100], [200, 200]);
    controller.pointerDown(ptr(150, 150));
    controller.pointerMove(ptr(300, 300));
    expect(getLayer(store.getState().doc, rect.id)?.x).toBe(250);
    controller.cancel();
    expect(getLayer(store.getState().doc, rect.id)).toMatchObject({ x: 100, y: 100 });
    expect(store.getState().undoStack).toHaveLength(1);
  });

  it('nests a layer dropped on a frame and un-nests it when dragged out, keeping its page position', () => {
    const { store, controller } = setup();
    const frame = draw(store, controller, 'frame', [300, 100], [700, 500]);
    const rect = draw(store, controller, 'rectangle', [50, 100], [150, 200]);
    expect(rect.parentId).toBe(store.getState().pageId);

    drag(controller, [100, 150], [400, 250]);
    expect(getLayer(store.getState().doc, rect.id)).toMatchObject({ parentId: frame.id, x: 50, y: 100 });
    expect(getWorldBounds(store.getState().doc, rect.id)).toMatchObject({ x: 350, y: 200 });

    drag(controller, [400, 250], [100, 150]);
    expect(getLayer(store.getState().doc, rect.id)).toMatchObject({ parentId: store.getState().pageId, x: 50, y: 100 });
  });

  it('does not move locked layers', () => {
    const { store, controller } = setup();
    const rect = draw(store, controller, 'rectangle', [100, 100], [200, 200]);
    toggleLocked(store);
    // A locked layer can still be selected from the layers panel.
    store.getState().setSelection([rect.id]);
    drag(controller, [150, 150], [300, 300]);
    expect(getLayer(store.getState().doc, rect.id)).toMatchObject({ x: 100, y: 100, locked: true });
  });

  it('nudges with the arrow keys', () => {
    const { store, controller } = setup();
    const rect = draw(store, controller, 'rectangle', [100, 100], [200, 200]);
    nudgeSelection(store, 1, 0);
    nudgeSelection(store, 0, -10);
    expect(getLayer(store.getState().doc, rect.id)).toMatchObject({ x: 101, y: 90 });
  });
});

describe('resizing and rotating with handles', () => {
  it('resizes from a corner handle', () => {
    const { store, controller } = setup();
    const rect = draw(store, controller, 'rectangle', [100, 100], [200, 200]);
    drag(controller, [200, 200], [260, 240]);
    expect(getLayer(store.getState().doc, rect.id)).toMatchObject({ x: 100, y: 100, width: 160, height: 140 });
    expect(store.getState().undoStack.at(-1)?.label).toBe('Resize');
  });

  it('resizes from an edge handle and from the top-left corner', () => {
    const { store, controller } = setup();
    const rect = draw(store, controller, 'rectangle', [100, 100], [200, 200]);
    drag(controller, [200, 150], [250, 150]);
    expect(getLayer(store.getState().doc, rect.id)).toMatchObject({ x: 100, width: 150, height: 100 });
    drag(controller, [100, 100], [80, 60]);
    expect(getLayer(store.getState().doc, rect.id)).toMatchObject({ x: 80, y: 60, width: 170, height: 140 });
  });

  it('keeps the opposite corner fixed when resizing a rotated layer', () => {
    const { store, controller } = setup();
    const rect = draw(store, controller, 'rectangle', [300, 200], [500, 300]);
    store.getState().apply('Rotate', (doc) => patchNode(doc, rect.id, { rotation: 30 }));
    const doc = store.getState().doc;
    const center = worldCenterOf(doc, rect.id);
    const corner = (dx: number, dy: number, node = getLayer(store.getState().doc, rect.id) as LayerNode, c = center) => {
      const r = (node.rotation * Math.PI) / 180;
      return { x: c.x + dx * Math.cos(r) - dy * Math.sin(r), y: c.y + dx * Math.sin(r) + dy * Math.cos(r) };
    };
    const topLeftBefore = corner(-100, -50);
    const bottomRight = corner(100, 50);
    drag(controller, [bottomRight.x, bottomRight.y], [bottomRight.x + 40, bottomRight.y + 50]);

    const after = getLayer(store.getState().doc, rect.id) as LayerNode;
    expect(after.rotation).toBe(30);
    expect(after.width).not.toBe(200);
    const topLeftAfter = corner(-after.width / 2, -after.height / 2, after, worldCenterOf(store.getState().doc, rect.id));
    expect(topLeftAfter.x).toBeCloseTo(topLeftBefore.x, 1);
    expect(topLeftAfter.y).toBeCloseTo(topLeftBefore.y, 1);
  });

  it('scales a multi-selection together', () => {
    const { store, controller } = setup();
    const a = draw(store, controller, 'rectangle', [100, 100], [200, 200]);
    const b = draw(store, controller, 'rectangle', [200, 200], [300, 300]);
    store.getState().setSelection([a.id, b.id]);
    drag(controller, [300, 300], [500, 300]);
    expect(getLayer(store.getState().doc, a.id)).toMatchObject({ x: 100, y: 100, width: 200, height: 100 });
    expect(getLayer(store.getState().doc, b.id)).toMatchObject({ x: 300, y: 200, width: 200, height: 100 });
  });

  it('rotates by dragging just outside a corner, snapping with Shift', () => {
    const { store, controller } = setup();
    const rect = draw(store, controller, 'rectangle', [200, 200], [400, 300]);
    // 12px outside the top-right corner, then swing a quarter turn about the centre (300, 250).
    controller.pointerDown(ptr(410, 190));
    controller.pointerMove(ptr(360, 380, { shiftKey: true }));
    controller.pointerUp(ptr(360, 380, { shiftKey: true }));
    const after = getLayer(store.getState().doc, rect.id) as LayerNode;
    expect(after.rotation % 15).toBe(0);
    expect(after.rotation).not.toBe(0);
    expect(after).toMatchObject({ x: 200, y: 200, width: 200, height: 100 });
    expect(store.getState().undoStack.at(-1)?.label).toBe('Rotate');
  });

  it('moves one end of a line with its endpoint handle', () => {
    const { store, controller } = setup();
    const line = draw(store, controller, 'line', [100, 100], [200, 100]);
    drag(controller, [200, 100], [100, 200]);
    expect(getLayer(store.getState().doc, line.id)).toMatchObject({ width: 100, height: 0, rotation: 90 });
  });
});

describe('view', () => {
  it('pans with the hand tool, the middle button and Space', () => {
    const { store, controller } = setup();
    store.getState().setTool('hand');
    drag(controller, [400, 300], [300, 250]);
    expect(store.getState().viewport).toEqual({ x: 100, y: 50, zoom: 1 });
    store.getState().setTool('move');
    drag(controller, [400, 300], [500, 350], { button: 1 });
    expect(store.getState().viewport).toEqual({ x: 0, y: 0, zoom: 1 });
    controller.setSpaceDown(true);
    drag(controller, [0, 0], [-40, 0]);
    controller.setSpaceDown(false);
    expect(store.getState().viewport.x).toBe(40);
    expect(store.getState().undoStack).toEqual([]);
  });

  it('zooms around the pointer with Ctrl + wheel and scrolls without it', () => {
    const { store, controller } = setup();
    const before = screenToWorld(store.getState().viewport, { x: 200, y: 150 });
    controller.wheel({ x: 200, y: 150, deltaX: 0, deltaY: -120, ctrlKey: true, shiftKey: false });
    const zoomed = store.getState().viewport;
    expect(zoomed.zoom).toBeGreaterThan(1);
    const after = screenToWorld(zoomed, { x: 200, y: 150 });
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);

    setZoom(store, 1);
    store.getState().setViewport({ x: 0, y: 0, zoom: 1 });
    controller.wheel({ x: 0, y: 0, deltaX: 0, deltaY: 30, ctrlKey: false, shiftKey: false });
    expect(store.getState().viewport).toEqual({ x: 0, y: 30, zoom: 1 });
    controller.wheel({ x: 0, y: 0, deltaX: 0, deltaY: 30, ctrlKey: false, shiftKey: true });
    expect(store.getState().viewport).toEqual({ x: 30, y: 30, zoom: 1 });
  });

  it('zooms to fit the page and to the selection', () => {
    const { store, controller } = setup();
    const rect = draw(store, controller, 'rectangle', [1000, 1000], [3000, 2000]);
    zoomToFit(store);
    const fit = store.getState().viewport;
    expect(fit.zoom).toBeLessThan(1);
    // The rectangle's centre is in the middle of the 800 × 600 canvas.
    const center = screenToWorld(fit, { x: 400, y: 300 });
    expect(center.x).toBeCloseTo(2000);
    expect(center.y).toBeCloseTo(1500);

    const small = draw(store, controller, 'rectangle', [0, 0], [10, 10]);
    store.getState().setSelection([small.id]);
    zoomToSelection(store);
    expect(store.getState().viewport.zoom).toBeGreaterThan(1);
    expect(rect.id).not.toBe(small.id);
  });

  it('remembers each page’s viewport', () => {
    const { store } = setup();
    const first = store.getState().pageId;
    store.getState().setViewport({ x: 10, y: 20, zoom: 2 });
    createPage(store);
    expect(store.getState().pageId).not.toBe(first);
    store.getState().setViewport({ x: -5, y: -5, zoom: 0.5 });
    store.getState().setPage(first);
    expect(store.getState().viewport).toEqual({ x: 10, y: 20, zoom: 2 });
  });
});

describe('commands', () => {
  it('copies and pastes in place, and cuts', () => {
    clearClipboard();
    const { store, controller } = setup();
    const rect = draw(store, controller, 'rectangle', [100, 100], [200, 200]);
    paste(store); // nothing on the clipboard yet
    expect(layersOnPage(store)).toHaveLength(1);

    expect(copySelection(store)).toBe(true);
    paste(store);
    expect(layersOnPage(store)).toHaveLength(2);
    const pasted = getLayer(store.getState().doc, store.getState().selection[0]) as LayerNode;
    expect(pasted.id).not.toBe(rect.id);
    expect(pasted).toMatchObject({ x: 100, y: 100, name: 'Rectangle 1' });

    cutSelection(store);
    expect(layersOnPage(store)).toHaveLength(1);
    paste(store);
    expect(layersOnPage(store)).toHaveLength(2);
  });

  it('pastes into the middle of the view on another page', () => {
    clearClipboard();
    const { store, controller } = setup();
    draw(store, controller, 'rectangle', [100, 100], [200, 200]);
    copySelection(store);
    createPage(store);
    store.getState().setViewport({ x: 1000, y: 1000, zoom: 1 });
    paste(store);
    const pasted = layersOnPage(store)[0] as LayerNode;
    expect(pasted).toMatchObject({ x: 1350, y: 1250 });
  });

  it('duplicates with an offset and selects the copy', () => {
    const { store, controller } = setup();
    const rect = draw(store, controller, 'rectangle', [100, 100], [200, 200]);
    duplicateSelection(store);
    const copy = getLayer(store.getState().doc, store.getState().selection[0]) as LayerNode;
    expect(copy.id).not.toBe(rect.id);
    expect(copy).toMatchObject({ x: 110, y: 110 });
    store.getState().undo();
    expect(layersOnPage(store)).toHaveLength(1);
  });

  it('deletes, reorders, hides and locks the selection', () => {
    const { store, controller } = setup();
    const a = draw(store, controller, 'rectangle', [0, 0], [100, 100]);
    const b = draw(store, controller, 'rectangle', [200, 0], [300, 100]);
    store.getState().setSelection([a.id]);
    reorderSelection(store, 'front');
    expect(layersOnPage(store).map((n) => n.id)).toEqual([b.id, a.id]);

    toggleVisible(store);
    expect(getLayer(store.getState().doc, a.id)?.visible).toBe(false);
    toggleVisible(store);
    expect(getLayer(store.getState().doc, a.id)?.visible).toBe(true);
    toggleLocked(store);
    expect(getLayer(store.getState().doc, a.id)?.locked).toBe(true);

    deleteSelection(store);
    expect(layersOnPage(store).map((n) => n.id)).toEqual([b.id]);
    expect(store.getState().selection).toEqual([]);
    store.getState().undo();
    expect(store.getState().selection).toEqual([a.id]);
  });

  it('selects all at the level being worked on, skipping locked and hidden layers', () => {
    const { store, controller } = setup();
    const frame = draw(store, controller, 'frame', [0, 0], [400, 400]);
    const inA = draw(store, controller, 'rectangle', [10, 10], [50, 50]);
    const inB = draw(store, controller, 'rectangle', [100, 10], [150, 50]);
    const out = draw(store, controller, 'rectangle', [500, 0], [600, 100]);
    const hidden = draw(store, controller, 'rectangle', [500, 200], [600, 300]);
    toggleVisible(store);

    store.getState().setSelection([]);
    selectAll(store);
    expect(store.getState().selection).toEqual([frame.id, out.id]);
    store.getState().setSelection([inA.id]);
    selectAll(store);
    expect(store.getState().selection).toEqual([inA.id, inB.id]);
    expect(getLayer(store.getState().doc, hidden.id)?.visible).toBe(false);
  });

  it('adds, duplicates and deletes pages, and undo returns to the right page', () => {
    const { store, controller } = setup();
    const first = store.getState().pageId;
    draw(store, controller, 'rectangle', [0, 0], [100, 100]);

    createPage(store);
    const second = store.getState().pageId;
    expect(getPages(store.getState().doc).map((p) => p.name)).toEqual(['Page 1', 'Page 2']);
    expect(second).not.toBe(first);

    copyPage(store, first);
    expect(getPages(store.getState().doc).map((p) => p.name)).toEqual(['Page 1', 'Page 1 copy', 'Page 2']);
    expect(layersOnPage(store)).toHaveLength(1);

    removePage(store, store.getState().pageId);
    expect(getPages(store.getState().doc).map((p) => p.name)).toEqual(['Page 1', 'Page 2']);
    expect(store.getState().doc.nodes[store.getState().pageId]?.type).toBe('PAGE');

    store.getState().undo();
    expect(getPages(store.getState().doc).map((p) => p.name)).toEqual(['Page 1', 'Page 1 copy', 'Page 2']);
  });

  it('never deletes the last page', () => {
    const { store, pageId } = setup();
    removePage(store, pageId);
    expect(getPages(store.getState().doc)).toHaveLength(1);
  });

  it('maps keys to commands, respecting modifiers', () => {
    const key = (code: string, mods: Partial<{ ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean }> = {}) =>
      commandForKey({ code, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...mods })?.id;
    expect(key('KeyV')).toBe('tool.move');
    expect(key('KeyV', { ctrlKey: true })).toBe('edit.paste');
    expect(key('KeyR')).toBe('tool.rectangle');
    expect(key('KeyF')).toBe('tool.frame');
    expect(key('KeyO')).toBe('tool.ellipse');
    expect(key('KeyL')).toBe('tool.line');
    expect(key('KeyH')).toBe('tool.hand');
    expect(key('KeyZ', { ctrlKey: true })).toBe('edit.undo');
    expect(key('KeyZ', { ctrlKey: true, shiftKey: true })).toBe('edit.redo');
    expect(key('KeyZ', { metaKey: true })).toBe('edit.undo');
    expect(key('KeyD', { ctrlKey: true })).toBe('edit.duplicate');
    expect(key('Digit1', { shiftKey: true })).toBe('view.zoomFit');
    expect(key('Digit2', { shiftKey: true })).toBe('view.zoomSelection');
    expect(key('Digit0', { shiftKey: true })).toBe('view.zoom100');
    expect(key('KeyQ')).toBeUndefined();
  });

  it('gives every key binding to exactly one command', () => {
    const seen = new Map<string, string>();
    for (const command of COMMANDS) {
      for (const k of command.keys ?? []) {
        const signature = `${k.ctrl ? 'C' : ''}${k.shift ? 'S' : ''}${k.alt ? 'A' : ''}+${k.code}`;
        expect(seen.get(signature), `${signature} is bound twice`).toBeUndefined();
        seen.set(signature, command.id);
      }
    }
    expect(seen.size).toBeGreaterThan(30);
  });
});

describe('history', () => {
  it('redo is cleared by a new edit', () => {
    const { store, controller } = setup();
    draw(store, controller, 'rectangle', [0, 0], [100, 100]);
    store.getState().undo();
    expect(store.getState().redoStack).toHaveLength(1);
    draw(store, controller, 'ellipse', [0, 0], [100, 100]);
    expect(store.getState().redoStack).toEqual([]);
  });

  it('is bounded', () => {
    const { store, pageId } = setup();
    const created = addLayer(store.getState().doc, 'RECTANGLE', pageId, { x: 0 });
    store.getState().apply('Create', () => created.doc);
    for (let i = 1; i <= HISTORY_LIMIT + 20; i++) {
      store.getState().apply('Move', (doc) => patchNode(doc, created.id, { x: i }));
    }
    expect(store.getState().undoStack).toHaveLength(HISTORY_LIMIT);
  });

  it('an edit that changes nothing is not recorded', () => {
    const { store } = setup();
    store.getState().apply('Nothing', (doc) => doc);
    expect(store.getState().undoStack).toEqual([]);
  });

  it('renaming the file is not an undo step', () => {
    const { store } = setup();
    store.getState().renameDocument('  Landing page  ');
    expect(store.getState().doc.name).toBe('Landing page');
    expect(store.getState().undoStack).toEqual([]);
  });
});
