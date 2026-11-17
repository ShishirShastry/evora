import { describe, expect, it } from 'vitest';
import {
  addLayer,
  approximateMeasurer,
  createDocument,
  getPages,
  gradientPaint,
  patchNode,
  solidPaint,
  type Document,
  type Effect,
  type GradientPaint,
  type LayerPatch,
  type LayerType,
  type NodeId,
} from './core';
import { separateShadow } from './engine/export/effects';
import { ANGULAR_WEDGES, angularWedges, diamondQuadrants, gradientColourAt } from './engine/export/gradients';
import { exportPdf, type EffectPictures } from './engine/export/pdf';
import { exportSvg } from './engine/export/svg';
import { buildVectorScene } from './engine/export/vector';
import { getRenderBounds } from './engine/render/scene';
import { createEditorStore, type EditorStore } from './state/editorStore';

/**
 * Export gaps closed: angular and diamond gradients drawn as they look
 * rather than as round ones, gradient stops that are partly transparent in
 * a PDF, shadows and blurs as SVG filters with their spread and room to
 * show, and shadows and blurs in a vector PDF as pictures from the renderer.
 * The SVG and PDF are read back here as the text they are.
 */

const RED = { r: 1, g: 0, b: 0 };
const BLUE = { r: 0, g: 0, b: 1 };
const WHITE = { r: 1, g: 1, b: 1 };
const BLACK = { r: 0, g: 0, b: 0 };

const now = (store: EditorStore): Document => store.getState().doc;
const act = (store: EditorStore, fn: (doc: Document) => Document): void => store.getState().apply('Edit', fn);

function add(store: EditorStore, type: LayerType, parentId: NodeId, props: LayerPatch): NodeId {
  let id = '';
  act(store, (doc) => {
    const out = addLayer(doc, type, parentId, props);
    id = out.id;
    return out.doc;
  });
  return id;
}

/** A page with one layer on it, 100 × 50 at (0, 0) unless told otherwise. */
function one(type: LayerType, props: LayerPatch): { store: EditorStore; id: NodeId } {
  const store = createEditorStore(createDocument('Gaps'));
  const pageId = (getPages(now(store))[0] as { id: NodeId }).id;
  const id = add(store, type, pageId, { x: 0, y: 0, width: 100, height: 50, name: 'Shape', ...props });
  return { store, id };
}

function svgOf(store: EditorStore, id: NodeId): { svg: string; warnings: string[] } {
  const doc = now(store);
  const bounds = getRenderBounds(doc, id);
  const scene = buildVectorScene(doc, [id], { measurer: approximateMeasurer, origin: { x: bounds.x, y: bounds.y } });
  return exportSvg(scene, { width: bounds.width, height: bounds.height });
}

const text = (bytes: Uint8Array): string => Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');

async function pdfOf(store: EditorStore, id: NodeId, pictures?: Record<string, EffectPictures>): Promise<{ all: string; warnings: string[] }> {
  const doc = now(store);
  const bounds = getRenderBounds(doc, id);
  const scene = buildVectorScene(doc, [id], { measurer: approximateMeasurer, origin: { x: bounds.x, y: bounds.y } });
  const out = await exportPdf([{ width: bounds.width, height: bounds.height, scene }], { measurer: approximateMeasurer, effectPictures: pictures });
  return { all: text(out.bytes), warnings: out.warnings };
}

/** Red to blue, the blue end see-through. */
function fading(type: GradientPaint['type']): GradientPaint {
  const paint = gradientPaint(type, RED, BLUE, 0) as GradientPaint;
  return { ...paint, stops: [paint.stops[0] as GradientPaint['stops'][number], { ...(paint.stops[1] as GradientPaint['stops'][number]), opacity: 0 }] };
}

const shadow = (type: 'DROP_SHADOW' | 'INNER_SHADOW', spread = 0): Effect => ({ type, color: BLACK, opacity: 0.5, offsetX: 2, offsetY: 4, blur: 6, spread, visible: true });

