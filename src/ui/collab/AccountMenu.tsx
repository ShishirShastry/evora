import { useRef, useState } from 'react';
import { clearAccount } from '../../collab/account';
import { api } from '../../collab/api';
import { PopupMenu, type MenuItem } from '../components/Menu';
import { AccountDialog, ChangeNameDialog, type AccountMode } from './AccountDialog';
import { Avatar } from './Avatar';
import { useAccount, useGuest } from './hooks';

interface AccountMenuProps {
  /** Smaller, for the editor's panel header. */
  compact?: boolean;
}

/**
 * The person using the application: their avatar with a menu (their name and
 * address, Change name…, Sign out), or a "Sign in" button when nobody is
 * signed in on this device. A guest sees their guest name and can sign in.
 */
export function AccountMenu({ compact = false }: AccountMenuProps) {
  const account = useAccount();
  const guest = useGuest();
  const button = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [dialog, setDialog] = useState<AccountMode | 'name' | null>(null);
  const size = compact ? 24 : 28;

  const openMenu = (): void => {
    const rect = button.current?.getBoundingClientRect();
    if (rect) setMenu({ x: Math.max(8, rect.right - 220), y: rect.bottom + 6 });
  };

  const signOut = (): void => {
    // The session ends on the server too; if the server cannot be reached, it is still forgotten here.
    void api
      .logout()
      .catch(() => undefined)
      .finally(() => clearAccount());
  };

  let items: MenuItem[] = [];
  if (account) {
    items = [
      { label: account.user.name, disabled: true, onSelect: () => undefined },
      { label: account.user.email, disabled: true, onSelect: () => undefined },
      { type: 'separator' },
      { label: 'Change name…', onSelect: () => setDialog('name') },
      { label: 'Sign out', onSelect: signOut },
    ];
  } else if (guest) {
    items = [
      { label: `${guest.guest.name} (guest)`, disabled: true, onSelect: () => undefined },
      { type: 'separator' },
      { label: 'Sign in…', onSelect: () => setDialog('signin') },
      { label: 'Create an account…', onSelect: () => setDialog('signup') },
    ];
  }

  return (
    <>
      {account || guest ? (
        <button
          ref={button}
          type="button"
          className="flex flex-none items-center justify-center rounded-full border-0 bg-transparent p-0.5 transition-[box-shadow] duration-150 hover:shadow-[0_0_0_2px_var(--ev-ring)]"
          aria-label={account ? `Account: ${account.user.name}` : `Guest: ${guest?.guest.name ?? ''}`}
          aria-haspopup="menu"
          title={account ? `${account.user.name} (you)` : `${guest?.guest.name ?? ''} (you, as a guest)`}
          onClick={openMenu}
        >
          <Avatar name={account ? account.user.name : (guest?.guest.name ?? '')} color={account ? account.user.color : (guest?.guest.color ?? '#0d99ff')} size={size} />
        </button>
      ) : (
        <button type="button" className={`ev-button flex-none ${compact ? '!h-7 !px-2.5' : ''}`} onClick={() => setDialog('signin')}>
          Sign in
        </button>
      )}
      {menu && <PopupMenu x={menu.x} y={menu.y} items={items} label="Account" onClose={() => setMenu(null)} />}
      {(dialog === 'signin' || dialog === 'signup') && <AccountDialog mode={dialog} onClose={() => setDialog(null)} />}
      {dialog === 'name' && account && <ChangeNameDialog current={account.user.name} onClose={() => setDialog(null)} />}
    </>
  );
}
