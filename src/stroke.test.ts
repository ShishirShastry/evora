import { describe, expect, it } from 'vitest';
import {
  addLayer,
  booleanNetworks,
  canOutlineStroke,
  createDocument,
  createLayer,
  dashPolyline,
  flattenCubic,
  getChildIds,
  getPages,
  getWorldBounds,
  NetworkBuilder,
  networkGeometry,
  outlineStrokes,
  solidPaint,
  stepCubic,
  strokeOutline,
  strokePolyline,
  validateDocument,
  type Document,
  type LayerNode,
  type NodeId,
  type Point,
  type VectorNetwork,
  type VectorNode,
} from './core';
import { commandForKey, runCommand, type AppActions, type Command } from './state/commands';
import { createEditorStore } from './state/editorStore';

/** The area a network's fill covers, counting outlines that run the other way round as holes. */
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

/** The area polygons cover together when filled by the non-zero rule. */
function covered(polygons: readonly Point[][]): number {
  const path = new NetworkBuilder();
  for (const polygon of polygons) {
    polygon.forEach((p, i) => (i === 0 ? path.moveTo(p.x, p.y) : path.lineTo(p.x, p.y)));
    path.close();
  }
  return area(booleanNetworks([{ network: path.build(), windingRule: 'NONZERO' }], 'UNION'));
}

const BLACK = solidPaint({ r: 0, g: 0, b: 0 });
const RED = solidPaint({ r: 1, g: 0, b: 0 });
const shape = (type: 'RECTANGLE' | 'ELLIPSE' | 'LINE', props: Record<string, unknown>): LayerNode =>
  createLayer(type, 'p', 'a0', { strokes: [BLACK], fills: [], ...props });
const bounds = (network: VectorNetwork) => networkGeometry(network).bounds;

describe('the shape of a stroke', () => {
  const line: Point[] = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
  ];
  const elbow: Point[] = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
  ];

  it('gives a line its width and its caps', () => {
    expect(strokePolyline(line, false, 10, 'NONE', 'MITER')).toEqual([
      [
        { x: 0, y: 5 },
        { x: 100, y: 5 },
        { x: 100, y: -5 },
        { x: 0, y: -5 },
      ],
    ]);
    expect(covered(strokePolyline(line, false, 10, 'NONE', 'MITER'))).toBeCloseTo(1000, 6);
    // Square ends reach half the width further at each end; round ends are half discs.
    expect(covered(strokePolyline(line, false, 10, 'SQUARE', 'MITER'))).toBeCloseTo(1100, 6);
    expect(Math.abs(covered(strokePolyline(line, false, 10, 'ROUND', 'MITER')) - (1000 + Math.PI * 25))).toBeLessThan(0.5);
    // No width, or no path, is no stroke; a path of no length is a dot only if its ends are round or square.
    expect(strokePolyline(line, false, 0, 'ROUND', 'MITER')).toEqual([]);
    expect(strokePolyline([{ x: 5, y: 5 }], false, 10, 'NONE', 'MITER')).toEqual([]);
    expect(Math.abs(covered(strokePolyline([{ x: 5, y: 5 }], false, 10, 'ROUND', 'MITER')) - Math.PI * 25)).toBeLessThan(0.5);
    expect(covered(strokePolyline([{ x: 5, y: 5 }], false, 10, 'SQUARE', 'MITER'))).toBeCloseTo(100, 6);
  });

  it('joins corners sharp, cut or round', () => {
    // Two arms of 100 × 10; the corner square is counted once, and the sharp tip fills it out.
    expect(covered(strokePolyline(elbow, false, 10, 'NONE', 'MITER'))).toBeCloseTo(2000, 6);
    // Cut: half of the tip's square is missing.
    expect(covered(strokePolyline(elbow, false, 10, 'NONE', 'BEVEL'))).toBeCloseTo(1987.5, 6);
    // Round: a quarter disc instead of the square.
    expect(Math.abs(covered(strokePolyline(elbow, false, 10, 'NONE', 'ROUND')) - (1975 + (Math.PI * 25) / 4))).toBeLessThan(0.2);
    // A very sharp corner is cut off rather than given a tip many times the stroke's width.
    const spike = [
      { x: 0, y: 0 },
      { x: 100, y: 2 },
      { x: 0, y: 4 },
    ];
    const tip = Math.max(...(strokePolyline(spike, false, 4, 'NONE', 'MITER')[0] as Point[]).map((p) => p.x));
    expect(tip).toBeLessThan(103);
  });

  it('gives a closed path an outside and an inside edge', () => {
    const square = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ];
    const polygons = strokePolyline(square, true, 10, 'NONE', 'MITER');
    expect(polygons).toHaveLength(2);
    expect(covered(polygons)).toBeCloseTo(110 * 110 - 90 * 90, 6);
  });

  it('cuts a path into dashes', () => {
    const dashes = dashPolyline(line, false, [10, 5]);
    expect(dashes.map((dash) => [dash.points[0]?.x, dash.points.at(-1)?.x])).toEqual([
      [0, 10],
      [15, 25],
      [30, 40],
      [45, 55],
      [60, 70],
      [75, 85],
      [90, 100],
    ]);
    expect(dashes.every((dash) => !dash.closed)).toBe(true);
    // Dashes run round corners, and a path with no dashes is left whole.
    const round = dashPolyline(elbow, false, [150, 20]);
    expect(round[0]?.points).toEqual([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 50 },
    ]);
    expect(round[1]?.points[0]).toEqual({ x: 100, y: 70 });
    expect(dashPolyline(elbow, false, [])).toEqual([{ points: elbow, closed: false }]);
    expect(dashPolyline(elbow, true, [0, 0])).toEqual([{ points: elbow, closed: true }]);
  });
});

