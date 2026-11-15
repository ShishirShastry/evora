import { describe, expect, it } from 'vitest';
import {
  addLayer,
  arrowShape,
  booleanNodes,
  createDocument,
  createLayer,
  cubicAt,
  CURRENT_SCHEMA_VERSION,
  fitVectorNode,
  flattenCubic,
  flattenNodes,
  getPages,
  hasArc,
  hitTestDeepest,
  NetworkBuilder,
  networkGeometry,
  parameterAtDistance,
  parseFile,
  patchNode,
  pathEnds,
  pointInNetworkFill,
  repairDocument,
  setNodes,
  segmentCubic,
  shapeNetwork,
  stepCubic,
  trimEnd,
  trimStart,
  validateDocument,
  type Cubic,
  type Document,
  type EllipseNode,
  type LineNode,
  type NodeId,
  type PathEnd,
  type Point,
  type VectorNetwork,
  type VectorNode,
} from './core';
import { freshKeys } from './core/order';
import { arcHandles } from './engine/input/arcHandles';
import { InteractionController, type PointerInput } from './engine/input/controller';
import { arrowHeads, traceLayerPath, traceStrokePath } from './engine/render/paint';
import { getRenderBounds, renderScene } from './engine/render/scene';
import { createEditorStore, type EditorStore } from './state/editorStore';

function setup(): { doc: Document; pageId: NodeId } {
  const doc = createDocument('Arcs');
  return { doc, pageId: (getPages(doc)[0] as { id: NodeId }).id };
}

const ellipse = (props: Partial<EllipseNode>): EllipseNode => createLayer('ELLIPSE', 'p', 'a0', { width: 200, height: 200, ...props }) as EllipseNode;

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

