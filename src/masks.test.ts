import { describe, expect, it } from 'vitest';
import {
  addLayer,
  createDocument,
  CURRENT_SCHEMA_VERSION,
  flattenNodes,
  getChildIds,
  getPages,
  hitTestDeepest,
  parseFile,
  patchNode,
  repairDocument,
  solidPaint,
  validateDocument,
  type Document,
  type LayerNode,
  type NodeId,
} from './core';
import { renderScene } from './engine/render/scene';
import { commandForKey, getCommand, runCommand, type AppActions, type Command } from './state/commands';
import { createEditorStore } from './state/editorStore';

function setup(): { doc: Document; pageId: NodeId } {
  const doc = createDocument('Masks');
  return { doc, pageId: (getPages(doc)[0] as { id: NodeId }).id };
}

const RED = solidPaint({ r: 1, g: 0, b: 0 });
const BLUE = solidPaint({ r: 0, g: 0, b: 1 });
const view = { size: { width: 800, height: 600 }, dpr: 1, viewport: { x: 0, y: 0, zoom: 1 } };

/** A circle (red) with a square (blue) over its lower right part. The circle is the bottom layer. */
function scene(): { doc: Document; pageId: NodeId; circle: NodeId; square: NodeId } {
  const { doc, pageId } = setup();
  const circle = addLayer(doc, 'ELLIPSE', pageId, { x: 100, y: 100, width: 200, height: 200, fills: [RED] });
  const square = addLayer(circle.doc, 'RECTANGLE', pageId, { x: 200, y: 200, width: 200, height: 200, fills: [BLUE] });
  return { doc: square.doc, pageId, circle: circle.id, square: square.id };
}

/** Canvas contexts that record what is painted on which canvas: the page's own ("main") or a scratch one. */
function harness(): { ctx: CanvasRenderingContext2D; createCanvas: () => HTMLCanvasElement; calls: string[] } {
  const calls: string[] = [];
  let count = 0;
  const make = (name: string): CanvasRenderingContext2D => {
    const target: Record<string, unknown> = {};
    const canvas = { name };
    const proxy: CanvasRenderingContext2D = new Proxy(target, {
      get(obj, prop: string) {
        if (prop === 'canvas') return canvas;
        if (prop in obj) return obj[prop];
        return (...args: unknown[]) => {
          if (prop === 'fill' || prop === 'clip') calls.push(`${name}:${prop}:${String(obj.fillStyle ?? '')}`);
          if (prop === 'drawImage') calls.push(`${name}:drawImage:${(args[0] as { name?: string }).name ?? '?'}:${String(obj.globalCompositeOperation ?? 'source-over')}`);
        };
      },
      set(obj, prop: string, value) {
        obj[prop] = value;
        return true;
      },
    }) as unknown as CanvasRenderingContext2D;
    return proxy;
  };
  return {
    ctx: make('main'),
    calls,
    createCanvas: () => {
      const name = `scratch${++count}`;
      const ctx = make(name);
      return { name, getContext: () => ctx } as unknown as HTMLCanvasElement;
    },
  };
}

