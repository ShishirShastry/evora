import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { errorMessage, type EvoraApi } from '../../collab/api';
import { filterFiles, localFavorites, localRecents, setLocalFavorite, sortFiles, type FileInfo, type FilesApi, type Project, type TrashedFile } from '../../collab/files';
import type { Workspace } from '../../collab/protocol';
import { listFiles } from '../../persistence/files';
import type { DocumentStorage, FileSummary } from '../../persistence/storage';
import { Avatar } from '../collab/Avatar';
import { timeAgo } from '../collab/hooks';
import { Dialog } from '../components/Dialog';
import { PopupMenu, type MenuItem } from '../components/Menu';
import { Confirm, ErrorNote, FileTable, FileToolbar, Glyph, useListPrefs, useLocalFileMarks, type FileRow } from './parts';

/**
 * The file browser's pages for advanced file management: Recents,
 * Favorites and search results (files on this device and shared files
 * together), a workspace's trash, and the dialogs to move and rename.
 */

// ------------------------------------------------------------------ cards for mixed lists

const HUES = [211, 258, 326, 18, 160, 190, 42];

function hueOf(id: string): number {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) hash = (hash * 31 + id.charCodeAt(index)) | 0;
  return HUES[Math.abs(hash) % HUES.length] ?? 211;
}

