/**
 * The email Evora sends, and confirming that an address is someone's.
 *
 * Email is off unless the server is given a relay (EVORA_SMTP_URL and
 * EVORA_MAIL_FROM, see server/config.ts and server/mail.ts). Off, everything
 * works as it did before: no mail, and an invitation by email is taken up by
 * whichever account has (or is made with) that address. On:
 *
 * - A new account (one not made through Google) is sent a link that confirms
 *   the address, and so is an account from before email was on, the first
 *   time it asks for its email status. The link holds a one-time token: only
 *   its hash is kept, it works once, for 24 hours, only for the address it was
 *   sent to, and a newer link replaces it. Asking for another (or a new
 *   address) is limited per account, the links sent to one address are limited
 *   per day whoever asks, and wrong tokens are limited per client address.
 *   An account made or linked through Google, whose address Google has
 *   verified, counts as confirmed.
 * - A new address is only asked for: the account keeps its address until the
 *   link sent to the new one is followed, so an address nobody confirmed is
 *   never held. It needs the account's password, or for an account without
 *   one a sign-in in the last few minutes. With email off it is refused.
 * - An invitation by email is taken up only by an account whose address is
 *   confirmed: one that has not confirmed it yet gets the invitation when it
 *   does. This is what stops someone from making an account with another
 *   person's address and receiving their invitations.
 * - Invitations to a workspace or a file by email are sent to the address,
 *   and a mention in a comment is sent to the mentioned person's confirmed
 *   address, unless they turned that off (`mentionEmails`). Both are limited
 *   per recipient (invitations per address per day, mentions per person and
 *   file), so that nobody can use the server to flood one mailbox.
 * - With email off, invitations that were left waiting for an account (while
 *   email was on) are taken up when the server starts.
 *
 * Routes:
 * - GET   /api/me/email                 -> {mail, email, verified, mentionEmails, pendingEmail, linkSent}
 * - PATCH /api/me/email {mentionEmails?, email?, password?} -> the same; a new address needs the
 *                                          account's password (or, without one, a recent sign-in), is
 *                                          sent a link, and replaces the old one when it is followed;
 *                                          409 with email off
 * - POST  /api/me/email/resend          -> {sent: true}; 409 when email is off or the address is confirmed, 429 too often
 * - POST  /api/auth/verify-email {token} -> {email, verified: true}; 400 for a token that is wrong, used or expired
 */
import type { Role } from '../src/collab/protocol.ts';
import { RateLimiter, hashToken, newToken, verifyPassword } from './auth.ts';
import type { Route } from './http.ts';
import type { ApiKit, Ctx } from './api.ts';
import { isMailAddress, type Mailer, type MailMessage } from './mail.ts';
import { normalizeEmail, type NotificationEvent, type Store, type UserRow } from './store.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

/** How long a link that confirms an address works. */
export const VERIFY_TTL_MS = DAY_MS;

/** Invitation emails one account may cause in a window; beyond it the invitation is still made, without an email. */
export const INVITE_EMAILS_PER_WINDOW = 50;

/** Invitation emails one address may be sent in a day, whoever invites it; beyond it the invitation is still made, without an email. */
export const INVITE_EMAILS_PER_ADDRESS = 10;

/** Links that confirm an address one address may be sent in a day, whichever accounts ask. */
export const VERIFY_EMAILS_PER_ADDRESS = 5;

/** Mention emails one person may be sent about one file in a window; the notifications in the app still come. */
export const MENTION_EMAILS_PER_DOC = 10;

/** For an account without a password, how recent its sign-in must be to ask for a new address. */
export const FRESH_SIGN_IN_MS = 10 * 60 * 1000;

export interface EmailLimits {
  /** Links that confirm an address one account may ask for in a window (besides the first). */
  emailResends: number;
  /** Wrong, used or expired tokens one client address may try in a window. */
  emailTokenFailures: number;
  windowMs: number;
}

const EMAIL = /^[^\s@]+@[^\s@]+$/;

const ROLE_WORDS: Record<Role, string> = { owner: 'an owner', editor: 'an editor', viewer: 'a viewer (who can comment)' };

