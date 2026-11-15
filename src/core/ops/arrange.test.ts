import { describe, expect, it } from 'vitest';
import {
  addLayer,
  alignNodes,
  createDocument,
  CURRENT_SCHEMA_VERSION,
  deeperTargetAt,
  deleteNodes,
  distributeNodes,
  flipNodes,
  getChildIds,
  getLayer,
  getPages,
  getWorldBounds,
  groupNodes,
  moveNodesBy,
  normalizeGroups,
  parseFile,
  patchNode,
  reparentNodes,
  resizeNodesInBounds,
  selectionTargetAt,
  setLayerBox,
  ungroupNodes,
  validateDocument,
  worldCenterOf,
  type Document,
  type NodeId,
} from '../index';

function setup(): { doc: Document; pageId: NodeId } {
  const doc = createDocument('Test');
  return { doc, pageId: (getPages(doc)[0] as { id: NodeId }).id };
}

function rects(specs: [number, number, number, number][]): { doc: Document; pageId: NodeId; ids: NodeId[] } {
  let { doc, pageId } = setup();
  const ids: NodeId[] = [];
  specs.forEach(([x, y, width, height], i) => {
    const out = addLayer(doc, 'RECTANGLE', pageId, { x, y, width, height, name: String.fromCharCode(65 + i) });
    doc = out.doc;
    ids.push(out.id);
  });
  return { doc, pageId, ids };
}

const names = (doc: Document, parentId: NodeId): string[] => getChildIds(doc, parentId).map((id) => doc.nodes[id]?.name ?? '?');

