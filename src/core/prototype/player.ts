import { isInstance, setOf } from '../components/instances';
import { isLayer, isPage, keyComboOf, keyCombosMatch, type Action, type Document, type FrameNode, type LayerNode, type NodeId, type Reaction, type RGB, type Transition, type TriggerType, type Variable, type VariableValue } from '../document/schema';
import { restoreLayout } from '../layout/restore';
import type { Point, Rect } from '../math/geometry';
import { swapInstances } from '../ops/components';
import { hitTestDeepest } from '../scene/hitTest';
import { getAncestorIds, getChildIds, getDescendantIds, getPageIdOf, getWorldBounds } from '../scene/tree';
import type { TextMeasurer } from '../text/layout';
import { modeFor, resolveVariable } from '../tokens/tokens';
import { evaluate, ExpressionError, truthy, valueText, type Value } from './expression';
import { buildStage, directionVector, ease, overlayOrigin, smartAnimate, STAGE_ID, type Size, type StagePart } from './stage';

/**
 * Plays a prototype. The player holds what is shown (which screen, which
 * overlays, how far everything is scrolled) and a copy of the document that
 * interactions change as they run (a variable set, a component changed to
 * another variant), and takes what the viewer tells it: where the pointer
 * is, what was pressed, what time it is. It draws nothing; `stage()` gives
 * the document to paint for the present moment.
 */

/** What is shown: a screen, the overlays open over it (bottom first), and how far each scrolling frame is scrolled. */
export interface Scene {
  screenId: NodeId;
  overlays: readonly NodeId[];
  scroll: Readonly<Record<NodeId, Point>>;
}

interface Snapshot {
  doc: Document;
  scene: Scene;
}

interface Running {
  kind: 'SCREEN' | 'OVERLAY_IN' | 'OVERLAY_OUT' | 'STATE';
  from: Snapshot;
  transition: Transition;
  start: number;
  overlayId?: NodeId;
}

interface Timer {
  due: number;
  rootId: NodeId;
  ownerId: NodeId;
  reactionId: string;
}

/** Something that lasts while the pointer hovers or presses, and is undone after. */
interface Held {
  ownerId: NodeId;
  /** What to go back to. Null once something else has happened since, which is then kept. */
  snapshot: Snapshot | null;
  transition: Transition | null;
}

interface ScrollTween {
  frameId: NodeId;
  from: Point;
  to: Point;
  start: number;
  transition: Transition;
}

export interface PlayerOptions {
  doc: Document;
  /** The frame to start on. */
  startId: NodeId;
  /** Must measure text as the editor does, since interactions lay text out again. */
  measurer: TextMeasurer;
  /** The size of the screen. Without one the screen is as big as the frame shown. */
  viewport?: Size | null;
}

const INSTANT: Transition = { type: 'INSTANT', direction: 'LEFT', duration: 0, delay: 0, easing: 'LINEAR', bezier: [0, 0, 1, 1] };
const DRAG_THRESHOLD = 4;
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

function timeOf(transition: Transition): number {
  return transition.type === 'INSTANT' ? 0 : transition.delay + transition.duration;
}

/** The transition that undoes one: the same, the other way. */
function reversed(transition: Transition): Transition {
  const type = transition.type === 'MOVE_IN' ? 'MOVE_OUT' : transition.type === 'MOVE_OUT' ? 'MOVE_IN' : transition.type === 'SLIDE_IN' ? 'SLIDE_OUT' : transition.type === 'SLIDE_OUT' ? 'SLIDE_IN' : transition.type;
  const direction = transition.direction === 'LEFT' ? 'RIGHT' : transition.direction === 'RIGHT' ? 'LEFT' : transition.direction === 'TOP' ? 'BOTTOM' : 'TOP';
  return { ...transition, type, direction, delay: 0 };
}

export class Player {
  /** The document as it was designed. */
  readonly design: Document;
  /** The document as the prototype has changed it. */
  doc: Document;
  scene: Scene;
  /** The variable that typing goes into, while an input field has the keyboard. */
  input: string | null = null;
  /** The layer whose interaction gave an input field the keyboard: the mode of the variable typed into is the one in effect there. */
  private inputOwner: NodeId | null = null;
  /** Web addresses that interactions asked to open, oldest first, for the viewer to open and clear. */
  links: string[] = [];
  now = 0;

