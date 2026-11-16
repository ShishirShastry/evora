import { describe, expect, it } from 'vitest';
import {
  addLayer,
  countGuides,
  createDocument,
  frameGuides,
  frameTakesGuides,
  getPages,
  guidesOf,
  hitFrameGuide,
  patchNode,
  repairDocument,
  setGuide,
  type Document,
  type FrameNode,
  type LayerNode,
  type NodeId,
  type PageNode,
} from './core';
import { InteractionController, type PointerInput } from './engine/input/controller';
import { renderOverlay } from './engine/render/overlay';
import { createEditorStore, type EditorStore } from './state/editorStore';

/**
 * Guides that belong to a frame: positions in the frame's own space, lines
 * across the frame and no further, moving with it.
 */

const ptr = (x: number, y: number): PointerInput => ({ x, y, button: 0, shiftKey: false, altKey: false, ctrlKey: false, detail: 1 });

/** A page with a frame at (100, 100), 400 by 200. */
function setup(): { doc: Document; pageId: NodeId; frame: NodeId } {
  const doc = createDocument('Frame guides');
  const pageId = (getPages(doc)[0] as { id: NodeId }).id;
  const frame = addLayer(doc, 'FRAME', pageId, { x: 100, y: 100, width: 400, height: 200 });
  return { doc: frame.doc, pageId, frame: frame.id };
}

const frameOf = (doc: Document, id: NodeId): FrameNode => doc.nodes[id] as FrameNode;
const pageOf = (doc: Document, id: NodeId): PageNode => doc.nodes[id] as PageNode;

describe('guides of a frame', () => {
  it('are added, moved and removed like those of a page, and only pages and frames have any', () => {
    const { doc, pageId, frame } = setup();
    expect(guidesOf(doc, frame)).toEqual([]);
    const one = setGuide(doc, frame, null, { axis: 'X', position: 50 });
    const two = setGuide(one, frame, null, { axis: 'Y', position: 30 });
    expect(frameOf(two, frame).guides).toEqual([
      { axis: 'X', position: 50 },
      { axis: 'Y', position: 30 },
    ]);
    expect(pageOf(two, pageId).guides).toEqual([]);
    expect(frameOf(setGuide(two, frame, 0, { axis: 'X', position: 80 }), frame).guides[0]).toEqual({ axis: 'X', position: 80 });
    expect(frameOf(setGuide(two, frame, 0, null), frame).guides).toEqual([{ axis: 'Y', position: 30 }]);
    expect(setGuide(two, frame, 0, { axis: 'X', position: 50 })).toBe(two);
    expect(setGuide(two, frame, 5, null)).toBe(two);
    expect(countGuides(setGuide(two, pageId, null, { axis: 'X', position: 0 }))).toBe(3);
    // A rectangle has none and takes none.
    const rectangle = addLayer(doc, 'RECTANGLE', pageId, {});
    expect(setGuide(rectangle.doc, rectangle.id, null, { axis: 'X', position: 10 })).toBe(rectangle.doc);
    expect(guidesOf(rectangle.doc, rectangle.id)).toEqual([]);
  });

  it('are lines on the page across their frame, and move with it', () => {
    const { doc, pageId, frame } = setup();
    let next = setGuide(doc, frame, null, { axis: 'X', position: 50 });
    next = setGuide(next, frame, null, { axis: 'Y', position: 30 });
    // One that lies outside the frame is kept but not shown.
    next = setGuide(next, frame, null, { axis: 'X', position: 500 });
    expect(frameGuides(next, pageId)).toEqual([
      { ownerId: frame, index: 0, axis: 'X', position: 150, from: 100, to: 300 },
      { ownerId: frame, index: 1, axis: 'Y', position: 130, from: 100, to: 500 },
    ]);
    const moved = patchNode(next, frame, { x: 300, y: 0 });
    expect(frameGuides(moved, pageId).map((guide) => [guide.position, guide.from, guide.to])).toEqual([
      [350, 0, 200],
      [30, 300, 700],
    ]);
    // A frame inside it has its own, placed by where that frame is on the page.
    const inner = addLayer(next, 'FRAME', frame, { x: 20, y: 40, width: 100, height: 100 });
    const nested = setGuide(inner.doc, inner.id, null, { axis: 'X', position: 10 });
    expect(frameGuides(nested, pageId).at(-1)).toEqual({ ownerId: inner.id, index: 0, axis: 'X', position: 130, from: 140, to: 240 });
  });

  it('are not shown by a frame that is hidden, turned, or inside something turned', () => {
    const { doc, pageId, frame } = setup();
    const guided = setGuide(doc, frame, null, { axis: 'X', position: 50 });
    expect(frameTakesGuides(guided, frame)).toBe(true);
    expect(frameGuides(patchNode(guided, frame, { visible: false }), pageId)).toEqual([]);
    const turned = patchNode(guided, frame, { rotation: 15 });
    expect(frameTakesGuides(turned, frame)).toBe(false);
    expect(frameGuides(turned, pageId)).toEqual([]);
    const inner = addLayer(turned, 'FRAME', frame, { x: 20, y: 40, width: 100, height: 100 });
    expect(frameTakesGuides(inner.doc, inner.id)).toBe(false);
    // The guide is still the frame's: turned back, it is there again.
    expect(frameGuides(patchNode(turned, frame, { rotation: 0 }), pageId)).toHaveLength(1);
    expect(frameTakesGuides(doc, pageId)).toBe(false);
  });

  it('are found under the pointer only along the stretch that is drawn', () => {
    const { doc, pageId, frame } = setup();
    const placed = frameGuides(setGuide(doc, frame, null, { axis: 'X', position: 50 }), pageId);
    expect(hitFrameGuide(placed, { x: 151, y: 200 }, 4)?.ownerId).toBe(frame);
    expect(hitFrameGuide(placed, { x: 156, y: 200 }, 4)).toBeNull();
    // Above the frame the line is not drawn, so there is nothing to grab.
    expect(hitFrameGuide(placed, { x: 150, y: 50 }, 4)).toBeNull();
    expect(hitFrameGuide(placed, { x: 150, y: 302 }, 4)?.index).toBe(0);
  });

  it('are checked when a file is opened', () => {
    const { doc, frame } = setup();
    const raw = JSON.parse(JSON.stringify(doc)) as { nodes: Record<string, Record<string, unknown>> };
    (raw.nodes[frame] as Record<string, unknown>).guides = [{ axis: 'X', position: 20 }, { axis: 'Z', position: 1 }, { axis: 'Y', position: 'low' }, 'guide'];
    expect(frameOf(repairDocument(raw).doc, frame).guides).toEqual([{ axis: 'X', position: 20 }]);
  });
});

