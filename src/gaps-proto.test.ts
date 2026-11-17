import { describe, expect, it } from 'vitest';
import {
  addLayer,
  addMode,
  addReaction,
  approximateMeasurer,
  compileSchema,
  createCollection,
  createDocument,
  createStyle,
  createVariable,
  CURRENT_SCHEMA_VERSION,
  DEFAULT_TRANSITION,
  encodeBinarySchema,
  getLayer,
  getPages,
  keyComboOf,
  keyCombosMatch,
  keyOf,
  layoutText,
  newAction,
  newTrigger,
  normalizeKeyCombo,
  parseFile,
  parseSchemaText,
  patchNode,
  Player,
  readFig,
  repairDocument,
  setVariableMode,
  setVariableValue,
  sha256Hex,
  solidPaint,
  writeFig,
  type Action,
  type Document,
  type FigEnvironment,
  type KiwiObject,
  type LayerNode,
  type LayerPatch,
  type LayerType,
  type NodeId,
  type TextNode,
  type Transition,
} from './core';
import { createEditorStore, type EditorStore } from './state/editorStore';

/**
 * Schema version 25: prototype triggers for the pointer leaving a layer and
 * being let go over it, keys with modifier keys, "set variable" in the mode
 * that is in effect, and space between the paragraphs of text. Interactions
 * are played with the player, told where the pointer is; text is laid out
 * with the fixed test measurer (a character is half the font size wide).
 */

const zlib = (await import('node:zlib' as string)) as {
  deflateRawSync(bytes: Uint8Array): Uint8Array;
  inflateRawSync(bytes: Uint8Array): Uint8Array;
};

const env: FigEnvironment = {
  inflateRaw: async (bytes) => new Uint8Array(zlib.inflateRawSync(bytes)),
  deflateRaw: async (bytes) => new Uint8Array(zlib.deflateRawSync(bytes)),
  sha256Hex,
  measurer: approximateMeasurer,
};

const RED = { r: 1, g: 0, b: 0 };
const BLUE = { r: 0, g: 0, b: 1 };
const INSTANT: Transition = { ...DEFAULT_TRANSITION, type: 'INSTANT' };

const now = (store: EditorStore): Document => store.getState().doc;
const act = (store: EditorStore, fn: (doc: Document) => Document): void => store.getState().apply('Edit', fn);

function make(store: EditorStore, fn: (doc: Document) => { doc: Document; id: string } | null): string {
  let id = '';
  act(store, (doc) => {
    const out = fn(doc) as { doc: Document; id: string };
    id = out.id;
    return out.doc;
  });
  return id;
}

function add(store: EditorStore, type: LayerType, parentId: NodeId, props: LayerPatch): NodeId {
  return make(store, (doc) => addLayer(doc, type, parentId, props));
}

function react(store: EditorStore, layerId: NodeId, trigger: Parameters<typeof newTrigger>, actions: Action[]): string {
  return make(store, (doc) => addReaction(doc, layerId, newTrigger(...trigger), actions));
}

/** Two 200 × 300 screens; the first has a 120 × 80 card at (20, 100) with a 20 × 20 icon at (10, 10) in it. */
function screens(): { store: EditorStore; pageId: NodeId; a: NodeId; b: NodeId; card: NodeId; icon: NodeId } {
  const store = createEditorStore(createDocument('Version 25'));
  const pageId = (getPages(now(store))[0] as { id: NodeId }).id;
  const a = add(store, 'FRAME', pageId, { x: 0, y: 0, width: 200, height: 300, name: 'Home' });
  const b = add(store, 'FRAME', pageId, { x: 400, y: 0, width: 200, height: 300, name: 'Detail', fills: [solidPaint(BLUE)] });
  const card = add(store, 'FRAME', a, { x: 20, y: 100, width: 120, height: 80, name: 'Card', fills: [solidPaint(RED)] });
  const icon = add(store, 'RECTANGLE', card, { x: 10, y: 10, width: 20, height: 20, name: 'Icon', fills: [solidPaint(BLUE)] });
  return { store, pageId, a, b, card, icon };
}

const play = (store: EditorStore, startId: NodeId): Player => new Player({ doc: now(store), startId, measurer: approximateMeasurer });

