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

/** True if any pixel of the design canvas inside the given canvas-space box is dark (text was painted there). */
async function hasInk(page: Page, box: { x: number; y: number; w: number; h: number }): Promise<boolean> {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  return page.evaluate(({ x, y, w, h }) => {
    const element = document.querySelector('canvas');
    const ctx = element?.getContext('2d');
    if (!element || !ctx) throw new Error('design canvas not found');
    const ratio = element.width / element.clientWidth;
    const data = ctx.getImageData(Math.round(x * ratio), Math.round(y * ratio), Math.max(1, Math.round(w * ratio)), Math.max(1, Math.round(h * ratio))).data;
    for (let i = 0; i < data.length; i += 4) {
      if ((data[i] as number) < 90 && (data[i + 1] as number) < 90 && (data[i + 2] as number) < 90) return true;
    }
    return false;
  }, box);
}

test('text: create, type, restyle, edit again, undo, and reopen', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await newFile(page);

  // A white frame to write on, so black text is visible.
  await page.keyboard.press('f');
  await drag(page, [100, 100], [600, 400]);

  // Text tool (T): click inside the frame and type.
  await page.keyboard.press('t');
  await expect(page.getByRole('button', { name: 'Text', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await click(page, [150, 200]);
  const editor = page.getByRole('textbox', { name: 'Edit text' });
  await expect(editor).toBeFocused();
  await page.keyboard.type('Get started');
  await expect(editor).toHaveValue('Get started');
  await page.keyboard.press('Escape');
  await expect(editor).toHaveCount(0);

  // The layer is named after its text, sits inside the frame and has a real size.
  await expect(layer(page, 'Get started')).toHaveAttribute('aria-selected', 'true');
  await expect(layer(page, 'Get started')).toHaveAttribute('aria-level', '2');
  await expect(field(page, 'X position')).toHaveValue('50');
  const width = Number(await field(page, 'Width').inputValue());
  const height = Number(await field(page, 'Height').inputValue());
  expect(width).toBeGreaterThan(40);
  expect(height).toBeGreaterThan(10);

  // The glyphs are really painted on the canvas, where the layer is.
  const y = 100 + Number(await field(page, 'Y position').inputValue());
  expect(await hasInk(page, { x: 150, y, w: width, h: height })).toBe(true);
  expect(await hasInk(page, { x: 150, y: y + height + 20, w: width, h: height })).toBe(false);

  // A bigger font makes the layer bigger; it is one undo step.
  await field(page, 'Font size').fill('48');
  await field(page, 'Font size').press('Enter');
  const bigWidth = Number(await field(page, 'Width').inputValue());
  expect(bigWidth).toBeGreaterThan(width * 2);
  await canvas(page).focus();
  await page.keyboard.press('Control+z');
  await expect(field(page, 'Width')).toHaveValue(String(width));
  await page.keyboard.press('Control+Shift+z');
  await expect(field(page, 'Width')).toHaveValue(String(bigWidth));

  // Bold and centred, from the properties panel.
  await page.getByRole('combobox', { name: 'Font weight' }).selectOption('700');
  await page.getByRole('radio', { name: 'Align text centre' }).click();
  await expect(page.getByRole('radio', { name: 'Align text centre' })).toHaveAttribute('aria-checked', 'true');

  // Double-click the text to edit it again; clicking elsewhere commits.
  await click(page, [160, y + 20], { clickCount: 2 });
  await expect(editor).toBeFocused();
  await expect(editor).toHaveValue('Get started');
  await page.keyboard.press('End');
  await page.keyboard.type(' today');
  await click(page, [700, 600]);
  await expect(editor).toHaveCount(0);
  await expect(layer(page, 'Get started today')).toBeVisible();

  // Undo restores the previous text, redo brings the edit back.
  await canvas(page).focus();
  await page.keyboard.press('Control+z');
  await expect(layer(page, 'Get started')).toBeVisible();
  await page.keyboard.press('Control+Shift+z');
  await expect(layer(page, 'Get started today')).toBeVisible();

  // Text that is left empty is not kept.
  await page.keyboard.press('t');
  await click(page, [300, 350]);
  await expect(editor).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(layers(page).getByRole('treeitem')).toHaveCount(2);

  await layer(page, 'Get started today').click();
  await page.screenshot({ path: 'test-results/phase2-text.png' });

  // It all survives a reload.
  await expect(page.getByRole('status')).toHaveText('Saved');
  await page.reload();
  await expect(layer(page, 'Get started today')).toBeVisible();
  await layer(page, 'Get started today').click();
  await expect(field(page, 'Font size')).toHaveValue('48');
  await expect(page.getByRole('combobox', { name: 'Font weight' })).toHaveValue('700');

  expect(errors).toEqual([]);
});

test('snapping: layers snap to each other, and the preference can be switched off and is remembered', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const { originX } = await newFile(page);

  await page.keyboard.press('r');
  await drag(page, [100, 100], [200, 200]);
  await page.keyboard.press('r');
  await drag(page, [300, 300], [400, 400]);

  // Drag the second rectangle so its left edge is 3px from the first one's right edge: it snaps onto it.
  await drag(page, [350, 350], [253, 350]);
  await expect(field(page, 'X position')).toHaveValue(String(200 - originX));

  // Switch snapping off from the View menu.
  const snapItem = page.getByRole('menuitemcheckbox', { name: /Snap to objects/ });
  await page.getByRole('button', { name: 'Main menu' }).click();
  await page.getByRole('menuitem', { name: 'View' }).click();
  await expect(snapItem).toHaveAttribute('aria-checked', 'true');
  await snapItem.click();

  // Now the same kind of drag lands exactly where the pointer puts it.
  await drag(page, [250, 350], [353, 350]);
  await expect(field(page, 'X position')).toHaveValue(String(303 - originX));
  await drag(page, [353, 350], [253, 350]);
  await expect(field(page, 'X position')).toHaveValue(String(203 - originX));

  // The preference belongs to the user, not the file: it is still off after a reload.
  await expect(page.getByRole('status')).toHaveText('Saved');
  await page.reload();
  await expect(canvas(page)).toBeVisible();
  await page.getByRole('button', { name: 'Main menu' }).click();
  await page.getByRole('menuitem', { name: 'View' }).click();
  await expect(snapItem).toHaveAttribute('aria-checked', 'false');
  await snapItem.click();

  expect(errors).toEqual([]);
});
