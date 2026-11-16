import { describe, expect, it } from 'vitest';
import {
  addComponentProp,
  addLayer,
  addVariant,
  addVariantProperty,
  bindProp,
  createComponent,
  createComponentSet,
  createDocument,
  createInstance,
  CURRENT_SCHEMA_VERSION,
  getChildIds,
  getLayer,
  getPages,
  instancePropValue,
  mirrorId,
  parseFile,
  patchNode,
  propertyOwner,
  propsOf,
  removeComponentProp,
  removeVariantProperty,
  renameComponentProp,
  renameVariantProperty,
  repairDocument,
  resetInstances,
  setInstanceProp,
  setInstanceVariant,
  setOf,
  setVariantValue,
  solidPaint,
  variantOptions,
  variantsOf,
  type Document,
  type FrameNode,
  type LayerNode,
  type NodeId,
  type TextNode,
} from './core';
import { createEditorStore, type EditorStore } from './state/editorStore';

/**
 * Component sets, variants and component properties, through the editor
 * store. Text is measured with the approximate measurer: 8 per character.
 */

const RED = { r: 1, g: 0, b: 0 };
const BLUE = { r: 0, g: 0, b: 1 };

const now = (store: EditorStore): Document => store.getState().doc;
const act = (store: EditorStore, fn: (doc: Document) => Document): void => store.getState().apply('Edit', fn);
const frameOf = (store: EditorStore, id: NodeId): FrameNode => getLayer(now(store), id) as FrameNode;
const layer = (store: EditorStore, id: NodeId): LayerNode => getLayer(now(store), id) as LayerNode;
const text = (store: EditorStore, id: NodeId): TextNode => getLayer(now(store), id) as TextNode;

interface Button {
  store: EditorStore;
  pageId: NodeId;
  /** Two button components, each a frame with an icon (an ellipse) and a label. */
  primary: NodeId;
  secondary: NodeId;
  icon: NodeId;
  label: NodeId;
  secondaryLabel: NodeId;
}

function buttons(): Button {
  const store = createEditorStore(createDocument('Variants'));
  const pageId = (getPages(now(store))[0] as { id: NodeId }).id;
  const ids = { primary: '', secondary: '', icon: '', label: '', secondaryLabel: '' };
  act(store, (doc) => {
    let next = doc;
    const make = (name: string, y: number, fill: typeof RED): { frame: NodeId; icon: NodeId; label: NodeId } => {
      const frame = addLayer(next, 'FRAME', pageId, { x: 0, y, width: 120, height: 40, name, fills: [solidPaint(fill)] });
      const icon = addLayer(frame.doc, 'ELLIPSE', frame.id, { x: 8, y: 12, width: 16, height: 16, name: 'Icon' });
      const label = addLayer(icon.doc, 'TEXT', frame.id, { x: 32, y: 10, characters: name, name: 'Label' });
      next = (createComponent(label.doc, [frame.id]) as { doc: Document }).doc;
      return { frame: frame.id, icon: icon.id, label: label.id };
    };
    const a = make('Primary', 0, BLUE);
    const b = make('Secondary', 60, RED);
    Object.assign(ids, { primary: a.frame, icon: a.icon, label: a.label, secondary: b.frame, secondaryLabel: b.label });
    return next;
  });
  return { store, pageId, ...ids };
}

/** Combines the two buttons into a set and returns its ID. */
function combine(b: Button): NodeId {
  let id = '';
  act(b.store, (doc) => {
    const out = createComponentSet(doc, [b.primary, b.secondary]) as { doc: Document; id: NodeId };
    id = out.id;
    return out.doc;
  });
  return id;
}

function place(store: EditorStore, componentId: NodeId, at = { x: 400, y: 0 }): NodeId {
  let id = '';
  act(store, (doc) => {
    const out = createInstance(doc, componentId, { parentId: store.getState().pageId, at }) as { doc: Document; id: NodeId };
    id = out.id;
    return out.doc;
  });
  return id;
}

