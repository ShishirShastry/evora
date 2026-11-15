import { createLayer, nextLayerName } from '../document/factory';
import { patchNodes, setNodes } from '../document/mutate';
import {
  isContainer,
  isLayer,
  type DesignNode,
  type Document,
  type LayerNode,
  type LayerPatch,
  type LayerType,
  type NodeId,
} from '../document/schema';
import { createId } from '../ids';
import { getChildIds, getDescendantIds, sortByPaintOrder, topLevelIds } from '../scene/tree';
import { insertionKeys, topIndex } from './ordering';

/**
 * Creates a layer inside `parentId`. It goes on top of its siblings unless
 * `index` says otherwise, and gets the next default name unless `props.name`
 * is given.
 */
export function addLayer(
  doc: Document,
  type: LayerType,
  parentId: NodeId,
  props: LayerPatch = {},
  index?: number,
): { doc: Document; id: NodeId } {
  if (!isContainer(doc.nodes[parentId])) throw new Error(`Cannot add a layer to "${parentId}": not a container`);
  const { keys, rekeyed } = insertionKeys(doc, parentId, index ?? topIndex(doc, parentId), 1);
  const node = createLayer(type, parentId, keys[0] as string, {
    name: nextLayerName(doc, type),
    ...props,
  });
  const next = setNodes(patchNodes(doc, rekeyed), { [node.id]: node });
  return { doc: next, id: node.id };
}

/** Deletes layers and everything inside them. Pages are not deleted here. */
export function deleteNodes(doc: Document, ids: readonly NodeId[]): Document {
  const changes: Record<NodeId, null> = {};
  for (const id of topLevelIds(doc, ids)) {
    if (!isLayer(doc.nodes[id])) continue;
    changes[id] = null;
    for (const descendant of getDescendantIds(doc, id)) changes[descendant] = null;
  }
  return setNodes(doc, changes);
}

/**
 * Copies a layer and its descendants with fresh IDs. The copy of the root
 * keeps the original's `parentId` and `order`; the caller repositions it.
 */
export function cloneSubtree(doc: Document, rootId: NodeId): LayerNode[] {
  const root = doc.nodes[rootId];
  if (!isLayer(root)) return [];
  const idMap = new Map<NodeId, NodeId>([[rootId, createId()]]);
  const sourceIds = [rootId, ...getDescendantIds(doc, rootId)];
  for (const id of sourceIds) if (!idMap.has(id)) idMap.set(id, createId());
  const out: LayerNode[] = [];
  for (const id of sourceIds) {
    const node = doc.nodes[id];
    if (!isLayer(node)) continue;
    out.push({
      ...structuredCloneNode(node),
      id: idMap.get(id) as NodeId,
      parentId: id === rootId ? node.parentId : (idMap.get(node.parentId) ?? node.parentId),
    });
  }
  return out;
}

function structuredCloneNode<T extends DesignNode>(node: T): T {
  return JSON.parse(JSON.stringify(node)) as T;
}

/**
 * Duplicates layers. Each copy sits directly above its original in the same
 * parent. Returns the IDs of the copies of the top-level layers.
 */
export function duplicateNodes(doc: Document, ids: readonly NodeId[]): { doc: Document; ids: NodeId[] } {
  let next = doc;
  const created: NodeId[] = [];
  for (const id of sortByPaintOrder(doc, topLevelIds(doc, ids))) {
    const original = next.nodes[id];
    if (!isLayer(original)) continue;
    const clones = cloneSubtree(next, id);
    const root = clones[0];
    if (!root) continue;
    const siblings = getChildIds(next, original.parentId);
    const { keys, rekeyed } = insertionKeys(next, original.parentId, siblings.indexOf(id) + 1, 1);
    next = patchNodes(next, rekeyed);
    const changes: Record<NodeId, DesignNode> = {};
    for (const clone of clones) changes[clone.id] = clone === root ? { ...root, order: keys[0] as string } : clone;
    next = setNodes(next, changes);
    created.push(root.id);
  }
  return { doc: next, ids: created };
}
