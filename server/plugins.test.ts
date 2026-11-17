import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { call, signUp, tempDir, testServer, type TestServer } from './testing.ts';
import { makeBundle, type PluginBundle } from '../src/plugins/manifest.ts';
import type { DirectoryEntry } from './plugins.ts';

let server: TestServer;

beforeAll(async () => {
  server = await testServer();
});

afterAll(async () => {
  await server.stop();
});

let made = 0;

function bundle(overrides: Record<string, unknown> = {}, code = 'evora.closePlugin();'): PluginBundle {
  made++;
  return makeBundle(
    {
      id: `com.example.plugin-${made}`,
      name: `Plugin ${made}`,
      version: '1.0.0',
      description: 'Does a thing',
      author: 'Someone',
      kind: 'plugin',
      api: 1,
      permissions: ['read'],
      ...overrides,
    },
    code,
    null,
  );
}

describe('the plugin directory', () => {
  it('publishes a plugin for someone with an account, and refuses anyone without one', async () => {
    const maker = await signUp(server, 'Maker');
    const guest = await call(server, 'POST', '/api/guests', { body: { name: 'Guest' } });
    const plugin = bundle({ name: 'Rename layers', description: 'Renames layers in bulk' });

    expect((await call(server, 'POST', '/api/plugins/directory', { body: { bundle: plugin } })).status).toBe(401);
    expect((await call(server, 'POST', '/api/plugins/directory', { guest: guest.body.guestToken, body: { bundle: plugin } })).status).toBe(401);

    const published = await call<DirectoryEntry>(server, 'POST', '/api/plugins/directory', { token: maker.token, body: { bundle: plugin } });
    expect(published.status).toBe(201);
    expect(published.body).toMatchObject({
      id: plugin.manifest.id,
      name: 'Rename layers',
      description: 'Renames layers in bulk',
      version: '1.0.0',
      kind: 'plugin',
      author: { id: maker.user.id, name: maker.user.name },
      installs: 0,
    });
    expect(Number.isNaN(Date.parse(published.body.updatedAt))).toBe(false);
  });

  it('refuses a bundle that is not a valid plugin, saying why', async () => {
    const maker = await signUp(server, 'Careless');
    const good = bundle();
    const bad = await call(server, 'POST', '/api/plugins/directory', { token: maker.token, body: { bundle: { ...good, manifest: { ...good.manifest, permissions: ['everything'] } } } });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain('"everything" is not a permission');
    const missing = await call(server, 'POST', '/api/plugins/directory', { token: maker.token, body: {} });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toContain('not an Evora plugin');
  });

  it('takes new versions from the publisher only, each higher than the last', async () => {
    const owner = await signUp(server, 'Owner');
    const other = await signUp(server, 'Other');
    const first = bundle();
    const id = first.manifest.id;
    expect((await call(server, 'POST', '/api/plugins/directory', { token: owner.token, body: { bundle: first } })).status).toBe(201);

    const second = makeBundle({ ...first.manifest, version: '1.1.0', name: 'Better name' }, 'evora.notify("v1.1"); evora.closePlugin();', null);
    const taken = await call(server, 'POST', '/api/plugins/directory', { token: other.token, body: { bundle: second } });
    expect(taken.status).toBe(403);
    expect(taken.body.error).toContain('published by someone else');

    const update = await call<DirectoryEntry>(server, 'POST', '/api/plugins/directory', { token: owner.token, body: { bundle: second, notes: 'A better name' } });
    expect(update.status).toBe(200);
    expect(update.body).toMatchObject({ version: '1.1.0', name: 'Better name' });

    const same = await call(server, 'POST', '/api/plugins/directory', { token: owner.token, body: { bundle: second } });
    expect(same.status).toBe(409);
    const older = await call(server, 'POST', '/api/plugins/directory', { token: owner.token, body: { bundle: makeBundle({ ...first.manifest, version: '1.0.5' }, 'x', null) } });
    expect(older.status).toBe(409);
    const asWidget = await call(server, 'POST', '/api/plugins/directory', {
      token: owner.token,
      body: { bundle: makeBundle({ ...first.manifest, version: '2.0.0', kind: 'widget', widgets: [{ id: 'w', name: 'W' }] }, 'x', null) },
    });
    expect(asWidget.status).toBe(409);

    const details = await call(server, 'GET', `/api/plugins/directory/${id}`);
    expect(details.status).toBe(200);
    expect(details.body.versions.map((v: { version: string }) => v.version)).toEqual(['1.1.0', '1.0.0']);
    expect(details.body.versions[0].notes).toBe('A better name');
    expect(details.body.permissions).toEqual(['read']);
    expect(details.body.commands).toEqual([{ id: 'run', name: first.manifest.name }]);

    // Every version stays downloadable.
    const old = await call<{ bundle: PluginBundle }>(server, 'GET', `/api/plugins/directory/${id}/versions/1.0.0`);
    expect(old.body.bundle).toEqual(first);
    expect((await call(server, 'GET', `/api/plugins/directory/${id}/versions/9.9.9`)).status).toBe(404);
  });

  it('is browsed and searched by anyone, by words and by kind', async () => {
    const maker = await signUp(server, 'Lister');
    const unique = `zq${Date.now()}`;
    const plugin = bundle({ name: `Tidy ${unique}`, description: 'Aligns layers to a grid' });
    const widget = bundle({ name: `Votes ${unique}`, kind: 'widget', widgets: [{ id: 'vote', name: 'Vote' }], permissions: [], description: 'Sticky votes' });
    for (const b of [plugin, widget]) expect((await call(server, 'POST', '/api/plugins/directory', { token: maker.token, body: { bundle: b } })).status).toBe(201);

    const all = await call<DirectoryEntry[]>(server, 'GET', `/api/plugins/directory?q=${unique}`);
    expect(all.status).toBe(200);
    expect(all.body.map((e) => e.id).sort()).toEqual([plugin.manifest.id, widget.manifest.id].sort());
    const widgets = await call<DirectoryEntry[]>(server, 'GET', `/api/plugins/directory?q=${unique}&kind=widget`);
    expect(widgets.body.map((e) => e.id)).toEqual([widget.manifest.id]);
    expect(widgets.body[0]).toEqual({
      id: widget.manifest.id,
      name: `Votes ${unique}`,
      description: 'Sticky votes',
      version: '1.0.0',
      kind: 'widget',
      author: { id: maker.user.id, name: maker.user.name },
      installs: 0,
      updatedAt: expect.any(String),
    });
    // By its description, case aside; by the publisher's name.
    expect((await call<DirectoryEntry[]>(server, 'GET', `/api/plugins/directory?q=ALIGNS%20LAYERS%20TO`)).body.some((e) => e.id === plugin.manifest.id)).toBe(true);
    expect((await call<DirectoryEntry[]>(server, 'GET', `/api/plugins/directory?q=${encodeURIComponent(maker.user.name)}`)).body.length).toBeGreaterThanOrEqual(2);
    // "%" and "_" are matched as themselves.
    expect((await call<DirectoryEntry[]>(server, 'GET', `/api/plugins/directory?q=${unique}%25`)).body).toEqual([]);
    expect((await call(server, 'GET', '/api/plugins/directory?kind=theme')).status).toBe(400);
    // Without a search, everything is listed.
    expect((await call<DirectoryEntry[]>(server, 'GET', '/api/plugins/directory')).body.length).toBeGreaterThanOrEqual(2);
  });

  it('gives the bundle to install and counts each installer once', async () => {
    const maker = await signUp(server, 'Counted');
    const fan = await signUp(server, 'Fan');
    const plugin = bundle();
    const id = plugin.manifest.id;
    await call(server, 'POST', '/api/plugins/directory', { token: maker.token, body: { bundle: plugin } });

    const first = await call<{ bundle: PluginBundle; installs: number }>(server, 'POST', `/api/plugins/directory/${id}/install`, { token: fan.token });
    expect(first.status).toBe(200);
    expect(first.body.bundle).toEqual(plugin);
    expect(first.body.installs).toBe(1);
    expect((await call(server, 'POST', `/api/plugins/directory/${id}/install`, { token: fan.token })).body.installs).toBe(1);
    // Someone not signed in, counted by their address.
    expect((await call(server, 'POST', `/api/plugins/directory/${id}/install`)).body.installs).toBe(2);
    expect((await call(server, 'POST', `/api/plugins/directory/${id}/install`, { body: { version: '3.0.0' } })).status).toBe(404);
    expect((await call(server, 'POST', '/api/plugins/directory/com.example.nothing-here/install')).status).toBe(404);
    expect((await call<DirectoryEntry>(server, 'GET', `/api/plugins/directory/${id}`)).body.installs).toBe(2);
  });

  it('is removed from the directory by its publisher only', async () => {
    const maker = await signUp(server, 'Remover');
    const other = await signUp(server, 'NotTheMaker');
    const plugin = bundle();
    const id = plugin.manifest.id;
    await call(server, 'POST', '/api/plugins/directory', { token: maker.token, body: { bundle: plugin } });
    expect((await call(server, 'DELETE', `/api/plugins/directory/${id}`)).status).toBe(401);
    expect((await call(server, 'DELETE', `/api/plugins/directory/${id}`, { token: other.token })).status).toBe(403);
    expect((await call(server, 'DELETE', `/api/plugins/directory/${id}`, { token: maker.token })).status).toBe(200);
    expect((await call(server, 'GET', `/api/plugins/directory/${id}`)).status).toBe(404);
    expect((await call(server, 'GET', `/api/plugins/directory/${id}/versions/1.0.0`)).status).toBe(404);
  });

  it('publishes the example plugins and widget that come with Evora', async () => {
    const maker = await signUp(server, 'Examples');
    for (const name of ['rename-layers', 'tidy-up', 'lorem-ipsum', 'vote-counter']) {
      const text = readFileSync(join(import.meta.dirname, '..', 'plugins', 'examples', `${name}.evora-plugin`), 'utf8');
      const answer = await call(server, 'POST', '/api/plugins/directory', { token: maker.token, body: { bundle: JSON.parse(text) } });
      expect(answer.status).toBe(201);
    }
  });
});

describe('the directory tables', () => {
  it('are made on a database from before them, and keep what is in them across a restart', async () => {
    const dataDir = tempDir();
    // A database made before Phase 9: only the tables of Phase 8.
    const first = await testServer({ dataDir });
    const maker = await signUp(first, 'Restart');
    const plugin = bundle();
    await call(first, 'POST', '/api/plugins/directory', { token: maker.token, body: { bundle: plugin } });
    await first.close();
    const db = new DatabaseSync(join(dataDir, 'evora.db'));
    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'plugin_%'`).all() as { name: string }[]).map((t) => t.name).sort();
    db.close();
    expect(tables).toEqual(['plugin_directory', 'plugin_installs', 'plugin_versions']);
    const second = await testServer({ dataDir });
    const listed = await call<DirectoryEntry>(second, 'GET', `/api/plugins/directory/${plugin.manifest.id}`);
    expect(listed.body.version).toBe('1.0.0');
    await second.stop();
  });
});
