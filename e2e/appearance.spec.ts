import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Phase 2 appearance: gradients, stroke options, per-corner radii, shadows,
 * blurs and blend modes. Everything is set through the properties panel and
 * checked by reading real pixels back from the design canvas.
 */

type RGB = [number, number, number];

const PAGE: RGB = [30, 30, 30];
const GREY: RGB = [217, 217, 217];

const canvas = (page: Page): Locator => page.getByRole('application', { name: 'Design canvas' });
const field = (page: Page, label: string): Locator => page.getByRole('textbox', { name: label, exact: true });
const select = (page: Page, label: string): Locator => page.getByRole('combobox', { name: label, exact: true });

async function drag(page: Page, from: [number, number], to: [number, number]): Promise<void> {
  const box = await canvas(page).boundingBox();
  if (!box) throw new Error('canvas not visible');
  await page.mouse.move(box.x + from[0], box.y + from[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + to[0], box.y + to[1], { steps: 6 });
  await page.mouse.up();
}

async function drawRectangle(page: Page, from: [number, number], to: [number, number]): Promise<void> {
  await canvas(page).focus();
  await page.keyboard.press('r');
  await drag(page, from, to);
}

async function set(page: Page, label: string, value: string): Promise<void> {
  await field(page, label).fill(value);
  await field(page, label).press('Enter');
}

/** RGB of one pixel of the design canvas, after the next repaint. */
async function pixel(page: Page, x: number, y: number): Promise<RGB> {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  return page.evaluate(
    ([px, py]) => {
      const element = document.querySelector('canvas');
      const ctx = element?.getContext('2d');
      if (!element || !ctx) throw new Error('design canvas not found');
      const ratio = element.width / element.clientWidth;
      const data = ctx.getImageData(Math.round((px as number) * ratio), Math.round((py as number) * ratio), 1, 1).data;
      return [data[0], data[1], data[2]] as [number, number, number];
    },
    [x, y],
  );
}

function expectNear(actual: RGB, expected: RGB, tolerance = 8): void {
  const ok = actual.every((channel, i) => Math.abs(channel - (expected[i] as number)) <= tolerance);
  expect(ok, `expected about rgb(${expected.join(', ')}), got rgb(${actual.join(', ')})`).toBe(true);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New design file' }).click();
  await expect(canvas(page)).toBeVisible();
});

test('gradient fills: linear, radial, angular and diamond', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await drawRectangle(page, [100, 100], [300, 200]);
  expectNear(await pixel(page, 200, 150), GREY, 1);

  // Solid → linear: starts as a fade of the same colour, top to bottom.
  await select(page, 'Fill 1 type').selectOption('GRADIENT_LINEAR');
  await expect(field(page, 'Fill 1 angle')).toHaveValue('90');
  expectNear(await pixel(page, 200, 102), GREY, 6);
  expectNear(await pixel(page, 200, 198), PAGE, 6);

  // Red to blue, left to right.
  await set(page, 'Fill 1 angle', '0');
  await set(page, 'Fill 1 stop 1 colour hex', 'FF0000');
  await set(page, 'Fill 1 stop 2 colour hex', '0000FF');
  await set(page, 'Fill 1 stop 2 opacity', '100');
  expectNear(await pixel(page, 102, 150), [252, 0, 3]);
  expectNear(await pixel(page, 200, 150), [128, 0, 128]);
  expectNear(await pixel(page, 298, 150), [3, 0, 252]);
  // The same along the whole height: the bands are vertical.
  expectNear(await pixel(page, 200, 105), [128, 0, 128]);

  // A third stop in the middle.
  await page.getByRole('button', { name: 'Add stop to Fill 1' }).click();
  await expect(field(page, 'Fill 1 stop 2 position')).toHaveValue('50');
  await set(page, 'Fill 1 stop 2 colour hex', '00FF00');
  expectNear(await pixel(page, 200, 150), [0, 255, 0]);
  await page.getByRole('button', { name: 'Remove Fill 1 stop 2', exact: true }).click();
  expectNear(await pixel(page, 200, 150), [128, 0, 128]);

  // Radial: the first stop at the centre, the last at the edge, stretched to the box.
  await select(page, 'Fill 1 type').selectOption('GRADIENT_RADIAL');
  expectNear(await pixel(page, 200, 150), [255, 0, 0], 10);
  expectNear(await pixel(page, 298, 150), [0, 0, 255], 12);
  // 2.5px inside the top edge is 95% of the way out along the short axis.
  expectNear(await pixel(page, 200, 102), [13, 0, 242], 6);
  expectNear(await pixel(page, 250, 150), [128, 0, 128], 10);

  // Angular: sweeps round the centre, starting to the right.
  await select(page, 'Fill 1 type').selectOption('GRADIENT_ANGULAR');
  expectNear(await pixel(page, 200, 198), [191, 0, 64], 14); // a quarter of the way round
  expectNear(await pixel(page, 102, 150), [128, 0, 128], 14); // half way round

  // Diamond: the colour depends on the distance measured along the two axes.
  await select(page, 'Fill 1 type').selectOption('GRADIENT_DIAMOND');
  expectNear(await pixel(page, 200, 150), [255, 0, 0], 10);
  expectNear(await pixel(page, 250, 150), [128, 0, 128], 10);
  expectNear(await pixel(page, 250, 175), [0, 0, 255], 12); // half-way on both axes adds up to the edge

  // Back to solid keeps the first colour; undo returns the gradient.
  await select(page, 'Fill 1 type').selectOption('SOLID');
  expectNear(await pixel(page, 250, 150), [255, 0, 0], 1);
  await canvas(page).focus();
  await page.keyboard.press('Control+z');
  await expect(select(page, 'Fill 1 type')).toHaveValue('GRADIENT_DIAMOND');

  // It is all stored: a reload shows the same gradient.
  await expect(page.getByRole('status')).toHaveText('Saved');
  await page.reload();
  await page.getByRole('tree', { name: 'Layers' }).getByRole('treeitem', { name: 'Rectangle 1', exact: true }).click();
  await expect(select(page, 'Fill 1 type')).toHaveValue('GRADIENT_DIAMOND');
  expectNear(await pixel(page, 250, 150), [128, 0, 128], 10);
  expect(errors).toEqual([]);
});

