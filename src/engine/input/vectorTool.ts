import {
  addLayer,
  addSegment,
  addVertex,
  applyToPoint,
  applyToVector,
  containerAt,
  cornerVertex,
  distance,
  getTangent,
  getWorldMatrix,
  handlesOf,
  handleVertex,
  invert,
  isVector,
  mirroringAt,
  moveVertices,
  nearestSegment,
  networkFromStroke,
  rectContainsPoint,
  rectFromPoints,
  setNetwork,
  setTangent,
  smoothVertex,
  snapAngle,
  splitSegment,
  vertexDegree,
  type Document,
  type HandleMirroring,
  type HandleRef,
  type Matrix,
  type NodeId,
  type Point,
  type Rect,
  type VectorNetwork,
  type VectorNode,
} from '../../core';
import type { EditorStore } from '../../state/editorStore';
import { screenToWorld } from '../viewport';
import type { PointerInput } from './controller';

const DRAG_THRESHOLD_PX = 3;
/** How close, in screen pixels, the pointer must be to a point or a handle to grab it. */
export const POINT_HIT_PX = 7;
/** How close, in screen pixels, the pointer must be to a curve to act on it. */
export const SEGMENT_HIT_PX = 5;
/** The pencil records a point each time the pointer has moved this far, in screen pixels. */
const PENCIL_STEP_PX = 2;
/** How far, in screen pixels, the smoothed pencil line may stray from what was drawn. */
const PENCIL_TOLERANCE_PX = 2.5;
/** A pencil stroke that ends this close, in screen pixels, to where it began is closed into a shape. */
const PENCIL_CLOSE_PX = 8;

/** What the vector tools need from the interaction controller that owns them. */
export interface VectorToolHost {
  requestRender(): void;
  setCursor(cursor: string): void;
  /** Shows (or with null hides) the selection rectangle being dragged out, in page space. */
  setMarquee(rect: Rect | null): void;
  /**
   * Puts a page-space point on whole pixels and, when snapping is on, on the
   * lines of the layers in `containerId`. With `show`, the guides it snapped
   * to are drawn until the interaction ends.
   */
  snapPoint(world: Point, doc: Document, containerId: NodeId, exclude: ReadonlySet<NodeId>, show: boolean): Point;
}

/** What the overlay draws for a vector that is being edited or drawn. Positions are in page space. */
export interface VectorOverlay {
  /** The vector whose points are shown, or null while a new path has only its first point. */
  id: NodeId | null;
  selected: readonly number[];
  /** The point under the pointer. */
  hoverVertex: number | null;
  /** The point the pen will continue from. */
  penVertex: number | null;
  /** The first point of a path that has no second point yet. */
  start: Point | null;
  /** The segment the next click of the pen would add. */
  preview: { from: Point; control: Point | null; to: Point } | null;
}

/** Where the pen's next segment starts: an existing point, or a first point that is not in the document yet. */
type PenFrom = { kind: 'vertex'; index: number } | { kind: 'start'; world: Point };

type VectorMode =
  | { kind: 'idle' }
  /** The first point of a new path is down; dragging pulls out its handle. */
  | { kind: 'pen-start'; world: Point }
  /** A point (and usually the segment to it) has been added; dragging shapes the curve into it. */
  | {
      kind: 'pen-add';
      base: Document;
      id: NodeId;
      /** The network with the addition, before any handle is pulled out. */
      network: VectorNetwork;
      vertex: number;
      /** The new segment, or -1 when the press only put a point on an existing segment. */
      segment: number;
      pressWorld: Point;
      startScreen: Point;
      /** The path ends at an existing point. */
      closing: boolean;
      label: string;
    }
  | {
      kind: 'points';
      id: NodeId;
      base: Document;
      indices: number[];
      /** The point under the pointer, which is the one that lands on whole pixels and snaps. */
      grabbed: number | null;
      startWorld: Point;
      startScreen: Point;
      dragging: boolean;
      /** The selection a click without a drag leaves behind. */
      onClick: number[] | null;
    }
  | { kind: 'handle'; id: NodeId; base: Document; ref: HandleRef; mirroring: HandleMirroring }
  | { kind: 'bend'; id: NodeId; base: Document; vertex: number; startScreen: Point; dragging: boolean }
  | { kind: 'marquee'; id: NodeId; startWorld: Point; baseSelection: number[] }
  /** The pencil is down: `points` is the stroke so far, in page space, and `id` the layer it is drawn into. */
  | { kind: 'pencil'; base: Document; id: NodeId; points: Point[]; lastScreen: Point };

