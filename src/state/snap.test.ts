import { describe, expect, it } from 'vitest';
import {
  addLayer,
  collectSnapTargets,
  createDocument,
  getLayer,
  getPages,
  patchNode,
  snapPoint,
  snapRect,
  type Document,
  type LayerNode,
  type NodeId,
} from '../core';
import { InteractionController, type PointerInput } from '../engine/input/controller';
import { DEFAULT_PREFERENCES, loadPreferences, savePreferences, type Preferences } from '../persistence/prefs';
import { commandForKey, getCommand, runCommand } from './commands';
import { createEditorStore, type EditorStore } from './editorStore';

function docWith(specs: [number, number, number, number][]): { doc: Document; pageId: NodeId; ids: NodeId[] } {
  let doc = createDocument('Snap');
  const pageId = (getPages(doc)[0] as { id: NodeId }).id;
  const ids: NodeId[] = [];
  for (const [x, y, width, height] of specs) {
    const out = addLayer(doc, 'RECTANGLE', pageId, { x, y, width, height });
    doc = out.doc;
    ids.push(out.id);
  }
  return { doc, pageId, ids };
}

describe('snap targets', () => {
  it('offers the edges and centre lines of the other layers in a container', () => {
    const { doc, pageId, ids } = docWith([
      [100, 100, 100, 50],
      [300, 200, 40, 40],
    ]);
    const targets = collectSnapTargets(doc, pageId, new Set([ids[1] as NodeId]));
    expect(targets.xs.map((line) => line.value)).toEqual([100, 150, 200]);
    expect(targets.ys.map((line) => line.value)).toEqual([100, 125, 150]);
    expect(targets.xs[0]).toEqual({ value: 100, from: 100, to: 150 });
  });

  it('includes the frame itself, skips hidden layers, and offers nothing inside a rotated frame', () => {
    const { doc, pageId } = docWith([]);
    const frame = addLayer(doc, 'FRAME', pageId, { x: 0, y: 0, width: 400, height: 200 });
    const child = addLayer(frame.doc, 'RECTANGLE', frame.id, { x: 10, y: 10, width: 20, height: 20 });
    const none = new Set<NodeId>();
    expect(collectSnapTargets(child.doc, frame.id, none).xs.map((l) => l.value)).toEqual([0, 200, 400, 10, 20, 30]);
    const hidden = patchNode(child.doc, child.id, { visible: false });
    expect(collectSnapTargets(hidden, frame.id, none).xs.map((l) => l.value)).toEqual([0, 200, 400]);
    const rotated = patchNode(child.doc, frame.id, { rotation: 20 });
    expect(collectSnapTargets(rotated, frame.id, none)).toEqual({ xs: [], ys: [] });
  });
});

describe('snapping maths', () => {
  const targets = { xs: [{ value: 100, from: 0, to: 50 }, { value: 200, from: 0, to: 50 }], ys: [{ value: 300, from: 100, to: 200 }] };

  it('snaps the nearest edge or centre line within the threshold', () => {
    // Left edge at 103 → 100.
    expect(snapRect({ x: 103, y: 0, width: 40, height: 40 }, targets, 6)).toMatchObject({ dx: -3, dy: 0 });
    // Right edge at 196 → 200.
    expect(snapRect({ x: 156, y: 0, width: 40, height: 40 }, targets, 6)).toMatchObject({ dx: 4 });
    // Centre at 98 → 100.
    expect(snapRect({ x: 78, y: 0, width: 40, height: 40 }, targets, 6)).toMatchObject({ dx: 2 });
    // Too far from everything.
    expect(snapRect({ x: 120, y: 0, width: 40, height: 40 }, targets, 6)).toEqual({ dx: 0, dy: 0, guides: [] });
  });

  it('prefers the closest line and can be limited to one axis', () => {
    // Left edge is 5 from 100, right edge is 1 from 200.
    expect(snapRect({ x: 105, y: 298, width: 94, height: 10 }, targets, 6)).toMatchObject({ dx: 1, dy: 2 });
    expect(snapRect({ x: 105, y: 298, width: 94, height: 10 }, targets, 6, { x: true })).toMatchObject({ dx: 1, dy: 0 });
    expect(snapRect({ x: 105, y: 298, width: 94, height: 10 }, targets, 6, { y: true })).toMatchObject({ dx: 0, dy: 2 });
  });

  it('reports a guide spanning the target and the snapped box', () => {
    const result = snapRect({ x: 103, y: 400, width: 40, height: 40 }, targets, 6);
    expect(result.guides).toEqual([{ axis: 'x', position: 100, from: 0, to: 440 }]);
  });

  it('snaps a single point', () => {
    expect(snapPoint({ x: 197, y: 303 }, targets, 6).point).toEqual({ x: 200, y: 300 });
    expect(snapPoint({ x: 197, y: 303 }, targets, 6, { y: true }).point).toEqual({ x: 197, y: 300 });
    expect(snapPoint({ x: 150, y: 150 }, targets, 6)).toEqual({ point: { x: 150, y: 150 }, guides: [] });
  });
});

