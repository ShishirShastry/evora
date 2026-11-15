import type { CornerRadii, LayerNode } from '../document/schema';
import type { Point } from '../math/geometry';

/** Vertices of a regular polygon inscribed in the box, first vertex at top centre. */
export function polygonPoints(width: number, height: number, pointCount: number): Point[] {
  const n = Math.max(3, Math.round(pointCount));
  const points: Point[] = [];
  for (let i = 0; i < n; i++) {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    points.push({ x: width / 2 + (Math.cos(angle) * width) / 2, y: height / 2 + (Math.sin(angle) * height) / 2 });
  }
  return points;
}

/** Vertices of a star inscribed in the box, alternating outer and inner points. */
export function starPoints(width: number, height: number, pointCount: number, innerRadius: number): Point[] {
  const n = Math.max(3, Math.round(pointCount));
  const ratio = Math.max(0, Math.min(1, innerRadius));
  const points: Point[] = [];
  for (let i = 0; i < n * 2; i++) {
    const angle = -Math.PI / 2 + (i * Math.PI) / n;
    const r = i % 2 === 0 ? 1 : ratio;
    points.push({
      x: width / 2 + (Math.cos(angle) * width * r) / 2,
      y: height / 2 + (Math.sin(angle) * height * r) / 2,
    });
  }
  return points;
}

/**
 * The outline of a polygonal layer in its local space, or `null` for types
 * whose outline is not a polygon (rectangles, ellipses, lines, frames).
 */
export function outlinePoints(node: LayerNode): Point[] | null {
  if (node.type === 'POLYGON') return polygonPoints(node.width, node.height, node.pointCount);
  if (node.type === 'STAR') return starPoints(node.width, node.height, node.pointCount, node.innerRadius);
  return null;
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

export function hasVisiblePaint(paints: readonly { visible: boolean; opacity: number }[]): boolean {
  return paints.some((paint) => paint.visible && paint.opacity > 0);
}
