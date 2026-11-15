import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Phase 3 arcs and arrowheads in the real browser, set through the
 * properties panel and checked on the design canvas's pixels.
 */

type RGB = [number, number, number];

const PAGE: RGB = [30, 30, 30];
const GREY: RGB = [217, 217, 217];
const RED: RGB = [255, 0, 0];

const canvas = (page: Page): Locator => page.getByRole('application', { name: 'Design canvas' });
const field = (page: Page, label: string): Locator => page.getByRole('textbox', { name: label, exact: true });
const select = (page: Page, label: string): Locator => page.getByRole('combobox', { name: label, exact: true });
const layer = (page: Page, name: string): Locator => page.getByRole('tree', { name: 'Layers' }).getByRole('treeitem', { name, exact: true });

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

test('arcs: an ellipse becomes a slice, a piece of a ring and a ring', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await canvas(page).focus();
  // A circle of radius 100 about (300, 300).
  await page.keyboard.press('o');
  await drag(page, [200, 200], [400, 400]);
  await expect(field(page, 'Arc sweep')).toHaveValue('360');
  const above: [number, number] = [300, 230];
  const below: [number, number] = [300, 370];
  const left: [number, number] = [230, 300];
  const right: [number, number] = [370, 300];
  for (const [x, y] of [above, below, left, right, [300, 300] as [number, number]]) expectNear(await pixel(page, x, y), GREY);

  // Half a turn from three o'clock, clockwise: the lower half.
  await set(page, 'Arc sweep', '180');
  expectNear(await pixel(page, ...below), GREY);
  expectNear(await pixel(page, ...above), PAGE);
  expectNear(await pixel(page, 250, 330), GREY);
  // The layer's box is still the whole circle's.
  await expect(field(page, 'Width')).toHaveValue('200');
  await expect(field(page, 'Height')).toHaveValue('200');

  // Starting at six o'clock instead: the left half.
  await set(page, 'Arc start', '90');
  expectNear(await pixel(page, ...left), GREY);
  expectNear(await pixel(page, ...right), PAGE);

  // An inner radius of half the outer one cuts the middle out.
  await set(page, 'Arc ratio', '50');
  expectNear(await pixel(page, 270, 300), PAGE);
  expectNear(await pixel(page, ...left), GREY);
  expectNear(await pixel(page, ...right), PAGE);

  // All the way round again: a ring.
  await set(page, 'Arc sweep', '360');
  for (const [x, y] of [above, below, left, right]) expectNear(await pixel(page, x, y), GREY);
  expectNear(await pixel(page, 300, 300), PAGE);

  // Clicking the hole does not select the ring; clicking the ring does.
  const box = await canvas(page).boundingBox();
  if (!box) throw new Error('canvas not visible');
  await page.mouse.click(box.x + 600, box.y + 500);
  await expect(field(page, 'Arc sweep')).toHaveCount(0);
  await page.mouse.click(box.x + 300, box.y + 300);
  await expect(field(page, 'Arc sweep')).toHaveCount(0);
  await page.mouse.click(box.x + 300, box.y + 230);
  await expect(field(page, 'Arc ratio')).toHaveValue('50');

  // Undo steps back through the changes, and a reload keeps the ring.
  await canvas(page).focus();
  await page.keyboard.press('Control+z');
  await expect(field(page, 'Arc sweep')).toHaveValue('180');
  await page.keyboard.press('Control+Shift+z');
  await expect(page.getByRole('status')).toHaveText('Saved');
  await page.reload();
  await expect(canvas(page)).toBeVisible();
  await expect.poll(() => pixel(page, 300, 230)).toEqual(GREY);
  expectNear(await pixel(page, 300, 300), PAGE);

  expect(errors).toEqual([]);
});

