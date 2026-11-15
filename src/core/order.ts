import { generateNKeysBetween } from 'fractional-indexing';

/**
 * Generates `count` order keys that sort strictly between `lower` and `upper`
 * (`null` means "no bound"). Returns `null` when the bounds are unusable, for
 * example equal or reversed keys, so the caller can re-key the siblings.
 */
export function keysBetween(lower: string | null, upper: string | null, count: number): string[] | null {
  if (count <= 0) return [];
  if (lower !== null && upper !== null && lower >= upper) return null;
  try {
    return generateNKeysBetween(lower, upper, count);
  } catch {
    return null;
  }
}

/** Generates `count` evenly spread keys for a fresh list of siblings. */
export function freshKeys(count: number): string[] {
  return count <= 0 ? [] : generateNKeysBetween(null, null, count);
}
