import { isFrame, isLayer, type Document, type FrameNode, type ImagePaint, type LayerNode, type NodeId, type Paint } from '../document/schema';
import { getChildIds } from '../scene/tree';
import { composeColor, composeFor, cssFor, kotlinString, swiftColor, swiftFor, swiftString } from './code';

/**
 * Code for a whole screen: a frame, or any layer that holds others, written
 * with everything in it. HTML and CSS nest a box for each layer, with Auto
 * Layout as flexbox and the layers that are not in a layout placed
 * absolutely in the box they are in; SwiftUI nests stacks, and Jetpack
 * Compose nests columns, rows and boxes. Each layer's own look comes from
 * the per-layer code (`cssFor`, `swiftFor`, `composeFor`), so the two always
 * agree. What HTML cannot draw (vectors, boolean groups, stars, polygons and
 * groups with a mask in them) is inline SVG written by the export engine,
 * which the caller passes in, since the core does not draw.
 */

export interface ScreenCodeOptions {
  /**
   * A layer as an `<svg>` element, drawn in its own box from its top-left
   * corner. Without it, or when it gives null, such a layer is an empty box
   * with a comment saying to export it as an asset.
   */
  svgFor?: (id: NodeId) => string | null;
}

export interface ScreenHtml {
  html: string;
  css: string;
}

const round = (value: number, places = 2): number => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};
const px = (value: number): string => (round(value) === 0 ? '0' : `${round(value)}px`);
const dp = (value: number): string => `${round(value)}.dp`;
const indent = (lines: readonly string[], by = '    '): string[] => lines.map((line) => (line === '' ? line : `${by}${line}`));

const escapeHtml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The layers in a layer that are shown, bottom first: the order they are laid out in, and painted in. */
function shownChildren(doc: Document, id: NodeId): LayerNode[] {
  return getChildIds(doc, id)
    .map((childId) => doc.nodes[childId])
    .filter((child): child is LayerNode => isLayer(child) && child.visible);
}

/** Whether a layer is placed by the Auto Layout of the frame it is in. */
function inFlow(doc: Document, node: LayerNode): boolean {
  const parent = doc.nodes[node.parentId];
  return isFrame(parent) && parent.layoutMode !== 'NONE' && node.layoutPositioning !== 'ABSOLUTE';
}

/** Layers that are drawn rather than boxed: as SVG in HTML, as an image asset in SwiftUI and Compose. */
function isDrawn(doc: Document, node: LayerNode): boolean {
  if (node.type === 'VECTOR' || node.type === 'BOOLEAN_OPERATION' || node.type === 'STAR' || node.type === 'POLYGON') return true;
  // A mask cuts what is above it to its shape, which boxes cannot do.
  return (node.type === 'GROUP' || node.type === 'FRAME') && shownChildren(doc, node.id).some((child) => child.isMask);
}

/** The single image a rectangle or ellipse shows, filled or fitted: an image element rather than a box with a background. */
function imageOf(node: LayerNode): ImagePaint | null {
  if (node.type !== 'RECTANGLE' && node.type !== 'ELLIPSE') return null;
  const paints = node.fills.filter((paint) => paint.visible && paint.opacity > 0);
  const only = paints[0];
  return paints.length === 1 && only?.type === 'IMAGE' && (only.scaleMode === 'FILL' || only.scaleMode === 'FIT') ? only : null;
}

