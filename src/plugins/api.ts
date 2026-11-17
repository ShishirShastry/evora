/**
 * The plugin API on the app's side: what each call a plugin makes does to
 * the editor, after checking that the plugin was given the permission for
 * it. Every change to the document goes through the editor store
 * (`store.apply`), so a call (or an `evora.batch`) is one undo step, named
 * after the plugin, and is synchronised like any other change on a shared
 * file. A file that may only be viewed here refuses every change.
 *
 * What a plugin gets back is plain data (JSON, and bytes for exports): a
 * plugin never holds the editor's own objects.
 */
import {
  addLayer,
  applyPatch,
  createCollection,
  createId,
  createInstance,
  createLayer,
  deleteNodes,
  diffDocuments,
  getChildIds,
  getDescendantIds,
  getPageIdOf,
  getPages,
  groupNodes,
  isComponent,
  isContainer,
  isLayer,
  jsonValue,
  listCollections,
  listComponents,
  listStyles,
  listVariables,
  repairNode,
  setNodes,
  setTable,
  setVariableValue,
  createVariable,
  STYLE_TYPES,
  VARIABLE_TYPES,
  widgetFrameOf,
  type DesignNode,
  type Document,
  type JsonValue,
  type LayerNode,
  type LayerType,
  type NodeId,
  type Style,
  type StyleType,
  type VariableType,
  type VariableValue,
} from '../core';
import type { EditorStore } from '../state/editorStore';
import type { Permission, PluginManifest } from './manifest';

/** A call a plugin may not make, or made wrongly: the message is what the plugin's promise is rejected with. */
export class PluginApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginApiError';
  }
}

/** The permission each call needs; null for calls every plugin may make. */
export const METHOD_PERMISSIONS: Readonly<Record<string, Permission | null>> = {
  notify: null,
  closePlugin: null,
  'batch.begin': null,
  'batch.end': null,
  getDocument: 'read',
  getPages: 'read',
  getCurrentPage: 'read',
  setCurrentPage: 'read',
  getSelection: 'read',
  setSelection: 'read',
  getNode: 'read',
  getChildren: 'read',
  findAll: 'read',
  findOne: 'read',
  getComponents: 'read',
  getStyles: 'read',
  getVariableCollections: 'read',
  getVariables: 'read',
  createRectangle: 'write',
  createEllipse: 'write',
  createFrame: 'write',
  createText: 'write',
  createInstance: 'write',
  setProperties: 'write',
  remove: 'write',
  group: 'write',
  createStyle: 'write',
  updateStyle: 'write',
  createVariableCollection: 'write',
  createVariable: 'write',
  setVariableValue: 'write',
  exportAsync: 'export',
  showUI: 'ui',
  'ui.postMessage': 'ui',
  'ui.resize': 'ui',
  'ui.close': 'ui',
  'clientStorage.getAsync': 'storage',
  'clientStorage.setAsync': 'storage',
  'clientStorage.deleteAsync': 'storage',
  'clientStorage.keysAsync': 'storage',
};

/** Events and the permission a plugin needs to be told of them. */
export const EVENT_PERMISSIONS: Readonly<Record<string, Permission | null>> = {
  selectionchange: 'read',
  documentchange: 'read',
  currentpagechange: 'read',
  close: null,
  message: 'ui',
};

