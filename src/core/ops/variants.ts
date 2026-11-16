import { isComponent, isInstance, propsOf, setOf } from '../components/instances';
import { createLayer } from '../document/factory';
import { patchNodes, setNodes } from '../document/mutate';
import { isFrame, isLayer, type ComponentProp, type ComponentPropType, type Document, type FrameNode, type LayerNode, type LayerPatch, type NodeId, type PropRefs } from '../document/schema';
import { createId } from '../ids';
import { transformedBounds, unionRects, type Rect } from '../math/geometry';
import { invert, multiply } from '../math/matrix';
import { getAncestorIds, getChildIds, getWorldMatrix, sortByPaintOrder, topLevelIds } from '../scene/tree';
import { reparentNodes } from './arrange';
import { swapInstances } from './components';
import { duplicateNodes } from './nodes';
import { insertionKeys } from './ordering';
import { clean } from './transform';

/**
 * Component sets, variants and component properties. A component set is a
 * frame holding components that are variants of one thing: each says which
 * variant it is with a value for each of the set's variant properties
 * ("Type" = "Primary", "Size" = "Small"). An instance of one variant can be
 * made to show another by choosing other values. Component properties are
 * what an instance can set for itself without reaching into its layers: a
 * switch for whether a layer shows, the text of a text, the component a
 * nested instance shows.
 */

const SET_PADDING = 20;

function isSet(node: unknown): node is FrameNode {
  return isFrame(node as LayerNode | undefined) && (node as FrameNode).kind === 'COMPONENT_SET';
}

/** The variants of a component set: the components directly in it, from the bottom of its stack up. */
export function variantsOf(doc: Document, setId: NodeId): FrameNode[] {
  const out: FrameNode[] = [];
  for (const id of getChildIds(doc, setId)) {
    const node = doc.nodes[id];
    if (isComponent(node)) out.push(node);
  }
  return out;
}

/** The variant properties of a set and the values each can have, in the order they first appear among its variants. */
export function variantOptions(doc: Document, setId: NodeId): { name: string; values: string[] }[] {
  const out: { name: string; values: string[] }[] = [];
  for (const variant of variantsOf(doc, setId)) {
    for (const name in variant.variantProps) {
      const value = variant.variantProps[name] as string;
      let option = out.find((entry) => entry.name === name);
      if (!option) {
        option = { name, values: [] };
        out.push(option);
      }
      if (!option.values.includes(value)) option.values.push(value);
    }
  }
  return out;
}

/** The name a variant goes by: its values, in the order of the set's properties. */
function variantName(values: Readonly<Record<string, string>>): string {
  const parts = Object.keys(values).map((name) => `${name}=${values[name]}`);
  return parts.length > 0 ? parts.join(', ') : 'Variant';
}

/**
 * Combines components into a component set: a new frame round them, in which
 * each is a variant told apart by the value of one property, to begin with
 * its own name. Returns the set, or null when the selection is not one or
 * more components that are not yet in a set and share a parent.
 */
export function createComponentSet(doc: Document, ids: readonly NodeId[]): { doc: Document; id: NodeId } | null {
  const selected = sortByPaintOrder(doc, topLevelIds(doc, ids));
  if (selected.length === 0) return null;
  const components = selected.map((id) => doc.nodes[id]);
  if (!components.every((node): node is FrameNode => isComponent(node) && setOf(doc, node.id) === null)) return null;
  const parentId = (components[0] as FrameNode).parentId;
  if (!components.every((node) => node.parentId === parentId)) return null;
  // A set, like a component, is not made inside a component or an instance.
  if ([parentId, ...getAncestorIds(doc, parentId)].some((id) => isFrame(doc.nodes[id]) && (doc.nodes[id] as FrameNode).kind !== 'FRAME')) return null;

  const rects = components.map((node) => transformedBounds(multiply(invert(getWorldMatrix(doc, parentId)), getWorldMatrix(doc, node.id)), node.width, node.height));
  const bounds = unionRects(rects) as Rect;
  const exclude = new Set(selected);
  const top = components[components.length - 1] as FrameNode;
  const below = getChildIds(doc, parentId).slice(0, getChildIds(doc, parentId).indexOf(top.id));
  const { keys, rekeyed } = insertionKeys(doc, parentId, below.filter((id) => !exclude.has(id)).length, 1, exclude);
  const name = (components[0] as FrameNode).name;
  const set = createLayer('FRAME', parentId, keys[0] as string, {
    name,
    x: clean(bounds.x - SET_PADDING),
    y: clean(bounds.y - SET_PADDING),
    width: clean(bounds.width + 2 * SET_PADDING),
    height: clean(bounds.height + 2 * SET_PADDING),
    fills: [],
    strokes: [{ type: 'SOLID', color: { r: 0.592, g: 0.278, b: 1 }, opacity: 1, visible: true }],
    dashPattern: [6, 4],
    cornerRadius: 6,
    clipsContent: false,
    kind: 'COMPONENT_SET',
  });
  let next = setNodes(patchNodes(doc, rekeyed), { [set.id]: set });
  next = reparentNodes(next, selected, set.id);
  const patches: Record<NodeId, LayerPatch> = {};
  const used = new Set<string>();
  components.forEach((component, index) => {
    let value = components.length === 1 ? 'Default' : component.name;
    while (used.has(value)) value = `${value} ${index + 1}`;
    used.add(value);
    const variantProps = { 'Property 1': value };
    patches[component.id] = { variantProps, name: variantName(variantProps) };
  });
  return { doc: patchNodes(next, patches), id: set.id };
}

