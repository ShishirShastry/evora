import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { commandForKey } from '../../state/commands';
import type { Peer, Presence, Thread } from '../../collab/protocol';
import { screenToWorld, worldToScreen } from '../../engine/viewport';
import { useEditor, useEditorContext } from '../editor/EditorContext';
import { Avatar, inkOn } from './Avatar';
import { CommentComposer, ThreadView } from './Comments';
import { useCollab, useCollabState } from './CollabContext';
import { cursorOnScreen, followViewport, pinAt, selectionOutlines, threadAnchor, viewportPresence } from './geometry';
import { useAccount, useGuest } from './hooks';
import { plainBody, type Mentionable } from './mentions';

/** How often presence is sent at most, in milliseconds. */
const PRESENCE_MS = 50;
const POPOVER_WIDTH = 300;

/** The Comment tool's pointer: a speech bubble whose tip is the place clicked. */
const COMMENT_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M2 22V12a10 10 0 1 1 10 10z" fill="#0d99ff" stroke="#fff" stroke-width="1.5"/><path d="M8 12h8M12 8v8" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/></svg>',
)}") 2 22, crosshair`;

/**
 * What collaboration draws over the canvas, as DOM laid over the canvas
 * card: the cursors and selections of the others in the document, comment
 * pins and the open thread, and the frame round the canvas while following
 * someone. It also sends this person's presence (pointer, page, selection,
 * view) and places comments with the Comment tool. Nothing is drawn for a
 * file on this device.
 */
export function CollabCanvasLayer({ host }: { host: RefObject<HTMLDivElement | null> }) {
  const session = useCollab();
  if (session.docId === null) return null;
  return <SharedLayer host={host} />;
}

