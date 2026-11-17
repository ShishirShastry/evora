import { describe, expect, it, vi } from 'vitest';
import { createComponent, getLayer, type FrameNode, type RectangleNode, type TextNode } from '../core';
import { PluginApi, PluginApiError, type PluginApiEnvironment } from './api';
import type { Permission } from './manifest';
import { add, editor, memoryStorage, pageOf } from './testing';

function apiFor(permissions: Permission[], extra: Partial<PluginApiEnvironment> = {}) {
  const store = extra.store ?? editor();
  const api = new PluginApi({ store, manifest: { id: 'com.example.test', name: 'Test plugin', permissions }, ...extra });
  return { store, api };
}

const ALL: Permission[] = ['read', 'write', 'export', 'ui', 'storage'];

describe('the plugin API: permissions', () => {
  it('refuses every call the plugin was not given the permission for, saying which it needs', async () => {
    const { store, api } = apiFor([]);
    const id = add(store, 'RECTANGLE');
    await expect(api.call('getSelection', [])).rejects.toThrow('Test plugin does not have the "read" permission, which evora.getSelection needs');
    await expect(api.call('createRectangle', [{}])).rejects.toThrow('"write" permission');
    await expect(api.call('setProperties', [id, { name: 'X' }])).rejects.toThrow('"write" permission');
    await expect(api.call('exportAsync', [id, { format: 'PNG' }])).rejects.toThrow('"export" permission');
    await expect(api.call('showUI', [{}])).rejects.toThrow('"ui" permission');
    await expect(api.call('clientStorage.getAsync', ['k'])).rejects.toThrow('"storage" permission');
    await expect(api.call('getVariables', [])).rejects.toThrow('"read" permission');
    // What every plugin may do.
    const notify = vi.fn();
    const quiet = new PluginApi({ store, manifest: { id: 'x.y', name: 'Quiet', permissions: [] }, notify });
    await quiet.call('notify', ['Hello', { timeout: 100 }]);
    expect(notify).toHaveBeenCalledWith('Hello', { error: false, timeout: 500 });
    // Nothing changed the file.
    expect(getLayer(store.getState().doc, id)?.name).toBe('Rectangle 1');
  });

  it('reads but does not write with only "read"', async () => {
    const { store, api } = apiFor(['read']);
    const id = add(store, 'RECTANGLE', { name: 'Card' });
    store.getState().setSelection([id]);
    const selection = (await api.call('getSelection', [])) as { id: string; name: string; type: string }[];
    expect(selection).toEqual([expect.objectContaining({ id, name: 'Card', type: 'RECTANGLE', x: 0, y: 0, width: 100, height: 100, children: [] })]);
    await expect(api.call('remove', [[id]])).rejects.toBeInstanceOf(PluginApiError);
    expect(getLayer(store.getState().doc, id)).toBeDefined();
  });

  it('refuses what is not part of the API', async () => {
    const { api } = apiFor(ALL);
    await expect(api.call('eval', ['1'])).rejects.toThrow('evora.eval is not part of the plugin API');
    await expect(api.call('constructor', [])).rejects.toThrow('not part of the plugin API');
  });
});

