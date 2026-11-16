import { patchNodes } from '../document/mutate';
import {
  isFrame,
  isLayer,
  type Document,
  type FrameNode,
  type LayerNode,
  type LayerPatch,
  type LayoutSizing,
  type NodeId,
} from '../document/schema';
import { applyConstraints, clean, resizeFromTopLeft, setLayerBox } from '../ops/transform';
import { getAncestorIds, getChildIds } from '../scene/tree';
import { layoutText, type TextMeasurer } from '../text/layout';
import { breakLines, clampSize, distribute, extent, lineSizes, placeAcross, placeAlong, type FlowItem } from './flow';

/**
 * Auto Layout. A frame with a layout direction places its children itself:
 * in a row or a column, with padding round them and spacing between them,
 * each child a fixed size, as big as what is in it ("hug") or taking the room
 * that is left ("fill"), and the frame itself fixed or hugging its children.
 * A frame can also stretch its children across its layout, whatever their own
 * sizing that way.
 *
 * As with constraints and groups, nothing is worked out when the design is
 * painted: `applyAutoLayout` puts every Auto Layout frame of a document in
 * order and the stored positions and sizes are the result. The editor runs it
 * after every change (see `restoreLayout`), so that typing in a text, removing
 * a child or resizing a frame is followed by the layout in the same step.
 */

const EPSILON = 0.0005;

/** Whether a node is a frame that lays out its children. */
export function isAutoLayout(node: unknown): node is FrameNode {
  return isFrame(node as LayerNode | undefined) && (node as FrameNode).layoutMode !== 'NONE';
}

/**
 * Whether a layer belongs to the flow of the Auto Layout frame it sits
 * directly inside: it has not been taken out of it. A hidden layer still
 * belongs to it, and is placed again when it is shown.
 */
export function belongsToFlow(doc: Document, node: LayerNode | undefined): boolean {
  return !!node && node.layoutPositioning === 'AUTO' && isAutoLayout(doc.nodes[node.parentId]);
}

/** Whether a layer is placed by the Auto Layout frame it is in right now: it belongs to its flow and is shown. */
export function isInFlow(doc: Document, node: LayerNode | undefined): boolean {
  return !!node && node.visible && belongsToFlow(doc, node);
}

/**
 * The children an Auto Layout frame places, in the order it places them:
 * from the bottom of the stack to the top, or the other way round when the
 * frame's order is reversed. Hidden children and children taken out of the
 * flow are left where they are.
 */
export function flowChildren(doc: Document, frame: FrameNode): LayerNode[] {
  const children: LayerNode[] = [];
  for (const id of getChildIds(doc, frame.id)) {
    const child = doc.nodes[id];
    if (isLayer(child) && child.visible && child.layoutPositioning === 'AUTO') children.push(child);
  }
  return frame.itemsReversed ? children.reverse() : children;
}

type Axis = 'x' | 'y';

/** The axis a frame's layout runs along. */
function mainAxis(frame: FrameNode): Axis {
  return frame.layoutMode === 'VERTICAL' ? 'y' : 'x';
}

/** Whether a layer can be stretched along an axis at all. A line has no height, and a flat vector cannot gain one. */
function canStretch(node: LayerNode, axis: Axis): boolean {
  if (node.rotation !== 0) return false;
  if (node.type === 'LINE') return axis === 'x';
  if (node.type === 'VECTOR') return axis === 'x' ? node.width > 0 : node.height > 0;
  return true;
}

/** Whether a text fits itself to its content along an axis, by its own sizing mode. */
function textHugs(node: LayerNode, axis: Axis): boolean {
  return node.type === 'TEXT' && (axis === 'x' ? node.textAutoResize === 'WIDTH_AND_HEIGHT' : node.textAutoResize !== 'NONE');
}

