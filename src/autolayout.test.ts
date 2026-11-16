import { describe, expect, it } from 'vitest';
import {
  addAutoLayout,
  addLayer,
  applyAutoLayout,
  approximateMeasurer,
  breakLines,
  createDocument,
  CURRENT_SCHEMA_VERSION,
  deleteNodes,
  distribute,
  flowIndexAt,
  getChildIds,
  getLayer,
  getPages,
  groupNodes,
  isAutoLayout,
  isInFlow,
  layoutDirection,
  lineSizes,
  parseFile,
  patchNode,
  patchNodes,
  placeAcross,
  placeAlong,
  placeInFlow,
  releaseSizing,
  removeAutoLayout,
  repairDocument,
  restoreLayout,
  setLayerBox,
  setLayoutDirection,
  setLayoutSizing,
  settleSizing,
  shiftInFlow,
  sizingChoices,
  stretchedAcross,
  validateDocument,
  type Document,
  type FrameNode,
  type LayerNode,
  type LayerPatch,
  type LayerType,
  type NodeId,
  type TextNode,
} from './core';
import { InteractionController, type PointerInput } from './engine/input/controller';
import { commandForKey, nudgeSelection, runCommand, type Command } from './state/commands';
import { placeImages } from './state/images';
import { createEditorStore, type EditorStore } from './state/editorStore';

/**
 * Auto Layout, from the arithmetic up to the editor store. Text is measured
 * with the approximate measurer throughout: each character is half the font
 * size wide (8px at the default 16px) and a line is 19px tall.
 */

const EMPTY = createDocument('Empty');

/** Restores everything that follows from content, as the editor store does after each change. */
const lay = (doc: Document): Document => restoreLayout(EMPTY, doc, approximateMeasurer);

interface Built {
  doc: Document;
  pageId: NodeId;
  frameId: NodeId;
}

/** A 400 × 200 Auto Layout frame at the page's origin, with the settings given. */
function frame(props: LayerPatch = {}): Built {
  const doc = createDocument('Auto Layout');
  const pageId = (getPages(doc)[0] as { id: NodeId }).id;
  const made = addLayer(doc, 'FRAME', pageId, { x: 0, y: 0, width: 400, height: 200, layoutMode: 'HORIZONTAL', ...props });
  return { doc: made.doc, pageId, frameId: made.id };
}

/** Adds children to a container, bottom first, and returns their IDs. */
function fill(doc: Document, parentId: NodeId, children: readonly (LayerPatch & { type?: LayerType })[]): { doc: Document; ids: NodeId[] } {
  let next = doc;
  const ids: NodeId[] = [];
  for (const { type = 'RECTANGLE', ...props } of children) {
    const made = addLayer(next, type, parentId, props);
    next = made.doc;
    ids.push(made.id);
  }
  return { doc: next, ids };
}

const THREE: LayerPatch[] = [
  { width: 50, height: 20 },
  { width: 60, height: 40 },
  { width: 70, height: 30 },
];

const box = (doc: Document, id: NodeId): { x: number; y: number; width: number; height: number } => {
  const node = getLayer(doc, id) as LayerNode;
  return { x: node.x, y: node.y, width: node.width, height: node.height };
};
const at = (doc: Document, id: NodeId): [number, number] => [box(doc, id).x, box(doc, id).y];
const size = (doc: Document, id: NodeId): [number, number] => [box(doc, id).width, box(doc, id).height];
const frameOf = (doc: Document, id: NodeId): FrameNode => getLayer(doc, id) as FrameNode;

const PADDED: LayerPatch = { paddingLeft: 10, paddingRight: 20, paddingTop: 30, paddingBottom: 40, itemSpacing: 8 };

describe('the arithmetic of a layout', () => {
  const fixed = (width: number) => ({ size: width, fill: false, min: 0, max: Infinity });
  const filling = (min = 0, max = Infinity) => ({ size: 0, fill: true, min, max });

  it('leaves fixed sizes alone and shares what is left between the items that fill', () => {
    expect(distribute([fixed(50), fixed(60)], 400, 10)).toEqual([50, 60]);
    expect(distribute([fixed(50), filling(), fixed(70)], 400, 10)).toEqual([50, 260, 70]);
    expect(distribute([filling(), fixed(100), filling()], 400, 0)).toEqual([150, 100, 150]);
  });

  it('settles an item that reaches its limit and shares the rest among the others', () => {
    // 300 to share: the first may have 100 at most, so the second gets 200.
    expect(distribute([filling(0, 100), filling()], 300, 0)).toEqual([100, 200]);
    // 100 to share: the first needs 80, so the second gets 20.
    expect(distribute([filling(80), filling()], 100, 0)).toEqual([80, 20]);
    // Nothing to share at all: each is as small as it may be.
    expect(distribute([fixed(300), filling(10), filling()], 200, 0)).toEqual([300, 10, 0]);
  });

  it('gives items that fill their minimum when the frame is only as big as its content', () => {
    expect(distribute([fixed(50), filling(30)], null, 10)).toEqual([50, 30]);
  });

  it('keeps a fixed size within its own limits', () => {
    expect(distribute([{ size: 50, fill: false, min: 0, max: 40 }, { size: 50, fill: false, min: 80, max: Infinity }], 400, 0)).toEqual([40, 80]);
  });

  it('breaks a row into lines that fit', () => {
    expect(breakLines([60, 60, 60, 60, 60], 180, 10)).toEqual([[0, 1], [2, 3], [4]]);
    expect(breakLines([60, 60, 60], 200, 10)).toEqual([[0, 1, 2]]);
    // Something too wide for the frame still gets a line of its own.
    expect(breakLines([300, 20, 20], 100, 10)).toEqual([[0], [1, 2]]);
    expect(breakLines([60, 60], null, 10)).toEqual([[0, 1]]);
    expect(breakLines([], 100, 10)).toEqual([]);
  });

  it('places a run of sizes at the start, in the middle, at the end or spread out', () => {
    expect(placeAlong([50, 60, 70], 300, 10, 'MIN')).toEqual([0, 60, 130]);
    expect(placeAlong([50, 60, 70], 300, 10, 'CENTER')).toEqual([50, 110, 180]);
    expect(placeAlong([50, 60, 70], 300, 10, 'MAX')).toEqual([100, 160, 230]);
    expect(placeAlong([50, 60, 70], 300, 10, 'SPACE_BETWEEN')).toEqual([0, 110, 230]);
    // Spreading out needs two items and room to spare.
    expect(placeAlong([50], 300, 10, 'SPACE_BETWEEN')).toEqual([0]);
    expect(placeAlong([200, 200], 300, 10, 'SPACE_BETWEEN')).toEqual([0, 200]);
    expect(placeAcross(40, 100, 'MIN')).toBe(0);
    expect(placeAcross(40, 100, 'CENTER')).toBe(30);
    expect(placeAcross(40, 100, 'MAX')).toBe(60);
  });

  it('makes a line as tall as its tallest item, and shares spare height between lines only when something fills', () => {
    const items = [fixed(20), fixed(40), fixed(30)];
    expect(lineSizes([[0, 1], [2]], items, null, 5, true)).toEqual([40, 30]);
    expect(lineSizes([[0, 1], [2]], items, 200, 5, true)).toEqual([40, 30]);
    expect(lineSizes([[0, 1, 2]], items, 200, 5, false)).toEqual([200]);
    expect(lineSizes([[0, 1], [2]], [fixed(20), filling(), fixed(30)], 105, 5, true)).toEqual([45, 55]);
  });
});

describe('rows and columns', () => {
  it('places children in a row, inside the padding, with the spacing between them', () => {
    const { doc, frameId } = frame(PADDED);
    const made = fill(doc, frameId, THREE);
    const laid = lay(made.doc);
    expect(made.ids.map((id) => at(laid, id))).toEqual([
      [10, 30],
      [68, 30],
      [136, 30],
    ]);
    // Sizes are the children's own, and a frame of a fixed size keeps it.
    expect(made.ids.map((id) => size(laid, id))).toEqual([
      [50, 20],
      [60, 40],
      [70, 30],
    ]);
    expect(size(laid, frameId)).toEqual([400, 200]);
  });

  it('places children in a column', () => {
    const { doc, frameId } = frame({ ...PADDED, layoutMode: 'VERTICAL' });
    const made = fill(doc, frameId, THREE);
    const laid = lay(made.doc);
    expect(made.ids.map((id) => at(laid, id))).toEqual([
      [10, 30],
      [10, 58],
      [10, 106],
    ]);
  });

  it('ignores where the children were put: the order in the stack is the order in the layout', () => {
    const { doc, frameId } = frame({ itemSpacing: 10 });
    const made = fill(doc, frameId, [
      { x: 300, y: 90, width: 50, height: 20 },
      { x: -40, y: 5, width: 60, height: 40 },
    ]);
    const laid = lay(made.doc);
    expect(made.ids.map((id) => at(laid, id))).toEqual([
      [0, 0],
      [60, 0],
    ]);
  });

  it('changes direction when the frame is told to', () => {
    const { doc, frameId } = frame(PADDED);
    const made = fill(doc, frameId, THREE);
    const column = lay(patchNode(lay(made.doc), frameId, { layoutMode: 'VERTICAL' }));
    expect(made.ids.map((id) => at(column, id))).toEqual([
      [10, 30],
      [10, 58],
      [10, 106],
    ]);
    const row = lay(patchNode(column, frameId, { layoutMode: 'HORIZONTAL' }));
    expect(made.ids.map((id) => at(row, id))).toEqual([
      [10, 30],
      [68, 30],
      [136, 30],
    ]);
  });

  it('lays a reversed frame out from the top of the stack down', () => {
    const { doc, frameId } = frame({ ...PADDED, itemsReversed: true });
    const made = fill(doc, frameId, THREE);
    const laid = lay(made.doc);
    // The last child added (70 wide) comes first.
    expect(made.ids.map((id) => at(laid, id))).toEqual([
      [156, 30],
      [88, 30],
      [10, 30],
    ]);
  });

  it('is already in order after one pass', () => {
    const { doc, frameId } = frame({ ...PADDED, layoutSizingHorizontal: 'HUG', layoutSizingVertical: 'HUG' });
    const laid = lay(fill(doc, frameId, THREE).doc);
    expect(applyAutoLayout(laid, approximateMeasurer)).toBe(laid);
    expect(lay(laid)).toBe(laid);
  });

  it('settles on sizes that do not come out as whole pixels', () => {
    const { doc, frameId } = frame({ width: 100, itemSpacing: 0 });
    const made = fill(doc, frameId, [0, 1, 2].map(() => ({ width: 10, height: 10, layoutSizingHorizontal: 'FILL' as const })));
    const laid = lay(made.doc);
    expect(made.ids.map((id) => box(laid, id).width)).toEqual([33.333, 33.333, 33.333]);
    expect(made.ids.map((id) => box(laid, id).x)).toEqual([0, 33.333, 66.667]);
    // A second pass finds nothing to do, so an edit elsewhere does not touch these layers.
    expect(applyAutoLayout(laid, approximateMeasurer)).toBe(laid);
  });

  it('leaves a document without Auto Layout untouched', () => {
    const { doc, frameId } = frame({ layoutMode: 'NONE' });
    const made = fill(doc, frameId, [{ x: 37, y: 41, width: 50, height: 20 }]);
    expect(applyAutoLayout(made.doc, approximateMeasurer)).toBe(made.doc);
    expect(at(lay(made.doc), made.ids[0] as NodeId)).toEqual([37, 41]);
  });
});

