import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Checks that what is painted on the canvas is what the document says: the
 * test reads real pixels back from the design canvas after drawing with the
 * real tools.
 */

const overlay = (page: Page): Locator => page.getByRole('application', { name: 'Design canvas' });

async function drag(page: Page, from: [number, number], to: [number, number]): Promise<void> {
  const box = await overlay(page).boundingBox();
  if (!box) throw new Error('canvas not visible');
  await page.mouse.move(box.x + from[0], box.y + from[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + to[0], box.y + to[1], { steps: 6 });
  await page.mouse.up();
}

/** RGB of one pixel of the design canvas (the first canvas; the second is the overlay). */
async function pixel(page: Page, x: number, y: number): Promise<[number, number, number]> {
  // Let the next animation frame paint before reading.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  return page.evaluate(
    ([px, py]) => {
      const canvas = document.querySelector('canvas');
      const ctx = canvas?.getContext('2d');
      if (!canvas || !ctx) throw new Error('design canvas not found');
      const ratio = canvas.width / canvas.clientWidth;
      const data = ctx.getImageData(Math.round((px as number) * ratio), Math.round((py as number) * ratio), 1, 1).data;
      return [data[0], data[1], data[2]] as [number, number, number];
    },
    [x, y],
  );
}

const PAGE_BACKGROUND: [number, number, number] = [30, 30, 30];
const FRAME_FILL: [number, number, number] = [255, 255, 255];
const SHAPE_FILL: [number, number, number] = [217, 217, 217];

test('the canvas paints frames, shapes, clipping, strokes and hidden layers correctly', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New design file' }).click();
  await expect(overlay(page)).toBeVisible();

  expect(await pixel(page, 300, 300)).toEqual(PAGE_BACKGROUND);

  // A white frame.
  await page.keyboard.press('f');
  await drag(page, [100, 100], [500, 400]);
  expect(await pixel(page, 300, 250)).toEqual(FRAME_FILL);
  expect(await pixel(page, 60, 60)).toEqual(PAGE_BACKGROUND);

  // A grey rectangle that starts inside the frame and extends past its right edge.
  await page.keyboard.press('r');
  await drag(page, [400, 150], [600, 250]);
  expect(await pixel(page, 450, 200)).toEqual(SHAPE_FILL);
  // The frame clips its content: beyond the frame edge the page shows through.
  expect(await pixel(page, 550, 200)).toEqual(PAGE_BACKGROUND);

  // Turning clipping off reveals the rest of the rectangle.
  await page.getByRole('tree', { name: 'Layers' }).getByRole('treeitem', { name: 'Frame 1', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Clip content' }).uncheck();
  expect(await pixel(page, 550, 200)).toEqual(SHAPE_FILL);

  // An ellipse is painted as an ellipse: its bounding-box corner stays empty.
  await page.keyboard.press('o');
  await drag(page, [150, 280], [250, 380]);
  expect(await pixel(page, 200, 330)).toEqual(SHAPE_FILL);
  expect(await pixel(page, 153, 283)).toEqual(FRAME_FILL);

  // A stroke added in the properties panel is painted in the chosen colour, inside the shape.
  await page.getByRole('button', { name: 'Add stroke' }).click();
  await page.getByRole('textbox', { name: 'Stroke 1 colour hex' }).fill('FF0000');
  await page.getByRole('textbox', { name: 'Stroke 1 colour hex' }).press('Enter');
  await page.getByRole('textbox', { name: 'Stroke weight' }).fill('6');
  await page.getByRole('textbox', { name: 'Stroke weight' }).press('Enter');
  expect(await pixel(page, 200, 283)).toEqual([255, 0, 0]);
  expect(await pixel(page, 200, 330)).toEqual(SHAPE_FILL);

  // Changing the fill colour repaints the shape.
  await page.getByRole('textbox', { name: 'Fill 1 colour hex' }).fill('#0066FF');
  await page.getByRole('textbox', { name: 'Fill 1 colour hex' }).press('Enter');
  expect(await pixel(page, 200, 330)).toEqual([0, 102, 255]);

  // Hiding a layer removes it from the canvas; undo brings it back.
  await page.keyboard.press('Escape');
  await overlay(page).focus();
  const ellipse = page.getByRole('tree', { name: 'Layers' }).getByRole('treeitem', { name: 'Ellipse 1', exact: true });
  await ellipse.hover();
  await page.getByRole('button', { name: 'Hide Ellipse 1' }).click();
  expect(await pixel(page, 200, 330)).toEqual(FRAME_FILL);
  await overlay(page).focus();
  await page.keyboard.press('Control+z');
  expect(await pixel(page, 200, 330)).toEqual([0, 102, 255]);

  await page.screenshot({ path: 'test-results/phase1-editor.png' });
});