describe('component sets and variants', () => {
  it('combines components into a set, each a variant told apart by one property', () => {
    const b = buttons();
    const setId = combine(b);
    expect(frameOf(b.store, setId)).toMatchObject({ kind: 'COMPONENT_SET', name: 'Primary', x: -20, y: -20, width: 160, height: 140 });
    expect(variantsOf(now(b.store), setId).map((variant) => variant.id)).toEqual([b.primary, b.secondary]);
    expect(frameOf(b.store, b.primary)).toMatchObject({ kind: 'COMPONENT', variantProps: { 'Property 1': 'Primary' }, name: 'Property 1=Primary', x: 20, y: 20 });
    expect(frameOf(b.store, b.secondary).variantProps).toEqual({ 'Property 1': 'Secondary' });
    expect(variantOptions(now(b.store), setId)).toEqual([{ name: 'Property 1', values: ['Primary', 'Secondary'] }]);
    expect(setOf(now(b.store), b.primary)?.id).toBe(setId);
    // One undo step puts them back on the page as they were.
    b.store.getState().undo();
    expect(frameOf(b.store, b.primary)).toMatchObject({ parentId: b.pageId, variantProps: {}, name: 'Primary', x: 0 });
    // Only components that are not in a set already can be combined.
    expect(createComponentSet(now(b.store), [b.icon])).toBeNull();
    b.store.getState().redo();
    expect(createComponentSet(now(b.store), [b.primary])).toBeNull();
  });

  it('names, adds, renames and removes variant properties, and adds variants', () => {
    const b = buttons();
    const setId = combine(b);
    act(b.store, (doc) => renameVariantProperty(doc, setId, 'Property 1', 'Type'));
    act(b.store, (doc) => addVariantProperty(doc, setId, 'State'));
    expect(variantOptions(now(b.store), setId)).toEqual([
      { name: 'Type', values: ['Primary', 'Secondary'] },
      { name: 'State', values: ['Default'] },
    ]);
    expect(frameOf(b.store, b.secondary)).toMatchObject({ variantProps: { Type: 'Secondary', State: 'Default' }, name: 'Type=Secondary, State=Default' });

    let added = '';
    act(b.store, (doc) => {
      const out = addVariant(doc, setId) as { doc: Document; id: NodeId };
      added = out.id;
      return out.doc;
    });
    // A copy of the last variant, under it, and the set has grown to hold it.
    expect(frameOf(b.store, added)).toMatchObject({ kind: 'COMPONENT', parentId: setId, variantProps: { Type: 'Variant 3', State: 'Default' }, x: 20, y: 140 });
    expect(frameOf(b.store, setId).height).toBe(200);
    expect(getChildIds(now(b.store), added)).toHaveLength(2);
    act(b.store, (doc) => setVariantValue(setVariantValue(doc, added, 'Type', 'Secondary'), added, 'State', 'Hover'));
    expect(variantOptions(now(b.store), setId)).toEqual([
      { name: 'Type', values: ['Primary', 'Secondary'] },
      { name: 'State', values: ['Default', 'Hover'] },
    ]);
    act(b.store, (doc) => removeVariantProperty(doc, setId, 'State'));
    expect(frameOf(b.store, added).variantProps).toEqual({ Type: 'Secondary' });
    // A set keeps one property, and a name is not given twice.
    expect(removeVariantProperty(now(b.store), setId, 'Type')).toBe(now(b.store));
    act(b.store, (doc) => addVariantProperty(doc, setId, 'Size'));
    expect(renameVariantProperty(now(b.store), setId, 'Size', 'Type')).toBe(now(b.store));
  });

  it('makes an instance show another variant when a value is chosen, and keeps what was changed in it', () => {
    const b = buttons();
    const setId = combine(b);
    act(b.store, (doc) => renameVariantProperty(doc, setId, 'Property 1', 'Type'));
    const a = place(b.store, b.primary);
    expect(frameOf(b.store, a)).toMatchObject({ componentId: b.primary, name: 'Primary', fills: [solidPaint(BLUE)] });
    act(b.store, (doc) => patchNode(doc, mirrorId(a, b.label), { characters: 'Buy now' }));

    act(b.store, (doc) => setInstanceVariant(doc, [a], 'Type', 'Secondary'));
    expect(frameOf(b.store, a)).toMatchObject({ componentId: b.secondary, fills: [solidPaint(RED)] });
    // The label of the other variant is a layer of the same name: the text typed here is on it now.
    expect(text(b.store, mirrorId(a, b.secondaryLabel)).characters).toBe('Buy now');
    b.store.getState().undo();
    expect(frameOf(b.store, a).componentId).toBe(b.primary);
    // A value no variant has changes nothing.
    expect(setInstanceVariant(now(b.store), [a], 'Type', 'Tertiary')).toBe(now(b.store));
  });

  it('finds the variant that agrees with the instance in the most other properties', () => {
    const b = buttons();
    const setId = combine(b);
    act(b.store, (doc) => addVariantProperty(renameVariantProperty(doc, setId, 'Property 1', 'Type'), setId, 'State'));
    // Four variants: Primary and Secondary, each Default and Hover.
    const hover: NodeId[] = [];
    for (const type of ['Primary', 'Secondary']) {
      act(b.store, (doc) => {
        const out = addVariant(doc, setId) as { doc: Document; id: NodeId };
        hover.push(out.id);
        return setVariantValue(setVariantValue(out.doc, out.id, 'Type', type), out.id, 'State', 'Hover');
      });
    }
    const a = place(b.store, b.secondary);
    act(b.store, (doc) => setInstanceVariant(doc, [a], 'State', 'Hover'));
    expect(frameOf(b.store, a).componentId).toBe(hover[1]);
    act(b.store, (doc) => setInstanceVariant(doc, [a], 'Type', 'Primary'));
    expect(frameOf(b.store, a).componentId).toBe(hover[0]);
    act(b.store, (doc) => setInstanceVariant(doc, [a], 'State', 'Default'));
    expect(frameOf(b.store, a).componentId).toBe(b.primary);
  });
});