describe('alignment', () => {
  const xs = (props: LayerPatch): number[] => {
    const { doc, frameId } = frame({ ...PADDED, ...props });
    const made = fill(doc, frameId, THREE);
    const laid = lay(made.doc);
    return made.ids.map((id) => box(laid, id).x);
  };
  const ys = (props: LayerPatch): number[] => {
    const { doc, frameId } = frame({ ...PADDED, ...props });
    const made = fill(doc, frameId, THREE);
    const laid = lay(made.doc);
    return made.ids.map((id) => box(laid, id).y);
  };

  it('packs a row at its start, middle or end, or spreads it from edge to edge', () => {
    // 370 between the padding; the children and two gaps of 8 take 196.
    expect(xs({ primaryAxisAlignItems: 'MIN' })).toEqual([10, 68, 136]);
    expect(xs({ primaryAxisAlignItems: 'CENTER' })).toEqual([97, 155, 223]);
    expect(xs({ primaryAxisAlignItems: 'MAX' })).toEqual([184, 242, 310]);
    // Spread out: the first at the left padding, the last at the right, equal gaps of 95 between.
    expect(xs({ primaryAxisAlignItems: 'SPACE_BETWEEN' })).toEqual([10, 155, 310]);
  });

  it('lines a row up at the top, the middle or the bottom', () => {
    // 130 between the padding; the children are 20, 40 and 30 tall.
    expect(ys({ counterAxisAlignItems: 'MIN' })).toEqual([30, 30, 30]);
    expect(ys({ counterAxisAlignItems: 'CENTER' })).toEqual([85, 75, 80]);
    expect(ys({ counterAxisAlignItems: 'MAX' })).toEqual([140, 120, 130]);
  });

  it('does the same for a column, the other way round', () => {
    // 130 between the padding; the children and two gaps take 106.
    expect(ys({ layoutMode: 'VERTICAL', primaryAxisAlignItems: 'CENTER' })).toEqual([42, 70, 118]);
    expect(ys({ layoutMode: 'VERTICAL', primaryAxisAlignItems: 'SPACE_BETWEEN' })).toEqual([30, 70, 130]);
    expect(xs({ layoutMode: 'VERTICAL', counterAxisAlignItems: 'CENTER' })).toEqual([170, 165, 160]);
    expect(xs({ layoutMode: 'VERTICAL', counterAxisAlignItems: 'MAX' })).toEqual([330, 320, 310]);
  });
});

describe('hug contents', () => {
  const HUG: LayerPatch = { layoutSizingHorizontal: 'HUG', layoutSizingVertical: 'HUG' };

  it('makes the frame exactly as big as its children, spacing and padding', () => {
    const { doc, frameId } = frame({ ...PADDED, ...HUG });
    const laid = lay(fill(doc, frameId, THREE).doc);
    // 50 + 60 + 70, two gaps of 8, padding 10 and 20; the tallest child is 40, padding 30 and 40.
    expect(size(laid, frameId)).toEqual([226, 110]);
    expect(at(laid, frameId)).toEqual([0, 0]);
  });

  it('follows a child that is removed, added or resized', () => {
    const { doc, frameId } = frame({ ...PADDED, ...HUG });
    const made = fill(doc, frameId, THREE);
    const laid = lay(made.doc);
    const [a, b, c] = made.ids as [NodeId, NodeId, NodeId];

    const removed = lay(deleteNodes(laid, [b]));
    expect(size(removed, frameId)).toEqual([158, 100]);
    expect(at(removed, c)).toEqual([68, 30]);

    const added = lay(addLayer(laid, 'ELLIPSE', frameId, { width: 30, height: 90 }).doc);
    expect(size(added, frameId)).toEqual([264, 160]);

    const resized = lay(setLayerBox(laid, a, { width: 150 }));
    expect(size(resized, frameId)).toEqual([326, 110]);
    expect(at(resized, b)).toEqual([168, 30]);
  });

  it('keeps its size when its last child goes, and hugs again when one comes back', () => {
    const { doc, frameId } = frame({ ...PADDED, ...HUG });
    const made = fill(doc, frameId, [THREE[0] as LayerPatch]);
    const laid = lay(made.doc);
    expect(size(laid, frameId)).toEqual([80, 90]);
    const emptied = lay(deleteNodes(laid, made.ids));
    expect(frameOf(emptied, frameId)).toMatchObject({ width: 80, height: 90, layoutSizingHorizontal: 'HUG' });
    expect(size(lay(addLayer(emptied, 'RECTANGLE', frameId, { width: 200, height: 10 }).doc), frameId)).toEqual([230, 80]);
  });

  it('hugs a column too', () => {
    const { doc, frameId } = frame({ ...PADDED, ...HUG, layoutMode: 'VERTICAL' });
    const laid = lay(fill(doc, frameId, THREE).doc);
    // The widest child is 70; 20 + 40 + 30 and two gaps of 8.
    expect(size(laid, frameId)).toEqual([100, 176]);
  });

  it('keeps the top-left corner of a rotated frame where it is while it grows', () => {
    const { doc, frameId } = frame({ ...HUG, rotation: 90, x: 100, y: 100, width: 10, height: 10 });
    const before = lay(fill(doc, frameId, [{ width: 10, height: 10 }]).doc);
    const corner = (d: Document): [number, number] => {
      const node = getLayer(d, frameId) as LayerNode;
      // Turned a quarter clockwise about its centre, the box's own top-left corner is at its top right.
      return [node.x + node.width / 2 + node.height / 2, node.y + node.height / 2 - node.width / 2];
    };
    const after = lay(addLayer(before, 'RECTANGLE', frameId, { width: 50, height: 30 }).doc);
    expect(size(after, frameId)).toEqual([60, 30]);
    expect(corner(after)).toEqual(corner(before));
  });

  it('can only be asked of a frame that lays out its children, or of text', () => {
    const { doc, frameId } = frame({ layoutMode: 'NONE', ...HUG });
    const made = fill(doc, frameId, [{ width: 50, height: 20, layoutSizingHorizontal: 'HUG' }]);
    const settled = settleSizing(made.doc);
    expect(frameOf(settled, frameId)).toMatchObject({ layoutSizingHorizontal: 'FIXED', layoutSizingVertical: 'FIXED' });
    expect(getLayer(settled, made.ids[0] as NodeId)).toMatchObject({ layoutSizingHorizontal: 'FIXED' });
    expect(size(lay(made.doc), frameId)).toEqual([400, 200]);
  });
});

describe('fill container', () => {
  it('gives a child that fills the room the others leave', () => {
    const { doc, frameId } = frame(PADDED);
    const made = fill(doc, frameId, [THREE[0] as LayerPatch, { ...THREE[1], layoutSizingHorizontal: 'FILL' }, THREE[2] as LayerPatch]);
    const laid = lay(made.doc);
    const [, b, c] = made.ids as [NodeId, NodeId, NodeId];
    // 370 between the padding, less 50, 70 and two gaps of 8.
    expect(box(laid, b)).toEqual({ x: 68, y: 30, width: 234, height: 40 });
    expect(at(laid, c)).toEqual([310, 30]);
  });

  it('shares the room between several that fill', () => {
    const { doc, frameId } = frame(PADDED);
    const made = fill(doc, frameId, [
      THREE[0] as LayerPatch,
      { ...THREE[1], layoutSizingHorizontal: 'FILL' },
      { ...THREE[2], layoutSizingHorizontal: 'FILL' },
    ]);
    const laid = lay(made.doc);
    expect(made.ids.map((id) => box(laid, id).width)).toEqual([50, 152, 152]);
    expect(made.ids.map((id) => box(laid, id).x)).toEqual([10, 68, 228]);
  });

  it('stretches a child across the layout when it fills the other way', () => {
    const { doc, frameId } = frame(PADDED);
    const made = fill(doc, frameId, [{ ...THREE[0], layoutSizingVertical: 'FILL' }, THREE[1] as LayerPatch]);
    const laid = lay(made.doc);
    // The full 130 between the top and bottom padding.
    expect(box(laid, made.ids[0] as NodeId)).toEqual({ x: 10, y: 30, width: 50, height: 130 });
    const column = lay(patchNodes(made.doc, { [frameId]: { layoutMode: 'VERTICAL' }, [made.ids[1] as NodeId]: { layoutSizingHorizontal: 'FILL' } }));
    expect(box(column, made.ids[1] as NodeId)).toMatchObject({ x: 10, width: 370 });
  });

  it('follows the frame when its size changes', () => {
    const { doc, frameId } = frame(PADDED);
    const made = fill(doc, frameId, [THREE[0] as LayerPatch, { ...THREE[1], layoutSizingHorizontal: 'FILL', layoutSizingVertical: 'FILL' }, THREE[2] as LayerPatch]);
    const laid = lay(made.doc);
    const [, b, c] = made.ids as [NodeId, NodeId, NodeId];
    const wider = lay(setLayerBox(laid, frameId, { width: 500, height: 300 }));
    expect(box(wider, b)).toEqual({ x: 68, y: 30, width: 334, height: 230 });
    expect(at(wider, c)).toEqual([410, 30]);
    const narrow = lay(setLayerBox(laid, frameId, { width: 100 }));
    // Nothing is left to share: the child that fills is a pixel wide and the row overflows.
    expect(box(narrow, b).width).toBe(1);
    expect(at(narrow, c)).toEqual([77, 30]);
  });

  it('is not possible along an axis the frame hugs, or outside a frame that lays out its children', () => {
    const { doc, frameId, pageId } = frame({ layoutSizingHorizontal: 'HUG' });
    const made = fill(doc, frameId, [{ width: 50, height: 20, layoutSizingHorizontal: 'FILL', layoutSizingVertical: 'FILL' }]);
    const loose = addLayer(made.doc, 'RECTANGLE', pageId, { width: 30, height: 30, layoutSizingHorizontal: 'FILL', layoutPositioning: 'ABSOLUTE' });
    const laid = lay(loose.doc);
    // Across the row the frame has a height of its own, so the child can fill that.
    expect(getLayer(laid, made.ids[0] as NodeId)).toMatchObject({ layoutSizingHorizontal: 'FIXED', layoutSizingVertical: 'FILL', width: 50, height: 200 });
    expect(getLayer(laid, loose.id)).toMatchObject({ layoutSizingHorizontal: 'FIXED', layoutPositioning: 'AUTO', width: 30 });
    expect(size(laid, frameId)).toEqual([50, 200]);
  });

  it('is not possible for a line across its length, or for a rotated layer', () => {
    const { doc, frameId } = frame();
    const made = fill(doc, frameId, [
      { type: 'LINE', width: 80, layoutSizingHorizontal: 'FILL', layoutSizingVertical: 'FILL' },
      { width: 50, height: 20, rotation: 30, layoutSizingHorizontal: 'FILL' },
    ]);
    const laid = lay(made.doc);
    expect(getLayer(laid, made.ids[0] as NodeId)).toMatchObject({ layoutSizingHorizontal: 'FILL', layoutSizingVertical: 'FIXED', height: 0 });
    expect(getLayer(laid, made.ids[1] as NodeId)).toMatchObject({ layoutSizingHorizontal: 'FIXED', width: 50 });
  });
});

describe('minimum and maximum sizes', () => {
  it('limit how far a child that fills grows or shrinks, and the others take up the difference', () => {
    const { doc, frameId } = frame(PADDED);
    const made = fill(doc, frameId, [
      THREE[0] as LayerPatch,
      { ...THREE[1], layoutSizingHorizontal: 'FILL', maxWidth: 100 },
      { ...THREE[2], layoutSizingHorizontal: 'FILL' },
    ]);
    const laid = lay(made.doc);
    // 304 to share: the first may have 100, so the other gets 204.
    expect(made.ids.map((id) => box(laid, id).width)).toEqual([50, 100, 204]);

    const tight = lay(patchNodes(setLayerBox(laid, frameId, { width: 300 }), { [made.ids[1] as NodeId]: { maxWidth: null, minWidth: 200 } }));
    // 204 to share: the first needs 200, so the other gets 4.
    expect(made.ids.map((id) => box(tight, id).width)).toEqual([50, 200, 4]);
  });

  it('limit a frame that hugs its children', () => {
    const { doc, frameId } = frame({ ...PADDED, layoutSizingHorizontal: 'HUG', layoutSizingVertical: 'HUG', minWidth: 300, maxHeight: 90 });
    const laid = lay(fill(doc, frameId, THREE).doc);
    expect(size(laid, frameId)).toEqual([300, 90]);
    const loosened = lay(patchNode(laid, frameId, { minWidth: null, maxWidth: 200, maxHeight: null, minHeight: 150 }));
    expect(size(loosened, frameId)).toEqual([200, 150]);
  });

  it('limit sizes that were given by hand, inside a layout', () => {
    const { doc, frameId } = frame({ maxWidth: 350 });
    const made = fill(doc, frameId, [{ width: 50, height: 20, maxWidth: 40, minHeight: 25 }]);
    const laid = lay(made.doc);
    expect(size(laid, made.ids[0] as NodeId)).toEqual([40, 25]);
    expect(size(laid, frameId)).toEqual([350, 200]);
  });
});

