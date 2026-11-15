import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Phase 3 vector editing in the real browser: drawing a path with the Pen
 * tool, filling it, editing its points with the mouse and the keyboard, and
 * flattening a shape. Shapes are checked on the design canvas's pixels and
 * points on the overlay's.
 */

type RGB = [number, number, number];

const PAGE: RGB = [30, 30, 30];
const GREY: RGB = [217, 217, 217];
const ACCENT: RGB = [25, 194, 179];
const WHITE: RGB = [255, 255, 255];

const canvas = (page: Page): Locator => page.getByRole('application', { name: 'Design canvas' });
const field = (page: Page, label: string): Locator => page.getByRole('textbox', { name: label, exact: true });
const layers = (page: Page): Locator => page.getByRole('tree', { name: 'Layers' });
const layer = (page: Page, name: string): Locator => layers(page).getByRole('treeitem', { name, exact: true });

async function at(page: Page, point: [number, number]): Promise<[number, number]> {
  const box = await canvas(page).boundingBox();
  if (!box) throw new Error('canvas not visible');
  return [box.x + point[0], box.y + point[1]];
}

async function click(page: Page, point: [number, number], options: { clickCount?: number; ctrl?: boolean } = {}): Promise<void> {
  const [x, y] = await at(page, point);
  if (options.ctrl) await page.keyboard.down('Control');
  await page.mouse.click(x, y, { clickCount: options.clickCount ?? 1 });
  if (options.ctrl) await page.keyboard.up('Control');
}

async function drag(page: Page, from: [number, number], to: [number, number]): Promise<void> {
  const [fx, fy] = await at(page, from);
  const [tx, ty] = await at(page, to);
  await page.mouse.move(fx, fy);
  await page.mouse.down();
  await page.mouse.move(tx, ty, { steps: 6 });
  await page.mouse.up();
}

/** Presses at the first point, moves through the rest one by one, and releases: a freehand stroke. */
async function strokeThrough(page: Page, points: readonly [number, number][]): Promise<void> {
  const [startX, startY] = await at(page, points[0] as [number, number]);
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  for (const point of points.slice(1)) {
    const [x, y] = await at(page, point);
    await page.mouse.move(x, y);
  }
  await page.mouse.up();
}

async function set(page: Page, label: string, value: string): Promise<void> {
  await field(page, label).fill(value);
  await field(page, label).press('Enter');
}

/** Lets a double-click's time window pass, so the next click is a single one. */
const settle = (page: Page): Promise<void> => page.waitForTimeout(450);

async function readPixel(page: Page, index: number, x: number, y: number): Promise<RGB> {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  return page.evaluate(
    ([canvasIndex, px, py]) => {
      const element = document.querySelectorAll('canvas')[canvasIndex as number];
      const ctx = element?.getContext('2d');
      if (!element || !ctx) throw new Error('canvas not found');
      const ratio = element.width / element.clientWidth;
      const data = ctx.getImageData(Math.round((px as number) * ratio), Math.round((py as number) * ratio), 1, 1).data;
      return [data[0], data[1], data[2]] as [number, number, number];
    },
    [index, x, y],
  );
}

/** A pixel of the design itself. */
const pixel = (page: Page, x: number, y: number): Promise<RGB> => readPixel(page, 0, x, y);
/** A pixel of what is drawn over the design: outlines, points, handles. */
const overlayPixel = (page: Page, x: number, y: number): Promise<RGB> => readPixel(page, 1, x, y);

function expectNear(actual: RGB, expected: RGB, tolerance = 8): void {
  const ok = actual.every((channel, i) => Math.abs(channel - (expected[i] as number)) <= tolerance);
  expect(ok, `expected about rgb(${expected.join(', ')}), got rgb(${actual.join(', ')})`).toBe(true);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New design file' }).click();
  await expect(canvas(page)).toBeVisible();
});

