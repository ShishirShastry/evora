import { instanceOf, isInstance, propsOf, setOf } from '../components/instances';
import { isFrame, isLayer, type Document, type LayerNode, type NodeId, type Paint, type RGB } from '../document/schema';
import type { Rect } from '../math/geometry';
import { getWorldBounds } from '../scene/tree';
import { resolveVariable } from '../tokens/tokens';
import { cssColor, cssVariableName } from './code';

/**
 * What a developer is told about a layer: every figure and name read off
 * the layer itself, in the sections the inspection panel shows. Nothing
 * here is a sample; a layer without a stroke has no "Borders" section.
 */

export interface InspectRow {
  label: string;
  value: string;
  /** A colour to show beside the value. */
  color?: RGB;
  /** The name of the variable or style the value comes from. */
  token?: string;
}

export interface InspectSection {
  title: string;
  rows: InspectRow[];
}

const round = (value: number): number => Math.round(value * 100) / 100;
const px = (value: number): string => `${round(value)}px`;

function paintRow(doc: Document, node: LayerNode, key: 'fills' | 'strokes', index: number, paint: Paint): InspectRow {
  const variable = doc.variables[node.boundVariables[`${key}.${index}`] ?? ''];
  const style = doc.styles[node.styleRefs[key] ?? ''];
  const token = variable ? variable.name : style ? style.name : undefined;
  const label = node[key].length > 1 ? `${key === 'fills' ? 'Fill' : 'Stroke'} ${index + 1}` : key === 'fills' ? 'Fill' : 'Stroke';
  if (paint.type === 'SOLID') return { label, value: cssColor(paint.color, paint.opacity), color: paint.color, token };
  if (paint.type === 'IMAGE') return { label, value: `Image: ${doc.assets[paint.imageHash]?.name ?? 'missing'} (${paint.scaleMode.toLowerCase()})`, token };
  const kind = { GRADIENT_LINEAR: 'Linear', GRADIENT_RADIAL: 'Radial', GRADIENT_ANGULAR: 'Angular', GRADIENT_DIAMOND: 'Diamond' }[paint.type];
  return { label, value: `${kind} gradient: ${paint.stops.map((stop) => `${cssColor(stop.color, stop.opacity)} ${Math.round(stop.position * 100)}%`).join(', ')}`, token };
}

/** How far a layer is from each side of what it is in: the spacing a developer asks about first. */
export function spacingInParent(doc: Document, id: NodeId): { left: number; top: number; right: number; bottom: number } | null {
  const node = doc.nodes[id];
  const parent = isLayer(node) ? doc.nodes[node.parentId] : undefined;
  if (!isLayer(node) || !isLayer(parent)) return null;
  const inner = getWorldBounds(doc, id);
  const outer = getWorldBounds(doc, parent.id);
  return { left: round(inner.x - outer.x), top: round(inner.y - outer.y), right: round(outer.x + outer.width - inner.x - inner.width), bottom: round(outer.y + outer.height - inner.y - inner.height) };
}

/**
 * How far a layer is from each edge of the frame it is in: the nearest
 * frame round it, past any groups and boolean groups between. Null for a
 * layer that is in no frame (a top-level layer on the page).
 */
export function distanceToFrame(doc: Document, id: NodeId): { frameId: NodeId; frameName: string; left: number; top: number; right: number; bottom: number } | null {
  const node = doc.nodes[id];
  if (!isLayer(node)) return null;
  let current = doc.nodes[node.parentId];
  while (isLayer(current) && !isFrame(current)) current = doc.nodes[current.parentId];
  if (!isFrame(current)) return null;
  const inner = getWorldBounds(doc, id);
  const outer = getWorldBounds(doc, current.id);
  return {
    frameId: current.id,
    frameName: current.name,
    left: round(inner.x - outer.x),
    top: round(inner.y - outer.y),
    right: round(outer.x + outer.width - inner.x - inner.width),
    bottom: round(outer.y + outer.height - inner.y - inner.height),
  };
}

/** The distances between two boxes on the page, as a measurement shows them: the gap each way, or how far one edge is inside the other. */
export function distancesBetween(a: Rect, b: Rect): { horizontal: number | null; vertical: number | null } {
  const horizontal = b.x >= a.x + a.width ? b.x - a.x - a.width : a.x >= b.x + b.width ? a.x - b.x - b.width : null;
  const vertical = b.y >= a.y + a.height ? b.y - a.y - a.height : a.y >= b.y + b.height ? a.y - b.y - b.height : null;
  return { horizontal: horizontal === null ? null : round(horizontal), vertical: vertical === null ? null : round(vertical) };
}