/** Straight lines through the given points, in order. */
function polyline(points: readonly Point[]): VectorNetwork {
  return {
    vertices: points.map((p) => ({ x: p.x, y: p.y })),
    segments: points.slice(1).map((_, i) => ({ start: i, end: i + 1, tangentStart: { x: 0, y: 0 }, tangentEnd: { x: 0, y: 0 } })),
  };
}

const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: Point, b: Point): Point => ({ x: a.x + b.x, y: a.y + b.y });
// Subtracting from zero rather than negating keeps -0 out of the document.
const negate = (a: Point): Point => ({ x: 0 - a.x, y: 0 - a.y });

/**
 * The Pen tool and point editing. Like the controller that owns it, it keeps
 * only the interaction in progress; every change goes through the editor
 * store as an undoable step, one per point placed or drag made.
 */
export class VectorTool {
  private mode: VectorMode = { kind: 'idle' };
  private from: PenFrom | null = null;
  /** The handle the pen left sticking out of `from`, as a page-space offset. The next segment starts along it. */
  private tangent: Point | null = null;
  private preview: VectorOverlay['preview'] = null;
  private hoverVertex: number | null = null;
  /** The number of undo steps after the pen's last action, to notice an undo. */
  private depth = 0;

  constructor(
    private readonly store: EditorStore,
    private readonly host: VectorToolHost,
  ) {}

  private get state() {
    return this.store.getState();
  }

  get isBusy(): boolean {
    return this.mode.kind !== 'idle';
  }

  /** True while a drag is changing the document. */
  get isTransforming(): boolean {
    const mode = this.mode;
    return (
      mode.kind === 'pen-add' ||
      mode.kind === 'handle' ||
      mode.kind === 'pencil' ||
      (mode.kind === 'points' && mode.dragging) ||
      (mode.kind === 'bend' && mode.dragging)
    );
  }

  /** Whether pointer input currently belongs to this tool rather than to the ordinary selection tool. */
  get wantsPointer(): boolean {
    const { tool, vectorEdit } = this.state;
    return tool === 'pen' || tool === 'pencil' || (tool === 'move' && vectorEdit !== null);
  }

  /** The vector being edited, if there is one. */
  private editing(doc: Document = this.state.doc): VectorNode | null {
    const edit = this.state.vectorEdit;
    const node = edit ? doc.nodes[edit.id] : undefined;
    return isVector(node) ? node : null;
  }

  private toWorld(p: Point): Point {
    return screenToWorld(this.state.viewport, p);
  }

  private tolerance(pixels: number): number {
    return pixels / this.state.viewport.zoom;
  }

  /** Brings the pen's memory in line with the tool, the layer being edited and the history. */
  private sync(): void {
    const state = this.state;
    if (state.tool !== 'pen') {
      this.from = null;
      this.tangent = null;
      this.preview = null;
      this.depth = state.undoStack.length;
      return;
    }
    const node = this.editing();
    if (state.undoStack.length < this.depth) {
      // Something was undone. Carry on from the end of the path as it now is.
      const last = node ? node.network.vertices.length - 1 : -1;
      this.from = node && last >= 0 && vertexDegree(node.network, last) === 1 ? { kind: 'vertex', index: last } : null;
      this.tangent = null;
      this.preview = null;
    } else if (this.from?.kind === 'vertex' && (!node || this.from.index >= node.network.vertices.length)) {
      this.from = null;
      this.tangent = null;
      this.preview = null;
    }
    this.depth = state.undoStack.length;
  }

  private fromWorld(): Point | null {
    if (!this.from) return null;
    if (this.from.kind === 'start') return this.from.world;
    const node = this.editing();
    const vertex = node?.network.vertices[this.from.index];
    return node && vertex ? applyToPoint(getWorldMatrix(this.state.doc, node.id), vertex) : null;
  }

