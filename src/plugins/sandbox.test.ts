import { describe, expect, it, vi } from 'vitest';
import { getLayer, type TextNode } from '../core';
import { MESSAGE_TAG, SANDBOX_CSP, SANDBOX_FLAGS, UI_SANDBOX_FLAGS, sandboxDocument, uiDocument } from './runtime';
import { add, editor, example, memoryStorage, settle, startFake, testBundle } from './testing';


describe('the sandbox document', () => {
  it('runs the plugin with scripts only, no network, and its code kept inside its script', () => {
    const bundle = testBundle({}, 'const s = "</script><script>alert(1)</script>"; evora.closePlugin();');
    const html = sandboxDocument(bundle, 'run');
    expect(SANDBOX_FLAGS).toBe('allow-scripts');
    // A window's forms may raise their submit event, and go nowhere.
    expect(UI_SANDBOX_FLAGS).toBe('allow-scripts allow-forms');
    expect(SANDBOX_CSP).toContain("form-action 'none'");
    expect(SANDBOX_CSP).toContain("default-src 'none'");
    expect(SANDBOX_CSP).toContain("connect-src 'none'");
    expect(SANDBOX_CSP).not.toContain('unsafe-eval');
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP}">`);
    // The plugin's text cannot end its script early.
    expect(html.match(/<\/script>/gi)).toHaveLength(2);
    expect(html).toContain('"command":"run"');
    const ui = uiDocument('<button>Go</button>', 'light');
    expect(ui).toContain(SANDBOX_CSP);
    expect(ui).toContain('--evora-text:#18181c');
    expect(ui).toContain('<button>Go</button>');
  });
});

describe('the sandbox message protocol', () => {
  it('carries out calls, answers with copies, and passes on refusals as rejected promises', async () => {
    const store = editor();
    const id = add(store, 'RECTANGLE', { name: 'Box' });
    store.getState().setSelection([id]);
    const bundle = testBundle(
      { permissions: ['read'] },
      `
      const selection = await evora.getSelection();
      console.log('selected', selection.map((n) => n.name));
      try {
        await evora.setProperties(selection[0].id, { name: 'Changed' });
      } catch (error) {
        console.error('refused:', error.message);
      }
      try {
        await evora.notify(() => 1);
      } catch (error) {
        console.warn('not sent');
      }
      evora.closePlugin('Done');
      `,
    );
    const sandbox = startFake(bundle, 'run', { store });
    await sandbox.session.ready;
    await settle();
    expect(sandbox.console).toEqual([
      { level: 'log', text: 'selected ["Box"]' },
      { level: 'error', text: 'refused: Test plugin does not have the "write" permission, which evora.setProperties needs. Add it to the plugin\'s manifest.' },
      { level: 'warn', text: 'not sent' },
    ]);
    expect(getLayer(store.getState().doc, id)?.name).toBe('Box');
    expect(sandbox.closed).toEqual([{ message: 'Done' }]);
    expect(sandbox.session.closed).toBe(true);
    // Every message carries the tag, so other messages are not taken for a plugin's.
    expect(sandbox.sent.every((message) => message.tag === MESSAGE_TAG)).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 80));
    expect(sandbox.disposed()).toBe(true);
  });

  it('reports errors the plugin does not catch', async () => {
    const sandbox = startFake(testBundle({}, 'await Promise.resolve(); throw new TypeError("broken");'), 'run', { store: editor() });
    await settle();
    expect(sandbox.console).toEqual([{ level: 'error', text: 'broken' }]);
  });

  it('tells a plugin of the events it listens for, and only with the permission they need', async () => {
    const store = editor();
    const id = add(store, 'RECTANGLE');
    const sandbox = startFake(
      testBundle(
        { permissions: ['read'] },
        `
        evora.on('selectionchange', (event) => console.log('selection', JSON.stringify(event.selection)));
        evora.on('documentchange', (event) => console.log('changes', event.changes.map((c) => c.type + ' ' + c.properties.join(',')).join(';')));
        evora.on('message', () => console.log('never'));
        evora.on('close', () => console.log('closing'));
        `,
      ),
      'run',
      { store },
    );
    sandbox.session.watch(store);
    await sandbox.session.ready;
    await settle();
    expect(sandbox.session.listensTo('selectionchange')).toBe(true);
    // "message" needs the "ui" permission.
    expect(sandbox.session.listensTo('message')).toBe(false);
    expect(sandbox.console).toEqual([{ level: 'error', text: 'Test plugin does not have the "ui" permission, which the "message" event needs.' }]);
    store.getState().setSelection([id]);
    store.getState().apply('Rename', (doc) => ({ ...doc, nodes: { ...doc.nodes, [id]: { ...getLayer(doc, id)!, name: 'Renamed' } } }));
    await settle();
    expect(sandbox.console.slice(1)).toEqual([
      { level: 'log', text: `selection ["${id}"]` },
      { level: 'log', text: 'changes PROPERTY_CHANGE name' },
    ]);
    sandbox.session.close();
    await settle();
    // The plugin is told it is closing; what it says after that is no longer taken.
    expect(sandbox.received.at(-1)).toMatchObject({ kind: 'event', name: 'close' });
  });

  it('asks the sandbox for things itself, and gives up on one that does not answer', async () => {
    const sandbox = startFake(
      testBundle(
        { kind: 'widget', widgets: [{ id: 'w', name: 'W' }] },
        `evora.widget.register('w', { initialState: { n: 1 }, render: (s) => ({ type: 'frame', children: [] }), handlers: { slow: () => new Promise(() => {}) } });`,
      ),
      null,
      { store: editor() },
      { requestTimeoutMs: 50 },
    );
    expect(await sandbox.session.request('widget.initial', ['w'])).toEqual({ n: 1 });
    await expect(sandbox.session.request('widget.initial', ['nope'])).rejects.toThrow('has not registered a widget "nope"');
    await expect(sandbox.session.request('widget.click', ['w', 'missing', {}])).rejects.toThrow('has no click handler "missing"');
    await expect(sandbox.session.request('widget.click', ['w', 'slow', {}])).rejects.toThrow('did not answer in time');
  });
});

