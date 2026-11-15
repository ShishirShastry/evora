import { createStore, type StoreApi } from 'zustand/vanilla';
import {
  applyPatch,
  approximateMeasurer,
  diffDocuments,
  fitTextLayers,
  getPageIdOf,
  getPages,
  isLayer,
  normalizeGroups,
  type AssetInfo,
  type Document,
  type DocumentPatch,
  type NodeId,
  type TextMeasurer,
} from '../core';
import { DEFAULT_VIEWPORT, type Size, type Viewport } from '../engine/viewport';

export type ToolId = 'move' | 'hand' | 'frame' | 'rectangle' | 'ellipse' | 'line' | 'polygon' | 'star' | 'text';

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
  /** Whether moving, resizing and drawing snap to nearby layers. A user preference. */
  snapping: boolean;
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
  setSnapping(snapping: boolean): void;
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
  /** Initial value of the "show layout grids" preference. On unless told otherwise. */
  showLayoutGrids?: boolean;
  /** Initial value of the "show rulers" preference. Off unless told otherwise. */
  showRulers?: boolean;
}

export function createEditorStore(doc: Document, session?: Partial<SessionState>, options: EditorOptions = {}): EditorStore {
  const initialPage = resolvePage(doc, session?.pageId);
  const viewports = { ...(session?.viewports ?? {}) };
  const measurer = options.measurer ?? approximateMeasurer;
  /** Restores the invariants that depend on content: text sizes, then group bounds. */
  const normalize = (previous: Document, next: Document): Document =>
    normalizeGroups(fitTextLayers(previous, next, measurer));

  return createStore<EditorState & EditorActions>()((set, get) => {
    /** Switches page (if needed) and selection after a history step or page change. */
    const withPage = (state: EditorState, doc: Document, pageId: NodeId, selection: readonly NodeId[]) => {
      const nextPage = resolvePage(doc, pageId, state.pageId);
      if (nextPage === state.pageId) {
        return { pageId: nextPage, selection: sanitizeSelection(doc, nextPage, selection) };
      }
      return {
        pageId: nextPage,
        selection: sanitizeSelection(doc, nextPage, selection),
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
      snapping: options.snapping ?? true,
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
          if (!sameIds(selection, state.selection)) set({ selection });
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
        set({ doc: next, selection });
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
        set({
          doc: state.gesture.doc,
          selection: sanitizeSelection(state.gesture.doc, state.pageId, state.gesture.selection),
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
        if (!sameIds(selection, state.selection)) set({ selection });
      },

      setTool(tool) {
        if (get().tool !== tool) set({ tool });
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

      setShowLayoutGrids(show) {
        if (get().showLayoutGrids !== show) set({ showLayoutGrids: show });
      },

      setShowRulers(show) {
        if (get().showRulers !== show) set({ showRulers: show });
      },

      setEditingText(id) {
        const state = get();
        const valid = id !== null && state.doc.nodes[id]?.type === 'TEXT' ? id : null;
        if (state.editingTextId !== valid) set({ editingTextId: valid, hoveredId: null });
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
