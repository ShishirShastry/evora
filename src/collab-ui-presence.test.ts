import { describe, expect, it } from 'vitest';
import { addLayer, addPage, createDocument, getPages, patchNode, type Document, type NodeId } from './core';
import type { Presence, Thread } from './collab/protocol';
import { centredOn, cursorOnScreen, followViewport, pinAt, selectionOutlines, threadAnchor, viewportPresence } from './ui/collab/geometry';
import { worldToScreen } from './engine/viewport';

/**
 * Where others' presence and comments appear on this canvas: page
 * coordinates turned into screen pixels with this person's own view, layers
 * found under a comment's pin, and the view that shows what someone else
 * sees when following them.
 */

function page(): { doc: Document; pageId: NodeId; other: NodeId } {
  const start = createDocument('Presence');
  const pageId = (getPages(start)[0] as { id: NodeId }).id;
  // A second page, to tell presence on another page apart.
  const { doc, id: other } = addPage(start, 'Page 2');
  return { doc, pageId, other };
}

const presence = (partial: Partial<Presence>): Presence => ({ pageId: null, cursor: null, selection: [], viewport: null, ...partial });

describe('others’ pointers', () => {
  it('are placed with this person’s view: page point minus the view’s corner, times the zoom', () => {
    const { pageId } = page();
    const view = { x: 100, y: 50, zoom: 2 };
    expect(cursorOnScreen(presence({ pageId, cursor: { x: 150, y: 80 } }), pageId, view)).toEqual({ x: 100, y: 60 });
    // Off the left of the view: a negative position, which the layer leaves outside the canvas.
    expect(cursorOnScreen(presence({ pageId, cursor: { x: 90, y: 50 } }), pageId, view)).toEqual({ x: -20, y: 0 });
  });

  it('are not shown when they are on another page, off the canvas, or not known', () => {
    const { pageId, other } = page();
    const view = { x: 0, y: 0, zoom: 1 };
    expect(cursorOnScreen(presence({ pageId: other, cursor: { x: 1, y: 1 } }), pageId, view)).toBeNull();
    expect(cursorOnScreen(presence({ pageId, cursor: null }), pageId, view)).toBeNull();
    expect(cursorOnScreen(null, pageId, view)).toBeNull();
  });
});

describe('others’ selections', () => {
  it('are each selected layer’s four corners on screen', () => {
    const { doc: start, pageId } = page();
    const { doc, id } = addLayer(start, 'RECTANGLE', pageId, { x: 10, y: 20, width: 100, height: 50 });
    const outlines = selectionOutlines(doc, presence({ pageId, selection: [id] }), pageId, { x: 0, y: 0, zoom: 2 });
    expect(outlines).toEqual([
      [
        { x: 20, y: 40 },
        { x: 220, y: 40 },
        { x: 220, y: 140 },
        { x: 20, y: 140 },
      ],
    ]);
  });

  it('turn with a rotated layer', () => {
    const { doc: start, pageId } = page();
    const made = addLayer(start, 'RECTANGLE', pageId, { x: 0, y: 0, width: 100, height: 100 });
    const doc = patchNode(made.doc, made.id, { rotation: 90 } as never);
    const [corners] = selectionOutlines(doc, presence({ pageId, selection: [made.id] }), pageId, { x: 0, y: 0, zoom: 1 });
    expect(corners).toHaveLength(4);
    // A quarter turn: the edge from the first corner to the second runs down the screen instead of across it.
    const [a, b] = corners as { x: number; y: number }[];
    expect(Math.abs((b?.x ?? 0) - (a?.x ?? 0))).toBeLessThan(1e-6);
    expect(Math.abs(Math.abs((b?.y ?? 0) - (a?.y ?? 0)) - 100)).toBeLessThan(1e-6);
  });

  it('leave out layers that are gone or on another page, and everything when they look at another page', () => {
    const { doc: start, pageId, other } = page();
    const here = addLayer(start, 'RECTANGLE', pageId, { x: 0, y: 0, width: 10, height: 10 });
    const there = addLayer(here.doc, 'RECTANGLE', other, { x: 0, y: 0, width: 10, height: 10 });
    const view = { x: 0, y: 0, zoom: 1 };
    expect(selectionOutlines(there.doc, presence({ pageId, selection: [here.id, there.id, 'gone'] }), pageId, view)).toHaveLength(1);
    expect(selectionOutlines(there.doc, presence({ pageId: other, selection: [here.id] }), pageId, view)).toEqual([]);
  });
});