  private readonly measurer: TextMeasurer;
  private readonly viewport: Size | null;
  private readonly startId: NodeId;
  private history: { scene: Scene; transition: Transition }[] = [];
  private running: Running | null = null;
  private timers: Timer[] = [];
  private tweens: ScrollTween[] = [];
  private hover: Held | null = null;
  private press: Held | null = null;
  private down: { point: Point; last: Point; chain: NodeId[]; dragged: boolean; scrolling: boolean } | null = null;
  /** What the pointer was over when it last moved, innermost first, for knowing what it has left. */
  private under: NodeId[] = [];
  private staged: Document | null = null;
  /** When a click last found nothing to do, for showing what can be clicked. */
  missedAt = -Infinity;

  constructor(options: PlayerOptions) {
    this.design = options.doc;
    this.doc = options.doc;
    this.measurer = options.measurer;
    this.viewport = options.viewport ?? null;
    this.startId = options.startId;
    this.scene = { screenId: options.startId, overlays: [], scroll: {} };
    this.enter(options.startId, 0);
  }

  // ------------------------------------------------------------ what is shown

  get screenId(): NodeId {
    return this.scene.screenId;
  }

  get overlays(): readonly NodeId[] {
    return this.scene.overlays;
  }

  /** The size of the screen: the device's, or the size of the frame shown. */
  get size(): Size {
    if (this.viewport) return this.viewport;
    const screen = this.doc.nodes[this.scene.screenId];
    return isLayer(screen) ? { width: screen.width, height: screen.height } : { width: 1, height: 1 };
  }

  /** Whether something is moving, so that the viewer has to keep painting. */
  get busy(): boolean {
    return this.running !== null || this.tweens.length > 0;
  }

  /** Whether there is a screen to go back to. */
  get canGoBack(): boolean {
    return this.history.length > 0 || this.scene.overlays.length > 0;
  }

  /** The value a variable has now, by name: for showing and for tests. */
  value(name: string): Value | null {
    const variable = this.variableNamed(name);
    return variable ? resolveVariable(this.doc, variable.id, this.scene.screenId) : null;
  }

  private variableNamed(name: string): Variable | undefined {
    const all = Object.values(this.doc.variables);
    return all.find((variable) => variable.name === name) ?? all.find((variable) => `${this.doc.variableCollections[variable.collectionId]?.name}/${variable.name}` === name);
  }

  private snapshot(): Snapshot {
    return { doc: this.doc, scene: this.scene };
  }

  private progress(running: Running): number {
    const { transition } = running;
    if (transition.duration <= 0) return 1;
    return ease(transition, (this.now - running.start - transition.delay) / transition.duration);
  }

  private begin(kind: Running['kind'], from: Snapshot, transition: Transition, overlayId?: NodeId): void {
    this.staged = null;
    this.running = timeOf(transition) > 0 ? { kind, from, transition, start: this.now, overlayId } : null;
  }

  /** The background behind everything: the colour of the page the screen is on. */
  private background(): RGB {
    const pageId = getPageIdOf(this.design, this.scene.screenId);
    const page = pageId ? this.design.nodes[pageId] : undefined;
    return isPage(page) ? page.backgroundColor : { r: 0, g: 0, b: 0 };
  }

