import {
  CURRENT_SCHEMA_VERSION,
  FILE_FORMAT,
  type Document,
  type FileMeta,
  type OpenDesignFile,
} from './schema';
import { repairDocument } from './validate';

/** Thrown when data cannot be opened as an OPEN DESIGN file. The message is safe to show to the user. */
export class FileFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FileFormatError';
  }
}

type Raw = Record<string, unknown>;

function isObject(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Migrations from one schema version to the next, keyed by the version they
 * read. Each takes a whole file of version N and returns version N + 1. They
 * must be pure, and each needs a unit test with a stored fixture.
 */
export const MIGRATIONS: Readonly<Record<number, (file: Raw) => Raw>> = {
  // Version 2 adds the GROUP layer type. A version 1 file contains no groups,
  // so its content is already valid version 2 content.
  1: (file) => ({ ...file, schemaVersion: 2 }),
};

/**
 * Brings raw file data up to the current schema version. Files written by a
 * newer build are refused rather than opened lossily, because saving them
 * again would destroy whatever this build does not understand.
 */
export function migrateFile(raw: unknown): Raw {
  if (!isObject(raw) || raw.format !== FILE_FORMAT) {
    throw new FileFormatError('This is not an OPEN DESIGN file.');
  }
  const version = raw.schemaVersion;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new FileFormatError('This file does not say which version of the format it uses, so it cannot be opened.');
  }
  if (version > CURRENT_SCHEMA_VERSION) {
    throw new FileFormatError(
      `This file was saved by a newer version of OPEN DESIGN (format ${version}). Update the application to open it.`,
    );
  }
  let file = raw;
  for (let v = version; v < CURRENT_SCHEMA_VERSION; v++) {
    const migrate = MIGRATIONS[v];
    if (!migrate) throw new FileFormatError(`No migration is available from format ${v}.`);
    file = migrate(file);
  }
  return file;
}

function isoDate(value: unknown, fallback: string): string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : fallback;
}

export interface ParsedFile {
  file: OpenDesignFile;
  /** What had to be repaired while loading. Empty for a healthy file. */
  repairs: string[];
}

/** Migrates, validates and repairs raw file data. Throws `FileFormatError` if it cannot be opened. */
export function parseFile(raw: unknown): ParsedFile {
  const migrated = migrateFile(raw);
  const { doc, repairs } = repairDocument(migrated.document);
  const now = new Date().toISOString();
  const meta = isObject(migrated.meta) ? migrated.meta : {};
  return {
    file: {
      format: FILE_FORMAT,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      meta: { createdAt: isoDate(meta.createdAt, now), updatedAt: isoDate(meta.updatedAt, now) },
      document: doc,
    },
    repairs,
  };
}

/** Parses the text of a `.opendesign` file. */
export function parseFileText(text: string): ParsedFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new FileFormatError('This file is damaged or is not an OPEN DESIGN file (it is not valid JSON).');
  }
  return parseFile(raw);
}

export function toFile(doc: Document, meta: FileMeta): OpenDesignFile {
  return { format: FILE_FORMAT, schemaVersion: CURRENT_SCHEMA_VERSION, meta: { ...meta }, document: doc };
}

export function serializeFile(file: OpenDesignFile): string {
  return JSON.stringify(file);
}
