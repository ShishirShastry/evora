import { getPageIdOf, getPages, isLayer, type NodeId } from '../../core';
import type { Thread } from '../../collab/protocol';
import type { EditorStore } from '../../state/editorStore';
import { useEditor, useEditorContext } from '../editor/EditorContext';
import { Icon } from '../components/Icon';
import { Avatar } from './Avatar';
import { useCollab, useCollabState } from './CollabContext';
import { centredOn, threadAnchor } from './geometry';
import { FREE_NOTE, timeAgo } from './hooks';
import { plainBody } from './mentions';
import type { CollabSession } from './session';

/** Shows a comment: its page, its pin in the middle of the canvas at the current zoom, and its thread open. */
export function goToThread(editor: EditorStore, session: CollabSession, thread: Thread): void {
  const state = editor.getState();
  if (!state.doc.nodes[thread.pageId]) {
    session.openThread(thread.id);
    return;
  }
  if (state.pageId !== thread.pageId) state.setPage(thread.pageId as NodeId);
  const now = editor.getState();
  const anchor = threadAnchor(now.doc, thread);
  if (now.canvasSize.width > 0) now.setViewport(centredOn(anchor, now.viewport, now.canvasSize));
  session.openThread(thread.id);
}

/** The time of a thread's latest comment, for putting the liveliest first. */
function lastActivity(thread: Thread): string {
  return thread.comments.reduce((latest, comment) => (comment.createdAt > latest ? comment.createdAt : latest), thread.createdAt);
}

/** The Comments tab of the right sidebar: every thread of the document, open or resolved; clicking one goes to it. */
export function CommentsPanel() {
  const session = useCollab();
  if (session.docId === null) return <LocalComments session={session} />;
  return <SharedComments />;
}

function LocalComments({ session }: { session: CollabSession }) {
  return (
    <div className="flex flex-col items-start gap-3 p-4">
      <Icon name="comment" size={20} />
      <p className="m-0 leading-relaxed text-dim">
        Comments are kept with shared files, so everyone working on the file sees them. Share this file to comment, reply and mention people.
      </p>
      <button type="button" className="ev-button ev-button-primary" onClick={() => session.openShare()}>
        Share this file
      </button>
      <p className="m-0 text-[11px] text-faint">{FREE_NOTE}</p>
    </div>
  );
}

function SharedComments() {
  const session = useCollab();
  const { store } = useEditorContext();
  const threads = useCollabState((s) => s.threads);
  const filter = useCollabState((s) => s.commentFilter);
  const openId = useCollabState((s) => s.openThreadId);
  const error = useCollabState((s) => s.threadsError);
  const doc = useEditor((s) => s.doc);
  const nodes = doc.nodes;
  const pages = getPages(doc);
  const pageName = (id: string): string => pages.find((page) => page.id === id)?.name ?? 'A deleted page';

  const shown = Object.values(threads)
    .filter((thread) => thread.resolved === (filter === 'resolved'))
    .sort((a, b) => (lastActivity(a) < lastActivity(b) ? 1 : -1));
  const counts = { open: 0, resolved: 0 };
  for (const thread of Object.values(threads)) counts[thread.resolved ? 'resolved' : 'open'] += 1;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-none items-center gap-2 px-3 pb-2 pt-3">
        <div role="tablist" aria-label="Which comments" className="ev-segmented flex-1">
          {(['open', 'resolved'] as const).map((value) => (
            <button key={value} type="button" role="tab" aria-selected={filter === value} className="ev-segment text-[11.5px]" onClick={() => session.store.setState({ commentFilter: value })}>
              {value === 'open' ? `Open (${counts.open})` : `Resolved (${counts.resolved})`}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="ev-icon-button"
          aria-label="Add a comment"
          title="Add a comment (C)"
          onClick={() => session.setCommentMode(true)}
        >
          <Icon name="plus" />
        </button>
      </div>
      {error && (
        <p role="alert" className="m-0 px-3 text-danger">
          {error}
        </p>
      )}
      {shown.length === 0 && !error && (
        <p className="m-0 px-4 py-6 text-center leading-relaxed text-dim">
          {filter === 'open' ? 'No open comments. Press C, or the comment button in the toolbar, then click the canvas to add one.' : 'No resolved comments.'}
        </p>
      )}
      <ul aria-label="Comment threads" className="m-0 min-h-0 flex-1 list-none overflow-y-auto p-1.5 pt-0">
        {shown.map((thread) => {
          const first = thread.comments[0];
          if (!first) return null;
          const replies = thread.comments.length - 1;
          const attached = thread.nodeId && isLayer(nodes[thread.nodeId]) && getPageIdOf(doc, thread.nodeId) === thread.pageId ? nodes[thread.nodeId]?.name : null;
          return (
            <li key={thread.id}>
              <button
                type="button"
                aria-current={openId === thread.id ? 'true' : undefined}
                className={`ev-row flex w-full items-start gap-2 rounded-[8px] border-0 px-2 py-2 text-left ${openId === thread.id ? 'bg-selected' : 'bg-transparent hover:bg-hover'}`}
                onClick={() => goToThread(store, session, thread)}
              >
                <Avatar name={first.author.name} color={first.author.color} size={22} />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate font-semibold text-ink">{first.author.name}</span>
                    <span className="flex-none text-[10.5px] text-faint">{timeAgo(lastActivity(thread))}</span>
                  </span>
                  <span className="line-clamp-3 break-words text-ink">{plainBody(first.body)}</span>
                  <span className="truncate text-[10.5px] text-dim">
                    {replies > 0 ? `${replies} ${replies === 1 ? 'reply' : 'replies'} · ` : ''}
                    {pages.length > 1 ? pageName(thread.pageId) : ''}
                    {attached ? `${pages.length > 1 ? ' · ' : ''}on ${attached}` : ''}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
