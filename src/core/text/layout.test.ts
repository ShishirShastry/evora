import { describe, expect, it } from 'vitest';
import {
  addLayer,
  approximateMeasurer,
  createDocument,
  CURRENT_SCHEMA_VERSION,
  displayText,
  fitTextLayers,
  fontString,
  getLayer,
  getPages,
  hitTestDeepest,
  layoutText,
  parseFile,
  patchNode,
  repairDocument,
  textLayerName,
  validateDocument,
  type Document,
  type LayerPatch,
  type NodeId,
  type TextNode,
} from '../index';

/**
 * The approximate measurer makes every character half the font size wide, so
 * at 20px each character is 10px and the arithmetic below can be checked by eye.
 */
const measurer = approximateMeasurer;

function setup(): { doc: Document; pageId: NodeId } {
  const doc = createDocument('Text');
  return { doc, pageId: (getPages(doc)[0] as { id: NodeId }).id };
}

function text(props: LayerPatch): { doc: Document; node: TextNode; pageId: NodeId } {
  const { doc, pageId } = setup();
  const created = addLayer(doc, 'TEXT', pageId, { fontSize: 20, ...props });
  return { doc: created.doc, node: created.doc.nodes[created.id] as TextNode, pageId };
}

describe('text layout', () => {
  it('keeps auto-width text on one line per paragraph', () => {
    const { node } = text({ characters: 'Hello world\nBye' });
    const layout = layoutText(node, measurer);
    expect(layout.lines.map((line) => line.text)).toEqual(['Hello world', 'Bye']);
    expect(layout.width).toBe(110);
    expect(layout.lineHeight).toBe(24);
    expect(layout.height).toBe(48);
  });

  it('wraps at word boundaries when the width is fixed', () => {
    const { node } = text({ characters: 'one two three four', width: 80, textAutoResize: 'HEIGHT' });
    const layout = layoutText(node, measurer);
    // 8 characters fit per line.
    expect(layout.lines.map((line) => line.text)).toEqual(['one two', 'three', 'four']);
    expect(layout.height).toBe(72);
  });

  it('breaks a word that is wider than the box', () => {
    const { node } = text({ characters: 'abcdefghij', width: 40, textAutoResize: 'HEIGHT' });
    expect(layoutText(node, measurer).lines.map((line) => line.text)).toEqual(['abcd', 'efgh', 'ij']);
  });

  it('keeps empty lines', () => {
    const { node } = text({ characters: 'a\n\nb', width: 100, textAutoResize: 'HEIGHT' });
    expect(layoutText(node, measurer).lines.map((line) => line.text)).toEqual(['a', '', 'b']);
  });

  it('positions lines for each horizontal and vertical alignment', () => {
    const base = { characters: 'abc\nabcdef', width: 100, height: 100, textAutoResize: 'NONE' as const };
    const left = layoutText(text(base).node, measurer);
    expect(left.lines.map((line) => line.x)).toEqual([0, 0]);
    const center = layoutText(text({ ...base, textAlign: 'CENTER' }).node, measurer);
    expect(center.lines.map((line) => line.x)).toEqual([35, 20]);
    const right = layoutText(text({ ...base, textAlign: 'RIGHT' }).node, measurer);
    expect(right.lines.map((line) => line.x)).toEqual([70, 40]);

    // Two 24px lines in a 100px box. The baseline sits 18px into its line (ascent 16 + 2px half-leading).
    expect(left.lines.map((line) => line.baseline)).toEqual([18, 42]);
    const middle = layoutText(text({ ...base, verticalAlign: 'MIDDLE' }).node, measurer);
    expect(middle.lines.map((line) => line.baseline)).toEqual([44, 68]);
    const bottom = layoutText(text({ ...base, verticalAlign: 'BOTTOM' }).node, measurer);
    expect(bottom.lines.map((line) => line.baseline)).toEqual([70, 94]);
  });

  it('honours line height, letter spacing and letter case', () => {
    const spaced = layoutText(text({ characters: 'abcd', letterSpacing: 5, lineHeight: 40 }).node, measurer);
    expect(spaced.width).toBe(60);
    expect(spaced.height).toBe(40);
    expect(displayText({ characters: 'hello big-world', textCase: 'UPPER' })).toBe('HELLO BIG-WORLD');
    expect(displayText({ characters: 'Hello', textCase: 'LOWER' })).toBe('hello');
    expect(displayText({ characters: 'hello big-world', textCase: 'TITLE' })).toBe('Hello Big-World');
    expect(displayText({ characters: 'hello', textCase: 'ORIGINAL' })).toBe('hello');
  });

  it('builds a CSS font string with a fallback', () => {
    expect(fontString({ fontFamily: 'Arial', fontSize: 16, fontWeight: 400, italic: false })).toBe('400 16px Arial, Arial, Helvetica, sans-serif');
    expect(fontString({ fontFamily: 'Segoe UI', fontSize: 12, fontWeight: 700, italic: true })).toBe(
      'italic 700 12px "Segoe UI", Arial, Helvetica, sans-serif',
    );
  });
});

