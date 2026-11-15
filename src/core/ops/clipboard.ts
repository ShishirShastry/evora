import { patchNodes, setNodes } from '../document/mutate';
import {
  isContainer,
  isLayer,
  type DesignNode,
  type Document,
  type LayerNode,
  type NodeId,
} from '../document/schema';
import { createId } from '../ids';
import { rectCenter, unionRects, type Point } from '../math/geometry';
import {
  getDescendantIds,
  getPageIdOf,
  getWorldBounds,
  getWorldRotation,
  sortByPaintOrder,
  topLevelIds,
} from '../scene/tree';
import { insertionKeys, topIndex } from './ordering';
import { placementInParent, worldCenterOf } from './transform';

interface ClipboardRoot {
  /** The copied layer and its descendants, root first, with their original IDs. */
  nodes: LayerNode[];
  /** Where the root was: used to paste back into the same container. */
  parentId: NodeId;
  worldCenter: Point;
  worldRotation: number;
}

export interface ClipboardPayload {
  kind: 'open-design/layers';
  sourceDocumentId: string;
  sourcePageId: NodeId | null;
  /** Centre of everything copied, in page space. */
  center: Point;
  roots: ClipboardRoot[];
}

/** Captures layers (with their contents) so they can be pasted later, possibly into another file. */
export function copyNodes(doc: Document, ids: readonly NodeId[]): ClipboardPayload | null {
  const top = sortByPaintOrder(doc, topLevelIds(doc, ids)).filter((id) => isLayer(doc.nodes[id]));
  if (top.length === 0) return null;
  const roots: ClipboardRoot[] = top.map((id) => {
    const root = doc.nodes[id] as LayerNode;
    const nodes = [id, ...getDescendantIds(doc, id)]
      .map((nodeId) => doc.nodes[nodeId])
      .filter(isLayer)
      .map((node) => JSON.parse(JSON.stringify(node)) as LayerNode);
    return {
      nodes,
      parentId: root.parentId,
      worldCenter: worldCenterOf(doc, id),
      worldRotation: getWorldRotation(doc, id),
    };
  });
  const bounds = unionRects(top.map((id) => getWorldBounds(doc, id)));
  return {
    kind: 'open-design/layers',
    sourceDocumentId: doc.id,
    sourcePageId: getPageIdOf(doc, top[0] as NodeId),
    center: bounds ? rectCenter(bounds) : { x: 0, y: 0 },
    roots,
  };
}

export interface PasteOptions {
  /** The page to paste onto. */
  pageId: NodeId;
  /**
   * Where the centre of the pasted content should land, in page space. When
   * omitted the content is pasted at its original position.
   */
  center?: Point;
}

/**
 * Pastes copied layers with fresh IDs. Each layer goes back into its original
 * container when that container still exists on the target page; otherwise it
 * goes onto the page itself. Returns the IDs of the pasted top-level layers.
 */
export function pasteNodes(
  doc: Document,
  payload: ClipboardPayload,
  options: PasteOptions,
): { doc: Document; ids: NodeId[] } {
  if (doc.nodes[options.pageId]?.type !== 'PAGE') return { doc, ids: [] };
  const dx = options.center ? options.center.x - payload.center.x : 0;
  const dy = options.center ? options.center.y - payload.center.y : 0;

  let next = doc;
  const created: NodeId[] = [];
  for (const root of payload.roots) {
    const source = root.nodes[0];
    if (!source) continue;
    const originalParent = next.nodes[root.parentId];
    const parentId =
      isContainer(originalParent) && getPageIdOf(next, root.parentId) === options.pageId
        ? root.parentId
        : options.pageId;

    const idMap = new Map<NodeId, NodeId>();
    for (const node of root.nodes) idMap.set(node.id, createId());

    const { keys, rekeyed } = insertionKeys(next, parentId, topIndex(next, parentId), 1);
    next = patchNodes(next, rekeyed);
    const placed = placementInParent(
      next,
      parentId,
      { x: root.worldCenter.x + dx, y: root.worldCenter.y + dy },
      source.width,
      source.height,
      root.worldRotation,
    );

    const changes: Record<NodeId, DesignNode> = {};
    root.nodes.forEach((node, i) => {
      const id = idMap.get(node.id) as NodeId;
      changes[id] =
        i === 0
          ? { ...node, id, parentId, order: keys[0] as string, ...placed }
          : { ...node, id, parentId: idMap.get(node.parentId) ?? node.parentId };
    });
    next = setNodes(next, changes);
    created.push(idMap.get(source.id) as NodeId);
  }
  return { doc: next, ids: created };
}
