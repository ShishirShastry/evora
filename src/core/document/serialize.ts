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
  // Version 12 adds adjustments to image paints. Older images are drawn as they are: all zero.
  11: (file) => {
    const body = isObject(file.document) ? file.document : {};
    const nodes = isObject(body.nodes) ? body.nodes : {};
    // The new values go where a file written by this version has them, after the tile size,
    // so that an upgraded file reads exactly as a new one and nothing is reported as repaired.
    const adjusted = (paint: Raw): Raw => {
      const zero = { exposure: 0, contrast: 0, saturation: 0 };
      const next: Raw = {};
      let placed = false;
      for (const key in paint) {
        next[key] = paint[key];
        if (key === 'tileScale') {
          Object.assign(next, zero);
          placed = true;
        }
      }
      return placed ? next : { ...next, ...zero };
    };
    const adjust = (paints: unknown): unknown =>
      Array.isArray(paints) ? paints.map((paint) => (isObject(paint) && paint.type === 'IMAGE' ? adjusted(paint) : paint)) : paints;
    const upgraded: Raw = {};
    for (const id in nodes) {
      const node = nodes[id];
      upgraded[id] = isObject(node) && node.type !== 'PAGE' ? { ...node, fills: adjust(node.fills), strokes: adjust(node.strokes) } : node;
    }
    return { ...file, schemaVersion: 12, document: { ...body, nodes: upgraded } };
  },
  // Version 13 adds justified text, lists and styles on parts of a text layer.
  // Older text is not a list and is in one style throughout.
  12: (file) => {
    const body = isObject(file.document) ? file.document : {};
    const nodes = isObject(body.nodes) ? body.nodes : {};
    const upgraded: Raw = {};
    for (const id in nodes) {
      const node = nodes[id];
      upgraded[id] = isObject(node) && node.type === 'TEXT' ? { listType: 'NONE', styleRanges: [], ...node } : node;
    }
    return { ...file, schemaVersion: 13, document: { ...body, nodes: upgraded } };
  },
  // Version 14 adds mirrored text and image fills, and guides on frames.
  // Nothing older is mirrored, and no older frame has guides.
  13: (file) => {
    const body = isObject(file.document) ? file.document : {};
    const nodes = isObject(body.nodes) ? body.nodes : {};
    // As in version 12: the new values go where a file written by this version has them (after the
    // adjustments), so that an upgraded file reads exactly as a new one.
    const unflipped = (paint: Raw): Raw => {
      const flags = { flipX: false, flipY: false };
      const next: Raw = {};
      let placed = false;
      for (const key in paint) {
        next[key] = paint[key];
        if (key === 'saturation') {
          Object.assign(next, flags);
          placed = true;
        }
      }
      return placed ? next : { ...next, ...flags };
    };
    const unflip = (paints: unknown): unknown =>
      Array.isArray(paints) ? paints.map((paint) => (isObject(paint) && paint.type === 'IMAGE' ? unflipped(paint) : paint)) : paints;
    const upgraded: Raw = {};
    for (const id in nodes) {
      const node = nodes[id];
      if (!isObject(node) || node.type === 'PAGE') {
        upgraded[id] = node;
        continue;
      }
      const next: Raw = { ...node, fills: unflip(node.fills), strokes: unflip(node.strokes) };
      if (node.type === 'FRAME' && !('guides' in node)) next.guides = [];
      if (node.type === 'TEXT') Object.assign(next, { flipX: node.flipX === true, flipY: node.flipY === true });
      upgraded[id] = next;
    }
    return { ...file, schemaVersion: 14, document: { ...body, nodes: upgraded } };
  },
  // Version 15 adds Auto Layout. No older frame lays out its children, and every older layer is the
  // size it was given, except text, which hugs in the directions its own sizing mode fits to its content.
  14: (file) => {
    const body = isObject(file.document) ? file.document : {};
    const nodes = isObject(body.nodes) ? body.nodes : {};
    const upgraded: Raw = {};
    for (const id in nodes) {
      const node = nodes[id];
      if (!isObject(node) || node.type === 'PAGE') {
        upgraded[id] = node;
        continue;
      }
      const hugsWidth = node.type === 'TEXT' && (node.textAutoResize === undefined || node.textAutoResize === 'WIDTH_AND_HEIGHT');
      const hugsHeight = node.type === 'TEXT' && node.textAutoResize !== 'NONE';
      const next: Raw = {
        layoutSizingHorizontal: hugsWidth ? 'HUG' : 'FIXED',
        layoutSizingVertical: hugsHeight ? 'HUG' : 'FIXED',
        layoutPositioning: 'AUTO',
        minWidth: null,
        maxWidth: null,
        minHeight: null,
        maxHeight: null,
        ...node,
      };
      if (node.type === 'FRAME') {
        const frame: Raw = {
          layoutMode: 'NONE',
          layoutWrap: 'NO_WRAP',
          primaryAxisAlignItems: 'MIN',
          counterAxisAlignItems: 'MIN',
          counterAxisAlignContent: 'AUTO',
          itemSpacing: 0,
          counterAxisSpacing: 0,
          paddingLeft: 0,
          paddingRight: 0,
          paddingTop: 0,
          paddingBottom: 0,
          itemsReversed: false,
        };
        for (const key in frame) if (!(key in node)) next[key] = frame[key];
      }
      upgraded[id] = next;
    }
    return { ...file, schemaVersion: 15, document: { ...body, nodes: upgraded } };
  },
  // Version 16 adds STRETCH to the alignments across a layout. No older frame stretches its children.
  15: (file) => ({ ...file, schemaVersion: 16 }),
  // Version 17 lets a column wrap. In older files only rows do, so only the version number changes.
  16: (file) => ({ ...file, schemaVersion: 17 }),
  // Version 18 adds components and instances. No older frame is either, and no older layer mirrors another.
  17: (file) => {
    const body = isObject(file.document) ? file.document : {};
    const nodes = isObject(body.nodes) ? body.nodes : {};
    const upgraded: Raw = {};
    for (const id in nodes) {
      const node = nodes[id];
      if (!isObject(node) || node.type === 'PAGE') {
        upgraded[id] = node;
        continue;
      }
      const next: Raw = { sourceId: null, ...node };
      if (node.type === 'FRAME') {
        const frame: Raw = { kind: 'FRAME', description: '', componentId: null, overrides: {} };
        for (const key in frame) if (!(key in node)) next[key] = frame[key];
      }
      upgraded[id] = next;
    }
    return { ...file, schemaVersion: 18, document: { ...body, nodes: upgraded } };
  },
  // Version 19 adds component sets, variants and component properties. No older component has properties or is a
  // variant, and no older layer is bound to a property.
  18: (file) => {
    const body = isObject(file.document) ? file.document : {};
    const nodes = isObject(body.nodes) ? body.nodes : {};
    const upgraded: Raw = {};
    for (const id in nodes) {
      const node = nodes[id];
      if (!isObject(node) || node.type === 'PAGE') {
        upgraded[id] = node;
        continue;
      }
      const next: Raw = { propRefs: {}, ...node };
      if (node.type === 'FRAME') {
        const frame: Raw = { componentProps: [], variantProps: {}, propValues: {} };
        for (const key in frame) if (!(key in node)) next[key] = frame[key];
      }
      upgraded[id] = next;
    }
    return { ...file, schemaVersion: 19, document: { ...body, nodes: upgraded } };
  },
  // Version 20 adds styles and variables. Older documents have none, and no older layer uses one.
  19: (file) => {
    const body = isObject(file.document) ? file.document : {};
    const nodes = isObject(body.nodes) ? body.nodes : {};
    const upgraded: Raw = {};
    for (const id in nodes) {
      const node = nodes[id];
      if (!isObject(node)) upgraded[id] = node;
      else if (node.type === 'PAGE') upgraded[id] = { variableModes: {}, ...node };
      else upgraded[id] = { styleRefs: {}, boundVariables: {}, variableModes: {}, ...node };
    }
    return { ...file, schemaVersion: 20, document: { styles: {}, variables: {}, variableCollections: {}, ...body, nodes: upgraded } };
  },
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
