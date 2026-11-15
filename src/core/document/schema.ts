/**
 * OPEN DESIGN document schema, version 7 (adds ruler guides on pages).
 * Version 2 added the GROUP layer type, version 3 TEXT, version 4 gradient
 * paints, stroke caps/joins/dashes, per-corner radii, effects and blend
 * modes, and version 5 image paints with the document's asset table.
 * The prose description of this file is DOCUMENT_SCHEMA.md; keep the two in step.
 */

export const CURRENT_SCHEMA_VERSION = 7;
export const FILE_FORMAT = 'open-design';
export const FILE_EXTENSION = '.opendesign';

export type NodeId = string;

export type LayerType = 'FRAME' | 'GROUP' | 'RECTANGLE' | 'ELLIPSE' | 'LINE' | 'POLYGON' | 'STAR' | 'TEXT';
export type NodeType = 'PAGE' | LayerType;

export const LAYER_TYPES: readonly LayerType[] = ['FRAME', 'GROUP', 'RECTANGLE', 'ELLIPSE', 'LINE', 'POLYGON', 'STAR', 'TEXT'];
export const NODE_TYPES: readonly NodeType[] = ['PAGE', ...LAYER_TYPES];
/** Types that may have children. */
export const CONTAINER_TYPES: readonly NodeType[] = ['PAGE', 'FRAME', 'GROUP'];

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export interface SolidPaint {
  type: 'SOLID';
  color: RGB;
  opacity: number;
  visible: boolean;
}

export interface GradientStop {
  /** 0 at the start of the gradient, 1 at its end. */
  position: number;
  color: RGB;
  opacity: number;
}

export type GradientType = 'GRADIENT_LINEAR' | 'GRADIENT_RADIAL' | 'GRADIENT_ANGULAR' | 'GRADIENT_DIAMOND';
export const GRADIENT_TYPES: readonly GradientType[] = ['GRADIENT_LINEAR', 'GRADIENT_RADIAL', 'GRADIENT_ANGULAR', 'GRADIENT_DIAMOND'];

/** A point in a layer's box: (0, 0) is its top-left corner and (1, 1) its bottom-right. */
export interface UnitPoint {
  x: number;
  y: number;
}

/**
 * A gradient. `from` and `to` are its two handles, in the layer's box:
 * a linear gradient runs from one to the other; for the other kinds `from`
 * is the centre and `to` sets the radius and the direction of the first stop.
 */
export interface GradientPaint {
  type: GradientType;
  /** At least two, sorted by position. */
  stops: GradientStop[];
  from: UnitPoint;
  to: UnitPoint;
  opacity: number;
  visible: boolean;
}

export type ImageScaleMode = 'FILL' | 'FIT' | 'CROP' | 'TILE';
export const IMAGE_SCALE_MODES: readonly ImageScaleMode[] = ['FILL', 'FIT', 'CROP', 'TILE'];

/**
 * An image used as a fill. The image itself is an asset stored outside the
 * document; the paint refers to it by the hash of its bytes.
 */
export interface ImagePaint {
  type: 'IMAGE';
  /** SHA-256 of the image file's bytes, in lowercase hex. A key of `Document.assets`. */
  imageHash: string;
  scaleMode: ImageScaleMode;
  /** For CROP: the part of the image that is shown, in the image's unit square. */
  crop: { x: number; y: number; width: number; height: number };
  /** For TILE: the size of one tile relative to the image's natural size. */
  tileScale: number;
  opacity: number;
  visible: boolean;
}

export type Paint = SolidPaint | GradientPaint | ImagePaint;

export function isGradient(paint: Paint): paint is GradientPaint {
  return paint.type !== 'SOLID' && paint.type !== 'IMAGE';
}

export function isImagePaint(paint: Paint): paint is ImagePaint {
  return paint.type === 'IMAGE';
}

/** What the document records about an image asset. The bytes live in asset storage, keyed by hash. */
export interface AssetInfo {
  mimeType: string;
  /** Natural size in pixels. */
  width: number;
  height: number;
  /** The file name it was imported from, for display. */
  name: string;
}

