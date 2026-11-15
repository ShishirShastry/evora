import { createLayer, nextLayerName } from '../document/factory';
import { patchNodes, setNodes } from '../document/mutate';
import {
  isLayer,
  type BooleanOperation,
  type DesignNode,
  type Document,
  type LayerNode,
  type LayerPatch,
  type NodeId,
  type VectorNetwork,
  type VectorNode,
} from '../document/schema';
import { applyToPoint, invert, multiply } from '../math/matrix';
import { getChildIds, getDescendantIds, getWorldMatrix, sortByPaintOrder, topLevelIds } from '../scene/tree';
import type { BooleanOperand } from '../vector/boolean';
import { fitVectorNode } from '../vector/fit';
import { mapNetwork } from '../vector/network';
import { combineNetworks, hasOutline, shapeNetwork } from '../vector/shapes';
import { groupNodes, normalizeGroups } from './groups';
import { insertionKeys } from './ordering';

/**
 * Restores the invariants of vector layers after an edit: every changed
 * vector's box is the bounding box of its curves, and a vector that has no
 * points left is removed. Returns the same document when nothing needs doing.
 */
export function fitVectors(previous: Document, doc: Document): Document {
  if (previous.nodes === doc.nodes) return doc;
  const changes: Record<NodeId, DesignNode | null> = {};
  for (const id in doc.nodes) {
    const node = doc.nodes[id];
    if (!node || node.type !== 'VECTOR' || node === previous.nodes[id]) continue;
    if (node.network.vertices.length === 0) {
      changes[id] = null;
      continue;
    }
    const fitted = fitVectorNode(node);
    if (fitted !== node) changes[id] = fitted;
  }
  return setNodes(doc, changes);
}

/** Replaces a vector layer's points and curves, and refits its box around them. */
export function setNetwork(doc: Document, id: NodeId, network: VectorNetwork): Document {
  const node = doc.nodes[id];
  if (!node || node.type !== 'VECTOR' || node.network === network) return doc;
  return setNodes(doc, { [id]: fitVectorNode({ ...node, network }) });
}

/** What a vector takes over from the layer it is made from. */
function appearanceOf(node: LayerNode): LayerPatch {
  return {
    visible: node.visible,
    locked: node.locked,
    opacity: node.opacity,
    fills: node.fills,
    strokes: node.strokes,
    strokeWeight: node.strokeWeight,
    // A line has no inside, so its stroke is centred whatever it says.
    strokeAlign: node.type === 'LINE' ? 'CENTER' : node.strokeAlign,
    strokeCap: node.strokeCap,
    strokeJoin: node.strokeJoin,
    dashPattern: node.dashPattern,
    effects: node.effects,
    blendMode: node.blendMode,
    constraints: node.constraints,
    ...(node.type === 'LINE' || node.type === 'VECTOR' ? { startArrow: node.startArrow, endArrow: node.endArrow } : {}),
  };
}

/** Can `flattenNodes` do anything with this selection? */
export function canFlatten(doc: Document, ids: readonly NodeId[]): boolean {
  const members = flattenMembers(doc, ids);
  return members.length > 1 || (members.length === 1 && doc.nodes[members[0] as NodeId]?.type !== 'VECTOR');
}

/** The shapes a flatten would merge, bottom first: the selected shapes and those inside selected groups. */
function flattenMembers(doc: Document, ids: readonly NodeId[]): NodeId[] {
  const members: NodeId[] = [];
  const collect = (id: NodeId): void => {
    const node = doc.nodes[id];
    if (!isLayer(node)) return;
    if (node.type === 'GROUP') for (const childId of getChildIds(doc, id)) collect(childId);
    else if (hasOutline(node)) members.push(id);
  };
  for (const id of sortByPaintOrder(doc, topLevelIds(doc, ids))) collect(id);
  return members;
}

/**
 * Flattens shapes into one editable vector layer. A single shape is converted
 * where it is and keeps its identity. Several shapes become one vector that
 * holds all their outlines, takes the appearance of the bottom-most of them
 * and sits where the top-most selected layer was. Frames and text are left
 * alone. Returns null when there is nothing to flatten.
 */
export function flattenNodes(doc: Document, ids: readonly NodeId[]): { doc: Document; id: NodeId } | null {
  const members = flattenMembers(doc, ids);
  const first = doc.nodes[members[0] as NodeId];
  if (!isLayer(first)) return null;

  if (members.length === 1) {
    if (first.type === 'VECTOR') return null;
    const network = shapeNetwork(first);
    if (!network) return null;
    const vector = createLayer('VECTOR', first.parentId, first.order, {
      ...appearanceOf(first),
      isMask: first.isMask,
      name: first.name,
      x: first.x,
      y: first.y,
      width: first.width,
      height: first.height,
      rotation: first.rotation,
      network,
    }) as VectorNode;
    const changes: Record<NodeId, DesignNode | null> = { [first.id]: fitVectorNode({ ...vector, id: first.id }) };
    // A boolean group becomes its result; the shapes it was made of go.
    for (const id of getDescendantIds(doc, first.id)) changes[id] = null;
    return { doc: setNodes(doc, changes), id: first.id };
  }

  const outlines = outlinesOf(doc, ids, members);
  if (!outlines) return null;
  return replaceWithVector(doc, members, outlines, combineNetworks(outlines.operands.map((operand) => operand.network)), {
    name: nextLayerName(doc, 'VECTOR'),
  });
}