function SharedLayer({ host }: { host: RefObject<HTMLDivElement | null> }) {
  const session = useCollab();
  const { store } = useEditorContext();
  const doc = useEditor((s) => s.doc);
  const pageId = useEditor((s) => s.pageId);
  const viewport = useEditor((s) => s.viewport);
  const size = useEditor((s) => s.canvasSize);
  const peers = useCollabState((s) => s.peers);
  const you = useCollabState((s) => s.you);
  const threads = useCollabState((s) => s.threads);
  const openId = useCollabState((s) => s.openThreadId);
  const draft = useCollabState((s) => s.draft);
  const commentMode = useCollabState((s) => s.commentMode);
  const following = useCollabState((s) => s.following);
  const role = useCollabState((s) => s.role);
  const members = useCollabState((s) => s.members);
  const account = useAccount();
  const guest = useGuest();
  const meId = you?.user.id ?? account?.user.id ?? guest?.guest.id ?? null;
  const me = you?.user ?? (account ? account.user : guest ? { ...guest.guest, guest: true } : null);

  // ------------------------------------------------------------ presence: what this person is doing
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let pending: Partial<Presence> = {};
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = (): void => {
      timer = null;
      const live = session.live();
      if (live && Object.keys(pending).length > 0) live.setPresence(pending);
      pending = {};
    };
    const send = (partial: Partial<Presence>): void => {
      pending = { ...pending, ...partial };
      if (timer === null) timer = setTimeout(flush, PRESENCE_MS);
    };
    const whole = (): Partial<Presence> => {
      const state = store.getState();
      return { pageId: state.pageId, selection: state.selection, viewport: state.canvasSize.width > 0 ? viewportPresence(state.viewport, state.canvasSize) : null };
    };
    send(whole());
    // The live connection may open after this layer: it is told everything again whenever its status changes.
    const stopStatus = session.store.subscribe((state, previous) => {
      if (state.status !== previous.status) send(whole());
    });
    const stopEditor = store.subscribe((state, previous) => {
      const partial: Partial<Presence> = {};
      if (state.pageId !== previous.pageId) {
        partial.pageId = state.pageId;
        partial.cursor = null;
      }
      if (state.selection !== previous.selection) partial.selection = state.selection;
      if (state.viewport !== previous.viewport || state.canvasSize !== previous.canvasSize) {
        partial.viewport = state.canvasSize.width > 0 ? viewportPresence(state.viewport, state.canvasSize) : null;
      }
      if (Object.keys(partial).length > 0) send(partial);
    });
    const onMove = (event: PointerEvent): void => {
      const rect = element.getBoundingClientRect();
      const point = screenToWorld(store.getState().viewport, { x: event.clientX - rect.left, y: event.clientY - rect.top });
      send({ cursor: { x: Math.round(point.x * 10) / 10, y: Math.round(point.y * 10) / 10 } });
    };
    const onLeave = (): void => send({ cursor: null });
    element.addEventListener('pointermove', onMove);
    element.addEventListener('pointerleave', onLeave);
    return () => {
      stopStatus();
      stopEditor();
      element.removeEventListener('pointermove', onMove);
      element.removeEventListener('pointerleave', onLeave);
      if (timer !== null) clearTimeout(timer);
    };
  }, [host, session, store]);

  // ------------------------------------------------------------ the Comment tool: a click on the canvas places a comment
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let spaceDown = false;
    let took: number | null = null;
    const onDown = (event: PointerEvent): void => {
      const state = session.store.getState();
      const onCanvas = event.target instanceof HTMLCanvasElement;
      if (!state.commentMode) {
        // Pressing the canvas puts away the open comment.
        if (onCanvas && (state.openThreadId || state.draft)) session.store.setState({ openThreadId: null, draft: null });
        return;
      }
      // Panning still works while commenting: the middle button, or Space held.
      if (!onCanvas || event.button !== 0 || spaceDown) return;
      event.stopPropagation();
      event.preventDefault();
      took = event.pointerId;
      const rect = element.getBoundingClientRect();
      const editor = store.getState();
      // On the layer under the click, when there is one, so that the comment follows it.
      session.setDraft(pinAt(editor.doc, editor.pageId, editor.viewport, { x: event.clientX - rect.left, y: event.clientY - rect.top }));
    };
    const onUp = (event: PointerEvent): void => {
      if (took === event.pointerId) {
        took = null;
        event.stopPropagation();
      }
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.code === 'Space') spaceDown = true;
      const state = session.store.getState();
      const typing = event.target instanceof HTMLElement && event.target.closest('input, textarea, select, [contenteditable="true"]') !== null;
      if (event.key === 'Escape' && !typing) {
        if (state.draft || state.openThreadId) session.store.setState({ draft: null, openThreadId: null });
        else if (state.commentMode) session.setCommentMode(false);
        else if (state.following) session.follow(null);
        return;
      }
      // Another tool's shortcut puts the Comment tool down.
      if (!typing && state.commentMode) {
        const command = commandForKey(event);
        if (command && command.group === 'Tools' && command.id !== 'tool.comment') session.setCommentMode(false);
      }
    };
    const onKeyUp = (event: KeyboardEvent): void => {
      if (event.code === 'Space') spaceDown = false;
    };
    element.addEventListener('pointerdown', onDown, true);
    element.addEventListener('pointerup', onUp, true);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      element.removeEventListener('pointerdown', onDown, true);
      element.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [host, session, store]);

  // The canvas shows the Comment tool's pointer while it is in hand.
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    if (commentMode) element.setAttribute('data-comment-mode', 'true');
    else element.removeAttribute('data-comment-mode');
  }, [host, commentMode]);

  // ------------------------------------------------------------ following someone's view, until this person moves
  const applied = useRef<unknown>(null);
  const followed = following ? peers.find((peer) => peer.clientId === following) : undefined;
  useEffect(() => {
    if (!followed?.presence?.viewport) return;
    const state = store.getState();
    if (state.canvasSize.width === 0) return;
    const theirs = followed.presence;
    applied.current = 'applying';
    if (theirs.pageId && theirs.pageId !== state.pageId && state.doc.nodes[theirs.pageId]) state.setPage(theirs.pageId);
    const next = followViewport(theirs.viewport as NonNullable<Presence['viewport']>, store.getState().canvasSize);
    const current = store.getState().viewport;
    if (Math.abs(current.x - next.x) > 1e-6 || Math.abs(current.y - next.y) > 1e-6 || Math.abs(current.zoom - next.zoom) > 1e-9) store.getState().setViewport(next);
    applied.current = store.getState().viewport;
  }, [followed, store]);
  useEffect(() => {
    if (!following) return;
    return store.subscribe((state, previous) => {
      if (applied.current === 'applying') return;
      // A view this person chose themselves (scrolling, zooming, another page) ends following.
      if ((state.viewport !== previous.viewport && state.viewport !== applied.current) || state.pageId !== previous.pageId) session.follow(null);
    });
  }, [following, store, session]);

  // ------------------------------------------------------------ what is drawn
  const others = peers.filter((peer) => peer.clientId !== you?.clientId);
  const people = useMemo<Mentionable[]>(() => {
    const list: Mentionable[] = members.map((member) => ({ id: member.user.id, name: member.user.name, email: member.user.email }));
    for (const peer of peers) if (!peer.user.guest && !list.some((person) => person.id === peer.user.id)) list.push({ id: peer.user.id, name: peer.user.name });
    return list.filter((person) => person.id !== meId);
  }, [members, peers, meId]);

  const onPage = Object.values(threads).filter((thread) => thread.pageId === pageId && (!thread.resolved || thread.id === openId));
  const open = openId ? threads[openId] : undefined;
  const pinScreen = (thread: Pick<Thread, 'pageId' | 'x' | 'y' | 'nodeId'>) => worldToScreen(viewport, threadAnchor(doc, thread));
  const popoverAt = (point: { x: number; y: number }): { left: number; top: number } => ({
    left: Math.max(8, Math.min(point.x + 22, size.width - POPOVER_WIDTH - 8)),
    top: Math.max(8, Math.min(point.y - 28, size.height - 200)),
  });

  return (
    <div className="pointer-events-none absolute inset-0 z-[5] overflow-hidden" aria-label="Collaboration" role="group">
      <style>{`[data-comment-mode="true"] canvas { cursor: ${COMMENT_CURSOR} !important; }`}</style>

      {/* Others' selections: their colour round each layer they have selected. */}
      <svg className="absolute left-0 top-0" width={size.width} height={size.height} aria-hidden="true">
        {others.map((peer) =>
          selectionOutlines(doc, peer.presence, pageId, viewport).map((corners, index) => (
            <polygon key={`${peer.clientId}:${index}`} points={corners.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" stroke={peer.user.color} strokeWidth={1.5} />
          )),
        )}
      </svg>

      {/* Comment pins. */}
      {onPage.map((thread) => {
        const first = thread.comments[0];
        if (!first) return null;
        const at = pinScreen(thread);
        const selected = thread.id === openId;
        return (
          <button
            key={thread.id}
            type="button"
            className="pointer-events-auto absolute flex h-7 w-7 items-center justify-center border-0 p-0.5 shadow-[var(--ev-shadow-pop)] transition-transform duration-100 hover:scale-110"
            style={{
              left: at.x,
              top: at.y - 28,
              borderRadius: '14px 14px 14px 2px',
              background: thread.resolved ? 'var(--ev-field-strong)' : selected ? 'var(--ev-accent)' : 'var(--ev-elevated)',
            }}
            aria-label={`Comment by ${first.author.name}: ${plainBody(first.body)}`}
            aria-expanded={selected}
            onClick={() => session.openThread(selected ? null : thread.id)}
          >
            <Avatar name={first.author.name} color={first.author.color} size={22} />
            {thread.comments.length > 1 && (
              <span aria-hidden="true" className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[9.5px] font-bold text-white">
                {thread.comments.length}
              </span>
            )}
          </button>
        );
      })}

      {/* Others' pointers, with their names. */}
      {others.map((peer) => (
        <RemoteCursor key={peer.clientId} peer={peer} at={cursorOnScreen(peer.presence, pageId, viewport)} />
      ))}

      {/* The open thread, beside its pin. */}
      {open && open.pageId === pageId && (
        <div className="ev-popover pointer-events-auto absolute" style={{ width: POPOVER_WIDTH, ...popoverAt(pinScreen(open)) }} role="dialog" aria-label="Comment thread">
          <ThreadView
            thread={open}
            meId={meId}
            moderate={role === 'owner' || role === 'editor'}
            people={people}
            onClose={() => session.openThread(null)}
            onReply={(body) => session.reply(open.id, body)}
            onResolve={(resolved) => session.setResolved(open.id, resolved)}
            onDelete={() => session.deleteThread(open.id)}
            onEdit={(comment, body) => session.editComment(comment.id, body)}
            onDeleteComment={(comment) => session.deleteComment(open.id, comment.id)}
          />
        </div>
      )}

      {/* A new comment being written where the Comment tool was clicked. */}
      {draft && draft.pageId === pageId && (
        <>
          <span
            aria-hidden="true"
            className="absolute flex h-7 w-7 items-center justify-center p-0.5 shadow-[var(--ev-shadow-pop)]"
            style={{ left: pinScreen(draft).x, top: pinScreen(draft).y - 28, borderRadius: '14px 14px 14px 2px', background: 'var(--ev-accent)' }}
          >
            {me && <Avatar name={me.name} color={me.color} size={22} />}
          </span>
          <div className="ev-popover pointer-events-auto absolute p-2.5" style={{ width: POPOVER_WIDTH, ...popoverAt(pinScreen(draft)) }} role="dialog" aria-label="New comment">
            <CommentComposer
              people={people}
              label="Comment"
              placeholder="Add a comment"
              submitLabel="Post comment"
              autoFocus
              onCancel={() => session.setDraft(null)}
              onSubmit={async (body) => {
                await session.postThread(draft, body);
              }}
            />
          </div>
        </>
      )}

      {/* While following someone, their colour frames the canvas. */}
      {followed && (
        <div className="absolute inset-0 rounded-[inherit]" style={{ boxShadow: `inset 0 0 0 2px ${followed.user.color}` }}>
          <div className="pointer-events-auto absolute left-1/2 top-2 flex -translate-x-1/2 items-center gap-2 rounded-full py-1 pl-3 pr-1 text-[11.5px] font-medium shadow-[var(--ev-shadow-pop)]" style={{ background: followed.user.color, color: inkOn(followed.user.color) }}>
            Following {followed.user.name}
            <button type="button" className="rounded-full border-0 bg-black/20 px-2 py-0.5 text-[11px] text-inherit hover:bg-black/30" onClick={() => session.follow(null)}>
              Stop
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Someone else's pointer: an arrow in their colour with their name beside it. */
function RemoteCursor({ peer, at }: { peer: Peer; at: { x: number; y: number } | null }) {
  const [shown, setShown] = useState(at);
  // A pointer that has just left keeps its last place, hidden, so it glides back in from there.
  useEffect(() => {
    if (at) setShown(at);
  }, [at]);
  if (!shown) return null;
  const ink = inkOn(peer.user.color);
  return (
    <div
      className="absolute left-0 top-0 transition-[transform,opacity] duration-75 ease-linear"
      style={{ transform: `translate(${shown.x}px, ${shown.y}px)`, opacity: at ? 1 : 0 }}
      data-cursor={peer.user.name}
      aria-hidden="true"
    >
      <svg width="18" height="20" viewBox="0 0 18 20" className="block drop-shadow-[0_1px_2px_rgba(0,0,0,0.4)]">
        <path d="M1.5 1.5l13.5 7-6 1.6-3.2 5.6z" fill={peer.user.color} stroke="#fff" strokeWidth="1.2" strokeLinejoin="round" />
      </svg>
      <span className="absolute left-3.5 top-4 whitespace-nowrap rounded-[6px] px-1.5 py-0.5 text-[11px] font-medium leading-tight shadow-[0_1px_3px_rgba(0,0,0,0.3)]" style={{ background: peer.user.color, color: ink }}>
        {peer.user.name}
        {peer.user.guest ? ' (guest)' : ''}
      </span>
    </div>
  );
}
