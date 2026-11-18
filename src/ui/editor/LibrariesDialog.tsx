import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from 'zustand';
import { hasUnpublishedChanges, listLibraries, publishContent, publishCounts, publishLibrary, removeLibrary, unpublishLibrary } from '../../core';
import { createLibraryUpdates, librariesApi, teamLibraryProblem, type LibrariesApi, type LibraryUpdates, type TeamLibrarySummary } from '../../collab/libraries';
import { listPublishedLibraries, type LibrarySummary } from '../../persistence/libraries';
import { AccountDialog } from '../collab/AccountDialog';
import { useAccount, useGuest } from '../collab/hooks';
import { Dialog } from '../components/Dialog';
import { Icon } from '../components/Icon';
import { useEditor, useEditorContext } from './EditorContext';
import { LibraryUpdatesNotice, useLibraryUpdateList, useOptionalLibraryUpdates } from './LibraryUpdates';

/** A rounded well pressed into the dialog: what this file's card and the lists of libraries sit in. */
const WELL = 'rounded-[12px] bg-bg/50 shadow-[var(--ev-sunk)]';
/** What an empty list says, in a quiet dashed outline where its rows would be. */
const EMPTY = 'm-0 rounded-[10px] border border-dashed border-line px-3 py-3 text-center leading-[1.45] text-faint';
/** A note under a part of the dialog. */
const NOTE = 'm-0 leading-[1.5] text-faint';
/** A list of libraries: rows in a well, a hairline between each. */
const LIST = `m-0 flex list-none flex-col divide-y divide-line/60 px-1 py-0 empty:hidden ${WELL}`;
/** A row of a list of libraries. */
const ROW = 'flex items-center gap-2.5 px-2 py-2';
/** The name of a group of team libraries (a workspace). */
const GROUP = 'm-0 mt-1 text-[11px] font-semibold text-dim';

/** A library's mark in a row: a small raised tile with the component glyph. */
function LibraryTile() {
  return (
    <span aria-hidden="true" className="flex h-8 w-8 flex-none items-center justify-center rounded-[8px] text-dim shadow-[var(--ev-raise)]" style={{ background: 'var(--ev-button)' }}>
      <Icon name="component" />
    </span>
  );
}

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

function contents(counts: { components: number; styles: number; variables: number }): string {
  return [plural(counts.components, 'component', 'components'), plural(counts.styles, 'style', 'styles'), plural(counts.variables, 'variable', 'variables')].join(', ');
}

const when = (iso: string): string => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
};

/** What the Team libraries section shows. */
type TeamState =
  | { status: 'signed-out'; message: string }
  | { status: 'loading' }
  | { status: 'offline'; message: string }
  | { status: 'error'; message: string }
  | { status: 'ready'; libraries: TeamLibrarySummary[] };

const SIGN_IN_NOTE = 'Sign in to use your team’s libraries.';
/** A guest (no account) is in no workspace, and the server lists no libraries for guests (a file opened by its link is not listed). */
const GUEST_NOTE = 'Team libraries are those published in your workspaces. Sign in with an account to use them.';

/** Team libraries by workspace, in the order the server sent them (workspace name, then name). */
export function groupByWorkspace(libraries: readonly TeamLibrarySummary[]): { key: string; label: string; libraries: TeamLibrarySummary[] }[] {
  const groups: { key: string; label: string; libraries: TeamLibrarySummary[] }[] = [];
  for (const library of libraries) {
    const key = library.workspaceId ?? '';
    let group = groups.find((entry) => entry.key === key);
    if (!group) {
      group = { key, label: library.workspaceName ?? 'Shared with you', libraries: [] };
      groups.push(group);
    }
    group.libraries.push(library);
  }
  return groups;
}

interface LibrariesDialogProps {
  onClose: () => void;
  /** The team library routes (tests give their own); the application's client by default. */
  teamApi?: LibrariesApi;
}

/**
 * Libraries: publishing this file's components, styles and variables for
 * other files, and adding, updating and removing the libraries this file
 * uses. The libraries offered are the published files on this device and,
 * for someone signed in, the team's: the shared files published on the
 * collaboration server that they can view. Either kind is copied into the
 * file when added, so the file opens and draws without the server.
 */
export function LibrariesDialog({ onClose, teamApi }: LibrariesDialogProps) {
  const { store, storage } = useEditorContext();
  const provided = useOptionalLibraryUpdates();
  const api = teamApi ?? librariesApi;
  // The editor provides the updates it shows above the canvas; on its own (tests), the dialog keeps its own.
  const own = useMemo(() => (provided ? null : createLibraryUpdates({ editor: store, storage, api })), [provided, store, storage, api]);
  const updates = (provided ?? own) as LibraryUpdates;
  const [signIn, setSignIn] = useState(false);

  if (signIn) {
    return <AccountDialog mode="signin" reason="Team libraries are the libraries published in your workspaces. An account is free, with no limits." onClose={() => setSignIn(false)} />;
  }
  return <LibrariesContent onClose={onClose} api={api} updates={updates} onSignIn={() => setSignIn(true)} />;
}

