import { describe, expect, it } from 'vitest';
import {
  addLayer,
  addSegment,
  applyToPoint,
  cornerVertex,
  createDocument,
  createLayer,
  cubicAt,
  cubicBounds,
  CURRENT_SCHEMA_VERSION,
  distanceToNetwork,
  fitVectorNode,
  flattenCubic,
  flattenNodes,
  flipNodes,
  getChildIds,
  getPages,
  getWorldBounds,
  getWorldMatrix,
  groupNodes,
  handlesOf,
  hitTestDeepest,
  isVector,
  mergeVertices,
  mirroringAt,
  moveVertices,
  nearestOnCubic,
  nearestSegment,
  NetworkBuilder,
  networkGeometry,
  parseFile,
  patchNode,
  patchNodes,
  pointInNetworkFill,
  removeSegments,
  removeVertices,
  repairDocument,
  segmentCubic,
  setLayerBox,
  setNetwork,
  setNodes,
  setTangent,
  shapeNetwork,
  smoothVertex,
  solidPaint,
  splitCubic,
  splitSegment,
  validateDocument,
  type Cubic,
  type Document,
  type LayerNode,
  type NodeId,
  type Point,
  type VectorNetwork,
  type VectorNode,
} from './core';
import { freshKeys } from './core/order';
import { traceLayerPath } from './engine/render/paint';
import { getRenderBounds, renderScene, strokeAlignOf } from './engine/render/scene';
import { commandForKey, getCommand, runCommand, type AppActions } from './state/commands';
import { createEditorStore } from './state/editorStore';

function setup(): { doc: Document; pageId: NodeId } {
  const doc = createDocument('Vectors');
  return { doc, pageId: (getPages(doc)[0] as { id: NodeId }).id };
}

const square = (size = 100, at = 0): NetworkBuilder =>
  new NetworkBuilder()
    .moveTo(at, at)
    .lineTo(at + size, at)
    .lineTo(at + size, at + size)
    .lineTo(at, at + size)
    .close();

/** Adds a vector layer holding `network`, with its box fitted, to the page. */
function addVector(doc: Document, pageId: NodeId, network: VectorNetwork, props: Partial<VectorNode> = {}): { doc: Document; id: NodeId } {
  // Sized to its curves from the start, so a rotation given in `props` turns it about its centre.
  const bounds = networkGeometry(network).bounds ?? { width: 0, height: 0 };
  const node = createLayer('VECTOR', pageId, freshKeys(1)[0] as string, { width: bounds.width, height: bounds.height, ...props, network }) as VectorNode;
  return { doc: setNodes(doc, { [node.id]: fitVectorNode(node) }), id: node.id };
}

const vectorOf = (doc: Document, id: NodeId): VectorNode => doc.nodes[id] as VectorNode;

/** Every point of a vector layer, in page space. */
function worldPoints(doc: Document, id: NodeId): Point[] {
  const matrix = getWorldMatrix(doc, id);
  return vectorOf(doc, id).network.vertices.map((v) => applyToPoint(matrix, v));
}

function polygonArea(points: readonly Point[]): number {
  let sum = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    sum += (points[j] as Point).x * (points[i] as Point).y - (points[i] as Point).x * (points[j] as Point).y;
  }
  return Math.abs(sum) / 2;
}

const near = (a: Point, b: Point, tolerance = 0.002): boolean => Math.abs(a.x - b.x) <= tolerance && Math.abs(a.y - b.y) <= tolerance;

describe('Bézier curves', () => {
  const arch: Cubic = { p0: { x: 0, y: 0 }, p1: { x: 0, y: 100 }, p2: { x: 100, y: 100 }, p3: { x: 100, y: 0 } };

  it('starts and ends at its end points', () => {
    expect(cubicAt(arch, 0)).toEqual({ x: 0, y: 0 });
    expect(cubicAt(arch, 1)).toEqual({ x: 100, y: 0 });
    expect(cubicAt(arch, 0.5)).toEqual({ x: 50, y: 75 });
  });

  it('measures the curve itself, not its control points', () => {
    // The handles reach y = 100 but the curve only gets to 75.
    expect(cubicBounds(arch)).toEqual({ x: 0, y: 0, width: 100, height: 75 });
    const s: Cubic = { p0: { x: 0, y: 0 }, p1: { x: 400, y: 0 }, p2: { x: -300, y: 50 }, p3: { x: 100, y: 50 } };
    const bounds = cubicBounds(s);
    // An S that swings out past both of its ends.
    expect(bounds.x).toBeLessThan(0);
    expect(bounds.x + bounds.width).toBeGreaterThan(100);
    expect(bounds.y).toBe(0);
    expect(bounds.height).toBe(50);
  });

  it('splits into two curves that trace the same shape', () => {
    const [left, right] = splitCubic(arch, 0.3);
    expect(left.p0).toEqual(arch.p0);
    expect(right.p3).toEqual(arch.p3);
    expect(left.p3).toEqual(right.p0);
    for (const u of [0, 0.25, 0.5, 0.75, 1]) {
      expect(near(cubicAt(left, u), cubicAt(arch, u * 0.3), 1e-9)).toBe(true);
      expect(near(cubicAt(right, u), cubicAt(arch, 0.3 + u * 0.7), 1e-9)).toBe(true);
    }
  });

  it('flattens to a polyline that stays within the tolerance', () => {
    const points: Point[] = [arch.p0];
    flattenCubic(arch, 0.1, points);
    expect(points.length).toBeGreaterThan(8);
    expect(points.at(-1)).toEqual(arch.p3);
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1] as Point;
      const b = points[i] as Point;
      const middle = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      expect(nearestOnCubic(arch, middle).distance).toBeLessThanOrEqual(0.1);
    }
    // A straight line needs no subdividing.
    const line: Point[] = [];
    flattenCubic({ p0: { x: 0, y: 0 }, p1: { x: 0, y: 0 }, p2: { x: 9, y: 9 }, p3: { x: 9, y: 9 } }, 0.1, line);
    expect(line).toEqual([{ x: 9, y: 9 }]);
  });

  it('finds the nearest point on a curve', () => {
    const found = nearestOnCubic(arch, { x: 50, y: 200 });
    expect(found.t).toBeCloseTo(0.5, 3);
    expect(found.point.y).toBeCloseTo(75, 3);
    expect(found.distance).toBeCloseTo(125, 3);
    expect(nearestOnCubic(arch, { x: -30, y: -40 }).distance).toBeCloseTo(50, 6);
  });
});

