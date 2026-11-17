/**
 * The HTTP API under /api, as listed in `src/collab/protocol.ts`, with the
 * permissions it states. Everything is free and unlimited: no plans, no seat
 * limits, no feature gates; any number of workspaces, members and documents.
 *
 * Who may do what in a document is the strongest of their own role in it,
 * their role in its workspace, and what its link gives anyone (guests too).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { createReadStream, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  GOOGLE_RETURN_ROUTE,
  canEdit,
  mentionsIn,
  type AuthResult,
  type DocInfo,
  type GuestResult,
  type Register,
  type Role,
} from '../src/collab/protocol.ts';
import { HttpError, clientAddress, match, readBody, readJson, route, sendError, sendJson, type Route } from './http.ts';
import { RateLimiter, decoyHash, hashPassword, hashToken, newToken, verifyPassword } from './auth.ts';
import {
  invalidRegisters,
  isLinkAccess,
  isRole,
  newId,
  normalizeEmail,
  now,
  personId,
  type DocRow,
  type Identity,
  type Store,
  type ThreadRow,
  type UserRow,
  type WorkspaceRow,
} from './store.ts';
import type { Hub } from './hub.ts';
import {
  CALLBACK_PATH,
  GoogleError,
  STATE_COOKIE,
  STATE_TTL_MS,
  TICKET_TTL_MS,
  allowedOrigin,
  asOrigin,
  consentUrl,
  cookieValue,
  fetchProfile,
  pkce,
  type GoogleConfig,
  type GoogleProfile,
} from './google.ts';

export interface Limits {
  /** Wrong passwords allowed per address and email in a window. */
  loginFailures: number;
  /** Accounts that may be made from one address in a window. */
  signups: number;
  /** Guests that may be made from one address in a window. */
  guests: number;
  windowMs: number;
}

export const DEFAULT_LIMITS: Limits = { loginFailures: 10, signups: 100, guests: 200, windowMs: 15 * 60 * 1000 };

export interface ApiOptions {
  version: string;
  /** The largest JSON body for most requests. */
  maxJsonBytes: number;
  /** The largest body for a new document's content and for an image. */
  maxUploadBytes: number;
  limits: Limits;
  /** Signing in with Google; off when not given. */
  google?: GoogleConfig | null;
  /** The app's public origin (EVORA_PUBLIC_URL), where Google sends people back to; otherwise only this computer's addresses are accepted. */
  publicUrl?: string | null;
  /** More routes, from the parts of the server built on this one (version history, plugins, community). */
  extensions?: ApiExtension[];
}

/**
 * What a part of the server built on the API gets to make its routes with:
 * the store and hub, and the API's own helpers for who is asking and what
 * they may do, so that every route checks access the same way.
 */
export interface ApiKit {
  store: Store;
  hub: Hub;
  route: typeof route<Ctx>;
  HttpError: typeof HttpError;
  /** An answer with a status other than 200: `new kit.Reply(201, body)`. */
  Reply: typeof Reply;
  /** Return this from a handler that has written the response itself. */
  HANDLED: typeof HANDLED;
  requireUser(ctx: Ctx): UserRow;
  requirePerson(ctx: Ctx): { id: string; guest: boolean };
  workspaceOf(ctx: Ctx, id: string, least?: Role): { workspace: WorkspaceRow; role: Role; user: UserRow };
  docOf(ctx: Ctx, id: string): { doc: DocRow; role: Role };
  info(doc: DocRow, who: Identity): DocInfo;
  text(body: Record<string, unknown>, key: string, max: number): string;
  optionalText(body: Record<string, unknown>, key: string, max: number): string | undefined;
  maxUploadBytes: number;
}

/** A part of the server that adds routes. */
export type ApiExtension = (kit: ApiKit) => Route<Ctx>[];

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  who: Identity;
  /**
   * Why the credentials sent no longer work (a session that ended), or null.
   * Such a request is answered as if nobody in particular asked, so that
   * signing in again works; anything that needs to know who is asking is 401.
   */
  stale: string | null;
  ip: string;
  /** The JSON body, up to the usual limit unless another is given. */
  json(limit?: number): Promise<Record<string, unknown>>;
}

/** An answer with a status other than 200. */
class Reply {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown) {
    this.status = status;
    this.body = body;
  }
}

/** Returned by a handler that has written the response itself. */
const HANDLED = Symbol('handled');

const EMAIL = /^[^\s@]+@[^\s@]+$/;
const ASSET_HASH = /^[0-9a-f]{64}$/;
const COLOR = /^#[0-9a-fA-F]{6}$/;
const ROLE_RANK: Record<Role, number> = { owner: 3, editor: 2, viewer: 1 };

// ------------------------------------------------------------------ checking what was sent

function text(body: Record<string, unknown>, key: string, max: number): string {
  const value = body[key];
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, `${key} is required`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new HttpError(400, `${key} is longer than ${max} characters`);
  return trimmed;
}

function optionalText(body: Record<string, unknown>, key: string, max: number): string | undefined {
  return body[key] === undefined ? undefined : text(body, key, max);
}

function email(body: Record<string, unknown>): string {
  const value = normalizeEmail(text(body, 'email', 254));
  if (!EMAIL.test(value)) throw new HttpError(400, 'That is not an email address');
  return value;
}

function role(body: Record<string, unknown>): Role {
  if (!isRole(body.role)) throw new HttpError(400, 'role must be owner, editor or viewer');
  return body.role;
}

function password(body: Record<string, unknown>): string {
  const value = body.password;
  if (typeof value !== 'string' || value.length < 8) throw new HttpError(400, 'The password must have at least 8 characters');
  if (value.length > 1024) throw new HttpError(400, 'The password is too long');
  return value;
}

