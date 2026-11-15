import type { VectorNetwork, VectorSegment, VectorVertex, WindingRule } from '../document/schema';
import { distanceToSegment, type Point, type Rect } from '../math/geometry';
import { cubicAt, cubicBounds, flattenCubic, isStraight, nearestOnCubic, splitCubic, type Cubic } from './bezier';

/**
 * Vector networks. A network is a set of points (vertices) and the curves
 * between them (segments). Unlike a classic path, a vertex may have any
 * number of segments, so shapes can branch and share edges. Everything here
 * is pure: operations return a new network and never change their input.
 */

const ZERO: Point = { x: 0, y: 0 };
const isZero = (p: Point): boolean => p.x === 0 && p.y === 0;

/** One segment travelled in one direction. */
export interface PathStep {
  segment: number;
  /** True when the segment is travelled from its `end` to its `start`. */
  reversed: boolean;
}

/** A run of segments drawn as one stroke: from a loose end or a branch to the next, or all the way round. */
export interface VectorChain {
  steps: PathStep[];
  closed: boolean;
}

/** Which end of a segment a control handle belongs to. */
export interface HandleRef {
  segment: number;
  end: 'start' | 'end';
}

/** How the two handles of a smooth point follow each other. */
export type HandleMirroring = 'NONE' | 'ANGLE' | 'ANGLE_AND_LENGTH';

export interface NetworkGeometry {
  /** What is stroked: every segment exactly once. */
  chains: VectorChain[];
  /** What is filled: closed outlines. An open path is filled as if a straight line closed it. */
  loops: PathStep[][];
  /** `loops` as polygons, for hit testing. */
  loopPolygons: Point[][];
  /** `chains` as polylines, for hit testing. A closed chain's last point repeats its first. */
  polylines: Point[][];
  /** Exact bounds of all curves and points, or null for an empty network. */
  bounds: Rect | null;
  /** True when there is at least one chain and none has a loose end, so a stroke has an inside and an outside. */
  closed: boolean;
}

/** The curve of one segment, in the network's coordinates. */
export function segmentCubic(network: VectorNetwork, index: number): Cubic {
  const segment = network.segments[index] as VectorSegment;
  const a = network.vertices[segment.start] as VectorVertex;
  const b = network.vertices[segment.end] as VectorVertex;
  return {
    p0: { x: a.x, y: a.y },
    p1: { x: a.x + segment.tangentStart.x, y: a.y + segment.tangentStart.y },
    p2: { x: b.x + segment.tangentEnd.x, y: b.y + segment.tangentEnd.y },
    p3: { x: b.x, y: b.y },
  };
}

/** The curve of a step, running in the direction of travel. */
export function stepCubic(network: VectorNetwork, step: PathStep): Cubic {
  const c = segmentCubic(network, step.segment);
  return step.reversed ? { p0: c.p3, p1: c.p2, p2: c.p1, p3: c.p0 } : c;
}

function stepOrigin(network: VectorNetwork, step: PathStep): number {
  const segment = network.segments[step.segment] as VectorSegment;
  return step.reversed ? segment.end : segment.start;
}

function stepTarget(network: VectorNetwork, step: PathStep): number {
  const segment = network.segments[step.segment] as VectorSegment;
  return step.reversed ? segment.start : segment.end;
}

/** For every vertex, the steps that leave it. A segment from a vertex to itself leaves it twice. */
function outgoingSteps(network: VectorNetwork): PathStep[][] {
  const out: PathStep[][] = network.vertices.map(() => []);
  network.segments.forEach((segment, index) => {
    out[segment.start]?.push({ segment: index, reversed: false });
    out[segment.end]?.push({ segment: index, reversed: true });
  });
  return out;
}

