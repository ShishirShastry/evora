import { describe, expect, it } from 'vitest';
import {
  addLayer,
  createDocument,
  CURRENT_SCHEMA_VERSION,
  getPages,
  imagePaint,
  parseFile,
  repairDocument,
  validateDocument,
  type Document,
  type ImagePaint,
  type LayerNode,
  type NodeId,
} from './core';
import { InteractionController, type PointerInput } from './engine/input/controller';
import { dragCrop } from './engine/input/cropDrag';
import { imageFilter } from './engine/render/paint';
import { createEditorStore, type EditorStore } from './state/editorStore';

const HASH = 'a'.repeat(64);
const ptr = (x: number, y: number): PointerInput => ({ x, y, button: 0, shiftKey: false, altKey: false, ctrlKey: false, detail: 1 });

function setup(): { doc: Document; pageId: NodeId } {
  const doc: Document = { ...createDocument('Images'), assets: { [HASH]: { mimeType: 'image/png', width: 400, height: 200, name: 'photo.png' } } };
  return { doc, pageId: (getPages(doc)[0] as { id: NodeId }).id };
}

/** A 200 × 100 layer at (100, 100) showing the middle half of an image, each way. */
function cropped(rotation = 0): { doc: Document; id: NodeId } {
  const { doc, pageId } = setup();
  const paint: ImagePaint = { ...imagePaint(HASH), scaleMode: 'CROP', crop: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 } };
  const made = addLayer(doc, 'RECTANGLE', pageId, { x: 100, y: 100, width: 200, height: 100, rotation, fills: [paint] });
  return { doc: made.doc, id: made.id };
}

const cropOf = (doc: Document, id: NodeId): ImagePaint['crop'] => ((doc.nodes[id] as LayerNode).fills[0] as ImagePaint).crop;

describe('image adjustments', () => {
  it('are none to begin with, and become a filter when set', () => {
    const plain = imagePaint(HASH);
    expect(plain).toMatchObject({ exposure: 0, contrast: 0, saturation: 0 });
    expect(imageFilter(plain)).toBeNull();
    expect(imageFilter({ ...plain, exposure: 0.5 })).toBe('brightness(1.5) contrast(1) saturate(1)');
    // All the way down: black, flat grey, no colour.
    expect(imageFilter({ ...plain, exposure: -1, contrast: -1, saturation: -1 })).toBe('brightness(0) contrast(0) saturate(0)');
    expect(imageFilter({ ...plain, contrast: 0.25, saturation: 1 })).toBe('brightness(1) contrast(1.25) saturate(2)');
    // Out of range is brought back in.
    expect(imageFilter({ ...plain, saturation: 5 })).toBe('brightness(1) contrast(1) saturate(2)');
  });

  it('are kept in range in a file, and are zero in a file from before they existed', () => {
    const { doc, id } = cropped();
    expect(validateDocument(doc)).toEqual([]);
    const data = JSON.parse(JSON.stringify(doc)) as { nodes: Record<string, { fills: Record<string, unknown>[] }> };
    Object.assign(data.nodes[id]?.fills[0] as Record<string, unknown>, { exposure: 9, contrast: 'high', saturation: -3 });
    expect((repairDocument(data).doc.nodes[id] as LayerNode).fills[0]).toMatchObject({ exposure: 1, contrast: 0, saturation: -1 });

    const v11 = JSON.parse(JSON.stringify(doc)) as { nodes: Record<string, { fills: Record<string, unknown>[] }> };
    for (const key of ['exposure', 'contrast', 'saturation']) delete (v11.nodes[id]?.fills[0] as Record<string, unknown>)[key];
    const parsed = parseFile({ format: 'open-design', schemaVersion: 11, meta: { createdAt: '2026-11-16T16:00:00.000Z', updatedAt: '2026-11-16T16:00:00.000Z' }, document: v11 });
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(12);
    expect(parsed.file.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(parsed.repairs).toEqual([]);
    expect(parsed.file.document).toEqual(doc);
  });
});

describe('positioning a cropped image by dragging', () => {
  const edit = (id: NodeId) => ({ id, key: 'fills' as const, index: 0 });

  it('moves the part of the image that shows, the other way from the drag', () => {
    const { doc, id } = cropped();
    // The layer is 200 wide and shows half the image's width: 50 pixels of drag is an eighth of the image.
    const moved = dragCrop(doc, edit(id), { x: 150, y: 150 }, { x: 200, y: 150 });
    expect(cropOf(moved, id)).toEqual({ x: 0.125, y: 0.25, width: 0.5, height: 0.5 });
    const down = dragCrop(doc, edit(id), { x: 150, y: 150 }, { x: 150, y: 130 });
    expect(cropOf(down, id)).toEqual({ x: 0.25, y: 0.35, width: 0.5, height: 0.5 });
    // It stops at the edges of the image.
    expect(cropOf(dragCrop(doc, edit(id), { x: 0, y: 0 }, { x: 5000, y: 5000 }), id)).toMatchObject({ x: 0, y: 0 });
    expect(cropOf(dragCrop(doc, edit(id), { x: 0, y: 0 }, { x: -5000, y: -5000 }), id)).toMatchObject({ x: 0.5, y: 0.5 });
    // In a layer turned a quarter turn, a drag down the page is a drag along the layer.
    const turned = cropped(90);
    expect(cropOf(dragCrop(turned.doc, edit(turned.id), { x: 200, y: 150 }, { x: 200, y: 200 }), turned.id)).toEqual({ x: 0.125, y: 0.25, width: 0.5, height: 0.5 });
  });

  it('is done with the pointer while the image is being positioned, and not otherwise', () => {
    const { doc, id } = cropped();
    const store: EditorStore = createEditorStore(doc);
    store.getState().setCanvasSize({ width: 800, height: 600 });
    const controller = new InteractionController(store, { requestRender: () => undefined, setCursor: () => undefined });
    const drag = (from: [number, number], to: [number, number]): void => {
      controller.pointerDown(ptr(from[0], from[1]));
      controller.pointerMove(ptr((from[0] + to[0]) / 2, (from[1] + to[1]) / 2));
      controller.pointerMove(ptr(to[0], to[1]));
      controller.pointerUp(ptr(to[0], to[1]));
    };
    store.getState().setSelection([id]);
    // Not positioning: the drag moves the layer.
    drag([200, 150], [220, 150]);
    expect(store.getState().doc.nodes[id]).toMatchObject({ x: 120 });
    expect(cropOf(store.getState().doc, id).x).toBe(0.25);
    store.getState().undo();

    store.getState().setPaintEdit(edit(id));
    expect(store.getState().paintEdit).toEqual(edit(id));
    drag([200, 150], [250, 150]);
    expect(store.getState().doc.nodes[id]).toMatchObject({ x: 100, y: 100, width: 200 });
    expect(cropOf(store.getState().doc, id)).toEqual({ x: 0.125, y: 0.25, width: 0.5, height: 0.5 });
    expect(store.getState().undoStack.map((entry) => entry.label)).toEqual(['Crop image']);
    // The layer's corner still resizes it.
    drag([300, 200], [340, 220]);
    expect(store.getState().doc.nodes[id]).toMatchObject({ width: 240, height: 120 });
    // An image that fills its layer has nothing to position.
    store.getState().apply('Fit', (d) => ({ ...d, nodes: { ...d.nodes, [id]: { ...(d.nodes[id] as LayerNode), fills: [{ ...imagePaint(HASH) }] } as LayerNode } }));
    expect(store.getState().paintEdit).toBeNull();
    store.getState().setPaintEdit(edit(id));
    expect(store.getState().paintEdit).toBeNull();
  });
});
