import type { Document, NodeId } from '../document/schema';
import { freshKeys, keysBetween } from '../order';
import { getChildIds } from '../scene/tree';

export interface InsertionKeys {
  /** Order keys for the nodes being inserted, bottom first. */
  keys: string[];
  /** Order changes for existing siblings; empty unless their keys had to be regenerated. */
  rekeyed: Record<NodeId, { order: string }>;
}

/**
 * Order keys for placing `count` nodes into `parentId` at `index`, where 0 is
 * the bottom of the stack and `siblings.length` is the top. Nodes in `exclude`
 * are treated as if they were not there, which is what a move needs.
 *
 * Normally only the new keys are returned. If the neighbouring keys are equal
 * or malformed (possible after a concurrent edit or a damaged file) every
 * sibling is re-keyed so the order becomes well defined again.
 */
export function insertionKeys(
  doc: Document,
  parentId: NodeId | null,
  index: number,
  count: number,
  exclude: ReadonlySet<NodeId> = new Set(),
): InsertionKeys {
  const siblings = getChildIds(doc, parentId).filter((id) => !exclude.has(id));
  const at = Math.max(0, Math.min(index, siblings.length));
  const orderAt = (i: number): string | null => {
    const id = siblings[i];
    return id === undefined ? null : (doc.nodes[id]?.order ?? null);
  };
  const keys = keysBetween(at > 0 ? orderAt(at - 1) : null, orderAt(at), count);
  if (keys) return { keys, rekeyed: {} };

  const all = freshKeys(siblings.length + count);
  const rekeyed: Record<NodeId, { order: string }> = {};
  siblings.forEach((id, i) => {
    rekeyed[id] = { order: all[i < at ? i : i + count] as string };
  });
  return { keys: all.slice(at, at + count), rekeyed };
}

/** Index that places a node at the top of `parentId`'s children. */
export function topIndex(doc: Document, parentId: NodeId | null, exclude: ReadonlySet<NodeId> = new Set()): number {
  return getChildIds(doc, parentId).filter((id) => !exclude.has(id)).length;
}
