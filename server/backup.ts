/**
 * Backing up and restoring an Evora server's data folder, while the server
 * runs:
 *
 *   node server/backup.ts --data .evora-server --out backups/evora-2026-11-18
 *   node server/backup.ts --restore backups/evora-2026-11-18 --data /var/lib/evora
 *   node server/backup.ts --verify backups/evora-2026-11-18
 *
 * (`npm run backup -- <the same flags>`; --data may also come from EVORA_DATA.)
 *
 * A backup is a folder:
 * - `evora.db`: a consistent copy of the database, made with SQLite's online
 *   backup (node:sqlite's `backup()`), or `VACUUM INTO` where that is missing.
 *   Either reads one snapshot of the database while the server goes on
 *   writing, so the copy is never half of one change;
 * - `files/`: the uploaded files, as they are in the data folder (images of
 *   documents in `assets/`, Community covers and assets in `community/`, and
 *   anything else kept next to the database);
 * - `manifest.json`: what it is, when it was made, by which version, and the
 *   size and SHA-256 of every file, checked before a restore.
 *
 * The database is copied first and the files after it, so every image the
 * copied database refers to was already written (images are written before the
 * change that refers to them). A file removed between the two steps is missing
 * from the backup; one added is there without a reference, which is harmless.
 *
 * A restore puts a backup into an empty (or new) data folder, after checking
 * every file against the manifest and the database with SQLite's integrity
 * check. Start the server on that folder afterwards: its tables are brought up
 * to date on start, as after any upgrade.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import * as sqlite from 'node:sqlite';
import { DatabaseSync } from 'node:sqlite';

export const DATABASE_FILE = 'evora.db';
export const MANIFEST_FILE = 'manifest.json';
export const BACKUP_FORMAT = 'evora-backup';
export const BACKUP_FORMAT_VERSION = 1;

export interface ManifestFile {
  /** The path inside the backup, with forward slashes: `evora.db` or `files/...`. */
  path: string;
  size: number;
  sha256: string;
}

export interface Manifest {
  format: typeof BACKUP_FORMAT;
  formatVersion: number;
  createdAt: string;
  /** The Evora version that made it. */
  evoraVersion: string;
  /** The database's own schema version (PRAGMA user_version). */
  databaseVersion: number;
  /** How the database was copied. */
  method: 'sqlite-backup' | 'vacuum-into';
  files: ManifestFile[];
}

export interface BackupResult {
  out: string;
  manifest: Manifest;
  bytes: number;
}

/** The database's own files, which are never copied as they are (the consistent copy stands for them). */
function isDatabaseFile(name: string): boolean {
  return name === DATABASE_FILE || name.startsWith(`${DATABASE_FILE}-`);
}

function evoraVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function isEmptyOrMissing(dir: string): boolean {
  if (!existsSync(dir)) return true;
  if (!statSync(dir).isDirectory()) return false;
  return readdirSync(dir).length === 0;
}

/** Every file under `dir`, as paths relative to it with forward slashes. */
function filesUnder(dir: string, base = dir): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...filesUnder(path, base));
    else if (entry.isFile()) found.push(relative(base, path).split(sep).join('/'));
  }
  return found.sort();
}

/** Copies the database at `source` to `target` from one snapshot, while others may be writing to it. */
async function copyDatabase(source: string, target: string): Promise<Manifest['method']> {
  const db = new DatabaseSync(source, { timeout: 10_000 });
  try {
    const online = (sqlite as { backup?: (db: DatabaseSync, path: string) => Promise<number> }).backup;
    if (typeof online === 'function') {
      await online(db, target);
      return 'sqlite-backup';
    }
    db.prepare('VACUUM INTO ?').run(target);
    return 'vacuum-into';
  } finally {
    db.close();
  }
}

/** Opens a database file on its own and checks it; returns its schema version. */
function checkDatabase(path: string): number {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const result = db.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[];
    const verdict = result.map((row) => row.integrity_check).join('; ');
    if (verdict !== 'ok') throw new Error(`The database copy is damaged: ${verdict}`);
    return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  } finally {
    db.close();
  }
}

