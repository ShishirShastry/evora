import type { ArrowShape, CornerRadii, GradientPaint, ImagePaint, LayerNode, LineNode, Paint, PathStep, RGB, SolidPaint, VectorNetwork, VectorNode } from '../../core';
import {
  arrowShape,
  arrowTrim,
  effectiveRadii,
  hasArc,
  imagePlacement,
  isStraight,
  networkGeometry,
  openRuns,
  outlinePoints,
  pathEnds,
  stepCubic,
  trimEnd,
  trimStart,
} from '../../core';
import type { ImageSource } from '../images/imageCache';

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** The subset of the 2D canvas API used to build paths; lets tests pass a recording stub. */
export type PathContext = Pick<
  CanvasRenderingContext2D,
  'beginPath' | 'moveTo' | 'lineTo' | 'arcTo' | 'ellipse' | 'closePath' | 'rect' | 'bezierCurveTo' | 'arc'
>;

/** Which of a layer's outlines to trace: what a fill covers, or what a stroke follows. They differ for vectors only. */
export type PathPart = 'fill' | 'stroke';

export { effectiveRadii };

export function rgbToCss(color: RGB, alpha = 1): string {
  const r = Math.round(color.r * 255);
  const g = Math.round(color.g * 255);
  const b = Math.round(color.b * 255);
  return alpha >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${Math.max(0, alpha)})`;
}

export function solidToCss(paint: SolidPaint): string {
  return rgbToCss(paint.color, paint.opacity);
}

/** The canvas fill rule for a layer's outline. Only vectors can ask for even-odd. */
export function fillRuleOf(node: LayerNode): CanvasFillRule {
  return node.type === 'VECTOR' && node.windingRule === 'EVENODD' ? 'evenodd' : 'nonzero';
}

/** Adds a run of segments to the current path as one sub-path. */
function traceSteps(ctx: PathContext, network: VectorNetwork, steps: readonly PathStep[], close: boolean): void {
  steps.forEach((step, i) => {
    const c = stepCubic(network, step);
    if (i === 0) ctx.moveTo(c.p0.x, c.p0.y);
    if (isStraight(c)) ctx.lineTo(c.p3.x, c.p3.y);
    else ctx.bezierCurveTo(c.p1.x, c.p1.y, c.p2.x, c.p2.y, c.p3.x, c.p3.y);
  });
  if (close && steps.length > 0) ctx.closePath();
}

/** Adds a vector network to the current path: its closed regions for filling, or every segment for stroking. */
export function traceNetwork(ctx: PathContext, network: VectorNetwork, part: PathPart): void {
  const geometry = networkGeometry(network);
  if (part === 'fill') for (const loop of geometry.loops) traceSteps(ctx, network, loop, true);
  else for (const chain of geometry.chains) traceSteps(ctx, network, chain.steps, chain.closed);
}

function roundedRect(ctx: PathContext, x: number, y: number, w: number, h: number, radii: CornerRadii): void {
  const [tl, tr, br, bl] = radii;
  if (tl <= 0 && tr <= 0 && br <= 0 && bl <= 0) {
    ctx.rect(x, y, w, h);
    return;
  }
  ctx.moveTo(x + tl, y);
  ctx.lineTo(x + w - tr, y);
  if (tr > 0) ctx.arcTo(x + w, y, x + w, y + tr, tr);
  ctx.lineTo(x + w, y + h - br);
  if (br > 0) ctx.arcTo(x + w, y + h, x + w - br, y + h, br);
  ctx.lineTo(x + bl, y + h);
  if (bl > 0) ctx.arcTo(x, y + h, x, y + h - bl, bl);
  ctx.lineTo(x, y + tl);
  if (tl > 0) ctx.arcTo(x, y, x + tl, y, tl);
  ctx.closePath();
}

/**
 * Traces a layer's outline in its local space (origin at the box's top-left).
 * `inset` shrinks (positive) or grows (negative) the outline; it is used for
 * shadow spread on boxes and ellipses. `part` matters for vectors, where the
 * area a fill covers and the lines a stroke follows are not the same thing.
 */
export function traceLayerPath(ctx: PathContext, node: LayerNode, inset = 0, part: PathPart = 'fill'): void {
  const { width, height } = node;
  ctx.beginPath();
  switch (node.type) {
    case 'GROUP':
    case 'TEXT':
      ctx.rect(inset, inset, Math.max(0, width - inset * 2), Math.max(0, height - inset * 2));
      break;
    case 'FRAME':
    case 'RECTANGLE': {
      const w = Math.max(0, width - inset * 2);
      const h = Math.max(0, height - inset * 2);
      roundedRect(ctx, inset, inset, w, h, effectiveRadii(w, h, node.cornerRadius, node.cornerRadii, inset));
      break;
    }
    case 'ELLIPSE': {
      const cx = width / 2;
      const cy = height / 2;
      const rx = Math.max(0, cx - inset);
      const ry = Math.max(0, cy - inset);
      if (!hasArc(node)) {
        ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
        ctx.closePath();
        break;
      }
      const from = (node.arcStart * Math.PI) / 180;
      const to = ((node.arcStart + node.arcSweep) * Math.PI) / 180;
      const inner = node.arcRatio;
      if (node.arcSweep >= 360) {
        // A ring: the hole is traced the other way round, and as a path of its own.
        ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
        ctx.closePath();
        ctx.moveTo(cx + rx * inner, cy);
        ctx.ellipse(cx, cy, rx * inner, ry * inner, 0, Math.PI * 2, 0, true);
        ctx.closePath();
      } else {
        ctx.ellipse(cx, cy, rx, ry, 0, from, to);
        // Back along the inner edge, or for a slice straight to the centre.
        if (inner > 0) ctx.ellipse(cx, cy, rx * inner, ry * inner, 0, to, from, true);
        else ctx.lineTo(cx, cy);
        ctx.closePath();
      }
      break;
    }
    case 'LINE':
      ctx.moveTo(0, height / 2);
      ctx.lineTo(width, height / 2);
      break;
    case 'POLYGON':
    case 'STAR': {
      const points = outlinePoints(node) ?? [];
      points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.closePath();
      break;
    }
    case 'VECTOR':
    case 'BOOLEAN_OPERATION':
      traceNetwork(ctx, node.network, part);
      break;
  }
}

/** The arrowheads a layer's stroke ends in, in the layer's own space. Only lines and vectors with loose ends have any. */
export function arrowHeads(node: LayerNode): ArrowShape[] {
  if (node.type !== 'LINE' && node.type !== 'VECTOR') return [];
  if (node.startArrow === 'NONE' && node.endArrow === 'NONE') return [];
  const heads: ArrowShape[] = [];
  for (const end of pathEnds(node)) {
    const head = arrowShape(end.at === 'start' ? node.startArrow : node.endArrow, end, node.strokeWeight);
    if (head) heads.push(head);
  }
  return heads;
}

/**
 * Traces what a line or vector's stroke follows, cut short at the ends whose
 * arrowhead would otherwise have the stroke showing through its tip.
 */
function traceTrimmedStroke(ctx: PathContext, node: LineNode | VectorNode): void {
  const startTrim = arrowTrim(node.startArrow, node.strokeWeight);
  const endTrim = arrowTrim(node.endArrow, node.strokeWeight);
  ctx.beginPath();
  if (node.type === 'LINE') {
    const room = node.width * 0.45;
    ctx.moveTo(Math.min(startTrim, room), node.height / 2);
    ctx.lineTo(node.width - Math.min(endTrim, room), node.height / 2);
    return;
  }
  const runs = openRuns(node);
  for (const chain of networkGeometry(node.network).chains) {
    const curves = chain.steps.map((step) => stepCubic(node.network, step));
    const run = runs.find((candidate) => candidate.steps === chain.steps);
    const last = curves.length - 1;
    if (run && last >= 0) {
      if (run.startLoose && startTrim > 0) curves[0] = trimStart(curves[0] as (typeof curves)[number], startTrim);
      if (run.endLoose && endTrim > 0) curves[last] = trimEnd(curves[last] as (typeof curves)[number], endTrim);
    }
    curves.forEach((c, i) => {
      if (i === 0) ctx.moveTo(c.p0.x, c.p0.y);
      if (isStraight(c)) ctx.lineTo(c.p3.x, c.p3.y);
      else ctx.bezierCurveTo(c.p1.x, c.p1.y, c.p2.x, c.p2.y, c.p3.x, c.p3.y);
    });
    if (chain.closed && curves.length > 0) ctx.closePath();
  }
}

/** Traces the path a layer's stroke is drawn along: its outline, made room for arrowheads where it has them. */
export function traceStrokePath(ctx: PathContext, node: LayerNode): void {
  if ((node.type === 'LINE' || node.type === 'VECTOR') && (node.startArrow !== 'NONE' || node.endArrow !== 'NONE')) traceTrimmedStroke(ctx, node);
  else traceLayerPath(ctx, node, 0, 'stroke');
}

/** Traces one arrowhead. */
export function traceArrowHead(ctx: PathContext, head: ArrowShape): void {
  ctx.beginPath();
  if (head.circle) {
    ctx.arc(head.circle.center.x, head.circle.center.y, head.circle.radius, 0, Math.PI * 2);
    return;
  }
  head.points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  if (head.filled) ctx.closePath();
}

function addStops(gradient: CanvasGradient, paint: GradientPaint): CanvasGradient {
  for (const stop of paint.stops) {
    gradient.addColorStop(Math.min(1, Math.max(0, stop.position)), rgbToCss(stop.color, stop.opacity));
  }
  return gradient;
}

/** A conic gradient, or null where the browser has none. */
function conic(ctx: Ctx, angle: number, x: number, y: number): CanvasGradient | null {
  return 'createConicGradient' in ctx ? ctx.createConicGradient(angle, x, y) : null;
}

/**
 * A gradient in the layer's pixel space, usable as a fill or stroke style for
 * anything drawn in that space, including text and strokes. Linear gradients
 * are exact. The round kinds are circular here (the radius is the distance
 * between the handles in pixels); `fillWithPaint` draws them elliptical for
 * shapes, which is what a box-shaped fill wants.
 */
export function gradientInPixels(ctx: Ctx, paint: GradientPaint, width: number, height: number): CanvasGradient {
  const fx = paint.from.x * width;
  const fy = paint.from.y * height;
  const tx = paint.to.x * width;
  const ty = paint.to.y * height;
  if (paint.type === 'GRADIENT_LINEAR') return addStops(ctx.createLinearGradient(fx, fy, tx, ty), paint);
  if (paint.type === 'GRADIENT_ANGULAR') {
    const gradient = conic(ctx, Math.atan2(ty - fy, tx - fx), fx, fy);
    if (gradient) return addStops(gradient, paint);
  }
  return addStops(ctx.createRadialGradient(fx, fy, 0, fx, fy, Math.max(0.001, Math.hypot(tx - fx, ty - fy))), paint);
}

/**
 * The fill or stroke style for a paint, in the layer's pixel space. Its
 * opacity is applied separately. Images are fills for shapes only; as a style
 * for strokes or text an image paint draws nothing.
 */
export function paintStyle(ctx: Ctx, paint: Paint, width: number, height: number): string | CanvasGradient {
  if (paint.type === 'SOLID') return rgbToCss(paint.color);
  if (paint.type === 'IMAGE') return 'rgba(0, 0, 0, 0)';
  return gradientInPixels(ctx, paint, width, height);
}

/** Shown where an image has not been decoded yet, or cannot be found. */
const IMAGE_PLACEHOLDER = 'rgba(128, 138, 138, 0.35)';

/** Draws an image paint into the layer's box. The caller has already clipped to the layer's outline. */
function drawImagePaint(ctx: Ctx, paint: ImagePaint, width: number, height: number, images: ImageSource | undefined): void {
  const decoded = images?.get(paint.imageHash) ?? null;
  if (!decoded) {
    ctx.fillStyle = IMAGE_PLACEHOLDER;
    ctx.fillRect(0, 0, width, height);
    return;
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  if (paint.scaleMode === 'TILE') {
    const pattern = ctx.createPattern(decoded.image, 'repeat');
    if (!pattern) return;
    // Scale the space rather than the pattern, so the tile size follows tileScale.
    const scale = Math.max(0.01, paint.tileScale);
    ctx.scale(scale, scale);
    ctx.fillStyle = pattern;
    ctx.fillRect(0, 0, width / scale, height / scale);
    return;
  }
  const placement = imagePlacement(paint.scaleMode, decoded.width, decoded.height, width, height, paint.crop);
  if (!placement) return;
  const { source, target } = placement;
  ctx.drawImage(decoded.image, source.x, source.y, source.width, source.height, target.x, target.y, target.width, target.height);
}

/** Fills the current path with the current style, by the given rule. */
export function fillPath(ctx: Ctx, rule: CanvasFillRule): void {
  if (rule === 'evenodd') ctx.fill('evenodd');
  else ctx.fill();
}

/** Clips to the current path, by the given rule. */
export function clipPath(ctx: Ctx, rule: CanvasFillRule): void {
  if (rule === 'evenodd') ctx.clip('evenodd');
  else ctx.clip();
}

/**
 * Fills the current path with a paint. The path must already be traced in the
 * layer's local space. Radial, angular and diamond gradients are drawn in the
 * layer's unit square, so they stretch with the box: a radial gradient in a
 * wide rectangle is an ellipse, as designers expect.
 */
export function fillWithPaint(ctx: Ctx, paint: Paint, width: number, height: number, images?: ImageSource, rule: CanvasFillRule = 'nonzero'): void {
  const previousAlpha = ctx.globalAlpha;
  ctx.globalAlpha = previousAlpha * paint.opacity;
  if (paint.type === 'SOLID') {
    ctx.fillStyle = rgbToCss(paint.color);
    fillPath(ctx, rule);
  } else if (paint.type === 'IMAGE') {
    ctx.save();
    clipPath(ctx, rule);
    drawImagePaint(ctx, paint, width, height, images);
    ctx.restore();
  } else if (paint.type === 'GRADIENT_LINEAR' || width <= 0 || height <= 0) {
    ctx.fillStyle = gradientInPixels(ctx, paint, width, height);
    fillPath(ctx, rule);
  } else {
    ctx.save();
    clipPath(ctx, rule);
    // From here on, (0,0)-(1,1) is the layer's box.
    ctx.transform(width, 0, 0, height, 0, 0);
    const { from, to } = paint;
    const radius = Math.max(1e-6, Math.hypot(to.x - from.x, to.y - from.y));
    const angle = Math.atan2(to.y - from.y, to.x - from.x);
    const far = 4;
    if (paint.type === 'GRADIENT_RADIAL') {
      ctx.fillStyle = addStops(ctx.createRadialGradient(from.x, from.y, 0, from.x, from.y, radius), paint);
      ctx.fillRect(-far, -far, far * 2 + 1, far * 2 + 1);
    } else if (paint.type === 'GRADIENT_ANGULAR') {
      const gradient = conic(ctx, angle, from.x, from.y);
      ctx.fillStyle = gradient ? addStops(gradient, paint) : addStops(ctx.createRadialGradient(from.x, from.y, 0, from.x, from.y, radius), paint);
      ctx.fillRect(-far, -far, far * 2 + 1, far * 2 + 1);
    } else {
      // Diamond: the colour depends on |x| + |y| from the centre, which is a
      // plain linear gradient within each of the four quadrants.
      ctx.translate(from.x, from.y);
      ctx.rotate(angle);
      for (const [sx, sy] of [
        [1, 1],
        [-1, 1],
        [-1, -1],
        [1, -1],
      ] as const) {
        ctx.fillStyle = addStops(ctx.createLinearGradient(0, 0, (sx * radius) / 2, (sy * radius) / 2), paint);
        ctx.fillRect(sx > 0 ? 0 : -far * 2, sy > 0 ? 0 : -far * 2, far * 2, far * 2);
      }
    }
    ctx.restore();
  }
  ctx.globalAlpha = previousAlpha;
}
