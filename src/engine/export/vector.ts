import {
  getChildIds,
  getLocalMatrix,
  getWorldMatrix,
  hasVisiblePaint,
  isLayer,
  layoutText,
  multiply,
  translation,
  type BlendMode,
  type Document,
  type Effect,
  type LayerNode,
  type Matrix,
  type NodeId,
  type Paint,
  type Point,
  type StrokeCap,
  type StrokeJoin,
  type TextLine,
  type TextMeasurer,
  type TextNode,
} from '../../core';
import { strokeSideBands, arrowHeads, fillRuleOf, traceArrowHead, traceLayerPath, traceStrokePath, type PathContext } from '../render/paint';
import { strokeAlignOf } from '../render/scene';

/**
 * What a design is made of when it is exported as vectors: groups with a
 * place, an opacity and a clip; shapes filled and stroked with paints; and
 * text. It is built from the document by the same rules the canvas is
 * painted by (the same outlines, the same order, the same stroke alignment),
 * and the SVG and PDF writers both work from it, so the two agree with each
 * other and with what is on the screen.
 */

export type Segment = { op: 'M' | 'L'; x: number; y: number } | { op: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number } | { op: 'Z' };
export type FillRule = 'nonzero' | 'evenodd';

export interface Clip {
  path: Segment[];
  rule: FillRule;
}

export interface VectorFill {
  kind: 'fill';
  path: Segment[];
  rule: FillRule;
  paint: Paint;
  /** The box of the layer, which gradients and images are laid out in. */
  width: number;
  height: number;
}

export interface VectorStroke {
  kind: 'stroke';
  path: Segment[];
  paint: Paint;
  /** The width of the line that is drawn. For a stroke inside or outside the outline it is twice the stroke's weight, and `clip` keeps half of it. */
  lineWidth: number;
  cap: StrokeCap;
  join: StrokeJoin;
  dash: number[];
  clip: Clip | null;
  width: number;
  height: number;
}

export interface VectorText {
  kind: 'text';
  node: TextNode;
  lines: TextLine[];
}

export interface VectorGroup {
  kind: 'group';
  /** The layer this group is, or null for a group that only holds others (what is in a frame, what a mask governs). */
  layerId: NodeId | null;
  name: string;
  matrix: Matrix;
  opacity: number;
  blend: BlendMode;
  effects: Effect[];
  /** Clips everything in the group. */
  clip: Clip | null;
  /** Shows the group only where this other group paints. */
  mask: VectorGroup | null;
  items: VectorItem[];
}

export type VectorItem = VectorFill | VectorStroke | VectorText | VectorGroup;

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** Builds a path from the calls a canvas would get, with arcs turned into curves. */
export class PathRecorder implements PathContext {
  segments: Segment[] = [];
  private current: Point | null = null;
  private start: Point | null = null;

  beginPath(): void {
    this.segments = [];
    this.current = null;
    this.start = null;
  }

  moveTo(x: number, y: number): void {
    this.segments.push({ op: 'M', x, y });
    this.current = { x, y };
    this.start = { x, y };
  }

  lineTo(x: number, y: number): void {
    if (!this.current) {
      this.moveTo(x, y);
      return;
    }
    this.segments.push({ op: 'L', x, y });
    this.current = { x, y };
  }

  bezierCurveTo(x1: number, y1: number, x2: number, y2: number, x: number, y: number): void {
    if (!this.current) this.moveTo(x1, y1);
    this.segments.push({ op: 'C', x1, y1, x2, y2, x, y });
    this.current = { x, y };
  }

  closePath(): void {
    if (!this.current) return;
    this.segments.push({ op: 'Z' });
    this.current = this.start;
  }

