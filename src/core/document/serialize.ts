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
  // Version 3 adds the TEXT layer type. Older files contain no text layers.
  2: (file) => ({ ...file, schemaVersion: 3 }),
  // Version 4 gives every layer stroke cap, join and dash settings, an effect
  // list and a blend mode, and frames and rectangles per-corner radii. Older
  // layers get the values that paint exactly what they painted before.
  3: (file) => {
    const body = isObject(file.document) ? file.document : {};
    const nodes = isObject(body.nodes) ? body.nodes : {};
    const upgraded: Raw = {};
    for (const id in nodes) {
      const node = nodes[id];
      if (!isObject(node) || node.type === 'PAGE') {
        upgraded[id] = node;
        continue;
      }
      const next: Raw = { strokeCap: 'NONE', strokeJoin: 'MITER', dashPattern: [], effects: [], blendMode: 'NORMAL', ...node };
      if ((node.type === 'FRAME' || node.type === 'RECTANGLE') && !('cornerRadii' in node)) next.cornerRadii = null;
      upgraded[id] = next;
    }
    return { ...file, schemaVersion: 4, document: { ...body, nodes: upgraded } };
  },
  // Version 5 adds image paints and the document's table of image assets.
  // Older documents use no images, so their table is empty.
  4: (file) => ({ ...file, schemaVersion: 5, document: { ...(isObject(file.document) ? file.document : {}), assets: {} } }),
  // Version 6 adds constraints to every layer and layout grids to frames.
  // Left and top constraints are what layers already did when a frame was
  // resized, and a frame without grids looks as it did.
  5: (file) => {
    const body = isObject(file.document) ? file.document : {};
    const nodes = isObject(body.nodes) ? body.nodes : {};
    const upgraded: Raw = {};
    for (const id in nodes) {
      const node = nodes[id];
      if (!isObject(node) || node.type === 'PAGE') {
        upgraded[id] = node;
        continue;
      }
      const next: Raw = { constraints: { horizontal: 'MIN', vertical: 'MIN' }, ...node };
      if (node.type === 'FRAME' && !('layoutGrids' in node)) next.layoutGrids = [];
      upgraded[id] = next;
    }
    return { ...file, schemaVersion: 6, document: { ...body, nodes: upgraded } };
  },
  // Version 7 adds ruler guides to pages. Older pages have none.
  6: (file) => {
    const body = isObject(file.document) ? file.document : {};
    const nodes = isObject(body.nodes) ? body.nodes : {};
    const upgraded: Raw = {};
    for (const id in nodes) {
      const node = nodes[id];
      upgraded[id] = isObject(node) && node.type === 'PAGE' && !('guides' in node) ? { ...node, guides: [] } : node;
    }
    return { ...file, schemaVersion: 7, document: { ...body, nodes: upgraded } };
  },
  // Version 8 adds the VECTOR layer type. Older files contain no vector layers.
  7: (file) => ({ ...file, schemaVersion: 8 }),
  // Version 9 adds arcs to ellipses and arrowheads to lines and vectors. A
  // whole ellipse and no arrowheads are what older layers were.
  8: (file) => {
    const body = isObject(file.document) ? file.document : {};
    const nodes = isObject(body.nodes) ? body.nodes : {};
    const upgraded: Raw = {};
    for (const id in nodes) {
      const node = nodes[id];
      if (isObject(node) && node.type === 'ELLIPSE') upgraded[id] = { arcStart: 0, arcSweep: 360, arcRatio: 0, ...node };
      else if (isObject(node) && (node.type === 'LINE' || node.type === 'VECTOR')) upgraded[id] = { startArrow: 'NONE', endArrow: 'NONE', ...node };
      else upgraded[id] = node;
    }
    return { ...file, schemaVersion: 9, document: { ...body, nodes: upgraded } };
  },
  // Version 10 adds masks. No older layer is one.
  9: (file) => {
    const body = isObject(file.document) ? file.document : {};
    const nodes = isObject(body.nodes) ? body.nodes : {};
    const upgraded: Raw = {};
    for (const id in nodes) {
      const node = nodes[id];
      upgraded[id] = isObject(node) && node.type !== 'PAGE' ? { isMask: false, ...node } : node;
    }
    return { ...file, schemaVersion: 10, document: { ...body, nodes: upgraded } };
  },
  // Version 11 adds the BOOLEAN_OPERATION layer type. Older files contain none.
  10: (file) => ({ ...file, schemaVersion: 11 }),
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
