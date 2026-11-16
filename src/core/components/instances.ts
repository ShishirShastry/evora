import { setNodes } from '../document/mutate';
import { isFrame, isLayer, type DesignNode, type Document, type FrameNode, type InstanceOverrides, type LayerNode, type NodeId } from '../document/schema';
import { getAncestorIds, getChildIds } from '../scene/tree';

/**
 * Components and instances. A component is a frame that is the original of a
 * reusable piece of design; an instance is a frame that shows a component
 * somewhere else. What is in an instance is real layers, so that everything
 * else in the application (painting, selecting, Auto Layout) treats it as it
 * treats any frame, but those layers are not the designer's to arrange: each
 * mirrors one layer of the component (`sourceId`) and `syncInstances` keeps
 * it in step, after every change, the way a layout is kept in order.
 *
 * What a designer changes in an instance (a text, a fill, whether something
 * shows) is kept apart from the layers, on the instance, as `overrides`: for
 * a layer of the component, the properties that differ here. So a change to
 * the component reaches every instance and takes nothing away that was
 * changed in one.
 */

/** The properties of a layer inside an instance that may differ from the component's: what it shows, not where it is. */
export const OVERRIDABLE: readonly string[] = [
  'visible',
  'opacity',
  'fills',
  'strokes',
  'strokeWeight',
  'strokeAlign',
  'strokeCap',
  'strokeJoin',
  'dashPattern',
  'effects',
  'blendMode',
  'cornerRadius',
  'cornerRadii',
  'clipsContent',
  'characters',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'italic',
  'lineHeight',
  'letterSpacing',
  'textAlign',
  'verticalAlign',
  'textDecoration',
  'textCase',
  'listType',
  'styleRanges',
  // A component used inside the component: which one it is, and what was changed in it.
  'componentId',
  'overrides',
];

/** What an instance takes from its component for itself, as a frame: its look and its layout. */
const ROOT_COPIED: readonly string[] = [
  'fills',
  'strokes',
  'strokeWeight',
  'strokeAlign',
  'strokeCap',
  'strokeJoin',
  'dashPattern',
  'effects',
  'cornerRadius',
  'cornerRadii',
  'clipsContent',
  'layoutMode',
  'layoutWrap',
  'primaryAxisAlignItems',
  'counterAxisAlignItems',
  'counterAxisAlignContent',
  'itemSpacing',
  'counterAxisSpacing',
  'paddingLeft',
  'paddingRight',
  'paddingTop',
  'paddingBottom',
  'itemsReversed',
];

/** Of those, the ones an instance may have its own way: its look. Its layout is always the component's. */
const ROOT_OVERRIDABLE: readonly string[] = ROOT_COPIED.slice(0, 11);

/** What a layer inside an instance does not take from the layer it mirrors: who it is, and where the layout has put it. */
const NOT_COPIED = new Set(['id', 'parentId', 'order', 'sourceId']);
const GEOMETRY: readonly string[] = ['x', 'y', 'width', 'height', 'rotation'];

type Props = Record<string, unknown>;

const same = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b);

export function isComponent(node: DesignNode | undefined): node is FrameNode {
  return isFrame(node) && node.kind === 'COMPONENT';
}

export function isInstance(node: DesignNode | undefined): node is FrameNode {
  return isFrame(node) && node.kind === 'INSTANCE';
}

/** The instance a layer is part of: the nearest frame above it that is an instance, when the layer mirrors one of a component's. */
export function instanceOf(doc: Document, id: NodeId): FrameNode | null {
  const node = doc.nodes[id];
  if (!isLayer(node) || node.sourceId === null) return null;
  for (const ancestorId of getAncestorIds(doc, id)) {
    const ancestor = doc.nodes[ancestorId];
    if (isInstance(ancestor)) return ancestor;
  }
  return null;
}

/** Whether a layer is inside a component or an instance, or is one. Such a layer cannot be made into a component. */
export function inComponent(doc: Document, id: NodeId): boolean {
  return [id, ...getAncestorIds(doc, id)].some((nodeId) => {
    const node = doc.nodes[nodeId];
    return isFrame(node) && node.kind !== 'FRAME';
  });
}