  /** The document to paint now: a page `STAGE_ID` with the screen, the overlays, and a transition part of the way. */
  stage(): Document {
    if (this.staged) return this.staged;
    const size = this.size;
    const running = this.running;
    const p = running ? this.progress(running) : 1;
    const parts: StagePart[] = [];
    const screen = (snapshot: Snapshot, at: Point, opacity: number, overrides?: StagePart['overrides']): StagePart => ({ doc: snapshot.doc, rootId: snapshot.scene.screenId, at, opacity, scroll: snapshot.scene.scroll, overrides, screen: true });
    const here = this.snapshot();
    const zero = { x: 0, y: 0 };

    if (running && running.kind === 'SCREEN' && p < 1) {
      const d = directionVector(running.transition.direction);
      const along = (factor: number): Point => ({ x: d.x * size.width * factor, y: d.y * size.height * factor });
      const type = running.transition.type;
      if (type === 'SMART_ANIMATE') parts.push(screen(here, zero, 1, smartAnimate(running.from.doc, running.from.scene.screenId, this.doc, this.scene.screenId, p)));
      else if (type === 'DISSOLVE') parts.push(screen(running.from, zero, 1), screen(here, zero, p));
      else if (type === 'MOVE_IN') parts.push(screen(running.from, zero, 1), screen(here, along(-(1 - p)), 1));
      else if (type === 'MOVE_OUT') parts.push(screen(here, zero, 1), screen(running.from, along(p), 1));
      else if (type === 'PUSH') parts.push(screen(running.from, along(p), 1), screen(here, along(-(1 - p)), 1));
      else if (type === 'SLIDE_IN') parts.push(screen(running.from, along(p * 0.3), 1), screen(here, along(-(1 - p)), 1));
      else if (type === 'SLIDE_OUT') parts.push(screen(here, along(-(1 - p) * 0.3), 1), screen(running.from, along(p), 1));
      else parts.push(screen(here, zero, 1));
    } else {
      const state = running && running.kind === 'STATE' && p < 1 ? running : null;
      parts.push(screen(here, zero, 1, state ? smartAnimate(state.from.doc, this.scene.screenId, this.doc, this.scene.screenId, p) : undefined));
    }

    const overlay = (snapshot: Snapshot, frameId: NodeId, q: number, transition: Transition | null): StagePart | null => {
      const frame = snapshot.doc.nodes[frameId];
      if (!isLayer(frame) || frame.type !== 'FRAME') return null;
      const origin = overlayOrigin(frame, size);
      let at = origin;
      let opacity = 1;
      if (transition && q < 1) {
        if (transition.type === 'DISSOLVE' || transition.type === 'SMART_ANIMATE') opacity = q;
        else if (transition.type !== 'INSTANT') {
          const d = directionVector(transition.direction);
          at = { x: origin.x - d.x * size.width * (1 - q), y: origin.y - d.y * size.height * (1 - q) };
        }
      }
      const state = running && running.kind === 'STATE' && p < 1 && running.from.scene.overlays.includes(frameId) ? smartAnimate(running.from.doc, frameId, snapshot.doc, frameId, p) : undefined;
      return { doc: snapshot.doc, rootId: frameId, at, opacity, scroll: snapshot.scene.scroll, overrides: state, dim: frame.overlayBackground ? { color: frame.overlayBackground.color, opacity: frame.overlayBackground.opacity * q } : undefined };
    };
    for (const frameId of this.scene.overlays) {
      const opening = running && running.kind === 'OVERLAY_IN' && running.overlayId === frameId && p < 1;
      const part = overlay(here, frameId, opening ? p : 1, opening ? running.transition : null);
      if (part) parts.push(part);
    }
    if (running && running.kind === 'OVERLAY_OUT' && running.overlayId && p < 1) {
      const part = overlay(running.from, running.overlayId, 1 - p, running.transition);
      if (part) parts.push(part);
    }
    const staged = buildStage(this.doc, parts, size, this.background());
    if (!this.busy) this.staged = staged;
    return staged;
  }

  // ------------------------------------------------------------------- time

  /** Tells the player the time, in milliseconds: transitions move on, and what was waiting for this moment happens. */
  advance(now: number): void {
    this.now = now;
    if (this.running) {
      this.staged = null;
      if (now >= this.running.start + timeOf(this.running.transition)) this.running = null;
    }
    if (this.tweens.length > 0) {
      this.staged = null;
      const scroll = { ...this.scene.scroll };
      this.tweens = this.tweens.filter((tween) => {
        const t = tween.transition.duration <= 0 ? 1 : ease(tween.transition, (now - tween.start - tween.transition.delay) / tween.transition.duration);
        scroll[tween.frameId] = { x: tween.from.x + (tween.to.x - tween.from.x) * t, y: tween.from.y + (tween.to.y - tween.from.y) * t };
        return now < tween.start + tween.transition.delay + tween.transition.duration;
      });
      this.scene = { ...this.scene, scroll };
    }
    const due = this.timers.filter((timer) => timer.due <= now).sort((a, b) => a.due - b.due);
    for (const timer of due) {
      // Something that ran before it may have left the screen it was waiting on.
      if (!this.timers.includes(timer)) continue;
      this.timers = this.timers.filter((other) => other !== timer);
      const reaction = this.reactionsOf(timer.ownerId).find((entry) => entry.id === timer.reactionId);
      if (reaction) this.run(reaction.actions, timer.ownerId);
    }
  }