/** Everything the inspection panel says about a layer. */
export function inspectLayer(doc: Document, id: NodeId): InspectSection[] {
  const node = doc.nodes[id];
  if (!isLayer(node)) return [];
  const sections: InspectSection[] = [];
  const section = (title: string, rows: (InspectRow | null | false)[]): void => {
    const kept = rows.filter((row): row is InspectRow => Boolean(row));
    if (kept.length > 0) sections.push({ title, rows: kept });
  };
  const variableOf = (key: string): string | undefined => doc.variables[node.boundVariables[key] ?? '']?.name;

  const world = getWorldBounds(doc, id);
  section('Layout', [
    { label: 'Width', value: px(node.width), token: variableOf('width') },
    node.type !== 'LINE' && { label: 'Height', value: px(node.height), token: variableOf('height') },
    { label: 'X', value: px(node.x) },
    { label: 'Y', value: px(node.y) },
    (world.x !== node.x || world.y !== node.y) && { label: 'On the page', value: `${round(world.x)}, ${round(world.y)}` },
    node.rotation !== 0 && { label: 'Rotation', value: `${round(node.rotation)}°` },
    node.opacity < 1 && { label: 'Opacity', value: `${Math.round(node.opacity * 100)}%`, token: variableOf('opacity') },
    (node.type === 'FRAME' || node.type === 'RECTANGLE') && (node.cornerRadii || node.cornerRadius > 0)
      ? { label: 'Corner radius', value: node.cornerRadii ? node.cornerRadii.map(px).join(' ') : px(node.cornerRadius), token: variableOf('cornerRadius') }
      : null,
    node.blendMode !== 'NORMAL' && { label: 'Blend mode', value: node.blendMode.toLowerCase().replace(/_/g, ' ') },
  ]);

  const spacing = spacingInParent(doc, id);
  if (spacing) {
    section('Spacing in its parent', [
      { label: 'Left', value: px(spacing.left) },
      { label: 'Top', value: px(spacing.top) },
      { label: 'Right', value: px(spacing.right) },
      { label: 'Bottom', value: px(spacing.bottom) },
    ]);
  }

  const parent = doc.nodes[node.parentId];
  if (isFrame(parent) && parent.layoutMode !== 'NONE') {
    const sizing = { FIXED: 'Fixed', HUG: 'Hug contents', FILL: 'Fill container' };
    section('In its layout', [
      { label: 'Width', value: sizing[node.layoutSizingHorizontal] },
      { label: 'Height', value: sizing[node.layoutSizingVertical] },
      node.layoutPositioning === 'ABSOLUTE' && { label: 'Position', value: 'Absolute (out of the flow)' },
    ]);
  }
  if (isFrame(node) && node.layoutMode !== 'NONE') {
    const align = { MIN: 'Start', CENTER: 'Centre', MAX: 'End', SPACE_BETWEEN: 'Space between', STRETCH: 'Stretch', BASELINE: 'Text baseline' };
    section('Auto Layout', [
      { label: 'Direction', value: `${node.layoutMode === 'HORIZONTAL' ? 'Horizontal' : 'Vertical'}${node.layoutWrap === 'WRAP' ? ', wraps' : ''}${node.itemsReversed ? ', reversed' : ''}` },
      { label: 'Spacing', value: node.primaryAxisAlignItems === 'SPACE_BETWEEN' ? 'Auto' : px(node.itemSpacing), token: variableOf('itemSpacing') },
      node.layoutWrap === 'WRAP' && { label: 'Between lines', value: px(node.counterAxisSpacing) },
      { label: 'Padding', value: [node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft].map(px).join(' '), token: variableOf('paddingLeft') ?? variableOf('paddingTop') },
      { label: 'Along', value: align[node.primaryAxisAlignItems] },
      { label: 'Across', value: align[node.counterAxisAlignItems] },
    ]);
  }

  if (node.type === 'TEXT') {
    const style = doc.styles[node.styleRefs.text ?? ''];
    section('Typography', [
      style ? { label: 'Text style', value: style.name } : null,
      { label: 'Font', value: node.fontFamily, token: variableOf('fontFamily') },
      { label: 'Size', value: px(node.fontSize), token: variableOf('fontSize') },
      { label: 'Weight', value: `${node.fontWeight}${node.italic ? ' italic' : ''}` },
      { label: 'Line height', value: node.lineHeight === null ? 'Auto' : px(node.lineHeight), token: variableOf('lineHeight') },
      node.letterSpacing !== 0 && { label: 'Letter spacing', value: px(node.letterSpacing), token: variableOf('letterSpacing') },
      { label: 'Align', value: node.textAlign.toLowerCase() },
      node.textDecoration !== 'NONE' && { label: 'Decoration', value: node.textDecoration.toLowerCase() },
      node.textCase !== 'ORIGINAL' && { label: 'Case', value: node.textCase.toLowerCase() },
      { label: 'Content', value: node.characters, token: variableOf('characters') },
    ]);
  }

  section(
    'Colours',
    node.fills.map((paint, index) => (paint.visible && paint.opacity > 0 && node.type !== 'LINE' ? paintRow(doc, node, 'fills', index, paint) : null)),
  );

  if (node.strokeWeight > 0 && node.strokes.some((paint) => paint.visible)) {
    section('Borders', [
      ...node.strokes.map((paint, index) => (paint.visible && paint.opacity > 0 ? paintRow(doc, node, 'strokes', index, paint) : null)),
      { label: 'Weight', value: px(node.strokeWeight), token: variableOf('strokeWeight') },
      node.type !== 'LINE' && node.type !== 'TEXT' && { label: 'Position', value: node.strokeAlign.toLowerCase() },
      node.dashPattern.length > 0 && { label: 'Dashes', value: node.dashPattern.map(round).join(', ') },
    ]);
  }

  section(
    'Effects',
    node.effects
      .filter((effect) => effect.visible)
      .map((effect) => {
        if (effect.type === 'DROP_SHADOW' || effect.type === 'INNER_SHADOW') {
          return { label: effect.type === 'DROP_SHADOW' ? 'Drop shadow' : 'Inner shadow', value: `${px(effect.offsetX)} ${px(effect.offsetY)} ${px(effect.blur)} ${px(effect.spread)} ${cssColor(effect.color, effect.opacity)}`, color: effect.color, token: doc.styles[node.styleRefs.effects ?? '']?.name };
        }
        return { label: effect.type === 'LAYER_BLUR' ? 'Layer blur' : 'Background blur', value: px((effect as { radius: number }).radius), token: doc.styles[node.styleRefs.effects ?? '']?.name };
      }),
  );

  // The component it is, or is an instance of, and what the instance is set to.
  const instance = isInstance(node) ? node : instanceOf(doc, id);
  const componentId = instance?.componentId ?? (isFrame(node) && node.kind === 'COMPONENT' ? node.id : null);
  const component = componentId === null ? undefined : doc.nodes[componentId];
  if (isFrame(component)) {
    const set = setOf(doc, component.id);
    const rows: InspectRow[] = [{ label: instance ? 'Instance of' : 'Component', value: set ? set.name : component.name }];
    for (const name in component.variantProps) rows.push({ label: name, value: component.variantProps[name] as string });
    for (const prop of propsOf(doc, component.id)) {
      const value = instance?.propValues[prop.id];
      if (value !== undefined) rows.push({ label: prop.name, value: prop.type === 'INSTANCE_SWAP' ? (doc.nodes[String(value)]?.name ?? '') : String(value) });
    }
    if (component.description) rows.push({ label: 'Description', value: component.description });
    if (instance && instance.id !== id) rows.push({ label: 'This layer', value: 'is part of the instance' });
    section('Component', rows);
  }

  // Variables and the value each has here, in the mode that applies to this layer.
  const tokens: InspectRow[] = [];
  for (const key in node.boundVariables) {
    const variable = doc.variables[node.boundVariables[key] as string];
    if (!variable) continue;
    const value = resolveVariable(doc, variable.id, id);
    const shown = value === null ? 'no value' : typeof value === 'object' ? cssColor(value) : String(value);
    tokens.push({ label: variable.name, value: `${shown} (${cssVariableName(variable.name)})`, color: value !== null && typeof value === 'object' ? value : undefined });
  }
  for (const ref of ['fills', 'strokes', 'text', 'effects', 'grids'] as const) {
    const style = doc.styles[node.styleRefs[ref] ?? ''];
    if (style) tokens.push({ label: `${{ fills: 'Fill', strokes: 'Stroke', text: 'Text', effects: 'Effect', grids: 'Grid' }[ref]} style`, value: style.name });
  }
  section('Variables and styles', tokens);
  return sections;
}
