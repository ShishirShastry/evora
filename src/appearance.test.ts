import { describe, expect, it } from 'vitest';
import {
  addLayer,
  createDocument,
  CURRENT_SCHEMA_VERSION,
  dropShadow,
  getPages,
  gradientAngle,
  gradientHandles,
  gradientPaint,
  hasVisiblePaint,
  paintColor,
  parseFile,
  patchNode,
  repairDocument,
  solidPaint,
  validateDocument,
  type Document,
  type GradientPaint,
  type LayerNode,
  type NodeId,
} from './core';
import { effectiveRadii } from './engine/render/paint';
import { getRenderBounds, renderScene } from './engine/render/scene';
import { convertEffect } from './ui/panels/EffectsSection';
import { convertPaint } from './ui/panels/PaintList';

const RED = { r: 1, g: 0, b: 0 };
const BLUE = { r: 0, g: 0, b: 1 };

function setup(): { doc: Document; pageId: NodeId } {
  const doc = createDocument('Appearance');
  return { doc, pageId: (getPages(doc)[0] as { id: NodeId }).id };
}

/** A deep, mutable copy so tests can damage the data. */
function raw(doc: Document): { nodes: Record<string, Record<string, unknown>> } {
  return JSON.parse(JSON.stringify(doc));
}

describe('gradients', () => {
  it('builds handles from an angle and reads the angle back', () => {
    expect(gradientHandles(0)).toEqual({ from: { x: 0, y: 0.5 }, to: { x: 1, y: 0.5 } });
    expect(gradientHandles(90)).toEqual({ from: { x: 0.5, y: 0 }, to: { x: 0.5, y: 1 } });
    for (const angle of [0, 45, 90, 135, 180, 270, 315]) expect(gradientAngle(gradientHandles(angle))).toBe(angle);
  });

  it('creates two-stop gradients: linear across the box, the others from its centre', () => {
    const linear = gradientPaint('GRADIENT_LINEAR', RED, BLUE);
    expect(linear).toMatchObject({ type: 'GRADIENT_LINEAR', from: { x: 0.5, y: 0 }, to: { x: 0.5, y: 1 }, opacity: 1, visible: true });
    expect(linear.stops).toEqual([
      { position: 0, color: RED, opacity: 1 },
      { position: 1, color: BLUE, opacity: 1 },
    ]);
    expect(gradientPaint('GRADIENT_RADIAL', RED, BLUE)).toMatchObject({ from: { x: 0.5, y: 0.5 }, to: { x: 1, y: 0.5 } });
    expect(paintColor(linear)).toEqual(RED);
    expect(paintColor(solidPaint(BLUE))).toEqual(BLUE);
    expect(hasVisiblePaint([linear])).toBe(true);
  });

  it('converts between paint kinds without losing what carries over', () => {
    const solid = { ...solidPaint(RED, 0.5), visible: false };
    const linear = convertPaint(solid, 'GRADIENT_LINEAR') as GradientPaint;
    expect(linear).toMatchObject({ type: 'GRADIENT_LINEAR', opacity: 0.5, visible: false });
    // A solid becomes a fade from its colour to transparent.
    expect(linear.stops).toEqual([
      { position: 0, color: RED, opacity: 1 },
      { position: 1, color: RED, opacity: 0 },
    ]);

    const edited: GradientPaint = { ...linear, stops: [linear.stops[0]!, { position: 0.4, color: BLUE, opacity: 1 }, linear.stops[1]!] };
    const radial = convertPaint(edited, 'GRADIENT_RADIAL') as GradientPaint;
    expect(radial.type).toBe('GRADIENT_RADIAL');
    expect(radial.stops).toEqual(edited.stops);
    expect(radial.from).toEqual({ x: 0.5, y: 0.5 });

    expect(convertPaint(radial, 'SOLID')).toEqual({ type: 'SOLID', color: RED, opacity: 0.5, visible: false });
    expect(convertPaint(solid, 'SOLID')).toBe(solid);
  });

  it('keeps valid gradients and repairs broken ones', () => {
    const { doc, pageId } = setup();
    const rect = addLayer(doc, 'RECTANGLE', pageId, { fills: [gradientPaint('GRADIENT_ANGULAR', RED, BLUE)] });
    expect(validateDocument(rect.doc)).toEqual([]);

    const data = raw(rect.doc);
    (data.nodes[rect.id] as Record<string, unknown>).fills = [
      // Stops out of order and out of range; a missing handle.
      { type: 'GRADIENT_LINEAR', stops: [{ position: 2, color: BLUE, opacity: 1 }, { position: 0.2, color: RED, opacity: 5 }], from: { x: 0, y: 0 }, opacity: 1, visible: true },
      // One stop is not a gradient.
      { type: 'GRADIENT_RADIAL', stops: [{ position: 0.5, color: RED, opacity: 1 }], from: { x: 0.5, y: 0.5 }, to: { x: 1, y: 0.5 }, opacity: 1, visible: true },
      // A kind this version does not have.
      { type: 'IMAGE_FROM_THE_FUTURE', opacity: 1, visible: true },
    ];
    const fills = (repairDocument(data).doc.nodes[rect.id] as LayerNode).fills as GradientPaint[];
    expect(fills).toHaveLength(2);
    expect(fills[0]?.stops).toEqual([
      { position: 0.2, color: RED, opacity: 1 },
      { position: 1, color: BLUE, opacity: 1 },
    ]);
    expect(fills[0]?.to).toEqual({ x: 0.5, y: 1 });
    expect(fills[1]?.stops).toHaveLength(2);
  });
});

