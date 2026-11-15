import { describe, expect, it } from 'vitest';
import {
  addLayer,
  booleanNetworks,
  booleanNodes,
  canBoolean,
  createDocument,
  createLayer,
  CURRENT_SCHEMA_VERSION,
  deeperTargetAt,
  deleteNodes,
  flattenCubic,
  flattenNodes,
  getChildIds,
  getPages,
  getWorldBounds,
  groupNodes,
  hitTestDeepest,
  intersectCubics,
  mapNetwork,
  moveNodesBy,
  NetworkBuilder,
  networkGeometry,
  normalizeGroups,
  parseFile,
  patchNode,
  pointInNetworkFill,
  segmentCubic,
  selectionTargetAt,
  setLayerBox,
  shapeNetwork,
  solidPaint,
  stepCubic,
  ungroupNodes,
  unionRects,
  validateDocument,
  type BooleanOperand,
  type BooleanOperationNode,
  type Cubic,
  type CurveCrossing,
  type Document,
  type LayerNode,
  type NodeId,
  type Point,
  type VectorNetwork,
} from './core';
import { InteractionController } from './engine/input/controller';
import { renderScene } from './engine/render/scene';
import { commandForKey, getCommand, runCommand, type AppActions, type Command } from './state/commands';
import { createEditorStore } from './state/editorStore';

const line = (x0: number, y0: number, x1: number, y1: number): Cubic => ({ p0: { x: x0, y: y0 }, p1: { x: x0, y: y0 }, p2: { x: x1, y: y1 }, p3: { x: x1, y: y1 } });

const rect = (x: number, y: number, w: number, h: number): VectorNetwork =>
  new NetworkBuilder()
    .moveTo(x, y)
    .lineTo(x + w, y)
    .lineTo(x + w, y + h)
    .lineTo(x, y + h)
    .close()
    .build();

/** A circle as four curves, like a flattened ellipse layer. */
function circle(cx: number, cy: number, r: number): VectorNetwork {
  const network = shapeNetwork(createLayer('ELLIPSE', 'p', 'a0', { width: r * 2, height: r * 2 })) as VectorNetwork;
  return mapNetwork(network, (p) => ({ x: p.x + cx - r, y: p.y + cy - r }));
}

const shape = (network: VectorNetwork, windingRule: BooleanOperand['windingRule'] = 'NONZERO'): BooleanOperand => ({ network, windingRule });

/**
 * The area a network's fill covers. A result's outlines all run with the
 * inside on the same side, so holes count against the area by themselves.
 */
function area(network: VectorNetwork): number {
  let total = 0;
  for (const loop of networkGeometry(network).loops) {
    const points: Point[] = [];
    loop.forEach((step, i) => {
      const c = stepCubic(network, step);
      if (i === 0) points.push(c.p0);
      flattenCubic(c, 0.0005, points);
    });
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      total += (points[j] as Point).x * (points[i] as Point).y - (points[i] as Point).x * (points[j] as Point).y;
    }
  }
  return Math.abs(total) / 2;
}

const corners = (network: VectorNetwork): string[] => network.vertices.map((v) => `${v.x},${v.y}`).sort();
const outlines = (network: VectorNetwork): number => networkGeometry(network).chains.length;

/** Every place two outlines cross, whichever of their segments it is on. */
function crossings(a: VectorNetwork, b: VectorNetwork): CurveCrossing[] {
  const out: CurveCrossing[] = [];
  a.segments.forEach((_, i) =>
    b.segments.forEach((__, j) => {
      for (const hit of intersectCubics(segmentCubic(a, i), segmentCubic(b, j))) {
        if (!out.some((other) => Math.hypot(other.point.x - hit.point.x, other.point.y - hit.point.y) < 1e-4)) out.push(hit);
      }
    }),
  );
  return out;
}

