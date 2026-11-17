import { describe, expect, it } from 'vitest';
import {
  addExportSetting,
  addLayer,
  allExportTargets,
  approximateMeasurer,
  crc32,
  createDocument,
  CURRENT_SCHEMA_VERSION,
  exportFileName,
  exportScale,
  exportTargetsOf,
  formatConstraint,
  getLayer,
  getPages,
  gradientPaint,
  isZip,
  newExportSetting,
  parseConstraint,
  parseFile,
  patchNode,
  readZip,
  removeExportSetting,
  repairDocument,
  safeFileName,
  solidPaint,
  uniqueFileNames,
  updateExportSetting,
  writeZip,
  type Document,
  type LayerPatch,
  type LayerType,
  type NodeId,
} from './core';
import { exportPdf, standardFont, winAnsiCode, writableAsPdfText } from './engine/export/pdf';
import { exportSvg, pathData } from './engine/export/svg';
import { strokeSideBands } from './engine/render/paint';
import { buildVectorScene, PathRecorder } from './engine/export/vector';
import { getRenderBounds } from './engine/render/scene';
import { deflateRaw, deflateZlib, inflateRaw, inflateZlib } from './persistence/compression';
import { createEditorStore, type EditorStore } from './state/editorStore';

/**
 * Export: the settings kept on layers, and the SVG, PDF and ZIP that are
 * written, read back here as the bytes and text they are. Pictures (PNG and
 * JPG) need a real canvas and are tested in the browser.
 */

const RED = { r: 1, g: 0, b: 0 };
const GREEN = { r: 0, g: 1, b: 0 };
const BLUE = { r: 0, g: 0, b: 1 };
const WHITE = { r: 1, g: 1, b: 1 };

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

/** A 200 × 100 card at (50, 50) with a red box, a ring with a gradient, a rotated bar, and a line of text. */
function card(): { store: EditorStore; pageId: NodeId; card: NodeId; box: NodeId; ring: NodeId; bar: NodeId; label: NodeId } {
  const store = createEditorStore(createDocument('Export'));
  const pageId = (getPages(now(store))[0] as { id: NodeId }).id;
  const cardId = add(store, 'FRAME', pageId, { x: 50, y: 50, width: 200, height: 100, name: 'Card', fills: [solidPaint(WHITE)] });
  const box = add(store, 'RECTANGLE', cardId, { x: 10, y: 10, width: 50, height: 30, name: 'Box', fills: [solidPaint(RED)], strokes: [solidPaint(BLUE)], strokeWeight: 4, strokeAlign: 'INSIDE' });
  const ring = add(store, 'ELLIPSE', cardId, { x: 80, y: 10, width: 40, height: 40, name: 'Ring', fills: [gradientPaint('GRADIENT_LINEAR', RED, BLUE, 0)], opacity: 0.5 });
  // Sticks out of the card, which clips it.
  const bar = add(store, 'RECTANGLE', cardId, { x: 150, y: 60, width: 80, height: 10, rotation: 30, name: 'Bar', fills: [solidPaint(BLUE, 0.5)] });
  const label = add(store, 'TEXT', cardId, { x: 10, y: 60, characters: 'Hello', name: 'Label', fills: [solidPaint(BLUE)], fontSize: 16 });
  return { store, pageId, card: cardId, box, ring, bar, label };
}

function sceneOf(doc: Document, id: NodeId) {
  const bounds = getRenderBounds(doc, id);
  return { bounds, scene: buildVectorScene(doc, [id], { measurer: approximateMeasurer, origin: { x: bounds.x, y: bounds.y } }) };
}