describe('vector networks', () => {
  it('reads a closed path as one ring that can be filled', () => {
    const network = square().build();
    expect(network.vertices).toHaveLength(4);
    expect(network.segments).toHaveLength(4);
    const geometry = networkGeometry(network);
    expect(geometry.chains).toHaveLength(1);
    expect(geometry.chains[0]?.closed).toBe(true);
    expect(geometry.chains[0]?.steps).toHaveLength(4);
    expect(geometry.closed).toBe(true);
    expect(geometry.loops).toHaveLength(1);
    expect(geometry.bounds).toEqual({ x: 0, y: 0, width: 100, height: 100 });
    // The same object comes back for the same network.
    expect(networkGeometry(network)).toBe(geometry);
  });

  it('reads an open path as one run, filled as if a straight line closed it', () => {
    const network = new NetworkBuilder().moveTo(0, 0).lineTo(60, 0).lineTo(60, 60).build();
    const geometry = networkGeometry(network);
    expect(geometry.chains).toHaveLength(1);
    expect(geometry.chains[0]?.closed).toBe(false);
    expect(geometry.closed).toBe(false);
    expect(geometry.loops).toHaveLength(1);
    expect(pointInNetworkFill(network, { x: 50, y: 20 }, 'NONZERO')).toBe(true);
    expect(pointInNetworkFill(network, { x: 10, y: 40 }, 'NONZERO')).toBe(false);
    expect(distanceToNetwork(network, { x: 30, y: 5 })).toBe(5);
    // The closing line is not part of the path, so it is not there to be touched.
    expect(distanceToNetwork(network, { x: 30, y: 30 })).toBe(30);
  });

  it('finds the regions of a network that branches', () => {
    // A square with a diagonal: two points now have three segments each.
    const network = addSegment(square().build(), 0, 2).network;
    const geometry = networkGeometry(network);
    expect(geometry.chains).toHaveLength(3);
    expect(geometry.chains.every((chain) => !chain.closed)).toBe(true);
    expect(geometry.closed).toBe(false);
    // Two triangles, and not the walk round the outside.
    expect(geometry.loops).toHaveLength(2);
    expect(geometry.loopPolygons.map(polygonArea)).toEqual([5000, 5000]);
    expect(pointInNetworkFill(network, { x: 75, y: 25 }, 'NONZERO')).toBe(true);
    expect(pointInNetworkFill(network, { x: 25, y: 75 }, 'EVENODD')).toBe(true);
    expect(pointInNetworkFill(network, { x: 150, y: 50 }, 'NONZERO')).toBe(false);
  });

  it('ignores loose ends when looking for regions', () => {
    // A square with a tail hanging off one corner, and a branch that encloses nothing.
    let network = square().build();
    network = { vertices: [...network.vertices, { x: 150, y: -50 }], segments: network.segments };
    network = addSegment(network, 1, 4).network;
    const geometry = networkGeometry(network);
    expect(geometry.loops).toHaveLength(1);
    expect(polygonArea(geometry.loopPolygons[0] as Point[])).toBeCloseTo(10000, 6);

    const tee = new NetworkBuilder().moveTo(0, 0).lineTo(50, 0).lineTo(100, 0).build();
    const withStem = addSegment({ vertices: [...tee.vertices, { x: 50, y: 80 }], segments: tee.segments }, 1, 3).network;
    expect(networkGeometry(withStem).loops).toHaveLength(0);
    expect(networkGeometry(withStem).chains).toHaveLength(3);
  });

  it('fills a shape inside a shape as a hole only by the even-odd rule', () => {
    const outer = square(100).build();
    const inner = square(20, 40).build();
    const ring: VectorNetwork = {
      vertices: [...outer.vertices, ...inner.vertices],
      segments: [...outer.segments, ...inner.segments.map((s) => ({ ...s, start: s.start + 4, end: s.end + 4 }))],
    };
    expect(networkGeometry(ring).loops).toHaveLength(2);
    expect(pointInNetworkFill(ring, { x: 50, y: 50 }, 'EVENODD')).toBe(false);
    expect(pointInNetworkFill(ring, { x: 50, y: 50 }, 'NONZERO')).toBe(true);
    expect(pointInNetworkFill(ring, { x: 10, y: 10 }, 'EVENODD')).toBe(true);
    expect(pointInNetworkFill(ring, { x: 10, y: 10 }, 'NONZERO')).toBe(true);
  });

  it('adds a point on a segment without changing the shape', () => {
    const curve = new NetworkBuilder().moveTo(0, 0).curveTo(0, 100, 100, 100, 100, 0).lineTo(200, 0).build();
    const before = segmentCubic(curve, 0);
    const { network, vertex } = splitSegment(curve, 0, 0.4);
    expect(vertex).toBe(3);
    expect(network.vertices).toHaveLength(4);
    expect(network.segments).toHaveLength(3);
    // The two halves take the old segment's place, so the path still runs in order.
    expect(network.segments.map((s) => [s.start, s.end])).toEqual([
      [0, 3],
      [3, 1],
      [1, 2],
    ]);
    expect(near(network.vertices[3] as Point, cubicAt(before, 0.4), 1e-9)).toBe(true);
    for (const u of [0.2, 0.5, 0.8]) {
      expect(near(cubicAt(segmentCubic(network, 0), u), cubicAt(before, u * 0.4), 1e-9)).toBe(true);
      expect(near(cubicAt(segmentCubic(network, 1), u), cubicAt(before, 0.4 + u * 0.6), 1e-9)).toBe(true);
    }
    expect(networkGeometry(network).chains).toHaveLength(1);

    // A straight segment stays straight.
    const line = splitSegment(network, 2, 0.5).network;
    expect(line.vertices[4]).toEqual({ x: 150, y: 0 });
    // The parameter is the curve's own: a quarter of the way through it is not a quarter of the way along.
    expect(splitSegment(network, 2, 0.25).network.vertices[4]).toEqual({ x: 115.625, y: 0 });
    expect(line.segments[2]).toEqual({ start: 1, end: 4, tangentStart: { x: 0, y: 0 }, tangentEnd: { x: 0, y: 0 } });
    expect(line.segments[3]).toEqual({ start: 4, end: 2, tangentStart: { x: 0, y: 0 }, tangentEnd: { x: 0, y: 0 } });
  });

  it('removes a point from the middle of a path and closes the gap', () => {
    const path = new NetworkBuilder().moveTo(0, 0).curveTo(10, -30, 40, -30, 50, 0).curveTo(60, 30, 90, 30, 100, 0).lineTo(150, 0).build();
    const healed = removeVertices(path, [1]);
    expect(healed.vertices).toEqual([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 150, y: 0 },
    ]);
    // The neighbours are joined and keep their own handles.
    expect(healed.segments).toEqual([
      { start: 0, end: 1, tangentStart: { x: 10, y: -30 }, tangentEnd: { x: -10, y: 30 } },
      { start: 1, end: 2, tangentStart: { x: 0, y: 0 }, tangentEnd: { x: 0, y: 0 } },
    ]);
    expect(networkGeometry(healed).chains).toHaveLength(1);

    // A closed triangle that loses a corner would be a line there and back, which is one line.
    const triangle = new NetworkBuilder().moveTo(0, 0).lineTo(50, 0).lineTo(25, 40).close().build();
    const two = removeVertices(triangle, [2]);
    expect(two.vertices).toHaveLength(2);
    expect(two.segments).toHaveLength(1);
  });

  it('removes a loose end or a branch point together with its segments', () => {
    const line = new NetworkBuilder().moveTo(0, 0).lineTo(50, 0).build();
    // Nothing is left of a line that loses an end, not even the other end.
    expect(removeVertices(line, [0])).toEqual({ vertices: [], segments: [] });

    const crossed = addSegment(square().build(), 0, 2).network;
    const rest = removeVertices(crossed, [0]);
    expect(rest.vertices).toEqual([
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ]);
    expect(rest.segments.map((s) => [s.start, s.end])).toEqual([
      [0, 1],
      [1, 2],
    ]);

    // Several at once, whatever order they are given in.
    const five = new NetworkBuilder().moveTo(0, 0).lineTo(10, 0).lineTo(20, 0).lineTo(30, 0).lineTo(40, 0).build();
    expect(removeVertices(five, [1, 3]).vertices).toEqual([
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 40, y: 0 },
    ]);
    expect(removeVertices(five, [3, 1]).segments).toHaveLength(2);
  });

  it('removes segments, and the points they leave behind', () => {
    const opened = removeSegments(square().build(), [1]);
    expect(opened.vertices).toHaveLength(4);
    expect(networkGeometry(opened).chains).toHaveLength(1);
    expect(networkGeometry(opened).closed).toBe(false);
    const line = new NetworkBuilder().moveTo(0, 0).lineTo(50, 0).lineTo(50, 50).build();
    expect(removeSegments(line, [1]).vertices).toEqual([
      { x: 0, y: 0 },
      { x: 50, y: 0 },
    ]);
  });

  it('keeps the handles of a smooth point opposite each other', () => {
    const path = new NetworkBuilder().moveTo(0, 0).lineTo(50, 0).lineTo(100, 0).build();
    expect(handlesOf(path, 1)).toEqual([
      { segment: 0, end: 'end' },
      { segment: 1, end: 'start' },
    ]);
    expect(mirroringAt(path, 1)).toBe('NONE');

    const mirrored = setTangent(path, { segment: 1, end: 'start' }, { x: 10, y: 10 }, 'ANGLE_AND_LENGTH');
    expect(mirrored.segments[0]?.tangentEnd).toEqual({ x: -10, y: -10 });
    expect(mirrored.segments[1]?.tangentStart).toEqual({ x: 10, y: 10 });
    expect(mirroringAt(mirrored, 1)).toBe('ANGLE_AND_LENGTH');

    // Turning one handle turns the other, which keeps its own length.
    const turned = setTangent(mirrored, { segment: 1, end: 'start' }, { x: 30, y: 0 }, 'ANGLE');
    expect(turned.segments[0]?.tangentEnd.x).toBeCloseTo(-Math.hypot(10, 10), 9);
    expect(turned.segments[0]?.tangentEnd.y).toBeCloseTo(0, 9);
    expect(mirroringAt(turned, 1)).toBe('ANGLE');

    // Moved on its own, a handle leaves the other where it was and the point becomes a corner.
    const broken = setTangent(turned, { segment: 1, end: 'start' }, { x: 0, y: 30 });
    expect(broken.segments[0]?.tangentEnd).toEqual(turned.segments[0]?.tangentEnd);
    expect(mirroringAt(broken, 1)).toBe('NONE');
    // The input is never changed.
    expect(path.segments[0]?.tangentEnd).toEqual({ x: 0, y: 0 });
  });

  it('turns a point into a smooth point and back into a corner', () => {
    const path = new NetworkBuilder().moveTo(0, 0).lineTo(50, 50).lineTo(100, 0).build();
    const smooth = smoothVertex(path, 1);
    const reach = Math.hypot(50, 50) / 3;
    expect(smooth.segments[0]?.tangentEnd.x).toBeCloseTo(-reach, 9);
    expect(smooth.segments[0]?.tangentEnd.y).toBeCloseTo(0, 9);
    expect(smooth.segments[1]?.tangentStart.x).toBeCloseTo(reach, 9);
    expect(mirroringAt(smooth, 1)).toBe('ANGLE_AND_LENGTH');
    // The sides are curves now: half-way along, the first one has not come as far across as a straight line would.
    expect(cubicAt(segmentCubic(smooth, 0), 0.5).x).toBeLessThan(20);
    expect(cubicAt(segmentCubic(path, 0), 0.5).x).toBe(25);

    const corner = cornerVertex(smooth, 1);
    expect(corner.segments).toEqual(path.segments);
    expect(cornerVertex(corner, 1)).toBe(corner);
  });

  it('joins and merges points', () => {
    const open = new NetworkBuilder().moveTo(0, 0).lineTo(50, 0).lineTo(50, 50).lineTo(0, 50).build();
    // Joining the two ends closes the path.
    const joined = addSegment(open, 3, 0);
    expect(joined.index).toBe(3);
    expect(networkGeometry(joined.network).closed).toBe(true);
    // A second straight line between the same two points would add nothing.
    expect(addSegment(joined.network, 0, 3).network).toBe(joined.network);
    expect(addSegment(joined.network, 0, 3).index).toBe(3);
    expect(addSegment(joined.network, 2, 2).index).toBe(-1);

    // Merging puts every segment of one point onto another.
    const merged = mergeVertices(new NetworkBuilder().moveTo(0, 0).lineTo(50, 0).lineTo(50, 50).lineTo(1, 1).build(), 0, 3);
    expect(merged.vertices).toHaveLength(3);
    expect(networkGeometry(merged).closed).toBe(true);
  });

  it('moves points and finds the nearest segment', () => {
    const network = square().build();
    const moved = moveVertices(network, [1, 2], 20, 0);
    expect(moved.vertices.map((v) => v.x)).toEqual([0, 120, 120, 0]);
    expect(moveVertices(network, [], 5, 5)).toBe(network);
    const found = nearestSegment(network, { x: 104, y: 30 });
    expect(found?.segment).toBe(1);
    expect(found?.distance).toBeCloseTo(4, 3);
    expect(found?.point.y).toBeCloseTo(30, 2);
    expect(nearestSegment({ vertices: [], segments: [] }, { x: 0, y: 0 })).toBeNull();
  });
});

