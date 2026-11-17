import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { clearAccount } from '../../collab/account';
import { ApiError, documentLink, errorMessage, inviteLink, type EvoraApi, type MembersResult } from '../../collab/api';
import { filesApi as defaultFiles, filterFiles, sortFiles, type FileInfo, type FilesApi, type Project } from '../../collab/files';
import type { DocInfo, Role, Workspace } from '../../collab/protocol';
import { PublishDialog } from '../community/PublishDialog';
import { Dialog } from '../components/Dialog';
import { Icon } from '../components/Icon';
import { PopupMenu, type MenuItem } from '../components/Menu';
import { locationOf, MoveDialog, NameDialog } from '../files/FilePages';
import { FileTable, FileToolbar, Glyph, useFilesStore, useListPrefs } from '../files/parts';
import { useFocusSoon } from './AccountDialog';
import { DocGrid } from './DocCard';
import { copyText, FREE_NOTE, ROLE_LABELS } from './hooks';
import { InviteForm, MembersList, RoleSelect } from './Members';
import { newSharedDocument } from './upload';

/**
 * What the file browser shows: the files on this device, a workspace's shared
 * files (or one project's), the files shared with you, your recent or
 * favourite files, or a workspace's trash.
 */
export type HomeView =
  | { kind: 'local' }
  | { kind: 'workspace'; id: string; projectId?: string }
  | { kind: 'shared' }
  | { kind: 'recents' }
  | { kind: 'favorites' }
  | { kind: 'trash'; id: string };

export function homeViewHash(view: HomeView): string {
  switch (view.kind) {
    case 'workspace':
      return view.projectId ? `#/workspace/${view.id}/project/${view.projectId}` : `#/workspace/${view.id}`;
    case 'trash':
      return `#/workspace/${view.id}/trash`;
    case 'shared':
      return '#/shared';
    case 'recents':
      return '#/recents';
    case 'favorites':
      return '#/favorites';
    default:
      return '#/';
  }
}

/** The workspaces of the signed-in person, read from the server, with a way to read them again. */
export function useWorkspaces(api: EvoraApi, signedIn: boolean): { workspaces: Workspace[] | null; error: string | null; reload: () => void } {
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    if (!signedIn) {
      setWorkspaces(null);
      return;
    }
    api
      .listWorkspaces()
      .then((list) => {
        setWorkspaces(list);
        setError(null);
      })
      .catch((cause: unknown) => {
        // A session the server no longer knows (it ended, or the server's data was reset): signed out here too.
        if (cause instanceof ApiError && cause.status === 401) clearAccount();
        else setError(errorMessage(cause));
      });
  }, [api, signedIn]);
  useEffect(reload, [reload]);
  return { workspaces, error, reload };
}

interface HomeRailProps {
  view: HomeView;
  onView: (view: HomeView) => void;
  workspaces: Workspace[] | null;
  error: string | null;
  onNewWorkspace: () => void;
  /** Goes to the Community. */
  onCommunity?: () => void;
  files?: FilesApi;
}

/** The projects of a workspace, read again whenever something in the file browser changes. */
export function useProjects(files: FilesApi, workspaceId: string | null): Project[] {
  const version = useFilesStore((state) => state.version);
  const [projects, setProjects] = useState<Project[]>([]);
  useEffect(() => {
    if (!workspaceId) {
      setProjects([]);
      return undefined;
    }
    let current = true;
    files
      .projects(workspaceId)
      .then((list) => current && setProjects(list))
      .catch(() => current && setProjects([]));
    return () => {
      current = false;
    };
  }, [files, workspaceId, version]);
  return projects;
}

/**
 * The file browser's left rail while signed in, as Figma's: Recents and
 * Favorites, this device, files shared with you, the Community, then each
 * workspace; the open workspace shows its projects and its trash.
 */
