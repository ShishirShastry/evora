import { patchNodes } from '../document/mutate';
import type { Document, LayerPatch, NodeId, RGB, TextDecoration, TextNode, TextRangeStyle, TextStyleRange } from '../document/schema';
import type { TextStyle } from './layout';

/**
 * Styles on part of a text layer. A layer has one style of its own; a range
 * of its characters can differ from it in font, size, weight, slant, letter
 * spacing, decoration and colour. Ranges are kept in one form everywhere:
 * in order, not overlapping, not empty, inside the text, each changing at
 * least one thing, and no two neighbours alike. Positions count UTF-16 code
 * units, as string indices do.
 */

/** What a range can change, in the order the keys are stored. */
export const RANGE_STYLE_KEYS = ['fontFamily', 'fontSize', 'fontWeight', 'italic', 'letterSpacing', 'textDecoration', 'color'] as const;
export type RangeStyleKey = (typeof RANGE_STYLE_KEYS)[number];

/** The style one character is drawn in. `color` is null where the layer's own fills paint the glyphs. */
export interface CharacterStyle extends TextStyle {
  textDecoration: TextDecoration;
  color: RGB | null;
}

/** A change to make to a range: values to set, and null for a colour to take away again. */
export type RangeStylePatch = Omit<TextRangeStyle, 'color'> & { color?: RGB | null };

type BaseStyle = Pick<TextNode, 'fontFamily' | 'fontSize' | 'fontWeight' | 'italic' | 'letterSpacing' | 'textDecoration'>;

/** The layer's own style, which every character has unless a range says otherwise. */
export function baseCharacterStyle(node: BaseStyle): CharacterStyle {
  return {
    fontFamily: node.fontFamily,
    fontSize: node.fontSize,
    fontWeight: node.fontWeight,
    italic: node.italic,
    letterSpacing: node.letterSpacing,
    textDecoration: node.textDecoration,
    color: null,
  };
}

/** The layer's style with a range's changes applied. */
export function rangeCharacterStyle(node: BaseStyle, range: TextRangeStyle): CharacterStyle {
  const base = baseCharacterStyle(node);
  return {
    fontFamily: range.fontFamily ?? base.fontFamily,
    fontSize: range.fontSize ?? base.fontSize,
    fontWeight: range.fontWeight ?? base.fontWeight,
    italic: range.italic ?? base.italic,
    letterSpacing: range.letterSpacing ?? base.letterSpacing,
    textDecoration: range.textDecoration ?? base.textDecoration,
    color: range.color ?? null,
  };
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
    const p = a as RGB;
    const q = b as RGB;
    return p.r === q.r && p.g === q.g && p.b === q.b;
  }
  return false;
}

function sameOverrides(a: TextRangeStyle, b: TextRangeStyle): boolean {
  return RANGE_STYLE_KEYS.every((key) => sameValue(a[key], b[key]));
}

/** One range, with its keys in the stored order and nothing undefined. Null when it changes nothing or covers nothing. */
function tidyRange(start: number, end: number, style: RangeStylePatch): TextStyleRange | null {
  if (end <= start) return null;
  const range: TextStyleRange = { start, end };
  let any = false;
  for (const key of RANGE_STYLE_KEYS) {
    const value = style[key];
    if (value === undefined || value === null) continue;
    const color = value as RGB;
    (range as unknown as Record<string, unknown>)[key] = key === 'color' ? { r: color.r, g: color.g, b: color.b } : value;
    any = true;
  }
  return any ? range : null;
}

/**
 * Flattens ranges that may overlap, be out of order or reach outside the
 * text. Where two overlap, the later one's values win, and a null takes a
 * value away. Neighbours that end up alike are joined.
 */
function flatten(ranges: readonly (RangeStylePatch & { start: number; end: number })[], length: number): TextStyleRange[] {
  const clamp = (value: number): number => Math.min(length, Math.max(0, Math.round(Number.isFinite(value) ? value : 0)));
  const spans = ranges.map((range) => ({ range, start: clamp(range.start), end: clamp(range.end) })).filter((span) => span.end > span.start);
  if (spans.length === 0) return [];
  const cuts = [...new Set(spans.flatMap((span) => [span.start, span.end]))].sort((a, b) => a - b);
  const out: TextStyleRange[] = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const start = cuts[i] as number;
    const end = cuts[i + 1] as number;
    const style: RangeStylePatch = {};
    for (const span of spans) {
      if (span.start > start || span.end < end) continue;
      for (const key of RANGE_STYLE_KEYS) {
        const value = span.range[key];
        if (value !== undefined) (style as Record<string, unknown>)[key] = value;
      }
    }
    const piece = tidyRange(start, end, style);
    if (!piece) continue;
    const last = out[out.length - 1];
    if (last && last.end === piece.start && sameOverrides(last, piece)) out[out.length - 1] = { ...last, end: piece.end };
    else out.push(piece);
  }
  return out;
}

