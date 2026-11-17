import { useEffect, useState, type FormEvent } from 'react';
import type { Document } from '../../core';
import { api as defaultApi, errorMessage, type EvoraApi } from '../../collab/api';
import {
  communityApi as defaultCommunity,
  docSourceKey,
  KIND_LABELS,
  localSourceKey,
  publishLocalDocument,
  RESOURCE_KINDS,
  type CommunityApi,
  type PublishFields,
  type ResourceKind,
  type ResourceSummary,
} from '../../collab/community';
import { documentFromRegisters } from '../../collab/registers';
import { openFile } from '../../persistence/files';
import type { DocumentStorage } from '../../persistence/storage';
import { AccountDialog } from '../collab/AccountDialog';
import { useAccount } from '../collab/hooks';
import { Dialog } from '../components/Dialog';
import { renderCover } from './cover';

/** What is published: a file on this device, or a shared file. */
export type PublishSource = { kind: 'local'; fileId: string; name: string } | { kind: 'shared'; docId: string; name: string };

interface PublishDialogProps {
  source: PublishSource;
  storage: DocumentStorage | null;
  onClose: () => void;
  /** Goes to a place in the app (the published resource's page). */
  onNavigate: (hash: string) => void;
  api?: EvoraApi;
  community?: CommunityApi;
  /** Makes the cover picture (tests give their own). */
  cover?: typeof renderCover;
}

type Loaded = { doc: Document; loadAsset: (hash: string) => Promise<{ mimeType: string; bytes: ArrayBuffer } | null> };

async function loadSource(source: PublishSource, storage: DocumentStorage | null, api: EvoraApi): Promise<Loaded> {
  if (source.kind === 'local') {
    if (!storage) throw new Error('The files on this device cannot be read here.');
    const opened = await openFile(storage, source.fileId);
    if (!opened) throw new Error('That file is no longer on this device.');
    return { doc: opened.doc, loadAsset: (hash) => storage.loadAsset(hash) };
  }
  const { registers } = await api.documentRegisters(source.docId);
  return {
    doc: documentFromRegisters(registers, { id: source.docId, name: source.name }),
    loadAsset: (hash) => api.getAsset(source.docId, hash).catch(() => null),
  };
}

/**
 * Publishing a file to the Community, free: what kind of resource it is, a
 * title, a description, tags, and (when it was published before) notes for
 * the new version. The cover is the file's first page, drawn by the app.
 */
