import { COMMANDS, getCommand, runCommand, type Command, type CommandEnv, type CommandGroup } from '../../state/commands';
import type { EditorState } from '../../state/editorStore';
import type { MenuItem } from '../components/Menu';

/** Builds a menu item from a command, so menus and shortcuts can never disagree. */
export function commandItem(id: string, env: CommandEnv, state: EditorState, label?: string): MenuItem {
  const command = getCommand(id);
  if (!command) throw new Error(`Unknown command "${id}"`);
  return {
    label: label ?? command.label,
    shortcut: command.shortcut,
    disabled: command.enabled ? !command.enabled(state) : false,
    checked: command.checked?.(state),
    onSelect: () => void runCommand(command, env),
  };
}

const separator: MenuItem = { type: 'separator' };

/** The menu shown when right-clicking a layer on the canvas or in the layers panel. */
export function layerMenu(env: CommandEnv, state: EditorState): MenuItem[] {
  const item = (id: string, label?: string): MenuItem => commandItem(id, env, state, label);
  return [
    item('edit.copy'),
    item('edit.cut'),
    item('edit.paste'),
    item('edit.duplicate'),
    separator,
    item('object.group'),
    item('object.ungroup'),
    separator,
    item('object.front'),
    item('object.forward'),
    item('object.backward'),
    item('object.back'),
    separator,
    item('object.flipHorizontal'),
    item('object.flipVertical'),
    separator,
    item('object.rename'),
    item('object.toggleVisible'),
    item('object.toggleLocked'),
    separator,
    item('view.zoomSelection'),
    separator,
    { ...item('edit.delete'), danger: true } as MenuItem,
  ];
}

/** The menu shown when right-clicking empty canvas. */
export function canvasMenu(env: CommandEnv, state: EditorState): MenuItem[] {
  const item = (id: string): MenuItem => commandItem(id, env, state);
  return [
    item('edit.paste'),
    item('edit.selectAll'),
    separator,
    item('view.zoomFit'),
    item('view.zoom100'),
    item('view.zoomIn'),
    item('view.zoomOut'),
  ];
}

const MENU_ORDER: Record<Exclude<CommandGroup, 'Tools'>, string[]> = {
  File: ['file.home', '-', 'file.placeImage', '-', 'file.save', 'file.saveAs'],
  Edit: [
    'edit.undo',
    'edit.redo',
    '-',
    'edit.cut',
    'edit.copy',
    'edit.paste',
    'edit.duplicate',
    'edit.delete',
    '-',
    'edit.selectAll',
    'edit.deselect',
  ],
  View: ['view.zoomIn', 'view.zoomOut', '-', 'view.zoomFit', 'view.zoomSelection', 'view.zoom100', '-', 'view.snapping'],
  Object: [
    'object.group',
    'object.ungroup',
    '-',
    'object.flipHorizontal',
    'object.flipVertical',
    '-',
    'object.front',
    'object.forward',
    'object.backward',
    'object.back',
    '-',
    'object.editText',
    'object.rename',
    'object.toggleVisible',
    'object.toggleLocked',
  ],
  Arrange: [
    'arrange.align.left',
    'arrange.align.centerX',
    'arrange.align.right',
    '-',
    'arrange.align.top',
    'arrange.align.centerY',
    'arrange.align.bottom',
    '-',
    'arrange.distribute.horizontal',
    'arrange.distribute.vertical',
  ],
  Help: ['help.shortcuts'],
};

/** The application's main menu: File, Edit, View, Object, Arrange, Help. */
export function mainMenu(env: CommandEnv, state: EditorState, extra: { renameFile: () => void }): MenuItem[] {
  const build = (ids: string[]): MenuItem[] => ids.map((id) => (id === '-' ? separator : commandItem(id, env, state)));
  const file = build(MENU_ORDER.File);
  file.splice(1, 0, { label: 'Rename file…', onSelect: extra.renameFile });
  return [
    { type: 'submenu', label: 'File', items: file },
    { type: 'submenu', label: 'Edit', items: build(MENU_ORDER.Edit) },
    { type: 'submenu', label: 'View', items: build(MENU_ORDER.View) },
    { type: 'submenu', label: 'Object', items: build(MENU_ORDER.Object) },
    { type: 'submenu', label: 'Arrange', items: build(MENU_ORDER.Arrange) },
    { type: 'submenu', label: 'Help', items: build(MENU_ORDER.Help) },
  ];
}

/** Commands grouped for the keyboard shortcut reference. Only commands that have a shortcut are listed. */
export function shortcutGroups(): { group: CommandGroup; commands: Command[] }[] {
  const order: CommandGroup[] = ['Tools', 'Edit', 'Object', 'Arrange', 'View', 'File', 'Help'];
  return order
    .map((group) => ({ group, commands: COMMANDS.filter((c) => c.group === group && c.shortcut) }))
    .filter((entry) => entry.commands.length > 0);
}
