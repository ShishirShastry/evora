/**
 * The collaboration server's storage: one SQLite database (Node's built-in
 * `node:sqlite`) in the data folder, in WAL mode, and the bytes of images in
 * files beside it (`assets/<docId>/<hash>`).
 *
 * Everything here is synchronous: a change is made in one transaction before
 * the server does anything else, so the order in which the server applies
 * changes is the order in which they arrived.
 */
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createHmac, randomBytes } from 'node:crypto';
import { MAX_JSON_DEPTH, tooDeep } from './http.ts';
import {
  PEOPLE_COLORS,
  mentionsIn,
  observe,
  strongerRole,
  tick,
  wins,
  makeClock,
  type ClockState,
  type Comment,
  type DocInfo,
  type Guest,
  type LinkAccess,
  type Member,
  type Notification,
  type PendingInvite,
  type Register,
  type Role,
  type StoredRegister,
  type Thread,
  type User,
  type UserRef,
  type Workspace,
} from '../src/collab/protocol.ts';

// ------------------------------------------------------------------ rows

export interface UserRow {
  id: string;
  email: string;
  name: string;
  color: string;
  /** A scrypt hash, or '' for an account made with Google that has no password (signing in with one then fails). */
  password: string;
  created_at: string;
  /** The Google account's ID (its `sub`), once the account signs in with Google. */
  google_sub?: string | null;
  /** 1 once the address is known to be the account's: its link was followed, or Google has verified it (schema 3). */
  email_verified?: number;
  /** 0 when the account does not want an email when someone mentions it (schema 3; 1 by default). */
  mention_emails?: number;
}

export interface GuestRow {
  id: string;
  name: string;
  color: string;
  created_at: string;
}

export interface WorkspaceRow {
  id: string;
  name: string;
  created_at: string;
}

export interface DocRow {
  id: string;
  workspace_id: string;
  name: string;
  owner_id: string;
  link_access: LinkAccess;
  seq: number;
  created_at: string;
  updated_at: string;
}

export interface ThreadRow {
  id: string;
  doc_id: string;
  page_id: string;
  x: number;
  y: number;
  node_id: string | null;
  resolved: number;
  created_at: string;
}

export interface CommentRow {
  id: string;
  thread_id: string;
  author_id: string;
  author_guest: number;
  body: string;
  mentions: string;
  created_at: string;
  edited_at: string | null;
}

/** Who is asking: someone signed in, a guest without an account, or nobody in particular. */
export type Identity =
  | { kind: 'user'; user: UserRow; sessionHash: string }
  | { kind: 'guest'; guest: GuestRow }
  | { kind: 'anonymous' };

/**
 * A change to a document that may not be changed now (a branch that has been
 * merged): `applyRegisters` throws it, the API answers it with 409 and the
 * live connection rejects the change with its message.
 */
export class DocumentLockedError extends Error {}

/** A branch of a file, as listed with its main file. */
export interface FileBranch {
  /** The branch's own document ID (it opens at #/doc/<id> like any file). */
  id: string;
  name: string;
  updatedAt: string;
  createdBy: UserRef;
  /** The role of the person asking on the branch. */
  role: Role;
}

/** What a file list says about branches: whether the file is a branch, and the open branches of a main file. */
export interface BranchFields {
  /** For a branch, its main file's ID; null for any other file. */
  mainId: string | null;
  /** A main file's open branches that the person asking can open, newest first; empty for a branch. */
  branches: FileBranch[];
}

/**
 * What a part of the server built on the store (versions.ts) adds to how
 * documents behave. Every hook is optional.
 */
export interface DocHooks {
  /** Runs inside the transaction of every change to a document, before the change is merged. */
  beforeApply?(docId: string): void;
  /** Why the document may not be changed now, or null when it may. */
  lockReason?(docId: string): string | null;
  /** Whether the document is left out of file lists (a branch, which is listed with its main file). */
  hiddenInLists?(docId: string): boolean;
  /** The branch fields of a file in a list. */
  branchFields?(doc: DocRow, who: Identity): BranchFields;
}

/** A file in the trash, as kept beside it: where it was and who could open it. */
export interface TrashRow {
  doc_id: string;
  workspace_id: string;
  link_access: string;
  /** JSON: {members: {user_id, role, created_at}[], invites: {email, role, invited_by, created_at}[]}. */
  members: string;
  trashed_by: string;
  trashed_at: number;
}

/** A notification as it was just stored, for `Store.onNotify`. */
export interface NotificationEvent {
  recipientId: string;
  kind: Notification['kind'];
  from: { id: string; guest: boolean };
  text: string;
  where: { docId?: string | null; threadId?: string | null; workspaceId?: string | null };
}

/** The workspace a file in the trash belongs to: one with no members, so that nobody can open it. */
export const TRASH_WORKSPACE = 'trash';

/** What the API (with 410) and the live connection answer about a file in the trash, to someone who could open it before. */
export const IN_TRASH_MESSAGE = 'This file is in the trash';

/** The ID of the person asking, or null for nobody in particular. */
export function personId(who: Identity): string | null {
  return who.kind === 'user' ? who.user.id : who.kind === 'guest' ? who.guest.id : null;
}

// ------------------------------------------------------------------ helpers

/** A random ID of 16 URL-safe characters: never a ":" (register keys split on it). */
export function newId(): string {
  return randomBytes(12).toString('base64url');
}

