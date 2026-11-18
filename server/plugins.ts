/**
 * Phase 9: the directory of plugins and widgets. Built on the API through its extension hook (`ApiExtension` in api.ts):
 * `setup` makes this part's tables (CREATE TABLE IF NOT EXISTS, so it is safe on every start
 * and on a database made before it), `extension` gives its routes.
 *
 * Anyone with an account can publish a plugin or widget (free, without
 * limits); a plugin's ID belongs to whoever published it first, and only they
 * publish its new versions. Browsing, searching and downloading are open to
 * anyone, without an account. Every bundle is checked with the same rules the
 * app installs with (`src/plugins/manifest.ts`).
 *
 * Routes (JSON under /api):
 * - GET    /api/plugins/directory?q=&kind=                 -> DirectoryEntry[]  (anyone)
 * - POST   /api/plugins/directory   {bundle, description?, notes?} -> DirectoryEntry (201 new, 200 new version)  (an account; new versions by the publisher)
 * - GET    /api/plugins/directory/:id                      -> DirectoryEntry & {versions, permissions, commands, widgets}  (anyone)
 * - GET    /api/plugins/directory/:id/versions/:version    -> {bundle}  (anyone)
 * - POST   /api/plugins/directory/:id/install  {version?}  -> {bundle, installs}  (anyone; counted once per person or address)
 *
 * Installs are counted once per account (or guest) and, for someone with
 * neither, once per client address, which is kept only as a keyed hash
 * (`kit.countedAs`). The address is the connection's own, or, when the server
 * is set to trust its reverse proxy (EVORA_TRUST_PROXY, server/proxy.ts), the
 * one the proxy forwarded; without that setting every caller behind a proxy has
 * the proxy's address and they are counted once together. Someone with many
 * accounts or addresses can still be counted more than once. The route is
 * limited per address (Limits.counted, 429 beyond it).
 * - DELETE /api/plugins/directory/:id                      -> {}  (the publisher)
 */
import type { ApiExtension } from './api.ts';
import { now, type Store } from './store.ts';
import { PluginFormatError, compareVersions, parseBundle, type PluginBundle } from '../src/plugins/manifest.ts';

/** A plugin or widget in the directory, as listed. */
export interface DirectoryEntry {
  id: string;
  name: string;
  description: string;
  version: string;
  kind: 'plugin' | 'widget';
  author: { id: string; name: string };
  installs: number;
  updatedAt: string;
}

interface EntryRow {
  id: string;
  publisher_id: string;
  publisher_name: string;
  name: string;
  description: string;
  kind: 'plugin' | 'widget';
  latest_version: string;
  installs: number;
  created_at: string;
  updated_at: string;
}

const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;

