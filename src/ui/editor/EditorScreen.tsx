import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CLIPBOARD_MIME, LEGACY_CLIPBOARD_MIME, FileFormatError, cssFor, isLayer, listLibraries, safeFileName, nameFromFile, readSvg, SvgImportError, newExportSetting, prototypeFrames, startFrame, type FileMeta, type Point } from '../../core';
import { ImageCache } from '../../engine/images/imageCache';
import type { InteractionController } from '../../engine/input/controller';
import { bundledFonts, fontsUsedBy, loadFonts, onFontsLoaded } from '../../engine/text/fonts';
import { getBrowserMeasurer, resetTextMeasurements } from '../../engine/text/measure';
import { createAutosaver, type Autosaver } from '../../persistence/autosave';
import { pickImageFiles, saveTextToDisk } from '../../persistence/diskIO';
import { exportFileName, exportFileText, openFile } from '../../persistence/files';
import { DEFAULT_PREFERENCES, loadPreferences, PANEL_WIDTH_MAX, PANEL_WIDTH_MIN, savePreferences } from '../../persistence/prefs';
import { loadSession, saveSession } from '../../persistence/session';
import type { DocumentStorage } from '../../persistence/storage';
import { clipboardText, commandForKey, getCommand, pasteClipboardText, runCommand, type AppActions } from '../../state/commands';
import { imageTypeOf, importImageFiles, placeImages, placeSvgLayers } from '../../state/images';
import { createEditorStore, getSession, type EditorStore } from '../../state/editorStore';
import { Dialog } from '../components/Dialog';
import { LibrariesDialog } from './LibrariesDialog';
import { ExportDialog } from '../panels/ExportSection';
import { downloadBytes, exportEnvironment } from './exporting';
import { exportFigBytes } from '../../persistence/fig';
import { exportOne, svgOf } from '../../engine/export/export';
import { loadLibrary } from '../../persistence/libraries';
import { Logo } from '../components/Icon';
import { PanelResizer } from '../components/PanelResizer';
import { RightSidebar } from '../panels/RightSidebar';
import { ComponentsPanel } from '../panels/ComponentSections';
import { LayersPanel } from '../panels/LayersPanel';
import { PagesPanel } from '../panels/PagesPanel';
import { applyTheme } from '../theme';
import { CanvasView } from './CanvasView';
import { EditorContext, type EditorContextValue } from './EditorContext';
import { shortcutGroups } from './menus';
import { FileHeader, ToolDock, ViewControls } from './TopBar';

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
      .then(async (opened) => {
        if (cancelled) return;
        if (!opened) {
          setLoad({ status: 'missing' });
          return;
        }
        // Text is measured on a canvas, which uses a fallback font for a face that has not been loaded.
        // So the faces of the bundled font, and whatever else the file's text is set in, are loaded first.
        await loadFonts([...bundledFonts(), ...fontsUsedBy(opened.doc)]);
        if (cancelled) return;
        resetTextMeasurements();
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
        <button type="button" className="ev-button" onClick={onExit}>
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
  const [librariesOpen, setLibrariesOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [saveAsOpen, setSaveAsOpen] = useState(false);
  const [notice, setNotice] = useState<{ title: string; lines: string[] } | null>(
    repairs.length > 0 ? { title: 'This file had problems that were repaired when it was opened.', lines: repairs } : null,
  );
  // When the file is opened: say so if a library it uses has been published again since.
  useEffect(() => {
    let current = true;
    const used = listLibraries(store.getState().doc);
    void Promise.all(used.map((library) => loadLibrary(storage, library.id).then((latest) => (latest && latest.publication.version > library.version ? library.name : null)))).then((names) => {
      const newer = names.filter((name): name is string => name !== null);
      if (!current || newer.length === 0) return;
      setNotice((shown) => shown ?? { title: 'A library this file uses has a newer version.', lines: newer.map((name) => `“${name}” was published again. Open Libraries in the File menu to update.`) });
    });
    return () => {
      current = false;
    };
  }, [store, storage]);
  const exit = useRef(onExit);
  exit.current = onExit;
  const images = useMemo(() => new ImageCache((hash) => storage.loadAsset(hash)), [storage]);

  const placeFiles = useCallback(
    async (files: readonly File[], at?: Point): Promise<void> => {
      // An SVG file comes in as layers that can be edited; one that cannot be read that way is placed as a picture.
      const pictures: File[] = [];
      const notes: string[] = [];
      for (const file of files) {
        if (imageTypeOf(file) !== 'image/svg+xml') {
          pictures.push(file);
          continue;
        }
        try {
          const drawing = readSvg(await file.text(), getBrowserMeasurer() ?? undefined);
          placeSvgLayers(store, drawing, nameFromFile(file.name), at);
          for (const warning of drawing.warnings) notes.push(`${file.name}: ${warning}`);
        } catch (error) {
          if (!(error instanceof SvgImportError)) throw error;
          pictures.push(file);
        }
      }
      const { imported, failed } = await importImageFiles(storage, images, pictures);
      placeImages(store, imported, at);
      if (notes.length > 0) setNotice({ title: 'The SVG was imported as layers. Some of it could not be:', lines: notes });
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

  /** True while a copy raised by the application itself is under way: that is the copy that carries layers. */
  const copyingLayers = useRef(false);

  const app = useMemo<AppActions>(
    () => ({
      copyToSystemClipboard: () => {
        // A page may write the clipboard only while a copy is under way, so one is started here;
        // the copy handler further down fills it with the layers.
        copyingLayers.current = true;
        try {
          document.execCommand('copy');
        } catch {
          // The layers are still on the application's own clipboard.
        } finally {
          copyingLayers.current = false;
        }
      },
      cancelInteraction: () => controller.current?.cancel() ?? false,
      openShortcuts: () => setShortcutsOpen(true),
      openLibraries: () => setLibrariesOpen(true),
      openExport: () => setExportOpen(true),
      copyAs: (kind) => {
        const { doc, selection } = store.getState();
        const ids = selection.filter((id) => isLayer(doc.nodes[id]));
        const first = ids[0];
        if (first === undefined || !navigator.clipboard) return;
        const said = (title: string): void => setNotice({ title, lines: [] });
        const refused = (): void => said('The browser did not allow copying to the clipboard.');
        const environment = exportEnvironment(storage, images);
        if (kind === 'CSS') {
          // Each layer's own CSS, under its name when there are several.
          const css = ids.map((id) => (ids.length > 1 ? `/* ${doc.nodes[id]?.name} */\n` : '') + cssFor(doc, id)).join('\n\n');
          void navigator.clipboard.writeText(css).then(() => said('Copied as CSS.'), refused);
        } else if (kind === 'SVG') {
          void Promise.all(ids.map((id) => svgOf(doc, id, environment)))
            .then((parts) => navigator.clipboard.writeText(parts.join('\n')))
            .then(() => said('Copied as SVG.'), refused);
        } else {
          // A picture of one layer: the first of the selection.
          void exportOne(doc, { nodeId: first, fileName: 'copy.png', setting: newExportSetting() }, environment)
            .then(({ file }) => navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([file.bytes as unknown as BlobPart], { type: 'image/png' }) })]))
            .then(() => said(`Copied “${doc.nodes[first]?.name}” as PNG.`), refused);
        }
      },
      present: (startId) => {
        const state = store.getState();
        // From the frame that is named or selected; otherwise from the first flow, or the first frame.
        const selected = state.selection.length === 1 ? state.selection[0] : undefined;
        const frames = prototypeFrames(state.doc, state.pageId);
        const start = startId ?? (selected !== undefined && frames.some((frame) => frame.id === selected) ? selected : startFrame(state.doc, state.pageId));
        if (state.editingTextId !== null) state.commitGesture('Edit text');
        // The viewer reads the file from storage, so it is written first.
        const pending = saver.current?.flush() ?? Promise.resolve();
        void pending.then(() => {
          window.location.hash = `#/proto/${state.doc.id}${start ? `/${start}` : ''}`;
        });
      },
      saveNow: () => void saver.current?.flush(),
      saveAs: () => setSaveAsOpen(true),
      placeImage: () => {
        void pickImageFiles().then((files) => (files.length > 0 ? placeFiles(files) : undefined));
      },
      goHome: () => {
        const pending = saver.current?.flush() ?? Promise.resolve();
        void pending.then(() => exit.current());
      },
    }),
    [store, meta, storage, placeFiles, images],
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
      if (state.theme !== previous.theme) {
        applyTheme(state.theme);
        savePreferences({ theme: state.theme });
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
      // While text is being edited and the keyboard is in the properties panel, only Escape acts on the design.
      if (store.getState().editingTextId !== null && command.id !== 'edit.deselect') {
        if (event.ctrlKey || event.metaKey || event.altKey) event.preventDefault();
        return;
      }
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

    /** A copy started by the application: the copied layers go on the system clipboard, with their names as plain text. */
    const onCopy = (event: ClipboardEvent): void => {
      const copied = copyingLayers.current ? clipboardText() : null;
      if (!copied || !event.clipboardData) return;
      event.clipboardData.setData(CLIPBOARD_MIME, copied.data);
      event.clipboardData.setData('text/plain', copied.names);
      event.preventDefault();
    };

    /**
     * Paste: layers on the system clipboard (copied in this window or another) are pasted; failing that,
     * images on it are placed; failing that, whatever was last copied in this window is pasted.
     */
    const onPaste = (event: ClipboardEvent): void => {
      if (isTyping(event.target) || overlayOpen()) return;
      event.preventDefault();
      // Layers copied by Evora, or by this application before it was renamed.
      const layers = event.clipboardData?.getData(CLIPBOARD_MIME) || event.clipboardData?.getData(LEGACY_CLIPBOARD_MIME) || '';
      if (layers !== '' && pasteClipboardText(store, layers)) return;
      const files = [...(event.clipboardData?.files ?? [])].filter((file) => imageTypeOf(file) !== null);
      if (files.length > 0) void placeFiles(files);
      else {
        const paste = getCommand('edit.paste');
        if (paste) runCommand(paste, { store, app });
      }
    };

    window.addEventListener('copy', onCopy);
    window.addEventListener('paste', onPaste);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('copy', onCopy);
      window.removeEventListener('paste', onPaste);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [store, app, placeFiles]);

  // A font face that arrives later (text in a script whose face was not needed until now) changes how
  // text measures: what was measured is forgotten, and text layers are sized to their content again.
  useEffect(
    () =>
      onFontsLoaded(() => {
        resetTextMeasurements();
        store.getState().refitText();
      }),
    [store],
  );

  // The widths of the two side panels: dragged by their edges, remembered on this device.
  const [panels, setPanels] = useState(() => {
    const preferences = loadPreferences();
    return { left: preferences.leftPanelWidth, right: preferences.rightPanelWidth };
  });

  // Show the file name in the browser tab.
  useEffect(() => {
    const setTitle = (): void => {
      document.title = `${store.getState().doc.name} – Evora`;
    };
    setTitle();
    const unsubscribe = store.subscribe((state, previous) => {
      if (state.doc.name !== previous.doc.name) setTitle();
    });
    return () => {
      unsubscribe();
      document.title = 'Evora';
    };
  }, [store]);

  return (
    <EditorContext.Provider value={context}>
      {/* Figma's arrangement: the panels float beside the canvas, each a card of its own on the window's dark ground. */}
      <div className="flex h-full gap-1.5 bg-bg p-1.5">
        <nav aria-label="Pages and layers" className="ev-panel relative z-10 flex flex-none flex-col overflow-hidden" style={{ width: panels.left }}>
          <FileHeader />
          <PagesPanel />
          <ComponentsPanel />
          <LayersPanel />
          <PanelResizer
            label="Resize the layers panel"
            side="left"
            width={panels.left}
            min={PANEL_WIDTH_MIN}
            max={PANEL_WIDTH_MAX}
            reset={DEFAULT_PREFERENCES.leftPanelWidth}
            onChange={(left) => setPanels((current) => ({ ...current, left }))}
            onCommit={(left) => savePreferences({ leftPanelWidth: left })}
          />
        </nav>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        {notice && (
          <div role="alert" className="ev-panel flex flex-none items-start gap-3 px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <strong>{notice.title}</strong>
              <ul className="m-0 mt-1 pl-4 text-dim">
                {notice.lines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
            <button type="button" className="ev-button" onClick={() => setNotice(null)}>
              Dismiss
            </button>
          </div>
        )}
          <div className="ev-panel relative flex min-h-0 flex-1 overflow-hidden">
            <CanvasView />
            <ToolDock />
          </div>
        </div>
        <div className="ev-panel relative z-10 flex flex-none flex-col overflow-hidden" style={{ width: panels.right }}>
          <PanelResizer
            label="Resize the design panel"
            side="right"
            width={panels.right}
            min={PANEL_WIDTH_MIN}
            max={PANEL_WIDTH_MAX}
            reset={DEFAULT_PREFERENCES.rightPanelWidth}
            onChange={(right) => setPanels((current) => ({ ...current, right }))}
            onCommit={(right) => savePreferences({ rightPanelWidth: right })}
          />
          <ViewControls />
          <RightSidebar />
        </div>
      </div>
      {shortcutsOpen && <ShortcutsDialog onClose={() => setShortcutsOpen(false)} />}
      {librariesOpen && <LibrariesDialog onClose={() => setLibrariesOpen(false)} />}
      {exportOpen && <ExportDialog onClose={() => setExportOpen(false)} />}
      {saveAsOpen && (
        <SaveCopyDialog
          onClose={() => setSaveAsOpen(false)}
          saveEvora={() => {
            const state = store.getState();
            const fileMeta = saver.current?.meta() ?? meta;
            void exportFileText(storage, state.doc, fileMeta).then((text) => saveTextToDisk(exportFileName(state.doc.name), text));
          }}
          saveFig={async () => {
            const state = store.getState();
            const out = await exportFigBytes(storage, state.doc);
            downloadBytes(`${safeFileName(state.doc.name)}.fig`, 'application/octet-stream', out.bytes);
            return out.notWritten;
          }}
        />
      )}
    </EditorContext.Provider>
  );
}

/** "Save a copy to disk": as an Evora file, or as a Figma file, with what a Figma file cannot hold said. */
function SaveCopyDialog({ onClose, saveEvora, saveFig }: { onClose: () => void; saveEvora: () => void; saveFig: () => Promise<string[]> }) {
  const [figResult, setFigResult] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog title="Save a copy to disk" onClose={onClose} width={520}>
      <div className="flex flex-col gap-3">
        <div className="flex items-start gap-3">
          <button
            type="button"
            data-autofocus
            className="ev-button flex-none"
            onClick={() => {
              saveEvora();
              onClose();
            }}
          >
            Evora (.evora)
          </button>
          <p className="m-0 text-dim">Everything in the file, exactly. It opens in Evora on any device.</p>
        </div>
        <div className="flex items-start gap-3">
          <button
            type="button"
            className="ev-button flex-none"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void saveFig()
                .then(setFigResult)
                .finally(() => setBusy(false));
            }}
          >
            {busy ? 'Saving…' : 'Figma (.fig)'}
          </button>
          <p className="m-0 text-dim">For opening in Figma. Not yet checked in Figma itself: the format is Figma’s own and unpublished, and what is written follows what can be worked out of its files.</p>
        </div>
        {figResult && (
          <div role="status" aria-label="Figma file saved" className="text-dim">
            <p className="m-0">Saved as a Figma file.{figResult.length > 0 ? ' These parts are not in it:' : ''}</p>
            {figResult.length > 0 && (
              <ul className="m-0 pl-4">
                {figResult.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}

/** The keyboard shortcut reference, generated from the same command table the shortcuts run from. */
function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog title="Keyboard shortcuts" onClose={onClose} width={640}>
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