describe('mouse leave and mouse up', () => {
  it('runs "mouse leave" once when the pointer leaves the layer, not when it moves onto a layer inside it', () => {
    const s = screens();
    const collection = make(s.store, (doc) => createCollection(doc, 'State'));
    const left = make(s.store, (doc) => createVariable(doc, collection, 'FLOAT', 'left', 0));
    const ups = make(s.store, (doc) => createVariable(doc, collection, 'FLOAT', 'ups', 0));
    react(s.store, s.card, ['MOUSE_LEAVE'], [newAction('SET_VARIABLE', { variableId: left, expression: '{left} + 1' })]);
    react(s.store, s.card, ['MOUSE_UP'], [newAction('SET_VARIABLE', { variableId: ups, expression: '{ups} + 1' })]);
    react(s.store, s.card, ['ON_CLICK'], [newAction('NAVIGATE', { destinationId: s.b, transition: INSTANT })]);
    const player = play(s.store, s.a);

    // Over the icon, then over the card beside it: the card has not been left, and the icon has no interaction of its own.
    player.pointerMove({ x: 45, y: 115 });
    player.pointerMove({ x: 100, y: 150 });
    expect(player.value('left')).toBe(0);
    // Off the card: it runs once, and moving on outside does not run it again.
    player.pointerMove({ x: 150, y: 250 });
    expect(player.value('left')).toBe(1);
    player.pointerMove({ x: 160, y: 250 });
    expect(player.value('left')).toBe(1);
    // The pointer leaving the screen leaves the card too.
    player.pointerMove({ x: 45, y: 115 });
    player.pointerLeave();
    expect(player.value('left')).toBe(2);

    // Pressed outside and let go over the card: "mouse up" runs, and it is not a click.
    player.pointerMove({ x: 150, y: 250 });
    player.pointerDown({ x: 150, y: 250 });
    expect(player.pointerUp({ x: 40, y: 120 })).toBe(true);
    expect(player.value('ups')).toBe(1);
    expect(player.screenId).toBe(s.a);
    // A click on it runs "mouse up" first and then the click, which goes to the other screen.
    player.pointerDown({ x: 40, y: 120 });
    player.pointerUp({ x: 40, y: 120 });
    expect(player.value('ups')).toBe(2);
    expect(player.screenId).toBe(s.b);
    // The card went with the screen it was on: that is not leaving it.
    player.pointerMove({ x: 190, y: 290 });
    expect(player.value('left')).toBe(2);
    // The card shows where a click does something.
    player.restart();
    expect(player.hotspots()).toContainEqual({ x: 20, y: 100, width: 120, height: 80 });
  });

  it('keeps the new triggers through saving and opening, and refuses one it does not know', () => {
    const s = screens();
    react(s.store, s.card, ['MOUSE_LEAVE'], [newAction('BACK')]);
    react(s.store, s.card, ['MOUSE_UP'], [newAction('BACK')]);
    const reopened = repairDocument(JSON.parse(JSON.stringify(now(s.store))));
    expect(reopened.repairs).toEqual([]);
    expect(getLayer(reopened.doc, s.card)?.reactions.map((reaction) => reaction.trigger.type)).toEqual(['MOUSE_LEAVE', 'MOUSE_UP']);
    const raw = JSON.parse(JSON.stringify(now(s.store))) as { nodes: Record<string, Record<string, unknown>> };
    (raw.nodes[s.card]!.reactions as { trigger: { type: string } }[])[0]!.trigger.type = 'MOUSE_WIGGLE';
    expect(getLayer(repairDocument(raw).doc, s.card)?.reactions.map((reaction) => reaction.trigger.type)).toEqual(['MOUSE_UP']);
  });
});

