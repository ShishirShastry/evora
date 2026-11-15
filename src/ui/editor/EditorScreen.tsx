import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileFormatError, type FileMeta, type Point } from '../../core';
import { ImageCache } from '../../engine/images/imageCache';
import type { InteractionController } from '../../engine/input/controller';
import { getBrowserMeasurer } from '../../engine/text/measure';
import { createAutosaver, type Autosaver } from '../../persistence/autosave';
import { pickImageFiles, saveTextToDisk } from '../../persistence/diskIO';
import { exportFileName, exportFileText, openFile } from '../../persistence/files';
import { loadPreferences, savePreferences } from '../../persistence/prefs';
import { loadSession, saveSession } from '../../persistence/session';
import type { DocumentStorage } from '../../persistence/storage';
import { commandForKey, getCommand, runCommand, type AppActions } from '../../state/commands';
import { imageTypeOf, importImageFiles, placeImages } from '../../state/images';
import { createEditorStore, getSession, type EditorStore } from '../../state/editorStore';
import { Dialog } from '../components/Dialog';
import { Logo } from '../components/Icon';
import { DesignPanel } from '../panels/DesignPanel';
import { LayersPanel } from '../panels/LayersPanel';
import { PagesPanel } from '../panels/PagesPanel';
import { CanvasView } from './CanvasView';
import { EditorContext, type EditorContextValue } from './EditorContext';
import { shortcutGroups } from './menus';
import { TopBar } from './TopBar';

interface EditorScreenProps {
  storage: DocumentStorage;
  fileId: string;
  onExit: () => void;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'missing' }
  | { status: 'error'; message: string }
  | { status: 'ready'; store: EditorStore; meta: FileMeta; repairs: string[] };

/** Loads a file from storage and shows the editor for it. */
export function EditorScreen({ storage, fileId, onExit }: EditorScreenProps) {
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setLoad({ status: 'loading' });
    openFile(storage, fileId)
      .then((opened) => {
        if (cancelled) return;
        if (!opened) {
          setLoad({ status: 'missing' });
          return;
        }
        const store = createEditorStore(opened.doc, loadSession(opened.doc.id), {
          measurer: getBrowserMeasurer() ?? undefined,
          ...loadPreferences(),
        });
        setLoad({ status: 'ready', store, meta: opened.meta, repairs: opened.repairs });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const message =
          error instanceof FileFormatError
            ? error.message
            : `The file could not be opened. ${error instanceof Error ? error.message : ''}`;
        setLoad({ status: 'error', message });
      });
    return () => {
      cancelled = true;
    };
  }, [storage, fileId]);

  if (load.status === 'ready') {
    return <Editor key={fileId} storage={storage} store={load.store} meta={load.meta} repairs={load.repairs} onExit={onExit} />;
  }
  return (
    <main className="flex h-full flex-col items-center justify-center gap-4 text-center">
      <Logo size={40} />
      {load.status === 'loading' && <p className="m-0 text-dim">Opening file…</p>}
      {load.status === 'missing' && <p className="m-0">This file does not exist on this device.</p>}
      {load.status === 'error' && (
        <p role="alert" className="m-0 max-w-md text-danger">
          {load.message}
        </p>
      )}
      {load.status !== 'loading' && (
        <button type="button" className="od-button" onClick={onExit}>
          Back to files
        </button>
      )}
    </main>
  );
}

interface EditorProps {
  storage: DocumentStorage;
  store: EditorStore;
  meta: FileMeta;
  repairs: string[];
  onExit: () => void;
}

