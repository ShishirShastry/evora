import { patchNodes, setTable } from '../document/mutate';
import {
  isLayer,
  type DesignNode,
  type Document,
  type LayerNode,
  type LayerPatch,
  type NodeId,
  type RGB,
  type Style,
  type StyleRefs,
  type StyleType,
  type TextStyleValues,
  type Variable,
  type VariableCollection,
  type VariableType,
  type VariableValue,
} from '../document/schema';
import { createId } from '../ids';
import { bindableKeys, STYLE_TARGETS, styleFits, TEXT_STYLE_KEYS } from '../tokens/tokens';

/**
 * What the user does with styles and variables: making, changing and
 * removing them, applying a style to layers, binding a property to a
 * variable, and choosing a mode. Writing their values into the layers that
 * use them is `applyTokens`, which the editor runs after every change.
 */

const DEFAULT_TEXT: TextStyleValues = {
  fontFamily: 'Inter',
  fontSize: 16,
  fontWeight: 400,
  italic: false,
  lineHeight: null,
  letterSpacing: 0,
  textDecoration: 'NONE',
  textCase: 'ORIGINAL',
};

function uniqueName(taken: readonly string[], wanted: string): string {
  let name = wanted.trim() || 'Untitled';
  for (let n = 2; taken.includes(name); n++) name = `${wanted.trim() || 'Untitled'} ${n}`;
  return name;
}

/** The styles of a document of one type, by name. */
export function listStyles(doc: Document, type?: StyleType): Style[] {
  return Object.values(doc.styles)
    .filter((style) => type === undefined || style.type === type)
    .sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1));
}

/** What a layer has now for the properties a kind of style sets, as the content of such a style. */
function styleContent(node: LayerNode, ref: keyof StyleRefs): Partial<Style> | null {
  if (!styleFits(node, ref)) return null;
  if (ref === 'fills') return { paints: node.fills };
  if (ref === 'strokes') return { paints: node.strokes };
  if (ref === 'effects') return { effects: node.effects };
  if (ref === 'grids') return node.type === 'FRAME' ? { grids: node.layoutGrids } : null;
  if (node.type !== 'TEXT') return null;
  const text = { ...DEFAULT_TEXT };
  for (const key of TEXT_STYLE_KEYS) (text as Record<string, unknown>)[key] = node[key];
  return { text };
}

/**
 * Makes a style of what a layer has (its fills, its strokes, its type
 * settings, its effects or its layout grids), and makes the layer use it.
 */
export function createStyle(doc: Document, layerId: NodeId, ref: keyof StyleRefs, name?: string): { doc: Document; id: string } | null {
  const node = doc.nodes[layerId];
  if (!isLayer(node)) return null;
  const content = styleContent(node, ref);
  if (!content) return null;
  const type = STYLE_TARGETS[ref].type;
  const labels: Record<StyleType, string> = { PAINT: 'Colour', TEXT: 'Text', EFFECT: 'Effect', GRID: 'Grid' };
  const style: Style = {
    id: createId(),
    name: uniqueName(Object.values(doc.styles).map((entry) => entry.name), name ?? `${labels[type]} style`),
    description: '',
    type,
    paints: [],
    text: { ...DEFAULT_TEXT },
    effects: [],
    grids: [],
    remote: null,
    ...content,
  };
  const next = setTable(doc, 'styles', { [style.id]: style });
  return { doc: patchNodes(next, { [layerId]: { styleRefs: { ...node.styleRefs, [ref]: style.id } } }), id: style.id };
}

/** Changes a style: its name, its description, or what it holds. Every layer that uses it follows. */
export function updateStyle(doc: Document, styleId: string, change: Partial<Omit<Style, 'id' | 'type'>>): Document {
  const style = doc.styles[styleId];
  // A style that came from a library is changed in the library.
  if (!style || style.remote) return doc;
  const name = change.name !== undefined ? change.name.trim() || style.name : style.name;
  return setTable(doc, 'styles', { [styleId]: { ...style, ...change, name, text: { ...style.text, ...(change.text ?? {}) } } });
}

