import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import {
  addLayer,
  base64ToBytes,
  bytesToBase64,
  createDocument,
  CURRENT_SCHEMA_VERSION,
  getChildIds,
  getLayer,
  getPages,
  imagePaint,
  imagePlacement,
  nameFromFile,
  parseFile,
  patchNode,
  referencedAssetHashes,
  repairDocument,
  sha256Hex,
  validateDocument,
  type Document,
  type ImagePaint,
  type LayerNode,
  type NodeId,
} from './core';
import { ImageCache, type AssetBytes, type DecodedImage } from './engine/images/imageCache';
import { renderScene } from './engine/render/scene';
import { exportFileText, importFileText, openFile, saveDocument } from './persistence/files';
import { IndexedDbStorage } from './persistence/indexedDbStorage';
import { MemoryStorage } from './persistence/storage';
import { createEditorStore } from './state/editorStore';
import { imageTypeOf, importImageFiles, placeImages, type ImageFile } from './state/images';
import { withCrop } from './ui/panels/PaintList';

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

/** A stand-in for an image file: its "pixels" are text, and its size is written in the first line. */
function fakeFile(name: string, width: number, height: number, type = 'image/png'): ImageFile {
  const bytes = text(`${width}x${height}\n${name}`);
  return { name, type, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer };
}

/** Decodes the stand-in files above; rejects anything else, as a real decoder rejects non-images. */
async function fakeDecode(asset: AssetBytes): Promise<DecodedImage> {
  const match = /^(\d+)x(\d+)\n/.exec(new TextDecoder().decode(asset.bytes));
  if (!match) throw new Error('not an image');
  return { image: { tag: 'decoded' } as unknown as CanvasImageSource, width: Number(match[1]), height: Number(match[2]) };
}

function setup(): { doc: Document; pageId: NodeId } {
  const doc = createDocument('Images');
  return { doc, pageId: (getPages(doc)[0] as { id: NodeId }).id };
}

