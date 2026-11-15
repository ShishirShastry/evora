import {
  addPage,
  alignNodes,
  canFlatten,
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
  rectCenter,
  rectsIntersect,
  reorderNodes,
  ungroupNodes,
  unionRects,
  type AlignMode,
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
  const { selection, apply } = store.getState();
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
  const { doc, pageId, selection, setSelection } = store.getState();
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

export function nudgeSelection(store: EditorStore, dx: number, dy: number): void {
  const { selection, apply } = store.getState();
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
  const patches: Record<NodeId, LayerPatch> = {};
  for (const id of ids) patches[id] = patch;
  store.getState().apply(label, (doc) => patchNodes(doc, patches));
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
    id: 'object.editText',
    label: 'Edit text',
    group: 'Object',
    shortcut: 'Enter',
    keys: [{ code: 'Enter' }, { code: 'NumpadEnter' }],
    enabled: (state) => state.selection.length === 1 && state.doc.nodes[state.selection[0] as NodeId]?.type === 'TEXT',
    run: ({ store }) => {
      const { selection, setEditingText } = store.getState();
      if (selection.length === 1) setEditingText(selection[0] as NodeId);
    },
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