/** A canvas context that records the calls that build and paint paths, with their arguments. */
function recorder(): { ctx: CanvasRenderingContext2D; calls: [string, ...unknown[]][] } {
  const calls: [string, ...unknown[]][] = [];
  const target: Record<string, unknown> = {};
  const ctx = new Proxy(target, {
    get(obj, prop: string) {
      if (prop in obj) return obj[prop];
      return (...args: unknown[]) => {
        if (['moveTo', 'lineTo', 'bezierCurveTo', 'closePath', 'ellipse', 'arc', 'fill', 'stroke', 'setLineDash'].includes(prop)) calls.push([prop, ...args]);
      };
    },
    set(obj, prop: string, value) {
      obj[prop] = value;
      return true;
    },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

const names = (calls: [string, ...unknown[]][]): string[] => calls.map((call) => call[0]);

describe('arcs: slices and rings of an ellipse', () => {
  it('is a whole ellipse until it is told otherwise', () => {
    const whole = ellipse({});
    expect(whole).toMatchObject({ arcStart: 0, arcSweep: 360, arcRatio: 0 });
    expect(hasArc(whole)).toBe(false);
    expect(hasArc(ellipse({ arcSweep: 359 }))).toBe(true);
    expect(hasArc(ellipse({ arcRatio: 0.1 }))).toBe(true);
    expect(shapeNetwork(whole)?.vertices).toHaveLength(4);
  });

  it('outlines a slice: an arc and two straight sides to the centre', () => {
    const quarter = shapeNetwork(ellipse({ arcSweep: 90 })) as VectorNetwork;
    // From three o'clock clockwise to six o'clock, then the centre.
    expect(quarter.vertices.map((v) => [Math.round(v.x), Math.round(v.y)])).toEqual([
      [200, 100],
      [100, 200],
      [100, 100],
    ]);
    expect(quarter.segments).toHaveLength(3);
    expect(networkGeometry(quarter).closed).toBe(true);
    expect(Math.abs(area(quarter) - (Math.PI * 10000) / 4)).toBeLessThan(3);
    // The arc stays on the circle.
    const middle = cubicAt(segmentCubic(quarter, 0), 0.5);
    expect(Math.hypot(middle.x - 100, middle.y - 100)).toBeCloseTo(100, 1);

    // Three quarters: three curves, none longer than a quarter turn.
    const most = shapeNetwork(ellipse({ arcStart: 90, arcSweep: 270 })) as VectorNetwork;
    expect(most.vertices).toHaveLength(5);
    expect(Math.abs(area(most) - Math.PI * 7500)).toBeLessThan(8);
    expect(pointInNetworkFill(most, { x: 50, y: 150 }, 'NONZERO')).toBe(true);
    // The missing quarter is the one from three o'clock to six o'clock.
    expect(pointInNetworkFill(most, { x: 150, y: 150 }, 'NONZERO')).toBe(false);

    // On an ellipse that is wider than it is tall.
    const wide = shapeNetwork(ellipse({ height: 100, arcSweep: 90 })) as VectorNetwork;
    expect(Math.abs(area(wide) - (Math.PI * 100 * 50) / 4)).toBeLessThan(2);
  });

  it('outlines a ring, whose hole is a hole whatever the fill rule', () => {
    const ring = shapeNetwork(ellipse({ arcRatio: 0.5 })) as VectorNetwork;
    expect(networkGeometry(ring).chains).toHaveLength(2);
    expect(networkGeometry(ring).closed).toBe(true);
    expect(Math.abs(area(ring) - Math.PI * 7500)).toBeLessThan(8);
    for (const rule of ['NONZERO', 'EVENODD'] as const) {
      expect(pointInNetworkFill(ring, { x: 100, y: 100 }, rule)).toBe(false);
      expect(pointInNetworkFill(ring, { x: 100, y: 25 }, rule)).toBe(true);
    }
  });

  it('outlines a piece of a ring', () => {
    // From nine o'clock clockwise to twelve: the upper left quarter, with the middle half cut out.
    const piece = shapeNetwork(ellipse({ arcStart: 180, arcSweep: 90, arcRatio: 0.5 })) as VectorNetwork;
    expect(networkGeometry(piece).chains).toHaveLength(1);
    expect(networkGeometry(piece).closed).toBe(true);
    expect(piece.vertices).toHaveLength(4);
    expect(Math.abs(area(piece) - (Math.PI * 7500) / 4)).toBeLessThan(3);
    expect(pointInNetworkFill(piece, { x: 47, y: 47 }, 'NONZERO')).toBe(true);
    expect(pointInNetworkFill(piece, { x: 80, y: 80 }, 'NONZERO')).toBe(false);
    expect(pointInNetworkFill(piece, { x: 153, y: 153 }, 'NONZERO')).toBe(false);
  });

  it('is selected by what is left of it', () => {
    const { doc, pageId } = setup();
    const made = addLayer(doc, 'ELLIPSE', pageId, { x: 100, y: 100, width: 200, height: 200, arcSweep: 90 });
    // The slice is the lower right quarter.
    expect(hitTestDeepest(made.doc, pageId, { x: 250, y: 250 })).toBe(made.id);
    expect(hitTestDeepest(made.doc, pageId, { x: 150, y: 150 })).toBeNull();
    const ring = patchNode(made.doc, made.id, { arcSweep: 360, arcRatio: 0.6 });
    expect(hitTestDeepest(ring, pageId, { x: 200, y: 200 })).toBeNull();
    expect(hitTestDeepest(ring, pageId, { x: 200, y: 115 })).toBe(made.id);
    const whole = patchNode(made.doc, made.id, { arcSweep: 360 });
    expect(hitTestDeepest(whole, pageId, { x: 150, y: 150 })).toBe(made.id);
  });

  it('is traced for the canvas with arcs, not approximations', () => {
    const whole = recorder();
    traceLayerPath(whole.ctx, ellipse({}));
    expect(names(whole.calls)).toEqual(['ellipse', 'closePath']);

    const slice = recorder();
    traceLayerPath(slice.ctx, ellipse({ arcStart: 90, arcSweep: 180 }));
    expect(names(slice.calls)).toEqual(['ellipse', 'lineTo', 'closePath']);
    expect(slice.calls[0]).toEqual(['ellipse', 100, 100, 100, 100, 0, Math.PI / 2, (Math.PI * 3) / 2]);
    expect(slice.calls[1]).toEqual(['lineTo', 100, 100]);

    const piece = recorder();
    traceLayerPath(piece.ctx, ellipse({ arcSweep: 90, arcRatio: 0.25 }));
    expect(names(piece.calls)).toEqual(['ellipse', 'ellipse', 'closePath']);
    // The inner edge is a quarter of the size and runs back the other way.
    expect(piece.calls[1]).toEqual(['ellipse', 100, 100, 25, 25, 0, Math.PI / 2, 0, true]);

    const ring = recorder();
    traceLayerPath(ring.ctx, ellipse({ arcRatio: 0.5 }));
    // Two outlines; the pen is lifted between them so that no line joins them.
    expect(names(ring.calls)).toEqual(['ellipse', 'closePath', 'moveTo', 'ellipse', 'closePath']);
    expect(ring.calls[2]).toEqual(['moveTo', 150, 100]);
  });

  it('flattens to a vector of the same shape, and takes part in boolean operations', () => {
    const { doc, pageId } = setup();
    const pie = addLayer(doc, 'ELLIPSE', pageId, { x: 0, y: 0, width: 200, height: 200, arcSweep: 270 });
    const flat = flattenNodes(pie.doc, [pie.id]) as { doc: Document; id: NodeId };
    const vector = flat.doc.nodes[flat.id] as VectorNode;
    expect(vector.type).toBe('VECTOR');
    expect('arcSweep' in vector).toBe(false);
    expect(Math.abs(area(vector.network) - Math.PI * 7500)).toBeLessThan(8);
    expect(validateDocument(flat.doc)).toEqual([]);

    // A ring minus a square over its right half: what is left is the left half of the ring.
    const ring = addLayer(doc, 'ELLIPSE', pageId, { x: 0, y: 0, width: 200, height: 200, arcRatio: 0.5 });
    const cutter = addLayer(ring.doc, 'RECTANGLE', pageId, { x: 100, y: -10, width: 120, height: 220 });
    const out = booleanNodes(cutter.doc, [ring.id, cutter.id], 'SUBTRACT') as { doc: Document; id: NodeId };
    const half = out.doc.nodes[out.id] as VectorNode;
    expect(half).toMatchObject({ x: 0, y: 0, width: 100, height: 200 });
    expect(Math.abs(area(half.network) - (Math.PI * 7500) / 2)).toBeLessThan(6);
  });

  it('keeps arc values in range', () => {
    const { doc, pageId } = setup();
    const made = addLayer(doc, 'ELLIPSE', pageId, { arcStart: 45, arcSweep: 200, arcRatio: 0.3 });
    expect(validateDocument(made.doc)).toEqual([]);
    const data = JSON.parse(JSON.stringify(made.doc)) as { nodes: Record<string, Record<string, unknown>> };
    Object.assign(data.nodes[made.id] as Record<string, unknown>, { arcStart: 'north', arcSweep: 0, arcRatio: 4 });
    expect(repairDocument(data).doc.nodes[made.id]).toMatchObject({ arcStart: 0, arcSweep: 1, arcRatio: 0.99 });
    Object.assign(data.nodes[made.id] as Record<string, unknown>, { arcStart: 720, arcSweep: 500, arcRatio: -1 });
    expect(repairDocument(data).doc.nodes[made.id]).toMatchObject({ arcStart: 360, arcSweep: 360, arcRatio: 0 });
  });
});

describe('arrowheads', () => {
  const line = (props: Partial<LineNode> = {}): LineNode => createLayer('LINE', 'p', 'a0', { width: 100, height: 0, strokeWeight: 2, ...props }) as LineNode;
  const vector = (network: VectorNetwork, props: Partial<VectorNode> = {}): VectorNode =>
    fitVectorNode(createLayer('VECTOR', 'p', 'a0', { strokeWeight: 2, ...props, network }) as VectorNode);

  it('finds the loose ends of lines and open paths, and which way they point', () => {
    expect(pathEnds(line())).toEqual([
      { at: 'start', point: { x: 0, y: 0 }, direction: { x: -1, y: 0 } },
      { at: 'end', point: { x: 100, y: 0 }, direction: { x: 1, y: 0 } },
    ]);
    const elbow = vector(new NetworkBuilder().moveTo(0, 0).lineTo(100, 0).lineTo(100, 100).build());
    expect(pathEnds(elbow)).toEqual([
      { at: 'start', point: { x: 0, y: 0 }, direction: { x: -1, y: 0 } },
      { at: 'end', point: { x: 100, y: 100 }, direction: { x: 0, y: 1 } },
    ]);
    // A curve ends in the direction it is travelling.
    const curve = vector(new NetworkBuilder().moveTo(0, 100).curveTo(0, 0, 100, 0, 100, 100).build());
    const ends = pathEnds(curve);
    expect(ends[0]?.direction.x).toBeCloseTo(0, 9);
    expect(ends[0]?.direction.y).toBeCloseTo(1, 9);
    expect(ends[1]?.direction.y).toBeCloseTo(1, 9);
    // A closed path has none, and a branch point is not an end.
    expect(pathEnds(vector(new NetworkBuilder().moveTo(0, 0).lineTo(50, 0).lineTo(25, 40).close().build()))).toEqual([]);
    const tee = new NetworkBuilder().moveTo(0, 0).lineTo(50, 0).lineTo(100, 0).build();
    const withStem = vector({ vertices: [...tee.vertices, { x: 50, y: 80 }], segments: [...tee.segments, { start: 1, end: 3, tangentStart: { x: 0, y: 0 }, tangentEnd: { x: 0, y: 0 } }] });
    expect(pathEnds(withStem).map((end) => [end.point.x, end.point.y]).sort()).toEqual(
      [
        [0, 0],
        [100, 0],
        [50, 80],
      ].sort(),
    );
  });

  it('shapes each kind of head from the end and the stroke weight', () => {
    const end: PathEnd = { at: 'end', point: { x: 100, y: 0 }, direction: { x: 1, y: 0 } };
    expect(arrowShape('NONE', end, 2)).toBeNull();
    // A triangle with its tip on the end point; the stroke stops short inside it.
    expect(arrowShape('TRIANGLE', end, 2)).toMatchObject({
      points: [
        { x: 100, y: 0 },
        { x: 90, y: -5 },
        { x: 90, y: 5 },
      ],
      filled: true,
      trim: 7.5,
    });
    // An open arrow: two strokes back from the tip.
    const open = arrowShape('LINE', end, 2);
    expect(open?.filled).toBe(false);
    expect(open?.trim).toBe(0);
    expect(open?.points[1]).toEqual({ x: 100, y: 0 });
    expect(open?.points[0]?.x).toBe(89);
    expect(open?.points[0]?.y).toBeCloseTo(-(open?.points[2]?.y ?? 0), 9);
    // A dot and a diamond sit on the end point.
    expect(arrowShape('CIRCLE', end, 2)).toMatchObject({ circle: { center: { x: 100, y: 0 }, radius: 5 }, points: [] });
    expect(arrowShape('DIAMOND', end, 2)?.points).toEqual([
      { x: 106.5, y: 0 },
      { x: 100, y: 6.5 },
      { x: 93.5, y: 0 },
      { x: 100, y: -6.5 },
    ]);
    // Heads grow with the stroke.
    expect(arrowShape('TRIANGLE', end, 10)?.points[1]).toEqual({ x: 70, y: -15 });
    // Pointing down.
    expect(arrowShape('TRIANGLE', { at: 'end', point: { x: 0, y: 0 }, direction: { x: 0, y: 1 } }, 2)?.points[1]).toEqual({ x: 5, y: -10 });
  });

  it('cuts a length off either end of a curve', () => {
    const straight: Cubic = { p0: { x: 0, y: 0 }, p1: { x: 0, y: 0 }, p2: { x: 100, y: 0 }, p3: { x: 100, y: 0 } };
    expect(cubicAt(straight, parameterAtDistance(straight, 25)).x).toBeCloseTo(25, 0);
    expect(parameterAtDistance(straight, 0)).toBe(0);
    expect(parameterAtDistance(straight, 500)).toBe(1);
    const shorter = trimEnd(straight, 10);
    expect(shorter.p0).toEqual({ x: 0, y: 0 });
    expect(shorter.p3.x).toBeCloseTo(90, 0);
    expect(trimStart(straight, 10).p0.x).toBeCloseTo(10, 0);
    expect(trimStart(straight, 10).p3).toEqual({ x: 100, y: 0 });
    // However much is asked for, something is left.
    expect(trimEnd(straight, 1000).p3.x).toBeGreaterThan(0);
  });

  it('draws the head with the stroke, and stops the stroke short of a triangle’s tip', () => {
    const plain = recorder();
    traceStrokePath(plain.ctx, line());
    expect(plain.calls).toEqual([
      ['moveTo', 0, 0],
      ['lineTo', 100, 0],
    ]);
    expect(arrowHeads(line())).toEqual([]);

    const pointed = line({ endArrow: 'TRIANGLE' });
    const trimmed = recorder();
    traceStrokePath(trimmed.ctx, pointed);
    expect(trimmed.calls).toEqual([
      ['moveTo', 0, 0],
      ['lineTo', 92.5, 0],
    ]);
    expect(arrowHeads(pointed)).toHaveLength(1);
    // The outline used for selecting and hovering is the whole line.
    const outline = recorder();
    traceLayerPath(outline.ctx, pointed, 0, 'stroke');
    expect(outline.calls.at(-1)).toEqual(['lineTo', 100, 0]);

    const { doc, pageId } = setup();
    const view = { size: { width: 800, height: 600 }, dpr: 1, viewport: { x: 0, y: 0, zoom: 1 } };
    const made = addLayer(doc, 'LINE', pageId, { x: 100, y: 100, width: 200, strokeWeight: 2, dashPattern: [4, 4], startArrow: 'LINE', endArrow: 'TRIANGLE' });
    const scene = recorder();
    renderScene(scene.ctx, made.doc, pageId, view);
    // The shaft, the open arrow at the start, the filled triangle at the end.
    expect(names(scene.calls).filter((name) => name === 'stroke')).toHaveLength(2);
    expect(names(scene.calls).filter((name) => name === 'fill')).toHaveLength(1);
    // The heads are solid even though the stroke is dashed.
    const order = scene.calls.filter((call) => call[0] === 'setLineDash' || call[0] === 'stroke' || call[0] === 'fill').map((call) => (call[0] === 'setLineDash' ? `dash:${(call[1] as number[]).length}` : call[0]));
    expect(order.slice(0, 5)).toEqual(['dash:2', 'stroke', 'dash:0', 'stroke', 'fill']);
    // What the layer covers includes its heads.
    const bare = patchNode(made.doc, made.id, { startArrow: 'NONE', endArrow: 'NONE' });
    expect(getRenderBounds(made.doc, made.id).width).toBeGreaterThan(getRenderBounds(bare, made.id).width + 10);
  });

  it('puts heads on the loose ends of a vector, and none on a closed one', () => {
    const open = vector(new NetworkBuilder().moveTo(0, 100).curveTo(0, 0, 100, 0, 100, 100).build(), { startArrow: 'CIRCLE', endArrow: 'TRIANGLE' });
    const heads = arrowHeads(open);
    expect(heads).toHaveLength(2);
    expect(heads[0]?.circle?.center).toEqual({ x: 0, y: 75 });
    expect(heads[1]?.points[0]).toEqual({ x: 100, y: 75 });
    const traced = recorder();
    traceStrokePath(traced.ctx, open);
    // The curve is drawn up to where the triangle begins: 7.5 short of its end, measured along it.
    const last = traced.calls.at(-1) as [string, ...number[]];
    expect(last[0]).toBe('bezierCurveTo');
    expect(last[5]).toBeCloseTo(100, 0);
    expect(last[6] as number).toBeGreaterThan(60);
    expect(last[6] as number).toBeLessThan(72);

    const closed = vector(new NetworkBuilder().moveTo(0, 0).lineTo(50, 0).lineTo(25, 40).close().build(), { startArrow: 'TRIANGLE', endArrow: 'TRIANGLE' });
    expect(arrowHeads(closed)).toEqual([]);
  });

  it('keeps its arrowheads when a line is flattened, and refuses unknown kinds', () => {
    const { doc, pageId } = setup();
    const made = addLayer(doc, 'LINE', pageId, { x: 10, y: 10, width: 120, startArrow: 'DIAMOND', endArrow: 'LINE' });
    const flat = flattenNodes(made.doc, [made.id]) as { doc: Document; id: NodeId };
    expect(flat.doc.nodes[flat.id]).toMatchObject({ type: 'VECTOR', startArrow: 'DIAMOND', endArrow: 'LINE' });
    expect(validateDocument(flat.doc)).toEqual([]);

    const data = JSON.parse(JSON.stringify(made.doc)) as { nodes: Record<string, Record<string, unknown>> };
    Object.assign(data.nodes[made.id] as Record<string, unknown>, { startArrow: 'HARPOON', endArrow: 7 });
    expect(repairDocument(data).doc.nodes[made.id]).toMatchObject({ startArrow: 'NONE', endArrow: 'NONE' });
  });
});

describe('the file format', () => {
  it('opens a version 8 file: whole ellipses and no arrowheads', () => {
    const { doc, pageId } = setup();
    const dot = addLayer(doc, 'ELLIPSE', pageId, { x: 10, y: 10 });
    const rule = addLayer(dot.doc, 'LINE', pageId, { x: 10, y: 200, width: 150 });
    const path = createLayer('VECTOR', pageId, freshKeys(3)[2] as string, { network: new NetworkBuilder().moveTo(0, 0).lineTo(40, 30).build() }) as VectorNode;
    const current = setNodes(rule.doc, { [path.id]: fitVectorNode(path) });

    const v8 = JSON.parse(JSON.stringify(current)) as { nodes: Record<string, Record<string, unknown>> };
    for (const id of [dot.id, rule.id, path.id]) {
      for (const key of ['arcStart', 'arcSweep', 'arcRatio', 'startArrow', 'endArrow']) delete (v8.nodes[id] as Record<string, unknown>)[key];
    }
    const parsed = parseFile({
      format: 'open-design',
      schemaVersion: 8,
      meta: { createdAt: '2026-11-16T12:00:00.000Z', updatedAt: '2026-11-16T12:00:00.000Z' },
      document: v8,
    });
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(9);
    expect(parsed.file.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(parsed.repairs).toEqual([]);
    expect(parsed.file.document).toEqual(current);
    // A layer that already says what it is keeps it.
    const kept = JSON.parse(JSON.stringify(current)) as { nodes: Record<string, Record<string, unknown>> };
    (kept.nodes[dot.id] as Record<string, unknown>).arcSweep = 120;
    const again = parseFile({ format: 'open-design', schemaVersion: 8, meta: {}, document: kept });
    expect(again.file.document.nodes[dot.id]).toMatchObject({ arcSweep: 120 });
  });
});

describe('arc handles on the canvas', () => {
  const ptr = (x: number, y: number, shiftKey = false): PointerInput => ({ x, y, button: 0, shiftKey, altKey: false, ctrlKey: false, detail: 1 });

  /** An editor with one selected circle of radius 100 about (200, 200). Canvas pixels are page units. */
  function editor(props: Partial<EllipseNode> = {}): { store: EditorStore; controller: InteractionController; id: NodeId } {
    const { doc, pageId } = setup();
    const made = addLayer(doc, 'ELLIPSE', pageId, { x: 100, y: 100, width: 200, height: 200, ...props });
    const store = createEditorStore(made.doc);
    store.getState().setCanvasSize({ width: 800, height: 600 });
    store.getState().setSelection([made.id]);
    const controller = new InteractionController(store, { requestRender: () => undefined, setCursor: () => undefined });
    return { store, controller, id: made.id };
  }

  const drag = (controller: InteractionController, from: [number, number], to: [number, number], shift = false): void => {
    controller.pointerDown(ptr(from[0], from[1], shift));
    controller.pointerMove(ptr((from[0] + to[0]) / 2, (from[1] + to[1]) / 2, shift));
    controller.pointerMove(ptr(to[0], to[1], shift));
    controller.pointerUp(ptr(to[0], to[1], shift));
  };

  const shown = (store: EditorStore): [string, number, number][] =>
    (arcHandles(store.getState().doc, store.getState().selection, store.getState().viewport)?.points ?? []).map((p) => [p.handle, Math.round(p.screen.x), Math.round(p.screen.y)]);

  const arcOf = (store: EditorStore, id: NodeId): EllipseNode => store.getState().doc.nodes[id] as EllipseNode;

  it('shows one handle on a whole ellipse, and three on an arc', () => {
    // Three quarters of the way out, at three o'clock.
    expect(shown(editor().store)).toEqual([['end', 275, 200]]);
    expect(shown(editor({ arcSweep: 90 }).store)).toEqual([
      ['start', 275, 200],
      ['end', 200, 275],
      ['ratio', 200, 200],
    ]);
    // On a ring the hole's handle is on the hole's edge, opposite where the ring starts.
    expect(shown(editor({ arcRatio: 0.5 }).store)).toEqual([
      ['end', 275, 200],
      ['ratio', 150, 200],
    ]);
    // None when there is no room for them, when the ellipse is locked, or when more is selected.
    expect(shown(editor({ width: 30, height: 30 }).store)).toEqual([]);
    expect(shown(editor({ locked: true }).store)).toEqual([]);
    const two = editor();
    const other = addLayer(two.store.getState().doc, 'ELLIPSE', two.store.getState().pageId, { x: 400, y: 100 });
    two.store.getState().apply('Add', () => other.doc);
    two.store.getState().setSelection([two.id, other.id]);
    expect(shown(two.store)).toEqual([]);
  });

  it('sweeps the arc when its end is dragged', () => {
    const { store, controller, id } = editor();
    drag(controller, [275, 200], [200, 275]);
    expect(arcOf(store, id)).toMatchObject({ arcStart: 0, arcSweep: 90, arcRatio: 0 });
    expect(store.getState().undoStack.map((entry) => entry.label)).toEqual(['Change arc']);
    // The handle is where the arc now ends; on to nine o'clock.
    drag(controller, [200, 275], [120, 200]);
    expect(arcOf(store, id).arcSweep).toBe(180);
    // With Shift, in steps of 15 degrees.
    drag(controller, [125, 200], [140, 150], true);
    expect(arcOf(store, id).arcSweep).toBe(225);
    store.getState().undo();
    store.getState().undo();
    store.getState().undo();
    expect(arcOf(store, id)).toMatchObject({ arcSweep: 360 });
  });

  it('moves the start of the arc and leaves its end where it is', () => {
    const { store, controller, id } = editor({ arcSweep: 180 });
    // From three o'clock to twelve.
    drag(controller, [275, 200], [200, 125]);
    expect(arcOf(store, id)).toMatchObject({ arcStart: 270, arcSweep: 270 });
  });

  it('opens a hole when the middle handle is dragged out', () => {
    const { store, controller, id } = editor({ arcSweep: 180 });
    drag(controller, [200, 200], [200, 250]);
    expect(arcOf(store, id)).toMatchObject({ arcRatio: 0.5, arcSweep: 180 });
    // The handle is now on the hole's edge, half-way round the arc: straight down.
    expect(shown(store)).toContainEqual(['ratio', 200, 250]);
    drag(controller, [200, 250], [200, 198]);
    expect(arcOf(store, id).arcRatio).toBe(0.02);
  });

  it('leaves a whole ellipse free to be dragged by its middle, and gives up a drag that is cancelled', () => {
    const { store, controller, id } = editor();
    drag(controller, [200, 200], [230, 240]);
    expect(arcOf(store, id)).toMatchObject({ x: 130, y: 140, arcSweep: 360, arcRatio: 0 });

    controller.pointerDown(ptr(305, 240));
    controller.pointerMove(ptr(230, 315));
    expect(arcOf(store, id).arcSweep).toBe(90);
    expect(controller.cancel()).toBe(true);
    expect(arcOf(store, id).arcSweep).toBe(360);
    expect(store.getState().undoStack.map((entry) => entry.label)).toEqual(['Move']);
  });
});
