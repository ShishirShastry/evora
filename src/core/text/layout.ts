import { patchNodes } from '../document/mutate';
import type { Document, LayerPatch, NodeId, TextNode } from '../document/schema';
import { rotatePoint } from '../math/geometry';
import { clean } from '../ops/transform';

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

export interface TextLine {
  text: string;
  width: number;
  /** Left edge of the line inside the layer's box. */
  x: number;
  /** Baseline of the line inside the layer's box. */
  baseline: number;
}

export interface TextLayout {
  lines: TextLine[];
  /** Width of the widest line. */
  width: number;
  /** Height of all lines. */
  height: number;
  lineHeight: number;
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

/** The characters as they are displayed, after the text-case setting. */
export function displayText(node: Pick<TextNode, 'characters' | 'textCase'>): string {
  switch (node.textCase) {
    case 'UPPER':
      return node.characters.toUpperCase();
    case 'LOWER':
      return node.characters.toLowerCase();
    case 'TITLE':
      return node.characters.replace(/(^|[\s-])(\p{L})/gu, (_match, lead: string, letter: string) => lead + letter.toUpperCase());
    default:
      return node.characters;
  }
}

/** Breaks one paragraph into lines no wider than `maxWidth`, at spaces where possible. */
function wrapParagraph(text: string, maxWidth: number, style: TextStyle, measurer: TextMeasurer): string[] {
  if (text === '' || measurer.width(text, style) <= maxWidth) return [text];
  const lines: string[] = [];
  // Tokens are words and the runs of spaces between them.
  const tokens = text.match(/\s+|\S+/g) ?? [];
  let line = '';
  const pushLine = (): void => {
    lines.push(line.replace(/\s+$/, ''));
    line = '';
  };
  for (const token of tokens) {
    const isSpace = /^\s/.test(token);
    if (measurer.width(line + token, style) <= maxWidth || (isSpace && line !== '')) {
      // Trailing spaces may hang past the edge; they are trimmed when the line ends.
      line += token;
      continue;
    }
    if (line !== '') pushLine();
    if (isSpace) continue;
    if (measurer.width(token, style) <= maxWidth) {
      line = token;
      continue;
    }
    // A single word wider than the box is broken between characters.
    for (const char of token) {
      if (line !== '' && measurer.width(line + char, style) > maxWidth) pushLine();
      line += char;
    }
  }
  if (line !== '' || lines.length === 0) pushLine();
  return lines;
}

const layoutCache = new WeakMap<TextMeasurer, WeakMap<TextNode, TextLayout>>();

/**
 * Lays a text layer out into lines positioned inside its box. Auto-width text
 * never wraps; the other modes wrap at the layer's width. Results are cached
 * per layer object, which is immutable.
 */
export function layoutText(node: TextNode, measurer: TextMeasurer): TextLayout {
  let perMeasurer = layoutCache.get(measurer);
  if (!perMeasurer) {
    perMeasurer = new WeakMap();
    layoutCache.set(measurer, perMeasurer);
  }
  const cached = perMeasurer.get(node);
  if (cached) return cached;

  const style: TextStyle = {
    fontFamily: node.fontFamily,
    fontSize: node.fontSize,
    fontWeight: node.fontWeight,
    italic: node.italic,
    letterSpacing: node.letterSpacing,
  };
  const lineHeight = resolveLineHeight(node);
  const wraps = node.textAutoResize !== 'WIDTH_AND_HEIGHT';
  const texts: string[] = [];
  for (const paragraph of displayText(node).split('\n')) {
    if (wraps) texts.push(...wrapParagraph(paragraph, Math.max(1, node.width), style, measurer));
    else texts.push(paragraph);
  }

  const widths = texts.map((text) => measurer.width(text, style));
  const width = Math.max(0, ...widths);
  const height = texts.length * lineHeight;
  // Lines are placed in the box the layer will have: its own size, except for
  // the dimensions that are fitted to the text.
  const boxWidth = node.textAutoResize === 'WIDTH_AND_HEIGHT' ? width : node.width;
  const boxHeight = node.textAutoResize === 'NONE' ? node.height : height;
  const top = node.verticalAlign === 'MIDDLE' ? (boxHeight - height) / 2 : node.verticalAlign === 'BOTTOM' ? boxHeight - height : 0;
  const { ascent, descent } = measurer.metrics(style);
  const baselineOffset = (lineHeight - (ascent + descent)) / 2 + ascent;

  const lines = texts.map((text, i) => {
    const lineWidth = widths[i] as number;
    const x = node.textAlign === 'CENTER' ? (boxWidth - lineWidth) / 2 : node.textAlign === 'RIGHT' ? boxWidth - lineWidth : 0;
    return { text, width: lineWidth, x, baseline: top + i * lineHeight + baselineOffset };
  });
  const layout = { lines, width, height, lineHeight };
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