/** Ranges in their one stored form, for text of a given length. */
export function normalizeRanges(ranges: readonly TextStyleRange[], length: number): TextStyleRange[] {
  return flatten(ranges, length);
}

/** Are these ranges already in their stored form for text of this length? */
export function rangesAreNormal(ranges: readonly TextStyleRange[], length: number): boolean {
  let previous: TextStyleRange | null = null;
  for (const range of ranges) {
    if (!Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start < 0 || range.end > length || range.end <= range.start) return false;
    if (!RANGE_STYLE_KEYS.some((key) => range[key] !== undefined)) return false;
    if (previous && (range.start < previous.end || (range.start === previous.end && sameOverrides(previous, range)))) return false;
    previous = range;
  }
  return true;
}

/**
 * The ranges after `removed` characters at `at` have been replaced by
 * `inserted` new ones. New characters take the style of the character before
 * them, or at the very start of the text of the one after them, as typing
 * does everywhere.
 */
export function spliceRanges(ranges: readonly TextStyleRange[], at: number, removed: number, inserted: number, length: number): TextStyleRange[] {
  const delta = inserted - removed;
  const after = at + removed;
  const moved: TextStyleRange[] = [];
  for (const range of ranges) {
    const joins = inserted > 0 && (at > 0 ? range.start < at && range.end >= at : range.start <= removed && range.end > removed);
    const start = range.start < at ? range.start : joins ? at : Math.max(range.start, after) + delta;
    const end = range.end > after ? range.end + delta : joins ? at + inserted : Math.min(range.end, at);
    if (end > start) moved.push({ ...range, start, end });
  }
  return flatten(moved, length);
}

/**
 * The ranges of a layer after part of it has been restyled. A value that is
 * what the layer has anyway is not kept as a change, so setting a word back
 * to the layer's own size leaves no trace.
 */
export function styleRange(node: TextNode, start: number, end: number, patch: RangeStylePatch): TextStyleRange[] {
  const base = baseCharacterStyle(node);
  const flattened = flatten([...node.styleRanges, { ...patch, start, end }], node.characters.length);
  const out: TextStyleRange[] = [];
  for (const range of flattened) {
    const style: RangeStylePatch = {};
    for (const key of RANGE_STYLE_KEYS) {
      const value = range[key];
      if (value === undefined || (key !== 'color' && value === base[key])) continue;
      (style as Record<string, unknown>)[key] = value;
    }
    const piece = tidyRange(range.start, range.end, style);
    if (!piece) continue;
    const last = out[out.length - 1];
    if (last && last.end === piece.start && sameOverrides(last, piece)) out[out.length - 1] = { ...last, end: piece.end };
    else out.push(piece);
  }
  return out;
}

/** The ranges with some kinds of change taken out everywhere, as when the whole layer is given a new value for them. */
export function withoutRangeKeys(ranges: readonly TextStyleRange[], keys: readonly RangeStyleKey[], length: number): TextStyleRange[] {
  return flatten(
    ranges.map((range) => {
      const next: RangeStylePatch & { start: number; end: number } = { ...range };
      for (const key of keys) delete next[key];
      return next;
    }),
    length,
  );
}

/**
 * The styles found between two positions, one for each stretch that differs.
 * For a caret (start equal to end) it is the style typing there would get.
 */
export function stylesBetween(node: TextNode, start: number, end: number): CharacterStyle[] {
  const base = baseCharacterStyle(node);
  if (end <= start) {
    const at = start > 0 ? start - 1 : 0;
    const range = node.styleRanges.find((r) => r.start <= at && r.end > at);
    return [range ? rangeCharacterStyle(node, range) : base];
  }
  const styles: CharacterStyle[] = [];
  let cursor = start;
  for (const range of node.styleRanges) {
    if (range.end <= start || range.start >= end) continue;
    if (range.start > cursor) styles.push(base);
    styles.push(rangeCharacterStyle(node, range));
    cursor = range.end;
  }
  if (cursor < end) styles.push(base);
  return styles;
}

