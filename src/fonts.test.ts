import { describe, expect, it } from 'vitest';
import {
  addLayer,
  clearTextLayoutCache,
  createDocument,
  DEFAULT_FONT_FAMILY,
  getPages,
  layoutText,
  styleTextRange,
  type Document,
  type NodeId,
  type TextMeasurer,
  type TextNode,
} from './core';
import { BUNDLED_FONT_FAMILY, bundledFonts, fontsUsedBy, loadFonts, onFontsLoaded } from './engine/text/fonts';
import { availableFonts, FONT_CANDIDATES, isFontAvailable } from './engine/text/measure';
import { createEditorStore } from './state/editorStore';

/**
 * The bundled font: new text is set in it, the faces a file needs are known
 * before the file is shown, and text is sized again when a face arrives late.
 */

function setup(): { doc: Document; pageId: NodeId } {
  const doc = createDocument('Fonts');
  return { doc, pageId: (getPages(doc)[0] as { id: NodeId }).id };
}

describe('the bundled font', () => {
  it('is what new text is set in, and is always on offer', () => {
    const { doc, pageId } = setup();
    const text = addLayer(doc, 'TEXT', pageId, { characters: 'Hello' });
    expect(BUNDLED_FONT_FAMILY).toBe('Inter');
    expect(DEFAULT_FONT_FAMILY).toBe(BUNDLED_FONT_FAMILY);
    expect((text.doc.nodes[text.id] as TextNode).fontFamily).toBe('Inter');
    // It heads the font menu and counts as installed whether or not the machine has a font of that name.
    expect(FONT_CANDIDATES[0]).toBe('Inter');
    expect(FONT_CANDIDATES.filter((family) => family === 'Inter')).toHaveLength(1);
    expect(isFontAvailable('Inter')).toBe(true);
    expect(availableFonts('Georgia')).toContain('Inter');
  });

  it('has eighteen faces: nine weights, upright and italic', () => {
    const faces = bundledFonts();
    expect(faces).toHaveLength(18);
    expect(faces[0]).toEqual({ font: '100 16px Inter, Arial, Helvetica, sans-serif', text: 'Hg' });
    expect(faces.filter((face) => face.font.startsWith('italic '))).toHaveLength(9);
    expect(new Set(faces.map((face) => face.font)).size).toBe(18);
  });
});

describe('the fonts a file needs', () => {
  it('are the fonts its text is set in, with the characters set in each', () => {
    const { doc, pageId } = setup();
    const plain = addLayer(doc, 'TEXT', pageId, { characters: 'Hello\nбел' });
    const georgia = addLayer(plain.doc, 'TEXT', pageId, { characters: 'Old', fontFamily: 'Georgia', fontWeight: 700, italic: true });
    // A bold word inside the first layer is another face of the same family.
    const styled = styleTextRange(georgia.doc, plain.id, 0, 5, { fontWeight: 700 });
    const fonts = fontsUsedBy(styled);
    expect(fonts.map((request) => request.font).sort()).toEqual([
      '400 16px Inter, Arial, Helvetica, sans-serif',
      '700 16px Inter, Arial, Helvetica, sans-serif',
      'italic 700 16px Georgia, Arial, Helvetica, sans-serif',
    ]);
    const regular = fonts.find((request) => request.font.startsWith('400')) as { text: string };
    // Both scripts are asked for, so that the face for each is loaded; the line break is not a character to draw.
    for (const char of 'Helloбел') expect(regular.text).toContain(char);
    expect(regular.text).not.toContain('\n');
    // Capitals too, since the case setting can show them without their being typed.
    expect(regular.text).toContain('Б');
    const bold = fonts.find((request) => request.font.startsWith('700 16px Inter')) as { text: string };
    expect(bold.text).toContain('H');
    expect(bold.text).not.toContain('б');
    // A file with no text needs none.
    expect(fontsUsedBy(doc)).toEqual([]);
  });

  it('can be asked for where there is no browser, and nothing happens', async () => {
    await expect(loadFonts(bundledFonts())).resolves.toBeUndefined();
    const stop = onFontsLoaded(() => {
      throw new Error('there is nothing to load here');
    });
    expect(() => stop()).not.toThrow();
  });
});

describe('text that measures differently once its font has loaded', () => {
  it('is laid out again after the layouts are forgotten, and sized again without an undo step', () => {
    // A measurer whose answers change, as a canvas's do when a font arrives: characters are 8 wide, then 10.
    let advance = 8;
    const measurer: TextMeasurer = {
      width: (text) => [...text].length * advance,
      metrics: (style) => ({ ascent: style.fontSize * 0.8, descent: style.fontSize * 0.2 }),
    };
    const { doc, pageId } = setup();
    const store = createEditorStore(doc, undefined, { measurer });
    let id = '';
    store.getState().apply('Add text', (d) => {
      const made = addLayer(d, 'TEXT', pageId, { characters: 'Hello' });
      id = made.id;
      return made.doc;
    });
    const node = (): TextNode => store.getState().doc.nodes[id] as TextNode;
    expect(node().width).toBe(40);
    const layout = layoutText(node(), measurer);
    expect(layoutText(node(), measurer)).toBe(layout);

    // The font arrives. Until the layouts are forgotten the old one is still handed out; afterwards it is worked out afresh.
    advance = 10;
    expect(layoutText(node(), measurer).width).toBe(40);
    clearTextLayoutCache();
    expect(layoutText(node(), measurer).width).toBe(50);

    // Sizing the text again changes the layer, but is not something to undo.
    const steps = store.getState().undoStack.length;
    store.getState().refitText();
    expect(node().width).toBe(50);
    expect(store.getState().undoStack).toHaveLength(steps);
    // Nothing to do the second time: the document is left exactly as it is.
    const settled = store.getState().doc;
    store.getState().refitText();
    expect(store.getState().doc).toBe(settled);

    // During a gesture (text being typed, say) its starting point is sized again too, so cancelling does not bring the old size back.
    advance = 12;
    clearTextLayoutCache();
    store.getState().beginGesture();
    store.getState().refitText();
    expect(node().width).toBe(60);
    store.getState().cancelGesture();
    expect(node().width).toBe(60);
    // And undoing the step that made the text still removes it.
    store.getState().undo();
    expect(store.getState().doc.nodes[id]).toBeUndefined();
  });
});
