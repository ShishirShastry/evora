import { createLayer, nextLayerName } from '../document/factory';
import { patchNodes, setNodes } from '../document/mutate';
import {
  isFrame,
  isLayer,
  type CounterAxisAlign,
  type Document,
  type FrameNode,
  type LayerNode,
  type LayerPatch,
  type LayoutMode,
  type LayoutSizing,
  type NodeId,
} from '../document/schema';
import { transformedBounds, unionRects, type Point, type Rect } from '../math/geometry';
import { applyToPoint, invert, multiply } from '../math/matrix';
import { belongsToFlow, canHug, flowChildren, isAutoLayout, isInFlow } from '../layout/autoLayout';
import { freshKeys } from '../order';
import { getChildIds, getLocalMatrix, getWorldMatrix, sortByPaintOrder, topLevelIds } from '../scene/tree';
import { reparentNodes } from './arrange';
import { insertionKeys } from './ordering';
import { clean } from './transform';

/**
 * What the user does with Auto Layout: switching it on for a frame or round
 * a selection, switching it off, choosing how a layer is sized, and putting a
 * layer at a place in a frame's flow. Each returns a new document; the layout
 * itself is then worked out by `applyAutoLayout`, which the editor runs after
 * every change.
 */

const DEFAULT_SPACING = 10;

type Axis = 'horizontal' | 'vertical';

/** The arrangement a set of boxes is already in: side by side or one under another, how far apart, and how lined up. */
interface Arrangement {
  mode: Exclude<LayoutMode, 'NONE'>;
  spacing: number;
  align: CounterAxisAlign;
  /** The positions of the boxes in the order they come in along the direction. */
  order: number[];
}

/** Reads the direction, spacing and alignment off boxes as they are now, so that switching Auto Layout on moves as little as possible. */
function readArrangement(rects: readonly Rect[]): Arrangement {
  const centreX = rects.map((rect) => rect.x + rect.width / 2);
  const centreY = rects.map((rect) => rect.y + rect.height / 2);
  const spread = (values: number[]): number => (values.length > 0 ? Math.max(...values) - Math.min(...values) : 0);
  const mode = rects.length > 1 && spread(centreY) > spread(centreX) ? 'VERTICAL' : 'HORIZONTAL';
  const along = mode === 'HORIZONTAL';
  const start = (rect: Rect): number => (along ? rect.x : rect.y);
  const size = (rect: Rect): number => (along ? rect.width : rect.height);
  const crossStart = (rect: Rect): number => (along ? rect.y : rect.x);
  const crossSize = (rect: Rect): number => (along ? rect.height : rect.width);

  const order = rects.map((_, index) => index).sort((a, b) => {
    const ra = rects[a] as Rect;
    const rb = rects[b] as Rect;
    return start(ra) + size(ra) / 2 - (start(rb) + size(rb) / 2) || crossStart(ra) - crossStart(rb) || a - b;
  });

  let spacing = DEFAULT_SPACING;
  if (order.length > 1) {
    let total = 0;
    for (let i = 1; i < order.length; i++) {
      const before = rects[order[i - 1] as number] as Rect;
      const after = rects[order[i] as number] as Rect;
      total += start(after) - (start(before) + size(before));
    }
    spacing = Math.max(0, Math.round(total / (order.length - 1)));
  }

  const same = (values: number[]): boolean => values.every((value) => Math.abs(value - (values[0] as number)) < 0.5);
  let align: CounterAxisAlign = 'MIN';
  if (!same(rects.map(crossStart))) {
    if (same(rects.map((rect) => crossStart(rect) + crossSize(rect) / 2))) align = 'CENTER';
    else if (same(rects.map((rect) => crossStart(rect) + crossSize(rect)))) align = 'MAX';
  }
  return { mode, spacing, align, order };
}

/** Bounds of a layer's box in the space of `ancestorId` (null for the page). */
function boundsIn(doc: Document, id: NodeId, ancestorId: NodeId): Rect {
  const node = doc.nodes[id] as LayerNode;
  const matrix = multiply(invert(getWorldMatrix(doc, ancestorId)), getWorldMatrix(doc, id));
  return transformedBounds(matrix, node.width, node.height);
}