/** A plugin's own data on this device (`evora.clientStorage`). */
export interface ClientStorage {
  get(key: string): Promise<JsonValue | undefined>;
  set(key: string, value: JsonValue): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

export type ExportFormat = 'PNG' | 'JPG' | 'SVG' | 'PDF';

export interface UiOptions {
  width: number;
  height: number;
  title: string;
  visible: boolean;
}

/** What the API needs from around it: the editor, and the parts of the app a plugin can reach. */
export interface PluginApiEnvironment {
  store: EditorStore;
  manifest: Pick<PluginManifest, 'id' | 'name' | 'permissions'>;
  storage?: ClientStorage;
  /** Exports a layer from a document as a file's bytes. */
  exporter?: (doc: Document, nodeId: NodeId, format: ExportFormat, scale: number) => Promise<Uint8Array>;
  notify?(message: string, options: { error: boolean; timeout: number }): void;
  showUI?(options: UiOptions): void;
  postToUI?(message: unknown): void;
  resizeUI?(width: number, height: number): void;
  closeUI?(): void;
  /** Ends the plugin. */
  close?(message: string | null): void;
}

/** A layer as a plugin sees it. */
export interface NodeInfo {
  id: NodeId;
  type: LayerType | 'PAGE';
  name: string;
  parentId: NodeId | null;
  pageId: NodeId | null;
  visible: boolean;
  locked: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  opacity: number;
  fills: unknown[];
  strokes: unknown[];
  strokeWeight: number;
  children: NodeId[];
  cornerRadius?: number;
  characters?: string;
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: number;
  textAlign?: string;
  layoutMode?: string;
  itemSpacing?: number;
  padding?: { top: number; right: number; bottom: number; left: number };
  /** For a component or an instance: which, and of what. */
  component?: { kind: 'COMPONENT' | 'COMPONENT_SET' | 'INSTANCE'; componentId: NodeId | null; description: string };
  /** For a widget: which plugin and widget draw it. */
  widget?: { pluginId: string; widgetId: string };
}

/** The properties a plugin may set on a layer, and the types it must give them as. */
const SETTABLE: Readonly<Record<string, 'string' | 'number' | 'boolean' | 'array' | 'object' | 'enum'>> = {
  name: 'string',
  visible: 'boolean',
  locked: 'boolean',
  x: 'number',
  y: 'number',
  width: 'number',
  height: 'number',
  rotation: 'number',
  opacity: 'number',
  fills: 'array',
  strokes: 'array',
  effects: 'array',
  strokeWeight: 'number',
  strokeAlign: 'enum',
  blendMode: 'enum',
  cornerRadius: 'number',
  clipsContent: 'boolean',
  constraints: 'object',
  characters: 'string',
  fontFamily: 'string',
  fontSize: 'number',
  fontWeight: 'number',
  italic: 'boolean',
  textAlign: 'enum',
  verticalAlign: 'enum',
  textAutoResize: 'enum',
  letterSpacing: 'number',
  lineHeight: 'number',
  layoutMode: 'enum',
  itemSpacing: 'number',
  paddingLeft: 'number',
  paddingRight: 'number',
  paddingTop: 'number',
  paddingBottom: 'number',
  primaryAxisAlignItems: 'enum',
  counterAxisAlignItems: 'enum',
  layoutSizingHorizontal: 'enum',
  layoutSizingVertical: 'enum',
  description: 'string',
};

const MAX_FOUND = 10_000;
const MAX_STORAGE_VALUE = 1_000_000;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function idArg(value: unknown, what = 'a layer ID'): NodeId {
  if (typeof value !== 'string' || !value) throw new PluginApiError(`Expected ${what}.`);
  return value;
}

function idsArg(value: unknown): NodeId[] {
  const list = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(list) || list.some((id) => typeof id !== 'string')) throw new PluginApiError('Expected a list of layer IDs.');
  return list as NodeId[];
}

/** A layer as a plugin sees it (see `NodeInfo`). */
export function nodeInfo(doc: Document, node: DesignNode): NodeInfo {
  const children = [...getChildIds(doc, node.id)];
  if (node.type === 'PAGE') {
    return { id: node.id, type: 'PAGE', name: node.name, parentId: null, pageId: node.id, visible: true, locked: false, x: 0, y: 0, width: 0, height: 0, rotation: 0, opacity: 1, fills: [], strokes: [], strokeWeight: 0, children };
  }
  const info: NodeInfo = {
    id: node.id,
    type: node.type,
    name: node.name,
    parentId: node.parentId,
    pageId: getPageIdOf(doc, node.id),
    visible: node.visible,
    locked: node.locked,
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
    rotation: node.rotation,
    opacity: node.opacity,
    fills: structuredClone(node.fills),
    strokes: structuredClone(node.strokes),
    strokeWeight: node.strokeWeight,
    children,
  };
  if (node.type === 'FRAME' || node.type === 'RECTANGLE') info.cornerRadius = node.cornerRadius;
  if (node.type === 'TEXT') {
    info.characters = node.characters;
    info.fontFamily = node.fontFamily;
    info.fontSize = node.fontSize;
    info.fontWeight = node.fontWeight;
    info.textAlign = node.textAlign;
  }
  if (node.type === 'FRAME') {
    info.layoutMode = node.layoutMode;
    info.itemSpacing = node.itemSpacing;
    info.padding = { top: node.paddingTop, right: node.paddingRight, bottom: node.paddingBottom, left: node.paddingLeft };
    if (node.kind !== 'FRAME') info.component = { kind: node.kind, componentId: node.componentId, description: node.description };
    if (node.widget) info.widget = { pluginId: node.widget.pluginId, widgetId: node.widget.widgetId };
  }
  return info;
}

