import { createId } from '../ids';
import { fitVectorNode } from '../vector/fit';
import { freshKeys } from '../order';
import { createLayer, createPage, DEFAULT_PAGE_BACKGROUND, textLayoutSizing } from './factory';
import {
  ARROW_TYPES,
  BLEND_MODES,
  BOOLEAN_OPERATIONS,
  CONSTRAINT_TYPES,
  CONTAINER_TYPES,
  LAYOUT_GRID_ALIGNMENTS,
  LAYOUT_GRID_PATTERNS,
  LAYOUT_MODES,
  LAYOUT_POSITIONINGS,
  LAYOUT_SIZINGS,
  LAYOUT_WRAPS,
  PRIMARY_AXIS_ALIGNS,
  COUNTER_AXIS_ALIGNS,
  COUNTER_AXIS_ALIGN_CONTENTS,
  FRAME_KINDS,
  COMPONENT_PROP_TYPES,
  STYLE_TYPES,
  VARIABLE_TYPES,
  type ComponentProp,
  ACTION_TYPES,
  DEV_STATUSES,
  EASING_TYPES,
  EXPORT_FORMATS,
  type Annotation,
  type DevResource,
  type ExportSetting,
  OVERFLOWS,
  OVERLAY_POSITIONS,
  PROTOTYPE_DEVICES,
  SCROLL_BEHAVIORS,
  TRANSITION_DIRECTIONS,
  TRANSITION_TYPES,
  TRIGGER_TYPES,
  normalizeKeyCombo,
  type Action,
  type Flow,
  type LibraryRef,
  type Publication,
  type Reaction,
  type Transition,
  type Style,
  type StyleRefs,
  type Variable,
  type VariableCollection,
  type VariableValue,
  GRADIENT_TYPES,
  IMAGE_SCALE_MODES,
  LAYER_TYPES,
  STROKE_CAPS,
  STROKE_JOINS,
  TEXT_ALIGNS,
  TEXT_AUTO_RESIZES,
  TEXT_CASES,
  TEXT_DECORATIONS,
  TEXT_LIST_TYPES,
  VERTICAL_ALIGNS,
  WINDING_RULES,
  type AssetInfo,
  type CornerRadii,
  type DesignNode,
  type Document,
  type Effect,
  type GradientStop,
  type GradientType,
  type Guide,
  type LayerNode,
  type LayerType,
  type LayoutGrid,
  type NodeId,
  type PageNode,
  type Paint,
  type RGB,
  type StrokeAlign,
  type TextStyleRange,
  type VectorNetwork,
  type VectorSegment,
  type JsonValue,
  type WidgetData,
} from './schema';

type Raw = Record<string, unknown>;

/** Imported late in the file's own order only to keep the schema imports together. */
import { normalizeRanges } from '../text/ranges';

export interface RepairResult {
  doc: Document;
  /** Human-readable descriptions of everything that had to be fixed. Empty when the input was valid. */
  repairs: string[];
}

function isObject(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finite(value: unknown, fallback: number, min = -Infinity, max = Infinity): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function rgb(value: unknown, fallback: RGB): RGB {
  if (!isObject(value)) return { ...fallback };
  return { r: finite(value.r, fallback.r, 0, 1), g: finite(value.g, fallback.g, 0, 1), b: finite(value.b, fallback.b, 0, 1) };
}

const BLACK_RGB: RGB = { r: 0, g: 0, b: 0 };

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/**
 * The styled ranges of a text layer. A value that is not what it should be
 * is left out, so that part of the text falls back to the layer's own style;
 * the ranges are then put into their one stored form.
 */
function styleRanges(value: unknown, length: number): TextStyleRange[] {
  const ranges: TextStyleRange[] = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!isObject(item)) continue;
      const number = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
      if (!number(item.start) || !number(item.end)) continue;
      const range: TextStyleRange = { start: item.start, end: item.end };
      if (typeof item.fontFamily === 'string' && item.fontFamily.trim()) range.fontFamily = item.fontFamily;
      if (number(item.fontSize)) range.fontSize = finite(item.fontSize, 12, 1, 2000);
      if (number(item.fontWeight)) range.fontWeight = Math.round(finite(item.fontWeight, 400, 100, 900) / 100) * 100;
      if (typeof item.italic === 'boolean') range.italic = item.italic;
      if (number(item.letterSpacing)) range.letterSpacing = finite(item.letterSpacing, 0, -200, 2000);
      if (TEXT_DECORATIONS.includes(item.textDecoration as (typeof TEXT_DECORATIONS)[number])) range.textDecoration = item.textDecoration as TextStyleRange['textDecoration'];
      if (isObject(item.color)) range.color = rgb(item.color, BLACK_RGB);
      ranges.push(range);
    }
  }
  return normalizeRanges(ranges, length);
}

function unitPoint(value: unknown, fallback: { x: number; y: number }): { x: number; y: number } {
  if (!isObject(value)) return { ...fallback };
  return { x: finite(value.x, fallback.x, -100, 100), y: finite(value.y, fallback.y, -100, 100) };
}

function gradientStops(value: unknown): GradientStop[] {
  const stops: GradientStop[] = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!isObject(item)) continue;
      stops.push({
        position: finite(item.position, 0, 0, 1),
        color: rgb(item.color, BLACK_RGB),
        opacity: finite(item.opacity, 1, 0, 1),
      });
    }
  }
  // A gradient needs two stops to be a gradient.
  while (stops.length < 2) stops.push({ position: stops.length === 0 ? 0 : 1, color: { ...BLACK_RGB }, opacity: 1 });
  // Stable sort: stops at the same position keep their order.
  return stops.map((stop, index) => ({ stop, index })).sort((a, b) => a.stop.position - b.stop.position || a.index - b.index).map((entry) => entry.stop);
}

