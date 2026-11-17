import { useRef, useState } from 'react';
import type { Peer } from '../../collab/protocol';
import type { DocumentStorage } from '../../persistence/storage';
import type { EditorState } from '../../state/editorStore';
import { useEditor, useEditorContext } from '../editor/EditorContext';
import { mergedBranchReason, useVersionsUi } from '../versions/state';
import { Dialog } from '../components/Dialog';
import { Icon } from '../components/Icon';
import { PopupMenu } from '../components/Menu';
import { AccountDialog } from './AccountDialog';
import { AccountMenu } from './AccountMenu';
import { Avatar } from './Avatar';
import { useCollab, useCollabState } from './CollabContext';
import { useAccount, useGuest } from './hooks';
import { peopleHere } from './session';
import { DocumentShareDialog, LocalShareDialog } from './ShareDialog';
import { uploadDocument } from './upload';

/** How many avatars the header shows before the rest are counted ("+3"). */
const MAX_AVATARS = 4;

/** Whether the editor shows the document read-only (a viewer of a shared document). */
export function storeReadOnly(state: EditorState): boolean {
  return state.readOnly;
}

/** Whether this person may only look and comment: the store says so, or the shared document's role does. */
export function useReadOnly(): boolean {
  const fromStore = useEditor(storeReadOnly);
  const shared = useCollabState((s) => s.docId !== null);
  const role = useCollabState((s) => s.role);
  return fromStore || (shared && role === 'viewer');
}

/**
 * The people in the document, in the properties panel's header: you first
 * (your avatar opens your account menu), then everyone else stacked, each
 * named on hover; clicking one follows their view. For a file on this
 * device, just your account (or "Sign in").
 */
export function PresenceAvatars() {
  const session = useCollab();
  const peers = useCollabState((s) => s.peers);
  const you = useCollabState((s) => s.you);
  const following = useCollabState((s) => s.following);
  const more = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  if (session.docId === null) return <AccountMenu compact />;
  const people = peopleHere(you, peers);
  const others = people.filter((peer) => !you || peer.user.id !== you.user.id);
  const shown = others.slice(0, MAX_AVATARS);
  const hidden = others.slice(MAX_AVATARS);
  const follow = (peer: Peer): void => session.follow(following === peer.clientId ? null : peer.clientId);

  return (
    <div className="flex min-w-0 items-center" role="group" aria-label="People in this file">
      <AccountMenu compact />
      <div className="ml-1 flex items-center">
        {shown.map((peer, index) => (
          <button
            key={peer.clientId}
            type="button"
            className={`relative flex flex-none items-center justify-center rounded-full border-0 bg-transparent p-0 transition-transform duration-100 hover:z-10 hover:-translate-y-px ${index > 0 ? '-ml-1.5' : ''}`}
            style={following === peer.clientId ? { boxShadow: `0 0 0 2px ${peer.user.color}` } : undefined}
            aria-label={`${following === peer.clientId ? 'Stop following' : 'Follow'} ${peer.user.name}`}
            aria-pressed={following === peer.clientId}
            title={`${peer.user.name}${peer.user.guest ? ' (guest)' : ''}${peer.role === 'viewer' ? ' · can view' : ''} · click to follow their view`}
            onClick={() => follow(peer)}
          >
            <Avatar name={peer.user.name} color={peer.user.color} size={24} ring />
          </button>
        ))}
        {hidden.length > 0 && (
          <button
            ref={more}
            type="button"
            className="-ml-1.5 flex h-6 min-w-6 flex-none items-center justify-center rounded-full border-0 bg-field px-1 text-[10.5px] font-semibold text-dim shadow-[0_0_0_2px_var(--ev-panel)]"
            aria-label={`${hidden.length} more people`}
            aria-haspopup="menu"
            onClick={() => {
              const rect = more.current?.getBoundingClientRect();
              if (rect) setMenu({ x: rect.left, y: rect.bottom + 6 });
            }}
          >
            +{hidden.length}
          </button>
        )}
      </div>
      {menu && (
        <PopupMenu
          x={menu.x}
          y={menu.y}
          label="People in this file"
          onClose={() => setMenu(null)}
          items={others.map((peer) => ({ label: `Follow ${peer.user.name}`, checked: following === peer.clientId, onSelect: () => follow(peer) }))}
        />
      )}
    </div>
  );
}

