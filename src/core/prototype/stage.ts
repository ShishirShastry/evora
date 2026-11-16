import { createLayer, solidPaint } from '../document/factory';
import { isLayer, type DesignNode, type Document, type FrameNode, type LayerNode, type NodeId, type PageNode, type Paint, type PrototypeDevice, type RGB, type Transition } from '../document/schema';
import type { Point } from '../math/geometry';
import { getChildIds, getDescendantIds } from '../scene/tree';

/**
 * What a prototype shows at one moment, as a document: a page (the stage)
 * with the screen on it, the overlays above, and whatever a transition has
 * in between. Because it is an ordinary document, the renderer paints it and
 * the hit test finds what is under the pointer in it, exactly as in the
 * editor, and a test can read where everything is without a canvas.
 */

export interface Size {
  width: number;
  height: number;
}

/** The ID of the page a prototype is staged on. */
export const STAGE_ID = 'prototype-stage';

/** The screens a prototype can be shown on. */
export const DEVICE_SIZES: Record<Exclude<PrototypeDevice, 'NONE'>, Size> = {
  PHONE: { width: 390, height: 844 },
  TABLET: { width: 820, height: 1180 },
  DESKTOP: { width: 1440, height: 900 },
};

// ------------------------------------------------------------------- easing

const CURVES: Record<Exclude<Transition['easing'], 'LINEAR' | 'CUSTOM'>, [number, number, number, number]> = {
  EASE_IN: [0.42, 0, 1, 1],
  EASE_OUT: [0, 0, 0.58, 1],
  EASE_IN_OUT: [0.42, 0, 0.58, 1],
};

/** A cubic Bézier timing curve, as in CSS: how far along (0 to 1) at a fraction of the time. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number, t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const at = (a: number, b: number, u: number): number => 3 * a * u * (1 - u) * (1 - u) + 3 * b * u * u * (1 - u) + u * u * u;
  // The curve gives x for a parameter; find the parameter for this x by halving.
  let low = 0;
  let high = 1;
  for (let i = 0; i < 40; i++) {
    const mid = (low + high) / 2;
    if (at(x1, x2, mid) < t) low = mid;
    else high = mid;
  }
  return at(y1, y2, (low + high) / 2);
}

/** How far along a transition is at a fraction of its time, by its easing. */
export function ease(transition: Pick<Transition, 'easing' | 'bezier'>, t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  if (transition.easing === 'LINEAR') return clamped;
  const curve = transition.easing === 'CUSTOM' ? transition.bezier : CURVES[transition.easing];
  return cubicBezier(curve[0], curve[1], curve[2], curve[3], clamped);
}

/** The way a transition moves, as a step of one along x or y. */
export function directionVector(direction: Transition['direction']): Point {
  return direction === 'LEFT' ? { x: -1, y: 0 } : direction === 'RIGHT' ? { x: 1, y: 0 } : direction === 'TOP' ? { x: 0, y: -1 } : { x: 0, y: 1 };
}

// ------------------------------------------------------------ Smart Animate

const lerp = (a: number, b: number, p: number): number => a + (b - a) * p;
const NUMBERS = ['x', 'y', 'width', 'height', 'rotation', 'opacity', 'strokeWeight', 'cornerRadius', 'fontSize', 'letterSpacing', 'lineHeight'] as const;

function lerpPaints(a: readonly Paint[], b: readonly Paint[], p: number): Paint[] {
  if (a.length !== b.length) return [...b];
  return b.map((to, index) => {
    const from = a[index] as Paint;
    if (from.type !== 'SOLID' || to.type !== 'SOLID') return to;
    return {
      ...to,
      opacity: lerp(from.visible ? from.opacity : 0, to.visible ? to.opacity : 0, p),
      visible: from.visible || to.visible,
      color: { r: lerp(from.color.r, to.color.r, p), g: lerp(from.color.g, to.color.g, p), b: lerp(from.color.b, to.color.b, p) },
    };
  });
}

