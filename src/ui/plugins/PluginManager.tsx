import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { getAccount } from '../../collab/account';
import type { JsonValue } from '../../core';
import { createDirectory, type DirectoryEntry } from '../../plugins/directory';
import { compareVersions, makeBundle, parseBundle, PERMISSION_LABELS, BUNDLE_EXTENSION, type PluginBundle } from '../../plugins/manifest';
import type { InstalledPlugin, PluginSource } from '../../plugins/storage';
import { Dialog } from '../components/Dialog';
import { Icon } from '../components/Icon';
import { clearConsole, pluginRegistry, pluginsStore, refreshInstalled, toast, type ManagerTab } from './state';

/** A rounded well pressed into the dialog, which lists sit in. */
const WELL = 'rounded-[12px] bg-bg/50 shadow-[var(--ev-sunk)]';
// Notes in the dim colour, not the faint one: faint is for hints next to something, and too pale to read as a sentence on white.
const EMPTY = 'm-0 rounded-[10px] border border-dashed border-line px-3 py-4 text-center leading-[1.5] text-dim';
const NOTE = 'm-0 leading-[1.5] text-dim';
const LIST = `m-0 flex list-none flex-col divide-y divide-line/60 px-1 py-0 ${WELL}`;
const CHIP = 'rounded-full bg-field px-2 py-[1px] text-[10.5px] font-medium text-dim shadow-[var(--ev-sunk)]';

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** A plugin's mark: its first letter on a raised tile, tinted for widgets. */
function PluginTile({ name, kind }: { name: string; kind: 'plugin' | 'widget' }) {
  return (
    <span
      aria-hidden="true"
      className={`flex h-9 w-9 flex-none items-center justify-center rounded-[10px] text-[14px] font-semibold shadow-[var(--ev-raise)] ${kind === 'widget' ? 'text-success' : 'text-accent'}`}
      style={{ background: 'var(--ev-button)' }}
    >
      {name.trim()[0]?.toUpperCase() ?? '?'}
    </span>
  );
}

/** Reads a file the person chose. */
function readText(file: File): Promise<string> {
  return file.text();
}

/** Lets the person choose files; resolves with none when they cancel (as far as the browser says). */
function chooseFiles(accept: string, multiple: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.addEventListener('change', () => resolve([...(input.files ?? [])]));
    input.addEventListener('cancel', () => resolve([]));
    input.click();
  });
}

/** Asks to install a bundle: shows what it is and what it asks for, and installs it only when the person agrees. */
export function askToInstall(bundle: PluginBundle, source: PluginSource): void {
  pluginsStore.setState({ pendingInstall: { bundle, source } });
}

/**
 * The dialog that installs a plugin: its name, maker and version, whether it
 * replaces one installed, and each permission it asks for in words. Nothing is
 * installed unless the person chooses Install.
 */
