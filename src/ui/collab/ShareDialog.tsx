import { useEffect, useState } from 'react';
import { documentLink, errorMessage, type EvoraApi, type MembersResult } from '../../collab/api';
import { linkOrigin } from '../../collab/endpoint';
import type { DocInfo, LinkAccess, Member, Role, Workspace } from '../../collab/protocol';
import { Dialog } from '../components/Dialog';
import { Icon } from '../components/Icon';
import { copyPrototypeLink, planPrototypeLink } from '../prototype/links';
import { InviteForm, MembersList } from './Members';
import { copyText } from './hooks';

export const LINK_ACCESS_OPTIONS: { value: LinkAccess; label: string; hint: string }[] = [
  { value: 'none', label: 'No one', hint: 'Only the people invited can open it.' },
  { value: 'view', label: 'Anyone with the link can view', hint: 'They can look and comment, also without an account.' },
  { value: 'edit', label: 'Anyone with the link can edit', hint: 'They can change the design, also without an account.' },
];

interface LinkAccessControlProps {
  value: LinkAccess;
  disabled?: boolean;
  onChange: (value: LinkAccess) => void;
}

/** Who can open the document by its link: a choice of three. */
export function LinkAccessControl({ value, disabled, onChange }: LinkAccessControlProps) {
  return (
    <div role="radiogroup" aria-label="Link access" className="flex flex-col gap-1">
      {LINK_ACCESS_OPTIONS.map((option) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            disabled={disabled}
            className={`flex w-full items-start gap-2.5 rounded-[8px] border-0 px-2.5 py-2 text-left transition-colors duration-100 disabled:cursor-default ${
              checked ? 'bg-selected' : 'bg-transparent hover:bg-hover'
            }`}
            onClick={() => {
              if (!checked) onChange(option.value);
            }}
          >
            <span
              aria-hidden="true"
              className={`mt-0.5 flex h-3.5 w-3.5 flex-none items-center justify-center rounded-full ${checked ? 'bg-accent' : 'bg-field shadow-[inset_0_0_0_1.5px_var(--ev-faint)]'}`}
            >
              {checked && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="font-medium">{option.label}</span>
              <span className="text-[11px] text-dim">{option.hint}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

interface DocumentShareDialogProps {
  api: EvoraApi;
  info: DocInfo;
  /** The role of the person looking. */
  role: Role | null;
  meId: string | null;
  onInfo: (info: DocInfo) => void;
  onClose: () => void;
  /** Where links point; the page's own address by default. */
  origin?: string;
  /** Whether the person looking has an account (a guest may not see who has access). True by default. */
  signedIn?: boolean;
  /** The frame its prototype link starts from; null (the default) starts where the file's first flow or frame does. */
  prototypeStartId?: string | null;
}

/**
 * Sharing a shared document, as Figma does: invite people by email with a
 * role, see and change who has access, choose who can open it by its link,
 * and copy the link. Free, with no limit on the number of people.
 */
export function DocumentShareDialog({ api, info, role, meId, onInfo, onClose, origin, signedIn = true, prototypeStartId = null }: DocumentShareDialogProps) {
  const [members, setMembers] = useState<MembersResult | null>(null);
  const [workspaceMembers, setWorkspaceMembers] = useState<Member[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  /** What "Copy prototype link" did: copied, or the link shown to be copied by hand, with who it opens for. */
  const [protoCopy, setProtoCopy] = useState<{ url: string; audience: string; copied: boolean } | null>(null);
  const [linkAccess, setLinkAccess] = useState<LinkAccess>(info.linkAccess);
  const manage = role === 'owner' || role === 'editor';

  useEffect(() => setLinkAccess(info.linkAccess), [info.linkAccess]);
  // Who the copied prototype link opens for changes with link access: the old note is taken down.
  useEffect(() => setProtoCopy(null), [linkAccess]);

  useEffect(() => {
    let current = true;
    // Member lists hold addresses: a guest may not read them, and only the workspace's own members may read its list.
    if (!signedIn) return;
    api
      .documentMembers(info.id)
      .then((result) => current && setMembers(result))
      .catch((cause: unknown) => current && setError(errorMessage(cause)));
    // Members of the workspace have access through it.
    void api
      .listWorkspaces()
      .then((list) => (list.some((workspace) => workspace.id === info.workspaceId) ? api.workspaceMembers(info.workspaceId) : null))
      .then((result) => current && result && setWorkspaceMembers(result.members))
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [api, info.id, info.workspaceId, signedIn]);

  const act = (action: () => Promise<void>): void => {
    setError(null);
    void action().catch((cause: unknown) => setError(errorMessage(cause)));
  };

  const changeLinkAccess = (value: LinkAccess): void => {
    const before = linkAccess;
    setLinkAccess(value);
    act(async () => {
      try {
        onInfo(await api.updateDocument(info.id, { linkAccess: value }));
      } catch (cause) {
        setLinkAccess(before);
        throw cause;
      }
    });
  };

  const link = documentLink(info.id, origin);
  const copyProtoLink = (): void => {
    const plan = planPrototypeLink({ sharedId: info.id, linkAccess, startId: prototypeStartId, origin: origin ?? linkOrigin() });
    const clipboard = typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function' ? navigator.clipboard : null;
    void copyPrototypeLink(plan, {
      writeText: clipboard ? (text) => clipboard.writeText(text) : undefined,
      said: (url, audience, done) => setProtoCopy({ url, audience, copied: done }),
      shareFirst: () => undefined,
    });
  };
  const direct = new Set(members?.members.map((member) => member.user.id) ?? []);
  const throughWorkspace = workspaceMembers.filter((member) => !direct.has(member.user.id));

  return (
    <Dialog title={`Share “${info.name}”`} onClose={onClose} width={460}>
      <div className="flex flex-col gap-4">
        {manage && <InviteForm roles={role === 'owner' ? ['owner', 'editor', 'viewer'] : ['editor', 'viewer']} onInvite={async (email, invitedRole) => setMembers(await api.addDocumentMember(info.id, email, invitedRole))} />}
        {error && (
          <p role="alert" className="m-0 rounded-[8px] bg-danger/10 px-3 py-2 text-danger ring-1 ring-danger/30 ring-inset">
            {error}
          </p>
        )}
        <section aria-label="People with access" className="flex flex-col gap-1.5">
          <h3 className="ev-section-title">People with access</h3>
          {!signedIn ? (
            <p className="m-0 text-dim">Who has access is shown to people with an account.</p>
          ) : members === null ? (
            <p className="m-0 text-dim">Loading…</p>
          ) : (
            <MembersList
              members={members}
              meId={meId}
              canManage={manage}
              roles={role === 'owner' ? ['owner', 'editor', 'viewer'] : ['editor', 'viewer']}
              onRole={(member, newRole) => act(async () => setMembers(await api.setDocumentMemberRole(info.id, member.user.id, newRole)))}
              onRemove={(member) =>
                act(async () => {
                  await api.removeDocumentMember(info.id, member.user.id);
                  setMembers(await api.documentMembers(info.id));
                })
              }
            />
          )}
          {throughWorkspace.length > 0 && (
            <p className="m-0 flex items-center gap-2 text-dim">
              <Icon name="users" size={14} />
              {throughWorkspace.length === 1 ? '1 more person has' : `${throughWorkspace.length} more people have`} access through the workspace.
            </p>
          )}
        </section>
        <section aria-label="Link" className="flex flex-col gap-1.5">
          <h3 className="ev-section-title">Who can open the link</h3>
          <LinkAccessControl value={linkAccess} disabled={!manage} onChange={changeLinkAccess} />
          <div className="flex items-center gap-1.5">
            <input className="ev-field !h-7 text-dim" readOnly aria-label="Link to this file" value={link} onFocus={(event) => event.currentTarget.select()} />
            <button
              type="button"
              className="ev-button !h-7 flex-none"
              onClick={() => {
                void copyText(link).then((done) => {
                  setCopied(done);
                  if (!done) setError('The browser did not allow copying. Select the link and copy it yourself.');
                });
              }}
            >
              <Icon name="link" size={14} />
              Copy link
            </button>
          </div>
          {copied && (
            <p role="status" className="m-0 text-success">
              Link copied.
            </p>
          )}
          {/* The prototype: the same file, opened straight into presentation, for the same people. */}
          <div className="flex items-center gap-1.5">
            <span className="min-w-0 flex-1 text-dim">Prototype link: opens the file in presentation.</span>
            <button type="button" className="ev-button !h-7 flex-none" onClick={copyProtoLink}>
              <Icon name="link" size={14} />
              Copy prototype link
            </button>
          </div>
          {protoCopy && (
            <div role="status" aria-label="Prototype link" className="flex flex-col gap-1">
              <p className={`m-0 ${protoCopy.copied ? 'text-success' : 'text-ink'}`}>{protoCopy.copied ? 'Prototype link copied.' : 'The browser did not allow copying. Copy this prototype link yourself:'}</p>
              {!protoCopy.copied && <input className="ev-field !h-7 text-dim" readOnly aria-label="Prototype link to copy" value={protoCopy.url} onFocus={(event) => event.currentTarget.select()} />}
              <p className="m-0 text-[11px] text-dim">{protoCopy.audience}</p>
            </div>
          )}
        </section>
        <p className="m-0 border-t border-line pt-3 text-center text-[11px] text-dim">Free · unlimited people. Everyone can edit, view and comment at no cost.</p>
      </div>
    </Dialog>
  );
}

interface LocalShareDialogProps {
  api: EvoraApi;
  /** The file's name. */
  name: string;
  signedIn: boolean;
  /** Why the dialog was opened, when it was for something else (the Comment tool). */
  reason?: string | null;
  /** Puts the file in a workspace (as a new shared document) and answers with its ID. */
  upload: (workspaceId: string) => Promise<string>;
  onShared: (docId: string) => void;
  onSignIn: () => void;
  onClose: () => void;
}

/**
 * Sharing a file that is on this device: a copy of it goes to one of your
 * workspaces as a shared document, which then opens. The file on this device
 * stays as it is.
 */
export function LocalShareDialog({ api, name, signedIn, reason, upload, onShared, onSignIn, onClose }: LocalShareDialogProps) {
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [chosen, setChosen] = useState<string>('');
  const [newName, setNewName] = useState('My workspace');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!signedIn) return;
    let current = true;
    api
      .listWorkspaces()
      .then((list) => {
        if (!current) return;
        // Only workspaces one may add files to.
        const usable = list.filter((workspace) => workspace.role !== 'viewer');
        setWorkspaces(usable);
        setChosen(usable[0]?.id ?? '');
      })
      .catch((cause: unknown) => current && setError(errorMessage(cause)));
    return () => {
      current = false;
    };
  }, [api, signedIn]);

  const share = (): void => {
    setBusy(true);
    setError(null);
    void (async () => {
      const workspaceId = chosen || (await api.createWorkspace(newName.trim() || 'My workspace')).id;
      return upload(workspaceId);
    })()
      .then(onShared)
      .catch((cause: unknown) => {
        setError(errorMessage(cause));
        setBusy(false);
      });
  };

  return (
    <Dialog title={`Share “${name}”`} onClose={onClose} width={440}>
      <div className="flex flex-col gap-3">
        {reason && <p className="m-0 rounded-[8px] bg-field px-3 py-2 leading-relaxed text-dim shadow-[var(--ev-sunk)]">{reason}</p>}
        <p className="m-0 leading-relaxed text-dim">
          This file is on this device only. Share it to edit it with others in real time, see their cursors, and comment. A copy goes to a workspace on the
          collaboration server; the file on this device stays as it is.
        </p>
        {!signedIn ? (
          <button type="button" className="ev-button ev-button-primary self-start" onClick={onSignIn}>
            Sign in or create an account to share
          </button>
        ) : workspaces === null ? (
          !error && <p className="m-0 text-dim">Loading your workspaces…</p>
        ) : (
          <>
            {workspaces.length > 0 ? (
              <label className="flex flex-col gap-1">
                <span className="text-dim">Workspace</span>
                <select className="ev-field" value={chosen} onChange={(event) => setChosen(event.target.value)}>
                  {workspaces.map((workspace) => (
                    <option key={workspace.id} value={workspace.id}>
                      {workspace.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <label className="flex flex-col gap-1">
                <span className="text-dim">A new workspace for it</span>
                <input className="ev-field" value={newName} onChange={(event) => setNewName(event.target.value)} />
              </label>
            )}
            <button type="button" className="ev-button ev-button-primary self-start" disabled={busy} onClick={share}>
              {busy ? 'Sharing…' : 'Share this file'}
            </button>
          </>
        )}
        {error && (
          <p role="alert" className="m-0 rounded-[8px] bg-danger/10 px-3 py-2 text-danger ring-1 ring-danger/30 ring-inset">
            {error}
          </p>
        )}
        <p className="m-0 border-t border-line pt-3 text-center text-[11px] text-dim">Free · unlimited people. No plans, no seat limits.</p>
      </div>
    </Dialog>
  );
}