describe('the plugin API: changes', () => {
  it('makes each call one undo step, named after the plugin', async () => {
    const { store, api } = apiFor(ALL);
    const before = store.getState().undoStack.length;
    const made = (await api.call('createRectangle', [{ name: 'Made', x: 10, y: 20, width: 40, height: 30, fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 }, opacity: 1, visible: true }] }])) as { id: string };
    expect(store.getState().undoStack.length).toBe(before + 1);
    expect(store.getState().undoStack.at(-1)?.label).toBe('Test plugin');
    const node = getLayer(store.getState().doc, made.id) as RectangleNode;
    expect(node).toMatchObject({ name: 'Made', x: 10, y: 20, width: 40, height: 30, parentId: pageOf(store) });
    expect(node.fills[0]).toMatchObject({ type: 'SOLID', color: { r: 1, g: 0, b: 0 } });

    await api.call('setProperties', [made.id, { name: 'Renamed', opacity: 0.5 }]);
    expect(store.getState().undoStack.length).toBe(before + 2);
    store.getState().undo();
    expect(getLayer(store.getState().doc, made.id)?.name).toBe('Made');
    store.getState().undo();
    expect(getLayer(store.getState().doc, made.id)).toBeUndefined();
  });

  it('makes a batch one undo step, reading its own changes while it runs', async () => {
    const { store, api } = apiFor(ALL);
    const ids = [add(store, 'RECTANGLE'), add(store, 'RECTANGLE'), add(store, 'ELLIPSE')];
    const before = store.getState().undoStack.length;
    await api.call('batch.begin', []);
    for (const [i, id] of ids.entries()) await api.call('setProperties', [id, { name: `Item ${i + 1}`, x: i * 50 }]);
    const text = (await api.call('createText', [{ characters: 'Hello', name: 'Greeting' }])) as { id: string };
    // Inside the batch the plugin sees what it did; the editor does not yet.
    expect(((await api.call('getNode', [ids[2]])) as { name: string }).name).toBe('Item 3');
    expect(getLayer(store.getState().doc, ids[2]!)?.name).not.toBe('Item 3');
    await api.call('batch.end', []);
    expect(store.getState().undoStack.length).toBe(before + 1);
    expect(store.getState().undoStack.at(-1)?.label).toBe('Test plugin');
    expect(ids.map((id) => getLayer(store.getState().doc, id)?.name)).toEqual(['Item 1', 'Item 2', 'Item 3']);
    const greeting = getLayer(store.getState().doc, text.id) as TextNode;
    expect(greeting.characters).toBe('Hello');
    // Laid out by the editor: the text is as wide as what it says.
    expect(greeting.width).toBeGreaterThan(1);
    store.getState().undo();
    expect(ids.map((id) => getLayer(store.getState().doc, id)?.name)).toEqual(['Rectangle 1', 'Rectangle 2', 'Ellipse 1']);
    expect(getLayer(store.getState().doc, text.id)).toBeUndefined();
    await expect(api.call('batch.end', [])).resolves.toBeNull();
  });

  it('keeps what someone else changed while a batch ran', async () => {
    const { store, api } = apiFor(ALL);
    const a = add(store, 'RECTANGLE');
    const b = add(store, 'RECTANGLE');
    await api.call('batch.begin', []);
    await api.call('setProperties', [a, { name: 'From plugin' }]);
    // Someone else's change, arriving in the middle.
    store.getState().applyRemote({ ...store.getState().doc, nodes: { ...store.getState().doc.nodes, [b]: { ...getLayer(store.getState().doc, b)!, name: 'From someone else' } } });
    await api.call('batch.end', []);
    expect(getLayer(store.getState().doc, a)?.name).toBe('From plugin');
    expect(getLayer(store.getState().doc, b)?.name).toBe('From someone else');
  });

  it('refuses every change on a file that may only be viewed, and still reads it', async () => {
    const { store, api } = apiFor(ALL);
    const id = add(store, 'RECTANGLE', { name: 'Fixed' });
    store.getState().setReadOnly(true);
    await expect(api.call('setProperties', [id, { name: 'Changed' }])).rejects.toThrow('This file can only be viewed here, so plugins cannot change it.');
    await expect(api.call('createFrame', [{}])).rejects.toThrow('can only be viewed');
    await expect(api.call('remove', [[id]])).rejects.toThrow('can only be viewed');
    await expect(api.call('createVariableCollection', ['Tokens'])).rejects.toThrow('can only be viewed');
    await api.call('batch.begin', []);
    await expect(api.call('setProperties', [id, { name: 'Changed' }])).rejects.toThrow('can only be viewed');
    await api.call('batch.end', []);
    expect(getLayer(store.getState().doc, id)?.name).toBe('Fixed');
    expect(((await api.call('getNode', [id])) as { name: string }).name).toBe('Fixed');
  });

  it('checks the properties a plugin sets', async () => {
    const { store, api } = apiFor(ALL);
    const id = add(store, 'RECTANGLE');
    await expect(api.call('setProperties', [id, { id: 'other' }])).rejects.toThrow('"id" cannot be set by a plugin');
    await expect(api.call('setProperties', [id, { width: 'wide' }])).rejects.toThrow('"width" must be a number');
    await expect(api.call('setProperties', [id, { fills: 'red' }])).rejects.toThrow('"fills" must be a list');
    await expect(api.call('setProperties', [id, { blendMode: 'SPARKLE' }])).rejects.toThrow('"SPARKLE" is not a value "blendMode" can have');
    await expect(api.call('setProperties', ['nope', { name: 'x' }])).rejects.toThrow('There is no layer with the ID "nope"');
    await expect(api.call('setProperties', [pageOf(store), { name: 'x' }])).rejects.toThrow('is a page, not a layer');
    // Out of range values are brought into range, as when a file is opened.
    await api.call('setProperties', [id, { opacity: 7, width: -5 }]);
    expect(getLayer(store.getState().doc, id)).toMatchObject({ opacity: 1 });
    expect(getLayer(store.getState().doc, id)!.width).toBeGreaterThanOrEqual(0);
  });

  it('finds layers, groups and deletes them, and puts new layers in a parent', async () => {
    const { store, api } = apiFor(ALL);
    const frame = (await api.call('createFrame', [{ name: 'Screen', width: 300, height: 200 }])) as { id: string };
    const one = (await api.call('createRectangle', [{ parentId: frame.id, name: 'Button' }])) as { id: string };
    const two = (await api.call('createEllipse', [{ parentId: frame.id, name: 'Button dot' }])) as { id: string };
    await expect(api.call('createRectangle', [{ parentId: one.id }])).rejects.toThrow('is not a page, frame or group');
    expect(((await api.call('findAll', [{ nameContains: 'button' }])) as { id: string }[]).map((n) => n.id)).toEqual([one.id, two.id]);
    expect(((await api.call('findAll', [{ type: 'ELLIPSE' }])) as { id: string }[]).map((n) => n.id)).toEqual([two.id]);
    expect(((await api.call('findOne', [{ name: 'Screen' }])) as { id: string }).id).toBe(frame.id);
    expect(await api.call('findOne', [{ name: 'Nothing' }])).toBeNull();
    expect(((await api.call('getChildren', [frame.id])) as { id: string }[]).map((n) => n.id)).toEqual([one.id, two.id]);
    const group = (await api.call('group', [[one.id, two.id], { name: 'Pair' }])) as { id: string; type: string; name: string; children: string[] };
    expect(group).toMatchObject({ type: 'GROUP', name: 'Pair', children: [one.id, two.id] });
    await api.call('remove', [[group.id]]);
    expect(getLayer(store.getState().doc, one.id)).toBeUndefined();
    expect(((await api.call('getDocument', [])) as { pages: unknown[] }).pages).toHaveLength(1);
  });

  it('sets the selection and the page, which are not changes to the file', async () => {
    const { store, api } = apiFor(['read']);
    const a = add(store, 'RECTANGLE');
    const steps = store.getState().undoStack.length;
    expect(await api.call('setSelection', [[a]])).toEqual([a]);
    expect(store.getState().selection).toEqual([a]);
    await expect(api.call('setSelection', [['missing']])).rejects.toThrow('There is no layer');
    await expect(api.call('setCurrentPage', [a])).rejects.toThrow('is not a page');
    expect(store.getState().undoStack.length).toBe(steps);
  });

  it('works with components, styles and variables', async () => {
    const { store, api } = apiFor(ALL);
    const card = add(store, 'RECTANGLE', { name: 'Card' });
    let componentId = '';
    store.getState().apply('Component', (doc) => {
      const made = createComponent(doc, [card])!;
      componentId = made.id;
      return made.doc;
    });
    const components = (await api.call('getComponents', [])) as { id: string; component: { kind: string } }[];
    expect(components.map((c) => c.id)).toEqual([componentId]);
    expect(components[0]?.component.kind).toBe('COMPONENT');
    const instance = (await api.call('createInstance', [componentId, { x: 400, y: 0 }])) as { id: string; component: { kind: string; componentId: string } };
    expect(instance.component).toMatchObject({ kind: 'INSTANCE', componentId });
    expect((getLayer(store.getState().doc, instance.id) as FrameNode).x).toBe(400);
    await expect(api.call('createInstance', [card, {}])).rejects.toThrow('is not a component');

    const style = (await api.call('createStyle', [{ type: 'PAINT', name: 'Brand/Blue', paints: [{ type: 'SOLID', color: { r: 0, g: 0.5, b: 1 }, opacity: 1, visible: true }] }])) as { id: string; name: string; paints: unknown[] };
    expect(style).toMatchObject({ name: 'Brand/Blue', type: 'PAINT', paints: [expect.objectContaining({ type: 'SOLID' })] });
    await api.call('updateStyle', [style.id, { name: 'Brand/Primary' }]);
    expect(((await api.call('getStyles', ['PAINT'])) as { name: string }[]).map((s) => s.name)).toEqual(['Brand/Primary']);
    await expect(api.call('getStyles', ['SOUND'])).rejects.toThrow('A style type is one of');

    const collection = (await api.call('createVariableCollection', ['Tokens'])) as { id: string; modes: { id: string }[] };
    const variable = (await api.call('createVariable', [{ collectionId: collection.id, type: 'FLOAT', name: 'Spacing/M', value: 16 }])) as { id: string; valuesByMode: Record<string, unknown> };
    expect(Object.values(variable.valuesByMode)).toEqual([16]);
    await api.call('setVariableValue', [variable.id, collection.modes[0]!.id, 24]);
    expect(((await api.call('getVariables', [collection.id])) as { valuesByMode: Record<string, unknown> }[])[0]?.valuesByMode[collection.modes[0]!.id]).toBe(24);
    await expect(api.call('setVariableValue', [variable.id, collection.modes[0]!.id, 'big'])).rejects.toThrow('does not fit the FLOAT variable');
    await expect(api.call('createVariable', [{ collectionId: 'none', type: 'FLOAT' }])).rejects.toThrow('There is no collection');
  });

  it('exports through the editor\'s exporter, and keeps a plugin\'s own data', async () => {
    const exporter = vi.fn(async () => new Uint8Array([1, 2, 3]));
    const storage = memoryStorage();
    const { store, api } = apiFor(ALL, { exporter, storage });
    const id = add(store, 'RECTANGLE');
    expect(await api.call('exportAsync', [id, { format: 'svg', scale: 2 }])).toEqual(new Uint8Array([1, 2, 3]));
    expect(exporter).toHaveBeenCalledWith(store.getState().doc, id, 'SVG', 2);
    await expect(api.call('exportAsync', [id, { format: 'GIF' }])).rejects.toThrow('The export format is one of');

    await api.call('clientStorage.setAsync', ['count', { n: 1 }]);
    expect(await api.call('clientStorage.getAsync', ['count'])).toEqual({ n: 1 });
    expect(await api.call('clientStorage.keysAsync', [])).toEqual(['count']);
    await expect(api.call('clientStorage.setAsync', ['f', () => 1])).rejects.toThrow('Only plain data');
    await api.call('clientStorage.deleteAsync', ['count']);
    expect(await api.call('clientStorage.getAsync', ['count'])).toBeNull();
  });

  it('opens, resizes and closes its window, and closes itself', async () => {
    const showUI = vi.fn();
    const resizeUI = vi.fn();
    const close = vi.fn();
    const { api } = apiFor(ALL, { showUI, resizeUI, close });
    await api.call('showUI', [{ width: 5000, height: 10, title: '  Rename  ' }]);
    expect(showUI).toHaveBeenCalledWith({ width: 1200, height: 80, title: 'Rename', visible: true });
    await api.call('ui.resize', [320, 200]);
    expect(resizeUI).toHaveBeenCalledWith(320, 200);
    await api.call('closePlugin', ['Done']);
    expect(close).toHaveBeenCalledWith('Done');
  });
});