/** Gives the children of a container the stacking order `ids` (bottom first), with fresh order keys. */
function stackAs(doc: Document, ids: readonly NodeId[]): Document {
  const keys = freshKeys(ids.length);
  const patches: Record<NodeId, LayerPatch> = {};
  ids.forEach((id, index) => {
    patches[id] = { order: keys[index] as string };
  });
  return patchNodes(doc, patches);
}

/**
 * Switches Auto Layout on for a frame, reading its direction, spacing,
 * padding and alignment off where its children are now. The children are
 * put in the stacking order they come in along the direction, since that is
 * the order a frame lays them out in. The frame then hugs them.
 */
function convertFrame(doc: Document, frame: FrameNode): Document {
  const all = getChildIds(doc, frame.id);
  const placed = all.filter((id) => {
    const child = doc.nodes[id];
    return isLayer(child) && child.visible;
  });
  if (placed.length === 0) {
    // Nothing to hug: the frame keeps its size.
    return patchNodes(doc, { [frame.id]: { layoutMode: 'HORIZONTAL', itemSpacing: DEFAULT_SPACING } });
  }
  const rects = placed.map((id) => {
    const child = doc.nodes[id] as LayerNode;
    return transformedBounds(getLocalMatrix(child), child.width, child.height);
  });
  const found = readArrangement(rects);
  const bounds = unionRects(rects) as Rect;
  const pad = (value: number): number => Math.max(0, Math.round(value));
  // Hidden children stay at the bottom of the stack, in the order they were in.
  const hidden = all.filter((id) => !placed.includes(id));
  const next = stackAs(doc, [...hidden, ...found.order.map((index) => placed[index] as NodeId)]);
  return patchNodes(next, {
    [frame.id]: {
      layoutMode: found.mode,
      itemSpacing: found.spacing,
      counterAxisAlignItems: found.align,
      paddingLeft: pad(bounds.x),
      paddingTop: pad(bounds.y),
      paddingRight: pad(frame.width - (bounds.x + bounds.width)),
      paddingBottom: pad(frame.height - (bounds.y + bounds.height)),
      layoutSizingHorizontal: 'HUG',
      layoutSizingVertical: 'HUG',
    },
  });
}

/**
 * Puts layers into a new frame that lays them out as they are arranged now.
 * The frame takes the place of the top-most of them in that layer's parent,
 * has no fill of its own and hugs what is in it.
 */
function wrapInFrame(doc: Document, ids: readonly NodeId[]): { doc: Document; id: NodeId } | null {
  const members = sortByPaintOrder(doc, topLevelIds(doc, ids)).filter((id) => isLayer(doc.nodes[id]));
  const top = doc.nodes[members[members.length - 1] as NodeId];
  if (!isLayer(top)) return null;
  const parentId = top.parentId;
  const rects = members.map((id) => boundsIn(doc, id, parentId));
  const bounds = unionRects(rects);
  if (!bounds) return null;
  const found = readArrangement(rects);

  const exclude = new Set(members);
  const below = getChildIds(doc, parentId).slice(0, getChildIds(doc, parentId).indexOf(top.id));
  const index = below.filter((id) => !exclude.has(id)).length;
  const { keys, rekeyed } = insertionKeys(doc, parentId, index, 1, exclude);
  const frame = createLayer('FRAME', parentId, keys[0] as string, {
    name: nextLayerName(doc, 'FRAME'),
    x: clean(bounds.x),
    y: clean(bounds.y),
    width: clean(bounds.width),
    height: clean(bounds.height),
    fills: [],
    clipsContent: false,
    layoutMode: found.mode,
    itemSpacing: found.spacing,
    counterAxisAlignItems: found.align,
    layoutSizingHorizontal: 'HUG',
    layoutSizingVertical: 'HUG',
  });
  let next = setNodes(patchNodes(doc, rekeyed), { [frame.id]: frame });
  next = reparentNodes(next, members, frame.id);
  next = stackAs(next, found.order.map((position) => members[position] as NodeId));
  return { doc: next, id: frame.id };
}

