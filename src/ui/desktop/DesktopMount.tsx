import { useEffect, useRef, useState } from 'react';
import { FigError, FileFormatError } from '../../core';
import { setServerOrigin } from '../../collab/endpoint';
import { getBrowserMeasurer } from '../../engine/text/measure';
import { createFile, importFileText } from '../../persistence/files';
import { desktopBridge, openDiskFile } from '../../persistence/desktop';
import { diskFileKind, type DiskFile, type EvoraDesktop, type NativeEdit } from '../../persistence/desktopContract';
import type { DocumentStorage } from '../../persistence/storage';
import { Dialog } from '../components/Dialog';
import { DesktopSettingsDialog } from './DesktopSettingsDialog';
import { currentDesktopEditor, placeWhenOpened, setDesktopNotifier } from './useDesktopEditor';

/**
 * What the desktop app adds to the window, beside the app itself: files
 * opened from the system (the command line, a double-click, the dock, a
 * second launch, Open Recent, a drop on the window), the native menus, the
 * collaboration server's settings and the team server this computer can
 * host, recovery after a crash. Renders nothing in a browser.
 */
export function DesktopMount({ storage }: { storage: DocumentStorage }) {
  const [bridge] = useState<EvoraDesktop | null>(() => desktopBridge());
  if (!bridge) return null;
  return <DesktopShell bridge={bridge} storage={storage} />;
}

/** Edit commands that act on a text field when one has the keyboard. */
const TEXT_EDITS: Record<string, NativeEdit> = {
  'edit.undo': 'undo',
  'edit.redo': 'redo',
  'edit.cut': 'cut',
  'edit.copy': 'copy',
  'edit.paste': 'paste',
  'edit.selectAll': 'selectAll',
  'edit.delete': 'delete',
};

function typingInField(): boolean {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return false;
  if (active.isContentEditable) return true;
  if (active instanceof HTMLTextAreaElement) return true;
  return active instanceof HTMLInputElement && !['checkbox', 'radio', 'color', 'range', 'button', 'submit'].includes(active.type);
}

function go(hash: string): void {
  if (window.location.hash !== hash) window.location.hash = hash;
}

