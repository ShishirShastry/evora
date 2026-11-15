import type { LayerNode, StrokeAlign, StrokeCap, StrokeJoin, VectorNetwork } from '../document/schema';
import type { Point } from '../math/geometry';
import { arrowShape, arrowTrim, openRuns, pathEnds, trimEnd, trimStart } from './arrows';
import { flattenCubic, type Cubic } from './bezier';
import { booleanNetworks } from './boolean';
import { fitCurve } from './fitCurve';
import { NetworkBuilder, networkGeometry, stepCubic } from './network';
import { shapeNetwork } from './shapes';

/**
 * Turning a stroke into a shape: the outline of everything a stroke paints,
 * as a filled vector. The path is flattened, offset to both sides with its
 * joins and caps, the pieces are merged into clean outlines, and smooth runs
 * of the result are turned back into curves.
 */

/** As the canvas draws them: a sharper corner than this is cut off instead of pointed. */
const MITER_LIMIT = 10;
/** How far the straight pieces that stand in for curves may be from them. */
const FLATNESS = 0.02;

const add = (a: Point, b: Point, s = 1): Point => ({ x: a.x + b.x * s, y: a.y + b.y * s });
const cross = (a: Point, b: Point): number => a.x * b.y - a.y * b.x;
const dot = (a: Point, b: Point): number => a.x * b.x + a.y * b.y;

/** The angle between points on an arc of this radius that keeps the arc within `FLATNESS` of a true one. */
function arcStep(radius: number): number {
  return radius <= FLATNESS ? Math.PI / 2 : 2 * Math.acos(1 - FLATNESS / radius);
}

/** Points on an arc about `center`, strictly between the directions `from` and `to` (unit vectors), going the short way round. */
function arcBetween(center: Point, from: Point, to: Point, radius: number): Point[] {
  const angle = Math.atan2(cross(from, to), dot(from, to));
  const steps = Math.max(1, Math.ceil(Math.abs(angle) / arcStep(radius)));
  const out: Point[] = [];
  for (let k = 1; k < steps; k++) {
    const a = (angle * k) / steps;
    const c = Math.cos(a);
    const s = Math.sin(a);
    out.push(add(center, { x: from.x * c - from.y * s, y: from.x * s + from.y * c }, radius));
  }
  return out;
}

/** Half a turn about `center` from the direction `side` to its opposite, bulging towards `out`. */
function halfTurn(center: Point, side: Point, out: Point, radius: number): Point[] {
  const steps = Math.max(2, Math.ceil(Math.PI / arcStep(radius)));
  const points: Point[] = [];
  for (let k = 1; k < steps; k++) {
    const a = (Math.PI * k) / steps;
    points.push({ x: center.x + radius * (Math.cos(a) * side.x + Math.sin(a) * out.x), y: center.y + radius * (Math.cos(a) * side.y + Math.sin(a) * out.y) });
  }
  return points;
}

function withoutRepeats(points: readonly Point[], closed: boolean): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 1e-9) out.push(p);
  }
  const first = out[0];
  const end = out[out.length - 1];
  if (closed && out.length > 1 && first && end && Math.hypot(first.x - end.x, first.y - end.y) <= 1e-9) out.pop();
  return out;
}

/**
 * One side of a stroke: the path moved sideways by `h`, to the left for
 * `side` 1 and to the right for -1, with its corners joined.
 */