test('pen: draw a closed path, fill it, edit its points, undo, reload', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  // P picks up the pen.
  await canvas(page).focus();
  await page.keyboard.press('p');
  await expect(page.getByRole('button', { name: 'Pen', exact: true })).toHaveAttribute('aria-pressed', 'true');

  // One point is not a layer yet; the second makes one.
  await click(page, [300, 200]);
  await expect(layers(page).getByRole('treeitem')).toHaveCount(0);
  await click(page, [500, 200]);
  await expect(layer(page, 'Vector 1')).toBeVisible();
  await expect(field(page, 'Width')).toHaveValue('200');
  await expect(field(page, 'Height')).toHaveValue('0');

  // A third point, then back onto the first one to close the triangle.
  await click(page, [400, 350]);
  await click(page, [300, 200]);
  await expect(field(page, 'Height')).toHaveValue('150');
  await expect(page.getByText('1 of 3 points selected')).toBeVisible();

  // The points are drawn over the design: the selected one filled, the others hollow.
  expectNear(await overlayPixel(page, 300, 200), ACCENT);
  expectNear(await overlayPixel(page, 500, 200), WHITE);
  expectNear(await overlayPixel(page, 400, 350), WHITE);

  // A path starts as an outline. Give it a fill: the inside is painted, the outside is not.
  expectNear(await pixel(page, 400, 250), PAGE);
  await page.getByRole('button', { name: 'Add fill' }).click();
  expectNear(await pixel(page, 400, 250), GREY);
  expectNear(await pixel(page, 310, 300), PAGE);
  expectNear(await pixel(page, 400, 380), PAGE);

  // Escape puts the pen down; the points stay open for editing with the move tool.
  await canvas(page).focus();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Move', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Done editing points' })).toBeVisible();

  // Drag the bottom point down: the shape and the layer's size follow.
  await drag(page, [400, 350], [400, 450]);
  await expect(field(page, 'Height')).toHaveValue('250');
  expectNear(await pixel(page, 400, 420), GREY);
  expectNear(await overlayPixel(page, 400, 450), ACCENT);

  // The selected point's position can be typed: 50 higher.
  const y = Number(await field(page, 'Point Y position').inputValue());
  await field(page, 'Point Y position').fill(String(y - 50));
  await field(page, 'Point Y position').press('Enter');
  await expect(field(page, 'Height')).toHaveValue('200');
  expectNear(await pixel(page, 400, 420), PAGE);

  // Ctrl-click makes the point smooth: the sharp tip becomes round, so the shape is wider near it.
  expectNear(await pixel(page, 420, 390), PAGE);
  await settle(page);
  await click(page, [400, 400], { ctrl: true });
  expectNear(await pixel(page, 420, 390), GREY);
  // Its two handles are shown, level with the point on either side of it.
  const handles = await page.evaluate(() => {
    const element = document.querySelectorAll('canvas')[1] as HTMLCanvasElement;
    const data = element.getContext('2d')!.getImageData(0, 400, element.width, 1).data;
    let white = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i] === 255 && data[i + 1] === 255 && data[i + 2] === 255 && data[i + 3] === 255) white++;
    return white;
  });
  expect(handles).toBeGreaterThan(4);
  await canvas(page).focus();
  await page.keyboard.press('Control+z');
  expectNear(await pixel(page, 420, 390), PAGE);

  // Delete removes the selected point, not the layer; undo brings it back.
  await settle(page);
  await click(page, [500, 200]);
  await expect(page.getByText('1 of 3 points selected')).toBeVisible();
  await page.keyboard.press('Delete');
  await expect(page.getByText('2 points. Click one to select it.')).toBeVisible();
  await expect(field(page, 'Width')).toHaveValue('100');
  await expect(layer(page, 'Vector 1')).toBeVisible();
  await page.keyboard.press('Control+z');
  await expect(field(page, 'Width')).toHaveValue('200');
  expectNear(await pixel(page, 400, 250), GREY);

  // While points are edited the layer's box has no handles: nothing is drawn at its bottom-right corner.
  expectNear(await overlayPixel(page, 500, 400), [0, 0, 0]);
  // Enter finishes editing, and the box handles are back.
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Edit points' })).toBeVisible();
  expectNear(await overlayPixel(page, 500, 400), WHITE);

  // It is all in the document: a reload shows the same shape.
  await expect(page.getByRole('status')).toHaveText('Saved');
  await page.reload();
  await expect(canvas(page)).toBeVisible();
  await expect.poll(() => pixel(page, 400, 250)).toEqual(GREY);
  await layer(page, 'Vector 1').click();
  await expect(field(page, 'Width')).toHaveValue('200');
  await expect(field(page, 'Height')).toHaveValue('200');

  await page.screenshot({ path: 'test-results/phase3-pen.png' });
  expect(errors).toEqual([]);
});

test('pen: curves by dragging, and a hole by the fill rule', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await canvas(page).focus();
  await page.keyboard.press('p');

  // Two points, each dragged as it is placed so that the path leaves the first upwards and
  // arrives at the second from above, then closed: a lens with a round top.
  await drag(page, [300, 400], [300, 300]);
  await drag(page, [500, 400], [500, 500]);
  await click(page, [300, 400]);
  await page.getByRole('button', { name: 'Add fill' }).click();
  // Well above the straight line between the two points, where only a curve reaches.
  expectNear(await pixel(page, 400, 345), GREY);
  expectNear(await pixel(page, 400, 300), PAGE);

  // A second, smaller path inside the first, in the same layer.
  await canvas(page).focus();
  await click(page, [380, 360]);
  await click(page, [420, 360]);
  await click(page, [400, 385]);
  await click(page, [380, 360]);
  await expect(page.getByText('1 of 5 points selected')).toBeVisible();
  // Enclosed is enclosed, until the rule says a shape inside a shape is a hole.
  expectNear(await pixel(page, 400, 368), GREY);
  await page.getByRole('combobox', { name: 'Fill rule', exact: true }).selectOption('EVENODD');
  expectNear(await pixel(page, 400, 368), PAGE);
  expectNear(await pixel(page, 400, 345), GREY);

  expect(errors).toEqual([]);
});