export type StrokeAlign = 'INSIDE' | 'CENTER' | 'OUTSIDE';
/** How the ends of open strokes and of dashes are drawn. NONE is a flat end at the endpoint. */
export type StrokeCap = 'NONE' | 'ROUND' | 'SQUARE';
export type StrokeJoin = 'MITER' | 'BEVEL' | 'ROUND';
export const STROKE_CAPS: readonly StrokeCap[] = ['NONE', 'ROUND', 'SQUARE'];
export const STROKE_JOINS: readonly StrokeJoin[] = ['MITER', 'BEVEL', 'ROUND'];

export type BlendMode =
  | 'NORMAL'
  | 'DARKEN'
  | 'MULTIPLY'
  | 'COLOR_BURN'
  | 'LIGHTEN'
  | 'SCREEN'
  | 'COLOR_DODGE'
  | 'OVERLAY'
  | 'SOFT_LIGHT'
  | 'HARD_LIGHT'
  | 'DIFFERENCE'
  | 'EXCLUSION'
  | 'HUE'
  | 'SATURATION'
  | 'COLOR'
  | 'LUMINOSITY';
export const BLEND_MODES: readonly BlendMode[] = [
  'NORMAL',
  'DARKEN',
  'MULTIPLY',
  'COLOR_BURN',
  'LIGHTEN',
  'SCREEN',
  'COLOR_DODGE',
  'OVERLAY',
  'SOFT_LIGHT',
  'HARD_LIGHT',
  'DIFFERENCE',
  'EXCLUSION',
  'HUE',
  'SATURATION',
  'COLOR',
  'LUMINOSITY',
];

/** A shadow cast outside the layer (drop) or inside its outline (inner). Offsets are in the layer's own axes. */
export interface ShadowEffect {
  type: 'DROP_SHADOW' | 'INNER_SHADOW';
  color: RGB;
  opacity: number;
  offsetX: number;
  offsetY: number;
  blur: number;
  /** Grows (positive) or shrinks the shadow's shape before it is blurred. */
  spread: number;
  visible: boolean;
}

/** Blurs the layer itself (layer blur) or whatever is behind it, inside its outline (background blur). */
export interface BlurEffect {
  type: 'LAYER_BLUR' | 'BACKGROUND_BLUR';
  radius: number;
  visible: boolean;
}

export type Effect = ShadowEffect | BlurEffect;
export type EffectType = Effect['type'];
export const EFFECT_TYPES: readonly EffectType[] = ['DROP_SHADOW', 'INNER_SHADOW', 'LAYER_BLUR', 'BACKGROUND_BLUR'];

export function isShadow(effect: Effect): effect is ShadowEffect {
  return effect.type === 'DROP_SHADOW' || effect.type === 'INNER_SHADOW';
}

/**
 * What a layer does along one axis when the frame it is in changes size:
 * keep its distance to the near edge (MIN: left or top), to the far edge
 * (MAX: right or bottom), to the centre, to both edges by stretching, or
 * keep its position and size as a proportion of the frame.
 */
export type ConstraintType = 'MIN' | 'CENTER' | 'MAX' | 'STRETCH' | 'SCALE';
export const CONSTRAINT_TYPES: readonly ConstraintType[] = ['MIN', 'CENTER', 'MAX', 'STRETCH', 'SCALE'];

export interface Constraints {
  horizontal: ConstraintType;
  vertical: ConstraintType;
}

export type LayoutGridPattern = 'GRID' | 'COLUMNS' | 'ROWS';
export type LayoutGridAlignment = 'MIN' | 'CENTER' | 'MAX' | 'STRETCH';
export const LAYOUT_GRID_PATTERNS: readonly LayoutGridPattern[] = ['GRID', 'COLUMNS', 'ROWS'];
export const LAYOUT_GRID_ALIGNMENTS: readonly LayoutGridAlignment[] = ['MIN', 'CENTER', 'MAX', 'STRETCH'];

