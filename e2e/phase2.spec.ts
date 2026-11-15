import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Phase 2 features, as they are completed. Driven with real input in a real
 * browser; results are read from the layers and properties panels.
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
  await page.mouse.move(box.x + to[0], box.y + to[1], { steps: 6 });
  await page.mouse.up();
}

async function click(page: Page, at: [number, number], options: { clickCount?: number } = {}): Promise<void> {
  const box = await canvas(page).boundingBox();
  if (!box) throw new Error('canvas not visible');
  await page.mouse.click(box.x + at[0], box.y + at[1], options);
}

async function newFile(page: Page): Promise<{ originX: number; originY: number }> {
  await page.goto('/');
  await page.getByRole('button', { name: 'New design file' }).click();
  await expect(canvas(page)).toBeVisible();
  const box = await canvas(page).boundingBox();
  if (!box) throw new Error('canvas not visible');
  return { originX: Math.floor(box.width) / 2, originY: Math.floor(box.height) / 2 };
}

test('group, ungroup, align, distribute and flip', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const { originX } = await newFile(page);

  // Three rectangles at different heights.
  await page.keyboard.press('r');
  await drag(page, [100, 100], [200, 200]);
  await page.keyboard.press('r');
  await drag(page, [250, 250], [300, 350]);
  await page.keyboard.press('r');
  await drag(page, [500, 150], [600, 200]);

  // Select all three with a marquee.
  await drag(page, [650, 400], [50, 50]);
  await expect(layers(page).locator('[aria-selected="true"]')).toHaveCount(3);
  await expect(page.getByText('3 layers')).toBeVisible();

  // Align left with the button in the properties panel: all three share X.
  await page.getByRole('button', { name: 'Align left' }).click();
  await expect(field(page, 'X position')).toHaveValue(String(100 - originX));

  // Undo, then distribute horizontally with the keyboard shortcut: X values now differ again.
  await canvas(page).focus();
  await page.keyboard.press('Control+z');
  await expect(field(page, 'X position')).toHaveValue('');
  await page.keyboard.press('Control+Alt+h');
  await layer(page, 'Rectangle 2').click();
  // Span 100..600, total width 250, two gaps of 125: the middle one starts at 100 + 100 + 125.
  await expect(field(page, 'X position')).toHaveValue(String(325 - originX));

  // Group all three (Ctrl+G): one group containing them, sized to their bounds.
  await drag(page, [650, 400], [50, 50]);
  await page.keyboard.press('Control+g');
  await expect(layer(page, 'Group 1')).toHaveAttribute('aria-selected', 'true');
  await expect(layer(page, 'Rectangle 1')).toHaveAttribute('aria-level', '2');
  await expect(field(page, 'Width')).toHaveValue('500');
  await expect(field(page, 'Height')).toHaveValue('250');
  // A group has no fill or stroke of its own.
  await expect(page.getByRole('region', { name: 'Fill' })).toHaveCount(0);

  // Clicking a member selects the group; double-clicking selects the member.
  await click(page, [700, 500]);
  await click(page, [150, 150]);
  await expect(layer(page, 'Group 1')).toHaveAttribute('aria-selected', 'true');
  await click(page, [150, 150], { clickCount: 2 });
  await expect(layer(page, 'Rectangle 1')).toHaveAttribute('aria-selected', 'true');

  // Flip the whole group horizontally from the main menu: the first rectangle moves to the right side.
  await layer(page, 'Group 1').click();
  await page.getByRole('button', { name: 'Main menu' }).click();
  await page.getByRole('menuitem', { name: 'Object' }).click();
  await page.getByRole('menuitem', { name: 'Flip horizontal' }).click();
  await layer(page, 'Rectangle 1').click();
  await expect(field(page, 'X position')).toHaveValue('400');

  // Ungroup (Ctrl+Shift+G): the rectangles are back on the page, in place.
  await layer(page, 'Group 1').click();
  await canvas(page).focus();
  await page.keyboard.press('Control+Shift+g');
  await expect(layer(page, 'Group 1')).toHaveCount(0);
  await expect(layer(page, 'Rectangle 1')).toHaveAttribute('aria-level', '1');
  await layer(page, 'Rectangle 1').click();
  await expect(field(page, 'X position')).toHaveValue(String(500 - originX));

  // Groups survive a reload.
  await drag(page, [650, 400], [50, 50]);
  await page.keyboard.press('Control+g');
  await expect(page.getByRole('status')).toHaveText('Saved');
  await page.reload();
  await expect(layer(page, 'Group 1')).toBeVisible();
  await expect(layer(page, 'Rectangle 3')).toHaveAttribute('aria-level', '2');

  expect(errors).toEqual([]);
});
