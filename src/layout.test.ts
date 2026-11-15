import { describe, expect, it } from 'vitest';
import {
  addLayer,
  applyConstraints,
  collectSnapTargets,
  createDocument,
  CURRENT_SCHEMA_VERSION,
  getLayer,
  getPages,
  groupNodes,
  layoutGrid,
  layoutGridGeometry,
  layoutGridSnapLines,
  normalizeGroups,
  parseFile,
  patchNode,
  repairDocument,
  setLayerBox,
  validateDocument,
  type ConstraintType,
  type Document,
  type FrameNode,
  type LayerNode,
  type NodeId,
} from './core';
import { InteractionController, type PointerInput } from './engine/input/controller';
import { commandForKey, getCommand } from './state/commands';
import { createEditorStore } from './state/editorStore';

function setup(): { doc: Document; pageId: NodeId } {
  const doc = createDocument('Layout');
  return { doc, pageId: (getPages(doc)[0] as { id: NodeId }).id };
}

/** A 400 × 300 frame at the origin with one 100 × 50 child at (50, 40), constrained as given. */
function framed(horizontal: ConstraintType, vertical: ConstraintType = 'MIN'): { doc: Document; frameId: NodeId; childId: NodeId } {
  const { doc, pageId } = setup();
  const frame = addLayer(doc, 'FRAME', pageId, { x: 0, y: 0, width: 400, height: 300 });
  const child = addLayer(frame.doc, 'RECTANGLE', frame.id, { x: 50, y: 40, width: 100, height: 50, constraints: { horizontal, vertical } });
  return { doc: child.doc, frameId: frame.id, childId: child.id };
}

const box = (doc: Document, id: NodeId): { x: number; y: number; width: number; height: number } => {
  const node = getLayer(doc, id) as LayerNode;
  return { x: node.x, y: node.y, width: node.width, height: node.height };
};

