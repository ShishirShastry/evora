import {
  getChildIds,
  getWorldCorners,
  getWorldMatrix,
  getWorldRotation,
  isFrame,
  isLayer,
  rectToPolygon,
  type Document,
  type NodeId,
  type Point,
  type Rect,
} from '../../core';
import { getSelectionFrame } from '../input/selectionFrame';
import { worldToScreen, type Size, type Viewport } from '../viewport';
import { traceLayerPath } from './paint';

export const ACCENT = '#19c2b3';
const ACCENT_FILL = 'rgba(25, 194, 179, 0.12)';
const LABEL_COLOR = '#8d9797';
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
}

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
