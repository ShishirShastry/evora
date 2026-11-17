import { instanceOf, isInstance, propsOf, setOf } from '../components/instances';
import { isFrame, isLayer, type CodeConnect, type Document, type FrameNode, type GradientPaint, type LayerNode, type NodeId, type Paint, type RGB } from '../document/schema';
import { getChildIds } from '../scene/tree';

/**
 * Code for a layer, written from the layer itself: CSS, and the nearest
 * thing in SwiftUI and in Jetpack Compose. Where a property is bound to a
 * variable, the CSS names the variable and gives the value as the fallback.
 */

const round = (value: number, places = 2): number => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};
const px = (value: number): string => (round(value) === 0 ? '0' : `${round(value)}px`);
const byte = (value: number): number => Math.round(Math.min(1, Math.max(0, value)) * 255);
const hex2 = (value: number): string => byte(value).toString(16).padStart(2, '0').toUpperCase();

/** A colour as CSS writes it: #RRGGBB, or rgba() when it is partly transparent. */
export function cssColor(color: RGB, opacity = 1): string {
  if (opacity >= 1) return `#${hex2(color.r)}${hex2(color.g)}${hex2(color.b)}`;
  return `rgba(${byte(color.r)}, ${byte(color.g)}, ${byte(color.b)}, ${round(opacity)})`;
}

/** The name of a variable as a CSS custom property: "Brand/Primary 500" is --brand-primary-500. */
export function cssVariableName(name: string): string {
  const cleaned = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `--${cleaned || 'variable'}`;
}

function gradientCss(paint: GradientPaint, width: number, height: number): string {
  const stops = paint.stops.map((stop) => `${cssColor(stop.color, stop.opacity * paint.opacity)} ${round(stop.position * 100)}%`).join(', ');
  if (paint.type === 'GRADIENT_LINEAR') {
    // The angle CSS counts from "to top", clockwise; the handles give the direction in the layer's own pixels.
    const angle = (Math.atan2((paint.to.y - paint.from.y) * height, (paint.to.x - paint.from.x) * width) * 180) / Math.PI + 90;
    return `linear-gradient(${round(((angle % 360) + 360) % 360, 1)}deg, ${stops})`;
  }
  const at = `${round(paint.from.x * 100)}% ${round(paint.from.y * 100)}%`;
  if (paint.type === 'GRADIENT_ANGULAR') return `conic-gradient(from ${round((Math.atan2(paint.to.y - paint.from.y, paint.to.x - paint.from.x) * 180) / Math.PI + 90, 1)}deg at ${at}, ${stops})`;
  // A diamond gradient has no CSS of its own; a radial one is the nearest.
  return `radial-gradient(ellipse at ${at}, ${stops})`;
}

function paintCss(paint: Paint, node: LayerNode, doc: Document): string {
  if (paint.type === 'SOLID') return cssColor(paint.color, paint.opacity);
  if (paint.type === 'IMAGE') {
    const name = doc.assets[paint.imageHash]?.name ?? 'image';
    const size = paint.scaleMode === 'FIT' ? 'contain' : paint.scaleMode === 'TILE' ? 'auto' : 'cover';
    return `url("${name}") center / ${size} ${paint.scaleMode === 'TILE' ? 'repeat' : 'no-repeat'}`;
  }
  return gradientCss(paint, node.width, node.height);
}

/** The variable a property of a layer is bound to, as `var(--name, fallback)`, or the value alone when it is not bound. */
function bound(doc: Document, node: LayerNode, key: string, value: string): string {
  const variable = doc.variables[node.boundVariables[key] ?? ''];
  return variable ? `var(${cssVariableName(variable.name)}, ${value})` : value;
}

const visiblePaints = (paints: readonly Paint[]): Paint[] => paints.filter((paint) => paint.visible && paint.opacity > 0);