/** The control handles that belong to a vertex, one for each segment end that meets it. */
export function handlesOf(network: VectorNetwork, vertex: number): HandleRef[] {
  const out: HandleRef[] = [];
  network.segments.forEach((segment, index) => {
    if (segment.start === vertex) out.push({ segment: index, end: 'start' });
    if (segment.end === vertex) out.push({ segment: index, end: 'end' });
  });
  return out;
}

/** How many segment ends meet at a vertex. */
export function vertexDegree(network: VectorNetwork, vertex: number): number {
  return handlesOf(network, vertex).length;
}

function buildChains(network: VectorNetwork, outgoing: readonly PathStep[][]): VectorChain[] {
  const chains: VectorChain[] = [];
  const visited = new Set<number>();
  const walk = (first: PathStep): PathStep[] => {
    const steps: PathStep[] = [];
    let step: PathStep | undefined = first;
    while (step && !visited.has(step.segment)) {
      visited.add(step.segment);
      steps.push(step);
      const arrived: PathStep = step;
      const at = stepTarget(network, arrived);
      const leaving = outgoing[at] as PathStep[];
      if (leaving.length !== 2) break;
      // Leave by the other of the two segment ends that meet here.
      step = leaving.find((candidate) => !(candidate.segment === arrived.segment && candidate.reversed !== arrived.reversed));
    }
    return steps;
  };
  // Runs that start at a loose end or a branch.
  outgoing.forEach((leaving) => {
    if (leaving.length === 2) return;
    for (const step of leaving) {
      if (visited.has(step.segment)) continue;
      chains.push({ steps: walk(step), closed: false });
    }
  });
  // Whatever is left is made of rings only.
  network.segments.forEach((_, index) => {
    if (visited.has(index)) return;
    chains.push({ steps: walk({ segment: index, reversed: false }), closed: true });
  });
  return chains;
}

function flattenSteps(network: VectorNetwork, steps: readonly PathStep[], tolerance: number): Point[] {
  const points: Point[] = [];
  steps.forEach((step, i) => {
    const c = stepCubic(network, step);
    if (i === 0) points.push(c.p0);
    flattenCubic(c, tolerance, points);
  });
  return points;
}

/** Twice the signed area of a polygon. The sign tells which way round it runs. */
function signedArea(points: readonly Point[]): number {
  let sum = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[j] as Point;
    const b = points[i] as Point;
    sum += a.x * b.y - b.x * a.y;
  }
  return sum;
}

/**
 * The enclosed regions of the parts of a network that branch. Walking always
 * takes the next segment round each vertex, which traces the outline of every
 * region once; the walk round the outside of each connected part runs the
 * other way and is dropped. Segments are expected not to cross each other.
 */
function buildFaces(network: VectorNetwork, outgoing: readonly PathStep[][], branching: ReadonlySet<number>): PathStep[][] {
  const key = (step: PathStep): number => step.segment * 2 + (step.reversed ? 1 : 0);
  const angle = (step: PathStep): number => {
    const c = stepCubic(network, step);
    // A little way along the curve rather than the tangent itself, so that
    // two curves that leave in the same direction are still told apart.
    let p = cubicAt(c, 0.02);
    if (p.x === c.p0.x && p.y === c.p0.y) p = c.p3;
    return Math.atan2(p.y - c.p0.y, p.x - c.p0.x);
  };
  const sorted = new Map<number, PathStep[]>();
  const position = new Map<number, number>();
  for (const vertex of branching) {
    const steps = [...(outgoing[vertex] as PathStep[])].sort((a, b) => angle(a) - angle(b));
    sorted.set(vertex, steps);
    steps.forEach((step, i) => position.set(key(step), i));
  }
  const next = (step: PathStep): PathStep | undefined => {
    const at = stepTarget(network, step);
    const around = sorted.get(at);
    if (!around) return undefined;
    const back = position.get(key({ segment: step.segment, reversed: !step.reversed })) as number;
    return around[(back - 1 + around.length) % around.length];
  };

  const faces: PathStep[][] = [];
  const visited = new Set<number>();
  for (const vertex of branching) {
    for (const first of sorted.get(vertex) as PathStep[]) {
      if (visited.has(key(first))) continue;
      const face: PathStep[] = [];
      let step: PathStep | undefined = first;
      while (step && !visited.has(key(step))) {
        visited.add(key(step));
        face.push(step);
        step = next(step);
      }
      if (signedArea(flattenSteps(network, face, 0.25)) > 1e-6) faces.push(face);
    }
  }
  return faces;
}