describe('guides of a frame on the canvas', () => {
  function editor(doc: Document): { store: EditorStore; controller: InteractionController } {
    const store = createEditorStore(doc, undefined, { showRulers: true });
    store.getState().setCanvasSize({ width: 800, height: 600 });
    const controller = new InteractionController(store, { requestRender: () => undefined, setCursor: () => undefined });
    return { store, controller };
  }
  const drag = (controller: InteractionController, from: [number, number], to: [number, number]): void => {
    controller.pointerDown(ptr(from[0], from[1]));
    controller.pointerMove(ptr((from[0] + to[0]) / 2, (from[1] + to[1]) / 2));
    controller.pointerMove(ptr(to[0], to[1]));
    controller.pointerUp(ptr(to[0], to[1]));
  };
  const labels = (store: EditorStore): string[] => store.getState().undoStack.map((entry) => entry.label);

  it('belong to the frame they are let go over, and to the page anywhere else', () => {
    const { doc, pageId, frame } = setup();
    const { store, controller } = editor(doc);
    const state = (): Document => store.getState().doc;

    // Pulled out of the left ruler and let go inside the frame: a guide 150 from the frame's left edge.
    drag(controller, [10, 180], [250, 180]);
    expect(frameOf(state(), frame).guides).toEqual([{ axis: 'X', position: 150 }]);
    expect(pageOf(state(), pageId).guides).toEqual([]);
    // Moved within the frame, it is the same guide.
    drag(controller, [250, 150], [300, 150]);
    expect(frameOf(state(), frame).guides).toEqual([{ axis: 'X', position: 200 }]);
    // Taken out of the frame, it is the page's, in page coordinates; brought back, the frame's again.
    drag(controller, [300, 150], [700, 150]);
    expect(frameOf(state(), frame).guides).toEqual([]);
    expect(pageOf(state(), pageId).guides).toEqual([{ axis: 'X', position: 700 }]);
    drag(controller, [700, 400], [120, 250]);
    expect(pageOf(state(), pageId).guides).toEqual([]);
    expect(frameOf(state(), frame).guides).toEqual([{ axis: 'X', position: 20 }]);
    // Dragged back onto its ruler, it is gone.
    drag(controller, [120, 250], [8, 250]);
    expect(countGuides(state())).toBe(0);
    expect(labels(store)).toEqual(['Add guide', 'Move guide', 'Move guide', 'Move guide', 'Remove guide']);
    store.getState().undo();
    expect(frameOf(state(), frame).guides).toEqual([{ axis: 'X', position: 20 }]);

    // From the top ruler: a horizontal guide, 50 below the frame's top edge.
    drag(controller, [400, 10], [400, 150]);
    expect(frameOf(state(), frame).guides).toEqual([
      { axis: 'X', position: 20 },
      { axis: 'Y', position: 50 },
    ]);
  });

  it('cannot be grabbed where they are not drawn, and are not taken by a frame that is turned', () => {
    const { doc, pageId, frame } = setup();
    const { store, controller } = editor(setGuide(doc, frame, null, { axis: 'X', position: 150 }));
    // Above the frame, on the line the guide would be on if it went further: nothing to drag.
    drag(controller, [250, 50], [300, 50]);
    expect(frameOf(store.getState().doc, frame).guides).toEqual([{ axis: 'X', position: 150 }]);
    expect(countGuides(store.getState().doc)).toBe(1);

    const turned = editor(patchNode(doc, frame, { rotation: 20 }));
    drag(turned.controller, [10, 180], [300, 200]);
    expect(frameOf(turned.store.getState().doc, frame).guides).toEqual([]);
    expect(pageOf(turned.store.getState().doc, pageId).guides).toEqual([{ axis: 'X', position: 300 }]);
  });

  it('are snapped to by the layers in their frame', () => {
    const { doc, frame } = setup();
    const child = addLayer(setGuide(doc, frame, null, { axis: 'X', position: 150 }), 'RECTANGLE', frame, { x: 10, y: 10, width: 40, height: 40 });
    const { store, controller } = editor(child.doc);
    store.getState().setSelection([child.id]);
    // Dragged so that its left edge would be at 252 on the page: the guide is at 250.
    drag(controller, [130, 130], [272, 130]);
    expect((store.getState().doc.nodes[child.id] as LayerNode).x).toBe(150);
    // With the rulers (and so the guides) hidden, there is nothing to snap to.
    store.getState().undo();
    store.getState().setShowRulers(false);
    drag(controller, [130, 130], [272, 130]);
    expect((store.getState().doc.nodes[child.id] as LayerNode).x).toBe(152);
  });

  it('are drawn across their frame only', () => {
    const { doc, pageId, frame } = setup();
    const guided = setGuide(doc, frame, null, { axis: 'X', position: 150 });
    const lines: number[][] = [];
    let from: number[] = [];
    const target: Record<string, unknown> = {};
    const ctx = new Proxy(target, {
      get(obj, prop: string) {
        if (prop in obj) return obj[prop];
        if (prop === 'measureText') return () => ({ width: 10 });
        return (...args: number[]) => {
          if (prop === 'moveTo') from = args;
          if (prop === 'lineTo') lines.push([...from, ...args]);
        };
      },
      set(obj, prop: string, value) {
        obj[prop] = value;
        return true;
      },
    }) as unknown as CanvasRenderingContext2D;
    renderOverlay(ctx, {
      doc: guided,
      pageId,
      viewport: { x: 0, y: 0, zoom: 1 },
      size: { width: 800, height: 600 },
      dpr: 1,
      selection: [],
      hoveredId: null,
      marquee: null,
      showHandles: false,
      showRulers: true,
    });
    // A vertical line at 250 on the page, from the frame's top edge to its bottom edge.
    expect(lines).toContainEqual([250.5, 100, 250.5, 300]);
    expect(lines.some((line) => line[0] === 250.5 && line[1] === 0)).toBe(false);
  });
});
