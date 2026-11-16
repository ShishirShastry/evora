import { patchNodes } from '../document/mutate';
import type { Document, LayerPatch, NodeId, TextNode } from '../document/schema';
import { rotatePoint } from '../math/geometry';
import { clean } from '../ops/transform';
import { baseCharacterStyle, rangeCharacterStyle, type CharacterStyle } from './ranges';

/** The font properties that decide how wide a run of text is. */
export interface TextStyle {
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  italic: boolean;
  letterSpacing: number;
}

/**
 * Measures text. The core cannot touch a canvas, so whoever lays text out
 * supplies this: the browser uses a 2D canvas context, tests use a fixed
 * formula. The same measurer must be used for sizing and for painting.
 */
export interface TextMeasurer {
  /** Advance width of `text` in pixels, including letter spacing. */
  width(text: string, style: TextStyle): number;
  /** Distance from the baseline to the top and bottom of the font's line box. */
  metrics(style: TextStyle): { ascent: number; descent: number };
}

/** A stretch of one line that is drawn in one style. */
export interface TextRun {
  /** The characters as they are displayed. */
  text: string;
  /** Left edge inside the layer's box. */
  x: number;
  width: number;
  style: CharacterStyle;
}

export interface TextLine {
  text: string;
  width: number;
  /** Left edge of the line inside the layer's box. */
  x: number;
  /** Baseline of the line inside the layer's box. */
  baseline: number;
  /** Top of the line's box inside the layer's box, and how tall it is. */
  top: number;
  height: number;
  /** The line's text in the stretches it is drawn in, left to right. */
  runs: TextRun[];
  /** The bullet or number of a list item, on the item's first line. */
  marker: TextRun | null;
}

export interface TextLayout {
  lines: TextLine[];
  /** Width of the widest line, with the space a list's markers take. */
  width: number;
  /** Height of all lines. */
  height: number;
  /** The line height of text in the layer's own style. */
  lineHeight: number;
  /** How far a list's text is set in from the left to make room for its markers; 0 without a list. */
  indent: number;
}

/** Fallbacks appended to every family so text is never invisible when a font is missing. */
export const FONT_FALLBACK = 'Arial, Helvetica, sans-serif';

/** The CSS font shorthand for a style, as canvas and DOM both understand it. */
export function fontString(style: Pick<TextStyle, 'fontFamily' | 'fontSize' | 'fontWeight' | 'italic'>): string {
  const family = /^[a-zA-Z0-9-]+$/.test(style.fontFamily) ? style.fontFamily : `"${style.fontFamily.replace(/"/g, '')}"`;
  return `${style.italic ? 'italic ' : ''}${style.fontWeight} ${style.fontSize}px ${family}, ${FONT_FALLBACK}`;
}

export function resolveLineHeight(node: Pick<TextNode, 'lineHeight' | 'fontSize'>): number {
  return node.lineHeight ?? Math.round(node.fontSize * 1.2);
}

/**
 * The characters as they are displayed, after the text-case setting, and for
 * each position in the original where it is in what is displayed (changing
 * case can change how long a string is: "ß" in capitals is "SS").
 */
function displayed(node: Pick<TextNode, 'characters' | 'textCase'>): { text: string; starts: number[] | null } {
  const chars = node.characters;
  if (node.textCase === 'ORIGINAL') return { text: chars, starts: null };
  const starts: number[] = new Array<number>(chars.length + 1);
  let text = '';
  // Title case: a letter is capitalised at the start, and after a space or a hyphen.
  let wordStart = true;
  for (let i = 0; i < chars.length; ) {
    const char = String.fromCodePoint(chars.codePointAt(i) as number);
    let shown = char;
    if (node.textCase === 'UPPER') shown = char.toUpperCase();
    else if (node.textCase === 'LOWER') shown = char.toLowerCase();
    else if (wordStart && /\p{L}/u.test(char)) shown = char.toUpperCase();
    for (let k = 0; k < char.length; k++) starts[i + k] = text.length;
    text += shown;
    wordStart = /[\s-]/.test(char);
    i += char.length;
  }
  starts[chars.length] = text.length;
  return { text, starts };
}

/** The characters as they are displayed, after the text-case setting. */
export function displayText(node: Pick<TextNode, 'characters' | 'textCase'>): string {
  return displayed(node).text;
}

/** A piece of text in one style. */
interface Part {
  text: string;
  style: CharacterStyle;
}