describe('keys with modifier keys', () => {
  it('writes a key and its modifiers one way, from text or from a key pressed', () => {
    expect(normalizeKeyCombo('control+shift+k')).toBe('Ctrl+Shift+K');
    expect(normalizeKeyCombo('Shift+Alt+Ctrl+s')).toBe('Ctrl+Alt+Shift+S');
    expect(normalizeKeyCombo('cmd+Enter')).toBe('Meta+Enter');
    expect(normalizeKeyCombo('Ctrl++')).toBe('Ctrl++');
    // Keys on their own, and text that is not a combination, are left as they are.
    for (const key of ['Enter', 'a', '+', ' ', 'a+b', 'Gamepad0']) expect(normalizeKeyCombo(key)).toBe(key);
    expect(keyComboOf({ key: 'k', ctrlKey: true })).toBe('Ctrl+K');
    expect(keyComboOf({ key: 'Enter', shiftKey: true })).toBe('Shift+Enter');
    expect(keyComboOf({ key: 's', ctrlKey: true, altKey: true })).toBe('Ctrl+Alt+S');
    expect(keyComboOf({ key: 'K', shiftKey: true })).toBe('Shift+K');
    // Shift that only makes the character ("!" is Shift and 1) is part of the key.
    expect(keyComboOf({ key: '!', shiftKey: true })).toBe('!');
    expect(keyCombosMatch('Ctrl+K', 'Ctrl+k')).toBe(true);
    expect(keyCombosMatch('k', 'Ctrl+K')).toBe(false);
    expect(keyCombosMatch('Ctrl+K', 'Ctrl+Shift+K')).toBe(false);
    expect(keyCombosMatch('a', 'A')).toBe(true);
  });

  it('runs an interaction only for its key with exactly its modifiers', () => {
    const s = screens();
    const collection = make(s.store, (doc) => createCollection(doc, 'State'));
    const count = make(s.store, (doc) => createVariable(doc, collection, 'FLOAT', 'count', 0));
    react(s.store, s.a, ['ON_KEY', { key: 'Ctrl+K' }], [newAction('NAVIGATE', { destinationId: s.b, transition: INSTANT })]);
    react(s.store, s.a, ['ON_KEY', { key: 'k' }], [newAction('SET_VARIABLE', { variableId: count, expression: '{count} + 1' })]);
    react(s.store, s.a, ['ON_KEY', { key: 'Shift+Enter' }], [newAction('SET_VARIABLE', { variableId: count, expression: '{count} + 10' })]);
    const player = play(s.store, s.a);
    // K alone, and K with Shift (which nothing waits for).
    expect(player.key('k')).toBe(true);
    expect(player.value('count')).toBe(1);
    expect(player.key('K', { shiftKey: true })).toBe(false);
    // Enter alone is not Shift+Enter.
    expect(player.key('Enter')).toBe(false);
    expect(player.key('Enter', { shiftKey: true })).toBe(true);
    expect(player.value('count')).toBe(11);
    // Ctrl+K, as a keyboard event gives it.
    expect(player.key('k', { ctrlKey: true, altKey: false, shiftKey: false, metaKey: false })).toBe(true);
    expect(player.screenId).toBe(s.b);
    expect(player.value('count')).toBe(11);
  });

  it('keeps a key with modifiers in a file, written the one way', () => {
    const s = screens();
    react(s.store, s.a, ['ON_KEY', { key: 'Ctrl+Shift+K' }], [newAction('BACK')]);
    const reopened = repairDocument(JSON.parse(JSON.stringify(now(s.store))));
    expect(reopened.repairs).toEqual([]);
    expect(getLayer(reopened.doc, s.a)?.reactions[0]?.trigger.key).toBe('Ctrl+Shift+K');
    // A file that writes it another way has it written the one way.
    const raw = JSON.parse(JSON.stringify(now(s.store))) as { nodes: Record<string, Record<string, unknown>> };
    (raw.nodes[s.a]!.reactions as { trigger: { key: string } }[])[0]!.trigger.key = 'shift+control+k';
    expect(getLayer(repairDocument(raw).doc, s.a)?.reactions[0]?.trigger.key).toBe('Ctrl+Shift+K');
  });

  it('turns Figma key codes with modifier codes into a key with modifiers', () => {
    expect(keyOf([17, 16, 75])).toBe('Ctrl+Shift+K');
    expect(keyOf([91, 13])).toBe('Meta+Enter');
    expect(keyOf([93, 18, 83])).toBe('Alt+Meta+S');
    expect(keyOf([39])).toBe('ArrowRight');
    expect(keyOf([65])).toBe('a');
    // Modifier keys alone: the last is the key.
    expect(keyOf([16])).toBe('Shift');
    expect(keyOf([])).toBe('');
  });
});