describe('snapping in the tools', () => {
  function setup(snapping = true): { store: EditorStore; controller: InteractionController; a: NodeId; b: NodeId } {
    const { doc, ids } = docWith([
      [100, 100, 100, 100],
      [300, 300, 100, 100],
    ]);
    const store = createEditorStore(doc, undefined, { snapping });
    store.getState().setCanvasSize({ width: 800, height: 600 });
    const controller = new InteractionController(store, { requestRender: () => undefined, setCursor: () => undefined });
    return { store, controller, a: ids[0] as NodeId, b: ids[1] as NodeId };
  }

  const ptr = (x: number, y: number, extra: Partial<PointerInput> = {}): PointerInput => ({
    x, y, button: 0, shiftKey: false, altKey: false, ctrlKey: false, detail: 1, ...extra,
  });
  const box = (store: EditorStore, id: NodeId): LayerNode => getLayer(store.getState().doc, id) as LayerNode;

  it('snaps a dragged layer to its neighbour and shows guides only while dragging', () => {
    const { store, controller, b } = setup();
    store.getState().setSelection([b]);
    controller.pointerDown(ptr(350, 350));
    // Raw position would be x 203, y 97: 3px from the neighbour's right edge and its top edge.
    controller.pointerMove(ptr(253, 147));
    expect(box(store, b)).toMatchObject({ x: 200, y: 100 });
    // The two boxes are the same height, so top, middle and bottom all line up.
    expect(controller.guides.map((g) => `${g.axis}=${g.position}`).sort()).toEqual(['x=200', 'y=100', 'y=150', 'y=200']);
    controller.pointerUp(ptr(253, 147));
    expect(controller.guides).toEqual([]);
    expect(box(store, b)).toMatchObject({ x: 200, y: 100 });
  });

  it('does not snap when snapping is switched off', () => {
    const { store, controller, b } = setup(false);
    store.getState().setSelection([b]);
    controller.pointerDown(ptr(350, 350));
    controller.pointerMove(ptr(253, 147));
    controller.pointerUp(ptr(253, 147));
    expect(box(store, b)).toMatchObject({ x: 203, y: 97 });
    expect(controller.guides).toEqual([]);
  });

  it('leaves an axis locked with Shift alone', () => {
    const { store, controller, b } = setup();
    store.getState().setSelection([b]);
    controller.pointerDown(ptr(350, 350));
    // Mostly horizontal, so Y is locked at 300; X still snaps to 200.
    controller.pointerMove(ptr(253, 347, { shiftKey: true }));
    controller.pointerUp(ptr(253, 347, { shiftKey: true }));
    expect(box(store, b)).toMatchObject({ x: 200, y: 300 });
  });

  it('snaps the edge being resized', () => {
    const { store, controller, a } = setup();
    store.getState().setSelection([a]);
    // Drag the right edge of A (at x = 200) to 297: it lands on B's left edge at 300.
    controller.pointerDown(ptr(200, 150));
    controller.pointerMove(ptr(297, 150));
    expect(box(store, a)).toMatchObject({ x: 100, width: 200 });
    expect(controller.guides.map((g) => g.position)).toEqual([300]);
    controller.pointerUp(ptr(297, 150));
    expect(controller.guides).toEqual([]);
  });

  it('snaps the corner of a shape being drawn', () => {
    const { store, controller } = setup();
    store.getState().setTool('rectangle');
    controller.pointerDown(ptr(500, 500));
    controller.pointerMove(ptr(403, 396));
    controller.pointerUp(ptr(403, 396));
    const drawn = box(store, store.getState().selection[0] as NodeId);
    // Snapped to B's right edge (400) and bottom edge (400).
    expect(drawn).toMatchObject({ x: 400, y: 400, width: 100, height: 100 });
    expect(controller.guides).toEqual([]);
  });

  it('snaps a layer inside a frame to the frame’s centre', () => {
    const { store, controller } = setup();
    store.getState().setTool('frame');
    controller.pointerDown(ptr(500, 0));
    controller.pointerMove(ptr(700, 80));
    controller.pointerUp(ptr(700, 80));
    const frameId = store.getState().selection[0] as NodeId;
    store.getState().setTool('rectangle');
    controller.pointerDown(ptr(510, 10));
    controller.pointerMove(ptr(530, 30));
    controller.pointerUp(ptr(530, 30));
    const childId = store.getState().selection[0] as NodeId;
    expect(box(store, childId)).toMatchObject({ parentId: frameId, x: 10, y: 10, width: 20, height: 20 });

    // Drag it so its centre is 2px left of the frame's centre line (x = 600 on the page).
    controller.pointerDown(ptr(520, 20));
    controller.pointerMove(ptr(598, 20));
    controller.pointerUp(ptr(598, 20));
    expect(box(store, childId)).toMatchObject({ x: 90, y: 10 });
  });

  it('toggles from the View command and its shortcut', () => {
    const { store } = setup();
    const command = commandForKey({ code: 'Quote', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false });
    expect(command?.id).toBe('view.snapping');
    expect(getCommand('view.snapping')?.checked?.(store.getState())).toBe(true);
    const app = { cancelInteraction: () => false, openShortcuts: () => undefined, saveNow: () => undefined, saveAs: () => undefined, placeImage: () => undefined, goHome: () => undefined };
    if (command) runCommand(command, { store, app });
    expect(store.getState().snapping).toBe(false);
    expect(getCommand('view.snapping')?.checked?.(store.getState())).toBe(false);
    expect(store.getState().undoStack).toEqual([]);
  });
});

