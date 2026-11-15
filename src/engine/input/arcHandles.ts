import { applyToPoint, getWorldMatrix, invert, type Document, type EllipseNode, type NodeId, type Point } from '../../core';
import { worldToScreen, type Viewport } from '../viewport';

/**
 * The handles shown on a selected ellipse for shaping its arc on the canvas:
 * where the arc starts, where it ends, and how big the hole in the middle is.
 */

export type ArcHandle = 'start' | 'end' | 'ratio';

export interface ArcHandlePoint {
  handle: ArcHandle;
  /** Where the handle is drawn, in canvas pixels. */
  screen: Point;
}

/** An ellipse smaller than this on screen (its shorter side, in pixels) shows no arc handles: there would be no room for them. */
const MIN_SIZE_PX = 48;
export const ARC_HANDLE_RADIUS_PX = 4;
const ARC_HIT_PX = 7;

const radians = (degrees: number): number => (degrees * Math.PI) / 180;

/** Where an ellipse's arc handles are, in its own space. A whole ellipse has no separate start handle. */
export function arcHandleLocal(node: EllipseNode): { handle: ArcHandle; point: Point }[] {
  const rx = node.width / 2;
  const ry = node.height / 2;
  // The start and end handles sit between the hole and the edge.
  const along = node.arcRatio > 0 ? (1 + node.arcRatio) / 2 : 0.75;
  const at = (degrees: number, factor: number): Point => ({ x: rx + rx * factor * Math.cos(radians(degrees)), y: ry + ry * factor * Math.sin(radians(degrees)) });
  const out: { handle: ArcHandle; point: Point }[] = [];
  if (node.arcSweep < 360) out.push({ handle: 'start', point: at(node.arcStart, along) });
  out.push({ handle: 'end', point: at(node.arcStart + node.arcSweep, along) });
  // The hole's handle is on its edge, half-way round the arc; with no hole yet it is at the centre.
  // A whole ellipse has none, so that it can still be dragged about by its middle.
  if (node.arcSweep < 360 || node.arcRatio > 0) out.push({ handle: 'ratio', point: at(node.arcStart + node.arcSweep / 2, node.arcRatio) });
  return out;
}

/** The arc handles to show for the current selection: only for a single, unlocked ellipse that is big enough on screen. */
export function arcHandles(doc: Document, selection: readonly NodeId[], viewport: Viewport): { id: NodeId; points: ArcHandlePoint[] } | null {
  if (selection.length !== 1) return null;
  const node = doc.nodes[selection[0] as NodeId];
  if (!node || node.type !== 'ELLIPSE' || node.locked) return null;
  if (Math.min(node.width, node.height) * viewport.zoom < MIN_SIZE_PX) return null;
  const matrix = getWorldMatrix(doc, node.id);
  return {
    id: node.id,
    points: arcHandleLocal(node).map(({ handle, point }) => ({ handle, screen: worldToScreen(viewport, applyToPoint(matrix, point)) })),
  };
}

/** The arc handle under a canvas point, if any. */
export function arcHandleAt(doc: Document, selection: readonly NodeId[], viewport: Viewport, screen: Point): { id: NodeId; handle: ArcHandle } | null {
  const shown = arcHandles(doc, selection, viewport);
  if (!shown) return null;
  let best: { id: NodeId; handle: ArcHandle } | null = null;
  let bestDistance = ARC_HIT_PX;
  for (const { handle, screen: at } of shown.points) {
    const d = Math.hypot(at.x - screen.x, at.y - screen.y);
    if (d <= bestDistance) {
      best = { id: shown.id, handle };
      bestDistance = d;
    }
  }
  return best;
}

const turn = (degrees: number): number => ((degrees % 360) + 360) % 360;

/**
 * The arc an ellipse has after one of its handles is dragged to a page-space
 * point. Angles land on whole degrees, or with `coarse` on multiples of 15.
 * Dragging the start keeps the end where it is.
 */
export function dragArcHandle(
  doc: Document,
  id: NodeId,
  handle: ArcHandle,
  world: Point,
  coarse: boolean,
): { arcStart?: number; arcSweep?: number; arcRatio?: number } | null {
  const node = doc.nodes[id];
  if (!node || node.type !== 'ELLIPSE') return null;
  const rx = node.width / 2;
  const ry = node.height / 2;
  if (rx <= 0 || ry <= 0) return null;
  const local = applyToPoint(invert(getWorldMatrix(doc, id)), world);
  // In the ellipse's own measure, where its edge is one unit from its centre in every direction.
  const nx = (local.x - rx) / rx;
  const ny = (local.y - ry) / ry;
  if (handle === 'ratio') return { arcRatio: Math.min(0.99, Math.max(0, Math.round(Math.hypot(nx, ny) * 100) / 100)) };
  const raw = (Math.atan2(ny, nx) * 180) / Math.PI;
  const angle = coarse ? Math.round(raw / 15) * 15 : Math.round(raw);
  if (handle === 'end') return { arcSweep: turn(angle - node.arcStart) || 360 };
  const end = node.arcStart + node.arcSweep;
  return { arcStart: turn(angle), arcSweep: turn(end - angle) || 360 };
}