export function PublishDialog({ source, storage, onClose, onNavigate, api = defaultApi, community = defaultCommunity, cover = renderCover }: PublishDialogProps) {
  const account = useAccount();
  const [signIn, setSignIn] = useState(false);
  const [existing, setExisting] = useState<ResourceSummary | null | undefined>(undefined);
  const [kind, setKind] = useState<ResourceKind>('file');
  const [title, setTitle] = useState(source.name);
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState('');
  const [notes, setNotes] = useState('');
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [coverBytes, setCoverBytes] = useState<Uint8Array | null>(null);
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ id: string; version: number } | null>(null);
  const sourceKey = source.kind === 'local' ? localSourceKey(source.fileId) : docSourceKey(source.docId);

  // Whether this file was published before: then this is a new version of it.
  useEffect(() => {
    if (!account) return undefined;
    let current = true;
    community
      .mine()
      .then((mine) => {
        if (!current) return;
        const found = mine.find((resource) => resource.sourceKey === sourceKey) ?? null;
        setExisting(found);
        if (found) {
          setKind(found.kind);
          setTitle(found.title);
          setDescription(found.description);
          setTags(found.tags.join(', '));
        }
      })
      .catch((cause: unknown) => {
        if (!current) return;
        setExisting(null);
        setError(errorMessage(cause));
      });
    return () => {
      current = false;
    };
  }, [account, community, sourceKey]);

  // The file itself, and its cover.
  useEffect(() => {
    if (!account) return undefined;
    let current = true;
    void loadSource(source, storage, api)
      .then(async (found) => {
        if (!current) return;
        setLoaded(found);
        const bytes = await cover(found.doc, found.loadAsset).catch(() => null);
        if (!current || !bytes) return;
        setCoverBytes(bytes);
        setCoverUrl(URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: 'image/png' })));
      })
      .catch((cause: unknown) => current && setError(errorMessage(cause)));
    return () => {
      current = false;
    };
    // Loaded once for the dialog.
  }, [account]);

  useEffect(() => () => void (coverUrl && URL.revokeObjectURL(coverUrl)), [coverUrl]);

  if (!account) {
    return signIn ? (
      <AccountDialog mode="signup" reason="Publishing needs a free account. Browsing the Community needs none." onClose={onClose} api={api} />
    ) : (
      <Dialog
        title="Publish to Community"
        onClose={onClose}
        footer={
          <>
            <button type="button" className="ev-button" onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="ev-button ev-button-primary" onClick={() => setSignIn(true)}>
              Sign in or create an account
            </button>
          </>
        }
      >
        <p className="m-0 leading-relaxed text-dim">Publishing needs a free account, so that people know who made it. Browsing and copying from the Community need none.</p>
      </Dialog>
    );
  }

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!loaded || busy || !title.trim()) return;
    setBusy(true);
    setError(null);
    const fields: PublishFields = {
      kind,
      title: title.trim(),
      description: description.trim(),
      tags: tags
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
      notes: notes.trim(),
    };
    const publish = source.kind === 'local' ? publishLocalDocument(community, loaded.doc, loaded.loadAsset, fields) : community.publishDocument(source.docId, fields);
    void publish
      .then(async (result) => {
        if (coverBytes) await community.putCover(result.resource.id, coverBytes, 'image/png');
        setDone({ id: result.resource.id, version: result.version });
      })
      .catch((cause: unknown) => setError(errorMessage(cause)))
      .finally(() => setBusy(false));
  };

  if (done) {
    return (
      <Dialog
        title="Published"
        onClose={onClose}
        footer={
          <>
            <button type="button" className="ev-button" onClick={onClose}>
              Done
            </button>
            <button type="button" className="ev-button ev-button-primary" onClick={() => onNavigate(`#/community/${done.id}`)}>
              View in Community
            </button>
          </>
        }
      >
        <p role="status" className="m-0 leading-relaxed text-dim">
          <strong className="font-semibold text-ink">{title}</strong> is published{done.version > 1 ? ` as version ${done.version}` : ''}. Anyone can find it, free.
        </p>
      </Dialog>
    );
  }

  return (
    <Dialog title={existing ? 'Publish a new version' : 'Publish to Community'} onClose={onClose} width={560}>
      <form className="flex flex-col gap-3" onSubmit={submit}>
        <div className="flex gap-3 max-sm:flex-col">
          <div
            aria-label="Cover"
            role="img"
            className="flex aspect-[16/10] w-[200px] flex-none items-center justify-center overflow-hidden rounded-[9px] bg-field text-center text-[11px] text-dim shadow-[var(--ev-sunk)] max-sm:w-full"
          >
            {coverUrl ? <img src={coverUrl} alt="" className="h-full w-full object-cover" /> : loaded ? 'No cover: the first page is empty' : 'Drawing the cover…'}
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-dim">Title</span>
              <input className="ev-field" value={title} maxLength={100} onChange={(event) => setTitle(event.target.value)} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-dim">Type</span>
              <select className="ev-field" value={kind} onChange={(event) => setKind(event.target.value as ResourceKind)}>
                {RESOURCE_KINDS.map((value) => (
                  <option key={value} value={value}>
                    {KIND_LABELS[value]}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
        <label className="flex flex-col gap-1">
          <span className="text-dim">Description</span>
          <textarea className="ev-field !h-20 resize-none py-1.5" value={description} maxLength={2000} onChange={(event) => setDescription(event.target.value)} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-dim">Tags</span>
          <input className="ev-field" placeholder="mobile, dashboard, icons" value={tags} onChange={(event) => setTags(event.target.value)} />
        </label>
        {existing && (
          <label className="flex flex-col gap-1">
            <span className="text-dim">What changed in this version</span>
            <textarea className="ev-field !h-16 resize-none py-1.5" value={notes} maxLength={1000} onChange={(event) => setNotes(event.target.value)} />
          </label>
        )}
        {existing && (
          <p className="m-0 text-[11.5px] text-dim">
            This file is published as “{existing.title}” (version {existing.version}). Publishing again makes version {existing.version + 1}; people can still duplicate earlier ones.
          </p>
        )}
        {error && (
          <p role="alert" className="m-0 text-danger">
            {error}
          </p>
        )}
        <div className="flex items-center gap-2">
          <p className="m-0 flex-1 text-[11px] text-dim">A copy of the file as it is now is published. Later edits change nothing until you publish again.</p>
          <button type="submit" className="ev-button ev-button-primary" disabled={!loaded || busy || !title.trim() || existing === undefined}>
            {busy ? 'Publishing…' : existing ? 'Publish new version' : 'Publish'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