/**
 * The ID of the layer that mirrors `sourceId` in the instance `instanceId`.
 * It is worked out from the two, so that the same layer of the same instance
 * is the same node however often the instance is rebuilt, and undo, selection
 * and collaboration can rely on it.
 */
export function mirrorId(instanceId: NodeId, sourceId: NodeId): NodeId {
  const text = `${instanceId}:${sourceId}`;
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  let out = '';
  for (let round = 0; out.length < 16; round++) {
    // FNV-1a, with a different start for each round.
    let hash = (0x811c9dc5 ^ (round * 0x9e3779b1)) >>> 0;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    for (let k = 0; k < 5 && out.length < 16; k++) {
      out += alphabet[hash % 62];
      hash = Math.floor(hash / 62);
    }
  }
  return out;
}

/** What was changed in a component used inside a component, on top of what the component itself changed in it. */
function mergeOverrides(base: InstanceOverrides, extra: InstanceOverrides | undefined): InstanceOverrides {
  if (!extra) return base;
  const merged: Record<NodeId, Props> = { ...base };
  for (const id in extra) merged[id] = { ...(base[id] ?? {}), ...extra[id] };
  return merged;
}

/** The part of `now` that is not already in `base`. */
function overridesBeyond(now: InstanceOverrides, base: InstanceOverrides): InstanceOverrides {
  const out: Record<NodeId, Props> = {};
  for (const id in now) {
    const props: Props = {};
    for (const key in now[id]) if (!same((now[id] as Props)[key], base[id]?.[key])) props[key] = (now[id] as Props)[key];
    if (Object.keys(props).length > 0) out[id] = props;
  }
  return out;
}

/** The layers of a component that an instance mirrors: everything in it, down to but not into the components it uses. */
function sourcesOf(doc: Document, componentId: NodeId): LayerNode[] {
  const out: LayerNode[] = [];
  const walk = (parentId: NodeId): void => {
    for (const id of getChildIds(doc, parentId)) {
      const node = doc.nodes[id];
      if (!isLayer(node)) continue;
      out.push(node);
      if (!isInstance(node)) walk(id);
    }
  };
  walk(componentId);
  return out;
}

/** The layers an instance holds as its own mirrors, with everything under each. */
function mirrorsIn(doc: Document, instanceId: NodeId): LayerNode[] {
  const out: LayerNode[] = [];
  const walk = (parentId: NodeId): void => {
    for (const id of getChildIds(doc, parentId)) {
      const node = doc.nodes[id];
      if (!isLayer(node)) continue;
      if (node.sourceId !== null) out.push(node);
      if (!isInstance(node)) walk(id);
    }
  };
  walk(instanceId);
  return out;
}

function subtreeIds(doc: Document, id: NodeId, into: Set<NodeId>): void {
  into.add(id);
  for (const childId of getChildIds(doc, id)) subtreeIds(doc, childId, into);
}

/**
 * Takes what the last edit changed inside instances and records it as
 * overrides. `previous` is the document before the edit, in which every
 * instance was in step with its component, so whatever differs now in a
 * layer of an instance was changed by the designer.
 */
