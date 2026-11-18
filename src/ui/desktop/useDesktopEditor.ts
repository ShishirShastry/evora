import { useEffect, useRef, type MutableRefObject } from 'react';
import type { Document, FileMeta, Point } from '../../core';
import type { Autosaver } from '../../persistence/autosave';
import type { CloseAction, DiskLink, EvoraDesktop } from '../../persistence/desktopContract';
import { desktopBridge, diskBaseline, isDiskDirty, saveFigToDisk, saveToDisk, type SaveMode } from '../../persistence/desktop';
import { exportFileText } from '../../persistence/files';
import type { DocumentStorage } from '../../persistence/storage';
import { getCommand, runCommand, type AppActions } from '../../state/commands';
import type { EditorStore } from '../../state/editorStore';

/**
 * The editor's part in the desktop app: Save and Save As to files on disk,
 * whether the open file has changes its disk file does not (the window's
 * title, the question when closing), a recovery copy of such a file kept by
 * the desktop app until it is saved, and the menu's commands. Does nothing in
 * a browser.
 */

export interface DesktopEditor {
  /** Runs an app command (src/state/commands.ts) on this editor. False when there is no such command or it is unavailable. */
  run(id: string): boolean;
  save(mode: SaveMode | 'fig'): Promise<void>;
  prepareClose(action: CloseAction): Promise<boolean>;
}

let current: DesktopEditor | null = null;

/** The editor open in this window, if any. */
export function currentDesktopEditor(): DesktopEditor | null {
  return current;
}

/** SVG files to place in a file once its editor is open (a `.svg` opened from disk becomes a new file with it in it). */
const pendingPlacements = new Map<string, File[]>();

export function placeWhenOpened(fileId: string, files: File[]): void {
  pendingPlacements.set(fileId, files);
}

/** Says what happened to the person: errors and results of saving. Set by DesktopMount. */
let notify: (title: string, lines?: string[]) => void = () => {};
export function setDesktopNotifier(callback: (title: string, lines?: string[]) => void): void {
  notify = callback;
}

const RECOVERY_DELAY = 2000;

interface Options {
  store: EditorStore;
  app: AppActions;
  storage: DocumentStorage;
  saver: MutableRefObject<Autosaver | null>;
  meta: FileMeta;
  /** Set for a shared document (on a collaboration server), which is not saved to disk from here. */
  sharedId: string | null;
  placeFiles: (files: readonly File[], at?: Point) => Promise<void>;
}

export function useDesktopEditor(options: Options): void {
  const latest = useRef(options);
  latest.current = options;
  const { store, storage, meta, sharedId } = options;

  useEffect(() => {
    const bridge: EvoraDesktop | null = desktopBridge();
    if (!bridge) return;
    const fileId = store.getState().doc.id;
    const shared = sharedId !== null;
    let link: DiskLink | null = null;
    let baseline: Document | null = store.getState().doc;
    let lastSent = '';
    let lastDirty = false;
    let disposed = false;
    let recoveryTimer: ReturnType<typeof setTimeout> | null = null;

    const dirty = (): boolean => !shared && isDiskDirty(link, baseline, store.getState().doc);
    const report = (isDirty: boolean = dirty()): void => {
      if (disposed) return;
      lastDirty = isDirty;
      const state = { editor: true, fileId, title: store.getState().doc.name, path: link?.path ?? null, dirty: isDirty, shared };
      const key = JSON.stringify(state);
      if (key === lastSent) return;
      lastSent = key;
      bridge.setDocState(state);
    };

    /** The document as stored: text being typed is made part of it and the autosave is written first. */
    const settled = async () => {
      const state = store.getState();
      if (state.editingTextId !== null) state.commitGesture('Edit text');
      const saver = latest.current.saver.current;
      await saver?.flush();
      return { fileId, doc: store.getState().doc, meta: saver?.meta() ?? meta };
    };

    const writeRecovery = async (): Promise<void> => {
      recoveryTimer = null;
      if (disposed || !link || !dirty()) return;
      const { doc, meta: stored } = await settled();
      const text = await exportFileText(storage, doc, stored);
      if (!disposed && link && dirty()) await bridge.writeRecovery({ fileId, path: link.path, name: doc.name, text });
    };
    const scheduleRecovery = (): void => {
      if (!link || recoveryTimer !== null) return;
      recoveryTimer = setTimeout(() => void writeRecovery(), RECOVERY_DELAY);
    };

    const save = async (mode: SaveMode | 'fig'): Promise<boolean> => {
      try {
        if (shared) {
          // A shared file lives on its server; a copy of it is saved with the editor's own dialog.
          if (mode === 'save') latest.current.app.saveNow();
          else latest.current.app.saveAs();
          return true;
        }
        const target = await settled();
        if (mode === 'fig') {
          const notWritten = await saveFigToDisk(storage, bridge, target.doc);
          if (notWritten && notWritten.length > 0) notify('Saved as a Figma file. A .fig file cannot hold everything in this file:', notWritten);
          return notWritten !== null;
        }
        const path = await saveToDisk(storage, bridge, target, mode);
        if (path === null) return false;
        if (mode !== 'copy') {
          link = await bridge.linkFor(fileId);
          baseline = target.doc;
          report();
        }
        return true;
      } catch (error) {
        // Electron wraps errors from the main process in "Error invoking remote method '…': Error: …"; show only the message.
        const message = (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '');
        notify('The file could not be saved.', [message]);
        return false;
      }
    };

    const editor: DesktopEditor = {
      run(id) {
        const command = getCommand(id);
        if (!command) return false;
        return runCommand(command, { store, app: latest.current.app });
      },
      save: async (mode) => {
        await save(mode);
      },
      async prepareClose(action) {
        if (action === 'save') return save('save');
        await settled();
        if (action === 'discard') {
          // The changes stay in the library file; opening the disk file again reads it afresh.
          await bridge.removeLink(fileId);
          await bridge.clearRecovery(fileId);
        }
        return true;
      },
    };
    current = editor;

    void bridge.linkFor(fileId).then((found) => {
      if (disposed) return;
      link = found;
      baseline = diskBaseline(found, meta, store.getState().doc);
      if (found && dirty()) scheduleRecovery();
      report();
    });
    report();

    const unsubscribe = store.subscribe((state, previous) => {
      if (state.doc === previous.doc) return;
      const wasDirty = lastDirty;
      const isDirty = dirty();
      report(isDirty);
      if (isDirty) scheduleRecovery();
      // Undone back to what is on disk: a recovery copy is no longer needed.
      else if (wasDirty && link) void bridge.clearRecovery(fileId);
    });

    // An SVG opened from disk: placed as layers once the canvas has its size.
    const svg = pendingPlacements.get(fileId);
    let stopWaiting: (() => void) | null = null;
    if (svg) {
      pendingPlacements.delete(fileId);
      const place = (): boolean => {
        if (store.getState().canvasSize.width === 0) return false;
        void latest.current.placeFiles(svg);
        return true;
      };
      if (!place()) {
        stopWaiting = store.subscribe(() => {
          if (place()) {
            stopWaiting?.();
            stopWaiting = null;
          }
        });
      }
    }

    return () => {
      disposed = true;
      unsubscribe();
      stopWaiting?.();
      if (recoveryTimer !== null) clearTimeout(recoveryTimer);
      if (current === editor) current = null;
      // Leaving the file is not a crash: its changes are in the library, and the recovery copy is not needed.
      void bridge.clearRecovery(fileId);
      bridge.setDocState({ editor: false, fileId: null, title: null, path: null, dirty: false, shared: false });
    };
  }, [store, storage, meta, sharedId]);
}