/**
 * Checks and tidies the properties a plugin gave for a layer: only the ones
 * it may set, of the right types. What the values may be is then settled by
 * the same repair that opening a file uses (`repairNode`).
 */
export function layerProps(raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (!isObject(raw)) throw new PluginApiError('Properties must be given as an object.');
  const out: Record<string, unknown> = {};
  for (const key in raw) {
    if (key === 'parentId' || key === 'index') continue;
    const kind = SETTABLE[key];
    const value = raw[key];
    if (!kind) throw new PluginApiError(`"${key}" cannot be set by a plugin. Properties that can: ${Object.keys(SETTABLE).join(', ')}.`);
    const ok =
      kind === 'number'
        ? typeof value === 'number' && Number.isFinite(value)
        : kind === 'array'
          ? Array.isArray(value)
          : kind === 'object'
            ? isObject(value)
            : kind === 'enum'
              ? typeof value === 'string'
              : key === 'lineHeight'
                ? value === null || typeof value === 'number'
                : typeof value === kind;
    if (!ok) throw new PluginApiError(`"${key}" must be ${kind === 'array' ? 'a list' : kind === 'object' ? 'an object' : kind === 'enum' ? 'one of its names (text)' : `a ${kind}`}.`);
    const copy = jsonValue(value);
    if (copy === undefined) throw new PluginApiError(`"${key}" must be plain data.`);
    out[key] = copy;
  }
  return out;
}

/** A layer with properties merged in and repaired; an enum value that is not one of its names is refused rather than quietly reset. */
function withProps(node: LayerNode, props: Record<string, unknown>): LayerNode {
  const merged = { ...node, ...props } as Record<string, unknown>;
  const repaired = repairNode(node.id, merged);
  if (!repaired || !isLayer(repaired)) throw new PluginApiError('Those properties cannot be set on this layer.');
  for (const key in props) {
    if (SETTABLE[key] === 'enum' && (repaired as unknown as Record<string, unknown>)[key] !== props[key]) {
      throw new PluginApiError(`"${String(props[key])}" is not a value "${key}" can have on a ${node.type.toLowerCase()} layer.`);
    }
  }
  return repaired;
}

/** Paints and effects as repairing a layer leaves them: what a style is given goes through the same checks. */
function repairedPaints(value: unknown): { paints: Style['paints']; effects: Style['effects'] } {
  const probe = createLayer('RECTANGLE', 'probe', 'a', {});
  const repaired = repairNode(probe.id, { ...probe, fills: Array.isArray(value) ? value : [], effects: Array.isArray(value) ? value : [] }) as LayerNode;
  return { paints: repaired.fills, effects: repaired.effects };
}

/**
 * The API for one plugin. `call` carries out one call from the plugin's
 * sandbox and resolves with what the plugin gets back, or rejects with a
 * `PluginApiError` that says why not.
 */
export class PluginApi {
  private batch: { base: Document; working: Document } | null = null;
  private readonly granted: ReadonlySet<Permission>;

  constructor(private readonly env: PluginApiEnvironment) {
    this.granted = new Set(env.manifest.permissions);
  }

  get manifest() {
    return this.env.manifest;
  }

  /** Whether the plugin was given a permission. */
  allows(permission: Permission | null): boolean {
    return permission === null || this.granted.has(permission);
  }

  /** The document as the plugin sees it: with what it changed in a batch that has not ended. */
  private doc(): Document {
    return this.batch?.working ?? this.env.store.getState().doc;
  }

  private node(id: unknown): DesignNode {
    const node = this.doc().nodes[idArg(id)];
    if (!node) throw new PluginApiError(`There is no layer with the ID "${String(id)}".`);
    return node;
  }

  private layer(id: unknown): LayerNode {
    const node = this.node(id);
    if (!isLayer(node)) throw new PluginApiError(`"${node.name}" is a page, not a layer.`);
    return node;
  }