  rect(x: number, y: number, w: number, h: number): void {
    this.moveTo(x, y);
    this.lineTo(x + w, y);
    this.lineTo(x + w, y + h);
    this.lineTo(x, y + h);
    this.closePath();
  }

  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number, counterclockwise = false): void {
    this.ellipse(x, y, radius, radius, 0, startAngle, endAngle, counterclockwise);
  }

  ellipse(cx: number, cy: number, rx: number, ry: number, rotation: number, startAngle: number, endAngle: number, counterclockwise = false): void {
    const full = Math.PI * 2;
    let sweep = endAngle - startAngle;
    if (!counterclockwise) {
      if (sweep >= full) sweep = full;
      else sweep = ((sweep % full) + full) % full;
    } else if (sweep <= -full) sweep = -full;
    else sweep = -((((-sweep) % full) + full) % full);
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    const at = (angle: number): Point => {
      const px = rx * Math.cos(angle);
      const py = ry * Math.sin(angle);
      return { x: cx + px * cos - py * sin, y: cy + px * sin + py * cos };
    };
    const tangent = (angle: number): Point => {
      const px = -rx * Math.sin(angle);
      const py = ry * Math.cos(angle);
      return { x: px * cos - py * sin, y: px * sin + py * cos };
    };
    const first = at(startAngle);
    // As on a canvas: a line from where the path is to where the arc starts.
    if (this.current) this.lineTo(first.x, first.y);
    else this.moveTo(first.x, first.y);
    const pieces = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-9));
    const step = sweep / pieces;
    const handle = (4 / 3) * Math.tan(step / 4);
    for (let i = 0; i < pieces; i++) {
      const a0 = startAngle + step * i;
      const a1 = a0 + step;
      const p0 = at(a0);
      const p1 = at(a1);
      const t0 = tangent(a0);
      const t1 = tangent(a1);
      this.segments.push({ op: 'C', x1: p0.x + t0.x * handle, y1: p0.y + t0.y * handle, x2: p1.x - t1.x * handle, y2: p1.y - t1.y * handle, x: p1.x, y: p1.y });
      this.current = p1;
    }
  }

  arcTo(x1: number, y1: number, x2: number, y2: number, radius: number): void {
    const from = this.current;
    if (!from) {
      this.moveTo(x1, y1);
      return;
    }
    const ax = from.x - x1;
    const ay = from.y - y1;
    const bx = x2 - x1;
    const by = y2 - y1;
    const la = Math.hypot(ax, ay);
    const lb = Math.hypot(bx, by);
    const cross = ax * by - ay * bx;
    if (radius <= 0 || la < 1e-9 || lb < 1e-9 || Math.abs(cross) < 1e-9) {
      this.lineTo(x1, y1);
      return;
    }
    const angle = Math.acos(Math.min(1, Math.max(-1, (ax * bx + ay * by) / (la * lb))));
    const along = radius / Math.tan(angle / 2);
    const start = { x: x1 + (ax / la) * along, y: y1 + (ay / la) * along };
    const end = { x: x1 + (bx / lb) * along, y: y1 + (by / lb) * along };
    this.lineTo(start.x, start.y);
    // A corner of up to a quarter turn is one curve; the control points lie on the two sides.
    const k = (4 / 3) * Math.tan((Math.PI - angle) / 4);
    this.segments.push({ op: 'C', x1: start.x - (ax / la) * radius * k, y1: start.y - (ay / la) * radius * k, x2: end.x - (bx / lb) * radius * k, y2: end.y - (by / lb) * radius * k, x: end.x, y: end.y });
    this.current = end;
  }
}

function record(trace: (ctx: PathContext) => void): Segment[] {
  const recorder = new PathRecorder();
  trace(recorder);
  return recorder.segments;
}

const visible = (paint: Paint): boolean => paint.visible && paint.opacity > 0;

/** What a layer paints itself: its fills, then what is in it, then its strokes. */
function layerGroup(doc: Document, id: NodeId, measurer: TextMeasurer, hidden: ReadonlySet<NodeId> | undefined): VectorGroup | null {
  const node = doc.nodes[id];
  if (!isLayer(node) || !node.visible || node.opacity <= 0 || hidden?.has(id)) return null;
  const group: VectorGroup = {
    kind: 'group',
    layerId: id,
    name: node.name,
    matrix: getLocalMatrix(node),
    opacity: node.opacity,
    blend: node.blendMode,
    effects: node.effects.filter((effect) => effect.visible),
    clip: null,
    mask: null,
    items: [],
  };
  if (node.type === 'TEXT') {
    group.items.push({ kind: 'text', node, lines: layoutText(node, measurer).lines });
    return group;
  }
  const rule = fillRuleOf(node);
  if (node.type !== 'LINE') {
    const outline = hasVisiblePaint(node.fills) ? record((ctx) => traceLayerPath(ctx, node)) : [];
    for (const paint of node.fills) {
      if (visible(paint)) group.items.push({ kind: 'fill', path: outline, rule, paint, width: node.width, height: node.height });
    }
  }
  if (node.type === 'FRAME' || node.type === 'GROUP') {
    const children = childItems(doc, id, measurer, hidden);
    if (children.length > 0) {
      group.items.push({
        kind: 'group',
        layerId: null,
        name: '',
        matrix: IDENTITY,
        opacity: 1,
        blend: 'NORMAL',
        effects: [],
        clip: node.type === 'FRAME' && node.clipsContent ? { path: record((ctx) => traceLayerPath(ctx, node)), rule: 'nonzero' } : null,
        mask: null,
        items: children,
      });
    }
  }
  const bands = strokeSideBands(node);
  if (bands && node.strokes.some(visible)) {
    const area = record((ctx) => {
      ctx.beginPath();
      for (const band of bands) ctx.rect(band.x, band.y, band.width, band.height);
    });
    const inside = node.strokeAlign === 'INSIDE' ? record((ctx) => traceLayerPath(ctx, node)) : null;
    for (const paint of node.strokes) {
      if (!visible(paint)) continue;
      const fill: VectorFill = { kind: 'fill', path: area, rule: 'nonzero', paint, width: node.width, height: node.height };
      group.items.push(inside ? { kind: 'group', layerId: null, name: '', matrix: IDENTITY, opacity: 1, blend: 'NORMAL', effects: [], clip: { path: inside, rule: 'nonzero' }, mask: null, items: [fill] } : fill);
    }
  } else if (node.strokeWeight > 0 && node.strokes.some(visible)) {
    const align = strokeAlignOf(node);
    const heads = arrowHeads(node);
    const base = { cap: node.strokeCap, join: node.strokeJoin, dash: [...node.dashPattern], width: node.width, height: node.height };
    for (const paint of node.strokes) {
      if (!visible(paint)) continue;
      if (align === 'CENTER') {
        group.items.push({ kind: 'stroke', path: record((ctx) => traceStrokePath(ctx, node)), paint, lineWidth: node.strokeWeight, clip: null, ...base });
        for (const head of heads) {
          const path = record((ctx) => traceArrowHead(ctx, head));
          // An arrowhead is solid whatever the stroke's dashes: filled, or drawn as a line.
          if (head.filled) group.items.push({ kind: 'fill', path, rule: 'nonzero', paint, width: node.width, height: node.height });
          else group.items.push({ kind: 'stroke', path, paint, lineWidth: node.strokeWeight, clip: null, ...base, dash: [] });
        }
        continue;
      }
      // Inside and outside: a line twice as wide, of which the half on the wanted side of the outline is kept.
      const outline = record((ctx) => traceLayerPath(ctx, node));
      let clip: Clip = { path: outline, rule };
      if (align === 'OUTSIDE') {
        const pad = node.strokeWeight * 2 + 2;
        const around = record((ctx) => {
          ctx.beginPath();
          ctx.rect(-pad, -pad, node.width + pad * 2, node.height + pad * 2);
        });
        clip = { path: [...outline, ...around], rule: 'evenodd' };
      }
      group.items.push({ kind: 'stroke', path: record((ctx) => traceLayerPath(ctx, node, 0, 'stroke')), paint, lineWidth: node.strokeWeight * 2, clip, ...base });
    }
  }
  return group;
}

