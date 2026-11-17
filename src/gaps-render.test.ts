import { describe, expect, it } from 'vitest';
import {
  addLayer,
  createDocument,
  createLayer,
  dropShadow,
  getPages,
  gradientPaint,
  groupNodes,
  patchNode,
  setNodes,
  solidPaint,
  type Document,
  type GradientType,
  type LayerNode,
  type NodeId,
  type ShadowEffect,
  type VectorNetwork,
  type VectorNode,
} from './core';
import { freshKeys } from './core/order';
import { fillStretchedGradient, traceLayerPath, traceStrokePath } from './engine/render/paint';
import { getRenderBounds, renderScene } from './engine/render/scene';

const RED = { r: 1, g: 0, b: 0 };
const BLUE = { r: 0, g: 0, b: 1 };

function setup(): { doc: Document; pageId: NodeId } {
  const doc = createDocument('Render gaps');
  return { doc, pageId: (getPages(doc)[0] as { id: NodeId }).id };
}

/** One call made on a canvas context, with the state that matters at the time it was made. */
interface Call {
  canvas: number;
  name: string;
  args: unknown[];
  op: string;
  fillStyle: unknown;
  strokeStyle: unknown;
  lineWidth: unknown;
  shadowBlur: unknown;
}

/** A gradient stub that remembers how it was made. */
interface GradientStub {
  kind: string;
  args: unknown[];
  stops: number;
}

/**
 * Canvas contexts that accept every call and record them all, in one list,
 * each marked with the canvas it was made on: 0 for the canvas being painted,
 * 1 and up for scratch canvases in the order they were made. Like real
 * canvases, a scratch canvas always hands out the same context.
 */
function harness(): { ctx: CanvasRenderingContext2D; calls: Call[]; gradients: (GradientStub & { canvas: number })[]; createCanvas: () => HTMLCanvasElement; scratchCount: () => number } {
  const calls: Call[] = [];
  const gradients: (GradientStub & { canvas: number })[] = [];
  const canvases: HTMLCanvasElement[] = [];
  const make = (index: number): CanvasRenderingContext2D => {
    const state: Record<string, unknown> = { globalAlpha: 1, globalCompositeOperation: 'source-over', filter: 'none' };
    const proxy = new Proxy(state, {
      get(obj, prop: string) {
        if (prop in obj) return obj[prop];
        if (prop === 'canvas') return canvases[index - 1] ?? { index: 0 };
        return (...args: unknown[]) => {
          calls.push({
            canvas: index,
            name: prop,
            args,
            op: String(obj.globalCompositeOperation),
            fillStyle: obj.fillStyle,
            strokeStyle: obj.strokeStyle,
            lineWidth: obj.lineWidth,
            shadowBlur: obj.shadowBlur,
          });
          if (/^create.*Gradient$/.test(prop)) {
            const stub = { kind: prop, args, stops: 0, canvas: index, addColorStop: () => void stub.stops++ };
            gradients.push(stub);
            return stub;
          }
          return undefined;
        };
      },
      set(obj, prop: string, value) {
        obj[prop] = value;
        return true;
      },
    });
    return proxy as unknown as CanvasRenderingContext2D;
  };
  return {
    ctx: make(0),
    calls,
    gradients,
    createCanvas: () => {
      const index = canvases.length + 1;
      const ctx = make(index);
      const canvas = { index, getContext: () => ctx } as unknown as HTMLCanvasElement;
      canvases.push(canvas);
      return canvas;
    },
    scratchCount: () => canvases.length,
  };
}

const view = { size: { width: 800, height: 600 }, dpr: 1, viewport: { x: 0, y: 0, zoom: 1 } };

function paint(doc: Document, pageId: NodeId, withScratch = true): ReturnType<typeof harness> & { stats: ReturnType<typeof renderScene> } {
  const h = harness();
  const stats = renderScene(h.ctx, doc, pageId, withScratch ? { ...view, createCanvas: h.createCanvas } : view);
  return { ...h, stats };
}

const named = (calls: readonly Call[], name: string, canvas?: number): Call[] => calls.filter((call) => call.name === name && (canvas === undefined || call.canvas === canvas));