  /** The point of `node` under a page-space position. */
  private vertexAt(node: VectorNode, matrix: Matrix, world: Point): number | null {
    let best: number | null = null;
    let bestDistance = this.tolerance(POINT_HIT_PX);
    for (let index = 0; index < node.network.vertices.length; index++) {
      const d = distance(applyToPoint(matrix, node.network.vertices[index] as Point), world);
      if (d <= bestDistance) {
        best = index;
        bestDistance = d;
      }
    }
    return best;
  }

  /** The handle under a page-space position, among those of the selected points. */
  private handleAt(node: VectorNode, matrix: Matrix, world: Point, selected: readonly number[]): HandleRef | null {
    const reach = this.tolerance(POINT_HIT_PX);
    for (const vertex of selected) {
      const at = node.network.vertices[vertex];
      if (!at) continue;
      for (const ref of handlesOf(node.network, vertex)) {
        const tangent = getTangent(node.network, ref);
        if (tangent.x === 0 && tangent.y === 0) continue;
        if (distance(applyToPoint(matrix, add(at, tangent)), world) <= reach) return ref;
      }
    }
    return null;
  }

  private segmentAt(node: VectorNode, matrix: Matrix, world: Point): { segment: number; t: number } | null {
    const found = nearestSegment(node.network, applyToPoint(invert(matrix), world));
    return found && found.distance <= this.tolerance(SEGMENT_HIT_PX) ? found : null;
  }

  /** What the overlay should draw, or null when no vector is being edited or drawn. */
  overlay(): VectorOverlay | null {
    const state = this.state;
    const edit = state.vectorEdit;
    const pen = state.tool === 'pen';
    if (!edit && !(pen && this.from)) return null;
    return {
      id: edit?.id ?? null,
      selected: edit?.vertices ?? [],
      hoverVertex: this.hoverVertex,
      penVertex: pen && this.from?.kind === 'vertex' ? this.from.index : null,
      start: pen && this.from?.kind === 'start' ? this.from.world : null,
      preview: pen ? this.preview : null,
    };
  }

  // ---------------------------------------------------------------- pointer

  pointerDown(e: PointerInput): void {
    this.sync();
    this.state.setHovered(null);
    if (this.state.tool === 'pen') this.penDown(e);
    else if (this.state.tool === 'pencil') this.pencilDown(e);
    else this.editDown(e);
  }

  pointerMove(e: PointerInput): void {
    const mode = this.mode;
    const world = this.toWorld(e);
    switch (mode.kind) {
      case 'idle':
        this.hover(e);
        return;
      case 'pen-start':
        this.tangent = distance(world, mode.world) > this.tolerance(DRAG_THRESHOLD_PX) ? sub(world, mode.world) : null;
        this.preview = this.tangent ? { from: mode.world, control: null, to: world } : null;
        this.host.requestRender();
        return;
      case 'pen-add':
        this.penDrag(mode, e);
        return;
      case 'points':
        this.pointsDrag(mode, e);
        return;
      case 'handle': {
        const node = mode.base.nodes[mode.id] as VectorNode;
        const local = applyToPoint(invert(getWorldMatrix(mode.base, mode.id)), world);
        const at = node.network.vertices[handleVertex(node.network, mode.ref)] as Point;
        let tangent = sub(local, at);
        if (e.shiftKey) tangent = snapAngle({ x: 0, y: 0 }, tangent, 45);
        // Alt moves this handle on its own, which makes the point a corner.
        const next = setTangent(node.network, mode.ref, tangent, e.altKey ? 'NONE' : mode.mirroring);
        this.state.updateGesture(() => setNetwork(mode.base, mode.id, next));
        return;
      }
      case 'bend':
        this.bendDrag(mode, e);
        return;
      case 'pencil':
        if (distance(e, mode.lastScreen) < PENCIL_STEP_PX) return;
        mode.lastScreen = { x: e.x, y: e.y };
        mode.points.push(world);
        // While it is being drawn the stroke is shown as it is; it is smoothed when the pencil is lifted.
        this.state.updateGesture(() => setNetwork(mode.base, mode.id, polyline(this.strokeLocal(mode))), [mode.id]);
        return;
      case 'marquee': {
        const rect = rectFromPoints(mode.startWorld, world);
        this.host.setMarquee(rect);
        const node = this.editing();
        if (node) {
          const matrix = getWorldMatrix(this.state.doc, node.id);
          const inside: number[] = [];
          node.network.vertices.forEach((vertex, index) => {
            if (rectContainsPoint(rect, applyToPoint(matrix, vertex))) inside.push(index);
          });
          this.state.setVectorEdit({ id: mode.id, vertices: [...new Set([...mode.baseSelection, ...inside])] });
        }
        this.host.requestRender();
        return;
      }
    }
  }

