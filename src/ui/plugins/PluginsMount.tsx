import { useEffect, useRef } from 'react';
import { useStore } from 'zustand';
import { newExportSetting } from '../../core';
import { exportOne } from '../../engine/export/export';
import { canvasClickListeners } from '../../engine/input/controller';
import { screenToWorld } from '../../engine/viewport';
import { PluginApi, type UiOptions } from '../../plugins/api';
import type { PluginBundle } from '../../plugins/manifest';
import { SANDBOX_FLAGS, sandboxDocument } from '../../plugins/runtime';
import { frameChannel, PluginSession } from '../../plugins/session';
import { placeWidget, runWidgetClick } from '../../plugins/widgetActions';
import { widgetClickAt } from '../../plugins/widgets';
import type { InstalledPlugin } from '../../plugins/storage';
import { useEditorContext } from '../editor/EditorContext';
import { exportEnvironment } from '../editor/exporting';
import { InstallDialog, PluginManager } from './PluginManager';
import { PluginWindow, type UiFrameHandle } from './PluginWindow';
import { log, pluginRegistry, pluginsStore, refreshInstalled, rememberLastRun, toast, type RunningPlugin } from './state';

/** A plugin running in this editor: its session, and its window's frame once there is one. */
interface Live {
  key: string;
  pluginId: string;
  session: PluginSession;
  bundle: PluginBundle;
  ui: UiFrameHandle;
}

let nextKey = 0;

