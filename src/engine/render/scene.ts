import {
  approximateMeasurer,
  expandRect,
  getChildIds,
  getWorldBounds,
  getWorldMatrix,
  getWorldRotation,
  hasVisiblePaint,
  isLayer,
  isPage,
  layoutText,
  networkGeometry,
  rectsIntersect,
  unionRects,
  type BlendMode,
  type BlurEffect,
  type Document,
  type LayerNode,
  type NodeId,
  type NodeMap,
  type Rect,
  type ShadowEffect,
  type StrokeAlign,
  type StrokeCap,
  type StrokeJoin,
  type TextMeasurer,
  type TextNode,
} from '../../core';
import type { ImageSource } from '../images/imageCache';
import { applyTextStyle } from '../text/measure';
import { visibleRect, type Size, type Viewport } from '../viewport';
import { clipPath, fillPath, fillRuleOf, fillWithPaint, paintStyle, rgbToCss, traceLayerPath } from './paint';

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
  /**
   * Needed for anything that must be composited as a whole: a group with
   * partial opacity, a blend mode, a layer blur, or the shadow of a group.
   * Without it those are painted directly, which is close but not exact.
   */
  createCanvas?: CanvasFactory;
  /** Paint the page background. Off for exports that need transparency. */
  background?: boolean;
  /** Measures text for layout. Must be the measurer the editor sizes text layers with. */
  measurer?: TextMeasurer;
  /** Layers to leave out, for example a text layer that is being edited in place. */
  hiddenIds?: ReadonlySet<NodeId>;
  /** Decoded images for image fills. Without it, image fills are drawn as placeholders. */
  images?: ImageSource;
}

const CAPS: Record<StrokeCap, CanvasLineCap> = { NONE: 'butt', ROUND: 'round', SQUARE: 'square' };
const JOINS: Record<StrokeJoin, CanvasLineJoin> = { MITER: 'miter', BEVEL: 'bevel', ROUND: 'round' };
const BLENDS: Record<BlendMode, GlobalCompositeOperation> = {
  NORMAL: 'source-over',
  DARKEN: 'darken',
  MULTIPLY: 'multiply',
  COLOR_BURN: 'color-burn',
  LIGHTEN: 'lighten',
  SCREEN: 'screen',
  COLOR_DODGE: 'color-dodge',
  OVERLAY: 'overlay',
  SOFT_LIGHT: 'soft-light',
  HARD_LIGHT: 'hard-light',
  DIFFERENCE: 'difference',
  EXCLUSION: 'exclusion',
  HUE: 'hue',
  SATURATION: 'saturation',
  COLOR: 'color',
  LUMINOSITY: 'luminosity',
};

/**
 * Where a layer's stroke actually goes. A line has no inside, and neither has
 * a vector with a loose end or a branch, so those are always stroked along
 * their centre.
 */
export function strokeAlignOf(node: LayerNode): StrokeAlign {
  if (node.type === 'LINE') return 'CENTER';
  if (node.type === 'VECTOR' && !networkGeometry(node.network).closed) return 'CENTER';
  return node.strokeAlign;
}

const renderBoundsCache = new WeakMap<NodeMap, Map<NodeId, Rect>>();