  pointerUp(): void {
    const mode = this.mode;
    this.mode = { kind: 'idle' };
    const state = this.state;
    switch (mode.kind) {
      case 'idle':
        return;
      case 'pen-start':
        break;
      case 'pen-add':
        state.commitGesture(mode.label);
        this.from = mode.closing ? null : { kind: 'vertex', index: mode.vertex };
        if (mode.closing) this.tangent = null;
        this.store.getState().setVectorEdit({ id: mode.id, vertices: [mode.vertex] });
        break;
      case 'points':
        if (mode.dragging) state.commitGesture('Move points');
        else if (mode.onClick) state.setVectorEdit({ id: mode.id, vertices: mode.onClick });
        break;
      case 'handle':
        state.commitGesture('Edit curve');
        break;
      case 'bend':
        if (mode.dragging) state.commitGesture('Edit curve');
        else {
          // A click turns a smooth point into a corner and a corner into a smooth point.
          state.apply('Change point type', (doc) => {
            const node = doc.nodes[mode.id];
            if (!isVector(node)) return doc;
            const curved = handlesOf(node.network, mode.vertex).some((ref) => {
              const tangent = getTangent(node.network, ref);
              return tangent.x !== 0 || tangent.y !== 0;
            });
            return setNetwork(doc, mode.id, curved ? cornerVertex(node.network, mode.vertex) : smoothVertex(node.network, mode.vertex));
          });
        }
        break;
      case 'marquee':
        this.host.setMarquee(null);
        break;
      case 'pencil': {
        const zoom = state.viewport.zoom;
        const network = networkFromStroke(this.strokeLocal(mode), PENCIL_TOLERANCE_PX / zoom, PENCIL_CLOSE_PX / zoom);
        // A press without a stroke draws nothing.
        if (network.segments.length === 0) state.cancelGesture();
        else {
          state.updateGesture(() => setNetwork(mode.base, mode.id, network), [mode.id]);
          state.commitGesture('Draw with pencil');
        }
        break;
      }
    }
    this.depth = this.store.getState().undoStack.length;
    this.host.requestRender();
  }

  /**
   * Abandons the drag in progress, or failing that ends the path the pen is
   * in the middle of. Returns false when there was neither.
   */
  cancel(): boolean {
    const mode = this.mode;
    if (mode.kind !== 'idle') {
      this.mode = { kind: 'idle' };
      this.host.setMarquee(null);
      this.state.cancelGesture();
      if (mode.kind === 'pen-start') {
        this.from = null;
        this.tangent = null;
      }
      this.preview = null;
      this.host.requestRender();
      return true;
    }
    if (this.state.tool === 'pen' && this.from) {
      this.from = null;
      this.tangent = null;
      this.preview = null;
      this.host.requestRender();
      return true;
    }
    return false;
  }

  /** The pointer left the canvas. */
  pointerLeave(): void {
    if (this.mode.kind !== 'idle') return;
    if (this.preview || this.hoverVertex !== null) {
      this.preview = null;
      this.hoverVertex = null;
      this.host.requestRender();
    }
  }

  /** Follows the pointer while nothing is pressed: which point is under it, and where the pen's next segment would go. */
  hover(e: PointerInput): void {
    this.sync();
    const state = this.state;
    const world = this.toWorld(e);
    const node = this.editing();
    const hit = node ? this.vertexAt(node, getWorldMatrix(state.doc, node.id), world) : null;
    const pen = state.tool === 'pen';
    let preview: VectorOverlay['preview'] = null;
    const from = pen ? this.fromWorld() : null;
    if (from) {
      const vertex = node && hit !== null ? node.network.vertices[hit] : undefined;
      const to = node && vertex ? applyToPoint(getWorldMatrix(state.doc, node.id), vertex) : this.target(world, e, from, false);
      preview = { from, control: this.tangent ? add(from, this.tangent) : null, to };
    }
    this.host.setCursor(state.tool === 'move' ? 'default' : 'crosshair');
    const changed = hit !== this.hoverVertex || preview !== null || this.preview !== null;
    this.hoverVertex = hit;
    this.preview = preview;
    if (changed) this.host.requestRender();
  }

