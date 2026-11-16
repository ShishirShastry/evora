import { describe, expect, it } from 'vitest';
import {
  addLayer,
  approximateMeasurer,
  createDocument,
  getChildIds,
  getLayer,
  getPages,
  networkBounds,
  networkFromSubpaths,
  parseColour,
  parsePathData,
  parseTransform,
  parseXml,
  readSvg,
  solidPaint,
  SvgImportError,
  textOf,
  XmlError,
  type Document,
  type FrameNode,
  type GradientPaint,
  type LayerPatch,
  type LayerType,
  type NodeId,
  type SolidPaint,
  type TextNode,
  type VectorNode,
} from './core';
import { exportSvg } from './engine/export/svg';
import { buildVectorScene } from './engine/export/vector';
import { getRenderBounds } from './engine/render/scene';
import { placeSvgLayers } from './state/images';
import { createEditorStore, type EditorStore } from './state/editorStore';

/**
 * Importing SVG: the file is read into layers that can be edited. The
 * drawing is checked layer by layer, and what this application exports as
 * SVG is read back and compared with what was exported.
 */

const RED = { r: 1, g: 0, b: 0 };
const BLUE = { r: 0, g: 0, b: 1 };
const now = (store: EditorStore): Document => store.getState().doc;

function start(): { store: EditorStore; pageId: NodeId } {
  const store = createEditorStore(createDocument('Import'));
  return { store, pageId: (getPages(now(store))[0] as { id: NodeId }).id };
}

/** Imports an SVG into a new file and gives the frame and the layers in it, bottom first. */
function imported(svg: string): { store: EditorStore; frame: FrameNode; layers: ReturnType<typeof getLayer>[]; warnings: string[] } {
  const { store } = start();
  const drawing = readSvg(svg, approximateMeasurer);
  const frameId = placeSvgLayers(store, drawing, 'Drawing', { x: drawing.width / 2, y: drawing.height / 2 }) as NodeId;
  return { store, frame: getLayer(now(store), frameId) as FrameNode, layers: getChildIds(now(store), frameId).map((id) => getLayer(now(store), id)), warnings: drawing.warnings };
}

describe('XML', () => {
  it('reads elements, attributes, text and entities, and says what is wrong with what is not XML', () => {
    const root = parseXml(`<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x "y">]><!-- a comment --><a one="1" two='&lt;2&gt; &amp; &#65;&#x42;'><b/>text &quot;here&quot;<c><![CDATA[<raw>]]></c></a>`);
    expect(root.name).toBe('a');
    expect(root.attributes).toEqual({ one: '1', two: '<2> & AB' });
    expect(root.children.map((child) => (typeof child === 'string' ? child : child.name))).toEqual(['b', 'text "here"', 'c']);
    expect(textOf(root)).toBe('text "here"<raw>');
    expect(() => parseXml('<a><b></a>')).toThrow(XmlError);
    expect(() => parseXml('<a>')).toThrow('<a> is not closed');
    expect(() => parseXml('<a b=c/>')).toThrow('name="value"');
    expect(() => parseXml('just text')).toThrow('no element');
  });
});

