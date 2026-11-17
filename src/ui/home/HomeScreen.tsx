import { useCallback, useEffect, useState } from 'react';
import { FigError, FileFormatError, FILE_EXTENSION, LEGACY_FILE_EXTENSIONS } from '../../core';
import { pickFile } from '../../persistence/diskIO';
import { importFigBytes, looksLikeFig } from '../../persistence/fig';
import { getBrowserMeasurer } from '../../engine/text/measure';
import { createFile, deleteFile, duplicateFile, importFileText, listFiles, renameFile } from '../../persistence/files';
import { clearSession } from '../../persistence/session';
import type { DocumentStorage, FileSummary } from '../../persistence/storage';
import { Dialog } from '../components/Dialog';
import { TextEdit } from '../components/Fields';
import { Icon, Logo, Wordmark } from '../components/Icon';
import { PopupMenu, type MenuItem } from '../components/Menu';

interface HomeScreenProps {
  storage: DocumentStorage;
  onOpen: (id: string) => void;
}

/** The hues a file's thumbnail is lit with; one is chosen from the file's id, so it stays put when the file is renamed. */
const THUMBNAIL_HUES = [211, 258, 326, 18, 160, 190, 42];

function thumbnailHue(id: string): number {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) hash = (hash * 31 + id.charCodeAt(index)) | 0;
  return THUMBNAIL_HUES[Math.abs(hash) % THUMBNAIL_HUES.length] ?? 211;
}

