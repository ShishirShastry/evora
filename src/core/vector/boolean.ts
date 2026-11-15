import type { VectorNetwork, VectorSegment, VectorVertex, WindingRule } from '../document/schema';
import type { Point } from '../math/geometry';
import { cubicAt, cubicBounds, cubicDerivative, flattenCubic, isStraight, reverseCubic, splitCubic, type Cubic } from './bezier';
import { networkGeometry, stepCubic } from './network';

/**
 * Boolean operations on shapes bounded by Bézier curves.
 *
 * Every outline is cut wherever it crosses another. Each resulting piece
 * then either separates the inside of the result from its outside, in which
 * case it is part of the result's outline, or it does not, in which case it
 * is dropped. The pieces that are kept are strung together into closed
 * outlines. Curves stay curves: nothing is turned into straight lines.
 */

export type BooleanOperation = 'UNION' | 'SUBTRACT' | 'INTERSECT' | 'EXCLUDE';
export const BOOLEAN_OPERATIONS: readonly BooleanOperation[] = ['UNION', 'SUBTRACT', 'INTERSECT', 'EXCLUDE'];

/** One of the shapes an operation combines: its outline, and which parts of it count as inside. */
export interface BooleanOperand {
  network: VectorNetwork;
  windingRule: WindingRule;
}

const cross = (a: Point, b: Point): number => a.x * b.y - a.y * b.x;
const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
const dist = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

/** A stretch of a curve that is nearly straight, with the parameters it runs between. */
interface Piece {
  t0: number;
  t1: number;
  a: Point;
  b: Point;
}

/** Cuts a curve into nearly straight pieces, remembering where on the curve each one is. */
function pieces(c: Cubic): Piece[] {
  if (isStraight(c)) return [{ t0: 0, t1: 1, a: c.p0, b: c.p3 }];
  const out: Piece[] = [];
  const flat = (curve: Cubic): boolean => {
    const chord = sub(curve.p3, curve.p0);
    const length = Math.hypot(chord.x, chord.y);
    if (length === 0) return dist(curve.p1, curve.p0) < 0.01 && dist(curve.p2, curve.p0) < 0.01;
    return Math.abs(cross(sub(curve.p1, curve.p0), chord)) / length < 0.01 && Math.abs(cross(sub(curve.p2, curve.p0), chord)) / length < 0.01;
  };
  const walk = (curve: Cubic, t0: number, t1: number, depth: number): void => {
    // The first cut is always made, so that a curve that returns to where it started is not taken for a point.
    if (depth > 0 && (depth >= 10 || flat(curve))) {
      out.push({ t0, t1, a: curve.p0, b: curve.p3 });
      return;
    }
    const [left, right] = splitCubic(curve, 0.5);
    const middle = (t0 + t1) / 2;
    walk(left, t0, middle, depth + 1);
    walk(right, middle, t1, depth + 1);
  };
  walk(c, 0, 1, 0);
  return out;
}

/**
 * The parameter at which a straight segment, stored as a curve, has covered
 * the fraction `f` of its length. (Such a curve starts and ends slowly.)
 */
function straightParameter(f: number): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 50; i++) {
    const t = (lo + hi) / 2;
    if (3 * t * t - 2 * t * t * t < f) lo = t;
    else hi = t;
  }
  return (lo + hi) / 2;
}

export interface CurveCrossing {
  /** Parameter on the first curve. */
  s: number;
  /** Parameter on the second curve. */
  t: number;
  point: Point;
}

/**
 * Where two curves meet. Crossings are found on straightened pieces of the
 * curves and then sharpened on the curves themselves. Two straight segments
 * that lie along each other are reported at the ends of their overlap.
 * Curves that merely touch, or that lie along each other, may be missed.
 */
