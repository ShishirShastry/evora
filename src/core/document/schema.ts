/**
 * OPEN DESIGN document schema, version 23 (adds export settings and what developers are handed; version 22: prototyping; version 21: libraries; version 20: styles and variables; version 19: adds component sets, variants and component properties; version 18
 * added components and instances; version 17: columns of an Auto Layout frame can wrap as rows can; version 16
 * added stretching children across an Auto Layout frame; version 15 added Auto Layout itself: frames that lay out their children, and how each layer is sized and placed in one; version 14 added mirrored text and image fills, and guides on frames;
 * version 13 added justified text, lists and styles on parts of a text layer;
 * version 12 added image adjustments, version 11 boolean groups, version 10 masks; version 9 added arcs on ellipses and arrowheads on lines and vectors;
 * version 8 added the VECTOR layer type, version 7 ruler guides on pages).
 * Version 2 added the GROUP layer type, version 3 TEXT, version 4 gradient
 * paints, stroke caps/joins/dashes, per-corner radii, effects and blend
 * modes, and version 5 image paints with the document's asset table.
 * The prose description of this file is DOCUMENT_SCHEMA.md; keep the two in step.
 */

export const CURRENT_SCHEMA_VERSION = 23;
export const FILE_FORMAT = 'open-design';
export const FILE_EXTENSION = '.opendesign';

export type NodeId = string;

export type LayerType = 'FRAME' | 'GROUP' | 'RECTANGLE' | 'ELLIPSE' | 'LINE' | 'POLYGON' | 'STAR' | 'TEXT' | 'VECTOR' | 'BOOLEAN_OPERATION';
export type NodeType = 'PAGE' | LayerType;

export const LAYER_TYPES: readonly LayerType[] = ['FRAME', 'GROUP', 'RECTANGLE', 'ELLIPSE', 'LINE', 'POLYGON', 'STAR', 'TEXT', 'VECTOR', 'BOOLEAN_OPERATION'];
export const NODE_TYPES: readonly NodeType[] = ['PAGE', ...LAYER_TYPES];
/** Types that may have children. */
export const CONTAINER_TYPES: readonly NodeType[] = ['PAGE', 'FRAME', 'GROUP', 'BOOLEAN_OPERATION'];

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
  /**
   * Adjustments made to the image as it is drawn, each from -1 to 1, where 0
   * leaves it as it is: darker or lighter, flatter or more contrasty, greyer
   * or more colourful. The image file itself is never changed.
   */
  exposure: number;
  contrast: number;
  saturation: number;
  /** The picture is drawn mirrored, left to right or top to bottom, inside the layer's box. Flipping the layer sets these. */
  flipX: boolean;
  flipY: boolean;
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

/** Whether a frame places its children itself (Auto Layout), and if so in a row or in a column. */
export type LayoutMode = 'NONE' | 'HORIZONTAL' | 'VERTICAL';
export const LAYOUT_MODES: readonly LayoutMode[] = ['NONE', 'HORIZONTAL', 'VERTICAL'];

/**
 * Whether the children of a layout carry on in a new line when they no
 * longer fit: a row in a further row beneath it, a column (from version 17)
 * in a further column beside it.
 */
export type LayoutWrap = 'NO_WRAP' | 'WRAP';
export const LAYOUT_WRAPS: readonly LayoutWrap[] = ['NO_WRAP', 'WRAP'];

/** Where children sit along the direction of the layout: at its start, middle or end, or spread out from end to end. */
export type PrimaryAxisAlign = 'MIN' | 'CENTER' | 'MAX' | 'SPACE_BETWEEN';
export const PRIMARY_AXIS_ALIGNS: readonly PrimaryAxisAlign[] = ['MIN', 'CENTER', 'MAX', 'SPACE_BETWEEN'];

/**
 * Where children sit across the direction of the layout: at its start, middle
 * or end, or (STRETCH, from version 16) made as big across it as the frame
 * has room, whatever their own sizing across says.
 */
export type CounterAxisAlign = 'MIN' | 'CENTER' | 'MAX' | 'STRETCH';
export const COUNTER_AXIS_ALIGNS: readonly CounterAxisAlign[] = ['MIN', 'CENTER', 'MAX', 'STRETCH'];