const geometryCache = new WeakMap<VectorNetwork, NetworkGeometry>();

/** Everything derived from a network that drawing and hit testing need. Cached per network object. */
export function networkGeometry(network: VectorNetwork): NetworkGeometry {
  const cached = geometryCache.get(network);
  if (cached) return cached;

  const outgoing = outgoingSteps(network);
  const chains = buildChains(network, outgoing);

  // Connected parts that contain a branch are filled region by region;
  // plain paths are filled as they are.
  const part = network.vertices.map((_, i) => i);
  const find = (v: number): number => {
    let root = v;
    while (part[root] !== root) root = part[root] as number;
    while (part[v] !== root) {
      const up = part[v] as number;
      part[v] = root;
      v = up;
    }
    return root;
  };
  for (const segment of network.segments) part[find(segment.start)] = find(segment.end);
  const branchingParts = new Set<number>();
  outgoing.forEach((leaving, vertex) => {
    if (leaving.length > 2) branchingParts.add(find(vertex));
  });
  const branching = new Set<number>();
  network.vertices.forEach((_, vertex) => {
    if (branchingParts.has(find(vertex)) && (outgoing[vertex] as PathStep[]).length > 0) branching.add(vertex);
  });

  const loops: PathStep[][] = [];
  for (const chain of chains) {
    const first = chain.steps[0];
    if (first && !branching.has(stepOrigin(network, first))) loops.push(chain.steps);
  }
  if (branching.size > 0) loops.push(...buildFaces(network, outgoing, branching));

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const include = (x: number, y: number): void => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  for (const vertex of network.vertices) include(vertex.x, vertex.y);
  network.segments.forEach((_, index) => {
    const b = cubicBounds(segmentCubic(network, index));
    include(b.x, b.y);
    include(b.x + b.width, b.y + b.height);
  });

  const geometry: NetworkGeometry = {
    chains,
    loops,
    loopPolygons: loops.map((steps) => flattenSteps(network, steps, 0.1)),
    polylines: chains.map((chain) => flattenSteps(network, chain.steps, 0.1)),
    bounds: network.vertices.length === 0 ? null : { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
    closed: chains.length > 0 && chains.every((chain) => chain.closed),
  };
  geometryCache.set(network, geometry);
  return geometry;
}

export function networkBounds(network: VectorNetwork): Rect | null {
  return networkGeometry(network).bounds;
}

/** Is a point inside what a fill would paint? */
export function pointInNetworkFill(network: VectorNetwork, p: Point, rule: WindingRule): boolean {
  let winding = 0;
  let inside = false;
  for (const polygon of networkGeometry(network).loopPolygons) {
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const a = polygon[j] as Point;
      const b = polygon[i] as Point;
      if (a.y > p.y === b.y > p.y) continue;
      if (p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
        inside = !inside;
        winding += b.y > a.y ? 1 : -1;
      }
    }
  }
  return rule === 'EVENODD' ? inside : winding !== 0;
}

/** The shortest distance from a point to any curve of the network. */
export function distanceToNetwork(network: VectorNetwork, p: Point): number {
  let best = Infinity;
  const { polylines } = networkGeometry(network);
  for (const line of polylines) {
    if (line.length === 1) best = Math.min(best, Math.hypot(p.x - (line[0] as Point).x, p.y - (line[0] as Point).y));
    for (let i = 1; i < line.length; i++) best = Math.min(best, distanceToSegment(p, line[i - 1] as Point, line[i] as Point));
  }
  return best;
}

