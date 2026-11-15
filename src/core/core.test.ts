import { describe, expect, it } from 'vitest';
import {
  addLayer,
  addPage,
  applyPatch,
  containerAt,
  copyNodes,
  createDocument,
  deleteNodes,
  deletePage,
  diffDocuments,
  duplicateNodes,
  duplicatePage,
  getChildIds,
  getDescendantIds,
  getLayer,
  getPages,
  getWorldBounds,
  hitTestDeepest,
  lineBox,
  lineEndpoints,
  moveNodesBy,
  movePage,
  nodesInRect,
  patchNode,
  pasteNodes,
  reorderNodes,
  reparentNodes,
  resizeBox,
  resizeNodesInBounds,
  rotateNodesAround,
  selectionTargetAt,
  deeperTargetAt,
  worldCenterOf,
  type Document,
  type NodeId,
} from './index';

function setup(): { doc: Document; pageId: NodeId } {
  const doc = createDocument('Test');
  return { doc, pageId: (getPages(doc)[0] as { id: NodeId }).id };
}

function names(doc: Document, parentId: NodeId): string[] {
  return getChildIds(doc, parentId).map((id) => doc.nodes[id]?.name ?? '?');
}

describe('document creation', () => {
  it('starts with one empty page', () => {
    const { doc, pageId } = setup();
    expect(getPages(doc)).toHaveLength(1);
    expect(getChildIds(doc, pageId)).toEqual([]);
    expect(doc.name).toBe('Test');
  });

  it('adds layers on top of their siblings with numbered names', () => {
    let { doc, pageId } = setup();
    const a = addLayer(doc, 'RECTANGLE', pageId);
    const b = addLayer(a.doc, 'RECTANGLE', pageId);
    const c = addLayer(b.doc, 'ELLIPSE', pageId);
    doc = c.doc;
    expect(names(doc, pageId)).toEqual(['Rectangle 1', 'Rectangle 2', 'Ellipse 1']);
    expect(getChildIds(doc, pageId)).toEqual([a.id, b.id, c.id]);
  });

  it('refuses to add a layer to something that is not a container', () => {
    const { doc, pageId } = setup();
    const rect = addLayer(doc, 'RECTANGLE', pageId);
    expect(() => addLayer(rect.doc, 'RECTANGLE', rect.id)).toThrow();
  });

  it('does not mutate the previous snapshot', () => {
    const { doc, pageId } = setup();
    const before = JSON.stringify(doc);
    addLayer(doc, 'RECTANGLE', pageId);
    expect(JSON.stringify(doc)).toBe(before);
  });
});

describe('frames and world transforms', () => {
  it('positions children relative to their frame', () => {
    const { doc, pageId } = setup();
    const frame = addLayer(doc, 'FRAME', pageId, { x: 100, y: 200, width: 400, height: 300 });
    const rect = addLayer(frame.doc, 'RECTANGLE', frame.id, { x: 10, y: 20, width: 50, height: 60 });
    expect(getWorldBounds(rect.doc, rect.id)).toEqual({ x: 110, y: 220, width: 50, height: 60 });
  });

  it('rotates children with their frame', () => {
    const { doc, pageId } = setup();
    const frame = addLayer(doc, 'FRAME', pageId, { x: 0, y: 0, width: 100, height: 100, rotation: 90 });
    const rect = addLayer(frame.doc, 'RECTANGLE', frame.id, { x: 0, y: 0, width: 20, height: 10 });
    const bounds = getWorldBounds(rect.doc, rect.id);
    // The frame's top-left corner ends up at its top-right after a 90° turn.
    expect(bounds.x).toBeCloseTo(90);
    expect(bounds.y).toBeCloseTo(0);
    expect(bounds.width).toBeCloseTo(10);
    expect(bounds.height).toBeCloseTo(20);
  });

  it('deleting a frame deletes its contents', () => {
    const { doc, pageId } = setup();
    const frame = addLayer(doc, 'FRAME', pageId);
    const rect = addLayer(frame.doc, 'RECTANGLE', frame.id);
    const after = deleteNodes(rect.doc, [frame.id]);
    expect(after.nodes[frame.id]).toBeUndefined();
    expect(after.nodes[rect.id]).toBeUndefined();
    expect(Object.keys(after.nodes)).toEqual([pageId]);
  });
});