/** A word, or the spaces between two words. */
interface Token {
  space: boolean;
  parts: Part[];
}

/** Joins neighbouring pieces that are in the same style, so each stretch is measured and drawn as one string. */
function merged(parts: readonly Part[]): Part[] {
  const out: Part[] = [];
  for (const part of parts) {
    const last = out[out.length - 1];
    if (last && last.style === part.style) out[out.length - 1] = { text: last.text + part.text, style: part.style };
    else out.push(part);
  }
  return out;
}

function widthOf(parts: readonly Part[], measurer: TextMeasurer): number {
  let width = 0;
  for (const part of merged(parts)) width += measurer.width(part.text, part.style);
  return width;
}

const partsOf = (tokens: readonly Token[]): Part[] => tokens.flatMap((token) => token.parts);

/** Breaks one paragraph into lines no wider than `maxWidth`, at spaces where possible. */
function wrapParagraph(tokens: readonly Token[], maxWidth: number, measurer: TextMeasurer): Token[][] {
  if (tokens.length === 0 || widthOf(partsOf(tokens), measurer) <= maxWidth) return [[...tokens]];
  const lines: Token[][] = [];
  let line: Token[] = [];
  const pushLine = (): void => {
    // Spaces at the end of a line may hang past the edge; they are not part of the line.
    while (line.length > 0 && (line[line.length - 1] as Token).space) line.pop();
    lines.push(line);
    line = [];
  };
  for (const token of tokens) {
    if (widthOf([...partsOf(line), ...token.parts], measurer) <= maxWidth || (token.space && line.length > 0)) {
      line.push(token);
      continue;
    }
    if (line.length > 0) pushLine();
    if (token.space) continue;
    if (widthOf(token.parts, measurer) <= maxWidth) {
      line = [token];
      continue;
    }
    // A single word wider than the box is broken between characters.
    for (const part of token.parts) {
      for (const char of part.text) {
        const piece: Part = { text: char, style: part.style };
        if (line.length > 0 && widthOf([...partsOf(line), piece], measurer) > maxWidth) pushLine();
        line.push({ space: false, parts: [piece] });
      }
    }
  }
  if (line.length > 0 || lines.length === 0) pushLine();
  return lines;
}

let layoutCache = new WeakMap<TextMeasurer, WeakMap<TextNode, TextLayout>>();

/**
 * Forgets every layout worked out so far. Layouts are kept per layer for as
 * long as a measurer gives the same answers; when it stops doing so (a font
 * has finished loading, and text now measures differently) they are stale.
 */
export function clearTextLayoutCache(): void {
  layoutCache = new WeakMap();
}

/**
 * Lays a text layer out into lines positioned inside its box. Auto-width text
 * never wraps; the other modes wrap at the layer's width. Each line is made
 * of runs, one for each stretch in one style; a line is as tall as its
 * tallest run unless the layer has a fixed line height. Justified text
 * spreads the words of every wrapped line across the width, leaving the last
 * line of each paragraph as it is. In a list every paragraph is an item with
 * a bullet or a number in front of it, and its lines are set in to make room.
 * Results are cached per layer object, which is immutable.
 */
