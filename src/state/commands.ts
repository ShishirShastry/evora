import {
  addPage,
  addSegment,
  alignNodes,
  applyToVector,
  BOOLEAN_NAMES,
  booleanNodes,
  canBoolean,
  cornerVertex,
  detachVertex,
  getWorldMatrix,
  invert,
  isVector,
  moveVertices,
  outlineStrokes,
  removeVertices,
  setNetwork,
  smoothVertex,
  canFlatten,
  canOutlineStroke,
  copyNodes,
  deleteNodes,
  deletePage,
  distributeNodes,
  duplicateNodes,
  duplicatePage,
  flattenNodes,
  flipNodes,
  getChildIds,
  getPages,
  getWorldBounds,
  groupNodes,
  isContainer,
  isFrame,
  isLayer,
  moveNodesBy,
  pasteNodes,
  patchNodes,
  setTextStyle,
  rectCenter,
  rectsIntersect,
  reorderNodes,
  ungroupNodes,
  unionRects,
  type AlignMode,
  type BooleanOperation,
  type ClipboardPayload,
  type DistributeAxis,
  type FlipAxis,
  type LayerPatch,
  type NodeId,
  type Rect,
  type ReorderMode,
} from '../core';
import { getSelectionFrame } from '../engine/input/selectionFrame';
import { fitRect, nextZoomStep, visibleRect, zoomAt } from '../engine/viewport';
import type { EditorState, EditorStore, ToolId } from './editorStore';

/**
 * Editor commands: everything a menu item, a toolbar button or a keyboard
 * shortcut can do. Each is a plain function of the store, so the three entry
 * points always behave identically.
 */

// The clipboard is shared by every open file in this tab.
let clipboard: ClipboardPayload | null = null;

export function hasClipboard(): boolean {
  return clipboard !== null;
}

export function clearClipboard(): void {
  clipboard = null;
}

// ------------------------------------------------------------------ editing

export function deleteSelection(store: EditorStore): void {
  const { selection, apply, vectorEdit } = store.getState();
  if (vectorEdit) {
    // While a vector's points are being edited, Delete removes the selected points, not the layer.
    if (vectorEdit.vertices.length === 0) return;
    apply('Delete points', (doc) => {
      const node = doc.nodes[vectorEdit.id];
      return isVector(node) ? setNetwork(doc, vectorEdit.id, removeVertices(node.network, vectorEdit.vertices)) : doc;
    });
    store.getState().setVectorEdit({ id: vectorEdit.id, vertices: [] });
    return;
  }
  if (selection.length === 0) return;
  apply('Delete', (doc) => deleteNodes(doc, selection), { select: [] });
}

export function duplicateSelection(store: EditorStore): void {
  const { selection, apply } = store.getState();
  if (selection.length === 0) return;
  let created: NodeId[] = [];
  apply('Duplicate', (doc) => {
    const out = duplicateNodes(doc, selection);
    created = out.ids;
    // Offset the copies so they do not hide the originals.
    return moveNodesBy(out.doc, created, 10, 10);
  });
  store.getState().setSelection(created);
}

export function copySelection(store: EditorStore): boolean {
  const { doc, selection } = store.getState();
  const payload = copyNodes(doc, selection);
  if (!payload) return false;
  clipboard = payload;
  return true;
}

export function cutSelection(store: EditorStore): void {
  if (!copySelection(store)) return;
  const { selection, apply } = store.getState();
  apply('Cut', (doc) => deleteNodes(doc, selection), { select: [] });
}

export function paste(store: EditorStore): void {
  const payload = clipboard;
  if (!payload) return;
  const state = store.getState();
  const samePage = payload.sourceDocumentId === state.doc.id && payload.sourcePageId === state.pageId;
  // Paste in place when the original spot is on screen; otherwise in the middle of the view.
  const view = visibleRect(state.viewport, state.canvasSize);
  const inPlace = samePage && (state.canvasSize.width === 0 || rectsIntersect(view, { ...payload.center, width: 0, height: 0 }));
  const center = inPlace ? undefined : state.canvasSize.width === 0 ? undefined : rectCenter(view);
  let created: NodeId[] = [];
  state.apply('Paste', (doc) => {
    const out = pasteNodes(doc, payload, { pageId: state.pageId, center: center && roundPoint(center) });
    created = out.ids;
    return out.doc;
  });
  store.getState().setSelection(created);
}

function roundPoint(p: { x: number; y: number }): { x: number; y: number } {
  return { x: Math.round(p.x), y: Math.round(p.y) };
}

/** Selects every unlocked, visible layer at the level the user is working on. */
export function selectAll(store: EditorStore): void {
  const { doc, pageId, selection, setSelection, vectorEdit, setVectorEdit } = store.getState();
  const edited = vectorEdit ? doc.nodes[vectorEdit.id] : undefined;
  if (vectorEdit && isVector(edited)) {
    // While a vector's points are being edited, "all" means all of its points.
    setVectorEdit({ id: vectorEdit.id, vertices: edited.network.vertices.map((_, index) => index) });
    return;
  }
  const first = selection[0] !== undefined ? doc.nodes[selection[0]] : undefined;
  const parentId = isLayer(first) ? first.parentId : pageId;
  setSelection(
    getChildIds(doc, parentId).filter((id) => {
      const node = doc.nodes[id];
      return isLayer(node) && node.visible && !node.locked;
    }),
  );
}

