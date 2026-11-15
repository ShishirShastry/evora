import { isLayer, type Document, type NodeId } from '../document/schema';
import type { Rect } from '../math/geometry';
import type { SnapAxes, SnapGuide } from './snap';
import { getChildIds, getWorldBounds, getWorldRotation } from './tree';

/**
 * Distances between boxes: snapping a moving box so that the gap beside it
 * matches the gaps between its neighbours, finding the equal gaps a box sits
 * in, and measuring from one box to another. Everything is in page space and
 * along the page axes, on bounding boxes.
 */

/** A distance to show on the canvas: a straight run along one page axis. Its length is the number shown beside it. */
export interface DistanceMark {
  /** 'x': the run is horizontal, from x = from to x = to. 'y': vertical. */
  axis: 'x' | 'y';
  from: number;
  to: number;
  /** Where the run lies on the other axis. */
  at: number;
}

/** Gaps that differ by less than this are equal; boxes closer than this touch. */
const EPSILON = 0.01;

/**
 * The boxes a moving layer can be spaced against inside one container: its
 * visible children, except the ones being moved. A rotated container offers
 * none, as with snap lines.
 */
export function collectSnapRects(doc: Document, containerId: NodeId, exclude: ReadonlySet<NodeId>): Rect[] {
  const container = doc.nodes[containerId];
  if (!container) return [];
  if (isLayer(container) && getWorldRotation(doc, containerId) !== 0) return [];
  const rects: Rect[] = [];
  for (const id of getChildIds(doc, containerId)) {
    const node = doc.nodes[id];
    if (!isLayer(node) || !node.visible || exclude.has(id)) continue;
    rects.push(getWorldBounds(doc, id));
  }
  return rects;
}

/** A box seen along one axis: it runs from a to b along the axis and from c to d across it. */
interface Span {
  a: number;
  b: number;
  c: number;
  d: number;
}

function spanOf(r: Rect, axis: 'x' | 'y'): Span {
  return axis === 'x' ? { a: r.x, b: r.x + r.width, c: r.y, d: r.y + r.height } : { a: r.y, b: r.y + r.height, c: r.x, d: r.x + r.width };
}

/** The boxes in line with a box: the ones that overlap it across the axis. */
function inLineWith(box: Span, others: readonly Span[]): Span[] {
  return others.filter((other) => Math.min(other.d, box.d) - Math.max(other.c, box.c) > EPSILON);
}

/** The nearest box that ends at or before a position. */
function nearestBefore(spans: readonly Span[], edge: number): Span | null {
  let best: Span | null = null;
  for (const span of spans) if (span.b <= edge + EPSILON && (best === null || span.b > best.b)) best = span;
  return best;
}

/** The nearest box that starts at or after a position. */
function nearestAfter(spans: readonly Span[], edge: number): Span | null {
  let best: Span | null = null;
  for (const span of spans) if (span.a >= edge - EPSILON && (best === null || span.a < best.a)) best = span;
  return best;
}

/**
 * How far to shift a box along one axis so that it is evenly spaced with the
 * boxes in line with it, or null when no such place is within the threshold.
 * Three places are tried: halfway between its two neighbours, and beyond a
 * neighbour by the gap that neighbour has to the next box along.
 */
function spacingShift(box: Span, others: readonly Span[], threshold: number, whole: boolean): number | null {
  const line = inLineWith(box, others);
  const middle = (box.a + box.b) / 2;
  const size = box.b - box.a;
  // Neighbours are taken by their middles, so a box dragged a little over its neighbour still has it as one.
  const before = nearestBefore(
    line.filter((other) => (other.a + other.b) / 2 < middle),
    Infinity,
  );
  const after = nearestAfter(
    line.filter((other) => (other.a + other.b) / 2 > middle),
    -Infinity,
  );
  const places: number[] = [];
  if (before && after && after.a - before.b - size > 2 * EPSILON) places.push(before.b + (after.a - before.b - size) / 2);
  if (before) {
    const further = nearestBefore(line, before.a);
    if (further && before.a - further.b > EPSILON) places.push(before.b + (before.a - further.b));
  }
  if (after) {
    const further = nearestAfter(line, after.b);
    if (further && further.a - after.b > EPSILON) places.push(after.a - (further.a - after.b) - size);
  }
  let best: number | null = null;
  for (const place of places) {
    // On the pixel grid a place between pixels cannot be taken, so it is not offered.
    if (whole && Math.abs(place - Math.round(place)) > 1e-6) continue;
    const shift = place - box.a;
    if (Math.abs(shift) <= threshold && (best === null || Math.abs(shift) < Math.abs(best))) best = shift;
  }
  return best;
}

/**
 * Snaps a box (already at its un-snapped position) to even spacing with the
 * boxes around it. Each axis is null when there is nothing to snap to on it.
 * `whole` leaves out places that are not on whole pixels.
 */