/** Makes a backup of the data folder `dataDir` in `out`, a folder that does not exist yet or is empty. */
export async function backup(options: { dataDir: string; out: string }): Promise<BackupResult> {
  const dataDir = resolve(options.dataDir);
  const out = resolve(options.out);
  const database = join(dataDir, DATABASE_FILE);
  if (!existsSync(database)) throw new Error(`${dataDir} has no ${DATABASE_FILE}: it is not an Evora server's data folder`);
  if (!isEmptyOrMissing(out)) throw new Error(`${out} is not empty: a backup goes into a new or empty folder`);
  const inside = relative(dataDir, out);
  if (inside === '' || (!inside.startsWith('..') && !isAbsolute(inside))) throw new Error('The backup cannot go inside the data folder it copies');

  mkdirSync(out, { recursive: true });
  try {
    // The database first, from one snapshot.
    const method = await copyDatabase(database, join(out, DATABASE_FILE));
    const databaseVersion = checkDatabase(join(out, DATABASE_FILE));
    const files: ManifestFile[] = [];
    const db = join(out, DATABASE_FILE);
    files.push({ path: DATABASE_FILE, size: statSync(db).size, sha256: sha256(db) });

    // Then the uploaded files.
    for (const path of filesUnder(dataDir)) {
      const top = path.split('/')[0] as string;
      if (isDatabaseFile(top) || path.endsWith('.part')) continue;
      const from = join(dataDir, ...path.split('/'));
      const to = join(out, 'files', ...path.split('/'));
      mkdirSync(dirname(to), { recursive: true });
      try {
        copyFileSync(from, to);
      } catch (error) {
        // Removed while the backup was being made (a document deleted): left out.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      files.push({ path: `files/${path}`, size: statSync(to).size, sha256: sha256(to) });
    }

    const manifest: Manifest = {
      format: BACKUP_FORMAT,
      formatVersion: BACKUP_FORMAT_VERSION,
      createdAt: new Date().toISOString(),
      evoraVersion: evoraVersion(),
      databaseVersion,
      method,
      files,
    };
    writeFileSync(join(out, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
    return { out, manifest, bytes: files.reduce((sum, file) => sum + file.size, 0) };
  } catch (error) {
    rmSync(out, { recursive: true, force: true });
    throw error;
  }
}

/** Reads a backup's manifest and checks every file in it; throws with what is wrong. */
export function verifyBackup(from: string): Manifest {
  const dir = resolve(from);
  const path = join(dir, MANIFEST_FILE);
  if (!existsSync(path)) throw new Error(`${dir} has no ${MANIFEST_FILE}: it is not an Evora backup`);
  let manifest: Manifest;
  try {
    manifest = JSON.parse(readFileSync(path, 'utf8')) as Manifest;
  } catch {
    throw new Error(`${path} is not readable JSON`);
  }
  if (manifest.format !== BACKUP_FORMAT || !Array.isArray(manifest.files)) throw new Error(`${path} is not an Evora backup's manifest`);
  if (manifest.formatVersion > BACKUP_FORMAT_VERSION) throw new Error(`This backup was made by a newer Evora (format ${manifest.formatVersion}); restore it with that version or later`);
  if (!manifest.files.some((file) => file.path === DATABASE_FILE)) throw new Error('The backup has no database');
  // Every path first: one that leads outside the backup is refused before any file is looked at.
  for (const file of manifest.files) {
    const parts = typeof file.path === 'string' ? file.path.split('/') : [];
    const safe = parts.length > 0 && parts.every((part) => part !== '' && part !== '.' && part !== '..' && !part.includes('\\') && !part.includes(':'));
    if (!safe || (file.path !== DATABASE_FILE && (parts[0] !== 'files' || parts.length < 2))) throw new Error(`The manifest names a file outside the backup: ${String(file.path)}`);
  }
  for (const file of manifest.files) {
    const at = join(dir, ...file.path.split('/'));
    if (!existsSync(at)) throw new Error(`The backup is missing ${file.path}`);
    if (statSync(at).size !== file.size || sha256(at) !== file.sha256) throw new Error(`${file.path} is not what was backed up (its size or checksum differs)`);
  }
  checkDatabase(join(dir, DATABASE_FILE));
  return manifest;
}

/** Puts the backup in `from` into `dataDir`, which must not exist yet or be empty. */
export function restore(options: { from: string; dataDir: string }): Manifest {
  const from = resolve(options.from);
  const dataDir = resolve(options.dataDir);
  if (!isEmptyOrMissing(dataDir)) throw new Error(`${dataDir} is not empty: a backup is restored only into a new or empty data folder (move the old one aside first)`);
  const manifest = verifyBackup(from);
  mkdirSync(dataDir, { recursive: true });
  try {
    for (const file of manifest.files) {
      const parts = file.path.split('/');
      const to = file.path === DATABASE_FILE ? join(dataDir, DATABASE_FILE) : join(dataDir, ...parts.slice(1));
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(join(from, ...parts), to);
    }
    checkDatabase(join(dataDir, DATABASE_FILE));
  } catch (error) {
    // The folder was empty: take back what was put there.
    for (const entry of readdirSync(dataDir)) rmSync(join(dataDir, entry), { recursive: true, force: true });
    throw error;
  }
  return manifest;
}

function defaultOut(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  return resolve(`evora-backup-${stamp}`);
}

function human(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const USAGE = `Usage:
  node server/backup.ts --data <data folder> [--out <new folder>]   make a backup (works while the server runs)
  node server/backup.ts --restore <backup folder> --data <empty folder>   put a backup back
  node server/backup.ts --verify <backup folder>   check a backup
--data may also come from EVORA_DATA.`;

export async function main(args: string[], env: Record<string, string | undefined>): Promise<number> {
  let values: { data?: string; out?: string; restore?: string; verify?: string; help?: boolean };
  try {
    values = parseArgs({
      args,
      options: { data: { type: 'string' }, out: { type: 'string' }, restore: { type: 'string' }, verify: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
      strict: true,
    }).values;
  } catch (error) {
    console.error(`${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const dataDir = values.data ?? env.EVORA_DATA;
  try {
    if (values.verify) {
      const manifest = verifyBackup(values.verify);
      console.log(`${resolve(values.verify)}: a good backup of ${manifest.files.length} files, made ${manifest.createdAt} by Evora ${manifest.evoraVersion}`);
      return 0;
    }
    if (values.restore) {
      if (!dataDir) throw new Error('--restore needs --data <empty folder> (or EVORA_DATA)');
      const manifest = restore({ from: values.restore, dataDir });
      console.log(`Restored ${manifest.files.length} files (made ${manifest.createdAt}) into ${resolve(dataDir)}. Start the server on it.`);
      return 0;
    }
    if (!dataDir) throw new Error(`--data <data folder> (or EVORA_DATA) is needed\n\n${USAGE}`);
    const result = await backup({ dataDir, out: values.out ?? defaultOut() });
    console.log(`Backed up ${result.manifest.files.length} files (${human(result.bytes)}, database by ${result.manifest.method}) into ${result.out}`);
    return 0;
  } catch (error) {
    console.error(`Evora backup: ${(error as Error).message}`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2), process.env);
}
