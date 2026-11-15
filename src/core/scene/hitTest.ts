import { isFrame, isLayer, type Document, type LayerNode, type NodeId } from '../document/schema';
import {
  convexPolygonsIntersect,
  distanceToPolygonEdge,
  distanceToSegment,
  pointInPolygon,
  rectContainsRect,
  rectToPolygon,
  type Point,
  type Rect,
} from '../math/geometry';
import { applyToPoint, invert } from '../math/matrix';
import { distanceToNetwork, pointInNetworkFill } from '../vector/network';
import { hasVisiblePaint, outlinePoints } from './shapes';
import { getAncestorIds, getChildIds, getWorldBounds, getWorldCorners, getWorldMatrix } from './tree';

function inBox(p: Point, width: number, height: number, grow: number): boolean {
  return p.x >= -grow && p.y >= -grow && p.x <= width + grow && p.y <= height + grow;
}

/**
 * Does a point in the layer's local space touch the layer's own shape?
 * `tolerance` is in page units and widens thin targets such as lines and
 * outlines so they can be clicked at any zoom level.
 */
export function hitsShape(node: LayerNode, p: Point, tolerance: number): boolean {
  const { width, height } = node;
  const filled = hasVisiblePaint(node.fills);
  const stroked = node.strokeWeight > 0 && hasVisiblePaint(node.strokes);
  // A layer with nothing painted is still selectable by its area.
  const solid = filled || !stroked;
  const edge = Math.max(tolerance, node.strokeWeight / 2);

  switch (node.type) {
    case 'FRAME':
      return inBox(p, width, height, 0);
    case 'GROUP':
      // A group is hit only through its children.
      return false;
    case 'TEXT':
      // Text is selected by its box, so it can be grabbed between the letters.
      return inBox(p, width, height, tolerance);
    case 'RECTANGLE':
      if (solid) return inBox(p, width, height, 0);
      return inBox(p, width, height, edge) && !inBox({ x: p.x - edge * 2, y: p.y - edge * 2 }, width - edge * 4, height - edge * 4, 0);
    case 'ELLIPSE': {
      const rx = width / 2;
      const ry = height / 2;
      if (rx <= 0 || ry <= 0) return inBox(p, width, height, tolerance);
      const within = (grow: number): boolean => {
        const ax = rx + grow;
        const ay = ry + grow;
        if (ax <= 0 || ay <= 0) return false;
        const nx = (p.x - rx) / ax;
        const ny = (p.y - ry) / ay;
        return nx * nx + ny * ny <= 1;
      };
      if (solid) return within(0);
      return within(edge) && !within(-edge * 2);
    }
    case 'LINE':
      return distanceToSegment(p, { x: 0, y: height / 2 }, { x: width, y: height / 2 }) <= edge;
    case 'POLYGON':
    case 'STAR': {
      const points = outlinePoints(node);
      if (!points) return false;
      if (solid && pointInPolygon(p, points)) return true;
      return distanceToPolygonEdge(p, points) <= edge;
    }
    case 'VECTOR':
      if (solid && pointInNetworkFill(node.network, p, node.windingRule)) return true;
      return distanceToNetwork(node.network, p) <= edge;
  }
}

/**
 * The top-most, deepest layer under a page-space point. Hidden and locked
 * layers, and everything inside them, are skipped. Frames that clip hide
 * whatever part of their children lies outside them.
 */
export function hitTestDeepest(doc: Document, pageId: NodeId, point: Point, tolerance = 0): NodeId | null {
  const search = (parentId: NodeId): NodeId | null => {
    const children = getChildIds(doc, parentId);
    for (let i = children.length - 1; i >= 0; i--) {
      const id = children[i] as NodeId;
      const node = doc.nodes[id];
      if (!isLayer(node) || !node.visible || node.locked) continue;
      const local = applyToPoint(invert(getWorldMatrix(doc, id)), point);
      if (node.type === 'FRAME') {
        const inside = inBox(local, node.width, node.height, 0);
        if (node.clipsContent && !inside) continue;
        const child = search(id);
        if (child) return child;
        if (inside) return id;
        continue;
      }
      if (node.type === 'GROUP') {
        const child = search(id);
        if (child) return child;
        continue;
      }
      if (hitsShape(node, local, tolerance)) return id;
    }
    return null;
  };
  return search(pageId);
}

/** The chain from the top-level layer down to `id`, excluding the page. */
function chainTo(doc: Document, id: NodeId): NodeId[] {
  const ancestors = getAncestorIds(doc, id);
  ancestors.pop(); // the page
  return [...ancestors.reverse(), id];
}

