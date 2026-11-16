import { createLayer, createPage } from '../document/factory';
import {
  isLayer,
  isPage,
  type AssetInfo,
  type BlendMode,
  type DesignNode,
  type Document,
  type Effect,
  type GradientPaint,
  type LayerNode,
  type LayerPatch,
  type LayerType,
  type NodeId,
  type Paint,
  type RGB,
  type VectorNetwork,
} from '../document/schema';
import { repairDocument } from '../document/validate';
import { readZip, writeZip, isZip } from '../files/zip';
import { createId } from '../ids';
import { restoreLayout } from '../layout/restore';
import { applyToPoint, invert, type Matrix } from '../math/matrix';
import { freshKeys } from '../order';
import { getChildIds, getPages, sortByPaintOrder } from '../scene/tree';
import type { TextMeasurer } from '../text/layout';
import { compileSchema, decodeBinarySchema, encodeBinarySchema, KiwiError, parseSchemaText, type KiwiObject, type KiwiValue } from './kiwi';
import { sha1, toHex } from './sha1';
import { isZstd, zstdDecompress, ZstdError } from './zstd';

/**
 * Figma's `.fig` files, read into a document and written from one.
 *
 * What is known of the format comes from the files themselves, not from a
 * published specification, and Figma changes it without notice. A `.fig`
 * file is a ZIP archive holding `canvas.fig` (and `images/`, `meta.json`,
 * a thumbnail), or that `canvas.fig` on its own. `canvas.fig` begins with
 * "fig-kiwi", a version number, and then chunks, each its length and its
 * bytes, compressed with deflate or Zstandard: first the schema of the data,
 * in Kiwi's binary form, then the data, a message whose `nodeChanges` are
 * every node of the file. Since the schema travels with the data, the data
 * is read by the names of its fields, whatever their numbers are.
 *
 * Reading converts what this application has a place for and lists the
 * rest; nothing is dropped without being named.
 */

export class FigError extends Error {}

export interface FigEnvironment {
  /** Undoes raw deflate (for ZIP entries and older chunks). */
  inflateRaw(bytes: Uint8Array): Promise<Uint8Array>;
  /** Compresses with raw deflate, for writing. */
  deflateRaw(bytes: Uint8Array): Promise<Uint8Array>;
  /** The SHA-256 of bytes, as hex: how this application names its images. */
  sha256Hex(bytes: Uint8Array): Promise<string>;
  /** Lays text out as the editor does, for converting text and instances. */
  measurer: TextMeasurer;
}

export interface FigRead {
  doc: Document;
  /** The bytes of each image the document uses, by this application's hash. */
  images: Record<string, { mimeType: string; bytes: Uint8Array }>;
  /** What the file has that was not converted, each said once, with how many. */
  notConverted: string[];
  /** The version number the file says it is. */
  version: number;
}

const MAGIC = 'fig-kiwi';
/** The version written in files made here: one of the versions Figma has written. */
const WRITE_VERSION = 48;

/**
 * The schema of the files this application writes. It uses the names Figma's
 * files use, as far as they are known, and only the fields that are written.
 */
export const FIG_SCHEMA = `
enum MessageType { JOIN_START = 0; NODE_CHANGES = 1; }
enum NodePhase { CREATED = 0; REMOVED = 1; }
enum NodeType { NONE = 0; DOCUMENT = 1; CANVAS = 2; GROUP = 3; FRAME = 4; BOOLEAN_OPERATION = 5; VECTOR = 6; STAR = 7; LINE = 8; ELLIPSE = 9; RECTANGLE = 10; REGULAR_POLYGON = 11; ROUNDED_RECTANGLE = 12; TEXT = 13; SLICE = 14; SYMBOL = 15; INSTANCE = 16; }
enum BlendMode { PASS_THROUGH = 0; NORMAL = 1; DARKEN = 2; MULTIPLY = 3; LINEAR_BURN = 4; COLOR_BURN = 5; LIGHTEN = 6; SCREEN = 7; LINEAR_DODGE = 8; COLOR_DODGE = 9; OVERLAY = 10; SOFT_LIGHT = 11; HARD_LIGHT = 12; DIFFERENCE = 13; EXCLUSION = 14; HUE = 15; SATURATION = 16; COLOR = 17; LUMINOSITY = 18; }
enum PaintType { SOLID = 0; GRADIENT_LINEAR = 1; GRADIENT_RADIAL = 2; GRADIENT_ANGULAR = 3; GRADIENT_DIAMOND = 4; IMAGE = 5; }
enum ImageScaleMode { STRETCH = 0; FIT = 1; FILL = 2; TILE = 3; }
enum EffectType { INNER_SHADOW = 0; DROP_SHADOW = 1; FOREGROUND_BLUR = 2; BACKGROUND_BLUR = 3; }
enum StrokeAlign { CENTER = 0; INSIDE = 1; OUTSIDE = 2; }
enum StrokeCap { NONE = 0; ROUND = 1; SQUARE = 2; }
enum StrokeJoin { MITER = 0; BEVEL = 1; ROUND = 2; }
enum TextAlignHorizontal { LEFT = 0; CENTER = 1; RIGHT = 2; JUSTIFIED = 3; }
enum TextAlignVertical { TOP = 0; CENTER = 1; BOTTOM = 2; }
enum NumberUnits { RAW = 0; PIXELS = 1; PERCENT = 2; }
enum TextAutoResize { NONE = 0; WIDTH_AND_HEIGHT = 1; HEIGHT = 2; }
enum TextDecoration { NONE = 0; UNDERLINE = 1; STRIKETHROUGH = 2; }
enum TextCase { ORIGINAL = 0; UPPER = 1; LOWER = 2; TITLE = 3; }
enum StackMode { NONE = 0; HORIZONTAL = 1; VERTICAL = 2; }
enum StackJustify { MIN = 0; CENTER = 1; MAX = 2; SPACE_EVENLY = 3; SPACE_BETWEEN = 4; }
enum StackAlign { MIN = 0; CENTER = 1; MAX = 2; BASELINE = 3; }
enum BooleanOperation { UNION = 0; INTERSECT = 1; SUBTRACT = 2; XOR = 3; }
struct GUID { uint sessionID; uint localID; }
struct Color { float r; float g; float b; float a; }
struct Vector { float x; float y; }
struct Matrix { float m00; float m01; float m02; float m10; float m11; float m12; }
struct ColorStop { Color color; float position; }
message ParentIndex { GUID guid = 1; string position = 2; }
message Number { float value = 1; NumberUnits units = 2; }
message FontName { string family = 1; string style = 2; string postscript = 3; }
message TextData { string characters = 1; }
message Image { byte[] hash = 1; string name = 2; }
message Paint { PaintType type = 1; Color color = 2; float opacity = 3; bool visible = 4; BlendMode blendMode = 5; ColorStop[] stops = 6; Matrix transform = 7; Image image = 8; ImageScaleMode imageScaleMode = 9; float scale = 10; }
message Effect { EffectType type = 1; Color color = 2; Vector offset = 3; float radius = 4; bool visible = 5; BlendMode blendMode = 6; float spread = 7; }
message SymbolData { GUID symbolID = 1; }
message VectorData { uint vectorNetworkBlob = 1; Vector normalizedSize = 2; }
message ArcData { float startingAngle = 1; float endingAngle = 2; float innerRadius = 3; }
message Blob { byte[] bytes = 1; }
message NodeChange {
  GUID guid = 1; NodePhase phase = 2; ParentIndex parentIndex = 3; NodeType type = 4; string name = 5;
  bool visible = 6; bool locked = 7; float opacity = 8; BlendMode blendMode = 9; Vector size = 10; Matrix transform = 11;
  Paint[] fillPaints = 12; Paint[] strokePaints = 13; float strokeWeight = 14; StrokeAlign strokeAlign = 15; StrokeCap strokeCap = 16; StrokeJoin strokeJoin = 17; float[] dashPattern = 18;
  float cornerRadius = 19; float rectangleTopLeftCornerRadius = 20; float rectangleTopRightCornerRadius = 21; float rectangleBottomLeftCornerRadius = 22; float rectangleBottomRightCornerRadius = 23; bool rectangleCornerRadiiIndependent = 24;
  bool frameMaskDisabled = 25; Effect[] effects = 26; bool mask = 27;
  TextData textData = 28; float fontSize = 29; FontName fontName = 30; TextAlignHorizontal textAlignHorizontal = 31; TextAlignVertical textAlignVertical = 32; Number letterSpacing = 33; Number lineHeight = 34; TextAutoResize textAutoResize = 35; TextDecoration textDecoration = 36; TextCase textCase = 37;
  StackMode stackMode = 38; float stackSpacing = 39; float stackHorizontalPadding = 40; float stackVerticalPadding = 41; float stackPaddingRight = 42; float stackPaddingBottom = 43; StackJustify stackPrimaryAlignItems = 44; StackAlign stackCounterAlignItems = 45;
  SymbolData symbolData = 46; float starInnerScale = 47; uint count = 48; ArcData arcData = 49; VectorData vectorData = 50; BooleanOperation booleanOperation = 51; Color backgroundColor = 52; bool internalOnly = 53; bool resizeToFit = 54; bool isStateGroup = 55; string description = 56;
}
message Message { MessageType type = 1; uint sessionID = 2; uint ackID = 3; NodeChange[] nodeChanges = 4; Blob[] blobs = 5; }
`;

