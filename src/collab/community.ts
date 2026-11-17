import { createId, toFile, type Document } from '../core';
import type { DocumentStorage } from '../persistence/storage';
import { ApiError, type ApiOptions } from './api';
import { createRequester, type FileInfo } from './files';
import { makeClock, newClientId, type ClockState, type Register, type UserRef } from './protocol';
import { documentFromRegisters, registersFromDocument } from './registers';

/**
 * The community resource library (Phase 9, spec §24): design files,
 * templates, UI kits, component libraries and icon libraries people publish,
 * free for everyone. Browsing and taking a copy need no account; publishing
 * and duplicating into a workspace need one. The routes are listed in
 * `server/community.ts`.
 */

export const RESOURCE_KINDS = ['file', 'template', 'ui-kit', 'components', 'icons'] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

export const KIND_LABELS: Record<ResourceKind, string> = {
  file: 'Design file',
  template: 'Template',
  'ui-kit': 'UI kit',
  components: 'Component library',
  icons: 'Icon library',
};

export interface ResourceSummary {
  id: string;
  kind: ResourceKind;
  title: string;
  description: string;
  tags: string[];
  author: UserRef;
  coverAt: string | null;
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
  assets: { hash: string; contentType: string }[];
}

export interface BrowseQuery {
  q?: string;
  kind?: ResourceKind | null;
  tag?: string | null;
  sort?: 'newest' | 'popular';
  limit?: number;
  offset?: number;
}

export interface PublishFields {
  kind?: ResourceKind;
  title?: string;
  description?: string;
  tags?: string[];
  notes?: string;
}

export interface PublishResult {
  resource: ResourceDetail;
  version: number;
  created: boolean;
}

/** A plugin or widget in the directory (GET /api/plugins/directory, served by the plugins part of the server). */
export interface DirectoryEntry {
  id: string;
  name: string;
  description: string;
  version: string;
  kind: string;
  author: { id: string; name: string };
  installs: number;
  updatedAt: string;
}

const id = (value: string): string => encodeURIComponent(value);

export function createCommunityApi(options: ApiOptions = {}) {
  const { base, raw, json } = createRequester(options);

  return {
    browse: (query: BrowseQuery = {}) => {
      const params = new URLSearchParams();
      if (query.q?.trim()) params.set('q', query.q.trim());
      if (query.kind) params.set('kind', query.kind);
      if (query.tag) params.set('tag', query.tag);
      if (query.sort && query.sort !== 'newest') params.set('sort', query.sort);
      if (query.limit) params.set('limit', String(query.limit));
      if (query.offset) params.set('offset', String(query.offset));
      const search = params.toString();
      return json<{ items: ResourceSummary[]; total: number }>('GET', `/community/resources${search ? `?${search}` : ''}`);
    },
    tags: () => json<{ tag: string; count: number }[]>('GET', '/community/tags'),
    resource: (resourceId: string) => json<ResourceDetail>('GET', `/community/resources/${id(resourceId)}`),
    mine: () => json<ResourceSummary[]>('GET', '/community/mine'),
    /** Publishes a shared file; publishing the same file again makes a new version. */
    publishDocument: (docId: string, fields: PublishFields) => json<PublishResult>('POST', '/community/resources', { docId, ...fields }),
    /** Publishes a file from this device, as registers; its images are uploaded with `putAsset` next. */
    publishRegisters: (sourceId: string, registers: Register[], fields: PublishFields) => json<PublishResult>('POST', '/community/resources', { sourceId, registers, ...fields }),
    update: (resourceId: string, fields: Omit<PublishFields, 'notes'>) => json<ResourceDetail>('PATCH', `/community/resources/${id(resourceId)}`, fields),
    unpublish: (resourceId: string) => json<Record<string, never>>('DELETE', `/community/resources/${id(resourceId)}`),
    putCover: async (resourceId: string, bytes: Uint8Array, mimeType: string): Promise<void> => {
      await raw('PUT', `/community/resources/${id(resourceId)}/cover`, { body: bytes as BodyInit, contentType: mimeType });
    },
    putAsset: async (resourceId: string, hash: string, bytes: ArrayBuffer | Uint8Array, mimeType: string): Promise<void> => {
      await raw('PUT', `/community/resources/${id(resourceId)}/assets/${id(hash)}`, { body: bytes as BodyInit, contentType: mimeType });
    },
    getAsset: async (resourceId: string, hash: string): Promise<{ mimeType: string; bytes: ArrayBuffer }> => {
      const response = await raw('GET', `/community/resources/${id(resourceId)}/assets/${id(hash)}`);
      return { mimeType: response.headers.get('Content-Type') ?? 'application/octet-stream', bytes: await response.arrayBuffer() };
    },
    version: (resourceId: string, number: number) => json<VersionContent>('GET', `/community/resources/${id(resourceId)}/versions/${number}`),
    /** A version's content to keep on this device (counted as a duplicate; no account needed). */
    copy: (resourceId: string, version?: number) => json<VersionContent>('POST', `/community/resources/${id(resourceId)}/copies`, version ? { version } : {}),
    /** A new shared file in a workspace, made from a version (the latest unless one is chosen), with its images. */
    duplicate: (resourceId: string, workspaceId: string, version?: number, projectId?: string | null) =>
      json<FileInfo>('POST', `/community/resources/${id(resourceId)}/duplicate`, { workspaceId, ...(version ? { version } : {}), ...(projectId ? { projectId } : {}) }),
    /** The cover picture's address, or null when there is none. */
    coverUrl: (resource: Pick<ResourceSummary, 'id' | 'coverAt'>): string | null =>
      resource.coverAt ? `${base}/community/resources/${id(resource.id)}/cover?v=${encodeURIComponent(resource.coverAt)}` : null,
    /**
     * The plugins and widgets directory. Null when this server has none
     * (the endpoint is missing); an empty list when it has no entries.
     */
    pluginDirectory: async (q = '', kind = ''): Promise<DirectoryEntry[] | null> => {
      const params = new URLSearchParams();
      if (q.trim()) params.set('q', q.trim());
      if (kind) params.set('kind', kind);
      const search = params.toString();
      try {
        const list = await json<unknown>('GET', `/plugins/directory${search ? `?${search}` : ''}`);
        return Array.isArray(list) ? (list as DirectoryEntry[]) : [];
      } catch (error) {
        if (error instanceof ApiError && (error.status === 404 || error.status === 405)) return null;
        throw error;
      }
    },
  };
}