describe('constraints', () => {
  it('new layers keep to the left and top, which is what an unconstrained layer does', () => {
    const { doc, frameId, childId } = framed('MIN');
    expect(getLayer(doc, childId)?.constraints).toEqual({ horizontal: 'MIN', vertical: 'MIN' });
    const wider = setLayerBox(doc, frameId, { width: 600, height: 500 });
    expect(box(wider, childId)).toEqual({ x: 50, y: 40, width: 100, height: 50 });
  });

  it('keeps the distance to the right or bottom edge', () => {
    const { doc, frameId, childId } = framed('MAX', 'MAX');
    // 250 from the right edge and 210 from the bottom, before and after.
    expect(box(setLayerBox(doc, frameId, { width: 600, height: 500 }), childId)).toEqual({ x: 250, y: 240, width: 100, height: 50 });
    expect(box(setLayerBox(doc, frameId, { width: 300 }), childId)).toEqual({ x: -50, y: 40, width: 100, height: 50 });
  });

  it('keeps the offset from the centre', () => {
    const { doc, frameId, childId } = framed('CENTER', 'CENTER');
    expect(box(setLayerBox(doc, frameId, { width: 600, height: 400 }), childId)).toEqual({ x: 150, y: 90, width: 100, height: 50 });
  });

  it('stretches to keep both edges, but never to nothing', () => {
    const { doc, frameId, childId } = framed('STRETCH', 'STRETCH');
    expect(box(setLayerBox(doc, frameId, { width: 600, height: 400 }), childId)).toEqual({ x: 50, y: 40, width: 300, height: 150 });
    expect(box(setLayerBox(doc, frameId, { width: 200, height: 100 }), childId)).toEqual({ x: 50, y: 40, width: 1, height: 1 });
  });

  it('scales position and size with the frame', () => {
    const { doc, frameId, childId } = framed('SCALE', 'SCALE');
    expect(box(setLayerBox(doc, frameId, { width: 800, height: 150 }), childId)).toEqual({ x: 100, y: 20, width: 200, height: 25 });
  });

  it('treats the two axes separately', () => {
    const { doc, frameId, childId } = framed('MAX', 'STRETCH');
    expect(box(setLayerBox(doc, frameId, { width: 500, height: 400 }), childId)).toEqual({ x: 150, y: 40, width: 100, height: 150 });
    // Only the height changed: nothing happens horizontally.
    expect(box(setLayerBox(doc, frameId, { height: 400 }), childId)).toEqual({ x: 50, y: 40, width: 100, height: 150 });
  });

  it('does nothing when the frame only moves, or is set to the size it already has', () => {
    const { doc, frameId } = framed('MAX', 'MAX');
    expect(setLayerBox(doc, frameId, { width: 400, height: 300 })).toBe(doc);
    expect(applyConstraints(doc, frameId, 400, 300, 400, 300)).toBe(doc);
    const moved = setLayerBox(doc, frameId, { x: 500, y: 500 });
    expect(Object.keys(moved.nodes).filter((id) => moved.nodes[id] !== doc.nodes[id])).toEqual([frameId]);
  });

  it('passes a stretch on to the children of a nested frame', () => {
    const { doc, frameId, childId } = framed('MIN');
    const inner = addLayer(doc, 'FRAME', frameId, { x: 200, y: 0, width: 200, height: 300, constraints: { horizontal: 'STRETCH', vertical: 'MIN' } });
    const pinned = addLayer(inner.doc, 'RECTANGLE', inner.id, { x: 150, y: 10, width: 40, height: 40, constraints: { horizontal: 'MAX', vertical: 'MIN' } });
    const out = setLayerBox(pinned.doc, frameId, { width: 500 });
    // The inner frame grows by 100; its child stays 10 from its right edge.
    expect(box(out, inner.id)).toMatchObject({ x: 200, width: 300 });
    expect(box(out, pinned.id)).toMatchObject({ x: 250, width: 40 });
    expect(box(out, childId)).toMatchObject({ x: 50, width: 100 });
  });

  it('scales what is inside a group when the group is stretched', () => {
    const { doc, pageId } = setup();
    const frame = addLayer(doc, 'FRAME', pageId, { x: 0, y: 0, width: 400, height: 300 });
    const a = addLayer(frame.doc, 'RECTANGLE', frame.id, { x: 0, y: 0, width: 100, height: 100 });
    const b = addLayer(a.doc, 'RECTANGLE', frame.id, { x: 100, y: 0, width: 100, height: 100 });
    const grouped = groupNodes(b.doc, [a.id, b.id]);
    if (!grouped) throw new Error('no group');
    const stretchy = patchNode(grouped.doc, grouped.id, { constraints: { horizontal: 'STRETCH', vertical: 'MIN' } });
    const out = normalizeGroups(setLayerBox(stretchy, frame.id, { width: 600 }));
    expect(box(out, grouped.id)).toMatchObject({ x: 0, width: 400 });
    expect(box(out, a.id)).toMatchObject({ x: 0, width: 200 });
    expect(box(out, b.id)).toMatchObject({ x: 200, width: 200 });
  });

  it('applies when a frame is resized by its handle on the canvas, as one undo step', () => {
    const { doc, frameId, childId } = framed('MAX', 'MAX');
    const store = createEditorStore(doc);
    store.getState().setCanvasSize({ width: 800, height: 600 });
    const controller = new InteractionController(store, { requestRender: () => undefined, setCursor: () => undefined });
    const ptr = (x: number, y: number): PointerInput => ({ x, y, button: 0, shiftKey: false, altKey: false, ctrlKey: false, detail: 1 });
    store.getState().setSelection([frameId]);
    // Drag the frame's bottom-right corner from (400, 300) to (500, 350).
    controller.pointerDown(ptr(400, 300));
    controller.pointerMove(ptr(500, 350));
    controller.pointerUp(ptr(500, 350));
    expect(box(store.getState().doc, frameId)).toEqual({ x: 0, y: 0, width: 500, height: 350 });
    expect(box(store.getState().doc, childId)).toEqual({ x: 150, y: 90, width: 100, height: 50 });
    store.getState().undo();
    expect(box(store.getState().doc, childId)).toEqual({ x: 50, y: 40, width: 100, height: 50 });
    expect(box(store.getState().doc, frameId)).toEqual({ x: 0, y: 0, width: 400, height: 300 });
  });

  it('repairs invalid constraints', () => {
    const { doc, childId } = framed('MAX');
    expect(validateDocument(doc)).toEqual([]);
    const data = JSON.parse(JSON.stringify(doc)) as { nodes: Record<string, Record<string, unknown>> };
    (data.nodes[childId] as Record<string, unknown>).constraints = { horizontal: 'SIDEWAYS' };
    expect(repairDocument(data).doc.nodes[childId]).toMatchObject({ constraints: { horizontal: 'MIN', vertical: 'MIN' } });
  });
});

