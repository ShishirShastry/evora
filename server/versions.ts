/**
 * Phase 9: version history and branching. Built on the API through its extension hook (`ApiExtension` in api.ts):
 * `setup` makes this part's tables (CREATE TABLE IF NOT EXISTS, so it is safe on every start
 * and on a database made before it), `extension` gives its routes.
 *
 * ## Versions
 *
 * A version is the whole document at one of the server's sequence numbers:
 * the value of every register (without clocks), as gzipped JSON. Versions are
 * named (made by someone, with a name and a description) or automatic (made
 * by the server: when a document changes again after `autoVersions.intervalMs`
 * since its last version, or after `autoVersions.everyChanges` changes).
 * Automatic ones are thinned out as they age: all of the last day, then the
 * last of each day for 30 days, then the last of each week. Named ones are kept.
 *
 * Versions are not removed with their document: deleting a file keeps its
 * versions (a backup), which the workspace's editors can list and bring back
 * as a new file, until an owner purges them.
 *
 * Restoring a version makes the document equal to it again by ordinary
 * changes with the server's clock (so everyone connected converges, live),
 * after an automatic "Before restoring …" version.
 *
 * ## Branches
 *
 * A branch is a document of its own holding a copy of its main file's
 * registers, with the main file, the sequence number and the values it was
 * made from (its *base*). "Update from main" brings main's changes since the
 * base into the branch; "Merge into main" brings the branch's changes since
 * the base into main. A register changed on both sides to different values is
 * a conflict, which the person resolves (keep main / take branch). Merging
 * records "Before merging" and "Merged" versions on main, so restoring the
 * first undoes the merge, and marks the branch merged (it stays viewable).
 */
import { gunzipSync, gzipSync } from 'node:zlib';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { canEdit, parseKey, type Register, type StoredRegister, type UserRef } from '../src/collab/protocol.ts';
import type { ApiExtension, ApiKit, Ctx } from './api.ts';
import { newId, now, type DocRow, type Store } from './store.ts';

// ------------------------------------------------------------------ settings

/** When the server makes automatic versions. Changed by the tests. */
export const autoVersions = {
  /** A change arriving this long after a document's last version makes a version of it first. */
  intervalMs: 10 * 60 * 1000,
  /** So does a change arriving after this many changes since its last version. */
  everyChanges: 1000,
  /** The time, as milliseconds. */
  now: (): number => Date.now(),
};

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

// ------------------------------------------------------------------ what is sent

export type VersionKind = 'auto' | 'named';

export interface VersionInfo {
  id: string;
  docId: string;
  kind: VersionKind;
  /** Empty for an automatic version. */
  name: string;
  description: string;
  /** The document's sequence number the version holds the document at. */
  seq: number;
  /** Who made it; null for the server's own. */
  author: UserRef | null;
  createdAt: string;
}

export type BranchStatus = 'open' | 'merged';

export interface BranchInfo {
  /** The branch's own document ID. */
  id: string;
  name: string;
  mainId: string;
  mainName: string;
  status: BranchStatus;
  /** Main's sequence number at the branch point or at the last update from main. */
  baseSeq: number;
  createdBy: UserRef;
  createdAt: string;
  mergedAt: string | null;
  mergedBy: UserRef | null;
}

/** A register changed on both sides since the base, to different values. `undefined` is written as null. */
export interface Conflict {
  key: string;
  base: unknown;
  main: unknown;
  branch: unknown;
}

/** One side's change to a register since the base. */
export interface Change {
  key: string;
  base: unknown;
  value: unknown;
}

export type Resolution = 'main' | 'branch';

// ------------------------------------------------------------------ rows

interface VersionRow {
  id: string;
  doc_id: string;
  workspace_id: string;
  doc_name: string;
  kind: VersionKind;
  name: string;
  description: string;
  seq: number;
  author_id: string | null;
  author_guest: number;
  created_at: string;
  created_ms: number;
}

