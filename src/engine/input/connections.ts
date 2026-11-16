import { getAncestorIds, getWorldBounds, isLayer, prototypeFrames, type Document, type NodeId, type Point, type Rect } from '../../core';
import { worldToScreen, type Viewport } from '../viewport';

/**
 * Prototype connections on the canvas: the round handle on the edge of the
 * selected layer from which a connection is dragged, the frame a connection
 * can be dropped on, and the curve a connection is drawn as.
 */

export const CONNECTOR_RADIUS_PX = 6;
const CONNECTOR_HIT_PX = 10;
/** How far outside the layer's right edge the handle sits, in screen pixels. */
const CONNECTOR_OFFSET_PX = 14;

/** The handle to drag a connection from: beside the middle of the right edge of the one selected layer. */
export function connectorHandle(doc: Document, selection: readonly NodeId[], viewport: Viewport): { id: NodeId; screen: Point } | null {
  const id = selection.length === 1 ? (selection[0] as NodeId) : undefined;
  const node = id === undefined ? undefined : doc.nodes[id];
  if (id === undefined || !isLayer(node) || node.locked) return null;
  const bounds = getWorldBounds(doc, id);
  const edge = worldToScreen(viewport, { x: bounds.x + bounds.width, y: bounds.y + bounds.height / 2 });
  return { id, screen: { x: edge.x + CONNECTOR_OFFSET_PX, y: edge.y } };
}

/** The layer whose connection handle is at a point of the canvas, if one is. */
export function connectorHandleAt(doc: Document, selection: readonly NodeId[], viewport: Viewport, point: Point): NodeId | null {
  const handle = connectorHandle(doc, selection, viewport);
  return handle && Math.hypot(point.x - handle.screen.x, point.y - handle.screen.y) <= CONNECTOR_HIT_PX ? handle.id : null;
}

/**
 * The frame a connection from a layer would go to when dropped at a point
 * of the page: the top-most frame laid out on the page there, other than
 * the layer itself and the frame the layer is in.
 */
export function connectTargetAt(doc: Document, pageId: NodeId, fromId: NodeId, world: Point): NodeId | null {
  const own = new Set([fromId, ...getAncestorIds(doc, fromId)]);
  const frames = prototypeFrames(doc, pageId);
  for (let i = frames.length - 1; i >= 0; i--) {
    const frame = frames[i] as { id: NodeId; visible: boolean };
    if (own.has(frame.id) || !frame.visible) continue;
    const bounds = getWorldBounds(doc, frame.id);
    if (world.x >= bounds.x && world.x <= bounds.x + bounds.width && world.y >= bounds.y && world.y <= bounds.y + bounds.height) return frame.id;
  }
  return null;
}

/** A connection as it is drawn: a curve from one point to another, in canvas pixels. */
export interface ConnectionCurve {
  from: Point;
  c1: Point;
  c2: Point;
  to: Point;
}

/**
 * The curve from a layer to a frame, or to a point while a connection is
 * being dragged. It leaves the layer by the side that faces where it goes
 * and arrives at the side of the frame that faces the layer.
 */
export function connectionCurve(viewport: Viewport, source: Rect, target: Rect | Point): ConnectionCurve {
  const isRect = (value: Rect | Point): value is Rect => 'width' in value;
  const targetCentre = isRect(target) ? target.x + target.width / 2 : target.x;
  const rightwards = targetCentre >= source.x + source.width / 2;
  const from = worldToScreen(viewport, { x: rightwards ? source.x + source.width : source.x, y: source.y + source.height / 2 });
  const to = worldToScreen(viewport, isRect(target) ? { x: rightwards ? target.x : target.x + target.width, y: target.y + target.height / 2 } : target);
  const reach = Math.max(30, Math.abs(to.x - from.x) / 2) * (rightwards ? 1 : -1);
  return { from, c1: { x: from.x + reach, y: from.y }, c2: { x: to.x - (isRect(target) ? reach : 0), y: to.y }, to };
}
