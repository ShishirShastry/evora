/**
 * Widgets (schema 26): a widget is a frame whose layers its plugin draws
 * from the widget's state. The plugin's `render(state)` returns a tree of
 * simple nodes (frames with Auto Layout, rectangles, ellipses and text, with
 * fills, sizes, corner radii, padding and spacing) and names the click
 * handlers on them; here that tree becomes real child layers of the widget
 * frame, so a widget is painted, exported and synchronised like any layers.
 * A click on one of its layers runs the handler in the plugin's sandbox,
 * which returns the next state; the state and the layers drawn from it are
 * then written as one change.
 */
import {
  addLayer,
  createLayer,
  getAncestorIds,
  getChildIds,
  getDescendantIds,
  hitTestDeepest,
  isFrame,
  jsonValue,
  setNodes,
  solidPaint,
  widgetFrameOf,
  type DesignNode,
  type Document,
  type FrameNode,
  type JsonValue,
  type LayerNode,
  type LayerType,
  type NodeId,
  type Paint,
  type Point,
  type RGB,
  type WidgetData,
} from '../core';
import { freshKeys } from '../core/order';

export class WidgetRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WidgetRenderError';
  }
}

export type WidgetNodeType = 'frame' | 'rectangle' | 'ellipse' | 'text';
export type WidgetSize = number | 'hug' | 'fill';

/** One node of what a widget's render returns. */
export interface WidgetNode {
  type: WidgetNodeType;
  name?: string;
  width?: WidgetSize;
  height?: WidgetSize;
  /** "#rgb", "#rrggbb" or "#rrggbbaa"; none when left out (grey for shapes, black for text). */
  fill?: string | null;
  stroke?: string | null;
  strokeWidth?: number;
  cornerRadius?: number;
  opacity?: number;
  /** Frames: the direction of their Auto Layout ("horizontal" unless told otherwise), or "none". */
  direction?: 'horizontal' | 'vertical' | 'none';
  padding?: number | { top?: number; right?: number; bottom?: number; left?: number; vertical?: number; horizontal?: number };
  spacing?: number;
  /** Frames: where the children go across the layout. */
  align?: 'start' | 'center' | 'end';
  /** Frames: where the children go along the layout. */
  justify?: 'start' | 'center' | 'end' | 'space-between';
  /** Frames with "none" for direction: where a child is. */
  x?: number;
  y?: number;
  children?: WidgetNode[];
  /** Text: what it says. */
  text?: string;
  fontSize?: number;
  fontWeight?: number;
  textAlign?: 'left' | 'center' | 'right';
  /** The name of the click handler (in the widget's `handlers`) to run when this node is clicked. */
  onClick?: string;
}

export const MAX_WIDGET_NODES = 500;
const MAX_DEPTH = 16;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A colour from "#rgb", "#rrggbb" or "#rrggbbaa", as a solid paint. */
export function hexPaint(value: unknown, what: string): Paint {
  if (typeof value !== 'string') throw new WidgetRenderError(`${what} must be a colour written as "#rrggbb".`);
  let hex = value.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(hex)) hex = [...hex].map((c) => c + c).join('');
  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(hex)) throw new WidgetRenderError(`"${value}" is not a colour: write it as "#rrggbb" or "#rrggbbaa".`);
  const byte = (i: number) => parseInt(hex.slice(i, i + 2), 16) / 255;
  const color: RGB = { r: byte(0), g: byte(2), b: byte(4) };
  return solidPaint(color, hex.length === 8 ? Math.round(byte(6) * 1000) / 1000 : 1);
}

function num(value: unknown, what: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new WidgetRenderError(`${what} must be a number.`);
  return Math.min(max, Math.max(min, value));
}

