import { inComponent, isComponent, isInstance } from '../components/instances';
import { createLayer } from '../document/factory';
import { patchNodes, setNodes } from '../document/mutate';
import { isFrame, isLayer, isPage, type Document, type FrameNode, type LayerNode, type LayerPatch, type NodeId } from '../document/schema';
import { transformedBounds, unionRects, type Point, type Rect } from '../math/geometry';
import { applyToPoint, invert, multiply } from '../math/matrix';
import { getAncestorIds, getChildIds, getPageIdOf, getWorldMatrix, sortByPaintOrder, topLevelIds } from '../scene/tree';
import { reparentNodes } from './arrange';
import { insertionKeys, topIndex } from './ordering';
import { clean } from './transform';

/**
 * What the user does with components: making one, placing instances of it,
 * and for an instance detaching it, resetting it and showing another
 * component in its place. Keeping instances in step is `syncInstances`,
 * which the editor runs after every change.
 */

/** "Component 3": the next unused name for a component. */
function nextComponentName(doc: Document): string {
  let max = 0;
  for (const id in doc.nodes) {
    const match = /^Component (\d+)$/.exec((doc.nodes[id] as { name: string }).name);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `Component ${max + 1}`;
}

/**
 * Makes a component. A single ordinary frame becomes one as it is; anything
 * else that is selected is put into a new frame, which becomes the
 * component. Nothing inside a component or an instance can become one.
 * Returns the component, or null when nothing could be done.
 */
export function createComponent(doc: Document, ids: readonly NodeId[]): { doc: Document; id: NodeId } | null {
  const selected = sortByPaintOrder(doc, topLevelIds(doc, ids)).filter((id) => isLayer(doc.nodes[id]));
  if (selected.length === 0 || selected.some((id) => inComponent(doc, id))) return null;
  // Nor can a component hold another component, or be made round an instance of something that holds it.
  const only = selected.length === 1 ? doc.nodes[selected[0] as NodeId] : undefined;
  if (isFrame(only) && only.kind === 'FRAME') {
    const named = /^Frame \d+$/.test(only.name) ? { name: nextComponentName(doc) } : {};
    return { doc: patchNodes(doc, { [only.id]: { kind: 'COMPONENT', ...named } }), id: only.id };
  }
  const top = doc.nodes[selected[selected.length - 1] as NodeId] as LayerNode;
  const parentId = top.parentId;
  const rects = selected.map((id) => {
    const node = doc.nodes[id] as LayerNode;
    return transformedBounds(multiply(invert(getWorldMatrix(doc, parentId)), getWorldMatrix(doc, id)), node.width, node.height);
  });
  const bounds = unionRects(rects) as Rect;
  const exclude = new Set(selected);
  const below = getChildIds(doc, parentId).slice(0, getChildIds(doc, parentId).indexOf(top.id));
  const { keys, rekeyed } = insertionKeys(doc, parentId, below.filter((id) => !exclude.has(id)).length, 1, exclude);
  const frame = createLayer('FRAME', parentId, keys[0] as string, {
    name: nextComponentName(doc),
    x: clean(bounds.x),
    y: clean(bounds.y),
    width: clean(bounds.width),
    height: clean(bounds.height),
    fills: [],
    clipsContent: false,
    kind: 'COMPONENT',
  });
  let next = setNodes(patchNodes(doc, rekeyed), { [frame.id]: frame });
  next = reparentNodes(next, selected, frame.id);
  return { doc: next, id: frame.id };
}

/** Every component of the document, in the order of their names. */
export function listComponents(doc: Document): FrameNode[] {
  const out: FrameNode[] = [];
  for (const id in doc.nodes) {
    const node = doc.nodes[id];
    if (isComponent(node)) out.push(node);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1));
}

/**
 * Places an instance of a component: in `parentId`, with its top-left corner
 * at a point of that container, or when no place is given on the component's
 * own page, beside the component. Its layers are made by `syncInstances`.
 */
export function createInstance(doc: Document, componentId: NodeId, place?: { parentId: NodeId; at: Point }): { doc: Document; id: NodeId } | null {
  const component = doc.nodes[componentId];
  if (!isComponent(component)) return null;
  let parentId: NodeId;
  let at: Point;
  if (place) {
    // An instance of a component cannot go inside that component.
    if (place.parentId === componentId || getAncestorIds(doc, place.parentId).includes(componentId)) return null;
    parentId = place.parentId;
    at = place.at;
  } else {
    const pageId = getPageIdOf(doc, componentId);
    if (!pageId || !isPage(doc.nodes[pageId])) return null;
    const corner = applyToPoint(getWorldMatrix(doc, componentId), { x: 0, y: 0 });
    parentId = pageId;
    at = { x: clean(corner.x + component.width + 40), y: clean(corner.y) };
  }
  const { keys, rekeyed } = insertionKeys(doc, parentId, topIndex(doc, parentId), 1);
  const instance = createLayer('FRAME', parentId, keys[0] as string, {
    name: component.name,
    x: at.x,
    y: at.y,
    width: component.width,
    height: component.height,
    kind: 'INSTANCE',
    componentId,
    layoutSizingHorizontal: component.layoutSizingHorizontal === 'HUG' ? 'HUG' : 'FIXED',
    layoutSizingVertical: component.layoutSizingVertical === 'HUG' ? 'HUG' : 'FIXED',
    fills: component.fills,
  });
  return { doc: setNodes(patchNodes(doc, rekeyed), { [instance.id]: instance }), id: instance.id };
}

