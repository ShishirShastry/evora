import { solidPaint } from '../document/factory';
import { isLayer, type Document, type GradientPaint, type GradientStop, type LayerPatch, type LayerType, type NodeId, type Paint, type RGB } from '../document/schema';
import type { Point } from '../math/geometry';
import { applyToPoint, multiply, rotationOf, type Matrix } from '../math/matrix';
import { groupNodes } from '../ops/groups';
import { addLayer } from '../ops/nodes';
import type { TextMeasurer } from '../text/layout';
import { networkBounds, translateNetwork } from '../vector/network';
import { arcCurves, networkFromSubpaths, parsePathData, transformSubpaths, type PathCurve, type Subpath } from './pathData';
import { elements, localName, parseXml, textOf, XmlError, type XmlElement } from './xml';

/**
 * Reads an SVG file into layers that can be edited: rectangles and ellipses
 * as themselves, every other shape as a vector layer with the same points,
 * groups as groups, text as text, and fills, strokes and gradients as the
 * document's own. What SVG has that the document does not (clipping paths,
 * filters, patterns, embedded pictures) is left out and named in the
 * warnings that come back.
 */

/** A layer read from a file, before it is put in a document: its type, its properties in the frame's space, and what is in it. */
export interface ImportedLayer {
  type: LayerType;
  props: LayerPatch;
  children: ImportedLayer[];
  /** A group that only one layer came out of is not made: this is the opacity it would have given. */
}

export interface ImportedSvg {
  width: number;
  height: number;
  layers: ImportedLayer[];
  warnings: string[];
}

export class SvgImportError extends Error {}

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

const NAMED_COLOURS: Record<string, string> = {
  black: '#000000', silver: '#c0c0c0', gray: '#808080', grey: '#808080', white: '#ffffff', maroon: '#800000', red: '#ff0000', purple: '#800080', fuchsia: '#ff00ff', magenta: '#ff00ff',
  green: '#008000', lime: '#00ff00', olive: '#808000', yellow: '#ffff00', navy: '#000080', blue: '#0000ff', teal: '#008080', aqua: '#00ffff', cyan: '#00ffff', orange: '#ffa500',
  pink: '#ffc0cb', brown: '#a52a2a', gold: '#ffd700', indigo: '#4b0082', violet: '#ee82ee', coral: '#ff7f50', crimson: '#dc143c', tomato: '#ff6347', salmon: '#fa8072', khaki: '#f0e68c',
  beige: '#f5f5dc', ivory: '#fffff0', lavender: '#e6e6fa', turquoise: '#40e0d0', tan: '#d2b48c', plum: '#dda0dd', orchid: '#da70d6', skyblue: '#87ceeb', steelblue: '#4682b4', slategray: '#708090',
  slategrey: '#708090', darkgray: '#a9a9a9', darkgrey: '#a9a9a9', lightgray: '#d3d3d3', lightgrey: '#d3d3d3', dimgray: '#696969', dimgrey: '#696969', gainsboro: '#dcdcdc', whitesmoke: '#f5f5f5',
  darkblue: '#00008b', darkgreen: '#006400', darkred: '#8b0000', lightblue: '#add8e6', lightgreen: '#90ee90', royalblue: '#4169e1', dodgerblue: '#1e90ff', forestgreen: '#228b22', seagreen: '#2e8b57',
  firebrick: '#b22222', chocolate: '#d2691e', sienna: '#a0522d', hotpink: '#ff69b4', deeppink: '#ff1493', midnightblue: '#191970', rebeccapurple: '#663399', transparent: 'none',
};

/** A colour as CSS writes one. Null for "none"; undefined for what is not a colour. */
export function parseColour(text: string): { color: RGB; opacity: number } | null | undefined {
  const value = text.trim().toLowerCase();
  if (value === '' || value === 'inherit') return undefined;
  if (value === 'none') return null;
  if (value === 'currentcolor') return { color: { r: 0, g: 0, b: 0 }, opacity: 1 };
  const named = NAMED_COLOURS[value];
  if (named === 'none') return null;
  const hex = /^#([0-9a-f]{3,8})$/.exec(named ?? value)?.[1];
  if (hex && [3, 4, 6, 8].includes(hex.length)) {
    const full = hex.length <= 4 ? [...hex].map((ch) => ch + ch).join('') : hex;
    const part = (at: number): number => parseInt(full.slice(at, at + 2), 16) / 255;
    return { color: { r: part(0), g: part(2), b: part(4) }, opacity: full.length === 8 ? part(6) : 1 };
  }
  const rgb = /^rgba?\(([^)]+)\)$/.exec(value);
  if (rgb) {
    const parts = (rgb[1] as string).split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 3) return undefined;
    const channel = (part: string): number => (part.endsWith('%') ? parseFloat(part) / 100 : parseFloat(part) / 255);
    const alpha = parts[3] === undefined ? 1 : parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
    const clamp = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
    return { color: { r: clamp(channel(parts[0] as string)), g: clamp(channel(parts[1] as string)), b: clamp(channel(parts[2] as string)) }, opacity: clamp(alpha) };
  }
  return undefined;
}