export function setup(store: Store): void {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS plugin_directory (
      id TEXT PRIMARY KEY,
      publisher_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      kind TEXT NOT NULL,
      latest_version TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS plugin_versions (
      plugin_id TEXT NOT NULL REFERENCES plugin_directory(id) ON DELETE CASCADE,
      version TEXT NOT NULL,
      bundle TEXT NOT NULL,
      notes TEXT NOT NULL,
      published_at TEXT NOT NULL,
      PRIMARY KEY (plugin_id, version)
    );
    CREATE TABLE IF NOT EXISTS plugin_installs (
      plugin_id TEXT NOT NULL REFERENCES plugin_directory(id) ON DELETE CASCADE,
      who TEXT NOT NULL,
      installed_at TEXT NOT NULL,
      PRIMARY KEY (plugin_id, who)
    );
  `);
  hashOldAddresses(store);
}

/**
 * Installs counted before addresses were hashed kept the address itself
 * (`address:<ip>`): each becomes `address:<keyed hash>` (an address already
 * counted under its hash is not counted twice), so no address is kept.
 */
function hashOldAddresses(store: Store): void {
  const old = store.all<{ plugin_id: string; who: string; installed_at: string }>(`SELECT plugin_id, who, installed_at FROM plugin_installs WHERE who LIKE 'address:%'`);
  const hashed = /^address:[0-9a-f]{64}$/;
  store.tx(() => {
    for (const row of old) {
      if (hashed.test(row.who)) continue;
      const address = row.who.slice('address:'.length);
      store.run(`INSERT OR IGNORE INTO plugin_installs (plugin_id, who, installed_at) VALUES (?, ?, ?)`, row.plugin_id, `address:${store.hashAddress(address)}`, row.installed_at);
      store.run(`DELETE FROM plugin_installs WHERE plugin_id = ? AND who = ?`, row.plugin_id, row.who);
    }
  });
}

const SELECT = `
  SELECT d.*, u.name AS publisher_name, (SELECT COUNT(*) FROM plugin_installs i WHERE i.plugin_id = d.id) AS installs
  FROM plugin_directory d JOIN users u ON u.id = d.publisher_id`;

function dto(row: EntryRow): DirectoryEntry {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    version: row.latest_version,
    kind: row.kind,
    author: { id: row.publisher_id, name: row.publisher_name },
    installs: Number(row.installs),
    updatedAt: row.updated_at,
  };
}

export const extension: ApiExtension = (kit) => {
  const { store, route, HttpError, Reply } = kit;

  const entry = (id: string): EntryRow => {
    const row = store.one<EntryRow>(`${SELECT} WHERE d.id = ?`, id);
    if (!row) throw new HttpError(404, 'There is no such plugin in the directory');
    return row;
  };

  const bundleOf = (pluginId: string, version: string): PluginBundle => {
    const row = store.one<{ bundle: string }>(`SELECT bundle FROM plugin_versions WHERE plugin_id = ? AND version = ?`, pluginId, version);
    if (!row) throw new HttpError(404, `There is no version ${version} of this plugin`);
    return JSON.parse(row.bundle) as PluginBundle;
  };

  return [
    route('GET', '/api/plugins/directory', (ctx) => {
      const url = new URL(ctx.req.url ?? '/', 'http://localhost');
      const q = (url.searchParams.get('q') ?? '').trim().toLowerCase().slice(0, 100);
      const kind = url.searchParams.get('kind') ?? '';
      if (kind && kind !== 'plugin' && kind !== 'widget') throw new HttpError(400, 'kind must be plugin or widget');
      const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      const rows = store.all<EntryRow>(
        `${SELECT}
         WHERE (? = '' OR d.kind = ?)
           AND (? = '' OR lower(d.name) LIKE ? ESCAPE '\\' OR lower(d.description) LIKE ? ESCAPE '\\' OR lower(d.id) LIKE ? ESCAPE '\\' OR lower(u.name) LIKE ? ESCAPE '\\')
         ORDER BY installs DESC, d.updated_at DESC, d.name ASC
         LIMIT 200`,
        kind,
        kind,
        q,
        like,
        like,
        like,
        like,
      );
      return rows.map(dto);
    }),

    route('POST', '/api/plugins/directory', async (ctx) => {
      const user = kit.requireUser(ctx);
      const body = await ctx.json(MAX_BUNDLE_BYTES);
      let bundle: PluginBundle;
      try {
        bundle = parseBundle(body.bundle);
      } catch (error) {
        if (error instanceof PluginFormatError) throw new HttpError(400, error.message);
        throw error;
      }
      const description = kit.optionalText(body, 'description', 1000) ?? bundle.manifest.description;
      const notes = kit.optionalText(body, 'notes', 2000) ?? '';
      const { id, name, version, kind } = bundle.manifest;
      const existing = store.one<EntryRow>(`SELECT * FROM plugin_directory WHERE id = ?`, id);
      const at = now();
      if (existing) {
        if (existing.publisher_id !== user.id) throw new HttpError(403, `The plugin ID "${id}" was published by someone else: give your plugin an ID of its own`);
        if (existing.kind !== kind) throw new HttpError(409, `"${id}" is published as a ${existing.kind}; a new version cannot be a ${kind}`);
        if (compareVersions(version, existing.latest_version) <= 0) {
          throw new HttpError(409, `Version ${existing.latest_version} is already published: a new version must be higher`);
        }
      }
      store.tx(() => {
        if (existing) {
          store.run(`UPDATE plugin_directory SET name = ?, description = ?, latest_version = ?, updated_at = ? WHERE id = ?`, name, description, version, at, id);
        } else {
          store.run(
            `INSERT INTO plugin_directory (id, publisher_id, name, description, kind, latest_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            id,
            user.id,
            name,
            description,
            kind,
            version,
            at,
            at,
          );
        }
        store.run(`INSERT INTO plugin_versions (plugin_id, version, bundle, notes, published_at) VALUES (?, ?, ?, ?, ?)`, id, version, JSON.stringify(bundle), notes, at);
      });
      const published = dto(entry(id));
      return existing ? published : new Reply(201, published);
    }),

    route('GET', '/api/plugins/directory/:id', (_ctx, params) => {
      const row = entry(params.id as string);
      const latest = bundleOf(row.id, row.latest_version);
      const versions = store
        .all<{ version: string; notes: string; published_at: string }>(`SELECT version, notes, published_at FROM plugin_versions WHERE plugin_id = ?`, row.id)
        .sort((a, b) => compareVersions(b.version, a.version))
        .map((v) => ({ version: v.version, notes: v.notes, publishedAt: v.published_at }));
      return {
        ...dto(row),
        permissions: latest.manifest.permissions,
        commands: latest.manifest.commands,
        widgets: latest.manifest.widgets,
        versions,
      };
    }),

    route('GET', '/api/plugins/directory/:id/versions/:version', (_ctx, params) => {
      const row = entry(params.id as string);
      return { bundle: bundleOf(row.id, params.version as string) };
    }),

    route('POST', '/api/plugins/directory/:id/install', async (ctx, params) => {
      const row = entry(params.id as string);
      const body = await ctx.json();
      const version = body.version === undefined ? row.latest_version : kit.text(body, 'version', 20);
      const bundle = bundleOf(row.id, version);
      // Counted once for each person (an account or a guest) or, for someone with neither, each address (kept as a keyed hash), however often they install it.
      const who = kit.countedAs(ctx);
      store.run(`INSERT OR IGNORE INTO plugin_installs (plugin_id, who, installed_at) VALUES (?, ?, ?)`, row.id, who, now());
      return { bundle, installs: dto(entry(row.id)).installs };
    }),

    route('DELETE', '/api/plugins/directory/:id', (ctx, params) => {
      const user = kit.requireUser(ctx);
      const row = entry(params.id as string);
      if (row.publisher_id !== user.id) throw new HttpError(403, 'Only whoever published a plugin can remove it from the directory');
      store.run(`DELETE FROM plugin_directory WHERE id = ?`, row.id);
      return {};
    }),
  ];
};