/** An image's file name without its extension, as an asset is named in Xcode and Android projects. */
function assetName(doc: Document, node: LayerNode, image: ImagePaint | null): string {
  const name = image ? (doc.assets[image.imageHash]?.name ?? node.name) : node.name;
  return name.replace(/\.[A-Za-z0-9]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'asset';
}

function isContainer(doc: Document, node: LayerNode): boolean {
  return (node.type === 'FRAME' || node.type === 'GROUP') && !isDrawn(doc, node) && shownChildren(doc, node.id).length > 0;
}

/** The topmost paint a box shows behind what is in it: a colour or a gradient. */
function backgroundPaint(node: LayerNode): Exclude<Paint, ImagePaint> | null {
  if (node.type === 'TEXT' || node.type === 'LINE' || node.type === 'GROUP') return null;
  const paints = node.fills.filter((paint): paint is Exclude<Paint, ImagePaint> => paint.visible && paint.opacity > 0 && paint.type !== 'IMAGE');
  return paints[paints.length - 1] ?? null;
}

function radiusOf(node: LayerNode): { all: number } | { corners: [number, number, number, number] } | null {
  if (node.type !== 'FRAME' && node.type !== 'RECTANGLE') return null;
  if (node.cornerRadii) return { corners: node.cornerRadii };
  return node.cornerRadius > 0 ? { all: node.cornerRadius } : null;
}

// HTML and CSS.

/**
 * A frame (or any layer) as HTML and CSS, with everything in it. Each layer
 * is an element with a class named after it; its CSS is its own CSS from
 * `cssFor`, placed for where it is in this tree.
 */
export function htmlFor(doc: Document, id: NodeId, options: ScreenCodeOptions = {}): ScreenHtml {
  const root = doc.nodes[id];
  if (!isLayer(root)) return { html: '', css: '' };
  const used = new Set<string>();
  const className = (name: string): string => {
    const cleaned = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'layer';
    // A class name cannot start with a digit.
    const base = /^[a-z_]/.test(cleaned) ? cleaned : `layer-${cleaned}`;
    let unique = base;
    for (let n = 2; used.has(unique); n++) unique = `${base}-${n}`;
    used.add(unique);
    return unique;
  };
  const rules: string[] = [];
  const rootClass = className(root.name);
  // Sizes in the design include padding and borders, as border-box sizes do.
  rules.push(`.${rootClass}, .${rootClass} * {\n  box-sizing: border-box;\n  margin: 0;\n}`);

  const write = (node: LayerNode, cls: string, isRoot: boolean): string[] => {
    const own = cssFor(doc, node.id)
      .split('\n')
      .filter((line) => line !== '' && !/^(position|left|top): /.test(line) && line !== 'display: none;');
    const declarations: string[] = [];
    const children = isDrawn(doc, node) ? [] : shownChildren(doc, node.id);
    const placedInside = children.some((child) => !inFlow(doc, child));
    if (!isRoot && !inFlow(doc, node)) declarations.push('position: absolute;', `left: ${px(node.x)};`, `top: ${px(node.y)};`);
    else if (placedInside) declarations.push('position: relative;');
    if (node.rotation !== 0) declarations.push('transform-origin: 0 0;');

    const drawn = isDrawn(doc, node);
    const image = imageOf(node);
    if (drawn) {
      // The drawing has its own fills, strokes and effects; the CSS only places and sizes it.
      declarations.push(...own.filter((line) => /^(width|height|flex|align-self|min-width|max-width|min-height|max-height|transform): /.test(line)), 'overflow: visible;');
    } else if (image) {
      declarations.push(...own.filter((line) => !line.startsWith('background: ')), `object-fit: ${image.scaleMode === 'FIT' ? 'contain' : 'cover'};`);
    } else {
      declarations.push(...own);
      if (node.type === 'TEXT') declarations.push(`white-space: ${node.textAutoResize === 'WIDTH_AND_HEIGHT' ? 'pre' : 'pre-wrap'};`);
    }
    rules.push(`.${cls} {\n${declarations.map((line) => `  ${line}`).join('\n')}\n}`);

    if (drawn) {
      const svg = options.svgFor?.(node.id) ?? null;
      if (svg) return [svg.replace(/^\s*(<\?xml[^>]*\?>\s*)?<svg\b/, `<svg class="${cls}" aria-label="${escapeHtml(node.name)}" role="img"`)];
      return [`<div class="${cls}"><!-- ${escapeHtml(node.name).replace(/--/g, '- -')}: export this layer as an SVG asset --></div>`];
    }
    if (image) return [`<img class="${cls}" src="${escapeHtml(doc.assets[image.imageHash]?.name ?? 'image')}" alt="${escapeHtml(node.name)}">`];
    if (node.type === 'TEXT') return [`<p class="${cls}">${escapeHtml(node.characters)}</p>`];
    if (children.length === 0) return [`<div class="${cls}"></div>`];
    const inner = children.flatMap((child) => write(child, className(child.name), false));
    return [`<div class="${cls}">`, ...indent(inner, '  '), '</div>'];
  };
  const html = write(root, rootClass, true).join('\n');
  return { html, css: rules.join('\n\n') };
}

/** HTML and CSS together, as one piece to paste: the CSS in a style element above the markup. */
export function htmlPageFor(doc: Document, id: NodeId, options: ScreenCodeOptions = {}): string {
  const { html, css } = htmlFor(doc, id, options);
  if (html === '') return '';
  return `<style>\n${css}\n</style>\n\n${html}`;
}

// What each axis of a layer's size is, where it is: SwiftUI and Compose both start from this.

type Size = { kind: 'FIXED'; value: number } | { kind: 'FILL'; along: boolean } | { kind: 'HUG' };

function sizes(doc: Document, node: LayerNode, isRoot: boolean): { width: Size; height: Size } {
  const parent = doc.nodes[node.parentId];
  const flow = !isRoot && inFlow(doc, node);
  const direction = isFrame(parent) ? parent.layoutMode : 'NONE';
  const axis = (sizing: LayerNode['layoutSizingHorizontal'], value: number, horizontal: boolean): Size => {
    if (sizing === 'FILL' && flow) return { kind: 'FILL', along: (direction === 'HORIZONTAL') === horizontal };
    if (sizing === 'HUG') return { kind: 'HUG' };
    return { kind: 'FIXED', value };
  };
  return { width: axis(node.layoutSizingHorizontal, node.width, true), height: axis(node.layoutSizingVertical, node.height, false) };
}

// SwiftUI.

const SWIFT_ALIGN: Record<string, string> = {
  'MIN,MIN': 'topLeading',
  'CENTER,MIN': 'top',
  'MAX,MIN': 'topTrailing',
  'MIN,CENTER': 'leading',
  'CENTER,CENTER': 'center',
  'MAX,CENTER': 'trailing',
  'MIN,MAX': 'bottomLeading',
  'CENTER,MAX': 'bottom',
  'MAX,MAX': 'bottomTrailing',
};

/** Where the content of a laid-out frame sits in its box, as a SwiftUI alignment. */
function swiftAlignment(node: FrameNode): string {
  const flat = (value: string): string => (value === 'MAX' ? 'MAX' : value === 'CENTER' ? 'CENTER' : 'MIN');
  const along = flat(node.primaryAxisAlignItems);
  const across = flat(node.counterAxisAlignItems);
  const [h, v] = node.layoutMode === 'HORIZONTAL' ? [along, across] : [across, along];
  return SWIFT_ALIGN[`${h},${v}`] ?? 'center';
}

function swiftShape(node: LayerNode): string {
  if (node.type === 'ELLIPSE') return 'Ellipse()';
  const radius = radiusOf(node);
  if (!radius) return 'Rectangle()';
  if ('all' in radius) return `RoundedRectangle(cornerRadius: ${round(radius.all)})`;
  const [tl, tr, br, bl] = radius.corners;
  return `UnevenRoundedRectangle(topLeadingRadius: ${round(tl)}, bottomLeadingRadius: ${round(bl)}, bottomTrailingRadius: ${round(br)}, topTrailingRadius: ${round(tr)})`;
}

function swiftPaint(paint: Exclude<Paint, ImagePaint>): string {
  if (paint.type === 'SOLID') return swiftColor(paint.color, paint.opacity);
  return `LinearGradient(colors: [${paint.stops.map((stop) => swiftColor(stop.color, stop.opacity * paint.opacity)).join(', ')}], startPoint: UnitPoint(x: ${round(paint.from.x)}, y: ${round(paint.from.y)}), endPoint: UnitPoint(x: ${round(paint.to.x)}, y: ${round(paint.to.y)}))`;
}

/** The `.frame` modifiers for a layer's size, with the alignment of what is in it. */
function swiftFrame(size: { width: Size; height: Size }, alignment: string | null): string[] {
  const fixed: string[] = [];
  const flexible: string[] = [];
  if (size.width.kind === 'FIXED') fixed.push(`width: ${round(size.width.value)}`);
  if (size.height.kind === 'FIXED') fixed.push(`height: ${round(size.height.value)}`);
  if (size.width.kind === 'FILL') flexible.push('maxWidth: .infinity');
  if (size.height.kind === 'FILL') flexible.push('maxHeight: .infinity');
  const tail = alignment && alignment !== 'center' ? [`alignment: .${alignment}`] : [];
  const out: string[] = [];
  if (fixed.length > 0) out.push(`.frame(${[...fixed, ...(flexible.length === 0 ? tail : [])].join(', ')})`);
  if (flexible.length > 0) out.push(`.frame(${[...flexible, ...tail].join(', ')})`);
  return out;
}

/** The look of a box: its background, corners, border, shadow and opacity, as SwiftUI modifiers. */
function swiftLook(node: LayerNode): string[] {
  const out: string[] = [];
  const shape = swiftShape(node);
  const paint = backgroundPaint(node);
  if (paint) out.push(shape === 'Rectangle()' ? `.background(${swiftPaint(paint)})` : `.background(${swiftPaint(paint)}, in: ${shape})`);
  if (isFrame(node) && node.clipsContent && shape !== 'Rectangle()') out.push(`.clipShape(${shape})`);
  else if (isFrame(node) && node.clipsContent) out.push('.clipped()');
  const stroke = node.strokes.filter((entry) => entry.visible && entry.opacity > 0).pop();
  if (stroke?.type === 'SOLID' && node.strokeWeight > 0) out.push(`.overlay(${shape}.stroke(${swiftColor(stroke.color, stroke.opacity)}, lineWidth: ${round(node.strokeWeight)}))`);
  for (const effect of node.effects) {
    if (!effect.visible) continue;
    if (effect.type === 'DROP_SHADOW') out.push(`.shadow(color: ${swiftColor(effect.color, effect.opacity)}, radius: ${round(effect.blur / 2)}, x: ${round(effect.offsetX)}, y: ${round(effect.offsetY)})`);
    else if (effect.type === 'LAYER_BLUR') out.push(`.blur(radius: ${round(effect.radius)})`);
  }
  if (node.opacity < 1) out.push(`.opacity(${round(node.opacity)})`);
  if (node.rotation !== 0) out.push(`.rotationEffect(.degrees(${round(node.rotation)}), anchor: .topLeading)`);
  return out;
}

function swiftView(doc: Document, node: LayerNode, isRoot: boolean): string[] {
  const size = sizes(doc, node, isRoot);
  const modifiers = (list: readonly string[]): string[] => indent(list);
  const image = imageOf(node);
  if (isDrawn(doc, node) || image) {
    const head = `Image(${swiftString(assetName(doc, node, image))})${image ? '' : ' // Exported from this layer as an asset'}`;
    const mode = image ? [`.aspectRatio(contentMode: .${image.scaleMode === 'FIT' ? 'fit' : 'fill'})`] : [];
    const clip = image && swiftShape(node) !== 'Rectangle()' ? [`.clipShape(${swiftShape(node)})`] : image ? ['.clipped()'] : [];
    return [head, ...modifiers(['.resizable()', ...mode, ...swiftFrame(size, null), ...clip, ...(node.opacity < 1 ? [`.opacity(${round(node.opacity)})`] : [])])];
  }
  if (node.type === 'TEXT') {
    // The text's own code, with its size set for where it is.
    const own = swiftFor(doc, node.id).split('\n').filter((line) => !line.startsWith('    .frame('));
    return [...own, ...modifiers(swiftFrame(size, node.textAlign === 'CENTER' ? 'center' : node.textAlign === 'RIGHT' ? 'trailing' : 'leading'))];
  }
  if (!isContainer(doc, node)) {
    const own = swiftFor(doc, node.id).split('\n').filter((line) => !line.startsWith('    .frame('));
    return [...own, ...modifiers(swiftFrame(size, null))];
  }

  const children = shownChildren(doc, node.id);
  const frame = isFrame(node) ? node : null;
  const laidOut = frame !== null && frame.layoutMode !== 'NONE';
  const flowing = laidOut ? children.filter((child) => inFlow(doc, child)) : [];
  const placed = laidOut ? children.filter((child) => !inFlow(doc, child)) : children;
  const placedView = (child: LayerNode): string[] => [...swiftView(doc, child, false), ...modifiers([`.offset(x: ${round(child.x)}, y: ${round(child.y)})`])];

  const lines: string[] = [];
  if (laidOut && frame) {
    const between = frame.primaryAxisAlignItems === 'SPACE_BETWEEN';
    const spacing = between ? 0 : round(frame.itemSpacing);
    const stack =
      frame.layoutMode === 'HORIZONTAL'
        ? `HStack(alignment: .${{ MIN: 'top', CENTER: 'center', MAX: 'bottom', STRETCH: 'center', BASELINE: 'firstTextBaseline' }[frame.counterAxisAlignItems]}, spacing: ${spacing}) {`
        : `VStack(alignment: .${{ MIN: 'leading', CENTER: 'center', MAX: 'trailing', STRETCH: 'center', BASELINE: 'leading' }[frame.counterAxisAlignItems]}, spacing: ${spacing}) {`;
    lines.push(stack);
    if (frame.layoutWrap === 'WRAP') lines.push('    // In the design this wraps onto more lines; SwiftUI stacks do not wrap.');
    const ordered = frame.itemsReversed ? [...flowing].reverse() : flowing;
    ordered.forEach((child, index) => {
      if (between && index > 0) lines.push('    Spacer(minLength: 0)');
      lines.push(...indent(swiftView(doc, child, false)));
    });
    lines.push('}');
    if (frame.paddingTop || frame.paddingLeft || frame.paddingBottom || frame.paddingRight) {
      lines.push(`    .padding(EdgeInsets(top: ${round(frame.paddingTop)}, leading: ${round(frame.paddingLeft)}, bottom: ${round(frame.paddingBottom)}, trailing: ${round(frame.paddingRight)}))`);
    }
    lines.push(...modifiers(swiftFrame(size, swiftAlignment(frame))));
  } else {
    // Layers that are not laid out sit in a stack from the top-left corner, each moved to its place.
    lines.push('ZStack(alignment: .topLeading) {');
    for (const child of placed) lines.push(...indent(placedView(child)));
    lines.push('}');
    lines.push(...modifiers(swiftFrame(size, 'topLeading')));
  }
  lines.push(...modifiers(swiftLook(node)));
  if (laidOut && placed.length > 0) {
    // Layers taken out of the layout lie over it, at their places in the frame.
    lines.push('    .overlay(alignment: .topLeading) {');
    for (const child of placed) lines.push(...indent(placedView(child), '        '));
    lines.push('    }');
  }
  return lines;
}

/** A frame (or any layer) as SwiftUI, with everything in it: stacks for Auto Layout, a positioned stack for the rest. */
export function swiftScreenFor(doc: Document, id: NodeId): string {
  const node = doc.nodes[id];
  if (!isLayer(node)) return '';
  return swiftView(doc, node, true).join('\n');
}

// Jetpack Compose.

function composeShape(node: LayerNode): string {
  if (node.type === 'ELLIPSE') return 'CircleShape';
  const radius = radiusOf(node);
  if (!radius) return 'RectangleShape';
  if ('all' in radius) return `RoundedCornerShape(${dp(radius.all)})`;
  const [tl, tr, br, bl] = radius.corners;
  return `RoundedCornerShape(topStart = ${dp(tl)}, topEnd = ${dp(tr)}, bottomEnd = ${dp(br)}, bottomStart = ${dp(bl)})`;
}

function composePaint(paint: Exclude<Paint, ImagePaint>): string {
  if (paint.type === 'SOLID') return composeColor(paint.color, paint.opacity);
  return `Brush.linearGradient(listOf(${paint.stops.map((stop) => composeColor(stop.color, stop.opacity * paint.opacity)).join(', ')}))`;
}

/** A layer's modifiers in Compose's order: where it is, how big, then how it looks, then the room inside it. */
function composeModifiers(doc: Document, node: LayerNode, isRoot: boolean, offset: boolean, look: boolean): string[] {
  const out: string[] = [];
  if (offset) out.push(`.offset(x = ${dp(node.x)}, y = ${dp(node.y)})`);
  const size = sizes(doc, node, isRoot);
  if (size.width.kind === 'FIXED' && size.height.kind === 'FIXED') out.push(`.size(width = ${dp(size.width.value)}, height = ${dp(size.height.value)})`);
  else {
    if (size.width.kind === 'FIXED') out.push(`.width(${dp(size.width.value)})`);
    if (size.height.kind === 'FIXED') out.push(`.height(${dp(size.height.value)})`);
  }
  for (const axis of [size.width, size.height]) if (axis.kind === 'FILL' && axis.along) out.push('.weight(1f)');
  if (size.width.kind === 'FILL' && !size.width.along) out.push('.fillMaxWidth()');
  if (size.height.kind === 'FILL' && !size.height.along) out.push('.fillMaxHeight()');
  if (node.rotation !== 0) out.push(`.rotate(${round(node.rotation)}f)`);
  if (node.opacity < 1) out.push(`.alpha(${round(node.opacity)}f)`);
  if (!look) return out;
  const shape = composeShape(node);
  for (const effect of node.effects) if (effect.visible && effect.type === 'DROP_SHADOW') out.push(`.shadow(elevation = ${dp(effect.blur / 2)}, shape = ${shape})`);
  const paint = backgroundPaint(node);
  if (paint) out.push(`.background(${composePaint(paint)}, ${shape})`);
  const stroke = node.strokes.filter((entry) => entry.visible && entry.opacity > 0).pop();
  if (stroke?.type === 'SOLID' && node.strokeWeight > 0 && node.type !== 'TEXT') out.push(`.border(${dp(node.strokeWeight)}, ${composeColor(stroke.color, stroke.opacity)}, ${shape})`);
  if (isFrame(node) && node.clipsContent) out.push(`.clip(${shape})`);
  return out;
}

const modifierArgument = (modifiers: readonly string[]): string[] => (modifiers.length === 0 ? [] : ['modifier = Modifier', ...modifiers.map((entry) => `    ${entry}`)].map((line, index, all) => (index === all.length - 1 ? `${line},` : line)));

function composeView(doc: Document, node: LayerNode, isRoot: boolean, offset: boolean): string[] {
  const image = imageOf(node);
  if (isDrawn(doc, node) || image) {
    const modifiers = composeModifiers(doc, node, isRoot, offset, false);
    if (image && node.type === 'ELLIPSE') modifiers.push('.clip(CircleShape)');
    else if (image && radiusOf(node)) modifiers.push(`.clip(${composeShape(node)})`);
    return [
      'Image(',
      `    painter = painterResource(R.drawable.${assetName(doc, node, image)}),`,
      `    contentDescription = ${kotlinString(node.name)},`,
      ...(image ? [`    contentScale = ContentScale.${image.scaleMode === 'FIT' ? 'Fit' : 'Crop'},`] : []),
      ...indent(modifierArgument(modifiers)),
      ')',
    ];
  }
  if (node.type === 'TEXT') {
    // The text's own code, with the modifiers for where it is in place of its own.
    const own = composeFor(doc, node.id).split('\n').filter((line) => !line.startsWith('    modifier = '));
    const modifiers = composeModifiers(doc, node, isRoot, offset, false);
    return [own[0] as string, own[1] as string, ...indent(modifierArgument(modifiers)), ...own.slice(2)];
  }
  if (!isContainer(doc, node)) return ['Box(', ...indent(modifierArgument(composeModifiers(doc, node, isRoot, offset, true))), ')'];

  const children = shownChildren(doc, node.id);
  const frame = isFrame(node) ? node : null;
  const laidOut = frame !== null && frame.layoutMode !== 'NONE';
  const flowing = laidOut ? children.filter((child) => inFlow(doc, child)) : [];
  const placed = laidOut ? children.filter((child) => !inFlow(doc, child)) : children;
  const outer = composeModifiers(doc, node, isRoot, offset, true);
  const padding = frame && laidOut && (frame.paddingTop || frame.paddingLeft || frame.paddingBottom || frame.paddingRight) ? `.padding(start = ${dp(frame.paddingLeft)}, top = ${dp(frame.paddingTop)}, end = ${dp(frame.paddingRight)}, bottom = ${dp(frame.paddingBottom)})` : null;
  const placedLines = placed.flatMap((child) => composeView(doc, child, false, true));

  if (!laidOut || !frame) return ['Box(', ...indent(modifierArgument(outer)), ') {', ...indent(placedLines), '}'];

  const row = frame.layoutMode === 'HORIZONTAL';
  const along = frame.primaryAxisAlignItems;
  const named = row ? { MIN: 'Start', CENTER: 'CenterHorizontally', MAX: 'End' } : { MIN: 'Top', CENTER: 'CenterVertically', MAX: 'Bottom' };
  const plain = row ? { MIN: 'Start', CENTER: 'Center', MAX: 'End' } : { MIN: 'Top', CENTER: 'Center', MAX: 'Bottom' };
  const arrangement =
    along === 'SPACE_BETWEEN'
      ? 'Arrangement.SpaceBetween'
      : frame.itemSpacing !== 0
        ? `Arrangement.spacedBy(${dp(frame.itemSpacing)}${along === 'MIN' ? '' : `, Alignment.${named[along]}`})`
        : `Arrangement.${plain[along]}`;
  const across = frame.counterAxisAlignItems;
  const alignment = row ? `Alignment.${{ MIN: 'Top', CENTER: 'CenterVertically', MAX: 'Bottom', STRETCH: 'Top', BASELINE: 'Top' }[across]}` : `Alignment.${{ MIN: 'Start', CENTER: 'CenterHorizontally', MAX: 'End', STRETCH: 'Start', BASELINE: 'Start' }[across]}`;
  const ordered = frame.itemsReversed ? [...flowing].reverse() : flowing;
  const flowLines = ordered.flatMap((child) => composeView(doc, child, false, false));
  const head = (modifiers: readonly string[]): string[] => [
    `${row ? 'Row' : 'Column'}(`,
    ...indent(modifierArgument(modifiers)),
    `    ${row ? 'horizontalArrangement' : 'verticalArrangement'} = ${arrangement},`,
    `    ${row ? 'verticalAlignment' : 'horizontalAlignment'} = ${alignment},`,
    ') {',
    ...(frame.layoutWrap === 'WRAP' ? [`    // In the design this wraps onto more lines: Flow${row ? 'Row' : 'Column'} does that.`] : []),
    ...indent(flowLines),
    '}',
  ];
  if (placed.length === 0) return head(padding ? [...outer, padding] : outer);
  // Layers taken out of the layout lie over it in a box the size of the frame.
  const fixed = frame.layoutSizingHorizontal === 'FIXED' && frame.layoutSizingVertical === 'FIXED';
  return ['Box(', ...indent(modifierArgument(outer)), ') {', ...indent(head([...(fixed ? ['.matchParentSize()'] : []), ...(padding ? [padding] : [])])), ...indent(placedLines), '}'];
}

/** A frame (or any layer) as Jetpack Compose, with everything in it: columns and rows for Auto Layout, boxes for the rest. */
export function composeScreenFor(doc: Document, id: NodeId): string {
  const node = doc.nodes[id];
  if (!isLayer(node)) return '';
  return composeView(doc, node, true, false).join('\n');
}

/** Whether a layer holds others, so that "Whole frame" code says more than the layer's own. */
export function hasScreenCode(doc: Document, id: NodeId): boolean {
  const node = doc.nodes[id];
  return isLayer(node) && isContainer(doc, node);
}

