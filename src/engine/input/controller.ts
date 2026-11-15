import {
  addLayer,
  applyToPoint,
  containerAt,
  deeperTargetAt,
  distance,
  duplicateNodes,
  enclosingFrameOrPage,
  getLayer,
  getWorldMatrix,
  getWorldRotation,
  invert,
  isLayer,
  isText,
  lineBox,
  lineEndpoints,
  moveNodesBy,
  nodesInRect,
  patchNode,
  rectCenter,
  resolveLineHeight,
  rectFromPoints,
  reparentNodes,
  resizeBox,
  resizeNodesInBounds,
  rotateNodesAround,
  selectionTargetAt,
  setLayerBox,
  snapAngle,
  topLevelIds,
  TYPE_LABELS,
  type Document,
  type Handle,
  type LayerPatch,
  type LayerType,
  type NodeId,
  type Point,
  type Rect,
} from '../../core';
import type { EditorStore, ToolId } from '../../state/editorStore';
import { hitFrameLabel, type FrameLabel } from '../render/overlay';
import { panBy, screenToWorld, zoomAt } from '../viewport';
import { getSelectionFrame, handleCursor, hitHandle, pointInSelectionFrame, type SelectionFrame } from './selectionFrame';

/** A pointer event reduced to what the tools need. Coordinates are CSS pixels relative to the canvas. */
export interface PointerInput {
  x: number;
  y: number;
  /** 0 primary, 1 middle, 2 secondary. */
  button: number;
  shiftKey: boolean;
  altKey: boolean;
  /** Ctrl on Windows and Linux, Command on macOS. */
  ctrlKey: boolean;
  /** Click count: 2 for a double-click. */
  detail: number;
}

export interface WheelInput {
  x: number;
  y: number;
  deltaX: number;
  deltaY: number;
  ctrlKey: boolean;
  shiftKey: boolean;
}

const DRAG_THRESHOLD_PX = 3;
const HIT_TOLERANCE_PX = 4;
const ROTATION_SNAP = 15;
const DEFAULT_SHAPE_SIZE = 100;

const SHAPE_TOOLS: Partial<Record<ToolId, LayerType>> = {
  frame: 'FRAME',
  rectangle: 'RECTANGLE',
  ellipse: 'ELLIPSE',
  line: 'LINE',
  polygon: 'POLYGON',
  star: 'STAR',
};

/**
 * Pressing on a selected layer may be the start of a drag, so the selection
 * change it would cause as a click is deferred until the pointer is released
 * without having moved.
 */
type ClickAction =
  | { kind: 'none' }
  /** Reduce a multi-selection to this layer. */
  | { kind: 'collapse'; id: NodeId }
  /** Shift-click on a selected layer removes it from the selection. */
  | { kind: 'deselect'; id: NodeId }
  /** Click on empty space inside the selection box clears the selection. */
  | { kind: 'clear' }
  /**
   * Double-click on a text layer opens it for editing. This waits for the
   * release because the browser moves keyboard focus to the canvas on the
   * press, which would immediately close an editor opened any earlier.
   */
  | { kind: 'edit-text'; id: NodeId };

type Mode =
  | { kind: 'idle' }
  | { kind: 'pan'; lastX: number; lastY: number }
  | {
      kind: 'press';
      startScreen: Point;
      startWorld: Point;
      /** What a click without a drag does to the selection. */
      onClick: ClickAction;
    }
  | { kind: 'move'; startWorld: Point; base: Document; ids: NodeId[]; duplicated: boolean }
  | { kind: 'marquee'; startWorld: Point; baseSelection: NodeId[] }
  | { kind: 'resize'; handle: Handle; frame: SelectionFrame; base: Document; ids: NodeId[] }
  | { kind: 'line-end'; id: NodeId; base: Document; fixed: Point }
  | { kind: 'rotate'; pivot: Point; startAngle: number; base: Document; ids: NodeId[] }
  | { kind: 'draw'; type: LayerType; id: NodeId; parentId: NodeId; base: Document; startScreen: Point; startWorld: Point }
  /** Text tool: a click places auto-width text, a drag sets the width of a text box. */
  | { kind: 'text'; startScreen: Point; startWorld: Point };