/** Turns the selected shapes into one editable vector layer. */
export function flattenSelection(store: EditorStore): void {
  const { selection, apply } = store.getState();
  const created: NodeId[] = [];
  apply('Flatten', (doc) => {
    const out = flattenNodes(doc, selection);
    if (!out) return doc;
    created.push(out.id);
    return out.doc;
  });
  if (created.length > 0) store.getState().setSelection(created);
}

/** Turns the strokes of the selected layers into filled shapes. */
export function outlineStrokeSelection(store: EditorStore): void {
  const { selection, apply } = store.getState();
  const made: NodeId[] = [];
  apply('Outline stroke', (doc) => {
    const out = outlineStrokes(doc, selection);
    if (!out) return doc;
    made.push(...out.ids);
    return out.doc;
  });
  if (made.length > 0) store.getState().setSelection(made);
}

/** Combines the selected shapes into one vector layer by a boolean operation. */
export function booleanSelection(store: EditorStore, operation: BooleanOperation): void {
  const { selection, apply } = store.getState();
  const created: NodeId[] = [];
  apply(BOOLEAN_NAMES[operation], (doc) => {
    const out = booleanNodes(doc, selection, operation);
    if (!out) return doc;
    created.push(out.id);
    return out.doc;
  });
  if (created.length > 0) store.getState().setSelection(created);
}

function booleanCommand(operation: BooleanOperation, label: string, code: string): Command {
  return {
    id: `object.${operation.toLowerCase()}`,
    label,
    group: 'Object',
    shortcut: `Ctrl+Alt+${code.replace('Key', '')}`,
    keys: [{ code, ctrl: true, alt: true }],
    enabled: (state) => canBoolean(state.doc, state.selection),
    run: ({ store }) => booleanSelection(store, operation),
  };
}

/** The single selected vector layer whose points could be edited, if that is what is selected. */
function editableVector(state: EditorState): NodeId | null {
  if (state.selection.length !== 1) return null;
  const node = state.doc.nodes[state.selection[0] as NodeId];
  return isVector(node) && !node.locked ? node.id : null;
}

/** Starts editing the points of the selected vector, or finishes editing them. */
export function toggleVectorEdit(store: EditorStore): void {
  const state = store.getState();
  if (state.vectorEdit) {
    state.setVectorEdit(null);
    if (store.getState().tool === 'pen') store.getState().setTool('move');
    return;
  }
  const id = editableVector(state);
  if (id) state.setVectorEdit({ id, vertices: [] });
}

/** Connects the two selected points with a straight segment, which is how two open ends are joined. */
export function joinPoints(store: EditorStore): void {
  const { vectorEdit, apply } = store.getState();
  if (!vectorEdit || vectorEdit.vertices.length !== 2) return;
  const [a, b] = vectorEdit.vertices as [number, number];
  apply('Join points', (doc) => {
    const node = doc.nodes[vectorEdit.id];
    return isVector(node) ? setNetwork(doc, vectorEdit.id, addSegment(node.network, a, b).network) : doc;
  });
}

/** Makes the selected points smooth (handles in line through the point) or corners (no handles). */
export function setPointType(store: EditorStore, type: 'SMOOTH' | 'CORNER'): void {
  const { vectorEdit, apply } = store.getState();
  if (!vectorEdit || vectorEdit.vertices.length === 0) return;
  apply(type === 'SMOOTH' ? 'Smooth points' : 'Corner points', (doc) => {
    const node = doc.nodes[vectorEdit.id];
    if (!isVector(node)) return doc;
    let network = node.network;
    for (const vertex of vectorEdit.vertices) network = type === 'SMOOTH' ? smoothVertex(network, vertex) : cornerVertex(network, vertex);
    return setNetwork(doc, vectorEdit.id, network);
  });
}

/** Cuts the path open at each selected point, so that the segments that met there can be pulled apart. */
export function cutAtPoints(store: EditorStore): void {
  const { vectorEdit, apply } = store.getState();
  if (!vectorEdit || vectorEdit.vertices.length === 0) return;
  const added: number[] = [];
  apply('Cut path', (doc) => {
    const node = doc.nodes[vectorEdit.id];
    if (!isVector(node)) return doc;
    let network = node.network;
    for (const vertex of vectorEdit.vertices) {
      const cut = detachVertex(network, vertex);
      network = cut.network;
      added.push(...cut.added);
    }
    return setNetwork(doc, vectorEdit.id, network);
  });
  // The new ends are selected, ready to be dragged away from the points they were cut from.
  if (added.length > 0) store.getState().setVectorEdit({ id: vectorEdit.id, vertices: added });
}