function paints(value: unknown): Paint[] {
  if (!Array.isArray(value)) return [];
  const out: Paint[] = [];
  for (const item of value) {
    if (!isObject(item)) continue;
    const opacity = finite(item.opacity, 1, 0, 1);
    const visible = item.visible !== false;
    if (item.type === 'SOLID') {
      out.push({ type: 'SOLID', color: rgb(item.color, BLACK_RGB), opacity, visible });
    } else if ((GRADIENT_TYPES as readonly unknown[]).includes(item.type)) {
      out.push({
        type: item.type as GradientType,
        stops: gradientStops(item.stops),
        from: unitPoint(item.from, { x: 0.5, y: 0 }),
        to: unitPoint(item.to, { x: 0.5, y: 1 }),
        opacity,
        visible,
      });
    } else if (item.type === 'IMAGE' && typeof item.imageHash === 'string' && HASH.test(item.imageHash)) {
      const crop = isObject(item.crop) ? item.crop : {};
      const x = finite(crop.x, 0, 0, 1);
      const y = finite(crop.y, 0, 0, 1);
      out.push({
        type: 'IMAGE',
        imageHash: item.imageHash,
        scaleMode: oneOf(item.scaleMode, IMAGE_SCALE_MODES, 'FILL'),
        // The crop must stay inside the image and keep some area.
        crop: { x, y, width: finite(crop.width, 1, 0.001, 1 - x || 0.001), height: finite(crop.height, 1, 0.001, 1 - y || 0.001) },
        tileScale: finite(item.tileScale, 1, 0.01, 100),
        exposure: finite(item.exposure, 0, -1, 1),
        contrast: finite(item.contrast, 0, -1, 1),
        saturation: finite(item.saturation, 0, -1, 1),
        flipX: item.flipX === true,
        flipY: item.flipY === true,
        opacity,
        visible,
      });
    }
    // Paints of a kind this version does not know are dropped.
  }
  return out;
}

const HASH = /^[0-9a-f]{64}$/;

/** The asset table: entries with a malformed hash or missing details are dropped. */
function assets(value: unknown): Record<string, AssetInfo> {
  const out: Record<string, AssetInfo> = {};
  if (!isObject(value)) return out;
  for (const hash in value) {
    const item = value[hash];
    if (!HASH.test(hash) || !isObject(item) || typeof item.mimeType !== 'string') continue;
    out[hash] = {
      mimeType: item.mimeType,
      width: finite(item.width, 1, 1, 100000),
      height: finite(item.height, 1, 1, 100000),
      name: typeof item.name === 'string' ? item.name : 'Image',
    };
  }
  return out;
}

function effects(value: unknown): Effect[] {
  if (!Array.isArray(value)) return [];
  const out: Effect[] = [];
  for (const item of value) {
    if (!isObject(item)) continue;
    const visible = item.visible !== false;
    if (item.type === 'DROP_SHADOW' || item.type === 'INNER_SHADOW') {
      out.push({
        type: item.type,
        color: rgb(item.color, BLACK_RGB),
        opacity: finite(item.opacity, 0.25, 0, 1),
        offsetX: finite(item.offsetX, 0, -10000, 10000),
        offsetY: finite(item.offsetY, 0, -10000, 10000),
        blur: finite(item.blur, 0, 0, 1000),
        spread: finite(item.spread, 0, -1000, 1000),
        visible,
      });
    } else if (item.type === 'LAYER_BLUR' || item.type === 'BACKGROUND_BLUR') {
      out.push({ type: item.type, radius: finite(item.radius, 0, 0, 1000), visible });
    }
  }
  return out;
}

function dashes(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const out = value.map((item) => finite(item, 0, 0, 10000));
  // A pattern of nothing but zeros would draw nothing at all.
  return out.some((length) => length > 0) ? out : [];
}

function layoutGrids(value: unknown): LayoutGrid[] {
  if (!Array.isArray(value)) return [];
  const out: LayoutGrid[] = [];
  for (const item of value) {
    if (!isObject(item) || !(LAYOUT_GRID_PATTERNS as readonly unknown[]).includes(item.pattern)) continue;
    out.push({
      pattern: item.pattern as LayoutGrid['pattern'],
      size: finite(item.size, 10, 1, 10000),
      count: Math.round(finite(item.count, 5, 1, 200)),
      gutter: finite(item.gutter, 20, 0, 10000),
      offset: finite(item.offset, 0, -10000, 10000),
      alignment: oneOf(item.alignment, LAYOUT_GRID_ALIGNMENTS, 'STRETCH'),
      sectionSize: finite(item.sectionSize, 100, 0, 100000),
      color: rgb(item.color, { r: 1, g: 0, b: 0 }),
      opacity: finite(item.opacity, 0.1, 0, 1),
      visible: item.visible !== false,
    });
  }
  return out;
}

function guides(value: unknown): Guide[] {
  if (!Array.isArray(value)) return [];
  const out: Guide[] = [];
  for (const item of value) {
    if (!isObject(item) || (item.axis !== 'X' && item.axis !== 'Y')) continue;
    if (typeof item.position !== 'number' || !Number.isFinite(item.position)) continue;
    out.push({ axis: item.axis, position: item.position });
  }
  return out;
}

function networkPoint(value: unknown): { x: number; y: number } {
  if (!isObject(value)) return { x: 0, y: 0 };
  return { x: finite(value.x, 0, -1e7, 1e7), y: finite(value.y, 0, -1e7, 1e7) };
}