export interface ControllerHost {
  /** Called when the overlay (marquee, handles) needs repainting without a store change. */
  requestRender(): void;
  setCursor(cursor: string): void;
}

/**
 * Turns pointer, wheel and key input into document changes. It holds only
 * transient interaction state (the drag in progress); everything it changes
 * goes through the editor store, so every interaction is undoable and saved.
 * It has no DOM dependency and can be driven directly from tests.
 */
export class InteractionController {
  private mode: Mode = { kind: 'idle' };
  private spaceDown = false;
  /** Marquee rectangle in page space, read by the overlay renderer. */
  marquee: Rect | null = null;
  /** Frame name labels from the last overlay paint, used for hit testing. */
  labels: FrameLabel[] = [];

  constructor(
    private readonly store: EditorStore,
    private readonly host: ControllerHost,
  ) {}

  /** True while the selection is being moved, resized, rotated or drawn. */
  get isTransforming(): boolean {
    const kind = this.mode.kind;
    return kind === 'move' || kind === 'resize' || kind === 'rotate' || kind === 'line-end' || kind === 'draw';
  }

  get isBusy(): boolean {
    return this.mode.kind !== 'idle';
  }

  private get state() {
    return this.store.getState();
  }

  private toWorld(p: Point): Point {
    return screenToWorld(this.state.viewport, p);
  }

  /** Converts a page-space point into the coordinate space of `parentId`. */
  private toParent(doc: Document, parentId: NodeId, world: Point): Point {
    return applyToPoint(invert(getWorldMatrix(doc, parentId)), world);
  }

  // ---------------------------------------------------------------- pointer

  pointerDown(e: PointerInput): void {
    if (this.mode.kind !== 'idle') return;
    const { tool } = this.state;
    if (e.button === 1 || (e.button === 0 && (this.spaceDown || tool === 'hand'))) {
      this.mode = { kind: 'pan', lastX: e.x, lastY: e.y };
      this.host.setCursor('grabbing');
      return;
    }
    if (e.button !== 0) return;
    const shape = SHAPE_TOOLS[tool];
    if (shape) this.beginDraw(shape, e);
    else if (tool === 'text') {
      const world = this.toWorld(e);
      this.state.setHovered(null);
      this.mode = { kind: 'text', startScreen: { x: e.x, y: e.y }, startWorld: { x: Math.round(world.x), y: Math.round(world.y) } };
    } else this.beginSelect(e);
  }

  pointerMove(e: PointerInput): void {
    const mode = this.mode;
    const world = this.toWorld(e);
    switch (mode.kind) {
      case 'idle':
        this.updateHover(e);
        return;
      case 'pan':
        this.store.getState().setViewport(panBy(this.state.viewport, e.x - mode.lastX, e.y - mode.lastY));
        mode.lastX = e.x;
        mode.lastY = e.y;
        return;
      case 'press':
        if (distance(e, mode.startScreen) > DRAG_THRESHOLD_PX) this.beginMove(mode.startWorld, e);
        return;
      case 'move':
        this.updateMove(mode, world, e);
        return;
      case 'marquee': {
        const rect = rectFromPoints(mode.startWorld, world);
        this.marquee = rect;
        const inside = nodesInRect(this.state.doc, this.state.pageId, rect);
        const merged = [...mode.baseSelection, ...inside.filter((id) => !mode.baseSelection.includes(id))];
        this.state.setSelection(merged);
        this.host.requestRender();
        return;
      }
      case 'resize':
        this.updateResize(mode, world, e);
        return;
      case 'line-end':
        this.updateLineEnd(mode, world, e);
        return;
      case 'rotate':
        this.updateRotate(mode, world, e);
        return;
      case 'draw':
        this.updateDraw(mode, e);
        return;
      case 'text':
        // Show the box being dragged out.
        this.marquee = distance(e, mode.startScreen) > DRAG_THRESHOLD_PX ? rectFromPoints(mode.startWorld, world) : null;
        this.host.requestRender();
        return;
    }
  }

