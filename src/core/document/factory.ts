import { createId } from '../ids';
import { freshKeys } from '../order';
import type {
  Document,
  GradientPaint,
  GradientType,
  ImagePaint,
  LayerNode,
  LayoutGrid,
  LayoutGridPattern,
  LayerPatch,
  LayerType,
  NodeId,
  PageNode,
  Paint,
  RGB,
  ShadowEffect,
  SolidPaint,
} from './schema';

export const DEFAULT_PAGE_BACKGROUND: RGB = { r: 0.118, g: 0.118, b: 0.118 };
export const DEFAULT_SHAPE_FILL: RGB = { r: 0.851, g: 0.851, b: 0.851 };
export const WHITE: RGB = { r: 1, g: 1, b: 1 };
export const BLACK: RGB = { r: 0, g: 0, b: 0 };

export const TYPE_LABELS: Record<LayerType, string> = {
  FRAME: 'Frame',
  GROUP: 'Group',
  RECTANGLE: 'Rectangle',
  ELLIPSE: 'Ellipse',
  LINE: 'Line',
  POLYGON: 'Polygon',
  STAR: 'Star',
  TEXT: 'Text',
  VECTOR: 'Vector',
};

export const DEFAULT_FONT_FAMILY = 'Arial';
export const DEFAULT_FONT_SIZE = 16;

export function solidPaint(color: RGB, opacity = 1): SolidPaint {
  return { type: 'SOLID', color: { ...color }, opacity, visible: true };
}

/** The two handles of a gradient at an angle through the middle of the box. 0° runs left to right, 90° top to bottom. */
export function gradientHandles(angle: number): Pick<GradientPaint, 'from' | 'to'> {
  const r = (angle * Math.PI) / 180;
  const dx = Math.cos(r) / 2;
  const dy = Math.sin(r) / 2;
  const tidy = (v: number): number => Math.round(v * 1e6) / 1e6;
  return { from: { x: tidy(0.5 - dx), y: tidy(0.5 - dy) }, to: { x: tidy(0.5 + dx), y: tidy(0.5 + dy) } };
}

/** The angle of a gradient's handles, in degrees, 0..360. */
export function gradientAngle(paint: Pick<GradientPaint, 'from' | 'to'>): number {
  const angle = (Math.atan2(paint.to.y - paint.from.y, paint.to.x - paint.from.x) * 180) / Math.PI;
  return Math.round(((angle % 360) + 360) % 360 * 100) / 100;
}

/** A two-stop gradient. Linear gradients span the box; the others start at its centre. */
export function gradientPaint(type: GradientType, start: RGB, end: RGB, angle = type === 'GRADIENT_LINEAR' ? 90 : 0): GradientPaint {
  const handles =
    type === 'GRADIENT_LINEAR'
      ? gradientHandles(angle)
      : { from: { x: 0.5, y: 0.5 }, to: { x: 0.5 + Math.cos((angle * Math.PI) / 180) / 2, y: 0.5 + Math.sin((angle * Math.PI) / 180) / 2 } };
  return {
    type,
    stops: [
      { position: 0, color: { ...start }, opacity: 1 },
      { position: 1, color: { ...end }, opacity: 1 },
    ],
    ...handles,
    opacity: 1,
    visible: true,
  };
}

/** One colour that stands for a paint, for swatches and text carets: the solid colour or the first stop. */
export function paintColor(paint: Paint): RGB {
  if (paint.type === 'SOLID') return paint.color;
  if (paint.type === 'IMAGE') return DEFAULT_SHAPE_FILL;
  return paint.stops[0]?.color ?? BLACK;
}

/** An image fill that covers the layer and shows the whole image when cropping is switched on. */
export function imagePaint(imageHash: string): ImagePaint {
  return { type: 'IMAGE', imageHash, scaleMode: 'FILL', crop: { x: 0, y: 0, width: 1, height: 1 }, tileScale: 1, opacity: 1, visible: true };
}

/** A new layout grid of the given kind, in the customary translucent red. */
export function layoutGrid(pattern: LayoutGridPattern = 'GRID'): LayoutGrid {
  return {
    pattern,
    size: 10,
    count: pattern === 'ROWS' ? 4 : 5,
    gutter: 20,
    offset: 0,
    alignment: 'STRETCH',
    sectionSize: 100,
    color: { r: 1, g: 0, b: 0 },
    opacity: 0.1,
    visible: true,
  };
}

export function dropShadow(): ShadowEffect {
  return { type: 'DROP_SHADOW', color: { ...BLACK }, opacity: 0.25, offsetX: 0, offsetY: 4, blur: 8, spread: 0, visible: true };
}

export function createPage(name: string, order: string): PageNode {
  return {
    id: createId(),
    type: 'PAGE',
    name,
    parentId: null,
    order,
    backgroundColor: { ...DEFAULT_PAGE_BACKGROUND },
    guides: [],
  };
}

/** A new document with one empty page. */
export function createDocument(name = 'Untitled'): Document {
  const page = createPage('Page 1', freshKeys(1)[0] as string);
  return { id: createId(), name, nodes: { [page.id]: page }, assets: {} };
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
    strokeCap: 'NONE' as const,
    strokeJoin: 'MITER' as const,
    dashPattern: [] as number[],
    effects: [] as LayerNode['effects'],
    blendMode: 'NORMAL' as const,
    constraints: { horizontal: 'MIN' as const, vertical: 'MIN' as const },
    isMask: false,
  };
  let node: LayerNode;
  switch (type) {
    case 'FRAME':
      node = { ...base, type, fills: [solidPaint(WHITE)], clipsContent: true, cornerRadius: 0, cornerRadii: null, layoutGrids: [] };
      break;
    case 'GROUP':
      node = { ...base, type, fills: [] };
      break;
    case 'RECTANGLE':
      node = { ...base, type, cornerRadius: 0, cornerRadii: null };
      break;
    case 'ELLIPSE':
      node = { ...base, type, arcStart: 0, arcSweep: 360, arcRatio: 0 };
      break;
    case 'LINE':
      node = {
        ...base,
        type,
        height: 0,
        fills: [],
        strokes: [solidPaint(BLACK)],
        strokeAlign: 'CENTER',
        startArrow: 'NONE',
        endArrow: 'NONE',
      };
      break;
    case 'POLYGON':
      node = { ...base, type, pointCount: 3 };
      break;
    case 'STAR':
      node = { ...base, type, pointCount: 5, innerRadius: 0.382 };
      break;
    case 'TEXT':
      node = {
        ...base,
        type,
        width: 1,
        height: Math.round(DEFAULT_FONT_SIZE * 1.2),
        fills: [solidPaint(BLACK)],
        characters: '',
        fontFamily: DEFAULT_FONT_FAMILY,
        fontSize: DEFAULT_FONT_SIZE,
        fontWeight: 400,
        italic: false,
        lineHeight: null,
        letterSpacing: 0,
        textAlign: 'LEFT',
        verticalAlign: 'TOP',
        textAutoResize: 'WIDTH_AND_HEIGHT',
        textDecoration: 'NONE',
        textCase: 'ORIGINAL',
      };
      break;
    case 'VECTOR':
      // A new path is an outline: a hairline stroke and no fill.
      node = {
        ...base,
        type,
        width: 0,
        height: 0,
        fills: [],
        strokes: [solidPaint(BLACK)],
        strokeAlign: 'CENTER',
        network: { vertices: [], segments: [] },
        windingRule: 'NONZERO',
        startArrow: 'NONE',
        endArrow: 'NONE',
      };
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
