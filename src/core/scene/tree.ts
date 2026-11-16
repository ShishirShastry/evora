import {
  isLayer,
  isPage,
  type DesignNode,
  type Document,
  type LayerNode,
  type NodeId,
  type NodeMap,
  type PageNode,
} from '../document/schema';
import { boxCorners, transformedBounds, type Point, type Rect } from '../math/geometry';
import { boxMatrix, IDENTITY, multiply, type Matrix } from '../math/matrix';

/**
 * Derived scene data. Nothing here is stored in the document: children lists
 * and world matrices are computed lazily and cached per `nodes` object, which
 * is immutable, so a cache entry can never go stale.
 */
interface SceneIndex {
  children: Map<string, readonly NodeId[]>;
  world: Map<NodeId, Matrix>;
}

const ROOT_KEY = '';
const EMPTY: readonly NodeId[] = Object.freeze([]);
const cache = new WeakMap<NodeMap, SceneIndex>();

export function compareSiblings(a: DesignNode, b: DesignNode): number {
  if (a.order < b.order) return -1;
  if (a.order > b.order) return 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function buildChildren(nodes: NodeMap): Map<string, readonly NodeId[]> {
  const groups = new Map<string, DesignNode[]>();
  for (const id in nodes) {
    const node = nodes[id] as DesignNode;
    const key = node.parentId ?? ROOT_KEY;
    const group = groups.get(key);
    if (group) group.push(node);
    else groups.set(key, [node]);
  }
  const children = new Map<string, readonly NodeId[]>();
  for (const [key, group] of groups) {
    group.sort(compareSiblings);
    children.set(
      key,
      group.map((n) => n.id),
    );
  }
  return children;
}

function getIndex(nodes: NodeMap): SceneIndex {
  let index = cache.get(nodes);
  if (!index) {
    index = { children: buildChildren(nodes), world: new Map() };
    cache.set(nodes, index);
  }
  return index;
}

/**
 * Tells the cache that `next` has the same tree structure as `prev` (no node
 * added or removed, no `parentId` or `order` changed), so the children lists
 * can be reused. Called by the mutation primitives.
 */
export function shareStructure(prev: NodeMap, next: NodeMap): void {
  const index = cache.get(prev);
  if (index && !cache.has(next)) cache.set(next, { children: index.children, world: new Map() });
}

export function getNode(doc: Document, id: NodeId | null | undefined): DesignNode | undefined {
  return id == null ? undefined : doc.nodes[id];
}

export function getLayer(doc: Document, id: NodeId | null | undefined): LayerNode | undefined {
  const node = getNode(doc, id);
  return isLayer(node) ? node : undefined;
}

/** Children of a node in paint order (bottom first). `null` returns the pages. */
export function getChildIds(doc: Document, parentId: NodeId | null): readonly NodeId[] {
  return getIndex(doc.nodes).children.get(parentId ?? ROOT_KEY) ?? EMPTY;
}

export function getPages(doc: Document): PageNode[] {
  const pages: PageNode[] = [];
  for (const id of getChildIds(doc, null)) {
    const node = doc.nodes[id];
    if (isPage(node) && !node.library) pages.push(node);
  }
  return pages;
}

/** The pages that hold what was imported from libraries. They are not among the document's pages. */
export function getLibraryPages(doc: Document): PageNode[] {
  const pages: PageNode[] = [];
  for (const id of getChildIds(doc, null)) {
    const node = doc.nodes[id];
    if (isPage(node) && node.library) pages.push(node);
  }
  return pages;
}

/** Ancestors from the direct parent up to and including the page. */
export function getAncestorIds(doc: Document, id: NodeId): NodeId[] {
  const out: NodeId[] = [];
  const seen = new Set<NodeId>([id]);
  let current = doc.nodes[id]?.parentId ?? null;
  while (current !== null && !seen.has(current)) {
    out.push(current);
    seen.add(current);
    current = doc.nodes[current]?.parentId ?? null;
  }
  return out;
}

export function getPageIdOf(doc: Document, id: NodeId): NodeId | null {
  const node = doc.nodes[id];
  if (!node) return null;
  if (node.type === 'PAGE') return id;
  const ancestors = getAncestorIds(doc, id);
  const top = ancestors[ancestors.length - 1];
  return top !== undefined && isPage(doc.nodes[top]) ? top : null;
}

export function isAncestor(doc: Document, ancestorId: NodeId, id: NodeId): boolean {
  return getAncestorIds(doc, id).includes(ancestorId);
}

/** All descendants in paint order (pre-order), not including the node itself. */
export function getDescendantIds(doc: Document, id: NodeId): NodeId[] {
  const out: NodeId[] = [];
  const walk = (parentId: NodeId): void => {
    for (const childId of getChildIds(doc, parentId)) {
      out.push(childId);
      walk(childId);
    }
  };
  walk(id);
  return out;
}

/** Removes IDs that are missing or whose ancestor is also in the list. */
export function topLevelIds(doc: Document, ids: readonly NodeId[]): NodeId[] {
  const set = new Set(ids);
  const out: NodeId[] = [];
  for (const id of set) {
    if (!doc.nodes[id]) continue;
    if (!getAncestorIds(doc, id).some((a) => set.has(a))) out.push(id);
  }
  return out;
}

/** Sorts IDs by paint order (bottom first) across the whole tree. */
export function sortByPaintOrder(doc: Document, ids: readonly NodeId[]): NodeId[] {
  const pathOf = (id: NodeId): DesignNode[] => {
    const chain = [id, ...getAncestorIds(doc, id)].reverse();
    return chain.map((nodeId) => doc.nodes[nodeId] as DesignNode);
  };
  const paths = new Map<NodeId, DesignNode[]>();
  for (const id of ids) if (doc.nodes[id]) paths.set(id, pathOf(id));
  return [...paths.keys()].sort((a, b) => {
    const pa = paths.get(a) as DesignNode[];
    const pb = paths.get(b) as DesignNode[];
    const n = Math.min(pa.length, pb.length);
    for (let i = 0; i < n; i++) {
      const na = pa[i] as DesignNode;
      const nb = pb[i] as DesignNode;
      if (na.id !== nb.id) return compareSiblings(na, nb);
    }
    return pa.length - pb.length;
  });
}

export function getLocalMatrix(node: LayerNode): Matrix {
  return boxMatrix(node.x, node.y, node.width, node.height, node.rotation);
}

/** Maps the node's local space (origin at its top-left corner) to page space. */
export function getWorldMatrix(doc: Document, id: NodeId | null): Matrix {
  if (id === null) return IDENTITY;
  const index = getIndex(doc.nodes);
  const cached = index.world.get(id);
  if (cached) return cached;
  const node = doc.nodes[id];
  let matrix: Matrix = IDENTITY;
  if (isLayer(node)) {
    // Guard against cycles in corrupt data: mark as identity while computing.
    index.world.set(id, IDENTITY);
    matrix = multiply(getWorldMatrix(doc, node.parentId), getLocalMatrix(node));
  }
  index.world.set(id, matrix);
  return matrix;
}

/** Sum of the rotations of a node and its ancestors, in degrees. */
export function getWorldRotation(doc: Document, id: NodeId | null): number {
  let total = 0;
  let current = id;
  const seen = new Set<NodeId>();
  while (current !== null && !seen.has(current)) {
    seen.add(current);
    const node = doc.nodes[current];
    if (!isLayer(node)) break;
    total += node.rotation;
    current = node.parentId;
  }
  return total;
}

/** Axis-aligned bounds of the node's box in page space. */
export function getWorldBounds(doc: Document, id: NodeId): Rect {
  const node = doc.nodes[id];
  if (!isLayer(node)) return { x: 0, y: 0, width: 0, height: 0 };
  return transformedBounds(getWorldMatrix(doc, id), node.width, node.height);
}

/** The node's box corners in page space: top-left, top-right, bottom-right, bottom-left. */
export function getWorldCorners(doc: Document, id: NodeId): [Point, Point, Point, Point] {
  const node = doc.nodes[id];
  if (!isLayer(node)) {
    const zero = { x: 0, y: 0 };
    return [zero, zero, zero, zero];
  }
  return boxCorners(getWorldMatrix(doc, id), node.width, node.height);
}