/** A vector network: points with finite coordinates, and only segments whose ends exist. */
function vectorNetwork(value: unknown): VectorNetwork {
  const source = isObject(value) ? value : {};
  const vertices = Array.isArray(source.vertices) ? source.vertices.map(networkPoint) : [];
  const segments: VectorSegment[] = [];
  const index = (item: unknown): number | null =>
    typeof item === 'number' && Number.isInteger(item) && item >= 0 && item < vertices.length ? item : null;
  if (Array.isArray(source.segments)) {
    for (const item of source.segments) {
      if (!isObject(item)) continue;
      const start = index(item.start);
      const end = index(item.end);
      if (start === null || end === null) continue;
      segments.push({ start, end, tangentStart: networkPoint(item.tangentStart), tangentEnd: networkPoint(item.tangentEnd) });
    }
  }
  return { vertices, segments };
}

/** Which component properties a layer is bound to: names of properties, as strings. */
function propRefs(value: unknown): { visible?: string; characters?: string; componentId?: string } {
  const out: { visible?: string; characters?: string; componentId?: string } = {};
  if (!isObject(value)) return out;
  for (const key of ['visible', 'characters', 'componentId'] as const) {
    const ref = value[key];
    if (typeof ref === 'string' && ref) out[key] = ref;
  }
  return out;
}

/** The ways something is exported: each of a known format, with a size that is a positive number. */
function exportSettings(value: unknown): ExportSetting[] {
  const out: ExportSetting[] = [];
  if (!Array.isArray(value)) return out;
  for (const item of value) {
    if (!isObject(item) || !(EXPORT_FORMATS as readonly unknown[]).includes(item.format)) continue;
    const constraint = isObject(item.constraint) ? item.constraint : {};
    const type = oneOf(constraint.type, ['SCALE', 'WIDTH', 'HEIGHT'] as const, 'SCALE');
    out.push({
      format: item.format as ExportSetting['format'],
      constraint: { type, value: type === 'SCALE' ? finite(constraint.value, 1, 0.01, 64) : Math.round(finite(constraint.value, 100, 1, 32768)) },
      suffix: typeof item.suffix === 'string' ? item.suffix : '',
      background: item.background === true,
      quality: finite(item.quality, 0.9, 0.1, 1),
      svgIds: item.svgIds === true,
      pdfContent: oneOf(item.pdfContent, ['VECTOR', 'PICTURE'] as const, 'VECTOR'),
      pdfText: oneOf(item.pdfText, ['TEXT', 'PICTURE'] as const, 'TEXT'),
    });
  }
  return out;
}

