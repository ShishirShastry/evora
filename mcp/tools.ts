// The Evora MCP server's tools: AI agents (Claude Code, Cursor and others)
// create and edit .evora design files with them. Everything happens on files
// in one folder (the workspace); the Evora app opens the results.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  addLayer,
  addPage,
  applyAutoLayout,
  createDocument,
  deleteNodes,
  dropShadow,
  fitTextLayers,
  getChildIds,
  getLayer,
  getNode,
  getPages,
  parseFileText,
  patchNode,
  serializeFile,
  solidPaint,
  textLayerName,
  toFile,
  type Document,
  type FileMeta,
  type LayerNode,
  type LayerPatch,
  type LayerType,
  type NodeId,
  type Paint,
  type RGB,
  type TextMeasurer,
} from '../src/core';
import { svgOf } from '../src/engine/export/export';

/** A mistake in what the agent asked for; it is shown to the agent so it can try again. */
export class ToolError extends Error {}

export interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run(args: Record<string, unknown>): Promise<ToolResult>;
}

// ---------------------------------------------------------------- text sizes

const NARROW = new Set("il.,:;'|!ftjrI()[]");

/**
 * Text widths in Inter, Evora's font, without a canvas: per-character
 * estimates close to Inter's real advances. The Evora app measures exactly
 * when the text is next edited.
 */
export const interMeasurer: TextMeasurer = {
  width(text, style) {
    let em = 0;
    let count = 0;
    for (const ch of text) {
      count++;
      if (ch === ' ') em += 0.28;
      else if (NARROW.has(ch)) em += 0.31;
      else if ('mwMW@%'.includes(ch)) em += 0.86;
      else if (ch >= 'A' && ch <= 'Z') em += 0.68;
      else if (ch >= '0' && ch <= '9') em += 0.6;
      else em += 0.56;
    }
    const weight = 1 + Math.max(0, style.fontWeight - 400) / 2000;
    return em * style.fontSize * weight + count * style.letterSpacing;
  },
  metrics: (style) => ({ ascent: style.fontSize * 0.97, descent: style.fontSize * 0.24 }),
};

// ------------------------------------------------------------------- colours

function parseColor(value: unknown): { color: RGB; opacity: number } {
  const match = typeof value === 'string' ? /^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value.trim()) : null;
  if (!match) throw new ToolError(`${JSON.stringify(value)} is not a colour. Use a hex colour such as "#7C5CFF", or "none".`);
  let hex = match[1] as string;
  if (hex.length === 3) hex = [...hex].map((c) => c + c).join('');
  const byte = (i: number) => parseInt(hex.slice(i, i + 2), 16) / 255;
  return { color: { r: byte(0), g: byte(2), b: byte(4) }, opacity: hex.length === 8 ? byte(6) : 1 };
}

function paintOf(value: unknown): Paint[] {
  if (value === 'none' || value === null) return [];
  const { color, opacity } = parseColor(value);
  return [solidPaint(color, opacity)];
}

function hexOf(color: RGB): string {
  return '#' + [color.r, color.g, color.b].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
}

function describePaints(paints: readonly Paint[]): string | undefined {
  const first = paints[0];
  if (!first) return undefined;
  if (first.type === 'SOLID') return hexOf(first.color) + (first.opacity < 1 ? ` at ${Math.round(first.opacity * 100)}%` : '');
  return first.type === 'IMAGE' ? 'image' : 'gradient';
}

// ------------------------------------------------------------- layer specs

const LAYER_TYPES = ['FRAME', 'RECTANGLE', 'ELLIPSE', 'TEXT', 'LINE'] as const;

