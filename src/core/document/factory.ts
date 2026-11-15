import { createId } from '../ids';
import { freshKeys } from '../order';
import type {
  Document,
  LayerNode,
  LayerPatch,
  LayerType,
  NodeId,
  PageNode,
  RGB,
  SolidPaint,
} from './schema';

export const DEFAULT_PAGE_BACKGROUND: RGB = { r: 0.118, g: 0.118, b: 0.118 };
export const DEFAULT_SHAPE_FILL: RGB = { r: 0.851, g: 0.851, b: 0.851 };
export const WHITE: RGB = { r: 1, g: 1, b: 1 };
export const BLACK: RGB = { r: 0, g: 0, b: 0 };

export const TYPE_LABELS: Record<LayerType, string> = {
  FRAME: 'Frame',
  RECTANGLE: 'Rectangle',
  ELLIPSE: 'Ellipse',
  LINE: 'Line',
  POLYGON: 'Polygon',
  STAR: 'Star',
};

export function solidPaint(color: RGB, opacity = 1): SolidPaint {
  return { type: 'SOLID', color: { ...color }, opacity, visible: true };
}

export function createPage(name: string, order: string): PageNode {
  return {
    id: createId(),
    type: 'PAGE',
    name,
    parentId: null,
    order,
    backgroundColor: { ...DEFAULT_PAGE_BACKGROUND },
  };
}

/** A new document with one empty page. */
export function createDocument(name = 'Untitled'): Document {
  const page = createPage('Page 1', freshKeys(1)[0] as string);
  return { id: createId(), name, nodes: { [page.id]: page } };
}

/**
 * Builds a layer with the defaults for its type. `parentId` and `order` must
 * be supplied by the caller, which knows where the layer goes in the tree.
 */
export function createLayer(
  type: LayerType,
  parentId: NodeId,
  order: string,
  props: LayerPatch = {},
): LayerNode {
  const base = {
    id: createId(),
    name: TYPE_LABELS[type],
    parentId,
    order,
    visible: true,
    locked: false,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    opacity: 1,
    fills: [solidPaint(DEFAULT_SHAPE_FILL)],
    strokes: [] as SolidPaint[],
    strokeWeight: 1,
    strokeAlign: 'INSIDE' as const,
  };
  let node: LayerNode;
  switch (type) {
    case 'FRAME':
      node = { ...base, type, fills: [solidPaint(WHITE)], clipsContent: true, cornerRadius: 0 };
      break;
    case 'RECTANGLE':
      node = { ...base, type, cornerRadius: 0 };
      break;
    case 'ELLIPSE':
      node = { ...base, type };
      break;
    case 'LINE':
      node = {
        ...base,
        type,
        height: 0,
        fills: [],
        strokes: [solidPaint(BLACK)],
        strokeAlign: 'CENTER',
      };
      break;
    case 'POLYGON':
      node = { ...base, type, pointCount: 3 };
      break;
    case 'STAR':
      node = { ...base, type, pointCount: 5, innerRadius: 0.382 };
      break;
  }
  return { ...node, ...props } as LayerNode;
}

/** "Rectangle 3": the type label followed by the next unused number in the document. */
export function nextLayerName(doc: Document, type: LayerType): string {
  const label = TYPE_LABELS[type];
  const pattern = new RegExp(`^${label} (\\d+)$`);
  let max = 0;
  for (const id in doc.nodes) {
    const match = pattern.exec((doc.nodes[id] as { name: string }).name);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `${label} ${max + 1}`;
}

export function nextPageName(doc: Document): string {
  let max = 0;
  for (const id in doc.nodes) {
    const node = doc.nodes[id];
    if (node?.type !== 'PAGE') continue;
    const match = /^Page (\d+)$/.exec(node.name);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `Page ${max + 1}`;
}
