/**
 * Shadows for a vector PDF. PDF cannot blur, so a layer's drop shadows are
 * a picture made by the editor's renderer and laid under the layer's
 * vectors. The renderer draws a layer and its shadows together, so the
 * shadows alone are worked out from two pictures of the layer, one with its
 * shadows and one without: where the layer is (A) over its shadow (S),
 * A = L + S × (1 − alpha of L), with colours weighted by their alpha, so
 * S = (A − L) / (1 − alpha of L). Where the layer is solid the shadow cannot
 * be seen and is left empty. Laid under the layer, the shadow found this way
 * gives back the picture with shadows, to within a step of rounding.
 */

/** The shadow alone, from pictures of a layer with and without its shadows (red, green, blue, alpha for each pixel, not weighted by alpha). */
export function separateShadow(withShadow: ArrayLike<number>, without: ArrayLike<number>): Uint8ClampedArray {
  const out = new Uint8ClampedArray(withShadow.length);
  for (let i = 0; i + 3 < withShadow.length; i += 4) {
    const aA = (withShadow[i + 3] as number) / 255;
    const aL = (without[i + 3] as number) / 255;
    const rest = 1 - aL;
    if (rest <= 1e-6) continue;
    const alpha = Math.min(1, Math.max(0, (aA - aL) / rest));
    if (alpha <= 0) continue;
    for (let c = 0; c < 3; c++) {
      // Colours weighted by alpha, as they add up when one is laid over the other.
      const shadow = (((withShadow[i + c] as number) / 255) * aA - ((without[i + c] as number) / 255) * aL) / rest;
      out[i + c] = Math.round((Math.min(alpha, Math.max(0, shadow)) / alpha) * 255);
    }
    out[i + 3] = Math.round(alpha * 255);
  }
  return out;
}
