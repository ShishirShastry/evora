/**
 * Evora collaboration (Phase 8): the contract between the app and the
 * collaboration server. Both import this file — the server directly with
 * Node's type stripping (`server/` imports `../src/collab/protocol.ts`) — so it
 * imports nothing and uses only syntax that types can be stripped from (no
 * enums, namespaces or parameter properties).
 *
 * Everything here is free and unlimited: there are no plans, no seat limits
 * and no feature gates anywhere in the protocol.
 *
 * ## How a document is shared
 *
 * A shared document is a set of *registers*, each a key with a JSON value and
 * the clock of the change that set it. Two changes to the same register are
 * resolved by their clocks: the later clock wins, everywhere, whatever order
 * the changes arrive in (last-writer-wins, as Figma does per property). So
 * every copy that has seen the same changes holds the same document, and
 * changes made offline merge when they are sent.
 *
 * Register keys:
 * - `n:<nodeId>:@`       whether the node exists: true, or false once deleted
 * - `n:<nodeId>:<prop>`  one property of a node (its parent and order are properties too)
 * - `t:styles:<id>`, `t:variables:<id>`, `t:variableCollections:<id>`
 *                        a whole entry of one of the document's tables; null once removed
 * - `d:name`, `d:publication`   the document's name and what it publishes
 * - `a:<hash>`           the description of an image (its bytes are an asset on the server)
 *
 * IDs never contain ":", so a key splits unambiguously on its first two colons.
 */

// ------------------------------------------------------------------ clocks

/**
 * A hybrid logical clock written as a string that sorts as the clocks
 * compare: milliseconds and a counter in fixed-width base 36, then the
 * client's ID to break ties. `"0lp3k9z2a.0003.k2x9…"`.
 */
export type Clock = string;

export interface ClockState {
  /** The highest clock this client has made or seen. */
  last: Clock;
  clientId: string;
}

const MS_WIDTH = 9;
const COUNTER_WIDTH = 4;

export function makeClock(ms: number, counter: number, clientId: string): Clock {
  return `${Math.max(0, Math.floor(ms)).toString(36).padStart(MS_WIDTH, '0')}.${counter.toString(36).padStart(COUNTER_WIDTH, '0')}.${clientId}`;
}

export function parseClock(clock: Clock): { ms: number; counter: number; clientId: string } {
  const [ms = '0', counter = '0', ...rest] = clock.split('.');
  return { ms: parseInt(ms, 36) || 0, counter: parseInt(counter, 36) || 0, clientId: rest.join('.') };
}

/** Compares two clocks: negative when `a` is earlier, positive when later, 0 when the same. */
export function compareClocks(a: Clock, b: Clock): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The next clock for a change made now: later than every clock made or seen, and than the wall clock. */
export function tick(state: ClockState, now: number): Clock {
  const last = parseClock(state.last);
  const clock = now > last.ms ? makeClock(now, 0, state.clientId) : makeClock(last.ms, last.counter + 1, state.clientId);
  state.last = clock;
  return clock;
}

/** Takes in a clock from elsewhere, so that the next clock made here is later than it. */
export function observe(state: ClockState, clock: Clock): void {
  if (compareClocks(clock, state.last) > 0) {
    const seen = parseClock(clock);
    state.last = makeClock(seen.ms, seen.counter, state.clientId);
  }
}

/** A client's ID: 10 letters and digits. */
export function newClientId(random: () => number = Math.random): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 10; i++) out += alphabet[Math.floor(random() * alphabet.length)];
  return out;
}

// ------------------------------------------------------------------ registers

export interface Register {
  /** See the key formats above. */
  k: string;
  /** Any JSON value; null for "removed". */
  v: unknown;
  c: Clock;
}

/** A register as the server keeps it: with the server's sequence number of the change that set it. */
export interface StoredRegister extends Register {
  s: number;
}

/** Whether `incoming` wins over what is held (`held` may be missing). */
export function wins(incoming: Register, held: Register | undefined): boolean {
  return !held || compareClocks(incoming.c, held.c) > 0;
}

export function nodeKey(nodeId: string, prop: string): string {
  return `n:${nodeId}:${prop}`;
}

export const EXISTS = '@';