/**
 * "Add Auto Layout". A single frame that has none gets it; anything else
 * that is selected is put into a new Auto Layout frame. Returns the frame
 * that now lays its children out, or null when nothing could be done.
 */
export function addAutoLayout(doc: Document, ids: readonly NodeId[]): { doc: Document; id: NodeId } | null {
  const selected = topLevelIds(doc, ids).filter((id) => isLayer(doc.nodes[id]));
  if (selected.length === 0) return null;
  const only = selected.length === 1 ? doc.nodes[selected[0] as NodeId] : undefined;
  if (isFrame(only) && only.layoutMode === 'NONE') return { doc: convertFrame(doc, only), id: only.id };
  return wrapInFrame(doc, selected);
}

/** The two ways a layout can run: in a row or in a column. */
export type LayoutDirection = Exclude<LayoutMode, 'NONE'>;

/**
 * What goes with a layout that wraps along a direction: it can only run out
 * of room at a size of its own, so a frame that hugs along that direction
 * keeps the size it has.
 */
function sizeToWrapAt(frame: FrameNode, direction: LayoutDirection): LayerPatch {
  const key = direction === 'HORIZONTAL' ? 'layoutSizingHorizontal' : 'layoutSizingVertical';
  return frame[key] === 'HUG' ? { [key]: 'FIXED' } : {};
}

/**
 * Sets which way the layouts of frames run: in a row or in a column.
 * Whether they wrap is left as it is.
 */
export function setLayoutDirection(doc: Document, ids: readonly NodeId[], direction: LayoutDirection): Document {
  const patches: Record<NodeId, LayerPatch> = {};
  for (const id of ids) {
    const frame = doc.nodes[id];
    if (!isAutoLayout(frame)) continue;
    patches[id] = { layoutMode: direction, ...(frame.layoutWrap === 'WRAP' ? sizeToWrapAt(frame, direction) : {}) };
  }
  return patchNodes(doc, patches);
}

/**
 * Switches wrapping on or off for the layouts of frames. A row that wraps
 * carries on in a further row beneath it when it runs out of width; a column
 * in a further column beside it when it runs out of height.
 */
export function setLayoutWrap(doc: Document, ids: readonly NodeId[], wrap: boolean): Document {
  const patches: Record<NodeId, LayerPatch> = {};
  for (const id of ids) {
    const frame = doc.nodes[id];
    if (!isAutoLayout(frame)) continue;
    patches[id] = wrap ? { layoutWrap: 'WRAP', ...sizeToWrapAt(frame, frame.layoutMode as LayoutDirection) } : { layoutWrap: 'NO_WRAP' };
  }
  return patchNodes(doc, patches);
}

/** A spacing of a layout: a fixed gap, or AUTO, where the gaps are whatever is left over when the items are spread from end to end. */
export type LayoutSpacing = number | 'AUTO';

/**
 * The spacing between a frame's items. Automatic spacing and the alignment
 * "space between" are one and the same setting of the frame, seen from the
 * gap and from the alignment: the first item at the start, the last at the
 * end, equal gaps between.
 */
export function itemSpacingOf(frame: FrameNode): LayoutSpacing {
  return frame.primaryAxisAlignItems === 'SPACE_BETWEEN' ? 'AUTO' : frame.itemSpacing;
}

/** The spacing between the lines of a frame that wraps: a fixed gap, or AUTO when the lines are spread out. */
export function lineSpacingOf(frame: FrameNode): LayoutSpacing {
  return frame.counterAxisAlignContent === 'SPACE_BETWEEN' ? 'AUTO' : frame.counterAxisSpacing;
}

/**
 * Sets the spacing between the items of frames with a layout. AUTO spreads
 * the items from end to end (the alignment along the layout becomes "space
 * between"); a number is a fixed gap, and takes the frame out of automatic
 * spacing if it was in it, packing the items at the start.
 */
