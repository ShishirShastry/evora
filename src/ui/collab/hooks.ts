import { useSyncExternalStore } from 'react';
import { getAccount, getGuest, subscribeAccount, type Account, type GuestIdentity } from '../../collab/account';

/** The account signed in on this device, kept up to date (also when it changes in another tab). */
export function useAccount(): Account | null {
  return useSyncExternalStore(subscribeAccount, getAccount, getAccount);
}

/** The guest identity of someone without an account, kept up to date. */
export function useGuest(): GuestIdentity | null {
  return useSyncExternalStore(subscribeAccount, getGuest, getGuest);
}

/** How long ago something happened, said briefly. */
export function timeAgo(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const minutes = Math.round((now - then) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} d ago`;
  return new Date(then).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Copies text to the clipboard; resolves to whether the browser allowed it. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the older way.
  }
  try {
    const field = document.createElement('textarea');
    field.value = text;
    field.style.position = 'fixed';
    field.style.opacity = '0';
    document.body.appendChild(field);
    field.select();
    const done = document.execCommand('copy');
    field.remove();
    return done;
  } catch {
    return false;
  }
}

export const ROLE_LABELS = { owner: 'Owner', editor: 'Can edit', viewer: 'Can view' } as const;

/** The line shown wherever collaboration is offered: it is free, for everyone, without limits. */
export const FREE_NOTE = 'Free for everyone · unlimited editors';
