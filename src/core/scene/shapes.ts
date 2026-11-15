import type { LayerNode } from '../document/schema';
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

export function hasVisiblePaint(paints: readonly { visible: boolean; opacity: number }[]): boolean {
  return paints.some((paint) => paint.visible && paint.opacity > 0);
}
