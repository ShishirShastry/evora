import { patchNodes } from '../document/mutate';
import {
  isLayer,
  type BooleanOperation,
  type BooleanOperationNode,
  type DesignNode,
  type Document,
  type LayerPatch,
  type NodeId,
  type VectorNetwork,
} from '../document/schema';
import { transformedBounds, unionRects, type Rect } from '../math/geometry';
import { applyToPoint } from '../math/matrix';
import { getChildIds, getDescendantIds, getLocalMatrix } from '../scene/tree';
import { booleanNetworks, type BooleanOperand } from '../vector/boolean';
import { mapNetwork, networkBounds, sameNetwork, translateNetwork } from '../vector/network';
import { shapeNetwork } from '../vector/shapes';
import { clean } from './transform';

/**
 * Boolean groups: layers that keep the shapes they combine as children and
 * show the result of combining them. The result is worked out from the
 * children whenever any of them changes, and kept on the group.
 */

const EPSILON = 0.001;

/**
 * The outline of a layer in its parent's coordinates, as something a boolean
 * operation can combine. A group counts as the union of what is in it.
 * Hidden layers, and layers that have no outline (frames, text), count for
 * nothing.
 */
export function outlineInParent(doc: Document, id: NodeId): BooleanOperand | null {
  const node = doc.nodes[id];
  if (!isLayer(node) || !node.visible) return null;
  const matrix = getLocalMatrix(node);
  const place = (network: VectorNetwork): VectorNetwork => mapNetwork(network, (p) => applyToPoint(matrix, p));
  if (node.type === 'GROUP') {
    const parts: BooleanOperand[] = [];
    for (const childId of getChildIds(doc, id)) {
      const part = outlineInParent(doc, childId);
      if (part) parts.push(part);
    }
    const only = parts[0];
    if (!only) return null;
    if (parts.length === 1) return { network: place(only.network), windingRule: only.windingRule };
    return { network: place(booleanNetworks(parts, 'UNION')), windingRule: 'NONZERO' };
  }
  const network = shapeNetwork(node);
  if (!network || network.segments.length === 0) return null;
  return { network: place(network), windingRule: node.type === 'VECTOR' ? node.windingRule : 'NONZERO' };
}

interface Remembered {
  /** Everything inside the group, as it was when the result was worked out. */
  parts: readonly DesignNode[];
  operation: BooleanOperation;
  network: VectorNetwork;
}

/** The last result for each boolean group, so that an edit elsewhere does not work it out again. */
const remembered = new Map<NodeId, Remembered>();

function sameParts(a: readonly DesignNode[], b: readonly DesignNode[]): boolean {
  return a.length === b.length && a.every((node, i) => node === b[i]);
}

const partsOf = (doc: Document, id: NodeId): DesignNode[] => getDescendantIds(doc, id).map((child) => doc.nodes[child] as DesignNode);

/**
 * Brings a boolean group up to date with its children: works out the
 * combined outline, and makes the group's box the bounding box of that
 * outline (or of the children, when nothing is left of them) without moving
 * anything on the page. Returns the same document when nothing changed.
 */
export function refreshBoolean(doc: Document, id: NodeId): Document {
  const node = doc.nodes[id];
  if (!node || node.type !== 'BOOLEAN_OPERATION') return doc;
  const parts = partsOf(doc, id);
  const known = remembered.get(id);
  let network: VectorNetwork;
  if (known && known.operation === node.operation && sameParts(known.parts, parts)) network = known.network;
  else {
    const operands: BooleanOperand[] = [];
    for (const childId of getChildIds(doc, id)) {
      const operand = outlineInParent(doc, childId);
      if (operand) operands.push(operand);
    }
    network = booleanNetworks(operands, node.operation);
  }
  // An unchanged result keeps the object the group already has, so that nothing appears to have changed.
  if (sameNetwork(network, node.network)) network = node.network;

  let bounds: Rect | null = networkBounds(network);
  if (!bounds) {
    // Nothing is left (an intersection of shapes that do not overlap): the box is that of the shapes.
    const rects: Rect[] = [];
    for (const childId of getChildIds(doc, id)) {
      const child = doc.nodes[childId];
      if (isLayer(child)) rects.push(transformedBounds(getLocalMatrix(child), child.width, child.height));
    }
    bounds = unionRects(rects);
  }
  let next = doc;
  const fits =
    !bounds ||
    (Math.abs(bounds.x) < EPSILON &&
      Math.abs(bounds.y) < EPSILON &&
      Math.abs(bounds.width - node.width) < EPSILON &&
      Math.abs(bounds.height - node.height) < EPSILON);
  if (fits || !bounds) {
    if (network !== node.network) next = patchNodes(doc, { [id]: { network } });
  } else {
    const shifted = translateNetwork(network, -bounds.x, -bounds.y);
    const center = applyToPoint(getLocalMatrix(node), { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 });
    const patches: Record<NodeId, LayerPatch> = {
      [id]: {
        x: clean(center.x - bounds.width / 2),
        y: clean(center.y - bounds.height / 2),
        width: clean(bounds.width),
        height: clean(bounds.height),
        network: shifted,
      },
    };
    for (const childId of getChildIds(doc, id)) {
      const child = doc.nodes[childId];
      if (isLayer(child)) patches[childId] = { x: clean(child.x - bounds.x), y: clean(child.y - bounds.y) };
    }
    next = patchNodes(doc, patches);
  }
  const current = next.nodes[id] as BooleanOperationNode;
  remembered.set(id, { parts: partsOf(next, id), operation: current.operation, network: current.network });
  if (remembered.size > 2000) {
    // Entries for groups that no longer exist are of no use to anyone.
    for (const key of remembered.keys()) if (!next.nodes[key]) remembered.delete(key);
  }
  return next;
}