describe('stroke options, corner radii, effects and blend modes', () => {
  it('gives new layers the defaults that paint a plain stroke and nothing else', () => {
    const { doc, pageId } = setup();
    const rect = addLayer(doc, 'RECTANGLE', pageId);
    expect(rect.doc.nodes[rect.id]).toMatchObject({
      strokeCap: 'NONE',
      strokeJoin: 'MITER',
      dashPattern: [],
      effects: [],
      blendMode: 'NORMAL',
      cornerRadii: null,
    });
    const line = addLayer(doc, 'LINE', pageId);
    expect('cornerRadii' in (line.doc.nodes[line.id] as object)).toBe(false);
  });

  it('accepts valid values', () => {
    const { doc, pageId } = setup();
    const rect = addLayer(doc, 'RECTANGLE', pageId, {
      strokeCap: 'ROUND',
      strokeJoin: 'BEVEL',
      dashPattern: [8, 4],
      blendMode: 'MULTIPLY',
      cornerRadii: [1, 2, 3, 4],
      effects: [dropShadow(), { type: 'LAYER_BLUR', radius: 6, visible: true }],
    });
    expect(validateDocument(rect.doc)).toEqual([]);
  });

  it('repairs invalid values', () => {
    const { doc, pageId } = setup();
    const rect = addLayer(doc, 'RECTANGLE', pageId);
    const data = raw(rect.doc);
    Object.assign(data.nodes[rect.id] as Record<string, unknown>, {
      strokeCap: 'POINTY',
      strokeJoin: 7,
      dashPattern: [0, 0],
      blendMode: 'SPARKLE',
      cornerRadii: [1, 2, 3],
      effects: [
        { type: 'DROP_SHADOW', color: { r: 9, g: -1, b: 0.5 }, opacity: 3, offsetX: 'far', offsetY: 2, blur: -5, spread: 1, visible: true },
        { type: 'BACKGROUND_BLUR', radius: -3 },
        { type: 'GLOW' },
        'nonsense',
      ],
    });
    const repaired = repairDocument(data);
    expect(repaired.repairs.length).toBeGreaterThan(0);
    expect(repaired.doc.nodes[rect.id]).toMatchObject({
      strokeCap: 'NONE',
      strokeJoin: 'MITER',
      dashPattern: [],
      blendMode: 'NORMAL',
      cornerRadii: null,
      effects: [
        { type: 'DROP_SHADOW', color: { r: 1, g: 0, b: 0.5 }, opacity: 1, offsetX: 0, offsetY: 2, blur: 0, spread: 1, visible: true },
        { type: 'BACKGROUND_BLUR', radius: 0, visible: true },
      ],
    });
  });

  it('converts between effect kinds, carrying the blur across', () => {
    const shadow = { ...dropShadow(), blur: 12, offsetX: 3 };
    expect(convertEffect(shadow, 'INNER_SHADOW')).toEqual({ ...shadow, type: 'INNER_SHADOW' });
    expect(convertEffect(shadow, 'LAYER_BLUR')).toEqual({ type: 'LAYER_BLUR', radius: 12, visible: true });
    const blur = { type: 'BACKGROUND_BLUR' as const, radius: 9, visible: false };
    expect(convertEffect(blur, 'LAYER_BLUR')).toEqual({ type: 'LAYER_BLUR', radius: 9, visible: false });
    expect(convertEffect(blur, 'DROP_SHADOW')).toMatchObject({ type: 'DROP_SHADOW', blur: 9, visible: false });
    expect(convertEffect(shadow, 'DROP_SHADOW')).toBe(shadow);
  });

  it('scales corner radii down together when they do not fit', () => {
    expect(effectiveRadii(100, 100, 10, null)).toEqual([10, 10, 10, 10]);
    expect(effectiveRadii(100, 100, 10, [0, 20, 30, 40])).toEqual([0, 20, 30, 40]);
    // 80 + 80 does not fit in a width of 100, so every radius is scaled to 62.5%.
    expect(effectiveRadii(100, 200, 80, null)).toEqual([50, 50, 50, 50]);
    expect(effectiveRadii(100, 100, 0, [100, 100, 0, 0])).toEqual([50, 50, 0, 0]);
    expect(effectiveRadii(0, 100, 10, null)).toEqual([0, 0, 0, 0]);
    // Shadow spread grows or shrinks rounded corners with the outline…
    expect(effectiveRadii(100, 100, 10, null, 4)).toEqual([6, 6, 6, 6]);
    expect(effectiveRadii(130, 130, 10, null, -15)).toEqual([25, 25, 25, 25]);
    // …but a sharp corner stays sharp however far the shadow spreads.
    expect(effectiveRadii(130, 130, 0, null, -15)).toEqual([0, 0, 0, 0]);
    expect(effectiveRadii(130, 130, 0, [0, 8, 0, 0], -15)).toEqual([0, 23, 0, 0]);
  });

  it('counts shadows and layer blur in what a layer paints, so they are not culled early', () => {
    const { doc, pageId } = setup();
    const rect = addLayer(doc, 'RECTANGLE', pageId, { x: 0, y: 0, width: 100, height: 100 });
    expect(getRenderBounds(rect.doc, rect.id)).toEqual({ x: 0, y: 0, width: 100, height: 100 });
    const shadowed = patchNode(rect.doc, rect.id, { effects: [{ ...dropShadow(), offsetX: 10, offsetY: 0, blur: 20, spread: 5 }] });
    expect(getRenderBounds(shadowed, rect.id)).toEqual({ x: -35, y: -35, width: 170, height: 170 });
    const blurred = patchNode(rect.doc, rect.id, { effects: [{ type: 'LAYER_BLUR', radius: 10, visible: true }] });
    expect(getRenderBounds(blurred, rect.id)).toEqual({ x: -30, y: -30, width: 160, height: 160 });
    const hidden = patchNode(rect.doc, rect.id, { effects: [{ ...dropShadow(), visible: false }] });
    expect(getRenderBounds(hidden, rect.id)).toEqual({ x: 0, y: 0, width: 100, height: 100 });
  });
});

