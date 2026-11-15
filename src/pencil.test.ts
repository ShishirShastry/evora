import { describe, expect, it } from 'vitest';
import {
  addLayer,
  applyToPoint,
  createDocument,
  cubicAt,
  distanceToNetwork,
  fitCurve,
  getPages,
  getWorldMatrix,
  invert,
  nearestOnCubic,
  networkFromStroke,
  networkGeometry,
  type Cubic,
  type Document,
  type NodeId,
  type Point,
  type VectorNode,
} from './core';
import { InteractionController, type PointerInput } from './engine/input/controller';
import { commandForKey, getCommand, runCommand, type AppActions, type Command } from './state/commands';
import { createEditorStore, type EditorStore } from './state/editorStore';

/** How far a point is from the nearest of some curves. */
function distanceToCurves(curves: readonly Cubic[], p: Point): number {
  return Math.min(...curves.map((curve) => nearestOnCubic(curve, p).distance));
}

const circle = (radius: number, count: number, turns = 1): Point[] =>
  Array.from({ length: count + 1 }, (_, i) => {
    const angle = (i / count) * Math.PI * 2 * turns;
    return { x: 200 + Math.cos(angle) * radius, y: 200 + Math.sin(angle) * radius };
  });

describe('fitting curves to a stroke', () => {
  it('finds a curve that was sampled, with hardly more segments than it had', () => {
    const arch: Cubic = { p0: { x: 0, y: 0 }, p1: { x: 20, y: 120 }, p2: { x: 180, y: 120 }, p3: { x: 200, y: 0 } };
    const points = Array.from({ length: 61 }, (_, i) => cubicAt(arch, i / 60));
    const curves = fitCurve(points, 0.5);
    // (Not always one: the directions at the ends are judged from the first and last two points, which is slightly off for a curve.)
    expect(curves.length).toBeLessThanOrEqual(3);
    expect(curves[0]?.p0).toEqual(arch.p0);
    expect(curves.at(-1)?.p3).toEqual(arch.p3);
    for (const p of points) expect(distanceToCurves(curves, p)).toBeLessThanOrEqual(0.5);
  });

  it('fits a straight run of points with a straight segment', () => {
    const points = Array.from({ length: 50 }, (_, i) => ({ x: 10 + i * 3, y: 20 + i * 1.5 }));
    const curves = fitCurve(points, 1);
    expect(curves).toHaveLength(1);
    // (The nearest point on a curve is found numerically, to about a thousandth.)
    for (const p of points) expect(distanceToCurves(curves, p)).toBeLessThan(0.01);
    expect(fitCurve([points[0] as Point, points[1] as Point], 1)).toEqual([{ p0: points[0], p1: points[0], p2: points[1], p3: points[1] }]);
  });

  it('fits a circle with a handful of segments, joined smoothly', () => {
    const points = circle(100, 200);
    const curves = fitCurve(points, 1);
    expect(curves.length).toBeGreaterThanOrEqual(3);
    expect(curves.length).toBeLessThanOrEqual(12);
    for (const p of points) expect(distanceToCurves(curves, p)).toBeLessThanOrEqual(1);
    // Each segment starts where the one before ended, and leaves in the direction that one arrived.
    for (let i = 1; i < curves.length; i++) {
      const before = curves[i - 1] as Cubic;
      const after = curves[i] as Cubic;
      expect(after.p0).toEqual(before.p3);
      const arriving = Math.atan2(before.p3.y - before.p2.y, before.p3.x - before.p2.x);
      const leaving = Math.atan2(after.p1.y - after.p0.y, after.p1.x - after.p0.x);
      expect(Math.cos(arriving - leaving)).toBeCloseTo(1, 6);
    }
    // A tighter tolerance needs more segments.
    expect(fitCurve(points, 0.05).length).toBeGreaterThan(curves.length);
  });

  it('stays within the tolerance of every point of a jagged stroke', () => {
    const points: Point[] = [];
    for (let i = 0; i <= 120; i++) {
      // A zigzag with sharp turns every 30 points, and some wobble.
      const leg = Math.floor(i / 30);
      const along = (i % 30) / 30;
      const y = leg % 2 === 0 ? along * 80 : 80 - along * 80;
      points.push({ x: i * 4, y: y + Math.sin(i * 1.7) * 0.8 });
    }
    for (const tolerance of [4, 2, 0.5]) {
      const curves = fitCurve(points, tolerance);
      for (const p of points) expect(distanceToCurves(curves, p)).toBeLessThanOrEqual(tolerance + 1e-6);
    }
    expect(fitCurve(points, 4).length).toBeLessThan(fitCurve(points, 0.5).length);
  });

  it('needs two different points', () => {
    expect(fitCurve([], 1)).toEqual([]);
    expect(fitCurve([{ x: 5, y: 5 }], 1)).toEqual([]);
    expect(fitCurve([{ x: 5, y: 5 }, { x: 5, y: 5 }, { x: 5, y: 5 }], 1)).toEqual([]);
  });

  it('turns a stroke into a path, closing it when it ends where it began', () => {
    const wave = Array.from({ length: 81 }, (_, i) => ({ x: i * 5, y: 100 + Math.sin(i / 8) * 40 }));
    const open = networkFromStroke(wave, 1, 8);
    expect(networkGeometry(open).chains).toHaveLength(1);
    expect(networkGeometry(open).closed).toBe(false);
    expect(open.vertices[0]).toEqual({ x: 0, y: 100 });
    expect(open.vertices.at(-1)).toEqual({ x: 400, y: Math.round((100 + Math.sin(10) * 40) * 100) / 100 });
    expect(open.segments.length).toBeLessThan(12);
    for (const p of wave) expect(distanceToNetwork(open, p)).toBeLessThanOrEqual(1.11);

    // Round the circle and back to within a few pixels of the start.
    const loop = circle(100, 120).slice(0, -3);
    const closed = networkFromStroke(loop, 1, 20);
    expect(networkGeometry(closed).closed).toBe(true);
    expect(closed.vertices).toHaveLength(closed.segments.length);
    // Without the allowance it stays open.
    expect(networkGeometry(networkFromStroke(loop, 1, 0)).closed).toBe(false);
    // A scribble that never left the neighbourhood of its start is not a shape.
    const scribble = [
      { x: 0, y: 0 },
      { x: 6, y: 3 },
      { x: 9, y: -4 },
      { x: 3, y: -6 },
      { x: 1, y: 1 },
    ];
    expect(networkGeometry(networkFromStroke(scribble, 1, 20)).closed).toBe(false);
    expect(networkFromStroke([], 1, 8)).toEqual({ vertices: [], segments: [] });
    // One point is not a path: nothing is made of it, not even a point.
    expect(networkFromStroke([{ x: 1, y: 1 }], 1, 8)).toEqual({ vertices: [], segments: [] });
  });
});