/** A `transform` attribute as one matrix. */
export function parseTransform(text: string | undefined): Matrix {
  let matrix: Matrix = IDENTITY;
  if (!text) return matrix;
  for (const match of text.matchAll(/(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g)) {
    const n = (match[2] as string).split(/[\s,]+/).filter(Boolean).map(Number);
    if (n.some((value) => !Number.isFinite(value))) continue;
    let step: Matrix = IDENTITY;
    const kind = match[1];
    if (kind === 'matrix' && n.length === 6) step = n as unknown as Matrix;
    else if (kind === 'translate') step = [1, 0, 0, 1, n[0] ?? 0, n[1] ?? 0];
    else if (kind === 'scale') step = [n[0] ?? 1, 0, 0, n[1] ?? n[0] ?? 1, 0, 0];
    else if (kind === 'rotate') {
      const r = ((n[0] ?? 0) * Math.PI) / 180;
      const turn: Matrix = [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0];
      step = n.length >= 3 ? multiply(multiply([1, 0, 0, 1, n[1] as number, n[2] as number], turn), [1, 0, 0, 1, -(n[1] as number), -(n[2] as number)]) : turn;
    } else if (kind === 'skewX') step = [1, 0, Math.tan(((n[0] ?? 0) * Math.PI) / 180), 1, 0, 0];
    else if (kind === 'skewY') step = [1, Math.tan(((n[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0];
    matrix = multiply(matrix, step);
  }
  return matrix;
}

const length = (text: string | undefined, fallback = 0): number => {
  if (text === undefined) return fallback;
  const value = parseFloat(text);
  if (!Number.isFinite(value)) return fallback;
  // Points, picas, millimetres, centimetres and inches, at the 96 pixels an inch CSS has.
  const unit = /[a-z%]+$/i.exec(text.trim())?.[0]?.toLowerCase();
  const factor = unit === 'pt' ? 96 / 72 : unit === 'pc' ? 16 : unit === 'mm' ? 96 / 25.4 : unit === 'cm' ? 96 / 2.54 : unit === 'in' ? 96 : 1;
  return value * factor;
};

/** The properties that pass from an element to what is in it. */
const INHERITED = ['fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'font-family', 'font-size', 'font-weight', 'font-style', 'letter-spacing', 'text-anchor', 'visibility'];

type Style = Record<string, string>;

interface Context {
  matrix: Matrix;
  style: Style;
  /** The opacity of the groups it is in that were not made into groups of their own. */
  opacity: number;
}

const circle = (cx: number, cy: number, rx: number, ry: number): Subpath => {
  const right = { x: cx + rx, y: cy };
  const left = { x: cx - rx, y: cy };
  return { closed: true, start: right, curves: [...arcCurves(right, rx, ry, 0, false, true, left), ...arcCurves(left, rx, ry, 0, false, true, right)] };
};

const polyline = (points: Point[], closed: boolean): Subpath[] => {
  if (points.length < 2) return [];
  const curves: PathCurve[] = [];
  for (let i = 1; i < points.length; i++) curves.push({ p0: points[i - 1] as Point, p1: points[i - 1] as Point, p2: points[i] as Point, p3: points[i] as Point });
  if (closed) curves.push({ p0: points[points.length - 1] as Point, p1: points[points.length - 1] as Point, p2: points[0] as Point, p3: points[0] as Point });
  return [{ curves, closed, start: points[0] as Point }];
};

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-3;
const sameBox = (a: Box, b: Box): boolean => near(a.x, b.x) && near(a.y, b.y) && near(a.width, b.width) && near(a.height, b.height);

/** The box of a layer that is an upright rectangle, as a rectangle or as the outline of one, with its corner radius. Null for anything else. */
function rectangleOf(layer: ImportedLayer): (Box & { radius: number }) | null {
  const { props } = layer;
  if (props.x === undefined || props.y === undefined || props.width === undefined || props.height === undefined) return null;
  const box = { x: props.x, y: props.y, width: props.width, height: props.height };
  if (layer.type === 'RECTANGLE') return (props.rotation ?? 0) === 0 ? { ...box, radius: props.cornerRadius ?? 0 } : null;
  if (layer.type !== 'VECTOR' || !props.network) return null;
  const { vertices, segments } = props.network;
  if (vertices.length !== 4 || segments.length !== 4) return null;
  const straight = segments.every((segment) => segment.tangentStart.x === 0 && segment.tangentStart.y === 0 && segment.tangentEnd.x === 0 && segment.tangentEnd.y === 0);
  // Its four points are the four corners of its box.
  const corners = vertices.every((vertex) => (near(vertex.x, 0) || near(vertex.x, box.width)) && (near(vertex.y, 0) || near(vertex.y, box.height)));
  const distinct = new Set(vertices.map((vertex) => `${near(vertex.x, 0) ? 0 : 1}${near(vertex.y, 0) ? 0 : 1}`)).size === 4;
  return straight && corners && distinct ? { ...box, radius: 0 } : null;
}

/** Reads an SVG file. Throws an `SvgImportError` when it is not one. */
export function readSvg(source: string, measurer?: TextMeasurer): ImportedSvg {
  let root: XmlElement;
  try {
    root = parseXml(source);
  } catch (error) {
    if (error instanceof XmlError) throw new SvgImportError(`This SVG file could not be read. ${error.message}`);
    throw error;
  }
  if (localName(root.name) !== 'svg') throw new SvgImportError('This is not an SVG file.');
  const warnings = new Set<string>();

  // What can be referred to by its ID: gradients, and shapes that <use> repeats.
  const byId = new Map<string, XmlElement>();
  const rules: { selector: string; style: Style }[] = [];
  const declarations = (text: string): Style => {
    const out: Style = {};
    for (const part of text.split(';')) {
      const colon = part.indexOf(':');
      if (colon > 0) out[part.slice(0, colon).trim().toLowerCase()] = part.slice(colon + 1).trim();
    }
    return out;
  };
  const index = (element: XmlElement): void => {
    if (element.attributes.id) byId.set(element.attributes.id, element);
    if (localName(element.name) === 'style') {
      // Rules of the simple kinds exported files have: a class, an ID, or an element's name.
      for (const rule of textOf(element).replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^}]*)\}/g)) {
        for (const selector of (rule[1] as string).split(',')) rules.push({ selector: selector.trim(), style: declarations(rule[2] as string) });
      }
    }
    for (const child of elements(element)) index(child);
  };
  index(root);

  const href = (element: XmlElement): XmlElement | undefined => {
    const value = element.attributes.href ?? element.attributes['xlink:href'];
    return value?.startsWith('#') ? byId.get(value.slice(1)) : undefined;
  };

  /** The style of an element: what it inherits, then its attributes, then style rules, then its own style attribute. */
  const styleOf = (element: XmlElement, inherited: Style): { style: Style; own: Style } => {
    const own: Style = {};
    for (const key in element.attributes) if (!key.includes(':') && key !== 'style' && key !== 'class' && key !== 'id' && key !== 'd' && key !== 'points') own[key] = element.attributes[key] as string;
    const classes = (element.attributes.class ?? '').split(/\s+/).filter(Boolean);
    for (const rule of rules) {
      const matches = rule.selector === localName(element.name) || (rule.selector.startsWith('.') && classes.includes(rule.selector.slice(1))) || (rule.selector.startsWith('#') && rule.selector.slice(1) === element.attributes.id);
      if (matches) Object.assign(own, rule.style);
    }
    if (element.attributes.style) Object.assign(own, declarations(element.attributes.style));
    const style: Style = {};
    for (const key of INHERITED) {
      const value = own[key] !== undefined && own[key] !== 'inherit' ? own[key] : inherited[key];
      if (value !== undefined) style[key] = value;
    }
    return { style, own };
  };

  /** A gradient of the file as a paint for a layer whose box, in the frame's space, is given. */
  const gradient = (element: XmlElement, box: { x: number; y: number; width: number; height: number }, matrix: Matrix, opacity: number): Paint | null => {
    // A gradient may take its stops, and whatever it does not say itself, from another.
    const chain: XmlElement[] = [];
    for (let current: XmlElement | undefined = element; current && !chain.includes(current) && chain.length < 8; current = href(current)) chain.push(current);
    const attribute = (name: string): string | undefined => chain.find((entry) => entry.attributes[name] !== undefined)?.attributes[name];
    const source = chain.find((entry) => elements(entry).some((child) => localName(child.name) === 'stop'));
    const stops: GradientStop[] = [];
    for (const stop of source ? elements(source).filter((child) => localName(child.name) === 'stop') : []) {
      const { own } = styleOf(stop, {});
      const colour = parseColour(own['stop-color'] ?? '#000000');
      const offset = own.offset ?? '0';
      const position = Math.min(1, Math.max(0, offset.endsWith('%') ? parseFloat(offset) / 100 : parseFloat(offset) || 0));
      stops.push({ position: Math.max(position, stops[stops.length - 1]?.position ?? 0), color: colour ? colour.color : { r: 0, g: 0, b: 0 }, opacity: (colour ? colour.opacity : 0) * (own['stop-opacity'] === undefined ? 1 : Math.min(1, Math.max(0, parseFloat(own['stop-opacity']) || 0))) });
    }
    if (stops.length === 0) return null;
    if (stops.length === 1) return { ...solidPaint((stops[0] as GradientStop).color, (stops[0] as GradientStop).opacity * opacity) };
    const user = attribute('gradientUnits') === 'userSpaceOnUse';
    const own = parseTransform(attribute('gradientTransform'));
    const fraction = (text: string | undefined, fallback: number): number => (text === undefined ? fallback : text.endsWith('%') ? parseFloat(text) / 100 : parseFloat(text));
    // A point of the gradient as a point of the layer's box, 0 to 1 each way.
    const unit = (x: number, y: number): Point => {
      const p = applyToPoint(own, { x, y });
      if (!user) return p;
      const placed = applyToPoint(matrix, p);
      return { x: box.width > 0 ? (placed.x - box.x) / box.width : 0, y: box.height > 0 ? (placed.y - box.y) / box.height : 0 };
    };
    const radial = localName(element.name) === 'radialGradient';
    let from: Point;
    let to: Point;
    if (radial) {
      const cx = fraction(attribute('cx'), user ? 0 : 0.5);
      const cy = fraction(attribute('cy'), user ? 0 : 0.5);
      const r = fraction(attribute('r'), user ? 0 : 0.5);
      from = unit(cx, cy);
      to = unit(cx + r, cy);
    } else {
      from = unit(fraction(attribute('x1'), 0), fraction(attribute('y1'), 0));
      to = unit(fraction(attribute('x2'), user ? 0 : 1), fraction(attribute('y2'), 0));
    }
    const paint: GradientPaint = { type: radial ? 'GRADIENT_RADIAL' : 'GRADIENT_LINEAR', stops, from, to, opacity, visible: true };
    return paint;
  };

  const paintOf = (value: string | undefined, opacity: number, box: { x: number; y: number; width: number; height: number }, matrix: Matrix): Paint | null => {
    if (value === undefined) return null;
    const reference = /^url\(\s*['"]?#([^'")\s]+)['"]?\s*\)/.exec(value.trim());
    if (reference) {
      const target = byId.get(reference[1] as string);
      const kind = target ? localName(target.name) : '';
      if (target && (kind === 'linearGradient' || kind === 'radialGradient')) return gradient(target, box, matrix, opacity);
      if (kind === 'pattern') warnings.add('A pattern fill was left out: patterns are not imported.');
      return null;
    }
    const colour = parseColour(value);
    return colour ? solidPaint(colour.color, colour.opacity * opacity) : null;
  };

  const number01 = (text: string | undefined): number => (text === undefined ? 1 : Math.min(1, Math.max(0, text.endsWith('%') ? parseFloat(text) / 100 : parseFloat(text))) || 0);

  /** The look of a shape, given its box in the frame's space. */
  const appearance = (style: Style, own: Style, context: Context, box: { x: number; y: number; width: number; height: number }, defaultFill: string | undefined): LayerPatch => {
    const scale = Math.sqrt(Math.abs(context.matrix[0] * context.matrix[3] - context.matrix[1] * context.matrix[2]));
    const fill = paintOf(style.fill ?? defaultFill, number01(style['fill-opacity']), box, context.matrix);
    const stroke = paintOf(style.stroke, number01(style['stroke-opacity']), box, context.matrix);
    const dashes = (style['stroke-dasharray'] ?? 'none') === 'none' ? [] : (style['stroke-dasharray'] as string).split(/[\s,]+/).map((part) => parseFloat(part) * scale).filter((value) => Number.isFinite(value) && value >= 0);
    const cap = style['stroke-linecap'];
    const join = style['stroke-linejoin'];
    return {
      fills: fill ? [fill] : [],
      strokes: stroke ? [stroke] : [],
      strokeWeight: stroke ? length(style['stroke-width'], 1) * scale : 1,
      strokeAlign: 'CENTER',
      strokeCap: cap === 'round' ? 'ROUND' : cap === 'square' ? 'SQUARE' : 'NONE',
      strokeJoin: join === 'round' ? 'ROUND' : join === 'bevel' ? 'BEVEL' : 'MITER',
      dashPattern: dashes.some((value) => value > 0) ? dashes : [],
      opacity: number01(own.opacity) * context.opacity,
    };
  };

  const named = (element: XmlElement, fallback: string): string => element.attributes.id?.replace(/[_-]+/g, ' ').trim() || fallback;

  const shape = (element: XmlElement, context: Context, style: Style, own: Style): ImportedLayer | null => {
    const kind = localName(element.name);
    const a = (name: string): number => length(element.attributes[name]);
    const m = context.matrix;
    // Upright and unsheared, a rectangle or an ellipse stays one.
    const upright = Math.abs(m[1]) < 1e-9 && Math.abs(m[2]) < 1e-9 && m[0] > 0 && m[3] > 0;
    if (kind === 'rect' && upright && a('width') > 0 && a('height') > 0) {
      const box = { x: a('x') * m[0] + m[4], y: a('y') * m[3] + m[5], width: a('width') * m[0], height: a('height') * m[3] };
      const rx = element.attributes.rx !== undefined ? a('rx') : a('ry');
      const ry = element.attributes.ry !== undefined ? a('ry') : rx;
      if (Math.abs(rx * m[0] - ry * m[3]) < 1e-6) {
        return { type: 'RECTANGLE', props: { name: named(element, 'Rectangle'), ...box, cornerRadius: Math.min(rx * m[0], box.width / 2, box.height / 2), ...appearance(style, own, context, box, '#000000') }, children: [] };
      }
    }
    if ((kind === 'circle' || kind === 'ellipse') && upright) {
      const rx = kind === 'circle' ? a('r') : a('rx');
      const ry = kind === 'circle' ? a('r') : a('ry');
      if (rx > 0 && ry > 0) {
        const box = { x: (a('cx') - rx) * m[0] + m[4], y: (a('cy') - ry) * m[3] + m[5], width: rx * 2 * m[0], height: ry * 2 * m[3] };
        return { type: 'ELLIPSE', props: { name: named(element, 'Ellipse'), ...box, ...appearance(style, own, context, box, '#000000') }, children: [] };
      }
    }
    // Everything else is its outline, as a vector layer.
    let paths: Subpath[] = [];
    if (kind === 'path') paths = parsePathData(element.attributes.d ?? '');
    else if (kind === 'rect') {
      const x = a('x');
      const y = a('y');
      const w = a('width');
      const h = a('height');
      const rx = Math.min(element.attributes.rx !== undefined ? a('rx') : a('ry'), w / 2);
      const ry = Math.min(element.attributes.ry !== undefined ? a('ry') : rx, h / 2);
      if (w > 0 && h > 0) paths = rx > 0 && ry > 0 ? parsePathData(`M${x + rx} ${y}H${x + w - rx}A${rx} ${ry} 0 0 1 ${x + w} ${y + ry}V${y + h - ry}A${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}H${x + rx}A${rx} ${ry} 0 0 1 ${x} ${y + h - ry}V${y + ry}A${rx} ${ry} 0 0 1 ${x + rx} ${y}Z`) : polyline([{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }], true);
    } else if (kind === 'circle' || kind === 'ellipse') {
      const rx = kind === 'circle' ? a('r') : a('rx');
      const ry = kind === 'circle' ? a('r') : a('ry');
      if (rx > 0 && ry > 0) paths = [circle(a('cx'), a('cy'), rx, ry)];
    } else if (kind === 'line') paths = polyline([{ x: a('x1'), y: a('y1') }, { x: a('x2'), y: a('y2') }], false);
    else if (kind === 'polyline' || kind === 'polygon') {
      const numbers = (element.attributes.points ?? '').split(/[\s,]+/).filter(Boolean).map(Number);
      const points: Point[] = [];
      for (let i = 0; i + 1 < numbers.length; i += 2) if (Number.isFinite(numbers[i]) && Number.isFinite(numbers[i + 1])) points.push({ x: numbers[i] as number, y: numbers[i + 1] as number });
      paths = polyline(points, kind === 'polygon');
    }
    if (paths.length === 0) return null;
    const network = networkFromSubpaths(transformSubpaths(paths, m));
    const bounds = networkBounds(network);
    if (!bounds) return null;
    // A line has nothing to fill.
    const open = kind === 'line' || kind === 'polyline';
    return {
      type: 'VECTOR',
      props: {
        name: named(element, kind === 'path' ? 'Vector' : kind[0]?.toUpperCase() + kind.slice(1)),
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        network: translateNetwork(network, -bounds.x, -bounds.y),
        windingRule: style['fill-rule'] === 'evenodd' ? 'EVENODD' : 'NONZERO',
        ...appearance(style, own, context, bounds, kind === 'line' ? 'none' : '#000000'),
        ...(open && style.fill === undefined ? { fills: kind === 'line' ? [] : undefined } : {}),
      },
      children: [],
    };
  };

  const text = (element: XmlElement, context: Context, given: Style, own: Style): ImportedLayer | null => {
    // Each run that starts at a place of its own is a line; the rest follows on.
    const lines: string[] = [];
    let first: { x: number; y: number } | null = null;
    // The element the first words are in: a text layer has one style, and it is theirs.
    let source: XmlElement | null = null;
    const walk = (node: XmlElement, x: number | undefined, y: number | undefined): void => {
      for (const child of node.children) {
        if (typeof child === 'string') {
          const content = child.replace(/\s+/g, ' ');
          if (content.trim() === '' && lines.length === 0) continue;
          if (lines.length === 0) lines.push('');
          lines[lines.length - 1] += content;
          if (source === null && content.trim() !== '') source = node;
        } else if (localName(child.name) === 'tspan') {
          const cx = child.attributes.x !== undefined ? length(child.attributes.x) : undefined;
          const cy = child.attributes.y !== undefined ? length(child.attributes.y) : undefined;
          if ((cy !== undefined || child.attributes.dy !== undefined) && lines.length > 0 && (lines[lines.length - 1] as string).trim() !== '') lines.push('');
          if (first === null && cx !== undefined && cy !== undefined) first = { x: cx, y: cy };
          walk(child, cx ?? x, cy ?? y);
        }
      }
    };
    const x = length(element.attributes.x);
    const y = length(element.attributes.y);
    walk(element, x, y);
    const characters = lines.map((line) => line.trim()).filter((line, index, all) => line !== '' || index < all.length - 1).join('\n').trim();
    if (characters === '') return null;
    const start: { x: number; y: number } = element.attributes.x !== undefined || element.attributes.y !== undefined || first === null ? { x, y } : first;
    const holder = source as XmlElement | null;
    const style = holder && holder !== element ? styleOf(holder, given).style : given;
    const m = context.matrix;
    const scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
    const fontSize = Math.max(1, length(style['font-size'], 16) * scale);
    const family = (style['font-family'] ?? 'Inter').split(',')[0]?.trim().replace(/^['"]|['"]$/g, '') || 'Inter';
    const weightText = style['font-weight'] ?? '400';
    const weight = weightText === 'bold' ? 700 : weightText === 'normal' ? 400 : Math.min(900, Math.max(100, Math.round((parseFloat(weightText) || 400) / 100) * 100));
    const typography = { fontFamily: family, fontSize, fontWeight: weight, italic: style['font-style'] === 'italic' || style['font-style'] === 'oblique', letterSpacing: length(style['letter-spacing']) * scale };
    // The place given is the start of the baseline; the layer's corner is above it by the font's ascent.
    const widest = Math.max(...characters.split('\n').map((line) => (measurer ? measurer.width(line, { ...typography, textDecoration: 'NONE', textCase: 'ORIGINAL' } as never) : line.length * fontSize * 0.55)));
    const metrics = measurer ? measurer.metrics({ ...typography, textDecoration: 'NONE', textCase: 'ORIGINAL' } as never) : { ascent: fontSize * 0.93, descent: fontSize * 0.24 };
    // The first line's baseline is below the top of the layer by the font's ascent and half of what the line height adds.
    const ascent = metrics.ascent + (Math.round(fontSize * 1.2) - metrics.ascent - metrics.descent) / 2;
    const anchor = style['text-anchor'];
    const shift = anchor === 'middle' ? widest / 2 : anchor === 'end' ? widest : 0;
    const baseline = applyToPoint(m, start);
    const rotation = rotationOf(m);
    const r = (rotation * Math.PI) / 180;
    // The top-left corner of the text, found from the baseline's start along the text's own axes.
    const corner = { x: baseline.x - shift * Math.cos(r) + ascent * Math.sin(r), y: baseline.y - shift * Math.sin(r) - ascent * Math.cos(r) };
    const height = Math.round(fontSize * 1.2) * characters.split('\n').length;
    // A layer turns about its centre, so its unturned corner is placed to bring the turned corner there.
    const centre = { x: corner.x + (widest / 2) * Math.cos(r) - (height / 2) * Math.sin(r), y: corner.y + (widest / 2) * Math.sin(r) + (height / 2) * Math.cos(r) };
    const box = { x: centre.x - widest / 2, y: centre.y - height / 2, width: widest, height };
    const look = appearance(style, own, context, box, '#000000');
    return {
      type: 'TEXT',
      props: { name: characters.split('\n')[0]?.slice(0, 40) ?? 'Text', x: box.x, y: box.y, rotation: Math.abs(rotation) < 1e-6 ? 0 : rotation, characters, ...typography, textAlign: anchor === 'middle' ? 'CENTER' : anchor === 'end' ? 'RIGHT' : 'LEFT', fills: look.fills, strokes: look.strokes, strokeWeight: look.strokeWeight, opacity: look.opacity } as LayerPatch,
      children: [],
    };
  };

  const SHAPES = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon']);
  const SKIPPED = new Set(['defs', 'style', 'title', 'desc', 'metadata', 'linearGradient', 'radialGradient', 'symbol', 'namedview', 'script']);

  const walk = (element: XmlElement, context: Context, depth: number): ImportedLayer[] => {
    const kind = localName(element.name);
    if (SKIPPED.has(kind) || depth > 64) return [];
    const { style, own } = styleOf(element, context.style);
    if (own.display === 'none' || style.visibility === 'hidden') return [];
    const clipped = own['clip-path'] !== undefined && own['clip-path'] !== 'none';
    const unclipped = (): void => {
      if (clipped) warnings.add('A clipping path was left out: what it clipped is whole.');
    };
    if (own.mask && own.mask !== 'none') warnings.add('A mask was left out: what it masked is whole.');
    if (own.filter && own.filter !== 'none') warnings.add('A filter was left out: shadows and blurs of the SVG are not imported.');
    const inner: Context = { matrix: multiply(context.matrix, parseTransform(element.attributes.transform)), style, opacity: context.opacity };
    if (SHAPES.has(kind)) {
      unclipped();
      const layer = shape(element, inner, style, own);
      return layer ? [layer] : [];
    }
    if (kind === 'text') {
      unclipped();
      const layer = text(element, inner, style, own);
      return layer ? [layer] : [];
    }
    if (kind === 'image') {
      warnings.add('A picture inside the SVG was left out: only its shapes and text are imported.');
      return [];
    }
    if (kind === 'use') {
      const target = href(element);
      if (!target || depth > 16) return [];
      const placed: Context = { ...inner, matrix: multiply(inner.matrix, [1, 0, 0, 1, length(element.attributes.x), length(element.attributes.y)]), opacity: inner.opacity * number01(own.opacity) };
      // A symbol is used for what is in it; anything else for itself.
      return localName(target.name) === 'symbol' ? elements(target).flatMap((child) => walk(child, placed, depth + 1)) : walk(target, placed, depth + 1);
    }
    if (kind === 'g' || kind === 'svg' || kind === 'a' || kind === 'switch') {
      const opacity = number01(own.opacity);
      let children = elements(element).flatMap((child) => walk(child, { ...inner, opacity: 1 }, depth + 1));
      if (children.length === 0) return [];
      // A group clipped to an upright rectangle is what a frame is: a box that clips what is in it.
      const reference = clipped ? /^url\(\s*['"]?#([^'")\s]+)/.exec(own['clip-path'] as string)?.[1] : undefined;
      const clipElement = reference ? byId.get(reference) : undefined;
      const clipShapes = clipElement && localName(clipElement.name) === 'clipPath' ? elements(clipElement) : [];
      const only = clipShapes.length === 1 ? clipShapes[0] : undefined;
      const outline = only && SHAPES.has(localName(only.name)) ? shape(only, { matrix: multiply(inner.matrix, parseTransform(only.attributes.transform)), style: {}, opacity: 1 }, {}, {}) : null;
      const frameBox = outline ? rectangleOf(outline) : null;
      if (frameBox) {
        // A plain rectangle that fills the frame, at the bottom of it, is the frame's own fill.
        const first = children[0];
        const under = first ? rectangleOf(first) : null;
        let fills: Paint[] = [];
        if (first && under && sameBox(under, frameBox) && (first.props.strokes ?? []).length === 0) {
          fills = first.props.fills ?? [];
          children = children.slice(1);
        }
        return [{ type: 'FRAME', props: { name: named(element, 'Frame'), x: frameBox.x, y: frameBox.y, width: frameBox.width, height: frameBox.height, cornerRadius: frameBox.radius, fills, clipsContent: true, opacity: opacity * inner.opacity }, children }];
      }
      unclipped();
      // The same, written the other way round: the fill first, then the clipped group over it.
      const [below, above] = children;
      if (children.length === 2 && below && above && above.type === 'FRAME' && (above.props.fills ?? []).length === 0 && (below.props.strokes ?? []).length === 0) {
        const under = rectangleOf(below);
        if (under && sameBox(under, above.props as Box)) children = [{ ...above, props: { ...above.props, fills: below.props.fills ?? [], name: named(element, above.props.name ?? 'Frame') } }];
      }
      // A group of one is that one, with the group's opacity on it.
      if (children.length === 1 || depth === 0) {
        return children.map((child) => ({ ...child, props: { ...child.props, opacity: (child.props.opacity ?? 1) * opacity * inner.opacity } }));
      }
      return [{ type: 'GROUP', props: { name: named(element, 'Group'), opacity: opacity * inner.opacity }, children }];
    }
    return [];
  };

  // The size of the drawing: its view box, stretched to the width and height the file gives.
  const box = (root.attributes.viewBox ?? '').split(/[\s,]+/).filter(Boolean).map(Number);
  const hasBox = box.length === 4 && box.every(Number.isFinite) && (box[2] as number) > 0 && (box[3] as number) > 0;
  const percent = (text: string | undefined): boolean => text === undefined || text.trim().endsWith('%');
  const width = percent(root.attributes.width) ? (hasBox ? (box[2] as number) : 300) : length(root.attributes.width, 300);
  const height = percent(root.attributes.height) ? (hasBox ? (box[3] as number) : 150) : length(root.attributes.height, 150);
  const view: Matrix = hasBox ? [width / (box[2] as number), 0, 0, height / (box[3] as number), (-(box[0] as number) * width) / (box[2] as number), (-(box[1] as number) * height) / (box[3] as number)] : IDENTITY;
  const layers = elements(root).flatMap((child) => walk(child, { matrix: view, style: styleOf(root, {}).style, opacity: 1 }, 1));
  if (layers.length === 0) throw new SvgImportError('Nothing in this SVG file could be imported: it has no shapes or text.');
  return { width: Math.max(1, width), height: Math.max(1, height), layers, warnings: [...warnings] };
}

/**
 * Puts what was read from an SVG file into a document: a frame of the
 * drawing's size, named after the file, with the layers in it. Returns the
 * document and the frame.
 */
export function placeSvg(doc: Document, parentId: NodeId, imported: ImportedSvg, name: string, at: Point): { doc: Document; id: NodeId } {
  const frame = addLayer(doc, 'FRAME', parentId, { name, x: Math.round(at.x), y: Math.round(at.y), width: imported.width, height: imported.height, fills: [], clipsContent: true });
  let next = frame.doc;
  // What was read is placed in the drawing's space; `origin` is where the container it goes into is in that space.
  const put = (layers: readonly ImportedLayer[], into: NodeId, origin: Point): NodeId[] => {
    const ids: NodeId[] = [];
    for (const layer of layers) {
      if (layer.type === 'GROUP') {
        // What is in a group is put where the group will be, and then grouped: the group takes its box from them.
        const members = put(layer.children, into, origin);
        const grouped = members.length > 1 ? groupNodes(next, members) : null;
        if (grouped) {
          next = grouped.doc;
          const group = next.nodes[grouped.id];
          if (isLayer(group)) next = { ...next, nodes: { ...next.nodes, [grouped.id]: { ...group, name: layer.props.name ?? group.name, opacity: layer.props.opacity ?? 1 } } };
          ids.push(grouped.id);
        } else ids.push(...members);
        continue;
      }
      const props: LayerPatch = {};
      for (const key in layer.props) if ((layer.props as Record<string, unknown>)[key] !== undefined) (props as Record<string, unknown>)[key] = (layer.props as Record<string, unknown>)[key];
      const added = addLayer(next, layer.type, into, { ...props, x: (props.x ?? 0) - origin.x, y: (props.y ?? 0) - origin.y });
      next = added.doc;
      ids.push(added.id);
      // What is in a frame is placed from the frame's own corner.
      if (layer.type === 'FRAME') put(layer.children, added.id, { x: props.x ?? 0, y: props.y ?? 0 });
    }
    return ids;
  };
  put(imported.layers, frame.id, { x: 0, y: 0 });
  return { doc: next, id: frame.id };
}
