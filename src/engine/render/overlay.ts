import {
  getChildIds,
  layoutGridGeometry,
  getWorldCorners,
  getWorldMatrix,
  getWorldRotation,
  isFrame,
  isLayer,
  rectToPolygon,
  type Document,
  type NodeId,
  type NodeMap,
  type Point,
  type Rect,
  type SnapGuide,
} from '../../core';
import { getSelectionFrame } from '../input/selectionFrame';
import { worldToScreen, type Size, type Viewport } from '../viewport';
import { traceLayerPath } from './paint';

export const ACCENT = '#19c2b3';
const ACCENT_FILL = 'rgba(25, 194, 179, 0.12)';
const LABEL_COLOR = '#8d9797';
const GUIDE_COLOR = '#ff4f7b';
const LABEL_FONT = '11px Inter, "Segoe UI", system-ui, sans-serif';
const LABEL_HEIGHT = 16;
const HANDLE_SIZE = 8;

/** Where a top-level frame's name is drawn, so that clicking it can select the frame. */
export interface FrameLabel {
  id: NodeId;
  /** Screen position of the frame's top-left corner. */
  origin: Point;
  /** Rotation of the label, in degrees. */
  rotation: number;
  width: number;
  height: number;
}

export interface OverlayInput {
  doc: Document;
  pageId: NodeId;
  viewport: Viewport;
  size: Size;
  dpr: number;
  selection: readonly NodeId[];
  hoveredId: NodeId | null;
  /** Marquee rectangle in page space, while one is being dragged. */
  marquee: Rect | null;
  /** Hide handles and the size badge while the selection is being transformed. */
  showHandles: boolean;
  /** Smart guides to draw while something is snapped. */
  guides?: readonly SnapGuide[];
  /** Draw the layout grids of frames. On by default. */
  showLayoutGrids?: boolean;
}

const gridFrameCache = new WeakMap<NodeMap, Map<NodeId, NodeId[]>>();

/** The visible frames on a page that have layout grids, outermost first. Cached per document snapshot. */
function framesWithGrids(doc: Document, pageId: NodeId): NodeId[] {
  let perPage = gridFrameCache.get(doc.nodes);
  if (!perPage) {
    perPage = new Map();
    gridFrameCache.set(doc.nodes, perPage);
  }
  const cached = perPage.get(pageId);
  if (cached) return cached;
  const out: NodeId[] = [];
  const walk = (parentId: NodeId): void => {
    for (const id of getChildIds(doc, parentId)) {
      const node = doc.nodes[id];
      if (!isLayer(node) || !node.visible) continue;
      if (node.type === 'FRAME' && node.layoutGrids.some((grid) => grid.visible)) out.push(id);
      if (node.type === 'FRAME' || node.type === 'GROUP') walk(id);
    }
  };
  walk(pageId);
  perPage.set(pageId, out);
  return out;
}

/** A uniform grid finer than this on screen is not drawn: it would be a solid wash. */
const MIN_GRID_CELL_PX = 4;

type Ctx = CanvasRenderingContext2D;

function polygon(ctx: Ctx, points: readonly Point[]): void {
  ctx.beginPath();
  points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  ctx.closePath();
}

function fitText(ctx: Ctx, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let cut = text;
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > maxWidth) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/**
 * Draws everything that sits above the design but is not part of it: frame
 * names, the hover outline, selection outlines and handles, and the marquee.
 * All of it is drawn in screen pixels so it stays crisp at any zoom.
 */
