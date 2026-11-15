import {
  distance,
  distanceToSegment,
  getWorldBounds,
  getWorldCorners,
  getWorldRotation,
  isLayer,
  pointInPolygon,
  rectToPolygon,
  unionRects,
  type Document,
  type Handle,
  type NodeId,
  type Point,
  type Rect,
} from '../../core';
import { worldToScreen, type Viewport } from '../viewport';

/** The box drawn around the selection, with the handles used to transform it. */
export interface SelectionFrame {
  /** Page-space corners: top-left, top-right, bottom-right, bottom-left. */
  corners: [Point, Point, Point, Point];
  /** Direction of the frame's X axis on the page, in degrees. */
  rotation: number;
  /** Axis-aligned page-space bounds. */
  bounds: Rect;
  /** The layer, when exactly one is selected. */
  single: NodeId | null;
  /** True when the single selected layer is a line (it has endpoint handles instead of a box). */
  line: boolean;
}

export function getSelectionFrame(doc: Document, selection: readonly NodeId[]): SelectionFrame | null {
  const ids = selection.filter((id) => isLayer(doc.nodes[id]));
  if (ids.length === 0) return null;
  if (ids.length === 1) {
    const id = ids[0] as NodeId;
    return {
      corners: getWorldCorners(doc, id),
      rotation: getWorldRotation(doc, id),
      bounds: getWorldBounds(doc, id),
      single: id,
      line: doc.nodes[id]?.type === 'LINE',
    };
  }
  const bounds = unionRects(ids.map((id) => getWorldBounds(doc, id)));
  if (!bounds) return null;
  const polygon = rectToPolygon(bounds) as [Point, Point, Point, Point];
  return { corners: polygon, rotation: 0, bounds, single: null, line: false };
}

export type HandleHit =
  | { kind: 'resize'; handle: Handle }
  | { kind: 'rotate' }
  | { kind: 'line-end'; end: 0 | 1 };

const CORNER_HANDLES: readonly Handle[] = [
  { hx: -1, hy: -1 },
  { hx: 1, hy: -1 },
  { hx: 1, hy: 1 },
  { hx: -1, hy: 1 },
];
const EDGE_HANDLES: readonly Handle[] = [
  { hx: 0, hy: -1 },
  { hx: 1, hy: 0 },
  { hx: 0, hy: 1 },
  { hx: -1, hy: 0 },
];

export const CORNER_RADIUS_PX = 7;
export const EDGE_DISTANCE_PX = 5;
export const ROTATE_DISTANCE_PX = 22;

/** Which transform handle, if any, is under a screen-space point. */
export function hitHandle(frame: SelectionFrame, viewport: Viewport, screenPoint: Point): HandleHit | null {
  const s = frame.corners.map((c) => worldToScreen(viewport, c)) as [Point, Point, Point, Point];

  if (frame.line) {
    if (distance(screenPoint, s[0]) <= CORNER_RADIUS_PX + 1) return { kind: 'line-end', end: 0 };
    if (distance(screenPoint, s[1]) <= CORNER_RADIUS_PX + 1) return { kind: 'line-end', end: 1 };
    return null;
  }

  for (let i = 0; i < 4; i++) {
    if (distance(screenPoint, s[i] as Point) <= CORNER_RADIUS_PX) {
      return { kind: 'resize', handle: CORNER_HANDLES[i] as Handle };
    }
  }
  for (let i = 0; i < 4; i++) {
    const a = s[i] as Point;
    const b = s[(i + 1) % 4] as Point;
    if (distanceToSegment(screenPoint, a, b) <= EDGE_DISTANCE_PX) {
      return { kind: 'resize', handle: EDGE_HANDLES[i] as Handle };
    }
  }
  if (!pointInPolygon(screenPoint, s)) {
    for (let i = 0; i < 4; i++) {
      if (distance(screenPoint, s[i] as Point) <= ROTATE_DISTANCE_PX) return { kind: 'rotate' };
    }
  }
  return null;
}

export function pointInSelectionFrame(frame: SelectionFrame, worldPoint: Point): boolean {
  return !frame.line && pointInPolygon(worldPoint, frame.corners);
}

const RESIZE_CURSORS = ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'] as const;

const ROTATE_CURSOR =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='22' height='22' viewBox='0 0 22 22'%3E%3Cpath d='M5 13a6.5 6.5 0 1 0 2.2-6.9' fill='none' stroke='%23fff' stroke-width='3.4' stroke-linecap='round'/%3E%3Cpath d='M4 3.5v5h5' fill='none' stroke='%23fff' stroke-width='3.4' stroke-linecap='round' stroke-linejoin='round'/%3E%3Cpath d='M5 13a6.5 6.5 0 1 0 2.2-6.9' fill='none' stroke='%23111' stroke-width='1.6' stroke-linecap='round'/%3E%3Cpath d='M4 3.5v5h5' fill='none' stroke='%23111' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\") 11 11, crosshair";

/** The CSS cursor that matches a handle, taking the frame's rotation into account. */
export function handleCursor(hit: HandleHit, frame: SelectionFrame): string {
  if (hit.kind === 'rotate') return ROTATE_CURSOR;
  if (hit.kind === 'line-end') return 'crosshair';
  const base = (Math.atan2(hit.handle.hy, hit.handle.hx) * 180) / Math.PI;
  const angle = (((base + frame.rotation) % 180) + 180) % 180;
  return RESIZE_CURSORS[Math.round(angle / 45) % 4] as string;
}