describe('how the renderer composites', () => {
  /** A canvas context that accepts every call, hands out gradient stubs and counts scratch canvases. */
  function harness(): { ctx: CanvasRenderingContext2D; created: () => number; createCanvas: () => HTMLCanvasElement; set: (prop: string) => unknown[] } {
    let created = 0;
    const assignments = new Map<string, unknown[]>();
    const make = (): CanvasRenderingContext2D => {
      const target: Record<string, unknown> = { filter: 'none', globalAlpha: 1 };
      const proxy: CanvasRenderingContext2D = new Proxy(target, {
        get(obj, prop: string) {
          if (prop in obj) return obj[prop];
          if (prop === 'canvas') return {};
          if (/^create.*Gradient$/.test(prop)) return () => ({ addColorStop: () => undefined });
          return () => undefined;
        },
        set(obj, prop: string, value) {
          obj[prop] = value;
          const list = assignments.get(prop) ?? [];
          list.push(value);
          assignments.set(prop, list);
          return true;
        },
      }) as unknown as CanvasRenderingContext2D;
      return proxy;
    };
    return {
      ctx: make(),
      created: () => created,
      createCanvas: () => {
        created++;
        return { getContext: () => make() } as unknown as HTMLCanvasElement;
      },
      set: (prop) => assignments.get(prop) ?? [],
    };
  }

  const view = { size: { width: 400, height: 300 }, dpr: 1, viewport: { x: 0, y: 0, zoom: 1 } };

  it('paints simple layers directly, including ones with a drop shadow', () => {
    const { doc, pageId } = setup();
    const rect = addLayer(doc, 'RECTANGLE', pageId, { x: 10, y: 10, effects: [dropShadow()], fills: [gradientPaint('GRADIENT_RADIAL', RED, BLUE)] });
    const h = harness();
    renderScene(h.ctx, rect.doc, pageId, { ...view, createCanvas: h.createCanvas });
    expect(h.created()).toBe(0);
    expect(h.set('shadowBlur')).toContain(8);
    expect(h.set('shadowColor')).toContain('rgba(0, 0, 0, 0.25)');
  });

  it('composites a layer as a whole for blend modes, layer blur and group opacity', () => {
    const { doc, pageId } = setup();
    const base = addLayer(doc, 'RECTANGLE', pageId, { x: 10, y: 10 });
    const cases: [string, Document][] = [
      ['blend mode', patchNode(base.doc, base.id, { blendMode: 'MULTIPLY' })],
      ['layer blur', patchNode(base.doc, base.id, { effects: [{ type: 'LAYER_BLUR', radius: 4, visible: true }] })],
      ['two paints at half opacity', patchNode(base.doc, base.id, { opacity: 0.5, strokes: [solidPaint(RED)], strokeWeight: 2 })],
    ];
    for (const [name, document] of cases) {
      const h = harness();
      renderScene(h.ctx, document, pageId, { ...view, createCanvas: h.createCanvas });
      expect(h.created(), name).toBe(1);
    }
    const multiply = harness();
    renderScene(multiply.ctx, cases[0]![1], pageId, { ...view, createCanvas: multiply.createCanvas });
    expect(multiply.set('globalCompositeOperation')).toContain('multiply');
    const blur = harness();
    renderScene(blur.ctx, cases[1]![1], pageId, { ...view, createCanvas: blur.createCanvas });
    expect(blur.set('filter')).toContain('blur(4px)');
  });

  it('applies stroke caps, joins and dashes, and scales blur with the zoom', () => {
    const { doc, pageId } = setup();
    const rect = addLayer(doc, 'RECTANGLE', pageId, {
      x: 10,
      y: 10,
      strokes: [solidPaint(RED)],
      strokeWeight: 3,
      strokeCap: 'ROUND',
      strokeJoin: 'BEVEL',
      dashPattern: [6, 2],
      effects: [{ type: 'BACKGROUND_BLUR', radius: 5, visible: true }],
    });
    const h = harness();
    renderScene(h.ctx, rect.doc, pageId, { ...view, viewport: { x: 0, y: 0, zoom: 2 } });
    expect(h.set('lineCap')).toContain('round');
    expect(h.set('lineJoin')).toContain('bevel');
    expect(h.set('filter')).toContain('blur(10px)');
  });
});