export function intersectCubics(a: Cubic, b: Cubic): CurveCrossing[] {
  const boundsA = cubicBounds(a);
  const boundsB = cubicBounds(b);
  const slack = 1e-6;
  if (
    boundsA.x > boundsB.x + boundsB.width + slack ||
    boundsB.x > boundsA.x + boundsA.width + slack ||
    boundsA.y > boundsB.y + boundsB.height + slack ||
    boundsB.y > boundsA.y + boundsA.height + slack
  ) {
    return [];
  }
  const straightA = isStraight(a);
  const straightB = isStraight(b);
  const parameter = (piece: Piece, f: number, straight: boolean): number => (straight ? straightParameter(f) : piece.t0 + (piece.t1 - piece.t0) * f);
  const found: CurveCrossing[] = [];

  const sharpen = (s: number, t: number): CurveCrossing => {
    const start = dist(cubicAt(a, s), cubicAt(b, t));
    let bestS = s;
    let bestT = t;
    let best = start;
    for (let i = 0; i < 12 && best > 1e-11; i++) {
      const d = sub(cubicAt(a, s), cubicAt(b, t));
      const da = cubicDerivative(a, s);
      const db = cubicDerivative(b, t);
      const determinant = db.x * da.y - da.x * db.y;
      if (Math.abs(determinant) < 1e-14) break;
      s = Math.min(1, Math.max(0, s + (d.x * db.y - db.x * d.y) / determinant));
      t = Math.min(1, Math.max(0, t + (d.x * da.y - da.x * d.y) / determinant));
      const now = dist(cubicAt(a, s), cubicAt(b, t));
      if (now < best) {
        best = now;
        bestS = s;
        bestT = t;
      }
    }
    return { s: bestS, t: bestT, point: cubicAt(a, bestS) };
  };

  const add = (s: number, t: number): void => {
    const hit = sharpen(Math.min(1, Math.max(0, s)), Math.min(1, Math.max(0, t)));
    if (!found.some((other) => dist(other.point, hit.point) < 1e-6 && Math.abs(other.s - hit.s) < 1e-4 && Math.abs(other.t - hit.t) < 1e-4)) found.push(hit);
  };

  const piecesA = pieces(a);
  const piecesB = pieces(b);
  const edge = 1e-9;
  for (const p of piecesA) {
    const r = sub(p.b, p.a);
    const minX = Math.min(p.a.x, p.b.x) - slack;
    const maxX = Math.max(p.a.x, p.b.x) + slack;
    const minY = Math.min(p.a.y, p.b.y) - slack;
    const maxY = Math.max(p.a.y, p.b.y) + slack;
    for (const q of piecesB) {
      if (Math.max(q.a.x, q.b.x) < minX || Math.min(q.a.x, q.b.x) > maxX || Math.max(q.a.y, q.b.y) < minY || Math.min(q.a.y, q.b.y) > maxY) continue;
      const d = sub(q.b, q.a);
      const denominator = cross(r, d);
      const offset = sub(q.a, p.a);
      const lengths = Math.hypot(r.x, r.y) * Math.hypot(d.x, d.y);
      if (lengths === 0) continue;
      if (Math.abs(denominator) <= 1e-10 * lengths) {
        // Parallel. Two straight segments along the same line meet at the ends of their overlap.
        if (!straightA || !straightB || Math.abs(cross(offset, r)) > 1e-7 * Math.hypot(r.x, r.y)) continue;
        const rr = r.x * r.x + r.y * r.y;
        const dd = d.x * d.x + d.y * d.y;
        const along = (point: Point): number => ((point.x - p.a.x) * r.x + (point.y - p.a.y) * r.y) / rr;
        const alongOther = (point: Point): number => ((point.x - q.a.x) * d.x + (point.y - q.a.y) * d.y) / dd;
        for (const [point, t] of [
          [q.a, 0],
          [q.b, 1],
        ] as const) {
          const u = along(point);
          if (u >= -edge && u <= 1 + edge) add(straightParameter(u), t);
        }
        for (const [point, s] of [
          [p.a, 0],
          [p.b, 1],
        ] as const) {
          const v = alongOther(point);
          if (v >= -edge && v <= 1 + edge) add(s, straightParameter(v));
        }
        continue;
      }
      const u = cross(offset, d) / denominator;
      const v = cross(offset, r) / denominator;
      if (u < -edge || u > 1 + edge || v < -edge || v > 1 + edge) continue;
      add(parameter(p, Math.min(1, Math.max(0, u)), straightA), parameter(q, Math.min(1, Math.max(0, v)), straightB));
    }
  }
  return found;
}

