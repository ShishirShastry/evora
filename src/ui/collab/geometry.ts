import { getPageIdOf, getWorldBounds, getWorldCorners, hitTestDeepest, isLayer, type Document, type NodeId, type Point } from '../../core';
import type { Presence, Thread } from '../../collab/protocol';
import { clampZoom, screenToWorld, worldToScreen, type Size, type Viewport } from '../../engine/viewport';

/**
 * Where what others are doing appears on this canvas: their cursors and
 * selections, comment pins, and the view to show when following someone.
 * Presence is in page coordinates; the canvas turns them into screen
 * pixels with this person's own viewport.
 */

/** Where someone's pointer is on this canvas, in pixels from its top-left; null when it is not on the page shown here. */
export function cursorOnScreen(presence: Presence | null, pageId: NodeId, viewport: Viewport): Point | null {
  if (!presence || presence.pageId !== pageId || !presence.cursor) return null;
  return worldToScreen(viewport, presence.cursor);
}

/**
 * The outlines of someone's selection on this canvas: for each selected layer
 * on the page shown, its box's four corners in screen pixels (turned with the
 * layer when it is rotated). Layers that no longer exist are left out.
 */
export function selectionOutlines(doc: Document, presence: Presence | null, pageId: NodeId, viewport: Viewport): Point[][] {
  if (!presence || presence.pageId !== pageId) return [];
  const out: Point[][] = [];
  for (const id of presence.selection) {
    if (!isLayer(doc.nodes[id]) || getPageIdOf(doc, id) !== pageId) continue;
    out.push(getWorldCorners(doc, id).map((corner) => worldToScreen(viewport, corner)));
  }
  return out;
}

/**
 * Where a comment's pin is on its page: relative to its layer's top-left
 * when it is attached to a layer that still exists there (so it follows the
 * layer), otherwise where it was put.
 */
export function threadAnchor(doc: Document, thread: Pick<Thread, 'pageId' | 'x' | 'y' | 'nodeId'>): Point {
  const { nodeId } = thread;
  if (nodeId && isLayer(doc.nodes[nodeId]) && getPageIdOf(doc, nodeId) === thread.pageId) {
    const bounds = getWorldBounds(doc, nodeId);
    return { x: bounds.x + thread.x, y: bounds.y + thread.y };
  }
  return { x: thread.x, y: thread.y };
}

/**
 * What a click on the canvas with the Comment tool pins a new comment to:
 * the layer under the click when there is one (with the place relative to
 * that layer's top-left), otherwise the page itself.
 */
export function pinAt(doc: Document, pageId: NodeId, viewport: Viewport, screen: Point): { pageId: NodeId; nodeId: NodeId | null; x: number; y: number } {
  const page = screenToWorld(viewport, screen);
  const hit = hitTestDeepest(doc, pageId, page, 2 / viewport.zoom);
  if (hit) {
    const bounds = getWorldBounds(doc, hit);
    return { pageId, nodeId: hit, x: round(page.x - bounds.x), y: round(page.y - bounds.y) };
  }
  return { pageId, nodeId: null, x: round(page.x), y: round(page.y) };
}

const round = (value: number): number => Math.round(value * 100) / 100;

/**
 * The view that shows what someone else sees: the middle of their view in
 * the middle of this canvas, zoomed so that as much of the page is in view
 * as they have (this canvas may be a different size from theirs).
 */
export function followViewport(theirs: NonNullable<Presence['viewport']>, size: Size): Viewport {
  const theirWidth = Math.max(1, theirs.width) / theirs.zoom;
  const theirHeight = Math.max(1, theirs.height) / theirs.zoom;
  const zoom = clampZoom(Math.min(size.width / theirWidth, size.height / theirHeight));
  const centre = { x: theirs.x + theirWidth / 2, y: theirs.y + theirHeight / 2 };
  return { x: centre.x - size.width / zoom / 2, y: centre.y - size.height / zoom / 2, zoom };
}

/** A view of the same zoom with a page point in the middle of the canvas: for going to a comment. */
export function centredOn(point: Point, viewport: Viewport, size: Size): Viewport {
  return { x: point.x - size.width / viewport.zoom / 2, y: point.y - size.height / viewport.zoom / 2, zoom: viewport.zoom };
}

/** This person's view as presence: the page point at the canvas's top-left, the zoom, and the canvas's size. */
export function viewportPresence(viewport: Viewport, size: Size): NonNullable<Presence['viewport']> {
  return { x: viewport.x, y: viewport.y, zoom: viewport.zoom, width: size.width, height: size.height };
}
