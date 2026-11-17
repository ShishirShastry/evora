import { createStore, type StoreApi } from 'zustand/vanilla';
import { getAccount } from '../../collab/account';
import { errorMessage, type EvoraApi } from '../../collab/api';
import type { CommentEvent, DocInfo, LinkAccess, Member, Peer, Presence, Role, Thread } from '../../collab/protocol';
import type { EditorStore } from '../../state/editorStore';

/**
 * What the editor knows about collaboration while a file is open: for a
 * shared document, the live connection's state (status, changes waiting,
 * who else is here, what you may do), its comments and the people who can
 * be mentioned; for every file, what the person is doing with them (the
 * Comment tool, the comment that is open, following someone, the Share
 * dialog). The canvas layer, the panels and the header all read it from
 * one store.
 */

/**
 * The live connection (`openLiveDocument` in `src/collab/live.ts`), as far as
 * the interface uses it. Written out here so tests can give their own.
 */
export interface LiveConnection {
  status(): string;
  onStatus(callback: (status: string) => void): () => void;
  peers(): Peer[];
  onPeers(callback: (peers: Peer[]) => void): () => void;
  you(): Peer | null;
  role(): Role | null;
  onAccess(callback: (role: Role | null, linkAccess: LinkAccess) => void): () => void;
  setPresence(presence: Partial<Presence>): void;
  onComment(callback: (event: CommentEvent) => void): () => void;
  pendingCount(): number;
  onPending(callback: (count: number) => void): () => void;
  close(): void;
  /** The document's details as the server last gave them, when the connection knows them. */
  info?(): DocInfo | null;
}

/** Where a new comment goes, before its first words are posted. */
export interface DraftPin {
  pageId: string;
  nodeId: string | null;
  x: number;
  y: number;
}

export interface CollabState {
  /** The shared document's ID; null for a file on this device. */
  docId: string | null;
  info: DocInfo | null;
  /** The connection's status, as the live connection reports it. */
  status: string;
  /** Changes made here that the server has not yet acknowledged. */
  pending: number;
  peers: Peer[];
  you: Peer | null;
  role: Role | null;
  linkAccess: LinkAccess;
  /** Every comment thread of the document, by ID. */
  threads: Record<string, Thread>;
  /** Why the comments could not be read, if they could not. */
  threadsError: string | null;
  /** The people who can be mentioned: the document's members and its workspace's. */
  members: Member[];

  commentMode: boolean;
  /** Whether the Comments tab of the right sidebar is open (it stands in front of the store's own tab). */
  commentsTab: boolean;
  commentFilter: 'open' | 'resolved';
  openThreadId: string | null;
  draft: DraftPin | null;
  /** The client being followed, or null. */
  following: string | null;
  shareOpen: boolean;
  /** Why the Share dialog was opened, when it was opened for something else (the Comment tool on a local file). */
  shareReason: string | null;
}

export type CollabStore = StoreApi<CollabState>;

export interface CollabSession {
  store: CollabStore;
  /** The shared document's ID; null for a file on this device. */
  docId: string | null;
  api: EvoraApi;
  /** The live connection, once it is open. */
  live(): LiveConnection | null;
  /** Takes over a live connection: its state is mirrored into the store until the returned function is called. */
  attach(live: LiveConnection): () => void;
  /** Reads the document's details, comments and people from the server. */
  refresh(): Promise<void>;
  applyCommentEvent(event: CommentEvent): void;
  setCommentMode(on: boolean): void;
  openThread(threadId: string | null): void;
  setDraft(draft: DraftPin | null): void;
  setCommentsTab(open: boolean): void;
  follow(clientId: string | null): void;
  openShare(reason?: string | null): void;
  closeShare(): void;

  postThread(draft: DraftPin, body: string): Promise<Thread>;
  reply(threadId: string, body: string): Promise<void>;
  setResolved(threadId: string, resolved: boolean): Promise<void>;
  deleteThread(threadId: string): Promise<void>;
  editComment(commentId: string, body: string): Promise<void>;
  deleteComment(threadId: string, commentId: string): Promise<void>;
  /** The document's details were changed (in the Share dialog). */
  setInfo(info: DocInfo): void;
}