describe('wrapping', () => {
  const WRAP: LayerPatch = {
    width: 200,
    layoutWrap: 'WRAP',
    paddingLeft: 10,
    paddingRight: 10,
    paddingTop: 10,
    paddingBottom: 10,
    itemSpacing: 10,
    counterAxisSpacing: 5,
    layoutSizingVertical: 'HUG',
  };
  const FIVE: LayerPatch[] = [0, 1, 2, 3, 4].map(() => ({ width: 60, height: 20 }));

  it('carries a row on in new lines, and the frame grows with them', () => {
    const { doc, frameId } = frame(WRAP);
    const made = fill(doc, frameId, FIVE);
    const laid = lay(made.doc);
    // 180 between the padding fits two children of 60 with a gap of 10, not three.
    expect(made.ids.map((id) => at(laid, id))).toEqual([
      [10, 10],
      [80, 10],
      [10, 35],
      [80, 35],
      [10, 60],
    ]);
    // Three lines of 20, two gaps of 5, padding 10 and 10.
    expect(size(laid, frameId)).toEqual([200, 90]);
  });

  it('breaks the lines again when the frame is made wider or narrower', () => {
    const { doc, frameId } = frame(WRAP);
    const made = fill(doc, frameId, FIVE);
    const wide = lay(setLayerBox(lay(made.doc), frameId, { width: 300 }));
    expect(made.ids.map((id) => at(wide, id))).toEqual([
      [10, 10],
      [80, 10],
      [150, 10],
      [220, 10],
      [10, 35],
    ]);
    expect(size(wide, frameId)).toEqual([300, 65]);
    const narrow = lay(setLayerBox(wide, frameId, { width: 70 }));
    expect(made.ids.map((id) => at(narrow, id))).toEqual([
      [10, 10],
      [10, 35],
      [10, 60],
      [10, 85],
      [10, 110],
    ]);
  });

  it('makes each line as tall as its tallest child and lines the others up in it', () => {
    const { doc, frameId } = frame({ ...WRAP, counterAxisAlignItems: 'MAX' });
    const made = fill(doc, frameId, [
      { width: 60, height: 20 },
      { width: 60, height: 50 },
      { width: 60, height: 30 },
    ]);
    const laid = lay(made.doc);
    expect(made.ids.map((id) => at(laid, id))).toEqual([
      [10, 40],
      [80, 10],
      [10, 65],
    ]);
    expect(size(laid, frameId)).toEqual([200, 105]);
  });

  it('lets a child that fills take what is left of its own line', () => {
    const { doc, frameId } = frame(WRAP);
    const made = fill(doc, frameId, [
      { width: 60, height: 20 },
      { width: 60, height: 20, layoutSizingHorizontal: 'FILL' },
      { width: 60, height: 20 },
      { width: 60, height: 20 },
    ]);
    const laid = lay(made.doc);
    // The second counts for a pixel when the lines are broken, so three fit; it then takes the 40 that are left.
    expect(made.ids.map((id) => box(laid, id))).toEqual([
      { x: 10, y: 10, width: 60, height: 20 },
      { x: 80, y: 10, width: 40, height: 20 },
      { x: 130, y: 10, width: 60, height: 20 },
      { x: 10, y: 35, width: 60, height: 20 },
    ]);
  });

  it('spreads the lines from top to bottom, or packs them where the row is lined up', () => {
    const fixedHeight: LayerPatch = { ...WRAP, layoutSizingVertical: 'FIXED', height: 200 };
    const ysOf = (props: LayerPatch): number[] => {
      const { doc, frameId } = frame({ ...fixedHeight, ...props });
      const made = fill(doc, frameId, FIVE);
      const laid = lay(made.doc);
      return [0, 2, 4].map((index) => box(laid, made.ids[index] as NodeId).y);
    };
    // 180 between the padding; three lines of 20.
    expect(ysOf({})).toEqual([10, 35, 60]);
    expect(ysOf({ counterAxisAlignContent: 'SPACE_BETWEEN' })).toEqual([10, 90, 170]);
    expect(ysOf({ counterAxisAlignItems: 'MAX' })).toEqual([120, 145, 170]);
    expect(ysOf({ counterAxisAlignItems: 'CENTER' })).toEqual([65, 90, 115]);
  });

  it('shares spare height between the lines when a child fills its line', () => {
    const { doc, frameId } = frame({ ...WRAP, layoutSizingVertical: 'FIXED', height: 200 });
    const made = fill(doc, frameId, [
      { width: 60, height: 20, layoutSizingVertical: 'FILL' },
      { width: 60, height: 20 },
      { width: 60, height: 20 },
    ]);
    const laid = lay(made.doc);
    // Two lines of 20 and a gap of 5 leave 135 of the 180: 67.5 more for each line.
    expect(box(laid, made.ids[0] as NodeId)).toEqual({ x: 10, y: 10, width: 60, height: 87.5 });
    expect(at(laid, made.ids[2] as NodeId)).toEqual([10, 102.5]);
  });

  it('is one of three directions a layout can be given; told to wrap, a frame that hugged its width keeps it', () => {
    const { doc, frameId, pageId } = frame({ ...WRAP, layoutWrap: 'NO_WRAP', layoutSizingHorizontal: 'HUG' });
    const made = fill(doc, frameId, FIVE);
    const laid = lay(made.doc);
    // Hugging, the row is as wide as its five children: 300, four gaps of 10 and the padding.
    expect(size(laid, frameId)).toEqual([360, 40]);
    expect(layoutDirection(frameOf(laid, frameId))).toBe('HORIZONTAL');

    const wrapping = lay(setLayoutDirection(laid, [frameId], 'WRAP'));
    expect(layoutDirection(frameOf(wrapping, frameId))).toBe('WRAP');
    expect(frameOf(wrapping, frameId)).toMatchObject({ layoutMode: 'HORIZONTAL', layoutWrap: 'WRAP', layoutSizingHorizontal: 'FIXED', width: 360 });
    // Now it has a width of its own to wrap at.
    expect(size(lay(setLayerBox(wrapping, frameId, { width: 200 })), frameId)).toEqual([200, 90]);

    const column = lay(setLayoutDirection(wrapping, [frameId], 'VERTICAL'));
    expect(frameOf(column, frameId)).toMatchObject({ layoutMode: 'VERTICAL', layoutWrap: 'NO_WRAP' });
    expect(layoutDirection(frameOf(column, frameId))).toBe('VERTICAL');
    const row = lay(setLayoutDirection(column, [frameId], 'HORIZONTAL'));
    expect(frameOf(row, frameId)).toMatchObject({ layoutMode: 'HORIZONTAL', layoutWrap: 'NO_WRAP' });

    // A frame without a layout has no direction, and is not given one this way.
    const plain = addLayer(row, 'FRAME', pageId, {});
    expect(layoutDirection(frameOf(plain.doc, plain.id))).toBeNull();
    expect(setLayoutDirection(plain.doc, [plain.id], 'WRAP')).toBe(plain.doc);
  });

  it('does not wrap a column', () => {
    const { doc, frameId } = frame({ ...WRAP, layoutMode: 'VERTICAL', layoutSizingVertical: 'FIXED', height: 50 });
    const made = fill(doc, frameId, FIVE);
    const laid = lay(made.doc);
    expect(made.ids.map((id) => at(laid, id))).toEqual([
      [10, 10],
      [10, 40],
      [10, 70],
      [10, 100],
      [10, 130],
    ]);
  });
});

describe('nested layouts', () => {
  /** A column 300 wide that hugs its height, holding a row that fills its width and hugs its height. */
  function nested(): { doc: Document; outer: NodeId; inner: NodeId; small: NodeId; wide: NodeId; below: NodeId } {
    const built = frame({
      width: 300,
      layoutMode: 'VERTICAL',
      itemSpacing: 10,
      paddingLeft: 10,
      paddingRight: 10,
      paddingTop: 10,
      paddingBottom: 10,
      layoutSizingVertical: 'HUG',
    });
    const inner = addLayer(built.doc, 'FRAME', built.frameId, {
      width: 50,
      height: 50,
      layoutMode: 'HORIZONTAL',
      itemSpacing: 5,
      paddingLeft: 5,
      paddingRight: 5,
      paddingTop: 5,
      paddingBottom: 5,
      layoutSizingHorizontal: 'FILL',
      layoutSizingVertical: 'HUG',
    });
    const row = fill(inner.doc, inner.id, [
      { width: 40, height: 30 },
      { width: 40, height: 30, layoutSizingHorizontal: 'FILL' },
    ]);
    const below = addLayer(row.doc, 'RECTANGLE', built.frameId, { width: 100, height: 20 });
    return { doc: below.doc, outer: built.frameId, inner: inner.id, small: row.ids[0] as NodeId, wide: row.ids[1] as NodeId, below: below.id };
  }

  it('sizes the inner frame from the outer one, and the outer one from the inner', () => {
    const { doc, outer, inner, small, wide, below } = nested();
    const laid = lay(doc);
    // The row fills the 280 between the column's padding and is as tall as its children and its own padding.
    expect(box(laid, inner)).toEqual({ x: 10, y: 10, width: 280, height: 40 });
    expect(box(laid, small)).toEqual({ x: 5, y: 5, width: 40, height: 30 });
    // 270 inside the row, less 40 and a gap of 5.
    expect(box(laid, wide)).toEqual({ x: 50, y: 5, width: 225, height: 30 });
    expect(at(laid, below)).toEqual([10, 60]);
    expect(size(laid, outer)).toEqual([300, 90]);
  });

  it('passes a change at any level through all of them', () => {
    const { doc, outer, inner, small, wide, below } = nested();
    const laid = lay(doc);
    // The outermost frame is made narrower: the innermost child that fills follows.
    const narrow = lay(setLayerBox(laid, outer, { width: 200 }));
    expect(box(narrow, inner).width).toBe(180);
    expect(box(narrow, wide).width).toBe(125);
    // The innermost child is made taller: every frame above it grows.
    const tall = lay(setLayerBox(laid, small, { height: 80 }));
    expect(box(tall, inner).height).toBe(90);
    expect(at(tall, below)).toEqual([10, 110]);
    expect(size(tall, outer)).toEqual([300, 140]);
    // The inner frame is emptied of one child: the other has it to itself.
    const emptied = lay(deleteNodes(laid, [small]));
    expect(box(emptied, wide)).toEqual({ x: 5, y: 5, width: 270, height: 30 });
  });

  it('lays out a frame that sits in a group inside another frame, and the frame round the group', () => {
    const built = frame({ layoutSizingHorizontal: 'HUG', layoutSizingVertical: 'HUG', itemSpacing: 10 });
    const first = addLayer(built.doc, 'RECTANGLE', built.frameId, { width: 30, height: 30 });
    const inner = addLayer(first.doc, 'FRAME', built.frameId, { width: 10, height: 10, layoutMode: 'VERTICAL', layoutSizingHorizontal: 'HUG', layoutSizingVertical: 'HUG' });
    const kids = fill(inner.doc, inner.id, [
      { width: 40, height: 15 },
      { width: 60, height: 25 },
    ]);
    const grouped = groupNodes(kids.doc, [inner.id]) as { doc: Document; id: NodeId };
    const laid = lay(grouped.doc);
    // The inner frame hugs 60 × 40; the group fits it; the outer frame hugs the rectangle, a gap and the group.
    expect(size(laid, inner.id)).toEqual([60, 40]);
    expect(box(laid, grouped.id)).toEqual({ x: 40, y: 0, width: 60, height: 40 });
    expect(size(laid, built.frameId)).toEqual([100, 40]);
    const grown = lay(setLayerBox(laid, kids.ids[1] as NodeId, { width: 90 }));
    expect(size(grown, built.frameId)).toEqual([130, 40]);
  });
});

