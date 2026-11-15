import type { ArrowType, LineNode, VectorNode } from '../document/schema';
import type { Point } from '../math/geometry';
import { cubicAt, cubicDerivative, splitCubic, type Cubic } from './bezier';
import { networkGeometry, stepCubic, vertexDegree, type PathStep } from './network';

/**
 * Arrowheads: what is drawn at the loose ends of lines and open paths.
 * Everything here is geometry in the layer's own space; the renderer paints
 * it with the layer's stroke.
 */

/** A loose end of a stroke: where it is, and which way the stroke points as it arrives there. */
export interface PathEnd {
  /** Whether this is the start or the end of its run, which decides which of the layer's two arrow settings applies. */
  at: 'start' | 'end';
  point: Point;
  /** Unit vector pointing out of the path, the way an arrow there points. */
  direction: Point;
}

function unit(v: Point, fallback: Point): Point {
  const length = Math.hypot(v.x, v.y);
  if (length > 0) return { x: v.x / length, y: v.y / length };
  const other = Math.hypot(fallback.x, fallback.y);
  return other > 0 ? { x: fallback.x / other, y: fallback.y / other } : { x: 1, y: 0 };
}

/** The direction a curve is travelling in as it reaches its end. */
function arrival(c: Cubic): Point {
  return unit(cubicDerivative(c, 1), { x: c.p3.x - c.p0.x, y: c.p3.y - c.p0.y });
}

/** The runs of a vector that have a loose end, with which of their ends are loose. */
export function openRuns(node: VectorNode): { steps: PathStep[]; startLoose: boolean; endLoose: boolean }[] {
  const { network } = node;
  const out: { steps: PathStep[]; startLoose: boolean; endLoose: boolean }[] = [];
  for (const chain of networkGeometry(network).chains) {
    const first = chain.steps[0];
    const last = chain.steps[chain.steps.length - 1];
    if (chain.closed || !first || !last) continue;
    const firstSegment = network.segments[first.segment];
    const lastSegment = network.segments[last.segment];
    if (!firstSegment || !lastSegment) continue;
    const startVertex = first.reversed ? firstSegment.end : firstSegment.start;
    const endVertex = last.reversed ? lastSegment.start : lastSegment.end;
    out.push({ steps: chain.steps, startLoose: vertexDegree(network, startVertex) === 1, endLoose: vertexDegree(network, endVertex) === 1 });
  }
  return out;
}

/**
 * The loose ends of a line or a vector, where arrowheads go. A line has two.
 * A vector has one for each end of each open run that is not a branch point;
 * a run starts at the end that was drawn first.
 */
export function pathEnds(node: LineNode | VectorNode): PathEnd[] {
  if (node.type === 'LINE') {
    const y = node.height / 2;
    return [
      { at: 'start', point: { x: 0, y }, direction: { x: -1, y: 0 } },
      { at: 'end', point: { x: node.width, y }, direction: { x: 1, y: 0 } },
    ];
  }
  const ends: PathEnd[] = [];
  for (const run of openRuns(node)) {
    const first = stepCubic(node.network, run.steps[0] as PathStep);
    const last = stepCubic(node.network, run.steps[run.steps.length - 1] as PathStep);
    if (run.startLoose) {
      const along = arrival({ p0: first.p3, p1: first.p2, p2: first.p1, p3: first.p0 });
      ends.push({ at: 'start', point: first.p0, direction: along });
    }
    if (run.endLoose) ends.push({ at: 'end', point: last.p3, direction: arrival(last) });
  }
  return ends;
}

export interface ArrowShape {
  /** Corner points of the head, in the layer's space. Empty for a circle. */
  points: Point[];
  /** A filled shape, or (for the open arrow) two strokes meeting at the tip. */
  filled: boolean;
  /** For the circle: its centre and radius. */
  circle: { center: Point; radius: number } | null;
  /** How much of the stroke is cut off at this end so that it does not show through the head. */
  trim: number;
  /** How far from the end point the head reaches, for working out what the layer covers. */
  reach: number;
}

/** How much shorter a stroke is drawn at an end that has this kind of arrowhead. */
export function arrowTrim(type: ArrowType, weight: number): number {
  return type === 'TRIANGLE' ? (2.5 * weight + 5) * 0.75 : 0;
}

/** The head drawn at a loose end, sized by the stroke's weight. Null for no arrow. */
export function arrowShape(type: ArrowType, end: PathEnd, weight: number): ArrowShape | null {
  if (type === 'NONE') return null;
  const { point: tip, direction: d } = end;
  // Across the direction of travel.
  const n = { x: -d.y, y: d.x };
  const at = (back: number, side: number): Point => ({ x: tip.x - d.x * back + n.x * side, y: tip.y - d.y * back + n.y * side });
  switch (type) {
    case 'LINE': {
      const length = 3 * weight + 5;
      const half = length * 0.55;
      return { points: [at(length, -half), tip, at(length, half)], filled: false, circle: null, trim: 0, reach: Math.hypot(length, half) + weight };
    }
    case 'TRIANGLE': {
      const length = 2.5 * weight + 5;
      const half = length * 0.5;
      return { points: [tip, at(length, -half), at(length, half)], filled: true, circle: null, trim: arrowTrim(type, weight), reach: Math.hypot(length, half) };
    }
    case 'CIRCLE': {
      const radius = 1.5 * weight + 2;
      return { points: [], filled: true, circle: { center: tip, radius }, trim: 0, reach: radius };
    }
    case 'DIAMOND': {
      const radius = 2 * weight + 2.5;
      return { points: [at(-radius, 0), at(0, radius), at(radius, 0), at(0, -radius)], filled: true, circle: null, trim: 0, reach: radius };
    }
  }
}

/** The parameter at which a curve has covered `distance` from its start, measured along it. */
export function parameterAtDistance(c: Cubic, distance: number): number {
  if (distance <= 0) return 0;
  const steps = 64;
  let travelled = 0;
  let previous = c.p0;
  for (let i = 1; i <= steps; i++) {
    const p = cubicAt(c, i / steps);
    const step = Math.hypot(p.x - previous.x, p.y - previous.y);
    if (travelled + step >= distance) return (i - 1 + (step === 0 ? 0 : (distance - travelled) / step)) / steps;
    travelled += step;
    previous = p;
  }
  return 1;
}

/** A curve with `distance` cut off its start. At most nine tenths of it are cut off. */
export function trimStart(c: Cubic, distance: number): Cubic {
  const t = Math.min(0.9, parameterAtDistance(c, distance));
  return t <= 0 ? c : splitCubic(c, t)[1];
}

/** A curve with `distance` cut off its end. At most nine tenths of it are cut off. */
export function trimEnd(c: Cubic, distance: number): Cubic {
  const reversed = trimStart({ p0: c.p3, p1: c.p2, p2: c.p1, p3: c.p0 }, distance);
  return { p0: reversed.p3, p1: reversed.p2, p2: reversed.p1, p3: reversed.p0 };
}
