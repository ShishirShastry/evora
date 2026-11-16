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

type TableName = 'styles' | 'variables' | 'variableCollections';

/**
 * Adds, replaces (an entry) or removes (`null`) entries of one of the
 * document's tables of styles, variables or variable collections. Returns
 * the same document when nothing changed.
 */
export function setTable<K extends TableName>(doc: Document, table: K, changes: Readonly<Record<string, Document[K][string] | null>>): Document {
  const next: Record<string, Document[K][string]> = { ...(doc[table] as Record<string, Document[K][string]>) };
  let changed = false;
  for (const id in changes) {
    const value = changes[id] as Document[K][string] | null;
    if (value === null) {
      if (id in next) {
        delete next[id];
        changed = true;
      }
    } else if (JSON.stringify(next[id]) !== JSON.stringify(value)) {
      next[id] = value;
      changed = true;
    }
  }
  return changed ? { ...doc, [table]: next } : doc;
}

export function patchNode(doc: Document, id: NodeId, patch: NodePatch): Document {
  return patchNodes(doc, { [id]: patch });
}