// ------------------------------------------------------------------ reading

/** The chunks of a `canvas.fig`, after its header. */
function chunks(bytes: Uint8Array): { version: number; parts: Uint8Array[] } {
  const header = String.fromCharCode(...bytes.subarray(0, 8));
  // FigJam files say "fig-jam." in the same place, and are laid out the same way.
  if (header !== MAGIC && header !== 'fig-jam.') throw new FigError('This is not a Figma file: it does not begin as one does.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(8, true);
  const parts: Uint8Array[] = [];
  let at = 12;
  while (at + 4 <= bytes.length) {
    const size = view.getUint32(at, true);
    at += 4;
    if (at + size > bytes.length) throw new FigError('The Figma file ends in the middle of its data: it is damaged or cut short.');
    parts.push(bytes.subarray(at, at + size));
    at += size;
  }
  if (parts.length < 2) throw new FigError('The Figma file has no data in it.');
  return { version, parts };
}

async function unpack(part: Uint8Array, env: FigEnvironment): Promise<Uint8Array> {
  if (isZstd(part)) return zstdDecompress(part);
  try {
    return await env.inflateRaw(part);
  } catch {
    throw new FigError('Part of the Figma file is compressed in a way that cannot be read.');
  }
}

function mimeOf(bytes: Uint8Array): string | null {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57) return 'image/webp';
  return null;
}

/** The size of a picture, read from its header. */
export function imageSize(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const mime = mimeOf(bytes);
  try {
    if (mime === 'image/png') return { width: view.getUint32(16), height: view.getUint32(20) };
    if (mime === 'image/gif') return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
    if (mime === 'image/jpeg') {
      for (let at = 2; at + 9 < bytes.length; ) {
        const marker = bytes[at + 1] as number;
        const length = view.getUint16(at + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { width: view.getUint16(at + 7), height: view.getUint16(at + 5) };
        at += 2 + length;
      }
    }
    if (mime === 'image/webp' && bytes[15] === 0x58) return { width: 1 + (bytes[24] as number) + ((bytes[25] as number) << 8) + ((bytes[26] as number) << 16), height: 1 + (bytes[27] as number) + ((bytes[28] as number) << 8) + ((bytes[29] as number) << 16) };
  } catch {
    // A header too short to read: the size is not known.
  }
  return { width: 1, height: 1 };
}

const obj = (value: KiwiValue | undefined): KiwiObject => (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Uint8Array) ? (value as KiwiObject) : {});
const list = (value: KiwiValue | undefined): KiwiValue[] => (Array.isArray(value) ? value : []);
const num = (value: KiwiValue | undefined, fallback = 0): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);
const str = (value: KiwiValue | undefined, fallback = ''): string => (typeof value === 'string' ? value : fallback);
const guidKey = (value: KiwiValue | undefined): string => `${num(obj(value).sessionID)}:${num(obj(value).localID)}`;
const colour = (value: KiwiValue | undefined): { color: RGB; a: number } => {
  const c = obj(value);
  return { color: { r: num(c.r), g: num(c.g), b: num(c.b) }, a: num(c.a, 1) };
};
/** A Figma matrix (m00 m01 m02 / m10 m11 m12) as this application's [a b c d e f]. */
const matrixOf = (value: KiwiValue | undefined): Matrix => {
  const m = obj(value);
  return [num(m.m00, 1), num(m.m10), num(m.m01), num(m.m11, 1), num(m.m02), num(m.m12)];
};

