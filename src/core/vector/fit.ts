import type { VectorNode } from '../document/schema';
import { applyToPoint } from '../math/matrix';
import { clean } from '../ops/transform';
import { getLocalMatrix } from '../scene/tree';
import { networkBounds, translateNetwork } from './network';

const EPSILON = 0.001;

/**
 * A vector layer's box is always the bounding box of its curves. This returns
 * the layer with its box made so again after its points changed, without
 * moving anything on the page (also when the layer is rotated), or the same
 * object when the box already fits.
 */
export function fitVectorNode(node: VectorNode): VectorNode {
  const bounds = networkBounds(node.network);
  if (!bounds) return node.width === 0 && node.height === 0 ? node : { ...node, width: 0, height: 0 };
  if (
    Math.abs(bounds.x) < EPSILON &&
    Math.abs(bounds.y) < EPSILON &&
    Math.abs(bounds.width - node.width) < EPSILON &&
    Math.abs(bounds.height - node.height) < EPSILON
  ) {
    return node;
  }
  // The layer turns about the centre of its box, so the new centre goes where
  // the old frame of reference says the curves' centre is.
  const center = applyToPoint(getLocalMatrix(node), { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 });
  return {
    ...node,
    x: clean(center.x - bounds.width / 2),
    y: clean(center.y - bounds.height / 2),
    width: clean(bounds.width),
    height: clean(bounds.height),
    network: translateNetwork(node.network, -bounds.x, -bounds.y),
  };
}