  /** Where a press at `world` puts a new point: on whole pixels, snapped to nearby layers, or with Shift at a multiple of 45° from the last point. */
  private target(world: Point, e: PointerInput, from: Point | null, show: boolean): Point {
    const state = this.state;
    if (e.shiftKey && from) {
      const p = snapAngle(from, world, 45);
      return { x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 };
    }
    const node = this.editing();
    const container = node ? node.parentId : containerAt(state.doc, state.pageId, world);
    return this.host.snapPoint(world, state.doc, container, new Set(node ? [node.id] : []), show);
  }

  // -------------------------------------------------------------------- pen

  private penDown(e: PointerInput): void {
    const state = this.state;
    const world = this.toWorld(e);
    const node = this.editing();
    const startScreen = { x: e.x, y: e.y };
    this.preview = null;

    if (node) {
      const matrix = getWorldMatrix(state.doc, node.id);
      const hit = this.vertexAt(node, matrix, world);
      if (hit !== null) {
        if (!this.from) {
          // Pick the path up at this point.
          this.from = { kind: 'vertex', index: hit };
          this.tangent = null;
          state.setVectorEdit({ id: node.id, vertices: [hit] });
          this.host.requestRender();
          return;
        }
        if (this.from.kind === 'vertex' && this.from.index === hit) {
          // Clicking the point the pen is at takes back the handle left sticking out of it.
          this.tangent = null;
          this.host.requestRender();
          return;
        }
        // Run the path into an existing point: this is what closes a shape.
        const built = this.extend(state.doc, node.id, { kind: 'vertex', index: hit });
        if (built) this.beginAdd({ ...built, closing: true, label: 'Close path', pressWorld: applyToPoint(matrix, node.network.vertices[hit] as Point), startScreen });
        return;
      }
      const onSegment = this.segmentAt(node, matrix, world);
      if (onSegment) {
        // A point on a segment. If a path is in progress it runs into that point and ends there.
        const split = splitSegment(node.network, onSegment.segment, onSegment.t);
        const at = applyToPoint(matrix, split.network.vertices[split.vertex] as Point);
        let network = split.network;
        let segment = -1;
        if (this.from) {
          const built = this.extend(setNetwork(state.doc, node.id, network), node.id, { kind: 'vertex', index: split.vertex });
          if (built) {
            network = built.network;
            segment = built.segment;
          }
        }
        this.beginAdd({ base: state.doc, id: node.id, network, vertex: split.vertex, segment, closing: true, label: 'Add point', pressWorld: at, startScreen });
        return;
      }
    }

    const point = this.target(world, e, this.fromWorld(), true);
    if (!this.from) {
      // The first point of a path. Nothing is added to the document until there is a second.
      this.from = { kind: 'start', world: point };
      this.tangent = null;
      this.mode = { kind: 'pen-start', world: point };
      state.setVectorEdit(node ? { id: node.id, vertices: [] } : null);
      this.host.requestRender();
      return;
    }
    const from = this.fromWorld();
    if (from && distance(from, point) < 1e-6) return;

    let doc = state.doc;
    let id = node?.id ?? null;
    if (id === null) {
      // A new layer, in the frame the path started over.
      const created = addLayer(doc, 'VECTOR', containerAt(doc, state.pageId, from ?? point));
      doc = created.doc;
      id = created.id;
    }
    const built = this.extend(doc, id, { kind: 'point', world: point });
    if (built) this.beginAdd({ ...built, closing: false, label: node ? 'Add point' : 'Create vector', pressWorld: point, startScreen });
  }

  /**
   * Adds a segment from where the pen is to `to` (an existing point, or a new
   * one at a page position) in the vector `id` of `doc`.
   */
  private extend(
    doc: Document,
    id: NodeId,
    to: { kind: 'vertex'; index: number } | { kind: 'point'; world: Point },
  ): { base: Document; id: NodeId; network: VectorNetwork; vertex: number; segment: number } | null {
    const node = doc.nodes[id];
    if (!isVector(node) || !this.from) return null;
    const toLocal = invert(getWorldMatrix(doc, id));
    let network = node.network;
    let start: number;
    if (this.from.kind === 'vertex') start = this.from.index;
    else {
      const added = addVertex(network, applyToPoint(toLocal, this.from.world));
      network = added.network;
      start = added.index;
    }
    let end: number;
    if (to.kind === 'vertex') end = to.index;
    else {
      const added = addVertex(network, applyToPoint(toLocal, to.world));
      network = added.network;
      end = added.index;
    }
    const tangentStart = this.tangent ? applyToVector(toLocal, this.tangent) : { x: 0, y: 0 };
    const joined = addSegment(network, start, end, tangentStart);
    if (joined.index < 0) return null;
    return { base: doc, id, network: joined.network, vertex: end, segment: joined.index };
  }

