import { describe, expect, it } from 'vitest';
import {
  addLayer,
  applyToPoint,
  createDocument,
  createLayer,
  fitVectorNode,
  getPages,
  getWorldMatrix,
  mirroringAt,
  NetworkBuilder,
  networkGeometry,
  setNodes,
  solidPaint,
  type Document,
  type NodeId,
  type Point,
  type VectorNetwork,
  type VectorNode,
} from './core';
import { freshKeys } from './core/order';
import { InteractionController, type PointerInput } from './engine/input/controller';
import { renderOverlay } from './engine/render/overlay';
import { commandForKey, getCommand, runCommand, type AppActions, type Command } from './state/commands';
import { createEditorStore, type EditorStore } from './state/editorStore';

type Mods = Partial<Pick<PointerInput, 'shiftKey' | 'altKey' | 'ctrlKey' | 'detail'>>;

const ptr = (x: number, y: number, mods: Mods = {}): PointerInput => ({ x, y, button: 0, shiftKey: false, altKey: false, ctrlKey: false, detail: 1, ...mods });

interface Harness {
  store: EditorStore;
  controller: InteractionController;
  app: AppActions;
  click(x: number, y: number, mods?: Mods): void;
  drag(from: [number, number], to: [number, number], mods?: Mods): void;
  run(id: string): boolean;
  /** The vector being edited. */
  vector(): VectorNode;
  /** Its points, in page space. */
  points(): Point[];
  labels(): string[];
}

/** An editor with a real store and controller. The view is not scrolled or zoomed, so canvas pixels are page units. */
function editor(doc: Document = createDocument('Pen')): Harness {
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
  const vector = (): VectorNode => {
    const state = store.getState();
    const id = state.vectorEdit?.id ?? state.selection[0];
    return state.doc.nodes[id as NodeId] as VectorNode;
  };
  return {
    store,
    controller,
    app,
    click(x, y, mods) {
      controller.pointerDown(ptr(x, y, mods));
      controller.pointerUp(ptr(x, y, mods));
    },
    drag(from, to, mods) {
      controller.pointerDown(ptr(from[0], from[1], mods));
      controller.pointerMove(ptr((from[0] + to[0]) / 2, (from[1] + to[1]) / 2, mods));
      controller.pointerMove(ptr(to[0], to[1], mods));
      controller.pointerUp(ptr(to[0], to[1], mods));
    },
    run: (id) => runCommand(getCommand(id) as Command, { store, app }),
    vector,
    points() {
      const node = vector();
      const matrix = getWorldMatrix(store.getState().doc, node.id);
      return node.network.vertices.map((v) => {
        const p = applyToPoint(matrix, v);
        return { x: Math.round(p.x * 1000) / 1000, y: Math.round(p.y * 1000) / 1000 };
      });
    },
    labels: () => store.getState().undoStack.map((entry) => entry.label),
  };
}

const pageOf = (doc: Document): NodeId => (getPages(doc)[0] as { id: NodeId }).id;

/** A document with one vector layer whose curves are `network`, placed so its box starts at (x, y). */
function withVector(network: VectorNetwork, props: Partial<VectorNode> = {}): { doc: Document; id: NodeId } {
  const doc = createDocument('Points');
  const bounds = networkGeometry(network).bounds ?? { width: 0, height: 0 };
  const node = createLayer('VECTOR', pageOf(doc), freshKeys(1)[0] as string, { width: bounds.width, height: bounds.height, ...props, network }) as VectorNode;
  return { doc: setNodes(doc, { [node.id]: fitVectorNode(node) }), id: node.id };
}

const square = (): VectorNetwork => new NetworkBuilder().moveTo(0, 0).lineTo(100, 0).lineTo(100, 100).lineTo(0, 100).close().build();

/** An editor on a filled 100 × 100 square at (100, 100), with its points open for editing. */
function editingSquare(): Harness & { id: NodeId } {
  const made = withVector(square(), { x: 100, y: 100, fills: [solidPaint({ r: 0.5, g: 0.5, b: 0.5 })] });
  const h = editor(made.doc);
  h.store.getState().setVectorEdit({ id: made.id, vertices: [] });
  return { ...h, id: made.id };
}