  /** Starts what waits on a screen or overlay that has just been shown: its "after delay" interactions. */
  private enter(rootId: NodeId, after: number): void {
    for (const id of [rootId, ...getDescendantIds(this.doc, rootId)]) {
      for (const reaction of this.reactionsOf(id)) {
        if (reaction.trigger.type === 'AFTER_DELAY') this.timers.push({ due: this.now + after + reaction.trigger.delay, rootId, ownerId: id, reactionId: reaction.id });
      }
    }
  }

  // ----------------------------------------------------------- interactions

  /** The interactions on a layer: its own and, for an instance, those on the component it shows. */
  reactionsOf(id: NodeId): Reaction[] {
    const node = this.doc.nodes[id];
    if (!isLayer(node)) return [];
    const component = isInstance(node) && node.componentId ? this.doc.nodes[node.componentId] : undefined;
    return isLayer(component) ? [...node.reactions, ...component.reactions] : node.reactions;
  }

  /** What is under a point of the screen, innermost first, up to the screen or overlay it is in. */
  private chainAt(point: Point): NodeId[] {
    const stage = this.stage();
    const hit = hitTestDeepest(stage, STAGE_ID, point);
    if (hit === null) return [];
    return [hit, ...getAncestorIds(stage, hit).filter((id) => id !== STAGE_ID)];
  }

  private owner(chain: readonly NodeId[], type: TriggerType): { id: NodeId; reaction: Reaction } | null {
    for (const id of chain) {
      const reaction = this.reactionsOf(id).find((entry) => entry.trigger.type === type);
      if (reaction) return { id, reaction };
    }
    return null;
  }

  /**
   * How an expression run by a layer's interaction reads variables: each
   * in the mode in effect for that layer (chosen on it, or on what it is in).
   */
  private lookupAt(nodeId: NodeId): (name: string) => Value | null {
    return (name) => {
      const variable = this.variableNamed(name);
      if (!variable) return null;
      return resolveVariable(this.doc, variable.id, this.doc.nodes[nodeId] ? nodeId : this.scene.screenId);
    };
  }

