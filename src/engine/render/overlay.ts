import {
  annotationsOn,
  applyToPoint,
  connectionsOn,
  devStatusList,
  flowsOf,
  getWorldBounds,
  frameGuides,
  getChildIds,
  getTangent,
  handlesOf,
  isVector,
  layoutGridGeometry,
  getWorldCorners,
  getWorldMatrix,
  getWorldRotation,
  isFrame,
  isLayer,
  isPage,
  rectToPolygon,
  type Document,
  type NodeId,
  type NodeMap,
  type Point,
  type DistanceMark,
  type Rect,
  type SnapGuide,
} from '../../core';
import { ARC_HANDLE_RADIUS_PX, arcHandles } from '../input/arcHandles';
import { CONNECTOR_RADIUS_PX, connectionCurve, connectorHandle, type ConnectionCurve } from '../input/connections';
import { GRADIENT_HANDLE_RADIUS_PX, gradientHandles } from '../input/gradientHandles';
import { getSelectionFrame } from '../input/selectionFrame';
import type { VectorOverlay } from '../input/vectorTool';
import type { PaintEdit } from '../../state/editorStore';
import { worldToScreen, type Size, type Viewport } from '../viewport';
import { traceLayerPath } from './paint';
import { drawFrameGuides, drawGuides, drawRulers, type RulerTheme } from './rulers';

export const ACCENT = '#0d99ff';
const ACCENT_FILL = 'rgba(13, 153, 255, 0.1)';
const LABEL_COLOR = '#a0a0a8';
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
  /** Distances to draw with their lengths: equal gaps while moving, or what Alt measures. */
  distances?: readonly DistanceMark[];
  /** Edges carried on to a measured distance, drawn dashed. */
  distanceGuides?: readonly SnapGuide[];
  /** Draw the layout grids of frames. On by default. */
  showLayoutGrids?: boolean;
  /** Draw the rulers and the page's ruler guides. Off by default. */
  showRulers?: boolean;
  /** The application's theme, which the rulers follow. Dark by default. */
  theme?: RulerTheme;
  /** The points, handles and pen preview of a vector that is being edited or drawn. */
  vector?: VectorOverlay | null;
  /** The paint whose handles are shown on the canvas, if one is being edited there. */
  paintEdit?: PaintEdit | null;
  /**
   * Set while the Prototype tab is open: the connections between layers are
   * drawn, with where flows start and the handle a connection is dragged
   * from; `connecting` is a connection being dragged, to a point of the page.
   */
  prototype?: { connecting: { fromId: NodeId; to: Point } | null } | null;
  /** Set while the Inspect tab (Developer Mode) is open: notes on layers are shown as numbered pins, and what is marked for development says so. */
  inspect?: boolean;
}

/** What Developer Mode shows on the canvas: a numbered pin for each note, at the top-right corner of its layer, and the status of what is marked. */
function drawInspect(ctx: Ctx, input: OverlayInput): void {
  const { doc, pageId, viewport } = input;
  ctx.font = '600 11px Inter, system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  for (const { pageId: page, layer } of devStatusList(doc)) {
    if (page !== pageId) continue;
    const bounds = getWorldBounds(doc, layer.id);
    const corner = worldToScreen(viewport, { x: bounds.x + bounds.width, y: bounds.y });
    const text = layer.devStatus === 'READY' ? 'Ready for dev' : 'Completed';
    const width = ctx.measureText(text).width + 12;
    ctx.fillStyle = layer.devStatus === 'READY' ? '#1f9d55' : '#6b7280';
    ctx.fillRect(corner.x - width, corner.y - 22, width, 18);
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'left';
    ctx.fillText(text, corner.x - width + 6, corner.y - 13);
  }
  const perLayer = new Map<NodeId, number>();
  ctx.textAlign = 'center';
  for (const placed of annotationsOn(doc, pageId)) {
    const bounds = getWorldBounds(doc, placed.layerId);
    const corner = worldToScreen(viewport, { x: bounds.x + bounds.width, y: bounds.y });
    // Several notes on one layer sit side by side.
    const index = perLayer.get(placed.layerId) ?? 0;
    perLayer.set(placed.layerId, index + 1);
    const x = corner.x - index * 20;
    ctx.beginPath();
    ctx.arc(x, corner.y, 9, 0, Math.PI * 2);
    ctx.fillStyle = '#f59e0b';
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = '#1a1a1a';
    ctx.fillText(String(placed.number), x, corner.y + 0.5);
  }
  ctx.textAlign = 'left';
}

