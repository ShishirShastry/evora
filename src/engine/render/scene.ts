import {
  approximateMeasurer,
  expandRect,
  getChildIds,
  getWorldBounds,
  getWorldMatrix,
  getWorldRotation,
  hasArc,
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
  type GradientPaint,
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
  type TextRun,
} from '../../core';
import type { ImageSource } from '../images/imageCache';
import { applyTextStyle } from '../text/measure';
import { visibleRect, type Size, type Viewport } from '../viewport';
import {
  strokeSideBands,
  strokeWidthOf,
  arrowHeads,
  clipPath,
  fillPath,
  fillRuleOf,
  fillStretchedGradient,
  fillWithPaint,
  isStretchedGradient,
  paintStyle,
  rgbToCss,
  traceArrowHead,
  traceLayerPath,
  traceStrokePath,
} from './paint';

export interface RenderStats {
  /** Layers actually painted. */
  drawn: number;
  /** Layers (with their subtrees) skipped because they are outside the viewport. */
  culled: number;
}

/** Creates a scratch canvas of the given pixel size. Injected so the renderer has no DOM dependency. */
export type CanvasFactory = (pixelWidth: number, pixelHeight: number) => HTMLCanvasElement | OffscreenCanvas;

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** A rectangle of the canvas, in device pixels. */
type PixelRegion = { x: number; y: number; w: number; h: number };

/** A scratch canvas in use, and the part of it that was cleared for the job. */
interface Scratch {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  ctx: Ctx;
  region: PixelRegion;
}

/**
 * Whether shadow spread can be drawn by tracing a layer's outline narrower or
 * wider: true for boxes and whole ellipses. Every other outline is grown or
 * shrunk on a scratch canvas.
 */
