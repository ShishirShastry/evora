import type { Point } from './geometry';

/**
 * 2D affine transform in canvas order:
 *   x' = a*x + c*y + e
 *   y' = b*x + d*y + f
 */
export type Matrix = readonly [a: number, b: number, c: number, d: number, e: number, f: number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** Returns `m1 · m2`: the transform that applies `m2` first, then `m1`. */
export function multiply(m1: Matrix, m2: Matrix): Matrix {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

export function translation(tx: number, ty: number): Matrix {
  return [1, 0, 0, 1, tx, ty];
}

/** Rotation by `degrees`, clockwise on screen (Y axis points down). */
export function rotation(degrees: number): Matrix {
  const r = (degrees * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return [cos, sin, -sin, cos, 0, 0];
}

export function invert(m: Matrix): Matrix {
  const det = m[0] * m[3] - m[1] * m[2];
  if (det === 0 || !Number.isFinite(det)) return IDENTITY;
  const a = m[3] / det;
  const b = -m[1] / det;
  const c = -m[2] / det;
  const d = m[0] / det;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}

export function applyToPoint(m: Matrix, p: Point): Point {
  return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] };
}

/** Applies only the linear part of the matrix (no translation). */
export function applyToVector(m: Matrix, v: Point): Point {
  return { x: m[0] * v.x + m[2] * v.y, y: m[1] * v.x + m[3] * v.y };
}

/** The rotation, in degrees, that the matrix applies to the X axis. */
export function rotationOf(m: Matrix): number {
  return (Math.atan2(m[1], m[0]) * 180) / Math.PI;
}

/**
 * Local matrix of a box stored as an unrotated rectangle plus a rotation about
 * its centre: `T(x + w/2, y + h/2) · R(rotation) · T(-w/2, -h/2)`.
 */
export function boxMatrix(x: number, y: number, width: number, height: number, degrees: number): Matrix {
  if (degrees === 0) return [1, 0, 0, 1, x, y];
  const r = (degrees * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const hw = width / 2;
  const hh = height / 2;
  return [cos, sin, -sin, cos, x + hw - cos * hw + sin * hh, y + hh - sin * hw - cos * hh];
}