export function renderOverlay(ctx: Ctx, input: OverlayInput): { labels: FrameLabel[] } {
  const { doc, pageId, viewport, size, dpr, selection } = input;
  const labels: FrameLabel[] = [];
  const toScreen = (p: Point): Point => worldToScreen(viewport, p);
  const selected = new Set(selection);

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, Math.round(size.width * dpr), Math.round(size.height * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.lineJoin = 'miter';

  // Layout grids: guides over frames, never part of the design itself.
  if (input.showLayoutGrids !== false) {
    const z = viewport.zoom;
    for (const id of framesWithGrids(doc, pageId)) {
      const frame = doc.nodes[id];
      if (!isFrame(frame)) continue;
      const m = getWorldMatrix(doc, id);
      ctx.save();
      ctx.transform(m[0] * z, m[1] * z, m[2] * z, m[3] * z, (m[4] - viewport.x) * z, (m[5] - viewport.y) * z);
      ctx.beginPath();
      ctx.rect(0, 0, frame.width, frame.height);
      ctx.clip();
      for (const grid of frame.layoutGrids) {
        if (!grid.visible || grid.opacity <= 0) continue;
        const geometry = layoutGridGeometry(grid, frame.width, frame.height);
        const colour = `rgba(${Math.round(grid.color.r * 255)}, ${Math.round(grid.color.g * 255)}, ${Math.round(grid.color.b * 255)}, ${grid.opacity})`;
        if (grid.pattern === 'GRID') {
          if (grid.size * z < MIN_GRID_CELL_PX) continue;
          ctx.strokeStyle = colour;
          ctx.lineWidth = 1 / z;
          ctx.beginPath();
          for (const x of geometry.xs) {
            ctx.moveTo(x, 0);
            ctx.lineTo(x, frame.height);
          }
          for (const y of geometry.ys) {
            ctx.moveTo(0, y);
            ctx.lineTo(frame.width, y);
          }
          ctx.stroke();
        } else {
          ctx.fillStyle = colour;
          for (const band of geometry.bands) ctx.fillRect(band.x, band.y, band.width, band.height);
        }
      }
      ctx.restore();
    }
  }

  // Names of top-level frames.
  ctx.font = LABEL_FONT;
  ctx.textBaseline = 'alphabetic';
  for (const id of getChildIds(doc, pageId)) {
    const node = doc.nodes[id];
    if (!isFrame(node) || !node.visible) continue;
    const corners = getWorldCorners(doc, id);
    const origin = toScreen(corners[0]);
    const maxWidth = Math.max(24, node.width * viewport.zoom);
    if (origin.x > size.width + maxWidth || origin.y > size.height + maxWidth || origin.x < -maxWidth * 2 || origin.y < -maxWidth * 2) continue;
    const rotation = getWorldRotation(doc, id);
    const text = fitText(ctx, node.name, maxWidth);
    const width = Math.ceil(ctx.measureText(text).width);
    ctx.save();
    ctx.translate(origin.x, origin.y);
    ctx.rotate((rotation * Math.PI) / 180);
    ctx.fillStyle = selected.has(id) || input.hoveredId === id ? ACCENT : LABEL_COLOR;
    ctx.fillText(text, 0, -5);
    ctx.restore();
    labels.push({ id, origin, rotation, width, height: LABEL_HEIGHT });
  }

  // Outline in the real shape of a layer.
  const outline = (id: NodeId, lineWidth: number): void => {
    const node = doc.nodes[id];
    if (!isLayer(node)) return;
    const m = getWorldMatrix(doc, id);
    const z = viewport.zoom;
    ctx.save();
    ctx.transform(m[0] * z, m[1] * z, m[2] * z, m[3] * z, (m[4] - viewport.x) * z, (m[5] - viewport.y) * z);
    traceLayerPath(ctx, node);
    ctx.restore();
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = lineWidth;
    ctx.stroke();
  };

  if (input.hoveredId !== null && !selected.has(input.hoveredId)) outline(input.hoveredId, 2);
  for (const id of selection) outline(id, 1);

  const frame = getSelectionFrame(doc, selection);
  if (frame) {
    const s = frame.corners.map(toScreen) as [Point, Point, Point, Point];
    if (!frame.single) {
      polygon(ctx, s);
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    if (input.showHandles) {
      const handlePoints = frame.line ? [s[0], s[1]] : s;
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 1;
      for (const p of handlePoints) {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate((frame.rotation * Math.PI) / 180);
        ctx.beginPath();
        ctx.rect(-HANDLE_SIZE / 2, -HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }

      // Size badge under the bottom edge.
      const node = frame.single ? doc.nodes[frame.single] : undefined;
      const w = isLayer(node) ? node.width : frame.bounds.width;
      const h = isLayer(node) ? node.height : frame.bounds.height;
      const text = `${formatSize(w)} × ${formatSize(h)}`;
      const mid = { x: (s[2].x + s[3].x) / 2, y: (s[2].y + s[3].y) / 2 };
      ctx.font = LABEL_FONT;
      const textWidth = ctx.measureText(text).width;
      ctx.save();
      ctx.translate(mid.x, mid.y);
      ctx.rotate((frame.rotation * Math.PI) / 180);
      ctx.fillStyle = ACCENT;
      ctx.beginPath();
      ctx.rect(-textWidth / 2 - 5, 7, textWidth + 10, 17);
      ctx.fill();
      ctx.fillStyle = '#04201d';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, -textWidth / 2, 16);
      ctx.restore();
    }
  }

  // Smart guides: the lines the selection is currently snapped to.
  if (input.guides && input.guides.length > 0) {
    ctx.strokeStyle = GUIDE_COLOR;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const guide of input.guides) {
      const a = toScreen(guide.axis === 'x' ? { x: guide.position, y: guide.from } : { x: guide.from, y: guide.position });
      const b = toScreen(guide.axis === 'x' ? { x: guide.position, y: guide.to } : { x: guide.to, y: guide.position });
      // Half-pixel offsets keep 1px lines crisp.
      ctx.moveTo(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5);
      ctx.lineTo(Math.round(b.x) + 0.5, Math.round(b.y) + 0.5);
    }
    ctx.stroke();
  }

  if (input.marquee) {
    const s = rectToPolygon(input.marquee).map(toScreen);
    polygon(ctx, s);
    ctx.fillStyle = ACCENT_FILL;
    ctx.fill();
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return { labels };
}

function formatSize(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/** The frame whose name label is under a screen-space point, top-most first. */
export function hitFrameLabel(labels: readonly FrameLabel[], point: Point): NodeId | null {
  for (let i = labels.length - 1; i >= 0; i--) {
    const label = labels[i] as FrameLabel;
    const r = (-label.rotation * Math.PI) / 180;
    const dx = point.x - label.origin.x;
    const dy = point.y - label.origin.y;
    const lx = dx * Math.cos(r) - dy * Math.sin(r);
    const ly = dx * Math.sin(r) + dy * Math.cos(r);
    if (lx >= -2 && lx <= label.width + 4 && ly <= 0 && ly >= -label.height - 2) return label.id;
  }
  return null;
}
