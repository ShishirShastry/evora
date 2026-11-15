import { setNodes } from '../document/mutate';
import type { DesignNode, Document, NodeId } from '../document/schema';

type Props = Record<string, unknown>;

/**
 * What happened to one node between two document snapshots.
 * - created: `before` is null and `after` is the whole node.
 * - deleted: `after` is null and `before` is the whole node.
 * - changed: both hold only the properties that differ. A property that is
 *   absent on one side is recorded there as `undefined`.
 */
export interface NodeChange {
  before: Props | null;
  after: Props | null;
}

export interface DocumentPatch {
  nodes: Record<NodeId, NodeChange>;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Computes the property-level difference between two snapshots. Untouched
 * nodes are shared by reference between snapshots, so they are skipped with a
 * single comparison each. Returns `null` when nothing differs.
 */
export function diffDocuments(before: Document, after: Document): DocumentPatch | null {
  if (before.nodes === after.nodes) return null;
  const nodes: Record<NodeId, NodeChange> = {};
  let any = false;

  for (const id in after.nodes) {
    const b = after.nodes[id] as DesignNode;
    const a = before.nodes[id];
    if (a === b) continue;
    if (!a) {
      nodes[id] = { before: null, after: b as unknown as Props };
      any = true;
      continue;
    }
    const pa = a as unknown as Props;
    const pb = b as unknown as Props;
    const beforeProps: Props = {};
    const afterProps: Props = {};
    let changed = false;
    for (const key in pb) {
      if (!sameValue(pa[key], pb[key])) {
        beforeProps[key] = pa[key];
        afterProps[key] = pb[key];
        changed = true;
      }
    }
    for (const key in pa) {
      if (!(key in pb)) {
        beforeProps[key] = pa[key];
        afterProps[key] = undefined;
        changed = true;
      }
    }
    if (changed) {
      nodes[id] = { before: beforeProps, after: afterProps };
      any = true;
    }
  }
  for (const id in before.nodes) {
    if (!(id in after.nodes)) {
      nodes[id] = { before: before.nodes[id] as unknown as Props, after: null };
      any = true;
    }
  }
  return any ? { nodes } : null;
}

/**
 * Applies a patch forwards (redo) or backwards (undo). Property changes are
 * merged into whatever the node currently is, so properties changed by someone
 * else in the meantime are left alone.
 */
export function applyPatch(doc: Document, patch: DocumentPatch, direction: 'forward' | 'backward'): Document {
  const changes: Record<NodeId, DesignNode | null> = {};
  for (const id in patch.nodes) {
    const change = patch.nodes[id] as NodeChange;
    const from = direction === 'forward' ? change.before : change.after;
    const to = direction === 'forward' ? change.after : change.before;
    const current = doc.nodes[id];

    if (to === null) {
      if (current) changes[id] = null;
      continue;
    }
    if (from === null) {
      // Re-create the node. If it already exists again, keep the existing one.
      if (!current) changes[id] = to as unknown as DesignNode;
      continue;
    }
    if (!current) continue;
    const merged: Props = { ...(current as unknown as Props) };
    for (const key in to) {
      if (to[key] === undefined) delete merged[key];
      else merged[key] = to[key];
    }
    changes[id] = merged as unknown as DesignNode;
  }
  return setNodes(doc, changes);
}
