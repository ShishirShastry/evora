import { describe, expect, it } from 'vitest';
import {
  addLayer,
  approximateMeasurer,
  createDocument,
  CURRENT_SCHEMA_VERSION,
  fitTextLayers,
  getPages,
  layoutText,
  normalizeRanges,
  parseFile,
  patchNode,
  repairDocument,
  replaceText,
  setTextCharacters,
  setTextStyle,
  spliceRanges,
  styleRange,
  stylesBetween,
  styleTextRange,
  textDifference,
  validateDocument,
  withoutRangeKeys,
  type Document,
  type LayerPatch,
  type NodeId,
  type TextNode,
  type TextStyleRange,
} from './core';
import { renderScene } from './engine/render/scene';
import { updateLayers } from './state/commands';
import { createEditorStore } from './state/editorStore';

/**
 * The approximate measurer makes every character half its font size wide, so
 * at 20px a character is 10px wide, a line 24px tall and its baseline 20px
 * down, and the arithmetic below can be checked by eye.
 */
const measurer = approximateMeasurer;
const RED = { r: 1, g: 0, b: 0 };

function text(props: LayerPatch): { doc: Document; node: TextNode; id: NodeId; pageId: NodeId } {
  const doc = createDocument('Rich text');
  const pageId = (getPages(doc)[0] as { id: NodeId }).id;
  const created = addLayer(doc, 'TEXT', pageId, { fontSize: 20, ...props });
  return { doc: created.doc, node: created.doc.nodes[created.id] as TextNode, id: created.id, pageId };
}

const textOf = (doc: Document, id: NodeId): TextNode => doc.nodes[id] as TextNode;