export function initialCollabState(docId: string | null): CollabState {
  return {
    docId,
    info: null,
    status: docId ? 'connecting' : 'local',
    pending: 0,
    peers: [],
    you: null,
    role: null,
    linkAccess: 'none',
    threads: {},
    threadsError: null,
    members: [],
    commentMode: false,
    commentsTab: false,
    commentFilter: 'open',
    openThreadId: null,
    draft: null,
    following: null,
    shareOpen: false,
    shareReason: null,
  };
}

interface SessionOptions {
  docId: string | null;
  api: EvoraApi;
  /** The editor's store: for read-only access and for which tab of the right sidebar is open. */
  editor?: EditorStore;
  /** Whether someone is signed in with an account here (a guest is not); the account on this device by default. */
  signedIn?: () => boolean;
}

/**
 * Images added to a shared document are sent to the server by the live
 * connection itself (given this device's storage), so the session leaves them alone.
 */
export function createCollabSession({ docId, api, editor, signedIn = () => getAccount() !== null }: SessionOptions): CollabSession {
  const store = createStore<CollabState>()(() => initialCollabState(docId));
  let live: LiveConnection | null = null;
  const set = (partial: Partial<CollabState>): void => store.setState(partial);
  const putThread = (thread: Thread): void => set({ threads: { ...store.getState().threads, [thread.id]: thread } });

  const applyCommentEvent = (event: CommentEvent): void => {
    if (event.kind === 'thread') putThread(event.thread);
    else {
      const threads = { ...store.getState().threads };
      delete threads[event.threadId];
      set({ threads, openThreadId: store.getState().openThreadId === event.threadId ? null : store.getState().openThreadId });
    }
  };

  /**
   * Whether the editor shows the document read-only: for viewers, and for anyone who has lost access
   * (`revoked`). A role not known yet (offline, before the server has answered) leaves editing as it is,
   * so that changes can be made offline and sent later.
   */
  const applyAccess = (role: Role | null, revoked = false): void => {
    if (!editor || !docId || (role === null && !revoked)) return;
    editor.getState().setReadOnly(role !== 'owner' && role !== 'editor');
  };

  editor?.subscribe((state, previous) => {
    // Choosing Design, Prototype or Inspect (also by their shortcuts) puts the Comments tab away.
    if (state.rightTab !== previous.rightTab && store.getState().commentsTab) set({ commentsTab: false });
  });

  const session: CollabSession = {
    store,
    docId,
    api,
    live: () => live,

    attach(connection) {
      live = connection;
      /** The document's details from the connection, when it has them (it is told them on connecting). */
      const infoNow = (): DocInfo | null => connection.info?.() ?? store.getState().info;
      set({
        status: connection.status(),
        pending: connection.pendingCount(),
        peers: connection.peers(),
        you: connection.you(),
        role: connection.role() ?? store.getState().role,
        info: infoNow(),
      });
      applyAccess(store.getState().role);
      const stops = [
        connection.onStatus((status) => {
          // Connecting is answered with who you are and what you may do.
          set({ status, you: connection.you() ?? store.getState().you, role: connection.role() ?? store.getState().role, info: infoNow() });
          applyAccess(store.getState().role);
        }),
        connection.onPending((pending) => set({ pending })),
        connection.onPeers((peers) => {
          const following = store.getState().following;
          set({
            peers,
            you: connection.you() ?? store.getState().you,
            // Someone who has left can no longer be followed.
            following: following && peers.some((peer) => peer.clientId === following) ? following : null,
          });
        }),
        connection.onAccess((role, linkAccess) => {
          const info = infoNow();
          set({ role, linkAccess, info: info ? { ...info, role, linkAccess } : info });
          applyAccess(role, true);
        }),
        connection.onComment(applyCommentEvent),
      ];
      return () => {
        for (const stop of stops) stop();
        if (live === connection) live = null;
      };
    },

    async refresh() {
      if (!docId) return;
      const [info, threads] = await Promise.allSettled([api.getDocument(docId), api.listThreads(docId)]);
      if (info.status === 'fulfilled') {
        set({ info: info.value, role: store.getState().role ?? info.value.role, linkAccess: info.value.linkAccess });
        applyAccess(store.getState().role);
      }
      if (threads.status === 'fulfilled') {
        const byId: Record<string, Thread> = {};
        for (const thread of threads.value) byId[thread.id] = thread;
        set({ threads: byId, threadsError: null });
      } else set({ threadsError: errorMessage(threads.reason) });
      // The people who can be mentioned: the document's own members and, when one is in its workspace, the workspace's.
      // Member lists hold addresses: a guest may not read them, nor may someone outside the workspace read its members,
      // so neither is asked for (the refusal would only be logged in the browser's console).
      if (!signedIn()) {
        set({ members: [] });
        return;
      }
      const workspaceId = info.status === 'fulfilled' ? info.value.workspaceId : null;
      const mine = workspaceId ? await api.listWorkspaces().then((list) => list.some((workspace) => workspace.id === workspaceId), () => false) : false;
      const lists = await Promise.allSettled([api.documentMembers(docId), mine && workspaceId ? api.workspaceMembers(workspaceId) : Promise.reject(new Error('none'))]);
      const members: Member[] = [];
      for (const list of lists) {
        if (list.status !== 'fulfilled') continue;
        for (const member of list.value.members) if (!members.some((known) => known.user.id === member.user.id)) members.push(member);
      }
      set({ members });
    },

    applyCommentEvent,
    setCommentMode(on) {
      set(on ? { commentMode: true } : { commentMode: false, draft: null });
    },
    openThread(threadId) {
      set({ openThreadId: threadId, draft: threadId ? null : store.getState().draft });
    },
    setDraft(draft) {
      set({ draft, openThreadId: draft ? null : store.getState().openThreadId });
    },
    setCommentsTab(open) {
      set({ commentsTab: open });
    },
    follow(clientId) {
      set({ following: clientId });
    },
    openShare(reason = null) {
      set({ shareOpen: true, shareReason: reason });
    },
    closeShare() {
      set({ shareOpen: false, shareReason: null });
    },

    async postThread(draft, body) {
      if (!docId) throw new Error('Comments are kept with shared files.');
      const thread = await api.createThread(docId, draft, body);
      putThread(thread);
      set({ draft: null, openThreadId: thread.id });
      return thread;
    },
    async reply(threadId, body) {
      putThread(await api.reply(threadId, body));
    },
    async setResolved(threadId, resolved) {
      putThread(await api.updateThread(threadId, { resolved }));
    },
    async deleteThread(threadId) {
      await api.deleteThread(threadId);
      applyCommentEvent({ kind: 'deleted', threadId });
    },
    async editComment(commentId, body) {
      putThread(await api.editComment(commentId, body));
    },
    async deleteComment(threadId, commentId) {
      const thread = await api.deleteComment(commentId);
      if (thread) putThread(thread);
      else applyCommentEvent({ kind: 'deleted', threadId });
    },
    setInfo(info) {
      set({ info, linkAccess: info.linkAccess, role: store.getState().role ?? info.role });
    },
  };
  return session;
}