describe('moving', () => {
  it('moves by a page-space delta', () => {
    const { doc, pageId } = setup();
    const rect = addLayer(doc, 'RECTANGLE', pageId, { x: 10, y: 10 });
    const moved = moveNodesBy(rect.doc, [rect.id], 25, -5);
    expect(getLayer(moved, rect.id)).toMatchObject({ x: 35, y: 5 });
  });

  it('moves a child of a rotated frame along the page axes', () => {
    const { doc, pageId } = setup();
    const frame = addLayer(doc, 'FRAME', pageId, { x: 0, y: 0, width: 200, height: 200, rotation: 90 });
    const rect = addLayer(frame.doc, 'RECTANGLE', frame.id, { x: 50, y: 50, width: 20, height: 20 });
    const before = worldCenterOf(rect.doc, rect.id);
    const moved = moveNodesBy(rect.doc, [rect.id], 30, 0);
    const after = worldCenterOf(moved, rect.id);
    expect(after.x - before.x).toBeCloseTo(30);
    expect(after.y - before.y).toBeCloseTo(0);
  });

  it('moves a parent only once when parent and child are both selected', () => {
    const { doc, pageId } = setup();
    const frame = addLayer(doc, 'FRAME', pageId, { x: 0, y: 0 });
    const rect = addLayer(frame.doc, 'RECTANGLE', frame.id, { x: 5, y: 5 });
    const moved = moveNodesBy(rect.doc, [frame.id, rect.id], 10, 10);
    expect(getLayer(moved, frame.id)).toMatchObject({ x: 10, y: 10 });
    expect(getLayer(moved, rect.id)).toMatchObject({ x: 5, y: 5 });
  });

  it('snaps to whole pixels when asked', () => {
    const { doc, pageId } = setup();
    const rect = addLayer(doc, 'RECTANGLE', pageId, { x: 0, y: 0 });
    const moved = moveNodesBy(rect.doc, [rect.id], 10.4, 3.6, true);
    expect(getLayer(moved, rect.id)).toMatchObject({ x: 10, y: 4 });
  });
});

