import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Figma `.fig` files in the browser: a design saved as a `.fig` file through
 * "Save a copy to disk", and that file opened from the file browser as a new
 * file. Whether Figma itself opens the file cannot be checked here.
 */

const canvas = (page: Page): Locator => page.getByRole('application', { name: 'Design canvas' });
const layers = (page: Page): Locator => page.getByRole('tree', { name: 'Layers' });
const layer = (page: Page, name: string): Locator => layers(page).getByRole('treeitem', { name, exact: true });
const field = (page: Page, label: string): Locator => page.getByRole('textbox', { name: label, exact: true });

async function drag(page: Page, from: [number, number], to: [number, number]): Promise<void> {
  const box = await canvas(page).boundingBox();
  if (!box) throw new Error('canvas not visible');
  await page.mouse.move(box.x + from[0], box.y + from[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + to[0], box.y + to[1], { steps: 8 });
  await page.mouse.up();
}

async function menu(page: Page, group: string, item: string): Promise<void> {
  await page.getByRole('button', { name: 'Main menu' }).click();
  await page.getByRole('menuitem', { name: group }).click();
  await page.getByRole('menuitem', { name: item }).click();
}

test('a design saved as a .fig file and opened again from it', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'New design file' }).click();
  await expect(canvas(page)).toBeVisible();
  await page.getByRole('button', { name: /^File name:/ }).click();
  await field(page, 'File name').fill('Handoff');
  await field(page, 'File name').press('Enter');

  // A 200 × 100 frame with a red rectangle in it.
  await canvas(page).focus();
  await page.keyboard.press('f');
  await drag(page, [100, 100], [300, 200]);
  await canvas(page).focus();
  await page.keyboard.press('r');
  await drag(page, [120, 120], [180, 160]);
  await field(page, 'Fill 1 colour hex').fill('FF0000');
  await field(page, 'Fill 1 colour hex').press('Enter');

  // Saved as a Figma file: an archive with the canvas in it.
  await menu(page, 'File', 'Save a copy to disk…');
  const dialog = page.getByRole('dialog', { name: 'Save a copy to disk' });
  await expect(dialog.getByRole('button', { name: 'OPEN DESIGN (.opendesign)' })).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: 'Figma (.fig)' }).click()]);
  expect(download.suggestedFilename()).toBe('Handoff.fig');
  await expect(dialog.getByRole('status', { name: 'Figma file saved' })).toContainText('Saved as a Figma file.');
  const bytes = readFileSync(await download.path());
  expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK');
  expect(bytes.toString('latin1')).toContain('canvas.fig');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await menu(page, 'File', 'Back to files');

  // Opened from the file browser: a new file with the same layers, sizes and colour.
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Import file…' }).click()]);
  await chooser.setFiles({ name: 'Handoff.fig', mimeType: 'application/octet-stream', buffer: bytes });
  // Nothing in it was left out, so it opens at once, as a file of its own.
  await expect(canvas(page)).toBeVisible();
  await expect(page.getByRole('button', { name: /^File name: Handoff/ })).toBeVisible();
  await layer(page, 'Frame 1').click();
  await expect(field(page, 'Width')).toHaveValue('200');
  await expect(field(page, 'Height')).toHaveValue('100');
  await layer(page, 'Rectangle 1').click();
  await expect(field(page, 'Width')).toHaveValue('60');
  await expect(field(page, 'Fill 1 colour hex')).toHaveValue('FF0000');
  expect(errors).toEqual([]);
});