/** Cuts a curve at the given parameters, which must be in ascending order and strictly between 0 and 1. */
function cutCurve(c: Cubic, parameters: readonly number[]): Cubic[] {
  if (parameters.length === 0) return [c];
  if (isStraight(c)) {
    // Straight stays straight: the cuts are points on the line.
    const stops = [c.p0, ...parameters.map((t) => cubicAt(c, t)), c.p3];
    return stops.slice(1).map((p, i) => ({ p0: stops[i] as Point, p1: stops[i] as Point, p2: p, p3: p }));
  }
  const out: Cubic[] = [];
  let rest = c;
  let done = 0;
  for (const t of parameters) {
    const [left, right] = splitCubic(rest, (t - done) / (1 - done));
    out.push(left);
    rest = right;
    done = t;
  }
  out.push(rest);
  return out;
}

/** Even-odd and winding counts of a point against a set of polygons. */
function inside(polygons: readonly Point[][], p: Point, rule: WindingRule): boolean {
  let winding = 0;
  let odd = false;
  for (const polygon of polygons) {
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const a = polygon[j] as Point;
      const b = polygon[i] as Point;
      if (a.y > p.y === b.y > p.y) continue;
      if (p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
        odd = !odd;
        winding += b.y > a.y ? 1 : -1;
      }
    }
  }
  return rule === 'EVENODD' ? odd : winding !== 0;
}

interface Shape {
  /** Everything that bounds the shape, including the straight lines that close its open paths. */
  outline: Cubic[];
  polygons: Point[][];
  rule: WindingRule;
}

function shapeOf(operand: BooleanOperand): Shape {
  const { network } = operand;
  const geometry = networkGeometry(network);
  const outline: Cubic[] = network.segments.map((_, index) => stepCubic(network, { segment: index, reversed: false }));
  const polygons: Point[][] = [];
  for (const loop of geometry.loops) {
    const points: Point[] = [];
    loop.forEach((step, i) => {
      const c = stepCubic(network, step);
      if (i === 0) points.push(c.p0);
      flattenCubic(c, 0.002, points);
    });
    polygons.push(points);
    // A path that is filled as if a straight line closed it is bounded by that line too.
    const first = points[0];
    const last = points[points.length - 1];
    if (first && last && dist(first, last) > 1e-9) outline.push({ p0: last, p1: last, p2: first, p3: first });
  }
  return { outline, polygons, rule: operand.windingRule };
}

/** A direction a little way along a curve from its start, as an angle. */
function departure(c: Cubic): number {
  let p = cubicAt(c, 0.02);
  if (p.x === c.p0.x && p.y === c.p0.y) p = c.p3;
  return Math.atan2(p.y - c.p0.y, p.x - c.p0.x);
}

/** How far the inside of the result is probed on either side of a piece of outline. */
const PROBE = 0.01;

/**
 * Combines shapes. `UNION` is everything inside any of them, `INTERSECT`
 * what is inside all of them, `SUBTRACT` the first with the others taken
 * out of it, and `EXCLUDE` what is inside an odd number of them. The result
 * is made of closed outlines that run with the inside on the same side, so
 * that an outline inside another is a hole under either fill rule.
 */
