import { diffDocuments, getPages, type DesignNode, type Document, type NodeId } from '../core';
import { currentAuth, type Auth } from './account';
import { ApiError } from './api';
import { API_BASE, parseKey, type DocInfo, type Register, type Role, type UserRef } from './protocol';
import { documentFromRegisters } from './registers';
import type { VersionKind } from '../persistence/versions';

/**
 * Version history and branching, for the app: a typed client for the
 * server's routes (`server/versions.ts`), and the pure helpers the version
 * history panel, the comparison and the merge review are built on.
 *
 * The routes (JSON under /api; errors are a status and `{ error }`):
 * - GET    /documents/:id/versions                     -> VersionInfo[] newest first   (anyone who can open it)
 * - POST   /documents/:id/versions  {name, description?} -> VersionInfo (201)          (owner, editor)
 * - GET    /documents/:id/versions/:vid                -> {version, registers}          (anyone who can open it)
 * - PATCH  /documents/:id/versions/:vid {name?, description?} -> VersionInfo           (owner, editor)
 * - DELETE /documents/:id/versions/:vid                -> {}                            (owner, editor)
 * - POST   /documents/:id/versions/:vid/restore        -> {seq, changed, before}        (owner, editor)
 * - GET    /workspaces/:id/deleted-documents           -> DeletedDocument[]             (workspace owner, editor)
 * - POST   /workspaces/:id/deleted-documents/:docId/recover -> DocInfo (201)           (workspace owner, editor)
 * - DELETE /workspaces/:id/deleted-documents/:docId    -> {}                            (workspace owner)
 * - POST   /documents/:id/branches  {name}             -> BranchInfo (201)              (owner, editor of main; an account)
 * - GET    /documents/:id/branches                     -> (BranchInfo & {role})[]       (anyone who can open main)
 * - GET    /documents/:id/branch                       -> {branch: BranchInfo | null}
 * - GET    /documents/:id/update-from-main             -> UpdatePreview
 * - POST   /documents/:id/update-from-main {resolutions} -> {seq, applied, baseSeq}     (owner, editor of the branch)
 * - GET    /documents/:id/merge                        -> MergePreview
 * - POST   /documents/:id/merge {resolutions}          -> MergeResult                   (owner, editor of main)
 */

// ------------------------------------------------------------------ what the server sends

export type { VersionKind };

export interface VersionInfo {
  id: string;
  docId: string;
  kind: VersionKind;
  /** Empty for an automatic version. */
  name: string;
  description: string;
  seq: number;
  author: UserRef | null;
  createdAt: string;
}

export interface BranchInfo {
  id: string;
  name: string;
  mainId: string;
  mainName: string;
  status: 'open' | 'merged';
  baseSeq: number;
  createdBy: UserRef;
  createdAt: string;
  mergedAt: string | null;
  mergedBy: UserRef | null;
  /** In a list of a file's branches: the role of the person asking. */
  role?: Role | null;
}

export interface Conflict {
  key: string;
  base: unknown;
  main: unknown;
  branch: unknown;
}

export interface Change {
  key: string;
  base: unknown;
  value: unknown;
}

export type Resolution = 'main' | 'branch';

export interface UpdatePreview {
  mainSeq: number;
  baseSeq: number;
  changes: Change[];
  conflicts: Conflict[];
}

export interface MergePreview extends UpdatePreview {
  mainId: string;
  status: 'open' | 'merged';
  canMerge: boolean;
}

export interface MergeResult {
  mainSeq: number;
  applied: number;
  before: VersionInfo;
  after: VersionInfo;
  branch: BranchInfo;
}

export interface DeletedDocument {
  docId: string;
  name: string;
  versions: number;
  latestAt: string;
}

// ------------------------------------------------------------------ the client

export interface VersionsApiOptions {
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
  base?: string;
  auth?: () => Auth;
}

const enc = (value: string): string => encodeURIComponent(value);

