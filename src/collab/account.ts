import type { AuthResult, Guest, GuestResult, User } from './protocol';

/**
 * Who is using the application, as far as the collaboration server knows:
 * the account signed in on this device (`evora:account`), and the guest
 * identity made when someone without an account opened a shared link
 * (`evora:guest`). Both are kept in local storage so they last across
 * reloads, and both are optional: files on this device need neither.
 *
 * Everything here is free and unlimited; an account only says who you are.
 */

export const ACCOUNT_KEY = 'evora:account';
export const GUEST_KEY = 'evora:guest';

export interface Account {
  token: string;
  user: User;
}

export interface GuestIdentity {
  guestToken: string;
  guest: Guest;
}

/** What a request to the server carries: the account's session, or failing that the guest's token. */
export interface Auth {
  token: string | null;
  guestToken: string | null;
}

/** The part of the Web Storage interface used here, so tests can give their own. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function browserStorage(): KeyValueStore | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // Storage can be refused (a private window with site data blocked).
    return null;
  }
}

let backing: KeyValueStore | null = browserStorage();
const listeners = new Set<() => void>();

/** Replaces where the identities are kept (tests), and tells subscribers. Null keeps nothing. */
export function setAccountStorage(store: KeyValueStore | null): void {
  backing = store;
  cache.clear();
  notify();
}

function read(key: string): string | null {
  try {
    return backing?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) backing?.removeItem(key);
    else backing?.setItem(key, value);
  } catch {
    // Storage that refuses writes keeps the identity for this page only (see the cache).
  }
}

/**
 * The parsed value of each key, by the text it was parsed from: so that the
 * same object is returned until the stored text changes (React's
 * `useSyncExternalStore` asks for a stable value).
 */
const cache = new Map<string, { raw: string | null; value: unknown }>();

function cached<T>(key: string, parse: (value: unknown) => T | null): T | null {
  const raw = read(key);
  const hit = cache.get(key);
  if (hit && hit.raw === raw) return hit.value as T | null;
  let value: T | null = null;
  if (raw !== null) {
    try {
      value = parse(JSON.parse(raw));
    } catch {
      value = null;
    }
  }
  cache.set(key, { raw, value });
  return value;
}

const isString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

function parseUser(value: unknown): User | null {
  if (!value || typeof value !== 'object') return null;
  const user = value as Partial<User>;
  if (!isString(user.id) || typeof user.email !== 'string' || typeof user.name !== 'string') return null;
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    color: typeof user.color === 'string' ? user.color : '#0d99ff',
    createdAt: typeof user.createdAt === 'string' ? user.createdAt : '',
  };
}

function parseAccount(value: unknown): Account | null {
  if (!value || typeof value !== 'object') return null;
  const { token, user } = value as { token?: unknown; user?: unknown };
  const parsedUser = parseUser(user);
  return isString(token) && parsedUser ? { token, user: parsedUser } : null;
}

function parseGuest(value: unknown): GuestIdentity | null {
  if (!value || typeof value !== 'object') return null;
  const { guestToken, guest } = value as { guestToken?: unknown; guest?: Partial<Guest> };
  if (!isString(guestToken) || !guest || !isString(guest.id) || typeof guest.name !== 'string') return null;
  return { guestToken, guest: { id: guest.id, name: guest.name, color: typeof guest.color === 'string' ? guest.color : '#0d99ff' } };
}

/** The account signed in on this device, or null. */
export function getAccount(): Account | null {
  return cached(ACCOUNT_KEY, parseAccount);
}

/** Keeps the account from signing up or in. A guest identity is no longer needed once signed in, so it is forgotten. */
export function setAccount(result: AuthResult | Account): void {
  write(ACCOUNT_KEY, JSON.stringify({ token: result.token, user: result.user }));
  write(GUEST_KEY, null);
  notify();
}

/** Replaces the signed-in person's details (after changing their name), keeping the session. */
export function updateAccountUser(user: User): void {
  const account = getAccount();
  if (!account) return;
  write(ACCOUNT_KEY, JSON.stringify({ token: account.token, user }));
  notify();
}

/** Forgets the account (signing out). */
export function clearAccount(): void {
  write(ACCOUNT_KEY, null);
  notify();
}

/** The guest identity of someone without an account, or null. */
export function getGuest(): GuestIdentity | null {
  return cached(GUEST_KEY, parseGuest);
}

export function setGuest(result: GuestResult | GuestIdentity): void {
  write(GUEST_KEY, JSON.stringify({ guestToken: result.guestToken, guest: result.guest }));
  notify();
}

export function clearGuest(): void {
  write(GUEST_KEY, null);
  notify();
}

/** The credentials for a request: the account's session when signed in, otherwise the guest's token, if any. */
export function currentAuth(): Auth {
  const account = getAccount();
  if (account) return { token: account.token, guestToken: null };
  return { token: null, guestToken: getGuest()?.guestToken ?? null };
}

function notify(): void {
  for (const listener of [...listeners]) listener();
}

/**
 * Calls `listener` whenever the account or the guest identity changes, here
 * or in another tab of the same browser. Returns the function that stops it.
 */
export function subscribeAccount(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1 && typeof window !== 'undefined') window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
  };
}

function onStorage(event: StorageEvent): void {
  if (event.key === null || event.key === ACCOUNT_KEY || event.key === GUEST_KEY) notify();
}

/** Initials for an avatar: the first letters of the first two words of a name, or of an email address. */
export function initialsOf(name: string): string {
  const words = name
    .replace(/@.*$/, '')
    .split(/[\s._-]+/)
    .filter((word) => word.length > 0);
  const letters = words.slice(0, 2).map((word) => Array.from(word)[0] ?? '');
  return letters.join('').toUpperCase() || '?';
}
