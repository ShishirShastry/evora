/**
 * What the desktop app's menus hold, as plain data (electron/menu.ts makes
 * the native menus from it). Items with an app command's ID run that command
 * (src/state/commands.ts) in the window, with its label and shortcut, so the
 * menus and the editor never disagree; a unit test checks them against the
 * commands. `desktop.*` items are the desktop app's own, handled in the
 * window by src/ui/desktop/DesktopMount.tsx; `special` items in the main
 * process.
 */

export interface CommandItem {
  kind: 'command';
  id: string;
  label: string;
  /** The shortcut, in Electron's accelerator syntax. */
  accelerator?: string;
}

export interface SpecialItem {
  kind: 'special';
  id:
    | 'newWindow'
    | 'recent'
    | 'closeWindow'
    | 'quit'
    | 'checkUpdates'
    | 'about'
    | 'devtools'
    | 'reload'
    | 'website'
    | 'issues'
    | 'dataFolder'
    | 'fullscreen';
  label: string;
  accelerator?: string;
}

export interface RoleItem {
  kind: 'role';
  role: 'about' | 'services' | 'hide' | 'hideOthers' | 'unhide' | 'quit' | 'minimize' | 'zoom' | 'front' | 'window' | 'togglefullscreen' | 'close';
  label?: string;
}

export type SpecItem = CommandItem | SpecialItem | RoleItem | { kind: 'separator' };

export interface SpecMenu {
  label: string;
  /** The macOS app menu, the Window menu and Help have a role on macOS. */
  role?: 'appMenu' | 'windowMenu' | 'help';
  items: SpecItem[];
}

/** An app shortcut as written in src/state/commands.ts (e.g. "Ctrl+Shift+Z", "Ctrl++") in Electron's syntax. */
export function toAccelerator(shortcut: string): string {
  const parts: string[] = [];
  let rest = shortcut;
  // "Ctrl++" ends in the "+" key itself.
  let key = '';
  if (rest.endsWith('++')) {
    key = 'Plus';
    rest = rest.slice(0, -2);
  } else {
    const index = rest.lastIndexOf('+');
    key = index >= 0 ? rest.slice(index + 1) : rest;
    rest = index >= 0 ? rest.slice(0, index) : '';
  }
  for (const modifier of rest.split('+').filter(Boolean)) parts.push(modifier === 'Ctrl' ? 'CmdOrCtrl' : modifier);
  const keys: Record<string, string> = { Esc: 'Escape', '←': 'Left', '→': 'Right', '↑': 'Up', '↓': 'Down' };
  parts.push(keys[key] ?? key);
  return parts.join('+');
}

const separator = { kind: 'separator' } as const;
const command = (id: string, label: string, shortcut?: string): CommandItem => ({ kind: 'command', id, label, accelerator: shortcut ? toAccelerator(shortcut) : undefined });

