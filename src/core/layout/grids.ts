import type { LayoutGrid } from '../document/schema';
import type { Rect } from '../math/geometry';

/**
 * The columns or rows of a layout grid as rectangles in the frame's local
 * space, or for a uniform grid the positions of its lines.
 */
export interface GridGeometry {
  /** Columns (full height) or rows (full width). Empty for a uniform grid. */
  bands: Rect[];
  /** Vertical line positions (x) of a uniform grid. */
  xs: number[];
  /** Horizontal line positions (y) of a uniform grid. */
  ys: number[];
}

/** Starts and size of `count` sections laid out along a length of `total`. */
function sections(grid: LayoutGrid, total: number): { starts: number[]; size: number } {
  const count = Math.max(1, Math.round(grid.count));
  const gutter = Math.max(0, grid.gutter);
  let size: number;
  let first: number;
  if (grid.alignment === 'STRETCH') {
    // The offset is a margin on both sides; the sections share what is left.
    size = Math.max(0, (total - grid.offset * 2 - gutter * (count - 1)) / count);
    first = grid.offset;
  } else {
    size = Math.max(0, grid.sectionSize);
    const block = count * size + (count - 1) * gutter;
    first = grid.alignment === 'MIN' ? grid.offset : grid.alignment === 'MAX' ? total - grid.offset - block : (total - block) / 2;
  }
  const starts: number[] = [];
  for (let i = 0; i < count; i++) starts.push(first + i * (size + gutter));
  return { starts, size };
}

/** Where a layout grid's columns, rows or lines fall in a frame of the given size. */
export function layoutGridGeometry(grid: LayoutGrid, width: number, height: number): GridGeometry {
  const out: GridGeometry = { bands: [], xs: [], ys: [] };
  if (width <= 0 || height <= 0) return out;
  if (grid.pattern === 'GRID') {
    const step = Math.max(1, grid.size);
    for (let x = step; x < width; x += step) out.xs.push(x);
    for (let y = step; y < height; y += step) out.ys.push(y);
    return out;
  }
  if (grid.pattern === 'COLUMNS') {
    const { starts, size } = sections(grid, width);
    for (const x of starts) out.bands.push({ x, y: 0, width: size, height });
  } else {
    const { starts, size } = sections(grid, height);
    for (const y of starts) out.bands.push({ x: 0, y, width, height: size });
  }
  return out;
}

/**
 * The positions things can snap to in a layout grid: the edges of its
 * columns or rows, or the lines of a uniform grid. Local to the frame.
 */
export function layoutGridSnapLines(grid: LayoutGrid, width: number, height: number): { xs: number[]; ys: number[] } {
  const geometry = layoutGridGeometry(grid, width, height);
  if (grid.pattern === 'GRID') return { xs: geometry.xs, ys: geometry.ys };
  const xs: number[] = [];
  const ys: number[] = [];
  for (const band of geometry.bands) {
    if (grid.pattern === 'COLUMNS') xs.push(band.x, band.x + band.width);
    else ys.push(band.y, band.y + band.height);
  }
  return { xs, ys };
}