/** A guide grid shown over a frame while designing. It is not part of the design and is never exported. */
export interface LayoutGrid {
  pattern: LayoutGridPattern;
  /** GRID: the size of each square cell. */
  size: number;
  /** COLUMNS and ROWS: how many. */
  count: number;
  /** COLUMNS and ROWS: the space between them. */
  gutter: number;
  /** COLUMNS and ROWS: the margin at both ends (STRETCH) or the offset from the aligned edge (MIN, MAX). */
  offset: number;
  alignment: LayoutGridAlignment;
  /** COLUMNS and ROWS that do not stretch: the width of each column or height of each row. */
  sectionSize: number;
  color: RGB;
  opacity: number;
  visible: boolean;
}

/** Corner radii in the order top-left, top-right, bottom-right, bottom-left. */
export type CornerRadii = [number, number, number, number];

interface NodeBase {
  id: NodeId;
  type: NodeType;
  name: string;
  /** `null` only for pages. */
  parentId: NodeId | null;
  /** Fractional index among siblings. Ascending is bottom-to-top for layers. */
  order: string;
}

/** A ruler guide: a vertical line at an x position ('X') or a horizontal line at a y position ('Y'), in page space. */
export interface Guide {
  axis: 'X' | 'Y';
  position: number;
}

export interface PageNode extends NodeBase {
  type: 'PAGE';
  parentId: null;
  backgroundColor: RGB;
  /** Ruler guides. Like layout grids they help while designing and are never exported. */
  guides: Guide[];
}

interface LayerBase extends NodeBase {
  type: LayerType;
  parentId: NodeId;
  visible: boolean;
  locked: boolean;
  /** Unrotated box in the parent's coordinate space. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Degrees, clockwise on screen, about the box centre. */
  rotation: number;
  opacity: number;
  fills: Paint[];
  strokes: Paint[];
  strokeWeight: number;
  strokeAlign: StrokeAlign;
  strokeCap: StrokeCap;
  strokeJoin: StrokeJoin;
  /** Alternating dash and gap lengths. Empty for a solid stroke. */
  dashPattern: number[];
  /** Applied in order; the first is the bottom-most. */
  effects: Effect[];
  /** How the layer, with everything in it, is mixed with what is beneath it. */
  blendMode: BlendMode;
  /** How the layer responds when the frame it is directly inside is resized. */
  constraints: Constraints;
}

export interface FrameNode extends LayerBase {
  type: 'FRAME';
  clipsContent: boolean;
  cornerRadius: number;
  /** One radius per corner; when null, `cornerRadius` applies to all four. */
  cornerRadii: CornerRadii | null;
  layoutGrids: LayoutGrid[];
}

/**
 * A group has no appearance of its own. Its box is always the bounding box of
 * its children and is kept that way automatically (see `normalizeGroups`).
 */
export interface GroupNode extends LayerBase {
  type: 'GROUP';
}

export interface RectangleNode extends LayerBase {
  type: 'RECTANGLE';
  cornerRadius: number;
  /** One radius per corner; when null, `cornerRadius` applies to all four. */
  cornerRadii: CornerRadii | null;
}

export interface EllipseNode extends LayerBase {
  type: 'ELLIPSE';
}

export interface LineNode extends LayerBase {
  type: 'LINE';
}

export interface PolygonNode extends LayerBase {
  type: 'POLYGON';
  pointCount: number;
}

export interface StarNode extends LayerBase {
  type: 'STAR';
  pointCount: number;
  /** Inner radius as a fraction of the outer radius, 0..1. */
  innerRadius: number;
}

export type TextAlign = 'LEFT' | 'CENTER' | 'RIGHT';
export type VerticalAlign = 'TOP' | 'MIDDLE' | 'BOTTOM';
/** Which of the layer's dimensions follow its content: both, the height only, or neither. */
export type TextAutoResize = 'WIDTH_AND_HEIGHT' | 'HEIGHT' | 'NONE';
export type TextDecoration = 'NONE' | 'UNDERLINE' | 'STRIKETHROUGH';
export type TextCase = 'ORIGINAL' | 'UPPER' | 'LOWER' | 'TITLE';