describe('styled ranges', () => {
  it('are kept in order, apart, inside the text and joined where alike', () => {
    const messy: TextStyleRange[] = [
      { start: 6, end: 9, italic: true },
      { start: 0, end: 4, fontWeight: 700 },
      { start: 2, end: 7, fontSize: 30 },
      { start: 9, end: 40, italic: true },
      { start: 5, end: 5, fontWeight: 700 },
      { start: 1, end: 3 },
    ];
    expect(normalizeRanges(messy, 12)).toEqual([
      { start: 0, end: 2, fontWeight: 700 },
      { start: 2, end: 4, fontSize: 30, fontWeight: 700 },
      { start: 4, end: 6, fontSize: 30 },
      { start: 6, end: 7, fontSize: 30, italic: true },
      { start: 7, end: 12, italic: true },
    ]);
    // Where two say different things about the same characters, the later one is kept.
    expect(normalizeRanges([{ start: 0, end: 4, fontSize: 10 }, { start: 2, end: 6, fontSize: 30 }], 6)).toEqual([
      { start: 0, end: 2, fontSize: 10 },
      { start: 2, end: 6, fontSize: 30 },
    ]);
    // The keys come out in one order whatever order they went in, so a saved file reads back unchanged.
    const keys = Object.keys(normalizeRanges([{ color: RED, italic: true, end: 3, fontFamily: 'Georgia', start: 0 }], 3)[0] as TextStyleRange);
    expect(keys).toEqual(['start', 'end', 'fontFamily', 'italic', 'color']);
  });

  it('follow their characters as text is typed and deleted', () => {
    // "Hello bold world": "bold" is bold.
    const ranges: TextStyleRange[] = [{ start: 6, end: 10, fontWeight: 700 }];
    // Typed before it, it moves along; typed inside it or at its end, it grows; typed at its start, it does not.
    expect(spliceRanges(ranges, 0, 0, 3, 19)).toEqual([{ start: 9, end: 13, fontWeight: 700 }]);
    expect(spliceRanges(ranges, 8, 0, 2, 18)).toEqual([{ start: 6, end: 12, fontWeight: 700 }]);
    expect(spliceRanges(ranges, 10, 0, 1, 17)).toEqual([{ start: 6, end: 11, fontWeight: 700 }]);
    expect(spliceRanges(ranges, 6, 0, 1, 17)).toEqual([{ start: 7, end: 11, fontWeight: 700 }]);
    expect(spliceRanges(ranges, 12, 0, 4, 20)).toEqual(ranges);
    // Deleted in part, in whole, and across its edge.
    expect(spliceRanges(ranges, 7, 2, 0, 14)).toEqual([{ start: 6, end: 8, fontWeight: 700 }]);
    expect(spliceRanges(ranges, 5, 6, 0, 10)).toEqual([]);
    expect(spliceRanges(ranges, 8, 5, 0, 11)).toEqual([{ start: 6, end: 8, fontWeight: 700 }]);
    expect(spliceRanges(ranges, 3, 5, 0, 11)).toEqual([{ start: 3, end: 5, fontWeight: 700 }]);
    // Typed over a selection that starts inside it: the new text is bold too.
    expect(spliceRanges(ranges, 8, 4, 3, 15)).toEqual([{ start: 6, end: 11, fontWeight: 700 }]);
    // At the very start of the text, new characters take the style of what follows.
    expect(spliceRanges([{ start: 0, end: 5, italic: true }], 0, 0, 2, 18)).toEqual([{ start: 0, end: 7, italic: true }]);
  });

  it('are set, combined and taken away again', () => {
    const { node } = text({ characters: 'Hello bold world' });
    const bold = { ...node, styleRanges: styleRange(node, 6, 10, { fontWeight: 700 }) };
    expect(bold.styleRanges).toEqual([{ start: 6, end: 10, fontWeight: 700 }]);
    // A size over part of it and beyond: three stretches.
    const sized = { ...bold, styleRanges: styleRange(bold, 8, 13, { fontSize: 40, color: RED }) };
    expect(sized.styleRanges).toEqual([
      { start: 6, end: 8, fontWeight: 700 },
      { start: 8, end: 10, fontSize: 40, fontWeight: 700, color: RED },
      { start: 10, end: 13, fontSize: 40, color: RED },
    ]);
    // Set back to what the layer has, a value leaves no trace; a colour is taken away with null.
    const unsized = { ...sized, styleRanges: styleRange(sized, 0, 16, { fontSize: 20 }) };
    expect(unsized.styleRanges).toEqual([
      { start: 6, end: 8, fontWeight: 700 },
      { start: 8, end: 10, fontWeight: 700, color: RED },
      { start: 10, end: 13, color: RED },
    ]);
    expect(styleRange(unsized, 0, 16, { color: null })).toEqual([{ start: 6, end: 10, fontWeight: 700 }]);
    expect(styleRange(unsized, 0, 16, { color: null, fontWeight: 400 })).toEqual([]);
    expect(withoutRangeKeys(sized.styleRanges, ['fontSize', 'color'], 16)).toEqual([{ start: 6, end: 10, fontWeight: 700 }]);

    // What is found between two places: one style, or several.
    expect(stylesBetween(sized, 6, 8).map((style) => style.fontWeight)).toEqual([700]);
    expect(stylesBetween(sized, 4, 9).map((style) => [style.fontWeight, style.fontSize])).toEqual([
      [400, 20],
      [700, 20],
      [700, 40],
    ]);
    expect(stylesBetween(sized, 12, 16).map((style) => style.color)).toEqual([RED, null]);
    // At a caret: the style typing there would have, which is that of the character before it.
    expect(stylesBetween(sized, 10, 10)[0]).toMatchObject({ fontWeight: 700, fontSize: 40 });
    expect(stylesBetween(sized, 6, 6)[0]).toMatchObject({ fontWeight: 400 });
    expect(stylesBetween(sized, 0, 0)[0]).toMatchObject({ fontWeight: 400, fontSize: 20, color: null });
  });

  it('stay on their characters through the document operations', () => {
    const { doc, id } = text({ characters: 'Hello bold world' });
    const styled = styleTextRange(doc, id, 10, 6, { fontWeight: 700 });
    expect(textOf(styled, id).styleRanges).toEqual([{ start: 6, end: 10, fontWeight: 700 }]);
    expect(textDifference('Hello bold world', 'Hello very bold world')).toEqual({ at: 6, removed: 0, inserted: 'very ' });
    expect(textDifference('Hello bold world', 'Hello world')).toEqual({ at: 6, removed: 5, inserted: '' });
    expect(textDifference('abc', 'abc')).toEqual({ at: 3, removed: 0, inserted: '' });

    const typed = setTextCharacters(styled, id, 'Oh, hello bold world');
    expect(textOf(typed, id)).toMatchObject({ characters: 'Oh, hello bold world', styleRanges: [{ start: 10, end: 14, fontWeight: 700 }] });
    const replaced = replaceText(styled, id, 6, 10, 'brave new');
    expect(textOf(replaced, id)).toMatchObject({ characters: 'Hello brave new world', styleRanges: [] });
    const within = replaceText(styled, id, 8, 8, 'L');
    expect(textOf(within, id)).toMatchObject({ characters: 'Hello boLld world', styleRanges: [{ start: 6, end: 11, fontWeight: 700 }] });
    // Nothing to do is nothing done.
    expect(replaceText(styled, id, 4, 4, '')).toBe(styled);
    expect(setTextCharacters(styled, id, 'Hello bold world')).toBe(styled);
    expect(styleTextRange(styled, id, 3, 3, { italic: true })).toBe(styled);
  });

  it('give way when the whole layer is given a value', () => {
    const { doc, id } = text({ characters: 'Hello bold world' });
    let styled = styleTextRange(doc, id, 6, 10, { fontWeight: 700, fontSize: 40, color: RED });
    styled = styleTextRange(styled, id, 0, 5, { italic: true });
    // A size for the layer is the size of all of its text; what else the ranges change stays.
    const sized = setTextStyle(styled, [id], { fontSize: 30 });
    expect(textOf(sized, id)).toMatchObject({
      fontSize: 30,
      styleRanges: [
        { start: 0, end: 5, italic: true },
        { start: 6, end: 10, fontWeight: 700, color: RED },
      ],
    });
    // New fills replace the colours of ranges.
    const filled = setTextStyle(sized, [id], { fills: textOf(sized, id).fills });
    expect(textOf(filled, id).styleRanges.some((range) => range.color !== undefined)).toBe(false);
    // Through the store, as the properties panel does it.
    const store = createEditorStore(styled);
    updateLayers(store, 'Change font weight', [id], { fontWeight: 300 });
    expect(textOf(store.getState().doc, id)).toMatchObject({ fontWeight: 300, styleRanges: [{ start: 0, end: 5 }, { start: 6, end: 10, fontSize: 40 }] });
    expect(textOf(store.getState().doc, id).styleRanges.some((range) => range.fontWeight !== undefined)).toBe(false);
    updateLayers(store, 'Change text alignment', [id], { textAlign: 'JUSTIFIED' });
    expect(textOf(store.getState().doc, id).styleRanges).toHaveLength(2);
    store.getState().undo();
    store.getState().undo();
    expect(textOf(store.getState().doc, id).styleRanges).toEqual(textOf(styled, id).styleRanges);
  });

  it('cannot reach past the end of text that was replaced by something shorter', () => {
    const { doc, id } = text({ characters: 'Hello bold world' });
    const store = createEditorStore(styleTextRange(doc, id, 6, 16, { fontWeight: 700 }));
    store.getState().apply('Shorten', (d) => patchNode(d, id, { characters: 'Hello bo' }));
    expect(textOf(store.getState().doc, id).styleRanges).toEqual([{ start: 6, end: 8, fontWeight: 700 }]);
    store.getState().apply('Shorten', (d) => patchNode(d, id, { characters: 'Hi' }));
    expect(textOf(store.getState().doc, id).styleRanges).toEqual([]);
  });
});

