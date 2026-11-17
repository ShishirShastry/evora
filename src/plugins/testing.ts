/**
 * For the plugin tests: a sandbox that runs the real runtime and a plugin's
 * real code in this process, against a stand-in window, connected to the app
 * by a channel that delivers messages the way postMessage does (later, and
 * copied). Not used by the app.
 */
import { addLayer, createDocument, getPages, type Document, type JsonValue, type LayerPatch, type LayerType, type NodeId } from '../core';
import { createEditorStore, type EditorStore } from '../state/editorStore';
import { PluginApi, type ClientStorage, type PluginApiEnvironment } from './api';
import { makeBundle, parseBundle, type PluginBundle } from './manifest';
import { RUNTIME_SOURCE, wrapPluginCode, type RuntimeConfig } from './runtime';
import { PluginSession, type ConsoleLevel, type PluginChannel } from './session';

// Node's, which the app's own types do not describe.
declare const setImmediate: (fn: () => void) => unknown;

/** Every file of the example plugins (plugins/examples), by path from here, as text. */
export const EXAMPLE_FILES = import.meta.glob('../../plugins/examples/**/*', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

/** An example plugin's bundle (plugins/examples/<name>.evora-plugin). */
export function example(name: string): PluginBundle {
  const text = EXAMPLE_FILES[`../../plugins/examples/${name}.evora-plugin`];
  if (text === undefined) throw new Error(`There is no example "${name}"`);
  return parseBundle(text);
}

/** A store with an empty page. */
export function editor(doc: Document = createDocument('Plugins')): EditorStore {
  return createEditorStore(doc);
}

export function pageOf(store: EditorStore): NodeId {
  return getPages(store.getState().doc)[0]!.id;
}

/** Adds a layer to the page (or a parent), as one undo step of its own. */
export function add(store: EditorStore, type: LayerType, props: LayerPatch = {}, parentId?: NodeId): NodeId {
  let id = '';
  store.getState().apply('Add', (doc) => {
    const added = addLayer(doc, type, parentId ?? store.getState().pageId, props);
    id = added.id;
    return added.doc;
  });
  return id;
}

/** A plugin's own data, kept in memory. */
export function memoryStorage(): ClientStorage & { data: Map<string, JsonValue> } {
  const data = new Map<string, JsonValue>();
  return {
    data,
    get: async (key) => data.get(key),
    set: async (key, value) => void data.set(key, value),
    delete: async (key) => void data.delete(key),
    keys: async () => [...data.keys()],
  };
}

/** A bundle made from a manifest's parts, for tests. */
export function testBundle(manifest: Record<string, unknown>, code: string, ui: string | null = null): PluginBundle {
  return makeBundle({ id: 'com.example.test', name: 'Test plugin', version: '1.0.0', author: 'Tests', kind: 'plugin', api: 1, permissions: [], ...manifest }, code, ui);
}

/** Waits until nothing more is queued: the messages in flight have arrived and been answered. */
export async function settle(rounds = 60): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((resolve) => setImmediate(() => resolve()));
}

interface FakeEvent {
  type: string;
  data?: unknown;
  source?: unknown;
  error?: unknown;
  message?: string;
  reason?: unknown;
}

/**
 * A stand-in for the sandbox's window: listeners, a console, and nothing
 * else (no DOM, no network, no storage), which is what plugin code may count on.
 */
class FakeWindow {
  console: Record<string, (...args: unknown[]) => void> = { log() {}, info() {}, warn() {}, error() {} };
  private listeners = new Map<string, Set<(event: FakeEvent) => void>>();
  [key: string]: unknown;

  addEventListener(type: string, fn: (event: FakeEvent) => void): void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(fn);
  }

  removeEventListener(type: string, fn: (event: FakeEvent) => void): void {
    this.listeners.get(type)?.delete(fn);
  }

  dispatch(event: FakeEvent): void {
    for (const fn of this.listeners.get(event.type) ?? []) fn(event);
  }
}

export interface FakeSandbox {
  session: PluginSession;
  api: PluginApi;
  /** Every message the sandbox sent, in order. */
  sent: Record<string, unknown>[];
  /** Every message the app sent the sandbox, in order. */
  received: Record<string, unknown>[];
  console: { level: ConsoleLevel; text: string }[];
  closed: { message: string | null }[];
  /** Whether the channel was disposed of (the frame removed). */
  disposed(): boolean;
}

/**
 * Starts a plugin in a stand-in sandbox: the runtime and the plugin's code run
 * here, and talk to the app's session only through the channel, as copies.
 */
export function startFake(bundle: PluginBundle, command: string | null, env: Omit<PluginApiEnvironment, 'manifest'>, options: { requestTimeoutMs?: number } = {}): FakeSandbox {
  const win = new FakeWindow();
  let toApp: ((message: Record<string, unknown>) => void) | null = null;
  const sent: Record<string, unknown>[] = [];
  const received: Record<string, unknown>[] = [];
  let disposed = false;
  const parent = {
    postMessage(message: unknown) {
      const copy = structuredClone(message) as Record<string, unknown>;
      sent.push(copy);
      setImmediate(() => toApp?.(copy));
    },
  };
  const channel: PluginChannel = {
    post(message) {
      const copy = structuredClone(message) as Record<string, unknown>;
      received.push(copy);
      setImmediate(() => win.dispatch({ type: 'message', data: copy, source: parent }));
    },
    listen(handler) {
      toApp = handler;
      return () => {
        toApp = null;
      };
    },
    dispose() {
      disposed = true;
    },
  };
  const consoleLines: FakeSandbox['console'] = [];
  const closed: FakeSandbox['closed'] = [];
  const api = new PluginApi({ ...env, manifest: bundle.manifest, close: (message) => session.close(message) });
  const session = new PluginSession(api, channel, {
    onConsole: (level, text) => consoleLines.push({ level, text }),
    onClosed: (message) => closed.push({ message }),
    requestTimeoutMs: options.requestTimeoutMs,
  });
  const config: RuntimeConfig = { pluginId: bundle.manifest.id, pluginName: bundle.manifest.name, kind: bundle.manifest.kind, command, apiVersion: bundle.manifest.api };
  // The two scripts of the sandbox's document, as the frame runs them.
  new Function('window', 'parent', 'config', RUNTIME_SOURCE)(win, parent, config);
  const run = new Function('window', wrapPluginCode(bundle.code));
  try {
    run(win);
  } catch (error) {
    win.dispatch({ type: 'error', error, message: String(error) });
  }
  return { session, api, sent, received, console: consoleLines, closed, disposed: () => disposed };
}
