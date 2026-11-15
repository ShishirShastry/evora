import { describe, expect, it } from 'vitest';
import { addLayer, createDocument, getPages, gradientAngle, gradientPaint, solidPaint, type GradientPaint, type LayerNode, type NodeId } from './core';
import { InteractionController, type PointerInput } from './engine/input/controller';
import { gradientHandles } from './engine/input/gradientHandles';
import { getCommand, runCommand, type AppActions, type Command } from './state/commands';
import { createEditorStore, type EditorStore } from './state/editorStore';

const ptr = (x: number, y: number, shiftKey = false): PointerInput => ({ x, y, button: 0, shiftKey, altKey: false, ctrlKey: false, detail: 1 });

const RED = { r: 1, g: 0, b: 0 };
const BLUE = { r: 0, g: 0, b: 1 };

/** An editor with a 200 × 100 rectangle at (100, 100) whose fill is a gradient from red at the top to blue at the bottom. */
function editor(rotation = 0): { store: EditorStore; controller: InteractionController; app: AppActions; id: NodeId } {
  const doc = createDocument('Gradients');
  const pageId = (getPages(doc)[0] as { id: NodeId }).id;
  const made = addLayer(doc, 'RECTANGLE', pageId, { x: 100, y: 100, width: 200, height: 100, rotation, fills: [solidPaint(RED), gradientPaint('GRADIENT_LINEAR', RED, BLUE)] });
  const store = createEditorStore(made.doc);
  store.getState().setCanvasSize({ width: 800, height: 600 });
  const controller = new InteractionController(store, { requestRender: () => undefined, setCursor: () => undefined });
  const app: AppActions = { cancelInteraction: () => controller.cancel(), openShortcuts: () => undefined, saveNow: () => undefined, saveAs: () => undefined, placeImage: () => undefined, goHome: () => undefined };
  return { store, controller, app, id: made.id };
}

const drag = (controller: InteractionController, from: [number, number], to: [number, number], shift = false): void => {
  controller.pointerDown(ptr(from[0], from[1], shift));
  controller.pointerMove(ptr((from[0] + to[0]) / 2, (from[1] + to[1]) / 2, shift));
  controller.pointerMove(ptr(to[0], to[1], shift));
  controller.pointerUp(ptr(to[0], to[1], shift));
};

const gradientOf = (store: EditorStore, id: NodeId): GradientPaint => (store.getState().doc.nodes[id] as LayerNode).fills[1] as GradientPaint;
const handlesOf = (store: EditorStore) => gradientHandles(store.getState().doc, store.getState().paintEdit, store.getState().viewport);