describe('angular and diamond gradients', () => {
  it('works out a gradient’s colour between its stops, weighting colours by their opacity', () => {
    const paint = fading('GRADIENT_LINEAR');
    // Half way to a blue that cannot be seen is red at half strength, not purple.
    expect(gradientColourAt(paint, 0.5)).toEqual({ color: RED, opacity: 0.5 });
    expect(gradientColourAt(paint, -1)).toEqual({ color: RED, opacity: 1 });
    expect(gradientColourAt(paint, 2)).toEqual({ color: BLUE, opacity: 0 });
    const solid = gradientPaint('GRADIENT_LINEAR', RED, BLUE, 0) as GradientPaint;
    expect(gradientColourAt(solid, 0.25)).toEqual({ color: { r: 0.75, g: 0, b: 0.25 }, opacity: 1 });
  });

  it('makes an angular gradient a fan of wedges that starts at its handle and covers the area', () => {
    const paint = gradientPaint('GRADIENT_ANGULAR', RED, BLUE, 0) as GradientPaint;
    const area = { x: 0, y: 0, width: 100, height: 50 };
    const wedges = angularWedges(paint, 100, 50, 'box', area);
    expect(wedges).toHaveLength(ANGULAR_WEDGES);
    // Every wedge starts at the centre, here the middle of the box.
    for (const wedge of wedges) expect(wedge.path[0]).toEqual({ op: 'M', x: 50, y: 25 });
    // The first is nearly red, the last nearly blue, and each is a triangle reaching past the box's corners.
    expect(wedges[0]?.color.r).toBeGreaterThan(0.99);
    expect(wedges[ANGULAR_WEDGES - 1]?.color.b).toBeGreaterThan(0.99);
    const tip = wedges[0]?.path[1] as { x: number; y: number };
    expect(tip.x).toBeGreaterThan(100);
    expect(tip.y).toBeCloseTo(25);
  });

  it('makes a diamond gradient four linear ones whose ends meet at the diamond’s corners', () => {
    const paint = gradientPaint('GRADIENT_DIAMOND', RED, BLUE, 0) as GradientPaint;
    const quadrants = diamondQuadrants(paint, 100, 50, { x: 0, y: 0, width: 100, height: 50 }) ?? [];
    expect(quadrants).toHaveLength(4);
    const radius = Math.hypot(paint.to.x - paint.from.x, paint.to.y - paint.from.y);
    expect(quadrants.map((quadrant) => [Math.sign(quadrant.to.x), Math.sign(quadrant.to.y)])).toEqual([
      [1, 1],
      [-1, 1],
      [-1, -1],
      [1, -1],
    ]);
    // Along the handle, at the radius, the gradient is at its end: (r, 0) projected on (r/2, r/2) is one length of it.
    const to = quadrants[0]?.to as { x: number; y: number };
    expect((radius * to.x) / (to.x * to.x + to.y * to.y)).toBeCloseTo(1);
    // A box with no size has no diamond: the canvas draws a round gradient there.
    expect(diamondQuadrants(paint, 0, 50, { x: 0, y: 0, width: 1, height: 50 })).toBeNull();
  });
});

