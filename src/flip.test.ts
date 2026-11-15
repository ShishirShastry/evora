import { describe, expect, it } from 'vitest';
import {
  addLayer,
  applyToPoint,
  applyToVector,
  createDocument,
  dropShadow,
  flipNodes,
  getPages,
  getWorldBounds,
  getWorldMatrix,
  gradientPaint,
  type Document,
  type EllipseNode,
  type FlipAxis,
  type GradientPaint,
  type LayerNode,
  type LayerPatch,
  type LayerType,
  type LineNode,
  type NodeId,
  type Point,
  type RectangleNode,
  type ShadowEffect,
} from './core';

/**
 * Flip gives the mirror image of a layer. The basic shapes are the same on
 * both sides, but what they are painted with need not be: these tests check
 * that the things that are not the same on both sides end up mirrored on the
 * page, whatever the layer's rotation.
 */

const RED = { r: 1, g: 0, b: 0 };
const BLUE = { r: 0, g: 0, b: 1 };

function make(type: LayerType, props: LayerPatch): { doc: Document; id: NodeId } {
  const doc = createDocument('Flip');
  const pageId = (getPages(doc)[0] as { id: NodeId }).id;
  const made = addLayer(doc, type, pageId, { x: 100, y: 100, width: 200, height: 100, ...props });
  return { doc: made.doc, id: made.id };
}

const layer = (doc: Document, id: NodeId): LayerNode => doc.nodes[id] as LayerNode;
const gradientOf = (doc: Document, id: NodeId): GradientPaint => layer(doc, id).fills[0] as GradientPaint;

/** Where a point of a layer's unit square (0,0 its top-left, 1,1 its bottom-right) is on the page. */
function onPage(doc: Document, id: NodeId, unit: Point): Point {
  const node = layer(doc, id);
  return applyToPoint(getWorldMatrix(doc, id), { x: unit.x * node.width, y: unit.y * node.height });
}

/** The mirror image of a page point in the line through the middle of a layer's bounds. */
function mirrorOnPage(doc: Document, id: NodeId, p: Point, axis: FlipAxis): Point {
  const bounds = getWorldBounds(doc, id);
  return axis === 'horizontal' ? { x: 2 * (bounds.x + bounds.width / 2) - p.x, y: p.y } : { x: p.x, y: 2 * (bounds.y + bounds.height / 2) - p.y };
}

function expectNear(actual: Point, expected: Point): void {
  expect(actual.x).toBeCloseTo(expected.x, 6);
  expect(actual.y).toBeCloseTo(expected.y, 6);
}