  /**
   * Runs the actions of an interaction, in order. `held` is for what lasts
   * only while the pointer hovers or presses. Returns the instance a
   * "change to" changed, if there was one.
   */
  private run(actions: readonly Action[], ownerId: NodeId, held = false, depth = 0): NodeId | null {
    let changed: NodeId | null = null;
    if (depth > 8) return changed;
    for (const action of actions) {
      if (!held) {
        // Whatever happens now is kept: leaving or letting go does not take it back.
        if (this.hover) this.hover.snapshot = null;
        if (this.press) this.press.snapshot = null;
      }
      const destination = action.destinationId === null ? undefined : this.doc.nodes[action.destinationId];
      const from = this.snapshot();
      switch (action.type) {
        case 'NAVIGATE': {
          if (!isLayer(destination) || destination.type !== 'FRAME') break;
          if (destination.id === this.scene.screenId && this.scene.overlays.length === 0) break;
          this.history.push({ scene: this.scene, transition: action.transition });
          this.scene = { screenId: destination.id, overlays: [], scroll: {} };
          this.timers = [];
          this.tweens = [];
          this.input = null;
          // A screen inside the other cannot be on the stage twice.
          const nested = getAncestorIds(this.doc, destination.id).includes(from.scene.screenId) || getAncestorIds(this.doc, from.scene.screenId).includes(destination.id);
          this.begin('SCREEN', from, nested || destination.id === from.scene.screenId ? INSTANT : action.transition);
          this.enter(destination.id, timeOf(action.transition));
          break;
        }
        case 'OPEN_OVERLAY':
        case 'SWAP_OVERLAY': {
          if (!isLayer(destination) || destination.type !== 'FRAME' || destination.id === this.scene.screenId || this.scene.overlays.includes(destination.id)) break;
          const overlays = [...this.scene.overlays];
          if (action.type === 'SWAP_OVERLAY' && overlays.length > 0) {
            const old = overlays.pop() as NodeId;
            this.timers = this.timers.filter((timer) => timer.rootId !== old);
          }
          this.scene = { ...this.scene, overlays: [...overlays, destination.id] };
          this.begin('OVERLAY_IN', from, action.transition, destination.id);
          this.enter(destination.id, timeOf(action.transition));
          break;
        }
        case 'CLOSE_OVERLAY':
          this.closeOverlay(action.transition);
          break;
        case 'BACK':
          this.back();
          break;
        case 'SCROLL_TO':
          if (isLayer(destination)) this.scrollTo(destination.id, action.transition);
          break;
        case 'CHANGE_TO': {
          if (!isLayer(destination)) break;
          const set = setOf(this.doc, destination.id);
          const target = [ownerId, ...getAncestorIds(this.doc, ownerId)].find((id) => {
            const node = this.doc.nodes[id];
            if (!isInstance(node) || node.componentId === null) return false;
            return set ? setOf(this.doc, node.componentId)?.id === set.id : true;
          });
          if (target === undefined || (this.doc.nodes[target] as FrameNode).componentId === destination.id) break;
          this.doc = restoreLayout(this.doc, swapInstances(this.doc, [target], destination.id), this.measurer);
          this.begin('STATE', from, action.transition);
          changed = target;
          break;
        }
        case 'SET_VARIABLE': {
          const variable = action.variableId === null ? undefined : this.doc.variables[action.variableId];
          if (!variable) break;
          let value: Value;
          try {
            value = evaluate(action.expression, this.lookupAt(ownerId));
          } catch (error) {
            if (error instanceof ExpressionError) break;
            throw error;
          }
          this.setVariable(variable, value, ownerId);
          break;
        }
        case 'CONDITIONAL': {
          let holds: boolean;
          try {
            holds = truthy(evaluate(action.expression, this.lookupAt(ownerId)));
          } catch (error) {
            if (error instanceof ExpressionError) break;
            throw error;
          }
          changed = this.run(holds ? action.then : action.otherwise, ownerId, held, depth + 1) ?? changed;
          break;
        }
        case 'INPUT':
          if (action.variableId !== null && this.doc.variables[action.variableId]?.type === 'STRING') {
            this.input = action.variableId;
            this.inputOwner = ownerId;
          }
          break;
        case 'OPEN_LINK':
          if (action.expression.trim() !== '') this.links.push(action.expression.trim());
          break;
      }
    }
    this.staged = null;
    return changed;
  }

  /**
   * Gives a variable a value for the rest of the prototype, as the type of
   * variable it is, in the mode in effect for the layer whose interaction set
   * it (the mode chosen for the variable's collection on that layer or what it
   * is in, else the collection's first): other modes keep their values, as in
   * Figma. A layer that is no longer there gives the screen's mode.
   */
  private setVariable(variable: Variable, value: Value, at: NodeId): void {
    let stored: VariableValue;
    if (variable.type === 'COLOR') {
      if (typeof value !== 'object') return;
      stored = value;
    } else if (variable.type === 'FLOAT') {
      const number = typeof value === 'number' ? value : typeof value === 'boolean' ? (value ? 1 : 0) : typeof value === 'string' ? Number(value) : NaN;
      if (!Number.isFinite(number)) return;
      stored = number;
    } else if (variable.type === 'STRING') stored = valueText(value);
    else stored = truthy(value);
    const mode = modeFor(this.doc, this.doc.nodes[at] ? at : this.scene.screenId, variable.collectionId);
    const valuesByMode: Record<string, VariableValue> = { ...variable.valuesByMode };
    if (mode === null) for (const id in valuesByMode) valuesByMode[id] = stored;
    else valuesByMode[mode] = stored;
    const next = { ...this.doc, variables: { ...this.doc.variables, [variable.id]: { ...variable, valuesByMode } } };
    this.doc = restoreLayout(this.doc, next, this.measurer);
    this.staged = null;
  }

