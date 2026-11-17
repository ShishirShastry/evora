import { setNodes } from '../document/mutate';
import { CONTAINER_TYPES, type DesignNode, type Document, type NodeId, type NodeMap } from '../document/schema';
import { keysBetween } from '../order';
import { getChildIds } from '../scene/tree';

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

/** The document's tables beside its nodes. An entry of one is changed as a whole. */
const TABLES = ['styles', 'variables', 'variableCollections'] as const;
type TableName = (typeof TABLES)[number];

export interface DocumentPatch {
  nodes: Record<NodeId, NodeChange>;
  /** For each table that changed: the entries that differ, whole, before and after (null where there is none). */
  tables?: Partial<Record<TableName, Record<string, { before: unknown; after: unknown }>>>;
  /** What the document has published, whole, before and after, when that changed. */
  publication?: { before: unknown; after: unknown };
}

function diffTables(before: Document, after: Document): DocumentPatch['tables'] | null {
  let out: NonNullable<DocumentPatch['tables']> | null = null;
  for (const table of TABLES) {
    const a = before[table] as Record<string, unknown>;
    const b = after[table] as Record<string, unknown>;
    if (a === b) continue;
    const entries: Record<string, { before: unknown; after: unknown }> = {};
    for (const id in b) if (!sameValue(a[id], b[id])) entries[id] = { before: a[id] ?? null, after: b[id] };
    for (const id in a) if (!(id in b)) entries[id] = { before: a[id], after: null };
    if (Object.keys(entries).length > 0) (out ??= {})[table] = entries;
  }
  return out;
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
  const tables = diffTables(before, after);
  const publication = sameValue(before.publication, after.publication) ? null : { before: before.publication, after: after.publication };
  const extra = { ...(tables ? { tables } : {}), ...(publication ? { publication } : {}) };
  const more = tables !== null || publication !== null;
  if (before.nodes === after.nodes) return more ? { nodes: {}, ...extra } : null;
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
  if (more) return { nodes, ...extra };
  return any ? { nodes } : null;
}

/** Whether a node hangs from a page through containers only, without going round in a circle. */
function hangsFromPage(nodes: NodeMap, id: NodeId): boolean {
  const seen = new Set<NodeId>();
  let current: DesignNode | undefined = nodes[id];
  while (current && current.type !== 'PAGE') {
    if (seen.has(current.id)) return false;
    seen.add(current.id);
    const parent: DesignNode | undefined = current.parentId === null ? undefined : nodes[current.parentId];
    if (!parent || !CONTAINER_TYPES.includes(parent.type)) return false;
    current = parent;
  }
  return current !== undefined;
}

/**
 * What a patch puts back has to fit the tree as it is now. In a shared
 * document someone else may have deleted a layer's parent, or moved layers
 * about, since the step was recorded. So a layer is not brought back under a
 * parent that is gone (nor into one of its own descendants): one that the
 * patch would re-create is left out, and one that exists stays as it is.
 * A layer whose old place in its stack has since been taken by another gets
 * a place of its own just above it. When the patch applies to the document it
 * was made from, none of this changes anything.
 */
function keepTreeSound(before: Document, after: Document, changes: Readonly<Record<NodeId, DesignNode | null>>): Document {
  // Only layers that were put back or moved can have landed somewhere unsound.
  const placed: NodeId[] = [];
  for (const id in changes) {
    const node = changes[id];
    const old = before.nodes[id];
    if (node && (!old || old.parentId !== node.parentId || old.order !== node.order)) placed.push(id);
  }
  if (placed.length === 0) return after;

  let doc = after;
  for (let pass = 0; pass <= placed.length; pass++) {
    const fixes: Record<NodeId, DesignNode | null> = {};
    let any = false;
    for (const id of placed) {
      const node = doc.nodes[id];
      if (!node || node.type === 'PAGE' || hangsFromPage(doc.nodes, id)) continue;
      // A layer that exists keeps all it has (its position belongs to where it is), a layer re-created is left out.
      const old = before.nodes[id] ?? null;
      fixes[id] = old && hangsFromPage({ ...doc.nodes, [id]: old }, id) ? old : null;
      any = true;
    }
    if (!any) break;
    doc = setNodes(doc, fixes);
  }

  // Each layer put back takes a place of its own in its stack.
  const orders: Record<NodeId, DesignNode> = {};
  const byParent = new Map<NodeId | null, NodeId[]>();
  for (const id of placed) {
    const node = doc.nodes[id];
    if (!node) continue;
    const group = byParent.get(node.parentId);
    if (group) group.push(id);
    else byParent.set(node.parentId, [id]);
  }
  for (const [parentId, ids] of byParent) {
    const keys = getChildIds(doc, parentId).map((id) => (doc.nodes[id] as DesignNode).order);
    const count = new Map<string, number>();
    for (const key of keys) count.set(key, (count.get(key) ?? 0) + 1);
    for (const id of [...ids].sort()) {
      const order = (orders[id] ?? (doc.nodes[id] as DesignNode)).order;
      if ((count.get(order) ?? 0) < 2 && order !== '') continue;
      let next: string | null = null;
      for (const key of count.keys()) if (key > order && (next === null || key < next)) next = key;
      const fresh = keysBetween(order || null, next, 1)?.[0];
      if (!fresh) continue;
      count.set(order, (count.get(order) ?? 1) - 1);
      count.set(fresh, 1);
      orders[id] = { ...(doc.nodes[id] as DesignNode), order: fresh } as DesignNode;
    }
  }
  return setNodes(doc, orders);
}

