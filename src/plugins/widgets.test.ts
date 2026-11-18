import { describe, expect, it } from 'vitest';
import {
  CURRENT_SCHEMA_VERSION,
  duplicateNodes,
  getChildIds,
  getLayer,
  getWorldBounds,
  parseFile,
  selectionTargetAt,
  deeperTargetAt,
  serializeFile,
  parseFileText,
  toFile,
  validateDocument,
  type FrameNode,
  type NodeId,
  type TextNode,
} from '../core';
import { add, editor, example, pageOf, settle, startFake } from './testing';
import { placeWidget, runWidgetClick } from './widgetActions';
import { checkWidgetTree, drawWidget, insertWidget, widgetClickAt, widgetLayerId, WidgetRenderError } from './widgets';

const voteCounter = example('vote-counter');

const meta = { createdAt: '2026-11-17T10:00:00.000Z', updatedAt: '2026-11-17T10:00:00.000Z' };

function centre(store: ReturnType<typeof editor>, id: NodeId) {
  const b = getWorldBounds(store.getState().doc, id);
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

const tree = {
  type: 'frame',
  direction: 'horizontal',
  padding: 8,
  spacing: 4,
  fill: '#ffffff',
  cornerRadius: 6,
  children: [
    { type: 'rectangle', width: 20, height: 10, fill: '#ff000080', onClick: 'red' },
    { type: 'frame', direction: 'vertical', onClick: 'box', children: [{ type: 'text', text: 'Hi', fontSize: 12 }, { type: 'ellipse', width: 8, height: 8 }] },
  ],
};

describe('widget render trees', () => {
  it('become real layers of the widget frame, laid out by Auto Layout', () => {
    const store = editor();
    store.getState().apply('Widget', (doc) => insertWidget(doc, pageOf(store), { x: 10, y: 20 }, { pluginId: 'com.example.w', widgetId: 'box', name: 'Box' }, { n: 1 }, tree).doc);
    const doc = store.getState().doc;
    const frame = getLayer(doc, getChildIds(doc, pageOf(store))[0]!) as FrameNode;
    expect(frame).toMatchObject({ type: 'FRAME', name: 'Box', x: 10, y: 20, layoutMode: 'HORIZONTAL', itemSpacing: 4, paddingLeft: 8, cornerRadius: 6, layoutSizingHorizontal: 'HUG' });
    expect(frame.widget).toEqual({ pluginId: 'com.example.w', widgetId: 'box', state: { n: 1 }, version: 0, handlers: { '0': 'red', '1': 'box' } });
    const [rect, inner] = getChildIds(doc, frame.id);
    expect(rect).toBe(widgetLayerId(frame.id, '0'));
    expect(getLayer(doc, rect!)).toMatchObject({ type: 'RECTANGLE', width: 20, height: 10, fills: [expect.objectContaining({ opacity: 0.502, color: { r: 1, g: 0, b: 0 } })] });
    const [text, dot] = getChildIds(doc, inner!);
    expect(getLayer(doc, text!)).toMatchObject({ type: 'TEXT', characters: 'Hi', fontSize: 12 });
    expect(getLayer(doc, dot!)).toMatchObject({ type: 'ELLIPSE', width: 8 });
    // Hugging its contents: 8 + 20 + 4 + (the column) + 8 wide.
    const column = getLayer(doc, inner!) as FrameNode;
    expect(frame.width).toBe(8 + 20 + 4 + column.width + 8);
    expect(column.height).toBeGreaterThan(8);
    expect(validateDocument(doc)).toEqual([]);
  });

  it('drawing the same thing again changes nothing; a new state changes only what differs', () => {
    const store = editor();
    store.getState().apply('Widget', (doc) => insertWidget(doc, pageOf(store), { x: 0, y: 0 }, { pluginId: 'p.q', widgetId: 'w', name: 'W' }, null, tree).doc);
    const doc = store.getState().doc;
    const frameId = getChildIds(doc, pageOf(store))[0]!;
    const widget = (getLayer(doc, frameId) as FrameNode).widget!;
    const steps = store.getState().undoStack.length;
    // Once laid out, the same drawing is the same document: no change, no undo step.
    store.getState().apply('Redraw', (d) => drawWidget(d, frameId, tree, null, widget, 0));
    expect(store.getState().undoStack.length).toBe(steps);
    expect(store.getState().doc).toBe(doc);
    store.getState().apply('Redraw', (d) => drawWidget(d, frameId, { ...tree, children: [tree.children[0]] }, { n: 2 }, widget));
    const changed = store.getState().doc;
    expect(getChildIds(changed, frameId)).toEqual([widgetLayerId(frameId, '0')]);
    expect(changed.nodes[widgetLayerId(frameId, '0')]).toEqual(doc.nodes[widgetLayerId(frameId, '0')]);
    expect(changed.nodes[widgetLayerId(frameId, '1.0')]).toBeUndefined();
    expect((changed.nodes[frameId] as FrameNode).widget).toMatchObject({ state: { n: 2 }, version: 1, handlers: { '0': 'red' } });
    // Only the widget's data, its size and the layers that went are in the step.
    expect(Object.keys(store.getState().undoStack.at(-1)!.patch.nodes).sort()).toEqual([frameId, widgetLayerId(frameId, '1'), widgetLayerId(frameId, '1.0'), widgetLayerId(frameId, '1.1')].sort());
  });

  it('are checked, with what is wrong said', () => {
    expect(() => checkWidgetTree({ type: 'rectangle' })).toThrow('must be a frame at the top');
    expect(() => checkWidgetTree({ type: 'frame', children: [{ type: 'video' }] })).toThrow('The widget.children[0] has the type "video"');
    expect(() => checkWidgetTree({ type: 'frame', fill: 'red' })).toThrow('"red" is not a colour');
    expect(() => checkWidgetTree({ type: 'frame', width: 'wide' })).toThrow('must be a number of pixels, "hug" or "fill"');
    expect(() => checkWidgetTree({ type: 'text', children: [] })).toThrow(WidgetRenderError);
    expect(() => checkWidgetTree({ type: 'frame', children: [{ type: 'text', children: [] }] })).toThrow('only frames have children');
    expect(() => checkWidgetTree({ type: 'frame', children: Array.from({ length: 600 }, () => ({ type: 'rectangle' })) })).toThrow('at most 500 layers');
  });
});

describe('widgets on the canvas', () => {
  it('are picked as a whole, and a click finds the handler of what is under the pointer', () => {
    const store = editor();
    store.getState().apply('Widget', (doc) => insertWidget(doc, pageOf(store), { x: 0, y: 0 }, { pluginId: 'p.q', widgetId: 'w', name: 'W' }, null, tree).doc);
    const doc = store.getState().doc;
    const frameId = getChildIds(doc, pageOf(store))[0]!;
    const dot = widgetLayerId(frameId, '1.1');
    const point = centre(store, dot);
    expect(selectionTargetAt(doc, pageOf(store), point, [])).toBe(frameId);
    expect(selectionTargetAt(doc, pageOf(store), point, [frameId])).toBe(frameId);
    expect(deeperTargetAt(doc, pageOf(store), point, [frameId])).toBe(frameId);
    // Ctrl-click reaches the layer itself, as for any layer.
    expect(selectionTargetAt(doc, pageOf(store), point, [], { deep: true })).toBe(dot);
    // The dot has no handler: the column it is in has.
    expect(widgetClickAt(doc, pageOf(store), point)).toMatchObject({ frameId, handler: 'box', path: '1' });
    expect(widgetClickAt(doc, pageOf(store), centre(store, widgetLayerId(frameId, '0')))).toMatchObject({ handler: 'red', path: '0' });
    // Not on a widget.
    const other = add(store, 'RECTANGLE', { x: 500, y: 500 });
    expect(widgetClickAt(store.getState().doc, pageOf(store), centre(store, other))).toBeNull();
  });

  it('place and change through the plugin\'s sandbox, each click one undo step that everyone gets', async () => {
    const store = editor();
    const sandbox = startFake(voteCounter, null, { store });
    const before = store.getState().undoStack.length;
    const id = await placeWidget(store, sandbox.session, voteCounter.manifest, 'counter', { x: 40, y: 40 });
    expect(store.getState().undoStack.length).toBe(before + 1);
    expect(store.getState().undoStack.at(-1)?.label).toBe('Vote counter: Counter');
    expect(store.getState().selection).toEqual([id]);
    const frame = () => getLayer(store.getState().doc, id) as FrameNode;
    const count = () => (getLayer(store.getState().doc, widgetLayerId(id, '1')) as TextNode).characters;
    expect(frame().widget).toMatchObject({ pluginId: 'org.evora.vote-counter', widgetId: 'counter', state: { count: 0 }, handlers: { '0': 'decrement', '2': 'increment' } });
    expect(count()).toBe('0');

    const plus = centre(store, widgetLayerId(id, '2'));
    for (let i = 0; i < 2; i++) {
      const click = widgetClickAt(store.getState().doc, pageOf(store), plus)!;
      expect(click.handler).toBe('increment');
      await runWidgetClick(store, sandbox.session, 'Vote counter', click);
    }
    expect(frame().widget?.state).toEqual({ count: 2 });
    expect(frame().widget?.version).toBe(2);
    expect(count()).toBe('2');
    expect(store.getState().undoStack.length).toBe(before + 3);
    expect(store.getState().undoStack.at(-1)?.label).toBe('Vote counter');
    store.getState().undo();
    expect(frame().widget?.state).toEqual({ count: 1 });
    expect(count()).toBe('1');

    // A copy of the widget works on its own: handlers go by place in the widget, not by layer ID.
    let copy = '';
    store.getState().apply('Duplicate', (doc) => {
      const made = duplicateNodes(doc, [id]);
      copy = made.ids[0]!;
      return made.doc;
    });
    store.getState().apply('Move', (doc) => ({ ...doc, nodes: { ...doc.nodes, [copy]: { ...(doc.nodes[copy] as FrameNode), x: 400 } } }));
    const minus = centre(store, getChildIds(store.getState().doc, copy)[0]!);
    const click = widgetClickAt(store.getState().doc, pageOf(store), minus)!;
    expect(click).toMatchObject({ frameId: copy, handler: 'decrement' });
    await runWidgetClick(store, sandbox.session, 'Vote counter', click);
    expect((getLayer(store.getState().doc, copy) as FrameNode).widget?.state).toEqual({ count: 0 });
    expect(frame().widget?.state).toEqual({ count: 1 });

    // On a file that may only be viewed, a click changes nothing.
    store.getState().setReadOnly(true);
    await expect(runWidgetClick(store, sandbox.session, 'Vote counter', widgetClickAt(store.getState().doc, pageOf(store), plus)!)).rejects.toThrow('can only be viewed');
    await expect(placeWidget(store, sandbox.session, voteCounter.manifest, 'upvote', { x: 0, y: 0 })).rejects.toThrow('can only be viewed');
    expect(frame().widget?.state).toEqual({ count: 1 });
    await settle();
  });

  it('show a click handler\'s error and change nothing', async () => {
    const store = editor();
    const bundle = { ...voteCounter, code: voteCounter.code.replace('increment: (state) => ({ ...state, count: state.count + 1 })', 'increment: () => { throw new Error("no more") }') };
    const sandbox = startFake(bundle, null, { store });
    const id = await placeWidget(store, sandbox.session, voteCounter.manifest, 'counter', { x: 0, y: 0 });
    const click = widgetClickAt(store.getState().doc, pageOf(store), centre(store, widgetLayerId(id, '2')))!;
    const steps = store.getState().undoStack.length;
    await expect(runWidgetClick(store, sandbox.session, 'Vote counter', click)).rejects.toThrow('no more');
    expect(store.getState().undoStack.length).toBe(steps);
  });
});

describe('schema 26', () => {
  it('opens a version 25 file, whose frames are not widgets, and keeps it through saving and opening', () => {
    const store = editor();
    add(store, 'FRAME', { name: 'Screen' });
    const current = store.getState().doc;
    const v25 = JSON.parse(JSON.stringify(current)) as { nodes: Record<string, Record<string, unknown>> };
    for (const nodeId in v25.nodes) delete v25.nodes[nodeId]!.widget;
    const parsed = parseFile({ format: 'evora', schemaVersion: 25, meta, document: v25 });
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(26);
    expect(parsed.repairs).toEqual([]);
    expect(parsed.file.document).toEqual(current);
    const frame = Object.values(parsed.file.document.nodes).find((node) => node.type === 'FRAME') as FrameNode;
    expect(frame.widget).toBeNull();
  });

  it('keeps a widget through saving and opening, and repairs widget data that is damaged', () => {
    const store = editor();
    store.getState().apply('Widget', (doc) => insertWidget(doc, pageOf(store), { x: 0, y: 0 }, { pluginId: 'p.q', widgetId: 'w', name: 'W' }, { list: [1, 'two', null], ok: true }, tree).doc);
    const doc = store.getState().doc;
    const reopened = parseFileText(serializeFile(toFile(doc, meta)));
    expect(reopened.repairs).toEqual([]);
    expect(reopened.file.document).toEqual(doc);

    const frameId = getChildIds(doc, pageOf(store))[0]!;
    const damaged = (widget: unknown) => {
      const raw = JSON.parse(JSON.stringify(toFile(doc, meta))) as { document: { nodes: Record<string, Record<string, unknown>> } };
      raw.document.nodes[frameId]!.widget = widget;
      return (parseFile(raw).file.document.nodes[frameId] as FrameNode).widget;
    };
    expect(damaged({ pluginId: '', widgetId: 'w' })).toBeNull();
    expect(damaged('counter')).toBeNull();
    expect(damaged({ pluginId: 'p', widgetId: 'w', state: { big: 'x'.repeat(200_000) }, version: -3, handlers: { 'a.b': 'x', '0.1': 'go', '2': 7 } })).toEqual({ pluginId: 'p', widgetId: 'w', state: null, version: 0, handlers: { '0.1': 'go' } });
  });
});