describe('where curves cross', () => {
  it('finds the crossing of two lines', () => {
    const hits = intersectCubics(line(0, 0, 100, 100), line(0, 100, 100, 0));
    expect(hits).toHaveLength(1);
    expect(hits[0]?.point.x).toBeCloseTo(50, 9);
    expect(hits[0]?.point.y).toBeCloseTo(50, 9);
    expect(hits[0]?.s).toBeCloseTo(0.5, 9);
    expect(hits[0]?.t).toBeCloseTo(0.5, 9);
    expect(intersectCubics(line(0, 0, 100, 0), line(0, 10, 100, 10))).toEqual([]);
    expect(intersectCubics(line(0, 0, 40, 40), line(60, 60, 100, 0))).toEqual([]);
  });

  it('finds where a line meets the end of another, and where two lines lie along each other', () => {
    // A T: the second line starts in the middle of the first.
    const tee = intersectCubics(line(0, 0, 100, 0), line(50, 0, 50, 80));
    expect(tee).toHaveLength(1);
    expect(tee[0]?.point.x).toBeCloseTo(50, 9);
    expect(tee[0]?.point.y).toBe(0);
    expect(tee[0]?.t).toBeCloseTo(0, 9);
    // Overlapping along the same line: they meet where each one's end lies on the other.
    const along = intersectCubics(line(0, 0, 100, 0), line(50, 0, 150, 0));
    expect(along.map((hit) => Math.round(hit.point.x)).sort((x, y) => x - y)).toEqual([50, 100]);
  });

  it('finds where a line crosses a curve, on the curve itself', () => {
    const arc = segmentCubic(circle(0, 0, 100), 1); // from the right-most point round to the bottom
    const hits = intersectCubics(arc, line(0, 0, 100, 100));
    expect(hits).toHaveLength(1);
    const hit = hits[0] as CurveCrossing;
    expect(hit.point.x).toBeCloseTo(hit.point.y, 6);
    expect(Math.hypot(hit.point.x, hit.point.y)).toBeCloseTo(100, 1);
    // The parameters it reports are where that point is on each of the two.
    const onLine = line(0, 0, 100, 100);
    const u = hit.t;
    expect((3 * u * u - 2 * u * u * u) * (onLine.p3.x - onLine.p0.x)).toBeCloseTo(hit.point.x, 6);
  });

  it('finds both crossings of two circles', () => {
    const hits = crossings(circle(0, 0, 50), circle(60, 0, 50));
    expect(hits).toHaveLength(2);
    const ys = hits.map((hit) => hit.point.y).sort((a, b) => a - b);
    expect(ys[0]).toBeCloseTo(-40, 1);
    expect(ys[1]).toBeCloseTo(40, 1);
    for (const hit of hits) expect(hit.point.x).toBeCloseTo(30, 1);
    expect(crossings(circle(0, 0, 50), circle(200, 0, 50))).toEqual([]);
    // One inside the other: no crossing either.
    expect(crossings(circle(0, 0, 50), circle(0, 0, 20))).toEqual([]);
  });
});

