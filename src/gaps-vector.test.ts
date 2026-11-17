import { describe, expect, it } from 'vitest';
import {
  applyToPoint,
  createDocument,
  createLayer,
  cubicAt,
  fitVectorNode,
  getPages,
  getWorldMatrix,
  NetworkBuilder,
  nearestOnCubic,
  networkGeometry,
  pointInNetworkFill,
  segmentCubic,
  segmentsOfPaths,
  setNodes,
  shownHandles,
  solidPaint,
  splitAtCrossings,
  splitIntersections,
  type Document,
  type NodeId,
  type Point,
  type VectorNetwork,
  type VectorNode,
} from './core';
import { freshKeys } from './core/order';
import { InteractionController, type PointerInput } from './engine/input/controller';
import { renderOverlay } from './engine/render/overlay';
import { getCommand, runCommand, type AppActions, type Command } from './state/commands';
import { createEditorStore, type EditorStore } from './state/editorStore';
import { mainMenu } from './ui/editor/menus';

type Mods = Partial<Pick<PointerInput, 'shiftKey' | 'altKey' | 'ctrlKey' | 'detail'>>;

const ptr = (x: number, y: number, mods: Mods = {}): PointerInput => ({ x, y, button: 0, shiftKey: false, altKey: false, ctrlKey: false, detail: 1, ...mods });

const app: AppActions = {
  cancelInteraction: () => false,
  openShortcuts: () => undefined,
  saveNow: () => undefined,
  saveAs: () => undefined,
  placeImage: () => undefined,
  goHome: () => undefined,
};