function captureOverrides(previous: Document, doc: Document): Document {
  const changed: { id: NodeId; depth: number }[] = [];
  for (const id in doc.nodes) {
    const node = doc.nodes[id];
    const before = previous.nodes[id];
    if (!isLayer(node) || !isLayer(before) || node === before) continue;
    if (node.sourceId !== null && node.sourceId === before.sourceId) changed.push({ id, depth: getAncestorIds(doc, id).length });
    else if (isInstance(node) && isInstance(before) && node.componentId === before.componentId) changed.push({ id, depth: getAncestorIds(doc, id).length });
  }
  if (changed.length === 0) return doc;
  // Innermost first: what is recorded on an instance inside an instance is in turn a change to that instance.
  changed.sort((a, b) => b.depth - a.depth);
  const nodes: Record<NodeId, DesignNode> = { ...doc.nodes };
  const working = (): Document => ({ ...doc, nodes });
  const record = (ownerId: NodeId, sourceId: NodeId, props: Props): void => {
    const owner = nodes[ownerId] as FrameNode;
    nodes[ownerId] = { ...owner, overrides: { ...owner.overrides, [sourceId]: { ...(owner.overrides[sourceId] ?? {}), ...props } } };
    // An instance inside an instance has now changed too, and is looked at in its turn (it is further out, so later).
    if (owner.sourceId !== null && isLayer(previous.nodes[ownerId]) && !changed.some((entry) => entry.id === ownerId)) {
      changed.push({ id: ownerId, depth: getAncestorIds(doc, ownerId).length });
    }
  };
  for (let i = 0; i < changed.length; i++) {
    const { id } = changed[i] as { id: NodeId };
    const node = nodes[id] as LayerNode;
    const before = previous.nodes[id] as LayerNode;
    const now = node as unknown as Props;
    const was = before as unknown as Props;
    // Its own look, as an instance, when it differs from the component's, is recorded on itself.
    const own = isInstance(node) && isInstance(before) && node.componentId !== null && node.componentId === before.componentId;
    if (own) {
      const props: Props = {};
      for (const key of ROOT_OVERRIDABLE) if (!same(now[key], was[key])) props[key] = now[key];
      if (Object.keys(props).length > 0) record(id, node.componentId as NodeId, props);
    }
    if (node.sourceId === null) continue;
    const owner = instanceOf(working(), id);
    if (!owner) continue;
    // For an instance inside an instance, that record is what the outer one keeps (as part of `overrides`).
    const current = nodes[id] as unknown as Props;
    const props: Props = {};
    for (const key of OVERRIDABLE) {
      if (own && ROOT_OVERRIDABLE.includes(key)) continue;
      const now = current;
      if (!(key in now) || same(now[key], was[key])) continue;
      if (key === 'overrides') {
        const source = doc.nodes[node.sourceId];
        props[key] = overridesBeyond(now[key] as InstanceOverrides, isFrame(source) ? source.overrides : {});
      } else props[key] = now[key];
    }
    if (Object.keys(props).length > 0) record(owner.id, node.sourceId, props);
  }
  return setNodes(doc, nodes);
}

/** Brings one instance into step with its component. Returns the document and the instances inside it that it made or changed. */
function mirror(doc: Document, since: Document, instanceId: NodeId): { doc: Document; inner: NodeId[] } {
  const instance = doc.nodes[instanceId];
  if (!isInstance(instance)) return { doc, inner: [] };
  const component = instance.componentId === null ? undefined : doc.nodes[instance.componentId];
  const changes: Record<NodeId, DesignNode | null> = {};

  if (!isComponent(component)) {
    // Its component is gone: it stays as it is, as an ordinary frame with ordinary layers in it.
    changes[instanceId] = { ...instance, kind: 'FRAME', componentId: null, overrides: {} };
    for (const node of mirrorsIn(doc, instanceId)) changes[node.id] = { ...node, sourceId: null };
    return { doc: setNodes(doc, changes), inner: [] };
  }
  // A component cannot hold an instance of itself, however indirectly: there would be no end to it.
  if (getAncestorIds(doc, instanceId).some((id) => id === component.id || doc.nodes[id]?.id === instance.componentId)) return { doc, inner: [] };
  if (getAncestorIds(doc, instanceId).length > 60) return { doc, inner: [] };

  const before = since.nodes[instanceId];
  const fresh = !isInstance(before) || before.componentId !== instance.componentId;
  const componentBefore = since.nodes[component.id];

  // The instance itself: its look and layout are the component's, except where it has its own.
  const root: Props = { ...(instance as unknown as Props) };
  const rootOverrides = instance.overrides[component.id] ?? {};
  for (const key of ROOT_COPIED) root[key] = key in rootOverrides && ROOT_OVERRIDABLE.includes(key) ? rootOverrides[key] : (component as unknown as Props)[key];
  // It is as big as the component until it is given a size of its own, and follows the component while it is.
  if (isFrame(componentBefore) && !fresh) {
    if (instance.width === componentBefore.width && component.width !== componentBefore.width) root.width = component.width;
    if (instance.height === componentBefore.height && component.height !== componentBefore.height) root.height = component.height;
  }
  let rootChanged = false;
  for (const key in root) if (!same(root[key], (instance as unknown as Props)[key])) rootChanged = true;
  if (rootChanged) changes[instanceId] = root as unknown as DesignNode;

  const expected = new Set<NodeId>();
  const inner: NodeId[] = [];
  for (const source of sourcesOf(doc, component.id)) {
    const id = mirrorId(instanceId, source.id);
    expected.add(id);
    const existing = doc.nodes[id];
    const override = instance.overrides[source.id] ?? {};
    const sourceBefore = since.nodes[source.id];
    const made = !isLayer(existing) || existing.sourceId !== source.id || fresh;
    const next: Props = made ? {} : { ...(existing as unknown as Props) };
    const from = source as unknown as Props;
    for (const key in from) {
      if (NOT_COPIED.has(key)) continue;
      if (GEOMETRY.includes(key)) {
        // Where a layer is and how big belong to the layout of the instance; the component's are taken when they change.
        if (made || !isLayer(sourceBefore) || (sourceBefore as unknown as Props)[key] !== from[key]) next[key] = from[key];
        continue;
      }
      if (key === 'overrides') next[key] = mergeOverrides(from[key] as InstanceOverrides, override[key] as InstanceOverrides | undefined);
      else next[key] = key in override && OVERRIDABLE.includes(key) ? override[key] : from[key];
    }
    next.id = id;
    next.sourceId = source.id;
    next.parentId = source.parentId === component.id ? instanceId : mirrorId(instanceId, source.parentId);
    next.order = source.order;
    let differs = !isLayer(existing);
    if (!differs) for (const key in next) if (!same(next[key], (existing as unknown as Props)[key])) differs = true;
    if (differs) {
      changes[id] = next as unknown as DesignNode;
      if (isInstance(source)) inner.push(id);
    }
  }
  // Mirrors of layers the component no longer has go, with what is in them.
  const gone = new Set<NodeId>();
  for (const node of mirrorsIn(doc, instanceId)) if (!expected.has(node.id) && !gone.has(node.id)) subtreeIds(doc, node.id, gone);
  for (const id of gone) if (!expected.has(id)) changes[id] = null;
  return { doc: setNodes(doc, changes), inner };
}

