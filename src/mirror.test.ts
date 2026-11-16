import { describe, expect, it } from 'vitest';
import {
  addLayer,
  approximateMeasurer,
  createDocument,
  CURRENT_SCHEMA_VERSION,
  flipNodes,
  getPages,
  gradientPaint,
  groupNodes,
  imagePaint,
  mirrorInPlace,
  parseFile,
  repairDocument,
  resizeFlips,
  rotatePoint,
  validateDocument,
  type Document,
  type FrameNode,
  type GradientPaint,
  type ImagePaint,
  type LayerNode,
  type LayerPatch,
  type LayerType,
  type NodeId,
  type TextNode,
} from './core';
import { InteractionController, type PointerInput } from './engine/input/controller';
import { dragCrop } from './engine/input/cropDrag';
import { renderScene } from './engine/render/scene';
import { createEditorStore, type EditorStore } from './state/editorStore';

/**
 * Mirrored text and image fills (schema version 14), and content that is
 * mirrored when a resize is dragged past the edge that stays fixed.
 */

const RED = { r: 1, g: 0, b: 0 };
const BLUE = { r: 0, g: 0, b: 1 };
const HASH = 'd'.repeat(64);
const ASSET = { [HASH]: { mimeType: 'image/png', width: 200, height: 100, name: 'photo.png' } };

function make(type: LayerType, props: LayerPatch): { doc: Document; id: NodeId; pageId: NodeId } {
  const doc: Document = { ...createDocument('Mirror'), assets: ASSET };
  const pageId = (getPages(doc)[0] as { id: NodeId }).id;
  const made = addLayer(doc, type, pageId, { x: 100, y: 100, width: 200, height: 100, ...props });
  return { doc: made.doc, id: made.id, pageId };
}

const layer = (doc: Document, id: NodeId): LayerNode => doc.nodes[id] as LayerNode;
const imageOf = (doc: Document, id: NodeId): ImagePaint => layer(doc, id).fills[0] as ImagePaint;
const gradientOf = (doc: Document, id: NodeId): GradientPaint => layer(doc, id).fills[0] as GradientPaint;
const ptr = (x: number, y: number, more: Partial<PointerInput> = {}): PointerInput => ({ x, y, button: 0, shiftKey: false, altKey: false, ctrlKey: false, detail: 1, ...more });

describe('flip marks text and image fills to be drawn mirrored', () => {
  it('turns the glyphs of text over, and back', () => {
    const { doc, id } = make('TEXT', { characters: 'Hello', fills: [gradientPaint('GRADIENT_LINEAR', RED, BLUE, 0)] });
    expect(layer(doc, id)).toMatchObject({ flipX: false, flipY: false });
    const across = flipNodes(doc, [id], 'horizontal');
    expect(layer(across, id)).toMatchObject({ flipX: true, flipY: false });
    expect(layer(flipNodes(doc, [id], 'vertical'), id)).toMatchObject({ flipX: false, flipY: true });
    // Mirrored text is drawn turned over as a whole, so what it is painted with is left as it is.
    expect(gradientOf(across, id)).toEqual(gradientOf(doc, id));
    expect(layer(flipNodes(across, [id], 'horizontal'), id)).toEqual(layer(doc, id));
  });

  it('turns the picture of an image fill over', () => {
    const { doc, id } = make('RECTANGLE', { fills: [imagePaint(HASH)] });
    expect(imageOf(doc, id)).toMatchObject({ flipX: false, flipY: false });
    expect(imageOf(flipNodes(doc, [id], 'horizontal'), id)).toMatchObject({ flipX: true, flipY: false });
    expect(imageOf(flipNodes(doc, [id], 'vertical'), id)).toMatchObject({ flipX: false, flipY: true });
    expect(imageOf(flipNodes(flipNodes(doc, [id], 'vertical'), [id], 'vertical'), id)).toEqual(imageOf(doc, id));
    // A triangle flipped top to bottom is given a half turn, which leaves its picture to be mirrored left to right.
    const triangle = make('POLYGON', { fills: [imagePaint(HASH)] });
    const down = flipNodes(triangle.doc, [triangle.id], 'vertical');
    expect(layer(down, triangle.id).rotation).toBe(180);
    expect(imageOf(down, triangle.id)).toMatchObject({ flipX: true, flipY: false });
  });

  it('moves the guides of a frame to the other side', () => {
    const { doc, id } = make('FRAME', {
      width: 400,
      height: 200,
      guides: [
        { axis: 'X', position: 100 },
        { axis: 'Y', position: 30 },
      ],
    });
    expect((flipNodes(doc, [id], 'horizontal').nodes[id] as FrameNode).guides).toEqual([
      { axis: 'X', position: 300 },
      { axis: 'Y', position: 30 },
    ]);
    expect((flipNodes(doc, [id], 'vertical').nodes[id] as FrameNode).guides).toEqual([
      { axis: 'X', position: 100 },
      { axis: 'Y', position: 170 },
    ]);
  });
});

