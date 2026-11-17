import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api as defaultApi, errorMessage, type EvoraApi } from '../../collab/api';
import {
  communityApi as defaultCommunity,
  copyToDevice,
  KIND_LABELS,
  RESOURCE_KINDS,
  type CommunityApi,
  type DirectoryEntry,
  type ResourceDetail,
  type ResourceKind,
  type ResourceSummary,
} from '../../collab/community';
import { filesApi as defaultFiles, type FilesApi, type Project } from '../../collab/files';
import type { Workspace } from '../../collab/protocol';
import type { DocumentStorage } from '../../persistence/storage';
import { AccountDialog } from '../collab/AccountDialog';
import { AccountMenu } from '../collab/AccountMenu';
import { Avatar } from '../collab/Avatar';
import { timeAgo, useAccount } from '../collab/hooks';
import { Dialog } from '../components/Dialog';
import { Icon, Wordmark } from '../components/Icon';
import { Confirm, Glyph } from '../files/parts';

interface CommunityScreenProps {
  storage: DocumentStorage | null;
  /** The resource whose page is shown (`#/community/<id>`), or none for browsing. */
  resourceId?: string | null;
  onNavigate: (hash: string) => void;
  api?: EvoraApi;
  community?: CommunityApi;
  files?: FilesApi;
}

/**
 * `#/community` and `#/community/<id>`: the Community (spec §24), free for
 * everyone. Browse and search what people published, see a resource's page,
 * duplicate it into a workspace or keep a copy on this device; the plugins
 * and widgets directory; and, signed in, your own published resources.
 */
export function CommunityScreen({ storage, resourceId = null, onNavigate, api = defaultApi, community = defaultCommunity, files = defaultFiles }: CommunityScreenProps) {
  return (
    <main className="flex h-full flex-col gap-1.5 overflow-hidden bg-bg p-1.5">
      <header className="ev-panel flex h-12 flex-none items-center gap-2 pl-3.5 pr-2">
        <h1 className="m-0 flex items-center gap-3 text-[15px] leading-none">
          <Wordmark size={24} />
          <span className="text-[13px] font-semibold text-dim">Community</span>
        </h1>
        <div className="flex-1" />
        <button type="button" className="ev-button" onClick={() => onNavigate('#/')}>
          Back to files
        </button>
        <AccountMenu />
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1120px] px-4 pb-12 pt-7 sm:px-8">
          {resourceId ? (
            <ResourcePage key={resourceId} id={resourceId} storage={storage} onNavigate={onNavigate} api={api} community={community} files={files} />
          ) : (
            <BrowsePage community={community} onNavigate={onNavigate} />
          )}
        </div>
      </div>
    </main>
  );
}

// ------------------------------------------------------------------ browsing

type Tab = 'resources' | 'plugins' | 'mine';

function TabButton({ selected, onClick, children }: { selected: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" role="tab" aria-selected={selected} className="ev-segment !flex-none !px-3 text-[12px]" onClick={onClick}>
      {children}
    </button>
  );
}

export function BrowsePage({ community, onNavigate }: { community: CommunityApi; onNavigate: (hash: string) => void }) {
  const account = useAccount();
  const [tab, setTab] = useState<Tab>('resources');
  const shown: Tab = tab === 'mine' && !account ? 'resources' : tab;
  return (
    <>
      <div className="mb-2 flex flex-wrap items-end gap-3">
        <div>
          <h2 className="m-0 text-[22px] font-semibold tracking-[-0.02em] text-ink">Explore the Community</h2>
          <p className="m-0 mt-1 text-dim">Design files, templates, UI kits, components, icons, plugins and widgets, free for everyone.</p>
        </div>
      </div>
      <div role="tablist" aria-label="Community sections" className="ev-segmented my-5 inline-flex">
        <TabButton selected={shown === 'resources'} onClick={() => setTab('resources')}>
          Files & templates
        </TabButton>
        <TabButton selected={shown === 'plugins'} onClick={() => setTab('plugins')}>
          Plugins & widgets
        </TabButton>
        {account && (
          <TabButton selected={shown === 'mine'} onClick={() => setTab('mine')}>
            Your resources
          </TabButton>
        )}
      </div>
      {shown === 'resources' && <ResourcesTab community={community} onNavigate={onNavigate} />}
      {shown === 'plugins' && <PluginsTab community={community} />}
      {shown === 'mine' && <MineTab community={community} onNavigate={onNavigate} />}
    </>
  );
}

