import { applyToPoint, type Matrix } from './matrix';

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function rectFromPoints(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height;
}

export function rectContainsRect(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

export function rectContainsPoint(r: Rect, p: Point): boolean {
  return p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;
}

export function unionRects(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.width);
    maxY = Math.max(maxY, r.y + r.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function expandRect(r: Rect, amount: number): Rect {
  return { x: r.x - amount, y: r.y - amount, width: r.width + amount * 2, height: r.height + amount * 2 };
}

export function rectCenter(r: Rect): Point {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

/** The four corners of a `width × height` box at the origin, transformed by `m`. */
export function boxCorners(m: Matrix, width: number, height: number): [Point, Point, Point, Point] {
  return [
    applyToPoint(m, { x: 0, y: 0 }),
    applyToPoint(m, { x: width, y: 0 }),
    applyToPoint(m, { x: width, y: height }),
    applyToPoint(m, { x: 0, y: height }),
  ];
}

/** Axis-aligned bounds of a `width × height` box at the origin, transformed by `m`. */
export function transformedBounds(m: Matrix, width: number, height: number): Rect {
  const c = boxCorners(m, width, height);
  const minX = Math.min(c[0].x, c[1].x, c[2].x, c[3].x);
  const minY = Math.min(c[0].y, c[1].y, c[2].y, c[3].y);
  const maxX = Math.max(c[0].x, c[1].x, c[2].x, c[3].x);
  const maxY = Math.max(c[0].y, c[1].y, c[2].y, c[3].y);
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Normalises an angle in degrees to the range (-180, 180]. */
export function normalizeAngle(degrees: number): number {
  let a = degrees % 360;
  if (a > 180) a -= 360;
  if (a <= -180) a += 360;
  return a === 0 ? 0 : a;
}

export function rotatePoint(p: Point, center: Point, degrees: number): Point {
  const r = (degrees * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const dx = p.x - center.x;
  const dy = p.y - center.y;
  return { x: center.x + dx * cos - dy * sin, y: center.y + dx * sin + dy * cos };
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return distance(p, a);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Even-odd point-in-polygon test. */
export function pointInPolygon(p: Point, polygon: readonly Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i] as Point;
    const b = polygon[j] as Point;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/** Shortest distance from a point to the outline of a closed polygon. */
export function distanceToPolygonEdge(p: Point, polygon: readonly Point[]): number {
  let best = Infinity;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    best = Math.min(best, distanceToSegment(p, polygon[i] as Point, polygon[j] as Point));
  }
  return best;
}

/** Do two convex polygons overlap? Separating axis test. */
export function convexPolygonsIntersect(a: readonly Point[], b: readonly Point[]): boolean {
  for (const polygon of [a, b]) {
    for (let i = 0; i < polygon.length; i++) {
      const p1 = polygon[i] as Point;
      const p2 = polygon[(i + 1) % polygon.length] as Point;
      const axis = { x: -(p2.y - p1.y), y: p2.x - p1.x };
      if (axis.x === 0 && axis.y === 0) continue;
      let minA = Infinity;
      let maxA = -Infinity;
      for (const p of a) {
        const d = p.x * axis.x + p.y * axis.y;
        minA = Math.min(minA, d);
        maxA = Math.max(maxA, d);
      }
      let minB = Infinity;
      let maxB = -Infinity;
      for (const p of b) {
        const d = p.x * axis.x + p.y * axis.y;
        minB = Math.min(minB, d);
        maxB = Math.max(maxB, d);
      }
      if (maxA < minB || maxB < minA) return false;
    }
  }
  return true;
}

export function rectToPolygon(r: Rect): Point[] {
  return [
    { x: r.x, y: r.y },
    { x: r.x + r.width, y: r.y },
    { x: r.x + r.width, y: r.y + r.height },
    { x: r.x, y: r.y + r.height },
  ];
}
