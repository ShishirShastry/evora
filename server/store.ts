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
import { randomBytes } from 'node:crypto';
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

const CLOCK_PATTERN = /^[0-9a-z]{9}\.[0-9a-z]{4,}\.[^\s]{1,64}$/;
/** How far ahead of the server's own clock a change's clock may be: further than this, it would win over every later change. */
export const MAX_CLOCK_LEAD_MS = 24 * 60 * 60 * 1000;
export const MAX_KEY_LENGTH = 1024;

/**
 * Checks changes sent by a client. Returns a reason when one is not valid:
 * the key must be a non-empty string, the clock a clock, the value present.
 */
export function invalidRegisters(ops: unknown, nowMs: number): string | null {
  if (!Array.isArray(ops)) return 'ops must be a list';
  for (const op of ops) {
    if (!op || typeof op !== 'object') return 'a change must be an object';
    const { k, c } = op as { k?: unknown; c?: unknown };
    if (typeof k !== 'string' || k.length === 0 || k.length > MAX_KEY_LENGTH) return 'a change needs a key';
    if (!('v' in op)) return `the change to ${k} has no value`;
    if (typeof c !== 'string' || !CLOCK_PATTERN.test(c)) return `the change to ${k} has no valid clock`;
    const ms = parseInt(c.slice(0, 9), 36);
    if (ms > nowMs + MAX_CLOCK_LEAD_MS) return `the change to ${k} has a clock too far in the future`;
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
`;

/**
 * 1: the first schema (Phase 8).
 * 2: users.google_sub (signing in with Google), google_states and google_tickets; a password may be ''.
 */
const SCHEMA_VERSION = 2;

/** A session ends when it has not been used for this long. */
export const SESSION_IDLE_MS = 90 * 24 * 60 * 60 * 1000;

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
  }

  /** Brings a database made by an earlier version up to this one, keeping everything in it. */
  private migrate(): void {
    const columns = (this.db.prepare(`PRAGMA table_info(users)`).all() as { name: string }[]).map((column) => column.name);
    if (!columns.includes('google_sub')) this.db.exec(`ALTER TABLE users ADD COLUMN google_sub TEXT`);
    // Unique, but any number of accounts may have none (NULLs are distinct in SQLite).
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub ON users(google_sub)`);
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
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.depth--;
    }
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
    const row = this.one<UserRow & { last_used: number }>(
      `SELECT u.id, u.email, u.name, u.color, u.password, u.created_at, s.last_used FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
      tokenHash,
    );
    if (!row) return undefined;
    const nowMs = Date.now();
    const idle = nowMs - Number(row.last_used);
    if (idle > SESSION_IDLE_MS) {
      this.run(`DELETE FROM sessions WHERE token_hash = ?`, tokenHash);
      return undefined;
    }
    // Noted at most once an hour, so that reading does not mean writing every time.
    if (idle > 60 * 60 * 1000) this.run(`UPDATE sessions SET last_used = ? WHERE token_hash = ?`, nowMs, tokenHash);
    return { id: row.id, email: row.email, name: row.name, color: row.color, password: row.password, created_at: row.created_at };
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
   * transaction. Returns the changes that were kept (the last for each key)
   * and the document's sequence number afterwards.
   */
  applyRegisters(docId: string, ops: Register[]): { seq: number; kept: StoredRegister[] } {
    return this.tx(() => {
      const doc = this.one<{ seq: number }>(`SELECT seq FROM documents WHERE id = ?`, docId);
      if (!doc) throw new Error(`No document ${docId}`);
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
