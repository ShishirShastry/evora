import { useState, type FormEvent } from 'react';
import { errorMessage, type MembersResult } from '../../collab/api';
import type { Member, Role } from '../../collab/protocol';
import { Icon } from '../components/Icon';
import { Avatar } from './Avatar';
import { ROLE_LABELS } from './hooks';

interface RoleSelectProps {
  label: string;
  value: Role;
  onChange: (role: Role) => void;
  /** The roles that may be chosen; the others are not offered. */
  roles?: readonly Role[];
  disabled?: boolean;
}

/** A role to choose: Owner, Can edit or Can view. */
export function RoleSelect({ label, value, onChange, roles = ['owner', 'editor', 'viewer'], disabled }: RoleSelectProps) {
  const offered = roles.includes(value) ? roles : [value, ...roles];
  return (
    <select aria-label={label} className="ev-field !h-7 !w-auto flex-none !pr-1" value={value} disabled={disabled} onChange={(event) => onChange(event.target.value as Role)}>
      {offered.map((role) => (
        <option key={role} value={role}>
          {ROLE_LABELS[role]}
        </option>
      ))}
    </select>
  );
}

interface InviteFormProps {
  /** The roles that may be given: an editor cannot make owners. */
  roles: readonly Role[];
  onInvite: (email: string, role: Role) => Promise<void>;
}

/** Inviting someone by email address with a role. Anyone can be invited: there are no seats to run out of. */
export function InviteForm({ roles, onInvite }: InviteFormProps) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>(roles.includes('editor') ? 'editor' : (roles[0] ?? 'viewer'));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!email.trim()) return;
    setBusy(true);
    setError(null);
    void onInvite(email.trim(), role)
      .then(() => setEmail(''))
      .catch((cause: unknown) => setError(errorMessage(cause)))
      .finally(() => setBusy(false));
  };
  return (
    <form className="flex flex-col gap-1.5" onSubmit={submit} aria-label="Invite people">
      <div className="flex items-center gap-1.5">
        <input
          className="ev-field"
          type="email"
          placeholder="Email address"
          aria-label="Email address to invite"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <RoleSelect label="Role for the invited person" value={role} roles={roles} onChange={setRole} />
        <button type="submit" className="ev-button ev-button-primary flex-none !h-7" disabled={busy || !email.trim()}>
          Invite
        </button>
      </div>
      {error && (
        <p role="alert" className="m-0 text-danger">
          {error}
        </p>
      )}
    </form>
  );
}

interface MembersListProps {
  members: MembersResult;
  /** The person looking. */
  meId: string | null;
  /** May change roles and remove people (an owner). */
  canManage: boolean;
  /** The roles that may be given. */
  roles?: readonly Role[];
  onRole: (member: Member, role: Role) => void;
  onRemove: (member: Member) => void;
  /** What removing oneself is called ("Leave"), when one may. */
  leaveLabel?: string;
}

/** The people with access and their roles, then the invitations not yet taken up. */
export function MembersList({ members, meId, canManage, roles, onRole, onRemove, leaveLabel }: MembersListProps) {
  return (
    <ul aria-label="People with access" className="m-0 flex list-none flex-col gap-0.5 p-0">
      {members.members.map((member) => {
        const me = member.user.id === meId;
        return (
          <li key={member.user.id} className="flex min-h-9 items-center gap-2.5 rounded-[8px] px-1">
            <Avatar name={member.user.name} color={member.user.color} size={26} />
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate font-medium">
                {member.user.name}
                {me && <span className="font-normal text-dim"> (you)</span>}
              </span>
              <span className="truncate text-[11px] text-dim">{member.user.email}</span>
            </div>
            {canManage && !me ? (
              <>
                <RoleSelect label={`Role of ${member.user.name}`} value={member.role} roles={roles} onChange={(role) => onRole(member, role)} />
                <button type="button" className="ev-icon-button" aria-label={`Remove ${member.user.name}`} title="Remove" onClick={() => onRemove(member)}>
                  <Icon name="close" size={14} />
                </button>
              </>
            ) : (
              <>
                <span className="flex-none text-dim">{ROLE_LABELS[member.role]}</span>
                {me && leaveLabel && (
                  <button type="button" className="ev-button !h-7 flex-none !px-2.5" onClick={() => onRemove(member)}>
                    {leaveLabel}
                  </button>
                )}
              </>
            )}
          </li>
        );
      })}
      {members.pending.map((invite) => (
        <li key={`pending:${invite.email}`} className="flex min-h-9 items-center gap-2.5 rounded-[8px] px-1">
          <span aria-hidden="true" className="flex h-[26px] w-[26px] flex-none items-center justify-center rounded-full bg-field text-dim shadow-[var(--ev-sunk)]">
            <Icon name="mail" size={13} />
          </span>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate">{invite.email}</span>
            <span className="text-[11px] text-dim">Invited · joins when they sign up</span>
          </div>
          <span className="flex-none text-dim">{ROLE_LABELS[invite.role]}</span>
        </li>
      ))}
    </ul>
  );
}