/**
 * Page-space bounds of everything a layer paints: its box, its stroke, its
 * shadows and blur, and for a group or a frame that does not clip, its
 * descendants too. Used for culling and for sizing offscreen compositing.
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
    if (node.strokeWeight > 0 && node.strokes.length > 0) {
      // The mitred tip of a sharp corner of a vector reaches well beyond the corner itself.
      const sharp = node.type === 'VECTOR' && node.strokeJoin === 'MITER';
      bounds = expandRect(bounds, node.strokeWeight * (sharp ? (strokeAlignOf(node) === 'OUTSIDE' ? 10 : 5) : 1));
    }
    if ((node.type === 'FRAME' && !node.clipsContent) || node.type === 'GROUP') {
      const parts = [bounds];
      for (const childId of getChildIds(doc, id)) {
        const child = doc.nodes[childId];
        if (isLayer(child) && child.visible) parts.push(getRenderBounds(doc, childId));
      }
      bounds = unionRects(parts) ?? bounds;
    }
    let reach = 0;
    for (const effect of node.effects) {
      if (!effect.visible) continue;
      if (effect.type === 'DROP_SHADOW') {
        reach = Math.max(reach, Math.abs(effect.offsetX) + Math.abs(effect.offsetY) + effect.blur + Math.max(0, effect.spread));
      } else if (effect.type === 'LAYER_BLUR') reach = Math.max(reach, effect.radius * 3);
    }
    if (reach > 0) bounds = expandRect(bounds, reach);
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
  const measurer = options.measurer ?? approximateMeasurer;
  /**
   * A shadow is drawn without the thing that casts it by drawing that thing
   * this far off the canvas and offsetting its shadow back by the same amount.
   */
  const away = (pixelWidth + pixelHeight) * 2 + 4000;

  const setLayerTransform = (target: Ctx, id: NodeId, shiftX = 0): void => {
    const m = getWorldMatrix(doc, id);
    target.setTransform(m[0] * scale, m[1] * scale, m[2] * scale, m[3] * scale, m[4] * scale + offsetX + shiftX, m[5] * scale + offsetY);
  };

  /** Applies a shadow's settings to a context. Offsets follow the layer's own axes, so a rotated layer casts a rotated shadow. */
  const setShadow = (target: Ctx, id: NodeId, shadow: ShadowEffect, shiftX: number): void => {
    const r = (getWorldRotation(doc, id) * Math.PI) / 180;
    const cos = Math.cos(r);
    const sin = Math.sin(r);
    target.shadowColor = rgbToCss(shadow.color, shadow.opacity);
    target.shadowBlur = shadow.blur * scale;
    target.shadowOffsetX = (shadow.offsetX * cos - shadow.offsetY * sin) * scale + shiftX;
    target.shadowOffsetY = (shadow.offsetX * sin + shadow.offsetY * cos) * scale;
  };

  const textLines = (target: Ctx, node: TextNode, draw: (text: string, x: number, baseline: number, width: number) => void): void => {
    const layout = layoutText(node, measurer);
    applyTextStyle(target, node);
    target.textBaseline = 'alphabetic';
    target.textAlign = 'left';
    for (const line of layout.lines) if (line.text !== '') draw(line.text, line.x, line.baseline, line.width);
  };

  /** Paints a text layer: its fills colour the glyphs, its strokes outline them. */
  const drawText = (target: Ctx, node: TextNode): void => {
    const thickness = Math.max(1, node.fontSize / 16);
    const decorationOffset =
      node.textDecoration === 'UNDERLINE' ? node.fontSize * 0.12 : node.textDecoration === 'STRIKETHROUGH' ? -node.fontSize * 0.3 : null;
    const alpha = target.globalAlpha;
    for (const paint of node.fills) {
      if (!paint.visible || paint.opacity <= 0) continue;
      target.globalAlpha = alpha * paint.opacity;
      target.fillStyle = paintStyle(target, paint, node.width, node.height);
      textLines(target, node, (text, x, baseline, width) => {
        target.fillText(text, x, baseline);
        if (decorationOffset !== null) target.fillRect(x, baseline + decorationOffset, width, thickness);
      });
    }
    if (node.strokeWeight > 0) {
      for (const paint of node.strokes) {
        if (!paint.visible || paint.opacity <= 0) continue;
        target.globalAlpha = alpha * paint.opacity;
        target.strokeStyle = paintStyle(target, paint, node.width, node.height);
        target.lineWidth = node.strokeWeight;
        target.lineJoin = 'round';
        target.setLineDash([]);
        textLines(target, node, (text, x, baseline) => target.strokeText(text, x, baseline));
      }
    }
    target.globalAlpha = alpha;
    applyTextStyle(target, { ...node, letterSpacing: 0 });
  };

  const fill = (target: Ctx, node: LayerNode): void => {
    if (node.type === 'LINE' || node.type === 'TEXT') return;
    for (const paint of node.fills) {
      if (!paint.visible || paint.opacity <= 0) continue;
      traceLayerPath(target, node);
      fillWithPaint(target, paint, node.width, node.height, options.images, fillRuleOf(node));
    }
  };

  const stroke = (target: Ctx, node: LayerNode): void => {
    if (node.strokeWeight <= 0 || node.type === 'TEXT') return;
    const align = strokeAlignOf(node);
    const rule = fillRuleOf(node);
    const alpha = target.globalAlpha;
    target.lineCap = CAPS[node.strokeCap];
    target.lineJoin = JOINS[node.strokeJoin];
    target.setLineDash(node.dashPattern);
    for (const paint of node.strokes) {
      if (!paint.visible || paint.opacity <= 0) continue;
      target.globalAlpha = alpha * paint.opacity;
      target.strokeStyle = paintStyle(target, paint, node.width, node.height);
      if (align === 'CENTER') {
        traceLayerPath(target, node, 0, 'stroke');
        target.lineWidth = node.strokeWeight;
        target.stroke();
        continue;
      }
      // Inside and outside strokes: draw a double-width stroke and keep only
      // the half on the wanted side of the outline.
      target.save();
      traceLayerPath(target, node);
      if (align === 'INSIDE') clipPath(target, rule);
      else {
        const pad = node.strokeWeight * 2 + 2;
        target.rect(-pad, -pad, node.width + pad * 2, node.height + pad * 2);
        target.clip('evenodd');
      }
      traceLayerPath(target, node, 0, 'stroke');
      target.lineWidth = node.strokeWeight * 2;
      target.stroke();
      target.restore();
    }
    target.globalAlpha = alpha;
    target.setLineDash([]);
  };

  /** Draws a layer's drop shadow from its outline, without drawing the layer. */
  const drawOutlineShadow = (target: Ctx, id: NodeId, node: LayerNode, shadow: ShadowEffect): void => {
    target.save();
    setLayerTransform(target, id, -away);
    setShadow(target, id, shadow, away);
    target.fillStyle = '#000';
    target.strokeStyle = '#000';
    if (node.type === 'TEXT') {
      textLines(target, node, (text, x, baseline) => target.fillText(text, x, baseline));
    } else {
      const filled = node.type !== 'LINE' && hasVisiblePaint(node.fills);
      const stroked = node.strokeWeight > 0 && hasVisiblePaint(node.strokes);
      const boxLike = node.type === 'RECTANGLE' || node.type === 'ELLIPSE' || node.type === 'FRAME';
      const align = strokeAlignOf(node);
      if (filled) {
        traceLayerPath(target, node, boxLike ? -shadow.spread : 0);
        fillPath(target, fillRuleOf(node));
      }
      // An inside stroke lies within the fill, which already cast the shadow.
      if (stroked && !(filled && align === 'INSIDE')) {
        traceLayerPath(target, node, 0, 'stroke');
        target.lineCap = CAPS[node.strokeCap];
        target.lineJoin = JOINS[node.strokeJoin];
        target.setLineDash(node.dashPattern);
        target.lineWidth = align === 'OUTSIDE' ? node.strokeWeight * 2 : node.strokeWeight;
        target.stroke();
      }
    }
    target.restore();
  };

  /** Draws a shadow inside the layer's outline: the shadow of everything around the outline, clipped to it. */
  const drawInnerShadow = (target: Ctx, id: NodeId, node: LayerNode, shadow: ShadowEffect): void => {
    target.save();
    setLayerTransform(target, id);
    traceLayerPath(target, node);
    clipPath(target, fillRuleOf(node));
    setLayerTransform(target, id, -away);
    setShadow(target, id, shadow, away);
    const boxLike = node.type === 'RECTANGLE' || node.type === 'ELLIPSE' || node.type === 'FRAME';
    traceLayerPath(target, node, boxLike ? shadow.spread : 0);
    const pad = (Math.abs(shadow.offsetX) + Math.abs(shadow.offsetY) + shadow.blur + Math.abs(shadow.spread)) * 2 + 20;
    target.rect(-pad, -pad, node.width + pad * 2, node.height + pad * 2);
    target.fillStyle = '#000';
    target.fill('evenodd');
    target.restore();
  };

  /** Blurs what has been painted so far, within the layer's outline. */
  const drawBackgroundBlur = (target: Ctx, id: NodeId, node: LayerNode, radius: number): void => {
    if (!('filter' in target) || radius <= 0) return;
    target.save();
    setLayerTransform(target, id);
    traceLayerPath(target, node);
    clipPath(target, fillRuleOf(node));
    target.setTransform(1, 0, 0, 1, 0, 0);
    target.filter = `blur(${radius * scale}px)`;
    target.drawImage(target.canvas, 0, 0);
    target.restore();
  };

  const drawChildren = (target: Ctx, parentId: NodeId): void => {
    for (const childId of getChildIds(doc, parentId)) drawLayer(target, childId);
  };

  const paintLayer = (target: Ctx, id: NodeId, node: LayerNode, innerShadows: readonly ShadowEffect[]): void => {
    setLayerTransform(target, id);
    if (node.type === 'TEXT') {
      drawText(target, node);
      return;
    }
    fill(target, node);
    if (node.type !== 'GROUP' && node.type !== 'LINE') {
      for (const shadow of innerShadows) drawInnerShadow(target, id, node, shadow);
      if (innerShadows.length > 0) setLayerTransform(target, id);
    }
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
    if (options.hiddenIds?.has(id)) return;
    const bounds = getRenderBounds(doc, id);
    if (!rectsIntersect(bounds, visible)) {
      stats.culled++;
      return;
    }
    stats.drawn++;

    const shown = node.effects.filter((effect) => effect.visible);
    const dropShadows = shown.filter((effect): effect is ShadowEffect => effect.type === 'DROP_SHADOW');
    const innerShadows = shown.filter((effect): effect is ShadowEffect => effect.type === 'INNER_SHADOW');
    const blurOf = (type: BlurEffect['type']): number =>
      shown.reduce((sum, effect) => (effect.type === type ? sum + effect.radius : sum), 0);
    const layerBlur = blurOf('LAYER_BLUR');
    const backgroundBlur = blurOf('BACKGROUND_BLUR');

    const hasChildren = (node.type === 'FRAME' || node.type === 'GROUP') && getChildIds(doc, id).length > 0;
    const paintCount =
      (node.type !== 'LINE' && hasVisiblePaint(node.fills) ? node.fills.length : 0) +
      (node.strokeWeight > 0 ? node.strokes.length : 0);
    // A shadow can be cast from the outline alone unless what is inside sticks out of it or shows through it.
    const outlineIsSilhouette = !hasChildren || (node.type === 'FRAME' && node.clipsContent && hasVisiblePaint(node.fills));
    const composite =
      options.createCanvas !== undefined &&
      (node.blendMode !== 'NORMAL' ||
        layerBlur > 0 ||
        (node.opacity < 1 && (hasChildren || paintCount > 1)) ||
        (dropShadows.length > 0 && !outlineIsSilhouette));

    if (backgroundBlur > 0) drawBackgroundBlur(target, id, node, backgroundBlur);

    if (!composite) {
      const alpha = target.globalAlpha;
      target.globalAlpha = alpha * node.opacity;
      for (const shadow of dropShadows) drawOutlineShadow(target, id, node, shadow);
      paintLayer(target, id, node, innerShadows);
      target.globalAlpha = alpha;
      return;
    }

    // Paint the layer on its own, then place the result: with its shadows,
    // its blur, its opacity and its blend mode applied to it as a whole.
    // Only the part of the canvas the layer can touch is cleared and copied.
    const x0 = Math.max(0, Math.floor((bounds.x - viewport.x) * scale) - 2);
    const y0 = Math.max(0, Math.floor((bounds.y - viewport.y) * scale) - 2);
    const x1 = Math.min(pixelWidth, Math.ceil((bounds.x + bounds.width - viewport.x) * scale) + 2);
    const y1 = Math.min(pixelHeight, Math.ceil((bounds.y + bounds.height - viewport.y) * scale) + 2);
    const w = x1 - x0;
    const h = y1 - y0;
    if (w <= 0 || h <= 0) return;

    const canvas = scratch.pop() ?? (options.createCanvas as CanvasFactory)(pixelWidth, pixelHeight);
    const layerCtx = canvas.getContext('2d') as Ctx | null;
    if (!layerCtx) {
      paintLayer(target, id, node, innerShadows);
      return;
    }
    layerCtx.setTransform(1, 0, 0, 1, 0, 0);
    layerCtx.globalAlpha = 1;
    layerCtx.clearRect(x0, y0, w, h);
    paintLayer(layerCtx, id, node, innerShadows);

    target.save();
    target.setTransform(1, 0, 0, 1, 0, 0);
    target.globalAlpha = target.globalAlpha * node.opacity;
    target.globalCompositeOperation = BLENDS[node.blendMode];
    for (const shadow of dropShadows) {
      setShadow(target, id, shadow, away);
      target.drawImage(canvas, x0, y0, w, h, x0 - away, y0, w, h);
    }
    target.shadowColor = 'transparent';
    target.shadowBlur = 0;
    target.shadowOffsetX = 0;
    target.shadowOffsetY = 0;
    if (layerBlur > 0 && 'filter' in target) target.filter = `blur(${layerBlur * scale}px)`;
    target.drawImage(canvas, x0, y0, w, h, x0, y0, w, h);
    target.restore();
    scratch.push(canvas);
  };

  drawChildren(ctx, pageId);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return stats;
}
