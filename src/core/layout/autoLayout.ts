import { patchNodes } from '../document/mutate';
import {
  isFrame,
  isLayer,
  type Document,
  type DesignNode,
  type FrameNode,
  type LayerNode,
  type LayerPatch,
  type LayoutSizing,
  type NodeId,
} from '../document/schema';
import { applyConstraints, clean, resizeFromTopLeft, setLayerBox } from '../ops/transform';
import { getAncestorIds, getChildIds } from '../scene/tree';
import { layoutText, type TextMeasurer } from '../text/layout';
import { scaleNetwork } from '../vector/network';
import { breakLines, clampSize, distribute, extent, lineSizes, placeAcross, placeAlong, type FlowItem } from './flow';

/**
 * Auto Layout. A frame with a layout direction places its children itself:
 * in a row or a column, with padding round them and spacing between them,
 * each child a fixed size, as big as what is in it ("hug") or taking the room
 * that is left ("fill"), and the frame itself fixed or hugging its children.
 * A frame can also stretch its children across its layout, whatever their own
 * sizing that way, and carry a row or a column on in further lines when it
 * runs out of room.
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

/** One frame's lines of children: the rows of a row that wraps, the columns of a column that wraps, otherwise one. */
interface Lines {
  /** For each line, the positions of its children in the frame's flow. */
  rows: number[][];
  /** The size of each line across the direction of the layout: the height of a row, the width of a column. */
  sizes: number[];
}

/** What one run over a frame and the frames nested in its flow works out. */
interface Solved {
  widths: Map<NodeId, number>;
  heights: Map<NodeId, number>;
  positions: Map<NodeId, { x: number; y: number }>;
  /**
   * The wrapping columns whose height is given to them by the frame they are
   * in, with the height each was taken to have while its columns were made.
   */
  trusted: Map<NodeId, number>;
}

/** How often a pass is run again because a height taken on trust turned out different. */
const MAX_RUNS = 4;