test('stroke dashes, caps and position, and per-corner radii', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await drawRectangle(page, [100, 100], [300, 200]);

  // A 6px red stroke inside the outline, dashed 20 on / 20 off, starting at the top-left corner.
  await page.getByRole('button', { name: 'Add stroke' }).click();
  await set(page, 'Stroke 1 colour hex', 'FF0000');
  await set(page, 'Stroke weight', '6');
  expectNear(await pixel(page, 130, 103), [255, 0, 0], 1);
  await set(page, 'Dash length', '20');
  await expect(field(page, 'Dash gap')).toHaveValue('20');
  expectNear(await pixel(page, 110, 103), [255, 0, 0], 1); // in the first dash
  expectNear(await pixel(page, 130, 103), GREY, 1); // in the first gap
  expectNear(await pixel(page, 150, 103), [255, 0, 0], 1); // in the second dash

  // A different gap changes the rhythm.
  await set(page, 'Dash gap', '60');
  expectNear(await pixel(page, 150, 103), GREY, 1);
  expectNear(await pixel(page, 190, 103), [255, 0, 0], 1);

  // No dashes again.
  await set(page, 'Dash length', '0');
  expectNear(await pixel(page, 150, 103), [255, 0, 0], 1);

  // Outside the outline instead of inside.
  await select(page, 'Stroke position').selectOption('OUTSIDE');
  expectNear(await pixel(page, 150, 103), GREY, 1);
  expectNear(await pixel(page, 150, 97), [255, 0, 0], 1);
  await select(page, 'Stroke position').selectOption('INSIDE');
  await page.getByRole('button', { name: 'Remove stroke 1' }).click();

  // One rounded corner: top-left only.
  await page.getByRole('button', { name: 'Separate corner radii' }).click();
  await set(page, 'Top left radius', '50');
  expectNear(await pixel(page, 104, 104), PAGE, 1);
  expectNear(await pixel(page, 296, 104), GREY, 1);
  expectNear(await pixel(page, 104, 196), GREY, 1);
  expectNear(await pixel(page, 296, 196), GREY, 1);
  await set(page, 'Bottom right radius', '50');
  expectNear(await pixel(page, 296, 196), PAGE, 1);

  // Back to one radius for all: the largest of the four.
  await page.getByRole('button', { name: 'Separate corner radii' }).click();
  await expect(field(page, 'Corner radius')).toHaveValue('50');
  expectNear(await pixel(page, 296, 104), PAGE, 1);

  // Round line ends reach past the end of the line; flat ends do not.
  await canvas(page).focus();
  await page.keyboard.press('l');
  await drag(page, [100, 300], [300, 300]);
  await set(page, 'Stroke 1 colour hex', 'FFFFFF');
  await set(page, 'Stroke weight', '20');
  expectNear(await pixel(page, 200, 300), [255, 255, 255], 1);
  expectNear(await pixel(page, 95, 300), PAGE, 1);
  await select(page, 'Stroke ends').selectOption('ROUND');
  expectNear(await pixel(page, 95, 300), [255, 255, 255], 1);
  expect(errors).toEqual([]);
});