describe('boolean operations on outlines', () => {
  const a = rect(0, 0, 100, 100);
  const b = rect(50, 50, 100, 100);

  it('unites two overlapping squares into one outline', () => {
    const union = booleanNetworks([shape(a), shape(b)], 'UNION');
    expect(outlines(union)).toBe(1);
    expect(networkGeometry(union).closed).toBe(true);
    expect(area(union)).toBeCloseTo(17500, 6);
    expect(corners(union)).toEqual(['0,0', '0,100', '100,0', '100,50', '150,150', '150,50', '50,100', '50,150'].sort());
    // Every piece is still a straight line.
    expect(union.segments.every((s) => s.tangentStart.x === 0 && s.tangentStart.y === 0 && s.tangentEnd.x === 0 && s.tangentEnd.y === 0)).toBe(true);
  });

  it('keeps what two squares share', () => {
    const both = booleanNetworks([shape(a), shape(b)], 'INTERSECT');
    expect(outlines(both)).toBe(1);
    expect(area(both)).toBeCloseTo(2500, 6);
    expect(corners(both)).toEqual(['100,100', '100,50', '50,100', '50,50']);
  });

  it('takes the later shapes out of the first', () => {
    const cut = booleanNetworks([shape(a), shape(b)], 'SUBTRACT');
    expect(outlines(cut)).toBe(1);
    expect(area(cut)).toBeCloseTo(7500, 6);
    expect(corners(cut)).toEqual(['0,0', '0,100', '100,0', '100,50', '50,100', '50,50'].sort());
    // The other way round it is the other L.
    const other = booleanNetworks([shape(b), shape(a)], 'SUBTRACT');
    expect(area(other)).toBeCloseTo(7500, 6);
    expect(corners(other)).toContain('150,150');
    expect(corners(other)).not.toContain('0,0');
  });

  it('excludes what an even number of shapes cover', () => {
    const xor = booleanNetworks([shape(a), shape(b)], 'EXCLUDE');
    // Two L shapes that touch at two points, each an outline of its own.
    expect(outlines(xor)).toBe(2);
    expect(networkGeometry(xor).closed).toBe(true);
    expect(area(xor)).toBeCloseTo(15000, 6);
    expect(xor.vertices).toHaveLength(12);
    for (const rule of ['NONZERO', 'EVENODD'] as const) {
      expect(pointInNetworkFill(xor, { x: 25, y: 25 }, rule)).toBe(true);
      expect(pointInNetworkFill(xor, { x: 125, y: 125 }, rule)).toBe(true);
      expect(pointInNetworkFill(xor, { x: 75, y: 75 }, rule)).toBe(false);
    }
  });

  it('makes a hole when a shape inside another is taken out', () => {
    const holed = booleanNetworks([shape(rect(0, 0, 100, 100)), shape(rect(40, 40, 20, 20))], 'SUBTRACT');
    expect(outlines(holed)).toBe(2);
    expect(area(holed)).toBeCloseTo(9600, 6);
    // The inner outline runs the other way, so the hole is a hole under either fill rule.
    for (const rule of ['NONZERO', 'EVENODD'] as const) {
      expect(pointInNetworkFill(holed, { x: 50, y: 50 }, rule)).toBe(false);
      expect(pointInNetworkFill(holed, { x: 10, y: 10 }, rule)).toBe(true);
    }
    // United, the inner one simply disappears.
    const united = booleanNetworks([shape(rect(0, 0, 100, 100)), shape(rect(40, 40, 20, 20))], 'UNION');
    expect(outlines(united)).toBe(1);
    expect(corners(united)).toEqual(['0,0', '0,100', '100,0', '100,100']);
    // And what they share is the inner one.
    expect(area(booleanNetworks([shape(rect(0, 0, 100, 100)), shape(rect(40, 40, 20, 20))], 'INTERSECT'))).toBeCloseTo(400, 6);
  });

  it('handles shapes that do not touch', () => {
    const apart = [shape(rect(0, 0, 50, 50)), shape(rect(100, 100, 50, 50))];
    const union = booleanNetworks(apart, 'UNION');
    expect(outlines(union)).toBe(2);
    expect(area(union)).toBeCloseTo(5000, 6);
    expect(booleanNetworks(apart, 'INTERSECT')).toEqual({ vertices: [], segments: [] });
    expect(area(booleanNetworks(apart, 'SUBTRACT'))).toBeCloseTo(2500, 6);
    expect(area(booleanNetworks(apart, 'EXCLUDE'))).toBeCloseTo(5000, 6);
  });

  it('keeps curves as curves', () => {
    const one = circle(50, 50, 50);
    const two = circle(110, 50, 50);
    // The lens two circles of radius 50 share when their centres are 60 apart.
    const lens = 2 * 2500 * Math.acos(0.6) - 30 * 80;
    const disc = Math.PI * 2500;

    const union = booleanNetworks([shape(one), shape(two)], 'UNION');
    expect(outlines(union)).toBe(1);
    // Three of each circle's four points survive, plus the two crossings.
    expect(union.vertices).toHaveLength(8);
    expect(union.segments.every((s) => s.tangentStart.x !== 0 || s.tangentStart.y !== 0)).toBe(true);
    expect(Math.abs(area(union) - (2 * disc - lens))).toBeLessThan(8);
    const crossing = union.vertices.filter((v) => Math.abs(v.x - 80) < 0.05);
    expect(crossing.map((v) => Math.round(v.y)).sort((x, y) => x - y)).toEqual([10, 90]);

    const both = booleanNetworks([shape(one), shape(two)], 'INTERSECT');
    expect(outlines(both)).toBe(1);
    expect(Math.abs(area(both) - lens)).toBeLessThan(4);
    const moon = booleanNetworks([shape(one), shape(two)], 'SUBTRACT');
    expect(outlines(moon)).toBe(1);
    expect(Math.abs(area(moon) - (disc - lens))).toBeLessThan(6);
    // The pieces add up (as nearly as areas of curves can be measured here).
    expect(area(moon) + area(both)).toBeCloseTo(area(one), 1);
  });

  it('combines more than two shapes', () => {
    const three = [shape(rect(0, 0, 100, 100)), shape(rect(50, 0, 100, 100)), shape(rect(100, 0, 100, 100))];
    const union = booleanNetworks(three, 'UNION');
    expect(outlines(union)).toBe(1);
    expect(area(union)).toBeCloseTo(20000, 6);
    // The middle strip is in all... of none: the first and the last only meet along a line.
    expect(booleanNetworks(three, 'INTERSECT').segments).toEqual([]);
    // The first with both others taken out: its left half.
    expect(area(booleanNetworks(three, 'SUBTRACT'))).toBeCloseTo(5000, 6);
    // Covered once or three times: the two outer halves.
    expect(area(booleanNetworks(three, 'EXCLUDE'))).toBeCloseTo(10000, 6);
  });

  it('respects the fill rule of what it is given', () => {
    const outer = rect(0, 0, 100, 100);
    const inner = rect(40, 40, 20, 20);
    const ring: VectorNetwork = {
      vertices: [...outer.vertices, ...inner.vertices],
      segments: [...outer.segments, ...inner.segments.map((s) => ({ ...s, start: s.start + 4, end: s.end + 4 }))],
    };
    const band = rect(0, 45, 100, 10);
    // With a hole in the ring, the band is cut in two; without one it is whole.
    const holed = booleanNetworks([shape(ring, 'EVENODD'), shape(band)], 'INTERSECT');
    expect(outlines(holed)).toBe(2);
    expect(area(holed)).toBeCloseTo(800, 6);
    const solid = booleanNetworks([shape(ring, 'NONZERO'), shape(band)], 'INTERSECT');
    expect(outlines(solid)).toBe(1);
    expect(area(solid)).toBeCloseTo(1000, 6);
  });

  it('copes with shapes that share an edge', () => {
    const left = rect(0, 0, 100, 100);
    const right = rect(100, 0, 100, 100);
    const union = booleanNetworks([shape(left), shape(right)], 'UNION');
    expect(outlines(union)).toBe(1);
    expect(area(union)).toBeCloseTo(20000, 6);
    // Taking away a neighbour takes nothing away, and leaves the shared edge there once.
    const cut = booleanNetworks([shape(left), shape(right)], 'SUBTRACT');
    expect(outlines(cut)).toBe(1);
    expect(cut.segments).toHaveLength(4);
    expect(area(cut)).toBeCloseTo(10000, 6);
    expect(booleanNetworks([shape(left), shape(right)], 'INTERSECT').segments).toEqual([]);

    // Sharing only part of an edge.
    const lower = rect(100, 50, 100, 100);
    const stepped = booleanNetworks([shape(left), shape(lower)], 'UNION');
    expect(outlines(stepped)).toBe(1);
    expect(area(stepped)).toBeCloseTo(20000, 6);
    expect(corners(stepped)).toContain('100,50');
    expect(corners(stepped)).toContain('100,100');
  });

  it('treats an open path as the shape its fill would be', () => {
    const vee = new NetworkBuilder().moveTo(0, 0).lineTo(50, 100).lineTo(100, 0).build();
    const top = booleanNetworks([shape(vee), shape(rect(-10, -10, 120, 60))], 'INTERSECT');
    expect(outlines(top)).toBe(1);
    expect(networkGeometry(top).closed).toBe(true);
    // The triangle's top half: 100 wide at the top, 50 wide half-way down.
    expect(area(top)).toBeCloseTo(3750, 6);
  });
});

