import { createStore, type StoreApi } from 'zustand/vanilla';
import {
  applyPatch,
  approximateMeasurer,
  diffDocuments,
  fitTextLayers,
  fitTextRanges,
  fitVectors,
  getPageIdOf,
  getPages,
  isGradient,
  isLayer,
  normalizeGroups,
  type AssetInfo,
  type Document,
  type DocumentPatch,
  type NodeId,
  type TextMeasurer,
} from '../core';
import { DEFAULT_VIEWPORT, type Size, type Viewport } from '../engine/viewport';

export type ToolId = 'move' | 'hand' | 'frame' | 'rectangle' | 'ellipse' | 'line' | 'polygon' | 'star' | 'text' | 'pen' | 'pencil';

/** Point-level editing of one vector layer: which layer, and which of its points are selected. */
/** A fill or stroke that is being edited on the canvas: which layer's, and which of its paints. */
export interface PaintEdit {
  id: NodeId;
  key: 'fills' | 'strokes';
  index: number;
}

export interface VectorEdit {
  id: NodeId;
  /** Indices into the layer's network. */
  vertices: number[];
}

export type SaveStatus = 'saved' | 'unsaved' | 'saving' | 'error';

interface EditorSnapshot {
  selection: NodeId[];
  pageId: NodeId;
}

export interface HistoryEntry {
  label: string;
  patch: DocumentPatch;
  before: EditorSnapshot;
  after: EditorSnapshot;
}

export const HISTORY_LIMIT = 500;

/** Per-user state that is remembered for a file but is not part of the document. */
export interface SessionState {
  pageId: NodeId;
  viewports: Record<NodeId, Viewport>;
}

export interface EditorState {
  // Document state: the design itself.
  doc: Document;

  // Editor state: per user, never part of the document.
  pageId: NodeId;
  selection: NodeId[];
  tool: ToolId;
  viewport: Viewport;
  /** Remembered viewports of the pages that are not currently shown. */
  viewports: Record<NodeId, Viewport>;
  canvasSize: Size;
  hoveredId: NodeId | null;
  /** Containers collapsed in the layers panel. */
  collapsed: Record<NodeId, true>;
  /** Layer whose name is being edited in the layers panel. */
  renamingId: NodeId | null;
  /** Text layer whose characters are being edited in place on the canvas. */
  editingTextId: NodeId | null;
  /**
   * The part of that text that is selected, as positions in its characters;
   * `start` equals `end` for a caret. Null while no text is being edited.
   */
  textSelection: { start: number; end: number } | null;
  /** The vector layer whose points are being edited on the canvas. It is always the whole selection. */
  vectorEdit: VectorEdit | null;
  /** The gradient (or cropped image) of the selected layer whose handles are shown on the canvas. */
  paintEdit: PaintEdit | null;
  /** Whether moving, resizing and drawing snap to nearby layers. A user preference. */
  snapping: boolean;
  /** Whether positions and sizes land on whole pixels while moving, resizing and drawing. A user preference. */
  pixelSnap: boolean;
  /** Whether frames' layout grids are drawn (and snapped to). A user preference. */
  showLayoutGrids: boolean;
  /** Whether the rulers, and with them the page's guides, are shown. A user preference. */
  showRulers: boolean;

  // History.
  undoStack: HistoryEntry[];
  redoStack: HistoryEntry[];
  /** Snapshot taken when a continuous interaction started; null when idle. */
  gesture: { doc: Document; selection: NodeId[] } | null;

  // Persistence status, written by the autosaver.
  saveStatus: SaveStatus;
  saveError: string | null;
}

export interface ApplyOptions {
  /** Selection to set together with the change. */
  select?: readonly NodeId[];
  /** Page to show after the change, for example a page the change just created. */
  page?: NodeId;
}

export interface EditorActions {
  /** Runs a pure document operation and records it as one undo step. */
  apply(label: string, fn: (doc: Document) => Document, options?: ApplyOptions): void;
  /** Starts a continuous interaction (drag, resize, rotate, draw). */
  beginGesture(): void;
  /**
   * Replaces the document during a gesture. `fn` receives the snapshot taken
   * by `beginGesture`, so calling it repeatedly never accumulates error.
   */
  updateGesture(fn: (base: Document) => Document, select?: readonly NodeId[]): void;
  /** Ends the gesture and records everything it changed as one undo step. */
  commitGesture(label: string): void;
  /** Ends the gesture and restores the document and selection from before it. */
  cancelGesture(): void;
  undo(): void;
  redo(): void;