/** Makes a style what a layer has now: the way to edit effects and grids, which have no fields of their own on a style. */
export function redefineStyle(doc: Document, styleId: string, layerId: NodeId, from?: keyof StyleRefs): Document {
  const style = doc.styles[styleId];
  const node = doc.nodes[layerId];
  if (!style || !isLayer(node)) return doc;
  // A colour style can be taken from a layer's strokes as well as its fills.
  const ref =
    from && STYLE_TARGETS[from].type === style.type
      ? from
      : (Object.keys(STYLE_TARGETS) as (keyof StyleRefs)[]).find((key) => STYLE_TARGETS[key].type === style.type && (style.type !== 'PAINT' || key === 'fills'));
  const content = ref ? styleContent(node, ref) : null;
  return content ? updateStyle(doc, styleId, content) : doc;
}

/** Removes a style. The layers that used it keep the look it gave them, as their own. */
export function deleteStyle(doc: Document, styleId: string): Document {
  if (doc.styles[styleId]?.remote) return doc;
  return setTable(doc, 'styles', { [styleId]: null });
}

/** Makes layers use a style for their fills, strokes, type, effects or grids, or with null stop using one (they keep what it gave them). */
export function applyStyle(doc: Document, ids: readonly NodeId[], ref: keyof StyleRefs, styleId: string | null): Document {
  const style = styleId === null ? null : doc.styles[styleId];
  if (styleId !== null && (!style || style.type !== STYLE_TARGETS[ref].type)) return doc;
  const patches: Record<NodeId, LayerPatch> = {};
  for (const id of ids) {
    const node = doc.nodes[id];
    if (!isLayer(node) || !styleFits(node, ref)) continue;
    const styleRefs: StyleRefs = { ...node.styleRefs };
    if (styleId === null) delete styleRefs[ref];
    else styleRefs[ref] = styleId;
    patches[id] = { styleRefs };
  }
  return patchNodes(doc, patches);
}

// ----------------------------------------------------------------- variables

export function listCollections(doc: Document): VariableCollection[] {
  return Object.values(doc.variableCollections).sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1));
}

/** The variables of a collection, by name. */
export function listVariables(doc: Document, collectionId?: string): Variable[] {
  return Object.values(doc.variables)
    .filter((variable) => collectionId === undefined || variable.collectionId === collectionId)
    .sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1));
}

/** Makes a collection of variables, with one mode to begin with. */
export function createCollection(doc: Document, name?: string): { doc: Document; id: string } {
  const collection: VariableCollection = {
    id: createId(),
    name: uniqueName(Object.values(doc.variableCollections).map((entry) => entry.name), name ?? 'Collection'),
    modes: [{ id: createId(), name: 'Mode 1' }],
    remote: null,
  };
  return { doc: setTable(doc, 'variableCollections', { [collection.id]: collection }), id: collection.id };
}

export function renameCollection(doc: Document, collectionId: string, name: string): Document {
  const collection = doc.variableCollections[collectionId];
  if (!collection || collection.remote || name.trim() === '') return doc;
  return setTable(doc, 'variableCollections', { [collectionId]: { ...collection, name: name.trim() } });
}

/** Removes a collection with its variables. Whatever was bound to them keeps the value it had. */
export function deleteCollection(doc: Document, collectionId: string): Document {
  if (doc.variableCollections[collectionId]?.remote) return doc;
  const gone: Record<string, null> = {};
  for (const variable of listVariables(doc, collectionId)) gone[variable.id] = null;
  return setTable(setTable(doc, 'variables', gone), 'variableCollections', { [collectionId]: null });
}

/** What a variable of a type is until it is given a value. */
function blank(type: VariableType): VariableValue {
  return type === 'COLOR' ? { r: 0, g: 0, b: 0 } : type === 'FLOAT' ? 0 : type === 'STRING' ? '' : false;
}