/** Text made safe to put in HTML. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] as string);
}

/** A short, plain message: paragraphs of text and one link, as text and as the same in simple HTML. */
export function composeMessage(to: string, subject: string, paragraphs: string[], link: { label: string; url: string }, footer: string): MailMessage {
  const text = [...paragraphs, `${link.label}: ${link.url}`, '', footer].join('\n\n').replace(/\n{3,}/g, '\n\n');
  const html = [
    '<!doctype html><html><body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.5;color:#1e1e1e">',
    ...paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`),
    `<p><a href="${escapeHtml(link.url)}">${escapeHtml(link.label)}</a></p>`,
    `<p style="color:#6b6b6b;font-size:13px">${escapeHtml(footer)}</p>`,
    '</body></html>',
  ].join('\n');
  return { to, subject: subject.length > 150 ? `${subject.slice(0, 149)}…` : subject, text, html };
}

/** What a link is for: thrown as the API's 400/409/429 by the routes. */
export class EmailError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface EmailServiceOptions {
  store: Store;
  /** The queue mail goes out through; null when email is off. */
  mailer: Mailer | null;
  /** The app's public origin, for the links in messages (needed when email is on). */
  publicUrl: string | null;
  limits: EmailLimits;
  /** The clock (the tests give their own). */
  now?: () => number;
}

/** Confirming addresses and sending Evora's messages. One per API. */
export class EmailService {
  readonly store: Store;
  readonly mailer: Mailer | null;
  private readonly origin: string;
  private readonly now: () => number;
  private readonly resends: RateLimiter;
  private readonly failures: RateLimiter;
  private readonly inviteMails: RateLimiter;
  private readonly inviteRecipients: RateLimiter;
  private readonly verifyRecipients: RateLimiter;
  private readonly mentionMails: RateLimiter;
  private readonly unsubscribe: () => void;

  constructor(options: EmailServiceOptions) {
    this.store = options.store;
    this.mailer = options.mailer;
    if (this.mailer && !options.publicUrl) throw new Error('Email needs the app\'s public URL (EVORA_PUBLIC_URL) for the links in its messages');
    this.origin = (options.publicUrl ?? '').replace(/\/+$/, '');
    this.now = options.now ?? Date.now;
    this.resends = new RateLimiter(options.limits.emailResends, options.limits.windowMs);
    this.failures = new RateLimiter(options.limits.emailTokenFailures, options.limits.windowMs);
    this.inviteMails = new RateLimiter(INVITE_EMAILS_PER_WINDOW, options.limits.windowMs);
    this.inviteRecipients = new RateLimiter(INVITE_EMAILS_PER_ADDRESS, DAY_MS);
    this.verifyRecipients = new RateLimiter(VERIFY_EMAILS_PER_ADDRESS, DAY_MS);
    this.mentionMails = new RateLimiter(MENTION_EMAILS_PER_DOC, options.limits.windowMs);
    this.unsubscribe = this.mailer ? this.store.onNotify((note) => this.mentioned(note)) : () => undefined;
    if (!this.mailer) this.takeUpWaiting();
  }

  /**
   * With email off, an invitation goes to whichever account has the address:
   * the invitations left waiting for an account whose address was not
   * confirmed (while email was on) are taken up now.
   */
  private takeUpWaiting(): void {
    const waiting = this.store.all<UserRow>(`SELECT * FROM users WHERE email IN (SELECT email FROM workspace_invites UNION SELECT email FROM document_invites)`);
    if (waiting.length) this.store.tx(() => waiting.forEach((user) => this.store.takeUpInvites(user)));
  }

  /** Whether mail can be sent to an address: always with email off (nothing is sent). */
  usable(address: string): boolean {
    return !this.on || isMailAddress(address);
  }

  /** Whether this server sends email. */
  get on(): boolean {
    return this.mailer !== null;
  }

  close(): void {
    this.unsubscribe();
  }

  isVerified(user: UserRow): boolean {
    return user.email_verified === 1;
  }

  /**
   * Whether an invitation by email to this account's address may be given to
   * it now. With email off, as before: yes. With email on, only once its
   * address is confirmed (until then the invitation waits).
   */
  takesInvites(user: UserRow): boolean {
    return !this.on || this.isVerified(user);
  }

  /** The account's link, if one was made: for its address, or for the new address it asked for. */
  private heldLink(user: UserRow): { email: string } | undefined {
    return this.store.one<{ email: string }>(`SELECT email FROM email_tokens WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`, user.id);
  }

  /** What the app shows: whether mail is on, the address and whether it is confirmed, a new address waiting for its link, whether a link was sent, and the mention setting. */
  status(user: UserRow): { mail: boolean; email: string; verified: boolean; mentionEmails: boolean; pendingEmail: string | null; linkSent: boolean } {
    const held = this.on ? this.heldLink(user) : undefined;
    return {
      mail: this.on,
      email: user.email,
      verified: this.isVerified(user),
      mentionEmails: user.mention_emails !== 0,
      pendingEmail: held && held.email !== user.email ? held.email : null,
      linkSent: !!held,
    };
  }

  /**
   * An account whose address is not confirmed and that was never sent a link
   * (it was made while email was off) is sent one, once.
   */
  linkIfNeverSent(user: UserRow): void {
    if (this.on && !this.isVerified(user) && !this.heldLink(user)) this.sendVerification(user);
  }

  // -------------------------------------------------------------- confirming an address

  /**
   * Makes a new link (older ones stop working) for the account's address, or
   * for the new address it asks for, and sends it there. Links sent to one
   * address are limited per day, whoever asks.
   */
  private link(user: UserRow, address: string): 'sent' | 'limited' | 'failed' {
    if (!this.mailer || !isMailAddress(address)) return 'failed';
    const at = this.now();
    if (!this.verifyRecipients.allowed(address, at)) return 'limited';
    const token = newToken();
    const hash = hashToken(token);
    const changing = address !== user.email;
    this.store.tx(() => {
      this.store.run(`DELETE FROM email_tokens WHERE user_id = ?`, user.id);
      this.store.run(
        `INSERT INTO email_tokens (token_hash, user_id, email, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
        hash,
        user.id,
        address,
        at,
        at + VERIFY_TTL_MS,
      );
    });
    // The account's name is left out: the server sends this to an address someone typed.
    const queued = this.mailer.send(
      composeMessage(
        address,
        'Confirm your email address for Evora',
        [
          'Hello,',
          changing
            ? 'Please confirm that this is your email address: an Evora account asked to use it. It does so once you follow the link, which works once, for 24 hours.'
            : 'Please confirm that this is your email address, so that invitations sent to it reach you. The link works once, for 24 hours.',
        ],
        { label: 'Confirm your email address', url: `${this.origin}/#/verify-email/${token}` },
        changing ? 'If you did not ask Evora to use this address, you can ignore this email.' : 'If you did not make an Evora account with this address, you can ignore this email.',
      ),
    );
    if (!queued) {
      this.store.run(`DELETE FROM email_tokens WHERE token_hash = ?`, hash);
      return 'failed';
    }
    this.verifyRecipients.hit(address, at);
    return 'sent';
  }

  /** Makes a new link for the account's current address (older ones stop working) and sends it. False when email is off or it was not sent. */
  sendVerification(user: UserRow): boolean {
    if (!this.mailer || this.isVerified(user)) return false;
    return this.link(user, user.email) === 'sent';
  }

  /** Asking for another link (for the new address, if one was asked for): limited per account, counted once it is sent. */
  resend(user: UserRow): void {
    if (!this.on) throw new EmailError(409, 'This server does not send email');
    const pending = this.status(user).pendingEmail;
    if (this.isVerified(user) && !pending) throw new EmailError(409, 'Your email address is already confirmed');
    if (!this.resends.allowed(user.id, this.now())) throw new EmailError(429, 'Too many emails asked for: try again later');
    const outcome = this.link(user, pending ?? user.email);
    if (outcome === 'limited') throw new EmailError(429, 'Too many emails were sent to this address today: try again tomorrow');
    if (outcome === 'failed') throw new EmailError(503, 'The email could not be queued: try again later');
    this.resends.hit(user.id, this.now());
  }

  /**
   * Follows a link: the account's address is confirmed, the token is used up,
   * and the invitations waiting for the address are taken up. A token that is
   * wrong, used, expired, or for an address the account no longer has fails,
   * and too many failures from one client address are refused for a while.
   */
  confirm(token: string, ip: string): UserRow {
    if (!this.failures.allowed(ip, this.now())) throw new EmailError(429, 'Too many attempts: try again later');
    const fail = (message: string): never => {
      this.failures.hit(ip, this.now());
      throw new EmailError(400, message);
    };
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return fail('This link is not valid');
    const hash = hashToken(token);
    // The transaction ends with either the confirmed account or why not; nothing in it throws, so the token is used up either way.
    const outcome = this.store.tx((): UserRow | string => {
      const held = this.store.one<{ user_id: string; email: string; expires_at: number }>(`SELECT user_id, email, expires_at FROM email_tokens WHERE token_hash = ?`, hash);
      if (!held) return 'This link is not valid, or was already used';
      this.store.run(`DELETE FROM email_tokens WHERE token_hash = ?`, hash);
      if (held.expires_at <= this.now()) return 'This link has expired: ask Evora for a new one';
      const user = this.store.userById(held.user_id);
      if (!user) return 'This link is for an account that no longer exists';
      const address = normalizeEmail(held.email);
      if (address !== normalizeEmail(user.email)) {
        // A new address the account asked for: it becomes the account's now, if nobody else has made an account with it since.
        const holder = this.store.userByEmail(address);
        if (holder && holder.id !== user.id) return 'There is now another account with this address';
        this.store.run(`UPDATE users SET email = ?, email_verified = 1 WHERE id = ?`, address, user.id);
      } else this.store.run(`UPDATE users SET email_verified = 1 WHERE id = ?`, user.id);
      this.store.run(`DELETE FROM email_tokens WHERE user_id = ?`, user.id);
      const confirmed = { ...user, email: address, email_verified: 1 };
      this.store.takeUpInvites(confirmed);
      return confirmed;
    });
    return typeof outcome === 'string' ? fail(outcome) : outcome;
  }

  // -------------------------------------------------------------- invitations

  /**
   * Tells an address it was invited. `joined`: the account with that address
   * is now a member; otherwise the invitation waits for an account with the
   * address (and, with email on, a confirmed one). `hasAccount`: an account
   * has the address but has not confirmed it yet.
   */
  invited(to: string, from: UserRow, place: { kind: 'workspace' | 'file'; id: string; name: string }, role: Role, joined: boolean, hasAccount = false): void {
    if (!this.mailer) return;
    // The server sends these to any address, with names people typed in them: one account may cause only so many,
    // and one address may be sent only so many, however many accounts invite it or however often.
    const at = this.now();
    const recipient = normalizeEmail(to);
    if (!this.inviteMails.allowed(from.id, at) || !this.inviteRecipients.allowed(recipient, at)) return;
    this.inviteMails.hit(from.id, at);
    this.inviteRecipients.hit(recipient, at);
    const what = place.kind === 'workspace' ? `the workspace “${place.name}”` : `the file “${place.name}”`;
    const url = place.kind === 'workspace' ? `${this.origin}/#/workspace/${encodeURIComponent(place.id)}` : `${this.origin}/#/doc/${encodeURIComponent(place.id)}`;
    const how = joined
      ? `You can open it now with your Evora account (${to}).`
      : hasAccount
        ? `To join, confirm this address (${to}) for your Evora account: follow the link in the email Evora sent you, or sign in and choose Send a link.`
        : `To join, sign in or create a free Evora account with this address (${to}) and confirm the address from the email Evora sends you.`;
    this.mailer.send(
      composeMessage(
        to,
        `${from.name} invited you to ${what} on Evora`,
        [`${from.name} invited you to ${what} on Evora, as ${ROLE_WORDS[role]}.`, how],
        { label: place.kind === 'workspace' ? 'Open the workspace' : 'Open the file', url },
        'You get this because someone invited this address in Evora. If you were not expecting it, you can ignore this email.',
      ),
    );
  }

  // -------------------------------------------------------------- mentions

  /** A mention in a comment, emailed to the person's confirmed address unless they turned it off. */
  private mentioned(note: NotificationEvent): void {
    if (!this.mailer || note.kind !== 'mention' || !note.where.docId) return;
    const user = this.store.userById(note.recipientId);
    if (!user || !this.isVerified(user) || user.mention_emails === 0) return;
    const doc = this.store.docById(note.where.docId);
    if (!doc) return;
    // Mentions made again and again (a comment edited to drop and add one, many comments) send only so many emails.
    const key = `${user.id}|${doc.id}`;
    if (!this.mentionMails.allowed(key, this.now())) return;
    this.mentionMails.hit(key, this.now());
    const author = this.store.ref(note.from.id, note.from.guest).name;
    const url = note.where.threadId
      ? `${this.origin}/#/doc/${encodeURIComponent(doc.id)}/comment/${encodeURIComponent(note.where.threadId)}`
      : `${this.origin}/#/doc/${encodeURIComponent(doc.id)}`;
    this.mailer.send(
      composeMessage(
        user.email,
        `${author} mentioned you in “${doc.name}”`,
        [`${author} mentioned you in a comment on “${doc.name}”:`, note.text],
        { label: 'Open the comment', url },
        'You get this because someone mentioned you in Evora. To stop these emails, choose Email settings in your account menu.',
      ),
    );
  }

  // -------------------------------------------------------------- changing the address

  /**
   * Asks for a new address: it must be free, and a link is sent to it; the
   * account keeps its address until the link is followed (`confirm`), so an
   * address nobody confirmed is never held. Limited per account like asking
   * for another link. Run after the password (or a recent sign-in) was checked.
   */
  changeAddress(user: UserRow, address: string): void {
    if (!this.on) throw new EmailError(409, 'This server does not send email, so a new address could not be confirmed');
    if (!isMailAddress(address)) throw new EmailError(400, 'Email cannot be sent to that address');
    const holder = this.store.userByEmail(address);
    if (holder && holder.id !== user.id) throw new EmailError(409, 'There is already an account with this email');
    if (!this.resends.allowed(user.id, this.now())) throw new EmailError(429, 'Too many emails asked for: try again later');
    const outcome = this.link(user, address);
    if (outcome === 'limited') throw new EmailError(429, 'Too many emails were sent to this address today: try again tomorrow');
    if (outcome === 'failed') throw new EmailError(503, 'The email could not be queued: try again later');
    this.resends.hit(user.id, this.now());
  }

  /** Whether an account without a password signed in recently enough (in this session) to ask for a new address. */
  signedInRecently(sessionHash: string): boolean {
    const session = this.store.one<{ created_at: string }>(`SELECT created_at FROM sessions WHERE token_hash = ?`, sessionHash);
    return !!session && this.now() - Date.parse(session.created_at) <= FRESH_SIGN_IN_MS;
  }
}

