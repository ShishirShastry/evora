/**
 * OPEN DESIGN document schema, version 1.
 * The prose description of this file is DOCUMENT_SCHEMA.md; keep the two in step.
 */

export const CURRENT_SCHEMA_VERSION = 1;
export const FILE_FORMAT = 'open-design';
export const FILE_EXTENSION = '.opendesign';

export type NodeId = string;

export type LayerType = 'FRAME' | 'RECTANGLE' | 'ELLIPSE' | 'LINE' | 'POLYGON' | 'STAR';
export type NodeType = 'PAGE' | LayerType;

export const LAYER_TYPES: readonly LayerType[] = ['FRAME', 'RECTANGLE', 'ELLIPSE', 'LINE', 'POLYGON', 'STAR'];
export const NODE_TYPES: readonly NodeType[] = ['PAGE', ...LAYER_TYPES];
/** Types that may have children. */
export const CONTAINER_TYPES: readonly NodeType[] = ['PAGE', 'FRAME'];

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

export type LayerNode = FrameNode | RectangleNode | EllipseNode | LineNode | PolygonNode | StarNode;
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

export function isContainer(node: DesignNode | undefined): node is PageNode | FrameNode {
  return node !== undefined && (node.type === 'PAGE' || node.type === 'FRAME');
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
};

export type PagePatch = Partial<Pick<PageNode, 'name' | 'order' | 'backgroundColor'>>;

export type NodePatch = LayerPatch | PagePatch;