describe('flip mirrors what a layer is painted with', () => {
  it('changes the sides of a gradient', () => {
    // Red on the left to blue on the right.
    const { doc, id } = make('RECTANGLE', { fills: [gradientPaint('GRADIENT_LINEAR', RED, BLUE, 0)] });
    expect(gradientOf(doc, id)).toMatchObject({ from: { x: 0, y: 0.5 }, to: { x: 1, y: 0.5 } });
    const across = flipNodes(doc, [id], 'horizontal');
    expect(gradientOf(across, id)).toMatchObject({ from: { x: 1, y: 0.5 }, to: { x: 0, y: 0.5 } });
    // Top to bottom it is the same either way up; flipped twice it is as it was.
    expect(gradientOf(flipNodes(doc, [id], 'vertical'), id)).toEqual(gradientOf(doc, id));
    expect(flipNodes(across, [id], 'horizontal').nodes[id]).toEqual(doc.nodes[id]);
    // The stops stay with their ends: only the handles move.
    expect(gradientOf(across, id).stops).toEqual(gradientOf(doc, id).stops);
  });

  it('puts both ends of a gradient at their mirror images on the page, whatever the layer and its rotation', () => {
    const paint: GradientPaint = { ...gradientPaint('GRADIENT_RADIAL', RED, BLUE), from: { x: 0.2, y: 0.3 }, to: { x: 0.9, y: 0.6 } };
    for (const type of ['RECTANGLE', 'ELLIPSE', 'POLYGON', 'STAR', 'FRAME'] as const) {
      for (const rotation of [0, 30, -75]) {
        for (const axis of ['horizontal', 'vertical'] as const) {
          const { doc, id } = make(type, { rotation, fills: [paint], strokes: [paint], strokeWeight: 4 });
          const flipped = flipNodes(doc, [id], axis);
          for (const end of ['from', 'to'] as const) {
            const before = onPage(doc, id, gradientOf(doc, id)[end]);
            expectNear(onPage(flipped, id, gradientOf(flipped, id)[end]), mirrorOnPage(doc, id, before, axis));
            const stroke = layer(flipped, id).strokes[0] as GradientPaint;
            expectNear(onPage(flipped, id, stroke[end]), mirrorOnPage(doc, id, before, axis));
          }
        }
      }
    }
  });

  it('swaps the radii of the corners', () => {
    // Top left, top right, bottom right, bottom left.
    const { doc, id } = make('RECTANGLE', { cornerRadii: [10, 20, 30, 40] });
    expect((flipNodes(doc, [id], 'horizontal').nodes[id] as RectangleNode).cornerRadii).toEqual([20, 10, 40, 30]);
    expect((flipNodes(doc, [id], 'vertical').nodes[id] as RectangleNode).cornerRadii).toEqual([40, 30, 20, 10]);
    const frame = make('FRAME', { cornerRadii: [0, 50, 0, 0] });
    expect((flipNodes(frame.doc, [frame.id], 'horizontal').nodes[frame.id] as RectangleNode).cornerRadii).toEqual([50, 0, 0, 0]);
    // One radius for all four corners is the same either way.
    const even = make('RECTANGLE', { cornerRadius: 12 });
    expect(flipNodes(even.doc, [even.id], 'horizontal').nodes[even.id]).toEqual(even.doc.nodes[even.id]);
  });

  it('mirrors the slice of an ellipse', () => {
    // A quarter from three o'clock to six o'clock: the bottom right.
    const { doc, id } = make('ELLIPSE', { arcStart: 0, arcSweep: 90 });
    // Left to right it becomes the bottom left: six o'clock to nine o'clock.
    expect(flipNodes(doc, [id], 'horizontal').nodes[id] as EllipseNode).toMatchObject({ arcStart: 90, arcSweep: 90 });
    // Top to bottom it becomes the top right: twelve o'clock to three o'clock.
    expect(flipNodes(doc, [id], 'vertical').nodes[id] as EllipseNode).toMatchObject({ arcStart: 270, arcSweep: 90 });
    // A ring is the same on all sides.
    const ring = make('ELLIPSE', { arcRatio: 0.5 });
    expect(flipNodes(ring.doc, [ring.id], 'horizontal').nodes[ring.id]).toEqual(ring.doc.nodes[ring.id]);
    // Twice is as it was.
    const odd = make('ELLIPSE', { arcStart: 35, arcSweep: 200, rotation: 20 });
    expect(flipNodes(flipNodes(odd.doc, [odd.id], 'vertical'), [odd.id], 'vertical').nodes[odd.id]).toEqual(odd.doc.nodes[odd.id]);
  });

  it('keeps an arrowhead at the end of the line that is its mirror image', () => {
    // A line from left to right with a triangle at its right end.
    const { doc, id } = make('LINE', { height: 0, rotation: 20, startArrow: 'NONE', endArrow: 'TRIANGLE' });
    const headBefore = onPage(doc, id, { x: 1, y: 0 });
    const across = flipNodes(doc, [id], 'horizontal');
    // The line now runs the other way, so the triangle is at its start, which is where the mirror image of the old end is.
    expect(across.nodes[id] as LineNode).toMatchObject({ startArrow: 'TRIANGLE', endArrow: 'NONE' });
    expectNear(onPage(across, id, { x: 0, y: 0 }), mirrorOnPage(doc, id, headBefore, 'horizontal'));
    // Top to bottom the line keeps its direction along the page, and its head its end.
    const down = flipNodes(doc, [id], 'vertical');
    expect(down.nodes[id] as LineNode).toMatchObject({ startArrow: 'NONE', endArrow: 'TRIANGLE' });
    expectNear(onPage(down, id, { x: 1, y: 0 }), mirrorOnPage(doc, id, headBefore, 'vertical'));
  });

  it('makes a shadow fall the other way', () => {
    const shadow: ShadowEffect = { ...dropShadow(), offsetX: 10, offsetY: 5 };
    /** Which way the shadow falls on the page: its offset is along the layer's own axes. */
    const falls = (doc: Document, id: NodeId): Point => {
      const effect = layer(doc, id).effects[0] as ShadowEffect;
      return applyToVector(getWorldMatrix(doc, id), { x: effect.offsetX, y: effect.offsetY });
    };
    for (const type of ['RECTANGLE', 'POLYGON'] as const) {
      for (const rotation of [0, 40]) {
        const { doc, id } = make(type, { rotation, effects: [shadow] });
        const before = falls(doc, id);
        expectNear(falls(flipNodes(doc, [id], 'horizontal'), id), { x: -before.x, y: before.y });
        expectNear(falls(flipNodes(doc, [id], 'vertical'), id), { x: before.x, y: -before.y });
      }
    }
  });

  it('reaches the layers inside a flipped frame or group', () => {
    const doc = createDocument('Flip');
    const pageId = (getPages(doc)[0] as { id: NodeId }).id;
    const frame = addLayer(doc, 'FRAME', pageId, { x: 0, y: 0, width: 400, height: 200 });
    const child = addLayer(frame.doc, 'RECTANGLE', frame.id, {
      x: 20,
      y: 20,
      width: 100,
      height: 50,
      cornerRadii: [8, 0, 0, 0],
      fills: [gradientPaint('GRADIENT_LINEAR', RED, BLUE, 0)],
    });
    const flipped = flipNodes(child.doc, [frame.id], 'horizontal');
    // The child is on the other side of the frame, and is itself mirrored.
    expect(flipped.nodes[child.id]).toMatchObject({ x: 280, y: 20, cornerRadii: [0, 8, 0, 0] });
    expect(gradientOf(flipped, child.id)).toMatchObject({ from: { x: 1, y: 0.5 }, to: { x: 0, y: 0.5 } });
    expect(flipNodes(flipped, [frame.id], 'horizontal').nodes[child.id]).toEqual(child.doc.nodes[child.id]);
  });
});