describe('a layout inside an ordinary frame', () => {
  it('follows its constraints when that frame is resized, and its children follow it', () => {
    const doc = createDocument('Responsive');
    const pageId = (getPages(doc)[0] as { id: NodeId }).id;
    const screen = addLayer(doc, 'FRAME', pageId, { x: 0, y: 0, width: 400, height: 300 });
    // A toolbar 20 in from both sides, stretching with the screen: a title that fills, and a button at its end.
    const bar = addLayer(screen.doc, 'FRAME', screen.id, {
      x: 20,
      y: 20,
      width: 360,
      height: 40,
      layoutMode: 'HORIZONTAL',
      itemSpacing: 10,
      counterAxisAlignItems: 'CENTER',
      constraints: { horizontal: 'STRETCH', vertical: 'MIN' },
    });
    const made = fill(bar.doc, bar.id, [
      { width: 100, height: 20, layoutSizingHorizontal: 'FILL' },
      { width: 60, height: 30 },
    ]);
    const laid = lay(made.doc);
    const [title, button] = made.ids as [NodeId, NodeId];
    expect(box(laid, title)).toEqual({ x: 0, y: 10, width: 290, height: 20 });
    expect(box(laid, button)).toEqual({ x: 300, y: 5, width: 60, height: 30 });

    const wide = lay(setLayerBox(laid, screen.id, { width: 700 }));
    expect(box(wide, bar.id)).toEqual({ x: 20, y: 20, width: 660, height: 40 });
    expect(box(wide, title).width).toBe(590);
    expect(box(wide, button).x).toBe(600);

    const phone = lay(setLayerBox(laid, screen.id, { width: 200 }));
    expect(box(phone, bar.id).width).toBe(160);
    expect(box(phone, title).width).toBe(90);
    expect(box(phone, button).x).toBe(100);
  });

  it('is laid out through the editor store when the frame round it is dragged wider', () => {
    const doc = createDocument('Responsive');
    const pageId = (getPages(doc)[0] as { id: NodeId }).id;
    const screen = addLayer(doc, 'FRAME', pageId, { x: 100, y: 100, width: 400, height: 300 });
    const bar = addLayer(screen.doc, 'FRAME', screen.id, {
      x: 0,
      y: 0,
      width: 400,
      height: 40,
      layoutMode: 'HORIZONTAL',
      constraints: { horizontal: 'STRETCH', vertical: 'MIN' },
    });
    const title = addLayer(bar.doc, 'RECTANGLE', bar.id, { width: 100, height: 40, layoutSizingHorizontal: 'FILL' });
    const store = createEditorStore(lay(title.doc));
    store.getState().setCanvasSize({ width: 1000, height: 800 });
    const controller = new InteractionController(store, { requestRender: () => undefined, setCursor: () => undefined });
    store.getState().setSelection([screen.id]);
    const ptr = (x: number, y: number): PointerInput => ({ x, y, button: 0, shiftKey: false, altKey: false, ctrlKey: false, detail: 1 });
    // The right edge of the screen, dragged out by 150, in two moves.
    controller.pointerDown(ptr(500, 250));
    controller.pointerMove(ptr(580, 250));
    expect(box(store.getState().doc, title.id).width).toBe(480);
    controller.pointerMove(ptr(650, 250));
    controller.pointerUp(ptr(650, 250));
    expect(box(store.getState().doc, title.id).width).toBe(550);
    expect(store.getState().undoStack).toHaveLength(1);
    store.getState().undo();
    expect(box(store.getState().doc, title.id).width).toBe(400);
  });
});

describe('text in a layout', () => {
  /** The specification's example: a button with 24 and 12 of padding round its label. */
  function button(): { doc: Document; frameId: NodeId; textId: NodeId } {
    const built = frame({
      layoutSizingHorizontal: 'HUG',
      layoutSizingVertical: 'HUG',
      paddingLeft: 24,
      paddingRight: 24,
      paddingTop: 12,
      paddingBottom: 12,
      itemSpacing: 8,
      cornerRadius: 8,
    });
    const label = addLayer(built.doc, 'TEXT', built.frameId, { characters: 'Get Started' });
    return { doc: label.doc, frameId: built.frameId, textId: label.id };
  }

  it('sizes a button to its label', () => {
    const { doc, frameId, textId } = button();
    const laid = lay(doc);
    // Eleven characters of 8, one line of 19.
    expect(box(laid, textId)).toEqual({ x: 24, y: 12, width: 88, height: 19 });
    expect(size(laid, frameId)).toEqual([136, 43]);
  });

  it('resizes the button when its label changes, as one undo step', () => {
    const { doc, frameId, textId } = button();
    const store = createEditorStore(lay(doc));
    store.getState().apply('Edit text', (d) => patchNode(d, textId, { characters: 'Get Started Today' }));
    expect(size(store.getState().doc, frameId)).toEqual([184, 43]);
    expect(box(store.getState().doc, textId)).toEqual({ x: 24, y: 12, width: 136, height: 19 });
    store.getState().undo();
    expect(size(store.getState().doc, frameId)).toEqual([136, 43]);
    expect((getLayer(store.getState().doc, textId) as TextNode).characters).toBe('Get Started');
    store.getState().redo();
    expect(size(store.getState().doc, frameId)).toEqual([184, 43]);
  });

  it('follows every keystroke while the text is being typed', () => {
    const { doc, frameId, textId } = button();
    const store = createEditorStore(lay(doc));
    store.getState().beginGesture();
    const base = store.getState().doc;
    for (const characters of ['Get Started T', 'Get Started To', 'Go']) {
      store.getState().updateGesture(() => patchNode(base, textId, { characters }));
      expect(size(store.getState().doc, frameId)[0]).toBe(48 + characters.length * 8);
    }
    store.getState().cancelGesture();
    expect(size(store.getState().doc, frameId)).toEqual([136, 43]);
  });

  it('puts an icon and a label side by side with the gap between them', () => {
    const { doc, frameId, textId } = button();
    const icon = addLayer(doc, 'ELLIPSE', frameId, { width: 16, height: 16 }, 0);
    const laid = lay(patchNode(icon.doc, frameId, { counterAxisAlignItems: 'CENTER' }));
    expect(at(laid, icon.id)).toEqual([24, 13.5]);
    expect(at(laid, textId)).toEqual([48, 12]);
    expect(size(laid, frameId)).toEqual([160, 43]);
  });

  it('wraps text that fills a column at the width it is given, and the column hugs the lines', () => {
    const built = frame({
      width: 200,
      layoutMode: 'VERTICAL',
      layoutSizingVertical: 'HUG',
      paddingLeft: 10,
      paddingRight: 10,
      paddingTop: 10,
      paddingBottom: 10,
    });
    const text = addLayer(built.doc, 'TEXT', built.frameId, {
      characters: 'aaaa bbbb cccc dddd eeee',
      textAutoResize: 'HEIGHT',
      layoutSizingHorizontal: 'FILL',
      width: 50,
    });
    const laid = lay(text.doc);
    // 180 wide: four words and their spaces are 152, the fifth does not fit. Two lines.
    expect(box(laid, text.id)).toEqual({ x: 10, y: 10, width: 180, height: 38 });
    expect(size(laid, built.frameId)).toEqual([200, 58]);
    const wide = lay(setLayerBox(laid, built.frameId, { width: 400 }));
    expect(box(wide, text.id)).toEqual({ x: 10, y: 10, width: 380, height: 19 });
    expect(size(wide, built.frameId)).toEqual([400, 39]);
    const narrow = lay(setLayerBox(wide, built.frameId, { width: 60 }));
    // 40 wide: one word to a line.
    expect(box(narrow, text.id)).toEqual({ x: 10, y: 10, width: 40, height: 95 });
    expect(size(narrow, built.frameId)).toEqual([60, 115]);
  });

  it('says of a text what its own sizing mode does', () => {
    const built = frame();
    const made = fill(built.doc, built.frameId, [
      { type: 'TEXT', characters: 'One' },
      { type: 'TEXT', characters: 'Two', textAutoResize: 'HEIGHT', width: 60 },
      { type: 'TEXT', characters: 'Three', textAutoResize: 'NONE', width: 60, height: 30, layoutSizingVertical: 'FILL' },
    ]);
    const laid = lay(made.doc);
    const sizing = (id: NodeId): [string, string] => {
      const node = getLayer(laid, id) as LayerNode;
      return [node.layoutSizingHorizontal, node.layoutSizingVertical];
    };
    expect(made.ids.map(sizing)).toEqual([
      ['HUG', 'HUG'],
      ['FIXED', 'HUG'],
      ['FIXED', 'FILL'],
    ]);
    expect(box(laid, made.ids[2] as NodeId).height).toBe(200);
    // Changing the mode changes the sizing with it.
    const changed = lay(patchNode(laid, made.ids[0] as NodeId, { textAutoResize: 'NONE' }));
    expect(getLayer(changed, made.ids[0] as NodeId)).toMatchObject({ layoutSizingHorizontal: 'FIXED', layoutSizingVertical: 'FIXED' });
  });
});