/** Adds a mode to a collection. Every variable in it starts the new mode with the value it has in the first. */
export function addMode(doc: Document, collectionId: string, name?: string): { doc: Document; id: string } | null {
  const collection = doc.variableCollections[collectionId];
  if (!collection || collection.remote) return null;
  const mode = { id: createId(), name: uniqueName(collection.modes.map((entry) => entry.name), name ?? `Mode ${collection.modes.length + 1}`) };
  const first = (collection.modes[0] as { id: string }).id;
  const changed: Record<string, Variable> = {};
  for (const variable of listVariables(doc, collectionId)) {
    changed[variable.id] = { ...variable, valuesByMode: { ...variable.valuesByMode, [mode.id]: variable.valuesByMode[first] ?? blank(variable.type) } };
  }
  const next = setTable(doc, 'variableCollections', { [collectionId]: { ...collection, modes: [...collection.modes, mode] } });
  return { doc: setTable(next, 'variables', changed), id: mode.id };
}

export function renameMode(doc: Document, collectionId: string, modeId: string, name: string): Document {
  const collection = doc.variableCollections[collectionId];
  if (!collection || collection.remote || name.trim() === '') return doc;
  return setTable(doc, 'variableCollections', {
    [collectionId]: { ...collection, modes: collection.modes.map((mode) => (mode.id === modeId ? { ...mode, name: name.trim() } : mode)) },
  });
}

/** Removes a mode. A collection keeps at least one; where the removed mode was chosen, the first applies again. */
export function removeMode(doc: Document, collectionId: string, modeId: string): Document {
  const collection = doc.variableCollections[collectionId];
  if (!collection || collection.remote || collection.modes.length <= 1 || !collection.modes.some((mode) => mode.id === modeId)) return doc;
  const changed: Record<string, Variable> = {};
  for (const variable of listVariables(doc, collectionId)) {
    const valuesByMode = { ...variable.valuesByMode };
    delete valuesByMode[modeId];
    changed[variable.id] = { ...variable, valuesByMode };
  }
  let next = setTable(doc, 'variableCollections', { [collectionId]: { ...collection, modes: collection.modes.filter((mode) => mode.id !== modeId) } });
  next = setTable(next, 'variables', changed);
  const patches: Record<NodeId, { variableModes: Record<string, string> }> = {};
  for (const id in next.nodes) {
    const node = next.nodes[id] as DesignNode;
    if (node.variableModes[collectionId] !== modeId) continue;
    const variableModes = { ...node.variableModes };
    delete variableModes[collectionId];
    patches[id] = { variableModes };
  }
  return patchNodes(next, patches);
}

/** Makes a variable in a collection, with the same starting value in every mode. */
export function createVariable(doc: Document, collectionId: string, type: VariableType, name?: string, value?: VariableValue): { doc: Document; id: string } | null {
  const collection = doc.variableCollections[collectionId];
  if (!collection || collection.remote) return null;
  const labels: Record<VariableType, string> = { COLOR: 'Colour', FLOAT: 'Number', STRING: 'String', BOOLEAN: 'Boolean' };
  const valuesByMode: Record<string, VariableValue> = {};
  for (const mode of collection.modes) valuesByMode[mode.id] = value ?? blank(type);
  const variable: Variable = {
    id: createId(),
    name: uniqueName(listVariables(doc, collectionId).map((entry) => entry.name), name ?? labels[type]),
    description: '',
    collectionId,
    type,
    scopes: [],
    valuesByMode,
    remote: null,
  };
  return { doc: setTable(doc, 'variables', { [variable.id]: variable }), id: variable.id };
}

/** Changes a variable's name, description or the kinds of property it is offered for. */
export function updateVariable(doc: Document, variableId: string, change: Partial<Pick<Variable, 'name' | 'description' | 'scopes'>>): Document {
  const variable = doc.variables[variableId];
  if (!variable || variable.remote) return doc;
  const name = change.name !== undefined ? change.name.trim() || variable.name : variable.name;
  return setTable(doc, 'variables', { [variableId]: { ...variable, ...change, name } });
}