describe('resizing', () => {
  const box = { x: 100, y: 100, width: 200, height: 100, rotation: 0 };

  it('drags the bottom-right corner, keeping the top-left fixed', () => {
    expect(resizeBox(box, { hx: 1, hy: 1 }, { x: 350, y: 260 })).toEqual({
      x: 100, y: 100, width: 250, height: 160, rotation: 0,
    });
  });

  it('drags the top-left corner, keeping the bottom-right fixed', () => {
    expect(resizeBox(box, { hx: -1, hy: -1 }, { x: 150, y: 120 })).toEqual({
      x: 150, y: 120, width: 150, height: 80, rotation: 0,
    });
  });

  it('drags an edge and changes only one dimension', () => {
    expect(resizeBox(box, { hx: 1, hy: 0 }, { x: 400, y: 999 })).toEqual({
      x: 100, y: 100, width: 300, height: 100, rotation: 0,
    });
  });

  it('flips over the fixed edge instead of going negative', () => {
    expect(resizeBox(box, { hx: 1, hy: 0 }, { x: 40, y: 0 })).toMatchObject({ x: 40, width: 60 });
  });

  it('never collapses below the minimum size', () => {
    expect(resizeBox(box, { hx: 1, hy: 1 }, { x: 100, y: 100 })).toMatchObject({ x: 100, y: 100, width: 1, height: 1 });
  });

  it('keeps the aspect ratio with a corner handle', () => {
    const out = resizeBox(box, { hx: 1, hy: 1 }, { x: 500, y: 150 }, { keepAspect: true });
    expect(out.width / out.height).toBeCloseTo(2);
    expect(out).toMatchObject({ x: 100, y: 100, width: 400, height: 200 });
  });

  it('resizes from the centre', () => {
    expect(resizeBox(box, { hx: 1, hy: 0 }, { x: 350, y: 0 }, { fromCenter: true })).toMatchObject({
      x: 50, width: 300, y: 100, height: 100,
    });
  });

  it('keeps the opposite corner of a rotated box fixed on the page', () => {
    const { doc, pageId } = setup();
    const rect = addLayer(doc, 'RECTANGLE', pageId, { x: 100, y: 100, width: 200, height: 100, rotation: 30 });
    const node = getLayer(rect.doc, rect.id);
    if (!node) throw new Error('missing layer');
    const cornerBefore = getWorldBounds(rect.doc, rect.id);
    const resized = resizeBox(node, { hx: 1, hy: 1 }, { x: 420, y: 330 });
    const after = patchNode(rect.doc, rect.id, resized);
    // The top-left corner (opposite the dragged one) must not have moved.
    const tlBefore = topLeft(rect.doc, rect.id);
    const tlAfter = topLeft(after, rect.id);
    expect(tlAfter.x).toBeCloseTo(tlBefore.x, 2);
    expect(tlAfter.y).toBeCloseTo(tlBefore.y, 2);
    expect(getWorldBounds(after, rect.id)).not.toEqual(cornerBefore);
    expect(getLayer(after, rect.id)?.rotation).toBe(30);
  });

  it('scales a multi-selection into new bounds', () => {
    const { doc, pageId } = setup();
    const a = addLayer(doc, 'RECTANGLE', pageId, { x: 0, y: 0, width: 100, height: 100 });
    const b = addLayer(a.doc, 'RECTANGLE', pageId, { x: 100, y: 100, width: 100, height: 100 });
    const out = resizeNodesInBounds(
      b.doc,
      [a.id, b.id],
      { x: 0, y: 0, width: 200, height: 200 },
      { x: 0, y: 0, width: 400, height: 200 },
    );
    expect(getLayer(out, a.id)).toMatchObject({ x: 0, y: 0, width: 200, height: 100 });
    expect(getLayer(out, b.id)).toMatchObject({ x: 200, y: 100, width: 200, height: 100 });
  });
});

function topLeft(doc: Document, id: NodeId): { x: number; y: number } {
  const node = getLayer(doc, id);
  if (!node) throw new Error('missing layer');
  const center = worldCenterOf(doc, id);
  const r = (node.rotation * Math.PI) / 180;
  const dx = -node.width / 2;
  const dy = -node.height / 2;
  return { x: center.x + dx * Math.cos(r) - dy * Math.sin(r), y: center.y + dx * Math.sin(r) + dy * Math.cos(r) };
}

describe('rotating', () => {
  it('rotates a layer about its own centre without moving it', () => {
    const { doc, pageId } = setup();
    const rect = addLayer(doc, 'RECTANGLE', pageId, { x: 100, y: 100, width: 200, height: 100 });
    const center = worldCenterOf(rect.doc, rect.id);
    const out = rotateNodesAround(rect.doc, [rect.id], center, 45);
    expect(getLayer(out, rect.id)).toMatchObject({ x: 100, y: 100, rotation: 45 });
  });

  it('rotates several layers about a shared pivot', () => {
    const { doc, pageId } = setup();
    const a = addLayer(doc, 'RECTANGLE', pageId, { x: 0, y: 0, width: 100, height: 100 });
    const b = addLayer(a.doc, 'RECTANGLE', pageId, { x: 200, y: 0, width: 100, height: 100 });
    const out = rotateNodesAround(b.doc, [a.id, b.id], { x: 150, y: 50 }, 180);
    expect(getLayer(out, a.id)).toMatchObject({ x: 200, y: 0, rotation: 180 });
    expect(getLayer(out, b.id)).toMatchObject({ x: 0, y: 0, rotation: 180 });
  });

  it('describes a line by its two endpoints', () => {
    const box = lineBox({ x: 10, y: 10 }, { x: 10, y: 110 });
    expect(box).toMatchObject({ width: 100, height: 0, rotation: 90 });
    const [start, end] = lineEndpoints(box);
    expect(start.x).toBeCloseTo(10);
    expect(start.y).toBeCloseTo(10);
    expect(end.x).toBeCloseTo(10);
    expect(end.y).toBeCloseTo(110);
  });
});

