import type { Point, Rect } from '../core/math/geometry';

/**
 * The visible part of the page. `x, y` is the page-space point at the top-left
 * corner of the canvas; `zoom` is screen pixels per page unit.
 */
export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

export interface Size {
  width: number;
  height: number;
}

export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 256;
export const ZOOM_STEPS = [0.02, 0.03, 0.06, 0.13, 0.25, 0.5, 1, 2, 4, 8, 16, 32, 64, 128, 256];
export const DEFAULT_VIEWPORT: Viewport = { x: 0, y: 0, zoom: 1 };

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

export function screenToWorld(v: Viewport, p: Point): Point {
  return { x: v.x + p.x / v.zoom, y: v.y + p.y / v.zoom };
}

export function worldToScreen(v: Viewport, p: Point): Point {
  return { x: (p.x - v.x) * v.zoom, y: (p.y - v.y) * v.zoom };
}

/** Changes the zoom while keeping the page point under `screenPoint` where it is. */
export function zoomAt(v: Viewport, screenPoint: Point, zoom: number): Viewport {
  const next = clampZoom(zoom);
  const world = screenToWorld(v, screenPoint);
  return { x: world.x - screenPoint.x / next, y: world.y - screenPoint.y / next, zoom: next };
}

export function panBy(v: Viewport, screenDx: number, screenDy: number): Viewport {
  return { x: v.x - screenDx / v.zoom, y: v.y - screenDy / v.zoom, zoom: v.zoom };
}

/** A viewport that shows `rect` centred with `padding` screen pixels around it. */
export function fitRect(rect: Rect, size: Size, padding = 48, maxZoom = MAX_ZOOM): Viewport {
  const availableW = Math.max(1, size.width - padding * 2);
  const availableH = Math.max(1, size.height - padding * 2);
  const zoom = clampZoom(
    Math.min(maxZoom, rect.width > 0 ? availableW / rect.width : maxZoom, rect.height > 0 ? availableH / rect.height : maxZoom),
  );
  return {
    x: rect.x + rect.width / 2 - size.width / zoom / 2,
    y: rect.y + rect.height / 2 - size.height / zoom / 2,
    zoom,
  };
}

/** The page-space rectangle currently visible on a canvas of `size`. */
export function visibleRect(v: Viewport, size: Size): Rect {
  return { x: v.x, y: v.y, width: size.width / v.zoom, height: size.height / v.zoom };
}

export function nextZoomStep(zoom: number, direction: 1 | -1): number {
  if (direction === 1) return ZOOM_STEPS.find((step) => step > zoom * 1.001) ?? MAX_ZOOM;
  return [...ZOOM_STEPS].reverse().find((step) => step < zoom * 0.999) ?? MIN_ZOOM;
}