describe('masks', () => {
  it('paints the layers above a mask through it, and not the mask itself', () => {
    const { doc, pageId, circle } = scene();
    const plain = harness();
    renderScene(plain.ctx, doc, pageId, { ...view, createCanvas: plain.createCanvas });
    // Without a mask both are simply painted, bottom first.
    expect(plain.calls).toEqual(['main:fill:rgb(255, 0, 0)', 'main:fill:rgb(0, 0, 255)']);

    const masked = harness();
    const stats = renderScene(masked.ctx, patchNode(doc, circle, { isMask: true }), pageId, { ...view, createCanvas: masked.createCanvas });
    expect(stats).toEqual({ drawn: 2, culled: 0 });
    expect(masked.calls).toEqual([
      // The square on one scratch canvas, the circle on another.
      'scratch1:fill:rgb(0, 0, 255)',
      'scratch2:fill:rgb(255, 0, 0)',
      // What the circle does not cover is taken out of the square...
      'scratch1:drawImage:scratch2:destination-in',
      // ...and what is left goes onto the page. The circle never does.
      'main:drawImage:scratch1:source-over',
    ]);
  });

  it('clips to the mask’s outline where nothing can be composited', () => {
    const { doc, pageId, circle } = scene();
    const h = harness();
    renderScene(h.ctx, patchNode(doc, circle, { isMask: true }), pageId, view);
    expect(h.calls).toEqual(['main:clip:rgb(30, 30, 30)', 'main:fill:rgb(0, 0, 255)']);
  });

  it('masks only what is above it, in its own parent, up to the next mask', () => {
    const { doc, pageId } = setup();
    const below = addLayer(doc, 'RECTANGLE', pageId, { x: 0, y: 0, fills: [solidPaint({ r: 0, g: 1, b: 0 })] });
    const mask = addLayer(below.doc, 'ELLIPSE', pageId, { x: 0, y: 0, fills: [RED], isMask: true });
    const inside = addLayer(mask.doc, 'RECTANGLE', pageId, { x: 20, y: 20, fills: [BLUE] });
    const second = addLayer(inside.doc, 'RECTANGLE', pageId, { x: 300, y: 0, fills: [solidPaint({ r: 1, g: 1, b: 0 })], isMask: true });
    const last = addLayer(second.doc, 'RECTANGLE', pageId, { x: 320, y: 20, fills: [solidPaint({ r: 0, g: 1, b: 1 })] });
    const h = harness();
    renderScene(h.ctx, last.doc, pageId, { ...view, createCanvas: h.createCanvas });
    expect(h.calls).toEqual([
      // The layer below the first mask is untouched by it.
      'main:fill:rgb(0, 255, 0)',
      'scratch1:fill:rgb(0, 0, 255)',
      'scratch2:fill:rgb(255, 0, 0)',
      'scratch1:drawImage:scratch2:destination-in',
      'main:drawImage:scratch1:source-over',
      // The second mask starts again with the layers above it.
      'scratch2:fill:rgb(0, 255, 255)',
      'scratch1:fill:rgb(255, 255, 0)',
      'scratch2:drawImage:scratch1:destination-in',
      'main:drawImage:scratch2:source-over',
    ]);

    // A mask inside a frame leaves the frame's neighbours alone.
    const { doc: empty, pageId: page } = setup();
    const frame = addLayer(empty, 'FRAME', page, { x: 0, y: 0, width: 300, height: 300, fills: [], clipsContent: false });
    const inner = addLayer(frame.doc, 'ELLIPSE', frame.id, { x: 0, y: 0, fills: [RED], isMask: true });
    const neighbour = addLayer(inner.doc, 'RECTANGLE', page, { x: 400, y: 0, fills: [BLUE] });
    const other = harness();
    renderScene(other.ctx, neighbour.doc, page, { ...view, createCanvas: other.createCanvas });
    expect(other.calls).toEqual(['main:fill:rgb(0, 0, 255)']);
  });

  it('masks nothing while it is hidden, and paints nothing if nothing is above it', () => {
    const { doc, pageId, circle } = scene();
    const hidden = harness();
    renderScene(hidden.ctx, patchNode(doc, circle, { isMask: true, visible: false }), pageId, { ...view, createCanvas: hidden.createCanvas });
    expect(hidden.calls).toEqual(['main:fill:rgb(0, 0, 255)']);

    const { doc: empty, pageId: page } = setup();
    const alone = addLayer(empty, 'ELLIPSE', page, { fills: [RED], isMask: true });
    const h = harness();
    expect(renderScene(h.ctx, alone.doc, page, { ...view, createCanvas: h.createCanvas })).toEqual({ drawn: 0, culled: 0 });
    expect(h.calls).toEqual([]);
  });

  it('lets clicks through only where the mask does, and is not clicked itself', () => {
    const { doc, pageId, circle, square } = scene();
    // Unmasked: the circle and the square are both there to be clicked.
    expect(hitTestDeepest(doc, pageId, { x: 150, y: 150 })).toBe(circle);
    expect(hitTestDeepest(doc, pageId, { x: 380, y: 380 })).toBe(square);

    const masked = patchNode(doc, circle, { isMask: true });
    // In the square and in the circle.
    expect(hitTestDeepest(masked, pageId, { x: 220, y: 220 })).toBe(square);
    // In the square, but the circle does not reach there.
    expect(hitTestDeepest(masked, pageId, { x: 380, y: 380 })).toBeNull();
    // In the circle only: a mask paints nothing, so there is nothing to click.
    expect(hitTestDeepest(masked, pageId, { x: 150, y: 150 })).toBeNull();
    // A hidden mask masks nothing.
    expect(hitTestDeepest(patchNode(masked, circle, { visible: false }), pageId, { x: 380, y: 380 })).toBe(square);
  });

  it('is switched on and off with "Use as mask"', () => {
    const { doc, circle, square } = scene();
    const app: AppActions = { cancelInteraction: () => false, openShortcuts: () => undefined, saveNow: () => undefined, saveAs: () => undefined, placeImage: () => undefined, goHome: () => undefined };
    const store = createEditorStore(doc);
    const command = commandForKey({ code: 'KeyM', ctrlKey: true, shiftKey: false, altKey: true, metaKey: false }) as Command;
    expect(command.id).toBe('object.mask');
    expect(command.enabled?.(store.getState())).toBe(false);

    store.getState().setSelection([circle]);
    expect(command.checked?.(store.getState())).toBe(false);
    runCommand(command, { store, app });
    expect(store.getState().doc.nodes[circle]).toMatchObject({ isMask: true });
    expect(command.checked?.(store.getState())).toBe(true);
    runCommand(command, { store, app });
    expect(store.getState().doc.nodes[circle]).toMatchObject({ isMask: false });
    expect(store.getState().undoStack.map((entry) => entry.label)).toEqual(['Use as mask', 'Remove mask']);

    // Several layers: grouped, with the bottom one masking the rest.
    store.getState().setSelection([square, circle]);
    runCommand(getCommand('object.mask') as Command, { store, app });
    const state = store.getState();
    expect(state.selection).toHaveLength(1);
    const group = state.doc.nodes[state.selection[0] as NodeId] as LayerNode;
    expect(group).toMatchObject({ type: 'GROUP', name: 'Mask group' });
    expect(getChildIds(state.doc, group.id)).toEqual([circle, square]);
    expect(state.doc.nodes[circle]).toMatchObject({ isMask: true });
    expect(state.doc.nodes[square]).toMatchObject({ isMask: false });
    state.undo();
    expect(store.getState().doc.nodes[circle]).toMatchObject({ isMask: false, parentId: (doc.nodes[circle] as LayerNode).parentId });
  });

  it('survives flattening, validation and older files', () => {
    const { doc, pageId, circle } = scene();
    const masked = patchNode(doc, circle, { isMask: true });
    expect(validateDocument(masked)).toEqual([]);
    const flat = flattenNodes(masked, [circle]) as { doc: Document; id: NodeId };
    expect(flat.doc.nodes[circle]).toMatchObject({ type: 'VECTOR', isMask: true });

    const data = JSON.parse(JSON.stringify(masked)) as { nodes: Record<string, Record<string, unknown>> };
    (data.nodes[circle] as Record<string, unknown>).isMask = 'yes';
    expect(repairDocument(data).doc.nodes[circle]).toMatchObject({ isMask: false });

    // A version 9 file knows nothing of masks: none of its layers is one.
    const v9 = JSON.parse(JSON.stringify(doc)) as { nodes: Record<string, Record<string, unknown>> };
    for (const id in v9.nodes) delete (v9.nodes[id] as Record<string, unknown>).isMask;
    const parsed = parseFile({ format: 'open-design', schemaVersion: 9, meta: { createdAt: '2026-11-16T14:00:00.000Z', updatedAt: '2026-11-16T14:00:00.000Z' }, document: v9 });
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(10);
    expect(parsed.file.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(parsed.repairs).toEqual([]);
    expect(parsed.file.document).toEqual(doc);
    expect(pageId in parsed.file.document.nodes).toBe(true);
  });
});