describe('mirroring a layer about its own axis', () => {
  it('leaves the box where it is and turns over what is in it', () => {
    const { doc, id } = make('RECTANGLE', { rotation: 30, cornerRadii: [10, 0, 0, 0], fills: [gradientPaint('GRADIENT_LINEAR', RED, BLUE, 0)] });
    const mirrored = mirrorInPlace(doc, [id], 'horizontal');
    expect(layer(mirrored, id)).toMatchObject({ x: 100, y: 100, width: 200, height: 100, rotation: 30, cornerRadii: [0, 10, 0, 0] });
    expect(gradientOf(mirrored, id)).toMatchObject({ from: { x: 1, y: 0.5 }, to: { x: 0, y: 0.5 } });
    expect(mirrorInPlace(mirrored, [id], 'horizontal').nodes[id]).toEqual(doc.nodes[id]);
    // A triangle turned over top to bottom points the other way: a half turn.
    const triangle = make('POLYGON', { rotation: 20 });
    expect(layer(mirrorInPlace(triangle.doc, [triangle.id], 'vertical'), triangle.id)).toMatchObject({ x: 100, y: 100, rotation: -160 });
    expect(layer(mirrorInPlace(triangle.doc, [triangle.id], 'horizontal'), triangle.id).rotation).toBe(20);
  });

  it('changes the sides of what is inside a group or a frame', () => {
    const doc = createDocument('Mirror');
    const pageId = (getPages(doc)[0] as { id: NodeId }).id;
    const a = addLayer(doc, 'RECTANGLE', pageId, { x: 0, y: 0, width: 50, height: 50 });
    const b = addLayer(a.doc, 'TEXT', pageId, { x: 150, y: 10, width: 50, height: 24, characters: 'Hi', textAutoResize: 'NONE' });
    const grouped = groupNodes(b.doc, [a.id, b.id]) as { doc: Document; id: NodeId };
    const mirrored = mirrorInPlace(grouped.doc, [grouped.id], 'horizontal');
    expect(layer(mirrored, grouped.id)).toMatchObject({ x: 0, y: 0, width: 200 });
    expect(layer(mirrored, a.id).x).toBe(150);
    expect(layer(mirrored, b.id)).toMatchObject({ x: 0, flipX: true });
  });
});