export function createVersionsApi(options: VersionsApiOptions = {}) {
  const base = options.base ?? API_BASE;
  const auth = options.auth ?? currentAuth;
  const send = (input: string, init: RequestInit): Promise<Response> => (options.fetch ? options.fetch(input, init) : globalThis.fetch(input, init));

  async function json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    const { token, guestToken } = auth();
    if (token) headers.Authorization = `Bearer ${token}`;
    else if (guestToken) headers['X-Evora-Guest'] = guestToken;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let response: Response;
    try {
      response = await send(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      throw new ApiError('The collaboration server could not be reached. Check that it is running and that you are online.', 0);
    }
    const text = await response.text();
    let data: unknown = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      if (response.ok) throw new ApiError('The collaboration server sent an answer that could not be read.', response.status);
    }
    if (!response.ok) {
      const error = (data as { error?: unknown }).error;
      throw new ApiError(typeof error === 'string' && error ? error : `The collaboration server answered with an error (${response.status}).`, response.status);
    }
    return data as T;
  }

  return {
    listVersions: (docId: string) => json<VersionInfo[]>('GET', `/documents/${enc(docId)}/versions`),
    createVersion: (docId: string, name: string, description = '') => json<VersionInfo>('POST', `/documents/${enc(docId)}/versions`, { name, description }),
    getVersion: (docId: string, versionId: string) => json<{ version: VersionInfo; registers: Register[] }>('GET', `/documents/${enc(docId)}/versions/${enc(versionId)}`),
    updateVersion: (docId: string, versionId: string, changes: { name?: string; description?: string }) =>
      json<VersionInfo>('PATCH', `/documents/${enc(docId)}/versions/${enc(versionId)}`, changes),
    deleteVersion: (docId: string, versionId: string) => json<Record<string, never>>('DELETE', `/documents/${enc(docId)}/versions/${enc(versionId)}`),
    restoreVersion: (docId: string, versionId: string) =>
      json<{ seq: number; changed: number; before: VersionInfo }>('POST', `/documents/${enc(docId)}/versions/${enc(versionId)}/restore`),

    deletedDocuments: (workspaceId: string) => json<DeletedDocument[]>('GET', `/workspaces/${enc(workspaceId)}/deleted-documents`),
    recoverDocument: (workspaceId: string, docId: string) => json<DocInfo>('POST', `/workspaces/${enc(workspaceId)}/deleted-documents/${enc(docId)}/recover`),
    purgeDocument: (workspaceId: string, docId: string) => json<Record<string, never>>('DELETE', `/workspaces/${enc(workspaceId)}/deleted-documents/${enc(docId)}`),

    createBranch: (docId: string, name: string) => json<BranchInfo>('POST', `/documents/${enc(docId)}/branches`, { name }),
    listBranches: (docId: string) => json<BranchInfo[]>('GET', `/documents/${enc(docId)}/branches`),
    branchInfo: (docId: string) => json<{ branch: BranchInfo | null }>('GET', `/documents/${enc(docId)}/branch`).then((answer) => answer.branch),
    updatePreview: (branchId: string) => json<UpdatePreview>('GET', `/documents/${enc(branchId)}/update-from-main`),
    updateFromMain: (branchId: string, resolutions: Record<string, Resolution>) =>
      json<{ seq: number; applied: number; baseSeq: number }>('POST', `/documents/${enc(branchId)}/update-from-main`, { resolutions }),
    mergePreview: (branchId: string) => json<MergePreview>('GET', `/documents/${enc(branchId)}/merge`),
    merge: (branchId: string, resolutions: Record<string, Resolution>) => json<MergeResult>('POST', `/documents/${enc(branchId)}/merge`, { resolutions }),
    /** The whole of a shared document as registers (the existing snapshot route). */
    registers: (docId: string) => json<{ seq: number; registers: Register[] }>('GET', `/documents/${enc(docId)}/registers`),
  };
}

export type VersionsApi = ReturnType<typeof createVersionsApi>;

/** The client for this device's account or guest. */
export const versionsApi: VersionsApi = createVersionsApi();

/** A shared document as a version holds it. */
export function documentFromVersion(registers: Iterable<Register>, base: { id: string; name: string }): Document {
  return documentFromRegisters(registers, base);
}

// ------------------------------------------------------------------ the history list

