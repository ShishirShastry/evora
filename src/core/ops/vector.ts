import { createLayer, nextLayerName } from '../document/factory';
import { patchNodes, setNodes } from '../document/mutate';
import {
  isLayer,
  type DesignNode,
  type Document,
  type LayerNode,
  type LayerPatch,
  type NodeId,
  type VectorNetwork,
  type VectorNode,
} from '../document/schema';
import { applyToPoint, invert, multiply } from '../math/matrix';
import { getChildIds, getWorldMatrix, sortByPaintOrder, topLevelIds } from '../scene/tree';
import { booleanNetworks, type BooleanOperand, type BooleanOperation } from '../vector/boolean';
import { fitVectorNode } from '../vector/fit';
import { mapNetwork } from '../vector/network';
import { combineNetworks, hasOutline, shapeNetwork } from '../vector/shapes';
import { normalizeGroups } from './groups';
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
      name: first.name,
      x: first.x,
      y: first.y,
      width: first.width,
      height: first.height,
      rotation: first.rotation,
      network,
    }) as VectorNode;
    return { doc: setNodes(doc, { [first.id]: fitVectorNode({ ...vector, id: first.id }) }), id: first.id };
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
  for (const id of members) changes[id] = null;
  // Groups that gave up everything they held go too.
  return { doc: normalizeGroups(setNodes(patchNodes(doc, rekeyed), changes)), id: vector.id };
}

export const BOOLEAN_NAMES: Record<BooleanOperation, string> = {
  UNION: 'Union',
  SUBTRACT: 'Subtract',
  INTERSECT: 'Intersect',
  EXCLUDE: 'Exclude',
};

/** Can `booleanNodes` do anything with this selection? It needs at least two shapes. */
export function canBoolean(doc: Document, ids: readonly NodeId[]): boolean {
  return flattenMembers(doc, ids).length >= 2;
}

/**
 * Combines shapes into one vector layer: their union, the bottom-most with
 * the others taken out of it, what they all share, or what an odd number of
 * them cover. The shapes are replaced by the result, which takes the
 * appearance of the bottom-most. Returns null when there are fewer than two
 * shapes or when nothing is left (shapes that do not overlap have no
 * intersection), in which case the document is not changed.
 */
export function booleanNodes(doc: Document, ids: readonly NodeId[], operation: BooleanOperation): { doc: Document; id: NodeId } | null {
  const members = flattenMembers(doc, ids);
  if (members.length < 2) return null;
  const outlines = outlinesOf(doc, ids, members);
  if (!outlines) return null;
  const network = booleanNetworks(outlines.operands, operation);
  if (network.segments.length === 0) return null;
  return replaceWithVector(doc, members, outlines, network, { name: BOOLEAN_NAMES[operation], windingRule: 'NONZERO' });
}