describe('the example plugins, run in the sandbox', () => {
  it('"Tidy up" arranges the selection in a grid as one undo step, and closes saying what it did', async () => {
    const store = editor();
    const ids = [0, 1, 2, 3].map((i) => add(store, 'RECTANGLE', { x: 300 - i * 70, y: i * 13, width: 40, height: 40 }));
    store.getState().setSelection(ids);
    const steps = store.getState().undoStack.length;
    const sandbox = startFake(example('tidy-up'), 'grid', { store });
    await settle();
    expect(sandbox.closed).toEqual([{ message: 'Arranged 4 layers in 2 columns.' }]);
    const place = (id: string) => ({ x: getLayer(store.getState().doc, id)!.x, y: getLayer(store.getState().doc, id)!.y });
    // Reading order (top to bottom): ids[0] … ids[3]; two columns, 16 apart, from the top left of the selection.
    expect(ids.map(place)).toEqual([
      { x: 90, y: 0 },
      { x: 146, y: 0 },
      { x: 90, y: 56 },
      { x: 146, y: 56 },
    ]);
    expect(store.getState().undoStack.length).toBe(steps + 1);
    expect(store.getState().undoStack.at(-1)?.label).toBe('Tidy up');

    const snap = startFake(example('tidy-up'), 'snap', { store });
    await settle();
    expect(snap.closed[0]?.message).toBe('Snapped 4 layers to the 8 px grid.');
    expect(ids.map(place).every((p) => p.x % 8 === 0 && p.y % 8 === 0)).toBe(true);
  });

  it('"Lorem ipsum" fills text, keeping where it got to in its own storage', async () => {
    const store = editor();
    const text = add(store, 'TEXT', { characters: 'one two three four' });
    store.getState().setSelection([text]);
    const storage = memoryStorage();
    const first = startFake(example('lorem-ipsum'), 'fill', { store, storage });
    await settle();
    expect(first.closed).toEqual([{ message: 'Filled 1 text layer.' }]);
    expect((getLayer(store.getState().doc, text) as TextNode).characters).toBe('Lorem ipsum dolor sit.');
    expect(storage.data.get('offset')).toBe(4);
    startFake(example('lorem-ipsum'), 'fill', { store, storage });
    await settle();
    expect((getLayer(store.getState().doc, text) as TextNode).characters).toBe('Amet consectetur adipiscing elit.');
    // Without the "storage" permission the same code is refused.
    const bundle = example('lorem-ipsum');
    const refused = startFake({ ...bundle, manifest: { ...bundle.manifest, permissions: ['read', 'write'] } }, 'fill', { store, storage });
    await settle();
    expect(refused.console.map((line) => line.text)).toEqual(['Lorem ipsum does not have the "storage" permission, which evora.clientStorage.getAsync needs. Add it to the plugin\'s manifest.']);
  });

  it('"Rename layers" shows its window and renames what its window asks, as one undo step', async () => {
    const store = editor();
    const ids = [add(store, 'RECTANGLE'), add(store, 'ELLIPSE')];
    store.getState().setSelection(ids);
    const showUI = vi.fn();
    const toWindow: unknown[] = [];
    const notify = vi.fn();
    const sandbox = startFake(example('rename-layers'), 'rename', { store, showUI, notify, postToUI: (message) => toWindow.push(message) });
    sandbox.session.watch(store);
    await settle();
    expect(showUI).toHaveBeenCalledWith({ width: 300, height: 196, title: 'Rename layers', visible: true });
    expect(toWindow).toEqual([{ type: 'selection', count: 2, first: 'Rectangle 1' }]);
    const steps = store.getState().undoStack.length;
    // What the window sends (parent.postMessage({ pluginMessage })) reaches the plugin as "message".
    sandbox.session.emit('message', { type: 'rename', pattern: 'Card $n ($&)', start: 1 });
    await settle();
    expect(ids.map((id) => getLayer(store.getState().doc, id)?.name)).toEqual(['Card 1 (Rectangle 1)', 'Card 2 (Ellipse 1)']);
    expect(store.getState().undoStack.length).toBe(steps + 1);
    expect(notify).toHaveBeenCalledWith('Renamed 2 layers.', { error: false, timeout: 3000 });
    sandbox.session.emit('message', { type: 'rename', find: 'Card', replace: 'Tile' });
    await settle();
    expect(ids.map((id) => getLayer(store.getState().doc, id)?.name)).toEqual(['Tile 1 (Rectangle 1)', 'Tile 2 (Ellipse 1)']);
    // The selection changing is sent on to the window.
    store.getState().setSelection([ids[0]!]);
    await settle();
    expect(toWindow.at(-1)).toEqual({ type: 'selection', count: 1, first: 'Tile 1 (Rectangle 1)' });
    sandbox.session.emit('message', { type: 'cancel' });
    await settle();
    expect(sandbox.session.closed).toBe(true);
  });
});
