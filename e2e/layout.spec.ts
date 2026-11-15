import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Phase 2 layout: constraints (how children follow their frame when it is
 * resized) and layout grids. Constraints are checked through the properties
 * panel; layout grids are guides drawn over the design, so they are checked by
 * reading pixels from the overlay canvas.
 */

const canvas = (page: Page): Locator => page.getByRole('application', { name: 'Design canvas' });
const layers = (page: Page): Locator => page.getByRole('tree', { name: 'Layers' });
const layer = (page: Page, name: string): Locator => layers(page).getByRole('treeitem', { name, exact: true });
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

async function set(page: Page, label: string, value: string): Promise<void> {
  await field(page, label).fill(value);
  await field(page, label).press('Enter');
}

/** RGBA of one pixel of the overlay canvas (the second canvas), after the next repaint. */
async function overlayPixel(page: Page, x: number, y: number): Promise<[number, number, number, number]> {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  return page.evaluate(
    ([px, py]) => {
      const element = document.querySelectorAll('canvas')[1];
      const ctx = element?.getContext('2d');
      if (!element || !ctx) throw new Error('overlay canvas not found');
      const data = ctx.getImageData(px as number, py as number, 1, 1).data;
      return [data[0], data[1], data[2], data[3]] as [number, number, number, number];
    },
    [x, y],
  );
}

async function setUp(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'New design file' }).click();
  await expect(canvas(page)).toBeVisible();
  // A 400 × 300 frame with a 100 × 80 rectangle 50px in from its top-left corner.
  await page.keyboard.press('f');
  await drag(page, [100, 100], [500, 400]);
  await page.keyboard.press('r');
  await drag(page, [150, 150], [250, 230]);
  await expect(layer(page, 'Rectangle 1')).toHaveAttribute('aria-level', '2');
}

/** Sets the frame's size in the properties panel and returns to the rectangle. */
async function resizeFrame(page: Page, width: string, height?: string): Promise<void> {
  await layer(page, 'Frame 1').click();
  await set(page, 'Width', width);
  if (height !== undefined) await set(page, 'Height', height);
  await layer(page, 'Rectangle 1').click();
}

test('constraints: children follow their frame as it is resized', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await setUp(page);

  // By default a layer keeps to the left and top.
  await expect(select(page, 'Horizontal constraint')).toHaveValue('MIN');
  await expect(select(page, 'Vertical constraint')).toHaveValue('MIN');
  await resizeFrame(page, '500');
  await expect(field(page, 'X position')).toHaveValue('50');

  // Right: the distance to the right edge is kept.
  await select(page, 'Horizontal constraint').selectOption('MAX');
  await resizeFrame(page, '600');
  await expect(field(page, 'X position')).toHaveValue('150');
  await expect(field(page, 'Width')).toHaveValue('100');

  // Left and right: the layer stretches. Top and bottom at the same time.
  await select(page, 'Horizontal constraint').selectOption('STRETCH');
  await select(page, 'Vertical constraint').selectOption('STRETCH');
  await resizeFrame(page, '700', '400');
  await expect(field(page, 'X position')).toHaveValue('150');
  await expect(field(page, 'Width')).toHaveValue('200');
  await expect(field(page, 'Height')).toHaveValue('180');

  // Undo puts the frame and its child back together, in one step each.
  await canvas(page).focus();
  await page.keyboard.press('Control+z'); // height
  await page.keyboard.press('Control+z'); // width
  await layer(page, 'Rectangle 1').click();
  await expect(field(page, 'Width')).toHaveValue('100');
  await expect(field(page, 'Height')).toHaveValue('80');

  // Scale: position and size stay in proportion to the frame.
  await select(page, 'Horizontal constraint').selectOption('SCALE');
  await resizeFrame(page, '300');
  await expect(field(page, 'X position')).toHaveValue('75');
  await expect(field(page, 'Width')).toHaveValue('50');

  // Dragging the frame's edge on the canvas applies constraints too.
  await select(page, 'Horizontal constraint').selectOption('MAX');
  await layer(page, 'Frame 1').click();
  // The frame is 300 wide: its right edge is at x = 400 on the canvas. Drag it to 500.
  await drag(page, [400, 250], [500, 250]);
  await expect(field(page, 'Width')).toHaveValue('400');
  await layer(page, 'Rectangle 1').click();
  await expect(field(page, 'X position')).toHaveValue('175');

  // A layer that is not inside a frame has no constraints to set.
  await page.keyboard.press('Escape');
  await canvas(page).focus();
  await page.keyboard.press('o');
  await drag(page, [600, 500], [650, 550]);
  await expect(select(page, 'Horizontal constraint')).toHaveCount(0);

  // Constraints are stored with the layer.
  await expect(page.getByRole('status')).toHaveText('Saved');
  await page.reload();
  await layer(page, 'Rectangle 1').click();
  await expect(select(page, 'Horizontal constraint')).toHaveValue('MAX');
  await expect(select(page, 'Vertical constraint')).toHaveValue('STRETCH');
  expect(errors).toEqual([]);
});