describe('laying out text in more than one style', () => {
  it('puts each stretch in its own run and makes a line as tall as its tallest', () => {
    const { node } = text({ characters: 'ab CD ef\ngh', styleRanges: [{ start: 3, end: 5, fontSize: 40, fontWeight: 700 }] });
    const layout = layoutText(node, measurer);
    expect(layout.lines.map((line) => line.text)).toEqual(['ab CD ef', 'gh']);
    const [first, second] = layout.lines as [(typeof layout.lines)[number], (typeof layout.lines)[number]];
    expect(first.runs.map((run) => [run.text, run.x, run.width, run.style.fontSize, run.style.fontWeight])).toEqual([
      ['ab ', 0, 30, 20, 400],
      ['CD', 30, 40, 40, 700],
      [' ef', 70, 30, 20, 400],
    ]);
    // 48 tall for the 40px text; the baseline is where the large text's is, and the small text sits on it.
    expect(first).toMatchObject({ top: 0, height: 48, baseline: 36, width: 100 });
    expect(second).toMatchObject({ top: 48, height: 24, baseline: 66, width: 20 });
    expect(layout).toMatchObject({ width: 100, height: 72, lineHeight: 24, indent: 0 });
    // A fixed line height is the height of every line.
    const fixed = layoutText({ ...node, lineHeight: 30 }, measurer);
    expect(fixed.lines.map((line) => line.height)).toEqual([30, 30]);
    expect(fixed.height).toBe(60);
    // The layer takes the size of its lines.
    const { doc, id } = text({ characters: 'ab CD ef\ngh' });
    const fitted = fitTextLayers(doc, styleTextRange(doc, id, 3, 5, { fontSize: 40 }), measurer);
    expect(textOf(fitted, id)).toMatchObject({ width: 100, height: 72 });
  });

  it('wraps by what each word measures in its own style', () => {
    // "BB" at 40px is 40 wide: "aa BB" is 70, and "cc" no longer fits in 80.
    const { node } = text({ characters: 'aa BB cc', width: 80, textAutoResize: 'HEIGHT', styleRanges: [{ start: 3, end: 5, fontSize: 40 }] });
    const layout = layoutText(node, measurer);
    expect(layout.lines.map((line) => [line.text, line.height])).toEqual([
      ['aa BB', 48],
      ['cc', 24],
    ]);
    // In one size it all fits on one line.
    expect(layoutText({ ...node, styleRanges: [] }, measurer).lines.map((line) => line.text)).toEqual(['aa BB cc']);
    // A word too long for the box is broken between characters, each measured in its style:
    // "ab" is 20 and the large "c" 20 more; the large "d" would make 60, so it starts the next line.
    const long = text({ characters: 'abcdef', width: 50, textAutoResize: 'HEIGHT', styleRanges: [{ start: 2, end: 4, fontSize: 40 }] });
    const broken = layoutText(long.node, measurer);
    expect(broken.lines.map((line) => line.text)).toEqual(['abc', 'def']);
    expect(broken.lines[1]?.runs.map((run) => [run.text, run.x, run.style.fontSize])).toEqual([
      ['d', 0, 40],
      ['ef', 20, 20],
    ]);
  });

  it('gives an empty line the height of text at that place', () => {
    const { node } = text({ characters: 'a\n\nb', styleRanges: [{ start: 1, end: 3, fontSize: 40 }] });
    expect(layoutText(node, measurer).lines.map((line) => line.height)).toEqual([24, 48, 24]);
  });

  it('keeps ranges on their characters when the case setting changes the length of the text', () => {
    // In capitals "ß" is "SS", so what is displayed is one longer than what is stored.
    const { node } = text({ characters: 'straße x', textCase: 'UPPER', styleRanges: [{ start: 7, end: 8, fontWeight: 700 }] });
    const line = layoutText(node, measurer).lines[0];
    expect(line?.runs.map((run) => [run.text, run.style.fontWeight])).toEqual([
      ['STRASSE ', 400],
      ['X', 700],
    ]);
    const title = text({ characters: 'hello big-world', textCase: 'TITLE', styleRanges: [{ start: 6, end: 9, italic: true }] });
    expect(layoutText(title.node, measurer).lines[0]?.runs.map((run) => run.text)).toEqual(['Hello ', 'Big', '-World']);
  });
});

