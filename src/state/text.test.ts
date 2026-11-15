import { describe, expect, it } from 'vitest';
import { createDocument, getChildIds, getLayer, patchNode, type NodeId, type TextNode } from '../core';
import { InteractionController, type PointerInput } from '../engine/input/controller';
import { commandForKey, getCommand, runCommand, updateLayers } from './commands';
import { createEditorStore, type EditorStore } from './editorStore';

/**
 * Text behaviour at the store and tool level. The store is created without a
 * measurer, so it uses the approximate one: each character is half the font
 * size wide (8px at the default 16px), with 19px lines.
 */

function setup(): { store: EditorStore; controller: InteractionController } {
  const store = createEditorStore(createDocument('Test'));
  store.getState().setCanvasSize({ width: 800, height: 600 });
  const controller = new InteractionController(store, { requestRender: () => undefined, setCursor: () => undefined });
  return { store, controller };
}

const ptr = (x: number, y: number, extra: Partial<PointerInput> = {}): PointerInput => ({
  x, y, button: 0, shiftKey: false, altKey: false, ctrlKey: false, detail: 1, ...extra,
});

function click(controller: InteractionController, at: [number, number], extra: Partial<PointerInput> = {}): void {
  controller.pointerDown(ptr(at[0], at[1], extra));
  controller.pointerUp(ptr(at[0], at[1], extra));
}

function drag(controller: InteractionController, from: [number, number], to: [number, number]): void {
  controller.pointerDown(ptr(from[0], from[1]));
  controller.pointerMove(ptr(to[0], to[1]));
  controller.pointerUp(ptr(to[0], to[1]));
}

const pageLayers = (store: EditorStore): NodeId[] => [...getChildIds(store.getState().doc, store.getState().pageId)];
const textOf = (store: EditorStore, id: NodeId): TextNode => getLayer(store.getState().doc, id) as TextNode;

/** What the in-place editor does while the user types and then finishes. */
function type(store: EditorStore, id: NodeId, characters: string): void {
  const base = store.getState().doc;
  store.getState().updateGesture(() => patchNode(base, id, { characters }));
}

describe('text tool', () => {
  it('places text with a click and opens it for editing inside one open gesture', () => {
    const { store, controller } = setup();
    store.getState().setTool('text');
    click(controller, [100, 200]);

    const [id] = pageLayers(store) as [NodeId];
    const state = store.getState();
    expect(textOf(store, id)).toMatchObject({ type: 'TEXT', characters: '', x: 100, textAutoResize: 'WIDTH_AND_HEIGHT' });
    // The first line is centred on the click.
    expect(textOf(store, id).y).toBe(Math.round(200 - 19 / 2));
    expect(state.editingTextId).toBe(id);
    expect(state.selection).toEqual([id]);
    expect(state.tool).toBe('move');
    expect(state.gesture).not.toBeNull();
    expect(state.undoStack).toEqual([]);
  });

  it('typing resizes the layer, and finishing records a single undo step', () => {
    const { store, controller } = setup();
    store.getState().setTool('text');
    click(controller, [100, 200]);
    const [id] = pageLayers(store) as [NodeId];

    type(store, id, 'Hello');
    expect(textOf(store, id)).toMatchObject({ characters: 'Hello', width: 40, height: 19 });
    type(store, id, 'Hello world');
    expect(textOf(store, id).width).toBe(88);

    store.getState().commitGesture('Create text');
    store.getState().setEditingText(null);
    expect(store.getState().undoStack.map((entry) => entry.label)).toEqual(['Create text']);
    store.getState().undo();
    expect(pageLayers(store)).toEqual([]);
    store.getState().redo();
    expect(textOf(store, id).characters).toBe('Hello world');
  });

  it('abandoning new text leaves nothing behind', () => {
    const { store, controller } = setup();
    store.getState().setTool('text');
    click(controller, [100, 200]);
    store.getState().cancelGesture();
    store.getState().setEditingText(null);
    expect(pageLayers(store)).toEqual([]);
    expect(store.getState().undoStack).toEqual([]);
  });

  it('dragging makes a text box of that width whose height follows the text', () => {
    const { store, controller } = setup();
    store.getState().setTool('text');
    drag(controller, [100, 100], [180, 300]);
    const [id] = pageLayers(store) as [NodeId];
    expect(textOf(store, id)).toMatchObject({ x: 100, y: 100, width: 80, textAutoResize: 'HEIGHT' });
    expect(controller.marquee).toBeNull();

    // Ten characters fit on a line; the height grows as the text wraps.
    type(store, id, 'one two three four five');
    expect(textOf(store, id)).toMatchObject({ width: 80, height: 57 });
  });

  it('places text inside the frame under the pointer', () => {
    const { store, controller } = setup();
    store.getState().setTool('frame');
    drag(controller, [100, 100], [500, 400]);
    const frameId = store.getState().selection[0] as NodeId;
    store.getState().setTool('text');
    click(controller, [150, 180]);
    const id = store.getState().editingTextId as NodeId;
    expect(textOf(store, id)).toMatchObject({ parentId: frameId, x: 50 });
  });
});

