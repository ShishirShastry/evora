import { useEffect, useMemo, useRef, useState } from 'react';
import { errorMessage } from '../../collab/api';
import { versionLabel, versionsApi, type VersionsApi } from '../../collab/versions';
import { AUTO_VERSION_INTERVAL_MS, localVersions, type LocalVersionStore } from '../../persistence/versions';
import { useOptionalCollab } from '../collab/CollabContext';
import { useAccount } from '../collab/hooks';
import { useEditor, useEditorContext } from '../editor/EditorContext';
import { BranchListDialog, CreateBranchDialog, MergeDialog, UpdateFromMainDialog } from './BranchDialogs';
import { CompareView } from './CompareView';
import { HistoryPanel, VersionInfoDialog, VersionViewer } from './HistoryPanel';
import { BranchIcon } from './icons';
import { localSource, sharedSource, type VersionEntry } from './source';
import { mergedBranchReason, useVersionsUi, versionsActions, versionsUi } from './state';

/**
 * Phase 9: version history and branching in the editor (panels, dialogs). Mounted once by EditorScreen.
 *
 * For a file on this device it also makes the automatic versions: when the
 * file is opened and differs from its latest version, and every ten minutes
 * while it changes. A shared file's automatic versions are made by the server.
 */
export function VersionsMount({ api = versionsApi, local = localVersions() }: { api?: VersionsApi; local?: LocalVersionStore } = {}) {
  const { store, images } = useEditorContext();
  const collab = useOptionalCollab();
  const docId = collab?.docId ?? null;
  const shared = docId !== null;
  const readOnly = useEditor((state) => state.readOnly);
  const doc = useEditor((state) => state.doc);
  const account = useAccount();
  const ui = useVersionsUi((state) => state);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const say = (message: string): void => setToast(message);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(timer);
  }, [toast]);

  // What the menu needs to know about the open file.
  useEffect(() => {
    versionsActions.setContext({ shared, docId, canEdit: !readOnly, signedIn: account !== null });
  }, [shared, docId, readOnly, account]);
  useEffect(() => () => versionsActions.reset(), []);

  // Whether a shared file is a branch, for its badge and the branch menu items. Read again when what one may do
  // changes: a branch merged by someone else turns read-only for everyone who has it open (the server says so).
  useEffect(() => {
    if (!docId) {
      versionsActions.setContext({ branch: null });
      return;
    }
    let live = true;
    api.branchInfo(docId).then(
      (branch) => {
        if (!live) return;
        const before = versionsUi.getState().context.branch;
        versionsActions.setContext({ branch });
        if (branch && branch.status === 'merged' && before?.id === branch.id && before.status === 'open') say(`${mergedBranchReason(branch)}.`);
      },
      () => live && versionsActions.setContext({ branch: null }),
    );
    return () => {
      live = false;
    };
  }, [api, docId, ui.revision, readOnly]);

  const source = useMemo(
    () => (docId ? sharedSource(docId, api, () => store.getState().doc.name) : localSource(store, local)),
    [docId, api, store, local],
  );

  // Automatic versions of a file on this device.
  const checked = useRef(store.getState().doc);
  useEffect(() => {
    if (shared || !local.available) return;
    let stopped = false;
    const fileId = store.getState().doc.id;
    const checkpoint = (): void => {
      const now = store.getState().doc;
      checked.current = now;
      void local.checkpoint(fileId, now).then(
        (made) => {
          if (made && !stopped) versionsActions.changed();
        },
        () => undefined,
      );
    };
    // Opened after changes since its last version: that is kept first.
    checkpoint();
    const timer = setInterval(() => {
      if (store.getState().doc !== checked.current) checkpoint();
    }, AUTO_VERSION_INTERVAL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [shared, local, store]);

  // Ctrl+Alt+Shift+S: Save to version history (Ctrl+Alt+S is "Subtract selection", beside the other shape operations).
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || !event.altKey || !event.shiftKey || event.code !== 'KeyS') return;
      event.preventDefault();
      if (versionsUi.getState().context.canEdit) versionsActions.openSave();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const view = (entry: VersionEntry | null): void => {
    if (!entry) {
      versionsActions.view(null);
      return;
    }
    source.content(entry).then(
      (content) => versionsActions.view({ entry, doc: content }),
      (reason: unknown) => say(errorMessage(reason)),
    );
  };

  const restoreViewed = (): void => {
    const viewing = versionsUi.getState().viewing;
    if (!viewing) return;
    setBusy(true);
    source
      .restore(viewing.entry)
      .then((said) => {
        say(said);
        versionsActions.view(null);
        versionsActions.changed();
      })
      .catch((reason: unknown) => say(errorMessage(reason)))
      .finally(() => setBusy(false));
  };

  const branch = ui.context.branch;
  const mainName = doc.name;

  return (
    <>
      {ui.panelOpen && (
        <HistoryPanel
          source={source}
          canEdit={!readOnly}
          revision={ui.revision}
          viewingId={ui.viewing?.entry.id ?? null}
          onView={view}
          onClose={() => versionsActions.openPanel(false)}
          onRestored={say}
        />
      )}
      {ui.panelOpen && ui.viewing && (
        <VersionViewer
          entry={ui.viewing.entry}
          doc={ui.viewing.doc}
          images={images}
          canEdit={!readOnly}
          busy={busy}
          onRestore={restoreViewed}
          onBack={() => versionsActions.view(null)}
        />
      )}
      {ui.saveOpen && (
        <VersionInfoDialog
          title="Save to version history"
          submitLabel="Save"
          onClose={() => versionsActions.openSave(false)}
          onSubmit={async (name, description) => {
            const made = await source.create(name, description);
            versionsActions.changed();
            say(`Saved “${versionLabel(made)}” to the version history.`);
          }}
        />
      )}
      {ui.compare && <CompareView source={source} current={doc} images={images} initial={ui.compare} onClose={() => versionsActions.closeCompare()} />}

      {docId && ui.branchDialog === 'create' && <CreateBranchDialog api={api} mainId={branch?.mainId ?? docId} mainName={branch?.mainName ?? mainName} onClose={() => versionsActions.openBranchDialog(null)} />}
      {docId && ui.branchDialog === 'list' && (
        <BranchListDialog
          api={api}
          mainId={branch?.mainId ?? docId}
          onClose={() => versionsActions.openBranchDialog(null)}
          onCreate={!readOnly && account && !branch ? () => versionsActions.openBranchDialog('create') : undefined}
        />
      )}
      {branch && ui.branchDialog === 'update' && (
        <UpdateFromMainDialog
          api={api}
          branch={branch}
          onClose={() => versionsActions.openBranchDialog(null)}
          onDone={(message) => {
            say(message);
            versionsActions.changed();
          }}
        />
      )}
      {branch && ui.branchDialog === 'merge' && (
        <MergeDialog
          api={api}
          branch={branch}
          onClose={() => versionsActions.openBranchDialog(null)}
          onDone={(message) => {
            say(message);
            versionsActions.changed();
          }}
        />
      )}

      {branch && (
        // Over the top of the canvas; on narrower screens, where the top is the file's header, above the tool dock instead.
        <div role="region" aria-label="Branch" className="ev-dock fixed bottom-[72px] left-1/2 z-30 flex max-w-[calc(100vw-12px)] -translate-x-1/2 items-center gap-2 !py-1 pl-2.5 pr-1 min-[1100px]:bottom-auto min-[1100px]:top-3">
          <span className="flex-none text-accent">
            <BranchIcon />
          </span>
          <span className="min-w-0 max-w-72 truncate">
            Branch of <strong>{branch.mainName}</strong>
            {branch.status === 'merged' ? <span className="text-dim" title={mergedBranchReason(branch)}> · merged, view only</span> : null}
          </span>
          {branch.status === 'open' && !readOnly && (
            <>
              <button type="button" className="ev-button h-7 flex-none" onClick={() => versionsActions.openBranchDialog('update')}>
                Update from main
              </button>
              <button type="button" className="ev-button ev-button-primary h-7 flex-none" onClick={() => versionsActions.openBranchDialog('merge')}>
                Merge into main
              </button>
            </>
          )}
          {branch.status === 'merged' && (
            <a className="ev-button h-7 flex-none no-underline" href={`#/doc/${branch.mainId}`}>
              Open main file
            </a>
          )}
        </div>
      )}

      {toast && (
        <div role="status" className="ev-popover fixed bottom-20 left-1/2 z-50 w-max max-w-[min(520px,calc(100vw-24px))] -translate-x-1/2 px-3.5 py-2.5">
          {toast}
        </div>
      )}
    </>
  );
}