describe('editing a gradient on the canvas', () => {
  it('shows its handles only while it is being edited there', () => {
    const { store, id } = editor();
    expect(handlesOf(store)).toBeNull();
    // A solid fill has no handles to show.
    store.getState().setPaintEdit({ id, key: 'fills', index: 0 });
    expect(store.getState().paintEdit).toBeNull();
    store.getState().setPaintEdit({ id, key: 'fills', index: 1 });
    expect(store.getState().paintEdit).toEqual({ id, key: 'fills', index: 1 });
    // The layer is selected with it. The gradient runs from the middle of the top edge to the middle of the bottom edge.
    expect(store.getState().selection).toEqual([id]);
    expect(handlesOf(store)).toEqual({ from: { x: 200, y: 100 }, to: { x: 200, y: 200 } });

    // Deselecting, or turning the fill into a plain colour, ends it.
    store.getState().setSelection([]);
    expect(store.getState().paintEdit).toBeNull();
    store.getState().setPaintEdit({ id, key: 'fills', index: 1 });
    store.getState().apply('Change fill', (doc) => ({ ...doc, nodes: { ...doc.nodes, [id]: { ...(doc.nodes[id] as LayerNode), fills: [solidPaint(RED)] } as LayerNode } }));
    expect(store.getState().paintEdit).toBeNull();
  });

  it('moves the end and the start of the gradient by dragging their handles', () => {
    const { store, controller, id } = editor();
    store.getState().setPaintEdit({ id, key: 'fills', index: 1 });
    // The end, from the bottom edge to the middle of the right edge.
    drag(controller, [200, 200], [300, 150]);
    expect(gradientOf(store, id)).toMatchObject({ from: { x: 0.5, y: 0 }, to: { x: 1, y: 0.5 } });
    expect(store.getState().undoStack.map((entry) => entry.label)).toEqual(['Change gradient']);
    // The layer itself has not moved, and the other fill is untouched.
    expect(store.getState().doc.nodes[id]).toMatchObject({ x: 100, y: 100 });
    expect((store.getState().doc.nodes[id] as LayerNode).fills[0]).toEqual(solidPaint(RED));

    // The start, to the top left corner. A handle may also go outside the layer.
    drag(controller, [200, 100], [100, 100]);
    expect(gradientOf(store, id).from).toEqual({ x: 0, y: 0 });
    drag(controller, [100, 100], [60, 80]);
    expect(gradientOf(store, id).from).toEqual({ x: -0.2, y: -0.2 });
    store.getState().undo();
    store.getState().undo();
    store.getState().undo();
    expect(gradientOf(store, id)).toMatchObject({ from: { x: 0.5, y: 0 }, to: { x: 0.5, y: 1 } });
  });

  it('keeps to steps of 15 degrees with Shift, and follows a rotated layer', () => {
    const { store, controller, id } = editor();
    store.getState().setPaintEdit({ id, key: 'fills', index: 1 });
    // Nearly, but not quite, straight to the right of the start.
    drag(controller, [200, 200], [320, 108], true);
    const paint = gradientOf(store, id);
    expect(paint.to.y).toBeCloseTo(0, 3);
    expect(gradientAngle(paint)).toBe(0);

    // A layer turned a quarter turn: its top edge is now its right edge on the page.
    const turned = editor(90);
    turned.store.getState().setPaintEdit({ id: turned.id, key: 'fills', index: 1 });
    expect(handlesOf(turned.store)?.from.x).toBeCloseTo(250, 6);
    expect(handlesOf(turned.store)?.from.y).toBeCloseTo(150, 6);
    expect(handlesOf(turned.store)?.to.x).toBeCloseTo(150, 6);
    drag(turned.controller, [150, 150], [200, 250]);
    const local = gradientOf(turned.store, turned.id).to;
    expect(local.x).toBeCloseTo(1, 3);
    expect(local.y).toBeCloseTo(0.5, 3);
  });

  it('ends with Escape before anything else is deselected, and gives up a drag that is cancelled', () => {
    const { store, controller, app, id } = editor();
    store.getState().setPaintEdit({ id, key: 'fills', index: 1 });
    controller.pointerDown(ptr(200, 200));
    controller.pointerMove(ptr(260, 180));
    expect(gradientOf(store, id).to).not.toEqual({ x: 0.5, y: 1 });
    expect(controller.cancel()).toBe(true);
    expect(gradientOf(store, id).to).toEqual({ x: 0.5, y: 1 });
    expect(store.getState().undoStack).toEqual([]);

    runCommand(getCommand('edit.deselect') as Command, { store, app });
    expect(store.getState().paintEdit).toBeNull();
    expect(store.getState().selection).toEqual([id]);
    // With the handles gone, a press where one was (the middle of the layer, say, had it been there) moves the layer.
    drag(controller, [200, 150], [220, 150]);
    expect(store.getState().doc.nodes[id]).toMatchObject({ x: 120, y: 100 });
    // A drawing tool ends it too.
    store.getState().setPaintEdit({ id, key: 'fills', index: 1 });
    store.getState().setTool('rectangle');
    expect(store.getState().paintEdit).toBeNull();
  });
});