export function HomeRail({ view, onView, workspaces, error, onNewWorkspace, onCommunity, files = defaultFiles }: HomeRailProps) {
  const openId = view.kind === 'workspace' || view.kind === 'trash' ? view.id : null;
  const projects = useProjects(files, openId);
  const row = 'ev-row flex h-8 w-full items-center gap-2 rounded-[8px] border-0 px-2 text-left';
  const item = (selected: boolean, label: string, icon: ReactNode, onClick: () => void, detail?: string, key?: string, indent = false) => (
    <button
      key={key}
      type="button"
      aria-current={selected ? 'page' : undefined}
      className={`${row} ${indent ? '!h-7 pl-7 text-[12px]' : ''} ${selected ? 'bg-selected text-ink' : 'bg-transparent text-dim hover:bg-hover hover:text-ink'}`}
      onClick={onClick}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {detail && <span className="flex-none text-[10.5px] text-faint">{detail}</span>}
    </button>
  );
  return (
    <nav aria-label="Workspaces" className="ev-panel flex w-[232px] flex-none flex-col gap-0.5 overflow-y-auto p-2">
      {item(view.kind === 'recents', 'Recents', <Glyph name="clock" size={15} />, () => onView({ kind: 'recents' }))}
      {item(view.kind === 'favorites', 'Favorites', <Icon name="star" size={15} />, () => onView({ kind: 'favorites' }))}
      {item(view.kind === 'local', 'Files on this device', <Icon name="device" size={15} />, () => onView({ kind: 'local' }))}
      {item(view.kind === 'shared', 'Shared with me', <Icon name="users" size={15} />, () => onView({ kind: 'shared' }))}
      {onCommunity && item(false, 'Community', <Glyph name="globe" size={15} />, onCommunity)}
      <h2 className="m-0 mt-3 px-2 pb-1 text-[11px] font-semibold text-dim">Workspaces</h2>
      {error && (
        <p role="alert" className="m-0 px-2 text-[11px] text-danger">
          {error}
        </p>
      )}
      {workspaces?.map((workspace) => {
        const open = openId === workspace.id;
        return [
          item(
            view.kind === 'workspace' && view.id === workspace.id && !view.projectId,
            workspace.name,
            <Icon name="file" size={15} />,
            () => onView({ kind: 'workspace', id: workspace.id }),
            `${workspace.memberCount} ${workspace.memberCount === 1 ? 'member' : 'members'}`,
            workspace.id,
          ),
          ...(open
            ? [
                ...projects.map((project) =>
                  item(
                    view.kind === 'workspace' && view.projectId === project.id,
                    project.name,
                    <Glyph name="folder" size={14} />,
                    () => onView({ kind: 'workspace', id: workspace.id, projectId: project.id }),
                    String(project.fileCount),
                    `${workspace.id}:${project.id}`,
                    true,
                  ),
                ),
                item(view.kind === 'trash', 'Trash', <Icon name="trash" size={14} />, () => onView({ kind: 'trash', id: workspace.id }), undefined, `${workspace.id}:trash`, true),
              ]
            : []),
        ];
      })}
      <button type="button" className={`${row} bg-transparent text-dim hover:bg-hover hover:text-ink`} onClick={onNewWorkspace}>
        <Icon name="plus" size={15} />
        New workspace
      </button>
      <div className="flex-1" />
      <p className="m-0 px-2 pt-3 text-[11px] leading-relaxed text-faint">{FREE_NOTE}. Unlimited workspaces and files.</p>
    </nav>
  );
}

/** Naming a new workspace. */
export function NewWorkspaceDialog({ api, onClose, onCreated }: { api: EvoraApi; onClose: () => void; onCreated: (workspace: Workspace) => void }) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  useFocusSoon(field, null);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!name.trim()) return;
    void api
      .createWorkspace(name.trim())
      .then((workspace) => {
        onCreated(workspace);
        onClose();
      })
      .catch((cause: unknown) => setError(errorMessage(cause)));
  };
  return (
    <Dialog title="New workspace" onClose={onClose} width={380}>
      <form className="flex flex-col gap-3" onSubmit={submit}>
        <label className="flex flex-col gap-1">
          <span className="text-dim">Name</span>
          <input ref={field} className="ev-field" value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        {error && (
          <p role="alert" className="m-0 text-danger">
            {error}
          </p>
        )}
        <button type="submit" className="ev-button ev-button-primary" disabled={!name.trim()}>
          Create workspace
        </button>
        <p className="m-0 text-center text-[11px] text-dim">Invite as many people as you like: every seat is free.</p>
      </form>
    </Dialog>
  );
}

interface DocActionsOptions {
  api: EvoraApi;
  files: FilesApi;
  /** Whether the person can add files to the file's own workspace (a duplicate goes there; otherwise to their first workspace). */
  canAddHere: boolean;
  onOpen: (doc: DocInfo) => void;
  /** Something changed: the list reads again. */
  onChanged: () => void;
  onError: (message: string) => void;
  onNavigate?: (hash: string) => void;
}

