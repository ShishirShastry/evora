import { describe, expect, it } from 'vitest';
import {
  addLayer,
  collectSnapRects,
  createDocument,
  getPages,
  measureDistances,
  patchNode,
  snapSpacing,
  spacingMarks,
  type DistanceMark,
  type Document,
  type LayerNode,
  type NodeId,
  type Rect,
} from './core';
import { InteractionController, type PointerInput } from './engine/input/controller';
import { distanceLabelBox, renderOverlay } from './engine/render/overlay';
import { createEditorStore, type EditorStore } from './state/editorStore';

const box = (x: number, y: number, width = 60, height = 60): Rect => ({ x, y, width, height });
const lengths = (marks: readonly DistanceMark[]): number[] => marks.map((mark) => mark.to - mark.from);

function docWith(specs: [number, number, number, number][]): { doc: Document; pageId: NodeId; ids: NodeId[] } {
  let doc = createDocument('Spacing');
  const pageId = (getPages(doc)[0] as { id: NodeId }).id;
  const ids: NodeId[] = [];
  for (const [x, y, width, height] of specs) {
    const out = addLayer(doc, 'RECTANGLE', pageId, { x, y, width, height });
    doc = out.doc;
    ids.push(out.id);
  }
  return { doc, pageId, ids };
}

describe('snapping to even spacing', () => {
  // Two boxes in a row, 40 apart.
  const pair = [box(100, 200), box(200, 200)];

  it('puts a box beyond a pair at the gap of the pair, on either side', () => {
    expect(snapSpacing(box(303, 205), pair, 6)).toEqual({ dx: -3, dy: null });
    expect(snapSpacing(box(-4, 190), pair, 6)).toEqual({ dx: 4, dy: null });
    // Too far away, and not in line with them.
    expect(snapSpacing(box(310, 205), pair, 6)).toEqual({ dx: null, dy: null });
    expect(snapSpacing(box(303, 400), pair, 6)).toEqual({ dx: null, dy: null });
    // An axis that is locked is left alone.
    expect(snapSpacing(box(303, 205), pair, 6, { x: false, y: true })).toEqual({ dx: null, dy: null });
  });

  it('puts a box halfway between its two neighbours', () => {
    const apart = [box(100, 200), box(300, 200)];
    expect(snapSpacing(box(204, 210), apart, 6)).toEqual({ dx: -4, dy: null });
    // No room between them: nothing to offer.
    expect(snapSpacing(box(165, 210, 150), apart, 6)).toEqual({ dx: null, dy: null });
    // Halfway falls between pixels for a box 61 wide: offered off the pixel grid, not on it.
    expect(snapSpacing(box(203, 210, 61), apart, 6)).toEqual({ dx: -3.5, dy: null });
    expect(snapSpacing(box(203, 210, 61), apart, 6, { x: true, y: true }, true)).toEqual({ dx: null, dy: null });
  });

  it('works down the page as it does across', () => {
    const column = [box(200, 100), box(200, 180)];
    // 20 apart: the next place down is at 260.
    expect(snapSpacing(box(190, 262), column, 6)).toEqual({ dx: null, dy: -2 });
    expect(snapSpacing(box(190, 18), column, 6)).toEqual({ dx: null, dy: 2 });
  });

  it('takes the boxes from the visible layers of a container, and none from a rotated one', () => {
    const { doc, pageId, ids } = docWith([
      [100, 200, 60, 60],
      [200, 200, 60, 60],
      [400, 400, 60, 60],
    ]);
    expect(collectSnapRects(doc, pageId, new Set([ids[2] as NodeId]))).toEqual([box(100, 200), box(200, 200)]);
    const hidden = patchNode(doc, ids[0] as NodeId, { visible: false });
    expect(collectSnapRects(hidden, pageId, new Set([ids[2] as NodeId]))).toEqual([box(200, 200)]);
    const frame = addLayer(doc, 'FRAME', pageId, { x: 0, y: 0, width: 400, height: 300, rotation: 30 });
    const child = addLayer(frame.doc, 'RECTANGLE', frame.id, { x: 10, y: 10, width: 20, height: 20 });
    expect(collectSnapRects(child.doc, frame.id, new Set())).toEqual([]);
  });
});

