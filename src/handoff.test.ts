import { describe, expect, it } from 'vitest';
import {
  addAnnotation,
  addComponentProp,
  addDevResource,
  addLayer,
  annotationsOn,
  bindProp,
  bindVariable,
  codeConnectFor,
  composeFor,
  createCollection,
  createComponent,
  createComponentSet,
  createDocument,
  createInstance,
  createStyle,
  createVariable,
  cssColor,
  cssFor,
  cssVariableName,
  devStatusList,
  distancesBetween,
  getLayer,
  getPages,
  gradientPaint,
  inspectLayer,
  patchNode,
  removeAnnotation,
  removeDevResource,
  safeUrl,
  setCodeConnect,
  setDevStatus,
  setInstanceProp,
  solidPaint,
  spacingInParent,
  swiftFor,
  updateAnnotation,
  type Document,
  type LayerPatch,
  type LayerType,
  type NodeId,
} from './core';
import { createEditorStore, type EditorStore } from './state/editorStore';

/**
 * Developer handoff: what the Inspect tab says about a layer, the code that
 * is written from it, and the notes, links, status and code mapping that
 * are kept on layers.
 */

const RED = { r: 1, g: 0, b: 0 };
const BLUE = { r: 0, g: 0, b: 1 };
const WHITE = { r: 1, g: 1, b: 1 };
const BLACK = { r: 0, g: 0, b: 0 };

const now = (store: EditorStore): Document => store.getState().doc;
const act = (store: EditorStore, fn: (doc: Document) => Document): void => store.getState().apply('Edit', fn);