const layerProps = {
  name: { type: 'string' },
  x: { type: 'number', description: 'Left edge, relative to the parent.' },
  y: { type: 'number', description: 'Top edge, relative to the parent.' },
  width: { type: 'number' },
  height: { type: 'number' },
  rotation: { type: 'number', description: 'Degrees.' },
  opacity: { type: 'number', minimum: 0, maximum: 1 },
  visible: { type: 'boolean' },
  fill: { type: 'string', description: 'Hex colour such as "#7C5CFF" or "#7C5CFF80" (with alpha), or "none". For text, the text colour.' },
  stroke: { type: 'string', description: 'Hex colour, or "none".' },
  strokeWeight: { type: 'number' },
  cornerRadius: { type: 'number', description: 'Frames and rectangles.' },
  shadow: {
    description: 'A drop shadow, or "none".',
    anyOf: [
      { type: 'string', enum: ['none'] },
      { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, blur: { type: 'number' }, spread: { type: 'number' }, color: { type: 'string' } } },
    ],
  },
  text: { type: 'string', description: 'Text layers: the words. Use \\n for a new line.' },
  fontSize: { type: 'number' },
  fontWeight: { type: 'number', description: '100 to 900; 400 is regular, 700 bold.' },
  italic: { type: 'boolean' },
  textAlign: { type: 'string', enum: ['LEFT', 'CENTER', 'RIGHT', 'JUSTIFIED'] },
  lineHeight: { type: 'number', description: 'Pixels.' },
  letterSpacing: { type: 'number', description: 'Pixels.' },
  fontFamily: { type: 'string', description: 'Defaults to Inter, which ships with Evora.' },
  layout: {
    type: 'object',
    description: 'Frames: auto layout, which places the children in a row or column.',
    properties: {
      direction: { type: 'string', enum: ['HORIZONTAL', 'VERTICAL', 'NONE'] },
      gap: { type: 'number' },
      padding: {
        description: 'One number for all sides, or each side.',
        anyOf: [{ type: 'number' }, { type: 'object', properties: { top: { type: 'number' }, right: { type: 'number' }, bottom: { type: 'number' }, left: { type: 'number' } } }],
      },
      align: { type: 'string', enum: ['MIN', 'CENTER', 'MAX', 'SPACE_BETWEEN'], description: 'Along the direction.' },
      crossAlign: { type: 'string', enum: ['MIN', 'CENTER', 'MAX'], description: 'Across the direction.' },
      wrap: { type: 'boolean' },
    },
  },
  widthSizing: { type: 'string', enum: ['FIXED', 'HUG', 'FILL'], description: 'HUG fits the content (auto-layout frames and text); FILL takes the room left in an auto-layout parent.' },
  heightSizing: { type: 'string', enum: ['FIXED', 'HUG', 'FILL'] },
  clipsContent: { type: 'boolean', description: 'Frames: hide what spills outside.' },
} as const;

const layerSpecSchema: Record<string, unknown> = {
  type: 'object',
  required: ['type'],
  properties: {
    type: { type: 'string', enum: LAYER_TYPES },
    ...layerProps,
    children: { type: 'array', description: 'Frames only: layers inside this one.', items: { type: 'object' } },
  },
};

type Spec = Record<string, unknown>;