const BLENDS: Record<string, BlendMode> = { NORMAL: 'NORMAL', PASS_THROUGH: 'NORMAL', DARKEN: 'DARKEN', MULTIPLY: 'MULTIPLY', COLOR_BURN: 'COLOR_BURN', LIGHTEN: 'LIGHTEN', SCREEN: 'SCREEN', COLOR_DODGE: 'COLOR_DODGE', OVERLAY: 'OVERLAY', SOFT_LIGHT: 'SOFT_LIGHT', HARD_LIGHT: 'HARD_LIGHT', DIFFERENCE: 'DIFFERENCE', EXCLUSION: 'EXCLUSION', HUE: 'HUE', SATURATION: 'SATURATION', COLOR: 'COLOR', LUMINOSITY: 'LUMINOSITY' };

/** A vector network as Figma stores it in a blob: its points, its curves and its filled regions, scaled from `normalizedSize`. */
export function readVectorBlob(bytes: Uint8Array, scaleX: number, scaleY: number): VectorNetwork {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const vertexCount = view.getUint32(0, true);
  const segmentCount = view.getUint32(4, true);
  if (12 + vertexCount * 12 + segmentCount * 28 > bytes.length) throw new FigError('A vector of the Figma file is damaged.');
  let at = 12;
  const vertices = [];
  for (let i = 0; i < vertexCount; i++, at += 12) vertices.push({ x: view.getFloat32(at + 4, true) * scaleX, y: view.getFloat32(at + 8, true) * scaleY });
  const segments = [];
  for (let i = 0; i < segmentCount; i++, at += 28) {
    const start = view.getUint32(at + 4, true);
    const end = view.getUint32(at + 16, true);
    if (start >= vertexCount || end >= vertexCount) throw new FigError('A vector of the Figma file is damaged.');
    segments.push({ start, end, tangentStart: { x: view.getFloat32(at + 8, true) * scaleX, y: view.getFloat32(at + 12, true) * scaleY }, tangentEnd: { x: view.getFloat32(at + 20, true) * scaleX, y: view.getFloat32(at + 24, true) * scaleY } });
  }
  return { vertices, segments };
}

/** A vector network as a Figma blob, with no regions (a region is worked out from the curves when there is none). */
export function writeVectorBlob(network: VectorNetwork): Uint8Array {
  const out = new Uint8Array(12 + network.vertices.length * 12 + network.segments.length * 28);
  const view = new DataView(out.buffer);
  view.setUint32(0, network.vertices.length, true);
  view.setUint32(4, network.segments.length, true);
  view.setUint32(8, 0, true);
  let at = 12;
  for (const vertex of network.vertices) {
    view.setFloat32(at + 4, vertex.x, true);
    view.setFloat32(at + 8, vertex.y, true);
    at += 12;
  }
  for (const segment of network.segments) {
    view.setUint32(at + 4, segment.start, true);
    view.setFloat32(at + 8, segment.tangentStart.x, true);
    view.setFloat32(at + 12, segment.tangentStart.y, true);
    view.setUint32(at + 16, segment.end, true);
    view.setFloat32(at + 20, segment.tangentEnd.x, true);
    view.setFloat32(at + 24, segment.tangentEnd.y, true);
    at += 28;
  }
  return out;
}

/** Where a gradient goes, from a Figma paint's transform (which maps the layer's box onto the gradient's own space). */
function gradientEnds(transform: Matrix, radial: boolean): { from: { x: number; y: number }; to: { x: number; y: number } } {
  const back = invert(transform);
  return radial ? { from: applyToPoint(back, { x: 0.5, y: 0.5 }), to: applyToPoint(back, { x: 1, y: 0.5 }) } : { from: applyToPoint(back, { x: 0, y: 0.5 }), to: applyToPoint(back, { x: 1, y: 0.5 }) };
}

/** The Figma transform of a gradient from where it goes. */
function gradientTransform(paint: GradientPaint): Matrix {
  const radial = paint.type !== 'GRADIENT_LINEAR';
  const d = { x: paint.to.x - paint.from.x, y: paint.to.y - paint.from.y };
  const n = { x: -d.y, y: d.x };
  // The matrix that takes the gradient's space to the layer's box; Figma keeps its inverse.
  const forward: Matrix = radial ? [2 * d.x, 2 * d.y, 2 * n.x, 2 * n.y, paint.from.x - d.x - n.x, paint.from.y - d.y - n.y] : [d.x, d.y, n.x, n.y, paint.from.x - 0.5 * n.x, paint.from.y - 0.5 * n.y];
  return invert(forward);
}

/**
 * Reads a `.fig` file: a ZIP archive or a bare `canvas.fig`. Throws a
 * `FigError` that says what is wrong when it cannot be read.
 */
export async function readFig(bytes: Uint8Array, name: string, env: FigEnvironment): Promise<FigRead> {
  let canvas = bytes;
  const zipped = new Map<string, Uint8Array>();
  if (isZip(bytes)) {
    let entries;
    try {
      entries = await readZip(bytes, env.inflateRaw);
    } catch (error) {
      throw new FigError(`The Figma file could not be opened as an archive. ${error instanceof Error ? error.message : ''}`);
    }
    for (const entry of entries) zipped.set(entry.name, entry.bytes);
    const found = zipped.get('canvas.fig') ?? [...zipped.entries()].find(([entry]) => entry.endsWith('.fig'))?.[1];
    if (!found) throw new FigError('The archive has no canvas.fig in it: it is not a Figma file.');
    canvas = found;
  }
  const { version, parts } = chunks(canvas);
  let message: KiwiObject;
  try {
    const schema = decodeBinarySchema(await unpack(parts[0] as Uint8Array, env));
    message = compileSchema(schema).decode('Message', await unpack(parts[1] as Uint8Array, env));
  } catch (error) {
    if (error instanceof KiwiError || error instanceof ZstdError) throw new FigError(`The Figma file's data could not be read: ${error.message}`);
    throw error;
  }
  return convert(message, zipped, name, version, env);
}

