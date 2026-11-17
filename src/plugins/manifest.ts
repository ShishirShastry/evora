/**
 * The plugin format (Phase 9): a manifest, the plugin's JavaScript and, if it
 * has one, the HTML of its window, bundled as one JSON file (`.evora-plugin`)
 * for installing. The format and the API are described for plugin makers in
 * `plugins/PLUGINS.md`.
 *
 * This file is shared by the app and the server (which checks what is
 * published to the directory), so it imports nothing and uses only erasable
 * TypeScript.
 */

/** The version of the plugin API this build provides. A plugin asks for one; a newer one than this is refused. */
export const PLUGIN_API_VERSION = 1;
/** What a bundle says it is. */
export const BUNDLE_FORMAT = 'evora-plugin';
export const BUNDLE_FORMAT_VERSION = 1;
export const BUNDLE_EXTENSION = '.evora-plugin';

/** What a plugin may be allowed to do. Each is asked for in the manifest and shown before installing. */
export const PERMISSIONS = ['read', 'write', 'export', 'ui', 'storage'] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** What each permission allows, in words, for the dialog that installs a plugin. */
export const PERMISSION_LABELS: Record<Permission, string> = {
  read: 'Read the current file: its pages, layers, selection, components, styles and variables',
  write: 'Change the current file: create, edit and delete layers, styles and variables',
  export: 'Export layers as pictures, SVG or PDF',
  ui: 'Show a window of its own',
  storage: 'Keep its own data on this device',
};

export type PluginKind = 'plugin' | 'widget';

/** A menu command of a plugin: what it is called in the Plugins menu, and the ID the plugin is given when it runs. */
export interface PluginCommand {
  id: string;
  name: string;
}

/** A widget a widget plugin offers: placed from Plugins > Widgets. */
export interface WidgetDeclaration {
  id: string;
  name: string;
}

export interface PluginManifest {
  /** Unique, lowercase, in reverse-domain style: "com.example.rename-layers". */
  id: string;
  name: string;
  /** "major.minor.patch". */
  version: string;
  description: string;
  author: string;
  kind: PluginKind;
  /** The plugin API version it was written for. */
  api: number;
  permissions: Permission[];
  /** For a plugin: its menu commands (at least one). */
  commands: PluginCommand[];
  /** For a widget plugin: its widgets (at least one). */
  widgets: WidgetDeclaration[];
  /** The file the code is in, for loading during development ("main.js"). */
  main: string;
  /** The file the window's HTML is in, if the plugin has a window ("ui.html"). */
  ui: string | null;
}

/** An installable plugin: the manifest with the code and the window's HTML in it. */
export interface PluginBundle {
  format: typeof BUNDLE_FORMAT;
  formatVersion: number;
  manifest: PluginManifest;
  code: string;
  ui: string | null;
}

export class PluginFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginFormatError';
  }
}

export const MAX_CODE_LENGTH = 2_000_000;
export const MAX_UI_LENGTH = 2_000_000;
const ID = /^[a-z0-9]+([.-][a-z0-9]+)+$/;
const VERSION = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
const PART_ID = /^[A-Za-z0-9_-]{1,50}$/;
const FILE = /^[A-Za-z0-9_.-]{1,100}$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(raw: Record<string, unknown>, key: string, max: number, required = true): string {
  const value = raw[key];
  if (value === undefined && !required) return '';
  if (typeof value !== 'string') throw new PluginFormatError(`The manifest's "${key}" must be text.`);
  const trimmed = value.trim();
  if (required && !trimmed) throw new PluginFormatError(`The manifest's "${key}" is empty.`);
  if (trimmed.length > max) throw new PluginFormatError(`The manifest's "${key}" is longer than ${max} characters.`);
  return trimmed;
}

function parts<T extends { id: string; name: string }>(raw: unknown, what: string): T[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new PluginFormatError(`The manifest's "${what}" must be a list.`);
  if (raw.length > 50) throw new PluginFormatError(`The manifest has more than 50 ${what}.`);
  const seen = new Set<string>();
  return raw.map((item) => {
    if (!isObject(item) || typeof item.id !== 'string' || !PART_ID.test(item.id)) {
      throw new PluginFormatError(`Each of the manifest's ${what} needs an "id" of letters, digits, "-" and "_".`);
    }
    if (seen.has(item.id)) throw new PluginFormatError(`The manifest has two ${what} with the ID "${item.id}".`);
    seen.add(item.id);
    if (typeof item.name !== 'string' || !item.name.trim() || item.name.trim().length > 60) {
      throw new PluginFormatError(`The ${what.replace(/s$/, '')} "${item.id}" needs a "name" of 1 to 60 characters.`);
    }
    return { id: item.id, name: item.name.trim() } as T;
  });
}

