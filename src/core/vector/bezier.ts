import type { Point, Rect } from '../math/geometry';

/** A cubic Bézier curve. A straight line is a cubic whose control points sit on its end points. */
export interface Cubic {
  p0: Point;
  p1: Point;
  p2: Point;
  p3: Point;
}

const lerp = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

/** The point on the curve at parameter `t` (0 at `p0`, 1 at `p3`). */
export function cubicAt(c: Cubic, t: number): Point {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const d = 3 * u * t * t;
  const e = t * t * t;
  return { x: a * c.p0.x + b * c.p1.x + d * c.p2.x + e * c.p3.x, y: a * c.p0.y + b * c.p1.y + d * c.p2.y + e * c.p3.y };
}

/** The direction of travel at parameter `t` (not normalised; zero for a degenerate curve). */
export function cubicDerivative(c: Cubic, t: number): Point {
  const u = 1 - t;
  const a = 3 * u * u;
  const b = 6 * u * t;
  const d = 3 * t * t;
  return {
    x: a * (c.p1.x - c.p0.x) + b * (c.p2.x - c.p1.x) + d * (c.p3.x - c.p2.x),
    y: a * (c.p1.y - c.p0.y) + b * (c.p2.y - c.p1.y) + d * (c.p3.y - c.p2.y),
  };
}

/** Splits a curve at `t` into two curves that together trace exactly the same shape (de Casteljau). */
export function splitCubic(c: Cubic, t: number): [Cubic, Cubic] {
  const ab = lerp(c.p0, c.p1, t);
  const bc = lerp(c.p1, c.p2, t);
  const cd = lerp(c.p2, c.p3, t);
  const abc = lerp(ab, bc, t);
  const bcd = lerp(bc, cd, t);
  const mid = lerp(abc, bcd, t);
  return [
    { p0: c.p0, p1: ab, p2: abc, p3: mid },
    { p0: mid, p1: bcd, p2: cd, p3: c.p3 },
  ];
}

export function reverseCubic(c: Cubic): Cubic {
  return { p0: c.p3, p1: c.p2, p2: c.p1, p3: c.p0 };
}

/** True when both control points coincide with their end points, so the curve is a straight line. */
export function isStraight(c: Cubic): boolean {
  return c.p1.x === c.p0.x && c.p1.y === c.p0.y && c.p2.x === c.p3.x && c.p2.y === c.p3.y;
}

/** Roots in (0, 1) of the derivative of one coordinate of a cubic, where that coordinate is at an extreme. */
function extrema(p0: number, p1: number, p2: number, p3: number): number[] {
  // Derivative coefficients of a*t² + b*t + c.
  const a = -p0 + 3 * p1 - 3 * p2 + p3;
  const b = 2 * (p0 - 2 * p1 + p2);
  const c = p1 - p0;
  const out: number[] = [];
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) > 1e-12) out.push(-c / b);
  } else {
    const discriminant = b * b - 4 * a * c;
    if (discriminant >= 0) {
      const root = Math.sqrt(discriminant);
      out.push((-b + root) / (2 * a), (-b - root) / (2 * a));
    }
  }
  // A turning point at an end of the curve is the end point itself, which the caller already has.
  return out.filter((t) => t > 1e-9 && t < 1 - 1e-9);
}

/** The exact bounding box of a curve: its end points and wherever it turns back along x or y. */
export function cubicBounds(c: Cubic): Rect {
  let minX = Math.min(c.p0.x, c.p3.x);
  let maxX = Math.max(c.p0.x, c.p3.x);
  let minY = Math.min(c.p0.y, c.p3.y);
  let maxY = Math.max(c.p0.y, c.p3.y);
  if (!isStraight(c)) {
    for (const t of [...extrema(c.p0.x, c.p1.x, c.p2.x, c.p3.x), ...extrema(c.p0.y, c.p1.y, c.p2.y, c.p3.y)]) {
      const p = cubicAt(c, t);
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function distanceToLine(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / length;
}

/**
 * Appends a polyline approximation of the curve to `out`: every point after
 * `p0` up to and including `p3`. The polyline is never further than
 * `tolerance` from the true curve.
 */
export function flattenCubic(c: Cubic, tolerance: number, out: Point[], depth = 0): void {
  if (
    depth >= 16 ||
    isStraight(c) ||
    (distanceToLine(c.p1, c.p0, c.p3) <= tolerance && distanceToLine(c.p2, c.p0, c.p3) <= tolerance)
  ) {
    out.push(c.p3);
    return;
  }
  const [left, right] = splitCubic(c, 0.5);
  flattenCubic(left, tolerance, out, depth + 1);
  flattenCubic(right, tolerance, out, depth + 1);
}

/** The point on a curve nearest to `p`, found by coarse sampling and then refining around the best sample. */
export function nearestOnCubic(c: Cubic, p: Point): { t: number; point: Point; distance: number } {
  const distanceAt = (t: number): number => {
    const q = cubicAt(c, t);
    return Math.hypot(q.x - p.x, q.y - p.y);
  };
  const samples = 24;
  let bestT = 0;
  let best = distanceAt(0);
  for (let i = 1; i <= samples; i++) {
    const t = i / samples;
    const d = distanceAt(t);
    if (d < best) {
      best = d;
      bestT = t;
    }
  }
  // Ternary-style narrowing of the interval around the best sample.
  let lo = Math.max(0, bestT - 1 / samples);
  let hi = Math.min(1, bestT + 1 / samples);
  for (let i = 0; i < 24; i++) {
    const a = lo + (hi - lo) / 3;
    const b = hi - (hi - lo) / 3;
    if (distanceAt(a) <= distanceAt(b)) hi = b;
    else lo = a;
  }
  const t = (lo + hi) / 2;
  const refined = distanceAt(t);
  if (refined < best) {
    best = refined;
    bestT = t;
  }
  return { t: bestT, point: cubicAt(c, bestT), distance: best };
}

/**
 * The number that turns a circle's radius into the length of the Bézier
 * handles that best draw a quarter of it.
 */
export const KAPPA = 0.5522847498307936;
