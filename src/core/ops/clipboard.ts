import { createDocument } from '../document/factory';
import { patchNodes, setNodes } from '../document/mutate';
import { parseFile } from '../document/serialize';
import {
  CURRENT_SCHEMA_VERSION,
  FILE_FORMAT,
  isContainer,
  isLayer,
  type AssetInfo,
  type DesignNode,
  type Document,
  type LayerNode,
  type NodeId,
} from '../document/schema';
import { createId } from '../ids';
import { rectCenter, unionRects, type Point } from '../math/geometry';
import {
  getDescendantIds,
  getPages,
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

/** The type copied layers have on the system clipboard. */
export const CLIPBOARD_MIME = 'application/x-open-design-layers+json';
const CLIPBOARD_FORMAT = 'open-design/clipboard';

/** Copied layers together with what is known of the images they use: what goes on the clipboard. */
export interface ClipboardData {
  payload: ClipboardPayload;
  assets: Record<string, AssetInfo>;
}

/** The image assets that copied layers use, from the document they were copied from. */
export function clipboardAssets(doc: Document, payload: ClipboardPayload): Record<string, AssetInfo> {
  const assets: Record<string, AssetInfo> = {};
  for (const root of payload.roots) {
    for (const node of root.nodes) {
      for (const paint of [...node.fills, ...node.strokes]) {
        const asset = paint.type === 'IMAGE' ? doc.assets[paint.imageHash] : undefined;
        if (paint.type === 'IMAGE' && asset) assets[paint.imageHash] = asset;
      }
    }
  }
  return assets;
}

/** Copied layers as text, for the system clipboard. */
export function serializeClipboard(data: ClipboardData): string {
  return JSON.stringify({ format: CLIPBOARD_FORMAT, schemaVersion: CURRENT_SCHEMA_VERSION, payload: data.payload, assets: data.assets });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads what `serializeClipboard` wrote. The clipboard is outside the
 * application's control, so the layers on it are checked exactly as a file is
 * when it is opened, and brought up to date if an older version copied them.
 * Null when the text is not copied layers, comes from a newer version, or
 * holds nothing that can be used.
 */
export function parseClipboard(text: string): ClipboardData | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(raw) || raw.format !== CLIPBOARD_FORMAT || !isRecord(raw.payload) || !Array.isArray(raw.payload.roots)) return null;
  const source = raw.payload;
  const number = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  const point = (value: unknown): Point => (isRecord(value) ? { x: number(value.x), y: number(value.y) } : { x: 0, y: 0 });

  // The layers are put on the page of an otherwise empty document, which is then read as a file is.
  const shell = createDocument('Clipboard');
  const pageId = (getPages(shell)[0] as { id: NodeId }).id;
  const nodes: Record<string, unknown> = { ...shell.nodes };
  const roots: { ids: string[]; parentId: NodeId; worldCenter: Point; worldRotation: number }[] = [];
  for (const root of source.roots as unknown[]) {
    if (!isRecord(root) || !Array.isArray(root.nodes)) continue;
    const ids: string[] = [];
    for (const [index, node] of (root.nodes as unknown[]).entries()) {
      const usable = isRecord(node) && typeof node.id === 'string' && node.id !== '' && !(node.id in nodes);
      // Without its first layer, the one all the others are inside, a root is nothing.
      if (!usable && index === 0) break;
      if (!usable) continue;
      nodes[node.id as string] = index === 0 ? { ...node, parentId: pageId } : node;
      ids.push(node.id as string);
    }
    if (ids.length === 0) continue;
    roots.push({
      ids,
      parentId: typeof root.parentId === 'string' && root.parentId !== '' ? root.parentId : pageId,
      worldCenter: point(root.worldCenter),
      worldRotation: number(root.worldRotation),
    });
  }
  if (roots.length === 0) return null;

  let checked: Document;
  try {
    const now = new Date(0).toISOString();
    checked = parseFile({
      format: FILE_FORMAT,
      schemaVersion: raw.schemaVersion,
      meta: { createdAt: now, updatedAt: now },
      document: { id: shell.id, name: shell.name, nodes, assets: isRecord(raw.assets) ? raw.assets : {} },
    }).file.document;
  } catch {
    // Not a version this build can read.
    return null;
  }

  const kept: ClipboardRoot[] = [];
  for (const root of roots) {
    const found = root.ids.map((id) => checked.nodes[id]).filter(isLayer);
    const first = found[0];
    // The first layer must still be there, directly on the page it was put on.
    if (!first || first.id !== root.ids[0] || first.parentId !== pageId) continue;
    // A layer that the check moved out of the root (its parent was missing or unusable) is not part of it any more.
    const inside = new Set<NodeId>([first.id]);
    const members: LayerNode[] = [{ ...first, parentId: root.parentId }];
    for (const node of found.slice(1)) {
      if (!inside.has(node.parentId)) continue;
      inside.add(node.id);
      members.push(node);
    }
    kept.push({ nodes: members, parentId: root.parentId, worldCenter: root.worldCenter, worldRotation: root.worldRotation });
  }
  if (kept.length === 0) return null;
  return {
    payload: {
      kind: 'open-design/layers',
      sourceDocumentId: typeof source.sourceDocumentId === 'string' ? source.sourceDocumentId : '',
      sourcePageId: typeof source.sourcePageId === 'string' ? source.sourcePageId : null,
      center: point(source.center),
      roots: kept,
    },
    assets: checked.assets,
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
