import { describe, expect, it } from 'vitest';
import { createDocument, getChildIds, getLayer, getWorldBounds, type LayerNode, type NodeId } from '../core';
import { InteractionController, type PointerInput } from '../engine/input/controller';
import {
  alignSelection,
  canAlign,
  canUngroup,
  commandForKey,
  deleteSelection,
  distributeSelection,
  flipSelection,
  groupSelection,
  ungroupSelection,
} from './commands';
import { createEditorStore, type EditorStore, type ToolId } from './editorStore';

function setup(): { store: EditorStore; controller: InteractionController } {
  const store = createEditorStore(createDocument('Test'));
  store.getState().setCanvasSize({ width: 800, height: 600 });
  const controller = new InteractionController(store, { requestRender: () => undefined, setCursor: () => undefined });
  return { store, controller };
}

const ptr = (x: number, y: number, extra: Partial<PointerInput> = {}): PointerInput => ({
  x, y, button: 0, shiftKey: false, altKey: false, ctrlKey: false, detail: 1, ...extra,
});

function drag(controller: InteractionController, from: [number, number], to: [number, number]): void {
  controller.pointerDown(ptr(from[0], from[1]));
  controller.pointerMove(ptr((from[0] + to[0]) / 2, (from[1] + to[1]) / 2));
  controller.pointerMove(ptr(to[0], to[1]));
  controller.pointerUp(ptr(to[0], to[1]));
}

function draw(store: EditorStore, controller: InteractionController, tool: ToolId, from: [number, number], to: [number, number]): LayerNode {
  store.getState().setTool(tool);
  drag(controller, from, to);
  return getLayer(store.getState().doc, store.getState().selection[0]) as LayerNode;
}

const pageLayers = (store: EditorStore): LayerNode[] => {
  const { doc, pageId } = store.getState();
  return getChildIds(doc, pageId).map((id) => doc.nodes[id] as LayerNode);
};

describe('grouping in the editor', () => {
  it('groups and ungroups the selection, each as one undoable step', () => {
    const { store, controller } = setup();
    const a = draw(store, controller, 'rectangle', [100, 100], [200, 200]);
    const b = draw(store, controller, 'rectangle', [300, 100], [400, 200]);
    store.getState().setSelection([a.id, b.id]);
    expect(canUngroup(store.getState())).toBe(false);

    groupSelection(store);
    const groupId = store.getState().selection[0] as NodeId;
    expect(store.getState().selection).toHaveLength(1);
    expect(getLayer(store.getState().doc, groupId)).toMatchObject({ type: 'GROUP', x: 100, y: 100, width: 300, height: 100 });
    expect(pageLayers(store).map((n) => n.type)).toEqual(['GROUP']);
    expect(canUngroup(store.getState())).toBe(true);

    ungroupSelection(store);
    expect(store.getState().selection).toEqual([a.id, b.id]);
    expect(pageLayers(store).map((n) => n.id)).toEqual([a.id, b.id]);

    store.getState().undo();
    expect(pageLayers(store).map((n) => n.type)).toEqual(['GROUP']);
    store.getState().undo();
    expect(pageLayers(store).map((n) => n.id)).toEqual([a.id, b.id]);
  });

  it('moves a group as a whole and keeps its box fitted when a child is dragged', () => {
    const { store, controller } = setup();
    const a = draw(store, controller, 'rectangle', [100, 100], [200, 200]);
    const b = draw(store, controller, 'rectangle', [300, 100], [400, 200]);
    store.getState().setSelection([a.id, b.id]);
    groupSelection(store);
    const groupId = store.getState().selection[0] as NodeId;

    // Dragging a child moves the whole group.
    drag(controller, [150, 150], [150, 250]);
    expect(store.getState().selection).toEqual([groupId]);
    expect(getLayer(store.getState().doc, groupId)).toMatchObject({ x: 100, y: 200 });
    expect(getWorldBounds(store.getState().doc, b.id)).toMatchObject({ x: 300, y: 200 });

    // Double-click enters the group; dragging the child now moves only it, and the group refits.
    controller.pointerDown(ptr(150, 250, { detail: 2 }));
    controller.pointerUp(ptr(150, 250, { detail: 2 }));
    expect(store.getState().selection).toEqual([a.id]);
    drag(controller, [150, 250], [150, 350]);
    expect(getWorldBounds(store.getState().doc, a.id)).toMatchObject({ x: 100, y: 300 });
    expect(getWorldBounds(store.getState().doc, b.id)).toMatchObject({ x: 300, y: 200 });
    expect(getLayer(store.getState().doc, groupId)).toMatchObject({ x: 100, y: 200, width: 300, height: 200 });

    // One undo step puts both the child and the group's box back.
    store.getState().undo();
    expect(getLayer(store.getState().doc, groupId)).toMatchObject({ x: 100, y: 200, width: 300, height: 100 });
  });

  it('resizing a group with its handle scales what is inside', () => {
    const { store, controller } = setup();
    const a = draw(store, controller, 'rectangle', [100, 100], [200, 200]);
    const b = draw(store, controller, 'rectangle', [200, 200], [300, 300]);
    store.getState().setSelection([a.id, b.id]);
    groupSelection(store);
    drag(controller, [300, 300], [500, 300]);
    expect(getWorldBounds(store.getState().doc, a.id)).toEqual({ x: 100, y: 100, width: 200, height: 100 });
    expect(getWorldBounds(store.getState().doc, b.id)).toEqual({ x: 300, y: 200, width: 200, height: 100 });
  });

  it('removes a group that becomes empty, in the same undo step as the delete', () => {
    const { store, controller } = setup();
    const a = draw(store, controller, 'rectangle', [100, 100], [200, 200]);
    groupSelection(store);
    const groupId = store.getState().selection[0] as NodeId;
    store.getState().setSelection([a.id]);
    deleteSelection(store);
    expect(pageLayers(store)).toEqual([]);
    store.getState().undo();
    expect(pageLayers(store).map((n) => n.id)).toEqual([groupId]);
    expect(getChildIds(store.getState().doc, groupId)).toEqual([a.id]);
  });
});