/**
 * Carries changes made elsewhere into a document worked out without them.
 *
 * A gesture (a drag, a resize, drawing) works its result out afresh at each
 * step, often from the document as it was when it began. When someone else
 * changes the document during the gesture (collaboration), those changes would
 * be lost from the next step. This applies each patch to `doc`, forwards, but
 * only where `doc` still has what the patch changed from: a layer created
 * elsewhere that `doc` lacks, a layer deleted elsewhere that `doc` still has,
 * and a property or table entry that `doc` still holds at its old value.
 * Wherever the gesture itself has changed the same thing, its value stays; a
 * step that was already worked out from the changed document is left as it is.
 */
export function carryPatches(doc: Document, patches: readonly DocumentPatch[]): Document {
  let out = doc;
  for (const patch of patches) {
    const nodes: Record<NodeId, NodeChange> = {};
    let any = false;
    for (const id in patch.nodes) {
      const change = patch.nodes[id] as NodeChange;
      const current = out.nodes[id] as unknown as Props | undefined;
      if (change.before === null || change.after === null) {
        // Created elsewhere and not here yet, or deleted elsewhere and still here.
        if ((change.before === null) === (current === undefined)) {
          nodes[id] = change;
          any = true;
        }
        continue;
      }
      if (!current) continue;
      const before: Props = {};
      const after: Props = {};
      let kept = false;
      for (const key in change.after) {
        if (!sameValue(current[key], change.before[key])) continue;
        before[key] = change.before[key];
        after[key] = change.after[key];
        kept = true;
      }
      if (kept) {
        nodes[id] = { before, after };
        any = true;
      }
    }
    let tables: DocumentPatch['tables'] | undefined;
    for (const table of TABLES) {
      const entries = patch.tables?.[table];
      if (!entries) continue;
      const rows = out[table] as Record<string, unknown>;
      for (const id in entries) {
        const entry = entries[id] as { before: unknown; after: unknown };
        if (sameValue(rows[id] ?? null, entry.before)) ((tables ??= {})[table] ??= {})[id] = entry;
      }
    }
    const publication = patch.publication && sameValue(out.publication, patch.publication.before) ? patch.publication : undefined;
    if (any || tables || publication) out = applyPatch(out, { nodes, ...(tables ? { tables } : {}), ...(publication ? { publication } : {}) }, 'forward');
  }
  return out;
}

/**
 * Applies a patch forwards (redo) or backwards (undo). Property changes are
 * merged into whatever the node currently is, so properties changed by someone
 * else in the meantime are left alone, and a change to a layer someone else
 * has deleted is skipped. Layers are only put back where they fit the tree as
 * it is now (see `keepTreeSound`), so a patch never leaves a broken document.
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
  let next = keepTreeSound(doc, setNodes(doc, changes), changes);
  for (const table of TABLES) {
    const entries = patch.tables?.[table];
    if (!entries) continue;
    const rows: Record<string, unknown> = { ...(next[table] as Record<string, unknown>) };
    for (const id in entries) {
      const entry = entries[id] as { before: unknown; after: unknown };
      const to = direction === 'forward' ? entry.after : entry.before;
      if (to === null) delete rows[id];
      else rows[id] = to;
    }
    next = { ...next, [table]: rows };
  }
  if (patch.publication) next = { ...next, publication: (direction === 'forward' ? patch.publication.after : patch.publication.before) as Document['publication'] };
  return next;
}
