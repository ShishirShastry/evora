import { describe, expect, it } from 'vitest';
import {
  addLayer,
  approximateMeasurer,
  compileSchema,
  createComponent,
  createDocument,
  createInstance,
  encodeBinarySchema,
  FigError,
  getChildIds,
  getLayer,
  getPages,
  gradientPaint,
  imageSize,
  parseSchemaText,
  readFig,
  readVectorBlob,
  readZip,
  restoreLayout,
  patchNode,
  sha1,
  sha256Hex,
  solidPaint,
  toHex,
  writeFig,
  writeVectorBlob,
  writeZip,
  type Document,
  type FigEnvironment,
  type FrameNode,
  type GradientPaint,
  type KiwiObject,
  type LayerNode,
  type LayerPatch,
  type LayerType,
  type NodeId,
  type SolidPaint,
  type TextNode,
  type VectorNode,
} from './core';
import { createEditorStore, type EditorStore } from './state/editorStore';

/**
 * Figma `.fig` files. No file made by Figma is part of these tests (a real
 * one, the owner's, is tested in figsample.test.ts where it is present). So
 * these check, with files built by hand, that what this application
 * writes it reads back the same, and that a file laid out as Figma's are
 * (a schema with other field numbers and fields this application does not
 * know, Zstandard compression, an archive or a bare canvas) is read by the
 * names of its fields, with what is not converted listed.
 */

const zlib = (await import('node:zlib' as string)) as {
  deflateRawSync(bytes: Uint8Array): Uint8Array;
  inflateRawSync(bytes: Uint8Array): Uint8Array;
  zstdCompressSync(bytes: Uint8Array): Uint8Array;
};

const env: FigEnvironment = {
  inflateRaw: async (bytes) => new Uint8Array(zlib.inflateRawSync(bytes)),
  deflateRaw: async (bytes) => new Uint8Array(zlib.deflateRawSync(bytes)),
  sha256Hex,
  measurer: approximateMeasurer,
};

const RED = { r: 1, g: 0, b: 0 };
const BLUE = { r: 0, g: 0, b: 1 };
const WHITE = { r: 1, g: 1, b: 1 };

const now = (store: EditorStore): Document => store.getState().doc;

function add(store: EditorStore, type: LayerType, parentId: NodeId, props: LayerPatch): NodeId {
  let id = '';
  store.getState().apply('Add', (doc) => {
    const out = addLayer(doc, type, parentId, props);
    id = out.id;
    return out.doc;
  });
  return id;
}

/** The layers of a document by name, for comparing two documents whose IDs differ. */
function byName(doc: Document): Map<string, LayerNode> {
  const out = new Map<string, LayerNode>();
  for (const id in doc.nodes) {
    const node = doc.nodes[id];
    if (node && node.type !== 'PAGE' && node.sourceId === null) out.set(node.name, node as LayerNode);
  }
  return out;
}

/** A PNG of one red pixel. */
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='), (ch) => ch.charCodeAt(0));

