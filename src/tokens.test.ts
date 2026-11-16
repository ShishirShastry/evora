import { describe, expect, it } from 'vitest';
import {
  addLayer,
  addMode,
  applyStyle,
  bindVariable,
  createCollection,
  createComponent,
  createDocument,
  createInstance,
  createStyle,
  createVariable,
  CURRENT_SCHEMA_VERSION,
  deleteCollection,
  deleteStyle,
  deleteVariable,
  getLayer,
  getPages,
  listStyles,
  listVariables,
  mirrorId,
  modeFor,
  parseFile,
  patchNode,
  redefineStyle,
  removeMode,
  renameMode,
  repairDocument,
  resetInstances,
  resolveVariable,
  setVariableMode,
  setVariableValue,
  solidPaint,
  updateStyle,
  updateVariable,
  variablesFor,
  type Document,
  type FrameNode,
  type LayerNode,
  type LayerPatch,
  type LayerType,
  type NodeId,
  type SolidPaint,
  type TextNode,
  type VariableType,
  type VariableValue,
} from './core';
import { createEditorStore, type EditorStore } from './state/editorStore';

/**
 * Styles, variables, modes and tokens, through the editor store: everything
 * here goes the way an edit in the application goes, so what a style or a
 * variable does to the layers that use it is in the same undo step.
 */

const RED = { r: 1, g: 0, b: 0 };
const GREEN = { r: 0, g: 1, b: 0 };
const BLUE = { r: 0, g: 0, b: 1 };
const WHITE = { r: 1, g: 1, b: 1 };
const BLACK = { r: 0, g: 0, b: 0 };

const now = (store: EditorStore): Document => store.getState().doc;
const act = (store: EditorStore, fn: (doc: Document) => Document): void => store.getState().apply('Edit', fn);
const layer = (store: EditorStore, id: NodeId): LayerNode => getLayer(now(store), id) as LayerNode;
const fill = (store: EditorStore, id: NodeId) => (layer(store, id).fills[0] as SolidPaint).color;

function start(): { store: EditorStore; pageId: NodeId } {
  const store = createEditorStore(createDocument('Tokens'));
  return { store, pageId: (getPages(now(store))[0] as { id: NodeId }).id };
}

function add(store: EditorStore, type: LayerType, parentId: NodeId, props: LayerPatch): NodeId {
  let id = '';
  act(store, (doc) => {
    const out = addLayer(doc, type, parentId, props);
    id = out.id;
    return out.doc;
  });
  return id;
}

/** Runs an operation that returns a document and an ID, and gives the ID. */
function make(store: EditorStore, fn: (doc: Document) => { doc: Document; id: string } | null): string {
  let id = '';
  act(store, (doc) => {
    const out = fn(doc) as { doc: Document; id: string };
    id = out.id;
    return out.doc;
  });
  return id;
}

/** A collection with one variable in it. */
function variable(store: EditorStore, type: VariableType, name: string, value: VariableValue, collectionId?: string): { collection: string; id: string; mode: string } {
  const collection = collectionId ?? make(store, (doc) => createCollection(doc, 'Theme'));
  const id = make(store, (doc) => createVariable(doc, collection, type, name, value));
  return { collection, id, mode: (now(store).variableCollections[collection] as { modes: { id: string }[] }).modes[0]!.id };
}