/**
 * Adds a variant to a set: a copy of its last variant, placed under it, with
 * a new value for the set's first property. The set grows to hold it.
 */
export function addVariant(doc: Document, setId: NodeId): { doc: Document; id: NodeId } | null {
  const set = doc.nodes[setId];
  const variants = variantsOf(doc, setId);
  const last = variants[variants.length - 1];
  if (!isSet(set) || !last) return null;
  const copied = duplicateNodes(doc, [last.id]);
  const id = copied.ids[0] as NodeId;
  const options = variantOptions(doc, setId);
  const first = options[0]?.name ?? 'Property 1';
  const taken = new Set(options[0]?.values ?? []);
  let n = variants.length + 1;
  while (taken.has(`Variant ${n}`)) n++;
  const variantProps = { ...last.variantProps, [first]: `Variant ${n}` };
  const y = last.y + last.height + SET_PADDING;
  const next = patchNodes(copied.doc, {
    [id]: { variantProps, name: variantName(variantProps), x: last.x, y },
    [setId]: { height: Math.max(set.height, y + last.height + SET_PADDING) },
  });
  return { doc: next, id };
}

/** Says which variant a component is, for one of its set's properties. */
export function setVariantValue(doc: Document, componentId: NodeId, name: string, value: string): Document {
  const component = doc.nodes[componentId];
  const text = value.trim();
  if (!isComponent(component) || !setOf(doc, componentId) || text === '') return doc;
  const variantProps = { ...component.variantProps, [name]: text };
  return patchNodes(doc, { [componentId]: { variantProps, name: variantName(variantProps) } });
}

/** Gives a set another variant property; every variant starts with the same value for it. */
export function addVariantProperty(doc: Document, setId: NodeId, name?: string): Document {
  if (!isSet(doc.nodes[setId])) return doc;
  const taken = new Set(variantOptions(doc, setId).map((option) => option.name));
  let label = name?.trim() || `Property ${taken.size + 1}`;
  while (taken.has(label)) label = `${label} 2`;
  const patches: Record<NodeId, LayerPatch> = {};
  for (const variant of variantsOf(doc, setId)) {
    const variantProps = { ...variant.variantProps, [label]: 'Default' };
    patches[variant.id] = { variantProps, name: variantName(variantProps) };
  }
  return patchNodes(doc, patches);
}

/** Renames a variant property of a set, in every variant, keeping its place among the properties. */
export function renameVariantProperty(doc: Document, setId: NodeId, from: string, to: string): Document {
  const label = to.trim();
  if (!isSet(doc.nodes[setId]) || label === '' || label === from) return doc;
  if (variantOptions(doc, setId).some((option) => option.name === label)) return doc;
  const patches: Record<NodeId, LayerPatch> = {};
  for (const variant of variantsOf(doc, setId)) {
    if (!(from in variant.variantProps)) continue;
    const variantProps: Record<string, string> = {};
    for (const name in variant.variantProps) variantProps[name === from ? label : name] = variant.variantProps[name] as string;
    patches[variant.id] = { variantProps, name: variantName(variantProps) };
  }
  return patchNodes(doc, patches);
}