interface BranchRow {
  doc_id: string;
  main_id: string;
  main_name: string;
  base_seq: number;
  base: Uint8Array;
  status: BranchStatus;
  created_by: string;
  created_at: string;
  merged_at: string | null;
  merged_by: string | null;
}

const VERSION_COLUMNS = 'id, doc_id, workspace_id, doc_name, kind, name, description, seq, author_id, author_guest, created_at, created_ms';
const BRANCH_COLUMNS = 'doc_id, main_id, main_name, base_seq, base, status, created_by, created_at, merged_at, merged_by';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS versions (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  doc_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  seq INTEGER NOT NULL,
  author_id TEXT,
  author_guest INTEGER NOT NULL DEFAULT 0,
  content BLOB NOT NULL,
  created_at TEXT NOT NULL,
  created_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS versions_doc ON versions(doc_id, created_ms);
CREATE INDEX IF NOT EXISTS versions_workspace ON versions(workspace_id);

CREATE TABLE IF NOT EXISTS branches (
  doc_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  main_id TEXT NOT NULL,
  main_name TEXT NOT NULL,
  base_seq INTEGER NOT NULL,
  base BLOB NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  merged_at TEXT,
  merged_by TEXT
);
CREATE INDEX IF NOT EXISTS branches_main ON branches(main_id);
`;

// ------------------------------------------------------------------ values

type Values = Map<string, unknown>;

/** JSON with the keys of objects in order, so that equal values are equal text. */
function canonical(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
    .join(',')}}`;
}

/** Whether two register values are the same (a missing register is the same as null). */
export function sameValue(a: unknown, b: unknown): boolean {
  return a === b || canonical(a ?? null) === canonical(b ?? null);
}

function encode(values: Values): Uint8Array {
  return gzipSync(JSON.stringify(Object.fromEntries(values)));
}

function decode(blob: Uint8Array): Values {
  return new Map(Object.entries(JSON.parse(gunzipSync(blob).toString('utf8')) as Record<string, unknown>));
}

function valuesOf(store: Store, docId: string): Values {
  return new Map(store.registersSince(docId, 0).map((register) => [register.k, register.v]));
}

/** What a register is set to when the version (or the other side) does not have it: a node does not exist, anything else is removed. */
function absent(key: string): unknown {
  const parsed = parseKey(key);
  return parsed.kind === 'node' && parsed.prop === '@' ? false : null;
}

/** Registers that are never carried between documents or versions: the document's own name, image descriptions are only added. */
function personal(key: string): boolean {
  return key === 'd:name';
}

/**
 * The register values that make `current` equal to `target`: every register
 * that differs, and every one `target` does not have set to "removed" (a node
 * to not existing). The name is left alone, and image descriptions are kept
 * (they are only ever added, and a description no layer uses costs nothing).
 */
export function valuesToReach(current: Values, target: Values): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const [key, value] of target) if (!personal(key) && !sameValue(current.get(key), value)) out.set(key, value);
  for (const [key, value] of current) {
    if (personal(key) || target.has(key) || key.startsWith('a:')) continue;
    const gone = absent(key);
    if (!sameValue(value, gone)) out.set(key, gone);
  }
  return out;
}

/** The registers of `side` changed since `base` (the name aside). */
export function changesSince(base: Values, side: Values): Change[] {
  const out: Change[] = [];
  const keys = new Set([...base.keys(), ...side.keys()]);
  for (const key of keys) {
    if (personal(key)) continue;
    const before = base.get(key);
    const after = side.get(key);
    if (!sameValue(before, after)) out.push({ key, base: before ?? null, value: after ?? null });
  }
  return out;
}

/** The registers changed on both sides since the base, to different values. */
export function conflictsBetween(base: Values, main: Values, branch: Values): Conflict[] {
  const mainChanged = new Map(changesSince(base, main).map((change) => [change.key, change]));
  const out: Conflict[] = [];
  for (const change of changesSince(base, branch)) {
    const other = mainChanged.get(change.key);
    if (other && !sameValue(other.value, change.value)) out.push({ key: change.key, base: change.base, main: other.value, branch: change.value });
  }
  return out;
}