describe('text layers that size themselves', () => {
  it('fits auto-width text to its content', () => {
    const { doc, node } = text({ characters: '', x: 100, y: 50 });
    const typed = patchNode(doc, node.id, { characters: 'Hello' });
    const fitted = fitTextLayers(doc, typed, measurer);
    expect(getLayer(fitted, node.id)).toMatchObject({ x: 100, y: 50, width: 50, height: 24 });
    // Nothing changed since: nothing is measured or rewritten.
    expect(fitTextLayers(fitted, fitted, measurer)).toBe(fitted);
  });

  it('grows right-aligned and centred text away from its anchored edge', () => {
    const right = text({ characters: 'ab', x: 100, y: 0, width: 20, height: 24, textAlign: 'RIGHT' });
    const grown = fitTextLayers(right.doc, patchNode(right.doc, right.node.id, { characters: 'abcdef' }), measurer);
    expect(getLayer(grown, right.node.id)).toMatchObject({ x: 60, width: 60 });

    const center = text({ characters: 'ab', x: 100, y: 0, width: 20, height: 24, textAlign: 'CENTER' });
    const wider = fitTextLayers(center.doc, patchNode(center.doc, center.node.id, { characters: 'abcdef' }), measurer);
    expect(getLayer(wider, center.node.id)).toMatchObject({ x: 80, width: 60 });
  });

  it('fits only the height of auto-height text and leaves fixed text alone', () => {
    const auto = text({ characters: 'x', width: 80, height: 24, textAutoResize: 'HEIGHT' });
    const wrapped = fitTextLayers(auto.doc, patchNode(auto.doc, auto.node.id, { characters: 'one two three four' }), measurer);
    expect(getLayer(wrapped, auto.node.id)).toMatchObject({ width: 80, height: 72 });

    const fixed = text({ characters: 'x', width: 80, height: 30, textAutoResize: 'NONE' });
    const same = fitTextLayers(fixed.doc, patchNode(fixed.doc, fixed.node.id, { characters: 'one two three four' }), measurer);
    expect(getLayer(same, fixed.node.id)).toMatchObject({ width: 80, height: 30 });
  });

  it('refits when the font changes', () => {
    const { doc, node } = text({ characters: 'Hello', width: 50, height: 24 });
    const bigger = fitTextLayers(doc, patchNode(doc, node.id, { fontSize: 40 }), measurer);
    expect(getLayer(bigger, node.id)).toMatchObject({ width: 100, height: 48 });
  });

  it('names a layer after its text', () => {
    expect(textLayerName('  Get   started \nsecond line')).toBe('Get started');
    expect(textLayerName('\n\nlater')).toBe('later');
    expect(textLayerName('x'.repeat(60))).toBe(`${'x'.repeat(40)}…`);
    expect(textLayerName('   ')).toBe('');
  });

  it('is selected by its box', () => {
    const { doc, node, pageId } = text({ characters: 'Hi', x: 10, y: 10, width: 100, height: 24 });
    expect(hitTestDeepest(doc, pageId, { x: 90, y: 20 })).toBe(node.id);
    expect(hitTestDeepest(doc, pageId, { x: 150, y: 20 })).toBeNull();
  });
});

