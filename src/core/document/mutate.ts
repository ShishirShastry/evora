import { shareStructure } from '../scene/tree';
import type { DesignNode, Document, NodeId, NodePatch } from './schema';

/**
 * The two primitives every document change goes through. Both return a new
 * document that shares all untouched nodes with the old one, or the same
 * document when nothing actually changed.
 */

/** Adds, replaces (`node`) or removes (`null`) whole nodes. */
export function setNodes(doc: Document, changes: Readonly<Record<NodeId, DesignNode | null>>): Document {
  let changed = false;
  let structural = false;
  const next: Record<NodeId, DesignNode> = { ...doc.nodes };
  for (const id in changes) {
    const value = changes[id] as DesignNode | null;
    const prev = doc.nodes[id];
    if (value === null) {
      if (prev) {
        delete next[id];
        changed = true;
        structural = true;
      }
      continue;
    }
    if (value === prev) continue;
    if (!prev || prev.parentId !== value.parentId || prev.order !== value.order) structural = true;
    next[id] = value;
    changed = true;
  }
  if (!changed) return doc;
  if (!structural) shareStructure(doc.nodes, next);
  return { ...doc, nodes: next };
}

/** Merges property patches into existing nodes. Unknown IDs are ignored. */
export function patchNodes(doc: Document, patches: Readonly<Record<NodeId, NodePatch>>): Document {
  const changes: Record<NodeId, DesignNode> = {};
  for (const id in patches) {
    const node = doc.nodes[id];
    if (!node) continue;
    const patch = patches[id] as Record<string, unknown>;
    const current = node as unknown as Record<string, unknown>;
    let differs = false;
    for (const key in patch) {
      if (!Object.is(current[key], patch[key])) {
        differs = true;
        break;
      }
    }
    if (differs) changes[id] = { ...node, ...patch } as DesignNode;
  }
  return setNodes(doc, changes);
}

export function patchNode(doc: Document, id: NodeId, patch: NodePatch): Document {
  return patchNodes(doc, { [id]: patch });
}
