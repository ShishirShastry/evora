import { useEffect, useState } from 'react';
import { setAccount } from '../../collab/account';
import { api as defaultApi, googleStartUrl, type EvoraApi } from '../../collab/api';
import { GOOGLE_RETURN_ROUTE } from '../../collab/protocol';
import type { EvoraDesktop, GoogleSignInResult } from '../../persistence/desktopContract';

/**
 * "Continue with Google" in the app: the button (shown only when the server
 * says Google is set up), remembering where the person was before the window
 * leaves for Google, and finding it again when it comes back to
 * `#/auth/google`.
 *
 * In the desktop app the window cannot leave for Google (its pages are at
 * app://evora/): the sign-in opens in the system's browser instead. When it
 * comes back, the main process redeems the ticket (with the PKCE verifier
 * only it holds, electron/auth.ts) and sends the session here through
 * `onGoogleReturn`: it is kept where the window is, without changing the
 * route, so an open document stays open (`listenForDesktopGoogleReturn`).
 */

export const GOOGLE_RETURN_KEY = 'evora:google-return';

/** Where to go back to after signing in with Google, and the invite link being followed, if any. */
export interface GoogleReturn {
  hash: string;
  invite: string | null;
}

/** The part of the Web Storage interface used here, so tests can give their own. */
type SessionStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function sessionStore(): SessionStore | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

/** A place in the app to go back to: one of its own routes, never the Google return itself. */
function safeHash(hash: unknown): string {
  return typeof hash === 'string' && /^#\/[^\s]*$/.test(hash) && !hash.startsWith(GOOGLE_RETURN_ROUTE) ? hash : '#/';
}

/** Remembers, for this tab, where the person was before going to Google. */
export function rememberGoogleReturn(hash: string, invite: string | null, store: SessionStore | null = sessionStore()): void {
  try {
    store?.setItem(GOOGLE_RETURN_KEY, JSON.stringify({ hash: safeHash(hash), invite }));
  } catch {
    // Not remembered: the person comes back to the file browser.
  }
}

/** Where to go back to: the file browser when nothing was remembered. */
export function readGoogleReturn(store: SessionStore | null = sessionStore()): GoogleReturn {
  try {
    const raw = store?.getItem(GOOGLE_RETURN_KEY);
    if (raw) {
      const value = JSON.parse(raw) as Partial<GoogleReturn>;
      return { hash: safeHash(value.hash), invite: typeof value.invite === 'string' && value.invite ? value.invite : null };
    }
  } catch {
    // Unreadable: as if nothing was remembered.
  }
  return { hash: '#/', invite: null };
}

/** Forgets where to go back to, once gone back there. */
export function forgetGoogleReturn(store: SessionStore | null = sessionStore()): void {
  try {
    store?.removeItem(GOOGLE_RETURN_KEY);
  } catch {
    // Nothing to forget.
  }
}

/** Whether the server offers signing in with Google; false until it says so, and when it cannot be asked. */
export function useGoogleAvailable(api: EvoraApi): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    let current = true;
    if (typeof api.authProviders !== 'function') return undefined;
    api
      .authProviders()
      .then((providers) => current && setAvailable(providers.google === true))
      .catch(() => current && setAvailable(false));
    return () => {
      current = false;
    };
  }, [api]);
  return available;
}

/** Google's "G", in its own colours. */
export function GoogleMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}

// ------------------------------------------------------------------ the desktop app's return

/** How a desktop sign-in ended, as the buttons waiting for it show it. */
export type GoogleOutcome = { ok: true; name: string; email: string } | { ok: false; message: string };

/** The buttons waiting for a desktop sign-in to end. */
const outcomeListeners = new Set<(outcome: GoogleOutcome) => void>();

/** Hears how desktop sign-ins end (after the account is kept); returns a function that stops. */
export function onGoogleOutcome(listener: (outcome: GoogleOutcome) => void): () => void {
  outcomeListeners.add(listener);
  return () => {
    outcomeListeners.delete(listener);
  };
}

interface FinishOptions {
  api?: Pick<EvoraApi, 'acceptInvite'>;
  store?: SessionStore | null;
  /** The window's location (tests give their own). */
  location?: Pick<Location, 'hash'>;
}

/**
 * Keeps the session a desktop sign-in brought back, where the window is: the
 * route does not change, so whatever is open (a document in the editor) stays.
 * When it was started from an invite link, the workspace is joined too, and
 * only when the window still shows that invitation does it go on to the
 * workspace, as the web app does.
 */