describe('component properties', () => {
  /** The primary button with three properties: whether the icon shows, the label's text, and which component the icon is. */
  function withProps(): Button & { show: string; label2: string } {
    const b = buttons();
    let show = '';
    let labelProp = '';
    act(b.store, (doc) => {
      const first = addComponentProp(doc, b.primary, 'BOOLEAN', 'Show icon') as { doc: Document; id: string };
      const second = addComponentProp(first.doc, b.primary, 'TEXT', 'Label') as { doc: Document; id: string };
      show = first.id;
      labelProp = second.id;
      return bindProp(bindProp(second.doc, b.icon, 'BOOLEAN', show), b.label, 'TEXT', labelProp);
    });
    return { ...b, show, label2: labelProp };
  }

  it('are defined on a component and bound to its layers', () => {
    const b = withProps();
    expect(frameOf(b.store, b.primary).componentProps).toEqual([
      { id: b.show, name: 'Show icon', type: 'BOOLEAN' },
      { id: b.label2, name: 'Label', type: 'TEXT' },
    ]);
    expect(layer(b.store, b.icon).propRefs).toEqual({ visible: b.show });
    expect(layer(b.store, b.label).propRefs).toEqual({ characters: b.label2 });
    expect(propertyOwner(now(b.store), b.icon)?.id).toBe(b.primary);
    // A text property is for text, and a property of another component is not this one's.
    expect(bindProp(now(b.store), b.icon, 'TEXT', b.label2)).toBe(now(b.store));
    expect(bindProp(now(b.store), b.secondaryLabel, 'TEXT', b.label2)).toBe(now(b.store));
    act(b.store, (doc) => renameComponentProp(doc, b.primary, b.show, 'Icon'));
    expect(frameOf(b.store, b.primary).componentProps[0]?.name).toBe('Icon');
    // A second property of the same kind gets a name of its own.
    act(b.store, (doc) => (addComponentProp(doc, b.primary, 'TEXT', 'Label') as { doc: Document }).doc);
    expect(frameOf(b.store, b.primary).componentProps.map((prop) => prop.name)).toEqual(['Icon', 'Label', 'Label 2']);
  });

  it('are set on an instance, and decide what the layers bound to them show there', () => {
    const b = withProps();
    const a = place(b.store, b.primary);
    const other = place(b.store, b.primary, { x: 400, y: 100 });
    // Until it is set, a property is what the component's layer has.
    expect(instancePropValue(now(b.store), a, b.show)).toBe(true);
    expect(instancePropValue(now(b.store), a, b.label2)).toBe('Primary');

    act(b.store, (doc) => setInstanceProp(setInstanceProp(doc, [a], b.show, false), [a], b.label2, 'Checkout'));
    expect(frameOf(b.store, a).propValues).toEqual({ [b.show]: false, [b.label2]: 'Checkout' });
    expect(layer(b.store, mirrorId(a, b.icon)).visible).toBe(false);
    expect(text(b.store, mirrorId(a, b.label))).toMatchObject({ characters: 'Checkout', width: 64 });
    expect(instancePropValue(now(b.store), a, b.label2)).toBe('Checkout');
    // The other instance and the component are as they were.
    expect(layer(b.store, mirrorId(other, b.icon)).visible).toBe(true);
    expect(text(b.store, b.label).characters).toBe('Primary');

    // The component changes its label: the instance that set the property keeps its own, the other follows.
    act(b.store, (doc) => patchNode(doc, b.label, { characters: 'Go' }));
    expect(text(b.store, mirrorId(a, b.label)).characters).toBe('Checkout');
    expect(text(b.store, mirrorId(other, b.label)).characters).toBe('Go');
    // A value of the wrong kind, or for a property the component does not have, is not taken.
    expect(setInstanceProp(now(b.store), [a], b.show, 'yes')).toBe(now(b.store));
    expect(setInstanceProp(now(b.store), [a], 'nothing', true)).toBe(now(b.store));
  });

  it('take what is changed directly on a bound layer of an instance as the property’s value', () => {
    const b = withProps();
    const a = place(b.store, b.primary);
    // The text is typed into the instance's label, and its icon hidden in the layers panel.
    act(b.store, (doc) => patchNode(doc, mirrorId(a, b.label), { characters: 'Typed here' }));
    act(b.store, (doc) => patchNode(doc, mirrorId(a, b.icon), { visible: false }));
    expect(frameOf(b.store, a).propValues).toEqual({ [b.label2]: 'Typed here', [b.show]: false });
    expect(frameOf(b.store, a).overrides).toEqual({});
    // Reset gives the properties back to the component too.
    act(b.store, (doc) => resetInstances(doc, [a]));
    expect(frameOf(b.store, a).propValues).toEqual({});
    expect(text(b.store, mirrorId(a, b.label)).characters).toBe('Primary');
    expect(layer(b.store, mirrorId(a, b.icon)).visible).toBe(true);
  });

  it('swap the component an instance inside the component shows', () => {
    const b = buttons();
    // Two icon components, and a card component that holds an instance of the first.
    const made = { star: '', heart: '', card: '', slot: '', prop: '' };
    act(b.store, (doc) => {
      let next = doc;
      for (const [key, y] of [['star', 200], ['heart', 260]] as const) {
        const frame = addLayer(next, 'FRAME', b.pageId, { x: 0, y, width: 24, height: 24, name: key });
        next = (createComponent(frame.doc, [frame.id]) as { doc: Document }).doc;
        made[key] = frame.id;
      }
      const card = addLayer(next, 'FRAME', b.pageId, { x: 0, y: 320, width: 100, height: 40, name: 'Card' });
      const slot = createInstance(card.doc, made.star, { parentId: card.id, at: { x: 8, y: 8 } }) as { doc: Document; id: NodeId };
      next = (createComponent(slot.doc, [card.id]) as { doc: Document }).doc;
      const prop = addComponentProp(next, card.id, 'INSTANCE_SWAP', 'Icon') as { doc: Document; id: string };
      Object.assign(made, { card: card.id, slot: slot.id, prop: prop.id });
      return bindProp(prop.doc, slot.id, 'INSTANCE_SWAP', prop.id);
    });
    const a = place(b.store, made.card);
    expect(frameOf(b.store, mirrorId(a, made.slot)).componentId).toBe(made.star);
    expect(instancePropValue(now(b.store), a, made.prop)).toBe(made.star);
    act(b.store, (doc) => setInstanceProp(doc, [a], made.prop, made.heart));
    expect(frameOf(b.store, mirrorId(a, made.slot))).toMatchObject({ kind: 'INSTANCE', componentId: made.heart });
    expect(frameOf(b.store, made.slot).componentId).toBe(made.star);
    // Something that is not a component is not shown.
    act(b.store, (doc) => setInstanceProp(doc, [a], made.prop, b.icon));
    expect(frameOf(b.store, mirrorId(a, made.slot)).componentId).toBe(made.star);
  });

  it('are shared by the variants of a set, and kept when an instance changes variant', () => {
    const b = buttons();
    const setId = combine(b);
    let prop = '';
    act(b.store, (doc) => {
      const out = addComponentProp(doc, setId, 'TEXT', 'Label') as { doc: Document; id: string };
      prop = out.id;
      return bindProp(bindProp(out.doc, b.label, 'TEXT', prop), b.secondaryLabel, 'TEXT', prop);
    });
    expect(propsOf(now(b.store), b.secondary).map((entry) => entry.id)).toEqual([prop]);
    expect(propertyOwner(now(b.store), b.label)?.id).toBe(setId);
    const a = place(b.store, b.primary);
    act(b.store, (doc) => setInstanceProp(doc, [a], prop, 'Pay'));
    act(b.store, (doc) => setInstanceVariant(doc, [a], 'Property 1', 'Secondary'));
    expect(frameOf(b.store, a)).toMatchObject({ componentId: b.secondary, propValues: { [prop]: 'Pay' } });
    expect(text(b.store, mirrorId(a, b.secondaryLabel)).characters).toBe('Pay');
  });

  it('of an instance inside an instance are set from the outer one, and kept there', () => {
    const b = buttons();
    let show = '';
    let listId = '';
    let inner = '';
    act(b.store, (doc) => {
      const prop = addComponentProp(doc, b.primary, 'BOOLEAN', 'Show icon') as { doc: Document; id: string };
      show = prop.id;
      const bound = bindProp(prop.doc, b.icon, 'BOOLEAN', show);
      const frame = addLayer(bound, 'FRAME', b.pageId, { x: 0, y: 400, width: 200, height: 60, name: 'Toolbar' });
      const slot = createInstance(frame.doc, b.primary, { parentId: frame.id, at: { x: 0, y: 0 } }) as { doc: Document; id: NodeId };
      listId = frame.id;
      inner = slot.id;
      return (createComponent(slot.doc, [frame.id]) as { doc: Document }).doc;
    });
    const a = place(b.store, listId, { x: 400, y: 400 });
    const nested = mirrorId(a, inner);
    act(b.store, (doc) => setInstanceProp(doc, [nested], show, false));
    expect(frameOf(b.store, a).overrides).toEqual({ [inner]: { propValues: { [show]: false } } });
    expect(layer(b.store, mirrorId(nested, b.icon)).visible).toBe(false);
    // The toolbar component's own button still shows its icon, and a change to the button reaches the nested one.
    expect(layer(b.store, mirrorId(inner, b.icon)).visible).toBe(true);
    act(b.store, (doc) => patchNode(doc, b.primary, { cornerRadius: 9 }));
    expect(frameOf(b.store, nested)).toMatchObject({ cornerRadius: 9, propValues: { [show]: false } });
  });

  it('are removed with everything that used them', () => {
    const b = withProps();
    const a = place(b.store, b.primary);
    act(b.store, (doc) => setInstanceProp(doc, [a], b.show, false));
    act(b.store, (doc) => removeComponentProp(doc, b.primary, b.show));
    expect(frameOf(b.store, b.primary).componentProps.map((prop) => prop.id)).toEqual([b.label2]);
    expect(layer(b.store, b.icon).propRefs).toEqual({});
    expect(frameOf(b.store, a).propValues).toEqual({});
    expect(layer(b.store, mirrorId(a, b.icon)).visible).toBe(true);
    // Unbinding leaves the property and takes the layer off it.
    act(b.store, (doc) => bindProp(doc, b.label, 'TEXT', null));
    expect(layer(b.store, b.label).propRefs).toEqual({});
  });
});

