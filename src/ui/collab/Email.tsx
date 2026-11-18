import { useEffect, useState } from 'react';
import { errorMessage } from '../../collab/api';
import { emailApi as defaultApi, needsVerifying, type EmailApi, type EmailStatus } from '../../collab/email';
import { Dialog } from '../components/Dialog';
import { Logo } from '../components/Icon';
import { useAccount } from './hooks';

/**
 * Email in the app (the server's side is `server/email.ts`): a notice asking a
 * signed-in person to confirm their address, the page a confirmation link
 * opens (`#/verify-email/<token>`), and the setting for emails about
 * mentions. Nothing here shows when the server does not send email.
 */

/** The signed-in account's email status, read again when the account changes; null while unknown or signed out. */
export function useEmailStatus(api: EmailApi = defaultApi): [EmailStatus | null, (status: EmailStatus) => void] {
  const account = useAccount();
  const [status, setStatus] = useState<EmailStatus | null>(null);
  const accountKey = account ? `${account.user.id}|${account.user.email}` : null;
  useEffect(() => {
    setStatus(null);
    if (!accountKey) return;
    let current = true;
    api
      .status()
      .then((found) => current && setStatus(found))
      // A server from before email, or one that cannot be reached: nothing to show.
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [api, accountKey]);
  return [status, setStatus];
}

/** "Confirm your email address", with Resend, for a signed-in account whose address is not confirmed on a server that sends email. */
export function VerifyEmailNotice({ api = defaultApi }: { api?: EmailApi }) {
  const [status] = useEmailStatus(api);
  const [state, setState] = useState<{ kind: 'idle' | 'sending' | 'sent' } | { kind: 'error'; message: string }>({ kind: 'idle' });
  if (!status || !needsVerifying(status)) return null;
  const address = status.pendingEmail ?? status.email;
  // A server from before this field always sent one.
  const linkSent = status.linkSent !== false || state.kind === 'sent';

  const resend = (): void => {
    setState({ kind: 'sending' });
    api
      .resend()
      .then(() => setState({ kind: 'sent' }))
      .catch((cause: unknown) => setState({ kind: 'error', message: errorMessage(cause) }));
  };

  return (
    <section
      aria-label="Confirm your email address"
      className="mb-5 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-accent bg-accent/10 px-4 py-3 text-[13px] leading-relaxed"
    >
      <p className="m-0 min-w-0 flex-1 basis-[260px]">
        <strong className="font-semibold">Confirm your email address.</strong> {linkSent ? 'We sent a link to' : 'Send a link to'}{' '}
        <span className="break-all">{address}</span>
        {linkSent ? '' : ' to confirm it'}. Invitations sent to this address reach you once it is confirmed.
      </p>
      <button type="button" className="ev-button flex-none" disabled={state.kind === 'sending'} onClick={resend}>
        {state.kind === 'sending' ? 'Sending…' : linkSent ? 'Resend' : 'Send a link'}
      </button>
      {/* Always there (hidden while empty) so that a screen reader hears "Sent" when it appears. */}
      <p role="status" className={`m-0 w-full text-dim ${state.kind === 'sent' ? '' : 'sr-only'}`}>
        {state.kind === 'sent' ? 'Sent. Check your inbox (and the spam folder); the newest link is the one that works.' : ''}
      </p>
      {state.kind === 'error' && (
        <p role="alert" className="m-0 w-full text-danger">
          {state.message}
        </p>
      )}
    </section>
  );
}

interface VerifyEmailScreenProps {
  token: string;
  api?: EmailApi;
  onHome: () => void;
}

/** Confirmations under way by token: a token works once, so the page asks once even if its effect runs twice. */
const confirming = new Map<string, Promise<{ email: string }>>();

function confirmOnce(api: EmailApi, token: string): Promise<{ email: string }> {
  let found = confirming.get(token);
  if (!found) {
    found = api.verify(token);
    confirming.set(token, found);
  }
  return found;
}

/** `#/verify-email/<token>`: where the link in the email lands. It confirms the address at once; no sign-in is needed. */
export function VerifyEmailScreen({ token, api = defaultApi, onHome }: VerifyEmailScreenProps) {
  const [result, setResult] = useState<{ kind: 'working' } | { kind: 'done'; email: string } | { kind: 'failed'; message: string }>({ kind: 'working' });
  useEffect(() => {
    let current = true;
    // The token leaves the address bar and the history: it has done its work.
    if (window.location.hash === `#/verify-email/${token}`) window.history.replaceState(null, '', '#/');
    confirmOnce(api, token)
      .then((answer) => current && setResult({ kind: 'done', email: answer.email }))
      .catch((cause: unknown) => current && setResult({ kind: 'failed', message: errorMessage(cause) }));
    return () => {
      current = false;
    };
  }, [api, token]);

  return (
    <main className="flex h-full items-center justify-center bg-bg p-6">
      <section aria-label="Confirm your email address" className="ev-panel flex w-full max-w-[400px] flex-col items-center gap-4 px-8 pb-8 pt-9 text-center">
        <Logo size={40} />
        <h1 className="m-0 text-[16px] font-semibold">Confirm your email address</h1>
        {result.kind === 'working' && (
          <p role="status" className="m-0 text-dim">
            Confirming…
          </p>
        )}
        {result.kind === 'done' && (
          <p role="status" className="m-0 text-[14px] leading-relaxed">
            <span className="break-all font-semibold">{result.email}</span> is confirmed. Invitations sent to it are now yours.
          </p>
        )}
        {result.kind === 'failed' && (
          <p role="alert" className="m-0 text-danger">
            {result.message}. You can ask for a new link from the notice in the file browser.
          </p>
        )}
        <button type="button" className="ev-button ev-button-primary" onClick={onHome}>
          Go to your files
        </button>
      </section>
    </main>
  );
}

/** Account menu ▸ Email settings…: whether a mention in a comment is also sent by email. */
export function EmailSettingsDialog({ onClose, api = defaultApi }: { onClose: () => void; api?: EmailApi }) {
  const [status, setStatus] = useState<EmailStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let current = true;
    api
      .status()
      .then((found) => current && setStatus(found))
      .catch((cause: unknown) => current && setError(errorMessage(cause)));
    return () => {
      current = false;
    };
  }, [api]);

  const toggle = (on: boolean): void => {
    setBusy(true);
    setError(null);
    api
      .setMentionEmails(on)
      .then(setStatus)
      .catch((cause: unknown) => setError(errorMessage(cause)))
      .finally(() => setBusy(false));
  };

  return (
    <Dialog title="Email settings" onClose={onClose} width={380}>
      <div className="flex flex-col gap-3 text-[13px] leading-relaxed">
        {status === null && !error && <p className="m-0 text-dim">Loading…</p>}
        {status && (
          <>
            <label className="flex items-start gap-2">
              <input type="checkbox" className="mt-[3px]" checked={status.mentionEmails} disabled={busy || !status.mail} onChange={(event) => toggle(event.target.checked)} />
              <span>Email me when someone mentions me in a comment</span>
            </label>
            {!status.mail && <p className="m-0 text-dim">This server does not send email, so nothing is sent whatever this says.</p>}
            {status.mail && !status.verified && <p className="m-0 text-dim">Emails go only to a confirmed address: confirm {status.email} from the link we sent.</p>}
            {status.mail && status.verified && <p className="m-0 text-dim">Emails go to {status.email}. Mentions still show in your notifications either way.</p>}
          </>
        )}
        {error && (
          <p role="alert" className="m-0 text-danger">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
