import { useCallback, useEffect, useState } from 'react';
import { hasUnpublishedChanges, importLibrary, listLibraries, publishContent, publishCounts, publishLibrary, removeLibrary, unpublishLibrary } from '../../core';
import { listPublishedLibraries, loadLibrary, type LibrarySummary } from '../../persistence/libraries';
import { Dialog } from '../components/Dialog';
import { useEditor, useEditorContext } from './EditorContext';

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
      <div className="flex flex-col gap-4">
        <section aria-label="This file as a library" className="flex flex-col gap-1.5">
          <h3 className="m-0 text-[11px] font-semibold uppercase tracking-wide text-dim">This file</h3>
          <p className="m-0">
            {nothing ? 'This file has no components, styles or variables to publish.' : `This file has ${contents(counts)}.`}{' '}
            <span role="status" aria-label="Publishing status">
              {doc.publication
                ? `Published as version ${doc.publication.version}${when(doc.publication.publishedAt) ? ` on ${when(doc.publication.publishedAt)}` : ''}${changed ? ', with changes since that are not published.' : '.'}`
                : 'Not published.'}
            </span>
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              className="od-button"
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
                className="od-button"
                onClick={() => {
                  store.getState().apply('Unpublish library', unpublishLibrary);
                  app.saveNow();
                }}
              >
                Unpublish
              </button>
            )}
          </div>
          <p className="m-0 text-faint">Other files get what was published, not what has changed since. Files that already use this library take a new version when they choose “Update”.</p>
        </section>

        <section aria-label="Libraries used in this file" className="flex flex-col gap-1.5">
          <h3 className="m-0 text-[11px] font-semibold uppercase tracking-wide text-dim">Used in this file</h3>
          {used.length === 0 && <p className="m-0 text-faint">No library has been added to this file.</p>}
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {used.map((library) => {
              const latest = available?.find((entry) => entry.id === library.id);
              const newer = latest !== undefined && latest.version > library.version;
              return (
                <li key={library.id} className="flex items-center gap-2 rounded border border-line px-2 py-1.5">
                  <div className="min-w-0 flex-1">
                    <div className="truncate">{latest?.name ?? library.name}</div>
                    <div className="text-dim">
                      Version {library.version}
                      {available === null ? '' : latest === undefined ? '. The library file is not published on this device any more; what this file has from it stays.' : newer ? `. Version ${latest.version} is available.` : '. Up to date.'}
                    </div>
                  </div>
                  {newer && (
                    <button type="button" className="od-button flex-none" aria-label={`Update ${library.name}`} onClick={() => take(library.id, 'Update library')}>
                      Update
                    </button>
                  )}
                  <button type="button" className="od-button flex-none" aria-label={`Remove ${library.name}`} onClick={() => store.getState().apply('Remove library', (d) => removeLibrary(d, library.id))}>
                    Remove
                  </button>
                </li>
              );
            })}
          </ul>
          {used.length > 0 && <p className="m-0 text-faint">Removing a library turns the instances of its components into ordinary frames; layers keep the look its styles and variables gave them.</p>}
        </section>

        <section aria-label="Available libraries" className="flex flex-col gap-1.5">
          <h3 className="m-0 text-[11px] font-semibold uppercase tracking-wide text-dim">Available</h3>
          {available === null && <p className="m-0 text-faint">Looking for published files…</p>}
          {available !== null && available.filter((entry) => !used.some((library) => library.id === entry.id)).length === 0 && (
            <p className="m-0 text-faint">No other published file on this device. To make one, open a file, choose Libraries and publish it.</p>
          )}
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {(available ?? [])
              .filter((entry) => !used.some((library) => library.id === entry.id))
              .map((entry) => (
                <li key={entry.id} className="flex items-center gap-2 rounded border border-line px-2 py-1.5">
                  <div className="min-w-0 flex-1">
                    <div className="truncate">{entry.name}</div>
                    <div className="text-dim">
                      {contents(entry)}. Version {entry.version}.
                    </div>
                  </div>
                  <button type="button" className="od-button flex-none" aria-label={`Add ${entry.name}`} onClick={() => take(entry.id, 'Add library')}>
                    Add to this file
                  </button>
                </li>
              ))}
          </ul>
          {problem && (
            <p role="alert" className="m-0 text-dim">
              {problem}
            </p>
          )}
        </section>
      </div>
    </Dialog>
  );
}