/** Takes a variant property away from a set. A set keeps at least one. */
export function removeVariantProperty(doc: Document, setId: NodeId, name: string): Document {
  if (!isSet(doc.nodes[setId]) || variantOptions(doc, setId).length <= 1) return doc;
  const patches: Record<NodeId, LayerPatch> = {};
  for (const variant of variantsOf(doc, setId)) {
    if (!(name in variant.variantProps)) continue;
    const variantProps = { ...variant.variantProps };
    delete variantProps[name];
    patches[variant.id] = { variantProps, name: variantName(variantProps) };
  }
  return patchNodes(doc, patches);
}

/**
 * The variant of a set that an instance should show when one of its values
 * is changed: the one with that value that agrees with the instance's other
 * values in the most places. Null when no variant has that value.
 */
export function findVariant(doc: Document, setId: NodeId, current: Readonly<Record<string, string>>, name: string, value: string): FrameNode | null {
  let best: FrameNode | null = null;
  let score = -1;
  for (const variant of variantsOf(doc, setId)) {
    if (variant.variantProps[name] !== value) continue;
    let agree = 0;
    for (const other in current) if (other !== name && variant.variantProps[other] === current[other]) agree++;
    if (agree > score) {
      best = variant;
      score = agree;
    }
  }
  return best;
}

/**
 * Makes instances show the variant with another value for a variant
 * property. What was changed in an instance, and what its component
 * properties are set to, is kept, as in any swap.
 */
export function setInstanceVariant(doc: Document, ids: readonly NodeId[], name: string, value: string): Document {
  let next = doc;
  for (const id of ids) {
    const instance = next.nodes[id];
    if (!isInstance(instance) || instance.componentId === null) continue;
    const component = next.nodes[instance.componentId];
    const set = setOf(next, instance.componentId);
    if (!isComponent(component) || !set) continue;
    const variant = findVariant(next, set.id, component.variantProps, name, value);
    if (variant) next = swapInstances(next, [id], variant.id);
  }
  return next;
}

/** The component or component set a property would be defined on for a layer: the nearest above it, a set before its variant. */
export function propertyOwner(doc: Document, id: NodeId): FrameNode | null {
  for (const nodeId of [id, ...getAncestorIds(doc, id)]) {
    const node = doc.nodes[nodeId];
    if (!isFrame(node)) continue;
    // An instance inside a component is a layer of that component like any other.
    if (nodeId === id && node.kind === 'INSTANCE') continue;
    if (node.kind === 'COMPONENT_SET') return node;
    if (node.kind === 'COMPONENT') return setOf(doc, node.id) ?? node;
    if (node.kind === 'INSTANCE') return null;
  }
  return null;
}

/** Defines a property on a component, or on a component set for all its variants. Returns the new property's ID. */
export function addComponentProp(doc: Document, ownerId: NodeId, type: ComponentPropType, name?: string): { doc: Document; id: string } | null {
  const owner = doc.nodes[ownerId];
  if (!isFrame(owner) || (owner.kind !== 'COMPONENT' && owner.kind !== 'COMPONENT_SET')) return null;
  const labels = { BOOLEAN: 'Show', TEXT: 'Text', INSTANCE_SWAP: 'Instance' };
  const taken = new Set(owner.componentProps.map((prop) => prop.name));
  let label = name?.trim() || labels[type];
  for (let n = 2; taken.has(label); n++) label = `${name?.trim() || labels[type]} ${n}`;
  const prop: ComponentProp = { id: createId(), name: label, type };
  return { doc: patchNodes(doc, { [ownerId]: { componentProps: [...owner.componentProps, prop] } }), id: prop.id };
}

export function renameComponentProp(doc: Document, ownerId: NodeId, propId: string, name: string): Document {
  const owner = doc.nodes[ownerId];
  const label = name.trim();
  if (!isFrame(owner) || label === '') return doc;
  if (!owner.componentProps.some((prop) => prop.id === propId && prop.name !== label)) return doc;
  return patchNodes(doc, { [ownerId]: { componentProps: owner.componentProps.map((prop) => (prop.id === propId ? { ...prop, name: label } : prop)) } });
}