/** Whether following what a variable stands for, from `start`, comes back to `variableId`. */
function leadsTo(doc: Document, start: string, variableId: string): boolean {
  const seen = new Set<string>();
  const visit = (id: string): boolean => {
    if (id === variableId) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    const variable = doc.variables[id];
    if (!variable) return false;
    return Object.values(variable.valuesByMode).some((value) => typeof value === 'object' && value !== null && 'alias' in value && visit(value.alias));
  };
  return visit(start);
}

/**
 * Gives a variable a value in one mode: a colour, number, string or switch
 * of its own type, or another variable of the same type that it then stands
 * for. A variable cannot stand for itself, however indirectly.
 */
export function setVariableValue(doc: Document, variableId: string, modeId: string, value: VariableValue): Document {
  const variable = doc.variables[variableId];
  const collection = variable ? doc.variableCollections[variable.collectionId] : undefined;
  if (!variable || variable.remote || !collection || !collection.modes.some((mode) => mode.id === modeId)) return doc;
  if (typeof value === 'object' && value !== null && 'alias' in value) {
    const target = doc.variables[value.alias];
    if (!target || target.type !== variable.type || leadsTo(doc, value.alias, variableId)) return doc;
  } else {
    const fits =
      variable.type === 'COLOR'
        ? typeof value === 'object' && value !== null
        : variable.type === 'FLOAT'
          ? typeof value === 'number' && Number.isFinite(value)
          : variable.type === 'STRING'
            ? typeof value === 'string'
            : typeof value === 'boolean';
    if (!fits) return doc;
  }
  const stored = typeof value === 'object' && value !== null && !('alias' in value) ? { ...(value as RGB) } : value;
  return setTable(doc, 'variables', { [variableId]: { ...variable, valuesByMode: { ...variable.valuesByMode, [modeId]: stored } } });
}

/** Removes a variable. Whatever was bound to it keeps the value it had; a variable that stood for it has none any more. */
export function deleteVariable(doc: Document, variableId: string): Document {
  if (doc.variables[variableId]?.remote) return doc;
  return setTable(doc, 'variables', { [variableId]: null });
}

/** The variables that can be bound to a property of a layer: of its type, and offered for that kind of property. */
export function variablesFor(doc: Document, node: LayerNode, key: string): Variable[] {
  const bindable = bindableKeys(node).find((entry) => entry.key === key);
  if (!bindable) return [];
  return listVariables(doc).filter((variable) => variable.type === bindable.type && (variable.scopes.length === 0 || variable.scopes.includes(bindable.scope)));
}

/**
 * Binds a property of layers to a variable, or with null unbinds it (the
 * property keeps the value it has). A size that is bound is the layer's
 * own: it no longer hugs or fills that way.
 */
export function bindVariable(doc: Document, ids: readonly NodeId[], key: string, variableId: string | null): Document {
  const patches: Record<NodeId, LayerPatch> = {};
  for (const id of ids) {
    const node = doc.nodes[id];
    if (!isLayer(node)) continue;
    const boundVariables = { ...node.boundVariables };
    const patch: LayerPatch = {};
    if (variableId === null) {
      if (!(key in boundVariables)) continue;
      delete boundVariables[key];
    } else {
      if (!variablesFor(doc, node, key).some((variable) => variable.id === variableId)) continue;
      boundVariables[key] = variableId;
      if (key === 'width') patch.layoutSizingHorizontal = 'FIXED';
      if (key === 'height') patch.layoutSizingVertical = 'FIXED';
    }
    patches[id] = { ...patch, boundVariables };
  }
  return patchNodes(doc, patches);
}

/**
 * Chooses the mode of a collection for a page or a layer and everything in
 * it, or with null leaves it to whatever is chosen further up.
 */
export function setVariableMode(doc: Document, nodeId: NodeId, collectionId: string, modeId: string | null): Document {
  const node = doc.nodes[nodeId];
  const collection = doc.variableCollections[collectionId];
  if (!node || !collection) return doc;
  const variableModes = { ...node.variableModes };
  if (modeId === null) delete variableModes[collectionId];
  else {
    if (!collection.modes.some((mode) => mode.id === modeId)) return doc;
    variableModes[collectionId] = modeId;
  }
  return patchNodes(doc, { [nodeId]: { variableModes } });
}