  private closeOverlay(transition: Transition): void {
    const overlays = [...this.scene.overlays];
    const closing = overlays.pop();
    if (closing === undefined) return;
    const from = this.snapshot();
    this.timers = this.timers.filter((timer) => timer.rootId !== closing);
    this.scene = { ...this.scene, overlays };
    this.begin('OVERLAY_OUT', from, transition, closing);
  }

  /** Goes back: closes the top overlay, or shows the screen before this one, with the transition that led here the other way. */
  back(): void {
    if (this.scene.overlays.length > 0) {
      this.closeOverlay(INSTANT);
      return;
    }
    const entry = this.history.pop();
    if (!entry) return;
    const from = this.snapshot();
    this.scene = entry.scene;
    this.timers = [];
    this.tweens = [];
    this.input = null;
    this.begin('SCREEN', from, reversed(entry.transition));
    this.enter(this.scene.screenId, timeOf(entry.transition));
  }

  /** Starts the prototype again, from a frame: as designed, with nothing changed. */
  restart(startId: NodeId = this.startId): void {
    this.doc = this.design;
    this.scene = { screenId: startId, overlays: [], scroll: {} };
    this.history = [];
    this.running = null;
    this.timers = [];
    this.tweens = [];
    this.hover = null;
    this.press = null;
    this.down = null;
    this.under = [];
    this.input = null;
    this.inputOwner = null;
    this.staged = null;
    this.enter(startId, 0);
  }

  // --------------------------------------------------------------- scrolling

  /** The roots on the stage: the screen and the overlays. */
  private roots(): NodeId[] {
    return [this.scene.screenId, ...this.scene.overlays];
  }

  /** How far a frame can be scrolled, each way. */
  private extent(frameId: NodeId): Point {
    const frame = this.doc.nodes[frameId];
    if (!isLayer(frame) || frame.type !== 'FRAME') return { x: 0, y: 0 };
    let right = 0;
    let bottom = 0;
    for (const childId of getChildIds(this.doc, frameId)) {
      const child = this.doc.nodes[childId];
      if (!isLayer(child) || !child.visible || child.scrollBehavior === 'FIXED') continue;
      right = Math.max(right, child.x + child.width);
      bottom = Math.max(bottom, child.y + child.height);
    }
    const horizontal = frame.overflow === 'HORIZONTAL' || frame.overflow === 'BOTH';
    const vertical = frame.overflow === 'VERTICAL' || frame.overflow === 'BOTH';
    if (frameId === this.scene.screenId) {
      // A screen bigger than the device scrolls whatever it is set to; set to scroll, it scrolls to the end of what is in it.
      const size = this.size;
      const width = horizontal ? Math.max(frame.width, right) : frame.width;
      const height = vertical ? Math.max(frame.height, bottom) : frame.height;
      return { x: Math.max(0, width - size.width), y: Math.max(0, height - size.height) };
    }
    return { x: horizontal ? Math.max(0, right - frame.width) : 0, y: vertical ? Math.max(0, bottom - frame.height) : 0 };
  }

  private scrollBy(chain: readonly NodeId[], dx: number, dy: number): boolean {
    let moved = false;
    const scroll = { ...this.scene.scroll };
    for (const axis of ['x', 'y'] as const) {
      const delta = axis === 'x' ? dx : dy;
      if (delta === 0) continue;
      for (const id of chain) {
        const max = this.extent(id)[axis];
        if (max <= 0) continue;
        const current = scroll[id] ?? { x: 0, y: 0 };
        const next = clamp(current[axis] + delta, 0, max);
        if (next === current[axis]) continue;
        scroll[id] = { ...current, [axis]: next };
        moved = true;
        break;
      }
    }
    if (moved) {
      this.scene = { ...this.scene, scroll };
      this.staged = null;
    }
    return moved;
  }