/** Checks what a widget's render returned: the shape of every node, and that there are not too many. */
export function checkWidgetTree(raw: unknown): WidgetNode {
  let count = 0;
  const visit = (value: unknown, depth: number, where: string): WidgetNode => {
    if (++count > MAX_WIDGET_NODES) throw new WidgetRenderError(`A widget can draw at most ${MAX_WIDGET_NODES} layers.`);
    if (depth > MAX_DEPTH) throw new WidgetRenderError(`A widget's layers can be at most ${MAX_DEPTH} deep.`);
    if (!isObject(value)) throw new WidgetRenderError(`${where} is not a node: each node is an object with a "type".`);
    const type = value.type;
    if (type !== 'frame' && type !== 'rectangle' && type !== 'ellipse' && type !== 'text') {
      throw new WidgetRenderError(`${where} has the type "${String(type)}"; a widget's nodes are frame, rectangle, ellipse and text.`);
    }
    for (const key of ['fill', 'stroke']) if (value[key] !== undefined && value[key] !== null) hexPaint(value[key], `${where}'s ${key}`);
    for (const key of ['width', 'height']) {
      const size = value[key];
      if (size !== undefined && size !== 'hug' && size !== 'fill' && (typeof size !== 'number' || !Number.isFinite(size) || size < 0)) {
        throw new WidgetRenderError(`${where}'s ${key} must be a number of pixels, "hug" or "fill".`);
      }
    }
    for (const key of ['strokeWidth', 'cornerRadius', 'opacity', 'spacing', 'x', 'y', 'fontSize', 'fontWeight']) num(value[key], `${where}'s ${key}`, -1e6, 1e6);
    if (value.onClick !== undefined && (typeof value.onClick !== 'string' || !value.onClick)) throw new WidgetRenderError(`${where}'s onClick must be the name of a handler.`);
    if (type === 'text' && value.text !== undefined && typeof value.text !== 'string') throw new WidgetRenderError(`${where}'s text must be text.`);
    const children = value.children;
    if (children !== undefined && type !== 'frame') throw new WidgetRenderError(`${where} is a ${type}; only frames have children.`);
    if (children !== undefined && !Array.isArray(children)) throw new WidgetRenderError(`${where}'s children must be a list.`);
    const copy = jsonValue(value);
    if (copy === undefined) throw new WidgetRenderError(`${where} must be plain data.`);
    const node = copy as unknown as WidgetNode;
    if (Array.isArray(children)) node.children = children.map((child, i) => visit(child, depth + 1, `${where}.children[${i}]`));
    return node;
  };
  const root = visit(raw, 0, 'The widget');
  if (root.type !== 'frame') throw new WidgetRenderError('What a widget renders must be a frame at the top.');
  return root;
}