/** The CSS of a layer, one declaration a line. */
export function cssFor(doc: Document, id: NodeId): string {
  const node = doc.nodes[id];
  if (!isLayer(node)) return '';
  const out: string[] = [];
  const add = (property: string, value: string): void => {
    out.push(`${property}: ${value};`);
  };
  const parent = doc.nodes[node.parentId];
  const inLayout = isFrame(parent) && parent.layoutMode !== 'NONE' && node.layoutPositioning !== 'ABSOLUTE';

  // Where it is and how big.
  if (isFrame(parent) && !inLayout) {
    add('position', 'absolute');
    add('left', px(node.x));
    add('top', px(node.y));
  }
  const fills = (axis: 'layoutSizingHorizontal' | 'layoutSizingVertical'): boolean => inLayout && node[axis] === 'FILL';
  const hugs = (axis: 'layoutSizingHorizontal' | 'layoutSizingVertical'): boolean => node[axis] === 'HUG';
  if (node.type !== 'LINE' || node.width > 0) {
    if (fills('layoutSizingHorizontal')) add(isFrame(parent) && parent.layoutMode === 'HORIZONTAL' ? 'flex' : 'align-self', isFrame(parent) && parent.layoutMode === 'HORIZONTAL' ? '1 0 0' : 'stretch');
    else add('width', hugs('layoutSizingHorizontal') ? 'fit-content' : bound(doc, node, 'width', px(node.width)));
  }
  if (node.type !== 'LINE') {
    if (fills('layoutSizingVertical')) add(isFrame(parent) && parent.layoutMode === 'VERTICAL' ? 'flex' : 'align-self', isFrame(parent) && parent.layoutMode === 'VERTICAL' ? '1 0 0' : 'stretch');
    else add('height', hugs('layoutSizingVertical') ? 'fit-content' : bound(doc, node, 'height', px(node.height)));
  }
  for (const [limit, property] of [['minWidth', 'min-width'], ['maxWidth', 'max-width'], ['minHeight', 'min-height'], ['maxHeight', 'max-height']] as const) {
    const value = node[limit];
    if (value !== null) add(property, px(value));
  }
  if (node.rotation !== 0) add('transform', `rotate(${round(node.rotation)}deg)`);
  if (node.opacity < 1) add('opacity', bound(doc, node, 'opacity', String(round(node.opacity))));
  if (!node.visible) add('display', 'none');

  // Auto Layout is flexbox.
  if (isFrame(node) && node.layoutMode !== 'NONE') {
    add('display', 'flex');
    add('flex-direction', `${node.layoutMode === 'HORIZONTAL' ? 'row' : 'column'}${node.itemsReversed ? '-reverse' : ''}`);
    if (node.layoutWrap === 'WRAP') add('flex-wrap', 'wrap');
    const justify = { MIN: 'flex-start', CENTER: 'center', MAX: 'flex-end', SPACE_BETWEEN: 'space-between' }[node.primaryAxisAlignItems];
    const align = { MIN: 'flex-start', CENTER: 'center', MAX: 'flex-end', STRETCH: 'stretch', BASELINE: node.layoutMode === 'HORIZONTAL' ? 'baseline' : 'flex-start' }[node.counterAxisAlignItems];
    add('justify-content', justify);
    add('align-items', align);
    if (node.primaryAxisAlignItems !== 'SPACE_BETWEEN' && node.itemSpacing !== 0) {
      const gap = bound(doc, node, 'itemSpacing', px(node.itemSpacing));
      add('gap', node.layoutWrap === 'WRAP' && node.counterAxisSpacing !== node.itemSpacing ? (node.layoutMode === 'HORIZONTAL' ? `${px(node.counterAxisSpacing)} ${gap}` : `${gap} ${px(node.counterAxisSpacing)}`) : gap);
    }
    const sides = [bound(doc, node, 'paddingTop', px(node.paddingTop)), bound(doc, node, 'paddingRight', px(node.paddingRight)), bound(doc, node, 'paddingBottom', px(node.paddingBottom)), bound(doc, node, 'paddingLeft', px(node.paddingLeft))];
    if (sides.some((side) => side !== '0')) {
      const [top, right, bottom, left] = sides as [string, string, string, string];
      add('padding', top === right && right === bottom && bottom === left ? top : top === bottom && left === right ? `${top} ${right}` : `${top} ${right} ${bottom} ${left}`);
    }
  }
  if (isFrame(node) && node.clipsContent && getChildIds(doc, id).length > 0) add('overflow', node.overflow === 'NONE' ? 'hidden' : node.overflow === 'HORIZONTAL' ? 'auto hidden' : node.overflow === 'VERTICAL' ? 'hidden auto' : 'auto');

  // What it looks like.
  const paints = visiblePaints(node.fills);
  if (node.type === 'TEXT') {
    const first = paints[0];
    if (first?.type === 'SOLID') add('color', bound(doc, node, 'fills.0', cssColor(first.color, first.opacity)));
    else if (first && first.type !== 'IMAGE') {
      add('background', paintCss(first, node, doc));
      add('-webkit-background-clip', 'text');
      add('color', 'transparent');
    }
    add('font-family', bound(doc, node, 'fontFamily', /^[A-Za-z0-9-]+$/.test(node.fontFamily) ? node.fontFamily : `"${node.fontFamily}"`));
    add('font-size', bound(doc, node, 'fontSize', px(node.fontSize)));
    add('font-weight', String(node.fontWeight));
    if (node.italic) add('font-style', 'italic');
    add('line-height', node.lineHeight === null ? 'normal' : bound(doc, node, 'lineHeight', px(node.lineHeight)));
    if (node.letterSpacing !== 0) add('letter-spacing', bound(doc, node, 'letterSpacing', px(node.letterSpacing)));
    if (node.textAlign !== 'LEFT') add('text-align', { CENTER: 'center', RIGHT: 'right', JUSTIFIED: 'justify', LEFT: 'left' }[node.textAlign]);
    if (node.textDecoration !== 'NONE') add('text-decoration', node.textDecoration === 'UNDERLINE' ? 'underline' : 'line-through');
    if (node.textCase !== 'ORIGINAL') add('text-transform', { UPPER: 'uppercase', LOWER: 'lowercase', TITLE: 'capitalize', ORIGINAL: 'none' }[node.textCase]);
  } else if (node.type !== 'LINE' && node.type !== 'GROUP' && paints.length > 0) {
    // CSS paints the first background on top; the document paints the last fill on top.
    const layers = [...paints].reverse().map((paint, index) => {
      const key = `fills.${node.fills.indexOf(paint)}`;
      const css = paintCss(paint, node, doc);
      // Only the bottom layer of a CSS background may be a plain colour.
      if (paint.type === 'SOLID' && index < paints.length - 1) return `linear-gradient(${css}, ${css})`;
      return paint.type === 'SOLID' ? bound(doc, node, key, css) : css;
    });
    add('background', layers.join(', '));
  }
  if ((node.type === 'FRAME' || node.type === 'RECTANGLE') && (node.cornerRadii || node.cornerRadius > 0)) {
    const radii = node.cornerRadii;
    add('border-radius', radii ? radii.map(px).join(' ') : bound(doc, node, 'cornerRadius', px(node.cornerRadius)));
  }
  if (node.type === 'ELLIPSE') add('border-radius', '50%');
  const strokes = visiblePaints(node.strokes);
  const stroke = strokes[strokes.length - 1];
  if (stroke && node.strokeWeight > 0 && node.type !== 'TEXT') {
    const colour = stroke.type === 'SOLID' ? bound(doc, node, `strokes.${node.strokes.indexOf(stroke)}`, cssColor(stroke.color, stroke.opacity)) : stroke.type === 'IMAGE' ? 'currentColor' : cssColor((stroke.stops[0] as GradientPaint['stops'][number]).color);
    const style = node.dashPattern.length > 0 ? 'dashed' : 'solid';
    const weight = bound(doc, node, 'strokeWeight', px(node.strokeWeight));
    if (node.type === 'LINE') add('border-top', `${weight} ${style} ${colour}`);
    else if (node.strokeAlign === 'OUTSIDE') add('outline', `${weight} ${style} ${colour}`);
    else add('border', `${weight} ${style} ${colour}`);
    if (node.strokeAlign === 'INSIDE' && node.type !== 'LINE') add('box-sizing', 'border-box');
  }
  const shadows: string[] = [];
  const filters: string[] = [];
  for (const effect of node.effects) {
    if (!effect.visible) continue;
    if (effect.type === 'DROP_SHADOW' || effect.type === 'INNER_SHADOW') {
      // A shadow of text has no spread and cannot be inside the letters.
      if (node.type === 'TEXT') shadows.push(`${px(effect.offsetX)} ${px(effect.offsetY)} ${px(effect.blur)} ${cssColor(effect.color, effect.opacity)}`);
      else shadows.push(`${effect.type === 'INNER_SHADOW' ? 'inset ' : ''}${px(effect.offsetX)} ${px(effect.offsetY)} ${px(effect.blur)} ${px(effect.spread)} ${cssColor(effect.color, effect.opacity)}`);
    } else if (effect.type === 'LAYER_BLUR') filters.push(`blur(${px(effect.radius)})`);
    else if (effect.type === 'BACKGROUND_BLUR') add('backdrop-filter', `blur(${px(effect.radius)})`);
  }
  if (shadows.length > 0) add(node.type === 'TEXT' ? 'text-shadow' : 'box-shadow', shadows.join(', '));
  if (filters.length > 0) add('filter', filters.join(' '));
  if (node.blendMode !== 'NORMAL') add('mix-blend-mode', node.blendMode.toLowerCase().replace(/_/g, '-'));
  return out.join('\n');
}

