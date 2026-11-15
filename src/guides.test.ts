import { describe, expect, it } from 'vitest';
import {
  addLayer,
  createDocument,
  CURRENT_SCHEMA_VERSION,
  duplicatePage,
  getLayer,
  getPages,
  guideSnapTargets,
  hitGuide,
  parseFile,
  patchNode,
  repairDocument,
  setGuide,
  validateDocument,
  type Document,
  type Guide,
  type LayerNode,
  type NodeId,
  type PageNode,
} from './core';
import { InteractionController, type PointerInput } from './engine/input/controller';
import { niceStep, RULER_SIZE, rulerTicks } from './engine/render/rulers';
import { commandForKey, getCommand } from './state/commands';
import { createEditorStore, type EditorStore } from './state/editorStore';

function setup(): { doc: Document; pageId: NodeId } {
  const doc = createDocument('Guides');
  return { doc, pageId: (getPages(doc)[0] as { id: NodeId }).id };
}

const guidesOf = (doc: Document, pageId: NodeId): Guide[] => (doc.nodes[pageId] as PageNode).guides;

describe('ruler ticks', () => {
  it('picks round steps', () => {
    expect(niceStep(1)).toBe(1);
    expect(niceStep(1.2)).toBe(2);
    expect(niceStep(3)).toBe(5);
    expect(niceStep(7)).toBe(10);
    expect(niceStep(64)).toBe(100);
    expect(niceStep(640)).toBe(1000);
    expect(niceStep(0.3)).toBeCloseTo(0.5);
    expect(niceStep(0)).toBe(1);
    expect(niceStep(Number.NaN)).toBe(1);
  });

  it('labels round page coordinates and puts four minor ticks between them', () => {
    // At 100% labels are 100 apart (the first round step of at least 64px), so minor ticks are 20 apart.
    const ticks = rulerTicks(0, 1, 300);
    expect(ticks.filter((tick) => tick.major).map((tick) => tick.value)).toEqual([0, 100, 200, 300]);
    expect(ticks.slice(0, 6).map((tick) => tick.value)).toEqual([0, 20, 40, 60, 80, 100]);
    expect(ticks.find((tick) => tick.value === 100)?.position).toBe(100);
  });

  it('follows the viewport and the zoom', () => {
    // Zoomed in four times, starting at page x = -30: labels every 20 units, 80px apart.
    const ticks = rulerTicks(-30, 4, 400);
    const major = ticks.filter((tick) => tick.major);
    // 400px of canvas show page x from -30 to 70.
    expect(major.map((tick) => tick.value)).toEqual([-20, 0, 20, 40, 60]);
    expect(major.find((tick) => tick.value === 0)?.position).toBe(120);
    // Zoomed far out the labels are thousands apart.
    expect(rulerTicks(0, 0.05, 400).filter((tick) => tick.major).map((tick) => tick.value)).toEqual([0, 2000, 4000, 6000, 8000]);
  });
});