/** The segment nearest to a point, and where on it. Null for a network without segments. */
export function nearestSegment(network: VectorNetwork, p: Point): { segment: number; t: number; point: Point; distance: number } | null {
  let best: { segment: number; t: number; point: Point; distance: number } | null = null;
  for (let index = 0; index < network.segments.length; index++) {
    const found = nearestOnCubic(segmentCubic(network, index), p);
    if (best === null || found.distance < best.distance) best = { segment: index, ...found };
  }
  return best;
}

/** Applies a map to every point of a network. `map` must be affine (translate, scale, rotate, skew) for curves to stay exact. */
export function mapNetwork(network: VectorNetwork, map: (p: Point) => Point): VectorNetwork {
  const vertices = network.vertices.map((vertex) => map(vertex));
  const handle = (vertex: VectorVertex, moved: Point, tangent: Point): Point => {
    if (isZero(tangent)) return ZERO;
    const tip = map({ x: vertex.x + tangent.x, y: vertex.y + tangent.y });
    return { x: tip.x - moved.x, y: tip.y - moved.y };
  };
  const segments = network.segments.map((segment) => ({
    start: segment.start,
    end: segment.end,
    tangentStart: handle(network.vertices[segment.start] as VectorVertex, vertices[segment.start] as Point, segment.tangentStart),
    tangentEnd: handle(network.vertices[segment.end] as VectorVertex, vertices[segment.end] as Point, segment.tangentEnd),
  }));
  return { vertices, segments };
}

export function scaleNetwork(network: VectorNetwork, sx: number, sy: number): VectorNetwork {
  if (sx === 1 && sy === 1) return network;
  return mapNetwork(network, (p) => ({ x: p.x * sx, y: p.y * sy }));
}

export function translateNetwork(network: VectorNetwork, dx: number, dy: number): VectorNetwork {
  if (dx === 0 && dy === 0) return network;
  return { vertices: network.vertices.map((v) => ({ x: v.x + dx, y: v.y + dy })), segments: network.segments };
}

/** Adds a point. Returns its index. */
export function addVertex(network: VectorNetwork, p: Point): { network: VectorNetwork; index: number } {
  return { network: { vertices: [...network.vertices, { x: p.x, y: p.y }], segments: network.segments }, index: network.vertices.length };
}

/**
 * Connects two points with a segment and returns its index. A second straight
 * line between the same two points would only hide under the first, so the
 * existing one is returned instead.
 */
export function addSegment(
  network: VectorNetwork,
  start: number,
  end: number,
  tangentStart: Point = ZERO,
  tangentEnd: Point = ZERO,
): { network: VectorNetwork; index: number } {
  if (!network.vertices[start] || !network.vertices[end]) return { network, index: -1 };
  const straight = isZero(tangentStart) && isZero(tangentEnd);
  if (straight) {
    if (start === end) return { network, index: -1 };
    const existing = network.segments.findIndex(
      (s) =>
        isZero(s.tangentStart) &&
        isZero(s.tangentEnd) &&
        ((s.start === start && s.end === end) || (s.start === end && s.end === start)),
    );
    if (existing >= 0) return { network, index: existing };
  }
  const segment: VectorSegment = { start, end, tangentStart: { ...tangentStart }, tangentEnd: { ...tangentEnd } };
  return { network: { vertices: network.vertices, segments: [...network.segments, segment] }, index: network.segments.length };
}

export function moveVertices(network: VectorNetwork, indices: readonly number[], dx: number, dy: number): VectorNetwork {
  if ((dx === 0 && dy === 0) || indices.length === 0) return network;
  const moving = new Set(indices);
  return {
    vertices: network.vertices.map((vertex, i) => (moving.has(i) ? { x: vertex.x + dx, y: vertex.y + dy } : vertex)),
    segments: network.segments,
  };
}