/** Phase 9: plugins and widgets in the editor (plugin windows, the plugin manager). Mounted once by EditorScreen. */
export function PluginsMount() {
  const { store, storage, images } = useEditorContext();
  const sandboxes = useRef<HTMLDivElement>(null);
  const live = useRef(new Map<string, Live>());
  const widgetSessions = useRef(new Map<string, PluginSession>());
  const managerOpen = useStore(pluginsStore, (s) => s.managerOpen);
  const pending = useStore(pluginsStore, (s) => s.pendingInstall);
  const running = useStore(pluginsStore, (s) => s.running);
  const toasts = useStore(pluginsStore, (s) => s.toasts);

  useEffect(() => {
    void refreshInstalled();
  }, []);

  useEffect(() => {
    const container = sandboxes.current;
    if (!container) return;

    const exporter = async (doc: Parameters<typeof exportOne>[0], nodeId: string, format: 'PNG' | 'JPG' | 'SVG' | 'PDF', scale: number): Promise<Uint8Array> => {
      const setting = newExportSetting({ format, constraint: { type: 'SCALE', value: scale } });
      const { file } = await exportOne(doc, { nodeId, setting, fileName: 'export' }, exportEnvironment(storage, images));
      return file.bytes;
    };

    const setRunning = (fn: (list: RunningPlugin[]) => RunningPlugin[]): void => pluginsStore.setState((s) => ({ running: fn(s.running) }));

    /** Starts a plugin's sandbox. For a widget plugin there is one, without a command, kept while the editor is open. */
    const start = (record: InstalledPlugin, command: string | null, key: string): Live => {
      const manifest = record.bundle.manifest;
      const frame = document.createElement('iframe');
      frame.setAttribute('sandbox', SANDBOX_FLAGS);
      frame.setAttribute('title', `${manifest.name} (plugin code)`);
      frame.setAttribute('aria-hidden', 'true');
      frame.tabIndex = -1;
      frame.srcdoc = sandboxDocument(record.bundle, command);
      const ui: UiFrameHandle = { frame: null, queue: [] };
      const close = (message: string | null): void => {
        entry.session.close(message);
      };
      const api = new PluginApi({
        store,
        manifest,
        storage: pluginRegistry().storageFor(manifest.id),
        exporter,
        notify: (message, options) => toast(message, options.error, options.timeout),
        showUI: (options: UiOptions) => {
          if (!record.bundle.ui) {
            log(manifest.id, 'error', 'evora.showUI: this plugin has no window ("ui" in its manifest).');
            return;
          }
          setRunning((list) => list.map((item) => (item.key === key ? { ...item, ui: options } : item)));
        },
        postToUI: (message) => {
          if (ui.frame?.contentWindow && ui.loaded) ui.frame.contentWindow.postMessage({ pluginMessage: message }, '*');
          else ui.queue.push(message);
        },
        resizeUI: (width, height) => setRunning((list) => list.map((item) => (item.key === key && item.ui ? { ...item, ui: { ...item.ui, width, height } } : item))),
        closeUI: () => setRunning((list) => list.map((item) => (item.key === key ? { ...item, ui: null } : item))),
        close,
      });
      const session = new PluginSession(api, frameChannel(frame), {
        onConsole: (level, text) => log(manifest.id, level, text),
        onClosed: (message) => {
          live.current.delete(key);
          if (widgetSessions.current.get(manifest.id) === session) widgetSessions.current.delete(manifest.id);
          setRunning((list) => list.filter((item) => item.key !== key));
          if (message) toast(message);
        },
      });
      const entry: Live = { key, pluginId: manifest.id, session, bundle: record.bundle, ui };
      live.current.set(key, entry);
      container.appendChild(frame);
      session.watch(store);
      session.ready.catch((error: Error) => {
        log(manifest.id, 'error', error.message);
        toast(error.message, true);
        session.close();
      });
      return entry;
    };

    const findPlugin = (pluginId: string): InstalledPlugin | undefined => pluginsStore.getState().installed.find((record) => record.id === pluginId);

    const widgetSession = (record: InstalledPlugin): PluginSession => {
      let session = widgetSessions.current.get(record.id);
      if (!session || session.closed) {
        session = start(record, null, `widget:${record.id}:${++nextKey}`).session;
        widgetSessions.current.set(record.id, session);
      }
      return session;
    };

    const failed = (pluginId: string, error: unknown): void => {
      const message = error instanceof Error ? error.message : String(error);
      log(pluginId, 'error', message);
      toast(message, true, 5000);
    };

    pluginsStore.setState({
      actions: {
        run(pluginId, commandId) {
          const record = findPlugin(pluginId);
          if (!record || !record.enabled) {
            toast('That plugin is not installed, or is turned off.', true);
            return;
          }
          const manifest = record.bundle.manifest;
          const command = commandId ?? manifest.commands[0]?.id ?? null;
          rememberLastRun(pluginId, command);
          // Running a plugin again restarts it, as in Figma.
          for (const entry of live.current.values()) if (entry.pluginId === pluginId && !entry.key.startsWith('widget:')) entry.session.close();
          const key = `run:${++nextKey}`;
          setRunning((list) => [...list, { key, pluginId, name: manifest.name, command, ui: null }]);
          start(record, command, key);
        },
        placeWidget(pluginId, widgetId) {
          const record = findPlugin(pluginId);
          if (!record || !record.enabled) {
            toast('That widget\'s plugin is not installed, or is turned off.', true);
            return;
          }
          const state = store.getState();
          const center = screenToWorld(state.viewport, { x: state.canvasSize.width / 2, y: state.canvasSize.height / 2 });
          placeWidget(store, widgetSession(record), record.bundle.manifest, widgetId, { x: center.x - 60, y: center.y - 24 }).catch((error) => failed(pluginId, error));
        },
        stop(key) {
          live.current.get(key)?.session.close();
        },
      },
    });

    // A click on a widget runs its handler.
    const onCanvasClick = (clicked: typeof store, world: { x: number; y: number }): void => {
      if (clicked !== store) return;
      const state = store.getState();
      if (state.tool !== 'move') return;
      const click = widgetClickAt(state.doc, state.pageId, world, 0);
      if (!click) return;
      const record = findPlugin(click.widget.pluginId);
      if (!record || !record.enabled || record.bundle.manifest.kind !== 'widget') {
        toast(`This widget's plugin (${click.widget.pluginId}) is not installed here, or is turned off.`, true);
        return;
      }
      if (state.readOnly) {
        toast('This file can only be viewed here, so its widgets cannot be changed.', true);
        return;
      }
      runWidgetClick(store, widgetSession(record), record.bundle.manifest.name, click).catch((error) => failed(record.id, error));
    };
    canvasClickListeners.add(onCanvasClick);

    // What a plugin's window sends goes to the plugin, as the "message" event.
    const onMessage = (event: MessageEvent): void => {
      for (const entry of live.current.values()) {
        if (!entry.ui.frame || event.source !== entry.ui.frame.contentWindow) continue;
        const data = event.data as { pluginMessage?: unknown } | null;
        if (data && typeof data === 'object' && 'pluginMessage' in data) entry.session.emit('message', data.pluginMessage);
      }
    };
    window.addEventListener('message', onMessage);

    // Ctrl+Alt+P runs the last plugin again.
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.code !== 'KeyP' || !(event.ctrlKey || event.metaKey) || !event.altKey || event.shiftKey) return;
      // Where text is typed, Ctrl+Alt (AltGr on some keyboards) may be typing a character.
      const target = event.target as HTMLElement | null;
      if (target?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
      event.preventDefault();
      const last = pluginsStore.getState().lastRun;
      if (last) pluginsStore.getState().actions?.run(last.pluginId, last.commandId);
      else toast('No plugin has been run yet.');
    };
    window.addEventListener('keydown', onKeyDown);

    // A plugin turned off or uninstalled stops.
    const unsubscribe = pluginsStore.subscribe((state, previous) => {
      if (state.installed === previous.installed) return;
      for (const entry of [...live.current.values()]) {
        const record = state.installed.find((item) => item.id === entry.pluginId);
        if (!record || !record.enabled || record.bundle !== entry.bundle) entry.session.close();
      }
    });

    const sessions = live.current;
    return () => {
      unsubscribe();
      canvasClickListeners.delete(onCanvasClick);
      window.removeEventListener('message', onMessage);
      window.removeEventListener('keydown', onKeyDown);
      for (const entry of [...sessions.values()]) entry.session.close();
      pluginsStore.setState({ actions: null, running: [] });
    };
  }, [store, storage, images]);

  return (
    <>
      <div ref={sandboxes} hidden data-plugin-sandboxes="" />
      {running
        .filter((item) => item.ui?.visible)
        .map((item) => {
          const entry = live.current.get(item.key);
          if (!entry || !entry.bundle.ui) return null;
          return <PluginWindow key={item.key} title={item.ui!.title} width={item.ui!.width} height={item.ui!.height} html={entry.bundle.ui} handle={entry.ui} onClose={() => entry.session.close()} />;
        })}
      {(running.some((item) => !item.ui?.visible) || toasts.length > 0) && (
        <div className="pointer-events-none fixed bottom-[84px] left-1/2 z-[60] flex -translate-x-1/2 flex-col items-center gap-2" aria-live="polite">
          {running
            .filter((item) => !item.ui?.visible)
            .map((item) => (
              <div key={item.key} role="status" className="ev-popover pointer-events-auto flex items-center gap-3 !rounded-full py-1.5 pl-4 pr-1.5 text-[12px] text-ink">
                <span className="h-2 w-2 flex-none animate-pulse rounded-full bg-accent" aria-hidden="true" />
                <span>Running {item.name}</span>
                <button type="button" className="ev-button !h-6 !rounded-full !px-3" onClick={() => pluginsStore.getState().actions?.stop(item.key)}>
                  Stop
                </button>
              </div>
            ))}
          {toasts.map((item) => (
            <div
              key={item.id}
              role={item.error ? 'alert' : 'status'}
              className={`ev-popover pointer-events-auto max-w-[520px] !rounded-full px-4 py-2 text-[12px] ${item.error ? 'text-danger' : 'text-ink'}`}
            >
              {item.message}
            </div>
          ))}
        </div>
      )}
      {managerOpen && <PluginManager />}
      {pending && <InstallDialog bundle={pending.bundle} source={pending.source} />}
    </>
  );
}