describe('groups', () => {
  it('groups layers without moving them on the page', () => {
    const { doc, pageId, ids } = rects([
      [0, 0, 100, 100],
      [200, 50, 100, 100],
    ]);
    const before = ids.map((id) => getWorldBounds(doc, id));
    const out = groupNodes(doc, ids);
    if (!out) throw new Error('no group');
    expect(getLayer(out.doc, out.id)).toMatchObject({ type: 'GROUP', name: 'Group 1', x: 0, y: 0, width: 300, height: 150, parentId: pageId });
    expect(getChildIds(out.doc, out.id)).toEqual(ids);
    expect(getLayer(out.doc, ids[1])).toMatchObject({ parentId: out.id, x: 200, y: 50 });
    expect(ids.map((id) => getWorldBounds(out.doc, id))).toEqual(before);
    expect(validateDocument(out.doc)).toEqual([]);
  });

  it('puts the group where the top-most member was in the stack', () => {
    const { doc, pageId, ids } = rects([
      [0, 0, 10, 10],
      [20, 0, 10, 10],
      [40, 0, 10, 10],
      [60, 0, 10, 10],
    ]);
    const out = groupNodes(doc, [ids[0] as NodeId, ids[2] as NodeId]);
    if (!out) throw new Error('no group');
    expect(names(out.doc, pageId)).toEqual(['B', 'Group 1', 'D']);
    expect(names(out.doc, out.id)).toEqual(['A', 'C']);
  });

  it('ungroups back to the same place and stacking position, also when the group was rotated', () => {
    const { doc, pageId, ids } = rects([
      [0, 0, 100, 100],
      [200, 50, 100, 100],
      [500, 500, 10, 10],
    ]);
    const grouped = groupNodes(doc, [ids[0] as NodeId, ids[1] as NodeId]);
    if (!grouped) throw new Error('no group');
    const rotated = patchNode(grouped.doc, grouped.id, { rotation: 30 });
    const centers = ids.map((id) => worldCenterOf(rotated, id));

    const out = ungroupNodes(rotated, [grouped.id]);
    expect(out.ids).toEqual([ids[0], ids[1]]);
    expect(out.doc.nodes[grouped.id]).toBeUndefined();
    expect(names(out.doc, pageId)).toEqual(['A', 'B', 'C']);
    ids.forEach((id, i) => {
      const center = worldCenterOf(out.doc, id);
      expect(center.x).toBeCloseTo((centers[i] as { x: number }).x, 2);
      expect(center.y).toBeCloseTo((centers[i] as { y: number }).y, 2);
    });
    expect(getLayer(out.doc, ids[0])).toMatchObject({ rotation: 30, parentId: pageId });
  });

  it('refits a group when a child moves, leaving the other children where they are', () => {
    const { doc, ids } = rects([
      [100, 100, 100, 100],
      [300, 100, 100, 100],
    ]);
    const grouped = groupNodes(doc, ids);
    if (!grouped) throw new Error('no group');
    const still = getWorldBounds(grouped.doc, ids[1] as NodeId);

    const moved = normalizeGroups(moveNodesBy(grouped.doc, [ids[0] as NodeId], -60, -40));
    expect(getLayer(moved, grouped.id)).toMatchObject({ x: 40, y: 60, width: 360, height: 140 });
    expect(getWorldBounds(moved, ids[0] as NodeId)).toMatchObject({ x: 40, y: 60 });
    expect(getWorldBounds(moved, ids[1] as NodeId)).toEqual(still);
    // Normalising again changes nothing.
    expect(normalizeGroups(moved)).toBe(moved);
  });

  it('refits a rotated group without moving its children on the page', () => {
    const { doc, ids } = rects([
      [100, 100, 100, 100],
      [300, 100, 100, 100],
    ]);
    const grouped = groupNodes(doc, ids);
    if (!grouped) throw new Error('no group');
    const rotated = patchNode(grouped.doc, grouped.id, { rotation: 40 });
    const moved = moveNodesBy(rotated, [ids[0] as NodeId], -50, 20);
    const expected = ids.map((id) => worldCenterOf(moved, id));
    const fitted = normalizeGroups(moved);
    expect(fitted).not.toBe(moved);
    ids.forEach((id, i) => {
      const center = worldCenterOf(fitted, id);
      expect(center.x).toBeCloseTo((expected[i] as { x: number }).x, 2);
      expect(center.y).toBeCloseTo((expected[i] as { y: number }).y, 2);
    });
  });

  it('removes a group when its last child is deleted or moved out, including nested groups', () => {
    const { doc, pageId, ids } = rects([
      [0, 0, 10, 10],
      [20, 0, 10, 10],
    ]);
    const inner = groupNodes(doc, [ids[0] as NodeId]);
    if (!inner) throw new Error('no group');
    const outer = groupNodes(inner.doc, [inner.id]);
    if (!outer) throw new Error('no group');

    const deleted = normalizeGroups(deleteNodes(outer.doc, [ids[0] as NodeId]));
    expect(deleted.nodes[inner.id]).toBeUndefined();
    expect(deleted.nodes[outer.id]).toBeUndefined();
    expect(names(deleted, pageId)).toEqual(['B']);

    const movedOut = normalizeGroups(reparentNodes(outer.doc, [ids[0] as NodeId], pageId));
    expect(movedOut.nodes[outer.id]).toBeUndefined();
    expect(names(movedOut, pageId)).toEqual(['B', 'A']);
  });

  it('scales the contents when a group is resized', () => {
    const { doc, ids } = rects([
      [0, 0, 100, 100],
      [100, 100, 100, 100],
    ]);
    const grouped = groupNodes(doc, ids);
    if (!grouped) throw new Error('no group');
    const out = normalizeGroups(setLayerBox(grouped.doc, grouped.id, { width: 400, height: 100 }));
    expect(getLayer(out, grouped.id)).toMatchObject({ x: 0, y: 0, width: 400, height: 100 });
    expect(getLayer(out, ids[0])).toMatchObject({ x: 0, y: 0, width: 200, height: 50 });
    expect(getLayer(out, ids[1])).toMatchObject({ x: 200, y: 50, width: 200, height: 50 });
  });

  it('scales a group and its contents as part of a multi-selection', () => {
    const { doc, ids } = rects([
      [0, 0, 100, 100],
      [100, 100, 100, 100],
      [300, 0, 100, 200],
    ]);
    const grouped = groupNodes(doc, [ids[0] as NodeId, ids[1] as NodeId]);
    if (!grouped) throw new Error('no group');
    const out = normalizeGroups(
      resizeNodesInBounds(grouped.doc, [grouped.id, ids[2] as NodeId], { x: 0, y: 0, width: 400, height: 200 }, { x: 0, y: 0, width: 800, height: 200 }),
    );
    expect(getWorldBounds(out, ids[1] as NodeId)).toEqual({ x: 200, y: 100, width: 200, height: 100 });
    expect(getWorldBounds(out, ids[2] as NodeId)).toEqual({ x: 600, y: 0, width: 200, height: 200 });
  });

  it('selects the group on click, its child on double-click, and nothing in the gaps', () => {
    const { doc, pageId, ids } = rects([
      [0, 0, 100, 100],
      [300, 0, 100, 100],
    ]);
    const grouped = groupNodes(doc, ids);
    if (!grouped) throw new Error('no group');
    const d = grouped.doc;
    expect(selectionTargetAt(d, pageId, { x: 50, y: 50 }, [])).toBe(grouped.id);
    expect(deeperTargetAt(d, pageId, { x: 50, y: 50 }, [grouped.id])).toBe(ids[0]);
    // Inside the group's box but not on a child.
    expect(selectionTargetAt(d, pageId, { x: 200, y: 50 }, [])).toBeNull();
    // Working inside the group: its children are selected directly.
    expect(selectionTargetAt(d, pageId, { x: 350, y: 50 }, [ids[0] as NodeId])).toBe(ids[1]);
  });
});