/** How the lines of a wrapping row are spaced: by the frame's line spacing, or spread out from top to bottom. */
export type CounterAxisAlignContent = 'AUTO' | 'SPACE_BETWEEN';
export const COUNTER_AXIS_ALIGN_CONTENTS: readonly CounterAxisAlignContent[] = ['AUTO', 'SPACE_BETWEEN'];

/**
 * What decides a layer's size along one axis: the size it was given, what is
 * in it ("hug": frames that lay out their children, and text), or the room
 * left in the Auto Layout frame it is in ("fill").
 */
export type LayoutSizing = 'FIXED' | 'HUG' | 'FILL';
export const LAYOUT_SIZINGS: readonly LayoutSizing[] = ['FIXED', 'HUG', 'FILL'];

/** Whether an Auto Layout frame places a child (AUTO), or leaves it where it was put (ABSOLUTE). */
export type LayoutPositioning = 'AUTO' | 'ABSOLUTE';
export const LAYOUT_POSITIONINGS: readonly LayoutPositioning[] = ['AUTO', 'ABSOLUTE'];

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

/**
 * A ruler guide: a vertical line at an x position ('X') or a horizontal line
 * at a y position ('Y'). A page's guides are in page space; a frame's are in
 * the frame's own space, and are lines across the frame only.
 */
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
  /** The mode chosen for this page of each variable collection that has one chosen. */
  variableModes: Readonly<Record<string, string>>;
  /**
   * Set on a page that holds what was imported from a library: its
   * components, which instances in this document show. Such a page is not
   * among the document's pages: it is never shown, listed or exported.
   */
  library: LibraryRef | null;
  /** The flows of the prototype on this page: its starting frames, by name. */
  flows: Flow[];
  /** The screen the prototype of this page is shown on. */
  prototypeDevice: PrototypeDevice;
  /** The ways this page is exported as a whole. */
  exportSettings: ExportSetting[];
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
  /**
   * A mask is not painted itself. Instead the layers above it in the same
   * parent, up to the next mask, show only where it would have painted, as
   * strongly as it would have painted there.
   */
  isMask: boolean;
  /**
   * What decides the layer's width and height. HUG applies to frames that lay
   * out their children and to text; FILL to a layer placed by an Auto Layout
   * frame. A setting that cannot apply where the layer is, is turned into
   * FIXED by the editor (see `settleSizing`).
   */
  layoutSizingHorizontal: LayoutSizing;
  layoutSizingVertical: LayoutSizing;
  /** ABSOLUTE takes the layer out of the flow of the Auto Layout frame it is in: it stays where it is put. */
  layoutPositioning: LayoutPositioning;
  /**
   * Limits on the size Auto Layout gives the layer, or null for none. They
   * apply to frames that lay out their children and to the layers such a
   * frame places.
   */
  minWidth: number | null;
  maxWidth: number | null;
  minHeight: number | null;
  maxHeight: number | null;
  /**
   * For a layer inside an instance: the layer of the component that it
   * mirrors. Null for every layer a designer made. Such a layer is kept in
   * step with the one it mirrors (see `syncInstances`).
   */
  sourceId: NodeId | null;
  /**
   * For a layer inside a component: the component properties that decide
   * something about it in each instance. Each names a property by its ID.
   */
  propRefs: PropRefs;
  /** The styles this layer takes its paints, type settings, effects or layout grids from, by style ID. */
  styleRefs: StyleRefs;
  /** The variables that properties of this layer are bound to: a property ("width", "fills.0" for the first fill's colour) to a variable ID. */
  boundVariables: Readonly<Record<string, string>>;
  /** The mode chosen here, for this layer and everything in it, of each variable collection that has one chosen. */
  variableModes: Readonly<Record<string, string>>;
  /** The interactions on this layer in a prototype. */
  reactions: Reaction[];
  /** What this layer does when the frame it is in scrolls in a prototype. */
  scrollBehavior: ScrollBehavior;
  /** The ways this layer is exported. */
  exportSettings: ExportSetting[];
  /** Where it stands in being handed to developers. */
  devStatus: DevStatus;
  /** Notes on it for developers. */
  annotations: Annotation[];
  /** Links that go with it. */
  devResources: DevResource[];
  /** How it is known in code, when it is a component that is. */
  codeConnect: CodeConnect | null;
}

