import { describe, expect, it } from 'vitest';
import {
  addLayer,
  clipboardAssets,
  copyNodes,
  createDocument,
  CURRENT_SCHEMA_VERSION,
  getPages,
  hitTestDeepest,
  imagePaint,
  inFrame,
  isLayer,
  parseClipboard,
  serializeClipboard,
  validateDocument,
  type ClipboardPayload,
  type Document,
  type NodeId,
} from './core';
import { clampPanelWidth, DEFAULT_PREFERENCES, loadPreferences, PANEL_WIDTH_MAX, PANEL_WIDTH_MIN, savePreferences } from './persistence/prefs';
import { clearClipboard, clipboardText, getCommand, pasteClipboardText, runCommand, type AppActions, type Command } from './state/commands';
import { createEditorStore } from './state/editorStore';
import { LAYER_ROW_HEIGHT, visibleRows } from './ui/panels/LayersPanel';

/**
 * Housekeeping left over from Phases 1 and 2: frames hit by their rounded
 * corners, a layers list that renders only what is in view, side panels
 * whose widths are remembered, and a light theme.
 */

function setup(): { doc: Document; pageId: NodeId } {
  const doc = createDocument('Housekeeping');
  return { doc, pageId: (getPages(doc)[0] as { id: NodeId }).id };
}

/** The application actions a command may call on, none of which matter here. */
const APP: AppActions = {
  cancelInteraction: () => false,
  openShortcuts: () => undefined,
  saveNow: () => undefined,
  saveAs: () => undefined,
  placeImage: () => undefined,
  goHome: () => undefined,
};

