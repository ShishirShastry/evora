import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Phase 5, libraries, in the real browser: one file publishes a component,
 * a second file adds the library and places an instance, the first changes
 * and publishes again, and the second takes the new version. What the
 * instance shows is read from the pixels of the design canvas.
 */

const canvas = (page: Page): Locator => page.getByRole('application', { name: 'Design canvas' });
const field = (page: Page, label: string): Locator => page.getByRole('textbox', { name: label, exact: true });
const section = (page: Page, name: string): Locator => page.getByRole('region', { name, exact: true });
const layers = (page: Page): Locator => page.getByRole('tree', { name: 'Layers' });

async function drag(page: Page, from: [number, number], to: [number, number]): Promise<void> {
  const box = await canvas(page).boundingBox();
  if (!box) throw new Error('canvas not visible');
  await page.mouse.move(box.x + from[0], box.y + from[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + to[0], box.y + to[1], { steps: 8 });
  await page.mouse.up();
}

async function set(page: Page, label: string, value: string): Promise<void> {
  await field(page, label).fill(value);
  await field(page, label).press('Enter');
}

const number = async (page: Page, label: string): Promise<number> => Number(await field(page, label).inputValue());

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

async function menu(page: Page, item: string): Promise<void> {
  await page.getByRole('button', { name: 'Main menu' }).click();
  await page.getByRole('menuitem', { name: 'File' }).click();
  await page.getByRole('menuitem', { name: item }).click();
}

async function rename(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: /^File name:/ }).click();
  await field(page, 'File name').fill(name);
  await field(page, 'File name').press('Enter');
  await expect(page.getByRole('button', { name: new RegExp(`^File name: ${name}`) })).toBeVisible();
}

const libraries = (page: Page): Locator => page.getByRole('dialog', { name: 'Libraries' });
const closeLibraries = (page: Page): Promise<void> => libraries(page).getByRole('button', { name: 'Close', exact: true }).click();

const RED: [number, number, number] = [255, 0, 0];
const GREEN: [number, number, number] = [0, 255, 0];

test('a component published as a library, used in another file, and updated there', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'New design file' }).click();
  await expect(canvas(page)).toBeVisible();
  await rename(page, 'Kit');

  // The library file: a red 200 × 100 component, published.
  await canvas(page).focus();
  await page.keyboard.press('f');
  await drag(page, [100, 100], [300, 200]);
  await set(page, 'Fill 1 colour hex', 'FF0000');
  await canvas(page).focus();
  await page.keyboard.press('Control+Alt+K');
  await expect(section(page, 'Component')).toBeVisible();
  await menu(page, 'Libraries…');
  await expect(libraries(page).getByRole('status', { name: 'Publishing status' })).toHaveText('Not published.');
  await expect(libraries(page)).toContainText('This file has 1 component, 0 styles, 0 variables.');
  await libraries(page).getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(libraries(page).getByRole('status', { name: 'Publishing status' })).toContainText('Published as version 1');
  await expect(libraries(page).getByRole('button', { name: 'Publish changes', exact: true })).toBeDisabled();
  await closeLibraries(page);
  await menu(page, 'Back to files');

  // A second file adds the library.
  await page.getByRole('button', { name: 'New design file' }).click();
  await expect(canvas(page)).toBeVisible();
  await rename(page, 'Design');
  await menu(page, 'Libraries…');
  await expect(section(page, 'Available libraries')).toContainText('1 component, 0 styles, 0 variables. Version 1.');
  await libraries(page).getByRole('button', { name: 'Add Kit', exact: true }).click();
  await expect(section(page, 'Libraries used in this file')).toContainText('Version 1. Up to date.');
  await closeLibraries(page);

  // A rectangle from (100, 100) on the canvas tells where the page is on it.
  await canvas(page).focus();
  await page.keyboard.press('r');
  await drag(page, [100, 100], [120, 120]);
  const originX = 100 - (await number(page, 'X position'));
  const originY = 100 - (await number(page, 'Y position'));

  // The library's component is in the Components list, under the library's name; an instance of it is red.
  const list = page.getByRole('region', { name: 'Components' });
  await list.getByRole('button', { name: 'Insert an instance of Kit/Component 1' }).click();
  await expect(section(page, 'Instance')).toBeVisible();
  const inside: [number, number] = [originX + (await number(page, 'X position')) + 150, originY + (await number(page, 'Y position')) + 80];
  expect(await pixel(page, ...inside)).toEqual(RED);
  // The library's page is not one of this file's pages, and its component is not among this file's layers.
  await expect(page.getByRole('region', { name: 'Pages' }).getByRole('button', { name: /Kit/ })).toHaveCount(0);
  await expect(layers(page).getByRole('treeitem')).toHaveCount(2);
  await expect(page.getByRole('status')).toHaveText('Saved');
  await menu(page, 'Back to files');

  // The library changes to green and is published again.
  await page.getByRole('button', { name: 'Open Kit' }).click();
  await expect(canvas(page)).toBeVisible();
  await layers(page).getByRole('treeitem', { name: 'Component 1', exact: true }).click();
  await set(page, 'Fill 1 colour hex', '00FF00');
  await menu(page, 'Libraries…');
  await expect(libraries(page).getByRole('status', { name: 'Publishing status' })).toContainText('with changes since that are not published');
  await libraries(page).getByRole('button', { name: 'Publish changes', exact: true }).click();
  await expect(libraries(page).getByRole('status', { name: 'Publishing status' })).toContainText('Published as version 2');
  await closeLibraries(page);
  await menu(page, 'Back to files');

  // The second file is told, still shows the old version, and takes the new one.
  await page.getByRole('button', { name: 'Open Design' }).click();
  await expect(canvas(page)).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('“Kit” was published again');
  expect(await pixel(page, ...inside)).toEqual(RED);
  await menu(page, 'Libraries…');
  await expect(section(page, 'Libraries used in this file')).toContainText('Version 2 is available.');
  await libraries(page).getByRole('button', { name: 'Update Kit', exact: true }).click();
  await expect(section(page, 'Libraries used in this file')).toContainText('Version 2. Up to date.');
  await closeLibraries(page);
  expect(await pixel(page, ...inside)).toEqual(GREEN);
  // One undo step goes back to the old version.
  await canvas(page).focus();
  await page.keyboard.press('Control+z');
  expect(await pixel(page, ...inside)).toEqual(RED);
  await page.keyboard.press('Control+Shift+z');
  expect(await pixel(page, ...inside)).toEqual(GREEN);

  // Removing the library leaves the instance as an ordinary frame that looks the same.
  await menu(page, 'Libraries…');
  await libraries(page).getByRole('button', { name: 'Remove Kit', exact: true }).click();
  await expect(section(page, 'Libraries used in this file')).toContainText('No library has been added');
  await closeLibraries(page);
  expect(await pixel(page, ...inside)).toEqual(GREEN);
  await expect(page.getByRole('region', { name: 'Components' })).toHaveCount(0);
  expect(errors).toEqual([]);
});