  pointerUp(e: PointerInput): void {
    const mode = this.mode;
    this.mode = { kind: 'idle' };
    const state = this.state;
    switch (mode.kind) {
      case 'idle':
        return;
      case 'pan':
        break;
      case 'press': {
        const action = mode.onClick;
        if (action.kind === 'collapse') state.setSelection([action.id]);
        else if (action.kind === 'deselect') state.setSelection(state.selection.filter((id) => id !== action.id));
        else if (action.kind === 'clear') state.setSelection([]);
        else if (action.kind === 'edit-text') state.setEditingText(action.id);
        break;
      }
      case 'move':
        state.commitGesture(mode.duplicated ? 'Duplicate' : 'Move');
        break;
      case 'marquee':
        this.marquee = null;
        break;
      case 'resize':
      case 'line-end':
        state.commitGesture('Resize');
        break;
      case 'rotate':
        state.commitGesture('Rotate');
        break;
      case 'draw':
        this.finishDraw(mode, e);
        break;
      case 'text':
        this.marquee = null;
        this.createText(mode, e);
        break;
    }
    this.updateHover(e);
    this.host.requestRender();
  }

  /** Abandons the interaction in progress and restores the document. Returns true if there was one. */
  cancel(): boolean {
    const mode = this.mode;
    if (mode.kind === 'idle') return false;
    this.mode = { kind: 'idle' };
    this.marquee = null;
    this.state.cancelGesture();
    if (mode.kind === 'draw' || mode.kind === 'text') this.state.setTool('move');
    this.host.setCursor(this.idleCursor());
    this.host.requestRender();
    return true;
  }

  /** The pointer left the canvas. */
  pointerLeave(): void {
    if (this.mode.kind === 'idle') this.state.setHovered(null);
  }

  // ------------------------------------------------------------------ wheel

  wheel(e: WheelInput): void {
    const state = this.state;
    if (e.ctrlKey) {
      // Ctrl + wheel, and trackpad pinch (which browsers report as ctrl + wheel).
      const factor = Math.exp(-e.deltaY * 0.0045);
      state.setViewport(zoomAt(state.viewport, { x: e.x, y: e.y }, state.viewport.zoom * factor));
      return;
    }
    const dx = e.shiftKey && e.deltaX === 0 ? e.deltaY : e.deltaX;
    const dy = e.shiftKey && e.deltaX === 0 ? 0 : e.deltaY;
    state.setViewport(panBy(state.viewport, -dx, -dy));
  }

  // ------------------------------------------------------------------- keys

  /** Holding Space turns the pointer into the hand tool temporarily. */
  setSpaceDown(down: boolean): void {
    if (this.spaceDown === down) return;
    this.spaceDown = down;
    if (this.mode.kind === 'idle') this.host.setCursor(this.idleCursor());
  }

  /** The cursor for the active tool when nothing more specific applies. */
  idleCursor(): string {
    if (this.spaceDown || this.state.tool === 'hand') return 'grab';
    if (this.state.tool === 'text') return 'text';
    return SHAPE_TOOLS[this.state.tool] ? 'crosshair' : 'default';
  }

  // -------------------------------------------------------------- selecting

  /** The layer a right-click at this point refers to, selecting it if it is not already selected. */
  contextTarget(e: PointerInput): NodeId | null {
    const state = this.state;
    const world = this.toWorld(e);
    const target =
      hitFrameLabel(this.labels, e) ??
      selectionTargetAt(state.doc, state.pageId, world, state.selection, {
        tolerance: HIT_TOLERANCE_PX / state.viewport.zoom,
      });
    if (target && !state.selection.includes(target)) state.setSelection([target]);
    else if (!target) {
      const frame = getSelectionFrame(state.doc, state.selection);
      if (!frame || !pointInSelectionFrame(frame, world)) state.setSelection([]);
    }
    return target;
  }

  private updateHover(e: PointerInput): void {
    const state = this.state;
    if (this.spaceDown || state.tool !== 'move') {
      state.setHovered(null);
      this.host.setCursor(this.idleCursor());
      return;
    }
    const frame = getSelectionFrame(state.doc, state.selection);
    const handle = frame ? hitHandle(frame, state.viewport, e) : null;
    if (frame && handle) {
      state.setHovered(null);
      this.host.setCursor(handleCursor(handle, frame));
      return;
    }
    const world = this.toWorld(e);
    const target =
      hitFrameLabel(this.labels, e) ??
      selectionTargetAt(state.doc, state.pageId, world, state.selection, {
        tolerance: HIT_TOLERANCE_PX / state.viewport.zoom,
        deep: e.ctrlKey,
      });
    state.setHovered(target);
    this.host.setCursor('default');
  }