/** The properties of a layer from a widget node: those every type has, then each type's own. */
function propsOf(node: WidgetNode, inLayout: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = { name: node.name ?? (node.type === 'text' ? (node.text ?? '').slice(0, 40) || 'Text' : node.type[0]!.toUpperCase() + node.type.slice(1)) };
  const shape = node.type !== 'text';
  out.fills = node.fill === null ? [] : node.fill !== undefined ? [hexPaint(node.fill, 'fill')] : node.type === 'frame' ? [] : node.type === 'text' ? [solidPaint({ r: 0, g: 0, b: 0 })] : [solidPaint({ r: 0.85, g: 0.85, b: 0.85 })];
  out.strokes = node.stroke ? [hexPaint(node.stroke, 'stroke')] : [];
  if (node.strokeWidth !== undefined) out.strokeWeight = Math.max(0, node.strokeWidth);
  if (node.opacity !== undefined) out.opacity = Math.min(1, Math.max(0, node.opacity));
  if ((node.type === 'frame' || node.type === 'rectangle') && node.cornerRadius !== undefined) out.cornerRadius = Math.max(0, node.cornerRadius);
  if (node.x !== undefined) out.x = node.x;
  if (node.y !== undefined) out.y = node.y;
  const sizing = (size: WidgetSize | undefined, fallback: 'HUG' | 'FIXED'): 'HUG' | 'FIXED' | 'FILL' => (size === 'fill' ? (inLayout ? 'FILL' : 'FIXED') : size === 'hug' ? 'HUG' : typeof size === 'number' ? 'FIXED' : fallback);
  const auto = node.type === 'frame' && node.direction !== 'none';
  if (node.type === 'frame') {
    out.clipsContent = false;
    out.layoutMode = node.direction === 'none' ? 'NONE' : node.direction === 'vertical' ? 'VERTICAL' : 'HORIZONTAL';
    out.itemSpacing = node.spacing ?? 0;
    const p = node.padding;
    const pad = typeof p === 'number' ? { top: p, right: p, bottom: p, left: p } : isObject(p) ? { top: p.top ?? p.vertical ?? 0, right: p.right ?? p.horizontal ?? 0, bottom: p.bottom ?? p.vertical ?? 0, left: p.left ?? p.horizontal ?? 0 } : { top: 0, right: 0, bottom: 0, left: 0 };
    out.paddingTop = Math.max(0, pad.top);
    out.paddingRight = Math.max(0, pad.right);
    out.paddingBottom = Math.max(0, pad.bottom);
    out.paddingLeft = Math.max(0, pad.left);
    out.counterAxisAlignItems = node.align === 'center' ? 'CENTER' : node.align === 'end' ? 'MAX' : 'MIN';
    out.primaryAxisAlignItems = node.justify === 'center' ? 'CENTER' : node.justify === 'end' ? 'MAX' : node.justify === 'space-between' ? 'SPACE_BETWEEN' : 'MIN';
  }
  if (node.type === 'text') {
    out.characters = node.text ?? '';
    out.fontSize = node.fontSize === undefined ? 14 : Math.max(1, Math.min(1000, node.fontSize));
    out.fontWeight = node.fontWeight === undefined ? 400 : Math.round(Math.max(100, Math.min(900, node.fontWeight)) / 100) * 100;
    out.textAlign = node.textAlign === 'center' ? 'CENTER' : node.textAlign === 'right' ? 'RIGHT' : 'LEFT';
    // A text with a width wraps at it; without one it is as wide as what it says.
    out.textAutoResize = typeof node.width === 'number' || node.width === 'fill' ? 'HEIGHT' : 'WIDTH_AND_HEIGHT';
  }
  const fallback = auto || node.type === 'text' ? 'HUG' : 'FIXED';
  out.layoutSizingHorizontal = sizing(node.width, fallback);
  out.layoutSizingVertical = sizing(node.height, fallback);
  if (node.type === 'text' && out.layoutSizingHorizontal === 'HUG') out.layoutSizingHorizontal = 'HUG';
  const size = (value: WidgetSize | undefined, other: number): number => (typeof value === 'number' ? value : other);
  const defaultSize = shape && !auto ? (node.type === 'frame' ? 100 : 24) : 1;
  out.width = size(node.width, defaultSize);
  out.height = size(node.height, node.type === 'text' ? Math.round((out.fontSize as number) * 1.2) : defaultSize);
  if (shape && !auto && out.layoutSizingHorizontal === 'HUG') out.layoutSizingHorizontal = 'FIXED';
  if (shape && !auto && out.layoutSizingVertical === 'HUG') out.layoutSizingVertical = 'FIXED';
  return out;
}

const LAYER_TYPES: Record<WidgetNodeType, LayerType> = { frame: 'FRAME', rectangle: 'RECTANGLE', ellipse: 'ELLIPSE', text: 'TEXT' };

/** The ID of a layer a widget draws: the widget frame's ID and the layer's path in it, so that drawing the same thing again changes nothing. */
export function widgetLayerId(frameId: NodeId, path: string): NodeId {
  return `${frameId}~${path}`;
}

/**
 * Draws a widget: its frame takes the root's settings, its children are
 * replaced by layers made from the tree, and its data takes the state and the
 * handlers. The document is not laid out here: the editor store does that
 * when the change is applied.
 */
