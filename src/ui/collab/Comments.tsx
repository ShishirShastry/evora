import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { errorMessage } from '../../collab/api';
import type { Comment, Thread } from '../../collab/protocol';
import { Icon } from '../components/Icon';
import { PopupMenu, type MenuItem } from '../components/Menu';
import { Avatar } from './Avatar';
import { timeAgo } from './hooks';
import { decodeBody, encodeBody, insertMention, matchMentions, mentionQueryAt, parseBody, type Mentionable } from './mentions';

/** A comment's text, with its mentions picked out. */
export function CommentBody({ body }: { body: string }) {
  return (
    <p className="m-0 whitespace-pre-wrap break-words leading-relaxed text-ink">
      {parseBody(body).map((part, index) =>
        part.kind === 'text' ? (
          <span key={index}>{part.text}</span>
        ) : (
          <span key={index} className="rounded-[4px] bg-selected px-0.5 font-medium text-accent">
            @{part.name}
          </span>
        ),
      )}
    </p>
  );
}

interface ComposerProps {
  /** The people who can be mentioned. */
  people: readonly Mentionable[];
  label: string;
  placeholder: string;
  submitLabel: string;
  /** A stored comment text to start from (when editing one). */
  initial?: string;
  /** Posts the comment's stored text; a rejection is shown under the field. */
  onSubmit: (body: string) => Promise<void>;
  onCancel?: () => void;
  autoFocus?: boolean;
}

/**
 * Where a comment is written. Typing `@` offers the people who can be
 * mentioned; one picked with the mouse, Enter or Tab goes in as `@Name`, and
 * is written as `@[Name](userId)` when the comment is posted. Enter posts,
 * Shift+Enter starts a new line, Escape closes the list or cancels.
 */