export type ParsedKey =
  | { kind: 'node'; nodeId: string; prop: string }
  | { kind: 'table'; table: 'styles' | 'variables' | 'variableCollections'; id: string }
  | { kind: 'doc'; field: 'name' | 'publication' }
  | { kind: 'asset'; hash: string }
  | { kind: 'unknown' };

export function parseKey(key: string): ParsedKey {
  const first = key.indexOf(':');
  const kind = key.slice(0, first);
  const rest = key.slice(first + 1);
  if (kind === 'n') {
    const second = rest.indexOf(':');
    if (second > 0) return { kind: 'node', nodeId: rest.slice(0, second), prop: rest.slice(second + 1) };
  } else if (kind === 't') {
    const second = rest.indexOf(':');
    const table = rest.slice(0, second);
    if (table === 'styles' || table === 'variables' || table === 'variableCollections') return { kind: 'table', table, id: rest.slice(second + 1) };
  } else if (kind === 'd') {
    if (rest === 'name' || rest === 'publication') return { kind: 'doc', field: rest };
  } else if (kind === 'a' && rest) return { kind: 'asset', hash: rest };
  return { kind: 'unknown' };
}

// ------------------------------------------------------------------ people and access

/** What someone may do in a workspace or a document. Viewers may comment. */
export type Role = 'owner' | 'editor' | 'viewer';
export const ROLES: readonly Role[] = ['owner', 'editor', 'viewer'];

/** Whether a role may change the document (as opposed to view and comment). */
export function canEdit(role: Role | null): boolean {
  return role === 'owner' || role === 'editor';
}

/** The higher of two roles (owner > editor > viewer > none). */
export function strongerRole(a: Role | null, b: Role | null): Role | null {
  const rank = (role: Role | null): number => (role === 'owner' ? 3 : role === 'editor' ? 2 : role === 'viewer' ? 1 : 0);
  return rank(a) >= rank(b) ? a : b;
}

/** Who can open a document by its link, without being invited: nobody, anyone to view (and comment), anyone to edit. */
export type LinkAccess = 'none' | 'view' | 'edit';

export interface User {
  id: string;
  email: string;
  name: string;
  /** A colour of their own for cursors, selections and avatars, as #rrggbb. */
  color: string;
  createdAt: string;
}

/** Someone without an account who opened a document by its link. */
export interface Guest {
  id: string;
  name: string;
  color: string;
}

export interface UserRef {
  id: string;
  name: string;
  color: string;
  /** True for a guest without an account. */
  guest?: boolean;
}

export interface Workspace {
  id: string;
  name: string;
  /** The role of the person asking. */
  role: Role;
  memberCount: number;
  createdAt: string;
}

export interface Member {
  user: UserRef & { email: string };
  role: Role;
}

/** An invitation by email to someone who has no account yet: it is taken up when they sign up with that address. */
export interface PendingInvite {
  email: string;
  role: Role;
  createdAt: string;
}

export interface DocInfo {
  id: string;
  name: string;
  workspaceId: string;
  /** The role of the person asking, or null when they cannot open it. */
  role: Role | null;
  linkAccess: LinkAccess;
  owner: UserRef;
  createdAt: string;
  updatedAt: string;
}

// ------------------------------------------------------------------ presence

export interface Presence {
  /** The page being looked at. */
  pageId: string | null;
  /** The pointer, in page coordinates; null when it is off the canvas. */
  cursor: { x: number; y: number } | null;
  /** The IDs of the layers selected. */
  selection: string[];
  /** What is in view: the page point at the top-left of the canvas, and the zoom. */
  viewport: { x: number; y: number; zoom: number; width: number; height: number } | null;
}

export interface Peer {
  clientId: string;
  user: UserRef;
  role: Role;
  presence: Presence | null;
}

// ------------------------------------------------------------------ comments

export interface Comment {
  id: string;
  threadId: string;
  author: UserRef;
  /** The text, with mentions written as `@[Name](userId)`. */
  body: string;
  mentions: string[];
  createdAt: string;
  editedAt: string | null;
}

export interface Thread {
  id: string;
  docId: string;
  pageId: string;
  /** Where the pin is, in page coordinates, or relative to the node's top-left when `nodeId` is set. */
  x: number;
  y: number;
  /** The layer the comment is attached to, which it follows when the layer moves. */
  nodeId: string | null;
  resolved: boolean;
  createdAt: string;
  comments: Comment[];
}

