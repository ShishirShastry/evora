/**
 * What the Plugins menu and the plugin windows share: the installed plugins,
 * the plugins running and their windows, the consoles, the last plugin run,
 * notifications, and the actions the mount carries out (it alone has the
 * editor). A small zustand store, outside React so the menu can read it.
 */
import { createStore } from 'zustand/vanilla';
import type { ConsoleLevel } from '../../plugins/session';
import type { UiOptions } from '../../plugins/api';
import type { PluginBundle } from '../../plugins/manifest';
import { PluginRegistry, type InstalledPlugin, type PluginSource } from '../../plugins/storage';

export interface ConsoleLine {
  level: ConsoleLevel;
  text: string;
  at: number;
}

/** A plugin running now: with a window when it showed one. */
export interface RunningPlugin {
  key: string;
  pluginId: string;
  name: string;
  command: string | null;
  ui: UiOptions | null;
}

export interface Toast {
  id: number;
  message: string;
  error: boolean;
  timeout: number;
}

/** What the mount does when asked (it has the editor and the sandboxes). */
export interface PluginActions {
  run(pluginId: string, commandId: string | null): void;
  placeWidget(pluginId: string, widgetId: string): void;
  stop(key: string): void;
}

export type ManagerTab = 'installed' | 'browse' | 'development';

export interface PluginsState {
  installed: InstalledPlugin[];
  loaded: boolean;
  managerOpen: boolean;
  managerTab: ManagerTab;
  /** A bundle waiting for the person to agree to what it asks for. */
  pendingInstall: { bundle: PluginBundle; source: PluginSource } | null;
  running: RunningPlugin[];
  consoles: Record<string, ConsoleLine[]>;
  lastRun: { pluginId: string; commandId: string | null } | null;
  toasts: Toast[];
  actions: PluginActions | null;
}

const LAST_RUN_KEY = 'evora.plugins.lastRun';
const CONSOLE_LIMIT = 500;

function readLastRun(): PluginsState['lastRun'] {
  try {
    const raw = globalThis.localStorage?.getItem(LAST_RUN_KEY);
    const value = raw ? (JSON.parse(raw) as unknown) : null;
    if (value && typeof value === 'object' && typeof (value as { pluginId?: unknown }).pluginId === 'string') return value as PluginsState['lastRun'];
  } catch {
    // Not available, or damaged: nothing remembered.
  }
  return null;
}

export const pluginsStore = createStore<PluginsState>()(() => ({
  installed: [],
  loaded: false,
  managerOpen: false,
  managerTab: 'installed',
  pendingInstall: null,
  running: [],
  consoles: {},
  lastRun: readLastRun(),
  toasts: [],
  actions: null,
}));

let registry: PluginRegistry | null = null;

/** Where installed plugins are kept (IndexedDB "evora-plugins"); the tests give their own. */
export function pluginRegistry(): PluginRegistry {
  registry ??= new PluginRegistry();
  return registry;
}

export function setPluginRegistry(next: PluginRegistry | null): void {
  registry = next;
}

/** Reads the installed plugins again. */
export async function refreshInstalled(): Promise<void> {
  // Without IndexedDB (some private windows, the tests' stand-in DOM) there are no installed plugins.
  if (!registry && typeof indexedDB === 'undefined') {
    pluginsStore.setState({ loaded: true });
    return;
  }
  try {
    const installed = await pluginRegistry().list();
    pluginsStore.setState({ installed, loaded: true });
  } catch (error) {
    pluginsStore.setState({ loaded: true });
    toast(`The installed plugins could not be read: ${error instanceof Error ? error.message : String(error)}`, true);
  }
}

let toastId = 0;

export function toast(message: string, error = false, timeout = 3000): void {
  const id = ++toastId;
  pluginsStore.setState((s) => ({ toasts: [...s.toasts.slice(-3), { id, message, error, timeout }] }));
  setTimeout(() => pluginsStore.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), timeout);
}

export function log(pluginId: string, level: ConsoleLevel, text: string): void {
  pluginsStore.setState((s) => {
    const lines = [...(s.consoles[pluginId] ?? []), { level, text, at: Date.now() }];
    if (lines.length > CONSOLE_LIMIT) lines.splice(0, lines.length - CONSOLE_LIMIT);
    return { consoles: { ...s.consoles, [pluginId]: lines } };
  });
}

export function clearConsole(pluginId: string): void {
  pluginsStore.setState((s) => ({ consoles: { ...s.consoles, [pluginId]: [] } }));
}

export function rememberLastRun(pluginId: string, commandId: string | null): void {
  const lastRun = { pluginId, commandId };
  pluginsStore.setState({ lastRun });
  try {
    globalThis.localStorage?.setItem(LAST_RUN_KEY, JSON.stringify(lastRun));
  } catch {
    // Not kept: only a convenience.
  }
}

export function openManager(tab: ManagerTab = 'installed'): void {
  pluginsStore.setState({ managerOpen: true, managerTab: tab });
}