describe('styles', () => {
  it('makes a colour style of a layer, applies it to another, and changes both when the style changes', () => {
    const { store, pageId } = start();
    const a = add(store, 'RECTANGLE', pageId, { x: 0, y: 0, width: 50, height: 50, fills: [solidPaint(RED)] });
    const b = add(store, 'RECTANGLE', pageId, { x: 100, y: 0, width: 50, height: 50, fills: [solidPaint(BLUE)], strokes: [solidPaint(BLACK)] });
    const style = make(store, (doc) => createStyle(doc, a, 'fills', 'Brand'));
    expect(now(store).styles[style]).toMatchObject({ name: 'Brand', type: 'PAINT', paints: [{ type: 'SOLID', color: RED }] });
    expect(layer(store, a).styleRefs).toEqual({ fills: style });
    expect(listStyles(now(store), 'PAINT').map((entry) => entry.id)).toEqual([style]);

    act(store, (doc) => applyStyle(doc, [b], 'fills', style));
    expect(fill(store, b)).toEqual(RED);
    // The same style can colour a stroke.
    act(store, (doc) => applyStyle(doc, [b], 'strokes', style));
    expect((layer(store, b).strokes[0] as SolidPaint).color).toEqual(RED);

    act(store, (doc) => updateStyle(doc, style, { paints: [solidPaint(GREEN)], name: 'Brand green', description: 'The brand colour' }));
    expect(fill(store, a)).toEqual(GREEN);
    expect(fill(store, b)).toEqual(GREEN);
    expect((layer(store, b).strokes[0] as SolidPaint).color).toEqual(GREEN);
    expect(now(store).styles[style]).toMatchObject({ name: 'Brand green', description: 'The brand colour' });
    // The style and every layer that uses it go back in one undo step, and forward again.
    store.getState().undo();
    expect(fill(store, a)).toEqual(RED);
    expect(fill(store, b)).toEqual(RED);
    expect(now(store).styles[style]?.name).toBe('Brand');
    store.getState().redo();
    expect(fill(store, b)).toEqual(GREEN);

    // A fill changed by hand is that layer's own again; the other still follows the style.
    act(store, (doc) => patchNode(doc, b, { fills: [solidPaint(BLUE)] }));
    expect(layer(store, b).styleRefs).toEqual({ strokes: style });
    expect(fill(store, b)).toEqual(BLUE);
    act(store, (doc) => updateStyle(doc, style, { paints: [solidPaint(WHITE)] }));
    expect(fill(store, a)).toEqual(WHITE);
    expect(fill(store, b)).toEqual(BLUE);

    // Taking a style off, or removing it, leaves the look it gave.
    act(store, (doc) => applyStyle(doc, [b], 'strokes', null));
    expect(layer(store, b).styleRefs).toEqual({});
    expect((layer(store, b).strokes[0] as SolidPaint).color).toEqual(WHITE);
    act(store, (doc) => deleteStyle(doc, style));
    expect(now(store).styles).toEqual({});
    expect(layer(store, a).styleRefs).toEqual({});
    expect(fill(store, a)).toEqual(WHITE);
    store.getState().undo();
    expect(layer(store, a).styleRefs).toEqual({ fills: style });
    expect(now(store).styles[style]).toBeDefined();
  });

  it('has text, effect and grid styles, each for the layers it fits', () => {
    const { store, pageId } = start();
    const title = add(store, 'TEXT', pageId, { x: 0, y: 0, characters: 'Title', fontSize: 32, fontWeight: 700 });
    const other = add(store, 'TEXT', pageId, { x: 0, y: 100, characters: 'Other' });
    const box = add(store, 'RECTANGLE', pageId, { x: 0, y: 200, width: 40, height: 40 });
    const heading = make(store, (doc) => createStyle(doc, title, 'text', 'Heading'));
    expect(now(store).styles[heading]).toMatchObject({ type: 'TEXT', text: { fontSize: 32, fontWeight: 700 } });
    act(store, (doc) => applyStyle(doc, [other, box], 'text', heading));
    expect(layer(store, other)).toMatchObject({ fontSize: 32, fontWeight: 700, styleRefs: { text: heading } });
    // A text style is not for a rectangle, and a colour style is not a text style.
    expect(layer(store, box).styleRefs).toEqual({});
    expect(createStyle(now(store), box, 'text')).toBeNull();
    const widthBefore = layer(store, other).width;
    act(store, (doc) => updateStyle(doc, heading, { text: { ...now(store).styles[heading]!.text, fontSize: 16, italic: true } }));
    expect(layer(store, title)).toMatchObject({ fontSize: 16, italic: true, fontWeight: 700 });
    expect(layer(store, other)).toMatchObject({ fontSize: 16, italic: true });
    // The text is fitted to its new size in the same step.
    expect(layer(store, other).width).toBeLessThan(widthBefore);
    // Changing the size of one by hand takes it off the style.
    act(store, (doc) => patchNode(doc, other, { fontSize: 20 }));
    expect(layer(store, other).styleRefs).toEqual({});
    expect(layer(store, title).styleRefs).toEqual({ text: heading });

    const shadow = { type: 'DROP_SHADOW', color: BLACK, opacity: 0.5, offsetX: 0, offsetY: 4, radius: 8, spread: 0, visible: true };
    const grid = { pattern: 'COLUMNS', size: 10, count: 4, gutter: 8, offset: 0, alignment: 'STRETCH', sectionSize: 10, color: RED, opacity: 0.1, visible: true };
    const card = add(store, 'FRAME', pageId, { x: 200, y: 0, width: 100, height: 100, effects: [shadow], layoutGrids: [grid] } as unknown as LayerPatch);
    const plain = add(store, 'FRAME', pageId, { x: 400, y: 0, width: 100, height: 100 });
    const elevation = make(store, (doc) => createStyle(doc, card, 'effects', 'Elevation'));
    const columns = make(store, (doc) => createStyle(doc, card, 'grids', 'Columns'));
    expect(now(store).styles[elevation]?.type).toBe('EFFECT');
    expect(now(store).styles[columns]?.type).toBe('GRID');
    act(store, (doc) => applyStyle(applyStyle(doc, [plain, box], 'effects', elevation), [plain, box], 'grids', columns));
    expect(layer(store, plain).effects).toEqual(layer(store, card).effects);
    expect((layer(store, plain) as FrameNode).layoutGrids).toEqual((layer(store, card) as FrameNode).layoutGrids);
    expect(layer(store, box).effects).toEqual(layer(store, card).effects);
    // Layout grids are for frames.
    expect(layer(store, box).styleRefs).toEqual({ effects: elevation });
    // A style is redefined from a layer: the layer that was changed by hand gives the style its new content.
    act(store, (doc) => patchNode(doc, plain, { effects: [] }));
    expect(layer(store, plain).styleRefs).toEqual({ grids: columns });
    act(store, (doc) => redefineStyle(doc, elevation, plain));
    expect(layer(store, card).effects).toEqual([]);
    expect(layer(store, box).effects).toEqual([]);
    // A style of one type is not applied as another.
    expect(applyStyle(now(store), [plain], 'fills', elevation)).toBe(now(store));
  });
});