/** What the file header says about a shared document's connection. */
export function statusLabel(status: string, pending: number): string {
  const waiting = `${pending} ${pending === 1 ? 'change' : 'changes'} waiting`;
  switch (status) {
    case 'connecting':
    case 'reconnecting':
      return pending > 0 ? `Connecting… ${waiting}` : 'Connecting…';
    case 'offline':
    case 'disconnected':
    case 'closed':
      return pending > 0 ? `Offline — ${waiting}` : 'Offline';
    case 'forbidden':
    case 'denied':
    case 'no-access':
      return 'No access';
    case 'local':
      return 'Saved';
    default:
      // Connected: saved on the server once nothing is waiting.
      return pending > 0 ? 'Saving…' : 'Synced';
  }
}

/** The colour of the dot beside the status: green when synced, amber while waiting or connecting, red when offline or shut out. */
export function statusTone(status: string, pending: number): 'ok' | 'busy' | 'bad' {
  if (status === 'offline' || status === 'disconnected' || status === 'closed' || status === 'forbidden' || status === 'denied' || status === 'no-access') return 'bad';
  if (status === 'connecting' || status === 'reconnecting' || pending > 0) return 'busy';
  return 'ok';
}

/** The people in a document for the avatar stack: you first, then each other person once (several tabs of one person are one avatar). */
export function peopleHere(you: Peer | null, peers: readonly Peer[]): Peer[] {
  const out: Peer[] = [];
  const seen = new Set<string>();
  if (you) {
    out.push(you);
    seen.add(you.user.id);
  }
  for (const peer of peers) {
    if (you && peer.clientId === you.clientId) continue;
    if (seen.has(peer.user.id)) continue;
    seen.add(peer.user.id);
    out.push(peer);
  }
  return out;
}
