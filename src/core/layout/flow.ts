/**
 * The arithmetic of Auto Layout along one axis: sharing out space, breaking
 * a row into lines, and placing things. Nothing here knows about documents or
 * layers; `autoLayout.ts` asks these questions about a frame's children, once
 * for widths and once for heights.
 */

/** One layer in the flow of an Auto Layout frame, measured along one axis. */
export interface FlowItem {
  /** Its size when it does not fill: its own size, or the size of what is in it. */
  size: number;
  /** Whether it takes a share of the space that is left over. */
  fill: boolean;
  /** The smallest and largest it may be. `max` may be Infinity. */
  min: number;
  max: number;
}

/** Where the items of a row sit along it, or across it. */
export type FlowAlign = 'MIN' | 'CENTER' | 'MAX' | 'SPACE_BETWEEN';

/** A size kept between a minimum and a maximum. Where the two disagree the minimum wins, as in CSS. */
export function clampSize(size: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, size));
}

/** How much room `count` items with `gap` between them leave of `available`. */
function gaps(count: number, gap: number): number {
  return count > 1 ? gap * (count - 1) : 0;
}

/**
 * The size of each item along the direction of the layout. Items that do not
 * fill keep their size (within their limits). Items that fill share what is
 * left of `available` equally; one that reaches its limit keeps that and the
 * others share the rest. With `available` null there is nothing to share (the
 * frame is as big as its content), and filling items are as small as they may be.
 */
export function distribute(items: readonly FlowItem[], available: number | null, gap: number): number[] {
  const sizes = items.map((item) => (item.fill ? item.min : clampSize(item.size, item.min, item.max)));
  let flexible = items.map((_, index) => index).filter((index) => (items[index] as FlowItem).fill);
  if (available === null || flexible.length === 0) return sizes;

  let free = available - gaps(items.length, gap);
  items.forEach((item, index) => {
    if (!item.fill) free -= sizes[index] as number;
  });
  // Shares that run into a limit are settled first, and the rest is shared again among the others.
  while (flexible.length > 0) {
    const share = Math.max(0, free) / flexible.length;
    const clamped = flexible.map((index) => clampSize(share, (items[index] as FlowItem).min, (items[index] as FlowItem).max));
    const violation = clamped.reduce((sum, size) => sum + size - share, 0);
    if (Math.abs(violation) < 1e-9) {
      flexible.forEach((index, k) => {
        sizes[index] = clamped[k] as number;
      });
      break;
    }
    const remaining: number[] = [];
    flexible.forEach((index, k) => {
      const size = clamped[k] as number;
      // Too little space overall: the ones held up by a minimum are settled. Too much: the ones held down by a maximum.
      const settled = violation > 0 ? size > share : size < share;
      if (settled) {
        sizes[index] = size;
        free -= size;
      } else remaining.push(index);
    });
    flexible = remaining;
  }
  return sizes;
}

/**
 * Breaks items into lines that fit `available`, in order: an item starts a
 * new line when it would not fit after the ones before it. Each line has at
 * least one item, however wide that is. With `available` null everything is
 * on one line. Returns the indices of the items of each line.
 */
export function breakLines(sizes: readonly number[], available: number | null, gap: number): number[][] {
  if (sizes.length === 0) return [];
  if (available === null) return [sizes.map((_, index) => index)];
  const lines: number[][] = [];
  let line: number[] = [];
  let used = 0;
  sizes.forEach((size, index) => {
    const next = line.length === 0 ? size : used + gap + size;
    // A thousandth of slack, so that sizes that only differ by rounding still fit.
    if (line.length > 0 && next > available + 0.001) {
      lines.push(line);
      line = [index];
      used = size;
    } else {
      line.push(index);
      used = next;
    }
  });
  lines.push(line);
  return lines;
}

/**
 * Where each of a run of sizes starts inside `available`, with `gap` between
 * them: packed at the start, in the middle or at the end, or spread out so
 * that the first is at the start and the last at the end. Spreading needs two
 * or more items and room to spare; otherwise they are packed at the start.
 */
export function placeAlong(sizes: readonly number[], available: number, gap: number, align: FlowAlign): number[] {
  const total = sizes.reduce((sum, size) => sum + size, 0);
  let between = gap;
  let start = 0;
  if (align === 'SPACE_BETWEEN') {
    // Without room to spare, or with a single item, they simply follow one another from the start.
    const spare = available - total;
    between = sizes.length > 1 && spare > 0 ? spare / (sizes.length - 1) : 0;
  } else {
    const content = total + gaps(sizes.length, gap);
    if (align === 'CENTER') start = (available - content) / 2;
    else if (align === 'MAX') start = available - content;
  }
  const offsets: number[] = [];
  let cursor = start;
  for (const size of sizes) {
    offsets.push(cursor);
    cursor += size + between;
  }
  return offsets;
}

/** Where one item starts across a line of size `available`. */
export function placeAcross(size: number, available: number, align: FlowAlign): number {
  if (align === 'CENTER') return (available - size) / 2;
  if (align === 'MAX') return available - size;
  return 0;
}

/**
 * How tall each line of a row is (or how wide each column), across the
 * direction of the layout. A line is as tall as its tallest item; an item
 * that fills counts for its minimum. With `available` given: a row that does
 * not wrap is one line of exactly that size; the lines of one that wraps
 * share any space left over equally when something in them fills, and are
 * otherwise left at their own sizes.
 */
export function lineSizes(
  lines: readonly (readonly number[])[],
  items: readonly FlowItem[],
  available: number | null,
  gap: number,
  wrap: boolean,
): number[] {
  const natural = lines.map((line) =>
    line.reduce((size, index) => {
      const item = items[index] as FlowItem;
      return Math.max(size, item.fill ? item.min : clampSize(item.size, item.min, item.max));
    }, 0),
  );
  if (available === null || lines.length === 0) return natural;
  if (!wrap) return lines.length === 1 ? [available] : natural;
  const spare = available - natural.reduce((sum, size) => sum + size, 0) - gaps(lines.length, gap);
  const anyFill = lines.some((line) => line.some((index) => (items[index] as FlowItem).fill));
  return spare > 0 && anyFill ? natural.map((size) => size + spare / lines.length) : natural;
}

/** The room a run of sizes takes with `gap` between them. */
export function extent(sizes: readonly number[], gap: number): number {
  return sizes.reduce((sum, size) => sum + size, 0) + gaps(sizes.length, gap);
}