describe('boolean operations on layers', () => {
  function setup(): { doc: Document; pageId: NodeId } {
    const doc = createDocument('Boolean');
    return { doc, pageId: (getPages(doc)[0] as { id: NodeId }).id };
  }
  const app: AppActions = {
    cancelInteraction: () => false,
    openShortcuts: () => undefined,
    saveNow: () => undefined,
    saveAs: () => undefined,
    placeImage: () => undefined,
    goHome: () => undefined,
  };

  it('puts the shapes in a boolean group that looks like the bottom-most did', () => {
    const { doc, pageId } = setup();
    const frame = addLayer(doc, 'FRAME', pageId, { x: 100, y: 100, width: 500, height: 400 });
    const square = addLayer(frame.doc, 'RECTANGLE', frame.id, { x: 50, y: 50, width: 200, height: 200, fills: [solidPaint({ r: 1, g: 0, b: 0 })] });
    const disc = addLayer(square.doc, 'ELLIPSE', frame.id, { x: 150, y: 150, width: 200, height: 200 });
    const before = disc.doc;
    const out = booleanNodes(before, [disc.id, square.id], 'UNION') as { doc: Document; id: NodeId };
    const vector = out.doc.nodes[out.id] as BooleanOperationNode;
    expect(vector).toMatchObject({ type: 'BOOLEAN_OPERATION', operation: 'UNION', name: 'Union', parentId: frame.id, x: 50, y: 50, width: 300, height: 300 });
    expect(vector.fills).toEqual([solidPaint({ r: 1, g: 0, b: 0 })]);
    expect(getChildIds(out.doc, frame.id)).toEqual([out.id]);
    // The shapes are still there, inside it, in the same order and in the same places on the page.
    expect(getChildIds(out.doc, out.id)).toEqual([square.id, disc.id]);
    expect(getWorldBounds(out.doc, disc.id)).toEqual(getWorldBounds(before, disc.id));
    expect(getWorldBounds(out.doc, out.id)).toEqual(unionRects([getWorldBounds(before, square.id), getWorldBounds(before, disc.id)]));
    expect(validateDocument(out.doc)).toEqual([]);

    // Subtract: the square with a bite out of its corner. The bite is not part of the layer any more.
    const bitten = booleanNodes(before, [square.id, disc.id], 'SUBTRACT') as { doc: Document; id: NodeId };
    expect(bitten.doc.nodes[bitten.id]).toMatchObject({ name: 'Subtract', x: 50, y: 50, width: 200, height: 200 });
    // A click selects the group; the shape under the pointer is one level further in.
    expect(selectionTargetAt(bitten.doc, pageId, { x: 100 + 60, y: 100 + 60 }, [])).toBe(bitten.id);
    expect(hitTestDeepest(bitten.doc, pageId, { x: 100 + 60, y: 100 + 60 })).toBe(square.id);
    expect(deeperTargetAt(bitten.doc, pageId, { x: 100 + 60, y: 100 + 60 }, [bitten.id])).toBe(square.id);
    expect(hitTestDeepest(bitten.doc, pageId, { x: 100 + 240, y: 100 + 240 })).toBe(frame.id);
    // Intersect: the corner alone.
    const corner = booleanNodes(before, [square.id, disc.id], 'INTERSECT') as { doc: Document; id: NodeId };
    expect(corner.doc.nodes[corner.id]).toMatchObject({ name: 'Intersect', x: 150, y: 150, width: 100, height: 100 });
  });

  it('works on rotated shapes and on shapes inside groups, wherever they are', () => {
    const { doc, pageId } = setup();
    const a = addLayer(doc, 'RECTANGLE', pageId, { x: 0, y: 0, width: 100, height: 100 });
    const b = addLayer(a.doc, 'RECTANGLE', pageId, { x: 50, y: 0, width: 100, height: 100, rotation: 45 });
    const grouped = groupNodes(b.doc, [b.id]) as { doc: Document; id: NodeId };
    expect(canBoolean(grouped.doc, [a.id, grouped.id])).toBe(true);
    const out = booleanNodes(grouped.doc, [a.id, grouped.id], 'UNION') as { doc: Document; id: NodeId };
    // The square and the group that holds the other one are both inside the boolean group now.
    expect(getChildIds(out.doc, pageId)).toEqual([out.id]);
    expect(getChildIds(out.doc, out.id)).toEqual([a.id, grouped.id]);
    const bounds = getWorldBounds(out.doc, out.id);
    const half = Math.SQRT2 * 50;
    // (A layer's box is kept to a thousandth of a pixel.)
    expect(bounds.x).toBeCloseTo(0, 2);
    expect(bounds.width).toBeCloseTo(100 + half, 2);
    expect(bounds.y).toBeCloseTo(50 - half, 2);
    expect(bounds.height).toBeCloseTo(half * 2, 2);
  });

  it('does nothing when there is nothing to do', () => {
    const { doc, pageId } = setup();
    const a = addLayer(doc, 'RECTANGLE', pageId, { x: 0, y: 0 });
    const b = addLayer(a.doc, 'RECTANGLE', pageId, { x: 300, y: 300 });
    const text = addLayer(b.doc, 'TEXT', pageId, { x: 0, y: 300, characters: 'Hi' });
    expect(canBoolean(text.doc, [a.id])).toBe(false);
    expect(canBoolean(text.doc, [a.id, text.id])).toBe(false);
    expect(booleanNodes(text.doc, [a.id], 'UNION')).toBeNull();
    // Shapes that do not overlap share nothing.
    expect(booleanNodes(text.doc, [a.id, b.id], 'INTERSECT')).toBeNull();

    const store = createEditorStore(text.doc);
    store.getState().setSelection([a.id, b.id]);
    runCommand(getCommand('object.intersect') as Command, { store, app });
    expect(store.getState().doc).toBe(text.doc);
    expect(store.getState().undoStack).toEqual([]);
  });

  it('runs from the keyboard, as one undo step', () => {
    const { doc, pageId } = setup();
    const a = addLayer(doc, 'ELLIPSE', pageId, { x: 0, y: 0 });
    const b = addLayer(a.doc, 'ELLIPSE', pageId, { x: 60, y: 0 });
    const store = createEditorStore(b.doc);
    const key = (code: string) => commandForKey({ code, ctrlKey: true, shiftKey: false, altKey: true, metaKey: false });
    expect(key('KeyU')?.id).toBe('object.union');
    expect(key('KeyS')?.id).toBe('object.subtract');
    expect(key('KeyI')?.id).toBe('object.intersect');
    expect(key('KeyX')?.id).toBe('object.exclude');
    expect(key('KeyS')?.enabled?.(store.getState())).toBe(false);

    store.getState().setSelection([a.id, b.id]);
    expect(key('KeyS')?.enabled?.(store.getState())).toBe(true);
    runCommand(key('KeyS') as Command, { store, app });
    const state = store.getState();
    expect(state.undoStack.map((entry) => entry.label)).toEqual(['Subtract']);
    expect(state.selection).toHaveLength(1);
    const moon = state.doc.nodes[state.selection[0] as NodeId] as BooleanOperationNode;
    expect(moon).toMatchObject({ type: 'BOOLEAN_OPERATION', operation: 'SUBTRACT', name: 'Subtract', x: 0, y: 0, height: 100 });
    // A crescent: it ends at its horns, where the two circles crossed, 80 across.
    expect(moon.width).toBeCloseTo(80, 1);
    expect(state.doc.nodes[a.id]).toMatchObject({ parentId: moon.id });

    state.undo();
    expect(store.getState().doc).toEqual(b.doc);
    expect(store.getState().selection).toEqual([a.id, b.id]);
    store.getState().redo();
    expect(Object.values(store.getState().doc.nodes).filter((node) => node.type === 'BOOLEAN_OPERATION')).toHaveLength(1);
  });
});