describe('version 3 files', () => {
  const V3_FIXTURE = {
    format: 'open-design',
    schemaVersion: 3,
    meta: { createdAt: '2026-11-15T14:00:00.000Z', updatedAt: '2026-11-15T14:30:00.000Z' },
    document: {
      id: 'docV3fixture00001',
      name: 'Version 3 file',
      nodes: {
        page0000000000001: { id: 'page0000000000001', type: 'PAGE', name: 'Page 1', parentId: null, order: 'a0', backgroundColor: { r: 0.118, g: 0.118, b: 0.118 } },
        rect0000000000001: {
          id: 'rect0000000000001', type: 'RECTANGLE', name: 'Card', parentId: 'page0000000000001', order: 'a0',
          visible: true, locked: false, x: 0, y: 0, width: 200, height: 120, rotation: 0, opacity: 1,
          fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 }, opacity: 1, visible: true }],
          strokes: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 }, opacity: 1, visible: true }], strokeWeight: 2, strokeAlign: 'CENTER',
          cornerRadius: 12,
        },
        text0000000000001: {
          id: 'text0000000000001', type: 'TEXT', name: 'Hello', parentId: 'page0000000000001', order: 'a1',
          visible: true, locked: false, x: 20, y: 20, width: 40, height: 19, rotation: 0, opacity: 1,
          fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 }, opacity: 1, visible: true }], strokes: [], strokeWeight: 1, strokeAlign: 'INSIDE',
          characters: 'Hello', fontFamily: 'Arial', fontSize: 16, fontWeight: 400, italic: false, lineHeight: null, letterSpacing: 0,
          textAlign: 'LEFT', verticalAlign: 'TOP', textAutoResize: 'WIDTH_AND_HEIGHT', textDecoration: 'NONE', textCase: 'ORIGINAL',
        },
      },
    },
  };

  it('open in version 4 with every layer given the new defaults and nothing else changed', () => {
    const parsed = parseFile(JSON.parse(JSON.stringify(V3_FIXTURE)));
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(4);
    expect(parsed.file.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(parsed.repairs).toEqual([]);
    const nodes = parsed.file.document.nodes;
    for (const [id, original] of Object.entries(V3_FIXTURE.document.nodes)) expect(nodes[id]).toMatchObject(original);
    expect(nodes.rect0000000000001).toMatchObject({ strokeCap: 'NONE', strokeJoin: 'MITER', dashPattern: [], effects: [], blendMode: 'NORMAL', cornerRadii: null });
    expect(nodes.text0000000000001).toMatchObject({ strokeCap: 'NONE', strokeJoin: 'MITER', dashPattern: [], effects: [], blendMode: 'NORMAL' });
    expect('cornerRadii' in (nodes.text0000000000001 as object)).toBe(false);
    expect('strokeCap' in (nodes.page0000000000001 as object)).toBe(false);
  });
});
