import { describe, expect, it } from 'vitest';
import { addLayer, createDocument, getPages, patchNode, setNodes, createLayer, type DesignNode, type Document, type NodeId } from '../../core';
import { freshKeys } from '../../core/order';
import { fitRect, nextZoomStep, screenToWorld, visibleRect, worldToScreen, zoomAt } from '../viewport';
import { getRenderBounds, renderScene } from './scene';

/** A canvas context that accepts every call and records the ones the tests look at. */
function recordingContext(): { ctx: CanvasRenderingContext2D; calls: string[] } {
  const calls: string[] = [];
  const target: Record<string, unknown> = {};
  const ctx = new Proxy(target, {
    get(obj, prop: string) {
      if (prop in obj) return obj[prop];
      return (...args: unknown[]) => {
        if (prop === 'fill' || prop === 'stroke' || prop === 'clip' || prop === 'fillRect') calls.push(`${prop}:${String(obj.fillStyle ?? '')}`);
        void args;
      };
    },
    set(obj, prop: string, value) {
      obj[prop] = value;
      return true;
    },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

function setup(): { doc: Document; pageId: NodeId } {
  const doc = createDocument('Render');
  return { doc, pageId: (getPages(doc)[0] as { id: NodeId }).id };
}

const options = { size: { width: 800, height: 600 }, dpr: 1, viewport: { x: 0, y: 0, zoom: 1 } };

describe('scene renderer', () => {
  it('paints the page background and each visible fill', () => {
    const { doc, pageId } = setup();
    const a = addLayer(doc, 'RECTANGLE', pageId, { x: 10, y: 10 });
    const { ctx, calls } = recordingContext();
    const stats = renderScene(ctx, a.doc, pageId, options);
    expect(stats).toEqual({ drawn: 1, culled: 0 });
    expect(calls).toEqual(['fillRect:rgb(30, 30, 30)', 'fill:rgb(217, 217, 217)']);
  });

  it('skips hidden layers and everything inside them', () => {
    const { doc, pageId } = setup();
    const frame = addLayer(doc, 'FRAME', pageId, { width: 200, height: 200 });
    const child = addLayer(frame.doc, 'RECTANGLE', frame.id, { x: 10, y: 10 });
    const hidden = patchNode(child.doc, frame.id, { visible: false });
    const { ctx, calls } = recordingContext();
    expect(renderScene(ctx, hidden, pageId, options)).toEqual({ drawn: 0, culled: 0 });
    expect(calls).toEqual(['fillRect:rgb(30, 30, 30)']);
  });

  it('culls layers outside the viewport, including whole clipped frames', () => {
    const { doc, pageId } = setup();
    const inView = addLayer(doc, 'RECTANGLE', pageId, { x: 100, y: 100 });
    const offscreen = addLayer(inView.doc, 'RECTANGLE', pageId, { x: 5000, y: 5000 });
    const farFrame = addLayer(offscreen.doc, 'FRAME', pageId, { x: -3000, y: 0, width: 500, height: 500 });
    const inFarFrame = addLayer(farFrame.doc, 'RECTANGLE', farFrame.id, { x: 10, y: 10 });
    const { ctx } = recordingContext();
    expect(renderScene(ctx, inFarFrame.doc, pageId, options)).toEqual({ drawn: 1, culled: 2 });

    // Panning to the far frame brings it and its child into view.
    const there = { ...options, viewport: { x: -3100, y: -50, zoom: 1 } };
    expect(renderScene(ctx, inFarFrame.doc, pageId, there)).toEqual({ drawn: 2, culled: 2 });
  });

  it('keeps a frame that does not clip when only its overflowing child is visible', () => {
    const { doc, pageId } = setup();
    const frame = addLayer(doc, 'FRAME', pageId, { x: -1000, y: 0, width: 100, height: 100, clipsContent: false });
    const child = addLayer(frame.doc, 'RECTANGLE', frame.id, { x: 1100, y: 50 });
    expect(getRenderBounds(child.doc, frame.id)).toEqual({ x: -1000, y: 0, width: 1200, height: 150 });
    const { ctx } = recordingContext();
    expect(renderScene(ctx, child.doc, pageId, options)).toEqual({ drawn: 2, culled: 0 });
    // With clipping on, the same frame is entirely off screen.
    const clipped = patchNode(child.doc, frame.id, { clipsContent: true });
    expect(renderScene(ctx, clipped, pageId, options)).toEqual({ drawn: 0, culled: 1 });
  });

  it('draws only what is visible in a document with ten thousand layers', () => {
    const { doc, pageId } = setup();
    const keys = freshKeys(10_000);
    const nodes: Record<NodeId, DesignNode> = {};
    for (let i = 0; i < 10_000; i++) {
      const node = createLayer('RECTANGLE', pageId, keys[i] as string, {
        x: (i % 100) * 120,
        y: Math.floor(i / 100) * 120,
        width: 100,
        height: 100,
      });
      nodes[node.id] = node;
    }
    const big = setNodes(doc, nodes);
    const { ctx } = recordingContext();
    const started = performance.now();
    const stats = renderScene(ctx, big, pageId, options);
    const elapsed = performance.now() - started;
    // An 800 × 600 view over a 120-unit grid shows 7 columns × 6 rows (the sixth row touches the bottom edge).
    expect(stats).toEqual({ drawn: 42, culled: 9_958 });
    expect(elapsed).toBeLessThan(500);
  });
});

describe('viewport', () => {
  it('converts between screen and page coordinates', () => {
    const v = { x: 100, y: 50, zoom: 2 };
    expect(screenToWorld(v, { x: 20, y: 10 })).toEqual({ x: 110, y: 55 });
    expect(worldToScreen(v, { x: 110, y: 55 })).toEqual({ x: 20, y: 10 });
    expect(visibleRect(v, { width: 800, height: 600 })).toEqual({ x: 100, y: 50, width: 400, height: 300 });
  });

  it('zooms about a fixed screen point and clamps the zoom', () => {
    const v = zoomAt({ x: 0, y: 0, zoom: 1 }, { x: 400, y: 300 }, 4);
    expect(screenToWorld(v, { x: 400, y: 300 })).toEqual({ x: 400, y: 300 });
    expect(zoomAt(v, { x: 0, y: 0 }, 100_000).zoom).toBe(256);
    expect(zoomAt(v, { x: 0, y: 0 }, 0).zoom).toBe(0.02);
  });

  it('fits a rectangle in the view with padding', () => {
    const v = fitRect({ x: 0, y: 0, width: 1000, height: 500 }, { width: 600, height: 600 }, 50);
    expect(v.zoom).toBe(0.5);
    expect(screenToWorld(v, { x: 300, y: 300 })).toEqual({ x: 500, y: 250 });
  });

  it('steps through zoom levels', () => {
    expect(nextZoomStep(1, 1)).toBe(2);
    expect(nextZoomStep(1, -1)).toBe(0.5);
    expect(nextZoomStep(1.5, 1)).toBe(2);
    expect(nextZoomStep(1.5, -1)).toBe(1);
    expect(nextZoomStep(256, 1)).toBe(256);
  });
});
