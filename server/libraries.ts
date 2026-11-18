/**
 * Team libraries: the shared documents that are published as libraries, for
 * the files that use them. Built on the API through its extension hook
 * (`ApiExtension` in api.ts). It needs no tables of its own: what a document
 * publishes is its `d:publication` register (`Publication` in
 * src/core/document/schema.ts), which editors set and clear through the live
 * connection like any other register. There is no publish route.
 *
 * Routes (JSON under /api):
 * - GET /api/libraries?workspace=<id>  -> {libraries: LibrarySummary[], truncated?: true}  (an account or a guest)
 * - GET /api/documents/:id/library     -> {id, name, publication}        (anyone who can open the document)
 *
 * The images a publication uses are downloaded with the document's own image
 * route, `GET /api/documents/:id/assets/:hash`, with the same access.
 *
 * Who sees what. The list holds the published documents the person can open
 * through their own membership of the document or of its workspace (the same
 * rule as file search), not in the trash, and no branches (a branch carries a
 * copy of its main file's publication). Every row is checked again with the
 * store's own `roleOn`. A document someone can open only through its link is
 * not listed: a link is shared by handing it over, and listing such documents
 * would show every link-shared library on the server to anyone who asks (a
 * guest pass is free). So a guest's list is empty; a guest, or anyone, opens a
 * library they were given the link of with `GET /api/documents/:id/library`,
 * which follows the document routes exactly (link access included; 410 for a
 * file in the trash to whoever could open it before).
 *
 * Reading is cheap: the list reads only the documents the person can reach and
 * the sequence number of their `d:publication` register, never its value (a
 * publication can be many megabytes, and the database is read synchronously,
 * so reading every value would hold up the whole server). Whether a document
 * is published, and the counts in its row, are worked out from the value once
 * per change of that register (it has a new sequence number each time) and
 * kept in memory.
 *
 * Every candidate is sorted in the order the response shows before the list is
 * cut to libraryLimits.libraries, so what is kept is always the first of that order; the
 * response then says `truncated: true`, and the app asks for the libraries
 * a file uses that are missing one by one.
 */
import type { ApiExtension } from './api.ts';
import { TRASH_WORKSPACE, type DocRow } from './store.ts';

/** The register that holds what a document publishes. */
export const PUBLICATION_KEY = 'd:publication';

/** The limits of one list (an object so that tests can lower them). */
export const libraryLimits = {
  /** At most this many libraries in one list: the first of the response's order. */
  libraries: 500,
  /**
   * A hard limit on the documents read for one list (published or not) before
   * access, branches and publishing are checked: only a safety cap, far above
   * what a person reaches. Past it the list is marked `truncated` too.
   */
  candidates: 20000,
};

/** Publication summaries kept in memory (by document and register sequence number). */
const MAX_CACHED = 5000;

/** One row of GET /api/libraries. */
export interface LibrarySummary {
  /** The library's document ID. */
  id: string;
  name: string;
  /** The document's workspace, or null when the person is not a member of it (they reach the document through its own members). */
  workspaceId: string | null;
  workspaceName: string | null;
  version: number;
  publishedAt: string;
  components: number;
  styles: number;
  variables: number;
}

