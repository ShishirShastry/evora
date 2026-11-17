import type { MenuItem } from '../components/Menu';
import type { CommandEnv } from '../../state/commands';
import type { EditorState } from '../../state/editorStore';
import { versionsActions, versionsUi } from './state';

/** Phase 9: the editor's main-menu entries for version history and branching; shown as a submenu when there are any. */
export function menuItems(_env: CommandEnv, state: EditorState): MenuItem[] {
  const ui = versionsUi.getState();
  const { context } = ui;
  const canEdit = context.canEdit && !state.readOnly;
  const items: MenuItem[] = [
    { label: 'Show version history', checked: ui.panelOpen, onSelect: () => versionsActions.openPanel(!ui.panelOpen) },
    { label: 'Save to version history…', shortcut: 'Ctrl+Alt+S', disabled: !canEdit, onSelect: () => versionsActions.openSave() },
    { label: 'Compare versions…', onSelect: () => versionsActions.openCompare() },
  ];
  // Branches are of shared files: they live on the collaboration server.
  if (context.shared) {
    const branch = context.branch;
    items.push({ type: 'separator' });
    if (branch) {
      items.push(
        { label: 'Update from main…', disabled: !canEdit || branch.status !== 'open', onSelect: () => versionsActions.openBranchDialog('update') },
        { label: 'Merge into main…', disabled: branch.status !== 'open', onSelect: () => versionsActions.openBranchDialog('merge') },
        { label: 'Show branches of main…', onSelect: () => versionsActions.openBranchDialog('list') },
      );
    } else {
      items.push(
        { label: 'Create branch…', disabled: !canEdit || !context.signedIn, onSelect: () => versionsActions.openBranchDialog('create') },
        { label: 'Show branches…', onSelect: () => versionsActions.openBranchDialog('list') },
      );
    }
  }
  return items;
}