export function snapSpacing(
  rect: Rect,
  others: readonly Rect[],
  threshold: number,
  axes: SnapAxes = { x: true, y: true },
  whole = false,
): { dx: number | null; dy: number | null } {
  return {
    dx: axes.x
      ? spacingShift(
          spanOf(rect, 'x'),
          others.map((r) => spanOf(r, 'x')),
          threshold,
          whole,
        )
      : null,
    dy: axes.y
      ? spacingShift(
          spanOf(rect, 'y'),
          others.map((r) => spanOf(r, 'y')),
          threshold,
          whole,
        )
      : null,
  };
}

function marksAlong(rect: Rect, others: readonly Rect[], axis: 'x' | 'y'): DistanceMark[] {
  const box = spanOf(rect, axis);
  const line = inLineWith(
    box,
    others.map((r) => spanOf(r, axis)),
  );
  const before = nearestBefore(line, box.a);
  const after = nearestAfter(line, box.b);
  const gapBefore = before ? box.a - before.b : 0;
  const gapAfter = after ? after.a - box.b : 0;
  // The gap between two boxes, drawn through the middle of where they face each other.
  const mark = (p: Span, q: Span): DistanceMark => ({ axis, from: p.b, to: q.a, at: (Math.max(p.c, q.c) + Math.min(p.d, q.d)) / 2 });
  // The equal gaps that carry on beyond a neighbour, away from the box.
  const chain = (start: Span, gap: number, direction: -1 | 1): DistanceMark[] => {
    const marks: DistanceMark[] = [];
    let current = start;
    for (let guard = 0; guard < 64; guard++) {
      const next = direction < 0 ? nearestBefore(line, current.a) : nearestAfter(line, current.b);
      if (!next || next === current) break;
      const between = direction < 0 ? current.a - next.b : next.a - current.b;
      if (Math.abs(between - gap) > EPSILON) break;
      marks.push(direction < 0 ? mark(next, current) : mark(current, next));
      current = next;
    }
    return marks;
  };
  const chainBefore = before && gapBefore > EPSILON ? chain(before, gapBefore, -1) : [];
  const chainAfter = after && gapAfter > EPSILON ? chain(after, gapAfter, 1) : [];
  const centred = before !== null && after !== null && gapBefore > EPSILON && Math.abs(gapBefore - gapAfter) <= EPSILON;
  const marks: DistanceMark[] = [];
  if (before && (centred || chainBefore.length > 0)) marks.push(...chainBefore.reverse(), mark(before, box));
  if (after && (centred || chainAfter.length > 0)) marks.push(mark(box, after), ...chainAfter);
  return marks;
}

/**
 * The equal gaps a box sits in, among the boxes in line with it: the gap on
 * each side when they match, and the gaps between its neighbours that match
 * the one beside it. In order along each axis, x first. Empty when the box is
 * not evenly spaced with anything.
 */
export function spacingMarks(rect: Rect, others: readonly Rect[]): DistanceMark[] {
  return [...marksAlong(rect, others, 'x'), ...marksAlong(rect, others, 'y')];
}

function measureAlong(from: Rect, to: Rect, axis: 'x' | 'y'): { marks: DistanceMark[]; guides: SnapGuide[] } {
  const s = spanOf(from, axis);
  const t = spanOf(to, axis);
  // Through the middle of where the boxes face each other; where they do not, through the middle of the first.
  const facing = Math.min(s.d, t.d) - Math.max(s.c, t.c) > EPSILON;
  const at = facing ? (Math.max(s.c, t.c) + Math.min(s.d, t.d)) / 2 : (s.c + s.d) / 2;
  const marks: DistanceMark[] = [];
  const guides: SnapGuide[] = [];
  const add = (a: number, b: number, edgeOfOther: number): void => {
    if (Math.abs(b - a) <= EPSILON) return;
    marks.push({ axis, from: Math.min(a, b), to: Math.max(a, b), at });
    // The run stops at the other box's edge; where that edge does not reach it, the edge is carried on to it.
    if (!facing) guides.push({ axis, position: edgeOfOther, from: Math.min(at, at < t.c ? t.c : t.d), to: Math.max(at, at < t.c ? t.c : t.d) });
  };
  if (t.b <= s.a + EPSILON) add(t.b, s.a, t.b);
  else if (t.a >= s.b - EPSILON) add(s.b, t.a, t.a);
  else {
    // They overlap along this axis: how far each edge of one is from the same edge of the other.
    add(t.a, s.a, t.a);
    add(s.b, t.b, t.b);
  }
  return { marks, guides };
}

/**
 * The distances from one box to another: between the edges that face each
 * other where they are apart, and from each edge to the same edge of the
 * other where they overlap (which, for a box inside another, is how far it is
 * from each side). `guides` carry an edge of the second box on to a run that
 * it does not reach.
 */
export function measureDistances(from: Rect, to: Rect): { marks: DistanceMark[]; guides: SnapGuide[] } {
  const x = measureAlong(from, to, 'x');
  const y = measureAlong(from, to, 'y');
  return { marks: [...x.marks, ...y.marks], guides: [...x.guides, ...y.guides] };
}
