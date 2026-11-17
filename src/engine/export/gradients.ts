import { applyToPoint, invert, multiply, type GradientPaint, type Matrix, type Point, type RGB } from '../../core';
import type { Segment } from './vector';

/**
 * Angular and diamond gradients for the vector writers, which have no such
 * gradients of their own. They are drawn as the canvas draws them:
 *
 * - An angular gradient is a fan of thin solid wedges round its centre, each
 *   in the colour the gradient has half way across it. With 180 wedges each
 *   is two degrees wide, too narrow to see as a band at any normal size.
 * - A diamond gradient is exactly four linear gradients, one in each quarter
 *   about its centre, which is how the canvas paints it too.
 *
 * Shapes are filled in the layer's box, stretched with it ('box'); lines and
 * text are coloured in plain units ('pixels'), where the canvas has no
 * diamond and draws a round gradient instead.
 */

export type GradientSpace = 'box' | 'pixels';

/** A part of the layer's space, which what is drawn has to cover. */
export interface Area {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Wedge {
  path: Segment[];
  color: RGB;
  opacity: number;
}

/** A quarter of a diamond: a linear gradient from (0, 0) to `to`, in the space `matrix` maps into the layer's. */
export interface Quadrant {
  path: Segment[];
  matrix: Matrix;
  to: Point;
}

export const ANGULAR_WEDGES = 180;

/** The colour and opacity of a gradient at a point along it, between its stops, as the canvas blends them (with the colours weighted by their opacity). */
export function gradientColourAt(paint: GradientPaint, t: number): { color: RGB; opacity: number } {
  const stops = [...paint.stops].sort((a, b) => a.position - b.position);
  const first = stops[0];
  const last = stops[stops.length - 1];
  if (!first || !last) return { color: { r: 0, g: 0, b: 0 }, opacity: 0 };
  if (t <= first.position) return { color: first.color, opacity: first.opacity };
  if (t >= last.position) return { color: last.color, opacity: last.opacity };
  let index = 0;
  while (index < stops.length - 2 && t > (stops[index + 1] as typeof first).position) index++;
  const a = stops[index] as typeof first;
  const b = stops[index + 1] as typeof first;
  const span = b.position - a.position;
  const f = span > 0 ? (t - a.position) / span : 1;
  const opacity = a.opacity + (b.opacity - a.opacity) * f;
  const channel = (key: keyof RGB): number => {
    if (opacity <= 0) return a.color[key] + (b.color[key] - a.color[key]) * f;
    return (a.color[key] * a.opacity * (1 - f) + b.color[key] * b.opacity * f) / opacity;
  };
  return { color: { r: channel('r'), g: channel('g'), b: channel('b') }, opacity };
}

/** Whether a paint has to be drawn as wedges or quarters rather than given as a colour. */
export function drawnAsShapes(paint: { type: string }, space: GradientSpace): boolean {
  return paint.type === 'GRADIENT_ANGULAR' || (paint.type === 'GRADIENT_DIAMOND' && space === 'box');
}

/** The space a gradient is laid out in, as a matrix into the layer's. A box with no width or height has no box space, and the canvas then uses plain units. */
function gradientSpace(space: GradientSpace, width: number, height: number): Matrix {
  return space === 'box' && width > 0 && height > 0 ? [width, 0, 0, height, 0, 0] : [1, 0, 0, 1, 0, 0];
}

function polygon(points: readonly Point[]): Segment[] {
  const out: Segment[] = points.map((point, index) => ({ op: index === 0 ? 'M' : 'L', x: point.x, y: point.y }));
  out.push({ op: 'Z' });
  return out;
}

/** The furthest any corner of an area is from a point, measured in another space. */
function reach(area: Area, toSpace: Matrix, centre: Point): number {
  let most = 0;
  for (const [x, y] of [
    [area.x, area.y],
    [area.x + area.width, area.y],
    [area.x, area.y + area.height],
    [area.x + area.width, area.y + area.height],
  ] as const) {
    const p = applyToPoint(toSpace, { x, y });
    most = Math.max(most, Math.hypot(p.x - centre.x, p.y - centre.y));
  }
  return most;
}

/** The wedges of an angular gradient that cover an area of the layer's space, in that space. */
export function angularWedges(paint: GradientPaint, width: number, height: number, space: GradientSpace, area: Area, count = ANGULAR_WEDGES): Wedge[] {
  const boxed = space === 'box' && width > 0 && height > 0;
  const g = gradientSpace(space, width, height);
  const sx = boxed ? 1 : width;
  const sy = boxed ? 1 : height;
  const centre = { x: paint.from.x * sx, y: paint.from.y * sy };
  const start = Math.atan2(paint.to.y * sy - centre.y, paint.to.x * sx - centre.x);
  const step = (Math.PI * 2) / count;
  // Far enough that the straight outer edge of each wedge, even one made wider, is outside the area.
  const radius = (Math.max(1e-6, reach(area, invert(g), centre)) / Math.cos(step)) * 1.01 + 1e-6;
  // Opaque wedges reach half way over the next, which is drawn over them, so no hairline shows between the two.
  const opaque = paint.stops.every((stop) => stop.opacity >= 1);
  const out: Wedge[] = [];
  for (let i = 0; i < count; i++) {
    const a0 = start + step * i;
    const a1 = a0 + step * (opaque && i < count - 1 ? 1.5 : 1);
    const { color, opacity } = gradientColourAt(paint, (i + 0.5) / count);
    const at = (angle: number): Point => applyToPoint(g, { x: centre.x + radius * Math.cos(angle), y: centre.y + radius * Math.sin(angle) });
    out.push({ path: polygon([applyToPoint(g, centre), at(a0), at(a1)]), color, opacity });
  }
  return out;
}

/** The four quarters of a diamond gradient in a shape's box that cover an area of the layer's space. Null for a box with no width or height, where the canvas draws a round gradient. */
export function diamondQuadrants(paint: GradientPaint, width: number, height: number, area: Area): Quadrant[] | null {
  if (width <= 0 || height <= 0) return null;
  const angle = Math.atan2(paint.to.y - paint.from.y, paint.to.x - paint.from.x);
  const radius = Math.max(1e-6, Math.hypot(paint.to.x - paint.from.x, paint.to.y - paint.from.y));
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  // The box, then the centre, then the turn: the quarters are the four signs of (x, y) in this space.
  const matrix = multiply([width, 0, 0, height, 0, 0], [cos, sin, -sin, cos, paint.from.x, paint.from.y]);
  const far = reach(area, invert(matrix), { x: 0, y: 0 }) + 1;
  const overlap = paint.stops.every((stop) => stop.opacity >= 1) ? far * 1e-3 : 0;
  const out: Quadrant[] = [];
  for (const [sx, sy] of [
    [1, 1],
    [-1, 1],
    [-1, -1],
    [1, -1],
  ] as const) {
    const x0 = sx > 0 ? -overlap : -far;
    const x1 = sx > 0 ? far : overlap;
    const y0 = sy > 0 ? -overlap : -far;
    const y1 = sy > 0 ? far : overlap;
    const corners = [
      { x: x0, y: y0 },
      { x: x1, y: y0 },
      { x: x1, y: y1 },
      { x: x0, y: y1 },
    ].map((point) => applyToPoint(matrix, point));
    out.push({ path: polygon(corners), matrix, to: { x: (sx * radius) / 2, y: (sy * radius) / 2 } });
  }
  return out;
}

/** The box round a path's points and handles, which holds the path. Null for an empty path. */
export function pathArea(segments: readonly Segment[], pad = 0): Area | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const take = (x: number, y: number): void => {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  };
  for (const segment of segments) {
    if (segment.op === 'Z') continue;
    if (segment.op === 'C') {
      take(segment.x1, segment.y1);
      take(segment.x2, segment.y2);
    }
    take(segment.x, segment.y);
  }
  if (x0 > x1) return null;
  return { x: x0 - pad, y: y0 - pad, width: x1 - x0 + pad * 2, height: y1 - y0 + pad * 2 };
}
