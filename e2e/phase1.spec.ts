import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Phase 1 acceptance criterion: "A user can create a document, create frames,
 * draw shapes, move and resize objects, manage layers, save and reopen their
 * work."
 *
 * Everything is done with real mouse and keyboard input in a real browser.
 * Results are read back from the layers panel and the properties panel, which
 * show the document model, and from a page reload, which shows what was
 * actually stored. The application exposes no test hooks.
 */

const canvas = (page: Page): Locator => page.getByRole('application', { name: 'Design canvas' });
const layers = (page: Page): Locator => page.getByRole('tree', { name: 'Layers' });
const layer = (page: Page, name: string): Locator => layers(page).getByRole('treeitem', { name, exact: true });
const field = (page: Page, label: string): Locator => page.getByRole('textbox', { name: label, exact: true });

/** Drags on the canvas between two points given in canvas pixels. */
async function drag(page: Page, from: [number, number], to: [number, number], options: { modifiers?: string[] } = {}): Promise<void> {
  const box = await canvas(page).boundingBox();
  if (!box) throw new Error('canvas not visible');
  for (const key of options.modifiers ?? []) await page.keyboard.down(key);
  await page.mouse.move(box.x + from[0], box.y + from[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + (from[0] + to[0]) / 2, box.y + (from[1] + to[1]) / 2, { steps: 4 });
  await page.mouse.move(box.x + to[0], box.y + to[1], { steps: 4 });
  await page.mouse.up();
  for (const key of options.modifiers ?? []) await page.keyboard.up(key);
}

async function click(page: Page, at: [number, number]): Promise<void> {
  const box = await canvas(page).boundingBox();
  if (!box) throw new Error('canvas not visible');
  await page.mouse.click(box.x + at[0], box.y + at[1]);
}

async function expectBox(page: Page, box: { x: number; y: number; w: number; h: number }): Promise<void> {
  await expect(field(page, 'X position')).toHaveValue(String(box.x));
  await expect(field(page, 'Y position')).toHaveValue(String(box.y));
  await expect(field(page, 'Width')).toHaveValue(String(box.w));
  await expect(field(page, 'Height')).toHaveValue(String(box.h));
}

async function newFile(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'New design file' }).click();
  await expect(canvas(page)).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('Saved');
}

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  // Fail any test during which the application logged an error.
  (page as Page & { __errors?: string[] }).__errors = errors;
});

test.afterEach(async ({ page }) => {
  expect((page as Page & { __errors?: string[] }).__errors ?? []).toEqual([]);
});