export function layoutText(node: TextNode, measurer: TextMeasurer): TextLayout {
  let perMeasurer = layoutCache.get(measurer);
  if (!perMeasurer) {
    perMeasurer = new WeakMap();
    layoutCache.set(measurer, perMeasurer);
  }
  const cached = perMeasurer.get(node);
  if (cached) return cached;

  const base = baseCharacterStyle(node);
  const shown = displayed(node);
  const text = shown.text;
  const position = (index: number): number => (shown.starts ? (shown.starts[Math.min(index, node.characters.length)] as number) : index);
  // The styled stretches, in positions of the displayed text.
  const spans = node.styleRanges
    .map((range) => ({ start: position(range.start), end: position(range.end), style: rangeCharacterStyle(node, range) }))
    .filter((span) => span.end > span.start);
  const styleAt = (index: number): CharacterStyle => spans.find((span) => span.start <= index && span.end > index)?.style ?? base;
  /** The text between two positions, cut where its style changes. */
  const partsBetween = (from: number, to: number): Part[] => {
    const parts: Part[] = [];
    let cursor = from;
    for (const span of spans) {
      if (span.end <= cursor || span.start >= to) continue;
      if (span.start > cursor) parts.push({ text: text.slice(cursor, span.start), style: base });
      const end = Math.min(span.end, to);
      parts.push({ text: text.slice(Math.max(span.start, cursor), end), style: span.style });
      cursor = end;
    }
    if (cursor < to) parts.push({ text: text.slice(cursor, to), style: base });
    return parts;
  };

  const baseLineHeight = resolveLineHeight(node);
  const wraps = node.textAutoResize !== 'WIDTH_AND_HEIGHT';
  const list = node.listType !== 'NONE';

  // Paragraphs, each with its tokens and, in a list, its marker.
  const paragraphs: { start: number; tokens: Token[]; marker: Part | null }[] = [];
  let offset = 0;
  for (const paragraph of text.split('\n')) {
    const tokens: Token[] = [];
    for (const match of paragraph.matchAll(/\s+|\S+/g)) {
      const from = offset + (match.index ?? 0);
      tokens.push({ space: /^\s/.test(match[0]), parts: partsBetween(from, from + match[0].length) });
    }
    // A marker looks like the start of its item, without any underline or strikethrough.
    const marker: Part | null = list
      ? { text: node.listType === 'BULLETED' ? '•' : `${paragraphs.length + 1}.`, style: { ...styleAt(offset), textDecoration: 'NONE' } }
      : null;
    paragraphs.push({ start: offset, tokens, marker });
    offset += paragraph.length + 1;
  }

  // A list's text starts after the widest marker and a gap.
  const markerGap = node.fontSize * 0.5;
  let indent = 0;
  if (list) {
    let widest = 0;
    for (const paragraph of paragraphs) if (paragraph.marker) widest = Math.max(widest, measurer.width(paragraph.marker.text, paragraph.marker.style));
    indent = Math.ceil(Math.max(node.fontSize * 1.5, widest + markerGap));
  }
  const wrapWidth = Math.max(1, node.width - indent);

  // Lines as tokens, remembering which paragraph each belongs to and whether it was cut short by wrapping.
  const rows: { tokens: Token[]; paragraph: number; first: boolean; wrapped: boolean }[] = [];
  paragraphs.forEach((paragraph, index) => {
    const wrappedLines = wraps ? wrapParagraph(paragraph.tokens, wrapWidth, measurer) : [paragraph.tokens];
    wrappedLines.forEach((tokens, i) => rows.push({ tokens, paragraph: index, first: i === 0, wrapped: i < wrappedLines.length - 1 }));
  });

  const measured = rows.map((row) => {
    const parts = merged(partsOf(row.tokens));
    const widths = parts.map((part) => measurer.width(part.text, part.style));
    // An empty line is as tall as text at that place would be.
    const styles = parts.length > 0 ? parts.map((part) => part.style) : [styleAt((paragraphs[row.paragraph] as { start: number }).start)];
    let height = node.lineHeight ?? 0;
    let ascent = 0;
    let descent = 0;
    for (const style of styles) {
      if (node.lineHeight === null) height = Math.max(height, Math.round(style.fontSize * 1.2));
      const metrics = measurer.metrics(style);
      ascent = Math.max(ascent, metrics.ascent);
      descent = Math.max(descent, metrics.descent);
    }
    return { row, parts, widths, width: widths.reduce((sum, w) => sum + w, 0), height, ascent, descent };
  });

  const width = Math.max(0, ...measured.map((line) => line.width)) + indent;
  const height = measured.reduce((sum, line) => sum + line.height, 0);
  // Lines are placed in the box the layer will have: its own size, except for
  // the dimensions that are fitted to the text.
  const boxWidth = node.textAutoResize === 'WIDTH_AND_HEIGHT' ? width : node.width;
  const boxHeight = node.textAutoResize === 'NONE' ? node.height : height;
  const column = boxWidth - indent;
  let top = node.verticalAlign === 'MIDDLE' ? (boxHeight - height) / 2 : node.verticalAlign === 'BOTTOM' ? boxHeight - height : 0;

  const lines: TextLine[] = measured.map((line) => {
    const baseline = top + (line.height - (line.ascent + line.descent)) / 2 + line.ascent;
    const gaps = line.row.tokens.filter((token) => token.space).length;
    const spread = node.textAlign === 'JUSTIFIED' && wraps && line.row.wrapped && gaps > 0;
    const runs: TextRun[] = [];
    let lineWidth = line.width;
    let x = indent + (node.textAlign === 'CENTER' ? (column - line.width) / 2 : node.textAlign === 'RIGHT' ? column - line.width : 0);
    const lineX = x;
    if (spread) {
      // Each word is placed on its own, and what is left over is shared between the gaps.
      const pieces = line.row.tokens.map((token) => ({ token, parts: merged(token.parts) }));
      const natural = pieces.reduce((sum, piece) => sum + piece.parts.reduce((s, part) => s + measurer.width(part.text, part.style), 0), 0);
      const extra = Math.max(0, column - natural) / gaps;
      for (const piece of pieces) {
        piece.parts.forEach((part, i) => {
          // The space takes up the extra, so that an underline carries on across it.
          const widthOfPart = measurer.width(part.text, part.style) + (piece.token.space && i === piece.parts.length - 1 ? extra : 0);
          runs.push({ text: part.text, x, width: widthOfPart, style: part.style });
          x += widthOfPart;
        });
      }
      lineWidth = x - lineX;
    } else {
      line.parts.forEach((part, i) => {
        runs.push({ text: part.text, x, width: line.widths[i] as number, style: part.style });
        x += line.widths[i] as number;
      });
    }
    const paragraph = paragraphs[line.row.paragraph] as { marker: Part | null };
    let marker: TextRun | null = null;
    if (paragraph.marker && line.row.first) {
      const markerWidth = measurer.width(paragraph.marker.text, paragraph.marker.style);
      marker = { text: paragraph.marker.text, x: indent - markerGap - markerWidth, width: markerWidth, style: paragraph.marker.style };
    }
    const result: TextLine = { text: runs.map((run) => run.text).join(''), width: lineWidth, x: lineX, baseline, top, height: line.height, runs, marker };
    top += line.height;
    return result;
  });

  const layout: TextLayout = { lines, width, height, lineHeight: baseLineHeight, indent };
  perMeasurer.set(node, layout);
  return layout;
}