function num(spec: Spec, key: string): number | undefined {
  const value = spec[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new ToolError(`"${key}" must be a number.`);
  return value;
}

function oneOf<T extends string>(spec: Spec, key: string, allowed: readonly T[]): T | undefined {
  const value = spec[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new ToolError(`"${key}" must be one of ${allowed.join(', ')}.`);
  return value as T;
}

/** Turns the agent's description of a layer into a patch for a layer of `type`. */
function patchFrom(spec: Spec, type: LayerType): LayerPatch {
  const patch: Record<string, unknown> = {};
  for (const key of ['x', 'y', 'width', 'height', 'rotation', 'opacity', 'strokeWeight'] as const) {
    const value = num(spec, key);
    if (value !== undefined) patch[key] = value;
  }
  if (typeof spec.name === 'string') patch.name = spec.name;
  if (typeof spec.visible === 'boolean') patch.visible = spec.visible;
  if (spec.fill !== undefined) patch.fills = paintOf(spec.fill);
  if (spec.stroke !== undefined) patch.strokes = paintOf(spec.stroke);
  const radius = num(spec, 'cornerRadius');
  if (radius !== undefined) {
    if (type !== 'FRAME' && type !== 'RECTANGLE') throw new ToolError('Only frames and rectangles have a corner radius.');
    patch.cornerRadius = radius;
  }
  if (spec.shadow !== undefined) {
    if (spec.shadow === 'none') patch.effects = [];
    else if (typeof spec.shadow === 'object' && spec.shadow !== null) {
      const s = spec.shadow as Spec;
      const { color, opacity } = parseColor(s.color ?? '#00000040');
      patch.effects = [{ ...dropShadow(), offsetX: num(s, 'x') ?? 0, offsetY: num(s, 'y') ?? 4, blur: num(s, 'blur') ?? 12, spread: num(s, 'spread') ?? 0, color, opacity }];
    } else throw new ToolError('"shadow" must be "none" or an object such as {"y": 4, "blur": 12, "color": "#00000040"}.');
  }

  const textKeys = ['text', 'fontSize', 'fontWeight', 'italic', 'textAlign', 'lineHeight', 'letterSpacing', 'fontFamily'];
  if (type === 'TEXT') {
    if (spec.text !== undefined) {
      if (typeof spec.text !== 'string') throw new ToolError('"text" must be a string.');
      patch.characters = spec.text;
    }
    for (const key of ['fontSize', 'fontWeight', 'lineHeight', 'letterSpacing'] as const) {
      const value = num(spec, key);
      if (value !== undefined) patch[key] = value;
    }
    if (typeof spec.italic === 'boolean') patch.italic = spec.italic;
    if (typeof spec.fontFamily === 'string') patch.fontFamily = spec.fontFamily;
    const align = oneOf(spec, 'textAlign', ['LEFT', 'CENTER', 'RIGHT', 'JUSTIFIED']);
    if (align) patch.textAlign = align;
    // A text with a set width wraps inside it; otherwise it grows to fit its words.
    if (spec.width !== undefined || spec.widthSizing === 'FILL') patch.textAutoResize = spec.height !== undefined ? 'NONE' : 'HEIGHT';
  } else if (textKeys.some((key) => spec[key] !== undefined)) {
    throw new ToolError(`Text settings (${textKeys.join(', ')}) apply only to TEXT layers.`);
  }

  if (spec.layout !== undefined) {
    if (type !== 'FRAME') throw new ToolError('Only frames have auto layout.');
    const layout = spec.layout as Spec;
    const direction = oneOf(layout, 'direction', ['HORIZONTAL', 'VERTICAL', 'NONE']);
    if (direction) patch.layoutMode = direction;
    const gap = num(layout, 'gap');
    if (gap !== undefined) patch.itemSpacing = gap;
    if (typeof layout.padding === 'number') {
      for (const side of ['Top', 'Right', 'Bottom', 'Left']) patch[`padding${side}`] = layout.padding;
    } else if (typeof layout.padding === 'object' && layout.padding !== null) {
      const padding = layout.padding as Spec;
      for (const side of ['top', 'right', 'bottom', 'left']) {
        const value = num(padding, side);
        if (value !== undefined) patch[`padding${side[0]!.toUpperCase()}${side.slice(1)}`] = value;
      }
    }
    const align = oneOf(layout, 'align', ['MIN', 'CENTER', 'MAX', 'SPACE_BETWEEN']);
    if (align) patch.primaryAxisAlignItems = align;
    const cross = oneOf(layout, 'crossAlign', ['MIN', 'CENTER', 'MAX']);
    if (cross) patch.counterAxisAlignItems = cross;
    if (typeof layout.wrap === 'boolean') patch.layoutWrap = layout.wrap ? 'WRAP' : 'NO_WRAP';
  }
  const widthSizing = oneOf(spec, 'widthSizing', ['FIXED', 'HUG', 'FILL']);
  if (widthSizing) patch.layoutSizingHorizontal = widthSizing;
  const heightSizing = oneOf(spec, 'heightSizing', ['FIXED', 'HUG', 'FILL']);
  if (heightSizing) patch.layoutSizingVertical = heightSizing;
  if (typeof spec.clipsContent === 'boolean') {
    if (type !== 'FRAME') throw new ToolError('Only frames clip their content.');
    patch.clipsContent = spec.clipsContent;
  }
  return patch as LayerPatch;
}

/** Lays out text and auto layout again after a change, as the editor does. */
function settle(previous: Document, doc: Document): Document {
  return applyAutoLayout(fitTextLayers(previous, doc, interMeasurer), interMeasurer);
}

// ----------------------------------------------------------------- outline

const round = (v: number) => Math.round(v * 100) / 100;

function outline(doc: Document, id: NodeId, depth: number): Record<string, unknown> {
  const node = getLayer(doc, id) as LayerNode;
  const out: Record<string, unknown> = { id, type: node.type, name: node.name, x: round(node.x), y: round(node.y), width: round(node.width), height: round(node.height) };
  if (!node.visible) out.hidden = true;
  if (node.rotation) out.rotation = round(node.rotation);
  if (node.opacity < 1) out.opacity = round(node.opacity);
  const fill = describePaints(node.fills);
  if (fill) out.fill = fill;
  const stroke = describePaints(node.strokes);
  if (stroke) out.stroke = `${stroke}, ${node.strokeWeight}px`;
  if ('cornerRadius' in node && node.cornerRadius) out.cornerRadius = node.cornerRadius;
  if (node.type === 'TEXT') {
    out.text = node.characters.length > 300 ? node.characters.slice(0, 300) + '…' : node.characters;
    out.font = `${node.fontFamily} ${node.fontWeight} ${node.fontSize}px`;
  }
  if (node.type === 'FRAME' && node.layoutMode !== 'NONE') {
    out.layout = {
      direction: node.layoutMode,
      gap: node.itemSpacing,
      padding: [node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft],
      align: node.primaryAxisAlignItems,
      crossAlign: node.counterAxisAlignItems,
    };
  }
  if (node.layoutSizingHorizontal !== 'FIXED' || node.layoutSizingVertical !== 'FIXED') out.sizing = `${node.layoutSizingHorizontal} x ${node.layoutSizingVertical}`;
  const children = getChildIds(doc, id);
  if (children.length) out.children = depth > 0 ? children.map((child) => outline(doc, child, depth - 1)) : `${children.length} layers (read with a larger depth)`;
  return out;
}

// --------------------------------------------------------------- workspace

interface Loaded {
  doc: Document;
  meta: FileMeta;
  assetData?: Record<string, string>;
}

/** The folder the agent may read and write .evora files in. */
export class Workspace {
  readonly root: string;
  private queues = new Map<string, Promise<unknown>>();

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  resolve(file: unknown, extension = '.evora'): string {
    if (typeof file !== 'string' || !file.trim()) throw new ToolError('"path" is required: a file path inside the workspace, such as "designs/home.evora".');
    const abs = path.resolve(this.root, file);
    if (abs !== this.root && !abs.startsWith(this.root + path.sep)) throw new ToolError(`"${file}" is outside the workspace (${this.root}).`);
    if (path.extname(abs).toLowerCase() !== extension) throw new ToolError(`"${file}" must end in ${extension}.`);
    return abs;
  }

  relative(abs: string): string {
    return path.relative(this.root, abs).split(path.sep).join('/');
  }

  async load(abs: string): Promise<Loaded> {
    let text: string;
    try {
      text = await fs.readFile(abs, 'utf8');
    } catch {
      throw new ToolError(`There is no file at "${this.relative(abs)}". Use list_files to see the files, or create_file to make one.`);
    }
    const { file } = parseFileText(text);
    const raw = JSON.parse(text) as { assetData?: Record<string, string> };
    return { doc: file.document, meta: file.meta, assetData: raw.assetData };
  }

  async save(abs: string, loaded: Loaded): Promise<void> {
    const file = toFile(loaded.doc, { createdAt: loaded.meta.createdAt, updatedAt: new Date().toISOString() });
    if (loaded.assetData) file.assetData = loaded.assetData;
    await fs.mkdir(path.dirname(abs), { recursive: true });
    const temp = `${abs}.${process.pid}.tmp`;
    await fs.writeFile(temp, serializeFile(file));
    await fs.rename(temp, abs);
  }

  /** Runs one change to a file at a time, so parallel calls don't overwrite each other. */
  edit<T>(abs: string, change: (loaded: Loaded) => T | Promise<T>): Promise<T> {
    const run = (this.queues.get(abs) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      const loaded = await this.load(abs);
      const result = await change(loaded);
      await this.save(abs, loaded);
      return result;
    });
    this.queues.set(abs, run);
    return run;
  }

  async list(): Promise<string[]> {
    const found: string[] = [];
    const walk = async (dir: string, depth: number) => {
      if (depth > 5 || found.length >= 500) return;
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full, depth + 1);
        else if (entry.name.toLowerCase().endsWith('.evora')) found.push(this.relative(full));
      }
    };
    await walk(this.root, 0);
    return found.sort();
  }
}