describe('paths, transforms and colours', () => {
  it('reads every path command, absolute and relative, into curves', () => {
    const ends = (d: string): [number, number][] => parsePathData(d).flatMap((path) => path.curves.map((curve) => [Math.round(curve.p3.x * 100) / 100, Math.round(curve.p3.y * 100) / 100] as [number, number]));
    expect(ends('M10 10 L20 10 H30 V20 Z')).toEqual([[20, 10], [30, 10], [30, 20], [10, 10]]);
    expect(ends('m10 10 l10 0 h10 v10 z')).toEqual([[20, 10], [30, 10], [30, 20], [10, 10]]);
    // Numbers after a move are lines; signs and dots end numbers without a space.
    expect(ends('M0 0 10 0 10-10.5.5.5')).toEqual([[10, 0], [10, -10.5], [0.5, 0.5]]);
    expect(parsePathData('M0 0 L10 0 Z')[0]?.closed).toBe(true);
    expect(parsePathData('M0 0 L10 0')[0]?.closed).toBe(false);
    // Two subpaths.
    expect(parsePathData('M0 0L1 0M5 5L6 5').length).toBe(2);
    // A cubic, and a smooth one that mirrors its second handle.
    const cubic = parsePathData('M0 0 C10 0 20 10 20 20 S30 40 40 40')[0]!.curves;
    expect(cubic[0]).toMatchObject({ p1: { x: 10, y: 0 }, p2: { x: 20, y: 10 }, p3: { x: 20, y: 20 } });
    expect(cubic[1]).toMatchObject({ p1: { x: 20, y: 30 }, p2: { x: 30, y: 40 }, p3: { x: 40, y: 40 } });
    // A quadratic becomes the cubic that draws the same curve: its middle is where the quadratic's is.
    const quad = parsePathData('M0 0 Q10 20 20 0 T40 0')[0]!.curves;
    const mid = (c: (typeof quad)[number]): number => (c.p0.y + 3 * c.p1.y + 3 * c.p2.y + c.p3.y) / 8;
    expect(mid(quad[0]!)).toBeCloseTo(10);
    expect(mid(quad[1]!)).toBeCloseTo(-10);
    // An arc: half a circle of radius 10 passes through its top.
    const arc = parsePathData('M0 0 A10 10 0 0 1 20 0')[0]!.curves;
    expect(arc.length).toBe(2);
    expect(arc[0]!.p3.x).toBeCloseTo(10);
    expect(arc[0]!.p3.y).toBeCloseTo(-10);
    // Flags written without spaces, and radii too small to reach, which are grown.
    expect(ends('M0 0a5 5 0 0110 0')).toEqual([[5, -5], [10, 0]]);
    expect(ends('M0 0 A1 1 0 0 0 20 0').pop()).toEqual([20, 0]);
    // What cannot be read ends the path there.
    expect(ends('M0 0 L10 10 L20')).toEqual([[10, 10]]);
    expect(parsePathData('')).toEqual([]);
    // A closed path's last curve comes back to its first point.
    const network = networkFromSubpaths(parsePathData('M0 0 L10 0 L10 10 Z M20 20 L30 20'));
    expect(network.vertices).toHaveLength(5);
    expect(network.segments.map((segment) => [segment.start, segment.end])).toEqual([[0, 1], [1, 2], [2, 0], [3, 4]]);
    expect(networkBounds(network)).toEqual({ x: 0, y: 0, width: 30, height: 20 });
  });

  it('reads transforms and colours as CSS writes them', () => {
    expect(parseTransform('translate(10, 20)')).toEqual([1, 0, 0, 1, 10, 20]);
    expect(parseTransform('translate(10 20) scale(2)')).toEqual([2, 0, 0, 2, 10, 20]);
    expect(parseTransform('matrix(1 2 3 4 5 6)')).toEqual([1, 2, 3, 4, 5, 6]);
    const turn = parseTransform('rotate(90 10 10)');
    expect(turn.map((n) => Math.round(n * 1000) / 1000)).toEqual([0, 1, -1, 0, 20, 0]);
    expect(parseTransform(undefined)).toEqual([1, 0, 0, 1, 0, 0]);
    expect(parseColour('#f00')).toEqual({ color: RED, opacity: 1 });
    expect(parseColour('#0000FF80')?.opacity).toBeCloseTo(0.5, 2);
    expect(parseColour('rgb(255, 0, 0)')).toEqual({ color: RED, opacity: 1 });
    expect(parseColour('rgba(0 0 255 / 50%)')).toEqual({ color: BLUE, opacity: 0.5 });
    expect(parseColour('blue')).toEqual({ color: BLUE, opacity: 1 });
    expect(parseColour('none')).toBeNull();
    expect(parseColour('transparent')).toBeNull();
    expect(parseColour('not-a-colour')).toBeUndefined();
  });
});