export function setItemSpacing(doc: Document, ids: readonly NodeId[], spacing: LayoutSpacing): Document {
  const patches: Record<NodeId, LayerPatch> = {};
  for (const id of ids) {
    const frame = doc.nodes[id];
    if (!isAutoLayout(frame)) continue;
    if (spacing === 'AUTO') patches[id] = { primaryAxisAlignItems: 'SPACE_BETWEEN' };
    else patches[id] = { itemSpacing: spacing, ...(frame.primaryAxisAlignItems === 'SPACE_BETWEEN' ? { primaryAxisAlignItems: 'MIN' as const } : {}) };
  }
  return patchNodes(doc, patches);
}

/** Sets the spacing between the lines of frames that wrap: AUTO spreads the lines out, a number packs them with that gap. */
export function setLineSpacing(doc: Document, ids: readonly NodeId[], spacing: LayoutSpacing): Document {
  const patches: Record<NodeId, LayerPatch> = {};
  for (const id of ids) {
    if (!isAutoLayout(doc.nodes[id])) continue;
    patches[id] = spacing === 'AUTO' ? { counterAxisAlignContent: 'SPACE_BETWEEN' } : { counterAxisSpacing: spacing, counterAxisAlignContent: 'AUTO' };
  }
  return patchNodes(doc, patches);
}

/** Switches Auto Layout off. The children stay where the layout last put them, at the sizes it gave them. */
export function removeAutoLayout(doc: Document, ids: readonly NodeId[]): Document {
  const patches: Record<NodeId, LayerPatch> = {};
  for (const id of ids) if (isAutoLayout(doc.nodes[id])) patches[id] = { layoutMode: 'NONE' };
  return patchNodes(doc, patches);
}

/** Whether a layer can be stretched along an axis: a line has no height to give, and a rotated layer is placed as it is. */
function canStretch(node: LayerNode, axis: Axis): boolean {
  if (node.rotation !== 0) return false;
  if (node.type === 'LINE') return axis === 'horizontal';
  if (node.type === 'VECTOR') return axis === 'horizontal' ? node.width > 0 : node.height > 0;
  return true;
}

/** The ways a layer can be sized along an axis where it is: always fixed, "hug" for layout frames and text, "fill" inside a layout frame. */
export function sizingChoices(doc: Document, id: NodeId, axis: Axis): LayoutSizing[] {
  const node = doc.nodes[id];
  if (!isLayer(node)) return [];
  const choices: LayoutSizing[] = ['FIXED'];
  // A frame that stretches its children across its layout has nothing to hug that way.
  if (node.type === 'TEXT' || (isAutoLayout(node) && canHug(node, axis === 'horizontal' ? 'x' : 'y'))) choices.push('HUG');
  if (belongsToFlow(doc, node) && canStretch(node, axis)) choices.push('FILL');
  return choices;
}

/**
 * Chooses how layers are sized along an axis. What goes with the choice is
 * done too: a text's own sizing mode is set to match, since that is what
 * decides whether it hugs; and a frame that hugged its children along that
 * axis keeps the size it has when one of them is told to fill it, because it
 * cannot be both as big as its children and filled by them.
 */
export function setLayoutSizing(doc: Document, ids: readonly NodeId[], axis: Axis, sizing: LayoutSizing): Document {
  const key = axis === 'horizontal' ? 'layoutSizingHorizontal' : 'layoutSizingVertical';
  const patches: Record<NodeId, LayerPatch> = {};
  for (const id of ids) {
    const node = doc.nodes[id];
    if (!isLayer(node) || !sizingChoices(doc, id, axis).includes(sizing)) continue;
    const patch: LayerPatch = { [key]: sizing };
    if (node.type === 'TEXT') {
      if (axis === 'horizontal') {
        if (sizing === 'HUG') patch.textAutoResize = 'WIDTH_AND_HEIGHT';
        else if (node.textAutoResize === 'WIDTH_AND_HEIGHT') patch.textAutoResize = 'HEIGHT';
      } else if (sizing === 'HUG') {
        if (node.textAutoResize === 'NONE') patch.textAutoResize = 'HEIGHT';
      } else patch.textAutoResize = 'NONE';
    }
    patches[id] = { ...patches[id], ...patch };
    if (sizing === 'FILL') {
      const parent = doc.nodes[node.parentId];
      if (isAutoLayout(parent) && parent[key] === 'HUG') patches[parent.id] = { ...patches[parent.id], [key]: 'FIXED' };
    }
  }
  return patchNodes(doc, patches);
}