// ------------------------------------------------------------------- tools

const text = (value: unknown): ToolResult => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });

function pageOrLayer(doc: Document, id: unknown, what: string): NodeId {
  if (typeof id !== 'string' || !getNode(doc, id)) throw new ToolError(`There is no ${what} with the id ${JSON.stringify(id)}. Use read_file to see the ids.`);
  return id;
}

function addTree(doc: Document, parentId: NodeId, specs: unknown): { doc: Document; created: Record<string, unknown>[] } {
  if (!Array.isArray(specs) || specs.length === 0) throw new ToolError('"layers" must be a list of at least one layer.');
  const created: Record<string, unknown>[] = [];
  for (const raw of specs) {
    if (typeof raw !== 'object' || raw === null) throw new ToolError('Each layer must be an object with a "type".');
    const spec = raw as Spec;
    const type = oneOf(spec, 'type', LAYER_TYPES);
    if (!type) throw new ToolError(`Each layer needs a "type": ${LAYER_TYPES.join(', ')}.`);
    const patch = patchFrom(spec, type);
    // Like the editor, a text layer is named after its words unless given a name.
    if (type === 'TEXT' && patch.name === undefined && typeof spec.text === 'string' && spec.text.trim()) patch.name = textLayerName(spec.text);
    const result = addLayer(doc, type, parentId, patch);
    doc = result.doc;
    const entry: Record<string, unknown> = { id: result.id, type, name: (getLayer(doc, result.id) as LayerNode).name };
    if (spec.children !== undefined) {
      if (type !== 'FRAME') throw new ToolError('Only frames can have children.');
      const inner = addTree(doc, result.id, spec.children);
      doc = inner.doc;
      entry.children = inner.created;
    }
    created.push(entry);
  }
  return { doc, created };
}