function Editor({ storage, store, meta, repairs, onExit }: EditorProps) {
  const controller = useRef<InteractionController | null>(null);
  const saver = useRef<Autosaver | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [notice, setNotice] = useState<{ title: string; lines: string[] } | null>(
    repairs.length > 0 ? { title: 'This file had problems that were repaired when it was opened.', lines: repairs } : null,
  );
  const exit = useRef(onExit);
  exit.current = onExit;
  const images = useMemo(() => new ImageCache((hash) => storage.loadAsset(hash)), [storage]);

  const placeFiles = useCallback(
    async (files: readonly File[], at?: Point): Promise<void> => {
      const { imported, failed } = await importImageFiles(storage, images, files);
      placeImages(store, imported, at);
      if (failed > 0) {
        setNotice({
          title: failed === 1 ? 'One file could not be placed.' : `${failed} files could not be placed.`,
          lines: ['Images can be PNG, JPEG, WebP, GIF or SVG.'],
        });
      }
    },
    [storage, images, store],
  );

  const pickImage = useCallback(async (): Promise<string | null> => {
    const [file] = await pickImageFiles(false);
    if (!file) return null;
    const { imported } = await importImageFiles(storage, images, [file]);
    const first = imported[0];
    if (!first) {
      setNotice({ title: 'That file could not be used as an image.', lines: ['Images can be PNG, JPEG, WebP, GIF or SVG.'] });
      return null;
    }
    store.getState().addAssets({ [first.hash]: first.info });
    return first.hash;
  }, [storage, images, store]);

  const app = useMemo<AppActions>(
    () => ({
      cancelInteraction: () => controller.current?.cancel() ?? false,
      openShortcuts: () => setShortcutsOpen(true),
      saveNow: () => void saver.current?.flush(),
      saveAs: () => {
        const state = store.getState();
        const fileMeta = saver.current?.meta() ?? meta;
        void exportFileText(storage, state.doc, fileMeta).then((text) => saveTextToDisk(exportFileName(state.doc.name), text));
      },
      placeImage: () => {
        void pickImageFiles().then((files) => (files.length > 0 ? placeFiles(files) : undefined));
      },
      goHome: () => {
        const pending = saver.current?.flush() ?? Promise.resolve();
        void pending.then(() => exit.current());
      },
    }),
    [store, meta, storage, placeFiles],
  );

  const context = useMemo<EditorContextValue>(
    () => ({ store, app, controller, storage, images, placeFiles, pickImage }),
    [store, app, storage, images, placeFiles, pickImage],
  );

  // Autosave, and remembering the view, for as long as the file is open.
  useEffect(() => {
    const autosaver = createAutosaver(store, storage, meta);
    saver.current = autosaver;
    const docId = store.getState().doc.id;

    let sessionTimer: ReturnType<typeof setTimeout> | null = null;
    const writeSession = (): void => saveSession(docId, getSession(store.getState()));
    const unsubscribe = store.subscribe((state, previous) => {
      if (
        state.snapping !== previous.snapping ||
        state.pixelSnap !== previous.pixelSnap ||
        state.showLayoutGrids !== previous.showLayoutGrids ||
        state.showRulers !== previous.showRulers
      ) {
        savePreferences({ snapping: state.snapping, pixelSnap: state.pixelSnap, showLayoutGrids: state.showLayoutGrids, showRulers: state.showRulers });
      }
      if (state.viewport === previous.viewport && state.pageId === previous.pageId) return;
      if (sessionTimer !== null) clearTimeout(sessionTimer);
      sessionTimer = setTimeout(writeSession, 300);
    });

    const flush = (): void => {
      writeSession();
      // Text being typed lives in an open gesture; make it part of the document before saving.
      if (store.getState().editingTextId !== null) store.getState().commitGesture('Edit text');
      void autosaver.flush();
    };
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') flush();
    };
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      if (store.getState().saveStatus === 'saved') return;
      // Start the write and ask the browser to wait so it can finish.
      flush();
      event.preventDefault();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', onBeforeUnload);

    return () => {
      unsubscribe();
      if (sessionTimer !== null) clearTimeout(sessionTimer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('beforeunload', onBeforeUnload);
      writeSession();
      void autosaver.dispose();
      if (saver.current === autosaver) saver.current = null;
    };
  }, [store, storage, meta]);

  // Keyboard shortcuts.
  useEffect(() => {
    // Shortcuts are suspended only while the keyboard is being used to type:
    // a focused checkbox or button must not swallow them.
    const TEXT_ENTRY =
      'input:not([type="checkbox"]):not([type="radio"]):not([type="color"]):not([type="range"]):not([type="button"]), textarea, select, [contenteditable="true"]';
    const isTyping = (target: EventTarget | null): boolean =>
      target instanceof HTMLElement && target.closest(TEXT_ENTRY) !== null;
    const overlayOpen = (): boolean => document.querySelector('[role="menu"], [role="dialog"]') !== null;

    // Space and Enter operate a focused button, list item or tree item; they must not be taken from it.
    const onControl = (target: EventTarget | null): boolean =>
      target instanceof HTMLElement && target.closest('button, a[href], [role="option"], [role="treeitem"]') !== null;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (isTyping(event.target) || overlayOpen()) return;
      if (event.code === 'Space') {
        if (onControl(event.target)) return;
        controller.current?.setSpaceDown(true);
        event.preventDefault();
        return;
      }
      if (event.key === 'Alt') {
        // Alt on its own measures from the selection. Left alone, the browser would move the focus to its own menu.
        controller.current?.setAltDown(true);
        event.preventDefault();
        return;
      }
      if ((event.code === 'Enter' || event.code === 'NumpadEnter') && onControl(event.target)) return;
      const command = commandForKey(event);
      if (!command) return;
      // Ctrl+V is left to the browser so that it raises a paste event, which
      // is the only way to see whether the clipboard holds an image.
      if (command.id === 'edit.paste') return;
      const ran = runCommand(command, { store, app });
      // Also swallow modified keys whose command is unavailable right now, so the
      // browser does not act on them instead (Ctrl+D would bookmark the page).
      if (ran || event.ctrlKey || event.metaKey || event.altKey) event.preventDefault();
    };
    const onKeyUp = (event: KeyboardEvent): void => {
      if (event.code === 'Space') controller.current?.setSpaceDown(false);
      if (event.key === 'Alt') {
        controller.current?.setAltDown(false);
        event.preventDefault();
      }
    };
    const onBlur = (): void => {
      controller.current?.setSpaceDown(false);
      controller.current?.setAltDown(false);
    };

    /** Paste: images from the system clipboard are placed; otherwise layers copied in the editor are pasted. */
    const onPaste = (event: ClipboardEvent): void => {
      if (isTyping(event.target) || overlayOpen()) return;
      event.preventDefault();
      const files = [...(event.clipboardData?.files ?? [])].filter((file) => imageTypeOf(file) !== null);
      if (files.length > 0) void placeFiles(files);
      else {
        const paste = getCommand('edit.paste');
        if (paste) runCommand(paste, { store, app });
      }
    };

    window.addEventListener('paste', onPaste);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('paste', onPaste);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [store, app, placeFiles]);

  // Show the file name in the browser tab.
  useEffect(() => {
    const setTitle = (): void => {
      document.title = `${store.getState().doc.name} – OPEN DESIGN`;
    };
    setTitle();
    const unsubscribe = store.subscribe((state, previous) => {
      if (state.doc.name !== previous.doc.name) setTitle();
    });
    return () => {
      unsubscribe();
      document.title = 'OPEN DESIGN';
    };
  }, [store]);

  return (
    <EditorContext.Provider value={context}>
      <div className="flex h-full flex-col">
        <TopBar />
        {notice && (
          <div role="alert" className="flex flex-none items-start gap-3 border-b border-line bg-field px-3 py-2">
            <div className="min-w-0 flex-1">
              <strong>{notice.title}</strong>
              <ul className="m-0 mt-1 pl-4 text-dim">
                {notice.lines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
            <button type="button" className="od-button" onClick={() => setNotice(null)}>
              Dismiss
            </button>
          </div>
        )}
        <div className="flex min-h-0 flex-1">
          <nav aria-label="Pages and layers" className="flex w-60 flex-none flex-col border-r border-line bg-panel">
            <PagesPanel />
            <LayersPanel />
          </nav>
          <CanvasView />
          <div className="flex w-[252px] flex-none flex-col border-l border-line bg-panel">
            <div className="flex h-9 flex-none items-center border-b border-line px-3 text-[11px] font-semibold uppercase tracking-wide text-accent">
              Design
            </div>
            <div className="min-h-0 flex-1">
              <DesignPanel />
            </div>
          </div>
        </div>
      </div>
      {shortcutsOpen && <ShortcutsDialog onClose={() => setShortcutsOpen(false)} />}
    </EditorContext.Provider>
  );
}

/** The keyboard shortcut reference, generated from the same command table the shortcuts run from. */
function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog title="Keyboard shortcuts" onClose={onClose} width={560}>
      <div className="grid grid-cols-2 gap-x-8 gap-y-4">
        {shortcutGroups().map(({ group, commands }) => (
          <section key={group} aria-label={group}>
            <h3 className="m-0 mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-dim">{group}</h3>
            <dl className="m-0">
              {commands.map((command) => (
                <div key={command.id} className="flex h-6 items-center justify-between gap-4">
                  <dt>{command.label}</dt>
                  <dd className="m-0">
                    <kbd className="rounded border border-line bg-field px-1.5 py-0.5 font-sans text-[11px] text-dim">
                      {command.shortcut}
                    </kbd>
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
        <section aria-label="Canvas">
          <h3 className="m-0 mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-dim">Canvas</h3>
          <dl className="m-0">
            {[
              ['Pan', 'Space + drag, or middle button'],
              ['Zoom', 'Ctrl + wheel, or pinch'],
              ['Scroll', 'Wheel (Shift for sideways)'],
              ['Select inside', 'Double-click, or Ctrl + click'],
              ['Add to selection', 'Shift + click'],
              ['Duplicate while moving', 'Alt + drag'],
              ['Constrain', 'Shift while dragging'],
              ['From centre', 'Alt while resizing or drawing'],
            ].map(([what, how]) => (
              <div key={what} className="flex min-h-6 items-center justify-between gap-4">
                <dt>{what}</dt>
                <dd className="m-0 text-right text-dim">{how}</dd>
              </div>
            ))}
          </dl>
        </section>
      </div>
    </Dialog>
  );
}