/** A prototype connection: a curve with a dot where it starts and an arrowhead where it ends. */
function drawConnection(ctx: Ctx, curve: ConnectionCurve, dashed: boolean): void {
  ctx.strokeStyle = ACCENT;
  ctx.fillStyle = ACCENT;
  ctx.lineWidth = 1.5;
  ctx.setLineDash(dashed ? [5, 4] : []);
  ctx.beginPath();
  ctx.moveTo(curve.from.x, curve.from.y);
  ctx.bezierCurveTo(curve.c1.x, curve.c1.y, curve.c2.x, curve.c2.y, curve.to.x, curve.to.y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.arc(curve.from.x, curve.from.y, 3, 0, Math.PI * 2);
  ctx.fill();
  // The arrowhead points the way the curve arrives.
  const angle = Math.atan2(curve.to.y - curve.c2.y, curve.to.x - curve.c2.x) || 0;
  ctx.save();
  ctx.translate(curve.to.x, curve.to.y);
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(-9, -4.5);
  ctx.lineTo(-9, 4.5);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** Everything the Prototype tab shows on the canvas. */
function drawPrototype(ctx: Ctx, input: OverlayInput): void {
  const { doc, pageId, viewport } = input;
  for (const connection of connectionsOn(doc, pageId)) {
    drawConnection(ctx, connectionCurve(viewport, getWorldBounds(doc, connection.fromId), getWorldBounds(doc, connection.toId)), connection.type !== 'NAVIGATE');
  }
  // Where each flow starts: its name on a tab at the frame's top-left corner, outside it.
  ctx.font = '600 11px Inter, system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  for (const flow of flowsOf(doc, pageId)) {
    const bounds = getWorldBounds(doc, flow.startId);
    const corner = worldToScreen(viewport, { x: bounds.x, y: bounds.y });
    const text = `▶ ${flow.name}`;
    const width = ctx.measureText(text).width + 12;
    ctx.fillStyle = ACCENT;
    ctx.fillRect(corner.x - width - 6, corner.y, width, 20);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(text, corner.x - width, corner.y + 10);
  }
  if (input.prototype?.connecting) {
    const { fromId, to } = input.prototype.connecting;
    if (isLayer(doc.nodes[fromId])) drawConnection(ctx, connectionCurve(viewport, getWorldBounds(doc, fromId), to), false);
  } else if (input.showHandles) {
    const handle = connectorHandle(doc, input.selection, viewport);
    if (handle) {
      ctx.beginPath();
      ctx.arc(handle.screen.x, handle.screen.y, CONNECTOR_RADIUS_PX, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(handle.screen.x - 3, handle.screen.y);
      ctx.lineTo(handle.screen.x + 3, handle.screen.y);
      ctx.moveTo(handle.screen.x, handle.screen.y - 3);
      ctx.lineTo(handle.screen.x, handle.screen.y + 3);
      ctx.stroke();
    }
  }
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
    traceLayerPath(ctx, node, 0, 'stroke');
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
      ctx.fillStyle = '#ffffff';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, -textWidth / 2, 16);
      ctx.restore();
    }
  }

  // The round handles that shape a selected ellipse's arc: its start, its end and its hole.
  const arc = input.showHandles ? arcHandles(doc, selection, viewport) : null;
  if (arc) {
    for (const { screen } of arc.points) {
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, ARC_HANDLE_RADIUS_PX, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  // A gradient being edited on the canvas: a line from where it starts to where it ends, with a handle on each.
  const gradient = gradientHandles(doc, input.paintEdit ?? null, viewport);
  if (gradient) {
    ctx.beginPath();
    ctx.moveTo(gradient.from.x, gradient.from.y);
    ctx.lineTo(gradient.to.x, gradient.to.y);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 1;
    ctx.stroke();
    for (const [point, start] of [
      [gradient.from, true],
      [gradient.to, false],
    ] as const) {
      ctx.beginPath();
      ctx.arc(point.x, point.y, GRADIENT_HANDLE_RADIUS_PX, 0, Math.PI * 2);
      // The start is hollow, the end solid.
      ctx.fillStyle = start ? '#ffffff' : ACCENT;
      ctx.fill();
      ctx.strokeStyle = start ? ACCENT : '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  if (input.vector) drawVectorEditing(ctx, doc, viewport, input.vector);

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

  if (input.distances && input.distances.length > 0) drawDistances(ctx, viewport, input.distances, input.distanceGuides ?? []);

  if (input.marquee) {
    const s = rectToPolygon(input.marquee).map(toScreen);
    polygon(ctx, s);
    ctx.fillStyle = ACCENT_FILL;
    ctx.fill();
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  if (input.prototype) drawPrototype(ctx, input);
  if (input.inspect) drawInspect(ctx, input);

  // Ruler guides run across everything; the rulers themselves sit on top of it all.
  if (input.showRulers) {
    const page = doc.nodes[pageId];
    const guides = isPage(page) ? page.guides : [];
    drawGuides(ctx, { viewport, size, guides });
    drawFrameGuides(ctx, viewport, frameGuides(doc, pageId));
    drawRulers(ctx, { viewport, size, guides, selection: frame ? frame.bounds : null, theme: input.theme });
  }

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return { labels };
}

/** Half the length of the little bar across each end of a distance. */
const DISTANCE_TICK = 4;
const DISTANCE_LABEL_HEIGHT = 16;

/**
 * Where the number of a distance is drawn, in screen pixels: below the middle
 * of a horizontal run, to the right of the middle of a vertical one.
 */
export function distanceLabelBox(mark: DistanceMark, viewport: Viewport, textWidth: number): { x: number; y: number; width: number; height: number } {
  const a = worldToScreen(viewport, mark.axis === 'x' ? { x: mark.from, y: mark.at } : { x: mark.at, y: mark.from });
  const b = worldToScreen(viewport, mark.axis === 'x' ? { x: mark.to, y: mark.at } : { x: mark.at, y: mark.to });
  const width = Math.ceil(textWidth) + 8;
  const cx = (a.x + b.x) / 2;
  const cy = (a.y + b.y) / 2;
  return mark.axis === 'x'
    ? { x: Math.round(cx - width / 2), y: Math.round(cy + 6), width, height: DISTANCE_LABEL_HEIGHT }
    : { x: Math.round(cx + 6), y: Math.round(cy - DISTANCE_LABEL_HEIGHT / 2), width, height: DISTANCE_LABEL_HEIGHT };
}

/**
 * Draws distances: each a line with a short bar across both ends and its
 * length in a label beside its middle. Edges carried on to a distance are
 * dashed lines.
 */
function drawDistances(ctx: Ctx, viewport: Viewport, marks: readonly DistanceMark[], guides: readonly SnapGuide[]): void {
  ctx.save();
  ctx.strokeStyle = GUIDE_COLOR;
  ctx.lineWidth = 1;
  if (guides.length > 0) {
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    for (const guide of guides) {
      const a = worldToScreen(viewport, guide.axis === 'x' ? { x: guide.position, y: guide.from } : { x: guide.from, y: guide.position });
      const b = worldToScreen(viewport, guide.axis === 'x' ? { x: guide.position, y: guide.to } : { x: guide.to, y: guide.position });
      ctx.moveTo(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5);
      ctx.lineTo(Math.round(b.x) + 0.5, Math.round(b.y) + 0.5);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.font = LABEL_FONT;
  ctx.textBaseline = 'middle';
  for (const mark of marks) {
    const a = worldToScreen(viewport, mark.axis === 'x' ? { x: mark.from, y: mark.at } : { x: mark.at, y: mark.from });
    const b = worldToScreen(viewport, mark.axis === 'x' ? { x: mark.to, y: mark.at } : { x: mark.at, y: mark.to });
    const ax = Math.round(a.x) + 0.5;
    const ay = Math.round(a.y) + 0.5;
    const bx = Math.round(b.x) + 0.5;
    const by = Math.round(b.y) + 0.5;
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    if (mark.axis === 'x') {
      ctx.moveTo(ax, ay - DISTANCE_TICK);
      ctx.lineTo(ax, ay + DISTANCE_TICK);
      ctx.moveTo(bx, by - DISTANCE_TICK);
      ctx.lineTo(bx, by + DISTANCE_TICK);
    } else {
      ctx.moveTo(ax - DISTANCE_TICK, ay);
      ctx.lineTo(ax + DISTANCE_TICK, ay);
      ctx.moveTo(bx - DISTANCE_TICK, by);
      ctx.lineTo(bx + DISTANCE_TICK, by);
    }
    ctx.stroke();
    const text = formatSize(Math.abs(mark.to - mark.from));
    const box = distanceLabelBox(mark, viewport, ctx.measureText(text).width);
    ctx.fillStyle = GUIDE_COLOR;
    ctx.beginPath();
    ctx.rect(box.x, box.y, box.width, box.height);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.fillText(text, box.x + 4, box.y + box.height / 2);
  }
  ctx.restore();
}

const POINT_SIZE = 7;
const HANDLE_RADIUS = 3;

/**
 * Draws a vector's points as squares (filled when selected), the handles of
 * the selected points as round knobs on a line, and the segment the pen
 * would add next. All in screen pixels.
 */
function drawVectorEditing(ctx: Ctx, doc: Document, viewport: Viewport, edit: VectorOverlay): void {
  const node = edit.id ? doc.nodes[edit.id] : undefined;
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  if (edit.preview) {
    const from = worldToScreen(viewport, edit.preview.from);
    const to = worldToScreen(viewport, edit.preview.to);
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    if (edit.preview.control) {
      const control = worldToScreen(viewport, edit.preview.control);
      ctx.bezierCurveTo(control.x, control.y, to.x, to.y, to.x, to.y);
    } else ctx.lineTo(to.x, to.y);
    ctx.strokeStyle = ACCENT;
    ctx.stroke();
  }
  const square = (p: Point, size: number, filled: boolean): void => {
    ctx.beginPath();
    ctx.rect(Math.round(p.x) - size / 2, Math.round(p.y) - size / 2, size, size);
    ctx.fillStyle = filled ? ACCENT : '#ffffff';
    ctx.fill();
    ctx.strokeStyle = filled ? '#ffffff' : ACCENT;
    ctx.stroke();
  };
  if (isVector(node)) {
    const matrix = getWorldMatrix(doc, node.id);
    const at = (p: Point): Point => worldToScreen(viewport, applyToPoint(matrix, p));
    const selected = new Set(edit.selected);
    for (const vertex of edit.selected) {
      const point = node.network.vertices[vertex];
      if (!point) continue;
      const origin = at(point);
      for (const ref of handlesOf(node.network, vertex)) {
        const tangent = getTangent(node.network, ref);
        if (tangent.x === 0 && tangent.y === 0) continue;
        const tip = at({ x: point.x + tangent.x, y: point.y + tangent.y });
        ctx.beginPath();
        ctx.moveTo(origin.x, origin.y);
        ctx.lineTo(tip.x, tip.y);
        ctx.strokeStyle = ACCENT;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(tip.x, tip.y, HANDLE_RADIUS, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.stroke();
      }
    }
    node.network.vertices.forEach((point, index) => {
      const emphasised = index === edit.hoverVertex || index === edit.penVertex;
      square(at(point), emphasised ? POINT_SIZE + 2 : POINT_SIZE, selected.has(index));
    });
  }
  if (edit.start) square(worldToScreen(viewport, edit.start), POINT_SIZE, true);
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