/**
 * What to bring from one side (`from`) into the other (`into`): `from`'s
 * changes since the base, except those that conflict and were resolved for
 * `into`'s side. A conflict without a resolution is an error: the person must choose.
 */
export function valuesToBring(
  base: Values,
  from: Values,
  into: Values,
  fromSide: Resolution,
  resolutions: Readonly<Record<string, Resolution>>,
): { values: Map<string, unknown>; unresolved: Conflict[] } {
  const conflicts = fromSide === 'branch' ? conflictsBetween(base, into, from) : conflictsBetween(base, from, into);
  const conflicting = new Map(conflicts.map((conflict) => [conflict.key, conflict]));
  const unresolved = conflicts.filter((conflict) => resolutions[conflict.key] !== 'main' && resolutions[conflict.key] !== 'branch');
  const values = new Map<string, unknown>();
  for (const change of changesSince(base, from)) {
    if (conflicting.has(change.key) && resolutions[change.key] !== fromSide) continue;
    // Already the same on the other side: nothing to bring.
    if (sameValue(into.get(change.key), change.value)) continue;
    values.set(change.key, from.has(change.key) ? change.value : absent(change.key));
  }
  return { values, unresolved };
}

// ------------------------------------------------------------------ retention

/**
 * Which automatic versions to keep, given every version of a document (any
 * order): all from the last day, then the newest of each day for 30 days,
 * then the newest of each week, and always the newest. Named versions are
 * always kept. Returns the IDs to remove.
 */
export function autoVersionsToDrop(versions: ReadonlyArray<{ id: string; kind: VersionKind; createdMs: number }>, nowMs: number): string[] {
  const autos = versions.filter((version) => version.kind === 'auto').sort((a, b) => b.createdMs - a.createdMs);
  const seen = new Set<string>();
  const drop: string[] = [];
  autos.forEach((version, index) => {
    const age = nowMs - version.createdMs;
    if (index === 0 || age < DAY_MS) return;
    const bucket = age < 30 * DAY_MS ? `d${Math.floor(version.createdMs / DAY_MS)}` : `w${Math.floor(version.createdMs / WEEK_MS)}`;
    if (seen.has(bucket)) drop.push(version.id);
    else seen.add(bucket);
  });
  return drop;
}

// ------------------------------------------------------------------ the part of the store this adds

function versionDto(store: Store, row: VersionRow): VersionInfo {
  return {
    id: row.id,
    docId: row.doc_id,
    kind: row.kind,
    name: row.name,
    description: row.description,
    seq: Number(row.seq),
    author: row.author_id ? store.ref(row.author_id, row.author_guest === 1) : null,
    createdAt: row.created_at,
  };
}

function branchDto(store: Store, row: BranchRow): BranchInfo {
  const doc = store.docById(row.doc_id);
  const main = store.docById(row.main_id);
  return {
    id: row.doc_id,
    name: doc?.name ?? '',
    mainId: row.main_id,
    mainName: main?.name ?? row.main_name,
    status: row.status,
    baseSeq: Number(row.base_seq),
    createdBy: store.ref(row.created_by),
    createdAt: row.created_at,
    mergedAt: row.merged_at,
    mergedBy: row.merged_by ? store.ref(row.merged_by) : null,
  };
}

interface Author {
  id: string;
  guest: boolean;
}

