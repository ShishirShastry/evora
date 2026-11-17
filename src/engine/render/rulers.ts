import type { Guide, PlacedGuide, Rect } from '../../core';
import type { Size, Viewport } from '../viewport';

/** Thickness of the rulers along the top and left edges of the canvas, in screen pixels. */
export const RULER_SIZE = 20;

/** The rulers are part of the application's chrome, so they follow its theme. */
export type RulerTheme = 'dark' | 'light';
const RULER_COLORS: Record<RulerTheme, { background: string; line: string; text: string }> = {
  dark: { background: '#141415', line: '#27272b', text: '#a0a0a8' },
  light: { background: '#ffffff', line: '#e2e2e7', text: '#66666f' },
};
const RULER_SELECTION = 'rgba(13, 153, 255, 0.28)';
export const GUIDE_COLOR = '#4aa8ff';
const RULER_FONT = '10px Inter, "Segoe UI", system-ui, sans-serif';
/** Labelled ticks are at least this far apart on screen. */
const MIN_LABEL_SPACING_PX = 64;

/** The smallest "round" number (1, 2 or 5 times a power of ten) that is at least `minimum`. */
export function niceStep(minimum: number): number {
  if (!(minimum > 0) || !Number.isFinite(minimum)) return 1;
  let power = 10 ** Math.floor(Math.log10(minimum));
  for (;;) {
    for (const multiple of [1, 2, 5]) {
      const step = multiple * power;
      if (step >= minimum * (1 - 1e-9)) return step;
    }
    power *= 10;
  }
}

export interface RulerTick {
  /** Page coordinate of the tick. */
  value: number;
  /** Distance from the start of the canvas, in screen pixels. */
  position: number;
  /** Labelled ticks are major; the ones between them are not. */
  major: boolean;
}

/**
 * The ticks of one ruler: where page coordinates fall along `length` screen
 * pixels of canvas that starts at page coordinate `start`. Major ticks sit on
 * round numbers far enough apart to label, with four minor ticks between each.
 */
export function rulerTicks(start: number, zoom: number, length: number): RulerTick[] {
  const step = niceStep(MIN_LABEL_SPACING_PX / zoom);
  const minor = step / 5;
  const ticks: RulerTick[] = [];
  const first = Math.floor(start / minor);
  const last = Math.ceil((start + length / zoom) / minor);
  for (let i = first; i <= last; i++) {
    // Derive each value from its index so rounding error cannot build up along the ruler.
    const value = Math.round(i * minor * 1e6) / 1e6;
    ticks.push({ value, position: (value - start) * zoom, major: i % 5 === 0 });
  }
  return ticks;
}

export interface RulerInput {
  viewport: Viewport;
  size: Size;
  guides: readonly Guide[];
  /** Page-space bounds of the selection, highlighted on both rulers. */
  selection: Rect | null;
  /** Dark unless told otherwise. */
  theme?: RulerTheme;
}

function formatValue(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/** Draws the page's guides across the whole canvas. Expects a context scaled to CSS pixels. */
export function drawGuides(ctx: CanvasRenderingContext2D, input: Pick<RulerInput, 'viewport' | 'size' | 'guides'>): void {
  if (input.guides.length === 0) return;
  const { viewport, size } = input;
  ctx.strokeStyle = GUIDE_COLOR;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const guide of input.guides) {
    if (guide.axis === 'X') {
      const x = Math.round((guide.position - viewport.x) * viewport.zoom) + 0.5;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, size.height);
    } else {
      const y = Math.round((guide.position - viewport.y) * viewport.zoom) + 0.5;
      ctx.moveTo(0, y);
      ctx.lineTo(size.width, y);
    }
  }
  ctx.stroke();
}

/** Draws the guides of frames, each a line across its frame and no further. Expects a context scaled to CSS pixels. */
export function drawFrameGuides(ctx: CanvasRenderingContext2D, viewport: Viewport, guides: readonly PlacedGuide[]): void {
  if (guides.length === 0) return;
  ctx.strokeStyle = GUIDE_COLOR;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const guide of guides) {
    if (guide.axis === 'X') {
      const x = Math.round((guide.position - viewport.x) * viewport.zoom) + 0.5;
      ctx.moveTo(x, (guide.from - viewport.y) * viewport.zoom);
      ctx.lineTo(x, (guide.to - viewport.y) * viewport.zoom);
    } else {
      const y = Math.round((guide.position - viewport.y) * viewport.zoom) + 0.5;
      ctx.moveTo((guide.from - viewport.x) * viewport.zoom, y);
      ctx.lineTo((guide.to - viewport.x) * viewport.zoom, y);
    }
  }
  ctx.stroke();
}

/** Draws the rulers along the top and left edges. Expects a context scaled to CSS pixels. */
export function drawRulers(ctx: CanvasRenderingContext2D, input: RulerInput): void {
  const { viewport, size, selection } = input;
  const R = RULER_SIZE;
  const colors = RULER_COLORS[input.theme ?? 'dark'];

  ctx.fillStyle = colors.background;
  ctx.fillRect(0, 0, size.width, R);
  ctx.fillRect(0, 0, R, size.height);

  if (selection) {
    ctx.fillStyle = RULER_SELECTION;
    const x0 = Math.max(R, (selection.x - viewport.x) * viewport.zoom);
    const x1 = Math.min(size.width, (selection.x + selection.width - viewport.x) * viewport.zoom);
    if (x1 > x0) ctx.fillRect(x0, 0, x1 - x0, R);
    const y0 = Math.max(R, (selection.y - viewport.y) * viewport.zoom);
    const y1 = Math.min(size.height, (selection.y + selection.height - viewport.y) * viewport.zoom);
    if (y1 > y0) ctx.fillRect(0, y0, R, y1 - y0);
  }

  ctx.strokeStyle = colors.line;
  ctx.fillStyle = colors.text;
  ctx.lineWidth = 1;
  ctx.font = RULER_FONT;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';

  ctx.beginPath();
  for (const tick of rulerTicks(viewport.x, viewport.zoom, size.width)) {
    if (tick.position < R) continue;
    const x = Math.round(tick.position) + 0.5;
    ctx.moveTo(x, tick.major ? R - 9 : R - 4);
    ctx.lineTo(x, R);
    if (tick.major) ctx.fillText(formatValue(tick.value), x + 3, 10);
  }
  for (const tick of rulerTicks(viewport.y, viewport.zoom, size.height)) {
    if (tick.position < R) continue;
    const y = Math.round(tick.position) + 0.5;
    ctx.moveTo(tick.major ? R - 9 : R - 4, y);
    ctx.lineTo(R, y);
    if (tick.major) {
      // Vertical ruler labels read bottom to top.
      ctx.save();
      ctx.translate(10, y - 3);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText(formatValue(tick.value), 0, 0);
      ctx.restore();
    }
  }
  // The edges of the rulers.
  ctx.moveTo(R, R + 0.5);
  ctx.lineTo(size.width, R + 0.5);
  ctx.moveTo(R + 0.5, R);
  ctx.lineTo(R + 0.5, size.height);
  ctx.stroke();

  // The corner where the two rulers meet.
  ctx.fillStyle = colors.background;
  ctx.fillRect(0, 0, R, R);
}