describe('layout grids', () => {
  it('lays out stretched columns between the margins', () => {
    const grid = { ...layoutGrid('COLUMNS'), count: 4, gutter: 20, offset: 30 };
    const geometry = layoutGridGeometry(grid, 400, 200);
    // 400 - 2×30 margins - 3×20 gutters = 280, so four columns of 70.
    expect(geometry.bands).toEqual([
      { x: 30, y: 0, width: 70, height: 200 },
      { x: 120, y: 0, width: 70, height: 200 },
      { x: 210, y: 0, width: 70, height: 200 },
      { x: 300, y: 0, width: 70, height: 200 },
    ]);
    expect(layoutGridSnapLines(grid, 400, 200)).toEqual({ xs: [30, 100, 120, 190, 210, 280, 300, 370], ys: [] });
  });

  it('aligns fixed-width columns left, centre and right', () => {
    const fixed = { ...layoutGrid('COLUMNS'), count: 3, gutter: 10, sectionSize: 50, offset: 20 };
    const starts = (alignment: 'MIN' | 'CENTER' | 'MAX'): number[] => layoutGridGeometry({ ...fixed, alignment }, 400, 100).bands.map((band) => band.x);
    // The block is 3×50 + 2×10 = 170 wide.
    expect(starts('MIN')).toEqual([20, 80, 140]);
    expect(starts('MAX')).toEqual([210, 270, 330]);
    expect(starts('CENTER')).toEqual([115, 175, 235]);
  });

  it('lays out rows down the frame', () => {
    const grid = { ...layoutGrid('ROWS'), count: 2, gutter: 0, offset: 0 };
    expect(layoutGridGeometry(grid, 300, 200).bands).toEqual([
      { x: 0, y: 0, width: 300, height: 100 },
      { x: 0, y: 100, width: 300, height: 100 },
    ]);
    expect(layoutGridSnapLines(grid, 300, 200)).toEqual({ xs: [], ys: [0, 100, 100, 200] });
  });

  it('draws the lines of a uniform grid inside the frame only', () => {
    const geometry = layoutGridGeometry({ ...layoutGrid('GRID'), size: 25 }, 100, 60);
    expect(geometry).toEqual({ bands: [], xs: [25, 50, 75], ys: [25, 50] });
    expect(layoutGridGeometry(layoutGrid('GRID'), 0, 100)).toEqual({ bands: [], xs: [], ys: [] });
  });

  it('offers grid lines as snap targets, unless the grid is hidden or grids are switched off', () => {
    const { doc, pageId } = setup();
    const frame = addLayer(doc, 'FRAME', pageId, { x: 100, y: 100, width: 200, height: 100, layoutGrids: [{ ...layoutGrid('GRID'), size: 50 }] });
    const none = new Set<NodeId>();
    const xs = (d: Document, options?: { layoutGrids?: boolean }): number[] => collectSnapTargets(d, frame.id, none, options).xs.map((line) => line.value);
    // The frame's own edges and centre, then the grid's lines, in page space.
    expect(xs(frame.doc)).toEqual([100, 200, 300, 150, 200, 250]);
    expect(xs(frame.doc, { layoutGrids: false })).toEqual([100, 200, 300]);
    const hidden = patchNode(frame.doc, frame.id, { layoutGrids: [{ ...layoutGrid('GRID'), size: 50, visible: false }] });
    expect(xs(hidden)).toEqual([100, 200, 300]);
  });

  it('snaps a dragged layer to a column edge', () => {
    const { doc, pageId } = setup();
    const columns = { ...layoutGrid('COLUMNS'), count: 2, gutter: 20, offset: 10 };
    const frame = addLayer(doc, 'FRAME', pageId, { x: 0, y: 0, width: 400, height: 300, layoutGrids: [columns] });
    const rect = addLayer(frame.doc, 'RECTANGLE', frame.id, { x: 300, y: 200, width: 40, height: 40 });
    const run = (showLayoutGrids: boolean): number => {
      const store = createEditorStore(rect.doc, undefined, { showLayoutGrids });
      store.getState().setCanvasSize({ width: 800, height: 600 });
      const controller = new InteractionController(store, { requestRender: () => undefined, setCursor: () => undefined });
      const ptr = (x: number, y: number): PointerInput => ({ x, y, button: 0, shiftKey: false, altKey: false, ctrlKey: false, detail: 1 });
      store.getState().setSelection([rect.id]);
      controller.pointerDown(ptr(320, 220));
      // The left edge would land on x = 13; the first column starts at 10.
      controller.pointerMove(ptr(33, 120));
      controller.pointerUp(ptr(33, 120));
      return (getLayer(store.getState().doc, rect.id) as LayerNode).x;
    };
    expect(run(true)).toBe(10);
    expect(run(false)).toBe(13);
  });

  it('validates grids and repairs broken ones', () => {
    const { doc, pageId } = setup();
    const frame = addLayer(doc, 'FRAME', pageId, { layoutGrids: [layoutGrid('GRID'), layoutGrid('COLUMNS'), layoutGrid('ROWS')] });
    expect(validateDocument(frame.doc)).toEqual([]);
    const data = JSON.parse(JSON.stringify(frame.doc)) as { nodes: Record<string, Record<string, unknown>> };
    (data.nodes[frame.id] as Record<string, unknown>).layoutGrids = [
      { pattern: 'COLUMNS', count: 0.4, gutter: -5, alignment: 'DIAGONAL', opacity: 4, color: 'red' },
      { pattern: 'HEXAGONS' },
      'nonsense',
    ];
    const grids = (repairDocument(data).doc.nodes[frame.id] as FrameNode).layoutGrids;
    expect(grids).toHaveLength(1);
    expect(grids[0]).toMatchObject({ pattern: 'COLUMNS', count: 1, gutter: 0, alignment: 'STRETCH', opacity: 1, color: { r: 1, g: 0, b: 0 }, visible: true });
  });

  it('is switched on and off with a command that is not an undo step', () => {
    const store = createEditorStore(createDocument('Grids'));
    const command = commandForKey({ code: 'KeyG', ctrlKey: false, shiftKey: true, altKey: false, metaKey: false });
    expect(command?.id).toBe('view.layoutGrids');
    expect(getCommand('view.layoutGrids')?.checked?.(store.getState())).toBe(true);
    store.getState().setShowLayoutGrids(false);
    expect(getCommand('view.layoutGrids')?.checked?.(store.getState())).toBe(false);
    expect(store.getState().undoStack).toEqual([]);
  });
});