/** A layer part of the way from what it was to what it becomes. */
function between(a: LayerNode, b: LayerNode, p: number, placed: boolean): LayerNode {
  const out = { ...b } as unknown as Record<string, unknown>;
  const from = a as unknown as Record<string, unknown>;
  const to = b as unknown as Record<string, unknown>;
  for (const key of NUMBERS) {
    // Where the screen itself is and how big is the stage's business.
    if (placed && (key === 'x' || key === 'y' || key === 'width' || key === 'height' || key === 'rotation')) continue;
    if (typeof from[key] === 'number' && typeof to[key] === 'number') out[key] = lerp(from[key] as number, to[key] as number, p);
  }
  // A layer that is hidden on one side fades.
  if (a.visible !== b.visible) {
    out.visible = true;
    out.opacity = lerp(a.visible ? a.opacity : 0, b.visible ? b.opacity : 0, p);
  }
  out.fills = lerpPaints(a.fills, b.fills, p);
  out.strokes = lerpPaints(a.strokes, b.strokes, p);
  return out as unknown as LayerNode;
}

/**
 * Smart Animate: the layers under `toId` part of the way (`p`, 0 to 1) from
 * the layers under `fromId`. A layer is matched to the layer of the same
 * name and type at the same place in the other tree (or of the same ID,
 * when both trees are the same layers at two moments), and is moved, sized,
 * turned and coloured between the two. A layer only the destination has
 * fades in; one only the source had fades out, drawn in the destination
 * where it was. Returns the nodes to lay over the destination document.
 */
export function smartAnimate(fromDoc: Document, fromId: NodeId, toDoc: Document, toId: NodeId, p: number): Record<NodeId, DesignNode> {
  const out: Record<NodeId, DesignNode> = {};
  const pair = (aId: NodeId, bId: NodeId, placed: boolean): void => {
    const a = fromDoc.nodes[aId];
    const b = toDoc.nodes[bId];
    if (!isLayer(a) || !isLayer(b)) return;
    out[bId] = between(a, b, p, placed);
    const before = getChildIds(fromDoc, aId);
    const used = new Set<NodeId>();
    for (const childId of getChildIds(toDoc, bId)) {
      const child = toDoc.nodes[childId];
      if (!isLayer(child)) continue;
      let match: NodeId | undefined = before.includes(childId) && !used.has(childId) && fromDoc.nodes[childId]?.type === child.type ? childId : undefined;
      match ??= before.find((id) => !used.has(id) && fromDoc.nodes[id]?.name === child.name && fromDoc.nodes[id]?.type === child.type);
      if (match === undefined) {
        out[childId] = { ...child, opacity: child.opacity * p };
        continue;
      }
      used.add(match);
      pair(match, childId, false);
    }
    if (p >= 1) return;
    for (const goneId of before) {
      if (used.has(goneId)) continue;
      const gone = fromDoc.nodes[goneId];
      if (!isLayer(gone)) continue;
      const ghost = (id: NodeId): NodeId => `ghost:${id}`;
      out[ghost(goneId)] = { ...gone, id: ghost(goneId), parentId: bId, opacity: gone.opacity * (1 - p) };
      for (const id of getDescendantIds(fromDoc, goneId)) {
        const node = fromDoc.nodes[id];
        if (isLayer(node)) out[ghost(id)] = { ...node, id: ghost(id), parentId: ghost(node.parentId) };
      }
    }
  };
  pair(fromId, toId, true);
  return out;
}

// -------------------------------------------------------------------- stage

/** One thing on the stage: a frame of a document, with everything in it. */
export interface StagePart {
  doc: Document;
  rootId: NodeId;
  /** Where its top-left corner is on the stage, before scrolling. */
  at: Point;
  /** Multiplies its own opacity. */
  opacity: number;
  /** How far each scrolling frame in it (and the frame itself) is scrolled. */
  scroll: Readonly<Record<NodeId, Point>>;
  /** Nodes to use in place of the document's, and to add: what Smart Animate works out. */
  overrides?: Record<NodeId, DesignNode>;
  /** Whether it is the screen, which is moved under the device when it is bigger than it. An overlay is not. */
  screen?: boolean;
  /** A colour laid over the stage under it: what is behind an overlay. */
  dim?: { color: RGB; opacity: number };
}

/**
 * Moves what is in a scrolling frame. `moved` is how far the frame itself has been moved (a screen bigger than the
 * device), `by` how far its content is scrolled inside it. A layer that is fixed stays where it is on the screen;
 * one that is sticky goes with the content until it reaches the top, and stops there.
 */