describe('layer order and nesting', () => {
  function three(): { doc: Document; pageId: NodeId; ids: NodeId[] } {
    const { doc, pageId } = setup();
    const a = addLayer(doc, 'RECTANGLE', pageId, { name: 'A' });
    const b = addLayer(a.doc, 'RECTANGLE', pageId, { name: 'B' });
    const c = addLayer(b.doc, 'RECTANGLE', pageId, { name: 'C' });
    return { doc: c.doc, pageId, ids: [a.id, b.id, c.id] };
  }

  it('brings to front and sends to back', () => {
    const { doc, pageId, ids } = three();
    expect(names(reorderNodes(doc, [ids[0] as NodeId], 'front'), pageId)).toEqual(['B', 'C', 'A']);
    expect(names(reorderNodes(doc, [ids[2] as NodeId], 'back'), pageId)).toEqual(['C', 'A', 'B']);
  });

  it('moves forward and backward one step', () => {
    const { doc, pageId, ids } = three();
    expect(names(reorderNodes(doc, [ids[0] as NodeId], 'forward'), pageId)).toEqual(['B', 'A', 'C']);
    expect(names(reorderNodes(doc, [ids[2] as NodeId], 'backward'), pageId)).toEqual(['A', 'C', 'B']);
  });

  it('leaves the order alone when a layer is already at the end', () => {
    const { doc, ids } = three();
    expect(reorderNodes(doc, [ids[2] as NodeId], 'front')).toBe(doc);
    expect(reorderNodes(doc, [ids[0] as NodeId], 'backward')).toBe(doc);
  });

  it('changes only the moved layer when reordering', () => {
    const { doc, ids } = three();
    const out = reorderNodes(doc, [ids[0] as NodeId], 'front');
    expect(out.nodes[ids[1] as NodeId]).toBe(doc.nodes[ids[1] as NodeId]);
    expect(out.nodes[ids[2] as NodeId]).toBe(doc.nodes[ids[2] as NodeId]);
  });

  it('reparents into a frame without moving the layer on the page', () => {
    const { doc, pageId } = setup();
    const frame = addLayer(doc, 'FRAME', pageId, { x: 300, y: 200, width: 400, height: 400 });
    const rect = addLayer(frame.doc, 'RECTANGLE', pageId, { x: 350, y: 260, width: 50, height: 50 });
    const before = getWorldBounds(rect.doc, rect.id);
    const out = reparentNodes(rect.doc, [rect.id], frame.id);
    expect(getLayer(out, rect.id)).toMatchObject({ parentId: frame.id, x: 50, y: 60 });
    expect(getWorldBounds(out, rect.id)).toEqual(before);
  });

  it('keeps the page position when moving out of a rotated frame', () => {
    const { doc, pageId } = setup();
    const frame = addLayer(doc, 'FRAME', pageId, { x: 100, y: 100, width: 300, height: 200, rotation: 40 });
    const rect = addLayer(frame.doc, 'RECTANGLE', frame.id, { x: 20, y: 30, width: 60, height: 40 });
    const before = worldCenterOf(rect.doc, rect.id);
    const out = reparentNodes(rect.doc, [rect.id], pageId);
    const after = worldCenterOf(out, rect.id);
    expect(after.x).toBeCloseTo(before.x, 2);
    expect(after.y).toBeCloseTo(before.y, 2);
    expect(getLayer(out, rect.id)).toMatchObject({ parentId: pageId, rotation: 40 });
  });

  it('never moves a frame into itself or its own contents', () => {
    const { doc, pageId } = setup();
    const outer = addLayer(doc, 'FRAME', pageId);
    const inner = addLayer(outer.doc, 'FRAME', outer.id);
    expect(reparentNodes(inner.doc, [outer.id], inner.id)).toBe(inner.doc);
    expect(reparentNodes(inner.doc, [outer.id], outer.id)).toBe(inner.doc);
  });

  it('inserts at a given index', () => {
    const { doc, pageId, ids } = three();
    const out = reparentNodes(doc, [ids[2] as NodeId], pageId, 0);
    expect(names(out, pageId)).toEqual(['C', 'A', 'B']);
  });

  it('repairs equal order keys when inserting between them', () => {
    const { doc, pageId, ids } = three();
    const broken = patchNode(doc, ids[1] as NodeId, { order: doc.nodes[ids[0] as NodeId]?.order });
    const added = addLayer(broken, 'RECTANGLE', pageId, { name: 'D' }, 1);
    const orders = getChildIds(added.doc, pageId).map((id) => added.doc.nodes[id]?.order);
    expect(new Set(orders).size).toBe(4);
    expect([...orders].sort()).toEqual(orders);
  });
});

