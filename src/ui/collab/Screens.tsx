import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { setAccount, setGuest } from '../../collab/account';
import { api as defaultApi, errorMessage, type EvoraApi, type InviteInfo } from '../../collab/api';
import type { AuthResult, Workspace } from '../../collab/protocol';
import { Logo } from '../components/Icon';
import { AccountDialog, useFocusSoon, type AccountMode } from './AccountDialog';
import { Avatar } from './Avatar';
import { forgetGoogleReturn, readGoogleReturn } from './google';
import { FREE_NOTE, ROLE_LABELS, useAccount } from './hooks';

/** A card in the middle of the window, for the screens that come before a file or the file browser. */
function Card({ children, label }: { children: ReactNode; label: string }) {
  return (
    <main className="flex h-full items-center justify-center bg-bg p-6">
      <section aria-label={label} className="ev-panel flex w-full max-w-[400px] flex-col items-center gap-4 px-8 pb-8 pt-9 text-center">
        <Logo size={40} />
        {children}
      </section>
    </main>
  );
}

interface InviteScreenProps {
  token: string;
  api?: EvoraApi;
  onAccepted: (workspace: Workspace) => void;
  onHome: () => void;
}

/** `#/invite/<token>`: an invitation to a workspace, accepted once signed in (or after creating an account, free). */
export function InviteScreen({ token, api = defaultApi, onAccepted, onHome }: InviteScreenProps) {
  const account = useAccount();
  const [invite, setInvite] = useState<InviteInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<AccountMode | null>(null);

  useEffect(() => {
    let current = true;
    api
      .getInvite(token)
      .then((found) => current && setInvite(found))
      .catch((cause: unknown) => current && setError(errorMessage(cause)));
    return () => {
      current = false;
    };
  }, [api, token]);

  const accept = (): void => {
    setBusy(true);
    setError(null);
    api
      .acceptInvite(token)
      .then(onAccepted)
      .catch((cause: unknown) => {
        setError(errorMessage(cause));
        setBusy(false);
      });
  };

  return (
    <Card label="Invitation">
      {invite ? (
        <>
          <Avatar name={invite.from.name} color={invite.from.color} size={36} />
          <p className="m-0 text-[14px] leading-relaxed">
            <strong className="font-semibold">{invite.from.name}</strong> invited you to the workspace <strong className="font-semibold">{invite.workspace.name}</strong>.
          </p>
          <p className="m-0 text-dim">You will join as: {ROLE_LABELS[invite.role]}</p>
          {account ? (
            <button type="button" className="ev-button ev-button-primary" disabled={busy} onClick={accept}>
              Accept invitation
            </button>
          ) : (
            <div className="flex gap-2">
              <button type="button" className="ev-button ev-button-primary" onClick={() => setDialog('signup')}>
                Create an account
              </button>
              <button type="button" className="ev-button" onClick={() => setDialog('signin')}>
                Sign in
              </button>
            </div>
          )}
        </>
      ) : (
        !error && <p className="m-0 text-dim">Opening the invitation…</p>
      )}
      {error && (
        <p role="alert" className="m-0 text-danger">
          {error}
        </p>
      )}
      <p className="m-0 text-[11px] text-dim">{FREE_NOTE}</p>
      <button type="button" className="ev-button" onClick={onHome}>
        Back to files
      </button>
      {dialog && (
        <AccountDialog
          mode={dialog}
          reason="Sign in or create an account to join the workspace."
          onClose={() => setDialog(null)}
          onDone={accept}
          api={api}
          invite={token}
        />
      )}
    </Card>
  );
}

interface GuestPromptProps {
  api?: EvoraApi;
  /** Called once there is an identity to open the document with: a guest name, or an account. */
  onReady: () => void;
  onBack: () => void;
}