describe('hashing and encoding', () => {
  it('computes SHA-256 in hex', async () => {
    expect(await sha256Hex(text('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(await sha256Hex(new Uint8Array(0))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(await sha256Hex(text('abc').buffer as ArrayBuffer)).toBe(await sha256Hex(text('abc')));
  });

  it('round-trips bytes through base64 at every padding length', () => {
    expect(bytesToBase64(text(''))).toBe('');
    expect(bytesToBase64(text('f'))).toBe('Zg==');
    expect(bytesToBase64(text('fo'))).toBe('Zm8=');
    expect(bytesToBase64(text('foo'))).toBe('Zm9v');
    expect(bytesToBase64(text('foobar'))).toBe('Zm9vYmFy');
    const all = new Uint8Array(256).map((_, i) => i);
    expect(base64ToBytes(bytesToBase64(all))).toEqual(all);
    for (const length of [1, 2, 3, 4, 5]) {
      const bytes = all.slice(0, length);
      expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
    }
  });

  it('refuses text that is not base64', () => {
    expect(base64ToBytes('Zm9')).toBeNull();
    expect(base64ToBytes('Zm9v!A==')).toBeNull();
    expect(base64ToBytes('=m9v')).toBeNull();
  });

  it('names a layer after its file', () => {
    expect(nameFromFile('holiday photo.final.JPG')).toBe('holiday photo.final');
    expect(nameFromFile('logo')).toBe('logo');
    expect(nameFromFile('.png')).toBe('Image');
  });

  it('recognises image files by type or, failing that, by extension', () => {
    expect(imageTypeOf({ name: 'a.bin', type: 'image/webp' })).toBe('image/webp');
    expect(imageTypeOf({ name: 'Photo.JPEG', type: '' })).toBe('image/jpeg');
    expect(imageTypeOf({ name: 'icon.svg', type: '' })).toBe('image/svg+xml');
    expect(imageTypeOf({ name: 'notes.txt', type: 'text/plain' })).toBeNull();
    expect(imageTypeOf({ name: 'photo.bmp', type: 'image/bmp' })).toBeNull();
  });
});

describe('image placement in a box', () => {
  const crop = { x: 0, y: 0, width: 1, height: 1 };

  it('FILL covers the box and lets the overflow be cropped', () => {
    expect(imagePlacement('FILL', 200, 100, 100, 100, crop)).toEqual({
      source: { x: 0, y: 0, width: 200, height: 100 },
      target: { x: -50, y: 0, width: 200, height: 100 },
    });
    expect(imagePlacement('FILL', 100, 100, 300, 100, crop)?.target).toEqual({ x: 0, y: -100, width: 300, height: 300 });
  });

  it('FIT shows the whole image inside the box', () => {
    expect(imagePlacement('FIT', 200, 100, 100, 100, crop)?.target).toEqual({ x: 0, y: 25, width: 100, height: 50 });
    expect(imagePlacement('FIT', 100, 200, 100, 100, crop)?.target).toEqual({ x: 25, y: 0, width: 50, height: 100 });
  });

  it('CROP stretches the chosen part over the box', () => {
    expect(imagePlacement('CROP', 200, 100, 80, 80, { x: 0.5, y: 0, width: 0.5, height: 1 })).toEqual({
      source: { x: 100, y: 0, width: 100, height: 100 },
      target: { x: 0, y: 0, width: 80, height: 80 },
    });
  });

  it('has no single placement for tiles or for empty boxes and images', () => {
    expect(imagePlacement('TILE', 200, 100, 100, 100, crop)).toBeNull();
    expect(imagePlacement('FILL', 0, 100, 100, 100, crop)).toBeNull();
    expect(imagePlacement('FILL', 200, 100, 0, 100, crop)).toBeNull();
  });

  it('keeps a crop inside the image when one side is changed', () => {
    const paint = imagePaint('a'.repeat(64));
    expect(withCrop(paint, { x: 0.5 }).crop).toEqual({ x: 0.5, y: 0, width: 0.5, height: 1 });
    expect(withCrop(paint, { width: 0.25, height: 0.5 }).crop).toEqual({ x: 0, y: 0, width: 0.25, height: 0.5 });
    expect(withCrop(withCrop(paint, { x: 0.8 }), { width: 0.9 }).crop).toMatchObject({ x: 0.8, width: 0.2 });
    expect(withCrop(paint, { x: 5, width: -1 }).crop).toMatchObject({ x: 0.99, width: 0.01 });
  });
});

describe('image paints in the document', () => {
  const hash = 'c'.repeat(64);

  it('accepts a valid image paint and asset table', () => {
    const { doc, pageId } = setup();
    const withAsset: Document = { ...doc, assets: { [hash]: { mimeType: 'image/png', width: 200, height: 100, name: 'photo.png' } } };
    const rect = addLayer(withAsset, 'RECTANGLE', pageId, { fills: [imagePaint(hash)] });
    expect(validateDocument(rect.doc)).toEqual([]);
    expect(referencedAssetHashes(rect.doc)).toEqual([hash]);
    const twice = addLayer(rect.doc, 'ELLIPSE', pageId, { fills: [imagePaint(hash)], strokes: [imagePaint('d'.repeat(64))] });
    expect(referencedAssetHashes(twice.doc).sort()).toEqual([hash, 'd'.repeat(64)]);
  });

  it('repairs broken image paints and asset tables', () => {
    const { doc, pageId } = setup();
    const rect = addLayer(doc, 'RECTANGLE', pageId);
    const data = JSON.parse(JSON.stringify(rect.doc)) as { nodes: Record<string, Record<string, unknown>>; assets: unknown };
    (data.nodes[rect.id] as Record<string, unknown>).fills = [
      { type: 'IMAGE', imageHash: hash, scaleMode: 'STRETCHY', crop: { x: 0.9, y: -1, width: 5, height: 0 }, tileScale: 0, opacity: 1, visible: true },
      { type: 'IMAGE', imageHash: 'not-a-hash', scaleMode: 'FILL', opacity: 1, visible: true },
    ];
    data.assets = {
      [hash]: { mimeType: 'image/png', width: -5, height: 'tall', name: 7 },
      'bad key': { mimeType: 'image/png', width: 1, height: 1, name: 'x' },
      ['e'.repeat(64)]: 'nonsense',
    };
    const repaired = repairDocument(data);
    const fills = (repaired.doc.nodes[rect.id] as LayerNode).fills as ImagePaint[];
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ imageHash: hash, scaleMode: 'FILL', tileScale: 0.01 });
    expect(fills[0]?.crop.x).toBe(0.9);
    expect(fills[0]?.crop.y).toBe(0);
    expect(fills[0]?.crop.width).toBeCloseTo(0.1);
    expect(fills[0]?.crop.height).toBe(0.001);
    expect(repaired.doc.assets).toEqual({ [hash]: { mimeType: 'image/png', width: 1, height: 1, name: 'Image' } });
    expect(repaired.repairs.join(' ')).toContain('image assets');
  });

  it('opens a version 4 file with an empty asset table', () => {
    const { doc, pageId } = setup();
    const rect = addLayer(doc, 'RECTANGLE', pageId);
    // A version 4 document is a current one without the asset table.
    const { assets: _unused, ...v4Document } = rect.doc;
    void _unused;
    const parsed = parseFile({
      format: 'open-design',
      schemaVersion: 4,
      meta: { createdAt: '2026-11-15T16:00:00.000Z', updatedAt: '2026-11-15T16:00:00.000Z' },
      document: JSON.parse(JSON.stringify(v4Document)),
    });
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(5);
    expect(parsed.file.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(parsed.repairs).toEqual([]);
    expect(parsed.file.document.assets).toEqual({});
    expect(parsed.file.document.nodes).toEqual(rect.doc.nodes);
  });
});

describe('image cache', () => {
  it('fetches and decodes in the background and tells listeners when an image is ready', async () => {
    const file = fakeFile('a.png', 40, 30);
    const bytes = await file.arrayBuffer();
    let loads = 0;
    const cache = new ImageCache(async (hash) => {
      loads++;
      return hash === 'known' ? { mimeType: 'image/png', bytes } : null;
    }, fakeDecode);
    let notified = 0;
    const stop = cache.onChange(() => notified++);

    expect(cache.get('known')).toBeNull();
    expect(cache.get('known')).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(loads).toBe(1);
    expect(notified).toBe(1);
    expect(cache.get('known')).toMatchObject({ width: 40, height: 30 });
    expect(cache.isMissing('known')).toBe(false);

    expect(cache.get('gone')).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(cache.isMissing('gone')).toBe(true);
    expect(notified).toBe(2);

    stop();
    await cache.put('fresh', { mimeType: 'image/png', bytes });
    expect(notified).toBe(2);
    expect(cache.get('fresh')).toMatchObject({ width: 40, height: 30 });
  });

  it('treats bytes that will not decode as missing', async () => {
    const cache = new ImageCache(async () => ({ mimeType: 'image/png', bytes: text('garbage').buffer as ArrayBuffer }), fakeDecode);
    cache.get('broken');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(cache.isMissing('broken')).toBe(true);
    await expect(cache.put('also-broken', { mimeType: 'image/png', bytes: text('garbage').buffer as ArrayBuffer })).rejects.toThrow();
  });
});

describe('placing images', () => {
  async function editor() {
    const storage = new MemoryStorage();
    const images = new ImageCache((hash) => storage.loadAsset(hash), fakeDecode);
    const store = createEditorStore(createDocument('Place'));
    store.getState().setCanvasSize({ width: 800, height: 600 });
    return { storage, images, store };
  }

  it('imports files as assets and places them as image-filled rectangles, in one undo step', async () => {
    const { storage, images, store } = await editor();
    const { imported, failed } = await importImageFiles(storage, images, [fakeFile('photo.png', 200, 100), fakeFile('notes.txt', 1, 1, 'text/plain')]);
    expect(failed).toBe(1);
    expect(imported).toHaveLength(1);
    const { hash, info } = imported[0]!;
    expect(info).toEqual({ mimeType: 'image/png', width: 200, height: 100, name: 'photo.png' });
    expect(await storage.loadAsset(hash)).not.toBeNull();

    const [id] = placeImages(store, imported) as [NodeId];
    const state = store.getState();
    // Natural size, centred in the 800 × 600 view.
    expect(getLayer(state.doc, id)).toMatchObject({ type: 'RECTANGLE', name: 'photo', x: 300, y: 250, width: 200, height: 100 });
    expect((getLayer(state.doc, id) as LayerNode).fills).toEqual([imagePaint(hash)]);
    expect(state.doc.assets[hash]).toEqual(info);
    expect(state.selection).toEqual([id]);
    expect(state.undoStack.map((entry) => entry.label)).toEqual(['Place image']);

    state.undo();
    expect(getChildIds(store.getState().doc, store.getState().pageId)).toEqual([]);
    // The asset stays known, so redo (or placing it again) still finds it.
    expect(store.getState().doc.assets[hash]).toEqual(info);
    store.getState().redo();
    expect(getLayer(store.getState().doc, id)).toBeDefined();
  });

  it('scales an image down to fit the view and never up', async () => {
    const { storage, images, store } = await editor();
    const { imported } = await importImageFiles(storage, images, [fakeFile('huge.png', 4000, 1000), fakeFile('tiny.png', 10, 10)]);
    const [huge, tiny] = placeImages(store, imported) as [NodeId, NodeId];
    // 80% of an 800px-wide view is 640px.
    expect(getLayer(store.getState().doc, huge)).toMatchObject({ width: 640, height: 160 });
    expect(getLayer(store.getState().doc, tiny)).toMatchObject({ width: 10, height: 10 });
    expect(store.getState().undoStack.map((entry) => entry.label)).toEqual(['Place images']);
  });

  it('places a dropped image where it was dropped, inside the frame under it', async () => {
    const { storage, images, store } = await editor();
    const frame = addLayer(store.getState().doc, 'FRAME', store.getState().pageId, { x: 100, y: 100, width: 400, height: 300 });
    store.getState().apply('Add frame', () => frame.doc);
    const { imported } = await importImageFiles(storage, images, [fakeFile('drop.png', 100, 50)]);
    const [id] = placeImages(store, imported, { x: 300, y: 250 }) as [NodeId];
    expect(getLayer(store.getState().doc, id)).toMatchObject({ parentId: frame.id, x: 150, y: 125, width: 100, height: 50 });
  });

  it('stores the same bytes once, whatever the file is called', async () => {
    const { storage, images, store } = await editor();
    const same = (name: string): ImageFile => ({ ...fakeFile('x.png', 20, 20), name });
    const { imported } = await importImageFiles(storage, images, [same('first.png'), same('second.png')]);
    expect(imported[0]?.hash).toBe(imported[1]?.hash);
    placeImages(store, imported);
    expect(Object.keys(store.getState().doc.assets)).toHaveLength(1);
  });
});

describe('images in exported files', () => {
  async function documentWithImage() {
    const storage = new MemoryStorage();
    const images = new ImageCache((hash) => storage.loadAsset(hash), fakeDecode);
    const store = createEditorStore(createDocument('With image'));
    const { imported } = await importImageFiles(storage, images, [fakeFile('photo.png', 200, 100)]);
    placeImages(store, imported);
    const doc = store.getState().doc;
    const meta = await saveDocument(storage, doc, '2026-11-15T16:00:00.000Z');
    return { storage, doc, meta, hash: imported[0]!.hash };
  }

  it('bundles the images a document uses and restores them on another device', async () => {
    const { storage, doc, meta, hash } = await documentWithImage();
    const exported = await exportFileText(storage, doc, meta);
    const parsed = JSON.parse(exported) as { assetData: Record<string, string> };
    expect(Object.keys(parsed.assetData)).toEqual([hash]);

    const other = new MemoryStorage();
    const { id, repairs } = await importFileText(other, exported);
    expect(repairs).toEqual([]);
    const original = await storage.loadAsset(hash);
    const restored = await other.loadAsset(hash);
    expect(restored?.mimeType).toBe('image/png');
    expect(new Uint8Array(restored!.bytes)).toEqual(new Uint8Array(original!.bytes));
    const opened = await openFile(other, id);
    expect(opened?.doc.nodes).toEqual(doc.nodes);
    expect(opened?.doc.assets).toEqual(doc.assets);
    // What is stored locally never carries the image bytes inside the document.
    expect(JSON.stringify(await other.load(id))).not.toContain('assetData');
  });

  it('does not bundle assets no layer uses, and writes no asset section when there are none', async () => {
    const { storage, doc, meta, hash } = await documentWithImage();
    const layerId = Object.keys(doc.nodes).find((id) => doc.nodes[id]?.type === 'RECTANGLE') as NodeId;
    const unused = patchNode(doc, layerId, { fills: [] });
    expect(unused.assets[hash]).toBeDefined();
    expect(await exportFileText(storage, unused, meta)).not.toContain('assetData');
  });

  it('refuses image bytes that do not match their hash', async () => {
    const { storage, doc, meta, hash } = await documentWithImage();
    const exported = JSON.parse(await exportFileText(storage, doc, meta)) as { assetData: Record<string, string> };
    exported.assetData[hash] = bytesToBase64(text('200x100\nsomething else entirely'));
    const other = new MemoryStorage();
    const { repairs } = await importFileText(other, JSON.stringify(exported));
    expect(await other.loadAsset(hash)).toBeNull();
    expect(repairs.join(' ')).toContain('damaged');
    expect(repairs.join(' ')).toContain('missing');
  });

  it('reports images that the file does not carry', async () => {
    const { storage, doc, meta } = await documentWithImage();
    const exported = JSON.parse(await exportFileText(storage, doc, meta)) as Record<string, unknown>;
    delete exported.assetData;
    const { repairs } = await importFileText(new MemoryStorage(), JSON.stringify(exported));
    expect(repairs).toEqual(['1 image(s) used by the file are missing; those layers show a placeholder.']);
    // On a device that already has the image, nothing is missing.
    expect((await importFileText(storage, JSON.stringify(exported))).repairs).toEqual([]);
  });
});

describe('asset storage in IndexedDB', () => {
  it('stores and returns image bytes, and survives reopening the database', async () => {
    const name = `open-design-assets-${Math.random()}`;
    const first = new IndexedDbStorage(indexedDB, name);
    const bytes = text('200x100\nphoto');
    expect(await first.loadAsset('abc')).toBeNull();
    await first.saveAsset('abc', { mimeType: 'image/png', bytes: bytes.buffer as ArrayBuffer });
    await first.close();

    const second = new IndexedDbStorage(indexedDB, name);
    const loaded = await second.loadAsset('abc');
    expect(loaded?.mimeType).toBe('image/png');
    expect(new Uint8Array(loaded!.bytes)).toEqual(bytes);
    await second.close();
  });
});

describe('rendering image fills', () => {
  function recorder(): { ctx: CanvasRenderingContext2D; calls: unknown[][] } {
    const calls: unknown[][] = [];
    const target: Record<string, unknown> = { globalAlpha: 1 };
    const ctx = new Proxy(target, {
      get(obj, prop: string) {
        if (prop in obj) return obj[prop];
        if (prop === 'createPattern') return () => ({ tag: 'pattern' });
        return (...args: unknown[]) => {
          if (prop === 'drawImage' || prop === 'fillRect' || prop === 'scale') calls.push([prop, ...args]);
        };
      },
      set(obj, prop: string, value) {
        obj[prop] = value;
        if (prop === 'fillStyle') calls.push(['fillStyle', value]);
        return true;
      },
    }) as unknown as CanvasRenderingContext2D;
    return { ctx, calls };
  }

  const view = { size: { width: 400, height: 300 }, dpr: 1, viewport: { x: 0, y: 0, zoom: 1 }, background: false };
  const hash = 'f'.repeat(64);
  const decoded = { image: { tag: 'image' } as unknown as CanvasImageSource, width: 200, height: 100 };

  function scene(paint: ImagePaint): { doc: Document; pageId: NodeId } {
    const { doc, pageId } = setup();
    return { doc: addLayer(doc, 'RECTANGLE', pageId, { x: 0, y: 0, width: 100, height: 100, fills: [paint] }).doc, pageId };
  }

  it('draws the image where the fit mode puts it', () => {
    const { doc, pageId } = scene(imagePaint(hash));
    const { ctx, calls } = recorder();
    renderScene(ctx, doc, pageId, { ...view, images: { get: () => decoded } });
    expect(calls.filter((call) => call[0] === 'drawImage')).toEqual([['drawImage', decoded.image, 0, 0, 200, 100, -50, 0, 200, 100]]);
  });

  it('tiles with a pattern scaled to the tile size', () => {
    const { doc, pageId } = scene({ ...imagePaint(hash), scaleMode: 'TILE', tileScale: 0.25 });
    const { ctx, calls } = recorder();
    renderScene(ctx, doc, pageId, { ...view, images: { get: () => decoded } });
    expect(calls).toContainEqual(['scale', 0.25, 0.25]);
    expect(calls).toContainEqual(['fillStyle', { tag: 'pattern' }]);
    expect(calls).toContainEqual(['fillRect', 0, 0, 400, 400]);
  });

  it('draws a placeholder until the image is available', () => {
    const { doc, pageId } = scene(imagePaint(hash));
    const { ctx, calls } = recorder();
    renderScene(ctx, doc, pageId, { ...view, images: { get: () => null } });
    expect(calls.some((call) => call[0] === 'drawImage')).toBe(false);
    expect(calls).toContainEqual(['fillRect', 0, 0, 100, 100]);
  });
});