export const swiftColor = (color: RGB, opacity = 1): string => `Color(red: ${round(color.r, 3)}, green: ${round(color.g, 3)}, blue: ${round(color.b, 3)}${opacity < 1 ? `, opacity: ${round(opacity)}` : ''})`;
export const swiftString = (text: string): string => `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
const SWIFT_WEIGHTS: Record<number, string> = { 100: 'ultraLight', 200: 'thin', 300: 'light', 400: 'regular', 500: 'medium', 600: 'semibold', 700: 'bold', 800: 'heavy', 900: 'black' };

/** A layer as SwiftUI would make it: the view it is nearest to, with modifiers for its size and look. */
export function swiftFor(doc: Document, id: NodeId): string {
  const node = doc.nodes[id];
  if (!isLayer(node)) return '';
  const lines: string[] = [];
  const fill = visiblePaints(node.fills)[0];
  const colour = fill?.type === 'SOLID' ? swiftColor(fill.color, fill.opacity) : fill && fill.type !== 'IMAGE' ? `LinearGradient(colors: [${fill.stops.map((stop) => swiftColor(stop.color, stop.opacity)).join(', ')}], startPoint: UnitPoint(x: ${round(fill.from.x)}, y: ${round(fill.from.y)}), endPoint: UnitPoint(x: ${round(fill.to.x)}, y: ${round(fill.to.y)}))` : null;
  const radius = (node.type === 'FRAME' || node.type === 'RECTANGLE') && !node.cornerRadii ? node.cornerRadius : 0;
  const shape = node.type === 'ELLIPSE' ? 'Ellipse()' : radius > 0 ? `RoundedRectangle(cornerRadius: ${round(radius)})` : 'Rectangle()';
  if (node.type === 'TEXT') {
    lines.push(`Text(${swiftString(node.characters)})`);
    lines.push(`    .font(.custom(${swiftString(node.fontFamily)}, size: ${round(node.fontSize)}))`);
    if (node.fontWeight !== 400) lines.push(`    .fontWeight(.${SWIFT_WEIGHTS[node.fontWeight] ?? 'regular'})`);
    if (node.italic) lines.push('    .italic()');
    if (colour) lines.push(`    .foregroundStyle(${colour})`);
    if (node.letterSpacing !== 0) lines.push(`    .kerning(${round(node.letterSpacing)})`);
    if (node.lineHeight !== null) lines.push(`    .lineSpacing(${round(Math.max(0, node.lineHeight - node.fontSize * 1.2))})`);
    if (node.textAlign !== 'LEFT') lines.push(`    .multilineTextAlignment(.${node.textAlign === 'CENTER' ? 'center' : node.textAlign === 'RIGHT' ? 'trailing' : 'leading'})`);
    if (node.textDecoration === 'UNDERLINE') lines.push('    .underline()');
    if (node.textDecoration === 'STRIKETHROUGH') lines.push('    .strikethrough()');
  } else if (isFrame(node) && getChildIds(doc, id).length > 0) {
    const children = getChildIds(doc, id).map((childId) => doc.nodes[childId]?.name ?? '');
    const stack = node.layoutMode === 'HORIZONTAL' ? `HStack(spacing: ${round(node.itemSpacing)})` : node.layoutMode === 'VERTICAL' ? `VStack(spacing: ${round(node.itemSpacing)})` : 'ZStack(alignment: .topLeading)';
    lines.push(`${stack} {`);
    for (const child of children) lines.push(`    // ${child}`);
    lines.push('}');
    if (node.layoutMode !== 'NONE' && (node.paddingTop || node.paddingLeft || node.paddingBottom || node.paddingRight)) {
      lines.push(`    .padding(EdgeInsets(top: ${round(node.paddingTop)}, leading: ${round(node.paddingLeft)}, bottom: ${round(node.paddingBottom)}, trailing: ${round(node.paddingRight)}))`);
    }
    if (colour) lines.push(`    .background(${colour})`);
    if (radius > 0) lines.push(`    .clipShape(${shape})`);
    else if (node.clipsContent) lines.push('    .clipped()');
  } else {
    lines.push(shape);
    if (colour) lines.push(`    .fill(${colour})`);
  }
  const stroke = visiblePaints(node.strokes)[0];
  if (stroke?.type === 'SOLID' && node.strokeWeight > 0 && node.type !== 'TEXT') lines.push(`    .overlay(${shape}.stroke(${swiftColor(stroke.color, stroke.opacity)}, lineWidth: ${round(node.strokeWeight)}))`);
  if (node.type !== 'TEXT' || node.layoutSizingHorizontal === 'FIXED') lines.push(`    .frame(width: ${round(node.width)}, height: ${round(node.height)})`);
  for (const effect of node.effects) {
    if (!effect.visible) continue;
    if (effect.type === 'DROP_SHADOW') lines.push(`    .shadow(color: ${swiftColor(effect.color, effect.opacity)}, radius: ${round(effect.blur / 2)}, x: ${round(effect.offsetX)}, y: ${round(effect.offsetY)})`);
    else if (effect.type === 'LAYER_BLUR') lines.push(`    .blur(radius: ${round(effect.radius)})`);
  }
  if (node.opacity < 1) lines.push(`    .opacity(${round(node.opacity)})`);
  if (node.rotation !== 0) lines.push(`    .rotationEffect(.degrees(${round(node.rotation)}))`);
  return lines.join('\n');
}