/** An editor with a real store and controller. The view is not scrolled or zoomed, so canvas pixels are page units. */
function editor(doc: Document) {
  const store: EditorStore = createEditorStore(doc);
  store.getState().setCanvasSize({ width: 800, height: 600 });
  const controller = new InteractionController(store, { requestRender: () => undefined, setCursor: () => undefined });
  const vector = (): VectorNode => {
    const state = store.getState();
    return state.doc.nodes[(state.vectorEdit?.id ?? state.selection[0]) as NodeId] as VectorNode;
  };
  return {
    store,
    controller,
    vector,
    click(x: number, y: number, mods?: Mods) {
      controller.pointerDown(ptr(x, y, mods));
      controller.pointerUp(ptr(x, y, mods));
    },
    drag(from: [number, number], to: [number, number], mods?: Mods) {
      controller.pointerDown(ptr(from[0], from[1], mods));
      controller.pointerMove(ptr((from[0] + to[0]) / 2, (from[1] + to[1]) / 2, mods));
      controller.pointerMove(ptr(to[0], to[1], mods));
      controller.pointerUp(ptr(to[0], to[1], mods));
    },
    run: (id: string) => runCommand(getCommand(id) as Command, { store, app }),
    /** The vector's points, in page space. */
    points(): Point[] {
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

/** A document with one vector layer whose curves are `network`, placed so its box starts at (x, y). */
function withVector(network: VectorNetwork, props: Partial<VectorNode> = {}): { doc: Document; id: NodeId } {
  const doc = createDocument('Vectors');
  const page = (getPages(doc)[0] as { id: NodeId }).id;
  const bounds = networkGeometry(network).bounds ?? { width: 0, height: 0 };
  const node = createLayer('VECTOR', page, freshKeys(1)[0] as string, { width: bounds.width, height: bounds.height, ...props, network }) as VectorNode;
  return { doc: setNodes(doc, { [node.id]: fitVectorNode(node) }), id: node.id };
}

const square = (): VectorNetwork => new NetworkBuilder().moveTo(0, 0).lineTo(100, 0).lineTo(100, 100).lineTo(0, 100).close().build();


describe('splitting a vector where its segments cross', () => {
  it('puts one shared point where two straight segments cross and cuts both', () => {
    const cross = new NetworkBuilder().moveTo(0, 0).lineTo(100, 100).moveTo(100, 0).lineTo(0, 100).build();
    const { network, crossings } = splitAtCrossings(cross);
    expect(crossings).toEqual([4]);
    expect(network.vertices[4]).toEqual({ x: 50, y: 50 });
    expect(network.segments).toHaveLength(4);
    // Every segment now ends or starts at the crossing, and all stay straight.
    expect(network.segments.every((s) => s.start === 4 || s.end === 4)).toBe(true);
    expect(network.segments.every((s) => s.tangentStart.x === 0 && s.tangentEnd.y === 0)).toBe(true);
  });

  it('finds where curves cross to a hundredth of a pixel, and keeps their exact shape', () => {
    // An arch whose top is at y = 75, crossed by a horizontal line at y = 50.
    const arch = new NetworkBuilder().moveTo(0, 0).curveTo(0, 100, 100, 100, 100, 0).moveTo(-10, 50).lineTo(110, 50).build();
    const original = segmentCubic(arch, 0);
    const { network, crossings } = splitAtCrossings(arch);
    expect(crossings).toHaveLength(2);
    for (const vertex of crossings) {
      const p = network.vertices[vertex] as Point;
      expect(Math.abs(p.y - 50)).toBeLessThan(0.01);
      expect(nearestOnCubic(original, p).distance).toBeLessThan(0.01);
    }
    // The arch is now three curves and the line three straight pieces.
    expect(network.segments).toHaveLength(6);
    // Every piece of the arch lies on the original curve.
    for (let i = 0; i < network.segments.length; i++) {
      const piece = segmentCubic(network, i);
      if (piece.p1.y === piece.p0.y && piece.p2.y === piece.p3.y && piece.p0.y === 50) continue;
      for (const t of [0.25, 0.5, 0.75]) {
        const on = cubicAt(piece, t);
        if (Math.abs(on.y - 50) < 1e-9) continue;
        expect(nearestOnCubic(original, on).distance).toBeLessThan(0.01);
      }
    }
  });

  it('makes the regions of a shape crossed by a line come out right', () => {
    // A square with a line running through it from side to side, beyond its edges.
    const crossed = new NetworkBuilder().moveTo(0, 0).lineTo(100, 0).lineTo(100, 100).lineTo(0, 100).close().moveTo(-20, 50).lineTo(120, 50).build();
    const { network, crossings } = splitAtCrossings(crossed);
    expect(crossings).toHaveLength(2);
    expect(crossings.map((v) => network.vertices[v])).toEqual(expect.arrayContaining([{ x: 0, y: 50 }, { x: 100, y: 50 }]));
    // The network now branches at the crossings, and both halves of the square are regions of their own.
    const loops = networkGeometry(network).loops;
    expect(loops).toHaveLength(2);
    expect(pointInNetworkFill(network, { x: 50, y: 25 }, 'NONZERO')).toBe(true);
    expect(pointInNetworkFill(network, { x: 50, y: 75 }, 'NONZERO')).toBe(true);
    expect(pointInNetworkFill(network, { x: 110, y: 40 }, 'NONZERO')).toBe(false);
  });

  it('leaves segments that only meet at their ends alone, and joins an end that lies on another segment', () => {
    const plain = square();
    expect(splitAtCrossings(plain).network).toBe(plain);
    expect(splitAtCrossings(plain).crossings).toEqual([]);

    // A line that stops on the square's bottom edge: the edge is cut there and the line's end becomes that point.
    const touching = new NetworkBuilder().moveTo(0, 0).lineTo(100, 0).lineTo(100, 100).lineTo(0, 100).close().moveTo(50, 50).lineTo(50, 100).build();
    const { network, crossings } = splitAtCrossings(touching);
    expect(network.vertices).toHaveLength(touching.vertices.length);
    expect(crossings).toHaveLength(1);
    expect(network.vertices[crossings[0] as number]).toEqual({ x: 50, y: 100 });
    expect(network.segments).toHaveLength(touching.segments.length + 1);
  });

  it('splits only the paths that are asked for', () => {
    // Two separate crosses, side by side.
    const two = new NetworkBuilder().moveTo(0, 50).lineTo(100, 50).moveTo(50, 0).lineTo(50, 100).moveTo(150, 50).lineTo(250, 50).moveTo(200, 0).lineTo(200, 100).build();
    expect(segmentsOfPaths(two, [0])).toEqual([0]);
    const first = splitAtCrossings(two, segmentsOfPaths(two, [0]));
    expect(first.crossings).toHaveLength(1);
    expect(first.network.vertices[first.crossings[0] as number]).toEqual({ x: 50, y: 50 });
    expect(splitAtCrossings(two).crossings).toHaveLength(2);
  });

  it('is a command in the Object menu that splits the selected vector in one undo step', () => {
    const two = new NetworkBuilder().moveTo(0, 50).lineTo(100, 50).moveTo(50, 0).lineTo(50, 100).moveTo(150, 50).lineTo(250, 50).moveTo(200, 0).lineTo(200, 100).build();
    const made = withVector(two, { x: 100, y: 100 });
    const h = editor(made.doc);
    const command = getCommand('object.splitIntersections') as Command;
    expect(command.label).toBe('Split at intersections');
    const object = mainMenu({ store: h.store, app }, h.store.getState(), { renameFile: () => undefined }).find((item) => 'label' in item && item.label === 'Object');
    expect(JSON.stringify(object)).toContain('Split at intersections');

    // Nothing selected: nothing to split.
    expect(command.enabled?.(h.store.getState())).toBe(false);
    h.store.getState().setSelection([made.id]);
    expect(command.enabled?.(h.store.getState())).toBe(true);
    const before = h.vector().network;
    h.run('object.splitIntersections');
    expect(h.labels()).toEqual(['Split at intersections']);
    expect(h.vector().network.vertices).toHaveLength(10);
    expect(h.vector().network.segments).toHaveLength(8);
    expect(h.points().slice(8)).toEqual([
      { x: 150, y: 150 },
      { x: 300, y: 150 },
    ]);
    h.store.getState().undo();
    expect(h.vector().network).toEqual(before);
    h.store.getState().redo();
    expect(h.vector().network.vertices).toHaveLength(10);

    // Running it again finds nothing more to split and adds no undo step.
    h.run('object.splitIntersections');
    expect(h.labels()).toEqual(['Split at intersections']);
  });

  it('while editing points, splits the paths of the selected points and selects the new points', () => {
    const two = new NetworkBuilder().moveTo(0, 50).lineTo(100, 50).moveTo(50, 0).lineTo(50, 100).moveTo(150, 50).lineTo(250, 50).moveTo(200, 0).lineTo(200, 100).build();
    const made = withVector(two, { x: 100, y: 100 });
    const h = editor(made.doc);
    h.store.getState().setVectorEdit({ id: made.id, vertices: [4] });
    h.run('object.splitIntersections');
    expect(h.vector().network.vertices).toHaveLength(9);
    expect(h.points()[8]).toEqual({ x: 300, y: 150 });
    expect(h.store.getState().vectorEdit?.vertices).toEqual([8]);

    // The document operation leaves a document without crossings unchanged.
    const plain = withVector(square());
    expect(splitIntersections(plain.doc, [plain.id])).toBeNull();
  });
});

/** An editor on a filled 100 × 100 square at (100, 100), with its points open for editing. */
function editingSquare() {
  const made = withVector(square(), { x: 100, y: 100, fills: [solidPaint({ r: 0.5, g: 0.5, b: 0.5 })] });
  const h = editor(made.doc);
  h.store.getState().setVectorEdit({ id: made.id, vertices: [] });
  return { ...h, id: made.id };
}

describe('undo while editing points', () => {
  it('brings back the points that were selected, and redo the ones that were selected after', () => {
    const h = editingSquare();
    h.click(200, 100);
    h.drag([200, 100], [220, 100]);
    expect(h.labels()).toEqual(['Move points']);
    // Another point is selected after the move.
    h.click(100, 200);
    expect(h.store.getState().vectorEdit?.vertices).toEqual([3]);
    h.store.getState().undo();
    expect(h.points()[1]).toEqual({ x: 200, y: 100 });
    expect(h.store.getState().vectorEdit?.vertices).toEqual([1]);
    h.store.getState().redo();
    expect(h.points()[1]).toEqual({ x: 220, y: 100 });
    expect(h.store.getState().vectorEdit?.vertices).toEqual([3]);
  });

  it('brings back the points that the arrow keys moved', () => {
    const h = editingSquare();
    h.store.getState().setVectorEdit({ id: h.id, vertices: [0, 2] });
    h.run('edit.nudgeRight');
    h.store.getState().setVectorEdit({ id: h.id, vertices: [1] });
    h.store.getState().undo();
    expect(h.store.getState().vectorEdit?.vertices).toEqual([0, 2]);
    expect(h.points()[0]).toEqual({ x: 100, y: 100 });
  });

  it('brings back the point the pen had selected before the point it added', () => {
    const h = editingSquare();
    // A point added on a segment by double-clicking it, while point 0 was selected.
    h.click(100, 100);
    h.controller.pointerDown(ptr(150, 100, { detail: 2 }));
    h.controller.pointerUp(ptr(150, 100, { detail: 2 }));
    expect(h.labels()).toEqual(['Add point']);
    expect(h.store.getState().vectorEdit?.vertices).toEqual([4]);
    h.store.getState().undo();
    expect(h.vector().network.vertices).toHaveLength(4);
    expect(h.store.getState().vectorEdit?.vertices).toEqual([0]);
    h.store.getState().redo();
    expect(h.store.getState().vectorEdit?.vertices).toEqual([4]);
  });
});

describe('handles of the points next to the selected ones', () => {
  it('lists the handles at both ends of every segment that leaves a selected point', () => {
    const curve = new NetworkBuilder().moveTo(0, 0).curveTo(10, -20, 40, -20, 50, 0).lineTo(100, 0).build();
    // The end point is selected: its segment is straight, so nothing shows.
    expect(shownHandles(curve, [2])).toEqual([]);
    // The middle point: its own handle on the curve, and the far handle of that curve too.
    expect(shownHandles(curve, [1])).toEqual([
      { segment: 0, end: 'start' },
      { segment: 0, end: 'end' },
    ]);
    expect(shownHandles(curve, [0])).toEqual(shownHandles(curve, [1]));
  });

  it('shows and drags the handle of a neighbouring point', () => {
    const h = editingSquare();
    // Point 1 at (200, 100) becomes smooth; its handles reach towards (176.4, 76.4) and (223.6, 123.6).
    h.click(200, 100, { ctrlKey: true });
    // Only point 2, below it, is selected.
    h.click(200, 200);
    expect(h.store.getState().vectorEdit?.vertices).toEqual([2]);

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
    // The one handle of point 1 on the segment to point 2 is drawn.
    expect(calls.filter((call) => call === 'arc')).toHaveLength(1);

    // It can be dragged, and its partner on the other side of point 1 turns with it.
    const tip = Math.round((200 + 100 / 3 / Math.SQRT2) * 100) / 100;
    const tipY = Math.round((100 + 100 / 3 / Math.SQRT2) * 100) / 100;
    h.drag([tip, tipY], [240, 100]);
    expect(h.labels().at(-1)).toBe('Edit curve');
    const network = h.vector().network;
    expect(network.segments[1]?.tangentStart.x).toBeCloseTo(40, 1);
    expect(network.segments[1]?.tangentStart.y).toBeCloseTo(0, 1);
    expect(network.segments[0]?.tangentEnd.x).toBeCloseTo(-40, 1);
    expect(h.store.getState().vectorEdit?.vertices).toEqual([2]);
  });
});
