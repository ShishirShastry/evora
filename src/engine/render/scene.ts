import {
  expandRect,
  getChildIds,
  getWorldBounds,
  getWorldMatrix,
  hasVisiblePaint,
  isLayer,
  isPage,
  rectsIntersect,
  unionRects,
  type Document,
  type LayerNode,
  type NodeId,
  type NodeMap,
  type Rect,
} from '../../core';
import { visibleRect, type Size, type Viewport } from '../viewport';
import { paintToCss, rgbToCss, traceLayerPath } from './paint';

export interface RenderStats {
  /** Layers actually painted. */
  drawn: number;
  /** Layers (with their subtrees) skipped because they are outside the viewport. */
  culled: number;
}

/** Creates a scratch canvas of the given pixel size. Injected so the renderer has no DOM dependency. */
export type CanvasFactory = (pixelWidth: number, pixelHeight: number) => HTMLCanvasElement | OffscreenCanvas;

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface RenderOptions {
  /** Size of the canvas in CSS pixels. */
  size: Size;
  /** Device pixel ratio the canvas backing store was sized with. */
  dpr: number;
  viewport: Viewport;
  /** Needed only when a layer with partial opacity must be composited as a group. */
  createCanvas?: CanvasFactory;
  /** Paint the page background. Off for exports that need transparency. */
  background?: boolean;
}

const renderBoundsCache = new WeakMap<NodeMap, Map<NodeId, Rect>>();

/**
 * Page-space bounds of everything a layer paints: its box, its stroke, and for
 * a frame that does not clip, its descendants too. Used for culling.
 */
export function getRenderBounds(doc: Document, id: NodeId): Rect {
  let cache = renderBoundsCache.get(doc.nodes);
  if (!cache) {
    cache = new Map();
    renderBoundsCache.set(doc.nodes, cache);
  }
  const cached = cache.get(id);
  if (cached) return cached;
  const node = doc.nodes[id];
  let bounds = getWorldBounds(doc, id);
  if (isLayer(node)) {
    if (node.strokeWeight > 0 && node.strokes.length > 0) bounds = expandRect(bounds, node.strokeWeight);
    if ((node.type === 'FRAME' && !node.clipsContent) || node.type === 'GROUP') {
      const parts = [bounds];
      for (const childId of getChildIds(doc, id)) {
        const child = doc.nodes[childId];
        if (isLayer(child) && child.visible) parts.push(getRenderBounds(doc, childId));
      }
      bounds = unionRects(parts) ?? bounds;
    }
  }
  cache.set(id, bounds);
  return bounds;
}

/**
 * Paints one page of a document. The same function renders the editor canvas
 * and, with an identity viewport on an offscreen canvas, image exports.
 */
