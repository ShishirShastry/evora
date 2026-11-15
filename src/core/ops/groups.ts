import { createLayer, nextLayerName } from '../document/factory';
import { patchNodes, setNodes } from '../document/mutate';
import {
  isContainer,
  isGroup,
  isLayer,
  type Document,
  type LayerNode,
  type LayerPatch,
  type NodeId,
} from '../document/schema';
import { transformedBounds, unionRects, type Rect } from '../math/geometry';
import { applyToPoint, invert, multiply } from '../math/matrix';
import {
  getAncestorIds,
  getChildIds,
  getLocalMatrix,
  getWorldMatrix,
  sortByPaintOrder,
  topLevelIds,
} from '../scene/tree';
import { reparentNodes } from './arrange';
import { insertionKeys } from './ordering';
import { clean } from './transform';

const EPSILON = 0.0005;

/** Bounds of a layer's box in the coordinate space of `ancestorId` (which must contain it). */
function boundsIn(doc: Document, id: NodeId, ancestorId: NodeId): Rect {
  const node = doc.nodes[id] as LayerNode;
  const matrix = multiply(invert(getWorldMatrix(doc, ancestorId)), getWorldMatrix(doc, id));
  return transformedBounds(matrix, node.width, node.height);
}

/**
 * Groups layers. The group takes the place of the top-most selected layer in
 * that layer's parent, and the layers keep their positions on the page and
 * their stacking order relative to each other.
 */
export function groupNodes(doc: Document, ids: readonly NodeId[]): { doc: Document; id: NodeId } | null {
  const members = sortByPaintOrder(doc, topLevelIds(doc, ids)).filter((id) => isLayer(doc.nodes[id]));
  const top = doc.nodes[members[members.length - 1] as NodeId];
  if (!isLayer(top)) return null;
  const parentId = top.parentId;

  const bounds = unionRects(members.map((id) => boundsIn(doc, id, parentId)));
  if (!bounds) return null;

  const exclude = new Set(members);
  const siblings = getChildIds(doc, parentId).filter((id) => !exclude.has(id));
  // The group goes where the top-most member was: above every sibling that was below it.
  const below = getChildIds(doc, parentId).slice(0, getChildIds(doc, parentId).indexOf(top.id));
  const index = below.filter((id) => !exclude.has(id)).length;
  const { keys, rekeyed } = insertionKeys(doc, parentId, Math.min(index, siblings.length), 1, exclude);

  const group = createLayer('GROUP', parentId, keys[0] as string, {
    name: nextLayerName(doc, 'GROUP'),
    x: clean(bounds.x),
    y: clean(bounds.y),
    width: clean(bounds.width),
    height: clean(bounds.height),
  });
  let next = setNodes(patchNodes(doc, rekeyed), { [group.id]: group });
  next = reparentNodes(next, members, group.id);
  return { doc: next, id: group.id };
}

/**
 * Dissolves groups (and frames): their children move up into the container's
 * parent, in the container's place, without moving on the page. Returns the
 * IDs of the released children.
 */
export function ungroupNodes(doc: Document, ids: readonly NodeId[]): { doc: Document; ids: NodeId[] } {
  let next = doc;
  const released: NodeId[] = [];
  for (const id of topLevelIds(doc, ids)) {
    const container = next.nodes[id];
    if (!isLayer(container) || !isContainer(container)) continue;
    const children = [...getChildIds(next, id)];
    if (children.length === 0) continue;
    const index = getChildIds(next, container.parentId).indexOf(id);
    next = reparentNodes(next, children, container.parentId, index);
    next = setNodes(next, { [id]: null });
    released.push(...children);
  }
  return { doc: next, ids: released };
}

/** Shrinks or grows one group's box to exactly contain its children, without moving them on the page. */
function fitGroup(doc: Document, id: NodeId): Document {
  const group = doc.nodes[id];
  if (!isGroup(group)) return doc;
  const children = getChildIds(doc, id);
  const rects: Rect[] = [];
  for (const childId of children) {
    const child = doc.nodes[childId];
    if (isLayer(child)) rects.push(transformedBounds(getLocalMatrix(child), child.width, child.height));
  }
  const bounds = unionRects(rects);
  if (!bounds) return doc;
  if (
    Math.abs(bounds.x) < EPSILON &&
    Math.abs(bounds.y) < EPSILON &&
    Math.abs(bounds.width - group.width) < EPSILON &&
    Math.abs(bounds.height - group.height) < EPSILON
  ) {
    return doc;
  }
  // The group turns about its own centre, so place the new centre where the
  // old frame of reference says the children's bounds are.
  const center = applyToPoint(getLocalMatrix(group), {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
  });
  const patches: Record<NodeId, LayerPatch> = {
    [id]: {
      x: clean(center.x - bounds.width / 2),
      y: clean(center.y - bounds.height / 2),
      width: clean(bounds.width),
      height: clean(bounds.height),
    },
  };
  for (const childId of children) {
    const child = doc.nodes[childId];
    if (isLayer(child)) patches[childId] = { x: clean(child.x - bounds.x), y: clean(child.y - bounds.y) };
  }
  return patchNodes(doc, patches);
}

/**
 * Restores the invariants of groups after any edit: a group with no children
 * is removed, and every group's box is its children's bounding box. Runs
 * innermost groups first. Returns the same document when nothing needs doing.
 */
export function normalizeGroups(doc: Document): Document {
  let groups: NodeId[] = [];
  for (const id in doc.nodes) if (doc.nodes[id]?.type === 'GROUP') groups.push(id);
  if (groups.length === 0) return doc;

  let next = doc;
  for (;;) {
    const empty = groups.filter((id) => next.nodes[id] && getChildIds(next, id).length === 0);
    if (empty.length === 0) break;
    const removal: Record<NodeId, null> = {};
    for (const id of empty) removal[id] = null;
    next = setNodes(next, removal);
    groups = groups.filter((id) => next.nodes[id]);
  }

  const depth = new Map<NodeId, number>();
  for (const id of groups) depth.set(id, getAncestorIds(next, id).length);
  groups.sort((a, b) => (depth.get(b) ?? 0) - (depth.get(a) ?? 0));
  for (const id of groups) next = fitGroup(next, id);
  return next;
}
