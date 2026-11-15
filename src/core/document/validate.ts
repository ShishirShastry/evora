import { createId } from '../ids';
import { freshKeys } from '../order';
import { createLayer, createPage, DEFAULT_PAGE_BACKGROUND } from './factory';
import {
  CONTAINER_TYPES,
  LAYER_TYPES,
  TEXT_ALIGNS,
  TEXT_AUTO_RESIZES,
  TEXT_CASES,
  TEXT_DECORATIONS,
  VERTICAL_ALIGNS,
  type DesignNode,
  type Document,
  type LayerNode,
  type LayerType,
  type NodeId,
  type PageNode,
  type Paint,
  type RGB,
  type StrokeAlign,
} from './schema';

type Raw = Record<string, unknown>;

export interface RepairResult {
  doc: Document;
  /** Human-readable descriptions of everything that had to be fixed. Empty when the input was valid. */
  repairs: string[];
}

function isObject(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finite(value: unknown, fallback: number, min = -Infinity, max = Infinity): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function rgb(value: unknown, fallback: RGB): RGB {
  if (!isObject(value)) return { ...fallback };
  return { r: finite(value.r, fallback.r, 0, 1), g: finite(value.g, fallback.g, 0, 1), b: finite(value.b, fallback.b, 0, 1) };
}

function paints(value: unknown): Paint[] {
  if (!Array.isArray(value)) return [];
  const out: Paint[] = [];
  for (const item of value) {
    if (!isObject(item) || item.type !== 'SOLID') continue;
    out.push({
      type: 'SOLID',
      color: rgb(item.color, { r: 0, g: 0, b: 0 }),
      opacity: finite(item.opacity, 1, 0, 1),
      visible: item.visible !== false,
    });
  }
  return out;
}

const STROKE_ALIGNS: readonly StrokeAlign[] = ['INSIDE', 'CENTER', 'OUTSIDE'];

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/** Rebuilds a node from raw data, keeping every valid field and defaulting or clamping the rest. */
function normalizeNode(id: NodeId, raw: Raw): DesignNode | null {
  const type = raw.type;
  const name = typeof raw.name === 'string' ? raw.name : '';
  const order = typeof raw.order === 'string' ? raw.order : '';

  if (type === 'PAGE') {
    const page: PageNode = {
      id,
      type: 'PAGE',
      name: name || 'Page',
      parentId: null,
      order,
      backgroundColor: rgb(raw.backgroundColor, DEFAULT_PAGE_BACKGROUND),
    };
    return page;
  }
  if (typeof type !== 'string' || !(LAYER_TYPES as readonly string[]).includes(type)) return null;

  const defaults = createLayer(type as LayerType, '', order);
  const layer = {
    ...defaults,
    id,
    name: name || defaults.name,
    parentId: typeof raw.parentId === 'string' ? raw.parentId : '',
    order,
    visible: raw.visible !== false,
    locked: raw.locked === true,
    x: finite(raw.x, 0),
    y: finite(raw.y, 0),
    width: finite(raw.width, defaults.width, 0),
    height: finite(raw.height, defaults.height, 0),
    rotation: finite(raw.rotation, 0, -360, 360),
    opacity: finite(raw.opacity, 1, 0, 1),
    fills: paints(raw.fills),
    strokes: paints(raw.strokes),
    strokeWeight: finite(raw.strokeWeight, 1, 0),
    strokeAlign: STROKE_ALIGNS.includes(raw.strokeAlign as StrokeAlign) ? (raw.strokeAlign as StrokeAlign) : defaults.strokeAlign,
  } as LayerNode;

  if (layer.type === 'FRAME') {
    layer.clipsContent = raw.clipsContent !== false;
    layer.cornerRadius = finite(raw.cornerRadius, 0, 0);
  } else if (layer.type === 'RECTANGLE') {
    layer.cornerRadius = finite(raw.cornerRadius, 0, 0);
  } else if (layer.type === 'POLYGON') {
    layer.pointCount = Math.round(finite(raw.pointCount, 3, 3, 60));
  } else if (layer.type === 'STAR') {
    layer.pointCount = Math.round(finite(raw.pointCount, 5, 3, 60));
    layer.innerRadius = finite(raw.innerRadius, 0.382, 0, 1);
  } else if (layer.type === 'TEXT') {
    layer.characters = typeof raw.characters === 'string' ? raw.characters : '';
    layer.fontFamily = typeof raw.fontFamily === 'string' && raw.fontFamily.trim() ? raw.fontFamily : layer.fontFamily;
    layer.fontSize = finite(raw.fontSize, layer.fontSize, 1, 2000);
    layer.fontWeight = Math.round(finite(raw.fontWeight, 400, 100, 900) / 100) * 100;
    layer.italic = raw.italic === true;
    layer.lineHeight = raw.lineHeight === null || raw.lineHeight === undefined ? null : finite(raw.lineHeight, layer.fontSize * 1.2, 1, 10000);
    layer.letterSpacing = finite(raw.letterSpacing, 0, -200, 2000);
    layer.textAlign = oneOf(raw.textAlign, TEXT_ALIGNS, 'LEFT');
    layer.verticalAlign = oneOf(raw.verticalAlign, VERTICAL_ALIGNS, 'TOP');
    layer.textAutoResize = oneOf(raw.textAutoResize, TEXT_AUTO_RESIZES, 'WIDTH_AND_HEIGHT');
    layer.textDecoration = oneOf(raw.textDecoration, TEXT_DECORATIONS, 'NONE');
    layer.textCase = oneOf(raw.textCase, TEXT_CASES, 'ORIGINAL');
  }
  return layer;
}

/**
 * Validates untrusted document data against the schema and repairs it where
 * that can be done without guessing: the result always satisfies every
 * invariant listed in DOCUMENT_SCHEMA.md §7.
 */
export function repairDocument(input: unknown): RepairResult {
  const repairs: string[] = [];
  const source = isObject(input) ? input : {};
  if (!isObject(input)) repairs.push('The document was not an object; started from an empty document.');

  const id = typeof source.id === 'string' && source.id ? source.id : createId();
  const name = typeof source.name === 'string' && source.name ? source.name : 'Untitled';
  const rawNodes = isObject(source.nodes) ? source.nodes : {};

  const nodes: Record<NodeId, DesignNode> = {};
  let dropped = 0;
  for (const key in rawNodes) {
    const raw = rawNodes[key];
    const node = isObject(raw) ? normalizeNode(key, raw) : null;
    if (!node) {
      dropped++;
      continue;
    }
    if (isObject(raw) && raw.id !== key) repairs.push(`Layer "${node.name}" had a mismatched ID; re-keyed.`);
    nodes[key] = node;
  }
  if (dropped > 0) repairs.push(`${dropped} item(s) of an unknown type were removed.`);

  // Unchanged values must not be reported, so compare what normalisation altered.
  let adjusted = 0;
  for (const key in nodes) {
    const raw = rawNodes[key] as Raw;
    const node = nodes[key] as unknown as Raw;
    for (const prop in node) {
      if (prop === 'id' || prop === 'parentId' || prop === 'order') continue;
      if (JSON.stringify(node[prop]) !== JSON.stringify(raw[prop])) {
        adjusted++;
        break;
      }
    }
  }
  if (adjusted > 0) repairs.push(`${adjusted} layer(s) had missing or out-of-range values that were reset.`);

  // At least one page.
  let pageIds = Object.keys(nodes).filter((key) => nodes[key]?.type === 'PAGE');
  if (pageIds.length === 0) {
    const page = createPage('Page 1', freshKeys(1)[0] as string);
    nodes[page.id] = page;
    pageIds = [page.id];
    repairs.push('The document had no pages; an empty page was added.');
  }
  pageIds.sort((a, b) => {
    const na = nodes[a] as DesignNode;
    const nb = nodes[b] as DesignNode;
    return na.order < nb.order ? -1 : na.order > nb.order ? 1 : a < b ? -1 : 1;
  });
  const firstPage = pageIds[0] as NodeId;

  // Children of removed layers go with them; other bad parents are reattached.
  const droppedParents = new Set<NodeId>();
  for (const key in rawNodes) if (!nodes[key]) droppedParents.add(key);
  let removedWithParent = 0;
  let reattached = 0;
  const reachesPage = (startId: NodeId): 'ok' | 'dropped' | 'broken' => {
    const seen = new Set<NodeId>();
    let current: NodeId | null = startId;
    while (current !== null) {
      if (seen.has(current)) return 'broken';
      seen.add(current);
      const node: DesignNode | undefined = nodes[current];
      if (!node) return droppedParents.has(current) ? 'dropped' : 'broken';
      if (node.type === 'PAGE') return 'ok';
      const parent: DesignNode | undefined = nodes[node.parentId];
      if (parent && !CONTAINER_TYPES.includes(parent.type)) return 'broken';
      current = node.parentId;
    }
    return 'broken';
  };
  for (const key of Object.keys(nodes)) {
    const node = nodes[key];
    if (!node || node.type === 'PAGE') continue;
    const state = reachesPage(key);
    if (state === 'dropped') {
      delete nodes[key];
      removedWithParent++;
    } else if (state === 'broken') {
      nodes[key] = { ...node, parentId: firstPage };
      reattached++;
    }
  }
  if (removedWithParent > 0) repairs.push(`${removedWithParent} layer(s) inside removed items were removed.`);
  if (reattached > 0) repairs.push(`${reattached} layer(s) with a missing or invalid parent were moved to the first page.`);

  // Sibling order keys must be non-empty and unique.
  const groups = new Map<string, DesignNode[]>();
  for (const key in nodes) {
    const node = nodes[key] as DesignNode;
    const groupKey = node.parentId ?? '';
    const group = groups.get(groupKey);
    if (group) group.push(node);
    else groups.set(groupKey, [node]);
  }
  let rekeyedGroups = 0;
  for (const group of groups.values()) {
    const seen = new Set<string>();
    const bad = group.some((node) => {
      if (!node.order || seen.has(node.order)) return true;
      seen.add(node.order);
      return false;
    });
    if (!bad) continue;
    group.sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : a.id < b.id ? -1 : 1));
    const keys = freshKeys(group.length);
    group.forEach((node, i) => {
      nodes[node.id] = { ...node, order: keys[i] as string } as DesignNode;
    });
    rekeyedGroups++;
  }
  if (rekeyedGroups > 0) repairs.push(`Layer order was rebuilt in ${rekeyedGroups} place(s).`);

  return { doc: { id, name, nodes }, repairs };
}

/** Lists what is wrong with a document. An empty list means it is valid. */
export function validateDocument(doc: unknown): string[] {
  return repairDocument(doc).repairs;
}