export function InstallDialog({ bundle, source }: { bundle: PluginBundle; source: PluginSource }) {
  const installed = useStore(pluginsStore, (s) => s.installed.find((record) => record.id === bundle.manifest.id));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const manifest = bundle.manifest;
  // Only this request is closed: another may have been made while it was being installed.
  const close = (): void => pluginsStore.setState((s) => (s.pendingInstall?.bundle === bundle ? { pendingInstall: null } : {}));
  const install = (): void => {
    setBusy(true);
    pluginRegistry()
      .install(bundle, source)
      .then(async () => {
        await refreshInstalled();
        close();
        toast(`Installed ${manifest.name} ${manifest.version}.`);
      })
      .catch((error) => {
        setBusy(false);
        setProblem(errorText(error));
      });
  };
  const older = installed ? compareVersions(manifest.version, installed.bundle.manifest.version) < 0 : false;
  return (
    <Dialog
      title={`Install ${manifest.kind === 'widget' ? 'widget' : 'plugin'}`}
      onClose={close}
      width={440}
      footer={
        <>
          <button type="button" className="ev-button !px-4" onClick={close}>
            Cancel
          </button>
          <button type="button" className="ev-button ev-button-primary !px-4" data-autofocus disabled={busy} onClick={install}>
            {installed ? (older ? 'Install older version' : 'Update') : 'Install'}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-start gap-3">
          <PluginTile name={manifest.name} kind={manifest.kind} />
          <div className="min-w-0 flex-1">
            <div className="font-semibold text-ink">{manifest.name}</div>
            <div className="text-[11px] leading-[1.45] text-dim">
              Version {manifest.version} by {manifest.author}
              {installed ? ` · replaces version ${installed.bundle.manifest.version}` : ''}
            </div>
            {manifest.description && <p className="m-0 mt-1.5 leading-[1.5] text-dim">{manifest.description}</p>}
          </div>
        </div>
        <section aria-label="Permissions" className="flex flex-col gap-2">
          <h3 className="ev-section-title">{manifest.permissions.length > 0 ? `This ${manifest.kind} asks to` : 'Permissions'}</h3>
          {manifest.permissions.length === 0 ? (
            <p className={EMPTY}>It asks for no permissions: it can only show notifications{manifest.kind === 'widget' ? ' and draw its widgets' : ''}.</p>
          ) : (
            <ul className={`${LIST} !py-1`}>
              {manifest.permissions.map((permission) => (
                <li key={permission} className="flex items-start gap-2.5 px-2 py-2">
                  <span className="mt-[1px] text-accent" aria-hidden="true">
                    <Icon name="check" />
                  </span>
                  <span className="leading-[1.45] text-ink">{PERMISSION_LABELS[permission]}</span>
                </li>
              ))}
            </ul>
          )}
          <p className={NOTE}>Plugins run apart from Evora and your other files, with no access to the network. They can do only what is listed here.</p>
        </section>
        {problem && (
          <p role="alert" className="m-0 text-danger">
            {problem}
          </p>
        )}
      </div>
    </Dialog>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange(next: boolean): void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-[18px] w-8 flex-none rounded-full transition-colors ${checked ? 'bg-accent' : 'bg-field shadow-[var(--ev-sunk)]'}`}
    >
      <span className={`absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white shadow transition-[left] ${checked ? 'left-[16px]' : 'left-[2px]'}`} />
    </button>
  );
}

/** A plugin's settings: what it keeps on this device, which can be cleared. */
function PluginStorage({ pluginId, name }: { pluginId: string; name: string }) {
  const [entries, setEntries] = useState<[string, JsonValue][] | null>(null);
  const load = useCallback(() => {
    pluginRegistry()
      .storageFor(pluginId)
      .entries()
      .then(setEntries)
      .catch(() => setEntries([]));
  }, [pluginId]);
  useEffect(load, [load]);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium text-dim">Stored data</span>
        <button
          type="button"
          className="ev-button !h-6 !px-2.5"
          aria-label={`Reset the data of ${name}`}
          disabled={!entries || entries.length === 0}
          onClick={() =>
            void pluginRegistry()
              .storageFor(pluginId)
              .clear()
              .then(() => {
                load();
                toast(`The data of ${name} was reset.`);
              })
          }
        >
          Reset
        </button>
      </div>
      {entries === null ? null : entries.length === 0 ? (
        <p className={NOTE}>Nothing stored.</p>
      ) : (
        <dl className="m-0 grid max-h-32 grid-cols-[auto_1fr] gap-x-3 gap-y-1 overflow-y-auto rounded-[8px] bg-field px-2 py-1.5 font-mono text-[10.5px] shadow-[var(--ev-sunk)]">
          {entries.map(([key, value]) => (
            <div key={key} className="contents">
              <dt className="truncate text-dim">{key}</dt>
              <dd className="m-0 truncate text-ink">{JSON.stringify(value)}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

/** What a plugin wrote to its console, and the errors it did not catch. */
function ConsolePanel({ pluginId }: { pluginId: string }) {
  const lines = useStore(pluginsStore, (s) => s.consoles[pluginId]);
  const log = useRef<HTMLDivElement>(null);
  // The newest line in view, without moving the dialog around it.
  useEffect(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [lines]);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium text-dim">Console</span>
        <button type="button" className="ev-button !h-6 !px-2.5" disabled={!lines || lines.length === 0} onClick={() => clearConsole(pluginId)}>
          Clear
        </button>
      </div>
      <div ref={log} role="log" aria-label="Plugin console" className="max-h-44 min-h-14 overflow-y-auto rounded-[8px] bg-bg px-2 py-1.5 font-mono text-[10.5px] leading-[1.5] shadow-[var(--ev-sunk)]">
        {!lines || lines.length === 0 ? (
          <span className="text-faint">Nothing yet. What the plugin logs with console.log, and its errors, show here.</span>
        ) : (
          lines.map((line, i) => (
            <div key={i} className={`whitespace-pre-wrap break-words ${line.level === 'error' ? 'text-danger' : line.level === 'warn' ? 'text-warning' : 'text-ink'}`}>
              <span className="text-faint">{new Date(line.at).toLocaleTimeString()} </span>
              {line.text}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function InstalledRow({ record }: { record: InstalledPlugin }) {
  const manifest = record.bundle.manifest;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const actions = useStore(pluginsStore, (s) => s.actions);
  const signedIn = getAccount() !== null;
  const publish = (): void => {
    setBusy(true);
    createDirectory()
      .publish(record.bundle)
      .then((entry) => toast(`Published ${entry.name} ${entry.version} to the directory.`))
      .catch((error) => toast(errorText(error), true, 6000))
      .finally(() => setBusy(false));
  };
  return (
    <li className="flex flex-col gap-2 px-2 py-2.5">
      <div className="flex items-center gap-2.5">
        <PluginTile name={manifest.name} kind={manifest.kind} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate font-medium text-ink">{manifest.name}</span>
            {manifest.kind === 'widget' && <span className={CHIP}>Widget</span>}
            {record.source === 'development' && <span className={CHIP}>Development</span>}
          </div>
          <div className="truncate text-[11px] leading-[1.45] text-dim">
            {manifest.version} · {manifest.author}
          </div>
        </div>
        {manifest.kind === 'plugin' && (
          <button type="button" className="ev-button !h-7 flex-none !px-3" aria-label={`Run ${manifest.name}`} disabled={!record.enabled || !actions} onClick={() => actions?.run(record.id, manifest.commands[0]?.id ?? null)}>
            Run
          </button>
        )}
        <Toggle
          label={`${manifest.name} enabled`}
          checked={record.enabled}
          onChange={(enabled) => void pluginRegistry().setEnabled(record.id, enabled).then(refreshInstalled)}
        />
        <button type="button" className="ev-icon-button" aria-label={`Settings of ${manifest.name}`} aria-expanded={open} onClick={() => setOpen(!open)}>
          <Icon name={open ? 'chevronDown' : 'chevronRight'} />
        </button>
      </div>
      {open && (
        <div className="ml-[46px] flex flex-col gap-3 pb-1 max-sm:ml-0">
          {manifest.description && <p className="m-0 leading-[1.5] text-dim">{manifest.description}</p>}
          <div className="flex flex-wrap gap-1" aria-label="Permissions">
            {manifest.permissions.length === 0 ? <span className={CHIP}>No permissions</span> : manifest.permissions.map((permission) => <span key={permission} className={CHIP} title={PERMISSION_LABELS[permission]}>{permission}</span>)}
          </div>
          {manifest.permissions.includes('storage') && <PluginStorage pluginId={record.id} name={manifest.name} />}
          <ConsolePanel pluginId={record.id} />
          <div className="flex gap-2">
            {signedIn && (
              <button type="button" className="ev-button !h-7 !px-3" disabled={busy} onClick={publish}>
                Publish to directory
              </button>
            )}
            <button
              type="button"
              className="ev-button ev-button-danger !h-7 !px-3"
              aria-label={`Uninstall ${manifest.name}`}
              onClick={() =>
                void pluginRegistry()
                  .uninstall(record.id)
                  .then(refreshInstalled)
                  .then(() => toast(`Uninstalled ${manifest.name}.`))
              }
            >
              Uninstall
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

function InstalledTab() {
  const installed = useStore(pluginsStore, (s) => s.installed);
  const loaded = useStore(pluginsStore, (s) => s.loaded);
  const [problem, setProblem] = useState('');
  const fromFile = (): void => {
    setProblem('');
    void chooseFiles(`${BUNDLE_EXTENSION},application/json`, false).then(async ([file]) => {
      if (!file) return;
      try {
        askToInstall(parseBundle(await readText(file)), 'file');
      } catch (error) {
        setProblem(`${file.name}: ${errorText(error)}`);
      }
    });
  };
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3 max-sm:flex-col max-sm:items-stretch">
        <p className={NOTE}>Installed plugins and widgets are available in every file on this device.</p>
        <button type="button" className="ev-button ev-button-primary flex-none !px-3" onClick={fromFile}>
          Install from file…
        </button>
      </div>
      {problem && (
        <p role="alert" className="m-0 text-danger">
          {problem}
        </p>
      )}
      {loaded && installed.length === 0 && <p className={EMPTY}>No plugins installed. Install one from a {BUNDLE_EXTENSION} file, or find one under Browse.</p>}
      {installed.length > 0 && (
        <ul className={LIST} aria-label="Installed plugins">
          {installed.map((record) => (
            <InstalledRow key={record.id} record={record} />
          ))}
        </ul>
      )}
    </div>
  );
}

function BrowseTab() {
  const installed = useStore(pluginsStore, (s) => s.installed);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<'' | 'plugin' | 'widget'>('');
  const [results, setResults] = useState<DirectoryEntry[] | null>(null);
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      createDirectory()
        .search(query, kind)
        .then((list) => {
          if (cancelled) return;
          setResults(list);
          setProblem('');
        })
        .catch((error) => {
          if (cancelled) return;
          setResults(null);
          setProblem(errorText(error));
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, kind]);

  const install = (entry: DirectoryEntry): void => {
    setBusy(entry.id);
    createDirectory()
      .install(entry.id)
      .then((bundle) => askToInstall(bundle, 'directory'))
      .catch((error) => toast(errorText(error), true, 6000))
      .finally(() => setBusy(null));
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <input className="ev-field min-w-[160px] flex-1" type="search" placeholder="Search plugins and widgets" aria-label="Search plugins and widgets" value={query} onChange={(event) => setQuery(event.target.value)} data-autofocus />
        <div role="tablist" aria-label="Kind" className="ev-segmented w-[210px] flex-none max-sm:w-full">
          {(
            [
              ['', 'All'],
              ['plugin', 'Plugins'],
              ['widget', 'Widgets'],
            ] as const
          ).map(([value, label]) => (
            <button key={value} type="button" role="tab" aria-selected={kind === value} className="ev-segment" onClick={() => setKind(value)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      {problem && <p className={EMPTY}>{problem}</p>}
      {results && results.length === 0 && <p className={EMPTY}>{query ? `Nothing found for “${query}”.` : 'Nothing has been published yet.'}</p>}
      {results && results.length > 0 && (
        <ul className={LIST} aria-label="Directory">
          {results.map((entry) => {
            const have = installed.find((record) => record.id === entry.id);
            const newer = have ? compareVersions(entry.version, have.bundle.manifest.version) > 0 : false;
            return (
              <li key={entry.id} className="flex items-start gap-2.5 px-2 py-2.5">
                <PluginTile name={entry.name} kind={entry.kind} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate font-medium text-ink">{entry.name}</span>
                    {entry.kind === 'widget' && <span className={CHIP}>Widget</span>}
                  </div>
                  <div className="text-[11px] leading-[1.45] text-dim">
                    {entry.author.name} · {entry.version} · {entry.installs === 1 ? '1 install' : `${entry.installs} installs`}
                  </div>
                  {entry.description && <p className="m-0 mt-1 line-clamp-2 leading-[1.45] text-dim">{entry.description}</p>}
                </div>
                <button
                  type="button"
                  className={`ev-button !h-7 flex-none !px-3 ${have && !newer ? '' : 'ev-button-primary'}`}
                  aria-label={`${have ? (newer ? 'Update' : 'Installed:') : 'Install'} ${entry.name}`}
                  disabled={busy === entry.id || (have !== undefined && !newer)}
                  onClick={() => install(entry)}
                >
                  {have ? (newer ? 'Update' : 'Installed') : 'Install'}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Files of a plugin in development, kept so "Reload" reads them again from the disk. */
interface DevFiles {
  read(): Promise<{ manifest: string; code: string; ui: string | null }>;
  names: string;
}

const devFiles = new Map<string, DevFiles>();

type FileHandle = { name: string; getFile(): Promise<File> };
type PickerWindow = Window & { showOpenFilePicker?: (options: { multiple: boolean; types?: unknown[] }) => Promise<FileHandle[]> };

/** Asks for a plugin's files (manifest.json, its code and its window's HTML), keeping the way back to them where the browser allows. */
async function pickDevelopmentFiles(): Promise<DevFiles | null> {
  const picker = (window as PickerWindow).showOpenFilePicker;
  let handles: { name: string; read(): Promise<string> }[];
  if (picker) {
    try {
      const chosen = await picker.call(window, { multiple: true });
      handles = chosen.map((handle) => ({ name: handle.name, read: async () => (await handle.getFile()).text() }));
    } catch {
      return null;
    }
  } else {
    const files = await chooseFiles('.json,.js,.mjs,.html,.htm', true);
    handles = files.map((file) => ({ name: file.name, read: () => file.text() }));
  }
  if (handles.length === 0) return null;
  const manifestFile = handles.find((handle) => handle.name === 'manifest.json') ?? handles.find((handle) => handle.name.endsWith('.json'));
  if (!manifestFile) throw new Error('Choose the plugin\'s manifest.json together with its code (and its window\'s HTML, if it has one).');
  return {
    names: handles.map((handle) => handle.name).join(', '),
    async read() {
      const manifest = await manifestFile.read();
      let parsed: { main?: unknown; ui?: unknown };
      try {
        parsed = JSON.parse(manifest) as { main?: unknown; ui?: unknown };
      } catch {
        throw new Error('manifest.json is not valid JSON.');
      }
      const main = typeof parsed.main === 'string' ? parsed.main : 'main.js';
      const codeFile = handles.find((handle) => handle.name === main) ?? handles.find((handle) => /\.m?js$/.test(handle.name));
      if (!codeFile) throw new Error(`The code (${main}) was not among the files chosen.`);
      const uiName = typeof parsed.ui === 'string' ? parsed.ui : null;
      const uiFile = uiName ? (handles.find((handle) => handle.name === uiName) ?? handles.find((handle) => /\.html?$/.test(handle.name))) : undefined;
      if (uiName && !uiFile) throw new Error(`The window's HTML (${uiName}) was not among the files chosen.`);
      return { manifest, code: await codeFile.read(), ui: uiFile ? await uiFile.read() : null };
    },
  };
}