  private beginSelect(e: PointerInput): void {
    const state = this.state;
    const world = this.toWorld(e);
    const tolerance = HIT_TOLERANCE_PX / state.viewport.zoom;
    const frame = getSelectionFrame(state.doc, state.selection);

    // 1. A transform handle of the current selection.
    const handle = frame ? hitHandle(frame, state.viewport, e) : null;
    if (frame && handle) {
      const ids = topLevelIds(state.doc, state.selection);
      state.beginGesture();
      state.setHovered(null);
      if (handle.kind === 'resize') {
        this.mode = { kind: 'resize', handle: handle.handle, frame, base: state.doc, ids };
      } else if (handle.kind === 'rotate') {
        const pivot = frame.single
          ? { x: (frame.corners[0].x + frame.corners[2].x) / 2, y: (frame.corners[0].y + frame.corners[2].y) / 2 }
          : rectCenter(frame.bounds);
        this.mode = {
          kind: 'rotate',
          pivot,
          startAngle: (Math.atan2(world.y - pivot.y, world.x - pivot.x) * 180) / Math.PI,
          base: state.doc,
          ids,
        };
      } else if (frame.single) {
        const node = getLayer(state.doc, frame.single);
        if (node) {
          const ends = lineEndpoints(node);
          this.mode = { kind: 'line-end', id: frame.single, base: state.doc, fixed: ends[handle.end === 0 ? 1 : 0] };
        }
      }
      return;
    }

    // 2. A layer (through a frame's name label, or directly).
    const label = hitFrameLabel(this.labels, e);
    let target =
      label ?? selectionTargetAt(state.doc, state.pageId, world, state.selection, { tolerance, deep: e.ctrlKey });
    if (!label && e.detail >= 2) {
      const deeper = deeperTargetAt(state.doc, state.pageId, world, state.selection, tolerance);
      // Double-clicking a text layer that a single click already reaches edits its text.
      if (deeper && isText(state.doc.nodes[deeper]) && (deeper === target || state.selection.includes(deeper))) {
        state.setSelection([deeper]);
        this.mode = {
          kind: 'press',
          startScreen: { x: e.x, y: e.y },
          startWorld: world,
          onClick: { kind: 'edit-text', id: deeper },
        };
        return;
      }
      target = deeper ?? target;
    }

    if (target) {
      const already = state.selection.includes(target);
      let onClick: ClickAction = { kind: 'none' };
      if (!already) state.setSelection(e.shiftKey ? [...state.selection, target] : [target]);
      else if (e.shiftKey) onClick = { kind: 'deselect', id: target };
      else if (state.selection.length > 1) onClick = { kind: 'collapse', id: target };
      this.mode = { kind: 'press', startScreen: { x: e.x, y: e.y }, startWorld: world, onClick };
      return;
    }

    // 3. Empty space inside the selection box drags the selection.
    if (frame && !e.shiftKey && pointInSelectionFrame(frame, world)) {
      this.mode = { kind: 'press', startScreen: { x: e.x, y: e.y }, startWorld: world, onClick: { kind: 'clear' } };
      return;
    }

    // 4. Empty canvas: marquee.
    if (!e.shiftKey) state.setSelection([]);
    this.mode = { kind: 'marquee', startWorld: world, baseSelection: e.shiftKey ? [...state.selection] : [] };
  }

  // ----------------------------------------------------------------- moving

  private beginMove(startWorld: Point, e: PointerInput): void {
    const state = this.state;
    const ids = topLevelIds(state.doc, state.selection).filter((id) => {
      const node = state.doc.nodes[id];
      return isLayer(node) && !node.locked;
    });
    if (ids.length === 0) {
      this.mode = { kind: 'idle' };
      return;
    }
    state.beginGesture();
    state.setHovered(null);
    if (e.altKey) {
      // Alt-drag leaves the originals in place and drags copies.
      const copy = duplicateNodes(state.doc, ids);
      this.mode = { kind: 'move', startWorld, base: copy.doc, ids: copy.ids, duplicated: true };
    } else {
      this.mode = { kind: 'move', startWorld, base: state.doc, ids, duplicated: false };
    }
    this.host.setCursor('default');
    this.updateMove(this.mode as Extract<Mode, { kind: 'move' }>, this.toWorld(e), e);
  }

