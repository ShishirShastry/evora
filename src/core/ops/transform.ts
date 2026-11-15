import { patchNodes } from '../document/mutate';
import { isLayer, type Document, type LayerPatch, type NodeId } from '../document/schema';
import { normalizeAngle, rotatePoint, type Point, type Rect } from '../math/geometry';
import { applyToPoint, applyToVector, invert } from '../math/matrix';
import { getWorldMatrix, getWorldRotation, topLevelIds } from '../scene/tree';

export const MIN_SIZE = 1;

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
}

/** Which edges a resize handle moves: -1 left/top, 1 right/bottom, 0 neither. */
export interface Handle {
  hx: -1 | 0 | 1;
  hy: -1 | 0 | 1;
}

export interface ResizeOptions {
  keepAspect?: boolean;
  fromCenter?: boolean;
  /** Round moved edges to whole pixels. Only applied to unrotated boxes. */
  snap?: boolean;
}

/** Removes floating-point noise such as 99.99999999 without losing sub-pixel precision. */
export function clean(value: number): number {
  const rounded = Math.round(value * 1000) / 1000;
  return rounded === 0 ? 0 : rounded;
}

/**
 * Converts a placement given in page space (box centre and total rotation)
 * into `x, y, rotation` relative to `parentId`.
 */
export function placementInParent(
  doc: Document,
  parentId: NodeId | null,
  worldCenter: Point,
  width: number,
  height: number,
  worldRotation: number,
): { x: number; y: number; rotation: number } {
  const local = applyToPoint(invert(getWorldMatrix(doc, parentId)), worldCenter);
  return {
    x: clean(local.x - width / 2),
    y: clean(local.y - height / 2),
    rotation: clean(normalizeAngle(worldRotation - getWorldRotation(doc, parentId))),
  };
}

/** The centre of a layer's box in page space. */
export function worldCenterOf(doc: Document, id: NodeId): Point {
  const node = doc.nodes[id];
  if (!isLayer(node)) return { x: 0, y: 0 };
  return applyToPoint(getWorldMatrix(doc, id), { x: node.width / 2, y: node.height / 2 });
}

/**
 * Moves layers by a delta given in page space. Children of a moved layer move
 * with it, so only the top-most selected layers are changed. With `snap`,
 * positions land on whole pixels when the parent is not rotated.
 */
export function moveNodesBy(doc: Document, ids: readonly NodeId[], dx: number, dy: number, snap = false): Document {
  if (dx === 0 && dy === 0 && !snap) return doc;
  const patches: Record<NodeId, LayerPatch> = {};
  for (const id of topLevelIds(doc, ids)) {
    const node = doc.nodes[id];
    if (!isLayer(node)) continue;
    const local = applyToVector(invert(getWorldMatrix(doc, node.parentId)), { x: dx, y: dy });
    let x = node.x + local.x;
    let y = node.y + local.y;
    if (snap && getWorldRotation(doc, node.parentId) === 0) {
      x = Math.round(x);
      y = Math.round(y);
    }
    patches[id] = { x: clean(x), y: clean(y) };
  }
  return patchNodes(doc, patches);
}

/**
 * Pure resize maths for one box. `pointer` is in the same coordinate space as
 * the box (its parent's space). The edge or corner opposite the handle stays
 * fixed, also for rotated boxes. Dragging past the fixed edge flips the box
 * over it rather than producing a negative size.
 */
