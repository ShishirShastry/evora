import type { VectorNetwork, VectorSegment, VectorVertex } from '../document/schema';
import type { Point } from '../math/geometry';
import { applyToPoint, type Matrix } from '../math/matrix';

/**
 * Paths as SVG writes them, read into cubic curves, and those turned into
 * the points and segments a vector layer is made of.
 */

/** One curve of a path. A straight line has its control points on its ends. */
export interface PathCurve {
  p0: Point;
  p1: Point;
  p2: Point;
  p3: Point;
}

/** A run of curves, each starting where the one before ended. */
export interface Subpath {
  curves: PathCurve[];
  closed: boolean;
  /** Where it starts, which matters for one that has no curves: a lone "move to". */
  start: Point;
}

const line = (a: Point, b: Point): PathCurve => ({ p0: a, p1: a, p2: b, p3: b });

/** An arc of an ellipse as SVG gives it (from, radii, turn, flags, to), as curves. */
export function arcCurves(from: Point, rx: number, ry: number, degrees: number, large: boolean, sweep: boolean, to: Point): PathCurve[] {
  if ((from.x === to.x && from.y === to.y) || rx === 0 || ry === 0) return rx === 0 || ry === 0 ? [line(from, to)] : [];
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const phi = (degrees * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  // The end points in the ellipse's own, unturned space, about their midpoint.
  const dx = (from.x - to.x) / 2;
  const dy = (from.y - to.y) / 2;
  const x1 = cos * dx + sin * dy;
  const y1 = -sin * dx + cos * dy;
  // Radii too small to reach are grown until they do.
  const scale = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (scale > 1) {
    rx *= Math.sqrt(scale);
    ry *= Math.sqrt(scale);
  }
  const numerator = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const denominator = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  const factor = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, numerator / denominator));
  const cxp = (factor * rx * y1) / ry;
  const cyp = (-factor * ry * x1) / rx;
  const cx = cos * cxp - sin * cyp + (from.x + to.x) / 2;
  const cy = sin * cxp + cos * cyp + (from.y + to.y) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number): number => {
    const dot = ux * vx + uy * vy;
    const length = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    const value = Math.acos(Math.min(1, Math.max(-1, dot / length)));
    return ux * vy - uy * vx < 0 ? -value : value;
  };
  const start = angle(1, 0, (x1 - cxp) / rx, (y1 - cyp) / ry);
  let delta = angle((x1 - cxp) / rx, (y1 - cyp) / ry, (-x1 - cxp) / rx, (-y1 - cyp) / ry);
  if (!sweep && delta > 0) delta -= Math.PI * 2;
  else if (sweep && delta < 0) delta += Math.PI * 2;
  const pieces = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2) - 1e-9));
  const step = delta / pieces;
  const handle = (4 / 3) * Math.tan(step / 4);
  const at = (theta: number): Point => ({ x: cx + rx * Math.cos(theta) * cos - ry * Math.sin(theta) * sin, y: cy + rx * Math.cos(theta) * sin + ry * Math.sin(theta) * cos });
  const tangent = (theta: number): Point => ({ x: -rx * Math.sin(theta) * cos - ry * Math.cos(theta) * sin, y: -rx * Math.sin(theta) * sin + ry * Math.cos(theta) * cos });
  const out: PathCurve[] = [];
  for (let i = 0; i < pieces; i++) {
    const a0 = start + step * i;
    const a1 = a0 + step;
    const p0 = i === 0 ? from : at(a0);
    const p3 = i === pieces - 1 ? to : at(a1);
    const t0 = tangent(a0);
    const t1 = tangent(a1);
    out.push({ p0, p1: { x: p0.x + t0.x * handle, y: p0.y + t0.y * handle }, p2: { x: p3.x - t1.x * handle, y: p3.y - t1.y * handle }, p3 });
  }
  return out;
}

