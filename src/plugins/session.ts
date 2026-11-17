/**
 * A running plugin, on the app's side: the messages from its sandbox are
 * carried out by its `PluginApi` and answered; the editor's events are sent
 * to it while it listens for them (and may be told of them); and the app can
 * ask the sandbox for things itself (a widget's first state, what it draws,
 * what a click does).
 *
 * The sandbox is reached through a `PluginChannel`: an iframe's window in the
 * browser (`frameChannel`), a stand-in in the tests.
 */
import { diffDocuments, type Document, type NodeId } from '../core';
import type { EditorState, EditorStore } from '../state/editorStore';
import { EVENT_PERMISSIONS, PluginApi } from './api';
import { MESSAGE_TAG } from './runtime';

/** Where messages to and from a sandbox go. */
export interface PluginChannel {
  post(message: unknown): void;
  /** Calls `handler` with each message from the sandbox; returns what stops that. */
  listen(handler: (message: Record<string, unknown>) => void): () => void;
  dispose(): void;
}

/** A channel to the sandbox in an iframe: messages are taken only from that frame's window, and carry the tag. */
export function frameChannel(frame: HTMLIFrameElement, host: Window = window): PluginChannel {
  return {
    post(message) {
      // A sandbox without allow-same-origin has an opaque origin, which can only be addressed as "*".
      frame.contentWindow?.postMessage(message, '*');
    },
    listen(handler) {
      const onMessage = (event: MessageEvent): void => {
        if (event.source !== frame.contentWindow || !event.source) return;
        const data = event.data as Record<string, unknown> | null;
        if (data && typeof data === 'object' && data.tag === MESSAGE_TAG) handler(data);
      };
      host.addEventListener('message', onMessage);
      return () => host.removeEventListener('message', onMessage);
    },
    dispose() {
      frame.remove();
    },
  };
}

export type ConsoleLevel = 'log' | 'info' | 'warn' | 'error';

export interface SessionOptions {
  /** Each line the plugin writes to its console, and each error it does not catch. */
  onConsole?(level: ConsoleLevel, text: string): void;
  /** The plugin has ended (it closed itself, or was closed). */
  onClosed?(message: string | null): void;
  /** How long the app waits for the sandbox to answer one of its requests. */
  requestTimeoutMs?: number;
  /** How long the app waits for the sandbox to start. */
  readyTimeoutMs?: number;
}

/** The IDs of the layers a change touched, by what happened to them. */
export function documentChanges(before: Document, after: Document): { id: NodeId; type: 'CREATE' | 'DELETE' | 'PROPERTY_CHANGE'; properties: string[] }[] {
  const patch = diffDocuments(before, after);
  if (!patch) return [];
  return Object.entries(patch.nodes).map(([id, change]) => ({
    id,
    type: change.before === null ? 'CREATE' : change.after === null ? 'DELETE' : 'PROPERTY_CHANGE',
    properties: change.before !== null && change.after !== null ? Object.keys(change.after) : [],
  }));
}

const sameIds = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((id, i) => id === b[i]);

/**
 * Limits on what a plugin's sandbox may send, so that a plugin cannot wear
 * the app out: a plugin that sends more than MAX_MESSAGES in MESSAGE_WINDOW_MS,
 * or has more than MAX_IN_FLIGHT calls unanswered at once, is stopped with a
 * message saying why; a line of its console is cut to MAX_CONSOLE_TEXT.
 */
export const PLUGIN_LIMITS = { MAX_MESSAGES: 20_000, MESSAGE_WINDOW_MS: 10_000, MAX_IN_FLIGHT: 2_000, MAX_CONSOLE_TEXT: 10_000 } as const;

/** A line for the plugin's console: text, cut to PLUGIN_LIMITS.MAX_CONSOLE_TEXT. */
function consoleText(value: unknown, fallback: string): string {
  const text = typeof value === 'string' ? value : value === undefined || value === null ? fallback : String(value);
  return text.length > PLUGIN_LIMITS.MAX_CONSOLE_TEXT ? `${text.slice(0, PLUGIN_LIMITS.MAX_CONSOLE_TEXT)}… (cut)` : text;
}

export class PluginSession {
  readonly api: PluginApi;
  readonly ready: Promise<void>;
  private readonly channel: PluginChannel;
  private readonly options: SessionOptions;
  private readonly stopListening: () => void;
  private readonly listening = new Set<string>();
  private readonly waiting = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private nextId = 1;
  private markReady!: () => void;
  private failReady!: (error: Error) => void;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private unwatch: (() => void) | null = null;
  private closedFlag = false;
  /** Messages from the sandbox in the current window, and calls not yet answered. */
  private window = { start: 0, count: 0 };
  private inFlight = 0;

  constructor(api: PluginApi, channel: PluginChannel, options: SessionOptions = {}) {
    this.api = api;
    this.channel = channel;
    this.options = options;
    this.ready = new Promise<void>((resolve, reject) => {
      this.markReady = resolve;
      this.failReady = reject;
    });
    // Nobody may be waiting yet: a sandbox that does not start is reported when something asks it.
    this.ready.catch(() => undefined);
    this.readyTimer = setTimeout(() => this.failReady(new Error(`${api.manifest.name} did not start.`)), options.readyTimeoutMs ?? 10_000);
    this.stopListening = channel.listen((message) => this.receive(message));
  }

  get closed(): boolean {
    return this.closedFlag;
  }

