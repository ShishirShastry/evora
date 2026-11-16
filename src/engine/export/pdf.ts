import { imagePlacement, isGradient, multiply, type BlendMode, type GradientPaint, type ImagePaint, type Matrix, type Paint, type RGB, type TextMeasurer } from '../../core';
import type { Clip, Segment, VectorFill, VectorGroup, VectorItem, VectorStroke, VectorText } from './vector';

/**
 * Writes PDF files, with nothing but this file: the objects, the content
 * streams, and the cross-reference table.
 *
 * A page is either a vector scene (shapes as paths, gradients as shadings,
 * images as images, text as text in the nearest of the fonts every PDF
 * reader has, or as a picture of the text) or one picture of the whole
 * thing. One unit of the design is one point of the page.
 */

/** A picture for a PDF: a JPEG as it is, or pixels (red, green, blue, alpha for each). */
export type PdfImage = { kind: 'jpeg'; bytes: Uint8Array; width: number; height: number } | { kind: 'pixels'; rgba: Uint8Array | Uint8ClampedArray; width: number; height: number };

export interface PdfPage {
  width: number;
  height: number;
  /** A colour behind everything. Without one the page is white, as paper is. */
  background?: RGB | null;
  /** Either what is on the page as vectors, */
  scene?: VectorGroup;
  /** or one picture that fills it. */
  picture?: PdfImage;
}

export interface PdfOptions {
  /** Images used by image fills, by hash. */
  images?: Readonly<Record<string, PdfImage>>;
  /** Pictures of text layers, by layer ID, with where each goes in the layer's own space. A text layer with one is drawn as that picture. */
  textPictures?: Readonly<Record<string, { image: PdfImage; x: number; y: number; width: number; height: number }>>;
  /** Measures text, to place each character where the design has it. Needed for text written as text. */
  measurer?: TextMeasurer;
  /** Compresses a stream (zlib format). Without it streams are written as they are. */
  deflate?: (bytes: Uint8Array) => Promise<Uint8Array>;
  title?: string;
}

const BLEND_NAMES: Record<BlendMode, string> = {
  NORMAL: 'Normal',
  DARKEN: 'Darken',
  MULTIPLY: 'Multiply',
  COLOR_BURN: 'ColorBurn',
  LIGHTEN: 'Lighten',
  SCREEN: 'Screen',
  COLOR_DODGE: 'ColorDodge',
  OVERLAY: 'Overlay',
  SOFT_LIGHT: 'SoftLight',
  HARD_LIGHT: 'HardLight',
  DIFFERENCE: 'Difference',
  EXCLUSION: 'Exclusion',
  HUE: 'Hue',
  SATURATION: 'Saturation',
  COLOR: 'Color',
  LUMINOSITY: 'Luminosity',
};

/** Characters outside Latin-1 that the standard encoding of PDF fonts has, and their codes there. */
const WIN_ANSI: Record<string, number> = { '€': 128, '‚': 130, 'ƒ': 131, '„': 132, '…': 133, '†': 134, '‡': 135, 'ˆ': 136, '‰': 137, 'Š': 138, '‹': 139, 'Œ': 140, 'Ž': 142, '‘': 145, '’': 146, '“': 147, '”': 148, '•': 149, '–': 150, '—': 151, '˜': 152, '™': 153, 'š': 154, '›': 155, 'œ': 156, 'ž': 158, 'Ÿ': 159 };

/** The code of a character in a standard PDF font, or null when those fonts do not have it. */
export function winAnsiCode(char: string): number | null {
  const code = char.codePointAt(0) as number;
  if ((code >= 32 && code <= 126) || (code >= 160 && code <= 255)) return code;
  return WIN_ANSI[char] ?? null;
}

/** Whether a text can be written with the fonts every PDF reader has. */
export function writableAsPdfText(text: string): boolean {
  for (const char of text) if (char !== '\n' && char !== '\t' && winAnsiCode(char) === null) return false;
  return true;
}