describe('children outside the flow', () => {
  it('leaves a child that was taken out of the flow where it is, and does not count it', () => {
    const { doc, frameId } = frame({ ...PADDED, layoutSizingHorizontal: 'HUG', layoutSizingVertical: 'HUG' });
    const made = fill(doc, frameId, [THREE[0] as LayerPatch, { x: 300, y: 150, width: 60, height: 40, layoutPositioning: 'ABSOLUTE' }, THREE[2] as LayerPatch]);
    const laid = lay(made.doc);
    const [a, b, c] = made.ids as [NodeId, NodeId, NodeId];
    expect(box(laid, b)).toEqual({ x: 300, y: 150, width: 60, height: 40 });
    expect(at(laid, a)).toEqual([10, 30]);
    expect(at(laid, c)).toEqual([68, 30]);
    expect(size(laid, frameId)).toEqual([158, 100]);
    expect(isInFlow(laid, getLayer(laid, b))).toBe(false);
    expect(isInFlow(laid, getLayer(laid, a))).toBe(true);
  });

  it('moves such a child by its constraints when the frame changes size, and never the children in the flow', () => {
    const { doc, frameId } = frame(PADDED);
    const made = fill(doc, frameId, [
      { ...THREE[0], constraints: { horizontal: 'MAX', vertical: 'MAX' } },
      { x: 300, y: 150, width: 60, height: 40, layoutPositioning: 'ABSOLUTE', constraints: { horizontal: 'MAX', vertical: 'MAX' } },
    ]);
    const laid = lay(made.doc);
    const resized = lay(setLayerBox(laid, frameId, { width: 500, height: 260 }));
    expect(at(resized, made.ids[1] as NodeId)).toEqual([400, 210]);
    expect(at(resized, made.ids[0] as NodeId)).toEqual([10, 30]);
  });

  it('follows constraints when a frame that hugs changes size by itself', () => {
    const { doc, frameId } = frame({ width: 100, height: 50, layoutSizingHorizontal: 'HUG', layoutSizingVertical: 'HUG' });
    const made = fill(doc, frameId, [
      { width: 100, height: 50 },
      { x: 80, y: 0, width: 20, height: 20, layoutPositioning: 'ABSOLUTE', constraints: { horizontal: 'MAX', vertical: 'MIN' } },
    ]);
    const laid = lay(made.doc);
    expect(size(laid, frameId)).toEqual([100, 50]);
    // The badge keeps its distance to the right edge as the frame grows with its content.
    const grown = lay(setLayerBox(laid, made.ids[0] as NodeId, { width: 160 }));
    expect(size(grown, frameId)).toEqual([160, 50]);
    expect(at(grown, made.ids[1] as NodeId)).toEqual([140, 0]);
  });

  it('skips hidden children, and takes them back when they are shown', () => {
    const { doc, frameId } = frame({ ...PADDED, layoutSizingHorizontal: 'HUG' });
    const made = fill(doc, frameId, THREE);
    const laid = lay(made.doc);
    const [, b, c] = made.ids as [NodeId, NodeId, NodeId];
    const hidden = lay(patchNode(laid, b, { visible: false }));
    expect(at(hidden, c)).toEqual([68, 30]);
    expect(size(hidden, frameId)[0]).toBe(158);
    const shown = lay(patchNode(hidden, b, { visible: true }));
    expect(at(shown, c)).toEqual([136, 30]);
    expect(size(shown, frameId)[0]).toBe(226);
  });

  it('lets a hidden child keep the sizing it has in the layout', () => {
    const { doc, frameId } = frame(PADDED);
    const made = fill(doc, frameId, [THREE[0] as LayerPatch, { ...THREE[1], layoutSizingHorizontal: 'FILL' }]);
    const laid = lay(made.doc);
    const b = made.ids[1] as NodeId;
    expect(box(laid, b).width).toBe(312);
    const hidden = lay(setLayerBox(patchNode(laid, b, { visible: false }), frameId, { width: 300 }));
    expect(getLayer(hidden, b)).toMatchObject({ layoutSizingHorizontal: 'FILL', width: 312 });
    expect(sizingChoices(hidden, b, 'horizontal')).toEqual(['FIXED', 'FILL']);
    // Shown again, it fills the frame as the frame now is.
    expect(box(lay(patchNode(hidden, b, { visible: true })), b).width).toBe(212);
  });

  it('gives a rotated child the room of the box round it', () => {
    const { doc, frameId } = frame({ layoutSizingHorizontal: 'HUG', layoutSizingVertical: 'HUG', itemSpacing: 10 });
    const made = fill(doc, frameId, [
      { width: 100, height: 20, rotation: 90 },
      { width: 30, height: 30 },
    ]);
    const laid = lay(made.doc);
    // Turned a quarter, the first takes 20 × 100; its own box is centred on that.
    expect(box(laid, made.ids[0] as NodeId)).toEqual({ x: -40, y: 40, width: 100, height: 20 });
    expect(at(laid, made.ids[1] as NodeId)).toEqual([30, 0]);
    expect(size(laid, frameId)).toEqual([60, 100]);
  });
});

describe('switching Auto Layout on and off', () => {
  it('reads direction, spacing, padding and alignment off a frame whose children are side by side', () => {
    const { doc, frameId } = frame({ layoutMode: 'NONE' });
    const made = fill(doc, frameId, [
      // Added out of order: the stack is not the order they stand in.
      { x: 150, y: 50, width: 60, height: 40 },
      { x: 20, y: 60, width: 100, height: 20 },
      { x: 240, y: 55, width: 80, height: 30 },
    ]);
    const out = addAutoLayout(made.doc, [frameId]) as { doc: Document; id: NodeId };
    expect(out.id).toBe(frameId);
    const laid = lay(out.doc);
    expect(frameOf(laid, frameId)).toMatchObject({
      layoutMode: 'HORIZONTAL',
      itemSpacing: 30,
      counterAxisAlignItems: 'CENTER',
      paddingLeft: 20,
      paddingTop: 50,
      paddingRight: 80,
      paddingBottom: 110,
      layoutSizingHorizontal: 'HUG',
      layoutSizingVertical: 'HUG',
    });
    // Nothing moves, and the frame is the size it was.
    expect(made.ids.map((id) => at(laid, id))).toEqual([
      [150, 50],
      [20, 60],
      [240, 55],
    ]);
    expect(size(laid, frameId)).toEqual([400, 200]);
    // The stack now runs from left to right.
    expect(getChildIds(laid, frameId)).toEqual([made.ids[1], made.ids[0], made.ids[2]]);
  });

  it('reads a column off children that are one under another', () => {
    const { doc, frameId } = frame({ layoutMode: 'NONE' });
    const made = fill(doc, frameId, [
      { x: 30, y: 20, width: 100, height: 40 },
      { x: 30, y: 72, width: 80, height: 40 },
      { x: 30, y: 124, width: 120, height: 40 },
    ]);
    const laid = lay((addAutoLayout(made.doc, [frameId]) as { doc: Document }).doc);
    expect(frameOf(laid, frameId)).toMatchObject({ layoutMode: 'VERTICAL', itemSpacing: 12, counterAxisAlignItems: 'MIN', paddingLeft: 30, paddingTop: 20 });
    expect(made.ids.map((id) => at(laid, id))).toEqual([
      [30, 20],
      [30, 72],
      [30, 124],
    ]);
  });

  it('gives an empty frame a layout and leaves its size alone', () => {
    const { doc, frameId } = frame({ layoutMode: 'NONE' });
    const laid = lay((addAutoLayout(doc, [frameId]) as { doc: Document }).doc);
    expect(frameOf(laid, frameId)).toMatchObject({ layoutMode: 'HORIZONTAL', layoutSizingHorizontal: 'FIXED', width: 400, height: 200 });
  });

  it('puts other layers into a new frame that lays them out where they are', () => {
    const doc = createDocument('Wrap');
    const pageId = (getPages(doc)[0] as { id: NodeId }).id;
    const made = fill(doc, pageId, [
      { x: 100, y: 100, width: 50, height: 50 },
      { x: 170, y: 100, width: 50, height: 50 },
    ]);
    const out = addAutoLayout(made.doc, made.ids) as { doc: Document; id: NodeId };
    const laid = lay(out.doc);
    expect(getLayer(laid, out.id)).toMatchObject({
      type: 'FRAME',
      name: 'Frame 1',
      x: 100,
      y: 100,
      width: 120,
      height: 50,
      layoutMode: 'HORIZONTAL',
      itemSpacing: 20,
      fills: [],
      clipsContent: false,
      layoutSizingHorizontal: 'HUG',
    });
    expect(getChildIds(laid, out.id)).toEqual(made.ids);
    expect(made.ids.map((id) => at(laid, id))).toEqual([
      [0, 0],
      [70, 0],
    ]);
    expect(getChildIds(laid, pageId)).toEqual([out.id]);
  });

  it('wraps a single text as the start of a button, and a frame that already has a layout in another', () => {
    const doc = createDocument('Wrap');
    const pageId = (getPages(doc)[0] as { id: NodeId }).id;
    const text = addLayer(doc, 'TEXT', pageId, { x: 40, y: 60, characters: 'Buy' });
    const first = addAutoLayout(lay(text.doc), [text.id]) as { doc: Document; id: NodeId };
    const laid = lay(first.doc);
    expect(box(laid, first.id)).toEqual({ x: 40, y: 60, width: 24, height: 19 });
    const second = addAutoLayout(laid, [first.id]) as { doc: Document; id: NodeId };
    expect(second.id).not.toBe(first.id);
    expect(getLayer(second.doc, first.id)?.parentId).toBe(second.id);
  });

  it('switches off, leaving the children where the layout put them', () => {
    const { doc, frameId } = frame({ ...PADDED, layoutSizingHorizontal: 'HUG' });
    const made = fill(doc, frameId, [THREE[0] as LayerPatch, { ...THREE[1], layoutSizingVertical: 'FILL' }]);
    const laid = lay(made.doc);
    const off = lay(removeAutoLayout(laid, [frameId]));
    expect(isAutoLayout(getLayer(off, frameId))).toBe(false);
    expect(made.ids.map((id) => box(off, id))).toEqual(made.ids.map((id) => box(laid, id)));
    // Settings that only mean something in a layout are back to "fixed".
    expect(getLayer(off, made.ids[1] as NodeId)).toMatchObject({ layoutSizingVertical: 'FIXED', height: 130 });
    expect(frameOf(off, frameId)).toMatchObject({ layoutSizingHorizontal: 'FIXED', width: 148 });
    // Free again: a child can be put anywhere.
    expect(at(lay(patchNode(off, made.ids[0] as NodeId, { x: 200, y: 5 })), made.ids[0] as NodeId)).toEqual([200, 5]);
  });
});

describe('choosing how a layer is sized', () => {
  it('offers what can apply where the layer is', () => {
    const { doc, frameId, pageId } = frame();
    const made = fill(doc, frameId, [{ width: 50, height: 20 }, { type: 'TEXT', characters: 'Hi' }, { type: 'LINE', width: 40 }]);
    const loose = addLayer(made.doc, 'RECTANGLE', pageId, {});
    const [rect, text, line] = made.ids as [NodeId, NodeId, NodeId];
    expect(sizingChoices(loose.doc, rect, 'horizontal')).toEqual(['FIXED', 'FILL']);
    expect(sizingChoices(loose.doc, text, 'horizontal')).toEqual(['FIXED', 'HUG', 'FILL']);
    expect(sizingChoices(loose.doc, line, 'vertical')).toEqual(['FIXED']);
    expect(sizingChoices(loose.doc, frameId, 'vertical')).toEqual(['FIXED', 'HUG']);
    expect(sizingChoices(loose.doc, loose.id, 'horizontal')).toEqual(['FIXED']);
  });

  it('makes a frame that hugged keep its size when a child is told to fill it', () => {
    const { doc, frameId } = frame({ ...PADDED, layoutSizingHorizontal: 'HUG', layoutSizingVertical: 'HUG' });
    const made = fill(doc, frameId, THREE);
    const laid = lay(made.doc);
    const filled = lay(setLayoutSizing(laid, [made.ids[1] as NodeId], 'horizontal', 'FILL'));
    expect(frameOf(filled, frameId)).toMatchObject({ layoutSizingHorizontal: 'FIXED', layoutSizingVertical: 'HUG', width: 226 });
    expect(getLayer(filled, made.ids[1] as NodeId)).toMatchObject({ layoutSizingHorizontal: 'FILL', width: 60 });
    // Now the frame can be made wider and the child takes the room.
    expect(box(lay(setLayerBox(filled, frameId, { width: 326 })), made.ids[1] as NodeId).width).toBe(160);
  });

  it('makes children that filled keep their size when the frame is told to hug', () => {
    const { doc, frameId } = frame(PADDED);
    const made = fill(doc, frameId, [THREE[0] as LayerPatch, { ...THREE[1], layoutSizingHorizontal: 'FILL' }]);
    const laid = lay(made.doc);
    const hugging = lay(setLayoutSizing(laid, [frameId], 'horizontal', 'HUG'));
    expect(getLayer(hugging, made.ids[1] as NodeId)).toMatchObject({ layoutSizingHorizontal: 'FIXED', width: 312 });
    expect(size(hugging, frameId)[0]).toBe(400);
  });

  it('sets a text’s own sizing mode to match', () => {
    const { doc, frameId } = frame({ layoutMode: 'VERTICAL' });
    const text = addLayer(doc, 'TEXT', frameId, { characters: 'Hello there' });
    const laid = lay(text.doc);
    const mode = (d: Document): string => (getLayer(d, text.id) as TextNode).textAutoResize;
    const filled = lay(setLayoutSizing(laid, [text.id], 'horizontal', 'FILL'));
    expect(mode(filled)).toBe('HEIGHT');
    expect(getLayer(filled, text.id)).toMatchObject({ layoutSizingHorizontal: 'FILL', layoutSizingVertical: 'HUG', width: 400 });
    const fixedHeight = lay(setLayoutSizing(filled, [text.id], 'vertical', 'FIXED'));
    expect(mode(fixedHeight)).toBe('NONE');
    const hugHeight = lay(setLayoutSizing(fixedHeight, [text.id], 'vertical', 'HUG'));
    expect(mode(hugHeight)).toBe('HEIGHT');
    const hugWidth = lay(setLayoutSizing(hugHeight, [text.id], 'horizontal', 'HUG'));
    expect(mode(hugWidth)).toBe('WIDTH_AND_HEIGHT');
    expect(getLayer(hugWidth, text.id)).toMatchObject({ layoutSizingHorizontal: 'HUG', width: 88 });
    const fixedWidth = lay(setLayoutSizing(hugWidth, [text.id], 'horizontal', 'FIXED'));
    expect(mode(fixedWidth)).toBe('HEIGHT');
  });

  it('ignores a choice that cannot apply', () => {
    const { doc, frameId, pageId } = frame();
    const loose = addLayer(doc, 'RECTANGLE', pageId, {});
    expect(setLayoutSizing(loose.doc, [loose.id], 'horizontal', 'FILL')).toBe(loose.doc);
    expect(setLayoutSizing(loose.doc, [loose.id], 'horizontal', 'HUG')).toBe(loose.doc);
    expect(setLayoutSizing(loose.doc, [frameId], 'horizontal', 'FILL')).toBe(loose.doc);
  });

  it('lets a size given by hand stand: resizing a layer that hugged or filled makes it fixed', () => {
    const { doc, frameId } = frame({ ...PADDED, layoutSizingHorizontal: 'HUG', layoutSizingVertical: 'HUG' });
    const made = fill(doc, frameId, [{ ...THREE[0], layoutSizingVertical: 'FILL' }, THREE[1] as LayerPatch]);
    const laid = lay(made.doc);
    const dragged = lay(releaseSizing(setLayerBox(laid, frameId, { width: 300 }), [frameId], { horizontal: true }));
    expect(frameOf(dragged, frameId)).toMatchObject({ layoutSizingHorizontal: 'FIXED', layoutSizingVertical: 'HUG', width: 300 });
    const child = made.ids[0] as NodeId;
    const pulled = lay(releaseSizing(setLayerBox(laid, child, { height: 25 }), [child], { vertical: true }));
    expect(getLayer(pulled, child)).toMatchObject({ layoutSizingVertical: 'FIXED', height: 25 });
  });
});