/**
 * Whether a frame's STRETCH alignment reaches a child along an axis: the
 * axis is the one across the frame's layout, and the child is one that can be
 * given a size there. A rotated child, a line's height and a text that fits
 * itself to its content are left as they are.
 */
function stretches(frame: FrameNode, child: LayerNode, axis: Axis): boolean {
  return frame.counterAxisAlignItems === 'STRETCH' && mainAxis(frame) !== axis && canStretch(child, axis) && !textHugs(child, axis);
}

/**
 * The direction in which a layer is stretched by the frame that lays it out,
 * or null when it is not: the frame's alignment across is STRETCH and the
 * layer is in its flow and can be stretched. Along that direction the layer's
 * own sizing is not used.
 */
export function stretchedAcross(doc: Document, node: LayerNode | undefined): 'horizontal' | 'vertical' | null {
  if (!node || !belongsToFlow(doc, node)) return null;
  const frame = doc.nodes[node.parentId] as FrameNode;
  const axis: Axis = mainAxis(frame) === 'x' ? 'y' : 'x';
  if (!stretches(frame, node, axis)) return null;
  return axis === 'x' ? 'horizontal' : 'vertical';
}

/**
 * Whether a frame with a layout can be as big as its children along an axis.
 * It cannot where its size is what decides something about them. Along its
 * layout: while its spacing is automatic, which makes the gaps whatever the
 * frame's size leaves over. Across it: while it stretches its children (they
 * would be as big as the frame, and the frame as big as they are), and while
 * the lines of a wrapping layout are spread out with automatic gaps.
 */
export function canHug(frame: FrameNode, axis: Axis): boolean {
  if (mainAxis(frame) === axis) return frame.primaryAxisAlignItems !== 'SPACE_BETWEEN';
  if (frame.counterAxisAlignItems === 'STRETCH') return false;
  return !(frame.layoutWrap === 'WRAP' && frame.counterAxisAlignContent === 'SPACE_BETWEEN');
}

/**
 * What a layer's sizing along an axis can be where it is, given what it is
 * set to. "Hug" is for frames that lay out their children and for text (where
 * it says the same as the text's own sizing mode, which decides). "Fill" is
 * for a layer placed by an Auto Layout frame that has a size of its own along
 * that axis: a frame that hugs its children cannot also be filled by them.
 */
function allowedSizing(doc: Document, node: LayerNode, axis: Axis): LayoutSizing {
  const stored = axis === 'x' ? node.layoutSizingHorizontal : node.layoutSizingVertical;
  const parent = doc.nodes[node.parentId];
  const parentHugs = isAutoLayout(parent) && (axis === 'x' ? parent.layoutSizingHorizontal : parent.layoutSizingVertical) === 'HUG';
  const mayFill = belongsToFlow(doc, node) && !parentHugs && canStretch(node, axis);
  if (node.type === 'TEXT') {
    if (textHugs(node, axis)) return 'HUG';
    return stored === 'FILL' && mayFill ? 'FILL' : 'FIXED';
  }
  if (stored === 'HUG') return isAutoLayout(node) && canHug(node, axis) ? 'HUG' : 'FIXED';
  if (stored === 'FILL') return mayFill ? 'FILL' : 'FIXED';
  return 'FIXED';
}

/**
 * Makes every layer's sizing and positioning say what actually happens to it:
 * "hug" and "fill" only where they can apply, and "taken out of the flow"
 * only inside a frame that has a flow. A setting that cannot apply becomes
 * "fixed", which is how such a layer behaves.
 */
export function settleSizing(doc: Document): Document {
  const patches: Record<NodeId, LayerPatch> = {};
  for (const id in doc.nodes) {
    const node = doc.nodes[id];
    if (!isLayer(node)) continue;
    const patch: LayerPatch = {};
    const horizontal = allowedSizing(doc, node, 'x');
    const vertical = allowedSizing(doc, node, 'y');
    if (horizontal !== node.layoutSizingHorizontal) patch.layoutSizingHorizontal = horizontal;
    if (vertical !== node.layoutSizingVertical) patch.layoutSizingVertical = vertical;
    if (node.layoutPositioning === 'ABSOLUTE' && !isAutoLayout(doc.nodes[node.parentId])) patch.layoutPositioning = 'AUTO';
    if (Object.keys(patch).length > 0) patches[id] = patch;
  }
  return patchNodes(doc, patches);
}