/** The standard font nearest a font family, weight and slant. */
export function standardFont(family: string, weight: number, italic: boolean): string {
  const name = family.toLowerCase();
  const bold = weight >= 600;
  if (/mono|courier|consol|code|menlo/.test(name)) return `Courier${bold ? '-Bold' : ''}${italic ? (bold ? 'Oblique' : '-Oblique') : ''}`;
  if (/(^|[^a-z])serif|times|georgia|garamond|baskerville|playfair|merriweather|palatino/.test(name) && !/sans/.test(name)) {
    return bold ? (italic ? 'Times-BoldItalic' : 'Times-Bold') : italic ? 'Times-Italic' : 'Times-Roman';
  }
  return `Helvetica${bold ? '-Bold' : ''}${italic ? (bold ? 'Oblique' : '-Oblique') : ''}`;
}

const num = (value: number): string => {
  const rounded = Math.round(value * 10000) / 10000;
  return Object.is(rounded, -0) || !Number.isFinite(rounded) ? '0' : String(rounded);
};
const rgb = (color: RGB): string => `${num(color.r)} ${num(color.g)} ${num(color.b)}`;

const latin1 = (text: string): Uint8Array => {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
};

/** How many colour channels a JPEG has: 1 grey, 3 colour, 4 CMYK. */
function jpegChannels(bytes: Uint8Array): number {
  for (let i = 2; i + 9 < bytes.length; ) {
    if (bytes[i] !== 0xff) return 3;
    const marker = bytes[i + 1] as number;
    const length = ((bytes[i + 2] as number) << 8) | (bytes[i + 3] as number);
    // The start-of-frame markers, which say how the picture is stored.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return bytes[i + 9] as number;
    i += 2 + length;
  }
  return 3;
}

interface Stream {
  dictionary: string;
  bytes: Uint8Array;
  /** Whether the bytes may be compressed. A JPEG is compressed already. */
  compress: boolean;
}

type PdfObject = string | Stream;

/** Collects the objects of a file and writes them out with the table that says where each is. */
class PdfFile {
  private objects: (PdfObject | null)[] = [];

  /** Takes a number for an object that is written later. */
  reserve(): number {
    this.objects.push(null);
    return this.objects.length;
  }

  set(id: number, object: PdfObject): void {
    this.objects[id - 1] = object;
  }

  add(object: PdfObject): number {
    this.objects.push(object);
    return this.objects.length;
  }