describe('variables', () => {
  it('binds properties of layers to variables of each type; changing a variable changes everything bound to it', () => {
    const { store, pageId } = start();
    const a = add(store, 'RECTANGLE', pageId, { x: 0, y: 0, width: 50, height: 50, fills: [solidPaint(RED)] });
    const b = add(store, 'RECTANGLE', pageId, { x: 100, y: 0, width: 50, height: 50, fills: [solidPaint(RED)], strokes: [solidPaint(BLACK)] });
    const label = add(store, 'TEXT', pageId, { x: 0, y: 100, characters: 'Hello' });
    const colour = variable(store, 'COLOR', 'brand', BLUE);
    const size = variable(store, 'FLOAT', 'size', 80, colour.collection);
    const copy = variable(store, 'STRING', 'greeting', 'Welcome', colour.collection);
    const shown = variable(store, 'BOOLEAN', 'shown', false, colour.collection);
    expect(listVariables(now(store), colour.collection).map((entry) => entry.name)).toEqual(['brand', 'greeting', 'shown', 'size']);

    act(store, (doc) => bindVariable(bindVariable(doc, [a, b], 'fills.0', colour.id), [b], 'strokes.0', colour.id));
    expect(fill(store, a)).toEqual(BLUE);
    expect(fill(store, b)).toEqual(BLUE);
    expect((layer(store, b).strokes[0] as SolidPaint).color).toEqual(BLUE);
    expect(layer(store, b).boundVariables).toEqual({ 'fills.0': colour.id, 'strokes.0': colour.id });

    act(store, (doc) => setVariableValue(doc, colour.id, colour.mode, GREEN));
    expect(fill(store, a)).toEqual(GREEN);
    expect(fill(store, b)).toEqual(GREEN);
    expect((layer(store, b).strokes[0] as SolidPaint).color).toEqual(GREEN);
    // One undo step for the variable and everything bound to it.
    store.getState().undo();
    expect(fill(store, a)).toEqual(BLUE);
    expect(fill(store, b)).toEqual(BLUE);
    expect(resolveVariable(now(store), colour.id, a)).toEqual(BLUE);
    store.getState().redo();

    // Numbers: a size, a corner radius, an opacity in percent.
    act(store, (doc) => bindVariable(bindVariable(bindVariable(doc, [a], 'width', size.id), [a], 'cornerRadius', size.id), [b], 'opacity', size.id));
    expect(layer(store, a)).toMatchObject({ width: 80, cornerRadius: 80, height: 50 });
    expect(layer(store, b).opacity).toBeCloseTo(0.8);
    act(store, (doc) => setVariableValue(doc, size.id, size.mode, 20));
    expect(layer(store, a)).toMatchObject({ width: 20, cornerRadius: 20 });
    expect(layer(store, b).opacity).toBeCloseTo(0.2);

    // A string for what a text says (which is then fitted), a switch for whether a layer shows.
    act(store, (doc) => bindVariable(bindVariable(doc, [label], 'characters', copy.id), [label], 'visible', shown.id));
    expect(layer(store, label)).toMatchObject({ characters: 'Welcome', visible: false });
    const width = layer(store, label).width;
    act(store, (doc) => setVariableValue(setVariableValue(doc, copy.id, copy.mode, 'Hi'), shown.id, shown.mode, true));
    expect(layer(store, label)).toMatchObject({ characters: 'Hi', visible: true });
    expect(layer(store, label).width).toBeLessThan(width);

    // Only a variable of the right type can be bound, and a value of the wrong type is not taken.
    expect(bindVariable(now(store), [a], 'fills.0', size.id)).toBe(now(store));
    expect(bindVariable(now(store), [a], 'characters', copy.id)).toBe(now(store));
    expect(setVariableValue(now(store), size.id, size.mode, 'wide')).toBe(now(store));
    expect(setVariableValue(now(store), colour.id, colour.mode, 4)).toBe(now(store));

    // Changing a bound property by hand unbinds it; the others stay bound.
    act(store, (doc) => patchNode(doc, a, { fills: [solidPaint(RED)] }));
    expect(layer(store, a).boundVariables).toEqual({ width: size.id, cornerRadius: size.id });
    act(store, (doc) => patchNode(doc, a, { cornerRadius: 3 }));
    expect(layer(store, a).boundVariables).toEqual({ width: size.id });
    act(store, (doc) => setVariableValue(setVariableValue(doc, colour.id, colour.mode, WHITE), size.id, size.mode, 64));
    expect(fill(store, a)).toEqual(RED);
    expect(layer(store, a)).toMatchObject({ cornerRadius: 3, width: 64 });
    expect(fill(store, b)).toEqual(WHITE);

    // Unbinding, and removing a variable, leave the value it gave.
    act(store, (doc) => bindVariable(doc, [a], 'width', null));
    expect(layer(store, a)).toMatchObject({ width: 64, boundVariables: {} });
    act(store, (doc) => deleteVariable(doc, colour.id));
    expect(layer(store, b).boundVariables).toEqual({ opacity: size.id });
    expect(fill(store, b)).toEqual(WHITE);
    act(store, (doc) => deleteCollection(doc, colour.collection));
    expect(now(store).variables).toEqual({});
    expect(now(store).variableCollections).toEqual({});
    expect(layer(store, b).boundVariables).toEqual({});
    store.getState().undo();
    expect(Object.keys(now(store).variables)).toHaveLength(3);
    expect(layer(store, b).boundVariables).toEqual({ opacity: size.id });
  });

  it('has modes: a variable has a value in each, and the mode chosen on a page or a frame applies to what is in it', () => {
    const { store, pageId } = start();
    const frame = add(store, 'FRAME', pageId, { x: 0, y: 0, width: 200, height: 200 });
    const inside = add(store, 'RECTANGLE', frame, { x: 10, y: 10, width: 50, height: 50, fills: [solidPaint(RED)] });
    const outside = add(store, 'RECTANGLE', pageId, { x: 300, y: 0, width: 50, height: 50, fills: [solidPaint(RED)] });
    const surface = variable(store, 'COLOR', 'surface', WHITE);
    act(store, (doc) => renameMode(doc, surface.collection, surface.mode, 'Light'));
    const dark = make(store, (doc) => addMode(doc, surface.collection, 'Dark'));
    // A new mode starts with the values of the first.
    expect(now(store).variables[surface.id]?.valuesByMode).toEqual({ [surface.mode]: WHITE, [dark]: WHITE });
    act(store, (doc) => setVariableValue(doc, surface.id, dark, BLACK));
    act(store, (doc) => bindVariable(doc, [inside, outside, frame], 'fills.0', surface.id));
    expect(fill(store, inside)).toEqual(WHITE);
    expect(fill(store, outside)).toEqual(WHITE);

    act(store, (doc) => setVariableMode(doc, frame, surface.collection, dark));
    expect(modeFor(now(store), inside, surface.collection)).toBe(dark);
    expect(fill(store, frame)).toEqual(BLACK);
    expect(fill(store, inside)).toEqual(BLACK);
    expect(fill(store, outside)).toEqual(WHITE);
    store.getState().undo();
    expect(fill(store, inside)).toEqual(WHITE);
    store.getState().redo();

    // The page's mode is for everything on it that has no nearer one.
    act(store, (doc) => setVariableMode(doc, pageId, surface.collection, dark));
    expect(fill(store, outside)).toEqual(BLACK);
    act(store, (doc) => setVariableMode(doc, frame, surface.collection, surface.mode));
    expect(fill(store, inside)).toEqual(WHITE);
    expect(fill(store, outside)).toEqual(BLACK);
    // Left to what is above again.
    act(store, (doc) => setVariableMode(doc, frame, surface.collection, null));
    expect(fill(store, inside)).toEqual(BLACK);
    // A layer moved out of a frame with a mode takes the mode of where it now is.
    act(store, (doc) => setVariableMode(setVariableMode(doc, pageId, surface.collection, null), frame, surface.collection, dark));
    expect(fill(store, inside)).toEqual(BLACK);
    act(store, (doc) => patchNode(doc, inside, { parentId: pageId } as LayerPatch));
    expect(fill(store, inside)).toEqual(WHITE);

    // Removing a mode: where it was chosen the first applies again. The last mode stays.
    act(store, (doc) => removeMode(doc, surface.collection, dark));
    expect(fill(store, frame)).toEqual(WHITE);
    expect(layer(store, frame).variableModes).toEqual({});
    expect(now(store).variables[surface.id]?.valuesByMode).toEqual({ [surface.mode]: WHITE });
    expect(removeMode(now(store), surface.collection, surface.mode)).toBe(now(store));
  });

  it('lets a variable stand for another: semantic tokens over primitives', () => {
    const { store, pageId } = start();
    const a = add(store, 'RECTANGLE', pageId, { x: 0, y: 0, width: 50, height: 50, fills: [solidPaint(RED)] });
    const blue = variable(store, 'COLOR', 'blue/500', BLUE);
    const green = variable(store, 'COLOR', 'green/500', GREEN, blue.collection);
    const semantic = make(store, (doc) => createCollection(doc, 'Semantic'));
    const action = variable(store, 'COLOR', 'action', BLACK, semantic);
    const button = variable(store, 'COLOR', 'button/background', BLACK, semantic);
    act(store, (doc) => setVariableValue(setVariableValue(doc, action.id, action.mode, { alias: blue.id }), button.id, button.mode, { alias: action.id }));
    act(store, (doc) => bindVariable(doc, [a], 'fills.0', button.id));
    expect(fill(store, a)).toEqual(BLUE);
    // Changing the primitive changes what stands for it, two steps away.
    act(store, (doc) => setVariableValue(doc, blue.id, blue.mode, { r: 0, g: 0, b: 0.5 }));
    expect(fill(store, a)).toEqual({ r: 0, g: 0, b: 0.5 });
    // Pointing the semantic token somewhere else.
    act(store, (doc) => setVariableValue(doc, action.id, action.mode, { alias: green.id }));
    expect(fill(store, a)).toEqual(GREEN);
    // A variable cannot stand for itself, however indirectly, nor for one of another type.
    expect(setVariableValue(now(store), green.id, green.mode, { alias: button.id })).toBe(now(store));
    expect(setVariableValue(now(store), action.id, action.mode, { alias: action.id })).toBe(now(store));
    const number = variable(store, 'FLOAT', 'space', 8, blue.collection);
    expect(setVariableValue(now(store), action.id, action.mode, { alias: number.id })).toBe(now(store));
    // An alias follows the mode of each collection on the way: dark primitives under a light semantic layer.
    const dark = make(store, (doc) => addMode(doc, blue.collection, 'Dark'));
    act(store, (doc) => setVariableValue(doc, green.id, dark, WHITE));
    act(store, (doc) => setVariableMode(doc, pageId, blue.collection, dark));
    expect(fill(store, a)).toEqual(WHITE);
    // What it stood for is removed: the layer keeps what it had, and follows again when the token gets a value.
    act(store, (doc) => deleteVariable(doc, green.id));
    expect(resolveVariable(now(store), button.id, a)).toBeNull();
    expect(fill(store, a)).toEqual(WHITE);
    expect(layer(store, a).boundVariables).toEqual({ 'fills.0': button.id });
    act(store, (doc) => setVariableValue(doc, action.id, action.mode, RED));
    expect(fill(store, a)).toEqual(RED);
  });

  it('offers a variable for the kinds of property it is scoped to, and keeps a name and a description', () => {
    const { store, pageId } = start();
    const frame = add(store, 'FRAME', pageId, { x: 0, y: 0, width: 200, height: 100, layoutMode: 'HORIZONTAL', itemSpacing: 4 } as LayerPatch);
    const first = add(store, 'RECTANGLE', frame, { width: 40, height: 40 });
    const second = add(store, 'RECTANGLE', frame, { width: 40, height: 40 });
    const space = variable(store, 'FLOAT', 'space/md', 16);
    const radius = variable(store, 'FLOAT', 'radius/md', 6, space.collection);
    act(store, (doc) => updateVariable(updateVariable(doc, space.id, { scopes: ['GAP'], description: 'Between items' }), radius.id, { scopes: ['RADIUS'], name: 'radius/medium' }));
    expect(now(store).variables[space.id]).toMatchObject({ description: 'Between items', scopes: ['GAP'] });
    expect(now(store).variables[radius.id]?.name).toBe('radius/medium');
    const f = layer(store, frame);
    expect(variablesFor(now(store), f, 'itemSpacing').map((entry) => entry.id)).toEqual([space.id]);
    expect(variablesFor(now(store), f, 'cornerRadius').map((entry) => entry.id)).toEqual([radius.id]);
    expect(variablesFor(now(store), f, 'width')).toEqual([]);
    expect(bindVariable(now(store), [frame], 'width', space.id)).toBe(now(store));
    // Spacing and padding tokens move what is in a layout.
    act(store, (doc) => bindVariable(bindVariable(doc, [frame], 'itemSpacing', space.id), [frame], 'paddingLeft', space.id));
    expect(layer(store, first).x).toBe(16);
    expect(layer(store, second).x).toBe(16 + 40 + 16);
    act(store, (doc) => setVariableValue(doc, space.id, space.mode, 24));
    expect(layer(store, first).x).toBe(24);
    expect(layer(store, second).x).toBe(24 + 40 + 24);
    // A width that is bound is the layer's own, not the layout's.
    act(store, (doc) => patchNode(updateVariable(doc, space.id, { scopes: [] }), first, { layoutSizingHorizontal: 'FILL' } as LayerPatch));
    expect(layer(store, first).width).toBeGreaterThan(40);
    act(store, (doc) => bindVariable(doc, [first], 'width', space.id));
    expect(layer(store, first)).toMatchObject({ width: 24, layoutSizingHorizontal: 'FIXED' });
  });
});