/** Notes for developers: each needs an ID. */
function notes(value: unknown): Annotation[] {
  const out: Annotation[] = [];
  if (!Array.isArray(value)) return out;
  const seen = new Set<string>();
  for (const item of value) {
    if (!isObject(item) || typeof item.id !== 'string' || !item.id || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push({ id: item.id, text: typeof item.text === 'string' ? item.text : '' });
  }
  return out;
}

/** Links for developers: each needs an ID. */
function devResources(value: unknown): DevResource[] {
  const out: DevResource[] = [];
  if (!Array.isArray(value)) return out;
  const seen = new Set<string>();
  for (const item of value) {
    if (!isObject(item) || typeof item.id !== 'string' || !item.id || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push({ id: item.id, name: typeof item.name === 'string' ? item.name : '', url: typeof item.url === 'string' ? item.url : '' });
  }
  return out;
}

/** A transition: a known kind, direction and easing, times that are not negative, and four numbers for a curve. */
function transition(value: unknown): Transition {
  const raw = isObject(value) ? value : {};
  const curve = Array.isArray(raw.bezier) && raw.bezier.length === 4 ? raw.bezier : [0.42, 0, 0.58, 1];
  return {
    type: oneOf(raw.type, TRANSITION_TYPES, 'INSTANT'),
    direction: oneOf(raw.direction, TRANSITION_DIRECTIONS, 'LEFT'),
    duration: finite(raw.duration, 300, 0, 10000),
    delay: finite(raw.delay, 0, 0, 10000),
    easing: oneOf(raw.easing, EASING_TYPES, 'EASE_OUT'),
    bezier: [finite(curve[0], 0.42, 0, 1), finite(curve[1], 0, -2, 3), finite(curve[2], 0.58, 0, 1), finite(curve[3], 1, -2, 3)],
  };
}

/** The actions of an interaction. One of an unknown type is left out; conditions nest only so deep. */
function actions(value: unknown, depth = 0): Action[] {
  const out: Action[] = [];
  if (!Array.isArray(value) || depth > 4) return out;
  for (const item of value) {
    if (!isObject(item) || !(ACTION_TYPES as readonly unknown[]).includes(item.type)) continue;
    out.push({
      type: item.type as Action['type'],
      destinationId: typeof item.destinationId === 'string' && item.destinationId ? item.destinationId : null,
      transition: transition(item.transition),
      variableId: typeof item.variableId === 'string' && item.variableId ? item.variableId : null,
      expression: typeof item.expression === 'string' ? item.expression : '',
      then: actions(item.then, depth + 1),
      otherwise: actions(item.otherwise, depth + 1),
    });
  }
  return out;
}

/** The interactions on a layer: each needs an ID and a known trigger. */
function reactions(value: unknown): Reaction[] {
  const out: Reaction[] = [];
  if (!Array.isArray(value)) return out;
  const seen = new Set<string>();
  for (const item of value) {
    if (!isObject(item) || typeof item.id !== 'string' || !item.id || seen.has(item.id)) continue;
    const trigger = isObject(item.trigger) ? item.trigger : {};
    if (!(TRIGGER_TYPES as readonly unknown[]).includes(trigger.type)) continue;
    seen.add(item.id);
    out.push({
      id: item.id,
      trigger: { type: trigger.type as Reaction['trigger']['type'], delay: finite(trigger.delay, 800, 0, 600000), key: typeof trigger.key === 'string' ? normalizeKeyCombo(trigger.key) : '' },
      actions: actions(item.actions),
    });
  }
  return out;
}

/** The flows of a page: each needs an ID and a frame to start on. */
function flows(value: unknown): Flow[] {
  const out: Flow[] = [];
  if (!Array.isArray(value)) return out;
  const seen = new Set<string>();
  for (const item of value) {
    if (!isObject(item) || typeof item.id !== 'string' || !item.id || seen.has(item.id) || typeof item.startId !== 'string' || !item.startId) continue;
    seen.add(item.id);
    out.push({ id: item.id, name: typeof item.name === 'string' && item.name ? item.name : 'Flow', startId: item.startId });
  }
  return out;
}

/** The library a page holds: it needs the library's ID. */
function libraryRef(value: unknown): LibraryRef | null {
  if (!isObject(value) || typeof value.id !== 'string' || !value.id) return null;
  return { id: value.id, name: typeof value.name === 'string' && value.name ? value.name : 'Library', version: Math.round(finite(value.version, 1, 1, 1e9)) };
}

const remoteOf = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

/**
 * What the document has published. Its parts are kept as they are: they are
 * checked like a document's own when another document imports them.
 */
function publication(value: unknown): Publication | null {
  if (!isObject(value) || typeof value.version !== 'number' || !Number.isFinite(value.version)) return null;
  const record = (part: unknown): Record<string, never> => (isObject(part) ? (part as Record<string, never>) : {});
  return {
    version: value.version,
    publishedAt: typeof value.publishedAt === 'string' ? value.publishedAt : '',
    roots: Array.isArray(value.roots) ? value.roots.filter((id): id is string => typeof id === 'string') : [],
    nodes: record(value.nodes),
    styles: record(value.styles),
    variables: record(value.variables),
    variableCollections: record(value.variableCollections),
    assets: record(value.assets),
  };
}

/** Which styles a layer uses: IDs, as strings, for the kinds of style there are. */
function styleRefs(value: unknown): StyleRefs {
  const out: StyleRefs = {};
  if (!isObject(value)) return out;
  for (const key of ['fills', 'strokes', 'text', 'effects', 'grids'] as const) {
    const ref = value[key];
    if (typeof ref === 'string' && ref) out[key] = ref;
  }
  return out;
}

/** The table of styles: an entry needs a known type; the parts a style has are checked like a layer's. */
function styles(value: unknown): Record<string, Style> {
  const out: Record<string, Style> = {};
  if (!isObject(value)) return out;
  for (const id in value) {
    const item = value[id];
    if (!isObject(item) || !(STYLE_TYPES as readonly unknown[]).includes(item.type)) continue;
    const text = isObject(item.text) ? item.text : {};
    out[id] = {
      id,
      name: typeof item.name === 'string' && item.name ? item.name : 'Style',
      description: typeof item.description === 'string' ? item.description : '',
      type: item.type as Style['type'],
      paints: paints(item.paints),
      text: {
        fontFamily: typeof text.fontFamily === 'string' && text.fontFamily.trim() ? text.fontFamily : 'Inter',
        fontSize: finite(text.fontSize, 16, 1, 2000),
        fontWeight: Math.round(finite(text.fontWeight, 400, 100, 900) / 100) * 100,
        italic: text.italic === true,
        lineHeight: text.lineHeight === null || text.lineHeight === undefined ? null : finite(text.lineHeight, 19, 1, 10000),
        letterSpacing: finite(text.letterSpacing, 0, -200, 2000),
        textDecoration: oneOf(text.textDecoration, TEXT_DECORATIONS, 'NONE'),
        textCase: oneOf(text.textCase, TEXT_CASES, 'ORIGINAL'),
        // Optional: a style made before version 25, or by a part of the application that does not set it, has none.
        ...(text.paragraphSpacing !== undefined ? { paragraphSpacing: finite(text.paragraphSpacing, 0, 0, 10000) } : {}),
      },
      effects: effects(item.effects),
      grids: layoutGrids(item.grids),
      remote: remoteOf(item.remote),
    };
  }
  return out;
}

/** The table of variable collections: each needs at least one mode. */
function variableCollections(value: unknown): Record<string, VariableCollection> {
  const out: Record<string, VariableCollection> = {};
  if (!isObject(value)) return out;
  for (const id in value) {
    const item = value[id];
    if (!isObject(item)) continue;
    const modes: VariableCollection['modes'] = [];
    const seen = new Set<string>();
    for (const mode of Array.isArray(item.modes) ? item.modes : []) {
      if (!isObject(mode) || typeof mode.id !== 'string' || !mode.id || seen.has(mode.id)) continue;
      seen.add(mode.id);
      modes.push({ id: mode.id, name: typeof mode.name === 'string' && mode.name ? mode.name : 'Mode' });
    }
    if (modes.length === 0) continue;
    out[id] = { id, name: typeof item.name === 'string' && item.name ? item.name : 'Collection', modes, remote: remoteOf(item.remote) };
  }
  return out;
}

/** The table of variables: each is in a collection that exists, and has values of its own type for that collection's modes. */
function variables(value: unknown, collections: Record<string, VariableCollection>): Record<string, Variable> {
  const out: Record<string, Variable> = {};
  if (!isObject(value)) return out;
  for (const id in value) {
    const item = value[id];
    if (!isObject(item) || !(VARIABLE_TYPES as readonly unknown[]).includes(item.type)) continue;
    const collection = typeof item.collectionId === 'string' ? collections[item.collectionId] : undefined;
    if (!collection) continue;
    const type = item.type as Variable['type'];
    const given = isObject(item.valuesByMode) ? item.valuesByMode : {};
    const valuesByMode: Record<string, VariableValue> = {};
    for (const mode of collection.modes) {
      const entry = given[mode.id];
      if (isObject(entry) && typeof entry.alias === 'string' && entry.alias) valuesByMode[mode.id] = { alias: entry.alias };
      else if (type === 'COLOR') valuesByMode[mode.id] = rgb(entry, BLACK_RGB);
      else if (type === 'FLOAT') valuesByMode[mode.id] = finite(entry, 0, -1e6, 1e6);
      else if (type === 'STRING') valuesByMode[mode.id] = typeof entry === 'string' ? entry : '';
      else valuesByMode[mode.id] = entry === true;
    }
    out[id] = {
      id,
      name: typeof item.name === 'string' && item.name ? item.name : 'Variable',
      description: typeof item.description === 'string' ? item.description : '',
      collectionId: collection.id,
      type,
      scopes: Array.isArray(item.scopes) ? item.scopes.filter((scope): scope is string => typeof scope === 'string') : [],
      valuesByMode,
      remote: remoteOf(item.remote),
    };
  }
  return out;
}

function componentProps(value: unknown): ComponentProp[] {
  const out: ComponentProp[] = [];
  if (!Array.isArray(value)) return out;
  const seen = new Set<string>();
  for (const item of value) {
    if (!isObject(item) || typeof item.id !== 'string' || !item.id || seen.has(item.id)) continue;
    if (!(COMPONENT_PROP_TYPES as readonly unknown[]).includes(item.type)) continue;
    seen.add(item.id);
    out.push({ id: item.id, name: typeof item.name === 'string' && item.name ? item.name : 'Property', type: item.type as ComponentProp['type'] });
  }
  return out;
}

function stringMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isObject(value)) return out;
  for (const key in value) if (typeof value[key] === 'string') out[key] = value[key] as string;
  return out;
}