async function loadDevelopment(files: DevFiles): Promise<string> {
  const { manifest, code, ui } = await files.read();
  const bundle = makeBundle(JSON.parse(manifest), code, ui);
  await pluginRegistry().install(bundle, 'development');
  devFiles.set(bundle.manifest.id, files);
  await refreshInstalled();
  return bundle.manifest.name;
}

function DevelopmentTab() {
  const installed = useStore(pluginsStore, (s) => s.installed);
  const actions = useStore(pluginsStore, (s) => s.actions);
  const development = installed.filter((record) => record.source === 'development');
  const [problem, setProblem] = useState('');
  const [selected, setSelected] = useState<string>(development[0]?.id ?? installed[0]?.id ?? '');
  const choose = (): void => {
    setProblem('');
    pickDevelopmentFiles()
      .then(async (files) => {
        if (!files) return;
        const name = await loadDevelopment(files);
        toast(`Loaded ${name} from ${files.names}.`);
      })
      .catch((error) => setProblem(errorText(error)));
  };
  const reload = (record: InstalledPlugin): void => {
    setProblem('');
    const files = devFiles.get(record.id);
    const again = files ? Promise.resolve(files) : pickDevelopmentFiles();
    again
      .then(async (picked) => {
        if (!picked) return;
        const name = await loadDevelopment(picked);
        toast(`Reloaded ${name}.`);
      })
      .catch((error) => setProblem(errorText(error)));
  };
  const shown = installed.find((record) => record.id === selected) ?? development[0] ?? installed[0];
  return (
    <div className="flex flex-col gap-4">
      <section aria-label="Plugins in development" className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3 max-sm:flex-col max-sm:items-stretch">
          <p className={NOTE}>Load a plugin from its files (manifest.json, its code and its window’s HTML) while you write it, and reload it after each change. The format and the API are in plugins/PLUGINS.md.</p>
          <button type="button" className="ev-button ev-button-primary flex-none !px-3" onClick={choose}>
            Load from files…
          </button>
        </div>
        {problem && (
          <p role="alert" className="m-0 whitespace-pre-wrap text-danger">
            {problem}
          </p>
        )}
        {development.length > 0 && (
          <ul className={LIST} aria-label="Plugins in development">
            {development.map((record) => (
              <li key={record.id} className="flex items-center gap-2.5 px-2 py-2">
                <PluginTile name={record.bundle.manifest.name} kind={record.bundle.manifest.kind} />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium text-ink">{record.bundle.manifest.name}</div>
                  <div className="truncate text-[11px] text-dim">Loaded {new Date(record.updatedAt).toLocaleTimeString()}</div>
                </div>
                <button type="button" className="ev-button !h-7 !px-3" aria-label={`Reload ${record.bundle.manifest.name}`} onClick={() => reload(record)}>
                  Reload
                </button>
                {record.bundle.manifest.kind === 'plugin' && (
                  <button type="button" className="ev-button !h-7 !px-3" aria-label={`Run ${record.bundle.manifest.name}`} disabled={!actions} onClick={() => actions?.run(record.id, record.bundle.manifest.commands[0]?.id ?? null)}>
                    Run
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      {installed.length > 0 && shown && (
        <section aria-label="Console" className="flex flex-col gap-2">
          <label className="flex items-center gap-2 text-[11px] text-dim">
            Console of
            <select className="ev-field !h-7 min-w-0 flex-1" value={shown.id} onChange={(event) => setSelected(event.target.value)}>
              {installed.map((record) => (
                <option key={record.id} value={record.id}>
                  {record.bundle.manifest.name}
                </option>
              ))}
            </select>
          </label>
          <ConsolePanel pluginId={shown.id} />
        </section>
      )}
    </div>
  );
}

const TABS: [ManagerTab, string][] = [
  ['installed', 'Installed'],
  ['browse', 'Browse'],
  ['development', 'Development'],
];

/** The plugin manager (Plugins > Manage plugins…): installed plugins and widgets, the directory, and development tools. */
export function PluginManager() {
  const tab = useStore(pluginsStore, (s) => s.managerTab);
  const close = (): void => pluginsStore.setState({ managerOpen: false });
  return (
    <Dialog title="Plugins and widgets" onClose={close} width={600}>
      <div className="flex min-h-[340px] flex-col gap-4">
        <div role="tablist" aria-label="Plugin manager" className="ev-segmented">
          {TABS.map(([value, label]) => (
            <button key={value} type="button" role="tab" aria-selected={tab === value} className="ev-segment" onClick={() => pluginsStore.setState({ managerTab: value })}>
              {label}
            </button>
          ))}
        </div>
        {tab === 'installed' && <InstalledTab />}
        {tab === 'browse' && <BrowseTab />}
        {tab === 'development' && <DevelopmentTab />}
      </div>
    </Dialog>
  );
}