export const composeColor = (color: RGB, opacity = 1): string => `Color(0x${hex2(opacity)}${hex2(color.r)}${hex2(color.g)}${hex2(color.b)})`;
export const kotlinString = (text: string): string => `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/\n/g, '\\n')}"`;
const dp = (value: number): string => `${round(value)}.dp`;

/** A layer as Jetpack Compose would make it. */
export function composeFor(doc: Document, id: NodeId): string {
  const node = doc.nodes[id];
  if (!isLayer(node)) return '';
  const fill = visiblePaints(node.fills)[0];
  const brush = fill?.type === 'SOLID' ? composeColor(fill.color, fill.opacity) : fill && fill.type !== 'IMAGE' ? `Brush.linearGradient(listOf(${fill.stops.map((stop) => composeColor(stop.color, stop.opacity)).join(', ')}))` : null;
  const radius = (node.type === 'FRAME' || node.type === 'RECTANGLE') && !node.cornerRadii ? node.cornerRadius : 0;
  const shape = node.type === 'ELLIPSE' ? 'CircleShape' : radius > 0 ? `RoundedCornerShape(${dp(radius)})` : 'RectangleShape';
  if (node.type === 'TEXT') {
    const lines = [`Text(`, `    text = ${kotlinString(node.characters)},`];
    if (fill?.type === 'SOLID') lines.push(`    color = ${composeColor(fill.color, fill.opacity)},`);
    lines.push(`    fontSize = ${round(node.fontSize)}.sp,`, `    fontWeight = FontWeight.W${node.fontWeight},`);
    if (node.italic) lines.push('    fontStyle = FontStyle.Italic,');
    lines.push(`    fontFamily = FontFamily(Font(R.font.${node.fontFamily.toLowerCase().replace(/[^a-z0-9]+/g, '_')})),`);
    if (node.lineHeight !== null) lines.push(`    lineHeight = ${round(node.lineHeight)}.sp,`);
    if (node.letterSpacing !== 0) lines.push(`    letterSpacing = ${round(node.letterSpacing)}.sp,`);
    if (node.textAlign !== 'LEFT') lines.push(`    textAlign = TextAlign.${node.textAlign === 'CENTER' ? 'Center' : node.textAlign === 'RIGHT' ? 'End' : 'Justify'},`);
    if (node.textDecoration !== 'NONE') lines.push(`    textDecoration = TextDecoration.${node.textDecoration === 'UNDERLINE' ? 'Underline' : 'LineThrough'},`);
    if (node.opacity < 1) lines.push(`    modifier = Modifier.alpha(${round(node.opacity)}f),`);
    lines.push(')');
    return lines.join('\n');
  }
  const modifiers = [`.size(width = ${dp(node.width)}, height = ${dp(node.height)})`];
  for (const effect of node.effects) if (effect.visible && effect.type === 'DROP_SHADOW') modifiers.push(`.shadow(elevation = ${dp(effect.blur / 2)}, shape = ${shape})`);
  if (node.rotation !== 0) modifiers.push(`.rotate(${round(node.rotation)}f)`);
  if (node.opacity < 1) modifiers.push(`.alpha(${round(node.opacity)}f)`);
  if (brush) modifiers.push(`.background(${brush}, ${shape})`);
  const stroke = visiblePaints(node.strokes)[0];
  if (stroke?.type === 'SOLID' && node.strokeWeight > 0) modifiers.push(`.border(${dp(node.strokeWeight)}, ${composeColor(stroke.color, stroke.opacity)}, ${shape})`);
  if (isFrame(node) && node.clipsContent && radius > 0) modifiers.push(`.clip(${shape})`);
  if (isFrame(node) && node.layoutMode !== 'NONE' && (node.paddingTop || node.paddingLeft || node.paddingBottom || node.paddingRight)) {
    modifiers.push(`.padding(start = ${dp(node.paddingLeft)}, top = ${dp(node.paddingTop)}, end = ${dp(node.paddingRight)}, bottom = ${dp(node.paddingBottom)})`);
  }
  const modifier = `modifier = Modifier\n${modifiers.map((entry) => `        ${entry}`).join('\n')}`;
  if (isFrame(node) && getChildIds(doc, id).length > 0) {
    const children = getChildIds(doc, id).map((childId) => `    // ${doc.nodes[childId]?.name ?? ''}`);
    const align = { MIN: 'Start', CENTER: 'Center', MAX: 'End', SPACE_BETWEEN: 'SpaceBetween' }[node.primaryAxisAlignItems];
    const spaced = node.primaryAxisAlignItems === 'SPACE_BETWEEN' ? 'Arrangement.SpaceBetween' : node.itemSpacing !== 0 ? `Arrangement.spacedBy(${dp(node.itemSpacing)})` : `Arrangement.${align === 'Start' ? (node.layoutMode === 'VERTICAL' ? 'Top' : 'Start') : align === 'End' ? (node.layoutMode === 'VERTICAL' ? 'Bottom' : 'End') : 'Center'}`;
    const head = node.layoutMode === 'HORIZONTAL' ? `Row(\n    horizontalArrangement = ${spaced},\n    ${modifier},\n) {` : node.layoutMode === 'VERTICAL' ? `Column(\n    verticalArrangement = ${spaced},\n    ${modifier},\n) {` : `Box(\n    ${modifier},\n) {`;
    return [head, ...children, '}'].join('\n');
  }
  return `Box(\n    ${modifier},\n)`;
}