/** Removes a property: no layer is bound to it any more, and no instance has a value for it. */
export function removeComponentProp(doc: Document, ownerId: NodeId, propId: string): Document {
  const owner = doc.nodes[ownerId];
  if (!isFrame(owner) || !owner.componentProps.some((prop) => prop.id === propId)) return doc;
  const patches: Record<NodeId, LayerPatch> = { [ownerId]: { componentProps: owner.componentProps.filter((prop) => prop.id !== propId) } };
  for (const id in doc.nodes) {
    const node = doc.nodes[id];
    if (!isLayer(node)) continue;
    const patch: LayerPatch = {};
    if (Object.values(node.propRefs).includes(propId)) {
      const propRefs: PropRefs = {};
      for (const key of ['visible', 'characters', 'componentId'] as const) if (node.propRefs[key] && node.propRefs[key] !== propId) propRefs[key] = node.propRefs[key];
      patch.propRefs = propRefs;
    }
    if (isFrame(node) && propId in node.propValues) {
      const propValues = { ...node.propValues };
      delete propValues[propId];
      patch.propValues = propValues;
    }
    if (Object.keys(patch).length > 0) patches[id] = { ...patches[id], ...patch };
  }
  return patchNodes(doc, patches);
}

/** What about a layer a property of each type decides. */
const TARGETS: Record<ComponentPropType, keyof PropRefs> = { BOOLEAN: 'visible', TEXT: 'characters', INSTANCE_SWAP: 'componentId' };

/** Whether a property of a type can decide something about a layer: any layer can be shown or hidden, a text has text, an instance a component. */
export function canBind(node: LayerNode, type: ComponentPropType): boolean {
  if (type === 'TEXT') return node.type === 'TEXT';
  if (type === 'INSTANCE_SWAP') return isInstance(node);
  return true;
}

/**
 * Binds a layer of a component to one of the component's properties, or
 * with null unbinds it from whichever property of that type it had.
 */
export function bindProp(doc: Document, layerId: NodeId, type: ComponentPropType, propId: string | null): Document {
  const node = doc.nodes[layerId];
  const owner = propertyOwner(doc, layerId);
  if (!isLayer(node) || !owner || node.id === owner.id || !canBind(node, type)) return doc;
  const key = TARGETS[type];
  const propRefs: PropRefs = { ...node.propRefs };
  if (propId === null) delete propRefs[key];
  else {
    const component = [layerId, ...getAncestorIds(doc, layerId)].map((id) => doc.nodes[id]).find((entry) => isComponent(entry));
    if (!component || !propsOf(doc, component.id).some((prop) => prop.id === propId && prop.type === type)) return doc;
    propRefs[key] = propId;
  }
  return patchNodes(doc, { [layerId]: { propRefs } });
}

/** Sets instances' value for a property of their component. */
export function setInstanceProp(doc: Document, ids: readonly NodeId[], propId: string, value: boolean | string): Document {
  const patches: Record<NodeId, LayerPatch> = {};
  for (const id of ids) {
    const instance = doc.nodes[id];
    if (!isInstance(instance) || instance.componentId === null) continue;
    const prop = propsOf(doc, instance.componentId).find((entry) => entry.id === propId);
    if (!prop || (prop.type === 'BOOLEAN' ? typeof value !== 'boolean' : typeof value !== 'string')) continue;
    patches[id] = { propValues: { ...instance.propValues, [propId]: value } };
  }
  return patchNodes(doc, patches);
}

/**
 * What a property is in an instance: the value the instance has set, or what
 * the first layer bound to it has in the component. Null for a property no
 * layer is bound to and that the instance has not set.
 */
export function instancePropValue(doc: Document, instanceId: NodeId, propId: string): boolean | string | null {
  const instance = doc.nodes[instanceId];
  if (!isInstance(instance) || instance.componentId === null) return null;
  if (propId in instance.propValues) return instance.propValues[propId] as boolean | string;
  const find = (parentId: NodeId): boolean | string | null => {
    for (const id of getChildIds(doc, parentId)) {
      const node = doc.nodes[id];
      if (!isLayer(node)) continue;
      if (node.propRefs.visible === propId) return node.visible;
      if (node.propRefs.characters === propId && node.type === 'TEXT') return node.characters;
      if (node.propRefs.componentId === propId && isFrame(node) && node.componentId) return node.componentId;
      if (!isInstance(node)) {
        const inner = find(id);
        if (inner !== null) return inner;
      }
    }
    return null;
  };
  return find(instance.componentId);
}