function spreadsByInset(node: LayerNode): boolean {
  return node.type === 'RECTANGLE' || node.type === 'FRAME' || (node.type === 'ELLIPSE' && !hasArc(node));
}

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
  /**
   * Paint only these layers, each with everything in it, where they are on
   * the page, and nothing of what they are in: what an export of a layer
   * shows. Without it the whole page is painted.
   */
  roots?: readonly NodeId[];
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
    if (strokeWidthOf(node) > 0 && node.strokes.length > 0) {
      // The mitred tip of a sharp corner of a vector reaches well beyond the corner itself.
      const sharp = (node.type === 'VECTOR' || node.type === 'BOOLEAN_OPERATION') && node.strokeJoin === 'MITER';
      bounds = expandRect(bounds, strokeWidthOf(node) * (sharp ? (strokeAlignOf(node) === 'OUTSIDE' ? 10 : 5) : 1));
      // Arrowheads reach beyond the ends of the stroke.
      const reach = arrowHeads(node).reduce((most, head) => Math.max(most, head.reach), 0);
      if (reach > 0) bounds = expandRect(bounds, reach);
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

  /**
   * Calls `draw` for the runs of a text layer that are wanted, list markers
   * included, with the font of each set on the context.
   */
  const textRuns = (target: Ctx, node: TextNode, wanted: (run: TextRun) => boolean, draw: (run: TextRun, baseline: number) => void): void => {
    const layout = layoutText(node, measurer);
    target.textBaseline = 'alphabetic';
    target.textAlign = 'left';
    let style: TextRun['style'] | null = null;
    for (const line of layout.lines) {
      for (const run of line.marker ? [line.marker, ...line.runs] : line.runs) {
        if (run.text === '' || !wanted(run)) continue;
        if (run.style !== style) {
          applyTextStyle(target, run.style);
          style = run.style;
        }
        draw(run, line.baseline);
      }
    }
  };

  /**
   * For a mirrored text layer, turns the layer's box over about its own middle, so that everything
   * drawn into it afterwards comes out mirrored. Returns whether it did; if so the caller restores the context.
   */
  const mirrorText = (target: Ctx, node: TextNode): boolean => {
    if (!node.flipX && !node.flipY) return false;
    target.save();
    target.translate(node.flipX ? node.width : 0, node.flipY ? node.height : 0);
    target.scale(node.flipX ? -1 : 1, node.flipY ? -1 : 1);
    return true;
  };

  /** Fills the glyphs of one run, and its underline or strikethrough, with whatever the context is set to fill with. */
  const fillRun = (target: Ctx, run: TextRun, baseline: number): void => {
    target.fillText(run.text, run.x, baseline);
    const size = run.style.fontSize;
    const offset = run.style.textDecoration === 'UNDERLINE' ? size * 0.12 : run.style.textDecoration === 'STRIKETHROUGH' ? -size * 0.3 : null;
    if (offset !== null) target.fillRect(run.x, baseline + offset, run.width, Math.max(1, size / 16));
  };

  /**
   * Paints a text layer: its fills colour the glyphs, except those with a
   * colour of their own; its inner shadows fall inside the glyphs; its
   * strokes outline them. Radial, angular and diamond gradients are stretched
   * to the box, as on shapes.
   */
  const drawText = (target: Ctx, node: TextNode, innerShadows: readonly ShadowEffect[] = []): void => {
    const alpha = target.globalAlpha;
    const mirrored = mirrorText(target, node);
    for (const paint of node.fills) {
      if (!paint.visible || paint.opacity <= 0) continue;
      if (isStretchedGradient(paint)) {
        target.globalAlpha = alpha;
        const painted = paintThroughMask(
          target,
          node,
          paint,
          (c) => {
            c.fillStyle = '#000';
            textRuns(c, node, (run) => run.style.color === null, (run, baseline) => fillRun(c, run, baseline));
          },
          0,
        );
        if (painted) continue;
      }
      target.globalAlpha = alpha * paint.opacity;
      target.fillStyle = paintStyle(target, paint, node.width, node.height);
      textRuns(
        target,
        node,
        (run) => run.style.color === null,
        (run, baseline) => fillRun(target, run, baseline),
      );
    }
    // Parts with a colour of their own are painted in it once, whatever the layer's fills are.
    target.globalAlpha = alpha;
    textRuns(
      target,
      node,
      (run) => run.style.color !== null,
      (run, baseline) => {
        if (run.style.color) target.fillStyle = rgbToCss(run.style.color);
        fillRun(target, run, baseline);
      },
    );
    for (const shadow of innerShadows) drawCastInnerShadow(target, node.id, node, shadow);
    if (node.strokeWeight > 0) {
      const outlineGlyphs = (c: Ctx): void => {
        c.lineWidth = node.strokeWeight;
        c.lineJoin = 'round';
        c.setLineDash([]);
        textRuns(
          c,
          node,
          () => true,
          (run, baseline) => c.strokeText(run.text, run.x, baseline),
        );
      };
      for (const paint of node.strokes) {
        if (!paint.visible || paint.opacity <= 0) continue;
        if (isStretchedGradient(paint)) {
          target.globalAlpha = alpha;
          const painted = paintThroughMask(
            target,
            node,
            paint,
            (c) => {
              c.strokeStyle = '#000';
              outlineGlyphs(c);
            },
            node.strokeWeight,
          );
          if (painted) continue;
        }
        target.globalAlpha = alpha * paint.opacity;
        target.strokeStyle = paintStyle(target, paint, node.width, node.height);
        outlineGlyphs(target);
      }
    }
    target.globalAlpha = alpha;
    applyTextStyle(target, { ...node, letterSpacing: 0 });
    if (mirrored) target.restore();
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
    const bands = strokeSideBands(node);
    if (bands) {
      // A weight for each side: the bands are filled with the stroke's paints, and an inside stroke stays inside rounded corners.
      const alpha = target.globalAlpha;
      for (const paint of node.strokes) {
        if (!paint.visible || paint.opacity <= 0) continue;
        target.save();
        if (node.strokeAlign === 'INSIDE') {
          traceLayerPath(target, node);
          target.clip();
        }
        target.beginPath();
        for (const band of bands) target.rect(band.x, band.y, band.width, band.height);
        fillWithPaint(target, paint, node.width, node.height, options.images);
        target.restore();
      }
      target.globalAlpha = alpha;
      return;
    }
    if (node.strokeWeight <= 0 || node.type === 'TEXT') return;
    const align = strokeAlignOf(node);
    const rule = fillRuleOf(node);
    const heads = arrowHeads(node);
    const alpha = target.globalAlpha;
    /** Strokes the layer once with whatever stroke style the context has, arrowheads included. */
    const strokeOnce = (c: Ctx): void => {
      c.lineCap = CAPS[node.strokeCap];
      c.lineJoin = JOINS[node.strokeJoin];
      c.setLineDash(node.dashPattern);
      if (align === 'CENTER') {
        traceStrokePath(c, node);
        c.lineWidth = node.strokeWeight;
        c.stroke();
        if (heads.length > 0) drawArrowHeads(c, heads);
        return;
      }
      // Inside and outside strokes: draw a double-width stroke and keep only
      // the half on the wanted side of the outline.
      c.save();
      traceLayerPath(c, node);
      if (align === 'INSIDE') clipPath(c, rule);
      else {
        const pad = node.strokeWeight * 2 + 2;
        c.rect(-pad, -pad, node.width + pad * 2, node.height + pad * 2);
        c.clip('evenodd');
      }
      traceLayerPath(c, node, 0, 'stroke');
      c.lineWidth = node.strokeWeight * 2;
      c.stroke();
      c.restore();
    };
    // How far past the box a stroke can reach: a mitred corner, and arrowheads.
    const reach = node.strokeWeight * 10 + heads.reduce((most, head) => Math.max(most, head.reach), 0) + 2;
    for (const paint of node.strokes) {
      if (!paint.visible || paint.opacity <= 0) continue;
      if (isStretchedGradient(paint)) {
        target.globalAlpha = alpha;
        const painted = paintThroughMask(
          target,
          node,
          paint,
          (c) => {
            c.strokeStyle = '#000';
            strokeOnce(c);
          },
          reach,
        );
        if (painted) continue;
      }
      target.globalAlpha = alpha * paint.opacity;
      target.strokeStyle = paintStyle(target, paint, node.width, node.height);
      strokeOnce(target);
    }
    target.globalAlpha = alpha;
    target.setLineDash([]);
  };

  /** Paints arrowheads with the current stroke style: solid, whatever the stroke's dashes. */
  const drawArrowHeads = (target: Ctx, heads: readonly ReturnType<typeof arrowHeads>[number][]): void => {
    target.setLineDash([]);
    for (const head of heads) {
      traceArrowHead(target, head);
      if (head.filled) {
        target.fillStyle = target.strokeStyle;
        target.fill();
      } else target.stroke();
    }
  };

  /**
   * Casts the shadow of what a layer covers, grown or shrunk by the shadow's
   * spread, from a scratch canvas: for text and for outlines other than boxes
   * and ellipses. The target must already have the shadow set, offset by
   * `away`. False when there is no scratch canvas, and nothing was cast.
   */
  const castSpreadShadow = (target: Ctx, id: NodeId, node: LayerNode, shadow: ShadowEffect): boolean => {
    const shape = silhouette(id, node, shadow.spread, layerRegion(id, node, shadowReach(shadow)));
    if (!shape) return false;
    placeAndReturn(target, shape, -away);
    return true;
  };

  /** Draws a layer's drop shadow from its outline, without drawing the layer. */
  const drawOutlineShadow = (target: Ctx, id: NodeId, node: LayerNode, shadow: ShadowEffect): void => {
    target.save();
    setLayerTransform(target, id, -away);
    setShadow(target, id, shadow, away);
    target.fillStyle = '#000';
    target.strokeStyle = '#000';
    if (node.type === 'TEXT') {
      if (shadow.spread === 0 || !castSpreadShadow(target, id, node, shadow)) {
        const mirrored = mirrorText(target, node);
        textRuns(
          target,
          node,
          () => true,
          (run, baseline) => target.fillText(run.text, run.x, baseline),
        );
        if (mirrored) target.restore();
      }
    } else {
      const filled = node.type !== 'LINE' && hasVisiblePaint(node.fills);
      const bands = strokeSideBands(node);
      const stroked = strokeWidthOf(node) > 0 && hasVisiblePaint(node.strokes);
      const boxLike = spreadsByInset(node);
      const align = strokeAlignOf(node);
      if (filled) {
        if (boxLike || shadow.spread === 0 || !castSpreadShadow(target, id, node, shadow)) {
          traceLayerPath(target, node, boxLike ? -shadow.spread : 0);
          fillPath(target, fillRuleOf(node));
        }
      }
      // A stroke with a weight for each side casts the shadow of its bands; an inside one lies within the fill.
      if (bands && stroked && !(filled && align === 'INSIDE')) {
        target.beginPath();
        for (const band of bands) target.rect(band.x, band.y, band.width, band.height);
        target.fill();
      } else if (stroked && !(filled && align === 'INSIDE')) {
        traceStrokePath(target, node);
        target.lineCap = CAPS[node.strokeCap];
        target.lineJoin = JOINS[node.strokeJoin];
        target.setLineDash(node.dashPattern);
        target.lineWidth = align === 'OUTSIDE' ? node.strokeWeight * 2 : node.strokeWeight;
        target.stroke();
        drawArrowHeads(target, arrowHeads(node));
      }
    }
    target.restore();
  };

  /** Draws a shadow inside the layer's outline: the shadow of everything around the outline, clipped to it. */
  const drawInnerShadow = (target: Ctx, id: NodeId, node: LayerNode, shadow: ShadowEffect): void => {
    const boxLike = spreadsByInset(node);
    // Spread on any other outline is drawn by shrinking the outline on a scratch canvas.
    if (!boxLike && shadow.spread !== 0 && drawCastInnerShadow(target, id, node, shadow)) return;
    target.save();
    setLayerTransform(target, id);
    traceLayerPath(target, node);
    clipPath(target, fillRuleOf(node));
    setLayerTransform(target, id, -away);
    setShadow(target, id, shadow, away);
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

  /** The part of the canvas, in device pixels, that something with these page-space bounds can touch. */
  const pixelRegion = (bounds: Rect): { x: number; y: number; w: number; h: number } => {
    const x0 = Math.max(0, Math.floor((bounds.x - viewport.x) * scale) - 2);
    const y0 = Math.max(0, Math.floor((bounds.y - viewport.y) * scale) - 2);
    const x1 = Math.min(pixelWidth, Math.ceil((bounds.x + bounds.width - viewport.x) * scale) + 2);
    const y1 = Math.min(pixelHeight, Math.ceil((bounds.y + bounds.height - viewport.y) * scale) + 2);
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  };

  /**
   * The part of the canvas a layer's own painting can touch, for painting it
   * by way of a scratch canvas: its render bounds, widened by `extra`, and
   * for text by however far its lines run out of its box.
   */
  const layerRegion = (id: NodeId, node: LayerNode, extra = 0): PixelRegion => {
    let reach = extra;
    if (node.type === 'TEXT') {
      const layout = layoutText(node, measurer);
      reach += Math.max(0, layout.width - node.width) + Math.max(0, layout.height - node.height) + Math.max(node.fontSize, layout.lineHeight) * 2;
    }
    return pixelRegion(expandRect(getRenderBounds(doc, id), reach));
  };

  /** A scratch canvas cleared over a region, with its settings at their defaults, or null where there is none. */
  const borrow = (region: PixelRegion): Scratch | null => {
    if (!options.createCanvas || region.w <= 0 || region.h <= 0) return null;
    const canvas = scratch.pop() ?? options.createCanvas(pixelWidth, pixelHeight);
    const c = canvas.getContext('2d') as Ctx | null;
    if (!c) {
      scratch.push(canvas);
      return null;
    }
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
    c.clearRect(region.x, region.y, region.w, region.h);
    return { canvas, ctx: c, region };
  };

  /** Draws what a scratch canvas holds onto the target where it is, with the target's opacity and clip, and gives the canvas back. */
  const placeAndReturn = (target: Ctx, borrowed: Scratch, shiftX = 0): void => {
    const { canvas, region: r } = borrowed;
    target.save();
    target.setTransform(1, 0, 0, 1, 0, 0);
    target.drawImage(canvas, r.x, r.y, r.w, r.h, r.x + shiftX, r.y, r.w, r.h);
    target.restore();
    scratch.push(canvas);
  };

  /**
   * Paints a radial, angular or diamond gradient onto what `mask` draws (in
   * the layer's own space, in any opaque colour), stretched to the layer's box
   * as a fill would be: the mask is drawn on a scratch canvas, the gradient is
   * painted over it keeping only what the mask covers, and the result is
   * placed on the target. This is how strokes and text get these gradients,
   * since the canvas cannot clip to a stroke or to glyphs. False when there
   * is no scratch canvas, and nothing was painted.
   */
  const paintThroughMask = (target: Ctx, node: LayerNode, paint: GradientPaint, mask: (c: Ctx) => void, margin: number): boolean => {
    if (node.width <= 0 || node.height <= 0) return false;
    const borrowed = borrow(layerRegion(node.id, node, margin));
    if (!borrowed) return false;
    const c = borrowed.ctx;
    c.save();
    setLayerTransform(c, node.id);
    const mirrored = node.type === 'TEXT' && mirrorText(c, node);
    c.save();
    mask(c);
    c.restore();
    c.globalCompositeOperation = 'source-in';
    c.globalAlpha = paint.opacity;
    fillStretchedGradient(c, paint, node.width, node.height, margin);
    if (mirrored) c.restore();
    c.restore();
    placeAndReturn(target, borrowed);
    return true;
  };

  /**
   * Paints in black, on a scratch canvas, what a layer covers: a group's
   * children as they are painted, a text's glyphs, or a shape's fill. `grow`
   * widens it by that many units all round, or with a negative value narrows
   * it, by stroking its outline twice as wide and adding or taking away what
   * that stroke covers; that is how shadow spread reaches outlines other than
   * boxes and ellipses. A group is not grown. Null where there is no scratch canvas.
   */
  const silhouette = (id: NodeId, node: LayerNode, grow: number, region: PixelRegion): Scratch | null => {
    const borrowed = borrow(region);
    if (!borrowed) return null;
    const c = borrowed.ctx;
    if (node.type === 'GROUP') {
      // The children are painted again only to see where they are: they are not counted twice.
      const { drawn, culled } = stats;
      drawChildren(c, id);
      stats.drawn = drawn;
      stats.culled = culled;
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.globalAlpha = 1;
      return borrowed;
    }
    c.save();
    setLayerTransform(c, id);
    c.fillStyle = '#000';
    c.strokeStyle = '#000';
    c.setLineDash([]);
    c.lineWidth = Math.abs(grow) * 2;
    if (node.type === 'TEXT') {
      const mirrored = mirrorText(c, node);
      textRuns(c, node, () => true, (run, baseline) => fillRun(c, run, baseline));
      if (grow !== 0) {
        c.lineJoin = 'round';
        c.globalCompositeOperation = grow > 0 ? 'source-over' : 'destination-out';
        textRuns(c, node, () => true, (run, baseline) => c.strokeText(run.text, run.x, baseline));
      }
      if (mirrored) c.restore();
    } else {
      traceLayerPath(c, node);
      fillPath(c, fillRuleOf(node));
      if (grow !== 0) {
        // Sharp corners stay sharp, as they do when a rectangle's shadow spreads.
        c.lineJoin = 'miter';
        c.miterLimit = 10;
        c.globalCompositeOperation = grow > 0 ? 'source-over' : 'destination-out';
        traceLayerPath(c, node);
        c.stroke();
      }
    }
    c.restore();
    return borrowed;
  };

  /**
   * Paints an inner shadow by way of scratch canvases: the shadow's colour,
   * less the offset and blurred shadow of `hole` (what the shadow does not
   * reach into before it is blurred), kept only where `shape` paints, placed
   * on the target. `shape` must paint in one call. Used where the outline
   * cannot be traced as a path: text, groups, and spread on outlines other
   * than boxes and ellipses. False when there is no scratch canvas.
   */
  const castInnerShadow = (target: Ctx, id: NodeId, shadow: ShadowEffect, hole: Scratch, shape: (c: Ctx) => void): boolean => {
    const r = hole.region;
    const borrowed = borrow(r);
    if (!borrowed) return false;
    const c = borrowed.ctx;
    c.fillStyle = rgbToCss(shadow.color, shadow.opacity);
    c.fillRect(r.x, r.y, r.w, r.h);
    c.save();
    c.globalCompositeOperation = 'destination-out';
    setShadow(c, id, { ...shadow, color: { r: 0, g: 0, b: 0 }, opacity: 1 }, away);
    c.drawImage(hole.canvas, r.x, r.y, r.w, r.h, r.x - away, r.y, r.w, r.h);
    c.restore();
    c.save();
    c.globalCompositeOperation = 'destination-in';
    shape(c);
    c.restore();
    placeAndReturn(target, borrowed);
    return true;
  };

  /** How far a shadow can carry what casts it: what a scratch canvas for it must take in round the layer. */
  const shadowReach = (shadow: ShadowEffect): number => Math.abs(shadow.offsetX) + Math.abs(shadow.offsetY) + shadow.blur + Math.abs(shadow.spread);

  /** An inner shadow on a text, a group, or a shape whose shadow spreads: see `castInnerShadow`. */
  const drawCastInnerShadow = (target: Ctx, id: NodeId, node: LayerNode, shadow: ShadowEffect): boolean => {
    const region = layerRegion(id, node, shadowReach(shadow));
    const outline = node.type === 'TEXT' || node.type === 'GROUP' ? silhouette(id, node, 0, region) : null;
    const spreads = node.type !== 'GROUP' && shadow.spread !== 0;
    const hole = spreads ? silhouette(id, node, -shadow.spread, region) : outline;
    if (!hole) {
      if (outline) scratch.push(outline.canvas);
      return false;
    }
    const done = castInnerShadow(target, id, shadow, hole, (c) => {
      if (outline) {
        c.setTransform(1, 0, 0, 1, 0, 0);
        c.drawImage(outline.canvas, region.x, region.y, region.w, region.h, region.x, region.y, region.w, region.h);
      } else {
        setLayerTransform(c, id);
        traceLayerPath(c, node);
        fillPath(c, fillRuleOf(node));
      }
    });
    scratch.push(hole.canvas);
    if (outline && outline !== hole) scratch.push(outline.canvas);
    return done;
  };

  /**
   * Paints the layers above a mask, showing through only where the mask
   * would have painted and only as strongly as it would have painted there.
   * The mask itself is not shown.
   */
  const drawMasked = (target: Ctx, maskId: NodeId, mask: LayerNode, ids: readonly NodeId[]): void => {
    if (ids.length === 0 || mask.opacity <= 0) return;
    const bounds = getRenderBounds(doc, maskId);
    if (!rectsIntersect(bounds, visible)) {
      stats.culled += ids.length;
      return;
    }
    const region = pixelRegion(bounds);
    const content = options.createCanvas ? (scratch.pop() ?? options.createCanvas(pixelWidth, pixelHeight)) : null;
    const stencil = options.createCanvas ? (scratch.pop() ?? options.createCanvas(pixelWidth, pixelHeight)) : null;
    const contentCtx = content ? (content.getContext('2d') as Ctx | null) : null;
    const stencilCtx = stencil ? (stencil.getContext('2d') as Ctx | null) : null;
    if (!content || !stencil || !contentCtx || !stencilCtx || region.w <= 0 || region.h <= 0) {
      // Without somewhere to composite, the mask's outline is used as a clip: exact for a shape with a solid fill.
      if (content) scratch.push(content);
      if (stencil) scratch.push(stencil);
      target.save();
      setLayerTransform(target, maskId);
      traceLayerPath(target, mask);
      clipPath(target, fillRuleOf(mask));
      for (const id of ids) drawLayer(target, id);
      target.restore();
      return;
    }
    for (const layerCtx of [contentCtx, stencilCtx]) {
      layerCtx.setTransform(1, 0, 0, 1, 0, 0);
      layerCtx.globalAlpha = 1;
      layerCtx.globalCompositeOperation = 'source-over';
      layerCtx.clearRect(region.x, region.y, region.w, region.h);
    }
    for (const id of ids) drawLayer(contentCtx, id);
    drawLayer(stencilCtx, maskId);
    // Keep of the content only what the mask covers.
    contentCtx.setTransform(1, 0, 0, 1, 0, 0);
    contentCtx.globalAlpha = 1;
    contentCtx.globalCompositeOperation = 'destination-in';
    contentCtx.drawImage(stencil, region.x, region.y, region.w, region.h, region.x, region.y, region.w, region.h);
    contentCtx.globalCompositeOperation = 'source-over';
    target.save();
    target.setTransform(1, 0, 0, 1, 0, 0);
    target.drawImage(content, region.x, region.y, region.w, region.h, region.x, region.y, region.w, region.h);
    target.restore();
    scratch.push(content, stencil);
  };

  const drawChildren = (target: Ctx, parentId: NodeId): void => {
    const ids = getChildIds(doc, parentId);
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i] as NodeId;
      const node = doc.nodes[id];
      if (!isLayer(node) || !node.isMask) {
        drawLayer(target, id);
        continue;
      }
      // A mask governs the layers above it, up to the next mask.
      let end = i + 1;
      while (end < ids.length) {
        const next = doc.nodes[ids[end] as NodeId];
        if (isLayer(next) && next.isMask) break;
        end++;
      }
      const above = ids.slice(i + 1, end);
      // A hidden mask masks nothing: what is above it is painted as usual.
      if (node.visible && !options.hiddenIds?.has(id)) drawMasked(target, id, node, above);
      else for (const other of above) drawLayer(target, other);
      i = end - 1;
    }
  };

  const paintLayer = (target: Ctx, id: NodeId, node: LayerNode, innerShadows: readonly ShadowEffect[]): void => {
    setLayerTransform(target, id);
    if (node.type === 'TEXT') {
      drawText(target, node, innerShadows);
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
        // A group's inner shadows fall inside what its children paint, over them.
        if (node.type === 'GROUP') for (const shadow of innerShadows) drawCastInnerShadow(target, id, node, shadow);
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
      (strokeWidthOf(node) > 0 ? node.strokes.length : 0);
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

  if (options.roots) for (const id of options.roots) drawLayer(ctx, id);
  else drawChildren(ctx, pageId);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return stats;
}