describe('a resize dragged past the edge that stays fixed', () => {
  const box = { x: 100, y: 100, width: 200, height: 100, rotation: 0 };

  it('is known to have crossed, on each axis of the box', () => {
    const right = { hx: 1, hy: 0 } as const;
    expect(resizeFlips(box, right, { x: 350, y: 150 })).toEqual({ x: false, y: false });
    expect(resizeFlips(box, right, { x: 50, y: 150 })).toEqual({ x: true, y: false });
    expect(resizeFlips(box, { hx: -1, hy: 0 }, { x: 350, y: 150 })).toEqual({ x: true, y: false });
    expect(resizeFlips(box, { hx: 1, hy: 1 }, { x: 50, y: 50 })).toEqual({ x: true, y: true });
    expect(resizeFlips(box, { hx: 0, hy: -1 }, { x: 150, y: 250 })).toEqual({ x: false, y: true });
    // From the centre there is no fixed edge to cross.
    expect(resizeFlips(box, right, { x: 50, y: 150 }, { fromCenter: true })).toEqual({ x: false, y: false });
    // In a box that is turned, it is the box's own left edge that counts.
    const turned = { ...box, rotation: 90 };
    const centre = { x: 200, y: 150 };
    expect(resizeFlips(turned, right, rotatePoint({ x: 50, y: 150 }, centre, 90))).toEqual({ x: true, y: false });
    expect(resizeFlips(turned, right, rotatePoint({ x: 350, y: 150 }, centre, 90))).toEqual({ x: false, y: false });
  });

  function editor(doc: Document): { store: EditorStore; controller: InteractionController } {
    const store = createEditorStore(doc);
    store.getState().setCanvasSize({ width: 800, height: 600 });
    const controller = new InteractionController(store, { requestRender: () => undefined, setCursor: () => undefined });
    return { store, controller };
  }

  it('mirrors what is in the layer while it is on the other side, and not once it is dragged back', () => {
    const { doc, id } = make('RECTANGLE', { fills: [gradientPaint('GRADIENT_LINEAR', RED, BLUE, 0), imagePaint(HASH)] });
    const { store, controller } = editor(doc);
    store.getState().setSelection([id]);
    // The handle in the middle of the right edge, dragged to the left of the left edge.
    controller.pointerDown(ptr(300, 150));
    controller.pointerMove(ptr(200, 150));
    expect(gradientOf(store.getState().doc, id).from.x).toBe(0);
    controller.pointerMove(ptr(40, 150));
    const crossed = store.getState().doc;
    expect(layer(crossed, id)).toMatchObject({ x: 40, y: 100, width: 60, height: 100 });
    expect(gradientOf(crossed, id)).toMatchObject({ from: { x: 1, y: 0.5 }, to: { x: 0, y: 0.5 } });
    expect(layer(crossed, id).fills[1]).toMatchObject({ flipX: true, flipY: false });
    // Back on its own side it is as it was, only wider.
    controller.pointerMove(ptr(350, 150));
    expect(layer(store.getState().doc, id)).toMatchObject({ x: 100, width: 250 });
    expect(gradientOf(store.getState().doc, id).from.x).toBe(0);
    expect(layer(store.getState().doc, id).fills[1]).toMatchObject({ flipX: false });
    // Left on the other side, it stays mirrored, as one undo step.
    controller.pointerMove(ptr(40, 150));
    controller.pointerUp(ptr(40, 150));
    expect(gradientOf(store.getState().doc, id).from.x).toBe(1);
    store.getState().undo();
    expect(store.getState().doc.nodes[id]).toEqual(doc.nodes[id]);
  });

  it('turns text over, and several layers change sides among themselves', () => {
    const text = make('TEXT', { characters: 'Hello', width: 50, height: 24, textAutoResize: 'NONE' });
    const one = editor(text.doc);
    one.store.getState().setSelection([text.id]);
    // The bottom-right corner dragged up and to the left of the top-left corner.
    one.controller.pointerDown(ptr(150, 124));
    one.controller.pointerMove(ptr(120, 110));
    one.controller.pointerMove(ptr(60, 70));
    expect(layer(one.store.getState().doc, text.id)).toMatchObject({ x: 60, y: 70, width: 40, height: 30, flipX: true, flipY: true });
    one.controller.cancel();
    expect(layer(one.store.getState().doc, text.id)).toMatchObject({ flipX: false, flipY: false });

    const doc = createDocument('Mirror');
    const pageId = (getPages(doc)[0] as { id: NodeId }).id;
    const a = addLayer(doc, 'RECTANGLE', pageId, { x: 100, y: 100, width: 50, height: 50, cornerRadii: [9, 0, 0, 0] });
    const b = addLayer(a.doc, 'RECTANGLE', pageId, { x: 250, y: 100, width: 50, height: 50 });
    const two = editor(b.doc);
    two.store.getState().setSelection([a.id, b.id]);
    // The pair spans 100 to 300. Its right edge is dragged to -100: the same size, on the other side of the left edge.
    two.controller.pointerDown(ptr(300, 125));
    two.controller.pointerMove(ptr(150, 125));
    two.controller.pointerMove(ptr(-100, 125));
    const flipped = two.store.getState().doc;
    // What was on the left is now on the right, next to the edge that stayed, and is itself mirrored.
    expect(layer(flipped, a.id)).toMatchObject({ x: 50, width: 50, cornerRadii: [0, 9, 0, 0] });
    expect(layer(flipped, b.id)).toMatchObject({ x: -100, width: 50 });
  });
});