describe('the Pen tool', () => {
  it('draws a path click by click, and closes it on its first point', () => {
    const h = editor();
    h.store.getState().setTool('pen');

    // The first point alone is not a layer yet.
    h.click(100, 100);
    expect(h.store.getState().selection).toEqual([]);
    expect(h.labels()).toEqual([]);
    expect(h.controller.vectorOverlay()).toMatchObject({ id: null, start: { x: 100, y: 100 } });

    h.click(200, 100);
    const state = h.store.getState();
    expect(state.selection).toHaveLength(1);
    expect(h.vector()).toMatchObject({ type: 'VECTOR', name: 'Vector 1', x: 100, y: 100, width: 100, height: 0 });
    expect(h.vector().network).toEqual({
      vertices: [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
      ],
      segments: [{ start: 0, end: 1, tangentStart: { x: 0, y: 0 }, tangentEnd: { x: 0, y: 0 } }],
    });
    expect(state.vectorEdit).toEqual({ id: state.selection[0], vertices: [1] });
    expect(state.tool).toBe('pen');
    expect(h.labels()).toEqual(['Create vector']);
    // The pen goes on from the point it just placed.
    expect(h.controller.vectorOverlay()).toMatchObject({ penVertex: 1, start: null });

    h.click(200, 200);
    expect(h.points()).toEqual([
      { x: 100, y: 100 },
      { x: 200, y: 100 },
      { x: 200, y: 200 },
    ]);
    expect(h.vector()).toMatchObject({ x: 100, y: 100, width: 100, height: 100 });
    expect(networkGeometry(h.vector().network).closed).toBe(false);

    // Back onto the first point: the path closes and the pen lets go of it.
    h.click(100, 100);
    expect(h.vector().network.vertices).toHaveLength(3);
    expect(h.vector().network.segments).toHaveLength(3);
    expect(networkGeometry(h.vector().network).closed).toBe(true);
    expect(h.labels()).toEqual(['Create vector', 'Add point', 'Close path']);
    expect(h.controller.vectorOverlay()).toMatchObject({ penVertex: null, selected: [0] });
  });

  it('carries on from the end of the path after an undo', () => {
    const h = editor();
    h.store.getState().setTool('pen');
    h.click(100, 100);
    h.click(200, 100);
    h.click(200, 200);
    h.click(100, 100);
    h.store.getState().undo();
    expect(h.vector().network.segments).toHaveLength(2);
    h.click(100, 200);
    expect(h.points()).toEqual([
      { x: 100, y: 100 },
      { x: 200, y: 100 },
      { x: 200, y: 200 },
      { x: 100, y: 200 },
    ]);
    expect(h.vector().network.segments.map((s) => [s.start, s.end])).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
    ]);
    // Undoing everything leaves no layer and nothing selected.
    const { undo } = h.store.getState();
    undo();
    undo();
    undo();
    expect(h.store.getState().selection).toEqual([]);
    expect(h.store.getState().vectorEdit).toBeNull();
    expect(Object.values(h.store.getState().doc.nodes).filter((node) => node.type === 'VECTOR')).toEqual([]);
  });

  it('pulls a handle out of a point when the press is dragged, and leaves the next segment along it', () => {
    const h = editor();
    h.store.getState().setTool('pen');
    h.click(100, 300);
    h.drag([200, 300], [230, 300]);
    // The curve arrives against the drag.
    expect(h.vector().network.segments).toEqual([{ start: 0, end: 1, tangentStart: { x: 0, y: 0 }, tangentEnd: { x: -30, y: 0 } }]);
    expect(h.points()[1]).toEqual({ x: 200, y: 300 });
    expect(h.labels()).toEqual(['Create vector']);

    h.click(300, 300);
    expect(h.vector().network.segments[1]).toEqual({ start: 1, end: 2, tangentStart: { x: 30, y: 0 }, tangentEnd: { x: 0, y: 0 } });
    // Which makes the point in the middle a smooth one.
    expect(mirroringAt(h.vector().network, 1)).toBe('ANGLE_AND_LENGTH');

    // A drag in another direction bends the path; the points stay where they were put.
    h.drag([400, 300], [400, 350]);
    expect(h.points()).toEqual([
      { x: 100, y: 300 },
      { x: 200, y: 300 },
      { x: 300, y: 300 },
      { x: 400, y: 300 },
    ]);
    expect(h.vector().network.segments[2]?.tangentEnd).toEqual({ x: 0, y: -50 });
    // The curve bulges upwards, and the layer's box grows to hold it.
    expect(h.vector().y).toBeLessThan(300);
    expect(h.vector().height).toBeGreaterThan(0);
  });

  it('gives the first point a handle too', () => {
    const h = editor();
    h.store.getState().setTool('pen');
    h.drag([100, 100], [100, 60]);
    expect(h.labels()).toEqual([]);
    h.click(200, 100);
    expect(h.vector().network.segments[0]?.tangentStart).toEqual({ x: 0, y: -40 });
    expect(h.points()).toEqual([
      { x: 100, y: 100 },
      { x: 200, y: 100 },
    ]);
    expect(h.vector().height).toBeGreaterThan(10);
  });

  it('ends the path on Escape, and starts another in the same layer', () => {
    const h = editor();
    h.store.getState().setTool('pen');
    h.click(100, 100);
    h.click(200, 100);
    expect(h.controller.cancel()).toBe(true);
    expect(h.controller.vectorOverlay()).toMatchObject({ penVertex: null, preview: null });
    expect(h.controller.cancel()).toBe(false);
    expect(h.store.getState().tool).toBe('pen');

    h.click(400, 400);
    expect(h.vector().network.vertices).toHaveLength(2);
    h.click(450, 400);
    expect(h.points()).toEqual([
      { x: 100, y: 100 },
      { x: 200, y: 100 },
      { x: 400, y: 400 },
      { x: 450, y: 400 },
    ]);
    expect(networkGeometry(h.vector().network).chains).toHaveLength(2);
    expect(h.labels()).toEqual(['Create vector', 'Add point']);

    // Escape as the keyboard sends it: end the path, then put the pen down.
    h.run('edit.deselect');
    expect(h.store.getState().tool).toBe('pen');
    h.run('edit.deselect');
    expect(h.store.getState().tool).toBe('move');
    expect(h.store.getState().vectorEdit).not.toBeNull();
  });

  it('keeps to multiples of 45° while Shift is held', () => {
    const h = editor();
    h.store.getState().setTool('pen');
    h.click(100, 100);
    h.click(200, 130, { shiftKey: true });
    const end = h.points()[1] as Point;
    expect(end.y).toBe(100);
    expect(end.x).toBeCloseTo(100 + Math.hypot(100, 30), 1);
    h.click(250, 160, { shiftKey: true });
    const third = h.points()[2] as Point;
    // 45° down and to the right.
    expect(third.x - end.x).toBeCloseTo(third.y - end.y, 1);
  });

  it('adds a point on a segment, and picks a path up again at its end', () => {
    const h = editor();
    h.store.getState().setTool('pen');
    h.click(100, 100);
    h.click(300, 100);
    h.controller.cancel();

    // On the line, a little off it and off-centre.
    h.click(150, 102);
    expect(h.vector().network.segments.map((s) => [s.start, s.end])).toEqual([
      [0, 2],
      [2, 1],
    ]);
    const added = h.points()[2] as Point;
    expect(added.x).toBeCloseTo(150, 1);
    expect(added.y).toBe(100);
    expect(h.store.getState().vectorEdit?.vertices).toEqual([2]);
    expect(h.labels()).toEqual(['Create vector', 'Add point']);
    expect(h.vector()).toMatchObject({ width: 200, height: 0 });

    // Clicking the end of the path picks it up without changing anything...
    h.click(300, 100);
    expect(h.labels()).toHaveLength(2);
    expect(h.controller.vectorOverlay()).toMatchObject({ penVertex: 1 });
    // ...and the next click continues it.
    h.click(300, 200);
    expect(h.vector().network.segments.at(-1)).toMatchObject({ start: 1, end: 3 });
    expect(h.points()[3]).toEqual({ x: 300, y: 200 });
  });

  it('runs a path into the middle of a segment, making a branch', () => {
    const h = editor();
    h.store.getState().setTool('pen');
    h.click(100, 100);
    h.click(300, 100);
    h.controller.cancel();
    h.click(200, 200);
    h.click(200, 101);
    const network = h.vector().network;
    expect(network.vertices).toHaveLength(4);
    expect(network.segments).toHaveLength(3);
    // Three segments meet at the new point.
    expect(network.segments.filter((s) => s.start === 2 || s.end === 2)).toHaveLength(3);
    expect(networkGeometry(network).chains).toHaveLength(3);
    expect(h.labels()).toEqual(['Create vector', 'Add point']);
    expect(h.controller.vectorOverlay()).toMatchObject({ penVertex: null });
  });

  it('puts a new path inside the frame it starts over', () => {
    const doc = createDocument('Pen');
    const frame = addLayer(doc, 'FRAME', pageOf(doc), { x: 300, y: 200, width: 300, height: 300 });
    const h = editor(frame.doc);
    h.store.getState().setTool('pen');
    h.click(350, 250);
    h.click(450, 300);
    expect(h.vector().parentId).toBe(frame.id);
    expect(h.vector()).toMatchObject({ x: 50, y: 50, width: 100, height: 50 });
    expect(h.points()).toEqual([
      { x: 350, y: 250 },
      { x: 450, y: 300 },
    ]);
  });

  it('abandons a point when the drag that places it is cancelled', () => {
    const h = editor();
    h.store.getState().setTool('pen');
    h.click(100, 100);
    h.click(200, 100);
    h.controller.pointerDown(ptr(300, 100));
    h.controller.pointerMove(ptr(320, 120));
    expect(h.vector().network.vertices).toHaveLength(3);
    expect(h.controller.cancel()).toBe(true);
    expect(h.vector().network.vertices).toHaveLength(2);
    expect(h.labels()).toEqual(['Create vector']);
    expect(h.controller.isBusy).toBe(false);
  });
});

