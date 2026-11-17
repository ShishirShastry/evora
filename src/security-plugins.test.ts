/**
 * Security tests of the plugin sandbox (Phase 10): hostile plugins run in the
 * stand-in sandbox (the real runtime and the plugin's real code, talking to
 * the app only through copied messages) and must not get past their
 * permissions, wear the app out, or keep it waiting for ever. What the
 * browser itself enforces (the frame's sandbox and its policy) is checked as
 * the attributes and policy the frame is given.
 */
import { describe, expect, it } from 'vitest';
import { getLayer } from './core';
import { METHOD_PERMISSIONS, PluginApi } from './plugins/api';
import { API_METHODS, MESSAGE_TAG, SANDBOX_CSP, SANDBOX_FLAGS, UI_SANDBOX_FLAGS, sandboxDocument, uiDocument } from './plugins/runtime';
import { PLUGIN_LIMITS, PluginSession, type PluginChannel } from './plugins/session';
import { add, editor, settle, startFake, testBundle } from './plugins/testing';
import type { EditorStore } from './state/editorStore';

/** A sandbox that sends whatever it likes: raw messages, as a hostile frame could post them. */
function hostile(store: EditorStore, permissions: string[]) {
  let toApp: ((message: Record<string, unknown>) => void) | null = null;
  const replies: Record<string, unknown>[] = [];
  const channel: PluginChannel = {
    post(message) {
      const copy = structuredClone(message) as Record<string, unknown>;
      if (copy.kind === 'reply') replies.push(copy);
    },
    listen(handler) {
      toApp = handler;
      return () => {
        toApp = null;
      };
    },
    dispose() {},
  };
  const manifest = testBundle({ permissions }, 'void 0;').manifest;
  const api = new PluginApi({ store, manifest });
  const session = new PluginSession(api, channel, {});
  return { session, replies, send: (message: Record<string, unknown>) => toApp?.({ ...message, tag: MESSAGE_TAG }) };
}

