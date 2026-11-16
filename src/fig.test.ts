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
 * Figma `.fig` files. No file made by Figma is part of these tests: what is
 * known of the format comes from what can be worked out of such files, and
 * none was available here. So the tests check that what this application
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
    message TextData { string characters = 1; uint[] characterStyleIDs = 2; }
    message Paint { PaintType type = 1; Color color = 2; float opacity = 3; bool visible = 4; }
    message SymbolOverride { string note = 1; }
    message SymbolData { GUID symbolID = 1; SymbolOverride[] symbolOverrides = 2; }
    message VectorData { uint vectorNetworkBlob = 1; Vector normalizedSize = 2; }
    message Interaction { string kind = 1; }
    message NodeChange {
      string name = 100; GUID guid = 200; ParentIndex parentIndex = 300; NodeType type = 400;
      Vector size = 500; Matrix transform = 600; Paint[] fillPaints = 700; float opacity = 800;
      bool resizeToFit = 900; bool frameMaskDisabled = 901; TextData textData = 1000; float fontSize = 1001; FontName fontName = 1002;
      Number letterSpacing = 1003; Number lineHeight = 1004; SymbolData symbolData = 1100; VectorData vectorData = 1200;
      Interaction[] prototypeInteractions = 1300; string styleIdForFill = 1400; bool internalOnly = 1500; uint someFutureField = 9999;
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

  async function figma(nodeChanges: KiwiObject[], blobs: Uint8Array[], options: { compress: 'zstd' | 'deflate'; zip?: { name: string; bytes: Uint8Array }[] }): Promise<Uint8Array> {
    const schema = parseSchemaText(FOREIGN);
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
    { guid: g(1, 1), type: 'FRAME', name: 'Screen', parentIndex: { guid: g(0, 1), position: 'a' }, size: { x: 375, y: 812 }, transform: at(10, 20), fillPaints: [paint(1, 1, 1)], someFutureField: 7, prototypeInteractions: [{ kind: 'ON_CLICK' }] },
    { guid: g(1, 4), type: 'TEXT', name: 'Heading', parentIndex: { guid: g(1, 1), position: 'b' }, size: { x: 200, y: 30 }, transform: at(16, 40), fillPaints: [paint(0, 0, 0)], textData: { characters: 'Welcome', characterStyleIDs: [0, 0, 1] }, fontSize: 24, fontName: { family: 'Roboto', style: 'Semi Bold Italic' }, letterSpacing: { value: 10, units: 'PERCENT' }, lineHeight: { value: 150, units: 'PERCENT' }, styleIdForFill: 'S:abc' },
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
    // The vector's points, scaled from the size they were stored at to the layer's.
    const art = layers.get('Line art') as VectorNode;
    expect(art.network.vertices).toEqual([{ x: 0, y: 50 }, { x: 100, y: 0 }]);
    expect(art.network.segments[0]?.tangentStart).toEqual({ x: 20, y: 0 });
    // The instance's component is in a library, which the file does not hold.
    expect(layers.get('Library button')).toMatchObject({ kind: 'FRAME' });
    expect(read.notConverted.sort()).toEqual(
      [
        'Changes made inside instances (overrides): the instances show their component as it is: 1',
        'Components from libraries (kept in Figma on a hidden page): 1',
        'Image fills whose pictures are not in the file (a bare canvas.fig keeps none): 1',
        'Instances of components that are not in the file (they are left as empty frames): 1',
        'Layers of the kind “WIDGET”: 1',
        'Links to shared styles (layers keep the look the styles gave them): 1',
        'Paints of the kind “EMOJI”: 1',
        'Prototype connections: 1',
        'Slices: 1',
        'Text with parts in a style of their own (shown in the layer’s own style): 1',
      ].sort(),
    );
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

  it('stores a vector network as Figma does, and reads it at another size', () => {
    const network = { vertices: [{ x: 1, y: 2 }, { x: 3, y: 4 }, { x: 5, y: 0 }], segments: [{ start: 0, end: 1, tangentStart: { x: 0.5, y: 0 }, tangentEnd: { x: 0, y: -0.5 } }, { start: 1, end: 2, tangentStart: { x: 0, y: 0 }, tangentEnd: { x: 0, y: 0 } }] };
    const blob = writeVectorBlob(network);
    expect(blob.length).toBe(12 + 3 * 12 + 2 * 28);
    expect(readVectorBlob(blob, 1, 1)).toEqual(network);
    expect(readVectorBlob(blob, 2, 1).vertices[2]).toEqual({ x: 10, y: 0 });
    expect(toHex(sha1(new TextEncoder().encode('abc')))).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
  });
});