describe('guides on a page', () => {
  it('adds, moves and removes guides', () => {
    const { doc, pageId } = setup();
    expect(guidesOf(doc, pageId)).toEqual([]);
    const one = setGuide(doc, pageId, null, { axis: 'X', position: 100 });
    const two = setGuide(one, pageId, null, { axis: 'Y', position: 50 });
    expect(guidesOf(two, pageId)).toEqual([
      { axis: 'X', position: 100 },
      { axis: 'Y', position: 50 },
    ]);
    const moved = setGuide(two, pageId, 0, { axis: 'X', position: 140 });
    expect(guidesOf(moved, pageId)[0]).toEqual({ axis: 'X', position: 140 });
    expect(guidesOf(setGuide(moved, pageId, 0, null), pageId)).toEqual([{ axis: 'Y', position: 50 }]);
    // Nothing to do: the same document comes back.
    expect(setGuide(two, pageId, 0, { axis: 'X', position: 100 })).toBe(two);
    expect(setGuide(two, pageId, 9, null)).toBe(two);
    expect(setGuide(two, pageId, null, null)).toBe(two);
  });

  it('finds the guide nearest the pointer', () => {
    const guides: Guide[] = [
      { axis: 'X', position: 100 },
      { axis: 'Y', position: 50 },
      { axis: 'X', position: 104 },
    ];
    expect(hitGuide(guides, { x: 101, y: 500 }, 4)).toBe(0);
    expect(hitGuide(guides, { x: 103, y: 500 }, 4)).toBe(2);
    expect(hitGuide(guides, { x: 300, y: 52 }, 4)).toBe(1);
    expect(hitGuide(guides, { x: 300, y: 300 }, 4)).toBeNull();
    // A vertical and a horizontal guide crossing: the nearer line wins.
    expect(hitGuide(guides, { x: 100, y: 53 }, 4)).toBe(0);
  });

  it('offers guides as snap lines', () => {
    const targets = guideSnapTargets([
      { axis: 'X', position: 100 },
      { axis: 'Y', position: 50 },
    ]);
    expect(targets.xs.map((line) => line.value)).toEqual([100]);
    expect(targets.ys.map((line) => line.value)).toEqual([50]);
  });

  it('copies guides with a duplicated page', () => {
    const { doc, pageId } = setup();
    const withGuide = setGuide(doc, pageId, null, { axis: 'Y', position: 200 });
    const copy = duplicatePage(withGuide, pageId);
    if (!copy) throw new Error('no copy');
    expect(guidesOf(copy.doc, copy.id)).toEqual([{ axis: 'Y', position: 200 }]);
    expect(guidesOf(copy.doc, copy.id)).not.toBe(guidesOf(copy.doc, pageId));
  });

  it('validates guides and drops broken ones', () => {
    const { doc, pageId } = setup();
    const withGuides = patchNode(doc, pageId, { guides: [{ axis: 'X', position: 10 }, { axis: 'Y', position: -4.5 }] });
    expect(validateDocument(withGuides)).toEqual([]);
    const data = JSON.parse(JSON.stringify(withGuides)) as { nodes: Record<string, Record<string, unknown>> };
    (data.nodes[pageId] as Record<string, unknown>).guides = [{ axis: 'X', position: 10 }, { axis: 'Z', position: 1 }, { axis: 'Y', position: 'low' }, null];
    expect(guidesOf(repairDocument(data).doc, pageId)).toEqual([{ axis: 'X', position: 10 }]);
  });

  it('opens a version 6 file with no guides', () => {
    const { doc, pageId } = setup();
    const v6 = JSON.parse(JSON.stringify(doc)) as { nodes: Record<string, Record<string, unknown>> };
    delete (v6.nodes[pageId] as Record<string, unknown>).guides;
    const parsed = parseFile({
      format: 'open-design',
      schemaVersion: 6,
      meta: { createdAt: '2026-11-15T20:00:00.000Z', updatedAt: '2026-11-15T20:00:00.000Z' },
      document: v6,
    });
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(7);
    expect(parsed.file.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(parsed.repairs).toEqual([]);
    expect(parsed.file.document).toEqual(doc);
  });
});

describe('rulers and guides in the editor', () => {
  function editor(showRulers = true, doc: Document = createDocument('Guides')): { store: EditorStore; controller: InteractionController; cursors: string[] } {
    const store = createEditorStore(doc, undefined, { showRulers });
    store.getState().setCanvasSize({ width: 800, height: 600 });
    const cursors: string[] = [];
    const controller = new InteractionController(store, { requestRender: () => undefined, setCursor: (cursor) => cursors.push(cursor) });
    return { store, controller, cursors };
  }

  const ptr = (x: number, y: number): PointerInput => ({ x, y, button: 0, shiftKey: false, altKey: false, ctrlKey: false, detail: 1 });
  const drag = (controller: InteractionController, from: [number, number], to: [number, number]): void => {
    controller.pointerDown(ptr(from[0], from[1]));
    controller.pointerMove(ptr((from[0] + to[0]) / 2, (from[1] + to[1]) / 2));
    controller.pointerMove(ptr(to[0], to[1]));
    controller.pointerUp(ptr(to[0], to[1]));
  };
  const guides = (store: EditorStore): Guide[] => guidesOf(store.getState().doc, store.getState().pageId);

  it('pulls a horizontal guide out of the top ruler and a vertical one out of the left ruler', () => {
    const { store, controller } = editor();
    drag(controller, [300, 10], [300, 200]);
    expect(guides(store)).toEqual([{ axis: 'Y', position: 200 }]);
    drag(controller, [10, 300], [150, 300]);
    expect(guides(store)).toEqual([
      { axis: 'Y', position: 200 },
      { axis: 'X', position: 150 },
    ]);
    expect(store.getState().undoStack.map((entry) => entry.label)).toEqual(['Add guide', 'Add guide']);
    store.getState().undo();
    expect(guides(store)).toEqual([{ axis: 'Y', position: 200 }]);
  });

  it('moves a guide by dragging it, and removes it when dragged back onto its ruler', () => {
    const { store, controller, cursors } = editor();
    drag(controller, [300, 10], [300, 200]);
    controller.pointerMove(ptr(500, 201));
    expect(cursors.at(-1)).toBe('row-resize');

    // Grabbed a pixel off the line: the guide goes to where the pointer is released.
    drag(controller, [500, 201], [500, 350]);
    expect(guides(store)).toEqual([{ axis: 'Y', position: 350 }]);
    expect(store.getState().undoStack.at(-1)?.label).toBe('Move guide');

    drag(controller, [500, 350], [500, 5]);
    expect(guides(store)).toEqual([]);
    expect(store.getState().undoStack.at(-1)?.label).toBe('Remove guide');
    store.getState().undo();
    expect(guides(store)).toEqual([{ axis: 'Y', position: 350 }]);
  });

  it('adds nothing when a guide is pulled out and dropped back on the ruler', () => {
    const { store, controller } = editor();
    drag(controller, [300, 10], [300, 15]);
    expect(guides(store)).toEqual([]);
    expect(store.getState().undoStack).toEqual([]);
  });

  it('follows the viewport: guides are placed in page coordinates', () => {
    const { store, controller } = editor();
    store.getState().setViewport({ x: 1000, y: 2000, zoom: 2 });
    drag(controller, [300, 10], [300, 200]);
    expect(guides(store)).toEqual([{ axis: 'Y', position: 2100 }]);
  });

  it('leaves the rulers alone with other tools, and the corner does nothing', () => {
    const { store, controller } = editor();
    store.getState().setTool('rectangle');
    drag(controller, [300, 10], [400, 200]);
    expect(Object.keys(store.getState().doc.nodes)).toHaveLength(1);
    expect(store.getState().tool).toBe('rectangle');
    store.getState().setTool('move');
    drag(controller, [5, 5], [300, 300]);
    expect(guides(store)).toEqual([]);
    expect(RULER_SIZE).toBe(20);
  });

  it('has no rulers or guides to grab when they are switched off', () => {
    const { doc, pageId } = setup();
    const withGuide = setGuide(doc, pageId, null, { axis: 'Y', position: 200 });
    const { store, controller } = editor(false, withGuide);
    // Pressing where the ruler would be starts an ordinary marquee.
    drag(controller, [300, 10], [300, 150]);
    expect(guides(store)).toEqual([{ axis: 'Y', position: 200 }]);
    // Dragging across the hidden guide does not move it.
    drag(controller, [500, 200], [500, 300]);
    expect(guides(store)).toEqual([{ axis: 'Y', position: 200 }]);
    expect(store.getState().undoStack).toEqual([]);
  });

  it('snaps layers to guides while the rulers are shown', () => {
    const { doc, pageId } = setup();
    const rect = addLayer(setGuide(doc, pageId, null, { axis: 'X', position: 300 }), 'RECTANGLE', pageId, { x: 100, y: 100, width: 50, height: 50 });
    const run = (showRulers: boolean): number => {
      const { store, controller } = editor(showRulers, rect.doc);
      store.getState().setSelection([rect.id]);
      // The right edge would land on x = 297; the guide is at 300.
      drag(controller, [125, 125], [272, 125]);
      return (getLayer(store.getState().doc, rect.id) as LayerNode).x;
    };
    expect(run(true)).toBe(250);
    expect(run(false)).toBe(247);
  });

  it('is switched on and off with Shift+R', () => {
    const { store } = editor(false);
    const command = commandForKey({ code: 'KeyR', ctrlKey: false, shiftKey: true, altKey: false, metaKey: false });
    expect(command?.id).toBe('view.rulers');
    expect(getCommand('view.rulers')?.checked?.(store.getState())).toBe(false);
    store.getState().setShowRulers(true);
    expect(getCommand('view.rulers')?.checked?.(store.getState())).toBe(true);
    // Plain R is still the rectangle tool.
    expect(commandForKey({ code: 'KeyR', ctrlKey: false, shiftKey: false, altKey: false, metaKey: false })?.id).toBe('tool.rectangle');
  });
});