describe('boolean groups keep their shapes', () => {
  function setup(): { doc: Document; pageId: NodeId } {
    const doc = createDocument('Boolean groups');
    return { doc, pageId: (getPages(doc)[0] as { id: NodeId }).id };
  }

  /** Two 100 × 100 squares, the second 50 to the right of the first, united. */
  function united(): { doc: Document; pageId: NodeId; a: NodeId; b: NodeId; id: NodeId } {
    const { doc, pageId } = setup();
    const a = addLayer(doc, 'RECTANGLE', pageId, { x: 0, y: 0, fills: [solidPaint({ r: 1, g: 0, b: 0 })] });
    const b = addLayer(a.doc, 'RECTANGLE', pageId, { x: 50, y: 0, fills: [solidPaint({ r: 0, g: 0, b: 1 })] });
    const out = booleanNodes(b.doc, [a.id, b.id], 'UNION') as { doc: Document; id: NodeId };
    return { doc: out.doc, pageId, a: a.id, b: b.id, id: out.id };
  }

  const group = (doc: Document, id: NodeId): BooleanOperationNode => doc.nodes[id] as BooleanOperationNode;

  it('follows its shapes when they move', () => {
    const { doc, a, b, id } = united();
    expect(group(doc, id)).toMatchObject({ x: 0, y: 0, width: 150, height: 100 });
    expect(area(group(doc, id).network)).toBeCloseTo(15000, 6);
    // Nothing to bring up to date: the document is left exactly as it is.
    expect(normalizeGroups(doc)).toBe(doc);

    // Pull the second square clear of the first: two squares, side by side.
    const apart = normalizeGroups(moveNodesBy(doc, [b], 100, 0));
    expect(group(apart, id)).toMatchObject({ x: 0, y: 0, width: 250, height: 100 });
    expect(outlines(group(apart, id).network)).toBe(2);
    expect(area(group(apart, id).network)).toBeCloseTo(20000, 6);
    // Move the first one left: the group's box follows, and the shapes stay where they are on the page.
    const wider = normalizeGroups(moveNodesBy(apart, [a], -40, 10));
    expect(group(wider, id)).toMatchObject({ x: -40, y: 0, width: 290, height: 110 });
    expect(getWorldBounds(wider, a)).toEqual({ x: -40, y: 10, width: 100, height: 100 });
    expect(getWorldBounds(wider, b)).toEqual({ x: 150, y: 0, width: 100, height: 100 });
    expect(validateDocument(wider)).toEqual([]);
  });

  it('shows another result when its operation changes, or when a shape is hidden or removed', () => {
    const { doc, a, b, id } = united();
    const shared = normalizeGroups(patchNode(doc, id, { operation: 'INTERSECT' }));
    expect(group(shared, id)).toMatchObject({ x: 50, y: 0, width: 50, height: 100 });
    const cut = normalizeGroups(patchNode(doc, id, { operation: 'SUBTRACT' }));
    expect(group(cut, id)).toMatchObject({ x: 0, y: 0, width: 50, height: 100 });
    const either = normalizeGroups(patchNode(doc, id, { operation: 'EXCLUDE' }));
    expect(area(group(either, id).network)).toBeCloseTo(10000, 6);

    // A hidden shape takes no part.
    const hidden = normalizeGroups(patchNode(doc, b, { visible: false }));
    expect(group(hidden, id)).toMatchObject({ x: 0, y: 0, width: 100, height: 100 });
    // Nor does one that is gone; and a group with nothing left in it goes too.
    const one = normalizeGroups(deleteNodes(doc, [b]));
    expect(group(one, id)).toMatchObject({ width: 100 });
    const none = normalizeGroups(deleteNodes(one, [a]));
    expect(none.nodes[id]).toBeUndefined();
  });

  it('is painted as one shape, and its shapes are not painted', () => {
    const { doc, pageId } = united();
    const fills: string[] = [];
    const target: Record<string, unknown> = {};
    const ctx = new Proxy(target, {
      get(obj, prop: string) {
        if (prop in obj) return obj[prop];
        return () => {
          if (prop === 'fill') fills.push(String(obj.fillStyle));
        };
      },
      set(obj, prop: string, value) {
        obj[prop] = value;
        return true;
      },
    }) as unknown as CanvasRenderingContext2D;
    const stats = renderScene(ctx, doc, pageId, { size: { width: 800, height: 600 }, dpr: 1, viewport: { x: 0, y: 0, zoom: 1 } });
    // In the colour of the bottom-most shape.
    expect(fills).toEqual(['rgb(255, 0, 0)']);
    expect(stats.drawn).toBe(1);
  });

  it('scales its shapes when it is resized, and lets them go when it is ungrouped or flattened', () => {
    const { doc, pageId, a, b, id } = united();
    const bigger = normalizeGroups(setLayerBox(doc, id, { width: 300, height: 200 }));
    expect(group(bigger, id)).toMatchObject({ x: 0, y: 0, width: 300, height: 200 });
    expect(bigger.nodes[b]).toMatchObject({ x: 100, y: 0, width: 200, height: 200 });

    const released = ungroupNodes(doc, [id]);
    expect(released.ids).toEqual([a, b]);
    expect(released.doc.nodes[id]).toBeUndefined();
    expect(getChildIds(released.doc, pageId)).toEqual([a, b]);
    expect(getWorldBounds(released.doc, b)).toEqual({ x: 50, y: 0, width: 100, height: 100 });

    // Flattened, the group becomes a vector of its result and the shapes are gone.
    const flat = flattenNodes(doc, [id]) as { doc: Document; id: NodeId };
    expect(flat.id).toBe(id);
    expect(flat.doc.nodes[id]).toMatchObject({ type: 'VECTOR', name: 'Union', width: 150, height: 100 });
    expect(flat.doc.nodes[a]).toBeUndefined();
    expect(flat.doc.nodes[b]).toBeUndefined();
    expect(validateDocument(flat.doc)).toEqual([]);
  });

  it('can hold groups and other boolean groups', () => {
    const { doc, pageId, id } = united();
    // A third square over the middle of the union, taken out of it.
    const c = addLayer(doc, 'RECTANGLE', pageId, { x: 50, y: 25, width: 50, height: 50 });
    const out = booleanNodes(c.doc, [id, c.id], 'SUBTRACT') as { doc: Document; id: NodeId };
    const outer = group(out.doc, out.id);
    expect(outer).toMatchObject({ operation: 'SUBTRACT', x: 0, y: 0, width: 150, height: 100 });
    expect(getChildIds(out.doc, out.id)).toEqual([id, c.id]);
    expect(area(outer.network)).toBeCloseTo(15000 - 2500, 6);
    expect(outlines(outer.network)).toBe(2);
    // It looks like the bottom-most shape of all.
    expect(outer.fills).toEqual([solidPaint({ r: 1, g: 0, b: 0 })]);
    // Changing the inner group changes the outer one.
    const inner = normalizeGroups(patchNode(out.doc, id, { operation: 'INTERSECT' }));
    expect(area(group(inner, out.id).network)).toBeCloseTo(5000 - 2500, 6);
  });

  it('is edited through the editor: a shape dragged inside it stays inside, and undo restores the result', () => {
    const { doc, a, b, id } = united();
    const store = createEditorStore(doc);
    store.getState().setCanvasSize({ width: 800, height: 600 });
    const controller = new InteractionController(store, { requestRender: () => undefined, setCursor: () => undefined });
    const ptr = (x: number, y: number, detail = 1) => ({ x, y, button: 0, shiftKey: false, altKey: false, ctrlKey: false, detail });
    // A click selects the group; a double-click the shape in it.
    controller.pointerDown(ptr(120, 50));
    controller.pointerUp(ptr(120, 50));
    expect(store.getState().selection).toEqual([id]);
    controller.pointerDown(ptr(120, 50, 2));
    controller.pointerUp(ptr(120, 50, 2));
    expect(store.getState().selection).toEqual([b]);

    controller.pointerDown(ptr(120, 50));
    controller.pointerMove(ptr(170, 50));
    controller.pointerMove(ptr(220, 50));
    controller.pointerUp(ptr(220, 50));
    const moved = store.getState().doc;
    expect((moved.nodes[b] as LayerNode).parentId).toBe(id);
    expect(getWorldBounds(moved, b)).toEqual({ x: 150, y: 0, width: 100, height: 100 });
    expect(group(moved, id)).toMatchObject({ width: 250 });
    expect(outlines(group(moved, id).network)).toBe(2);
    expect(store.getState().undoStack.map((entry) => entry.label)).toEqual(['Move']);

    store.getState().undo();
    expect(store.getState().doc).toEqual(doc);
    expect(group(store.getState().doc, id)).toMatchObject({ width: 150 });
    expect((store.getState().doc.nodes[a] as LayerNode).parentId).toBe(id);
  });

  it('opens a version 10 file, which has no boolean groups', () => {
    const { doc, pageId } = setup();
    const rect = addLayer(doc, 'RECTANGLE', pageId, { x: 10, y: 20 });
    const parsed = parseFile({
      format: 'open-design',
      schemaVersion: 10,
      meta: { createdAt: '2026-11-16T15:00:00.000Z', updatedAt: '2026-11-16T15:00:00.000Z' },
      document: JSON.parse(JSON.stringify(rect.doc)),
    });
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(11);
    expect(parsed.file.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(parsed.repairs).toEqual([]);
    expect(parsed.file.document).toEqual(rect.doc);
    // And a file with a boolean group comes back as it was saved.
    const saved = united().doc;
    const again = parseFile({ format: 'open-design', schemaVersion: CURRENT_SCHEMA_VERSION, meta: {}, document: JSON.parse(JSON.stringify(saved)) });
    expect(again.repairs).toEqual([]);
    expect(again.file.document).toEqual(saved);
  });
});
