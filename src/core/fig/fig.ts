import { mirrorId } from '../components/instances';
import { applyConstraints, setLayerBox } from '../ops/transform';
import { patchNodes, setNodes } from '../document/mutate';
import { scaleNetwork } from '../vector/network';
import { createLayer, createPage } from '../document/factory';
import {
  isLayer,
  isPage,
  isShadow,
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
  type Action,
  type ActionType,
  type ComponentProp,
  type Constraints,
  type Flow,
  type PropRefs,
  type Reaction,
  type Style,
  type StyleRefs,
  type TextCase,
  type TextDecoration,
  type TextRangeStyle,
  type TextStyleRange,
  type Transition,
  type TriggerType,
  type Variable,
  type VariableCollection,
  type VariableValue,
  type LayoutGrid,
  type ExportSetting,
  type OverlayPosition,
} from '../document/schema';
import { networkFromSubpaths, type Subpath } from '../import/pathData';
import { mirrorNetwork } from '../vector/shapes';
import { repairDocument } from '../document/validate';
import { readZip, writeZip, isZip } from '../files/zip';
import { createId } from '../ids';
import { restoreLayout } from '../layout/restore';
import { applyToPoint, invert, multiply, type Matrix } from '../math/matrix';
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


/** The name the keyboard gives a key (as in KeyboardEvent.key), from the key code Figma keeps of it. */
function keyName(code: number): string {
  const named: Record<number, string> = { 8: 'Backspace', 9: 'Tab', 13: 'Enter', 16: 'Shift', 17: 'Control', 18: 'Alt', 27: 'Escape', 32: ' ', 33: 'PageUp', 34: 'PageDown', 35: 'End', 36: 'Home', 37: 'ArrowLeft', 38: 'ArrowUp', 39: 'ArrowRight', 40: 'ArrowDown', 46: 'Delete', 91: 'Meta', 186: ';', 187: '=', 188: ',', 189: '-', 190: '.', 191: '/', 192: '`', 219: '[', 220: '\\', 221: ']', 222: "'" };
  if (named[code]) return named[code] as string;
  if ((code >= 48 && code <= 57) || (code >= 65 && code <= 90)) return String.fromCharCode(code).toLowerCase();
  if (code >= 96 && code <= 105) return String(code - 96);
  if (code >= 112 && code <= 123) return `F${code - 111}`;
  return '';
}

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
  bool borderStrokeWeightsIndependent = 57; float borderTopWeight = 58; float borderRightWeight = 59; float borderBottomWeight = 60; float borderLeftWeight = 61;
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
    // Figma's own caches (laid-out glyphs, sizes worked out for instances, frozen frames) and its edit history are
    // most of a large file and are worked out again here, so they are moved past without being built.
    const skip = new Set(['derivedTextData', 'derivedSymbolData', 'derivedImmutableFrameData', 'editInfo', 'localUndoStack', 'localRedoStack', 'thumbHash', 'thumbHashBase64', 'fontMetaData', 'glyphs', 'baselines', 'logicalIndexToCharacterOffsetMap', 'derivedLines']);
    message = compileSchema(schema).decode('Message', await unpack(parts[1] as Uint8Array, env), skip);
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
    const blob = num(obj(paint.image).dataBlob, -1);
    const bytes = zipped.get(`images/${key}`) ?? (blob >= 0 ? blobs[blob] : undefined);
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

  /** The variable a value stands for, when it is an alias to one: `{ value: { alias: { guid } } }`. */
  const aliasOf = (value: KiwiValue | undefined): NodeId | null => {
    const alias = obj(obj(obj(value).value).alias);
    return alias.guid ? idOf(guidKey(alias.guid)) : null;
  };

  /**
   * The paints of a layer. With `bind`, a solid paint whose colour is a
   * variable is bound to it, as `fills.N` or `strokes.N`.
   */
  const paints = async (values: KiwiValue | undefined, bind?: { key: string; out: Record<string, string> }): Promise<Paint[]> => {
    const out: Paint[] = [];
    for (const value of list(values)) {
      const paint = obj(value);
      const type = str(paint.type, 'SOLID');
      const visible = paint.visible !== false;
      const opacity = num(paint.opacity, 1);
      if (type === 'SOLID') {
        const c = colour(paint.color);
        const variable = aliasOf(paint.colorVar);
        if (bind && variable) bind.out[`${bind.key}.${out.length}`] = variable;
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
        if (paint.filters || paint.paintFilter) miss('Image adjustments');
        out.push({ type: 'IMAGE', imageHash: hash, scaleMode: mode === 'FIT' ? 'FIT' : mode === 'TILE' ? 'TILE' : mode === 'STRETCH' ? 'CROP' : 'FILL', crop: { x: 0, y: 0, width: 1, height: 1 }, tileScale: num(paint.scale, 1), exposure: 0, contrast: 0, saturation: 0, flipX: false, flipY: false, opacity, visible });
      } else if (type === 'VIDEO' && paint.imageThumbnail) {
        // A video is shown by its still: this application has no moving pictures.
        const hash = await imageFor({ ...paint, image: paint.imageThumbnail });
        if (hash) out.push({ type: 'IMAGE', imageHash: hash, scaleMode: 'FILL', crop: { x: 0, y: 0, width: 1, height: 1 }, tileScale: 1, exposure: 0, contrast: 0, saturation: 0, flipX: false, flipY: false, opacity, visible });
        miss('Video fills (shown as their first frame)');
      } else miss(`Paints of the kind “${type}”`);
    }
    return out;
  };

  /** Figma's stored outline of a shape (its fill or stroke geometry): commands in a blob, 1 move, 2 line, 3 quadratic, 4 cubic, 0 close. */
  const geometryOf = (values: KiwiValue | undefined): Subpath[] => {
    const out: Subpath[] = [];
    for (const value of list(values)) {
      const bytes = blobs[num(obj(value).commandsBlob, -1)];
      if (!bytes) continue;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      let at = 0;
      let current: Subpath | null = null;
      let point = { x: 0, y: 0 };
      const f = (): number => {
        const v = view.getFloat32(at, true);
        at += 4;
        return v;
      };
      try {
        while (at < bytes.length) {
          const command = bytes[at++] as number;
          if (command === 0) {
            if (current && current.curves.length > 0) {
              const first = current.start;
              if (point.x !== first.x || point.y !== first.y) current.curves.push({ p0: point, p1: point, p2: first, p3: first });
              current.closed = true;
              point = first;
            }
            current = null;
          } else if (command === 1) {
            point = { x: f(), y: f() };
            current = { curves: [], closed: false, start: point };
            out.push(current);
          } else if (command === 2 || command === 3 || command === 4) {
            if (!current) {
              current = { curves: [], closed: false, start: point };
              out.push(current);
            }
            if (command === 2) {
              const to = { x: f(), y: f() };
              current.curves.push({ p0: point, p1: point, p2: to, p3: to });
              point = to;
            } else if (command === 3) {
              const c = { x: f(), y: f() };
              const to = { x: f(), y: f() };
              current.curves.push({ p0: point, p1: { x: point.x + (2 / 3) * (c.x - point.x), y: point.y + (2 / 3) * (c.y - point.y) }, p2: { x: to.x + (2 / 3) * (c.x - to.x), y: to.y + (2 / 3) * (c.y - to.y) }, p3: to });
              point = to;
            } else {
              const p1 = { x: f(), y: f() };
              const p2 = { x: f(), y: f() };
              const to = { x: f(), y: f() };
              current.curves.push({ p0: point, p1, p2, p3: to });
              point = to;
            }
          } else break;
        }
      } catch {
        // A blob that ends early keeps what was read of it.
      }
    }
    return out.filter((path) => path.curves.length > 0);
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

  /** A font's weight and slant from the name of its style ("Semi Bold Italic"). */
  const fontStyle = (value: KiwiValue | undefined): { fontFamily: string; fontWeight: number; italic: boolean } => {
    const font = obj(value);
    const style = str(font.style, 'Regular').toLowerCase();
    const weights: [string, number][] = [['thin', 100], ['hairline', 100], ['extralight', 200], ['extra light', 200], ['ultralight', 200], ['light', 300], ['medium', 500], ['semibold', 600], ['semi bold', 600], ['demibold', 600], ['extrabold', 800], ['extra bold', 800], ['ultrabold', 800], ['black', 900], ['heavy', 900], ['bold', 700]];
    return { fontFamily: str(font.family, 'Inter'), fontWeight: weights.find(([word]) => style.includes(word))?.[1] ?? 400, italic: style.includes('italic') || style.includes('oblique') };
  };

  /** The type settings of a text node, or of a text style, which Figma keeps as a text node. */
  const typeSettings = (change: KiwiObject) => {
    const fontSize = num(change.fontSize, 12);
    const spacing = obj(change.letterSpacing);
    const leading = obj(change.lineHeight);
    return {
      ...fontStyle(change.fontName),
      fontSize,
      letterSpacing: str(spacing.units) === 'PERCENT' ? (num(spacing.value) / 100) * fontSize : num(spacing.value),
      lineHeight: change.lineHeight === undefined || (str(leading.units) === 'PERCENT' && num(leading.value) === 100) ? null : str(leading.units) === 'PERCENT' ? (num(leading.value) / 100) * fontSize : str(leading.units) === 'RAW' ? num(leading.value) * fontSize : num(leading.value),
      textDecoration: (['UNDERLINE', 'STRIKETHROUGH'].includes(str(change.textDecoration)) ? str(change.textDecoration) : 'NONE') as TextDecoration,
      textCase: (['UPPER', 'LOWER', 'TITLE'].includes(str(change.textCase)) ? str(change.textCase) : 'ORIGINAL') as TextCase,
    };
  };

  const nodes: Record<NodeId, DesignNode> = {};
  const pages: NodeId[] = [];
  const root = changes.find((change) => str(change.type) === 'DOCUMENT');
  const documentKey = root ? guidKey(root.guid) : '0:0';
  const canvases = (children.get(documentKey) ?? []).filter((change) => str(change.type) === 'CANVAS');
  const pageKeys = freshKeys(Math.max(1, canvases.length));
  let pageIndex = 0;
  for (const canvasNode of canvases) {
    // Figma keeps a page of its own that is never shown, for shared styles, variables and the components of other files.
    if (canvasNode.internalOnly === true) {
      const kept = (children.get(guidKey(canvasNode.guid)) ?? []).filter((change) => str(change.type) === 'SYMBOL' || str(change.type) === 'INSTANCE');
      if (kept.length > 0) miss('Components from libraries (kept in Figma on a hidden page)');
      continue;
    }
    const page = { ...createPage(str(canvasNode.name, 'Page'), pageKeys[pageIndex++] as string), id: idOf(guidKey(canvasNode.guid)) };
    if (canvasNode.backgroundColor) page.backgroundColor = colour(canvasNode.backgroundColor).color;
    // The device a page's prototype is shown on: the nearest of the phone, tablet and desktop this application has.
    const device = obj(canvasNode.prototypeDevice);
    const deviceType = str(device.type, 'NONE');
    if (deviceType !== 'NONE') {
      const width = Math.min(num(obj(device.size).x), num(obj(device.size).y)) || 0;
      page.prototypeDevice = deviceType === 'PRESENTATION' || width >= 1000 ? 'DESKTOP' : width >= 600 ? 'TABLET' : 'PHONE';
      const exact = { PHONE: 390, TABLET: 820, DESKTOP: 900 }[page.prototypeDevice];
      if (deviceType === 'PRESENTATION' || Math.abs(width - exact) > 1) miss('Prototype devices of a size of their own (shown on the nearest of phone, tablet and desktop)');
    }
    nodes[page.id] = page;
    pages.push(page.id);
  }

  // Variables and their collections: Figma keeps them as nodes too.
  const collections: Record<string, VariableCollection> = {};
  const variables: Record<string, Variable> = {};
  const SCOPES: Record<string, string> = { ALL_FILLS: 'FILL', FRAME_FILL: 'FILL', SHAPE_FILL: 'FILL', TEXT_FILL: 'FILL', STROKE_COLOR: 'STROKE', STROKE_FLOAT: 'STROKE', WIDTH_HEIGHT: 'SIZE', GAP: 'GAP', CORNER_RADIUS: 'RADIUS', OPACITY: 'OPACITY', TEXT_CONTENT: 'TEXT', FONT_FAMILY: 'TEXT', FONT_SIZE: 'TEXT', LINE_HEIGHT: 'TEXT', LETTER_SPACING: 'TEXT' };
  for (const change of changes) {
    if (str(change.type) !== 'VARIABLE_SET') continue;
    const id = idOf(guidKey(change.guid));
    const modes = list(change.variableSetModes).map((mode) => ({ id: idOf(`mode:${guidKey(obj(mode).id)}`), name: str(obj(mode).name, 'Mode') }));
    collections[id] = { id, name: str(change.name, 'Collection'), modes: modes.length > 0 ? modes : [{ id: createId(), name: 'Mode 1' }], remote: null };
  }
  for (const change of changes) {
    if (str(change.type) !== 'VARIABLE') continue;
    const collection = collections[idOf(guidKey(obj(change.variableSetID).guid))];
    const resolved = str(change.variableResolvedType);
    const type = ({ COLOR: 'COLOR', FLOAT: 'FLOAT', STRING: 'STRING', BOOLEAN: 'BOOLEAN' } as Record<string, Variable['type']>)[resolved];
    if (!collection || !type) {
      miss(collection ? `Variables of the kind “${resolved}”` : 'Variables from other files');
      continue;
    }
    const id = idOf(guidKey(change.guid));
    const valuesByMode: Record<string, VariableValue> = {};
    for (const entry of list(obj(change.variableDataValues).entries)) {
      const modeId = idOf(`mode:${guidKey(obj(entry).modeID)}`);
      const data = obj(obj(entry).variableData);
      const value = obj(data.value);
      const alias = aliasOf(data);
      if (alias) valuesByMode[modeId] = { alias };
      else if (type === 'COLOR') valuesByMode[modeId] = colour(value.colorValue).color;
      else if (type === 'FLOAT') valuesByMode[modeId] = num(value.floatValue);
      else if (type === 'STRING') valuesByMode[modeId] = str(value.textValue);
      else valuesByMode[modeId] = value.boolValue === true;
    }
    const scopes = [...new Set(list(change.variableScopes).map((scope) => SCOPES[str(scope)]).filter((scope): scope is string => Boolean(scope)))];
    variables[id] = { id, name: str(change.name, 'Variable'), description: str(change.description), collectionId: collection.id, type, scopes: list(change.variableScopes).some((scope) => str(scope) === 'ALL_SCOPES') ? [] : scopes, valuesByMode, remote: null };
  }

  /** Layout grids, as Figma keeps them on a frame or in a grid style. */
  const gridsOf = (values: KiwiValue | undefined): LayoutGrid[] => {
    const grids: LayoutGrid[] = [];
    for (const value of list(values)) {
      const grid = obj(value);
      const c = colour(grid.color);
      const align = str(grid.type, 'STRETCH');
      const pattern = str(grid.pattern) === 'GRID' ? 'GRID' : str(grid.axis) === 'Y' ? 'ROWS' : 'COLUMNS';
      grids.push({ pattern, size: num(grid.sectionSize, 10), count: Math.max(1, Math.round(num(grid.numSections, 1))), gutter: num(grid.gutterSize), offset: num(grid.offset), alignment: (['MIN', 'CENTER', 'MAX', 'STRETCH'].includes(align) ? align : 'STRETCH') as LayoutGrid['alignment'], sectionSize: num(grid.sectionSize, 10), color: c.color, opacity: c.a, visible: grid.visible !== false });
    }
    return grids;
  };

  // Shared styles: also nodes, each with a `styleType`.
  const styles: Record<string, Style> = {};
  for (const change of changes) {
    const styleType = str(change.styleType);
    if (!styleType || styleType === 'NONE') continue;
    const id = idOf(guidKey(change.guid));
    const base = { id, name: str(change.name, 'Style'), description: str(change.styleDescription, str(change.description)), paints: [] as Paint[], text: { fontFamily: 'Inter', fontSize: 16, fontWeight: 400, italic: false, lineHeight: null as number | null, letterSpacing: 0, textDecoration: 'NONE' as TextDecoration, textCase: 'ORIGINAL' as TextCase }, effects: [] as Effect[], grids: [], remote: null };
    if (styleType === 'TEXT') styles[id] = { ...base, type: 'TEXT', text: typeSettings(change) };
    else if (styleType === 'FILL') styles[id] = { ...base, type: 'PAINT', paints: await paints(change.fillPaints) };
    else if (styleType === 'EFFECT') styles[id] = { ...base, type: 'EFFECT', effects: effects(change.effects) };
    else if (styleType === 'GRID') styles[id] = { ...base, type: 'GRID', grids: gridsOf(change.layoutGrids) };
    else miss(`Shared styles of the kind “${styleType}”`);
  }
  const styleRef = (value: KiwiValue | undefined): string | undefined => {
    const reference = obj(value);
    if (!reference.guid) return undefined;
    const id = idOf(guidKey(reference.guid));
    if (styles[id]) return id;
    miss('Links to shared styles of other files (layers keep the look the styles gave them)');
    return undefined;
  };

  const TYPES: Record<string, LayerType> = { FRAME: 'FRAME', SECTION: 'FRAME', SYMBOL: 'FRAME', INSTANCE: 'FRAME', GROUP: 'GROUP', RECTANGLE: 'RECTANGLE', ROUNDED_RECTANGLE: 'RECTANGLE', ELLIPSE: 'ELLIPSE', LINE: 'LINE', REGULAR_POLYGON: 'POLYGON', STAR: 'STAR', TEXT: 'TEXT', VECTOR: 'VECTOR', BOOLEAN_OPERATION: 'BOOLEAN_OPERATION' };
  const CONSTRAINTS: Record<string, Constraints['horizontal']> = { MIN: 'MIN', FIXED_MIN: 'MIN', CENTER: 'CENTER', MAX: 'MAX', FIXED_MAX: 'MAX', STRETCH: 'STRETCH', SCALE: 'SCALE' };
  const instances: { id: NodeId; symbol: string; overrides: KiwiObject[]; assignments: KiwiObject[] }[] = [];
  const resized: { chain: NodeId[]; width: number; height: number }[] = [];
  const flows = new Map<NodeId, Flow[]>();
  const pageOfLayer = new Map<NodeId, NodeId>();

  /** What happens in a prototype: Figma's interactions as this application's. */
  const reactionsOf = (values: KiwiValue | undefined): Reaction[] => {
    const out: Reaction[] = [];
    for (const value of list(values)) {
      const interaction = obj(value);
      if (interaction.isDeleted === true) continue;
      const event = obj(interaction.event);
      const kind = str(event.interactionType, 'ON_CLICK');
      const trigger = ({ ON_CLICK: 'ON_CLICK', ON_HOVER: 'MOUSE_ENTER', MOUSE_ENTER: 'MOUSE_ENTER', ON_PRESS: 'ON_PRESS', MOUSE_DOWN: 'ON_PRESS', AFTER_TIMEOUT: 'AFTER_DELAY', DRAG: 'ON_DRAG', ON_KEY_DOWN: 'ON_KEY' } as Record<string, TriggerType>)[kind];
      const codes = list(obj(event.keyTrigger).keyCodes).map((code) => num(code));
      const key = codes.length > 0 ? keyName(codes[codes.length - 1] as number) : '';
      if (kind === 'ON_KEY_DOWN' && codes.length > 1) miss('Key presses with modifier keys (the last key alone triggers them)');
      if (!trigger) {
        miss(`Prototype triggers of the kind “${kind}”`);
        continue;
      }
      const actions = actionsOf(interaction.actions, 0);
      if (actions.length === 0) continue;
      out.push({ id: createId(), trigger: { type: trigger, delay: Math.round(num(event.transitionTimeout, 0.8) * 1000), key }, actions });
    }
    return out;
  };

  /** A variable's value or an expression of Figma's, as this application's expressions write it. Null when it has none of the parts this one has. */
  const expressionOf = (value: KiwiValue | undefined, depth = 0): string | null => {
    const data = obj(value);
    const v = obj(data.value);
    if (depth > 12) return null;
    const alias = obj(v.alias).guid ? variables[idOf(guidKey(obj(v.alias).guid))] : undefined;
    if (obj(v.alias).guid) return alias ? `{${alias.name}}` : null;
    if (v.boolValue !== undefined) return v.boolValue === true ? 'true' : 'false';
    if (v.floatValue !== undefined) return String(num(v.floatValue));
    if (v.textValue !== undefined) {
      // In quotes the expressions here read as they are: double ones, or single ones round a text that has double ones.
      const text = str(v.textValue);
      return !text.includes('"') ? `"${text}"` : !text.includes("'") ? `'${text}'` : null;
    }
    if (v.colorValue) {
      const c = colour(v.colorValue).color;
      const part = (n: number): string => Math.round(n * 255).toString(16).padStart(2, '0');
      return `#${part(c.r)}${part(c.g)}${part(c.b)}`;
    }
    const expression = obj(v.expressionValue);
    if (!expression.expressionFunction) return null;
    const args = list(expression.expressionArguments).map((argument) => expressionOf(argument, depth + 1));
    if (args.some((argument) => argument === null)) return null;
    const [a, b] = args as string[];
    const binary: Record<string, string> = { ADDITION: '+', SUBTRACTION: '-', MULTIPLY: '*', DIVIDE: '/', EQUALS: '==', NOT_EQUAL: '!=', LESS_THAN: '<', LESS_THAN_OR_EQUAL: '<=', GREATER_THAN: '>', GREATER_THAN_OR_EQUAL: '>=', AND: 'and', OR: 'or' };
    const fn = str(expression.expressionFunction);
    if (binary[fn] && args.length === 2) return `(${a} ${binary[fn]} ${b})`;
    if (fn === 'NOT' && args.length === 1) return `not (${a})`;
    if (fn === 'NEGATE' && args.length === 1) return `-(${a})`;
    if (fn === 'IS_TRUTHY' && args.length === 1) return `(${a})`;
    if (fn === 'STRINGIFY' && args.length === 1) return `("" + ${a})`;
    return null;
  };

  /** The actions of an interaction, or of one side of a condition. */
  const actionsOf = (values: KiwiValue | undefined, depth: number): Action[] => {
    const actions: Action[] = [];
    for (const item of list(values)) {
        const action = obj(item);
        const connection = str(action.connectionType, 'NONE');
        const blank = { destinationId: null, transition: { type: 'INSTANT' as const, direction: 'LEFT' as const, duration: 0, delay: 0, easing: 'LINEAR' as const, bezier: [0.42, 0, 0.58, 1] as [number, number, number, number] }, variableId: null, expression: '', then: [], otherwise: [] };
        if (connection === 'URL') {
          actions.push({ ...blank, type: 'OPEN_LINK', expression: str(action.connectionURL) });
          continue;
        }
        if (connection === 'SET_VARIABLE') {
          const target = obj(obj(action.targetVariable).id).guid ?? action.targetVariableID;
          const variableId = target ? idOf(guidKey(target)) : null;
          const expression = expressionOf(action.targetVariableData);
          if (!variableId || !variables[variableId] || expression === null) {
            miss('Prototype “set variable” actions with values that cannot be written as an expression here');
            continue;
          }
          actions.push({ ...blank, type: 'SET_VARIABLE', variableId, expression });
          continue;
        }
        if (connection === 'CONDITIONAL') {
          // "If … else if … else": each block a condition and its actions, the last without a condition.
          const blocks = list(action.conditionalActions).map(obj);
          let chain: Action[] = [];
          for (let i = blocks.length - 1; i >= 0; i--) {
            const block = blocks[i] as KiwiObject;
            const then = depth < 4 ? actionsOf(block.actions, depth + 1) : [];
            const condition = block.condition ? expressionOf(block.condition) : null;
            if (block.condition && condition === null) {
              miss('Prototype conditions that cannot be written as an expression here');
              chain = [];
              break;
            }
            chain = condition === null ? then : [{ ...blank, type: 'CONDITIONAL', expression: condition, then, otherwise: chain }];
          }
          actions.push(...chain);
          continue;
        }
        const navigation = str(action.navigationType, 'NAVIGATE');
        const type: ActionType | undefined =
          connection === 'BACK' ? 'BACK' : connection === 'CLOSE' ? 'CLOSE_OVERLAY' : connection === 'INTERNAL_NODE' ? ({ NAVIGATE: 'NAVIGATE', OVERLAY: 'OPEN_OVERLAY', SWAP: 'SWAP_OVERLAY', SCROLL_TO: 'SCROLL_TO', SWAP_STATE: 'CHANGE_TO' } as Record<string, ActionType>)[navigation] : undefined;
        if (!type) {
          if (connection !== 'NONE') miss(`Prototype actions of the kind “${connection === 'INTERNAL_NODE' ? navigation : connection}”`);
          continue;
        }
        if (navigation === 'OVERLAY' && action.overlayRelativePosition) miss('Overlays placed beside the layer that opened them (shown at their own position)');
        const kind = str(action.transitionType, 'INSTANT_TRANSITION');
        const way = /(LEFT|RIGHT|TOP|BOTTOM)$/.exec(kind)?.[1] as 'LEFT' | 'RIGHT' | 'TOP' | 'BOTTOM' | undefined;
        // "From the left" moves things to the right; "out to the left" moves them to the left.
        const opposite = { LEFT: 'RIGHT', RIGHT: 'LEFT', TOP: 'BOTTOM', BOTTOM: 'TOP' } as const;
        const direction = way ? (kind.includes('_FROM_') ? opposite[way] : way) : 'LEFT';
        const transitionType: Transition['type'] = kind.startsWith('SLIDE_FROM') ? 'SLIDE_IN' : kind.startsWith('SLIDE_OUT') ? 'SLIDE_OUT' : kind.startsWith('PUSH') ? 'PUSH' : kind.startsWith('MOVE_FROM') ? 'MOVE_IN' : kind.startsWith('MOVE_OUT') ? 'MOVE_OUT' : kind === 'SMART_ANIMATE' || kind === 'MAGIC_MOVE' || action.transitionShouldSmartAnimate === true ? 'SMART_ANIMATE' : kind === 'DISSOLVE' || kind === 'FADE' ? 'DISSOLVE' : 'INSTANT';
        const easingType = str(action.easingType, 'OUT_CUBIC');
        const curve = list(action.easingFunction).map((part) => num(part));
        const easing: Transition['easing'] = easingType === 'LINEAR' ? 'LINEAR' : easingType === 'IN_CUBIC' || easingType === 'EASE_IN' ? 'EASE_IN' : easingType === 'INOUT_CUBIC' ? 'EASE_IN_OUT' : easingType === 'CUSTOM_CUBIC' && curve.length === 4 ? 'CUSTOM' : 'EASE_OUT';
        if (easingType.includes('SPRING') || easingType.includes('BACK')) miss('Spring and overshooting easings (shown as ease out)');
        actions.push({
          type,
          destinationId: action.transitionNodeID ? idOf(guidKey(action.transitionNodeID)) : null,
          transition: { type: transitionType, direction, duration: Math.round(num(action.transitionDuration, 0.3) * 1000), delay: 0, easing, bezier: curve.length === 4 ? (curve as [number, number, number, number]) : [0.42, 0, 0.58, 1] },
          variableId: null,
          expression: '',
          then: [],
          otherwise: [],
        });
    }
    return actions;
  };

  /** What a text has in parts styled apart from the rest, as this application's styled ranges. */
  const styleRangesOf = async (change: KiwiObject, characters: string): Promise<TextStyleRange[]> => {
    const data = obj(change.textData);
    const perCharacter = list(data.characterStyleIDs).map((value) => num(value));
    if (!perCharacter.some((value) => value !== 0)) return [];
    const table = new Map<number, KiwiObject>();
    for (const entry of list(data.styleOverrideTable)) table.set(num(obj(entry).styleID), obj(entry));
    const styleOf = async (styleId: number): Promise<TextRangeStyle> => {
      const entry = table.get(styleId);
      if (!entry) return {};
      const out: TextRangeStyle = {};
      if (entry.fontName) Object.assign(out, fontStyle(entry.fontName));
      if (entry.fontSize !== undefined) out.fontSize = num(entry.fontSize, 12);
      if (entry.textDecoration !== undefined) out.textDecoration = (['UNDERLINE', 'STRIKETHROUGH'].includes(str(entry.textDecoration)) ? str(entry.textDecoration) : 'NONE') as TextDecoration;
      const fill = (await paints(entry.fillPaints))[0];
      if (fill?.type === 'SOLID') out.color = fill.color;
      return out;
    };
    // Figma counts in code points; this application counts as strings do. The two differ only past the basic plane.
    const units: number[] = [];
    let at = 0;
    for (const char of characters) {
      units.push(at);
      at += char.length;
    }
    units.push(at);
    const out: TextStyleRange[] = [];
    let start = 0;
    while (start < perCharacter.length) {
      let end = start;
      while (end < perCharacter.length && perCharacter[end] === perCharacter[start]) end++;
      const styleId = perCharacter[start] as number;
      if (styleId !== 0) {
        const style = await styleOf(styleId);
        if (Object.keys(style).length > 0) out.push({ start: units[start] ?? at, end: units[Math.min(end, units.length - 1)] ?? at, ...style });
      }
      start = end;
    }
    return out;
  };

  // `pre` is laid over a layer's own transform: what a flipped frame or group passes to what is in it, as it is kept unflipped itself.
  const layer = async (change: KiwiObject, parentId: NodeId, order: string, parentChange: KiwiObject | null, pageId: NodeId, pre: Matrix | null = null): Promise<void> => {
    const kind = str(change.type);
    // A frame that fits round what is in it and does not clip is how newer files keep a group.
    const isGroup = kind === 'GROUP' || (kind === 'FRAME' && change.resizeToFit === true && change.frameMaskDisabled !== false && !change.fillPaints && !change.stackMode);
    const inside0 = children.get(guidKey(change.guid)) ?? [];
    // Kinds this application has no layer of its own for (FigJam's stickies, shapes and connectors, tables, code
    // blocks, slices, and kinds Figma adds later) are kept as the nearest thing: what holds layers is a frame, what
    // has an outline is a vector of it, anything else is a box; the text they carry is kept as a text layer in them.
    let type: LayerType | undefined = isGroup ? 'GROUP' : TYPES[kind];
    let approximated = false;
    if (!type) {
      approximated = true;
      const outline = geometryOf(change.fillGeometry).length > 0 || geometryOf(change.strokeGeometry).length > 0;
      type = inside0.length > 0 || change.textData || kind === 'SLICE' ? 'FRAME' : outline || change.vectorData ? 'VECTOR' : 'RECTANGLE';
      miss(kind === 'SLICE' ? 'Slices (kept as empty frames, with their export settings)' : `Layers of the kind “${kind}” (kept as ${type === 'FRAME' ? 'frames' : type === 'VECTOR' ? 'vectors of their outline' : 'boxes'})`);
    }
    const id = idOf(guidKey(change.guid));
    pageOfLayer.set(id, pageId);
    const width = Math.max(0.01, num(obj(change.size).x, 1));
    const height = Math.max(0.01, num(obj(change.size).y, 1));
    const own = change.transform ? matrixOf(change.transform) : ([1, 0, 0, 1, 0, 0] as Matrix);
    const m = pre ? multiply(pre, own) : own;
    // The layer's box turns about its centre here; Figma places its corner. The centre is the same in both.
    const centre = applyToPoint(m, { x: width / 2, y: height / 2 });
    // A flipped layer: turned, and mirrored top to bottom. What is drawn by points is mirrored exactly; text and pictures
    // have a flip of their own; what a frame or group holds is turned over inside it. A component or an instance cannot
    // be: what is in an instance is its component's, drawn the same in every instance. Those are shown unflipped, turned
    // as a mirror left to right would leave them (the flip designers make most), and listed.
    const reversed = m[0] * m[3] - m[1] * m[2] < 0;
    const mirrorable = kind !== 'INSTANCE' && kind !== 'SYMBOL';
    const flipped = reversed && mirrorable;
    if (reversed && !mirrorable) miss('Flipped components and instances (shown unflipped)');
    const rotation = (reversed && !mirrorable ? Math.atan2(-m[1], -m[0]) : Math.atan2(m[1], m[0])) * (180 / Math.PI);
    const bound: Record<string, string> = {};
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
      fills: await paints(change.fillPaints, { key: 'fills', out: bound }),
      strokes: await paints(change.strokePaints, { key: 'strokes', out: bound }),
      strokeWeight: num(change.strokeWeight, 1),
      strokeAlign: (['INSIDE', 'OUTSIDE', 'CENTER'].includes(str(change.strokeAlign)) ? str(change.strokeAlign) : 'INSIDE') as LayerNode['strokeAlign'],
      strokeCap: str(change.strokeCap) === 'ROUND' ? 'ROUND' : str(change.strokeCap) === 'SQUARE' ? 'SQUARE' : 'NONE',
      strokeJoin: str(change.strokeJoin) === 'ROUND' ? 'ROUND' : str(change.strokeJoin) === 'BEVEL' ? 'BEVEL' : 'MITER',
      dashPattern: list(change.dashPattern).map((value) => num(value)),
      effects: effects(change.effects),
      isMask: change.mask === true,
      constraints: { horizontal: CONSTRAINTS[str(change.horizontalConstraint, 'MIN')] ?? 'MIN', vertical: CONSTRAINTS[str(change.verticalConstraint, 'MIN')] ?? 'MIN' },
      scrollBehavior: str(change.scrollBehavior) === 'FIXED_WHEN_CHILD_OF_SCROLLING_FRAME' ? 'FIXED' : str(change.scrollBehavior) === 'STICKY_SCROLLS' ? 'STICKY' : 'SCROLLS',
      reactions: reactionsOf(change.prototypeInteractions),
    };
    if (change.borderStrokeWeightsIndependent === true) {
      props.strokeSides = { top: num(change.borderTopWeight, num(change.strokeWeight)), right: num(change.borderRightWeight, num(change.strokeWeight)), bottom: num(change.borderBottomWeight, num(change.strokeWeight)), left: num(change.borderLeftWeight, num(change.strokeWeight)) };
      if (type !== 'FRAME' && type !== 'RECTANGLE') miss('Strokes of a different weight on each side of layers other than frames and rectangles (drawn with one weight)');
    }
    if (num(change.cornerSmoothing) > 0) miss('Smoothed corners (drawn as plain round corners)');
    if (change.mask === true && str(change.maskType, 'ALPHA') !== 'ALPHA') miss(`Masks by ${str(change.maskType).toLowerCase()} (applied by their shape)`);
    if (str(change.blendMode) === 'LINEAR_BURN' || str(change.blendMode) === 'LINEAR_DODGE') {
      props.blendMode = str(change.blendMode) === 'LINEAR_BURN' ? 'MULTIPLY' : 'SCREEN';
      miss('Linear burn and linear dodge blending (drawn as multiply and screen)');
    }
    // Smallest and largest sizes, in Auto Layout.
    const minSize = obj(obj(change.minSize).value);
    const maxSize = obj(obj(change.maxSize).value);
    if (change.minSize) {
      if (minSize.x !== undefined) props.minWidth = num(minSize.x);
      if (minSize.y !== undefined) props.minHeight = num(minSize.y);
    }
    if (change.maxSize) {
      if (maxSize.x !== undefined) props.maxWidth = num(maxSize.x);
      if (maxSize.y !== undefined) props.maxHeight = num(maxSize.y);
    }
    // Bindings of other properties to variables: sizes, radius, spacing, padding, opacity, type, text, visibility.
    const FIELDS: Record<string, string> = { CORNER_RADIUS: 'cornerRadius', STROKE_WEIGHT: 'strokeWeight', STACK_SPACING: 'itemSpacing', STACK_PADDING_LEFT: 'paddingLeft', STACK_PADDING_TOP: 'paddingTop', STACK_PADDING_RIGHT: 'paddingRight', STACK_PADDING_BOTTOM: 'paddingBottom', VISIBLE: 'visible', TEXT_DATA: 'characters', WIDTH: 'width', HEIGHT: 'height', OPACITY: 'opacity', FONT_SIZE: 'fontSize', LETTER_SPACING: 'letterSpacing', LINE_HEIGHT: 'lineHeight', FONT_FAMILY: 'fontFamily' };
    for (const entry of list(obj(change.variableConsumptionMap).entries)) {
      const field = str(obj(entry).variableField);
      const variable = aliasOf(obj(entry).variableData);
      const key = FIELDS[field];
      if (key && variable) bound[key] = variable;
      else if (field) miss(`Bindings of “${field}” to variables (the value is kept)`);
    }
    // The mode of each collection chosen on this layer.
    const modes: Record<string, string> = {};
    for (const entry of list(obj(change.variableModeBySetMap).entries)) {
      const set = obj(obj(entry).variableSetID).guid;
      if (set && obj(entry).variableModeID) modes[idOf(guidKey(set))] = idOf(`mode:${guidKey(obj(entry).variableModeID)}`);
    }
    if (Object.keys(modes).length > 0) props.variableModes = modes;
    // Layout grids, guides and export settings.
    const grids = gridsOf(change.layoutGrids);
    if (grids.length > 0) props.layoutGrids = grids;
    const guideList = list(change.guides).map(obj).map((guide) => ({ axis: (str(guide.axis) === 'Y' ? 'Y' : 'X') as 'X' | 'Y', position: num(guide.offset) }));
    if (guideList.length > 0) props.guides = guideList;
    const exports: ExportSetting[] = [];
    for (const value of list(change.exportSettings)) {
      const setting = obj(value);
      const format = ({ PNG: 'PNG', JPEG: 'JPG', SVG: 'SVG', PDF: 'PDF' } as Record<string, ExportSetting['format']>)[str(setting.imageType, 'PNG')];
      if (!format) {
        miss(`Export settings of the kind “${str(setting.imageType)}”`);
        continue;
      }
      const constraint = obj(setting.constraint);
      const kindOf = str(constraint.type, 'CONTENT_SCALE');
      exports.push({ format, constraint: { type: kindOf === 'CONTENT_WIDTH' ? 'WIDTH' : kindOf === 'CONTENT_HEIGHT' ? 'HEIGHT' : 'SCALE', value: num(constraint.value, 1) }, suffix: str(setting.suffix), background: false, quality: num(setting.quality, 0.9) || 0.9, svgIds: setting.svgIDMode !== undefined && str(setting.svgIDMode) !== 'IF_NEEDED' ? true : setting.svgDataName === true, pdfContent: 'VECTOR', pdfText: setting.svgOutlineText === true ? 'PICTURE' : 'TEXT' });
    }
    if (exports.length > 0) props.exportSettings = exports;
    // In a prototype: which way it scrolls, and how it opens as an overlay.
    const scroll = str(change.scrollDirection);
    if (scroll === 'HORIZONTAL' || scroll === 'VERTICAL' || scroll === 'BOTH') props.overflow = scroll;
    if (change.overlayPositionType) {
      const position = str(change.overlayPositionType);
      props.overlayPosition = (['TOP_LEFT', 'TOP_CENTER', 'TOP_RIGHT', 'BOTTOM_LEFT', 'BOTTOM_CENTER', 'BOTTOM_RIGHT'].includes(position) ? position : 'CENTER') as OverlayPosition;
      if (position === 'MANUAL') miss('Overlays at a position of their own (shown in the centre)');
    }
    if (change.overlayBackgroundInteraction !== undefined) props.overlayCloseOutside = str(change.overlayBackgroundInteraction) === 'CLOSE_ON_CLICK_OUTSIDE';
    const backdrop = obj(change.overlayBackgroundAppearance);
    if (str(backdrop.backgroundType) === 'SOLID_COLOR') {
      const c = colour(backdrop.backgroundColor);
      props.overlayBackground = { color: c.color, opacity: c.a };
    }
    if (change.hyperlink || list(obj(change.textData).lines).some((line) => obj(line).lineType === 'BLOCKQUOTE' || obj(line).lineType === 'CHECKLIST')) miss('Links in text, quotes and checklists (shown as plain text)');
    if (!change.fillPaints && (type === 'FRAME' || type === 'GROUP')) props.fills = [];
    if (type === 'FRAME' || type === 'RECTANGLE') {
      props.cornerRadius = num(change.cornerRadius);
      if (change.rectangleCornerRadiiIndependent === true) props.cornerRadii = [num(change.rectangleTopLeftCornerRadius), num(change.rectangleTopRightCornerRadius), num(change.rectangleBottomRightCornerRadius), num(change.rectangleBottomLeftCornerRadius)];
    }
    // In a parent with Auto Layout: how this layer is sized and whether it is in the flow.
    const parentStack = str(obj(parentChange ?? undefined).stackMode, 'NONE');
    if (parentStack === 'HORIZONTAL' || parentStack === 'VERTICAL') {
      const grow = num(change.stackChildPrimaryGrow) > 0;
      const stretch = str(change.stackChildAlignSelf) === 'STRETCH';
      const horizontal = parentStack === 'HORIZONTAL';
      if (grow) props[horizontal ? 'layoutSizingHorizontal' : 'layoutSizingVertical'] = 'FILL';
      if (stretch) props[horizontal ? 'layoutSizingVertical' : 'layoutSizingHorizontal'] = 'FILL';
      if (str(change.stackPositioning) === 'ABSOLUTE') props.layoutPositioning = 'ABSOLUTE';
    }
    if (type === 'FRAME') {
      props.clipsContent = kind === 'SECTION' || approximated ? change.frameMaskDisabled === false : change.frameMaskDisabled !== true;
      if (approximated && !change.fillPaints) props.fills = [];
      props.kind = kind === 'SYMBOL' ? 'COMPONENT' : kind === 'INSTANCE' ? 'INSTANCE' : change.isStateGroup === true ? 'COMPONENT_SET' : 'FRAME';
      if (kind === 'SYMBOL' || change.isStateGroup === true) props.description = str(change.symbolDescription, str(change.description));
      // A variant's values are in its name: "Type=Primary, State=Hover".
      if (kind === 'SYMBOL' && obj(parentChange ?? undefined).isStateGroup === true) {
        const values: Record<string, string> = {};
        for (const part of str(change.name).split(',')) {
          const [key, ...rest] = part.split('=');
          if (key && rest.length > 0) values[key.trim()] = rest.join('=').trim();
        }
        props.variantProps = values;
      }
      // Component properties: boolean, text and instance swap. Variant properties are the variants themselves.
      const defined: ComponentProp[] = [];
      for (const value of list(change.componentPropDefs)) {
        const definition = obj(value);
        if (definition.isDeleted === true || !definition.name) continue;
        const propType = ({ BOOL: 'BOOLEAN', TEXT: 'TEXT', INSTANCE_SWAP: 'INSTANCE_SWAP' } as Record<string, ComponentProp['type']>)[str(definition.type)];
        if (propType) defined.push({ id: idOf(`prop:${guidKey(definition.id)}`), name: str(definition.name), type: propType });
        else if (str(definition.type) !== 'VARIANT') miss(`Component properties of the kind “${str(definition.type)}”`);
      }
      if (defined.length > 0) props.componentProps = defined;
      const stack = str(change.stackMode, 'NONE');
      if (stack === 'HORIZONTAL' || stack === 'VERTICAL') {
        props.layoutMode = stack;
        props.layoutWrap = str(change.stackWrap) === 'WRAP' ? 'WRAP' : 'NO_WRAP';
        props.itemSpacing = num(change.stackSpacing);
        props.counterAxisSpacing = num(change.stackCounterSpacing, num(change.stackSpacing));
        props.paddingLeft = num(change.stackHorizontalPadding);
        props.paddingTop = num(change.stackVerticalPadding);
        props.paddingRight = num(change.stackPaddingRight, num(change.stackHorizontalPadding));
        props.paddingBottom = num(change.stackPaddingBottom, num(change.stackVerticalPadding));
        const justify = str(change.stackPrimaryAlignItems, 'MIN');
        props.primaryAxisAlignItems = justify === 'CENTER' ? 'CENTER' : justify === 'MAX' ? 'MAX' : justify.startsWith('SPACE') ? 'SPACE_BETWEEN' : 'MIN';
        if (justify === 'SPACE_EVENLY' || justify === 'SPACE_AROUND' || justify === 'SPACE_EVENLY_CSS') miss('Auto Layout spaced evenly or around (spaced between instead)');
        const align = str(change.stackCounterAlignItems, 'MIN');
        props.counterAxisAlignItems = align === 'CENTER' ? 'CENTER' : align === 'MAX' ? 'MAX' : align === 'STRETCH' ? 'STRETCH' : align === 'BASELINE' ? 'BASELINE' : 'MIN';
        if (str(change.stackCounterAlignContent) === 'SPACE_BETWEEN') props.counterAxisAlignContent = 'SPACE_BETWEEN';
        if (change.stackReverseZIndex === true) miss('Auto Layout with the first item drawn on top (drawn with the last on top)');
        // Hugging what is in it, along and across: Figma's "resize to fit".
        const hugs = (value: KiwiValue | undefined): boolean => str(value).startsWith('RESIZE_TO_FIT');
        const along = hugs(change.stackPrimarySizing);
        const across = hugs(change.stackCounterSizing);
        const horizontal = stack === 'HORIZONTAL';
        if (along && props[horizontal ? 'layoutSizingHorizontal' : 'layoutSizingVertical'] === undefined) props[horizontal ? 'layoutSizingHorizontal' : 'layoutSizingVertical'] = 'HUG';
        if (across && props[horizontal ? 'layoutSizingVertical' : 'layoutSizingHorizontal'] === undefined) props[horizontal ? 'layoutSizingVertical' : 'layoutSizingHorizontal'] = 'HUG';
      }
      if (change.prototypeStartingPoint) flows.set(pageId, [...(flows.get(pageId) ?? []), { id: createId(), name: str(obj(change.prototypeStartingPoint).name, str(change.name, 'Flow')), startId: id }]);
      if (kind === 'INSTANCE') {
        instances.push({ id, symbol: guidKey(obj(change.symbolData).symbolID), overrides: list(obj(change.symbolData).symbolOverrides).map(obj), assignments: list(change.componentPropAssignments).map(obj) });
      }
    }
    // A layer of a component bound to one of its properties.
    const references: PropRefs = {};
    for (const value of list(change.componentPropRefs)) {
      const reference = obj(value);
      if (reference.isDeleted === true) continue;
      const field = str(reference.componentPropNodeField);
      const key = field === 'TEXT_DATA' ? 'characters' : field === 'VISIBLE' ? 'visible' : field === 'OVERRIDDEN_SYMBOL_ID' ? 'componentId' : null;
      if (key) references[key] = idOf(`prop:${guidKey(reference.defID)}`);
      else miss(`Component property bindings to “${field}”`);
    }
    if (Object.keys(references).length > 0) props.propRefs = references;
    if (type === 'ELLIPSE' && change.arcData) {
      const arc = obj(change.arcData);
      const start = (num(arc.startingAngle) * 180) / Math.PI;
      const end = (num(arc.endingAngle, Math.PI * 2) * 180) / Math.PI;
      props.arcSweep = Math.min(360, Math.max(1, end - start));
      // Mirrored top to bottom, an arc from one angle to another runs back from the second's mirror to the first's.
      props.arcStart = flipped ? (((-(start + (props.arcSweep as number))) % 360) + 360) % 360 : start;
      props.arcRatio = Math.min(0.99, Math.max(0, num(arc.innerRadius)));
    }
    if (type === 'POLYGON' || type === 'STAR') props.pointCount = Math.max(3, Math.round(num(change.count, type === 'STAR' ? 5 : 3)));
    if (type === 'STAR') props.innerRadius = Math.min(1, Math.max(0, num(change.starInnerScale, 0.38)));
    if (type === 'LINE') props.height = 0;
    if (type === 'TEXT') {
      const characters = str(obj(change.textData).characters);
      // A list: here every paragraph of a text is a bullet or a number, so a text is one when all its paragraphs are of one kind.
      const kinds = new Set(list(obj(change.textData).lines).map((line) => str(obj(line).lineType, 'PLAIN')));
      if (kinds.size === 1 && kinds.has('ORDERED_LIST')) props.listType = 'NUMBERED';
      else if (kinds.size === 1 && kinds.has('UNORDERED_LIST')) props.listType = 'BULLETED';
      else if (kinds.has('ORDERED_LIST') || kinds.has('UNORDERED_LIST')) miss('Lists in only some paragraphs of a text, or of both kinds (shown as plain text)');
      if (num(change.paragraphSpacing) > 0 || num(change.paragraphIndent) > 0) miss('Space between paragraphs and paragraph indents');
      if (flipped) props.flipY = true;
      Object.assign(props, typeSettings(change), {
        characters,
        textAlign: (['LEFT', 'CENTER', 'RIGHT', 'JUSTIFIED'].includes(str(change.textAlignHorizontal)) ? str(change.textAlignHorizontal) : 'LEFT') as never,
        verticalAlign: str(change.textAlignVertical) === 'CENTER' ? 'MIDDLE' : str(change.textAlignVertical) === 'BOTTOM' ? 'BOTTOM' : 'TOP',
        textAutoResize: str(change.textAutoResize) === 'WIDTH_AND_HEIGHT' ? 'WIDTH_AND_HEIGHT' : str(change.textAutoResize) === 'HEIGHT' ? 'HEIGHT' : 'NONE',
        styleRanges: await styleRangesOf(change, characters),
      });
    }
    if (type === 'VECTOR') {
      const data = obj(change.vectorData);
      const blob = blobs[num(data.vectorNetworkBlob, -1)];
      const normal = obj(data.normalizedSize);
      let network: VectorNetwork | null = null;
      if (blob) {
        try {
          network = readVectorBlob(blob, width / Math.max(1e-6, num(normal.x, width)), height / Math.max(1e-6, num(normal.y, height)));
        } catch {
          network = null;
        }
      }
      // Without its points, a shape is drawn from the outline Figma keeps of it.
      if (!network || network.vertices.length === 0) {
        const outline = geometryOf(change.fillGeometry);
        const paths = outline.length > 0 ? outline : geometryOf(change.strokeGeometry);
        if (paths.length > 0) network = networkFromSubpaths(paths);
        if (outline.length === 0 && paths.length > 0) {
          // An outline of a stroke is filled with the stroke's paint.
          props.fills = props.strokes ?? [];
          props.strokes = [];
        }
      }
      if (!network) {
        miss('Vectors whose points are not in the file');
        return;
      }
      props.network = network;
      if (flipped) props.network = mirrorNetwork(network, width, height, 'vertical');
    }
    if (flipped && type !== 'TEXT') {
      // Pictures and gradients are turned over. What a frame or a group holds is turned over by the transform passed to it, below.
      const turn = (paint: Paint): Paint => (paint.type === 'IMAGE' ? { ...paint, flipY: !paint.flipY } : paint.type === 'SOLID' ? paint : { ...paint, from: { x: paint.from.x, y: 1 - paint.from.y }, to: { x: paint.to.x, y: 1 - paint.to.y } });
      props.fills = (props.fills ?? []).map(turn);
      props.strokes = (props.strokes ?? []).map(turn);
      // The stroke's top side is now at the bottom.
      const sides = props.strokeSides as { top: number; right: number; bottom: number; left: number } | undefined;
      if (sides) props.strokeSides = { ...sides, top: sides.bottom, bottom: sides.top };
      if (type === 'FRAME' && change.stackMode && str(change.stackMode) !== 'NONE') miss('Flipped Auto Layout frames (their items are laid out unflipped)');
      if (type === 'POLYGON' || type === 'STAR') miss('Flipped polygons and stars (shown unflipped)');
      // Turned top to bottom, the corners on top are those that were at the bottom.
      const radii = props.cornerRadii as [number, number, number, number] | undefined;
      if (radii) props.cornerRadii = [radii[3], radii[2], radii[1], radii[0]];
    }
    if (type === 'BOOLEAN_OPERATION') {
      const operation = str(change.booleanOperation, 'UNION');
      props.operation = operation === 'XOR' ? 'EXCLUDE' : operation === 'INTERSECT' ? 'INTERSECT' : operation === 'SUBTRACT' ? 'SUBTRACT' : 'UNION';
    }
    const refs: StyleRefs = {};
    const fillStyle = styleRef(change.styleIdForFill) ?? styleRef(change.inheritFillStyleID ? { guid: change.inheritFillStyleID } : undefined);
    if (fillStyle) refs.fills = fillStyle;
    const strokeStyle = styleRef(change.styleIdForStrokeFill) ?? styleRef(change.inheritFillStyleIDForStroke ? { guid: change.inheritFillStyleIDForStroke } : undefined);
    if (strokeStyle) refs.strokes = strokeStyle;
    const textStyle = type === 'TEXT' ? (styleRef(change.styleIdForText) ?? styleRef(change.inheritTextStyleID ? { guid: change.inheritTextStyleID } : undefined)) : undefined;
    if (textStyle) refs.text = textStyle;
    const effectStyle = styleRef(change.styleIdForEffect) ?? styleRef(change.inheritEffectStyleID ? { guid: change.inheritEffectStyleID } : undefined);
    if (effectStyle) refs.effects = effectStyle;
    if (Object.keys(refs).length > 0) props.styleRefs = refs;
    if (Object.keys(bound).length > 0) props.boundVariables = bound;
    const gridStyle = styleRef(change.styleIdForGrid);
    if (gridStyle) props.styleRefs = { ...(props.styleRefs ?? {}), grids: gridStyle };
    nodes[id] = createLayer(type, parentId, order, props as LayerPatch);
    nodes[id] = { ...nodes[id], id } as DesignNode;
    // The text a node of another kind carries (a sticky note, a shape with text, a table cell) is a text layer in it.
    if (approximated && change.textData && str(obj(change.textData).characters) !== '') {
      const textId = idOf(`text:${guidKey(change.guid)}`);
      const padding = Math.min(16, width / 8, height / 8);
      nodes[textId] = { ...createLayer('TEXT', id, '~', { name: 'Text', x: padding, y: padding, width: Math.max(1, width - padding * 2), height: Math.max(1, height - padding * 2), textAutoResize: 'HEIGHT', characters: str(obj(change.textData).characters), ...typeSettings(change), fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 }, opacity: 1, visible: true }] } as LayerPatch), id: textId } as DesignNode;
    }
    // What is in an instance is its component's, and is made from it.
    if (kind === 'INSTANCE') return;
    const inside = children.get(guidKey(change.guid)) ?? [];
    const keys = freshKeys(Math.max(1, inside.length));
    // A flipped frame or group is kept unflipped; what it holds is turned over within it instead, so it looks the same.
    const turn: Matrix | null = flipped ? [1, 0, 0, -1, 0, height] : null;
    for (let i = 0; i < inside.length; i++) await layer(inside[i] as KiwiObject, id, keys[i] as string, change, pageId, turn);
  };

  for (const canvasNode of canvases) {
    const pageId = ids.get(guidKey(canvasNode.guid));
    if (!pageId || !nodes[pageId]) continue;
    const inside = children.get(guidKey(canvasNode.guid)) ?? [];
    const keys = freshKeys(Math.max(1, inside.length));
    for (let i = 0; i < inside.length; i++) await layer(inside[i] as KiwiObject, pageId, keys[i] as string, null, pageId);
  }

  // Instances: their component, what is changed in them, and their properties' values.
  for (const instance of instances) {
    const node = nodes[instance.id];
    const component = ids.get(instance.symbol);
    if (!isLayer(node)) continue;
    if (!component || !nodes[component]) {
      // Its component is not in this file: it stays as a frame, without what was in it.
      miss('Instances of components that are not in the file (they are left as empty frames)');
      nodes[instance.id] = { ...node, kind: 'FRAME' } as DesignNode;
      continue;
    }
    const overrides: Record<NodeId, Record<string, unknown>> = {};
    for (const override of instance.overrides) {
      // The layer changed, by the path to it: a layer of the component, or one in an instance in it, and so on down.
      const path = list(obj(override.guidPath).guids).map((guid) => idOf(guidKey(guid)));
      if (path.length === 0) continue;
      const target = path[path.length - 1] as NodeId;
      const source = nodes[target];
      // Changes to layers the component no longer has: Figma keeps them, and shows nothing of them.
      if (!source) continue;
      // A path to the component itself is a change to the instance itself (keyed by the component, as here too).
      const itself = path.length === 1 && target === component;
      const props: Record<string, unknown> = {};
      if (override.name !== undefined) props.name = str(override.name);
      if (override.strokeWeight !== undefined) props.strokeWeight = num(override.strokeWeight, 1);
      if (override.stackPositioning !== undefined) props.layoutPositioning = str(override.stackPositioning) === 'ABSOLUTE' ? 'ABSOLUTE' : 'AUTO';
      if (override.borderStrokeWeightsIndependent === false) props.strokeSides = null;
      // The weights of the sides count only where the sides are independent: by this change, or already in the component.
      else if (override.borderStrokeWeightsIndependent === true || (isLayer(source) && source.strokeSides !== null && ['borderTopWeight', 'borderRightWeight', 'borderBottomWeight', 'borderLeftWeight'].some((key) => override[key] !== undefined))) {
        // Sides it does not name are as the component has them.
        const weight = num(override.strokeWeight, isLayer(source) ? source.strokeWeight : 1);
        const base = isLayer(source) && source.strokeSides ? source.strokeSides : { top: weight, right: weight, bottom: weight, left: weight };
        props.strokeSides = { top: num(override.borderTopWeight, base.top), right: num(override.borderRightWeight, base.right), bottom: num(override.borderBottomWeight, base.bottom), left: num(override.borderLeftWeight, base.left) };
      }
      // A size of its own: the place and size of a layer in an instance belong to the instance, so it is given once its layers are made.
      if (override.size && !itself) resized.push({ chain: [instance.id, ...path], width: Math.max(0.01, num(obj(override.size).x, 1)), height: Math.max(0.01, num(obj(override.size).y, 1)) });
      // An instance inside: the values of its own component's properties.
      if (override.componentPropAssignments) {
        const inner: Record<string, boolean | string> = {};
        for (const assignment of list(override.componentPropAssignments).map(obj)) {
          const value = obj(assignment.value);
          const key = idOf(`prop:${guidKey(assignment.defID)}`);
          if (value.boolValue !== undefined) inner[key] = value.boolValue === true;
          else if (value.textValue) inner[key] = str(obj(value.textValue).characters);
          else if (value.guidValue) inner[key] = idOf(guidKey(value.guidValue));
        }
        if (Object.keys(inner).length > 0) props.propValues = inner;
      }
      if (override.fillPaints) props.fills = await paints(override.fillPaints);
      if (override.strokePaints) props.strokes = await paints(override.strokePaints);
      if (override.visible !== undefined) props.visible = override.visible !== false;
      if (override.opacity !== undefined) props.opacity = num(override.opacity, 1);
      if (override.textData) props.characters = str(obj(override.textData).characters);
      if (override.fontSize !== undefined) props.fontSize = num(override.fontSize, 12);
      if (override.fontName) Object.assign(props, fontStyle(override.fontName));
      if (override.overriddenSymbolID) props.componentId = idOf(guidKey(override.overriddenSymbolID));
      if (override.effects) props.effects = effects(override.effects);
      if (override.prototypeInteractions) props.reactions = reactionsOf(override.prototypeInteractions);
      // What Figma works out for itself again (geometry, measured text, versions) is not a change of the designer's.
      const derived = new Set(['guidPath', 'derivedTextData', 'fillGeometry', 'strokeGeometry', 'fontVersion', 'textUserLayoutVersion', 'textExplicitLayoutVersion', 'fontVariations', 'textBidiVersion', 'textTracking', 'autoRename', 'emojiImageSet', 'editInfo', 'overrideLevel']);
      const converted = new Set(['fillPaints', 'strokePaints', 'visible', 'opacity', 'textData', 'fontSize', 'fontName', 'overriddenSymbolID', 'effects', 'prototypeInteractions', 'name', 'strokeWeight', 'borderStrokeWeightsIndependent', 'borderTopWeight', 'borderRightWeight', 'borderBottomWeight', 'borderLeftWeight', 'size', 'componentPropAssignments', 'stackPositioning']);
      const NAMES: Record<string, string> = {};
      for (const key of Object.keys(override)) {
        if (derived.has(key) || converted.has(key)) continue;
        miss(`Changes made inside instances to ${NAMES[key] ?? `“${key}”`} (shown as their component has them)`);
      }
      if (Object.keys(props).length === 0) continue;
      // A change inside an instance inside is an override of that instance's: { [inner]: { overrides: { [layer]: … } } }.
      let level = overrides;
      for (const step of path.slice(0, -1)) {
        const entry = { ...(level[step] ?? {}) };
        const deeper = { ...((entry.overrides as Record<NodeId, Record<string, unknown>> | undefined) ?? {}) };
        entry.overrides = deeper;
        level[step] = entry;
        level = deeper;
      }
      level[target] = { ...(level[target] ?? {}), ...props };
    }
    const values: Record<string, boolean | string> = {};
    for (const assignment of instance.assignments) {
      const value = obj(assignment.value);
      const key = idOf(`prop:${guidKey(assignment.defID)}`);
      if (value.boolValue !== undefined) values[key] = value.boolValue === true;
      else if (value.textValue) values[key] = str(obj(value.textValue).characters);
      else if (value.guidValue) values[key] = idOf(guidKey(value.guidValue));
    }
    nodes[instance.id] = { ...node, componentId: component, overrides, propValues: values } as DesignNode;
  }
  for (const [pageId, list] of flows) {
    const page = nodes[pageId];
    if (isPage(page)) nodes[pageId] = { ...page, flows: list };
  }
  if (pages.length === 0) miss('Pages (the file has none that can be shown)');

  const repaired = repairDocument({ id: createId(), name, nodes, assets, styles, variables, variableCollections: collections, publication: null }).doc;
  // Instances get their component's layers, groups their boxes and boolean groups their shapes, as after any change.
  let doc = restoreLayout({ ...repaired, nodes: {} }, repaired, env.measurer);
  // An instance at a size other than its component's (an icon placed smaller, say) has what is in it placed and sized
  // by their constraints, as Figma does when an instance is resized. Its layers are made at the component's size,
  // so each instance is done once, outermost first; one whose layers an outer one already moved is left as it is.
  const before = doc;
  // The work is done on small documents of one instance's layers each and gathered here, and the whole document is
  // changed once at the end: changing it for every layer would index all of its layers again every time.
  const moved: Record<NodeId, DesignNode> = {};
  const nodeOf = (id: NodeId): DesignNode | undefined => moved[id] ?? before.nodes[id];
  const within = (rootId: NodeId, change: (part: Document) => Document): void => {
    const part: Record<NodeId, DesignNode> = {};
    const walk = (id: NodeId): void => {
      const node = nodeOf(id);
      if (!node) return;
      part[id] = node;
      for (const childId of getChildIds(before, id)) walk(childId);
    };
    walk(rootId);
    const result = change({ ...before, nodes: part });
    for (const id in result.nodes) if (result.nodes[id] !== part[id]) moved[id] = result.nodes[id] as DesignNode;
  };
  const scaledByTool: { id: NodeId; factor: number }[] = [];
  const depth = new Map<NodeId, number>();
  const depthOf = (id: NodeId): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    const node = doc.nodes[id];
    const value = isLayer(node) ? depthOf(node.parentId) + 1 : 0;
    depth.set(id, value);
    return value;
  };
  const sizedInstances = Object.values(doc.nodes).filter((node): node is LayerNode => {
    if (!isLayer(node) || node.type !== 'FRAME' || node.kind !== 'INSTANCE' || !node.componentId) return false;
    const component = doc.nodes[node.componentId];
    return isLayer(component) && (component.width !== node.width || component.height !== node.height);
  });
  sizedInstances.sort((a, b) => depthOf(a.id) - depthOf(b.id));
  for (const { id } of sizedInstances) {
    const instance = nodeOf(id);
    const component = isLayer(instance) && instance.type === 'FRAME' && instance.componentId ? nodeOf(instance.componentId) : undefined;
    if (!isLayer(instance) || !isLayer(component)) continue;
    within(id, (whole) => {
      // Everything in it goes back to where its component has it first: an outer instance that was resized moved it
      // from there by sizes this one did not yet have, and its constraints work from the component's size.
      const reset: Record<NodeId, LayerPatch> = {};
      const back = (parentId: NodeId): void => {
        for (const childId of getChildIds(whole, parentId)) {
          const child = whole.nodes[childId];
          const source = isLayer(child) && child.sourceId ? nodeOf(child.sourceId) : undefined;
          if (isLayer(child) && isLayer(source)) {
            reset[childId] = { x: source.x, y: source.y, width: source.width, height: source.height, ...(child.type === 'VECTOR' && source.type === 'VECTOR' ? { network: source.network } : {}) };
          }
          back(childId);
        }
      };
      back(id);
      const part = patchNodes(whole, reset);
      const placed = applyConstraints(part, id, component.width, component.height, instance.width, instance.height);
      // Scaled with Figma's scale tool, an instance has everything in it scaled with it, whatever their constraints:
      // that is taken to be so when it is exactly in proportion to its component and its constraints would leave what
      // it holds sticking out of it, which the designer would have seen in Figma.
      const sx = instance.width / Math.max(1e-6, component.width);
      const sy = instance.height / Math.max(1e-6, component.height);
      if (Math.abs(sx - sy) > 0.005 * Math.max(sx, sy)) return placed;
      const outside = (doc2: Document, frame: { width: number; height: number }): boolean =>
        getChildIds(doc2, id).some((childId) => {
          const child = doc2.nodes[childId];
          return isLayer(child) && child.visible && child.rotation === 0 && (child.x < -0.5 || child.y < -0.5 || child.x + child.width > frame.width + 0.5 || child.y + child.height > frame.height + 0.5);
        });
      if (!outside(placed, instance) || outside(part, component)) return placed;
      const patches: Record<NodeId, LayerPatch> = {};
      const scale = (parentId: NodeId): void => {
        for (const childId of getChildIds(part, parentId)) {
          const child = part.nodes[childId];
          if (!isLayer(child)) continue;
          const patch: LayerPatch = { x: child.x * sx, y: child.y * sx, width: child.width * sx, height: child.height * sx };
          if (child.type === 'VECTOR') patch.network = scaleNetwork(child.network, sx, sx);
          patches[childId] = patch;
          scale(childId);
        }
      };
      scale(id);
      scaledByTool.push({ id, factor: sx });
      return patchNodes(part, patches);
    });
  }
  // What the scale tool scales besides places and sizes (stroke weights, corners, shadows and blurs, type) is given to
  // the layers of those instances as changes made in them, kept by the instance that holds them as any change is.
  for (const { id, factor } of scaledByTool) {
    const instance = nodeOf(id);
    if (!isLayer(instance) || instance.type !== 'FRAME' || !instance.componentId) continue;
    // The instance whose overrides hold the changes (the outermost one of its own), and the path from it to this one.
    const nearestInstance = (nodeId: NodeId): LayerNode | undefined => {
      let parent = nodeOf(nodeId);
      while (isLayer(parent)) {
        parent = nodeOf(parent.parentId);
        if (isLayer(parent) && parent.type === 'FRAME' && parent.kind === 'INSTANCE') return parent;
      }
      return undefined;
    };
    const prefix: NodeId[] = [];
    let owner: LayerNode | undefined = instance;
    while (owner && owner.sourceId !== null) {
      prefix.unshift(owner.sourceId);
      owner = nearestInstance(owner.id);
    }
    if (!owner) continue;
    let overrides = (owner.type === 'FRAME' ? owner.overrides : {}) as Record<NodeId, Record<string, unknown>>;
    const put = (keys: readonly NodeId[], props: Record<string, unknown>): void => {
      const write = (level: Record<NodeId, Record<string, unknown>>, at: number): Record<NodeId, Record<string, unknown>> => {
        const key = keys[at] as NodeId;
        const entry = { ...(level[key] ?? {}) };
        if (at === keys.length - 1) Object.assign(entry, props);
        else entry.overrides = write((entry.overrides as Record<NodeId, Record<string, unknown>> | undefined) ?? {}, at + 1);
        return { ...level, [key]: entry };
      };
      overrides = write(overrides, 0);
    };
    const scaled = (node: LayerNode): Record<string, unknown> => {
      const out: Record<string, unknown> = {};
      const by = (value: number): number => Math.round(value * factor * 10000) / 10000;
      if (node.strokeWeight > 0) out.strokeWeight = by(node.strokeWeight);
      if (node.strokeSides) out.strokeSides = { top: by(node.strokeSides.top), right: by(node.strokeSides.right), bottom: by(node.strokeSides.bottom), left: by(node.strokeSides.left) };
      if (node.dashPattern.length > 0) out.dashPattern = node.dashPattern.map(by);
      if (node.effects.length > 0) out.effects = node.effects.map((effect) => (isShadow(effect) ? { ...effect, offsetX: by(effect.offsetX), offsetY: by(effect.offsetY), blur: by(effect.blur), spread: by(effect.spread) } : { ...effect, radius: by(effect.radius) }));
      if ((node.type === 'FRAME' || node.type === 'RECTANGLE') && node.cornerRadius > 0) out.cornerRadius = by(node.cornerRadius);
      if ((node.type === 'FRAME' || node.type === 'RECTANGLE') && node.cornerRadii) out.cornerRadii = node.cornerRadii.map(by);
      if (node.type === 'TEXT') {
        out.fontSize = by(node.fontSize);
        if (node.lineHeight !== null) out.lineHeight = by(node.lineHeight);
        if (node.letterSpacing !== 0) out.letterSpacing = by(node.letterSpacing);
        if (node.styleRanges.length > 0)
          out.styleRanges = node.styleRanges.map((range) => ({ ...range, ...(range.fontSize !== undefined ? { fontSize: by(range.fontSize) } : {}), ...(range.letterSpacing !== undefined ? { letterSpacing: by(range.letterSpacing) } : {}) }));
      }
      if (node.type === 'FRAME' && node.layoutMode !== 'NONE' && (node.itemSpacing !== 0 || node.paddingLeft + node.paddingRight + node.paddingTop + node.paddingBottom !== 0)) miss('Auto Layout inside instances scaled with the scale tool (its spacing and padding keep their sizes)');
      return out;
    };
    const root = scaled(instance);
    delete root.strokeSides;
    if (Object.keys(root).length > 0) put([...prefix, instance.componentId], root);
    const walk = (parentId: NodeId, keys: readonly NodeId[]): void => {
      for (const childId of getChildIds(before, parentId)) {
        const child = nodeOf(childId);
        if (!isLayer(child) || child.sourceId === null) continue;
        const path = [...keys, child.sourceId];
        const props = scaled(child);
        if (Object.keys(props).length > 0) put(path, props);
        // What is in an instance inside is that instance's, one level further down the path.
        walk(childId, child.type === 'FRAME' && child.kind === 'INSTANCE' ? path : keys);
      }
    };
    walk(id, prefix);
    moved[owner.id] = { ...(nodeOf(owner.id) as LayerNode), overrides } as DesignNode;
  }
  // Sizes given to layers in instances: now that the instances have their layers, those layers are given them.
  for (const { chain, width, height } of resized) {
    let id = chain[0] as NodeId;
    for (const step of chain.slice(1)) id = mirrorId(id, step);
    const node = nodeOf(id);
    if (!isLayer(node)) {
      miss('Sizes given to layers in instances that could not be found (shown as their component has them)');
      continue;
    }
    if (node.width !== width || node.height !== height) within(id, (part) => setLayerBox(part, id, { width, height }));
  }
  // Laid out again, as after any change.
  if (Object.keys(moved).length > 0) doc = restoreLayout(before, setNodes(before, moved), env.measurer);
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
      // A weight for each side, as Figma keeps it.
      if (node.strokeSides) Object.assign(change, { borderStrokeWeightsIndependent: true, borderTopWeight: node.strokeSides.top, borderRightWeight: node.strokeSides.right, borderBottomWeight: node.strokeSides.bottom, borderLeftWeight: node.strokeSides.left });
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