  async write(rootId: number, infoId: number, deflate?: (bytes: Uint8Array) => Promise<Uint8Array>): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    let length = 0;
    const push = (chunk: Uint8Array | string): void => {
      const bytes = typeof chunk === 'string' ? latin1(chunk) : chunk;
      chunks.push(bytes);
      length += bytes.length;
    };
    // The second line is a comment of bytes above 127, which tells programs the file is not plain text.
    push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
    const offsets: number[] = [];
    for (let i = 0; i < this.objects.length; i++) {
      const object = this.objects[i] ?? 'null';
      offsets.push(length);
      push(`${i + 1} 0 obj\n`);
      if (typeof object === 'string') push(`${object}\n`);
      else {
        let bytes = object.bytes;
        let filter = '';
        if (object.compress && deflate && bytes.length > 64) {
          const packed = await deflate(bytes);
          if (packed.length < bytes.length) {
            bytes = packed;
            filter = ' /Filter /FlateDecode';
          }
        }
        push(`<<${object.dictionary}${filter} /Length ${bytes.length} >>\nstream\n`);
        push(bytes);
        push('\nendstream\n');
      }
      push('endobj\n');
    }
    const xref = length;
    push(`xref\n0 ${this.objects.length + 1}\n0000000000 65535 f \n`);
    for (const offset of offsets) push(`${String(offset).padStart(10, '0')} 00000 n \n`);
    push(`trailer\n<< /Size ${this.objects.length + 1} /Root ${rootId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    const out = new Uint8Array(length);
    let at = 0;
    for (const chunk of chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
    return out;
  }
}

/** A string as PDF writes one, for text in the document's information. */
function pdfString(text: string): string {
  let out = '';
  for (const char of text) {
    const code = winAnsiCode(char);
    if (code === null) out += '?';
    else if (char === '(' || char === ')' || char === '\\') out += `\\${char}`;
    else out += String.fromCharCode(code);
  }
  return `(${out})`;
}

export async function exportPdf(pages: readonly PdfPage[], options: PdfOptions = {}): Promise<{ bytes: Uint8Array; warnings: string[] }> {
  const file = new PdfFile();
  const warnings = new Set<string>();
  const catalogId = file.reserve();
  const pagesId = file.reserve();
  const resourcesId = file.reserve();

  // Everything pages draw with, by name, in one dictionary that every page and form uses.
  const states = new Map<string, string>();
  const fonts = new Map<string, { name: string; id: number }>();
  const patterns: { name: string; id: number }[] = [];
  const xobjects: { name: string; id: number }[] = [];
  const imageNames = new Map<PdfImage, string>();

  const state = (fill: number, stroke: number, blend: BlendMode): string => {
    const key = `${num(fill)} ${num(stroke)} ${blend}`;
    let name = states.get(key);
    if (!name) {
      name = `GS${states.size + 1}`;
      states.set(key, name);
    }
    return name;
  };

  const font = (base: string): string => {
    let entry = fonts.get(base);
    if (!entry) {
      entry = { name: `F${fonts.size + 1}`, id: file.add(`<< /Type /Font /Subtype /Type1 /BaseFont /${base} /Encoding /WinAnsiEncoding >>`) };
      fonts.set(base, entry);
    }
    return entry.name;
  };

  const image = (picture: PdfImage): string => {
    let name = imageNames.get(picture);
    if (name) return name;
    name = `Im${imageNames.size + 1}`;
    imageNames.set(picture, name);
    const common = `/Type /XObject /Subtype /Image /Width ${picture.width} /Height ${picture.height} /BitsPerComponent 8`;
    if (picture.kind === 'jpeg') {
      const channels = jpegChannels(picture.bytes);
      const space = channels === 1 ? '/DeviceGray' : channels === 4 ? '/DeviceCMYK /Decode [1 0 1 0 1 0 1 0]' : '/DeviceRGB';
      xobjects.push({ name, id: file.add({ dictionary: ` ${common} /ColorSpace ${space} /Filter /DCTDecode`, bytes: picture.bytes, compress: false }) });
      return name;
    }
    const count = picture.width * picture.height;
    const colour = new Uint8Array(count * 3);
    const alpha = new Uint8Array(count);
    let transparent = false;
    for (let i = 0; i < count; i++) {
      const a = picture.rgba[i * 4 + 3] as number;
      colour[i * 3] = picture.rgba[i * 4] as number;
      colour[i * 3 + 1] = picture.rgba[i * 4 + 1] as number;
      colour[i * 3 + 2] = picture.rgba[i * 4 + 2] as number;
      alpha[i] = a;
      if (a !== 255) transparent = true;
    }
    const mask = transparent ? file.add({ dictionary: ` ${common} /ColorSpace /DeviceGray`, bytes: alpha, compress: true }) : null;
    xobjects.push({ name, id: file.add({ dictionary: ` ${common} /ColorSpace /DeviceRGB${mask ? ` /SMask ${mask} 0 R` : ''}`, bytes: colour, compress: true }) });
    return name;
  };

  /** A function from 0..1 to the colours of a gradient's stops. */
  const stopsFunction = (paint: GradientPaint): number => {
    const stops = [...paint.stops].sort((a, b) => a.position - b.position);
    if (stops.some((stop) => stop.opacity < 1)) warnings.add('A gradient stop that is partly transparent is written solid: a PDF shading has no transparency of its own.');
    const pieces: string[] = [];
    const bounds: number[] = [];
    for (let i = 0; i < stops.length - 1; i++) {
      const a = stops[i] as GradientPaint['stops'][number];
      const b = stops[i + 1] as GradientPaint['stops'][number];
      pieces.push(`<< /FunctionType 2 /Domain [0 1] /C0 [${rgb(a.color)}] /C1 [${rgb(b.color)}] /N 1 >>`);
      if (i > 0) bounds.push(Math.min(1, Math.max(0, a.position)));
    }
    if (pieces.length === 1) return file.add(pieces[0] as string);
    // The pieces between stops, each stretched over its own part of 0..1.
    return file.add(`<< /FunctionType 3 /Domain [0 1] /Functions [${pieces.join(' ')}] /Bounds [${bounds.map(num).join(' ')}] /Encode [${pieces.map(() => '0 1').join(' ')}] >>`);
  };

  /** A gradient as a pattern that can be painted with. `ctm` is where the layer's space is on the page or form being drawn. */
  const gradient = (paint: GradientPaint, width: number, height: number, ctm: Matrix): string => {
    const fx = paint.from.x * width;
    const fy = paint.from.y * height;
    const fn = stopsFunction(paint);
    let shading: number;
    let matrix = ctm;
    if (paint.type === 'GRADIENT_LINEAR') {
      shading = file.add(`<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [${num(fx)} ${num(fy)} ${num(paint.to.x * width)} ${num(paint.to.y * height)}] /Function ${fn} 0 R /Extend [true true] >>`);
    } else {
      if (paint.type !== 'GRADIENT_RADIAL') warnings.add(`${paint.type === 'GRADIENT_ANGULAR' ? 'An angular' : 'A diamond'} gradient was written as a radial one: PDF has no such gradient.`);
      const radius = Math.max(1e-6, Math.hypot(paint.to.x - paint.from.x, paint.to.y - paint.from.y));
      shading = file.add(`<< /ShadingType 3 /ColorSpace /DeviceRGB /Coords [0 0 0 0 0 1] /Function ${fn} 0 R /Extend [false true] >>`);
      matrix = multiply(ctm, [width * radius, 0, 0, height * radius, fx, fy]);
    }
    const name = `P${patterns.length + 1}`;
    patterns.push({ name, id: file.add(`<< /Type /Pattern /PatternType 2 /Shading ${shading} 0 R /Matrix [${matrix.map(num).join(' ')}] >>`) });
    return name;
  };

  const trace = (segments: readonly Segment[]): string => {
    let out = '';
    for (const segment of segments) {
      if (segment.op === 'Z') out += 'h\n';
      else if (segment.op === 'C') out += `${num(segment.x1)} ${num(segment.y1)} ${num(segment.x2)} ${num(segment.y2)} ${num(segment.x)} ${num(segment.y)} c\n`;
      else out += `${num(segment.x)} ${num(segment.y)} ${segment.op === 'M' ? 'm' : 'l'}\n`;
    }
    return out;
  };
  const clipOps = (clip: Clip): string => `${trace(clip.path)}${clip.rule === 'evenodd' ? 'W*' : 'W'} n\n`;

  /** Sets the colour to fill or stroke with. Null for a paint that cannot colour a line or text. */
  const colour = (paint: Paint, width: number, height: number, ctm: Matrix, stroking: boolean): string | null => {
    if (paint.type === 'SOLID') return `${rgb(paint.color)} ${stroking ? 'RG' : 'rg'}\n`;
    if (!isGradient(paint)) return null;
    return `/Pattern ${stroking ? 'CS' : 'cs'} /${gradient(paint, width, height, ctm)} ${stroking ? 'SCN' : 'scn'}\n`;
  };

  /** Draws a picture into a box of the current space, the right way up. */
  const draw = (picture: PdfImage, x: number, y: number, width: number, height: number): string => `q ${num(width)} 0 0 ${num(-height)} ${num(x)} ${num(y + height)} cm /${image(picture)} Do Q\n`;

  const imageFill = (item: VectorFill, paint: ImagePaint): string => {
    const picture = options.images?.[paint.imageHash];
    let out = `q\n${clipOps({ path: item.path, rule: item.rule })}`;
    if (!picture) {
      warnings.add('An image could not be found on this device and was left as a grey box.');
      return `${out}/${state(0.35, 1, 'NORMAL')} gs 0.5 0.54 0.54 rg 0 0 ${num(item.width)} ${num(item.height)} re f\nQ\n`;
    }
    if (paint.exposure !== 0 || paint.contrast !== 0 || paint.saturation !== 0) warnings.add('Image adjustments (exposure, contrast, saturation) are not written to a vector PDF: the image is as it was imported.');
    if (paint.opacity < 1) out += `/${state(paint.opacity, 1, 'NORMAL')} gs\n`;
    if (paint.flipX || paint.flipY) out += `${paint.flipX ? -1 : 1} 0 0 ${paint.flipY ? -1 : 1} ${num(paint.flipX ? item.width : 0)} ${num(paint.flipY ? item.height : 0)} cm\n`;
    if (paint.scaleMode === 'TILE') {
      const scale = Math.max(0.01, paint.tileScale);
      const w = picture.width * scale;
      const h = picture.height * scale;
      const columns = Math.ceil(item.width / w);
      const rows = Math.ceil(item.height / h);
      if (columns * rows > 2500) warnings.add('A tiled image has too many tiles for a PDF; only the first 2500 were written.');
      let written = 0;
      for (let row = 0; row < rows && written < 2500; row++) for (let column = 0; column < columns && written < 2500; column++, written++) out += draw(picture, column * w, row * h, w, h);
      return `${out}Q\n`;
    }
    const placement = imagePlacement(paint.scaleMode, picture.width, picture.height, item.width, item.height, paint.crop);
    if (!placement) return `${out}Q\n`;
    const { source, target } = placement;
    // The whole picture, placed so that the part that is used lands where it goes; the outline hides the rest.
    const sx = target.width / source.width;
    const sy = target.height / source.height;
    out += `${num(target.x)} ${num(target.y)} ${num(target.width)} ${num(target.height)} re W n\n`;
    out += draw(picture, target.x - source.x * sx, target.y - source.y * sy, picture.width * sx, picture.height * sy);
    return `${out}Q\n`;
  };

  const fill = (item: VectorFill, ctm: Matrix): string => {
    if (item.paint.type === 'IMAGE') return imageFill(item, item.paint);
    const set = colour(item.paint, item.width, item.height, ctm, false);
    if (set === null || item.path.length === 0) return '';
    return `q\n${item.paint.opacity < 1 ? `/${state(item.paint.opacity, 1, 'NORMAL')} gs\n` : ''}${set}${trace(item.path)}${item.rule === 'evenodd' ? 'f*' : 'f'}\nQ\n`;
  };

  const stroke = (item: VectorStroke, ctm: Matrix): string => {
    const set = colour(item.paint, item.width, item.height, ctm, true);
    if (set === null || item.path.length === 0) return '';
    let out = 'q\n';
    if (item.clip) out += clipOps(item.clip);
    if (item.paint.opacity < 1) out += `/${state(1, item.paint.opacity, 'NORMAL')} gs\n`;
    out += `${set}${num(item.lineWidth)} w ${item.cap === 'ROUND' ? 1 : item.cap === 'SQUARE' ? 2 : 0} J ${item.join === 'ROUND' ? 1 : item.join === 'BEVEL' ? 2 : 0} j [${item.dash.map(num).join(' ')}] 0 d\n`;
    return `${out}${trace(item.path)}S\nQ\n`;
  };

  const text = (item: VectorText, ctm: Matrix): string => {
    const { node } = item;
    const picture = options.textPictures?.[node.id];
    if (picture) return draw(picture.image, picture.x, picture.y, picture.width, picture.height);
    const measurer = options.measurer;
    const paint = node.fills.find((entry) => entry.visible && entry.opacity > 0 && entry.type !== 'IMAGE');
    if (node.fills.filter((entry) => entry.visible && entry.opacity > 0).length > 1) warnings.add('Text with several fills is written in its first fill only.');
    if (node.strokeWeight > 0 && node.strokes.some((entry) => entry.visible)) warnings.add('The outline of text is not written when text is written as text; choose “Text as pictures” to keep it.');
    let out = 'q\n';
    if (node.flipX || node.flipY) out += `${node.flipX ? -1 : 1} 0 0 ${node.flipY ? -1 : 1} ${num(node.flipX ? node.width : 0)} ${num(node.flipY ? node.height : 0)} cm\n`;
    const local = node.flipX || node.flipY ? multiply(ctm, [node.flipX ? -1 : 1, 0, 0, node.flipY ? -1 : 1, node.flipX ? node.width : 0, node.flipY ? node.height : 0]) : ctm;
    if (paint && paint.opacity < 1) out += `/${state(paint.opacity, 1, 'NORMAL')} gs\n`;
    const base = paint ? colour(paint, node.width, node.height, local, false) : null;
    for (const line of item.lines) {
      for (const run of line.marker ? [line.marker, ...line.runs] : line.runs) {
        if (run.text === '') continue;
        const style = run.style;
        const set = style.color ? `${rgb(style.color)} rg\n` : base;
        if (set === null) continue;
        out += set;
        const name = font(standardFont(style.fontFamily, style.fontWeight, style.italic));
        out += `BT /${name} ${num(style.fontSize)} Tf\n`;
        // Each character goes where the design's own font puts it, so lines keep their length in the stand-in font.
        let before = '';
        for (const char of run.text) {
          const code = winAnsiCode(char);
          const x = run.x + (measurer ? measurer.width(before, style) : (run.width * [...before].length) / Math.max(1, [...run.text].length));
          before += char;
          if (code === null || char === ' ') continue;
          const escaped = code === 40 || code === 41 || code === 92 ? `\\${String.fromCharCode(code)}` : String.fromCharCode(code);
          out += `1 0 0 -1 ${num(x)} ${num(line.baseline)} Tm (${escaped}) Tj\n`;
        }
        out += 'ET\n';
        const offset = style.textDecoration === 'UNDERLINE' ? style.fontSize * 0.12 : style.textDecoration === 'STRIKETHROUGH' ? -style.fontSize * 0.3 : null;
        if (offset !== null) out += `${num(run.x)} ${num(line.baseline + offset)} ${num(run.width)} ${num(Math.max(1, style.fontSize / 16))} re f\n`;
      }
    }
    return `${out}Q\n`;
  };

  /** A group drawn on its own and then laid down as one thing, which is what makes its opacity and blend mode apply to it as a whole. */
  const form = (content: string): string => {
    const name = `Fm${xobjects.length + 1}`;
    xobjects.push({
      name,
      id: file.add({ dictionary: ` /Type /XObject /Subtype /Form /BBox [-100000 -100000 100000 100000] /Group << /S /Transparency /CS /DeviceRGB /I true >> /Resources ${resourcesId} 0 R`, bytes: latin1(content), compress: true }),
    });
    return name;
  };

  const group = (item: VectorGroup, ctm: Matrix): string => {
    if (item.effects.some((effect) => effect.type === 'DROP_SHADOW' || effect.type === 'INNER_SHADOW' || effect.type === 'LAYER_BLUR' || effect.type === 'BACKGROUND_BLUR')) {
      warnings.add('Shadows and blurs are not written to a vector PDF. Choose “As a picture” for the PDF’s content to keep them.');
    }
    const whole = item.opacity < 1 || item.blend !== 'NORMAL';
    // One shape with one opaque paint can take the opacity itself; anything more is drawn apart and laid down as a whole.
    const only = item.items.length === 1 ? item.items[0] : undefined;
    const single = !item.mask && only !== undefined && (only.kind === 'fill' || only.kind === 'stroke') && only.paint.type !== 'IMAGE' && only.paint.opacity === 1;
    // Inside a form, shadings are placed from the form's own space, which starts where the form is drawn.
    const inner = whole && !single ? ([1, 0, 0, 1, 0, 0] as Matrix) : multiply(ctm, item.matrix);
    let body = '';
    if (item.mask) {
      // PDF has no cheap way to mask by what a layer paints: what is masked is clipped to the mask's own outline.
      const outline = item.mask.items.find((entry): entry is VectorFill => entry.kind === 'fill');
      if (outline) body += `${num(item.mask.matrix[0])} ${num(item.mask.matrix[1])} ${num(item.mask.matrix[2])} ${num(item.mask.matrix[3])} ${num(item.mask.matrix[4])} ${num(item.mask.matrix[5])} cm\n${clipOps({ path: outline.path, rule: outline.rule })}`;
      if (outline) {
        // Back to the group's own space for what is masked.
        const m = item.mask.matrix;
        const det = m[0] * m[3] - m[1] * m[2] || 1;
        const inverse: Matrix = [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
        body += `${inverse.map(num).join(' ')} cm\n`;
      } else warnings.add('A mask that is not a single shape is not applied in a vector PDF.');
      if (item.mask.opacity < 1 || item.mask.items.some((entry) => entry.kind === 'fill' && entry.paint.type !== 'SOLID')) warnings.add('A mask is applied by its outline in a vector PDF: how transparent it is in places is not.');
    }
    if (item.clip) body += clipOps(item.clip);
    for (const child of item.items) body += write(child, inner);
    if (body === '') return '';
    const place = `${item.matrix.map(num).join(' ')} cm\n`;
    if (!whole) return `q\n${place}${body}Q\n`;
    if (single) return `q\n${place}/${state(item.opacity, item.opacity, item.blend)} gs\n${body}Q\n`;
    return `q\n${place}/${state(item.opacity, item.opacity, item.blend)} gs /${form(body)} Do\nQ\n`;
  };

  function write(item: VectorItem, ctm: Matrix): string {
    return item.kind === 'group' ? group(item, ctm) : item.kind === 'fill' ? fill(item, ctm) : item.kind === 'stroke' ? stroke(item, ctm) : text(item, ctm);
  }

  const pageIds: number[] = [];
  for (const page of pages) {
    // The page's space is turned over, so that y runs down as it does in the design.
    const flip: Matrix = [1, 0, 0, -1, 0, page.height];
    let content = `${flip.map(num).join(' ')} cm\n`;
    if (page.background) content += `${rgb(page.background)} rg 0 0 ${num(page.width)} ${num(page.height)} re f\n`;
    if (page.picture) content += draw(page.picture, 0, 0, page.width, page.height);
    else if (page.scene) content += group(page.scene, flip);
    const contentId = file.add({ dictionary: '', bytes: latin1(content), compress: true });
    pageIds.push(file.add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${num(page.width)} ${num(page.height)}] /Resources ${resourcesId} 0 R /Contents ${contentId} 0 R /Group << /S /Transparency /CS /DeviceRGB >> >>`));
  }

  const entries = (items: readonly { name: string; id: number }[]): string => items.map((item) => `/${item.name} ${item.id} 0 R`).join(' ');
  const stateEntries = [...states.entries()]
    .map(([key, name]) => {
      const [fill, stroke, blend] = key.split(' ') as [string, string, BlendMode];
      return `/${name} << /Type /ExtGState /ca ${fill} /CA ${stroke} /BM /${BLEND_NAMES[blend]} >>`;
    })
    .join(' ');
  file.set(resourcesId, `<< /ProcSet [/PDF /Text /ImageB /ImageC] /ExtGState << ${stateEntries} >> /Font << ${entries([...fonts.values()])} >> /Pattern << ${entries(patterns)} >> /XObject << ${entries(xobjects)} >> >>`);
  file.set(pagesId, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`);
  file.set(catalogId, `<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  const infoId = file.add(`<< /Title ${pdfString(options.title ?? 'Untitled')} /Producer (OPEN DESIGN) /Creator (OPEN DESIGN) >>`);
  return { bytes: await file.write(catalogId, infoId, options.deflate), warnings: [...warnings] };
}
