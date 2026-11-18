import { PluginsMount } from '../plugins/PluginsMount';
import { VersionsMount } from '../versions/VersionsMount';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CLIPBOARD_MIME, LEGACY_CLIPBOARD_MIME, FileFormatError, cssFor, isLayer, safeFileName, nameFromFile, readSvg, SvgImportError, newExportSetting, type FileMeta, type Point } from '../../core';
import { currentAuth } from '../../collab/account';
import { api, ApiError, errorMessage } from '../../collab/api';
import { filesApi } from '../../collab/files';
import { createLibraryUpdates } from '../../collab/libraries';
import { cloudAssetLoader, loadSharedDocument, openLiveDocument, type LiveDocument } from '../../collab/live';
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
import { LibraryUpdatesContext, LibraryUpdatesNotice, useLibraryUpdateChecks } from './LibraryUpdates';
import { ExportDialog } from '../panels/ExportSection';
import { downloadBytes, exportEnvironment } from './exporting';
import { exportFigBytes } from '../../persistence/fig';
import { exportOne, svgOf } from '../../engine/export/export';
import { Logo } from '../components/Icon';
import { CollabContext } from '../collab/CollabContext';
import { goToThread } from '../collab/CommentsPanel';
import { CollabDialogs, toggleCommentTool } from '../collab/EditorChrome';
import { useAccount, useGuest } from '../collab/hooks';
import { GuestPrompt } from '../collab/Screens';
import { createCollabSession, type CollabSession } from '../collab/session';
import { PanelResizer } from '../components/PanelResizer';
import { RightSidebar } from '../panels/RightSidebar';
import { ComponentsPanel } from '../panels/ComponentSections';
import { LayersPanel } from '../panels/LayersPanel';
import { PagesPanel } from '../panels/PagesPanel';
import { applyTheme } from '../theme';
import { CanvasView } from './CanvasView';
import { EditorContext, type EditorContextValue } from './EditorContext';
import { shortcutGroups } from './menus';
import { useDesktopEditor } from '../desktop/useDesktopEditor';
import { copyPrototypeLink, createPresentGate, planPrototypeLink, presentFrom, presentHash, SHARE_FIRST_REASON, unsentWarning } from '../prototype/links';
import { linkOrigin } from '../../collab/endpoint';
import { FileHeader, ToolDock, ViewControls } from './TopBar';

interface EditorScreenProps {
  storage: DocumentStorage;
  /** The file on this device, or the shared document's ID on the collaboration server. */
  fileId: string;
  onExit: () => void;
  /**
   * Where the document comes from: this device (the default), or the
   * collaboration server (`#/doc/<id>`), where it is edited live with
   * others and is not saved into the files on this device.
   */
  source?: 'local' | 'shared';
  /** For a shared document: a comment thread to open (from a notification). */
  threadId?: string;
  /** For a file on this device: open the Share dialog once it is open (`#/file/<id>/share`, from a prototype asking to be shared). */
  openShare?: boolean;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'missing' }
  | { status: 'error'; message: string }
  | { status: 'ready'; store: EditorStore; meta: FileMeta; repairs: string[] };

/** Loads a file from storage, or a shared document from the collaboration server, and shows the editor for it. */
export function EditorScreen({ storage, fileId, onExit, source = 'local', threadId, openShare }: EditorScreenProps) {
  if (source === 'shared') return <SharedEditorScreen storage={storage} docId={fileId} threadId={threadId} onExit={onExit} />;
  return <LocalEditorScreen storage={storage} fileId={fileId} openShare={openShare} onExit={onExit} />;
}