/** The layers an instance holds for itself: all under it, not into the instances inside it. */
function ownLayers(doc: Document, instanceId: NodeId): LayerNode[] {
  const out: LayerNode[] = [];
  const walk = (parentId: NodeId): void => {
    for (const id of getChildIds(doc, parentId)) {
      const node = doc.nodes[id];
      if (!isLayer(node)) continue;
      out.push(node);
      if (!isInstance(node)) walk(id);
    }
  };
  walk(instanceId);
  return out;
}

/**
 * Detaches instances: each becomes an ordinary frame holding ordinary
 * layers, exactly as it looks now, and no longer follows its component.
 * Instances inside it stay instances of their own components.
 */
export function detachInstances(doc: Document, ids: readonly NodeId[]): Document {
  const patches: Record<NodeId, LayerPatch> = {};
  for (const id of ids) {
    const node = doc.nodes[id];
    // An instance inside another is that one's to detach.
    if (!isInstance(node) || node.sourceId !== null) continue;
    patches[id] = { kind: 'FRAME', componentId: null, overrides: {} };
    for (const layer of ownLayers(doc, id)) patches[layer.id] = { sourceId: null };
  }
  return patchNodes(doc, patches);
}

/** Takes away everything that was changed in instances: they are their components again, at the size they have. */
export function resetInstances(doc: Document, ids: readonly NodeId[]): Document {
  const patches: Record<NodeId, LayerPatch> = {};
  for (const id of ids) {
    const node = doc.nodes[id];
    if (isInstance(node) && Object.keys(node.overrides).length > 0) patches[id] = { overrides: {} };
  }
  return patchNodes(doc, patches);
}

/** A layer's place in its component, as the names from the component down to it. */
function namePath(doc: Document, rootId: NodeId, id: NodeId): string {
  const names: string[] = [];
  let current: NodeId | null = id;
  while (current !== null && current !== rootId) {
    const node: LayerNode | undefined = doc.nodes[current] as LayerNode | undefined;
    if (!node) break;
    names.unshift(`${node.type}:${node.name}`);
    current = node.parentId;
  }
  return names.join('/');
}

/**
 * Shows another component in instances. What was changed in an instance is
 * kept wherever the new component has a layer of the same kind and name in
 * the same place; the rest has nothing to apply to and is dropped.
 */
export function swapInstances(doc: Document, ids: readonly NodeId[], componentId: NodeId): Document {
  const target = doc.nodes[componentId];
  if (!isComponent(target)) return doc;
  const targets = new Map<string, NodeId>();
  const walk = (parentId: NodeId): void => {
    for (const id of getChildIds(doc, parentId)) {
      const path = namePath(doc, componentId, id);
      if (!targets.has(path)) targets.set(path, id);
      if (!isInstance(doc.nodes[id])) walk(id);
    }
  };
  walk(componentId);
  const patches: Record<NodeId, LayerPatch> = {};
  for (const id of ids) {
    const node = doc.nodes[id];
    if (!isInstance(node) || node.componentId === componentId || node.componentId === null) continue;
    if (id === componentId || getAncestorIds(doc, id).includes(componentId)) continue;
    const overrides: Record<NodeId, Readonly<Record<string, unknown>>> = {};
    for (const sourceId in node.overrides) {
      const props = node.overrides[sourceId] as Readonly<Record<string, unknown>>;
      if (sourceId === node.componentId) overrides[componentId] = props;
      else {
        const match = targets.get(namePath(doc, node.componentId, sourceId));
        if (match) overrides[match] = props;
      }
    }
    // An instance that was the size of its component is the size of the new one; a size of its own it keeps.
    const old = doc.nodes[node.componentId];
    const size: LayerPatch = {};
    if (isFrame(old) && node.width === old.width) size.width = target.width;
    if (isFrame(old) && node.height === old.height) size.height = target.height;
    patches[id] = { componentId, overrides, ...size };
  }
  return patchNodes(doc, patches);
}