/** Opening a shared link without an account: a name to be seen by (a guest), or signing in. Either is free. */
export function GuestPrompt({ api = defaultApi, onReady, onBack }: GuestPromptProps) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<AccountMode | null>(null);
  const field = useRef<HTMLInputElement>(null);
  useFocusSoon(field, null);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    api
      .createGuest(name.trim())
      .then((result) => {
        setGuest(result);
        onReady();
      })
      .catch((cause: unknown) => {
        setError(errorMessage(cause));
        setBusy(false);
      });
  };

  return (
    <Card label="Join as a guest">
      <h1 className="m-0 text-[16px] font-semibold">Open this shared file</h1>
      <p className="m-0 leading-relaxed text-dim">Say what name the others will see on your cursor and comments. No account is needed.</p>
      <form className="flex w-full flex-col gap-2" onSubmit={submit}>
        <input ref={field} className="ev-field" aria-label="Your name" placeholder="Your name" value={name} onChange={(event) => setName(event.target.value)} />
        <button type="submit" className="ev-button ev-button-primary" disabled={busy || !name.trim()}>
          Continue as a guest
        </button>
      </form>
      {error && (
        <p role="alert" className="m-0 text-danger">
          {error}
        </p>
      )}
      <p className="m-0 text-dim">
        Have an account?{' '}
        <button type="button" className="border-0 bg-transparent p-0 text-accent underline-offset-2 hover:underline" onClick={() => setDialog('signin')}>
          Sign in
        </button>{' '}
        or{' '}
        <button type="button" className="border-0 bg-transparent p-0 text-accent underline-offset-2 hover:underline" onClick={() => setDialog('signup')}>
          create one
        </button>
        .
      </p>
      <p className="m-0 text-[11px] text-dim">{FREE_NOTE}</p>
      <button type="button" className="ev-button" onClick={onBack}>
        Back to files
      </button>
      {dialog && <AccountDialog mode={dialog} onClose={() => setDialog(null)} onDone={onReady} api={api} />}
    </Card>
  );
}

/** Redemptions under way, by ticket: a ticket works once, and React may start the same screen twice. */
const redeeming = new Map<string, Promise<AuthResult>>();

interface GoogleReturnScreenProps {
  /** The query of `#/auth/google?…`: a `ticket`, or an `error`. */
  query: string;
  api?: EvoraApi;
  /** Goes to a place in the app, in place of the return (so the ticket is not left in the history). */
  onDone: (hash: string) => void;
}

/**
 * `#/auth/google`: back from Google. The one-time ticket is traded for a
 * session, kept like any sign-in, and the person goes back to where they were
 * (into the workspace when they came from an invite link). A failure is said,
 * with a way back.
 */
export function GoogleReturnScreen({ query, api = defaultApi, onDone }: GoogleReturnScreenProps) {
  const params = new URLSearchParams(query);
  const ticket = params.get('ticket');
  const [error, setError] = useState<string | null>(() => params.get('error') ?? (ticket ? null : 'Signing in with Google did not finish: try again.'));
  const [back] = useState(() => readGoogleReturn());
  const finish = (hash: string): void => {
    forgetGoogleReturn();
    onDone(hash);
  };

  useEffect(() => {
    if (!ticket) return undefined;
    let current = true;
    let pending = redeeming.get(ticket);
    if (!pending) {
      pending = api.redeemGoogle(ticket);
      redeeming.set(ticket, pending);
    }
    pending
      .then(async (result) => {
        if (!current) return;
        setAccount(result);
        if (back.invite) {
          const workspace = await api.acceptInvite(back.invite).catch(() => null);
          if (!current) return;
          if (workspace) {
            finish(`#/workspace/${workspace.id}`);
            return;
          }
        }
        finish(back.hash);
      })
      .catch((cause: unknown) => current && setError(errorMessage(cause)));
    return () => {
      current = false;
    };
    // The ticket is redeemed once, whatever else changes.
  }, [api, ticket]);

  return (
    <Card label="Continue with Google">
      {error ? (
        <>
          <h1 className="m-0 text-[16px] font-semibold">Could not sign in with Google</h1>
          <p role="alert" className="m-0 text-danger">
            {error}
          </p>
          <button type="button" className="ev-button" onClick={() => finish(back.hash)}>
            Go back
          </button>
        </>
      ) : (
        <p className="m-0 text-dim">Signing in with Google…</p>
      )}
    </Card>
  );
}