function scrollChildren(nodes: Record<NodeId, DesignNode>, doc: Document, frameId: NodeId, moved: Point, by: Point): void {
  for (const childId of getChildIds(doc, frameId)) {
    const child = nodes[childId];
    if (!isLayer(child)) continue;
    const behavior = child.scrollBehavior;
    if (behavior === 'FIXED') nodes[childId] = { ...child, x: child.x + moved.x, y: child.y + moved.y };
    else if (behavior === 'STICKY') nodes[childId] = { ...child, x: child.x - by.x, y: Math.max(child.y - by.y, moved.y) };
    else if (by.x !== 0 || by.y !== 0) nodes[childId] = { ...child, x: child.x - by.x, y: child.y - by.y };
  }
}

/**
 * Builds the stage: `base` with a page `STAGE_ID` that holds the parts,
 * bottom first. Each part's frame is taken off its own page and put on the
 * stage, unrotated and visible; nothing else of the document is on it.
 */
export function buildStage(base: Document, parts: readonly StagePart[], viewport: Size, background: RGB): Document {
  const nodes: Record<NodeId, DesignNode> = { ...base.nodes };
  const stage: PageNode = { id: STAGE_ID, type: 'PAGE', name: 'Prototype', parentId: null, order: 'a', backgroundColor: background, guides: [], variableModes: {}, library: null, flows: [], prototypeDevice: 'NONE', exportSettings: [] };
  nodes[STAGE_ID] = stage;
  const key = (index: number, part: string): string => `p${String(index).padStart(4, '0')}${part}`;
  parts.forEach((part, index) => {
    const root = part.overrides?.[part.rootId] ?? part.doc.nodes[part.rootId];
    if (!isLayer(root)) return;
    if (part.doc.nodes !== base.nodes) {
      nodes[part.rootId] = root;
      for (const id of getDescendantIds(part.doc, part.rootId)) nodes[id] = part.doc.nodes[id] as DesignNode;
    }
    if (part.overrides) Object.assign(nodes, part.overrides);
    if (part.dim && part.dim.opacity > 0) {
      const dim = createLayer('RECTANGLE', STAGE_ID, key(index, 'a'), { name: 'Overlay background', x: 0, y: 0, width: viewport.width, height: viewport.height, fills: [solidPaint(part.dim.color, part.dim.opacity)] });
      nodes[`dim:${part.rootId}`] = { ...dim, id: `dim:${part.rootId}` };
    }
    const own = part.scroll[part.rootId] ?? { x: 0, y: 0 };
    const placed = (nodes[part.rootId] ?? root) as LayerNode;
    // A frame bigger than the screen is moved under it; past that, what is in the frame moves inside it.
    const moved = part.screen ? { x: Math.min(own.x, Math.max(0, placed.width - viewport.width)), y: Math.min(own.y, Math.max(0, placed.height - viewport.height)) } : { x: 0, y: 0 };
    nodes[part.rootId] = { ...placed, parentId: STAGE_ID, order: key(index, 'b'), x: part.at.x - moved.x, y: part.at.y - moved.y, rotation: 0, visible: true, locked: false, opacity: placed.opacity * part.opacity };
    if (own.x !== 0 || own.y !== 0) scrollChildren(nodes, part.doc, part.rootId, moved, { x: own.x - moved.x, y: own.y - moved.y });
    for (const frameId in part.scroll) {
      if (frameId === part.rootId) continue;
      const frame = nodes[frameId];
      const by = part.scroll[frameId] as Point;
      if (!isLayer(frame) || frame.type !== 'FRAME' || !getDescendantIds(part.doc, part.rootId).includes(frameId)) continue;
      nodes[frameId] = { ...frame, clipsContent: true };
      scrollChildren(nodes, part.doc, frameId, { x: 0, y: 0 }, by);
    }
  });
  return { ...base, nodes };
}

/** Where an overlay's top-left corner goes on a screen of a size. */
export function overlayOrigin(frame: Pick<FrameNode, 'width' | 'height' | 'overlayPosition'>, viewport: Size): Point {
  const position = frame.overlayPosition;
  const x = position.endsWith('LEFT') ? 0 : position.endsWith('RIGHT') ? viewport.width - frame.width : (viewport.width - frame.width) / 2;
  const y = position.startsWith('TOP') ? 0 : position.startsWith('BOTTOM') ? viewport.height - frame.height : (viewport.height - frame.height) / 2;
  return { x, y };
}