test('flatten a shape to a vector and open it with a double-click', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await canvas(page).focus();
  await page.keyboard.press('o');
  await drag(page, [200, 200], [400, 400]);
  await expect(layer(page, 'Ellipse 1')).toBeVisible();
  expectNear(await pixel(page, 300, 300), GREY);
  // The corner of the box is outside the circle.
  expectNear(await pixel(page, 210, 210), PAGE);

  await page.keyboard.press('Control+e');
  await expect(page.getByRole('button', { name: 'Edit points' })).toBeVisible();
  await expect(field(page, 'Width')).toHaveValue('200');
  // It looks exactly as it did.
  expectNear(await pixel(page, 300, 300), GREY);
  expectNear(await pixel(page, 210, 210), PAGE);
  expectNear(await pixel(page, 232, 232), GREY);

  // Double-click opens its points: four of them, at the top, right, bottom and left.
  await click(page, [300, 300], { clickCount: 2 });
  await expect(page.getByText('4 points. Click one to select it.')).toBeVisible();
  expectNear(await overlayPixel(page, 300, 200), WHITE);
  expectNear(await overlayPixel(page, 400, 300), WHITE);

  // Pull the top point up: the circle becomes an egg.
  await settle(page);
  await drag(page, [300, 200], [300, 120]);
  await expect(field(page, 'Height')).toHaveValue('280');
  expectNear(await pixel(page, 300, 150), GREY);

  // Undo all the way back to an ellipse.
  await page.keyboard.press('Control+z');
  await expect(field(page, 'Height')).toHaveValue('200');
  await page.keyboard.press('Control+z');
  await expect(page.getByRole('button', { name: 'Edit points' })).toHaveCount(0);
  await expect(layer(page, 'Ellipse 1')).toBeVisible();

  expect(errors).toEqual([]);
});

test('pencil: a hand-drawn stroke becomes a smooth path, and a loop becomes a shape', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await canvas(page).focus();
  await page.keyboard.press('Shift+P');
  await expect(page.getByRole('button', { name: 'Pencil', exact: true })).toHaveAttribute('aria-pressed', 'true');

  // A wave, drawn with sixty small moves of the pointer.
  const wave = Array.from({ length: 61 }, (_, i) => [200 + i * 5, Math.round(300 + Math.sin(i / 6) * 50)] as [number, number]);
  await strokeThrough(page, wave);
  await expect(layer(page, 'Vector 1')).toBeVisible();
  expect(Math.abs(Number(await field(page, 'Width').inputValue()) - 300)).toBeLessThan(2);
  // The pencil stays in hand.
  await expect(page.getByRole('button', { name: 'Pencil', exact: true })).toHaveAttribute('aria-pressed', 'true');

  // Make the line thick and red, so that it can be found in the pixels: it runs through the points that were drawn.
  await set(page, 'Stroke weight', '10');
  await set(page, 'Stroke 1 colour hex', 'FF0000');
  for (const i of [0, 12, 25, 38, 50, 60]) {
    const [x, y] = wave[i] as [number, number];
    expectNear(await pixel(page, x, y), [255, 0, 0]);
  }
  expectNear(await pixel(page, 350, 200), PAGE);
  expectNear(await pixel(page, 350, 400), PAGE);

  // A stroke that comes back to where it began is closed, so it can be filled.
  const loop = Array.from({ length: 88 }, (_, i) => {
    const angle = (i / 90) * Math.PI * 2;
    return [Math.round(350 + Math.cos(angle) * 60), Math.round(130 + Math.sin(angle) * 60)] as [number, number];
  });
  await strokeThrough(page, loop);
  await expect(layer(page, 'Vector 2')).toBeVisible();
  expectNear(await pixel(page, 350, 130), PAGE);
  await page.getByRole('button', { name: 'Add fill' }).click();
  expectNear(await pixel(page, 350, 130), GREY);
  expectNear(await pixel(page, 350, 50), PAGE);

  // Each stroke is one undo step.
  await canvas(page).focus();
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  await expect(layer(page, 'Vector 2')).toHaveCount(0);
  await expect(layer(page, 'Vector 1')).toBeVisible();

  expect(errors).toEqual([]);
});