describe('shapes as vector networks', () => {
  const shape = (type: 'RECTANGLE' | 'ELLIPSE' | 'LINE' | 'POLYGON' | 'STAR' | 'FRAME' | 'TEXT', props: Record<string, unknown> = {}): LayerNode =>
    createLayer(type, 'p', 'a0', props);

  it('traces a rectangle, with arcs where its corners are round', () => {
    const plain = shapeNetwork(shape('RECTANGLE', { width: 100, height: 60 })) as VectorNetwork;
    expect(plain.vertices).toEqual([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 60 },
      { x: 0, y: 60 },
    ]);
    expect(networkGeometry(plain).closed).toBe(true);

    const rounded = shapeNetwork(shape('RECTANGLE', { width: 100, height: 60, cornerRadius: 10 })) as VectorNetwork;
    expect(rounded.vertices).toHaveLength(8);
    expect(rounded.segments.filter((s) => s.tangentStart.x !== 0 || s.tangentStart.y !== 0)).toHaveLength(4);
    expect(networkGeometry(rounded).bounds).toEqual({ x: 0, y: 0, width: 100, height: 60 });
    // The middle of a corner arc lies on the circle of that corner.
    const corner = cubicAt(segmentCubic(rounded, 1), 0.5);
    expect(Math.hypot(corner.x - 90, corner.y - 10)).toBeCloseTo(10, 2);

    // A pill: the round ends meet, so there are no straight sides between them.
    const pill = shapeNetwork(shape('RECTANGLE', { width: 100, height: 40, cornerRadius: 20 })) as VectorNetwork;
    expect(pill.vertices).toHaveLength(6);
    expect(pill.segments).toHaveLength(6);
    expect(networkGeometry(pill).closed).toBe(true);

    const mixed = shapeNetwork(shape('RECTANGLE', { width: 100, height: 100, cornerRadii: [0, 30, 0, 0] })) as VectorNetwork;
    expect(mixed.vertices).toHaveLength(5);
  });

  it('traces an ellipse with four curves that stay on the ellipse', () => {
    const network = shapeNetwork(shape('ELLIPSE', { width: 100, height: 60 })) as VectorNetwork;
    expect(network.vertices).toEqual([
      { x: 50, y: 0 },
      { x: 100, y: 30 },
      { x: 50, y: 60 },
      { x: 0, y: 30 },
    ]);
    expect(network.segments).toHaveLength(4);
    expect(networkGeometry(network).bounds).toEqual({ x: 0, y: 0, width: 100, height: 60 });
    for (let i = 0; i < 4; i++) {
      for (const t of [0.25, 0.5, 0.75]) {
        const p = cubicAt(segmentCubic(network, i), t);
        expect(Math.hypot((p.x - 50) / 50, (p.y - 30) / 30)).toBeCloseTo(1, 3);
      }
    }
  });

  it('traces lines, polygons and stars, and nothing for frames and text', () => {
    expect(shapeNetwork(shape('LINE', { width: 80, height: 0 }))).toEqual({
      vertices: [
        { x: 0, y: 0 },
        { x: 80, y: 0 },
      ],
      segments: [{ start: 0, end: 1, tangentStart: { x: 0, y: 0 }, tangentEnd: { x: 0, y: 0 } }],
    });
    const triangle = shapeNetwork(shape('POLYGON', { pointCount: 3 })) as VectorNetwork;
    expect(triangle.vertices).toHaveLength(3);
    expect(networkGeometry(triangle).closed).toBe(true);
    const star = shapeNetwork(shape('STAR', { pointCount: 5 })) as VectorNetwork;
    expect(star.vertices).toHaveLength(10);
    expect(star.segments).toHaveLength(10);
    expect(shapeNetwork(shape('FRAME'))).toBeNull();
    expect(shapeNetwork(shape('TEXT'))).toBeNull();
  });
});

