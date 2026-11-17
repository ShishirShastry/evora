import { describe, expect, it } from 'vitest';
import {
  addFlow,
  addLayer,
  addReaction,
  approximateMeasurer,
  bindVariable,
  connect,
  connectionsOn,
  createCollection,
  createComponent,
  createComponentSet,
  createDocument,
  createInstance,
  createVariable,
  cubicBezier,
  CURRENT_SCHEMA_VERSION,
  DEFAULT_TRANSITION,
  evaluate,
  expressionProblem,
  ExpressionError,
  flowAt,
  flowsOf,
  getLayer,
  getPages,
  mirrorId,
  newAction,
  newTrigger,
  parseFile,
  patchNode,
  Player,
  prototypeFrames,
  removeFlow,
  removeReaction,
  renameFlow,
  repairDocument,
  solidPaint,
  STAGE_ID,
  startFrame,
  updateReaction,
  type Action,
  type Document,
  type FrameNode,
  type LayerNode,
  type LayerPatch,
  type LayerType,
  type NodeId,
  type SolidPaint,
  type TextNode,
  type Transition,
  type VariableType,
  type VariableValue,
} from './core';
import { createEditorStore, type EditorStore } from './state/editorStore';

/**
 * Prototyping: building interactions through the editor store, and playing
 * them with the player, which is told where the pointer is and what time it
 * is. What the player shows is read from the stage document it would paint.
 */

const RED = { r: 1, g: 0, b: 0 };
const GREEN = { r: 0, g: 1, b: 0 };
const BLUE = { r: 0, g: 0, b: 1 };
const BLACK = { r: 0, g: 0, b: 0 };
const INSTANT: Transition = { ...DEFAULT_TRANSITION, type: 'INSTANT' };
const linear = (type: Transition['type'], duration: number, more: Partial<Transition> = {}): Transition => ({ ...DEFAULT_TRANSITION, type, duration, easing: 'LINEAR', ...more });

const now = (store: EditorStore): Document => store.getState().doc;
const act = (store: EditorStore, fn: (doc: Document) => Document): void => store.getState().apply('Edit', fn);