// ------------------------------------------------------- export and handoff

export type ExportFormat = 'PNG' | 'JPG' | 'SVG' | 'PDF';
export const EXPORT_FORMATS: readonly ExportFormat[] = ['PNG', 'JPG', 'SVG', 'PDF'];

/**
 * One way a layer or a page is exported: a format, a size, and a suffix for
 * the file's name. A layer may have several (the same picture at 1x, 2x and
 * 3x, say). Every setting has every field; the format says which count.
 */
export interface ExportSetting {
  format: ExportFormat;
  /** How big: a scale of the design's size, or a width or height in pixels that the other side follows. */
  constraint: { type: 'SCALE' | 'WIDTH' | 'HEIGHT'; value: number };
  /** Added to the layer's name to make the file's name: "@2x". */
  suffix: string;
  /** Paint the page's background behind what is exported. Without it PNG, SVG and PDF are transparent; a JPG is on white. */
  background: boolean;
  /** JPG: how much is kept, from 0.1 to 1. */
  quality: number;
  /** SVG: give each layer's element an `id` made from its name. */
  svgIds: boolean;
  /** PDF: shapes as vectors, or the whole thing as one picture (which keeps shadows and blurs). */
  pdfContent: 'VECTOR' | 'PICTURE';
  /** Vector PDF: text as text in the nearest standard font (it can be selected), or as pictures of the text (it looks exactly as designed). */
  pdfText: 'TEXT' | 'PICTURE';
}

/** Where a layer stands in being handed to developers. */
export type DevStatus = 'NONE' | 'READY' | 'COMPLETED';
export const DEV_STATUSES: readonly DevStatus[] = ['NONE', 'READY', 'COMPLETED'];

/** A note on a layer for whoever builds it. */
export interface Annotation {
  id: string;
  text: string;
}

/** A link that goes with a layer: its documentation, its ticket, its source file. */
export interface DevResource {
  id: string;
  name: string;
  url: string;
}

/**
 * How a component is known in code: its name there, where it is imported
 * from, and a snippet that uses it, in which `{Name}` stands for the value
 * an instance has for the variant or component property of that name.
 */
export interface CodeConnect {
  component: string;
  source: string;
  snippet: string;
}

// ---------------------------------------------------------------- prototyping

/** What sets an interaction off. */
export type TriggerType = 'ON_CLICK' | 'ON_DRAG' | 'MOUSE_ENTER' | 'ON_PRESS' | 'AFTER_DELAY' | 'ON_KEY';
export const TRIGGER_TYPES: readonly TriggerType[] = ['ON_CLICK', 'ON_DRAG', 'MOUSE_ENTER', 'ON_PRESS', 'AFTER_DELAY', 'ON_KEY'];

export interface Trigger {
  type: TriggerType;
  /** AFTER_DELAY: how long after the screen is shown, in milliseconds. */
  delay: number;
  /** ON_KEY: the key, as the keyboard names it ("Enter", "ArrowRight", "a"). */
  key: string;
}

export type TransitionType = 'INSTANT' | 'DISSOLVE' | 'SMART_ANIMATE' | 'MOVE_IN' | 'MOVE_OUT' | 'PUSH' | 'SLIDE_IN' | 'SLIDE_OUT';
export const TRANSITION_TYPES: readonly TransitionType[] = ['INSTANT', 'DISSOLVE', 'SMART_ANIMATE', 'MOVE_IN', 'MOVE_OUT', 'PUSH', 'SLIDE_IN', 'SLIDE_OUT'];
/** The way things move in a transition. */
export type TransitionDirection = 'LEFT' | 'RIGHT' | 'TOP' | 'BOTTOM';
export const TRANSITION_DIRECTIONS: readonly TransitionDirection[] = ['LEFT', 'RIGHT', 'TOP', 'BOTTOM'];
export type EasingType = 'LINEAR' | 'EASE_IN' | 'EASE_OUT' | 'EASE_IN_OUT' | 'CUSTOM';
export const EASING_TYPES: readonly EasingType[] = ['LINEAR', 'EASE_IN', 'EASE_OUT', 'EASE_IN_OUT', 'CUSTOM'];