export type CommentEvent = { kind: 'thread'; thread: Thread } | { kind: 'deleted'; threadId: string };

/** Finds the mentions in a comment's text: `@[Name](userId)`. */
export function mentionsIn(body: string): string[] {
  const out: string[] = [];
  for (const match of body.matchAll(/@\[[^\]]*\]\(([A-Za-z0-9_-]+)\)/g)) if (match[1] && !out.includes(match[1])) out.push(match[1]);
  return out;
}

export interface Notification {
  id: string;
  kind: 'mention' | 'reply' | 'invite' | 'shared';
  docId: string | null;
  threadId: string | null;
  workspaceId: string | null;
  from: UserRef;
  /** A short text to show, e.g. the comment's first words or the document's name. */
  text: string;
  createdAt: string;
  read: boolean;
}

// ------------------------------------------------------------------ the live connection (WebSocket at /ws)

export type ClientMessage =
  /** The first message: which document, and the last server sequence number already held (0 for none). */
  | { t: 'hello'; docId: string; since: number; clientId: string; token?: string; guestToken?: string }
  /** Changes made here, with an ID the server acknowledges. */
  | { t: 'ops'; id: string; ops: Register[] }
  | { t: 'presence'; presence: Presence }
  | { t: 'ping' };

export type ServerMessage =
  /**
   * The answer to hello: the registers changed since `since` (all of them when `full`), the server's
   * latest sequence number, who you are and may do, and who else is here.
   */
  | { t: 'welcome'; seq: number; full: boolean; registers: StoredRegister[]; you: Peer; peers: Peer[]; doc: DocInfo }
  /** Changes from someone else, already applied on the server. */
  | { t: 'ops'; seq: number; ops: StoredRegister[]; from: string }
  /** Your changes with this ID were kept, up to this sequence number. */
  | { t: 'ack'; id: string; seq: number }
  /** Your changes with this ID were not kept (you may not edit, or they were not valid). */
  | { t: 'rejected'; id: string; reason: string }
  | { t: 'presence'; peer: Peer }
  | { t: 'leave'; clientId: string }
  | { t: 'comment'; event: CommentEvent }
  /** What you may do changed; null means you may no longer open the document, and the connection closes. */
  | { t: 'access'; role: Role | null; linkAccess: LinkAccess }
  | { t: 'error'; code: 'unauthorized' | 'forbidden' | 'not-found' | 'bad-request'; message: string }
  | { t: 'pong' };

// ------------------------------------------------------------------ the HTTP API (JSON under /api)