  setSelection(ids: readonly NodeId[]): void;
  setTool(tool: ToolId): void;
  setPage(pageId: NodeId): void;
  setViewport(viewport: Viewport): void;
  setCanvasSize(size: Size): void;
  setHovered(id: NodeId | null): void;
  setCollapsed(id: NodeId, collapsed: boolean): void;
  setRenaming(id: NodeId | null): void;
  setEditingText(id: NodeId | null): void;
  /** Records which part of the text being edited is selected. */
  setTextSelection(selection: { start: number; end: number } | null): void;
  /** Starts point editing of a vector layer (which becomes the selection), changes which points are selected, or with null ends it. */
  setVectorEdit(edit: VectorEdit | null): void;
  /** Shows the handles of one of a layer's paints on the canvas (the layer becomes the selection), or with null hides them. */
  setPaintEdit(edit: PaintEdit | null): void;
  setSnapping(snapping: boolean): void;
  setPixelSnap(pixelSnap: boolean): void;
  setShowLayoutGrids(show: boolean): void;
  setShowRulers(show: boolean): void;
  /** Renames the file. Not an undo step, like renaming a file anywhere else. */
  renameDocument(name: string): void;
  /**
   * Records image assets in the document's asset table. Not an undo step:
   * the table only ever grows, and an entry no layer uses costs nothing.
   */
  addAssets(assets: Readonly<Record<string, AssetInfo>>): void;
  setSaveStatus(status: SaveStatus, error?: string | null): void;
}

export type EditorStore = StoreApi<EditorState & EditorActions>;

/** Keeps only existing layers on the given page, without duplicates. */
export function sanitizeSelection(doc: Document, pageId: NodeId, ids: readonly NodeId[]): NodeId[] {
  const out: NodeId[] = [];
  const seen = new Set<NodeId>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (isLayer(doc.nodes[id]) && getPageIdOf(doc, id) === pageId) out.push(id);
  }
  return out;
}

/**
 * Point editing lasts only while its vector exists and is the one selected
 * layer. Points that no longer exist drop out of the point selection.
 */
function keepVectorEdit(doc: Document, selection: readonly NodeId[], edit: VectorEdit | null): VectorEdit | null {
  if (!edit) return null;
  const node = doc.nodes[edit.id];
  if (!node || node.type !== 'VECTOR' || selection.length !== 1 || selection[0] !== edit.id) return null;
  const count = node.network.vertices.length;
  return edit.vertices.every((vertex) => vertex < count) ? edit : { id: edit.id, vertices: edit.vertices.filter((vertex) => vertex < count) };
}

/** A paint is edited on the canvas only while its layer is the one selected layer and the paint is still one that has handles. */
function keepPaintEdit(doc: Document, selection: readonly NodeId[], edit: PaintEdit | null): PaintEdit | null {
  if (!edit || selection.length !== 1 || selection[0] !== edit.id) return null;
  const node = doc.nodes[edit.id];
  const paint = isLayer(node) ? node[edit.key][edit.index] : undefined;
  if (!paint) return null;
  return isGradient(paint) || (paint.type === 'IMAGE' && paint.scaleMode === 'CROP') ? edit : null;
}

/** What is left of the point editing and paint editing in progress after the document or the selection changed. */
function keepEdits(doc: Document, selection: readonly NodeId[], state: Pick<EditorState, 'vectorEdit' | 'paintEdit'>): Pick<EditorState, 'vectorEdit' | 'paintEdit'> {
  return { vectorEdit: keepVectorEdit(doc, selection, state.vectorEdit), paintEdit: keepPaintEdit(doc, selection, state.paintEdit) };
}