function DesktopShell({ bridge, storage }: { bridge: EvoraDesktop; storage: DocumentStorage }) {
  const [message, setMessage] = useState<{ title: string; lines: string[] } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const busy = useRef(false);

  useEffect(() => {
    setDesktopNotifier((title, lines = []) => setMessage({ title, lines }));
    void bridge.settings().then((settings) => setServerOrigin(settings.serverUrl));
  }, [bridge]);

  useEffect(() => {
    const open = async (file: DiskFile): Promise<void> => {
      try {
        const opened = await openDiskFile(storage, bridge, file, getBrowserMeasurer() ?? undefined);
        if (opened.svg) placeWhenOpened(opened.id, [opened.svg]);
        go(`#/file/${opened.id}`);
        if (opened.notConverted.length > 0) setMessage({ title: `${file.name} was opened. These parts of it could not be brought over, so they are missing or simplified:`, lines: opened.notConverted });
        else if (opened.repairs.length > 0) setMessage({ title: 'This file had problems that were repaired when it was opened.', lines: opened.repairs });
      } catch (error) {
        const known = error instanceof FileFormatError || error instanceof FigError || (error instanceof Error && error.name === 'UnsupportedFileError');
        setMessage({ title: `${file.name} could not be opened.`, lines: [known ? (error as Error).message : `That did not work. ${error instanceof Error ? error.message : ''}`] });
      }
    };

    const openFromDialog = async (): Promise<void> => {
      if (busy.current) return;
      busy.current = true;
      try {
        const file = await bridge.openDialog();
        if (file) await open(file);
      } catch (error) {
        setMessage({ title: 'The file could not be opened.', lines: [error instanceof Error ? error.message : String(error)] });
      } finally {
        busy.current = false;
      }
    };

    const onMenu = (id: string): void => {
      const editor = currentDesktopEditor();
      switch (id) {
        case 'desktop.open':
          void openFromDialog();
          return;
        case 'desktop.new':
          void createFile(storage).then((file) => go(`#/file/${file.id}`));
          return;
        case 'desktop.save':
        case 'desktop.saveAs':
        case 'desktop.saveFig': {
          if (!editor) {
            setMessage({ title: 'Open a file to save it.', lines: [] });
            return;
          }
          void editor.save(id === 'desktop.save' ? 'save' : id === 'desktop.saveAs' ? 'saveAs' : 'fig');
          return;
        }
        case 'desktop.settings':
          setSettingsOpen(true);
          return;
        case 'desktop.home':
          go('#/');
          return;
      }
      // Undo, copy, paste and the like act on a text field that has the keyboard; paste always goes through the
      // system, which raises the paste event the editor reads layers and images from.
      const native = TEXT_EDITS[id];
      if (native && (typingInField() || id === 'edit.paste' || !editor)) {
        bridge.nativeEdit(native);
        return;
      }
      if (editor) editor.run(id);
      else if (id === 'file.home') go('#/');
    };

    // The shortcuts of the desktop app's own File commands, before the editor's (which would save to the library only).
    const onKeyDown = (event: KeyboardEvent): void => {
      const ctrl = event.ctrlKey || event.metaKey;
      if (!ctrl || event.altKey) return;
      let id: string | null = null;
      if (event.code === 'KeyS') id = event.shiftKey ? 'desktop.saveAs' : 'desktop.save';
      else if (event.code === 'KeyO' && !event.shiftKey) id = 'desktop.open';
      if (id === null) return;
      if (document.querySelector('[role="dialog"]') && id !== 'desktop.save') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onMenu(id);
    };

    // Evora and Figma files dropped on the window are opened; images and SVGs are left to the canvas.
    const opensFile = (event: DragEvent): boolean => {
      const items = [...(event.dataTransfer?.items ?? [])];
      if (items.length === 0) return false;
      const files = [...(event.dataTransfer?.files ?? [])];
      // While dragging the names are not known; any file is let through and decided on drop.
      if (files.length === 0) return items.some((item) => item.kind === 'file');
      return files.some((file) => {
        const kind = diskFileKind(file.name);
        return kind === 'evora' || kind === 'fig' || (kind === 'svg' && currentDesktopEditor() === null);
      });
    };
    const onDragOver = (event: DragEvent): void => {
      if (currentDesktopEditor() !== null) return;
      if (opensFile(event)) event.preventDefault();
    };
    const onDrop = (event: DragEvent): void => {
      const files = [...(event.dataTransfer?.files ?? [])].filter((file) => {
        const kind = diskFileKind(file.name);
        return kind === 'evora' || kind === 'fig' || (kind === 'svg' && currentDesktopEditor() === null);
      });
      if (files.length === 0) {
        // Nothing for the desktop app; outside the editor a drop must not navigate the window to the file.
        if (currentDesktopEditor() === null) event.preventDefault();
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      void (async () => {
        for (const file of files) {
          const disk = await bridge.openDropped(file);
          if (disk) await open(disk);
        }
      })();
    };

    const stops = [
      bridge.onOpenFile((file) => void open(file)),
      bridge.onMenu(onMenu),
      bridge.onPrepareClose(async (action) => {
        const editor = currentDesktopEditor();
        return editor ? editor.prepareClose(action) : true;
      }),
      bridge.onRecover((entry) => {
        void (async () => {
          try {
            if ((await storage.load(entry.fileId)) !== null) {
              go(`#/file/${entry.fileId}`);
              return;
            }
            // The library no longer has it: the copy kept by the desktop app is brought back, still linked to its file.
            const { id } = await importFileText(storage, entry.text);
            await bridge.setLink({ fileId: id, path: entry.path, savedUpdatedAt: '', mtimeMs: 0 });
            await bridge.clearRecovery(entry.fileId);
            go(`#/file/${id}`);
          } catch (error) {
            setMessage({ title: `${entry.name} could not be recovered.`, lines: [error instanceof Error ? error.message : String(error)] });
          }
        })();
      }),
    ];
    // Tells the desktop app this page listens now: files and recoveries waiting for it are sent.
    void bridge.info();
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop, true);
    return () => {
      for (const stop of stops) stop();
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop, true);
    };
  }, [bridge, storage]);

  return (
    <>
      {settingsOpen && <DesktopSettingsDialog bridge={bridge} onClose={() => setSettingsOpen(false)} />}
      {message && (
        <Dialog
          title={message.title}
          onClose={() => setMessage(null)}
          width={520}
          footer={
            <button type="button" data-autofocus className="ev-button ev-button-primary" onClick={() => setMessage(null)}>
              OK
            </button>
          }
        >
          <p className="m-0 mb-2 leading-relaxed text-ink">{message.title}</p>
          {message.lines.length > 0 && (
            <ul className="m-0 flex list-disc flex-col gap-1 pl-5 leading-relaxed text-dim">
              {message.lines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
        </Dialog>
      )}
    </>
  );
}