describe('the equal gaps a box sits in', () => {
  it('are the gap beside it and the same gap between its neighbours', () => {
    const marks = spacingMarks(box(300, 200), [box(100, 200), box(200, 200)]);
    expect(marks).toEqual([
      { axis: 'x', from: 160, to: 200, at: 230 },
      { axis: 'x', from: 260, to: 300, at: 230 },
    ]);
    // A third box at the same gap further along is part of it; one at another gap is not.
    expect(lengths(spacingMarks(box(300, 200), [box(0, 200), box(100, 200), box(200, 200)]))).toEqual([40, 40, 40]);
    expect(lengths(spacingMarks(box(300, 200), [box(-10, 200), box(100, 200), box(200, 200)]))).toEqual([40, 40]);
    // The run goes through the middle of where two boxes face each other.
    expect(spacingMarks(box(300, 230), [box(100, 200), box(200, 200)]).map((mark) => mark.at)).toEqual([230, 245]);
  });

  it('are the gaps on both sides of a box that is halfway between two others', () => {
    expect(spacingMarks(box(200, 200), [box(100, 200), box(300, 200)])).toEqual([
      { axis: 'x', from: 160, to: 200, at: 230 },
      { axis: 'x', from: 260, to: 300, at: 230 },
    ]);
    // Both ways at once.
    const around = [box(100, 200), box(300, 200), box(200, 120), box(200, 280)];
    expect(spacingMarks(box(200, 200), around).map((mark) => [mark.axis, mark.to - mark.from])).toEqual([
      ['x', 40],
      ['x', 40],
      ['y', 20],
      ['y', 20],
    ]);
  });

  it('are none when the gaps differ, the boxes touch, or nothing is in line', () => {
    expect(spacingMarks(box(301, 200), [box(100, 200), box(200, 200)])).toEqual([]);
    expect(spacingMarks(box(260, 200), [box(100, 200), box(200, 200)])).toEqual([]);
    expect(spacingMarks(box(300, 400), [box(100, 200), box(200, 200)])).toEqual([]);
    expect(spacingMarks(box(300, 200), [box(200, 200)])).toEqual([]);
  });
});

describe('measuring from one box to another', () => {
  it('gives the gap between boxes that are side by side', () => {
    expect(measureDistances(box(300, 200), box(100, 200))).toEqual({ marks: [{ axis: 'x', from: 160, to: 300, at: 230 }], guides: [] });
    expect(measureDistances(box(100, 200), box(300, 200))).toEqual({ marks: [{ axis: 'x', from: 160, to: 300, at: 230 }], guides: [] });
    // One above the other, and shifted sideways: the gap, and how far each side is from the same side of the other.
    expect(measureDistances(box(100, 100), box(120, 300)).marks).toEqual([
      { axis: 'x', from: 100, to: 120, at: 130 },
      { axis: 'x', from: 160, to: 180, at: 130 },
      { axis: 'y', from: 160, to: 300, at: 140 },
    ]);
  });

  it('gives how far a box is from each side of one it is inside', () => {
    const measured = measureDistances({ x: 50, y: 40, width: 100, height: 20 }, { x: 0, y: 0, width: 400, height: 200 });
    expect(measured.marks).toEqual([
      { axis: 'x', from: 0, to: 50, at: 50 },
      { axis: 'x', from: 150, to: 400, at: 50 },
      { axis: 'y', from: 0, to: 40, at: 100 },
      { axis: 'y', from: 60, to: 200, at: 100 },
    ]);
    expect(measured.guides).toEqual([]);
    // Flush against a side: nothing to show for it.
    expect(lengths(measureDistances({ x: 0, y: 40, width: 100, height: 20 }, { x: 0, y: 0, width: 400, height: 200 }).marks)).toEqual([300, 40, 140]);
  });

  it('carries an edge on to a run it does not reach, for boxes that are diagonally apart', () => {
    const measured = measureDistances(box(300, 300, 50, 50), box(100, 100, 50, 50));
    expect(measured.marks).toEqual([
      { axis: 'x', from: 150, to: 300, at: 325 },
      { axis: 'y', from: 150, to: 300, at: 325 },
    ]);
    // The other box's right edge runs on down to the horizontal run, and its bottom edge across to the vertical one.
    expect(measured.guides).toEqual([
      { axis: 'x', position: 150, from: 150, to: 325 },
      { axis: 'y', position: 150, from: 150, to: 325 },
    ]);
  });
});