export interface Transition {
  type: TransitionType;
  direction: TransitionDirection;
  /** Milliseconds. */
  duration: number;
  /** Milliseconds before it starts. */
  delay: number;
  easing: EasingType;
  /** CUSTOM: the two control points of a cubic Bézier curve, as in CSS. */
  bezier: [number, number, number, number];
}

export type ActionType = 'NAVIGATE' | 'OPEN_OVERLAY' | 'SWAP_OVERLAY' | 'CLOSE_OVERLAY' | 'SCROLL_TO' | 'BACK' | 'CHANGE_TO' | 'SET_VARIABLE' | 'CONDITIONAL' | 'INPUT';
export const ACTION_TYPES: readonly ActionType[] = ['NAVIGATE', 'OPEN_OVERLAY', 'SWAP_OVERLAY', 'CLOSE_OVERLAY', 'SCROLL_TO', 'BACK', 'CHANGE_TO', 'SET_VARIABLE', 'CONDITIONAL', 'INPUT'];

/**
 * One thing an interaction does. Every action has every field; which ones
 * count depends on its type: a destination (a frame to go to or open, a
 * layer to scroll to, a variant to change to), a transition, a variable
 * with the expression for its new value (or, for INPUT, the variable that
 * typing goes into), or a condition (`expression`) with the actions for
 * when it holds (`then`) and when it does not (`otherwise`).
 */
export interface Action {
  type: ActionType;
  destinationId: NodeId | null;
  transition: Transition;
  variableId: string | null;
  expression: string;
  then: Action[];
  otherwise: Action[];
}

/** An interaction on a layer: when the trigger happens, the actions run in order. */
export interface Reaction {
  id: string;
  trigger: Trigger;
  actions: Action[];
}

/** A named way through a prototype, from the frame it starts on. */
export interface Flow {
  id: string;
  name: string;
  startId: NodeId;
}

/** Which way the content of a frame scrolls in a prototype when there is more of it than fits. */
export type Overflow = 'NONE' | 'HORIZONTAL' | 'VERTICAL' | 'BOTH';
export const OVERFLOWS: readonly Overflow[] = ['NONE', 'HORIZONTAL', 'VERTICAL', 'BOTH'];
/** What a layer does when the frame it is in scrolls: go with the content, stay where it is, or stop at the top. */
export type ScrollBehavior = 'SCROLLS' | 'FIXED' | 'STICKY';
export const SCROLL_BEHAVIORS: readonly ScrollBehavior[] = ['SCROLLS', 'FIXED', 'STICKY'];
/** Where a frame sits when it is opened as an overlay. */
export type OverlayPosition = 'CENTER' | 'TOP_LEFT' | 'TOP_CENTER' | 'TOP_RIGHT' | 'BOTTOM_LEFT' | 'BOTTOM_CENTER' | 'BOTTOM_RIGHT';
export const OVERLAY_POSITIONS: readonly OverlayPosition[] = ['CENTER', 'TOP_LEFT', 'TOP_CENTER', 'TOP_RIGHT', 'BOTTOM_LEFT', 'BOTTOM_CENTER', 'BOTTOM_RIGHT'];
/** The screen a prototype is shown on. NONE: as big as the frame. */
export type PrototypeDevice = 'NONE' | 'PHONE' | 'TABLET' | 'DESKTOP';
export const PROTOTYPE_DEVICES: readonly PrototypeDevice[] = ['NONE', 'PHONE', 'TABLET', 'DESKTOP'];

export type StyleType = 'PAINT' | 'TEXT' | 'EFFECT' | 'GRID';
export const STYLE_TYPES: readonly StyleType[] = ['PAINT', 'TEXT', 'EFFECT', 'GRID'];

/** What a text style sets on a text layer. */
export interface TextStyleValues {
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  italic: boolean;
  lineHeight: number | null;
  letterSpacing: number;
  textDecoration: TextDecoration;
  textCase: TextCase;
}

/**
 * A named look that layers can share: paints (for fills or strokes), type
 * settings, effects or layout grids. Only the part that goes with its type
 * is used.
 */