const PAGE = 24;

function ResourcesTab({ community, onNavigate }: { community: CommunityApi; onNavigate: (hash: string) => void }) {
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<ResourceKind | null>(null);
  const [tag, setTag] = useState<string | null>(null);
  const [sort, setSort] = useState<'newest' | 'popular'>('newest');
  const [items, setItems] = useState<ResourceSummary[] | null>(null);
  const [total, setTotal] = useState(0);
  const [tags, setTags] = useState<{ tag: string; count: number }[]>([]);
  const [error, setError] = useState<string | null>(null);

  // What is typed is searched for once typing pauses.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(text), 250);
    return () => clearTimeout(timer);
  }, [text]);

  useEffect(() => {
    let current = true;
    setError(null);
    community
      .browse({ q: query, kind, tag, sort, limit: PAGE })
      .then((result) => {
        if (!current) return;
        setItems(result.items);
        setTotal(result.total);
      })
      .catch((cause: unknown) => current && setError(errorMessage(cause)));
    return () => {
      current = false;
    };
  }, [community, query, kind, tag, sort]);

  useEffect(() => {
    community
      .tags()
      .then(setTags)
      .catch(() => setTags([]));
  }, [community]);

  const more = (): void => {
    if (!items) return;
    community
      .browse({ q: query, kind, tag, sort, limit: PAGE, offset: items.length })
      .then((result) => {
        setItems([...items, ...result.items]);
        setTotal(result.total);
      })
      .catch((cause: unknown) => setError(errorMessage(cause)));
  };

  return (
    <section aria-label="Files and templates">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <label className="ev-input-shell flex h-8 min-w-[240px] flex-1 items-center gap-2 px-2.5 text-dim">
          <Glyph name="search" size={15} />
          <input
            className="min-w-0 flex-1 border-0 bg-transparent p-0 text-[12.5px] text-ink outline-none placeholder:text-faint"
            aria-label="Search the Community"
            placeholder="Search files, templates, UI kits, icons…"
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </label>
        <select aria-label="Sort by" className="ev-field !h-8 !w-auto" value={sort} onChange={(event) => setSort(event.target.value as 'newest' | 'popular')}>
          <option value="newest">Newest</option>
          <option value="popular">Most duplicated</option>
        </select>
      </div>
      <div role="radiogroup" aria-label="Type" className="mb-3 flex flex-wrap gap-1.5">
        {[null, ...RESOURCE_KINDS].map((value) => (
          <button
            key={value ?? 'all'}
            type="button"
            role="radio"
            aria-checked={kind === value}
            className={`h-7 rounded-full border-0 px-3 text-[12px] font-medium transition-colors ${kind === value ? 'bg-ink text-bg' : 'bg-field text-dim shadow-[var(--ev-sunk)] hover:text-ink'}`}
            onClick={() => setKind(value)}
          >
            {/* The colour is on a span: the global `button { color: inherit }` rule is not in a layer, so it beats a text colour utility on the button itself. */}
            <span className={kind === value ? 'text-bg' : undefined}>{value ? KIND_LABELS[value] : 'All'}</span>
          </button>
        ))}
      </div>
      {tags.length > 0 && (
        <div aria-label="Tags" role="group" className="mb-5 flex flex-wrap items-center gap-1.5">
          {tags.map((entry) => (
            <button
              key={entry.tag}
              type="button"
              aria-pressed={tag === entry.tag}
              className={`h-6 rounded-[6px] border-0 px-2 text-[11.5px] ${tag === entry.tag ? 'bg-accent text-accent-ink' : 'bg-transparent text-dim hover:bg-hover hover:text-ink'}`}
              onClick={() => setTag(tag === entry.tag ? null : entry.tag)}
            >
              #{entry.tag}
            </button>
          ))}
        </div>
      )}
      {error && (
        <p role="alert" className="m-0 mb-4 text-danger">
          {error}
        </p>
      )}
      {items === null && !error && <p className="m-0 text-dim">Loading…</p>}
      {items !== null && items.length === 0 && (
        <p className="m-0 rounded-[12px] bg-panel px-6 py-8 text-center leading-relaxed text-dim shadow-[var(--ev-shadow-panel)]">
          {query || kind || tag ? 'Nothing matches. Try other words, or another type.' : 'Nothing has been published yet. Publish a file from its menu in your files: it is free.'}
        </p>
      )}
      {items !== null && items.length > 0 && (
        <>
          <p className="m-0 mb-3 text-[11.5px] text-dim" role="status">
            {total} {total === 1 ? 'resource' : 'resources'}
          </p>
          <ResourceGrid items={items} community={community} onOpen={(resource) => onNavigate(`#/community/${resource.id}`)} />
          {items.length < total && (
            <div className="mt-6 flex justify-center">
              <button type="button" className="ev-button" onClick={more}>
                Show more
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

/** Resources as cards: the cover, the title, who made it, how often it was duplicated. */
export function ResourceGrid({ items, community, onOpen, extra }: { items: ResourceSummary[]; community: CommunityApi; onOpen: (resource: ResourceSummary) => void; extra?: (resource: ResourceSummary) => ReactNode }) {
  return (
    <ul aria-label="Resources" className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(232px,1fr))] gap-4 p-0">
      {items.map((resource) => {
        const cover = community.coverUrl(resource);
        return (
          <li key={resource.id} className="group relative flex flex-col rounded-[12px] bg-panel shadow-[var(--ev-shadow-panel)] transition-[translate,box-shadow] duration-150 ease-[var(--ev-ease)] hover:-translate-y-0.5 hover:shadow-[var(--ev-shadow-pop)]">
            <div aria-hidden="true" className="m-1.5 mb-0 flex aspect-[16/10] items-center justify-center overflow-hidden rounded-[9px] bg-field shadow-[var(--ev-sunk)]">
              {cover ? <img src={cover} alt="" loading="lazy" className="h-full w-full object-cover" /> : <span className="text-[24px] font-semibold text-faint">{Array.from(resource.title)[0]?.toUpperCase()}</span>}
            </div>
            <div className="flex flex-col gap-1 px-3 pb-3 pt-2">
              <button
                type="button"
                className="min-w-0 truncate border-0 bg-transparent p-0 text-left text-[12.5px] font-medium text-ink after:absolute after:inset-0 after:rounded-[12px] focus-visible:!outline-none focus-visible:after:shadow-[0_0_0_2px_var(--ev-ring)]"
                aria-label={`Open ${resource.title}`}
                onClick={() => onOpen(resource)}
              >
                {resource.title}
              </button>
              <span className="flex items-center gap-1.5 text-[11px] text-dim">
                <Avatar name={resource.author.name} color={resource.author.color} size={14} />
                <span className="truncate">{resource.author.name}</span>
                <span aria-hidden="true">·</span>
                <span className="flex-none">{KIND_LABELS[resource.kind]}</span>
              </span>
              <span className="flex items-center gap-1 text-[11px] text-faint">
                <Glyph name="copy" size={11} />
                {resource.duplicates} {resource.duplicates === 1 ? 'duplicate' : 'duplicates'}
              </span>
              {extra && <div className="relative z-10 mt-1 flex gap-1.5">{extra(resource)}</div>}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function PluginsTab({ community }: { community: CommunityApi }) {
  const [text, setText] = useState('');
  const [kind, setKind] = useState('');
  const [entries, setEntries] = useState<DirectoryEntry[] | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    const timer = setTimeout(() => {
      community
        .pluginDirectory(text, kind)
        .then((list) => {
          if (!current) return;
          setEntries(list);
          setError(null);
        })
        .catch((cause: unknown) => {
          if (!current) return;
          setEntries([]);
          setError(errorMessage(cause));
        });
    }, 200);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [community, text, kind]);
  return (
    <section aria-label="Plugins and widgets">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <label className="ev-input-shell flex h-8 min-w-[240px] flex-1 items-center gap-2 px-2.5 text-dim">
          <Glyph name="search" size={15} />
          <input
            className="min-w-0 flex-1 border-0 bg-transparent p-0 text-[12.5px] text-ink outline-none placeholder:text-faint"
            aria-label="Search plugins and widgets"
            placeholder="Search plugins and widgets…"
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </label>
        <select aria-label="Show" className="ev-field !h-8 !w-auto" value={kind} onChange={(event) => setKind(event.target.value)}>
          <option value="">Plugins and widgets</option>
          <option value="plugin">Plugins</option>
          <option value="widget">Widgets</option>
        </select>
      </div>
      {error && (
        <p role="alert" className="m-0 mb-4 text-danger">
          {error}
        </p>
      )}
      {entries === undefined && <p className="m-0 text-dim">Loading…</p>}
      {entries === null && <p className="m-0 rounded-[12px] bg-panel px-6 py-8 text-center text-dim shadow-[var(--ev-shadow-panel)]">This server has no plugin directory yet.</p>}
      {entries && entries.length === 0 && !error && (
        <p className="m-0 rounded-[12px] bg-panel px-6 py-8 text-center text-dim shadow-[var(--ev-shadow-panel)]">
          {text || kind ? 'No plugins or widgets match.' : 'No plugins or widgets have been published yet.'}
        </p>
      )}
      {entries && entries.length > 0 && (
        <ul aria-label="Plugins" className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3 p-0">
          {entries.map((entry) => (
            <li key={entry.id} className="flex gap-3 rounded-[12px] bg-panel p-3 shadow-[var(--ev-shadow-panel)]">
              <span aria-hidden="true" className="flex h-10 w-10 flex-none items-center justify-center rounded-[10px] bg-field text-[16px] font-semibold text-dim shadow-[var(--ev-sunk)]">
                {Array.from(entry.name)[0]?.toUpperCase()}
              </span>
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate text-[12.5px] font-medium text-ink">{entry.name}</span>
                <span className="line-clamp-2 text-[11.5px] leading-snug text-dim">{entry.description}</span>
                <span className="text-[11px] text-faint">
                  {entry.kind === 'widget' ? 'Widget' : 'Plugin'} · {entry.author.name} · v{entry.version} · {entry.installs} {entry.installs === 1 ? 'install' : 'installs'}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="m-0 mt-4 text-[11.5px] text-dim">Plugins and widgets are installed from the editor’s main menu, under Plugins.</p>
    </section>
  );
}

function MineTab({ community, onNavigate }: { community: CommunityApi; onNavigate: (hash: string) => void }) {
  const [items, setItems] = useState<ResourceSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unpublishing, setUnpublishing] = useState<ResourceSummary | null>(null);
  const load = useCallback(() => {
    community
      .mine()
      .then(setItems)
      .catch((cause: unknown) => setError(errorMessage(cause)));
  }, [community]);
  useEffect(load, [load]);
  return (
    <section aria-label="Your resources">
      {error && (
        <p role="alert" className="m-0 mb-4 text-danger">
          {error}
        </p>
      )}
      {items !== null && items.length === 0 && (
        <p className="m-0 rounded-[12px] bg-panel px-6 py-8 text-center leading-relaxed text-dim shadow-[var(--ev-shadow-panel)]">
          You have not published anything yet. Open a file’s menu in your files and choose “Publish to Community…”.
        </p>
      )}
      {items !== null && items.length > 0 && (
        <ResourceGrid
          items={items}
          community={community}
          onOpen={(resource) => onNavigate(`#/community/${resource.id}`)}
          extra={(resource) => (
            <button type="button" className="ev-button !h-7 text-danger" onClick={() => setUnpublishing(resource)}>
              Unpublish…
            </button>
          )}
        />
      )}
      {unpublishing && (
        <Confirm
          title="Unpublish resource"
          action="Unpublish"
          onClose={() => setUnpublishing(null)}
          onConfirm={() =>
            void community
              .unpublish(unpublishing.id)
              .then(load)
              .catch((cause: unknown) => setError(errorMessage(cause)))
          }
        >
          Take <strong className="font-semibold text-ink">{unpublishing.title}</strong> and all its versions out of the Community? Copies people already made are theirs to keep.
        </Confirm>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ a resource's page

interface ResourcePageProps {
  id: string;
  storage: DocumentStorage | null;
  onNavigate: (hash: string) => void;
  api: EvoraApi;
  community: CommunityApi;
  files: FilesApi;
}

export function ResourcePage({ id, storage, onNavigate, api, community, files }: ResourcePageProps) {
  const account = useAccount();
  const [resource, setResource] = useState<ResourceDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState<number | null>(null);
  const [duplicating, setDuplicating] = useState(false);
  const [signIn, setSignIn] = useState(false);
  const [unpublishing, setUnpublishing] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    community
      .resource(id)
      .then((found) => {
        setResource(found);
        setError(null);
      })
      .catch((cause: unknown) => setError(errorMessage(cause)));
  }, [community, id]);
  useEffect(load, [load]);

  if (!resource)
    return (
      <>
        <BackLink onNavigate={onNavigate} />
        {error ? (
          <p role="alert" className="m-0 text-danger">
            {error}
          </p>
        ) : (
          <p className="m-0 text-dim">Loading…</p>
        )}
      </>
    );

  const chosen = version ?? resource.version;
  const cover = community.coverUrl(resource);
  const mine = account?.user.id === resource.author.id;

  const copyHere = (): void => {
    if (!storage) return;
    setBusy(true);
    setError(null);
    void copyToDevice(community, storage, resource.id, chosen)
      .then((fileId) => onNavigate(`#/file/${fileId}`))
      .catch((cause: unknown) => setError(errorMessage(cause)))
      .finally(() => setBusy(false));
  };

  return (
    <article aria-label={resource.title}>
      <BackLink onNavigate={onNavigate} />
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex min-w-0 flex-col gap-5">
          <div className="flex aspect-[16/10] items-center justify-center overflow-hidden rounded-[14px] bg-field shadow-[var(--ev-sunk)]">
            {cover ? <img src={cover} alt={`Cover of ${resource.title}`} className="h-full w-full object-contain" /> : <span className="text-dim">No cover</span>}
          </div>
          <section aria-label="Description">
            <h3 className="ev-section-title mb-2">About</h3>
            <p className="m-0 whitespace-pre-wrap leading-relaxed text-dim">{resource.description || 'No description.'}</p>
            {resource.tags.length > 0 && (
              <ul aria-label="Tags" className="m-0 mt-3 flex list-none flex-wrap gap-1.5 p-0">
                {resource.tags.map((tag) => (
                  <li key={tag} className="rounded-[6px] bg-field px-2 py-0.5 text-[11.5px] text-dim shadow-[var(--ev-sunk)]">
                    #{tag}
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section aria-label="Versions">
            <h3 className="ev-section-title mb-2">Versions</h3>
            <ol className="m-0 flex list-none flex-col gap-0 rounded-[12px] bg-panel p-0 shadow-[var(--ev-shadow-panel)]">
              {resource.versions.map((entry) => (
                <li key={entry.number} className="flex items-start gap-3 border-b border-line/60 px-3 py-2.5 last:border-b-0">
                  <span className="flex-none rounded-[5px] bg-field px-1.5 py-0.5 text-[11px] font-semibold text-ink shadow-[var(--ev-sunk)]">v{entry.number}</span>
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="text-[12px] text-ink">{entry.notes || (entry.number === 1 ? 'First published' : 'No notes')}</span>
                    <span className="text-[11px] text-faint">
                      {timeAgo(entry.createdAt)}
                      {entry.number === resource.version ? ' · latest' : ''}
                    </span>
                  </div>
                </li>
              ))}
            </ol>
          </section>
        </div>
        <aside className="flex flex-col gap-4">
          <div className="ev-panel flex flex-col gap-3 p-4">
            <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-faint">{KIND_LABELS[resource.kind]}</span>
            <h2 className="m-0 text-[20px] font-semibold leading-tight tracking-[-0.02em] text-ink">{resource.title}</h2>
            <span className="flex items-center gap-2 text-dim">
              <Avatar name={resource.author.name} color={resource.author.color} size={20} />
              {resource.author.name}
            </span>
            <dl className="m-0 grid grid-cols-2 gap-2 text-[11.5px]">
              <div>
                <dt className="text-faint">Duplicates</dt>
                <dd className="m-0 text-ink">{resource.duplicates}</dd>
              </div>
              <div>
                <dt className="text-faint">Updated</dt>
                <dd className="m-0 text-ink">{timeAgo(resource.updatedAt)}</dd>
              </div>
            </dl>
            {resource.versions.length > 1 && (
              <label className="flex flex-col gap-1">
                <span className="text-dim">Version</span>
                <select className="ev-field" value={chosen} onChange={(event) => setVersion(Number(event.target.value))}>
                  {resource.versions.map((entry) => (
                    <option key={entry.number} value={entry.number}>
                      Version {entry.number}
                      {entry.number === resource.version ? ' (latest)' : ''}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <button type="button" className="ev-button ev-button-primary" disabled={busy} onClick={() => (account ? setDuplicating(true) : setSignIn(true))}>
              <Glyph name="copy" size={14} />
              Duplicate
            </button>
            <button type="button" className="ev-button" disabled={busy || !storage} onClick={copyHere}>
              <Glyph name="download" size={14} />
              Open a copy on this device
            </button>
            {error && (
              <p role="alert" className="m-0 text-danger">
                {error}
              </p>
            )}
            <p className="m-0 text-[11px] leading-relaxed text-dim">Free to use. Duplicate it into a workspace to edit with others, or keep a copy on this device without an account.</p>
            {mine && (
              <button type="button" className="ev-button text-danger" onClick={() => setUnpublishing(true)}>
                Unpublish…
              </button>
            )}
          </div>
        </aside>
      </div>
      {duplicating && (
        <DuplicateDialog
          api={api}
          files={files}
          title={resource.title}
          onClose={() => setDuplicating(false)}
          onDuplicate={async (workspaceId, projectId) => {
            const made = await community.duplicate(resource.id, workspaceId, chosen, projectId);
            onNavigate(`#/doc/${made.id}`);
          }}
        />
      )}
      {signIn && <AccountDialog mode="signup" reason="Duplicating into a workspace needs a free account. Or open a copy on this device, without one." onClose={() => setSignIn(false)} onDone={() => setDuplicating(true)} api={api} />}
      {unpublishing && (
        <Confirm
          title="Unpublish resource"
          action="Unpublish"
          onClose={() => setUnpublishing(false)}
          onConfirm={() =>
            void community
              .unpublish(resource.id)
              .then(() => onNavigate('#/community'))
              .catch((cause: unknown) => setError(errorMessage(cause)))
          }
        >
          Take <strong className="font-semibold text-ink">{resource.title}</strong> and all its versions out of the Community? Copies people already made are theirs to keep.
        </Confirm>
      )}
    </article>
  );
}

function BackLink({ onNavigate }: { onNavigate: (hash: string) => void }) {
  return (
    <button type="button" className="mb-5 flex items-center gap-1 border-0 bg-transparent p-0 text-dim hover:text-ink" onClick={() => onNavigate('#/community')}>
      <span className="inline-flex rotate-180">
        <Icon name="chevronRight" size={14} />
      </span>
      Community
    </button>
  );
}

interface DuplicateDialogProps {
  api: EvoraApi;
  files: FilesApi;
  title: string;
  onClose: () => void;
  onDuplicate: (workspaceId: string, projectId: string | null) => Promise<void>;
}

/** Choosing where a duplicate goes: one of your workspaces where you can edit, and a project in it. */
export function DuplicateDialog({ api, files, title, onClose, onDuplicate }: DuplicateDialogProps) {
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [workspaceId, setWorkspaceId] = useState('');
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .listWorkspaces()
      .then((list) => {
        const editable = list.filter((workspace) => workspace.role !== 'viewer');
        setWorkspaces(editable);
        setWorkspaceId((current) => current || editable[0]?.id || '');
      })
      .catch((cause: unknown) => setError(errorMessage(cause)));
  }, [api]);

  useEffect(() => {
    setProjectId('');
    if (!workspaceId) return;
    files
      .projects(workspaceId)
      .then(setProjects)
      .catch(() => setProjects([]));
  }, [files, workspaceId]);

  return (
    <Dialog
      title={`Duplicate “${title}”`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="ev-button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="ev-button ev-button-primary"
            disabled={!workspaceId || busy}
            onClick={() => {
              setBusy(true);
              setError(null);
              void onDuplicate(workspaceId, projectId || null)
                .then(onClose)
                .catch((cause: unknown) => {
                  setError(errorMessage(cause));
                  setBusy(false);
                });
            }}
          >
            {busy ? 'Duplicating…' : 'Duplicate'}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {workspaces !== null && workspaces.length === 0 && <p className="m-0 text-dim">You cannot add files to any workspace. Make a workspace of your own first.</p>}
        <label className="flex flex-col gap-1">
          <span className="text-dim">Workspace</span>
          <select className="ev-field" value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)} disabled={!workspaces?.length}>
            {workspaces?.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-dim">Project</span>
          <select className="ev-field" value={projectId} onChange={(event) => setProjectId(event.target.value)} disabled={!workspaceId}>
            <option value="">No project (workspace root)</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
        {error && (
          <p role="alert" className="m-0 text-danger">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