function LibrariesContent({ onClose, api, updates, onSignIn }: { onClose: () => void; api: LibrariesApi; updates: LibraryUpdates; onSignIn: () => void }) {
  const { store, storage, app } = useEditorContext();
  const doc = useEditor((s) => s.doc);
  const readOnly = useEditor((s) => s.readOnly);
  const account = useAccount();
  const guest = useGuest();
  const [available, setAvailable] = useState<LibrarySummary[] | null>(null);
  const [team, setTeam] = useState<TeamState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [problem, setProblem] = useState('');
  const busy = useStore(updates.store, (s) => s.busy);
  const latest = useStore(updates.store, (s) => s.latest);
  const { all: newer } = useLibraryUpdateList(updates);
  const docId = doc.id;
  // Only an account has workspaces: the server answers a guest with an empty list, so a guest is asked to sign in instead.
  const credential = account?.token ?? null;
  const isGuest = !credential && Boolean(guest?.guestToken);

  const refresh = useCallback(() => {
    listPublishedLibraries(storage, docId)
      .then((list) => {
        setAvailable(list);
        updates.learn('device', list);
      })
      .catch(() => setAvailable([]));
  }, [storage, docId, updates]);
  useEffect(refresh, [refresh]);

  // The team's libraries: asked for when the dialog opens, when someone signs in, and on "Try again".
  useEffect(() => {
    if (!credential) {
      setTeam({ status: 'signed-out', message: isGuest ? GUEST_NOTE : SIGN_IN_NOTE });
      return;
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setTeam({ status: 'offline', message: teamLibraryProblem(null).message });
      return;
    }
    let current = true;
    setTeam({ status: 'loading' });
    api
      .list()
      .then((libraries) => {
        if (!current) return;
        setTeam({ status: 'ready', libraries });
        updates.learn('team', libraries);
      })
      .catch((error: unknown) => {
        if (!current) return;
        const said = teamLibraryProblem(error);
        setTeam(said.kind === 'signed-out' ? { status: 'signed-out', message: said.message } : said.kind === 'offline' ? { status: 'offline', message: said.message } : { status: 'error', message: said.message });
      });
    return () => {
      current = false;
    };
  }, [api, credential, isGuest, attempt, updates]);

  const used = listLibraries(doc);
  const counts = publishCounts(publishContent(doc));
  const nothing = counts.components + counts.styles + counts.variables === 0;
  const changed = hasUnpublishedChanges(doc);
  const isUsed = (id: string): boolean => used.some((library) => library.id === id);

  const take = (id: string, source: 'device' | 'team', name: string, label: string): void => {
    setProblem('');
    void updates.take(id, source, name, label).then((said) => {
      if (!said) return;
      setProblem(said);
      if (source === 'device') refresh();
      else setAttempt((n) => n + 1);
    });
  };

  const teamGroups = team.status === 'ready' ? groupByWorkspace(team.libraries.filter((entry) => entry.id !== docId && !isUsed(entry.id))) : [];

  return (
    <Dialog title="Libraries" onClose={onClose} width={560}>
      <div className="flex flex-col gap-5">
        <section aria-label="This file as a library" className="flex flex-col gap-2">
          <h3 className="ev-section-title">This file</h3>
          {/* This file's card: what it would publish and where it stands, with the actions under it. */}
          <div className={`flex flex-col gap-3 p-3 ${WELL}`}>
            <div className="flex items-start gap-3">
              <span aria-hidden="true" className="flex h-9 w-9 flex-none items-center justify-center rounded-[10px] bg-selected text-accent">
                <Icon name="component" size={18} />
              </span>
              <p className="m-0 min-w-0 flex-1 leading-[1.5] text-ink">
                {nothing ? 'This file has no components, styles or variables to publish.' : `This file has ${contents(counts)}.`}{' '}
                <span role="status" aria-label="Publishing status" className="mt-0.5 block text-dim">
                  {doc.publication
                    ? `Published as version ${doc.publication.version}${when(doc.publication.publishedAt) ? ` on ${when(doc.publication.publishedAt)}` : ''}${changed ? ', with changes since that are not published.' : '.'}`
                    : 'Not published.'}
                </span>
              </p>
            </div>
            <div className="flex gap-2 pl-12">
              <button
                type="button"
                className="ev-button ev-button-primary !px-4"
                data-autofocus
                disabled={nothing || (doc.publication !== null && !changed)}
                onClick={() => {
                  store.getState().apply('Publish library', (d) => publishLibrary(d, new Date().toISOString()));
                  // Written at once, so that other files find the new version.
                  app.saveNow();
                }}
              >
                {doc.publication ? 'Publish changes' : 'Publish'}
              </button>
              {doc.publication && (
                <button
                  type="button"
                  className="ev-button !px-4"
                  onClick={() => {
                    store.getState().apply('Unpublish library', unpublishLibrary);
                    app.saveNow();
                  }}
                >
                  Unpublish
                </button>
              )}
            </div>
          </div>
          <p className={NOTE}>Other files get what was published, not what has changed since. Files that already use this library are told when a new version is published, and take it when they choose “Update”.</p>
        </section>

        <LibraryUpdatesNotice updates={updates} className={WELL} />

        <section aria-label="Libraries used in this file" className="flex flex-col gap-2">
          <h3 className="ev-section-title">Used in this file</h3>
          {used.length === 0 && <p className={EMPTY}>No library has been added to this file.</p>}
          <ul className={LIST}>
            {used.map((library) => {
              const update = newer.find((entry) => entry.id === library.id);
              const known = latest?.find((entry) => entry.id === library.id);
              return (
                <li key={library.id} className={ROW}>
                  <LibraryTile />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-ink">{update?.name ?? known?.name ?? library.name}</div>
                    <div className="text-[11px] leading-[1.45] text-dim">
                      Version {library.version}
                      {latest === null
                        ? ''
                        : update
                          ? `. Version ${update.to} is available.`
                          : known
                            ? '. Up to date.'
                            : '. Not found on this device or among your team’s libraries just now; what this file has from it stays.'}
                    </div>
                  </div>
                  {update && !readOnly && (
                    <button type="button" className="ev-button ev-button-primary !h-7 flex-none !px-3" disabled={busy} aria-label={`Update ${library.name}`} onClick={() => take(library.id, update.latest.source, update.name, 'Update library')}>
                      Update
                    </button>
                  )}
                  <button type="button" className="ev-button ev-button-danger !h-7 flex-none !px-3" disabled={readOnly} aria-label={`Remove ${library.name}`} onClick={() => store.getState().apply('Remove library', (d) => removeLibrary(d, library.id))}>
                    Remove
                  </button>
                </li>
              );
            })}
          </ul>
          {used.length > 0 && <p className={NOTE}>Removing a library turns the instances of its components into ordinary frames; layers keep the look its styles and variables gave them.</p>}
        </section>

        <section aria-label="Libraries on this device" className="flex flex-col gap-2">
          <h3 className="ev-section-title">On this device</h3>
          {available === null && <p className={EMPTY}>Looking for published files…</p>}
          {available !== null && available.filter((entry) => !isUsed(entry.id)).length === 0 && (
            <p className={EMPTY}>No other published file on this device. To make one, open a file, choose Libraries and publish it.</p>
          )}
          <ul className={LIST}>
            {(available ?? [])
              .filter((entry) => !isUsed(entry.id))
              .map((entry) => (
                <li key={entry.id} className={ROW}>
                  <LibraryTile />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-ink">{entry.name}</div>
                    <div className="text-[11px] leading-[1.45] text-dim">
                      {contents(entry)}. Version {entry.version}.
                    </div>
                  </div>
                  <button type="button" className="ev-button !h-7 flex-none !gap-1.5 !pl-2 !pr-3" disabled={busy || readOnly} aria-label={`Add ${entry.name}`} onClick={() => take(entry.id, 'device', entry.name, 'Add library')}>
                    <Icon name="plus" size={12} />
                    Add to this file
                  </button>
                </li>
              ))}
          </ul>
        </section>

        <section aria-label="Team libraries" className="flex flex-col gap-2">
          <h3 className="ev-section-title">Team libraries</h3>
          {team.status === 'signed-out' && (
            <div className={`${EMPTY} flex flex-col items-center gap-2`}>
              <span>{team.message}</span>
              <button type="button" className="ev-button !h-7 !px-3" onClick={onSignIn}>
                Sign in
              </button>
            </div>
          )}
          {team.status === 'loading' && <p className={EMPTY}>Looking for your team’s libraries…</p>}
          {(team.status === 'offline' || team.status === 'error') && (
            <div className={`${EMPTY} flex flex-col items-center gap-2`}>
              <span>{team.message}</span>
              <button type="button" className="ev-button !h-7 !px-3" onClick={() => setAttempt((n) => n + 1)}>
                Try again
              </button>
            </div>
          )}
          {team.status === 'ready' && teamGroups.length === 0 && (
            <p className={EMPTY}>No other library is published in your workspaces. To publish one, open a shared file, choose Libraries and publish it.</p>
          )}
          {teamGroups.map((group) => (
            <div key={group.key} role="group" aria-label={group.label} className="flex flex-col gap-1.5">
              <h4 className={GROUP}>{group.label}</h4>
              <ul className={LIST}>
                {group.libraries.map((entry) => (
                  <li key={entry.id} className={ROW}>
                    <LibraryTile />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium text-ink">{entry.name}</div>
                      <div className="text-[11px] leading-[1.45] text-dim">
                        {contents(entry)}. Version {entry.version}.
                      </div>
                    </div>
                    <button type="button" className="ev-button !h-7 flex-none !gap-1.5 !pl-2 !pr-3" disabled={busy || readOnly} aria-label={`Add ${entry.name}`} onClick={() => take(entry.id, 'team', entry.name, 'Add library')}>
                      <Icon name="plus" size={12} />
                      Add to this file
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {team.status === 'ready' && teamGroups.length > 0 && <p className={NOTE}>What a team library publishes is copied into this file, so the file opens and draws without the server.</p>}
        </section>
        {problem && (
          <p role="alert" className="m-0 leading-[1.45] text-danger">
            {problem}
          </p>
        )}
      </div>
    </Dialog>
  );
}