export function getTangent(network: VectorNetwork, ref: HandleRef): Point {
  const segment = network.segments[ref.segment];
  if (!segment) return ZERO;
  return ref.end === 'start' ? segment.tangentStart : segment.tangentEnd;
}

/** The vertex a handle belongs to. */
export function handleVertex(network: VectorNetwork, ref: HandleRef): number {
  const segment = network.segments[ref.segment] as VectorSegment;
  return ref.end === 'start' ? segment.start : segment.end;
}

function withTangent(segments: VectorSegment[], ref: HandleRef, tangent: Point): void {
  const segment = segments[ref.segment] as VectorSegment;
  segments[ref.segment] = ref.end === 'start' ? { ...segment, tangentStart: { x: tangent.x, y: tangent.y } } : { ...segment, tangentEnd: { x: tangent.x, y: tangent.y } };
}

/**
 * Moves one control handle. With mirroring, and when the point has exactly
 * one other handle, that one is kept opposite to it: at the same angle, and
 * for `ANGLE_AND_LENGTH` at the same length too.
 */
export function setTangent(network: VectorNetwork, ref: HandleRef, tangent: Point, mirroring: HandleMirroring = 'NONE'): VectorNetwork {
  if (!network.segments[ref.segment]) return network;
  const segments = [...network.segments];
  withTangent(segments, ref, tangent);
  const length = Math.hypot(tangent.x, tangent.y);
  if (mirroring !== 'NONE' && length > 0) {
    const others = handlesOf(network, handleVertex(network, ref)).filter((h) => !(h.segment === ref.segment && h.end === ref.end));
    if (others.length === 1) {
      const other = others[0] as HandleRef;
      if (mirroring === 'ANGLE_AND_LENGTH') withTangent(segments, other, { x: 0 - tangent.x, y: 0 - tangent.y });
      else {
        const current = getTangent(network, other);
        const otherLength = Math.hypot(current.x, current.y);
        withTangent(segments, other, { x: (-tangent.x / length) * otherLength, y: (-tangent.y / length) * otherLength });
      }
    }
  }
  return { vertices: network.vertices, segments };
}

/**
 * How the handles of a point behave, read from the handles themselves: a
 * point with two handles in a straight line through it is smooth, and its
 * handles turn together; if they are also the same length they stay so.
 */
export function mirroringAt(network: VectorNetwork, vertex: number): HandleMirroring {
  const handles = handlesOf(network, vertex);
  if (handles.length !== 2) return 'NONE';
  const a = getTangent(network, handles[0] as HandleRef);
  const b = getTangent(network, handles[1] as HandleRef);
  const la = Math.hypot(a.x, a.y);
  const lb = Math.hypot(b.x, b.y);
  if (la === 0 || lb === 0) return 'NONE';
  const cross = (a.x * b.y - a.y * b.x) / (la * lb);
  const dot = (a.x * b.x + a.y * b.y) / (la * lb);
  if (Math.abs(cross) > 0.02 || dot > 0) return 'NONE';
  return Math.abs(la - lb) <= Math.max(la, lb) * 0.01 + 0.01 ? 'ANGLE_AND_LENGTH' : 'ANGLE';
}

/**
 * Adds a point on a segment at parameter `t` of its curve (as `nearestSegment`
 * gives it) without changing the shape: the segment becomes two. Returns the
 * new point's index.
 */
