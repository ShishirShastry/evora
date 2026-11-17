import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { clearAccount } from '../../collab/account';
import { ApiError, documentLink, errorMessage, inviteLink, type EvoraApi, type MembersResult } from '../../collab/api';
import type { DocInfo, Role, Workspace } from '../../collab/protocol';
import { Dialog } from '../components/Dialog';
import { Icon } from '../components/Icon';
import { PopupMenu, type MenuItem } from '../components/Menu';
import { useFocusSoon } from './AccountDialog';
import { DocGrid } from './DocCard';
import { copyText, FREE_NOTE, ROLE_LABELS } from './hooks';
import { InviteForm, MembersList, RoleSelect } from './Members';
import { newSharedDocument } from './upload';

/** What the file browser shows: the files on this device, a workspace's shared files, or the files shared with you. */
export type HomeView = { kind: 'local' } | { kind: 'workspace'; id: string } | { kind: 'shared' };

export function homeViewHash(view: HomeView): string {
  return view.kind === 'workspace' ? `#/workspace/${view.id}` : view.kind === 'shared' ? '#/shared' : '#/';
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
}

/** The file browser's left rail while signed in: this device, files shared with you, and each workspace. */
export function HomeRail({ view, onView, workspaces, error, onNewWorkspace }: HomeRailProps) {
  const item = (selected: boolean, label: string, icon: 'device' | 'users' | 'file', onClick: () => void, detail?: string, key?: string) => (
    <button
      key={key}
      type="button"
      aria-current={selected ? 'page' : undefined}
      className={`ev-row flex h-8 w-full items-center gap-2 rounded-[8px] border-0 px-2 text-left ${selected ? 'bg-selected text-ink' : 'bg-transparent text-dim hover:bg-hover hover:text-ink'}`}
      onClick={onClick}
    >
      <Icon name={icon} size={15} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {detail && <span className="flex-none text-[10.5px] text-faint">{detail}</span>}
    </button>
  );
  return (
    <nav aria-label="Workspaces" className="ev-panel flex w-[232px] flex-none flex-col gap-0.5 overflow-y-auto p-2">
      {item(view.kind === 'local', 'Files on this device', 'device', () => onView({ kind: 'local' }))}
      {item(view.kind === 'shared', 'Shared with me', 'users', () => onView({ kind: 'shared' }))}
      <h2 className="m-0 mt-3 px-2 pb-1 text-[11px] font-semibold text-dim">Workspaces</h2>
      {error && (
        <p role="alert" className="m-0 px-2 text-[11px] text-danger">
          {error}
        </p>
      )}
      {workspaces?.map((workspace) =>
        item(view.kind === 'workspace' && view.id === workspace.id, workspace.name, 'file', () => onView({ kind: 'workspace', id: workspace.id }), `${workspace.memberCount} ${workspace.memberCount === 1 ? 'member' : 'members'}`, workspace.id),
      )}
      <button type="button" className="ev-row flex h-8 w-full items-center gap-2 rounded-[8px] border-0 bg-transparent px-2 text-left text-dim hover:bg-hover hover:text-ink" onClick={onNewWorkspace}>
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

/** The menu items shared by every card of a shared document. */
function docMenu(doc: DocInfo, rename: () => void, onOpen: (doc: DocInfo) => void, askDelete: (doc: DocInfo) => void): MenuItem[] {
  const items: MenuItem[] = [
    { label: 'Open', onSelect: () => onOpen(doc) },
    { label: 'Copy link', onSelect: () => void copyText(documentLink(doc.id)) },
  ];
  if (doc.role === 'owner' || doc.role === 'editor') items.push({ label: 'Rename', onSelect: rename });
  if (doc.role === 'owner') {
    items.push({ type: 'separator' });
    items.push({ label: 'Delete…', danger: true, onSelect: () => askDelete(doc) });
  }
  return items;
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
}

/** One workspace: its shared files as cards, "New shared file", its members, and renaming, deleting or leaving it. */
export function WorkspacePage({ api, workspace, meId, onOpenDoc, onChanged, onGone }: WorkspacePageProps) {
  const [docs, setDocs] = useState<DocInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [membersOpen, setMembersOpen] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<DocInfo | null>(null);
  const [deletingWorkspace, setDeletingWorkspace] = useState(false);

  const load = useCallback(() => {
    api
      .workspaceDocuments(workspace.id)
      .then((list) => {
        setDocs([...list].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)));
        setError(null);
      })
      .catch((cause: unknown) => setError(errorMessage(cause)));
  }, [api, workspace.id]);
  useEffect(load, [load]);

  const canAdd = workspace.role !== 'viewer';
  const create = (): void => {
    setCreating(true);
    void newSharedDocument(api, workspace.id)
      .then((id) => onOpenDoc({ id } as DocInfo))
      .catch((cause: unknown) => setError(errorMessage(cause)))
      .finally(() => setCreating(false));
  };

  const workspaceMenu: MenuItem[] =
    workspace.role === 'owner'
      ? [
          { label: 'Rename workspace', onSelect: () => setRenaming(true) },
          { type: 'separator' },
          { label: 'Delete workspace…', danger: true, onSelect: () => setDeletingWorkspace(true) },
        ]
      : [
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
        ];

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
      {docs === null && !error && <p className="m-0 text-dim">Loading…</p>}
      {docs !== null && docs.length === 0 && (
        <p className="m-0 rounded-[12px] bg-panel px-6 py-8 text-center leading-relaxed text-dim shadow-[var(--ev-shadow-panel)]">
          No shared files in this workspace yet.{canAdd ? ' Make one with “New shared file”, or open a file on this device and share it.' : ''}
        </p>
      )}
      {docs !== null && docs.length > 0 && (
        <DocGrid
          label="Shared files"
          docs={docs}
          onOpen={onOpenDoc}
          menuFor={(doc, rename) => docMenu(doc, rename, onOpenDoc, setDeleting)}
          onRename={(doc, name) =>
            void api
              .updateDocument(doc.id, { name })
              .then(load)
              .catch((cause: unknown) => setError(errorMessage(cause)))
          }
        />
      )}
      {menu && <PopupMenu x={menu.x} y={menu.y} items={workspaceMenu} label="Workspace actions" onClose={() => setMenu(null)} />}
      {membersOpen && <WorkspaceMembersDialog api={api} workspace={workspace} meId={meId} onClose={() => setMembersOpen(false)} onChanged={onChanged} onLeft={onGone} />}
      {deleting && (
        <ConfirmDialog
          title="Delete shared file"
          action="Delete file"
          onClose={() => setDeleting(null)}
          onConfirm={() =>
            api
              .deleteDocument(deleting.id)
              .then(load)
              .catch((cause: unknown) => setError(errorMessage(cause)))
          }
        >
          Delete <strong className="font-semibold text-ink">{deleting.name}</strong> for everyone who has it? This cannot be undone.
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
export function SharedPage({ api, onOpenDoc }: { api: EvoraApi; onOpenDoc: (doc: DocInfo) => void }) {
  const [docs, setDocs] = useState<DocInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<DocInfo | null>(null);
  const load = useCallback(() => {
    api
      .sharedDocuments()
      .then(setDocs)
      .catch((cause: unknown) => setError(errorMessage(cause)));
  }, [api]);
  useEffect(load, [load]);
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
        <DocGrid
          label="Shared files"
          docs={docs}
          onOpen={onOpenDoc}
          menuFor={(doc, rename) => docMenu(doc, rename, onOpenDoc, setDeleting)}
          onRename={(doc, name) =>
            void api
              .updateDocument(doc.id, { name })
              .then(load)
              .catch((cause: unknown) => setError(errorMessage(cause)))
          }
        />
      )}
      {deleting && (
        <ConfirmDialog
          title="Delete shared file"
          action="Delete file"
          onClose={() => setDeleting(null)}
          onConfirm={() =>
            api
              .deleteDocument(deleting.id)
              .then(load)
              .catch((cause: unknown) => setError(errorMessage(cause)))
          }
        >
          Delete <strong className="font-semibold text-ink">{deleting.name}</strong> for everyone who has it? This cannot be undone.
        </ConfirmDialog>
      )}
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