describe('styles and variables in components', () => {
  function button(): { store: EditorStore; pageId: NodeId; component: NodeId; icon: NodeId; instance: NodeId; mirror: NodeId } {
    const { store, pageId } = start();
    const frame = add(store, 'FRAME', pageId, { x: 0, y: 0, width: 120, height: 40, fills: [solidPaint(WHITE)] });
    const icon = add(store, 'ELLIPSE', frame, { x: 8, y: 12, width: 16, height: 16, fills: [solidPaint(RED)] });
    act(store, (doc) => (createComponent(doc, [frame]) as { doc: Document }).doc);
    const instance = make(store, (doc) => createInstance(doc, frame, { parentId: pageId, at: { x: 300, y: 0 } }));
    return { store, pageId, component: frame, icon, instance, mirror: mirrorId(instance, icon) };
  }

  it('takes a token change to the instances without making it an override, and resolves the mode where the instance is', () => {
    const b = button();
    const ink = variable(b.store, 'COLOR', 'ink', BLUE);
    const paper = variable(b.store, 'COLOR', 'paper', WHITE, ink.collection);
    const dark = make(b.store, (doc) => addMode(doc, ink.collection, 'Dark'));
    act(b.store, (doc) => setVariableValue(setVariableValue(doc, ink.id, dark, GREEN), paper.id, dark, BLACK));
    act(b.store, (doc) => bindVariable(bindVariable(doc, [b.icon], 'fills.0', ink.id), [b.component], 'fills.0', paper.id));
    expect(fill(b.store, b.mirror)).toEqual(BLUE);
    expect(layer(b.store, b.mirror).boundVariables).toEqual({ 'fills.0': ink.id });
    expect(layer(b.store, b.instance).boundVariables).toEqual({ 'fills.0': paper.id });
    act(b.store, (doc) => setVariableValue(doc, ink.id, ink.mode, RED));
    expect(fill(b.store, b.icon)).toEqual(RED);
    expect(fill(b.store, b.mirror)).toEqual(RED);
    expect((layer(b.store, b.instance) as FrameNode).overrides).toEqual({});

    // A dark instance of a light component: its layers and its own background.
    act(b.store, (doc) => setVariableMode(doc, b.instance, ink.collection, dark));
    expect(fill(b.store, b.mirror)).toEqual(GREEN);
    expect(fill(b.store, b.instance)).toEqual(BLACK);
    expect(fill(b.store, b.icon)).toEqual(RED);
    expect(fill(b.store, b.component)).toEqual(WHITE);
    expect((layer(b.store, b.instance) as FrameNode).overrides).toEqual({});
    // It stays dark while the component changes.
    act(b.store, (doc) => patchNode(doc, b.icon, { width: 20 }));
    expect(fill(b.store, b.mirror)).toEqual(GREEN);
    expect(layer(b.store, b.mirror).width).toBe(20);

    // A colour set by hand in the instance is an override, which a token no longer changes; reset binds it again.
    act(b.store, (doc) => patchNode(doc, b.mirror, { fills: [solidPaint(WHITE)] }));
    expect((layer(b.store, b.instance) as FrameNode).overrides[b.icon]).toMatchObject({ boundVariables: {}, fills: [{ color: WHITE }] });
    act(b.store, (doc) => setVariableValue(doc, ink.id, dark, BLUE));
    expect(fill(b.store, b.mirror)).toEqual(WHITE);
    act(b.store, (doc) => resetInstances(doc, [b.instance]));
    expect(fill(b.store, b.mirror)).toEqual(BLUE);
    expect(layer(b.store, b.mirror).boundVariables).toEqual({ 'fills.0': ink.id });
  });

  it('keeps an instance on the styles of its component, and lets it use another', () => {
    const b = button();
    const accent = make(b.store, (doc) => createStyle(doc, b.icon, 'fills', 'Accent'));
    const surface = make(b.store, (doc) => createStyle(doc, b.component, 'fills', 'Surface'));
    expect(layer(b.store, b.mirror).styleRefs).toEqual({ fills: accent });
    expect(layer(b.store, b.instance).styleRefs).toEqual({ fills: surface });
    act(b.store, (doc) => updateStyle(updateStyle(doc, accent, { paints: [solidPaint(GREEN)] }), surface, { paints: [solidPaint(BLACK)] }));
    expect(fill(b.store, b.mirror)).toEqual(GREEN);
    expect(fill(b.store, b.instance)).toEqual(BLACK);
    expect((layer(b.store, b.instance) as FrameNode).overrides).toEqual({});
    // Another style in the instance is an override of which style it uses.
    act(b.store, (doc) => applyStyle(doc, [b.mirror], 'fills', surface));
    expect(fill(b.store, b.mirror)).toEqual(BLACK);
    expect((layer(b.store, b.instance) as FrameNode).overrides[b.icon]).toEqual({ styleRefs: { fills: surface } });
    act(b.store, (doc) => updateStyle(updateStyle(doc, accent, { paints: [solidPaint(RED)] }), surface, { paints: [solidPaint(WHITE)] }));
    expect(fill(b.store, b.icon)).toEqual(RED);
    expect(fill(b.store, b.mirror)).toEqual(WHITE);
    // A fill overridden before the component got a style stays the instance's own.
    const c = button();
    act(c.store, (doc) => patchNode(doc, c.mirror, { fills: [solidPaint(BLUE)] }));
    const later = make(c.store, (doc) => createStyle(doc, c.icon, 'fills', 'Later'));
    act(c.store, (doc) => updateStyle(doc, later, { paints: [solidPaint(GREEN)] }));
    expect(fill(c.store, c.icon)).toEqual(GREEN);
    expect(fill(c.store, c.mirror)).toEqual(BLUE);
    expect(layer(c.store, c.mirror).styleRefs).toEqual({});
  });
});