test('layout grids: columns over a frame, shown, hidden and remembered', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await setUp(page);
  await layer(page, 'Frame 1').click();
  // Nothing is drawn over the frame yet (well inside it, away from the selection outline).
  expect((await overlayPixel(page, 130, 250))[3]).toBe(0);

  // Add a grid and make it five stretched columns with 20px gutters.
  await page.getByRole('button', { name: 'Add layout grid' }).click();
  await expect(select(page, 'Layout grid 1 type')).toHaveValue('GRID');
  await select(page, 'Layout grid 1 type').selectOption('COLUMNS');
  await expect(field(page, 'Layout grid 1 count')).toHaveValue('5');
  await expect(field(page, 'Layout grid 1 gutter')).toHaveValue('20');
  // (400 - 4×20) / 5 = 64: columns at 0-64, 84-148 and so on, measured from the frame's left edge at x = 100.
  const inColumn = await overlayPixel(page, 130, 250);
  expect(inColumn[0]).toBeGreaterThan(200);
  expect(inColumn[1]).toBeLessThan(40);
  expect(inColumn[3]).toBeGreaterThan(15);
  expect(inColumn[3]).toBeLessThan(40);
  expect((await overlayPixel(page, 174, 250))[3]).toBe(0); // in the first gutter
  expect((await overlayPixel(page, 200, 250))[3]).toBeGreaterThan(15); // in the second column

  // Solid blue, so it is unmistakable.
  await set(page, 'Layout grid 1 colour hex', '0000FF');
  await set(page, 'Layout grid 1 opacity', '100');
  expect(await overlayPixel(page, 130, 250)).toEqual([0, 0, 255, 255]);

  // Fewer, fixed-width columns aligned to the right.
  await set(page, 'Layout grid 1 count', '2');
  await select(page, 'Layout grid 1 alignment').selectOption('MAX');
  await set(page, 'Layout grid 1 column width', '50');
  await set(page, 'Layout grid 1 offset', '10');
  // The block is 2×50 + 20 = 120 wide and ends 10 from the right edge: columns at 270-320 and 340-390.
  expect((await overlayPixel(page, 130, 250))[3]).toBe(0);
  expect(await overlayPixel(page, 100 + 295, 250)).toEqual([0, 0, 255, 255]);
  expect((await overlayPixel(page, 100 + 330, 250))[3]).toBe(0);
  expect(await overlayPixel(page, 100 + 365, 250)).toEqual([0, 0, 255, 255]);

  // The grid is a guide, not part of the design: the design canvas under it is untouched.
  const design = await page.evaluate(() => {
    const ctx = document.querySelector('canvas')?.getContext('2d');
    const data = ctx?.getImageData(395, 250, 1, 1).data;
    return data ? [data[0], data[1], data[2]] : null;
  });
  expect(design).toEqual([255, 255, 255]);

  // Shift+G hides all layout grids and shows them again.
  await canvas(page).focus();
  await page.keyboard.press('Shift+G');
  expect((await overlayPixel(page, 100 + 295, 250))[3]).toBe(0);
  await page.keyboard.press('Shift+G');
  expect(await overlayPixel(page, 100 + 295, 250)).toEqual([0, 0, 255, 255]);

  // The eye hides just this grid.
  await page.getByRole('button', { name: 'Hide layout grid 1' }).click();
  expect((await overlayPixel(page, 100 + 295, 250))[3]).toBe(0);
  await page.getByRole('button', { name: 'Show layout grid 1' }).click();

  // The grid belongs to the frame and is stored with it.
  await expect(page.getByRole('status')).toHaveText('Saved');
  await page.reload();
  await expect(canvas(page)).toBeVisible();
  await expect.poll(() => overlayPixel(page, 100 + 295, 250)).toEqual([0, 0, 255, 255]);
  await layer(page, 'Frame 1').click();
  await expect(select(page, 'Layout grid 1 type')).toHaveValue('COLUMNS');
  await page.getByRole('button', { name: 'Remove layout grid 1' }).click();
  expect((await overlayPixel(page, 100 + 295, 250))[3]).toBe(0);
  expect(errors).toEqual([]);
});