export function nudgeSelection(store: EditorStore, dx: number, dy: number): void {
  const { selection, apply, vectorEdit } = store.getState();
  if (vectorEdit && vectorEdit.vertices.length > 0) {
    // While points are selected, the arrow keys move them rather than the layer.
    apply('Move points', (doc) => {
      const node = doc.nodes[vectorEdit.id];
      if (!isVector(node)) return doc;
      const local = applyToVector(invert(getWorldMatrix(doc, vectorEdit.id)), { x: dx, y: dy });
      return setNetwork(doc, vectorEdit.id, moveVertices(node.network, vectorEdit.vertices, local.x, local.y));
    });
    return;
  }
  if (selection.length === 0) return;
  apply('Move', (doc) => moveNodesBy(doc, selection, dx, dy));
}

export function reorderSelection(store: EditorStore, mode: ReorderMode): void {
  const { selection, apply } = store.getState();
  if (selection.length === 0) return;
  const labels: Record<ReorderMode, string> = {
    front: 'Bring to front',
    back: 'Send to back',
    forward: 'Bring forward',
    backward: 'Send backward',
  };
  apply(labels[mode], (doc) => reorderNodes(doc, selection, mode));
}

function toggleFlag(store: EditorStore, ids: readonly NodeId[], key: 'visible' | 'locked', label: [string, string]): void {
  const { doc, apply } = store.getState();
  const layers = ids.map((id) => doc.nodes[id]).filter(isLayer);
  if (layers.length === 0) return;
  // If any layer has the flag off, turn it on for all; otherwise turn it off.
  const value = layers.some((layer) => !layer[key]);
  const patches: Record<NodeId, LayerPatch> = {};
  for (const layer of layers) patches[layer.id] = { [key]: value };
  apply(value ? label[0] : label[1], (d) => patchNodes(d, patches));
}

export function toggleVisible(store: EditorStore, ids: readonly NodeId[] = store.getState().selection): void {
  toggleFlag(store, ids, 'visible', ['Show', 'Hide']);
}

export function toggleLocked(store: EditorStore, ids: readonly NodeId[] = store.getState().selection): void {
  toggleFlag(store, ids, 'locked', ['Lock', 'Unlock']);
}

export function renameNode(store: EditorStore, id: NodeId, name: string): void {
  const trimmed = name.trim();
  if (!trimmed) return;
  store.getState().apply('Rename', (doc) => patchNodes(doc, { [id]: { name: trimmed } }));
}

/** Applies the same property patch to several layers as one undo step. */
export function updateLayers(store: EditorStore, label: string, ids: readonly NodeId[], patch: LayerPatch): void {
  store.getState().apply(label, (doc) => {
    const patches: Record<NodeId, LayerPatch> = {};
    for (const id of ids) if (doc.nodes[id]?.type !== 'TEXT') patches[id] = patch;
    // A text layer given a font, a size, fills and so on has them for all of its text, styled parts included.
    return setTextStyle(patchNodes(doc, patches), ids, patch);
  });
}

// ------------------------------------------------------------------ arrange

export function groupSelection(store: EditorStore): void {
  const { selection, apply } = store.getState();
  if (selection.length === 0) return;
  let created: NodeId | null = null;
  apply('Group', (doc) => {
    const out = groupNodes(doc, selection);
    if (!out) return doc;
    created = out.id;
    return out.doc;
  });
  if (created) store.getState().setSelection([created]);
}

/**
 * "Use as mask". One layer: it becomes a mask for the layers above it in
 * its parent, or stops being one. Several layers: they are grouped, and the
 * bottom-most becomes the mask of the others, so the mask reaches no
 * further than the group.
 */
export function maskSelection(store: EditorStore): void {
  const { selection, apply, doc } = store.getState();
  const layers = selection.map((id) => doc.nodes[id]).filter(isLayer);
  const only = layers[0];
  if (!only) return;
  if (layers.length === 1) {
    apply(only.isMask ? 'Remove mask' : 'Use as mask', (d) => patchNodes(d, { [only.id]: { isMask: !only.isMask } }));
    return;
  }
  const created: NodeId[] = [];
  apply('Use as mask', (d) => {
    const out = groupNodes(d, selection);
    if (!out) return d;
    const bottom = getChildIds(out.doc, out.id)[0];
    if (!bottom) return d;
    created.push(out.id);
    return patchNodes(out.doc, { [bottom]: { isMask: true }, [out.id]: { name: 'Mask group' } });
  });
  if (created.length > 0) store.getState().setSelection(created);
}

export function ungroupSelection(store: EditorStore): void {
  const { selection, apply } = store.getState();
  let released: NodeId[] = [];
  apply('Ungroup', (doc) => {
    const out = ungroupNodes(doc, selection);
    released = out.ids;
    return out.doc;
  });
  if (released.length > 0) store.getState().setSelection(released);
}

const ALIGN_LABELS: Record<AlignMode, string> = {
  left: 'Align left',
  centerX: 'Align horizontal centres',
  right: 'Align right',
  top: 'Align top',
  centerY: 'Align vertical centres',
  bottom: 'Align bottom',
};