/** The routes listed at the top of this file. */
export function emailRoutes(kit: ApiKit, email: EmailService): Route<Ctx>[] {
  const { route, store, HttpError } = kit;
  const wrap = <T>(work: () => T): T => {
    try {
      return work();
    } catch (error) {
      if (error instanceof EmailError) throw new HttpError(error.status, error.message);
      throw error;
    }
  };
  const passwordChecks = new RateLimiter(10, 15 * 60 * 1000);

  return [
    route('GET', '/api/me/email', (ctx) => {
      const user = kit.requireUser(ctx);
      // An account from before email was on gets its link the first time the app asks.
      email.linkIfNeverSent(user);
      return email.status(user);
    }),

    route('PATCH', '/api/me/email', async (ctx) => {
      const user = kit.requireUser(ctx);
      const body = await ctx.json();
      if (body.mentionEmails !== undefined && typeof body.mentionEmails !== 'boolean') throw new HttpError(400, 'mentionEmails must be true or false');
      let address: string | undefined;
      if (body.email !== undefined) {
        address = normalizeEmail(kit.text(body, 'email', 254));
        if (!EMAIL.test(address)) throw new HttpError(400, 'That is not an email address');
        if (address === user.email) address = undefined;
      }
      if (address !== undefined) {
        if (!email.on) throw new HttpError(409, 'This server does not send email, so a new address could not be confirmed');
        if (!email.usable(address)) throw new HttpError(400, 'Email cannot be sent to that address');
      }
      if (address !== undefined && user.password) {
        // A new address takes the password: whoever finds a session left open cannot take the account's invitations elsewhere.
        if (!passwordChecks.allowed(user.id)) throw new HttpError(429, 'Too many wrong attempts: try again later');
        const ok = typeof body.password === 'string' && (await verifyPassword(body.password, user.password));
        if (!ok) {
          passwordChecks.hit(user.id);
          throw new HttpError(403, 'Enter your current password to change your email address');
        }
      } else if (address !== undefined) {
        // No password (made through Google): a sign-in in the last few minutes stands for it.
        if (ctx.who.kind !== 'user' || !email.signedInRecently(ctx.who.sessionHash))
          throw new HttpError(403, 'Sign in with Google again to change your email address');
      }
      if (address !== undefined) wrap(() => email.changeAddress(user, address as string));
      if (typeof body.mentionEmails === 'boolean') store.run(`UPDATE users SET mention_emails = ? WHERE id = ?`, body.mentionEmails ? 1 : 0, user.id);
      return email.status(store.userById(user.id) as UserRow);
    }),

    route('POST', '/api/me/email/resend', (ctx) => {
      wrap(() => email.resend(kit.requireUser(ctx)));
      return { sent: true };
    }),

    route('POST', '/api/auth/verify-email', async (ctx) => {
      const body = await ctx.json();
      const token = typeof body.token === 'string' ? body.token : '';
      const user = wrap(() => email.confirm(token, ctx.ip));
      return { email: user.email, verified: true };
    }),
  ];
}
