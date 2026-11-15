import type { LayerNode, VectorNetwork } from '../document/schema';
import { effectiveRadii, polygonPoints, starPoints } from '../scene/shapes';
import { KAPPA } from './bezier';
import { mapNetwork, NetworkBuilder } from './network';

/** Layer types whose outline can be turned into a vector network. */
export function hasOutline(node: LayerNode): boolean {
  return (
    node.type === 'RECTANGLE' ||
    node.type === 'ELLIPSE' ||
    node.type === 'LINE' ||
    node.type === 'POLYGON' ||
    node.type === 'STAR' ||
    node.type === 'VECTOR'
  );
}

/**
 * The outline of a shape layer as a vector network in the layer's own space,
 * or null for layers that have no outline of their own (frames, groups) or
 * whose outline is not available (text). All outlines run clockwise on screen.
 */
export function shapeNetwork(node: LayerNode): VectorNetwork | null {
  const { width: w, height: h } = node;
  const k = KAPPA;
  switch (node.type) {
    case 'VECTOR':
      return node.network;
    case 'RECTANGLE': {
      const [tl, tr, br, bl] = effectiveRadii(w, h, node.cornerRadius, node.cornerRadii);
      const path = new NetworkBuilder().moveTo(tl, 0).lineTo(w - tr, 0);
      if (tr > 0) path.curveTo(w - tr + k * tr, 0, w, tr - k * tr, w, tr);
      path.lineTo(w, h - br);
      if (br > 0) path.curveTo(w, h - br + k * br, w - br + k * br, h, w - br, h);
      path.lineTo(bl, h);
      if (bl > 0) path.curveTo(bl - k * bl, h, 0, h - bl + k * bl, 0, h - bl);
      path.lineTo(0, tl);
      if (tl > 0) path.curveTo(0, tl - k * tl, tl - k * tl, 0, tl, 0);
      return path.close().build();
    }
    case 'ELLIPSE': {
      const rx = w / 2;
      const ry = h / 2;
      return new NetworkBuilder()
        .moveTo(rx, 0)
        .curveTo(rx + k * rx, 0, w, ry - k * ry, w, ry)
        .curveTo(w, ry + k * ry, rx + k * rx, h, rx, h)
        .curveTo(rx - k * rx, h, 0, ry + k * ry, 0, ry)
        .curveTo(0, ry - k * ry, rx - k * rx, 0, rx, 0)
        .close()
        .build();
    }
    case 'LINE':
      return new NetworkBuilder()
        .moveTo(0, h / 2)
        .lineTo(w, h / 2)
        .build();
    case 'POLYGON':
    case 'STAR': {
      const points = node.type === 'POLYGON' ? polygonPoints(w, h, node.pointCount) : starPoints(w, h, node.pointCount, node.innerRadius);
      const path = new NetworkBuilder();
      points.forEach((p, i) => (i === 0 ? path.moveTo(p.x, p.y) : path.lineTo(p.x, p.y)));
      return path.close().build();
    }
    default:
      return null;
  }
}

/** A network mirrored within a `width × height` box: left to right for 'horizontal', top to bottom for 'vertical'. */
export function mirrorNetwork(network: VectorNetwork, width: number, height: number, axis: 'horizontal' | 'vertical'): VectorNetwork {
  return mapNetwork(network, (p) => (axis === 'horizontal' ? { x: width - p.x, y: p.y } : { x: p.x, y: height - p.y }));
}

/** Joins several networks into one. Their points keep their coordinates. */
export function combineNetworks(networks: readonly VectorNetwork[]): VectorNetwork {
  const vertices: VectorNetwork['vertices'] = [];
  const segments: VectorNetwork['segments'] = [];
  for (const network of networks) {
    const offset = vertices.length;
    for (const vertex of network.vertices) vertices.push(vertex);
    for (const segment of network.segments) segments.push({ ...segment, start: segment.start + offset, end: segment.end + offset });
  }
  return { vertices, segments };
}