export function splitSegment(network: VectorNetwork, index: number, t: number): { network: VectorNetwork; vertex: number } {
  const segment = network.segments[index];
  if (!segment) return { network, vertex: -1 };
  const c = segmentCubic(network, index);
  const vertex = network.vertices.length;
  const segments = [...network.segments];
  let mid: Point;
  let first: VectorSegment;
  let second: VectorSegment;
  if (isStraight(c)) {
    // `t` is the curve's own parameter, which does not run evenly along a
    // straight segment; this is the point `nearestSegment` reports for it.
    mid = cubicAt(c, t);
    first = { start: segment.start, end: vertex, tangentStart: ZERO, tangentEnd: ZERO };
    second = { start: vertex, end: segment.end, tangentStart: ZERO, tangentEnd: ZERO };
  } else {
    const [left, right] = splitCubic(c, t);
    mid = left.p3;
    const offset = (from: Point, to: Point): Point => ({ x: to.x - from.x, y: to.y - from.y });
    first = { start: segment.start, end: vertex, tangentStart: offset(left.p0, left.p1), tangentEnd: offset(left.p3, left.p2) };
    second = { start: vertex, end: segment.end, tangentStart: offset(right.p0, right.p1), tangentEnd: offset(right.p3, right.p2) };
  }
  segments.splice(index, 1, first, second);
  return { network: { vertices: [...network.vertices, mid], segments }, vertex };
}

/** Removes points that no segment uses. `map` gives each old index its new one, or -1 if it was removed. */
export function pruneIsolated(network: VectorNetwork): { network: VectorNetwork; map: number[] } {
  const used = network.vertices.map(() => false);
  for (const segment of network.segments) {
    used[segment.start] = true;
    used[segment.end] = true;
  }
  if (used.every(Boolean)) return { network, map: network.vertices.map((_, i) => i) };
  const map: number[] = [];
  const vertices: VectorVertex[] = [];
  network.vertices.forEach((vertex, i) => {
    map.push(used[i] ? vertices.length : -1);
    if (used[i]) vertices.push(vertex);
  });
  const segments = network.segments.map((s) => ({ ...s, start: map[s.start] as number, end: map[s.end] as number }));
  return { network: { vertices, segments }, map };
}

function dropVertex(network: VectorNetwork, vertex: number, segments: VectorSegment[]): VectorNetwork {
  const shift = (i: number): number => (i > vertex ? i - 1 : i);
  return {
    vertices: network.vertices.filter((_, i) => i !== vertex),
    segments: segments.map((s) => ({ ...s, start: shift(s.start), end: shift(s.end) })),
  };
}

function removeVertex(network: VectorNetwork, vertex: number): VectorNetwork {
  if (!network.vertices[vertex]) return network;
  const handles = handlesOf(network, vertex);
  const [a, b] = handles;
  if (handles.length === 2 && a && b && a.segment !== b.segment) {
    // A point in the middle of a path: its two neighbours are joined directly
    // and keep their own handles, so the path stays in one piece.
    const far = (ref: HandleRef): { vertex: number; tangent: Point } => {
      const s = network.segments[ref.segment] as VectorSegment;
      return ref.end === 'start' ? { vertex: s.end, tangent: s.tangentEnd } : { vertex: s.start, tangent: s.tangentStart };
    };
    const from = far(a);
    const to = far(b);
    const healed: VectorSegment = { start: from.vertex, end: to.vertex, tangentStart: from.tangent, tangentEnd: to.tangent };
    // A straight line from a point to itself is nothing, and so is a second
    // straight line between two points that already have one.
    const straight = isZero(from.tangent) && isZero(to.tangent);
    const pointless =
      straight &&
      (from.vertex === to.vertex ||
        network.segments.some(
          (s, i) =>
            i !== a.segment &&
            i !== b.segment &&
            isZero(s.tangentStart) &&
            isZero(s.tangentEnd) &&
            ((s.start === from.vertex && s.end === to.vertex) || (s.start === to.vertex && s.end === from.vertex)),
        ));
    const segments: VectorSegment[] = [];
    network.segments.forEach((s, i) => {
      if (i === a.segment) {
        if (!pointless) segments.push(healed);
      } else if (i !== b.segment) segments.push(s);
    });
    return dropVertex(network, vertex, segments);
  }
  return dropVertex(
    network,
    vertex,
    network.segments.filter((s) => s.start !== vertex && s.end !== vertex),
  );
}

/**
 * Deletes points. A point in the middle of a path is taken out and the path
 * closes up over the gap; a loose end or a branch point takes its segments
 * with it. Points left without any segment are removed as well.
 */
