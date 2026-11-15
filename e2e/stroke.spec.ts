import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Phase 3 "Outline stroke" in the real browser: the stroke of a shape becomes
 * a filled vector that looks exactly as the stroke did.
 */

type RGB = [number, number, number];

const PAGE: RGB = [30, 30, 30];
const GREY: RGB = [217, 217, 217];
const RED: RGB = [255, 0, 0];

const canvas = (page: Page): Locator => page.getByRole('application', { name: 'Design canvas' });
const field = (page: Page, label: string): Locator => page.getByRole('textbox', { name: label, exact: true });
const layers = (page: Page): Locator => page.getByRole('tree', { name: 'Layers' });
const layer = (page: Page, name: string): Locator => layers(page).getByRole('treeitem', { name, exact: true });

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

test('outline stroke: a thick dashed stroke becomes a shape that looks the same', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'New design file' }).click();
  await expect(canvas(page)).toBeVisible();
  await canvas(page).focus();

  // A circle of radius 100 about (300, 300) with a red stroke 20 wide, centred on its edge.
  await page.keyboard.press('o');
  await drag(page, [200, 200], [400, 400]);
  await page.getByRole('button', { name: 'Add stroke' }).click();
  await set(page, 'Stroke weight', '20');
  await set(page, 'Stroke 1 colour hex', 'FF0000');
  await page.getByRole('combobox', { name: 'Stroke position', exact: true }).selectOption('CENTER');

  // On the band at the top and on a diagonal; inside it, where the fill is; outside it.
  const probes: [[number, number], RGB][] = [
    [[300, 200], RED],
    [[300, 193], RED],
    [[300, 207], RED],
    [[229, 229], RED],
    [[400, 300], RED],
    [[300, 216], GREY],
    [[300, 300], GREY],
    [[300, 186], PAGE],
    [[212, 212], PAGE],
  ];
  for (const [[x, y], colour] of probes) expectNear(await pixel(page, x, y), colour);

  // Outline it: the fill stays in the ellipse, and the stroke is a vector of its own above it.
  await canvas(page).focus();
  await page.keyboard.press('Control+Shift+o');
  await expect(layer(page, 'Ellipse 1 stroke')).toBeVisible();
  await expect(layers(page).getByRole('treeitem')).toHaveCount(2);
  for (const [[x, y], colour] of probes) expectNear(await pixel(page, x, y), colour);

  // The new layer is selected: what was the stroke's colour is now its fill, it has no stroke, and its points can be edited.
  await expect(field(page, 'Fill 1 colour hex')).toHaveValue('FF0000');
  await expect(page.getByRole('button', { name: 'Remove stroke 1' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Edit points' })).toBeVisible();
  // (Its curves are fitted to within a twentieth of a pixel of the stroke's true edge.)
  expect(Math.abs(Number(await field(page, 'Width').inputValue()) - 220)).toBeLessThan(0.3);
  // And the ellipse has lost its stroke.
  await layer(page, 'Ellipse 1').click();
  await expect(page.getByRole('button', { name: 'Remove stroke 1' })).toHaveCount(0);
  await expect(field(page, 'Fill 1 colour hex')).toHaveValue('D9D9D9');

  // One undo step puts it all back.
  await canvas(page).focus();
  await page.keyboard.press('Control+z');
  await expect(layers(page).getByRole('treeitem')).toHaveCount(1);
  for (const [[x, y], colour] of probes) expectNear(await pixel(page, x, y), colour);

  // With dashes: the gaps stay gaps.
  await layer(page, 'Ellipse 1').click();
  await set(page, 'Dash length', '40');
  await set(page, 'Dash gap', '40');
  const row: RGB[] = [];
  for (let x = 205; x < 400; x += 10) row.push(await pixel(page, x, 300 - Math.round(Math.sqrt(100 * 100 - (x - 300) * (x - 300)))));
  await canvas(page).focus();
  await page.keyboard.press('Control+Shift+o');
  await expect(layer(page, 'Ellipse 1 stroke')).toBeVisible();
  const after: RGB[] = [];
  for (let x = 205; x < 400; x += 10) after.push(await pixel(page, x, 300 - Math.round(Math.sqrt(100 * 100 - (x - 300) * (x - 300)))));
  // Along the top of the circle there are both dashes and gaps, and they are where they were.
  expect(row.some((colour) => colour[0] > 240 && colour[1] < 20)).toBe(true);
  expect(row.some((colour) => colour[0] < 240)).toBe(true);
  let different = 0;
  row.forEach((colour, i) => {
    if (Math.abs(colour[0] - (after[i] as RGB)[0]) > 40) different++;
  });
  expect(different).toBeLessThanOrEqual(1);

  expect(errors).toEqual([]);
});