export function resizeBox(box: Box, handle: Handle, pointer: Point, options: ResizeOptions = {}): Box {
  const { keepAspect = false, fromCenter = false } = options;
  const snap = options.snap === true && box.rotation === 0;
  const c0 = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const p = rotatePoint(pointer, c0, -box.rotation);
  const px = snap ? Math.round(p.x) : p.x;
  const py = snap ? Math.round(p.y) : p.y;

  let left = box.x;
  let right = box.x + box.width;
  let top = box.y;
  let bottom = box.y + box.height;

  if (handle.hx !== 0) {
    if (fromCenter) {
      const half = Math.abs(px - c0.x);
      left = c0.x - half;
      right = c0.x + half;
    } else if (handle.hx === 1) right = px;
    else left = px;
  }
  if (handle.hy !== 0) {
    if (fromCenter) {
      const half = Math.abs(py - c0.y);
      top = c0.y - half;
      bottom = c0.y + half;
    } else if (handle.hy === 1) bottom = py;
    else top = py;
  }

  if (keepAspect && box.width > 0 && box.height > 0) {
    const aspect = box.width / box.height;
    let w = Math.abs(right - left);
    let h = Math.abs(bottom - top);
    if (handle.hx !== 0 && handle.hy !== 0) {
      const scale = Math.max(w / box.width, h / box.height);
      w = box.width * scale;
      h = box.height * scale;
    } else if (handle.hx !== 0) h = w / aspect;
    else w = h * aspect;

    // Re-derive the edges from the anchor so the fixed point stays fixed.
    if (fromCenter || handle.hx === 0) {
      left = c0.x - w / 2;
      right = c0.x + w / 2;
    } else if (handle.hx === 1) right = left + (right >= left ? w : -w);
    else left = right + (left <= right ? -w : w);
    if (fromCenter || handle.hy === 0) {
      top = c0.y - h / 2;
      bottom = c0.y + h / 2;
    } else if (handle.hy === 1) bottom = top + (bottom >= top ? h : -h);
    else top = bottom + (top <= bottom ? -h : h);
  }

  let x = Math.min(left, right);
  let width = Math.abs(right - left);
  if (width < MIN_SIZE && box.width >= MIN_SIZE) {
    if (fromCenter || handle.hx === 0) x = c0.x - MIN_SIZE / 2;
    else if (handle.hx === -1) x = box.x + box.width - MIN_SIZE;
    else x = box.x;
    width = MIN_SIZE;
  }
  let y = Math.min(top, bottom);
  let height = Math.abs(bottom - top);
  if (height < MIN_SIZE && box.height >= MIN_SIZE) {
    if (fromCenter || handle.hy === 0) y = c0.y - MIN_SIZE / 2;
    else if (handle.hy === -1) y = box.y + box.height - MIN_SIZE;
    else y = box.y;
    height = MIN_SIZE;
  }

  // The box rotates about its own centre, so put the new centre where the
  // old rotation frame says it is.
  const c1 = rotatePoint({ x: x + width / 2, y: y + height / 2 }, c0, box.rotation);
  return {
    x: clean(c1.x - width / 2),
    y: clean(c1.y - height / 2),
    width: clean(width),
    height: clean(height),
    rotation: box.rotation,
  };
}

/**
 * Sets a box's size while keeping its top-left corner where it is on screen,
 * also when the box is rotated. This is what typing a width or height into
 * the properties panel does.
 */
export function resizeFromTopLeft(box: Box, width: number, height: number): Box {
  const c0 = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const c1 = rotatePoint({ x: box.x + width / 2, y: box.y + height / 2 }, c0, box.rotation);
  return {
    x: clean(c1.x - width / 2),
    y: clean(c1.y - height / 2),
    width: clean(width),
    height: clean(height),
    rotation: box.rotation,
  };
}

/**
 * Scales layers so that what occupied the page-space rectangle `from` now
 * occupies `to`. Used for resizing a multi-selection. Children of a resized
 * frame keep their positions inside it.
 */