export function removeVertices(network: VectorNetwork, indices: readonly number[]): VectorNetwork {
  let next = network;
  for (const vertex of [...new Set(indices)].sort((x, y) => y - x)) next = removeVertex(next, vertex);
  return pruneIsolated(next).network;
}

/** Deletes segments, and any points left without one. */
export function removeSegments(network: VectorNetwork, indices: readonly number[]): VectorNetwork {
  const removing = new Set(indices);
  if (removing.size === 0) return network;
  return pruneIsolated({ vertices: network.vertices, segments: network.segments.filter((_, i) => !removing.has(i)) }).network;
}

/** Makes one point of two: every segment of `drop` is attached to `keep` instead. */
export function mergeVertices(network: VectorNetwork, keep: number, drop: number): VectorNetwork {
  if (keep === drop || !network.vertices[keep] || !network.vertices[drop]) return network;
  const moved = network.segments
    .map((s) => ({ ...s, start: s.start === drop ? keep : s.start, end: s.end === drop ? keep : s.end }))
    // A straight line from a point to itself is nothing.
    .filter((s) => !(s.start === s.end && isZero(s.tangentStart) && isZero(s.tangentEnd)));
  return dropVertex(network, drop, moved);
}

/**
 * Cuts the path at a point: the segments that met there no longer do. The
 * first keeps the point; each of the others gets a point of its own in the
 * same place. A closed path is opened; an open one becomes two. `added`
 * lists the new points.
 */
export function detachVertex(network: VectorNetwork, vertex: number): { network: VectorNetwork; added: number[] } {
  const at = network.vertices[vertex];
  const handles = handlesOf(network, vertex);
  if (!at || handles.length < 2) return { network, added: [] };
  const vertices = [...network.vertices];
  const segments = [...network.segments];
  const added: number[] = [];
  for (const ref of handles.slice(1)) {
    const index = vertices.length;
    vertices.push({ x: at.x, y: at.y });
    added.push(index);
    const segment = segments[ref.segment] as VectorSegment;
    segments[ref.segment] = ref.end === 'start' ? { ...segment, start: index } : { ...segment, end: index };
  }
  return { network: { vertices, segments }, added };
}

/** Turns a point into a corner: its handles are pulled in, so the segments leave it straight. */
export function cornerVertex(network: VectorNetwork, vertex: number): VectorNetwork {
  const handles = handlesOf(network, vertex);
  if (handles.every((h) => isZero(getTangent(network, h)))) return network;
  const segments = [...network.segments];
  for (const h of handles) withTangent(segments, h, ZERO);
  return { vertices: network.vertices, segments };
}

/**
 * Turns a point into a smooth one. With two segments the handles are laid
 * along the line between the two neighbouring points, a third of the way to
 * each; otherwise each handle points a third of the way to its neighbour.
 */
export function smoothVertex(network: VectorNetwork, vertex: number): VectorNetwork {
  const at = network.vertices[vertex];
  const handles = handlesOf(network, vertex);
  if (!at || handles.length === 0) return network;
  const neighbour = (ref: HandleRef): Point => {
    const s = network.segments[ref.segment] as VectorSegment;
    return network.vertices[ref.end === 'start' ? s.end : s.start] as Point;
  };
  const segments = [...network.segments];
  const [a, b] = handles;
  if (handles.length === 2 && a && b) {
    const pa = neighbour(a);
    const pb = neighbour(b);
    const length = Math.hypot(pb.x - pa.x, pb.y - pa.y);
    if (length === 0) return network;
    const dx = (pb.x - pa.x) / length;
    const dy = (pb.y - pa.y) / length;
    const reachA = Math.hypot(pa.x - at.x, pa.y - at.y) / 3;
    const reachB = Math.hypot(pb.x - at.x, pb.y - at.y) / 3;
    withTangent(segments, a, { x: -dx * reachA, y: -dy * reachA });
    withTangent(segments, b, { x: dx * reachB, y: dy * reachB });
  } else {
    for (const h of handles) {
      const p = neighbour(h);
      withTangent(segments, h, { x: (p.x - at.x) / 3, y: (p.y - at.y) / 3 });
    }
  }
  return { vertices: network.vertices, segments };
}