/** A vector layer with the given network, sized to it. */
function addVector(doc: Document, pageId: NodeId, network: VectorNetwork, props: Partial<VectorNode> = {}): { doc: Document; id: NodeId } {
  const node = createLayer('VECTOR', pageId, freshKeys(1)[0] as string, { x: 50, y: 50, width: 100, height: 100, ...props, network }) as VectorNode;
  return { doc: setNodes(doc, { [node.id]: node }), id: node.id };
}

/** Straight segments from one middle point out to each of the given points. */
function star(center: { x: number; y: number }, ends: { x: number; y: number }[]): VectorNetwork {
  const zero = { x: 0, y: 0 };
  return {
    vertices: [center, ...ends],
    segments: ends.map((_, i) => ({ start: 0, end: i + 1, tangentStart: zero, tangentEnd: zero })),
  };
}

const innerShadow = (props: Partial<ShadowEffect> = {}): ShadowEffect => ({ ...dropShadow(), type: 'INNER_SHADOW', ...props });

describe('radial, angular and diamond gradients on text and strokes', () => {
  const kinds: GradientType[] = ['GRADIENT_RADIAL', 'GRADIENT_ANGULAR', 'GRADIENT_DIAMOND'];

  it('are painted over the glyphs stretched to the box, as they are on a fill', () => {
    for (const kind of kinds) {
      const { doc, pageId } = setup();
      const text = addLayer(doc, 'TEXT', pageId, { x: 20, y: 20, characters: 'Gradient', fontSize: 20, fills: [gradientPaint(kind, RED, BLUE)] });
      const { calls, gradients } = paint(text.doc, pageId);
      const node = text.doc.nodes[text.id] as LayerNode;
      // The glyphs are drawn on a scratch canvas as a mask…
      const mask = named(calls, 'fillText').filter((call) => call.canvas > 0);
      expect(mask.length, kind).toBeGreaterThan(0);
      const scratch = (mask[0] as Call).canvas;
      // …the gradient is laid out in the box's unit square and kept only where the mask is…
      const stretch = named(calls, 'transform', scratch).find((call) => call.args[0] === node.width && call.args[3] === node.height);
      expect(stretch, kind).toBeDefined();
      const painted = named(calls, 'fillRect', scratch).filter((call) => call.op === 'source-in');
      expect(painted.length, kind).toBeGreaterThan(0);
      // …and the result is placed on the canvas.
      expect(named(calls, 'drawImage', 0).length, kind).toBe(1);
      // Nothing round is made in pixels, where it would be a circle.
      expect(gradients.filter((g) => g.canvas === 0), kind).toEqual([]);
      if (kind === 'GRADIENT_RADIAL') {
        const radial = gradients.find((g) => g.kind === 'createRadialGradient');
        // The radius is half the box, in the box's own units.
        expect(radial?.args).toEqual([0.5, 0.5, 0, 0.5, 0.5, 0.5]);
      }
    }
  });

  it('draw a diamond as four linear quadrants, not as a radial gradient', () => {
    const { doc, pageId } = setup();
    const rect = addLayer(doc, 'RECTANGLE', pageId, { x: 20, y: 20, width: 200, height: 50, fills: [], strokes: [gradientPaint('GRADIENT_DIAMOND', RED, BLUE)], strokeWeight: 4 });
    const { calls, gradients } = paint(rect.doc, pageId);
    expect(gradients.filter((g) => g.kind === 'createRadialGradient')).toEqual([]);
    expect(gradients.filter((g) => g.kind === 'createLinearGradient')).toHaveLength(4);
    // The stroke is the mask, drawn in black on the scratch canvas: an inside stroke twice as wide, clipped to the outline.
    const strokes = named(calls, 'stroke').filter((call) => call.canvas > 0);
    expect(strokes).toHaveLength(1);
    expect(strokes[0]?.strokeStyle).toBe('#000');
    expect(strokes[0]?.lineWidth).toBe(8);
    expect(named(calls, 'clip', strokes[0]?.canvas).length).toBeGreaterThan(0);
    // The 200 × 50 box stretches the diamond.
    expect(named(calls, 'transform').some((call) => call.args[0] === 200 && call.args[3] === 50)).toBe(true);
  });

  it('paint each quadrant of a diamond only within its own clip, so that "source-in" keeps the others', () => {
    const h = harness();
    fillStretchedGradient(h.ctx, gradientPaint('GRADIENT_DIAMOND', RED, BLUE), 100, 40, 30);
    const relevant = h.calls.filter((call) => ['rect', 'clip', 'fillRect'].includes(call.name));
    // The margin, then four times: a quadrant, clipped to, and filled exactly.
    expect(relevant[0]?.name).toBe('rect');
    expect(relevant[1]?.name).toBe('clip');
    const quadrants = relevant.slice(2);
    expect(quadrants).toHaveLength(12);
    for (let i = 0; i < 12; i += 3) {
      expect(quadrants.slice(i, i + 3).map((call) => call.name)).toEqual(['rect', 'clip', 'fillRect']);
      expect(quadrants[i + 2]?.args).toEqual(quadrants[i]?.args);
    }
  });

  it('keep a gradient on a vector stroke, an inside stroke and arrowheads within the mask', () => {
    const { doc, pageId } = setup();
    const made = addVector(doc, pageId, star({ x: 50, y: 50 }, [{ x: 100, y: 50 }, { x: 50, y: 0 }]), {
      strokes: [gradientPaint('GRADIENT_ANGULAR', RED, BLUE)],
      strokeWeight: 3,
      endArrow: 'TRIANGLE',
    });
    const { calls, gradients } = paint(made.doc, pageId);
    expect(gradients.filter((g) => g.canvas === 0)).toEqual([]);
    // The stroke and the filled arrowhead both go into the mask.
    expect(named(calls, 'stroke').filter((call) => call.canvas > 0).length).toBeGreaterThan(0);
    expect(named(calls, 'fill').filter((call) => call.canvas > 0 && call.fillStyle === '#000').length).toBe(1);
  });

  it('fall back to the gradient in pixels where there is no scratch canvas', () => {
    const { doc, pageId } = setup();
    const text = addLayer(doc, 'TEXT', pageId, { x: 20, y: 20, characters: 'Gradient', fills: [gradientPaint('GRADIENT_RADIAL', RED, BLUE)] });
    const { calls, gradients } = paint(text.doc, pageId, false);
    expect(gradients.map((g) => g.kind)).toEqual(['createRadialGradient']);
    expect(named(calls, 'fillText', 0).length).toBeGreaterThan(0);
  });

  it('leave solid and linear paints on text and strokes as they were: drawn directly', () => {
    const { doc, pageId } = setup();
    const text = addLayer(doc, 'TEXT', pageId, { x: 20, y: 20, characters: 'Plain', fills: [gradientPaint('GRADIENT_LINEAR', RED, BLUE)], strokes: [solidPaint(RED)], strokeWeight: 1 });
    const h = paint(text.doc, pageId);
    expect(h.scratchCount()).toBe(0);
    expect(named(h.calls, 'fillText', 0).length).toBeGreaterThan(0);
    expect(named(h.calls, 'strokeText', 0).length).toBeGreaterThan(0);
  });
});