describe('vector layers in a document', () => {
  it('flattens one shape where it is', () => {
    const { doc, pageId } = setup();
    const ellipse = addLayer(doc, 'ELLIPSE', pageId, { x: 40, y: 30, width: 120, height: 80, rotation: 25, name: 'Dot', fills: [solidPaint({ r: 1, g: 0, b: 0 })] });
    const out = flattenNodes(ellipse.doc, [ellipse.id]);
    expect(out?.id).toBe(ellipse.id);
    const vector = (out as { doc: Document }).doc.nodes[ellipse.id] as LayerNode;
    expect(isVector(vector)).toBe(true);
    expect(vector).toMatchObject({ name: 'Dot', x: 40, y: 30, width: 120, height: 80, rotation: 25, fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }] });
    expect(getWorldBounds((out as { doc: Document }).doc, ellipse.id)).toEqual(getWorldBounds(ellipse.doc, ellipse.id));
    expect(validateDocument((out as { doc: Document }).doc)).toEqual([]);
    // A vector is already flat, and a frame cannot be flattened.
    expect(flattenNodes((out as { doc: Document }).doc, [ellipse.id])).toBeNull();
    const frame = addLayer(doc, 'FRAME', pageId);
    expect(flattenNodes(frame.doc, [frame.id])).toBeNull();
  });

  it('gives a flattened line a centred stroke, because a line has no inside', () => {
    const { doc, pageId } = setup();
    const line = addLayer(doc, 'LINE', pageId, { x: 10, y: 50, width: 80, rotation: 45, strokeWeight: 4, strokeAlign: 'INSIDE' });
    const out = flattenNodes(line.doc, [line.id]) as { doc: Document; id: NodeId };
    expect(vectorOf(out.doc, out.id)).toMatchObject({ strokeAlign: 'CENTER', strokeWeight: 4, width: 80, height: 0, rotation: 45, x: 10, y: 50 });
    expect(vectorOf(out.doc, out.id).network.vertices).toEqual([
      { x: 0, y: 0 },
      { x: 80, y: 0 },
    ]);
  });

  it('flattens several shapes into one vector without moving any of them', () => {
    const { doc, pageId } = setup();
    const frame = addLayer(doc, 'FRAME', pageId, { x: 200, y: 100, width: 400, height: 300, rotation: 10 });
    const rect = addLayer(frame.doc, 'RECTANGLE', frame.id, { x: 20, y: 20, width: 100, height: 60, fills: [solidPaint({ r: 0, g: 0, b: 1 })] });
    const ellipse = addLayer(rect.doc, 'ELLIPSE', frame.id, { x: 90, y: 50, width: 80, height: 80, rotation: 30 });
    const star = addLayer(ellipse.doc, 'STAR', frame.id, { x: 200, y: 120, width: 90, height: 90 });
    const grouped = groupNodes(star.doc, [star.id]) as { doc: Document; id: NodeId };
    const before = grouped.doc;

    const expected: Point[] = [];
    for (const id of [rect.id, ellipse.id, star.id]) {
      const matrix = getWorldMatrix(before, id);
      for (const v of (shapeNetwork(before.nodes[id] as LayerNode) as VectorNetwork).vertices) expected.push(applyToPoint(matrix, v));
    }

    const out = flattenNodes(before, [grouped.id, rect.id, ellipse.id]) as { doc: Document; id: NodeId };
    const vector = vectorOf(out.doc, out.id);
    expect(vector.parentId).toBe(frame.id);
    expect(vector.name).toBe('Vector 1');
    // It looks like the bottom-most shape did.
    expect(vector.fills).toEqual([solidPaint({ r: 0, g: 0, b: 1 })]);
    // The shapes are gone, and so is the group that held nothing else.
    expect(getChildIds(out.doc, frame.id)).toEqual([out.id]);
    expect(out.doc.nodes[grouped.id]).toBeUndefined();

    const actual = worldPoints(out.doc, out.id);
    expect(actual).toHaveLength(expected.length);
    expected.forEach((p, i) => expect(near(actual[i] as Point, p, 0.005)).toBe(true));
    expect(networkGeometry(vector.network).chains).toHaveLength(3);
    expect(validateDocument(out.doc)).toEqual([]);
  });

  it('keeps the box around the curves when a point moves, also when the layer is rotated', () => {
    const { doc, pageId } = setup();
    const made = addVector(doc, pageId, square().build(), { x: 50, y: 50, rotation: 30 });
    expect(vectorOf(made.doc, made.id)).toMatchObject({ x: 50, y: 50, width: 100, height: 100 });
    const before = worldPoints(made.doc, made.id);

    // Pull the top-right corner out and up, in the layer's own axes.
    const next = setNetwork(made.doc, made.id, moveVertices(vectorOf(made.doc, made.id).network, [1], 40, -20));
    const vector = vectorOf(next, made.id);
    expect(vector.width).toBe(140);
    expect(vector.height).toBe(120);
    expect(vector.rotation).toBe(30);
    expect(networkGeometry(vector.network).bounds).toMatchObject({ x: 0, y: 0 });
    const after = worldPoints(next, made.id);
    // The other three corners have not moved on the page.
    for (const i of [0, 2, 3]) expect(near(after[i] as Point, before[i] as Point)).toBe(true);
    const r = (30 * Math.PI) / 180;
    const moved = { x: (before[1] as Point).x + 40 * Math.cos(r) + 20 * Math.sin(r), y: (before[1] as Point).y + 40 * Math.sin(r) - 20 * Math.cos(r) };
    expect(near(after[1] as Point, moved)).toBe(true);
    expect(validateDocument(next)).toEqual([]);
  });

  it('refits vectors after any edit made through the editor, and removes one with no points left', () => {
    const { doc, pageId } = setup();
    const made = addVector(doc, pageId, square().build(), { x: 10, y: 10 });
    const store = createEditorStore(made.doc);
    const network = vectorOf(made.doc, made.id).network;
    // A plain property change, as a tool would make it.
    store.getState().apply('Move point', (d) => patchNode(d, made.id, { network: moveVertices(network, [0], -30, -30) }));
    expect(vectorOf(store.getState().doc, made.id)).toMatchObject({ x: -20, y: -20, width: 130, height: 130 });
    expect(vectorOf(store.getState().doc, made.id).network.vertices[0]).toEqual({ x: 0, y: 0 });
    store.getState().undo();
    expect(store.getState().doc).toEqual(made.doc);
    store.getState().redo();
    expect(vectorOf(store.getState().doc, made.id).width).toBe(130);

    store.getState().apply('Delete points', (d) => patchNode(d, made.id, { network: { vertices: [], segments: [] } }));
    expect(store.getState().doc.nodes[made.id]).toBeUndefined();
    store.getState().undo();
    expect(vectorOf(store.getState().doc, made.id).width).toBe(130);
  });

  it('scales the curves when the layer is resized', () => {
    const { doc, pageId } = setup();
    const ellipse = addLayer(doc, 'ELLIPSE', pageId, { x: 0, y: 0, width: 100, height: 100 });
    const flat = flattenNodes(ellipse.doc, [ellipse.id]) as { doc: Document; id: NodeId };
    const resized = setLayerBox(flat.doc, flat.id, { width: 200, height: 50 });
    const vector = vectorOf(resized, flat.id);
    expect(vector).toMatchObject({ width: 200, height: 50 });
    expect(vector.network.vertices).toEqual([
      { x: 100, y: 0 },
      { x: 200, y: 25 },
      { x: 100, y: 50 },
      { x: 0, y: 25 },
    ]);
    // Handles stretch with it: still an ellipse.
    const p = cubicAt(segmentCubic(vector.network, 0), 0.5);
    expect(Math.hypot((p.x - 100) / 100, (p.y - 25) / 25)).toBeCloseTo(1, 3);
    expect(fitVectorNode(vector)).toBe(vector);

    // Inside a group that is resized.
    const grouped = groupNodes(flat.doc, [flat.id]) as { doc: Document; id: NodeId };
    const bigger = setLayerBox(grouped.doc, grouped.id, { width: 300, height: 100 });
    expect(vectorOf(bigger, flat.id)).toMatchObject({ width: 300, height: 100 });
    expect(vectorOf(bigger, flat.id).network.vertices[1]).toEqual({ x: 300, y: 50 });
    expect(fitVectorNode(vectorOf(bigger, flat.id))).toBe(vectorOf(bigger, flat.id));
  });

  it('cannot stretch a vector in a direction in which it is flat', () => {
    const { doc, pageId } = setup();
    const made = addVector(doc, pageId, new NetworkBuilder().moveTo(0, 0).lineTo(100, 0).build(), { x: 10, y: 10 });
    const resized = setLayerBox(made.doc, made.id, { width: 50, height: 40 });
    expect(vectorOf(resized, made.id)).toMatchObject({ width: 50, height: 0 });
    expect(vectorOf(resized, made.id).network.vertices[1]).toEqual({ x: 50, y: 0 });
  });

  it('mirrors the curves when a vector is flipped', () => {
    const { doc, pageId } = setup();
    // An L, which looks different in a mirror.
    const l = new NetworkBuilder().moveTo(0, 0).lineTo(100, 0).lineTo(100, 20).lineTo(20, 20).lineTo(20, 60).lineTo(0, 60).close().build();
    const made = addVector(doc, pageId, l, { x: 30, y: 40 });
    const flipped = flipNodes(made.doc, [made.id], 'horizontal');
    expect(vectorOf(flipped, made.id)).toMatchObject({ x: 30, y: 40, width: 100, height: 60 });
    expect(vectorOf(flipped, made.id).network.vertices.map((v) => [v.x, v.y])).toEqual([
      [100, 0],
      [0, 0],
      [0, 20],
      [80, 20],
      [80, 60],
      [100, 60],
    ]);
    expect(vectorOf(flipNodes(flipped, [made.id], 'horizontal'), made.id).network.vertices).toEqual(l.vertices);
    const upsideDown = flipNodes(made.doc, [made.id], 'vertical');
    expect(vectorOf(upsideDown, made.id).network.vertices[0]).toEqual({ x: 0, y: 60 });
    expect(fitVectorNode(vectorOf(upsideDown, made.id))).toBe(vectorOf(upsideDown, made.id));
  });

  it('is selected by what it paints: its filled regions and its lines', () => {
    const { doc, pageId } = setup();
    const outer = square(100).build();
    const inner = square(20, 40).build();
    const ring: VectorNetwork = {
      vertices: [...outer.vertices, ...inner.vertices],
      segments: [...outer.segments, ...inner.segments.map((s) => ({ ...s, start: s.start + 4, end: s.end + 4 }))],
    };
    const filled = addVector(doc, pageId, ring, { x: 100, y: 100, fills: [solidPaint({ r: 0, g: 0, b: 0 })], strokes: [], windingRule: 'EVENODD' });
    expect(hitTestDeepest(filled.doc, pageId, { x: 110, y: 110 })).toBe(filled.id);
    // The hole is not part of the shape.
    expect(hitTestDeepest(filled.doc, pageId, { x: 150, y: 150 })).toBeNull();
    const solid = patchNode(filled.doc, filled.id, { windingRule: 'NONZERO' });
    expect(hitTestDeepest(solid, pageId, { x: 150, y: 150 })).toBe(filled.id);

    // An outline only: caught on the line (with some tolerance), not in the space it goes round.
    const open = addVector(doc, pageId, new NetworkBuilder().moveTo(0, 0).lineTo(100, 0).lineTo(100, 100).build(), { x: 300, y: 300 });
    expect(hitTestDeepest(open.doc, pageId, { x: 350, y: 302 }, 4)).toBe(open.id);
    expect(hitTestDeepest(open.doc, pageId, { x: 380, y: 330 }, 4)).toBeNull();
  });

  it('validates networks and repairs damaged ones', () => {
    const { doc, pageId } = setup();
    const made = addVector(doc, pageId, new NetworkBuilder().moveTo(0, 0).curveTo(0, 50, 50, 50, 50, 0).build(), { x: 5, y: 5 });
    expect(validateDocument(made.doc)).toEqual([]);

    const data = JSON.parse(JSON.stringify(made.doc)) as { nodes: Record<string, Record<string, unknown>> };
    Object.assign(data.nodes[made.id] as Record<string, unknown>, {
      windingRule: 'SIDEWAYS',
      width: 999,
      network: {
        vertices: [{ x: 10, y: 10 }, { x: 'far', y: 10 }, null, { x: 60, y: 10 }],
        segments: [
          { start: 0, end: 3, tangentStart: { x: 0, y: 0 }, tangentEnd: { x: 0, y: Number.NaN } },
          { start: 0, end: 9, tangentStart: { x: 0, y: 0 }, tangentEnd: { x: 0, y: 0 } },
          { start: 1.5, end: 2 },
          'segment',
        ],
      },
    });
    const repaired = repairDocument(data);
    expect(repaired.repairs.length).toBeGreaterThan(0);
    const vector = vectorOf(repaired.doc, made.id);
    expect(vector.windingRule).toBe('NONZERO');
    // Points with bad coordinates stay, so the numbering of the others still holds; segments to nowhere go.
    expect(vector.network.vertices).toHaveLength(4);
    expect(vector.network.segments).toEqual([{ start: 0, end: 3, tangentStart: { x: 0, y: 0 }, tangentEnd: { x: 0, y: 0 } }]);
    // And the box is the box of what is left.
    expect(networkGeometry(vector.network).bounds).toMatchObject({ x: 0, y: 0, width: vector.width, height: vector.height });
    expect(validateDocument(repaired.doc)).toEqual([]);
  });

  it('opens a version 7 file, which has no vector layers', () => {
    const { doc, pageId } = setup();
    const rect = addLayer(doc, 'RECTANGLE', pageId, { x: 10, y: 20, cornerRadius: 6 });
    const parsed = parseFile({
      format: 'open-design',
      schemaVersion: 7,
      meta: { createdAt: '2026-11-16T09:00:00.000Z', updatedAt: '2026-11-16T09:00:00.000Z' },
      document: JSON.parse(JSON.stringify(rect.doc)),
    });
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(8);
    expect(parsed.file.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(parsed.repairs).toEqual([]);
    expect(parsed.file.document).toEqual(rect.doc);
  });
});