/** Whether every element that is opened is closed, in order: what makes text XML. */
function wellFormed(xml: string): boolean {
  const open: string[] = [];
  for (const match of xml.matchAll(/<(\/?)([A-Za-z][\w:-]*)((?:\s+[\w:-]+="[^"<]*")*)\s*(\/?)>/g)) {
    if (match[4] === '/') continue;
    if (match[1] === '/') {
      if (open.pop() !== match[2]) return false;
    } else open.push(match[2] as string);
  }
  // Nothing is left over that looks like a tag but was not matched as one.
  return open.length === 0 && (xml.match(/</g)?.length ?? 0) === [...xml.matchAll(/<(\/?)([A-Za-z][\w:-]*)((?:\s+[\w:-]+="[^"<]*")*)\s*(\/?)>/g)].length;
}

const text = (bytes: Uint8Array): string => Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');

describe('export settings', () => {
  it('reads and writes sizes, works out scales and makes file names', () => {
    expect(parseConstraint('2x')).toEqual({ type: 'SCALE', value: 2 });
    expect(parseConstraint(' 1.5 X ')).toEqual({ type: 'SCALE', value: 1.5 });
    expect(parseConstraint('3')).toEqual({ type: 'SCALE', value: 3 });
    expect(parseConstraint('512w')).toEqual({ type: 'WIDTH', value: 512 });
    expect(parseConstraint('300h')).toEqual({ type: 'HEIGHT', value: 300 });
    expect(parseConstraint('64px')).toEqual({ type: 'WIDTH', value: 64 });
    for (const bad of ['', 'big', '0x', '-2x', '100x', '0w', '2y']) expect(parseConstraint(bad)).toBeNull();
    expect(formatConstraint({ type: 'SCALE', value: 0.5 })).toBe('0.5x');
    expect(formatConstraint({ type: 'WIDTH', value: 512 })).toBe('512w');
    expect(formatConstraint({ type: 'HEIGHT', value: 300 })).toBe('300h');
    expect(exportScale({ type: 'SCALE', value: 3 }, 200, 100)).toBe(3);
    expect(exportScale({ type: 'WIDTH', value: 500 }, 200, 100)).toBe(2.5);
    expect(exportScale({ type: 'HEIGHT', value: 50 }, 200, 100)).toBe(0.5);
    expect(exportFileName('Icon / Home', { suffix: '@2x', format: 'PNG' })).toBe('Icon - Home@2x.png');
    expect(exportFileName('  ', { suffix: '', format: 'PDF' })).toBe('Untitled.pdf');
    expect(safeFileName('a:b*c?"<>|.')).toBe('a-b-c-');
    expect(uniqueFileNames(['Icon.png', 'icon.png', 'Icon.svg', 'Icon.png'])).toEqual(['Icon.png', 'icon 2.png', 'Icon.svg', 'Icon 3.png']);
  });

  it('keeps the ways a layer and a page are exported, with undo, and lists everything that has any', () => {
    const c = card();
    act(c.store, (doc) => addExportSetting(doc, [c.card, c.box]));
    act(c.store, (doc) => addExportSetting(doc, [c.card], newExportSetting({ format: 'SVG', suffix: '-vector' })));
    act(c.store, (doc) => updateExportSetting(doc, [c.card, c.box], 0, { constraint: { type: 'SCALE', value: 2 }, suffix: '@2x' }));
    expect(getLayer(now(c.store), c.card)?.exportSettings).toMatchObject([{ format: 'PNG', constraint: { type: 'SCALE', value: 2 }, suffix: '@2x' }, { format: 'SVG', suffix: '-vector' }]);
    expect(getLayer(now(c.store), c.box)?.exportSettings).toHaveLength(1);
    act(c.store, (doc) => addExportSetting(doc, [c.pageId], newExportSetting({ format: 'PDF' })));
    expect(exportTargetsOf(now(c.store), [c.card]).map((target) => target.fileName)).toEqual(['Card@2x.png', 'Card-vector.svg']);
    expect(allExportTargets(now(c.store)).map((target) => target.fileName)).toEqual(['Page 1.pdf', 'Box@2x.png', 'Card@2x.png', 'Card-vector.svg']);
    c.store.getState().undo();
    expect(allExportTargets(now(c.store))).toHaveLength(3);
    c.store.getState().redo();
    act(c.store, (doc) => removeExportSetting(doc, [c.card], 0));
    expect(getLayer(now(c.store), c.card)?.exportSettings).toMatchObject([{ format: 'SVG' }]);
    // Two layers of one name get file names that differ.
    act(c.store, (doc) => addExportSetting(patchNode(doc, c.ring, { name: 'Box' }), [c.ring], newExportSetting({ suffix: '@2x', constraint: { type: 'SCALE', value: 2 } })));
    expect(exportTargetsOf(now(c.store), [c.box, c.ring]).map((target) => target.fileName)).toEqual(['Box@2x.png', 'Box@2x 2.png']);
  });

  it('opens a version 22 file, which has no export settings, and keeps them through saving and opening', () => {
    const c = card();
    const current = now(c.store);
    const v22 = JSON.parse(JSON.stringify(current)) as { nodes: Record<string, Record<string, unknown>> };
    for (const id in v22.nodes) for (const key of ['exportSettings', 'devStatus', 'annotations', 'devResources', 'codeConnect']) delete (v22.nodes[id] as Record<string, unknown>)[key];
    const parsed = parseFile({ format: 'open-design', schemaVersion: 22, meta: { createdAt: '2026-11-16T15:00:00.000Z', updatedAt: '2026-11-16T15:00:00.000Z' }, document: v22 });
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(23);
    expect(parsed.repairs).toEqual([]);
    expect(parsed.file.document).toEqual(current);
    act(c.store, (doc) => addExportSetting(doc, [c.card, c.pageId], newExportSetting({ format: 'JPG', quality: 0.6, background: true, constraint: { type: 'WIDTH', value: 640 } })));
    const reopened = repairDocument(JSON.parse(JSON.stringify(now(c.store))));
    expect(reopened.repairs).toEqual([]);
    expect(reopened.doc).toEqual(now(c.store));
    const raw = JSON.parse(JSON.stringify(now(c.store))) as { nodes: Record<string, Record<string, unknown>> };
    raw.nodes[c.card]!.exportSettings = [{ format: 'TIFF' }, { format: 'PNG', constraint: { type: 'SCALE', value: -3 }, quality: 9, pdfContent: 'HOLOGRAM' }, 'png'];
    expect(getLayer(repairDocument(raw).doc, c.card)?.exportSettings).toEqual([{ format: 'PNG', constraint: { type: 'SCALE', value: 0.01 }, suffix: '', background: false, quality: 1, svgIds: false, pdfContent: 'VECTOR', pdfText: 'TEXT' }]);
  });
});

describe('strokes with a weight for each side', () => {
  it('draws only the sides that have a weight, inside the box, and exports them as filled bands', () => {
    const c = card();
    act(c.store, (doc) => patchNode(doc, c.box, { strokes: [solidPaint(GREEN)], strokeSides: { top: 0, right: 0, bottom: 6, left: 2 } }));
    const box = getLayer(now(c.store), c.box)!;
    // Inside the 50 × 30 box: the bottom six and the left two; sides of no weight are not drawn.
    expect(strokeSideBands(box)).toEqual([
      { x: 0, y: 24, width: 50, height: 6 },
      { x: 0, y: 0, width: 2, height: 30 },
    ]);
    // Centred on the edge, they reach out half their weight.
    expect(strokeSideBands({ ...box, strokeAlign: 'CENTER' })).toEqual([
      { x: -1, y: 27, width: 51, height: 6 },
      { x: -1, y: 0, width: 2, height: 33 },
    ]);
    // What is drawn reaches as far as the heaviest side, so an outside stroke is not cut off or left out.
    act(c.store, (doc) => patchNode(doc, c.box, { strokeAlign: 'OUTSIDE', strokeWeight: 0 }));
    expect(getRenderBounds(now(c.store), c.box)).toEqual({ x: 54, y: 54, width: 62, height: 42 });
    // An ellipse has no sides: its stroke is the same all round.
    expect(strokeSideBands({ ...box, type: 'ELLIPSE' } as typeof box)).toBeNull();
    const { scene, bounds } = sceneOf(now(c.store), c.card);
    const { svg } = exportSvg(scene, { width: bounds.width, height: bounds.height });
    expect(svg).toContain('fill="#00ff00"');
    expect(svg).not.toContain('stroke="#00ff00"');
  });

  it('opens a version 23 file, which has none, and keeps them through saving and opening', () => {
    const c = card();
    const current = now(c.store);
    const v23 = JSON.parse(JSON.stringify(current)) as { nodes: Record<string, Record<string, unknown>> };
    for (const id in v23.nodes) delete (v23.nodes[id] as Record<string, unknown>).strokeSides;
    const parsed = parseFile({ format: 'open-design', schemaVersion: 23, meta: { createdAt: '2026-11-16T15:00:00.000Z', updatedAt: '2026-11-16T15:00:00.000Z' }, document: v23 });
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(24);
    expect(parsed.repairs).toEqual([]);
    expect(parsed.file.document).toEqual(current);
    act(c.store, (doc) => patchNode(doc, c.box, { strokeSides: { top: 1, right: 2, bottom: 3, left: 4 } }));
    const reopened = repairDocument(JSON.parse(JSON.stringify(now(c.store))));
    expect(reopened.repairs).toEqual([]);
    expect(reopened.doc).toEqual(now(c.store));
    // A weight that is not a number, or less than nothing, is mended.
    const raw = JSON.parse(JSON.stringify(now(c.store))) as { nodes: Record<string, Record<string, unknown>> };
    raw.nodes[c.box]!.strokeSides = { top: 'thick', right: -2, bottom: 3, left: 4 };
    expect(getLayer(repairDocument(raw).doc, c.box)?.strokeSides).toEqual({ top: 0, right: 0, bottom: 3, left: 4 });
  });
});

describe('paths', () => {
  it('turns what a canvas is told into lines and curves', () => {
    const path = new PathRecorder();
    path.beginPath();
    path.rect(10, 20, 30, 40);
    expect(pathData(path.segments)).toBe('M10 20L40 20L40 60L10 60Z');
    // A whole circle is four curves that end where they began.
    path.beginPath();
    path.arc(50, 50, 10, 0, Math.PI * 2);
    expect(path.segments.map((segment) => segment.op).join('')).toBe('MCCCC');
    expect(path.segments[0]).toMatchObject({ x: 60, y: 50 });
    const last = path.segments[4] as { x: number; y: number };
    expect(last.x).toBeCloseTo(60);
    expect(last.y).toBeCloseTo(50);
    // Each quarter passes through the circle: its middle is on it.
    const quarter = path.segments[1] as { x1: number; y1: number; x2: number; y2: number; x: number; y: number };
    const mid = { x: (60 + 3 * quarter.x1 + 3 * quarter.x2 + quarter.x) / 8, y: (50 + 3 * quarter.y1 + 3 * quarter.y2 + quarter.y) / 8 };
    expect(Math.hypot(mid.x - 50, mid.y - 50)).toBeCloseTo(10, 1);
    // A rounded corner: a line to where the curve starts, and a curve that ends on the next side.
    path.beginPath();
    path.moveTo(0, 0);
    path.arcTo(100, 0, 100, 100, 20);
    expect(path.segments.map((segment) => segment.op).join('')).toBe('MLC');
    expect(path.segments[1]).toMatchObject({ x: 80, y: 0 });
    expect((path.segments[2] as { x: number; y: number }).x).toBeCloseTo(100);
    expect((path.segments[2] as { x: number; y: number }).y).toBeCloseTo(20);
    // An ellipse arc anticlockwise, a quarter of the way.
    path.beginPath();
    path.ellipse(0, 0, 20, 10, 0, 0, -Math.PI / 2, true);
    const end = path.segments[path.segments.length - 1] as { x: number; y: number };
    expect(end.x).toBeCloseTo(0);
    expect(end.y).toBeCloseTo(-10);
  });
});

describe('SVG', () => {
  it('writes a frame with its shapes, gradient, clip, inside stroke and text', () => {
    const c = card();
    const { bounds, scene } = sceneOf(now(c.store), c.card);
    expect(bounds).toEqual({ x: 50, y: 50, width: 200, height: 100 });
    const { svg, warnings } = exportSvg(scene, { width: bounds.width, height: bounds.height });
    expect(warnings).toEqual([]);
    expect(wellFormed(svg)).toBe(true);
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100"')).toBe(true);
    // The card's own fill, and what is in it clipped to the card.
    expect(svg).toContain('<path d="M0 0L200 0L200 100L0 100Z" fill="#ffffff"/>');
    expect(svg).toMatch(/<clipPath id="clip\d+"><path d="M0 0L200 0L200 100L0 100Z"\/><\/clipPath>/);
    // The box where it is in the card, red, with a stroke of 4 inside it: a line of 8 clipped to the box.
    expect(svg).toContain('<g transform="translate(10 10)"><path d="M0 0L50 0L50 30L0 30Z" fill="#ff0000"/>');
    expect(svg).toMatch(/<g clip-path="url\(#clip\d+\)"><path d="M0 0L50 0L50 30L0 30Z" fill="none" stroke="#0000ff" stroke-width="8"\/><\/g>/);
    // The ring: half transparent, filled with a gradient from red to blue across its box.
    expect(svg).toMatch(/<linearGradient id="gradient\d+" gradientUnits="userSpaceOnUse" x1="0" y1="20" x2="40" y2="20"><stop offset="0" stop-color="#ff0000"\/><stop offset="1" stop-color="#0000ff"\/><\/linearGradient>/);
    expect(svg).toMatch(/<g transform="translate\(80 10\)" opacity="0.5"><path d="M40 20C[^"]+Z" fill="url\(#gradient\d+\)"\/><\/g>/);
    // The bar is turned, and its paint is half transparent.
    expect(svg).toMatch(/<g transform="matrix\(0\.866 0\.5 -0\.5 0\.866 [\d.]+ [\d.]+\)"><path d="M0 0L80 0L80 10L0 10Z" fill="#0000ff" fill-opacity="0\.5"\/><\/g>/);
    // Text is text, in its font, at its baseline.
    expect(svg).toMatch(/<text xml:space="preserve"><tspan x="0" y="[\d.]+" font-family="Inter, Arial, Helvetica, sans-serif" font-size="16" font-weight="400" fill="#0000ff">Hello<\/tspan><\/text>/);
  });

  it('follows its options, embeds images, and says what SVG cannot show', () => {
    const c = card();
    const hash = 'a'.repeat(64);
    act(c.store, (doc) => ({ ...doc, assets: { [hash]: { mimeType: 'image/png', width: 20, height: 10, name: 'photo.png' } } }));
    act(c.store, (doc) =>
      patchNode(
        patchNode(patchNode(doc, c.box, { fills: [{ type: 'IMAGE', imageHash: hash, scaleMode: 'FILL', crop: { x: 0, y: 0, width: 1, height: 1 }, tileScale: 1, exposure: 0, contrast: 0, saturation: 0, flipX: false, flipY: false, opacity: 1, visible: true }], strokes: [] }), c.ring, {
          fills: [gradientPaint('GRADIENT_ANGULAR', RED, BLUE, 0)],
          effects: [{ type: 'DROP_SHADOW', color: { r: 0, g: 0, b: 0 }, opacity: 0.25, offsetX: 0, offsetY: 4, blur: 8, spread: 0, visible: true }],
        } as LayerPatch),
        c.label,
        { characters: 'A < B & "C"' } as LayerPatch,
      ),
    );
    const { bounds, scene } = sceneOf(now(c.store), c.card);
    const out = exportSvg(scene, { width: bounds.width, height: bounds.height, scale: 2, background: BLUE, ids: true, images: { [hash]: { mimeType: 'image/png', base64: 'AAAA', width: 20, height: 10 } } });
    expect(wellFormed(out.svg)).toBe(true);
    // Twice the size, the same drawing.
    expect(out.svg).toContain('width="400" height="200" viewBox="0 0 200 100"');
    expect(out.svg).toContain('<rect width="200" height="100" fill="#0000ff"/>');
    for (const id of ['Card', 'Box', 'Ring', 'Bar', 'Label']) expect(out.svg).toContain(`<g id="${id}"`);
    // The image is in the file, stretched to cover the box (50 × 30 from 20 × 10: 60 × 30, centred).
    expect(out.svg).toContain('<image id="image');
    expect(out.svg).toContain('href="data:image/png;base64,AAAA"');
    expect(out.svg).toContain('<svg x="-5" y="0" width="60" height="30" viewBox="0 0 20 10" preserveAspectRatio="none" overflow="hidden">');
    expect(out.svg).toContain('<feOffset in="SourceAlpha" dx="0" dy="4" result="shadow1offset"/><feGaussianBlur in="shadow1offset" stdDeviation="4" result="shadow1blur"/><feFlood flood-color="#000000" flood-opacity="0.25"');
    expect(out.svg).toContain('A &lt; B &amp; &quot;C&quot;');
    // The angular gradient is a fan of wedges, the first red; nothing had to be left out.
    expect(out.svg).toContain('fill="#fe0001"');
    expect(out.warnings).toEqual([]);
    // Without the image's bytes the box is grey, and it is said.
    const missing = exportSvg(scene, { width: bounds.width, height: bounds.height });
    expect(missing.warnings).toContain('An image could not be found on this device and was left as a grey box.');
  });

  it('writes a mask as a mask, and a layer alone where it is on the page', () => {
    const c = card();
    act(c.store, (doc) => patchNode(doc, c.box, { isMask: true }));
    const { scene, bounds } = sceneOf(now(c.store), c.card);
    const out = exportSvg(scene, { width: bounds.width, height: bounds.height });
    expect(wellFormed(out.svg)).toBe(true);
    expect(out.svg).toMatch(/<mask id="mask\d+" style="mask-type:alpha">/);
    expect(out.svg).toMatch(/<g mask="url\(#mask\d+\)">/);
    // The ring alone: its own box, at the origin, though it sits inside a frame at (50, 50).
    const alone = sceneOf(now(c.store), c.ring);
    expect(alone.bounds).toEqual({ x: 130, y: 60, width: 40, height: 40 });
    expect(exportSvg(alone.scene, { width: 40, height: 40 }).svg).toMatch(/^<svg [^>]*width="40" height="40"[^>]*><defs>.*<\/defs><g opacity="0.5"><path d="M40 20C/);
  });
});

describe('PDF', () => {
  /** The objects of a PDF, found through its cross-reference table, as the reader of a PDF finds them. */
  function objects(bytes: Uint8Array): string[] {
    const all = text(bytes);
    const start = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(all)?.[1]);
    expect(all.slice(start, start + 4)).toBe('xref');
    const count = Number(/^xref\n0 (\d+)\n/.exec(all.slice(start))?.[1]);
    const rows = all.slice(start).split('\n').slice(2, 2 + count);
    expect(rows[0]).toBe('0000000000 65535 f ');
    return rows.slice(1).map((row, index) => {
      const offset = Number(row.slice(0, 10));
      // Every entry of the table points at the object of that number.
      expect(all.slice(offset, offset + `${index + 1} 0 obj`.length)).toBe(`${index + 1} 0 obj`);
      return all.slice(offset, all.indexOf('endobj', offset));
    });
  }

  it('writes a page of vectors: paths, a shading, an inside stroke, a form for a see-through group, and text', async () => {
    const c = card();
    // The ring gets something in it, so that its opacity has to apply to the two together.
    act(c.store, (doc) => patchNode(doc, c.ring, { strokes: [solidPaint(BLUE)], strokeWeight: 2, strokeAlign: 'CENTER' }));
    const { bounds, scene } = sceneOf(now(c.store), c.card);
    const { bytes, warnings } = await exportPdf([{ width: bounds.width, height: bounds.height, scene }], { measurer: approximateMeasurer, title: 'Card (1)' });
    expect(warnings).toEqual([]);
    const all = text(bytes);
    expect(all.startsWith('%PDF-1.4\n')).toBe(true);
    const parts = objects(bytes);
    expect(parts.some((part) => part.includes('/Type /Catalog'))).toBe(true);
    expect(parts.some((part) => part.includes('/Type /Page /Parent') && part.includes('/MediaBox [0 0 200 100]'))).toBe(true);
    expect(all).toContain('/Title (Card \\(1\\))');
    // The page is turned over so that y runs down; then the card's white fill.
    expect(all).toContain('1 0 0 -1 0 100 cm\n');
    expect(all).toContain('1 1 1 rg\n0 0 m\n200 0 l\n200 100 l\n0 100 l\nh\nf\n');
    // What is in the card is clipped to it.
    expect(all).toContain('0 0 m\n200 0 l\n200 100 l\n0 100 l\nh\nW n\n');
    // The red box, and its stroke: clipped to the box, 8 wide, blue.
    expect(all).toContain('1 0 0 1 10 10 cm\nq\n1 0 0 rg\n0 0 m\n50 0 l\n50 30 l\n0 30 l\nh\nf\nQ\n');
    expect(all).toContain('0 0 1 RG\n8 w 0 J 0 j [] 0 d\n');
    // The ring: drawn apart as a form, laid down at half opacity; its gradient is a shading from red to blue.
    expect(parts.some((part) => part.includes('/Subtype /Form') && part.includes('/Group << /S /Transparency'))).toBe(true);
    expect(all).toMatch(/\/GS\d+ gs \/Fm\d+ Do/);
    expect(all).toMatch(/\/GS\d+ << \/Type \/ExtGState \/ca 0\.5 \/CA 0\.5 \/BM \/Normal >>/);
    expect(parts.some((part) => part.includes('/ShadingType 2') && part.includes('/Coords [0 20 40 20]'))).toBe(true);
    expect(parts.some((part) => part.includes('/FunctionType 2') && part.includes('/C0 [1 0 0] /C1 [0 0 1]'))).toBe(true);
    // Inside the form the shading is placed from the form's own space.
    expect(parts.some((part) => part.includes('/PatternType 2') && part.includes('/Matrix [1 0 0 1 0 0]'))).toBe(true);
    // The bar's paint is half transparent on its own.
    expect(all).toMatch(/\/GS\d+ gs\n0 0 1 rg\n0 0 m\n80 0 l/);
    // Text: each character where the design has it (8 units a character here), the right way up, in Helvetica.
    expect(parts.some((part) => part.includes('/BaseFont /Helvetica /Encoding /WinAnsiEncoding'))).toBe(true);
    expect(all).toMatch(/BT \/F1 16 Tf\n1 0 0 -1 0 [\d.]+ Tm \(H\) Tj\n1 0 0 -1 8 [\d.]+ Tm \(e\) Tj\n/);
  });

  it('compresses streams when it can, writes pictures, and says what a vector PDF cannot show', async () => {
    const c = card();
    act(c.store, (doc) => patchNode(doc, c.ring, { fills: [gradientPaint('GRADIENT_DIAMOND', RED, BLUE, 0)], effects: [{ type: 'LAYER_BLUR', radius: 4, visible: true }] } as LayerPatch));
    const { bounds, scene } = sceneOf(now(c.store), c.card);
    const packed = await exportPdf([{ width: bounds.width, height: bounds.height, scene, background: BLUE }], { measurer: approximateMeasurer, deflate: deflateZlib });
    expect(packed.warnings).toEqual(['Shadows and blurs are not written to a vector PDF. Choose “As a picture” for the PDF’s content to keep them.']);
    const parts = objects(packed.bytes);
    const page = parts.find((part) => part.includes('/Filter /FlateDecode') && !part.includes('/Subtype')) as string;
    const stream = packed.bytes.subarray(text(packed.bytes).indexOf(page) + page.indexOf('stream\n') + 7, text(packed.bytes).indexOf(page) + page.lastIndexOf('\nendstream'));
    const content = text(await inflateZlib(stream));
    expect(content.startsWith('1 0 0 -1 0 100 cm\n0 0 1 rg 0 0 200 100 re f\n')).toBe(true);
    // The diamond is four linear shadings, one in each quarter.
    expect(parts.filter((part) => part.includes('/ShadingType 2'))).toHaveLength(4);

    // A page that is one picture, with a second page after it: two pixels, one of them see-through.
    const rgba = new Uint8Array([255, 0, 0, 255, 0, 0, 255, 0]);
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9]);
    const pictures = await exportPdf([
      { width: 20, height: 10, picture: { kind: 'pixels', rgba, width: 2, height: 1 } },
      { width: 30, height: 30, picture: { kind: 'jpeg', bytes: jpeg, width: 1, height: 1 } },
    ]);
    const all = text(pictures.bytes);
    const picked = objects(pictures.bytes);
    expect(picked.filter((part) => part.includes('/Type /Page /Parent'))).toHaveLength(2);
    expect(all).toContain('/Count 2');
    // The colours and, apart, how see-through each pixel is.
    expect(picked.some((part) => part.includes('/Width 2 /Height 1') && part.includes('/ColorSpace /DeviceRGB /SMask') && part.includes('stream\n\xff\x00\x00\x00\x00\xff\nendstream'))).toBe(true);
    expect(picked.some((part) => part.includes('/ColorSpace /DeviceGray') && part.includes('stream\n\xff\x00\nendstream'))).toBe(true);
    // A grey JPEG is passed through as it is.
    expect(picked.some((part) => part.includes('/ColorSpace /DeviceGray /Filter /DCTDecode /Length 17'))).toBe(true);
    // Drawn the right way up over the whole page.
    expect(all).toContain('q 20 0 0 -10 0 10 cm /Im1 Do Q\n');
  });

  it('knows which text the standard fonts can write, and which font stands in for which', () => {
    expect(writableAsPdfText('Hello, “world” — £5 • naïve…\nNext')).toBe(true);
    expect(writableAsPdfText('こんにちは')).toBe(false);
    expect(writableAsPdfText('😀')).toBe(false);
    expect(winAnsiCode('€')).toBe(128);
    expect(winAnsiCode('A')).toBe(65);
    expect(winAnsiCode('Ω')).toBeNull();
    expect(standardFont('Inter', 400, false)).toBe('Helvetica');
    expect(standardFont('Inter', 700, true)).toBe('Helvetica-BoldOblique');
    expect(standardFont('Georgia', 400, true)).toBe('Times-Italic');
    expect(standardFont('Source Serif', 700, false)).toBe('Times-Bold');
    expect(standardFont('Source Sans', 400, false)).toBe('Helvetica');
    expect(standardFont('JetBrains Mono', 600, false)).toBe('Courier-Bold');
  });
});

describe('ZIP', () => {
  it('writes an archive that reads back, and reads one whose entries are compressed', async () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    const entries = [
      { name: 'Card@2x.png', bytes: new Uint8Array([1, 2, 3, 4, 5]) },
      { name: 'icons/Ünïcode.svg', bytes: new TextEncoder().encode('<svg/>') },
      { name: 'empty.txt', bytes: new Uint8Array(0) },
    ];
    const zip = writeZip(entries);
    expect(isZip(zip)).toBe(true);
    expect(isZip(new Uint8Array([1, 2, 3, 4, 5]))).toBe(false);
    const never = (): Promise<Uint8Array> => Promise.reject(new Error('nothing here is compressed'));
    expect(await readZip(zip, never)).toEqual(entries);

    // An archive as other programs write it: one entry deflated, one folder.
    const content = new TextEncoder().encode('hello hello hello hello hello hello');
    const packed = await deflateRaw(content);
    expect(await inflateRaw(packed)).toEqual(content);
    const name = new TextEncoder().encode('folder/note.txt');
    const folder = new TextEncoder().encode('folder/');
    const local = (file: Uint8Array, method: number, data: Uint8Array, size: number): Uint8Array => {
      const view = new DataView(new ArrayBuffer(30));
      view.setUint32(0, 0x04034b50, true);
      view.setUint16(8, method, true);
      view.setUint32(18, data.length, true);
      view.setUint32(22, size, true);
      view.setUint16(26, file.length, true);
      return new Uint8Array([...new Uint8Array(view.buffer), ...file, ...data]);
    };
    const central = (file: Uint8Array, method: number, data: Uint8Array, size: number, offset: number): Uint8Array => {
      const view = new DataView(new ArrayBuffer(46));
      view.setUint32(0, 0x02014b50, true);
      view.setUint16(10, method, true);
      view.setUint32(20, data.length, true);
      view.setUint32(24, size, true);
      view.setUint16(28, file.length, true);
      view.setUint32(42, offset, true);
      return new Uint8Array([...new Uint8Array(view.buffer), ...file]);
    };
    const first = local(folder, 0, new Uint8Array(0), 0);
    const second = local(name, 8, packed, content.length);
    const directory = new Uint8Array([...central(folder, 0, new Uint8Array(0), 0, 0), ...central(name, 8, packed, content.length, first.length)]);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(10, 2, true);
    end.setUint32(12, directory.length, true);
    end.setUint32(16, first.length + second.length, true);
    const foreign = new Uint8Array([...first, ...second, ...directory, ...new Uint8Array(end.buffer)]);
    expect(await readZip(foreign, inflateRaw)).toEqual([{ name: 'folder/note.txt', bytes: content }]);
    await expect(readZip(new Uint8Array(100), inflateRaw)).rejects.toThrow('not a ZIP archive');
  });
});