export function drawWidget(doc: Document, frameId: NodeId, rawTree: unknown, state: JsonValue, widget: Pick<WidgetData, 'pluginId' | 'widgetId'>, version?: number): Document {
  const frame = doc.nodes[frameId];
  if (!isFrame(frame)) throw new WidgetRenderError('The widget no longer exists.');
  const tree = checkWidgetTree(rawTree);
  const handlers: Record<string, string> = {};
  const changes: Record<NodeId, DesignNode | null> = {};
  for (const id of getDescendantIds(doc, frameId)) changes[id] = null;

  const rootProps = propsOf(tree, frame.parentId !== null && isFrame(doc.nodes[frame.parentId]) && (doc.nodes[frame.parentId] as FrameNode).layoutMode !== 'NONE');
  delete rootProps.name;
  delete rootProps.x;
  delete rootProps.y;
  if (tree.onClick) handlers[''] = tree.onClick;
  const nextVersion = version ?? (frame.widget ? frame.widget.version + 1 : 0);
  changes[frameId] = { ...frame, ...rootProps, widget: { pluginId: widget.pluginId, widgetId: widget.widgetId, state, version: nextVersion, handlers } } as FrameNode;

  const build = (children: readonly WidgetNode[], parentId: NodeId, parentPath: string, inLayout: boolean): void => {
    const keys = freshKeys(children.length);
    children.forEach((child, index) => {
      const path = parentPath === '' ? String(index) : `${parentPath}.${index}`;
      const layer = createLayer(LAYER_TYPES[child.type], parentId, keys[index] as string, propsOf(child, inLayout) as Parameters<typeof createLayer>[3]);
      const id = widgetLayerId(frameId, path);
      changes[id] = { ...layer, id } as LayerNode;
      if (child.onClick) handlers[path] = child.onClick;
      if (child.children) build(child.children, id, path, child.direction !== 'none');
    });
  };
  build(tree.children ?? [], frameId, '', tree.direction !== 'none');
  // Unchanged layers are kept as they were, so that drawing the same thing again is no change at all.
  for (const id in changes) {
    const next = changes[id];
    const prev = doc.nodes[id];
    if (next && prev && JSON.stringify(next) === JSON.stringify(prev)) changes[id] = prev;
  }
  return setNodes(doc, changes);
}

/** Puts a new widget on a page (or in a frame) at a point, drawn from its first state. Returns the widget frame's ID. */
export function insertWidget(
  doc: Document,
  parentId: NodeId,
  at: Point,
  widget: { pluginId: string; widgetId: string; name: string },
  state: JsonValue,
  tree: unknown,
): { doc: Document; id: NodeId } {
  const added = addLayer(doc, 'FRAME', parentId, {
    name: widget.name,
    x: Math.round(at.x),
    y: Math.round(at.y),
    fills: [],
    clipsContent: false,
    widget: { pluginId: widget.pluginId, widgetId: widget.widgetId, state, version: 0, handlers: {} },
  });
  return { doc: drawWidget(added.doc, added.id, tree, state, widget, 0), id: added.id };
}

/** The path of a layer inside a widget frame: its index among its siblings at each level ("" for the frame itself). */
export function pathInWidget(doc: Document, frameId: NodeId, id: NodeId): string | null {
  if (id === frameId) return '';
  const chain = [id, ...getAncestorIds(doc, id)];
  const at = chain.indexOf(frameId);
  if (at < 0) return null;
  const parts: number[] = [];
  for (let i = at - 1; i >= 0; i--) {
    const child = chain[i] as NodeId;
    const parent = chain[i + 1] as NodeId;
    parts.push(getChildIds(doc, parent).indexOf(child));
  }
  return parts.join('.');
}

export interface WidgetClick {
  frameId: NodeId;
  widget: WidgetData;
  handler: string;
  /** The path of the layer that has the handler. */
  path: string;
}

/**
 * The click handler a click at a point on the page runs: the one on the
 * layer under the pointer, or on the nearest layer around it that has one,
 * up to the widget frame. Null when the click is not on a widget, or not on
 * anything of it with a handler.
 */
export function widgetClickAt(doc: Document, pageId: NodeId, point: Point, tolerance = 0): WidgetClick | null {
  const hit = hitTestDeepest(doc, pageId, point, tolerance);
  if (!hit) return null;
  const frameId = widgetFrameOf(doc, hit);
  const frame = frameId ? doc.nodes[frameId] : undefined;
  if (!frameId || !isFrame(frame) || !frame.widget) return null;
  const path = pathInWidget(doc, frameId, hit);
  if (path === null) return null;
  const parts = path === '' ? [] : path.split('.');
  for (let n = parts.length; n >= 0; n--) {
    const at = parts.slice(0, n).join('.');
    const handler = frame.widget.handlers[at];
    if (handler) return { frameId, widget: frame.widget, handler, path: at };
  }
  return null;
}

/** Every widget in a document, by the plugin that draws it. */
export function widgetsOf(doc: Document, pluginId?: string): FrameNode[] {
  const out: FrameNode[] = [];
  for (const id in doc.nodes) {
    const node = doc.nodes[id];
    if (isFrame(node) && node.widget && (pluginId === undefined || node.widget.pluginId === pluginId)) out.push(node);
  }
  return out;
}