/** A minimal stand-in for the browser's local storage. */
function localStorageLike(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => void values.delete(key),
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

describe('frames with rounded corners', () => {
  it('are hit inside the curve of a corner and not outside it', () => {
    const frame = { width: 200, height: 100, cornerRadius: 40, cornerRadii: null };
    expect(inFrame(frame, { x: 100, y: 50 })).toBe(true);
    // The very corner of the box is outside the curve; a little way in along the diagonal is inside it.
    expect(inFrame(frame, { x: 2, y: 2 })).toBe(false);
    expect(inFrame(frame, { x: 198, y: 98 })).toBe(false);
    expect(inFrame(frame, { x: 14, y: 14 })).toBe(true);
    expect(inFrame(frame, { x: 40, y: 0 })).toBe(true);
    expect(inFrame(frame, { x: -1, y: 50 })).toBe(false);
    // Each corner has its own radius; a square corner is all there.
    const mixed = { width: 200, height: 100, cornerRadius: 0, cornerRadii: [40, 0, 0, 0] as [number, number, number, number] };
    expect(inFrame(mixed, { x: 2, y: 2 })).toBe(false);
    expect(inFrame(mixed, { x: 198, y: 2 })).toBe(true);
    // A radius larger than the frame allows is scaled down, as it is when drawn: here to a half circle at each end.
    const pill = { width: 200, height: 100, cornerRadius: 500, cornerRadii: null };
    expect(inFrame(pill, { x: 10, y: 10 })).toBe(false);
    expect(inFrame(pill, { x: 16, y: 26 })).toBe(true);
  });

  it('are not selected, and do not show their children, where the corner is cut away', () => {
    const { doc, pageId } = setup();
    const frame = addLayer(doc, 'FRAME', pageId, { x: 100, y: 100, width: 200, height: 100, cornerRadius: 40 });
    const child = addLayer(frame.doc, 'RECTANGLE', frame.id, { x: 0, y: 0, width: 60, height: 60 });
    // In the cut-away corner nothing is hit: not the frame, and not the child that the frame clips there.
    expect(hitTestDeepest(child.doc, pageId, { x: 102, y: 102 })).toBeNull();
    expect(hitTestDeepest(child.doc, pageId, { x: 120, y: 120 })).toBe(child.id);
    expect(hitTestDeepest(child.doc, pageId, { x: 250, y: 150 })).toBe(frame.id);
    expect(hitTestDeepest(child.doc, pageId, { x: 298, y: 198 })).toBeNull();
  });
});

describe('the layers list', () => {
  it('needs only the rows in view, and a few either side', () => {
    // 1000 rows of 28 pixels in a list 280 tall: rows 0 to 9 are in view.
    expect(visibleRows(1000, 0, 280)).toEqual({ start: 0, end: 18 });
    // Scrolled to row 500.
    expect(visibleRows(1000, 500 * LAYER_ROW_HEIGHT, 280)).toEqual({ start: 492, end: 518 });
    // At the very end, and past it.
    expect(visibleRows(1000, 990 * LAYER_ROW_HEIGHT, 280)).toEqual({ start: 982, end: 1000 });
    expect(visibleRows(1000, 5000 * LAYER_ROW_HEIGHT, 280)).toEqual({ start: 991, end: 1000 });
    // A short list is all there; an empty one has nothing.
    expect(visibleRows(5, 0, 280)).toEqual({ start: 0, end: 5 });
    expect(visibleRows(0, 0, 280)).toEqual({ start: 0, end: 0 });
    // Before the list has been measured it still shows its first rows.
    expect(visibleRows(1000, 0, 0)).toEqual({ start: 0, end: 9 });
    // However long the page, the number of rows made depends on the height of the list alone.
    for (const count of [100, 10_000, 1_000_000]) {
      const { start, end } = visibleRows(count, Math.floor(count / 2) * LAYER_ROW_HEIGHT, 600);
      expect(end - start).toBe(Math.ceil(600 / LAYER_ROW_HEIGHT) + 16);
    }
  });
});

describe('layers on the system clipboard', () => {
  const HASH = 'c'.repeat(64);
  const IMAGE = { mimeType: 'image/png', width: 40, height: 20, name: 'photo.png' };

  /** A frame holding a rectangle filled with an image, and a text layer beside it. */
  function source(): { doc: Document; pageId: NodeId; frame: NodeId; child: NodeId; label: NodeId } {
    const { doc, pageId } = setup();
    const withImage: Document = { ...doc, assets: { [HASH]: IMAGE } };
    const frame = addLayer(withImage, 'FRAME', pageId, { x: 100, y: 100, width: 200, height: 100, name: 'Card' });
    const child = addLayer(frame.doc, 'RECTANGLE', frame.id, { x: 10, y: 10, width: 40, height: 20, fills: [imagePaint(HASH)] });
    const label = addLayer(child.doc, 'TEXT', pageId, { x: 400, y: 100, characters: 'Hello', name: 'Hello' });
    return { doc: label.doc, pageId, frame: frame.id, child: child.id, label: label.id };
  }

  it('come back as they went, and are pasted into another file with the images they use', () => {
    const { doc, frame, label } = source();
    const payload = copyNodes(doc, [frame, label]) as ClipboardPayload;
    const data = { payload, assets: clipboardAssets(doc, payload) };
    expect(Object.keys(data.assets)).toEqual([HASH]);
    const text = serializeClipboard(data);
    expect(parseClipboard(text)).toEqual(data);

    // Another file, in another window: it knows nothing of what was copied but this text.
    const other = createEditorStore(createDocument('Other'));
    other.getState().setCanvasSize({ width: 800, height: 600 });
    expect(pasteClipboardText(other, text)).toBe(true);
    const pasted = Object.values(other.getState().doc.nodes).filter(isLayer);
    expect(pasted.map((node) => node.name).sort()).toEqual(['Card', 'Hello', 'Rectangle 1']);
    // Fresh layers, not the copied ones under their old names.
    expect(pasted.some((node) => node.id === frame || node.id === label)).toBe(false);
    expect(other.getState().doc.assets).toEqual({ [HASH]: IMAGE });
    expect(other.getState().selection).toHaveLength(2);
    expect(validateDocument(other.getState().doc)).toEqual([]);
    // One undo takes the layers out again.
    other.getState().undo();
    expect(Object.values(other.getState().doc.nodes).filter(isLayer)).toEqual([]);
  });

  it('are what the copy command leaves for the system clipboard, with their names as plain text', () => {
    const { doc, frame, label } = source();
    const store = createEditorStore(doc);
    clearClipboard();
    expect(clipboardText()).toBeNull();
    store.getState().setSelection([frame, label]);
    let wrote = 0;
    const app: AppActions = { ...APP, copyToSystemClipboard: () => void wrote++ };
    runCommand(getCommand('edit.copy') as Command, { store, app });
    expect(wrote).toBe(1);
    const copied = clipboardText();
    expect(copied?.names).toBe('Card\nHello');
    expect(parseClipboard(copied?.data ?? '')?.payload.roots).toHaveLength(2);
    // Cut writes the clipboard while the layers still exist, then removes them.
    let layersAtCopy = -1;
    const cutting: AppActions = { ...APP, copyToSystemClipboard: () => void (layersAtCopy = Object.values(store.getState().doc.nodes).filter(isLayer).length) };
    runCommand(getCommand('edit.cut') as Command, { store, app: cutting });
    expect(layersAtCopy).toBe(3);
    expect(Object.values(store.getState().doc.nodes).filter(isLayer)).toEqual([]);
    // Without a system clipboard, copying still works inside the application.
    store.getState().undo();
    store.getState().setSelection([label]);
    runCommand(getCommand('edit.copy') as Command, { store, app: APP });
    expect(clipboardText()?.names).toBe('Hello');
  });

  it('are checked as a file is: other text, newer versions and damage do no harm', () => {
    const { doc, frame, child, label } = source();
    const payload = copyNodes(doc, [frame, label]) as ClipboardPayload;
    const good = JSON.parse(serializeClipboard({ payload, assets: clipboardAssets(doc, payload) })) as {
      schemaVersion: number;
      payload: { center: unknown; roots: { nodes: Record<string, unknown>[]; worldCenter: unknown }[] };
    };
    const again = (change: (data: typeof good) => void): ReturnType<typeof parseClipboard> => {
      const copy = JSON.parse(JSON.stringify(good)) as typeof good;
      change(copy);
      return parseClipboard(JSON.stringify(copy));
    };
    // Not layers at all.
    expect(parseClipboard('Hello')).toBeNull();
    expect(parseClipboard('{"format":"something else"}')).toBeNull();
    expect(parseClipboard(JSON.stringify({ format: 'open-design/clipboard', payload: { roots: [] } }))).toBeNull();
    // Copied by a newer version than this one, or with no version at all.
    expect(again((data) => void (data.schemaVersion = CURRENT_SCHEMA_VERSION + 1))).toBeNull();
    expect(again((data) => void ((data as { schemaVersion?: number }).schemaVersion = undefined))).toBeNull();

    // Bad values are put right, as when a file is opened; a layer whose parent is not there is left behind.
    const repaired = again((data) => {
      const [card, rectangle] = (data.payload.roots[0] as { nodes: Record<string, unknown>[] }).nodes as [Record<string, unknown>, Record<string, unknown>];
      card.width = 'wide';
      card.opacity = 7;
      rectangle.parentId = 'nowhere';
      data.payload.center = 'middle';
      (data.payload.roots[0] as { worldCenter: unknown }).worldCenter = { x: Number.NaN, y: 5 };
    });
    const card = repaired?.payload.roots[0]?.nodes ?? [];
    expect(card.map((node) => node.id)).toEqual([frame]);
    expect(card[0]).toMatchObject({ opacity: 1, type: 'FRAME' });
    expect(Number.isFinite(card[0]?.width)).toBe(true);
    expect(repaired?.payload.center).toEqual({ x: 0, y: 0 });
    expect(repaired?.payload.roots[0]?.worldCenter).toEqual({ x: 0, y: 5 });
    expect(card.some((node) => node.id === child)).toBe(false);
    // A root without its first layer is dropped; the other root is still pasted.
    const half = again((data) => void ((data.payload.roots[0] as { nodes: unknown[] }).nodes[0] = 'not a layer'));
    expect(half?.payload.roots.map((root) => root.nodes[0]?.id)).toEqual([label]);

    // Copied by an older version: brought up to date. Text of version 12 had no list and no styled parts.
    const older = again((data) => {
      data.schemaVersion = 12;
      const text = (data.payload.roots[1] as { nodes: Record<string, unknown>[] }).nodes[0] as Record<string, unknown>;
      delete text.listType;
      delete text.styleRanges;
    });
    expect(older?.payload.roots[1]?.nodes[0]).toMatchObject({ type: 'TEXT', characters: 'Hello', listType: 'NONE', styleRanges: [] });
  });
});

describe('side panel widths and the theme', () => {
  const app = APP;

  it('are preferences of this device, kept within limits', () => {
    const storage = localStorageLike();
    expect(loadPreferences(storage)).toEqual(DEFAULT_PREFERENCES);
    expect(DEFAULT_PREFERENCES).toMatchObject({ theme: 'dark', leftPanelWidth: 240, rightPanelWidth: 252 });
    // One preference can be saved without the others being given or lost.
    savePreferences({ leftPanelWidth: 300 }, storage);
    savePreferences({ theme: 'light' }, storage);
    savePreferences({ snapping: false }, storage);
    expect(loadPreferences(storage)).toEqual({ ...DEFAULT_PREFERENCES, leftPanelWidth: 300, theme: 'light', snapping: false });
    // Widths outside what a panel can be, and anything that is not a width or a theme, are brought back.
    savePreferences({ leftPanelWidth: 5000, rightPanelWidth: 10 }, storage);
    expect(loadPreferences(storage)).toMatchObject({ leftPanelWidth: PANEL_WIDTH_MAX, rightPanelWidth: PANEL_WIDTH_MIN });
    storage.setItem('open-design:preferences', JSON.stringify({ theme: 'sepia', leftPanelWidth: 'wide', rightPanelWidth: null }));
    expect(loadPreferences(storage)).toEqual(DEFAULT_PREFERENCES);
    expect(clampPanelWidth(250.6, 240)).toBe(251);
    expect(clampPanelWidth(Number.NaN, 240)).toBe(240);
    // Storage that cannot be used leaves the defaults.
    expect(loadPreferences(undefined)).toEqual(DEFAULT_PREFERENCES);
  });

  it('switch the theme from the View menu, without touching the document', () => {
    const { doc } = setup();
    const store = createEditorStore(doc, undefined, { theme: 'light' });
    expect(store.getState().theme).toBe('light');
    const command = getCommand('view.lightTheme') as Command;
    expect(command.checked?.(store.getState())).toBe(true);
    runCommand(command, { store, app });
    expect(store.getState().theme).toBe('dark');
    expect(command.checked?.(store.getState())).toBe(false);
    runCommand(command, { store, app });
    expect(store.getState().theme).toBe('light');
    // It is a preference, not an edit: nothing to undo, nothing to save.
    expect(store.getState().undoStack).toEqual([]);
    expect(store.getState().doc).toBe(doc);
    expect(createEditorStore(doc).getState().theme).toBe('dark');
  });
});
