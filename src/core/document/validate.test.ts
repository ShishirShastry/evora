import { describe, expect, it } from 'vitest';
import {
  addLayer,
  createDocument,
  CURRENT_SCHEMA_VERSION,
  FileFormatError,
  getAncestorIds,
  getChildIds,
  getPages,
  migrateFile,
  parseFile,
  parseFileText,
  repairDocument,
  serializeFile,
  toFile,
  validateDocument,
  type Document,
  type NodeId,
} from '../index';

const meta = { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z' };

function sample(): { doc: Document; pageId: NodeId; frameId: NodeId; rectId: NodeId; starId: NodeId } {
  const doc = createDocument('Sample');
  const pageId = (getPages(doc)[0] as { id: NodeId }).id;
  const frame = addLayer(doc, 'FRAME', pageId, { x: 10, y: 20, width: 300, height: 200 });
  const rect = addLayer(frame.doc, 'RECTANGLE', frame.id, { x: 5, y: 6, rotation: 15, cornerRadius: 4 });
  const star = addLayer(rect.doc, 'STAR', pageId, { pointCount: 7, innerRadius: 0.5 });
  return { doc: star.doc, pageId, frameId: frame.id, rectId: rect.id, starId: star.id };
}

/** A deep, mutable copy so tests can damage the data. */
function raw(doc: Document): { id: string; name: string; nodes: Record<string, Record<string, unknown>> } {
  return JSON.parse(JSON.stringify(doc));
}

describe('validation', () => {
  it('accepts a healthy document without changing it', () => {
    const { doc } = sample();
    expect(validateDocument(doc)).toEqual([]);
    expect(repairDocument(doc).doc).toEqual(doc);
  });

  it('adds a page when there is none', () => {
    const { doc, repairs } = repairDocument({ id: 'x', name: 'Empty', nodes: {} });
    expect(getPages(doc)).toHaveLength(1);
    expect(repairs.join(' ')).toContain('no pages');
  });

  it('starts from an empty document when the data is not a document at all', () => {
    for (const bad of [null, 42, 'text', []]) {
      const { doc, repairs } = repairDocument(bad);
      expect(getPages(doc)).toHaveLength(1);
      expect(repairs.length).toBeGreaterThan(0);
    }
  });

  it('moves layers with a missing parent to the first page', () => {
    const { doc, pageId, rectId } = sample();
    const data = raw(doc);
    (data.nodes[rectId] as Record<string, unknown>).parentId = 'does-not-exist';
    const repaired = repairDocument(data);
    expect(repaired.doc.nodes[rectId]?.parentId).toBe(pageId);
    expect(repaired.repairs.join(' ')).toContain('missing or invalid parent');
    expect(validateDocument(repaired.doc)).toEqual([]);
  });

  it('refuses a parent that cannot have children', () => {
    const { doc, pageId, rectId, starId } = sample();
    const data = raw(doc);
    (data.nodes[rectId] as Record<string, unknown>).parentId = starId;
    const repaired = repairDocument(data);
    expect(repaired.doc.nodes[rectId]?.parentId).toBe(pageId);
  });

  it('breaks parent cycles', () => {
    const { doc, pageId, frameId } = sample();
    const second = addLayer(doc, 'FRAME', frameId);
    const data = raw(second.doc);
    (data.nodes[frameId] as Record<string, unknown>).parentId = second.id;
    const repaired = repairDocument(data);
    for (const id of [frameId, second.id]) {
      const ancestors = getAncestorIds(repaired.doc, id);
      expect(ancestors[ancestors.length - 1]).toBe(pageId);
    }
    expect(validateDocument(repaired.doc)).toEqual([]);
  });

  it('rebuilds duplicate or missing order keys while keeping the order', () => {
    const { doc, pageId, frameId, starId } = sample();
    const data = raw(doc);
    (data.nodes[starId] as Record<string, unknown>).order = (data.nodes[frameId] as Record<string, unknown>).order;
    const repaired = repairDocument(data);
    const children = getChildIds(repaired.doc, pageId);
    expect(children).toHaveLength(2);
    expect(new Set(children.map((id) => repaired.doc.nodes[id]?.order)).size).toBe(2);
    expect(repaired.repairs.join(' ')).toContain('order was rebuilt');
  });

  it('clamps and resets out-of-range values', () => {
    const { doc, rectId, starId } = sample();
    const data = raw(doc);
    Object.assign(data.nodes[rectId] as Record<string, unknown>, { width: -50, x: null, opacity: 7, cornerRadius: -3, fills: 'red' });
    Object.assign(data.nodes[starId] as Record<string, unknown>, { pointCount: 1, innerRadius: 9 });
    const repaired = repairDocument(data);
    expect(repaired.doc.nodes[rectId]).toMatchObject({ width: 0, x: 0, opacity: 1, cornerRadius: 0, fills: [] });
    expect(repaired.doc.nodes[starId]).toMatchObject({ pointCount: 3, innerRadius: 1 });
    expect(repaired.repairs.join(' ')).toContain('out-of-range');
    // Untouched values survive.
    expect(repaired.doc.nodes[rectId]).toMatchObject({ y: 6, rotation: 15 });
  });

  it('removes items of unknown types together with their contents, and says so', () => {
    const { doc, frameId, rectId, starId } = sample();
    const data = raw(doc);
    (data.nodes[frameId] as Record<string, unknown>).type = 'HOLOGRAM';
    const repaired = repairDocument(data);
    expect(repaired.doc.nodes[frameId]).toBeUndefined();
    expect(repaired.doc.nodes[rectId]).toBeUndefined();
    expect(repaired.doc.nodes[starId]).toBeDefined();
    expect(repaired.repairs.join(' ')).toContain('unknown type');
  });

  it('re-keys nodes stored under the wrong ID', () => {
    const { doc, rectId } = sample();
    const data = raw(doc);
    (data.nodes[rectId] as Record<string, unknown>).id = 'something-else';
    const repaired = repairDocument(data);
    expect(repaired.doc.nodes[rectId]?.id).toBe(rectId);
  });
});

describe('file format', () => {
  it('round-trips through text without any change', () => {
    const { doc } = sample();
    const text = serializeFile(toFile(doc, meta));
    const parsed = parseFileText(text);
    expect(parsed.repairs).toEqual([]);
    expect(parsed.file.document).toEqual(doc);
    expect(parsed.file.meta).toEqual(meta);
    expect(parsed.file.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(parsed.file.format).toBe('evora');
  });

  it('opens a file saved before the application was renamed Evora, and saves it under the new name', () => {
    const { doc } = sample();
    const old = { ...toFile(doc, meta), format: 'open-design' };
    const parsed = parseFileText(JSON.stringify(old));
    expect(parsed.repairs).toEqual([]);
    expect(parsed.file.document).toEqual(doc);
    expect(parsed.file.format).toBe('evora');
  });

  it('refuses data that is not an Evora file', () => {
    expect(() => parseFileText('{{{')).toThrow(FileFormatError);
    expect(() => migrateFile(null)).toThrow('not an Evora file');
    expect(() => migrateFile({ format: 'something-else', schemaVersion: 1 })).toThrow('not an Evora file');
    expect(() => migrateFile({ format: 'open-design' })).toThrow('which version');
    expect(() => migrateFile({ format: 'open-design', schemaVersion: 1.5 })).toThrow('which version');
  });

  it('refuses files from a newer version instead of opening them lossily', () => {
    const { doc } = sample();
    const future = { ...toFile(doc, meta), schemaVersion: CURRENT_SCHEMA_VERSION + 1 };
    expect(() => parseFile(future)).toThrow('newer version');
  });

  it('supplies timestamps when they are missing', () => {
    const { doc } = sample();
    const parsed = parseFile({ format: 'open-design', schemaVersion: 1, document: doc });
    expect(Number.isNaN(Date.parse(parsed.file.meta.createdAt))).toBe(false);
  });
});
