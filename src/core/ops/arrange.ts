import { patchNodes } from '../document/mutate';
import { isContainer, isLayer, type Document, type LayerPatch, type NodeId } from '../document/schema';
import { freshKeys, keysBetween } from '../order';
import {
  getChildIds,
  getWorldRotation,
  isAncestor,
  sortByPaintOrder,
  topLevelIds,
} from '../scene/tree';
import { insertionKeys, topIndex } from './ordering';
import { placementInParent, worldCenterOf } from './transform';

/**
 * Moves layers into `parentId` at `index` (0 = bottom, omitted = top) while
 * keeping them exactly where they are on the page. Also used to reorder
 * within the same parent. A layer is never moved into itself or into one of
 * its own descendants.
 */
export function reparentNodes(
  doc: Document,
  ids: readonly NodeId[],
  parentId: NodeId,
  index?: number,
): Document {
  if (!isContainer(doc.nodes[parentId])) return doc;
  const moving = sortByPaintOrder(doc, topLevelIds(doc, ids)).filter(
    (id) => isLayer(doc.nodes[id]) && id !== parentId && !isAncestor(doc, id, parentId),
  );
  if (moving.length === 0) return doc;

  const exclude = new Set(moving);
  const { keys, rekeyed } = insertionKeys(
    doc,
    parentId,
    index ?? topIndex(doc, parentId, exclude),
    moving.length,
    exclude,
  );
  const patches: Record<NodeId, LayerPatch> = { ...rekeyed };
  moving.forEach((id, i) => {
    const node = doc.nodes[id];
    if (!isLayer(node)) return;
    const order = keys[i] as string;
    if (node.parentId === parentId) {
      patches[id] = { order };
      return;
    }
    const placed = placementInParent(
      doc,
      parentId,
      worldCenterOf(doc, id),
      node.width,
      node.height,
      getWorldRotation(doc, id),
    );
    patches[id] = { parentId, order, ...placed };
  });
  return patchNodes(doc, patches);
}

export type ReorderMode = 'front' | 'back' | 'forward' | 'backward';

/** Changes stacking order within each layer's own parent. */
export function reorderNodes(doc: Document, ids: readonly NodeId[], mode: ReorderMode): Document {
  const byParent = new Map<NodeId, Set<NodeId>>();
  for (const id of ids) {
    const node = doc.nodes[id];
    if (!isLayer(node)) continue;
    const set = byParent.get(node.parentId) ?? new Set<NodeId>();
    set.add(id);
    byParent.set(node.parentId, set);
  }

  let next = doc;
  for (const [parentId, selected] of byParent) {
    const current = [...getChildIds(next, parentId)];
    const target = reorderList(current, selected, mode);
    if (target.every((id, i) => id === current[i])) continue;
    next = applySiblingOrder(next, target, selected);
  }
  return next;
}

function reorderList(list: readonly NodeId[], selected: ReadonlySet<NodeId>, mode: ReorderMode): NodeId[] {
  const picked = list.filter((id) => selected.has(id));
  const rest = list.filter((id) => !selected.has(id));
  if (mode === 'front') return [...rest, ...picked];
  if (mode === 'back') return [...picked, ...rest];
  const out = [...list];
  if (mode === 'forward') {
    for (let i = out.length - 2; i >= 0; i--) {
      const a = out[i] as NodeId;
      const b = out[i + 1] as NodeId;
      if (selected.has(a) && !selected.has(b)) {
        out[i] = b;
        out[i + 1] = a;
      }
    }
  } else {
    for (let i = 1; i < out.length; i++) {
      const a = out[i] as NodeId;
      const b = out[i - 1] as NodeId;
      if (selected.has(a) && !selected.has(b)) {
        out[i] = b;
        out[i - 1] = a;
      }
    }
  }
  return out;
}

/**
 * Writes order keys so that siblings sort as `target`. Only the `moved`
 * layers get new keys; the others keep theirs, unless the existing keys are
 * unusable, in which case all of them are regenerated.
 */
function applySiblingOrder(doc: Document, target: readonly NodeId[], moved: ReadonlySet<NodeId>): Document {
  const patches: Record<NodeId, LayerPatch> = {};
  let i = 0;
  let lower: string | null = null;
  while (i < target.length) {
    const id = target[i] as NodeId;
    if (!moved.has(id)) {
      lower = doc.nodes[id]?.order ?? null;
      i++;
      continue;
    }
    let end = i;
    while (end < target.length && moved.has(target[end] as NodeId)) end++;
    const upperId = target[end];
    const upper = upperId === undefined ? null : (doc.nodes[upperId]?.order ?? null);
    const keys = keysBetween(lower, upper, end - i);
    if (!keys) {
      const all = freshKeys(target.length);
      const full: Record<NodeId, LayerPatch> = {};
      target.forEach((nodeId, n) => {
        full[nodeId] = { order: all[n] as string };
      });
      return patchNodes(doc, full);
    }
    for (let k = i; k < end; k++) patches[target[k] as NodeId] = { order: keys[k - i] as string };
    lower = keys[keys.length - 1] ?? lower;
    i = end;
  }
  return patchNodes(doc, patches);
}
