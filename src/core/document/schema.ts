/**
 * OPEN DESIGN document schema, version 3.
 * Version 2 added the GROUP layer type; version 3 adds TEXT.
 * The prose description of this file is DOCUMENT_SCHEMA.md; keep the two in step.
 */

export const CURRENT_SCHEMA_VERSION = 3;
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

export type Paint = SolidPaint;

export type StrokeAlign = 'INSIDE' | 'CENTER' | 'OUTSIDE';

interface NodeBase {
  id: NodeId;
  type: NodeType;
  name: string;
  /** `null` only for pages. */
  parentId: NodeId | null;
  /** Fractional index among siblings. Ascending is bottom-to-top for layers. */
  order: string;
}

export interface PageNode extends NodeBase {
  type: 'PAGE';
  parentId: null;
  backgroundColor: RGB;
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
}

export interface FrameNode extends LayerBase {
  type: 'FRAME';
  clipsContent: boolean;
  cornerRadius: number;
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
  pointCount?: number;
  innerRadius?: number;
} & Partial<Omit<TextNode, keyof LayerBase>>;

export type PagePatch = Partial<Pick<PageNode, 'name' | 'order' | 'backgroundColor'>>;

export type NodePatch = LayerPatch | PagePatch;
