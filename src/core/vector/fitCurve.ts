import type { VectorNetwork } from '../document/schema';
import type { Point } from '../math/geometry';
import { cubicAt, type Cubic } from './bezier';
import { NetworkBuilder } from './network';

/**
 * Fitting smooth curves to a hand-drawn stroke. This is Philip Schneider's
 * algorithm ("An Algorithm for Automatically Fitting Digitized Curves",
 * Graphics Gems, 1990): fit one Bézier curve to the points by least squares;
 * if some point is too far from it, improve the fit a few times, and failing
 * that split the points where the fit is worst and fit each half, keeping
 * the two halves smooth where they meet.
 */

const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: Point, b: Point): Point => ({ x: a.x + b.x, y: a.y + b.y });
const scale = (a: Point, s: number): Point => ({ x: a.x * s, y: a.y * s });
const dot = (a: Point, b: Point): number => a.x * b.x + a.y * b.y;
const length = (a: Point): number => Math.hypot(a.x, a.y);

function normalize(a: Point): Point {
  const l = length(a);
  return l === 0 ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l };
}

/** Each point's position along the run from `first` to `last`, by distance travelled, from 0 to 1. */
function chordLengths(points: readonly Point[], first: number, last: number): number[] {
  const u = [0];
  for (let i = first + 1; i <= last; i++) u.push((u[i - first - 1] as number) + length(sub(points[i] as Point, points[i - 1] as Point)));
  const total = u[u.length - 1] as number;
  return u.map((value) => (total === 0 ? 0 : value / total));
}

/** The curve from `points[first]` to `points[last]`, leaving along `tangent1` and arriving along `-tangent2`, that best fits the points between at parameters `u`. */
function generate(points: readonly Point[], first: number, last: number, u: readonly number[], tangent1: Point, tangent2: Point): Cubic {
  const p0 = points[first] as Point;
  const p3 = points[last] as Point;
  let c00 = 0;
  let c01 = 0;
  let c11 = 0;
  let x0 = 0;
  let x1 = 0;
  for (let i = 0; i <= last - first; i++) {
    const t = u[i] as number;
    const s = 1 - t;
    const b0 = s * s * s;
    const b1 = 3 * t * s * s;
    const b2 = 3 * t * t * s;
    const b3 = t * t * t;
    const a0 = scale(tangent1, b1);
    const a1 = scale(tangent2, b2);
    c00 += dot(a0, a0);
    c01 += dot(a0, a1);
    c11 += dot(a1, a1);
    const rest = sub(points[first + i] as Point, add(scale(p0, b0 + b1), scale(p3, b2 + b3)));
    x0 += dot(a0, rest);
    x1 += dot(a1, rest);
  }
  const determinant = c00 * c11 - c01 * c01;
  const alpha1 = determinant === 0 ? 0 : (x0 * c11 - x1 * c01) / determinant;
  const alpha2 = determinant === 0 ? 0 : (c00 * x1 - c01 * x0) / determinant;
  const span = length(sub(p3, p0));
  const tiny = 1e-6 * span;
  if (alpha1 < tiny || alpha2 < tiny) {
    // The least-squares answer is degenerate: fall back on handles a third of the way along.
    return { p0, p1: add(p0, scale(tangent1, span / 3)), p2: add(p3, scale(tangent2, span / 3)), p3 };
  }
  return { p0, p1: add(p0, scale(tangent1, alpha1)), p2: add(p3, scale(tangent2, alpha2)), p3 };
}

/** One step of Newton's method towards the parameter at which the curve is closest to `p`. */
function closerParameter(c: Cubic, p: Point, t: number): number {
  const q = cubicAt(c, t);
  const d1 = [scale(sub(c.p1, c.p0), 3), scale(sub(c.p2, c.p1), 3), scale(sub(c.p3, c.p2), 3)] as const;
  const d2 = [scale(sub(d1[1], d1[0]), 2), scale(sub(d1[2], d1[1]), 2)] as const;
  const s = 1 - t;
  const q1 = add(add(scale(d1[0], s * s), scale(d1[1], 2 * s * t)), scale(d1[2], t * t));
  const q2 = add(scale(d2[0], s), scale(d2[1], t));
  const offset = sub(q, p);
  const denominator = dot(q1, q1) + dot(offset, q2);
  if (denominator === 0) return t;
  return Math.min(1, Math.max(0, t - dot(offset, q1) / denominator));
}

/** The largest squared distance from a point to the curve at its parameter, and which point that is. */
function worstFit(points: readonly Point[], first: number, last: number, c: Cubic, u: readonly number[]): { error: number; index: number } {
  let error = 0;
  let index = Math.floor((first + last + 1) / 2);
  for (let i = first + 1; i < last; i++) {
    const d = sub(cubicAt(c, u[i - first] as number), points[i] as Point);
    const squared = dot(d, d);
    if (squared >= error) {
      error = squared;
      index = i;
    }
  }
  return { error, index };
}