describe('styles and variables in a file', () => {
  it('opens a version 19 file, which has none, and keeps them through saving and opening', () => {
    const { store, pageId } = start();
    const a = add(store, 'RECTANGLE', pageId, { x: 0, y: 0, width: 50, height: 50, fills: [solidPaint(RED)] });
    const label = add(store, 'TEXT', pageId, { x: 0, y: 100, characters: 'Hello' }) as NodeId;
    const current = now(store);
    const v19 = JSON.parse(JSON.stringify(current)) as Record<string, unknown> & { nodes: Record<string, Record<string, unknown>> };
    for (const key of ['styles', 'variables', 'variableCollections']) delete v19[key];
    for (const id in v19.nodes) for (const key of ['styleRefs', 'boundVariables', 'variableModes']) delete (v19.nodes[id] as Record<string, unknown>)[key];
    const parsed = parseFile({ format: 'open-design', schemaVersion: 19, meta: { createdAt: '2026-11-16T15:00:00.000Z', updatedAt: '2026-11-16T15:00:00.000Z' }, document: v19 });
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(20);
    expect(parsed.repairs).toEqual([]);
    expect(parsed.file.document).toEqual(current);

    const style = make(store, (doc) => createStyle(doc, a, 'fills', 'Brand'));
    const heading = make(store, (doc) => createStyle(doc, label, 'text', 'Heading'));
    const colour = variable(store, 'COLOR', 'ink', BLUE);
    const alias = variable(store, 'COLOR', 'text', BLACK, colour.collection);
    const dark = make(store, (doc) => addMode(doc, colour.collection, 'Dark'));
    act(store, (doc) => setVariableValue(doc, alias.id, dark, { alias: colour.id }));
    act(store, (doc) => setVariableMode(bindVariable(doc, [label], 'fills.0', alias.id), pageId, colour.collection, dark));
    expect((getLayer(now(store), label) as TextNode).styleRefs).toEqual({ text: heading });
    const reopened = repairDocument(JSON.parse(JSON.stringify(now(store))));
    expect(reopened.repairs).toEqual([]);
    expect(reopened.doc).toEqual(now(store));

    // What is not what it should be is dropped or put right, and said.
    const raw = JSON.parse(JSON.stringify(now(store))) as Record<string, Record<string, Record<string, unknown>>>;
    raw.styles!.odd = { id: 'odd', type: 'SOUND', name: 'Odd' };
    (raw.styles![style] as Record<string, unknown>).name = 7;
    raw.variables!.lost = { id: 'lost', type: 'COLOR', collectionId: 'nowhere', valuesByMode: {} };
    (raw.variables![colour.id] as Record<string, unknown>).valuesByMode = { [colour.mode]: 'blue', other: 3 };
    raw.variableCollections!.empty = { id: 'empty', name: 'Empty', modes: [] };
    (raw.nodes![a] as Record<string, unknown>).styleRefs = { fills: 5, sound: 'x' };
    const repaired = repairDocument(raw);
    expect(repaired.repairs.length).toBeGreaterThan(0);
    expect(Object.keys(repaired.doc.styles).sort()).toEqual([heading, style].sort());
    expect(repaired.doc.styles[style]?.name).toBe('Style');
    expect(Object.keys(repaired.doc.variables).sort()).toEqual([alias.id, colour.id].sort());
    expect(repaired.doc.variables[colour.id]?.valuesByMode).toEqual({ [colour.mode]: BLACK, [dark]: BLACK });
    expect(Object.keys(repaired.doc.variableCollections)).toEqual([colour.collection]);
    expect((getLayer(repaired.doc, a) as LayerNode).styleRefs).toEqual({});
  });
});