describe('duplicate, copy and paste', () => {
  it('duplicates a frame with its contents directly above the original', () => {
    const { doc, pageId } = setup();
    const frame = addLayer(doc, 'FRAME', pageId, { name: 'Card' });
    const rect = addLayer(frame.doc, 'RECTANGLE', frame.id, { name: 'Bg' });
    const other = addLayer(rect.doc, 'ELLIPSE', pageId, { name: 'Dot' });
    const out = duplicateNodes(other.doc, [frame.id]);
    expect(names(out.doc, pageId)).toEqual(['Card', 'Card', 'Dot']);
    const copyId = out.ids[0] as NodeId;
    expect(copyId).not.toBe(frame.id);
    const copiedChildren = getChildIds(out.doc, copyId);
    expect(copiedChildren).toHaveLength(1);
    expect(copiedChildren[0]).not.toBe(rect.id);
    expect(out.doc.nodes[copiedChildren[0] as NodeId]?.name).toBe('Bg');
  });

  it('pastes into the original container at the original position', () => {
    const { doc, pageId } = setup();
    const frame = addLayer(doc, 'FRAME', pageId, { x: 100, y: 100, width: 300, height: 300 });
    const rect = addLayer(frame.doc, 'RECTANGLE', frame.id, { x: 10, y: 20 });
    const payload = copyNodes(rect.doc, [rect.id]);
    if (!payload) throw new Error('nothing copied');
    const out = pasteNodes(rect.doc, payload, { pageId });
    const pasted = getLayer(out.doc, out.ids[0] as NodeId);
    expect(pasted).toMatchObject({ parentId: frame.id, x: 10, y: 20 });
    expect(pasted?.id).not.toBe(rect.id);
  });

  it('pastes onto another page centred where asked', () => {
    const { doc, pageId } = setup();
    const rect = addLayer(doc, 'RECTANGLE', pageId, { x: 0, y: 0, width: 100, height: 100 });
    const payload = copyNodes(rect.doc, [rect.id]);
    if (!payload) throw new Error('nothing copied');
    const second = addPage(rect.doc);
    const out = pasteNodes(second.doc, payload, { pageId: second.id, center: { x: 500, y: 500 } });
    expect(getLayer(out.doc, out.ids[0] as NodeId)).toMatchObject({ parentId: second.id, x: 450, y: 450 });
  });
});