export function createTools(workspace: Workspace): Tool[] {
  const pathProp = { path: { type: 'string', description: 'A .evora file, relative to the workspace folder.' } };
  return [
    {
      name: 'list_files',
      description: 'Lists the Evora design files (.evora) in the workspace folder.',
      inputSchema: { type: 'object', properties: {} },
      async run() {
        const files = await workspace.list();
        return text(files.length ? { workspace: workspace.root, files } : `There are no .evora files in ${workspace.root} yet. Use create_file to start one.`);
      },
    },
    {
      name: 'create_file',
      description: 'Creates a new, empty Evora design file with one page, and returns the page id to add layers to.',
      inputSchema: { type: 'object', required: ['path'], properties: { ...pathProp, name: { type: 'string', description: "The design's name. Defaults to the file name." } } },
      async run(args) {
        const abs = workspace.resolve(args.path);
        const exists = await fs.stat(abs).then(() => true, () => false);
        if (exists) throw new ToolError(`"${workspace.relative(abs)}" already exists. Pick another name, or edit it with add_layers.`);
        const name = typeof args.name === 'string' && args.name.trim() ? args.name.trim() : path.basename(abs, '.evora');
        const doc = createDocument(name);
        const now = new Date().toISOString();
        await workspace.save(abs, { doc, meta: { createdAt: now, updatedAt: now } });
        const page = getPages(doc)[0]!;
        return text({ path: workspace.relative(abs), pages: [{ id: page.id, name: page.name }], next: 'Add a FRAME to the page (for example 1440 x 1024 for a desktop screen, or 390 x 844 for a phone) and build inside it.' });
      },
    },
    {
      name: 'read_file',
      description: 'Shows a design: its pages, and the layers on one page as a tree with ids, positions, sizes, colours, text and auto layout.',
      inputSchema: {
        type: 'object',
        required: ['path'],
        properties: { ...pathProp, pageId: { type: 'string', description: 'Defaults to the first page.' }, depth: { type: 'number', description: 'How many levels of layers to show. Defaults to 6.' } },
      },
      async run(args) {
        const abs = workspace.resolve(args.path);
        const { doc } = await workspace.load(abs);
        const pages = getPages(doc);
        const pageId = args.pageId === undefined ? pages[0]?.id : pageOrLayer(doc, args.pageId, 'page');
        if (!pageId || !pages.some((p) => p.id === pageId)) throw new ToolError(`${JSON.stringify(args.pageId)} is not a page id.`);
        const depth = typeof args.depth === 'number' ? Math.max(0, Math.min(20, Math.floor(args.depth))) : 6;
        return text({
          name: doc.name,
          pages: pages.map((p) => ({ id: p.id, name: p.name })),
          page: pageId,
          layers: getChildIds(doc, pageId).map((id) => outline(doc, id, depth - 1)),
        });
      },
    },
    {
      name: 'add_layers',
      description:
        'Adds layers to a page or inside a frame. Layers can nest through "children". Use frames with "layout" (auto layout) for rows, columns, cards and buttons; ' +
        'give text a "fill" for its colour. Returns the new layer ids.',
      inputSchema: {
        type: 'object',
        required: ['path', 'parentId', 'layers'],
        properties: { ...pathProp, parentId: { type: 'string', description: 'A page id or a frame id.' }, layers: { type: 'array', items: layerSpecSchema } },
      },
      async run(args) {
        const abs = workspace.resolve(args.path);
        const created = await workspace.edit(abs, (loaded) => {
          const parentId = pageOrLayer(loaded.doc, args.parentId, 'page or frame');
          const before = loaded.doc;
          const result = addTree(before, parentId, args.layers);
          loaded.doc = settle(before, result.doc);
          return result.created;
        });
        return text({ added: created });
      },
    },
    {
      name: 'update_layers',
      description: 'Changes existing layers: position, size, colours, text, auto layout and the rest of the settings add_layers takes.',
      inputSchema: {
        type: 'object',
        required: ['path', 'updates'],
        properties: {
          ...pathProp,
          updates: { type: 'array', items: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, ...layerProps } } },
        },
      },
      async run(args) {
        const abs = workspace.resolve(args.path);
        if (!Array.isArray(args.updates) || args.updates.length === 0) throw new ToolError('"updates" must be a list of at least one change, each with an "id".');
        const updates = args.updates as Spec[];
        await workspace.edit(abs, (loaded) => {
          const before = loaded.doc;
          let doc = before;
          for (const update of updates) {
            const id = pageOrLayer(doc, update.id, 'layer');
            const layer = getLayer(doc, id);
            if (!layer) throw new ToolError(`${id} is a page; only layers can be changed here.`);
            if (update.type !== undefined && update.type !== layer.type) throw new ToolError(`A layer's type can't be changed (${id} is a ${layer.type}).`);
            doc = patchNode(doc, id, patchFrom(update, layer.type));
          }
          loaded.doc = settle(before, doc);
        });
        return text(`Changed ${updates.length} layer${updates.length === 1 ? '' : 's'}.`);
      },
    },
    {
      name: 'delete_layers',
      description: 'Deletes layers and everything inside them.',
      inputSchema: { type: 'object', required: ['path', 'ids'], properties: { ...pathProp, ids: { type: 'array', items: { type: 'string' } } } },
      async run(args) {
        const abs = workspace.resolve(args.path);
        if (!Array.isArray(args.ids) || args.ids.length === 0) throw new ToolError('"ids" must be a list of layer ids.');
        await workspace.edit(abs, (loaded) => {
          const ids = (args.ids as unknown[]).map((id) => {
            const checked = pageOrLayer(loaded.doc, id, 'layer');
            if (!getLayer(loaded.doc, checked)) throw new ToolError(`${checked} is a page; pages are not deleted here.`);
            return checked;
          });
          const before = loaded.doc;
          loaded.doc = settle(before, deleteNodes(before, ids));
        });
        return text(`Deleted ${args.ids.length} layer${args.ids.length === 1 ? '' : 's'}.`);
      },
    },
    {
      name: 'add_page',
      description: 'Adds a page to a design and returns its id.',
      inputSchema: { type: 'object', required: ['path'], properties: { ...pathProp, name: { type: 'string' } } },
      async run(args) {
        const abs = workspace.resolve(args.path);
        const id = await workspace.edit(abs, (loaded) => {
          const result = addPage(loaded.doc, typeof args.name === 'string' ? args.name : undefined);
          loaded.doc = result.doc;
          return result.id;
        });
        return text({ id });
      },
    },
    {
      name: 'export_svg',
      description: 'Draws a layer (usually a top-level frame) as SVG, to check how the design looks. Optionally saves it as a .svg file in the workspace.',
      inputSchema: {
        type: 'object',
        required: ['path', 'id'],
        properties: { ...pathProp, id: { type: 'string', description: 'The layer to draw.' }, saveTo: { type: 'string', description: 'A .svg path in the workspace to save the drawing to.' } },
      },
      async run(args) {
        const abs = workspace.resolve(args.path);
        const { doc } = await workspace.load(abs);
        const id = pageOrLayer(doc, args.id, 'layer');
        if (!getLayer(doc, id)) throw new ToolError('Pick a layer, such as a top-level frame, not a page.');
        const noCanvas = () => {
          throw new ToolError('This drawing needs a picture effect (such as a blur) that only the Evora app can draw.');
        };
        const svg = await svgOf(doc, id, { measurer: interMeasurer, createCanvas: noCanvas, encode: noCanvas, loadAsset: async () => null });
        let saved = '';
        if (args.saveTo !== undefined) {
          const out = workspace.resolve(args.saveTo, '.svg');
          await fs.mkdir(path.dirname(out), { recursive: true });
          await fs.writeFile(out, svg);
          saved = `Saved to ${workspace.relative(out)}.\n`;
        }
        return text(svg.length > 200_000 ? `${saved}The SVG is ${Math.round(svg.length / 1024)} KB, too large to show; save it with "saveTo" instead.` : saved + svg);
      },
    },
  ];
}