describe('justified text', () => {
  it('spreads the words of wrapped lines across the width and leaves last lines alone', () => {
    const { node } = text({ characters: 'one two three four\nfive', width: 100, textAutoResize: 'HEIGHT', textAlign: 'JUSTIFIED' });
    const layout = layoutText(node, measurer);
    expect(layout.lines.map((line) => line.text)).toEqual(['one two', 'three four', 'five']);
    const [first, second, third] = layout.lines as [(typeof layout.lines)[number], (typeof layout.lines)[number], (typeof layout.lines)[number]];
    // "one two" is 70 wide: the 30 left over goes into the gap, and the line reaches the right edge.
    expect(first.runs.map((run) => [run.text, run.x, run.width])).toEqual([
      ['one', 0, 30],
      [' ', 30, 40],
      ['two', 70, 30],
    ]);
    expect(first.width).toBe(100);
    // The last line of a paragraph is not spread, nor is a line that fits anyway.
    expect(second.runs.map((run) => [run.text, run.x])).toEqual([['three four', 0]]);
    expect(third.runs.map((run) => [run.text, run.x])).toEqual([['five', 0]]);
    // Several gaps share what is left over equally.
    const three = text({ characters: 'a b c dddddddd', width: 80, textAutoResize: 'HEIGHT', textAlign: 'JUSTIFIED' });
    expect(layoutText(three.node, measurer).lines[0]?.runs.map((run) => [run.text, run.x])).toEqual([
      ['a', 0],
      [' ', 10],
      ['b', 35],
      [' ', 45],
      ['c', 70],
    ]);
    // Text that sets its own width never wraps, so there is nothing to spread.
    const auto = text({ characters: 'one two three', textAlign: 'JUSTIFIED' });
    expect(layoutText(auto.node, measurer).lines[0]?.runs).toHaveLength(1);
  });
});