  /** Scrolls the nearest scrolling frame round a layer so that the layer is at its top-left, as far as it goes. */
  private scrollTo(layerId: NodeId, transition: Transition): void {
    const roots = this.roots();
    const ancestors = getAncestorIds(this.doc, layerId);
    const rootIndex = ancestors.findIndex((id) => roots.includes(id));
    if (rootIndex < 0) return;
    const within = ancestors.slice(0, rootIndex + 1);
    const containerId = within.find((id) => this.extent(id).x > 0 || this.extent(id).y > 0) ?? within[within.length - 1];
    if (containerId === undefined) return;
    // Where the layer is in the container, through the frames between.
    let x = 0;
    let y = 0;
    for (const id of [layerId, ...within]) {
      if (id === containerId) break;
      const node = this.doc.nodes[id] as LayerNode;
      x += node.x;
      y += node.y;
    }
    const max = this.extent(containerId);
    const from = this.scene.scroll[containerId] ?? { x: 0, y: 0 };
    const to = { x: clamp(x, 0, max.x), y: clamp(y, 0, max.y) };
    this.tweens = this.tweens.filter((tween) => tween.frameId !== containerId);
    if (timeOf(transition) > 0) this.tweens.push({ frameId: containerId, from, to, start: this.now, transition });
    else this.scene = { ...this.scene, scroll: { ...this.scene.scroll, [containerId]: to } };
    this.staged = null;
  }

  /** How far a frame is scrolled now. */
  scrollOf(frameId: NodeId): Point {
    return this.scene.scroll[frameId] ?? { x: 0, y: 0 };
  }

  // ------------------------------------------------------------------ input

  private hold(owner: { id: NodeId; reaction: Reaction }): Held {
    const snapshot = this.snapshot();
    const target = this.run(owner.reaction.actions, owner.id, true);
    const change = owner.reaction.actions.find((action) => action.type === 'CHANGE_TO');
    // After a change of variant the layer that was hovered may be gone: it is the instance that is hovered then.
    return { ownerId: target ?? owner.id, snapshot, transition: change ? change.transition : null };
  }

  private release(held: Held): void {
    if (!held.snapshot) return;
    const from = this.snapshot();
    this.doc = held.snapshot.doc;
    this.scene = held.snapshot.scene;
    this.begin('STATE', from, held.transition ? { ...held.transition, delay: 0 } : INSTANT);
  }

  /** Whether a layer is on the stage now: one of the screen and overlays, or in one. */
  private onStage(id: NodeId): boolean {
    if (!this.doc.nodes[id]) return false;
    const roots = this.roots();
    return roots.includes(id) || getAncestorIds(this.doc, id).some((ancestor) => roots.includes(ancestor));
  }

  /**
   * The pointer is over a chain of layers now: what lasts while hovering
   * follows it, and if it has left layers it was over, the innermost of them
   * with a "mouse leave" interaction runs it, once, and it is kept.
   */
  private track(chain: readonly NodeId[]): void {
    const left = this.under.filter((id) => !chain.includes(id));
    this.under = [...chain];
    this.updateHover(chain);
    // A layer of a screen that has gone, or of a variant no longer shown, has not been left: it is not there.
    const owner = this.owner(left.filter((id) => this.onStage(id)), 'MOUSE_LEAVE');
    if (owner) this.run(owner.reaction.actions, owner.id);
  }

  private updateHover(chain: readonly NodeId[]): void {
    if (this.hover && chain.includes(this.hover.ownerId)) return;
    if (this.hover) {
      this.release(this.hover);
      this.hover = null;
      // What was hovered may have been a layer of a variant that is no longer shown.
      chain = chain.filter((id) => this.doc.nodes[id] !== undefined);
    }
    const owner = this.owner(chain, 'MOUSE_ENTER');
    if (owner) this.hover = this.hold(owner);
  }

  /** The pointer is at a point of the screen. */
  pointerMove(point: Point): void {
    const down = this.down;
    if (down) {
      if (!down.dragged && Math.hypot(point.x - down.point.x, point.y - down.point.y) > DRAG_THRESHOLD) {
        down.dragged = true;
        const owner = this.owner(down.chain, 'ON_DRAG');
        if (owner) this.run(owner.reaction.actions, owner.id);
        else down.scrolling = true;
      }
      // Dragging what has no drag of its own scrolls, as a finger does.
      if (down.scrolling) this.scrollBy(down.chain, down.last.x - point.x, down.last.y - point.y);
      down.last = point;
      return;
    }
    this.track(this.chainAt(point));
  }

  /** The pointer has left the screen. */
  pointerLeave(): void {
    if (this.down) return;
    this.track([]);
  }

  pointerDown(point: Point): void {
    const chain = this.chainAt(point);
    this.down = { point, last: point, chain, dragged: false, scrolling: false };
    const owner = this.owner(chain, 'ON_PRESS');
    if (owner) this.press = this.hold(owner);
  }