describe('pages', () => {
  it('adds, reorders, duplicates and deletes pages', () => {
    const { doc, pageId } = setup();
    const rect = addLayer(doc, 'RECTANGLE', pageId);
    const second = addPage(rect.doc);
    expect(getPages(second.doc).map((p) => p.name)).toEqual(['Page 1', 'Page 2']);

    const moved = movePage(second.doc, second.id, 0);
    expect(getPages(moved).map((p) => p.name)).toEqual(['Page 2', 'Page 1']);

    const copy = duplicatePage(second.doc, pageId);
    if (!copy) throw new Error('no copy');
    expect(getPages(copy.doc).map((p) => p.name)).toEqual(['Page 1', 'Page 1 copy', 'Page 2']);
    expect(getChildIds(copy.doc, copy.id)).toHaveLength(1);
    expect(getChildIds(copy.doc, copy.id)[0]).not.toBe(rect.id);

    const deleted = deletePage(second.doc, pageId);
    expect(getPages(deleted).map((p) => p.name)).toEqual(['Page 2']);
    expect(deleted.nodes[rect.id]).toBeUndefined();
  });

  it('refuses to delete the last page', () => {
    const { doc, pageId } = setup();
    expect(deletePage(doc, pageId)).toBe(doc);
  });
});

describe('hit testing and selection targets', () => {
  it('finds the top-most layer under a point', () => {
    const { doc, pageId } = setup();
    const a = addLayer(doc, 'RECTANGLE', pageId, { x: 0, y: 0 });
    const b = addLayer(a.doc, 'RECTANGLE', pageId, { x: 50, y: 50 });
    expect(hitTestDeepest(b.doc, pageId, { x: 75, y: 75 })).toBe(b.id);
    expect(hitTestDeepest(b.doc, pageId, { x: 25, y: 25 })).toBe(a.id);
    expect(hitTestDeepest(b.doc, pageId, { x: 500, y: 500 })).toBeNull();
  });

  it('ignores hidden and locked layers', () => {
    const { doc, pageId } = setup();
    const a = addLayer(doc, 'RECTANGLE', pageId, { x: 0, y: 0 });
    const b = addLayer(a.doc, 'RECTANGLE', pageId, { x: 0, y: 0 });
    expect(hitTestDeepest(patchNode(b.doc, b.id, { visible: false }), pageId, { x: 10, y: 10 })).toBe(a.id);
    expect(hitTestDeepest(patchNode(b.doc, b.id, { locked: true }), pageId, { x: 10, y: 10 })).toBe(a.id);
  });

  it('tests the real shape, not the bounding box', () => {
    const { doc, pageId } = setup();
    const ellipse = addLayer(doc, 'ELLIPSE', pageId, { x: 0, y: 0, width: 100, height: 100 });
    expect(hitTestDeepest(ellipse.doc, pageId, { x: 50, y: 50 })).toBe(ellipse.id);
    expect(hitTestDeepest(ellipse.doc, pageId, { x: 3, y: 3 })).toBeNull();

    const triangle = addLayer(doc, 'POLYGON', pageId, { x: 0, y: 0, width: 100, height: 100 });
    expect(hitTestDeepest(triangle.doc, pageId, { x: 50, y: 60 })).toBe(triangle.id);
    expect(hitTestDeepest(triangle.doc, pageId, { x: 5, y: 5 })).toBeNull();
  });

  it('hits a thin line within the tolerance', () => {
    const { doc, pageId } = setup();
    const line = addLayer(doc, 'LINE', pageId, { x: 0, y: 50, width: 100, height: 0 });
    expect(hitTestDeepest(line.doc, pageId, { x: 50, y: 53 }, 4)).toBe(line.id);
    expect(hitTestDeepest(line.doc, pageId, { x: 50, y: 60 }, 4)).toBeNull();
  });

  it('hits a rotated rectangle only where it really is', () => {
    const { doc, pageId } = setup();
    const rect = addLayer(doc, 'RECTANGLE', pageId, { x: 0, y: 40, width: 100, height: 20, rotation: 90 });
    // Rotated a quarter turn about its centre (50, 50) it now spans x 40..60, y 0..100.
    expect(hitTestDeepest(rect.doc, pageId, { x: 50, y: 5 })).toBe(rect.id);
    expect(hitTestDeepest(rect.doc, pageId, { x: 5, y: 50 })).toBeNull();
  });

  it('clips children to a clipping frame', () => {
    const { doc, pageId } = setup();
    const frame = addLayer(doc, 'FRAME', pageId, { x: 0, y: 0, width: 100, height: 100 });
    const rect = addLayer(frame.doc, 'RECTANGLE', frame.id, { x: 50, y: 50, width: 200, height: 200 });
    expect(hitTestDeepest(rect.doc, pageId, { x: 150, y: 150 })).toBeNull();
    const open = patchNode(rect.doc, frame.id, { clipsContent: false });
    expect(hitTestDeepest(open, pageId, { x: 150, y: 150 })).toBe(rect.id);
  });

  it('selects through a top-level frame to its child', () => {
    const { doc, pageId } = setup();
    const frame = addLayer(doc, 'FRAME', pageId, { x: 0, y: 0, width: 400, height: 400 });
    const rect = addLayer(frame.doc, 'RECTANGLE', frame.id, { x: 10, y: 10 });
    expect(selectionTargetAt(rect.doc, pageId, { x: 20, y: 20 }, [])).toBe(rect.id);
    // Empty area of a frame that has children selects nothing…
    expect(selectionTargetAt(rect.doc, pageId, { x: 300, y: 300 }, [])).toBeNull();
    // …unless the frame is already selected, so it can be dragged by its background.
    expect(selectionTargetAt(rect.doc, pageId, { x: 300, y: 300 }, [frame.id])).toBe(frame.id);
    // An empty frame is selected directly.
    expect(selectionTargetAt(frame.doc, pageId, { x: 300, y: 300 }, [])).toBe(frame.id);
  });

  it('selects the nested frame first and its content on double-click', () => {
    const { doc, pageId } = setup();
    const outer = addLayer(doc, 'FRAME', pageId, { x: 0, y: 0, width: 400, height: 400 });
    const inner = addLayer(outer.doc, 'FRAME', outer.id, { x: 50, y: 50, width: 200, height: 200 });
    const rect = addLayer(inner.doc, 'RECTANGLE', inner.id, { x: 10, y: 10 });
    const point = { x: 80, y: 80 };
    expect(selectionTargetAt(rect.doc, pageId, point, [])).toBe(inner.id);
    expect(deeperTargetAt(rect.doc, pageId, point, [inner.id])).toBe(rect.id);
    expect(selectionTargetAt(rect.doc, pageId, point, [], { deep: true })).toBe(rect.id);
    // Once working inside the nested frame, its children are selected directly.
    const sibling = addLayer(rect.doc, 'ELLIPSE', inner.id, { x: 120, y: 120, width: 50, height: 50 });
    expect(selectionTargetAt(sibling.doc, pageId, point, [sibling.id])).toBe(rect.id);
  });

  it('marquee selects touched layers, and frames only when enclosed', () => {
    const { doc, pageId } = setup();
    const frame = addLayer(doc, 'FRAME', pageId, { x: 0, y: 0, width: 300, height: 300 });
    const inside = addLayer(frame.doc, 'RECTANGLE', frame.id, { x: 10, y: 10, width: 50, height: 50 });
    const loose = addLayer(inside.doc, 'RECTANGLE', pageId, { x: 400, y: 0, width: 50, height: 50 });
    const d = loose.doc;
    expect(nodesInRect(d, pageId, { x: 0, y: 0, width: 40, height: 40 })).toEqual([inside.id]);
    expect(nodesInRect(d, pageId, { x: -10, y: -10, width: 500, height: 400 })).toEqual([frame.id, loose.id]);
    expect(nodesInRect(d, pageId, { x: 390, y: -10, width: 30, height: 30 })).toEqual([loose.id]);
    expect(nodesInRect(d, pageId, { x: 600, y: 600, width: 10, height: 10 })).toEqual([]);
  });

  it('finds the frame a new layer should go into', () => {
    const { doc, pageId } = setup();
    const outer = addLayer(doc, 'FRAME', pageId, { x: 0, y: 0, width: 400, height: 400 });
    const inner = addLayer(outer.doc, 'FRAME', outer.id, { x: 50, y: 50, width: 100, height: 100 });
    expect(containerAt(inner.doc, pageId, { x: 60, y: 60 })).toBe(inner.id);
    expect(containerAt(inner.doc, pageId, { x: 300, y: 300 })).toBe(outer.id);
    expect(containerAt(inner.doc, pageId, { x: 900, y: 900 })).toBe(pageId);
    expect(containerAt(inner.doc, pageId, { x: 60, y: 60 }, new Set([inner.id]))).toBe(outer.id);
  });
});

