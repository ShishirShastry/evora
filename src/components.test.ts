import { describe, expect, it } from 'vitest';
import {
  addLayer,
  containerAt,
  createComponent,
  createDocument,
  createInstance,
  CURRENT_SCHEMA_VERSION,
  deleteNodes,
  detachInstances,
  duplicateNodes,
  getChildIds,
  getLayer,
  getPages,
  instanceOf,
  isComponent,
  isInstance,
  listComponents,
  mirrorId,
  parseFile,
  patchNode,
  patchNodes,
  repairDocument,
  reorderNodes,
  resetInstances,
  selectionTargetAt,
  setLayerBox,
  solidPaint,
  swapInstances,
  type Document,
  type FrameNode,
  type LayerNode,
  type LayerPatch,
  type NodeId,
  type TextNode,
} from './core';
import { createEditorStore, type EditorStore } from './state/editorStore';

/**
 * Components and instances, through the editor store, which keeps instances
 * in step after every change exactly as the application does. Text is
 * measured with the approximate measurer: 8 per character, lines of 19.
 */

const RED = { r: 1, g: 0, b: 0 };
const BLUE = { r: 0, g: 0, b: 1 };

interface Card {
  store: EditorStore;
  pageId: NodeId;
  /** The component: a 200 × 100 frame holding a 60 × 40 rectangle at (10, 10) and the text "Title" at (10, 60). */
  componentId: NodeId;
  rectId: NodeId;
  textId: NodeId;
}

function card(frameProps: LayerPatch = {}): Card {
  const store = createEditorStore(createDocument('Components'));
  const pageId = (getPages(store.getState().doc)[0] as { id: NodeId }).id;
  const ids = { componentId: '', rectId: '', textId: '' };
  store.getState().apply('Build', (doc) => {
    const frame = addLayer(doc, 'FRAME', pageId, { x: 0, y: 0, width: 200, height: 100, name: 'Card', ...frameProps });
    const rect = addLayer(frame.doc, 'RECTANGLE', frame.id, { x: 10, y: 10, width: 60, height: 40, name: 'Picture' });
    const text = addLayer(rect.doc, 'TEXT', frame.id, { x: 10, y: 60, characters: 'Title', name: 'Title' });
    ids.componentId = frame.id;
    ids.rectId = rect.id;
    ids.textId = text.id;
    return (createComponent(text.doc, [frame.id]) as { doc: Document }).doc;
  });
  return { store, pageId, ...ids };
}

const now = (store: EditorStore): Document => store.getState().doc;
const act = (store: EditorStore, fn: (doc: Document) => Document): void => store.getState().apply('Edit', fn);

/** Places an instance of a component at a point on the page and returns its ID. */
function place(store: EditorStore, componentId: NodeId, at = { x: 300, y: 0 }): NodeId {
  let id = '';
  act(store, (doc) => {
    const out = createInstance(doc, componentId, { parentId: store.getState().pageId, at }) as { doc: Document; id: NodeId };
    id = out.id;
    return out.doc;
  });
  return id;
}

const frameOf = (store: EditorStore, id: NodeId): FrameNode => getLayer(now(store), id) as FrameNode;
const layer = (store: EditorStore, id: NodeId): LayerNode => getLayer(now(store), id) as LayerNode;
const text = (store: EditorStore, id: NodeId): TextNode => getLayer(now(store), id) as TextNode;