describe('comment pins', () => {
  const thread = (partial: Partial<Thread>): Thread => ({ id: 't', docId: 'd', pageId: 'p', x: 0, y: 0, nodeId: null, resolved: false, createdAt: '', comments: [], ...partial });

  it('are placed on the layer under the click, relative to its corner, or on the page', () => {
    const { doc: start, pageId } = page();
    const { doc, id } = addLayer(start, 'RECTANGLE', pageId, { x: 100, y: 100, width: 200, height: 100 });
    const view = { x: 50, y: 50, zoom: 2 };
    // Screen (150, 150) is page (125, 125): inside the rectangle, 25 from its corner each way.
    expect(pinAt(doc, pageId, view, { x: 150, y: 150 })).toEqual({ pageId, nodeId: id, x: 25, y: 25 });
    // Screen (10, 10) is page (55, 55): empty page.
    expect(pinAt(doc, pageId, view, { x: 10, y: 10 })).toEqual({ pageId, nodeId: null, x: 55, y: 55 });
  });

  it('follow their layer when it moves, and stay where they were put when it is deleted', () => {
    const { doc: start, pageId } = page();
    const { doc, id } = addLayer(start, 'RECTANGLE', pageId, { x: 100, y: 100, width: 200, height: 100 });
    const pinned = thread({ pageId, nodeId: id, x: 25, y: 10 });
    expect(threadAnchor(doc, pinned)).toEqual({ x: 125, y: 110 });
    const moved = patchNode(doc, id, { x: 400 } as never);
    expect(threadAnchor(moved, pinned)).toEqual({ x: 425, y: 110 });
    const { [id]: _gone, ...rest } = moved.nodes;
    expect(threadAnchor({ ...moved, nodes: rest }, pinned)).toEqual({ x: 25, y: 10 });
    expect(threadAnchor(doc, thread({ pageId, x: 7, y: 8 }))).toEqual({ x: 7, y: 8 });
  });

  it('round-trip: a pin placed by a click is drawn back where the click was', () => {
    const { doc: start, pageId } = page();
    const { doc } = addLayer(start, 'ELLIPSE', pageId, { x: -40, y: 30, width: 120, height: 120 });
    const view = { x: -100, y: -20, zoom: 1.5 };
    for (const click of [
      { x: 120, y: 140 },
      { x: 5, y: 7 },
    ]) {
      const pin = pinAt(doc, pageId, view, click);
      const back = worldToScreen(view, threadAnchor(doc, thread(pin)));
      expect(back.x).toBeCloseTo(click.x, 1);
      expect(back.y).toBeCloseTo(click.y, 1);
    }
  });
});

describe('following someone', () => {
  it('shows exactly their view on a canvas of the same size', () => {
    const theirs = viewportPresence({ x: 120, y: -40, zoom: 0.5 }, { width: 800, height: 600 });
    const view = followViewport(theirs, { width: 800, height: 600 });
    expect(view.x).toBeCloseTo(120);
    expect(view.y).toBeCloseTo(-40);
    expect(view.zoom).toBeCloseTo(0.5);
  });

  it('keeps their middle in the middle and all of their view in sight on a smaller canvas', () => {
    // They see page x 0..1000, y 0..500 (2000 × 1000 pixels at zoom 2).
    const theirs = { x: 0, y: 0, zoom: 2, width: 2000, height: 1000 };
    const size = { width: 500, height: 500 };
    const view = followViewport(theirs, size);
    expect(view.zoom).toBeCloseTo(0.5);
    // The middle of the canvas is the middle of their view, (500, 250).
    expect(view.x + size.width / view.zoom / 2).toBeCloseTo(500);
    expect(view.y + size.height / view.zoom / 2).toBeCloseTo(250);
  });

  it('centres a comment at the current zoom when going to it', () => {
    const view = centredOn({ x: 300, y: 200 }, { x: 0, y: 0, zoom: 2 }, { width: 400, height: 300 });
    expect(view).toEqual({ x: 200, y: 125, zoom: 2 });
  });
});