async function convert(message: KiwiObject, zipped: Map<string, Uint8Array>, name: string, version: number, env: FigEnvironment): Promise<FigRead> {
  const missed = new Map<string, number>();
  const miss = (what: string): void => {
    missed.set(what, (missed.get(what) ?? 0) + 1);
  };
  const blobs = list(message.blobs).map((blob) => obj(blob).bytes).map((bytes) => (bytes instanceof Uint8Array ? bytes : new Uint8Array(0)));
  const changes = list(message.nodeChanges).map(obj).filter((change) => str(change.phase, 'CREATED') !== 'REMOVED');
  const children = new Map<string, KiwiObject[]>();
  for (const change of changes) {
    const parent = obj(change.parentIndex);
    if (!parent.guid) continue;
    const key = guidKey(parent.guid);
    children.set(key, [...(children.get(key) ?? []), change]);
  }
  for (const list of children.values()) list.sort((a, b) => (str(obj(a.parentIndex).position) < str(obj(b.parentIndex).position) ? -1 : str(obj(a.parentIndex).position) > str(obj(b.parentIndex).position) ? 1 : 0));

  const ids = new Map<string, NodeId>();
  const idOf = (key: string): NodeId => {
    let id = ids.get(key);
    if (!id) {
      id = createId();
      ids.set(key, id);
    }
    return id;
  };

  // Images: named in the archive by the SHA-1 of their bytes, kept here by their SHA-256.
  const images: FigRead['images'] = {};
  const assets: Record<string, AssetInfo> = {};
  const imageHashes = new Map<string, string>();
  const imageFor = async (paint: KiwiObject): Promise<string | null> => {
    const hash = obj(paint.image).hash;
    const key = hash instanceof Uint8Array ? toHex(hash) : '';
    if (imageHashes.has(key)) return imageHashes.get(key) as string;
    const bytes = zipped.get(`images/${key}`);
    const mime = bytes ? mimeOf(bytes) : null;
    if (!bytes || !mime) {
      miss('Image fills whose pictures are not in the file (a bare canvas.fig keeps none)');
      return null;
    }
    const ours = await env.sha256Hex(bytes);
    images[ours] = { mimeType: mime, bytes };
    assets[ours] = { mimeType: mime, ...imageSize(bytes), name: str(obj(paint.image).name, 'Image') };
    imageHashes.set(key, ours);
    return ours;
  };

  const paints = async (values: KiwiValue | undefined): Promise<Paint[]> => {
    const out: Paint[] = [];
    for (const value of list(values)) {
      const paint = obj(value);
      const type = str(paint.type, 'SOLID');
      const visible = paint.visible !== false;
      const opacity = num(paint.opacity, 1);
      if (type === 'SOLID') {
        const c = colour(paint.color);
        out.push({ type: 'SOLID', color: c.color, opacity: opacity * c.a, visible });
      } else if (type.startsWith('GRADIENT_')) {
        const stops = list(paint.stops).map((stop) => {
          const c = colour(obj(stop).color);
          return { position: Math.min(1, Math.max(0, num(obj(stop).position))), color: c.color, opacity: c.a };
        });
        if (stops.length < 2) continue;
        out.push({ type: type as GradientPaint['type'], stops, ...gradientEnds(paint.transform ? matrixOf(paint.transform) : [1, 0, 0, 1, 0, 0], type !== 'GRADIENT_LINEAR'), opacity, visible });
      } else if (type === 'IMAGE') {
        const hash = await imageFor(paint);
        if (!hash) continue;
        const mode = str(paint.imageScaleMode, 'FILL');
        if (mode === 'STRETCH') miss('The crop of image fills set to “Crop” (shown whole)');
        if (paint.filters) miss('Image adjustments');
        out.push({ type: 'IMAGE', imageHash: hash, scaleMode: mode === 'FIT' ? 'FIT' : mode === 'TILE' ? 'TILE' : mode === 'STRETCH' ? 'CROP' : 'FILL', crop: { x: 0, y: 0, width: 1, height: 1 }, tileScale: num(paint.scale, 1), exposure: 0, contrast: 0, saturation: 0, flipX: false, flipY: false, opacity, visible });
      } else miss(`Paints of the kind “${type}”`);
    }
    return out;
  };

  const effects = (values: KiwiValue | undefined): Effect[] =>
    list(values).flatMap((value): Effect[] => {
      const effect = obj(value);
      const type = str(effect.type);
      const visible = effect.visible !== false;
      if (type === 'DROP_SHADOW' || type === 'INNER_SHADOW') {
        const c = colour(effect.color);
        return [{ type, color: c.color, opacity: c.a, offsetX: num(obj(effect.offset).x), offsetY: num(obj(effect.offset).y), blur: num(effect.radius), spread: num(effect.spread), visible }];
      }
      if (type === 'FOREGROUND_BLUR' || type === 'BACKGROUND_BLUR') return [{ type: type === 'FOREGROUND_BLUR' ? 'LAYER_BLUR' : 'BACKGROUND_BLUR', radius: num(effect.radius), visible }];
      miss(`Effects of the kind “${type}”`);
      return [];
    });

  const nodes: Record<NodeId, DesignNode> = {};
  const pages: NodeId[] = [];
  const root = changes.find((change) => str(change.type) === 'DOCUMENT');
  const documentKey = root ? guidKey(root.guid) : '0:0';
  const canvases = (children.get(documentKey) ?? []).filter((change) => str(change.type) === 'CANVAS');
  const pageKeys = freshKeys(Math.max(1, canvases.length));
  let pageIndex = 0;
  for (const canvasNode of canvases) {
    // Figma keeps the components of other files on a page of its own that is never shown.
    if (canvasNode.internalOnly === true) {
      if ((children.get(guidKey(canvasNode.guid)) ?? []).length > 0) miss('Components from libraries (kept in Figma on a hidden page)');
      continue;
    }
    const page = { ...createPage(str(canvasNode.name, 'Page'), pageKeys[pageIndex++] as string), id: idOf(guidKey(canvasNode.guid)) };
    if (canvasNode.backgroundColor) page.backgroundColor = colour(canvasNode.backgroundColor).color;
    nodes[page.id] = page;
    pages.push(page.id);
  }

  const TYPES: Record<string, LayerType> = { FRAME: 'FRAME', SYMBOL: 'FRAME', INSTANCE: 'FRAME', GROUP: 'GROUP', RECTANGLE: 'RECTANGLE', ROUNDED_RECTANGLE: 'RECTANGLE', ELLIPSE: 'ELLIPSE', LINE: 'LINE', REGULAR_POLYGON: 'POLYGON', STAR: 'STAR', TEXT: 'TEXT', VECTOR: 'VECTOR', BOOLEAN_OPERATION: 'BOOLEAN_OPERATION' };
  const instances: { id: NodeId; symbol: string }[] = [];

  const layer = async (change: KiwiObject, parentId: NodeId, order: string): Promise<void> => {
    const kind = str(change.type);
    // A frame that fits round what is in it and does not clip is how newer files keep a group.
    const isGroup = kind === 'GROUP' || (kind === 'FRAME' && change.resizeToFit === true && change.frameMaskDisabled !== false && !change.fillPaints);
    const type: LayerType | undefined = isGroup ? 'GROUP' : TYPES[kind];
    if (!type) {
      miss(kind === 'SLICE' ? 'Slices' : `Layers of the kind “${kind}”`);
      return;
    }
    const id = idOf(guidKey(change.guid));
    const width = Math.max(0.01, num(obj(change.size).x, 1));
    const height = Math.max(0.01, num(obj(change.size).y, 1));
    const m = change.transform ? matrixOf(change.transform) : ([1, 0, 0, 1, 0, 0] as Matrix);
    // The layer's box turns about its centre here; Figma places its corner. The centre is the same in both.
    const centre = applyToPoint(m, { x: width / 2, y: height / 2 });
    const rotation = (Math.atan2(m[1], m[0]) * 180) / Math.PI;
    if (m[0] * m[3] - m[1] * m[2] < 0) miss('Layers that were flipped (shown unflipped)');
    const props: LayerPatch & Record<string, unknown> = {
      name: str(change.name, type),
      visible: change.visible !== false,
      locked: change.locked === true,
      opacity: num(change.opacity, 1),
      blendMode: BLENDS[str(change.blendMode, 'NORMAL')] ?? 'NORMAL',
      x: centre.x - width / 2,
      y: centre.y - height / 2,
      width,
      height,
      rotation: Math.abs(rotation) < 1e-6 ? 0 : rotation,
      fills: await paints(change.fillPaints),
      strokes: await paints(change.strokePaints),
      strokeWeight: num(change.strokeWeight, 1),
      strokeAlign: (['INSIDE', 'OUTSIDE', 'CENTER'].includes(str(change.strokeAlign)) ? str(change.strokeAlign) : 'INSIDE') as LayerNode['strokeAlign'],
      strokeCap: str(change.strokeCap) === 'ROUND' ? 'ROUND' : str(change.strokeCap) === 'SQUARE' ? 'SQUARE' : 'NONE',
      strokeJoin: str(change.strokeJoin) === 'ROUND' ? 'ROUND' : str(change.strokeJoin) === 'BEVEL' ? 'BEVEL' : 'MITER',
      dashPattern: list(change.dashPattern).map((value) => num(value)),
      effects: effects(change.effects),
      isMask: change.mask === true,
    };
    if (!change.fillPaints && (type === 'FRAME' || type === 'GROUP')) props.fills = [];
    if (type === 'FRAME' || type === 'RECTANGLE') {
      props.cornerRadius = num(change.cornerRadius);
      if (change.rectangleCornerRadiiIndependent === true) props.cornerRadii = [num(change.rectangleTopLeftCornerRadius), num(change.rectangleTopRightCornerRadius), num(change.rectangleBottomRightCornerRadius), num(change.rectangleBottomLeftCornerRadius)];
    }
    if (type === 'FRAME') {
      props.clipsContent = change.frameMaskDisabled !== true;
      props.kind = kind === 'SYMBOL' ? 'COMPONENT' : kind === 'INSTANCE' ? 'INSTANCE' : change.isStateGroup === true ? 'COMPONENT_SET' : 'FRAME';
      if (kind === 'SYMBOL' || change.isStateGroup === true) props.description = str(change.description);
      const stack = str(change.stackMode, 'NONE');
      if (stack === 'HORIZONTAL' || stack === 'VERTICAL') {
        props.layoutMode = stack;
        props.itemSpacing = num(change.stackSpacing);
        props.paddingLeft = num(change.stackHorizontalPadding);
        props.paddingTop = num(change.stackVerticalPadding);
        props.paddingRight = num(change.stackPaddingRight, num(change.stackHorizontalPadding));
        props.paddingBottom = num(change.stackPaddingBottom, num(change.stackVerticalPadding));
        const justify = str(change.stackPrimaryAlignItems, 'MIN');
        props.primaryAxisAlignItems = justify === 'CENTER' ? 'CENTER' : justify === 'MAX' ? 'MAX' : justify === 'SPACE_BETWEEN' || justify === 'SPACE_EVENLY' ? 'SPACE_BETWEEN' : 'MIN';
        const align = str(change.stackCounterAlignItems, 'MIN');
        props.counterAxisAlignItems = align === 'CENTER' ? 'CENTER' : align === 'MAX' ? 'MAX' : 'MIN';
        if (change.stackPrimarySizing || change.stackCounterSizing || change.stackChildPrimaryGrow !== undefined) miss('How layers in Auto Layout are sized (hug and fill): they keep the size they had');
      }
      if (kind === 'INSTANCE') {
        instances.push({ id, symbol: guidKey(obj(change.symbolData).symbolID) });
        if (list(obj(change.symbolData).symbolOverrides).length > 0) miss('Changes made inside instances (overrides): the instances show their component as it is');
      }
    }
    if (type === 'ELLIPSE' && change.arcData) {
      const arc = obj(change.arcData);
      const start = (num(arc.startingAngle) * 180) / Math.PI;
      const end = (num(arc.endingAngle, Math.PI * 2) * 180) / Math.PI;
      props.arcStart = start;
      props.arcSweep = Math.min(360, Math.max(1, end - start));
      props.arcRatio = Math.min(0.99, Math.max(0, num(arc.innerRadius)));
    }
    if (type === 'POLYGON' || type === 'STAR') props.pointCount = Math.max(3, Math.round(num(change.count, type === 'STAR' ? 5 : 3)));
    if (type === 'STAR') props.innerRadius = Math.min(1, Math.max(0, num(change.starInnerScale, 0.38)));
    if (type === 'LINE') props.height = 0;
    if (type === 'TEXT') {
      const style = str(obj(change.fontName).style, 'Regular').toLowerCase();
      const weights: [string, number][] = [['thin', 100], ['extralight', 200], ['extra light', 200], ['light', 300], ['medium', 500], ['semibold', 600], ['semi bold', 600], ['extrabold', 800], ['extra bold', 800], ['black', 900], ['heavy', 900], ['bold', 700]];
      const fontSize = num(change.fontSize, 12);
      const spacing = obj(change.letterSpacing);
      const leading = obj(change.lineHeight);
      Object.assign(props, {
        characters: str(obj(change.textData).characters),
        fontFamily: str(obj(change.fontName).family, 'Inter'),
        fontSize,
        fontWeight: weights.find(([word]) => style.includes(word))?.[1] ?? 400,
        italic: style.includes('italic') || style.includes('oblique'),
        letterSpacing: str(spacing.units) === 'PERCENT' ? (num(spacing.value) / 100) * fontSize : num(spacing.value),
        lineHeight: change.lineHeight === undefined || (str(leading.units) === 'PERCENT' && num(leading.value) === 100) ? null : str(leading.units) === 'PERCENT' ? (num(leading.value) / 100) * fontSize : str(leading.units) === 'RAW' ? num(leading.value) * fontSize : num(leading.value),
        textAlign: (['LEFT', 'CENTER', 'RIGHT', 'JUSTIFIED'].includes(str(change.textAlignHorizontal)) ? str(change.textAlignHorizontal) : 'LEFT') as never,
        verticalAlign: str(change.textAlignVertical) === 'CENTER' ? 'MIDDLE' : str(change.textAlignVertical) === 'BOTTOM' ? 'BOTTOM' : 'TOP',
        textAutoResize: str(change.textAutoResize) === 'WIDTH_AND_HEIGHT' ? 'WIDTH_AND_HEIGHT' : str(change.textAutoResize) === 'HEIGHT' ? 'HEIGHT' : 'NONE',
        textDecoration: (['UNDERLINE', 'STRIKETHROUGH'].includes(str(change.textDecoration)) ? str(change.textDecoration) : 'NONE') as never,
        textCase: (['UPPER', 'LOWER', 'TITLE'].includes(str(change.textCase)) ? str(change.textCase) : 'ORIGINAL') as never,
      });
      if (list(obj(change.textData).characterStyleIDs).some((value) => num(value) !== 0)) miss('Text with parts in a style of their own (shown in the layer’s own style)');
    }
    if (type === 'VECTOR') {
      const data = obj(change.vectorData);
      const blob = blobs[num(data.vectorNetworkBlob, -1)];
      const normal = obj(data.normalizedSize);
      if (!blob) {
        miss('Vectors whose points are not in the file');
        return;
      }
      try {
        props.network = readVectorBlob(blob, width / Math.max(1e-6, num(normal.x, width)), height / Math.max(1e-6, num(normal.y, height)));
      } catch {
        miss('Vectors whose points could not be read');
        return;
      }
    }
    if (type === 'BOOLEAN_OPERATION') {
      const operation = str(change.booleanOperation, 'UNION');
      props.operation = operation === 'XOR' ? 'EXCLUDE' : operation === 'INTERSECT' ? 'INTERSECT' : operation === 'SUBTRACT' ? 'SUBTRACT' : 'UNION';
    }
    if (change.componentPropertyDefinitions || change.componentPropertyReferences) miss('Component properties');
    if (change.prototypeInteractions || change.transitionNodeID) miss('Prototype connections');
    if (change.styleIdForFill || change.styleIdForText || change.styleIdForEffect || change.inheritFillStyleID || change.inheritTextStyleID) miss('Links to shared styles (layers keep the look the styles gave them)');
    if (change.variableConsumptionMap || change.parameterConsumptionMap) miss('Bindings to variables (layers keep their values)');
    if (change.layoutGrids) miss('Layout grids');
    if (change.exportSettings) miss('Export settings');
    nodes[id] = createLayer(type, parentId, order, props as LayerPatch);
    nodes[id] = { ...nodes[id], id } as DesignNode;
    // What is in an instance is its component's, and is made from it.
    if (kind === 'INSTANCE') return;
    const inside = children.get(guidKey(change.guid)) ?? [];
    const keys = freshKeys(Math.max(1, inside.length));
    for (let i = 0; i < inside.length; i++) await layer(inside[i] as KiwiObject, id, keys[i] as string);
  };

  for (const canvasNode of canvases) {
    const pageId = ids.get(guidKey(canvasNode.guid));
    if (!pageId) continue;
    const inside = children.get(guidKey(canvasNode.guid)) ?? [];
    const keys = freshKeys(Math.max(1, inside.length));
    for (let i = 0; i < inside.length; i++) await layer(inside[i] as KiwiObject, pageId, keys[i] as string);
  }
  for (const instance of instances) {
    const node = nodes[instance.id];
    const component = ids.get(instance.symbol);
    if (!isLayer(node)) continue;
    if (component && nodes[component]) nodes[instance.id] = { ...node, componentId: component } as DesignNode;
    else {
      // Its component is not in this file: it stays as a frame, without what was in it.
      miss('Instances of components that are not in the file (they are left as empty frames)');
      nodes[instance.id] = { ...node, kind: 'FRAME' } as DesignNode;
    }
  }
  if (pages.length === 0) miss('Pages (the file has none that can be shown)');

  const repaired = repairDocument({ id: createId(), name, nodes, assets, styles: {}, variables: {}, variableCollections: {}, publication: null }).doc;
  // Instances get their component's layers, groups their boxes and boolean groups their shapes, as after any change.
  const doc = restoreLayout({ ...repaired, nodes: { ...repaired.nodes } }, repaired, env.measurer);
  return { doc, images, notConverted: [...missed.entries()].map(([what, count]) => `${what}: ${count}`), version };
}