export function resizeNodesInBounds(
  doc: Document,
  ids: readonly NodeId[],
  from: Rect,
  to: Rect,
  snap = false,
): Document {
  const sx = from.width > 0 ? to.width / from.width : 1;
  const sy = from.height > 0 ? to.height / from.height : 1;
  const patches: Record<NodeId, LayerPatch> = {};
  for (const id of topLevelIds(doc, ids)) {
    const node = doc.nodes[id];
    if (!isLayer(node)) continue;
    const center = worldCenterOf(doc, id);
    const worldRotation = getWorldRotation(doc, id);
    const r = (worldRotation * Math.PI) / 180;
    const cos = Math.cos(r);
    const sin = Math.sin(r);
    let width = node.width * Math.hypot(sx * cos, sy * sin);
    let height = node.height * Math.hypot(sx * sin, sy * cos);
    if (node.width >= MIN_SIZE) width = Math.max(MIN_SIZE, width);
    if (node.height >= MIN_SIZE) height = Math.max(MIN_SIZE, height);
    const newCenter = {
      x: to.x + (center.x - from.x) * sx,
      y: to.y + (center.y - from.y) * sy,
    };
    const exact = snap && worldRotation === 0;
    if (exact) {
      width = Math.max(node.width >= MIN_SIZE ? MIN_SIZE : 0, Math.round(width));
      height = Math.max(node.height >= MIN_SIZE ? MIN_SIZE : 0, Math.round(height));
    }
    const placed = placementInParent(doc, node.parentId, newCenter, width, height, worldRotation);
    patches[id] = {
      x: exact ? Math.round(placed.x) : placed.x,
      y: exact ? Math.round(placed.y) : placed.y,
      width: clean(width),
      height: clean(height),
    };
  }
  return patchNodes(doc, patches);
}

/** Rotates layers by `delta` degrees about a pivot given in page space. */
export function rotateNodesAround(doc: Document, ids: readonly NodeId[], pivot: Point, delta: number): Document {
  if (delta === 0) return doc;
  const patches: Record<NodeId, LayerPatch> = {};
  for (const id of topLevelIds(doc, ids)) {
    const node = doc.nodes[id];
    if (!isLayer(node)) continue;
    const center = rotatePoint(worldCenterOf(doc, id), pivot, delta);
    const placed = placementInParent(
      doc,
      node.parentId,
      center,
      node.width,
      node.height,
      getWorldRotation(doc, id) + delta,
    );
    patches[id] = placed;
  }
  return patchNodes(doc, patches);
}

/** Sets a layer's rotation, turning it about its own centre. */
export function setRotation(doc: Document, ids: readonly NodeId[], degrees: number): Document {
  const patches: Record<NodeId, LayerPatch> = {};
  for (const id of ids) if (isLayer(doc.nodes[id])) patches[id] = { rotation: clean(normalizeAngle(degrees)) };
  return patchNodes(doc, patches);
}

/** The box of a LINE layer running from `a` to `b` (both in the parent's space). */
export function lineBox(a: Point, b: Point): Box {
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  const angle = length === 0 ? 0 : (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
  const cx = (a.x + b.x) / 2;
  const cy = (a.y + b.y) / 2;
  return {
    x: clean(cx - length / 2),
    y: clean(cy),
    width: clean(length),
    height: 0,
    rotation: clean(normalizeAngle(angle)),
  };
}

/** The two endpoints of a LINE layer's box, in the parent's space. */
export function lineEndpoints(box: Box): [Point, Point] {
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  return [
    rotatePoint({ x: box.x, y: center.y }, center, box.rotation),
    rotatePoint({ x: box.x + box.width, y: center.y }, center, box.rotation),
  ];
}

/** Snaps the direction from `origin` to `point` to multiples of `step` degrees, keeping the distance. */
export function snapAngle(origin: Point, point: Point, step = 45): Point {
  const length = Math.hypot(point.x - origin.x, point.y - origin.y);
  if (length === 0) return point;
  const angle = Math.atan2(point.y - origin.y, point.x - origin.x);
  const stepRad = (step * Math.PI) / 180;
  const snapped = Math.round(angle / stepRad) * stepRad;
  return { x: origin.x + Math.cos(snapped) * length, y: origin.y + Math.sin(snapped) * length };
}