/** A file on this device. */
function LocalEditorScreen({ storage, fileId, onExit, openShare }: { storage: DocumentStorage; fileId: string; onExit: () => void; openShare?: boolean }) {
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
    return <Editor key={fileId} storage={storage} store={load.store} meta={load.meta} repairs={load.repairs} onExit={onExit} openShare={openShare} />;
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

type SharedLoadState =
  | { status: 'identify' }
  | { status: 'loading' }
  | { status: 'error'; message: string; denied: boolean; trashed: boolean }
  | { status: 'ready'; store: EditorStore; seq: number };

/**
 * Resolves once a shared file's changes made here have reached the server, or after `limit` ms, whichever is first,
 * with how many are still unsent.
 */
function untilSent(session: CollabSession, limit = 2000): Promise<number> {
  return new Promise((resolve) => {
    if (session.store.getState().pending === 0) {
      resolve(0);
      return;
    }
    let stop = (): void => undefined;
    const timer = window.setTimeout(() => {
      stop();
      resolve(session.store.getState().pending);
    }, limit);
    stop = session.store.subscribe((state) => {
      if (state.pending !== 0) return;
      window.clearTimeout(timer);
      stop();
      resolve(0);
    });
  });
}

/**
 * Where a file in the trash can be restored from: the trash of the first of the person's workspaces (where they
 * may restore, that is not a viewer) that holds it. Null when there is none, or for a guest.
 */
async function trashHolding(docId: string): Promise<string | null> {
  if (!currentAuth().token) return null;
  const workspaces = await api.listWorkspaces().catch(() => []);
  for (const workspace of workspaces) {
    if (workspace.role === 'viewer') continue;
    const items = await filesApi.trash(workspace.id).catch(() => []);
    if (items.some((item) => item.id === docId)) return workspace.id;
  }
  return null;
}

/** "This file is in the trash", and, for someone who can restore it, the way to its workspace's trash. */
function TrashedNotice({ docId, message }: { docId: string; message: string }) {
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void trashHolding(docId).then((id) => live && setWorkspaceId(id));
    return () => {
      live = false;
    };
  }, [docId]);
  return (
    <div role="alert" className="flex max-w-md flex-col items-center gap-1.5">
      <p className="m-0 font-semibold text-ink">{message || 'This file is in the trash'}</p>
      <p className="m-0 text-dim">
        {workspaceId ? 'It can be restored from its workspace’s trash for 30 days after it was deleted.' : 'Nobody can open it until someone who can edit its workspace restores it.'}
      </p>
      {workspaceId && (
        <a className="ev-button ev-button-primary mt-1.5 no-underline" href={`#/workspace/${workspaceId}/trash`}>
          Go to the trash
        </a>
      )}
    </div>
  );
}

/**
 * A shared document (`#/doc/<id>`): read from the collaboration server (or,
 * offline, from what this device last held of it), then edited live. Someone
 * with neither an account nor a guest name is first asked for a name.
 */