/**
 * Makes layers keep the size they are given along the axes named: what a
 * resize by hand does to a layer that hugged or filled, so that the size
 * that was dragged out or typed in is not taken away again by the layout.
 * Text is left to its own sizing mode where it hugs; the tools that resize
 * text change that mode themselves.
 */
export function releaseSizing(doc: Document, ids: readonly NodeId[], axes: { horizontal?: boolean; vertical?: boolean }): Document {
  const patches: Record<NodeId, LayerPatch> = {};
  for (const id of ids) {
    const node = doc.nodes[id];
    if (!isLayer(node)) continue;
    const patch: LayerPatch = {};
    const release = (sizing: LayoutSizing): boolean => sizing === 'FILL' || (sizing === 'HUG' && node.type !== 'TEXT');
    if (axes.horizontal && release(node.layoutSizingHorizontal)) patch.layoutSizingHorizontal = 'FIXED';
    if (axes.vertical && release(node.layoutSizingVertical)) patch.layoutSizingVertical = 'FIXED';
    if (Object.keys(patch).length > 0) patches[id] = patch;
  }
  return patchNodes(doc, patches);
}

/**
 * The place in a frame's stack that puts a layer at `position` in its flow
 * (0 is first), leaving the layers in `exclude` out of the count: they are
 * the ones being placed.
 */
function stackIndexFor(doc: Document, frame: FrameNode, position: number, exclude: ReadonlySet<NodeId>): number {
  const stack = getChildIds(doc, frame.id).filter((id) => !exclude.has(id));
  const flow = flowChildren(doc, frame).filter((child) => !exclude.has(child.id));
  if (flow.length === 0) return stack.length;
  const last = flow[flow.length - 1] as LayerNode;
  const at = flow[Math.max(0, Math.min(position, flow.length))];
  // A frame lays out from the bottom of its stack upwards, unless its order is reversed.
  if (!frame.itemsReversed) return at ? stack.indexOf(at.id) : stack.indexOf(last.id) + 1;
  return at ? stack.indexOf(at.id) + 1 : stack.indexOf(last.id);
}

/**
 * Moves layers of a frame to a place in its stack (counted without them),
 * keeping their order among themselves. Layers that are already there are
 * left exactly as they are, so that a drag that ends where it began is not
 * a change.
 */
function moveInStack(doc: Document, frameId: NodeId, ids: readonly NodeId[], index: number): Document {
  const stack = getChildIds(doc, frameId);
  const moving = stack.filter((id) => ids.includes(id));
  const rest = stack.filter((id) => !ids.includes(id));
  const target = [...rest.slice(0, index), ...moving, ...rest.slice(index)];
  if (target.every((id, i) => id === stack[i])) return doc;
  return reparentNodes(doc, moving, frameId, index);
}

/**
 * Where in an Auto Layout frame's flow a layer dropped at a point on the
 * page belongs: before the first child whose middle lies beyond the point
 * along the direction of the layout, and in a layout that wraps in the line
 * (the row, or the column) the point is over. Returns the place in the
 * frame's stack to insert at.
 */
