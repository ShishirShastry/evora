import { describe, expect, it } from 'vitest';
import { EXAMPLE_FILES } from './testing';
import { compareVersions, makeBundle, parseBundle, PluginFormatError, serializeBundle, validateManifest, PLUGIN_API_VERSION } from './manifest';

const good = {
  id: 'com.example.rename',
  name: 'Rename',
  version: '1.2.3',
  description: 'Renames',
  author: 'Ada',
  kind: 'plugin',
  api: 1,
  permissions: ['write', 'read', 'read'],
};


describe('plugin manifests', () => {
  it('are tidied: permissions in order and once, a command when none is given', () => {
    expect(validateManifest(good)).toEqual({
      ...good,
      permissions: ['read', 'write'],
      commands: [{ id: 'run', name: 'Rename' }],
      widgets: [],
      main: 'main.js',
      ui: null,
    });
  });

  it('are refused with a message that says what is wrong', () => {
    const wrong = (change: Record<string, unknown>) => () => validateManifest({ ...good, ...change });
    expect(() => validateManifest('x')).toThrow('must be a JSON object');
    expect(wrong({ id: 'Rename' })).toThrow('must be lowercase letters and digits in parts');
    expect(wrong({ id: 'single' })).toThrow(PluginFormatError);
    expect(wrong({ version: '1.0' })).toThrow('major.minor.patch');
    expect(wrong({ name: '' })).toThrow('"name" is empty');
    expect(wrong({ author: 7 })).toThrow('"author" must be text');
    expect(wrong({ kind: 'theme' })).toThrow('"kind" must be "plugin" or "widget"');
    expect(wrong({ api: PLUGIN_API_VERSION + 1 })).toThrow(`needs version ${PLUGIN_API_VERSION + 1} of the plugin API`);
    expect(wrong({ permissions: ['network'] })).toThrow('"network" is not a permission. The permissions are: read, write, export, ui, storage.');
    expect(wrong({ permissions: 'read' })).toThrow('must be a list');
    expect(wrong({ ui: 'ui.html' })).toThrow('must ask for the "ui" permission');
    expect(wrong({ kind: 'widget' })).toThrow('at least one widget');
    expect(wrong({ commands: [{ id: 'a', name: 'A' }, { id: 'a', name: 'B' }] })).toThrow('two commands with the ID "a"');
    expect(wrong({ commands: [{ id: 'a b', name: 'A' }] })).toThrow('needs an "id"');
    expect(wrong({ main: '../secret.js' })).toThrow('"main" must be a file name');
  });

  it('compare versions by number', () => {
    expect(compareVersions('1.10.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareVersions('2.0.0', '2.0.0')).toBe(0);
    expect(compareVersions('0.0.1', '0.1.0')).toBeLessThan(0);
  });
});

describe('plugin bundles', () => {
  it('round-trip through their file, and refuse what is not one', () => {
    const bundle = makeBundle({ ...good, permissions: ['ui'], ui: 'ui.html' }, 'evora.showUI();', '<p>Hi</p>');
    expect(parseBundle(serializeBundle(bundle))).toEqual(bundle);
    expect(() => parseBundle('not json')).toThrow('the file is not JSON');
    expect(() => parseBundle({ format: 'zip' })).toThrow('This is not an Evora plugin');
    expect(() => parseBundle({ ...bundle, formatVersion: 99 })).toThrow('bundled for a newer version of Evora');
    expect(() => parseBundle({ ...bundle, code: '  ' })).toThrow('has no code');
    expect(() => parseBundle({ ...bundle, ui: null })).toThrow('names a window ("ui.html") but the plugin has no HTML');
    expect(() => makeBundle(good, 'x', '<p>window</p>')).toThrow('has HTML for a window, but its manifest has no "ui"');
    expect(() => makeBundle(good, 'x'.repeat(2_000_001), null)).toThrow('larger than 2 MB');
  });
});

describe('the example plugins', () => {
  const root = '../../plugins/examples/';
  const read = (path: string): string => {
    const text = EXAMPLE_FILES[root + path];
    if (text === undefined) throw new Error(`${path} is missing`);
    return text;
  };
  // Each example is a folder with its manifest.
  const names = Object.keys(EXAMPLE_FILES)
    .filter((path) => path.endsWith('/manifest.json'))
    .map((path) => path.slice(root.length, -'/manifest.json'.length))
    .sort();

  it('are three plugins and a widget, each installable', () => {
    const bundles = names.map((name) => parseBundle(read(`${name}.evora-plugin`)));
    expect(bundles.map((b) => [b.manifest.name, b.manifest.kind])).toEqual([
      ['Lorem ipsum', 'plugin'],
      ['Rename layers', 'plugin'],
      ['Tidy up', 'plugin'],
      ['Vote counter', 'widget'],
    ]);
    expect(bundles.find((b) => b.manifest.name === 'Rename layers')?.ui).toContain('<form');
    expect(bundles.find((b) => b.manifest.name === 'Tidy up')?.ui).toBeNull();
  });

  it('are bundled from their sources as they are now (node plugins/build-examples.mjs)', () => {
    for (const name of names) {
      const manifest = JSON.parse(read(`${name}/manifest.json`)) as { main?: string; ui?: string };
      const code = read(`${name}/${manifest.main ?? 'main.js'}`);
      const ui = manifest.ui ? read(`${name}/${manifest.ui}`) : null;
      expect(read(`${name}.evora-plugin`), name).toBe(serializeBundle(makeBundle(manifest, code, ui)));
    }
  });
});
