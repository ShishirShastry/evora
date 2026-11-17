import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { PluginRegistry } from './storage';
import { testBundle } from './testing';

let n = 0;
const registry = () => new PluginRegistry(new IDBFactory(), `evora-plugins-test-${n++}`, IDBKeyRange);

describe('installed plugins', () => {
  it('are kept, listed by name, turned off and on, and updated in place', async () => {
    const plugins = registry();
    expect(await plugins.list()).toEqual([]);
    const b = testBundle({ id: 'com.example.b', name: 'Beta' }, 'evora.closePlugin();');
    const a = testBundle({ id: 'com.example.a', name: 'Alpha', permissions: ['storage'] }, 'evora.closePlugin();');
    await plugins.install(b, 'file', '2026-11-17T10:00:00.000Z');
    await plugins.install(a, 'directory', '2026-11-17T11:00:00.000Z');
    const listed = await plugins.list();
    expect(listed.map((p) => [p.id, p.source, p.enabled])).toEqual([
      ['com.example.a', 'directory', true],
      ['com.example.b', 'file', true],
    ]);
    expect(listed[1]?.bundle).toEqual(b);

    await plugins.setEnabled('com.example.b', false);
    const newer = testBundle({ id: 'com.example.b', name: 'Beta', version: '2.0.0' }, 'evora.notify("2");');
    const updated = await plugins.install(newer, 'development', '2026-11-18T10:00:00.000Z');
    // A new version keeps whether it was on, and when it was first installed.
    expect(updated).toMatchObject({ enabled: false, installedAt: '2026-11-17T10:00:00.000Z', updatedAt: '2026-11-18T10:00:00.000Z', source: 'development' });
    expect((await plugins.get('com.example.b'))?.bundle.manifest.version).toBe('2.0.0');
    // The same database, opened again (another file, another tab).
    const again = new PluginRegistry((plugins as unknown as { factory: IDBFactory }).factory, (plugins as unknown as { name: string }).name, IDBKeyRange);
    expect((await again.list()).map((p) => p.id)).toEqual(['com.example.a', 'com.example.b']);
  });

  it('keep their own data apart, which uninstalling removes', async () => {
    const plugins = registry();
    await plugins.install(testBundle({ id: 'com.example.a', name: 'A' }, 'x'), 'file');
    await plugins.install(testBundle({ id: 'com.example.ab', name: 'AB' }, 'x'), 'file');
    const a = plugins.storageFor('com.example.a');
    const ab = plugins.storageFor('com.example.ab');
    await a.set('count', 3);
    await a.set('names', ['x', 'y']);
    await ab.set('count', 9);
    expect(await a.get('count')).toBe(3);
    expect((await a.keys()).sort()).toEqual(['count', 'names']);
    expect(await ab.keys()).toEqual(['count']);
    expect(await a.entries()).toEqual([
      ['count', 3],
      ['names', ['x', 'y']],
    ]);
    await a.delete('names');
    expect(await a.get('names')).toBeUndefined();
    await ab.clear();
    expect(await ab.keys()).toEqual([]);
    expect(await a.get('count')).toBe(3);
    await plugins.uninstall('com.example.a');
    expect(await a.keys()).toEqual([]);
    expect((await plugins.list()).map((p) => p.id)).toEqual(['com.example.ab']);
  });
});
