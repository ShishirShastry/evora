/**
 * What runs inside a plugin's sandbox: the `evora` object a plugin's code
 * talks to, which turns every call into a message to the app and every
 * answer back into a settled promise. The app (see `session.ts`) carries out
 * the calls, after checking the plugin's permissions.
 *
 * A plugin's code runs in an iframe with `sandbox="allow-scripts"` (no
 * `allow-same-origin`: an opaque origin, with no access to the app, its
 * storage or its cookies) and a Content-Security-Policy that allows inline
 * scripts and styles and nothing else: no network, no other frames, no
 * forms. The only way out is `parent.postMessage`.
 *
 * The runtime is kept here as source text, so that it can be put in the
 * sandbox's document as it is, and run by the tests against a stand-in window.
 */
import type { PluginBundle } from './manifest';

/** Every message between the app and a sandbox carries this, so that other messages are ignored. */
export const MESSAGE_TAG = 'evora-plugin';

/** The Content-Security-Policy of every plugin frame: inline code and styles only; pictures only from data and blob addresses; nothing fetched. */
export const SANDBOX_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'";

/** The sandbox attribute of a plugin's code frame. */
export const SANDBOX_FLAGS = 'allow-scripts';

/**
 * The sandbox attribute of a plugin's window. Forms are allowed so that a
 * form's submit event reaches the window's own script (a sandbox without
 * them drops the submission before the event); the policy's
 * `form-action 'none'` still stops a form from going anywhere.
 */
export const UI_SANDBOX_FLAGS = 'allow-scripts allow-forms';

/** The API methods a plugin can call, by the names it calls them with. */
export const API_METHODS = [
  'notify',
  'closePlugin',
  'getDocument',
  'getPages',
  'getCurrentPage',
  'setCurrentPage',
  'getSelection',
  'setSelection',
  'getNode',
  'getChildren',
  'findAll',
  'findOne',
  'createRectangle',
  'createEllipse',
  'createFrame',
  'createText',
  'createInstance',
  'setProperties',
  'remove',
  'group',
  'getComponents',
  'getStyles',
  'createStyle',
  'updateStyle',
  'getVariableCollections',
  'getVariables',
  'createVariableCollection',
  'createVariable',
  'setVariableValue',
  'exportAsync',
  'showUI',
] as const;

export interface RuntimeConfig {
  pluginId: string;
  pluginName: string;
  kind: 'plugin' | 'widget';
  /** The menu command the plugin was run with; null for a widget's sandbox. */
  command: string | null;
  apiVersion: number;
}

/**
 * The runtime, as the body of a function of `window`, `parent` and `config`.
 * Plain JavaScript (ES2020), as the sandbox gets it.
 */