export type CommunityApi = ReturnType<typeof createCommunityApi>;

/** The client the application uses. */
export const communityApi: CommunityApi = createCommunityApi();

// ------------------------------------------------------------------ publishing and copying files

/** The source key a file of this device is published under. */
export function localSourceKey(fileId: string): string {
  return `local:${fileId}`;
}

export function docSourceKey(docId: string): string {
  return `doc:${docId}`;
}

/** Publishes a file of this device: its content as registers, then the bytes of every image it uses. */
export async function publishLocalDocument(
  api: CommunityApi,
  doc: Document,
  loadAsset: (hash: string) => Promise<{ mimeType: string; bytes: ArrayBuffer } | null>,
  fields: PublishFields,
): Promise<PublishResult> {
  const clock: ClockState = { last: makeClock(0, 0, ''), clientId: newClientId() };
  const result = await api.publishRegisters(doc.id, registersFromDocument(doc, clock), fields);
  for (const hash of Object.keys(doc.assets)) {
    const asset = await loadAsset(hash);
    if (asset) await api.putAsset(result.resource.id, hash, asset.bytes, asset.mimeType);
  }
  return result;
}

/** A version of a resource as a document (with a new ID), and the images it needs. */
export function documentOfVersion(content: VersionContent, name?: string): Document {
  const doc = documentFromRegisters(content.registers, { id: createId(), name: name ?? content.name });
  return { ...doc, name: name ?? content.name };
}

/**
 * Takes a copy of a resource's version and keeps it as a file on this device,
 * with its images. No account is needed. Answers with the new file's ID.
 */
export async function copyToDevice(api: CommunityApi, storage: DocumentStorage, resourceId: string, version?: number): Promise<string> {
  const content = await api.copy(resourceId, version);
  const doc = documentOfVersion(content);
  for (const asset of content.assets) {
    const got = await api.getAsset(resourceId, asset.hash);
    await storage.saveAsset(asset.hash, { mimeType: got.mimeType, bytes: got.bytes });
  }
  const at = new Date().toISOString();
  await storage.save(toFile(doc, { createdAt: at, updatedAt: at }));
  return doc.id;
}
