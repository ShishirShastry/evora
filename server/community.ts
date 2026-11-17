/**
 * Phase 9: the community library and advanced file management. Built on the API through its extension hook (`ApiExtension` in api.ts):
 * `setup` makes this part's tables (CREATE TABLE IF NOT EXISTS, so it is safe on every start
 * and on a database made before it), `extension` gives its routes.
 *
 * ## The community (all free, open to everyone)
 *
 * A resource is a design file, template, UI kit, component library or icon
 * library someone published. Each publication is a version: a copy of the
 * file's registers taken when it was published (later edits to the file do not
 * change it), with the images it uses copied beside it
 * (`<data>/community/<resourceId>/<hash>`) and a cover picture made by the app.
 * Publishing again from the same file (a shared document, or a file on the
 * author's device, by its ID) makes a new version of the same resource.
 * Browsing, reading and taking a copy to one's device need no account;
 * publishing and duplicating into a workspace need one.
 *
 * - GET    /api/community/resources?q=&kind=&tag=&sort=newest|popular&limit=&offset=  -> {items: ResourceSummary[], total}   (anyone)
 * - POST   /api/community/resources  {docId | registers+sourceId, kind, title, description?, tags?, notes?}
 *                                     -> {resource, version, created} (201 when new)   (an account; editors of a shared file)
 * - GET    /api/community/resources/:id                    -> ResourceDetail          (anyone)
 * - PATCH  /api/community/resources/:id {kind?, title?, description?, tags?} -> ResourceDetail (its author)
 * - DELETE /api/community/resources/:id                    -> {}                      (its author: unpublishes it)
 * - PUT    /api/community/resources/:id/cover (PNG/JPEG/WebP bytes) -> {}             (its author)
 * - GET    /api/community/resources/:id/cover              -> the picture             (anyone)
 * - PUT    /api/community/resources/:id/assets/:hash (bytes) -> {}                    (its author; only images its latest version uses)
 * - GET    /api/community/resources/:id/assets/:hash       -> the bytes               (anyone)
 * - GET    /api/community/resources/:id/versions/:number   -> VersionContent          (anyone)
 * - POST   /api/community/resources/:id/copies {version?}  -> VersionContent          (anyone: a copy to keep on one's device; counted)
 * - POST   /api/community/resources/:id/duplicate {workspaceId, version?, projectId?} -> FileInfo (201) (an editor of the workspace; counted)
 *
 * `duplicates` counts each taker once, whether they take a copy or duplicate
 * it, however often: an account (or a guest) by its ID, someone with neither
 * by a keyed hash of their address (`kit.countedAs`; the address itself is
 * not kept). It is the number of distinct takers in `community_takers` plus
 * the counter kept before takers were recorded (the `duplicates` column,
 * no longer changed), so a number shown before never drops. Someone with
 * many accounts or addresses can still be counted more than once. The two
 * routes are limited per address (Limits.counted).
 * - GET    /api/community/mine                             -> ResourceSummary[] with sourceKey (an account)
 * - GET    /api/community/tags                             -> {tag, count}[]          (anyone)
 *
 * ## File management (shared files)
 *
 * Projects are folders inside a workspace; a file is in at most one, or at the
 * workspace's root. Favourites and recents are per person. Deleting a file
 * (`DELETE /api/documents/:id` or `POST /api/documents/:id/trash`, both in
 * api.ts, `store.trashDoc`) moves it to its workspace's trash: it keeps
 * everything, but nobody can open it (its members, invitations and link
 * access are put aside and it belongs to no workspace; opening it answers 410
 * "This file is in the trash") until it is restored; after 30 days it is
 * deleted for good.
 *
 * Branches are not listed as files: every list here leaves them out and gives
 * each main file its open branches (`FileInfo.branches`, and `mainId` for a
 * branch met some other way, e.g. after moving it). A branch still opens by
 * its link, and GET /api/documents/:id/branches lists all of a file's branches.
 *
 * - GET    /api/workspaces/:id/projects            -> Project[]          (members)
 * - POST   /api/workspaces/:id/projects {name}     -> Project (201)      (editors)
 * - PATCH  /api/projects/:id {name}                -> Project            (editors of its workspace)
 * - DELETE /api/projects/:id                       -> {}                 (editors; its files go to the workspace's root)
 * - GET    /api/workspaces/:id/files               -> FileInfo[]         (members)
 * - POST   /api/documents/:id/move {workspaceId?, projectId?: string|null} -> FileInfo (editors of the file and of both workspaces)
 * - POST   /api/documents/:id/duplicate {workspaceId?, projectId?, name?}  -> FileInfo (201) (anyone who can open it, into a workspace they edit in)
 * - POST   /api/documents/:id/trash                -> {}                 (owners of the file; in api.ts, the same as DELETE /api/documents/:id)
 * - GET    /api/workspaces/:id/trash               -> TrashedFile[]      (members)
 * - POST   /api/trash/:docId/restore               -> FileInfo           (editors of its workspace)
 * - DELETE /api/trash/:docId                       -> {}                 (a workspace owner, whoever deleted it, or the file's owner)
 * - GET    /api/favorites                          -> FileInfo[]
 * - PUT    /api/favorites/:docId                   -> {}                 (anyone who can open it)
 * - DELETE /api/favorites/:docId                   -> {}
 * - GET    /api/recents                            -> FileInfo[]         (the 30 last opened)
 * - POST   /api/recents/:docId                     -> {}                 (anyone who can open it)
 * - GET    /api/files/search?q=                    -> FileInfo[]         (files in one's workspaces and shared with one)
 */
import { createHash } from 'node:crypto';
import { copyFileSync, createReadStream, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ApiExtension, ApiKit, Ctx } from './api.ts';
import { looksLike, readBody, uploadType } from './http.ts';
import { TRASH_WORKSPACE, invalidRegisters, newId, now, type BranchFields, type DocRow, type Identity, type Store, type TrashRow, type UserRow } from './store.ts';
import { canEdit, type DocInfo, type Register, type Role, type UserRef } from '../src/collab/protocol.ts';

