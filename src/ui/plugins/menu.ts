import type { MenuItem } from '../components/Menu';
import type { CommandEnv } from '../../state/commands';
import type { EditorState } from '../../state/editorStore';
import { openManager, pluginsStore } from './state';

/** The shortcut of "Run last plugin". */
export const RUN_LAST_SHORTCUT = 'Ctrl+Alt+P';

/**
 * Phase 9: the editor's main-menu entries for plugins and widgets; shown as a submenu when there are any.
 * The installed, enabled plugins with their commands, the widgets to place, running the last plugin again,
 * and the plugin manager.
 */
export function menuItems(_env: CommandEnv, state: EditorState): MenuItem[] {
  const plugins = pluginsStore.getState();
  const enabled = plugins.installed.filter((record) => record.enabled);
  const actions = plugins.actions;
  const last = plugins.lastRun ? enabled.find((record) => record.id === plugins.lastRun?.pluginId && record.bundle.manifest.kind === 'plugin') : undefined;
  const lastCommand = last?.bundle.manifest.commands.find((command) => command.id === plugins.lastRun?.commandId);
  const items: MenuItem[] = [
    {
      label: last ? `Run last plugin: ${last.bundle.manifest.name}${lastCommand && last.bundle.manifest.commands.length > 1 ? ` – ${lastCommand.name}` : ''}` : 'Run last plugin',
      shortcut: RUN_LAST_SHORTCUT,
      disabled: !last || !actions,
      onSelect: () => last && actions?.run(last.id, plugins.lastRun?.commandId ?? null),
    },
    { type: 'separator' },
  ];
  for (const record of enabled) {
    const manifest = record.bundle.manifest;
    if (manifest.kind !== 'plugin') continue;
    if (manifest.commands.length === 1) {
      items.push({ label: manifest.name, disabled: !actions, onSelect: () => actions?.run(record.id, manifest.commands[0]?.id ?? null) });
    } else {
      items.push({
        type: 'submenu',
        label: manifest.name,
        items: manifest.commands.map((command) => ({ label: command.name, disabled: !actions, onSelect: () => actions?.run(record.id, command.id) })),
      });
    }
  }
  const widgetPlugins = enabled.filter((record) => record.bundle.manifest.kind === 'widget');
  const widgets: MenuItem[] = [];
  for (const record of widgetPlugins) {
    for (const widget of record.bundle.manifest.widgets) {
      widgets.push({
        label: widgetPlugins.length > 1 ? `${widget.name} (${record.bundle.manifest.name})` : widget.name,
        disabled: !actions || state.readOnly,
        onSelect: () => actions?.placeWidget(record.id, widget.id),
      });
    }
  }
  if (widgets.length > 0) items.push({ type: 'submenu', label: 'Widgets', items: widgets });
  if (items.length > 2) items.push({ type: 'separator' });
  items.push({ label: 'Manage plugins…', onSelect: () => openManager('installed') });
  items.push({ label: 'Browse plugins and widgets…', onSelect: () => openManager('browse') });
  items.push({ label: 'Development…', onSelect: () => openManager('development') });
  return items;
}