describe('inner shadows on text and groups', () => {
  it('fall inside the glyphs of a text', () => {
    const { doc, pageId } = setup();
    const text = addLayer(doc, 'TEXT', pageId, { x: 20, y: 20, characters: 'Shadow', fontSize: 24, effects: [innerShadow({ blur: 6, offsetY: 3 })] });
    const { calls } = paint(text.doc, pageId);
    // The glyphs are drawn once on the canvas, and once on a scratch canvas as the outline.
    expect(named(calls, 'fillText', 0).length).toBeGreaterThan(0);
    const outline = named(calls, 'fillText').find((call) => call.canvas > 0) as Call;
    expect(outline).toBeDefined();
    // The shadow canvas: filled with the shadow's colour, less the blurred shadow of the glyphs, kept within the glyphs.
    const colour = named(calls, 'fillRect').find((call) => call.canvas > 0 && call.fillStyle === 'rgba(0, 0, 0, 0.25)') as Call;
    expect(colour).toBeDefined();
    const shadowCanvas = colour.canvas;
    const draws = named(calls, 'drawImage', shadowCanvas);
    expect(draws.map((call) => call.op)).toEqual(['destination-out', 'destination-in']);
    expect(draws[0]?.shadowBlur).toBe(6);
    // Both take the glyphs' outline.
    expect(draws.every((call) => (call.args[0] as { index: number }).index === outline.canvas)).toBe(true);
    // The result is placed on the canvas after the glyphs are filled.
    const placed = named(calls, 'drawImage', 0);
    expect(placed).toHaveLength(1);
    expect(calls.indexOf(placed[0] as Call)).toBeGreaterThan(calls.indexOf(named(calls, 'fillText', 0)[0] as Call));
  });

  it('fall inside what the children of a group paint, over them, without counting them twice', () => {
    const { doc, pageId } = setup();
    const a = addLayer(doc, 'RECTANGLE', pageId, { x: 10, y: 10, width: 50, height: 50 });
    const b = addLayer(a.doc, 'ELLIPSE', pageId, { x: 40, y: 40, width: 50, height: 50 });
    const grouped = groupNodes(b.doc, [a.id, b.id]);
    if (!grouped) throw new Error('The rectangle and the ellipse should group.');
    const plain = paint(grouped.doc, pageId);
    const shadowed = paint(patchNode(grouped.doc, grouped.id, { effects: [innerShadow()] }), pageId);
    expect(shadowed.stats).toEqual(plain.stats);
    // The children are painted on the canvas, and again on a scratch canvas to find where they are.
    expect(named(shadowed.calls, 'fill', 0)).toHaveLength(2);
    const outlineFills = named(shadowed.calls, 'fill').filter((call) => call.canvas > 0);
    expect(outlineFills).toHaveLength(2);
    const placed = named(shadowed.calls, 'drawImage', 0);
    expect(placed).toHaveLength(1);
    expect(shadowed.calls.indexOf(placed[0] as Call)).toBeGreaterThan(shadowed.calls.indexOf(named(shadowed.calls, 'fill', 0)[1] as Call));
    // Before, a group's inner shadow drew nothing.
    expect(named(plain.calls, 'drawImage')).toEqual([]);
  });

  it('draw nothing, and break nothing, where there is no scratch canvas', () => {
    const { doc, pageId } = setup();
    const text = addLayer(doc, 'TEXT', pageId, { x: 20, y: 20, characters: 'Shadow', effects: [innerShadow()] });
    const { calls } = paint(text.doc, pageId, false);
    expect(named(calls, 'drawImage')).toEqual([]);
    expect(named(calls, 'fillText', 0).length).toBeGreaterThan(0);
  });
});

