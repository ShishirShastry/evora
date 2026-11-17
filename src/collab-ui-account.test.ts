import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ACCOUNT_KEY,
  clearAccount,
  clearGuest,
  currentAuth,
  getAccount,
  getGuest,
  GUEST_KEY,
  initialsOf,
  setAccount,
  setAccountStorage,
  setGuest,
  subscribeAccount,
  updateAccountUser,
  type KeyValueStore,
} from './collab/account';

/**
 * The account and guest identity kept on this device: what is stored under
 * which key, what a request is sent with, what happens to stored values that
 * cannot be read, and who is told when either changes.
 */

class MemoryKeyValues implements KeyValueStore {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
}

const user = { id: 'u1', email: 'ana@example.com', name: 'Ana Lima', color: '#0d99ff', createdAt: '2026-11-17T10:00:00.000Z' };
const guest = { id: 'g1', name: 'Visitor', color: '#f24e1e' };

let storage: MemoryKeyValues;
beforeEach(() => {
  storage = new MemoryKeyValues();
  setAccountStorage(storage);
});
afterEach(() => setAccountStorage(null));

describe('the account kept on this device', () => {
  it('is kept under evora:account and read back', () => {
    expect(getAccount()).toBeNull();
    setAccount({ token: 'session-1', user });
    expect(JSON.parse(storage.getItem(ACCOUNT_KEY) as string)).toEqual({ token: 'session-1', user });
    expect(getAccount()).toEqual({ token: 'session-1', user });
  });

  it('is the same object until it changes, as React asks of a store', () => {
    setAccount({ token: 'session-1', user });
    const first = getAccount();
    expect(getAccount()).toBe(first);
    updateAccountUser({ ...user, name: 'Ana L.' });
    expect(getAccount()).not.toBe(first);
    expect(getAccount()?.user.name).toBe('Ana L.');
    expect(getAccount()?.token).toBe('session-1');
  });

  it('is forgotten when signing out', () => {
    setAccount({ token: 'session-1', user });
    clearAccount();
    expect(getAccount()).toBeNull();
    expect(storage.getItem(ACCOUNT_KEY)).toBeNull();
  });

  it('ignores stored values that cannot be read', () => {
    storage.setItem(ACCOUNT_KEY, '{not json');
    expect(getAccount()).toBeNull();
    storage.setItem(ACCOUNT_KEY, JSON.stringify({ token: '', user }));
    expect(getAccount()).toBeNull();
    storage.setItem(ACCOUNT_KEY, JSON.stringify({ token: 'x', user: { id: 'u1' } }));
    expect(getAccount()).toBeNull();
  });

  it('works without storage at all, keeping nothing', () => {
    setAccountStorage(null);
    setAccount({ token: 'session-1', user });
    expect(getAccount()).toBeNull();
    expect(currentAuth()).toEqual({ token: null, guestToken: null });
  });

  it('survives storage that refuses to be read or written', () => {
    setAccountStorage({
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    });
    expect(() => setAccount({ token: 'session-1', user })).not.toThrow();
    expect(getAccount()).toBeNull();
  });
});

describe('the guest identity', () => {
  it('is kept under evora:guest', () => {
    setGuest({ guestToken: 'guest-1', guest });
    expect(JSON.parse(storage.getItem(GUEST_KEY) as string)).toEqual({ guestToken: 'guest-1', guest });
    expect(getGuest()).toEqual({ guestToken: 'guest-1', guest });
    clearGuest();
    expect(getGuest()).toBeNull();
  });

  it('is what requests carry while nobody is signed in', () => {
    expect(currentAuth()).toEqual({ token: null, guestToken: null });
    setGuest({ guestToken: 'guest-1', guest });
    expect(currentAuth()).toEqual({ token: null, guestToken: 'guest-1' });
  });

  it('is replaced by the account when the guest signs in', () => {
    setGuest({ guestToken: 'guest-1', guest });
    setAccount({ token: 'session-1', user });
    expect(currentAuth()).toEqual({ token: 'session-1', guestToken: null });
    expect(getGuest()).toBeNull();
  });
});

describe('being told of changes', () => {
  it('calls each subscriber on every change until it unsubscribes', () => {
    const calls: string[] = [];
    const stop = subscribeAccount(() => calls.push(getAccount()?.user.name ?? 'nobody'));
    setAccount({ token: 'session-1', user });
    updateAccountUser({ ...user, name: 'Ana L.' });
    clearAccount();
    setGuest({ guestToken: 'guest-1', guest });
    stop();
    setAccount({ token: 'session-2', user });
    expect(calls).toEqual(['Ana Lima', 'Ana L.', 'nobody', 'nobody']);
  });
});

describe('initials for avatars', () => {
  it('takes the first letters of the first two words, or of an email address', () => {
    expect(initialsOf('Ana Lima')).toBe('AL');
    expect(initialsOf('ana')).toBe('A');
    expect(initialsOf('Jean-Luc Picard Third')).toBe('JL');
    expect(initialsOf('ana.lima@example.com')).toBe('AL');
    expect(initialsOf('   ')).toBe('?');
    expect(initialsOf('élodie')).toBe('É');
  });
});