describe('the Pencil tool', () => {
  const ptr = (x: number, y: number): PointerInput => ({ x, y, button: 0, shiftKey: false, altKey: false, ctrlKey: false, detail: 1 });

  function editor(doc: Document = createDocument('Pencil')): { store: EditorStore; controller: InteractionController; app: AppActions } {
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

  /** Draws through the given canvas points with the pointer held down. */
  function stroke(controller: InteractionController, points: readonly Point[], release = true): void {
    const first = points[0] as Point;
    controller.pointerDown(ptr(first.x, first.y));
    for (const p of points.slice(1)) controller.pointerMove(ptr(p.x, p.y));
    const last = points[points.length - 1] as Point;
    if (release) controller.pointerUp(ptr(last.x, last.y));
  }

  const vectors = (store: EditorStore): VectorNode[] =>
    Object.values(store.getState().doc.nodes).filter((node): node is VectorNode => node.type === 'VECTOR');

  const wave = (): Point[] => Array.from({ length: 101 }, (_, i) => ({ x: 100 + i * 4, y: 300 + Math.sin(i / 10) * 60 }));

  it('draws a smooth path through where the pointer went', () => {
    const { store, controller } = editor();
    store.getState().setTool('pencil');
    const drawn = wave();
    stroke(controller, drawn, false);
    // While the pencil is down the stroke is shown as drawn, point for point.
    expect(vectors(store)).toHaveLength(1);
    expect(vectors(store)[0]?.network.vertices).toHaveLength(drawn.length);
    expect(store.getState().undoStack).toEqual([]);

    const last = drawn[drawn.length - 1] as Point;
    controller.pointerUp(ptr(last.x, last.y));
    const state = store.getState();
    const [vector] = vectors(store);
    expect(vector).toBeDefined();
    expect(state.selection).toEqual([vector?.id]);
    expect(state.undoStack.map((entry) => entry.label)).toEqual(['Draw with pencil']);
    // The pencil stays in hand for the next stroke, and its lines have round ends.
    expect(state.tool).toBe('pencil');
    expect(vector).toMatchObject({ name: 'Vector 1', strokeCap: 'ROUND', strokeJoin: 'ROUND', fills: [] });

    // A hundred points have become a few curves that stay within the pencil's tolerance of every one of them.
    const network = (vector as VectorNode).network;
    expect(network.segments.length).toBeLessThan(15);
    expect(networkGeometry(network).chains).toHaveLength(1);
    const toLocal = invert(getWorldMatrix(state.doc, (vector as VectorNode).id));
    for (const p of drawn) expect(distanceToNetwork(network, applyToPoint(toLocal, p))).toBeLessThanOrEqual(2.52);
    const matrix = getWorldMatrix(state.doc, (vector as VectorNode).id);
    const start = applyToPoint(matrix, network.vertices[0] as Point);
    expect(start.x).toBeCloseTo(100, 1);
    expect(start.y).toBeCloseTo(300, 1);

    state.undo();
    expect(vectors(store)).toEqual([]);
    expect(store.getState().selection).toEqual([]);
  });

  it('draws nothing for a click, and each stroke is a layer of its own', () => {
    const { store, controller } = editor();
    store.getState().setTool('pencil');
    controller.pointerDown(ptr(200, 200));
    controller.pointerUp(ptr(200, 200));
    expect(vectors(store)).toEqual([]);
    expect(store.getState().undoStack).toEqual([]);
    expect(controller.isBusy).toBe(false);

    stroke(controller, [
      { x: 100, y: 100 },
      { x: 150, y: 100 },
      { x: 200, y: 100 },
    ]);
    stroke(controller, [
      { x: 100, y: 200 },
      { x: 150, y: 230 },
      { x: 200, y: 200 },
    ]);
    expect(vectors(store).map((vector) => vector.name).sort()).toEqual(['Vector 1', 'Vector 2']);
    // A straight stroke is one straight segment.
    const straight = vectors(store).find((vector) => vector.name === 'Vector 1') as VectorNode;
    expect(straight).toMatchObject({ x: 100, y: 100, width: 100, height: 0 });
    expect(straight.network.segments).toHaveLength(1);
  });

  it('closes a stroke that comes back to where it started', () => {
    const { store, controller } = editor();
    store.getState().setTool('pencil');
    // Round a circle, stopping 7 pixels short of the start.
    const loop = Array.from({ length: 90 }, (_, i) => {
      const angle = (i / 90) * Math.PI * 2;
      return { x: 300 + Math.cos(angle) * 100, y: 300 + Math.sin(angle) * 100 };
    });
    stroke(controller, loop);
    const [vector] = vectors(store);
    expect(networkGeometry((vector as VectorNode).network).closed).toBe(true);
    expect((vector as VectorNode).width).toBeGreaterThan(195);
    expect((vector as VectorNode).width).toBeLessThan(205);
  });

  it('puts the stroke in the frame it starts over, and gives it up when cancelled', () => {
    const doc = createDocument('Pencil');
    const frame = addLayer(doc, 'FRAME', (getPages(doc)[0] as { id: NodeId }).id, { x: 100, y: 100, width: 400, height: 300 });
    const { store, controller } = editor(frame.doc);
    store.getState().setTool('pencil');
    stroke(controller, [
      { x: 150, y: 150 },
      { x: 200, y: 180 },
      { x: 260, y: 150 },
    ]);
    const [vector] = vectors(store);
    expect(vector?.parentId).toBe(frame.id);
    expect(vector).toMatchObject({ x: 50, y: 50, width: 110 });

    stroke(
      controller,
      [
        { x: 150, y: 250 },
        { x: 200, y: 280 },
        { x: 260, y: 250 },
      ],
      false,
    );
    expect(vectors(store)).toHaveLength(2);
    expect(controller.cancel()).toBe(true);
    expect(vectors(store)).toHaveLength(1);
    expect(store.getState().undoStack).toHaveLength(1);
  });

  it('follows the stroke more closely when zoomed in', () => {
    const { store, controller } = editor();
    store.getState().setViewport({ x: 0, y: 0, zoom: 4 });
    store.getState().setTool('pencil');
    // On screen this wobbles by 12 pixels; on the page that is only 3 units, which a fixed tolerance would iron flat.
    const drawn = Array.from({ length: 81 }, (_, i) => ({ x: 100 + i * 6, y: 300 + Math.sin(i / 4) * 12 }));
    stroke(controller, drawn);
    const [vector] = vectors(store);
    expect((vector as VectorNode).height).toBeGreaterThan(5);
    expect((vector as VectorNode).network.segments.length).toBeGreaterThan(4);
  });

  it('is picked up with Shift+P, which ends any point editing', () => {
    const { store, controller, app } = editor();
    const command = commandForKey({ code: 'KeyP', ctrlKey: false, shiftKey: true, altKey: false, metaKey: false });
    expect(command?.id).toBe('tool.pencil');
    expect(commandForKey({ code: 'KeyP', ctrlKey: false, shiftKey: false, altKey: false, metaKey: false })?.id).toBe('tool.pen');
    runCommand(command as Command, { store, app });
    expect(store.getState().tool).toBe('pencil');
    expect(controller.idleCursor()).toBe('crosshair');

    stroke(controller, [
      { x: 100, y: 100 },
      { x: 150, y: 120 },
      { x: 200, y: 100 },
    ]);
    const [vector] = vectors(store);
    store.getState().setTool('move');
    runCommand(getCommand('object.editVector') as Command, { store, app });
    expect(store.getState().vectorEdit?.id).toBe(vector?.id);
    runCommand(command as Command, { store, app });
    expect(store.getState().vectorEdit).toBeNull();
    // Escape puts the pencil down.
    runCommand(getCommand('edit.deselect') as Command, { store, app });
    expect(store.getState().tool).toBe('move');
  });
});