export function alignSelection(store: EditorStore, mode: AlignMode): void {
  const { selection, apply } = store.getState();
  apply(ALIGN_LABELS[mode], (doc) => alignNodes(doc, selection, mode));
}

export function distributeSelection(store: EditorStore, axis: DistributeAxis): void {
  const { selection, apply } = store.getState();
  apply(axis === 'horizontal' ? 'Distribute horizontal spacing' : 'Distribute vertical spacing', (doc) =>
    distributeNodes(doc, selection, axis),
  );
}

export function flipSelection(store: EditorStore, axis: FlipAxis): void {
  const { selection, apply } = store.getState();
  apply(axis === 'horizontal' ? 'Flip horizontal' : 'Flip vertical', (doc) => flipNodes(doc, selection, axis));
}

/** Aligning needs something to align to: other selected layers, or the frame a single layer is in. */
export function canAlign(state: EditorState): boolean {
  if (state.selection.length > 1) return true;
  const only = state.selection[0] !== undefined ? state.doc.nodes[state.selection[0]] : undefined;
  return isLayer(only) && isFrame(state.doc.nodes[only.parentId]);
}

export function canUngroup(state: EditorState): boolean {
  return state.selection.some((id) => {
    const node = state.doc.nodes[id];
    return isLayer(node) && isContainer(node) && getChildIds(state.doc, id).length > 0;
  });
}

// -------------------------------------------------------------------- pages

export function createPage(store: EditorStore): void {
  const state = store.getState();
  let created: NodeId | null = null;
  state.apply(
    'Add page',
    (doc) => {
      const out = addPage(doc, undefined, state.pageId);
      created = out.id;
      return out.doc;
    },
    { select: [] },
  );
  if (created) store.getState().setPage(created);
}

export function removePage(store: EditorStore, pageId: NodeId): void {
  const state = store.getState();
  if (getPages(state.doc).length <= 1) return;
  state.apply('Delete page', (doc) => deletePage(doc, pageId), { select: [] });
}

export function copyPage(store: EditorStore, pageId: NodeId): void {
  let created: NodeId | null = null;
  store.getState().apply(
    'Duplicate page',
    (doc) => {
      const out = duplicatePage(doc, pageId);
      if (!out) return doc;
      created = out.id;
      return out.doc;
    },
    { select: [] },
  );
  if (created) store.getState().setPage(created);
}

// --------------------------------------------------------------------- view

function canvasCenter(state: EditorState): { x: number; y: number } {
  return { x: state.canvasSize.width / 2, y: state.canvasSize.height / 2 };
}

export function setZoom(store: EditorStore, zoom: number): void {
  const state = store.getState();
  state.setViewport(zoomAt(state.viewport, canvasCenter(state), zoom));
}

export function zoomIn(store: EditorStore): void {
  setZoom(store, nextZoomStep(store.getState().viewport.zoom, 1));
}

export function zoomOut(store: EditorStore): void {
  setZoom(store, nextZoomStep(store.getState().viewport.zoom, -1));
}

/** Bounds of everything visible on the current page, or null for an empty page. */
export function pageContentBounds(state: EditorState): Rect | null {
  const rects: Rect[] = [];
  for (const id of getChildIds(state.doc, state.pageId)) {
    const node = state.doc.nodes[id];
    if (isLayer(node) && node.visible) rects.push(getWorldBounds(state.doc, id));
  }
  return unionRects(rects);
}

export function zoomToFit(store: EditorStore): void {
  const state = store.getState();
  if (state.canvasSize.width === 0) return;
  const bounds = pageContentBounds(state);
  if (!bounds) {
    state.setViewport({ x: -state.canvasSize.width / 2, y: -state.canvasSize.height / 2, zoom: 1 });
    return;
  }
  state.setViewport(fitRect(bounds, state.canvasSize, 64, 1));
}

export function zoomToSelection(store: EditorStore): void {
  const state = store.getState();
  if (state.canvasSize.width === 0) return;
  const frame = getSelectionFrame(state.doc, state.selection);
  if (!frame) {
    zoomToFit(store);
    return;
  }
  state.setViewport(fitRect(frame.bounds, state.canvasSize, 96, 16));
}

// ---------------------------------------------------------- command registry

/** Callbacks into the application shell for commands that are not document edits. */
export interface AppActions {
  /** Cancels a drag in progress. Returns true if there was one. */
  cancelInteraction(): boolean;
  openShortcuts(): void;
  /** Writes the file to local storage immediately. */
  saveNow(): void;
  /** Saves a `.opendesign` copy to disk. */
  saveAs(): void;
  /** Lets the user choose image files and places them on the canvas. */
  placeImage(): void;
  goHome(): void;
}

export interface CommandEnv {
  store: EditorStore;
  app: AppActions;
}

export interface KeyBinding {
  /** `KeyboardEvent.code`, for example "KeyD", "Digit1", "BracketRight". */
  code: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
}

export type CommandGroup = 'Tools' | 'File' | 'Edit' | 'View' | 'Object' | 'Arrange' | 'Help';