describe('a place in the flow', () => {
  /** A row of three squares of 50 with gaps of 10, starting at the frame's left edge. */
  function row(props: LayerPatch = {}): { doc: Document; frameId: NodeId; ids: NodeId[]; pageId: NodeId } {
    const built = frame({ x: 100, y: 100, itemSpacing: 10, ...props });
    const made = fill(built.doc, built.frameId, [0, 1, 2].map(() => ({ width: 50, height: 50 })));
    return { doc: lay(made.doc), frameId: built.frameId, ids: made.ids, pageId: built.pageId };
  }
  const order = (doc: Document, frameId: NodeId): readonly NodeId[] => getChildIds(doc, frameId);

  it('finds where in the stack a point on the page puts a layer', () => {
    const { doc, frameId } = row();
    // The squares' middles are at 125, 185 and 245 on the page.
    expect(flowIndexAt(doc, frameId, { x: 110, y: 120 })).toBe(0);
    expect(flowIndexAt(doc, frameId, { x: 150, y: 120 })).toBe(1);
    expect(flowIndexAt(doc, frameId, { x: 200, y: 120 })).toBe(2);
    expect(flowIndexAt(doc, frameId, { x: 400, y: 120 })).toBe(3);
  });

  it('moves a child to the place a point is over', () => {
    const { doc, frameId, ids } = row();
    const [a, b, c] = ids as [NodeId, NodeId, NodeId];
    const toEnd = lay(placeInFlow(doc, [a], { x: 300, y: 120 }));
    expect(order(toEnd, frameId)).toEqual([b, c, a]);
    expect(at(toEnd, a)).toEqual([120, 0]);
    expect(at(toEnd, b)).toEqual([0, 0]);
    const toMiddle = lay(placeInFlow(doc, [c], { x: 170, y: 120 }));
    expect(order(toMiddle, frameId)).toEqual([a, c, b]);
    // Over its own place nothing changes, however often the layer has been moved about before.
    expect(placeInFlow(doc, [b], { x: 185, y: 120 })).toBe(doc);
    let shuffled = doc;
    for (const x of [300, 101, 170, 300, 170, 101]) shuffled = lay(placeInFlow(shuffled, [b], { x, y: 120 }));
    expect(order(shuffled, frameId)).toEqual([b, a, c]);
    expect(placeInFlow(shuffled, [b], { x: 101, y: 120 })).toBe(shuffled);
    expect(placeInFlow(shuffled, [a], { x: 185, y: 120 })).toBe(shuffled);
  });

  it('works in a column, a reversed frame and a wrapping row', () => {
    const column = row({ layoutMode: 'VERTICAL' });
    expect(order(placeInFlow(column.doc, [column.ids[0] as NodeId], { x: 120, y: 300 }), column.frameId)).toEqual([column.ids[1], column.ids[2], column.ids[0]]);

    const reversed = row({ itemsReversed: true });
    // Reversed, the last child added is the first in the row; dropping the first-added at the far left puts it on top of the stack.
    expect(order(placeInFlow(reversed.doc, [reversed.ids[0] as NodeId], { x: 101, y: 120 }), reversed.frameId)).toEqual([
      reversed.ids[1],
      reversed.ids[2],
      reversed.ids[0],
    ]);

    const wrapping = row({ width: 120, layoutWrap: 'WRAP', counterAxisSpacing: 10 });
    // Two squares on the first line, one on the second, which starts at 160 on the page.
    expect(at(wrapping.doc, wrapping.ids[2] as NodeId)).toEqual([0, 60]);
    const dropped = placeInFlow(wrapping.doc, [wrapping.ids[0] as NodeId], { x: 190, y: 190 });
    expect(order(dropped, wrapping.frameId)).toEqual([wrapping.ids[1], wrapping.ids[2], wrapping.ids[0]]);
  });

  it('leaves children outside the flow out of the count', () => {
    const { doc, frameId, ids } = row();
    const badge = addLayer(doc, 'ELLIPSE', frameId, { x: 0, y: 0, width: 10, height: 10, layoutPositioning: 'ABSOLUTE' }, 1);
    const laid = lay(badge.doc);
    const moved = placeInFlow(laid, [ids[2] as NodeId], { x: 101, y: 120 });
    expect(order(moved, frameId).filter((id) => id !== badge.id)).toEqual([ids[2], ids[0], ids[1]]);
    expect(placeInFlow(laid, [badge.id], { x: 300, y: 120 })).toBe(laid);
  });

  it('moves a child one place along with the arrow keys’ operation', () => {
    const { doc, frameId, ids } = row();
    const [a, b, c] = ids as [NodeId, NodeId, NodeId];
    const later = shiftInFlow(doc, [a], 1) as Document;
    expect(order(later, frameId)).toEqual([b, a, c]);
    expect(order(shiftInFlow(later, [a], 1) as Document, frameId)).toEqual([b, c, a]);
    // At the end there is nowhere further to go.
    expect(shiftInFlow(doc, [c], 1)).toBe(doc);
    expect(order(shiftInFlow(doc, [b, c], -1) as Document, frameId)).toEqual([b, c, a]);
    // A layer that no frame places is not this operation's business.
    expect(shiftInFlow(doc, [frameId], 1)).toBeNull();
  });
});

