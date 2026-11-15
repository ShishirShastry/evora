import { describe, expect, it } from 'vitest';
import { hslToRgb, hsvToRgb, rgbToHsl, rgbToHsv, type RGB } from './core';

const rgb = (r: number, g: number, b: number): RGB => ({ r: r / 255, g: g / 255, b: b / 255 });
const bytes = (c: RGB): number[] => [Math.round(c.r * 255), Math.round(c.g * 255), Math.round(c.b * 255)];

describe('colour conversions', () => {
  it('reads hue, saturation and brightness from a colour', () => {
    expect(rgbToHsv(rgb(255, 0, 0))).toEqual({ h: 0, s: 1, v: 1 });
    expect(rgbToHsv(rgb(0, 255, 0))).toEqual({ h: 120, s: 1, v: 1 });
    expect(rgbToHsv(rgb(0, 0, 255))).toEqual({ h: 240, s: 1, v: 1 });
    expect(rgbToHsv(rgb(255, 0, 255)).h).toBe(300);
    // A grey has no hue and no saturation; black has no brightness either.
    expect(rgbToHsv(rgb(128, 128, 128))).toEqual({ h: 0, s: 0, v: 128 / 255 });
    expect(rgbToHsv(rgb(0, 0, 0))).toEqual({ h: 0, s: 0, v: 0 });
    const olive = rgbToHsv(rgb(128, 128, 0));
    expect(olive.h).toBe(60);
    expect(olive.s).toBe(1);
    expect(olive.v).toBeCloseTo(0.502, 3);
  });

  it('makes a colour from hue, saturation and brightness', () => {
    expect(bytes(hsvToRgb({ h: 0, s: 1, v: 1 }))).toEqual([255, 0, 0]);
    expect(bytes(hsvToRgb({ h: 60, s: 1, v: 1 }))).toEqual([255, 255, 0]);
    expect(bytes(hsvToRgb({ h: 120, s: 0.5, v: 0.5 }))).toEqual([64, 128, 64]);
    expect(bytes(hsvToRgb({ h: 210, s: 0.25, v: 0.8 }))).toEqual([153, 179, 204]);
    // Hue goes round: 360 is 0, and a negative hue counts back from it.
    expect(bytes(hsvToRgb({ h: 360, s: 1, v: 1 }))).toEqual([255, 0, 0]);
    expect(bytes(hsvToRgb({ h: -60, s: 1, v: 1 }))).toEqual([255, 0, 255]);
    // Values outside their range are brought back into it.
    expect(bytes(hsvToRgb({ h: 0, s: 3, v: 2 }))).toEqual([255, 0, 0]);
  });

  it('goes to hue, saturation and lightness and back', () => {
    expect(rgbToHsl(rgb(255, 0, 0))).toEqual({ h: 0, s: 1, l: 0.5 });
    expect(rgbToHsl(rgb(255, 255, 255))).toEqual({ h: 0, s: 0, l: 1 });
    const steel = rgbToHsl(rgb(70, 130, 180));
    expect(Math.round(steel.h)).toBe(207);
    expect(Math.round(steel.s * 100)).toBe(44);
    expect(Math.round(steel.l * 100)).toBe(49);
    expect(bytes(hslToRgb({ h: 120, s: 1, l: 0.5 }))).toEqual([0, 255, 0]);
    expect(bytes(hslToRgb({ h: 120, s: 1, l: 0.25 }))).toEqual([0, 128, 0]);
    expect(bytes(hslToRgb({ h: 0, s: 0, l: 0.5 }))).toEqual([128, 128, 128]);
  });

  it('comes back to the colour it started from, whichever way round', () => {
    for (const [r, g, b] of [
      [217, 217, 217],
      [25, 194, 179],
      [255, 122, 122],
      [1, 2, 3],
      [250, 128, 7],
      [0, 0, 0],
      [255, 255, 255],
    ] as const) {
      const colour = rgb(r, g, b);
      expect(bytes(hsvToRgb(rgbToHsv(colour)))).toEqual([r, g, b]);
      expect(bytes(hslToRgb(rgbToHsl(colour)))).toEqual([r, g, b]);
    }
  });
});