  /** Makes a change to the document: one undo step, named after the plugin, or part of the batch in progress. */
  private change<T>(fn: (doc: Document) => { doc: Document; result: T }): T {
    if (this.env.store.getState().readOnly) throw new PluginApiError('This file can only be viewed here, so plugins cannot change it.');
    if (this.batch) {
      const out = fn(this.batch.working);
      this.batch.working = out.doc;
      return out.result;
    }
    let result: T | undefined;
    let ran = false;
    this.env.store.getState().apply(this.env.manifest.name, (doc) => {
      const out = fn(doc);
      result = out.result;
      ran = true;
      return out.doc;
    });
    if (!ran) throw new PluginApiError('The change could not be made.');
    return result as T;
  }

  /** Ends a batch that was left open (the plugin closed in the middle of one), keeping what it did. */
  finish(): void {
    if (this.batch) this.endBatch();
  }

  private endBatch(): void {
    const batch = this.batch;
    this.batch = null;
    if (!batch) return;
    const patch = diffDocuments(batch.base, batch.working);
    if (!patch) return;
    if (this.env.store.getState().readOnly) throw new PluginApiError('This file can only be viewed here, so plugins cannot change it.');
    // What others changed while the batch ran is kept: only the batch's own changes are made, onto the document as it is now.
    this.env.store.getState().apply(this.env.manifest.name, (doc) => applyPatch(doc, patch, 'forward'));
  }

  /** The parent a new layer goes in: the one asked for, or the page shown. */
  private parentFor(props: unknown, doc: Document): NodeId {
    const asked = isObject(props) ? props.parentId : undefined;
    if (asked === undefined || asked === null) return this.env.store.getState().pageId;
    const parent = doc.nodes[idArg(asked, 'a parent ID')];
    if (!parent || !isContainer(parent)) throw new PluginApiError(`"${String(asked)}" is not a page, frame or group that layers can go in.`);
    if (widgetFrameOf(doc, parent.id)) throw new PluginApiError('Layers cannot be put inside a widget: its plugin draws what is in it.');
    return parent.id;
  }

  private create(type: LayerType, props: unknown, defaults: Record<string, unknown> = {}): NodeInfo {
    const given = layerProps(props);
    const id = this.change((doc) => {
      const parentId = this.parentFor(props, doc);
      const index = isObject(props) && typeof props.index === 'number' && Number.isInteger(props.index) && props.index >= 0 ? Math.min(props.index, getChildIds(doc, parentId).length) : undefined;
      const added = addLayer(doc, type, parentId, {}, index);
      const node = withProps(added.doc.nodes[added.id] as LayerNode, { ...defaults, ...given });
      return { doc: setNodes(added.doc, { [added.id]: node }), result: added.id };
    });
    return nodeInfo(this.doc(), this.doc().nodes[id] as DesignNode);
  }

  private find(query: unknown, one: boolean): NodeInfo[] {
    const doc = this.doc();
    const q = isObject(query) ? query : {};
    const within = q.within === undefined || q.within === null ? this.env.store.getState().pageId : (this.node(q.within).id as NodeId);
    const types = q.type === undefined ? null : new Set(Array.isArray(q.type) ? q.type : [q.type]);
    const name = typeof q.name === 'string' ? q.name : null;
    const contains = typeof q.nameContains === 'string' ? q.nameContains.toLowerCase() : null;
    const out: NodeInfo[] = [];
    for (const id of getDescendantIds(doc, within)) {
      const node = doc.nodes[id];
      if (!isLayer(node)) continue;
      if (types && !types.has(node.type)) continue;
      if (name !== null && node.name !== name) continue;
      if (contains !== null && !node.name.toLowerCase().includes(contains)) continue;
      out.push(nodeInfo(doc, node));
      if (one || out.length >= MAX_FOUND) break;
    }
    return out;
  }

  private storage(): ClientStorage {
    if (!this.env.storage) throw new PluginApiError('Storage is not available here.');
    return this.env.storage;
  }

  private key(value: unknown): string {
    if (typeof value !== 'string' || !value || value.length > 200) throw new PluginApiError('A storage key must be text of 1 to 200 characters.');
    return value;
  }