/** Reads the `d` of an SVG path. What cannot be read ends the path there, as browsers do. */
export function parsePathData(d: string): Subpath[] {
  const tokens = d.match(/[a-zA-Z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? [];
  const out: Subpath[] = [];
  let current: Subpath | null = null;
  let at: Point = { x: 0, y: 0 };
  let start: Point = { x: 0, y: 0 };
  // The second control point of the last curve, which "smooth" curves mirror.
  let lastCubic: Point | null = null;
  let lastQuad: Point | null = null;
  let index = 0;
  let command = '';
  const more = (): boolean => index < tokens.length && !/^[a-zA-Z]$/.test(tokens[index] as string);
  const number = (): number => Number(tokens[index++]);
  const flag = (): boolean => {
    // An arc's flags may be written without a space after them: "01" is two flags.
    const token = tokens[index] as string;
    if (token.length > 1 && /^[01]/.test(token)) {
      tokens[index] = token.slice(1);
      return token[0] === '1';
    }
    index++;
    return token === '1';
  };
  const begin = (): Subpath => {
    if (!current) {
      current = { curves: [], closed: false, start: at };
      out.push(current);
    }
    return current;
  };
  while (index < tokens.length) {
    const token = tokens[index] as string;
    if (/^[a-zA-Z]$/.test(token)) {
      command = token;
      index++;
    } else if (command === '') break;
    else if (command === 'M') command = 'L';
    else if (command === 'm') command = 'l';
    const relative = command === command.toLowerCase();
    const base = relative ? at : { x: 0, y: 0 };
    const kind = command.toUpperCase();
    if (kind === 'Z') {
      if (current) {
        const path: Subpath = current;
        if (at.x !== start.x || at.y !== start.y) path.curves.push(line(at, start));
        path.closed = true;
      }
      at = start;
      current = null;
      lastCubic = lastQuad = null;
      continue;
    }
    const need = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7 }[kind];
    if (need === undefined) break;
    // Not enough numbers left for the command: the path ends here.
    let have = 0;
    for (let i = index; i < tokens.length && !/^[a-zA-Z]$/.test(tokens[i] as string); i++) have++;
    if (have < (kind === 'A' ? 5 : need)) break;
    if (kind === 'M') {
      at = { x: base.x + number(), y: base.y + number() };
      start = at;
      current = null;
      lastCubic = lastQuad = null;
      // A "move to" with nothing after it is still somewhere: it starts a path there.
      if (!more()) continue;
      continue;
    }
    const path = begin();
    if (kind === 'L') {
      const to = { x: base.x + number(), y: base.y + number() };
      path.curves.push(line(at, to));
      at = to;
      lastCubic = lastQuad = null;
    } else if (kind === 'H') {
      const to = { x: (relative ? at.x : 0) + number(), y: at.y };
      path.curves.push(line(at, to));
      at = to;
      lastCubic = lastQuad = null;
    } else if (kind === 'V') {
      const to = { x: at.x, y: (relative ? at.y : 0) + number() };
      path.curves.push(line(at, to));
      at = to;
      lastCubic = lastQuad = null;
    } else if (kind === 'C' || kind === 'S') {
      const p1 = kind === 'C' ? { x: base.x + number(), y: base.y + number() } : lastCubic ? { x: 2 * at.x - lastCubic.x, y: 2 * at.y - lastCubic.y } : at;
      const p2 = { x: base.x + number(), y: base.y + number() };
      const to = { x: base.x + number(), y: base.y + number() };
      path.curves.push({ p0: at, p1, p2, p3: to });
      at = to;
      lastCubic = p2;
      lastQuad = null;
    } else if (kind === 'Q' || kind === 'T') {
      const control: Point = kind === 'Q' ? { x: base.x + number(), y: base.y + number() } : lastQuad ? { x: 2 * at.x - lastQuad.x, y: 2 * at.y - lastQuad.y } : at;
      const to = { x: base.x + number(), y: base.y + number() };
      // A quadratic curve as the cubic that draws the same line.
      path.curves.push({ p0: at, p1: { x: at.x + (2 / 3) * (control.x - at.x), y: at.y + (2 / 3) * (control.y - at.y) }, p2: { x: to.x + (2 / 3) * (control.x - to.x), y: to.y + (2 / 3) * (control.y - to.y) }, p3: to });
      at = to;
      lastQuad = control;
      lastCubic = null;
    } else {
      const rx = number();
      const ry = number();
      const turn = number();
      const large = flag();
      const sweep = flag();
      const to = { x: base.x + number(), y: base.y + number() };
      path.curves.push(...arcCurves(at, rx, ry, turn, large, sweep, to));
      at = to;
      lastCubic = lastQuad = null;
    }
  }
  return out.filter((path) => path.curves.length > 0);
}

/** Subpaths moved, turned, scaled or sheared by a matrix. */
export function transformSubpaths(paths: readonly Subpath[], matrix: Matrix): Subpath[] {
  const map = (p: Point): Point => applyToPoint(matrix, p);
  return paths.map((path) => ({ closed: path.closed, start: map(path.start), curves: path.curves.map((curve) => ({ p0: map(curve.p0), p1: map(curve.p1), p2: map(curve.p2), p3: map(curve.p3) })) }));
}

/**
 * The points and segments of a vector layer for some subpaths. Each curve
 * is a segment between two points; a closed subpath ends on the point it
 * began on. A handle is kept as its distance from its own end point.
 */
export function networkFromSubpaths(paths: readonly Subpath[]): VectorNetwork {
  const vertices: VectorVertex[] = [];
  const segments: VectorSegment[] = [];
  const close = (a: Point, b: Point): boolean => Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6;
  for (const path of paths) {
    if (path.curves.length === 0) continue;
    const first = vertices.length;
    vertices.push({ x: (path.curves[0] as PathCurve).p0.x, y: (path.curves[0] as PathCurve).p0.y });
    let previous = first;
    path.curves.forEach((curve, index) => {
      const last = index === path.curves.length - 1;
      // A closed path's last curve comes back to its first point, which is not made twice.
      let end: number;
      if (last && path.closed && close(curve.p3, vertices[first] as VectorVertex)) end = first;
      else {
        end = vertices.length;
        vertices.push({ x: curve.p3.x, y: curve.p3.y });
      }
      segments.push({ start: previous, end, tangentStart: { x: curve.p1.x - curve.p0.x, y: curve.p1.y - curve.p0.y }, tangentEnd: { x: curve.p2.x - curve.p3.x, y: curve.p2.y - curve.p3.y } });
      previous = end;
    });
    if (path.closed && previous !== first) segments.push({ start: previous, end: first, tangentStart: { x: 0, y: 0 }, tangentEnd: { x: 0, y: 0 } });
  }
  return { vertices, segments };
}