function defaultTargetIndex(doc: Document, chain: readonly NodeId[], selection: readonly NodeId[]): number {
  const first = chain[0] as NodeId;
  let index = 0;
  if (isFrame(doc.nodes[first])) {
    if (chain.length > 1) index = 1;
    else if (getChildIds(doc, first).length > 0) index = -1;
  }
  // Stay at the level the user is already working on.
  const selected = new Set(selection);
  const selectedParents = new Set<NodeId>();
  for (const id of selection) {
    const parentId = doc.nodes[id]?.parentId;
    if (parentId) selectedParents.add(parentId);
  }
  for (let i = chain.length - 1; i > index; i--) {
    const id = chain[i] as NodeId;
    const parentId = doc.nodes[id]?.parentId;
    if (selected.has(id) || (i >= 1 && parentId != null && selectedParents.has(parentId))) {
      index = i;
      break;
    }
  }
  return index;
}

export interface TargetOptions {
  tolerance?: number;
  /** Select the deepest layer (Ctrl/Cmd-click). */
  deep?: boolean;
}

/**
 * Which layer a click at `point` selects.
 * - The outermost layer under the pointer, except that a top-level frame is
 *   passed through to its direct child.
 * - The empty area of a top-level frame that has children selects nothing.
 * - A layer that shares a parent with the current selection is selected directly.
 */
export function selectionTargetAt(
  doc: Document,
  pageId: NodeId,
  point: Point,
  selection: readonly NodeId[],
  options: TargetOptions = {},
): NodeId | null {
  const hit = hitTestDeepest(doc, pageId, point, options.tolerance ?? 0);
  if (!hit) return null;
  if (options.deep) return hit;
  const chain = chainTo(doc, hit);
  const index = defaultTargetIndex(doc, chain, selection);
  return index < 0 ? null : (chain[index] as NodeId);
}

/** Which layer a double-click selects: one level deeper than a single click. */
export function deeperTargetAt(
  doc: Document,
  pageId: NodeId,
  point: Point,
  selection: readonly NodeId[],
  tolerance = 0,
): NodeId | null {
  const hit = hitTestDeepest(doc, pageId, point, tolerance);
  if (!hit) return null;
  const chain = chainTo(doc, hit);
  const index = defaultTargetIndex(doc, chain, selection);
  return chain[Math.min(index + 1, chain.length - 1)] ?? null;
}

function boxIntersectsRect(doc: Document, id: NodeId, rect: Rect): boolean {
  return convexPolygonsIntersect(getWorldCorners(doc, id), rectToPolygon(rect));
}

/**
 * Layers selected by dragging a marquee over `rect` (page space). A top-level
 * frame with children is selected only when the marquee encloses it entirely;
 * otherwise the marquee selects the frame's direct children that it touches.
 */
export function nodesInRect(doc: Document, pageId: NodeId, rect: Rect): NodeId[] {
  const out: NodeId[] = [];
  const selectable = (id: NodeId): boolean => {
    const node = doc.nodes[id];
    return isLayer(node) && node.visible && !node.locked;
  };
  for (const id of getChildIds(doc, pageId)) {
    if (!selectable(id)) continue;
    const children = getChildIds(doc, id);
    if (isFrame(doc.nodes[id]) && children.length > 0) {
      if (rectContainsRect(rect, getWorldBounds(doc, id))) out.push(id);
      else for (const childId of children) if (selectable(childId) && boxIntersectsRect(doc, childId, rect)) out.push(childId);
    } else if (boxIntersectsRect(doc, id, rect)) out.push(id);
  }
  return out;
}

/**
 * The frame or page a container ultimately sits in, looking through groups.
 * A layer inside a group "lives" in the frame around that group: dragging it
 * about within that frame must not take it out of its group.
 */
export function enclosingFrameOrPage(doc: Document, containerId: NodeId): NodeId {
  let current = containerId;
  const seen = new Set<NodeId>();
  while (!seen.has(current)) {
    seen.add(current);
    const node = doc.nodes[current];
    if (!isLayer(node) || node.type !== 'GROUP') break;
    current = node.parentId;
  }
  return current;
}

/**
 * The container a new or dragged layer should go into: the deepest visible,
 * unlocked frame under the point, or the page. Frames in `exclude` and their
 * contents are ignored, so a layer is never dropped into itself.
 */
export function containerAt(
  doc: Document,
  pageId: NodeId,
  point: Point,
  exclude: ReadonlySet<NodeId> = new Set(),
): NodeId {
  const search = (parentId: NodeId): NodeId | null => {
    const children = getChildIds(doc, parentId);
    for (let i = children.length - 1; i >= 0; i--) {
      const id = children[i] as NodeId;
      const node = doc.nodes[id];
      if (!isFrame(node) || !node.visible || node.locked || exclude.has(id)) continue;
      const local = applyToPoint(invert(getWorldMatrix(doc, id)), point);
      if (!inBox(local, node.width, node.height, 0)) continue;
      return search(id) ?? id;
    }
    return null;
  };
  return search(pageId) ?? pageId;
}