function propValues(value: unknown): Record<string, boolean | string> {
  const out: Record<string, boolean | string> = {};
  if (!isObject(value)) return out;
  for (const key in value) {
    const item = value[key];
    if (typeof item === 'boolean' || typeof item === 'string') out[key] = item;
  }
  return out;
}

/** An instance's overrides: for each layer, an object of properties. Anything else is dropped. */
function overrides(value: unknown): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  if (!isObject(value)) return out;
  for (const id in value) {
    const props = value[id];
    if (isObject(props)) out[id] = props;
  }
  return out;
}

/** A minimum or maximum size: a number that is not negative, or null for no limit. */
function sizeLimit(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(1e6, Math.max(0, value)) : null;
}

function cornerRadii(value: unknown): CornerRadii | null {
  if (!Array.isArray(value) || value.length !== 4) return null;
  return value.map((item) => finite(item, 0, 0)) as CornerRadii;
}

const STROKE_ALIGNS: readonly StrokeAlign[] = ['INSIDE', 'CENTER', 'OUTSIDE'];

/** The largest widget state kept, as JSON text: a widget's state is for its settings and counts, not for content. */
export const MAX_WIDGET_STATE_LENGTH = 100_000;

/** A copy of a JSON value, or undefined when it is not one (a function, a cycle, a number that is not finite) or is too deep. */
export function jsonValue(value: unknown, depth = 0): JsonValue | undefined {
  if (depth > 32) return undefined;
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    const out: JsonValue[] = [];
    for (const item of value) {
      const copy = jsonValue(item, depth + 1);
      if (copy === undefined) return undefined;
      out.push(copy);
    }
    return out;
  }
  if (isObject(value)) {
    const out: { [key: string]: JsonValue } = {};
    for (const key in value) {
      const copy = jsonValue(value[key], depth + 1);
      if (copy === undefined) return undefined;
      out[key] = copy;
    }
    return out;
  }
  return undefined;
}

/** A frame's widget (schema 26): it needs a plugin and a widget; a state that is not JSON, or too large, is left empty. */
function widgetData(value: unknown): WidgetData | null {
  if (!isObject(value) || typeof value.pluginId !== 'string' || !value.pluginId || typeof value.widgetId !== 'string' || !value.widgetId) return null;
  let state = jsonValue(value.state);
  if (state === undefined || JSON.stringify(state).length > MAX_WIDGET_STATE_LENGTH) state = null;
  const handlers: Record<string, string> = {};
  if (isObject(value.handlers)) {
    for (const path in value.handlers) {
      const name = value.handlers[path];
      if (/^(\d+(\.\d+)*)?$/.test(path) && typeof name === 'string' && name) handlers[path] = name;
    }
  }
  return { pluginId: value.pluginId, widgetId: value.widgetId, state, version: Math.max(0, Math.round(finite(value.version, 0, 0, Number.MAX_SAFE_INTEGER))), handlers };
}

/**
 * Rebuilds one node from untrusted data (a plugin's change, say), the way
 * opening a file does: every valid field is kept, the rest defaulted or
 * clamped. Null when it is of no known type.
 */
export function repairNode(id: NodeId, raw: unknown): DesignNode | null {
  return isObject(raw) ? normalizeNode(id, raw) : null;
}