export function CommentComposer({ people, label, placeholder, submitLabel, initial, onSubmit, onCancel, autoFocus }: ComposerProps) {
  const start = initial ? decodeBody(initial) : { text: '', mentions: [] };
  const [text, setText] = useState(start.text);
  const [picked, setPicked] = useState<Mentionable[]>(start.mentions);
  const [caret, setCaret] = useState(start.text.length);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!autoFocus) return;
    const timer = setTimeout(() => {
      const element = field.current;
      if (!element) return;
      element.focus({ preventScroll: true });
      element.setSelectionRange(element.value.length, element.value.length);
    }, 0);
    return () => clearTimeout(timer);
  }, [autoFocus]);

  const typing = mentionQueryAt(text, caret);
  const matches = typing && dismissed !== typing.start ? matchMentions(people, typing.query) : [];
  const listOpen = matches.length > 0;

  const pick = (person: Mentionable): void => {
    const next = insertMention(text, caret, person);
    setText(next.text);
    setCaret(next.caret);
    setPicked((list) => (list.some((known) => known.id === person.id) ? list : [...list, person]));
    setActive(0);
    requestAnimationFrame(() => {
      const element = field.current;
      if (!element) return;
      element.focus();
      // Only while nothing more has been typed: a quick typist's caret is not taken back.
      if (element.value === next.text) element.setSelectionRange(next.caret, next.caret);
    });
  };

  const submit = (): void => {
    const body = encodeBody(text, picked);
    if (!body || busy) return;
    setBusy(true);
    setError(null);
    onSubmit(body)
      .then(() => {
        setText('');
        setPicked([]);
        setCaret(0);
      })
      .catch((cause: unknown) => setError(errorMessage(cause)))
      .finally(() => setBusy(false));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (listOpen) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setActive((index) => (index + step + matches.length) % matches.length);
        event.preventDefault();
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        const person = matches[Math.min(active, matches.length - 1)];
        if (person) pick(person);
        event.preventDefault();
        return;
      }
      if (event.key === 'Escape') {
        setDismissed(typing?.start ?? null);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    } else if (event.key === 'Escape' && onCancel) {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    }
  };

  return (
    <div className="relative flex flex-col gap-1.5">
      <div className="flex items-end gap-1.5">
        <textarea
          ref={field}
          aria-label={label}
          placeholder={placeholder}
          rows={Math.min(6, Math.max(1, text.split('\n').length))}
          className="ev-field min-h-[30px] flex-1 resize-none !py-1.5 leading-[1.4]"
          value={text}
          aria-autocomplete="list"
          aria-expanded={listOpen}
          onChange={(event) => {
            setText(event.target.value);
            setCaret(event.target.selectionStart);
            setActive(0);
          }}
          onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
        />
        <button type="button" className="ev-icon-button ev-button-primary !h-[30px] !w-[30px] flex-none !text-white" aria-label={submitLabel} title={`${submitLabel} (Enter)`} disabled={busy || !text.trim()} onClick={submit}>
          <Icon name="send" size={14} />
        </button>
      </div>
      {listOpen && (
        <ul role="listbox" aria-label="People to mention" className="ev-popover absolute left-0 top-full z-10 m-0 mt-1 w-full list-none p-1">
          {matches.map((person, index) => (
            <li
              key={person.id}
              role="option"
              aria-selected={index === active}
              className={`flex h-8 cursor-default items-center gap-2 rounded-[6px] px-2 ${index === active ? 'bg-accent text-accent-ink' : ''}`}
              onPointerDown={(event) => {
                // Keep the field's focus and caret: the pick happens on the press.
                event.preventDefault();
                pick(person);
              }}
              onMouseEnter={() => setActive(index)}
            >
              <span className="truncate font-medium">{person.name}</span>
              {person.email && <span className={`truncate text-[11px] ${index === active ? 'text-accent-ink/80' : 'text-dim'}`}>{person.email}</span>}
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" className="m-0 text-danger">
          {error}
        </p>
      )}
      {onCancel && initial !== undefined && (
        <div className="flex justify-end">
          <button type="button" className="ev-button !h-6 !px-2 text-[11px]" onClick={onCancel}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

interface ThreadViewProps {
  thread: Thread;
  /** The person looking, to tell their own comments. */
  meId: string | null;
  /** May delete anyone's thread (owners and editors). */
  moderate: boolean;
  people: readonly Mentionable[];
  onReply: (body: string) => Promise<void>;
  onResolve: (resolved: boolean) => Promise<void>;
  onDelete: () => Promise<void>;
  onEdit: (comment: Comment, body: string) => Promise<void>;
  onDeleteComment: (comment: Comment) => Promise<void>;
  onClose: () => void;
}

/** A comment thread: its comments, replying, editing and deleting one's own, resolving and reopening. */
export function ThreadView({ thread, meId, moderate, people, onReply, onResolve, onDelete, onEdit, onDeleteComment, onClose }: ThreadViewProps) {
  const [editing, setEditing] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const first = thread.comments[0];
  const mayDelete = moderate || (first !== undefined && first.author.id === meId);
  const attempt = (action: () => Promise<void>): void => {
    setError(null);
    void action().catch((cause: unknown) => setError(errorMessage(cause)));
  };

  return (
    <div className="flex max-h-[420px] flex-col">
      <header className="flex h-10 flex-none items-center gap-1 border-b border-line pl-3 pr-1.5">
        <h3 className="m-0 flex-1 text-[12px] font-semibold">{thread.resolved ? 'Resolved comment' : 'Comment'}</h3>
        <button
          type="button"
          className="ev-icon-button !h-7 !w-7"
          aria-label={thread.resolved ? 'Reopen' : 'Resolve'}
          title={thread.resolved ? 'Reopen' : 'Resolve'}
          aria-pressed={thread.resolved}
          onClick={() => attempt(() => onResolve(!thread.resolved))}
        >
          <Icon name="check" size={14} />
        </button>
        {mayDelete && (
          <button
            type="button"
            className="ev-icon-button !h-7 !w-7"
            aria-label="Thread actions"
            aria-haspopup="menu"
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              setMenu({ x: rect.right - 210, y: rect.bottom + 4, items: [{ label: 'Delete thread', danger: true, onSelect: () => attempt(onDelete) }] });
            }}
          >
            <Icon name="more" size={14} />
          </button>
        )}
        <button type="button" className="ev-icon-button !h-7 !w-7" aria-label="Close comment" onClick={onClose}>
          <Icon name="close" size={14} />
        </button>
      </header>
      <ol aria-label="Comments" className="m-0 flex min-h-0 flex-1 list-none flex-col gap-3 overflow-y-auto p-3">
        {thread.comments.map((comment) => {
          const mine = comment.author.id === meId;
          return (
            <li key={comment.id} className="group flex gap-2">
              <Avatar name={comment.author.name} color={comment.author.color} size={22} />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <div className="flex items-center gap-1.5">
                  <span className="truncate font-semibold">{comment.author.name}</span>
                  {comment.author.guest && <span className="text-[10.5px] text-faint">guest</span>}
                  <span className="flex-none text-[10.5px] text-faint">
                    {timeAgo(comment.createdAt)}
                    {comment.editedAt ? ' · edited' : ''}
                  </span>
                  <div className="flex-1" />
                  {mine && editing !== comment.id && (
                    <span className="flex flex-none gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                      <button type="button" className="ev-button !h-5 !px-1.5 text-[10.5px]" aria-label="Edit comment" onClick={() => setEditing(comment.id)}>
                        Edit
                      </button>
                      <button type="button" className="ev-button ev-button-danger !h-5 !px-1.5 text-[10.5px]" aria-label="Delete comment" onClick={() => attempt(() => onDeleteComment(comment))}>
                        Delete
                      </button>
                    </span>
                  )}
                </div>
                {editing === comment.id ? (
                  <CommentComposer
                    people={people}
                    label="Edit comment"
                    placeholder="Comment"
                    submitLabel="Save comment"
                    initial={comment.body}
                    autoFocus
                    onCancel={() => setEditing(null)}
                    onSubmit={async (body) => {
                      await onEdit(comment, body);
                      setEditing(null);
                    }}
                  />
                ) : (
                  <CommentBody body={comment.body} />
                )}
              </div>
            </li>
          );
        })}
      </ol>
      {error && (
        <p role="alert" className="m-0 px-3 pb-2 text-danger">
          {error}
        </p>
      )}
      <div className="flex-none border-t border-line p-2.5">
        <CommentComposer people={people} label="Reply" placeholder="Reply" submitLabel="Post reply" autoFocus onSubmit={onReply} onCancel={onClose} />
      </div>
      {menu && <PopupMenu x={menu.x} y={menu.y} items={menu.items} label="Thread actions" onClose={() => setMenu(null)} />}
    </div>
  );
}