/** Records a version of a document as it is now. */
export function recordVersion(store: Store, doc: DocRow, kind: VersionKind, name: string, description: string, author: Author | null): VersionInfo {
  const nowMs = autoVersions.now();
  return store.tx(() => {
    const current = store.docById(doc.id) ?? doc;
    const row: VersionRow = {
      id: newId(),
      doc_id: current.id,
      workspace_id: current.workspace_id,
      doc_name: current.name,
      kind,
      name,
      description,
      seq: Number(current.seq),
      author_id: author?.id ?? null,
      author_guest: author?.guest ? 1 : 0,
      created_at: new Date(nowMs).toISOString(),
      created_ms: nowMs,
    };
    store.run(
      `INSERT INTO versions (${VERSION_COLUMNS}, content) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.doc_id,
      row.workspace_id,
      row.doc_name,
      row.kind,
      row.name,
      row.description,
      row.seq,
      row.author_id,
      row.author_guest,
      row.created_at,
      row.created_ms,
      encode(valuesOf(store, current.id)),
    );
    if (kind === 'auto') pruneVersions(store, current.id, nowMs);
    return versionDto(store, row);
  });
}

function pruneVersions(store: Store, docId: string, nowMs: number): void {
  const rows = store.all<{ id: string; kind: VersionKind; created_ms: number }>(`SELECT id, kind, created_ms FROM versions WHERE doc_id = ?`, docId);
  for (const id of autoVersionsToDrop(rows.map((row) => ({ id: row.id, kind: row.kind, createdMs: Number(row.created_ms) })), nowMs))
    store.run(`DELETE FROM versions WHERE id = ?`, id);
}

/**
 * Before a change is merged into a document: makes an automatic version of it
 * as it is, when it has changed since its last version and that was long
 * enough ago, or enough changes ago.
 */
export function checkpointIfDue(store: Store, docId: string): VersionInfo | null {
  const doc = store.docById(docId);
  if (!doc || Number(doc.seq) === 0) return null;
  const last = store.one<{ seq: number; created_ms: number }>(`SELECT seq, created_ms FROM versions WHERE doc_id = ? ORDER BY created_ms DESC, rowid DESC LIMIT 1`, docId);
  const lastSeq = last ? Number(last.seq) : 0;
  const lastMs = last ? Number(last.created_ms) : Date.parse(doc.created_at);
  if (Number(doc.seq) <= lastSeq) return null;
  const due = autoVersions.now() - lastMs >= autoVersions.intervalMs || Number(doc.seq) - lastSeq >= autoVersions.everyChanges;
  return due ? recordVersion(store, doc, 'auto', '', '', null) : null;
}

/** Sets registers of a document to values, with the server's clock (so they win), and passes them on to everyone connected. */
function setValues(kit: ApiKit, docId: string, values: Map<string, unknown>): { seq: number; kept: StoredRegister[] } {
  const { store, hub } = kit;
  const ops: Register[] = [];
  for (const [key, value] of values) ops.push({ k: key, v: value, c: store.serverClock(store.register(docId, key)?.c) });
  const result = ops.length > 0 ? store.applyRegisters(docId, ops) : { seq: Number(store.docById(docId)?.seq ?? 0), kept: [] };
  hub.serverOps(docId, result.seq, result.kept);
  return result;
}

/** Copies the images of one document to another (a branch, or main after a merge): their files and their rows. */
function copyAssets(store: Store, fromId: string, toId: string): void {
  const rows = store.all<{ hash: string; content_type: string; size: number; created_at: string }>(`SELECT hash, content_type, size, created_at FROM assets WHERE doc_id = ?`, fromId);
  for (const row of rows) {
    const source = store.assetPath(fromId, row.hash);
    const target = store.assetPath(toId, row.hash);
    if (!existsSync(source)) continue;
    if (!existsSync(target)) {
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(source, target);
    }
    store.run(`INSERT OR IGNORE INTO assets (doc_id, hash, content_type, size, created_at) VALUES (?, ?, ?, ?, ?)`, toId, row.hash, row.content_type, row.size, row.created_at);
  }
}

// ------------------------------------------------------------------ setup

/** The stores already set up: the change hook is put in once per store. */
const hooked = new WeakSet<Store>();

export function setup(store: Store): void {
  store.db.exec(SCHEMA);
  if (hooked.has(store)) return;
  hooked.add(store);
  // Every change to a document goes through `applyRegisters` (the live connection, renames over HTTP, restores and merges):
  // an automatic version is made first when one is due, in the same transaction.
  const apply = store.applyRegisters.bind(store);
  store.applyRegisters = (docId: string, ops: Register[]) =>
    store.tx(() => {
      checkpointIfDue(store, docId);
      return apply(docId, ops);
    });
}

// ------------------------------------------------------------------ routes

function resolutionsOf(body: Record<string, unknown>, HttpError: ApiKit['HttpError']): Record<string, Resolution> {
  const raw = body.resolutions ?? {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(400, 'resolutions must map register keys to "main" or "branch"');
  const out: Record<string, Resolution> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value !== 'main' && value !== 'branch') throw new HttpError(400, 'Each resolution must be "main" or "branch"');
    out[key] = value;
  }
  return out;
}

export const extension: ApiExtension = (kit) => {
  const { store, route, HttpError, Reply, docOf, requirePerson, requireUser, workspaceOf, text } = kit;

  function description(body: Record<string, unknown>): string | undefined {
    const value = body.description;
    if (value === undefined) return undefined;
    if (typeof value !== 'string') throw new HttpError(400, 'description must be text');
    if (value.length > 5000) throw new HttpError(400, 'description is longer than 5000 characters');
    return value.trim();
  }

  function versionOf(ctx: Ctx, docId: string, versionId: string): { doc: DocRow; row: VersionRow; editor: boolean } {
    const { doc, role } = docOf(ctx, docId);
    const row = store.one<VersionRow>(`SELECT ${VERSION_COLUMNS} FROM versions WHERE id = ? AND doc_id = ?`, versionId, doc.id);
    if (!row) throw new HttpError(404, 'There is no such version');
    return { doc, row, editor: canEdit(role) };
  }

  function contentOf(id: string): Values {
    const blob = store.one<{ content: Uint8Array }>(`SELECT content FROM versions WHERE id = ?`, id);
    if (!blob) throw new HttpError(404, 'There is no such version');
    return decode(blob.content);
  }

  function branchRow(docId: string): BranchRow | undefined {
    return store.one<BranchRow>(`SELECT ${BRANCH_COLUMNS} FROM branches WHERE doc_id = ?`, docId);
  }

  /** A branch the person can open, its row, their role on it, and its main file (which must still exist). */
  function branchOf(ctx: Ctx, id: string) {
    const { doc, role } = docOf(ctx, id);
    const row = branchRow(doc.id);
    if (!row) throw new HttpError(404, 'This file is not a branch');
    const main = store.docById(row.main_id);
    if (!main) throw new HttpError(410, 'The main file of this branch has been deleted');
    return { doc, role, row, main };
  }

  function registersOf(values: Values, seq: number): Register[] {
    // The clocks of a version are not kept: every register is given the same one, which is what a document built from it needs.
    const c = `${'0'.repeat(9)}.0000.version${seq}`;
    return [...values].map(([k, v]) => ({ k, v, c }));
  }

  function asConflictList(conflicts: Conflict[]): Conflict[] {
    return conflicts.map((conflict) => ({ key: conflict.key, base: conflict.base ?? null, main: conflict.main ?? null, branch: conflict.branch ?? null }));
  }

  return [
    // ---- versions

    route('GET', '/api/documents/:id/versions', (ctx, params) => {
      const { doc } = docOf(ctx, params.id as string);
      return store.all<VersionRow>(`SELECT ${VERSION_COLUMNS} FROM versions WHERE doc_id = ? ORDER BY created_ms DESC, rowid DESC`, doc.id).map((row) => versionDto(store, row));
    }),

    route('POST', '/api/documents/:id/versions', async (ctx, params) => {
      const { doc, role } = docOf(ctx, params.id as string);
      if (!canEdit(role)) throw new HttpError(403, 'Viewers cannot save versions');
      const body = await ctx.json();
      const name = text(body, 'name', 200);
      return new Reply(201, recordVersion(store, doc, 'named', name, description(body) ?? '', requirePerson(ctx)));
    }),

    route('GET', '/api/documents/:id/versions/:versionId', (ctx, params) => {
      const { row } = versionOf(ctx, params.id as string, params.versionId as string);
      return { version: versionDto(store, row), registers: registersOf(contentOf(row.id), Number(row.seq)) };
    }),

    route('PATCH', '/api/documents/:id/versions/:versionId', async (ctx, params) => {
      const { row, editor } = versionOf(ctx, params.id as string, params.versionId as string);
      if (!editor) throw new HttpError(403, 'Viewers cannot change versions');
      const body = await ctx.json();
      const name = body.name === undefined ? undefined : typeof body.name === 'string' ? body.name.trim().slice(0, 200) : null;
      if (name === null) throw new HttpError(400, 'name must be text');
      const about = description(body);
      // Naming an automatic version makes it a named one, which is kept.
      const kind: VersionKind = name ? 'named' : row.kind;
      if (kind === 'named' && !(name ?? row.name)) throw new HttpError(400, 'A named version needs a name');
      store.run(`UPDATE versions SET name = ?, description = ?, kind = ? WHERE id = ?`, name ?? row.name, about ?? row.description, kind, row.id);
      return versionDto(store, store.one<VersionRow>(`SELECT ${VERSION_COLUMNS} FROM versions WHERE id = ?`, row.id) as VersionRow);
    }),

    route('DELETE', '/api/documents/:id/versions/:versionId', (ctx, params) => {
      const { row, editor } = versionOf(ctx, params.id as string, params.versionId as string);
      if (!editor) throw new HttpError(403, 'Viewers cannot delete versions');
      store.run(`DELETE FROM versions WHERE id = ?`, row.id);
      return {};
    }),

    route('POST', '/api/documents/:id/versions/:versionId/restore', (ctx, params) => {
      const { doc, row, editor } = versionOf(ctx, params.id as string, params.versionId as string);
      if (!editor) throw new HttpError(403, 'Viewers cannot restore versions');
      const author = requirePerson(ctx);
      const target = contentOf(row.id);
      const label = row.name || `the version of ${new Date(row.created_at).toLocaleString('en-GB', { timeZone: 'UTC' })} UTC`;
      return store.tx(() => {
        const before = recordVersion(store, doc, 'named', `Before restoring ${label}`, '', author);
        const result = setValues(kit, doc.id, valuesToReach(valuesOf(store, doc.id), target));
        return { seq: result.seq, changed: result.kept.length, before };
      });
    }),

    // ---- backups of deleted files

    route('GET', '/api/workspaces/:id/deleted-documents', (ctx, params) => {
      const { workspace } = workspaceOf(ctx, params.id as string, 'editor');
      const rows = store.all<{ doc_id: string; doc_name: string; versions: number; latest: string }>(
        `SELECT doc_id, doc_name, COUNT(*) AS versions, MAX(created_at) AS latest FROM versions
         WHERE workspace_id = ? AND doc_id NOT IN (SELECT id FROM documents) GROUP BY doc_id ORDER BY latest DESC`,
        workspace.id,
      );
      return rows.map((row) => {
        const name = store.one<{ doc_name: string }>(`SELECT doc_name FROM versions WHERE doc_id = ? ORDER BY created_ms DESC, rowid DESC LIMIT 1`, row.doc_id);
        return { docId: row.doc_id, name: name?.doc_name ?? row.doc_name, versions: Number(row.versions), latestAt: row.latest };
      });
    }),

    route('POST', '/api/workspaces/:id/deleted-documents/:docId/recover', (ctx, params) => {
      const { workspace, user } = workspaceOf(ctx, params.id as string, 'editor');
      const docId = params.docId as string;
      if (store.docById(docId)) throw new HttpError(409, 'That file has not been deleted');
      const latest = store.one<VersionRow>(
        `SELECT ${VERSION_COLUMNS} FROM versions WHERE doc_id = ? AND workspace_id = ? ORDER BY created_ms DESC, rowid DESC LIMIT 1`,
        docId,
        workspace.id,
      );
      if (!latest) throw new HttpError(404, 'There is no backup of that file');
      const values = contentOf(latest.id);
      const clock = store.serverClock();
      const doc = store.createDoc(workspace.id, latest.doc_name, user.id, [...values].map(([k, v]) => ({ k, v, c: clock })));
      return new Reply(201, kit.info(doc, ctx.who));
    }),

    route('DELETE', '/api/workspaces/:id/deleted-documents/:docId', (ctx, params) => {
      const { workspace } = workspaceOf(ctx, params.id as string, 'owner');
      const docId = params.docId as string;
      if (store.docById(docId)) throw new HttpError(409, 'That file has not been deleted');
      if (store.run(`DELETE FROM versions WHERE doc_id = ? AND workspace_id = ?`, docId, workspace.id) === 0) throw new HttpError(404, 'There is no backup of that file');
      return {};
    }),

    // ---- branches

    route('POST', '/api/documents/:id/branches', async (ctx, params) => {
      const { doc: main, role } = docOf(ctx, params.id as string);
      if (!canEdit(role)) throw new HttpError(403, 'Only editors can make branches');
      const user = requireUser(ctx);
      if (branchRow(main.id)) throw new HttpError(400, 'A branch cannot have branches of its own: make one from the main file');
      const name = text(await ctx.json(), 'name', 200);
      const branch = store.tx(() => {
        const base = valuesOf(store, main.id);
        // The branch starts with main's registers as they are (their clocks too), under its own name.
        const doc = store.createDoc(main.workspace_id, name, user.id, store.registersSince(main.id, 0).map(({ k, v, c }) => ({ k, v, c })));
        // Whoever may open main may open its branch, in the same way.
        for (const member of store.all<{ user_id: string; role: string }>(`SELECT user_id, role FROM document_members WHERE doc_id = ?`, main.id))
          if (member.user_id !== user.id) store.addDocMember(doc.id, member.user_id, member.role as 'owner' | 'editor' | 'viewer');
        store.run(`UPDATE documents SET link_access = ? WHERE id = ?`, main.link_access, doc.id);
        store.run(
          `INSERT INTO branches (${BRANCH_COLUMNS}) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, NULL, NULL)`,
          doc.id,
          main.id,
          main.name,
          Number(main.seq),
          encode(base),
          user.id,
          now(),
        );
        return doc;
      });
      copyAssets(store, main.id, branch.id);
      return new Reply(201, branchDto(store, branchRow(branch.id) as BranchRow));
    }),

    route('GET', '/api/documents/:id/branches', (ctx, params) => {
      const { doc } = docOf(ctx, params.id as string);
      const rows = store.all<BranchRow>(`SELECT ${BRANCH_COLUMNS} FROM branches WHERE main_id = ? ORDER BY created_at DESC`, doc.id);
      // Only the branches this person can open.
      return rows.filter((row) => {
        const branch = store.docById(row.doc_id);
        return branch !== undefined && store.roleOn(branch, ctx.who) !== null;
      }).map((row) => ({ ...branchDto(store, row), role: store.roleOn(store.docById(row.doc_id) as DocRow, ctx.who) }));
    }),

    /** Whether a document is a branch, and of what: for the "Branch of …" badge. */
    route('GET', '/api/documents/:id/branch', (ctx, params) => {
      const { doc } = docOf(ctx, params.id as string);
      const row = branchRow(doc.id);
      return { branch: row ? branchDto(store, row) : null };
    }),

    route('GET', '/api/documents/:id/update-from-main', (ctx, params) => {
      const { doc, row, main } = branchOf(ctx, params.id as string);
      const base = decode(row.base);
      const mainValues = valuesOf(store, main.id);
      const branchValues = valuesOf(store, doc.id);
      return {
        mainSeq: Number(main.seq),
        baseSeq: Number(row.base_seq),
        changes: changesSince(base, mainValues),
        conflicts: asConflictList(conflictsBetween(base, mainValues, branchValues)),
      };
    }),

    route('POST', '/api/documents/:id/update-from-main', async (ctx, params) => {
      const { doc, role, row, main } = branchOf(ctx, params.id as string);
      if (!canEdit(role)) throw new HttpError(403, 'Only editors of the branch can update it');
      if (row.status !== 'open') throw new HttpError(409, 'This branch has been merged');
      const resolutions = resolutionsOf(await ctx.json(), HttpError);
      // Images main has that the branch may now show.
      copyAssets(store, main.id, doc.id);
      return store.tx(() => {
        const base = decode(row.base);
        const mainValues = valuesOf(store, main.id);
        const { values, unresolved } = valuesToBring(base, mainValues, valuesOf(store, doc.id), 'main', resolutions);
        if (unresolved.length > 0) throw new HttpError(409, `${unresolved.length} ${unresolved.length === 1 ? 'conflict needs' : 'conflicts need'} a choice`);
        const result = setValues(kit, doc.id, values);
        // Main as it is now is the branch's new base.
        store.run(`UPDATE branches SET base = ?, base_seq = ? WHERE doc_id = ?`, encode(mainValues), Number(main.seq), doc.id);
        return { seq: result.seq, applied: values.size, baseSeq: Number(main.seq) };
      });
    }),

    /** The review before merging: the branch's changes since its base, and the conflicts with main's. */
    route('GET', '/api/documents/:id/merge', (ctx, params) => {
      const { doc, row, main } = branchOf(ctx, params.id as string);
      const base = decode(row.base);
      const mainValues = valuesOf(store, main.id);
      const branchValues = valuesOf(store, doc.id);
      const mainRole = store.roleOn(main, ctx.who);
      return {
        mainId: main.id,
        mainSeq: Number(main.seq),
        baseSeq: Number(row.base_seq),
        status: row.status,
        canMerge: canEdit(mainRole) && row.status === 'open',
        changes: changesSince(base, branchValues),
        conflicts: asConflictList(conflictsBetween(base, mainValues, branchValues)),
      };
    }),

    route('POST', '/api/documents/:id/merge', async (ctx, params) => {
      const { doc, row, main } = branchOf(ctx, params.id as string);
      const mainRole = store.roleOn(main, ctx.who);
      if (!canEdit(mainRole)) throw new HttpError(403, 'Only editors of the main file can merge into it');
      if (row.status !== 'open') throw new HttpError(409, 'This branch has already been merged');
      const user = requireUser(ctx);
      const resolutions = resolutionsOf(await ctx.json(), HttpError);
      // Images the branch added, which main will now show.
      copyAssets(store, doc.id, main.id);
      return store.tx(() => {
        const base = decode(row.base);
        const { values, unresolved } = valuesToBring(base, valuesOf(store, doc.id), valuesOf(store, main.id), 'branch', resolutions);
        if (unresolved.length > 0) throw new HttpError(409, `${unresolved.length} ${unresolved.length === 1 ? 'conflict needs' : 'conflicts need'} a choice`);
        const author = { id: user.id, guest: false };
        const before = recordVersion(store, main, 'named', `Before merging ${doc.name}`, `Main as it was before the branch “${doc.name}” was merged. Restore this version to undo the merge.`, author);
        const result = setValues(kit, main.id, values);
        const after = recordVersion(store, main, 'named', `Merged ${doc.name}`, `${values.size} ${values.size === 1 ? 'change' : 'changes'} from the branch “${doc.name}”.`, author);
        store.run(`UPDATE branches SET status = 'merged', merged_at = ?, merged_by = ? WHERE doc_id = ?`, now(), user.id, doc.id);
        return { mainSeq: result.seq, applied: values.size, before, after, branch: branchDto(store, branchRow(doc.id) as BranchRow) };
      });
    }),
  ];
};
