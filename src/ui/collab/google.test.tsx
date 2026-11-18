// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getAccount, setAccountStorage, type KeyValueStore } from '../../collab/account';
import { createApi, googleStartUrl } from '../../collab/api';
import type { AuthResult } from '../../collab/protocol';
import { parseRoute } from '../App';
import { AccountDialog } from './AccountDialog';
import type { GoogleSignInResult } from '../../persistence/desktopContract';
import { GOOGLE_RETURN_KEY, GoogleButton, finishDesktopGoogleSignIn, listenForDesktopGoogleReturn, readGoogleReturn, rememberGoogleReturn } from './google';
import { GoogleReturnScreen } from './Screens';

/**
 * "Continue with Google" in the app: the button is there, in both the sign-in
 * and the create-account views, only when the server offers Google; it sends
 * the window to the server's start address with the app's origin, the mode
 * and any invite, after remembering where the person was; and coming back
 * redeems the ticket, keeps the account and goes back there.
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

const result: AuthResult = {
  token: 'session-token',
  user: { id: 'u1', email: 'hedy@gmail.example', name: 'Hedy', color: '#0d99ff', createdAt: '2026-11-17T10:00:00.000Z' },
};

/** A server that offers Google or not, and redeems one ticket once. */
function server(google: boolean | 'unreachable') {
  const calls: string[] = [];
  let redeemed = false;
  const api = createApi({
    auth: () => ({ token: null, guestToken: null }),
    fetch: async (url, init) => {
      calls.push(`${init.method ?? 'GET'} ${url}`);
      if (url === '/api/auth/providers') {
        if (google === 'unreachable') throw new TypeError('Failed to fetch');
        return Response.json({ google });
      }
      if (url === '/api/auth/google/redeem') {
        const { ticket } = JSON.parse(String(init.body)) as { ticket: string };
        if (ticket !== 'good-ticket' || redeemed) return Response.json({ error: 'This sign-in has expired or was already used: try again' }, { status: 401 });
        redeemed = true;
        return Response.json(result);
      }
      if (url === '/api/invites/inv123/accept') return Response.json({ id: 'w9', name: 'Team', role: 'viewer', memberCount: 2, createdAt: '' });
      return Response.json({ error: 'Not found' }, { status: 404 });
    },
  });
  return { api, calls };
}

beforeEach(() => {
  setAccountStorage(new MemoryKeyValues());
  sessionStorage.clear();
  window.location.hash = '';
});

afterEach(() => {
  cleanup();
  setAccountStorage(null);
});

