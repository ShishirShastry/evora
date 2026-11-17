import { imagePlacement, isGradient, type Effect, type GradientPaint, type ImagePaint, type Matrix, type Paint, type RGB } from '../../core';
import { angularWedges, diamondQuadrants, drawnAsShapes, pathArea, type Area, type GradientSpace } from './gradients';
import type { Clip, Segment, VectorFill, VectorGroup, VectorItem, VectorStroke, VectorText } from './vector';

/**
 * Writes a vector scene as SVG. Shapes are paths with the same outlines the
 * canvas paints; text is real text in its own font; gradients, clips, masks,
 * shadows and blurs are the SVG things of the same name. Angular gradients,
 * which SVG has not got, are fans of thin wedges, and diamond gradients are
 * four linear ones, one in each quarter (see `gradients.ts`). What SVG has no
 * way to say (a background blur) is left out and named in the warnings that
 * come back with the file.
 */

/** An image as the writer needs it: its bytes, as base64, and its natural size. */
export interface SvgImage {
  mimeType: string;
  base64: string;
  width: number;
  height: number;
}

export interface SvgOptions {
  width: number;
  height: number;
  /** Multiplies the size the file says it is; the drawing inside is the same. */
  scale?: number;
  /** A colour behind everything. Without one the file is transparent. */
  background?: RGB | null;
  /** Give each layer's element an `id` made from the layer's name. */
  ids?: boolean;
  images?: Readonly<Record<string, SvgImage>>;
}

const BLENDS: Record<string, string> = {
  DARKEN: 'darken',
  MULTIPLY: 'multiply',
  COLOR_BURN: 'color-burn',
  LIGHTEN: 'lighten',
  SCREEN: 'screen',
  COLOR_DODGE: 'color-dodge',
  OVERLAY: 'overlay',
  SOFT_LIGHT: 'soft-light',
  HARD_LIGHT: 'hard-light',
  DIFFERENCE: 'difference',
  EXCLUSION: 'exclusion',
  HUE: 'hue',
  SATURATION: 'saturation',
  COLOR: 'color',
  LUMINOSITY: 'luminosity',
};

const num = (value: number): string => {
  const rounded = Math.round(value * 1000) / 1000;
  return Object.is(rounded, -0) ? '0' : String(rounded);
};

const escape = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function hex(color: RGB): string {
  const part = (value: number): string => Math.round(Math.min(1, Math.max(0, value)) * 255).toString(16).padStart(2, '0');
  return `#${part(color.r)}${part(color.g)}${part(color.b)}`;
}

/** A path as the `d` of an SVG path. */
export function pathData(segments: readonly Segment[]): string {
  return segments
    .map((segment) => {
      if (segment.op === 'Z') return 'Z';
      if (segment.op === 'C') return `C${num(segment.x1)} ${num(segment.y1)} ${num(segment.x2)} ${num(segment.y2)} ${num(segment.x)} ${num(segment.y)}`;
      return `${segment.op}${num(segment.x)} ${num(segment.y)}`;
    })
    .join('');
}

const isIdentity = (m: Matrix): boolean => m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0;
const matrixText = (m: Matrix): string => (m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 ? `translate(${num(m[4])} ${num(m[5])})` : `matrix(${m.map(num).join(' ')})`);