describe('lists', () => {
  it('put a bullet in front of every paragraph and set its lines in', () => {
    const { node } = text({ characters: 'one\ntwo three four', width: 110, textAutoResize: 'HEIGHT', listType: 'BULLETED' });
    const layout = layoutText(node, measurer);
    // The text starts 30 in (one and a half times the font size), so "two three four" (140) wraps at 80.
    expect(layout.indent).toBe(30);
    expect(layout.lines.map((line) => [line.text, line.x, line.marker?.text ?? null])).toEqual([
      ['one', 30, '•'],
      ['two', 30, '•'],
      ['three', 30, null],
      ['four', 30, null],
    ]);
    // The bullet ends half a font size before the text.
    expect(layout.lines[0]?.marker).toMatchObject({ x: 10, width: 10 });
    expect(layout.width).toBe(80);
    // Right-aligned, the lines move within the column and the bullets stay where they are.
    const right = layoutText({ ...node, textAlign: 'RIGHT' }, measurer);
    expect(right.lines.map((line) => line.x)).toEqual([80, 80, 60, 70]);
    expect(right.lines[0]?.marker?.x).toBe(10);
  });

  it('number the paragraphs, with the numbers lined up on their right', () => {
    const characters = Array.from({ length: 10 }, (_, i) => `item ${i + 1}`).join('\n');
    const { doc, id } = text({ characters });
    const listed = fitTextLayers(doc, patchNode(doc, id, { listType: 'NUMBERED' }), measurer);
    const node = textOf(listed, id);
    const layout = layoutText(node, measurer);
    expect(layout.lines.map((line) => line.marker?.text)).toEqual(['1.', '2.', '3.', '4.', '5.', '6.', '7.', '8.', '9.', '10.']);
    // "10." is 30 wide, so the text starts at 40, and every number ends at 30.
    expect(layout.indent).toBe(40);
    expect(layout.lines[0]?.marker).toMatchObject({ x: 10, width: 20 });
    expect(layout.lines[9]?.marker).toMatchObject({ x: 0, width: 30 });
    // The layer is as wide as its longest item and the room for the numbers: "item 10" is 70.
    expect(node).toMatchObject({ width: 110, height: 240 });
    // Without the list it is as it was.
    expect(textOf(fitTextLayers(listed, patchNode(listed, id, { listType: 'NONE' }), measurer), id)).toMatchObject({ width: 70, height: 240 });
  });

  it('give a marker the look of the start of its item, without its underline', () => {
    const { node } = text({
      characters: 'big\nsmall',
      listType: 'BULLETED',
      textDecoration: 'UNDERLINE',
      styleRanges: [{ start: 0, end: 3, fontSize: 40, color: RED }],
    });
    const lines = layoutText(node, measurer).lines;
    expect(lines[0]?.marker?.style).toMatchObject({ fontSize: 40, color: RED, textDecoration: 'NONE' });
    expect(lines[1]?.marker?.style).toMatchObject({ fontSize: 20, color: null, textDecoration: 'NONE' });
    expect(lines[0]?.runs[0]?.style.textDecoration).toBe('UNDERLINE');
  });
});