describe('sets and properties in the file format', () => {
  it('opens a version 18 file, and keeps sets, variants and properties through saving and opening', () => {
    const plain = buttons();
    const current = now(plain.store);
    const v18 = JSON.parse(JSON.stringify(current)) as { nodes: Record<string, Record<string, unknown>> };
    for (const id in v18.nodes) for (const key of ['propRefs', 'componentProps', 'variantProps', 'propValues']) delete (v18.nodes[id] as Record<string, unknown>)[key];
    const parsed = parseFile({ format: 'open-design', schemaVersion: 18, meta: { createdAt: '2026-11-16T15:00:00.000Z', updatedAt: '2026-11-16T15:00:00.000Z' }, document: v18 });
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(19);
    expect(parsed.repairs).toEqual([]);
    expect(parsed.file.document).toEqual(current);

    const b = buttons();
    const setId = combine(b);
    let prop = '';
    act(b.store, (doc) => {
      const out = addComponentProp(doc, setId, 'BOOLEAN', 'Show icon') as { doc: Document; id: string };
      prop = out.id;
      return bindProp(out.doc, b.icon, 'BOOLEAN', prop);
    });
    const a = place(b.store, b.primary);
    act(b.store, (doc) => setInstanceProp(doc, [a], prop, false));
    const reopened = repairDocument(JSON.parse(JSON.stringify(now(b.store))));
    expect(reopened.repairs).toEqual([]);
    expect(reopened.doc).toEqual(now(b.store));
    // Values that are not what they should be are dropped.
    const raw = JSON.parse(JSON.stringify(now(b.store))) as { nodes: Record<string, Record<string, unknown>> };
    Object.assign(raw.nodes[setId] as Record<string, unknown>, { componentProps: [{ id: 'x', name: 'Odd', type: 'COLOUR' }, { id: prop, type: 'BOOLEAN' }], variantProps: { Type: 5 } });
    Object.assign(raw.nodes[a] as Record<string, unknown>, { propValues: { [prop]: 3, other: 'ok' } });
    Object.assign(raw.nodes[b.icon] as Record<string, unknown>, { propRefs: { visible: 7, characters: 'p' } });
    const repaired = repairDocument(raw);
    expect(getLayer(repaired.doc, setId)).toMatchObject({ componentProps: [{ id: prop, name: 'Property', type: 'BOOLEAN' }], variantProps: {} });
    expect(getLayer(repaired.doc, a)).toMatchObject({ propValues: { other: 'ok' } });
    expect(getLayer(repaired.doc, b.icon)).toMatchObject({ propRefs: { characters: 'p' } });
  });
});