export function renderScene(ctx: Ctx, doc: Document, pageId: NodeId, options: RenderOptions): RenderStats {
  const { size, dpr, viewport } = options;
  const stats: RenderStats = { drawn: 0, culled: 0 };
  const page = doc.nodes[pageId];
  const pixelWidth = Math.round(size.width * dpr);
  const pixelHeight = Math.round(size.height * dpr);

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.clearRect(0, 0, pixelWidth, pixelHeight);
  if (!isPage(page)) return stats;
  if (options.background !== false) {
    ctx.fillStyle = rgbToCss(page.backgroundColor);
    ctx.fillRect(0, 0, pixelWidth, pixelHeight);
  }

  const scale = viewport.zoom * dpr;
  const offsetX = -viewport.x * scale;
  const offsetY = -viewport.y * scale;
  const visible = visibleRect(viewport, size);
  const scratch: (HTMLCanvasElement | OffscreenCanvas)[] = [];

  const setLayerTransform = (target: Ctx, id: NodeId): void => {
    const m = getWorldMatrix(doc, id);
    target.setTransform(
      m[0] * scale,
      m[1] * scale,
      m[2] * scale,
      m[3] * scale,
      m[4] * scale + offsetX,
      m[5] * scale + offsetY,
    );
  };

  const fill = (target: Ctx, node: LayerNode): void => {
    if (node.type === 'LINE') return;
    for (const paint of node.fills) {
      if (!paint.visible || paint.opacity <= 0) continue;
      traceLayerPath(target, node);
      target.fillStyle = paintToCss(paint);
      target.fill();
    }
  };

  const stroke = (target: Ctx, node: LayerNode): void => {
    if (node.strokeWeight <= 0) return;
    const align = node.type === 'LINE' ? 'CENTER' : node.strokeAlign;
    for (const paint of node.strokes) {
      if (!paint.visible || paint.opacity <= 0) continue;
      target.strokeStyle = paintToCss(paint);
      target.lineJoin = 'miter';
      if (align === 'CENTER') {
        traceLayerPath(target, node);
        target.lineWidth = node.strokeWeight;
        target.stroke();
        continue;
      }
      // Inside and outside strokes: draw a double-width stroke and keep only
      // the half on the wanted side of the outline.
      target.save();
      if (align === 'INSIDE') {
        traceLayerPath(target, node);
        target.clip();
      } else {
        traceLayerPath(target, node);
        const pad = node.strokeWeight * 2 + 2;
        target.rect(-pad, -pad, node.width + pad * 2, node.height + pad * 2);
        target.clip('evenodd');
      }
      traceLayerPath(target, node);
      target.lineWidth = node.strokeWeight * 2;
      target.stroke();
      target.restore();
    }
  };

  const drawChildren = (target: Ctx, parentId: NodeId): void => {
    for (const childId of getChildIds(doc, parentId)) drawLayer(target, childId);
  };

  const paintLayer = (target: Ctx, id: NodeId, node: LayerNode): void => {
    setLayerTransform(target, id);
    fill(target, node);
    if (node.type === 'FRAME' || node.type === 'GROUP') {
      if (getChildIds(doc, id).length > 0) {
        target.save();
        if (node.type === 'FRAME' && node.clipsContent) {
          traceLayerPath(target, node);
          target.clip();
        }
        drawChildren(target, id);
        target.restore();
        setLayerTransform(target, id);
      }
    }
    stroke(target, node);
  };

  const drawLayer = (target: Ctx, id: NodeId): void => {
    const node = doc.nodes[id];
    if (!isLayer(node) || !node.visible || node.opacity <= 0) return;
    if (!rectsIntersect(getRenderBounds(doc, id), visible)) {
      stats.culled++;
      return;
    }
    stats.drawn++;

    if (node.opacity >= 1) {
      paintLayer(target, id, node);
      return;
    }
    // A single paint can simply be drawn translucent. Anything more must be
    // composited as a group, or overlapping parts would show through each other.
    const paintCount =
      (node.type !== 'LINE' && hasVisiblePaint(node.fills) ? node.fills.length : 0) +
      (node.strokeWeight > 0 ? node.strokes.length : 0);
    const isGroup = (node.type === 'FRAME' || node.type === 'GROUP') && getChildIds(doc, id).length > 0;
    if ((!isGroup && paintCount <= 1) || !options.createCanvas) {
      const previous = target.globalAlpha;
      target.globalAlpha = previous * node.opacity;
      paintLayer(target, id, node);
      target.globalAlpha = previous;
      return;
    }
    const canvas = scratch.pop() ?? options.createCanvas(pixelWidth, pixelHeight);
    const layerCtx = canvas.getContext('2d') as Ctx | null;
    if (!layerCtx) {
      paintLayer(target, id, node);
      return;
    }
    layerCtx.setTransform(1, 0, 0, 1, 0, 0);
    layerCtx.globalAlpha = 1;
    layerCtx.clearRect(0, 0, pixelWidth, pixelHeight);
    paintLayer(layerCtx, id, node);
    target.save();
    target.setTransform(1, 0, 0, 1, 0, 0);
    target.globalAlpha = target.globalAlpha * node.opacity;
    target.drawImage(canvas, 0, 0);
    target.restore();
    scratch.push(canvas);
  };

  drawChildren(ctx, pageId);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return stats;
}