describe('Continue with Google', () => {
  it('builds the start address with the origin, the mode and any invite', () => {
    expect(googleStartUrl('http://localhost:5173', 'login')).toBe('/api/auth/google/start?origin=http%3A%2F%2Flocalhost%3A5173&mode=login');
    expect(googleStartUrl('https://evora.example.com', 'signup', 'tok_en-1')).toBe(
      '/api/auth/google/start?origin=https%3A%2F%2Fevora.example.com&mode=signup&invite=tok_en-1',
    );
  });

  it('shows the button in both views when the server offers Google, before the email form', async () => {
    const { api } = server(true);
    render(<AccountDialog mode="signin" onClose={() => undefined} api={api} navigate={() => undefined} />);
    const button = await screen.findByRole('button', { name: 'Continue with Google' });
    expect(button.className).toContain('ev-button');
    expect(button.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    // Above the email field.
    expect(button.compareDocumentPosition(screen.getByLabelText('Email')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Create account' }));
    expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeTruthy();
    // The existing controls keep their names.
    expect(screen.getByRole('button', { name: 'Create account' })).toBeTruthy();
  });

  it('hides the button when the server does not offer Google, or cannot be asked', async () => {
    for (const google of [false, 'unreachable'] as const) {
      const { api, calls } = server(google);
      render(<AccountDialog mode="signup" onClose={() => undefined} api={api} />);
      await waitFor(() => expect(calls).toContain('GET /api/auth/providers'));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(screen.queryByRole('button', { name: 'Continue with Google' })).toBeNull();
      expect(screen.getByRole('button', { name: 'Create account' })).toBeTruthy();
      cleanup();
    }
  });

  it('remembers where the person was and sends the window to the start address', async () => {
    window.location.hash = '#/invite/inv123';
    const { api } = server(true);
    const visited: string[] = [];
    render(<AccountDialog mode="signup" onClose={() => undefined} api={api} invite="inv123" navigate={(url) => visited.push(url)} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Continue with Google' }));
    expect(visited).toEqual([googleStartUrl(window.location.origin, 'signup', 'inv123')]);
    expect(JSON.parse(sessionStorage.getItem(GOOGLE_RETURN_KEY) as string)).toEqual({ hash: '#/invite/inv123', invite: 'inv123' });

    fireEvent.click(screen.getByRole('tab', { name: 'Sign in' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue with Google' }));
    expect(visited[1]).toContain('mode=login');
  });

  it('in the desktop app, opens the sign-in in the system browser instead of leaving the window', async () => {
    window.location.hash = '#/doc/abc';
    const visited: string[] = [];
    const asked: Array<{ mode: string; invite: string | null }> = [];
    let answer = { ok: true, message: null as string | null };
    const desktop = {
      startGoogleSignIn: async (request: { mode: 'login' | 'signup'; invite: string | null }) => {
        asked.push(request);
        return answer;
      },
    };
    render(<GoogleButton mode="signup" invite="inv123" navigate={(url) => visited.push(url)} desktop={desktop} />);
    fireEvent.click(screen.getByRole('button', { name: 'Continue with Google' }));
    expect(asked).toEqual([{ mode: 'signup', invite: 'inv123' }]);
    expect(visited).toEqual([]);
    expect(JSON.parse(sessionStorage.getItem(GOOGLE_RETURN_KEY) as string)).toEqual({ hash: '#/doc/abc', invite: 'inv123' });
    expect((await screen.findByRole('status')).textContent).toMatch(/in your browser, then click Open Evora/);

    // No server chosen: said, as an alert.
    answer = { ok: false, message: 'Choose a collaboration server first.' };
    fireEvent.click(screen.getByRole('button', { name: 'Continue with Google' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Choose a collaboration server first.');
  });

  it('in the desktop app, keeps the session that comes back where the window is, and says so', async () => {
    window.location.hash = '#/doc/abc';
    let deliver: ((result: GoogleSignInResult) => void) | null = null;
    const desktop = {
      startGoogleSignIn: async () => ({ ok: true, message: null }),
      onGoogleReturn: (callback: (result: GoogleSignInResult) => void) => {
        deliver = callback;
        return () => {
          deliver = null;
        };
      },
    };
    const { calls, api } = server(true);
    const stop = listenForDesktopGoogleReturn(desktop, { api });
    let signedIn = 0;
    render(<GoogleButton mode="signin" desktop={desktop} onSignedIn={() => signedIn++} />);
    fireEvent.click(screen.getByRole('button', { name: 'Continue with Google' }));
    expect((await screen.findByRole('status')).textContent).toMatch(/Open Evora/);

    (deliver as unknown as (result: GoogleSignInResult) => void)({ ok: true, account: result });
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('You are signed in as Hedy (hedy@gmail.example).'));
    expect(getAccount()).toEqual({ token: 'session-token', user: result.user });
    expect(signedIn).toBe(1);
    // The window stayed where it was: the open document is not left.
    expect(window.location.hash).toBe('#/doc/abc');
    expect(sessionStorage.getItem(GOOGLE_RETURN_KEY)).toBeNull();
    // The main process redeemed the ticket: the page asks the server nothing.
    expect(calls).toEqual([]);
    stop();
    expect(deliver).toBeNull();
  });

  it('in the desktop app, says why a sign-in did not finish', async () => {
    let deliver: ((result: GoogleSignInResult) => void) | null = null;
    const desktop = {
      startGoogleSignIn: async () => ({ ok: true, message: null }),
      onGoogleReturn: (callback: (result: GoogleSignInResult) => void) => {
        deliver = callback;
        return () => undefined;
      },
    };
    listenForDesktopGoogleReturn(desktop, { api: server(true).api });
    render(<GoogleButton mode="signin" desktop={desktop} />);
    fireEvent.click(screen.getByRole('button', { name: 'Continue with Google' }));
    await screen.findByRole('status');
    (deliver as unknown as (result: GoogleSignInResult) => void)({ ok: false, message: 'Signing in with Google was cancelled' });
    expect((await screen.findByRole('alert')).textContent).toBe('Signing in with Google was cancelled');
    expect(getAccount()).toBeNull();
  });

  it('in the desktop app, a sign-in started from an invite joins the workspace, and opens it only from the invitation', async () => {
    const { api } = server(true);
    const store = new MemoryKeyValues();
    rememberGoogleReturn('#/invite/inv123', 'inv123', store);
    const onInvite = { hash: '#/invite/inv123' };
    expect(await finishDesktopGoogleSignIn({ ok: true, account: result }, { api, store, location: onInvite })).toEqual({ ok: true, name: 'Hedy', email: result.user.email });
    expect(onInvite.hash).toBe('#/workspace/w9');

    rememberGoogleReturn('#/invite/inv123', 'inv123', store);
    const elsewhere = { hash: '#/doc/abc' };
    await finishDesktopGoogleSignIn({ ok: true, account: result }, { api, store, location: elsewhere });
    expect(elsewhere.hash).toBe('#/doc/abc');
  });

  it('only remembers places in the app', () => {
    const store = new MemoryKeyValues();
    rememberGoogleReturn('#/doc/abc', null, store);
    expect(readGoogleReturn(store)).toEqual({ hash: '#/doc/abc', invite: null });
    rememberGoogleReturn('javascript:alert(1)', null, store);
    expect(readGoogleReturn(store).hash).toBe('#/');
    rememberGoogleReturn('#/auth/google?ticket=x', null, store);
    expect(readGoogleReturn(store).hash).toBe('#/');
    store.setItem(GOOGLE_RETURN_KEY, '{not json');
    expect(readGoogleReturn(store)).toEqual({ hash: '#/', invite: null });
  });

  it('routes #/auth/google with its query', () => {
    expect(parseRoute('#/auth/google?ticket=abc')).toEqual({ screen: 'google', query: 'ticket=abc' });
    expect(parseRoute('#/auth/google?error=Nope')).toEqual({ screen: 'google', query: 'error=Nope' });
    expect(parseRoute('#/auth/google')).toEqual({ screen: 'google', query: '' });
  });

  it('coming back redeems the ticket, keeps the account and goes back to where the person was', async () => {
    rememberGoogleReturn('#/doc/d1', null);
    const { api, calls } = server(true);
    const went: string[] = [];
    render(<GoogleReturnScreen query="ticket=good-ticket" api={api} onDone={(hash) => went.push(hash)} />);
    await waitFor(() => expect(went).toEqual(['#/doc/d1']));
    expect(getAccount()).toEqual({ token: 'session-token', user: result.user });
    expect(calls.filter((call) => call.endsWith('/redeem'))).toHaveLength(1);
    expect(sessionStorage.getItem(GOOGLE_RETURN_KEY)).toBeNull();
  });

  it('coming back from an invite link joins the workspace and opens it', async () => {
    rememberGoogleReturn('#/invite/inv123', 'inv123');
    const { api } = server(true);
    const went: string[] = [];
    render(<GoogleReturnScreen query="ticket=good-ticket" api={api} onDone={(hash) => went.push(hash)} />);
    await waitFor(() => expect(went).toEqual(['#/workspace/w9']));
  });

  it('says what went wrong, with a way back', async () => {
    rememberGoogleReturn('#/shared', null);
    const { api, calls } = server(true);
    const went: string[] = [];
    render(<GoogleReturnScreen query="error=Google+has+not+verified+this+email+address" api={api} onDone={(hash) => went.push(hash)} />);
    expect(screen.getByRole('alert').textContent).toBe('Google has not verified this email address');
    expect(calls).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Go back' }));
    expect(went).toEqual(['#/shared']);
    expect(getAccount()).toBeNull();
  });

  it('says so when the ticket no longer works', async () => {
    const { api } = server(true);
    render(<GoogleReturnScreen query="ticket=used-ticket" api={api} onDone={() => undefined} />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/expired or was already used/);
    expect(getAccount()).toBeNull();
  });
});