/**
 * Lays out one Auto Layout frame and every Auto Layout frame nested in its
 * flow. Widths are settled first, from the outside in, because how tall a
 * wrapped text or a wrapping row is depends on how wide it is; then heights;
 * then positions.
 *
 * A column that wraps is the other way round: how wide it is, and its
 * children with it, depends on its height, which says where a new column
 * starts. Its height is known beforehand when it is fixed or hugs; when the
 * frame it is in gives it (it fills, or is stretched), the height it has now
 * is taken on trust and the run is repeated if the result disagrees.
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
  const wrapsColumn = (frame: FrameNode): boolean => frame.layoutMode === 'VERTICAL' && frame.layoutWrap === 'WRAP';

  const limits = (node: LayerNode, axis: Axis): { min: number; max: number } => {
    // A rotated layer is a box of a given size to the layout, whatever its limits say.
    if (node.rotation !== 0) return { min: 0, max: Infinity };
    const min = axis === 'x' ? node.minWidth : node.minHeight;
    const max = axis === 'x' ? node.maxWidth : node.maxHeight;
    return { min: min ?? 0, max: max ?? Infinity };
  };

  const solve = (assumed: ReadonlyMap<NodeId, number>): Solved => {
    const widths = new Map<NodeId, number>();
    const heights = new Map<NodeId, number>();
    const positions = new Map<NodeId, { x: number; y: number }>();
    const trusted = new Map<NodeId, number>();
    const lines = new Map<NodeId, Lines>();
    const hugWidths = new Map<NodeId, number>();
    const hugHeights = new Map<NodeId, number>();
    const columns = new Map<NodeId, number[][]>();

    // ---------------------------------------------------------------- widths

    /** The width of a frame that hugs its children: theirs, the spacing between them, and its padding. */
    const hugWidth = (frame: FrameNode): number => {
      const known = hugWidths.get(frame.id);
      if (known !== undefined) return known;
      // With nothing to hug, the frame keeps the width it has rather than shrinking to nothing.
      if (flowOf(frame).length === 0) return frame.width;
      let content: number;
      if (wrapsColumn(frame)) {
        // Its columns side by side: each as wide as its widest child.
        const items = flowOf(frame).map((child) => widthItem(frame, child));
        content = extent(lineSizes(columnsOf(frame, null), items, null, frame.counterAxisSpacing, true), frame.counterAxisSpacing);
      } else {
        const sizes = flowOf(frame).map((child) => {
          const { min, max } = limits(child, 'x');
          return footprint(child, clampSize(ownWidth(child), min, max), child.height).width;
        });
        content = frame.layoutMode === 'HORIZONTAL' ? extent(sizes, frame.itemSpacing) : Math.max(0, ...sizes);
      }
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

    /**
     * The height between its padding at which a wrapping column starts a new
     * column, or null where it never does: a column that hugs its height and
     * has no maximum is as tall as its children need.
     */
    const breakHeight = (frame: FrameNode): number | null => {
      const { min, max } = limits(frame, 'y');
      const padding = frame.paddingTop + frame.paddingBottom;
      const parent = frame.id === rootId ? undefined : doc.nodes[frame.parentId];
      if (isAutoLayout(parent) && (frame.layoutSizingVertical === 'FILL' || stretches(parent, frame, 'y'))) {
        // Its height comes from the frame it is in, which is settled only after the widths.
        const height = assumed.get(frame.id) ?? frame.height;
        trusted.set(frame.id, height);
        return Math.max(0, height - padding);
      }
      if (frame.layoutSizingVertical === 'HUG') return max === Infinity ? null : Math.max(0, max - padding);
      return Math.max(0, clampSize(frame.height, min, max) - padding);
    };

    /** Forgets what was measured inside a child at a width that was only provisional. */
    const forget = (node: LayerNode): void => {
      if (!nested(node)) return;
      hugHeights.delete(node.id);
      columns.delete(node.id);
      for (const child of flowOf(node)) forget(child);
    };

    /**
     * Breaks the children of a wrapping column into its columns. Where a
     * column ends depends on the children's heights, and a child's height
     * can depend on its width (text that wraps, a row that wraps), so every
     * child is given a width first: its own, or, where it fills across the
     * layout, the whole width between the padding, since which column it will
     * be in, and how wide that is, is not known yet. `inner` is that width,
     * or null while the frame's own width is still being worked out (it hugs,
     * and then nothing fills across it).
     */
    const columnsOf = (frame: FrameNode, inner: number | null): number[][] => {
      const known = columns.get(frame.id);
      if (known) return known;
      const flow = flowOf(frame);
      const items = flow.map((child) => widthItem(frame, child));
      flow.forEach((child, index) => {
        const item = items[index] as FlowItem;
        const provisional = child.rotation !== 0 ? child.width : item.fill ? clampSize(inner ?? 0, item.min, item.max) : item.size;
        if (nested(child)) setWidth(child, provisional);
        else widths.set(child.id, provisional);
      });
      const tall = flow.map((child) => heightItem(frame, child));
      const rows = breakLines(
        tall.map((item) => (item.fill ? item.min : item.size)),
        breakHeight(frame),
        frame.itemSpacing,
      );
      // What was measured at the full width is measured again once the child has its column's width.
      flow.forEach((child, index) => {
        if ((items[index] as FlowItem).fill) forget(child);
      });
      columns.set(frame.id, rows);
      return rows;
    };

    const setWidth = (frame: FrameNode, width: number): void => {
      widths.set(frame.id, width);
      const flow = flowOf(frame);
      const inner = Math.max(0, width - frame.paddingLeft - frame.paddingRight);
      const items = flow.map((child) => widthItem(frame, child));
      const all = flow.length > 0 ? [flow.map((_, index) => index)] : [];
      const sizes = new Array<number>(flow.length).fill(0);
      if (frame.layoutMode === 'HORIZONTAL') {
        const rows =
          frame.layoutWrap === 'WRAP'
            ? breakLines(
                items.map((item) => (item.fill ? item.min : item.size)),
                inner,
                frame.itemSpacing,
              )
            : all;
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
        // How tall each line is comes with the heights.
        lines.set(frame.id, { rows, sizes: [] });
      } else {
        // A column, or the columns of one that wraps: each is as wide as its widest child (the one column of a
        // column that does not wrap, as wide as the frame has room), and a child that fills is as wide as its column.
        const wrap = wrapsColumn(frame);
        const rows = wrap ? columnsOf(frame, inner) : all;
        const across = lineSizes(rows, items, inner, frame.counterAxisSpacing, wrap);
        rows.forEach((row, line) => {
          for (const index of row) {
            const item = items[index] as FlowItem;
            sizes[index] = item.fill ? clampSize(across[line] as number, item.min, item.max) : item.size;
          }
        });
        lines.set(frame.id, { rows, sizes: across });
      }
      flow.forEach((child, index) => {
        // A rotated child keeps its own width; what was worked out above is the room it takes.
        const own = child.rotation === 0 ? (sizes[index] as number) : child.width;
        if (nested(child)) setWidth(child, own);
        else widths.set(child.id, own);
      });
    };

    // --------------------------------------------------------------- heights

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

    /**
     * How far below its top a layer's baseline is, for a row aligned on the baseline of text: a text's first line, the
     * first text in a frame (where it sits in the frame), and for anything without text its bottom edge, as in Figma.
     */
    const textBaseline = (node: LayerNode, depth: number): number | null => {
      if (!node.visible || node.rotation !== 0) return null;
      const height = heights.get(node.id) ?? node.height;
      if (node.type === 'TEXT') {
        const laid = layoutText({ ...node, width: clean(widths.get(node.id) ?? node.width), height: clean(height) }, measurer);
        return laid.lines[0]?.baseline ?? null;
      }
      if ((node.type !== 'FRAME' && node.type !== 'GROUP') || depth > 8) return null;
      const inside = node.type === 'FRAME' && isAutoLayout(node) ? flowOf(node) : getChildIds(doc, node.id).map((id) => doc.nodes[id]).filter(isLayer);
      for (const child of inside) {
        const found = textBaseline(child, depth + 1);
        if (found !== null) return (positions.get(child.id)?.y ?? child.y) - (node.type === 'GROUP' ? node.y : 0) + found;
      }
      return null;
    };
    const baselineOf = (node: LayerNode): number => textBaseline(node, 0) ?? (heights.get(node.id) ?? node.height);
    /** The height a row aligned on the baseline takes: from the highest baseline's top to the lowest bottom. */
    const baselineRow = (row: readonly number[], flow: readonly LayerNode[], heightOf: (index: number) => number): number => {
      let above = 0;
      let below = 0;
      for (const index of row) {
        const child = flow[index] as LayerNode;
        const base = baselineOf(child);
        above = Math.max(above, base);
        below = Math.max(below, heightOf(index) - base);
      }
      return above + below;
    };

    /** The height of a frame that hugs its children: the tallest column of a column, or a row's lines one under another. */
    const hugHeight = (frame: FrameNode): number => {
      const known = hugHeights.get(frame.id);
      if (known !== undefined) return known;
      if (flowOf(frame).length === 0) return frame.height;
      const items = flowOf(frame).map((child) => heightItem(frame, child));
      const rows = lines.get(frame.id)?.rows ?? [];
      const content =
        frame.layoutMode === 'VERTICAL'
          ? Math.max(
              0,
              ...rows.map((row) =>
                extent(
                  distribute(
                    row.map((index) => items[index] as FlowItem),
                    null,
                    frame.itemSpacing,
                  ),
                  frame.itemSpacing,
                ),
              ),
            )
          : frame.counterAxisAlignItems === 'BASELINE'
            ? extent(rows.map((row) => baselineRow(row, flowOf(frame), (index) => (items[index] as FlowItem).size)), frame.counterAxisSpacing)
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
      const sizes = new Array<number>(flow.length).fill(0);
      if (frame.layoutMode === 'VERTICAL') {
        // Each column shares out its own height.
        for (const row of own.rows) {
          const shared = distribute(
            row.map((index) => items[index] as FlowItem),
            inner,
            frame.itemSpacing,
          );
          row.forEach((index, k) => {
            sizes[index] = shared[k] as number;
          });
        }
      } else {
        own.sizes = lineSizes(own.rows, items, inner, frame.counterAxisSpacing, frame.layoutWrap === 'WRAP');
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

    // ------------------------------------------------------------- positions

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
      // A child that a stretch does not reach sits at the start, across the layout; so does one in a column aligned on the baseline.
      const baseline = frame.counterAxisAlignItems === 'BASELINE';
      const across: 'MIN' | 'CENTER' | 'MAX' = frame.counterAxisAlignItems === 'CENTER' || frame.counterAxisAlignItems === 'MAX' ? frame.counterAxisAlignItems : 'MIN';
      const spread = frame.layoutWrap === 'WRAP' && frame.counterAxisAlignContent === 'SPACE_BETWEEN';
      if (frame.layoutMode === 'HORIZONTAL') {
        const tops = placeAlong(own.sizes, innerHeight, frame.counterAxisSpacing, spread ? 'SPACE_BETWEEN' : across);
        own.rows.forEach((row, line) => {
          const lefts = placeAlong(
            row.map((index) => (rooms[index] as { width: number }).width),
            innerWidth,
            frame.itemSpacing,
            frame.primaryAxisAlignItems,
          );
          // Aligned on the baseline, each item is moved down until its baseline is level with the lowest-lying one.
          const bases = baseline ? row.map((index) => baselineOf(flow[index] as LayerNode)) : [];
          const level = baseline ? Math.max(0, ...bases) : 0;
          row.forEach((index, k) => {
            const down = baseline ? level - (bases[k] as number) : placeAcross((rooms[index] as { height: number }).height, own.sizes[line] as number, across);
            put(index, lefts[k] as number, (tops[line] as number) + down);
          });
        });
      } else {
        const lefts = placeAlong(own.sizes, innerWidth, frame.counterAxisSpacing, spread ? 'SPACE_BETWEEN' : across);
        own.rows.forEach((row, line) => {
          const tops = placeAlong(
            row.map((index) => (rooms[index] as { height: number }).height),
            innerHeight,
            frame.itemSpacing,
            frame.primaryAxisAlignItems,
          );
          row.forEach((index, k) => {
            const over = placeAcross((rooms[index] as { width: number }).width, own.sizes[line] as number, across);
            put(index, (lefts[line] as number) + over, tops[k] as number);
          });
        });
      }
      for (const child of flow) if (nested(child)) place(child);
    };

    const rootLimits = { x: limits(root, 'x'), y: limits(root, 'y') };
    setWidth(root, root.layoutSizingHorizontal === 'HUG' ? hugWidth(root) : clampSize(root.width, rootLimits.x.min, rootLimits.x.max));
    setHeight(root, root.layoutSizingVertical === 'HUG' ? hugHeight(root) : clampSize(root.height, rootLimits.y.min, rootLimits.y.max));
    place(root);
    return { widths, heights, positions, trusted };
  };

  // ---------------------------------------------------------------- the pass

  let solved = solve(new Map());
  for (let run = 1; run < MAX_RUNS; run++) {
    // A wrapping column that was given a different height than the one its columns were made for is done again.
    const given = new Map<NodeId, number>();
    let settled = true;
    for (const [id, taken] of solved.trusted) {
      const height = solved.heights.get(id) ?? taken;
      given.set(id, height);
      if (Math.abs(height - taken) >= EPSILON) settled = false;
    }
    if (settled) break;
    solved = solve(given);
  }
  const { widths, heights, positions } = solved;

  // Write the result, from the outside in. Sizes go through the operations that
  // keep what is inside a layer in step with its box.
  let next = doc;
  // Plain changes of place and size are gathered and written together: writing them one by one copies the
  // document's map each time, which in a file of thousands of layers is most of the time a layout takes.
  // Only a box whose contents have to follow it is written at once, after what was gathered.
  let pending: Record<NodeId, LayerPatch> = {};
  const flush = (): void => {
    if (Object.keys(pending).length === 0) return;
    next = patchNodes(next, pending);
    pending = {};
  };
  const current = (id: NodeId): DesignNode | undefined => {
    const node = next.nodes[id];
    const patch = pending[id];
    return patch && node ? ({ ...node, ...patch } as DesignNode) : node;
  };
  const differs = (a: number, b: number): boolean => Math.abs(a - b) >= EPSILON;
  const resize = (id: NodeId, width: number, height: number, position: { x: number; y: number } | null): void => {
    const node = current(id);
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
    const holds = getChildIds(next, id).length > 0;
    // Its flow is placed by this pass; what it holds outside the flow follows its constraints.
    const followers = isAutoLayout(node) ? getChildIds(next, id).some((childId) => { const child = next.nodes[childId]; return isLayer(child) && child.layoutPositioning === 'ABSOLUTE'; }) : holds;
    if (!sized || !followers) {
      // A vector's points are drawn where they are, so a vector given another size has them scaled to it, as setLayerBox does.
      if (sized && node.type === 'VECTOR') {
        const sx = node.width > 0 ? clean(width) / node.width : 1;
        const sy = node.height > 0 ? clean(height) / node.height : 1;
        if (node.width <= 0) delete box.width;
        if (node.height <= 0) delete box.height;
        if (sx !== 1 || sy !== 1) box.network = scaleNetwork(node.network, node.width > 0 ? sx : 1, node.height > 0 ? sy : 1);
      }
      pending[id] = { ...(pending[id] ?? {}), ...box };
      return;
    }
    flush();
    if (isAutoLayout(node)) {
      next = patchNodes(next, { [id]: box });
      next = applyConstraints(next, id, node.width, node.height, clean(width), clean(height));
    } else next = setLayerBox(next, id, box);
  };
  const write = (frame: FrameNode): void => {
    for (const child of flowOf(frame)) {
      resize(child.id, widths.get(child.id) as number, heights.get(child.id) as number, positions.get(child.id) ?? null);
      if (isAutoLayout(child) && child.rotation === 0) write(child);
    }
  };
  resize(rootId, widths.get(rootId) as number, heights.get(rootId) as number, null);
  write(root);
  flush();
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