describe('drawing vector layers', () => {
  /** A canvas context that records the calls that build and paint paths. */
  function recorder(): { ctx: CanvasRenderingContext2D; calls: string[] } {
    const calls: string[] = [];
    const target: Record<string, unknown> = {};
    const ctx = new Proxy(target, {
      get(obj, prop: string) {
        if (prop in obj) return obj[prop];
        return (...args: unknown[]) => {
          if (['moveTo', 'lineTo', 'bezierCurveTo', 'closePath', 'fill', 'stroke', 'clip'].includes(prop)) {
            calls.push(args.length > 0 && typeof args[0] === 'string' ? `${prop}:${String(args[0])}` : prop);
          }
        };
      },
      set(obj, prop: string, value) {
        obj[prop] = value;
        return true;
      },
    });
    return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
  }

  const view = { size: { width: 800, height: 600 }, dpr: 1, viewport: { x: 0, y: 0, zoom: 1 } };

  it('traces regions for a fill and every segment for a stroke', () => {
    const { doc, pageId } = setup();
    const open = addVector(doc, pageId, new NetworkBuilder().moveTo(0, 0).curveTo(0, 50, 50, 50, 50, 0).lineTo(90, 0).build());
    const node = vectorOf(open.doc, open.id);
    const fill = recorder();
    traceLayerPath(fill.ctx, node, 0, 'fill');
    // Filled as if closed.
    expect(fill.calls).toEqual(['moveTo', 'bezierCurveTo', 'lineTo', 'closePath']);
    const stroke = recorder();
    traceLayerPath(stroke.ctx, node, 0, 'stroke');
    // Stroked as drawn: the ends stay loose.
    expect(stroke.calls).toEqual(['moveTo', 'bezierCurveTo', 'lineTo']);

    const closed = recorder();
    traceLayerPath(closed.ctx, { ...node, network: square().build() }, 0, 'stroke');
    expect(closed.calls).toEqual(['moveTo', 'lineTo', 'lineTo', 'lineTo', 'lineTo', 'closePath']);
  });

  it('fills by the layer’s winding rule and strokes an open path along its centre', () => {
    const { doc, pageId } = setup();
    const made = addVector(doc, pageId, square().build(), {
      x: 20,
      y: 20,
      fills: [solidPaint({ r: 1, g: 0, b: 0 })],
      strokes: [solidPaint({ r: 0, g: 0, b: 0 })],
      strokeWeight: 4,
      strokeAlign: 'INSIDE',
      windingRule: 'EVENODD',
    });
    const first = recorder();
    expect(renderScene(first.ctx, made.doc, pageId, view)).toEqual({ drawn: 1, culled: 0 });
    expect(first.calls.filter((call) => call.startsWith('fill'))).toEqual(['fill:evenodd']);
    // An inside stroke is clipped to the shape, by the same rule.
    expect(first.calls.filter((call) => call.startsWith('clip'))).toEqual(['clip:evenodd']);
    expect(strokeAlignOf(vectorOf(made.doc, made.id))).toBe('INSIDE');

    const opened = setNetwork(made.doc, made.id, removeSegments(vectorOf(made.doc, made.id).network, [3]));
    expect(strokeAlignOf(vectorOf(opened, made.id))).toBe('CENTER');
    const second = recorder();
    renderScene(second.ctx, opened, pageId, view);
    expect(second.calls.filter((call) => call.startsWith('clip'))).toEqual([]);
    expect(second.calls.filter((call) => call === 'stroke')).toHaveLength(1);

    const plain = recorder();
    renderScene(plain.ctx, patchNodes(made.doc, { [made.id]: { windingRule: 'NONZERO', strokes: [] } }), pageId, view);
    expect(plain.calls.filter((call) => call.startsWith('fill'))).toEqual(['fill']);
  });

  it('allows for the mitred tips of sharp corners when working out what a vector covers', () => {
    const { doc, pageId } = setup();
    const made = addVector(doc, pageId, new NetworkBuilder().moveTo(0, 100).lineTo(10, 0).lineTo(20, 100).build(), { x: 100, y: 100, strokeWeight: 4 });
    expect(getRenderBounds(made.doc, made.id)).toEqual({ x: 80, y: 80, width: 60, height: 140 });
    const round = patchNode(made.doc, made.id, { strokeJoin: 'ROUND' });
    expect(getRenderBounds(round, made.id)).toEqual({ x: 96, y: 96, width: 28, height: 108 });
  });
});

