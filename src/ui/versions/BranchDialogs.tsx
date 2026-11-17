import { useEffect, useMemo, useState } from 'react';
import type { Document } from '../../core';
import { errorMessage } from '../../collab/api';
import {
  diffList,
  documentFromVersion,
  groupConflicts,
  nodesIn,
  resolutionsFor,
  versionTime,
  type BranchInfo,
  type ConflictGroup,
  type MergePreview,
  type Resolution,
  type UpdatePreview,
  type VersionsApi,
} from '../../collab/versions';
import { Dialog } from '../components/Dialog';
import { ConflictIcon } from './icons';
import { DiffListView } from './CompareView';

/**
 * Branches of a shared file: making one, the list of a file's branches,
 * updating a branch from main, and the review that merges it into main, each
 * with a choice per conflicting layer.
 */

/** Opens a shared document in this window. */
export function openSharedDocument(docId: string): void {
  window.location.hash = `#/doc/${docId}`;
}

export function CreateBranchDialog({ api, mainId, mainName, onClose, open = openSharedDocument }: { api: VersionsApi; mainId: string; mainName: string; onClose: () => void; open?: (docId: string) => void }) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = (): void => {
    if (!name.trim()) {
      setError('Give the branch a name.');
      return;
    }
    setBusy(true);
    api.createBranch(mainId, name.trim()).then(
      (branch) => {
        onClose();
        open(branch.id);
      },
      (reason: unknown) => {
        setError(errorMessage(reason));
        setBusy(false);
      },
    );
  };
  return (
    <Dialog
      title="Create branch"
      onClose={onClose}
      width={400}
      footer={
        <>
          <button type="button" className="ev-button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="ev-button ev-button-primary" disabled={busy} onClick={submit}>
            {busy ? 'Creating…' : 'Create'}
          </button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <p className="m-0 text-dim">A branch is a copy of “{mainName}” to work on apart. Its changes reach the main file only when you merge it.</p>
        <label className="flex flex-col gap-1.5">
          <span className="text-dim">Branch name</span>
          <input data-autofocus className="ev-field h-8 px-2.5" value={name} maxLength={200} placeholder="e.g. New checkout" onChange={(event) => setName(event.target.value)} />
        </label>
        {error && (
          <p role="alert" className="m-0 text-danger">
            {error}
          </p>
        )}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

export function BranchListDialog({ api, mainId, onClose, onCreate, open = openSharedDocument }: { api: VersionsApi; mainId: string; onClose: () => void; onCreate?: () => void; open?: (docId: string) => void }) {
  const [branches, setBranches] = useState<BranchInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.listBranches(mainId).then(
      (list) => live && setBranches(list),
      (reason: unknown) => live && setError(errorMessage(reason)),
    );
    return () => {
      live = false;
    };
  }, [api, mainId]);
  return (
    <Dialog
      title="Branches"
      onClose={onClose}
      width={460}
      footer={
        onCreate && (
          <button type="button" className="ev-button ev-button-primary" onClick={onCreate}>
            Create branch…
          </button>
        )
      }
    >
      {error && (
        <p role="alert" className="m-0 text-danger">
          {error}
        </p>
      )}
      {branches === null && !error && <p className="m-0 text-dim">Reading…</p>}
      {branches?.length === 0 && <p className="m-0 text-dim">This file has no branches yet.</p>}
      {branches && branches.length > 0 && (
        <ul aria-label="Branches of this file" className="m-0 flex list-none flex-col gap-1 p-0">
          {branches.map((branch) => (
            <li key={branch.id} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-hover">
              <span className="min-w-0 flex-1">
                <span className="block truncate font-semibold">{branch.name}</span>
                <span className="block truncate text-[11px] text-dim">
                  {branch.status === 'merged' ? `Merged ${branch.mergedAt ? versionTime(branch.mergedAt) : ''}` : `By ${branch.createdBy.name}, ${versionTime(branch.createdAt)}`}
                </span>
              </span>
              {branch.status === 'merged' && <span className="rounded-md bg-field px-1.5 py-0.5 text-[11px] text-dim">Archived</span>}
              <button
                type="button"
                className="ev-button"
                onClick={() => {
                  onClose();
                  open(branch.id);
                }}
              >
                Open
              </button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}

/** The two documents of a branch and its main file, as they are on the server. */
function useBranchDocuments(api: VersionsApi, branch: BranchInfo): { main: Document | null; branchDoc: Document | null; error: string | null } {
  const [docs, setDocs] = useState<{ main: Document | null; branchDoc: Document | null; error: string | null }>({ main: null, branchDoc: null, error: null });
  useEffect(() => {
    let live = true;
    Promise.all([api.registers(branch.mainId), api.registers(branch.id)]).then(
      ([main, own]) => {
        if (!live) return;
        setDocs({
          main: documentFromVersion(main.registers, { id: branch.mainId, name: branch.mainName }),
          branchDoc: documentFromVersion(own.registers, { id: branch.id, name: branch.name }),
          error: null,
        });
      },
      (reason: unknown) => live && setDocs({ main: null, branchDoc: null, error: errorMessage(reason) }),
    );
    return () => {
      live = false;
    };
  }, [api, branch]);
  return docs;
}

/** The conflicts, one per layer, each with a choice of which side to keep. */
export function ConflictChoices({ groups, choices, onChoose }: { groups: readonly ConflictGroup[]; choices: Readonly<Record<string, Resolution>>; onChoose: (id: string, choice: Resolution) => void }) {
  return (
    <ul aria-label="Conflicts" className="m-0 flex list-none flex-col gap-1.5 p-0">
      {groups.map((group) => (
        <li key={group.id} className="flex items-center gap-2.5 rounded-lg bg-field px-2.5 py-2">
          <ConflictIcon />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-semibold">{group.label}</span>
            <span className="block truncate text-[11px] text-dim">{group.props.join(', ')}</span>
          </span>
          <div role="radiogroup" aria-label={`Keep for ${group.label}`} className="ev-segmented w-48 flex-none">
            {(
              [
                ['main', 'Keep main'],
                ['branch', 'Take branch'],
              ] as const
            ).map(([value, text]) => (
              <button key={value} type="button" role="radio" aria-checked={choices[group.id] === value} aria-selected={choices[group.id] === value} className="ev-segment text-[11px]" onClick={() => onChoose(group.id, value)}>
                {text}
              </button>
            ))}
          </div>
        </li>
      ))}
    </ul>
  );
}

export function UpdateFromMainDialog({ api, branch, onClose, onDone }: { api: VersionsApi; branch: BranchInfo; onClose: () => void; onDone?: (message: string) => void }) {
  const [preview, setPreview] = useState<UpdatePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [choices, setChoices] = useState<Record<string, Resolution>>({});
  const [busy, setBusy] = useState(false);
  const { main, branchDoc } = useBranchDocuments(api, branch);
  useEffect(() => {
    let live = true;
    api.updatePreview(branch.id).then(
      (answer) => live && setPreview(answer),
      (reason: unknown) => live && setError(errorMessage(reason)),
    );
    return () => {
      live = false;
    };
  }, [api, branch]);
  const groups = useMemo(() => groupConflicts(preview?.conflicts ?? [], main, branchDoc), [preview, main, branchDoc]);
  const unresolved = groups.filter((group) => !choices[group.id]).length;
  // What main changed, by layer: main against the branch, limited to the layers main changed.
  const changed = useMemo(() => {
    if (!preview || !main || !branchDoc) return [];
    const nodes = nodesIn(preview.changes.map((change) => change.key));
    return diffList(branchDoc, main).filter((diff) => nodes.has(diff.id));
  }, [preview, main, branchDoc]);

  const apply = (): void => {
    setBusy(true);
    api.updateFromMain(branch.id, resolutionsFor(groups, choices)).then(
      (result) => {
        onDone?.(`Updated from “${branch.mainName}”: ${result.applied} ${result.applied === 1 ? 'change' : 'changes'} brought in.`);
        onClose();
      },
      (reason: unknown) => {
        setError(errorMessage(reason));
        setBusy(false);
      },
    );
  };

  return (
    <Dialog
      title="Update from main"
      onClose={onClose}
      width={560}
      footer={
        <>
          <button type="button" className="ev-button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="ev-button ev-button-primary" disabled={busy || !preview || unresolved > 0 || preview.changes.length === 0} onClick={apply}>
            {busy ? 'Updating…' : 'Update branch'}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error && (
          <p role="alert" className="m-0 text-danger">
            {error}
          </p>
        )}
        {!preview && !error && <p className="m-0 text-dim">Comparing with the main file…</p>}
        {preview && preview.changes.length === 0 && <p className="m-0">This branch is up to date with “{branch.mainName}”.</p>}
        {preview && preview.changes.length > 0 && (
          <>
            <p className="m-0">
              “{branch.mainName}” has {preview.changes.length} {preview.changes.length === 1 ? 'change' : 'changes'} since this branch was made or last updated.
              {groups.length > 0 ? ' Some of them are to layers this branch changed too: choose what to keep for each.' : ' None conflicts with this branch’s own.'}
            </p>
            {groups.length > 0 && <ConflictChoices groups={groups} choices={choices} onChoose={(id, choice) => setChoices((all) => ({ ...all, [id]: choice }))} />}
            <section aria-label="Changes in main">
              <h3 className="ev-section-title mb-1">Changed in main</h3>
              <DiffListView diffs={changed} empty="Changes to styles, variables or the library only." />
            </section>
          </>
        )}
      </div>
    </Dialog>
  );
}

export function MergeDialog({ api, branch, onClose, onDone, open = openSharedDocument }: { api: VersionsApi; branch: BranchInfo; onClose: () => void; onDone?: (message: string) => void; open?: (docId: string) => void }) {
  const [preview, setPreview] = useState<MergePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [choices, setChoices] = useState<Record<string, Resolution>>({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const { main, branchDoc } = useBranchDocuments(api, branch);
  useEffect(() => {
    let live = true;
    api.mergePreview(branch.id).then(
      (answer) => live && setPreview(answer),
      (reason: unknown) => live && setError(errorMessage(reason)),
    );
    return () => {
      live = false;
    };
  }, [api, branch]);
  const groups = useMemo(() => groupConflicts(preview?.conflicts ?? [], main, branchDoc), [preview, main, branchDoc]);
  const unresolved = groups.filter((group) => !choices[group.id]).length;
  // The branch's changes against main, by layer: limited to the layers the branch changed.
  const changed = useMemo(() => {
    if (!preview || !main || !branchDoc) return [];
    const nodes = nodesIn(preview.changes.map((change) => change.key));
    return diffList(main, branchDoc).filter((diff) => nodes.has(diff.id));
  }, [preview, main, branchDoc]);

  const merge = (): void => {
    setBusy(true);
    api.merge(branch.id, resolutionsFor(groups, choices)).then(
      (result) => {
        const said = `Merged into “${branch.mainName}”: ${result.applied} ${result.applied === 1 ? 'change' : 'changes'}. To undo the merge, restore “${result.before.name}” in its version history.`;
        setDone(said);
        onDone?.(said);
        setBusy(false);
      },
      (reason: unknown) => {
        setError(errorMessage(reason));
        setBusy(false);
      },
    );
  };

  return (
    <Dialog
      title={`Merge “${branch.name}” into main`}
      onClose={onClose}
      width={600}
      footer={
        done ? (
          <>
            <button type="button" className="ev-button" onClick={onClose}>
              Stay on branch
            </button>
            <button
              type="button"
              className="ev-button ev-button-primary"
              onClick={() => {
                onClose();
                open(branch.mainId);
              }}
            >
              Open main file
            </button>
          </>
        ) : (
          <>
            <button type="button" className="ev-button" onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="ev-button ev-button-primary" disabled={busy || !preview?.canMerge || unresolved > 0 || preview.changes.length === 0} onClick={merge}>
              {busy ? 'Merging…' : 'Merge branch'}
            </button>
          </>
        )
      }
    >
      <div className="flex flex-col gap-3">
        {error && (
          <p role="alert" className="m-0 text-danger">
            {error}
          </p>
        )}
        {done && (
          <p role="status" className="m-0">
            {done}
          </p>
        )}
        {!done && !preview && !error && <p className="m-0 text-dim">Reviewing the branch’s changes…</p>}
        {!done && preview && (
          <>
            {preview.status === 'merged' && <p className="m-0">This branch has already been merged. It is kept, archived, to look at.</p>}
            {preview.status === 'open' && !preview.canMerge && <p className="m-0 text-dim">Only editors of “{branch.mainName}” can merge into it. You can review the changes.</p>}
            {preview.changes.length === 0 ? (
              <p className="m-0">This branch has no changes to merge.</p>
            ) : (
              <p className="m-0">
                {preview.changes.length} {preview.changes.length === 1 ? 'change' : 'changes'} will be merged into “{branch.mainName}”. A version of main is saved before and after, so the merge can be undone.
              </p>
            )}
            {groups.length > 0 && (
              <section aria-label="Conflicts to resolve" className="flex flex-col gap-1.5">
                <h3 className="ev-section-title">Conflicts</h3>
                <p className="m-0 text-dim">These layers were changed in main too since the branch was made or last updated.</p>
                <ConflictChoices groups={groups} choices={choices} onChoose={(id, choice) => setChoices((all) => ({ ...all, [id]: choice }))} />
              </section>
            )}
            <section aria-label="Changes in this branch">
              <h3 className="ev-section-title mb-1">Changes</h3>
              <DiffListView diffs={changed} empty={preview.changes.length > 0 ? 'Changes to styles, variables or the library only.' : 'No changes.'} />
            </section>
          </>
        )}
      </div>
    </Dialog>
  );
}