describe('spacing and measuring on the canvas', () => {
  const ptr = (x: number, y: number, more: Partial<PointerInput> = {}): PointerInput => ({
    x,
    y,
    button: 0,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    detail: 1,
    ...more,
  });

  function setup(specs: [number, number, number, number][]): { store: EditorStore; controller: InteractionController; ids: NodeId[]; renders: { count: number } } {
    const { doc, ids } = docWith(specs);
    const store = createEditorStore(doc);
    store.getState().setCanvasSize({ width: 800, height: 600 });
    const renders = { count: 0 };
    const controller = new InteractionController(store, { requestRender: () => void renders.count++, setCursor: () => undefined });
    return { store, controller, ids, renders };
  }

  const at = (store: EditorStore, id: NodeId): { x: number; y: number } => {
    const node = store.getState().doc.nodes[id] as LayerNode;
    return { x: node.x, y: node.y };
  };

  it('snaps a layer dragged beside a pair to the gap of the pair and shows the gaps', () => {
    const { store, controller, ids } = setup([
      [100, 200, 60, 60],
      [200, 200, 60, 60],
      [400, 400, 60, 60],
    ]);
    const moving = ids[2] as NodeId;
    store.getState().setSelection([moving]);
    controller.pointerDown(ptr(430, 430));
    controller.pointerMove(ptr(380, 300));
    // The layer would be at (303, 203): its top snaps to the others' tops, and it is spaced 40 from the second.
    controller.pointerMove(ptr(333, 233));
    expect(at(store, moving)).toEqual({ x: 300, y: 200 });
    expect(controller.distances).toEqual([
      { axis: 'x', from: 160, to: 200, at: 230 },
      { axis: 'x', from: 260, to: 300, at: 230 },
    ]);
    // Only the lines it sits on are drawn as guides: none of them is vertical.
    expect(controller.guides.length).toBeGreaterThan(0);
    expect(controller.guides.every((guide) => guide.axis === 'y')).toBe(true);
    // Moved on, the gaps are no longer equal and are not shown.
    controller.pointerMove(ptr(350, 233));
    expect(at(store, moving)).toEqual({ x: 320, y: 200 });
    expect(controller.distances).toEqual([]);
    controller.pointerMove(ptr(333, 233));
    controller.pointerUp(ptr(333, 233));
    expect(controller.distances).toEqual([]);
    expect(controller.guides).toEqual([]);
    expect(at(store, moving)).toEqual({ x: 300, y: 200 });
    store.getState().undo();
    expect(at(store, moving)).toEqual({ x: 400, y: 400 });
  });

  it('prefers a line that is nearer than the even place, and does nothing when snapping is off', () => {
    const { store, controller, ids } = setup([
      [100, 200, 60, 60],
      [200, 200, 60, 60],
      [400, 400, 60, 60],
      [302, 500, 20, 20],
    ]);
    const moving = ids[2] as NodeId;
    store.getState().setSelection([moving]);
    controller.pointerDown(ptr(430, 430));
    controller.pointerMove(ptr(380, 300));
    // At 303 the small layer's left edge (302) is one pixel away, the even place (300) three.
    controller.pointerMove(ptr(333, 233));
    expect(at(store, moving)).toEqual({ x: 302, y: 200 });
    expect(controller.distances).toEqual([]);
    expect(controller.guides.some((guide) => guide.axis === 'x' && guide.position === 302)).toBe(true);
    controller.cancel();
    expect(at(store, moving)).toEqual({ x: 400, y: 400 });

    store.getState().setSnapping(false);
    controller.pointerDown(ptr(430, 430));
    controller.pointerMove(ptr(380, 300));
    controller.pointerMove(ptr(331, 232));
    expect(at(store, moving)).toEqual({ x: 301, y: 202 });
    expect(controller.distances).toEqual([]);
    controller.cancel();
  });

  it('centres a layer between two others, on whole pixels only while the pixel grid is on', () => {
    const { store, controller, ids } = setup([
      [100, 200, 60, 60],
      [300, 200, 60, 60],
      [400, 400, 61, 60],
      [500, 400, 60, 60],
    ]);
    const even = ids[3] as NodeId;
    store.getState().setSelection([even]);
    controller.pointerDown(ptr(530, 430));
    controller.pointerMove(ptr(400, 300));
    // Would be at (203, 240): halfway between the two is 200.
    controller.pointerMove(ptr(233, 270));
    expect(at(store, even)).toEqual({ x: 200, y: 240 });
    expect(lengths(controller.distances)).toEqual([40, 40]);
    controller.cancel();

    // 61 wide: halfway is 199.5, which the pixel grid cannot hold.
    const odd = ids[2] as NodeId;
    store.getState().setSelection([odd]);
    controller.pointerDown(ptr(430, 430));
    controller.pointerMove(ptr(400, 300));
    controller.pointerMove(ptr(233, 270));
    expect(at(store, odd)).toEqual({ x: 203, y: 240 });
    expect(controller.distances).toEqual([]);
    controller.cancel();
    store.getState().setPixelSnap(false);
    controller.pointerDown(ptr(430, 430));
    controller.pointerMove(ptr(400, 300));
    controller.pointerMove(ptr(233, 270));
    expect(at(store, odd)).toEqual({ x: 199.5, y: 240 });
    expect(lengths(controller.distances)).toEqual([39.5, 39.5]);
    controller.cancel();
  });

  it('measures from the selection to the layer under the pointer while Alt is held', () => {
    const { store, controller, ids, renders } = setup([
      [100, 200, 60, 60],
      [300, 200, 60, 60],
    ]);
    store.getState().setSelection([ids[1] as NodeId]);
    controller.pointerMove(ptr(130, 230));
    expect(controller.distances).toEqual([]);
    controller.pointerMove(ptr(130, 230, { altKey: true }));
    expect(controller.distances).toEqual([{ axis: 'x', from: 160, to: 300, at: 230 }]);
    // Releasing and pressing Alt takes effect without the pointer moving, and asks for a repaint.
    const before = renders.count;
    controller.setAltDown(false);
    expect(controller.distances).toEqual([]);
    expect(renders.count).toBeGreaterThan(before);
    controller.setAltDown(true);
    expect(lengths(controller.distances)).toEqual([140]);
    // Over the selection itself on the bare page there is nothing to measure to.
    controller.pointerMove(ptr(330, 230, { altKey: true }));
    expect(controller.distances).toEqual([]);
    // A press puts the read-out away; so does leaving the canvas.
    controller.pointerMove(ptr(130, 230, { altKey: true }));
    expect(controller.distances).toHaveLength(1);
    controller.pointerLeave();
    expect(controller.distances).toEqual([]);
    controller.setAltDown(true);
    expect(controller.distances).toEqual([]);
    // With nothing selected there is nothing to measure from.
    store.getState().setSelection([]);
    controller.pointerMove(ptr(130, 230, { altKey: true }));
    expect(controller.distances).toEqual([]);
  });

  it('measures to the frame a layer is in when the pointer is over nothing else', () => {
    const { doc, pageId } = docWith([]);
    const frame = addLayer(doc, 'FRAME', pageId, { x: 100, y: 100, width: 400, height: 200 });
    const child = addLayer(frame.doc, 'RECTANGLE', frame.id, { x: 50, y: 40, width: 100, height: 20 });
    const store = createEditorStore(child.doc);
    store.getState().setCanvasSize({ width: 800, height: 600 });
    const controller = new InteractionController(store, { requestRender: () => undefined, setCursor: () => undefined });
    store.getState().setSelection([child.id]);
    controller.pointerMove(ptr(700, 500, { altKey: true }));
    expect(controller.distances).toEqual([
      { axis: 'x', from: 100, to: 150, at: 150 },
      { axis: 'x', from: 250, to: 500, at: 150 },
      { axis: 'y', from: 100, to: 140, at: 200 },
      { axis: 'y', from: 160, to: 300, at: 200 },
    ]);
    expect(lengths(controller.distances)).toEqual([50, 250, 40, 140]);
  });

  it('draws each distance as a line with its length in a label beside it', () => {
    const { store, controller, ids } = setup([
      [100, 200, 60, 60],
      [300, 200, 60, 60],
    ]);
    store.getState().setSelection([ids[1] as NodeId]);
    controller.pointerMove(ptr(130, 230, { altKey: true }));
    const texts: unknown[][] = [];
    const rects: unknown[][] = [];
    const target: Record<string, unknown> = {};
    const ctx = new Proxy(target, {
      get(obj, prop: string) {
        if (prop in obj) return obj[prop];
        if (prop === 'measureText') return () => ({ width: 20 });
        return (...args: unknown[]) => {
          if (prop === 'fillText') texts.push(args);
          if (prop === 'rect') rects.push(args);
        };
      },
      set(obj, prop: string, value) {
        obj[prop] = value;
        return true;
      },
    }) as unknown as CanvasRenderingContext2D;
    const state = store.getState();
    renderOverlay(ctx, {
      doc: state.doc,
      pageId: state.pageId,
      viewport: state.viewport,
      size: state.canvasSize,
      dpr: 1,
      selection: state.selection,
      hoveredId: null,
      marquee: null,
      showHandles: false,
      distances: controller.distances,
      distanceGuides: controller.distanceGuides,
    });
    // The length, in a box under the middle of the run from 160 to 300 at y = 230.
    expect(distanceLabelBox(controller.distances[0] as DistanceMark, state.viewport, 20)).toEqual({ x: 216, y: 236, width: 28, height: 16 });
    expect(texts).toContainEqual(['140', 220, 244]);
    expect(rects).toContainEqual([216, 236, 28, 16]);
  });
});