test('arrowheads: a line gets a triangle at one end and a dot at the other', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await canvas(page).focus();
  await page.keyboard.press('l');
  await drag(page, [200, 300], [500, 300]);
  await expect(layer(page, 'Line 1')).toBeVisible();
  await set(page, 'Stroke weight', '4');
  await set(page, 'Stroke 1 colour hex', 'FF0000');
  expectNear(await pixel(page, 350, 300), RED);

  // Beside the line near its ends there is nothing yet.
  const besideEnd: [number, number] = [488, 303];
  const besideStart: [number, number] = [200, 306];
  expectNear(await pixel(page, ...besideEnd), PAGE);
  expectNear(await pixel(page, ...besideStart), PAGE);

  // A triangle at the end: 15 long for this weight, with its tip on the end point.
  await select(page, 'End arrow').selectOption('TRIANGLE');
  expectNear(await pixel(page, ...besideEnd), RED);
  expectNear(await pixel(page, 497, 300), RED);
  // The head does not reach beyond the end of the line, or far up its shaft.
  expectNear(await pixel(page, 503, 300), PAGE);
  expectNear(await pixel(page, 480, 305), PAGE);

  // A dot at the start, 8 in radius.
  await select(page, 'Start arrow').selectOption('CIRCLE');
  expectNear(await pixel(page, ...besideStart), RED);
  expectNear(await pixel(page, 194, 300), RED);
  expectNear(await pixel(page, 200, 312), PAGE);

  // Undo takes the dot away again; the triangle stays.
  await canvas(page).focus();
  await page.keyboard.press('Control+z');
  await expect(select(page, 'Start arrow')).toHaveValue('NONE');
  expectNear(await pixel(page, ...besideStart), PAGE);
  expectNear(await pixel(page, ...besideEnd), RED);

  // Flattened to a vector, the path keeps its arrowhead.
  await page.keyboard.press('Control+e');
  await expect(page.getByRole('button', { name: 'Edit points' })).toBeVisible();
  await expect(select(page, 'End arrow')).toHaveValue('TRIANGLE');
  expectNear(await pixel(page, ...besideEnd), RED);

  expect(errors).toEqual([]);
});

test('arcs: shaped by dragging the handles on the canvas', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await canvas(page).focus();
  // A circle of radius 100 about (300, 300). Drawn, it is selected, and its arc handle is at three o'clock.
  await page.keyboard.press('o');
  await drag(page, [200, 200], [400, 400]);
  const overlay = async (x: number, y: number): Promise<RGB> => {
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    return page.evaluate(
      ([px, py]) => {
        const data = (document.querySelectorAll('canvas')[1] as HTMLCanvasElement).getContext('2d')!.getImageData(px as number, py as number, 1, 1).data;
        return [data[0], data[1], data[2]] as [number, number, number];
      },
      [x, y],
    );
  };
  expectNear(await overlay(375, 300), [255, 255, 255]);

  // Drag it round to six o'clock: a quarter of the circle is left.
  await drag(page, [375, 300], [300, 375]);
  await expect(field(page, 'Arc sweep')).toHaveValue('90');
  expectNear(await pixel(page, 350, 350), GREY);
  expectNear(await pixel(page, 250, 250), PAGE);
  expectNear(await pixel(page, 350, 250), PAGE);
  // The handle went with the end of the arc, and there is now one for the start and one in the middle for the hole.
  expectNear(await overlay(300, 375), [255, 255, 255]);
  expectNear(await overlay(300, 300), [255, 255, 255]);

  // Drag the middle handle out: a hole, half the size of the circle.
  await drag(page, [300, 300], [335, 335]);
  await expect(field(page, 'Arc ratio')).toHaveValue('49');
  expectNear(await pixel(page, 320, 320), PAGE);
  expectNear(await pixel(page, 360, 360), GREY);

  // Undo steps back through the drags.
  await canvas(page).focus();
  await page.keyboard.press('Control+z');
  await expect(field(page, 'Arc ratio')).toHaveValue('0');
  await page.keyboard.press('Control+z');
  await expect(field(page, 'Arc sweep')).toHaveValue('360');

  expect(errors).toEqual([]);
});
