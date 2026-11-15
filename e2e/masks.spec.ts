import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Phase 2 masks in the real browser: a layer used as a mask shows the layers
 * above it only where it would have painted, checked on the canvas's pixels.
 */

type RGB = [number, number, number];

const PAGE: RGB = [30, 30, 30];
const GREY: RGB = [217, 217, 217];
const RED: RGB = [255, 0, 0];

const canvas = (page: Page): Locator => page.getByRole('application', { name: 'Design canvas' });
const field = (page: Page, label: string): Locator => page.getByRole('textbox', { name: label, exact: true });
const layers = (page: Page): Locator => page.getByRole('tree', { name: 'Layers' });
const layer = (page: Page, name: string): Locator => layers(page).getByRole('treeitem', { name, exact: true });
const maskBox = (page: Page): Locator => page.getByRole('checkbox', { name: 'Mask the layers above' });

async function drag(page: Page, from: [number, number], to: [number, number]): Promise<void> {
  const box = await canvas(page).boundingBox();
  if (!box) throw new Error('canvas not visible');
  await page.mouse.move(box.x + from[0], box.y + from[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + to[0], box.y + to[1], { steps: 6 });
  await page.mouse.up();
}

async function set(page: Page, label: string, value: string): Promise<void> {
  await field(page, label).fill(value);
  await field(page, label).press('Enter');
}

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

test('masks: a circle masks the rectangle above it', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'New design file' }).click();
  await expect(canvas(page)).toBeVisible();
  await canvas(page).focus();

  // A red circle of radius 100 about (300, 300), and over its lower right part a grey square.
  await page.keyboard.press('o');
  await drag(page, [200, 200], [400, 400]);
  await set(page, 'Fill 1 colour hex', 'FF0000');
  await canvas(page).focus();
  await page.keyboard.press('r');
  await drag(page, [300, 300], [500, 500]);

  const circleOnly: [number, number] = [250, 250];
  const both: [number, number] = [340, 340];
  const squareOnly: [number, number] = [450, 450];
  expectNear(await pixel(page, ...circleOnly), RED);
  expectNear(await pixel(page, ...both), GREY);
  expectNear(await pixel(page, ...squareOnly), GREY);

  // Make the circle a mask: the square shows only inside it, and the circle itself is not painted.
  await layer(page, 'Ellipse 1').click();
  await maskBox(page).check();
  expectNear(await pixel(page, ...both), GREY);
  expectNear(await pixel(page, ...squareOnly), PAGE);
  expectNear(await pixel(page, ...circleOnly), PAGE);

  // A mask that is half see-through lets half of the square through.
  await set(page, 'Fill 1 opacity', '50');
  expectNear(await pixel(page, ...both), [124, 124, 124], 6);
  await set(page, 'Fill 1 opacity', '100');

  // Clicking the part of the square the mask hides selects nothing; clicking the part it shows selects the square.
  const box = await canvas(page).boundingBox();
  if (!box) throw new Error('canvas not visible');
  await page.mouse.click(box.x + 450, box.y + 450);
  await expect(field(page, 'Width')).toHaveCount(0);
  await page.mouse.click(box.x + 340, box.y + 340);
  await expect(page.getByText('Rectangle', { exact: true })).toBeVisible();

  // Hiding the mask shows the square whole again; it is the mask that is saved, so a reload keeps it.
  await layer(page, 'Ellipse 1').click();
  await expect(maskBox(page)).toBeChecked();
  await expect(page.getByRole('status')).toHaveText('Saved');
  await page.reload();
  await expect(canvas(page)).toBeVisible();
  await expect.poll(() => pixel(page, ...both)).toEqual(GREY);
  expectNear(await pixel(page, ...squareOnly), PAGE);

  // Switched off, both are ordinary layers again.
  await layer(page, 'Ellipse 1').click();
  await maskBox(page).uncheck();
  expectNear(await pixel(page, ...circleOnly), RED);
  expectNear(await pixel(page, ...squareOnly), GREY);
  await canvas(page).focus();
  await page.keyboard.press('Control+z');
  expectNear(await pixel(page, ...squareOnly), PAGE);

  expect(errors).toEqual([]);
});