function sameIds(a: readonly NodeId[], b: readonly NodeId[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

function resolvePage(doc: Document, preferred: NodeId | undefined, fallback?: NodeId): NodeId {
  if (preferred !== undefined && doc.nodes[preferred]?.type === 'PAGE') return preferred;
  if (fallback !== undefined && doc.nodes[fallback]?.type === 'PAGE') return fallback;
  const first = getPages(doc)[0];
  if (!first) throw new Error('The document has no pages');
  return first.id;
}

export interface EditorOptions {
  /**
   * Measures text so that text layers can be sized to their content. The
   * browser passes a canvas-based measurer; without one a fixed approximation
   * is used, which is what tests rely on.
   */
  measurer?: TextMeasurer;
  /** Initial value of the snapping preference. On unless told otherwise. */
  snapping?: boolean;
  /** Initial value of the "snap to pixel grid" preference. On unless told otherwise. */
  pixelSnap?: boolean;
  /** Initial value of the "show layout grids" preference. On unless told otherwise. */
  showLayoutGrids?: boolean;
  /** Initial value of the "show rulers" preference. Off unless told otherwise. */
  showRulers?: boolean;
}

export function createEditorStore(doc: Document, session?: Partial<SessionState>, options: EditorOptions = {}): EditorStore {
  const initialPage = resolvePage(doc, session?.pageId);
  const viewports = { ...(session?.viewports ?? {}) };
  const measurer = options.measurer ?? approximateMeasurer;
  /** Restores the invariants that depend on content: text sizes and vector boxes, then group bounds. */
  const normalize = (previous: Document, next: Document): Document =>
    normalizeGroups(fitVectors(previous, fitTextLayers(previous, fitTextRanges(previous, next), measurer)));

  return createStore<EditorState & EditorActions>()((set, get) => {
    /** Switches page (if needed) and selection after a history step or page change. */
    const withPage = (state: EditorState, doc: Document, pageId: NodeId, selection: readonly NodeId[]) => {
      const nextPage = resolvePage(doc, pageId, state.pageId);
      const nextSelection = sanitizeSelection(doc, nextPage, selection);
      if (nextPage === state.pageId) {
        return { pageId: nextPage, selection: nextSelection, ...keepEdits(doc, nextSelection, state) };
      }
      return {
        pageId: nextPage,
        selection: nextSelection,
        vectorEdit: null,
        paintEdit: null,
        viewports: { ...state.viewports, [state.pageId]: state.viewport },
        viewport: state.viewports[nextPage] ?? DEFAULT_VIEWPORT,
        hoveredId: null,
      };
    };

    const push = (state: EditorState, entry: HistoryEntry) => {
      const undoStack = [...state.undoStack, entry];
      if (undoStack.length > HISTORY_LIMIT) undoStack.splice(0, undoStack.length - HISTORY_LIMIT);
      return { undoStack, redoStack: [] as HistoryEntry[] };
    };

    return {
      doc,
      pageId: initialPage,
      selection: [],
      tool: 'move',
      viewport: viewports[initialPage] ?? DEFAULT_VIEWPORT,
      viewports,
      canvasSize: { width: 0, height: 0 },
      hoveredId: null,
      collapsed: {},
      renamingId: null,
      editingTextId: null,
      textSelection: null,
      vectorEdit: null,
      paintEdit: null,
      snapping: options.snapping ?? true,
      pixelSnap: options.pixelSnap ?? true,
      showLayoutGrids: options.showLayoutGrids ?? true,
      showRulers: options.showRulers ?? false,
      undoStack: [],
      redoStack: [],
      gesture: null,
      saveStatus: 'saved',
      saveError: null,

      apply(label, fn, options) {
        if (get().gesture) get().commitGesture('Edit');
        const state = get();
        const next = normalize(state.doc, fn(state.doc));
        const patch = diffDocuments(state.doc, next);
        if (!patch) {
          const selection = sanitizeSelection(state.doc, state.pageId, options?.select ?? state.selection);
          if (!sameIds(selection, state.selection)) set({ selection, ...keepEdits(state.doc, selection, state) });
          return;
        }
        // The change may have removed the current page, or asked to show another one.
        const view = withPage(state, next, options?.page ?? state.pageId, options?.select ?? state.selection);
        set({
          doc: next,
          hoveredId: state.hoveredId !== null && next.nodes[state.hoveredId] ? state.hoveredId : null,
          ...view,
          ...push(state, {
            label,
            patch,
            before: { selection: state.selection, pageId: state.pageId },
            after: { selection: view.selection, pageId: view.pageId },
          }),
        });
      },

      beginGesture() {
        const state = get();
        if (state.gesture) return;
        set({ gesture: { doc: state.doc, selection: state.selection } });
      },

      updateGesture(fn, select) {
        const state = get();
        if (!state.gesture) return;
        const next = normalize(state.gesture.doc, fn(state.gesture.doc));
        const selection = select ? sanitizeSelection(next, state.pageId, select) : sanitizeSelection(next, state.pageId, state.selection);
        if (next === state.doc && sameIds(selection, state.selection)) return;
        set({ doc: next, selection, ...keepEdits(next, selection, state) });
      },

      commitGesture(label) {
        const state = get();
        if (!state.gesture) return;
        const patch = diffDocuments(state.gesture.doc, state.doc);
        if (!patch) {
          set({ gesture: null });
          return;
        }
        set({
          gesture: null,
          ...push(state, {
            label,
            patch,
            before: { selection: state.gesture.selection, pageId: state.pageId },
            after: { selection: state.selection, pageId: state.pageId },
          }),
        });
      },

      cancelGesture() {
        const state = get();
        if (!state.gesture) return;
        const selection = sanitizeSelection(state.gesture.doc, state.pageId, state.gesture.selection);
        set({
          doc: state.gesture.doc,
          selection,
          ...keepEdits(state.gesture.doc, selection, state),
          gesture: null,
        });
      },

      undo() {
        if (get().gesture) get().cancelGesture();
        const state = get();
        const entry = state.undoStack[state.undoStack.length - 1];
        if (!entry) return;
        const next = applyPatch(state.doc, entry.patch, 'backward');
        set({
          doc: next,
          undoStack: state.undoStack.slice(0, -1),
          redoStack: [...state.redoStack, entry],
          renamingId: null,
          editingTextId: null,
          ...withPage(state, next, entry.before.pageId, entry.before.selection),
        });
      },

      redo() {
        if (get().gesture) return;
        const state = get();
        const entry = state.redoStack[state.redoStack.length - 1];
        if (!entry) return;
        const next = applyPatch(state.doc, entry.patch, 'forward');
        set({
          doc: next,
          redoStack: state.redoStack.slice(0, -1),
          undoStack: [...state.undoStack, entry],
          renamingId: null,
          editingTextId: null,
          ...withPage(state, next, entry.after.pageId, entry.after.selection),
        });
      },

      setSelection(ids) {
        const state = get();
        const selection = sanitizeSelection(state.doc, state.pageId, ids);
        if (!sameIds(selection, state.selection)) set({ selection, ...keepEdits(state.doc, selection, state) });
      },

      setTool(tool) {
        if (get().tool === tool) return;
        // Picking up a drawing tool other than the pen ends point editing.
        const keepsEditing = tool === 'move' || tool === 'hand' || tool === 'pen';
        const keepsPaint = tool === 'move' || tool === 'hand';
        set({ tool, vectorEdit: keepsEditing ? get().vectorEdit : null, paintEdit: keepsPaint ? get().paintEdit : null });
      },

      setPage(pageId) {
        const state = get();
        if (pageId === state.pageId || state.doc.nodes[pageId]?.type !== 'PAGE') return;
        if (state.gesture) get().cancelGesture();
        set({ renamingId: null, ...withPage(get(), get().doc, pageId, []) });
      },

      setViewport(viewport) {
        const current = get().viewport;
        if (current.x === viewport.x && current.y === viewport.y && current.zoom === viewport.zoom) return;
        set({ viewport });
      },

      setCanvasSize(size) {
        const current = get().canvasSize;
        if (current.width !== size.width || current.height !== size.height) set({ canvasSize: size });
      },

      setHovered(id) {
        if (get().hoveredId !== id) set({ hoveredId: id });
      },

      setCollapsed(id, collapsed) {
        const next = { ...get().collapsed };
        if (collapsed) next[id] = true;
        else delete next[id];
        set({ collapsed: next });
      },

      setRenaming(id) {
        if (get().renamingId !== id) set({ renamingId: id });
      },

      setSnapping(snapping) {
        if (get().snapping !== snapping) set({ snapping });
      },

      setPixelSnap(pixelSnap) {
        if (get().pixelSnap !== pixelSnap) set({ pixelSnap });
      },

      setShowLayoutGrids(show) {
        if (get().showLayoutGrids !== show) set({ showLayoutGrids: show });
      },

      setShowRulers(show) {
        if (get().showRulers !== show) set({ showRulers: show });
      },

      setEditingText(id) {
        const state = get();
        const valid = id !== null && state.doc.nodes[id]?.type === 'TEXT' ? id : null;
        if (state.editingTextId !== valid) {
          set({
            editingTextId: valid,
            textSelection: null,
            hoveredId: null,
            vectorEdit: valid === null ? state.vectorEdit : null,
            paintEdit: valid === null ? state.paintEdit : null,
          });
        }
      },

      setTextSelection(selection) {
        const state = get();
        const next =
          selection && state.editingTextId !== null
            ? { start: Math.max(0, Math.min(selection.start, selection.end)), end: Math.max(0, selection.start, selection.end) }
            : null;
        const current = state.textSelection;
        if (current === next || (current && next && current.start === next.start && current.end === next.end)) return;
        set({ textSelection: next });
      },

      setVectorEdit(edit) {
        const state = get();
        if (edit === null) {
          if (state.vectorEdit !== null) set({ vectorEdit: null });
          return;
        }
        const node = state.doc.nodes[edit.id];
        if (!node || node.type !== 'VECTOR' || getPageIdOf(state.doc, edit.id) !== state.pageId) return;
        const count = node.network.vertices.length;
        const vertices = [...new Set(edit.vertices)].filter((vertex) => Number.isInteger(vertex) && vertex >= 0 && vertex < count);
        const current = state.vectorEdit;
        const selected = sameIds(state.selection, [edit.id]);
        if (current && current.id === edit.id && selected && sameIds(current.vertices.map(String), vertices.map(String))) return;
        set({
          vectorEdit: { id: edit.id, vertices },
          selection: selected ? state.selection : [edit.id],
          hoveredId: null,
          editingTextId: null,
          paintEdit: null,
        });
      },

      setPaintEdit(edit) {
        const state = get();
        if (edit === null) {
          if (state.paintEdit !== null) set({ paintEdit: null });
          return;
        }
        if (getPageIdOf(state.doc, edit.id) !== state.pageId) return;
        const selection = sameIds(state.selection, [edit.id]) ? state.selection : [edit.id];
        const kept = keepPaintEdit(state.doc, selection, edit);
        if (!kept) return;
        const current = state.paintEdit;
        if (current && current.id === kept.id && current.key === kept.key && current.index === kept.index && selection === state.selection) return;
        set({ paintEdit: { id: kept.id, key: kept.key, index: kept.index }, selection, hoveredId: null, editingTextId: null, vectorEdit: null });
      },

      renameDocument(name) {
        const trimmed = name.trim();
        const state = get();
        if (!trimmed || trimmed === state.doc.name) return;
        set({ doc: { ...state.doc, name: trimmed } });
      },

      addAssets(assets) {
        const state = get();
        const fresh: Record<string, AssetInfo> = {};
        for (const hash in assets) if (!state.doc.assets[hash]) fresh[hash] = assets[hash] as AssetInfo;
        if (Object.keys(fresh).length === 0) return;
        const withAssets = (doc: Document): Document => ({ ...doc, assets: { ...doc.assets, ...fresh } });
        // Keep an open gesture's snapshot in step, so cancelling it does not forget the assets.
        set({ doc: withAssets(state.doc), gesture: state.gesture ? { ...state.gesture, doc: withAssets(state.gesture.doc) } : null });
      },

      setSaveStatus(status, error = null) {
        const state = get();
        if (state.saveStatus !== status || state.saveError !== error) set({ saveStatus: status, saveError: error });
      },
    };
  });
}

export function getSession(state: EditorState): SessionState {
  return { pageId: state.pageId, viewports: { ...state.viewports, [state.pageId]: state.viewport } };
}