export async function finishDesktopGoogleSignIn(
  result: GoogleSignInResult,
  { api = defaultApi, store = sessionStore(), location = window.location }: FinishOptions = {},
): Promise<GoogleOutcome> {
  if (!result.ok) {
    forgetGoogleReturn(store);
    return { ok: false, message: result.message };
  }
  setAccount(result.account);
  const back = readGoogleReturn(store);
  forgetGoogleReturn(store);
  if (back.invite) {
    const workspace = await api.acceptInvite(back.invite).catch(() => null);
    if (workspace && location.hash === `#/invite/${back.invite}`) location.hash = `#/workspace/${workspace.id}`;
  }
  return { ok: true, name: result.account.user.name, email: result.account.user.email };
}

/** Listens for the desktop app's Google returns, keeps each session and tells the waiting buttons; returns a function that stops. */
export function listenForDesktopGoogleReturn(desktop: Pick<EvoraDesktop, 'onGoogleReturn'>, options: FinishOptions = {}): () => void {
  return desktop.onGoogleReturn((result) => {
    void finishDesktopGoogleSignIn(result, options)
      .catch((): GoogleOutcome => ({ ok: false, message: 'Signing in with Google did not finish. Try again.' }))
      .then((outcome) => {
        for (const listener of [...outcomeListeners]) listener(outcome);
      });
  });
}

// In the desktop app, the return is heard from the start, whatever is open then (the dialog with the button may have
// been closed meanwhile). Once per page, also when this module is loaded again in development.
const INSTALLED = Symbol.for('evora.googleReturnListener');
{
  const scope = globalThis as { evoraDesktop?: EvoraDesktop; [INSTALLED]?: boolean };
  const bridge = scope.evoraDesktop;
  if (bridge && typeof bridge.onGoogleReturn === 'function' && !scope[INSTALLED]) {
    scope[INSTALLED] = true;
    listenForDesktopGoogleReturn(bridge);
  }
}

// ------------------------------------------------------------------ the button

interface GoogleButtonProps {
  mode: 'signin' | 'signup';
  /** The invite link being followed, if the dialog was opened from one. */
  invite?: string | null;
  disabled?: boolean;
  /** Sends the window somewhere; the browser's own navigation by default (tests give their own). */
  navigate?: (url: string) => void;
  /** The desktop app's bridge; null in a browser (tests give their own). */
  desktop?: Pick<EvoraDesktop, 'startGoogleSignIn'> | null;
  /** In the desktop app: called once the sign-in this button started has ended signed in. */
  onSignedIn?: () => void;
}

type Status = { kind: 'waiting' | 'done' | 'failed'; message: string };

/** "Continue with Google", full width, followed by an "or" before the email form. */
export function GoogleButton({
  mode,
  invite = null,
  disabled = false,
  navigate = (url) => window.location.assign(url),
  desktop = (globalThis as { evoraDesktop?: EvoraDesktop }).evoraDesktop ?? null,
  onSignedIn,
}: GoogleButtonProps) {
  const [status, setStatus] = useState<Status | null>(null);
  const waiting = status?.kind === 'waiting';

  // While waiting, the end of the sign-in is shown here: signed in, or why not.
  useEffect(() => {
    if (!waiting) return undefined;
    return onGoogleOutcome((outcome) => {
      if (outcome.ok) {
        setStatus({ kind: 'done', message: `You are signed in as ${outcome.name} (${outcome.email}).` });
        onSignedIn?.();
      } else {
        setStatus({ kind: 'failed', message: outcome.message });
      }
    });
  }, [waiting, onSignedIn]);

  const start = (): void => {
    rememberGoogleReturn(window.location.hash || '#/', invite);
    const startMode = mode === 'signup' ? 'signup' : 'login';
    if (desktop) {
      setStatus(null);
      desktop
        .startGoogleSignIn({ mode: startMode, invite })
        .then((started) =>
          setStatus(
            started.ok
              ? { kind: 'waiting', message: 'Finish signing in with Google in your browser, then click Open Evora there. Evora carries on by itself.' }
              : { kind: 'failed', message: started.message ?? 'Your browser could not be opened.' },
          ),
        )
        .catch(() => setStatus({ kind: 'failed', message: 'Your browser could not be opened.' }));
      return;
    }
    navigate(googleStartUrl(window.location.origin, startMode, invite));
  };
  return (
    <>
      <button type="button" className="ev-button w-full" disabled={disabled} onClick={start}>
        <GoogleMark />
        Continue with Google
      </button>
      {status && (
        <p role={status.kind === 'failed' ? 'alert' : 'status'} className={`m-0 leading-relaxed ${status.kind === 'failed' ? 'text-danger' : 'text-dim'}`}>
          {status.message}
        </p>
      )}
      <div className="flex items-center gap-2 text-[11px] text-dim" aria-hidden="true">
        <span className="h-px flex-1 bg-current opacity-25" />
        or
        <span className="h-px flex-1 bg-current opacity-25" />
      </div>
    </>
  );
}