describe('editing existing text', () => {
  function withText(characters = 'Hello'): { store: EditorStore; controller: InteractionController; id: NodeId } {
    const { store, controller } = setup();
    store.getState().setTool('text');
    click(controller, [100, 200]);
    const [id] = pageLayers(store) as [NodeId];
    type(store, id, characters);
    store.getState().commitGesture('Create text');
    store.getState().setEditingText(null);
    return { store, controller, id };
  }

  it('opens on double-click and with Enter, but not on a single click', () => {
    const { store, controller, id } = withText();
    click(controller, [600, 500]);
    click(controller, [110, 200]);
    expect(store.getState().selection).toEqual([id]);
    expect(store.getState().editingTextId).toBeNull();

    click(controller, [110, 200], { detail: 2 });
    expect(store.getState().editingTextId).toBe(id);
    store.getState().setEditingText(null);

    const enter = commandForKey({ code: 'Enter', ctrlKey: false, shiftKey: false, altKey: false, metaKey: false });
    expect(enter?.id).toBe('object.editText');
    const app = { cancelInteraction: () => false, openShortcuts: () => undefined, saveNow: () => undefined, saveAs: () => undefined, placeImage: () => undefined, goHome: () => undefined };
    if (enter) runCommand(enter, { store, app });
    expect(store.getState().editingTextId).toBe(id);
  });

  it('Enter does nothing unless exactly one text layer is selected', () => {
    const { store } = setup();
    const command = getCommand('object.editText');
    expect(command?.enabled?.(store.getState())).toBe(false);
  });

  it('refits when the font size changes, as one undo step', () => {
    const { store, id } = withText('Hello');
    expect(textOf(store, id).width).toBe(40);
    updateLayers(store, 'Change font size', [id], { fontSize: 32 });
    expect(textOf(store, id)).toMatchObject({ fontSize: 32, width: 80, height: 38 });
    store.getState().undo();
    expect(textOf(store, id)).toMatchObject({ fontSize: 16, width: 40, height: 19 });
  });

  it('dragging a side handle fixes the width; dragging a corner fixes both', () => {
    const { store, controller, id } = withText('one two three');
    const box = textOf(store, id);
    expect(box).toMatchObject({ x: 100, width: 104, textAutoResize: 'WIDTH_AND_HEIGHT' });

    // Right edge, halfway down: narrow the box so the text wraps.
    const midY = box.y + box.height / 2;
    drag(controller, [box.x + box.width, midY], [box.x + 60, midY]);
    // Seven characters fit per line now: "one two" / "three".
    expect(textOf(store, id)).toMatchObject({ width: 60, textAutoResize: 'HEIGHT', height: 38 });

    // Bottom-right corner: the height no longer follows the text.
    const now = textOf(store, id);
    drag(controller, [now.x + now.width, now.y + now.height], [now.x + 90, now.y + 120]);
    expect(textOf(store, id)).toMatchObject({ width: 90, height: 120, textAutoResize: 'NONE' });
  });

  it('undo while editing closes the editor', () => {
    const { store, id } = withText();
    store.getState().setEditingText(id);
    store.getState().undo();
    expect(store.getState().editingTextId).toBeNull();
  });

  it('only a text layer can be opened for editing', () => {
    const { store, controller } = setup();
    store.getState().setTool('rectangle');
    drag(controller, [0, 0], [100, 100]);
    const rectId = store.getState().selection[0] as NodeId;
    store.getState().setEditingText(rectId);
    expect(store.getState().editingTextId).toBeNull();
  });
});