function fit(points: readonly Point[], first: number, last: number, tangent1: Point, tangent2: Point, tolerance: number, out: Cubic[], depth: number): void {
  const p0 = points[first] as Point;
  const p3 = points[last] as Point;
  if (last - first === 1) {
    const reach = length(sub(p3, p0)) / 3;
    out.push({ p0, p1: add(p0, scale(tangent1, reach)), p2: add(p3, scale(tangent2, reach)), p3 });
    return;
  }
  const limit = tolerance * tolerance;
  let u = chordLengths(points, first, last);
  let curve = generate(points, first, last, u, tangent1, tangent2);
  let worst = worstFit(points, first, last, curve, u);
  if (worst.error <= limit) {
    out.push(curve);
    return;
  }
  // Close enough to be worth improving: move each point's parameter to where
  // the curve is nearest, and fit again, for as long as that keeps helping.
  if (worst.error <= limit * 100) {
    let previous = worst.error;
    for (let pass = 0; pass < 8; pass++) {
      u = u.map((t, i) => closerParameter(curve, points[first + i] as Point, t));
      curve = generate(points, first, last, u, tangent1, tangent2);
      worst = worstFit(points, first, last, curve, u);
      if (worst.error <= limit) {
        out.push(curve);
        return;
      }
      if (worst.error >= previous) break;
      previous = worst.error;
    }
  }
  if (depth > 40) {
    out.push(curve);
    return;
  }
  // Split at the worst point. Both halves leave it along the same line, so the join is smooth.
  const split = worst.index;
  const before = sub(points[split - 1] as Point, points[split] as Point);
  const after = sub(points[split] as Point, points[split + 1] as Point);
  let centre = normalize(add(before, after));
  if (centre.x === 0 && centre.y === 0) centre = normalize(before);
  fit(points, first, split, tangent1, centre, tolerance, out, depth + 1);
  fit(points, split, last, { x: -centre.x, y: -centre.y }, tangent2, tolerance, out, depth + 1);
}

/**
 * Curves that pass within `tolerance` of every one of `points`, in order,
 * starting at the first and ending at the last. Fewer than two distinct
 * points give no curve.
 */
export function fitCurve(points: readonly Point[], tolerance: number): Cubic[] {
  const distinct: Point[] = [];
  for (const p of points) {
    const previous = distinct[distinct.length - 1];
    if (!previous || length(sub(p, previous)) > 1e-9) distinct.push(p);
  }
  if (distinct.length < 2) return [];
  const n = distinct.length;
  const first = distinct[0] as Point;
  const last = distinct[n - 1] as Point;
  if (n === 2) return [{ p0: first, p1: first, p2: last, p3: last }];
  const out: Cubic[] = [];
  fit(distinct, 0, n - 1, normalize(sub(distinct[1] as Point, first)), normalize(sub(distinct[n - 2] as Point, last)), Math.max(tolerance, 1e-6), out, 0);
  return out;
}

/**
 * Turns a stroke drawn by hand into a path of smooth curves that stays
 * within `tolerance` of the stroke. A stroke that ends within
 * `closeDistance` of where it began, having gone further away than that in
 * between, becomes a closed shape. Coordinates are kept to a hundredth.
 */
export function networkFromStroke(points: readonly Point[], tolerance: number, closeDistance = 0): VectorNetwork {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return { vertices: [], segments: [] };
  const wandered = points.some((p) => length(sub(p, first)) > closeDistance * 2);
  const closes = closeDistance > 0 && points.length > 3 && wandered && length(sub(last, first)) <= closeDistance;
  const curves = fitCurve(closes ? [...points, first] : points, tolerance);
  // (Adding zero turns a -0 left by rounding into a plain 0.)
  const round = (p: Point): Point => ({ x: Math.round(p.x * 100) / 100 + 0, y: Math.round(p.y * 100) / 100 + 0 });
  const path = new NetworkBuilder();
  curves.forEach((curve, i) => {
    const p0 = round(curve.p0);
    const p3 = round(curve.p3);
    if (i === 0) path.moveTo(p0.x, p0.y);
    const p1 = round(curve.p1);
    const p2 = round(curve.p2);
    if (p1.x === p0.x && p1.y === p0.y && p2.x === p3.x && p2.y === p3.y) path.lineTo(p3.x, p3.y);
    else path.curveTo(p1.x, p1.y, p2.x, p2.y, p3.x, p3.y);
  });
  if (closes) path.close();
  return path.build();
}
