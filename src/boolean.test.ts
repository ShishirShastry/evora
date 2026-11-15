import { describe, expect, it } from 'vitest';
import {
  addLayer,
  booleanNetworks,
  booleanNodes,
  canBoolean,
  createDocument,
  createLayer,
  flattenCubic,
  getChildIds,
  getPages,
  getWorldBounds,
  groupNodes,
  hitTestDeepest,
  intersectCubics,
  mapNetwork,
  NetworkBuilder,
  networkGeometry,
  pointInNetworkFill,
  segmentCubic,
  shapeNetwork,
  solidPaint,
  stepCubic,
  unionRects,
  validateDocument,
  type BooleanOperand,
  type Cubic,
  type CurveCrossing,
  type Document,
  type NodeId,
  type Point,
  type VectorNetwork,
  type VectorNode,
} from './core';
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

  it('replaces the shapes with one vector that looks like the bottom-most did', () => {
    const { doc, pageId } = setup();
    const frame = addLayer(doc, 'FRAME', pageId, { x: 100, y: 100, width: 500, height: 400 });
    const square = addLayer(frame.doc, 'RECTANGLE', frame.id, { x: 50, y: 50, width: 200, height: 200, fills: [solidPaint({ r: 1, g: 0, b: 0 })] });
    const disc = addLayer(square.doc, 'ELLIPSE', frame.id, { x: 150, y: 150, width: 200, height: 200 });
    const before = disc.doc;
    const out = booleanNodes(before, [disc.id, square.id], 'UNION') as { doc: Document; id: NodeId };
    const vector = out.doc.nodes[out.id] as VectorNode;
    expect(vector).toMatchObject({ type: 'VECTOR', name: 'Union', parentId: frame.id, windingRule: 'NONZERO', x: 50, y: 50, width: 300, height: 300 });
    expect(vector.fills).toEqual([solidPaint({ r: 1, g: 0, b: 0 })]);
    expect(getChildIds(out.doc, frame.id)).toEqual([out.id]);
    expect(getWorldBounds(out.doc, out.id)).toEqual(unionRects([getWorldBounds(before, square.id), getWorldBounds(before, disc.id)]));
    expect(validateDocument(out.doc)).toEqual([]);

    // Subtract: the square with a bite out of its corner. The bite is not part of the layer any more.
    const bitten = booleanNodes(before, [square.id, disc.id], 'SUBTRACT') as { doc: Document; id: NodeId };
    expect(bitten.doc.nodes[bitten.id]).toMatchObject({ name: 'Subtract', x: 50, y: 50, width: 200, height: 200 });
    expect(hitTestDeepest(bitten.doc, pageId, { x: 100 + 60, y: 100 + 60 })).toBe(bitten.id);
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
    // The group that held the second square is gone with it.
    expect(getChildIds(out.doc, pageId)).toEqual([out.id]);
    const bounds = getWorldBounds(out.doc, out.id);
    const half = Math.SQRT2 * 50;
    expect(bounds.x).toBeCloseTo(0, 3);
    expect(bounds.width).toBeCloseTo(100 + half, 3);
    expect(bounds.y).toBeCloseTo(50 - half, 3);
    expect(bounds.height).toBeCloseTo(half * 2, 3);
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
    const moon = state.doc.nodes[state.selection[0] as NodeId] as VectorNode;
    expect(moon).toMatchObject({ type: 'VECTOR', name: 'Subtract', x: 0, y: 0, height: 100 });
    // A crescent: it ends at its horns, where the two circles crossed, 80 across.
    expect(moon.width).toBeCloseTo(80, 1);
    expect(state.doc.nodes[a.id]).toBeUndefined();

    state.undo();
    expect(store.getState().doc).toEqual(b.doc);
    expect(store.getState().selection).toEqual([a.id, b.id]);
    store.getState().redo();
    expect(Object.values(store.getState().doc.nodes).filter((node) => node.type === 'VECTOR')).toHaveLength(1);
  });
});
