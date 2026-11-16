import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Phase 5, styles and variables, in the real browser. What a style or a
 * variable gives a layer is read from the pixels of the design canvas.
 */

const canvas = (page: Page): Locator => page.getByRole('application', { name: 'Design canvas' });
const layers = (page: Page): Locator => page.getByRole('tree', { name: 'Layers' });
const layer = (page: Page, name: string): Locator => layers(page).getByRole('treeitem', { name, exact: true });
const field = (page: Page, label: string): Locator => page.getByRole('textbox', { name: label, exact: true });
const select = (page: Page, label: string): Locator => page.getByRole('combobox', { name: label, exact: true });
const button = (page: Page, name: string): Locator => page.getByRole('button', { name, exact: true });
const section = (page: Page, name: string): Locator => page.getByRole('region', { name, exact: true });

async function drag(page: Page, from: [number, number], to: [number, number]): Promise<void> {
  const box = await canvas(page).boundingBox();
  if (!box) throw new Error('canvas not visible');
  await page.mouse.move(box.x + from[0], box.y + from[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + to[0], box.y + to[1], { steps: 8 });
  await page.mouse.up();
}

async function click(page: Page, at: [number, number]): Promise<void> {
  const box = await canvas(page).boundingBox();
  if (!box) throw new Error('canvas not visible');
  await page.mouse.click(box.x + at[0], box.y + at[1]);
}

async function set(page: Page, label: string, value: string): Promise<void> {
  await field(page, label).fill(value);
  await field(page, label).press('Enter');
}

async function pixel(page: Page, x: number, y: number): Promise<[number, number, number]> {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  return page.evaluate(
    ([px, py]) => {
      const element = document.querySelector('canvas');
      const ctx = element?.getContext('2d');
      if (!element || !ctx) throw new Error('design canvas not found');
      const data = ctx.getImageData(Math.round(px as number), Math.round(py as number), 1, 1).data;
      return [data[0], data[1], data[2]] as [number, number, number];
    },
    [x, y],
  );
}

const RED: [number, number, number] = [255, 0, 0];
const GREEN: [number, number, number] = [0, 255, 0];
const BLUE: [number, number, number] = [0, 0, 255];
const BLACK: [number, number, number] = [0, 0, 0];
const PINK: [number, number, number] = [255, 0, 255];

const first: [number, number] = [150, 140];
const second: [number, number] = [350, 140];
const nowhere: [number, number] = [600, 420];

test('a colour style shared by two layers, and a variable with a light and a dark mode', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'New design file' }).click();
  await expect(canvas(page)).toBeVisible();
  await canvas(page).focus();

  // Two rectangles, one red and one blue.
  await page.keyboard.press('r');
  await drag(page, [100, 100], [200, 180]);
  await set(page, 'Fill 1 colour hex', 'FF0000');
  await canvas(page).focus();
  await page.keyboard.press('r');
  await drag(page, [300, 100], [400, 180]);
  await set(page, 'Fill 1 colour hex', '0000FF');
  expect(await pixel(page, ...second)).toEqual(BLUE);

  // The red one's fill becomes a style, which the blue one then uses.
  await layer(page, 'Rectangle 1').click();
  await select(page, 'Fill style').selectOption({ label: 'New style from this layer' });
  await expect(select(page, 'Fill style')).toContainText('Colour style');
  await layer(page, 'Rectangle 2').click();
  await select(page, 'Fill style').selectOption({ label: 'Colour style' });
  expect(await pixel(page, ...second)).toEqual(RED);

  // With nothing selected the file's styles are listed: changing the style's colour changes both layers.
  await click(page, nowhere);
  await expect(section(page, 'Local styles')).toBeVisible();
  await set(page, 'Colour of style Colour style hex', '00FF00');
  expect(await pixel(page, ...first)).toEqual(GREEN);
  expect(await pixel(page, ...second)).toEqual(GREEN);
  // One undo step takes the style and both layers back.
  await canvas(page).focus();
  await page.keyboard.press('Control+z');
  expect(await pixel(page, ...first)).toEqual(RED);
  expect(await pixel(page, ...second)).toEqual(RED);
  await page.keyboard.press('Control+Shift+z');
  expect(await pixel(page, ...second)).toEqual(GREEN);

  // A colour variable with two modes.
  await button(page, 'Edit variables').click();
  const dialog = page.getByRole('dialog', { name: 'Variables' });
  await dialog.getByRole('button', { name: 'New collection', exact: true }).click();
  await dialog.getByRole('button', { name: 'Colour', exact: true }).click();
  await set(page, 'Name of variable Colour', 'ink');
  await set(page, 'ink in Mode 1 hex', '0000FF');
  await dialog.getByRole('button', { name: 'Add mode', exact: true }).click();
  await set(page, 'Name of mode Mode 1', 'Light');
  await set(page, 'Name of mode Mode 2', 'Dark');
  await set(page, 'ink in Dark hex', '000000');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(section(page, 'Local variables')).toContainText('1 variable in 1 collection');

  // The first rectangle comes off the style and its fill is bound to the variable.
  await layer(page, 'Rectangle 1').click();
  await select(page, 'Fill style').selectOption({ label: 'None' });
  expect(await pixel(page, ...first)).toEqual(GREEN);
  await select(page, 'Bind a property to a variable').selectOption({ label: 'Fill colour' });
  await select(page, 'Fill colour variable').selectOption({ label: 'ink' });
  expect(await pixel(page, ...first)).toEqual(BLUE);
  expect(await pixel(page, ...second)).toEqual(GREEN);

  // The page goes dark: the bound layer follows, the other does not.
  await click(page, nowhere);
  await select(page, 'Collection mode').selectOption({ label: 'Dark' });
  expect(await pixel(page, ...first)).toEqual(BLACK);
  expect(await pixel(page, ...second)).toEqual(GREEN);

  // Stored: after a reload the mode, the binding and the style are all still there.
  await expect(page.getByRole('status')).toHaveText('Saved');
  await page.reload();
  await expect(canvas(page)).toBeVisible();
  expect(await pixel(page, ...first)).toEqual(BLACK);
  expect(await pixel(page, ...second)).toEqual(GREEN);
  await click(page, nowhere);
  await expect(select(page, 'Collection mode')).toHaveValue(/.+/);
  await select(page, 'Collection mode').selectOption({ label: 'Auto (Light)' });
  expect(await pixel(page, ...first)).toEqual(BLUE);

  // Changing the variable's value changes the layer; changing the fill by hand unbinds it.
  await button(page, 'Edit variables').click();
  await set(page, 'ink in Light hex', 'FF0000');
  await page.getByRole('dialog', { name: 'Variables' }).getByRole('button', { name: 'Close', exact: true }).click();
  expect(await pixel(page, ...first)).toEqual(RED);
  await layer(page, 'Rectangle 1').click();
  await expect(select(page, 'Fill colour variable')).toHaveCount(1);
  await set(page, 'Fill 1 colour hex', 'FF00FF');
  expect(await pixel(page, ...first)).toEqual(PINK);
  await expect(select(page, 'Fill colour variable')).toHaveCount(0);
  expect(errors).toEqual([]);
});