/** Rebuilds a node from raw data, keeping every valid field and defaulting or clamping the rest. */
function normalizeNode(id: NodeId, raw: Raw): DesignNode | null {
  const type = raw.type;
  const name = typeof raw.name === 'string' ? raw.name : '';
  const order = typeof raw.order === 'string' ? raw.order : '';

  if (type === 'PAGE') {
    const page: PageNode = {
      id,
      type: 'PAGE',
      name: name || 'Page',
      parentId: null,
      order,
      backgroundColor: rgb(raw.backgroundColor, DEFAULT_PAGE_BACKGROUND),
      guides: guides(raw.guides),
      variableModes: stringMap(raw.variableModes),
      library: libraryRef(raw.library),
      flows: flows(raw.flows),
      prototypeDevice: oneOf(raw.prototypeDevice, PROTOTYPE_DEVICES, 'NONE'),
      exportSettings: exportSettings(raw.exportSettings),
    };
    return page;
  }
  if (typeof type !== 'string' || !(LAYER_TYPES as readonly string[]).includes(type)) return null;

  const defaults = createLayer(type as LayerType, '', order);
  const layer = {
    ...defaults,
    id,
    name: name || defaults.name,
    parentId: typeof raw.parentId === 'string' ? raw.parentId : '',
    order,
    visible: raw.visible !== false,
    locked: raw.locked === true,
    x: finite(raw.x, 0),
    y: finite(raw.y, 0),
    width: finite(raw.width, defaults.width, 0),
    height: finite(raw.height, defaults.height, 0),
    rotation: finite(raw.rotation, 0, -360, 360),
    opacity: finite(raw.opacity, 1, 0, 1),
    fills: paints(raw.fills),
    strokes: paints(raw.strokes),
    strokeWeight: finite(raw.strokeWeight, 1, 0),
    strokeAlign: STROKE_ALIGNS.includes(raw.strokeAlign as StrokeAlign) ? (raw.strokeAlign as StrokeAlign) : defaults.strokeAlign,
    strokeCap: oneOf(raw.strokeCap, STROKE_CAPS, 'NONE'),
    strokeJoin: oneOf(raw.strokeJoin, STROKE_JOINS, 'MITER'),
    dashPattern: dashes(raw.dashPattern),
    effects: effects(raw.effects),
    blendMode: oneOf(raw.blendMode, BLEND_MODES, 'NORMAL'),
    constraints: {
      horizontal: oneOf(isObject(raw.constraints) ? raw.constraints.horizontal : undefined, CONSTRAINT_TYPES, 'MIN'),
      vertical: oneOf(isObject(raw.constraints) ? raw.constraints.vertical : undefined, CONSTRAINT_TYPES, 'MIN'),
    },
    isMask: raw.isMask === true,
    layoutSizingHorizontal: oneOf(raw.layoutSizingHorizontal, LAYOUT_SIZINGS, 'FIXED'),
    layoutSizingVertical: oneOf(raw.layoutSizingVertical, LAYOUT_SIZINGS, 'FIXED'),
    layoutPositioning: oneOf(raw.layoutPositioning, LAYOUT_POSITIONINGS, 'AUTO'),
    minWidth: sizeLimit(raw.minWidth),
    maxWidth: sizeLimit(raw.maxWidth),
    minHeight: sizeLimit(raw.minHeight),
    maxHeight: sizeLimit(raw.maxHeight),
    sourceId: typeof raw.sourceId === 'string' && raw.sourceId ? raw.sourceId : null,
    propRefs: propRefs(raw.propRefs),
    styleRefs: styleRefs(raw.styleRefs),
    boundVariables: stringMap(raw.boundVariables),
    variableModes: stringMap(raw.variableModes),
    strokeSides: isObject(raw.strokeSides) ? { top: finite(raw.strokeSides.top, 0, 0, 10000), right: finite(raw.strokeSides.right, 0, 0, 10000), bottom: finite(raw.strokeSides.bottom, 0, 0, 10000), left: finite(raw.strokeSides.left, 0, 0, 10000) } : null,
    reactions: reactions(raw.reactions),
    scrollBehavior: oneOf(raw.scrollBehavior, SCROLL_BEHAVIORS, 'SCROLLS'),
    exportSettings: exportSettings(raw.exportSettings),
    devStatus: oneOf(raw.devStatus, DEV_STATUSES, 'NONE'),
    annotations: notes(raw.annotations),
    devResources: devResources(raw.devResources),
    codeConnect: isObject(raw.codeConnect)
      ? { component: typeof raw.codeConnect.component === 'string' ? raw.codeConnect.component : '', source: typeof raw.codeConnect.source === 'string' ? raw.codeConnect.source : '', snippet: typeof raw.codeConnect.snippet === 'string' ? raw.codeConnect.snippet : '' }
      : null,
  } as LayerNode;

  if (layer.type === 'FRAME') {
    layer.clipsContent = raw.clipsContent !== false;
    layer.overflow = oneOf(raw.overflow, OVERFLOWS, 'NONE');
    layer.overlayPosition = oneOf(raw.overlayPosition, OVERLAY_POSITIONS, 'CENTER');
    layer.overlayCloseOutside = raw.overlayCloseOutside !== false;
    layer.overlayBackground = isObject(raw.overlayBackground) ? { color: rgb(raw.overlayBackground.color, BLACK_RGB), opacity: finite(raw.overlayBackground.opacity, 0.5, 0, 1) } : null;
    layer.cornerRadius = finite(raw.cornerRadius, 0, 0);
    layer.cornerRadii = cornerRadii(raw.cornerRadii);
    layer.layoutGrids = layoutGrids(raw.layoutGrids);
    layer.guides = guides(raw.guides);
    layer.kind = oneOf(raw.kind, FRAME_KINDS, 'FRAME');
    layer.description = typeof raw.description === 'string' ? raw.description : '';
    // Only an instance has a component and overrides.
    layer.componentId = layer.kind === 'INSTANCE' && typeof raw.componentId === 'string' && raw.componentId ? raw.componentId : null;
    layer.overrides = layer.kind === 'INSTANCE' ? overrides(raw.overrides) : {};
    layer.componentProps = componentProps(raw.componentProps);
    layer.variantProps = stringMap(raw.variantProps);
    layer.propValues = layer.kind === 'INSTANCE' ? propValues(raw.propValues) : {};
    layer.layoutMode = oneOf(raw.layoutMode, LAYOUT_MODES, 'NONE');
    layer.layoutWrap = oneOf(raw.layoutWrap, LAYOUT_WRAPS, 'NO_WRAP');
    layer.primaryAxisAlignItems = oneOf(raw.primaryAxisAlignItems, PRIMARY_AXIS_ALIGNS, 'MIN');
    layer.counterAxisAlignItems = oneOf(raw.counterAxisAlignItems, COUNTER_AXIS_ALIGNS, 'MIN');
    layer.counterAxisAlignContent = oneOf(raw.counterAxisAlignContent, COUNTER_AXIS_ALIGN_CONTENTS, 'AUTO');
    layer.itemSpacing = finite(raw.itemSpacing, 0, -10000, 10000);
    layer.counterAxisSpacing = finite(raw.counterAxisSpacing, 0, -10000, 10000);
    layer.paddingLeft = finite(raw.paddingLeft, 0, 0, 100000);
    layer.paddingRight = finite(raw.paddingRight, 0, 0, 100000);
    layer.paddingTop = finite(raw.paddingTop, 0, 0, 100000);
    layer.paddingBottom = finite(raw.paddingBottom, 0, 0, 100000);
    layer.itemsReversed = raw.itemsReversed === true;
    layer.widget = widgetData(raw.widget);
  } else if (layer.type === 'RECTANGLE') {
    layer.cornerRadius = finite(raw.cornerRadius, 0, 0);
    layer.cornerRadii = cornerRadii(raw.cornerRadii);
  } else if (layer.type === 'ELLIPSE') {
    layer.arcStart = finite(raw.arcStart, 0, -360, 360);
    layer.arcSweep = finite(raw.arcSweep, 360, 1, 360);
    layer.arcRatio = finite(raw.arcRatio, 0, 0, 0.99);
  } else if (layer.type === 'LINE') {
    layer.startArrow = oneOf(raw.startArrow, ARROW_TYPES, 'NONE');
    layer.endArrow = oneOf(raw.endArrow, ARROW_TYPES, 'NONE');
  } else if (layer.type === 'POLYGON') {
    layer.pointCount = Math.round(finite(raw.pointCount, 3, 3, 60));
  } else if (layer.type === 'STAR') {
    layer.pointCount = Math.round(finite(raw.pointCount, 5, 3, 60));
    layer.innerRadius = finite(raw.innerRadius, 0.382, 0, 1);
  } else if (layer.type === 'TEXT') {
    layer.characters = typeof raw.characters === 'string' ? raw.characters : '';
    layer.fontFamily = typeof raw.fontFamily === 'string' && raw.fontFamily.trim() ? raw.fontFamily : layer.fontFamily;
    layer.fontSize = finite(raw.fontSize, layer.fontSize, 1, 2000);
    layer.fontWeight = Math.round(finite(raw.fontWeight, 400, 100, 900) / 100) * 100;
    layer.italic = raw.italic === true;
    layer.lineHeight = raw.lineHeight === null || raw.lineHeight === undefined ? null : finite(raw.lineHeight, layer.fontSize * 1.2, 1, 10000);
    layer.letterSpacing = finite(raw.letterSpacing, 0, -200, 2000);
    layer.textAlign = oneOf(raw.textAlign, TEXT_ALIGNS, 'LEFT');
    layer.verticalAlign = oneOf(raw.verticalAlign, VERTICAL_ALIGNS, 'TOP');
    layer.textAutoResize = oneOf(raw.textAutoResize, TEXT_AUTO_RESIZES, 'WIDTH_AND_HEIGHT');
    layer.textDecoration = oneOf(raw.textDecoration, TEXT_DECORATIONS, 'NONE');
    layer.textCase = oneOf(raw.textCase, TEXT_CASES, 'ORIGINAL');
    layer.flipX = raw.flipX === true;
    layer.flipY = raw.flipY === true;
    layer.listType = oneOf(raw.listType, TEXT_LIST_TYPES, 'NONE');
    layer.paragraphSpacing = finite(raw.paragraphSpacing, 0, 0, 10000);
    layer.styleRanges = styleRanges(raw.styleRanges, layer.characters.length);
    // A text hugs exactly where its own sizing mode fits it to its content.
    Object.assign(layer, textLayoutSizing(layer));
  } else if (layer.type === 'VECTOR') {
    layer.network = vectorNetwork(raw.network);
    layer.windingRule = oneOf(raw.windingRule, WINDING_RULES, 'NONZERO');
    layer.startArrow = oneOf(raw.startArrow, ARROW_TYPES, 'NONE');
    layer.endArrow = oneOf(raw.endArrow, ARROW_TYPES, 'NONE');
    // The box of a vector is the bounding box of its curves.
    return fitVectorNode(layer);
  } else if (layer.type === 'BOOLEAN_OPERATION') {
    layer.operation = oneOf(raw.operation, BOOLEAN_OPERATIONS, 'UNION');
    layer.network = vectorNetwork(raw.network);
  }
  return layer;
}