export function now(): string {
  return new Date().toISOString();
}

export function isRole(value: unknown): value is Role {
  return value === 'owner' || value === 'editor' || value === 'viewer';
}

export function isLinkAccess(value: unknown): value is LinkAccess {
  return value === 'none' || value === 'view' || value === 'edit';
}

/** What link access gives anyone who opens the document by its link. */
export function linkRole(access: LinkAccess): Role | null {
  return access === 'edit' ? 'editor' : access === 'view' ? 'viewer' : null;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Plain text for a notification: mentions written as @Name, cut to a short length. */
export function excerpt(body: string, length = 140): string {
  const text = body.replace(/@\[([^\]]*)\]\([A-Za-z0-9_-]+\)/g, '@$1').replace(/\s+/g, ' ').trim();
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

/**
 * A clock: 9 base-36 digits of milliseconds, a counter of 4 to 11 digits (11
 * hold every counter up to Number.MAX_SAFE_INTEGER; a longer one would be
 * read as a rounded number or as Infinity by every client that sees it, and
 * would make each clock a client makes after it invalid), and a client ID.
 */
const CLOCK_PATTERN = /^[0-9a-z]{9}\.[0-9a-z]{4,11}\.[^\s]{1,64}$/;
/** How far ahead of the server's own clock a change's clock may be: further than this, it would win over every later change. */
export const MAX_CLOCK_LEAD_MS = 24 * 60 * 60 * 1000;
export const MAX_KEY_LENGTH = 1024;

/**
 * Checks changes sent by a client. Returns a reason when one is not valid:
 * the key must be a non-empty string with no `__proto__` part (the app
 * builds objects from the parts of keys), the clock a clock whose counter is
 * a safe integer, the value present and nested at most MAX_JSON_DEPTH deep.
 */
export function invalidRegisters(ops: unknown, nowMs: number): string | null {
  if (!Array.isArray(ops)) return 'ops must be a list';
  for (const op of ops) {
    if (!op || typeof op !== 'object') return 'a change must be an object';
    const { k, c } = op as { k?: unknown; c?: unknown };
    if (typeof k !== 'string' || k.length === 0 || k.length > MAX_KEY_LENGTH) return 'a change needs a key';
    if (k.split(':').includes('__proto__')) return 'a key may not have a part named __proto__';
    if (!('v' in op)) return `the change to ${k} has no value`;
    if (typeof c !== 'string' || !CLOCK_PATTERN.test(c)) return `the change to ${k} has no valid clock`;
    const ms = parseInt(c.slice(0, 9), 36);
    if (ms > nowMs + MAX_CLOCK_LEAD_MS) return `the change to ${k} has a clock too far in the future`;
    if (parseInt(c.slice(10, c.indexOf('.', 10)), 36) > Number.MAX_SAFE_INTEGER) return `the change to ${k} has a clock whose counter is too large`;
    if (tooDeep((op as { v: unknown }).v)) return `the value of ${k} is nested more than ${MAX_JSON_DEPTH} levels deep`;
  }
  return null;
}

// ------------------------------------------------------------------ the schema

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  password TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  last_used INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS guests (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX IF NOT EXISTS workspace_members_user ON workspace_members(user_id);

CREATE TABLE IF NOT EXISTS workspace_invites (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL,
  invited_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, email)
);
CREATE INDEX IF NOT EXISTS workspace_invites_email ON workspace_invites(email);

CREATE TABLE IF NOT EXISTS invite_links (
  token_hash TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  link_access TEXT NOT NULL DEFAULT 'none',
  seq INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS documents_workspace ON documents(workspace_id);

CREATE TABLE IF NOT EXISTS document_members (
  doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (doc_id, user_id)
);
CREATE INDEX IF NOT EXISTS document_members_user ON document_members(user_id);

CREATE TABLE IF NOT EXISTS document_invites (
  doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL,
  invited_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (doc_id, email)
);
CREATE INDEX IF NOT EXISTS document_invites_email ON document_invites(email);

CREATE TABLE IF NOT EXISTS registers (
  doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  clock TEXT NOT NULL,
  seq INTEGER NOT NULL,
  PRIMARY KEY (doc_id, key)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS registers_seq ON registers(doc_id, seq);
-- Which documents publish a library, and when that changed, without reading the publication itself (server/libraries.ts).
CREATE INDEX IF NOT EXISTS registers_publication ON registers(doc_id, seq) WHERE key = 'd:publication';

CREATE TABLE IF NOT EXISTS assets (
  doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  hash TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (doc_id, hash)
);

CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL,
  x REAL NOT NULL,
  y REAL NOT NULL,
  node_id TEXT,
  resolved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS threads_doc ON threads(doc_id);

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL,
  author_guest INTEGER NOT NULL DEFAULT 0,
  body TEXT NOT NULL,
  mentions TEXT NOT NULL,
  created_at TEXT NOT NULL,
  edited_at TEXT
);
CREATE INDEX IF NOT EXISTS comments_thread ON comments(thread_id);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  recipient_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  doc_id TEXT REFERENCES documents(id) ON DELETE CASCADE,
  thread_id TEXT REFERENCES threads(id) ON DELETE CASCADE,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  from_id TEXT NOT NULL,
  from_guest INTEGER NOT NULL DEFAULT 0,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS notifications_recipient ON notifications(recipient_id);

CREATE TABLE IF NOT EXISTS google_states (
  state_hash TEXT PRIMARY KEY,
  verifier TEXT NOT NULL,
  origin TEXT NOT NULL,
  mode TEXT NOT NULL,
  invite TEXT,
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS google_tickets (
  ticket_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS file_trash (
  doc_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  link_access TEXT NOT NULL,
  members TEXT NOT NULL,
  trashed_by TEXT NOT NULL,
  trashed_at INTEGER NOT NULL
);
`;

/**
 * 1: the first schema (Phase 8).
 * 2: users.google_sub (signing in with Google), google_states and google_tickets; a password may be ''.
 * 3: users.email_verified (accounts linked to Google start verified) and users.mention_emails; email_tokens.
 */
const SCHEMA_VERSION = 3;

/** A session ends when it has not been used for this long. */
export const SESSION_IDLE_MS = 90 * 24 * 60 * 60 * 1000;
/** A session ends this long after it started, however often it is used: a stolen token does not work for ever. */
export const SESSION_MAX_MS = 365 * 24 * 60 * 60 * 1000;

const ROLE_RANK: Record<Role, number> = { owner: 3, editor: 2, viewer: 1 };

// ------------------------------------------------------------------ the store

export class Store {
  readonly db: DatabaseSync;
  readonly dataDir: string;
  readonly assetsDir: string;
  private statements = new Map<string, StatementSync>();
  private depth = 0;
  /** The server's own clock, for changes it makes itself (a document renamed over HTTP). */
  private clock: ClockState = { last: makeClock(0, 0, 'server'), clientId: 'server' };

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.assetsDir = join(dataDir, 'assets');
    mkdirSync(this.assetsDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, 'evora.db'), { enableForeignKeyConstraints: true, timeout: 5000 });
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.db.exec(SCHEMA);
    this.migrate();
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    this.run(`INSERT OR IGNORE INTO workspaces (id, name, created_at) VALUES (?, 'Trash', ?)`, TRASH_WORKSPACE, now());
  }

  // -------------------------------------------------------------- hooks of the parts built on the store

  private hooks: DocHooks[] = [];

  addDocHooks(hooks: DocHooks): void {
    this.hooks.push(hooks);
  }

  /** Why a document may not be changed now (a merged branch), or null. */
  lockReason(docId: string): string | null {
    for (const hook of this.hooks) {
      const reason = hook.lockReason?.(docId);
      if (reason) return reason;
    }
    return null;
  }

  /** Whether a document is left out of file lists (a branch: it is listed with its main file). */
  hiddenInLists(docId: string): boolean {
    return this.hooks.some((hook) => hook.hiddenInLists?.(docId) === true);
  }

  /** The branch fields of a file in a list. */
  branchFields(doc: DocRow, who: Identity): BranchFields {
    for (const hook of this.hooks) if (hook.branchFields) return hook.branchFields(doc, who);
    return { mainId: null, branches: [] };
  }

  // -------------------------------------------------------------- client addresses

  private addressSecret: string | null = null;

  /**
   * A keyed hash of a client's address, for counting someone without an
   * account once: the address itself is never kept. The key is made once per
   * database and kept in it, so the same address gives the same hash after a
   * restart, and the hashes cannot be reversed by trying every address
   * without it.
   */
  hashAddress(address: string): string {
    if (!this.addressSecret) {
      this.run(`INSERT OR IGNORE INTO meta (key, value) VALUES ('address_secret', ?)`, randomBytes(32).toString('hex'));
      this.addressSecret = (this.one<{ value: string }>(`SELECT value FROM meta WHERE key = 'address_secret'`) as { value: string }).value;
    }
    return createHmac('sha256', this.addressSecret).update(address).digest('hex');
  }

  /** Brings a database made by an earlier version up to this one, keeping everything in it. */
  private migrate(): void {
    const columns = (this.db.prepare(`PRAGMA table_info(users)`).all() as { name: string }[]).map((column) => column.name);
    if (!columns.includes('google_sub')) this.db.exec(`ALTER TABLE users ADD COLUMN google_sub TEXT`);
    // Unique, but any number of accounts may have none (NULLs are distinct in SQLite).
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub ON users(google_sub)`);
    // 3: email. Google links only an account whose address it has verified, so those accounts start verified.
    // In one transaction, and decided by the version rather than by the column: a start stopped half way does it again.
    const version = (this.db.prepare(`PRAGMA user_version`).get() as { user_version: number }).user_version;
    this.tx(() => {
      if (!columns.includes('email_verified')) this.db.exec(`ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0`);
      if (version < 3) this.db.exec(`UPDATE users SET email_verified = 1 WHERE google_sub IS NOT NULL`);
    });
    if (!columns.includes('mention_emails')) this.db.exec(`ALTER TABLE users ADD COLUMN mention_emails INTEGER NOT NULL DEFAULT 1`);
    // Links that confirm an address: only their hash is kept, with the address they were sent to.
    this.db.exec(`CREATE TABLE IF NOT EXISTS email_tokens (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS email_tokens_user ON email_tokens(user_id);`);
  }

  close(): void {
    this.statements.clear();
    if (this.db.isOpen) this.db.close();
  }

  // -------------------------------------------------------------- SQL

  private statement(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  one<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.statement(sql).get(...params) as T | undefined;
  }

  all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.statement(sql).all(...params) as T[];
  }

  run(sql: string, ...params: SQLInputValue[]): number {
    return Number(this.statement(sql).run(...params).changes);
  }

  /** Runs `fn` in one transaction: all of it is kept, or none of it. */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.depth++;
    let result: T;
    try {
      result = fn();
      this.db.exec('COMMIT');
    } catch (error) {
      // What was to happen once the transaction is kept (`afterCommit`) does not happen.
      this.committed = [];
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.depth--;
    }
    const kept = this.committed;
    this.committed = [];
    for (const run of kept) run();
    return result;
  }

  private committed: (() => void)[] = [];

  /** Runs `work` once the transaction under way is kept (at once outside one); never when it is undone. */
  afterCommit(work: () => void): void {
    if (this.depth > 0) this.committed.push(work);
    else work();
  }

  // -------------------------------------------------------------- people

  /** The next colour from PEOPLE_COLORS, in turn. */
  nextColor(): string {
    const row = this.one<{ value: string }>(`SELECT value FROM meta WHERE key = 'next_color'`);
    const index = row ? Number(row.value) || 0 : 0;
    this.run(`INSERT INTO meta (key, value) VALUES ('next_color', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, String(index + 1));
    return PEOPLE_COLORS[index % PEOPLE_COLORS.length] as string;
  }

  userById(id: string): UserRow | undefined {
    return this.one<UserRow>(`SELECT * FROM users WHERE id = ?`, id);
  }

  userByEmail(email: string): UserRow | undefined {
    return this.one<UserRow>(`SELECT * FROM users WHERE email = ?`, normalizeEmail(email));
  }

  userByGoogle(sub: string): UserRow | undefined {
    return this.one<UserRow>(`SELECT * FROM users WHERE google_sub = ?`, sub);
  }

  guestById(id: string): GuestRow | undefined {
    return this.one<GuestRow>(`SELECT id, name, color, created_at FROM guests WHERE id = ?`, id);
  }

  /** The user a session token (by its hash) belongs to; a session not used for SESSION_IDLE_MS has ended. */
  sessionUser(tokenHash: string): UserRow | undefined {
    const row = this.one<UserRow & { last_used: number; started: string }>(
      `SELECT u.id, u.email, u.name, u.color, u.password, u.created_at, u.email_verified, u.mention_emails, s.last_used, s.created_at AS started FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
      tokenHash,
    );
    if (!row) return undefined;
    const nowMs = Date.now();
    const idle = nowMs - Number(row.last_used);
    const age = nowMs - Date.parse(row.started);
    if (idle > SESSION_IDLE_MS || age > SESSION_MAX_MS) {
      this.run(`DELETE FROM sessions WHERE token_hash = ?`, tokenHash);
      return undefined;
    }
    // Noted at most once an hour, so that reading does not mean writing every time.
    if (idle > 60 * 60 * 1000) this.run(`UPDATE sessions SET last_used = ? WHERE token_hash = ?`, nowMs, tokenHash);
    return {
      id: row.id,
      email: row.email,
      name: row.name,
      color: row.color,
      password: row.password,
      created_at: row.created_at,
      email_verified: row.email_verified,
      mention_emails: row.mention_emails,
    };
  }

  /** Starts a session for a user; returns the token (only its hash is kept). */
  createSession(userId: string, token: string, tokenHash: string): string {
    this.run(`INSERT INTO sessions (token_hash, user_id, created_at, last_used) VALUES (?, ?, ?, ?)`, tokenHash, userId, now(), Date.now());
    return token;
  }

  guestByToken(tokenHash: string): GuestRow | undefined {
    return this.one<GuestRow>(`SELECT id, name, color, created_at FROM guests WHERE token_hash = ?`, tokenHash);
  }

  userDto(row: UserRow): User {
    return { id: row.id, email: row.email, name: row.name, color: row.color, createdAt: row.created_at };
  }

  guestDto(row: GuestRow): Guest {
    return { id: row.id, name: row.name, color: row.color };
  }

  /** A reference to a person by ID: a user, or a guest when `guest` is set. */
  ref(id: string, guest = false): UserRef {
    if (guest) {
      const row = this.guestById(id);
      return row ? { id, name: row.name, color: row.color, guest: true } : { id, name: 'Guest', color: '#8a8a8a', guest: true };
    }
    const row = this.userById(id);
    return row ? { id, name: row.name, color: row.color } : { id, name: 'Someone', color: '#8a8a8a' };
  }

  identityRef(who: Identity): UserRef | null {
    if (who.kind === 'user') return { id: who.user.id, name: who.user.name, color: who.user.color };
    if (who.kind === 'guest') return { id: who.guest.id, name: who.guest.name, color: who.guest.color, guest: true };
    return null;
  }

  // -------------------------------------------------------------- workspaces

  workspaceById(id: string): WorkspaceRow | undefined {
    return this.one<WorkspaceRow>(`SELECT * FROM workspaces WHERE id = ?`, id);
  }

  workspaceRole(workspaceId: string, userId: string): Role | null {
    const row = this.one<{ role: Role }>(`SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?`, workspaceId, userId);
    return row ? row.role : null;
  }

  workspaceDto(row: WorkspaceRow, role: Role): Workspace {
    const count = this.one<{ n: number }>(`SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id = ?`, row.id);
    return { id: row.id, name: row.name, role, memberCount: count ? Number(count.n) : 0, createdAt: row.created_at };
  }

  workspacesOf(userId: string): Workspace[] {
    const rows = this.all<WorkspaceRow & { role: Role }>(
      `SELECT w.*, m.role FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id WHERE m.user_id = ? ORDER BY w.created_at, w.rowid`,
      userId,
    );
    return rows.map((row) => this.workspaceDto(row, row.role));
  }

  createWorkspace(name: string, ownerId: string): WorkspaceRow {
    const row: WorkspaceRow = { id: newId(), name, created_at: now() };
    this.tx(() => {
      this.run(`INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)`, row.id, row.name, row.created_at);
      this.run(`INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)`, row.id, ownerId, row.created_at);
    });
    return row;
  }

  ownerCount(workspaceId: string): number {
    const row = this.one<{ n: number }>(`SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id = ? AND role = 'owner'`, workspaceId);
    return row ? Number(row.n) : 0;
  }

  workspaceMembers(workspaceId: string): { members: Member[]; pending: PendingInvite[] } {
    const members = this.all<UserRow & { role: Role }>(
      `SELECT u.*, m.role FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? ORDER BY m.created_at, m.rowid`,
      workspaceId,
    ).map((row) => ({ user: { id: row.id, name: row.name, color: row.color, email: row.email }, role: row.role }));
    const pending = this.all<{ email: string; role: Role; created_at: string }>(
      `SELECT email, role, created_at FROM workspace_invites WHERE workspace_id = ? ORDER BY created_at, rowid`,
      workspaceId,
    ).map((row) => ({ email: row.email, role: row.role, createdAt: row.created_at }));
    return { members, pending };
  }

  /** Adds someone to a workspace, or raises their role there; never lowers it. Returns whether they are newly a member. */
  addWorkspaceMember(workspaceId: string, userId: string, role: Role): boolean {
    const held = this.workspaceRole(workspaceId, userId);
    if (held === null) {
      this.run(`INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?)`, workspaceId, userId, role, now());
      return true;
    }
    if (ROLE_RANK[role] > ROLE_RANK[held]) this.run(`UPDATE workspace_members SET role = ? WHERE workspace_id = ? AND user_id = ?`, role, workspaceId, userId);
    return false;
  }

  // -------------------------------------------------------------- documents

  docById(id: string): DocRow | undefined {
    return this.one<DocRow>(`SELECT * FROM documents WHERE id = ?`, id);
  }

  docMemberRole(docId: string, userId: string): Role | null {
    const row = this.one<{ role: Role }>(`SELECT role FROM document_members WHERE doc_id = ? AND user_id = ?`, docId, userId);
    return row ? row.role : null;
  }

  /**
   * What someone may do in a document: the strongest of their own role in it,
   * their role in its workspace, and what its link gives anyone (guests included).
   */
  roleOn(doc: DocRow, who: Identity): Role | null {
    let role = linkRole(doc.link_access);
    if (who.kind === 'user') {
      role = strongerRole(role, this.docMemberRole(doc.id, who.user.id));
      role = strongerRole(role, this.workspaceRole(doc.workspace_id, who.user.id));
    }
    return role;
  }

  /** The role of a person by ID (a user, or a guest when `guest`), for deciding whom to notify. */
  roleOfPerson(doc: DocRow, id: string, guest: boolean): Role | null {
    if (guest) {
      const row = this.guestById(id);
      return row ? linkRole(doc.link_access) : null;
    }
    const user = this.userById(id);
    return user ? this.roleOn(doc, { kind: 'user', user, sessionHash: '' }) : null;
  }

  docDto(row: DocRow, role: Role | null): DocInfo {
    return {
      id: row.id,
      name: row.name,
      workspaceId: row.workspace_id,
      role,
      linkAccess: row.link_access,
      owner: this.ref(row.owner_id),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  docsInWorkspace(workspaceId: string): DocRow[] {
    return this.all<DocRow>(`SELECT * FROM documents WHERE workspace_id = ? ORDER BY updated_at DESC, rowid DESC`, workspaceId);
  }

  docMembers(docId: string): { members: Member[]; pending: PendingInvite[] } {
    const members = this.all<UserRow & { role: Role }>(
      `SELECT u.*, m.role FROM document_members m JOIN users u ON u.id = m.user_id WHERE m.doc_id = ? ORDER BY m.created_at, m.rowid`,
      docId,
    ).map((row) => ({ user: { id: row.id, name: row.name, color: row.color, email: row.email }, role: row.role }));
    const pending = this.all<{ email: string; role: Role; created_at: string }>(
      `SELECT email, role, created_at FROM document_invites WHERE doc_id = ? ORDER BY created_at, rowid`,
      docId,
    ).map((row) => ({ email: row.email, role: row.role, createdAt: row.created_at }));
    return { members, pending };
  }

  /** Adds someone to a document, or raises their role in it; never lowers it. Returns whether they are newly a member. */
  addDocMember(docId: string, userId: string, role: Role): boolean {
    const held = this.docMemberRole(docId, userId);
    if (held === null) {
      this.run(`INSERT INTO document_members (doc_id, user_id, role, created_at) VALUES (?, ?, ?, ?)`, docId, userId, role, now());
      return true;
    }
    if (ROLE_RANK[role] > ROLE_RANK[held]) this.run(`UPDATE document_members SET role = ? WHERE doc_id = ? AND user_id = ?`, role, docId, userId);
    return false;
  }

  createDoc(workspaceId: string, name: string, ownerId: string, registers: Register[]): DocRow {
    const created = now();
    const id = newId();
    this.tx(() => {
      this.run(
        `INSERT INTO documents (id, workspace_id, name, owner_id, link_access, seq, created_at, updated_at) VALUES (?, ?, ?, ?, 'none', 0, ?, ?)`,
        id,
        workspaceId,
        name,
        ownerId,
        created,
        created,
      );
      this.run(`INSERT INTO document_members (doc_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)`, id, ownerId, created);
      if (registers.length > 0) this.applyRegisters(id, registers);
      // The name given is the document's name, whatever the starting content says.
      const held = this.register(id, 'd:name');
      if (!held || held.v !== name) this.applyRegisters(id, [{ k: 'd:name', v: name, c: this.serverClock(held?.c) }]);
      // The starting content is not an edit: the document was last changed when it was made.
      this.run(`UPDATE documents SET name = ?, updated_at = ? WHERE id = ?`, name, created, id);
    });
    return this.docById(id) as DocRow;
  }

  /** Removes a document with everything in it, its images included. */
  deleteDoc(docId: string): void {
    this.run(`DELETE FROM documents WHERE id = ?`, docId);
    this.removeAssetFiles(docId);
  }

  // -------------------------------------------------------------- the trash

  trashRow(docId: string): TrashRow | undefined {
    return this.one<TrashRow>(`SELECT * FROM file_trash WHERE doc_id = ?`, docId);
  }

  /**
   * Moves a document to the trash: it keeps everything, but its members,
   * invitations and link access are put aside and it belongs to the trash
   * workspace (which has no members), so nobody can open it until it is
   * restored. Whoever has it open must then be disconnected (`hub.recheck`).
   */
  trashDoc(doc: DocRow, byUserId: string, atMs: number = Date.now()): void {
    this.tx(() => {
      const members = this.all<{ user_id: string; role: Role; created_at: string }>(`SELECT user_id, role, created_at FROM document_members WHERE doc_id = ?`, doc.id);
      const invites = this.all<{ email: string; role: Role; invited_by: string; created_at: string }>(
        `SELECT email, role, invited_by, created_at FROM document_invites WHERE doc_id = ?`,
        doc.id,
      );
      this.run(
        `INSERT INTO file_trash (doc_id, workspace_id, link_access, members, trashed_by, trashed_at) VALUES (?, ?, ?, ?, ?, ?)`,
        doc.id,
        doc.workspace_id,
        doc.link_access,
        JSON.stringify({ members, invites }),
        byUserId,
        atMs,
      );
      this.run(`DELETE FROM document_members WHERE doc_id = ?`, doc.id);
      this.run(`DELETE FROM document_invites WHERE doc_id = ?`, doc.id);
      this.run(`UPDATE documents SET workspace_id = ?, link_access = 'none' WHERE id = ?`, TRASH_WORKSPACE, doc.id);
    });
  }

  /**
   * Whether a document is in the trash and the person could open it before
   * it was put there (by its link, as one of its members, or in its
   * workspace): they are told it is in the trash; anyone else is not.
   */
  trashedFor(doc: DocRow, who: Identity): boolean {
    if (doc.workspace_id !== TRASH_WORKSPACE) return false;
    const row = this.trashRow(doc.id);
    if (!row) return false;
    if (linkRole(row.link_access as LinkAccess) !== null) return true;
    if (who.kind !== 'user') return false;
    if (this.workspaceRole(row.workspace_id, who.user.id)) return true;
    const stashed = JSON.parse(row.members) as { members?: { user_id: string }[] };
    return (stashed.members ?? []).some((member) => member.user_id === who.user.id);
  }

  /** Removes a workspace with its documents and everything in them. Returns the IDs of the documents removed. */
  deleteWorkspace(workspaceId: string): string[] {
    const docIds = this.docsInWorkspace(workspaceId).map((doc) => doc.id);
    this.tx(() => {
      this.run(`DELETE FROM documents WHERE workspace_id = ?`, workspaceId);
      this.run(`DELETE FROM workspaces WHERE id = ?`, workspaceId);
    });
    for (const id of docIds) this.removeAssetFiles(id);
    return docIds;
  }

  assetPath(docId: string, hash: string): string {
    return join(this.assetsDir, docId, hash);
  }

  private removeAssetFiles(docId: string): void {
    rmSync(join(this.assetsDir, docId), { recursive: true, force: true });
  }

  // -------------------------------------------------------------- registers

  /** A clock for a change the server makes itself: later than `after` and than every clock it has made. */
  serverClock(after?: string): string {
    if (after) observe(this.clock, after);
    return tick(this.clock, Date.now());
  }

  register(docId: string, key: string): StoredRegister | undefined {
    const row = this.one<{ key: string; value: string; clock: string; seq: number }>(
      `SELECT key, value, clock, seq FROM registers WHERE doc_id = ? AND key = ?`,
      docId,
      key,
    );
    return row ? { k: row.key, v: JSON.parse(row.value) as unknown, c: row.clock, s: Number(row.seq) } : undefined;
  }

  /** The registers changed after sequence number `since`, in the order they were changed (all of them for 0). */
  registersSince(docId: string, since: number): StoredRegister[] {
    return this.all<{ key: string; value: string; clock: string; seq: number }>(
      `SELECT key, value, clock, seq FROM registers WHERE doc_id = ? AND seq > ? ORDER BY seq`,
      docId,
      since,
    ).map((row) => ({ k: row.key, v: JSON.parse(row.value) as unknown, c: row.clock, s: Number(row.seq) }));
  }

  /**
   * Merges changes into a document by their clocks: each one that is later
   * than what is held is kept with the next sequence number. All in one
   * transaction, after the `beforeApply` hooks; a document that may not be
   * changed now (`lockReason`) throws `DocumentLockedError`. Returns the
   * changes that were kept (the last for each key) and the document's
   * sequence number afterwards.
   */
  applyRegisters(docId: string, ops: Register[]): { seq: number; kept: StoredRegister[] } {
    return this.tx(() => {
      const found = this.one<{ seq: number }>(`SELECT seq FROM documents WHERE id = ?`, docId);
      if (!found) throw new Error(`No document ${docId}`);
      const locked = this.lockReason(docId);
      if (locked) throw new DocumentLockedError(locked);
      for (const hook of this.hooks) hook.beforeApply?.(docId);
      // Read again: a hook may have changed the document (not its sequence number, but to be sure).
      const doc = this.one<{ seq: number }>(`SELECT seq FROM documents WHERE id = ?`, docId) as { seq: number };
      let seq = Number(doc.seq);
      const kept = new Map<string, StoredRegister>();
      for (const op of ops) {
        observe(this.clock, op.c);
        const held = kept.get(op.k) ?? this.register(docId, op.k);
        if (!wins(op, held)) continue;
        seq++;
        const stored: StoredRegister = { k: op.k, v: op.v === undefined ? null : op.v, c: op.c, s: seq };
        this.run(
          `INSERT INTO registers (doc_id, key, value, clock, seq) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(doc_id, key) DO UPDATE SET value = excluded.value, clock = excluded.clock, seq = excluded.seq`,
          docId,
          op.k,
          JSON.stringify(stored.v),
          op.c,
          seq,
        );
        kept.delete(op.k);
        kept.set(op.k, stored);
      }
      if (kept.size > 0) {
        const name = kept.get('d:name');
        if (name && typeof name.v === 'string' && name.v.trim()) this.run(`UPDATE documents SET name = ? WHERE id = ?`, name.v.trim().slice(0, 200), docId);
        this.run(`UPDATE documents SET seq = ?, updated_at = ? WHERE id = ?`, seq, now(), docId);
      }
      return { seq, kept: [...kept.values()].sort((a, b) => a.s - b.s) };
    });
  }

  // -------------------------------------------------------------- comments

  threadById(id: string): ThreadRow | undefined {
    return this.one<ThreadRow>(`SELECT * FROM threads WHERE id = ?`, id);
  }

  commentById(id: string): CommentRow | undefined {
    return this.one<CommentRow>(`SELECT * FROM comments WHERE id = ?`, id);
  }

  private commentDto(row: CommentRow): Comment {
    return {
      id: row.id,
      threadId: row.thread_id,
      author: this.ref(row.author_id, row.author_guest === 1),
      body: row.body,
      mentions: JSON.parse(row.mentions) as string[],
      createdAt: row.created_at,
      editedAt: row.edited_at,
    };
  }

  private threadDtoWith(row: ThreadRow, comments: CommentRow[]): Thread {
    return {
      id: row.id,
      docId: row.doc_id,
      pageId: row.page_id,
      x: row.x,
      y: row.y,
      nodeId: row.node_id,
      resolved: row.resolved === 1,
      createdAt: row.created_at,
      comments: comments.map((comment) => this.commentDto(comment)),
    };
  }

  threadDto(row: ThreadRow): Thread {
    return this.threadDtoWith(row, this.all<CommentRow>(`SELECT * FROM comments WHERE thread_id = ? ORDER BY created_at, rowid`, row.id));
  }

  threadsOf(docId: string): Thread[] {
    const threads = this.all<ThreadRow>(`SELECT * FROM threads WHERE doc_id = ? ORDER BY created_at, rowid`, docId);
    const comments = this.all<CommentRow>(
      `SELECT c.* FROM comments c JOIN threads t ON t.id = c.thread_id WHERE t.doc_id = ? ORDER BY c.created_at, c.rowid`,
      docId,
    );
    const byThread = new Map<string, CommentRow[]>();
    for (const comment of comments) {
      const list = byThread.get(comment.thread_id) ?? [];
      list.push(comment);
      byThread.set(comment.thread_id, list);
    }
    return threads.map((thread) => this.threadDtoWith(thread, byThread.get(thread.id) ?? []));
  }

  /** The first comment's author: the person who started the thread. */
  threadAuthor(threadId: string): { id: string; guest: boolean } | null {
    const row = this.one<{ author_id: string; author_guest: number }>(
      `SELECT author_id, author_guest FROM comments WHERE thread_id = ? ORDER BY created_at, rowid LIMIT 1`,
      threadId,
    );
    return row ? { id: row.author_id, guest: row.author_guest === 1 } : null;
  }

  addComment(threadId: string, author: { id: string; guest: boolean }, body: string): CommentRow {
    const row: CommentRow = {
      id: newId(),
      thread_id: threadId,
      author_id: author.id,
      author_guest: author.guest ? 1 : 0,
      body,
      mentions: JSON.stringify(mentionsIn(body)),
      created_at: now(),
      edited_at: null,
    };
    this.run(
      `INSERT INTO comments (id, thread_id, author_id, author_guest, body, mentions, created_at, edited_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      row.id,
      row.thread_id,
      row.author_id,
      row.author_guest,
      row.body,
      row.mentions,
      row.created_at,
    );
    return row;
  }

  // -------------------------------------------------------------- notifications

  private notifyListeners: ((note: NotificationEvent) => void)[] = [];

  /** Runs `listener` after each notification is stored (server/email.ts sends mention emails from here). */
  onNotify(listener: (note: NotificationEvent) => void): () => void {
    this.notifyListeners.push(listener);
    return () => {
      this.notifyListeners = this.notifyListeners.filter((other) => other !== listener);
    };
  }

  /**
   * Takes up the invitations by email waiting for an account's address: a new
   * account, or one whose address has just been confirmed. Run inside a
   * transaction.
   */
  takeUpInvites(user: UserRow): void {
    for (const invite of this.all<{ workspace_id: string; role: Role; invited_by: string }>(
      `SELECT workspace_id, role, invited_by FROM workspace_invites WHERE email = ? ORDER BY created_at, rowid`,
      user.email,
    )) {
      const workspace = this.workspaceById(invite.workspace_id);
      if (!workspace) continue;
      if (this.addWorkspaceMember(workspace.id, user.id, invite.role))
        this.notify(user.id, 'invite', { id: invite.invited_by, guest: false }, workspace.name, { workspaceId: workspace.id });
    }
    this.run(`DELETE FROM workspace_invites WHERE email = ?`, user.email);
    for (const invite of this.all<{ doc_id: string; role: Role; invited_by: string }>(
      `SELECT doc_id, role, invited_by FROM document_invites WHERE email = ? ORDER BY created_at, rowid`,
      user.email,
    )) {
      const doc = this.docById(invite.doc_id);
      if (!doc) continue;
      if (this.addDocMember(doc.id, user.id, invite.role))
        this.notify(user.id, 'shared', { id: invite.invited_by, guest: false }, doc.name, { docId: doc.id, workspaceId: doc.workspace_id });
    }
    this.run(`DELETE FROM document_invites WHERE email = ?`, user.email);
  }

  notify(
    recipientId: string,
    kind: Notification['kind'],
    from: { id: string; guest: boolean },
    text: string,
    where: { docId?: string | null; threadId?: string | null; workspaceId?: string | null },
  ): void {
    this.run(
      `INSERT INTO notifications (id, recipient_id, kind, doc_id, thread_id, workspace_id, from_id, from_guest, text, created_at, read)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      newId(),
      recipientId,
      kind,
      where.docId ?? null,
      where.threadId ?? null,
      where.workspaceId ?? null,
      from.id,
      from.guest ? 1 : 0,
      text,
      now(),
    );
    // Told once the notification is kept: an email is never sent about a comment whose transaction was undone.
    this.afterCommit(() => {
      for (const listener of this.notifyListeners) {
        try {
          listener({ recipientId, kind, from, text, where });
        } catch (error) {
          // A listener's failure (an email that could not be queued) never undoes the notification.
          console.error('A notification listener failed:', error);
        }
      }
    });
  }

  notificationsOf(recipientId: string, limit = 200): Notification[] {
    return this.all<{
      id: string;
      kind: Notification['kind'];
      doc_id: string | null;
      thread_id: string | null;
      workspace_id: string | null;
      from_id: string;
      from_guest: number;
      text: string;
      created_at: string;
      read: number;
    }>(`SELECT * FROM notifications WHERE recipient_id = ? ORDER BY rowid DESC LIMIT ?`, recipientId, limit).map((row) => ({
      id: row.id,
      kind: row.kind,
      docId: row.doc_id,
      threadId: row.thread_id,
      workspaceId: row.workspace_id,
      from: this.ref(row.from_id, row.from_guest === 1),
      text: row.text,
      createdAt: row.created_at,
      read: row.read === 1,
    }));
  }

  /**
   * Notifies whoever a comment mentions, and, for a reply, the thread's other
   * participants; only people who can open the document, never the author.
   */
  notifyForComment(doc: DocRow, threadId: string, comment: CommentRow, previousMentions: string[], isReply: boolean): void {
    const author = { id: comment.author_id, guest: comment.author_guest === 1 };
    const text = excerpt(comment.body);
    const told = new Set<string>([author.id]);
    for (const id of JSON.parse(comment.mentions) as string[]) {
      if (told.has(id) || previousMentions.includes(id)) continue;
      const guest = !this.userById(id) && !!this.guestById(id);
      if (this.roleOfPerson(doc, id, guest) === null) continue;
      this.notify(id, 'mention', author, text, { docId: doc.id, threadId, workspaceId: doc.workspace_id });
      told.add(id);
    }
    if (!isReply) return;
    const participants = this.all<{ author_id: string; author_guest: number }>(
      `SELECT DISTINCT author_id, author_guest FROM comments WHERE thread_id = ? AND id != ?`,
      threadId,
      comment.id,
    );
    for (const person of participants) {
      if (told.has(person.author_id)) continue;
      if (this.roleOfPerson(doc, person.author_id, person.author_guest === 1) === null) continue;
      this.notify(person.author_id, 'reply', author, text, { docId: doc.id, threadId, workspaceId: doc.workspace_id });
      told.add(person.author_id);
    }
  }
}