/** Something versions have in common, on this device and on the server. */
export interface VersionLike {
  id: string;
  kind: VersionKind;
  name: string;
  createdAt: string;
}

export type HistoryItem<V extends VersionLike> = { type: 'named'; version: V } | { type: 'autos'; versions: V[] };

/**
 * The history as Figma shows it: named versions as entries of their own,
 * and the automatic ones between them grouped (expandable). Newest first.
 */
export function groupHistory<V extends VersionLike>(versions: readonly V[]): HistoryItem<V>[] {
  const sorted = [...versions].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const out: HistoryItem<V>[] = [];
  for (const version of sorted) {
    const last = out[out.length - 1];
    if (version.kind === 'named') out.push({ type: 'named', version });
    else if (last && last.type === 'autos') last.versions.push(version);
    else out.push({ type: 'autos', versions: [version] });
  }
  return out;
}

/** The label of a version: its name, or "Autosave". */
export function versionLabel(version: { kind: VersionKind; name: string }): string {
  return version.name || 'Autosave';
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** When, as the history list shows it: "Just now", "5 minutes ago", "Today at 14:05", "12 Nov 2026 at 09:30". */
export function versionTime(iso: string, now: number = Date.now()): string {
  const at = new Date(iso);
  const age = now - at.getTime();
  if (age < 60_000) return 'Just now';
  if (age < 60 * 60_000) {
    const minutes = Math.floor(age / 60_000);
    return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`;
  }
  const time = at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const today = new Date(now);
  if (at.toDateString() === today.toDateString()) return `Today at ${time}`;
  if (new Date(now - DAY_MS).toDateString() === at.toDateString()) return `Yesterday at ${time}`;
  return `${at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })} at ${time}`;
}

// ------------------------------------------------------------------ automatic versions

/** Thinning automatic versions out as they age (the rule is with this device's versions, the server keeps its own by it too). */
export { autoVersionsToDrop } from '../persistence/versions';

// ------------------------------------------------------------------ differences between two documents

export type LayerDiffKind = 'added' | 'removed' | 'changed';

/** One layer (or page) that differs between two documents. */
export interface LayerDiff {
  id: NodeId;
  kind: LayerDiffKind;
  name: string;
  type: string;
  /** The page it is on (in the document that has it; for a page, itself), or null. */
  pageId: NodeId | null;
  /** The properties that changed, for a changed layer, in a readable form ("Position", "Fill"…). */
  props: string[];
}

const PROP_LABELS: Record<string, string> = {
  x: 'Position',
  y: 'Position',
  width: 'Size',
  height: 'Size',
  rotation: 'Rotation',
  parentId: 'Parent',
  order: 'Layer order',
  name: 'Name',
  visible: 'Visibility',
  locked: 'Lock',
  opacity: 'Opacity',
  blendMode: 'Blend mode',
  fills: 'Fill',
  strokes: 'Stroke',
  strokeWeight: 'Stroke',
  effects: 'Effects',
  characters: 'Text',
  cornerRadius: 'Corner radius',
  constraints: 'Constraints',
  layoutMode: 'Auto layout',
};

/** A readable name for a property of a layer. */
export function propertyLabel(prop: string): string {
  const known = PROP_LABELS[prop];
  if (known) return known;
  const words = prop.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function pageOf(doc: Document, id: NodeId): NodeId | null {
  let node: DesignNode | undefined = doc.nodes[id];
  for (let step = 0; node && step < 10_000; step++) {
    if (node.type === 'PAGE') return node.id;
    node = node.parentId === null ? undefined : doc.nodes[node.parentId];
  }
  return null;
}

/**
 * The layers that differ between two documents (`before` the older or main
 * side, `after` the newer or branch side): added, removed and changed, with
 * what changed. Pages first, then in the order of the pages and their names.
 * Built on the history's `diffDocuments`, so it says what an undo step would.
 */
export function diffList(before: Document, after: Document): LayerDiff[] {
  const patch = diffDocuments(before, after);
  if (!patch) return [];
  const out: LayerDiff[] = [];
  for (const id in patch.nodes) {
    const change = patch.nodes[id];
    if (!change) continue;
    const old = before.nodes[id];
    const now = after.nodes[id];
    if (!change.before && now) out.push({ id, kind: 'added', name: now.name, type: now.type, pageId: pageOf(after, id), props: [] });
    else if (!change.after && old) out.push({ id, kind: 'removed', name: old.name, type: old.type, pageId: pageOf(before, id), props: [] });
    else if (now && change.after) {
      const props = [...new Set(Object.keys(change.after).map(propertyLabel))];
      out.push({ id, kind: 'changed', name: now.name, type: now.type, pageId: pageOf(after, id) ?? pageOf(before, id), props });
    }
  }
  const pageOrder = new Map<NodeId, number>();
  [...getPages(before), ...getPages(after)].forEach((page) => {
    if (!pageOrder.has(page.id)) pageOrder.set(page.id, pageOrder.size);
  });
  const rank = (diff: LayerDiff): number => (diff.type === 'PAGE' ? -1 : (pageOrder.get(diff.pageId ?? '') ?? 1e6));
  return out.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/** How many layers were added, removed and changed. */
export function diffCounts(diffs: readonly LayerDiff[]): Record<LayerDiffKind, number> {
  const counts: Record<LayerDiffKind, number> = { added: 0, removed: 0, changed: 0 };
  for (const diff of diffs) counts[diff.kind]++;
  return counts;
}

// ------------------------------------------------------------------ conflicts, by layer

/** The conflicts of one layer (or of something else in the document), resolved together. */
export interface ConflictGroup {
  /** The node's ID, or the register key for something that is not a node. */
  id: string;
  label: string;
  /** What changed, readable. */
  props: string[];
  keys: string[];
}

/** Groups register conflicts by the layer they are on, so a choice is made per layer, as in Figma. */
export function groupConflicts(conflicts: readonly Conflict[], mainDoc: Document | null, branchDoc: Document | null): ConflictGroup[] {
  const groups = new Map<string, ConflictGroup>();
  for (const conflict of conflicts) {
    const parsed = parseKey(conflict.key);
    let id = conflict.key;
    let label = conflict.key;
    let prop = 'Value';
    if (parsed.kind === 'node') {
      id = parsed.nodeId;
      const node = branchDoc?.nodes[parsed.nodeId] ?? mainDoc?.nodes[parsed.nodeId];
      label = node?.name ?? 'A layer';
      prop = parsed.prop === '@' ? 'Deleted or kept' : propertyLabel(parsed.prop);
    } else if (parsed.kind === 'table') {
      const names = { styles: 'Style', variables: 'Variable', variableCollections: 'Variable collection' } as const;
      const entry = (branchDoc?.[parsed.table] as Record<string, { name?: string }> | undefined)?.[parsed.id] ?? (mainDoc?.[parsed.table] as Record<string, { name?: string }> | undefined)?.[parsed.id];
      label = `${names[parsed.table]} ${entry?.name ? `“${entry.name}”` : ''}`.trim();
      prop = 'Definition';
    } else if (parsed.kind === 'doc') {
      label = parsed.field === 'publication' ? 'Library publication' : 'File name';
    }
    const group = groups.get(id) ?? { id, label, props: [], keys: [] };
    if (!group.props.includes(prop)) group.props.push(prop);
    group.keys.push(conflict.key);
    groups.set(id, group);
  }
  return [...groups.values()];
}

/** Turns a choice per conflict group into a choice per register, as the server takes them. */
export function resolutionsFor(groups: readonly ConflictGroup[], choices: Readonly<Record<string, Resolution>>): Record<string, Resolution> {
  const out: Record<string, Resolution> = {};
  for (const group of groups) {
    const choice = choices[group.id];
    if (choice) for (const key of group.keys) out[key] = choice;
  }
  return out;
}

/** The IDs of the nodes some registers are about. */
export function nodesIn(keys: Iterable<string>): Set<NodeId> {
  const out = new Set<NodeId>();
  for (const key of keys) {
    const parsed = parseKey(key);
    if (parsed.kind === 'node') out.add(parsed.nodeId);
  }
  return out;
}