export function exportSvg(scene: VectorGroup, options: SvgOptions): { svg: string; warnings: string[] } {
  const defs: string[] = [];
  const warnings = new Set<string>();
  const used = new Set<string>();
  let counter = 0;
  const fresh = (prefix: string): string => `${prefix}${++counter}`;
  const images = new Map<string, string>();

  const layerId = (name: string): string => {
    const base = name.trim().replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'layer';
    let id = /^[A-Za-z_]/.test(base) ? base : `_${base}`;
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);
    return id;
  };

  const stops = (paint: GradientPaint): string => paint.stops.map((stop) => `<stop offset="${num(Math.min(1, Math.max(0, stop.position)))}" stop-color="${hex(stop.color)}"${stop.opacity < 1 ? ` stop-opacity="${num(stop.opacity)}"` : ''}/>`).join('');

  /**
   * The `fill` or `stroke` value for a paint, with what it needs added to the
   * definitions. Null for a paint that cannot be given as a colour: an image,
   * and the gradients that are drawn as shapes (`drawnAsShapes`). In 'box'
   * space a round gradient stretches with the layer's box, as a shape's fill
   * does on the canvas; in 'pixels' (lines and text) it is a circle, and a
   * diamond is drawn round, as the canvas draws it there.
   */
  const paintValue = (paint: Paint, width: number, height: number, space: GradientSpace = 'box'): string | null => {
    if (paint.type === 'SOLID') return hex(paint.color);
    if (!isGradient(paint) || drawnAsShapes(paint, space)) return null;
    const id = fresh('gradient');
    const fx = paint.from.x * width;
    const fy = paint.from.y * height;
    if (paint.type === 'GRADIENT_LINEAR') {
      defs.push(`<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${num(fx)}" y1="${num(fy)}" x2="${num(paint.to.x * width)}" y2="${num(paint.to.y * height)}">${stops(paint)}</linearGradient>`);
      return `url(#${id})`;
    }
    if (space === 'pixels' || width <= 0 || height <= 0) {
      const r = Math.max(1e-3, Math.hypot(paint.to.x * width - fx, paint.to.y * height - fy));
      defs.push(`<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${num(fx)}" cy="${num(fy)}" r="${num(r)}">${stops(paint)}</radialGradient>`);
      return `url(#${id})`;
    }
    // A circle of radius 1 about the origin, stretched with the layer's box as the canvas stretches it.
    const radius = Math.max(1e-6, Math.hypot(paint.to.x - paint.from.x, paint.to.y - paint.from.y));
    defs.push(`<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="1" gradientTransform="matrix(${num(width * radius)} 0 0 ${num(height * radius)} ${num(fx)} ${num(fy)})">${stops(paint)}</radialGradient>`);
    return `url(#${id})`;
  };

  /** An angular or diamond gradient drawn over an area of the layer's space, as wedges or quarters; what shows of it is up to whatever clips or masks it. */
  const gradientShapes = (paint: GradientPaint, width: number, height: number, space: GradientSpace, area: Area): string => {
    if (paint.type === 'GRADIENT_DIAMOND') {
      const quadrants = diamondQuadrants(paint, width, height, area) ?? [];
      return quadrants
        .map((quadrant) => {
          const id = fresh('gradient');
          defs.push(`<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="${num(quadrant.to.x)}" y2="${num(quadrant.to.y)}" gradientTransform="matrix(${quadrant.matrix.map(num).join(' ')})">${stops(paint)}</linearGradient>`);
          return `<path d="${pathData(quadrant.path)}" fill="url(#${id})"/>`;
        })
        .join('');
    }
    return angularWedges(paint, width, height, space, area)
      .map((wedge) => `<path d="${pathData(wedge.path)}" fill="${hex(wedge.color)}"${wedge.opacity < 1 ? ` fill-opacity="${num(wedge.opacity)}"` : ''}/>`)
      .join('');
  };

  /** Shows something only where what is in the mask is drawn, in white. */
  const maskWith = (content: string, body: string, opacity: number): string => {
    const id = fresh('mask');
    defs.push(`<mask id="${id}">${content}</mask>`);
    return `<g mask="url(#${id})"${opacity < 1 ? ` opacity="${num(opacity)}"` : ''}>${body}</g>`;
  };

  const clipId = (clip: Clip): string => {
    const id = fresh('clip');
    defs.push(`<clipPath id="${id}"><path d="${pathData(clip.path)}"${clip.rule === 'evenodd' ? ' clip-rule="evenodd"' : ''}/></clipPath>`);
    return id;
  };

  const imageId = (hash: string, image: SvgImage): string => {
    let id = images.get(hash);
    if (!id) {
      id = fresh('image');
      images.set(hash, id);
      defs.push(`<image id="${id}" width="${num(image.width)}" height="${num(image.height)}" preserveAspectRatio="none" href="data:${image.mimeType};base64,${image.base64}"/>`);
    }
    return id;
  };

  const imageFill = (item: VectorFill, paint: ImagePaint): string => {
    const image = options.images?.[paint.imageHash];
    const d = pathData(item.path);
    const rule = item.rule === 'evenodd' ? ' fill-rule="evenodd"' : '';
    if (!image) {
      warnings.add('An image could not be found on this device and was left as a grey box.');
      return `<path d="${d}"${rule} fill="#808a8a" fill-opacity="0.35"/>`;
    }
    if (paint.exposure !== 0 || paint.contrast !== 0 || paint.saturation !== 0) warnings.add('Image adjustments (exposure, contrast, saturation) are not written to SVG: the image is as it was imported.');
    const id = imageId(paint.imageHash, image);
    const flip = paint.flipX || paint.flipY ? ` transform="translate(${num(paint.flipX ? item.width : 0)} ${num(paint.flipY ? item.height : 0)}) scale(${paint.flipX ? -1 : 1} ${paint.flipY ? -1 : 1})"` : '';
    const opacity = paint.opacity < 1 ? ` opacity="${num(paint.opacity)}"` : '';
    const clip = clipId({ path: item.path, rule: item.rule });
    if (paint.scaleMode === 'TILE') {
      const scale = Math.max(0.01, paint.tileScale);
      const pattern = fresh('pattern');
      defs.push(`<pattern id="${pattern}" patternUnits="userSpaceOnUse" width="${num(image.width * scale)}" height="${num(image.height * scale)}"><use href="#${id}" transform="scale(${num(scale)})"/></pattern>`);
      return `<g clip-path="url(#${clip})"${opacity}><rect${flip} width="${num(item.width)}" height="${num(item.height)}" fill="url(#${pattern})"/></g>`;
    }
    const placement = imagePlacement(paint.scaleMode, image.width, image.height, item.width, item.height, paint.crop);
    if (!placement) return '';
    const { source, target } = placement;
    // The part of the image that is used, stretched over where it goes.
    const placed = `<svg x="${num(target.x)}" y="${num(target.y)}" width="${num(target.width)}" height="${num(target.height)}" viewBox="${num(source.x)} ${num(source.y)} ${num(source.width)} ${num(source.height)}" preserveAspectRatio="none" overflow="hidden"><use href="#${id}"/></svg>`;
    // The outline clips first; a mirrored picture is turned over inside it.
    return `<g clip-path="url(#${clip})"${opacity}>${flip ? `<g${flip}>${placed}</g>` : placed}</g>`;
  };

  const fill = (item: VectorFill): string => {
    if (item.paint.type === 'IMAGE') return imageFill(item, item.paint);
    if (isGradient(item.paint) && drawnAsShapes(item.paint, 'box')) {
      const area = pathArea(item.path);
      if (!area) return '';
      const opacity = item.paint.opacity < 1 ? ` opacity="${num(item.paint.opacity)}"` : '';
      return `<g clip-path="url(#${clipId({ path: item.path, rule: item.rule })})"${opacity}>${gradientShapes(item.paint, item.width, item.height, 'box', area)}</g>`;
    }
    const value = paintValue(item.paint, item.width, item.height);
    if (value === null) return '';
    return `<path d="${pathData(item.path)}" fill="${value}"${item.paint.opacity < 1 ? ` fill-opacity="${num(item.paint.opacity)}"` : ''}${item.rule === 'evenodd' ? ' fill-rule="evenodd"' : ''}/>`;
  };

  const stroke = (item: VectorStroke): string => {
    const cap = item.cap === 'ROUND' ? ' stroke-linecap="round"' : item.cap === 'SQUARE' ? ' stroke-linecap="square"' : '';
    const join = item.join === 'ROUND' ? ' stroke-linejoin="round"' : item.join === 'BEVEL' ? ' stroke-linejoin="bevel"' : '';
    const dash = item.dash.length > 0 ? ` stroke-dasharray="${item.dash.map(num).join(' ')}"` : '';
    let path: string;
    if (isGradient(item.paint) && drawnAsShapes(item.paint, 'pixels')) {
      // The wedges, shown only where the line is drawn.
      const area = pathArea(item.path, item.lineWidth + 2);
      if (!area) return '';
      const line = `<path d="${pathData(item.path)}" fill="none" stroke="#ffffff" stroke-width="${num(item.lineWidth)}"${cap}${join}${dash}/>`;
      path = maskWith(line, gradientShapes(item.paint, item.width, item.height, 'pixels', area), item.paint.opacity);
    } else {
      const value = paintValue(item.paint, item.width, item.height, 'pixels');
      if (value === null) return '';
      path = `<path d="${pathData(item.path)}" fill="none" stroke="${value}" stroke-width="${num(item.lineWidth)}"${item.paint.opacity < 1 ? ` stroke-opacity="${num(item.paint.opacity)}"` : ''}${cap}${join}${dash}/>`;
    }
    return item.clip ? `<g clip-path="url(#${clipId(item.clip)})">${path}</g>` : path;
  };

  const text = (item: VectorText): string => {
    const { node } = item;
    const family = (name: string): string => escape(`${name}, Arial, Helvetica, sans-serif`);
    const spans = (colour: (own: RGB | null) => string | null, extra: string): string => {
      let out = '';
      for (const line of item.lines) {
        for (const run of line.marker ? [line.marker, ...line.runs] : line.runs) {
          if (run.text === '') continue;
          const style = run.style;
          const paint = colour(style.color);
          if (paint === null) continue;
          const decoration = style.textDecoration === 'UNDERLINE' ? ' text-decoration="underline"' : style.textDecoration === 'STRIKETHROUGH' ? ' text-decoration="line-through"' : '';
          out += `<tspan x="${num(run.x)}" y="${num(line.baseline)}" font-family="${family(style.fontFamily)}" font-size="${num(style.fontSize)}" font-weight="${style.fontWeight}"${style.italic ? ' font-style="italic"' : ''}${style.letterSpacing ? ` letter-spacing="${num(style.letterSpacing)}"` : ''}${decoration} ${paint}${extra}>${escape(run.text)}</tspan>`;
        }
      }
      return out;
    };
    const flip = node.flipX || node.flipY ? ` transform="translate(${num(node.flipX ? node.width : 0)} ${num(node.flipY ? node.height : 0)}) scale(${node.flipX ? -1 : 1} ${node.flipY ? -1 : 1})"` : '';
    // What is written so far: whole elements, and the spans of a <text> still open.
    let done = '';
    let open = '';
    const flush = (): void => {
      if (open !== '') done += `<text xml:space="preserve"${flip}>${open}</text>`;
      open = '';
    };
    // The box the glyphs can reach, which an angular gradient has to cover.
    const tallest = item.lines.reduce((most, line) => line.runs.reduce((size, run) => Math.max(size, run.style.fontSize), most), 0);
    const pad = tallest + node.strokeWeight + 2;
    const area: Area = { x: -pad, y: -pad, width: node.width + pad * 2, height: node.height + pad * 2 };
    const fills = node.fills.filter((paint) => paint.visible && paint.opacity > 0 && paint.type !== 'IMAGE');
    // The fills colour the glyphs, except those with a colour of their own, which are written once in it.
    fills.forEach((paint, index) => {
      if (isGradient(paint) && drawnAsShapes(paint, 'pixels')) {
        // The wedges, shown only where the glyphs are.
        flush();
        const glyphs = spans((own) => (own === null ? 'fill="#ffffff"' : null), '');
        if (glyphs !== '') done += maskWith(`<text xml:space="preserve"${flip}>${glyphs}</text>`, gradientShapes(paint, node.width, node.height, 'pixels', area), paint.opacity);
        if (index === 0) open += spans((own) => (own === null ? null : `fill="${hex(own)}"`), '');
        return;
      }
      const value = paintValue(paint, node.width, node.height, 'pixels');
      const opacity = paint.opacity < 1 ? ` fill-opacity="${num(paint.opacity)}"` : '';
      open += spans((own) => (own === null ? `fill="${value}"${opacity}` : index === 0 ? `fill="${hex(own)}"` : null), '');
    });
    if (fills.length === 0) open += spans((own) => (own === null ? null : `fill="${hex(own)}"`), '');
    if (node.strokeWeight > 0) {
      for (const paint of node.strokes) {
        if (!paint.visible || paint.opacity <= 0) continue;
        if (isGradient(paint) && drawnAsShapes(paint, 'pixels')) {
          flush();
          const outlines = spans(() => `fill="none" stroke="#ffffff" stroke-width="${num(node.strokeWeight)}" stroke-linejoin="round"`, '');
          done += maskWith(`<text xml:space="preserve"${flip}>${outlines}</text>`, gradientShapes(paint, node.width, node.height, 'pixels', area), paint.opacity);
          continue;
        }
        const value = paintValue(paint, node.width, node.height, 'pixels');
        if (value === null) continue;
        open += spans(() => `fill="none" stroke="${value}" stroke-width="${num(node.strokeWeight)}" stroke-linejoin="round"`, paint.opacity < 1 ? ` stroke-opacity="${num(paint.opacity)}"` : '');
      }
    }
    flush();
    return done;
  };

  /** The part of a group's own space that what is in it covers, or null when it draws nothing that has a place. */
  const contentArea = (items: readonly VectorItem[]): Area | null => {
    let box: Area | null = null;
    const take = (part: Area | null): void => {
      if (!part) return;
      if (!box) {
        box = part;
        return;
      }
      const x0 = Math.min(box.x, part.x);
      const y0 = Math.min(box.y, part.y);
      box = { x: x0, y: y0, width: Math.max(box.x + box.width, part.x + part.width) - x0, height: Math.max(box.y + box.height, part.y + part.height) - y0 };
    };
    for (const item of items) {
      if (item.kind === 'fill') take(pathArea(item.path));
      // A mitred corner can reach further than half the line's width.
      else if (item.kind === 'stroke') take(pathArea(item.path, item.lineWidth * 2));
      else if (item.kind === 'text') {
        const pad = item.lines.reduce((most, line) => line.runs.reduce((size, run) => Math.max(size, run.style.fontSize), most), 0) + item.node.strokeWeight;
        take({ x: -pad, y: -pad, width: item.node.width + pad * 2, height: item.node.height + pad * 2 });
      } else {
        const inner = contentArea(item.items);
        if (!inner) continue;
        const m = item.matrix;
        const xs: number[] = [];
        const ys: number[] = [];
        for (const [x, y] of [
          [inner.x, inner.y],
          [inner.x + inner.width, inner.y],
          [inner.x, inner.y + inner.height],
          [inner.x + inner.width, inner.y + inner.height],
        ] as const) {
          xs.push(m[0] * x + m[2] * y + m[4]);
          ys.push(m[1] * x + m[3] * y + m[5]);
        }
        take({ x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) });
      }
    }
    return box;
  };

  /**
   * A layer's shadows and blur as an SVG filter, built as the canvas paints
   * them: inner shadows over the layer, inside its outline; then the layer
   * blur, of the layer with its inner shadows; then the drop shadows, cast
   * by the layer as it is before it is blurred, under it. A shadow's spread
   * grows (or shrinks) its shape first. The filter covers what the layer
   * draws and as far as its effects reach, worked out in the layer's own
   * units, so that a line, which has no height, still has room for them.
   */
  const filterId = (effects: readonly Effect[], area: Area | null): string | null => {
    const parts: string[] = [];
    let index = 0;
    let reachOut = 0;
    const spreadOf = (source: string, spread: number, name: string): string => {
      if (spread === 0) return source;
      parts.push(`<feMorphology in="${source}" operator="${spread > 0 ? 'dilate' : 'erode'}" radius="${num(Math.abs(spread))}" result="${name}spread"/>`);
      return `${name}spread`;
    };
    if (effects.some((effect) => effect.type === 'BACKGROUND_BLUR')) warnings.add('A background blur is not written to SVG: SVG cannot blur what is behind a shape.');
    const inner: string[] = [];
    for (const effect of effects) {
      if (effect.type !== 'INNER_SHADOW') continue;
      const name = `inner${++index}`;
      // A spread makes the hole smaller, so more of the shadow falls inside.
      const shape = spreadOf('SourceAlpha', -effect.spread, name);
      // What is outside the shape, moved and blurred, kept where it falls inside the shape.
      parts.push(
        `<feComponentTransfer in="${shape}" result="${name}inverse"><feFuncA type="table" tableValues="1 0"/></feComponentTransfer>`,
        `<feOffset in="${name}inverse" dx="${num(effect.offsetX)}" dy="${num(effect.offsetY)}" result="${name}offset"/>`,
        `<feGaussianBlur in="${name}offset" stdDeviation="${num(effect.blur / 2)}" result="${name}blur"/>`,
        `<feFlood flood-color="${hex(effect.color)}" flood-opacity="${num(effect.opacity)}" result="${name}colour"/>`,
        `<feComposite in="${name}colour" in2="${name}blur" operator="in" result="${name}shade"/>`,
        `<feComposite in="${name}shade" in2="SourceGraphic" operator="in" result="${name}"/>`,
      );
      inner.push(name);
    }
    let content = 'SourceGraphic';
    if (inner.length > 0) {
      parts.push(`<feMerge result="painted">${['SourceGraphic', ...inner].map((name) => `<feMergeNode in="${name}"/>`).join('')}</feMerge>`);
      content = 'painted';
    }
    const blur = effects.reduce((sum, effect) => (effect.type === 'LAYER_BLUR' ? sum + effect.radius : sum), 0);
    if (blur > 0) {
      parts.push(`<feGaussianBlur in="${content}" stdDeviation="${num(blur)}" result="blurred"/>`);
      content = 'blurred';
      reachOut = Math.max(reachOut, blur * 3);
    }
    const drops: string[] = [];
    for (const effect of effects) {
      if (effect.type !== 'DROP_SHADOW') continue;
      const name = `shadow${++index}`;
      const shape = spreadOf('SourceAlpha', effect.spread, name);
      parts.push(
        `<feOffset in="${shape}" dx="${num(effect.offsetX)}" dy="${num(effect.offsetY)}" result="${name}offset"/>`,
        `<feGaussianBlur in="${name}offset" stdDeviation="${num(effect.blur / 2)}" result="${name}blur"/>`,
        `<feFlood flood-color="${hex(effect.color)}" flood-opacity="${num(effect.opacity)}" result="${name}colour"/>`,
        `<feComposite in="${name}colour" in2="${name}blur" operator="in" result="${name}"/>`,
      );
      drops.push(name);
      reachOut = Math.max(reachOut, Math.abs(effect.offsetX) + Math.abs(effect.offsetY) + effect.blur * 1.5 + Math.max(0, effect.spread));
    }
    if (parts.length === 0) return null;
    // The shadows in order, the first lowest, and the layer over them all.
    if (drops.length > 0) parts.push(`<feMerge>${[...drops, content].map((name) => `<feMergeNode in="${name}"/>`).join('')}</feMerge>`);
    const id = fresh('filter');
    const pad = reachOut + 2;
    const region = area
      ? `filterUnits="userSpaceOnUse" x="${num(area.x - pad)}" y="${num(area.y - pad)}" width="${num(area.width + pad * 2)}" height="${num(area.height + pad * 2)}"`
      : 'x="-100%" y="-100%" width="300%" height="300%"';
    defs.push(`<filter id="${id}" ${region} color-interpolation-filters="sRGB">${parts.join('')}</filter>`);
    return id;
  };

  const group = (item: VectorGroup): string => {
    const inner = item.items.map(write).join('');
    if (inner === '' && !item.mask) return '';
    let attributes = '';
    if (options.ids && item.layerId !== null) attributes += ` id="${layerId(item.name)}"`;
    if (!isIdentity(item.matrix)) attributes += ` transform="${matrixText(item.matrix)}"`;
    if (item.opacity < 1) attributes += ` opacity="${num(item.opacity)}"`;
    if (item.blend !== 'NORMAL') attributes += ` style="mix-blend-mode:${BLENDS[item.blend]}"`;
    const filter = item.effects.length > 0 ? filterId(item.effects, contentArea(item.items)) : null;
    if (filter) attributes += ` filter="url(#${filter})"`;
    let body = inner;
    if (item.clip) body = `<g clip-path="url(#${clipId(item.clip)})">${body}</g>`;
    if (item.mask) {
      const id = fresh('mask');
      defs.push(`<mask id="${id}" style="mask-type:alpha">${group(item.mask)}</mask>`);
      body = `<g mask="url(#${id})">${body}</g>`;
    }
    // A group that says nothing of its own is not written.
    return attributes === '' && item.layerId === null ? body : `<g${attributes}>${body}</g>`;
  };

  function write(item: VectorItem): string {
    return item.kind === 'group' ? group(item) : item.kind === 'fill' ? fill(item) : item.kind === 'stroke' ? stroke(item) : text(item);
  }

  const body = group(scene);
  const scale = options.scale ?? 1;
  const background = options.background ? `<rect width="${num(options.width)}" height="${num(options.height)}" fill="${hex(options.background)}"/>` : '';
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${num(options.width * scale)}" height="${num(options.height * scale)}" viewBox="0 0 ${num(options.width)} ${num(options.height)}" fill="none">` +
    (defs.length > 0 ? `<defs>${defs.join('')}</defs>` : '') +
    background +
    body +
    '</svg>';
  return { svg, warnings: [...warnings] };
}