/** The room a layer takes up in a row or a column: its box, or the box round it when it is rotated. */
function footprint(node: LayerNode, width: number, height: number): { width: number; height: number } {
  if (node.rotation === 0) return { width, height };
  const r = (node.rotation * Math.PI) / 180;
  const cos = Math.abs(Math.cos(r));
  const sin = Math.abs(Math.sin(r));
  return { width: width * cos + height * sin, height: width * sin + height * cos };
}

/** One frame's lines of children (a row that does not wrap, and a column, have one). */
interface Lines {
  /** For each line, the positions of its children in the frame's flow. */
  rows: number[][];
  /** The size of each line across the direction of the layout, once heights are known. */
  sizes: number[];
}

/**
 * Lays out one Auto Layout frame and every Auto Layout frame nested in its
 * flow. Widths are settled first, from the outside in, because how tall a
 * wrapped text or a wrapping row is depends on how wide it is; then heights;
 * then positions.
 */
function layoutTree(doc: Document, rootId: NodeId, measurer: TextMeasurer): Document {
  const root = doc.nodes[rootId];
  if (!isAutoLayout(root)) return doc;

  const flows = new Map<NodeId, LayerNode[]>();
  const flowOf = (frame: FrameNode): LayerNode[] => {
    let flow = flows.get(frame.id);
    if (!flow) {
      flow = flowChildren(doc, frame);
      flows.set(frame.id, flow);
    }
    return flow;
  };
  /** A child that this pass lays out itself, rather than taking as a box of a given size. */
  const nested = (node: LayerNode): node is FrameNode => isAutoLayout(node) && node.rotation === 0;

  const widths = new Map<NodeId, number>();
  const heights = new Map<NodeId, number>();
  const positions = new Map<NodeId, { x: number; y: number }>();
  const lines = new Map<NodeId, Lines>();
  const hugWidths = new Map<NodeId, number>();
  const hugHeights = new Map<NodeId, number>();

  const limits = (node: LayerNode, axis: Axis): { min: number; max: number } => {
    // A rotated layer is a box of a given size to the layout, whatever its limits say.
    if (node.rotation !== 0) return { min: 0, max: Infinity };
    const min = axis === 'x' ? node.minWidth : node.minHeight;
    const max = axis === 'x' ? node.maxWidth : node.maxHeight;
    return { min: min ?? 0, max: max ?? Infinity };
  };

  // ------------------------------------------------------------------ widths

  /** The width of a frame that hugs its children: theirs, the spacing between them, and its padding. */
  const hugWidth = (frame: FrameNode): number => {
    const known = hugWidths.get(frame.id);
    if (known !== undefined) return known;
    // With nothing to hug, the frame keeps the width it has rather than shrinking to nothing.
    if (flowOf(frame).length === 0) return frame.width;
    const sizes = flowOf(frame).map((child) => {
      const { min, max } = limits(child, 'x');
      return footprint(child, clampSize(ownWidth(child), min, max), child.height).width;
    });
    const content = frame.layoutMode === 'HORIZONTAL' ? extent(sizes, frame.itemSpacing) : Math.max(0, ...sizes);
    const { min, max } = limits(frame, 'x');
    const width = clampSize(content + frame.paddingLeft + frame.paddingRight, min, max);
    hugWidths.set(frame.id, width);
    return width;
  };

  /** The width a child has when it does not fill. */
  const ownWidth = (node: LayerNode): number => (nested(node) && node.layoutSizingHorizontal === 'HUG' ? hugWidth(node) : node.width);

  const widthItem = (frame: FrameNode, child: LayerNode): FlowItem => {
    const fill = child.layoutSizingHorizontal === 'FILL' || stretches(frame, child, 'x');
    const { min, max } = limits(child, 'x');
    // Something that fills never shrinks to nothing: a layer without a width cannot be seen or picked up.
    if (fill) return { size: 0, fill, min: Math.max(1, min), max: Math.max(1, max) };
    return { size: footprint(child, clampSize(ownWidth(child), min, max), child.height).width, fill, min: 0, max: Infinity };
  };

  const setWidth = (frame: FrameNode, width: number): void => {
    widths.set(frame.id, width);
    const flow = flowOf(frame);
    const inner = Math.max(0, width - frame.paddingLeft - frame.paddingRight);
    const items = flow.map((child) => widthItem(frame, child));
    let sizes: number[];
    if (frame.layoutMode === 'HORIZONTAL') {
      const all = flow.map((_, index) => index);
      const rows =
        frame.layoutWrap === 'WRAP'
          ? breakLines(
              items.map((item) => (item.fill ? item.min : item.size)),
              inner,
              frame.itemSpacing,
            )
          : flow.length > 0
            ? [all]
            : [];
      sizes = new Array<number>(flow.length).fill(0);
      for (const row of rows) {
        const shared = distribute(
          row.map((index) => items[index] as FlowItem),
          inner,
          frame.itemSpacing,
        );
        row.forEach((index, k) => {
          sizes[index] = shared[k] as number;
        });
      }
      lines.set(frame.id, { rows, sizes: [] });
    } else {
      sizes = items.map((item) => (item.fill ? clampSize(inner, item.min, item.max) : item.size));
      lines.set(frame.id, { rows: flow.length > 0 ? [flow.map((_, index) => index)] : [], sizes: [] });
    }
    flow.forEach((child, index) => {
      // A rotated child keeps its own width; what was worked out above is the room it takes.
      const own = child.rotation === 0 ? (sizes[index] as number) : child.width;
      if (nested(child)) setWidth(child, own);
      else widths.set(child.id, own);
    });
  };

  // ----------------------------------------------------------------- heights

  /** The height of a text that follows its content, at the width it has been given. */
  const textHeight = (node: LayerNode): number => {
    if (node.type !== 'TEXT' || node.rotation !== 0 || node.textAutoResize !== 'HEIGHT') return node.height;
    const width = widths.get(node.id) ?? node.width;
    if (Math.abs(width - node.width) < EPSILON) return node.height;
    return Math.max(1, layoutText({ ...node, width: clean(width) }, measurer).height);
  };

  /** The height a child has when it does not fill. */
  const ownHeight = (node: LayerNode): number => {
    if (nested(node)) return node.layoutSizingVertical === 'HUG' ? hugHeight(node) : node.height;
    return textHeight(node);
  };

  const heightItem = (frame: FrameNode, child: LayerNode): FlowItem => {
    const fill = child.layoutSizingVertical === 'FILL' || stretches(frame, child, 'y');
    const { min, max } = limits(child, 'y');
    if (fill) return { size: 0, fill, min: Math.max(1, min), max: Math.max(1, max) };
    const width = widths.get(child.id) ?? child.width;
    return { size: footprint(child, width, clampSize(ownHeight(child), min, max)).height, fill, min: 0, max: Infinity };
  };

  /** The height of a frame that hugs its children: a column's children one under another, or a row's lines. */
  const hugHeight = (frame: FrameNode): number => {
    const known = hugHeights.get(frame.id);
    if (known !== undefined) return known;
    if (flowOf(frame).length === 0) return frame.height;
    const items = flowOf(frame).map((child) => heightItem(frame, child));
    const rows = lines.get(frame.id)?.rows ?? [];
    const content =
      frame.layoutMode === 'VERTICAL'
        ? extent(distribute(items, null, frame.itemSpacing), frame.itemSpacing)
        : extent(lineSizes(rows, items, null, frame.counterAxisSpacing, frame.layoutWrap === 'WRAP'), frame.counterAxisSpacing);
    const { min, max } = limits(frame, 'y');
    const height = clampSize(content + frame.paddingTop + frame.paddingBottom, min, max);
    hugHeights.set(frame.id, height);
    return height;
  };

  const setHeight = (frame: FrameNode, height: number): void => {
    heights.set(frame.id, height);
    const flow = flowOf(frame);
    const inner = Math.max(0, height - frame.paddingTop - frame.paddingBottom);
    const items = flow.map((child) => heightItem(frame, child));
    const own = lines.get(frame.id) as Lines;
    let sizes: number[];
    if (frame.layoutMode === 'VERTICAL') {
      sizes = distribute(items, inner, frame.itemSpacing);
      own.sizes = [];
    } else {
      own.sizes = lineSizes(own.rows, items, inner, frame.counterAxisSpacing, frame.layoutWrap === 'WRAP');
      sizes = new Array<number>(flow.length).fill(0);
      own.rows.forEach((row, line) => {
        for (const index of row) {
          const item = items[index] as FlowItem;
          sizes[index] = item.fill ? clampSize(own.sizes[line] as number, item.min, item.max) : item.size;
        }
      });
    }
    flow.forEach((child, index) => {
      const mine = child.rotation === 0 ? (sizes[index] as number) : child.height;
      if (nested(child)) setHeight(child, mine);
      else heights.set(child.id, mine);
    });
  };

  // --------------------------------------------------------------- positions

  const place = (frame: FrameNode): void => {
    const flow = flowOf(frame);
    const own = lines.get(frame.id) as Lines;
    const innerWidth = Math.max(0, (widths.get(frame.id) as number) - frame.paddingLeft - frame.paddingRight);
    const innerHeight = Math.max(0, (heights.get(frame.id) as number) - frame.paddingTop - frame.paddingBottom);
    const rooms = flow.map((child) => footprint(child, widths.get(child.id) as number, heights.get(child.id) as number));
    const put = (index: number, left: number, top: number): void => {
      const child = flow[index] as LayerNode;
      const room = rooms[index] as { width: number; height: number };
      // A rotated layer turns about the middle of its box, which is the middle of the room it takes.
      positions.set(child.id, {
        x: frame.paddingLeft + left + (room.width - (widths.get(child.id) as number)) / 2,
        y: frame.paddingTop + top + (room.height - (heights.get(child.id) as number)) / 2,
      });
    };
    // A child that a stretch does not reach sits at the start, across the layout.
    const across = frame.counterAxisAlignItems === 'STRETCH' ? 'MIN' : frame.counterAxisAlignItems;
    if (frame.layoutMode === 'HORIZONTAL') {
      const spread = frame.layoutWrap === 'WRAP' && frame.counterAxisAlignContent === 'SPACE_BETWEEN';
      const tops = placeAlong(own.sizes, innerHeight, frame.counterAxisSpacing, spread ? 'SPACE_BETWEEN' : across);
      own.rows.forEach((row, line) => {
        const lefts = placeAlong(
          row.map((index) => (rooms[index] as { width: number }).width),
          innerWidth,
          frame.itemSpacing,
          frame.primaryAxisAlignItems,
        );
        row.forEach((index, k) => {
          const down = placeAcross((rooms[index] as { height: number }).height, own.sizes[line] as number, across);
          put(index, lefts[k] as number, (tops[line] as number) + down);
        });
      });
    } else {
      const tops = placeAlong(
        rooms.map((room) => room.height),
        innerHeight,
        frame.itemSpacing,
        frame.primaryAxisAlignItems,
      );
      flow.forEach((_, index) => {
        put(index, placeAcross((rooms[index] as { width: number }).width, innerWidth, across), tops[index] as number);
      });
    }
    for (const child of flow) if (nested(child)) place(child);
  };

  // ---------------------------------------------------------------- the pass

  const rootLimits = { x: limits(root, 'x'), y: limits(root, 'y') };
  setWidth(root, root.layoutSizingHorizontal === 'HUG' ? hugWidth(root) : clampSize(root.width, rootLimits.x.min, rootLimits.x.max));
  setHeight(root, root.layoutSizingVertical === 'HUG' ? hugHeight(root) : clampSize(root.height, rootLimits.y.min, rootLimits.y.max));
  place(root);

  // Write the result, from the outside in. Sizes go through the operations that
  // keep what is inside a layer in step with its box.
  let next = doc;
  const differs = (a: number, b: number): boolean => Math.abs(a - b) >= EPSILON;
  const resize = (id: NodeId, width: number, height: number, position: { x: number; y: number } | null): void => {
    const node = next.nodes[id];
    if (!isLayer(node)) return;
    const sized = differs(node.width, width) || differs(node.height, height);
    const box: LayerPatch = {};
    if (sized) {
      box.width = clean(width);
      box.height = clean(height);
    }
    if (position) {
      if (differs(node.x, position.x)) box.x = clean(position.x);
      if (differs(node.y, position.y)) box.y = clean(position.y);
    } else if (sized) {
      // The frame the pass started from keeps its top-left corner where it is, also when it is rotated.
      const kept = resizeFromTopLeft(node, clean(width), clean(height));
      box.x = kept.x;
      box.y = kept.y;
    }
    if (Object.keys(box).length === 0) return;
    if (isAutoLayout(node)) {
      // Its flow is placed by this pass; what it holds outside the flow follows its constraints.
      next = patchNodes(next, { [id]: box });
      if (sized) next = applyConstraints(next, id, node.width, node.height, clean(width), clean(height));
    } else if (sized) next = setLayerBox(next, id, box);
    else next = patchNodes(next, { [id]: box });
  };
  const write = (frame: FrameNode): void => {
    for (const child of flowOf(frame)) {
      resize(child.id, widths.get(child.id) as number, heights.get(child.id) as number, positions.get(child.id) ?? null);
      if (nested(child)) write(child);
    }
  };
  resize(rootId, widths.get(rootId) as number, heights.get(rootId) as number, null);
  write(root);
  return next;
}