/**
 * Validates untrusted document data against the schema and repairs it where
 * that can be done without guessing: the result always satisfies every
 * invariant listed in DOCUMENT_SCHEMA.md §7.
 */
export function repairDocument(input: unknown): RepairResult {
  const repairs: string[] = [];
  const source = isObject(input) ? input : {};
  if (!isObject(input)) repairs.push('The document was not an object; started from an empty document.');

  const id = typeof source.id === 'string' && source.id ? source.id : createId();
  const name = typeof source.name === 'string' && source.name ? source.name : 'Untitled';
  const rawNodes = isObject(source.nodes) ? source.nodes : {};
  const styleTable = styles(source.styles);
  const collectionTable = variableCollections(source.variableCollections);
  const variableTable = variables(source.variables, collectionTable);
  const tables: [string, unknown, unknown][] = [
    ['styles', styleTable, source.styles],
    ['variable collections', collectionTable, source.variableCollections],
    ['variables', variableTable, source.variables],
  ];
  for (const [what, checked, given] of tables) {
    if (JSON.stringify(checked) !== JSON.stringify(isObject(given) ? given : null)) repairs.push(`The document's ${what} were damaged and have been rebuilt.`);
  }
  const assetTable = assets(source.assets);
  if (JSON.stringify(assetTable) !== JSON.stringify(isObject(source.assets) ? source.assets : null)) {
    repairs.push('The list of image assets was damaged and has been rebuilt.');
  }

  const nodes: Record<NodeId, DesignNode> = {};
  let dropped = 0;
  for (const key in rawNodes) {
    const raw = rawNodes[key];
    const node = isObject(raw) ? normalizeNode(key, raw) : null;
    if (!node) {
      dropped++;
      continue;
    }
    if (isObject(raw) && raw.id !== key) repairs.push(`Layer "${node.name}" had a mismatched ID; re-keyed.`);
    nodes[key] = node;
  }
  if (dropped > 0) repairs.push(`${dropped} item(s) of an unknown type were removed.`);

  // Unchanged values must not be reported, so compare what normalisation altered.
  let adjusted = 0;
  for (const key in nodes) {
    const raw = rawNodes[key] as Raw;
    const node = nodes[key] as unknown as Raw;
    for (const prop in node) {
      if (prop === 'id' || prop === 'parentId' || prop === 'order') continue;
      if (JSON.stringify(node[prop]) !== JSON.stringify(raw[prop])) {
        adjusted++;
        break;
      }
    }
  }
  if (adjusted > 0) repairs.push(`${adjusted} layer(s) had missing or out-of-range values that were reset.`);

  // At least one page.
  // A page that holds a library's components does not count: there is one to design on.
  let pageIds = Object.keys(nodes).filter((key) => nodes[key]?.type === 'PAGE' && !(nodes[key] as PageNode).library);
  if (pageIds.length === 0) {
    const page = createPage('Page 1', freshKeys(1)[0] as string);
    nodes[page.id] = page;
    pageIds = [page.id];
    repairs.push('The document had no pages; an empty page was added.');
  }
  pageIds.sort((a, b) => {
    const na = nodes[a] as DesignNode;
    const nb = nodes[b] as DesignNode;
    return na.order < nb.order ? -1 : na.order > nb.order ? 1 : a < b ? -1 : 1;
  });
  const firstPage = pageIds[0] as NodeId;

  // Children of removed layers go with them; other bad parents are reattached.
  const droppedParents = new Set<NodeId>();
  for (const key in rawNodes) if (!nodes[key]) droppedParents.add(key);
  let removedWithParent = 0;
  let reattached = 0;
  const reachesPage = (startId: NodeId): 'ok' | 'dropped' | 'broken' => {
    const seen = new Set<NodeId>();
    let current: NodeId | null = startId;
    while (current !== null) {
      if (seen.has(current)) return 'broken';
      seen.add(current);
      const node: DesignNode | undefined = nodes[current];
      if (!node) return droppedParents.has(current) ? 'dropped' : 'broken';
      if (node.type === 'PAGE') return 'ok';
      const parent: DesignNode | undefined = nodes[node.parentId];
      if (parent && !CONTAINER_TYPES.includes(parent.type)) return 'broken';
      current = node.parentId;
    }
    return 'broken';
  };
  for (const key of Object.keys(nodes)) {
    const node = nodes[key];
    if (!node || node.type === 'PAGE') continue;
    const state = reachesPage(key);
    if (state === 'dropped') {
      delete nodes[key];
      removedWithParent++;
    } else if (state === 'broken') {
      nodes[key] = { ...node, parentId: firstPage };
      reattached++;
    }
  }
  if (removedWithParent > 0) repairs.push(`${removedWithParent} layer(s) inside removed items were removed.`);
  if (reattached > 0) repairs.push(`${reattached} layer(s) with a missing or invalid parent were moved to the first page.`);

  // Sibling order keys must be non-empty and unique.
  const groups = new Map<string, DesignNode[]>();
  for (const key in nodes) {
    const node = nodes[key] as DesignNode;
    const groupKey = node.parentId ?? '';
    const group = groups.get(groupKey);
    if (group) group.push(node);
    else groups.set(groupKey, [node]);
  }
  let rekeyedGroups = 0;
  for (const group of groups.values()) {
    const seen = new Set<string>();
    const bad = group.some((node) => {
      if (!node.order || seen.has(node.order)) return true;
      seen.add(node.order);
      return false;
    });
    if (!bad) continue;
    group.sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : a.id < b.id ? -1 : 1));
    const keys = freshKeys(group.length);
    group.forEach((node, i) => {
      nodes[node.id] = { ...node, order: keys[i] as string } as DesignNode;
    });
    rekeyedGroups++;
  }
  if (rekeyedGroups > 0) repairs.push(`Layer order was rebuilt in ${rekeyedGroups} place(s).`);

  return { doc: { id, name, nodes, assets: assetTable, styles: styleTable, variables: variableTable, variableCollections: collectionTable, publication: publication(source.publication) }, repairs };
}

/** Lists what is wrong with a document. An empty list means it is valid. */
export function validateDocument(doc: unknown): string[] {
  return repairDocument(doc).repairs;
}