/** Checks a manifest and returns it tidied, or throws a `PluginFormatError` that says what is wrong. */
export function validateManifest(raw: unknown): PluginManifest {
  if (!isObject(raw)) throw new PluginFormatError('The manifest must be a JSON object.');
  const id = str(raw, 'id', 100);
  if (!ID.test(id)) throw new PluginFormatError(`The plugin ID "${id}" must be lowercase letters and digits in parts joined by "." or "-", like "com.example.my-plugin".`);
  const name = str(raw, 'name', 60);
  const version = str(raw, 'version', 20);
  if (!VERSION.test(version)) throw new PluginFormatError(`The version "${version}" must be written as major.minor.patch, like "1.0.0".`);
  const description = str(raw, 'description', 1000, false);
  const author = str(raw, 'author', 100);
  const kind = raw.kind;
  if (kind !== 'plugin' && kind !== 'widget') throw new PluginFormatError('The manifest\'s "kind" must be "plugin" or "widget".');
  const api = raw.api;
  if (typeof api !== 'number' || !Number.isInteger(api) || api < 1) throw new PluginFormatError('The manifest\'s "api" must be the API version it was written for (1).');
  if (api > PLUGIN_API_VERSION) throw new PluginFormatError(`This plugin needs version ${api} of the plugin API; this version of Evora has version ${PLUGIN_API_VERSION}. Update Evora to use it.`);
  if (!Array.isArray(raw.permissions)) throw new PluginFormatError('The manifest\'s "permissions" must be a list (it may be empty).');
  const permissions: Permission[] = [];
  for (const item of raw.permissions) {
    if (!(PERMISSIONS as readonly unknown[]).includes(item)) throw new PluginFormatError(`"${String(item)}" is not a permission. The permissions are: ${PERMISSIONS.join(', ')}.`);
    if (!permissions.includes(item as Permission)) permissions.push(item as Permission);
  }
  permissions.sort((a, b) => PERMISSIONS.indexOf(a) - PERMISSIONS.indexOf(b));
  const commands = parts<PluginCommand>(raw.commands, 'commands');
  const widgets = parts<WidgetDeclaration>(raw.widgets, 'widgets');
  if (kind === 'plugin' && commands.length === 0) commands.push({ id: 'run', name: name });
  if (kind === 'widget' && widgets.length === 0) throw new PluginFormatError('A widget plugin must list at least one widget in "widgets".');
  const main = raw.main === undefined ? 'main.js' : str(raw, 'main', 100);
  if (!FILE.test(main)) throw new PluginFormatError('The manifest\'s "main" must be a file name, like "main.js".');
  const ui = raw.ui === undefined || raw.ui === null ? null : str(raw, 'ui', 100);
  if (ui !== null && !FILE.test(ui)) throw new PluginFormatError('The manifest\'s "ui" must be a file name, like "ui.html".');
  if (ui !== null && !permissions.includes('ui')) throw new PluginFormatError('A plugin with a window ("ui") must ask for the "ui" permission.');
  return { id, name, version, description, author, kind, api, permissions, commands, widgets, main, ui };
}

/** Makes a bundle from a manifest and the contents of its files, checking all of it. */
export function makeBundle(manifest: unknown, code: string, ui: string | null): PluginBundle {
  const checked = validateManifest(manifest);
  if (typeof code !== 'string' || !code.trim()) throw new PluginFormatError('The plugin has no code.');
  if (code.length > MAX_CODE_LENGTH) throw new PluginFormatError('The plugin\'s code is larger than 2 MB.');
  if (checked.ui !== null && (typeof ui !== 'string' || !ui.trim())) throw new PluginFormatError(`The manifest names a window ("${checked.ui}") but the plugin has no HTML for it.`);
  if (checked.ui === null && ui) throw new PluginFormatError('The plugin has HTML for a window, but its manifest has no "ui".');
  if (ui && ui.length > MAX_UI_LENGTH) throw new PluginFormatError('The plugin\'s window is larger than 2 MB.');
  return { format: BUNDLE_FORMAT, formatVersion: BUNDLE_FORMAT_VERSION, manifest: checked, code, ui: checked.ui === null ? null : ui };
}

/** Reads a bundle: the text of a `.evora-plugin` file, or its JSON already parsed. */
export function parseBundle(input: unknown): PluginBundle {
  let raw = input;
  if (typeof input === 'string') {
    try {
      raw = JSON.parse(input);
    } catch {
      throw new PluginFormatError('This is not an Evora plugin: the file is not JSON.');
    }
  }
  if (!isObject(raw) || raw.format !== BUNDLE_FORMAT) throw new PluginFormatError('This is not an Evora plugin (.evora-plugin).');
  if (typeof raw.formatVersion !== 'number' || raw.formatVersion > BUNDLE_FORMAT_VERSION) {
    throw new PluginFormatError('This plugin was bundled for a newer version of Evora. Update Evora to install it.');
  }
  if (typeof raw.code !== 'string') throw new PluginFormatError('The plugin has no code.');
  return makeBundle(raw.manifest, raw.code, typeof raw.ui === 'string' ? raw.ui : null);
}

export function serializeBundle(bundle: PluginBundle): string {
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

/** Compares two "major.minor.patch" versions: negative when `a` is older. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
