import { useEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
import { setAccount, updateAccountUser } from '../../collab/account';
import { api as defaultApi, errorMessage, type EvoraApi } from '../../collab/api';
import { Dialog } from '../components/Dialog';
import { FREE_NOTE } from './hooks';

export type AccountMode = 'signin' | 'signup';

interface AccountDialogProps {
  mode?: AccountMode;
  onClose: () => void;
  /** Called once signed in or up, before the dialog closes. */
  onDone?: () => void;
  /** Why an account is asked for, shown above the form. */
  reason?: string;
  api?: EvoraApi;
}

/** Signing in, or creating an account: free, with no plans and no limits. */
export function AccountDialog({ mode: initialMode = 'signin', onClose, onDone, reason, api = defaultApi }: AccountDialogProps) {
  const [mode, setMode] = useState<AccountMode>(initialMode);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLInputElement>(null);
  useFocusSoon(first, mode);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setError(null);
    if (mode === 'signup' && name.trim() === '') {
      setError('Say what name others should see.');
      return;
    }
    setBusy(true);
    const request = mode === 'signup' ? api.signup(email.trim(), name.trim(), password) : api.login(email.trim(), password);
    void request
      .then((result) => {
        setAccount(result);
        onDone?.();
        onClose();
      })
      .catch((cause: unknown) => {
        setError(errorMessage(cause));
        setBusy(false);
      });
  };

  const title = mode === 'signup' ? 'Create an account' : 'Sign in';
  return (
    <Dialog title={title} onClose={onClose} width={380}>
      <form className="flex flex-col gap-3" onSubmit={submit}>
        {reason && <p className="m-0 leading-relaxed text-dim">{reason}</p>}
        <div role="tablist" aria-label="Account" className="ev-segmented">
          <button type="button" role="tab" aria-selected={mode === 'signin'} className="ev-segment" onClick={() => setMode('signin')}>
            Sign in
          </button>
          <button type="button" role="tab" aria-selected={mode === 'signup'} className="ev-segment" onClick={() => setMode('signup')}>
            Create account
          </button>
        </div>
        {mode === 'signup' && (
          <label className="flex flex-col gap-1">
            <span className="text-dim">Name</span>
            <input ref={first} className="ev-field" autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} />
          </label>
        )}
        <label className="flex flex-col gap-1">
          <span className="text-dim">Email</span>
          <input
            className="ev-field"
            type="email"
            required
            autoComplete="email"
            ref={mode === 'signin' ? first : undefined}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-dim">Password</span>
          <input
            className="ev-field"
            type="password"
            required
            autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        {error && (
          <p role="alert" className="m-0 rounded-[8px] bg-danger/10 px-3 py-2 leading-relaxed text-danger ring-1 ring-danger/30 ring-inset">
            {error}
          </p>
        )}
        <button type="submit" className="ev-button ev-button-primary" disabled={busy}>
          {busy ? 'Please wait…' : mode === 'signup' ? 'Create account' : 'Sign in'}
        </button>
        <p className="m-0 text-center text-[11px] text-dim">{FREE_NOTE}. No plans, no seat limits.</p>
      </form>
    </Dialog>
  );
}

/** Changing the name others see on cursors, avatars and comments. */
export function ChangeNameDialog({ current, onClose, api = defaultApi }: { current: string; onClose: () => void; api?: EvoraApi }) {
  const [name, setName] = useState(current);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  useFocusSoon(field, null);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError('A name cannot be empty.');
      return;
    }
    setBusy(true);
    void api
      .updateMe({ name: trimmed })
      .then((user) => {
        updateAccountUser(user);
        onClose();
      })
      .catch((cause: unknown) => {
        setError(errorMessage(cause));
        setBusy(false);
      });
  };
  return (
    <Dialog title="Change name" onClose={onClose} width={360}>
      <form className="flex flex-col gap-3" onSubmit={submit}>
        <label className="flex flex-col gap-1">
          <span className="text-dim">Name</span>
          <input ref={field} className="ev-field" value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        {error && (
          <p role="alert" className="m-0 text-danger">
            {error}
          </p>
        )}
        <button type="submit" className="ev-button ev-button-primary" disabled={busy}>
          Save
        </button>
      </form>
    </Dialog>
  );
}

/** Puts the keyboard in a field once the dialog round it has settled (the dialog first focuses itself). */
export function useFocusSoon(ref: RefObject<HTMLElement | null>, key: unknown): void {
  useEffect(() => {
    const timer = setTimeout(() => ref.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [ref, key]);
}