export interface Command {
  id: string;
  label: string;
  group: CommandGroup;
  /** How the shortcut is shown in menus and in the shortcut reference. */
  shortcut?: string;
  keys?: KeyBinding[];
  enabled?: (state: EditorState) => boolean;
  /** For commands that switch something on and off: whether it is on. Shown as a tick in menus. */
  checked?: (state: EditorState) => boolean;
  run: (env: CommandEnv) => void;
}

const hasSelection = (state: EditorState): boolean => state.selection.length > 0;

function alignCommand(mode: AlignMode, code: string): Command {
  return {
    id: `arrange.align.${mode}`,
    label: ALIGN_LABELS[mode],
    group: 'Arrange',
    shortcut: `Alt+${code.replace('Key', '')}`,
    keys: [{ code, alt: true }],
    enabled: canAlign,
    run: ({ store }) => alignSelection(store, mode),
  };
}

function toolCommand(tool: ToolId, label: string, code?: string): Command {
  return {
    id: `tool.${tool}`,
    label,
    group: 'Tools',
    shortcut: code ? code.replace('Key', '') : undefined,
    keys: code ? [{ code }] : undefined,
    run: ({ store, app }) => {
      app.cancelInteraction();
      store.getState().setTool(tool);
    },
  };
}

function nudgeCommand(id: string, label: string, code: string, dx: number, dy: number, big: boolean): Command {
  const arrow = { ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓' }[code] ?? code;
  return {
    id,
    label,
    group: 'Edit',
    shortcut: big ? `Shift+${arrow}` : arrow,
    keys: [{ code, shift: big }],
    enabled: hasSelection,
    run: ({ store }) => nudgeSelection(store, dx, dy),
  };
}

export const SMALL_NUDGE = 1;
export const BIG_NUDGE = 10;

export const COMMANDS: readonly Command[] = [
  toolCommand('move', 'Move', 'KeyV'),
  toolCommand('hand', 'Hand', 'KeyH'),
  toolCommand('frame', 'Frame', 'KeyF'),
  toolCommand('rectangle', 'Rectangle', 'KeyR'),
  toolCommand('ellipse', 'Ellipse', 'KeyO'),
  toolCommand('line', 'Line', 'KeyL'),
  toolCommand('polygon', 'Polygon'),
  toolCommand('star', 'Star'),
  toolCommand('text', 'Text', 'KeyT'),
  toolCommand('pen', 'Pen', 'KeyP'),
  {
    id: 'tool.pencil',
    label: 'Pencil',
    group: 'Tools',
    shortcut: 'Shift+P',
    keys: [{ code: 'KeyP', shift: true }],
    run: ({ store, app }) => {
      app.cancelInteraction();
      store.getState().setTool('pencil');
    },
  },

  {
    id: 'file.save',
    label: 'Save now',
    group: 'File',
    shortcut: 'Ctrl+S',
    keys: [{ code: 'KeyS', ctrl: true }],
    run: ({ app }) => app.saveNow(),
  },
  {
    id: 'file.saveAs',
    label: 'Save a copy to disk…',
    group: 'File',
    shortcut: 'Ctrl+Shift+S',
    keys: [{ code: 'KeyS', ctrl: true, shift: true }],
    run: ({ app }) => app.saveAs(),
  },
  {
    id: 'file.placeImage',
    label: 'Place image…',
    group: 'File',
    shortcut: 'Ctrl+Shift+K',
    keys: [{ code: 'KeyK', ctrl: true, shift: true }],
    run: ({ app }) => app.placeImage(),
  },
  { id: 'file.home', label: 'Back to files', group: 'File', run: ({ app }) => app.goHome() },

  {
    id: 'edit.undo',
    label: 'Undo',
    group: 'Edit',
    shortcut: 'Ctrl+Z',
    keys: [{ code: 'KeyZ', ctrl: true }],
    enabled: (state) => state.undoStack.length > 0 || state.gesture !== null,
    run: ({ store }) => store.getState().undo(),
  },
  {
    id: 'edit.redo',
    label: 'Redo',
    group: 'Edit',
    shortcut: 'Ctrl+Shift+Z',
    keys: [
      { code: 'KeyZ', ctrl: true, shift: true },
      { code: 'KeyY', ctrl: true },
    ],
    enabled: (state) => state.redoStack.length > 0,
    run: ({ store }) => store.getState().redo(),
  },
  {
    id: 'edit.cut',
    label: 'Cut',
    group: 'Edit',
    shortcut: 'Ctrl+X',
    keys: [{ code: 'KeyX', ctrl: true }],
    enabled: hasSelection,
    run: ({ store }) => cutSelection(store),
  },
  {
    id: 'edit.copy',
    label: 'Copy',
    group: 'Edit',
    shortcut: 'Ctrl+C',
    keys: [{ code: 'KeyC', ctrl: true }],
    enabled: hasSelection,
    run: ({ store }) => void copySelection(store),
  },
  {
    id: 'edit.paste',
    label: 'Paste',
    group: 'Edit',
    shortcut: 'Ctrl+V',
    keys: [{ code: 'KeyV', ctrl: true }],
    enabled: () => hasClipboard(),
    run: ({ store }) => paste(store),
  },
  {
    id: 'edit.duplicate',
    label: 'Duplicate',
    group: 'Edit',
    shortcut: 'Ctrl+D',
    keys: [{ code: 'KeyD', ctrl: true }],
    enabled: hasSelection,
    run: ({ store }) => duplicateSelection(store),
  },
  {
    id: 'edit.delete',
    label: 'Delete',
    group: 'Edit',
    shortcut: 'Delete',
    keys: [{ code: 'Delete' }, { code: 'Backspace' }],
    enabled: hasSelection,
    run: ({ store }) => deleteSelection(store),
  },
  {
    id: 'edit.selectAll',
    label: 'Select all',
    group: 'Edit',
    shortcut: 'Ctrl+A',
    keys: [{ code: 'KeyA', ctrl: true }],
    run: ({ store }) => selectAll(store),
  },
  {
    id: 'edit.deselect',
    label: 'Deselect / cancel',
    group: 'Edit',
    shortcut: 'Esc',
    keys: [{ code: 'Escape' }],
    run: ({ store, app }) => {
      if (app.cancelInteraction()) return;
      const state = store.getState();
      if (state.tool !== 'move') state.setTool('move');
      else if (state.paintEdit) state.setPaintEdit(null);
      // Out of point editing one step at a time: first the points, then the editing itself.
      else if (state.vectorEdit) state.setVectorEdit(state.vectorEdit.vertices.length > 0 ? { id: state.vectorEdit.id, vertices: [] } : null);
      else state.setSelection([]);
    },
  },
  nudgeCommand('edit.nudgeLeft', 'Nudge left', 'ArrowLeft', -SMALL_NUDGE, 0, false),
  nudgeCommand('edit.nudgeRight', 'Nudge right', 'ArrowRight', SMALL_NUDGE, 0, false),
  nudgeCommand('edit.nudgeUp', 'Nudge up', 'ArrowUp', 0, -SMALL_NUDGE, false),
  nudgeCommand('edit.nudgeDown', 'Nudge down', 'ArrowDown', 0, SMALL_NUDGE, false),
  nudgeCommand('edit.bigNudgeLeft', 'Nudge left by 10', 'ArrowLeft', -BIG_NUDGE, 0, true),
  nudgeCommand('edit.bigNudgeRight', 'Nudge right by 10', 'ArrowRight', BIG_NUDGE, 0, true),
  nudgeCommand('edit.bigNudgeUp', 'Nudge up by 10', 'ArrowUp', 0, -BIG_NUDGE, true),
  nudgeCommand('edit.bigNudgeDown', 'Nudge down by 10', 'ArrowDown', 0, BIG_NUDGE, true),

  {
    id: 'view.zoomIn',
    label: 'Zoom in',
    group: 'View',
    shortcut: 'Ctrl++',
    keys: [
      { code: 'Equal', ctrl: true },
      { code: 'Equal' },
      { code: 'NumpadAdd', ctrl: true },
      { code: 'NumpadAdd' },
    ],
    run: ({ store }) => zoomIn(store),
  },
  {
    id: 'view.zoomOut',
    label: 'Zoom out',
    group: 'View',
    shortcut: 'Ctrl+-',
    keys: [
      { code: 'Minus', ctrl: true },
      { code: 'Minus' },
      { code: 'NumpadSubtract', ctrl: true },
      { code: 'NumpadSubtract' },
    ],
    run: ({ store }) => zoomOut(store),
  },
  {
    id: 'view.zoomFit',
    label: 'Zoom to fit',
    group: 'View',
    shortcut: 'Shift+1',
    keys: [{ code: 'Digit1', shift: true }],
    run: ({ store }) => zoomToFit(store),
  },
  {
    id: 'view.zoomSelection',
    label: 'Zoom to selection',
    group: 'View',
    shortcut: 'Shift+2',
    keys: [{ code: 'Digit2', shift: true }],
    enabled: hasSelection,
    run: ({ store }) => zoomToSelection(store),
  },
  {
    id: 'view.zoom100',
    label: 'Zoom to 100%',
    group: 'View',
    shortcut: 'Shift+0',
    keys: [
      { code: 'Digit0', shift: true },
      { code: 'Digit0', ctrl: true },
    ],
    run: ({ store }) => setZoom(store, 1),
  },

  {
    id: 'view.snapping',
    label: 'Snap to objects',
    group: 'View',
    shortcut: "Ctrl+Shift+'",
    keys: [{ code: 'Quote', ctrl: true, shift: true }],
    checked: (state) => state.snapping,
    run: ({ store }) => store.getState().setSnapping(!store.getState().snapping),
  },
  {
    id: 'view.pixelSnap',
    label: 'Snap to pixel grid',
    group: 'View',
    shortcut: "Ctrl+Alt+'",
    keys: [{ code: 'Quote', ctrl: true, alt: true }],
    checked: (state) => state.pixelSnap,
    run: ({ store }) => store.getState().setPixelSnap(!store.getState().pixelSnap),
  },

  {
    id: 'view.rulers',
    label: 'Rulers and guides',
    group: 'View',
    shortcut: 'Shift+R',
    keys: [{ code: 'KeyR', shift: true }],
    checked: (state) => state.showRulers,
    run: ({ store }) => store.getState().setShowRulers(!store.getState().showRulers),
  },
  {
    id: 'view.layoutGrids',
    label: 'Show layout grids',
    group: 'View',
    shortcut: 'Shift+G',
    keys: [{ code: 'KeyG', shift: true }],
    checked: (state) => state.showLayoutGrids,
    run: ({ store }) => store.getState().setShowLayoutGrids(!store.getState().showLayoutGrids),
  },

  {
    id: 'object.front',
    label: 'Bring to front',
    group: 'Object',
    shortcut: ']',
    keys: [{ code: 'BracketRight' }],
    enabled: hasSelection,
    run: ({ store }) => reorderSelection(store, 'front'),
  },
  {
    id: 'object.forward',
    label: 'Bring forward',
    group: 'Object',
    shortcut: 'Ctrl+]',
    keys: [{ code: 'BracketRight', ctrl: true }],
    enabled: hasSelection,
    run: ({ store }) => reorderSelection(store, 'forward'),
  },
  {
    id: 'object.backward',
    label: 'Send backward',
    group: 'Object',
    shortcut: 'Ctrl+[',
    keys: [{ code: 'BracketLeft', ctrl: true }],
    enabled: hasSelection,
    run: ({ store }) => reorderSelection(store, 'backward'),
  },
  {
    id: 'object.back',
    label: 'Send to back',
    group: 'Object',
    shortcut: '[',
    keys: [{ code: 'BracketLeft' }],
    enabled: hasSelection,
    run: ({ store }) => reorderSelection(store, 'back'),
  },
  {
    id: 'object.group',
    label: 'Group selection',
    group: 'Object',
    shortcut: 'Ctrl+G',
    keys: [{ code: 'KeyG', ctrl: true }],
    enabled: hasSelection,
    run: ({ store }) => groupSelection(store),
  },
  {
    id: 'object.ungroup',
    label: 'Ungroup',
    group: 'Object',
    shortcut: 'Ctrl+Shift+G',
    keys: [{ code: 'KeyG', ctrl: true, shift: true }],
    enabled: canUngroup,
    run: ({ store }) => ungroupSelection(store),
  },
  {
    id: 'object.flatten',
    label: 'Flatten to vector',
    group: 'Object',
    shortcut: 'Ctrl+E',
    keys: [{ code: 'KeyE', ctrl: true }],
    enabled: (state) => canFlatten(state.doc, state.selection),
    run: ({ store }) => flattenSelection(store),
  },
  {
    id: 'object.outlineStroke',
    label: 'Outline stroke',
    group: 'Object',
    shortcut: 'Ctrl+Shift+O',
    keys: [{ code: 'KeyO', ctrl: true, shift: true }],
    enabled: (state) => canOutlineStroke(state.doc, state.selection),
    run: ({ store }) => outlineStrokeSelection(store),
  },
  {
    id: 'object.mask',
    label: 'Use as mask',
    group: 'Object',
    shortcut: 'Ctrl+Alt+M',
    keys: [{ code: 'KeyM', ctrl: true, alt: true }],
    enabled: hasSelection,
    checked: (state) => {
      const only = state.selection.length === 1 ? state.doc.nodes[state.selection[0] as NodeId] : undefined;
      return isLayer(only) && only.isMask;
    },
    run: ({ store }) => maskSelection(store),
  },
  booleanCommand('UNION', 'Union selection', 'KeyU'),
  booleanCommand('SUBTRACT', 'Subtract selection', 'KeyS'),
  booleanCommand('INTERSECT', 'Intersect selection', 'KeyI'),
  booleanCommand('EXCLUDE', 'Exclude selection', 'KeyX'),
  {
    id: 'object.flipHorizontal',
    label: 'Flip horizontal',
    group: 'Object',
    shortcut: 'Shift+H',
    keys: [{ code: 'KeyH', shift: true }],
    enabled: hasSelection,
    run: ({ store }) => flipSelection(store, 'horizontal'),
  },
  {
    id: 'object.flipVertical',
    label: 'Flip vertical',
    group: 'Object',
    shortcut: 'Shift+V',
    keys: [{ code: 'KeyV', shift: true }],
    enabled: hasSelection,
    run: ({ store }) => flipSelection(store, 'vertical'),
  },
  {
    // Enter edits whatever is selected: the characters of a text layer, or the points of a vector.
    id: 'object.editText',
    label: 'Edit text or points',
    group: 'Object',
    shortcut: 'Enter',
    keys: [{ code: 'Enter' }, { code: 'NumpadEnter' }],
    enabled: (state) =>
      (state.selection.length === 1 && state.doc.nodes[state.selection[0] as NodeId]?.type === 'TEXT') ||
      state.vectorEdit !== null ||
      editableVector(state) !== null,
    run: ({ store }) => {
      const state = store.getState();
      const only = state.selection.length === 1 ? state.doc.nodes[state.selection[0] as NodeId] : undefined;
      if (only?.type === 'TEXT') state.setEditingText(only.id);
      else toggleVectorEdit(store);
    },
  },
  {
    // The same as Enter on a vector, for the menu and the properties panel, where it shows whether it is on.
    id: 'object.editVector',
    label: 'Edit points',
    group: 'Object',
    enabled: (state) => state.vectorEdit !== null || editableVector(state) !== null,
    checked: (state) => state.vectorEdit !== null,
    run: ({ store }) => toggleVectorEdit(store),
  },
  {
    id: 'vector.join',
    label: 'Join points',
    group: 'Object',
    shortcut: 'Ctrl+J',
    keys: [{ code: 'KeyJ', ctrl: true }],
    enabled: (state) => state.vectorEdit?.vertices.length === 2,
    run: ({ store }) => joinPoints(store),
  },
  {
    id: 'vector.cut',
    label: 'Cut path at points',
    group: 'Object',
    enabled: (state) => (state.vectorEdit?.vertices.length ?? 0) > 0,
    run: ({ store }) => cutAtPoints(store),
  },
  {
    id: 'vector.smooth',
    label: 'Smooth points',
    group: 'Object',
    enabled: (state) => (state.vectorEdit?.vertices.length ?? 0) > 0,
    run: ({ store }) => setPointType(store, 'SMOOTH'),
  },
  {
    id: 'vector.corner',
    label: 'Corner points',
    group: 'Object',
    enabled: (state) => (state.vectorEdit?.vertices.length ?? 0) > 0,
    run: ({ store }) => setPointType(store, 'CORNER'),
  },
  {
    id: 'object.rename',
    label: 'Rename',
    group: 'Object',
    shortcut: 'Ctrl+Alt+R',
    keys: [{ code: 'KeyR', ctrl: true, alt: true }],
    enabled: (state) => state.selection.length === 1,
    run: ({ store }) => {
      const { selection, setRenaming } = store.getState();
      if (selection.length === 1) setRenaming(selection[0] as NodeId);
    },
  },
  {
    id: 'object.toggleVisible',
    label: 'Show / hide',
    group: 'Object',
    shortcut: 'Ctrl+Shift+H',
    keys: [{ code: 'KeyH', ctrl: true, shift: true }],
    enabled: hasSelection,
    run: ({ store }) => toggleVisible(store),
  },
  {
    id: 'object.toggleLocked',
    label: 'Lock / unlock',
    group: 'Object',
    shortcut: 'Ctrl+Shift+L',
    keys: [{ code: 'KeyL', ctrl: true, shift: true }],
    enabled: hasSelection,
    run: ({ store }) => toggleLocked(store),
  },

  alignCommand('left', 'KeyA'),
  alignCommand('centerX', 'KeyH'),
  alignCommand('right', 'KeyD'),
  alignCommand('top', 'KeyW'),
  alignCommand('centerY', 'KeyV'),
  alignCommand('bottom', 'KeyS'),
  {
    id: 'arrange.distribute.horizontal',
    label: 'Distribute horizontal spacing',
    group: 'Arrange',
    shortcut: 'Ctrl+Alt+H',
    keys: [{ code: 'KeyH', ctrl: true, alt: true }],
    enabled: (state) => state.selection.length >= 3,
    run: ({ store }) => distributeSelection(store, 'horizontal'),
  },
  {
    id: 'arrange.distribute.vertical',
    label: 'Distribute vertical spacing',
    group: 'Arrange',
    shortcut: 'Ctrl+Alt+V',
    keys: [{ code: 'KeyV', ctrl: true, alt: true }],
    enabled: (state) => state.selection.length >= 3,
    run: ({ store }) => distributeSelection(store, 'vertical'),
  },

  {
    id: 'help.shortcuts',
    label: 'Keyboard shortcuts',
    group: 'Help',
    shortcut: 'Ctrl+/',
    keys: [{ code: 'Slash', ctrl: true }],
    run: ({ app }) => app.openShortcuts(),
  },
];

export function getCommand(id: string): Command | undefined {
  return COMMANDS.find((command) => command.id === id);
}

export interface KeyLike {
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** The command bound to a key event, if any. Modifiers must match exactly. */
export function commandForKey(event: KeyLike): Command | undefined {
  const ctrl = event.ctrlKey || event.metaKey;
  for (const command of COMMANDS) {
    for (const key of command.keys ?? []) {
      if (
        key.code === event.code &&
        (key.ctrl ?? false) === ctrl &&
        (key.shift ?? false) === event.shiftKey &&
        (key.alt ?? false) === event.altKey
      ) {
        return command;
      }
    }
  }
  return undefined;
}

/** Runs a command if it is currently enabled. Returns whether it ran. */
export function runCommand(command: Command, env: CommandEnv): boolean {
  if (command.enabled && !command.enabled(env.store.getState())) return false;
  command.run(env);
  return true;
}