describe('outlining the stroke of a layer', () => {
  it('follows where the stroke is: centred, inside or outside', () => {
    const centred = strokeOutline(shape('RECTANGLE', { width: 100, height: 100, strokeWeight: 10, strokeAlign: 'CENTER' })) as VectorNetwork;
    expect(area(centred)).toBeCloseTo(4000, 4);
    expect(bounds(centred)).toEqual({ x: -5, y: -5, width: 110, height: 110 });
    expect(networkGeometry(centred).chains).toHaveLength(2);
    // Straight edges come out as straight edges: four corners outside, four inside.
    expect(centred.vertices).toHaveLength(8);

    const inside = strokeOutline(shape('RECTANGLE', { width: 100, height: 100, strokeWeight: 10, strokeAlign: 'INSIDE' })) as VectorNetwork;
    expect(area(inside)).toBeCloseTo(100 * 100 - 80 * 80, 4);
    expect(bounds(inside)).toEqual({ x: 0, y: 0, width: 100, height: 100 });

    const outside = strokeOutline(shape('RECTANGLE', { width: 100, height: 100, strokeWeight: 10, strokeAlign: 'OUTSIDE' })) as VectorNetwork;
    expect(area(outside)).toBeCloseTo(120 * 120 - 100 * 100, 4);
    expect(bounds(outside)).toEqual({ x: -10, y: -10, width: 120, height: 120 });

    // Nothing to outline.
    expect(strokeOutline(shape('RECTANGLE', { strokeWeight: 0 }))).toBeNull();
    expect(strokeOutline(createLayer('TEXT', 'p', 'a0', { characters: 'Hi', strokes: [BLACK], strokeWeight: 2 }))).toBeNull();
    expect(strokeOutline(createLayer('FRAME', 'p', 'a0', { strokes: [BLACK], strokeWeight: 2 }))).toBeNull();
  });

  it('turns the stroke of a curve back into curves', () => {
    const ring = strokeOutline(shape('ELLIPSE', { width: 100, height: 100, strokeWeight: 10, strokeAlign: 'CENTER' })) as VectorNetwork;
    // A band of width 10 about a circle of radius 50.
    expect(Math.abs(area(ring) - Math.PI * (55 * 55 - 45 * 45))).toBeLessThan(6);
    expect(networkGeometry(ring).chains).toHaveLength(2);
    // Hundreds of little straight pieces went in; a handful of curves come out.
    expect(ring.segments.length).toBeLessThan(40);
    expect(ring.segments.some((s) => s.tangentStart.x !== 0 || s.tangentStart.y !== 0)).toBe(true);
    const box = bounds(ring);
    expect(Math.abs((box?.x ?? 0) + 5)).toBeLessThan(0.1);
    expect(Math.abs((box?.width ?? 0) - 110)).toBeLessThan(0.2);
  });

  it('includes round ends, dashes and arrowheads', () => {
    const round = strokeOutline(shape('LINE', { width: 100, height: 0, strokeWeight: 10, strokeCap: 'ROUND' })) as VectorNetwork;
    // (Curves are fitted to within a twentieth of a pixel of the true outline.)
    expect(Math.abs(area(round) - (1000 + Math.PI * 25))).toBeLessThan(3);
    expect(bounds(round)?.x).toBeCloseTo(-5, 1);

    const dashed = strokeOutline(shape('LINE', { width: 100, height: 0, strokeWeight: 4, dashPattern: [10, 5] })) as VectorNetwork;
    expect(networkGeometry(dashed).chains).toHaveLength(7);
    expect(area(dashed)).toBeCloseTo(7 * 40, 4);

    // A triangle at the end: the shaft stops 7.5 short of the tip, inside the head.
    const arrow = strokeOutline(shape('LINE', { width: 100, height: 0, strokeWeight: 2, endArrow: 'TRIANGLE' })) as VectorNetwork;
    expect(networkGeometry(arrow).chains).toHaveLength(1);
    expect(area(arrow)).toBeCloseTo(92.5 * 2 + 50 - 5, 3);
    expect(bounds(arrow)).toMatchObject({ x: 0, width: 100, height: 10 });
    const dot = strokeOutline(shape('LINE', { width: 100, height: 0, strokeWeight: 2, startArrow: 'CIRCLE' })) as VectorNetwork;
    expect(bounds(dot)?.x).toBeCloseTo(-5, 1);
  });
});