describe('align and distribute', () => {
  const three = (): ReturnType<typeof rects> =>
    rects([
      [0, 0, 100, 50],
      [150, 100, 50, 100],
      [400, 30, 100, 20],
    ]);

  it('aligns to each edge and centre of the selection', () => {
    const { doc, ids } = three();
    const xs = (d: Document): number[] => ids.map((id) => getWorldBounds(d, id).x);
    const ys = (d: Document): number[] => ids.map((id) => getWorldBounds(d, id).y);
    expect(xs(alignNodes(doc, ids, 'left'))).toEqual([0, 0, 0]);
    expect(xs(alignNodes(doc, ids, 'right'))).toEqual([400, 450, 400]);
    expect(xs(alignNodes(doc, ids, 'centerX'))).toEqual([200, 225, 200]);
    expect(ys(alignNodes(doc, ids, 'top'))).toEqual([0, 0, 0]);
    expect(ys(alignNodes(doc, ids, 'bottom'))).toEqual([150, 100, 180]);
    expect(ys(alignNodes(doc, ids, 'centerY'))).toEqual([75, 50, 90]);
  });

  it('aligns a single layer to the frame it is in, and does nothing for a single layer on the page', () => {
    const { doc, pageId } = setup();
    const frame = addLayer(doc, 'FRAME', pageId, { x: 100, y: 100, width: 400, height: 300 });
    const rect = addLayer(frame.doc, 'RECTANGLE', frame.id, { x: 30, y: 40, width: 100, height: 50 });
    expect(getLayer(alignNodes(rect.doc, [rect.id], 'right'), rect.id)).toMatchObject({ x: 300, y: 40 });
    expect(getLayer(alignNodes(rect.doc, [rect.id], 'centerY'), rect.id)).toMatchObject({ x: 30, y: 125 });
    const loose = addLayer(rect.doc, 'RECTANGLE', pageId, { x: 5, y: 5 });
    expect(alignNodes(loose.doc, [loose.id], 'left')).toBe(loose.doc);
  });

  it('aligns rotated layers by their visible bounds', () => {
    const { doc, ids } = rects([
      [0, 0, 100, 20],
      [300, 0, 100, 100],
    ]);
    const rotated = patchNode(doc, ids[0] as NodeId, { rotation: 90 });
    const out = alignNodes(rotated, ids, 'left');
    expect(getWorldBounds(out, ids[0] as NodeId).x).toBeCloseTo(getWorldBounds(out, ids[1] as NodeId).x);
  });

  it('distributes so the gaps are equal and the outer layers stay put', () => {
    const { doc, ids } = three();
    const out = distributeNodes(doc, ids, 'horizontal');
    const b = ids.map((id) => getWorldBounds(out, id));
    expect(b[0]?.x).toBe(0);
    expect(b[2]?.x).toBe(400);
    // Span 500, total width 250, two gaps of 125.
    expect(b[1]?.x).toBe(225);
    expect(distributeNodes(doc, ids.slice(0, 2), 'horizontal')).toBe(doc);

    const vertical = distributeNodes(doc, ids, 'vertical');
    const v = ids.map((id) => getWorldBounds(vertical, id));
    // Sorted by top: A (0..50), C (30..50), B (100..200). Span 200, total 170, gaps 15.
    expect(v.map((r) => r.y)).toEqual([0, 100, 65]);
  });
});