  /** Whether the plugin listens for an event (and may be told of it). */
  listensTo(event: string): boolean {
    return this.listening.has(event);
  }

  private post(message: Record<string, unknown>): void {
    if (this.closedFlag) return;
    this.channel.post({ ...message, tag: MESSAGE_TAG });
  }

  private receive(message: Record<string, unknown>): void {
    if (this.closedFlag) return;
    const nowMs = Date.now();
    if (nowMs - this.window.start >= PLUGIN_LIMITS.MESSAGE_WINDOW_MS) this.window = { start: nowMs, count: 0 };
    if (++this.window.count > PLUGIN_LIMITS.MAX_MESSAGES) {
      this.stop(`${this.api.manifest.name} was stopped: it sent too many messages.`);
      return;
    }
    switch (message.kind) {
      case 'ready':
        if (this.readyTimer) clearTimeout(this.readyTimer);
        this.markReady();
        return;
      case 'call': {
        const id = message.id;
        const method = typeof message.method === 'string' ? message.method : '';
        const args = Array.isArray(message.args) ? message.args : [];
        if (this.inFlight >= PLUGIN_LIMITS.MAX_IN_FLIGHT) {
          this.stop(`${this.api.manifest.name} was stopped: it made too many calls at once.`);
          return;
        }
        this.inFlight++;
        this.api.call(method, args).then(
          (value) => {
            this.inFlight--;
            this.post({ kind: 'reply', id, ok: true, value: value === undefined ? null : value });
          },
          (error: unknown) => {
            this.inFlight--;
            this.post({ kind: 'reply', id, ok: false, error: error instanceof Error ? error.message : String(error) });
          },
        );
        return;
      }
      case 'reply': {
        const waiting = this.waiting.get(message.id as number);
        if (!waiting) return;
        this.waiting.delete(message.id as number);
        clearTimeout(waiting.timer);
        if (message.ok) waiting.resolve(message.value);
        else waiting.reject(new Error(typeof message.error === 'string' ? message.error : 'The plugin failed.'));
        return;
      }
      case 'listen': {
        const event = typeof message.event === 'string' ? message.event : '';
        if (message.on) {
          if (!Object.hasOwn(EVENT_PERMISSIONS, event)) {
            this.options.onConsole?.('warn', `There is no event "${event}". The events are: ${Object.keys(EVENT_PERMISSIONS).join(', ')}.`);
            return;
          }
          const needed = EVENT_PERMISSIONS[event] ?? null;
          if (!this.api.allows(needed)) {
            this.options.onConsole?.('error', `${this.api.manifest.name} does not have the "${needed}" permission, which the "${event}" event needs.`);
            return;
          }
          this.listening.add(event);
        } else this.listening.delete(event);
        return;
      }
      case 'console': {
        const level = message.level === 'warn' || message.level === 'error' || message.level === 'info' ? message.level : 'log';
        this.options.onConsole?.(level, consoleText(message.text, ''));
        return;
      }
      case 'error':
        this.options.onConsole?.('error', consoleText(message.text, 'An error'));
        return;
    }
  }

  /** Stops a plugin that broke a limit: the reason goes to its console and to whoever closes it. */
  private stop(reason: string): void {
    this.options.onConsole?.('error', reason);
    this.close(reason);
  }

  /** Tells the plugin of an event, if it listens for it. */
  emit(event: string, data: unknown = null): void {
    if (this.listening.has(event)) this.post({ kind: 'event', name: event, data });
  }

  /** Asks the sandbox for something (for widgets: "widget.initial", "widget.render", "widget.click"). */
  async request(method: string, args: unknown[]): Promise<unknown> {
    await this.ready;
    if (this.closedFlag) throw new Error(`${this.api.manifest.name} has stopped.`);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`${this.api.manifest.name} did not answer in time.`));
      }, this.options.requestTimeoutMs ?? 5000);
      this.waiting.set(id, { resolve, reject, timer });
      this.post({ kind: 'call', id, method, args });
    });
  }

  /** Sends the editor's selection, page and document changes to the plugin while it listens for them. */
  watch(store: EditorStore): void {
    this.unwatch?.();
    this.unwatch = store.subscribe((state: EditorState, previous: EditorState) => {
      if (state.selection !== previous.selection && !sameIds(state.selection, previous.selection) && this.listening.has('selectionchange')) this.emit('selectionchange', { selection: [...state.selection] });
      if (state.pageId !== previous.pageId) this.emit('currentpagechange', { pageId: state.pageId });
      if (state.doc !== previous.doc && this.listening.has('documentchange')) this.emit('documentchange', { changes: documentChanges(previous.doc, state.doc) });
    });
  }

  /** Ends the plugin: it is told (the "close" event), and then its sandbox is removed. */
  close(message: string | null = null): void {
    if (this.closedFlag) return;
    this.emit('close');
    try {
      this.api.finish();
    } catch (error) {
      this.options.onConsole?.('error', error instanceof Error ? error.message : String(error));
    }
    this.closedFlag = true;
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.unwatch?.();
    this.stopListening();
    for (const waiting of this.waiting.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(new Error(`${this.api.manifest.name} has stopped.`));
    }
    this.waiting.clear();
    // The "close" event is given a moment to arrive before the frame goes.
    setTimeout(() => this.channel.dispose(), 50);
    this.options.onClosed?.(message);
  }
}