describe('painting text in more than one style', () => {
  function paint(node: TextNode, doc: Document, pageId: NodeId): { text: unknown[]; font: string; fill: unknown }[] {
    const drawn: { text: unknown[]; font: string; fill: unknown }[] = [];
    const target: Record<string, unknown> = { globalAlpha: 1 };
    const ctx = new Proxy(target, {
      get(obj, prop: string) {
        if (prop in obj) return obj[prop];
        return (...args: unknown[]) => {
          if (prop === 'fillText') drawn.push({ text: args, font: String(obj.font), fill: obj.fillStyle });
          if (prop === 'fillRect' && args.length === 4 && args[3] !== 600) drawn.push({ text: ['line', ...args], font: '', fill: obj.fillStyle });
        };
      },
      set(obj, prop: string, value) {
        obj[prop] = value;
        return true;
      },
    }) as unknown as CanvasRenderingContext2D;
    renderScene(ctx, doc, pageId, { size: { width: 800, height: 600 }, dpr: 1, viewport: { x: 0, y: 0, zoom: 1 }, measurer });
    void node;
    return drawn;
  }

  it('draws each run in its own font and colour, and each list marker', () => {
    const { doc, id, pageId } = text({ characters: 'ab CD', x: 0, y: 0, listType: 'BULLETED' });
    let styled = styleTextRange(doc, id, 3, 5, { fontSize: 40, fontWeight: 700, color: RED, textDecoration: 'UNDERLINE' });
    styled = fitTextLayers(doc, styled, measurer);
    const drawn = paint(textOf(styled, id), styled, pageId);
    const glyphs = drawn.filter((call) => call.text[0] !== 'line');
    // With the layer's fill: the bullet and the plain text. Then, in its own colour, the styled text.
    expect(glyphs.map((call) => call.text)).toEqual([
      ['•', 10, 36],
      ['ab ', 30, 36],
      ['CD', 60, 36],
    ]);
    expect(glyphs[1]?.font).toContain('400 20px');
    expect(glyphs[2]?.font).toContain('700 40px');
    expect(glyphs[2]?.fill).toBe('rgb(255, 0, 0)');
    expect(glyphs[1]?.fill).not.toBe('rgb(255, 0, 0)');
    // The underline runs under the styled text only, as thick as its size asks.
    expect(drawn.filter((call) => call.text[0] === 'line').map((call) => call.text)).toEqual([['line', 60, 36 + 40 * 0.12, 40, 2.5]]);
  });
});

describe('text in the file format', () => {
  it('checks ranges, list and alignment, and reads back what it wrote', () => {
    const { doc, id } = text({ characters: 'Hello bold world', listType: 'NUMBERED', textAlign: 'JUSTIFIED' });
    const styled = styleTextRange(doc, id, 6, 10, { fontWeight: 700, color: RED, fontFamily: 'Georgia' });
    expect(validateDocument(styled)).toEqual([]);
    expect(repairDocument(JSON.parse(JSON.stringify(styled))).repairs).toEqual([]);

    const damaged = JSON.parse(JSON.stringify(styled)) as { nodes: Record<string, Record<string, unknown>> };
    Object.assign(damaged.nodes[id] as Record<string, unknown>, {
      listType: 'CHECKLIST',
      textAlign: 'SIDEWAYS',
      styleRanges: [
        { start: 12, end: 99, fontSize: 9000, italic: 'yes' },
        { start: 'two', end: 4, fontWeight: 700 },
        { start: 0, end: 5, fontWeight: 650, textDecoration: 'WAVY', color: { r: 2, g: -1, b: 0.5 } },
        'bold',
      ],
    });
    const repaired = repairDocument(damaged);
    expect(repaired.repairs.length).toBeGreaterThan(0);
    expect(textOf(repaired.doc, id)).toMatchObject({
      listType: 'NONE',
      textAlign: 'LEFT',
      styleRanges: [
        { start: 0, end: 5, fontWeight: 700, color: { r: 1, g: 0, b: 0.5 } },
        { start: 12, end: 16, fontSize: 2000 },
      ],
    });
    expect(textOf(repaired.doc, id).styleRanges[0]).not.toHaveProperty('textDecoration');
    expect(textOf(repaired.doc, id).styleRanges[1]).not.toHaveProperty('italic');
  });

  it('opens a version 12 file: text that is no list and in one style', () => {
    const { doc, id } = text({ characters: 'Hello' });
    const v12 = JSON.parse(JSON.stringify(doc)) as { nodes: Record<string, Record<string, unknown>> };
    delete (v12.nodes[id] as Record<string, unknown>).listType;
    delete (v12.nodes[id] as Record<string, unknown>).styleRanges;
    const parsed = parseFile({ format: 'open-design', schemaVersion: 12, meta: { createdAt: '2026-11-16T16:00:00.000Z', updatedAt: '2026-11-16T16:00:00.000Z' }, document: v12 });
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(13);
    expect(parsed.file.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(parsed.repairs).toEqual([]);
    expect(parsed.file.document).toEqual(doc);
    expect(textOf(parsed.file.document, id)).toMatchObject({ listType: 'NONE', styleRanges: [] });
  });
});