  private updateMove(mode: Extract<Mode, { kind: 'move' }>, world: Point, e: PointerInput): void {
    let dx = world.x - mode.startWorld.x;
    let dy = world.y - mode.startWorld.y;
    if (e.shiftKey) {
      if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
      else dx = 0;
    }
    const pageId = this.state.pageId;
    this.state.updateGesture(() => {
      let doc = moveNodesBy(mode.base, mode.ids, dx, dy, true);
      // Dropping onto a frame puts the layers inside it; dragging out takes them out.
      // A layer inside a group stays in its group while it remains over the same frame.
      const container = containerAt(doc, pageId, world, new Set(mode.ids));
      const outside = mode.ids.filter((id) => {
        const parentId = doc.nodes[id]?.parentId;
        return parentId != null && enclosingFrameOrPage(doc, parentId) !== container;
      });
      if (outside.length > 0) doc = reparentNodes(doc, outside, container);
      return doc;
    }, mode.ids);
  }

  // --------------------------------------------------------------- resizing

  private updateResize(mode: Extract<Mode, { kind: 'resize' }>, world: Point, e: PointerInput): void {
    const { frame, base, handle } = mode;
    const single = frame.single ? getLayer(base, frame.single) : undefined;
    if (single) {
      const pointer = this.toParent(base, single.parentId, world);
      const box = resizeBox(single, handle, pointer, {
        keepAspect: e.shiftKey,
        fromCenter: e.altKey,
        snap: getWorldRotation(base, single.id) === 0,
      });
      // Dragging a text layer's handle stops its size following its content in that direction.
      const textMode =
        single.type === 'TEXT'
          ? { textAutoResize: handle.hy !== 0 || single.textAutoResize === 'NONE' ? ('NONE' as const) : ('HEIGHT' as const) }
          : null;
      this.state.updateGesture(() => {
        const resized = setLayerBox(base, single.id, box);
        return textMode ? patchNode(resized, single.id, textMode) : resized;
      });
      return;
    }
    const from = frame.bounds;
    const to = resizeBox({ ...from, rotation: 0 }, handle, world, {
      keepAspect: e.shiftKey,
      fromCenter: e.altKey,
      snap: true,
    });
    this.state.updateGesture(() => resizeNodesInBounds(base, mode.ids, from, to, true));
  }

  private updateLineEnd(mode: Extract<Mode, { kind: 'line-end' }>, world: Point, e: PointerInput): void {
    const node = getLayer(mode.base, mode.id);
    if (!node) return;
    let pointer = this.toParent(mode.base, node.parentId, world);
    if (e.shiftKey) pointer = snapAngle(mode.fixed, pointer, ROTATION_SNAP);
    else if (getWorldRotation(mode.base, node.parentId) === 0) pointer = { x: Math.round(pointer.x), y: Math.round(pointer.y) };
    const [start] = lineEndpoints(node);
    // Keep the line's direction: the fixed end stays the end it was.
    const fixedIsStart = distance(start, mode.fixed) < 1e-6;
    const box = fixedIsStart ? lineBox(mode.fixed, pointer) : lineBox(pointer, mode.fixed);
    this.state.updateGesture(() => patchNode(mode.base, mode.id, box));
  }

  // --------------------------------------------------------------- rotating

  private updateRotate(mode: Extract<Mode, { kind: 'rotate' }>, world: Point, e: PointerInput): void {
    const angle = (Math.atan2(world.y - mode.pivot.y, world.x - mode.pivot.x) * 180) / Math.PI;
    let delta = angle - mode.startAngle;
    if (e.shiftKey) delta = Math.round(delta / ROTATION_SNAP) * ROTATION_SNAP;
    else delta = Math.round(delta);
    this.state.updateGesture(() => rotateNodesAround(mode.base, mode.ids, mode.pivot, delta));
  }

  // ---------------------------------------------------------------- drawing