/**
 * What can be done to a shared file from the file browser, and the dialogs
 * that go with it: open, copy its link, rename, duplicate, move, favourite,
 * publish to the Community, delete (to the trash).
 */
function useDocActions({ api, files, canAddHere, onOpen, onChanged, onError, onNavigate }: DocActionsOptions) {
  const bump = useFilesStore((state) => state.bump);
  const [deleting, setDeleting] = useState<DocInfo | null>(null);
  const [moving, setMoving] = useState<FileInfo | null>(null);
  const [publishing, setPublishing] = useState<DocInfo | null>(null);
  const [renaming, setRenaming] = useState<DocInfo | null>(null);
  const changed = (): void => {
    onChanged();
    bump();
  };
  const fail = (cause: unknown): void => onError(errorMessage(cause));

  const duplicate = async (doc: DocInfo): Promise<void> => {
    if (canAddHere) {
      await files.duplicateFile(doc.id);
      return;
    }
    const target = (await api.listWorkspaces()).find((workspace) => workspace.role !== 'viewer');
    if (!target) throw new Error('You cannot add files to any workspace. Make a workspace of your own first.');
    await files.duplicateFile(doc.id, { workspaceId: target.id });
  };

  const menuFor = (doc: DocInfo, rename: (() => void) | null): MenuItem[] => {
    const info = doc as Partial<FileInfo> & DocInfo;
    const editor = doc.role === 'owner' || doc.role === 'editor';
    const favorite = info.favorite === true;
    const items: MenuItem[] = [
      { label: 'Open', onSelect: () => onOpen(doc) },
      { label: 'Copy link', onSelect: () => void copyText(documentLink(doc.id)) },
    ];
    if (editor) items.push({ label: 'Rename', onSelect: rename ?? (() => setRenaming(doc)) });
    items.push({ label: 'Duplicate', onSelect: () => void duplicate(doc).then(changed).catch(fail) });
    if (editor) items.push({ label: 'Move to…', onSelect: () => setMoving({ projectId: null, ...info } as FileInfo) });
    items.push({
      label: favorite ? 'Remove from favorites' : 'Add to favorites',
      onSelect: () => void files.setFavorite(doc.id, !favorite).then(changed).catch(fail),
    });
    if (editor) items.push({ label: 'Publish to Community…', onSelect: () => setPublishing(doc) });
    if (doc.role === 'owner') {
      items.push({ type: 'separator' });
      items.push({ label: 'Delete…', danger: true, onSelect: () => setDeleting(doc) });
    }
    return items;
  };

  const dialogs = (
    <>
      {deleting && (
        <ConfirmDialog
          title="Delete shared file"
          action="Delete file"
          onClose={() => setDeleting(null)}
          onConfirm={() => void files.trashFile(deleting.id).then(changed).catch(fail)}
        >
          Move <strong className="font-semibold text-ink">{deleting.name}</strong> to its workspace’s trash? Nobody can open it there; it can be restored for 30 days.
        </ConfirmDialog>
      )}
      {moving && <MoveDialog api={api} files={files} file={moving} onClose={() => setMoving(null)} onMoved={changed} />}
      {publishing && <PublishDialog source={{ kind: 'shared', docId: publishing.id, name: publishing.name }} storage={null} api={api} onClose={() => setPublishing(null)} onNavigate={onNavigate ?? ((hash) => void (window.location.hash = hash))} />}
      {renaming && (
        <NameDialog
          title="Rename file"
          label="Name"
          initial={renaming.name}
          action="Rename"
          onClose={() => setRenaming(null)}
          onSubmit={async (name) => {
            await api.updateDocument(renaming.id, { name });
            changed();
          }}
        />
      )}
    </>
  );

  return { menuFor, dialogs };
}