test('create a file, frames and shapes, move, resize, manage layers, save and reopen', async ({ page }) => {
  await newFile(page);

  // A new file opens with the canvas origin in the middle of the view. Work in
  // canvas pixels and let the properties panel report page coordinates.
  const size = await canvas(page).boundingBox();
  if (!size) throw new Error('canvas not visible');
  const originX = Math.floor(size.width) / 2;
  const originY = Math.floor(size.height) / 2;

  // --- Create a frame by dragging with the frame tool (F).
  await page.keyboard.press('f');
  await expect(page.getByRole('button', { name: 'Frame', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await drag(page, [100, 100], [500, 400]);
  await expect(layer(page, 'Frame 1')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: 'Move', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expectBox(page, { x: 100 - originX, y: 100 - originY, w: 400, h: 300 });

  // --- Draw a rectangle inside the frame (R): it is nested and positioned relative to the frame.
  await page.keyboard.press('r');
  await drag(page, [150, 150], [250, 230]);
  await expect(layer(page, 'Rectangle 1')).toHaveAttribute('aria-level', '2');
  await expectBox(page, { x: 50, y: 50, w: 100, h: 80 });

  // --- Draw an ellipse outside the frame (O): it sits on the page.
  await page.keyboard.press('o');
  await drag(page, [600, 150], [700, 250]);
  await expect(layer(page, 'Ellipse 1')).toHaveAttribute('aria-level', '1');
  await expectBox(page, { x: 600 - originX, y: 150 - originY, w: 100, h: 100 });

  // --- A click with a shape tool creates a default 100 × 100 shape.
  await page.getByRole('button', { name: 'Star', exact: true }).click();
  await click(page, [600, 350]);
  await expect(layer(page, 'Star 1')).toHaveAttribute('aria-selected', 'true');
  await expectBox(page, { x: 600 - originX, y: 350 - originY, w: 100, h: 100 });

  // --- Select the rectangle by clicking it on the canvas, then move it by dragging.
  await click(page, [200, 190]);
  await expect(layer(page, 'Rectangle 1')).toHaveAttribute('aria-selected', 'true');
  await drag(page, [200, 190], [260, 230]);
  await expectBox(page, { x: 110, y: 90, w: 100, h: 80 });

  // --- Resize it by dragging its bottom-right handle.
  await drag(page, [310, 270], [360, 300]);
  await expectBox(page, { x: 110, y: 90, w: 150, h: 110 });

  // --- Undo and redo are real: the document goes back and forward.
  await page.keyboard.press('Control+z');
  await expectBox(page, { x: 110, y: 90, w: 100, h: 80 });
  await page.keyboard.press('Control+Shift+z');
  await expectBox(page, { x: 110, y: 90, w: 150, h: 110 });

  // --- Edit position and size precisely in the properties panel.
  await field(page, 'X position').fill('20');
  await field(page, 'X position').press('Enter');
  await field(page, 'Width').fill('200');
  await field(page, 'Width').press('Enter');
  await expectBox(page, { x: 20, y: 90, w: 200, h: 110 });

  // --- Nudge with the arrow keys.
  await canvas(page).focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowDown');
  await expectBox(page, { x: 21, y: 100, w: 200, h: 110 });

  // --- Manage layers: rename, hide, lock, reorder.
  await layer(page, 'Ellipse 1').dblclick();
  await page.getByRole('textbox', { name: 'Layer name' }).fill('Dot');
  await page.getByRole('textbox', { name: 'Layer name' }).press('Enter');
  await expect(layer(page, 'Dot')).toBeVisible();

  await layer(page, 'Dot').hover();
  await page.getByRole('button', { name: 'Hide Dot' }).click();
  await expect(page.getByRole('button', { name: 'Show Dot' })).toBeVisible();
  // A hidden layer cannot be clicked on the canvas.
  await click(page, [740, 640]);
  await click(page, [650, 200]);
  await expect(layer(page, 'Dot')).toHaveAttribute('aria-selected', 'false');
  await page.getByRole('button', { name: 'Show Dot' }).click();
  await click(page, [650, 200]);
  await expect(layer(page, 'Dot')).toHaveAttribute('aria-selected', 'true');

  // Top-level order in the panel is top-most first: Star 1, Dot, Frame 1.
  const topLevel = layers(page).locator('[role="treeitem"][aria-level="1"]');
  await expect(topLevel).toHaveText(['Star 1', 'Dot', 'Frame 1']);
  await page.keyboard.press(']'); // bring Dot to front
  await expect(topLevel).toHaveText(['Dot', 'Star 1', 'Frame 1']);

  // Lock the star from the layers panel: it can no longer be selected on the canvas.
  await layer(page, 'Star 1').hover();
  await page.getByRole('button', { name: 'Lock Star 1' }).click();
  await click(page, [740, 640]);
  await click(page, [650, 400]);
  await expect(layer(page, 'Star 1')).toHaveAttribute('aria-selected', 'false');

  // --- Duplicate and delete.
  await click(page, [650, 200]);
  await page.keyboard.press('Control+d');
  await expect(layers(page).getByRole('treeitem', { name: 'Dot', exact: true })).toHaveCount(2);
  await page.keyboard.press('Delete');
  await expect(layers(page).getByRole('treeitem', { name: 'Dot', exact: true })).toHaveCount(1);

  // --- Rename the file; everything is saved automatically.
  await page.getByRole('button', { name: /^File name:/ }).click();
  await page.getByRole('textbox', { name: 'File name' }).fill('Acceptance file');
  await page.getByRole('textbox', { name: 'File name' }).press('Enter');
  await expect(page.getByRole('status')).toHaveText('Saved');

  // --- Reopen: a full page reload reads the file back from storage.
  await page.reload();
  await expect(canvas(page)).toBeVisible();
  await expect(page.getByRole('button', { name: /^File name: Acceptance file/ })).toBeVisible();
  await expect(layers(page).locator('[role="treeitem"][aria-level="1"]')).toHaveText(['Dot', 'Star 1', 'Frame 1']);
  await expect(layer(page, 'Rectangle 1')).toHaveAttribute('aria-level', '2');
  await expect(page.getByRole('button', { name: 'Unlock Star 1' })).toBeVisible();
  await layer(page, 'Rectangle 1').click();
  await expectBox(page, { x: 21, y: 100, w: 200, h: 110 });
  // The view was restored too, so the rectangle is where it was left on screen.
  await click(page, [740, 640]);
  await click(page, [100 + 21 + 100, 100 + 100 + 55]);
  await expect(layer(page, 'Rectangle 1')).toHaveAttribute('aria-selected', 'true');

  // --- The file browser lists the file, and it opens again from there.
  await page.getByRole('button', { name: 'Main menu' }).click();
  await page.getByRole('menuitem', { name: 'File' }).click();
  await page.getByRole('menuitem', { name: 'Back to files' }).click();
  await expect(page.getByRole('button', { name: 'Open Acceptance file' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Files' })).toContainText('4 layers');
  await page.getByRole('button', { name: 'Open Acceptance file' }).click();
  await expect(layer(page, 'Frame 1')).toBeVisible();
});

test('pages: add, rename, switch and keep separate content', async ({ page }) => {
  await newFile(page);
  await page.keyboard.press('r');
  await drag(page, [200, 200], [300, 300]);
  await expect(layer(page, 'Rectangle 1')).toBeVisible();

  await page.getByRole('button', { name: 'Add page' }).click();
  const pages = page.getByRole('listbox', { name: 'Pages' });
  await expect(pages.getByRole('option')).toHaveText(['Page 1', 'Page 2']);
  await expect(pages.getByRole('option', { name: 'Page 2' })).toHaveAttribute('aria-selected', 'true');
  await expect(layers(page).getByRole('treeitem')).toHaveCount(0);

  await page.keyboard.press('o');
  await drag(page, [200, 200], [300, 300]);
  await expect(layer(page, 'Ellipse 1')).toBeVisible();

  await pages.getByRole('option', { name: 'Page 1' }).click();
  await expect(layer(page, 'Rectangle 1')).toBeVisible();
  await expect(layer(page, 'Ellipse 1')).toHaveCount(0);

  await pages.getByRole('option', { name: 'Page 2' }).dblclick();
  await page.getByRole('textbox', { name: 'Page name' }).fill('Icons');
  await page.getByRole('textbox', { name: 'Page name' }).press('Enter');
  await expect(pages.getByRole('option')).toHaveText(['Page 1', 'Icons']);

  await expect(page.getByRole('status')).toHaveText('Saved');
  await page.reload();
  await expect(page.getByRole('listbox', { name: 'Pages' }).getByRole('option')).toHaveText(['Page 1', 'Icons']);
});

test('zoom and pan change the view, not the document', async ({ page }) => {
  await newFile(page);
  await page.keyboard.press('r');
  await drag(page, [300, 300], [400, 400]);
  const zoom = page.getByRole('textbox', { name: 'Zoom percentage' });
  await expect(zoom).toHaveValue('100');
  const before = await field(page, 'X position').inputValue();

  // Ctrl + wheel zooms in around the pointer.
  const box = await canvas(page).boundingBox();
  if (!box) throw new Error('canvas not visible');
  await page.mouse.move(box.x + 350, box.y + 350);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -300);
  await page.keyboard.up('Control');
  await expect(zoom).not.toHaveValue('100');
  // The point under the pointer stayed put, so the rectangle is still under it.
  await click(page, [740, 640]);
  await click(page, [350, 350]);
  await expect(layer(page, 'Rectangle 1')).toHaveAttribute('aria-selected', 'true');

  // Shift+0 returns to 100%, Shift+1 fits the content.
  await page.keyboard.press('Shift+Digit0');
  await expect(zoom).toHaveValue('100');
  await page.keyboard.press('Shift+Digit1');
  await expect(zoom).toHaveValue('100');

  // Space + drag pans. The layer's coordinates are unchanged by any of this.
  await page.keyboard.down('Space');
  await drag(page, [400, 400], [300, 350]);
  await page.keyboard.up('Space');
  await expect(field(page, 'X position')).toHaveValue(before);
});
