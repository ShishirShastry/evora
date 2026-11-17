import { describe, expect, it } from 'vitest';
import {
  addLayer,
  approximateMeasurer,
  createDocument,
  cssFor,
  getPages,
  getWorldMatrix,
  groupNodes,
  imagePaint,
  isLayer,
  networkFromSubpaths,
  parsePathData,
  patchNode,
  solidPaint,
  type Document,
  type LayerPatch,
  type LayerType,
  type NodeId,
} from './core';
import { distanceToFrame } from './core/dev/inspect';
import { composeScreenFor, hasScreenCode, htmlFor, htmlPageFor, swiftScreenFor } from './core/dev/screen';
import { exportSvg } from './engine/export/svg';
import { buildVectorScene } from './engine/export/vector';
import { createEditorStore, type EditorStore } from './state/editorStore';

/**
 * Developer handoff, taken further: code for a whole frame with everything
 * in it (HTML and CSS, SwiftUI, Jetpack Compose), and the distance from a
 * layer to the edges of the frame it is in.
 */

const WHITE = { r: 1, g: 1, b: 1 };
const BLUE = { r: 0, g: 0, b: 1 };
const RED = { r: 1, g: 0, b: 0 };

const now = (store: EditorStore): Document => store.getState().doc;
const act = (store: EditorStore, fn: (doc: Document) => Document): void => store.getState().apply('Edit', fn);

function add(store: EditorStore, type: LayerType, parentId: NodeId, props: LayerPatch): NodeId {
  let id = '';
  act(store, (doc) => {
    const out = addLayer(doc, type, parentId, props);
    id = out.id;
    return out.doc;
  });
  return id;
}

/** The SVG the export engine writes for a layer, in its own box, as the Inspect tab passes it in. */
function svgFor(doc: Document) {
  return (id: NodeId): string | null => {
    const node = doc.nodes[id];
    if (!isLayer(node)) return null;
    const at = getWorldMatrix(doc, id);
    const scene = buildVectorScene(doc, [id], { measurer: approximateMeasurer, origin: { x: at[4], y: at[5] } });
    return exportSvg(scene, { width: node.width, height: node.height }).svg;
  };
}

/** A card laid out in a column, with a title, a box and an icon in it, and a badge placed by hand over its corner. */
function card() {
  const store = createEditorStore(createDocument('Handoff gaps'));
  const pageId = (getPages(now(store))[0] as { id: NodeId }).id;
  const cardId = add(store, 'FRAME', pageId, {
    name: 'Card',
    x: 100,
    y: 50,
    width: 200,
    height: 160,
    fills: [solidPaint(WHITE)],
    cornerRadius: 12,
    layoutMode: 'VERTICAL',
    itemSpacing: 8,
    paddingLeft: 16,
    paddingRight: 16,
    paddingTop: 16,
    paddingBottom: 16,
    counterAxisAlignItems: 'CENTER',
  } as LayerPatch);
  const title = add(store, 'TEXT', cardId, { name: 'Title', characters: 'Hello <world>', fills: [solidPaint(BLUE)], fontSize: 18, fontWeight: 600, lineHeight: 24 } as LayerPatch);
  const box = add(store, 'RECTANGLE', cardId, { name: 'Box', width: 40, height: 30, fills: [solidPaint(RED)], cornerRadius: 4 } as LayerPatch);
  const icon = add(store, 'VECTOR', cardId, { name: 'Icon', width: 10, height: 10, fills: [solidPaint(BLUE)], network: networkFromSubpaths(parsePathData('M0 0L10 0L10 10Z')) } as LayerPatch);
  const badge = add(store, 'RECTANGLE', cardId, { name: 'Badge', x: 180, y: 4, width: 12, height: 12, fills: [solidPaint(RED)], layoutPositioning: 'ABSOLUTE' } as LayerPatch);
  // The box takes the width of the column.
  act(store, (doc) => patchNode(doc, box, { layoutSizingHorizontal: 'FILL' } as LayerPatch));
  return { store, pageId, card: cardId, title, box, icon, badge };
}

