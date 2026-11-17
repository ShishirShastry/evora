// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PluginRegistry } from '../../plugins/storage';
import { example } from '../../plugins/testing';
import { editor } from '../../plugins/testing';
import type { AppActions } from '../../state/commands';
import type { MenuItem } from '../components/Menu';
import { menuItems } from './menu';
import { InstallDialog, PluginManager } from './PluginManager';
import { pluginsStore, refreshInstalled, setPluginRegistry } from './state';

/**
 * The plugin manager, rendered: a plugin is installed only after its
 * permissions are shown and agreed to, then listed with its version and
 * maker, turned off and on, and uninstalled; and the Plugins menu lists what
 * is installed and enabled.
 */

let registry: PluginRegistry;
let n = 0;

beforeEach(async () => {
  registry = new PluginRegistry(new IDBFactory(), `plugins-ui-${n++}`, IDBKeyRange);
  setPluginRegistry(registry);
  pluginsStore.setState({ installed: [], loaded: false, managerOpen: false, pendingInstall: null, running: [], consoles: {}, lastRun: null, toasts: [], actions: null });
  await refreshInstalled();
});

afterEach(() => {
  cleanup();
  setPluginRegistry(null);
});

function Pending() {
  const pending = pluginsStore.getState().pendingInstall;
  return pending ? <InstallDialog bundle={pending.bundle} source={pending.source} /> : null;
}

const labels = (items: MenuItem[]): unknown[] =>
  items.map((item) => (item.type === 'separator' ? '—' : item.type === 'submenu' ? { [item.label]: labels(item.items) } : item.label));

describe('installing a plugin', () => {
  it('shows what it asks for, and installs it only when agreed to', async () => {
    const bundle = example('rename-layers');
    pluginsStore.setState({ pendingInstall: { bundle, source: 'file' } });
    const { rerender } = render(<Pending />);
    const dialog = screen.getByRole('dialog', { name: 'Install plugin' });
    expect(within(dialog).getByText('Rename layers')).toBeTruthy();
    expect(within(dialog).getByText('Version 1.0.0 by Evora')).toBeTruthy();
    const permissions = within(within(dialog).getByRole('region', { name: 'Permissions' })).getAllByRole('listitem').map((item) => item.textContent);
    expect(permissions).toEqual([
      'Read the current file: its pages, layers, selection, components, styles and variables',
      'Change the current file: create, edit and delete layers, styles and variables',
      'Show a window of its own',
    ]);
    // Cancel: nothing installed.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(pluginsStore.getState().pendingInstall).toBeNull();
    rerender(<Pending />);
    expect(await registry.list()).toEqual([]);

    pluginsStore.setState({ pendingInstall: { bundle, source: 'file' } });
    rerender(<Pending />);
    fireEvent.click(screen.getByRole('button', { name: 'Install' }));
    await waitFor(() => expect(pluginsStore.getState().pendingInstall).toBeNull());
    expect((await registry.list()).map((record) => record.id)).toEqual(['org.evora.rename-layers']);
    expect(pluginsStore.getState().installed.map((record) => record.id)).toEqual(['org.evora.rename-layers']);
  });
});

describe('the plugin manager', () => {
  it('lists installed plugins, turns them off and on, and uninstalls them', async () => {
    await registry.install(example('tidy-up'), 'file');
    await registry.install(example('vote-counter'), 'directory');
    await refreshInstalled();
    pluginsStore.setState({ managerOpen: true, managerTab: 'installed' });
    render(<PluginManager />);
    const list = screen.getByRole('list', { name: 'Installed plugins' });
    expect(within(list).getAllByRole('listitem').map((item) => item.textContent?.replace(/\s+/g, ' '))).toEqual([
      expect.stringContaining('Tidy up1.0.0 · Evora'),
      expect.stringContaining('Vote counterWidget1.0.0 · Evora'),
    ]);
    const toggle = screen.getByRole('switch', { name: 'Tidy up enabled' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Tidy up enabled' }).getAttribute('aria-checked')).toBe('false'));
    expect((await registry.get('org.evora.tidy-up'))?.enabled).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Settings of Vote counter' }));
    expect(screen.getByRole('log', { name: 'Plugin console' }).textContent).toContain('Nothing yet');
    fireEvent.click(screen.getByRole('button', { name: 'Uninstall Vote counter' }));
    await waitFor(() => expect(screen.queryByText('Vote counter')).toBeNull());
    expect((await registry.list()).map((record) => record.id)).toEqual(['org.evora.tidy-up']);
  });
});

describe('the Plugins menu', () => {
  it('lists enabled plugins with their commands, the widgets, the last plugin run, and the manager', async () => {
    const store = editor();
    const env = { store, app: {} as AppActions };
    const run: unknown[] = [];
    pluginsStore.setState({ actions: { run: (...args) => void run.push(args), placeWidget: (...args) => void run.push(['widget', ...args]), stop() {} } });
    expect(labels(menuItems(env, store.getState()))).toEqual(['Run last plugin', '—', 'Manage plugins…', 'Browse plugins and widgets…', 'Development…']);

    for (const name of ['tidy-up', 'rename-layers', 'vote-counter', 'lorem-ipsum']) await registry.install(example(name), 'file');
    await registry.setEnabled('org.evora.lorem-ipsum', false);
    await refreshInstalled();
    pluginsStore.setState({ lastRun: { pluginId: 'org.evora.tidy-up', commandId: 'snap' } });
    const items = menuItems(env, store.getState());
    expect(labels(items)).toEqual([
      'Run last plugin: Tidy up – Snap to the 8 px grid',
      '—',
      'Rename layers',
      { 'Tidy up': ['Arrange in a grid', 'Snap to the 8 px grid'] },
      { Widgets: ['Counter', 'Upvote'] },
      '—',
      'Manage plugins…',
      'Browse plugins and widgets…',
      'Development…',
    ]);
    const first = items[0] as { shortcut?: string; onSelect(): void };
    expect(first.shortcut).toBe('Ctrl+Alt+P');
    first.onSelect();
    ((items[3] as { items: { onSelect(): void }[] }).items[0] as { onSelect(): void }).onSelect();
    ((items[4] as { items: { onSelect(): void }[] }).items[1] as { onSelect(): void }).onSelect();
    expect(run).toEqual([
      ['org.evora.tidy-up', 'snap'],
      ['org.evora.tidy-up', 'grid'],
      ['widget', 'org.evora.vote-counter', 'upvote'],
    ]);
    (items.at(-3) as { onSelect(): void }).onSelect();
    expect(pluginsStore.getState()).toMatchObject({ managerOpen: true, managerTab: 'installed' });
  });
});