describe('preferences', () => {
  /** The default preferences with some of them changed. */
  const prefs = (changed: Partial<Preferences>): Preferences => ({ ...DEFAULT_PREFERENCES, ...changed });

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

  it('remembers each preference, defaults to on, and ignores damaged values', () => {
    const storage = fakeStorage();
    expect(loadPreferences(storage)).toEqual(prefs({ snapping: true, showLayoutGrids: true, showRulers: false }));
    savePreferences(prefs({ snapping: false, showLayoutGrids: true, showRulers: false }), storage);
    expect(loadPreferences(storage)).toEqual(prefs({ snapping: false, showLayoutGrids: true, showRulers: false }));
    savePreferences(prefs({ snapping: true, showLayoutGrids: false, showRulers: false }), storage);
    expect(loadPreferences(storage)).toEqual(prefs({ snapping: true, showLayoutGrids: false, showRulers: false }));
    savePreferences(prefs({ snapping: true, showLayoutGrids: true, showRulers: true }), storage);
    expect(loadPreferences(storage)).toEqual(prefs({ snapping: true, showLayoutGrids: true, showRulers: true }));
    storage.setItem('open-design:preferences', 'broken');
    expect(loadPreferences(storage)).toEqual(prefs({ snapping: true, showLayoutGrids: true, showRulers: false }));
    // A value of the wrong type falls back to its default; values saved by an older version are kept.
    storage.setItem('open-design:preferences', '{"snapping":"yes","showLayoutGrids":false}');
    expect(loadPreferences(storage)).toEqual(prefs({ snapping: true, showLayoutGrids: false, showRulers: false }));
    storage.setItem('open-design:preferences', '{"snapping":false}');
    expect(loadPreferences(storage)).toEqual(prefs({ snapping: false, showLayoutGrids: true, showRulers: false }));
  });
});