export const TEXT_ALIGNS: readonly TextAlign[] = ['LEFT', 'CENTER', 'RIGHT'];
export const VERTICAL_ALIGNS: readonly VerticalAlign[] = ['TOP', 'MIDDLE', 'BOTTOM'];
export const TEXT_AUTO_RESIZES: readonly TextAutoResize[] = ['WIDTH_AND_HEIGHT', 'HEIGHT', 'NONE'];
export const TEXT_DECORATIONS: readonly TextDecoration[] = ['NONE', 'UNDERLINE', 'STRIKETHROUGH'];
export const TEXT_CASES: readonly TextCase[] = ['ORIGINAL', 'UPPER', 'LOWER', 'TITLE'];

/**
 * A text layer. One style applies to the whole layer; per-range styling is not
 * part of this version. Its fills colour the glyphs.
 */
export interface TextNode extends LayerBase {
  type: 'TEXT';
  characters: string;
  fontFamily: string;
  fontSize: number;
  /** 100..900 in steps of 100. */
  fontWeight: number;
  italic: boolean;
  /** Line height in pixels, or null for automatic (1.2 × the font size). */
  lineHeight: number | null;
  /** Extra space between characters, in pixels. */
  letterSpacing: number;
  textAlign: TextAlign;
  verticalAlign: VerticalAlign;
  textAutoResize: TextAutoResize;
  textDecoration: TextDecoration;
  textCase: TextCase;
}

export type LayerNode = FrameNode | GroupNode | RectangleNode | EllipseNode | LineNode | PolygonNode | StarNode | TextNode;
export type DesignNode = PageNode | LayerNode;

export type NodeMap = Readonly<Record<NodeId, DesignNode>>;

export interface Document {
  id: string;
  name: string;
  nodes: NodeMap;
  /** Image assets used by this document, by hash. Entries are only ever added. */
  assets: Readonly<Record<string, AssetInfo>>;
}

export interface FileMeta {
  createdAt: string;
  updatedAt: string;
}

/** The native file container, as stored on disk and in local storage. */
export interface OpenDesignFile {
  format: typeof FILE_FORMAT;
  schemaVersion: number;
  meta: FileMeta;
  document: Document;
  /**
   * Only in files exported to disk: the bytes of every asset the document
   * uses, base64-encoded, by hash, so that the file is complete on its own.
   * Local storage keeps assets separately and never sets this.
   */
  assetData?: Record<string, string>;
}

export function isPage(node: DesignNode | undefined): node is PageNode {
  return node !== undefined && node.type === 'PAGE';
}

export function isLayer(node: DesignNode | undefined): node is LayerNode {
  return node !== undefined && node.type !== 'PAGE';
}

export function isFrame(node: DesignNode | undefined): node is FrameNode {
  return node !== undefined && node.type === 'FRAME';
}

export function isGroup(node: DesignNode | undefined): node is GroupNode {
  return node !== undefined && node.type === 'GROUP';
}

export function isText(node: DesignNode | undefined): node is TextNode {
  return node !== undefined && node.type === 'TEXT';
}

export function isContainer(node: DesignNode | undefined): node is PageNode | FrameNode | GroupNode {
  return node !== undefined && (node.type === 'PAGE' || node.type === 'FRAME' || node.type === 'GROUP');
}

export function hasCornerRadius(node: DesignNode | undefined): node is FrameNode | RectangleNode {
  return node !== undefined && (node.type === 'FRAME' || node.type === 'RECTANGLE');
}

/** A partial update for a layer. Type-specific keys only make sense on the matching node types. */
export type LayerPatch = Partial<Omit<LayerBase, 'id' | 'type'>> & {
  clipsContent?: boolean;
  cornerRadius?: number;
  cornerRadii?: CornerRadii | null;
  layoutGrids?: LayoutGrid[];
  pointCount?: number;
  innerRadius?: number;
} & Partial<Omit<TextNode, keyof LayerBase>>;

export type PagePatch = Partial<Pick<PageNode, 'name' | 'order' | 'backgroundColor' | 'guides'>>;

export type NodePatch = LayerPatch | PagePatch;