describe('writing and reading .fig files', () => {
  it('reads back what it writes: pages, frames, shapes, text, vectors, gradients, images, effects, components and instances', async () => {
    const store = createEditorStore(createDocument('Round trip'));
    const pageId = (getPages(now(store))[0] as { id: NodeId }).id;
    const imageHash = await sha256Hex(PNG);
    store.getState().addAssets({ [imageHash]: { mimeType: 'image/png', width: 1, height: 1, name: 'dot.png' } });
    const card = add(store, 'FRAME', pageId, { x: 40, y: 30, width: 300, height: 200, name: 'Card', fills: [solidPaint(WHITE)], cornerRadius: 12, layoutMode: 'VERTICAL', itemSpacing: 8, paddingLeft: 16, paddingTop: 12, paddingRight: 16, paddingBottom: 12 } as LayerPatch);
    add(store, 'RECTANGLE', card, { width: 100, height: 40, name: 'Box', fills: [gradientPaint('GRADIENT_LINEAR', RED, BLUE, 0)], strokes: [solidPaint(BLUE, 0.5)], strokeWeight: 2, cornerRadii: [1, 2, 3, 4], effects: [{ type: 'DROP_SHADOW', color: { r: 0, g: 0, b: 0 }, opacity: 0.25, offsetX: 0, offsetY: 4, blur: 8, spread: 1, visible: true }] } as LayerPatch);
    add(store, 'TEXT', card, { characters: 'Hello Figma', name: 'Title', fontFamily: 'Inter', fontSize: 20, fontWeight: 700, italic: true, letterSpacing: 0.5, lineHeight: 28, fills: [solidPaint(BLUE)] } as LayerPatch);
    const free = add(store, 'FRAME', pageId, { x: 400, y: 0, width: 200, height: 200, name: 'Free', fills: [] });
    add(store, 'ELLIPSE', free, { x: 10, y: 20, width: 60, height: 40, rotation: 30, name: 'Oval', fills: [{ type: 'IMAGE', imageHash, scaleMode: 'FIT', crop: { x: 0, y: 0, width: 1, height: 1 }, tileScale: 1, exposure: 0, contrast: 0, saturation: 0, flipX: false, flipY: false, opacity: 1, visible: true }], arcStart: 0, arcSweep: 270, arcRatio: 0.5 } as LayerPatch);
    add(store, 'STAR', free, { x: 100, y: 100, width: 50, height: 50, name: 'Star', pointCount: 6, innerRadius: 0.5 } as LayerPatch);
    add(store, 'VECTOR', free, { x: 0, y: 150, width: 40, height: 20, name: 'Wave', network: { vertices: [{ x: 0, y: 20 }, { x: 40, y: 0 }], segments: [{ start: 0, end: 1, tangentStart: { x: 10, y: -20 }, tangentEnd: { x: -10, y: 20 } }] } } as LayerPatch);
    const button = add(store, 'FRAME', pageId, { x: 0, y: 400, width: 120, height: 40, name: 'Button', fills: [solidPaint(BLUE)] });
    add(store, 'TEXT', button, { x: 10, y: 10, characters: 'OK', name: 'Label' });
    store.getState().apply('Component', (doc) => (createComponent(doc, [button]) as { doc: Document }).doc);
    store.getState().apply('Instance', (doc) => (createInstance(doc, button, { parentId: pageId, at: { x: 200, y: 400 } }) as { doc: Document }).doc);
    store.getState().apply('Rename', (doc) => {
      const instance = Object.values(doc.nodes).find((node) => node.type === 'FRAME' && (node as FrameNode).kind === 'INSTANCE') as FrameNode;
      return { ...doc, nodes: { ...doc.nodes, [instance.id]: { ...instance, name: 'Button copy' } } };
    });
    const before = now(store);

    const { bytes, notWritten } = await writeFig(before, { [imageHash]: { bytes: PNG } }, env);
    expect(notWritten).toEqual(['How layers in Auto Layout are sized (hug and fill): 1']);
    // It is an archive with the canvas, the image named by its SHA-1, and meta.json.
    const entries = await readZip(bytes, env.inflateRaw);
    expect(entries.map((entry) => entry.name).sort()).toEqual(['canvas.fig', `images/${toHex(sha1(PNG))}`, 'meta.json'].sort());
    const canvas = entries.find((entry) => entry.name === 'canvas.fig')!.bytes;
    expect(String.fromCharCode(...canvas.subarray(0, 8))).toBe('fig-kiwi');

    const read = await readFig(bytes, 'Round trip', env);
    expect(read.notConverted).toEqual([]);
    expect(Object.keys(read.images)).toEqual([imageHash]);
    expect(read.doc.assets[imageHash]).toEqual({ mimeType: 'image/png', width: 1, height: 1, name: 'dot.png' });
    expect(getPages(read.doc).map((page) => page.name)).toEqual(['Page 1']);
    const a = byName(before);
    const b = byName(read.doc);
    expect([...b.keys()].sort()).toEqual([...a.keys()].sort());
    const close = (name: string, keys: string[]): void => {
      for (const key of keys) {
        const left = (a.get(name) as unknown as Record<string, unknown>)[key];
        const right = (b.get(name) as unknown as Record<string, unknown>)[key];
        if (typeof left === 'number') expect(right as number, `${name}.${key}`).toBeCloseTo(left, 3);
        else expect(JSON.parse(JSON.stringify(right)), `${name}.${key}`).toEqual(JSON.parse(JSON.stringify(left)));
      }
    };
    close('Card', ['x', 'y', 'width', 'height', 'cornerRadius', 'clipsContent', 'layoutMode', 'itemSpacing', 'paddingLeft', 'paddingTop', 'paddingRight', 'paddingBottom', 'fills']);
    close('Box', ['width', 'height', 'cornerRadii', 'strokes', 'strokeWeight', 'effects']);
    const gradient = b.get('Box')!.fills[0] as GradientPaint;
    const original = a.get('Box')!.fills[0] as GradientPaint;
    expect(gradient.type).toBe('GRADIENT_LINEAR');
    expect(gradient.stops).toEqual(original.stops);
    expect(gradient.from.x).toBeCloseTo(original.from.x, 4);
    expect(gradient.to.y).toBeCloseTo(original.to.y, 4);
    close('Title', ['characters', 'fontFamily', 'fontSize', 'fontWeight', 'italic', 'letterSpacing', 'lineHeight', 'fills']);
    close('Oval', ['x', 'y', 'width', 'height', 'rotation', 'arcStart', 'arcSweep', 'arcRatio']);
    expect(b.get('Oval')!.fills[0]).toMatchObject({ type: 'IMAGE', imageHash, scaleMode: 'FIT' });
    close('Star', ['pointCount', 'innerRadius', 'x', 'y']);
    close('Wave', ['x', 'y', 'width', 'height', 'network']);
    // The component is a component, and the instance shows it, with the component's layers made again.
    expect(b.get('Button')).toMatchObject({ kind: 'COMPONENT' });
    const copy = b.get('Button copy') as FrameNode;
    expect(copy).toMatchObject({ kind: 'INSTANCE', componentId: b.get('Button')!.id, x: 200, y: 400 });
    expect(getChildIds(read.doc, copy.id).map((id) => (getLayer(read.doc, id) as TextNode).characters)).toEqual(['OK']);
  });

  it('writes a stroke with a weight for each side as Figma keeps it, and reads it back', async () => {
    const store = createEditorStore(createDocument('Sides'));
    const pageId = (getPages(now(store))[0] as { id: NodeId }).id;
    const box = add(store, 'RECTANGLE', pageId, { width: 100, height: 40, name: 'Underlined', strokes: [solidPaint(BLUE)], strokeSides: { top: 0, right: 0, bottom: 2, left: 0 } } as LayerPatch);
    const written = await writeFig(now(store), {}, env);
    const read = await readFig(written.bytes, 'Sides', env);
    expect(byName(read.doc).get('Underlined')?.strokeSides).toEqual({ top: 0, right: 0, bottom: 2, left: 0 });
    expect(getLayer(now(store), box)?.strokeSides).toEqual({ top: 0, right: 0, bottom: 2, left: 0 });
  });

  it('notes what it cannot write', async () => {
    const store = createEditorStore(createDocument('Partial'));
    const pageId = (getPages(now(store))[0] as { id: NodeId }).id;
    add(store, 'TEXT', pageId, { characters: 'Ab', styleRanges: [{ start: 0, end: 1, fontWeight: 700 }] } as unknown as LayerPatch);
    add(store, 'RECTANGLE', pageId, { fills: [{ type: 'IMAGE', imageHash: 'f'.repeat(64), scaleMode: 'CROP', crop: { x: 0, y: 0, width: 1, height: 1 }, tileScale: 1, exposure: 0, contrast: 0, saturation: 0, flipX: false, flipY: false, opacity: 1, visible: true }] } as LayerPatch);
    const { notWritten } = await writeFig(now(store), {}, env);
    expect(notWritten.sort()).toEqual(['Image fills whose pictures are not on this device: 1', 'Parts of text in a style of their own: 1']);
  });
});