/** The top of a file's card, for the eye only: the file's initial on a lit key, sitting in a well dotted like a canvas. */
function FileThumbnail({ file }: { file: FileSummary }) {
  const hue = thumbnailHue(file.id);
  const initial = Array.from(file.name.trim())[0]?.toUpperCase() ?? '';
  return (
    <div
      aria-hidden="true"
      className="m-1.5 mb-0 flex aspect-[16/10] items-center justify-center overflow-hidden rounded-[9px] bg-field shadow-[var(--ev-sunk)]"
      style={{
        backgroundImage: `radial-gradient(90% 80% at 50% 115%, hsl(${hue} 90% 58% / 0.26), transparent 70%), radial-gradient(rgba(127, 127, 140, 0.16) 1px, transparent 1.3px)`,
        backgroundSize: '100% 100%, 14px 14px',
        backgroundPosition: 'center, center',
      }}
    >
      <span
        className="flex h-12 w-12 items-center justify-center rounded-[14px] text-[20px] font-semibold text-accent-ink transition-transform duration-200 ease-[var(--ev-ease)] group-hover:-translate-y-0.5 group-hover:scale-105"
        style={{
          background: `linear-gradient(160deg, hsl(${hue} 92% 66%) 0%, hsl(${hue} 80% 47%) 100%)`,
          boxShadow: `inset 0 1px 0 rgba(255, 255, 255, 0.35), 0 0 0 1px hsl(${hue} 70% 28% / 0.45), 0 10px 24px -10px hsl(${hue} 90% 50% / 0.85)`,
        }}
      >
        {initial}
      </span>
    </div>
  );
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
  const [figReport, setFigReport] = useState<{ id: string; name: string; lines: string[] } | null>(null);
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
        cause instanceof FileFormatError || cause instanceof FigError
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

  // An Evora file or a Figma file, told apart by its name and its first bytes.
  const importFile = (): Promise<void> =>
    attempt(async () => {
      const file = await pickFile([FILE_EXTENSION, ...LEGACY_FILE_EXTENSIONS, '.fig', 'application/json'].join(','));
      if (!file) return;
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (looksLikeFig(file.name, bytes)) {
        const { id, notConverted } = await importFigBytes(storage, bytes, file.name, getBrowserMeasurer() ?? undefined);
        await refresh();
        // What the file had that could not be brought over is said before it is opened.
        if (notConverted.length > 0) setFigReport({ id, name: file.name, lines: notConverted });
        else onOpen(id);
        return;
      }
      const { id } = await importFileText(storage, new TextDecoder().decode(bytes));
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
    // Figma's file browser on Framer's ground: a floating bar like the editor's panels, and the files as cards beneath it.
    <main className="flex h-full flex-col gap-1.5 overflow-hidden bg-bg p-1.5">
      <header className="ev-panel flex h-12 flex-none items-center gap-2 pl-3.5 pr-2">
        <h1 className="m-0 flex items-center text-[15px] leading-none">
          <Wordmark size={24} />
        </h1>
        <div className="flex-1" />
        <button type="button" className="ev-button" onClick={() => void importFile()}>
          Import file…
        </button>
        <button type="button" className="ev-button ev-button-primary" onClick={() => void create()}>
          <Icon name="plus" size={14} />
          New design file
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1120px] px-4 pb-12 pt-7 sm:px-8">
          <h2 className="m-0 mb-5 text-[18px] font-semibold tracking-[-0.015em] text-ink">Files on this device</h2>
          {error && (
            <p role="alert" className="m-0 mb-4 rounded-[8px] bg-danger/10 px-3 py-2.5 leading-relaxed text-danger ring-1 ring-danger/30 ring-inset">
              {error}
            </p>
          )}
          {files === null && (
            <p className="m-0 flex items-center gap-2 text-dim">
              <span aria-hidden="true" className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
              Loading…
            </p>
          )}
          {files !== null && files.length === 0 && !error && (
            <div className="mx-auto mt-6 flex max-w-[440px] flex-col items-center rounded-[14px] bg-panel px-8 pb-9 pt-10 text-center shadow-[var(--ev-shadow-panel)]">
              <span aria-hidden="true" className="mb-5 flex h-[72px] w-[72px] items-center justify-center rounded-[20px] bg-field shadow-[var(--ev-sunk)]">
                <Logo size={40} />
              </span>
              <p className="m-0 mb-1.5 text-[15px] font-semibold tracking-[-0.01em] text-ink">No design files yet</p>
              <p className="m-0 mb-6 max-w-[320px] leading-relaxed text-dim">
                Files are stored on this device and saved automatically while you work. No account is needed.
              </p>
              <button type="button" className="ev-button ev-button-primary" onClick={() => void create()}>
                <Icon name="plus" size={14} />
                Create your first file
              </button>
            </div>
          )}
          {files !== null && files.length > 0 && (
            <ul aria-label="Files" className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(212px,1fr))] gap-4 p-0">
              {files.map((file) => (
                <li
                  key={file.id}
                  className="group relative flex flex-col rounded-[12px] bg-panel shadow-[var(--ev-shadow-panel)] transition-[translate,box-shadow] duration-150 ease-[var(--ev-ease)] hover:-translate-y-0.5 hover:shadow-[var(--ev-shadow-pop)]"
                  onContextMenu={(event) => {
                    event.preventDefault();
                    openMenu(file, event.clientX, event.clientY);
                  }}
                >
                  <FileThumbnail file={file} />
                  <div className="flex min-h-[50px] items-center gap-1 py-1.5 pl-3 pr-1.5">
                    {renaming === file.id ? (
                      <div className="min-w-0 flex-1">
                        <TextEdit
                          className="!h-7"
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
                      // The whole card opens the file: the button's ::after stretches over it, and carries its focus ring.
                      <button
                        type="button"
                        className="flex min-w-0 flex-1 cursor-pointer flex-col items-start justify-center gap-0.5 border-0 bg-transparent p-0 text-left after:absolute after:inset-0 after:rounded-[12px] after:transition-shadow after:duration-150 focus-visible:!outline-none focus-visible:after:shadow-[0_0_0_2px_var(--ev-ring)]"
                        aria-label={`Open ${file.name}`}
                        onClick={() => onOpen(file.id)}
                      >
                        <span className="max-w-full truncate text-[12.5px] font-medium text-ink">{file.name}</span>
                        <span className="max-w-full truncate text-[11px] text-dim">
                          Edited {formatWhen(file.updatedAt, now)} · {file.layerCount} {file.layerCount === 1 ? 'layer' : 'layers'}
                        </span>
                      </button>
                    )}
                    <button
                      type="button"
                      className="ev-icon-button relative z-10"
                      aria-label={`More actions for ${file.name}`}
                      title="More actions"
                      onClick={(event) => {
                        const rect = event.currentTarget.getBoundingClientRect();
                        openMenu(file, rect.right - 200, rect.bottom + 4);
                      }}
                    >
                      <Icon name="more" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {menu && <PopupMenu x={menu.x} y={menu.y} items={menu.items} label="File menu" onClose={() => setMenu(null)} />}
      {figReport && (
        <Dialog
          title="Figma file opened"
          onClose={() => setFigReport(null)}
          width={520}
          footer={
            <button
              type="button"
              data-autofocus
              className="ev-button ev-button-primary"
              onClick={() => {
                const { id } = figReport;
                setFigReport(null);
                onOpen(id);
              }}
            >
              Open the file
            </button>
          }
        >
          <p className="m-0 mb-3 leading-relaxed text-dim">
            <strong className="font-semibold text-ink">{figReport.name}</strong> is now a file on this device. These parts of it could not be brought over, so they are missing or simplified:
          </p>
          <ul
            aria-label="Not converted"
            className="m-0 flex list-disc flex-col gap-1 rounded-[8px] bg-field py-2.5 pl-7 pr-3 leading-relaxed text-dim shadow-[var(--ev-sunk)] marker:text-faint"
          >
            {figReport.lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </Dialog>
      )}
      {deleting && (
        <Dialog
          title="Delete file"
          onClose={() => setDeleting(null)}
          footer={
            <>
              <button type="button" className="ev-button" onClick={() => setDeleting(null)}>
                Cancel
              </button>
              <button
                type="button"
                data-autofocus
                className="ev-button ev-button-danger"
                onClick={() => {
                  const target = deleting;
                  setDeleting(null);
                  void attempt(async () => {
                    await deleteFile(storage, target.id);
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
          <p className="m-0 leading-relaxed text-dim">
            Delete <strong className="font-semibold text-ink">{deleting.name}</strong> from this device? This cannot be undone. To keep a copy, open the file and
            use “Save a copy to disk” first.
          </p>
        </Dialog>
      )}
    </main>
  );
}