describe('set variable in the mode in effect', () => {
  it('sets the value of the mode chosen where the interaction is, and reads that mode in expressions', () => {
    const s = screens();
    const theme = make(s.store, (doc) => createCollection(doc, 'Theme'));
    const light = now(s.store).variableCollections[theme]!.modes[0]!.id;
    const dark = make(s.store, (doc) => addMode(doc, theme, 'Dark'));
    const count = make(s.store, (doc) => createVariable(doc, theme, 'FLOAT', 'count', 0));
    act(s.store, (doc) => setVariableValue(doc, count, dark, 100));
    // The first screen is in the dark mode; the second has none chosen, so it is in the first mode, light.
    act(s.store, (doc) => setVariableMode(doc, s.a, theme, dark));
    react(s.store, s.card, ['ON_CLICK'], [newAction('SET_VARIABLE', { variableId: count, expression: '{count} + 1' }), newAction('NAVIGATE', { destinationId: s.b, transition: INSTANT })]);
    react(s.store, s.b, ['ON_CLICK'], [newAction('SET_VARIABLE', { variableId: count, expression: '{count} + 1' })]);
    const player = play(s.store, s.a);
    expect(player.value('count')).toBe(100);
    player.pointerDown({ x: 100, y: 150 });
    player.pointerUp({ x: 100, y: 150 });
    // Dark was 100 and is now 101; light is untouched.
    expect(player.doc.variables[count]!.valuesByMode).toEqual({ [light]: 0, [dark]: 101 });
    // On the second screen the expression reads light's value.
    expect(player.screenId).toBe(s.b);
    expect(player.value('count')).toBe(0);
    player.pointerDown({ x: 100, y: 150 });
    player.pointerUp({ x: 100, y: 150 });
    expect(player.doc.variables[count]!.valuesByMode).toEqual({ [light]: 1, [dark]: 101 });
    // The design itself is as it was.
    expect(now(s.store).variables[count]!.valuesByMode).toEqual({ [light]: 0, [dark]: 100 });
  });
});