/**
 * Resizes text layers whose size follows their content. Auto-width text takes
 * the size of its lines; auto-height text keeps its width and takes the height
 * of its wrapped lines. The edge the text is aligned to stays where it is, so
 * right-aligned text grows to the left. Only layers that differ from
 * `previous` are measured, which keeps this cheap enough to run on every edit.
 */
export function fitTextLayers(previous: Document, doc: Document, measurer: TextMeasurer): Document {
  if (previous.nodes === doc.nodes) return doc;
  const patches: Record<NodeId, LayerPatch> = {};
  for (const id in doc.nodes) {
    const node = doc.nodes[id];
    if (!node || node.type !== 'TEXT' || node === previous.nodes[id] || node.textAutoResize === 'NONE') continue;
    const layout = layoutText(node, measurer);
    const width = node.textAutoResize === 'WIDTH_AND_HEIGHT' ? Math.max(1, Math.ceil(layout.width)) : node.width;
    const height = Math.max(1, layout.height);
    if (width === node.width && height === node.height) continue;

    // Keep the aligned edge fixed in the layer's own (possibly rotated) frame.
    const anchor = node.textAlign === 'CENTER' ? 0.5 : node.textAlign === 'RIGHT' ? 1 : 0;
    const left = node.x + (node.width - width) * anchor;
    const c0 = { x: node.x + node.width / 2, y: node.y + node.height / 2 };
    const c1 = rotatePoint({ x: left + width / 2, y: node.y + height / 2 }, c0, node.rotation);
    patches[id] = { x: clean(c1.x - width / 2), y: clean(c1.y - height / 2), width: clean(width), height: clean(height) };
  }
  return patchNodes(doc, patches);
}

/** A layer name derived from its text, as shown in the layers panel. */
export function textLayerName(characters: string): string {
  const firstLine = characters.split('\n').find((line) => line.trim() !== '') ?? '';
  const trimmed = firstLine.trim().replace(/\s+/g, ' ');
  return trimmed.length > 40 ? `${trimmed.slice(0, 40)}…` : trimmed;
}

/** A measurer with fixed arithmetic, for tests and for environments without a canvas. */
export const approximateMeasurer: TextMeasurer = {
  width: (text, style) => [...text].length * (style.fontSize * 0.5 + style.letterSpacing),
  metrics: (style) => ({ ascent: style.fontSize * 0.8, descent: style.fontSize * 0.2 }),
};
