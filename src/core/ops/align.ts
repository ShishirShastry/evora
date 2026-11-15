import { patchNodes } from '../document/mutate';
import { isContainer, isFrame, isLayer, type Document, type LayerPatch, type NodeId } from '../document/schema';
import { normalizeAngle, transformedBounds, unionRects, type Rect } from '../math/geometry';
import { getChildIds, getLocalMatrix, getWorldBounds, sortByPaintOrder, topLevelIds } from '../scene/tree';
import { clean, moveNodesBy } from './transform';

export type AlignMode = 'left' | 'centerX' | 'right' | 'top' | 'centerY' | 'bottom';

/**
 * Aligns layers by their page-space bounding boxes. Several layers align to
 * the bounds of the selection; a single layer inside a frame aligns to that
 * frame. Returns the same document when there is nothing to align to.
 */
export function alignNodes(doc: Document, ids: readonly NodeId[], mode: AlignMode): Document {
  const members = topLevelIds(doc, ids).filter((id) => isLayer(doc.nodes[id]));
  if (members.length === 0) return doc;

  let target: Rect | null;
  if (members.length === 1) {
    const only = doc.nodes[members[0] as NodeId];
    const parent = isLayer(only) ? doc.nodes[only.parentId] : undefined;
    if (!isFrame(parent)) return doc;
    target = getWorldBounds(doc, parent.id);
  } else {
    target = unionRects(members.map((id) => getWorldBounds(doc, id)));
  }
  if (!target) return doc;

  let next = doc;
  for (const id of members) {
    const b = getWorldBounds(next, id);
    let dx = 0;
    let dy = 0;
    if (mode === 'left') dx = target.x - b.x;
    else if (mode === 'centerX') dx = target.x + target.width / 2 - (b.x + b.width / 2);
    else if (mode === 'right') dx = target.x + target.width - (b.x + b.width);
    else if (mode === 'top') dy = target.y - b.y;
    else if (mode === 'centerY') dy = target.y + target.height / 2 - (b.y + b.height / 2);
    else dy = target.y + target.height - (b.y + b.height);
    next = moveNodesBy(next, [id], dx, dy);
  }
  return next;
}

export type DistributeAxis = 'horizontal' | 'vertical';

/**
 * Spaces three or more layers evenly along an axis: the outermost two stay
 * where they are and the gaps between neighbours become equal.
 */
export function distributeNodes(doc: Document, ids: readonly NodeId[], axis: DistributeAxis): Document {
  const members = topLevelIds(doc, ids).filter((id) => isLayer(doc.nodes[id]));
  if (members.length < 3) return doc;
  const horizontal = axis === 'horizontal';
  const start = (r: Rect): number => (horizontal ? r.x : r.y);
  const size = (r: Rect): number => (horizontal ? r.width : r.height);

  const items = members
    .map((id) => ({ id, bounds: getWorldBounds(doc, id) }))
    .sort((a, b) => start(a.bounds) - start(b.bounds) || start(a.bounds) + size(a.bounds) - (start(b.bounds) + size(b.bounds)));
  const first = items[0] as (typeof items)[number];
  const last = items[items.length - 1] as (typeof items)[number];
  const span = start(last.bounds) + size(last.bounds) - start(first.bounds);
  const total = items.reduce((sum, item) => sum + size(item.bounds), 0);
  const gap = (span - total) / (items.length - 1);

  let next = doc;
  let cursor = start(first.bounds);
  for (const item of items) {
    const delta = cursor - start(item.bounds);
    if (Math.abs(delta) > 1e-9) next = moveNodesBy(next, [item.id], horizontal ? delta : 0, horizontal ? 0 : delta);
    cursor += size(item.bounds) + gap;
  }
  return next;
}

export type FlipAxis = 'horizontal' | 'vertical';

/**
 * Mirrors the contents of a container inside its own box, recursively. Every
 * shape that exists today is symmetric about its own vertical axis, so a
 * mirror image is exactly "position mirrored, rotation negated" (plus a half
 * turn for a vertical flip of shapes that have a top, such as triangles and
 * stars). No flip flag is needed until asymmetric content exists.
 */
function flipInside(doc: Document, containerId: NodeId, axis: FlipAxis, patches: Record<NodeId, LayerPatch>): void {
  const container = doc.nodes[containerId];
  if (!isLayer(container)) return;
  for (const childId of getChildIds(doc, containerId)) {
    const child = doc.nodes[childId];
    if (!isLayer(child)) continue;
    const center = { x: child.x + child.width / 2, y: child.y + child.height / 2 };
    const mirrored = axis === 'horizontal' ? { x: container.width - center.x, y: center.y } : { x: center.x, y: container.height - center.y };
    patches[childId] = {
      x: clean(mirrored.x - child.width / 2),
      y: clean(mirrored.y - child.height / 2),
      rotation: mirroredRotation(child.type, child.rotation, axis),
    };
    if (isContainer(child)) flipInside(doc, childId, axis, patches);
  }
}

function mirroredRotation(type: string, rotation: number, axis: FlipAxis): number {
  const halfTurn = axis === 'vertical' && (type === 'POLYGON' || type === 'STAR') ? 180 : 0;
  return clean(normalizeAngle(-rotation + halfTurn));
}

/**
 * Flips layers. One layer flips in place; several layers that share a parent
 * also swap sides within their common bounds.
 */
export function flipNodes(doc: Document, ids: readonly NodeId[], axis: FlipAxis): Document {
  const members = sortByPaintOrder(doc, topLevelIds(doc, ids)).filter((id) => isLayer(doc.nodes[id]));
  if (members.length === 0) return doc;

  const byParent = new Map<NodeId, NodeId[]>();
  for (const id of members) {
    const node = doc.nodes[id];
    if (!isLayer(node)) continue;
    const list = byParent.get(node.parentId) ?? [];
    list.push(id);
    byParent.set(node.parentId, list);
  }

  const patches: Record<NodeId, LayerPatch> = {};
  for (const group of byParent.values()) {
    // Mirror line: the middle of these layers' bounds, in their parent's space.
    const rects: Rect[] = [];
    for (const id of group) {
      const node = doc.nodes[id];
      if (isLayer(node)) rects.push(transformedBounds(getLocalMatrix(node), node.width, node.height));
    }
    const bounds = unionRects(rects);
    if (!bounds) continue;
    const mid = axis === 'horizontal' ? bounds.x + bounds.width / 2 : bounds.y + bounds.height / 2;
    for (const id of group) {
      const node = doc.nodes[id];
      if (!isLayer(node)) continue;
      const center = { x: node.x + node.width / 2, y: node.y + node.height / 2 };
      const mirrored = axis === 'horizontal' ? { x: 2 * mid - center.x, y: center.y } : { x: center.x, y: 2 * mid - center.y };
      patches[id] = {
        x: clean(mirrored.x - node.width / 2),
        y: clean(mirrored.y - node.height / 2),
        rotation: mirroredRotation(node.type, node.rotation, axis),
      };
      if (isContainer(node)) flipInside(doc, id, axis, patches);
    }
  }
  return patchNodes(doc, patches);
}