  private beginAdd(add: Omit<Extract<VectorMode, { kind: 'pen-add' }>, 'kind'>): void {
    const state = this.state;
    state.beginGesture();
    this.mode = { kind: 'pen-add', ...add };
    this.tangent = null;
    state.updateGesture(() => setNetwork(add.base, add.id, add.network), [add.id]);
  }

  /** Dragging after placing a point pulls a handle out of it: the curve arrives against the drag and the next one leaves along it. */
  private penDrag(mode: Extract<VectorMode, { kind: 'pen-add' }>, e: PointerInput): void {
    const world = this.toWorld(e);
    const dragged = distance(e, mode.startScreen) > DRAG_THRESHOLD_PX;
    let pull = dragged ? sub(world, mode.pressWorld) : null;
    if (pull && e.shiftKey) pull = snapAngle({ x: 0, y: 0 }, pull, 45);
    let network = mode.network;
    if (pull && mode.segment >= 0) {
      const local = applyToVector(invert(getWorldMatrix(mode.base, mode.id)), pull);
      network = setTangent(network, { segment: mode.segment, end: 'end' }, negate(local));
    }
    this.tangent = pull;
    this.preview = pull ? { from: mode.pressWorld, control: null, to: add(mode.pressWorld, pull) } : null;
    this.state.updateGesture(() => setNetwork(mode.base, mode.id, network), [mode.id]);
    this.host.requestRender();
  }

  // ----------------------------------------------------------------- pencil

  /** Starts a stroke. Every stroke is a layer of its own, in the frame it starts over, with round ends and corners like a pencil line. */
  private pencilDown(e: PointerInput): void {
    const state = this.state;
    const world = this.toWorld(e);
    state.beginGesture();
    const created = addLayer(state.doc, 'VECTOR', containerAt(state.doc, state.pageId, world), { strokeCap: 'ROUND', strokeJoin: 'ROUND' });
    this.mode = { kind: 'pencil', base: created.doc, id: created.id, points: [world], lastScreen: { x: e.x, y: e.y } };
  }

  /** The stroke so far in the coordinates of the layer it is drawn into. */
  private strokeLocal(mode: Extract<VectorMode, { kind: 'pencil' }>): Point[] {
    const toLocal = invert(getWorldMatrix(mode.base, mode.id));
    return mode.points.map((p) => applyToPoint(toLocal, p));
  }

  // ---------------------------------------------------------- editing points