describe('making components', () => {
  it('makes a frame into a component as it is', () => {
    const { store, componentId, rectId } = card();
    expect(frameOf(store, componentId)).toMatchObject({ kind: 'COMPONENT', name: 'Card', width: 200, height: 100, componentId: null, overrides: {} });
    expect(isComponent(frameOf(store, componentId))).toBe(true);
    expect(layer(store, rectId)).toMatchObject({ parentId: componentId, sourceId: null });
    expect(listComponents(now(store)).map((component) => component.id)).toEqual([componentId]);
  });

  it('puts anything else into a new frame that is the component', () => {
    const store = createEditorStore(createDocument('Components'));
    const pageId = store.getState().pageId;
    let ids: NodeId[] = [];
    let made = '';
    act(store, (doc) => {
      const a = addLayer(doc, 'RECTANGLE', pageId, { x: 100, y: 100, width: 50, height: 50 });
      const b = addLayer(a.doc, 'ELLIPSE', pageId, { x: 180, y: 120, width: 40, height: 40 });
      ids = [a.id, b.id];
      const out = createComponent(b.doc, ids) as { doc: Document; id: NodeId };
      made = out.id;
      return out.doc;
    });
    expect(frameOf(store, made)).toMatchObject({ kind: 'COMPONENT', name: 'Component 1', x: 100, y: 100, width: 120, height: 60, fills: [] });
    expect(getChildIds(now(store), made)).toEqual(ids);
    // Nothing moved on the page.
    expect(layer(store, ids[1] as NodeId)).toMatchObject({ x: 80, y: 20 });
    expect(getChildIds(now(store), pageId)).toEqual([made]);
  });

  it('does not make a component of anything inside a component or an instance', () => {
    const { store, componentId, rectId } = card();
    const instanceId = place(store, componentId);
    expect(createComponent(now(store), [rectId])).toBeNull();
    expect(createComponent(now(store), [componentId])).toBeNull();
    expect(createComponent(now(store), [instanceId])).toBeNull();
    expect(createComponent(now(store), [mirrorId(instanceId, rectId)])).toBeNull();
  });
});