  /** The pointer is let go. Returns whether a click did something. */
  pointerUp(point: Point): boolean {
    if (this.press) {
      this.release(this.press);
      this.press = null;
    }
    const down = this.down;
    this.down = null;
    if (!down) return false;
    let done = false;
    if (!down.dragged) {
      const chain = this.chainAt(point);
      const top = this.scene.overlays[this.scene.overlays.length - 1];
      const overlay = top === undefined ? undefined : this.doc.nodes[top];
      if (top !== undefined && isLayer(overlay) && overlay.type === 'FRAME' && overlay.overlayCloseOutside && !chain.includes(top)) {
        // A click outside an overlay closes it and does nothing else.
        this.closeOverlay(INSTANT);
        done = true;
      } else {
        this.input = null;
        // Letting go over a layer with a "mouse up" interaction runs it first: the pointer comes up before a click is complete.
        const scene = this.scene;
        const up = this.owner(chain, 'MOUSE_UP');
        if (up) {
          this.run(up.reaction.actions, up.id);
          done = true;
        }
        // If that changed what is shown, what was pressed is no longer there to click.
        const owner = this.scene === scene ? this.owner(chain, 'ON_CLICK') : null;
        const pressed = this.owner(down.chain, 'ON_CLICK');
        if (owner && pressed && owner.id === pressed.id) {
          this.run(owner.reaction.actions, owner.id);
          done = true;
        }
      }
      if (!done) this.missedAt = this.now;
    }
    this.track(this.chainAt(point));
    return done;
  }

  /** The wheel is turned over a point: the innermost frame there that can scroll that way does. */
  wheel(point: Point, dx: number, dy: number): boolean {
    return this.scrollBy(this.chainAt(point), dx, dy);
  }

  /**
   * A key is pressed, named as the keyboard names it, with the modifier keys
   * held (a keyboard event will do). While an input field has the keyboard,
   * it types into its variable; otherwise the first interaction for that key
   * and exactly those modifiers on what is shown runs ("k" is not Ctrl+K).
   * Returns whether the key did something.
   */
  key(key: string, modifiers: { ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean; metaKey?: boolean } = {}): boolean {
    if (this.input !== null) {
      const variable = this.doc.variables[this.input];
      // A shortcut (Ctrl or Meta without Alt, which some keyboards need for ordinary characters) is not typing.
      const shortcut = (modifiers.ctrlKey === true || modifiers.metaKey === true) && modifiers.altKey !== true;
      if (!variable) {
        this.input = null;
      } else if (key === 'Enter' || key === 'Escape' || key === 'Tab') {
        this.input = null;
        return true;
      } else if (!shortcut) {
        const at = this.inputOwner !== null && this.doc.nodes[this.inputOwner] ? this.inputOwner : this.scene.screenId;
        const text = valueText(resolveVariable(this.doc, variable.id, at) ?? '');
        if (key === 'Backspace') this.setVariable(variable, text.slice(0, -1), at);
        else if (key.length === 1) this.setVariable(variable, text + key, at);
        else return false;
        return true;
      }
    }
    const pressed = keyComboOf({ key, ...modifiers });
    for (const rootId of this.roots().reverse()) {
      for (const id of [rootId, ...getDescendantIds(this.doc, rootId)]) {
        const reaction = this.reactionsOf(id).find((entry) => entry.trigger.type === 'ON_KEY' && keyCombosMatch(entry.trigger.key, pressed));
        if (!reaction) continue;
        this.run(reaction.actions, id);
        return true;
      }
    }
    return false;
  }

  /** Where on the screen a click does something: the boxes of the layers with a click interaction, in what is on top. */
  hotspots(): Rect[] {
    const stage = this.stage();
    const roots = this.roots();
    const top = roots[roots.length - 1] as NodeId;
    const out: Rect[] = [];
    for (const id of [top, ...getDescendantIds(stage, top)]) {
      if (this.reactionsOf(id).some((reaction) => reaction.trigger.type === 'ON_CLICK' || reaction.trigger.type === 'MOUSE_UP')) out.push(getWorldBounds(stage, id));
    }
    return out;
  }
}