export function booleanNetworks(operands: readonly BooleanOperand[], operation: BooleanOperation): VectorNetwork {
  const shapes = operands.map(shapeOf);
  const within = (p: Point): boolean => {
    const flags = shapes.map((shape) => inside(shape.polygons, p, shape.rule));
    switch (operation) {
      case 'UNION':
        return flags.some(Boolean);
      case 'INTERSECT':
        return flags.length > 0 && flags.every(Boolean);
      case 'SUBTRACT':
        return flags[0] === true && !flags.slice(1).some(Boolean);
      case 'EXCLUDE':
        return flags.filter(Boolean).length % 2 === 1;
    }
  };

  // 1. Cut every piece of outline wherever another crosses it.
  const curves = shapes.flatMap((shape) => shape.outline);
  const cuts: number[][] = curves.map(() => []);
  for (let i = 0; i < curves.length; i++) {
    for (let j = i + 1; j < curves.length; j++) {
      for (const hit of intersectCubics(curves[i] as Cubic, curves[j] as Cubic)) {
        (cuts[i] as number[]).push(hit.s);
        (cuts[j] as number[]).push(hit.t);
      }
    }
  }
  const parts: Cubic[] = [];
  curves.forEach((curve, i) => {
    const sorted = [...(cuts[i] as number[])].sort((x, y) => x - y);
    const parameters: number[] = [];
    for (const t of sorted) {
      if (t <= 1e-7 || t >= 1 - 1e-7) continue;
      if (parameters.length === 0 || t - (parameters[parameters.length - 1] as number) > 1e-7) parameters.push(t);
    }
    for (const part of cutCurve(curve, parameters)) if (dist(part.p0, part.p3) > 1e-6 || !isStraight(part)) parts.push(part);
  });

  // 2. Keep the pieces that have the result on one side only, turned so that it is on their left.
  const kept: Cubic[] = [];
  for (const part of parts) {
    const middle = cubicAt(part, 0.5);
    let direction = cubicDerivative(part, 0.5);
    if (direction.x === 0 && direction.y === 0) direction = sub(part.p3, part.p0);
    const length = Math.hypot(direction.x, direction.y);
    if (length === 0) continue;
    const normal = { x: (-direction.y / length) * PROBE, y: (direction.x / length) * PROBE };
    const left = within({ x: middle.x + normal.x, y: middle.y + normal.y });
    const right = within({ x: middle.x - normal.x, y: middle.y - normal.y });
    if (left === right) continue;
    kept.push(left ? part : reverseCubic(part));
  }

  // 3. Give every end point an identity, so that pieces that meet can be found.
  const cell = 1e-3;
  const grid = new Map<string, number[]>();
  const positions: Point[] = [];
  const pointId = (p: Point): number => {
    const cx = Math.floor(p.x / cell);
    const cy = Math.floor(p.y / cell);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const id of grid.get(`${cx + dx},${cy + dy}`) ?? []) if (dist(positions[id] as Point, p) < 2e-4) return id;
      }
    }
    const id = positions.length;
    positions.push(p);
    const key = `${cx},${cy}`;
    const list = grid.get(key);
    if (list) list.push(id);
    else grid.set(key, [id]);
    return id;
  };
  interface Edge {
    curve: Cubic;
    from: number;
    to: number;
    out: number;
    back: number;
    used: boolean;
  }
  const edges: Edge[] = [];
  for (const curve of kept) {
    const from = pointId(curve.p0);
    const to = pointId(curve.p3);
    const middle = cubicAt(curve, 0.5);
    // Two outlines that run along each other leave the same piece twice; one is enough.
    if (edges.some((other) => other.from === from && other.to === to && dist(cubicAt(other.curve, 0.5), middle) < 1e-3)) continue;
    edges.push({ curve, from, to, out: departure(curve), back: departure(reverseCubic(curve)), used: false });
  }
  const leaving = new Map<number, Edge[]>();
  for (const edge of edges) {
    const list = leaving.get(edge.from);
    if (list) list.push(edge);
    else leaving.set(edge.from, [edge]);
  }

  // 4. String the pieces into closed outlines. Where several pieces leave a
  // point, the one to follow is the first round from the piece just arrived
  // by, on the side the inside is on: that keeps to the outline of one region.
  const vertices: VectorVertex[] = [];
  const segments: VectorSegment[] = [];
  const turn = (from: number, to: number): number => {
    const angle = (from - to) % (Math.PI * 2);
    return angle <= 1e-12 ? angle + Math.PI * 2 : angle;
  };
  for (const first of edges) {
    if (first.used) continue;
    const outline: Edge[] = [];
    let edge: Edge | undefined = first;
    while (edge && !edge.used) {
      edge.used = true;
      outline.push(edge);
      const arrived: Edge = edge;
      const options = (leaving.get(arrived.to) ?? []).filter((candidate) => !candidate.used || candidate === first);
      edge = undefined;
      let best = Infinity;
      for (const candidate of options) {
        const angle = turn(arrived.back, candidate.out);
        if (angle < best) {
          best = angle;
          edge = candidate;
        }
      }
    }
    // An outline that does not come back to its start is the debris of curves that only touched; leave it out.
    if (edge !== first) continue;
    const base = vertices.length;
    // Crossings are found numerically; a millionth of a unit is as fine as the result is kept.
    const tidy = (value: number): number => Math.round(value * 1e6) / 1e6 + 0;
    outline.forEach((piece, i) => {
      const { curve } = piece;
      vertices.push({ x: tidy(curve.p0.x), y: tidy(curve.p0.y) });
      segments.push({
        start: base + i,
        end: base + ((i + 1) % outline.length),
        tangentStart: { x: tidy(curve.p1.x - curve.p0.x), y: tidy(curve.p1.y - curve.p0.y) },
        tangentEnd: { x: tidy(curve.p2.x - curve.p3.x), y: tidy(curve.p2.y - curve.p3.y) },
      });
    });
  }
  return { vertices, segments };
}