function offsetSide(points: readonly Point[], closed: boolean, h: number, side: 1 | -1, join: StrokeJoin): Point[] {
  const n = points.length;
  const count = closed ? n : n - 1;
  const directions: Point[] = [];
  const normals: Point[] = [];
  const lengths: number[] = [];
  for (let i = 0; i < count; i++) {
    const a = points[i] as Point;
    const b = points[(i + 1) % n] as Point;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    const d = { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
    directions.push(d);
    normals.push({ x: -d.y * side, y: d.x * side });
    lengths.push(length);
  }
  const out: Point[] = [];
  const corner = (vertex: Point, before: number, after: number): void => {
    const a = normals[before] as Point;
    const b = normals[after] as Point;
    const turn = cross(directions[before] as Point, directions[after] as Point) * side;
    const from = add(vertex, a, h);
    const to = add(vertex, b, h);
    if (Math.abs(turn) < 1e-9 && dot(a, b) > 0) {
      out.push(to);
    } else if (turn > 0) {
      // The inside of the corner. Where the two edges are long enough, their offsets simply meet.
      // Where they are not (a bend tighter than the stroke is wide), go back to the corner itself
      // and out again, which keeps the stroke whole.
      const cos = dot(a, b);
      const retreat = cos <= -1 ? Infinity : h * Math.sqrt((1 - cos) / (1 + cos));
      if (retreat < Math.min(lengths[before] as number, lengths[after] as number)) out.push(add(vertex, { x: a.x + b.x, y: a.y + b.y }, h / (1 + cos)));
      else out.push(from, vertex, to);
    } else if (join === 'ROUND') {
      out.push(from, ...arcBetween(vertex, a, b, h), to);
    } else {
      const cosHalf = Math.sqrt(Math.max(0, (1 + dot(a, b)) / 2));
      if (join === 'MITER' && cosHalf > 1e-6 && 1 / cosHalf <= MITER_LIMIT) out.push(add(vertex, { x: a.x + b.x, y: a.y + b.y }, h / (1 + dot(a, b))));
      else out.push(from, to);
    }
  };
  if (closed) {
    for (let i = 0; i < n; i++) corner(points[i] as Point, (i - 1 + n) % n, i);
  } else {
    out.push(add(points[0] as Point, normals[0] as Point, h));
    for (let i = 1; i < n - 1; i++) corner(points[i] as Point, i - 1, i);
    out.push(add(points[n - 1] as Point, normals[count - 1] as Point, h));
  }
  return out;
}

/**
 * Closed polygons that together, filled by the non-zero rule, cover what a
 * stroke of `weight` along a polyline paints. An open path gives one, with
 * its caps; a closed path gives two, one for each side of the stroke.
 */
export function strokePolyline(path: readonly Point[], closed: boolean, weight: number, cap: StrokeCap, join: StrokeJoin): Point[][] {
  const points = withoutRepeats(path, closed);
  const h = weight / 2;
  if (h <= 0 || points.length === 0) return [];
  const first = points[0] as Point;
  if (points.length === 1) {
    // A stroke of no length is a dot or a square, if its ends have any size at all.
    if (cap === 'ROUND') return [[add(first, { x: 1, y: 0 }, h), ...halfTurn(first, { x: 1, y: 0 }, { x: 0, y: 1 }, h), add(first, { x: -1, y: 0 }, h), ...halfTurn(first, { x: -1, y: 0 }, { x: 0, y: -1 }, h)]];
    if (cap === 'SQUARE') return [[add(first, { x: -h, y: -h }), add(first, { x: h, y: -h }), add(first, { x: h, y: h }), add(first, { x: -h, y: h })]];
    return [];
  }
  if (closed && points.length > 2) return [offsetSide(points, true, h, 1, join), offsetSide(points, true, h, -1, join).reverse()];

  const left = offsetSide(points, false, h, 1, join);
  const right = offsetSide(points, false, h, -1, join);
  const last = points[points.length - 1] as Point;
  const before = points[points.length - 2] as Point;
  const second = points[1] as Point;
  const unit = (from: Point, to: Point): Point => {
    const length = Math.hypot(to.x - from.x, to.y - from.y);
    return { x: (to.x - from.x) / length, y: (to.y - from.y) / length };
  };
  const endDirection = unit(before, last);
  const startDirection = unit(second, first);
  const endCap: Point[] = [];
  const startCap: Point[] = [];
  if (cap === 'SQUARE') {
    endCap.push(add(left[left.length - 1] as Point, endDirection, h), add(right[right.length - 1] as Point, endDirection, h));
    startCap.push(add(right[0] as Point, startDirection, h), add(left[0] as Point, startDirection, h));
  } else if (cap === 'ROUND') {
    endCap.push(...halfTurn(last, { x: -endDirection.y, y: endDirection.x }, endDirection, h));
    startCap.push(...halfTurn(first, { x: -startDirection.y, y: startDirection.x }, startDirection, h));
  }
  return [[...left, ...endCap, ...right.reverse(), ...startCap]];
}

/**
 * The parts of a polyline a dashed stroke draws: each dash as an open path.
 * With no dashes the whole path comes back as it is.
 */
export function dashPolyline(path: readonly Point[], closed: boolean, pattern: readonly number[]): { points: Point[]; closed: boolean }[] {
  const points = withoutRepeats(path, closed);
  if (pattern.length === 0 || !pattern.some((length) => length > 0) || points.length < 2) return [{ points, closed }];
  // As the canvas does: a pattern with an odd number of lengths is used twice over.
  const lengths = pattern.length % 2 === 0 ? pattern : [...pattern, ...pattern];
  const line = closed ? [...points, points[0] as Point] : points;
  const out: { points: Point[]; closed: boolean }[] = [];
  let index = 0;
  let left = lengths[0] as number;
  let on = true;
  let current: Point[] = [line[0] as Point];
  for (let i = 1; i < line.length; i++) {
    let from = line[i - 1] as Point;
    const to = line[i] as Point;
    let remaining = Math.hypot(to.x - from.x, to.y - from.y);
    while (remaining > left) {
      const t = left / remaining;
      const at = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
      if (on) {
        current.push(at);
        out.push({ points: current, closed: false });
      }
      remaining -= left;
      from = at;
      on = !on;
      index = (index + 1) % lengths.length;
      left = lengths[index] as number;
      current = [at];
    }
    left -= remaining;
    if (on) current.push(to);
  }
  if (on && current.length > 1) out.push({ points: current, closed: false });
  return out;
}

/** The runs of curves a layer's stroke follows, cut short where an arrowhead needs room. */
function strokeRuns(node: LayerNode, network: VectorNetwork): { curves: Cubic[]; closed: boolean }[] {
  const arrows = node.type === 'LINE' || node.type === 'VECTOR';
  const startTrim = arrows ? arrowTrim(node.startArrow, node.strokeWeight) : 0;
  const endTrim = arrows ? arrowTrim(node.endArrow, node.strokeWeight) : 0;
  const loose = node.type === 'VECTOR' ? openRuns(node) : [];
  return networkGeometry(network).chains.map((chain) => {
    const curves = chain.steps.map((step) => stepCubic(network, step));
    const last = curves.length - 1;
    if (!chain.closed && last >= 0) {
      const run = loose.find((candidate) => candidate.steps === chain.steps);
      const startLoose = node.type === 'LINE' || run?.startLoose === true;
      const endLoose = node.type === 'LINE' || run?.endLoose === true;
      if (startLoose && startTrim > 0) curves[0] = trimStart(curves[0] as Cubic, startTrim);
      if (endLoose && endTrim > 0) curves[last] = trimEnd(curves[last] as Cubic, endTrim);
    }
    // Dashes are counted from where the stroke is drawn from. A whole ellipse is drawn
    // from three o'clock, though its outline is kept from twelve.
    if (node.type === 'ELLIPSE' && chain.closed && curves.length === 4 && node.arcSweep >= 360 && node.arcRatio <= 0) curves.push(curves.shift() as Cubic);
    return { curves, closed: chain.closed };
  });
}

/** Where a layer's stroke really goes: a path with a loose end has no inside, so its stroke is centred. */
function alignOf(node: LayerNode, network: VectorNetwork): StrokeAlign {
  if (node.type === 'LINE') return 'CENTER';
  return networkGeometry(network).closed ? node.strokeAlign : 'CENTER';
}

function polygonNetwork(polygons: readonly Point[][]): VectorNetwork {
  const path = new NetworkBuilder();
  for (const polygon of polygons) {
    if (polygon.length < 3) continue;
    polygon.forEach((p, i) => (i === 0 ? path.moveTo(p.x, p.y) : path.lineTo(p.x, p.y)));
    path.close();
  }
  return path.build();
}

/**
 * Turns the runs of short straight pieces that stand in for curves back
 * into curves, leaving real corners as corners. Outlines that already have
 * curves in them are left alone.
 */
function smoothOutlines(network: VectorNetwork): VectorNetwork {
  const path = new NetworkBuilder();
  const straight = (c: Cubic): boolean => c.p1.x === c.p0.x && c.p1.y === c.p0.y && c.p2.x === c.p3.x && c.p2.y === c.p3.y;
  const emit = (curves: readonly Cubic[]): void => {
    curves.forEach((c, i) => {
      if (i === 0) path.moveTo(c.p0.x, c.p0.y);
      if (straight(c)) path.lineTo(c.p3.x, c.p3.y);
      else path.curveTo(c.p1.x, c.p1.y, c.p2.x, c.p2.y, c.p3.x, c.p3.y);
    });
    path.close();
  };
  for (const chain of networkGeometry(network).chains) {
    const curves = chain.steps.map((step) => stepCubic(network, step));
    if (!chain.closed || curves.length < 3 || !curves.every(straight)) {
      emit(curves);
      continue;
    }
    const points = curves.map((c) => c.p0);
    const n = points.length;
    const turnAt = (i: number): number => {
      const a = points[(i - 1 + n) % n] as Point;
      const b = points[i] as Point;
      const c = points[(i + 1) % n] as Point;
      return Math.abs(Math.atan2(cross({ x: b.x - a.x, y: b.y - a.y }, { x: c.x - b.x, y: c.y - b.y }), dot({ x: b.x - a.x, y: b.y - a.y }, { x: c.x - b.x, y: c.y - b.y })));
    };
    // A real corner turns sharply; the joints of a flattened curve hardly turn at all.
    const corners: number[] = [];
    for (let i = 0; i < n; i++) if (turnAt(i) > 0.7) corners.push(i);
    const fitted: Cubic[] = [];
    const fitRun = (run: Point[]): void => {
      if (run.length <= 2) fitted.push({ p0: run[0] as Point, p1: run[0] as Point, p2: run[run.length - 1] as Point, p3: run[run.length - 1] as Point });
      else fitted.push(...fitCurve(run, 0.05));
    };
    if (corners.length === 0) fitRun([...points, points[0] as Point]);
    else {
      for (let k = 0; k < corners.length; k++) {
        const from = corners[k] as number;
        const to = corners[(k + 1) % corners.length] as number;
        const run: Point[] = [];
        for (let i = from; ; i = (i + 1) % n) {
          run.push(points[i] as Point);
          if (i === to && run.length > 1) break;
        }
        fitRun(run);
      }
    }
    emit(fitted);
  }
  return path.build();
}

/**
 * The outline of a layer's stroke as a vector network in the layer's own
 * space: what its stroke paints, including dashes, caps, joins, arrowheads
 * and whether the stroke is inside, outside or centred. Null for layers
 * whose stroke has no outline to follow (frames, groups, text) or no width.
 */
export function strokeOutline(node: LayerNode): VectorNetwork | null {
  const network = shapeNetwork(node);
  if (!network || network.segments.length === 0 || node.strokeWeight <= 0) return null;
  const align = alignOf(node, network);
  const weight = node.strokeWeight * (align === 'CENTER' ? 1 : 2);
  const polygons: Point[][] = [];
  for (const run of strokeRuns(node, network)) {
    const points: Point[] = [];
    run.curves.forEach((c, i) => {
      if (i === 0) points.push(c.p0);
      flattenCubic(c, FLATNESS, points);
    });
    for (const piece of dashPolyline(points, run.closed, node.dashPattern)) {
      polygons.push(...strokePolyline(piece.points, piece.closed, weight, node.strokeCap, node.strokeJoin));
    }
  }
  if (node.type === 'LINE' || node.type === 'VECTOR') {
    for (const end of pathEnds(node)) {
      const head = arrowShape(end.at === 'start' ? node.startArrow : node.endArrow, end, node.strokeWeight);
      if (!head) continue;
      if (head.circle) {
        const { center, radius } = head.circle;
        polygons.push([add(center, { x: 1, y: 0 }, radius), ...halfTurn(center, { x: 1, y: 0 }, { x: 0, y: 1 }, radius), add(center, { x: -1, y: 0 }, radius), ...halfTurn(center, { x: -1, y: 0 }, { x: 0, y: -1 }, radius)]);
      } else if (head.filled) polygons.push(head.points);
      else polygons.push(...strokePolyline(head.points, false, node.strokeWeight, node.strokeCap, node.strokeJoin));
    }
  }
  const raw = polygonNetwork(polygons);
  if (raw.segments.length === 0) return null;
  // Merge the pieces, which overlap each other and themselves, into clean outlines.
  let outline = booleanNetworks([{ network: raw, windingRule: 'NONZERO' }], 'UNION');
  if (outline.segments.length === 0) outline = raw;
  if (align !== 'CENTER') {
    const rule = node.type === 'VECTOR' ? node.windingRule : 'NONZERO';
    outline = booleanNetworks([{ network: outline, windingRule: 'NONZERO' }, { network, windingRule: rule }], align === 'INSIDE' ? 'INTERSECT' : 'SUBTRACT');
  }
  return outline.segments.length === 0 ? null : smoothOutlines(outline);
}