describe('flip', () => {
  it('flips one layer in place', () => {
    const { doc, pageId } = setup();
    const triangle = addLayer(doc, 'POLYGON', pageId, { x: 10, y: 20, width: 100, height: 80, rotation: 30 });
    const h = flipNodes(triangle.doc, [triangle.id], 'horizontal');
    expect(getLayer(h, triangle.id)).toMatchObject({ x: 10, y: 20, rotation: -30 });
    const v = flipNodes(triangle.doc, [triangle.id], 'vertical');
    expect(getLayer(v, triangle.id)).toMatchObject({ x: 10, y: 20, rotation: 150 });
    // Flipping twice returns to the start.
    expect(getLayer(flipNodes(v, [triangle.id], 'vertical'), triangle.id)).toMatchObject({ rotation: 30 });
  });

  it('swaps sides when several layers are flipped together', () => {
    const { doc, ids } = rects([
      [0, 0, 100, 100],
      [300, 20, 50, 50],
    ]);
    const out = flipNodes(doc, ids, 'horizontal');
    expect(getLayer(out, ids[0])).toMatchObject({ x: 250, y: 0 });
    expect(getLayer(out, ids[1])).toMatchObject({ x: 0, y: 20 });
    const v = flipNodes(doc, ids, 'vertical');
    expect(getLayer(v, ids[0])).toMatchObject({ x: 0, y: 0 });
    expect(getLayer(v, ids[1])).toMatchObject({ x: 300, y: 30 });
  });

  it('mirrors the contents of a frame inside it', () => {
    const { doc, pageId } = setup();
    const frame = addLayer(doc, 'FRAME', pageId, { x: 100, y: 100, width: 400, height: 200 });
    const rect = addLayer(frame.doc, 'RECTANGLE', frame.id, { x: 10, y: 20, width: 50, height: 60, rotation: 10 });
    const out = flipNodes(rect.doc, [frame.id], 'horizontal');
    expect(getLayer(out, frame.id)).toMatchObject({ x: 100, y: 100, rotation: 0 });
    expect(getLayer(out, rect.id)).toMatchObject({ x: 340, y: 20, rotation: -10 });
  });
});

describe('schema migration', () => {
  /** A file exactly as version 1 of the application wrote it. */
  const V1_FIXTURE = {
    format: 'open-design',
    schemaVersion: 1,
    meta: { createdAt: '2026-11-15T10:00:00.000Z', updatedAt: '2026-11-15T10:05:00.000Z' },
    document: {
      id: 'docV1fixture00001',
      name: 'Version 1 file',
      nodes: {
        page0000000000001: { id: 'page0000000000001', type: 'PAGE', name: 'Page 1', parentId: null, order: 'a0', backgroundColor: { r: 0.118, g: 0.118, b: 0.118 } },
        frame000000000001: {
          id: 'frame000000000001', type: 'FRAME', name: 'Frame 1', parentId: 'page0000000000001', order: 'a0',
          visible: true, locked: false, x: 0, y: 0, width: 400, height: 300, rotation: 0, opacity: 1,
          fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 }, opacity: 1, visible: true }], strokes: [], strokeWeight: 1, strokeAlign: 'INSIDE',
          clipsContent: true, cornerRadius: 0,
        },
        rect0000000000001: {
          id: 'rect0000000000001', type: 'RECTANGLE', name: 'Rectangle 1', parentId: 'frame000000000001', order: 'a0',
          visible: true, locked: false, x: 20, y: 30, width: 100, height: 80, rotation: 15, opacity: 0.5,
          fills: [{ type: 'SOLID', color: { r: 0.851, g: 0.851, b: 0.851 }, opacity: 1, visible: true }], strokes: [], strokeWeight: 1, strokeAlign: 'INSIDE',
          cornerRadius: 8,
        },
      },
    },
  };

  it('opens a version 1 file as the current version with its content intact', () => {
    const parsed = parseFile(JSON.parse(JSON.stringify(V1_FIXTURE)));
    // Every migration from version 1 up to the current version is applied in turn.
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(2);
    expect(parsed.file.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(parsed.repairs).toEqual([]);
    expect(parsed.file.document).toEqual(V1_FIXTURE.document);
    expect(parsed.file.meta).toEqual(V1_FIXTURE.meta);
  });
});