describe('drawing what is mirrored', () => {
  function record(doc: Document, pageId: NodeId): [string, ...unknown[]][] {
    const calls: [string, ...unknown[]][] = [];
    const target: Record<string, unknown> = { globalAlpha: 1 };
    const ctx = new Proxy(target, {
      get(obj, prop: string) {
        if (prop in obj) return obj[prop];
        return (...args: unknown[]) => {
          if (['translate', 'scale', 'drawImage', 'fillText', 'save', 'restore'].includes(prop)) calls.push([prop, ...args]);
        };
      },
      set(obj, prop: string, value) {
        obj[prop] = value;
        return true;
      },
    }) as unknown as CanvasRenderingContext2D;
    const decoded = { image: { tag: 'image' } as unknown as CanvasImageSource, width: 200, height: 100 };
    renderScene(ctx, doc, pageId, { size: { width: 800, height: 600 }, dpr: 1, viewport: { x: 0, y: 0, zoom: 1 }, measurer: approximateMeasurer, images: { get: () => decoded } });
    return calls;
  }
  /** The calls that turn a box over, in the order they were made before `drawing`. */
  const turnsBefore = (calls: [string, ...unknown[]][], drawing: string): unknown[][] => {
    const at = calls.findIndex((call) => call[0] === drawing);
    return calls.slice(0, at).filter((call) => call[0] === 'translate' || call[0] === 'scale');
  };

  it('turns the box over before drawing a mirrored picture into it', () => {
    const { doc, id, pageId } = make('RECTANGLE', { fills: [imagePaint(HASH)] });
    expect(turnsBefore(record(doc, pageId), 'drawImage')).toEqual([]);
    expect(turnsBefore(record(flipNodes(doc, [id], 'horizontal'), pageId), 'drawImage')).toEqual([
      ['translate', 200, 0],
      ['scale', -1, 1],
    ]);
    expect(turnsBefore(record(flipNodes(doc, [id], 'vertical'), pageId), 'drawImage')).toEqual([
      ['translate', 0, 100],
      ['scale', 1, -1],
    ]);
  });

  it('turns the box over before drawing mirrored text into it, and puts it back afterwards', () => {
    const { doc, id, pageId } = make('TEXT', { characters: 'Hello', width: 50, height: 24, textAutoResize: 'NONE' });
    expect(turnsBefore(record(doc, pageId), 'fillText')).toEqual([]);
    const calls = record(flipNodes(doc, [id], 'horizontal'), pageId);
    expect(turnsBefore(calls, 'fillText')).toEqual([
      ['translate', 50, 0],
      ['scale', -1, 1],
    ]);
    // The glyphs themselves are drawn where they always are in the box.
    expect(calls.find((call) => call[0] === 'fillText')).toEqual(record(doc, pageId).find((call) => call[0] === 'fillText'));
    const names = calls.map((call) => call[0]);
    expect(names.lastIndexOf('restore')).toBeGreaterThan(names.indexOf('fillText'));
  });

  it('lets a mirrored picture still follow the pointer when it is positioned by dragging', () => {
    const paint: ImagePaint = { ...imagePaint(HASH), scaleMode: 'CROP', crop: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 } };
    const { doc, id } = make('RECTANGLE', { fills: [paint] });
    const edit = { id, key: 'fills' as const, index: 0 };
    // Dragged 50 to the right: as it is, the part shown moves left in the picture.
    expect((dragCrop(doc, edit, { x: 150, y: 150 }, { x: 200, y: 150 }).nodes[id] as LayerNode).fills[0]).toMatchObject({ crop: { x: 0.125, y: 0.25 } });
    // Mirrored, the picture is the other way round, so the part shown moves right in it.
    const mirrored = flipNodes(doc, [id], 'horizontal');
    expect((dragCrop(mirrored, edit, { x: 150, y: 150 }, { x: 200, y: 150 }).nodes[id] as LayerNode).fills[0]).toMatchObject({ crop: { x: 0.375, y: 0.25 } });
  });
});

