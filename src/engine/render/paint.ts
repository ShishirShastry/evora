import type { LayerNode, Paint, RGB } from '../../core';
import { outlinePoints } from '../../core';

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

export function paintToCss(paint: Paint): string {
  return rgbToCss(paint.color, paint.opacity);
}

function roundedRect(ctx: PathContext, x: number, y: number, w: number, h: number, radius: number): void {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  if (r <= 0) {
    ctx.rect(x, y, w, h);
    return;
  }
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

/**
 * Traces a layer's outline in its local space (origin at the box's top-left).
 * `inset` shrinks (positive) or grows (negative) the outline; it is used for
 * inside and outside strokes on boxes and ellipses.
 */
export function traceLayerPath(ctx: PathContext, node: LayerNode, inset = 0): void {
  const { width, height } = node;
  ctx.beginPath();
  switch (node.type) {
    case 'FRAME':
    case 'RECTANGLE':
      roundedRect(
        ctx,
        inset,
        inset,
        Math.max(0, width - inset * 2),
        Math.max(0, height - inset * 2),
        Math.max(0, node.cornerRadius - inset),
      );
      break;
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