describe('the frame a plugin runs in', () => {
  it('has scripts only: no same origin (so no access to the app, its storage or cookies), no popups, no navigating the app', () => {
    for (const flags of [SANDBOX_FLAGS, UI_SANDBOX_FLAGS]) {
      const list = flags.split(/\s+/);
      expect(list).toContain('allow-scripts');
      for (const forbidden of ['allow-same-origin', 'allow-top-navigation', 'allow-top-navigation-by-user-activation', 'allow-top-navigation-to-custom-protocols', 'allow-popups', 'allow-popups-to-escape-sandbox', 'allow-modals', 'allow-downloads', 'allow-pointer-lock', 'allow-presentation', 'allow-storage-access-by-user-activation'])
        expect(list, `${flags} must not have ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('has a policy that fetches nothing, frames nothing, evaluates no strings and sends no forms', () => {
    const directives = new Map(SANDBOX_CSP.split(';').map((part) => part.trim().split(/\s+/)).map(([name, ...values]) => [name as string, values]));
    expect(directives.get('default-src')).toEqual(["'none'"]);
    expect(directives.get('connect-src')).toEqual(["'none'"]);
    expect(directives.get('frame-src')).toEqual(["'none'"]);
    expect(directives.get('worker-src')).toEqual(["'none'"]);
    expect(directives.get('form-action')).toEqual(["'none'"]);
    expect(directives.get('base-uri')).toEqual(["'none'"]);
    expect(directives.get('script-src')).toEqual(["'unsafe-inline'"]);
    expect(SANDBOX_CSP).not.toMatch(/unsafe-eval|https?:|\*/);
    // Pictures only from data and blob addresses: an <img src="https://…"> cannot carry data out.
    expect(directives.get('img-src')).toEqual(['data:', 'blob:']);
  });

  it('puts the policy before anything of the plugin’s, which cannot end its script or the head early', () => {
    const hostile = testBundle({}, '</script><meta http-equiv="Content-Security-Policy" content="default-src *"><script>parent.location="https://evil.example"</script>');
    const html = sandboxDocument(hostile, 'run');
    const policyAt = html.indexOf('Content-Security-Policy');
    expect(policyAt).toBeGreaterThan(0);
    expect(html.indexOf('</script><meta')).toBe(-1);
    // Only the runtime's script and the plugin's script end.
    expect(html.match(/<\/script>/gi)).toHaveLength(2);
    // A window's own HTML comes after the policy, so a <meta> in it can only add rules (rules only ever narrow).
    const ui = uiDocument('<meta http-equiv="Content-Security-Policy" content="default-src *"><img src="https://evil.example/x.png">', 'dark');
    expect(ui.indexOf(SANDBOX_CSP)).toBeLessThan(ui.indexOf('default-src *'));
  });
});

describe('a hostile plugin', () => {
  it('cannot call anything that is not the plugin API, whatever name it sends', async () => {
    const store = editor();
    const sandbox = hostile(store, ['read', 'write', 'export', 'ui', 'storage']);
    const names = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf', 'call', 'finish', 'change', 'env', 'doc', 'allows', 'endBatch', ''];
    for (const [i, name] of names.entries()) sandbox.send({ kind: 'call', id: i, method: name, args: [] });
    sandbox.send({ kind: 'call', id: 99, method: { toString: () => 'getSelection' }, args: 'not a list' });
    await settle(100);
    expect(sandbox.replies).toHaveLength(names.length + 1);
    for (const reply of sandbox.replies) {
      expect(reply.ok).toBe(false);
      expect(String(reply.error)).toMatch(/is not part of the plugin API/);
    }
  });

  it('is refused every method its permissions do not cover', async () => {
    const store = editor();
    const id = add(store, 'RECTANGLE', { name: 'Keep me' });
    // Every method that needs a permission, from the API's own table.
    const needing = API_METHODS.filter((method) => METHOD_PERMISSIONS[method] !== null && METHOD_PERMISSIONS[method] !== undefined);
    expect(needing.length).toBeGreaterThan(10);
    const sandbox = hostile(store, []);
    for (const [i, method] of needing.entries()) sandbox.send({ kind: 'call', id: i, method, args: [id, { name: 'Changed' }] });
    await settle(200);
    expect(sandbox.replies).toHaveLength(needing.length);
    for (const reply of sandbox.replies) {
      expect(reply.ok).toBe(false);
      expect(String(reply.error)).toMatch(/does not have the "[a-z]+" permission/);
    }
    expect(getLayer(store.getState().doc, id)?.name).toBe('Keep me');
    expect(store.getState().undoStack).toHaveLength(1);
    // And events it has no permission for are not sent to it.
    sandbox.send({ kind: 'listen', event: 'documentchange', on: true });
    sandbox.send({ kind: 'listen', event: '__proto__', on: true });
    await settle();
    expect(sandbox.session.listensTo('documentchange')).toBe(false);
    expect(sandbox.session.listensTo('__proto__')).toBe(false);
  });

  it('is stopped when it floods the app with calls, and the reason is given', async () => {
    const store = editor();
    const bundle = testBundle({ permissions: ['read'] }, `for (let i = 0; i < ${PLUGIN_LIMITS.MAX_MESSAGES + 500}; i++) evora.getSelection();`);
    const sandbox = startFake(bundle, 'run', { store });
    await settle(400);
    expect(sandbox.session.closed).toBe(true);
    expect(sandbox.closed[0]?.message).toMatch(/was stopped: it (sent too many messages|made too many calls at once)/);
    expect(sandbox.console.some((line) => line.level === 'error' && /was stopped/.test(line.text))).toBe(true);
  });

  it('is stopped when it keeps too many calls waiting at once', async () => {
    const store = editor();
    // Calls that the app is still carrying out when more arrive: the app's side is made to never finish one.
    const fresh = startFake(testBundle({ permissions: ['read'] }, `for (let i = 0; i < ${PLUGIN_LIMITS.MAX_IN_FLIGHT + 10}; i++) evora.getSelection();`), 'run', { store });
    (fresh.api as unknown as { call: (method: string, args: unknown[]) => Promise<unknown> }).call = () => new Promise(() => undefined);
    await settle(200);
    expect(fresh.session.closed).toBe(true);
    expect(fresh.closed[0]?.message).toMatch(/made too many calls at once/);
  });

  it('cannot fill the console with one enormous line', async () => {
    const store = editor();
    const sandbox = startFake(testBundle({}, `console.log('x'.repeat(200_000)); evora.closePlugin();`), 'run', { store });
    await settle();
    const line = sandbox.console[0]?.text ?? '';
    expect(line.length).toBeLessThanOrEqual(PLUGIN_LIMITS.MAX_CONSOLE_TEXT + 10);
    expect(line).toMatch(/… \(cut\)$/);
  });

  it('cannot keep the app waiting for an answer for ever', async () => {
    const store = editor();
    const bundle = testBundle(
      { kind: 'widget', permissions: [], widgets: [{ id: 'stuck', name: 'Stuck' }] },
      `evora.widget.register('stuck', { initialState: {}, render: () => new Promise(() => {}) });`,
    );
    const sandbox = startFake(bundle, null, { store }, { requestTimeoutMs: 150 });
    await sandbox.session.ready;
    await expect(sandbox.session.request('widget.render', ['stuck', {}])).rejects.toThrow(/did not answer in time/);
    await expect(sandbox.session.request('widget.render', ['missing', {}])).rejects.toThrow(/has not registered a widget/);
  });
});