describe('code for a whole frame', () => {
  it('writes HTML and CSS for the frame and everything in it: flexbox for Auto Layout, absolute places for the rest, text as text and vectors as inline SVG', () => {
    const c = card();
    const doc = now(c.store);
    const { html, css } = htmlFor(doc, c.card, { svgFor: svgFor(doc) });
    const lines = html.split('\n');
    expect(lines[0]).toBe('<div class="card">');
    // The text is escaped, and the vector is the export engine's SVG with the layer's class on it.
    expect(lines[1]).toBe('  <p class="title">Hello &lt;world&gt;</p>');
    expect(lines[2]).toBe('  <div class="box"></div>');
    expect(lines[3]).toMatch(/^ {2}<svg class="icon" aria-label="Icon" role="img" xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="10" height="10"/);
    expect(lines[3]).toContain('<path d="M0 0L10 0L10 10');
    expect(lines[4]).toBe('  <div class="badge"></div>');
    expect(lines[5]).toBe('</div>');

    const rule = (name: string): string[] => {
      const match = new RegExp(`\\.${name} \\{\\n([^}]*)\\n\\}`).exec(css);
      return match ? (match[1] as string).split('\n').map((line) => line.trim()) : [];
    };
    // Sizes in the design include padding, so every box is sized by its border.
    expect(css.startsWith('.card, .card * {\n  box-sizing: border-box;\n  margin: 0;\n}')).toBe(true);
    // The frame holds a layer placed by hand, so it is what that layer is placed in.
    expect(rule('card')).toEqual(['position: relative;', ...cssFor(doc, c.card).split('\n')]);
    expect(rule('card')).toContain('display: flex;');
    expect(rule('card')).toContain('flex-direction: column;');
    expect(rule('card')).toContain('gap: 8px;');
    expect(rule('card')).toContain('padding: 16px;');
    expect(rule('card')).toContain('align-items: center;');
    expect(rule('title')).toEqual([...cssFor(doc, c.title).split('\n'), 'white-space: pre;']);
    expect(rule('title')).toEqual(expect.arrayContaining(['font-size: 18px;', 'font-weight: 600;', 'line-height: 24px;', 'color: #0000FF;']));
    expect(rule('box')).toEqual(['align-self: stretch;', 'height: 30px;', 'background: #FF0000;', 'border-radius: 4px;']);
    // A drawing is only placed and sized: its look is in the SVG.
    expect(rule('icon')).toEqual(['width: 10px;', 'height: 10px;', 'overflow: visible;']);
    expect(rule('badge')).toEqual(['position: absolute;', 'left: 180px;', 'top: 4px;', 'width: 12px;', 'height: 12px;', 'background: #FF0000;']);

    // As one piece to paste, the CSS sits in a style element above the markup.
    expect(htmlPageFor(doc, c.card, { svgFor: svgFor(doc) })).toBe(`<style>\n${css}\n</style>\n\n${html}`);
    // Without a way to draw it, a vector is an empty box saying to export it.
    expect(htmlFor(doc, c.card).html).toContain('<div class="icon"><!-- Icon: export this layer as an SVG asset --></div>');
  });

  it('places layers in a frame without Auto Layout, and in groups, from the top-left corner of what they are in, and names images by their file', () => {
    const store = createEditorStore(createDocument('Free'));
    const pageId = (getPages(now(store))[0] as { id: NodeId }).id;
    const screen = add(store, 'FRAME', pageId, { name: 'Screen', width: 320, height: 200, fills: [solidPaint(WHITE)] } as LayerPatch);
    const a = add(store, 'RECTANGLE', screen, { name: 'A', x: 20, y: 30, width: 50, height: 50, fills: [solidPaint(RED)] } as LayerPatch);
    add(store, 'RECTANGLE', screen, { name: 'A', x: 90, y: 30, width: 50, height: 50, fills: [solidPaint(BLUE)] } as LayerPatch);
    add(store, 'RECTANGLE', screen, { name: 'Photo', x: 10, y: 100, width: 80, height: 60, fills: [{ ...imagePaint('abc'), scaleMode: 'FIT' }] } as LayerPatch);
    // The image's file is known by its hash, as a placed image is.
    store.getState().addAssets({ abc: { name: 'photo.png', mimeType: 'image/png', width: 10, height: 10 } });
    let group = '';
    act(store, (doc) => {
      const out = groupNodes(doc, [a]) as { doc: Document; id: NodeId };
      group = out.id;
      return out.doc;
    });
    const doc = now(store);
    const { html, css } = htmlFor(doc, screen);
    expect(html.split('\n')).toEqual(['<div class="screen">', '  <div class="group-1">', '    <div class="a"></div>', '  </div>', '  <div class="a-2"></div>', '  <img class="photo" src="photo.png" alt="Photo">', '</div>'].map((line) => line.replace('group-1', String(doc.nodes[group]?.name).toLowerCase().replace(/[^a-z0-9]+/g, '-'))));
    expect(css).toContain('.screen {\n  position: relative;\n  width: 320px;');
    expect(css).toContain('.a-2 {\n  position: absolute;\n  left: 90px;\n  top: 30px;');
    expect(css).toContain('object-fit: contain;');
    expect(css).not.toContain('url("photo.png")');
    // The rectangle in the group is placed in the group, which is placed in the frame.
    expect(css).toMatch(/\.a \{\n {2}position: absolute;\n {2}left: 0;\n {2}top: 0;/);
  });

  it('writes SwiftUI for the frame and everything in it: a stack for Auto Layout, with the layers taken out of it laid over it', () => {
    const c = card();
    const code = swiftScreenFor(now(c.store), c.card).split('\n');
    expect(code[0]).toBe('VStack(alignment: .center, spacing: 8) {');
    expect(code[1]).toBe('    Text("Hello <world>")');
    expect(code).toContain('        .font(.custom("Inter", size: 18))');
    expect(code).toContain('        .fontWeight(.semibold)');
    expect(code).toContain('    RoundedRectangle(cornerRadius: 4)');
    // The box fills the column's width and keeps its own height.
    expect(code).toContain('        .frame(height: 30)');
    expect(code).toContain('        .frame(maxWidth: .infinity)');
    expect(code).toContain('    Image("icon") // Exported from this layer as an asset');
    expect(code).toContain('    .padding(EdgeInsets(top: 16, leading: 16, bottom: 16, trailing: 16))');
    expect(code).toContain('    .frame(width: 200, height: 160, alignment: .top)');
    expect(code).toContain('    .background(Color(red: 1, green: 1, blue: 1), in: RoundedRectangle(cornerRadius: 12))');
    expect(code.slice(code.indexOf('    .overlay(alignment: .topLeading) {'))).toEqual([
      '    .overlay(alignment: .topLeading) {',
      '        Rectangle()',
      '            .fill(Color(red: 1, green: 0, blue: 0))',
      '            .frame(width: 12, height: 12)',
      '            .offset(x: 180, y: 4)',
      '    }',
    ]);
  });

  it('writes Jetpack Compose for the frame and everything in it: a column with spacing and padding, inside a box for the layer placed by hand', () => {
    const c = card();
    const code = composeScreenFor(now(c.store), c.card);
    expect(code.split('\n').slice(0, 14)).toEqual([
      'Box(',
      '    modifier = Modifier',
      '        .size(width = 200.dp, height = 160.dp)',
      '        .background(Color(0xFFFFFFFF), RoundedCornerShape(12.dp))',
      '        .clip(RoundedCornerShape(12.dp)),',
      ') {',
      '    Column(',
      '        modifier = Modifier',
      '            .matchParentSize()',
      '            .padding(start = 16.dp, top = 16.dp, end = 16.dp, bottom = 16.dp),',
      '        verticalArrangement = Arrangement.spacedBy(8.dp),',
      '        horizontalAlignment = Alignment.CenterHorizontally,',
      '    ) {',
      '        Text(',
    ]);
    expect(code).toContain('            text = "Hello <world>",');
    expect(code).toContain('            fontWeight = FontWeight.W600,');
    // The box fills the column's width: across the column, so it is not a weight.
    expect(code).toContain('                .height(30.dp)\n                .fillMaxWidth()\n                .background(Color(0xFFFF0000), RoundedCornerShape(4.dp)),');
    expect(code).toContain('            painter = painterResource(R.drawable.icon),');
    // The layer placed by hand lies over the column, moved to its place in the frame.
    expect(code).toContain('            .offset(x = 180.dp, y = 4.dp)\n            .size(width = 12.dp, height = 12.dp)');
  });

  it('knows which layers have more to say as a whole frame than as a layer', () => {
    const c = card();
    const doc = now(c.store);
    expect(hasScreenCode(doc, c.card)).toBe(true);
    expect(hasScreenCode(doc, c.box)).toBe(false);
    expect(hasScreenCode(doc, c.title)).toBe(false);
  });
});

describe('distance to the frame', () => {
  it('measures a layer to the edges of the frame it is in, past the groups between', () => {
    const store = createEditorStore(createDocument('Distances'));
    const pageId = (getPages(now(store))[0] as { id: NodeId }).id;
    const screen = add(store, 'FRAME', pageId, { name: 'Screen', x: 50, y: 50, width: 300, height: 200 } as LayerPatch);
    const a = add(store, 'RECTANGLE', screen, { name: 'A', x: 20, y: 30, width: 100, height: 40 } as LayerPatch);
    const b = add(store, 'RECTANGLE', screen, { name: 'B', x: 200, y: 150, width: 50, height: 20 } as LayerPatch);
    act(store, (doc) => (groupNodes(doc, [a, b]) as { doc: Document }).doc);
    const doc = now(store);
    expect(distanceToFrame(doc, a)).toEqual({ frameId: screen, frameName: 'Screen', left: 20, top: 30, right: 180, bottom: 130 });
    expect(distanceToFrame(doc, b)).toEqual({ frameId: screen, frameName: 'Screen', left: 200, top: 150, right: 50, bottom: 30 });
    // A frame on the page is in no frame.
    expect(distanceToFrame(doc, screen)).toBeNull();
  });
});