export interface PublicationSummary {
  version: number;
  publishedAt: string;
  components: number;
  styles: number;
  variables: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * What the list says about a publication: its version, when it was published
 * and how many components, styles and variables it has (the same counting as
 * the app's `publishCounts`: every node of kind COMPONENT, so each variant of
 * a set counts). Null when the value is not a publication (not published, or
 * unpublished: the register is null). Values an editor sent in another shape
 * count as 0 or empty rather than failing.
 */
export function summarizePublication(value: unknown): PublicationSummary | null {
  if (!isObject(value)) return null;
  const version = typeof value.version === 'number' && Number.isFinite(value.version) ? value.version : 0;
  const publishedAt = typeof value.publishedAt === 'string' ? value.publishedAt.slice(0, 64) : '';
  let components = 0;
  if (isObject(value.nodes)) {
    for (const id in value.nodes) {
      const node = value.nodes[id];
      if (isObject(node) && node.kind === 'COMPONENT') components++;
    }
  }
  const styles = isObject(value.styles) ? Object.keys(value.styles).length : 0;
  const variables = isObject(value.variables) ? Object.keys(value.variables).length : 0;
  return { version, publishedAt, components, styles, variables };
}

/** Case-insensitive order for names, then a fixed order for equal ones. */
export function compareLibraries(a: LibrarySummary, b: LibrarySummary): number {
  // Libraries outside the person's workspaces (shared with them directly) come last.
  if ((a.workspaceName === null) !== (b.workspaceName === null)) return a.workspaceName === null ? 1 : -1;
  const byWorkspace = (a.workspaceName ?? '').toLowerCase().localeCompare((b.workspaceName ?? '').toLowerCase(), 'en');
  if (byWorkspace !== 0) return byWorkspace;
  const byName = a.name.toLowerCase().localeCompare(b.name.toLowerCase(), 'en');
  if (byName !== 0) return byName;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

interface CandidateRow extends DocRow {
  publication_seq: number;
  member_workspace_name: string | null;
}

export const extension: ApiExtension = (kit) => {
  const { store, route, HttpError, docOf, requirePerson, workspaceOf } = kit;

  // Summaries by "<docId> <register seq>": a register's sequence number changes with every change to it.
  const cache = new Map<string, PublicationSummary | null>();

  function summaryOf(docId: string, seq: number): PublicationSummary | null {
    const key = `${docId} ${seq}`;
    if (cache.has(key)) return cache.get(key) as PublicationSummary | null;
    const held = store.register(docId, PUBLICATION_KEY);
    // Changed since the list was read: summarised as it is now, but not kept under the old number.
    const summary = summarizePublication(held?.v);
    if (held && held.s === seq) {
      if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value as string);
      cache.set(key, summary);
    }
    return summary;
  }

  /**
   * The documents with a publication register (published or since unpublished) a signed-in person reaches through the workspaces
   * they are in and the documents they are a member of, optionally in one
   * workspace, with the workspace's name when they are a member of it.
   * The register is read through the small index of publication registers
   * (registers_publication in store.ts, which names the key as a literal):
   * it holds the sequence number, so the publication itself stays on disk.
   * Through the table, reaching the sequence number means reading past the
   * whole value, which is what made the list slow.
   */
  function candidates(userId: string, workspaceId: string | null): CandidateRow[] {
    return store.all<CandidateRow>(
      `WITH reachable(doc_id) AS (
         SELECT d.id FROM workspace_members wm JOIN documents d ON d.workspace_id = wm.workspace_id WHERE wm.user_id = ?
         UNION
         SELECT m.doc_id FROM document_members m WHERE m.user_id = ?
       )
       SELECT d.*, r.seq AS publication_seq,
         CASE WHEN EXISTS (SELECT 1 FROM workspace_members x WHERE x.workspace_id = d.workspace_id AND x.user_id = ?) THEN w.name END AS member_workspace_name
       FROM reachable
       JOIN documents d ON d.id = reachable.doc_id
       JOIN registers r INDEXED BY registers_publication ON r.doc_id = d.id AND r.key = 'd:publication'
       LEFT JOIN workspaces w ON w.id = d.workspace_id
       WHERE d.workspace_id != ? AND (? IS NULL OR d.workspace_id = ?)
       ORDER BY d.id
       LIMIT ?`,
      userId,
      userId,
      userId,
      TRASH_WORKSPACE,
      workspaceId,
      workspaceId,
      libraryLimits.candidates + 1,
    );
  }

  return [
    route('GET', '/api/libraries', (ctx) => {
      if (ctx.stale) throw new HttpError(401, ctx.stale);
      requirePerson(ctx);
      const wanted = new URL(ctx.req.url ?? '/', 'http://localhost').searchParams.get('workspace');
      // Guests reach documents only through links, which are not listed (see the header).
      if (ctx.who.kind !== 'user') {
        if (wanted) throw new HttpError(401, 'Sign in to list a workspace');
        return { libraries: [] };
      }
      const user = ctx.who.user;
      // Someone outside the workspace is told it does not exist, as on the workspace routes.
      const workspaceId = wanted ? workspaceOf(ctx, wanted).workspace.id : null;
      const libraries: LibrarySummary[] = [];
      const rows = candidates(user.id, workspaceId);
      let truncated = rows.length > libraryLimits.candidates;
      for (const row of rows.slice(0, libraryLimits.candidates)) {
        if (store.roleOn(row, ctx.who) === null || store.hiddenInLists(row.id)) continue;
        // Not published (the register was cleared): known from the cached summary, read once per change.
        const summary = summaryOf(row.id, Number(row.publication_seq));
        if (!summary) continue;
        const member = row.member_workspace_name !== null;
        libraries.push({
          id: row.id,
          name: row.name,
          workspaceId: member ? row.workspace_id : null,
          workspaceName: row.member_workspace_name,
          ...summary,
        });
      }
      libraries.sort(compareLibraries);
      if (libraries.length > libraryLimits.libraries) {
        libraries.length = libraryLimits.libraries;
        truncated = true;
      }
      return truncated ? { libraries, truncated: true } : { libraries };
    }),

    route('GET', '/api/documents/:id/library', (ctx, params) => {
      const { doc } = docOf(ctx, params.id as string);
      const held = store.register(doc.id, PUBLICATION_KEY);
      if (!held || summarizePublication(held.v) === null) throw new HttpError(404, 'This file is not published as a library');
      return { id: doc.id, name: doc.name, publication: held.v };
    }),
  ];
};