describe('editing the points of a vector', () => {
  it('opens a vector for editing with a double-click or Enter, and closes it again', () => {
    const made = withVector(square(), { x: 100, y: 100, fills: [solidPaint({ r: 0.5, g: 0.5, b: 0.5 })] });
    const h = editor(made.doc);
    h.click(150, 150);
    expect(h.store.getState().selection).toEqual([made.id]);
    expect(h.store.getState().vectorEdit).toBeNull();
    h.click(150, 150, { detail: 2 });
    expect(h.store.getState().vectorEdit).toEqual({ id: made.id, vertices: [] });
    expect(h.controller.vectorOverlay()).toMatchObject({ id: made.id, selected: [] });

    // Double-clicking away from the path finishes.
    h.click(500, 500, { detail: 2 });
    expect(h.store.getState().vectorEdit).toBeNull();
    expect(h.store.getState().selection).toEqual([made.id]);

    // Enter edits whatever is selected: here the vector's points, and again to finish.
    const enter = commandForKey({ code: 'Enter', ctrlKey: false, shiftKey: false, altKey: false, metaKey: false }) as Command;
    expect(enter.enabled?.(h.store.getState())).toBe(true);
    runCommand(enter, { store: h.store, app: h.app });
    expect(h.store.getState().vectorEdit?.id).toBe(made.id);
    expect(getCommand('object.editVector')?.checked?.(h.store.getState())).toBe(true);
    runCommand(enter, { store: h.store, app: h.app });
    expect(h.store.getState().vectorEdit).toBeNull();
    // The menu and the panel have it as "Edit points".
    h.run('object.editVector');
    expect(h.store.getState().vectorEdit?.id).toBe(made.id);

    // With text selected, the same key edits the text instead.
    const text = addLayer(made.doc, 'TEXT', pageOf(made.doc), { characters: 'Hi' });
    const other = editor(text.doc);
    other.store.getState().setSelection([text.id]);
    runCommand(enter, { store: other.store, app: other.app });
    expect(other.store.getState().editingTextId).toBe(text.id);
    expect(other.store.getState().vectorEdit).toBeNull();
    expect(getCommand('object.editVector')?.enabled?.(other.store.getState())).toBe(false);
    // And with a plain shape selected it does nothing.
    const rect = addLayer(made.doc, 'RECTANGLE', pageOf(made.doc), {});
    const third = editor(rect.doc);
    third.store.getState().setSelection([rect.id]);
    expect(enter.enabled?.(third.store.getState())).toBe(false);
  });

  it('selects points by clicking, Shift-clicking and dragging a box round them', () => {
    const h = editingSquare();
    h.click(100, 100);
    expect(h.store.getState().vectorEdit?.vertices).toEqual([0]);
    h.click(200, 200, { shiftKey: true });
    expect(h.store.getState().vectorEdit?.vertices).toEqual([0, 2]);
    h.click(100, 100, { shiftKey: true });
    expect(h.store.getState().vectorEdit?.vertices).toEqual([2]);
    // Clicking one of several selected points keeps just that one.
    h.click(100, 100, { shiftKey: true });
    h.click(200, 200);
    expect(h.store.getState().vectorEdit?.vertices).toEqual([2]);
    // Empty space clears.
    h.click(400, 400);
    expect(h.store.getState().vectorEdit?.vertices).toEqual([]);
    expect(h.store.getState().vectorEdit?.id).toBe(h.id);

    h.controller.pointerDown(ptr(80, 80));
    h.controller.pointerMove(ptr(210, 120));
    expect(h.controller.marquee).toEqual({ x: 80, y: 80, width: 130, height: 40 });
    h.controller.pointerUp(ptr(210, 120));
    expect(h.controller.marquee).toBeNull();
    expect(h.store.getState().vectorEdit?.vertices).toEqual([0, 1]);
    // With Shift a box adds to what is selected.
    h.drag([80, 180], [120, 220], { shiftKey: true });
    expect(h.store.getState().vectorEdit?.vertices).toEqual([0, 1, 3]);
    expect(h.labels()).toEqual([]);

    h.run('edit.selectAll');
    expect(h.store.getState().vectorEdit?.vertices).toEqual([0, 1, 2, 3]);
  });

  it('moves points by dragging them, as one undo step', () => {
    const h = editingSquare();
    h.drag([100, 100], [70, 60]);
    expect(h.points()).toEqual([
      { x: 70, y: 60 },
      { x: 200, y: 100 },
      { x: 200, y: 200 },
      { x: 100, y: 200 },
    ]);
    // The layer's box follows its curves.
    expect(h.vector()).toMatchObject({ x: 70, y: 60, width: 130, height: 140 });
    expect(h.labels()).toEqual(['Move points']);
    h.store.getState().undo();
    expect(h.vector()).toMatchObject({ x: 100, y: 100, width: 100, height: 100 });
    expect(h.store.getState().vectorEdit?.id).toBe(h.id);

    // Several at once, and Shift keeps the move to one direction.
    h.click(200, 100);
    h.click(200, 200, { shiftKey: true });
    h.drag([200, 200], [240, 215], { shiftKey: true });
    expect(h.points()).toEqual([
      { x: 100, y: 100 },
      { x: 240, y: 100 },
      { x: 240, y: 200 },
      { x: 100, y: 200 },
    ]);

    // The arrow keys move the selected points too.
    h.run('edit.nudgeDown');
    h.run('edit.bigNudgeLeft');
    expect(h.points()[1]).toEqual({ x: 230, y: 101 });
    expect(h.points()[0]).toEqual({ x: 100, y: 100 });
    expect(h.labels().slice(-2)).toEqual(['Move points', 'Move points']);
  });

  it('moves a segment by dragging it', () => {
    const h = editingSquare();
    h.drag([150, 101], [150, 81]);
    expect(h.store.getState().vectorEdit?.vertices).toEqual([0, 1]);
    expect(h.points()).toEqual([
      { x: 100, y: 80 },
      { x: 200, y: 80 },
      { x: 200, y: 200 },
      { x: 100, y: 200 },
    ]);
    expect(h.vector()).toMatchObject({ y: 80, height: 120 });
  });

  it('turns a corner into a smooth point and back with Ctrl-click, and pulls handles out with Ctrl-drag', () => {
    const h = editingSquare();
    h.click(200, 200, { ctrlKey: true });
    expect(h.labels()).toEqual(['Change point type']);
    expect(mirroringAt(h.vector().network, 2)).toBe('ANGLE_AND_LENGTH');
    expect(h.points()[2]).toEqual({ x: 200, y: 200 });
    h.click(200, 200, { ctrlKey: true });
    expect(h.vector().network).toEqual(square());

    h.drag([200, 100], [240, 100], { ctrlKey: true });
    expect(h.labels().at(-1)).toBe('Edit curve');
    // The drag is the way the path leaves; it arrives from the opposite side.
    expect(h.vector().network.segments[1]?.tangentStart).toEqual({ x: 40, y: 0 });
    expect(h.vector().network.segments[0]?.tangentEnd).toEqual({ x: -40, y: 0 });
    expect(h.store.getState().vectorEdit?.vertices).toEqual([1]);
  });

  it('reshapes a curve by dragging a handle; Alt moves it without its partner', () => {
    const h = editingSquare();
    h.drag([200, 100], [240, 100], { ctrlKey: true });
    // The handle that was pulled out now ends at (240, 100).
    h.drag([240, 100], [240, 140]);
    expect(h.vector().network.segments[1]?.tangentStart).toEqual({ x: 40, y: 40 });
    expect(h.vector().network.segments[0]?.tangentEnd).toEqual({ x: -40, y: -40 });
    expect(h.labels().at(-1)).toBe('Edit curve');
    expect(h.points()[1]).toEqual({ x: 200, y: 100 });

    h.drag([240, 140], [260, 100], { altKey: true });
    // (The layer's box moved when the curve bulged out of it, and its position is kept to a thousandth of a pixel.)
    expect(h.vector().network.segments[1]?.tangentStart.x).toBeCloseTo(60, 2);
    expect(h.vector().network.segments[1]?.tangentStart.y).toBeCloseTo(0, 2);
    expect(h.vector().network.segments[0]?.tangentEnd).toEqual({ x: -40, y: -40 });
    expect(mirroringAt(h.vector().network, 1)).toBe('NONE');
  });

  it('deletes the selected points, not the layer, and joins two ends', () => {
    const h = editingSquare();
    // Nothing selected: Delete does nothing while points are being edited.
    h.run('edit.delete');
    expect(h.store.getState().doc.nodes[h.id]).toBeDefined();
    expect(h.labels()).toEqual([]);

    h.click(100, 200);
    h.run('edit.delete');
    expect(h.vector().network.vertices).toHaveLength(3);
    expect(networkGeometry(h.vector().network).closed).toBe(true);
    expect(h.store.getState().vectorEdit).toEqual({ id: h.id, vertices: [] });
    expect(h.labels()).toEqual(['Delete points']);

    // Deleting every point removes the layer, and undo brings it back.
    h.run('edit.selectAll');
    h.run('edit.delete');
    expect(h.store.getState().doc.nodes[h.id]).toBeUndefined();
    expect(h.store.getState().vectorEdit).toBeNull();
    expect(h.store.getState().selection).toEqual([]);
    h.store.getState().undo();
    expect(h.store.getState().doc.nodes[h.id]).toBeDefined();

    const open = withVector(new NetworkBuilder().moveTo(0, 0).lineTo(100, 0).lineTo(100, 100).build(), { x: 50, y: 50 });
    const other = editor(open.doc);
    other.store.getState().setVectorEdit({ id: open.id, vertices: [0] });
    expect(getCommand('vector.join')?.enabled?.(other.store.getState())).toBe(false);
    other.store.getState().setVectorEdit({ id: open.id, vertices: [0, 2] });
    const join = commandForKey({ code: 'KeyJ', ctrlKey: true, shiftKey: false, altKey: false, metaKey: false });
    expect(join?.id).toBe('vector.join');
    other.run('vector.join');
    expect(networkGeometry(other.vector().network).closed).toBe(true);
    expect(other.labels()).toEqual(['Join points']);
  });

  it('makes points smooth or corners from the commands', () => {
    const h = editingSquare();
    expect(getCommand('vector.smooth')?.enabled?.(h.store.getState())).toBe(false);
    h.run('edit.selectAll');
    h.run('vector.smooth');
    expect(h.vector().network.segments.every((s) => s.tangentStart.x !== 0 || s.tangentStart.y !== 0)).toBe(true);
    // Rounder than the square it was: the box has grown.
    expect(h.vector().width).toBeGreaterThan(100);
    h.run('vector.corner');
    expect(h.vector().network.segments.every((s) => s.tangentStart.x === 0 && s.tangentStart.y === 0)).toBe(true);
    expect(h.vector()).toMatchObject({ x: 100, y: 100, width: 100, height: 100 });
    expect(h.labels()).toEqual(['Smooth points', 'Corner points']);
  });

  it('leaves point editing step by step with Escape', () => {
    const h = editingSquare();
    h.click(100, 100);
    h.run('edit.deselect');
    expect(h.store.getState().vectorEdit).toEqual({ id: h.id, vertices: [] });
    h.run('edit.deselect');
    expect(h.store.getState().vectorEdit).toBeNull();
    expect(h.store.getState().selection).toEqual([h.id]);
    h.run('edit.deselect');
    expect(h.store.getState().selection).toEqual([]);
  });

  it('ends point editing when the layer is no longer the selection or is gone', () => {
    const h = editingSquare();
    const rect = addLayer(h.store.getState().doc, 'RECTANGLE', pageOf(h.store.getState().doc), { x: 500, y: 300 });
    h.store.getState().apply('Add', () => rect.doc);
    expect(h.store.getState().vectorEdit?.id).toBe(h.id);
    h.store.getState().setSelection([rect.id]);
    expect(h.store.getState().vectorEdit).toBeNull();

    h.store.getState().setVectorEdit({ id: h.id, vertices: [1, 1, 9, -1] });
    expect(h.store.getState().vectorEdit).toEqual({ id: h.id, vertices: [1] });
    expect(h.store.getState().selection).toEqual([h.id]);
    // A drawing tool other than the pen ends it; the hand does not.
    h.store.getState().setTool('hand');
    expect(h.store.getState().vectorEdit).not.toBeNull();
    h.store.getState().setTool('rectangle');
    expect(h.store.getState().vectorEdit).toBeNull();

    // Only vectors can be edited this way.
    h.store.getState().setTool('move');
    h.store.getState().setVectorEdit({ id: rect.id, vertices: [] });
    expect(h.store.getState().vectorEdit).toBeNull();
  });

  it('draws every point, and the handles of the selected ones', () => {
    const h = editingSquare();
    h.drag([200, 100], [240, 100], { ctrlKey: true });
    const calls: string[] = [];
    const target: Record<string, unknown> = {};
    const ctx = new Proxy(target, {
      get(obj, prop: string) {
        if (prop in obj) return obj[prop];
        if (prop === 'measureText') return () => ({ width: 10 });
        return () => {
          calls.push(prop);
        };
      },
      set(obj, prop: string, value) {
        obj[prop] = value;
        return true;
      },
    }) as unknown as CanvasRenderingContext2D;
    const state = h.store.getState();
    renderOverlay(ctx, {
      doc: state.doc,
      pageId: state.pageId,
      viewport: state.viewport,
      size: state.canvasSize,
      dpr: 1,
      selection: state.selection,
      hoveredId: null,
      marquee: null,
      showHandles: false,
      vector: h.controller.vectorOverlay(),
    });
    // Four points as squares, and two round handle knobs on the selected point.
    expect(calls.filter((call) => call === 'rect')).toHaveLength(4);
    expect(calls.filter((call) => call === 'arc')).toHaveLength(2);
  });
});