/** Shared files as grid cards or list rows, filtered and sorted as the toolbar says. */
function SharedFiles({
  label,
  docs,
  onOpen,
  menuFor,
  onRename,
  showLocation,
  toolbar,
}: {
  label: string;
  docs: FileInfo[];
  onOpen: (doc: DocInfo) => void;
  menuFor: (doc: DocInfo, rename: (() => void) | null) => MenuItem[];
  onRename: (doc: DocInfo, name: string) => void;
  showLocation: boolean;
  toolbar?: ReactNode;
}) {
  const [prefs, setPrefs] = useListPrefs();
  const shown = sortFiles(filterFiles(docs, prefs.filter), prefs.sort);
  return (
    <>
      <FileToolbar prefs={prefs} onChange={setPrefs}>
        {toolbar}
      </FileToolbar>
      {shown.length === 0 ? (
        <p className="m-0 text-dim">No files match “{prefs.filter}”.</p>
      ) : prefs.view === 'list' ? (
        <FileTable
          label={label}
          rows={shown.map((doc) => ({
            id: doc.id,
            name: doc.name,
            location: showLocation ? locationOf(doc) : (doc.projectName ?? doc.owner.name),
            owner: doc.owner.name,
            updatedAt: doc.updatedAt,
            createdAt: doc.createdAt,
            favorite: doc.favorite,
            shared: true,
            onOpen: () => onOpen(doc),
            menu: () => menuFor(doc, null),
          }))}
        />
      ) : (
        <DocGrid label={label} docs={shown} onOpen={onOpen} menuFor={(doc, rename) => menuFor(doc, rename)} onRename={onRename} />
      )}
    </>
  );
}

interface WorkspacePageProps {
  api: EvoraApi;
  workspace: Workspace;
  meId: string | null;
  onOpenDoc: (doc: DocInfo) => void;
  /** The workspace changed (renamed, members): the rail reads the list again. */
  onChanged: () => void;
  /** The workspace was deleted, or left. */
  onGone: () => void;
  /** The project shown, or none for all the workspace's files. */
  projectId?: string;
  files?: FilesApi;
  onNavigate?: (hash: string) => void;
}

/**
 * One workspace: its shared files (all of them, or one project's) as cards or
 * rows, "New shared file", projects, its members, and renaming, deleting or
 * leaving it.
 */
