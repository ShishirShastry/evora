import { applyToPoint, applyToVector, getWorldMatrix, invert, isLayer, patchNode, type Document, type ImagePaint, type LayerNode, type Point } from '../../core';
import type { PaintEdit } from '../../state/editorStore';

/**
 * Positioning a cropped image by dragging it on the canvas: the layer stays
 * where it is and the part of the image that shows through it moves.
 */

/** The cropped image a paint edit points at, with its layer, or null if it no longer points at one. */
export function editedCrop(doc: Document, edit: PaintEdit | null): { node: LayerNode; paint: ImagePaint } | null {
  if (!edit) return null;
  const node = doc.nodes[edit.id];
  if (!isLayer(node) || node.width <= 0 || node.height <= 0) return null;
  const paint = node[edit.key][edit.index];
  return paint && paint.type === 'IMAGE' && paint.scaleMode === 'CROP' ? { node, paint } : null;
}

/** Is a page-space point over the layer whose cropped image is being positioned? */
export function cropUnderPointer(doc: Document, edit: PaintEdit | null, world: Point): boolean {
  const found = editedCrop(doc, edit);
  if (!found) return false;
  const local = applyToPoint(invert(getWorldMatrix(doc, found.node.id)), world);
  return local.x >= 0 && local.y >= 0 && local.x <= found.node.width && local.y <= found.node.height;
}

/**
 * The document after the image has been dragged from one page-space point to
 * another. The image follows the pointer, so the part of it that shows moves
 * the other way; it stops at the image's edges.
 */
export function dragCrop(doc: Document, edit: PaintEdit, from: Point, to: Point): Document {
  const found = editedCrop(doc, edit);
  if (!found) return doc;
  const { node, paint } = found;
  const moved = applyToVector(invert(getWorldMatrix(doc, node.id)), { x: to.x - from.x, y: to.y - from.y });
  // A mirrored picture is drawn turned over, so it follows the pointer the other way round in its own terms.
  if (paint.flipX) moved.x = 0 - moved.x;
  if (paint.flipY) moved.y = 0 - moved.y;
  const clamp = (v: number, max: number): number => Math.min(max, Math.max(0, v));
  const tidy = (v: number): number => Math.round(v * 1e4) / 1e4 + 0;
  const crop = {
    ...paint.crop,
    x: tidy(clamp(paint.crop.x - (moved.x / node.width) * paint.crop.width, 1 - paint.crop.width)),
    y: tidy(clamp(paint.crop.y - (moved.y / node.height) * paint.crop.height, 1 - paint.crop.height)),
  };
  const paints = node[edit.key].map((other, i) => (i === edit.index ? { ...paint, crop } : other));
  return patchNode(doc, node.id, { [edit.key]: paints });
}
