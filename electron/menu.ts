import { app, BrowserWindow, Menu, shell, type MenuItemConstructorOptions } from 'electron';
import { basename } from 'node:path';
import { clearRecent, recentFiles } from './files.js';
import { menuSpec, type SpecItem, type SpecialItem } from './menuSpec.js';

/**
 * The native menus (File, Edit, View, Window, Help, and the app menu on
 * macOS), made from electron/menuSpec.ts. A command item sends its ID to the
 * focused window, which runs it. On Windows and Linux the app's own shortcuts
 * are only shown in the menus, not taken by them, so the editor keeps
 * handling its keys (text fields keep theirs); on macOS, where a menu always
 * takes its shortcuts, only those with ⌘ are given.
 */

export interface MenuActions {
  command(window: BrowserWindow | null, id: string): void;
  special(window: BrowserWindow | null, id: SpecialItem['id']): void;
  openRecent(path: string): void;
}

export function buildMenu(actions: MenuActions): void {
  const focused = (): BrowserWindow | null => BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;

  const recentMenu = (): MenuItemConstructorOptions[] => {
    const list = recentFiles();
    const items: MenuItemConstructorOptions[] = list.map((path) => ({ label: basename(path), sublabel: path, click: () => actions.openRecent(path) }));
    if (items.length === 0) items.push({ label: 'No recent files', enabled: false });
    items.push({ type: 'separator' }, { label: 'Clear the list', enabled: list.length > 0, click: () => clearRecent() });
    return items;
  };

  const item = (spec: SpecItem): MenuItemConstructorOptions => {
    switch (spec.kind) {
      case 'separator':
        return { type: 'separator' };
      case 'role':
        return { role: spec.role, label: spec.label };
      case 'command':
        return {
          label: spec.label,
          accelerator: spec.accelerator,
          // Shown, but left to the window on Windows and Linux (macOS always takes a menu's shortcut).
          registerAccelerator: false,
          click: () => actions.command(focused(), spec.id),
        };
      case 'special':
        if (spec.id === 'recent') return { label: spec.label, submenu: recentMenu() };
        return { label: spec.label, accelerator: spec.accelerator, click: () => actions.special(focused(), spec.id) };
    }
  };

  const template: MenuItemConstructorOptions[] = menuSpec(process.platform).map((menu) => ({
    label: menu.label,
    role: menu.role,
    submenu: menu.items.map(item),
  }));
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

export const PROJECT_URL = 'https://github.com/ShishirShastry/evora';

export function openProjectPage(path = ''): void {
  void shell.openExternal(`${PROJECT_URL}${path}`);
}

export function appVersion(): string {
  return app.getVersion();
}