describe('reading files laid out as Figma’s', () => {
  /** A schema with field numbers of its own and fields this application does not use. */
  const FOREIGN = `
    enum NodeType { NONE = 0; DOCUMENT = 1; CANVAS = 2; GROUP = 3; FRAME = 4; VECTOR = 6; ROUNDED_RECTANGLE = 12; TEXT = 13; SLICE = 14; SYMBOL = 15; INSTANCE = 16; WIDGET = 40; }
    enum PaintType { SOLID = 0; IMAGE = 5; EMOJI = 9; }
    enum NumberUnits { RAW = 0; PIXELS = 1; PERCENT = 2; }
    struct GUID { uint sessionID; uint localID; }
    struct Color { float r; float g; float b; float a; }
    struct Vector { float x; float y; }
    struct Matrix { float m00; float m01; float m02; float m10; float m11; float m12; }
    message ParentIndex { string position = 7; GUID guid = 3; }
    message Number { NumberUnits units = 9; float value = 4; }
    message FontName { string family = 1; string style = 2; }
    message TextData { string characters = 1; uint[] characterStyleIDs = 2; NodeChange[] styleOverrideTable = 3; }
    message Paint { PaintType type = 1; Color color = 2; float opacity = 3; bool visible = 4; }
    message SymbolOverride { string note = 1; }
    message SymbolData { GUID symbolID = 1; SymbolOverride[] symbolOverrides = 2; }
    message VectorData { uint vectorNetworkBlob = 1; Vector normalizedSize = 2; }
    message StyleId { GUID guid = 1; }
    message PrototypeEvent { string interactionType = 1; float transitionTimeout = 2; }
    message PrototypeAction { string connectionType = 1; string connectionURL = 2; GUID transitionNodeID = 3; string navigationType = 4; string transitionType = 5; float transitionDuration = 6; string easingType = 7; }
    message PrototypeInteraction { PrototypeEvent event = 1; PrototypeAction[] actions = 2; }
    message NodeChange {
      string name = 100; GUID guid = 200; ParentIndex parentIndex = 300; NodeType type = 400;
      Vector size = 500; Matrix transform = 600; Paint[] fillPaints = 700; float opacity = 800;
      bool resizeToFit = 900; bool frameMaskDisabled = 901; TextData textData = 1000; float fontSize = 1001; FontName fontName = 1002;
      Number letterSpacing = 1003; Number lineHeight = 1004; SymbolData symbolData = 1100; VectorData vectorData = 1200;
      PrototypeInteraction[] prototypeInteractions = 1300; StyleId styleIdForFill = 1400; bool internalOnly = 1500; uint styleID = 1600; uint someFutureField = 9999;
    }
    message Blob { byte[] bytes = 1; }
    message Message { uint type = 1; NodeChange[] nodeChanges = 2; Blob[] blobs = 3; }
  `;
  const at = (x: number, y: number, turn = 0): KiwiObject => {
    const r = (turn * Math.PI) / 180;
    return { m00: Math.cos(r), m01: -Math.sin(r), m02: x, m10: Math.sin(r), m11: Math.cos(r), m12: y };
  };
  const g = (session: number, local: number): KiwiObject => ({ sessionID: session, localID: local });
  const paint = (r: number, gg: number, b: number, extra: KiwiObject = {}): KiwiObject => ({ type: 'SOLID', color: { r, g: gg, b, a: 1 }, opacity: 1, visible: true, ...extra });

  async function figma(nodeChanges: KiwiObject[], blobs: Uint8Array[], options: { compress: 'zstd' | 'deflate'; zip?: { name: string; bytes: Uint8Array }[]; schema?: string }): Promise<Uint8Array> {
    const schema = parseSchemaText(options.schema ?? FOREIGN);
    const message = compileSchema(schema).encode('Message', { type: 1, nodeChanges, blobs: blobs.map((bytes) => ({ bytes })) });
    const pack = (bytes: Uint8Array): Uint8Array => (options.compress === 'zstd' ? new Uint8Array(zlib.zstdCompressSync(bytes)) : new Uint8Array(zlib.deflateRawSync(bytes)));
    const parts = [pack(encodeBinarySchema(schema)), pack(message)];
    const canvas = new Uint8Array(12 + parts.reduce((sum, part) => sum + 4 + part.length, 0));
    const view = new DataView(canvas.buffer);
    canvas.set(new TextEncoder().encode('fig-kiwi'));
    view.setUint32(8, 101, true);
    let offset = 12;
    for (const part of parts) {
      view.setUint32(offset, part.length, true);
      canvas.set(part, offset + 4);
      offset += 4 + part.length;
    }
    return options.zip ? writeZip([{ name: 'canvas.fig', bytes: canvas }, ...options.zip]) : canvas;
  }

  const nodes = (): KiwiObject[] => [
    { guid: g(0, 0), type: 'DOCUMENT', name: 'Document' },
    // Pages in the order of their positions, not the order they come in.
    { guid: g(0, 2), type: 'CANVAS', name: 'Second', parentIndex: { guid: g(0, 0), position: 'b' } },
    { guid: g(0, 1), type: 'CANVAS', name: 'First', parentIndex: { guid: g(0, 0), position: 'a' } },
    { guid: g(0, 3), type: 'CANVAS', name: 'Internal Only Canvas', internalOnly: true, parentIndex: { guid: g(0, 0), position: 'c' } },
    { guid: g(9, 9), type: 'SYMBOL', name: 'Library button', parentIndex: { guid: g(0, 3), position: 'a' }, size: { x: 10, y: 10 }, transform: at(0, 0) },
    { guid: g(1, 1), type: 'FRAME', name: 'Screen', parentIndex: { guid: g(0, 1), position: 'a' }, size: { x: 375, y: 812 }, transform: at(10, 20), fillPaints: [paint(1, 1, 1)], someFutureField: 7, prototypeInteractions: [{ event: { interactionType: 'ON_CLICK' }, actions: [{ connectionType: 'URL', connectionURL: 'https://example.com' }] }, { event: { interactionType: 'AFTER_TIMEOUT', transitionTimeout: 1.5 }, actions: [{ connectionType: 'INTERNAL_NODE', navigationType: 'NAVIGATE', transitionNodeID: g(1, 2), transitionType: 'PUSH_FROM_RIGHT', transitionDuration: 0.4, easingType: 'LINEAR' }] }] },
    { guid: g(1, 4), type: 'TEXT', name: 'Heading', parentIndex: { guid: g(1, 1), position: 'b' }, size: { x: 200, y: 30 }, transform: at(16, 40), fillPaints: [paint(0, 0, 0)], textData: { characters: 'Welcome', characterStyleIDs: [0, 0, 1, 1], styleOverrideTable: [{ styleID: 1, fontName: { family: 'Roboto', style: 'Black' }, fillPaints: [paint(1, 0, 0)] }] }, fontSize: 24, fontName: { family: 'Roboto', style: 'Semi Bold Italic' }, letterSpacing: { value: 10, units: 'PERCENT' }, lineHeight: { value: 150, units: 'PERCENT' }, styleIdForFill: { guid: g(77, 1) } },
    // A frame that fits what is in it and does not clip: a group, as newer files keep them.
    { guid: g(1, 2), type: 'FRAME', name: 'Badge', parentIndex: { guid: g(1, 1), position: 'a' }, size: { x: 50, y: 50 }, transform: at(100, 100, 90), resizeToFit: true, frameMaskDisabled: true },
    { guid: g(1, 3), type: 'ROUNDED_RECTANGLE', name: 'Dot', parentIndex: { guid: g(1, 2), position: 'a' }, size: { x: 50, y: 50 }, transform: at(0, 0), fillPaints: [paint(1, 0, 0), { type: 'EMOJI' }] },
    { guid: g(1, 5), type: 'VECTOR', name: 'Line art', parentIndex: { guid: g(1, 1), position: 'c' }, size: { x: 100, y: 50 }, transform: at(0, 300), vectorData: { vectorNetworkBlob: 0, normalizedSize: { x: 10, y: 5 } } },
    { guid: g(1, 6), type: 'SLICE', name: 'Export area', parentIndex: { guid: g(1, 1), position: 'd' }, size: { x: 10, y: 10 } },
    { guid: g(1, 7), type: 'INSTANCE', name: 'Library button', parentIndex: { guid: g(1, 1), position: 'e' }, size: { x: 10, y: 10 }, transform: at(0, 0), symbolData: { symbolID: g(9, 9), symbolOverrides: [{ note: 'x' }] } },
    { guid: g(1, 8), type: 'WIDGET', name: 'Sticky', parentIndex: { guid: g(1, 1), position: 'f' } },
    { guid: g(2, 1), type: 'ROUNDED_RECTANGLE', name: 'Image box', parentIndex: { guid: g(0, 2), position: 'a' }, size: { x: 20, y: 10 }, transform: at(0, 0), fillPaints: [{ type: 'IMAGE', opacity: 1, visible: true }] },
  ];

  it('reads a Zstandard-compressed bare canvas by the names of its fields, and lists what it does not convert', async () => {
    const blob = writeVectorBlob({ vertices: [{ x: 0, y: 5 }, { x: 10, y: 0 }], segments: [{ start: 0, end: 1, tangentStart: { x: 2, y: 0 }, tangentEnd: { x: -2, y: 0 } }] });
    const file = await figma(nodes(), [blob], { compress: 'zstd' });
    const read = await readFig(file, 'From Figma', env);
    expect(read.version).toBe(101);
    expect(getPages(read.doc).map((page) => page.name)).toEqual(['First', 'Second']);
    const layers = byName(read.doc);
    expect(layers.get('Screen')).toMatchObject({ type: 'FRAME', x: 10, y: 20, width: 375, height: 812, clipsContent: true });
    expect((layers.get('Screen')!.fills[0] as SolidPaint).color).toEqual(WHITE);
    // The group is a group, turned a quarter, with its dot in it.
    const badge = layers.get('Badge')!;
    expect(badge.type).toBe('GROUP');
    expect(badge.rotation).toBeCloseTo(90);
    expect(getChildIds(read.doc, badge.id).map((id) => read.doc.nodes[id]?.name)).toEqual(['Dot']);
    expect(layers.get('Dot')).toMatchObject({ type: 'RECTANGLE', width: 50, fills: [{ color: RED }] });
    // Text: its words, its font, its weight and slant from the style's name, spacing from percentages.
    const heading = layers.get('Heading') as TextNode;
    expect(heading).toMatchObject({ characters: 'Welcome', fontFamily: 'Roboto', fontSize: 24, fontWeight: 600, italic: true });
    expect(heading.letterSpacing).toBeCloseTo(2.4);
    expect(heading.lineHeight).toBeCloseTo(36);
    // Its third and fourth letters in a style of their own: black, and red.
    expect(heading.styleRanges).toEqual([{ start: 2, end: 4, fontFamily: 'Roboto', fontWeight: 900, italic: false, color: RED }]);
    // The screen's prototype: a link opened on a click, and a timed push to the badge.
    expect(layers.get('Screen')!.reactions).toMatchObject([
      { trigger: { type: 'ON_CLICK' }, actions: [{ type: 'OPEN_LINK', expression: 'https://example.com' }] },
      { trigger: { type: 'AFTER_DELAY', delay: 1500 }, actions: [{ type: 'NAVIGATE', destinationId: badge.id, transition: { type: 'PUSH', direction: 'LEFT', duration: 400, easing: 'LINEAR' } }] },
    ]);
    // The vector's points, scaled from the size they were stored at to the layer's.
    const art = layers.get('Line art') as VectorNode;
    expect(art.network.vertices).toEqual([{ x: 0, y: 50 }, { x: 100, y: 0 }]);
    expect(art.network.segments[0]?.tangentStart).toEqual({ x: 20, y: 0 });
    // The instance's component is in a library, which the file does not hold.
    expect(layers.get('Library button')).toMatchObject({ kind: 'FRAME' });
    expect(read.notConverted.sort()).toEqual(
      [
        'Components from libraries (kept in Figma on a hidden page): 1',
        'Image fills whose pictures are not in the file (a bare canvas.fig keeps none): 1',
        'Instances of components that are not in the file (they are left as empty frames): 1',
        'Layers of the kind “WIDGET” (kept as boxes): 1',
        'Links to shared styles of other files (layers keep the look the styles gave them): 1',
        'Paints of the kind “EMOJI”: 1',
        'Slices (kept as empty frames, with their export settings): 1',
      ].sort(),
    );
    // Kinds with no layer of their own here are still there, as the nearest kind.
    expect(layers.get('Sticky')).toMatchObject({ type: 'RECTANGLE' });
    expect(layers.get('Export area')).toMatchObject({ type: 'FRAME', width: 10, height: 10, fills: [] });
  });

  it('reads a deflated archive with its images, and refuses what is not a Figma file', async () => {
    const hash = sha1(PNG);
    const changes = nodes();
    const image = changes.find((change) => change.name === 'Image box')!;
    image.fillPaints = [{ type: 'IMAGE', opacity: 1, visible: true }];
    const file = await figma(changes, [new Uint8Array(12)], { compress: 'deflate', zip: [{ name: `images/${toHex(hash)}`, bytes: PNG }] });
    const read = await readFig(file, 'Archive', env);
    // The image paint names no picture in this schema (it has no "image" field), so nothing is matched to it.
    expect(read.notConverted.some((line) => line.startsWith('Image fills'))).toBe(true);
    expect(imageSize(PNG)).toEqual({ width: 1, height: 1 });
    await expect(readFig(new TextEncoder().encode('hello there, not a file'), 'x', env)).rejects.toThrow(FigError);
    await expect(readFig(writeZip([{ name: 'readme.txt', bytes: new Uint8Array(1) }]), 'x', env)).rejects.toThrow('no canvas.fig');
    const cut = await figma(nodes(), [], { compress: 'zstd' });
    await expect(readFig(cut.subarray(0, cut.length - 10), 'x', env)).rejects.toThrow(FigError);
  });

  /** Figma's own field names for what a design system, a prototype and FigJam keep, with field numbers of this test's. */
  const RICH = `
    struct GUID { uint sessionID; uint localID; }
    struct Color { float r; float g; float b; float a; }
    struct Vector { float x; float y; }
    struct Matrix { float m00; float m01; float m02; float m10; float m11; float m12; }
    message ParentIndex { GUID guid = 1; string position = 2; }
    message Image { byte[] hash = 1; string name = 2; }
    message ColorStop { Color color = 1; float position = 2; }
    message ArcData { float startingAngle = 1; float endingAngle = 2; float innerRadius = 3; }
    message Paint { string type = 1; Color color = 2; float opacity = 3; bool visible = 4; Image image = 5; Image imageThumbnail = 6; ColorStop[] stops = 7; Matrix transform = 8; }
    message PrototypeDevice { string type = 1; Vector size = 2; }
    message Path { uint commandsBlob = 1; }
    message LineData { string lineType = 1; }
    message TextData { string characters = 1; LineData[] lines = 2; }
    message FontName { string family = 1; string style = 2; }
    message OptionalVector { Vector value = 1; }
    message LayoutGrid { string type = 1; string axis = 2; bool visible = 3; int numSections = 4; float offset = 5; float sectionSize = 6; float gutterSize = 7; Color color = 8; string pattern = 9; }
    message Guide { string axis = 1; float offset = 2; }
    message ExportConstraint { string type = 1; float value = 2; }
    message ExportSettings { string suffix = 1; string imageType = 2; ExportConstraint constraint = 3; }
    message VariableID { GUID guid = 1; }
    message Expression { string expressionFunction = 1; VariableData[] expressionArguments = 2; }
    message VariableAnyValue { bool boolValue = 1; string textValue = 2; float floatValue = 3; VariableID alias = 4; Color colorValue = 5; Expression expressionValue = 6; }
    message VariableData { VariableAnyValue value = 1; }
    message VariableDataMapEntry { string variableField = 1; VariableData variableData = 2; }
    message VariableDataMap { VariableDataMapEntry[] entries = 1; }
    message VariableSetID { GUID guid = 1; }
    message VariableModeBySetMapEntry { VariableSetID variableSetID = 1; GUID variableModeID = 2; }
    message VariableModeBySetMap { VariableModeBySetMapEntry[] entries = 1; }
    message VariableSetMode { GUID id = 1; string name = 2; }
    message VariableDataValuesEntry { GUID modeID = 1; VariableData variableData = 2; }
    message VariableDataValues { VariableDataValuesEntry[] entries = 1; }
    message StyleId { GUID guid = 1; }
    message KeyTrigger { int[] keyCodes = 1; }
    message PrototypeEvent { string interactionType = 1; KeyTrigger keyTrigger = 2; }
    message ConditionalActions { PrototypeAction[] actions = 1; VariableData condition = 2; }
    message PrototypeAction { string connectionType = 1; string connectionURL = 2; GUID targetVariableID = 3; VariableData targetVariableData = 4; ConditionalActions[] conditionalActions = 5; }
    message PrototypeInteraction { PrototypeEvent event = 1; PrototypeAction[] actions = 2; }
    message BackgroundAppearance { string backgroundType = 1; Color backgroundColor = 2; }
    message GuidPath { GUID[] guids = 1; }
    message SymbolOverride { GuidPath guidPath = 1; string name = 2; float strokeWeight = 3; Vector size = 4; string stackPositioning = 5; Paint[] fillPaints = 6; bool borderStrokeWeightsIndependent = 7; float borderTopWeight = 8; }
    message SymbolData { GUID symbolID = 1; SymbolOverride[] symbolOverrides = 2; }
    message NodeChange {
      GUID guid = 1; ParentIndex parentIndex = 2; string type = 3; string name = 4; Vector size = 5; Matrix transform = 6;
      Paint[] fillPaints = 7; Paint[] strokePaints = 8; float strokeWeight = 9; bool borderStrokeWeightsIndependent = 10;
      float borderTopWeight = 11; float borderRightWeight = 12; float borderBottomWeight = 13; float borderLeftWeight = 14;
      Path[] fillGeometry = 15; Path[] strokeGeometry = 16; TextData textData = 17; float fontSize = 18; FontName fontName = 19;
      LayoutGrid[] layoutGrids = 20; Guide[] guides = 21; ExportSettings[] exportSettings = 22; OptionalVector minSize = 23; OptionalVector maxSize = 24;
      VariableDataMap variableConsumptionMap = 25; VariableModeBySetMap variableModeBySetMap = 26; string scrollDirection = 27;
      string overlayPositionType = 28; string overlayBackgroundInteraction = 29; BackgroundAppearance overlayBackgroundAppearance = 30;
      PrototypeInteraction[] prototypeInteractions = 31; SymbolData symbolData = 32; string styleType = 33; StyleId styleIdForGrid = 34;
      VariableSetMode[] variableSetModes = 35; VariableSetID variableSetID = 36; string variableResolvedType = 37; VariableDataValues variableDataValues = 38;
      bool internalOnly = 39; float rectangleTopLeftCornerRadius = 40; float rectangleBottomLeftCornerRadius = 41; bool rectangleCornerRadiiIndependent = 42; string horizontalConstraint = 43; string verticalConstraint = 44; PrototypeDevice prototypeDevice = 45; ArcData arcData = 46;
    }
    message Blob { byte[] bytes = 1; }
    message Message { uint type = 1; NodeChange[] nodeChanges = 2; Blob[] blobs = 3; }
  `;

  /** An outline as Figma keeps one: 1 move, 2 line, 0 close, each followed by its points as little-endian floats. */
  const outline = (...commands: (number | [number, number])[]): Uint8Array => {
    const bytes: number[] = [];
    const view = new DataView(new ArrayBuffer(4));
    for (const command of commands) {
      if (typeof command === 'number') bytes.push(command);
      else
        for (const value of command) {
          view.setFloat32(0, value, true);
          bytes.push(...new Uint8Array(view.buffer));
        }
    }
    return Uint8Array.from(bytes);
  };

  it('reads what a design system, a prototype and FigJam keep: per-side strokes, grids, bindings, modes, flips, overrides, logic and other kinds of node', async () => {
    const v = (value: KiwiObject): KiwiObject => ({ value });
    const count = g(5, 3);
    const changes: KiwiObject[] = [
      { guid: g(0, 0), type: 'DOCUMENT', name: 'Document' },
      { guid: g(0, 1), type: 'CANVAS', name: 'Page', parentIndex: { guid: g(0, 0), position: 'a' }, prototypeDevice: { type: 'PRESET', size: { x: 390, y: 844 } } },
      { guid: g(0, 3), type: 'CANVAS', name: 'Internal Only Canvas', internalOnly: true, parentIndex: { guid: g(0, 0), position: 'b' } },
      // A video, shown by its first frame.
      { guid: g(1, 7), type: 'ROUNDED_RECTANGLE', name: 'Clip', parentIndex: { guid: g(0, 1), position: 'l' }, size: { x: 20, y: 10 }, transform: at(0, 1000), fillPaints: [{ type: 'VIDEO', opacity: 1, visible: true, image: { hash: new Uint8Array(20), name: 'clip.mp4' }, imageThumbnail: { hash: sha1(PNG), name: 'clip' } }] },
      // A collection with a mode, a number for a radius and a counter.
      { guid: g(5, 1), type: 'VARIABLE_SET', name: 'Theme', variableSetModes: [{ id: g(5, 10), name: 'Light' }], parentIndex: { guid: g(0, 3), position: 'a' } },
      { guid: g(5, 2), type: 'VARIABLE', name: 'gap', variableSetID: { guid: g(5, 1) }, variableResolvedType: 'FLOAT', variableDataValues: { entries: [{ modeID: g(5, 10), variableData: v({ floatValue: 8 }) }] }, parentIndex: { guid: g(0, 3), position: 'b' } },
      { guid: g(5, 4), type: 'VARIABLE', name: 'label', variableSetID: { guid: g(5, 1) }, variableResolvedType: 'STRING', variableDataValues: { entries: [{ modeID: g(5, 10), variableData: v({ textValue: '' }) }] }, parentIndex: { guid: g(0, 3), position: 'e' } },
      { guid: count, type: 'VARIABLE', name: 'count', variableSetID: { guid: g(5, 1) }, variableResolvedType: 'FLOAT', variableDataValues: { entries: [{ modeID: g(5, 10), variableData: v({ floatValue: 0 }) }] }, parentIndex: { guid: g(0, 3), position: 'c' } },
      // A shared grid style.
      { guid: g(6, 1), type: 'FRAME', name: 'Columns', styleType: 'GRID', layoutGrids: [{ type: 'STRETCH', axis: 'X', visible: true, numSections: 12, offset: 0, sectionSize: 10, gutterSize: 20, color: { r: 1, g: 0, b: 0, a: 0.1 }, pattern: 'STRIPES' }], parentIndex: { guid: g(0, 3), position: 'd' } },
      // A card: a line along its bottom only, a grid, a guide, exports, sizes, a bound radius, a mode, scrolling, an overlay's settings and some logic.
      {
        guid: g(1, 1),
        type: 'FRAME',
        name: 'Card',
        parentIndex: { guid: g(0, 1), position: 'a' },
        size: { x: 200, y: 100 },
        transform: at(0, 0),
        fillPaints: [paint(1, 1, 1)],
        strokePaints: [paint(0, 0, 0)],
        strokeWeight: 1,
        borderStrokeWeightsIndependent: true,
        borderTopWeight: 0,
        borderRightWeight: 0,
        borderBottomWeight: 4,
        borderLeftWeight: 0,
        styleIdForGrid: { guid: g(6, 1) },
        guides: [{ axis: 'Y', offset: 20 }],
        exportSettings: [
          { suffix: '@2x', imageType: 'PNG', constraint: { type: 'CONTENT_SCALE', value: 2 } },
          { suffix: '', imageType: 'SVG', constraint: { type: 'CONTENT_SCALE', value: 1 } },
        ],
        minSize: { value: { x: 50, y: 20 } },
        maxSize: { value: { x: 400, y: 300 } },
        variableConsumptionMap: { entries: [{ variableField: 'CORNER_RADIUS', variableData: v({ alias: { guid: g(5, 2) } }) }] },
        variableModeBySetMap: { entries: [{ variableSetID: { guid: g(5, 1) }, variableModeID: g(5, 10) }] },
        scrollDirection: 'VERTICAL',
        overlayPositionType: 'TOP_CENTER',
        overlayBackgroundInteraction: 'CLOSE_ON_CLICK_OUTSIDE',
        overlayBackgroundAppearance: { backgroundType: 'SOLID_COLOR', backgroundColor: { r: 0, g: 0, b: 0, a: 0.5 } },
        prototypeInteractions: [
          // The right arrow key adds one to the counter.
          {
            event: { interactionType: 'ON_KEY_DOWN', keyTrigger: { keyCodes: [39] } },
            actions: [{ connectionType: 'SET_VARIABLE', targetVariableID: count, targetVariableData: v({ expressionValue: { expressionFunction: 'ADDITION', expressionArguments: [v({ alias: { guid: count } }), v({ floatValue: 1 })] } }) }],
          },
          // A click: past two, a link; otherwise back to nought.
          {
            event: { interactionType: 'ON_CLICK' },
            actions: [
              {
                connectionType: 'CONDITIONAL',
                conditionalActions: [
                  { condition: v({ expressionValue: { expressionFunction: 'GREATER_THAN', expressionArguments: [v({ alias: { guid: count } }), v({ floatValue: 2 })] } }), actions: [{ connectionType: 'URL', connectionURL: 'https://example.com/more' }] },
                  { actions: [{ connectionType: 'SET_VARIABLE', targetVariableID: count, targetVariableData: v({ floatValue: 0 }) }] },
                ],
              },
            ],
          },
        ],
      },
      // A frame turned over top to bottom, with a bar at its top that is therefore drawn at its bottom, and its rounded corner with it.
      { guid: g(1, 2), type: 'FRAME', name: 'Flipped', parentIndex: { guid: g(0, 1), position: 'b' }, size: { x: 100, y: 50 }, transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: -1, m12: 250 }, fillPaints: [paint(0.9, 0.9, 0.9)], rectangleCornerRadiiIndependent: true, rectangleTopLeftCornerRadius: 12, rectangleBottomLeftCornerRadius: 0, strokePaints: [paint(0, 0, 0)], borderStrokeWeightsIndependent: true, borderTopWeight: 3, borderRightWeight: 0, borderBottomWeight: 0, borderLeftWeight: 0, prototypeInteractions: [{ event: { interactionType: 'ON_CLICK' }, actions: [{ connectionType: 'SET_VARIABLE', targetVariableID: g(5, 4), targetVariableData: v({ textValue: 'He said "hi"' }) }] }], layoutGrids: [{ type: 'MIN', axis: 'Y', visible: true, numSections: 3, offset: 8, sectionSize: 24, gutterSize: 12, color: { r: 0, g: 0, b: 1, a: 0.25 }, pattern: 'STRIPES' }] },
      { guid: g(1, 3), type: 'ROUNDED_RECTANGLE', name: 'Top bar', parentIndex: { guid: g(1, 2), position: 'a' }, size: { x: 100, y: 10 }, transform: at(0, 0), fillPaints: [paint(1, 0, 0)] },
      // A gradient on a shape turned over, and its twin the right way up; a quarter of an ellipse turned over.
      { guid: g(1, 8), type: 'VECTOR', name: 'Upright', parentIndex: { guid: g(0, 1), position: 'ba' }, size: { x: 100, y: 2 }, transform: at(600, 300), fillGeometry: [{ commandsBlob: 0 }], fillPaints: [{ type: 'GRADIENT_LINEAR', opacity: 1, visible: true, stops: [{ color: { r: 1, g: 0, b: 0, a: 1 }, position: 0 }, { color: { r: 0, g: 0, b: 1, a: 1 }, position: 1 }], transform: { m00: 0, m01: 1, m02: 0, m10: -1, m11: 0, m12: 1 } }] },
      { guid: g(1, 9), type: 'VECTOR', name: 'Turned over', parentIndex: { guid: g(0, 1), position: 'bb' }, size: { x: 100, y: 2 }, transform: { m00: 1, m01: 0, m02: 600, m10: 0, m11: -1, m12: 402 }, fillGeometry: [{ commandsBlob: 0 }], fillPaints: [{ type: 'GRADIENT_LINEAR', opacity: 1, visible: true, stops: [{ color: { r: 1, g: 0, b: 0, a: 1 }, position: 0 }, { color: { r: 0, g: 0, b: 1, a: 1 }, position: 1 }], transform: { m00: 0, m01: 1, m02: 0, m10: -1, m11: 0, m12: 1 } }] },
      { guid: g(1, 10), type: 'ELLIPSE', name: 'Quarter', parentIndex: { guid: g(0, 1), position: 'bc' }, size: { x: 40, y: 40 }, transform: { m00: 1, m01: 0, m02: 700, m10: 0, m11: -1, m12: 540 }, fillPaints: [paint(0, 0, 0)], arcData: { startingAngle: 0, endingAngle: Math.PI / 2, innerRadius: 0 } },
      // A text with a bullet on its first paragraph only.
      { guid: g(1, 11), type: 'TEXT', name: 'Half list', parentIndex: { guid: g(0, 1), position: 'bd' }, size: { x: 100, y: 40 }, transform: at(0, 360), fillPaints: [paint(0, 0, 0)], fontSize: 14, fontName: { family: 'Inter', style: 'Regular' }, textData: { characters: 'One\nTwo', lines: [{ lineType: 'UNORDERED_LIST' }, { lineType: 'PLAIN' }] } },
      // A bulleted list.
      { guid: g(1, 4), type: 'TEXT', name: 'List', parentIndex: { guid: g(0, 1), position: 'c' }, size: { x: 100, y: 40 }, transform: at(0, 300), fillPaints: [paint(0, 0, 0)], fontSize: 14, fontName: { family: 'Inter', style: 'Regular' }, textData: { characters: 'One\nTwo', lines: [{ lineType: 'UNORDERED_LIST' }, { lineType: 'UNORDERED_LIST' }] } },
      // FigJam: a sticky note with its words, and a connector drawn by its outline.
      { guid: g(1, 5), type: 'STICKY', name: 'Note', parentIndex: { guid: g(0, 1), position: 'd' }, size: { x: 200, y: 200 }, transform: at(400, 0), fillPaints: [paint(1, 0.9, 0.5)], fontSize: 16, fontName: { family: 'Inter', style: 'Medium' }, textData: { characters: 'Remember this' } },
      { guid: g(1, 6), type: 'CONNECTOR', name: 'Arrow', parentIndex: { guid: g(0, 1), position: 'e' }, size: { x: 100, y: 2 }, transform: at(400, 300), strokePaints: [paint(0, 0, 1)], strokeGeometry: [{ commandsBlob: 0 }] },
      // Components: a chip, a pair of chips, and an icon drawn at 24 whose shape scales.
      { guid: g(3, 1), type: 'SYMBOL', name: 'Chip', parentIndex: { guid: g(0, 1), position: 'f' }, size: { x: 80, y: 30 }, transform: at(0, 600) },
      { guid: g(3, 2), type: 'ROUNDED_RECTANGLE', name: 'Bg', parentIndex: { guid: g(3, 1), position: 'a' }, size: { x: 80, y: 30 }, transform: at(0, 0), fillPaints: [paint(1, 0, 0)], strokePaints: [paint(0, 0, 0)], strokeWeight: 1, horizontalConstraint: 'MIN', verticalConstraint: 'MIN' },
      { guid: g(3, 10), type: 'TEXT', name: 'Chip label', parentIndex: { guid: g(3, 1), position: 'b' }, size: { x: 60, y: 15 }, transform: at(10, 8), fillPaints: [paint(0, 0, 0)], fontSize: 12, fontName: { family: 'Inter', style: 'Regular' }, textData: { characters: 'Chip' }, horizontalConstraint: 'MIN', verticalConstraint: 'MIN' },
      // A chip shrunk to half with the scale tool: everything in it is half, its stroke and type included.
      { guid: g(3, 11), type: 'INSTANCE', name: 'Half chip', parentIndex: { guid: g(0, 1), position: 'm' }, size: { x: 40, y: 15 }, transform: at(0, 1100), symbolData: { symbolID: g(3, 1) } },
      { guid: g(3, 3), type: 'SYMBOL', name: 'Pair', parentIndex: { guid: g(0, 1), position: 'g' }, size: { x: 200, y: 40 }, transform: at(0, 700) },
      { guid: g(3, 4), type: 'INSTANCE', name: 'Inner', parentIndex: { guid: g(3, 3), position: 'a' }, size: { x: 80, y: 30 }, transform: at(0, 0), symbolData: { symbolID: g(3, 1) } },
      { guid: g(3, 7), type: 'SYMBOL', name: 'Icon', parentIndex: { guid: g(0, 1), position: 'h' }, size: { x: 24, y: 24 }, transform: at(300, 600) },
      { guid: g(3, 8), type: 'ROUNDED_RECTANGLE', name: 'Shape', parentIndex: { guid: g(3, 7), position: 'a' }, size: { x: 20, y: 20 }, transform: at(2, 2), fillPaints: [paint(0, 0, 0)], horizontalConstraint: 'SCALE', verticalConstraint: 'SCALE' },
      // A chip with its background renamed, its stroke heavier, a size of its own and out of the flow; a pair whose inner chip is blue; the icon placed at 12.
      { guid: g(3, 5), type: 'INSTANCE', name: 'Chip copy', parentIndex: { guid: g(0, 1), position: 'i' }, size: { x: 80, y: 30 }, transform: at(0, 800), symbolData: { symbolID: g(3, 1), symbolOverrides: [{ guidPath: { guids: [g(3, 2)] }, name: 'Background', strokeWeight: 3, size: { x: 60, y: 20 }, stackPositioning: 'ABSOLUTE', borderStrokeWeightsIndependent: true, borderTopWeight: 5 }] } },
      { guid: g(3, 6), type: 'INSTANCE', name: 'Pair copy', parentIndex: { guid: g(0, 1), position: 'j' }, size: { x: 200, y: 40 }, transform: at(0, 900), symbolData: { symbolID: g(3, 3), symbolOverrides: [{ guidPath: { guids: [g(3, 4), g(3, 2)] }, fillPaints: [paint(0, 0, 1)] }] } },
      // A chip flipped left to right, which cannot be shown mirrored here.
      { guid: g(3, 15), type: 'INSTANCE', name: 'Mirrored chip', parentIndex: { guid: g(0, 1), position: 'n' }, size: { x: 80, y: 30 }, transform: { m00: -1, m01: 0, m02: 280, m10: 0, m11: 1, m12: 1200 }, symbolData: { symbolID: g(3, 1) } },
      // A card holding the icon at 48, stretching across it; one of its instances twice as wide.
      { guid: g(3, 12), type: 'SYMBOL', name: 'Icon card', parentIndex: { guid: g(0, 1), position: 'o' }, size: { x: 100, y: 50 }, transform: at(400, 600) },
      { guid: g(3, 13), type: 'INSTANCE', name: 'Card icon', parentIndex: { guid: g(3, 12), position: 'a' }, size: { x: 48, y: 48 }, transform: at(2, 1), symbolData: { symbolID: g(3, 7) }, horizontalConstraint: 'STRETCH', verticalConstraint: 'MIN' },
      { guid: g(3, 14), type: 'INSTANCE', name: 'Wide card', parentIndex: { guid: g(0, 1), position: 'p' }, size: { x: 200, y: 50 }, transform: at(400, 800), symbolData: { symbolID: g(3, 12) } },
      { guid: g(3, 9), type: 'INSTANCE', name: 'Small icon', parentIndex: { guid: g(0, 1), position: 'k' }, size: { x: 12, y: 12 }, transform: at(300, 800), symbolData: { symbolID: g(3, 7) } },
    ];
    const file = await figma(changes, [outline(1, [0, 0], 2, [100, 0], 2, [100, 2], 2, [0, 2], 0)], { compress: 'zstd', schema: RICH, zip: [{ name: `images/${toHex(sha1(PNG))}`, bytes: PNG }] });
    const read = await readFig(file, 'Rich', env);
    const doc = read.doc;
    const layers = byName(doc);
    const collectionId = Object.keys(doc.variableCollections)[0] as string;
    const variable = (name: string): string => Object.keys(doc.variables).find((id) => doc.variables[id]?.name === name) as string;

    // The card: a line along the bottom, its grids and the style of them, a guide, exports, sizes, a binding, a mode, scrolling and an overlay's settings.
    const card = layers.get('Card') as FrameNode;
    expect(card.strokeSides).toEqual({ top: 0, right: 0, bottom: 4, left: 0 });
    // Its grids are its style's; the flipped frame below has rows of its own.
    expect((layers.get('Flipped') as FrameNode).layoutGrids).toMatchObject([{ pattern: 'ROWS', count: 3, offset: 8, sectionSize: 24, gutter: 12, alignment: 'MIN', opacity: 0.25 }]);
    const gridStyle = Object.values(doc.styles).find((style) => style.type === 'GRID');
    expect(gridStyle).toMatchObject({ name: 'Columns', grids: [{ pattern: 'COLUMNS', count: 12, gutter: 20 }] });
    expect(card.styleRefs.grids).toBe(gridStyle!.id);
    expect(card.layoutGrids).toEqual(gridStyle!.grids);
    expect(card.guides).toEqual([{ axis: 'Y', position: 20 }]);
    expect(card.exportSettings).toMatchObject([{ format: 'PNG', constraint: { type: 'SCALE', value: 2 }, suffix: '@2x' }, { format: 'SVG' }]);
    expect(card).toMatchObject({ minWidth: 50, minHeight: 20, maxWidth: 400, maxHeight: 300, overflow: 'VERTICAL', overlayPosition: 'TOP_CENTER', overlayCloseOutside: true, overlayBackground: { color: { r: 0, g: 0, b: 0 }, opacity: 0.5 } });
    expect(card.boundVariables).toEqual({ cornerRadius: variable('gap') });
    expect(card.cornerRadius).toBe(8);
    expect(card.variableModes).toEqual({ [collectionId]: doc.variableCollections[collectionId]!.modes[0]!.id });

    // Its logic: a key that counts, and a click that decides.
    expect(card.reactions).toMatchObject([
      { trigger: { type: 'ON_KEY', key: 'ArrowRight' }, actions: [{ type: 'SET_VARIABLE', variableId: variable('count'), expression: '({count} + 1)' }] },
      { trigger: { type: 'ON_CLICK' }, actions: [{ type: 'CONDITIONAL', expression: '({count} > 2)', then: [{ type: 'OPEN_LINK', expression: 'https://example.com/more' }], otherwise: [{ type: 'SET_VARIABLE', expression: '0' }] }] },
    ]);

    // The flipped frame is kept upright with its bar at the bottom, as Figma shows it, and its rounded corner is at the bottom too.
    expect(layers.get('Flipped')).toMatchObject({ x: 0, y: 200, width: 100, height: 50, rotation: 0, cornerRadii: [0, 0, 0, 12] });
    expect(layers.get('Top bar')).toMatchObject({ x: 0, y: 40, width: 100, height: 10 });

    // A list, a sticky note with its words in it, and a connector drawn by its outline in its stroke's colour.
    expect(layers.get('List')).toMatchObject({ type: 'TEXT', listType: 'BULLETED' });
    const note = layers.get('Note') as FrameNode;
    expect(note).toMatchObject({ type: 'FRAME', width: 200, height: 200 });
    expect(getChildIds(doc, note.id).map((id) => doc.nodes[id])).toMatchObject([{ type: 'TEXT', characters: 'Remember this', fontWeight: 500 }]);
    const arrow = layers.get('Arrow') as VectorNode;
    expect(arrow).toMatchObject({ type: 'VECTOR', strokes: [], fills: [{ color: BLUE }] });
    expect(arrow.network.vertices).toHaveLength(4);

    // Changes inside instances: a name, a stroke, its sides, a size and its place in the flow; and one inside an instance inside.
    const chip = layers.get('Chip copy') as FrameNode;
    expect(getLayer(doc, getChildIds(doc, chip.id)[0] as NodeId)).toMatchObject({ name: 'Background', strokeWeight: 3, strokeSides: { top: 5, right: 3, bottom: 3, left: 3 }, width: 60, height: 20, layoutPositioning: 'ABSOLUTE' });
    const pair = layers.get('Pair copy') as FrameNode;
    const inner = getLayer(doc, getChildIds(doc, pair.id)[0] as NodeId) as FrameNode;
    expect((getLayer(doc, getChildIds(doc, inner.id)[0] as NodeId)!.fills[0] as SolidPaint).color).toEqual(BLUE);
    // The component itself is as it was.
    expect((layers.get('Bg')!.fills[0] as SolidPaint).color).toEqual(RED);

    // The icon drawn at 24 and placed at 12 has its shape scaled by its constraints.
    const icon = layers.get('Small icon') as FrameNode;
    expect(getLayer(doc, getChildIds(doc, icon.id)[0] as NodeId)).toMatchObject({ x: 1, y: 1, width: 10, height: 10 });

    // The chip shrunk with the scale tool.
    const half = layers.get('Half chip') as FrameNode;
    const [halfBg, halfLabel] = getChildIds(doc, half.id).map((id) => getLayer(doc, id) as LayerNode);
    expect(halfBg).toMatchObject({ x: 0, y: 0, width: 40, height: 15, strokeWeight: 0.5 });
    expect(halfLabel).toMatchObject({ x: 5, y: 4, fontSize: 6 });
    // And it stays so after the component is changed.
    const recoloured = restoreLayout(doc, patchNode(doc, layers.get('Bg')!.id, { opacity: 0.5 }), approximateMeasurer);
    expect(getLayer(recoloured, halfBg!.id)).toMatchObject({ width: 40, strokeWeight: 0.5, opacity: 0.5 });
    expect(getLayer(recoloured, halfLabel!.id)).toMatchObject({ fontSize: 6 });

    // Turned over: the flipped frame's heavy top side is at its bottom, a shape's gradient runs the other way, and an
    // arc from 0° to 90° runs from 270° to 360°.
    expect((layers.get('Flipped') as FrameNode).strokeSides).toEqual({ top: 0, right: 0, bottom: 3, left: 0 });
    const upright = layers.get('Upright')!.fills[0] as GradientPaint;
    const over = layers.get('Turned over')!.fills[0] as GradientPaint;
    expect(over.from.y).toBeCloseTo(1 - upright.from.y, 5);
    expect(over.to.y).toBeCloseTo(1 - upright.to.y, 5);
    const quarter = layers.get('Quarter') as LayerNode & { arcStart: number; arcSweep: number };
    expect(quarter.arcStart).toBeCloseTo(270, 4);
    expect(quarter.arcSweep).toBeCloseTo(90, 4);
    // A list in only some paragraphs is plain text here; text with double quotes is set in single ones.
    expect(layers.get('Half list')).toMatchObject({ listType: 'NONE' });
    expect((layers.get('Flipped') as FrameNode).reactions).toMatchObject([{ actions: [{ type: 'SET_VARIABLE', variableId: variable('label'), expression: `'He said "hi"'` }] }]);
    // A flipped instance is shown unflipped where it was, not upside down.
    expect(layers.get('Mirrored chip')).toMatchObject({ x: 200, y: 1200, rotation: 0 });
    // The icon in the wide card: stretched with the card, and its shape scaled from the icon's 24 to its 148 × 48.
    const wide = layers.get('Wide card') as FrameNode;
    const cardIcon = getLayer(doc, getChildIds(doc, wide.id)[0] as NodeId) as FrameNode;
    expect(cardIcon).toMatchObject({ x: 2, width: 148, height: 48 });
    const shape = getLayer(doc, getChildIds(doc, cardIcon.id)[0] as NodeId)!;
    expect(shape.x).toBeCloseTo((2 * 148) / 24, 3);
    expect(shape.width).toBeCloseTo((20 * 148) / 24, 3);
    expect(shape).toMatchObject({ y: 4, height: 40 });

    // The page's prototype is shown on a phone; the video by its first frame.
    expect(getPages(doc)[0]?.prototypeDevice).toBe('PHONE');
    const clip = layers.get('Clip')!;
    expect(clip.fills).toMatchObject([{ type: 'IMAGE', scaleMode: 'FILL' }]);
    expect(Object.keys(read.images)).toHaveLength(1);

    expect(read.notConverted.sort()).toEqual(
      [
        'Flipped components and instances (shown unflipped): 1',
        'Layers of the kind “CONNECTOR” (kept as vectors of their outline): 1',
        'Layers of the kind “STICKY” (kept as frames): 1',
        'Lists in only some paragraphs of a text, or of both kinds (shown as plain text): 1',
        'Video fills (shown as their first frame): 1',
      ].sort(),
    );
  });

  it('stores a vector network as Figma does, and reads it at another size', () => {
    const network = { vertices: [{ x: 1, y: 2 }, { x: 3, y: 4 }, { x: 5, y: 0 }], segments: [{ start: 0, end: 1, tangentStart: { x: 0.5, y: 0 }, tangentEnd: { x: 0, y: -0.5 } }, { start: 1, end: 2, tangentStart: { x: 0, y: 0 }, tangentEnd: { x: 0, y: 0 } }] };
    const blob = writeVectorBlob(network);
    expect(blob.length).toBe(12 + 3 * 12 + 2 * 28);
    expect(readVectorBlob(blob, 1, 1)).toEqual(network);
    expect(readVectorBlob(blob, 2, 1).vertices[2]).toEqual({ x: 10, y: 0 });
    expect(toHex(sha1(new TextEncoder().encode('abc')))).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
  });
});