/**
 * Puts every Auto Layout frame of a document in order: each child where the
 * frame's direction, padding, spacing and alignment put it, at the size its
 * own sizing gives it, and each frame that hugs its children exactly as big
 * as they need. Frames nested in another's flow are laid out with it; the
 * others are done innermost first, so that a frame is the right size before
 * whatever contains it looks at it. Returns the same document when everything
 * is already in order.
 */
export function applyAutoLayout(doc: Document, measurer: TextMeasurer): Document {
  let any = false;
  for (const id in doc.nodes) {
    const node = doc.nodes[id];
    if (!isLayer(node)) continue;
    if (isAutoLayout(node) || node.layoutSizingHorizontal !== 'FIXED' || node.layoutSizingVertical !== 'FIXED' || node.layoutPositioning !== 'AUTO') {
      any = true;
      break;
    }
  }
  if (!any) return doc;

  let next = settleSizing(doc);
  // The frames to start a pass from: those that no other frame's pass reaches.
  const roots: { id: NodeId; depth: number }[] = [];
  for (const id in next.nodes) {
    const node = next.nodes[id];
    if (!isAutoLayout(node)) continue;
    if (isInFlow(next, node) && node.rotation === 0) continue;
    roots.push({ id, depth: getAncestorIds(next, id).length });
  }
  roots.sort((a, b) => b.depth - a.depth || (a.id < b.id ? -1 : 1));
  for (const { id } of roots) next = layoutTree(next, id, measurer);
  return next;
}