/**
 * Checks that a file from an older version opened with everything it had,
 * plus the defaults later versions added: nothing lost, nothing repaired.
 */
function expectUpgraded(actual: Document, fixture: { id: string; name: string; nodes: Record<string, Record<string, unknown>> }): void {
  expect(actual.id).toBe(fixture.id);
  expect(actual.name).toBe(fixture.name);
  expect(Object.keys(actual.nodes).sort()).toEqual(Object.keys(fixture.nodes).sort());
  for (const [id, original] of Object.entries(fixture.nodes)) {
    expect(actual.nodes[id]).toMatchObject(original);
    if (original.type === 'PAGE') continue;
    // Added in version 4, with values that paint what the layer painted before.
    expect(actual.nodes[id]).toMatchObject({ strokeCap: 'NONE', strokeJoin: 'MITER', dashPattern: [], effects: [], blendMode: 'NORMAL' });
    if (original.type === 'FRAME' || original.type === 'RECTANGLE') expect(actual.nodes[id]).toMatchObject({ cornerRadii: null });
  }
  expect(validateDocument(actual)).toEqual([]);
}

describe('text in the file format', () => {
  it('validates text properties and repairs bad ones', () => {
    const { doc, node } = text({ characters: 'Hello' });
    expect(validateDocument(doc)).toEqual([]);

    const data = JSON.parse(JSON.stringify(doc)) as { nodes: Record<string, Record<string, unknown>> };
    Object.assign(data.nodes[node.id] as Record<string, unknown>, {
      characters: 42,
      fontFamily: '',
      fontSize: -5,
      fontWeight: 450,
      textAlign: 'SIDEWAYS',
      lineHeight: 'tall',
      textCase: null,
    });
    const repaired = repairDocument(data).doc.nodes[node.id];
    expect(repaired).toMatchObject({
      characters: '',
      fontFamily: 'Arial',
      fontSize: 1,
      fontWeight: 500,
      textAlign: 'LEFT',
      textCase: 'ORIGINAL',
    });
    expect((repaired as TextNode).lineHeight).toBeGreaterThan(0);
  });

  /** A file exactly as schema version 2 wrote it: frames, shapes and groups, no text. */
  const V2_FIXTURE = {
    format: 'open-design',
    schemaVersion: 2,
    meta: { createdAt: '2026-11-15T12:00:00.000Z', updatedAt: '2026-11-15T12:30:00.000Z' },
    document: {
      id: 'docV2fixture00001',
      name: 'Version 2 file',
      nodes: {
        page0000000000001: { id: 'page0000000000001', type: 'PAGE', name: 'Page 1', parentId: null, order: 'a0', backgroundColor: { r: 0.118, g: 0.118, b: 0.118 } },
        group000000000001: {
          id: 'group000000000001', type: 'GROUP', name: 'Group 1', parentId: 'page0000000000001', order: 'a0',
          visible: true, locked: false, x: 10, y: 10, width: 100, height: 100, rotation: 0, opacity: 1,
          fills: [], strokes: [], strokeWeight: 1, strokeAlign: 'INSIDE',
        },
        ellipse0000000001: {
          id: 'ellipse0000000001', type: 'ELLIPSE', name: 'Ellipse 1', parentId: 'group000000000001', order: 'a0',
          visible: true, locked: false, x: 0, y: 0, width: 100, height: 100, rotation: 0, opacity: 1,
          fills: [{ type: 'SOLID', color: { r: 0.851, g: 0.851, b: 0.851 }, opacity: 1, visible: true }], strokes: [], strokeWeight: 1, strokeAlign: 'INSIDE',
        },
      },
    },
  };

  it('opens a version 2 file as the current version with its content intact', () => {
    const parsed = parseFile(JSON.parse(JSON.stringify(V2_FIXTURE)));
    expect(parsed.file.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(3);
    expect(parsed.repairs).toEqual([]);
    expectUpgraded(parsed.file.document, V2_FIXTURE.document);
  });
});