export function flowIndexAt(doc: Document, frameId: NodeId, world: Point, exclude: ReadonlySet<NodeId> = new Set()): number {
  const frame = doc.nodes[frameId];
  if (!isAutoLayout(frame)) return getChildIds(doc, frameId).filter((id) => !exclude.has(id)).length;
  const point = applyToPoint(invert(getWorldMatrix(doc, frameId)), world);
  const flow = flowChildren(doc, frame).filter((child) => !exclude.has(child.id));
  const rects = flow.map((child) => transformedBounds(getLocalMatrix(child), child.width, child.height));
  // Seen along the layout and across it, a row and a column are the same thing.
  const column = frame.layoutMode === 'VERTICAL';
  const along = (rect: Rect): number => (column ? rect.y : rect.x);
  const length = (rect: Rect): number => (column ? rect.height : rect.width);
  const far = (rect: Rect): number => (column ? rect.x + rect.width : rect.y + rect.height);
  const at = { along: column ? point.y : point.x, across: column ? point.x : point.y };
  // The lines of the layout: a new one starts wherever a child is further back along it than the one before.
  const rows: number[][] = [];
  rects.forEach((rect, index) => {
    const previous = rects[index - 1];
    if (!previous || along(rect) < along(previous)) rows.push([index]);
    else (rows[rows.length - 1] as number[]).push(index);
  });
  const ends = rows.map((row) => Math.max(...row.map((index) => far(rects[index] as Rect))));
  let line = rows.findIndex((_, index) => at.across < (ends[index] as number) + frame.counterAxisSpacing / 2);
  if (line === -1) line = rows.length - 1;
  const row = rows[line] ?? [];
  const position = (row[0] ?? 0) + row.filter((index) => along(rects[index] as Rect) + length(rects[index] as Rect) / 2 < at.along).length;
  return stackIndexFor(doc, frame, position, exclude);
}

/**
 * Puts layers that an Auto Layout frame places at the point in its flow
 * that a point on the page is over. This is what dragging a child about
 * inside its frame does: it changes the child's place among the others.
 */
export function placeInFlow(doc: Document, ids: readonly NodeId[], world: Point): Document {
  const first = doc.nodes[ids[0] as NodeId];
  const frame = isLayer(first) ? doc.nodes[first.parentId] : undefined;
  if (!isAutoLayout(frame)) return doc;
  const moving = ids.filter((id) => {
    const node = doc.nodes[id];
    return isLayer(node) && node.parentId === frame.id && isInFlow(doc, node);
  });
  if (moving.length === 0) return doc;
  return moveInStack(doc, frame.id, moving, flowIndexAt(doc, frame.id, world, new Set(moving)));
}

/**
 * Moves layers one place earlier (-1) or later (1) in the flow of the Auto
 * Layout frame that places them: what the arrow keys do there. Several
 * layers move together, keeping their order. Null when the layers are not
 * all placed by the same frame.
 */
export function shiftInFlow(doc: Document, ids: readonly NodeId[], direction: -1 | 1): Document | null {
  const first = doc.nodes[ids[0] as NodeId];
  const frame = isLayer(first) ? doc.nodes[first.parentId] : undefined;
  if (!isAutoLayout(frame)) return null;
  const moving = new Set(ids);
  for (const id of ids) {
    const node = doc.nodes[id];
    if (!isLayer(node) || node.parentId !== frame.id || !isInFlow(doc, node)) return null;
  }
  const flow = flowChildren(doc, frame);
  const firstAt = flow.findIndex((child) => moving.has(child.id));
  // Its place among the layers that stay: how many of them come before it now, one more or one less.
  const before = flow.slice(0, firstAt).filter((child) => !moving.has(child.id)).length;
  const others = flow.length - moving.size;
  const position = Math.max(0, Math.min(others, before + direction));
  if (position === before) return doc;
  return moveInStack(doc, frame.id, [...moving], stackIndexFor(doc, frame, position, moving));
}

/** The direction of the layout a layer is placed by, or null when no frame places it. */
export function flowDirection(doc: Document, id: NodeId): Exclude<LayoutMode, 'NONE'> | null {
  const node = doc.nodes[id];
  if (!isLayer(node) || !isInFlow(doc, node)) return null;
  return (doc.nodes[node.parentId] as FrameNode).layoutMode as Exclude<LayoutMode, 'NONE'>;
}