/** Where two strings differ: what to remove from the first, and what to put there, to get the second. */
export function textDifference(before: string, after: string): { at: number; removed: number; inserted: string } {
  const limit = Math.min(before.length, after.length);
  let head = 0;
  while (head < limit && before[head] === after[head]) head++;
  let tail = 0;
  while (tail < limit - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
  return { at: head, removed: before.length - head - tail, inserted: after.slice(head, after.length - tail) };
}

/** Replaces part of a text layer's characters, keeping its styled ranges on the characters they were on. */
export function replaceText(doc: Document, id: NodeId, start: number, end: number, text: string): Document {
  const node = doc.nodes[id];
  if (!node || node.type !== 'TEXT') return doc;
  const from = Math.min(node.characters.length, Math.max(0, Math.min(start, end)));
  const to = Math.min(node.characters.length, Math.max(start, end));
  if (from === to && text === '') return doc;
  const characters = node.characters.slice(0, from) + text + node.characters.slice(to);
  const styleRanges = spliceRanges(node.styleRanges, from, to - from, text.length, characters.length);
  return patchNodes(doc, { [id]: { characters, styleRanges } });
}

/** Gives a text layer new characters, working out what changed so that styled ranges stay on their characters. */
export function setTextCharacters(doc: Document, id: NodeId, characters: string): Document {
  const node = doc.nodes[id];
  if (!node || node.type !== 'TEXT' || node.characters === characters) return doc;
  const change = textDifference(node.characters, characters);
  return replaceText(doc, id, change.at, change.at + change.removed, change.inserted);
}

/** Restyles part of a text layer. */
export function styleTextRange(doc: Document, id: NodeId, start: number, end: number, patch: RangeStylePatch): Document {
  const node = doc.nodes[id];
  if (!node || node.type !== 'TEXT') return doc;
  const from = Math.max(0, Math.min(start, end));
  const to = Math.min(node.characters.length, Math.max(start, end));
  if (to <= from) return doc;
  return patchNodes(doc, { [id]: { styleRanges: styleRange(node, from, to, patch) } });
}

const LAYER_KEYS: readonly Exclude<RangeStyleKey, 'color'>[] = ['fontFamily', 'fontSize', 'fontWeight', 'italic', 'letterSpacing', 'textDecoration'];

/**
 * Changes text layers as a whole. A value given to the whole layer also
 * replaces what any of its ranges had for it: choosing a size for a layer
 * makes all of its text that size. New fills likewise replace the colours of
 * ranges.
 */
export function setTextStyle(doc: Document, ids: readonly NodeId[], patch: LayerPatch): Document {
  const cleared: RangeStyleKey[] = LAYER_KEYS.filter((key) => patch[key] !== undefined);
  if (patch.fills !== undefined) cleared.push('color');
  const patches: Record<NodeId, LayerPatch> = {};
  for (const id of ids) {
    const node = doc.nodes[id];
    if (!node || node.type !== 'TEXT') continue;
    const next: LayerPatch = { ...patch };
    if (cleared.length > 0 && node.styleRanges.length > 0) next.styleRanges = withoutRangeKeys(node.styleRanges, cleared, node.characters.length);
    patches[id] = next;
  }
  return patchNodes(doc, patches);
}

/**
 * Keeps the ranges of text layers that have changed inside their text: a
 * layer whose characters were replaced by something shorter cannot keep a
 * range that reaches past the end. Run after every change, like the fitting
 * of text boxes.
 */
export function fitTextRanges(previous: Document, doc: Document): Document {
  if (previous.nodes === doc.nodes) return doc;
  const patches: Record<NodeId, LayerPatch> = {};
  for (const id in doc.nodes) {
    const node = doc.nodes[id];
    if (!node || node.type !== 'TEXT' || node === previous.nodes[id] || node.styleRanges.length === 0) continue;
    if (!rangesAreNormal(node.styleRanges, node.characters.length)) patches[id] = { styleRanges: normalizeRanges(node.styleRanges, node.characters.length) };
  }
  return patchNodes(doc, patches);
}