describe('mirrored text and pictures in the file format', () => {
  it('are plain flags, false unless they are true', () => {
    const { doc, id } = make('TEXT', { characters: 'Hello' });
    const flipped = flipNodes(doc, [id], 'horizontal');
    expect(validateDocument(flipped)).toEqual([]);
    expect(repairDocument(JSON.parse(JSON.stringify(flipped))).repairs).toEqual([]);
    const damaged = JSON.parse(JSON.stringify(flipped)) as { nodes: Record<string, Record<string, unknown>> };
    Object.assign(damaged.nodes[id] as Record<string, unknown>, { flipX: 'yes', flipY: 1 });
    expect(repairDocument(damaged).doc.nodes[id] as TextNode).toMatchObject({ flipX: false, flipY: false });
    const picture = make('RECTANGLE', { fills: [{ ...imagePaint(HASH), flipX: true }] });
    const raw = JSON.parse(JSON.stringify(picture.doc)) as { nodes: Record<string, { fills: Record<string, unknown>[] }> };
    Object.assign(raw.nodes[picture.id]?.fills[0] as Record<string, unknown>, { flipY: 'down' });
    expect(imageOf(repairDocument(raw).doc, picture.id)).toMatchObject({ flipX: true, flipY: false });
  });

  it('opens a version 13 file: nothing mirrored, and no guides on frames', () => {
    const doc: Document = { ...createDocument('Mirror'), assets: ASSET };
    const pageId = (getPages(doc)[0] as { id: NodeId }).id;
    const frame = addLayer(doc, 'FRAME', pageId, { x: 0, y: 0, width: 400, height: 300 });
    const picture = addLayer(frame.doc, 'RECTANGLE', frame.id, { x: 10, y: 10, width: 100, height: 50, fills: [imagePaint(HASH)], strokes: [imagePaint(HASH)] });
    const text = addLayer(picture.doc, 'TEXT', frame.id, { x: 10, y: 100, characters: 'Hello' });
    const current = text.doc;
    const v13 = JSON.parse(JSON.stringify(current)) as { nodes: Record<string, Record<string, unknown>> };
    delete (v13.nodes[frame.id] as Record<string, unknown>).guides;
    delete (v13.nodes[text.id] as Record<string, unknown>).flipX;
    delete (v13.nodes[text.id] as Record<string, unknown>).flipY;
    for (const key of ['fills', 'strokes']) {
      const paint = ((v13.nodes[picture.id] as Record<string, unknown>)[key] as Record<string, unknown>[])[0] as Record<string, unknown>;
      delete paint.flipX;
      delete paint.flipY;
    }
    const parsed = parseFile({ format: 'open-design', schemaVersion: 13, meta: { createdAt: '2026-11-16T16:00:00.000Z', updatedAt: '2026-11-16T16:00:00.000Z' }, document: v13 });
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(14);
    expect(parsed.file.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(parsed.repairs).toEqual([]);
    expect(parsed.file.document).toEqual(current);
  });
});