/** The Share button beside Present: open to everyone, for every file. */
export function ShareButton() {
  const session = useCollab();
  return (
    <button type="button" className="ev-button !h-7 flex-none !px-2.5" title="Share this file with others: free, unlimited people" onClick={() => session.openShare()}>
      Share
    </button>
  );
}

/** "View only", shown in the file header to someone who may look and comment but not change the design. */
export function ViewOnlyBadge() {
  const readOnly = useReadOnly();
  // A merged branch is view-only for everyone, whatever their role: the badge says why.
  const branch = useVersionsUi((state) => state.context.branch);
  if (!readOnly) return null;
  const reason = branch?.status === 'merged' ? mergedBranchReason(branch) : 'You can look and comment, but not change the design';
  return (
    <span className="flex-none rounded-full bg-field px-2 py-0.5 text-[10.5px] font-semibold text-dim shadow-[var(--ev-sunk)]" title={reason} aria-description={reason}>
      View only
    </span>
  );
}

/** The Share dialog of the open file: for a shared document its people and link, for a file on this device putting it in a workspace. */
export function CollabDialogs({ storage }: { storage: DocumentStorage }) {
  const session = useCollab();
  const { store } = useEditorContext();
  const open = useCollabState((s) => s.shareOpen);
  const reason = useCollabState((s) => s.shareReason);
  const info = useCollabState((s) => s.info);
  const role = useCollabState((s) => s.role);
  const you = useCollabState((s) => s.you);
  const name = useEditor((s) => s.doc.name);
  const account = useAccount();
  const guest = useGuest();
  const [signIn, setSignIn] = useState(false);

  if (signIn) return <AccountDialog mode="signup" reason="An account lets you share files and work on them together. It is free, with no limits." onClose={() => setSignIn(false)} />;
  if (!open) return null;
  if (session.docId !== null) {
    if (!info)
      return (
        <Dialog title="Share" onClose={() => session.closeShare()}>
          <p className="m-0 text-dim">Reading who has access…</p>
        </Dialog>
      );
    return (
      <DocumentShareDialog
        api={session.api}
        info={info}
        role={role ?? info.role}
        meId={you?.user.id ?? account?.user.id ?? guest?.guest.id ?? null}
        signedIn={account !== null}
        onInfo={(next) => session.setInfo(next)}
        onClose={() => session.closeShare()}
      />
    );
  }
  return (
    <LocalShareDialog
      api={session.api}
      name={name}
      signedIn={account !== null}
      reason={reason}
      upload={(workspaceId) => {
        const state = store.getState();
        // Text being typed is part of the document before it is copied.
        if (state.editingTextId !== null) state.commitGesture('Edit text');
        return uploadDocument(session.api, storage, store.getState().doc, workspaceId);
      }}
      onShared={(docId) => {
        session.closeShare();
        window.location.hash = `#/doc/${docId}`;
      }}
      onSignIn={() => setSignIn(true)}
      onClose={() => session.closeShare()}
    />
  );
}

/** The Comment tool in the dock: places comments on a shared document; on a file on this device it offers to share it first. */
export function CommentToolButton() {
  const session = useCollab();
  const commentMode = useCollabState((s) => s.commentMode);
  return (
    <button
      type="button"
      className="ev-icon-button !h-8 !w-8 !rounded-[9px]"
      aria-label="Comment"
      aria-pressed={commentMode}
      title="Comment (C)"
      onClick={() => toggleCommentTool(session)}
    >
      <Icon name="comment" />
    </button>
  );
}

/** What the Comment tool does when it is picked up: see `CommentToolButton`. */
export function toggleCommentTool(session: ReturnType<typeof useCollab>): void {
  if (session.docId === null) {
    session.openShare('Comments are kept with shared files, so everyone working on the file sees them. Share this file to comment: it is free.');
    return;
  }
  session.setCommentMode(!session.store.getState().commentMode);
}
