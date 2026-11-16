import { describe, expect, it } from 'vitest';
import { approximateMeasurer, getPages, isLayer, listComponents, readFig, repairDocument, sha256Hex, writeFig, type Document, type FigEnvironment } from './core';

/**
 * A real file made by Figma: "EXPATS final.fig", supplied by the owner on
 * 2026-11-16 and kept outside the repository (in `.tools/fig-samples/`,
 * which git ignores), since it is the owner's design. These tests run only
 * where that file is; elsewhere they are skipped, and say so.
 *
 * The numbers are Figma's own: the file has 7,699 nodes, of which 40 are
 * not layers (the document, four pages, a variable collection, 22 variables
 * and 12 text styles), so every one of its 7,659 layers must come through.
 */

const fs = (await import('node:fs' as string)) as { existsSync(path: string): boolean; readFileSync(path: string): Uint8Array };
const zlib = (await import('node:zlib' as string)) as { inflateRawSync(b: Uint8Array): Uint8Array; deflateRawSync(b: Uint8Array): Uint8Array };
const SAMPLE = '.tools/fig-samples/EXPATS final.fig';
const present = fs.existsSync(SAMPLE);

const env: FigEnvironment = {
  inflateRaw: async (bytes) => new Uint8Array(zlib.inflateRawSync(bytes)),
  deflateRaw: async (bytes) => new Uint8Array(zlib.deflateRawSync(bytes)),
  sha256Hex,
  measurer: approximateMeasurer,
};

function counts(doc: Document) {
  const own = Object.values(doc.nodes).filter(isLayer).filter((layer) => layer.sourceId === null);
  const of = (test: (layer: (typeof own)[number]) => boolean): number => own.filter(test).length;
  return {
    layers: own.length,
    texts: of((layer) => layer.type === 'TEXT'),
    vectors: of((layer) => layer.type === 'VECTOR'),
    booleans: of((layer) => layer.type === 'BOOLEAN_OPERATION'),
    components: listComponents(doc).length,
    sets: of((layer) => layer.type === 'FRAME' && layer.kind === 'COMPONENT_SET'),
    instances: of((layer) => layer.type === 'FRAME' && layer.kind === 'INSTANCE'),
    autoLayout: of((layer) => layer.type === 'FRAME' && layer.layoutMode !== 'NONE'),
  };
}

describe.skipIf(!present)('a real Figma file (EXPATS final.fig)', () => {
  it('opens with every layer, component, instance, style, variable, flow and interaction, and says what it leaves out', async () => {
    const read = await readFig(new Uint8Array(fs.readFileSync(SAMPLE)), 'EXPATS final', env);
    expect(read.version).toBe(106);
    const { doc } = read;
    expect(getPages(doc).map((page) => page.name)).toEqual(['Design system', 'App screens', 'Cover & decisions']);
    expect(counts(doc)).toEqual({ layers: 7659, texts: 2327, vectors: 419, booleans: 2, components: 373, sets: 19, instances: 1118, autoLayout: 1320 });
    const own = Object.values(doc.nodes).filter(isLayer).filter((layer) => layer.sourceId === null);
    // Interactions, and the flows that start the prototype, are all there.
    expect(own.reduce((sum, layer) => sum + layer.reactions.length, 0)).toBe(351);
    expect(getPages(doc).reduce((sum, page) => sum + page.flows.length, 0)).toBe(12);
    // Variants know their values; instances have what was changed in them and their properties' values.
    expect(own.filter((layer) => layer.type === 'FRAME' && Object.keys(layer.variantProps).length > 0)).toHaveLength(42);
    expect(own.filter((layer) => layer.type === 'FRAME' && Object.keys(layer.overrides).length > 0).length).toBeGreaterThanOrEqual(290);
    expect(own.filter((layer) => layer.type === 'FRAME' && Object.keys(layer.propValues).length > 0)).toHaveLength(51);
    // Hugging and filling in Auto Layout come through as such.
    expect(own.filter((layer) => layer.layoutSizingHorizontal === 'HUG' || layer.layoutSizingVertical === 'HUG')).toHaveLength(3012);
    expect(own.filter((layer) => layer.layoutSizingHorizontal === 'FILL' || layer.layoutSizingVertical === 'FILL')).toHaveLength(693);
    // The design system: 12 text styles, one colour collection of 22 variables, bound where the file binds them.
    expect(Object.values(doc.styles).map((style) => style.type)).toEqual(Array(12).fill('TEXT'));
    expect(Object.values(doc.variableCollections).map((collection) => [collection.name, collection.modes.map((mode) => mode.name)])).toEqual([['Expats color', ['Light']]]);
    expect(Object.keys(doc.variables)).toHaveLength(22);
    expect(doc.variables[Object.keys(doc.variables).find((id) => doc.variables[id]?.name === 'bg/page') as string]?.valuesByMode).toEqual({ [Object.values(doc.variableCollections)[0]!.modes[0]!.id]: { r: expect.closeTo(0.933, 3), g: expect.closeTo(0.933, 3), b: expect.closeTo(0.945, 3) } });
    expect(own.filter((layer) => Object.keys(layer.boundVariables).length > 0)).toHaveLength(32);
    expect(Object.keys(read.images)).toHaveLength(289);
    // A file that needs no repairing, and the short list of what could not be brought over.
    expect(repairDocument(JSON.parse(JSON.stringify(doc))).repairs).toEqual([]);
    expect(read.notConverted).toEqual([
      'Layers that were flipped (shown unflipped): 2',
      'Strokes of a different weight on each side (drawn with one weight): 118',
      'Changes made inside instances to layer names (shown as their component has them): 165',
      'Changes made inside instances to sizes (shown as their component has them): 300',
      'Changes made inside instances to Auto Layout positions (shown as their component has them): 3',
      'Changes made inside instances to stroke weights (shown as their component has them): 1',
      'Changes made inside instances to per-side stroke weights (shown as their component has them): 4',
    ]);

    // Saved as .fig and opened again, every layer is still there.
    const written = await writeFig(doc, read.images, env);
    const again = await readFig(written.bytes, 'EXPATS again', env);
    expect(counts(again.doc)).toEqual(counts(doc));
  }, 300000);
});

describe.skipIf(present)('a real Figma file', () => {
  it.skip('is not on this machine: put "EXPATS final.fig" in .tools/fig-samples/ to run these tests', () => undefined);
});