describe('shadow spread on outlines other than boxes', () => {
  const outlines = (doc: Document, pageId: NodeId): [string, { doc: Document; id: NodeId }][] => [
    ['star', addLayer(doc, 'STAR', pageId, { x: 100, y: 100, width: 80, height: 80 })],
    ['polygon', addLayer(doc, 'POLYGON', pageId, { x: 100, y: 100, width: 80, height: 80 })],
    ['slice', addLayer(doc, 'ELLIPSE', pageId, { x: 100, y: 100, width: 80, height: 80, arcStart: 0, arcSweep: 90, arcRatio: 0 })],
    ['ring', addLayer(doc, 'ELLIPSE', pageId, { x: 100, y: 100, width: 80, height: 80, arcStart: 0, arcSweep: 360, arcRatio: 0.5 })],
    ['vector', addVector(doc, pageId, { vertices: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 80 }], segments: [0, 1, 2].map((i) => ({ start: i, end: (i + 1) % 3, tangentStart: { x: 0, y: 0 }, tangentEnd: { x: 0, y: 0 } })) }, { fills: [solidPaint(RED)] })],
  ];

  it('grows the outline that casts a drop shadow by stroking it twice the spread wide', () => {
    const { doc, pageId } = setup();
    for (const [name, made] of outlines(doc, pageId)) {
      const spread = patchNode(made.doc, made.id, { effects: [{ ...dropShadow(), spread: 6 }] });
      const { calls } = paint(spread, pageId);
      // The silhouette: the fill and a stroke 12 wide round it, both added.
      const grow = named(calls, 'stroke').filter((call) => call.canvas > 0);
      expect(grow, name).toHaveLength(1);
      expect(grow[0]?.lineWidth, name).toBe(12);
      expect(grow[0]?.op, name).toBe('source-over');
      // The silhouette casts the shadow: drawn far off the canvas, with the shadow brought back onto it.
      const cast = named(calls, 'drawImage', 0);
      expect(cast, name).toHaveLength(1);
      expect(cast[0]?.shadowBlur, name).toBe(8);
      expect(cast[0]?.args[5] as number, name).toBeLessThan(-1000);
    }
  });

  it('shrinks it for a negative spread, by taking the stroke away', () => {
    const { doc, pageId } = setup();
    const [, made] = outlines(doc, pageId)[0] as [string, { doc: Document; id: NodeId }];
    const shrunk = patchNode(made.doc, made.id, { effects: [{ ...dropShadow(), spread: -3 }] });
    const grow = named(paint(shrunk, pageId).calls, 'stroke').filter((call) => call.canvas > 0);
    expect(grow).toHaveLength(1);
    expect(grow[0]?.lineWidth).toBe(6);
    expect(grow[0]?.op).toBe('destination-out');
  });

  it('shrinks the hole an inner shadow leaves on these outlines', () => {
    const { doc, pageId } = setup();
    for (const [name, made] of outlines(doc, pageId)) {
      const spread = patchNode(made.doc, made.id, { effects: [innerShadow({ spread: 5 })] });
      const { calls } = paint(spread, pageId);
      const shrink = named(calls, 'stroke').filter((call) => call.canvas > 0);
      expect(shrink, name).toHaveLength(1);
      expect(shrink[0]?.lineWidth, name).toBe(10);
      expect(shrink[0]?.op, name).toBe('destination-out');
      // The shadow is kept within the layer's own outline and placed on the canvas.
      const shadowCanvas = named(calls, 'fill').find((call) => call.canvas > 0 && call.op === 'destination-in');
      expect(shadowCanvas, name).toBeDefined();
      expect(named(calls, 'drawImage', 0), name).toHaveLength(1);
    }
  });

  it('spreads a text’s drop shadow too', () => {
    const { doc, pageId } = setup();
    const text = addLayer(doc, 'TEXT', pageId, { x: 20, y: 20, characters: 'Spread', effects: [{ ...dropShadow(), spread: 2 }] });
    const { calls } = paint(text.doc, pageId);
    const grow = named(calls, 'strokeText').filter((call) => call.canvas > 0);
    expect(grow.length).toBeGreaterThan(0);
    expect(grow[0]?.lineWidth).toBe(4);
    expect(named(calls, 'drawImage', 0)).toHaveLength(1);
  });

  it('still insets boxes and whole ellipses directly, with no scratch canvas', () => {
    const { doc, pageId } = setup();
    const rect = addLayer(doc, 'RECTANGLE', pageId, { x: 100, y: 100, effects: [{ ...dropShadow(), spread: 6 }, innerShadow({ spread: 4 })] });
    const ellipse = addLayer(rect.doc, 'ELLIPSE', pageId, { x: 300, y: 100, effects: [{ ...dropShadow(), spread: 6 }] });
    const h = paint(ellipse.doc, pageId);
    expect(h.scratchCount()).toBe(0);
    // The shadow is no wider than the spread it is given.
    expect(getRenderBounds(ellipse.doc, ellipse.id).width).toBe(100 + 2 * (4 + 8 + 6));
  });
});