describe('Outline stroke on layers', () => {
  function setup(): { doc: Document; pageId: NodeId } {
    const doc = createDocument('Strokes');
    return { doc, pageId: (getPages(doc)[0] as { id: NodeId }).id };
  }
  const app: AppActions = { cancelInteraction: () => false, openShortcuts: () => undefined, saveNow: () => undefined, saveAs: () => undefined, placeImage: () => undefined, goHome: () => undefined };

  it('replaces a layer that was only a stroke', () => {
    const { doc, pageId } = setup();
    const made = addLayer(doc, 'ELLIPSE', pageId, { x: 100, y: 100, width: 80, height: 80, rotation: 30, name: 'Ring', fills: [], strokes: [RED], strokeWeight: 6, strokeAlign: 'CENTER' });
    expect(canOutlineStroke(made.doc, [made.id])).toBe(true);
    const out = outlineStrokes(made.doc, [made.id]) as { doc: Document; ids: NodeId[] };
    expect(out.ids).toEqual([made.id]);
    const vector = out.doc.nodes[made.id] as VectorNode;
    // What painted the stroke now fills the shape.
    expect(vector).toMatchObject({ type: 'VECTOR', name: 'Ring', rotation: 30, fills: [RED], strokes: [], windingRule: 'NONZERO' });
    expect(Math.abs(vector.width - 86)).toBeLessThan(0.2);
    expect(Math.abs(vector.height - 86)).toBeLessThan(0.2);
    // Still centred where the ellipse was.
    const before = getWorldBounds(made.doc, made.id);
    const after = getWorldBounds(out.doc, made.id);
    expect(after.x + after.width / 2).toBeCloseTo(before.x + before.width / 2, 1);
    expect(after.y + after.height / 2).toBeCloseTo(before.y + before.height / 2, 1);
    expect(validateDocument(out.doc)).toEqual([]);
  });

  it('leaves a fill where it is and puts the stroke above it', () => {
    const { doc, pageId } = setup();
    const made = addLayer(doc, 'RECTANGLE', pageId, { x: 50, y: 50, width: 100, height: 60, name: 'Card', fills: [solidPaint({ r: 0, g: 0, b: 1 })], strokes: [RED], strokeWeight: 8, strokeAlign: 'OUTSIDE' });
    const out = outlineStrokes(made.doc, [made.id]) as { doc: Document; ids: NodeId[] };
    expect(out.ids).toHaveLength(1);
    const [strokeId] = out.ids as [NodeId];
    expect(getChildIds(out.doc, pageId)).toEqual([made.id, strokeId]);
    expect(out.doc.nodes[made.id]).toMatchObject({ type: 'RECTANGLE', strokes: [], fills: [solidPaint({ r: 0, g: 0, b: 1 })] });
    expect(out.doc.nodes[strokeId]).toMatchObject({ type: 'VECTOR', name: 'Card stroke', fills: [RED], strokes: [], x: 42, y: 42, width: 116, height: 76 });
    // A layer with no stroke that shows has nothing to outline.
    expect(canOutlineStroke(out.doc, [made.id])).toBe(false);
    expect(outlineStrokes(out.doc, [made.id])).toBeNull();
  });

  it('runs from the keyboard, as one undo step', () => {
    const { doc, pageId } = setup();
    const made = addLayer(doc, 'LINE', pageId, { x: 10, y: 10, width: 100, strokeWeight: 4, endArrow: 'TRIANGLE' });
    const store = createEditorStore(made.doc);
    const command = commandForKey({ code: 'KeyO', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false }) as Command;
    expect(command.id).toBe('object.outlineStroke');
    expect(command.enabled?.(store.getState())).toBe(false);
    store.getState().setSelection([made.id]);
    expect(command.enabled?.(store.getState())).toBe(true);
    runCommand(command, { store, app });
    const state = store.getState();
    expect(state.undoStack.map((entry) => entry.label)).toEqual(['Outline stroke']);
    expect(state.selection).toEqual([made.id]);
    expect(state.doc.nodes[made.id]).toMatchObject({ type: 'VECTOR', strokes: [] });
    expect('endArrow' in (state.doc.nodes[made.id] as object) && (state.doc.nodes[made.id] as VectorNode).endArrow).toBe('NONE');
    state.undo();
    expect(store.getState().doc).toEqual(made.doc);
  });
});