export function WorkspacePage({ api, workspace, meId, onOpenDoc, onChanged, onGone, projectId, files = defaultFiles, onNavigate }: WorkspacePageProps) {
  const [docs, setDocs] = useState<FileInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [membersOpen, setMembersOpen] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [creating, setCreating] = useState(false);
  const [deletingWorkspace, setDeletingWorkspace] = useState(false);
  const [projectDialog, setProjectDialog] = useState<'new' | 'rename' | 'delete' | null>(null);
  const version = useFilesStore((state) => state.version);
  const bump = useFilesStore((state) => state.bump);
  const projects = useProjects(files, workspace.id);
  const project = projectId ? projects.find((candidate) => candidate.id === projectId) : undefined;
  const go = onNavigate ?? ((hash: string) => void (window.location.hash = hash));

  const load = useCallback(() => {
    files
      .workspaceFiles(workspace.id)
      .then((list) => {
        setDocs([...list].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)));
        setError(null);
      })
      .catch((cause: unknown) => setError(errorMessage(cause)));
  }, [files, workspace.id]);
  useEffect(load, [load, version]);

  const canAdd = workspace.role !== 'viewer';
  const actions = useDocActions({ api, files, canAddHere: canAdd, onOpen: onOpenDoc, onChanged: load, onError: setError, onNavigate });
  const create = (): void => {
    setCreating(true);
    void newSharedDocument(api, workspace.id)
      .then(async (id) => {
        if (projectId) await files.moveFile(id, { projectId });
        onOpenDoc({ id } as DocInfo);
      })
      .catch((cause: unknown) => setError(errorMessage(cause)))
      .finally(() => setCreating(false));
  };

  const projectItems: MenuItem[] =
    canAdd && project
      ? [
          { label: 'Rename project…', onSelect: () => setProjectDialog('rename') },
          { label: 'Delete project…', danger: true, onSelect: () => setProjectDialog('delete') },
          { type: 'separator' },
        ]
      : [];
  const workspaceMenu: MenuItem[] = [
    ...projectItems,
    ...(canAdd ? ([{ label: 'New project…', onSelect: () => setProjectDialog('new') }, { type: 'separator' }] as MenuItem[]) : []),
    ...(workspace.role === 'owner'
      ? ([
          { label: 'Rename workspace', onSelect: () => setRenaming(true) },
          { type: 'separator' },
          { label: 'Delete workspace…', danger: true, onSelect: () => setDeletingWorkspace(true) },
        ] as MenuItem[])
      : ([
          {
            label: 'Leave workspace',
            danger: true,
            onSelect: () => {
              if (!meId) return;
              void api
                .removeWorkspaceMember(workspace.id, meId)
                .then(onGone)
                .catch((cause: unknown) => setError(errorMessage(cause)));
            },
          },
        ] as MenuItem[])),
  ];

  const shown = docs?.filter((doc) => !projectId || doc.projectId === projectId) ?? null;

  return (
    <>
      <div className="mb-5 flex flex-wrap items-center gap-2">
        {renaming ? (
          <RenameField
            value={workspace.name}
            onDone={(name) => {
              setRenaming(false);
              if (name && name !== workspace.name)
                void api
                  .renameWorkspace(workspace.id, name)
                  .then(onChanged)
                  .catch((cause: unknown) => setError(errorMessage(cause)));
            }}
          />
        ) : (
          <h2 className="m-0 text-[18px] font-semibold tracking-[-0.015em] text-ink">{workspace.name}</h2>
        )}
        {projectId && (
          <span className="flex items-center gap-1.5 text-[18px] font-semibold tracking-[-0.015em] text-ink">
            <span aria-hidden="true" className="text-faint">
              /
            </span>
            <Glyph name="folder" size={16} />
            {project?.name ?? '…'}
          </span>
        )}
        <span className="text-dim">
          {ROLE_LABELS[workspace.role]} · {workspace.memberCount} {workspace.memberCount === 1 ? 'member' : 'members'}
        </span>
        <div className="flex-1" />
        <button type="button" className="ev-button" onClick={() => setMembersOpen(true)}>
          <Icon name="users" size={14} />
          Members
        </button>
        <button
          type="button"
          className="ev-icon-button"
          aria-label="Workspace actions"
          aria-haspopup="menu"
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            setMenu({ x: rect.right - 210, y: rect.bottom + 4 });
          }}
        >
          <Icon name="more" />
        </button>
        {canAdd && (
          <button type="button" className="ev-button ev-button-primary" disabled={creating} onClick={create}>
            <Icon name="plus" size={14} />
            New shared file
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="m-0 mb-4 rounded-[8px] bg-danger/10 px-3 py-2.5 leading-relaxed text-danger ring-1 ring-danger/30 ring-inset">
          {error}
        </p>
      )}
      {!projectId && projects.length > 0 && (
        <ul aria-label="Projects" className="m-0 mb-5 grid list-none grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-2 p-0">
          {projects.map((entry) => (
            <li key={entry.id}>
              <button
                type="button"
                className="ev-row flex w-full items-center gap-2.5 rounded-[10px] border-0 bg-panel px-3 py-2.5 text-left shadow-[var(--ev-shadow-panel)] hover:bg-hover"
                aria-label={`Open project ${entry.name}`}
                onClick={() => go(homeViewHash({ kind: 'workspace', id: workspace.id, projectId: entry.id }))}
              >
                <span className="flex h-8 w-8 flex-none items-center justify-center rounded-[8px] bg-field text-dim shadow-[var(--ev-sunk)]">
                  <Glyph name="folder" size={16} />
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-[12.5px] font-medium text-ink">{entry.name}</span>
                  <span className="text-[11px] text-dim">
                    {entry.fileCount} {entry.fileCount === 1 ? 'file' : 'files'}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {shown === null && !error && <p className="m-0 text-dim">Loading…</p>}
      {shown !== null && shown.length === 0 && (
        <p className="m-0 rounded-[12px] bg-panel px-6 py-8 text-center leading-relaxed text-dim shadow-[var(--ev-shadow-panel)]">
          {projectId ? 'No files in this project yet.' : 'No shared files in this workspace yet.'}
          {canAdd ? (projectId ? ' Make one with “New shared file”, or move files here from their menu.' : ' Make one with “New shared file”, or open a file on this device and share it.') : ''}
        </p>
      )}
      {shown !== null && shown.length > 0 && (
        <SharedFiles
          label="Shared files"
          docs={shown}
          onOpen={onOpenDoc}
          menuFor={actions.menuFor}
          showLocation={false}
          onRename={(doc, name) =>
            void api
              .updateDocument(doc.id, { name })
              .then(load)
              .catch((cause: unknown) => setError(errorMessage(cause)))
          }
        />
      )}
      {actions.dialogs}
      {menu && <PopupMenu x={menu.x} y={menu.y} items={workspaceMenu} label="Workspace actions" onClose={() => setMenu(null)} />}
      {membersOpen && <WorkspaceMembersDialog api={api} workspace={workspace} meId={meId} onClose={() => setMembersOpen(false)} onChanged={onChanged} onLeft={onGone} />}
      {projectDialog === 'new' && (
        <NameDialog
          title="New project"
          label="Name"
          action="Create project"
          onClose={() => setProjectDialog(null)}
          onSubmit={async (name) => {
            const made = await files.createProject(workspace.id, name);
            bump();
            go(homeViewHash({ kind: 'workspace', id: workspace.id, projectId: made.id }));
          }}
        />
      )}
      {projectDialog === 'rename' && project && (
        <NameDialog
          title="Rename project"
          label="Name"
          initial={project.name}
          action="Rename"
          onClose={() => setProjectDialog(null)}
          onSubmit={async (name) => {
            await files.renameProject(project.id, name);
            bump();
          }}
        />
      )}
      {projectDialog === 'delete' && project && (
        <ConfirmDialog
          title="Delete project"
          action="Delete project"
          onClose={() => setProjectDialog(null)}
          onConfirm={() =>
            void files
              .deleteProject(project.id)
              .then(() => {
                bump();
                go(homeViewHash({ kind: 'workspace', id: workspace.id }));
              })
              .catch((cause: unknown) => setError(errorMessage(cause)))
          }
        >
          Delete the project <strong className="font-semibold text-ink">{project.name}</strong>? Its files are kept: they move to the workspace’s root.
        </ConfirmDialog>
      )}
      {deletingWorkspace && (
        <ConfirmDialog
          title="Delete workspace"
          action="Delete workspace"
          onClose={() => setDeletingWorkspace(false)}
          onConfirm={() =>
            api
              .deleteWorkspace(workspace.id)
              .then(onGone)
              .catch((cause: unknown) => setError(errorMessage(cause)))
          }
        >
          Delete <strong className="font-semibold text-ink">{workspace.name}</strong> and every file in it, for all its members? This cannot be undone.
        </ConfirmDialog>
      )}
    </>
  );
}

function RenameField({ value, onDone }: { value: string; onDone: (name: string) => void }) {
  const [name, setName] = useState(value);
  const field = useRef<HTMLInputElement>(null);
  useFocusSoon(field, null);
  return (
    <input
      ref={field}
      aria-label="Workspace name"
      className="ev-field !w-64"
      value={name}
      onChange={(event) => setName(event.target.value)}
      onBlur={() => onDone(name.trim())}
      onKeyDown={(event) => {
        if (event.key === 'Enter') onDone(name.trim());
        if (event.key === 'Escape') onDone(value);
      }}
    />
  );
}

/** The files shared with you directly, outside your workspaces. */
export function SharedPage({ api, onOpenDoc, files = defaultFiles, onNavigate }: { api: EvoraApi; onOpenDoc: (doc: DocInfo) => void; files?: FilesApi; onNavigate?: (hash: string) => void }) {
  const [docs, setDocs] = useState<FileInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const version = useFilesStore((state) => state.version);
  const load = useCallback(() => {
    api
      .sharedDocuments()
      .then(async (list) => {
        // Favourites are marked: the favourites are read once for the whole list.
        const favorites = new Set((await files.favorites().catch(() => [])).map((file) => file.id));
        setDocs(list.map((doc) => ({ projectId: null, projectName: null, workspaceName: null, openedAt: null, ...doc, favorite: favorites.has(doc.id) })));
      })
      .catch((cause: unknown) => setError(errorMessage(cause)));
  }, [api, files]);
  useEffect(load, [load, version]);
  const actions = useDocActions({ api, files, canAddHere: false, onOpen: onOpenDoc, onChanged: load, onError: setError, onNavigate });
  return (
    <>
      <h2 className="m-0 mb-5 text-[18px] font-semibold tracking-[-0.015em] text-ink">Shared with me</h2>
      {error && (
        <p role="alert" className="m-0 mb-4 text-danger">
          {error}
        </p>
      )}
      {docs !== null && docs.length === 0 && <p className="m-0 text-dim">Nothing has been shared with you yet. Files people invite you to appear here.</p>}
      {docs !== null && docs.length > 0 && (
        <SharedFiles
          label="Shared files"
          docs={docs}
          onOpen={onOpenDoc}
          menuFor={actions.menuFor}
          showLocation
          onRename={(doc, name) =>
            void api
              .updateDocument(doc.id, { name })
              .then(load)
              .catch((cause: unknown) => setError(errorMessage(cause)))
          }
        />
      )}
      {actions.dialogs}
    </>
  );
}

/** Asking before something that cannot be undone. */
function ConfirmDialog({ title, action, children, onConfirm, onClose }: { title: string; action: string; children: ReactNode; onConfirm: () => void; onClose: () => void }) {
  return (
    <Dialog
      title={title}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="ev-button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="ev-button ev-button-danger"
            onClick={() => {
              onClose();
              onConfirm();
            }}
          >
            {action}
          </button>
        </>
      }
    >
      <p className="m-0 leading-relaxed text-dim">{children}</p>
    </Dialog>
  );
}

interface WorkspaceMembersDialogProps {
  api: EvoraApi;
  workspace: Workspace;
  meId: string | null;
  onClose: () => void;
  onChanged: () => void;
  onLeft: () => void;
}

/** A workspace's members: invite by email with a role, change roles, remove people, and copy an invite link. */
export function WorkspaceMembersDialog({ api, workspace, meId, onClose, onChanged, onLeft }: WorkspaceMembersDialogProps) {
  const [members, setMembers] = useState<MembersResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [linkRole, setLinkRole] = useState<Role>('editor');
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const owner = workspace.role === 'owner';
  const canInvite = workspace.role === 'owner' || workspace.role === 'editor';
  const roles: Role[] = owner ? ['owner', 'editor', 'viewer'] : ['editor', 'viewer'];

  useEffect(() => {
    api
      .workspaceMembers(workspace.id)
      .then(setMembers)
      .catch((cause: unknown) => setError(errorMessage(cause)));
  }, [api, workspace.id]);

  const act = (action: () => Promise<void>): void => {
    setError(null);
    void action()
      .then(onChanged)
      .catch((cause: unknown) => setError(errorMessage(cause)));
  };

  return (
    <Dialog title={`Members of ${workspace.name}`} onClose={onClose} width={480}>
      <div className="flex flex-col gap-4">
        {canInvite && (
          <InviteForm
            roles={roles}
            onInvite={async (email, role) => {
              setMembers(await api.addWorkspaceMember(workspace.id, email, role));
              onChanged();
            }}
          />
        )}
        {error && (
          <p role="alert" className="m-0 rounded-[8px] bg-danger/10 px-3 py-2 text-danger ring-1 ring-danger/30 ring-inset">
            {error}
          </p>
        )}
        {members === null ? (
          !error && <p className="m-0 text-dim">Loading…</p>
        ) : (
          <MembersList
            members={members}
            meId={meId}
            canManage={owner}
            roles={roles}
            leaveLabel={owner ? undefined : 'Leave'}
            onRole={(member, role) => act(async () => setMembers(await api.setWorkspaceMemberRole(workspace.id, member.user.id, role)))}
            onRemove={(member) =>
              act(async () => {
                await api.removeWorkspaceMember(workspace.id, member.user.id);
                if (member.user.id === meId) {
                  onClose();
                  onLeft();
                  return;
                }
                setMembers(await api.workspaceMembers(workspace.id));
              })
            }
          />
        )}
        {canInvite && (
          <section aria-label="Invite link" className="flex flex-col gap-1.5 border-t border-line pt-3">
            <h3 className="ev-section-title">Invite link</h3>
            <p className="m-0 text-dim">Anyone who opens it and signs in joins the workspace with this role.</p>
            <div className="flex items-center gap-1.5">
              <RoleSelect label="Role given by the invite link" value={linkRole} roles={roles} onChange={setLinkRole} />
              <button
                type="button"
                className="ev-button !h-7"
                onClick={() =>
                  act(async () => {
                    const { token } = await api.createInviteLink(workspace.id, linkRole);
                    const url = inviteLink(token);
                    setLink(url);
                    setCopied(await copyText(url));
                  })
                }
              >
                <Icon name="link" size={14} />
                Copy invite link
              </button>
            </div>
            {link && <input className="ev-field !h-7 text-dim" readOnly aria-label="Invite link" value={link} onFocus={(event) => event.currentTarget.select()} />}
            {copied && (
              <p role="status" className="m-0 text-success">
                Invite link copied.
              </p>
            )}
          </section>
        )}
        <p className="m-0 text-center text-[11px] text-dim">Free · unlimited members.</p>
      </div>
    </Dialog>
  );
}
