import { useCallback, useEffect, useRef, useState } from 'react';
import { api as defaultApi, errorMessage, type EvoraApi } from '../../collab/api';
import type { Notification } from '../../collab/protocol';
import { Icon } from '../components/Icon';
import { Avatar } from './Avatar';
import { timeAgo } from './hooks';
import { plainBody } from './mentions';
import { Popover } from './Popover';

/** How often the list is read again while the application is open. */
const POLL_MS = 30_000;

/** What a notification says, in words. */
export function notificationTitle(notification: Notification): string {
  const who = notification.from.name;
  switch (notification.kind) {
    case 'mention':
      return `${who} mentioned you`;
    case 'reply':
      return `${who} replied to a comment`;
    case 'invite':
      return `${who} invited you to a workspace`;
    case 'shared':
      return `${who} shared a file with you`;
  }
}

/** Where a notification leads: the comment in its document, the document, or the workspace. */
export function notificationTarget(notification: Notification): string | null {
  if (notification.docId && notification.threadId) return `#/doc/${notification.docId}/comment/${notification.threadId}`;
  if (notification.docId) return `#/doc/${notification.docId}`;
  if (notification.workspaceId) return `#/workspace/${notification.workspaceId}`;
  return null;
}

/** The bell in the file browser's header: mentions, replies, invitations and files shared with you. */
export function NotificationsBell({ api = defaultApi, onOpen }: { api?: EvoraApi; onOpen: (hash: string) => void }) {
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<Notification[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .notifications()
      .then((items) => {
        setList(items);
        setError(null);
      })
      .catch((cause: unknown) => setError(errorMessage(cause)));
  }, [api]);

  useEffect(() => {
    load();
    const timer = setInterval(load, POLL_MS);
    window.addEventListener('focus', load);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', load);
    };
  }, [load]);

  const unread = list?.filter((item) => !item.read).length ?? 0;

  const markRead = (ids: string[]): void => {
    if (ids.length === 0) return;
    setList((items) => items?.map((item) => (ids.includes(item.id) ? { ...item, read: true } : item)) ?? items);
    void api.markNotificationsRead(ids).catch((cause: unknown) => setError(errorMessage(cause)));
  };

  return (
    <>
      <button
        ref={button}
        type="button"
        className="ev-icon-button relative"
        aria-label="Notifications"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={unread > 0 ? `${unread} unread` : 'Notifications'}
        onClick={() => {
          setOpen((shown) => !shown);
          load();
        }}
      >
        <Icon name="bell" />
        {unread > 0 && (
          <span aria-hidden="true" className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[9.5px] font-bold text-white">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
      {open && (
        <Popover anchor={button.current} label="Notifications" alignRight width={340} onClose={() => setOpen(false)}>
          <header className="flex h-10 flex-none items-center justify-between border-b border-line pl-3.5 pr-2">
            <h2 className="m-0 text-[12.5px] font-semibold">Notifications</h2>
            <button type="button" className="ev-button !h-6 !px-2 text-[11px]" disabled={unread === 0} onClick={() => markRead(list?.filter((item) => !item.read).map((item) => item.id) ?? [])}>
              Mark all as read
            </button>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto p-1">
            {error && (
              <p role="alert" className="m-0 p-2.5 text-danger">
                {error}
              </p>
            )}
            {list !== null && list.length === 0 && <p className="m-0 p-4 text-center text-dim">Nothing yet. Mentions, replies and invitations appear here.</p>}
            {list !== null && list.length > 0 && (
              <ul aria-label="Notifications" className="m-0 flex list-none flex-col gap-0.5 p-0">
                {list.map((item) => {
                  const target = notificationTarget(item);
                  return (
                    <li key={item.id}>
                      <button
                        type="button"
                        className="ev-row flex w-full items-start gap-2.5 rounded-[8px] border-0 bg-transparent px-2 py-2 text-left hover:bg-hover"
                        onClick={() => {
                          markRead([item.id]);
                          setOpen(false);
                          if (target) onOpen(target);
                        }}
                      >
                        <Avatar name={item.from.name} color={item.from.color} size={26} />
                        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                          <span className={item.read ? 'text-dim' : 'font-semibold text-ink'}>{notificationTitle(item)}</span>
                          {item.text && <span className="line-clamp-2 text-dim">{plainBody(item.text)}</span>}
                          <span className="text-[10.5px] text-faint">{timeAgo(item.createdAt)}</span>
                        </span>
                        {!item.read && <span aria-label="Unread" className="mt-1.5 h-2 w-2 flex-none rounded-full bg-accent" />}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </Popover>
      )}
    </>
  );
}