describe('Auto Layout in the file format', () => {
  it('opens a version 14 file: frames without a layout and layers of the size they were given', () => {
    const { doc, frameId } = frame({ layoutMode: 'NONE' });
    const made = fill(doc, frameId, [
      { width: 50, height: 20 },
      { type: 'TEXT', characters: 'Hello' },
      { type: 'TEXT', characters: 'Wrapped', textAutoResize: 'HEIGHT', width: 40 },
      { type: 'TEXT', characters: 'Boxed', textAutoResize: 'NONE', width: 40, height: 40 },
    ]);
    const current = lay(made.doc);
    const v14 = JSON.parse(JSON.stringify(current)) as { nodes: Record<string, Record<string, unknown>> };
    const added = [
      'layoutSizingHorizontal',
      'layoutSizingVertical',
      'layoutPositioning',
      'minWidth',
      'maxWidth',
      'minHeight',
      'maxHeight',
      'layoutMode',
      'layoutWrap',
      'primaryAxisAlignItems',
      'counterAxisAlignItems',
      'counterAxisAlignContent',
      'itemSpacing',
      'counterAxisSpacing',
      'paddingLeft',
      'paddingRight',
      'paddingTop',
      'paddingBottom',
      'itemsReversed',
    ];
    for (const id in v14.nodes) for (const key of added) delete (v14.nodes[id] as Record<string, unknown>)[key];
    const parsed = parseFile({
      format: 'open-design',
      schemaVersion: 14,
      meta: { createdAt: '2026-11-16T10:00:00.000Z', updatedAt: '2026-11-16T10:00:00.000Z' },
      document: v14,
    });
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(15);
    expect(parsed.file.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(parsed.repairs).toEqual([]);
    expect(parsed.file.document).toEqual(current);
    expect(frameOf(parsed.file.document, frameId)).toMatchObject({ layoutMode: 'NONE', itemSpacing: 0, layoutSizingHorizontal: 'FIXED' });
    expect(getLayer(parsed.file.document, made.ids[1] as NodeId)).toMatchObject({ layoutSizingHorizontal: 'HUG', layoutSizingVertical: 'HUG' });
    expect(getLayer(parsed.file.document, made.ids[2] as NodeId)).toMatchObject({ layoutSizingHorizontal: 'FIXED', layoutSizingVertical: 'HUG' });
    expect(getLayer(parsed.file.document, made.ids[3] as NodeId)).toMatchObject({ layoutSizingHorizontal: 'FIXED', layoutSizingVertical: 'FIXED' });
    // Nothing about it needs laying out.
    expect(lay(parsed.file.document)).toBe(parsed.file.document);
  });

  it('keeps a layout through saving and opening', () => {
    const { doc, frameId } = frame({ ...PADDED, layoutWrap: 'WRAP', primaryAxisAlignItems: 'SPACE_BETWEEN', counterAxisAlignContent: 'SPACE_BETWEEN', itemsReversed: true });
    const made = fill(doc, frameId, [{ ...THREE[0], layoutSizingHorizontal: 'FILL', minWidth: 20, maxWidth: 300 }, { ...THREE[1], layoutPositioning: 'ABSOLUTE' }]);
    const laid = lay(made.doc);
    expect(validateDocument(laid)).toEqual([]);
    const reopened = repairDocument(JSON.parse(JSON.stringify(laid)));
    expect(reopened.repairs).toEqual([]);
    expect(reopened.doc).toEqual(laid);
  });

  it('repairs values that are not what they should be', () => {
    const { doc, frameId } = frame({ layoutMode: 'VERTICAL' });
    const made = fill(doc, frameId, [{ width: 50, height: 20 }, { type: 'TEXT', characters: 'Hello' }]);
    const raw = JSON.parse(JSON.stringify(made.doc)) as { nodes: Record<string, Record<string, unknown>> };
    Object.assign(raw.nodes[frameId] as Record<string, unknown>, {
      layoutMode: 'DIAGONAL',
      layoutWrap: 'SOMETIMES',
      primaryAxisAlignItems: 'STRETCH',
      counterAxisAlignItems: 'SPACE_BETWEEN',
      itemSpacing: 'wide',
      paddingLeft: -5,
      paddingTop: null,
      itemsReversed: 'yes',
    });
    Object.assign(raw.nodes[made.ids[0] as NodeId] as Record<string, unknown>, {
      layoutSizingHorizontal: 'GROW',
      layoutPositioning: 'FLOATING',
      minWidth: -10,
      maxWidth: 'none',
      minHeight: Number.NaN,
    });
    // A text that says it is fixed while its own mode fits it to its content.
    Object.assign(raw.nodes[made.ids[1] as NodeId] as Record<string, unknown>, { layoutSizingHorizontal: 'FIXED', layoutSizingVertical: 'FILL' });
    const repaired = repairDocument(raw);
    expect(repaired.repairs.length).toBeGreaterThan(0);
    expect(frameOf(repaired.doc, frameId)).toMatchObject({
      layoutMode: 'NONE',
      layoutWrap: 'NO_WRAP',
      primaryAxisAlignItems: 'MIN',
      counterAxisAlignItems: 'MIN',
      itemSpacing: 0,
      paddingLeft: 0,
      paddingTop: 0,
      itemsReversed: false,
    });
    expect(getLayer(repaired.doc, made.ids[0] as NodeId)).toMatchObject({
      layoutSizingHorizontal: 'FIXED',
      layoutPositioning: 'AUTO',
      minWidth: 0,
      maxWidth: null,
      minHeight: null,
    });
    expect(getLayer(repaired.doc, made.ids[1] as NodeId)).toMatchObject({ layoutSizingHorizontal: 'HUG', layoutSizingVertical: 'HUG' });
    // Only rows wrap.
    const column = JSON.parse(JSON.stringify(made.doc)) as { nodes: Record<string, Record<string, unknown>> };
    Object.assign(column.nodes[frameId] as Record<string, unknown>, { layoutWrap: 'WRAP' });
    expect(frameOf(repairDocument(column).doc, frameId).layoutWrap).toBe('NO_WRAP');
  });
});

describe('stretch', () => {
  const STRETCH: LayerPatch = { ...PADDED, counterAxisAlignItems: 'STRETCH' };
  const heights = (doc: Document, ids: readonly NodeId[]): number[] => ids.map((id) => box(doc, id).height);
  const widthsOf = (doc: Document, ids: readonly NodeId[]): number[] => ids.map((id) => box(doc, id).width);

  it('makes every child of a row as tall as the frame has room, whatever its own sizing', () => {
    const { doc, frameId } = frame(STRETCH);
    const made = fill(doc, frameId, [THREE[0] as LayerPatch, { ...THREE[1], layoutSizingVertical: 'FILL' }, { ...THREE[2], minHeight: 10 }]);
    const laid = lay(made.doc);
    // 130 between the top and bottom padding.
    expect(heights(laid, made.ids)).toEqual([130, 130, 130]);
    expect(made.ids.map((id) => at(laid, id))).toEqual([
      [10, 30],
      [68, 30],
      [136, 30],
    ]);
    // Widths are their own, and what each child says about its height is kept, unused.
    expect(widthsOf(laid, made.ids)).toEqual([50, 60, 70]);
    expect(made.ids.map((id) => (getLayer(laid, id) as LayerNode).layoutSizingVertical)).toEqual(['FIXED', 'FILL', 'FIXED']);
    expect(made.ids.map((id) => stretchedAcross(laid, getLayer(laid, id)))).toEqual(['vertical', 'vertical', 'vertical']);
  });

  it('makes every child of a column as wide as the frame has room', () => {
    const { doc, frameId } = frame({ ...STRETCH, layoutMode: 'VERTICAL' });
    const made = fill(doc, frameId, THREE);
    const laid = lay(made.doc);
    expect(widthsOf(laid, made.ids)).toEqual([370, 370, 370]);
    expect(heights(laid, made.ids)).toEqual([20, 40, 30]);
    expect(made.ids.map((id) => box(laid, id).x)).toEqual([10, 10, 10]);
    expect(stretchedAcross(laid, getLayer(laid, made.ids[0] as NodeId))).toBe('horizontal');
  });

  it('follows the frame, within each child’s own limits', () => {
    const { doc, frameId } = frame(STRETCH);
    const made = fill(doc, frameId, [THREE[0] as LayerPatch, { ...THREE[1], maxHeight: 100 }, { ...THREE[2], minHeight: 150 }]);
    const laid = lay(made.doc);
    expect(heights(laid, made.ids)).toEqual([130, 100, 150]);
    const taller = lay(setLayerBox(laid, frameId, { height: 300 }));
    expect(heights(taller, made.ids)).toEqual([230, 100, 230]);
    const shorter = lay(setLayerBox(laid, frameId, { height: 100 }));
    expect(heights(shorter, made.ids)).toEqual([30, 30, 150]);
  });

  it('leaves alone what cannot be stretched: a rotated child, a line, and text that fits itself to its content', () => {
    const { doc, frameId } = frame(STRETCH);
    const made = fill(doc, frameId, [
      { width: 60, height: 20, rotation: 90 },
      { type: 'LINE', width: 40 },
      { type: 'TEXT', characters: 'Label' },
      { type: 'TEXT', characters: 'Boxed', textAutoResize: 'NONE', width: 50, height: 25 },
    ]);
    const laid = lay(made.doc);
    const [turned, line, label, boxed] = made.ids as [NodeId, NodeId, NodeId, NodeId];
    expect(size(laid, turned)).toEqual([60, 20]);
    expect(box(laid, line).height).toBe(0);
    expect(box(laid, label).height).toBe(19);
    // A text with a box of its own is stretched like any other layer.
    expect(box(laid, boxed).height).toBe(130);
    // What is not stretched sits at the top.
    expect(box(laid, label).y).toBe(30);
    expect(box(laid, line).y).toBe(30);
    expect([turned, line, label, boxed].map((id) => stretchedAcross(laid, getLayer(laid, id)))).toEqual([null, null, null, 'vertical']);
  });

  it('stretches text that wraps to the width of a column, and its height follows', () => {
    const { doc, frameId } = frame({ counterAxisAlignItems: 'STRETCH', layoutMode: 'VERTICAL', width: 150 });
    const made = fill(doc, frameId, [
      { type: 'TEXT', characters: 'aaaa bbbb cccc dddd eeee', textAutoResize: 'HEIGHT', width: 40 },
      { type: 'TEXT', characters: 'Label' },
    ]);
    const laid = lay(made.doc);
    // 150 wide: three words and their spaces fit, the other two go to a second line.
    expect(box(laid, made.ids[0] as NodeId)).toEqual({ x: 0, y: 0, width: 150, height: 38 });
    // Text that sets its own width keeps it.
    expect(box(laid, made.ids[1] as NodeId)).toEqual({ x: 0, y: 38, width: 40, height: 19 });
  });

  it('stretches a frame nested in the row, and that frame lays its own children out in the room it gets', () => {
    const { doc, frameId } = frame(STRETCH);
    const inner = addLayer(doc, 'FRAME', frameId, {
      width: 10,
      height: 10,
      layoutMode: 'VERTICAL',
      primaryAxisAlignItems: 'MAX',
      layoutSizingHorizontal: 'HUG',
      layoutSizingVertical: 'HUG',
    });
    const kids = fill(inner.doc, inner.id, [{ width: 40, height: 15 }]);
    const laid = lay(kids.doc);
    // It hugs its width, but its height is the row's: its child sits at the bottom of that.
    expect(box(laid, inner.id)).toEqual({ x: 10, y: 30, width: 40, height: 130 });
    expect(at(laid, kids.ids[0] as NodeId)).toEqual([0, 115]);
    expect(frameOf(laid, inner.id).layoutSizingVertical).toBe('HUG');
  });

  it('keeps a frame from hugging across its layout: one that hugged keeps the size it has', () => {
    const { doc, frameId } = frame({ ...PADDED, layoutSizingHorizontal: 'HUG', layoutSizingVertical: 'HUG' });
    const made = fill(doc, frameId, THREE);
    const hugging = lay(made.doc);
    expect(size(hugging, frameId)).toEqual([226, 110]);
    const stretched = lay(patchNode(hugging, frameId, { counterAxisAlignItems: 'STRETCH' }));
    // Along the row it still hugs; across it, it is now fixed at the height it had, and the children take that.
    expect(frameOf(stretched, frameId)).toMatchObject({ layoutSizingHorizontal: 'HUG', layoutSizingVertical: 'FIXED', width: 226, height: 110 });
    expect(heights(stretched, made.ids)).toEqual([40, 40, 40]);
    expect(sizingChoices(stretched, frameId, 'vertical')).toEqual(['FIXED']);
    expect(sizingChoices(stretched, frameId, 'horizontal')).toEqual(['FIXED', 'HUG']);
    expect(setLayoutSizing(stretched, [frameId], 'vertical', 'HUG')).toBe(stretched);
    // Turned into a column, it is the width that can no longer be hugged.
    const column = lay(patchNode(stretched, frameId, { layoutMode: 'VERTICAL', layoutSizingVertical: 'HUG' }));
    expect(frameOf(column, frameId)).toMatchObject({ layoutSizingHorizontal: 'FIXED', layoutSizingVertical: 'HUG', width: 226 });
    expect(widthsOf(column, made.ids)).toEqual([196, 196, 196]);
  });

  it('gives the children their own sizing back when the alignment is no longer Stretch', () => {
    const { doc, frameId } = frame(STRETCH);
    const inner = addLayer(doc, 'FRAME', frameId, { width: 10, height: 10, layoutMode: 'VERTICAL', layoutSizingHorizontal: 'HUG', layoutSizingVertical: 'HUG' });
    const kid = addLayer(inner.doc, 'RECTANGLE', inner.id, { width: 40, height: 15 });
    const made = fill(kid.doc, frameId, [THREE[0] as LayerPatch, { ...THREE[1], layoutSizingVertical: 'FILL' }]);
    const stretched = lay(made.doc);
    const [plain, filling] = made.ids as [NodeId, NodeId];
    expect(heights(stretched, [inner.id, plain, filling])).toEqual([130, 130, 130]);
    const top = lay(patchNode(stretched, frameId, { counterAxisAlignItems: 'MIN' }));
    // The frame hugs again, the one that fills still fills, and a fixed size stays what the stretch made it.
    expect(heights(top, [inner.id, plain, filling])).toEqual([15, 130, 130]);
    expect(stretchedAcross(top, getLayer(top, plain))).toBeNull();
  });

  it('stretches each child of a wrapping row to its line, and shares the frame’s height between the lines', () => {
    const { doc, frameId } = frame({
      width: 200,
      height: 200,
      layoutWrap: 'WRAP',
      counterAxisAlignItems: 'STRETCH',
      paddingLeft: 10,
      paddingRight: 10,
      paddingTop: 10,
      paddingBottom: 10,
      itemSpacing: 10,
      counterAxisSpacing: 20,
    });
    const made = fill(doc, frameId, [0, 1, 2].map(() => ({ width: 60, height: 20 })));
    const laid = lay(made.doc);
    // Two lines share the 180 between the padding, less the gap of 20: 80 each.
    expect(made.ids.map((id) => box(laid, id))).toEqual([
      { x: 10, y: 10, width: 60, height: 80 },
      { x: 80, y: 10, width: 60, height: 80 },
      { x: 10, y: 110, width: 60, height: 80 },
    ]);
  });

  it('does not reach a child that is hidden or taken out of the flow', () => {
    const { doc, frameId } = frame(STRETCH);
    const made = fill(doc, frameId, [
      { ...THREE[0], x: 300, y: 5, layoutPositioning: 'ABSOLUTE' },
      { ...THREE[1], visible: false },
    ]);
    const laid = lay(made.doc);
    expect(box(laid, made.ids[0] as NodeId)).toEqual({ x: 300, y: 5, width: 50, height: 20 });
    expect(box(laid, made.ids[1] as NodeId).height).toBe(40);
    expect(stretchedAcross(laid, getLayer(laid, made.ids[0] as NodeId))).toBeNull();
  });

  it('opens a version 15 file, where no frame stretches, and keeps a stretch through saving and opening', () => {
    const { doc, frameId } = frame({ ...PADDED, counterAxisAlignItems: 'CENTER' });
    const current = lay(fill(doc, frameId, THREE).doc);
    const parsed = parseFile({
      format: 'open-design',
      schemaVersion: 15,
      meta: { createdAt: '2026-11-16T12:00:00.000Z', updatedAt: '2026-11-16T12:00:00.000Z' },
      document: JSON.parse(JSON.stringify(current)),
    });
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(16);
    expect(parsed.file.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(parsed.repairs).toEqual([]);
    expect(parsed.file.document).toEqual(current);
    expect(frameOf(parsed.file.document, frameId).counterAxisAlignItems).toBe('CENTER');

    const stretched = lay(patchNode(current, frameId, { counterAxisAlignItems: 'STRETCH' }));
    const reopened = repairDocument(JSON.parse(JSON.stringify(stretched)));
    expect(reopened.repairs).toEqual([]);
    expect(reopened.doc).toEqual(stretched);
    expect(lay(reopened.doc)).toBe(reopened.doc);
  });
});

describe('Auto Layout on the canvas', () => {
  const ptr = (x: number, y: number, extra: Partial<PointerInput> = {}): PointerInput => ({
    x, y, button: 0, shiftKey: false, altKey: false, ctrlKey: false, detail: 1, ...extra,
  });

  /** A row at (100, 100) on the page holding three squares of 50 with gaps of 10, in a store with its controller. */
  function canvas(props: LayerPatch = {}): { store: EditorStore; controller: InteractionController; frameId: NodeId; ids: NodeId[] } {
    const built = frame({ x: 100, y: 100, itemSpacing: 10, ...props });
    const made = fill(built.doc, built.frameId, [0, 1, 2].map(() => ({ width: 50, height: 50 })));
    const store = createEditorStore(lay(made.doc));
    store.getState().setCanvasSize({ width: 1000, height: 800 });
    const controller = new InteractionController(store, { requestRender: () => undefined, setCursor: () => undefined });
    return { store, controller, frameId: built.frameId, ids: made.ids };
  }

  function drag(controller: InteractionController, from: [number, number], to: [number, number], steps: [number, number][] = []): void {
    controller.pointerDown(ptr(from[0], from[1]));
    for (const [x, y] of steps) controller.pointerMove(ptr(x, y));
    controller.pointerMove(ptr(to[0], to[1]));
    controller.pointerUp(ptr(to[0], to[1]));
  }

  const now = (store: EditorStore): Document => store.getState().doc;

  it('changes the place of a child among the others when it is dragged along the row', () => {
    const { store, controller, frameId, ids } = canvas();
    const [a, b, c] = ids as [NodeId, NodeId, NodeId];
    drag(controller, [125, 125], [300, 130], [[200, 128]]);
    expect(getChildIds(now(store), frameId)).toEqual([b, c, a]);
    expect(ids.map((id) => at(now(store), id))).toEqual([
      [120, 0],
      [0, 0],
      [60, 0],
    ]);
    expect(store.getState().selection).toEqual([a]);
    expect(store.getState().undoStack).toHaveLength(1);
    store.getState().undo();
    expect(getChildIds(now(store), frameId)).toEqual([a, b, c]);
    expect(at(now(store), a)).toEqual([0, 0]);
  });

  it('reorders a card among cards without dropping it into the one it passes over', () => {
    const built = frame({ x: 100, y: 100, itemSpacing: 10 });
    const made = fill(built.doc, built.frameId, [0, 1, 2].map(() => ({ type: 'FRAME' as const, width: 80, height: 80 })));
    const store = createEditorStore(lay(made.doc));
    store.getState().setCanvasSize({ width: 1000, height: 800 });
    const controller = new InteractionController(store, { requestRender: () => undefined, setCursor: () => undefined });
    const [a, b, c] = made.ids as [NodeId, NodeId, NodeId];
    store.getState().setSelection([a]);
    // From the first card to the right half of the second: over a frame all the way.
    drag(controller, [140, 140], [260, 140], [[200, 140]]);
    expect(getChildIds(now(store), built.frameId)).toEqual([b, a, c]);
    expect(getLayer(now(store), a)?.parentId).toBe(built.frameId);
    // Off the row altogether and onto another frame, it does go inside that.
    const other = addLayer(now(store), 'FRAME', store.getState().pageId, { x: 100, y: 400, width: 300, height: 200 });
    store.getState().apply('Add', () => other.doc);
    store.getState().setSelection([a]);
    drag(controller, [230, 140], [230, 500]);
    expect(getLayer(now(store), a)?.parentId).toBe(other.id);
    expect(getChildIds(now(store), built.frameId)).toEqual([b, c]);
  });

  it('keeps the child where it is while the pointer stays over its own place, and on Escape', () => {
    const { store, controller, frameId, ids } = canvas();
    drag(controller, [125, 125], [140, 140]);
    expect(getChildIds(now(store), frameId)).toEqual(ids);
    expect(at(now(store), ids[0] as NodeId)).toEqual([0, 0]);
    // Nothing changed, so there is nothing to undo.
    expect(store.getState().undoStack).toHaveLength(0);

    controller.pointerDown(ptr(125, 125));
    controller.pointerMove(ptr(300, 125));
    expect(getChildIds(now(store), frameId)).toEqual([ids[1], ids[2], ids[0]]);
    controller.cancel();
    expect(getChildIds(now(store), frameId)).toEqual(ids);
  });

  it('takes a child out of the layout when it is dragged off the frame, and the rest close up', () => {
    const { store, controller, frameId, ids } = canvas({ layoutSizingHorizontal: 'HUG', layoutSizingVertical: 'HUG' });
    const [a, b] = ids as [NodeId, NodeId];
    drag(controller, [125, 125], [625, 525]);
    const doc = now(store);
    expect(getLayer(doc, a)?.parentId).toBe(store.getState().pageId);
    // It followed the pointer: 500 across and 400 down from where it was on the page.
    expect(at(doc, a)).toEqual([600, 500]);
    expect(getChildIds(doc, frameId)).toEqual([ids[1], ids[2]]);
    expect(at(doc, b)).toEqual([0, 0]);
    expect(size(doc, frameId)).toEqual([110, 50]);
  });

  it('puts a layer dropped on the frame at the place it is dropped over', () => {
    const { store, controller, frameId, ids } = canvas();
    const outside = addLayer(now(store), 'ELLIPSE', store.getState().pageId, { x: 600, y: 500, width: 40, height: 40 });
    store.getState().apply('Add', () => outside.doc);
    store.getState().setSelection([outside.id]);
    // Dropped between the first and the second square.
    drag(controller, [620, 520], [155, 120]);
    const doc = now(store);
    expect(getChildIds(doc, frameId)).toEqual([ids[0], outside.id, ids[1], ids[2]]);
    expect(at(doc, outside.id)).toEqual([60, 0]);
    expect(at(doc, ids[1] as NodeId)).toEqual([110, 0]);
  });

  it('puts an image dropped on the frame at the place it is dropped over', () => {
    const { store, frameId, ids } = canvas();
    const image = { hash: 'a'.repeat(64), info: { mimeType: 'image/png', width: 40, height: 40, name: 'icon.png' } };
    const [id] = placeImages(store, [image], { x: 155, y: 125 }) as [NodeId];
    expect(getChildIds(now(store), frameId)).toEqual([ids[0], id, ids[1], ids[2]]);
    expect(box(now(store), id)).toEqual({ x: 60, y: 0, width: 40, height: 40 });
    expect(at(now(store), ids[1] as NodeId)).toEqual([110, 0]);
  });

  it('makes a size dragged out by a handle stand', () => {
    const { store, controller, frameId, ids } = canvas({ layoutSizingHorizontal: 'HUG', layoutSizingVertical: 'HUG' });
    const b = ids[1] as NodeId;
    store.getState().apply('Fill', (doc) => patchNode(doc, b, { layoutSizingVertical: 'FILL' }));
    // The frame hugs 170 × 50. Its right edge is dragged out by 100.
    store.getState().setSelection([frameId]);
    drag(controller, [270, 125], [370, 125]);
    expect(frameOf(now(store), frameId)).toMatchObject({ layoutSizingHorizontal: 'FIXED', layoutSizingVertical: 'HUG', width: 270, height: 50 });
    // The square that fills the height is dragged shorter by its bottom edge (to a place clear of the lines
    // its neighbours offer for snapping): it is fixed from then on.
    store.getState().setSelection([b]);
    drag(controller, [185, 150], [185, 115]);
    expect(getLayer(now(store), b)).toMatchObject({ layoutSizingVertical: 'FIXED', height: 15 });
    expect(size(now(store), frameId)).toEqual([270, 50]);
  });

  it('gives a shape drawn into the frame the place it is drawn over, and text too', () => {
    const { store, controller, frameId, ids } = canvas();
    store.getState().setTool('rectangle');
    // Started between the second and the third square.
    drag(controller, [215, 110], [245, 140]);
    let doc = now(store);
    const drawn = getChildIds(doc, frameId).find((id) => !ids.includes(id)) as NodeId;
    expect(getChildIds(doc, frameId)).toEqual([ids[0], ids[1], drawn, ids[2]]);
    expect(box(doc, drawn)).toEqual({ x: 120, y: 0, width: 30, height: 30 });
    expect(at(doc, ids[2] as NodeId)).toEqual([160, 0]);

    store.getState().setTool('text');
    controller.pointerDown(ptr(105, 120));
    controller.pointerUp(ptr(105, 120));
    doc = now(store);
    expect(getChildIds(doc, frameId)[0]).toBe(store.getState().editingTextId);
  });

  it('adds a layout with Shift+A and takes it away with Alt+Shift+A', () => {
    const store = createEditorStore(createDocument('Keys'));
    const env = {
      store,
      app: { cancelInteraction: () => false, openShortcuts: () => undefined, saveNow: () => undefined, saveAs: () => undefined, placeImage: () => undefined, goHome: () => undefined },
    };
    const pageId = store.getState().pageId;
    const made = fill(now(store), pageId, [
      { x: 100, y: 100, width: 50, height: 50 },
      { x: 100, y: 170, width: 50, height: 50 },
    ]);
    store.getState().apply('Add', () => made.doc);
    store.getState().setSelection(made.ids);

    const add = commandForKey({ code: 'KeyA', ctrlKey: false, metaKey: false, shiftKey: true, altKey: false });
    expect(add?.id).toBe('object.autoLayout');
    expect(runCommand(add as Command, env)).toBe(true);
    const [frameId] = store.getState().selection as [NodeId];
    expect(frameOf(now(store), frameId)).toMatchObject({ layoutMode: 'VERTICAL', itemSpacing: 20, x: 100, y: 100, width: 50, height: 120 });

    const remove = commandForKey({ code: 'KeyA', ctrlKey: false, metaKey: false, shiftKey: true, altKey: true });
    expect(remove?.id).toBe('object.removeAutoLayout');
    expect(remove?.enabled?.(store.getState())).toBe(true);
    runCommand(remove as Command, env);
    expect(frameOf(now(store), frameId).layoutMode).toBe('NONE');
    expect(remove?.enabled?.(store.getState())).toBe(false);
    store.getState().undo();
    store.getState().undo();
    expect(getChildIds(now(store), pageId)).toEqual(made.ids);
  });

  it('moves a child along the layout with the arrow keys, and not across it', () => {
    const { store, frameId, ids } = canvas();
    const [a, b, c] = ids as [NodeId, NodeId, NodeId];
    store.getState().setSelection([a]);
    nudgeSelection(store, 1, 0);
    expect(getChildIds(now(store), frameId)).toEqual([b, a, c]);
    nudgeSelection(store, 10, 0);
    expect(getChildIds(now(store), frameId)).toEqual([b, c, a]);
    nudgeSelection(store, 0, 1);
    nudgeSelection(store, 1, 0);
    expect(getChildIds(now(store), frameId)).toEqual([b, c, a]);
    expect(store.getState().undoStack).toHaveLength(2);
    nudgeSelection(store, -1, 0);
    expect(getChildIds(now(store), frameId)).toEqual([b, a, c]);
    // The frame itself, which no layout places, still moves by pixels.
    store.getState().setSelection([frameId]);
    nudgeSelection(store, 0, 10);
    expect(at(now(store), frameId)).toEqual([100, 110]);
  });
});