describe('version 5 files', () => {
  it('open in version 6 with left/top constraints and no layout grids', () => {
    const { doc, pageId } = setup();
    const frame = addLayer(doc, 'FRAME', pageId, { width: 300, height: 200 });
    const rect = addLayer(frame.doc, 'RECTANGLE', frame.id, { x: 10, y: 10 });
    // A version 5 document is a current one without constraints and layout grids.
    const v5 = JSON.parse(JSON.stringify(rect.doc)) as { nodes: Record<string, Record<string, unknown>> };
    for (const node of Object.values(v5.nodes)) {
      delete node.constraints;
      delete node.layoutGrids;
    }
    const parsed = parseFile({
      format: 'open-design',
      schemaVersion: 5,
      meta: { createdAt: '2026-11-15T18:00:00.000Z', updatedAt: '2026-11-15T18:00:00.000Z' },
      document: v5,
    });
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(6);
    expect(parsed.file.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(parsed.repairs).toEqual([]);
    // Exactly what a new document of the same shape contains.
    expect(parsed.file.document).toEqual(rect.doc);
    expect('layoutGrids' in (parsed.file.document.nodes[rect.id] as object)).toBe(false);
    expect('constraints' in (parsed.file.document.nodes[pageId] as object)).toBe(false);
  });
});