describe('instances', () => {
  it('shows the component: the same layers, in the same places, each mirroring one of the component’s', () => {
    const { store, componentId, rectId, textId } = card();
    const instanceId = place(store, componentId);
    expect(frameOf(store, instanceId)).toMatchObject({ kind: 'INSTANCE', componentId, name: 'Card', x: 300, y: 0, width: 200, height: 100 });
    expect(isInstance(frameOf(store, instanceId))).toBe(true);
    const mirrors = getChildIds(now(store), instanceId);
    expect(mirrors).toEqual([mirrorId(instanceId, rectId), mirrorId(instanceId, textId)]);
    expect(layer(store, mirrors[0] as NodeId)).toMatchObject({ type: 'RECTANGLE', name: 'Picture', sourceId: rectId, x: 10, y: 10, width: 60, height: 40 });
    expect(text(store, mirrors[1] as NodeId)).toMatchObject({ type: 'TEXT', characters: 'Title', sourceId: textId, x: 10, y: 60, width: 40 });
    expect(instanceOf(now(store), mirrors[0] as NodeId)?.id).toBe(instanceId);
    expect(instanceOf(now(store), rectId)).toBeNull();
    // Placing it is one undo step, and takes its layers with it.
    store.getState().undo();
    expect(getLayer(now(store), instanceId)).toBeUndefined();
    expect(getLayer(now(store), mirrors[0] as NodeId)).toBeUndefined();
  });

  it('is placed beside its component when no place is given, and never inside it', () => {
    const { store, componentId, rectId } = card();
    let id = '';
    act(store, (doc) => {
      const out = createInstance(doc, componentId) as { doc: Document; id: NodeId };
      id = out.id;
      return out.doc;
    });
    expect(frameOf(store, id)).toMatchObject({ x: 240, y: 0, parentId: store.getState().pageId });
    expect(createInstance(now(store), componentId, { parentId: componentId, at: { x: 0, y: 0 } })).toBeNull();
    expect(createInstance(now(store), rectId)).toBeNull();
  });

  it('follows every change to the component', () => {
    const { store, componentId, rectId, textId } = card();
    const a = place(store, componentId);
    const b = place(store, componentId, { x: 300, y: 200 });
    const of = (instanceId: NodeId, sourceId: NodeId): LayerNode => layer(store, mirrorId(instanceId, sourceId));

    // A fill, a text, a place and a size.
    act(store, (doc) => patchNodes(doc, { [rectId]: { fills: [solidPaint(RED)], x: 100 }, [textId]: { characters: 'Heading' } }));
    for (const instanceId of [a, b]) {
      expect(of(instanceId, rectId)).toMatchObject({ fills: [solidPaint(RED)], x: 100 });
      expect(of(instanceId, textId)).toMatchObject({ characters: 'Heading', width: 56 });
    }
    // The component's own look and size.
    act(store, (doc) => setLayerBox(patchNode(doc, componentId, { fills: [solidPaint(BLUE)], cornerRadius: 12 }), componentId, { width: 260 }));
    expect(frameOf(store, a)).toMatchObject({ fills: [solidPaint(BLUE)], cornerRadius: 12, width: 260 });
    // A layer added to the component, and one taken away.
    let added = '';
    act(store, (doc) => {
      const out = addLayer(doc, 'ELLIPSE', componentId, { x: 150, y: 50, width: 20, height: 20 });
      added = out.id;
      return out.doc;
    });
    expect(getChildIds(now(store), b)).toEqual([mirrorId(b, rectId), mirrorId(b, textId), mirrorId(b, added)]);
    expect(of(b, added)).toMatchObject({ type: 'ELLIPSE', x: 150, y: 50 });
    act(store, (doc) => deleteNodes(doc, [rectId]));
    expect(getChildIds(now(store), a)).toEqual([mirrorId(a, textId), mirrorId(a, added)]);
    // The order of its layers.
    act(store, (doc) => reorderNodes(doc, [textId], 'front'));
    expect(getChildIds(now(store), a)).toEqual([mirrorId(a, added), mirrorId(a, textId)]);
    // Each of these is one undo step for the component and its instances together.
    store.getState().undo();
    expect(getChildIds(now(store), a)).toEqual([mirrorId(a, textId), mirrorId(a, added)]);
  });

  it('keeps what was changed in it when the component changes', () => {
    const { store, componentId, rectId, textId } = card();
    const a = place(store, componentId);
    const b = place(store, componentId, { x: 300, y: 200 });
    const title = mirrorId(a, textId);
    const picture = mirrorId(a, rectId);

    // In one instance: another text, another fill, the picture hidden.
    act(store, (doc) => patchNode(doc, title, { characters: 'My own title' }));
    act(store, (doc) => patchNodes(doc, { [picture]: { fills: [solidPaint(RED)], visible: false } }));
    expect(frameOf(store, a).overrides).toEqual({
      [textId]: { characters: 'My own title' },
      [rectId]: { fills: [solidPaint(RED)], visible: false },
    });
    expect(text(store, title)).toMatchObject({ characters: 'My own title', width: 96 });
    // The component and the other instance are as they were.
    expect(text(store, textId).characters).toBe('Title');
    expect(text(store, mirrorId(b, textId)).characters).toBe('Title');

    // The component changes the same things, and others.
    act(store, (doc) => patchNodes(doc, { [textId]: { characters: 'New title', fontSize: 20 }, [rectId]: { fills: [solidPaint(BLUE)], cornerRadius: 6, x: 30 } }));
    // What was changed here stays; what was not, follows.
    expect(text(store, title)).toMatchObject({ characters: 'My own title', fontSize: 20 });
    expect(layer(store, picture)).toMatchObject({ fills: [solidPaint(RED)], visible: false, cornerRadius: 6, x: 30 });
    expect(text(store, mirrorId(b, textId))).toMatchObject({ characters: 'New title', fontSize: 20 });
    expect(layer(store, mirrorId(b, rectId))).toMatchObject({ fills: [solidPaint(BLUE)], visible: true });

    // An override is one undo step.
    act(store, (doc) => patchNode(doc, title, { characters: 'Third' }));
    store.getState().undo();
    expect(text(store, title).characters).toBe('My own title');
    expect(frameOf(store, a).overrides[textId]).toEqual({ characters: 'My own title' });
  });

  it('keeps its own look as a frame, and takes the component’s layout', () => {
    const { store, componentId } = card({ layoutMode: 'HORIZONTAL', itemSpacing: 10, paddingLeft: 5, layoutSizingHorizontal: 'HUG', layoutSizingVertical: 'HUG' });
    const a = place(store, componentId);
    // The component hugs a 60 × 40 picture, a gap of 10 and a 40 × 19 text, after 5 of padding.
    expect(frameOf(store, componentId)).toMatchObject({ width: 115, height: 40 });
    expect(frameOf(store, a)).toMatchObject({ layoutMode: 'HORIZONTAL', itemSpacing: 10, paddingLeft: 5, width: 115, height: 40, layoutSizingHorizontal: 'HUG' });
    act(store, (doc) => patchNode(doc, a, { fills: [solidPaint(RED)] }));
    act(store, (doc) => patchNode(doc, componentId, { fills: [solidPaint(BLUE)], itemSpacing: 30 }));
    expect(frameOf(store, a)).toMatchObject({ fills: [solidPaint(RED)], itemSpacing: 30, width: 135 });
    expect(frameOf(store, a).overrides).toEqual({ [componentId]: { fills: [solidPaint(RED)] } });
  });

  it('is laid out for its own content: a longer text in one instance makes that instance wider', () => {
    const { store, componentId, textId } = card({ layoutMode: 'HORIZONTAL', itemSpacing: 10, layoutSizingHorizontal: 'HUG', layoutSizingVertical: 'HUG' });
    const a = place(store, componentId);
    const b = place(store, componentId, { x: 300, y: 200 });
    act(store, (doc) => patchNode(doc, mirrorId(a, textId), { characters: 'A much longer title' }));
    // 60, a gap of 10, and nineteen characters of 8.
    expect(frameOf(store, a).width).toBe(222);
    expect(frameOf(store, b).width).toBe(110);
    expect(frameOf(store, componentId).width).toBe(110);
    // The component's text changes: the instance that has its own is not touched, the other follows.
    act(store, (doc) => patchNode(doc, textId, { characters: 'Hi' }));
    expect(frameOf(store, a).width).toBe(222);
    expect(frameOf(store, b).width).toBe(86);
  });

  it('resizes what is in it by the constraints of the component’s layers', () => {
    const { store, componentId, rectId } = card();
    act(store, (doc) => patchNode(doc, rectId, { constraints: { horizontal: 'STRETCH', vertical: 'MAX' } }));
    const a = place(store, componentId);
    act(store, (doc) => setLayerBox(doc, a, { width: 300, height: 150 }));
    expect(layer(store, mirrorId(a, rectId))).toMatchObject({ x: 10, y: 60, width: 160, height: 40 });
    // The component is as it was, and a change to it elsewhere leaves the instance's own size alone.
    expect(layer(store, rectId)).toMatchObject({ x: 10, y: 10, width: 60 });
    act(store, (doc) => patchNode(doc, rectId, { fills: [solidPaint(RED)] }));
    expect(frameOf(store, a)).toMatchObject({ width: 300, height: 150 });
    expect(layer(store, mirrorId(a, rectId))).toMatchObject({ x: 10, y: 60, width: 160, fills: [solidPaint(RED)] });
    // An instance that kept the component's size follows it when the component is resized.
    const b = place(store, componentId, { x: 0, y: 300 });
    act(store, (doc) => setLayerBox(doc, componentId, { width: 240 }));
    expect(frameOf(store, b).width).toBe(240);
    expect(frameOf(store, a).width).toBe(300);
  });

  it('gets back a layer of its own that is deleted, and keeps its layers where the component has them', () => {
    const { store, componentId, rectId } = card();
    const a = place(store, componentId);
    const picture = mirrorId(a, rectId);
    act(store, (doc) => deleteNodes(doc, [picture]));
    expect(layer(store, picture)).toMatchObject({ sourceId: rectId, parentId: a });
    // Taken out of the instance, it is put back: what is in an instance is the component's to arrange.
    act(store, (doc) => patchNode(doc, picture, { parentId: store.getState().pageId }));
    expect(layer(store, picture).parentId).toBe(a);
  });

  it('is copied as an instance of the same component, with what was changed in it', () => {
    const { store, componentId, textId } = card();
    const a = place(store, componentId);
    act(store, (doc) => patchNode(doc, mirrorId(a, textId), { characters: 'Mine' }));
    let copy = '';
    act(store, (doc) => {
      const out = duplicateNodes(doc, [a]);
      copy = out.ids[0] as NodeId;
      return out.doc;
    });
    expect(frameOf(store, copy)).toMatchObject({ kind: 'INSTANCE', componentId, overrides: { [textId]: { characters: 'Mine' } } });
    expect(getChildIds(now(store), copy)).toHaveLength(2);
    expect(text(store, mirrorId(copy, textId)).characters).toBe('Mine');
    // The two are separate from here on.
    act(store, (doc) => patchNode(doc, mirrorId(copy, textId), { characters: 'Copy' }));
    expect(text(store, mirrorId(a, textId)).characters).toBe('Mine');
    // A copy of a component is another component, with no instances of its own.
    let second = '';
    act(store, (doc) => {
      const out = duplicateNodes(doc, [componentId]);
      second = out.ids[0] as NodeId;
      return out.doc;
    });
    expect(frameOf(store, second).kind).toBe('COMPONENT');
    expect(listComponents(now(store))).toHaveLength(2);
    act(store, (doc) => patchNode(doc, getChildIds(doc, second)[1] as NodeId, { characters: 'Second' }));
    expect(text(store, mirrorId(a, textId)).characters).toBe('Mine');
  });
});

