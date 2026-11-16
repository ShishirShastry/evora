import { clearTextLayoutCache, fontString, type TextMeasurer, type TextStyle } from '../../core';
import { BUNDLED_FONT_FAMILY } from './fonts';

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const MAX_CACHE = 20_000;

/** Sets font and letter spacing on a context. Returns false when the context cannot do letter spacing itself. */
export function applyTextStyle(ctx: Ctx, style: TextStyle): boolean {
  ctx.font = fontString(style);
  if ('letterSpacing' in ctx) {
    (ctx as Ctx & { letterSpacing: string }).letterSpacing = `${style.letterSpacing}px`;
    return true;
  }
  return false;
}

/**
 * Measures text with a 2D canvas context, which is exactly how the renderer
 * will paint it, so layout and painting always agree. Widths are cached,
 * because the same words are measured again on every keystroke and resize.
 */
export function createCanvasMeasurer(ctx: Ctx): TextMeasurer & { reset(): void } {
  const widths = new Map<string, number>();
  const metrics = new Map<string, { ascent: number; descent: number }>();

  return {
    width(text, style) {
      if (text === '') return 0;
      const key = `${fontString(style)}|${style.letterSpacing}|${text}`;
      const cached = widths.get(key);
      if (cached !== undefined) return cached;
      const native = applyTextStyle(ctx, style);
      let width = ctx.measureText(text).width;
      if (!native) width += style.letterSpacing * [...text].length;
      if (widths.size >= MAX_CACHE) widths.clear();
      widths.set(key, width);
      return width;
    },
    metrics(style) {
      const key = fontString(style);
      const cached = metrics.get(key);
      if (cached) return cached;
      applyTextStyle(ctx, style);
      const m = ctx.measureText('Hg');
      const result = {
        ascent: m.fontBoundingBoxAscent ?? m.actualBoundingBoxAscent ?? style.fontSize * 0.8,
        descent: m.fontBoundingBoxDescent ?? m.actualBoundingBoxDescent ?? style.fontSize * 0.2,
      };
      metrics.set(key, result);
      return result;
    },
    /** Forgets what was measured: the same text may measure differently once its font has loaded. */
    reset() {
      widths.clear();
      metrics.clear();
    },
  };
}

let shared: { measurer: TextMeasurer & { reset(): void }; ctx: CanvasRenderingContext2D } | null = null;

function sharedContext(): { measurer: TextMeasurer & { reset(): void }; ctx: CanvasRenderingContext2D } | null {
  if (shared) return shared;
  if (typeof document === 'undefined') return null;
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return null;
  shared = { measurer: createCanvasMeasurer(ctx), ctx };
  return shared;
}

/** The one measurer the application uses in the browser, for both sizing and painting. */
export function getBrowserMeasurer(): TextMeasurer | null {
  return sharedContext()?.measurer ?? null;
}

/**
 * Forgets everything measured so far, and with it every text layout and what
 * was found out about which fonts are installed. Called when font faces have
 * finished loading, because a canvas measures text in a fallback font until
 * the real one is there.
 */
export function resetTextMeasurements(): void {
  shared?.measurer.reset();
  availability.clear();
  clearTextLayoutCache();
}

/** Font families offered in the font menu: the one that ships with the application, and these when the machine has them. */
export const FONT_CANDIDATES = [
  BUNDLED_FONT_FAMILY,
  'Arial',
  'Helvetica',
  'Roboto',
  'Segoe UI',
  'Calibri',
  'Verdana',
  'Tahoma',
  'Trebuchet MS',
  'Georgia',
  'Cambria',
  'Times New Roman',
  'Courier New',
  'Consolas',
  'Impact',
  'Comic Sans MS',
];

const availability = new Map<string, boolean>();

/**
 * Whether a font family is installed. A missing family falls back to the
 * generic one, so text set in it measures the same as the generic family
 * alone; an installed one differs from at least one of two generics.
 */
export function isFontAvailable(family: string): boolean {
  // The bundled font is always there, whether or not its faces have been fetched yet.
  if (family === BUNDLED_FONT_FAMILY) return true;
  const known = availability.get(family);
  if (known !== undefined) return known;
  const context = sharedContext();
  if (!context) return true;
  const { ctx } = context;
  const sample = 'mmmmmmmmmmlliWQ@0123456789';
  const widthOf = (font: string): number => {
    ctx.font = `72px ${font}`;
    return ctx.measureText(sample).width;
  };
  const quoted = `"${family.replace(/"/g, '')}"`;
  const available = ['monospace', 'serif'].some((generic) => widthOf(`${quoted}, ${generic}`) !== widthOf(generic));
  availability.set(family, available);
  return available;
}

/** The candidate families that are installed, always including `current`. */
export function availableFonts(current?: string): string[] {
  const fonts = FONT_CANDIDATES.filter(isFontAvailable);
  if (current && !fonts.includes(current)) fonts.unshift(current);
  return fonts;
}