describe('importing SVG', () => {
  it('turns shapes, groups, gradients and text into layers that can be edited', () => {
    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="200" height="100" viewBox="0 0 400 200">
  <defs>
    <linearGradient id="fade" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#f00"/><stop offset="100%" style="stop-color: blue; stop-opacity: 0.5"/></linearGradient>
    <style>.outlined { fill: none; stroke: #00f; stroke-width: 4px }</style>
    <circle id="dot" r="10"/>
  </defs>
  <rect id="background_card" x="20" y="20" width="100" height="60" rx="10" fill="url(#fade)"/>
  <circle cx="200" cy="100" r="40" fill="red" fill-opacity="0.5" opacity="0.8"/>
  <g id="marks" transform="translate(300 20)" opacity="0.5">
    <path class="outlined" d="M0 0 L40 0 L40 40 Z" stroke-linejoin="round" stroke-dasharray="4 2"/>
    <rect x="0" y="60" width="40" height="20" transform="rotate(45)"/>
  </g>
  <text x="20" y="180" font-family="'Georgia', serif" font-size="32" font-weight="bold" fill="#0000ff">Hello <tspan font-style="italic">there</tspan></text>
  <use xlink:href="#dot" x="380" y="180" fill="#00f"/>
  <image href="data:image/png;base64,AAAA" width="10" height="10"/>
  <polyline points="0,0 10,0 10,10" fill="none" stroke="black"/>
</svg>`;
    const { frame, layers, warnings, store } = imported(svg);
    // The drawing is 400 × 200 in a file that says it is 200 × 100: everything is half size.
    expect(frame).toMatchObject({ name: 'Drawing', width: 200, height: 100, x: 0, y: 0, fills: [], clipsContent: true });
    expect(layers.map((layer) => [layer?.type, layer?.name])).toEqual([['RECTANGLE', 'background card'], ['ELLIPSE', 'Ellipse'], ['GROUP', 'marks'], ['TEXT', 'Hello there'], ['ELLIPSE', 'dot'], ['VECTOR', 'Polyline']]);
    expect(warnings).toEqual(['A picture inside the SVG was left out: only its shapes and text are imported.']);

    const [card, circle, group, text, dot, line] = layers;
    expect(card).toMatchObject({ x: 10, y: 10, width: 50, height: 30, cornerRadius: 5 });
    expect(card?.fills[0]).toMatchObject({ type: 'GRADIENT_LINEAR', from: { x: 0, y: 0 }, to: { x: 1, y: 0 }, stops: [{ position: 0, color: RED, opacity: 1 }, { position: 1, color: BLUE, opacity: 0.5 }] });
    expect(circle).toMatchObject({ x: 80, y: 30, width: 40, height: 40, opacity: 0.8, fills: [{ type: 'SOLID', color: RED, opacity: 0.5 }] });
    // The group has its two layers, in the group's own space, and the group's opacity.
    expect(group).toMatchObject({ opacity: 0.5 });
    const members = getChildIds(now(store), group!.id).map((id) => getLayer(now(store), id));
    expect(members.map((member) => member?.type)).toEqual(['VECTOR', 'VECTOR']);
    const triangle = members[0] as VectorNode;
    expect(triangle).toMatchObject({ width: 20, height: 20, fills: [], strokeWeight: 2, strokeJoin: 'ROUND', dashPattern: [2, 1], strokes: [{ color: BLUE }] });
    expect(triangle.network.vertices).toEqual([{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }]);
    // The turned rectangle is its outline, turned: a diamond, as wide as it is tall.
    const diamond = members[1] as VectorNode;
    expect(diamond.network.vertices).toHaveLength(4);
    expect(diamond.width).toBeCloseTo(diamond.height);
    expect(diamond.fills).toMatchObject([{ color: { r: 0, g: 0, b: 0 } }]);
    // Text is text: its words, its font, half the size, blue.
    expect(text as TextNode).toMatchObject({ characters: 'Hello there', fontFamily: 'Georgia', fontSize: 16, fontWeight: 700, fills: [{ color: BLUE }] });
    // The baseline was at y = 90: the text's box starts above it.
    expect((text as TextNode).y).toBeLessThan(90);
    expect((text as TextNode).y + (text as TextNode).height).toBeGreaterThan(90);
    // The used circle, placed where the use says, with the use's fill.
    expect(dot).toMatchObject({ x: 185, y: 85, width: 10, height: 10, fills: [{ color: BLUE }] });
    expect(line).toMatchObject({ fills: [], strokes: [{ color: { r: 0, g: 0, b: 0 } }], strokeWeight: 0.5 });
    // It is one undo step, and what came in can be changed like anything else.
    store.getState().undo();
    expect(getChildIds(now(store), (getPages(now(store))[0] as { id: NodeId }).id)).toEqual([]);
  });

  it('says so when a file is not an SVG, and names what it leaves out', () => {
    expect(() => readSvg('<html><body/></html>')).toThrow(SvgImportError);
    expect(() => readSvg('<svg><g>')).toThrow('could not be read');
    expect(() => readSvg('<svg xmlns="http://www.w3.org/2000/svg"><defs/></svg>')).toThrow('no shapes or text');
    const drawing = readSvg('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" clip-path="url(#c)" filter="url(#f)" mask="url(#m)" fill="url(#p)"/><pattern id="p"/><rect width="5" height="5" style="display:none"/></svg>');
    expect(drawing.layers).toHaveLength(1);
    expect(drawing.warnings.sort()).toEqual([
      'A clipping path was left out: what it clipped is whole.',
      'A filter was left out: shadows and blurs of the SVG are not imported.',
      'A mask was left out: what it masked is whole.',
      'A pattern fill was left out: patterns are not imported.',
    ]);
  });

  it('reads back what this application exports as SVG', () => {
    const { store, pageId } = start();
    const add = (type: LayerType, parentId: NodeId, props: LayerPatch): NodeId => {
      let id = '';
      store.getState().apply('Add', (doc) => {
        const out = addLayer(doc, type, parentId, props);
        id = out.id;
        return out.doc;
      });
      return id;
    };
    const card = add('FRAME', pageId, { x: 50, y: 50, width: 200, height: 100, name: 'Card', fills: [solidPaint({ r: 1, g: 1, b: 1 })] });
    add('RECTANGLE', card, { x: 10, y: 10, width: 50, height: 30, name: 'Box', fills: [solidPaint(RED)] });
    add('ELLIPSE', card, { x: 80, y: 10, width: 40, height: 40, name: 'Ring', fills: [solidPaint(BLUE, 0.5)], strokes: [solidPaint(RED)], strokeWeight: 3, strokeAlign: 'CENTER' });
    add('RECTANGLE', card, { x: 140, y: 50, width: 40, height: 20, rotation: 30, name: 'Bar', fills: [solidPaint(BLUE)] });
    add('TEXT', card, { x: 10, y: 60, characters: 'Hello', name: 'Label', fills: [solidPaint(BLUE)], fontSize: 16 });
    const bounds = getRenderBounds(now(store), card);
    const { svg } = exportSvg(buildVectorScene(now(store), [card], { measurer: approximateMeasurer, origin: { x: bounds.x, y: bounds.y } }), { width: bounds.width, height: bounds.height });

    const back = imported(svg);
    expect(back.warnings).toEqual([]);
    expect(back.frame).toMatchObject({ width: 200, height: 100 });
    // The card comes back as a frame: a box with its own fill that clips what is in it.
    expect(back.layers).toHaveLength(1);
    const frame = back.layers[0] as FrameNode;
    expect(frame).toMatchObject({ type: 'FRAME', x: 0, y: 0, width: 200, height: 100, clipsContent: true });
    expect((frame.fills[0] as SolidPaint).color).toEqual({ r: 1, g: 1, b: 1 });
    // Shapes come back as outlines: each the same size, in the same place, with the same paint.
    const [box, ring, bar, label] = getChildIds(now(back.store), frame.id).map((id) => getLayer(now(back.store), id));
    expect(box).toMatchObject({ type: 'VECTOR', x: 10, y: 10, width: 50, height: 30, fills: [{ color: RED }] });
    // The ring's fill and its stroke are two shapes in the file, so they come back as a group of two.
    expect(ring?.type).toBe('GROUP');
    const parts = getChildIds(now(back.store), ring!.id).map((id) => getLayer(now(back.store), id));
    expect(parts[0]).toMatchObject({ x: 0, y: 0, fills: [{ color: BLUE, opacity: 0.5 }] });
    expect(parts[0]?.width).toBeCloseTo(40);
    expect(parts[1]).toMatchObject({ fills: [], strokes: [{ color: RED }], strokeWeight: 3 });
    expect(ring).toMatchObject({ x: 80, y: 10 });
    // The turned bar: the box round its turned outline is the box round the original's.
    const original = getRenderBounds(now(store), getChildIds(now(store), card)[2] as NodeId);
    expect(bar!.x).toBeCloseTo(original.x - 50, 1);
    expect(bar!.y).toBeCloseTo(original.y - 50, 1);
    expect(bar!.width).toBeCloseTo(original.width, 1);
    expect((bar?.fills[0] as SolidPaint).color).toEqual(BLUE);
    // Text comes back as text, where it was.
    expect(label as TextNode).toMatchObject({ type: 'TEXT', characters: 'Hello', fontFamily: 'Inter', fontSize: 16, fontWeight: 400, x: 10, fills: [{ color: BLUE }] });
    expect((label as TextNode).y).toBeCloseTo(60, 0);
    // A gradient round trip keeps its ends and its stops.
    const gradient = readSvg('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><defs><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="10" y1="25" x2="90" y2="25"><stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/></linearGradient></defs><path d="M10 0L90 0L90 50L10 50Z" fill="url(#g)"/></svg>');
    expect(gradient.layers[0]?.props.fills?.[0] as GradientPaint).toMatchObject({ type: 'GRADIENT_LINEAR', from: { x: 0, y: 0.5 }, to: { x: 1, y: 0.5 } });
  });
});