// ------------------------------------------------------------------ what is answered

export const RESOURCE_KINDS = ['file', 'template', 'ui-kit', 'components', 'icons'] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

export interface ResourceSummary {
  id: string;
  kind: ResourceKind;
  title: string;
  description: string;
  tags: string[];
  author: UserRef;
  /** When the cover was last changed, or null when there is none (its picture is at /api/community/resources/:id/cover). */
  coverAt: string | null;
  /** The latest version's number. */
  version: number;
  duplicates: number;
  createdAt: string;
  updatedAt: string;
  /** For the author only: the file it is published from (`doc:<id>` or `local:<id>`). */
  sourceKey?: string;
}

export interface VersionInfo {
  number: number;
  name: string;
  notes: string;
  createdAt: string;
  assetCount: number;
}

export interface ResourceDetail extends ResourceSummary {
  versions: VersionInfo[];
}

export interface VersionContent {
  resourceId: string;
  number: number;
  name: string;
  registers: Register[];
  /** The images the version uses that were uploaded, with their types. */
  assets: { hash: string; contentType: string }[];
}

export interface Project {
  id: string;
  workspaceId: string;
  name: string;
  createdAt: string;
  fileCount: number;
}

export interface FileInfo extends DocInfo, BranchFields {
  projectId: string | null;
  projectName: string | null;
  /** The workspace's name, when the person asking is one of its members. */
  workspaceName: string | null;
  favorite: boolean;
  /** When the person asking last opened it, as far as the app said. */
  openedAt: string | null;
}

export interface TrashedFile {
  id: string;
  name: string;
  workspaceId: string;
  owner: UserRef;
  trashedBy: UserRef;
  trashedAt: string;
  /** When it is deleted for good. */
  purgeAt: string;
  /** Whether the person asking may delete it for good. */
  canDelete: boolean;
}

// ------------------------------------------------------------------ rows and limits

interface ResourceRow {
  id: string;
  author_id: string;
  source_key: string;
  kind: ResourceKind;
  title: string;
  description: string;
  tags: string;
  cover_type: string | null;
  cover_at: string | null;
  /** The count kept before each taker was recorded (no longer changed); `duplicates` in answers adds the distinct takers. */
  duplicates: number;
  /** Selected with the row in lists: the distinct takers in community_takers. */
  takers?: number;
  created_at: string;
  updated_at: string;
}

interface VersionRow {
  resource_id: string;
  number: number;
  name: string;
  notes: string;
  registers: string;
  assets: string;
  created_at: string;
}

interface ProjectRow {
  id: string;
  workspace_id: string;
  name: string;
  created_by: string;
  created_at: string;
}