/** Do two networks describe the same geometry, point for point? */
export function sameNetwork(a: VectorNetwork, b: VectorNetwork): boolean {
  if (a === b) return true;
  if (a.vertices.length !== b.vertices.length || a.segments.length !== b.segments.length) return false;
  for (let i = 0; i < a.vertices.length; i++) {
    const p = a.vertices[i] as VectorVertex;
    const q = b.vertices[i] as VectorVertex;
    if (p.x !== q.x || p.y !== q.y) return false;
  }
  for (let i = 0; i < a.segments.length; i++) {
    const s = a.segments[i] as VectorSegment;
    const t = b.segments[i] as VectorSegment;
    if (
      s.start !== t.start ||
      s.end !== t.end ||
      s.tangentStart.x !== t.tangentStart.x ||
      s.tangentStart.y !== t.tangentStart.y ||
      s.tangentEnd.x !== t.tangentEnd.x ||
      s.tangentEnd.y !== t.tangentEnd.y
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Builds a network the way paths are usually described: move to a point,
 * then lines and curves from each point to the next, closing where wanted.
 */
export class NetworkBuilder {
  private readonly vertices: VectorVertex[] = [];
  private readonly segments: VectorSegment[] = [];
  private first = -1;
  private last = -1;

  private near(index: number, x: number, y: number): boolean {
    const v = this.vertices[index];
    return v !== undefined && Math.abs(v.x - x) < 1e-9 && Math.abs(v.y - y) < 1e-9;
  }

  moveTo(x: number, y: number): this {
    this.vertices.push({ x, y });
    this.first = this.last = this.vertices.length - 1;
    return this;
  }

  lineTo(x: number, y: number): this {
    if (this.last < 0) return this.moveTo(x, y);
    // A line of no length adds nothing.
    if (this.near(this.last, x, y)) return this;
    this.vertices.push({ x, y });
    const index = this.vertices.length - 1;
    this.segments.push({ start: this.last, end: index, tangentStart: ZERO, tangentEnd: ZERO });
    this.last = index;
    return this;
  }

  /** A curve to `(x, y)` with control points `(c1x, c1y)` and `(c2x, c2y)`, given as positions. */
  curveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): this {
    if (this.last < 0) this.moveTo(c1x, c1y);
    const from = this.vertices[this.last] as VectorVertex;
    this.vertices.push({ x, y });
    const index = this.vertices.length - 1;
    this.segments.push({
      start: this.last,
      end: index,
      tangentStart: { x: c1x - from.x, y: c1y - from.y },
      tangentEnd: { x: c2x - x, y: c2y - y },
    });
    this.last = index;
    return this;
  }

  /** Closes the current path: back to where it started, with a straight line if it is not already there. */
  close(): this {
    if (this.first < 0 || this.last === this.first) return this;
    const start = this.vertices[this.first] as VectorVertex;
    if (this.near(this.last, start.x, start.y) && this.last === this.vertices.length - 1) {
      // The path already ends where it began: use the one point for both.
      const dropped = this.last;
      this.vertices.pop();
      for (const segment of this.segments) {
        if (segment.start === dropped) segment.start = this.first;
        if (segment.end === dropped) segment.end = this.first;
      }
    } else {
      this.segments.push({ start: this.last, end: this.first, tangentStart: ZERO, tangentEnd: ZERO });
    }
    this.last = this.first;
    return this;
  }

  build(): VectorNetwork {
    return { vertices: this.vertices.map((v) => ({ ...v })), segments: this.segments.map((s) => ({ ...s })) };
  }
}