describe('space between paragraphs', () => {
  function textLayer(props: LayerPatch): { store: EditorStore; id: NodeId } {
    const s = screens();
    return { store: s.store, id: add(s.store, 'TEXT', s.a, { x: 0, y: 0, ...props }) };
  }

  it('adds the spacing after each paragraph but the last, never after a line that wraps', () => {
    // Font size 16: lines 19 high, characters 8 wide. "aaa bbb" wraps in a box 40 wide; "ccc" is a paragraph of its own.
    const { store, id } = textLayer({ characters: 'aaa bbb\nccc', textAutoResize: 'HEIGHT', width: 40, paragraphSpacing: 10 } as LayerPatch);
    const layer = getLayer(now(store), id) as TextNode;
    const layout = layoutText(layer, approximateMeasurer);
    expect(layout.lines.map((line) => line.text)).toEqual(['aaa', 'bbb', 'ccc']);
    expect(layout.lines.map((line) => line.top)).toEqual([0, 19, 48]);
    expect(layout.height).toBe(67);
    // Auto height follows.
    expect(layer.height).toBe(67);
    // Without it, the lines are as they were.
    const plain = layoutText({ ...layer, paragraphSpacing: 0 }, approximateMeasurer);
    expect(plain.lines.map((line) => line.top)).toEqual([0, 19, 38]);
    expect(plain.height).toBe(57);
    // Text that grows with what is typed takes it too; a single paragraph has none.
    const auto = textLayer({ characters: 'One\nTwo\nThree', paragraphSpacing: 6 } as LayerPatch);
    expect(getLayer(now(auto.store), auto.id)?.height).toBe(19 * 3 + 12);
    const single = textLayer({ characters: 'One', paragraphSpacing: 6 } as LayerPatch);
    expect(getLayer(now(single.store), single.id)?.height).toBe(19);
  });

  it('is changed with undo, kept through saving and opening, and mended when it is not a number', () => {
    const { store, id } = textLayer({ characters: 'One\nTwo' });
    expect((getLayer(now(store), id) as TextNode).paragraphSpacing).toBe(0);
    expect(getLayer(now(store), id)?.height).toBe(38);
    act(store, (doc) => patchNode(doc, id, { paragraphSpacing: 20 } as LayerPatch));
    expect(getLayer(now(store), id)?.height).toBe(58);
    store.getState().undo();
    expect((getLayer(now(store), id) as TextNode).paragraphSpacing).toBe(0);
    expect(getLayer(now(store), id)?.height).toBe(38);
    store.getState().redo();
    const reopened = repairDocument(JSON.parse(JSON.stringify(now(store))));
    expect(reopened.repairs).toEqual([]);
    expect(reopened.doc).toEqual(now(store));
    const raw = JSON.parse(JSON.stringify(now(store))) as { nodes: Record<string, Record<string, unknown>> };
    raw.nodes[id]!.paragraphSpacing = 'wide';
    expect((getLayer(repairDocument(raw).doc, id) as TextNode).paragraphSpacing).toBe(0);
    raw.nodes[id]!.paragraphSpacing = -5;
    expect((getLayer(repairDocument(raw).doc, id) as TextNode).paragraphSpacing).toBe(0);
  });

  it('is part of a text style made from a layer, and of what the style gives the layers that use it', () => {
    const { store, id } = textLayer({ characters: 'One\nTwo', paragraphSpacing: 12 } as LayerPatch);
    const style = make(store, (doc) => createStyle(doc, id, 'text', 'Body'));
    expect(now(store).styles[style]!.text.paragraphSpacing).toBe(12);
    const other = add(store, 'TEXT', getLayer(now(store), id)!.parentId as NodeId, { x: 0, y: 100, characters: 'A\nB' });
    act(store, (doc) => patchNode(doc, other, { styleRefs: { text: style } } as LayerPatch));
    expect((getLayer(now(store), other) as TextNode).paragraphSpacing).toBe(12);
    expect(getLayer(now(store), other)?.height).toBe(50);
    // A style without it (made before version 25) opens without a repair and gives no spacing.
    const raw = JSON.parse(JSON.stringify(now(store))) as { styles: Record<string, { text: Record<string, unknown> }> };
    delete raw.styles[style]!.text.paragraphSpacing;
    const reopened = repairDocument(raw);
    expect(reopened.repairs).toEqual([]);
    expect(reopened.doc.styles[style]!.text.paragraphSpacing).toBeUndefined();
  });

  it('is written to a .fig file and read back', async () => {
    const { store, id } = textLayer({ characters: 'One\nTwo', paragraphSpacing: 14 } as LayerPatch);
    const { bytes } = await writeFig(now(store), {}, env);
    const read = await readFig(bytes, 'Back', env);
    const back = Object.values(read.doc.nodes).find((node) => node.type === 'TEXT' && (node as TextNode).characters === 'One\nTwo') as TextNode;
    expect(back.paragraphSpacing).toBe(14);
    expect(back.height).toBe(getLayer(now(store), id)?.height);
  });
});