export const RUNTIME_SOURCE = String.raw`
'use strict';
var TAG = ${JSON.stringify(MESSAGE_TAG)};
var METHODS = ${JSON.stringify(API_METHODS)};
var nextId = 1;
var pending = new Map();
var listeners = new Map();
var widgets = new Map();
var original = window.console;
var post = function (message) {
  message.tag = TAG;
  parent.postMessage(message, '*');
};
var text = function (value) {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack || (value.name + ': ' + value.message);
  try {
    var json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch (e) {
    return String(value);
  }
};
var describe = function (error) {
  if (error instanceof Error) return error.message || String(error);
  return text(error);
};
var call = function (method, args) {
  return new Promise(function (resolve, reject) {
    var id = nextId++;
    pending.set(id, { resolve: resolve, reject: reject });
    try {
      post({ kind: 'call', id: id, method: method, args: args });
    } catch (e) {
      pending.delete(id);
      reject(new Error('The arguments of ' + method + ' cannot be sent to Evora: ' + describe(e)));
    }
  });
};
var listen = function (event, on) {
  post({ kind: 'listen', event: event, on: on });
};
var evora = {
  apiVersion: config.apiVersion,
  pluginId: config.pluginId,
  pluginName: config.pluginName,
  command: config.command,
  on: function (event, fn) {
    if (typeof fn !== 'function') throw new TypeError('evora.on needs a function');
    var set = listeners.get(event);
    if (!set) {
      set = new Set();
      listeners.set(event, set);
      listen(event, true);
    }
    set.add(fn);
  },
  off: function (event, fn) {
    var set = listeners.get(event);
    if (!set) return;
    set.delete(fn);
    if (set.size === 0) {
      listeners.delete(event);
      listen(event, false);
    }
  },
  once: function (event, fn) {
    var wrapped = function (data) {
      evora.off(event, wrapped);
      fn(data);
    };
    evora.on(event, wrapped);
  },
  batch: async function (fn) {
    await call('batch.begin', []);
    try {
      return await fn();
    } finally {
      await call('batch.end', []);
    }
  },
  ui: {
    onmessage: null,
    postMessage: function (message) { return call('ui.postMessage', [message]); },
    resize: function (width, height) { return call('ui.resize', [width, height]); },
    close: function () { return call('ui.close', []); },
  },
  clientStorage: {
    getAsync: function (key) { return call('clientStorage.getAsync', [key]); },
    setAsync: function (key, value) { return call('clientStorage.setAsync', [key, value]); },
    deleteAsync: function (key) { return call('clientStorage.deleteAsync', [key]); },
    keysAsync: function () { return call('clientStorage.keysAsync', []); },
  },
  widget: {
    register: function (id, definition) {
      if (typeof id !== 'string' || !id) throw new TypeError('evora.widget.register needs the widget ID from the manifest');
      if (!definition || typeof definition.render !== 'function') throw new TypeError('A widget needs a render(state) function');
      widgets.set(id, definition);
    },
  },
};
METHODS.forEach(function (name) {
  evora[name] = function () {
    return call(name, Array.prototype.slice.call(arguments));
  };
});
var emit = function (event, data) {
  if (event === 'message' && typeof evora.ui.onmessage === 'function') {
    try { evora.ui.onmessage(data); } catch (e) { report(e); }
  }
  var set = listeners.get(event);
  if (!set) return;
  Array.from(set).forEach(function (fn) {
    try {
      var result = fn(data);
      if (result && typeof result.then === 'function') result.then(undefined, report);
    } catch (e) {
      report(e);
    }
  });
};
var report = function (error) {
  post({ kind: 'error', text: describe(error), stack: error instanceof Error && error.stack ? String(error.stack) : '' });
};
var widgetOf = function (id) {
  var widget = widgets.get(id);
  if (!widget) throw new Error('This plugin has not registered a widget "' + id + '" (evora.widget.register)');
  return widget;
};
var clone = function (value) {
  return value === undefined ? null : JSON.parse(JSON.stringify(value));
};
var answer = async function (method, args) {
  if (method === 'widget.initial') {
    var widget = widgetOf(args[0]);
    var initial = typeof widget.initialState === 'function' ? await widget.initialState() : widget.initialState;
    return clone(initial === undefined ? {} : initial);
  }
  if (method === 'widget.render') {
    return clone(await widgetOf(args[0]).render(args[1]));
  }
  if (method === 'widget.click') {
    var handlers = widgetOf(args[0]).handlers || {};
    var handler = handlers[args[1]];
    if (typeof handler !== 'function') throw new Error('The widget "' + args[0] + '" has no click handler "' + args[1] + '"');
    var next = await handler(args[2], args[3] || {});
    return clone(next === undefined ? args[2] : next);
  }
  throw new Error('Unknown request: ' + method);
};
window.addEventListener('message', function (event) {
  if (event.source !== parent) return;
  var message = event.data;
  if (!message || message.tag !== TAG) return;
  if (message.kind === 'reply') {
    var waiting = pending.get(message.id);
    if (!waiting) return;
    pending.delete(message.id);
    if (message.ok) waiting.resolve(message.value);
    else waiting.reject(new Error(message.error));
  } else if (message.kind === 'event') {
    emit(message.name, message.data);
  } else if (message.kind === 'call') {
    answer(message.method, message.args || []).then(
      function (value) { post({ kind: 'reply', id: message.id, ok: true, value: value }); },
      function (error) { post({ kind: 'reply', id: message.id, ok: false, error: describe(error) }); }
    );
  }
});
var forward = function (level) {
  return function () {
    var args = Array.prototype.slice.call(arguments);
    try { post({ kind: 'console', level: level, text: args.map(text).join(' ') }); } catch (e) { /* nothing to be done */ }
    if (original && typeof original[level] === 'function') original[level].apply(original, args);
  };
};
window.console = { log: forward('log'), info: forward('info'), warn: forward('warn'), error: forward('error'), debug: forward('log') };
window.addEventListener('error', function (event) {
  report(event.error || new Error(event.message));
});
window.addEventListener('unhandledrejection', function (event) {
  report(event.reason);
});
window.evora = evora;
window.__evoraReport = report;
window.__evoraReady = function () { post({ kind: 'ready' }); };
`;

/**
 * A plugin's code, wrapped so that it may use `await` at its top level and
 * any error it throws is reported. Plain JavaScript, a statement.
 */
export function wrapPluginCode(code: string): string {
  return `(async function (evora, console) {\n${code}\n})(window.evora, window.console).catch(function (error) { window.__evoraReport(error); });\nwindow.__evoraReady();`;
}

/** Text that is safe inside an inline script: a "</script" in it would end the script early. */
function inScript(source: string): string {
  return source.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
}

/** The document of a plugin's code sandbox: the runtime, then the plugin's code. Nothing is shown. */
export function sandboxDocument(bundle: PluginBundle, command: string | null): string {
  const config: RuntimeConfig = {
    pluginId: bundle.manifest.id,
    pluginName: bundle.manifest.name,
    kind: bundle.manifest.kind,
    command,
    apiVersion: bundle.manifest.api,
  };
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP}">`,
    `<script>(function (window, parent, config) {${inScript(RUNTIME_SOURCE)}})(window, window.parent, ${inScript(JSON.stringify(config))});</script>`,
    `<script>${inScript(wrapPluginCode(bundle.code))}</script>`,
    '</head><body></body></html>',
  ].join('\n');
}

/**
 * The document of a plugin's window: its own HTML, with the same policy and
 * Evora's colours as CSS variables (`--evora-bg`, `--evora-text`, …) so a
 * plugin can look at home in both themes.
 */
export function uiDocument(html: string, theme: 'dark' | 'light'): string {
  const colors =
    theme === 'dark'
      ? '--evora-bg:#1c1c1f;--evora-panel:#141415;--evora-field:#1e1e21;--evora-line:#27272b;--evora-text:#f2f2f4;--evora-dim:#a0a0a8;--evora-accent:#0d99ff;--evora-danger:#ff5a5f;color-scheme:dark;'
      : '--evora-bg:#ffffff;--evora-panel:#ffffff;--evora-field:#f1f1f4;--evora-line:#e2e2e7;--evora-text:#18181c;--evora-dim:#66666f;--evora-accent:#0d8bf2;--evora-danger:#e5484d;color-scheme:light;';
  const base = `<style>:root{${colors}}html,body{margin:0;background:var(--evora-bg);color:var(--evora-text);font:12px/1.45 Inter,system-ui,-apple-system,"Segoe UI",sans-serif;}</style>`;
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP}">`,
    base,
    '</head><body>',
    html,
    '</body></html>',
  ].join('\n');
}