test('effects: drop shadow, inner shadow, layer blur and background blur', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await drawRectangle(page, [100, 100], [200, 200]);
  expectNear(await pixel(page, 210, 210), PAGE, 1);

  // A hard black drop shadow, 20px down and right.
  await page.getByRole('button', { name: 'Add effect' }).click();
  await expect(select(page, 'Effect 1 type')).toHaveValue('DROP_SHADOW');
  await set(page, 'Effect 1 X offset', '20');
  await set(page, 'Effect 1 Y offset', '20');
  await set(page, 'Effect 1 blur', '0');
  await set(page, 'Effect 1 opacity', '100');
  expectNear(await pixel(page, 210, 210), [0, 0, 0], 1);
  expectNear(await pixel(page, 150, 150), GREY, 1); // the layer itself is on top of its shadow
  expectNear(await pixel(page, 230, 230), PAGE, 1);

  // Spread grows the shadow.
  await set(page, 'Effect 1 spread', '15');
  expectNear(await pixel(page, 230, 230), [0, 0, 0], 1);
  await set(page, 'Effect 1 spread', '0');

  // Blur softens its edge: just outside the hard edge is now partly dark.
  await set(page, 'Effect 1 blur', '20');
  const soft = await pixel(page, 224, 160);
  expect(soft[0]).toBeLessThan(30);
  expect(soft[0]).toBeGreaterThan(0);

  // Coloured, and hidden with the eye button.
  await set(page, 'Effect 1 blur', '0');
  await set(page, 'Effect 1 colour hex', '00FF00');
  expectNear(await pixel(page, 210, 210), [0, 255, 0], 1);
  await page.getByRole('button', { name: 'Hide effect 1' }).click();
  expectNear(await pixel(page, 210, 210), PAGE, 1);
  await page.getByRole('button', { name: 'Show effect 1' }).click();

  // Inner shadow: the same offsets now darken the inside of the top and left edges.
  await select(page, 'Effect 1 type').selectOption('INNER_SHADOW');
  expectNear(await pixel(page, 210, 210), PAGE, 1);
  expectNear(await pixel(page, 110, 150), [0, 255, 0], 1);
  expectNear(await pixel(page, 150, 110), [0, 255, 0], 1);
  expectNear(await pixel(page, 160, 160), GREY, 1);

  // Layer blur: the layer bleeds past its outline and its edge is no longer crisp.
  await select(page, 'Effect 1 type').selectOption('LAYER_BLUR');
  await set(page, 'Effect 1 radius', '10');
  const outside = await pixel(page, 96, 150);
  expect(outside[0]).toBeGreaterThan(PAGE[0] + 15);
  const inside = await pixel(page, 104, 150);
  expect(inside[0]).toBeLessThan(GREY[0] - 15);
  expectNear(await pixel(page, 150, 150), GREY, 3);
  await page.getByRole('button', { name: 'Remove effect 1' }).click();
  expectNear(await pixel(page, 96, 150), PAGE, 1);

  // Background blur: an empty layer over the first one's edge blurs what is behind it.
  await drawRectangle(page, [180, 120], [260, 180]);
  await page.getByRole('button', { name: 'Remove fill 1' }).click();
  expectNear(await pixel(page, 205, 150), PAGE, 1);
  await page.getByRole('button', { name: 'Add effect' }).click();
  await select(page, 'Effect 1 type').selectOption('BACKGROUND_BLUR');
  await set(page, 'Effect 1 radius', '10');
  const blurred = await pixel(page, 205, 150);
  expect(blurred[0]).toBeGreaterThan(PAGE[0] + 15);
  // Outside the blurring layer nothing changes.
  expectNear(await pixel(page, 205, 110), PAGE, 1);
  expect(errors).toEqual([]);
});

test('blend modes and layer opacity', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await drawRectangle(page, [100, 100], [200, 200]);
  await set(page, 'Fill 1 colour hex', 'FF0000');
  await drawRectangle(page, [150, 150], [250, 250]);
  await set(page, 'Fill 1 colour hex', '00FFFF');
  expectNear(await pixel(page, 175, 175), [0, 255, 255], 1);

  // Multiply: cyan over red is black; cyan over the dark page keeps only the page's green and blue.
  await select(page, 'Blend mode').selectOption('MULTIPLY');
  expectNear(await pixel(page, 175, 175), [0, 0, 0], 2);
  expectNear(await pixel(page, 225, 225), [0, 30, 30], 3);
  expectNear(await pixel(page, 125, 125), [255, 0, 0], 1);

  // Screen: cyan over red is white.
  await select(page, 'Blend mode').selectOption('SCREEN');
  expectNear(await pixel(page, 175, 175), [255, 255, 255], 2);

  // Difference.
  await select(page, 'Blend mode').selectOption('DIFFERENCE');
  expectNear(await pixel(page, 175, 175), [255, 255, 255], 2);
  expectNear(await pixel(page, 225, 225), [30, 225, 225], 3);

  // Normal again, at half opacity: an even mix of the two.
  await select(page, 'Blend mode').selectOption('NORMAL');
  await set(page, 'Layer opacity', '50');
  expectNear(await pixel(page, 175, 175), [128, 128, 128], 3);

  // A stroke and a fill at half opacity are faded together, not one through the other.
  await page.getByRole('button', { name: 'Add stroke' }).click();
  await set(page, 'Stroke 1 colour hex', '00FFFF');
  await set(page, 'Stroke weight', '10');
  expectNear(await pixel(page, 154, 175), [128, 128, 128], 3);

  await page.screenshot({ path: 'test-results/phase2-appearance.png' });
  expect(errors).toEqual([]);
});
