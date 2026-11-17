import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import type { Document } from '../../core';
import type { BranchInfo } from '../../collab/versions';
import type { VersionEntry } from './source';

/**
 * What the version history interface shows, shared by the main menu's items
 * (`menu.ts`) and what `VersionsMount` draws: one small store, so a menu item
 * only has to say what to open.
 */

/** Why a merged branch is view-only, in the server's words (`mergedReason` in server/versions.ts). */
export function mergedBranchReason(branch: Pick<BranchInfo, 'mainName'>): string {
  return `This branch has been merged into ${branch.mainName}; it can be viewed but not changed`;
}

/** A side of a comparison: a version's ID, or the file as it is now. */
export const CURRENT = 'current';

export type BranchDialog = 'create' | 'list' | 'update' | 'merge' | null;

export interface VersionsContext {
  /** The open file is shared (on the collaboration server). */
  shared: boolean;
  docId: string | null;
  /** The person may change the file (and so save, rename, delete and restore versions). */
  canEdit: boolean;
  /** Signed in with an account (making a branch needs one). */
  signedIn: boolean;
  /** Set when the open file is a branch. */
  branch: BranchInfo | null;
}

export interface VersionsUiState {
  context: VersionsContext;
  panelOpen: boolean;
  saveOpen: boolean;
  /** The version shown read-only on the canvas. */
  viewing: { entry: VersionEntry; doc: Document } | null;
  /** The comparison that is open: two sides, each a version ID or CURRENT (null: the newest version). */
  compare: { a: string | null; b: string } | null;
  branchDialog: BranchDialog;
  /** Goes up when the list of versions should be read again. */
  revision: number;
}

export const initialVersionsState = (): VersionsUiState => ({
  context: { shared: false, docId: null, canEdit: true, signedIn: false, branch: null },
  panelOpen: false,
  saveOpen: false,
  viewing: null,
  compare: null,
  branchDialog: null,
  revision: 0,
});

export const versionsUi = createStore<VersionsUiState>()(() => initialVersionsState());

export function useVersionsUi<T>(selector: (state: VersionsUiState) => T): T {
  return useStore(versionsUi, selector);
}

export const versionsActions = {
  openPanel(open = true): void {
    versionsUi.setState(open ? { panelOpen: true } : { panelOpen: false, viewing: null });
  },
  openSave(open = true): void {
    versionsUi.setState({ saveOpen: open });
  },
  view(viewing: VersionsUiState['viewing']): void {
    versionsUi.setState({ viewing });
  },
  openCompare(a: string | null = null, b: string = CURRENT): void {
    versionsUi.setState({ compare: { a, b } });
  },
  closeCompare(): void {
    versionsUi.setState({ compare: null });
  },
  openBranchDialog(dialog: BranchDialog): void {
    versionsUi.setState({ branchDialog: dialog });
  },
  /** The list of versions changed. */
  changed(): void {
    versionsUi.setState((state) => ({ revision: state.revision + 1 }));
  },
  setContext(context: Partial<VersionsContext>): void {
    versionsUi.setState((state) => ({ context: { ...state.context, ...context } }));
  },
  /** Back to nothing open (the editor closed). */
  reset(): void {
    versionsUi.setState(initialVersionsState());
  },
};