describe('history diff', () => {
  it('records only the properties that changed', () => {
    const { doc, pageId } = setup();
    const rect = addLayer(doc, 'RECTANGLE', pageId, { x: 0, y: 0 });
    const moved = moveNodesBy(rect.doc, [rect.id], 10, 0);
    const patch = diffDocuments(rect.doc, moved);
    expect(patch).toEqual({ nodes: { [rect.id]: { before: { x: 0 }, after: { x: 10 } } } });
  });

  it('returns null when nothing changed', () => {
    const { doc } = setup();
    expect(diffDocuments(doc, doc)).toBeNull();
    expect(diffDocuments(doc, { ...doc, nodes: { ...doc.nodes } })).toBeNull();
  });

  it('undoes and redoes creation, deletion and edits exactly', () => {
    const { doc, pageId } = setup();
    const frame = addLayer(doc, 'FRAME', pageId);
    const rect = addLayer(frame.doc, 'RECTANGLE', frame.id, { x: 5, y: 5 });
    const steps: Document[] = [doc, frame.doc, rect.doc];
    steps.push(moveNodesBy(rect.doc, [rect.id], 20, 20));
    steps.push(deleteNodes(steps[3] as Document, [frame.id]));

    for (let i = 1; i < steps.length; i++) {
      const before = steps[i - 1] as Document;
      const after = steps[i] as Document;
      const patch = diffDocuments(before, after);
      if (!patch) throw new Error('expected a patch');
      expect(applyPatch(after, patch, 'backward').nodes).toEqual(before.nodes);
      expect(applyPatch(before, patch, 'forward').nodes).toEqual(after.nodes);
    }
  });

  it('undo leaves other properties changed in the meantime untouched', () => {
    const { doc, pageId } = setup();
    const rect = addLayer(doc, 'RECTANGLE', pageId, { x: 0, y: 0 });
    const moved = moveNodesBy(rect.doc, [rect.id], 10, 0);
    const patch = diffDocuments(rect.doc, moved);
    if (!patch) throw new Error('expected a patch');
    // Someone else renames the layer after the move.
    const renamed = patchNode(moved, rect.id, { name: 'Renamed remotely' });
    const undone = applyPatch(renamed, patch, 'backward');
    expect(getLayer(undone, rect.id)).toMatchObject({ x: 0, name: 'Renamed remotely' });
  });

  it('lists every descendant in paint order', () => {
    const { doc, pageId } = setup();
    const frame = addLayer(doc, 'FRAME', pageId);
    const a = addLayer(frame.doc, 'RECTANGLE', frame.id);
    const b = addLayer(a.doc, 'RECTANGLE', frame.id);
    expect(getDescendantIds(b.doc, pageId)).toEqual([frame.id, a.id, b.id]);
  });
});