describe('stroke joins where three or more segments meet', () => {
  function recorder(): { ctx: CanvasRenderingContext2D; calls: [string, ...number[]][] } {
    const calls: [string, ...number[]][] = [];
    const ctx = new Proxy({} as Record<string, unknown>, {
      get: (_obj, prop: string) => (...args: number[]) => void calls.push([prop, ...args]),
    });
    return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
  }

  it('adds a piece that turns from one segment to the next across the gap wider than a half turn', () => {
    const { doc, pageId } = setup();
    // Three segments leave (50, 50): right, down-right and down, all within a quarter turn.
    const made = addVector(doc, pageId, star({ x: 50, y: 50 }, [{ x: 100, y: 50 }, { x: 100, y: 100 }, { x: 50, y: 100 }]), { strokes: [solidPaint(RED)], strokeWeight: 6, strokeJoin: 'ROUND' });
    const node = made.doc.nodes[made.id] as VectorNode;
    const traced = recorder();
    traceLayerPath(traced.ctx, node, 0, 'stroke');
    // Three runs, then the join: from just along the downward segment, to the point, to just along the rightward one.
    const joinStart = traced.calls.length - 3;
    expect(traced.calls.slice(0, joinStart).filter((call) => call[0] === 'moveTo')).toHaveLength(3);
    const [move, corner, out] = traced.calls.slice(joinStart) as [string, number, number][];
    expect(move[0]).toBe('moveTo');
    expect(move[1]).toBeCloseTo(50, 5);
    expect(move[2]).toBeGreaterThan(50);
    expect(move[2]).toBeLessThan(50.1);
    expect(corner).toEqual(['lineTo', 50, 50]);
    expect(out[0]).toBe('lineTo');
    expect(out[1]).toBeGreaterThan(50);
    expect(out[2]).toBeCloseTo(50, 5);
    // It is part of the stroke's own path, painted with it in one go and with its join.
    const h = paint(made.doc, pageId);
    expect(named(h.calls, 'stroke', 0)).toHaveLength(1);
  });

  it('adds none where the segments leave a point evenly, or where only two meet', () => {
    const { doc, pageId } = setup();
    const even = addVector(doc, pageId, star({ x: 50, y: 50 }, [{ x: 100, y: 50 }, { x: 25, y: 93.3 }, { x: 25, y: 6.7 }]));
    const evenTraced = recorder();
    traceLayerPath(evenTraced.ctx, even.doc.nodes[even.id] as LayerNode, 0, 'stroke');
    expect(evenTraced.calls.filter((call) => call[0] === 'moveTo')).toHaveLength(3);

    // Two segments make one run through the point, which the canvas joins itself.
    const bend = addVector(doc, pageId, star({ x: 50, y: 50 }, [{ x: 100, y: 50 }, { x: 50, y: 100 }]));
    const bendTraced = recorder();
    traceLayerPath(bendTraced.ctx, bend.doc.nodes[bend.id] as LayerNode, 0, 'stroke');
    expect(bendTraced.calls.map((call) => call[0])).toEqual(['beginPath', 'moveTo', 'lineTo', 'lineTo']);
  });

  it('follows the handle of a curved segment, and is kept when the stroke is cut short for arrowheads', () => {
    const { doc, pageId } = setup();
    const network = star({ x: 50, y: 50 }, [{ x: 100, y: 50 }, { x: 100, y: 100 }, { x: 50, y: 100 }]);
    // The downward segment now leaves down-right, along its handle, before it bends down.
    network.segments[2] = { ...(network.segments[2] as VectorNetwork['segments'][number]), tangentStart: { x: 20, y: 20 } };
    const made = addVector(doc, pageId, network, { endArrow: 'TRIANGLE', strokes: [solidPaint(RED)], strokeWeight: 2 });
    const traced = recorder();
    traceStrokePath(traced.ctx, made.doc.nodes[made.id] as LayerNode);
    // Two segments now leave down-right together, so the widest gap runs from there round to the right.
    const [move, corner] = traced.calls.slice(-3) as [string, number, number][];
    expect(corner).toEqual(['lineTo', 50, 50]);
    expect(move[1] - 50).toBeCloseTo(move[2] - 50, 5);
    expect(move[1]).toBeGreaterThan(50);
  });
});