function start(): { store: EditorStore; pageId: NodeId } {
  const store = createEditorStore(createDocument('Handoff'));
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

function make(store: EditorStore, fn: (doc: Document) => { doc: Document; id: string } | null): string {
  let id = '';
  act(store, (doc) => {
    const out = fn(doc) as { doc: Document; id: string };
    id = out.id;
    return out.doc;
  });
  return id;
}

/** A card laid out as a row, with a box and a label in it. */
function card(): { store: EditorStore; pageId: NodeId; card: NodeId; box: NodeId; label: NodeId } {
  const { store, pageId } = start();
  const cardId = add(store, 'FRAME', pageId, { x: 40, y: 60, width: 240, height: 80, name: 'Card', fills: [solidPaint(WHITE)], cornerRadius: 12, layoutMode: 'HORIZONTAL', itemSpacing: 8, paddingLeft: 16, paddingRight: 16, paddingTop: 12, paddingBottom: 12, counterAxisAlignItems: 'CENTER' } as LayerPatch);
  const box = add(store, 'RECTANGLE', cardId, { width: 40, height: 40, name: 'Box', fills: [solidPaint(RED, 0.5)], strokes: [solidPaint(BLUE)], strokeWeight: 2, cornerRadius: 4, effects: [{ type: 'DROP_SHADOW', color: BLACK, opacity: 0.25, offsetX: 0, offsetY: 4, blur: 8, spread: 0, visible: true }] } as LayerPatch);
  const label = add(store, 'TEXT', cardId, { characters: 'Hello', name: 'Label', fills: [solidPaint(BLUE)], fontSize: 16, fontWeight: 700, letterSpacing: 0.5 } as LayerPatch);
  // The label takes the room that is left in the row: a text of a set width, as wide as the row gives it.
  act(store, (doc) => patchNode(doc, label, { textAutoResize: 'HEIGHT', layoutSizingHorizontal: 'FILL' } as LayerPatch));
  return { store, pageId, card: cardId, box, label };
}

describe('code', () => {
  it('writes the CSS of a layer from the layer: its size, its layout, its look, and the variables it is bound to', () => {
    const c = card();
    expect(cssFor(now(c.store), c.card).split('\n')).toEqual([
      'width: 240px;',
      'height: 80px;',
      'display: flex;',
      'flex-direction: row;',
      'justify-content: flex-start;',
      'align-items: center;',
      'gap: 8px;',
      'padding: 12px 16px;',
      'overflow: hidden;',
      'background: #FFFFFF;',
      'border-radius: 12px;',
    ]);
    expect(cssFor(now(c.store), c.box).split('\n')).toEqual(['width: 40px;', 'height: 40px;', 'background: rgba(255, 0, 0, 0.5);', 'border-radius: 4px;', 'border: 2px solid #0000FF;', 'box-sizing: border-box;', 'box-shadow: 0 4px 8px 0 rgba(0, 0, 0, 0.25);']);
    // The label fills the row, so it has no width of its own.
    expect(cssFor(now(c.store), c.label).split('\n')).toEqual(['flex: 1 0 0;', 'height: fit-content;', 'color: #0000FF;', 'font-family: Inter;', 'font-size: 16px;', 'font-weight: 700;', 'line-height: normal;', 'letter-spacing: 0.5px;']);

    // Bound to variables, the CSS names them, with the value they have as the fallback.
    const collection = make(c.store, (doc) => createCollection(doc, 'Theme'));
    const ink = make(c.store, (doc) => createVariable(doc, collection, 'COLOR', 'Brand/Ink 500', BLUE));
    const gap = make(c.store, (doc) => createVariable(doc, collection, 'FLOAT', 'space md', 8));
    act(c.store, (doc) => bindVariable(bindVariable(doc, [c.label], 'fills.0', ink), [c.card], 'itemSpacing', gap));
    expect(cssVariableName('Brand/Ink 500')).toBe('--brand-ink-500');
    expect(cssFor(now(c.store), c.label)).toContain('color: var(--brand-ink-500, #0000FF);');
    expect(cssFor(now(c.store), c.card)).toContain('gap: var(--space-md, 8px);');

    // A layer placed by hand in a frame, turned and see-through, with a gradient.
    const free = add(c.store, 'FRAME', c.pageId, { x: 400, y: 0, width: 200, height: 200, name: 'Free' });
    const dot = add(c.store, 'ELLIPSE', free, { x: 20, y: 30, width: 50, height: 50, rotation: 45, opacity: 0.8, fills: [gradientPaint('GRADIENT_LINEAR', RED, BLUE, 90)], blendMode: 'MULTIPLY' } as LayerPatch);
    const css = cssFor(now(c.store), dot);
    expect(css).toContain('position: absolute;\nleft: 20px;\ntop: 30px;');
    expect(css).toContain('transform: rotate(45deg);');
    expect(css).toContain('opacity: 0.8;');
    expect(css).toContain('background: linear-gradient(180deg, #FF0000 0%, #0000FF 100%);');
    expect(css).toContain('border-radius: 50%;');
    expect(css).toContain('mix-blend-mode: multiply;');
    expect(cssColor(RED)).toBe('#FF0000');
    expect(cssColor(RED, 0.25)).toBe('rgba(255, 0, 0, 0.25)');
  });

  it('writes a starting point for SwiftUI and for Compose from the same layer', () => {
    const c = card();
    expect(swiftFor(now(c.store), c.label)).toBe(['Text("Hello")', '    .font(.custom("Inter", size: 16))', '    .fontWeight(.bold)', '    .foregroundStyle(Color(red: 0, green: 0, blue: 1))', '    .kerning(0.5)'].join('\n'));
    const swift = swiftFor(now(c.store), c.card);
    expect(swift.split('\n')[0]).toBe('HStack(spacing: 8) {');
    expect(swift).toContain('    // Box\n    // Label\n}');
    expect(swift).toContain('.padding(EdgeInsets(top: 12, leading: 16, bottom: 12, trailing: 16))');
    expect(swift).toContain('.background(Color(red: 1, green: 1, blue: 1))');
    expect(swift).toContain('.clipShape(RoundedRectangle(cornerRadius: 12))');
    expect(swiftFor(now(c.store), c.box)).toContain('RoundedRectangle(cornerRadius: 4)\n    .fill(Color(red: 1, green: 0, blue: 0, opacity: 0.5))');
    expect(swiftFor(now(c.store), c.box)).toContain('.shadow(color: Color(red: 0, green: 0, blue: 0, opacity: 0.25), radius: 4, x: 0, y: 4)');

    expect(composeFor(now(c.store), c.label)).toBe(['Text(', '    text = "Hello",', '    color = Color(0xFF0000FF),', '    fontSize = 16.sp,', '    fontWeight = FontWeight.W700,', '    fontFamily = FontFamily(Font(R.font.inter)),', '    letterSpacing = 0.5.sp,', ')'].join('\n'));
    const compose = composeFor(now(c.store), c.card);
    expect(compose.split('\n')[0]).toBe('Row(');
    expect(compose).toContain('horizontalArrangement = Arrangement.spacedBy(8.dp),');
    expect(compose).toContain('.size(width = 240.dp, height = 80.dp)');
    expect(compose).toContain('.background(Color(0xFFFFFFFF), RoundedCornerShape(12.dp))');
    expect(compose).toContain('.padding(start = 16.dp, top = 12.dp, end = 16.dp, bottom = 12.dp)');
    expect(composeFor(now(c.store), c.box)).toContain('.border(2.dp, Color(0xFF0000FF), RoundedCornerShape(4.dp))');
  });

  it('says how a component is used in code, with an instance’s own values in the snippet', () => {
    const { store, pageId } = start();
    const variant = (name: string, y: number): { frame: NodeId; icon: NodeId } => {
      const frame = add(store, 'FRAME', pageId, { x: 0, y, width: 120, height: 40, name });
      const icon = add(store, 'ELLIPSE', frame, { x: 8, y: 12, width: 16, height: 16, name: 'Icon' });
      act(store, (doc) => (createComponent(doc, [frame]) as { doc: Document }).doc);
      return { frame, icon };
    };
    const primary = variant('Primary', 0);
    const secondary = variant('Secondary', 60);
    const set = make(store, (doc) => createComponentSet(doc, [primary.frame, secondary.frame]));
    const prop = make(store, (doc) => addComponentProp(doc, set, 'BOOLEAN', 'Show icon'));
    act(store, (doc) => bindProp(bindProp(doc, primary.icon, 'BOOLEAN', prop), secondary.icon, 'BOOLEAN', prop));
    const instance = make(store, (doc) => createInstance(doc, secondary.frame, { parentId: pageId, at: { x: 300, y: 0 } }));
    expect(codeConnectFor(now(store), instance)).toBeNull();
    act(store, (doc) => setCodeConnect(doc, set, { component: ' Button ', source: '@acme/ui', snippet: '<Button variant="{Property 1}" icon={{Show icon}} label="{Label}" />' }));
    expect(getLayer(now(store), set)?.codeConnect).toEqual({ component: 'Button', source: '@acme/ui', snippet: '<Button variant="{Property 1}" icon={{Show icon}} label="{Label}" />' });
    // The variant's name is filled in; a property the instance has not set is left as it is written.
    expect(codeConnectFor(now(store), instance)?.code).toBe("import { Button } from '@acme/ui';\n\n<Button variant=\"Secondary\" icon={{Show icon}} label=\"{Label}\" />");
    act(store, (doc) => setInstanceProp(doc, [instance], prop, false));
    expect(codeConnectFor(now(store), instance)?.code).toContain('<Button variant="Secondary" icon={false} label="{Label}" />');
    // A layer inside the instance, and the variant itself, give the same mapping.
    expect(codeConnectFor(now(store), primary.frame)?.code).toContain('variant="Primary"');
    // Only a component or a set has a mapping; an empty one is none.
    expect(setCodeConnect(now(store), instance, { component: 'X', source: '', snippet: '' })).toBe(now(store));
    act(store, (doc) => setCodeConnect(doc, set, { component: '', source: 'x', snippet: '  ' }));
    expect(getLayer(now(store), set)?.codeConnect).toBeNull();
    store.getState().undo();
    expect(getLayer(now(store), set)?.codeConnect?.component).toBe('Button');
  });
});

describe('inspection', () => {
  it('says what a layer is, in sections, with the variables and styles its values come from', () => {
    const c = card();
    const style = make(c.store, (doc) => createStyle(doc, c.box, 'fills', 'Accent'));
    const collection = make(c.store, (doc) => createCollection(doc, 'Theme'));
    const ink = make(c.store, (doc) => createVariable(doc, collection, 'COLOR', 'ink', BLUE));
    act(c.store, (doc) => bindVariable(doc, [c.label], 'fills.0', ink));
    const find = (id: NodeId, title: string) => inspectLayer(now(c.store), id).find((section) => section.title === title)?.rows;
    expect(inspectLayer(now(c.store), c.card).map((section) => section.title)).toEqual(['Layout', 'Auto Layout', 'Colours']);
    expect(find(c.card, 'Layout')).toEqual([{ label: 'Width', value: '240px', token: undefined }, { label: 'Height', value: '80px', token: undefined }, { label: 'X', value: '40px' }, { label: 'Y', value: '60px' }, { label: 'Corner radius', value: '12px', token: undefined }]);
    expect(find(c.card, 'Auto Layout')).toEqual([
      { label: 'Direction', value: 'Horizontal' },
      { label: 'Spacing', value: '8px', token: undefined },
      { label: 'Padding', value: '12px 16px 12px 16px', token: undefined },
      { label: 'Along', value: 'Start' },
      { label: 'Across', value: 'Centre' },
    ]);
    expect(inspectLayer(now(c.store), c.box).map((section) => section.title)).toEqual(['Layout', 'Spacing in its parent', 'In its layout', 'Colours', 'Borders', 'Effects', 'Variables and styles']);
    // The box is 16 in from the left and centred in the 80 high card.
    expect(find(c.box, 'Spacing in its parent')).toEqual([{ label: 'Left', value: '16px' }, { label: 'Top', value: '20px' }, { label: 'Right', value: '184px' }, { label: 'Bottom', value: '20px' }]);
    expect(find(c.box, 'Layout')).toContainEqual({ label: 'On the page', value: '56, 80' });
    expect(find(c.box, 'Colours')).toEqual([{ label: 'Fill', value: 'rgba(255, 0, 0, 0.5)', color: RED, token: 'Accent' }]);
    expect(find(c.box, 'Borders')).toEqual([{ label: 'Stroke', value: '#0000FF', color: BLUE, token: undefined }, { label: 'Weight', value: '2px', token: undefined }, { label: 'Position', value: 'inside' }]);
    expect(find(c.box, 'Effects')).toEqual([{ label: 'Drop shadow', value: '0px 4px 8px 0px rgba(0, 0, 0, 0.25)', color: BLACK, token: undefined }]);
    expect(find(c.box, 'Variables and styles')).toEqual([{ label: 'Fill style', value: 'Accent' }]);
    expect(find(c.label, 'Typography')).toEqual([
      { label: 'Font', value: 'Inter', token: undefined },
      { label: 'Size', value: '16px', token: undefined },
      { label: 'Weight', value: '700' },
      { label: 'Line height', value: 'Auto', token: undefined },
      { label: 'Letter spacing', value: '0.5px', token: undefined },
      { label: 'Align', value: 'left' },
      { label: 'Content', value: 'Hello', token: undefined },
    ]);
    expect(find(c.label, 'In its layout')).toEqual([{ label: 'Width', value: 'Fill container' }, { label: 'Height', value: 'Hug contents' }]);
    expect(find(c.label, 'Colours')).toEqual([{ label: 'Fill', value: '#0000FF', color: BLUE, token: 'ink' }]);
    expect(find(c.label, 'Variables and styles')).toEqual([{ label: 'ink', value: '#0000FF (--ink)', color: BLUE }]);
    expect(style).not.toBe('');
    expect(spacingInParent(now(c.store), c.card)).toBeNull();
    // What a measurement between two boxes says: the gap where they are apart, nothing where they overlap that way.
    expect(distancesBetween({ x: 0, y: 0, width: 10, height: 10 }, { x: 30, y: 4, width: 10, height: 10 })).toEqual({ horizontal: 20, vertical: null });
    expect(distancesBetween({ x: 30, y: 40, width: 10, height: 10 }, { x: 0, y: 0, width: 10, height: 10 })).toEqual({ horizontal: 20, vertical: 30 });
  });
});

describe('handing off', () => {
  it('marks what is ready, leaves numbered notes and safe links on layers, each an undo step', () => {
    const c = card();
    act(c.store, (doc) => setDevStatus(doc, [c.card], 'READY'));
    act(c.store, (doc) => setDevStatus(doc, [c.box], 'COMPLETED'));
    expect(devStatusList(now(c.store)).map(({ layer }) => [layer.name, layer.devStatus])).toEqual([['Box', 'COMPLETED'], ['Card', 'READY']]);
    c.store.getState().undo();
    expect(devStatusList(now(c.store))).toHaveLength(1);

    const first = make(c.store, (doc) => addAnnotation(doc, c.label, 'Truncate at one line'));
    make(c.store, (doc) => addAnnotation(doc, c.card, 'Whole card is a link'));
    const third = make(c.store, (doc) => addAnnotation(doc, c.label, 'Use the system font on Android'));
    // Numbered in the order the layers are painted: the card, then what is in it.
    expect(annotationsOn(now(c.store), c.pageId).map((placed) => [placed.number, placed.annotation.text])).toEqual([[1, 'Whole card is a link'], [2, 'Truncate at one line'], [3, 'Use the system font on Android']]);
    act(c.store, (doc) => updateAnnotation(doc, c.label, first, 'Truncate at two lines'));
    act(c.store, (doc) => removeAnnotation(doc, c.label, third));
    expect(getLayer(now(c.store), c.label)?.annotations).toEqual([{ id: first, text: 'Truncate at two lines' }]);

    // A link has to be an address that only goes somewhere.
    expect(safeUrl('https://example.com/docs')).toBe('https://example.com/docs');
    expect(safeUrl('mailto:dev@example.com')).toBe('mailto:dev@example.com');
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'example.com', 'https://a b', '']) expect(safeUrl(bad)).toBeNull();
    expect(addDevResource(now(c.store), c.card, 'Bad', 'javascript:alert(1)')).toBeNull();
    const link = make(c.store, (doc) => addDevResource(doc, c.card, ' Storybook ', 'https://example.com/storybook'));
    make(c.store, (doc) => addDevResource(doc, c.card, '', 'https://example.com/ticket'));
    expect(getLayer(now(c.store), c.card)?.devResources).toMatchObject([{ name: 'Storybook', url: 'https://example.com/storybook' }, { name: 'https://example.com/ticket' }]);
    act(c.store, (doc) => removeDevResource(doc, c.card, link));
    expect(getLayer(now(c.store), c.card)?.devResources).toHaveLength(1);
    // None of it is taken into an instance of a component: it belongs to the layer it was put on.
    act(c.store, (doc) => (createComponent(patchNode(doc, c.card, { layoutMode: 'NONE' } as LayerPatch), [c.card]) as { doc: Document }).doc);
    const instance = make(c.store, (doc) => createInstance(doc, c.card, { parentId: c.pageId, at: { x: 400, y: 0 } }));
    expect(getLayer(now(c.store), instance)).toMatchObject({ devStatus: 'NONE', annotations: [], devResources: [] });
    expect(annotationsOn(now(c.store), c.pageId)).toHaveLength(2);
  });
});