function finite(body: Record<string, unknown>, key: string): number {
  const value = body[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new HttpError(400, `${key} must be a number`);
  return value;
}

function commentBody(body: Record<string, unknown>): string {
  const value = body.body;
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, 'A comment needs some text');
  if (value.length > 20_000) throw new HttpError(400, 'A comment is limited to 20,000 characters');
  return value.trim();
}

// ------------------------------------------------------------------ the API

export function createApi(store: Store, hub: Hub, options: ApiOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const loginFailures = new RateLimiter(options.limits.loginFailures, options.limits.windowMs);
  const signups = new RateLimiter(options.limits.signups, options.limits.windowMs);
  const guests = new RateLimiter(options.limits.guests, options.limits.windowMs);

  // -------------------------------------------------------------- who is asking

  function identify(req: IncomingMessage): { who: Identity; stale: string | null } {
    const authorization = req.headers.authorization;
    if (authorization) {
      const found = /^Bearer\s+(\S+)$/i.exec(authorization);
      const hash = found ? hashToken(found[1] as string) : '';
      const user = hash ? store.sessionUser(hash) : undefined;
      if (!user) return { who: { kind: 'anonymous' }, stale: 'Your session has ended: sign in again' };
      return { who: { kind: 'user', user, sessionHash: hash }, stale: null };
    }
    const guestToken = req.headers['x-evora-guest'];
    if (typeof guestToken === 'string' && guestToken) {
      const guest = store.guestByToken(hashToken(guestToken));
      if (!guest) return { who: { kind: 'anonymous' }, stale: 'This guest pass is no longer valid' };
      return { who: { kind: 'guest', guest }, stale: null };
    }
    return { who: { kind: 'anonymous' }, stale: null };
  }

  function requireUser(ctx: Ctx): UserRow {
    if (ctx.who.kind !== 'user') throw new HttpError(401, ctx.stale ?? 'Sign in first');
    return ctx.who.user;
  }

  /** Someone who can be named as an author: a user or a guest. */
  function requirePerson(ctx: Ctx): { id: string; guest: boolean } {
    if (ctx.who.kind === 'user') return { id: ctx.who.user.id, guest: false };
    if (ctx.who.kind === 'guest') return { id: ctx.who.guest.id, guest: true };
    throw new HttpError(401, ctx.stale ?? 'Sign in, or join as a guest, first');
  }

  // -------------------------------------------------------------- workspaces and documents, with access

  /** A workspace the person is a member of, with their role there; someone outside it is told it does not exist. */
  function workspaceOf(ctx: Ctx, id: string, least: Role = 'viewer'): { workspace: WorkspaceRow; role: Role; user: UserRow } {
    const user = requireUser(ctx);
    const workspace = store.workspaceById(id);
    const held = workspace ? store.workspaceRole(id, user.id) : null;
    if (!workspace || !held) throw new HttpError(404, 'There is no such workspace');
    if (ROLE_RANK[held] < ROLE_RANK[least]) throw new HttpError(403, least === 'owner' ? 'Only an owner of the workspace can do this' : 'Viewers cannot do this');
    return { workspace, role: held, user };
  }

  function access(ctx: Ctx, doc: DocRow): Role {
    if (ctx.stale) throw new HttpError(401, ctx.stale);
    const held = store.roleOn(doc, ctx.who);
    if (held) return held;
    if (ctx.who.kind === 'anonymous') throw new HttpError(401, 'Sign in, or join as a guest, to open this document');
    throw new HttpError(403, 'You do not have access to this document');
  }

  function docOf(ctx: Ctx, id: string): { doc: DocRow; role: Role } {
    const doc = store.docById(id);
    if (!doc) throw new HttpError(404, 'There is no such document');
    return { doc, role: access(ctx, doc) };
  }

  function info(doc: DocRow, who: Identity): DocInfo {
    return store.docDto(doc, store.roleOn(doc, who));
  }

  function workspaceDocIds(workspaceId: string): string[] {
    return store.docsInWorkspace(workspaceId).map((doc) => doc.id);
  }

  /** Changes to who may manage people need an account: a guest cannot share a document or change its link. */
  function requireAccountToShare(ctx: Ctx): UserRow {
    if (ctx.who.kind !== 'user') throw new HttpError(403, 'Sign in to change who has access');
    return ctx.who.user;
  }

  function addPending(table: 'workspace_invites' | 'document_invites', column: 'workspace_id' | 'doc_id', id: string, address: string, wanted: Role, by: string): void {
    const held = store.one<{ role: Role }>(`SELECT role FROM ${table} WHERE ${column} = ? AND email = ?`, id, address);
    if (!held) store.run(`INSERT INTO ${table} (${column}, email, role, invited_by, created_at) VALUES (?, ?, ?, ?, ?)`, id, address, wanted, by, now());
    else if (ROLE_RANK[wanted] > ROLE_RANK[held.role]) store.run(`UPDATE ${table} SET role = ? WHERE ${column} = ? AND email = ?`, wanted, id, address);
  }

  /** Takes up the invitations waiting for an email address (a new account was made with it). */
  function takeUpInvites(user: UserRow): void {
    for (const invite of store.all<{ workspace_id: string; role: Role; invited_by: string }>(
      `SELECT workspace_id, role, invited_by FROM workspace_invites WHERE email = ? ORDER BY created_at, rowid`,
      user.email,
    )) {
      const workspace = store.workspaceById(invite.workspace_id);
      if (!workspace) continue;
      if (store.addWorkspaceMember(workspace.id, user.id, invite.role))
        store.notify(user.id, 'invite', { id: invite.invited_by, guest: false }, workspace.name, { workspaceId: workspace.id });
    }
    store.run(`DELETE FROM workspace_invites WHERE email = ?`, user.email);
    for (const invite of store.all<{ doc_id: string; role: Role; invited_by: string }>(
      `SELECT doc_id, role, invited_by FROM document_invites WHERE email = ? ORDER BY created_at, rowid`,
      user.email,
    )) {
      const doc = store.docById(invite.doc_id);
      if (!doc) continue;
      if (store.addDocMember(doc.id, user.id, invite.role))
        store.notify(user.id, 'shared', { id: invite.invited_by, guest: false }, doc.name, { docId: doc.id, workspaceId: doc.workspace_id });
    }
    store.run(`DELETE FROM document_invites WHERE email = ?`, user.email);
  }

  /** Makes an account with its own workspace, and takes up the invitations waiting for its email. Run inside a transaction. */
  function createUser(address: string, name: string, hashed: string, googleSub: string | null): UserRow {
    const user: UserRow = { id: newId(), email: address, name, color: store.nextColor(), password: hashed, created_at: now(), google_sub: googleSub };
    store.run(
      `INSERT INTO users (id, email, name, color, password, created_at, google_sub) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      user.id,
      user.email,
      user.name,
      user.color,
      user.password,
      user.created_at,
      googleSub,
    );
    store.createWorkspace(`${name}'s workspace`, user.id);
    takeUpInvites(user);
    return user;
  }

  function startSession(user: UserRow): AuthResult {
    const token = newToken();
    store.createSession(user.id, token, hashToken(token));
    return { token, user: store.userDto(user) };
  }

  // -------------------------------------------------------------- comments

  function threadOf(ctx: Ctx, id: string): { thread: ThreadRow; doc: DocRow; role: Role } {
    const thread = store.threadById(id);
    const doc = thread ? store.docById(thread.doc_id) : undefined;
    if (!thread || !doc) throw new HttpError(404, 'There is no such comment thread');
    return { thread, doc, role: access(ctx, doc) };
  }

  function isAuthor(ctx: Ctx, author: { id: string; guest: boolean } | null): boolean {
    return !!author && author.id === personId(ctx.who) && author.guest === (ctx.who.kind === 'guest');
  }

  function publishThread(docId: string, threadId: string): ReturnType<Store['threadDto']> {
    const thread = store.threadDto(store.threadById(threadId) as ThreadRow);
    hub.comment(docId, { kind: 'thread', thread });
    return thread;
  }

  // -------------------------------------------------------------- routes

  const routes: Route<Ctx>[] = [
    route('GET', '/api/health', () => ({ ok: true, version: options.version })),

    // ---- accounts

    route('POST', '/api/auth/signup', async (ctx) => {
      const body = await ctx.json();
      const address = email(body);
      const name = text(body, 'name', 100);
      const secret = password(body);
      if (!signups.allowed(ctx.ip)) throw new HttpError(429, 'Too many accounts made from here: try again later');
      signups.hit(ctx.ip);
      if (store.userByEmail(address)) throw new HttpError(409, 'There is already an account with this email');
      const hashed = await hashPassword(secret);
      const result = store.tx(() => {
        if (store.userByEmail(address)) throw new HttpError(409, 'There is already an account with this email');
        return startSession(createUser(address, name, hashed, null));
      });
      return new Reply(201, result);
    }),

    route('POST', '/api/auth/login', async (ctx) => {
      const body = await ctx.json();
      const address = email(body);
      const secret = typeof body.password === 'string' ? body.password : '';
      const key = `${ctx.ip}|${address}`;
      if (!loginFailures.allowed(key)) throw new HttpError(429, 'Too many wrong attempts: try again later');
      const user = store.userByEmail(address);
      // An unknown email, or an account made with Google that has no password, is checked against a decoy,
      // so it takes as long as a wrong password and gets the same answer.
      const ok = (await verifyPassword(secret, user?.password ? user.password : await decoyHash())) && !!user?.password;
      if (!ok || !user) {
        loginFailures.hit(key);
        throw new HttpError(401, 'Wrong email or password');
      }
      loginFailures.reset(key);
      return startSession(user);
    }),

    route('POST', '/api/auth/logout', (ctx) => {
      if (ctx.who.kind === 'user') {
        store.run(`DELETE FROM sessions WHERE token_hash = ?`, ctx.who.sessionHash);
        hub.endSession(ctx.who.sessionHash);
      }
      return {};
    }),

    // ---- signing in with Google (the flow is described in server/google.ts)

    route('GET', '/api/auth/providers', () => ({ google: !!options.google })),

    route('GET', '/api/auth/google/start', (ctx) => {
      const google = options.google;
      if (!google) throw new HttpError(404, 'Signing in with Google is not set up on this server');
      const query = new URL(ctx.req.url ?? '/', 'http://localhost').searchParams;
      const origin = allowedOrigin(query.get('origin'), options.publicUrl);
      if (!origin) throw new HttpError(400, 'origin must be the address of the app: its public URL, or localhost');
      const mode = query.get('mode') === 'signup' ? 'signup' : 'login';
      const invite = query.get('invite');
      const state = newToken();
      const { verifier, challenge } = pkce();
      const nowMs = Date.now();
      store.tx(() => {
        // A state is kept until it expires, a used one too, so that a second use is still answered on the right site.
        store.run(`DELETE FROM google_states WHERE expires_at <= ?`, nowMs - STATE_TTL_MS);
        store.run(
          `INSERT INTO google_states (state_hash, verifier, origin, mode, invite, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
          hashToken(state),
          verifier,
          origin,
          mode,
          invite && invite.length <= 200 ? invite : null,
          nowMs + STATE_TTL_MS,
        );
      });
      const secure = origin.startsWith('https:') ? '; Secure' : '';
      ctx.res.writeHead(302, {
        Location: consentUrl(google, `${origin}${CALLBACK_PATH}`, state, challenge),
        'Cache-Control': 'no-store',
        // Ties the sign-in to this browser: a callback brought from elsewhere (with someone else's code) is refused.
        'Set-Cookie': `${STATE_COOKIE}=${state}; Path=/api/auth/google; Max-Age=${STATE_TTL_MS / 1000}; HttpOnly; SameSite=Lax${secure}`,
        'Content-Length': 0,
      });
      ctx.res.end();
      return HANDLED;
    }),

    route('GET', CALLBACK_PATH, async (ctx) => {
      const query = new URL(ctx.req.url ?? '/', 'http://localhost').searchParams;
      const state = query.get('state') ?? '';
      const stateHash = hashToken(state);
      const found = state
        ? store.one<{ verifier: string; origin: string; invite: string | null; expires_at: number; used: number }>(
            `SELECT verifier, origin, invite, expires_at, used FROM google_states WHERE state_hash = ?`,
            stateHash,
          )
        : undefined;
      const back = (origin: string, params: Record<string, string>): typeof HANDLED => {
        ctx.res.writeHead(302, {
          Location: `${origin}/${GOOGLE_RETURN_ROUTE}?${new URLSearchParams(params).toString()}`,
          'Cache-Control': 'no-store',
          'Set-Cookie': `${STATE_COOKIE}=; Path=/api/auth/google; Max-Age=0; HttpOnly; SameSite=Lax`,
          'Content-Length': 0,
        });
        ctx.res.end();
        return HANDLED;
      };
      if (!found) {
        // Without a state given out here there is no telling which site to go back to: the public one, if it is known.
        const fallback = asOrigin(options.publicUrl);
        if (fallback) return back(fallback, { error: 'This sign-in link is not valid: try again' });
        throw new HttpError(400, 'This sign-in link is not valid: go back to Evora and try again');
      }
      const fail = (message: string): typeof HANDLED => back(found.origin, { error: message });
      // Used once only, whatever happens next.
      if (found.used || store.run(`UPDATE google_states SET used = 1 WHERE state_hash = ? AND used = 0`, stateHash) === 0)
        return fail('This sign-in was already used: try again');
      if (found.expires_at <= Date.now()) return fail('The sign-in took too long: try again');
      if (cookieValue(ctx.req.headers.cookie, STATE_COOKIE) !== state) return fail('The sign-in was started in another browser: try again');
      const google = options.google;
      if (!google) return fail('Signing in with Google is not set up on this server');
      const refused = query.get('error');
      if (refused) return fail(refused === 'access_denied' ? 'Signing in with Google was cancelled' : 'Google did not complete the sign-in');
      const code = query.get('code');
      if (!code) return fail('Google did not complete the sign-in');

      let profile: GoogleProfile;
      try {
        profile = await fetchProfile(google, code, found.verifier, `${found.origin}${CALLBACK_PATH}`);
      } catch (error) {
        if (error instanceof GoogleError) return fail(error.message);
        throw error;
      }
      if (!profile.emailVerified) return fail('Google has not verified this email address');
      const address = normalizeEmail(profile.email);
      if (!EMAIL.test(address) || address.length > 254) return fail('Google gave an email address that cannot be used');

      let user: UserRow;
      try {
        user = store.tx(() => {
          const bySub = store.userByGoogle(profile.sub);
          if (bySub) return bySub;
          const byEmail = store.userByEmail(address);
          if (byEmail) {
            if (byEmail.google_sub) throw new HttpError(409, 'The account with this email is linked to another Google account');
            // Google has verified that the address is theirs: the account is linked to this Google account.
            store.run(`UPDATE users SET google_sub = ? WHERE id = ?`, profile.sub, byEmail.id);
            return { ...byEmail, google_sub: profile.sub };
          }
          if (!signups.allowed(ctx.ip)) throw new HttpError(429, 'Too many accounts made from here: try again later');
          signups.hit(ctx.ip);
          // No password: one can be set later (PATCH /api/me); until then signing in with a password fails as a wrong one does.
          return createUser(address, profile.name, '', profile.sub);
        });
      } catch (error) {
        if (error instanceof HttpError) return fail(error.message);
        throw error;
      }

      // Started from an invite link: joined at once, as accepting it does.
      if (found.invite) {
        const link = store.one<{ workspace_id: string; role: Role }>(`SELECT workspace_id, role FROM invite_links WHERE token_hash = ?`, hashToken(found.invite));
        if (link && store.workspaceById(link.workspace_id)) {
          store.addWorkspaceMember(link.workspace_id, user.id, link.role);
          hub.recheck(workspaceDocIds(link.workspace_id));
        }
      }

      const ticket = newToken();
      const nowMs = Date.now();
      store.tx(() => {
        store.run(`DELETE FROM google_tickets WHERE expires_at <= ?`, nowMs);
        store.run(`INSERT INTO google_tickets (ticket_hash, user_id, expires_at) VALUES (?, ?, ?)`, hashToken(ticket), user.id, nowMs + TICKET_TTL_MS);
      });
      return back(found.origin, { ticket });
    }),

    route('POST', '/api/auth/google/redeem', async (ctx) => {
      const hash = hashToken(text(await ctx.json(), 'ticket', 200));
      return store.tx(() => {
        const held = store.one<{ user_id: string; expires_at: number }>(`SELECT user_id, expires_at FROM google_tickets WHERE ticket_hash = ?`, hash);
        // Once only.
        store.run(`DELETE FROM google_tickets WHERE ticket_hash = ?`, hash);
        const user = held && held.expires_at > Date.now() ? store.userById(held.user_id) : undefined;
        if (!user) throw new HttpError(401, 'This sign-in has expired or was already used: try again');
        // The session starts here, so its token is only ever in this answer, never in a URL.
        return startSession(user);
      });
    }),

    route('POST', '/api/guests', async (ctx) => {
      const body = await ctx.json();
      const name = text(body, 'name', 100);
      if (!guests.allowed(ctx.ip)) throw new HttpError(429, 'Too many guests from here: try again later');
      guests.hit(ctx.ip);
      const token = newToken();
      const guest = { id: newId(), name, color: store.nextColor(), created_at: now() };
      store.run(`INSERT INTO guests (id, token_hash, name, color, created_at) VALUES (?, ?, ?, ?, ?)`, guest.id, hashToken(token), name, guest.color, guest.created_at);
      const result: GuestResult = { guestToken: token, guest: store.guestDto(guest) };
      return result;
    }),

    route('GET', '/api/me', (ctx) => {
      const user = requireUser(ctx);
      return { user: store.userDto(user), workspaces: store.workspacesOf(user.id) };
    }),

    route('PATCH', '/api/me', async (ctx) => {
      const user = requireUser(ctx);
      const body = await ctx.json();
      const name = optionalText(body, 'name', 100);
      const color = body.color === undefined ? undefined : typeof body.color === 'string' && COLOR.test(body.color) ? body.color.toLowerCase() : null;
      if (color === null) throw new HttpError(400, 'color must be written as #rrggbb');
      const secret = body.password === undefined ? undefined : password(body);
      const hashed = secret === undefined ? undefined : await hashPassword(secret);
      store.tx(() => {
        if (name !== undefined) store.run(`UPDATE users SET name = ? WHERE id = ?`, name, user.id);
        if (color !== undefined) store.run(`UPDATE users SET color = ? WHERE id = ?`, color, user.id);
        if (hashed !== undefined) store.run(`UPDATE users SET password = ? WHERE id = ?`, hashed, user.id);
      });
      if (hashed !== undefined && ctx.who.kind === 'user') {
        // A new password ends every other session: whoever knew the old one is signed out.
        const current = ctx.who.sessionHash;
        for (const session of store.all<{ token_hash: string }>(`SELECT token_hash FROM sessions WHERE user_id = ? AND token_hash != ?`, user.id, current)) {
          store.run(`DELETE FROM sessions WHERE token_hash = ?`, session.token_hash);
          hub.endSession(session.token_hash);
        }
      }
      const updated = store.userById(user.id) as UserRow;
      if (name !== undefined || color !== undefined) hub.renamePerson(updated);
      return store.userDto(updated);
    }),

    // ---- workspaces

    route('GET', '/api/workspaces', (ctx) => store.workspacesOf(requireUser(ctx).id)),

    route('POST', '/api/workspaces', async (ctx) => {
      const user = requireUser(ctx);
      const name = text(await ctx.json(), 'name', 100);
      return new Reply(201, store.workspaceDto(store.createWorkspace(name, user.id), 'owner'));
    }),

    route('PATCH', '/api/workspaces/:id', async (ctx, params) => {
      const { workspace } = workspaceOf(ctx, params.id as string, 'owner');
      const name = text(await ctx.json(), 'name', 100);
      store.run(`UPDATE workspaces SET name = ? WHERE id = ?`, name, workspace.id);
      return store.workspaceDto({ ...workspace, name }, 'owner');
    }),

    route('DELETE', '/api/workspaces/:id', (ctx, params) => {
      const { workspace } = workspaceOf(ctx, params.id as string, 'owner');
      hub.recheck(store.deleteWorkspace(workspace.id));
      return {};
    }),

    route('GET', '/api/workspaces/:id/members', (ctx, params) => store.workspaceMembers(workspaceOf(ctx, params.id as string).workspace.id)),

    route('POST', '/api/workspaces/:id/members', async (ctx, params) => {
      const { workspace, role: mine, user } = workspaceOf(ctx, params.id as string, 'editor');
      const body = await ctx.json();
      const address = email(body);
      const wanted = role(body);
      if (wanted === 'owner' && mine !== 'owner') throw new HttpError(403, 'Only an owner can make owners');
      const invitee = store.userByEmail(address);
      store.tx(() => {
        if (invitee) {
          if (store.addWorkspaceMember(workspace.id, invitee.id, wanted) && invitee.id !== user.id)
            store.notify(invitee.id, 'invite', { id: user.id, guest: false }, workspace.name, { workspaceId: workspace.id });
        } else addPending('workspace_invites', 'workspace_id', workspace.id, address, wanted, user.id);
      });
      if (invitee) hub.recheck(workspaceDocIds(workspace.id));
      return store.workspaceMembers(workspace.id);
    }),

    route('PATCH', '/api/workspaces/:id/members/:userId', async (ctx, params) => {
      const { workspace } = workspaceOf(ctx, params.id as string, 'owner');
      const wanted = role(await ctx.json());
      const target = params.userId as string;
      if (target.includes('@')) {
        // A pending invitation, by email.
        const changed = store.run(`UPDATE workspace_invites SET role = ? WHERE workspace_id = ? AND email = ?`, wanted, workspace.id, normalizeEmail(target));
        if (changed === 0) throw new HttpError(404, 'There is no such invitation');
        return store.workspaceMembers(workspace.id);
      }
      const held = store.workspaceRole(workspace.id, target);
      if (!held) throw new HttpError(404, 'That person is not a member of this workspace');
      if (held === 'owner' && wanted !== 'owner' && store.ownerCount(workspace.id) === 1) throw new HttpError(409, 'A workspace needs at least one owner');
      store.run(`UPDATE workspace_members SET role = ? WHERE workspace_id = ? AND user_id = ?`, wanted, workspace.id, target);
      hub.recheck(workspaceDocIds(workspace.id));
      return store.workspaceMembers(workspace.id);
    }),

    route('DELETE', '/api/workspaces/:id/members/:userId', (ctx, params) => {
      const target = params.userId as string;
      if (target.includes('@')) {
        const { workspace } = workspaceOf(ctx, params.id as string, 'editor');
        if (store.run(`DELETE FROM workspace_invites WHERE workspace_id = ? AND email = ?`, workspace.id, normalizeEmail(target)) === 0)
          throw new HttpError(404, 'There is no such invitation');
        return {};
      }
      const { workspace, role: mine, user } = workspaceOf(ctx, params.id as string);
      if (target !== user.id && mine !== 'owner') throw new HttpError(403, 'Only an owner can remove members');
      const held = store.workspaceRole(workspace.id, target);
      if (!held) throw new HttpError(404, 'That person is not a member of this workspace');
      if (held === 'owner' && store.ownerCount(workspace.id) === 1) throw new HttpError(409, 'A workspace needs at least one owner');
      store.run(`DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?`, workspace.id, target);
      hub.recheck(workspaceDocIds(workspace.id));
      return {};
    }),

    route('POST', '/api/workspaces/:id/invites', async (ctx, params) => {
      const { workspace, role: mine, user } = workspaceOf(ctx, params.id as string, 'editor');
      const wanted = role(await ctx.json());
      if (wanted === 'owner' && mine !== 'owner') throw new HttpError(403, 'Only an owner can make owners');
      const token = newToken();
      store.run(`INSERT INTO invite_links (token_hash, workspace_id, role, created_by, created_at) VALUES (?, ?, ?, ?, ?)`, hashToken(token), workspace.id, wanted, user.id, now());
      return { token };
    }),

    route('GET', '/api/invites/:token', (_ctx, params) => {
      const link = store.one<{ workspace_id: string; role: Role; created_by: string }>(
        `SELECT workspace_id, role, created_by FROM invite_links WHERE token_hash = ?`,
        hashToken(params.token as string),
      );
      const workspace = link ? store.workspaceById(link.workspace_id) : undefined;
      if (!link || !workspace) throw new HttpError(404, 'This invite link is not valid');
      return { workspace: { id: workspace.id, name: workspace.name }, role: link.role, from: store.ref(link.created_by) };
    }),

    route('POST', '/api/invites/:token/accept', (ctx, params) => {
      const user = requireUser(ctx);
      const link = store.one<{ workspace_id: string; role: Role }>(`SELECT workspace_id, role FROM invite_links WHERE token_hash = ?`, hashToken(params.token as string));
      const workspace = link ? store.workspaceById(link.workspace_id) : undefined;
      if (!link || !workspace) throw new HttpError(404, 'This invite link is not valid');
      store.addWorkspaceMember(workspace.id, user.id, link.role);
      hub.recheck(workspaceDocIds(workspace.id));
      return store.workspaceDto(workspace, store.workspaceRole(workspace.id, user.id) as Role);
    }),

    // ---- documents

    route('GET', '/api/workspaces/:id/documents', (ctx, params) => {
      const { workspace } = workspaceOf(ctx, params.id as string);
      return store.docsInWorkspace(workspace.id).map((doc) => info(doc, ctx.who));
    }),

    route('GET', '/api/shared', (ctx) => {
      const user = requireUser(ctx);
      return store
        .all<DocRow>(
          `SELECT d.* FROM documents d JOIN document_members m ON m.doc_id = d.id WHERE m.user_id = ? AND d.owner_id != ? ORDER BY d.updated_at DESC, d.rowid DESC`,
          user.id,
          user.id,
        )
        .map((doc) => info(doc, ctx.who));
    }),

    route('POST', '/api/documents', async (ctx) => {
      const body = await ctx.json(options.maxUploadBytes);
      if (typeof body.workspaceId !== 'string') throw new HttpError(400, 'workspaceId is required');
      const { workspace, user } = workspaceOf(ctx, body.workspaceId, 'editor');
      const name = text(body, 'name', 200);
      const registers = body.registers === undefined ? [] : body.registers;
      const invalid = invalidRegisters(registers, Date.now());
      if (invalid) throw new HttpError(400, invalid);
      const doc = store.createDoc(workspace.id, name, user.id, registers as Register[]);
      return new Reply(201, info(doc, ctx.who));
    }),

    route('GET', '/api/documents/:id', (ctx, params) => {
      const { doc, role: held } = docOf(ctx, params.id as string);
      return store.docDto(doc, held);
    }),

    route('PATCH', '/api/documents/:id', async (ctx, params) => {
      const { doc, role: held } = docOf(ctx, params.id as string);
      if (!canEdit(held)) throw new HttpError(403, 'Viewers cannot change the document');
      const body = await ctx.json();
      const name = optionalText(body, 'name', 200);
      const linkAccess = body.linkAccess;
      if (linkAccess !== undefined) {
        if (!isLinkAccess(linkAccess)) throw new HttpError(400, 'linkAccess must be none, view or edit');
        requireAccountToShare(ctx);
      }
      if (name !== undefined && name !== doc.name) {
        // The name is a register of the document too, so open copies are renamed with everything else.
        const current = store.register(doc.id, 'd:name');
        const result = store.applyRegisters(doc.id, [{ k: 'd:name', v: name, c: store.serverClock(current?.c) }]);
        hub.serverOps(doc.id, result.seq, result.kept);
      }
      if (linkAccess !== undefined && linkAccess !== doc.link_access) {
        store.run(`UPDATE documents SET link_access = ? WHERE id = ?`, linkAccess, doc.id);
        hub.recheck([doc.id]);
      }
      return info(store.docById(doc.id) as DocRow, ctx.who);
    }),

    route('DELETE', '/api/documents/:id', (ctx, params) => {
      const { doc, role: held } = docOf(ctx, params.id as string);
      if (held !== 'owner') throw new HttpError(403, 'Only an owner can delete the document');
      store.deleteDoc(doc.id);
      hub.recheck([doc.id]);
      return {};
    }),

    route('GET', '/api/documents/:id/members', (ctx, params) => {
      const { doc } = docOf(ctx, params.id as string);
      requireAccountToShare(ctx);
      return store.docMembers(doc.id);
    }),

    route('POST', '/api/documents/:id/members', async (ctx, params) => {
      const { doc, role: mine } = docOf(ctx, params.id as string);
      const user = requireAccountToShare(ctx);
      if (!canEdit(mine)) throw new HttpError(403, 'Viewers cannot share the document');
      const body = await ctx.json();
      const address = email(body);
      const wanted = role(body);
      if (wanted === 'owner' && mine !== 'owner') throw new HttpError(403, 'Only an owner can make owners');
      const invitee = store.userByEmail(address);
      store.tx(() => {
        if (invitee) {
          if (store.addDocMember(doc.id, invitee.id, wanted) && invitee.id !== user.id)
            store.notify(invitee.id, 'shared', { id: user.id, guest: false }, doc.name, { docId: doc.id, workspaceId: doc.workspace_id });
        } else addPending('document_invites', 'doc_id', doc.id, address, wanted, user.id);
      });
      if (invitee) hub.recheck([doc.id]);
      return store.docMembers(doc.id);
    }),

    route('PATCH', '/api/documents/:id/members/:userId', async (ctx, params) => {
      const { doc, role: mine } = docOf(ctx, params.id as string);
      requireAccountToShare(ctx);
      if (mine !== 'owner') throw new HttpError(403, 'Only an owner can change roles');
      const wanted = role(await ctx.json());
      const target = params.userId as string;
      if (target.includes('@')) {
        const changed = store.run(`UPDATE document_invites SET role = ? WHERE doc_id = ? AND email = ?`, wanted, doc.id, normalizeEmail(target));
        if (changed === 0) throw new HttpError(404, 'There is no such invitation');
        return store.docMembers(doc.id);
      }
      if (!store.docMemberRole(doc.id, target)) throw new HttpError(404, 'That person is not a member of this document');
      store.run(`UPDATE document_members SET role = ? WHERE doc_id = ? AND user_id = ?`, wanted, doc.id, target);
      hub.recheck([doc.id]);
      return store.docMembers(doc.id);
    }),

    route('DELETE', '/api/documents/:id/members/:userId', (ctx, params) => {
      const { doc, role: mine } = docOf(ctx, params.id as string);
      const user = requireAccountToShare(ctx);
      const target = params.userId as string;
      if (target.includes('@')) {
        if (!canEdit(mine)) throw new HttpError(403, 'Viewers cannot change invitations');
        if (store.run(`DELETE FROM document_invites WHERE doc_id = ? AND email = ?`, doc.id, normalizeEmail(target)) === 0)
          throw new HttpError(404, 'There is no such invitation');
        return {};
      }
      if (target !== user.id && mine !== 'owner') throw new HttpError(403, 'Only an owner can remove people');
      if (store.run(`DELETE FROM document_members WHERE doc_id = ? AND user_id = ?`, doc.id, target) === 0)
        throw new HttpError(404, 'That person is not a member of this document');
      hub.recheck([doc.id]);
      return {};
    }),

    route('GET', '/api/documents/:id/registers', (ctx, params) => {
      const { doc } = docOf(ctx, params.id as string);
      return { seq: doc.seq, registers: store.registersSince(doc.id, 0) };
    }),

    // ---- images

    route('PUT', '/api/documents/:id/assets/:hash', async (ctx, params) => {
      const { doc, role: held } = docOf(ctx, params.id as string);
      if (!canEdit(held)) throw new HttpError(403, 'Viewers cannot add images');
      const hash = params.hash as string;
      if (!ASSET_HASH.test(hash)) throw new HttpError(400, 'An image is named by the SHA-256 of its bytes, in lowercase hex');
      const bytes = await readBody(ctx.req, options.maxUploadBytes);
      if (createHash('sha256').update(bytes).digest('hex') !== hash) throw new HttpError(400, 'The bytes do not match their hash');
      const type = String(ctx.req.headers['content-type'] ?? 'application/octet-stream').slice(0, 200);
      const path = store.assetPath(doc.id, hash);
      mkdirSync(dirname(path), { recursive: true });
      // Written beside it first and then renamed, so a reader never sees half a file.
      const partial = `${path}.${newId()}.part`;
      writeFileSync(partial, bytes);
      renameSync(partial, path);
      store.run(
        `INSERT INTO assets (doc_id, hash, content_type, size, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(doc_id, hash) DO UPDATE SET content_type = excluded.content_type, size = excluded.size`,
        doc.id,
        hash,
        type,
        bytes.length,
        now(),
      );
      return {};
    }),

    route('GET', '/api/documents/:id/assets/:hash', (ctx, params) => {
      const { doc } = docOf(ctx, params.id as string);
      const hash = params.hash as string;
      const asset = ASSET_HASH.test(hash)
        ? store.one<{ content_type: string; size: number }>(`SELECT content_type, size FROM assets WHERE doc_id = ? AND hash = ?`, doc.id, hash)
        : undefined;
      if (!asset) throw new HttpError(404, 'There is no such image in this document');
      ctx.res.writeHead(200, {
        'Content-Type': asset.content_type,
        'Content-Length': Number(asset.size),
        'Cache-Control': 'private, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
        // Whatever was uploaded, it never runs as a page on this site.
        'Content-Security-Policy': "default-src 'none'; sandbox",
      });
      createReadStream(store.assetPath(doc.id, hash))
        .on('error', () => ctx.res.destroy())
        .pipe(ctx.res);
      return HANDLED;
    }),

    // ---- comments

    route('GET', '/api/documents/:id/threads', (ctx, params) => store.threadsOf(docOf(ctx, params.id as string).doc.id)),

    route('POST', '/api/documents/:id/threads', async (ctx, params) => {
      const { doc } = docOf(ctx, params.id as string);
      const author = requirePerson(ctx);
      const body = await ctx.json();
      const pageId = text(body, 'pageId', 200);
      const x = finite(body, 'x');
      const y = finite(body, 'y');
      const nodeId = body.nodeId === undefined || body.nodeId === null ? null : text(body, 'nodeId', 200);
      const words = commentBody(body);
      const threadId = newId();
      store.tx(() => {
        store.run(`INSERT INTO threads (id, doc_id, page_id, x, y, node_id, resolved, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)`, threadId, doc.id, pageId, x, y, nodeId, now());
        const comment = store.addComment(threadId, author, words);
        store.notifyForComment(doc, threadId, comment, [], false);
      });
      return new Reply(201, publishThread(doc.id, threadId));
    }),

    route('POST', '/api/threads/:id/comments', async (ctx, params) => {
      const { thread, doc } = threadOf(ctx, params.id as string);
      const author = requirePerson(ctx);
      const words = commentBody(await ctx.json());
      store.tx(() => {
        const comment = store.addComment(thread.id, author, words);
        store.notifyForComment(doc, thread.id, comment, [], true);
      });
      return publishThread(doc.id, thread.id);
    }),

    route('PATCH', '/api/threads/:id', async (ctx, params) => {
      const { thread, doc, role: held } = threadOf(ctx, params.id as string);
      requirePerson(ctx);
      const body = await ctx.json();
      if (body.resolved !== undefined && typeof body.resolved !== 'boolean') throw new HttpError(400, 'resolved must be true or false');
      const moving = body.x !== undefined || body.y !== undefined;
      if (moving && !canEdit(held) && !isAuthor(ctx, store.threadAuthor(thread.id))) throw new HttpError(403, 'Only the comment’s author or an editor can move it');
      const x = body.x === undefined ? thread.x : finite(body, 'x');
      const y = body.y === undefined ? thread.y : finite(body, 'y');
      const resolved = body.resolved === undefined ? thread.resolved : body.resolved ? 1 : 0;
      store.run(`UPDATE threads SET x = ?, y = ?, resolved = ? WHERE id = ?`, x, y, resolved, thread.id);
      return publishThread(doc.id, thread.id);
    }),

    route('DELETE', '/api/threads/:id', (ctx, params) => {
      const { thread, doc, role: held } = threadOf(ctx, params.id as string);
      requirePerson(ctx);
      if (!canEdit(held) && !isAuthor(ctx, store.threadAuthor(thread.id))) throw new HttpError(403, 'Only the comment’s author or an editor can delete it');
      store.run(`DELETE FROM threads WHERE id = ?`, thread.id);
      hub.comment(doc.id, { kind: 'deleted', threadId: thread.id });
      return {};
    }),

    route('PATCH', '/api/comments/:id', async (ctx, params) => {
      const comment = store.commentById(params.id as string);
      if (!comment) throw new HttpError(404, 'There is no such comment');
      const { thread, doc } = threadOf(ctx, comment.thread_id);
      requirePerson(ctx);
      if (!isAuthor(ctx, { id: comment.author_id, guest: comment.author_guest === 1 })) throw new HttpError(403, 'Only its author can change a comment');
      const words = commentBody(await ctx.json());
      const before = JSON.parse(comment.mentions) as string[];
      store.tx(() => {
        store.run(`UPDATE comments SET body = ?, mentions = ?, edited_at = ? WHERE id = ?`, words, JSON.stringify(mentionsIn(words)), now(), comment.id);
        // Only people mentioned for the first time are told.
        store.notifyForComment(doc, thread.id, store.commentById(comment.id) as NonNullable<ReturnType<Store['commentById']>>, before, false);
      });
      return publishThread(doc.id, thread.id);
    }),

    route('DELETE', '/api/comments/:id', (ctx, params) => {
      const comment = store.commentById(params.id as string);
      if (!comment) throw new HttpError(404, 'There is no such comment');
      const { thread, doc } = threadOf(ctx, comment.thread_id);
      requirePerson(ctx);
      if (!isAuthor(ctx, { id: comment.author_id, guest: comment.author_guest === 1 })) throw new HttpError(403, 'Only its author can delete a comment');
      store.run(`DELETE FROM comments WHERE id = ?`, comment.id);
      const left = store.one<{ n: number }>(`SELECT COUNT(*) AS n FROM comments WHERE thread_id = ?`, thread.id);
      if (!left || Number(left.n) === 0) {
        store.run(`DELETE FROM threads WHERE id = ?`, thread.id);
        hub.comment(doc.id, { kind: 'deleted', threadId: thread.id });
        return {};
      }
      return publishThread(doc.id, thread.id);
    }),

    // ---- notifications

    route('GET', '/api/notifications', (ctx) => store.notificationsOf(requirePerson(ctx).id)),

    route('POST', '/api/notifications/read', async (ctx) => {
      const person = requirePerson(ctx);
      const body = await ctx.json();
      if (!Array.isArray(body.ids) || !body.ids.every((id) => typeof id === 'string')) throw new HttpError(400, 'ids must be a list of notification IDs');
      store.tx(() => {
        for (const id of body.ids as string[]) store.run(`UPDATE notifications SET read = 1 WHERE id = ? AND recipient_id = ?`, id, person.id);
      });
      return {};
    }),
  ];

  // The routes of the parts built on the API.
  const kit: ApiKit = {
    store,
    hub,
    route: route<Ctx>,
    HttpError,
    Reply,
    HANDLED,
    requireUser,
    requirePerson,
    workspaceOf,
    docOf,
    info,
    text,
    optionalText,
    maxUploadBytes: options.maxUploadBytes,
  };
  for (const extension of options.extensions ?? []) routes.push(...extension(kit));

  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      const found = match(routes, req.method ?? 'GET', url.pathname);
      if (found === null) throw new HttpError(404, 'Not found');
      if (found === 'method') throw new HttpError(405, 'Method not allowed');
      const { who, stale } = identify(req);
      const ctx: Ctx = {
        req,
        res,
        who,
        stale,
        ip: clientAddress(req),
        json: (limit = options.maxJsonBytes) => readJson(req, limit),
      };
      const result = await found.route.handler(ctx, found.params);
      if (result === HANDLED) return;
      if (result instanceof Reply) sendJson(res, result.status, result.body);
      else sendJson(res, 200, result);
    } catch (error) {
      if (error instanceof HttpError) {
        // A body too large is not read to its end: the connection is closed after the answer.
        if (error.status === 413) res.setHeader('Connection', 'close');
        sendError(res, error.status, error.message);
      } else {
        console.error(error);
        sendError(res, 500, 'Something went wrong on the server');
      }
    }
  };
}
