import { useCallback, useEffect, useState } from 'react';
import { hasUnpublishedChanges, importLibrary, listLibraries, publishContent, publishCounts, publishLibrary, removeLibrary, unpublishLibrary } from '../../core';
import { listPublishedLibraries, loadLibrary, type LibrarySummary } from '../../persistence/libraries';
import { Dialog } from '../components/Dialog';
import { Icon } from '../components/Icon';
import { useEditor, useEditorContext } from './EditorContext';

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

/**
 * Libraries: publishing this file's components, styles and variables for
 * other files, and adding, updating and removing the libraries this file
 * uses. The libraries offered are the published files on this device.
 */
export function LibrariesDialog({ onClose }: { onClose: () => void }) {
  const { store, storage, app } = useEditorContext();
  const doc = useEditor((s) => s.doc);
  const [available, setAvailable] = useState<LibrarySummary[] | null>(null);
  const [problem, setProblem] = useState('');
  const docId = doc.id;

  const refresh = useCallback(() => {
    listPublishedLibraries(storage, docId)
      .then(setAvailable)
      .catch(() => setAvailable([]));
  }, [storage, docId]);
  useEffect(refresh, [refresh]);

  const used = listLibraries(doc);
  const counts = publishCounts(publishContent(doc));
  const nothing = counts.components + counts.styles + counts.variables === 0;
  const changed = hasUnpublishedChanges(doc);

  const take = (id: string, label: string): void => {
    setProblem('');
    void loadLibrary(storage, id).then((library) => {
      if (!library) {
        setProblem('That library is no longer published.');
        refresh();
        return;
      }
      store.getState().apply(label, (d) => importLibrary(d, library));
    });
  };

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
          <p className={NOTE}>Other files get what was published, not what has changed since. Files that already use this library take a new version when they choose “Update”.</p>
        </section>

        <section aria-label="Libraries used in this file" className="flex flex-col gap-2">
          <h3 className="ev-section-title">Used in this file</h3>
          {used.length === 0 && <p className={EMPTY}>No library has been added to this file.</p>}
          <ul className={LIST}>
            {used.map((library) => {
              const latest = available?.find((entry) => entry.id === library.id);
              const newer = latest !== undefined && latest.version > library.version;
              return (
                <li key={library.id} className={ROW}>
                  <LibraryTile />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-ink">{latest?.name ?? library.name}</div>
                    <div className="text-[11px] leading-[1.45] text-dim">
                      Version {library.version}
                      {available === null ? '' : latest === undefined ? '. The library file is not published on this device any more; what this file has from it stays.' : newer ? `. Version ${latest.version} is available.` : '. Up to date.'}
                    </div>
                  </div>
                  {newer && (
                    <button type="button" className="ev-button ev-button-primary !h-7 flex-none !px-3" aria-label={`Update ${library.name}`} onClick={() => take(library.id, 'Update library')}>
                      Update
                    </button>
                  )}
                  <button type="button" className="ev-button ev-button-danger !h-7 flex-none !px-3" aria-label={`Remove ${library.name}`} onClick={() => store.getState().apply('Remove library', (d) => removeLibrary(d, library.id))}>
                    Remove
                  </button>
                </li>
              );
            })}
          </ul>
          {used.length > 0 && <p className={NOTE}>Removing a library turns the instances of its components into ordinary frames; layers keep the look its styles and variables gave them.</p>}
        </section>

        <section aria-label="Available libraries" className="flex flex-col gap-2">
          <h3 className="ev-section-title">Available</h3>
          {available === null && <p className={EMPTY}>Looking for published files…</p>}
          {available !== null && available.filter((entry) => !used.some((library) => library.id === entry.id)).length === 0 && (
            <p className={EMPTY}>No other published file on this device. To make one, open a file, choose Libraries and publish it.</p>
          )}
          <ul className={LIST}>
            {(available ?? [])
              .filter((entry) => !used.some((library) => library.id === entry.id))
              .map((entry) => (
                <li key={entry.id} className={ROW}>
                  <LibraryTile />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-ink">{entry.name}</div>
                    <div className="text-[11px] leading-[1.45] text-dim">
                      {contents(entry)}. Version {entry.version}.
                    </div>
                  </div>
                  <button type="button" className="ev-button !h-7 flex-none !gap-1.5 !pl-2 !pr-3" aria-label={`Add ${entry.name}`} onClick={() => take(entry.id, 'Add library')}>
                    <Icon name="plus" size={12} />
                    Add to this file
                  </button>
                </li>
              ))}
          </ul>
          {problem && (
            <p role="alert" className="m-0 leading-[1.45] text-danger">
              {problem}
            </p>
          )}
        </section>
      </div>
    </Dialog>
  );
}