function SharedEditorScreen({ storage, docId, threadId, onExit }: { storage: DocumentStorage; docId: string; threadId?: string; onExit: () => void }) {
  const account = useAccount();
  const guest = useGuest();
  const identity = account?.token ?? guest?.guestToken ?? null;
  const [load, setLoad] = useState<SharedLoadState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [meta] = useState<FileMeta>(() => ({ createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));

  useEffect(() => {
    if (identity === null) {
      setLoad({ status: 'identify' });
      return;
    }
    let cancelled = false;
    setLoad({ status: 'loading' });
    loadSharedDocument(docId, currentAuth())
      .then(async ({ doc, seq }) => {
        if (cancelled) return;
        await loadFonts([...bundledFonts(), ...fontsUsedBy(doc)]);
        if (cancelled) return;
        resetTextMeasurements();
        const store = createEditorStore(doc, loadSession(docId), { measurer: getBrowserMeasurer() ?? undefined, ...loadPreferences() });
        setLoad({ status: 'ready', store, seq });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const status = error instanceof ApiError ? error.status : (error as { status?: unknown })?.status;
        setLoad({ status: 'error', message: errorMessage(error), denied: status === 401 || status === 403 || status === 404, trashed: status === 410 });
      });
    return () => {
      cancelled = true;
    };
  }, [docId, identity, attempt]);

  if (load.status === 'identify') return <GuestPrompt onReady={() => setAttempt((count) => count + 1)} onBack={onExit} />;
  if (load.status === 'ready') {
    return <Editor key={docId} storage={storage} store={load.store} meta={meta} repairs={[]} onExit={onExit} shared={{ docId, seq: load.seq, threadId }} />;
  }
  return (
    <main className="flex h-full flex-col items-center justify-center gap-4 text-center">
      <Logo size={40} />
      {load.status === 'loading' && <p className="m-0 text-dim">Opening shared file…</p>}
      {load.status === 'error' && load.trashed && <TrashedNotice docId={docId} message={load.message} />}
      {load.status === 'error' && !load.trashed && (
        <div role="alert" className="flex max-w-md flex-col gap-1.5">
          <p className="m-0 text-danger">{load.denied ? 'This file cannot be opened with your account.' : 'The shared file could not be opened.'}</p>
          <p className="m-0 text-dim">{load.message}</p>
          {load.denied && <p className="m-0 text-dim">Ask someone who can share it to invite you, or to open its link to anyone. Sharing is free.</p>}
        </div>
      )}
      {load.status === 'error' && (
        <div className="flex gap-2">
          <button type="button" className="ev-button" onClick={() => setAttempt((count) => count + 1)}>
            Try again
          </button>
          <button type="button" className="ev-button" onClick={onExit}>
            Back to files
          </button>
        </div>
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
  /** Set for a shared document: its ID, the server's sequence number it was read at, and a thread to open. */
  shared?: { docId: string; seq: number; threadId?: string };
  /** Opens the Share dialog, saying a prototype link needs the file shared (`#/file/<id>/share`). */
  openShare?: boolean;
}

function Editor({ storage, store, meta, repairs, onExit, shared, openShare }: EditorProps) {
  const sharedId = shared?.docId ?? null;
  const controller = useRef<InteractionController | null>(null);
  const saver = useRef<Autosaver | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [librariesOpen, setLibrariesOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [saveAsOpen, setSaveAsOpen] = useState(false);
  const [notice, setNotice] = useState<{ title: string; lines: string[] } | null>(
    repairs.length > 0 ? { title: 'This file had problems that were repaired when it was opened.', lines: repairs } : null,
  );
  // The live connection of a shared file, while it is open.
  const liveRef = useRef<LiveDocument | null>(null);
  // The libraries this file uses: newer versions looked for on opening, then every few minutes (on this device and the team's server).
  // A team library's images that reach this device after it was added are sent to a shared file's own copy too.
  const libraryUpdates = useMemo(() => createLibraryUpdates({ editor: store, storage, uploadImages: (hashes) => liveRef.current?.uploadAssets(hashes) }), [store, storage]);
  useLibraryUpdateChecks(libraryUpdates);
  const exit = useRef(onExit);
  exit.current = onExit;
  // A shared document's images are on the collaboration server: those this device does not have are fetched, and kept by hash.
  const images = useMemo(
    () => new ImageCache(sharedId === null ? (hash) => storage.loadAsset(hash) : cloudAssetLoader({ docId: sharedId, auth: currentAuth(), storage })),
    [storage, sharedId],
  );

  // What collaboration knows and does while this file is open: for a shared document, with the live connection.
  const session = useMemo(() => createCollabSession({ docId: sharedId, api, editor: store }), [sharedId, store]);
  // Present on a shared file waits a moment for its changes to be sent; leaving the editor meanwhile calls that off.
  const presentGate = useRef<ReturnType<typeof createPresentGate> | null>(null);
  useEffect(() => {
    const gate = createPresentGate();
    presentGate.current = gate;
    return () => gate.cancel();
  }, []);
  const sharedSeq = shared?.seq ?? 0;
  useEffect(() => {
    if (sharedId === null) return;
    // Given this device's storage, the connection sends the images added here and fetches those others add.
    const live = openLiveDocument({ docId: sharedId, store, auth: currentAuth(), seq: sharedSeq, storage });
    liveRef.current = live;
    const detach = session.attach(live);
    void session.refresh();
    return () => {
      if (liveRef.current === live) liveRef.current = null;
      detach();
      live.close();
    };
  }, [sharedId, sharedSeq, store, session, storage]);
  // Sent here from a prototype to be shared: the Share dialog opens, and the address goes back to the file's own.
  useEffect(() => {
    if (!openShare || sharedId !== null) return;
    session.openShare(SHARE_FIRST_REASON);
    if (/\/share$/.test(window.location.hash)) window.history.replaceState(null, '', window.location.hash.replace(/\/share$/, ''));
  }, [openShare, sharedId, session]);
  // Opened from a notification: once the comments are read, go to the one it is about.
  const threadToOpen = useRef(shared?.threadId ?? null);
  useEffect(() => {
    if (threadToOpen.current === null) return;
    const goWhenRead = (): boolean => {
      const thread = threadToOpen.current ? session.store.getState().threads[threadToOpen.current] : undefined;
      if (!thread || store.getState().canvasSize.width === 0) return false;
      threadToOpen.current = null;
      goToThread(store, session, thread);
      return true;
    };
    if (goWhenRead()) return;
    const stopThreads = session.store.subscribe(() => void goWhenRead());
    const stopEditor = store.subscribe(() => void goWhenRead());
    return () => {
      stopThreads();
      stopEditor();
    };
  }, [session, store]);

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
        const start = startId ?? presentFrom(state);
        if (state.editingTextId !== null) state.commitGesture('Edit text');
        if (sharedId !== null) {
          // A shared file is presented from the server: what was changed here is sent first (for a moment at most),
          // and whatever has not gone is still shown, as the presentation also reads what this device keeps unsent.
          // The presentation holds no connection, so changes still unsent then are warned about first (Present again goes anyway).
          presentGate.current?.start(
            untilSent(session),
            () => {
              window.location.hash = presentHash(sharedId, start);
            },
            (unsent) => setNotice({ title: 'Not all changes are sent yet.', lines: [unsentWarning(unsent)] }),
          );
          return;
        }
        // The viewer reads the file from storage, so it is written first.
        const pending = saver.current?.flush() ?? Promise.resolve();
        void pending.then(() => {
          window.location.hash = `#/proto/${state.doc.id}${start ? `/${start}` : ''}`;
        });
      },
      copyPrototypeLink: (startId) => {
        // A file on this device has no link others could open: it is shared first.
        // Link access is only known once the file's details have loaded (the session's own value starts at 'none'): unknown until then.
        const plan = planPrototypeLink({ sharedId, linkAccess: session.store.getState().info?.linkAccess ?? null, startId: startId ?? presentFrom(store.getState()), origin: linkOrigin() });
        const clipboard = typeof navigator.clipboard?.writeText === 'function' ? navigator.clipboard : null;
        void copyPrototypeLink(plan, {
          writeText: clipboard ? (text) => clipboard.writeText(text) : undefined,
          said: (url, audience, copied) => setNotice({ title: copied ? 'Prototype link copied.' : 'Copy this prototype link:', lines: [url, audience] }),
          shareFirst: (reason) => session.openShare(reason),
        });
      },
      // A shared document is kept on the collaboration server as it changes; there is nothing to save here.
      saveNow: () => void saver.current?.flush(),
      share: () => session.openShare(),
      commentTool: () => toggleCommentTool(session),
      saveAs: () => setSaveAsOpen(true),
      placeImage: () => {
        void pickImageFiles().then((files) => (files.length > 0 ? placeFiles(files) : undefined));
      },
      goHome: () => {
        if (sharedId !== null) {
          // Back to the workspace the shared document is in, when it is one of yours; otherwise to what is shared with you.
          const workspaceId = session.store.getState().info?.workspaceId;
          void api
            .listWorkspaces()
            .then((list) => (list.some((workspace) => workspace.id === workspaceId) ? `#/workspace/${workspaceId}` : '#/shared'))
            .catch(() => '#/')
            .then((hash) => {
              window.location.hash = hash;
            });
          return;
        }
        const pending = saver.current?.flush() ?? Promise.resolve();
        void pending.then(() => exit.current());
      },
    }),
    [store, meta, storage, placeFiles, images, session, sharedId],
  );

  // The desktop app (Phase 10): Save to a file on disk, unsaved-changes and recovery, its menus. Nothing in a browser.
  useDesktopEditor({ store, app, storage, saver, meta, sharedId, placeFiles });

  const context = useMemo<EditorContextValue>(
    () => ({ store, app, controller, storage, images, placeFiles, pickImage }),
    [store, app, storage, images, placeFiles, pickImage],
  );

  // Autosave (for a file on this device; a shared document is not saved into this device's files), and remembering the view, for as long as the file is open.
  useEffect(() => {
    const autosaver = sharedId === null ? createAutosaver(store, storage, meta) : null;
    saver.current = autosaver;
    const docId = sharedId ?? store.getState().doc.id;

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
      void autosaver?.flush();
    };
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') flush();
    };
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      // A shared document asks only while changes made here have not reached the server.
      if (autosaver === null ? session.store.getState().pending === 0 : store.getState().saveStatus === 'saved') return;
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
      void autosaver?.dispose();
      if (saver.current === autosaver) saver.current = null;
    };
  }, [store, storage, meta, sharedId, session]);

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
      <CollabContext.Provider value={session}>
      <LibraryUpdatesContext.Provider value={libraryUpdates}>
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
          <LibraryUpdatesNotice updates={libraryUpdates} className="ev-panel" />
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
      {/* Phase 9: version history and plugins put their panels and dialogs here. */}
      <VersionsMount />
      <PluginsMount />
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
      <CollabDialogs storage={storage} />
      </LibraryUpdatesContext.Provider>
      </CollabContext.Provider>
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