describe('resetting, detaching and swapping', () => {
  it('resets an instance to its component', () => {
    const { store, componentId, rectId, textId } = card();
    const a = place(store, componentId);
    act(store, (doc) => patchNodes(doc, { [mirrorId(a, textId)]: { characters: 'Mine' }, [mirrorId(a, rectId)]: { visible: false }, [a]: { fills: [solidPaint(RED)] } }));
    expect(Object.keys(frameOf(store, a).overrides)).toHaveLength(3);
    act(store, (doc) => resetInstances(doc, [a]));
    expect(frameOf(store, a).overrides).toEqual({});
    expect(frameOf(store, a).fills).toEqual(frameOf(store, componentId).fills);
    expect(text(store, mirrorId(a, textId)).characters).toBe('Title');
    expect(layer(store, mirrorId(a, rectId)).visible).toBe(true);
    store.getState().undo();
    expect(text(store, mirrorId(a, textId)).characters).toBe('Mine');
    expect(resetInstances(now(store), [componentId])).toBe(now(store));
  });

  it('detaches an instance: it stays as it looks, and no longer follows the component', () => {
    const { store, componentId, rectId, textId } = card();
    const a = place(store, componentId);
    act(store, (doc) => patchNode(doc, mirrorId(a, textId), { characters: 'Mine' }));
    act(store, (doc) => detachInstances(doc, [a]));
    expect(frameOf(store, a)).toMatchObject({ kind: 'FRAME', componentId: null, overrides: {} });
    const [picture, title] = getChildIds(now(store), a) as [NodeId, NodeId];
    expect(layer(store, picture)).toMatchObject({ sourceId: null, x: 10, y: 10 });
    expect(text(store, title)).toMatchObject({ sourceId: null, characters: 'Mine' });
    act(store, (doc) => patchNodes(doc, { [rectId]: { fills: [solidPaint(RED)] }, [textId]: { characters: 'Changed' } }));
    expect(text(store, title).characters).toBe('Mine');
    expect(layer(store, picture).fills).not.toEqual([solidPaint(RED)]);
    // Its layers are its own now: one can be moved, or deleted for good.
    act(store, (doc) => deleteNodes(patchNode(doc, title, { x: 99 }), [picture]));
    expect(getChildIds(now(store), a)).toEqual([title]);
    expect(layer(store, title).x).toBe(99);
  });

  it('detaches every instance of a component that is deleted', () => {
    const { store, componentId, textId } = card();
    const a = place(store, componentId);
    act(store, (doc) => deleteNodes(doc, [componentId]));
    expect(frameOf(store, a)).toMatchObject({ kind: 'FRAME', componentId: null });
    expect(getChildIds(now(store), a)).toHaveLength(2);
    expect(layer(store, mirrorId(a, textId)).sourceId).toBeNull();
  });

  it('shows another component in an instance, keeping what was changed where the new one has the same layer', () => {
    const first = card();
    const { store, componentId, rectId, textId, pageId } = first;
    // A second component with a text of the same name, and a different shape.
    let other = '';
    let otherText = '';
    act(store, (doc) => {
      const frame = addLayer(doc, 'FRAME', pageId, { x: 0, y: 300, width: 120, height: 60, name: 'Chip' });
      const shape = addLayer(frame.doc, 'ELLIPSE', frame.id, { x: 5, y: 5, width: 20, height: 20, name: 'Dot' });
      const label = addLayer(shape.doc, 'TEXT', frame.id, { x: 30, y: 5, characters: 'Chip', name: 'Title' });
      other = frame.id;
      otherText = label.id;
      return (createComponent(label.doc, [frame.id]) as { doc: Document }).doc;
    });
    const a = place(store, componentId);
    act(store, (doc) => patchNodes(doc, { [mirrorId(a, textId)]: { characters: 'Kept' }, [mirrorId(a, rectId)]: { visible: false } }));
    act(store, (doc) => swapInstances(doc, [a], other));
    expect(frameOf(store, a)).toMatchObject({ componentId: other, overrides: { [otherText]: { characters: 'Kept' } }, width: 120, height: 60 });
    expect(getChildIds(now(store), a)).toHaveLength(2);
    expect(text(store, mirrorId(a, otherText))).toMatchObject({ characters: 'Kept', x: 30, y: 5 });
    expect(getLayer(now(store), mirrorId(a, rectId))).toBeUndefined();
    // And back, in one undo step.
    store.getState().undo();
    expect(frameOf(store, a).componentId).toBe(componentId);
    expect(layer(store, mirrorId(a, rectId)).visible).toBe(false);
    // Nothing happens for a component that is not one, or for the one it already shows.
    expect(swapInstances(now(store), [a], rectId)).toBe(now(store));
    expect(swapInstances(now(store), [a], componentId)).toBe(now(store));
  });
});