  private beginDraw(type: LayerType, e: PointerInput): void {
    const state = this.state;
    const world = this.toWorld(e);
    const startWorld = { x: Math.round(world.x), y: Math.round(world.y) };
    const parentId = containerAt(state.doc, state.pageId, startWorld);
    const origin = this.toParent(state.doc, parentId, startWorld);
    state.beginGesture();
    state.setHovered(null);
    const created = addLayer(state.doc, type, parentId, { x: origin.x, y: origin.y, width: 0, height: 0 });
    this.mode = {
      kind: 'draw',
      type,
      id: created.id,
      parentId,
      base: created.doc,
      startScreen: { x: e.x, y: e.y },
      startWorld,
    };
    state.updateGesture(() => created.doc, [created.id]);
  }

  /**
   * Creates a text layer and starts editing it. The gesture is left open: the
   * in-place editor commits it (as "Create text") or cancels it if nothing
   * was typed, so an abandoned text layer leaves no trace in the history.
   */
  private createText(mode: Extract<Mode, { kind: 'text' }>, e: PointerInput): void {
    const state = this.state;
    const world = this.toWorld(e);
    const dragged = distance(e, mode.startScreen) > DRAG_THRESHOLD_PX;
    const parentId = containerAt(state.doc, state.pageId, mode.startWorld);
    const a = this.toParent(state.doc, parentId, mode.startWorld);
    state.beginGesture();
    let props: LayerPatch;
    if (dragged) {
      const b = this.toParent(state.doc, parentId, { x: Math.round(world.x), y: Math.round(world.y) });
      const box = rectFromPoints(a, b);
      props = { x: box.x, y: box.y, width: Math.max(10, box.width), textAutoResize: 'HEIGHT' };
    } else {
      // Put the first line's middle where the user clicked.
      const lineHeight = resolveLineHeight({ lineHeight: null, fontSize: 16 });
      props = { x: a.x, y: Math.round(a.y - lineHeight / 2) };
    }
    const created = addLayer(state.doc, 'TEXT', parentId, props);
    state.updateGesture(() => created.doc, [created.id]);
    state.setTool('move');
    this.store.getState().setEditingText(created.id);
    this.host.setCursor('default');
  }

  private drawBox(mode: Extract<Mode, { kind: 'draw' }>, e: PointerInput): LayerPatch {
    const world = this.toWorld(e);
    const a = this.toParent(mode.base, mode.parentId, mode.startWorld);
    let b = this.toParent(mode.base, mode.parentId, { x: Math.round(world.x), y: Math.round(world.y) });

    if (mode.type === 'LINE') {
      if (e.shiftKey) b = snapAngle(a, b, 45);
      return lineBox(a, b);
    }
    if (e.shiftKey) {
      const side = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      b = { x: a.x + (b.x >= a.x ? side : -side), y: a.y + (b.y >= a.y ? side : -side) };
    }
    const start = e.altKey ? { x: a.x - (b.x - a.x), y: a.y - (b.y - a.y) } : a;
    return rectFromPoints(start, b);
  }

  private updateDraw(mode: Extract<Mode, { kind: 'draw' }>, e: PointerInput): void {
    const box = this.drawBox(mode, e);
    this.state.updateGesture(() => patchNode(mode.base, mode.id, box), [mode.id]);
  }

  private finishDraw(mode: Extract<Mode, { kind: 'draw' }>, e: PointerInput): void {
    const state = this.state;
    const dragged = distance(e, mode.startScreen) > DRAG_THRESHOLD_PX;
    let box: LayerPatch;
    if (dragged) {
      box = this.drawBox(mode, e);
      if (mode.type !== 'LINE') {
        box = { ...box, width: Math.max(1, box.width ?? 0), height: Math.max(1, box.height ?? 0) };
      }
    } else {
      // A click without a drag creates the shape at its default size.
      const origin = this.toParent(mode.base, mode.parentId, mode.startWorld);
      box =
        mode.type === 'LINE'
          ? lineBox(origin, { x: origin.x + DEFAULT_SHAPE_SIZE, y: origin.y })
          : { x: origin.x, y: origin.y, width: DEFAULT_SHAPE_SIZE, height: DEFAULT_SHAPE_SIZE };
    }
    state.updateGesture(() => patchNode(mode.base, mode.id, box), [mode.id]);
    state.commitGesture(`Create ${TYPE_LABELS[mode.type].toLowerCase()}`);
    state.setTool('move');
    this.host.setCursor('default');
  }
}