export interface Style {
  id: string;
  name: string;
  description: string;
  type: StyleType;
  paints: Paint[];
  text: TextStyleValues;
  effects: Effect[];
  grids: LayoutGrid[];
  /** The library (a document ID) this style was imported from; null for a style of this document. */
  remote: string | null;
}

/** Which style a layer uses for what. */
export interface StyleRefs {
  fills?: string;
  strokes?: string;
  text?: string;
  effects?: string;
  grids?: string;
}

export type VariableType = 'COLOR' | 'FLOAT' | 'STRING' | 'BOOLEAN';
export const VARIABLE_TYPES: readonly VariableType[] = ['COLOR', 'FLOAT', 'STRING', 'BOOLEAN'];

/** A value of a variable in one mode: a colour, number, string or switch, or another variable that it stands for. */
export type VariableValue = RGB | number | string | boolean | { alias: string };

/** A named value that properties of layers can be bound to, with a value for each mode of its collection. */
export interface Variable {
  id: string;
  name: string;
  description: string;
  collectionId: string;
  type: VariableType;
  /** The kinds of property it is offered for. Empty for all. */
  scopes: string[];
  valuesByMode: Readonly<Record<string, VariableValue>>;
  /** The library this variable was imported from; null for a variable of this document. */
  remote: string | null;
}

/** A group of variables that share modes: "Light" and "Dark", say. The first mode is the one that applies where none is chosen. */
export interface VariableCollection {
  id: string;
  name: string;
  modes: { id: string; name: string }[];
  /** The library this collection was imported from; null for a collection of this document. */
  remote: string | null;
}

/** Which library a page holds, and which published version of it. */
export interface LibraryRef {
  /** The ID of the library's document. */
  id: string;
  name: string;
  version: number;
}

/**
 * What a document offers other documents as a library: its components, with
 * the components they use, and its styles and variables, as they were when
 * it was last published. Changes made since then reach nobody until it is
 * published again.
 */
export interface Publication {
  /** Counts up with every publishing. */
  version: number;
  publishedAt: string;
  /** The components and component sets, by ID. Their `parentId` is empty. */
  roots: NodeId[];
  /** Those and every layer in them, except the layers instances hold as mirrors. */
  nodes: Readonly<Record<NodeId, LayerNode>>;
  styles: Readonly<Record<string, Style>>;
  variables: Readonly<Record<string, Variable>>;
  variableCollections: Readonly<Record<string, VariableCollection>>;
  /** The image assets those use. */
  assets: Readonly<Record<string, AssetInfo>>;
}

/** What a component property can decide about a layer: whether it shows, what a text says, which component an instance shows. */
export interface PropRefs {
  visible?: string;
  characters?: string;
  componentId?: string;
}

export type ComponentPropType = 'BOOLEAN' | 'TEXT' | 'INSTANCE_SWAP';
export const COMPONENT_PROP_TYPES: readonly ComponentPropType[] = ['BOOLEAN', 'TEXT', 'INSTANCE_SWAP'];

/**
 * A property of a component that every instance can set for itself: a
 * switch, a text or a component. What it starts as in an instance is what
 * the layers it is bound to have in the component.
 */
export interface ComponentProp {
  id: string;
  name: string;
  type: ComponentPropType;
}

/**
 * What a frame is, as far as components go: an ordinary frame, the original
 * of a component, or an instance that shows a component somewhere else.
 */
export type FrameKind = 'FRAME' | 'COMPONENT' | 'COMPONENT_SET' | 'INSTANCE';
export const FRAME_KINDS: readonly FrameKind[] = ['FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE'];

/**
 * What differs in an instance from its component: for a layer of the
 * component (by its ID; the component's own ID stands for the instance
 * itself), the properties that have another value here.
 */
export type InstanceOverrides = Readonly<Record<NodeId, Readonly<Record<string, unknown>>>>;