/** The menus for a platform ("darwin" gets the app menu and macOS's Window menu). */
export function menuSpec(platform: string): SpecMenu[] {
  const mac = platform === 'darwin';
  const menus: SpecMenu[] = [];
  if (mac) {
    menus.push({
      label: 'Evora',
      role: 'appMenu',
      items: [
        { kind: 'role', role: 'about', label: 'About Evora' },
        { kind: 'special', id: 'checkUpdates', label: 'Check for updates…' },
        separator,
        command('desktop.settings', 'Collaboration…'),
        separator,
        { kind: 'role', role: 'services' },
        separator,
        { kind: 'role', role: 'hide', label: 'Hide Evora' },
        { kind: 'role', role: 'hideOthers' },
        { kind: 'role', role: 'unhide' },
        separator,
        { kind: 'role', role: 'quit', label: 'Quit Evora' },
      ],
    });
  }
  menus.push({
    label: 'File',
    items: [
      command('desktop.new', 'New design file'),
      { kind: 'special', id: 'newWindow', label: 'New window', accelerator: 'CmdOrCtrl+Shift+N' },
      separator,
      command('desktop.open', 'Open…', 'Ctrl+O'),
      { kind: 'special', id: 'recent', label: 'Open recent' },
      separator,
      command('desktop.save', 'Save', 'Ctrl+S'),
      command('desktop.saveAs', 'Save as…', 'Ctrl+Shift+S'),
      command('desktop.saveFig', 'Save a copy as .fig…'),
      separator,
      command('file.placeImage', 'Place image…', 'Ctrl+Shift+K'),
      command('file.export', 'Export…', 'Ctrl+Shift+E'),
      command('file.libraries', 'Libraries…'),
      command('file.share', 'Share…'),
      separator,
      ...(mac ? [] : [command('desktop.settings', 'Collaboration…'), separator]),
      command('file.home', 'Back to files'),
      { kind: 'special', id: 'closeWindow', label: mac ? 'Close window' : 'Close window', accelerator: mac ? 'Cmd+W' : 'Ctrl+W' },
      ...(mac ? [] : [{ kind: 'special', id: 'quit', label: 'Exit', accelerator: 'Alt+F4' } as SpecialItem]),
    ],
  });
  // Shortcuts without Ctrl/Cmd are only shown off macOS, where a menu would take those keys from text fields.
  const plain = (id: string, label: string, shortcut: string): CommandItem => (mac ? command(id, label) : command(id, label, shortcut));
  menus.push({
    label: 'Edit',
    items: [
      command('edit.undo', 'Undo', 'Ctrl+Z'),
      command('edit.redo', 'Redo', 'Ctrl+Shift+Z'),
      separator,
      command('edit.cut', 'Cut', 'Ctrl+X'),
      command('edit.copy', 'Copy', 'Ctrl+C'),
      command('edit.paste', 'Paste', 'Ctrl+V'),
      command('edit.duplicate', 'Duplicate', 'Ctrl+D'),
      plain('edit.delete', 'Delete', 'Delete'),
      separator,
      command('edit.selectAll', 'Select all', 'Ctrl+A'),
      separator,
      command('edit.copyAsPng', 'Copy as PNG', 'Ctrl+Shift+C'),
      command('edit.copyAsSvg', 'Copy as SVG'),
      command('edit.copyAsCss', 'Copy as CSS'),
    ],
  });
  menus.push({
    label: 'View',
    items: [
      command('view.zoomIn', 'Zoom in', 'Ctrl++'),
      command('view.zoomOut', 'Zoom out', 'Ctrl+-'),
      plain('view.zoomFit', 'Zoom to fit', 'Shift+1'),
      plain('view.zoomSelection', 'Zoom to selection', 'Shift+2'),
      plain('view.zoom100', 'Zoom to 100%', 'Shift+0'),
      separator,
      plain('view.rulers', 'Rulers and guides', 'Shift+R'),
      plain('view.layoutGrids', 'Show layout grids', 'Shift+G'),
      command('view.snapping', 'Snap to objects', "Ctrl+Shift+'"),
      command('view.pixelSnap', 'Snap to pixel grid', "Ctrl+Alt+'"),
      separator,
      plain('view.prototypeTab', 'Prototype panel', 'Shift+E'),
      plain('view.inspectTab', 'Developer mode (Inspect)', 'Shift+D'),
      command('view.present', 'Present prototype', 'Ctrl+Alt+Enter'),
      separator,
      command('view.lightTheme', 'Light theme'),
      { kind: 'special', id: 'fullscreen', label: 'Full screen', accelerator: mac ? 'Ctrl+Cmd+F' : 'F11' },
    ],
  });
  menus.push({
    label: 'Window',
    role: mac ? 'windowMenu' : undefined,
    items: mac
      ? [{ kind: 'role', role: 'minimize' }, { kind: 'role', role: 'zoom' }, separator, { kind: 'special', id: 'newWindow', label: 'New window' }, separator, { kind: 'role', role: 'front' }]
      : [{ kind: 'role', role: 'minimize' }, { kind: 'special', id: 'newWindow', label: 'New window' }, { kind: 'role', role: 'close', label: 'Close window' }],
  });
  menus.push({
    label: 'Help',
    role: mac ? 'help' : undefined,
    items: [
      command('help.shortcuts', 'Keyboard shortcuts', 'Ctrl+/'),
      separator,
      ...(mac ? [] : [{ kind: 'special', id: 'checkUpdates', label: 'Check for updates…' } as SpecialItem]),
      { kind: 'special', id: 'website', label: 'Evora on GitHub' },
      { kind: 'special', id: 'issues', label: 'Report a problem' },
      { kind: 'special', id: 'dataFolder', label: 'Show the app’s data folder' },
      separator,
      { kind: 'special', id: 'reload', label: 'Reload window' },
      { kind: 'special', id: 'devtools', label: 'Developer tools', accelerator: mac ? 'Alt+Cmd+I' : 'Ctrl+Shift+I' },
      ...(mac ? [] : [separator, { kind: 'special', id: 'about', label: 'About Evora' } as SpecialItem]),
    ],
  });
  return menus;
}