  private editDown(e: PointerInput): void {
    const state = this.state;
    const edit = state.vectorEdit;
    const node = this.editing();
    if (!edit || !node) return;
    const world = this.toWorld(e);
    const matrix = getWorldMatrix(state.doc, node.id);
    const startScreen = { x: e.x, y: e.y };

    const handle = this.handleAt(node, matrix, world, edit.vertices);
    if (handle) {
      state.beginGesture();
      this.mode = { kind: 'handle', id: node.id, base: state.doc, ref: handle, mirroring: mirroringAt(node.network, handleVertex(node.network, handle)) };
      return;
    }

    const hit = this.vertexAt(node, matrix, world);
    if (hit !== null) {
      if (e.ctrlKey) {
        // Ctrl-drag pulls handles out of a point; Ctrl-click switches it between corner and smooth.
        state.setVectorEdit({ id: node.id, vertices: [hit] });
        this.mode = { kind: 'bend', id: node.id, base: state.doc, vertex: hit, startScreen, dragging: false };
        return;
      }
      const already = edit.vertices.includes(hit);
      let onClick: number[] | null = null;
      if (!already) state.setVectorEdit({ id: node.id, vertices: e.shiftKey ? [...edit.vertices, hit] : [hit] });
      else if (e.shiftKey) onClick = edit.vertices.filter((v) => v !== hit);
      else if (edit.vertices.length > 1) onClick = [hit];
      this.mode = {
        kind: 'points',
        id: node.id,
        base: state.doc,
        indices: [...(this.state.vectorEdit?.vertices ?? [hit])],
        grabbed: hit,
        startWorld: world,
        startScreen,
        dragging: false,
        onClick,
      };
      return;
    }

    const onSegment = this.segmentAt(node, matrix, world);
    if (onSegment && e.detail >= 2) {
      // Double-clicking a segment puts a point on it.
      const split = splitSegment(node.network, onSegment.segment, onSegment.t);
      state.apply('Add point', (doc) => setNetwork(doc, node.id, split.network));
      this.store.getState().setVectorEdit({ id: node.id, vertices: [split.vertex] });
      return;
    }
    if (onSegment) {
      // A segment is moved by its two ends.
      const segment = node.network.segments[onSegment.segment];
      const ends = segment ? [...new Set([segment.start, segment.end])] : [];
      const vertices = e.shiftKey ? [...new Set([...edit.vertices, ...ends])] : ends;
      state.setVectorEdit({ id: node.id, vertices });
      this.mode = { kind: 'points', id: node.id, base: state.doc, indices: vertices, grabbed: null, startWorld: world, startScreen, dragging: false, onClick: null };
      return;
    }

    if (e.detail >= 2) {
      // Double-clicking away from the path finishes editing it.
      state.setVectorEdit(null);
      return;
    }
    if (!e.shiftKey) state.setVectorEdit({ id: node.id, vertices: [] });
    this.mode = { kind: 'marquee', id: node.id, startWorld: world, baseSelection: e.shiftKey ? [...edit.vertices] : [] };
  }

  private pointsDrag(mode: Extract<VectorMode, { kind: 'points' }>, e: PointerInput): void {
    const state = this.state;
    if (!mode.dragging) {
      if (distance(e, mode.startScreen) <= DRAG_THRESHOLD_PX || mode.indices.length === 0) return;
      state.beginGesture();
      mode.dragging = true;
    }
    const node = mode.base.nodes[mode.id] as VectorNode;
    const matrix = getWorldMatrix(mode.base, mode.id);
    const world = this.toWorld(e);
    let delta = sub(world, mode.startWorld);
    if (e.shiftKey) delta = Math.abs(delta.x) >= Math.abs(delta.y) ? { x: delta.x, y: 0 } : { x: 0, y: delta.y };
    const grabbed = mode.grabbed !== null ? node.network.vertices[mode.grabbed] : undefined;
    if (grabbed && !e.shiftKey) {
      // The point under the pointer is the one that lands on whole pixels and snaps to other layers.
      const before = applyToPoint(matrix, grabbed);
      const after = this.host.snapPoint(add(before, delta), mode.base, node.parentId, new Set([mode.id]), true);
      delta = sub(after, before);
    } else if (state.pixelSnap) delta = { x: Math.round(delta.x), y: Math.round(delta.y) };
    const local = applyToVector(invert(matrix), delta);
    state.updateGesture(() => setNetwork(mode.base, mode.id, moveVertices(node.network, mode.indices, local.x, local.y)));
  }

  private bendDrag(mode: Extract<VectorMode, { kind: 'bend' }>, e: PointerInput): void {
    const state = this.state;
    if (!mode.dragging) {
      if (distance(e, mode.startScreen) <= DRAG_THRESHOLD_PX) return;
      state.beginGesture();
      mode.dragging = true;
    }
    const node = mode.base.nodes[mode.id] as VectorNode;
    const handles = handlesOf(node.network, mode.vertex);
    const last = handles[handles.length - 1];
    const at = node.network.vertices[mode.vertex];
    if (!last || !at) return;
    let pull = sub(applyToPoint(invert(getWorldMatrix(mode.base, mode.id)), this.toWorld(e)), at);
    if (e.shiftKey) pull = snapAngle({ x: 0, y: 0 }, pull, 45);
    // The drag is the direction the path leaves in. An end point has only the handle it arrives by, which points the other way.
    const next = handles.length === 1 ? setTangent(node.network, last, negate(pull)) : setTangent(node.network, last, pull, 'ANGLE_AND_LENGTH');
    state.updateGesture(() => setNetwork(mode.base, mode.id, next));
  }
}