export interface FrameNode extends LayerBase {
  type: 'FRAME';
  /** Whether this frame is a component, an instance of one, or neither. */
  kind: FrameKind;
  /** A component's description, shown where it is chosen. */
  description: string;
  /** An instance's component. Null for anything that is not an instance. */
  componentId: NodeId | null;
  /** An instance's overrides. Empty for anything that is not an instance. */
  overrides: InstanceOverrides;
  /** The properties of a component, or of a component set, where they are shared by all its variants. */
  componentProps: ComponentProp[];
  /** For a component in a component set: which variant it is, as a value for each of the set's variant properties. */
  variantProps: Readonly<Record<string, string>>;
  /** An instance's values for its component's properties, by property ID. A property not named here is as the component has it. */
  propValues: Readonly<Record<string, boolean | string>>;
  clipsContent: boolean;
  /** Which way the frame's content scrolls in a prototype. */
  overflow: Overflow;
  /** When the frame is opened as an overlay: where it sits, */
  overlayPosition: OverlayPosition;
  /** whether a click outside it closes it, */
  overlayCloseOutside: boolean;
  /** and what covers the screen behind it, if anything. */
  overlayBackground: { color: RGB; opacity: number } | null;
  cornerRadius: number;
  /** One radius per corner; when null, `cornerRadius` applies to all four. */
  cornerRadii: CornerRadii | null;
  layoutGrids: LayoutGrid[];
  /** Ruler guides of this frame, at positions in its own space. They move with it and are never exported. */
  guides: Guide[];
  /** Auto Layout: NONE leaves the children where they are; otherwise the frame places them in a row or a column. */
  layoutMode: LayoutMode;
  /** Whether the layout carries on in new lines: further rows under a row, further columns beside a column. */
  layoutWrap: LayoutWrap;
  primaryAxisAlignItems: PrimaryAxisAlign;
  counterAxisAlignItems: CounterAxisAlign;
  counterAxisAlignContent: CounterAxisAlignContent;
  /** The space between neighbouring children along the direction of the layout. May be negative, which overlaps them. */
  itemSpacing: number;
  /** The space between the lines of a layout that wraps: between its rows, or between its columns. */
  counterAxisSpacing: number;
  /** The space kept free between each edge of the frame and its children. */
  paddingLeft: number;
  paddingRight: number;
  paddingTop: number;
  paddingBottom: number;
  /** Lays the children out from the top of the stack to the bottom, instead of from the bottom to the top. */
  itemsReversed: boolean;
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

/**
 * An ellipse, or part of one. The angles are in degrees, clockwise on screen
 * from three o'clock. A sweep of less than 360 leaves a slice; a ratio above
 * zero cuts a hole of that proportion out of the middle, which makes a ring,
 * or with a sweep a piece of one. The layer's box is always the whole ellipse's.
 */
export interface EllipseNode extends LayerBase {
  type: 'ELLIPSE';
  /** Where the arc starts. */
  arcStart: number;
  /** How far round it goes, 1..360. 360 is the whole ellipse. */
  arcSweep: number;
  /** The inner radius as a fraction of the outer one, 0..0.99. */
  arcRatio: number;
}

/** What is drawn at a loose end of a stroke. */
export type ArrowType = 'NONE' | 'LINE' | 'TRIANGLE' | 'CIRCLE' | 'DIAMOND';
export const ARROW_TYPES: readonly ArrowType[] = ['NONE', 'LINE', 'TRIANGLE', 'CIRCLE', 'DIAMOND'];

export interface LineNode extends LayerBase {
  type: 'LINE';
  /** The arrowhead at the line's left end (its start) and at its right end, before rotation. */
  startArrow: ArrowType;
  endArrow: ArrowType;
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

export type TextAlign = 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED';
export type VerticalAlign = 'TOP' | 'MIDDLE' | 'BOTTOM';
/** Which of the layer's dimensions follow its content: both, the height only, or neither. */
export type TextAutoResize = 'WIDTH_AND_HEIGHT' | 'HEIGHT' | 'NONE';
export type TextDecoration = 'NONE' | 'UNDERLINE' | 'STRIKETHROUGH';
export type TextCase = 'ORIGINAL' | 'UPPER' | 'LOWER' | 'TITLE';
/** Whether the paragraphs of a text layer are the items of a list, and what stands in front of each. */
export type TextListType = 'NONE' | 'BULLETED' | 'NUMBERED';

export const TEXT_ALIGNS: readonly TextAlign[] = ['LEFT', 'CENTER', 'RIGHT', 'JUSTIFIED'];
export const TEXT_LIST_TYPES: readonly TextListType[] = ['NONE', 'BULLETED', 'NUMBERED'];
export const VERTICAL_ALIGNS: readonly VerticalAlign[] = ['TOP', 'MIDDLE', 'BOTTOM'];
export const TEXT_AUTO_RESIZES: readonly TextAutoResize[] = ['WIDTH_AND_HEIGHT', 'HEIGHT', 'NONE'];
export const TEXT_DECORATIONS: readonly TextDecoration[] = ['NONE', 'UNDERLINE', 'STRIKETHROUGH'];
export const TEXT_CASES: readonly TextCase[] = ['ORIGINAL', 'UPPER', 'LOWER', 'TITLE'];

/**
 * What part of a text layer can have that differs from the rest of it. A key
 * that is absent means "as the layer has it".
 */
export interface TextRangeStyle {
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: number;
  italic?: boolean;
  letterSpacing?: number;
  textDecoration?: TextDecoration;
  /** A solid colour for the glyphs, in place of the layer's fills. */
  color?: RGB;
}

/**
 * A stretch of a text layer's characters with a style of its own, from
 * `start` up to but not including `end`, counted as string indices are
 * (UTF-16 code units).
 */
export interface TextStyleRange extends TextRangeStyle {
  start: number;
  end: number;
}

/**
 * A text layer. Its font properties are the style of all of its text, except
 * where a range in `styleRanges` changes some of them. Its fills colour the
 * glyphs that have no colour of their own.
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
  /** The glyphs are drawn mirrored, left to right or top to bottom, inside the layer's box. Flipping the layer sets these. */
  flipX: boolean;
  flipY: boolean;
  /** A list makes every paragraph an item, with a bullet or its number in front and its lines set in. */
  listType: TextListType;
  /**
   * The parts of the text that differ from the layer's own style: in order,
   * not overlapping, not empty, inside the text, each changing something,
   * and no two neighbours alike.
   */
  styleRanges: TextStyleRange[];
}

/** A point of a vector layer, in the layer's own space: (0, 0) is the top-left corner of its box. */
export interface VectorVertex {
  x: number;
  y: number;
}

/**
 * A curve between two points of a vector layer. The tangents are its Bézier
 * control handles, each given relative to its own end point; when both are
 * zero the segment is a straight line.
 */
export interface VectorSegment {
  /** Indices into the network's `vertices`. */
  start: number;
  end: number;
  tangentStart: { x: number; y: number };
  tangentEnd: { x: number; y: number };
}

/**
 * Points and the curves between them. A point may have any number of
 * segments, so a network can branch and share edges, which a path cannot.
 */
export interface VectorNetwork {
  vertices: VectorVertex[];
  segments: VectorSegment[];
}

/** Which overlapping regions a fill covers: everything enclosed, or every other nesting level (which makes holes). */
export type WindingRule = 'NONZERO' | 'EVENODD';
export const WINDING_RULES: readonly WindingRule[] = ['NONZERO', 'EVENODD'];

/**
 * A freely drawn shape. Its box is always the bounding box of its curves and
 * is kept that way automatically (see `fitVectors`).
 */
export interface VectorNode extends LayerBase {
  type: 'VECTOR';
  network: VectorNetwork;
  windingRule: WindingRule;
  /** The arrowheads at the loose ends of its open paths: where each was started, and where it ended. */
  startArrow: ArrowType;
  endArrow: ArrowType;
}

/** How a boolean group combines the shapes in it. */
export type BooleanOperation = 'UNION' | 'SUBTRACT' | 'INTERSECT' | 'EXCLUDE';
export const BOOLEAN_OPERATIONS: readonly BooleanOperation[] = ['UNION', 'SUBTRACT', 'INTERSECT', 'EXCLUDE'];

/**
 * A boolean group shows the result of combining the shapes it holds: their
 * union, the bottom-most with the others taken out of it, what they all
 * share, or what an odd number of them cover. The shapes stay in it as its
 * children and can still be moved and edited; they are not painted
 * themselves. `network` is that result, in the group's own space, and the
 * group's box is the result's bounding box; both are kept up to date
 * automatically (see `refreshBoolean`) and are never edited directly.
 */
export interface BooleanOperationNode extends LayerBase {
  type: 'BOOLEAN_OPERATION';
  operation: BooleanOperation;
  network: VectorNetwork;
}

export type LayerNode =
  | FrameNode
  | GroupNode
  | RectangleNode
  | EllipseNode
  | LineNode
  | PolygonNode
  | StarNode
  | TextNode
  | VectorNode
  | BooleanOperationNode;
export type DesignNode = PageNode | LayerNode;

export type NodeMap = Readonly<Record<NodeId, DesignNode>>;

export interface Document {
  id: string;
  name: string;
  nodes: NodeMap;
  /** Image assets used by this document, by hash. Entries are only ever added. */
  assets: Readonly<Record<string, AssetInfo>>;
  /** The document's styles, by ID. */
  styles: Readonly<Record<string, Style>>;
  /** The document's variables, by ID. */
  variables: Readonly<Record<string, Variable>>;
  /** The collections the variables are in, by ID. */
  variableCollections: Readonly<Record<string, VariableCollection>>;
  /** What this document has published as a library, or null when it has not been published. */
  publication: Publication | null;
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

export function isVector(node: DesignNode | undefined): node is VectorNode {
  return node !== undefined && node.type === 'VECTOR';
}

export function isBoolean(node: DesignNode | undefined): node is BooleanOperationNode {
  return node !== undefined && node.type === 'BOOLEAN_OPERATION';
}

/** Groups and boolean groups: containers whose box follows what is in them, and whose children move with them. */
export function isGroupLike(node: DesignNode | undefined): node is GroupNode | BooleanOperationNode {
  return node !== undefined && (node.type === 'GROUP' || node.type === 'BOOLEAN_OPERATION');
}

export function isContainer(node: DesignNode | undefined): node is PageNode | FrameNode | GroupNode | BooleanOperationNode {
  return node !== undefined && (node.type === 'PAGE' || node.type === 'FRAME' || node.type === 'GROUP' || node.type === 'BOOLEAN_OPERATION');
}

export function hasCornerRadius(node: DesignNode | undefined): node is FrameNode | RectangleNode {
  return node !== undefined && (node.type === 'FRAME' || node.type === 'RECTANGLE');
}

/** A partial update for a layer. Type-specific keys only make sense on the matching node types. */
export type LayerPatch = Partial<Omit<LayerBase, 'id' | 'type'>> & {
  clipsContent?: boolean;
  overflow?: Overflow;
  overlayPosition?: OverlayPosition;
  overlayCloseOutside?: boolean;
  overlayBackground?: { color: RGB; opacity: number } | null;
  cornerRadius?: number;
  cornerRadii?: CornerRadii | null;
  layoutGrids?: LayoutGrid[];
  guides?: Guide[];
  kind?: FrameKind;
  description?: string;
  componentId?: NodeId | null;
  overrides?: InstanceOverrides;
  componentProps?: ComponentProp[];
  variantProps?: Readonly<Record<string, string>>;
  propValues?: Readonly<Record<string, boolean | string>>;
  layoutMode?: LayoutMode;
  layoutWrap?: LayoutWrap;
  primaryAxisAlignItems?: PrimaryAxisAlign;
  counterAxisAlignItems?: CounterAxisAlign;
  counterAxisAlignContent?: CounterAxisAlignContent;
  itemSpacing?: number;
  counterAxisSpacing?: number;
  paddingLeft?: number;
  paddingRight?: number;
  paddingTop?: number;
  paddingBottom?: number;
  itemsReversed?: boolean;
  pointCount?: number;
  innerRadius?: number;
  network?: VectorNetwork;
  windingRule?: WindingRule;
  operation?: BooleanOperation;
  arcStart?: number;
  arcSweep?: number;
  arcRatio?: number;
  startArrow?: ArrowType;
  endArrow?: ArrowType;
} & Partial<Omit<TextNode, keyof LayerBase>>;

export type PagePatch = Partial<Pick<PageNode, 'name' | 'order' | 'backgroundColor' | 'guides' | 'variableModes' | 'flows' | 'prototypeDevice' | 'exportSettings'>>;

export type NodePatch = LayerPatch | PagePatch;