// ------------------------------------------------------------------ writing

/**
 * Writes a document as a `.fig` file: a ZIP archive with `canvas.fig`, the
 * images it uses under `images/`, and `meta.json`. `images` gives the bytes
 * of the document's images by their hash here. Layers made from a component
 * inside an instance are not written: an instance is written as its
 * component and what it changes, as Figma keeps it.
 */
export async function writeFig(doc: Document, images: Readonly<Record<string, { bytes: Uint8Array }>>, env: Pick<FigEnvironment, 'deflateRaw'>): Promise<{ bytes: Uint8Array; notWritten: string[] }> {
  const missed = new Map<string, number>();
  const miss = (what: string): void => {
    missed.set(what, (missed.get(what) ?? 0) + 1);
  };
  const schema = parseSchemaText(FIG_SCHEMA);
  const codec = compileSchema(schema);
  let local = 1;
  const guids = new Map<NodeId, KiwiObject>();
  const guid = (id: NodeId, session = 1): KiwiObject => {
    let value = guids.get(id);
    if (!value) {
      value = { sessionID: session, localID: local++ };
      guids.set(id, value);
    }
    return value;
  };
  const files: { name: string; bytes: Uint8Array }[] = [];
  const written = new Map<string, Uint8Array>();
  const blobs: KiwiObject[] = [];
  const changes: KiwiObject[] = [];
  const documentGuid = { sessionID: 0, localID: 0 };
  changes.push({ guid: documentGuid, phase: 'CREATED', type: 'DOCUMENT', name: 'Document', visible: true, opacity: 1, transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 } });
  const color = (c: RGB, a = 1): KiwiObject => ({ r: c.r, g: c.g, b: c.b, a });

  const paintOut = (paint: Paint): KiwiObject | null => {
    const base = { opacity: paint.opacity, visible: paint.visible, blendMode: 'NORMAL' };
    if (paint.type === 'SOLID') return { type: 'SOLID', color: color(paint.color), ...base };
    if (paint.type === 'IMAGE') {
      const image = images[paint.imageHash];
      if (!image) {
        miss('Image fills whose pictures are not on this device');
        return null;
      }
      let key = written.get(paint.imageHash);
      if (!key) {
        key = sha1(image.bytes);
        written.set(paint.imageHash, key);
        files.push({ name: `images/${toHex(key)}`, bytes: image.bytes });
      }
      if (paint.exposure || paint.contrast || paint.saturation) miss('Image adjustments');
      if (paint.scaleMode === 'CROP') miss('Image crops (written as “Fill”)');
      return { type: 'IMAGE', image: { hash: key, name: doc.assets[paint.imageHash]?.name ?? 'Image' }, imageScaleMode: paint.scaleMode === 'FIT' ? 'FIT' : paint.scaleMode === 'TILE' ? 'TILE' : 'FILL', scale: paint.tileScale, ...base };
    }
    const m = gradientTransform(paint);
    return { type: paint.type, stops: paint.stops.map((stop) => ({ color: color(stop.color, stop.opacity), position: stop.position })), transform: { m00: m[0], m01: m[2], m02: m[4], m10: m[1], m11: m[3], m12: m[5] }, ...base };
  };
  const paintsOut = (paints: readonly Paint[]): KiwiObject[] => paints.map(paintOut).filter((paint): paint is KiwiObject => paint !== null);
  const effectOut = (effect: Effect): KiwiObject =>
    effect.type === 'DROP_SHADOW' || effect.type === 'INNER_SHADOW'
      ? { type: effect.type, color: color(effect.color, effect.opacity), offset: { x: effect.offsetX, y: effect.offsetY }, radius: effect.blur, spread: effect.spread, visible: effect.visible, blendMode: 'NORMAL' }
      : { type: effect.type === 'LAYER_BLUR' ? 'FOREGROUND_BLUR' : 'BACKGROUND_BLUR', radius: (effect as { radius: number }).radius, visible: effect.visible };

  const layerOut = (id: NodeId, parent: KiwiObject, position: string): void => {
    const node = doc.nodes[id];
    if (!isLayer(node)) return;
    // The layers an instance shows are its component's, and are not stored with it.
    if (node.sourceId !== null) return;
    const r = (node.rotation * Math.PI) / 180;
    const cos = Math.cos(r);
    const sin = Math.sin(r);
    const cx = node.x + node.width / 2;
    const cy = node.y + node.height / 2;
    const change: KiwiObject = {
      guid: guid(id),
      phase: 'CREATED',
      parentIndex: { guid: parent, position },
      name: node.name,
      visible: node.visible,
      locked: node.locked,
      opacity: node.opacity,
      blendMode: node.blendMode === 'NORMAL' && (node.type === 'GROUP' || node.type === 'FRAME') ? 'PASS_THROUGH' : node.blendMode,
      size: { x: node.width, y: node.type === 'LINE' ? 0 : node.height },
      // Figma places the corner; the box turns about the centre here, which stays where it is.
      transform: { m00: cos, m01: -sin, m02: cx - cos * (node.width / 2) + sin * (node.height / 2), m10: sin, m11: cos, m12: cy - sin * (node.width / 2) - cos * (node.height / 2) },
      fillPaints: paintsOut(node.fills),
      strokePaints: paintsOut(node.strokes),
      strokeWeight: node.strokeWeight,
      strokeAlign: node.strokeAlign,
      strokeCap: node.strokeCap,
      strokeJoin: node.strokeJoin,
      dashPattern: node.dashPattern,
      effects: node.effects.map(effectOut),
      mask: node.isMask,
    };
    const typeNames: Record<LayerType, string> = { FRAME: 'FRAME', GROUP: 'GROUP', RECTANGLE: 'ROUNDED_RECTANGLE', ELLIPSE: 'ELLIPSE', LINE: 'LINE', POLYGON: 'REGULAR_POLYGON', STAR: 'STAR', TEXT: 'TEXT', VECTOR: 'VECTOR', BOOLEAN_OPERATION: 'BOOLEAN_OPERATION' };
    change.type = typeNames[node.type];
    if (node.type === 'FRAME' || node.type === 'RECTANGLE') {
      change.cornerRadius = node.cornerRadius;
      if (node.cornerRadii) {
        change.rectangleCornerRadiiIndependent = true;
        [change.rectangleTopLeftCornerRadius, change.rectangleTopRightCornerRadius, change.rectangleBottomRightCornerRadius, change.rectangleBottomLeftCornerRadius] = node.cornerRadii;
      }
    }
    if (node.type === 'FRAME') {
      change.frameMaskDisabled = !node.clipsContent;
      if (node.kind === 'COMPONENT') change.type = 'SYMBOL';
      if (node.kind === 'COMPONENT_SET') change.isStateGroup = true;
      if (node.kind === 'COMPONENT' || node.kind === 'COMPONENT_SET') change.description = node.description;
      if (node.kind === 'INSTANCE' && node.componentId) {
        change.type = 'INSTANCE';
        change.symbolData = { symbolID: guid(node.componentId) };
        if (Object.keys(node.overrides).length > 0 || Object.keys(node.propValues).length > 0) miss('Changes made inside instances (overrides)');
      }
      if (node.layoutMode !== 'NONE') {
        Object.assign(change, {
          stackMode: node.layoutMode,
          stackSpacing: node.itemSpacing,
          stackHorizontalPadding: node.paddingLeft,
          stackVerticalPadding: node.paddingTop,
          stackPaddingRight: node.paddingRight,
          stackPaddingBottom: node.paddingBottom,
          stackPrimaryAlignItems: node.primaryAxisAlignItems,
          stackCounterAlignItems: node.counterAxisAlignItems === 'STRETCH' ? 'MIN' : node.counterAxisAlignItems,
        });
        miss('How layers in Auto Layout are sized (hug and fill)');
      }
      if (node.layoutGrids.length > 0) miss('Layout grids');
      if (node.componentProps.length > 0) miss('Component properties');
    }
    if (node.type === 'ELLIPSE' && (node.arcSweep < 360 || node.arcRatio > 0)) change.arcData = { startingAngle: (node.arcStart * Math.PI) / 180, endingAngle: ((node.arcStart + node.arcSweep) * Math.PI) / 180, innerRadius: node.arcRatio };
    if (node.type === 'POLYGON' || node.type === 'STAR') change.count = node.pointCount;
    if (node.type === 'STAR') change.starInnerScale = node.innerRadius;
    if (node.type === 'TEXT') {
      const weightName = { 100: 'Thin', 200: 'Extra Light', 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'Semi Bold', 700: 'Bold', 800: 'Extra Bold', 900: 'Black' }[node.fontWeight] ?? 'Regular';
      const style = node.italic ? (weightName === 'Regular' ? 'Italic' : `${weightName} Italic`) : weightName;
      Object.assign(change, {
        textData: { characters: node.characters },
        fontSize: node.fontSize,
        fontName: { family: node.fontFamily, style, postscript: '' },
        textAlignHorizontal: node.textAlign,
        textAlignVertical: node.verticalAlign === 'MIDDLE' ? 'CENTER' : node.verticalAlign,
        letterSpacing: { value: node.letterSpacing, units: 'PIXELS' },
        textAutoResize: node.textAutoResize,
        textDecoration: node.textDecoration,
        textCase: node.textCase,
      });
      if (node.lineHeight !== null) change.lineHeight = { value: node.lineHeight, units: 'PIXELS' };
      if (node.styleRanges.length > 0) miss('Parts of text in a style of their own');
      if (node.listType !== 'NONE') miss('Lists in text');
    }
    if (node.type === 'VECTOR' || node.type === 'BOOLEAN_OPERATION') {
      if (node.type === 'BOOLEAN_OPERATION') change.booleanOperation = node.operation === 'EXCLUDE' ? 'XOR' : node.operation;
      else {
        blobs.push({ bytes: writeVectorBlob(node.network) });
        change.vectorData = { vectorNetworkBlob: blobs.length - 1, normalizedSize: { x: node.width, y: node.height } };
      }
    }
    if (node.reactions.length > 0) miss('Prototype connections');
    if (Object.keys(node.styleRefs).length > 0) miss('Links to styles (layers keep their look)');
    if (Object.keys(node.boundVariables).length > 0) miss('Bindings to variables (layers keep their values)');
    if (node.exportSettings.length > 0) miss('Export settings');
    changes.push(change);
    if (node.type === 'FRAME' && node.kind === 'INSTANCE') return;
    const inside = sortByPaintOrder(doc, getChildIds(doc, id));
    inside.forEach((childId, index) => layerOut(childId, guid(id), positionKey(index)));
  };

  getPages(doc).forEach((page, index) => {
    if (!isPage(page)) return;
    const pageGuid = guid(page.id, 0);
    changes.push({ guid: pageGuid, phase: 'CREATED', parentIndex: { guid: documentGuid, position: positionKey(index) }, type: 'CANVAS', name: page.name, visible: true, opacity: 1, backgroundColor: color(page.backgroundColor), transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 } });
    getChildIds(doc, page.id).forEach((id, childIndex) => layerOut(id, pageGuid, positionKey(childIndex)));
    if (page.flows.length > 0) miss('Prototype flows');
  });
  if (Object.keys(doc.styles).length > 0) miss('Styles (layers keep their look)');
  if (Object.keys(doc.variables).length > 0) miss('Variables');

  const message = codec.encode('Message', { type: 'NODE_CHANGES', sessionID: 0, ackID: 0, nodeChanges: changes, blobs });
  const schemaBytes = await env.deflateRaw(encodeBinarySchema(schema));
  const messageBytes = await env.deflateRaw(message);
  const canvas = new Uint8Array(12 + 4 + schemaBytes.length + 4 + messageBytes.length);
  const view = new DataView(canvas.buffer);
  for (let i = 0; i < 8; i++) canvas[i] = MAGIC.charCodeAt(i);
  view.setUint32(8, WRITE_VERSION, true);
  view.setUint32(12, schemaBytes.length, true);
  canvas.set(schemaBytes, 16);
  view.setUint32(16 + schemaBytes.length, messageBytes.length, true);
  canvas.set(messageBytes, 20 + schemaBytes.length);
  const meta = new TextEncoder().encode(JSON.stringify({ client_meta: { background_color: { r: 0.96, g: 0.96, b: 0.96, a: 1 } }, file_name: doc.name, developer_related_links: [], exported_at: '' }));
  const archive = writeZip([{ name: 'canvas.fig', bytes: canvas }, { name: 'meta.json', bytes: meta }, ...files]);
  return { bytes: archive, notWritten: [...missed.entries()].map(([what, count]) => `${what}: ${count}`) };
}

/** A position among siblings, as a string that sorts in their order. */
function positionKey(index: number): string {
  // Printable characters from "!" on, two to a place: enough for any number of siblings in order.
  return String.fromCharCode(33 + Math.floor(index / 90)) + String.fromCharCode(33 + (index % 90));
}