/**
 * How the component a layer is, or is an instance of, is used in code: the
 * snippet a designer or developer gave it, with each `{Name}` replaced by
 * the instance's value for the variant or component property of that name.
 * Null when the component has no such mapping.
 */
export function codeConnectFor(doc: Document, id: NodeId): { connect: CodeConnect; code: string } | null {
  const node = doc.nodes[id];
  if (!isLayer(node)) return null;
  const instance = isInstance(node) ? node : instanceOf(doc, id);
  const componentId = instance?.componentId ?? (isFrame(node) && node.kind !== 'FRAME' ? node.id : null);
  if (componentId === null) return null;
  const component = doc.nodes[componentId];
  if (!isFrame(component)) return null;
  // A variant without a mapping of its own uses its set's.
  const connect = component.codeConnect ?? setOf(doc, componentId)?.codeConnect ?? null;
  if (!connect) return null;
  const values: Record<string, string> = { ...component.variantProps };
  for (const prop of propsOf(doc, componentId)) {
    const value = (instance as FrameNode | null)?.propValues[prop.id];
    if (value !== undefined) values[prop.name] = prop.type === 'INSTANCE_SWAP' ? (doc.nodes[String(value)]?.name ?? '') : String(value);
  }
  const code = connect.snippet.replace(/\{([^{}]+)\}/g, (whole, name: string) => values[name.trim()] ?? whole);
  // The line that brings the component in, written in pieces so that it is not read as a line of this file's own.
  const bringsIn = ['import', `{ ${connect.component} }`, 'from', `'${connect.source}';`].join(' ');
  return { connect, code: connect.source ? `${bringsIn}\n\n${code}` : code };
}