/**
 * Requests carry `Authorization: Bearer <token>` (a session from signing up or
 * in) or, for someone without an account, `X-Evora-Guest: <guestToken>`.
 * Errors answer with a status and `{ error: string }`.
 *
 * - POST   /api/auth/signup            {email, name, password}       -> AuthResult (201); a pending invite for that email is taken up
 * - POST   /api/auth/login             {email, password}             -> AuthResult
 * - POST   /api/auth/logout                                          -> {}
 * - POST   /api/guests                 {name}                        -> GuestResult
 * - GET    /api/me                                                   -> {user, workspaces}
 * - PATCH  /api/me                     {name?, password?, color?}    -> User
 * - GET    /api/workspaces                                           -> Workspace[]
 * - POST   /api/workspaces             {name}                        -> Workspace (201)
 * - PATCH  /api/workspaces/:id         {name}                        -> Workspace          (owner)
 * - DELETE /api/workspaces/:id                                       -> {}                 (owner)
 * - GET    /api/workspaces/:id/members                               -> {members, pending}
 * - POST   /api/workspaces/:id/members {email, role}                 -> {members, pending} (owner, editor; an editor cannot make owners)
 * - PATCH  /api/workspaces/:id/members/:userId {role}               -> {members, pending} (owner)
 * - DELETE /api/workspaces/:id/members/:userId                      -> {}                 (owner, or oneself to leave)
 * - POST   /api/workspaces/:id/invites {role}                        -> {token}            (an invite link: /#/invite/<token>)
 * - GET    /api/invites/:token                                       -> {workspace: {id, name}, role, from: UserRef}
 * - POST   /api/invites/:token/accept                                -> Workspace
 * - GET    /api/workspaces/:id/documents                             -> DocInfo[]
 * - GET    /api/shared                                               -> DocInfo[]  (documents shared with me directly)
 * - POST   /api/documents              {workspaceId, name, registers?} -> DocInfo (201)   (registers: the starting content, e.g. a local file)
 * - GET    /api/documents/:id                                        -> DocInfo
 * - PATCH  /api/documents/:id          {name?, linkAccess?}          -> DocInfo            (owner, editor)
 * - DELETE /api/documents/:id                                        -> {}                 (owner)
 * - GET    /api/documents/:id/members                                -> {members, pending}
 * - POST   /api/documents/:id/members  {email, role}                 -> {members, pending} (owner, editor)
 * - PATCH  /api/documents/:id/members/:userId {role}                -> {members, pending}
 * - DELETE /api/documents/:id/members/:userId                       -> {}
 * - GET    /api/documents/:id/registers                              -> {seq, registers}   (the whole document, for a snapshot)
 * - PUT    /api/documents/:id/assets/:hash  (raw bytes, Content-Type) -> {}              (editors)
 * - GET    /api/documents/:id/assets/:hash                           -> the bytes
 * - GET    /api/documents/:id/threads                                -> Thread[]
 * - POST   /api/documents/:id/threads  {pageId, x, y, nodeId, body}  -> Thread (201)      (anyone who can open it, guests included)
 * - POST   /api/threads/:id/comments   {body}                        -> Thread
 * - PATCH  /api/threads/:id            {resolved?, x?, y?}           -> Thread
 * - DELETE /api/threads/:id                                          -> {}                 (its author, or an owner/editor)
 * - PATCH  /api/comments/:id           {body}                        -> Thread             (its author)
 * - DELETE /api/comments/:id                                         -> Thread | {}        (its author; the last one removes the thread)
 * - GET    /api/notifications                                        -> Notification[]
 * - POST   /api/notifications/read     {ids}                         -> {}
 * - GET    /api/health                                               -> {ok: true, version}
 *
 * Signing in and up with Google (added later; on only when the server has a Google OAuth client):
 * - GET    /api/auth/providers                                       -> AuthProviders
 * - GET    /api/auth/google/start?origin=<app origin>&mode=login|signup&invite=<invite token?>
 *                                                                    -> 302 to Google's consent page
 * - GET    /api/auth/google/callback?code&state                      -> 302 to <origin>/#/auth/google?ticket=<one-time ticket>
 *                                                                       or <origin>/#/auth/google?error=<message>
 * - POST   /api/auth/google/redeem     {ticket}                      -> AuthResult (the ticket works once, for two minutes)
 */
export interface AuthResult {
  token: string;
  user: User;
}

/** The other ways of signing in that the server offers. */
export interface AuthProviders {
  google: boolean;
}

/** Where the app's Google sign-in comes back to, with `?ticket=` or `?error=`. */
export const GOOGLE_RETURN_ROUTE = '#/auth/google';

export interface GuestResult {
  guestToken: string;
  guest: Guest;
}

/** Where the HTTP API and the live connection are, relative to the page: the same origin. */
export const API_BASE = '/api';
export const SOCKET_PATH = '/ws';

/**
 * The close codes of the live connection when the server ends it itself
 * (added with the server). Each follows an `error` message, or, for
 * `forbidden` after a change of access, an `access` message with role null.
 * A client should not reconnect after these until something changes: signing
 * in again, being given access, or (for `replaced`) its other connection with
 * the same client ID closing. 1001 means the server is stopping: reconnect.
 */
export const SOCKET_CLOSE = { badRequest: 4400, unauthorized: 4401, forbidden: 4403, notFound: 4404, replaced: 4409 } as const;

/** The default port of the collaboration server. */
export const DEFAULT_SERVER_PORT = 8787;

/** Colours given to people in turn, for cursors and avatars: bright enough on a dark and a light canvas. */
export const PEOPLE_COLORS: readonly string[] = ['#f24e1e', '#0d99ff', '#14ae5c', '#9747ff', '#ff24bd', '#ffa629', '#00b5ce', '#e5484d', '#7b61ff', '#2fd27f'];