  /** Carries out one call. */
  async call(method: string, args: readonly unknown[]): Promise<unknown> {
    if (!Object.hasOwn(METHOD_PERMISSIONS, method)) throw new PluginApiError(`evora.${method} is not part of the plugin API.`);
    const needed = METHOD_PERMISSIONS[method] ?? null;
    if (!this.allows(needed)) {
      throw new PluginApiError(`${this.env.manifest.name} does not have the "${needed}" permission, which evora.${method} needs. Add it to the plugin's manifest.`);
    }
    const [a, b, c] = args;
    const state = this.env.store.getState();
    switch (method) {
      case 'notify': {
        const options = isObject(b) ? b : {};
        const timeout = typeof options.timeout === 'number' && Number.isFinite(options.timeout) ? Math.max(500, Math.min(60_000, options.timeout)) : 3000;
        this.env.notify?.(String(a ?? '').slice(0, 300), { error: options.error === true, timeout });
        return null;
      }
      case 'closePlugin':
        this.finish();
        this.env.close?.(typeof a === 'string' && a ? a.slice(0, 300) : null);
        return null;
      case 'batch.begin':
        if (this.batch) throw new PluginApiError('A batch is already in progress: batches do not nest.');
        this.batch = { base: state.doc, working: state.doc };
        return null;
      case 'batch.end':
        this.endBatch();
        return null;

      // ---- the document, pages and selection
      case 'getDocument': {
        const doc = this.doc();
        return { id: doc.id, name: doc.name, currentPageId: state.pageId, pages: getPages(doc).filter((page) => !page.library).map((page) => ({ id: page.id, name: page.name })) };
      }
      case 'getPages':
        return getPages(this.doc())
          .filter((page) => !page.library)
          .map((page) => nodeInfo(this.doc(), page));
      case 'getCurrentPage':
        return nodeInfo(this.doc(), this.doc().nodes[state.pageId] as DesignNode);
      case 'setCurrentPage': {
        const page = this.node(a);
        if (page.type !== 'PAGE' || page.library) throw new PluginApiError(`"${page.name}" is not a page.`);
        state.setPage(page.id);
        return null;
      }
      case 'getSelection':
        return state.selection.map((id) => nodeInfo(this.doc(), this.doc().nodes[id] as DesignNode)).filter(Boolean);
      case 'setSelection': {
        const ids = idsArg(a);
        for (const id of ids) this.layer(id);
        state.setSelection(ids);
        return [...this.env.store.getState().selection];
      }
      case 'getNode': {
        const node = this.doc().nodes[idArg(a)];
        return node ? nodeInfo(this.doc(), node) : null;
      }
      case 'getChildren':
        return getChildIds(this.doc(), this.node(a).id).map((id) => nodeInfo(this.doc(), this.doc().nodes[id] as DesignNode));
      case 'findAll':
        return this.find(a, false);
      case 'findOne':
        return this.find(a, true)[0] ?? null;

      // ---- making and changing layers
      case 'createRectangle':
        return this.create('RECTANGLE', a);
      case 'createEllipse':
        return this.create('ELLIPSE', a);
      case 'createFrame':
        return this.create('FRAME', a);
      case 'createText':
        return this.create('TEXT', a, { characters: '' });
      case 'createInstance': {
        const componentId = idArg(a, 'a component ID');
        const given = layerProps(b);
        const id = this.change((doc) => {
          if (!isComponent(doc.nodes[componentId])) throw new PluginApiError(`"${componentId}" is not a component.`);
          const parentId = this.parentFor(b, doc);
          const x = typeof given.x === 'number' ? given.x : 0;
          const y = typeof given.y === 'number' ? given.y : 0;
          const made = createInstance(doc, componentId, { parentId, at: { x, y } });
          if (!made) throw new PluginApiError('An instance of a component cannot go inside that component.');
          const node = withProps(made.doc.nodes[made.id] as LayerNode, given);
          return { doc: setNodes(made.doc, { [made.id]: node }), result: made.id };
        });
        return nodeInfo(this.doc(), this.doc().nodes[id] as DesignNode);
      }
      case 'setProperties': {
        const target = this.layer(a);
        const props = layerProps(b);
        this.change((doc) => {
          const node = doc.nodes[target.id];
          if (!isLayer(node)) throw new PluginApiError('That layer no longer exists.');
          return { doc: setNodes(doc, { [node.id]: withProps(node, props) }), result: null };
        });
        return nodeInfo(this.doc(), this.doc().nodes[target.id] as DesignNode);
      }
      case 'remove': {
        const ids = idsArg(a);
        for (const id of ids) this.layer(id);
        this.change((doc) => ({ doc: deleteNodes(doc, ids), result: null }));
        return null;
      }
      case 'group': {
        const ids = idsArg(a);
        if (ids.length === 0) throw new PluginApiError('Grouping needs at least one layer.');
        for (const id of ids) this.layer(id);
        const parent = this.layer(ids[ids.length - 1]).parentId;
        if (ids.some((id) => this.layer(id).parentId !== parent)) throw new PluginApiError('The layers to group must be in the same parent.');
        const props = layerProps(b);
        const id = this.change((doc) => {
          const grouped = groupNodes(doc, ids);
          if (!grouped) throw new PluginApiError('Those layers cannot be grouped.');
          const name = typeof props.name === 'string' ? props.name : null;
          const next = name ? setNodes(grouped.doc, { [grouped.id]: withProps(grouped.doc.nodes[grouped.id] as LayerNode, { name }) }) : grouped.doc;
          return { doc: next, result: grouped.id };
        });
        return nodeInfo(this.doc(), this.doc().nodes[id] as DesignNode);
      }

      // ---- components, styles and variables
      case 'getComponents':
        return listComponents(this.doc()).map((node) => nodeInfo(this.doc(), node));
      case 'getStyles': {
        const type = a === undefined || a === null ? undefined : (a as StyleType);
        if (type !== undefined && !STYLE_TYPES.includes(type)) throw new PluginApiError(`A style type is one of ${STYLE_TYPES.join(', ')}.`);
        return listStyles(this.doc(), type).map((style) => structuredClone(style));
      }
      case 'createStyle': {
        if (!isObject(a)) throw new PluginApiError('createStyle needs {type, name, …}.');
        const type = a.type as StyleType;
        if (type !== 'PAINT' && type !== 'EFFECT') throw new PluginApiError('Plugins can create PAINT and EFFECT styles.');
        const name = typeof a.name === 'string' && a.name.trim() ? a.name.trim().slice(0, 200) : type === 'PAINT' ? 'Colour' : 'Effect';
        const { paints, effects } = repairedPaints(type === 'PAINT' ? a.paints : a.effects);
        const id = createId();
        this.change((doc) => {
          const base = listStyles(doc)[0];
          const style: Style = {
            id,
            name,
            description: typeof a.description === 'string' ? a.description.slice(0, 2000) : '',
            type,
            paints: type === 'PAINT' ? paints : [],
            effects: type === 'EFFECT' ? effects : [],
            grids: [],
            text: base?.text ?? { fontFamily: 'Inter', fontSize: 16, fontWeight: 400, italic: false, lineHeight: null, letterSpacing: 0, textDecoration: 'NONE', textCase: 'ORIGINAL', paragraphSpacing: 0 },
            remote: null,
          };
          return { doc: setTable(doc, 'styles', { [id]: style }), result: null };
        });
        return structuredClone(this.doc().styles[id]);
      }
      case 'updateStyle': {
        const styleId = idArg(a, 'a style ID');
        const style = this.doc().styles[styleId];
        if (!style) throw new PluginApiError(`There is no style with the ID "${styleId}".`);
        if (style.remote) throw new PluginApiError(`"${style.name}" comes from a library and can only be changed there.`);
        if (!isObject(b)) throw new PluginApiError('updateStyle needs the changes as an object.');
        const next: Style = { ...style };
        if (typeof b.name === 'string' && b.name.trim()) next.name = b.name.trim().slice(0, 200);
        if (typeof b.description === 'string') next.description = b.description.slice(0, 2000);
        if (b.paints !== undefined) next.paints = repairedPaints(b.paints).paints;
        if (b.effects !== undefined) next.effects = repairedPaints(b.effects).effects;
        this.change((doc) => ({ doc: setTable(doc, 'styles', { [styleId]: next }), result: null }));
        return structuredClone(this.doc().styles[styleId]);
      }
      case 'getVariableCollections':
        return listCollections(this.doc()).map((collection) => structuredClone(collection));
      case 'getVariables':
        return listVariables(this.doc(), typeof a === 'string' ? a : undefined).map((variable) => structuredClone(variable));
      case 'createVariableCollection': {
        const name = typeof a === 'string' && a.trim() ? a.trim().slice(0, 200) : undefined;
        const id = this.change((doc) => {
          const made = createCollection(doc, name);
          return { doc: made.doc, result: made.id };
        });
        return structuredClone(this.doc().variableCollections[id]);
      }
      case 'createVariable': {
        if (!isObject(a)) throw new PluginApiError('createVariable needs {collectionId, type, name, value}.');
        const type = a.type as VariableType;
        if (!VARIABLE_TYPES.includes(type)) throw new PluginApiError(`A variable's type is one of ${VARIABLE_TYPES.join(', ')}.`);
        const collectionId = idArg(a.collectionId, 'a collection ID');
        const value = a.value === undefined ? undefined : (jsonValue(a.value) as VariableValue | undefined);
        const id = this.change((doc) => {
          const made = createVariable(doc, collectionId, type, typeof a.name === 'string' ? a.name.slice(0, 200) : undefined);
          if (!made) throw new PluginApiError(`There is no collection "${collectionId}" of this file to put the variable in.`);
          let next = made.doc;
          if (value !== undefined) {
            for (const mode of next.variableCollections[collectionId]?.modes ?? []) next = setVariableValue(next, made.id, mode.id, value);
          }
          return { doc: next, result: made.id };
        });
        return structuredClone(this.doc().variables[id]);
      }
      case 'setVariableValue': {
        const variableId = idArg(a, 'a variable ID');
        const variable = this.doc().variables[variableId];
        if (!variable) throw new PluginApiError(`There is no variable with the ID "${variableId}".`);
        const modeId = idArg(b, 'a mode ID');
        const value = jsonValue(c) as VariableValue | undefined;
        if (value === undefined) throw new PluginApiError('A variable\'s value must be plain data.');
        this.change((doc) => {
          const next = setVariableValue(doc, variableId, modeId, value);
          if (next === doc && JSON.stringify(doc.variables[variableId]?.valuesByMode[modeId]) !== JSON.stringify(value)) {
            throw new PluginApiError(`That value does not fit the ${variable.type} variable "${variable.name}" in that mode.`);
          }
          return { doc: next, result: null };
        });
        return structuredClone(this.doc().variables[variableId]);
      }

      // ---- export, window and storage
      case 'exportAsync': {
        const node = this.layer(a);
        const options = isObject(b) ? b : {};
        const format = (typeof options.format === 'string' ? options.format.toUpperCase() : 'PNG') as ExportFormat;
        if (!['PNG', 'JPG', 'SVG', 'PDF'].includes(format)) throw new PluginApiError('The export format is one of PNG, JPG, SVG and PDF.');
        const scale = typeof options.scale === 'number' && Number.isFinite(options.scale) ? Math.max(0.01, Math.min(16, options.scale)) : 1;
        if (!this.env.exporter) throw new PluginApiError('Exporting is not available here.');
        return this.env.exporter(this.doc(), node.id, format, scale);
      }
      case 'showUI': {
        const options = isObject(a) ? a : {};
        const size = (value: unknown, fallback: number) => (typeof value === 'number' && Number.isFinite(value) ? Math.round(Math.max(80, Math.min(1200, value))) : fallback);
        this.env.showUI?.({
          width: size(options.width, 300),
          height: size(options.height, 400),
          title: typeof options.title === 'string' && options.title.trim() ? options.title.trim().slice(0, 80) : this.env.manifest.name,
          visible: options.visible !== false,
        });
        return null;
      }
      case 'ui.postMessage':
        this.env.postToUI?.(a);
        return null;
      case 'ui.resize':
        if (typeof a !== 'number' || typeof b !== 'number') throw new PluginApiError('ui.resize needs a width and a height.');
        this.env.resizeUI?.(Math.round(Math.max(80, Math.min(1200, a))), Math.round(Math.max(60, Math.min(1200, b))));
        return null;
      case 'ui.close':
        this.env.closeUI?.();
        return null;
      case 'clientStorage.getAsync':
        return (await this.storage().get(this.key(a))) ?? null;
      case 'clientStorage.setAsync': {
        const value = jsonValue(b);
        if (value === undefined) throw new PluginApiError('Only plain data (JSON) can be kept in storage.');
        if (JSON.stringify(value).length > MAX_STORAGE_VALUE) throw new PluginApiError('A value kept in storage is limited to 1 MB.');
        await this.storage().set(this.key(a), value);
        return null;
      }
      case 'clientStorage.deleteAsync':
        await this.storage().delete(this.key(a));
        return null;
      case 'clientStorage.keysAsync':
        return this.storage().keys();
    }
    throw new PluginApiError(`evora.${method} is not part of the plugin API.`);
  }
}