function start(): { store: EditorStore; pageId: NodeId } {
  const store = createEditorStore(createDocument('Prototype'));
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

/** An interaction on a layer. */
function react(store: EditorStore, layerId: NodeId, trigger: Parameters<typeof newTrigger>, actions: Action[]): string {
  return make(store, (doc) => addReaction(doc, layerId, newTrigger(...trigger), actions));
}

function variable(store: EditorStore, type: VariableType, name: string, value: VariableValue, collection?: string): { id: string; collection: string } {
  const collectionId = collection ?? make(store, (doc) => createCollection(doc, 'State'));
  return { id: make(store, (doc) => createVariable(doc, collectionId, type, name, value)), collection: collectionId };
}

const play = (store: EditorStore, startId: NodeId, viewport?: { width: number; height: number }): Player => new Player({ doc: now(store), startId, measurer: approximateMeasurer, viewport });
const click = (player: Player, x: number, y: number): boolean => {
  player.pointerMove({ x, y });
  player.pointerDown({ x, y });
  return player.pointerUp({ x, y });
};
/** A layer as the stage has it now. */
const staged = (player: Player, id: NodeId): LayerNode => player.stage().nodes[id] as LayerNode;
const onStage = (player: Player): NodeId[] => Object.values(player.stage().nodes).filter((node) => node.parentId === STAGE_ID).sort((a, b) => (a.order < b.order ? -1 : 1)).map((node) => node.id);

/** Two 200 × 300 screens; the first has a 100 × 40 button at (20, 20). */
function screens(): { store: EditorStore; pageId: NodeId; a: NodeId; b: NodeId; button: NodeId } {
  const { store, pageId } = start();
  const a = add(store, 'FRAME', pageId, { x: 0, y: 0, width: 200, height: 300, name: 'Home' });
  const b = add(store, 'FRAME', pageId, { x: 400, y: 0, width: 200, height: 300, name: 'Detail', fills: [solidPaint(BLUE)] });
  const button = add(store, 'RECTANGLE', a, { x: 20, y: 20, width: 100, height: 40, name: 'Button', fills: [solidPaint(RED)] });
  return { store, pageId, a, b, button };
}

describe('expressions', () => {
  const values: Record<string, number | string | boolean> = { count: 2, name: 'Ada', open: false, 'cart/total': 12.5 };
  const lookup = (name: string) => (name in values ? (values[name] as number | string | boolean) : null);
  it('works out arithmetic, text, comparisons and logic over variables', () => {
    expect(evaluate('{count} + 1', lookup)).toBe(3);
    expect(evaluate('({count} + 1) * 2 - 8 / 4 % 3', lookup)).toBe(4);
    expect(evaluate('-{count} * 2', lookup)).toBe(-4);
    expect(evaluate('"Hello, " + {name}', lookup)).toBe('Hello, Ada');
    expect(evaluate("'Items: ' + {count}", lookup)).toBe('Items: 2');
    expect(evaluate('{cart/total} > 10 and not {open}', lookup)).toBe(true);
    expect(evaluate('{count} == 2 || {name} == "Bob"', lookup)).toBe(true);
    expect(evaluate('{name} != "Ada" && true', lookup)).toBe(false);
    expect(evaluate('!{open}', lookup)).toBe(true);
    expect(evaluate('{count} >= 3', lookup)).toBe(false);
    expect(evaluate('#FF0000', lookup)).toEqual(RED);
    expect(evaluate('#ff0000 == #FF0000', lookup)).toBe(true);
    expect(evaluate('true', lookup)).toBe(true);
  });
  it('says what is wrong with an expression', () => {
    expect(() => evaluate('{missing} + 1', lookup)).toThrow(ExpressionError);
    expect(() => evaluate('1 +', lookup)).toThrow('ends too soon');
    expect(() => evaluate('(1 + 2', lookup)).toThrow('not closed');
    expect(() => evaluate('1 / 0', lookup)).toThrow('Division by zero');
    expect(() => evaluate('"a" * 2', lookup)).toThrow('needs numbers');
    expect(() => evaluate('count + 1', lookup)).toThrow('{count}');
    expect(() => evaluate('', lookup)).toThrow('empty');
    expect(expressionProblem('{count} + 1', ['count'])).toBeNull();
    expect(expressionProblem('{total} + 1', ['count'])).toContain('no variable "total"');
    expect(expressionProblem('1 + + 2', [])).not.toBeNull();
  });
});

describe('building a prototype', () => {
  it('connects layers to frames, changes and removes interactions, and names flows', () => {
    const s = screens();
    const id = make(s.store, (doc) => connect(doc, s.button, s.b));
    expect(getLayer(now(s.store), s.button)?.reactions).toMatchObject([{ id, trigger: { type: 'ON_CLICK' }, actions: [{ type: 'NAVIGATE', destinationId: s.b, transition: { type: 'DISSOLVE', duration: 300 } }] }]);
    expect(connectionsOn(now(s.store), s.pageId)).toEqual([{ fromId: s.button, toId: s.b, reactionId: id, type: 'NAVIGATE' }]);
    // A connection is one undo step.
    s.store.getState().undo();
    expect(getLayer(now(s.store), s.button)?.reactions).toEqual([]);
    s.store.getState().redo();
    // Nothing is connected to itself, to what is in it, or to what is not a frame.
    expect(connect(now(s.store), s.a, s.a)).toBeNull();
    expect(connect(now(s.store), s.a, s.button)).toBeNull();
    expect(connect(now(s.store), s.b, s.button)).toBeNull();

    act(s.store, (doc) => updateReaction(doc, s.button, id, { trigger: newTrigger('AFTER_DELAY', { delay: 1200 }), actions: [newAction('OPEN_OVERLAY', { destinationId: s.b }), newAction('BACK')] }));
    expect(getLayer(now(s.store), s.button)?.reactions[0]).toMatchObject({ trigger: { type: 'AFTER_DELAY', delay: 1200 }, actions: [{ type: 'OPEN_OVERLAY' }, { type: 'BACK' }] });
    expect(connectionsOn(now(s.store), s.pageId)).toMatchObject([{ type: 'OPEN_OVERLAY', toId: s.b }]);
    act(s.store, (doc) => removeReaction(doc, s.button, id));
    expect(connectionsOn(now(s.store), s.pageId)).toEqual([]);

    // Flows: named starting frames, one for a frame.
    expect(prototypeFrames(now(s.store), s.pageId).map((frame) => frame.id)).toEqual([s.a, s.b]);
    expect(startFrame(now(s.store), s.pageId)).toBe(s.a);
    expect(startFrame(now(s.store), s.pageId, s.b)).toBe(s.b);
    const first = make(s.store, (doc) => addFlow(doc, s.b));
    const second = make(s.store, (doc) => addFlow(doc, s.a, 'Sign up'));
    expect(flowsOf(now(s.store), s.pageId)).toEqual([{ id: first, name: 'Flow 1', startId: s.b }, { id: second, name: 'Sign up', startId: s.a }]);
    expect(addFlow(now(s.store), s.a)).toBeNull();
    expect(addFlow(now(s.store), s.button)).toBeNull();
    expect(startFrame(now(s.store), s.pageId, s.a)).toBe(s.b);
    act(s.store, (doc) => renameFlow(doc, s.pageId, first, 'Browse'));
    expect(flowAt(now(s.store), s.b)?.name).toBe('Browse');
    act(s.store, (doc) => removeFlow(doc, s.pageId, first));
    expect(flowsOf(now(s.store), s.pageId).map((flow) => flow.name)).toEqual(['Sign up']);
    // A flow whose frame is deleted is no flow.
    act(s.store, (doc) => patchNode(doc, s.a, { parentId: s.b } as LayerPatch));
    expect(flowsOf(now(s.store), s.pageId).map((flow) => flow.name)).toEqual(['Sign up']);
  });

  it('opens a version 21 file, which has no prototype, and keeps one through saving and opening', () => {
    const s = screens();
    const current = now(s.store);
    const v21 = JSON.parse(JSON.stringify(current)) as { nodes: Record<string, Record<string, unknown>> };
    for (const id in v21.nodes) for (const key of ['reactions', 'scrollBehavior', 'overflow', 'overlayPosition', 'overlayCloseOutside', 'overlayBackground', 'flows', 'prototypeDevice']) delete (v21.nodes[id] as Record<string, unknown>)[key];
    const parsed = parseFile({ format: 'open-design', schemaVersion: 21, meta: { createdAt: '2026-11-16T15:00:00.000Z', updatedAt: '2026-11-16T15:00:00.000Z' }, document: v21 });
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(22);
    expect(parsed.repairs).toEqual([]);
    expect(parsed.file.document).toEqual(current);

    const reaction = react(s.store, s.button, ['ON_KEY', { key: 'ArrowRight' }], [newAction('CONDITIONAL', { expression: '{count} > 1', then: [newAction('NAVIGATE', { destinationId: s.b, transition: linear('PUSH', 400, { easing: 'CUSTOM', bezier: [0.2, 0.8, 0.4, 1] }) })], otherwise: [newAction('BACK')] })]);
    make(s.store, (doc) => addFlow(doc, s.a, 'Main'));
    act(s.store, (doc) => patchNode(patchNode(patchNode(doc, s.a, { overflow: 'VERTICAL' }), s.b, { overlayPosition: 'BOTTOM_CENTER', overlayCloseOutside: false, overlayBackground: { color: BLACK, opacity: 0.4 } }), s.button, { scrollBehavior: 'FIXED' }));
    act(s.store, (doc) => patchNode(doc, s.pageId, { prototypeDevice: 'PHONE' }));
    const reopened = repairDocument(JSON.parse(JSON.stringify(now(s.store))));
    expect(reopened.repairs).toEqual([]);
    expect(reopened.doc).toEqual(now(s.store));

    // What is not what it should be is left out or put right.
    const raw = JSON.parse(JSON.stringify(now(s.store))) as { nodes: Record<string, Record<string, unknown>> };
    raw.nodes[s.button]!.reactions = [{ id: reaction, trigger: { type: 'ON_SNEEZE' }, actions: [] }, { id: 'ok', trigger: { type: 'ON_CLICK', delay: -5 }, actions: [{ type: 'NAVIGATE', destinationId: 7, transition: { type: 'WOBBLE', duration: -1 } }, { type: 'DANCE' }] }, { trigger: { type: 'ON_CLICK' } }];
    raw.nodes[s.button]!.scrollBehavior = 'FLOATS';
    raw.nodes[s.a]!.overflow = 'DIAGONAL';
    raw.nodes[s.pageId]!.flows = [{ id: 'f', name: '', startId: s.a }, { id: 'f', startId: s.b }, { id: 'g' }];
    raw.nodes[s.pageId]!.prototypeDevice = 'WATCH';
    const repaired = repairDocument(raw).doc;
    expect(getLayer(repaired, s.button)).toMatchObject({ scrollBehavior: 'SCROLLS', reactions: [{ id: 'ok', trigger: { type: 'ON_CLICK', delay: 0, key: '' }, actions: [{ type: 'NAVIGATE', destinationId: null, transition: { type: 'INSTANT', duration: 0 }, then: [], otherwise: [] }] }] });
    expect((getLayer(repaired, s.a) as FrameNode).overflow).toBe('NONE');
    expect(repaired.nodes[s.pageId]).toMatchObject({ flows: [{ id: 'f', name: 'Flow', startId: s.a }], prototypeDevice: 'NONE' });
  });
});

describe('playing a prototype', () => {
  it('goes to a frame on a click, shows the transition part of the way, and goes back', () => {
    const s = screens();
    react(s.store, s.button, ['ON_CLICK'], [newAction('NAVIGATE', { destinationId: s.b, transition: linear('DISSOLVE', 400) })]);
    const player = play(s.store, s.a);
    expect(player.size).toEqual({ width: 200, height: 300 });
    expect(onStage(player)).toEqual([s.a]);
    expect(staged(player, s.a)).toMatchObject({ x: 0, y: 0, parentId: STAGE_ID });
    // A click beside the button does nothing; where a click would is known.
    expect(click(player, 150, 200)).toBe(false);
    expect(player.screenId).toBe(s.a);
    expect(player.hotspots()).toEqual([{ x: 20, y: 20, width: 100, height: 40 }]);
    player.advance(1000);
    expect(click(player, 50, 40)).toBe(true);
    expect(player.screenId).toBe(s.b);
    expect(player.busy).toBe(true);
    // Part of the way: the old screen with the new one over it, a quarter there.
    player.advance(1100);
    expect(onStage(player)).toEqual([s.a, s.b]);
    expect(staged(player, s.b).opacity).toBeCloseTo(0.25);
    expect(staged(player, s.a).opacity).toBe(1);
    player.advance(1400);
    expect(player.busy).toBe(false);
    expect(onStage(player)).toEqual([s.b]);
    expect(staged(player, s.b).opacity).toBe(1);
    // The design is not changed by playing it.
    expect(getLayer(now(s.store), s.b)).toMatchObject({ x: 400, parentId: s.pageId });
    expect(player.canGoBack).toBe(true);
    player.back();
    expect(player.screenId).toBe(s.a);
    player.advance(2000);
    expect(onStage(player)).toEqual([s.a]);
    expect(player.canGoBack).toBe(false);
  });

  it('moves screens as each transition says, with its easing, delay and direction', () => {
    const at = (type: Transition['type'], more: Partial<Transition>, time: number): { old: LayerNode | undefined; fresh: LayerNode; order: NodeId[]; s: ReturnType<typeof screens> } => {
      const s = screens();
      react(s.store, s.button, ['ON_CLICK'], [newAction('NAVIGATE', { destinationId: s.b, transition: linear(type, 400, more) })]);
      const player = play(s.store, s.a);
      click(player, 50, 40);
      player.advance(time);
      return { old: onStage(player).includes(s.a) ? staged(player, s.a) : undefined, fresh: staged(player, s.b), order: onStage(player), s };
    };
    // Push to the left, a quarter of the way: the new screen comes in from the right as the old one leaves.
    let shot = at('PUSH', { direction: 'LEFT' }, 100);
    expect(shot.fresh.x).toBeCloseTo(150);
    expect(shot.old?.x).toBeCloseTo(-50);
    // Move in from below (moving up): the old screen stays, under the new one.
    shot = at('MOVE_IN', { direction: 'TOP' }, 200);
    expect(shot.fresh.y).toBeCloseTo(150);
    expect(shot.old).toMatchObject({ x: 0, y: 0 });
    expect(shot.order).toEqual([shot.s.a, shot.s.b]);
    // Move out to the right: the old screen leaves over the new one.
    shot = at('MOVE_OUT', { direction: 'RIGHT' }, 200);
    expect(shot.old?.x).toBeCloseTo(100);
    expect(shot.fresh.x).toBe(0);
    expect(shot.order).toEqual([shot.s.b, shot.s.a]);
    // Slide in: the old screen gives way a little.
    shot = at('SLIDE_IN', { direction: 'LEFT' }, 200);
    expect(shot.fresh.x).toBeCloseTo(100);
    expect(shot.old?.x).toBeCloseTo(-30);
    shot = at('SLIDE_OUT', { direction: 'BOTTOM' }, 200);
    expect(shot.old?.y).toBeCloseTo(150);
    expect(shot.fresh.y).toBeCloseTo(-45);
    // A delay holds it back; easing out is further along than linear at the same time.
    shot = at('PUSH', { direction: 'LEFT', delay: 200 }, 100);
    expect(shot.fresh.x).toBeCloseTo(200);
    shot = at('PUSH', { direction: 'LEFT', easing: 'EASE_OUT' }, 100);
    expect(shot.fresh.x).toBeLessThan(150);
    shot = at('PUSH', { direction: 'LEFT', easing: 'CUSTOM', bezier: [0, 0, 1, 1] }, 100);
    expect(shot.fresh.x).toBeCloseTo(150, 1);
    // Instant is at once.
    shot = at('INSTANT', {}, 0);
    expect(shot.order).toEqual([shot.s.b]);
    expect(cubicBezier(0.42, 0, 0.58, 1, 0.5)).toBeCloseTo(0.5);
    expect(cubicBezier(0.42, 0, 1, 1, 0.5)).toBeLessThan(0.5);
  });

  it('Smart Animate moves, sizes and colours matching layers, and fades what is on one side only', () => {
    const s = screens();
    act(s.store, (doc) => patchNode(doc, s.button, { name: 'Box', rotation: 0, opacity: 1, cornerRadius: 0 } as LayerPatch));
    const gone = add(s.store, 'ELLIPSE', s.a, { x: 150, y: 200, width: 20, height: 20, name: 'Only here' });
    const box = add(s.store, 'RECTANGLE', s.b, { x: 60, y: 220, width: 140, height: 80, name: 'Box', fills: [solidPaint(BLUE)], opacity: 0.5, cornerRadius: 20 } as LayerPatch);
    const fresh = add(s.store, 'ELLIPSE', s.b, { x: 10, y: 10, width: 20, height: 20, name: 'Only there' });
    react(s.store, s.a, ['ON_KEY', { key: 'Enter' }], [newAction('NAVIGATE', { destinationId: s.b, transition: linear('SMART_ANIMATE', 200) })]);
    const player = play(s.store, s.a);
    expect(player.key('Enter')).toBe(true);
    player.advance(100);
    // Only the new screen is on the stage, with its layers half way from where the old screen had them.
    expect(onStage(player)).toEqual([s.b]);
    expect(staged(player, box)).toMatchObject({ x: 40, y: 120, width: 120, height: 60, cornerRadius: 10 });
    expect(staged(player, box).opacity).toBeCloseTo(0.75);
    expect((staged(player, box).fills[0] as SolidPaint).color).toEqual({ r: 0.5, g: 0, b: 0.5 });
    expect(staged(player, fresh).opacity).toBeCloseTo(0.5);
    expect(staged(player, `ghost:${gone}`)).toMatchObject({ parentId: s.b, x: 150, y: 200 });
    expect(staged(player, `ghost:${gone}`).opacity).toBeCloseTo(0.5);
    // The background of the screen is on its way too.
    expect((staged(player, s.b).fills[0] as SolidPaint).color).toEqual({ r: 0.5, g: 0.5, b: 1 });
    player.advance(200);
    expect(staged(player, box)).toMatchObject({ x: 60, y: 220, width: 140, opacity: 0.5 });
    expect(player.stage().nodes[`ghost:${gone}`]).toBeUndefined();
  });

  it('opens, swaps and closes overlays, with what is behind them and where they sit', () => {
    const { store, pageId } = start();
    const screen = add(store, 'FRAME', pageId, { x: 0, y: 0, width: 400, height: 300, name: 'Screen' });
    const open = add(store, 'RECTANGLE', screen, { x: 10, y: 10, width: 50, height: 20, name: 'Open' });
    const menu = add(store, 'FRAME', pageId, { x: 600, y: 0, width: 200, height: 100, name: 'Menu', overlayBackground: { color: BLACK, opacity: 0.5 } } as LayerPatch);
    const close = add(store, 'RECTANGLE', menu, { x: 10, y: 10, width: 30, height: 20, name: 'Close' });
    const more = add(store, 'RECTANGLE', menu, { x: 100, y: 10, width: 30, height: 20, name: 'More' });
    const sheet = add(store, 'FRAME', pageId, { x: 600, y: 200, width: 400, height: 120, name: 'Sheet', overlayPosition: 'BOTTOM_CENTER', overlayCloseOutside: false } as LayerPatch);
    react(store, open, ['ON_CLICK'], [newAction('OPEN_OVERLAY', { destinationId: menu, transition: INSTANT })]);
    react(store, close, ['ON_CLICK'], [newAction('CLOSE_OVERLAY', { transition: INSTANT })]);
    react(store, more, ['ON_CLICK'], [newAction('SWAP_OVERLAY', { destinationId: sheet, transition: linear('MOVE_IN', 200, { direction: 'TOP' }) })]);
    const player = play(store, screen);
    click(player, 20, 20);
    expect(player.overlays).toEqual([menu]);
    // The screen, what is behind the overlay, and the overlay in the middle.
    expect(onStage(player)).toEqual([screen, `dim:${menu}`, menu]);
    expect(staged(player, menu)).toMatchObject({ x: 100, y: 100 });
    expect(staged(player, `dim:${menu}`)).toMatchObject({ width: 400, height: 300, fills: [{ color: BLACK, opacity: 0.5 }] });
    // The button under the overlay's background is not reached; the overlay's own is.
    click(player, 115, 115);
    expect(player.overlays).toEqual([]);
    expect(onStage(player)).toEqual([screen]);
    // A click outside closes it, and does nothing else.
    click(player, 20, 20);
    expect(click(player, 20, 20)).toBe(true);
    expect(player.overlays).toEqual([]);
    // Swapped for a sheet that comes up from the bottom and stays when clicked outside.
    click(player, 20, 20);
    click(player, 210, 115);
    expect(player.overlays).toEqual([sheet]);
    player.advance(100);
    expect(staged(player, sheet).x).toBe(0);
    expect(staged(player, sheet).y).toBeCloseTo(180 + 150);
    player.advance(200);
    expect(staged(player, sheet)).toMatchObject({ x: 0, y: 180 });
    click(player, 20, 20);
    expect(player.overlays).toEqual([sheet, menu]);
    click(player, 380, 20);
    expect(player.overlays).toEqual([sheet]);
    click(player, 380, 20);
    expect(player.overlays).toEqual([sheet]);
    // Back closes an overlay before it leaves the screen.
    player.back();
    expect(player.overlays).toEqual([]);
    expect(player.screenId).toBe(screen);
  });

  it('scrolls a screen and a frame in it; fixed layers stay and sticky ones stop at the top', () => {
    const { store, pageId } = start();
    const screen = add(store, 'FRAME', pageId, { x: 0, y: 0, width: 200, height: 300, name: 'Feed', overflow: 'VERTICAL' } as LayerPatch);
    const header = add(store, 'RECTANGLE', screen, { x: 0, y: 0, width: 200, height: 40, name: 'Header', scrollBehavior: 'FIXED' });
    const tabs = add(store, 'RECTANGLE', screen, { x: 0, y: 160, width: 200, height: 20, name: 'Tabs', scrollBehavior: 'STICKY' });
    const row = add(store, 'FRAME', screen, { x: 0, y: 50, width: 200, height: 100, name: 'Row', overflow: 'HORIZONTAL' } as LayerPatch);
    const cards = [0, 150, 300].map((x, index) => add(store, 'RECTANGLE', row, { x, y: 0, width: 100, height: 100, name: `Card ${index + 1}` }));
    const last = add(store, 'RECTANGLE', screen, { x: 0, y: 500, width: 200, height: 200, name: 'Last' });
    const detail = add(store, 'FRAME', pageId, { x: 400, y: 0, width: 200, height: 300, name: 'Detail' });
    react(store, cards[2] as NodeId, ['ON_CLICK'], [newAction('NAVIGATE', { destinationId: detail, transition: INSTANT })]);
    react(store, header, ['ON_CLICK'], [newAction('SCROLL_TO', { destinationId: last, transition: linear('SMART_ANIMATE', 200) })]);
    const player = play(store, screen);

    // The row scrolls sideways under the wheel; the same wheel turned down scrolls the screen.
    expect(player.wheel({ x: 10, y: 60 }, 120, 0)).toBe(true);
    expect(staged(player, cards[0] as NodeId).x).toBe(-120);
    expect(staged(player, cards[2] as NodeId).x).toBe(180);
    expect((staged(player, row) as FrameNode).clipsContent).toBe(true);
    player.wheel({ x: 10, y: 60 }, 500, 0);
    expect(player.scrollOf(row)).toEqual({ x: 200, y: 0 });
    // The third card was out of sight; now it is under the pointer and its click works.
    expect(player.wheel({ x: 10, y: 60 }, 0, 150)).toBe(true);
    // The frame is as big as the screen, so it stays and what is in it moves.
    expect(staged(player, screen).y).toBe(0);
    expect(staged(player, last).y).toBe(350);
    // The fixed header is where it was on the screen; the sticky tabs have not reached the top yet.
    expect(staged(player, screen).y + staged(player, header).y).toBe(0);
    expect(staged(player, screen).y + staged(player, tabs).y).toBe(10);
    player.wheel({ x: 10, y: 250 }, 0, 1000);
    expect(player.scrollOf(screen)).toEqual({ x: 0, y: 400 });
    expect(staged(player, screen).y + staged(player, tabs).y).toBe(0);
    expect(staged(player, screen).y + staged(player, last).y).toBe(100);
    player.wheel({ x: 10, y: 250 }, 0, -1000);
    expect(player.scrollOf(screen)).toEqual({ x: 0, y: 0 });
    // "Scroll to" takes the screen there over its time.
    click(player, 100, 20);
    player.advance(100);
    expect(player.scrollOf(screen).y).toBeCloseTo(200);
    player.advance(200);
    expect(player.scrollOf(screen)).toEqual({ x: 0, y: 400 });
    expect(player.busy).toBe(false);
    player.wheel({ x: 10, y: 250 }, 0, -1000);
    // Dragging what has no drag of its own scrolls it, as a finger would.
    player.pointerDown({ x: 150, y: 100 });
    player.pointerMove({ x: 100, y: 100 });
    player.pointerUp({ x: 100, y: 100 });
    expect(player.scrollOf(row).x).toBe(200);
    click(player, 150, 100);
    expect(player.screenId).toBe(detail);

    // On a device smaller than the frame, the frame scrolls though it is not set to.
    const phone = play(store, detail, { width: 200, height: 200 });
    expect(phone.size).toEqual({ width: 200, height: 200 });
    phone.wheel({ x: 10, y: 10 }, 0, 500);
    expect(phone.scrollOf(detail)).toEqual({ x: 0, y: 100 });
  });

  it('changes the state of a component: on a click, while hovering and while pressing', () => {
    const { store, pageId } = start();
    const variant = (name: string, y: number, color: typeof RED, knob: number): { frame: NodeId; knob: NodeId } => {
      const frame = add(store, 'FRAME', pageId, { x: 600, y, width: 40, height: 20, name, fills: [solidPaint(color)] });
      const knobId = add(store, 'ELLIPSE', frame, { x: knob, y: 2, width: 16, height: 16, name: 'Knob' });
      act(store, (doc) => (createComponent(doc, [frame]) as { doc: Document }).doc);
      return { frame, knob: knobId };
    };
    const off = variant('Off', 0, RED, 2);
    const on = variant('On', 40, GREEN, 22);
    const hover = variant('Hover', 80, BLUE, 2);
    make(store, (doc) => createComponentSet(doc, [off.frame, on.frame, hover.frame]));
    react(store, off.frame, ['ON_CLICK'], [newAction('CHANGE_TO', { destinationId: on.frame, transition: linear('SMART_ANIMATE', 200) })]);
    react(store, on.frame, ['ON_CLICK'], [newAction('CHANGE_TO', { destinationId: off.frame, transition: INSTANT })]);
    react(store, off.frame, ['MOUSE_ENTER'], [newAction('CHANGE_TO', { destinationId: hover.frame, transition: INSTANT })]);
    react(store, hover.frame, ['ON_PRESS'], [newAction('CHANGE_TO', { destinationId: on.frame, transition: INSTANT })]);
    const screen = add(store, 'FRAME', pageId, { x: 0, y: 0, width: 200, height: 100, name: 'Screen' });
    const toggle = make(store, (doc) => createInstance(doc, off.frame, { parentId: screen, at: { x: 20, y: 20 } }));
    const other = make(store, (doc) => createInstance(doc, off.frame, { parentId: screen, at: { x: 120, y: 20 } }));
    const shown = (player: Player, id: NodeId): NodeId | null => (player.doc.nodes[id] as FrameNode).componentId;

    // Hovering shows the hover state of that instance only; leaving takes it back.
    const player = play(store, screen);
    player.pointerMove({ x: 30, y: 30 });
    expect(shown(player, toggle)).toBe(hover.frame);
    expect(shown(player, other)).toBe(off.frame);
    expect((staged(player, toggle).fills[0] as SolidPaint).color).toEqual(BLUE);
    player.pointerMove({ x: 35, y: 32 });
    expect(shown(player, toggle)).toBe(hover.frame);
    // Pressing, while it is hovered, shows another state until the button is let go.
    player.pointerDown({ x: 35, y: 32 });
    expect(shown(player, toggle)).toBe(on.frame);
    player.pointerUp({ x: 35, y: 32 });
    expect(shown(player, toggle)).toBe(hover.frame);
    player.pointerMove({ x: 90, y: 80 });
    expect(shown(player, toggle)).toBe(off.frame);
    player.pointerLeave();

    // A click changes the state for good, animated; a second click changes it back.
    const second = play(store, screen);
    second.pointerDown({ x: 130, y: 30 });
    second.pointerUp({ x: 130, y: 30 });
    expect(shown(second, other)).toBe(on.frame);
    expect(shown(second, toggle)).toBe(off.frame);
    second.advance(100);
    expect(staged(second, mirrorId(other, on.knob)).x).toBeCloseTo(12);
    expect((staged(second, other).fills[0] as SolidPaint).color).toEqual({ r: 0.5, g: 0.5, b: 0 });
    second.advance(200);
    expect(staged(second, mirrorId(other, on.knob)).x).toBe(22);
    second.pointerDown({ x: 130, y: 30 });
    second.pointerUp({ x: 130, y: 30 });
    // It is off again, and since the pointer is over it, hovered; leaving shows it off.
    expect(shown(second, other)).toBe(hover.frame);
    second.pointerLeave();
    expect(shown(second, other)).toBe(off.frame);
    // The design's instances are as they were.
    expect((getLayer(now(store), other) as FrameNode).componentId).toBe(off.frame);
    // Starting again puts everything back.
    click(second, 30, 30);
    second.restart();
    expect(shown(second, toggle)).toBe(off.frame);
  });

  it('sets variables with expressions and takes a condition one way or the other', () => {
    const s = screens();
    const count = variable(s.store, 'FLOAT', 'count', 0);
    const label = variable(s.store, 'STRING', 'label', 'Nothing yet', count.collection);
    const shown = variable(s.store, 'BOOLEAN', 'shown', true, count.collection);
    const text = add(s.store, 'TEXT', s.a, { x: 20, y: 100, characters: 'x', name: 'Label' });
    const badge = add(s.store, 'RECTANGLE', s.a, { x: 150, y: 20, width: 20, height: 20, name: 'Badge' });
    act(s.store, (doc) => bindVariable(bindVariable(doc, [text], 'characters', label.id), [badge], 'visible', shown.id));
    react(s.store, s.button, ['ON_CLICK'], [
      newAction('SET_VARIABLE', { variableId: count.id, expression: '{count} + 1' }),
      newAction('SET_VARIABLE', { variableId: shown.id, expression: 'not {shown}' }),
      newAction('CONDITIONAL', {
        expression: '{count} >= 3',
        then: [newAction('NAVIGATE', { destinationId: s.b, transition: INSTANT })],
        otherwise: [newAction('SET_VARIABLE', { variableId: label.id, expression: '"Clicked " + {count} + " of 3"' })],
      }),
      // An expression that cannot be worked out changes nothing and stops nothing.
      newAction('SET_VARIABLE', { variableId: count.id, expression: '{missing} + 1' }),
    ]);
    const player = play(s.store, s.a);
    expect((staged(player, text) as TextNode).characters).toBe('Nothing yet');
    click(player, 50, 40);
    expect(player.value('count')).toBe(1);
    expect(player.value('State/shown')).toBe(false);
    expect((staged(player, text) as TextNode).characters).toBe('Clicked 1 of 3');
    expect(staged(player, badge).visible).toBe(false);
    // The text was laid out again for what it says now.
    expect(staged(player, text).width).toBeGreaterThan(getLayer(now(s.store), text)!.width);
    click(player, 50, 40);
    expect((staged(player, text) as TextNode).characters).toBe('Clicked 2 of 3');
    expect(staged(player, badge).visible).toBe(true);
    expect(player.screenId).toBe(s.a);
    click(player, 50, 40);
    expect(player.screenId).toBe(s.b);
    // The design's variables are as they were, and so is a prototype that is started again.
    expect(now(s.store).variables[count.id]?.valuesByMode).toEqual(expect.objectContaining({}));
    expect(Object.values(now(s.store).variables[count.id]!.valuesByMode)).toEqual([0]);
    player.restart();
    expect(player.value('count')).toBe(0);
    expect(player.screenId).toBe(s.a);
  });

  it('hands the address of a link to whoever shows the prototype', () => {
    const s = screens();
    react(s.store, s.button, ['ON_CLICK'], [newAction('OPEN_LINK', { expression: ' https://example.com/help ' }), newAction('OPEN_LINK', { expression: '  ' })]);
    const player = play(s.store, s.a);
    expect(player.links).toEqual([]);
    click(player, 50, 40);
    // The address, trimmed; an empty one opens nothing. The screen stays where it is.
    expect(player.links).toEqual(['https://example.com/help']);
    expect(player.screenId).toBe(s.a);
  });

  it('runs interactions after a delay, on a key and on a drag, and types into an input field', () => {
    const s = screens();
    const name = variable(s.store, 'STRING', 'name', '');
    const field = add(s.store, 'TEXT', s.a, { x: 20, y: 200, characters: 'placeholder', name: 'Field' });
    act(s.store, (doc) => bindVariable(doc, [field], 'characters', name.id));
    // The field is a box with the text in front of it: an empty text has nothing to click.
    const box = add(s.store, 'RECTANGLE', s.a, { x: 20, y: 195, width: 160, height: 30, name: 'Field box' });
    act(s.store, (doc) => patchNode(doc, field, { order: 'zz' } as LayerPatch));
    const third = add(s.store, 'FRAME', s.pageId, { x: 800, y: 0, width: 200, height: 300, name: 'Third' });
    react(s.store, s.a, ['AFTER_DELAY', { delay: 500 }], [newAction('NAVIGATE', { destinationId: s.b, transition: INSTANT })]);
    react(s.store, s.b, ['ON_KEY', { key: 'ArrowRight' }], [newAction('NAVIGATE', { destinationId: third, transition: INSTANT })]);
    react(s.store, third, ['ON_DRAG'], [newAction('BACK')]);
    react(s.store, third, ['ON_CLICK'], [newAction('NAVIGATE', { destinationId: s.a, transition: INSTANT })]);
    react(s.store, box, ['ON_CLICK'], [newAction('INPUT', { variableId: name.id })]);

    const player = play(s.store, s.a);
    // Typing goes into the field once it is clicked, and stops at Enter.
    expect(player.key('H')).toBe(false);
    click(player, 30, 205);
    expect(player.input).toBe(name.id);
    for (const key of ['H', 'i', '!', 'Backspace']) expect(player.key(key)).toBe(true);
    expect(player.value('name')).toBe('Hi');
    expect((staged(player, field) as TextNode).characters).toBe('Hi');
    expect(player.key('Enter')).toBe(true);
    expect(player.input).toBeNull();
    // The delay runs from when the screen was shown.
    player.advance(499);
    expect(player.screenId).toBe(s.a);
    player.advance(500);
    expect(player.screenId).toBe(s.b);
    // A key that nothing waits for does nothing; the one that is waited for does.
    expect(player.key('ArrowLeft')).toBe(false);
    expect(player.key('ArrowRight')).toBe(true);
    expect(player.screenId).toBe(third);
    // A drag is not a click: it goes back, and the click on the same frame does not run.
    player.pointerDown({ x: 100, y: 100 });
    player.pointerMove({ x: 102, y: 100 });
    expect(player.screenId).toBe(third);
    player.pointerMove({ x: 130, y: 100 });
    expect(player.screenId).toBe(s.b);
    player.pointerUp({ x: 130, y: 100 });
    expect(player.screenId).toBe(s.b);
    // Leaving a screen before its delay is up cancels it.
    const again = play(s.store, s.a);
    again.advance(100);
    click(again, 30, 205);
    again.restart(third);
    again.advance(5000);
    expect(again.screenId).toBe(third);
    click(again, 100, 100);
    expect(again.screenId).toBe(s.a);
    again.advance(5400);
    expect(again.screenId).toBe(s.a);
    again.advance(5500);
    expect(again.screenId).toBe(s.b);
  });
});
