import {
  addLayer,
  applyToPoint,
  clean,
  collectSnapRects,
  collectSnapTargets,
  containerAt,
  deeperTargetAt,
  distance,
  duplicateNodes,
  enclosingFrameOrPage,
  getLayer,
  guideSnapTargets,
  countGuides,
  flipNodes,
  frameGuides,
  frameTakesGuides,
  hitFrameGuide,
  hitGuide,
  mirrorInPlace,
  isFrame,
  isInFlow,
  isPage,
  measureDistances,
  placeInFlow,
  releaseSizing,
  setGuide,
  getWorldBounds,
  getWorldMatrix,
  getWorldRotation,
  invert,
  isAncestor,
  isLayer,
  isGroupLike,
  isText,
  isVector,
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
  resizeFlips,
  resizeNodesInBounds,
  rotateNodesAround,
  selectionTargetAt,
  setLayerBox,
  snapAngle,
  snapPoint,
  snapRect,
  snapSpacing,
  spacingMarks,
  topLevelIds,
  TYPE_LABELS,
  unionRects,
  type DistanceMark,
  type Document,
  type Guide,
  type Handle,
  type LayerPatch,
  type LayerType,
  type NodeId,
  type Point,
  type Rect,
  type SnapAxes,
  type SnapGuide,
  type SnapTargets,
} from '../../core';
import type { EditorStore, PaintEdit, ToolId } from '../../state/editorStore';
import { hitFrameLabel, type FrameLabel } from '../render/overlay';
import { RULER_SIZE } from '../render/rulers';
import { panBy, screenToWorld, zoomAt } from '../viewport';
import { arcHandleAt, dragArcHandle, type ArcHandle } from './arcHandles';
import { cropUnderPointer, dragCrop } from './cropDrag';
import { dragGradientHandle, gradientHandleAt, type GradientHandle } from './gradientHandles';
import { getSelectionFrame, handleCursor, hitHandle, pointInSelectionFrame, type SelectionFrame } from './selectionFrame';
import { VectorTool, type VectorOverlay } from './vectorTool';

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
/** How close, in screen pixels, an edge must come to a line to snap to it. */
const SNAP_DISTANCE_PX = 6;
const DEFAULT_SHAPE_SIZE = 100;
/** How close, in screen pixels, the pointer must be to a ruler guide to grab it. */
const GUIDE_HIT_PX = 4;

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
  | { kind: 'text'; startScreen: Point; startWorld: Point }
  /** A ruler guide being pulled out of a ruler (`owner` and `index` null) or moved (the page or frame it is in, and its index there). */
  | { kind: 'guide'; axis: Guide['axis']; owner: NodeId | null; index: number | null; base: Document }
  /** The Pen tool or point editing has the pointer; see `VectorTool`. */
  | { kind: 'vector' }
  /** A cropped image is being dragged about inside its layer. */
  | { kind: 'crop'; edit: PaintEdit; startWorld: Point; base: Document }
  /** One of the two handles of a gradient is being dragged. */
  | { kind: 'gradient'; edit: PaintEdit; handle: GradientHandle; base: Document }
  /** One of the handles that shape an ellipse's arc is being dragged. */
  | { kind: 'arc'; id: NodeId; handle: ArcHandle; base: Document };

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
  /** Smart guides for whatever is snapped right now, read by the overlay renderer. */
  guides: SnapGuide[] = [];
  /**
   * Distances to show with their lengths: the equal gaps the layers being moved sit in, or, while Alt is held,
   * what lies between the selection and the layer under the pointer. Read by the overlay renderer.
   */
  distances: DistanceMark[] = [];
  /** Edges carried on to a measured distance that they do not reach, drawn dashed. */
  distanceGuides: SnapGuide[] = [];
  /** The last pointer position seen while nothing was being dragged, so that pressing Alt can measure from it. */
  private lastHover: PointerInput | null = null;
  /** Snap lines and boxes of the container being worked in, kept for the length of one interaction. */
  private snapCache: { doc: Document; key: string; targets: SnapTargets; rects: Rect[] } | null = null;

  /** The Pen tool and the editing of a vector's points. */
  readonly vector: VectorTool;

  constructor(
    private readonly store: EditorStore,
    private readonly host: ControllerHost,
  ) {
    this.vector = new VectorTool(store, {
      requestRender: () => host.requestRender(),
      setCursor: (cursor) => host.setCursor(cursor),
      setMarquee: (rect) => {
        this.marquee = rect;
      },
      snapPoint: (world, doc, containerId, exclude, show) => {
        const snapped = this.snapWorldPoint(this.whole(world), doc, [containerId], exclude, { x: true, y: true });
        if (!show) this.guides = [];
        return snapped;
      },
    });
  }

  /** True while the selection is being moved, resized, rotated or drawn. */
  get isTransforming(): boolean {
    const kind = this.mode.kind;
    if (kind === 'vector') return this.vector.isTransforming;
    return kind === 'move' || kind === 'resize' || kind === 'rotate' || kind === 'line-end' || kind === 'draw';
  }

  /** What the overlay draws for the vector being edited or drawn, if any. */
  vectorOverlay(): VectorOverlay | null {
    return this.vector.overlay();
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

  /** A point put on whole pixels, when snapping to the pixel grid is on; otherwise just tidied to a thousandth. */
  private whole(p: Point): Point {
    return this.state.pixelSnap ? { x: Math.round(p.x), y: Math.round(p.y) } : { x: clean(p.x), y: clean(p.y) };
  }

  /**
   * The lines available for snapping in one or more containers, leaving out
   * the layers being transformed. Cached per interaction, since the layers
   * that are not moving do not change while it lasts.
   */
  private snapSources(doc: Document, containerIds: readonly NodeId[], exclude: ReadonlySet<NodeId>): { targets: SnapTargets; rects: Rect[] } {
    const key = containerIds.join(',');
    if (this.snapCache && this.snapCache.doc === doc && this.snapCache.key === key) return this.snapCache;
    const targets: SnapTargets = { xs: [], ys: [] };
    // The boxes of the same layers, for spacing a moving layer evenly among them.
    const rects: Rect[] = [];
    for (const id of new Set(containerIds)) {
      const part = collectSnapTargets(doc, id, exclude, { layoutGrids: this.state.showLayoutGrids });
      targets.xs.push(...part.xs);
      targets.ys.push(...part.ys);
      rects.push(...collectSnapRects(doc, id, exclude));
    }
    // The page's ruler guides, and those of the frames being worked in, while the rulers are shown.
    if (this.state.showRulers) {
      const guides = guideSnapTargets(this.pageGuides(doc));
      targets.xs.push(...guides.xs);
      targets.ys.push(...guides.ys);
      const containers = new Set(containerIds);
      for (const guide of frameGuides(doc, this.state.pageId)) {
        if (!containers.has(guide.ownerId)) continue;
        (guide.axis === 'X' ? targets.xs : targets.ys).push({ value: guide.position, from: guide.from, to: guide.to });
      }
    }
    this.snapCache = { doc, key, targets, rects };
    return this.snapCache;
  }

  private snapTargets(doc: Document, containerIds: readonly NodeId[], exclude: ReadonlySet<NodeId>): SnapTargets {
    return this.snapSources(doc, containerIds, exclude).targets;
  }

  /** Snaps a page-space point to nearby lines, if snapping is on, and shows the guides. */
  private snapWorldPoint(point: Point, doc: Document, containerIds: readonly NodeId[], exclude: ReadonlySet<NodeId>, axes: SnapAxes): Point {
    this.guides = [];
    if (!this.state.snapping || (!axes.x && !axes.y)) return point;
    const snapped = snapPoint(point, this.snapTargets(doc, containerIds, exclude), SNAP_DISTANCE_PX / this.state.viewport.zoom, axes);
    this.guides = snapped.guides;
    return snapped.point;
  }

  private pageGuides(doc: Document): readonly Guide[] {
    const page = doc.nodes[this.state.pageId];
    return isPage(page) ? page.guides : [];
  }

  /** Which ruler a canvas point is on: 'Y' for the top ruler (it makes horizontal guides), 'X' for the left one. */
  private rulerAt(p: Point): Guide['axis'] | 'corner' | null {
    if (!this.state.showRulers) return null;
    const top = p.y < RULER_SIZE;
    const left = p.x < RULER_SIZE;
    if (top && left) return 'corner';
    return top ? 'Y' : left ? 'X' : null;
  }

  /**
   * The ruler guide under a page-space point, while guides are shown: which page or frame it belongs to and its
   * index there. A frame's guides are drawn over the page's, so they are found first.
   */
  private guideAt(world: Point): { owner: NodeId; index: number; axis: Guide['axis'] } | null {
    if (!this.state.showRulers) return null;
    const state = this.state;
    const tolerance = GUIDE_HIT_PX / state.viewport.zoom;
    const placed = hitFrameGuide(frameGuides(state.doc, state.pageId), world, tolerance);
    if (placed) return { owner: placed.ownerId, index: placed.index, axis: placed.axis };
    const index = hitGuide(this.pageGuides(state.doc), world, tolerance);
    const guide = index === null ? undefined : this.pageGuides(state.doc)[index];
    return guide && index !== null ? { owner: state.pageId, index, axis: guide.axis } : null;
  }

  private beginGuide(axis: Guide['axis'], owner: NodeId | null, index: number | null): void {
    const state = this.state;
    state.beginGesture();
    state.setHovered(null);
    this.mode = { kind: 'guide', axis, owner, index, base: state.doc };
    this.host.setCursor(axis === 'X' ? 'col-resize' : 'row-resize');
  }

  /**
   * Follows the pointer with the guide. Over a frame that can show guides it is that frame's guide, in the
   * frame's own space; anywhere else it is the page's. Over its own ruler it is removed, so dragging it
   * back there deletes it.
   */
  private updateGuide(mode: Extract<Mode, { kind: 'guide' }>, e: PointerInput): void {
    const world = this.toWorld(e);
    const overRuler = mode.axis === 'X' ? e.x < RULER_SIZE : e.y < RULER_SIZE;
    const pageId = this.state.pageId;
    this.state.updateGesture(() => {
      const base = mode.base;
      const without = mode.owner !== null && mode.index !== null ? setGuide(base, mode.owner, mode.index, null) : base;
      if (overRuler) return without;
      const under = containerAt(base, pageId, world, new Set());
      const owner = under !== pageId && frameTakesGuides(base, under) ? under : pageId;
      const origin = owner === pageId ? { x: 0, y: 0 } : getWorldBounds(base, owner);
      const guide: Guide = { axis: mode.axis, position: Math.round(mode.axis === 'X' ? world.x - origin.x : world.y - origin.y) };
      // Moved within the page or frame it is in, it keeps its place in the list; taken to another, it is added there.
      if (mode.owner === owner && mode.index !== null) return setGuide(base, owner, mode.index, guide);
      return setGuide(without, owner, null, guide);
    });
  }

  private endSnapping(): void {
    this.guides = [];
    this.snapCache = null;
    this.clearDistances();
  }

  /** Puts away the distances being shown. */
  private clearDistances(): void {
    if (this.distances.length === 0 && this.distanceGuides.length === 0) return;
    this.distances = [];
    this.distanceGuides = [];
    this.host.requestRender();
  }

  /**
   * Shows the distances from the selection to another layer: the one under the pointer or, over the selection
   * itself or over nothing, the frame the selection is in.
   */
  private measureTo(target: NodeId | null): void {
    const state = this.state;
    const ids = topLevelIds(state.doc, state.selection).filter((id) => isLayer(state.doc.nodes[id]));
    const from = unionRects(ids.map((id) => getWorldBounds(state.doc, id)));
    if (!from) return;
    let other = target !== null && !state.selection.includes(target) ? target : null;
    if (other === null) {
      const parentId = state.doc.nodes[ids[0] as NodeId]?.parentId;
      if (parentId && isFrame(state.doc.nodes[parentId])) other = parentId;
    }
    if (other === null) return;
    const measured = measureDistances(from, getWorldBounds(state.doc, other));
    this.distances = measured.marks;
    this.distanceGuides = measured.guides;
    if (measured.marks.length > 0) this.host.requestRender();
  }

  /** Converts a page-space point into the coordinate space of `parentId`. */
  private toParent(doc: Document, parentId: NodeId, world: Point): Point {
    return applyToPoint(invert(getWorldMatrix(doc, parentId)), world);
  }

  // ---------------------------------------------------------------- pointer

  pointerDown(e: PointerInput): void {
    if (this.mode.kind !== 'idle') return;
    this.clearDistances();
    const { tool } = this.state;
    if (e.button === 1 || (e.button === 0 && (this.spaceDown || tool === 'hand'))) {
      this.mode = { kind: 'pan', lastX: e.x, lastY: e.y };
      this.host.setCursor('grabbing');
      return;
    }
    if (e.button !== 0) return;
    // The rulers are not canvas: pressing one with the move tool pulls out a guide, and does nothing otherwise.
    const ruler = this.rulerAt(e);
    if (ruler) {
      if (tool === 'move' && ruler !== 'corner') this.beginGuide(ruler, null, null);
      return;
    }
    if (this.vector.wantsPointer) {
      this.vector.pointerDown(e);
      if (this.vector.isBusy) this.mode = { kind: 'vector' };
      this.host.requestRender();
      return;
    }
    const shape = SHAPE_TOOLS[tool];
    if (shape) this.beginDraw(shape, e);
    else if (tool === 'text') {
      const world = this.toWorld(e);
      this.state.setHovered(null);
      this.mode = { kind: 'text', startScreen: { x: e.x, y: e.y }, startWorld: this.whole(world) };
    } else this.beginSelect(e);
  }

  pointerMove(e: PointerInput): void {
    const mode = this.mode;
    const world = this.toWorld(e);
    switch (mode.kind) {
      case 'idle':
        this.lastHover = e;
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
      case 'guide':
        this.updateGuide(mode, e);
        return;
      case 'vector':
        this.vector.pointerMove(e);
        return;
      case 'gradient':
        this.state.updateGesture(() => dragGradientHandle(mode.base, mode.edit, mode.handle, world, e.shiftKey));
        return;
      case 'crop':
        this.state.updateGesture(() => dragCrop(mode.base, mode.edit, mode.startWorld, world));
        return;
      case 'arc': {
        const patch = dragArcHandle(mode.base, mode.id, mode.handle, world, e.shiftKey);
        if (patch) this.state.updateGesture(() => patchNode(mode.base, mode.id, patch));
        return;
      }
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
    this.endSnapping();
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
      case 'guide': {
        const removed = countGuides(state.doc) < countGuides(mode.base);
        state.commitGesture(mode.index === null ? 'Add guide' : removed ? 'Remove guide' : 'Move guide');
        break;
      }
      case 'text':
        this.marquee = null;
        this.createText(mode, e);
        break;
      case 'vector':
        this.vector.pointerUp();
        break;
      case 'arc':
        state.commitGesture('Change arc');
        break;
      case 'gradient':
        state.commitGesture('Change gradient');
        break;
      case 'crop':
        state.commitGesture('Crop image');
        break;
    }
    // Finishing a draw computes its final box, which may snap once more; nothing stays snapped afterwards.
    this.endSnapping();
    this.updateHover(e);
    this.host.requestRender();
  }

  /** Abandons the interaction in progress and restores the document. Returns true if there was one. */
  cancel(): boolean {
    const mode = this.mode;
    // With nothing being dragged, this ends the path the pen is in the middle of.
    if (mode.kind === 'idle') return this.vector.cancel();
    this.mode = { kind: 'idle' };
    this.marquee = null;
    this.endSnapping();
    if (mode.kind === 'vector') {
      this.vector.cancel();
      this.host.requestRender();
      return true;
    }
    this.state.cancelGesture();
    if (mode.kind === 'draw' || mode.kind === 'text') this.state.setTool('move');
    this.host.setCursor(this.idleCursor());
    this.host.requestRender();
    return true;
  }

  /** The pointer left the canvas. */
  pointerLeave(): void {
    if (this.mode.kind !== 'idle') return;
    this.lastHover = null;
    this.clearDistances();
    this.state.setHovered(null);
    this.vector.pointerLeave();
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

  /**
   * Holding Alt measures from the selection to whatever the pointer is over. It takes effect when the key goes
   * down or comes up, without the pointer having to move.
   */
  setAltDown(down: boolean): void {
    if (this.mode.kind !== 'idle' || !this.lastHover || this.lastHover.altKey === down) return;
    this.lastHover = { ...this.lastHover, altKey: down };
    this.updateHover(this.lastHover);
  }

  /** The cursor for the active tool when nothing more specific applies. */
  idleCursor(): string {
    if (this.spaceDown || this.state.tool === 'hand') return 'grab';
    if (this.state.tool === 'text') return 'text';
    if (this.state.tool === 'pen' || this.state.tool === 'pencil') return 'crosshair';
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
    this.clearDistances();
    if (!this.spaceDown && this.vector.wantsPointer) {
      state.setHovered(null);
      this.vector.hover(e);
      return;
    }
    if (this.spaceDown || state.tool !== 'move') {
      state.setHovered(null);
      this.host.setCursor(this.idleCursor());
      return;
    }
    if (gradientHandleAt(state.doc, state.paintEdit, state.viewport, e) || arcHandleAt(state.doc, state.selection, state.viewport, e)) {
      state.setHovered(null);
      this.host.setCursor('pointer');
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
    // A cropped image that is being positioned can be dragged wherever no handle is.
    if (cropUnderPointer(state.doc, state.paintEdit, world)) {
      state.setHovered(null);
      this.host.setCursor('grab');
      return;
    }
    if (this.rulerAt(e)) {
      state.setHovered(null);
      this.host.setCursor('default');
      return;
    }
    const overGuide = this.guideAt(world);
    if (overGuide) {
      state.setHovered(null);
      this.host.setCursor(overGuide.axis === 'X' ? 'col-resize' : 'row-resize');
      return;
    }
    const target =
      hitFrameLabel(this.labels, e) ??
      selectionTargetAt(state.doc, state.pageId, world, state.selection, {
        tolerance: HIT_TOLERANCE_PX / state.viewport.zoom,
        deep: e.ctrlKey,
      });
    state.setHovered(target);
    this.host.setCursor('default');
    // With Alt held, the distances from the selection to what the pointer is over.
    if (e.altKey) this.measureTo(target);
  }

  private beginSelect(e: PointerInput): void {
    const state = this.state;
    const world = this.toWorld(e);
    const tolerance = HIT_TOLERANCE_PX / state.viewport.zoom;
    const frame = getSelectionFrame(state.doc, state.selection);

    // The handles of a gradient that is being edited on the canvas.
    const gradient = gradientHandleAt(state.doc, state.paintEdit, state.viewport, e);
    if (gradient && state.paintEdit) {
      state.beginGesture();
      state.setHovered(null);
      this.mode = { kind: 'gradient', edit: state.paintEdit, handle: gradient, base: state.doc };
      return;
    }

    // The handles that shape a selected ellipse's arc.
    const arc = arcHandleAt(state.doc, state.selection, state.viewport, e);
    if (arc) {
      state.beginGesture();
      state.setHovered(null);
      this.mode = { kind: 'arc', id: arc.id, handle: arc.handle, base: state.doc };
      return;
    }

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

    // A cropped image that is being positioned: dragging on its layer moves the image inside it.
    if (state.paintEdit && cropUnderPointer(state.doc, state.paintEdit, world)) {
      state.beginGesture();
      state.setHovered(null);
      this.mode = { kind: 'crop', edit: state.paintEdit, startWorld: world, base: state.doc };
      this.host.setCursor('grabbing');
      return;
    }

    // A ruler guide: dragging moves it, and dragging it onto its ruler removes it.
    const guide = this.guideAt(world);
    if (guide) {
      this.beginGuide(guide.axis, guide.owner, guide.index);
      return;
    }

    // 2. A layer (through a frame's name label, or directly).
    const label = hitFrameLabel(this.labels, e);
    let target =
      label ?? selectionTargetAt(state.doc, state.pageId, world, state.selection, { tolerance, deep: e.ctrlKey });
    if (!label && e.detail >= 2) {
      const deeper = deeperTargetAt(state.doc, state.pageId, world, state.selection, tolerance);
      // Double-clicking a vector that a single click already reaches opens it for editing its points.
      if (deeper && isVector(state.doc.nodes[deeper]) && (deeper === target || state.selection.includes(deeper))) {
        state.setVectorEdit({ id: deeper, vertices: [] });
        this.host.requestRender();
        return;
      }
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
      // A layer inside an instance is where its component has it: it is not dragged about.
      return isLayer(node) && !node.locked && node.sourceId === null;
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

    // Snap the moving bounds to the layers around them. An axis locked by Shift is left alone.
    this.guides = [];
    this.distances = [];
    this.distanceGuides = [];
    const bounds = this.state.snapping ? unionRects(mode.ids.map((id) => getWorldBounds(mode.base, id))) : null;
    let neighbours: Rect[] = [];
    if (bounds) {
      const exclude = new Set(mode.ids);
      const first = mode.base.nodes[mode.ids[0] as NodeId];
      // Offer the frame under the pointer and, for a layer inside a group, its fellow group members.
      const containers = [containerAt(mode.base, pageId, world, exclude)];
      if (first?.parentId && isGroupLike(mode.base.nodes[first.parentId])) containers.push(first.parentId);
      const sources = this.snapSources(mode.base, containers, exclude);
      neighbours = sources.rects;
      const moved = { x: bounds.x + dx, y: bounds.y + dy, width: bounds.width, height: bounds.height };
      const threshold = SNAP_DISTANCE_PX / this.state.viewport.zoom;
      const axes = { x: !(e.shiftKey && dx === 0), y: !(e.shiftKey && dy === 0) };
      const snap = snapRect(moved, sources.targets, threshold, axes);
      // Even spacing with the neighbours is offered as well. On each axis the nearer of the two wins, and a line wins a tie.
      const spaced = snapSpacing(moved, neighbours, threshold, axes, this.state.pixelSnap);
      const onLine = (axis: 'x' | 'y'): boolean => snap.guides.some((guide) => guide.axis === axis);
      const spaceX = spaced.dx !== null && (!onLine('x') || Math.abs(spaced.dx) < Math.abs(snap.dx) - 1e-9);
      const spaceY = spaced.dy !== null && (!onLine('y') || Math.abs(spaced.dy) < Math.abs(snap.dy) - 1e-9);
      dx += spaceX ? (spaced.dx as number) : snap.dx;
      dy += spaceY ? (spaced.dy as number) : snap.dy;
      this.guides = snap.guides.filter((guide) => !(guide.axis === 'x' ? spaceX : spaceY));
    }

    this.state.updateGesture(() => {
      let doc = moveNodesBy(mode.base, mode.ids, dx, dy, this.state.pixelSnap);
      // Dropping onto a frame puts the layers inside it; dragging out takes them out.
      // A layer inside a group stays in its group while it remains over the same frame.
      let container = containerAt(doc, pageId, world, new Set(mode.ids));
      // A layer that a frame lays out stays in that frame while the pointer is over it, also where it passes
      // over a neighbour that is a frame itself: there the drag changes its place, it does not put it inside.
      const first = getLayer(mode.base, mode.ids[0] as NodeId);
      if (first && isInFlow(mode.base, first) && isAncestor(doc, first.parentId, container)) container = first.parentId;
      const outside = mode.ids.filter((id) => {
        const parentId = doc.nodes[id]?.parentId;
        return parentId != null && enclosingFrameOrPage(doc, parentId) !== container;
      });
      if (outside.length > 0) doc = reparentNodes(doc, outside, container);
      // In a frame that lays out its children a layer cannot be put anywhere: the drag gives it a place among them.
      return placeInFlow(doc, mode.ids, world);
    }, mode.ids);

    // A layer that a frame places is not snapped to anything: where it goes is the layout's business.
    if (mode.ids.some((id) => isInFlow(this.state.doc, getLayer(this.state.doc, id)))) {
      this.guides = [];
      return;
    }

    // The equal gaps the layers have come to rest in are shown with their sizes, however they got there.
    if (bounds) {
      const now = unionRects(mode.ids.map((id) => getWorldBounds(this.state.doc, id)));
      if (now) this.distances = spacingMarks(now, neighbours);
    }
  }

  // --------------------------------------------------------------- resizing

  private updateResize(mode: Extract<Mode, { kind: 'resize' }>, world: Point, e: PointerInput): void {
    const { frame, base, handle } = mode;
    const single = frame.single ? getLayer(base, frame.single) : undefined;
    // The dragged edges snap to neighbouring layers, unless the box is rotated or proportions are locked.
    const firstParent = base.nodes[mode.ids[0] as NodeId]?.parentId;
    if (firstParent && frame.rotation === 0 && !e.shiftKey && !e.altKey) {
      world = this.snapWorldPoint(world, base, [firstParent], new Set(mode.ids), { x: handle.hx !== 0, y: handle.hy !== 0 });
    } else this.guides = [];
    if (single) {
      const pointer = this.toParent(base, single.parentId, world);
      const options = {
        keepAspect: e.shiftKey,
        fromCenter: e.altKey,
        snap: this.state.pixelSnap && getWorldRotation(base, single.id) === 0,
      };
      const box = resizeBox(single, handle, pointer, options);
      // Dragged past the edge that stays fixed, the box lies on the other side of it: what is in it is mirrored to match.
      const crossed = resizeFlips(single, handle, pointer, options);
      // Dragging a text layer's handle stops its size following its content in that direction.
      const textMode =
        single.type === 'TEXT'
          ? { textAutoResize: handle.hy !== 0 || single.textAutoResize === 'NONE' ? ('NONE' as const) : ('HEIGHT' as const) }
          : null;
      this.state.updateGesture(() => {
        let resized = setLayerBox(base, single.id, box);
        if (crossed.x) resized = mirrorInPlace(resized, [single.id], 'horizontal');
        if (crossed.y) resized = mirrorInPlace(resized, [single.id], 'vertical');
        // A size dragged out by hand stands: the layer no longer hugs or fills in the directions that were dragged.
        resized = releaseSizing(resized, [single.id], { horizontal: box.width !== single.width, vertical: box.height !== single.height });
        return textMode ? patchNode(resized, single.id, textMode) : resized;
      });
      return;
    }
    const from = frame.bounds;
    const options = { keepAspect: e.shiftKey, fromCenter: e.altKey, snap: this.state.pixelSnap };
    const to = resizeBox({ ...from, rotation: 0 }, handle, world, options);
    const crossed = resizeFlips({ ...from, rotation: 0 }, handle, world, options);
    const pixelSnap = this.state.pixelSnap;
    this.state.updateGesture(() => {
      // Several layers dragged past the fixed edge change sides among themselves as well as being mirrored.
      let resized = resizeNodesInBounds(base, mode.ids, from, to, pixelSnap);
      if (crossed.x) resized = flipNodes(resized, mode.ids, 'horizontal');
      if (crossed.y) resized = flipNodes(resized, mode.ids, 'vertical');
      return releaseSizing(resized, mode.ids, { horizontal: to.width !== from.width, vertical: to.height !== from.height });
    });
  }

  private updateLineEnd(mode: Extract<Mode, { kind: 'line-end' }>, world: Point, e: PointerInput): void {
    const node = getLayer(mode.base, mode.id);
    if (!node) return;
    let pointer = this.toParent(mode.base, node.parentId, world);
    if (e.shiftKey) pointer = snapAngle(mode.fixed, pointer, ROTATION_SNAP);
    else if (this.state.pixelSnap && getWorldRotation(mode.base, node.parentId) === 0) pointer = { x: Math.round(pointer.x), y: Math.round(pointer.y) };
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
    const startWorld = this.whole(world);
    const parentId = containerAt(state.doc, state.pageId, startWorld);
    const origin = this.toParent(state.doc, parentId, startWorld);
    state.beginGesture();
    state.setHovered(null);
    const added = addLayer(state.doc, type, parentId, { x: origin.x, y: origin.y, width: 0, height: 0 });
    // Drawn into a frame that lays out its children, the shape takes the place in the row or column it is drawn over.
    const created = { id: added.id, doc: placeInFlow(added.doc, [added.id], startWorld) };
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
      const b = this.toParent(state.doc, parentId, this.whole(world));
      const box = rectFromPoints(a, b);
      props = { x: box.x, y: box.y, width: Math.max(10, box.width), textAutoResize: 'HEIGHT' };
    } else {
      // Put the first line's middle where the user clicked.
      const lineHeight = resolveLineHeight({ lineHeight: null, fontSize: 16 });
      props = { x: a.x, y: state.pixelSnap ? Math.round(a.y - lineHeight / 2) : clean(a.y - lineHeight / 2) };
    }
    const added = addLayer(state.doc, 'TEXT', parentId, props);
    const created = { id: added.id, doc: placeInFlow(added.doc, [added.id], mode.startWorld) };
    state.updateGesture(() => created.doc, [created.id]);
    state.setTool('move');
    this.store.getState().setEditingText(created.id);
    this.host.setCursor('default');
  }

  private drawBox(mode: Extract<Mode, { kind: 'draw' }>, e: PointerInput): LayerPatch {
    const constrained = e.shiftKey || e.altKey;
    const world = constrained
      ? this.toWorld(e)
      : this.snapWorldPoint(this.toWorld(e), mode.base, [mode.parentId], new Set([mode.id]), { x: true, y: true });
    if (constrained) this.guides = [];
    const a = this.toParent(mode.base, mode.parentId, mode.startWorld);
    let b = this.toParent(mode.base, mode.parentId, this.whole(world));

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