/** Files as cards, as elsewhere in the file browser: for lists that mix files on this device and shared files. */
export function FileCards({ rows, label }: { rows: FileRow[]; label: string }) {
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const now = Date.now();
  return (
    <>
      <ul aria-label={label} className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(212px,1fr))] gap-4 p-0">
        {rows.map((row) => {
          const hue = hueOf(row.id);
          return (
            <li
              key={row.id}
              className="group relative flex flex-col rounded-[12px] bg-panel shadow-[var(--ev-shadow-panel)] transition-[translate,box-shadow] duration-150 ease-[var(--ev-ease)] hover:-translate-y-0.5 hover:shadow-[var(--ev-shadow-pop)]"
              onContextMenu={(event) => {
                event.preventDefault();
                setMenu({ x: event.clientX, y: event.clientY, items: row.menu() });
              }}
            >
              <div
                aria-hidden="true"
                className="relative m-1.5 mb-0 flex aspect-[16/10] items-center justify-center overflow-hidden rounded-[9px] bg-field shadow-[var(--ev-sunk)]"
                style={{
                  backgroundImage: `radial-gradient(90% 80% at 50% 115%, hsl(${hue} 90% 58% / 0.26), transparent 70%), radial-gradient(rgba(127, 127, 140, 0.16) 1px, transparent 1.3px)`,
                  backgroundSize: '100% 100%, 14px 14px',
                }}
              >
                <span
                  className="flex h-12 w-12 items-center justify-center rounded-[14px] text-[20px] font-semibold text-accent-ink"
                  style={{ background: `linear-gradient(160deg, hsl(${hue} 92% 66%) 0%, hsl(${hue} 80% 47%) 100%)` }}
                >
                  {Array.from(row.name.trim())[0]?.toUpperCase() ?? ''}
                </span>
                {row.favorite && (
                  <span className="absolute left-2 top-2 text-[#ffc21a]">
                    <Glyph name="starFilled" size={14} />
                  </span>
                )}
                <span className="absolute bottom-2 right-2 flex items-center gap-1 rounded-full bg-elevated/90 px-1.5 py-0.5 text-[10.5px] text-dim shadow-[var(--ev-raise)]">
                  <Glyph name={row.shared ? 'globe' : 'folder'} size={11} />
                  {row.shared ? 'Shared' : 'This device'}
                </span>
              </div>
              <div className="flex min-h-[50px] items-center gap-1 py-1.5 pl-3 pr-1.5">
                <button
                  type="button"
                  className="flex min-w-0 flex-1 cursor-pointer flex-col items-start justify-center gap-0.5 border-0 bg-transparent p-0 text-left after:absolute after:inset-0 after:rounded-[12px] focus-visible:!outline-none focus-visible:after:shadow-[0_0_0_2px_var(--ev-ring)]"
                  aria-label={`Open ${row.name}`}
                  onClick={row.onOpen}
                >
                  <span className="max-w-full truncate text-[12.5px] font-medium text-ink">{row.name}</span>
                  <span className="max-w-full truncate text-[11px] text-dim">
                    {row.location} · Edited {timeAgo(row.updatedAt, now)}
                  </span>
                </button>
                <button
                  type="button"
                  className="ev-icon-button relative z-10"
                  aria-label={`More actions for ${row.name}`}
                  onClick={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    setMenu({ x: rect.right - 200, y: rect.bottom + 4, items: row.menu() });
                  }}
                >
                  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                    <circle cx="4" cy="8" r="1.1" fill="currentColor" />
                    <circle cx="8" cy="8" r="1.1" fill="currentColor" />
                    <circle cx="12" cy="8" r="1.1" fill="currentColor" />
                  </svg>
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      {menu && <PopupMenu x={menu.x} y={menu.y} items={menu.items} label="File menu" onClose={() => setMenu(null)} />}
    </>
  );
}

/** Where a shared file is, in words: its workspace and project. */
export function locationOf(file: FileInfo): string {
  const workspace = file.workspaceName ?? 'Shared with you';
  return file.projectName ? `${workspace} / ${file.projectName}` : workspace;
}

// ------------------------------------------------------------------ recents, favourites, search

export type QuickKind = 'recents' | 'favorites' | 'search';

interface QuickPageProps {
  kind: QuickKind;
  /** For search: what is looked for. */
  query?: string;
  storage: DocumentStorage;
  files: FilesApi;
  signedIn: boolean;
  onOpenLocal: (id: string) => void;
  onOpenDoc: (doc: FileInfo) => void;
}

const QUICK_TITLES: Record<QuickKind, string> = { recents: 'Recents', favorites: 'Favorites', search: 'Search' };

/**
 * Recents, Favorites, or search results: the files on this device and, signed
 * in, the shared files, together. Recents keep the order they were opened in.
 */
export function QuickPage({ kind, query = '', storage, files, signedIn, onOpenLocal, onOpenDoc }: QuickPageProps) {
  const marks = useLocalFileMarks();
  const [local, setLocal] = useState<FileSummary[] | null>(null);
  const [shared, setShared] = useState<FileInfo[] | null>(signedIn ? null : []);
  const [error, setError] = useState<string | null>(null);
  const [prefs, setPrefs] = useListPrefs();

  useEffect(() => {
    void listFiles(storage)
      .then(setLocal)
      .catch(() => setLocal([]));
  }, [storage]);

  const loadShared = useCallback(() => {
    if (!signedIn) {
      setShared([]);
      return;
    }
    const request = kind === 'recents' ? files.recents() : kind === 'favorites' ? files.favorites() : query.trim() ? files.search(query) : Promise.resolve([]);
    request
      .then((list) => {
        setShared(list);
        setError(null);
      })
      .catch((cause: unknown) => {
        setShared([]);
        setError(errorMessage(cause));
      });
  }, [files, kind, query, signedIn]);
  useEffect(loadShared, [loadShared]);

  const localRow = (file: FileSummary, openedAt?: string): FileRow & { at: string } => {
    const favorite = marks.favorites.includes(file.id);
    return {
      id: `local:${file.id}`,
      name: file.name,
      location: 'This device',
      updatedAt: file.updatedAt,
      createdAt: file.createdAt,
      favorite,
      shared: false,
      at: openedAt ?? file.updatedAt,
      onOpen: () => onOpenLocal(file.id),
      menu: () => [
        { label: 'Open', onSelect: () => onOpenLocal(file.id) },
        { label: favorite ? 'Remove from favorites' : 'Add to favorites', onSelect: () => setLocalFavorite(file.id, !favorite) },
      ],
    };
  };
  const sharedRow = (file: FileInfo): FileRow & { at: string } => ({
    id: `doc:${file.id}`,
    name: file.name,
    location: locationOf(file),
    owner: file.owner.name,
    updatedAt: file.updatedAt,
    createdAt: file.createdAt,
    favorite: file.favorite,
    shared: true,
    at: file.openedAt ?? file.updatedAt,
    onOpen: () => onOpenDoc(file),
    menu: () => [
      { label: 'Open', onSelect: () => onOpenDoc(file) },
      {
        label: file.favorite ? 'Remove from favorites' : 'Add to favorites',
        onSelect: () =>
          void files
            .setFavorite(file.id, !file.favorite)
            .then(loadShared)
            .catch((cause: unknown) => setError(errorMessage(cause))),
      },
    ],
  });

  let rows: (FileRow & { at: string })[] = [];
  if (local && shared) {
    const byId = new Map(local.map((file) => [file.id, file]));
    if (kind === 'recents') {
      const opened = localRecents();
      rows = [...opened.flatMap((entry) => (byId.has(entry.id) ? [localRow(byId.get(entry.id) as FileSummary, entry.openedAt)] : [])), ...shared.map(sharedRow)];
      rows.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    } else if (kind === 'favorites') {
      rows = [...localFavorites().flatMap((id) => (byId.has(id) ? [localRow(byId.get(id) as FileSummary)] : [])), ...shared.map(sharedRow)];
      rows = sortFiles(rows, prefs.sort);
    } else {
      rows = [...filterFiles(local, query).map((file) => localRow(file)), ...shared.map(sharedRow)];
      rows = sortFiles(rows, prefs.sort);
    }
    rows = filterFiles(rows, prefs.filter);
  }

  const title = kind === 'search' ? `Results for “${query}”` : QUICK_TITLES[kind];
  const empty =
    kind === 'recents'
      ? 'Files you open appear here.'
      : kind === 'favorites'
        ? 'Add files to your favorites from their menu, and they appear here.'
        : 'No files have that in their name.';

  return (
    <>
      <h2 className="m-0 mb-5 text-[18px] font-semibold tracking-[-0.015em] text-ink">{title}</h2>
      {error && <ErrorNote>{error}</ErrorNote>}
      {(local === null || shared === null) && <p className="m-0 text-dim">Loading…</p>}
      {local !== null && shared !== null && (
        <>
          <FileToolbar prefs={prefs} onChange={setPrefs} />
          {rows.length === 0 ? (
            <p className="m-0 rounded-[12px] bg-panel px-6 py-8 text-center leading-relaxed text-dim shadow-[var(--ev-shadow-panel)]">{empty}</p>
          ) : prefs.view === 'list' ? (
            <FileTable rows={rows} label={QUICK_TITLES[kind]} />
          ) : (
            <FileCards rows={rows} label={QUICK_TITLES[kind]} />
          )}
        </>
      )}
    </>
  );
}

// ------------------------------------------------------------------ the trash

interface TrashPageProps {
  files: FilesApi;
  workspace: Workspace;
  /** Something was restored: lists elsewhere read again. */
  onChanged: () => void;
}

/** A workspace's trash: files deleted lately, to restore or delete for good; each goes by itself after 30 days. */
export function TrashPage({ files, workspace, onChanged }: TrashPageProps) {
  const [items, setItems] = useState<TrashedFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<TrashedFile | null>(null);
  const canRestore = workspace.role !== 'viewer';
  const load = useCallback(() => {
    files
      .trash(workspace.id)
      .then((list) => {
        setItems(list);
        setError(null);
      })
      .catch((cause: unknown) => setError(errorMessage(cause)));
  }, [files, workspace.id]);
  useEffect(load, [load]);
  const now = Date.now();
  return (
    <>
      <h2 className="m-0 mb-1 text-[18px] font-semibold tracking-[-0.015em] text-ink">Trash</h2>
      <p className="m-0 mb-5 text-dim">Files deleted from {workspace.name}. Nobody can open them until they are restored; each is deleted for good 30 days after it was deleted.</p>
      {error && <ErrorNote>{error}</ErrorNote>}
      {items === null && !error && <p className="m-0 text-dim">Loading…</p>}
      {items !== null && items.length === 0 && <p className="m-0 rounded-[12px] bg-panel px-6 py-8 text-center text-dim shadow-[var(--ev-shadow-panel)]">The trash is empty.</p>}
      {items !== null && items.length > 0 && (
        <ul aria-label="Deleted files" className="m-0 flex list-none flex-col overflow-hidden rounded-[12px] bg-panel p-0 shadow-[var(--ev-shadow-panel)]">
          {items.map((item) => (
            <li key={item.id} className="flex items-center gap-3 border-b border-line/60 px-3 py-2 last:border-b-0">
              <Avatar name={item.owner.name} color={item.owner.color} size={22} />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[12.5px] font-medium text-ink">{item.name}</span>
                <span className="truncate text-[11px] text-dim">
                  Deleted by {item.trashedBy.name} {timeAgo(item.trashedAt, now)} · gone for good in {Math.max(0, Math.ceil((Date.parse(item.purgeAt) - now) / 86_400_000))} days
                </span>
              </div>
              {canRestore && (
                <button
                  type="button"
                  className="ev-button !h-7"
                  aria-label={`Restore ${item.name}`}
                  onClick={() =>
                    void files
                      .restoreFile(item.id)
                      .then(() => {
                        load();
                        onChanged();
                      })
                      .catch((cause: unknown) => setError(errorMessage(cause)))
                  }
                >
                  <Glyph name="restore" size={14} />
                  Restore
                </button>
              )}
              {item.canDelete && (
                <button type="button" className="ev-button !h-7 text-danger" aria-label={`Delete ${item.name} forever`} onClick={() => setDeleting(item)}>
                  Delete forever…
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {deleting && (
        <Confirm
          title="Delete forever"
          action="Delete forever"
          onClose={() => setDeleting(null)}
          onConfirm={() =>
            void files
              .deleteForever(deleting.id)
              .then(load)
              .catch((cause: unknown) => setError(errorMessage(cause)))
          }
        >
          Delete <strong className="font-semibold text-ink">{deleting.name}</strong> for good, with its comments and images? This cannot be undone.
        </Confirm>
      )}
    </>
  );
}

// ------------------------------------------------------------------ moving and renaming

interface MoveDialogProps {
  api: EvoraApi;
  files: FilesApi;
  file: { id: string; name: string; workspaceId: string; projectId: string | null };
  onClose: () => void;
  onMoved: (moved: FileInfo) => void;
}

/** Moving a shared file to another project, or to another workspace where you can edit. */
export function MoveDialog({ api, files, file, onClose, onMoved }: MoveDialogProps) {
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [workspaceId, setWorkspaceId] = useState(file.workspaceId);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState(file.projectId ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const first = useRef(true);

  useEffect(() => {
    api
      .listWorkspaces()
      .then((list) => setWorkspaces(list.filter((workspace) => workspace.role !== 'viewer')))
      .catch((cause: unknown) => setError(errorMessage(cause)));
  }, [api]);

  useEffect(() => {
    if (!first.current) setProjectId('');
    first.current = false;
    files
      .projects(workspaceId)
      .then(setProjects)
      .catch(() => setProjects([]));
  }, [files, workspaceId]);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    void files
      .moveFile(file.id, { workspaceId, projectId: projectId || null })
      .then((moved) => {
        onMoved(moved);
        onClose();
      })
      .catch((cause: unknown) => {
        setError(errorMessage(cause));
        setBusy(false);
      });
  };

  return (
    <Dialog title={`Move “${file.name}”`} onClose={onClose} width={400}>
      <form className="flex flex-col gap-3" onSubmit={submit}>
        <label className="flex flex-col gap-1">
          <span className="text-dim">Workspace</span>
          <select className="ev-field" value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)}>
            {!workspaces?.some((workspace) => workspace.id === file.workspaceId) && <option value={file.workspaceId}>Its current workspace</option>}
            {workspaces?.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-dim">Project</span>
          <select className="ev-field" value={projectId} onChange={(event) => setProjectId(event.target.value)}>
            <option value="">No project (workspace root)</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
        {workspaceId !== file.workspaceId && <p className="m-0 text-[11.5px] text-dim">Members of the new workspace will have access; members of its current one will lose the access the workspace gave them.</p>}
        {error && (
          <p role="alert" className="m-0 text-danger">
            {error}
          </p>
        )}
        <button type="submit" className="ev-button ev-button-primary" disabled={busy}>
          Move
        </button>
      </form>
    </Dialog>
  );
}

/** Naming something in a dialog: a new project, a project renamed. */
export function NameDialog({ title, label, initial = '', action, onClose, onSubmit }: { title: string; label: string; initial?: string; action: string; onClose: () => void; onSubmit: (name: string) => Promise<void> }) {
  const [name, setName] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!name.trim()) return;
    void onSubmit(name.trim())
      .then(onClose)
      .catch((cause: unknown) => setError(errorMessage(cause)));
  };
  return (
    <Dialog title={title} onClose={onClose} width={380}>
      <form className="flex flex-col gap-3" onSubmit={submit}>
        <label className="flex flex-col gap-1">
          <span className="text-dim">{label}</span>
          <input data-autofocus className="ev-field" value={name} maxLength={100} onChange={(event) => setName(event.target.value)} />
        </label>
        {error && (
          <p role="alert" className="m-0 text-danger">
            {error}
          </p>
        )}
        <button type="submit" className="ev-button ev-button-primary" disabled={!name.trim()}>
          {action}
        </button>
      </form>
    </Dialog>
  );
}