describe('components inside components', () => {
  /** A "List" component holding two instances of the card. */
  function list(): Card & { listId: NodeId; inner: [NodeId, NodeId] } {
    const base = card();
    const { store, pageId, componentId } = base;
    let listId = '';
    const inner: NodeId[] = [];
    act(store, (doc) => {
      const frame = addLayer(doc, 'FRAME', pageId, { x: 0, y: 400, width: 200, height: 220, name: 'List' });
      listId = frame.id;
      let next = frame.doc;
      for (const y of [0, 110]) {
        const out = createInstance(next, componentId, { parentId: frame.id, at: { x: 0, y } }) as { doc: Document; id: NodeId };
        next = out.doc;
        inner.push(out.id);
      }
      return (createComponent(next, [frame.id]) as { doc: Document }).doc;
    });
    return { ...base, listId, inner: inner as [NodeId, NodeId] };
  }

  it('shows the instances a component holds in every instance of it', () => {
    const { store, componentId, listId, inner, textId, rectId } = list();
    const a = place(store, listId, { x: 400, y: 400 });
    const first = mirrorId(a, inner[0]);
    const second = mirrorId(a, inner[1]);
    expect(getChildIds(now(store), a)).toEqual([first, second]);
    expect(frameOf(store, first)).toMatchObject({ kind: 'INSTANCE', componentId, sourceId: inner[0], x: 0, y: 0 });
    expect(frameOf(store, second)).toMatchObject({ kind: 'INSTANCE', componentId, sourceId: inner[1], y: 110 });
    expect(text(store, mirrorId(first, textId))).toMatchObject({ characters: 'Title', sourceId: textId });
    // A change to the innermost component reaches all of them.
    act(store, (doc) => patchNode(doc, rectId, { fills: [solidPaint(RED)] }));
    for (const id of [inner[0], inner[1], first, second]) expect(layer(store, mirrorId(id, rectId)).fills).toEqual([solidPaint(RED)]);
  });

  it('keeps what was changed inside a component’s instance, at each level, when either component changes', () => {
    const { store, listId, inner, textId, rectId } = list();
    // In the list component itself, the first card has its own title.
    act(store, (doc) => patchNode(doc, mirrorId(inner[0], textId), { characters: 'First' }));
    const a = place(store, listId, { x: 400, y: 400 });
    const first = mirrorId(a, inner[0]);
    const second = mirrorId(a, inner[1]);
    expect(text(store, mirrorId(first, textId)).characters).toBe('First');

    // In this instance of the list, the second card has its own title and the first its own picture colour.
    act(store, (doc) => patchNode(doc, mirrorId(second, textId), { characters: 'Second, here' }));
    act(store, (doc) => patchNode(doc, mirrorId(first, rectId), { fills: [solidPaint(BLUE)] }));
    expect(frameOf(store, a).overrides).toEqual({
      [inner[1]]: { overrides: { [textId]: { characters: 'Second, here' } } },
      [inner[0]]: { overrides: { [rectId]: { fills: [solidPaint(BLUE)] } } },
    });
    // The first card still has what the list component gave it, as well as what was changed here.
    expect(text(store, mirrorId(first, textId)).characters).toBe('First');

    // The list component renames its first card, and the card component changes its text and picture.
    act(store, (doc) => patchNode(doc, mirrorId(inner[0], textId), { characters: 'Number one' }));
    act(store, (doc) => patchNodes(doc, { [textId]: { characters: 'Card', fontSize: 20 }, [rectId]: { fills: [solidPaint(RED)] } }));
    expect(text(store, mirrorId(first, textId))).toMatchObject({ characters: 'Number one', fontSize: 20 });
    expect(layer(store, mirrorId(first, rectId)).fills).toEqual([solidPaint(BLUE)]);
    expect(text(store, mirrorId(second, textId))).toMatchObject({ characters: 'Second, here', fontSize: 20 });
    expect(layer(store, mirrorId(second, rectId)).fills).toEqual([solidPaint(RED)]);

    // Reset, the instance of the list is the list component again: its first card keeps the list's own title.
    act(store, (doc) => resetInstances(doc, [a]));
    expect(text(store, mirrorId(first, textId)).characters).toBe('Number one');
    expect(text(store, mirrorId(second, textId)).characters).toBe('Card');
  });

  it('shows another component in an instance inside an instance, and leaves the rest', () => {
    const { store, pageId, listId, inner, textId } = list();
    let chip = '';
    let chipText = '';
    act(store, (doc) => {
      const frame = addLayer(doc, 'FRAME', pageId, { x: 600, y: 0, width: 120, height: 60, name: 'Chip' });
      const label = addLayer(frame.doc, 'TEXT', frame.id, { x: 5, y: 5, characters: 'Chip', name: 'Title' });
      chip = frame.id;
      chipText = label.id;
      return (createComponent(label.doc, [frame.id]) as { doc: Document }).doc;
    });
    const a = place(store, listId, { x: 400, y: 400 });
    const first = mirrorId(a, inner[0]);
    act(store, (doc) => swapInstances(doc, [first], chip));
    expect(frameOf(store, a).overrides[inner[0]]).toMatchObject({ componentId: chip });
    expect(frameOf(store, first).componentId).toBe(chip);
    expect(text(store, mirrorId(first, chipText)).characters).toBe('Chip');
    expect(getLayer(now(store), mirrorId(first, textId))).toBeUndefined();
    // The list component and the other card in this instance are as they were.
    expect(frameOf(store, inner[0]).componentId).not.toBe(chip);
    expect(text(store, mirrorId(mirrorId(a, inner[1]), textId)).characters).toBe('Title');
  });

  it('cannot hold itself', () => {
    const { store, listId, componentId } = list();
    expect(createInstance(now(store), listId, { parentId: listId, at: { x: 0, y: 0 } })).toBeNull();
    // Nor through another component: the card cannot hold the list that holds it.
    let id = '';
    act(store, (doc) => {
      const out = createInstance(doc, listId, { parentId: componentId, at: { x: 0, y: 0 } });
      id = out?.id ?? '';
      return out?.doc ?? doc;
    });
    // If such an instance is made all the same, it is left empty rather than filled without end.
    if (id) expect(getChildIds(now(store), id).length).toBeLessThan(10);
    expect(Object.keys(now(store).nodes).length).toBeLessThan(200);
  });
});