/**
 * Keeps every instance in step with its component. With `capture`, what the
 * last edit changed inside instances is first recorded as their overrides
 * (`since` must then be the document before that edit). After that each
 * instance is given the component's layers as they are now, with its
 * overrides laid over them; a layer's place and size are only taken from the
 * component where the component's changed since `since`, since in between
 * they are the instance's own layout. Returns the same document when every
 * instance is in step already.
 */
export function syncInstances(since: Document, doc: Document, capture: boolean): Document {
  let any = false;
  for (const id in doc.nodes) {
    const node = doc.nodes[id];
    if (isLayer(node) && (node.sourceId !== null || isInstance(node))) {
      any = true;
      break;
    }
  }
  if (!any) return doc;

  let next = capture ? captureOverrides(since, doc) : doc;

  // A layer that mirrors another but is in no instance (it was copied out of one) is an ordinary layer.
  const loose: Record<NodeId, DesignNode> = {};
  for (const id in next.nodes) {
    const node = next.nodes[id];
    if (isLayer(node) && node.sourceId !== null && !instanceOf(next, id)) loose[id] = { ...node, sourceId: null };
  }
  next = setNodes(next, loose);

  // Outermost first: an instance inside another exists only once the outer one has been given its layers.
  const queue: NodeId[] = [];
  for (const id in next.nodes) if (isInstance(next.nodes[id])) queue.push(id);
  const depth = new Map<NodeId, number>();
  for (const id of queue) depth.set(id, getAncestorIds(next, id).length);
  queue.sort((a, b) => (depth.get(a) ?? 0) - (depth.get(b) ?? 0) || (a < b ? -1 : 1));
  const done = new Set<NodeId>();
  for (let i = 0; i < queue.length && i < 100000; i++) {
    const id = queue[i] as NodeId;
    if (done.has(id)) continue;
    done.add(id);
    const out = mirror(next, since, id);
    next = out.doc;
    for (const innerId of out.inner) {
      done.delete(innerId);
      queue.push(innerId);
    }
  }
  return next;
}