interface Outlines {
  /** Where the layer that replaces the shapes goes: the parent of the top-most selected layer, directly above it. */
  parentId: NodeId;
  index: number;
  /** The shapes' outlines in that parent's coordinates, bottom-most first. */
  operands: BooleanOperand[];
}

function outlinesOf(doc: Document, ids: readonly NodeId[], members: readonly NodeId[]): Outlines | null {
  const roots = sortByPaintOrder(doc, topLevelIds(doc, ids)).filter((id) => isLayer(doc.nodes[id]));
  const top = doc.nodes[roots[roots.length - 1] as NodeId];
  if (!isLayer(top)) return null;
  const parentId = top.parentId;
  const toParent = invert(getWorldMatrix(doc, parentId));
  const operands: BooleanOperand[] = [];
  for (const id of members) {
    const node = doc.nodes[id] as LayerNode;
    const network = shapeNetwork(node);
    if (!network) continue;
    const matrix = multiply(toParent, getWorldMatrix(doc, id));
    operands.push({
      network: mapNetwork(network, (p) => applyToPoint(matrix, p)),
      windingRule: node.type === 'VECTOR' ? node.windingRule : 'NONZERO',
    });
  }
  return { parentId, index: getChildIds(doc, parentId).indexOf(top.id) + 1, operands };
}

/** Puts one vector holding `network` in the place of the given shapes. It looks like the bottom-most of them did. */
function replaceWithVector(
  doc: Document,
  members: readonly NodeId[],
  outlines: Outlines,
  network: VectorNetwork,
  props: LayerPatch,
): { doc: Document; id: NodeId } {
  const { keys, rekeyed } = insertionKeys(doc, outlines.parentId, outlines.index, 1);
  const vector = createLayer('VECTOR', outlines.parentId, keys[0] as string, {
    ...appearanceOf(doc.nodes[members[0] as NodeId] as LayerNode),
    x: 0,
    y: 0,
    rotation: 0,
    ...props,
    network,
  }) as VectorNode;
  const changes: Record<NodeId, DesignNode | null> = { [vector.id]: fitVectorNode(vector) };
  for (const id of members) {
    changes[id] = null;
    for (const inside of getDescendantIds(doc, id)) changes[inside] = null;
  }
  // Groups that gave up everything they held go too.
  return { doc: normalizeGroups(setNodes(patchNodes(doc, rekeyed), changes)), id: vector.id };
}

export const BOOLEAN_NAMES: Record<BooleanOperation, string> = {
  UNION: 'Union',
  SUBTRACT: 'Subtract',
  INTERSECT: 'Intersect',
  EXCLUDE: 'Exclude',
};

/** The selected layers a boolean operation can combine, bottom first: shapes, vectors, boolean groups, and groups that hold any. */
function booleanRoots(doc: Document, ids: readonly NodeId[]): NodeId[] {
  return sortByPaintOrder(doc, topLevelIds(doc, ids)).filter((id) => flattenMembers(doc, [id]).length > 0);
}

/** Can `booleanNodes` do anything with this selection? It needs at least two layers that have an outline. */
export function canBoolean(doc: Document, ids: readonly NodeId[]): boolean {
  return booleanRoots(doc, ids).length >= 2;
}

/**
 * Combines layers in a boolean group: their union, the bottom-most with the
 * others taken out of it, what they all share, or what an odd number of them
 * cover. The layers become the group's children, where they can still be
 * moved and edited, and the group shows the result with the appearance of
 * the bottom-most shape. Returns null when there are fewer than two layers
 * to combine or when nothing would be left (shapes that do not overlap have
 * no intersection), in which case the document is not changed.
 */
export function booleanNodes(doc: Document, ids: readonly NodeId[], operation: BooleanOperation): { doc: Document; id: NodeId } | null {
  const roots = booleanRoots(doc, ids);
  if (roots.length < 2) return null;
  const leaf = doc.nodes[flattenMembers(doc, [roots[0] as NodeId])[0] as NodeId];
  const grouped = groupNodes(doc, roots);
  const group = grouped ? grouped.doc.nodes[grouped.id] : undefined;
  if (!grouped || !isLayer(group) || !isLayer(leaf)) return null;
  const look = appearanceOf(leaf);
  delete look.startArrow;
  delete look.endArrow;
  const node = createLayer('BOOLEAN_OPERATION', group.parentId, group.order, {
    ...look,
    name: BOOLEAN_NAMES[operation],
    x: group.x,
    y: group.y,
    width: group.width,
    height: group.height,
    operation,
  });
  // The group that was just made becomes the boolean group; bringing it up to date works out its result.
  const next = normalizeGroups(setNodes(grouped.doc, { [grouped.id]: { ...node, id: grouped.id } }));
  const result = next.nodes[grouped.id];
  if (!result || result.type !== 'BOOLEAN_OPERATION' || result.network.segments.length === 0) return null;
  return { doc: next, id: grouped.id };
}