describe('components on the canvas and in the file format', () => {
  it('picks an instance as a whole, and puts nothing into one', () => {
    const { store, componentId } = card();
    const a = place(store, componentId);
    const doc = now(store);
    const pageId = store.getState().pageId;
    // Over the picture inside the instance: the instance. Over the picture in the component: the picture.
    expect(selectionTargetAt(doc, pageId, { x: 320, y: 20 }, [])).toBe(a);
    expect(selectionTargetAt(doc, pageId, { x: 20, y: 20 }, [])).not.toBe(componentId);
    expect(containerAt(doc, pageId, { x: 320, y: 20 })).toBe(pageId);
    expect(containerAt(doc, pageId, { x: 20, y: 20 })).toBe(componentId);
  });

  it('opens a version 17 file, where nothing is a component, and keeps components through saving and opening', () => {
    const plain = createDocument('Old');
    const pageId = (getPages(plain)[0] as { id: NodeId }).id;
    const frame = addLayer(plain, 'FRAME', pageId, { width: 100, height: 100 });
    const current = addLayer(frame.doc, 'TEXT', frame.id, { characters: 'Hi' }).doc;
    const v17 = JSON.parse(JSON.stringify(current)) as { nodes: Record<string, Record<string, unknown>> };
    for (const id in v17.nodes) for (const key of ['sourceId', 'kind', 'description', 'componentId', 'overrides']) delete (v17.nodes[id] as Record<string, unknown>)[key];
    const parsed = parseFile({ format: 'open-design', schemaVersion: 17, meta: { createdAt: '2026-11-16T14:00:00.000Z', updatedAt: '2026-11-16T14:00:00.000Z' }, document: v17 });
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(18);
    expect(parsed.file.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(parsed.repairs).toEqual([]);
    expect(parsed.file.document).toEqual(current);

    const { store, componentId, textId } = card();
    const a = place(store, componentId);
    act(store, (doc) => patchNode(doc, mirrorId(a, textId), { characters: 'Mine' }));
    const reopened = repairDocument(JSON.parse(JSON.stringify(now(store))));
    expect(reopened.repairs).toEqual([]);
    expect(reopened.doc).toEqual(now(store));
    // A frame that says it has a component without being an instance is put right.
    const raw = JSON.parse(JSON.stringify(now(store))) as { nodes: Record<string, Record<string, unknown>> };
    Object.assign(raw.nodes[componentId] as Record<string, unknown>, { kind: 'WIDGET', componentId: a, overrides: [] });
    const repaired = repairDocument(raw);
    expect(getLayer(repaired.doc, componentId)).toMatchObject({ kind: 'FRAME', componentId: null, overrides: {} });
  });
});

describe('text in an instance that differs from its component', () => {
  it('keeps the component’s styled parts only as far as the instance’s own text goes', () => {
    const c = card();
    // "Title" in the component, with its last three letters bold.
    act(c.store, (doc) => patchNode(doc, c.textId, { styleRanges: [{ start: 2, end: 5, fontWeight: 700 }] } as LayerPatch));
    const instance = place(c.store, c.componentId);
    const mirror = mirrorId(instance, c.textId);
    expect(text(c.store, mirror).styleRanges).toEqual([{ start: 2, end: 5, fontWeight: 700 }]);
    // Shortened in the instance: the bold part stops at the end of the shorter text, and the file needs no repair.
    act(c.store, (doc) => patchNode(doc, mirror, { characters: 'Tit' } as LayerPatch));
    expect(text(c.store, mirror)).toMatchObject({ characters: 'Tit', styleRanges: [{ start: 2, end: 3, fontWeight: 700 }] });
    act(c.store, (doc) => patchNode(doc, mirror, { characters: 'T' } as LayerPatch));
    expect(text(c.store, mirror).styleRanges).toEqual([]);
    expect(repairDocument(JSON.parse(JSON.stringify(now(c.store)))).repairs).toEqual([]);
    // The component's own text keeps its styled part.
    expect(text(c.store, c.textId).styleRanges).toEqual([{ start: 2, end: 5, fontWeight: 700 }]);
  });
});
