import { applyToPoint, getWorldMatrix, invert, isGradient, isLayer, patchNode, snapAngle, type Document, type GradientPaint, type LayerNode, type Point } from '../../core';
import type { PaintEdit } from '../../state/editorStore';
import { worldToScreen, type Viewport } from '../viewport';

/**
 * The two handles of a gradient shown on the canvas while it is being
 * edited there: where it starts (or its centre) and where it ends (or how
 * far it reaches).
 */

export type GradientHandle = 'from' | 'to';
export const GRADIENT_HANDLE_RADIUS_PX = 5;
const GRADIENT_HIT_PX = 8;

/** The gradient a paint edit points at, with its layer, or null if it no longer does. */
export function editedGradient(doc: Document, edit: PaintEdit | null): { node: LayerNode; paint: GradientPaint } | null {
  if (!edit) return null;
  const node = doc.nodes[edit.id];
  if (!isLayer(node) || node.width <= 0 || node.height <= 0) return null;
  const paint = node[edit.key][edit.index];
  return paint && isGradient(paint) ? { node, paint } : null;
}

/** Where the handles are, in canvas pixels. */
export function gradientHandles(doc: Document, edit: PaintEdit | null, viewport: Viewport): { from: Point; to: Point } | null {
  const found = editedGradient(doc, edit);
  if (!found) return null;
  const { node, paint } = found;
  const matrix = getWorldMatrix(doc, node.id);
  const place = (p: Point): Point => worldToScreen(viewport, applyToPoint(matrix, { x: p.x * node.width, y: p.y * node.height }));
  return { from: place(paint.from), to: place(paint.to) };
}

/** The gradient handle under a canvas point, if any. The end is on top where the two coincide. */
export function gradientHandleAt(doc: Document, edit: PaintEdit | null, viewport: Viewport, screen: Point): GradientHandle | null {
  const handles = gradientHandles(doc, edit, viewport);
  if (!handles) return null;
  const near = (p: Point): boolean => Math.hypot(p.x - screen.x, p.y - screen.y) <= GRADIENT_HIT_PX;
  return near(handles.to) ? 'to' : near(handles.from) ? 'from' : null;
}

/**
 * The document after a gradient handle is dragged to a page-space point.
 * With `coarse` the gradient's direction keeps to multiples of 15 degrees.
 */
export function dragGradientHandle(doc: Document, edit: PaintEdit, handle: GradientHandle, world: Point, coarse: boolean): Document {
  const found = editedGradient(doc, edit);
  if (!found) return doc;
  const { node, paint } = found;
  let local = applyToPoint(invert(getWorldMatrix(doc, node.id)), world);
  if (coarse) {
    const other = handle === 'from' ? paint.to : paint.from;
    local = snapAngle({ x: other.x * node.width, y: other.y * node.height }, local, 15);
  }
  const tidy = (v: number): number => Math.round(v * 1000) / 1000 + 0;
  const moved = { x: tidy(local.x / node.width), y: tidy(local.y / node.height) };
  const paints = node[edit.key].map((other, i) => (i === edit.index ? { ...paint, [handle]: moved } : other));
  return patchNode(doc, node.id, { [edit.key]: paints });
}
