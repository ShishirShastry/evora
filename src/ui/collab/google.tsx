import { useEffect, useState } from 'react';
import { googleStartUrl, type EvoraApi } from '../../collab/api';
import { GOOGLE_RETURN_ROUTE } from '../../collab/protocol';

/**
 * "Continue with Google" in the app: the button (shown only when the server
 * says Google is set up), remembering where the person was before the window
 * leaves for Google, and finding it again when it comes back to
 * `#/auth/google`.
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

interface GoogleButtonProps {
  mode: 'signin' | 'signup';
  /** The invite link being followed, if the dialog was opened from one. */
  invite?: string | null;
  disabled?: boolean;
  /** Sends the window somewhere; the browser's own navigation by default (tests give their own). */
  navigate?: (url: string) => void;
}

/** "Continue with Google", full width, followed by an "or" before the email form. */
export function GoogleButton({ mode, invite = null, disabled = false, navigate = (url) => window.location.assign(url) }: GoogleButtonProps) {
  const start = (): void => {
    rememberGoogleReturn(window.location.hash || '#/', invite);
    navigate(googleStartUrl(window.location.origin, mode === 'signup' ? 'signup' : 'login', invite));
  };
  return (
    <>
      <button type="button" className="ev-button w-full" disabled={disabled} onClick={start}>
        <GoogleMark />
        Continue with Google
      </button>
      <div className="flex items-center gap-2 text-[11px] text-dim" aria-hidden="true">
        <span className="h-px flex-1 bg-current opacity-25" />
        or
        <span className="h-px flex-1 bg-current opacity-25" />
      </div>
    </>
  );
}