describe('a Figma file with these', () => {
  /** Figma's field names, with field numbers of this test's. */
  const SCHEMA = `
    struct GUID { uint sessionID; uint localID; }
    struct Vector { float x; float y; }
    struct Matrix { float m00; float m01; float m02; float m10; float m11; float m12; }
    message ParentIndex { GUID guid = 1; string position = 2; }
    message TextData { string characters = 1; }
    message KeyTrigger { int[] keyCodes = 1; }
    message PrototypeEvent { string interactionType = 1; KeyTrigger keyTrigger = 2; }
    message PrototypeAction { string connectionType = 1; string connectionURL = 2; }
    message PrototypeInteraction { PrototypeEvent event = 1; PrototypeAction[] actions = 2; }
    message NodeChange {
      GUID guid = 1; ParentIndex parentIndex = 2; string type = 3; string name = 4; Vector size = 5; Matrix transform = 6;
      TextData textData = 7; float fontSize = 8; float paragraphSpacing = 9; float paragraphIndent = 10; PrototypeInteraction[] prototypeInteractions = 11;
    }
    message Blob { byte[] bytes = 1; }
    message Message { uint type = 1; NodeChange[] nodeChanges = 2; Blob[] blobs = 3; }
  `;
  const g = (session: number, local: number): KiwiObject => ({ sessionID: session, localID: local });
  const at = (x: number, y: number): KiwiObject => ({ m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y });

  function figma(nodeChanges: KiwiObject[]): Uint8Array {
    const schema = parseSchemaText(SCHEMA);
    const message = compileSchema(schema).encode('Message', { type: 1, nodeChanges, blobs: [] });
    const parts = [encodeBinarySchema(schema), message].map((bytes) => new Uint8Array(zlib.deflateRawSync(bytes)));
    const canvas = new Uint8Array(12 + parts.reduce((sum, part) => sum + 4 + part.length, 0));
    const view = new DataView(canvas.buffer);
    canvas.set(new TextEncoder().encode('fig-kiwi'));
    view.setUint32(8, 101, true);
    let offset = 12;
    for (const part of parts) {
      view.setUint32(offset, part.length, true);
      canvas.set(part, offset + 4);
      offset += 4 + part.length;
    }
    return canvas;
  }

  it('reads mouse leave and mouse up, keys with modifiers and space between paragraphs, and lists only the indent', async () => {
    const link = (url: string): KiwiObject[] => [{ connectionType: 'URL', connectionURL: url }];
    const file = figma([
      { guid: g(0, 0), type: 'DOCUMENT', name: 'Document' },
      { guid: g(0, 1), type: 'CANVAS', name: 'Page', parentIndex: { guid: g(0, 0), position: 'a' } },
      {
        guid: g(1, 1),
        type: 'FRAME',
        name: 'Screen',
        parentIndex: { guid: g(0, 1), position: 'a' },
        size: { x: 200, y: 300 },
        transform: at(0, 0),
        prototypeInteractions: [
          { event: { interactionType: 'MOUSE_LEAVE' }, actions: link('https://example.com/leave') },
          { event: { interactionType: 'MOUSE_OUT' }, actions: link('https://example.com/out') },
          { event: { interactionType: 'MOUSE_UP' }, actions: link('https://example.com/up') },
          { event: { interactionType: 'ON_KEY_DOWN', keyTrigger: { keyCodes: [17, 16, 75] } }, actions: link('https://example.com/key') },
        ],
      },
      { guid: g(1, 2), type: 'TEXT', name: 'Copy', parentIndex: { guid: g(1, 1), position: 'a' }, size: { x: 100, y: 50 }, transform: at(0, 0), textData: { characters: 'One\nTwo' }, fontSize: 16, paragraphSpacing: 12, paragraphIndent: 8 },
    ]);
    const read = await readFig(file, 'Figma', env);
    const layers = Object.values(read.doc.nodes) as LayerNode[];
    const screen = layers.find((node) => node.name === 'Screen')!;
    expect(screen.reactions.map((reaction) => [reaction.trigger.type, reaction.trigger.key])).toEqual([
      ['MOUSE_LEAVE', ''],
      ['MOUSE_LEAVE', ''],
      ['MOUSE_UP', ''],
      ['ON_KEY', 'Ctrl+Shift+K'],
    ]);
    expect((layers.find((node) => node.name === 'Copy') as TextNode).paragraphSpacing).toBe(12);
    expect(read.notConverted).toEqual(['Paragraph indents (the paragraphs start at the edge): 1']);
  });
});

describe('opening older files', () => {
  it('opens a version 24 file, whose text has no space between paragraphs, and keeps it through saving and opening', () => {
    const { store, id } = (() => {
      const s = screens();
      return { store: s.store, id: add(s.store, 'TEXT', s.a, { x: 0, y: 0, characters: 'One\nTwo' }) };
    })();
    react(store, getLayer(now(store), id)!.parentId as NodeId, ['ON_KEY', { key: 'Enter' }], [newAction('BACK')]);
    const current = now(store);
    const v24 = JSON.parse(JSON.stringify(current)) as { nodes: Record<string, Record<string, unknown>> };
    for (const nodeId in v24.nodes) delete v24.nodes[nodeId]!.paragraphSpacing;
    const parsed = parseFile({ format: 'evora', schemaVersion: 24, meta: { createdAt: '2026-11-17T10:00:00.000Z', updatedAt: '2026-11-17T10:00:00.000Z' }, document: v24 });
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(25);
    expect(parsed.repairs).toEqual([]);
    expect(parsed.file.document).toEqual(current);
    expect((getLayer(parsed.file.document, id) as TextNode).paragraphSpacing).toBe(0);
  });
});