describe('flattening from the editor', () => {
  const app: AppActions = {
    cancelInteraction: () => false,
    openShortcuts: () => undefined,
    saveNow: () => undefined,
    saveAs: () => undefined,
    placeImage: () => undefined,
    goHome: () => undefined,
  };

  it('flattens the selection with Ctrl+E, as one undo step', () => {
    const { doc, pageId } = setup();
    const a = addLayer(doc, 'RECTANGLE', pageId, { x: 0, y: 0 });
    const b = addLayer(a.doc, 'ELLIPSE', pageId, { x: 60, y: 60 });
    const text = addLayer(b.doc, 'TEXT', pageId, { x: 300, y: 0, characters: 'Hello' });
    const store = createEditorStore(text.doc);
    const command = commandForKey({ code: 'KeyE', ctrlKey: true, shiftKey: false, altKey: false, metaKey: false });
    expect(command?.id).toBe('object.flatten');
    expect(getCommand('object.flatten')?.enabled?.(store.getState())).toBe(false);
    store.getState().setSelection([text.id]);
    expect(getCommand('object.flatten')?.enabled?.(store.getState())).toBe(false);

    store.getState().setSelection([a.id, b.id]);
    expect(getCommand('object.flatten')?.enabled?.(store.getState())).toBe(true);
    expect(runCommand(command as NonNullable<typeof command>, { store, app })).toBe(true);
    const state = store.getState();
    expect(state.selection).toHaveLength(1);
    const vector = vectorOf(state.doc, state.selection[0] as NodeId);
    expect(vector).toMatchObject({ type: 'VECTOR', x: 0, y: 0, width: 160, height: 160 });
    expect(state.doc.nodes[a.id]).toBeUndefined();
    expect(state.undoStack.map((entry) => entry.label)).toEqual(['Flatten']);
    // One vector on its own has nothing left to flatten.
    expect(getCommand('object.flatten')?.enabled?.(state)).toBe(false);

    state.undo();
    expect(store.getState().doc).toEqual(text.doc);
    expect(store.getState().selection).toEqual([a.id, b.id]);
    store.getState().redo();
    expect(store.getState().doc.nodes[a.id]).toBeUndefined();
    expect(Object.values(store.getState().doc.nodes).filter((node) => node.type === 'VECTOR')).toHaveLength(1);
  });

  it('turns a single shape into a vector and back again with undo', () => {
    const { doc, pageId } = setup();
    const rect = addLayer(doc, 'RECTANGLE', pageId, { x: 10, y: 10, cornerRadius: 12 });
    const store = createEditorStore(rect.doc);
    store.getState().setSelection([rect.id]);
    runCommand(getCommand('object.flatten') as NonNullable<ReturnType<typeof getCommand>>, { store, app });
    const vector = store.getState().doc.nodes[rect.id] as LayerNode;
    expect(vector.type).toBe('VECTOR');
    expect('cornerRadius' in vector).toBe(false);
    expect(store.getState().selection).toEqual([rect.id]);
    store.getState().undo();
    expect(store.getState().doc.nodes[rect.id]).toEqual(rect.doc.nodes[rect.id]);
  });
});
