import type { CornerRadii, GradientPaint, ImagePaint, LayerNode, Paint, RGB, SolidPaint } from '../../core';
import { imagePlacement, outlinePoints } from '../../core';
import type { ImageSource } from '../images/imageCache';

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** The subset of the 2D canvas API used to build paths; lets tests pass a recording stub. */
export type PathContext = Pick<
  CanvasRenderingContext2D,
  'beginPath' | 'moveTo' | 'lineTo' | 'arcTo' | 'ellipse' | 'closePath' | 'rect'
>;

export function rgbToCss(color: RGB, alpha = 1): string {
  const r = Math.round(color.r * 255);
  const g = Math.round(color.g * 255);
  const b = Math.round(color.b * 255);
  return alpha >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${Math.max(0, alpha)})`;
}

export function solidToCss(paint: SolidPaint): string {
  return rgbToCss(paint.color, paint.opacity);
}

/**
 * The radii actually used for a box's corners, in the order top-left,
 * top-right, bottom-right, bottom-left. When neighbouring radii do not fit
 * along a side they are all scaled down together, as CSS does, so the outline
 * stays smooth instead of overlapping.
 */
export function effectiveRadii(width: number, height: number, radius: number, radii: CornerRadii | null, inset = 0): CornerRadii {
  // A rounded corner grows or shrinks with the outline; a sharp corner stays sharp.
  const [tl, tr, br, bl] = (radii ?? [radius, radius, radius, radius]).map((r) => (r <= 0 ? 0 : Math.max(0, r - inset))) as CornerRadii;
  if (width <= 0 || height <= 0) return [0, 0, 0, 0];
  const factor = Math.min(
    1,
    tl + tr > 0 ? width / (tl + tr) : 1,
    bl + br > 0 ? width / (bl + br) : 1,
    tl + bl > 0 ? height / (tl + bl) : 1,
    tr + br > 0 ? height / (tr + br) : 1,
  );
  return [tl * factor, tr * factor, br * factor, bl * factor];
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
 * shadow spread on boxes and ellipses.
 */
export function traceLayerPath(ctx: PathContext, node: LayerNode, inset = 0): void {
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
    case 'ELLIPSE':
      ctx.ellipse(width / 2, height / 2, Math.max(0, width / 2 - inset), Math.max(0, height / 2 - inset), 0, 0, Math.PI * 2);
      ctx.closePath();
      break;
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
  }
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

/**
 * Fills the current path with a paint. The path must already be traced in the
 * layer's local space. Radial, angular and diamond gradients are drawn in the
 * layer's unit square, so they stretch with the box: a radial gradient in a
 * wide rectangle is an ellipse, as designers expect.
 */
export function fillWithPaint(ctx: Ctx, paint: Paint, width: number, height: number, images?: ImageSource): void {
  const previousAlpha = ctx.globalAlpha;
  ctx.globalAlpha = previousAlpha * paint.opacity;
  if (paint.type === 'SOLID') {
    ctx.fillStyle = rgbToCss(paint.color);
    ctx.fill();
  } else if (paint.type === 'IMAGE') {
    ctx.save();
    ctx.clip();
    drawImagePaint(ctx, paint, width, height, images);
    ctx.restore();
  } else if (paint.type === 'GRADIENT_LINEAR' || width <= 0 || height <= 0) {
    ctx.fillStyle = gradientInPixels(ctx, paint, width, height);
    ctx.fill();
  } else {
    ctx.save();
    ctx.clip();
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