describe('SVG', () => {
  it('writes an angular fill as wedges clipped to the shape, with nothing left out', () => {
    const { store, id } = one('ELLIPSE', { fills: [{ ...(gradientPaint('GRADIENT_ANGULAR', RED, BLUE, 0) as GradientPaint), opacity: 0.5 }] });
    const { svg, warnings } = svgOf(store, id);
    expect(warnings).toEqual([]);
    expect(svg).toMatch(/<g clip-path="url\(#clip\d+\)" opacity="0.5"><path d="M50 25L/);
    expect(svg.match(/<path d="M50 25L/g)).toHaveLength(ANGULAR_WEDGES);
    expect(svg).not.toContain('radialGradient');
  });

  it('writes a diamond fill as four linear gradients in the turned box, keeping see-through stops', () => {
    const { store, id } = one('RECTANGLE', { fills: [fading('GRADIENT_DIAMOND')] });
    const { svg, warnings } = svgOf(store, id);
    expect(warnings).toEqual([]);
    const gradients = svg.match(/<linearGradient [^>]*gradientTransform="matrix\([^)]*\)">/g) ?? [];
    expect(gradients).toHaveLength(4);
    // Each runs from the centre to half the radius along both axes of its quarter; the box is 100 × 50 with the centre in its middle.
    expect(gradients[0]).toContain('x1="0" y1="0" x2="0.25" y2="0.25" gradientTransform="matrix(100 0 0 50 50 25)"');
    expect(svg).toContain('<stop offset="1" stop-color="#0000ff" stop-opacity="0"/>');
  });

  it('shows an angular stroke and angular text through a mask of the line or the glyphs in white', () => {
    const line = one('RECTANGLE', { fills: [], strokes: [gradientPaint('GRADIENT_ANGULAR', RED, BLUE, 0)], strokeWeight: 4, strokeAlign: 'CENTER' });
    const stroked = svgOf(line.store, line.id);
    expect(stroked.svg).toMatch(/<mask id="mask\d+"><path d="M0 0L100 0L100 50L0 50Z" fill="none" stroke="#ffffff" stroke-width="4"\/><\/mask>/);
    expect(stroked.svg).toMatch(/<g mask="url\(#mask\d+\)"><path d="M50 25L/);
    const label = one('TEXT', { characters: 'Hi', fontSize: 20, fills: [gradientPaint('GRADIENT_ANGULAR', RED, BLUE, 0)] });
    const written = svgOf(label.store, label.id);
    expect(written.svg).toMatch(/<mask id="mask\d+"><text xml:space="preserve"><tspan [^>]* fill="#ffffff">Hi<\/tspan><\/text><\/mask>/);
    expect(written.warnings).toEqual([]);
  });

  it('colours lines with round gradients as circles, as the canvas does, a diamond included', () => {
    const { store, id } = one('RECTANGLE', { fills: [], strokes: [gradientPaint('GRADIENT_DIAMOND', RED, BLUE, 0)], strokeWeight: 2, strokeAlign: 'CENTER' });
    const { svg, warnings } = svgOf(store, id);
    expect(warnings).toEqual([]);
    expect(svg).toMatch(/<radialGradient id="gradient\d+" gradientUnits="userSpaceOnUse" cx="50" cy="25" r="[\d.]+">/);
  });

  it('writes shadows and a layer blur as filters, with spread, in the order the canvas paints them', () => {
    const { store, id } = one('RECTANGLE', { fills: [solidPaint(RED)], effects: [shadow('DROP_SHADOW', 3), shadow('INNER_SHADOW', 2), { type: 'LAYER_BLUR', radius: 5, visible: true }] } as LayerPatch);
    const { svg, warnings } = svgOf(store, id);
    expect(warnings).toEqual([]);
    const filter = /<filter [^>]*>(.*?)<\/filter>/.exec(svg)?.[1] ?? '';
    // The inner shadow: its spread shrinks the hole first, then the shape is turned inside out, moved, blurred, coloured and kept inside the shape.
    expect(filter).toContain('<feMorphology in="SourceAlpha" operator="erode" radius="2" result="inner1spread"/><feComponentTransfer in="inner1spread"');
    expect(filter).toContain('<feComposite in="inner1shade" in2="SourceGraphic" operator="in" result="inner1"/>');
    // The layer with its inner shadow is blurred; the drop shadow is cast by the layer before it is blurred, grown by its spread.
    expect(filter).toContain('<feMerge result="painted"><feMergeNode in="SourceGraphic"/><feMergeNode in="inner1"/></feMerge><feGaussianBlur in="painted" stdDeviation="5" result="blurred"/>');
    expect(filter).toContain('<feMorphology in="SourceAlpha" operator="dilate" radius="3" result="shadow2spread"/><feOffset in="shadow2spread" dx="2" dy="4"');
    expect(filter).toContain('<feFlood flood-color="#000000" flood-opacity="0.5" result="shadow2colour"/>');
    expect(filter.endsWith('<feMerge><feMergeNode in="shadow2"/><feMergeNode in="blurred"/></feMerge>')).toBe(true);
    expect(filter).not.toContain('feDropShadow');
  });

  it('gives a filter room in the layer’s own units, so a line with no height still casts its shadow, and says a background blur cannot be written', () => {
    const { store, id } = one('LINE', { width: 100, height: 0, strokes: [solidPaint(BLUE)], strokeWeight: 2, effects: [shadow('DROP_SHADOW'), { type: 'BACKGROUND_BLUR', radius: 8, visible: true }] } as LayerPatch);
    const { svg, warnings } = svgOf(store, id);
    const region = /<filter id="filter\d+" filterUnits="userSpaceOnUse" x="([-\d.]+)" y="([-\d.]+)" width="([\d.]+)" height="([\d.]+)"/.exec(svg);
    expect(region).not.toBeNull();
    // From above the line to below its shadow: 4 down, blurred by 6, and the line's own width.
    expect(Number(region?.[2])).toBeLessThan(-10);
    expect(Number(region?.[4])).toBeGreaterThan(20);
    expect(warnings).toEqual(['A background blur is not written to SVG: SVG cannot blur what is behind a shape.']);
  });
});

describe('PDF', () => {
  it('keeps gradient stops that are partly transparent with a soft mask of the same gradient in grey', async () => {
    const { store, id } = one('RECTANGLE', { fills: [fading('GRADIENT_LINEAR')] });
    const { all, warnings } = await pdfOf(store, id);
    expect(warnings).toEqual([]);
    // The colours, and beside them the opacities: 1 to 0.
    expect(all).toContain('/ShadingType 2 /ColorSpace /DeviceRGB /Coords [0 25 100 25]');
    expect(all).toMatch(/\/ShadingType 2 \/ColorSpace \/DeviceGray \/Coords \[0 25 100 25\] \/Function \d+ 0 R/);
    expect(all).toContain('/C0 [1] /C1 [0] /N 1');
    // The mask is that grey gradient painted over everything, set before the shape is filled with the colours.
    expect(all).toMatch(/<< \/Type \/ExtGState \/SMask << \/Type \/Mask \/S \/Luminosity \/G \d+ 0 R >> >>/);
    expect(all).toContain('q 1 0 0 1 0 0 cm /Sh1 sh Q');
    expect(all).toMatch(/\/GM1 gs\n\/Pattern cs \/P1 scn\n0 0 m\n100 0 l/);
    expect(all).toMatch(/\/Shading << \/Sh1 \d+ 0 R >>/);
  });

  it('writes an angular fill as wedges clipped to the shape, each as see-through as the gradient is there', async () => {
    const { store, id } = one('ELLIPSE', { fills: [fading('GRADIENT_ANGULAR')] });
    const { all, warnings } = await pdfOf(store, id);
    expect(warnings).toEqual([]);
    expect(all.match(/\n50 25 m\n/g)).toHaveLength(ANGULAR_WEDGES);
    expect(all).toContain('W n\n');
    // The first wedge is almost fully opaque, the last almost gone.
    expect(all).toMatch(/\/GS\d+ << \/Type \/ExtGState \/ca 0\.997\d* \/CA 1/);
    expect(all).toMatch(/\/GS\d+ << \/Type \/ExtGState \/ca 0\.002\d* \/CA 1/);
    expect(all).not.toContain('/ShadingType 3');
  });

  it('writes a diamond fill as four linear shadings, each in its quarter', async () => {
    const { store, id } = one('RECTANGLE', { fills: [gradientPaint('GRADIENT_DIAMOND', RED, BLUE, 0)] });
    const { all, warnings } = await pdfOf(store, id);
    expect(warnings).toEqual([]);
    expect(all.match(/\/ShadingType 2 \/ColorSpace \/DeviceRGB \/Coords \[0 0 -?0\.25 -?0\.25\]/g)).toHaveLength(4);
    // Each pattern is placed by the box, the centre and the turn (from the page, which is turned over).
    expect(all).toContain('/Matrix [100 0 0 -50 50 25]');
  });

  it('shows an angular stroke and angular text through soft masks of the line and the glyphs in white', async () => {
    const line = one('RECTANGLE', { fills: [], strokes: [gradientPaint('GRADIENT_ANGULAR', RED, BLUE, 0)], strokeWeight: 4, strokeAlign: 'CENTER' });
    const stroked = await pdfOf(line.store, line.id);
    expect(stroked.warnings).toEqual([]);
    expect(stroked.all).toContain('1 1 1 RG\n4 w 0 J 0 j [] 0 d\n0 0 m\n100 0 l\n100 50 l\n0 50 l\nh\nS\n');
    // The first wedge, almost red, inside the mask.
    expect(stroked.all).toMatch(/\/GM1 gs\n0\.99\d* 0 0\.00\d* rg\n50 25 m\n/);
    const label = one('TEXT', { characters: 'Hi', fontSize: 20, fills: [gradientPaint('GRADIENT_ANGULAR', RED, BLUE, 0)] });
    const written = await pdfOf(label.store, label.id);
    expect(written.warnings).toEqual([]);
    expect(written.all).toMatch(/q\n1 1 1 rg\nBT \/F1 20 Tf\n1 0 0 -1 0 [\d.]+ Tm \(H\) Tj\n/);
    expect(written.all).toMatch(/\/GM1 gs\n/);
  });

  it('lays pictures of shadows under and over a layer’s vectors, or a blurred layer in their place', async () => {
    const { store, id } = one('FRAME', { fills: [solidPaint(WHITE)], strokes: [solidPaint(BLUE)], strokeWeight: 2, effects: [shadow('DROP_SHADOW'), shadow('INNER_SHADOW')] } as LayerPatch);
    const pixel = (value: number) => ({ kind: 'pixels' as const, rgba: new Uint8Array([0, 0, 0, value]), width: 1, height: 1 });
    const pictures = { [id]: { under: { image: pixel(100), x: -10, y: -10, width: 130, height: 80 }, inner: { image: pixel(200), x: 0, y: 0, width: 100, height: 50 } } };
    const { all, warnings } = await pdfOf(store, id, pictures);
    expect(warnings).toEqual([]);
    // The drop shadow first, then the white fill, then the inner shadow over it, then the blue stroke.
    const under = all.indexOf('q 130 0 0 -80 -10 70 cm /Im1 Do Q');
    const fill = all.indexOf('1 1 1 rg\n');
    const inner = all.indexOf('q 100 0 0 -50 0 50 cm /Im2 Do Q');
    const stroke = all.indexOf('0 0 1 RG');
    expect(under).toBeGreaterThan(-1);
    expect(fill).toBeGreaterThan(under);
    expect(inner).toBeGreaterThan(fill);
    expect(stroke).toBeGreaterThan(inner);

    // A blurred layer is its picture alone; a background blur is said to be left out.
    act(store, (doc) => patchNode(doc, id, { effects: [{ type: 'LAYER_BLUR', radius: 4, visible: true }, { type: 'BACKGROUND_BLUR', radius: 4, visible: true }] } as LayerPatch));
    const blurred = await pdfOf(store, id, { [id]: { whole: { image: pixel(255), x: -12, y: -12, width: 124, height: 74 } } });
    expect(blurred.all).toContain('q 124 0 0 -74 -12 62 cm /Im1 Do Q');
    expect(blurred.all).not.toContain('1 1 1 rg\n');
    expect(blurred.warnings).toEqual(['A background blur is not written to a vector PDF: it blurs what is behind the layer, which a PDF cannot do. Choose “As a picture” for the PDF’s content to keep it.']);
  });

  it('finds a layer’s shadow alone from pictures of the layer with and without it', () => {
    // Four pixels: shadow only; the layer solid over the shadow; the layer half see-through over the shadow; nothing.
    const shadowAlone = [20, 40, 60, 128];
    const layer = [200, 0, 0];
    const over = (alpha: number): number[] => {
      const a = alpha / 255;
      const s = shadowAlone[3] as number / 255;
      const out = a + s * (1 - a);
      return [...layer.map((c, i) => Math.round(((c / 255) * a + ((shadowAlone[i] as number) / 255) * s * (1 - a)) / out * 255)), Math.round(out * 255)];
    };
    const withShadow = [...shadowAlone, ...over(255), ...over(128), 0, 0, 0, 0];
    const without = [0, 0, 0, 0, ...layer, 255, ...layer, 128, 0, 0, 0, 0];
    const found = Array.from(separateShadow(withShadow, without));
    expect(found.slice(0, 4)).toEqual(shadowAlone);
    // Under a solid layer the shadow cannot be seen, and is left empty.
    expect(found.slice(4, 8)).toEqual([0, 0, 0, 0]);
    // Under a half see-through layer it is found again, to within rounding.
    const half = found.slice(8, 12);
    for (let i = 0; i < 4; i++) expect(Math.abs((half[i] as number) - (shadowAlone[i] as number))).toBeLessThanOrEqual(3);
    expect(found.slice(12)).toEqual([0, 0, 0, 0]);
  });
});
