import type { Document } from '../../core';
import type { UserRef } from '../../collab/protocol';
import { documentFromVersion, versionLabel, type VersionKind, type VersionsApi } from '../../collab/versions';
import type { LocalVersionStore } from '../../persistence/versions';
import type { EditorStore } from '../../state/editorStore';

/**
 * Where the open file's versions are: on this device (IndexedDB) or on the
 * collaboration server. The history panel and the comparison work with
 * either through this one shape.
 */

export interface VersionEntry {
  id: string;
  kind: VersionKind;
  name: string;
  description: string;
  createdAt: string;
  /** Who made it; null for automatic versions and for files on this device. */
  author: UserRef | null;
}

export interface VersionSource {
  kind: 'local' | 'shared';
  list(): Promise<VersionEntry[]>;
  /** The document a version holds. */
  content(entry: VersionEntry): Promise<Document>;
  create(name: string, description: string): Promise<VersionEntry>;
  update(id: string, changes: { name?: string; description?: string }): Promise<VersionEntry>;
  remove(id: string): Promise<void>;
  /** Makes the file equal to the version again. Resolves with what to tell the person. */
  restore(entry: VersionEntry): Promise<string>;
}

/**
 * The document a local version is restored as: the version's layers, styles
 * and variables, under the file's own ID and name, keeping every image the
 * file knows (the asset table only grows, so undoing never misses one).
 */
export function restoredDocument(current: Document, version: Document): Document {
  return { ...version, id: current.id, name: current.name, assets: { ...version.assets, ...current.assets } };
}

/** A file on this device: versions in IndexedDB, restored as one step of the editor's undo history. */
export function localSource(store: EditorStore, versions: LocalVersionStore): VersionSource {
  const fileId = (): string => store.getState().doc.id;
  const entry = (version: Awaited<ReturnType<LocalVersionStore['list']>>[number]): VersionEntry => ({
    id: version.id,
    kind: version.kind,
    name: version.name,
    description: version.description,
    createdAt: version.createdAt,
    author: null,
  });
  /** The open document, with text being typed made part of it. */
  const currentDoc = (): Document => {
    const state = store.getState();
    if (state.editingTextId !== null) state.commitGesture('Edit text');
    return store.getState().doc;
  };
  return {
    kind: 'local',
    list: async () => (await versions.list(fileId())).map(entry),
    async content(version) {
      const doc = await versions.content(version.id);
      if (!doc) throw new Error('This version is no longer kept.');
      return doc;
    },
    create: async (name, description) => entry(await versions.add(fileId(), currentDoc(), { kind: 'named', name, description })),
    update: async (id, changes) => entry(await versions.update(id, changes)),
    remove: (id) => versions.remove(id),
    async restore(version) {
      const doc = await versions.content(version.id);
      if (!doc) throw new Error('This version is no longer kept.');
      const current = currentDoc();
      // What there was is kept first, so the restore can also be undone from the history later.
      await versions.add(fileId(), current, { kind: 'named', name: `Before restoring ${versionLabel(version)}` });
      if (store.getState().readOnly) throw new Error('This file cannot be changed here.');
      store.getState().apply('Restore version', (now) => restoredDocument(now, doc));
      return `Restored “${versionLabel(version)}”. Undo (Ctrl+Z) puts the file back as it was.`;
    },
  };
}

/** A shared file: versions on the collaboration server; a restore reaches everyone as ordinary changes. */
export function sharedSource(docId: string, api: VersionsApi, docName: () => string): VersionSource {
  const entry = (version: Awaited<ReturnType<VersionsApi['listVersions']>>[number]): VersionEntry => ({
    id: version.id,
    kind: version.kind,
    name: version.name,
    description: version.description,
    createdAt: version.createdAt,
    author: version.author,
  });
  return {
    kind: 'shared',
    list: async () => (await api.listVersions(docId)).map(entry),
    async content(version) {
      const { registers } = await api.getVersion(docId, version.id);
      return documentFromVersion(registers, { id: docId, name: docName() });
    },
    create: async (name, description) => entry(await api.createVersion(docId, name, description)),
    update: async (id, changes) => entry(await api.updateVersion(docId, id, changes)),
    remove: async (id) => {
      await api.deleteVersion(docId, id);
    },
    async restore(version) {
      const result = await api.restoreVersion(docId, version.id);
      return `Restored “${versionLabel(version)}” for everyone (${result.changed} ${result.changed === 1 ? 'change' : 'changes'}). To undo it, restore “${result.before.name}”.`;
    },
  };
}