/** The workspace a file in the trash belongs to (kept in store.ts, with the trash itself). */
export { TRASH_WORKSPACE };
/** How long a file stays in the trash. */
export const TRASH_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const ASSET_HASH = /^[0-9a-f]{64}$/;
const COVER_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_COVER_BYTES = 5 * 1024 * 1024;
const MAX_TAGS = 10;
const MAX_RECENTS = 50;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS community_resources (
  id TEXT PRIMARY KEY,
  author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  tags TEXT NOT NULL,
  cover_type TEXT,
  cover_at TEXT,
  duplicates INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS community_resources_source ON community_resources(author_id, source_key);

CREATE TABLE IF NOT EXISTS community_tags (
  resource_id TEXT NOT NULL REFERENCES community_resources(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY (resource_id, tag)
);
CREATE INDEX IF NOT EXISTS community_tags_tag ON community_tags(tag);

CREATE TABLE IF NOT EXISTS community_versions (
  resource_id TEXT NOT NULL REFERENCES community_resources(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  name TEXT NOT NULL,
  notes TEXT NOT NULL,
  registers TEXT NOT NULL,
  assets TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (resource_id, number)
);

CREATE TABLE IF NOT EXISTS community_assets (
  resource_id TEXT NOT NULL REFERENCES community_resources(id) ON DELETE CASCADE,
  hash TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (resource_id, hash)
);

CREATE TABLE IF NOT EXISTS file_projects (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS file_projects_workspace ON file_projects(workspace_id);

CREATE TABLE IF NOT EXISTS file_project_docs (
  doc_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES file_projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS file_project_docs_project ON file_project_docs(project_id);

CREATE TABLE IF NOT EXISTS file_favorites (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, doc_id)
);

CREATE TABLE IF NOT EXISTS file_recents (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  opened_at TEXT NOT NULL,
  PRIMARY KEY (user_id, doc_id)
);

CREATE TABLE IF NOT EXISTS community_takers (
  resource_id TEXT NOT NULL REFERENCES community_resources(id) ON DELETE CASCADE,
  who TEXT NOT NULL,
  taken_at TEXT NOT NULL,
  PRIMARY KEY (resource_id, who)
);
`;

/** Timers of the stores set up here, so that a closed store's timer stops. */
const purgeTimers = new WeakMap<Store, ReturnType<typeof setInterval>>();

export function setup(store: Store): void {
  // The file_trash table and the trash workspace are the store's own (store.ts).
  store.db.exec(SCHEMA);
  purgeTrash(store);
  if (!purgeTimers.has(store)) {
    const timer = setInterval(() => {
      if (!store.db.isOpen) {
        clearInterval(timer);
        return;
      }
      purgeTrash(store);
    }, 60 * 60 * 1000);
    timer.unref();
    purgeTimers.set(store, timer);
  }
}

/** Deletes for good the files that have been in the trash for 30 days, and those whose workspace is gone. Returns how many. */
export function purgeTrash(store: Store, nowMs: number = Date.now()): number {
  const doomed = store.all<{ doc_id: string }>(
    `SELECT t.doc_id FROM file_trash t LEFT JOIN workspaces w ON w.id = t.workspace_id WHERE t.trashed_at <= ? OR w.id IS NULL`,
    nowMs - TRASH_DAYS * DAY_MS,
  );
  for (const row of doomed) store.deleteDoc(row.doc_id);
  return doomed.length;
}

function communityDir(store: Store, resourceId: string): string {
  return join(store.dataDir, 'community', resourceId);
}

/** Writes bytes beside their place first and then renames them, so a reader never sees half a file. */
function writeWhole(path: string, bytes: Uint8Array): void {
  mkdirSync(join(path, '..'), { recursive: true });
  const partial = `${path}.${newId()}.part`;
  writeFileSync(partial, bytes);
  renameSync(partial, path);
}

// ------------------------------------------------------------------ the routes

export const extension: ApiExtension = (kit: ApiKit) => {
  const { store, hub, route, HttpError, Reply, HANDLED, requireUser, workspaceOf, docOf, info, text, optionalText } = kit;

  // -------------------------------------------------------------- reading what was sent

  function optionalString(body: Record<string, unknown>, key: string, max: number): string | undefined {
    const value = body[key];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string') throw new HttpError(400, `${key} must be text`);
    const trimmed = value.trim();
    if (trimmed.length > max) throw new HttpError(400, `${key} is longer than ${max} characters`);
    return trimmed;
  }

  function kindOf(value: unknown): ResourceKind {
    if (typeof value !== 'string' || !(RESOURCE_KINDS as readonly string[]).includes(value)) throw new HttpError(400, `kind must be one of ${RESOURCE_KINDS.join(', ')}`);
    return value as ResourceKind;
  }

  function tagsOf(value: unknown): string[] {
    if (!Array.isArray(value)) throw new HttpError(400, 'tags must be a list of words');
    const out: string[] = [];
    for (const tag of value) {
      if (typeof tag !== 'string') throw new HttpError(400, 'tags must be a list of words');
      const cleaned = tag.trim().toLowerCase().replace(/\s+/g, '-');
      if (!cleaned) continue;
      if (cleaned.length > 30) throw new HttpError(400, 'A tag is limited to 30 characters');
      if (!out.includes(cleaned)) out.push(cleaned);
    }
    if (out.length > MAX_TAGS) throw new HttpError(400, `A resource can have at most ${MAX_TAGS} tags`);
    return out;
  }

  function versionNumber(value: unknown): number | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw new HttpError(400, 'version must be a version number');
    return value;
  }

  // -------------------------------------------------------------- resources

  function takerCount(resourceId: string): number {
    const row = store.one<{ n: number }>(`SELECT COUNT(*) AS n FROM community_takers WHERE resource_id = ?`, resourceId);
    return row ? Number(row.n) : 0;
  }

  /** Counts someone (`kit.countedAs`) as a taker of a resource: once, however often they take it. */
  function countTaker(resourceId: string, who: string): void {
    store.run(`INSERT OR IGNORE INTO community_takers (resource_id, who, taken_at) VALUES (?, ?, ?)`, resourceId, who, now());
  }

  function resourceOf(id: string): ResourceRow {
    const row = store.one<ResourceRow>(`SELECT * FROM community_resources WHERE id = ?`, id);
    if (!row) throw new HttpError(404, 'There is no such resource: it may have been unpublished');
    return row;
  }

  function authorOf(ctx: Ctx, id: string): { resource: ResourceRow; user: UserRow } {
    const user = requireUser(ctx);
    const resource = resourceOf(id);
    if (resource.author_id !== user.id) throw new HttpError(403, 'Only its author can change a resource');
    return { resource, user };
  }

  function latestNumber(resourceId: string): number {
    const row = store.one<{ n: number | null }>(`SELECT MAX(number) AS n FROM community_versions WHERE resource_id = ?`, resourceId);
    return row && row.n !== null ? Number(row.n) : 0;
  }

  function summary(row: ResourceRow, who: Identity): ResourceSummary {
    const author = store.ref(row.author_id);
    const out: ResourceSummary = {
      id: row.id,
      kind: row.kind,
      title: row.title,
      description: row.description,
      tags: JSON.parse(row.tags) as string[],
      author: { id: author.id, name: author.name, color: author.color },
      coverAt: row.cover_type ? row.cover_at : null,
      version: latestNumber(row.id),
      duplicates: Number(row.duplicates) + (row.takers === undefined ? takerCount(row.id) : Number(row.takers)),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    if (who.kind === 'user' && who.user.id === row.author_id) out.sourceKey = row.source_key;
    return out;
  }

  function detail(row: ResourceRow, who: Identity): ResourceDetail {
    const versions = store
      .all<VersionRow>(`SELECT resource_id, number, name, notes, assets, created_at, '' AS registers FROM community_versions WHERE resource_id = ? ORDER BY number DESC`, row.id)
      .map((version) => ({
        number: Number(version.number),
        name: version.name,
        notes: version.notes,
        createdAt: version.created_at,
        assetCount: (JSON.parse(version.assets) as string[]).length,
      }));
    return { ...summary(row, who), versions };
  }

  function versionOf(resourceId: string, number?: number): VersionRow {
    const wanted = number ?? latestNumber(resourceId);
    const row = store.one<VersionRow>(`SELECT * FROM community_versions WHERE resource_id = ? AND number = ?`, resourceId, wanted);
    if (!row) throw new HttpError(404, 'There is no such version of this resource');
    return row;
  }

  function content(version: VersionRow): VersionContent {
    const wanted = new Set(JSON.parse(version.assets) as string[]);
    const assets = store
      .all<{ hash: string; content_type: string }>(`SELECT hash, content_type FROM community_assets WHERE resource_id = ? ORDER BY hash`, version.resource_id)
      .filter((asset) => wanted.has(asset.hash))
      .map((asset) => ({ hash: asset.hash, contentType: asset.content_type }));
    return { resourceId: version.resource_id, number: Number(version.number), name: version.name, registers: JSON.parse(version.registers) as Register[], assets };
  }

  /** The images registers use: the hashes of `a:<hash>` keys that are not removed. */
  function usedAssets(registers: Register[]): string[] {
    const out: string[] = [];
    for (const register of registers) {
      if (!register.k.startsWith('a:') || register.v === null || register.v === undefined) continue;
      const hash = register.k.slice(2);
      if (ASSET_HASH.test(hash) && !out.includes(hash)) out.push(hash);
    }
    return out;
  }

  function nameIn(registers: Register[], fallback: string): string {
    const found = registers.find((register) => register.k === 'd:name');
    return found && typeof found.v === 'string' && found.v.trim() ? found.v.trim().slice(0, 200) : fallback;
  }

  /** A document's content as registers, as they are now: a snapshot that later edits do not change. */
  function snapshot(docId: string): Register[] {
    return store.registersSince(docId, 0).map(({ k, v, c }) => ({ k, v, c }));
  }

  /** Copies the images of a shared document that `hashes` names into a resource. */
  function copyDocAssets(docId: string, resourceId: string, hashes: string[]): void {
    for (const hash of hashes) {
      const asset = store.one<{ content_type: string; size: number }>(`SELECT content_type, size FROM assets WHERE doc_id = ? AND hash = ?`, docId, hash);
      const from = store.assetPath(docId, hash);
      if (!asset || !existsSync(from)) continue;
      const to = join(communityDir(store, resourceId), hash);
      if (!existsSync(to)) {
        mkdirSync(communityDir(store, resourceId), { recursive: true });
        copyFileSync(from, to);
      }
      store.run(
        `INSERT OR IGNORE INTO community_assets (resource_id, hash, content_type, size, created_at) VALUES (?, ?, ?, ?, ?)`,
        resourceId,
        hash,
        asset.content_type,
        Number(asset.size),
        now(),
      );
    }
  }

  function setTags(resourceId: string, tags: string[]): void {
    store.run(`DELETE FROM community_tags WHERE resource_id = ?`, resourceId);
    for (const tag of tags) store.run(`INSERT INTO community_tags (resource_id, tag) VALUES (?, ?)`, resourceId, tag);
  }

  function sendFile(ctx: Ctx, path: string, contentType: string, size: number | null, cache: string): typeof HANDLED {
    ctx.res.writeHead(200, {
      'Content-Type': contentType,
      ...(size === null ? {} : { 'Content-Length': size }),
      'Cache-Control': cache,
      'X-Content-Type-Options': 'nosniff',
      // Whatever was uploaded, it never runs as a page on this site.
      'Content-Security-Policy': "default-src 'none'; sandbox",
    });
    createReadStream(path)
      .on('error', () => ctx.res.destroy())
      .pipe(ctx.res);
    return HANDLED;
  }

  // -------------------------------------------------------------- files: access and answers

  function workspaceName(workspaceId: string, who: Identity): string | null {
    if (who.kind !== 'user') return null;
    if (!store.workspaceRole(workspaceId, who.user.id)) return null;
    return store.workspaceById(workspaceId)?.name ?? null;
  }

  function fileInfo(doc: DocRow, who: Identity): FileInfo {
    const project = store.one<{ id: string; name: string }>(
      `SELECT p.id, p.name FROM file_project_docs d JOIN file_projects p ON p.id = d.project_id WHERE d.doc_id = ?`,
      doc.id,
    );
    const userId = who.kind === 'user' ? who.user.id : null;
    const favorite = userId ? !!store.one(`SELECT 1 AS x FROM file_favorites WHERE user_id = ? AND doc_id = ?`, userId, doc.id) : false;
    const opened = userId ? store.one<{ opened_at: string }>(`SELECT opened_at FROM file_recents WHERE user_id = ? AND doc_id = ?`, userId, doc.id) : undefined;
    return {
      ...info(doc, who),
      projectId: project?.id ?? null,
      projectName: project?.name ?? null,
      workspaceName: workspaceName(doc.workspace_id, who),
      favorite,
      openedAt: opened?.opened_at ?? null,
      ...store.branchFields(doc, who),
    };
  }

  /** Only the files the person can open, none in the trash, and no branches (they are listed with their main file). */
  function openable(docs: DocRow[], who: Identity): DocRow[] {
    return docs.filter((doc) => doc.workspace_id !== TRASH_WORKSPACE && store.roleOn(doc, who) !== null && !store.hiddenInLists(doc.id));
  }

  /** A list of files: no branches (they are listed with their main file). */
  function listed(docs: DocRow[], who: Identity): FileInfo[] {
    return docs.filter((doc) => !store.hiddenInLists(doc.id)).map((doc) => fileInfo(doc, who));
  }

  function projectOf(ctx: Ctx, id: string, least: Role = 'viewer'): { project: ProjectRow; role: Role; user: UserRow } {
    const project = store.one<ProjectRow>(`SELECT * FROM file_projects WHERE id = ?`, id);
    if (!project) throw new HttpError(404, 'There is no such project');
    const { role, user } = workspaceOf(ctx, project.workspace_id, least);
    return { project, role, user };
  }

  function projectDto(row: ProjectRow): Project {
    const count = store.one<{ n: number }>(`SELECT COUNT(*) AS n FROM file_project_docs WHERE project_id = ?`, row.id);
    return { id: row.id, workspaceId: row.workspace_id, name: row.name, createdAt: row.created_at, fileCount: count ? Number(count.n) : 0 };
  }

  /** A project for a file in a workspace: null for the root; one of another workspace is refused. */
  function projectIn(workspaceId: string, value: unknown): string | null {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string') throw new HttpError(400, 'projectId must be a project ID or null');
    const project = store.one<ProjectRow>(`SELECT * FROM file_projects WHERE id = ?`, value);
    if (!project || project.workspace_id !== workspaceId) throw new HttpError(400, 'That project is not in the workspace');
    return project.id;
  }

  function placeInProject(docId: string, projectId: string | null): void {
    store.run(`DELETE FROM file_project_docs WHERE doc_id = ?`, docId);
    if (projectId) store.run(`INSERT INTO file_project_docs (doc_id, project_id) VALUES (?, ?)`, docId, projectId);
  }

  /** A copy of a document's images for another document: the bytes and their rows. */
  function copyAssetsBetween(fromPath: (hash: string) => string, rows: { hash: string; content_type: string; size: number }[], docId: string): void {
    for (const asset of rows) {
      const from = fromPath(asset.hash);
      if (!existsSync(from)) continue;
      const to = store.assetPath(docId, asset.hash);
      mkdirSync(join(to, '..'), { recursive: true });
      copyFileSync(from, to);
      store.run(
        `INSERT OR IGNORE INTO assets (doc_id, hash, content_type, size, created_at) VALUES (?, ?, ?, ?, ?)`,
        docId,
        asset.hash,
        asset.content_type,
        Number(asset.size),
        now(),
      );
    }
  }

  function trashRowOf(ctx: Ctx, docId: string, least: Role): { row: TrashRow; doc: DocRow; role: Role; user: UserRow } {
    const row = store.one<TrashRow>(`SELECT * FROM file_trash WHERE doc_id = ?`, docId);
    const doc = row ? store.docById(row.doc_id) : undefined;
    if (!row || !doc) throw new HttpError(404, 'That file is not in the trash');
    const { role, user } = workspaceOf(ctx, row.workspace_id, least);
    return { row, doc, role, user };
  }

  function query(ctx: Ctx): URLSearchParams {
    return new URL(ctx.req.url ?? '/', 'http://localhost').searchParams;
  }

  // -------------------------------------------------------------- the list

  return [
    // ---- the community

    route('GET', '/api/community/resources', (ctx) => {
      const params = query(ctx);
      const where: string[] = [];
      const args: (string | number)[] = [];
      const kind = params.get('kind');
      if (kind) {
        where.push('r.kind = ?');
        args.push(kindOf(kind));
      }
      const tag = params.get('tag');
      if (tag) {
        where.push('EXISTS (SELECT 1 FROM community_tags t WHERE t.resource_id = r.id AND t.tag = ?)');
        args.push(tag.trim().toLowerCase());
      }
      // Every word must be found in the title, the description, a tag or the author's name.
      // At most five words of at most 100 characters each: a search is never an expensive pattern.
      const words = (params.get('q') ?? '').slice(0, 1000).toLowerCase().split(/\s+/).filter(Boolean).slice(0, 5).map((word) => word.slice(0, 100));
      for (const word of words) {
        const like = `%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        where.push(
          `(lower(r.title) LIKE ? ESCAPE '\\' OR lower(r.description) LIKE ? ESCAPE '\\' OR lower(u.name) LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM community_tags t2 WHERE t2.resource_id = r.id AND t2.tag LIKE ? ESCAPE '\\'))`,
        );
        args.push(like, like, like, like);
      }
      const order = params.get('sort') === 'popular' ? '(r.duplicates + takers) DESC, r.updated_at DESC, r.rowid DESC' : 'r.updated_at DESC, r.rowid DESC';
      const limit = Math.min(100, Math.max(1, Number(params.get('limit')) || 48));
      const offset = Math.max(0, Number(params.get('offset')) || 0);
      const from = `FROM community_resources r JOIN users u ON u.id = r.author_id${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`;
      const total = store.one<{ n: number }>(`SELECT COUNT(*) AS n ${from}`, ...args);
      const rows = store.all<ResourceRow>(
        `SELECT r.*, (SELECT COUNT(*) FROM community_takers k WHERE k.resource_id = r.id) AS takers ${from} ORDER BY ${order} LIMIT ? OFFSET ?`,
        ...args,
        limit,
        offset,
      );
      return { items: rows.map((row) => summary(row, ctx.who)), total: total ? Number(total.n) : 0 };
    }),

    route('GET', '/api/community/tags', () =>
      store
        .all<{ tag: string; n: number }>(`SELECT tag, COUNT(*) AS n FROM community_tags GROUP BY tag ORDER BY n DESC, tag LIMIT 30`)
        .map((row) => ({ tag: row.tag, count: Number(row.n) })),
    ),

    route('GET', '/api/community/mine', (ctx) => {
      const user = requireUser(ctx);
      return store
        .all<ResourceRow>(`SELECT * FROM community_resources WHERE author_id = ? ORDER BY updated_at DESC, rowid DESC`, user.id)
        .map((row) => summary(row, ctx.who));
    }),

    route('POST', '/api/community/resources', async (ctx) => {
      const user = requireUser(ctx);
      const body = await ctx.json(kit.maxUploadBytes);
      let sourceKey: string;
      let registers: Register[];
      let fromDoc: DocRow | null = null;
      if (body.docId !== undefined) {
        if (typeof body.docId !== 'string') throw new HttpError(400, 'docId must be a document ID');
        const { doc, role } = docOf(ctx, body.docId);
        if (!canEdit(role)) throw new HttpError(403, 'Only people who can edit a file can publish it');
        fromDoc = doc;
        sourceKey = `doc:${doc.id}`;
        registers = snapshot(doc.id);
      } else {
        const invalid = invalidRegisters(body.registers, Date.now());
        if (invalid) throw new HttpError(400, invalid);
        sourceKey = `local:${text(body, 'sourceId', 200)}`;
        registers = body.registers as Register[];
      }
      const existing = store.one<ResourceRow>(`SELECT * FROM community_resources WHERE author_id = ? AND source_key = ?`, user.id, sourceKey);
      const kind = body.kind === undefined && existing ? existing.kind : kindOf(body.kind);
      const title = existing ? (optionalText(body, 'title', 100) ?? existing.title) : text(body, 'title', 100);
      const description = optionalString(body, 'description', 2000) ?? existing?.description ?? '';
      const tags = body.tags === undefined ? (existing ? (JSON.parse(existing.tags) as string[]) : []) : tagsOf(body.tags);
      const notes = optionalString(body, 'notes', 1000) ?? '';
      const assets = usedAssets(registers);
      const name = nameIn(registers, title);
      const stamp = now();

      const id = existing?.id ?? newId();
      const number = store.tx(() => {
        if (existing) {
          store.run(`UPDATE community_resources SET kind = ?, title = ?, description = ?, tags = ?, updated_at = ? WHERE id = ?`, kind, title, description, JSON.stringify(tags), stamp, id);
        } else {
          store.run(
            `INSERT INTO community_resources (id, author_id, source_key, kind, title, description, tags, cover_type, cover_at, duplicates, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, ?, ?)`,
            id,
            user.id,
            sourceKey,
            kind,
            title,
            description,
            JSON.stringify(tags),
            stamp,
            stamp,
          );
        }
        setTags(id, tags);
        const next = latestNumber(id) + 1;
        store.run(
          `INSERT INTO community_versions (resource_id, number, name, notes, registers, assets, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          id,
          next,
          name,
          notes,
          JSON.stringify(registers),
          JSON.stringify(assets),
          stamp,
        );
        return next;
      });
      // The images of a shared file are copied now; those of a file on the author's device are uploaded next.
      if (fromDoc) copyDocAssets(fromDoc.id, id, assets);
      const result = { resource: detail(resourceOf(id), ctx.who), version: number, created: !existing };
      return existing ? result : new Reply(201, result);
    }),

    route('GET', '/api/community/resources/:id', (ctx, params) => detail(resourceOf(params.id as string), ctx.who)),

    route('PATCH', '/api/community/resources/:id', async (ctx, params) => {
      const { resource } = authorOf(ctx, params.id as string);
      const body = await ctx.json();
      const kind = body.kind === undefined ? resource.kind : kindOf(body.kind);
      const title = optionalText(body, 'title', 100) ?? resource.title;
      const description = optionalString(body, 'description', 2000) ?? resource.description;
      const tags = body.tags === undefined ? (JSON.parse(resource.tags) as string[]) : tagsOf(body.tags);
      store.tx(() => {
        store.run(`UPDATE community_resources SET kind = ?, title = ?, description = ?, tags = ?, updated_at = ? WHERE id = ?`, kind, title, description, JSON.stringify(tags), now(), resource.id);
        setTags(resource.id, tags);
      });
      return detail(resourceOf(resource.id), ctx.who);
    }),

    route('DELETE', '/api/community/resources/:id', (ctx, params) => {
      const { resource } = authorOf(ctx, params.id as string);
      store.run(`DELETE FROM community_resources WHERE id = ?`, resource.id);
      rmSync(communityDir(store, resource.id), { recursive: true, force: true });
      return {};
    }),

    route('PUT', '/api/community/resources/:id/cover', async (ctx, params) => {
      const { resource } = authorOf(ctx, params.id as string);
      const type = String(ctx.req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
      if (!COVER_TYPES.includes(type)) throw new HttpError(400, 'A cover must be a PNG, JPEG or WebP picture');
      const bytes = await readBody(ctx.req, MAX_COVER_BYTES);
      if (bytes.length === 0) throw new HttpError(400, 'The cover is empty');
      // The bytes must be the picture they are said to be.
      if (!looksLike(type, bytes)) throw new HttpError(400, 'The cover is not the picture its type says it is');
      writeWhole(join(communityDir(store, resource.id), 'cover'), bytes);
      store.run(`UPDATE community_resources SET cover_type = ?, cover_at = ? WHERE id = ?`, type, now(), resource.id);
      return {};
    }),

    route('GET', '/api/community/resources/:id/cover', (ctx, params) => {
      const resource = resourceOf(params.id as string);
      const path = join(communityDir(store, resource.id), 'cover');
      if (!resource.cover_type || !existsSync(path)) throw new HttpError(404, 'This resource has no cover');
      return sendFile(ctx, path, resource.cover_type, null, 'public, max-age=300');
    }),

    route('PUT', '/api/community/resources/:id/assets/:hash', async (ctx, params) => {
      const { resource } = authorOf(ctx, params.id as string);
      const hash = params.hash as string;
      if (!ASSET_HASH.test(hash)) throw new HttpError(400, 'An image is named by the SHA-256 of its bytes, in lowercase hex');
      const latest = versionOf(resource.id);
      if (!(JSON.parse(latest.assets) as string[]).includes(hash)) throw new HttpError(400, 'The resource’s latest version does not use this image');
      const bytes = await readBody(ctx.req, kit.maxUploadBytes);
      if (createHash('sha256').update(bytes).digest('hex') !== hash) throw new HttpError(400, 'The bytes do not match their hash');
      // Only image types are kept as declared: anything else is served as bytes, never as a page or a script.
      const type = uploadType(ctx.req.headers['content-type']);
      writeWhole(join(communityDir(store, resource.id), hash), bytes);
      store.run(
        `INSERT INTO community_assets (resource_id, hash, content_type, size, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(resource_id, hash) DO UPDATE SET content_type = excluded.content_type, size = excluded.size`,
        resource.id,
        hash,
        type,
        bytes.length,
        now(),
      );
      return {};
    }),

    route('GET', '/api/community/resources/:id/assets/:hash', (ctx, params) => {
      const resource = resourceOf(params.id as string);
      const hash = params.hash as string;
      const asset = ASSET_HASH.test(hash)
        ? store.one<{ content_type: string; size: number }>(`SELECT content_type, size FROM community_assets WHERE resource_id = ? AND hash = ?`, resource.id, hash)
        : undefined;
      const path = join(communityDir(store, resource.id), hash);
      if (!asset || !existsSync(path)) throw new HttpError(404, 'There is no such image in this resource');
      return sendFile(ctx, path, uploadType(asset.content_type), Number(asset.size), 'public, max-age=31536000, immutable');
    }),

    route('GET', '/api/community/resources/:id/versions/:number', (_ctx, params) => {
      const resource = resourceOf(params.id as string);
      const number = Number(params.number);
      if (!Number.isInteger(number) || number < 1) throw new HttpError(404, 'There is no such version of this resource');
      return content(versionOf(resource.id, number));
    }),

    route('POST', '/api/community/resources/:id/copies', async (ctx, params) => {
      const resource = resourceOf(params.id as string);
      const version = versionOf(resource.id, versionNumber((await ctx.json()).version));
      countTaker(resource.id, kit.countedAs(ctx));
      return content(version);
    }),

    route('POST', '/api/community/resources/:id/duplicate', async (ctx, params) => {
      const resource = resourceOf(params.id as string);
      const body = await ctx.json();
      if (typeof body.workspaceId !== 'string') throw new HttpError(400, 'workspaceId is required');
      const { workspace, user } = workspaceOf(ctx, body.workspaceId, 'editor');
      const version = versionOf(resource.id, versionNumber(body.version));
      const projectId = projectIn(workspace.id, body.projectId);
      const taker = kit.countedAs(ctx);
      const registers = JSON.parse(version.registers) as Register[];
      const doc = store.createDoc(workspace.id, version.name || resource.title, user.id, registers);
      const wanted = new Set(JSON.parse(version.assets) as string[]);
      const rows = store
        .all<{ hash: string; content_type: string; size: number }>(`SELECT hash, content_type, size FROM community_assets WHERE resource_id = ?`, resource.id)
        .filter((row) => wanted.has(row.hash));
      copyAssetsBetween((hash) => join(communityDir(store, resource.id), hash), rows, doc.id);
      store.tx(() => {
        placeInProject(doc.id, projectId);
        countTaker(resource.id, taker);
      });
      return new Reply(201, fileInfo(store.docById(doc.id) as DocRow, ctx.who));
    }),

    // ---- projects

    route('GET', '/api/workspaces/:id/projects', (ctx, params) => {
      const { workspace } = workspaceOf(ctx, params.id as string);
      return store.all<ProjectRow>(`SELECT * FROM file_projects WHERE workspace_id = ? ORDER BY lower(name), created_at`, workspace.id).map(projectDto);
    }),

    route('POST', '/api/workspaces/:id/projects', async (ctx, params) => {
      const { workspace, user } = workspaceOf(ctx, params.id as string, 'editor');
      const name = text(await ctx.json(), 'name', 100);
      const row: ProjectRow = { id: newId(), workspace_id: workspace.id, name, created_by: user.id, created_at: now() };
      store.run(`INSERT INTO file_projects (id, workspace_id, name, created_by, created_at) VALUES (?, ?, ?, ?, ?)`, row.id, row.workspace_id, row.name, row.created_by, row.created_at);
      return new Reply(201, projectDto(row));
    }),

    route('PATCH', '/api/projects/:id', async (ctx, params) => {
      const { project } = projectOf(ctx, params.id as string, 'editor');
      const name = text(await ctx.json(), 'name', 100);
      store.run(`UPDATE file_projects SET name = ? WHERE id = ?`, name, project.id);
      return projectDto({ ...project, name });
    }),

    route('DELETE', '/api/projects/:id', (ctx, params) => {
      const { project } = projectOf(ctx, params.id as string, 'editor');
      // Its files stay in the workspace, at its root.
      store.run(`DELETE FROM file_projects WHERE id = ?`, project.id);
      return {};
    }),

    // ---- files

    route('GET', '/api/workspaces/:id/files', (ctx, params) => {
      const { workspace } = workspaceOf(ctx, params.id as string);
      return listed(store.docsInWorkspace(workspace.id), ctx.who);
    }),

    route('POST', '/api/documents/:id/move', async (ctx, params) => {
      const { doc, role } = docOf(ctx, params.id as string);
      const user = requireUser(ctx);
      if (!canEdit(role)) throw new HttpError(403, 'Viewers cannot move the file');
      const body = await ctx.json();
      if (body.workspaceId !== undefined && typeof body.workspaceId !== 'string') throw new HttpError(400, 'workspaceId must be a workspace ID');
      const target = (body.workspaceId as string | undefined) ?? doc.workspace_id;
      const { workspace } = workspaceOf(ctx, target, 'editor');
      if (workspace.id !== doc.workspace_id) {
        // Taking a file out of a workspace takes it from its members: an editor there, or the file's owner, may.
        const held = store.workspaceRole(doc.workspace_id, user.id);
        if (role !== 'owner' && !canEdit(held)) throw new HttpError(403, 'Only an editor of its workspace can move the file elsewhere');
      }
      const projectId = projectIn(workspace.id, body.projectId);
      store.tx(() => {
        if (workspace.id !== doc.workspace_id) store.run(`UPDATE documents SET workspace_id = ? WHERE id = ?`, workspace.id, doc.id);
        placeInProject(doc.id, projectId);
      });
      if (workspace.id !== doc.workspace_id) hub.recheck([doc.id]);
      return fileInfo(store.docById(doc.id) as DocRow, ctx.who);
    }),

    route('POST', '/api/documents/:id/duplicate', async (ctx, params) => {
      const { doc } = docOf(ctx, params.id as string);
      requireUser(ctx);
      const body = await ctx.json();
      if (body.workspaceId !== undefined && typeof body.workspaceId !== 'string') throw new HttpError(400, 'workspaceId must be a workspace ID');
      const target = (body.workspaceId as string | undefined) ?? doc.workspace_id;
      const { workspace, user } = workspaceOf(ctx, target, 'editor');
      const name = optionalText(body, 'name', 200) ?? `${doc.name} copy`.slice(0, 200);
      const sameProject = store.one<{ project_id: string }>(`SELECT project_id FROM file_project_docs WHERE doc_id = ?`, doc.id);
      const projectId = body.projectId !== undefined ? projectIn(workspace.id, body.projectId) : workspace.id === doc.workspace_id ? (sameProject?.project_id ?? null) : null;
      const copy = store.createDoc(workspace.id, name, user.id, snapshot(doc.id));
      const rows = store.all<{ hash: string; content_type: string; size: number }>(`SELECT hash, content_type, size FROM assets WHERE doc_id = ?`, doc.id);
      copyAssetsBetween((hash) => store.assetPath(doc.id, hash), rows, copy.id);
      placeInProject(copy.id, projectId);
      return new Reply(201, fileInfo(store.docById(copy.id) as DocRow, ctx.who));
    }),

    // ---- the trash

    // Moving a file to the trash is in api.ts (POST /api/documents/:id/trash and DELETE /api/documents/:id).

    route('GET', '/api/workspaces/:id/trash', (ctx, params) => {
      const { workspace, role, user } = workspaceOf(ctx, params.id as string);
      purgeTrash(store);
      return store
        .all<TrashRow & { name: string; owner_id: string }>(
          `SELECT t.*, d.name, d.owner_id FROM file_trash t JOIN documents d ON d.id = t.doc_id WHERE t.workspace_id = ? ORDER BY t.trashed_at DESC`,
          workspace.id,
        )
        .map((row): TrashedFile => ({
          id: row.doc_id,
          name: row.name,
          workspaceId: row.workspace_id,
          owner: store.ref(row.owner_id),
          trashedBy: store.ref(row.trashed_by),
          trashedAt: new Date(Number(row.trashed_at)).toISOString(),
          purgeAt: new Date(Number(row.trashed_at) + TRASH_DAYS * DAY_MS).toISOString(),
          canDelete: role === 'owner' || row.trashed_by === user.id || row.owner_id === user.id,
        }));
    }),

    route('POST', '/api/trash/:docId/restore', (ctx, params) => {
      const { row, doc } = trashRowOf(ctx, params.docId as string, 'editor');
      const stashed = JSON.parse(row.members) as {
        members: { user_id: string; role: Role; created_at: string }[];
        invites: { email: string; role: Role; invited_by: string; created_at: string }[];
      };
      store.tx(() => {
        store.run(`UPDATE documents SET workspace_id = ?, link_access = ? WHERE id = ?`, row.workspace_id, row.link_access, doc.id);
        for (const member of stashed.members)
          if (store.userById(member.user_id))
            store.run(`INSERT OR IGNORE INTO document_members (doc_id, user_id, role, created_at) VALUES (?, ?, ?, ?)`, doc.id, member.user_id, member.role, member.created_at);
        for (const invite of stashed.invites)
          store.run(
            `INSERT OR IGNORE INTO document_invites (doc_id, email, role, invited_by, created_at) VALUES (?, ?, ?, ?, ?)`,
            doc.id,
            invite.email,
            invite.role,
            invite.invited_by,
            invite.created_at,
          );
        store.run(`DELETE FROM file_trash WHERE doc_id = ?`, doc.id);
      });
      hub.recheck([doc.id]);
      return fileInfo(store.docById(doc.id) as DocRow, ctx.who);
    }),

    route('DELETE', '/api/trash/:docId', (ctx, params) => {
      const { row, doc, role, user } = trashRowOf(ctx, params.docId as string, 'viewer');
      if (role !== 'owner' && row.trashed_by !== user.id && doc.owner_id !== user.id)
        throw new HttpError(403, 'Only a workspace owner, the file’s owner or whoever deleted it can delete it for good');
      store.deleteDoc(doc.id);
      return {};
    }),

    // ---- favourites, recents, search

    route('GET', '/api/favorites', (ctx) => {
      const user = requireUser(ctx);
      const docs = store.all<DocRow>(
        `SELECT d.* FROM file_favorites f JOIN documents d ON d.id = f.doc_id WHERE f.user_id = ? ORDER BY f.created_at DESC, f.rowid DESC`,
        user.id,
      );
      return openable(docs, ctx.who).map((doc) => fileInfo(doc, ctx.who));
    }),

    route('PUT', '/api/favorites/:docId', (ctx, params) => {
      const user = requireUser(ctx);
      const { doc } = docOf(ctx, params.docId as string);
      store.run(`INSERT OR IGNORE INTO file_favorites (user_id, doc_id, created_at) VALUES (?, ?, ?)`, user.id, doc.id, now());
      return {};
    }),

    route('DELETE', '/api/favorites/:docId', (ctx, params) => {
      const user = requireUser(ctx);
      store.run(`DELETE FROM file_favorites WHERE user_id = ? AND doc_id = ?`, user.id, params.docId as string);
      return {};
    }),

    route('GET', '/api/recents', (ctx) => {
      const user = requireUser(ctx);
      const docs = store.all<DocRow>(
        `SELECT d.* FROM file_recents r JOIN documents d ON d.id = r.doc_id WHERE r.user_id = ? ORDER BY r.opened_at DESC, r.rowid DESC LIMIT 60`,
        user.id,
      );
      return openable(docs, ctx.who)
        .slice(0, 30)
        .map((doc) => fileInfo(doc, ctx.who));
    }),

    route('POST', '/api/recents/:docId', (ctx, params) => {
      const user = requireUser(ctx);
      const { doc } = docOf(ctx, params.docId as string);
      store.tx(() => {
        store.run(
          `INSERT INTO file_recents (user_id, doc_id, opened_at) VALUES (?, ?, ?) ON CONFLICT(user_id, doc_id) DO UPDATE SET opened_at = excluded.opened_at`,
          user.id,
          doc.id,
          now(),
        );
        store.run(
          `DELETE FROM file_recents WHERE user_id = ? AND doc_id NOT IN (SELECT doc_id FROM file_recents WHERE user_id = ? ORDER BY opened_at DESC LIMIT ?)`,
          user.id,
          user.id,
          MAX_RECENTS,
        );
      });
      return {};
    }),

    route('GET', '/api/files/search', (ctx) => {
      const user = requireUser(ctx);
      const q = (query(ctx).get('q') ?? '').trim().toLowerCase().slice(0, 200);
      if (!q) return [];
      const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      const docs = store.all<DocRow>(
        `SELECT d.* FROM documents d
         WHERE d.workspace_id != ? AND lower(d.name) LIKE ? ESCAPE '\\'
           AND (EXISTS (SELECT 1 FROM workspace_members w WHERE w.workspace_id = d.workspace_id AND w.user_id = ?)
             OR EXISTS (SELECT 1 FROM document_members m WHERE m.doc_id = d.id AND m.user_id = ?))
         ORDER BY d.updated_at DESC, d.rowid DESC LIMIT 100`,
        TRASH_WORKSPACE,
        like,
        user.id,
        user.id,
      );
      return listed(docs, ctx.who);
    }),
  ];
};
