import type { RGB } from './document/schema';

/**
 * Colour conversions for the colour picker. Channels of `RGB` are 0..1, as
 * they are in the document. Hue is in degrees, 0..360; saturation, value
 * (brightness) and lightness are 0..1.
 */

export interface HSV {
  h: number;
  s: number;
  v: number;
}

export interface HSL {
  h: number;
  s: number;
  l: number;
}

/** The hue of a colour in degrees, or 0 for a grey, which has none. */
function hueOf(c: RGB, max: number, delta: number): number {
  if (delta === 0) return 0;
  let h: number;
  if (max === c.r) h = ((c.g - c.b) / delta) % 6;
  else if (max === c.g) h = (c.b - c.r) / delta + 2;
  else h = (c.r - c.g) / delta + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

export function rgbToHsv(c: RGB): HSV {
  const max = Math.max(c.r, c.g, c.b);
  const delta = max - Math.min(c.r, c.g, c.b);
  return { h: hueOf(c, max, delta), s: max === 0 ? 0 : delta / max, v: max };
}

/** The colour at a point on the hue circle, before saturation and brightness are applied. */
function fromHue(h: number, chroma: number): RGB {
  const sector = (((h % 360) + 360) % 360) / 60;
  const x = chroma * (1 - Math.abs((sector % 2) - 1));
  if (sector < 1) return { r: chroma, g: x, b: 0 };
  if (sector < 2) return { r: x, g: chroma, b: 0 };
  if (sector < 3) return { r: 0, g: chroma, b: x };
  if (sector < 4) return { r: 0, g: x, b: chroma };
  if (sector < 5) return { r: x, g: 0, b: chroma };
  return { r: chroma, g: 0, b: x };
}

const clamp = (v: number): number => Math.min(1, Math.max(0, v));

export function hsvToRgb({ h, s, v }: HSV): RGB {
  const chroma = clamp(v) * clamp(s);
  const base = fromHue(h, chroma);
  const m = clamp(v) - chroma;
  return { r: clamp(base.r + m), g: clamp(base.g + m), b: clamp(base.b + m) };
}

export function rgbToHsl(c: RGB): HSL {
  const max = Math.max(c.r, c.g, c.b);
  const min = Math.min(c.r, c.g, c.b);
  const delta = max - min;
  const l = (max + min) / 2;
  return { h: hueOf(c, max, delta), s: delta === 0 ? 0 : delta / (1 - Math.abs(2 * l - 1)), l };
}

export function hslToRgb({ h, s, l }: HSL): RGB {
  const chroma = (1 - Math.abs(2 * clamp(l) - 1)) * clamp(s);
  const base = fromHue(h, chroma);
  const m = clamp(l) - chroma / 2;
  return { r: clamp(base.r + m), g: clamp(base.g + m), b: clamp(base.b + m) };
}