describe('arranging in the editor', () => {
  it('aligns, distributes and flips through commands, undoably', () => {
    const { store, controller } = setup();
    const a = draw(store, controller, 'rectangle', [100, 100], [200, 150]);
    const b = draw(store, controller, 'rectangle', [250, 300], [300, 400]);
    const c = draw(store, controller, 'rectangle', [500, 200], [600, 220]);
    const xs = (): number[] => [a, b, c].map((n) => (getLayer(store.getState().doc, n.id) as LayerNode).x);

    store.getState().setSelection([a.id]);
    expect(canAlign(store.getState())).toBe(false);
    store.getState().setSelection([a.id, b.id, c.id]);
    expect(canAlign(store.getState())).toBe(true);

    alignSelection(store, 'left');
    expect(xs()).toEqual([100, 100, 100]);
    store.getState().undo();
    expect(xs()).toEqual([100, 250, 500]);

    distributeSelection(store, 'horizontal');
    expect(xs()).toEqual([100, 325, 500]);
    store.getState().undo();

    flipSelection(store, 'horizontal');
    expect(xs()).toEqual([500, 400, 100]);
    expect(store.getState().undoStack.at(-1)?.label).toBe('Flip horizontal');
  });

  it('binds the arrange shortcuts', () => {
    const key = (code: string, mods: Partial<{ ctrlKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) =>
      commandForKey({ code, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...mods })?.id;
    expect(key('KeyG', { ctrlKey: true })).toBe('object.group');
    expect(key('KeyG', { ctrlKey: true, shiftKey: true })).toBe('object.ungroup');
    expect(key('KeyH', { shiftKey: true })).toBe('object.flipHorizontal');
    expect(key('KeyV', { shiftKey: true })).toBe('object.flipVertical');
    expect(key('KeyA', { altKey: true })).toBe('arrange.align.left');
    expect(key('KeyH', { altKey: true })).toBe('arrange.align.centerX');
    expect(key('KeyD', { altKey: true })).toBe('arrange.align.right');
    expect(key('KeyW', { altKey: true })).toBe('arrange.align.top');
    expect(key('KeyV', { altKey: true })).toBe('arrange.align.centerY');
    expect(key('KeyS', { altKey: true })).toBe('arrange.align.bottom');
    expect(key('KeyH', { ctrlKey: true, altKey: true })).toBe('arrange.distribute.horizontal');
    expect(key('KeyV', { ctrlKey: true, altKey: true })).toBe('arrange.distribute.vertical');
    // The plain keys still pick tools.
    expect(key('KeyH')).toBe('tool.hand');
    expect(key('KeyV')).toBe('tool.move');
  });
});
