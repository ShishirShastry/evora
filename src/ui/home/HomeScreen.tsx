import { useCallback, useEffect, useState } from 'react';
import { FileFormatError } from '../../core';
import { pickTextFile } from '../../persistence/diskIO';
import { createFile, duplicateFile, importFileText, listFiles, renameFile } from '../../persistence/files';
import { clearSession } from '../../persistence/session';
import type { DocumentStorage, FileSummary } from '../../persistence/storage';
import { Dialog } from '../components/Dialog';
import { TextEdit } from '../components/Fields';
import { Icon, Logo } from '../components/Icon';
import { PopupMenu, type MenuItem } from '../components/Menu';

interface HomeScreenProps {
  storage: DocumentStorage;
  onOpen: (id: string) => void;
}

function formatWhen(iso: string, now: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const minutes = Math.round((now - then) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(then).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** The file browser: every design file stored on this device, with create, open, rename, duplicate, import and delete. */
export function HomeScreen({ storage, onOpen }: HomeScreenProps) {
  const [files, setFiles] = useState<FileSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<FileSummary | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setFiles(await listFiles(storage));
    } catch (cause) {
      setFiles([]);
      setError(`Your files could not be read from this device. ${cause instanceof Error ? cause.message : ''}`);
    }
  }, [storage]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** Runs a file operation, reporting a failure instead of losing it. */
  const attempt = async (action: () => Promise<void>): Promise<void> => {
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(
        cause instanceof FileFormatError
          ? cause.message
          : `That did not work. ${cause instanceof Error ? cause.message : ''}`,
      );
    }
  };

  const create = (): Promise<void> =>
    attempt(async () => {
      const file = await createFile(storage);
      onOpen(file.id);
    });

  const importFile = (): Promise<void> =>
    attempt(async () => {
      const text = await pickTextFile();
      if (text === null) return;
      const { id } = await importFileText(storage, text);
      onOpen(id);
    });

  const openMenu = (file: FileSummary, x: number, y: number): void =>
    setMenu({
      x,
      y,
      items: [
        { label: 'Open', onSelect: () => onOpen(file.id) },
        { label: 'Rename', onSelect: () => setRenaming(file.id) },
        {
          label: 'Duplicate',
          onSelect: () =>
            void attempt(async () => {
              await duplicateFile(storage, file.id);
              await refresh();
            }),
        },
        { type: 'separator' },
        { label: 'Delete…', danger: true, onSelect: () => setDeleting(file) },
      ],
    });

  const now = Date.now();

  return (
    <main className="flex h-full flex-col overflow-hidden">
      <header className="flex h-14 flex-none items-center gap-3 border-b border-line bg-panel px-5">
        <Logo size={26} />
        <h1 className="m-0 text-[14px] font-semibold tracking-[0.14em]">OPEN DESIGN</h1>
        <div className="flex-1" />
        <button type="button" className="od-button" onClick={() => void importFile()}>
          Import file…
        </button>
        <button type="button" className="od-button od-button-primary" onClick={() => void create()}>
          New design file
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-6">
        <div className="mx-auto max-w-4xl">
          <h2 className="m-0 mb-3 text-[11px] font-semibold uppercase tracking-wide text-dim">Files on this device</h2>
          {error && (
            <p role="alert" className="mb-3 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-danger">
              {error}
            </p>
          )}
          {files === null && <p className="text-dim">Loading…</p>}
          {files !== null && files.length === 0 && !error && (
            <div className="rounded-xl border border-dashed border-line px-6 py-14 text-center">
              <p className="m-0 mb-1 text-[14px] font-medium">No design files yet</p>
              <p className="m-0 mb-5 text-dim">
                Files are stored on this device and saved automatically while you work. No account is needed.
              </p>
              <button type="button" className="od-button od-button-primary" onClick={() => void create()}>
                Create your first file
              </button>
            </div>
          )}
          {files !== null && files.length > 0 && (
            <ul aria-label="Files" className="m-0 list-none overflow-hidden rounded-xl border border-line p-0">
              {files.map((file) => (
                <li
                  key={file.id}
                  className="group flex h-14 items-center gap-3 border-b border-line bg-panel pl-4 pr-2 last:border-b-0 hover:bg-hover"
                  onContextMenu={(event) => {
                    event.preventDefault();
                    openMenu(file, event.clientX, event.clientY);
                  }}
                >
                  <span className="flex-none text-accent">
                    <Icon name="file" size={18} />
                  </span>
                  {renaming === file.id ? (
                    <div className="min-w-0 flex-1">
                      <TextEdit
                        label="File name"
                        value={file.name}
                        onCancel={() => setRenaming(null)}
                        onCommit={(name) => {
                          setRenaming(null);
                          void attempt(async () => {
                            await renameFile(storage, file.id, name);
                            await refresh();
                          });
                        }}
                      />
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="flex h-full min-w-0 flex-1 cursor-pointer flex-col items-start justify-center border-0 bg-transparent p-0 text-left"
                      aria-label={`Open ${file.name}`}
                      onClick={() => onOpen(file.id)}
                    >
                      <span className="max-w-full truncate text-[13px] font-medium">{file.name}</span>
                      <span className="text-dim">
                        Edited {formatWhen(file.updatedAt, now)} · {file.layerCount} {file.layerCount === 1 ? 'layer' : 'layers'}
                      </span>
                    </button>
                  )}
                  <button
                    type="button"
                    className="od-icon-button"
                    aria-label={`More actions for ${file.name}`}
                    title="More actions"
                    onClick={(event) => {
                      const rect = event.currentTarget.getBoundingClientRect();
                      openMenu(file, rect.right - 200, rect.bottom + 4);
                    }}
                  >
                    <Icon name="more" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {menu && <PopupMenu x={menu.x} y={menu.y} items={menu.items} label="File menu" onClose={() => setMenu(null)} />}
      {deleting && (
        <Dialog
          title="Delete file"
          onClose={() => setDeleting(null)}
          footer={
            <>
              <button type="button" className="od-button" onClick={() => setDeleting(null)}>
                Cancel
              </button>
              <button
                type="button"
                data-autofocus
                className="od-button"
                style={{ borderColor: 'var(--od-danger)', color: 'var(--od-danger)' }}
                onClick={() => {
                  const target = deleting;
                  setDeleting(null);
                  void attempt(async () => {
                    await storage.remove(target.id);
                    clearSession(target.id);
                    await refresh();
                  });
                }}
              >
                Delete file
              </button>
            </>
          }
        >
          <p className="m-0">
            Delete <strong>{deleting.name}</strong> from this device? This cannot be undone. To keep a copy, open the file and
            use “Save a copy to disk” first.
          </p>
        </Dialog>
      )}
    </main>
  );
}