/** The layers of a container, bottom first, with each mask made the mask of the layers above it up to the next. */
function childItems(doc: Document, parentId: NodeId, measurer: TextMeasurer, hidden: ReadonlySet<NodeId> | undefined): VectorItem[] {
  const out: VectorItem[] = [];
  const ids = getChildIds(doc, parentId);
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i] as NodeId;
    const node = doc.nodes[id];
    if (!isLayer(node) || !node.isMask) {
      const group = layerGroup(doc, id, measurer, hidden);
      if (group) out.push(group);
      continue;
    }
    let end = i + 1;
    while (end < ids.length) {
      const next = doc.nodes[ids[end] as NodeId];
      if (isLayer(next) && next.isMask) break;
      end++;
    }
    const above = ids.slice(i + 1, end).map((other) => layerGroup(doc, other, measurer, hidden)).filter((group): group is VectorGroup => group !== null);
    const mask = node.visible && !hidden?.has(id) ? layerGroup(doc, id, measurer, hidden) : null;
    if (!mask) out.push(...above);
    else if (above.length > 0) out.push({ kind: 'group', layerId: null, name: `${node.name} (mask)`, matrix: IDENTITY, opacity: 1, blend: 'NORMAL', effects: [], clip: null, mask, items: above });
    i = end - 1;
  }
  return out;
}

export interface VectorSceneOptions {
  measurer: TextMeasurer;
  /** The page-space point that becomes (0, 0). */
  origin: Point;
  hiddenIds?: ReadonlySet<NodeId>;
}

/**
 * The vector scene of some layers, each with everything in it, in the order
 * given (bottom first), or of a whole page when `pageId` is given instead.
 */
export function buildVectorScene(doc: Document, roots: readonly NodeId[] | { pageId: NodeId }, options: VectorSceneOptions): VectorGroup {
  const scene: VectorGroup = { kind: 'group', layerId: null, name: '', matrix: translation(-options.origin.x, -options.origin.y), opacity: 1, blend: 'NORMAL', effects: [], clip: null, mask: null, items: [] };
  if (!Array.isArray(roots)) {
    scene.items = childItems(doc, (roots as { pageId: NodeId }).pageId, options.measurer, options.hiddenIds);
    return scene;
  }
  for (const id of roots as readonly NodeId[]) {
    const node = doc.nodes[id];
    const group = layerGroup(doc, id, options.measurer, options.hiddenIds);
    if (!group || !isLayer(node)) continue;
    // A layer taken out of what it is in keeps its place on the page, measured from the origin.
    group.matrix = multiply(scene.matrix, multiply(getWorldMatrix(doc, node.parentId), group.matrix));
    scene.items.push(group);
  }
  scene.matrix = IDENTITY;
  return scene;
}

/** A layer's own outline in its own space, for whoever needs just that. */
export function layerOutline(node: LayerNode): Segment[] {
  return record((ctx) => traceLayerPath(ctx, node));
}
