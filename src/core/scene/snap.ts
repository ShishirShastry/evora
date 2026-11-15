import { isFrame, isLayer, type Document, type NodeId } from '../document/schema';
import type { Point, Rect } from '../math/geometry';
import { getChildIds, getWorldBounds, getWorldRotation } from './tree';

/** A line that a moving edge can snap to, with the extent of the layer it comes from. */
interface SnapLine {
  /** Position of the line on its axis. */
  value: number;
  /** Extent of the source layer along the other axis, used to draw the guide. */
  from: number;
  to: number;
}

export interface SnapTargets {
  /** Vertical lines (constant x). */
  xs: SnapLine[];
  /** Horizontal lines (constant y). */
  ys: SnapLine[];
}

/** A guide to draw while something is snapped. Coordinates are in page space. */
export interface SnapGuide {
  /** 'x': a vertical line at x = position. 'y': a horizontal line at y = position. */
  axis: 'x' | 'y';
  position: number;
  from: number;
  to: number;
}

export const NO_TARGETS: SnapTargets = { xs: [], ys: [] };

function addRect(targets: SnapTargets, r: Rect): void {
  for (const x of [r.x, r.x + r.width / 2, r.x + r.width]) targets.xs.push({ value: x, from: r.y, to: r.y + r.height });
  for (const y of [r.y, r.y + r.height / 2, r.y + r.height]) targets.ys.push({ value: y, from: r.x, to: r.x + r.width });
}

/**
 * The lines layers can snap to inside one container: the edges and centre
 * lines of the container itself (when it is a frame) and of each of its
 * visible children, except the layers in `exclude` (the ones being moved).
 * Snapping works along the page axes, so a rotated container offers nothing.
 */
export function collectSnapTargets(doc: Document, containerId: NodeId, exclude: ReadonlySet<NodeId>): SnapTargets {
  const targets: SnapTargets = { xs: [], ys: [] };
  const container = doc.nodes[containerId];
  if (!container) return targets;
  if (isLayer(container) && getWorldRotation(doc, containerId) !== 0) return targets;
  if (isFrame(container)) addRect(targets, getWorldBounds(doc, containerId));
  for (const id of getChildIds(doc, containerId)) {
    const node = doc.nodes[id];
    if (!isLayer(node) || !node.visible || exclude.has(id)) continue;
    addRect(targets, getWorldBounds(doc, id));
  }
  return targets;
}

interface AxisSnap {
  delta: number;
  guides: { position: number; from: number; to: number }[];
}

/**
 * Finds the smallest shift that puts one of `edges` exactly on a target line,
 * if one is within `threshold`. Every target line that the shifted edges land
 * on becomes a guide, stretched to cover both the target and the moving box.
 */
function snapAxis(edges: readonly number[], lines: readonly SnapLine[], threshold: number, boxFrom: number, boxTo: number): AxisSnap {
  let best: number | null = null;
  for (const edge of edges) {
    for (const line of lines) {
      const delta = line.value - edge;
      if (Math.abs(delta) <= threshold && (best === null || Math.abs(delta) < Math.abs(best))) best = delta;
    }
  }
  if (best === null) return { delta: 0, guides: [] };
  const guides = new Map<number, { position: number; from: number; to: number }>();
  for (const edge of edges) {
    for (const line of lines) {
      if (Math.abs(line.value - (edge + best)) > 1e-6) continue;
      const existing = guides.get(line.value);
      const from = Math.min(line.from, boxFrom, existing?.from ?? Infinity);
      const to = Math.max(line.to, boxTo, existing?.to ?? -Infinity);
      guides.set(line.value, { position: line.value, from, to });
    }
  }
  return { delta: best, guides: [...guides.values()] };
}

export interface SnapResult {
  dx: number;
  dy: number;
  guides: SnapGuide[];
}

export interface SnapAxes {
  x?: boolean;
  y?: boolean;
}

/**
 * Snaps a rectangle (the bounds of what is being moved, already at its
 * un-snapped position) by its edges and centre lines. Returns how far to
 * shift it and the guides to show.
 */
export function snapRect(rect: Rect, targets: SnapTargets, threshold: number, axes: SnapAxes = { x: true, y: true }): SnapResult {
  const x: AxisSnap = axes.x
    ? snapAxis([rect.x, rect.x + rect.width / 2, rect.x + rect.width], targets.xs, threshold, rect.y, rect.y + rect.height)
    : { delta: 0, guides: [] };
  const y: AxisSnap = axes.y
    ? snapAxis([rect.y, rect.y + rect.height / 2, rect.y + rect.height], targets.ys, threshold, rect.x, rect.x + rect.width)
    : { delta: 0, guides: [] };
  return {
    dx: x.delta,
    dy: y.delta,
    guides: [
      // The moving box has shifted on the other axis too; extend guides to its snapped position.
      ...x.guides.map((g) => ({ axis: 'x' as const, position: g.position, from: Math.min(g.from, rect.y + y.delta), to: Math.max(g.to, rect.y + rect.height + y.delta) })),
      ...y.guides.map((g) => ({ axis: 'y' as const, position: g.position, from: Math.min(g.from, rect.x + x.delta), to: Math.max(g.to, rect.x + rect.width + x.delta) })),
    ],
  };
}

/** Snaps a single point, such as the corner being dragged while resizing or drawing. */
export function snapPoint(point: Point, targets: SnapTargets, threshold: number, axes: SnapAxes = { x: true, y: true }): { point: Point; guides: SnapGuide[] } {
  const x: AxisSnap = axes.x ? snapAxis([point.x], targets.xs, threshold, point.y, point.y) : { delta: 0, guides: [] };
  const y: AxisSnap = axes.y ? snapAxis([point.y], targets.ys, threshold, point.x, point.x) : { delta: 0, guides: [] };
  return {
    point: { x: point.x + x.delta, y: point.y + y.delta },
    guides: [
      ...x.guides.map((g) => ({ axis: 'x' as const, ...g })),
      ...y.guides.map((g) => ({ axis: 'y' as const, ...g })),
    ],
  };
}
